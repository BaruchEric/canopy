/** Carrying out a kit plan on one machine: the skills through one sh
 *  script on onHost, which acts only on links (and on the dirs it makes),
 *  so a real folder is never replaced or removed; MCP servers through
 *  kitmcp's writers. */
import { onHost } from "./exec";
import { isMcpAction } from "./kit";
import { applyMcp } from "./kitmcp";
import { KIT_FILE } from "./kitscan";
import type { KitAction, KitApplyResult, KitMcpEntry, KitMcpFormat, KitMcpSeen, KitSeen } from "./types";

/** args: the store dir, then one op per action as 4 words
 *  (`mkdir dir - -`, `link dir name text`, `relink …`, `remove dir name -`,
 *  `pull - - -`). Prints `ok <i>` or `err <i> <why>` per op. The pull says
 *  `--no-rebase` because a machine's `pull.rebase=true` (the mini's) makes
 *  git refuse any pull over a store with local edits. */
export const APPLY_SCRIPT = String.raw`
store=$1; shift; i=0
while [ $# -ge 4 ]; do
  op=$1; d=$2; n=$3; l=$4; shift 4
  case $op in
    mkdir) if mkdir -p "$d" 2>/dev/null; then echo "ok $i"; else echo "err $i cannot make $d"; fi ;;
    link) if [ -e "$d/$n" ] || [ -L "$d/$n" ]; then echo "err $i exists"
          elif ln -s "$l" "$d/$n" 2>/dev/null; then echo "ok $i"; else echo "err $i ln failed"; fi ;;
    relink) if [ ! -L "$d/$n" ]; then echo "err $i not a link"
            elif rm -f "$d/$n" && ln -s "$l" "$d/$n"; then echo "ok $i"; else echo "err $i ln failed"; fi ;;
    remove) if [ ! -L "$d/$n" ]; then echo "err $i not a link"
            elif rm -f "$d/$n"; then echo "ok $i"; else echo "err $i rm failed"; fi ;;
    pull) out=$(git -C "$store" pull --ff-only --no-rebase -q 2>&1)
          if [ $? -eq 0 ]; then echo "ok $i"; else echo "err $i $(printf %s "$out" | tr '\n' ' ')"; fi ;;
  esac
  i=$((i + 1))
done
`;

/** writes each `<agent> <dir> <json>` triple to <dir>/.canopy-kit.json */
const PLACED_SCRIPT = String.raw`
while [ $# -ge 2 ]; do
  d=$1; j=$2; shift 2
  [ -d "$d" ] || continue
  printf '%s\n' "$j" > "$d/${KIT_FILE}.tmp" && mv -f "$d/${KIT_FILE}.tmp" "$d/${KIT_FILE}"
done
`;

const dirOf = (seen: KitSeen, agent: string) => seen.targets.find((t) => t.agent === agent)?.dir ?? "";
const storeOf = (seen: KitSeen) => seen.targets[0]!.dir.replace(/\/skills\/?$/, "");

export function applyArgs(seen: KitSeen, actions: KitAction[]): string[] {
  const args = [storeOf(seen)];
  for (const a of actions) {
    if (isMcpAction(a)) continue;
    if (a.kind === "pull") args.push("pull", "-", "-", "-");
    else if (a.kind === "mkdir") args.push("mkdir", dirOf(seen, a.agent), "-", "-");
    else if (a.kind === "remove") args.push("remove", dirOf(seen, a.agent), a.name, "-");
    else args.push(a.kind, dirOf(seen, a.agent), a.name, a.link);
  }
  return args;
}

export function nextPlaced(seen: KitSeen, done: KitAction[]): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = {};
  for (const a of done) {
    if (a.kind === "pull" || a.kind === "mkdir" || isMcpAction(a)) continue;
    const t = seen.targets.find((x) => x.agent === a.agent);
    if (!t) continue;
    const p = (out[a.agent] ??= { ...t.placed });
    if (a.kind === "remove") delete p[a.name];
    else p[a.name] = a.link;
  }
  return out;
}

/** Skills go through the sh script, which answers by position over the
 *  skill actions alone; MCP actions go to applyMcp. Each action's outcome
 *  is looked up by the action itself, so the result keeps the order asked. */
export async function applyKit(
  seen: KitSeen,
  host: string | null,
  actions: KitAction[],
  opts: { run?: typeof onHost; env?: Record<string, string>; mcp?: { seen: KitMcpSeen; entries: Record<string, KitMcpEntry>; formats: Record<string, KitMcpFormat> } } = {},
): Promise<KitApplyResult> {
  const run = opts.run ?? onHost;
  const outcome = new Map<KitAction, string | null>();
  const skills = actions.filter((a) => !isMcpAction(a));
  const servers = actions.filter(isMcpAction);
  if (skills.length > 0) {
    const r = await run(host, ["sh", "-c", APPLY_SCRIPT, "kit-apply", ...applyArgs(seen, skills)], { env: opts.env, timeoutMs: 120_000 });
    const lines = r.stdout.split("\n");
    skills.forEach((a, i) => {
      const line = lines.find((l) => l === `ok ${i}` || l.startsWith(`err ${i} `));
      outcome.set(a, line === `ok ${i}` ? null : line ? line.slice(`err ${i} `.length) : (r.stderr.trim() || `exited ${r.code}`));
    });
    const placed = nextPlaced(seen, skills.filter((a) => outcome.get(a) === null));
    const words: string[] = [];
    for (const [agent, p] of Object.entries(placed)) words.push(dirOf(seen, agent), JSON.stringify({ placed: p }));
    if (words.length) await run(host, ["sh", "-c", PLACED_SCRIPT, "kit-placed", ...words], { env: opts.env, timeoutMs: 30_000 });
  }
  if (servers.length > 0) {
    if (!opts.mcp) for (const a of servers) outcome.set(a, "no MCP scan for this machine; rescan");
    else {
      const r = await applyMcp(opts.mcp.seen, seen.home, servers, opts.mcp.entries, opts.mcp.formats, { run, host, env: opts.env });
      for (const a of r.done) outcome.set(a, null);
      for (const f of r.failed) outcome.set(f.action, f.why);
    }
  }
  const done: KitAction[] = [];
  const failed: KitApplyResult["failed"] = [];
  for (const a of actions) {
    const why = outcome.get(a);
    if (why === null) done.push(a);
    else failed.push({ action: a, why: why ?? "not carried out" });
  }
  return { machine: seen.machine, done, failed };
}
