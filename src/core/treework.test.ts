import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Proc } from "./procs";
import { busiest, inFolder, jobWord, treesAtWork, workPids, workWord } from "./treework";

const proc = (pid: number, ppid: number, argv: string[], cpuMs?: number, startedAt = 1_000): Proc => ({ pid, ppid, argv, startedAt, ...(cpuMs !== undefined ? { cpuMs } : {}) });

test("a folder holds itself and what is under it, not a sibling whose name starts the same", () => {
  expect(inFolder("/t/feat", "/t/feat")).toBe(true);
  expect(inFolder("/t/feat/ui/src", "/t/feat")).toBe(true);
  expect(inFolder("/t/feat/ui", "/t/feat/")).toBe(true);
  expect(inFolder("/t/feat-two", "/t/feat")).toBe(false);
  expect(inFolder("/t", "/t/feat")).toBe(false);
  expect(inFolder("", "/t/feat")).toBe(false);
});

test("the processes at work in a folder are the ones sitting in it and everything under them", () => {
  const procs = [
    proc(1, 0, ["launchd"]),
    proc(10, 1, ["claude"]), // an agent in the main checkout
    proc(11, 10, ["/bin/zsh", "-c", "cd", "/t/feat"]), // its tool call, moved into the tree
    proc(12, 11, ["bun", "test"]),
    proc(13, 12, ["git", "status"]), // a test's child, in a temp folder
    proc(20, 1, ["vite"]), // another tree's dev server
    proc(30, 1, ["sleep", "9"]), // in a folder under the tree
  ];
  const cwds = new Map([
    [10, "/repo"],
    [11, "/t/feat"],
    [12, "/t/feat"],
    [13, "/tmp/x"],
    [20, "/t/other"],
    [30, "/t/feat/ui"],
  ]);
  expect([...workPids(procs, cwds, "/t/feat")].sort((a, b) => a - b)).toEqual([11, 12, 13, 30]);
  expect([...workPids(procs, cwds, "/t/other")]).toEqual([20]);
  expect(workPids(procs, cwds, "/t/none").size).toBe(0);
});

test("the backend's own git calls in a tree, and what they start, are not work in it", () => {
  const procs = [
    proc(50, 1, ["bun", "bin/canopy.ts", "ui"]), // the backend
    proc(51, 50, ["/usr/bin/git", "status", "--porcelain=v2"]),
    proc(52, 51, ["git-remote-https", "origin"]),
    proc(53, 50, ["claude", "-p"]), // a run of the backend's, which is work
    proc(54, 53, ["bun", "test"]),
  ];
  const cwds = new Map([
    [50, "/repo"],
    [51, "/t/feat"],
    [52, "/t/feat"],
    [53, "/t/feat"],
    [54, "/t/feat"],
  ]);
  expect([...workPids(procs, cwds, "/t/feat", 50)].sort((a, b) => a - b)).toEqual([53, 54]);
  // read from another process, the same git call counts
  expect(workPids(procs, cwds, "/t/feat", 999).has(51)).toBe(true);
});

test("the share of a core the processes used between two readings, and the one that used most", () => {
  const before = [proc(1, 0, ["zsh"], 500), proc(2, 1, ["bun", "test"], 1_000), proc(3, 1, ["vite"], 9_000), proc(9, 0, ["elsewhere"], 100)];
  const after = [proc(1, 0, ["zsh"], 510), proc(2, 1, ["bun", "test"], 1_800), proc(3, 1, ["vite"], 9_000), proc(9, 0, ["elsewhere"], 5_000)];
  const r = busiest(before, after, new Set([1, 2, 3]), 1_000);
  expect(r.share).toBeCloseTo(0.81, 5);
  expect(r.top?.pid).toBe(2);
});

test("a process that started between the readings counts with all it used, one whose pid was taken over too, and one that gave no reading with nothing", () => {
  const before = [proc(2, 1, ["old"], 4_000, 1_000)];
  const after = [
    proc(2, 1, ["bun", "test"], 300, 5_000), // the pid, started again since
    proc(4, 2, ["tsc"], 200),
    proc(5, 2, ["sleep", "1"]),
  ];
  const r = busiest(before, after, new Set([2, 4, 5]), 1_000);
  expect(r.share).toBeCloseTo(0.5, 5);
  expect(r.top?.pid).toBe(2);
  expect(busiest(before, [], new Set([2]), 1_000)).toEqual({ share: 0, top: null });
  expect(busiest(before, after, new Set([2]), 0)).toEqual({ share: 0, top: null });
});

test("a process in words: the program's name and the first word that is not a flag", () => {
  expect(workWord(proc(1, 0, ["/Users/e/.bun/bin/bun", "test"]))).toBe("bun test");
  expect(workWord(proc(1, 0, ["node", "/repo/node_modules/.bin/vitest", "run"]))).toBe("node vitest");
  expect(workWord(proc(1, 0, ["cargo", "--quiet", "test"]))).toBe("cargo test");
  expect(workWord(proc(1, 0, ["tsc"]))).toBe("tsc");
  expect(workWord({ ...proc(1, 0, ["bun", "run", "build"]), comm: "/opt/homebrew/bin/bun" })).toBe("bun run");
  expect(workWord(proc(7, 0, []))).toBe("process 7");
  expect(workWord(proc(1, 0, ["python3", `${"x".repeat(80)}.py`])).length).toBeLessThanOrEqual(40);
});

test("a job is told by its name: a test run, a build, a check or an install, through its runtime or its runner", () => {
  const job = (...argv: string[]) => jobWord(proc(1, 0, argv));
  expect(job("bun", "test")).toBe("bun test");
  expect(job("/Users/e/.bun/bin/bun", "test", "src/core")).toBe("bun test");
  expect(jobWord({ ...proc(1, 0, ["bun", "test"]), comm: "/Users/e/.bun/bin/bun" })).toBe("bun test");
  expect(job("bun", "run", "build")).toBe("bun run build");
  expect(job("bun", "run", "test:e2e")).toBe("bun run test:e2e");
  expect(job("bun", "typecheck")).toBe("bun typecheck");
  expect(job("npm", "run", "typecheck")).toBe("npm run typecheck");
  expect(job("bun", "install")).toBe("bun install");
  expect(job("cargo", "--quiet", "test")).toBe("cargo test");
  expect(job("cargo", "clippy")).toBe("cargo clippy");
  expect(job("go", "test", "./...")).toBe("go test");
  expect(job("node", "/repo/node_modules/.bin/vitest", "run")).toBe("vitest run");
  expect(job("node", "/repo/node_modules/typescript/bin/tsc", "--noEmit", "-p", "tsconfig.json")).toBe("tsc");
  expect(job("bunx", "oxlint", "src")).toBe("oxlint");
  expect(job("bun", "x", "jest")).toBe("jest");
  expect(job("python3", "-m", "pytest", "-q")).toBe("pytest");
  expect(job("uv", "run", "pytest")).toBe("pytest");
  expect(job("vite", "build")).toBe("vite build");
  expect(job("playwright", "test")).toBe("playwright test");
  expect(job("make", "-j8", "all")).toBe("make");
});

test("what stays up is not a job: a watcher, a dev server, a shell, an agent, the wrapper a tool call runs in", () => {
  const job = (...argv: string[]) => jobWord(proc(1, 0, argv));
  expect(job("bun", "--watch", "test")).toBeNull();
  expect(job("bun", "test", "--watch")).toBeNull();
  expect(job("tsc", "-w")).toBeNull();
  expect(job("npx", "jest", "--watchAll")).toBeNull();
  expect(job("bun", "run", "dev")).toBeNull();
  expect(job("bun", "--watch", "bin/canopy.ts", "ui", ".")).toBeNull();
  expect(job("bun", "bin/canopy.ts", "ui")).toBeNull();
  // vitest watches unless told to run once
  expect(job("node", "/repo/node_modules/.bin/vitest")).toBeNull();
  expect(job("vite")).toBeNull();
  expect(job("next", "dev")).toBeNull();
  expect(job("webpack", "serve")).toBeNull();
  expect(job("cargo", "run")).toBeNull();
  expect(job("cargo", "watch", "-x", "test")).toBeNull();
  expect(job("claude")).toBeNull();
  expect(job("/bin/zsh", "-il")).toBeNull();
  expect(job("sh", "-c", "bun", "test")).toBeNull();
  expect(job("git", "status")).toBeNull();
  expect(job("sleep", "30")).toBeNull();
  expect(job()).toBeNull();
});

let dir = "";
beforeAll(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), "canopy-work-")));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

test("on this machine: a test run in a folder is found by its name at once, however little it does", async () => {
  if (process.platform !== "linux" && process.platform !== "darwin") return;
  await writeFile(join(dir, "slow.test.ts"), 'import { test } from "bun:test";\ntest("slow", async () => {\n  await Bun.sleep(15_000);\n}, 20_000);\n');
  const run = Bun.spawn([process.execPath, "test", "slow.test.ts"], { cwd: dir, stdout: "ignore", stderr: "ignore" });
  try {
    const started = Date.now();
    // a window this long would time the test out: a job found by name needs no second reading
    const found = await treesAtWork([dir], { windowMs: 60_000 });
    expect(found.get(dir)).toBe("bun test");
    expect(Date.now() - started).toBeLessThan(10_000);
  } finally {
    run.kill();
    await run.exited;
  }
}, 20_000);

test("on this machine: a busy process with no name for a job is found by its CPU, an idle one is not, and a folder nothing sits in costs no wait", async () => {
  if (process.platform !== "linux" && process.platform !== "darwin") return;
  const started = Date.now();
  expect((await treesAtWork([join(dir, "nobody-here")], { windowMs: 60_000 })).size).toBe(0);
  expect(Date.now() - started).toBeLessThan(10_000);

  const idle = Bun.spawn(["sleep", "30"], { cwd: dir, stdout: "ignore", stderr: "ignore" });
  try {
    expect((await treesAtWork([dir], { windowMs: 400 })).get(dir)).toBeUndefined();
  } finally {
    idle.kill();
    await idle.exited;
  }

  const busy = Bun.spawn(["sh", "-c", "while :; do :; done"], { cwd: dir, stdout: "ignore", stderr: "ignore" });
  try {
    const found = await treesAtWork([dir, join(dir, "nobody-here")], { windowMs: 600 });
    expect([...found]).toEqual([[dir, "sh"]]);
  } finally {
    busy.kill();
    await busy.exited;
  }
}, 20_000);
