/** Carrying out a kit plan on one machine: the skills through one sh
 *  script on onHost, which acts only on links (and on the dirs it makes),
 *  so a real folder is never replaced or removed; MCP servers through
 *  kitmcp's writers. */
import { onHost } from "./exec";
import { adoptedPath, isMcpAction } from "./kit";
import { applyMcp } from "./kitmcp";
import { KIT_FILE } from "./kitscan";
import type { KitAction, KitApplyResult, KitMcpEntry, KitMcpFormat, KitMcpSeen, KitSeen } from "./types";

/** args: the store dir, then one op per action as 4 words
 *  (`mkdir dir - -`, `link dir name text`, `relink …`, `remove dir name -`,
 *  `pull - - -`, `adopt dir name text`, `putback dir name placed-text`).
 *  Prints `ok <i>` or `err <i> <why>` per op. The pull says
 *  `--no-rebase` because a machine's `pull.rebase=true` (the mini's) makes
 *  git refuse any pull over a store with local edits. Adopt moves the
 *  hand-made entry to `.canopy-kit-adopted/<name>` beside the dir (0700,
 *  never over one there) and links; put back takes out only the link the
 *  kit placed and moves the entry back. */
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
    adopt) a="$(dirname "$d")/.canopy-kit-adopted"
           if [ ! -e "$d/$n" ] && [ ! -L "$d/$n" ]; then echo "err $i nothing to adopt"
           elif [ -e "$a/$n" ] || [ -L "$a/$n" ]; then echo "err $i $a/$n is taken; move it away first"
           elif ! { mkdir -p "$a" && chmod 700 "$a"; } 2>/dev/null; then echo "err $i cannot make $a"
           elif ! mv "$d/$n" "$a/$n" 2>/dev/null; then echo "err $i cannot move $d/$n aside"
           elif ln -s "$l" "$d/$n" 2>/dev/null; then echo "ok $i"
           elif mv "$a/$n" "$d/$n" 2>/dev/null; then echo "err $i ln failed; moved it back"
           else echo "err $i ln failed, and it stays at $a/$n"; fi ;;
    putback) a="$(dirname "$d")/.canopy-kit-adopted"
             if [ ! -e "$a/$n" ] && [ ! -L "$a/$n" ]; then echo "err $i $a/$n is gone"
             elif [ -L "$d/$n" ] && [ "$(readlink "$d/$n")" != "$l" ]; then echo "err $i $d/$n was pointed elsewhere by hand"
             elif [ -e "$d/$n" ] && [ ! -L "$d/$n" ]; then echo "err $i $d/$n is not the kit's link"
             elif ! rm -f "$d/$n"; then echo "err $i rm failed"
             elif mv "$a/$n" "$d/$n" 2>/dev/null; then echo "ok $i"
             else echo "err $i cannot move $a/$n back"; fi ;;
  esac
  i=$((i + 1))
done
`;

/** writes each `<dir> <json>` pair to <dir>/.canopy-kit.json */
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
    else if (a.kind === "skill-adopt") args.push("adopt", dirOf(seen, a.agent), a.name, a.link);
    // the link text the kit placed, so a link pointed elsewhere since stops it
    else if (a.kind === "skill-restore") args.push("putback", dirOf(seen, a.agent), a.name, seen.targets.find((t) => t.agent === a.agent)?.placed[a.name] ?? "-");
    else args.push(a.kind, dirOf(seen, a.agent), a.name, a.link);
  }
  return args;
}

/** what a dir's .canopy-kit.json holds; adoptedFrom only once adopt has run there */
export interface KitPlaced { placed: Record<string, string>; adoptedFrom?: Record<string, string> }

export function nextPlaced(seen: KitSeen, done: KitAction[]): Record<string, KitPlaced> {
  const out: Record<string, { placed: Record<string, string>; adoptedFrom: Record<string, string> }> = {};
  for (const a of done) {
    if (a.kind === "pull" || a.kind === "mkdir" || isMcpAction(a)) continue;
    const t = seen.targets.find((x) => x.agent === a.agent);
    if (!t) continue;
    const p = (out[a.agent] ??= { placed: { ...t.placed }, adoptedFrom: { ...t.adoptedFrom } });
    if (a.kind === "remove") delete p.placed[a.name];
    else if (a.kind === "skill-restore") { delete p.placed[a.name]; delete p.adoptedFrom[a.name]; }
    else {
      p.placed[a.name] = a.link;
      if (a.kind === "skill-adopt") p.adoptedFrom[a.name] = adoptedPath(t.dir, a.name);
    }
  }
  return Object.fromEntries(Object.entries(out).map(([agent, p]) => [agent, Object.keys(p.adoptedFrom).length > 0 ? p : { placed: p.placed }]));
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
    for (const [agent, p] of Object.entries(placed)) words.push(dirOf(seen, agent), JSON.stringify(p));
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
