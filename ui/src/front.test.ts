import { describe, expect, test } from "bun:test";
import { benchHolds, benchProjects, benchIs, benchOf, benchTask, clearTask, frontForTab, keepFront, projectFront, type Front } from "./front";
import type { TaskInfo, TermInfo } from "../../src/core/types";
import type { TermTab } from "./term";

const tab = (id: string, repoId: string, place: TermTab["place"]): TermTab => ({ id, repoId, name: repoId, path: `/${repoId}`, place });

describe("front", () => {
  test("a bench names its project and task", () => {
    const f = projectFront("a", "dev");
    expect(benchOf(f)).toBe("a");
    expect(benchIs(f, "a")).toBe(true);
    expect(benchIs(f, "b")).toBe(false);
    expect(benchTask(f, "a")).toBe("dev");
    expect(benchTask(f, "b")).toBeUndefined();
    expect(benchOf({ kind: "strip" })).toBeNull();
    expect(benchTask(null, "a")).toBeUndefined();
  });

  test("a tasks section going clears only the task, the bench stays", () => {
    const f = projectFront("a", "dev", "t1");
    expect(clearTask(f, "a")).toEqual(projectFront("a", null, "t1"));
    expect(clearTask(f, "b")).toBe(f);
    const strip: Front = { kind: "strip" };
    expect(clearTask(strip, "a")).toBe(strip);
    const plain = projectFront("a");
    expect(clearTask(plain, "a")).toBe(plain);
  });

  test("the strip stays while it has a tab, a bench while its panel is open", () => {
    const strip: Front = { kind: "strip" };
    expect(keepFront(strip, [tab("1", "a", "strip")], [])).toBe(strip);
    expect(keepFront(strip, [tab("1", "a", "panel")], ["a"])).toBeNull();
    const bench = projectFront("a");
    // its last shell closing does not end the bench
    expect(keepFront(bench, [], ["a"])).toBe(bench);
    expect(keepFront(bench, [tab("1", "a", "panel")], ["b"])).toBeNull();
    expect(keepFront(null, [], ["a"])).toBeNull();
  });

  test("a shell goes to the front in its own place", () => {
    expect(frontForTab(null, tab("1", "a", "strip"))).toEqual({ kind: "strip" });
    expect(frontForTab(null, tab("1", "a", "panel"))).toEqual(projectFront("a", null, "1"));
    // the same bench keeps its task, another project's does not carry over
    expect(frontForTab(projectFront("a", "dev"), tab("2", "a", "panel"))).toEqual(projectFront("a", "dev", "2"));
    expect(frontForTab(projectFront("b", "dev"), tab("2", "a", "panel"))).toEqual(projectFront("a", null, "2"));
  });
});

test("a bench holds its panes open, and only its own project's", () => {
  const f = projectFront("a");
  expect(benchHolds(f, "a", "preview")).toBe(true);
  expect(benchHolds(f, "a", "shell")).toBe(true);
  expect(benchHolds(f, "a", "history")).toBe(false);
  expect(benchHolds(f, "b", "preview")).toBe(false);
  expect(benchHolds(null, "a", "preview")).toBe(false);
});

test("the bench offers the open panels, then every project with something running", () => {
  const repos = [
    { id: "a", name: "alpha" },
    { id: "b", name: "beta" },
    { id: "c", name: "gamma" },
    { id: "d", name: "delta" },
  ];
  const live = [
    { id: "s1", repoId: "c", place: "panel" },
    { id: "s2", repoId: "a", place: "strip" },
    { id: "t1", repoId: "d", place: "panel", task: "dev" },
    { id: "s3", repoId: "gone", place: "panel" },
  ] as unknown as TermInfo[];
  const tasks = [
    { repoId: "d", name: "dev", status: "running" },
    { repoId: "b", name: "test", status: "stopped" },
    { repoId: "a", name: "dev", status: "backoff" },
    { repoId: "c", name: "old", status: "running", gone: true },
  ] as unknown as TaskInfo[];
  const tabs = [tab("s2", "a", "strip"), tab("s4", "a", "panel"), { ...tab("s5", "a", "panel"), exit: 0 }];
  expect(benchProjects(["b", "a"], tabs, live, tasks, repos)).toEqual([
    { repoId: "b", name: "beta", shells: 0, running: 0 },
    { repoId: "a", name: "alpha", shells: 2, running: 1 },
    { repoId: "d", name: "delta", shells: 0, running: 1 },
    { repoId: "c", name: "gamma", shells: 1, running: 0 },
  ]);
});
