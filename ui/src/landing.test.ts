import { describe, expect, test } from "bun:test";
import { advance, enqueue } from "../../src/core/landing";
import { touchedOf, type Collision } from "../../src/core/touch";
import type { LandEntry, LandingInfo, LandingRun, LandNotice, PrWatch, Run, RunReview } from "../../src/core/types";
import { approveFiles, backLine, branchByDefault, chipWords, landAllOf, mergeLanding, needsApproval, noticeLine, openedRow, OVERLAP_WORD, overlapChip, repoLanding, runOverlaps, type OpenedRun, runLanding, scenarioLine, scenarioTone, verdictTone, verdictWord } from "./landing";

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

  test("a run a restart stopped stays out of ready, whole or not", () => {
    const l = repoLanding(info([rec("a", { state: "stopped", whole: { ok: true } }), rec("b", { state: "stopped", whole: { ok: false, why: "changes left uncommitted" } }), rec("c")]), "canopy");
    expect(l.ready.map((r) => r.id)).toEqual(["c"]);
    expect(l.other.map((r) => r.id).sort()).toEqual(["a", "b"]);
  });

  test("a branch that opened a PR is neither ready nor the rest, in any state", () => {
    const l = repoLanding(info([rec("a", { pr: 12 }), rec("b", { state: "stopped", pr: 13 }), rec("c")]), "canopy");
    expect(l.ready.map((r) => r.id)).toEqual(["c"]);
    expect(l.other).toEqual([]);
    expect(l.opened.map((r) => r.id)).toEqual(["a", "b"]);
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
    expect(runLanding(run("a"), info([rec("a")]))).toEqual({ word: "ready to land", canLand: true, canFix: false, canPr: true });
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

  test("a run that opened a PR neither lands nor opens another; a stopped one opens none", () => {
    expect(runLanding(run("a"), info([rec("a", { pr: 12 })]))).toEqual({ word: "PR #12", canLand: false, canFix: false, canPr: false });
    expect(runLanding(run("a"), info([rec("a", { state: "stopped", whole: { ok: true } })]))).toMatchObject({ canLand: true, canPr: false });
  });

  test("propose starts on a branch by default, a workspace run never", () => {
    expect(branchByDefault("propose")).toBe(true);
    expect(branchByDefault("propose", "ws")).toBe(false);
    expect(branchByDefault("ask")).toBe(false);
  });
});

const sorted = (verdict: RunReview["verdict"], files: RunReview["files"] = [], over: Partial<RunReview> = {}): RunReview => ({ verdict, files, base: "b0", head: "h1", at: 1, ...over });

test("overlap chips: an entry's mark and a run's live collisions; the notice line; merged across backends", () => {
  expect(overlapChip("run/x-b", ["a.ts", "b.ts"])).toEqual({ text: "⚠ overlaps run/x-b", title: "Both touch 2 files; the queue rebases and reports a conflict if it finds one. Nothing is held" });
  expect(overlapChip("x", ["a.ts"]).title.startsWith("Both touch 1 file;")).toBe(true);
  const c: Collision = { id: "r-a+r-b", repoId: "canopy", run: "r-a", name: "run/x-a", with: { kind: "run", run: "r-b", verb: "Ask", name: "run/x-b" }, paths: ["a.ts"], at: 1 };
  const landing: LandingInfo = { runs: [rec("a")], entries: [], orphans: [], collisions: [c] };
  expect(runOverlaps(landing, "r-a")).toEqual([c]);
  expect(runOverlaps(landing, "r-b")).toEqual([]);
  expect(runLanding(run("a"), landing)?.overlaps).toEqual([{ name: "run/x-b", paths: ["a.ts"] }]);
  expect(runLanding(run("b"), landing)?.overlaps).toBeUndefined();
  const working = [touchedOf({ id: "w", verb: "Ask", steps: [{ id: "1", at: 1, kind: "tool", tool: { name: "Edit", title: "", status: "ok", paths: ["q.ts"] } }] })];
  const entries = enqueue([], rec("q", { review: sorted("land", [{ path: "q.ts", cls: "logic" }]) }), 1, undefined, working);
  expect(runLanding(run("q"), { ...landing, entries })?.overlaps).toEqual([{ name: "Ask run w", paths: ["q.ts"] }]);
  expect(noticeLine({ id: "n", entry: "a", repoId: "canopy", branch: "run/x-a", note: "", kind: "collision", why: "run/x-a and run/x-b both edit a.ts", at: 1 })).toBe("run/x-a and run/x-b both edit a.ts");
  expect(mergeLanding({ mac: landing, mini: { runs: [], entries: [], orphans: [], collisions: [{ ...c, id: "m" }] } }).collisions?.map((collision) => collision.id)).toEqual(["r-a+r-b", "m"]);
  expect(OVERLAP_WORD).toBe("⚠ overlaps");
});

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

  test("a run a restart stopped lands once its work is whole, or says why not", () => {
    const stoppedBranch = { ...run("s").branch!, state: "stopped" as const };
    for (const [branch, status] of [[stoppedBranch, "done"], [{ ...stoppedBranch, state: "working" as const }, "working"]] as const) {
      const l = runLanding(run("s", { status, branch }), info([rec("s", { state: "stopped", whole: { ok: true }, review: sorted("land") })]))!;
      expect(l).toMatchObject({ word: "stopped by a restart", canLand: true, stopped: true, verdict: "needs your land", approve: false });
      expect(l.why).toBeUndefined();
    }
    const dirty = runLanding(run("s", { status: "done", branch: stoppedBranch }), info([rec("s", { state: "stopped", whole: { ok: false, why: "changes left uncommitted" } })]))!;
    expect(dirty).toMatchObject({ word: "stopped by a restart", canLand: false, why: "changes left uncommitted" });
    expect(dirty.stopped).toBeUndefined();
  });

  test("notices: one line each, merged newest first across backends", () => {
    const n = (id: string, at: number, over: Partial<LandNotice> = {}): LandNotice => ({ id, entry: "e", repoId: "canopy", branch: "run/x-e", note: "", kind: "landed", at, ...over });
    expect(noticeLine(n("a", 1, { head: "abcdef1234" }))).toBe("run/x-e landed on its own at abcdef1");
    expect(noticeLine(n("b", 1, { kind: "held", why: "after the rebase it needs your land" }))).toBe("run/x-e held back: after the rebase it needs your land");
    const merged = mergeLanding({ mini: { ...info([]), notices: [n("m1", 1)] }, mac: { ...info([]), notices: [n("c1", 5)] } });
    expect(merged.notices?.map((x) => x.id)).toEqual(["c1", "m1"]);
  });
});

describe("a branch that opened a PR, in the landing section", () => {
  const opened = (id: string, over: Partial<LandingRun> = {}): OpenedRun => ({ ...rec(id, over), pr: 12 });
  const watch = (id: string, over: Partial<PrWatch> = {}): PrWatch => ({ id, repoId: "canopy", number: 12, url: "https://github.com/o/canopy/pull/12", ...over }) as PrWatch;

  test("watched: PR #n linking to it, and no land or drop, since the watch keeps its worktree", () => {
    expect(openedRow(opened("a"), [watch("a")])).toEqual({ word: "PR #12", url: "https://github.com/o/canopy/pull/12", canDrop: false });
  });

  test("watched but swept, or read closed or merged: drop as the server allows it, still linking to the PR", () => {
    const url = "https://github.com/o/canopy/pull/12";
    expect(openedRow(opened("a"), [watch("a", { swept: 5 })])).toEqual({ word: "PR #12", url, canDrop: true });
    for (const status of ["closed", "merged"] as const) {
      expect(openedRow(opened("a"), [watch("a", { state: { status } as PrWatch["state"] })]).canDrop).toBe(true);
    }
    expect(openedRow(opened("a", { state: "working" }), [watch("a", { swept: 5 })]).canDrop).toBe(false);
  });

  test("no watch (dropped 30 days after a sweep closed it): PR #n with drop, never land", () => {
    expect(openedRow(opened("a"), [watch("b"), watch("a", { repoId: "other" })])).toEqual({ word: "PR #12", canDrop: true });
  });

  test("no drop while a run on the branch is still working", () => {
    expect(openedRow(opened("a", { state: "working" }), []).canDrop).toBe(false);
  });
});

test("scenarioLine and scenarioTone", () => {
  expect(scenarioLine({ total: 8, passed: 7, score: 0.875 })).toBe("scenarios 7/8 · 0.88");
  expect(scenarioLine({ total: 2, passed: 2, score: 1 })).toBe("scenarios 2/2 · 1.00");
  expect(scenarioTone({ total: 8, passed: 7 })).toBe("rust");
  expect(scenarioTone({ total: 2, passed: 2 })).toBe("moss");
});

test("runLanding carries the record's scenarios for a queued entry and a ready run", () => {
  const pass = { head: "h", at: 1, total: 1, passed: 1, score: 1, results: [] };
  const r = rec("a", { scenarios: pass });
  const entries = enqueue([], r, 1);
  const branchRun = run("a");
  expect(runLanding(branchRun, { runs: [r], entries, orphans: [] })?.scenarios).toEqual(pass);
  expect(runLanding(branchRun, { runs: [r], entries: [], orphans: [] })?.scenarios).toEqual(pass);
});
