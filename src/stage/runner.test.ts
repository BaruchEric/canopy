import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn as nodeSpawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeFrame, fromB64, lineSplitter, parseFrame, type StageFrame, type StageRequest } from "../core/stagewire";
import { killTree, startStageRunner, type RunnerOptions } from "./runner";

let dir = "";
let root = "";
let sock = "";
const stops: (() => Promise<void>)[] = [];

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
  const r = await startStageRunner({ socket: sock, root, env: { PATH: process.env["PATH"], HOME: dir, GH_TOKEN: "own-secret" } });
  stops.push(r.stop);
});
afterAll(async () => {
  for (const s of stops) await s();
  await rm(dir, { recursive: true, force: true });
});

/** a runner of its own on another socket, stopped in afterAll */
async function extra(name: string, opts: Omit<RunnerOptions, "socket" | "root">): Promise<string> {
  const path = join(dir, `${name}.sock`);
  const r = await startStageRunner({ socket: path, root, ...opts });
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
    expect(f).toEqual({ t: "hello", harnesses: ["claude"] });
  });

  test("a program that resolves inside the stage root is neither listed nor started", async () => {
    const inside = await standIn(join(root, "coin", "claude"));
    const path = await extra("inroot", { env: { PATH: process.env["PATH"], HOME: dir }, programs: { claude: inside, codex: "/nonexistent/codex" } });
    expect((await talk({ t: "hello" }, [], 5000, path))[0]).toEqual({ t: "hello", harnesses: [] });
    const fs = await talk({ t: "spawn", argv: ["claude"], cwd: join(root, "coin"), env: {} }, [], 5000, path);
    expect(fs.at(-1)?.t).toBe("refused");
    await rm(inside);
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
