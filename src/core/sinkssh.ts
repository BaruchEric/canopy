/**
 * Sinks on a machine with no canopy backend (gpd), written by the backend
 * that reaches it over ssh (phase 3 spec, part A2). Every call is a fixed
 * sh script run through `onHost`, with paths as its arguments. A file's
 * text comes back as base64 on one line, and new text goes out as base64
 * on stdin, so no value is ever an argument and none is parsed by sh. The
 * merge that keeps a file's other keys runs here, in `syncSink`, as for a
 * local sink.
 */

import { onHost, type ExecResult } from "./exec";
import { MCP_SERVER_STRICT_SRC } from "./secretfile";
import type { SinkIO } from "./sinksync";

export interface RemoteSinks {
  machine: string;
  /** null and the machine's $HOME when it answers, else why not */
  probe(): Promise<{ home: string } | { away: string }>;
  io: SinkIO;
  /** why a sink may not live at `path` there: inside a git work tree that does not ignore it */
  refusal(path: string): Promise<string | null>;
  /** remove the kit's env files in `dir` that no sink names; never rejects */
  prune(dir: string, keep: readonly string[]): Promise<{ removed: string[]; failed: string[] }>;
}

type Run = (host: string | null, cmd: string[], opts: { timeoutMs?: number; input?: string }) => Promise<ExecResult>;

const PROBE_TIMEOUT = 20_000;
const CALL_TIMEOUT = 30_000;

const PROBE = `printf 'up %s\\n' "$HOME"`;

/** L a symlink, N missing, F <base64> the text, E unreadable */
const READ = `p=$1
if [ -L "$p" ]; then echo L; exit 0; fi
if [ ! -e "$p" ]; then echo N; exit 0; fi
if [ -f "$p" ] && [ -r "$p" ]; then printf 'F '; base64 <"$p" | tr -d '\\n'; echo; exit 0; fi
echo E`;

/** stdin is the new text as base64; a temp file in the same folder, 0600, renamed over */
const WRITE = `p=$1
d=$(dirname "$p")
b=$(basename "$p")
if [ -L "$p" ]; then echo "$p is a symlink; canopy writes only plain files" >&2; exit 3; fi
if [ ! -d "$d" ]; then
  if [ "$(basename "$d")" = mcp-env ] && [ -d "$(dirname "$d")" ]; then mkdir -m 700 "$d" || exit 4
  else echo "no folder $d" >&2; exit 4; fi
fi
umask 077
t="$d/.$b.canopy-$$"
if ! base64 -d >"$t"; then rm -f "$t"; echo "the text did not decode" >&2; exit 5; fi
chmod 600 "$t" && mv -f "$t" "$p" || { rm -f "$t"; exit 6; }`;

/** OK, or IN <top> when the path is in a work tree that does not ignore it */
const REFUSAL = `p=$1
d=$(dirname "$p")
while [ ! -d "$d" ]; do d=$(dirname "$d"); done
top=$(git -C "$d" rev-parse --show-toplevel 2>/dev/null) || { echo OK; exit 0; }
if git -C "$top" check-ignore -q "$p"; then echo OK; else printf 'IN %s\\n' "$top"; fi`;

/** the names in a folder, one a line; nothing when it is missing */
const LIST = `[ -d "$1" ] || exit 0
for f in "$1"/* "$1"/.[!.]*; do [ -f "$f" ] && [ ! -L "$f" ] && printf '%s\\n' "\${f##*/}"; done; exit 0`;

/** removes each named regular file in a folder, printing R or X per name */
const REMOVE = `d=$1; shift
for n in "$@"; do f="$d/$n"; if [ -f "$f" ] && [ ! -L "$f" ] && rm -f "$f"; then printf 'R %s\\n' "$n"; else printf 'X %s\\n' "$n"; fi; done`;

const MCP_ENV_FILE = new RegExp(`^${MCP_SERVER_STRICT_SRC}\\.(env|headers\\.json)$`);

/** the last useful line of a failed ssh or sh */
const reason = (r: ExecResult): string =>
  r.stderr.split("\n").map((l) => l.trim()).filter(Boolean)[0] ?? `exited ${r.code}`;

export function sshSinks(machine: string, host: string, run: Run = onHost): RemoteSinks {
  const sh = (script: string, name: string, args: string[], opts: { timeoutMs?: number; input?: string } = {}) =>
    run(host, ["sh", "-c", script, name, ...args], { timeoutMs: opts.timeoutMs ?? CALL_TIMEOUT, ...(opts.input !== undefined ? { input: opts.input } : {}) });
  return {
    machine,
    async probe() {
      const r = await sh(PROBE, "sink-probe", [], { timeoutMs: PROBE_TIMEOUT });
      const m = /^up (\/\S*)$/m.exec(r.stdout);
      if (r.code === 0 && m?.[1]) return { home: m[1] };
      return { away: r.stderr.trim() ? reason(r) : `no answer from ${host} within ${PROBE_TIMEOUT / 1000} s` };
    },
    io: {
      async read(path) {
        const r = await sh(READ, "sink-read", [path]);
        if (r.code !== 0) return { error: `${machine}: ${path} could not be read (${reason(r)})` };
        const line = r.stdout.trim();
        if (line === "N") return { text: null };
        if (line === "L") return { error: `${path} is a symlink on ${machine}; canopy writes only plain files` };
        if (line.startsWith("F ")) return { text: Buffer.from(line.slice(2), "base64").toString("utf8") };
        if (line === "F") return { text: "" };
        return { error: `${path} cannot be read on ${machine}` };
      },
      async write(path, text) {
        const r = await sh(WRITE, "sink-write", [path], { input: Buffer.from(text, "utf8").toString("base64") });
        if (r.code !== 0) throw new Error(`${machine}: ${reason(r)}`);
      },
    },
    async refusal(path) {
      const r = await sh(REFUSAL, "sink-refusal", [path]);
      if (r.code !== 0) return `${machine}: could not check ${path} (${reason(r)})`;
      const line = r.stdout.trim();
      if (line === "OK") return null;
      return `${path} is inside the repo ${line.replace(/^IN /, "")} on ${machine} and git does not ignore it there`;
    },
    async prune(dir, keep) {
      const out = { removed: [] as string[], failed: [] as string[] };
      try {
        const listed = await sh(LIST, "sink-list", [dir]);
        if (listed.code !== 0) return out;
        const gone = listed.stdout.split("\n").filter((n) => MCP_ENV_FILE.test(n) && !keep.includes(`${dir}/${n}`)).sort();
        if (gone.length === 0) return out;
        const r = await sh(REMOVE, "sink-prune", [dir, ...gone]);
        for (const line of r.stdout.split("\n")) {
          const n = line.slice(2);
          if (!gone.includes(n)) continue;
          (line.startsWith("R ") ? out.removed : out.failed).push(n);
        }
        for (const n of gone) if (!out.removed.includes(n) && !out.failed.includes(n)) out.failed.push(n);
      } catch {
        // a prune never rejects; the next pass tries again
      }
      return out;
    },
  };
}
