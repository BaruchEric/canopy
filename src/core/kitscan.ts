/** Reading one machine for the kit: one POSIX sh script through onHost, so
 *  a local machine and an ssh one read the same way. */
import { onHost } from "./exec";
import { SKILL_NAME, sourcePath, targetsFor } from "./kit";
import type { KitEntry, KitEntryKind, KitManifest, KitSeen, KitSeenTarget, KitStoreState } from "./types";

export const KIT_FILE = ".canopy-kit.json";
const SCAN_TIMEOUT = 30_000;
const FETCH_TIMEOUT = 20_000;

/** args: store dir, then `t <agent> <dir>` per target and `s <name> <path>`
 *  per source. Prints tab lines: H home, K tracked skill, G porcelain line,
 *  F fetch failed, N no checkout, X git's first error line in the store,
 *  D agent dir exists parentExists, E agent name kind link,
 *  P agent placed-json, R name 0|1. */
/** a leading ~ to $HOME, and nothing else expanded: the paths come from a
 *  manifest any agent can edit, so they never pass through eval */
const EXP = String.raw`exp() { case $1 in "~") printf %s "$HOME";; "~/"*) printf '%s/%s' "$HOME" "$(printf %s "$1" | cut -c3-)";; *) printf %s "$1";; esac; }`;

/** "up" first, so a run that never reached the host is told apart from a
 *  fetch that failed there */
const FETCH_SCRIPT = `${EXP}
echo up
cd "$(exp "$1")" && git fetch -q origin`;

export const SCAN_SCRIPT = EXP + String.raw`
list() {
  for p in "$2"/*; do
    [ -e "$p" ] || [ -L "$p" ] || continue
    n=$(basename "$p")
    if [ -L "$p" ]; then printf 'E\t%s\t%s\tlink\t%s\n' "$1" "$n" "$(readlink "$p")"
    elif [ -d "$p" ]; then printf 'E\t%s\t%s\tdir\t\n' "$1" "$n"
    else printf 'E\t%s\t%s\tfile\t\n' "$1" "$n"; fi
  done
}
placed() { [ -f "$2/${KIT_FILE}" ] && printf 'P\t%s\t%s\n' "$1" "$(tr -d '\n' < "$2/${KIT_FILE}")"; return 0; }
store=$(exp "$1"); shift
printf 'H\t%s\n' "$HOME"
# a git that fails must say so: an empty tracked list would plan the
# removal of every placed link
gitq() { out=$(git -C "$store" "$@" 2>/dev/null) && return 0; printf 'X\t%s\n' "$(git -C "$store" "$@" 2>&1 >/dev/null | grep -v '^$' | head -n 1)"; return 1; }
if [ -d "$store/.git" ]; then
  if gitq ls-files -- skills; then
    k=$out
    if gitq status --porcelain=v2 --branch; then
      printf '%s\n' "$k" | cut -d/ -f2 | sort -u | while IFS= read -r l; do [ -n "$l" ] && printf 'K\t%s\n' "$l"; done
      printf '%s\n' "$out" | while IFS= read -r l; do [ -n "$l" ] && printf 'G\t%s\n' "$l"; done
    fi
  fi
else
  printf 'N\n'
fi
while [ $# -gt 0 ]; do
  case $1 in
    t) a=$2; d=$(exp "$3"); shift 3
       pe=0; [ -d "$(dirname "$d")" ] && pe=1
       if [ -d "$d" ]; then printf 'D\t%s\t%s\t1\t%s\n' "$a" "$d" "$pe"; list "$a" "$d"; placed "$a" "$d"
       else printf 'D\t%s\t%s\t0\t%s\n' "$a" "$d" "$pe"; fi ;;
    s) if [ -e "$3" ]; then printf 'R\t%s\t1\n' "$2"; else printf 'R\t%s\t0\n' "$2"; fi; shift 3 ;;
    *) shift ;;
  esac
done
`;

/** the store dir is the store target's skills dir's parent */
const storeDir = (skills: string) => skills.replace(/\/skills\/?$/, "");

export function scanArgs(kit: KitManifest, machine: string, dev: string): string[] {
  const ts = targetsFor(kit, machine);
  const args = [storeDir(ts[0]!.skills)];
  for (const t of ts) args.push("t", t.agent, t.skills);
  for (const [name, o] of Object.entries(kit.only)) {
    const p = o.source ? sourcePath(o.source, dev) : null;
    if (p) args.push("s", name, p);
  }
  return args;
}

const KINDS: readonly KitEntryKind[] = ["dir", "link", "file"];

export function parseScan(machine: string, stdout: string, at: number): KitSeen {
  let home = "";
  const tracked: string[] = [];
  let branch: string | null = null;
  let ahead = 0;
  let behind = 0;
  let dirty = 0;
  let checkout = true;
  let gitError: string | null = null;
  const targets: KitSeenTarget[] = [];
  const sources: Record<string, boolean> = {};
  const byAgent = (a: string) => targets.find((t) => t.agent === a);
  for (const line of stdout.split("\n")) {
    const f = line.split("\t");
    switch (f[0]) {
      case "H": home = f[1] ?? ""; break;
      case "N": checkout = false; break;
      case "X": gitError = f.slice(1).join("\t").trim() || "git failed"; break;
      case "K": if (SKILL_NAME.test(f[1] ?? "")) tracked.push(f[1]!); break;
      case "G": {
        const g = f.slice(1).join("\t");
        if (g.startsWith("# branch.head ")) branch = g.slice(14);
        else if (g.startsWith("# branch.ab ")) {
          const m = /\+(\d+) -(\d+)/.exec(g);
          ahead = Number(m?.[1] ?? 0);
          behind = Number(m?.[2] ?? 0);
        } else if (!g.startsWith("#") && g.trim()) dirty++;
        break;
      }
      case "D": targets.push({ agent: f[1]!, dir: f[2]!, exists: f[3] === "1", parentExists: f[4] === "1", entries: [], placed: {} }); break;
      case "E": {
        const t = byAgent(f[1]!);
        const kind = f[3] as KitEntryKind;
        if (t && SKILL_NAME.test(f[2] ?? "") && KINDS.includes(kind)) {
          const e: KitEntry = { name: f[2]!, kind, link: kind === "link" ? (f[4] ?? "") : null };
          t.entries.push(e);
        }
        break;
      }
      case "P": {
        const t = byAgent(f[1]!);
        try {
          const j = JSON.parse(f.slice(2).join("\t")) as { placed?: Record<string, string> };
          if (t && j.placed && typeof j.placed === "object") t.placed = j.placed;
        } catch { /* a broken placed file reads as nothing placed */ }
        break;
      }
      case "R": sources[f[1]!] = f[2] === "1"; break;
    }
  }
  for (const t of targets) t.entries.sort((a, b) => a.name.localeCompare(b.name));
  if (gitError !== null) return { machine, at, away: `store: ${gitError}`, home, store: null, targets, sources };
  const store: KitStoreState | null = checkout ? { tracked, branch, ahead, behind, dirty, fetchFailed: false } : null;
  return { machine, at, away: null, home, store, targets, sources };
}

/** the last useful line of a failed ssh or sh */
const reason = (stderr: string, code: number) =>
  stderr.split("\n").map((l) => l.replace(/^#\s*/, "").trim()).filter(Boolean)[0] ?? `exited ${code}`;

export async function seeKit(
  kit: KitManifest,
  m: { name: string; host: string | null; dev: string },
  opts: { run?: typeof onHost; env?: Record<string, string>; timeoutMs?: number; now?: () => number } = {},
): Promise<KitSeen> {
  const run = opts.run ?? onHost;
  const now = opts.now ?? Date.now;
  const store = storeDir(targetsFor(kit, m.name)[0]!.skills);
  const fetched = await run(m.host, ["sh", "-c", FETCH_SCRIPT, "kit-fetch", store], {
    env: opts.env, timeoutMs: FETCH_TIMEOUT,
  });
  // ssh that never ran the command (a refused connection, Tailscale's
  // browser check hanging until the timeout) would only hang the scan too
  if (m.host !== null && !/^up$/m.test(fetched.stdout)) {
    const why = fetched.stderr.trim() ? reason(fetched.stderr, fetched.code) : `no answer from ${m.host} within ${FETCH_TIMEOUT / 1000} s`;
    return { machine: m.name, at: now(), away: why, home: "", store: null, targets: [], sources: {} };
  }
  const r = await run(m.host, ["sh", "-c", SCAN_SCRIPT, "kit-scan", ...scanArgs(kit, m.name, m.dev)], {
    env: opts.env, timeoutMs: opts.timeoutMs ?? SCAN_TIMEOUT,
  });
  if (r.code !== 0) {
    return { machine: m.name, at: now(), away: reason(r.stderr, r.code), home: "", store: null, targets: [], sources: {} };
  }
  const seen = parseScan(m.name, r.stdout, now());
  if (seen.store && fetched.code !== 0) seen.store.fetchFailed = true;
  return seen;
}
