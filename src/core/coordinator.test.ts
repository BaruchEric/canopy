import { describe, expect, test } from "bun:test";
import { childOutcome, COORD_AT_ONCE, MAX_PLAN, MAX_TASKS, nextToStart, settleNote, validatePlan, type ChildLanding } from "./coordinator";
import { FLEET_CONCURRENCY } from "./flow";
import type { CoordTask, LandEntry, Run, RunBranch } from "./types";

const known = (repo: string): "local" | "remote" | null => (repo === "web" || repo === "api" ? "local" : repo === "mini:box" ? "remote" : null);
const task = (over: Record<string, unknown> = {}) => ({ title: "fix the login", repo: "web", note: "the login form drops the email", action: "propose", ...over });
const plan = (tasks: unknown, have = 0) => validatePlan(tasks, { known, have });

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
    expect(nextToStart(tasks, { working: 0, repoFull: () => false }).map((t) => t.id)).toEqual(["t1", "t2", "t3"]);
    expect(nextToStart(tasks, { working: 2, repoFull: () => false }).map((t) => t.id)).toEqual(["t1"]);
    expect(nextToStart(tasks, { working: 3, repoFull: () => false })).toEqual([]);
  });

  test("passes over cards that are not queued", () => {
    const tasks = [card("t1", "web", "proposed"), card("t2", "web", "running"), card("t3", "web", "done"), card("t4", "web")];
    expect(nextToStart(tasks, { working: 1, repoFull: () => false }).map((t) => t.id)).toEqual(["t4"]);
  });

  test("a card whose repo is full waits, and a later one in another repo goes ahead of it", () => {
    const tasks = [card("t1", "web"), card("t2", "api"), card("t3", "web"), card("t4", "api")];
    expect(nextToStart(tasks, { working: 1, repoFull: (r) => r === "web" }).map((t) => t.id)).toEqual(["t2", "t4"]);
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

  test("a failure, a stop and a branch with nothing to land are failed or empty", () => {
    expect(childOutcome(child({ status: "failed", error: "boom", branch: branch({ state: "nothing" }) }))).toEqual({ state: "failed", outcome: "failed" });
    expect(childOutcome(child({ status: "stopped", branch: branch({ state: "uncommitted" }) }))).toEqual({ state: "failed", outcome: "stopped" });
    expect(childOutcome(child({ branch: branch({ state: "uncommitted" }) }))).toEqual({ state: "failed", outcome: "uncommitted" });
    expect(childOutcome(child({ branch: branch({ state: "nothing" }) }))).toEqual({ state: "done", outcome: "no change" });
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

  test("a PR is named by its address, and a result keeps to one line", () => {
    const note = settleNote(t, child({ result: { text: "Opened it.\n\nAll green.", durationMs: 1, turns: 1 } }), { prUrl: "https://github.com/x/web/pull/7" });
    expect(note).toContain("result: Opened it. All green.");
    expect(note).toContain("PR: https://github.com/x/web/pull/7");
    expect(note).not.toContain("branch: ");
  });
});
