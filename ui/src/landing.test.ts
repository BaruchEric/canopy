import { describe, expect, test } from "bun:test";
import { advance, enqueue } from "../../src/core/landing";
import type { LandEntry, LandingInfo, LandingRun, LandNotice, Run, RunReview } from "../../src/core/types";
import { approveFiles, backLine, branchByDefault, chipWords, landAllOf, mergeLanding, needsApproval, noticeLine, repoLanding, runLanding, verdictTone, verdictWord } from "./landing";

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

const sorted = (verdict: RunReview["verdict"], files: RunReview["files"] = [], over: Partial<RunReview> = {}): RunReview => ({ verdict, files, base: "b0", head: "h1", at: 1, ...over });

describe("review rules in the page", () => {
  test("a ready run's verdict, its tone, and whether land opens the approve sheet", () => {
    expect([verdictWord(rec("a")), needsApproval(rec("a"))]).toEqual(["sorting", false]);
    const auto = rec("b", { review: sorted("auto") });
    expect([verdictWord(auto), verdictTone(auto), needsApproval(auto)]).toEqual(["lands on its own", "moss", false]);
    const land = rec("c", { review: sorted("land", [], { why: "no review rules" }) });
    expect([verdictWord(land), verdictTone(land)]).toEqual(["needs your land: no review rules", "lichen"]);
    const look = rec("d", { review: sorted("approve", [{ path: "s", cls: "docs", sensitive: "x" }]) });
    expect([verdictWord(look), verdictTone(look), needsApproval(look)]).toEqual(["needs your approval: 1 sensitive file", "rust", true]);
  });

  test("the approve sheet lists the sensitive files first, or every file when the rules are broken", () => {
    const doc: RunReview["files"][number] = { path: "a.md", cls: "docs" };
    const touchy: RunReview["files"][number] = { path: "s.ts", cls: "logic", sensitive: "x" };
    expect(approveFiles(rec("a", { review: sorted("approve", [doc, touchy]) }))).toEqual({ look: [touchy], rest: [doc] });
    expect(approveFiles(rec("a", { review: sorted("approve", [doc], { why: "bad" }) }))).toEqual({ look: [doc], rest: [] });
  });

  test("land all takes what needs no approval", () => {
    const l = landAllOf(info([rec("a", { review: sorted("land") }), rec("b", { review: sorted("approve") }), rec("c")]), "canopy");
    expect([l.take.map((r) => r.id), l.skip.map((r) => r.id)]).toEqual([["a", "c"], ["b"]]);
  });

  test("a run sheet's land knows its verdict", () => {
    const r = runLanding(run("a"), info([rec("a", { review: sorted("approve", [{ path: "s", cls: "docs", sensitive: "x" }]) })]))!;
    expect([r.canLand, r.verdict, r.approve]).toEqual([true, "needs your approval: 1 sensitive file", true]);
    expect(runLanding(run("b"), info([rec("b")]))).toMatchObject({ canLand: true });
    expect(runLanding(run("b"), info([rec("b")]))?.verdict).toBeUndefined();
  });

  test("notices: one line each, merged newest first across backends", () => {
    const n = (id: string, at: number, over: Partial<LandNotice> = {}): LandNotice => ({ id, entry: "e", repoId: "canopy", branch: "run/x-e", note: "", kind: "landed", at, ...over });
    expect(noticeLine(n("a", 1, { head: "abcdef1234" }))).toBe("run/x-e landed on its own at abcdef1");
    expect(noticeLine(n("b", 1, { kind: "held", why: "after the rebase it needs your land" }))).toBe("run/x-e held back: after the rebase it needs your land");
    const merged = mergeLanding({ mini: { ...info([]), notices: [n("m1", 1)] }, mac: { ...info([]), notices: [n("c1", 5)] } });
    expect(merged.notices?.map((x) => x.id)).toEqual(["c1", "m1"]);
  });
});
