/**
 * A shell inside canopy: one pty per browser terminal, bridged over a
 * websocket. The browser sends keystrokes as binary frames and a resize as a
 * JSON text frame; the pty's output goes back as binary frames and the
 * shell's exit as one JSON text frame before the socket closes.
 *
 * The pty outlives the socket: the browser names it (`termId`, made there),
 * a socket for a name the server holds attaches to that shell, one for a
 * name it does not starts a new shell under it, and a socket closing leaves
 * the shell running for the next one. The server keeps the last stretch of
 * output in a `Scrollback` so the next socket sees what it missed.
 *
 * The size, argv, id and message parsing and the scrollback are pure and
 * tested; `startTerm` is Bun-only, since the pty is Bun's.
 */
import { parseLocator } from "./host";
import { sshSessionArgs, userShell } from "./openers";
import type { ShellPlace } from "./types";

export interface TermSize {
  cols: number;
  rows: number;
}

/** what a pty is when the browser has not said, and the bounds it may ask for */
export const TERM_SIZE = { cols: 80, rows: 24, min: 2, max: 500 } as const;

const dim = (value: unknown, fallback: number): number => {
  const n = typeof value === "string" ? Number(value) : value;
  if (typeof n !== "number" || !Number.isFinite(n)) return fallback;
  return Math.min(TERM_SIZE.max, Math.max(TERM_SIZE.min, Math.floor(n)));
};

/** A size from the query string or a message: anything missing or absurd
 *  falls back to the default, and the rest is clamped to the bounds. */
export function termSize(cols: unknown, rows: unknown): TermSize {
  return { cols: dim(cols, TERM_SIZE.cols), rows: dim(rows, TERM_SIZE.rows) };
}

/** What the pty runs to land at the repo: the login shell for a folder here,
 *  the same ssh session a terminal tab would open for a folder elsewhere. */
export function shellArgs(locator: string, shell = userShell()): string[] {
  const { host, path } = parseLocator(locator);
  if (host === null) return [shell, "-l", "-i"];
  return sshSessionArgs(host, path, "shell");
}

/** what the browser names a shell: 32 hex digits of its own randomness */
const TERM_ID = /^[0-9a-f]{32}$/;

export const isTermId = (v: unknown): v is string => typeof v === "string" && TERM_ID.test(v);

/** where a shell was opened, off the socket's query; the strip when unsaid */
export const termPlace = (v: unknown): ShellPlace => (v === "panel" ? "panel" : "strip");

/** what a shell keeps of its output for the next socket, in bytes */
export const SCROLLBACK_CAP = 512 * 1024;

/**
 * The last `cap` bytes a pty wrote. Chunks go in whole and the oldest go out
 * whole once the total is over the cap, so a replay may open mid-escape,
 * which xterm reads past. One chunk over the cap on its own keeps its tail.
 */
export class Scrollback {
  private chunks: Uint8Array[] = [];
  private total = 0;

  constructor(readonly cap = SCROLLBACK_CAP) {}

  get size(): number {
    return this.total;
  }

  push(chunk: Uint8Array): void {
    if (chunk.length === 0) return;
    if (chunk.length >= this.cap) {
      this.chunks = [chunk.slice(chunk.length - this.cap)];
      this.total = this.cap;
      return;
    }
    this.chunks.push(chunk);
    this.total += chunk.length;
    while (this.total > this.cap) {
      const gone = this.chunks.shift();
      if (!gone) break;
      this.total -= gone.length;
    }
  }

  /** everything kept, oldest first, as one buffer */
  bytes(): Uint8Array {
    const out = new Uint8Array(this.total);
    let at = 0;
    for (const c of this.chunks) {
      out.set(c, at);
      at += c.length;
    }
    return out;
  }
}

export type TermMessage = { kind: "resize"; size: TermSize };

/** The one text message the browser sends: `{"resize":{"cols","rows"}}`.
 *  Anything else is null and ignored. */
export function parseTermMessage(text: string): TermMessage | null {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return null;
  }
  if (!v || typeof v !== "object" || !("resize" in v)) return null;
  const r = (v as { resize: unknown }).resize;
  if (!r || typeof r !== "object") return null;
  const { cols, rows } = r as { cols?: unknown; rows?: unknown };
  return { kind: "resize", size: termSize(cols, rows) };
}

/** The pty's environment: the server's, told it is a color terminal. */
export function termEnv(base: Record<string, string | undefined> = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) if (v !== undefined) env[k] = v;
  env["TERM"] = "xterm-256color";
  env["COLORTERM"] = "truecolor";
  return env;
}

export interface TermSession {
  write(data: Uint8Array | string): void;
  resize(size: TermSize): void;
  /** ends the shell; `exit` still fires once it is gone */
  close(): void;
  /** ends the pty but leaves the shell running where it can (a tmux session
   *  stays for the next attach); on a plain pty the shell has nowhere to
   *  be, so this is close. `exit` fires either way. */
  detach(): void;
}

export interface TermHooks {
  data(chunk: Uint8Array): void;
  exit(code: number | null): void;
}

/** the process on the pty, and how to hang it up */
export interface PtyProcess {
  argv: string[];
  cwd?: string;
  /** added to the pty's environment */
  env?: Record<string, string>;
  /** ends the shell itself; the process on the pty follows */
  end?: () => Promise<void>;
}

/** A process on a pty of the given size, its output and exit in the hooks.
 *  Throws when the spawn itself fails (a folder that is gone, a binary that
 *  is not there). `close` runs `end` when there is one (the shell lives
 *  elsewhere) and otherwise hangs the process up; `detach` only hangs up.
 *  A process that ignores the hangup gets the same treatment a closed
 *  terminal window gives it. */
export function spawnOnPty(what: PtyProcess, size: TermSize, hooks: TermHooks): TermSession {
  let done = false;
  const terminal = new Bun.Terminal({
    cols: size.cols,
    rows: size.rows,
    data: (_t, chunk) => hooks.data(chunk),
  });
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn(what.argv, { cwd: what.cwd, env: { ...termEnv(), ...what.env }, terminal });
  } catch (err) {
    terminal.close();
    throw err;
  }
  void proc.exited.then((code) => {
    done = true;
    terminal.close();
    hooks.exit(code);
  });
  const hangup = () => {
    if (done) return;
    proc.kill("SIGHUP");
    setTimeout(() => {
      if (!done) proc.kill("SIGKILL");
    }, 3_000).unref();
  };
  return {
    write: (data) => {
      if (!done && !terminal.closed) terminal.write(data);
    },
    resize: ({ cols, rows }) => {
      if (done || terminal.closed) return;
      terminal.resize(cols, rows);
      // The kernel signals a new size only to the pty's foreground group,
      // which the process here is not (a tmux client never took the pty
      // as its terminal), so it is told directly or it keeps its old size.
      proc.kill("SIGWINCH");
    },
    close: () => {
      if (done) return;
      if (what.end) void what.end().finally(hangup);
      else hangup();
    },
    detach: hangup,
  };
}

/** Spawns the shell for a repo on a pty of the given size, straight on it:
 *  the shell lives and dies with the pty. */
export function startTerm(locator: string, size: TermSize, hooks: TermHooks, env?: Record<string, string>): TermSession {
  const { host, path } = parseLocator(locator);
  return spawnOnPty({ argv: shellArgs(locator), cwd: host === null ? path : undefined, env }, size, hooks);
}
