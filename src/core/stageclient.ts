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
  type Fenced,
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

interface Watcher {
  up: boolean;
  onUp: (() => void) | undefined;
  onDown: (() => void) | undefined;
  onAnswer: (() => void) | undefined;
}

/** the fence as the runner's last answer said it */
export interface FenceNow {
  fenced: Fenced;
  reason: string | null;
}

export class StageClient {
  private last: string[] | null = null;
  /** the fence as the last hello said it, or a fence refusal since; null
   *  while the runner has not answered */
  private fence: FenceNow | null = null;
  /** the processes the runner refused for its fence, with its words: by
   *  the refusal's own field, never by what the stage printed */
  private readonly unfenced = new WeakMap<RpcProc, string>();
  /** every watch's listeners, each with the up it last told */
  private readonly watchers = new Set<Watcher>();
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
          if (f.fenced !== undefined) {
            this.unfenced.set(proc, f.reason);
            this.fence = { fenced: f.fenced, reason: f.reason };
          }
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

    const proc: RpcProc = {
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
    return proc;
  }

  /** the runner's words when it refused this process for its fence, else null */
  fenceRefusal(proc: RpcProc): string | null {
    return this.unfenced.get(proc) ?? null;
  }

  /** the fence as the runner last said it, or null while it has not answered */
  fenceNow(): FenceNow | null {
    return this.fence;
  }

  /** a check: the command to its end or the timeout, then code, stdout and
   *  stderr; 126 for a refusal and 127 when the runner is not answering;
   *  `unfenced` holds the runner's words when it refused for its fence */
  async exec(argv: string[], opts: { cwd: string; timeoutMs: number; env?: Record<string, string> }): Promise<ExecResult & { unfenced?: string }> {
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
    const unfenced = this.fenceRefusal(p);
    return { code: code ?? KILLED, stdout, stderr: said, ...(unfenced !== null ? { unfenced } : {}) };
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
    const answer = await this.ask(
      { t: "hello" },
      (f) => (f.t === "hello" && "harnesses" in f ? { harnesses: f.harnesses, fence: { fenced: f.fenced, reason: f.reason ?? null } } : undefined),
      timeoutMs,
    );
    this.last = answer?.harnesses ?? null;
    this.fence = answer?.fence ?? null;
    this.tell(answer !== null);
    return this.last;
  }

  /** Each watch hears every hello, whoever made it: an answer, and a flip
   *  from its last word. On a microtask, so a listener never runs inside
   *  the run or check that asked, and caught, so one that throws cannot
   *  turn an answer into a miss for the caller. */
  private tell(now: boolean): void {
    for (const w of this.watchers) {
      const back = now && !w.up;
      const gone = !now && w.up;
      w.up = now;
      const fire = (f: (() => void) | undefined): void => {
        if (!f) return;
        queueMicrotask(() => {
          if (!this.watchers.has(w)) return;
          try {
            f();
          } catch {
            // a listener's own failure is its own
          }
        });
      };
      if (back) fire(w.onUp);
      if (gone) fire(w.onDown);
      if (now) fire(w.onAnswer);
    }
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

  /** A hello now and every `everyMs`, one at a time. Every hello, the
   *  watch's own or a run's or a check's, tells the listeners: `onUp` on
   *  the first answer and on each answer after a miss, `onDown` on each miss
   *  after an answer, `onAnswer` on every answer. Returns the stop, which
   *  also stops the telling. */
  watch(everyMs = 15_000, onUp?: () => void, onDown?: () => void, onAnswer?: () => void): () => void {
    const w: Watcher = { up: false, onUp, onDown, onAnswer };
    this.watchers.add(w);
    let beating = false;
    const tick = (): void => {
      if (beating || !this.watchers.has(w)) return;
      beating = true;
      this.hello()
        .catch(() => null)
        .finally(() => {
          beating = false;
        });
    };
    tick();
    const t = setInterval(tick, everyMs);
    return () => {
      this.watchers.delete(w);
      clearInterval(t);
    };
  }
}

/** How a hold on a seed came out by the end of its wait: the runner said
 *  nothing runs there, did not answer, or still says something does. */
export type QuietWord = "quiet" | "away" | "busy";

export interface QuietHold {
  /** within `wait`: what the stage runner said by then */
  settled: Promise<QuietWord>;
  /** once the runner says no, or stops answering: until then canopy keeps
   *  the seeds busy and reads none of them */
  released: Promise<void>;
  /** lets go at once, for a server stopping */
  cancel(): void;
}

/** first ask, then every `poll` ms until `wait` is up, then every `repoll` */
const HOLD_POLL = 100;
const HOLD_REPOLL = 1_000;

/** Asks the stage runner whether anything still runs in `seed` until it says
 *  no. A persistent yes stays busy past `wait`, with one line in the log, and
 *  the hold lets go only on the next no: a process a stage left alive in a
 *  seed must not see canopy run git there. Only an answer that does not come
 *  (the runner gone, which takes its processes with it) counts as quiet. */
export function holdQuiet(
  client: Pick<StageClient, "busy">,
  seed: string,
  wait: number,
  label = "canopy",
  poll = HOLD_POLL,
  repoll = HOLD_REPOLL,
): QuietHold {
  let settle!: (w: QuietWord) => void;
  let release!: () => void;
  const settled = new Promise<QuietWord>((r) => (settle = r));
  const released = new Promise<void>((r) => (release = r));
  let over = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let word: QuietWord | null = null;
  const start = Date.now();
  const say = (w: QuietWord): void => {
    if (word !== null) return;
    word = w;
    settle(w);
  };
  const end = (w: QuietWord): void => {
    if (over) return;
    over = true;
    if (timer) clearTimeout(timer);
    say(w);
    release();
  };
  const ask = async (): Promise<void> => {
    if (over) return;
    const held = Date.now() - start;
    if (word === null && held >= wait) {
      console.error(`${label}: ${seed} still has a process in it ${wait} ms after the run's own ended; every seed stays busy until it has none`);
      say("busy");
    }
    let busy: boolean | null;
    try {
      busy = await client.busy(seed, word === null ? Math.max(1, wait - held) : undefined);
    } catch {
      busy = null;
    }
    if (over) return;
    if (busy === false) return end("quiet");
    if (busy === null) {
      console.error(`${label}: the stage runner did not say whether ${seed} is quiet; taking it as quiet`);
      return end("away");
    }
    const next = word === null ? Math.min(poll, Math.max(0, wait - (Date.now() - start))) : repoll;
    timer = setTimeout(() => void ask(), next);
    if (word !== null) timer.unref?.();
  };
  void ask();
  return { settled, released, cancel: () => end(word ?? "quiet") };
}
