/** Carrying out a kit plan on one machine: one sh script through onHost.
 *  It acts only on links (and on the dirs it makes), so a real folder is
 *  never replaced or removed. */
import { onHost } from "./exec";
import { isMcpAction } from "./kit";
import { KIT_FILE } from "./kitscan";
import type { KitAction, KitApplyResult, KitSeen } from "./types";

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

export async function applyKit(
  seen: KitSeen,
  host: string | null,
  actions: KitAction[],
  opts: { run?: typeof onHost; env?: Record<string, string> } = {},
): Promise<KitApplyResult> {
  const run = opts.run ?? onHost;
  const done: KitAction[] = [];
  const failed: KitApplyResult["failed"] = [];
  if (actions.length === 0) return { machine: seen.machine, done, failed };
  const r = await run(host, ["sh", "-c", APPLY_SCRIPT, "kit-apply", ...applyArgs(seen, actions)], { env: opts.env, timeoutMs: 120_000 });
  const lines = r.stdout.split("\n");
  actions.forEach((a, i) => {
    const line = lines.find((l) => l === `ok ${i}` || l.startsWith(`err ${i} `));
    if (line === `ok ${i}`) done.push(a);
    else failed.push({ action: a, why: line ? line.slice(`err ${i} `.length) : (r.stderr.trim() || `exited ${r.code}`) });
  });
  const placed = nextPlaced(seen, done);
  const words: string[] = [];
  for (const [agent, p] of Object.entries(placed)) words.push(dirOf(seen, agent), JSON.stringify({ placed: p }));
  if (words.length) await run(host, ["sh", "-c", PLACED_SCRIPT, "kit-placed", ...words], { env: opts.env, timeoutMs: 30_000 });
  return { machine: seen.machine, done, failed };
}
