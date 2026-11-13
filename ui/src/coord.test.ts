import { describe, expect, test } from "bun:test";
import type { CoordTask, LandingInfo, PrWatch, Run, RunStep } from "../../src/core/types";
import { canStartCards, cardCarries, cardCounts, cardDraft, cardEdit, cardStatus, chainWords, childLine, coordTurn, coordView, isCoordinator, parentCard, parseAfter, stepLine } from "./coord";

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

describe("who started a run's child (FR-038)", () => {
  test("the chain reads up to the coordinator or the run above", () => {
    expect(chainWords({ parent: "3f2a9c" })).toBe("started by run 3f2a");
    expect(chainWords({ parent: "mac|3f2a9c" }, { parent: undefined })).toBe("started by run 3f2a");
    expect(chainWords({ parent: "3f2a9c" }, { parent: "k1", depth: undefined })).toBe("started by run 3f2a, which the coordinator started");
    expect(chainWords({ parent: "3f2a9c" }, { parent: "9b1e00", depth: 1 })).toBe("started by run 3f2a, which run 9b1e started");
    expect(chainWords({ parent: undefined })).toBe("");
  });
});

describe("the view a phone opens a coordinator on", () => {
  const coord = (status: Run["status"], tasks: CoordTask[]) => run("c1", { action: "coordinate", chat: true, status, tasks });

  test("the chat while there are no cards or a question waits", () => {
    expect(coordView(coord("idle", []))).toBe("chat");
    expect(coordView(run("c1", { action: "coordinate", status: "idle" }))).toBe("chat");
    expect(coordView(coord("waiting", [card()]))).toBe("chat");
  });

  test("the cards while any waits for start these, even mid-turn", () => {
    expect(coordView(coord("working", [card({ state: "done" }), card({ id: "t2" })]))).toBe("cards");
    expect(coordView(coord("idle", [card()]))).toBe("cards");
  });

  test("the chat while it works on cards already started, the cards between turns and once it ended", () => {
    const started = [card({ state: "running", run: "k1" }), card({ id: "t2", state: "failed" })];
    expect(coordView(coord("working", started))).toBe("chat");
    expect(coordView(coord("idle", started))).toBe("cards");
    expect(coordView(coord("done", started))).toBe("cards");
  });
});

describe("a card that started a group", () => {
  const group = { id: "g", repoId: "repo", repoPath: "/r", action: "ask", note: "n", expectedMembers: 3, members: [], state: "reviewing", autoLand: false, startedAt: 1 } as const;
  const running: CoordTask = { id: "t1", title: "t", repo: "repo", note: "n", action: "ask", state: "running", times: 3, group: "g" };
  const none: LandingInfo = { runs: [], entries: [], orphans: [] };
  test("a running card shows the group's word", () => {
    expect(cardStatus(running, undefined, none, [], { ...group, members: [] })).toEqual({ word: "reviewing", tone: "sky", line: "" });
  });
  test("the settled words read as words, not as sentences", () => {
    for (const outcome of ["winner picked", "landed"]) expect(cardStatus({ ...running, state: "done", outcome }, undefined, none, [])).toMatchObject({ word: outcome, tone: "moss", line: "" });
    for (const outcome of ["needs you", "dropped"]) expect(cardStatus({ ...running, state: "failed", outcome }, undefined, none, [])).toMatchObject({ word: outcome, tone: "rust", line: "" });
  });
});

describe("what a card carries, for its facts line", () => {
  test("its loadout, with changed and the overrides in the title when Eric set a field", () => {
    expect(cardCarries(card({ equip: { loadout: "feature" } }))).toEqual({ loadout: { word: "feature", title: "loadout feature" } });
    const changed = cardCarries(card({ equip: { loadout: "feature", model: "sonnet" } })).loadout;
    expect(changed?.word).toBe("feature, changed");
    expect(changed?.title).toBe("loadout feature; model sonnet");
    const all = cardCarries(card({ equip: { loadout: "feature", effort: "high", skills: ["a", "b"], mcp: ["probe"] } })).loadout;
    expect(all?.title).toBe("loadout feature; effort high; skills a, b; servers probe");
    // no skills at all is an override too
    expect(cardCarries(card({ equip: { loadout: "feature", skills: [] } })).loadout).toEqual({ word: "feature, changed", title: "loadout feature; skills none" });
  });
  test("its workflow and the cards it waits for", () => {
    expect(cardCarries(card({ workflow: "review" })).workflow).toBe("review");
    expect(cardCarries(card({ after: ["t1", "t3"] })).after).toBe("after t1, t3");
    expect(cardCarries(card())).toEqual({});
  });
});

describe("what a card's form sends", () => {
  test("nothing while nothing changed, whatever the card carries", () => {
    const t = card({ equip: { loadout: "feature", model: "sonnet" }, workflow: "review", workflowRepo: true, after: ["t2", "t3"] });
    expect(cardEdit(t, cardDraft(t))).toEqual({});
    // the same ids typed another way are no change
    expect(cardEdit(t, { ...cardDraft(t), after: "t2 t3" })).toEqual({});
  });
  test("a new loadout replaces the card's equip; none clears it", () => {
    const t = card({ equip: { loadout: "feature", model: "sonnet" } });
    expect(cardEdit(t, { ...cardDraft(t), loadout: "docs" })).toEqual({ equip: { loadout: "docs" } });
    expect(cardEdit(t, { ...cardDraft(t), loadout: "" })).toEqual({ equip: null });
    expect(cardEdit(card(), { ...cardDraft(card()), loadout: "feature" })).toEqual({ equip: { loadout: "feature" } });
  });
  test("after takes ids split by commas or spaces; empty clears it", () => {
    expect(parseAfter(" t1, t3  t4,,")).toEqual(["t1", "t3", "t4"]);
    expect(parseAfter("  ")).toEqual([]);
    expect(cardEdit(card(), { ...cardDraft(card()), after: "t1, t3" })).toEqual({ after: ["t1", "t3"] });
    const t = card({ after: ["t1"] });
    expect(cardEdit(t, { ...cardDraft(t), after: "" })).toEqual({ after: null });
  });
  test("a workflow names its source: the repo's own says so, none clears it", () => {
    expect(cardEdit(card(), { ...cardDraft(card()), workflow: { name: "review", fromRepo: true } })).toEqual({ workflow: "review", workflowRepo: true });
    expect(cardEdit(card(), { ...cardDraft(card()), workflow: { name: "review", fromRepo: false } })).toEqual({ workflow: "review" });
    const own = card({ workflow: "review", workflowRepo: true });
    expect(cardEdit(own, { ...cardDraft(own), workflow: { name: "review", fromRepo: false } })).toEqual({ workflow: "review" });
    expect(cardEdit(own, { ...cardDraft(own), workflow: null })).toEqual({ workflow: null });
    // a new repo sends the workflow again, so the server checks that repo has it
    expect(cardEdit(own, { ...cardDraft(own), repo: "other" })).toEqual({ repo: "other", workflow: "review", workflowRepo: true });
  });
  test("a queued card sends only its loadout and after", () => {
    const t = card({ state: "queued" });
    const draft = { ...cardDraft(t), title: "another", times: 2, workflow: { name: "review", fromRepo: false }, loadout: "feature", after: "t2" };
    expect(cardEdit(t, draft)).toEqual({ equip: { loadout: "feature" }, after: ["t2"] });
  });
  test("a proposed card's own fields, trimmed, as before", () => {
    const t = card();
    expect(cardEdit(t, { ...cardDraft(t), title: " add the other thing ", times: 3, action: "propose" })).toEqual({ title: "add the other thing", times: 3, action: "propose" });
  });
});
