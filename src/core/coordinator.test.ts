import { describe, expect, test } from "bun:test";
import { afterWait, blockedNote, cardLanded, childOutcome, childSettled, COORD_AT_ONCE, editCard, flowNote, flowSettled, groupNote, groupSettled, holdNote, landedNote, MAX_PLAN, MAX_TASKS, MAY_LAND_LATER, nextToStart, settleNote, startNote, validatePlan, coordWorkflows, withStandingRules, type ChildLanding, type PlanContext } from "./coordinator";
import { FLEET_CONCURRENCY } from "./flow";
import type { RunGroup } from "./group";
import { EMPTY_LOADOUTS } from "./loadout";
import type { CoordTask, Flow, LandEntry, Loadout, LoadoutsInfo, Run, RunBranch, Workflow, WorkflowEntry, WorkflowSource } from "./types";

const known = (repo: string): "local" | "remote" | null => (repo === "web" || repo === "api" ? "local" : repo === "mini:box" ? "remote" : null);
const task = (over: Record<string, unknown> = {}) => ({ title: "fix the login", repo: "web", note: "the login form drops the email", action: "propose", ...over });
const filler = (n: number): CoordTask[] => Array.from({ length: n }, (_, i) => ({ id: `t${i + 1}`, title: "x", repo: "web", note: "n", action: "ask", state: "done" }));
const ctxOf = (over: Partial<PlanContext> = {}): PlanContext => ({ known, cards: [], next: 1, loadouts: EMPTY_LOADOUTS, workflows: () => [], by: "person", ...over });
const plan = (tasks: unknown, have = 0) => validatePlan(tasks, ctxOf({ cards: filler(have), next: have + 1 }));

describe("validatePlan", () => {
  test("takes up to 8 tasks, trimmed", () => {
    const got = plan([task({ title: "  fix the login  ", note: "\n the form \n" }), task({ repo: "api", action: "ask" })]);
    expect(got).toEqual({
      tasks: [
        { title: "fix the login", repo: "web", note: "the form", action: "propose" },
        { title: "fix the login", repo: "api", note: "the login form drops the email", action: "ask" },
      ],
    });
    expect("tasks" in plan(Array.from({ length: MAX_PLAN }, () => task()))).toBe(true);
  });

  test("refuses 9 tasks, an empty list and a list that is not one", () => {
    expect(plan(Array.from({ length: 9 }, () => task()))).toEqual({ error: "at most 8 tasks per plan; this one has 9" });
    expect(plan([])).toEqual({ error: "a plan needs at least one task" });
    expect(plan({ title: "x" })).toEqual({ error: "tasks must be a list" });
  });

  test("refuses a plan that takes the coordinator past 20 tasks", () => {
    expect("tasks" in plan([task(), task()], MAX_TASKS - 2)).toBe(true);
    expect(plan([task(), task(), task()], 18)).toEqual({ error: "a coordinator holds at most 20 tasks; it has 18 and this plan adds 3" });
  });

  test("names the task and the field it refuses", () => {
    expect(plan([task(), task({ repo: "nowhere" })])).toEqual({ error: "tasks[1].repo: no repo nowhere on this backend" });
    expect(plan([task({ repo: "mini:box" })])).toEqual({ error: "tasks[0].repo: mini:box is on another host; a task runs in a local repo" });
    expect(plan([task({ action: "chat" })])).toEqual({ error: "tasks[0].action must be propose or ask" });
    expect(plan([task({ action: undefined })])).toEqual({ error: "tasks[0].action must be propose or ask" });
    expect(plan([task({ title: "   " })])).toEqual({ error: "tasks[0].title is empty" });
    expect(plan([task({ title: "x".repeat(121) })])).toEqual({ error: "tasks[0].title is over 120 characters" });
    expect(plan([task({ note: "" })])).toEqual({ error: "tasks[0].note is empty" });
    expect(plan([task({ note: 7 })])).toEqual({ error: "tasks[0].note must be text" });
    expect(plan([task({ note: "x".repeat(4001) })])).toEqual({ error: "tasks[0].note is over 4000 characters" });
    expect(plan([task({ repo: 3 })])).toEqual({ error: "tasks[0].repo must be a repo id" });
    expect(plan(["fix it"])).toEqual({ error: "tasks[0] must be an object" });
    expect("tasks" in plan([task({ title: "x".repeat(120), note: "y".repeat(4000) })])).toBe(true);
  });
});

const card = (id: string, repo: string, state: CoordTask["state"] = "queued"): CoordTask => ({ id, title: id, repo, note: "n", action: "ask", state });

describe("nextToStart", () => {
  test("3 at once is the fleet's cap", () => {
    expect(COORD_AT_ONCE).toBe(FLEET_CONCURRENCY);
  });

  test("starts queued cards in order, up to 3 working", () => {
    const tasks = [card("t1", "web"), card("t2", "api"), card("t3", "web"), card("t4", "api"), card("t5", "web")];
    expect(nextToStart(tasks, { working: 0, repoFull: () => false, cards: tasks }).map((t) => t.id)).toEqual(["t1", "t2", "t3"]);
    expect(nextToStart(tasks, { working: 2, repoFull: () => false, cards: tasks }).map((t) => t.id)).toEqual(["t1"]);
    expect(nextToStart(tasks, { working: 3, repoFull: () => false, cards: tasks })).toEqual([]);
  });

  test("passes over cards that are not queued", () => {
    const tasks = [card("t1", "web", "proposed"), card("t2", "web", "running"), card("t3", "web", "done"), card("t4", "web")];
    expect(nextToStart(tasks, { working: 1, repoFull: () => false, cards: tasks }).map((t) => t.id)).toEqual(["t4"]);
  });

  test("a card whose repo is full waits, and a later one in another repo goes ahead of it", () => {
    const tasks = [card("t1", "web"), card("t2", "api"), card("t3", "web"), card("t4", "api")];
    expect(nextToStart(tasks, { working: 1, repoFull: (r) => r === "web", cards: tasks }).map((t) => t.id)).toEqual(["t2", "t4"]);
  });
});

const branch = (over: Partial<RunBranch> = {}): RunBranch => ({ name: "run/fix-login-ab12cd34", target: "main", base: "abc", dir: "/tmp/w", state: "ready", origin: "ab12cd34", ...over });
const child = (over: Partial<Run> = {}): Run => ({
  id: "c1",
  repoId: "web",
  action: "propose",
  verb: "plan",
  progress: "planning",
  expectsChange: true,
  chat: false,
  harness: "claude",
  note: "the login form drops the email",
  status: "done",
  startedAt: 1,
  endedAt: 2,
  steps: [],
  prompt: null,
  result: { text: "Fixed the form and committed it.", durationMs: 1, turns: 1 },
  branch: branch(),
  parent: "co1",
  ...over,
});
const entry = (over: Partial<LandEntry> = {}): LandEntry => ({
  id: "ab12cd34",
  repoId: "web",
  repoPath: "/r/web",
  branch: "run/fix-login-ab12cd34",
  target: "main",
  dir: "/tmp/w",
  note: "n",
  state: "queued",
  tries: 0,
  queuedAt: 1,
  updatedAt: 1,
  ...over,
});
const landed = (e: Partial<LandEntry> = {}): ChildLanding => {
  const one = entry({ state: "landed", ...e });
  return { entry: one, entries: [one] };
};

describe("childOutcome", () => {
  test("nothing while the child is going or its branch is still being read", () => {
    expect(childOutcome(child({ status: "working" }))).toBeNull();
    expect(childOutcome(child({ status: "idle" }))).toBeNull();
    expect(childOutcome(child({ branch: branch({ state: "working" }) }))).toBeNull();
  });

  test("a ready branch is done, and the queue's word beats it once it has one", () => {
    expect(childOutcome(child())).toEqual({ state: "done", outcome: "ready" });
    expect(childOutcome(child(), landed())).toEqual({ state: "done", outcome: "landed" });
    expect(childOutcome(child(), landed({ state: "red", gate: "test" }))).toEqual({ state: "failed", outcome: "sent back" });
    expect(childOutcome(child(), { entry: entry(), entries: [entry()] })).toEqual({ state: "done", outcome: "ready" });
  });

  test("a ready branch with a PR open says so", () => {
    expect(childOutcome(child(), { prUrl: "https://github.com/x/web/pull/7" })).toEqual({ state: "done", outcome: "PR opened" });
  });

  test("a failure, a stop and a branch with nothing to land are failed or empty", () => {
    expect(childOutcome(child({ status: "failed", error: "boom", branch: branch({ state: "nothing" }) }))).toEqual({ state: "failed", outcome: "failed" });
    expect(childOutcome(child({ status: "stopped", branch: branch({ state: "uncommitted" }) }))).toEqual({ state: "failed", outcome: "stopped" });
    expect(childOutcome(child({ branch: branch({ state: "uncommitted" }) }))).toEqual({ state: "failed", outcome: "uncommitted" });
    expect(childOutcome(child({ branch: branch({ state: "nothing" }) }))).toEqual({ state: "done", outcome: "no change" });
    expect(childOutcome(child({ proposalState: "turned down", branch: branch({ state: "nothing" }) }))).toEqual({ state: "failed", outcome: "plan turned down" });
    expect(childOutcome(child({ proposalState: "sent back", branch: branch({ state: "nothing" }) }))).toEqual({ state: "done", outcome: "no change" });
  });

  test("a limited child waits for capacity whether its branch is empty or ready", () => {
    const text = "You've hit your limit · resets 3pm";
    const limited = child({ status: "limited", error: text, limited: { at: 3, text } });
    const outcome = { state: "failed", outcome: "waiting for capacity" } as const;
    expect(childOutcome({ ...limited, branch: branch({ state: "nothing" }) })).toEqual(outcome);
    expect(childOutcome({ ...limited, branch: branch({ state: "ready" }) }, { prUrl: "https://github.com/x/web/pull/7" })).toEqual(outcome);
  });
});

describe("settleNote", () => {
  const t: CoordTask = { id: "t2", title: "fix the login", repo: "web", note: "n", action: "propose", state: "running", run: "c1" };

  test("a landed child", () => {
    expect(settleNote(t, child(), landed())).toBe(
      [
        "canopy: a task you started has settled",
        "task t2: fix the login (repo web)",
        "outcome: landed",
        "result: Fixed the form and committed it.",
        "branch: run/fix-login-ab12cd34, landed",
      ].join("\n"),
    );
  });

  test("a sent-back child names the queue's word", () => {
    const note = settleNote(t, child(), landed({ state: "red", gate: "test" }));
    expect(note).toContain("outcome: sent back");
    expect(note).toContain("branch: run/fix-login-ab12cd34, red: test");
  });

  test("a failed child gives its error for a result, cut to 600 characters", () => {
    const note = settleNote(t, child({ status: "failed", result: undefined, error: `setup failed: ${"x".repeat(700)}`, branch: branch({ state: "nothing" }) }));
    expect(note).toContain("outcome: failed");
    const line = note.split("\n").find((l) => l.startsWith("result: ")) ?? "";
    expect(line.length).toBe("result: ".length + 600);
    expect(line.endsWith("…")).toBe(true);
    expect(note).toContain("branch: run/fix-login-ab12cd34, no commits");
  });

  test("a limited child note says it waits for capacity and keeps the limit text", () => {
    const text = "You've hit your limit · resets 3pm";
    const note = settleNote(t, child({
      status: "limited",
      error: text,
      limited: { at: 3, text },
      result: { text: "Partial work before the limit.", durationMs: 1, turns: 1 },
      branch: branch({ state: "ready" }),
    }));
    expect(note).toContain("outcome: waiting for capacity");
    expect(note).toContain(`result: ${text}`);
    expect(note).not.toContain("result: Partial work before the limit.");
  });

  test("a PR is named by its address, and a result keeps to one line", () => {
    const note = settleNote(t, child({ result: { text: "Opened it.\n\nAll green.", durationMs: 1, turns: 1 } }), { prUrl: "https://github.com/x/web/pull/7" });
    expect(note).toContain("result: Opened it. All green.");
    expect(note).toContain("PR: https://github.com/x/web/pull/7");
    expect(note).not.toContain("branch: ");
  });
});

describe("childSettled", () => {
  const queued = { entry: entry(), entries: [entry()] };

  test("an end that needs no landing settles at once", () => {
    expect(childSettled(child({ status: "failed", branch: branch({ state: "nothing" }) }), {}, false)).toEqual({ state: "failed", outcome: "failed" });
    expect(childSettled(child({ branch: branch({ state: "uncommitted" }) }), {}, false)).toEqual({ state: "failed", outcome: "uncommitted" });
    expect(childSettled(child({ branch: branch({ state: "nothing" }) }), {}, false)).toEqual({ state: "done", outcome: "no change" });
  });

  test("a going child, or one whose branch is still being read, waits", () => {
    expect(childSettled(child({ status: "working" }), {}, true)).toBeNull();
    expect(childSettled(child({ branch: branch({ state: "working" }) }), {}, true)).toBeNull();
  });

  test("a ready branch waits for its sort, and for the queue once the sort lands it on its own", () => {
    expect(childSettled(child(), {}, false)).toBeNull();
    expect(childSettled(child(), { verdict: "auto" }, false)).toBeNull();
    expect(childSettled(child(), { verdict: "auto", ...queued }, false)).toBeNull();
    expect(childSettled(child(), { verdict: "auto", ...queued }, true)).toBeNull();
    expect(childSettled(child(), { openPr: true }, false)).toBeNull();
  });

  test("the queue's last word, a PR, or a branch left to Eric settles a ready child", () => {
    expect(childSettled(child(), landed(), false)).toEqual({ state: "done", outcome: "landed" });
    expect(childSettled(child(), landed({ state: "conflict" }), false)).toEqual({ state: "failed", outcome: "sent back" });
    expect(childSettled(child(), { prUrl: "https://github.com/x/web/pull/7", openPr: true }, false)).toEqual({ state: "done", outcome: "PR opened" });
    expect(childSettled(child(), { verdict: "approve" }, false)).toEqual({ state: "done", outcome: "ready" });
    expect(childSettled(child(), { verdict: "land" }, false)).toEqual({ state: "done", outcome: "ready" });
  });

  test("a ready branch the queue never took settles ready once overdue", () => {
    expect(childSettled(child(), {}, true)).toEqual({ state: "done", outcome: "ready" });
    expect(childSettled(child(), { verdict: "auto" }, true)).toEqual({ state: "done", outcome: "ready" });
  });
});

describe("startNote", () => {
  test("a card that could not start says why", () => {
    const t: CoordTask = { id: "t3", title: "tidy the docs", repo: "api", note: "n", action: "ask", state: "failed" };
    expect(startNote(t, "api has no main or master branch to cut a run's branch from")).toBe(
      [
        "canopy: a task you started could not start",
        "task t3: tidy the docs (repo api)",
        "outcome: failed",
        "result: api has no main or master branch to cut a run's branch from",
      ].join("\n"),
    );
  });
});

describe("a card with times", () => {
  const one = (over: Record<string, unknown>) => ({ title: "t", repo: "web", note: "n", action: "ask", ...over });
  const queued = (id: string, times?: number): CoordTask => ({ id, title: id, repo: "web", note: "n", action: "ask", state: "queued", ...(times ? { times } : {}) });
  test("a plan takes 2 or 3, and 1 stores nothing", () => {
    const got = validatePlan([one({ times: 3 }), one({ times: 1 }), one({})], ctxOf());
    if ("error" in got) throw new Error(got.error);
    expect(got.tasks.map((t) => t.times)).toEqual([3, undefined, undefined]);
    expect("times" in (got.tasks[1] ?? {})).toBe(false);
  });
  test("a plan refuses anything else, naming the task", () => {
    for (const times of [0, 4, 1.5, "2", null]) {
      expect(validatePlan([one({}), one({ times })], ctxOf())).toEqual({ error: "tasks[1].times must be 1 to 3" });
    }
  });
  test("a card counts as its times against the 3 working", () => {
    const repoFull = () => false;
    expect(nextToStart([queued("t1", 3), queued("t2")], { working: 0, repoFull, cards: [] }).map((t) => t.id)).toEqual(["t1"]);
    expect(nextToStart([queued("t1", 2), queued("t2", 2), queued("t3")], { working: 0, repoFull, cards: [] }).map((t) => t.id)).toEqual(["t1", "t3"]);
  });
  test("a card that does not fit the room left waits, and a later single goes ahead", () => {
    expect(nextToStart([queued("t1", 3), queued("t2")], { working: 1, repoFull: () => false, cards: [] }).map((t) => t.id)).toEqual(["t2"]);
  });
  test("a card asks its repo for that many slots", () => {
    const asked: (number | undefined)[] = [];
    const repoFull = (_repo: string, need?: number) => { asked.push(need); return (need ?? 1) > 1; };
    expect(nextToStart([queued("t1", 2), queued("t2")], { working: 0, repoFull, cards: [] }).map((t) => t.id)).toEqual(["t2"]);
    expect(asked).toEqual([2, 1]);
  });
});

describe("a group card settling", () => {
  test("each state of the group as the card's word", () => {
    expect(groupSettled({ state: "working" })).toBeNull();
    expect(groupSettled({ state: "scoring" })).toBeNull();
    expect(groupSettled({ state: "reviewing" })).toBeNull();
    expect(groupSettled({ state: "picked" })).toEqual({ state: "done", outcome: "winner picked" });
    expect(groupSettled({ state: "landed" })).toEqual({ state: "done", outcome: "landed" });
    expect(groupSettled({ state: "needs-you" })).toEqual({ state: "failed", outcome: "needs you" });
    expect(groupSettled({ state: "dropped" })).toEqual({ state: "failed", outcome: "dropped" });
  });
  const task: CoordTask = { id: "t2", title: "retry the import", repo: "web", note: "n", action: "ask", state: "running", times: 3, group: "g-a1b2c3d4" };
  const group: RunGroup = {
    id: "g-a1b2c3d4", repoId: "web", repoPath: "/w", action: "ask", note: "n", expectedMembers: 3, autoLand: false, startedAt: 1, state: "picked",
    members: [{ run: "r1", origin: "o1", profile: null }],
    winner: "o1",
    scores: { o1: { branch: "run/a", base: "b", state: "ready", gates: { ok: true } } },
    review: { run: "c1", ranking: ["run/a"], why: { "run/a": "It is the smallest." } },
  };
  test("a picked winner's note names its branch and the reviewer's reason", () => {
    expect(groupNote(task, group, "winner picked")).toBe([
      "canopy: a task you started has settled",
      "task t2: retry the import (repo web)",
      "outcome: winner picked",
      "result: best of 3, It is the smallest.",
      "branch: run/a, the winner, waiting for Eric to land it",
    ].join("\n"));
  });
  test("a group that needs Eric says why and names no branch", () => {
    const { winner: _w, ...rest } = group;
    const text = groupNote(task, { ...rest, state: "needs-you", reason: "the reviewers disagree: run/a or run/b" }, "needs you");
    expect(text).toContain("result: best of 3, the reviewers disagree: run/a or run/b");
    expect(text).not.toContain("branch:");
  });
});

const lo = (over: Partial<Loadout> = {}): Loadout => ({ name: "quick", note: "", harness: "claude", model: "default", effort: "default", skills: [], mcp: [], canopyTools: false, ...over });
const kit: LoadoutsInfo = { base: [], loadouts: [lo(), lo({ name: "cx", harness: "codex" })], errors: [] };
const dest = (over: Partial<PlanContext> = {}) => ctxOf({ loadouts: kit, ...over });
const one = (over: Record<string, unknown> = {}) => ({ title: "t", repo: "web", note: "n", action: "ask", ...over });
const held = (id: string, over: Partial<CoordTask> = {}): CoordTask => ({ id, title: id, repo: "web", note: "n", action: "ask", state: "queued", ...over });

describe("a card's equip", () => {
  test("a coordinator names a loadout and nothing else", () => {
    expect(validatePlan([one({ equip: { loadout: "quick", model: "opus" } })], dest({ by: "coordinator" }))).toEqual({ error: "tasks[0].equip: a coordinator names a loadout; its fields are Eric's" });
    const got = validatePlan([one({ equip: { loadout: "quick" } })], dest({ by: "coordinator" }));
    expect(got).toEqual({ tasks: [{ title: "t", repo: "web", note: "n", action: "ask", equip: { loadout: "quick" } }] });
  });
  test("Eric may override what the loadout's harness takes", () => {
    const got = validatePlan([one({ equip: { loadout: "quick", model: "opus", effort: "high", skills: ["a"], mcp: ["m"] } })], dest());
    expect(got).toEqual({ tasks: [{ title: "t", repo: "web", note: "n", action: "ask", equip: { loadout: "quick", model: "opus", effort: "high", skills: ["a"], mcp: ["m"] } }] });
  });
  test("each refusal names the field", () => {
    expect(validatePlan([one({ equip: { loadout: "nope" } })], dest())).toEqual({ error: "tasks[0].equip.loadout: no loadout nope in kit.json" });
    expect(validatePlan([one({ equip: { model: "opus" } })], dest())).toEqual({ error: "tasks[0].equip: name a loadout before changing its fields" });
    expect(validatePlan([one({ equip: { loadout: "cx", skills: ["a"] } })], dest())).toEqual({ error: "tasks[0].equip: a codex loadout takes no skills or servers" });
    expect(validatePlan([one({ equip: { loadout: "quick", model: "gpt-6-sol" } })], dest())).toEqual({ error: "tasks[0].equip.model: claude does not take gpt-6-sol" });
    expect(validatePlan([one({ equip: { loadout: "quick", effort: "huge" } })], dest())).toEqual({ error: "tasks[0].equip.effort: claude does not take huge" });
    expect(validatePlan([one({ equip: { loadout: "quick", skills: "a" } })], dest())).toEqual({ error: "tasks[0].equip.skills must be a list of names" });
    expect(validatePlan([one({ equip: "quick" })], dest())).toEqual({ error: "tasks[0].equip must be an object" });
  });
});

describe("a card's workflow", () => {
  const flows = (repo: string) => (repo === "web" ? [{ name: "review", fromRepo: false }, { name: "ship", fromRepo: true }] : []);
  test("passes when the repo lists it, and records a repo's own", () => {
    expect(validatePlan([one({ workflow: "review" })], ctxOf({ workflows: flows }))).toEqual({ tasks: [{ title: "t", repo: "web", note: "n", action: "ask", workflow: "review" }] });
    expect(validatePlan([one({ workflow: "ship" })], ctxOf({ workflows: flows }))).toEqual({ tasks: [{ title: "t", repo: "web", note: "n", action: "ask", workflow: "ship", workflowRepo: true }] });
  });
  test("a coordinator gets the bundled workflow, never the repo's", () => {
    const both = () => [{ name: "review", fromRepo: true }, { name: "review", fromRepo: false }];
    const got = validatePlan([one({ workflow: "review" })], ctxOf({ by: "coordinator", workflows: both }));
    expect(got).toEqual({ tasks: [{ title: "t", repo: "web", note: "n", action: "ask", workflow: "review" }] });
    expect(validatePlan([one({ workflow: "ship" })], ctxOf({ by: "coordinator", workflows: flows }))).toEqual({ error: "tasks[0].workflow: no workflow ship for web" });
    const own = validatePlan([one({ workflow: "review" })], ctxOf({ workflows: both }));
    expect(own).toEqual({ tasks: [{ title: "t", repo: "web", note: "n", action: "ask", workflow: "review" }] });
    expect(validatePlan([one({ workflow: "review", workflowRepo: true })], ctxOf({ workflows: both }))).toEqual({ tasks: [{ title: "t", repo: "web", note: "n", action: "ask", workflow: "review", workflowRepo: true }] });
  });
  test("an unknown name and a workflow with times are refused", () => {
    expect(validatePlan([one({ workflow: "nope" })], ctxOf({ workflows: flows }))).toEqual({ error: "tasks[0].workflow: no workflow nope for web" });
    expect(validatePlan([one({ workflow: "review", times: 2 })], ctxOf({ workflows: flows }))).toEqual({ error: "tasks[0]: a card with a workflow starts one run" });
  });
});

describe("a card's after", () => {
  const two = [held("t1"), held("t2")];
  const c = (over: Partial<PlanContext> = {}) => ctxOf({ cards: two, next: 3, ...over });
  test("names cards held or in the plan, in the order given", () => {
    const got = validatePlan([one(), one({ after: ["t1", "t3"] })], c());
    expect(got).toEqual({ tasks: [{ title: "t", repo: "web", note: "n", action: "ask" }, { title: "t", repo: "web", note: "n", action: "ask", after: ["t1", "t3"] }] });
  });
  test("refuses a card that is not there, itself, and a name twice", () => {
    expect(validatePlan([one(), one({ after: ["t9"] })], c())).toEqual({ error: "tasks[1].after: no card t9" });
    expect(validatePlan([one(), one({ after: ["t4"] })], c())).toEqual({ error: "tasks[1].after: a card cannot wait for itself" });
    expect(validatePlan([one({ after: ["t1", "t1"] })], c())).toEqual({ error: "tasks[0].after: t1 is named twice" });
    expect(validatePlan([one({ after: "t1" })], c())).toEqual({ error: "tasks[0].after must be a list of card ids" });
  });
  test("refuses cards that wait for each other, naming them in order", () => {
    expect(validatePlan([one({ after: ["t4"] }), one({ after: ["t3"] })], c())).toEqual({ error: "tasks[0].after: t3 and t4 wait for each other" });
    expect(validatePlan([one({ after: ["t4"] }), one({ after: ["t5"] }), one({ after: ["t3"] })], c())).toEqual({ error: "tasks[0].after: t3, t4 and t5 wait for each other" });
  });
  test("a chain is not a loop", () => {
    expect("tasks" in validatePlan([one({ after: ["t1"] }), one({ after: ["t3"] })], c())).toBe(true);
  });
});

describe("editCard", () => {
  const cards = (t: CoordTask) => [t, held("t2")];
  const ctx = (t: CoordTask) => dest({ cards: cards(t), next: 3 });
  test("a proposed card changes title and after", () => {
    const t = held("t1", { state: "proposed", times: 2 });
    const got = editCard(t, { title: "new", after: ["t2"] }, ctx(t));
    expect(got).toEqual({ task: { id: "t1", title: "new", repo: "web", note: "n", action: "ask", state: "proposed", times: 2, after: ["t2"] } });
  });
  test("null clears after and equip", () => {
    const t = held("t1", { state: "proposed", after: ["t2"], equip: { loadout: "quick" } });
    const got = editCard(t, { after: null, equip: null }, ctx(t));
    expect(got).toEqual({ task: { id: "t1", title: "t1", repo: "web", note: "n", action: "ask", state: "proposed" } });
  });
  test("a queued card changes its equip and after", () => {
    const t = held("t1");
    const got = editCard(t, { equip: { loadout: "quick", model: "opus" }, after: ["t2"] }, ctx(t));
    expect(got).toEqual({ task: { ...t, equip: { loadout: "quick", model: "opus" }, after: ["t2"] } });
    expect(editCard(t, { note: "x" }, ctx(t))).toEqual({ error: "t1 is queued; only its loadout and after change" });
  });
  test("a coordinator changes only after on a card carrying Eric's fields", () => {
    const t = held("t1", { state: "proposed", equip: { loadout: "quick", model: "opus", skills: ["a"] }, workflow: "ship", workflowRepo: true });
    const got = editCard(t, { after: ["t2"] }, dest({ by: "coordinator", cards: cards(t), next: 3 }));
    expect(got).toEqual({ task: { ...t, after: ["t2"] } });
    expect(editCard(t, { equip: { loadout: "quick", model: "opus" } }, dest({ by: "coordinator", cards: cards(t), next: 3 }))).toEqual({ error: "t1.equip: a coordinator names a loadout; its fields are Eric's" });
  });
  test("a queued card whose loadout is gone still takes an after change", () => {
    const t = held("t1", { equip: { loadout: "gone" }, after: ["t2"] });
    expect(editCard(t, { after: [] }, ctx(t))).toEqual({ task: { id: "t1", title: "t1", repo: "web", note: "n", action: "ask", state: "queued", equip: { loadout: "gone" } } });
    const away = held("t1", { repo: "vanished" });
    expect(editCard(away, { after: ["t2"] }, ctx(away))).toEqual({ task: { ...away, after: ["t2"] } });
  });
  test("any other state changes nothing", () => {
    const t = held("t1", { state: "running" });
    expect(editCard(t, { title: "x" }, ctx(t))).toEqual({ error: "t1 is running; only a proposed or queued card changes" });
  });
  test("errors name the card, and a loop through the card is refused", () => {
    const t = held("t1", { state: "proposed" });
    expect(editCard(t, { after: ["t1"] }, ctx(t))).toEqual({ error: "t1.after: a card cannot wait for itself" });
    expect(editCard(t, { after: ["t7"] }, ctx(t))).toEqual({ error: "t1.after: no card t7" });
    const loop = [t, held("t2", { after: ["t1"] })];
    expect(editCard(t, { after: ["t2"] }, dest({ cards: loop, next: 3 }))).toEqual({ error: "t1.after: t1 and t2 wait for each other" });
  });
});

describe("afterWait", () => {
  const landedCard = held("t1", { state: "done", outcome: "landed" });
  test("a card with nothing to wait for", () => {
    expect(afterWait(held("t2"), [])).toBeNull();
    expect(afterWait(held("t2", { after: ["t1"] }), [landedCard])).toBeNull();
    expect(cardLanded(landedCard)).toBe(true);
  });
  test("waits for cards not landed", () => {
    expect(afterWait(held("t2", { after: ["t1"] }), [held("t1")])).toEqual({ words: "waits for t1", blocked: false });
    expect(afterWait(held("t4", { after: ["t1", "t3"] }), [held("t1"), held("t3", { state: "running" })])).toEqual({ words: "waits for t1 and t3", blocked: false });
    for (const outcome of ["ready", "PR opened", "winner picked"]) {
      expect(afterWait(held("t2", { after: ["t1"] }), [held("t1", { state: "done", outcome })])).toEqual({ words: "waits for t1", blocked: false });
    }
  });
  test("a card that will not land blocks", () => {
    const t = held("t2", { after: ["t1"] });
    expect(afterWait(t, [held("t1", { state: "failed" })])).toEqual({ words: "waits for t1, which failed", blocked: true });
    expect(afterWait(t, [held("t1", { state: "dropped" })])).toEqual({ words: "waits for t1, which was dropped", blocked: true });
    expect(afterWait(t, [])).toEqual({ words: "waits for t1, which was removed", blocked: true });
  });
  test("may land later is the three words Eric can still land", () => {
    expect(MAY_LAND_LATER).toEqual(["ready", "PR opened", "winner picked"]);
  });
});

describe("nextToStart with held, after and first", () => {
  const repoFull = () => false;
  test("a held coordinator starts nothing", () => {
    const tasks = [held("t1")];
    expect(nextToStart(tasks, { working: 0, repoFull, cards: tasks, held: true })).toEqual([]);
  });
  test("a card that waits is skipped, and a later one goes ahead", () => {
    const tasks = [held("t1", { after: ["t3"] }), held("t2"), held("t3", { state: "running" })];
    expect(nextToStart(tasks, { working: 1, repoFull, cards: tasks }).map((t) => t.id)).toEqual(["t2"]);
    const done = [held("t1", { after: ["t3"] }), held("t3", { state: "done", outcome: "landed" })];
    expect(nextToStart(done, { working: 0, repoFull, cards: done }).map((t) => t.id)).toEqual(["t1"]);
  });
  test("first goes before the rest", () => {
    const tasks = [held("t1"), held("t2"), held("t3")];
    expect(nextToStart(tasks, { working: 2, repoFull, cards: tasks, first: ["t3"] }).map((t) => t.id)).toEqual(["t3"]);
    expect(nextToStart(tasks, { working: 0, repoFull, cards: tasks, first: ["t3", "t2"] }).map((t) => t.id)).toEqual(["t3", "t2", "t1"]);
  });
});

describe("a merged PR", () => {
  test("lands a ready branch", () => {
    expect(childOutcome(child(), { prMerged: true })).toEqual({ state: "done", outcome: "landed" });
    expect(childOutcome(child(), { prUrl: "https://github.com/x/web/pull/7", prMerged: true })).toEqual({ state: "done", outcome: "landed" });
  });
});

describe("a card's flow settling", () => {
  const flow = (over: Partial<Flow> = {}): Flow => ({
    id: "f1", repoId: "web", workflow: "review", verb: "review", note: "n", status: "done",
    steps: [{ name: "look", status: "passed", summary: "Found two nits." }, { name: "fix", status: "passed", summary: "Fixed both." }],
    current: 1, startedAt: 1, branch: branch(), ...over,
  });
  test("a flow that is going is not settled", () => {
    for (const status of ["working", "waiting", "gated"] as const) expect(flowSettled(flow({ status }), {}, true)).toBeNull();
  });
  test("failed and stopped", () => {
    expect(flowSettled(flow({ status: "failed" }), {}, false)).toEqual({ state: "failed", outcome: "failed" });
    expect(flowSettled(flow({ status: "stopped" }), {}, false)).toEqual({ state: "failed", outcome: "stopped" });
  });
  test("a done flow settles by its branch", () => {
    expect(flowSettled(flow({ branch: branch({ state: "nothing" }) }), {}, false)).toEqual({ state: "done", outcome: "no change" });
    expect(flowSettled(flow({ branch: undefined }), {}, false)).toEqual({ state: "done", outcome: "no change" });
    expect(flowSettled(flow({ branch: branch({ state: "uncommitted" }) }), {}, false)).toEqual({ state: "failed", outcome: "uncommitted" });
    expect(flowSettled(flow({ branch: branch({ state: "working" }) }), {}, true)).toBeNull();
  });
  test("a ready branch waits as a run's does", () => {
    const queued = { entry: entry(), entries: [entry()] };
    expect(flowSettled(flow(), { verdict: "auto", ...queued }, true)).toBeNull();
    expect(flowSettled(flow(), {}, false)).toBeNull();
    expect(flowSettled(flow(), landed(), false)).toEqual({ state: "done", outcome: "landed" });
    expect(flowSettled(flow(), { verdict: "approve" }, false)).toEqual({ state: "done", outcome: "ready" });
    expect(flowSettled(flow(), {}, true)).toEqual({ state: "done", outcome: "ready" });
  });
  const t: CoordTask = { id: "t1", title: "tidy", repo: "web", note: "n", action: "ask", state: "running" };
  test("the note follows the run's, with the workflow and the last step's line", () => {
    expect(flowNote(t, flow(), landed())).toBe([
      "canopy: a task you started has settled",
      "task t1: tidy (repo web)",
      "outcome: landed",
      "result: review done, fix: Fixed both.",
      "branch: run/fix-login-ab12cd34, landed",
    ].join("\n"));
  });
  test("a failed step's reason is the line, and a PR replaces the branch", () => {
    const f = flow({ status: "failed", steps: [{ name: "look", status: "passed" }, { name: "check", status: "failed", reason: "tests red" }] });
    expect(flowNote(t, f, { prUrl: "https://github.com/x/web/pull/7" })).toBe([
      "canopy: a task you started has settled",
      "task t1: tidy (repo web)",
      "outcome: failed",
      "result: review failed, check: tests red",
      "PR: https://github.com/x/web/pull/7",
    ].join("\n"));
  });
  test("no step line, no branch", () => {
    expect(flowNote(t, flow({ steps: [], branch: undefined, status: "stopped" }))).toContain("result: review stopped\n".trimEnd());
  });
});

describe("the notes a card sends", () => {
  const t: CoordTask = { id: "t2", title: "tidy the docs", repo: "api", note: "n", action: "ask", state: "queued" };
  test("hold and resume", () => {
    expect(holdNote(true)).toBe("canopy: Eric held the goal; no new card starts until he resumes it");
    expect(holdNote(false)).toBe("canopy: Eric resumed the goal; queued cards start again");
  });
  test("landed and blocked", () => {
    const n = landedNote({ ...t, id: "t1" });
    expect(n.startsWith("canopy: task t1 (")).toBe(true);
    expect(n.endsWith(") landed; cards that wait for it can start")).toBe(true);
    expect(n).toBe("canopy: task t1 (tidy the docs) landed; cards that wait for it can start");
    expect(blockedNote(t, "waits for t1, which failed")).toBe("canopy: task t2 (tidy the docs) waits for t1, which failed; it stays queued until Eric takes its after off or removes it");
  });
});

describe("what the coordinator reads of workflows", () => {
  const entry = (name: string, source: WorkflowSource, extra: Partial<Workflow> = {}): WorkflowEntry => ({
    ok: true,
    workflow: {
      name,
      label: `Label ${name}`,
      verb: name,
      blurb: `does ${name}`,
      when: "always",
      expectsChange: true,
      notePlaceholder: "",
      noteRequired: false,
      steps: [
        { name: "build", tools: [], turns: 5, check: "bun test", gate: "continue", body: "SECRET BODY", retries: 0, back: "build", evidence: [], after: [], mode: "auto" },
        { name: "look", tools: [], turns: 5, check: null, gate: "ask", body: "more", retries: 0, back: "look", evidence: [], after: ["build"], mode: "manual" },
      ],
      budget: null,
      source,
      file: `/abs/${name}.md`,
      ...extra,
    } as Workflow,
  });
  test("only parsed, listed, bundled and user entries, with no file path and no step body", () => {
    const out = coordWorkflows([
      entry("ship", "bundled"),
      entry("mine", "user"),
      entry("theirs", "repo"),
      entry("scout", "bundled", { listed: false }),
      { ok: false, name: "broken", source: "user", file: "/abs/broken.md", error: "bad" },
    ]);
    expect(out.map((w) => w.name)).toEqual(["ship", "mine"]);
    expect(out[0]).toEqual({
      name: "ship",
      label: "Label ship",
      blurb: "does ship",
      source: "bundled",
      steps: [
        { name: "build", gate: "continue", mode: "auto" },
        { name: "look", gate: "ask", mode: "manual" },
      ],
    });
    expect(JSON.stringify(out)).not.toContain("SECRET BODY");
    expect(JSON.stringify(out)).not.toContain("/abs/");
  });
});

describe("Eric's standing rules in the brief", () => {
  test("they follow the brief under their own heading, trimmed", () => {
    expect(withStandingRules("BRIEF", "  Prefer the quick loadout.\n")).toBe("BRIEF\n\n## Eric's standing rules\n\nPrefer the quick loadout.");
  });
  test("none, or blank, leaves the brief", () => {
    expect(withStandingRules("BRIEF", null)).toBe("BRIEF");
    expect(withStandingRules("BRIEF", " \n\t ")).toBe("BRIEF");
  });
});
