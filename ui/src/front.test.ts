import { describe, expect, test } from "bun:test";
import {
  BENCH_DOCK,
  BENCH_SPLIT,
  benchRailOf,
  dockAt,
  railAt,
  shareOf,
  splitAt,
  benchHolds,
  benchProjects,
  benchIs,
  benchOf,
  benchSolo,
  benchTask,
  clearTask,
  frontForTab,
  frontForTask,
  keepFront,
  paneOf,
  projectFront,
  withSolo,
  type Front,
} from "./front";
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
    // a bench with a part filling it gives the room to the shells
    expect(frontForTab(projectFront("a", null, null, "app"), tab("2", "a", "panel"))).toEqual(projectFront("a", null, "2", "shell"));
    expect(frontForTab(projectFront("b", null, null, "app"), tab("2", "a", "panel"))).toEqual(projectFront("a", null, "2"));
  });

  test("one part fills a bench, and only its own project's", () => {
    const f = projectFront("a", "dev");
    expect(benchSolo(f, "a")).toBeNull();
    const app = withSolo(f, "a", "app");
    expect(app).toEqual(projectFront("a", "dev", null, "app"));
    expect(benchSolo(app, "a")).toBe("app");
    expect(benchSolo(app, "b")).toBeNull();
    // every part again
    expect(withSolo(app, "a", null)).toEqual(f);
    // no change is the same front, and another project or the strip is left alone
    expect(withSolo(app, "a", "app")).toBe(app);
    expect(withSolo(f, "b", "app")).toBe(f);
    const strip: Front = { kind: "strip" };
    expect(withSolo(strip, "a", "app")).toBe(strip);
    expect(withSolo(null, "a", "app")).toBeNull();
    // a tasks section going keeps the part
    expect(clearTask(app, "a")).toEqual(projectFront("a", null, null, "app"));
  });

  test("a task asked for in a filled bench takes the room for its log", () => {
    expect(frontForTask(projectFront("a", "dev", "t1", "files"), "a", "test")).toEqual(projectFront("a", "test", null, "log"));
    expect(frontForTask(projectFront("a", "dev"), "a", "test")).toEqual(projectFront("a", "test"));
    expect(frontForTask(projectFront("b", "dev", null, "log"), "a", "test")).toEqual(projectFront("a", "test"));
    expect(frontForTask(null, "a", null)).toEqual(projectFront("a"));
  });

  test("a section's part of the bench", () => {
    expect(paneOf("preview")).toBe("app");
    expect(paneOf("tasks")).toBe("log");
    expect(paneOf("shell")).toBe("shell");
    expect(paneOf("changes")).toBe("files");
    expect(paneOf("history")).toBe("files");
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

describe("the bench's seams", () => {
  test("a saved rail is clamped and rounded, anything else the default", () => {
    expect(benchRailOf(512.6)).toBe(513);
    expect(benchRailOf(10)).toBe(240);
    expect(benchRailOf(1e6)).toBe(1600);
    expect(benchRailOf("400")).toBeNull();
    expect(benchRailOf(null)).toBeNull();
    expect(benchRailOf(Number.NaN)).toBeNull();
  });
  test("a saved share is clamped to its bounds", () => {
    expect(shareOf(0.5, BENCH_DOCK)).toBe(0.5);
    expect(shareOf(0.01, BENCH_DOCK)).toBe(BENCH_DOCK.min);
    expect(shareOf(2, BENCH_SPLIT)).toBe(BENCH_SPLIT.max);
    expect(shareOf(0.33333, BENCH_SPLIT)).toBe(0.333);
    expect(shareOf(undefined, BENCH_SPLIT)).toBe(BENCH_SPLIT.initial);
  });
  test("the rail follows the pointer and leaves the main part its room", () => {
    expect(railAt(512, 12, 1600)).toBe(500);
    expect(railAt(0, 12, 1600)).toBe(240);
    expect(railAt(1590, 12, 1600)).toBe(1280);
    // a bench too narrow for both still gives the rail its floor
    expect(railAt(400, 0, 400)).toBe(240);
  });
  test("the shells' share is what lies below the pointer", () => {
    expect(dockAt(600, 1000, 1000)).toBe(0.4);
    expect(dockAt(990, 1000, 1000)).toBe(BENCH_DOCK.min);
    expect(dockAt(0, 1000, 1000)).toBe(BENCH_DOCK.max);
    expect(dockAt(10, 10, 0)).toBe(BENCH_DOCK.initial);
  });
  test("the log's share is what lies right of the pointer", () => {
    expect(splitAt(700, 400, 1400)).toBe(0.7);
    expect(splitAt(1390, 400, 1400)).toBe(BENCH_SPLIT.min);
    expect(splitAt(10, 400, 1400)).toBe(BENCH_SPLIT.max);
    expect(splitAt(5, 400, 400)).toBe(BENCH_SPLIT.initial);
  });
});
