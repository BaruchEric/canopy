import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn as nodeSpawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeFrame, fromB64, lineSplitter, parseFrame, type StageFrame, type StageRequest } from "../core/stagewire";
import { allProcs, type Proc } from "../core/procs";
import { killTree, orphansOf, ownPidNamespace, startStageRunner, type RunnerOptions } from "./runner";

let dir = "";
let root = "";
let sock = "";
const stops: (() => Promise<void>)[] = [];

/** the fence probe's target in these tests, never fetched: each runner gets a probe of its own */
const PROBE = "http://probe.test/";
const FENCE = { CANOPY_FENCE_PROBE: PROBE };
/** a probe that times out, as one does behind the fence: every runner here but the fence's own tests */
const blocked: NonNullable<RunnerOptions["probe"]> = async () => ({ result: "blocked" });
/** stand-ins live in a temp dir the tests own: only the writability tests ask */
const notWritable: NonNullable<RunnerOptions["writable"]> = async () => false;

beforeAll(async () => {
  // the realpath, since a Mac's tmpdir sits behind /var -> /private/var and
  // the runner spawns in the realpath it checked
  dir = await realpath(await mkdtemp(join(tmpdir(), "cs-")));
  root = join(dir, "_incubator");
  await mkdir(join(root, "coin", "sub"), { recursive: true });
  await mkdir(join(root, "other"), { recursive: true });
  await mkdir(join(root, ".shared"), { recursive: true });
  await writeFile(join(root, "afile"), "x");
  await symlink("/", join(root, "escape"));
  await writeFile(join(dir, "escape.ts"), ESCAPE);
  sock = join(dir, "s.sock");
  const r = await startStageRunner({ socket: sock, root, env: { PATH: process.env["PATH"], HOME: dir, GH_TOKEN: "own-secret", ...FENCE }, probe: blocked });
  stops.push(r.stop);
});
afterAll(async () => {
  for (const s of stops) await s();
  await rm(dir, { recursive: true, force: true });
});

/** a runner of its own on another socket, stopped in afterAll */
async function extra(name: string, opts: Omit<RunnerOptions, "socket" | "root">): Promise<string> {
  const path = join(dir, `${name}.sock`);
  const r = await startStageRunner({ socket: path, root, probe: blocked, writable: notWritable, ...opts, env: { PATH: process.env["PATH"], HOME: dir, ...FENCE, ...opts.env } });
  stops.push(r.stop);
  return path;
}

/** an executable stand-in that exits 0 */
async function standIn(path: string): Promise<string> {
  await writeFile(path, "#!/bin/sh\nexit 0\n");
  await chmod(path, 0o755);
  return path;
}

/** a grandchild in a session of its own (setsid, through node's detached),
 *  so neither the tree walk nor the process group reaches it; it keeps the
 *  run's stdout open, so the exit frame must not wait on the pipe */
const ESCAPE = `import { spawn } from "node:child_process";
const c = spawn("sleep", ["300"], { detached: true, stdio: "inherit" });
await Bun.write(process.argv[2] ?? "", String(c.pid));
c.unref();
`;

const ENDS = new Set(["exit", "refused", "hello", "busy"]);

/** one connection: send the request and frames, collect every frame back until an end */
async function talk(req: StageRequest | StageFrame, frames: StageFrame[] = [], waitMs = 8000, path = sock): Promise<StageFrame[]> {
  const got: StageFrame[] = [];
  const split = lineSplitter();
  return new Promise((resolve, reject) => {
    const c = connect(path, () => {
      c.write(encodeFrame(req));
      for (const f of frames) c.write(encodeFrame(f));
    });
    const t = setTimeout(() => (c.destroy(), reject(new Error(`no end: ${JSON.stringify(got)}`))), waitMs);
    c.on("data", (b) => {
      for (const line of split(b.toString())) {
        const f = parseFrame(line) as StageFrame | null;
        if (!f) continue;
        got.push(f);
        if (ENDS.has(f.t)) {
          clearTimeout(t);
          c.end();
          resolve(got);
        }
      }
    });
    c.on("error", reject);
  });
}
const text = (fs: StageFrame[], t: "out" | "err") =>
  Buffer.concat(fs.filter((f) => f.t === t).map((f) => Buffer.from(fromB64((f as { d: string }).d)))).toString();

/** a connection left open: its frames collect into `got`, `ended` settles on an end frame */
function open(req: StageRequest): { c: Socket; got: StageFrame[]; ended: Promise<StageFrame[]> } {
  const got: StageFrame[] = [];
  const split = lineSplitter();
  const c = connect(sock, () => c.write(encodeFrame(req)));
  const ended = new Promise<StageFrame[]>((resolve) => {
    c.on("data", (b) => {
      for (const line of split(b.toString())) {
        const f = parseFrame(line) as StageFrame | null;
        if (!f) continue;
        got.push(f);
        if (ENDS.has(f.t)) resolve(got);
      }
    });
  });
  c.on("error", () => {});
  return { c, got, ended };
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
async function gone(pid: number, ms = 3000): Promise<boolean> {
  for (let i = 0; i < ms / 20; i++) {
    if (!alive(pid)) return true;
    await Bun.sleep(20);
  }
  return !alive(pid);
}
async function pidIn(file: string): Promise<number> {
  for (let i = 0; i < 250 && !(await Bun.file(file).exists()); i++) await Bun.sleep(20);
  for (let i = 0; i < 50; i++) {
    const n = Number((await readFile(file, "utf8")).trim());
    if (n > 0) return n;
    await Bun.sleep(20);
  }
  throw new Error(`no pid in ${file}`);
}

describe("the stage runner", () => {
  test("hello lists the harnesses it can start, by what resolves on its PATH", async () => {
    const path = await extra("hello", {
      env: { PATH: process.env["PATH"], HOME: dir },
      programs: { claude: await standIn(join(dir, "fake-claude")), codex: "/nonexistent/codex" },
    });
    const [f] = await talk({ t: "hello" }, [], 5000, path);
    expect(f).toEqual({ t: "hello", harnesses: ["claude"], fenced: true });
  });

  test("a program that resolves inside the stage root is neither listed nor started", async () => {
    const inside = await standIn(join(root, "coin", "claude"));
    const path = await extra("inroot", { env: { PATH: process.env["PATH"], HOME: dir }, programs: { claude: inside, codex: "/nonexistent/codex" } });
    expect((await talk({ t: "hello" }, [], 5000, path))[0]).toEqual({ t: "hello", harnesses: [], fenced: true });
    const fs = await talk({ t: "spawn", argv: ["claude"], cwd: join(root, "coin"), env: {} }, [], 5000, path);
    expect(fs.at(-1)?.t).toBe("refused");
    await rm(inside);
  });

  test("a program the runner's own uid could rewrite, the file or any folder above it, is neither listed nor started", async () => {
    // the real check, not the stand-ins' pass
    const own = await standIn(join(dir, "own-claude"));
    const lockedDir = join(dir, "locked");
    await mkdir(lockedDir, { recursive: true });
    const locked = await standIn(join(lockedDir, "codex"));
    // the file is read-only, but its folder is ours: a stage could swap it
    await chmod(locked, 0o555);
    const path = await extra("writable", {
      writable: undefined,
      programs: { claude: own, codex: locked },
    });
    expect((await talk({ t: "hello" }, [], 5000, path))[0]).toMatchObject({ harnesses: [] });
    for (const [name, file] of [
      ["claude", own],
      ["codex", lockedDir],
    ] as const) {
      const fs = await talk({ t: "spawn", argv: [name], cwd: join(root, "coin"), env: {} }, [], 5000, path);
      expect(fs.at(-1)).toEqual({ t: "refused", reason: `${name} is not started: ${file} is writable by the stage runner's own user, so a stage could change it` });
    }
    // sh resolves to the system's, which no user here can write
    const fs = await talk({ t: "spawn", argv: ["sh", "-c", "exit 0"], cwd: join(root, "coin"), env: {} }, [], 5000, path);
    expect(fs.at(-1)).toEqual({ t: "exit", code: 0 });
  });

  test("sh runs in a seed, stdin in, stdout out, the exit code back", async () => {
    const fs = await talk({ t: "spawn", argv: ["sh", "-c", "cat; echo $PWD; exit 3"], cwd: join(root, "coin"), env: {} }, [
      { t: "in", d: btoa("hello\n") },
      { t: "eof" },
    ]);
    expect(text(fs, "out")).toBe(`hello\n${join(root, "coin")}\n`);
    expect(fs.at(-1)).toEqual({ t: "exit", code: 3 });
  });

  test("the child's env holds no token, its own or one canopy sent", async () => {
    const fs = await talk({ t: "spawn", argv: ["sh", "-c", "env"], cwd: join(root, "coin"), env: { GH_TOKEN: "sent", CANOPY_RUN: "r1" } });
    const env = text(fs, "out");
    expect(env).not.toContain("GH_TOKEN");
    expect(env).not.toContain("own-secret");
    expect(env).toContain("CANOPY_RUN=r1");
  });

  test.each([
    ["a symlink out of the root", () => join(root, "escape")],
    ["a dot folder", () => join(root, ".shared")],
    ["a nested folder", () => join(root, "coin", "sub")],
    ["the root itself", () => root],
    ["a missing folder", () => join(root, "nope")],
    ["a file, not a folder", () => join(root, "afile")],
    ["a relative path", () => "coin"],
  ])("%s is refused before anything starts", async (_name, cwd) => {
    const fs = await talk({ t: "spawn", argv: ["sh", "-c", `touch ${join(dir, "ran")}`], cwd: cwd(), env: {} });
    expect(fs.at(-1)?.t).toBe("refused");
    expect(await Bun.file(join(dir, "ran")).exists()).toBe(false);
  });

  test.each([["/bin/sh"], ["bun"], ["./sh"]])("the program %s is refused", async (prog) => {
    const fs = await talk({ t: "spawn", argv: [prog, "-c", `touch ${join(dir, "ran2")}`], cwd: join(root, "coin"), env: {} });
    expect(fs.at(-1)?.t).toBe("refused");
    expect(await Bun.file(join(dir, "ran2")).exists()).toBe(false);
  });

  test("a first frame that is not a request is refused", async () => {
    const fs = await talk({ t: "in", d: btoa("x") });
    expect(fs.at(-1)?.t).toBe("refused");
  });

  test("bad base64 on stdin is refused and the child is killed", async () => {
    const pidFile = join(dir, "bad64.pid");
    const r = open({ t: "spawn", argv: ["sh", "-c", `echo $$ > ${pidFile}; exec sleep 300`], cwd: join(root, "coin"), env: {} });
    const pid = await pidIn(pidFile);
    r.c.write(encodeFrame({ t: "in", d: "!!not base64!!" }));
    const fs = await r.ended;
    expect(fs.at(-1)?.t).toBe("refused");
    expect(await gone(pid)).toBe(true);
    r.c.destroy();
  });

  test("closing the connection kills the child and its grandchildren", async () => {
    const pidFile = join(dir, "grandchild.pid");
    const c = connect(sock);
    c.on("error", () => {});
    await new Promise<void>((r) => c.on("connect", () => r()));
    // the grandchild is a backgrounded sleep that would outlive a plain kill of sh
    c.write(encodeFrame({ t: "spawn", argv: ["sh", "-c", `sleep 300 & echo $! > ${pidFile}; wait`], cwd: join(root, "coin"), env: {} }));
    const pid = await pidIn(pidFile);
    expect(alive(pid)).toBe(true);
    c.destroy();
    expect(await gone(pid)).toBe(true);
  });

  test("closing the connection kills a grandchild only the tree walk reaches", async () => {
    // set -m puts the job in a process group of its own, and its cwd is out
    // of the seed, so neither the group kill nor the seed sweep reaches it
    const pidFile = join(dir, "treeonly.pid");
    const c = connect(sock);
    c.on("error", () => {});
    await new Promise<void>((r) => c.on("connect", () => r()));
    c.write(encodeFrame({ t: "spawn", argv: ["sh", "-c", `set -m; (cd / && exec sleep 300) & echo $! > ${pidFile}; wait`], cwd: join(root, "coin"), env: {} }));
    const pid = await pidIn(pidFile);
    expect(alive(pid)).toBe(true);
    c.destroy();
    expect(await gone(pid)).toBe(true);
  });

  test("a kill frame ends the process and the exit frame still comes", async () => {
    const fs = await talk({ t: "spawn", argv: ["sh", "-c", "sleep 300"], cwd: join(root, "coin"), env: {} }, [{ t: "kill" }]);
    expect(fs.at(-1)?.t).toBe("exit");
  });

  test("a kill frame lands within a second while the child never reads its stdin", async () => {
    const pidFile = join(dir, "noread.pid");
    const r = open({ t: "spawn", argv: ["sh", "-c", `echo $$ > ${pidFile}; exec sleep 300`], cwd: join(root, "coin"), env: {} });
    const pid = await pidIn(pidFile);
    // far past a pipe's buffer, so a write that waits for the child to read never returns
    const chunk = btoa("x".repeat(48 * 1024));
    for (let i = 0; i < 100; i++) r.c.write(encodeFrame({ t: "in", d: chunk }));
    await Bun.sleep(200);
    const sent = Date.now();
    r.c.write(encodeFrame({ t: "kill" }));
    const end = await Promise.race([r.ended.then((fs) => fs.at(-1)), Bun.sleep(3000).then(() => null)]);
    const took = Date.now() - sent;
    r.c.destroy();
    expect(end?.t).toBe("exit");
    expect(took).toBeLessThan(1000);
    expect(await gone(pid)).toBe(true);
  });

  test("a run whose end fails to sweep still sends its exit frame", async () => {
    const path = await extra("sweepfails", {
      env: { PATH: process.env["PATH"], HOME: dir },
      procs: () => Promise.reject(new Error("the process table could not be read")),
    });
    const fs = await talk({ t: "spawn", argv: ["sh", "-c", "exit 0"], cwd: join(root, "coin"), env: {} }, [], 4000, path);
    expect(fs.at(-1)).toEqual({ t: "exit", code: 0 });
  });

  test("an escapee in its own session outlives the tree kill alone", async () => {
    const pidFile = join(dir, "control.pid");
    const sh = nodeSpawn("sh", ["-c", `'${process.execPath}' ${join(dir, "escape.ts")} ${pidFile}; sleep 300`], {
      cwd: join(root, "other"),
      detached: true,
      stdio: "ignore",
    });
    const pid = await pidIn(pidFile);
    await killTree(sh.pid ?? 0);
    try {
      process.kill(-(sh.pid ?? 0), "SIGKILL");
    } catch {
      // the group is already gone
    }
    expect(await gone(sh.pid ?? 0)).toBe(true);
    // what makes the next two tests mean something: only the cwd sweep reaches it
    expect(alive(pid)).toBe(true);
    process.kill(pid, "SIGKILL");
  });

  test("a run's end kills an escapee whose cwd is in its seed, and the exit frame does not wait on its pipe", async () => {
    const pidFile = join(dir, "escapee.pid");
    const fs = await talk({ t: "spawn", argv: ["sh", "-c", `'${process.execPath}' ${join(dir, "escape.ts")} ${pidFile}`], cwd: join(root, "coin"), env: {} });
    expect(fs.at(-1)).toEqual({ t: "exit", code: 0 });
    expect(await gone(await pidIn(pidFile))).toBe(true);
  });

  test("a kill frame kills an escapee too", async () => {
    const pidFile = join(dir, "escapee-kill.pid");
    const r = open({ t: "spawn", argv: ["sh", "-c", `'${process.execPath}' ${join(dir, "escape.ts")} ${pidFile}; sleep 300`], cwd: join(root, "coin"), env: {} });
    const pid = await pidIn(pidFile);
    expect(alive(pid)).toBe(true);
    r.c.write(encodeFrame({ t: "kill" }));
    expect((await r.ended).at(-1)?.t).toBe("exit");
    expect(await gone(pid)).toBe(true);
    r.c.destroy();
  });

  test("a run's end leaves another live connection's process in the same seed alone", async () => {
    const pidFile = join(dir, "neighbour.pid");
    const a = open({ t: "spawn", argv: ["sh", "-c", `echo $$ > ${pidFile}; exec sleep 300`], cwd: join(root, "coin"), env: {} });
    const pid = await pidIn(pidFile);
    const fs = await talk({ t: "spawn", argv: ["sh", "-c", "true"], cwd: join(root, "coin"), env: {} });
    expect(fs.at(-1)?.t).toBe("exit");
    await Bun.sleep(200);
    expect(alive(pid)).toBe(true);
    a.c.destroy();
    expect(await gone(pid)).toBe(true);
  });

  test("busy says whether any process has its cwd in the seed", async () => {
    const pidFile = join(dir, "busy.pid");
    const a = open({ t: "spawn", argv: ["sh", "-c", `echo $$ > ${pidFile}; exec sleep 300`], cwd: join(root, "coin"), env: {} });
    const pid = await pidIn(pidFile);
    expect((await talk({ t: "busy", seed: join(root, "coin") })).at(-1)).toEqual({ t: "busy", busy: true });
    expect((await talk({ t: "busy", seed: join(root, "other") })).at(-1)).toEqual({ t: "busy", busy: false });
    a.c.destroy();
    expect(await gone(pid)).toBe(true);
    expect((await talk({ t: "busy", seed: join(root, "coin") })).at(-1)).toEqual({ t: "busy", busy: false });
  });

  test.each([
    ["the root itself", () => root],
    ["a dot folder", () => join(root, ".shared")],
    ["a nested folder", () => join(root, "coin", "sub")],
    ["a symlink out of the root", () => join(root, "escape")],
    ["a missing folder", () => join(root, "nope")],
    ["a relative path", () => "coin"],
  ])("busy for %s is refused", async (_name, seed) => {
    expect((await talk({ t: "busy", seed: seed() })).at(-1)?.t).toBe("refused");
  });

  test("before it starts codex, the runner drops every seed's trust from its own codex config", async () => {
    const home = join(dir, "codex-home");
    await mkdir(home, { recursive: true });
    const config = `model = "x"\n\n[projects."${join(root, "coin")}"]\ntrust_level = "trusted"\n\n[projects."/elsewhere"]\ntrust_level = "trusted"\n`;
    await writeFile(join(home, "config.toml"), config);
    const fakeCodex = join(dir, "fake-codex");
    await writeFile(fakeCodex, '#!/bin/sh\ncat "$CODEX_HOME/config.toml"\n');
    await chmod(fakeCodex, 0o755);
    const path = await extra("codex", {
      env: { PATH: process.env["PATH"], HOME: dir, CODEX_HOME: home },
      programs: { codex: fakeCodex },
    });
    const fs = await talk({ t: "spawn", argv: ["codex"], cwd: join(root, "coin"), env: {} }, [], 5000, path);
    expect(fs.at(-1)).toEqual({ t: "exit", code: 0 });
    // what codex itself read when it started
    expect(text(fs, "out")).toContain(`[projects."/elsewhere"]`);
    expect(text(fs, "out")).not.toContain(join(root, "coin"));
    const after = await readFile(join(home, "config.toml"), "utf8");
    expect(after).not.toContain(join(root, "coin"));
    expect(after).toContain(`[projects."/elsewhere"]`);
  });
});

describe("the fence", () => {
  const coin = () => join(root, "coin");
  /** a spawn that would leave a marker; refused means the marker never appears */
  const tryMark = async (path: string, mark: string): Promise<StageFrame[]> =>
    talk({ t: "spawn", argv: ["sh", "-c", `touch ${join(dir, mark)}`], cwd: coin(), env: {} }, [], 8000, path);

  test("with no probe target set it is unchecked: hello says so and every spawn is refused", async () => {
    const path = await extra("fence-unset", { env: { PATH: process.env["PATH"], HOME: dir, CANOPY_FENCE_PROBE: "" } });
    const [hello] = await talk({ t: "hello" }, [], 5000, path);
    expect(hello).toMatchObject({ t: "hello", fenced: "unchecked", reason: "the fence is unchecked: set CANOPY_FENCE_PROBE" });
    const fs = await tryMark(path, "fence-unset");
    expect(fs.at(-1)).toEqual({ t: "refused", reason: "the fence is unchecked: set CANOPY_FENCE_PROBE", fenced: "unchecked" });
    expect(await Bun.file(join(dir, "fence-unset")).exists()).toBe(false);
  });

  test("a probe that gets an answer is a fence that is down: refused, and hello says why", async () => {
    const path = await extra("fence-open", { probe: async () => ({ result: "open" }) });
    const fs = await tryMark(path, "fence-open");
    expect(fs.at(-1)).toEqual({ t: "refused", reason: `the fence is down: ${PROBE} answered`, fenced: false });
    expect(await Bun.file(join(dir, "fence-open")).exists()).toBe(false);
    expect((await talk({ t: "hello" }, [], 5000, path))[0]).toMatchObject({ fenced: false, reason: `the fence is down: ${PROBE} answered` });
  });

  test("a probe that fails some other way (a lookup, a certificate) is not a fence: refused with its own reason", async () => {
    const path = await extra("fence-dns", { probe: async () => ({ result: "error", why: "ENOTFOUND" }) });
    const fs = await tryMark(path, "fence-dns");
    expect(fs.at(-1)).toEqual({ t: "refused", reason: `the fence probe of ${PROBE} failed (ENOTFOUND), so the fence is not confirmed`, fenced: false });
    expect(await Bun.file(join(dir, "fence-dns")).exists()).toBe(false);
  });

  test("a probe that times out is the fence: the spawn runs", async () => {
    const asked: string[] = [];
    const path = await extra("fence-up", {
      probe: async (url) => {
        asked.push(url);
        return { result: "blocked" };
      },
    });
    const fs = await talk({ t: "spawn", argv: ["sh", "-c", "echo ran"], cwd: coin(), env: {} }, [], 8000, path);
    expect(text(fs, "out")).toBe("ran\n");
    expect(fs.at(-1)).toEqual({ t: "exit", code: 0 });
    expect(asked).toEqual([PROBE]);
  });

  test("a spawn that comes while the first probe is still out waits for it; hello does not", async () => {
    let let_go: () => void = () => {};
    const out = new Promise<void>((r) => (let_go = r));
    const path = await extra("fence-pending", {
      probe: async () => {
        await out;
        return { result: "blocked" };
      },
    });
    expect((await talk({ t: "hello" }, [], 5000, path))[0]).toMatchObject({ fenced: "unchecked", reason: "the fence probe has not finished" });
    const spawned = talk({ t: "spawn", argv: ["sh", "-c", "echo waited"], cwd: coin(), env: {} }, [], 8000, path);
    await Bun.sleep(100);
    let_go();
    const fs = await spawned;
    expect(text(fs, "out")).toBe("waited\n");
  });

  test("the probe runs again on its timer, and a fence that drops refuses from then on", async () => {
    let calls = 0;
    const path = await extra("fence-timer", {
      probe: async () => (++calls === 1 ? { result: "blocked" } : { result: "open" }),
      fenceEvery: 100,
    });
    expect((await talk({ t: "hello" }, [], 5000, path))[0]).toMatchObject({ fenced: true });
    for (let i = 0; i < 100 && calls < 2; i++) await Bun.sleep(20);
    await Bun.sleep(20);
    expect(calls).toBeGreaterThanOrEqual(2);
    expect((await talk({ t: "hello" }, [], 5000, path))[0]).toMatchObject({ fenced: false });
    expect((await tryMark(path, "fence-timer")).at(-1)).toMatchObject({ t: "refused", fenced: false });
    expect(await Bun.file(join(dir, "fence-timer")).exists()).toBe(false);
  });
});

describe("the orphan sweep", () => {
  /** the stages container as the runner sees it: docker's init as pid 1,
   *  the runner its child, and docker exec's processes with ppid 0 */
  const p = (pid: number, ppid: number, state?: string): Proc => ({ pid, ppid, argv: [], ...(state ? { state } : {}) });
  const TABLE: Proc[] = [
    p(1, 0), // docker-init
    p(7, 1), // the runner
    p(20, 7), // a live run's harness
    p(21, 20),
    p(22, 21), // the live run's grandchild
    p(30, 1), // setsid, then chdir("/"): reparented to init, cwd outside every seed
    p(40, 1), // double forked: the middle process exited
    p(41, 40), // and what it started
    p(50, 0), // docker compose exec stages claude, a login
    p(51, 50), // its child
    p(60, 0), // the healthcheck, another docker exec
    p(70, 1, "Z"), // a zombie, which only its parent can reap
    p(80, 7), // a run of the runner's whose connection is gone
  ];

  test("kills the setsid escapee and the double-forked tree, and spares init, the runner, live runs, docker exec and zombies", () => {
    expect(orphansOf(TABLE, 7, [20]).sort((a, b) => a - b)).toEqual([30, 40, 41, 80]);
  });

  test("a run that is no longer live is not spared", () => {
    expect(orphansOf(TABLE, 7, [20, 80]).sort((a, b) => a - b)).toEqual([30, 40, 41]);
  });

  test("with the runner as pid 1 the rule is the same: orphans reparent to it and still die", () => {
    const table = [p(1, 0), p(20, 1), p(21, 20), p(30, 1), p(50, 0), p(51, 50)];
    expect(orphansOf(table, 1, [20]).sort((a, b) => a - b)).toEqual([30]);
  });

  test("on only in a pid namespace of the runner's own", () => {
    // a container's process sees its pid in its own namespace last
    expect(ownPidNamespace("Name:\tbun\nNSpid:\t4123\t7\n", 7)).toBe(true);
    // the host's, or a Mac with no NSpid line
    expect(ownPidNamespace("Name:\tbun\nNSpid:\t4123\n", 4123)).toBe(false);
    expect(ownPidNamespace("", 4123)).toBe(false);
    // pid 1 is a namespace's own init, whatever the line says
    expect(ownPidNamespace("", 1)).toBe(true);
  });

  test("through a real runner: the timer and a run's end kill an escapee, and nothing outside the namespace's view", async () => {
    /** an escapee started outside any run, as a stage's setsid daemon would be */
    const escape = async (name: string): Promise<number> => {
      const pidFile = join(dir, `${name}.pid`);
      const sh = nodeSpawn("sh", ["-c", `'${process.execPath}' ${join(dir, "escape.ts")} ${pidFile}`], { cwd: "/", detached: true, stdio: "ignore" });
      sh.unref();
      return pidIn(pidFile);
    };
    const neighbour = nodeSpawn("sleep", ["300"], { detached: true, stdio: "ignore" });
    neighbour.unref();
    /** the namespace a runner sees: init, itself, and the escapees put in it */
    const viewOf =
      (watched: Set<number>) =>
      async (): Promise<Proc[]> => [p(1, 0), p(process.pid, 1), ...(await allProcs()).filter((x) => watched.has(x.pid))];
    const byTimer = new Set<number>();
    const byEnd = new Set<number>();
    try {
      byTimer.add(await escape("orphan-timer"));
      await extra("sweeper", { env: { PATH: process.env["PATH"], HOME: dir }, procs: viewOf(byTimer), sweepOrphans: true, sweepEvery: 200 });
      for (const pid of byTimer) expect(await gone(pid, 3000)).toBe(true);

      const path = await extra("sweeper-end", { env: { PATH: process.env["PATH"], HOME: dir }, procs: viewOf(byEnd), sweepOrphans: true, sweepEvery: 600_000 });
      byEnd.add(await escape("orphan-end"));
      const fs = await talk({ t: "spawn", argv: ["sh", "-c", "true"], cwd: join(root, "other"), env: {} }, [], 5000, path);
      expect(fs.at(-1)).toEqual({ t: "exit", code: 0 });
      for (const pid of byEnd) expect(await gone(pid, 3000)).toBe(true);

      expect(alive(neighbour.pid ?? 0)).toBe(true);
    } finally {
      for (const pid of [...byTimer, ...byEnd, neighbour.pid ?? 0]) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // already gone
        }
      }
    }
  });
});
