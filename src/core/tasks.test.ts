import { describe, expect, test } from "bun:test";
import {
  cwdError,
  detectTasks,
  expiredTaskLogs,
  isTaskName,
  logPage,
  mergeTasks,
  nextDelay,
  normalizeTaskPatch,
  parseCargo,
  parseMakeTargets,
  parseScripts,
  parseTaskFile,
  parseTaskFiles,
  parseTaskState,
  plainLines,
  reapable,
  startMark,
  staleWants,
  taskStatus,
} from "./tasks";

describe("names and patches", () => {
  test("task names", () => {
    expect(isTaskName("dev")).toBe(true);
    expect(isTaskName("test.watch-2")).toBe(true);
    expect(isTaskName("Dev")).toBe(false);
    expect(isTaskName("-x")).toBe(false);
    expect(isTaskName("a".repeat(41))).toBe(false);
  });
  test("cwd stays inside the repo", () => {
    expect(cwdError("ui")).toBeNull();
    expect(cwdError("/etc")).not.toBeNull();
    expect(cwdError("ui/../..")).not.toBeNull();
  });
  test("a patch is validated field by field", () => {
    expect(normalizeTaskPatch({ name: "dev", cmd: " bun run dev ", keep: true })).toEqual({ name: "dev", cmd: "bun run dev", keep: true });
    expect(normalizeTaskPatch({ name: "dev", cwd: "./" })).toEqual({ name: "dev" });
    expect(typeof normalizeTaskPatch({ name: "dev", cmd: "a\nb" })).toBe("string");
    expect(typeof normalizeTaskPatch({ name: "dev", keep: "yes" })).toBe("string");
    expect(typeof normalizeTaskPatch({ name: "Bad" })).toBe("string");
    expect(typeof normalizeTaskPatch({ name: "x", cwd: "../out" })).toBe("string");
  });
  test("the repo file keeps good entries and reports bad ones", () => {
    const r = parseTaskFile(JSON.stringify([{ name: "a", cmd: "x" }, { name: "B" }, { name: "a", cmd: "y" }]));
    expect(r.patches).toEqual([{ name: "a", cmd: "x" }]);
    expect(r.errors.length).toBe(2);
    expect(parseTaskFile("{").errors).toEqual([".canopy/tasks.json is not JSON"]);
    expect(parseTaskFile("{}").errors).toEqual([".canopy/tasks.json is a list of tasks"]);
  });
});

describe("detection", () => {
  test("package.json scripts run through bun, lifecycle hooks left out", () => {
    const pkg = JSON.stringify({ scripts: { dev: "vite", "test:watch": "vitest", prebuild: "x", build: "tsc", postinstall: "y", "my script": "z" } });
    expect(parseScripts(pkg)).toEqual([
      { name: "dev", cmd: "bun run dev", dev: true },
      { name: "test-watch", cmd: "bun run test:watch" },
      { name: "build", cmd: "bun run build" },
      { name: "my-script", cmd: "bun run 'my script'" },
    ]);
    expect(parseScripts("not json")).toEqual([]);
    expect(parseScripts("{}")).toEqual([]);
  });
  test("cargo: a package runs, a bare workspace does not", () => {
    expect(parseCargo('[package]\nname = "x"').map((t) => t.cmd)).toEqual(["cargo build", "cargo test", "cargo run"]);
    expect(parseCargo("[workspace]\nmembers = []").map((t) => t.cmd)).toEqual(["cargo build", "cargo test"]);
    expect(parseCargo("")).toEqual([]);
  });
  test("make: plain targets only", () => {
    const mk = ["all: build", ".PHONY: all", "%.o: %.c", "CC := gcc", "lint:", "\techo lint", "a b: c", "all: again"].join("\n");
    expect(parseMakeTargets(mk)).toEqual([
      { name: "all", cmd: "make all" },
      { name: "lint", cmd: "make lint" },
    ]);
  });
  test("the first manifest wins a name", () => {
    const t = detectTasks({ pkg: JSON.stringify({ scripts: { build: "tsc" } }), cargo: "[package]", make: "build:\nextra:" });
    expect(t.map((x) => `${x.name}=${x.cmd}`)).toEqual(["build=bun run build", "test=cargo test", "run=cargo run", "extra=make extra"]);
  });
  test("the file dump splits back into files", () => {
    const out = "\x1epackage.json\n{\"a\":1}\n\x1eMakefile\nall:\n";
    expect(parseTaskFiles(out)).toEqual({ pkg: '{"a":1}\n', make: "all:\n" });
    expect(parseTaskFiles("")).toEqual({});
  });
});

describe("merge", () => {
  const detected = [{ name: "dev", cmd: "bun run dev", dev: true }, { name: "test", cmd: "bun run test" }];

  test("later layers win field by field, and say so", () => {
    const r = mergeTasks(detected, [{ name: "test", cmd: "bun test --bail" }], [{ name: "dev", keep: true }], true);
    expect(r.tasks).toEqual([
      { name: "dev", cmd: "bun run dev", dev: true, keep: true, source: "canopy" },
      { name: "test", cmd: "bun test --bail", source: "repo" },
    ]);
  });
  test("new names append in layer order", () => {
    const r = mergeTasks([], [{ name: "a", cmd: "x" }], [{ name: "b", cmd: "y" }], true);
    expect(r.tasks.map((t) => t.name)).toEqual(["a", "b"]);
  });
  test("a task with no command is an error, not a task", () => {
    const r = mergeTasks([], [{ name: "a", keep: true }], [], true);
    expect(r.tasks).toEqual([]);
    expect(r.errors).toEqual(["a: no command"]);
  });
  test("auto flags from someone else's repo file are only suggested", () => {
    const r = mergeTasks(detected, [{ name: "dev", keep: true, withPanel: true }], [], false);
    expect(r.tasks[0]).toEqual({ name: "dev", cmd: "bun run dev", dev: true, source: "repo", suggested: { keep: true, withPanel: true } });
  });
  test("an answer in canopy's layer clears the suggestion", () => {
    const r = mergeTasks(detected, [{ name: "dev", keep: true }], [{ name: "dev", keep: false }], false);
    expect(r.tasks[0]).toEqual({ name: "dev", cmd: "bun run dev", dev: true, keep: false, source: "canopy" });
  });
  test("own repos apply the repo file's flags", () => {
    const r = mergeTasks(detected, [{ name: "dev", keep: true }], [], true);
    expect(r.tasks[0]?.keep).toBe(true);
  });
  test("only one dev task", () => {
    const r = mergeTasks(detected, [{ name: "web", cmd: "x", dev: true }], [], true);
    expect(r.tasks.filter((t) => t.dev).map((t) => t.name)).toEqual(["dev"]);
    expect(r.errors).toEqual(["web: only one dev task; dev is it"]);
  });
});

describe("backoff and status", () => {
  test("delays double to a cap", () => {
    expect([1, 2, 3, 4, 5, 6, 7, 8].map((n) => nextDelay(n))).toEqual([1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000]);
    expect(nextDelay(3, 100, 250)).toBe(250);
  });
  const base = { live: false, dead: false, want: undefined, gaveUp: false } as const;
  test("status from what tmux and the record say", () => {
    expect(taskStatus({ ...base, live: true })).toBe("running");
    expect(taskStatus({ ...base, live: true, dead: true, want: "running", exitedAt: 1, exitCode: 2 })).toBe("failed");
    expect(taskStatus({ ...base, want: "running", exitedAt: 1, exitCode: 0 })).toBe("exited");
    expect(taskStatus({ ...base, want: "stopped", exitedAt: 1, exitCode: 130 })).toBe("exited");
    expect(taskStatus({ ...base, want: "running", exitedAt: 1, exitCode: 1, retryAt: 5 })).toBe("backoff");
    expect(taskStatus({ ...base, want: "running", exitedAt: 1, exitCode: 1, gaveUp: true })).toBe("gave-up");
    expect(taskStatus(base)).toBe("idle");
  });
});

describe("log text", () => {
  test("ANSI and overwritten progress are dropped", () => {
    expect(plainLines("\x1b[32mok\x1b[0m\r\n10%\r50%\r100%\nend")).toEqual(["ok", "100%", "end"]);
    expect(plainLines("\x1b]0;title\x07x")).toEqual(["x"]);
  });
  test("a page carries each line's run start", () => {
    const raw = ["before", startMark(1000, "a"), "one", startMark(2000, "b"), "two", ""].join("\n");
    const page = logPage(raw, {});
    expect(page.lines.map((l) => [l.n, l.text, l.at, l.mark ?? false])).toEqual([
      [1, "before", null, false],
      [2, "--- started 1000 · a ---", 1000, true],
      [3, "one", 1000, false],
      [4, "--- started 2000 · b ---", 2000, true],
      [5, "two", 2000, false],
    ]);
    expect(page.more).toBe(false);
  });
  test("search, paging back and the limit", () => {
    const raw = ["Error a", "fine", "error b", "ERROR c"].join("\n");
    const hits = logPage(raw, { q: "error", limit: 2 });
    expect(hits.lines.map((l) => l.n)).toEqual([3, 4]);
    expect(hits.more).toBe(true);
    expect(logPage(raw, { q: "error", before: 3 }).lines.map((l) => l.n)).toEqual([1]);
  });
});

describe("state and the sweep", () => {
  test("state.json drops what it cannot use", () => {
    const a: string = "a".repeat(32);
    const b: string = "b".repeat(32);
    const c: string = "c".repeat(32);
    const text = JSON.stringify({
      [a]: { repoId: "r", path: "/p", name: "dev", want: "running", exitCode: 1, exitedAt: 5 },
      [b]: { repoId: "r", path: "/p", name: "Bad", want: "running" },
      [c]: "nope",
      short: { repoId: "r", path: "/p", name: "dev", want: "running" },
    });
    expect(parseTaskState(text)).toEqual({ [a]: { repoId: "r", path: "/p", name: "dev", want: "running", exitCode: 1, exitedAt: 5 } });
    expect(parseTaskState("not json")).toEqual({});
  });
  const DAY = 86_400_000;
  test("logs go only when unused, undefined and old", () => {
    const logs = [
      { termId: "live", mtime: 0 },
      { termId: "defined", mtime: 0 },
      { termId: "unknown", mtime: 0 },
      { termId: "fresh", mtime: 8 * DAY - 1 },
      { termId: "gone", mtime: 0 },
    ];
    const defined = (id: string) => (id === "defined" ? true : id === "unknown" ? null : false);
    expect(expiredTaskLogs(logs, new Set(["live"]), defined, 8 * DAY, 7 * DAY)).toEqual(["gone"]);
  });
  test("a dead pane with no viewers is reaped after the wait", () => {
    expect(reapable({ dead: true, exitedAt: 0, viewers: 0 }, 3_600_001, 3_600_000)).toBe(true);
    expect(reapable({ dead: true, exitedAt: 0, viewers: 1 }, 3_600_001, 3_600_000)).toBe(false);
    expect(reapable({ dead: false, exitedAt: 0, viewers: 0 }, 3_600_001, 3_600_000)).toBe(false);
    expect(reapable({ dead: true, viewers: 0 }, 3_600_001, 3_600_000)).toBe(false);
  });
  test("wants for gone tasks with no session", () => {
    const st = {
      a: { repoId: "r", path: "/p", name: "a", want: "running" as const },
      b: { repoId: "r", path: "/p", name: "b", want: "stopped" as const },
      c: { repoId: "r", path: "/p", name: "c", want: "stopped" as const },
    };
    expect(staleWants(st, new Set(["a"]), (id) => (id === "b" ? true : false))).toEqual(["c"]);
  });
});
