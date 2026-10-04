import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn as nodeSpawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeFrame, fromB64, lineSplitter, parseFrame, type StageFrame, type StageRequest } from "../core/stagewire";
import { allProcs, type Proc } from "../core/procs";
import { enterSeed, killTree, orphansOf, ownPidNamespace, rootStart, socketModes, stageChores, startStageRunner, writableBy, type RunnerOptions } from "./runner";

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
      expect(fs.at(-1)).toEqual({ t: "refused", reason: `${name} is not started: ${file} is writable by the stage user, so a stage could change it` });
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
    const config = `model = "x"\n\n[projects."${join(root, "coin")}"]\ntrust_level = "trusted"\n`;
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
    expect(text(fs, "out")).toContain('model = "x"');
    expect(text(fs, "out")).not.toContain(join(root, "coin"));
    expect(await readFile(join(home, "config.toml"), "utf8")).not.toContain(join(root, "coin"));
  });

  test("any spawn sweeps the seeds' trust first, and a projects table left after it refuses, naming it", async () => {
    const home = join(dir, "codex-home-2");
    await mkdir(home, { recursive: true });
    await writeFile(join(home, "config.toml"), `[projects."${join(root, "coin")}"]\ntrust_level = "trusted"\n`);
    const path = await extra("codex2", { env: { PATH: process.env["PATH"], HOME: dir, CODEX_HOME: home } });
    const ran = await talk({ t: "spawn", argv: ["sh", "-c", "exit 0"], cwd: join(root, "coin"), env: {} }, [], 5000, path);
    expect(ran.at(-1)).toEqual({ t: "exit", code: 0 });
    expect(await readFile(join(home, "config.toml"), "utf8")).not.toContain(join(root, "coin"));
    await writeFile(join(home, "config.toml"), '[projects."/elsewhere"]\ntrust_level = "trusted"\n');
    const fs = await talk({ t: "spawn", argv: ["sh", "-c", `touch ${join(dir, "ran-projects")}`], cwd: join(root, "coin"), env: {} }, [], 5000, path);
    expect(fs.at(-1)).toMatchObject({ t: "refused" });
    expect((fs.at(-1) as { reason: string }).reason).toStartWith(`${join(home, "config.toml")} holds "projects"`);
    expect(await Bun.file(join(dir, "ran-projects")).exists()).toBe(false);
  });

  test("a stage claude settings file off the allowlist refuses every spawn, by file and key, as a plain refusal and not the fence", async () => {
    const cfg = join(dir, "stage-claude");
    await mkdir(cfg, { recursive: true });
    await writeFile(join(cfg, "settings.json"), JSON.stringify({ model: "opus", hooks: { PreToolUse: [] } }));
    const path = await extra("settings", { env: { PATH: process.env["PATH"], HOME: dir, CLAUDE_CONFIG_DIR: cfg } });
    const fs = await talk({ t: "spawn", argv: ["sh", "-c", `touch ${join(dir, "ran-settings")}`], cwd: join(root, "coin"), env: {} }, [], 5000, path);
    const last = fs.at(-1) as { t: string; reason: string; fenced?: unknown };
    expect(last.t).toBe("refused");
    expect(last.reason).toStartWith(`${join(cfg, "settings.json")} holds "hooks"`);
    expect(last.fenced).toBeUndefined();
    expect(await Bun.file(join(dir, "ran-settings")).exists()).toBe(false);
    // fixed by hand, the next spawn runs
    await writeFile(join(cfg, "settings.json"), JSON.stringify({ model: "opus" }));
    expect((await talk({ t: "spawn", argv: ["sh", "-c", "exit 0"], cwd: join(root, "coin"), env: {} }, [], 5000, path)).at(-1)).toEqual({ t: "exit", code: 0 });
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

  test("on under compose's init: true, where the container's /proc shows one NSpid level", () => {
    // what the stages container on the mini reads: docker-init is pid 1, the
    // runner its child, and /proc belongs to the container's own namespace
    const status = "Name:\tbun\nPPid:\t1\nNSpid:\t7\n";
    expect(ownPidNamespace(status, 7, "docker-init\n")).toBe(true);
    expect(ownPidNamespace(status, 7, "tini")).toBe(true);
    // a host's pid 1 is systemd or launchd, never one of those
    expect(ownPidNamespace(status, 7, "systemd\n")).toBe(false);
    // under docker-init but not its child: a run's process, not the runner
    expect(ownPidNamespace("Name:\tbun\nPPid:\t40\nNSpid:\t7\n", 7, "docker-init")).toBe(false);
    expect(ownPidNamespace("Name:\tbun\nNSpid:\t7\n", 7, "docker-init")).toBe(false);
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

describe("git in a seed", () => {
  const seed = () => join(root, "gitseed");
  const quiet = { stdout: "ignore", stderr: "ignore" } as const;
  let runnerPath = "";
  let head = "";
  beforeAll(async () => {
    await mkdir(seed(), { recursive: true });
    for (const argv of [
      ["git", "init", "-q", "-b", "main"],
      ["git", "-c", "user.name=a", "-c", "user.email=a@b", "commit", "-q", "--allow-empty", "-m", "one"],
    ]) {
      expect(await Bun.spawn(argv, { cwd: seed(), ...quiet }).exited).toBe(0);
    }
    head = (await new Response(Bun.spawn(["git", "rev-parse", "HEAD"], { cwd: seed(), stdout: "pipe" }).stdout).text()).trim();
    // a global config the runner's own HOME holds, which canopy's git must never read
    await writeFile(join(dir, ".gitconfig"), "[user]\n\tname = from-the-home\n");
    runnerPath = await extra("git", { env: { PATH: process.env["PATH"], HOME: dir, ...FENCE } });
  });

  test("runs git in the seed and answers its output and exit code", async () => {
    const fs = await talk({ t: "git", seed: seed(), args: ["rev-parse", "HEAD"], env: {} }, [], 8000, runnerPath);
    expect(text(fs, "out").trim()).toBe(head);
    expect(fs.at(-1)).toEqual({ t: "exit", code: 0 });
  });

  test("reads no global config, sets the ceiling, and passes git's own names alone", async () => {
    const fs = await talk(
      { t: "git", seed: seed(), args: ["var", "GIT_AUTHOR_IDENT"], env: { GIT_AUTHOR_NAME: "canopy", GIT_AUTHOR_EMAIL: "canopy@mini" } },
      [],
      8000,
      runnerPath,
    );
    expect(text(fs, "out")).toStartWith("canopy <canopy@mini>");
    const user = await talk({ t: "git", seed: seed(), args: ["config", "user.name"], env: {} }, [], 8000, runnerPath);
    expect(text(user, "out")).toBe("");
    expect(user.at(-1)).toEqual({ t: "exit", code: 1 });
  });

  test("the seed's fsmonitor and hooks do not run", async () => {
    const mark = join(dir, "fsmonitor-ran");
    await writeFile(join(dir, "fsmonitor.sh"), `#!/bin/sh\ntouch ${mark}\n`);
    await chmod(join(dir, "fsmonitor.sh"), 0o755);
    expect(await Bun.spawn(["git", "config", "core.fsmonitor", join(dir, "fsmonitor.sh")], { cwd: seed(), ...quiet }).exited).toBe(0);
    try {
      const fs = await talk({ t: "git", seed: seed(), args: ["status", "--porcelain"], env: {} }, [], 8000, runnerPath);
      expect(fs.at(-1)).toEqual({ t: "exit", code: 0 });
      expect(await Bun.file(mark).exists()).toBe(false);
    } finally {
      await Bun.spawn(["git", "config", "--unset", "core.fsmonitor"], { cwd: seed(), ...quiet }).exited;
    }
  });

  test.each([
    ["a nested folder", () => join(root, "coin", "sub")],
    ["a dot folder", () => join(root, ".shared")],
    ["the root itself", () => root],
    ["a symlink out of the root", () => join(root, "escape")],
    ["a relative path", () => "gitseed"],
  ])("in %s is refused", async (_name, where) => {
    const fs = await talk({ t: "git", seed: where(), args: ["status"], env: {} }, [], 8000, runnerPath);
    expect(fs).toHaveLength(1);
    expect(fs[0]?.t).toBe("refused");
  });

  test("an env name off git's own list is refused before anything runs", async () => {
    const fs = await talk({ t: "git", seed: seed(), args: ["add", "-A"], env: { GIT_INDEX_FILE: join(dir, "elsewhere") } }, [], 8000, runnerPath);
    expect(fs).toEqual([{ t: "refused", reason: expect.stringContaining("GIT_INDEX_FILE") }]);
  });

  test("waits for the fence like a spawn, and refuses unfenced", async () => {
    const path = await extra("git-open", { probe: async () => ({ result: "open" }) });
    const fs = await talk({ t: "git", seed: seed(), args: ["status"], env: {} }, [], 8000, path);
    expect(fs).toEqual([{ t: "refused", reason: `the fence is down: ${PROBE} answered`, fenced: false }]);
  });

  test("a git the stage user could rewrite is refused", async () => {
    const path = await extra("git-writable", { writable: async () => true });
    const fs = await talk({ t: "git", seed: seed(), args: ["status"], env: {} }, [], 8000, path);
    expect(fs.at(-1)?.t).toBe("refused");
    expect((fs.at(-1) as { reason: string }).reason).toContain("writable");
  });

  test("the orphan sweep spares a git still running, and its end takes its tree", async () => {
    const pidFile = join(dir, "slow-git.pid");
    const slow = join(dir, "slow-git");
    await writeFile(slow, `#!/bin/sh\necho $$ > ${pidFile}\nexec sleep 300\n`);
    await chmod(slow, 0o755);
    const watched = new Set<number>();
    const view = async (): Promise<Proc[]> => [
      { pid: 1, ppid: 0, argv: [] },
      { pid: process.pid, ppid: 1, argv: [] },
      ...(await allProcs()).filter((x) => watched.has(x.pid)),
    ];
    const path = await extra("git-sweep", { programs: { git: slow }, procs: view, sweepOrphans: true, sweepEvery: 100 });
    const live = (() => {
      const got: StageFrame[] = [];
      const split = lineSplitter();
      const c = connect(path, () => c.write(encodeFrame({ t: "git", seed: seed(), args: ["status"], env: {} })));
      c.on("data", (b) => {
        for (const line of split(b.toString())) {
          const f = parseFrame(line) as StageFrame | null;
          if (f) got.push(f);
        }
      });
      c.on("error", () => {});
      return { c, got };
    })();
    const pid = await pidIn(pidFile);
    watched.add(pid);
    await Bun.sleep(600);
    expect(alive(pid)).toBe(true);
    live.c.destroy();
    expect(await gone(pid)).toBe(true);
  });
});

describe("a root runner drops every child", () => {
  test("writableBy reads the owner, group and other bits for the stage uid alone", () => {
    const st = (uid: number, gid: number, mode: number) => ({ uid, gid, mode });
    expect(writableBy(st(1000, 1000, 0o755), 1000, 1000)).toBe(true);
    expect(writableBy(st(1000, 1000, 0o555), 1000, 1000)).toBe(false);
    expect(writableBy(st(0, 1000, 0o775), 1000, 1000)).toBe(true);
    expect(writableBy(st(0, 1000, 0o755), 1000, 1000)).toBe(false);
    expect(writableBy(st(0, 0, 0o757), 1000, 1000)).toBe(true);
    // root's own files, as a root runner sees them: not the stage user's
    expect(writableBy(st(0, 0, 0o755), 1000, 1000)).toBe(false);
    // the owner bits decide for the owner, whatever the group's say
    expect(writableBy(st(1000, 1000, 0o575), 1000, 1000)).toBe(false);
    // a sticky world-writable folder still counts: what the stage made there is its own
    expect(writableBy(st(0, 0, 0o1777), 1000, 1000)).toBe(true);
  });

  test("every child, git included, starts through setpriv as the stage uid with no groups", async () => {
    const log = join(dir, "setpriv.log");
    // the stand-in sits where the stage uid can write nothing up to "/", or
    // the runner refuses it: not the scratch dir, since Linux's tmpdir is a
    // world-writable /tmp (a Mac's is the user's own)
    const cache = join(import.meta.dir, "../../node_modules/.cache");
    await mkdir(cache, { recursive: true });
    const own = await mkdtemp(join(cache, "setpriv-"));
    stops.push(() => rm(own, { recursive: true, force: true }));
    const setpriv = join(own, "setpriv");
    const cwds = join(dir, "setpriv.cwd");
    await writeFile(setpriv, `#!/bin/sh\npwd -P >> ${cwds}\nprintf '%s\\n' "$@" >> ${log}\nwhile [ "$1" != "--" ]; do shift; done\nshift\nexec "$@"\n`);
    await chmod(setpriv, 0o755);
    const seed = join(root, "dropped");
    await mkdir(seed, { recursive: true });
    expect(await Bun.spawn(["git", "init", "-q", "-b", "main"], { cwd: seed }).exited).toBe(0);
    // the default writability check, judged for a stage uid that owns nothing here
    // the stages' codex config holds a seed's trust, swept by the chores child
    const home = join(dir, "dropped-codex");
    await mkdir(home, { recursive: true });
    await writeFile(join(home, "config.toml"), `[projects."${seed}"]\ntrust_level = "trusted"\n`);
    const self = [process.execPath, join(import.meta.dir, "main.ts")];
    const path = await extra("dropped", {
      as: { uid: 4242, gid: 4343, setpriv, self },
      writable: undefined,
      env: { PATH: process.env["PATH"], HOME: dir, CODEX_HOME: home },
    });
    const ran = await talk({ t: "spawn", argv: ["sh", "-c", "echo hi"], cwd: seed, env: {} }, [], 15000, path);
    expect(text(ran, "out")).toBe("hi\n");
    expect(await readFile(join(home, "config.toml"), "utf8")).not.toContain("trust_level");
    const gitRan = await talk({ t: "git", seed, args: ["rev-parse", "--is-inside-work-tree"], env: {} }, [], 8000, path);
    expect(text(gitRan, "out").trim()).toBe("true");
    const lines = (await readFile(log, "utf8")).trim().split("\n");
    const head = ["--reuid=4242", "--regid=4343", "--clear-groups", "--no-new-privs", "--"];
    const starts = lines.flatMap((l, i) => (l === "--reuid=4242" ? [lines.slice(i, i + 11)] : []));
    expect(starts).toHaveLength(3);
    for (const s of starts) expect(s.slice(0, 5)).toEqual(head);
    // the sweep and the settings check, as the stage user, before the spawn
    expect(starts[0]?.slice(5, 8)).toEqual([...self, "--stage-chores"]);
    // each stage starts in "/" and enters its seed only after the drop
    const real = await realpath(seed);
    for (const s of starts.slice(1)) expect(s.slice(6, 10)).toEqual(enterSeed("sh", real, []).slice(1));
    expect(starts[1]?.[10]).toEndWith("/sh");
    expect(starts[2]?.[10]).toEndWith("/git");
    expect(new Set((await readFile(cwds, "utf8")).trim().split("\n"))).toEqual(new Set(["/"]));
  }, 20_000);

  test("a stage enters its seed after the drop, and runs nothing when the seed is not where it was checked", async () => {
    const real = await realpath(await mkdtemp(join(dir, "enter-")));
    const ran = join(real, "ran");
    const go = (seed: string) => Bun.spawn(enterSeed("/bin/sh", seed, ["/bin/sh", "-c", `pwd -P > ${ran}`]), { cwd: "/", stderr: "pipe" });
    const ok = go(real);
    expect(await ok.exited).toBe(0);
    expect((await readFile(ran, "utf8")).trim()).toBe(real);
    await rm(ran);
    // the seed swapped for a link to a folder elsewhere since the check
    const elsewhere = await realpath(await mkdtemp(join(dir, "elsewhere-")));
    const swapped = join(real, "seed");
    await symlink(elsewhere, swapped);
    const no = go(swapped);
    expect(await no.exited).toBe(126);
    expect(await new Response(no.stderr).text()).toContain("seed");
    expect(await Bun.file(ran).exists()).toBe(false);
    // and a seed that is gone
    const gone = go(join(real, "gone"));
    expect(await gone.exited).toBe(126);
  });

  test("the chores never follow a link the stage planted in its config folders", async () => {
    const home = join(dir, "chores-codex");
    await mkdir(home, { recursive: true });
    const outside = join(dir, "chores-outside.toml");
    const trusted = '[projects."/w/_incubator/coin"]\ntrust_level = "trusted"\n';
    await writeFile(outside, trusted);
    await symlink(outside, join(home, "config.toml"));
    // a link is not a plain config: the sweep leaves it, and what it points at
    await stageChores({ CODEX_HOME: home, HOME: dir }, ["/w/_incubator"]);
    expect(await readFile(outside, "utf8")).toBe(trusted);
    // a plain config with the seeds' trust is swept, and nothing else is left to refuse
    await rm(join(home, "config.toml"));
    await writeFile(join(home, "config.toml"), trusted);
    expect(await stageChores({ CODEX_HOME: home, HOME: dir }, ["/w/_incubator"])).toBeNull();
    expect(await readFile(join(home, "config.toml"), "utf8")).not.toContain("trust_level");
    // a key that would steer a stage still refuses
    await writeFile(join(home, "config.toml"), 'notify = ["x"]\n');
    expect(await stageChores({ CODEX_HOME: home, HOME: dir }, ["/w/_incubator"])).toContain("notify");
  });

  test("a root start needs a stage uid and gid, and a caller group of its own", () => {
    const ok = { CANOPY_STAGE_UID: "1000", CANOPY_STAGE_GID: "1000", CANOPY_STAGE_CALLER_GID: "7850" };
    expect(rootStart(ok)).toEqual({ uid: 1000, gid: 1000, callerGid: 7850 });
    expect(rootStart({ ...ok, CANOPY_STAGE_UID: "0" })).toHaveProperty("refused");
    expect(rootStart({ ...ok, CANOPY_STAGE_GID: undefined })).toHaveProperty("refused");
    expect(rootStart({ ...ok, CANOPY_STAGE_UID: "1000x" })).toHaveProperty("refused");
    expect(rootStart({ ...ok, CANOPY_STAGE_CALLER_GID: "" })).toHaveProperty("refused");
    expect(rootStart({ ...ok, CANOPY_STAGE_CALLER_GID: "1000" })).toHaveProperty("refused");
  });

  test("the socket's folder is root's and the caller group's alone, and so is the socket", async () => {
    const calls: string[] = [];
    const fs = {
      chown: async (p: string, uid: number, gid: number) => void calls.push(`chown ${p} ${uid}:${gid}`),
      chmod: async (p: string, mode: number) => void calls.push(`chmod ${p} ${mode.toString(8)}`),
    };
    await socketModes("/run/canopy-stage", "/run/canopy-stage/runner.sock", 7850, fs);
    expect(calls).toEqual([
      "chown /run/canopy-stage 0:7850",
      "chmod /run/canopy-stage 750",
      "chown /run/canopy-stage/runner.sock 0:7850",
      "chmod /run/canopy-stage/runner.sock 660",
    ]);
  });

  test("a setpriv the stage user could write starts nothing", async () => {
    const setpriv = join(dir, "setpriv-open");
    await writeFile(setpriv, "#!/bin/sh\nexit 0\n");
    await chmod(setpriv, 0o777);
    await expect(startStageRunner({ socket: join(dir, "open.sock"), root, probe: blocked, as: { uid: 4242, gid: 4343, setpriv, self: [] } })).rejects.toThrow("setpriv");
  });
});
