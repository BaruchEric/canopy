import { describe, expect, test } from "bun:test";
import { advance, enqueue } from "../../src/core/landing";
import type { LandEntry, LandingInfo, LandingRun, Run } from "../../src/core/types";
import { backLine, branchByDefault, chipWords, mergeLanding, repoLanding, runLanding } from "./landing";

const rec = (id: string, over: Partial<LandingRun> = {}): LandingRun => ({
  id,
  runId: `r-${id}`,
  repoId: "canopy",
  repoPath: "/r/canopy",
  branch: `run/x-${id}`,
  target: "main",
  base: "b0",
  dir: `/w/${id}`,
  note: "n",
  verb: "Ask",
  harness: "claude",
  state: "ready",
  startedAt: 1,
  ...over,
});

const run = (id: string, over: Partial<Run> = {}): Run => ({
  id: `r-${id}`,
  repoId: "canopy",
  action: "ask",
  verb: "Ask",
  progress: "working",
  expectsChange: true,
  chat: false,
  harness: "claude",
  note: "n",
  status: "done",
  startedAt: 1,
  steps: [],
  prompt: null,
  branch: { name: `run/x-${id}`, target: "main", base: "b0", dir: `/w/${id}`, state: "ready", origin: id },
  ...over,
});

const info = (runs: LandingRun[], entries: LandEntry[] = []): LandingInfo => ({ runs, entries, orphans: [] });

describe("a repo's landing", () => {
  test("queue, sent back, landed, ready and the rest", () => {
    let entries: LandEntry[] = [];
    for (const id of ["a", "b", "c", "d"]) entries = enqueue(entries, rec(id), entries.length);
    entries = entries.map((e) =>
      e.id === "b" ? advance(e, { t: "red", gate: "test", output: "x" }, 5)
      : e.id === "c" ? advance(e, { t: "landed", head: "h" }, 6)
      : e,
    );
    const l = repoLanding(info([rec("a"), rec("e"), rec("f", { state: "working" }), rec("z", { repoId: "other" })], entries), "canopy");
    expect(l.queue.map((e) => e.id)).toEqual(["a", "d"]);
    expect(l.back.map((e) => e.id)).toEqual(["b"]);
    expect(l.landed.map((e) => e.id)).toEqual(["c"]);
    expect(l.ready.map((r) => r.id)).toEqual(["e"]);
    expect(l.other.map((r) => r.id)).toEqual(["f"]);
    expect(backLine(l.back[0]!)).toBe("test failed");
  });

  test("two backends' queues read as one", () => {
    const m = mergeLanding({ home: info([rec("a")]), mini: info([rec("mini:b")]) });
    expect(m.runs.map((r) => r.id)).toEqual(["a", "mini:b"]);
  });
});

describe("the card chip", () => {
  test("nothing, queued, sent back", () => {
    expect(chipWords(info([]), "canopy")).toBeNull();
    let entries = enqueue([], rec("a"), 1);
    expect(chipWords(info([], entries), "canopy")).toMatchObject({ text: "1 queued", tone: "queued" });
    entries = enqueue(entries, rec("b"), 2).map((e) => (e.id === "b" ? advance(e, { t: "conflict", files: ["f"] }, 3) : e));
    expect(chipWords(info([], entries), "canopy")).toMatchObject({ text: "1 queued · 1 sent back", tone: "back" });
  });
});

describe("a run's word and buttons", () => {
  test("a ready run that ended can land", () => {
    expect(runLanding(run("a"), info([rec("a")]))).toEqual({ word: "ready to land", canLand: true, canFix: false });
    expect(runLanding(run("a", { status: "working", branch: { ...run("a").branch!, state: "working" } }), info([rec("a", { state: "working" })]))?.canLand).toBe(false);
    expect(runLanding(run("a", { branch: undefined }), info([]))).toBeNull();
  });

  test("queued, then sent back with fix it, then a fix going", () => {
    let entries = enqueue(enqueue([], rec("z"), 0), rec("a"), 1);
    expect(runLanding(run("a"), info([rec("a")], entries))).toMatchObject({ word: "queued 2nd", canLand: false, canFix: false });
    entries = entries.map((e) => (e.id === "a" ? advance(e, { t: "conflict", files: ["f"] }, 2) : e));
    expect(runLanding(run("a"), info([rec("a")], entries))).toMatchObject({ word: "conflict", canFix: true });
    entries = entries.map((e) => (e.id === "a" ? { ...e, fixing: "r-fix" } : e));
    expect(runLanding(run("a"), info([rec("a")], entries))).toMatchObject({ word: "conflict, a fix is going", canFix: false });
  });

  test("propose starts on a branch by default, a workspace run never", () => {
    expect(branchByDefault("propose")).toBe(true);
    expect(branchByDefault("propose", "ws")).toBe(false);
    expect(branchByDefault("ask")).toBe(false);
  });
});
