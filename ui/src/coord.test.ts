import { describe, expect, test } from "bun:test";
import type { CoordTask, LandingInfo, PrWatch, Run, RunStep } from "../../src/core/types";
import { canStartCards, cardCounts, cardStatus, childLine, coordTurn, isCoordinator, parentCard, stepLine } from "./coord";

const run = (id: string, over: Partial<Run> = {}): Run => ({
  id,
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

const card = (over: Partial<CoordTask> = {}): CoordTask => ({
  id: "t1",
  title: "add the thing",
  repo: "canopy",
  note: "do it",
  action: "ask",
  state: "proposed",
  ...over,
});

const step = (kind: RunStep["kind"], text: string, over: Partial<RunStep> = {}): RunStep => ({ id: `s${text}`, at: 1, kind, text, ...over });

const none: LandingInfo = { runs: [], entries: [], orphans: [] };

const watch = (over: Partial<PrWatch> = {}): PrWatch => ({
  id: "c1",
  runId: "c1",
  repoId: "canopy",
  repoPath: "/r",
  branch: "run/x-c1",
  target: "main",
  dir: "/w",
  note: "n",
  slug: "o/r",
  remote: "origin",
  number: 12,
  url: "https://github.com/o/r/pull/12",
  autoFix: false,
  autoMerge: false,
  pushed: "h1",
  attempts: {},
  seenComment: 0,
  openedAt: 1,
  updatedAt: 1,
  ...over,
});

describe("a step on one line", () => {
  test("text keeps its first line without emphasis, a tool its title", () => {
    expect(stepLine(step("text", "\n**Done.** The `gate` passes\nmore below"))).toBe("Done. The gate passes");
    expect(stepLine({ id: "x", at: 1, kind: "tool", tool: { name: "Bash", title: "bun test", status: "ok" } })).toBe("bun test");
    expect(stepLine(step("note", "x".repeat(200)))).toHaveLength(140);
  });
  test("the child's newest main-thread step that says something", () => {
    const steps = [step("text", "first"), step("text", "under an agent", { parent: "a" }), step("text", "  ")];
    expect(childLine({ steps })).toBe("first");
    expect(childLine({ steps: [] })).toBe("");
  });
});

describe("a card's status", () => {
  test("proposed and queued, with why it waits", () => {
    expect(cardStatus(card(), undefined, none, [])).toEqual({ word: "proposed", tone: "lichen", line: "" });
    const waiting = card({ state: "queued", outcome: "waiting for a branch slot in canopy" });
    expect(cardStatus(waiting, undefined, none, [])).toEqual({ word: "queued", tone: "sky", line: "waiting for a branch slot in canopy" });
  });
  test("running shows the child's newest step, and needs you while it waits", () => {
    const child = run("c1", { status: "working", steps: [step("text", "reading the tests")] });
    const t = card({ state: "running", run: "c1" });
    expect(cardStatus(t, child, none, [])).toMatchObject({ word: "running", tone: "sky", line: "reading the tests" });
    expect(cardStatus(t, { ...child, status: "waiting" }, none, []).word).toBe("needs you");
  });
  test("a running card whose child ended shows its landing word or its PR", () => {
    const child = run("c1", { status: "done", steps: [step("text", "all done")] });
    const t = card({ state: "running", run: "c1" });
    expect(cardStatus(t, child, none, []).word).toBe("ready to land");
    const pr = watch();
    expect(cardStatus(t, child, none, [pr])).toMatchObject({ word: "PR #12, not read yet", pr });
  });
  test("settled cards say their outcome; a sentence goes under the card", () => {
    expect(cardStatus(card({ state: "done", outcome: "landed" }), undefined, none, [])).toEqual({ word: "landed", tone: "moss", line: "" });
    expect(cardStatus(card({ state: "failed", outcome: "sent back" }), undefined, none, [])).toMatchObject({ word: "sent back", tone: "rust" });
    expect(cardStatus(card({ state: "failed", outcome: "its run is no longer kept" }), undefined, none, [])).toEqual({
      word: "failed",
      tone: "rust",
      line: "its run is no longer kept",
    });
    expect(cardStatus(card({ state: "dropped" }), undefined, none, [])).toEqual({ word: "dropped", tone: "faint", line: "" });
  });
});

describe("the coordinator's run", () => {
  test("start these only while it is going and a card is proposed", () => {
    const coord = run("k", { action: "coordinate", status: "idle", chat: true, tasks: [card(), card({ id: "t2", state: "queued" })] });
    expect(isCoordinator(coord)).toBe(true);
    expect(canStartCards(coord)).toBe(true);
    expect(canStartCards({ ...coord, status: "stopped" })).toBe(false);
    expect(canStartCards({ ...coord, tasks: [card({ state: "running" })] })).toBe(false);
  });
  test("its turn is the user's only while cards wait for start these", () => {
    const coord = run("k", { action: "coordinate", status: "idle", chat: true, tasks: [card(), card({ id: "t2" }), card({ id: "t3", state: "running" })] });
    expect(coordTurn(coord)).toBe("2 cards wait for start these");
    expect(coordTurn({ ...coord, tasks: [card()] })).toBe("1 card waits for start these");
    expect(coordTurn({ ...coord, tasks: [card({ state: "running" })] })).toBeNull();
    expect(coordTurn({ ...coord, tasks: undefined })).toBeNull();
  });
  test("a child finds its card, and the counts read in order", () => {
    const tasks = [card(), card({ id: "t2", state: "running", run: "c2" }), card({ id: "t3", state: "running", run: "c3" })];
    expect(parentCard({ tasks }, "c3")?.id).toBe("t3");
    expect(parentCard(undefined, "c3")).toBeUndefined();
    expect(cardCounts(tasks)).toBe("3 cards · 1 proposed, 2 running");
    expect(cardCounts([])).toBe("0 cards");
  });
});
