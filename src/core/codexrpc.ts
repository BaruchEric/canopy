/** JSON-RPC over a child process's stdio, the dialect `codex app-server`
 *  speaks: one JSON object per line, JSON-RPC 2.0 without the `jsonrpc`
 *  field. Both ends make requests. canopy asks for threads and turns, and the
 *  server asks canopy for approvals and answers, under ids of its own that
 *  start at 0. So a reply is matched by id alone, and 0 is a real id.
 *
 *  The spawn is injected. The driver hands in `bunSpawn`, the tests an
 *  in-memory pair of pipes. The line framing and the message classifier are
 *  pure and exported, since partial chunks are where a stdio client goes
 *  wrong quietly. */

/** stderr kept for an error message, after ANSI colour codes are stripped */
const STDERR_CAP = 2_000;

/** the one side of the child's stdin the client uses; a Bun FileSink fits */
export interface RpcWriter {
  write(chunk: string): unknown;
  flush?(): unknown;
  end(): unknown;
}

/** A started child process as the client sees it. */
export interface RpcProc {
  stdin: RpcWriter;
  stdout: ReadableStream<Uint8Array>;
  stderr?: ReadableStream<Uint8Array> | null;
  /** resolves with the exit code, null when a signal ended it */
  exited: Promise<number | null>;
  kill(): void;
}

export type RpcSpawn = (
  argv: readonly string[],
  opts: { cwd: string; env: Record<string, string | undefined> },
) => RpcProc;

/** The real thing: Bun.spawn with every stdio stream piped. */
export const bunSpawn: RpcSpawn = (argv, { cwd, env }) => {
  const p = Bun.spawn([...argv], { cwd, env, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  return {
    stdin: p.stdin,
    stdout: p.stdout,
    stderr: p.stderr,
    // Bun reports a signal death as exitCode null and resolves `exited`
    // with the signal's number; the code is what the caller reads.
    exited: p.exited.then(() => p.exitCode),
    kill: () => p.kill(),
  };
};

export type RpcId = number | string;

/** An error the other end answered a request with. */
export class RpcError extends Error {
  constructor(
    readonly method: string,
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = "RpcError";
  }
}

/** The process went away while a request waited for its answer. */
export class RpcClosed extends Error {
  constructor(
    readonly method: string,
    readonly code: number | null,
    readonly stderr: string,
  ) {
    super(`the process exited (code ${code}) before answering ${method}${stderr ? `: ${stderr}` : ""}`);
    this.name = "RpcClosed";
  }
}

export interface RpcExit {
  code: number | null;
  /** the last of stderr, colour codes stripped */
  stderr: string;
}

/** A request the server sent. Answer it exactly once, through the client. */
export interface RpcRequest {
  id: RpcId;
  method: string;
  params: unknown;
}

export type RpcMessage =
  | { kind: "response"; id: RpcId; result: unknown }
  | { kind: "error"; id: RpcId; code: number; message: string; data?: unknown }
  | { kind: "request"; id: RpcId; method: string; params: unknown }
  | { kind: "notification"; method: string; params: unknown };

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const isId = (v: unknown): v is RpcId => typeof v === "number" || typeof v === "string";

/** One line off stdout as a message, or null for anything that is not one:
 *  blank lines, log chatter, JSON that is not a JSON-RPC object. A
 *  `jsonrpc` field is allowed and ignored, so a server that starts sending
 *  it breaks nothing. */
export function parseMessage(line: string): RpcMessage | null {
  const text = line.trim();
  if (!text.startsWith("{")) return null;
  let o: unknown;
  try {
    o = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(o)) return null;
  const method = typeof o["method"] === "string" ? o["method"] : null;
  const id = o["id"];
  if (method !== null) {
    return isId(id)
      ? { kind: "request", id, method, params: o["params"] }
      : { kind: "notification", method, params: o["params"] };
  }
  if (!isId(id)) return null;
  if (isRecord(o["error"])) {
    const e = o["error"];
    return {
      kind: "error",
      id,
      code: typeof e["code"] === "number" ? e["code"] : 0,
      message: typeof e["message"] === "string" ? e["message"] : "error",
      ...(e["data"] !== undefined ? { data: e["data"] } : {}),
    };
  }
  if ("result" in o) return { kind: "response", id, result: o["result"] };
  return null;
}

/** Cuts a byte stream into lines. A chunk may end mid-line, or mid-character:
 *  the decoder keeps the partial character, the splitter the partial line. */
export class LineSplitter {
  private buf = "";
  private dec = new TextDecoder();

  push(chunk: Uint8Array | string): string[] {
    this.buf += typeof chunk === "string" ? chunk : this.dec.decode(chunk, { stream: true });
    const out: string[] = [];
    let nl = this.buf.indexOf("\n");
    while (nl !== -1) {
      out.push(this.buf.slice(0, nl).replace(/\r$/, ""));
      this.buf = this.buf.slice(nl + 1);
      nl = this.buf.indexOf("\n");
    }
    return out;
  }

  /** what is left once the stream has ended: a last line with no newline */
  flush(): string[] {
    this.buf += this.dec.decode();
    const rest = this.buf;
    this.buf = "";
    return rest.trim() ? [rest] : [];
  }
}

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]/g;

/** stderr fit for an error message: colour codes gone, the last `cap`
 *  characters kept, trimmed. */
export function stderrTail(text: string, cap = STDERR_CAP): string {
  const plain = text.replace(ANSI, "");
  return (plain.length > cap ? plain.slice(-cap) : plain).trim();
}

type Waiter = { method: string; resolve: (v: unknown) => void; reject: (e: Error) => void };

/** One connection to one child process. Requests are answered in any order;
 *  notifications and server requests go to the handlers set on it. When the
 *  process ends, every request still waiting is rejected with `RpcClosed`,
 *  and `done` resolves with the exit code and the stderr tail. */
export class RpcClient {
  private next = 1;
  private waiting = new Map<RpcId, Waiter>();
  private notified: (method: string, params: unknown) => void = () => {};
  private asked: ((req: RpcRequest) => void) | null = null;
  private stderr = "";
  private ended = false;
  private exit: RpcExit | null = null;
  /** resolves once stdout has ended and the process has exited */
  readonly done: Promise<RpcExit>;

  constructor(
    private proc: RpcProc,
    private opts: { stderrCap?: number } = {},
  ) {
    const reading = this.read();
    const draining = this.drainStderr();
    this.done = Promise.all([reading, draining, proc.exited.catch(() => null)]).then(
      ([, , code]) => {
        const exit: RpcExit = { code, stderr: this.stderrTail() };
        this.exit = exit;
        this.ended = true;
        for (const [id, w] of this.waiting) {
          this.waiting.delete(id);
          w.reject(new RpcClosed(w.method, code, exit.stderr));
        }
        return exit;
      },
    );
  }

  /** true once the process has gone and `done` has resolved */
  get closed(): boolean {
    return this.exit !== null;
  }

  onNotification(fn: (method: string, params: unknown) => void): void {
    this.notified = fn;
  }

  /** Server requests go here. Without a handler each is refused with
   *  "method not found", so the server never waits on canopy for nothing. */
  onRequest(fn: (req: RpcRequest) => void): void {
    this.asked = fn;
  }

  /** Sends a request; resolves with its result, rejects with `RpcError` for
   *  an error answer and `RpcClosed` when the process goes first. */
  request<T = unknown>(method: string, params?: unknown): Promise<T> {
    if (this.ended || this.exit) {
      return Promise.reject(new RpcClosed(method, this.exit?.code ?? null, this.stderrTail()));
    }
    const id = this.next++;
    return new Promise<T>((resolve, reject) => {
      this.waiting.set(id, { method, resolve: resolve as (v: unknown) => void, reject });
      this.send(params === undefined ? { id, method } : { id, method, params });
    });
  }

  notify(method: string, params?: unknown): void {
    this.send(params === undefined ? { method } : { method, params });
  }

  reply(id: RpcId, result: unknown): void {
    this.send({ id, result });
  }

  replyError(id: RpcId, code: number, message: string): void {
    this.send({ id, error: { code, message } });
  }

  stderrTail(): string {
    return stderrTail(this.stderr, this.opts.stderrCap ?? STDERR_CAP);
  }

  /** Closes stdin. `codex app-server` exits on its own when it sees EOF. */
  end(): void {
    try {
      this.proc.stdin.end();
    } catch {
      // already closed; the exit reports itself
    }
  }

  kill(): void {
    try {
      this.proc.kill();
    } catch {
      // already gone
    }
  }

  private send(msg: unknown): void {
    if (this.ended) return;
    try {
      this.proc.stdin.write(JSON.stringify(msg) + "\n");
      const flushed = this.proc.stdin.flush?.();
      if (flushed instanceof Promise) flushed.catch(() => {});
    } catch {
      // the pipe is gone; the read loop ends and `done` says why
    }
  }

  private async read(): Promise<void> {
    const split = new LineSplitter();
    try {
      for await (const chunk of this.proc.stdout) {
        for (const line of split.push(chunk)) this.dispatch(line);
      }
    } catch {
      // a broken pipe ends the stream the same way EOF does
    }
    for (const line of split.flush()) this.dispatch(line);
    // No more answers can come; later sends go nowhere.
    this.ended = true;
  }

  private async drainStderr(): Promise<void> {
    const err = this.proc.stderr;
    if (!err) return;
    const dec = new TextDecoder();
    const keep = (this.opts.stderrCap ?? STDERR_CAP) * 4;
    try {
      for await (const chunk of err) {
        this.stderr += dec.decode(chunk, { stream: true });
        // raw text holds colour codes, so keep a margin over the cap
        if (this.stderr.length > keep) this.stderr = this.stderr.slice(-keep);
      }
    } catch {
      // nothing more to read
    }
  }

  private dispatch(line: string): void {
    const m = parseMessage(line);
    if (!m) return;
    switch (m.kind) {
      case "response":
      case "error": {
        const w = this.waiting.get(m.id);
        if (!w) return;
        this.waiting.delete(m.id);
        if (m.kind === "response") w.resolve(m.result);
        else w.reject(new RpcError(w.method, m.code, m.message, m.data));
        return;
      }
      case "notification":
        try {
          this.notified(m.method, m.params);
        } catch {
          // a handler's bug must not stop the read loop
        }
        return;
      case "request": {
        const handler = this.asked;
        if (!handler) {
          this.replyError(m.id, -32601, `canopy does not handle ${m.method}`);
          return;
        }
        try {
          handler({ id: m.id, method: m.method, params: m.params });
        } catch (err) {
          this.replyError(m.id, -32603, err instanceof Error ? err.message : String(err));
        }
      }
    }
  }
}
