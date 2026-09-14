/**
 * A shell inside canopy: one pty per browser terminal, bridged over a
 * websocket. The browser sends keystrokes as binary frames and a resize as a
 * JSON text frame; the pty's output goes back as binary frames and the
 * shell's exit as one JSON text frame before the socket closes.
 *
 * The size, argv and message parsing are pure and tested; `startTerm` is
 * Bun-only, since the pty is Bun's.
 */
import { parseLocator } from "./host";
import { sshSessionArgs, userShell } from "./openers";

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
}

export interface TermHooks {
  data(chunk: Uint8Array): void;
  exit(code: number | null): void;
}

/** Spawns the shell for a repo on a pty of the given size. Throws when the
 *  spawn itself fails (a folder that is gone, a shell that is not there). */
export function startTerm(locator: string, size: TermSize, hooks: TermHooks): TermSession {
  const { host, path } = parseLocator(locator);
  let done = false;
  const terminal = new Bun.Terminal({
    cols: size.cols,
    rows: size.rows,
    data: (_t, chunk) => hooks.data(chunk),
  });
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn(shellArgs(locator), {
      cwd: host === null ? path : undefined,
      env: termEnv(),
      terminal,
    });
  } catch (err) {
    terminal.close();
    throw err;
  }
  void proc.exited.then((code) => {
    done = true;
    terminal.close();
    hooks.exit(code);
  });
  return {
    write: (data) => {
      if (!done && !terminal.closed) terminal.write(data);
    },
    resize: ({ cols, rows }) => {
      if (!done && !terminal.closed) terminal.resize(cols, rows);
    },
    close: () => {
      if (done) return;
      proc.kill("SIGHUP");
      // a shell that ignores the hangup gets the same treatment a closed
      // terminal window gives it
      setTimeout(() => {
        if (!done) proc.kill("SIGKILL");
      }, 3_000).unref();
    },
  };
}
