/**
 * The stage runner: the one way canopy starts a process in the stages
 * container. It listens on a unix socket shared with canopy's container, and
 * a connection carries one request: a hello (which harnesses it can start), a
 * busy question (does any process have its cwd in a seed), or a spawn. It
 * starts only claude, codex or sh, resolved on its own PATH to a program
 * outside the stage root, only in a seed (a direct, non-dot child of the
 * stage root, by realpath, and spawned in that realpath), with an env built
 * from its own base and three CANOPY_* names, never what canopy sends.
 * Every refusal is answered before anything starts.
 *
 * A run's end, a kill frame, or the connection closing ends the process and
 * every descendant: the tree is frozen and killed, then the child's process
 * group, then every process whose cwd is inside the seed (what a setsid or a
 * double fork leaves behind), sparing the trees of other live connections.
 * Before it starts codex it drops every seed's trust from its own codex
 * config.
 */
import { readdir, realpath, rm, stat } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { basename, dirname, join } from "node:path";
import { sweepCodexTrust } from "../core/codextrust";
import { exec } from "../core/exec";
import { parseLsofCwd } from "../core/ports";
import { allProcs, descendants, procCwd, type Proc } from "../core/procs";
import {
  childEnv,
  chunkB64,
  encodeFrame,
  fromB64,
  lineSplitter,
  parseFrame,
  requestRefusal,
  STAGE_PROGRAMS,
  type StageFrame,
  type StageRequest,
} from "../core/stagewire";

export interface RunnerOptions {
  socket: string;
  root: string;
  env?: Record<string, string | undefined>;
  /** a bare program name to the command it runs; each name runs itself
   *  unless named here */
  programs?: Record<string, string>;
  /** the process table every walk reads; `allProcs` unless a test hands
   *  in its own */
  procs?: () => Promise<Proc[]>;
}

const HARNESSES: readonly string[] = ["claude", "codex"];
/** a connection that sends no request in this long is closed */
const FIRST_FRAME_MS = 10_000;
/** the longest line a client may send before it is cut off */
const LINE_MAX = 8 * 1024 * 1024;
/** how long the exit frame waits for the child's output to drain once the
 *  run's processes are dead (an escapee outside the seed may hold the pipe) */
const DRAIN_MS = 2_000;
/** passes over the tree or the seed, each catching what forked during the last */
const ROUNDS = 5;

/** one line in the runner's log for something that failed where nothing
 *  else would hear of it */
const warn = (what: string, e: unknown): void => {
  console.error(`canopy-stage-runner: ${what}: ${e instanceof Error ? e.message : String(e)}`);
};

const inside = (path: string, dir: string): boolean => path === dir || path.startsWith(`${dir}/`);

const signal = (pid: number, sig: NodeJS.Signals): void => {
  try {
    process.kill(pid, sig);
  } catch {
    // already gone
  }
};

/** The seed a path names, as its realpath and the root's, or why it is not
 *  one: a direct child of the stage root whose name has no leading dot, and
 *  a folder. */
async function seedOf(root: string, path: string): Promise<{ seed: string; root: string } | { refused: string }> {
  if (!path.startsWith("/")) return { refused: "the folder must be an absolute path" };
  const realRoot = await realpath(root).catch(() => null);
  if (realRoot === null) return { refused: "the stage root does not exist" };
  const seed = await realpath(path).catch(() => null);
  if (seed === null) return { refused: "the folder does not exist" };
  if (dirname(seed) !== realRoot || basename(seed).startsWith(".")) {
    return { refused: "the folder is not a seed: a direct child of the stage root whose name has no leading dot" };
  }
  if (!(await stat(seed).catch(() => null))?.isDirectory()) return { refused: "the seed is not a folder" };
  return { seed, root: realRoot };
}

/** A program on the runner's own PATH (absolute entries only, so nothing
 *  resolves against a cwd), and never one inside the stage root. */
async function resolveProgram(cmd: string, path: string | undefined, root: string): Promise<string | null> {
  const PATH = (path ?? "")
    .split(":")
    .filter((p) => p.startsWith("/"))
    .join(":");
  const found = Bun.which(cmd, { PATH });
  if (!found?.startsWith("/")) return null;
  const real = await realpath(found).catch(() => null);
  if (real === null) return null;
  const realRoot = await realpath(root).catch(() => root);
  if ([root, realRoot].some((r) => inside(found, r) || inside(real, r))) return null;
  return found;
}

/** every process's cwd, read before the process table so a process seen
 *  here is also in the table read after it */
async function cwdsNow(env: Record<string, string | undefined>): Promise<Map<number, string>> {
  if (process.platform === "linux") {
    const pids = (await readdir("/proc").catch(() => [] as string[])).filter((d) => /^\d+$/.test(d));
    const out = new Map<number, string>();
    await Promise.all(
      pids.map(async (pid) => {
        const cwd = await procCwd(pid);
        if (cwd !== undefined) out.set(Number(pid), cwd);
      }),
    );
    return out;
  }
  const r = await exec(["lsof", "-a", "-d", "cwd", "-Fpn"], { timeoutMs: 5_000, base: env });
  return parseLsofCwd(r.stdout);
}

/** Every process under `pid`, frozen top down a pass at a time (so a parent
 *  forks no more while its children are found), then killed. */
export async function killTree(pid: number, procs: () => Promise<Proc[]> = allProcs): Promise<void> {
  const hit = new Set<number>();
  for (let round = 0; round < ROUNDS; round++) {
    const fresh = descendants(await procs(), pid, Infinity)
      .map((p) => p.pid)
      .filter((p) => !hit.has(p) && p !== process.pid);
    if (fresh.length === 0) break;
    for (const p of fresh) {
      hit.add(p);
      signal(p, "SIGSTOP");
    }
  }
  for (const p of hit) signal(p, "SIGKILL");
  signal(pid, "SIGKILL");
}

/** one connection's process, while it runs */
interface Live {
  pid: number;
  seed: string;
  running: boolean;
}

export async function startStageRunner(opts: RunnerOptions): Promise<{ stop(): Promise<void> }> {
  const own = opts.env ?? process.env;
  const procs = opts.procs ?? allProcs;
  const identity = Object.fromEntries(STAGE_PROGRAMS.map((p) => [p, p]));
  const programs: Record<string, string> = { ...identity, ...opts.programs };
  await rm(opts.socket, { force: true });
  const live = new Set<Socket>();
  const runs = new Set<Live>();
  const finishing = new Set<Promise<void>>();

  /** the pids of every other live run's tree, which a sweep spares */
  const spared = (procs: Proc[], self: Live): Set<number> => {
    const out = new Set<number>([process.pid]);
    for (const r of runs) {
      if (r === self || !r.running) continue;
      for (const p of descendants(procs, r.pid, Infinity)) out.add(p.pid);
    }
    return out;
  };

  /** the processes whose cwd is in the seed, past the ones spared */
  const inSeed = async (seed: string, self: Live): Promise<number[]> => {
    const where = await cwdsNow(own);
    const keep = spared(await procs(), self);
    return [...where].filter(([pid, cwd]) => !keep.has(pid) && inside(cwd, seed)).map(([pid]) => pid);
  };

  /** kill whatever has its cwd in the seed, a pass at a time until a pass finds nothing */
  const sweepSeed = async (seed: string, self: Live): Promise<void> => {
    for (let round = 0; round < ROUNDS; round++) {
      const hit = await inSeed(seed, self);
      if (hit.length === 0) return;
      for (const p of hit) signal(p, "SIGSTOP");
      for (const p of hit) signal(p, "SIGKILL");
    }
  };

  /** The run's tree while its process lives (once it is reaped its children
   *  belong to init and the walk finds nothing), its process group, and
   *  everything left in its seed. */
  const endRun = async (run: Live): Promise<void> => {
    if (run.running) await killTree(run.pid, procs);
    signal(-run.pid, "SIGKILL");
    await sweepSeed(run.seed, run);
  };

  const server = createServer((sock) => {
    live.add(sock);
    const split = lineSplitter();
    const decoder = new TextDecoder();
    let sinceNewline = 0;
    let state: "new" | "starting" | "running" | "over" = "new";
    let proc: Bun.Subprocess<"pipe", "pipe", "pipe"> | null = null;
    let run: Live | null = null;
    /** a kill frame came: later stdin is dropped */
    let killed = false;

    const send = (f: StageFrame): void => {
      if (state !== "over" && !sock.destroyed) sock.write(encodeFrame(f));
    };
    /** the last frame this connection gets */
    const finish = (f: StageFrame): void => {
      send(f);
      state = "over";
      sock.end();
    };
    const firstFrame = setTimeout(() => sock.destroy(), FIRST_FRAME_MS);

    const hello = async (): Promise<void> => {
      const harnesses: string[] = [];
      for (const h of HARNESSES) {
        if (await resolveProgram(programs[h] ?? h, own["PATH"], opts.root)) harnesses.push(h);
      }
      finish({ t: "hello", harnesses });
    };

    const busy = async (path: string): Promise<void> => {
      const where = await seedOf(opts.root, path);
      if ("refused" in where) return finish({ t: "refused", reason: where.refused });
      const found = [...(await cwdsNow(own))];
      finish({ t: "busy", busy: found.some(([pid, cwd]) => pid !== process.pid && inside(cwd, where.seed)) });
    };

    const spawn = async (req: Extract<StageRequest, { t: "spawn" }>): Promise<void> => {
      const refused = requestRefusal(req);
      if (refused) return finish({ t: "refused", reason: refused });
      const where = await seedOf(opts.root, req.cwd);
      if ("refused" in where) return finish({ t: "refused", reason: where.refused });
      const name = req.argv[0] ?? "";
      const program = await resolveProgram(programs[name] ?? name, own["PATH"], opts.root);
      if (program === null) return finish({ t: "refused", reason: `${name} is not installed where the stage runner can start it` });
      if (name === "codex") {
        const home = own["CODEX_HOME"] ?? (own["HOME"] ? join(own["HOME"], ".codex") : null);
        try {
          if (home) for (const seeds of new Set([opts.root, where.root])) await sweepCodexTrust(home, seeds);
        } catch {
          return finish({ t: "refused", reason: "codex's trust of the seeds could not be cleared" });
        }
      }
      // the connection may have closed while the checks ran: then nothing starts
      if (sock.destroyed || state === "over") return;
      let p: Bun.Subprocess<"pipe", "pipe", "pipe">;
      try {
        p = Bun.spawn([program, ...req.argv.slice(1)], {
          cwd: where.seed,
          env: childEnv(own, req.env),
          stdin: "pipe",
          stdout: "pipe",
          stderr: "pipe",
          // its own process group, so a child that double forks is still
          // reached by one kill of the group
          detached: true,
        });
      } catch {
        return finish({ t: "refused", reason: `${name} could not be started` });
      }
      proc = p;
      const self: Live = { pid: p.pid, seed: where.seed, running: true };
      run = self;
      runs.add(self);
      state = "running";

      const cancels: (() => void)[] = [];
      const pump = async (stream: ReadableStream<Uint8Array>, t: "out" | "err"): Promise<void> => {
        const r = stream.getReader();
        cancels.push(() => void r.cancel().catch(() => {}));
        try {
          for (;;) {
            const { done: end, value } = await r.read();
            if (end) return;
            for (const d of chunkB64(value)) send({ t, d });
          }
        } catch {
          // cancelled, or the pipe broke
        }
      };
      const pumps = Promise.all([pump(p.stdout, "out"), pump(p.stderr, "err")]);
      const done = (async () => {
        await p.exited;
        self.running = false;
        try {
          // the group at once, before its pid could be handed to anything else
          await endRun(self);
        } catch (e) {
          // the exit frame still goes: the client waits on it, and a run
          // that never ends holds the seed busy in canopy
          warn(`ending the run in ${self.seed} failed`, e);
        }
        const drained = await Promise.race([pumps.then(() => true), Bun.sleep(DRAIN_MS).then(() => false)]);
        if (!drained) for (const cancel of cancels) cancel();
        runs.delete(self);
        finish({ t: "exit", code: p.exitCode });
      })();
      finishing.add(done);
      void done.catch((e: unknown) => warn("a run's end failed", e)).finally(() => finishing.delete(done));
    };

    const handle = async (f: StageFrame | StageRequest): Promise<void> => {
      if (state === "over") return;
      if (state === "new") {
        state = "starting";
        clearTimeout(firstFrame);
        if (f.t === "hello" && !("harnesses" in f)) return hello();
        if (f.t === "busy" && "seed" in f) {
          const refused = requestRefusal(f);
          return refused ? finish({ t: "refused", reason: refused }) : busy(f.seed);
        }
        if (f.t === "spawn") return spawn(f);
        return finish({ t: "refused", reason: "the first frame must be a request" });
      }
      if (state !== "running" || !proc || !run) return;
      // nothing reaches a process once it is being killed: a stop's deny
      // comes after its kill, and must not let the agent finish its turn
      if (killed) return;
      const p = proc;
      if (f.t === "in") {
        let bytes: Uint8Array;
        try {
          bytes = fromB64(f.d);
        } catch {
          // a frame that does not decode ends the run: the close kills it
          finish({ t: "refused", reason: "stdin that is not base64" });
          sock.destroy();
          return;
        }
        try {
          p.stdin.write(bytes);
          // not awaited: a child that stops reading would hold every frame
          // behind this one, a kill's included
          const flushed = p.stdin.flush();
          if (flushed instanceof Promise) flushed.catch(() => {});
        } catch {
          // the child closed its stdin
        }
      } else if (f.t === "eof") {
        try {
          await p.stdin.end();
        } catch {
          // already closed
        }
      } else if (f.t === "kill") {
        kill(run);
      }
    };

    /** A kill ends the run now, never behind the frames queued ahead of it:
     *  it goes around the chain once the process runs, and through it while
     *  the spawn is still being checked. */
    const kill = (r: Live): void => {
      if (killed) return;
      killed = true;
      const killing = endRun(r);
      finishing.add(killing);
      void killing.catch((e: unknown) => warn(`killing the run in ${r.seed} failed`, e)).finally(() => finishing.delete(killing));
    };

    let chain = Promise.resolve();
    sock.on("data", (b: Buffer) => {
      const s = decoder.decode(b, { stream: true });
      const nl = s.lastIndexOf("\n");
      sinceNewline = nl < 0 ? sinceNewline + s.length : s.length - nl - 1;
      if (sinceNewline > LINE_MAX) {
        sock.destroy();
        return;
      }
      for (const line of split(s)) {
        const f = parseFrame(line);
        if (!f) continue;
        if (f.t === "kill" && state === "running" && run) kill(run);
        else chain = chain.then(() => handle(f)).catch((e: unknown) => warn("a frame failed", e));
      }
    });
    sock.on("close", () => {
      clearTimeout(firstFrame);
      live.delete(sock);
      const r = run;
      if (r?.running) {
        const killing = killTree(r.pid, procs)
          .catch((e: unknown) => warn(`killing the tree of ${r.pid} failed`, e))
          .then(() => signal(-r.pid, "SIGKILL"));
        finishing.add(killing);
        void killing.catch((e: unknown) => warn("a closed connection's kill failed", e)).finally(() => finishing.delete(killing));
      }
      state = "over";
    });
    sock.on("error", () => {});
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.socket, () => {
      server.off("error", reject);
      resolve();
    });
  });
  return {
    stop: async () => {
      for (const s of live) s.destroy();
      const closed = new Promise<void>((r) => server.close(() => r()));
      while (finishing.size > 0) await Promise.allSettled(finishing);
      await closed;
      await rm(opts.socket, { force: true });
    },
  };
}
