/**
 * canopy's side of the stage runner: a process in the stages container as
 * the RpcProc the drivers already speak (stdin writer, stdout and stderr
 * streams, an exit promise, kill), plus exec for a check, hello for what the
 * runner can start, and busy for whether anything still runs in a seed.
 * One connection per request, as the wire says. Bun.
 *
 * The runner reads a closed connection as a kill, so a process's stdin is
 * ended with an eof frame and the socket is never ended or half-closed
 * before the exit frame (node's allowHalfOpen is off: a half-close would
 * close the runner's side too).
 */
import { connect, type Socket } from "node:net";
import type { RpcProc, RpcSpawn } from "./codexrpc";
import type { ExecResult } from "./exec";
import {
  chunkB64,
  encodeFrame,
  fromB64,
  lineSplitter,
  parseFrame,
  STAGE_AWAY,
  type StageFrame,
  type StageRequest,
} from "./stagewire";

const enc = new TextEncoder();
/** how long a kill waits for the exit frame before it drops the connection,
 *  which the runner reads as a kill too; past the runner's own drain wait */
const KILL_GRACE = 5_000;
const HELLO_TIMEOUT = 2_000;
/** the runner's busy answer reads every process's cwd (lsof on a Mac) */
const BUSY_TIMEOUT = 5_000;

/** the code a run ended by a kill or a lost connection reads as */
const KILLED = 137;
/** a request the runner refused, as a shell answers a command it cannot run */
const REFUSED = 126;
/** the runner did not answer at all, as a shell answers a missing command */
const AWAY = 127;

type Frame = StageFrame | StageRequest;

/** each line of a connection's frames, decoded across chunk edges */
const frameReader = (): ((b: Buffer) => Frame[]) => {
  const decoder = new TextDecoder();
  const split = lineSplitter();
  return (b) => {
    const out: Frame[] = [];
    for (const line of split(decoder.decode(b, { stream: true }))) {
      const f = parseFrame(line);
      if (f) out.push(f);
    }
    return out;
  };
};

/** a byte stream the socket's frames feed, quiet once closed or cancelled */
function feed(): { stream: ReadableStream<Uint8Array>; push(b: Uint8Array): void; close(): void } {
  let ctl: ReadableStreamDefaultController<Uint8Array> | null = null;
  let open = true;
  const stream = new ReadableStream<Uint8Array>({
    start: (c) => {
      ctl = c;
    },
    cancel: () => {
      open = false;
    },
  });
  return {
    stream,
    push: (b) => {
      if (!open) return;
      try {
        ctl?.enqueue(b);
      } catch {
        // the reader went away
        open = false;
      }
    },
    close: () => {
      if (!open) return;
      open = false;
      try {
        ctl?.close();
      } catch {
        // already closed
      }
    },
  };
}

const clean = (env: Record<string, string | undefined>): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined) out[k] = v;
  return out;
};

export class StageClient {
  private last: string[] | null = null;
  constructor(private readonly socket: string) {}

  /** a process in the stages container whose stdio rides the socket */
  readonly spawn: RpcSpawn = (argv, { cwd, env }) => this.open({ t: "spawn", argv: [...argv], cwd, env: clean(env) });

  private open(req: StageRequest): RpcProc {
    const sock: Socket = connect(this.socket);
    const out = feed();
    const err = feed();
    let settle: (code: number | null) => void = () => {};
    const exited = new Promise<number | null>((r) => {
      settle = r;
    });
    let done = false;
    let grace: ReturnType<typeof setTimeout> | null = null;
    const finish = (code: number | null): void => {
      if (done) return;
      done = true;
      if (grace) clearTimeout(grace);
      out.close();
      err.close();
      // the run is over: closing now kills nothing
      sock.end();
      settle(code);
    };
    const write = (f: Frame): void => {
      if (!done && sock.writable) sock.write(encodeFrame(f));
    };
    // written before the connect completes: node queues writes in call
    // order, so no stdin frame can reach the runner ahead of the request
    write(req);

    const read = frameReader();
    sock.on("data", (b: Buffer) => {
      for (const f of read(b)) {
        if (done) return;
        if (f.t === "out") out.push(fromB64(f.d));
        else if (f.t === "err") err.push(fromB64(f.d));
        else if (f.t === "exit") finish(f.code);
        else if (f.t === "refused") {
          err.push(enc.encode(`${f.reason}\n`));
          finish(REFUSED);
        }
      }
    });
    sock.on("error", (e) => {
      if (done) return;
      err.push(enc.encode(`${STAGE_AWAY}: ${e.message}\n`));
      finish(AWAY);
    });
    // a connection gone without an exit frame: the runner killed the run
    sock.on("close", () => finish(null));

    return {
      stdin: {
        write: (chunk: string) => {
          for (const d of chunkB64(enc.encode(chunk))) write({ t: "in", d });
        },
        flush: () => undefined,
        end: () => write({ t: "eof" }),
      },
      stdout: out.stream,
      stderr: err.stream,
      exited,
      kill: () => {
        if (done || grace) return;
        write({ t: "kill" });
        // a runner that never answers the kill: drop the connection, which
        // it reads as a kill as well, and settle here
        grace = setTimeout(() => sock.destroy(), KILL_GRACE);
      },
    };
  }

  /** a check: the command to its end or the timeout, then code, stdout and
   *  stderr; 126 for a refusal and 127 when the runner is not answering */
  async exec(argv: string[], opts: { cwd: string; timeoutMs: number; env?: Record<string, string> }): Promise<ExecResult> {
    const p = this.open({ t: "spawn", argv, cwd: opts.cwd, env: opts.env ?? {} });
    p.stdin.end();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      p.kill();
    }, opts.timeoutMs);
    const [stdout, stderr, code] = await Promise.all([
      new Response(p.stdout).text(),
      new Response(p.stderr ?? null).text(),
      p.exited,
    ]);
    clearTimeout(timer);
    const said = timedOut ? `${stderr}timed out after ${opts.timeoutMs} ms\n` : stderr;
    return { code: code ?? KILLED, stdout, stderr: said };
  }

  /** One request whose answer is one frame: what `pick` reads off it, or
   *  null on a refusal, an error, a close or the timeout. */
  private ask<T>(req: StageRequest, pick: (f: Frame) => T | undefined, timeoutMs: number): Promise<T | null> {
    return new Promise<T | null>((resolve) => {
      const sock = connect(this.socket);
      let settled = false;
      const settle = (v: T | null): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        sock.destroy();
        resolve(v);
      };
      const timer = setTimeout(() => settle(null), timeoutMs);
      sock.write(encodeFrame(req));
      const read = frameReader();
      sock.on("data", (b: Buffer) => {
        for (const f of read(b)) {
          if (f.t === "refused") return settle(null);
          const v = pick(f);
          if (v !== undefined) return settle(v);
        }
      });
      sock.on("error", () => settle(null));
      sock.on("close", () => settle(null));
    });
  }

  /** the harnesses the runner can start, or null when it is not answering */
  async hello(timeoutMs = HELLO_TIMEOUT): Promise<string[] | null> {
    const answer = await this.ask({ t: "hello" }, (f) => (f.t === "hello" && "harnesses" in f ? f.harnesses : undefined), timeoutMs);
    this.last = answer;
    return answer;
  }

  /** whether any process in the stages container has its cwd in the seed;
   *  null when the runner refused the path or did not answer */
  busy(seed: string, timeoutMs = BUSY_TIMEOUT): Promise<boolean | null> {
    return this.ask({ t: "busy", seed }, (f) => (f.t === "busy" && "busy" in f ? f.busy : undefined), timeoutMs);
  }

  /** the last hello's answer, which watch keeps fresh */
  harnessesNow(): string[] | null {
    return this.last;
  }

  /** A hello now and every `everyMs`, one at a time; `onUp` on the first
   *  answer and on each answer after a miss, `onDown` on each miss after an
   *  answer. Returns the stop. */
  watch(everyMs = 15_000, onUp?: () => void, onDown?: () => void): () => void {
    let up = false;
    let stopped = false;
    let beating = false;
    const beat = async (): Promise<void> => {
      if (beating || stopped) return;
      beating = true;
      try {
        const now = (await this.hello()) !== null;
        if (stopped) return;
        const back = now && !up;
        const gone = !now && up;
        up = now;
        if (back) onUp?.();
        if (gone) onDown?.();
      } finally {
        beating = false;
      }
    };
    const tick = (): void => {
      beat().catch(() => {
        // onUp or onDown threw; the next tick still runs
      });
    };
    tick();
    const t = setInterval(tick, everyMs);
    return () => {
      stopped = true;
      clearInterval(t);
    };
  }
}
