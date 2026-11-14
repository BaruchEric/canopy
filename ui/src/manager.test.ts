import { describe, expect, test } from "bun:test";
import type { BranchTree, BranchTreesInfo, CoordTask, Flow, FlowStep, LandEntry, LandingInfo, LandingRun, Loadout, PrWatch, Run, RunBranch, RunPrompt, RunReview, RunStep } from "../../src/core/types";
import type { RunGroup } from "../../src/core/group";
import type { Repo } from "../../src/core/types";
import { chatAim, liveCoordinators, managerRows, sayTarget, waves, type Lane, type ManagerInputs } from "./manager";

// a run's branch id is b-<run id>, so a test that mixes up a run's id and
// its branch's finds nothing
const br = (id: string, over: Partial<RunBranch> = {}): RunBranch => ({ name: `run/x-${id}`, target: "main", base: "b0", dir: `/w/${id}`, state: "ready", origin: `b-${id}`, ...over });

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
  branch: br(id),
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

/** a card whose child is run `id` on branch b-<id> */
const child = (id: string, over: Partial<CoordTask> = {}): CoordTask => card({ id: "t1", state: "running", run: id, branch: `b-${id}`, ...over });

const coord = (tasks: CoordTask[], over: Partial<Run> = {}): Run =>
  run("k", { action: "coordinate", verb: "Coordinate", chat: true, status: "idle", branch: undefined, note: "the goal as noted", startedAt: 100, tasks, ...over });

const step = (kind: RunStep["kind"], text: string, at: number): RunStep => ({ id: `s${at}`, at, kind, text });

const rec = (id: string, over: Partial<LandingRun> = {}): LandingRun => ({
  id,
  runId: id.replace(/^b-/, ""),
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

const entry = (id: string, state: LandEntry["state"], over: Partial<LandEntry> = {}): LandEntry => ({
  id,
  repoId: "canopy",
  repoPath: "/r/canopy",
  branch: `run/x-${id}`,
  target: "main",
  dir: `/w/${id}`,
  note: "n",
  state,
  tries: 0,
  queuedAt: 1,
  updatedAt: 60,
  ...over,
});

const review = (verdict: RunReview["verdict"]): RunReview => ({ verdict, files: [], base: "b0", head: "h1", at: 40 });

const fstep = (name: string, status: FlowStep["status"], over: Partial<FlowStep> = {}): FlowStep => ({ name, status, ...over });

const flow = (id: string, steps: FlowStep[], over: Partial<Flow> = {}): Flow => ({
  id,
  repoId: "canopy",
  workflow: "ship",
  verb: "ship",
  note: "n",
  status: "working",
  steps,
  current: 0,
  startedAt: 5,
  branch: br(id, { state: "working" }),
  ...over,
});

const watch = (over: Partial<PrWatch> = {}): PrWatch => ({
  id: "b-c1",
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

const loadout = (over: Partial<Loadout> = {}): Loadout => ({
  name: "feature",
  note: "",
  harness: "claude",
  model: "opus",
  effort: "high",
  skills: ["a", "b", "c"],
  mcp: ["probe"],
  canopyTools: false,
  ...over,
});

const none: LandingInfo = { runs: [], entries: [], orphans: [] };
const landing = (runs: LandingRun[], entries: LandEntry[] = []): LandingInfo => ({ runs, entries, orphans: [] });
const runsOf = (...rs: Run[]): Record<string, Run> => Object.fromEntries(rs.map((r) => [r.id, r]));
const flowsOf = (...fs: Flow[]): Record<string, Flow> => Object.fromEntries(fs.map((f) => [f.id, f]));
const at = (over: Partial<ManagerInputs> = {}): ManagerInputs => ({ runs: {}, flows: {}, landing: none, prs: [], loadouts: [], ...over });

const question: RunPrompt = { id: "p1", kind: "question", questions: [{ question: "Which file?", header: "file", options: [], multiSelect: false }] };

describe("the rings", () => {
  test("the manager's ring comes first, one arc per card in card order, each the card's tone", () => {
    const tasks = [
      card({ id: "t1" }),
      card({ id: "t2", state: "queued" }),
      child("c3", { id: "t3" }),
      card({ id: "t4", state: "done", outcome: "landed" }),
      card({ id: "t5", state: "failed", outcome: "sent back" }),
      card({ id: "t6", state: "dropped" }),
    ];
    const rows = managerRows(coord(tasks), at({ runs: runsOf(run("c3", { status: "working" })) }));
    const manager = rows.rings[0];
    expect(manager?.id).toBe("manager");
    expect(manager?.repo).toBeNull();
    expect(manager?.arcs).toEqual([
      { label: "t1", tone: "lichen" },
      { label: "t2", tone: "hair" },
      { label: "t3", tone: "sky" },
      { label: "t4", tone: "moss" },
      { label: "t5", tone: "rust" },
      { label: "t6", tone: "rust" },
    ]);
    expect(rows.rings.slice(1).map((r) => [r.id, r.tone])).toEqual(manager?.arcs.map((a) => [a.label, a.tone]) ?? []);
  });

  test("a card that waits on Eric reads lichen, whatever its state", () => {
    const c1 = run("c1");
    const ready = child("c1", { state: "done", outcome: "ready" });
    const rows = managerRows(coord([ready]), at({ runs: runsOf(c1), landing: landing([rec("b-c1", { review: review("land") })]) }));
    expect(rows.rings[0]?.arcs).toEqual([{ label: "t1", tone: "lichen" }]);
    expect(rows.rings[1]?.word).toBe("ready");
  });

  test("a card with a flow has one arc per workflow step, toned by the step, and the step in hand", () => {
    const f = flow("f1", [fstep("Gates", "passed"), fstep("Docs", "running"), fstep("Commit", "pending")], { current: 1 });
    const rows = managerRows(coord([card({ state: "running", flow: "f1", branch: "b-f1" })]), at({ flows: flowsOf(f) }));
    const ring = rows.rings[1];
    expect(ring?.arcs).toEqual([
      { label: "Gates", tone: "moss" },
      { label: "Docs", tone: "sky" },
      { label: "Commit", tone: "hair" },
    ]);
    expect(ring?.at).toBe("2/3");
    const every = flow("f2", [
      fstep("a", "running"),
      fstep("b", "checking"),
      fstep("c", "gated"),
      fstep("d", "held"),
      fstep("e", "passed"),
      fstep("f", "failed"),
      fstep("g", "pending"),
      fstep("h", "skipped"),
    ]);
    const tones = managerRows(coord([card({ state: "running", flow: "f2" })]), at({ flows: flowsOf(every) })).rings[1]?.arcs.map((a) => a.tone);
    expect(tones).toEqual(["sky", "sky", "lichen", "lichen", "moss", "rust", "hair", "hair"]);
  });

  test("a plain run's arcs are its lifecycle: plan only for propose, then build and land", () => {
    const arcs = (task: CoordTask, r?: Run, info: LandingInfo = none) =>
      managerRows(coord([task]), at({ runs: r ? runsOf(r) : {}, landing: info })).rings[1];
    const working = run("c1", { status: "working", branch: br("c1", { state: "working" }) });
    expect(arcs(child("c1"), working)?.arcs).toEqual([
      { label: "build", tone: "sky" },
      { label: "land", tone: "hair" },
    ]);
    expect(arcs(child("c1"), working)?.at).toBe("1/2");
    // a propose plans first: build waits until the plan is approved
    const planning = { ...working, action: "propose" };
    const propose = child("c1", { action: "propose" });
    expect(arcs(propose, planning)?.arcs.map((a) => [a.label, a.tone])).toEqual([["plan", "sky"], ["build", "hair"], ["land", "hair"]]);
    expect(arcs(propose, { ...planning, status: "waiting", proposalState: "waiting" })?.arcs[0]?.tone).toBe("lichen");
    const building = arcs(propose, { ...planning, proposalState: "approved" });
    expect(building?.arcs.map((a) => a.tone)).toEqual(["moss", "sky", "hair"]);
    expect(building?.at).toBe("2/3");
    expect(arcs(propose, { ...planning, status: "done", proposalState: "turned down", branch: br("c1", { state: "nothing" }) })?.arcs[0]?.tone).toBe("rust");
    // a card not started has every arc to come and no step in hand
    expect(arcs(card({ action: "propose" }))?.arcs.map((a) => a.tone)).toEqual(["hair", "hair", "hair"]);
    expect(arcs(card())?.at).toBeNull();
  });

  test("build is sky while the run works, moss once it settled ready, rust when it failed or stopped", () => {
    const build = (r: Run) => managerRows(coord([child("c1", { state: r.status === "working" ? "running" : "done" })]), at({ runs: runsOf(r) })).rings[1]?.arcs[0]?.tone;
    expect(build(run("c1", { status: "working" }))).toBe("sky");
    expect(build(run("c1"))).toBe("moss");
    expect(build(run("c1", { status: "failed" }))).toBe("rust");
    expect(build(run("c1", { status: "stopped", branch: br("c1", { state: "stopped" }) }))).toBe("rust");
  });

  test("land is hair until ready, lichen while it waits on Eric, sky in flight, moss once landed, rust once dropped", () => {
    const land = (task: CoordTask, r: Run | undefined, info: LandingInfo) => managerRows(coord([task]), at({ runs: r ? runsOf(r) : {}, landing: info })).rings[1]?.arcs[1]?.tone;
    const done = child("c1", { state: "done", outcome: "ready" });
    const working = run("c1", { status: "working", branch: br("c1", { state: "working" }) });
    expect(land(child("c1"), working, none)).toBe("hair");
    expect(land(done, run("c1"), landing([rec("b-c1", { review: review("land") })]))).toBe("lichen");
    expect(land(done, run("c1"), landing([rec("b-c1", { review: review("approve") })]))).toBe("lichen");
    expect(land(child("c1"), run("c1"), landing([rec("b-c1")], [entry("b-c1", "queued")]))).toBe("sky");
    expect(land(child("c1"), run("c1"), landing([rec("b-c1")], [entry("b-c1", "gate", { gate: "test" })]))).toBe("sky");
    expect(land(child("c1", { state: "failed", outcome: "sent back" }), run("c1"), landing([rec("b-c1")], [entry("b-c1", "red")]))).toBe("lichen");
    expect(land(child("c1"), run("c1"), landing([rec("b-c1")], [entry("b-c1", "judge")]))).toBe("lichen");
    expect(land(child("c1", { state: "done", outcome: "landed" }), run("c1"), landing([], [entry("b-c1", "landed")]))).toBe("moss");
    // a landed card whose entry the queue no longer keeps
    expect(land(child("c1", { state: "done", outcome: "landed" }), undefined, none)).toBe("moss");
    expect(land(child("c1", { state: "dropped", outcome: "dropped" }), run("c1"), none)).toBe("rust");
  });
});

describe("waves", () => {
  test("a card with no after, or an after naming no card here, is wave 0; else one past the highest it names", () => {
    const w = waves([
      card({ id: "t1" }),
      card({ id: "t2", after: ["t9"] }),
      card({ id: "t3", after: ["t1"] }),
      card({ id: "t4", after: ["t1", "t3"] }),
      card({ id: "t5", after: ["t2", "t9"] }),
    ]);
    expect([...w.entries()]).toEqual([
      ["t1", 0],
      ["t2", 0],
      ["t3", 1],
      ["t4", 2],
      ["t5", 1],
    ]);
  });

  test("a cycle does not loop, and stays within the card count", () => {
    const tasks = [card({ id: "t1", after: ["t2"] }), card({ id: "t2", after: ["t1"] }), card({ id: "t3", after: ["t1"] }), card({ id: "t4", after: ["t4"] })];
    const w = waves(tasks);
    for (const t of tasks) {
      const n = w.get(t.id);
      expect(n).toBeDefined();
      expect(n ?? 99).toBeLessThanOrEqual(tasks.length);
    }
    expect(w.get("t3")).toBe((w.get("t1") ?? 0) + 1);
  });

  test("a queued card after t1 sits in wave 1", () => {
    const rows = managerRows(coord([child("c1"), card({ id: "t2", state: "queued", after: ["t1"] })]), at({ runs: runsOf(run("c1", { status: "working" })) }));
    expect(rows.rings.map((r) => [r.id, r.wave])).toEqual([
      ["manager", 0],
      ["t1", 0],
      ["t2", 1],
    ]);
  });
});

describe("needs you", () => {
  test("a prompt on a card's run, since its newest step", () => {
    const c1 = run("c1", { status: "waiting", prompt: question, steps: [step("text", "reading", 20), step("tool", "edit", 30)] });
    const rows = managerRows(coord([child("c1", { repo: "mini|homelab" })]), at({ runs: runsOf(c1) }));
    expect(rows.needs).toHaveLength(1);
    expect(rows.needs[0]).toMatchObject({ kind: "prompt", card: "t1", who: "t1, homelab", runId: "c1", prompt: question, since: 30 });
    // a run with no steps yet counts from its start
    const fresh = managerRows(coord([child("c1")]), at({ runs: runsOf({ ...c1, steps: [], startedAt: 7 }) }));
    expect(fresh.needs[0]?.since).toBe(7);
  });

  test("a gated flow card whose Fill step's run holds a question gives a gate and a prompt with that step run", () => {
    const fill = run("sf", { status: "waiting", prompt: question, steps: [step("text", "which file", 25)], branch: br("sf", { origin: "b-f1", state: "working" }) });
    const built = run("sb", { endedAt: 20, branch: br("sb", { origin: "b-f1", state: "working" }) });
    const f = flow("f1", [fstep("Build", "passed", { runId: "sb" }), fstep("Fill", "gated", { runId: "sf" })], { status: "gated", current: 1 });
    const rows = managerRows(coord([card({ state: "running", flow: "f1", branch: "b-f1" })]), at({ runs: runsOf(fill, built), flows: flowsOf(f) }));
    expect(rows.needs.map((n) => n.kind)).toEqual(["gate", "prompt"]);
    expect(rows.needs[0]).toMatchObject({ kind: "gate", card: "t1", flowId: "f1", since: 5 });
    expect(rows.needs[1]).toMatchObject({ kind: "prompt", card: "t1", runId: "sf", prompt: question, since: 25 });
  });

  test("a gate counts from its step run's end, else from the flow's start", () => {
    const r = run("sc", { endedAt: 50 });
    const f = flow("f1", [fstep("Gates", "passed"), fstep("Commit", "gated", { runId: "sc", reason: "two files outside the ask" })], { status: "gated", current: 1 });
    const rows = managerRows(coord([card({ state: "running", flow: "f1" })]), at({ runs: runsOf(r), flows: flowsOf(f) }));
    expect(rows.needs).toEqual([
      expect.objectContaining({ kind: "gate", flowId: "f1", runId: "sc", since: 50, detail: "two files outside the ask" }),
    ]);
    // a working flow waits on no one
    expect(managerRows(coord([card({ state: "running", flow: "f1" })]), at({ flows: flowsOf({ ...f, status: "working" }) })).needs).toEqual([]);
  });

  test("a question on the coordinator itself is the manager's", () => {
    const k = coord([], { status: "waiting", prompt: question, steps: [step("text", "one thing first", 12)] });
    expect(managerRows(k, at()).needs).toEqual([expect.objectContaining({ kind: "prompt", card: null, who: "manager", runId: "k", since: 12 })]);
  });

  test("a branch whose verdict waits for Eric, one sent back, and one waiting on the judge", () => {
    const needs = (task: CoordTask, info: LandingInfo) => managerRows(coord([task]), at({ runs: runsOf(run("c1", { endedAt: 30 })), landing: info })).needs;
    const done = child("c1", { state: "done", outcome: "ready" });
    expect(needs(done, landing([rec("b-c1", { review: review("land") })]))).toEqual([
      expect.objectContaining({ kind: "landing", card: "t1", landingId: "b-c1", runId: "c1", canLand: true, since: 40 }),
    ]);
    expect(needs(done, landing([rec("b-c1", { review: review("approve") })]))[0]).toMatchObject({ kind: "landing", canLand: true });
    // the queue lands an auto verdict on its own
    expect(needs(child("c1"), landing([rec("b-c1", { review: review("auto") })]))).toEqual([]);
    const back = child("c1", { state: "failed", outcome: "sent back" });
    expect(needs(back, landing([rec("b-c1")], [entry("b-c1", "red", { gate: "test" })]))).toEqual([
      expect.objectContaining({ kind: "landing", landingId: "b-c1", canLand: false, since: 60 }),
    ]);
    // a fix already going waits on no one
    expect(needs(back, landing([rec("b-c1")], [entry("b-c1", "red", { fixing: "c2" })]))).toEqual([]);
    expect(needs(child("c1"), landing([rec("b-c1")], [entry("b-c1", "judge", { reason: "scenario x needs a judge" })]))).toEqual([
      expect.objectContaining({ kind: "landing", landingId: "b-c1", detail: "scenario x needs a judge" }),
    ]);
    expect(needs(child("c1"), landing([rec("b-c1")], [entry("b-c1", "queued")]))).toEqual([]);
  });

  test("a branch's landing item outlives its run once the page no longer holds the run", () => {
    // the runner keeps only so many finished runs; the landing record stays
    const pruned = (task: CoordTask, info: LandingInfo) => managerRows(coord([task]), at({ landing: info })).needs;
    const done = child("c1", { state: "done", outcome: "ready" });
    expect(pruned(done, landing([rec("b-c1", { review: review("land"), endedAt: 30 })]))).toEqual([
      expect.objectContaining({ kind: "landing", card: "t1", landingId: "b-c1", runId: "c1", canLand: true, since: 40, detail: "needs your land" }),
    ]);
    const back = child("c1", { state: "failed", outcome: "sent back" });
    expect(pruned(back, landing([rec("b-c1")], [entry("b-c1", "red", { gate: "test" })]))).toEqual([
      expect.objectContaining({ kind: "landing", landingId: "b-c1", canLand: false, since: 60, detail: "test failed" }),
    ]);
    expect(pruned(child("c1"), landing([rec("b-c1")], [entry("b-c1", "judge", { reason: "scenario x needs a judge" })]))).toEqual([
      expect.objectContaining({ kind: "landing", landingId: "b-c1", detail: "scenario x needs a judge" }),
    ]);
    expect(pruned(back, landing([rec("b-c1")], [entry("b-c1", "red", { fixing: "c2" })]))).toEqual([]);
    expect(pruned(done, landing([rec("b-c1", { review: review("auto") })]))).toEqual([]);
    // a branch that opened a PR lands there
    expect(pruned(done, landing([rec("b-c1", { review: review("land"), pr: 12 })]))).toEqual([]);
    // the card reads lichen, as its land arc does
    const rows = managerRows(coord([done]), at({ landing: landing([rec("b-c1", { review: review("land") })]) }));
    expect([rows.rings[1]?.tone, rows.rings[1]?.arcs[1]?.tone]).toEqual(["lichen", "lichen"]);
  });

  test("a prompt on a group member's run waits on Eric, with that member's run", () => {
    const g: RunGroup = {
      id: "g1",
      repoId: "canopy",
      repoPath: "/r/canopy",
      action: "ask",
      note: "n",
      expectedMembers: 3,
      members: [
        { run: "m1", origin: "b-m1", profile: null },
        { run: "m2", origin: "b-m2", profile: null },
        { run: "m3", origin: "b-m3", profile: null },
      ],
      state: "working",
      autoLand: false,
      startedAt: 1,
    };
    const m2 = run("m2", { status: "waiting", prompt: { ...question, id: "p2" }, steps: [step("text", "may I", 15)] });
    const task = card({ state: "running", times: 3, group: "g1" });
    const rows = managerRows(coord([task]), at({ runs: runsOf(run("m1", { status: "working" }), m2), landing: { ...none, groups: [g] } }));
    expect(rows.needs).toEqual([expect.objectContaining({ key: "prompt:m2:p2", kind: "prompt", card: "t1", runId: "m2", since: 15 })]);
    expect(rows.rings[1]?.tone).toBe("lichen");
  });

  test("the manager's turn is its proposed cards; prose in a message never counts", () => {
    const k = coord([card(), card({ id: "t2", title: "and the other" }), card({ id: "t3", state: "queued" })], { steps: [step("text", "Shall I start t1?", 9)] });
    expect(managerRows(k, at()).needs).toEqual([
      expect.objectContaining({ key: "cards:k", kind: "cards", card: null, who: "manager", what: "2 cards wait for start these", since: 9 }),
    ]);
    const asking = coord([card({ state: "running" })], { steps: [step("text", "Should I go on? Tell me.", 9)] });
    expect(managerRows(asking, at()).needs).toEqual([]);
  });

  test("oldest first, then card order, the manager's own before a card's", () => {
    const c1 = run("c1", { endedAt: 30 });
    const c2 = run("c2", { status: "waiting", prompt: question, steps: [step("text", "q", 9)] });
    const c3 = run("c3", { status: "waiting", prompt: { ...question, id: "p3" }, steps: [step("text", "q", 9)] });
    const k = coord(
      [child("c1", { state: "done", outcome: "ready" }), child("c2", { id: "t2", branch: "b-c2" }), child("c3", { id: "t3", branch: "b-c3" }), card({ id: "t4" })],
      { steps: [step("text", "four cards", 9)] },
    );
    const rows = managerRows(k, at({ runs: runsOf(c1, c2, c3), landing: landing([rec("b-c1", { review: review("land") })]) }));
    expect(rows.needs.map((n) => n.key)).toEqual(["cards:k", "prompt:c2:p1", "prompt:c3:p3", "landing:b-c1"]);
  });
});

describe("what a lane's say box sends to", () => {
  test("an active Claude run is steered; a Codex one takes no message mid-turn", () => {
    const task = child("c1");
    expect(sayTarget(task, run("c1", { status: "working" }), undefined, none)).toEqual({ kind: "steer", runId: "c1" });
    expect(sayTarget(task, run("c1", { status: "waiting" }), undefined, none)).toEqual({ kind: "steer", runId: "c1" });
    expect(sayTarget(task, run("c1", { status: "working", harness: "codex" }), undefined, none)).toEqual({ kind: "none", why: "a Codex worker takes no message mid-turn" });
  });

  test("an active flow's step run is steered; a gated flow and a stopped one say what comes first", () => {
    const sr = run("s2", { status: "working", branch: br("s2", { origin: "b-f1", state: "working" }) });
    const f = flow("f1", [fstep("Build", "passed", { runId: "s1" }), fstep("Test", "running", { runId: "s2" })], { current: 1 });
    const task = card({ state: "running", flow: "f1", branch: "b-f1" });
    expect(sayTarget(task, sr, f, none)).toEqual({ kind: "steer", runId: "s2" });
    expect(managerRows(coord([task]), at({ runs: runsOf(sr), flows: flowsOf(f) })).lanes[0]?.say).toEqual({ kind: "steer", runId: "s2" });
    expect(sayTarget(task, { ...sr, status: "done" }, { ...f, status: "gated" }, none)).toEqual({ kind: "none", why: "release or stop its gate first" });
    expect(sayTarget(task, { ...sr, status: "stopped" }, { ...f, status: "stopped" }, landing([rec("b-f1")]))).toEqual({ kind: "none", why: "pick its flow up first" });
    // a working flow running its check has no agent to say to
    const checking = { ...f, steps: [fstep("Build", "passed", { runId: "s1" }), fstep("Test", "checking", { runId: "s2" })] };
    expect(sayTarget(task, { ...sr, status: "done" }, checking, none)).toEqual({ kind: "none", why: "no step of its flow is at work just now" });
  });

  test("a stopped flow whose branch has a landing entry says the entry's words, not to pick the flow up", () => {
    const sr = run("s2", { status: "stopped", branch: br("s2", { origin: "b-f1", state: "ready" }) });
    const f = flow("f1", [fstep("Build", "passed", { runId: "s1" }), fstep("Test", "failed", { runId: "s2" })], { current: 1, status: "stopped" });
    const task = card({ state: "failed", outcome: "stopped", flow: "f1", branch: "b-f1" });
    expect(sayTarget(task, sr, f, landing([rec("b-f1")], [entry("b-f1", "red")]))).toEqual({ kind: "none", why: "it was sent back (red); fix it from the landing queue instead" });
    expect(sayTarget(task, sr, f, landing([rec("b-f1")], [entry("b-f1", "rebasing")]))).toEqual({ kind: "none", why: "it is in the landing queue (rebasing); wait for it, or drop it from the queue first" });
    expect(sayTarget(task, sr, f, landing([rec("b-f1")], [entry("b-f1", "landed")]))).toEqual({ kind: "none", why: "it has landed" });
  });

  test("a card waiting on the usage reset takes no words: it carries on after the reset", () => {
    const task = child("c1", { limited: 0, outcome: "waiting for capacity" });
    const limited = run("c1", { status: "limited" });
    expect(sayTarget(task, limited, undefined, landing([rec("b-c1")]))).toEqual({ kind: "none", why: "it carries on after the reset" });
    // once it resumed, its run is steered as any other
    expect(sayTarget(child("c2", { limited: 1 }), run("c2", { status: "working" }), undefined, none)).toEqual({ kind: "steer", runId: "c2" });
  });

  test("a card not started, or landed, takes no message", () => {
    expect(sayTarget(card(), undefined, undefined, none)).toEqual({ kind: "none", why: "it has not started" });
    expect(sayTarget(card({ state: "queued" }), undefined, undefined, none)).toEqual({ kind: "none", why: "it has not started" });
    expect(sayTarget(child("c1", { state: "done", outcome: "landed" }), run("c1"), undefined, none)).toEqual({ kind: "none", why: "it has landed" });
  });

  test("a settled card follows up when the server would take it, else says the server's refusal", () => {
    const task = child("c1", { state: "done", outcome: "ready" });
    const r = run("c1");
    expect(sayTarget(task, r, undefined, landing([rec("b-c1")]))).toEqual({ kind: "followup", landingId: "b-c1" });
    expect(sayTarget(child("c1", { state: "failed", outcome: "stopped" }), { ...r, status: "stopped" }, undefined, landing([rec("b-c1", { state: "stopped" })]))).toEqual({
      kind: "followup",
      landingId: "b-c1",
    });
    expect(sayTarget(task, r, undefined, landing([rec("b-c1")], [entry("b-c1", "queued")]))).toEqual({
      kind: "none",
      why: "it is in the landing queue (queued); wait for it, or drop it from the queue first",
    });
    expect(sayTarget(task, r, undefined, landing([rec("b-c1")], [entry("b-c1", "red")]))).toEqual({
      kind: "none",
      why: "it was sent back (red); fix it from the landing queue instead",
    });
    expect(sayTarget(task, r, undefined, none)).toEqual({ kind: "none", why: "canopy no longer holds its branch; it was dropped or never ran" });
    // a card whose branch Eric dropped says so, with no id of canopy's
    expect(sayTarget({ ...task, state: "failed", outcome: "dropped" }, r, undefined, none)).toEqual({ kind: "none", why: "its branch was dropped" });
    // a card whose start failed has no branch at all
    expect(sayTarget(card({ state: "failed", outcome: "repo not found" }), undefined, undefined, none)).toEqual({ kind: "none", why: "it has no branch to follow up on" });
  });

  test("a branch the PR watch holds takes a PR comment, not a follow-up", () => {
    const task = child("c1", { state: "done", outcome: "PR opened" });
    const info = landing([rec("b-c1", { pr: 12 })]);
    expect(sayTarget(task, run("c1"), undefined, info, [watch()])).toEqual({
      kind: "none",
      why: "it has an open pull request; comment on the PR and the PR watch fixes it",
    });
    const closed = watch({ state: { number: 12, url: "u", status: "closed", draft: false, additions: 0, deletions: 0, files: 0, head: "h1", mergeable: "UNKNOWN", mergeState: "CLEAN", review: "none", checks: [] } });
    expect(sayTarget(task, run("c1"), undefined, info, [closed])).toEqual({ kind: "followup", landingId: "b-c1" });
    // the manager passes the PRs it is given
    expect(managerRows(coord([task]), at({ runs: runsOf(run("c1")), landing: info, prs: [watch()] })).lanes[0]?.say.kind).toBe("none");
  });
});

describe("the lanes", () => {
  test("a worker's model: the run's settings, its equip, the card's equip, then its loadout's", () => {
    const task = child("c1", { equip: { loadout: "feature", model: "sonnet" } });
    const model = (r: Run | undefined, t: CoordTask = task) => managerRows(coord([t]), at({ runs: r ? runsOf(r) : {}, loadouts: [loadout()] })).lanes[0]?.model;
    const equip = { loadout: "feature", model: "haiku", effort: "low" as const, skills: [], mcp: [], off: 0 };
    expect(model(run("c1", { agentSettings: { harness: "claude", model: "opus-5", effort: "default" }, equip }))).toBe("opus-5");
    expect(model(run("c1", { equip }))).toBe("haiku");
    expect(model(run("c1"))).toBe("sonnet");
    expect(model(undefined, card({ equip: { loadout: "feature" } }))).toBe("opus");
    expect(model(undefined, card())).toBeNull();
    // the ring under the card says the same
    expect(managerRows(coord([task]), at({ runs: runsOf(run("c1", { equip })), loadouts: [loadout()] })).rings[1]?.model).toBe("haiku");
  });

  test("a flow card's worker is its step run in hand, where a profile step puts its model", () => {
    const sr = run("s2", { status: "working", agentSettings: { harness: "claude", model: "sonnet-5", effort: "medium" } });
    const f = flow("f1", [fstep("Plan", "passed", { runId: "s1" }), fstep("Build", "running", { runId: "s2" })], { current: 1 });
    const lane = managerRows(coord([card({ state: "running", flow: "f1", equip: { loadout: "feature" } })]), at({ runs: runsOf(sr), flows: flowsOf(f), loadouts: [loadout()] })).lanes[0];
    expect(lane).toMatchObject({ model: "sonnet-5", effort: "medium", flowId: "f1", runId: null });
  });

  test("its equip chips: loadout, effort, skills and servers, with the run's equip as the title", () => {
    const equip = { loadout: "feature", model: "opus", effort: "high" as const, skills: ["a", "b"], mcp: ["probe"], off: 3 };
    const started = managerRows(coord([child("c1")]), at({ runs: runsOf(run("c1", { equip })) })).lanes[0];
    expect(started).toMatchObject({ loadout: "feature", effort: "high", skills: 2, servers: 1, equipTitle: "loadout feature\nopus, high\nskills: a, b\nservers: probe\n3 skills off" });
    const planned = managerRows(coord([card({ equip: { loadout: "feature", skills: [] } })]), at({ loadouts: [loadout()] })).lanes[0];
    expect(planned).toMatchObject({ loadout: "feature", model: "opus", effort: "high", skills: 0, servers: 1, equipTitle: "loadout feature; skills none" });
    expect(managerRows(coord([card()]), at()).lanes[0]).toMatchObject({ loadout: null, effort: null, skills: 0, servers: 0, equipTitle: "" });
  });
  test("the goal's files its card takes, by name, else none", () => {
    expect(managerRows(coord([card({ files: ["shot.png", "notes.md"] })]), at()).lanes[0]?.files).toBe("files: shot.png, notes.md");
    expect(managerRows(coord([card()]), at()).lanes[0]?.files).toBeNull();
  });

  test("its head: branch, start, newest step line and the ids its actions take", () => {
    const c1 = run("c1", { status: "working", startedAt: 20, steps: [step("text", "**Editing** src/server/notify.ts", 30)] });
    const lane = managerRows(coord([child("c1", { title: "one signal" })]), at({ runs: runsOf(c1), landing: landing([rec("b-c1", { state: "working" })]) })).lanes[0];
    expect(lane).toMatchObject({ id: "t1", title: "one signal", word: "running", tone: "sky", repo: "canopy", branch: "run/x-c1", startedAt: 20, live: "Editing src/server/notify.ts", runId: "c1", flowId: null, landingId: "b-c1" });
    expect(lane?.steps.map((s) => s.label)).toEqual(["build", "land"]);
    expect(managerRows(coord([card()]), at()).lanes[0]).toMatchObject({ branch: null, startedAt: null, live: null, runId: null, landingId: null });
  });

  test("equip and start now for cards not started, start now only while the goal is not held", () => {
    const lanes = (k: Run) => managerRows(k, at({ runs: runsOf(run("c3", { status: "working" })) })).lanes.map((l) => [l.id, l.canEquip, l.canStartNow]);
    const tasks = [card(), card({ id: "t2", state: "queued" }), child("c3", { id: "t3", branch: "b-c3" })];
    expect(lanes(coord(tasks))).toEqual([
      ["t1", true, true],
      ["t2", true, true],
      ["t3", false, false],
    ]);
    expect(lanes(coord(tasks, { held: true }))).toEqual([
      ["t1", true, false],
      ["t2", true, false],
      ["t3", false, false],
    ]);
    // an ended goal starts and equips nothing: its cards no longer change
    expect(lanes(coord(tasks, { status: "stopped" }))).toEqual([
      ["t1", false, false],
      ["t2", false, false],
      ["t3", false, false],
    ]);
  });

  test("stop while its run or flow works; resume a stopped run the server would follow up, or a stopped branch flow", () => {
    const lane = (task: CoordTask, over: Partial<ManagerInputs>) => managerRows(coord([task]), at(over)).lanes[0];
    expect(lane(child("c1"), { runs: runsOf(run("c1", { status: "working" })) })).toMatchObject({ canStop: true, canResume: false });
    const f = flow("f1", [fstep("Build", "running")]);
    expect(lane(card({ state: "running", flow: "f1" }), { flows: flowsOf(f) })).toMatchObject({ canStop: true, canResume: false });
    expect(lane(card({ state: "failed", outcome: "stopped", flow: "f1" }), { flows: flowsOf({ ...f, status: "stopped" }) })).toMatchObject({ canStop: false, canResume: true });
    expect(lane(card({ state: "failed", flow: "f1" }), { flows: flowsOf({ ...f, status: "stopped", branch: undefined }) })?.canResume).toBe(false);
    const stopped = run("c1", { status: "stopped", branch: br("c1", { state: "stopped" }) });
    const failed = child("c1", { state: "failed", outcome: "stopped" });
    expect(lane(failed, { runs: runsOf(stopped), landing: landing([rec("b-c1", { state: "stopped" })]) })).toMatchObject({ canStop: false, canResume: true, landingId: "b-c1" });
    expect(lane(failed, { runs: runsOf(stopped) })?.canResume).toBe(false);
    expect(lane(failed, { runs: runsOf({ ...stopped, status: "failed" }), landing: landing([rec("b-c1", { state: "stopped" })]) })?.canResume).toBe(false);
    // the server refuses a follow-up on a branch its PR watch holds, so resume does not offer one
    expect(lane(failed, { runs: runsOf(stopped), landing: landing([rec("b-c1", { state: "stopped", pr: 12 })]), prs: [watch()] })?.canResume).toBe(false);
  });

  test("a stopped flow whose branch the landing queue holds, sent back or landed offers no resume, since its pickup is refused", () => {
    const lane = (es: LandEntry[]) => managerRows(coord([card({ state: "failed", outcome: "stopped", flow: "f1", branch: "b-f1" })]), at({ flows: flowsOf(flow("f1", [fstep("Build", "failed")], { status: "stopped" })), landing: landing([rec("b-f1")], es) })).lanes[0];
    expect(lane([])?.canResume).toBe(true);
    for (const state of ["queued", "rebasing", "red", "landed"] as const) expect(lane([entry("b-f1", state)])?.canResume).toBe(false);
  });

  test("a stopped flow whose PR the PR watch holds offers no resume, since its pickup is refused", () => {
    const lane = (prs: PrWatch[]) => managerRows(coord([card({ state: "failed", outcome: "stopped", flow: "f1", branch: "b-f1" })]), at({ flows: flowsOf(flow("f1", [fstep("Build", "failed")], { status: "stopped" })), landing: landing([rec("b-f1")]), prs })).lanes[0];
    expect(lane([])?.canResume).toBe(true);
    expect(lane([watch({ id: "b-f1", runId: "f1" })])?.canResume).toBe(false);
    // a watch on another branch holds nothing here
    expect(lane([watch()])?.canResume).toBe(true);
  });
});

describe("whom the manager chat speaks to", () => {
  const lanes = (): Lane[] =>
    managerRows(
      coord([child("c1"), child("c2", { id: "t2", branch: "b-c2" })]),
      at({ runs: runsOf(run("c1", { status: "working" }), run("c2", { status: "working" })) }),
    ).lanes;
  test("nothing picked is the manager, and the list holds the lanes that take words", () => {
    const got = chatAim(lanes(), "");
    expect(got.lane).toBeUndefined();
    expect(got.shut).toBeUndefined();
    expect(got.options.map((l) => l.id)).toEqual(["t1", "t2"]);
  });
  test("a picked lane that takes words is where the words go", () => {
    expect(chatAim(lanes(), "t2")).toMatchObject({ lane: { id: "t2" } });
    expect(chatAim(lanes(), "t2").shut).toBeUndefined();
  });
  test("a picked lane that stops taking words stays picked and shut, so a draft never goes to the manager", () => {
    const now = lanes().map((l) => (l.id === "t1" ? { ...l, say: { kind: "none" as const, why: "it has landed" } } : l));
    const got = chatAim(now, "t1");
    expect(got.lane?.id).toBe("t1");
    expect(got.shut).toBe("t1 takes no words now: it has landed. Pick the manager or another worker to send this.");
    expect(got.options.map((l) => l.id)).toEqual(["t1", "t2"]);
    // not picked, a lane that takes no words is not offered
    expect(chatAim(now, "").options.map((l) => l.id)).toEqual(["t2"]);
  });
  test("a picked card no longer on the goal leaves the manager", () => {
    expect(chatAim(lanes(), "t9")).toEqual({ options: lanes() });
  });
});

describe("the goal", () => {
  test("its text is the first thing Eric said, else the run's note", () => {
    const k = coord([], { steps: [step("note", "canopy started", 1), step("user", "One buzz per waiting run", 2), step("user", "and quiet nights", 3)] });
    expect(managerRows(k, at()).goal.text).toBe("One buzz per waiting run");
    expect(managerRows(coord([]), at()).goal.text).toBe("the goal as noted");
  });

  test("its model, start, held, ended, and how many work and wait", () => {
    const tasks = [child("c1"), child("c2", { id: "t2", branch: "b-c2" }), card({ id: "t3", state: "running", flow: "f1" }), card({ id: "t4" })];
    const runs = runsOf(run("c1", { status: "working" }), run("c2", { status: "waiting", prompt: question }));
    const flows = flowsOf(flow("f1", [fstep("Build", "running")]));
    const k = coord(tasks, { agentSettings: { harness: "claude", model: "opus-5", effort: "low" }, held: true });
    const { goal, needs } = managerRows(k, at({ runs, flows }));
    expect(goal).toEqual({ text: "the goal as noted", model: "opus-5", effort: "low", startedAt: 100, working: 3, waiting: needs.length, held: true, ended: false });
    expect(needs.length).toBe(2);
    expect(managerRows({ ...k, status: "done", held: undefined }, at({ runs, flows })).goal).toMatchObject({ held: false, ended: true });
  });

  test("a flow parked at its gate waits on Eric and is not counted as working, though it can still be stopped", () => {
    const tasks = [child("c1"), card({ id: "t2", state: "running", flow: "f2" })];
    const gated = flow("f2", [fstep("Build", "passed", { runId: "s1" }), fstep("Check", "gated", { runId: "s2" })], { current: 1, status: "gated" });
    const rows = managerRows(coord(tasks), at({ runs: runsOf(run("c1", { status: "working" })), flows: flowsOf(gated) }));
    expect(rows.goal.working).toBe(1);
    expect(rows.needs.map((n) => n.key)).toEqual(["gate:f2"]);
    expect(rows.lanes[1]?.canStop).toBe(true);
  });

  test("the manager's ring says how the goal stands and carries the manager's model", () => {
    const k = coord([card(), card({ id: "t2", state: "queued" })], { status: "working", agentSettings: { harness: "claude", model: "opus-5", effort: "default" } });
    expect(managerRows(k, at()).rings[0]).toMatchObject({ id: "manager", title: "2 cards · 1 proposed, 1 queued", model: "opus-5", at: "2 cards", wave: 0 });
  });
});

describe("the live coordinators", () => {
  test("active coordinator runs, newest first", () => {
    const runs = runsOf(
      coord([], { id: "k1", startedAt: 10 }),
      coord([], { id: "k2", startedAt: 30, status: "working" }),
      coord([], { id: "k3", startedAt: 50, status: "done" }),
      run("c1", { status: "working", startedAt: 60 }),
      coord([], { id: "k4", startedAt: 20, status: "waiting" }),
    );
    expect(liveCoordinators(runs).map((r) => r.id)).toEqual(["k2", "k4", "k1"]);
  });
});

describe("a card in a kept tree", () => {
  const tree = (over: Partial<BranchTree> = {}): BranchTree => ({ slug: "feat-x", dir: "/c/trees/canopy/feat-x", branch: "feat/x", base: "main", port: null, madeAt: 1, caches: false, state: "ready", sync: false, ...over }) as BranchTree;
  const trees = (t: BranchTree): Record<string, BranchTreesInfo> => ({ mini: { root: "/c/trees", ports: "", repos: [{ repoId: "canopy", repoPath: "/r/canopy", trees: [t] }] } });
  const repos = [{ id: "trees:canopy/feat-x", path: "/c/trees/canopy/feat-x" }] as unknown as Repo[];
  const tcard = (over: Partial<CoordTask> = {}): CoordTask => card({ id: "t1", state: "done", run: "c1", tree: "feat/x", treeRepo: "trees:canopy/feat-x", outcome: "done in tree feat/x", ...over });
  const lane = (task: CoordTask, over: Partial<ManagerInputs> = {}, c: Partial<Run> = {}) => managerRows(coord([task], c), at(over)).lanes[0];
  const tr = run("c1", { repoId: "trees:canopy/feat-x", branch: undefined });

  test("a queued tree card carries its tree, its state and its card, and the making words", () => {
    const l = lane(card({ state: "queued", tree: "feat/x", outcome: "making tree feat/x" }), { trees: trees(tree({ state: "preparing" })), repos });
    expect(l?.tree).toEqual({ branch: "feat/x", state: "preparing", cardId: "trees:canopy/feat-x" });
    expect(l?.live).toBe("making tree feat/x");
    expect(lane(card({ state: "queued", tree: "feat/x" }))?.tree).toEqual({ branch: "feat/x", state: null, cardId: null });
    expect(lane(card())?.tree).toBeNull();
  });

  test("the card is the task's treeRepo when the server set it", () => {
    expect(lane(tcard(), { runs: runsOf(tr) })?.tree).toEqual({ branch: "feat/x", state: null, cardId: "trees:canopy/feat-x" });
  });

  test("a tree removed after its card ran has no card to open: repos without it give cardId null", () => {
    const l = lane(tcard(), { runs: runsOf(tr), repos: [] });
    expect(l?.tree).toEqual({ branch: "feat/x", state: null, cardId: null });
    expect(lane(tcard(), { runs: runsOf(tr), repos })?.tree?.cardId).toBe("trees:canopy/feat-x");
  });

  test("a settled tree card takes words into its tree, and a stopped run resumes there", () => {
    const l = lane(tcard(), { runs: runsOf(tr) });
    expect(l?.say).toEqual({ kind: "tree", coordId: "k", cardId: "t1", branch: "feat/x" });
    expect(l?.canResume).toBe(false);
    if (!l) throw new Error("no lane");
    expect(chatAim([l], "t1").options).toEqual([l]);
    expect(lane(tcard({ state: "failed" }), { runs: runsOf({ ...tr, status: "stopped" }) })).toMatchObject({ canResume: true, say: { kind: "tree" } });
    expect(lane(tcard({ state: "running" }), { runs: runsOf({ ...tr, status: "working" }) })?.say).toEqual({ kind: "steer", runId: "c1" });
    expect(lane(tcard(), { runs: runsOf(tr) }, { status: "stopped" })?.say).toEqual({ kind: "none", why: "its goal has ended" });
    expect(lane(card({ state: "queued", tree: "feat/x" }))?.say).toEqual({ kind: "none", why: "it has not started" });
    expect(lane(tcard({ limited: 0 }), { runs: runsOf({ ...tr, status: "limited" }) })?.say).toEqual({ kind: "none", why: "it carries on after the reset" });
  });

  test("a tree card that never ran in its tree takes no words and offers no resume", () => {
    const failed = card({ state: "failed", tree: "feat/x", outcome: "tree feat/x failed: setup exited 3" });
    expect(lane(failed)).toMatchObject({ say: { kind: "none", why: "it never ran in its tree" }, canResume: false });
    // a run with no treeRepo is the same to the server
    expect(lane(tcard({ treeRepo: undefined }), { runs: runsOf({ ...tr, status: "stopped" }) })).toMatchObject({ say: { kind: "none", why: "it never ran in its tree" }, canResume: false });
  });

  test("its last arc is the tree: moss when done, hair while running", () => {
    const last = (task: CoordTask, r: Run) => lane(task, { runs: runsOf(r) })?.steps.at(-1);
    expect(last(tcard(), tr)).toEqual({ label: "tree", tone: "moss" });
    expect(last(tcard({ state: "running" }), { ...tr, status: "working" })).toEqual({ label: "tree", tone: "hair" });
  });
});
