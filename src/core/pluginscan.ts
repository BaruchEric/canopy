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
 *  `git ls-files -t` tag in ~/.claude (H: tracked and checked out) and 1
 *  when git sees it changed. Each CLI runs from $HOME, so no project's
 *  plugins mix in. KIT_CLAUDE and KIT_CODEX name the CLIs (the tests). */
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
for a in "$@"; do
  case $a in
    claude) c=$(find_cli claude "${"$"}{KIT_CLAUDE:-}") ;;
    codex) c=$(find_cli codex "${"$"}{KIT_CODEX:-}") ;;
    *) continue ;;
  esac
  printf 'P\t%s\t%s\n' "$a" "$c"
  [ -n "$c" ] || continue
  sec "$a" list "$c" plugin list --json
  sec "$a" markets "$c" plugin marketplace list --json
  if [ "$a" = claude ]; then
    f="$HOME/.claude/settings.json"
    [ -r "$f" ] && printf 'S\tclaude\tsettings\t0\t%s\n' "$(b64 < "$f")"
    t=$(git -C "$HOME/.claude" ls-files -t -- settings.json 2>/dev/null | cut -c1)
    d=0; [ -n "$(git -C "$HOME/.claude" status --porcelain -- settings.json 2>/dev/null)" ] && d=1
    printf 'G\t%s\t%s\n' "$t" "$d"
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
