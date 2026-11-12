/** Reading and changing one machine's agent plugins (FR-064): one sh script
 *  through onHost for the read, so an ssh machine reads the way the local
 *  one does, and the agent's own CLI for every change. Needs Bun. */
import { onHost, type ExecResult } from "./exec";
import { jsonOf, parseClaudeList, parseClaudeMarkets, parseCodexList, parseCodexMarkets, parseSettings } from "./plugins";
import type { PluginAgent, PluginAgentSeen, PluginMachineSeen } from "./types";

const SCAN_TIMEOUT = 60_000;
/** an install clones a marketplace or a plugin repo */
export const OP_TIMEOUT = 5 * 60_000;
export const CATALOG_TIMEOUT = 2 * 60_000;

/** args: the agents to read. Prints tab lines: P agent path (absolute, or
 *  empty when the CLI is not found), S agent what code base64 (what is
 *  list, markets or settings; the CLI's stdout, base64 on one line so no
 *  JSON passes through sh), and for claude G tag dirty: settings.json's
 *  `git ls-files -t` tag in ~/.claude (H: tracked and checked out), 1
 *  when git sees it changed, and how many commits its upstream lacks. Each CLI runs from $HOME, so no project's
 *  plugins mix in. KIT_CLAUDE and KIT_CODEX name the CLIs (the tests);
 *  KIT_CLAUDE_HOME is the home claude runs under, when it is not $HOME
 *  (the mini's container, server/kit.ts claudeHome). */
export const PLUGIN_SCAN_SCRIPT = String.raw`
abs() { case $1 in /*) [ -x "$1" ] && printf %s "$1";; esac; }
b64() { base64 | tr -d '\n'; }
find_cli() {
  c=$(abs "$2")
  [ -n "$c" ] || c=$(abs "$(command -v "$1" 2>/dev/null)")
  [ -n "$c" ] || c=$(abs "$HOME/.local/bin/$1")
  [ -n "$c" ] || c=$(abs "$("${"$"}{SHELL:-sh}" -lc "command -v $1" 2>/dev/null </dev/null)")
  printf %s "$c"
}
sec() {
  a=$1; w=$2; shift 2
  out=$("$@" </dev/null 2>/dev/null); rc=$?
  printf 'S\t%s\t%s\t%s\t%s\n' "$a" "$w" "$rc" "$(printf %s "$out" | b64)"
}
cd "$HOME" 2>/dev/null || true
ch=${"$"}{KIT_CLAUDE_HOME:-$HOME}
for a in "$@"; do
  case $a in
    claude) c=$(find_cli claude "${"$"}{KIT_CLAUDE:-}") ;;
    codex) c=$(find_cli codex "${"$"}{KIT_CODEX:-}") ;;
    *) continue ;;
  esac
  printf 'P\t%s\t%s\n' "$a" "$c"
  [ -n "$c" ] || continue
  h=$HOME; [ "$a" = claude ] && h=$ch
  sec "$a" list env HOME="$h" "$c" plugin list --json
  sec "$a" markets env HOME="$h" "$c" plugin marketplace list --json
  if [ "$a" = claude ]; then
    f="$HOME/.claude/settings.json"
    [ -r "$f" ] && printf 'S\tclaude\tsettings\t0\t%s\n' "$(b64 < "$f")"
    t=$(git -C "$HOME/.claude" ls-files -t -- settings.json 2>/dev/null | cut -c1)
    d=0; [ -n "$(git -C "$HOME/.claude" status --porcelain -- settings.json 2>/dev/null)" ] && d=1
    u=$(git -C "$HOME/.claude" rev-list --count '@{u}..HEAD' 2>/dev/null)
    printf 'G\t%s\t%s\t%s\n' "$t" "$d" "${"$"}{u:-0}"
  fi
done
`;

/** runs a CLI from $HOME with its own arguments, never through a shell line */
export const CLI_SCRIPT = 'cd "$HOME" 2>/dev/null || true; exec "$@"';

const unb64 = (s: string): string => Buffer.from(s, "base64").toString("utf8");

const reason = (stderr: string, code: number) =>
  stderr.split("\n").map((l) => l.replace(/^#\s*/, "").trim()).filter(Boolean)[0] ?? `exited ${code}`;

const empty = (agent: PluginAgent, path: string | null, error: string | null): PluginAgentSeen =>
  ({ agent, path, error, plugins: [], markets: [], declared: {}, declaredMarkets: {} });

export function parsePluginScan(machine: string, at: number, text: string, agents: readonly PluginAgent[], commits: boolean): PluginMachineSeen {
  const seen: PluginMachineSeen = { machine, at, away: null, shared: false, settingsDirty: false, commits, agents: [] };
  const by = new Map<PluginAgent, PluginAgentSeen>();
  for (const line of text.split("\n")) {
    const f = line.split("\t");
    const agent = agents.find((a) => a === f[1]);
    if (f[0] === "P" && agent) {
      const path = f[2]?.startsWith("/") ? f[2] : null;
      by.set(agent, empty(agent, path, path ? null : `${agent} is not installed here`));
    } else if (f[0] === "S" && agent) {
      const a = by.get(agent);
      if (!a) continue;
      const what = f[2];
      const code = Number(f[3]);
      const body = unb64(f[4] ?? "");
      if (what === "settings") {
        Object.assign(a, parseSettings(body));
        continue;
      }
      const v = jsonOf(body);
      if (what === "list") {
        const list = agent === "claude" ? parseClaudeList(v) : parseCodexList(v);
        if (list) a.plugins = list;
        else a.error = `${agent} plugin list ${code === 0 ? "printed no list" : `exited ${code}`}`;
      } else if (what === "markets") {
        a.markets = (agent === "claude" ? parseClaudeMarkets(v) : parseCodexMarkets(v)) ?? [];
      }
    } else if (f[0] === "G") {
      seen.shared = f[1] === "H";
      seen.settingsDirty = f[2] === "1";
      const u = Number(f[3]);
      if (u > 0) seen.unpushed = u;
    }
  }
  seen.agents = agents.flatMap((a) => { const s = by.get(a); return s ? [s] : []; });
  return seen;
}

export interface PluginIO {
  run?: typeof onHost;
  env?: Record<string, string>;
  now?: () => number;
}

/** one machine's plugins; a scan that fails reads away with the reason */
export async function seePlugins(m: { name: string; host: string | null }, agents: readonly PluginAgent[], commits: boolean, io: PluginIO = {}): Promise<PluginMachineSeen> {
  const at = (io.now ?? Date.now)();
  const r = await (io.run ?? onHost)(m.host, ["sh", "-c", PLUGIN_SCAN_SCRIPT, "kit-plugins", ...agents], { env: io.env, timeoutMs: SCAN_TIMEOUT });
  if (r.code !== 0) return { machine: m.name, at, away: `the plugin scan failed: ${reason(r.stderr, r.code)}`, shared: false, settingsDirty: false, commits, agents: [] };
  return parsePluginScan(m.name, at, r.stdout, agents, commits);
}

/** one CLI call from $HOME on a machine */
export function runCli(host: string | null, path: string, args: string[], io: PluginIO & { timeoutMs: number }): Promise<ExecResult> {
  return (io.run ?? onHost)(host, ["sh", "-c", CLI_SCRIPT, "kit-plugin", path, ...args], { env: io.env, timeoutMs: io.timeoutMs });
}

/** a terminal's colours and cursor moves out of a CLI's text */
// eslint-disable-next-line no-control-regex
export const plain = (s: string): string => s.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "");

/* ---------- codex's switch in config.toml ---------- */

/** Codex's CLI has no command that turns a plugin off and on; its
 *  config.toml does, as `enabled` in the plugin's own `[plugins."id"]`
 *  table, which codex writes when it installs a local plugin. Args: mode,
 *  then for set the id and true|false, for undo the checksum set printed.
 *  set rewrites that one line into a copy that keeps the file's mode,
 *  keeps the file as it was in config.toml.canopy-before, and swaps the
 *  copy in only when nothing else wrote the file meanwhile, then prints
 *  `S <cksum>`. keep drops the copy of before; undo puts it back, unless
 *  the file changed since set. Never adds a table: a second one for the
 *  same plugin stops codex reading its config at all. Exits: 3 no file or
 *  a link, 4 no table, 5 two tables, 6 no enabled line, 7 already so, 8
 *  the file changed underneath. */
export const CODEX_SWITCH_SCRIPT = String.raw`
f=${"$"}{CODEX_HOME:-$HOME/.codex}/config.toml
b="$f.canopy-before"
case $1 in
  keep) rm -f "$b"; exit 0 ;;
  undo)
    [ -f "$b" ] || { echo "nothing to put back"; exit 3; }
    [ "$(cksum < "$f")" = "$2" ] || { rm -f "$b"; echo "config.toml changed after canopy's edit, so it stays as it is"; exit 8; }
    mv -f "$b" "$f"; exit $? ;;
  set) ;;
  *) echo "usage: set id true|false, keep, undo cksum"; exit 2 ;;
esac
[ -f "$f" ] || { echo "there is no $f"; exit 3; }
[ -L "$f" ] && { echo "$f is a link; canopy edits only a plain file"; exit 3; }
before=$(cksum < "$f")
t=$(mktemp "$f.canopy.XXXXXX") || exit 1
cp -p "$f" "$t" || { rm -f "$t"; exit 1; }
awk -v id="$2" -v v="$3" '
BEGIN { hdr = "[plugins.\"" id "\"]"; inside = 0; found = 0; done = 0; was = "" }
{
  s = $0; sub(/^[ \t]+/, "", s); sub(/[ \t]+$/, "", s)
  if (substr(s, 1, 1) == "[") { inside = (s == hdr); if (inside) found++ }
  else if (inside && !done && s ~ /^enabled[ \t]*=/) {
    was = s; sub(/^enabled[ \t]*=[ \t]*/, "", was); sub(/[ \t]*#.*$/, "", was)
    print "enabled = " v; done = 1; next
  }
  print
}
END { if (found == 0) exit 4; if (found > 1) exit 5; if (!done) exit 6; if (was == v) exit 7 }
' "$f" > "$t"
rc=$?
if [ "$rc" -ne 0 ]; then
  rm -f "$t"
  case $rc in
    4) echo "config.toml has no [plugins.\"$2\"] table" ;;
    5) echo "config.toml has two [plugins.\"$2\"] tables" ;;
    6) echo "the [plugins.\"$2\"] table in config.toml has no enabled line" ;;
    7) echo "config.toml already has enabled = $3" ;;
    *) echo "awk exited $rc" ;;
  esac
  exit "$rc"
fi
[ "$(cksum < "$f")" = "$before" ] || { rm -f "$t"; echo "config.toml changed while canopy edited it"; exit 8; }
cp -p "$f" "$b" || { rm -f "$t"; exit 1; }
mv -f "$t" "$f" || { rm -f "$t" "$b"; exit 1; }
printf 'S\t%s\n' "$(cksum < "$f")"
`;

/** runs the switch script on a machine, under codex's own home */
export function codexSwitch(host: string | null, args: string[], io: PluginIO): Promise<ExecResult> {
  return (io.run ?? onHost)(host, ["sh", "-c", CODEX_SWITCH_SCRIPT, "kit-codex-switch", ...args], { env: io.env, timeoutMs: SCAN_TIMEOUT });
}

/* ---------- committing dotclaude's settings.json ---------- */

/** reads ~/.claude's branch, settings.json's hash and both its HEAD and
 *  working bytes, base64 so no JSON passes through sh */
export const SETTINGS_READ_SCRIPT = String.raw`
cd "$HOME/.claude" 2>/dev/null || { echo "there is no ~/.claude"; exit 3; }
git rev-parse --is-inside-work-tree >/dev/null 2>&1 || { echo "~/.claude is not a git checkout"; exit 3; }
[ -f settings.json ] || { echo "~/.claude has no settings.json"; exit 3; }
printf 'B\t%s\n' "$(git symbolic-ref -q --short HEAD)"
printf 'X\t%s\n' "$(git hash-object settings.json)"
d=0; [ -n "$(git status --porcelain -- settings.json)" ] && d=1
printf 'D\t%s\n' "$d"
printf 'H\t%s\n' "$(git show HEAD:settings.json 2>/dev/null | base64 | tr -d '\n')"
printf 'W\t%s\n' "$(base64 < settings.json | tr -d '\n')"
`;

/** Commits settings.json alone (git commit's pathspec leaves anything
 *  else staged as it is) when it still hashes to $1, with message $2, and
 *  pushes. A push turned away is rebased onto the remote and tried once
 *  more, but only when no other tracked file is changed, so a conflict
 *  never leaves the checkout every machine pulls from mid-rebase. git
 *  never prompts: no terminal, and ssh in batch mode unless the repo
 *  names its own ssh command. Prints E <why> and exits non-zero before a
 *  commit; after one, C <short sha> and P ok or P failed <git's words,
 *  without its hints>. */
export const SETTINGS_COMMIT_SCRIPT = String.raw`
cd "$HOME/.claude" 2>/dev/null || { printf 'E\tthere is no ~/.claude\n'; exit 3; }
export GIT_TERMINAL_PROMPT=0
[ -n "$(git config core.sshCommand)" ] || export GIT_SSH_COMMAND="ssh -o BatchMode=yes -o ConnectTimeout=20"
br=$(git symbolic-ref -q --short HEAD) || { printf 'E\t~/.claude is on no branch\n'; exit 3; }
git rev-parse -q --verify '@{u}' >/dev/null || { printf 'E\t%s has no upstream to push to\n' "$br"; exit 3; }
[ "$(git hash-object settings.json)" = "$1" ] || { printf 'E\tsettings.json changed since it was shown; look at it again\n'; exit 7; }
[ -n "$(git status --porcelain -- settings.json)" ] || { printf 'E\tsettings.json has nothing to commit\n'; exit 8; }
out=$(git commit -q -m "$2" -- settings.json 2>&1 </dev/null) || { printf 'E\t%s\n' "$(printf %s "$out" | tr '\n' ' ')"; exit 9; }
printf 'C\t%s\n' "$(git rev-parse --short HEAD)"
out=$(git push -q 2>&1 </dev/null) && { printf 'P\tok\n'; exit 0; }
if [ -z "$(git status --porcelain --untracked-files=no)" ]; then
  if git pull -q --rebase --no-autostash </dev/null >/dev/null 2>&1; then
    printf 'C\t%s\n' "$(git rev-parse --short HEAD)"
    out=$(git push -q 2>&1 </dev/null) && { printf 'P\tok\n'; exit 0; }
  else
    git rebase --abort >/dev/null 2>&1
  fi
fi
printf 'P\tfailed\t%s\n' "$(printf '%s\n' "$out" | grep -v -e '^hint:' -e '^To ' | tr '\n' ' ')"
`;

export interface SettingsGit { branch: string; sha: string; dirty: boolean; head: string; work: string }

export function parseSettingsRead(text: string): SettingsGit {
  const out: SettingsGit = { branch: "", sha: "", dirty: false, head: "", work: "" };
  for (const line of text.split("\n")) {
    const [k, v = ""] = line.split("\t");
    if (k === "B") out.branch = v;
    else if (k === "X") out.sha = v;
    else if (k === "D") out.dirty = v === "1";
    else if (k === "H") out.head = unb64(v);
    else if (k === "W") out.work = unb64(v);
  }
  return out;
}

/** what the commit script came to: the commit it made, and whether the push went */
export function parseCommitRun(text: string): { error: string | null; commit: string | null; pushed: boolean; pushError: string } {
  let error: string | null = null;
  let commit: string | null = null;
  let pushed = false;
  let pushError = "";
  for (const line of text.split("\n")) {
    const f = line.split("\t");
    if (f[0] === "E") error = f.slice(1).join("\t").trim();
    else if (f[0] === "C") commit = f[1] ?? null;
    else if (f[0] === "P") {
      pushed = f[1] === "ok";
      if (!pushed) pushError = f.slice(2).join("\t").trim();
    }
  }
  return { error, commit, pushed, pushError };
}

export function readSettingsGit(host: string | null, io: PluginIO): Promise<ExecResult> {
  return (io.run ?? onHost)(host, ["sh", "-c", SETTINGS_READ_SCRIPT, "kit-settings-read"], { env: io.env, timeoutMs: SCAN_TIMEOUT });
}

export function commitSettingsGit(host: string | null, sha: string, message: string, io: PluginIO): Promise<ExecResult> {
  return (io.run ?? onHost)(host, ["sh", "-c", SETTINGS_COMMIT_SCRIPT, "kit-settings-commit", sha, message], { env: io.env, timeoutMs: 2 * 60_000 });
}
