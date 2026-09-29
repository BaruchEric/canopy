import { describe, expect, test } from "bun:test";
import {
  cwdError,
  detectTasks,
  isTaskName,
  mergeTasks,
  normalizeTaskPatch,
  parseCargo,
  parseMakeTargets,
  parseScripts,
  parseTaskFile,
  parseTaskFiles,
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
