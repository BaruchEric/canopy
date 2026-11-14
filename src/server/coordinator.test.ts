import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { blockedNote, CARDS_NOW, flowGoneNote, flowNote, holdNote, landedNote, lateFailNote, treeNote, validatePlan, type ChildBranch } from "../core/coordinator";
import { EMPTY_LOADOUTS } from "../core/loadout";
import type { RunGroup } from "../core/group";
import type { CoordTask, Flow, LandEntry, Loadout, LoadoutsInfo, Run, RunBranch } from "../core/types";
import type { Caller } from "./callers";
import type { WorkState } from "../core/work";
import { CoordinatorHub, type ChildResume, type CoordinatorDeps } from "./coordinator";

let runs: Map<string, Run>;
let said: { id: string; text: string; cards?: string }[];
let started: { coord: string; task: string }[];
let full: Set<string>;
let refuse: Map<string, string>;
let busy: Set<string>;
let branches: Map<string, ChildBranch>;
let sent: number;
let clock: number;
let n: number;
let made: CoordinatorHub[];
let asked: { repo: string; withRepo: boolean }[];
let flows: Map<string, Flow>;

const lo = (over: Partial<Loadout> = {}): Loadout => ({ name: "quick", note: "", harness: "claude", model: "default", effort: "default", skills: [], mcp: [], canopyTools: false, ...over });
const kit: LoadoutsInfo = { base: [], loadouts: [lo()], errors: [], servers: [] };

const coordinator = (over: Partial<Run> = {}): Run => {
  const r = {
    id: "co1",
    repoId: "web",
    action: "coordinate",
    verb: "coordinate",
    progress: "coordinating",
    expectsChange: false,
    chat: true,
    harness: "claude",
    note: "",
    status: "working",
    startedAt: 1,
    steps: [],
    prompt: null,
    ...over,
  } as Run;
  runs.set(r.id, r);
  return r;
};

const branch = (id: string, state: RunBranch["state"] = "working"): RunBranch => ({ name: `run/x-${id}`, target: "main", base: "b", dir: `/w/${id}`, state, origin: `br-${id}`, work: "w-test2345" });

const page: Caller = { id: "p1", kind: "page", label: "page mac", created: 0, used: 0 };
const coordCaller = (run?: string): Caller => ({ id: "k1", kind: "coordinator", label: "coordinator web", ...(run ? { run } : {}), created: 0, used: 0 });

function hub(over: Partial<CoordinatorDeps> = {}): CoordinatorHub {
  const deps: CoordinatorDeps = {
    run: (id) => runs.get(id),
    runs: () => [...runs.values()],
    startChild: async (coordId, task) => {
      const why = refuse.get(task.repo);
      if (why) throw new Error(why);
      if (busy.has(task.repo)) return { busy: `${task.repo} has 3 branch runs going` };
      started.push({ coord: coordId, task: task.id });
      if (task.workflow) {
        // a card that names a workflow starts one flow on a branch of its own
        const id = `fl${++n}`;
        const flow: Flow = { id, repoId: task.repo, workflow: task.workflow, verb: task.workflow, note: task.note, status: "working", steps: [{ name: "Build", status: "running" }], current: 0, startedAt: clock, branch: branch(id) };
        flows.set(id, flow);
        h.onFlow(flow);
        return { flow };
      }
      const child = { id: `c${++n}`, repoId: task.repo, action: task.action, status: "working", startedAt: clock, steps: [], note: task.note, by: "coordinator", parent: coordId, branch: branch(`c${n}`) } as unknown as Run;
      runs.set(child.id, child);
      // the runner tells everyone about a run before its start returns
      h.onRun(child);
      return { run: child };
    },
    say: (id, text) => {
      const co = runs.get(id);
      if (co?.status !== "idle") throw new Error("still replying");
      // each note ends with every card's state; the tests read the two apart
      const at = text.lastIndexOf(`\n${CARDS_NOW}`);
      said.push(at >= 0 ? { id, text: text.slice(0, at), cards: text.slice(at + 1) } : { id, text });
      co.status = "working";
      h.onRun(co);
    },
    repoFull: (repo) => full.has(repo),
    known: (repo) => (repo === "web" || repo === "api" ? "local" : repo === "mini:box" ? "remote" : null),
    landing: (run) => branches.get(run.id) ?? {},
    // a child's branch is br-<child id>, so the branch's facts are its child's
    branch: (origin) => branches.get(origin.replace(/^br-/, "")) ?? {},
    flow: (id) => flows.get(id),
    loadouts: () => kit,
    workflows: async (repo, withRepo) => {
      asked.push({ repo, withRepo });
      return [{ name: "review", fromRepo: false }, ...(withRepo && repo === "web" ? [{ name: "local", fromRepo: true }] : [])];
    },
    broadcast: () => {
      sent++;
    },
    now: () => clock,
    readyWait: 1000,
    ...over,
  };
  const h = new CoordinatorHub(deps);
  made.push(h);
  return h;
}

async function post(h: CoordinatorHub, act: string, body: unknown, caller: Caller | null = page): Promise<{ status: number; body: Record<string, unknown> }> {
  const req = new Request(`http://x/api/coordinator/${act}`, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });
  const res = await h.handle(req, new URL(req.url), caller);
  if (!res) throw new Error(`no answer for ${act}`);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

const task = (over: Record<string, unknown> = {}) => ({ title: "fix the login", repo: "web", note: "the login form drops the email", action: "propose", ...over });
const cards = (id = "co1"): CoordTask[] => runs.get(id)?.tasks ?? [];
const card = (taskId: string, id = "co1"): CoordTask | undefined => cards(id).find((t) => t.id === taskId);
const child = (taskId: string): Run => {
  const r = runs.get(card(taskId)?.run ?? "");
  if (!r) throw new Error(`${taskId} has no child`);
  return r;
};

/** a child ends: done with its branch read as `state`, or failed */
function end(h: CoordinatorHub, taskId: string, how: { status?: Run["status"]; branch?: RunBranch["state"]; result?: string } = {}): Run {
  const r = child(taskId);
  r.status = how.status ?? "done";
  r.endedAt = clock;
  if (r.branch) r.branch = { ...r.branch, state: how.branch ?? (r.status === "done" ? "ready" : "nothing") };
  if (how.result) r.result = { text: how.result, durationMs: 1, turns: 1 };
  if (r.status === "failed") r.error = "it fell over";
  h.onRun(r);
  return r;
}

function goIdle(h: CoordinatorHub, id = "co1"): void {
  const co = runs.get(id);
  if (!co) throw new Error(`no ${id}`);
  co.status = "idle";
  h.onRun(co);
}

const entry = (taskId: string, state: LandEntry["state"]): LandEntry => {
  const b = child(taskId).branch;
  return { id: b?.origin ?? "", repoId: "web", repoPath: "/r/web", branch: b?.name ?? "", target: "main", dir: b?.dir ?? "", note: "n", state, tries: 0, queuedAt: 1, updatedAt: 1 };
};

const settled = async (h: CoordinatorHub): Promise<void> => {
  await h.idle();
};

async function planFive(h: CoordinatorHub): Promise<void> {
  const tasks = [task(), task({ repo: "api", action: "ask" }), task({ title: "three" }), task({ title: "four", repo: "api" }), task({ title: "five" })];
  expect((await post(h, "plan", { run: "co1", tasks })).status).toBe(200);
}

beforeEach(() => {
  runs = new Map();
  said = [];
  started = [];
  full = new Set();
  refuse = new Map();
  busy = new Set();
  branches = new Map();
  sent = 0;
  clock = 10_000;
  n = 0;
  made = [];
  asked = [];
  flows = new Map();
  coordinator();
});

afterEach(() => {
  for (const h of made) h.stop();
});

describe("the plan route", () => {
  test("adds the tasks as proposed cards numbered per coordinator, and says which", async () => {
    const h = hub();
    const first = await post(h, "plan", { run: "co1", tasks: [task(), task({ repo: "api", action: "ask", title: "  tidy  " })] });
    expect(first.status).toBe(200);
    expect(first.body["ok"]).toBe(true);
    expect((first.body["added"] as CoordTask[]).map((t) => t.id)).toEqual(["t1", "t2"]);
    expect(cards()).toEqual([
      { id: "t1", title: "fix the login", repo: "web", note: "the login form drops the email", action: "propose", state: "proposed" },
      { id: "t2", title: "tidy", repo: "api", note: "the login form drops the email", action: "ask", state: "proposed" },
    ]);
    const second = await post(h, "plan", { run: "co1", tasks: [task()] });
    expect((second.body["added"] as CoordTask[]).map((t) => t.id)).toEqual(["t3"]);
    expect(sent).toBe(2);
  });

  test("a bad plan answers 400 with the reason, and adds nothing", async () => {
    const h = hub();
    expect(await post(h, "plan", { run: "co1", tasks: [task(), task({ repo: "mini:box" })] })).toEqual({
      status: 400,
      body: { error: "tasks[1].repo: mini:box is on another host; a task runs in a local repo" },
    });
    expect((await post(h, "plan", { run: "co1", tasks: Array.from({ length: 9 }, () => task()) })).body).toEqual({ error: "at most 8 tasks per plan; this one has 9" });
    expect(cards()).toEqual([]);
  });

  test("a coordinator's token plans for its own run only, and may leave the run out", async () => {
    coordinator({ id: "co2", repoId: "api" });
    const h = hub();
    expect(await post(h, "plan", { run: "co2", tasks: [task()] }, coordCaller("co1"))).toEqual({ status: 403, body: { error: "a coordinator's token plans for its own run only" } });
    expect((await post(h, "plan", { run: "co1", tasks: [task()] }, coordCaller())).status).toBe(403);
    expect(cards("co2")).toEqual([]);
    expect((await post(h, "plan", { tasks: [task()] }, coordCaller("co1"))).status).toBe(200);
    expect(cards("co1").map((t) => t.id)).toEqual(["t1"]);
    // a page may post for any coordinator
    expect((await post(h, "plan", { run: "co2", tasks: [task()] })).status).toBe(200);
  });

  test("takes a plan only for a coordinator still going", async () => {
    runs.set("r9", { ...coordinator({ id: "r9" }), action: "ask" });
    coordinator({ id: "co3", status: "stopped" });
    const h = hub();
    expect(await post(h, "plan", { run: "nope", tasks: [task()] })).toEqual({ status: 404, body: { error: "no run nope" } });
    expect(await post(h, "plan", { run: "r9", tasks: [task()] })).toEqual({ status: 409, body: { error: "r9 is not a coordinator" } });
    expect(await post(h, "plan", { run: "co3", tasks: [task()] })).toEqual({ status: 409, body: { error: "coordinator co3 has ended" } });
    expect(await post(h, "plan", { run: 7, tasks: [task()] })).toEqual({ status: 400, body: { error: "missing run" } });
  });

  test("answers only its own routes", async () => {
    const h = hub();
    const req = new Request("http://x/api/coordinator/other", { method: "POST", body: "{}" });
    expect(await h.handle(req, new URL(req.url), page)).toBeNull();
    const get = new Request("http://x/api/coordinator/plan");
    expect(await h.handle(get, new URL(get.url), page)).toBeNull();
  });
});

describe("the tasks route", () => {
  test("edits a proposed card under the plan's limits, and removes one", async () => {
    const h = hub();
    await post(h, "plan", { run: "co1", tasks: [task(), task({ title: "two" })] });
    const edited = await post(h, "tasks", { run: "co1", id: "t1", title: "fix the signup", action: "ask" });
    expect(edited.status).toBe(200);
    expect(edited.body["task"]).toEqual({ id: "t1", title: "fix the signup", repo: "web", note: "the login form drops the email", action: "ask", state: "proposed" });
    expect(await post(h, "tasks", { run: "co1", id: "t1", repo: "nowhere" })).toEqual({ status: 400, body: { error: "t1.repo: no repo nowhere on this backend" } });
    expect(await post(h, "tasks", { run: "co1", id: "t1", remove: true })).toEqual({ status: 200, body: { ok: true, removed: "t1" } });
    expect(cards().map((t) => t.id)).toEqual(["t2"]);
    // a removed card's number is not given out again
    const more = await post(h, "plan", { run: "co1", tasks: [task()] });
    expect((more.body["added"] as CoordTask[]).map((t) => t.id)).toEqual(["t3"]);
    expect(await post(h, "tasks", { run: "co1", id: "t9", title: "x" })).toEqual({ status: 404, body: { error: "no card t9" } });
  });

  test("refuses to edit or remove a card that has started", async () => {
    const h = hub();
    await post(h, "plan", { run: "co1", tasks: [task()] });
    await post(h, "start", { run: "co1" });
    expect(card("t1")?.state).toBe("running");
    expect(await post(h, "tasks", { run: "co1", id: "t1", title: "other" })).toEqual({ status: 409, body: { error: "t1 is running; only a proposed or queued card changes" } });
    expect((await post(h, "tasks", { run: "co1", id: "t1", remove: true })).status).toBe(409);
  });

  test("a coordinator's token neither edits nor starts cards", async () => {
    const h = hub();
    await post(h, "plan", { run: "co1", tasks: [task()] });
    expect((await post(h, "tasks", { run: "co1", id: "t1", title: "x" }, coordCaller("co1"))).status).toBe(403);
    expect((await post(h, "start", { run: "co1" }, coordCaller("co1"))).status).toBe(403);
    expect(card("t1")?.state).toBe("proposed");
  });
});

describe("start these", () => {
  test("starts 3 of 5 as children of the coordinator and queues 2", async () => {
    const h = hub();
    await planFive(h);
    const res = await post(h, "start", { run: "co1" });
    expect(res.status).toBe(200);
    expect(cards().map((t) => t.state)).toEqual(["running", "running", "running", "queued", "queued"]);
    expect(started).toEqual([
      { coord: "co1", task: "t1" },
      { coord: "co1", task: "t2" },
      { coord: "co1", task: "t3" },
    ]);
    expect(child("t1").parent).toBe("co1");
    expect((res.body["tasks"] as CoordTask[]).length).toBe(5);
    expect(await post(h, "start", { run: "co1" })).toEqual({ status: 409, body: { error: "no proposed cards to start" } });
  });

  test("a child settling starts the next card and queues a note", async () => {
    const h = hub();
    await planFive(h);
    await post(h, "start", { run: "co1" });
    end(h, "t2", { status: "failed" });
    await settled(h);
    expect(card("t2")).toMatchObject({ state: "failed", outcome: "failed" });
    expect(card("t4")?.state).toBe("running");
    expect(card("t5")?.state).toBe("queued");
    expect(said).toEqual([]);
    goIdle(h);
    await settled(h);
    expect(said.length).toBe(1);
    expect(said[0]?.text).toContain("canopy: a task you started has settled");
    expect(said[0]?.text).toContain("task t2: fix the login (repo api)");
    expect(said[0]?.text).toContain("outcome: failed");
  });

  test("a child that ended waiting on the landing queue frees its slot", async () => {
    const h = hub();
    await planFive(h);
    await post(h, "start", { run: "co1" });
    branches.set("c1", { verdict: "auto" });
    end(h, "t1");
    await settled(h);
    expect(card("t1")?.state).toBe("running");
    expect(card("t4")?.state).toBe("running");
  });

  test("a card whose repo is full waits with the reason, and starts once a slot frees", async () => {
    full.add("web");
    const h = hub();
    await post(h, "plan", { run: "co1", tasks: [task(), task({ repo: "api" })] });
    await post(h, "start", { run: "co1" });
    expect(card("t1")).toMatchObject({ state: "queued", outcome: "waiting for a branch slot in web" });
    expect(card("t2")?.state).toBe("running");
    // a run of anyone's ending in web frees the slot
    full.delete("web");
    h.onRun({ ...coordinator({ id: "other", action: "ask" }), status: "done" });
    await settled(h);
    expect(card("t1")?.state).toBe("running");
    expect(card("t1")?.outcome).toBeUndefined();
  });

  test("a start that finds the repo busy leaves the card queued", async () => {
    busy.add("web");
    const h = hub();
    await post(h, "plan", { run: "co1", tasks: [task()] });
    await post(h, "start", { run: "co1" });
    expect(card("t1")).toMatchObject({ state: "queued", outcome: "waiting for a branch slot in web" });
  });

  test("a failed start marks the card failed with the error and queues a note", async () => {
    refuse.set("api", "api has no main or master branch to cut a run's branch from");
    coordinator({ status: "idle" });
    const h = hub();
    await post(h, "plan", { run: "co1", tasks: [task({ repo: "api" }), task()] });
    await post(h, "start", { run: "co1" });
    await settled(h);
    expect(card("t1")).toMatchObject({ state: "failed", outcome: "api has no main or master branch to cut a run's branch from" });
    expect(card("t2")?.state).toBe("running");
    expect(said.length).toBe(1);
    expect(said[0]?.text).toContain("canopy: a task you started could not start");
    expect(said[0]?.text).toContain("task t1: fix the login (repo api)");
  });
});

describe("settle notes", () => {
  test("wait for the coordinator to go idle and go one per idle turn, in order", async () => {
    const h = hub();
    await planFive(h);
    await post(h, "start", { run: "co1" });
    end(h, "t1", { status: "failed" });
    end(h, "t3", { status: "stopped" });
    await settled(h);
    expect(said).toEqual([]);
    goIdle(h);
    await settled(h);
    expect(said.map((s) => s.text.split("\n")[1])).toEqual(["task t1: fix the login (repo web)"]);
    expect(runs.get("co1")?.status).toBe("working");
    goIdle(h);
    await settled(h);
    expect(said.map((s) => s.text.split("\n")[1])).toEqual(["task t1: fix the login (repo web)", "task t3: three (repo web)"]);
    goIdle(h);
    await settled(h);
    expect(said.length).toBe(2);
  });

  test("a ready child waits for the landing queue's word, then says landed", async () => {
    coordinator({ status: "idle" });
    const h = hub();
    await post(h, "plan", { run: "co1", tasks: [task()] });
    await post(h, "start", { run: "co1" });
    branches.set("c1", { verdict: "auto" });
    end(h, "t1", { result: "Fixed it." });
    await settled(h);
    expect(card("t1")?.state).toBe("running");
    branches.set("c1", { verdict: "auto", entry: entry("t1", "gate"), entries: [entry("t1", "gate")] });
    h.recheck();
    await settled(h);
    expect(card("t1")?.state).toBe("running");
    branches.set("c1", { verdict: "auto", entry: entry("t1", "landed"), entries: [entry("t1", "landed")] });
    h.recheck();
    await settled(h);
    expect(card("t1")).toMatchObject({ state: "done", outcome: "landed" });
    expect(said[0]?.text).toContain("outcome: landed");
    expect(said[0]?.text).toContain("branch: run/x-c1, landed");
  });

  test("a card carries its child's item and notes how it settled", async () => {
    const notes: string[] = [];
    coordinator({ status: "idle" });
    const h = hub({ work: { note: (id, t) => notes.push(`${id} ${t}`), close: () => {}, link: () => {} } });
    await post(h, "plan", { run: "co1", tasks: [task()] });
    await post(h, "start", { run: "co1" });
    expect(card("t1")?.work).toBe("w-test2345");
    branches.set("c1", { verdict: "auto" });
    end(h, "t1", { result: "Fixed it." });
    await settled(h);
    branches.set("c1", { verdict: "auto", entry: entry("t1", "landed"), entries: [entry("t1", "landed")] });
    h.recheck();
    await settled(h);
    expect(card("t1")).toMatchObject({ state: "done", outcome: "landed", work: "w-test2345" });
    expect(notes).toEqual(["w-test2345 card t1 settled: landed"]);
  });

  test("a sent-back child, a PR and a branch left to Eric each settle it", async () => {
    coordinator({ status: "idle" });
    const h = hub();
    await post(h, "plan", { run: "co1", tasks: [task(), task({ title: "two" }), task({ title: "three" })] });
    await post(h, "start", { run: "co1" });
    branches.set("c1", { verdict: "auto", entry: entry("t1", "red"), entries: [entry("t1", "red")] });
    branches.set("c2", { openPr: true, prUrl: "https://github.com/x/web/pull/7" });
    branches.set("c3", { verdict: "approve" });
    end(h, "t1");
    end(h, "t2");
    end(h, "t3");
    await settled(h);
    expect(cards().map((t) => [t.state, t.outcome])).toEqual([
      ["failed", "sent back"],
      ["done", "PR opened"],
      ["done", "ready"],
    ]);
  });

  test("a ready child the queue never took settles ready once overdue", async () => {
    const h = hub();
    await post(h, "plan", { run: "co1", tasks: [task()] });
    await post(h, "start", { run: "co1" });
    end(h, "t1");
    await settled(h);
    expect(card("t1")?.state).toBe("running");
    clock += 1000;
    h.recheck();
    expect(card("t1")).toMatchObject({ state: "done", outcome: "ready" });
  });

  test("a child still in the queue past the wait sets no timer, and waits on the queue's own word", async () => {
    let looks = 0;
    const h = hub({
      landing: (run) => {
        looks++;
        return branches.get(run.id) ?? {};
      },
      // the wait has passed the moment the child ends
      readyWait: 0,
    });
    await post(h, "plan", { run: "co1", tasks: [task()] });
    await post(h, "start", { run: "co1" });
    branches.set("c1", { verdict: "auto", entry: entry("t1", "queued"), entries: [entry("t1", "queued")] });
    end(h, "t1");
    await settled(h);
    const after = looks;
    await new Promise((r) => setTimeout(r, 200));
    expect(looks).toBe(after);
    expect(h.waiting()).toBe(0);
    expect(card("t1")?.state).toBe("running");
    branches.set("c1", { verdict: "auto", entry: entry("t1", "landed"), entries: [entry("t1", "landed")] });
    h.recheck();
    expect(card("t1")).toMatchObject({ state: "done", outcome: "landed" });
  });

  test("a coordinator ending clears the timers its children's cards waited on", async () => {
    const h = hub();
    await post(h, "plan", { run: "co1", tasks: [task()] });
    await post(h, "start", { run: "co1" });
    end(h, "t1");
    await settled(h);
    expect(h.waiting()).toBe(1);
    const co = runs.get("co1");
    if (!co) throw new Error("no co1");
    co.status = "stopped";
    h.onRun(co);
    expect(h.waiting()).toBe(0);
  });
});

describe("a branch flow ending", () => {
  test("pumps a coordinator whose card waits for a slot in its repo", async () => {
    const h = hub();
    full.add("web");
    await post(h, "plan", { run: "co1", tasks: [task()] });
    await post(h, "start", { run: "co1" });
    expect(card("t1")).toMatchObject({ state: "queued", outcome: "waiting for a branch slot in web" });
    full.delete("web");
    const someone = (over: Partial<Flow>): Flow => ({ id: "other", repoId: "web", workflow: "fix", verb: "fix", note: "", status: "working", steps: [], current: 0, startedAt: 1, branch: branch("other"), ...over });
    h.onFlow(someone({}));
    await settled(h);
    expect(card("t1")?.state).toBe("queued");
    const { branch: _b, ...inCheckout } = someone({ status: "done" });
    h.onFlow(inCheckout);
    await settled(h);
    expect(card("t1")?.state).toBe("queued");
    h.onFlow(someone({ status: "done" }));
    await settled(h);
    expect(card("t1")?.state).toBe("running");
  });
});

describe("the coordinator ending", () => {
  test("drops its proposed and queued cards and its waiting notes, and leaves its children alone", async () => {
    const h = hub();
    await planFive(h);
    await post(h, "start", { run: "co1" });
    await post(h, "plan", { run: "co1", tasks: [task({ title: "six" })] });
    end(h, "t1", { status: "failed" });
    await settled(h);
    const co = runs.get("co1");
    if (!co) throw new Error("no co1");
    co.status = "stopped";
    h.onRun(co);
    await settled(h);
    expect(cards().map((t) => [t.id, t.state])).toEqual([
      ["t1", "failed"],
      ["t2", "running"],
      ["t3", "running"],
      ["t4", "running"],
      ["t5", "dropped"],
      ["t6", "dropped"],
    ]);
    expect(child("t2").status).toBe("working");
    // a child that ends later still moves its card, but nothing is said
    end(h, "t2", { status: "failed" });
    await settled(h);
    expect(card("t2")?.state).toBe("failed");
    expect(said).toEqual([]);
    expect(started.length).toBe(4);
  });
});

describe("the brief", () => {
  test("sends the token, names the plan route, and its example is a plan canopy takes", async () => {
    const brief = await readFile(join(import.meta.dir, "../../lib/coordinator.md"), "utf8");
    // the server uses it as is: nothing in it is filled in
    expect(brief).not.toContain("{{");
    expect(brief).toContain('-H "X-Canopy-Token: $CANOPY_TOKEN"');
    expect(brief).toContain("$CANOPY_API/api/coordinator/plan");
    const example = /<<'EOF'\n([\s\S]*?)\n\s*EOF\n/.exec(brief)?.[1];
    if (!example) throw new Error("no example in the brief");
    const body = JSON.parse(example) as { tasks: unknown };
    expect("tasks" in validatePlan(body.tasks, { known: () => "local", cards: [], next: 1, loadouts: EMPTY_LOADOUTS, workflows: () => [], by: "person", files: [], treeCard: () => false })).toBe(true);
  });
});

describe("capacity (FR-036 plan 2)", () => {
  const HOLD = "waiting for capacity: the 5-hour window is spent (resets 15:00)";
  const LIMIT = "You've hit your limit · resets 3pm";

  test("a held start leaves every queued card waiting with the governor's words; a wake starts them; a release goes as interactive", async () => {
    let held = true;
    const priorities: (string | undefined)[] = [];
    const h = hub({
      startChild: async (coordId, t, priority) => {
        priorities.push(priority);
        if (held && priority !== "interactive") return { busy: HOLD };
        started.push({ coord: coordId, task: t.id });
        const c = { id: `c${++n}`, repoId: t.repo, action: t.action, status: "working", startedAt: clock, steps: [], note: t.note, by: "coordinator", parent: coordId, branch: branch(`c${n}`) } as unknown as Run;
        runs.set(c.id, c);
        h.onRun(c);
        return { run: c };
      },
    });
    await post(h, "plan", { run: "co1", tasks: [task(), task({ title: "two" })] });
    await post(h, "start", { run: "co1" });
    await settled(h);
    expect(cards().map((t) => [t.state, t.outcome])).toEqual([["queued", HOLD], ["queued", HOLD]]);
    // one start is tried for the pair: they share the window
    expect(priorities).toEqual(["normal"]);
    expect(h.heldStarts().map((x) => [x.id, x.priority, x.why])).toEqual([["card:co1:t1", "normal", HOLD], ["card:co1:t2", "normal", HOLD]]);
    await h.release("co1", "t1");
    await settled(h);
    expect(card("t1")?.state).toBe("running");
    expect(priorities.at(-2)).toBe("interactive");
    held = false;
    h.wake(() => true);
    await settled(h);
    expect(cards().map((t) => t.state)).toEqual(["running", "running"]);
    expect(card("t2")?.outcome).toBeUndefined();
  });

  test("a child that hits the limit keeps its card waiting, resumes on its branch on a wake that says go, and fails the card on a second limit", async () => {
    clock = Date.UTC(2026, 9, 26, 12);
    const resumed: string[] = [];
    const h = hub({
      resumeChild: async (coordId, t, old, priority) => {
        resumed.push(`${old.id} ${priority}`);
        const c = { id: `c${++n}`, repoId: t.repo, action: t.action, status: "working", startedAt: clock, steps: [], note: t.note, by: "coordinator", parent: coordId, branch: old.branch } as unknown as Run;
        runs.set(c.id, c);
        h.onRun(c);
        return { run: c };
      },
    });
    await post(h, "plan", { run: "co1", tasks: [task()] });
    await post(h, "start", { run: "co1" });
    await settled(h);
    const first = child("t1");
    first.status = "limited";
    first.endedAt = clock;
    first.error = LIMIT;
    first.limited = { at: clock, text: LIMIT };
    h.onRun(first);
    await settled(h);
    expect([card("t1")?.state, card("t1")?.outcome, card("t1")?.limited]).toEqual(["running", "waiting for capacity (resets 15:00)", 0]);
    expect(h.heldStarts().map((x) => x.id)).toEqual(["card:co1:t1"]);
    h.wake(() => false);
    await settled(h);
    expect(resumed).toEqual([]);
    h.wake(() => true);
    await settled(h);
    expect(resumed).toEqual([`${first.id} normal`]);
    expect([card("t1")?.run, card("t1")?.outcome, card("t1")?.limited]).toEqual(["c2", undefined, 1]);
    const second = child("t1");
    second.status = "limited";
    second.endedAt = clock;
    second.error = LIMIT;
    second.limited = { at: 1, text: LIMIT };
    h.onRun(second);
    await settled(h);
    expect([card("t1")?.state, card("t1")?.outcome]).toEqual(["failed", "the plan's usage limit, twice in a row"]);
    // the note says what the card says, as the cards line under it does
    const note = (await hearAll(h)).find((x) => x.startsWith("canopy: a task you started has settled"));
    expect(note).toContain("outcome: failed");
    expect(said.at(-1)?.cards).toBe("cards now: t1 failed");
  });

  test("a card waiting for capacity keeps the card after it waiting, not blocked; resumed and landed, the next one starts", async () => {
    clock = Date.UTC(2026, 9, 26, 12);
    coordinator({ status: "idle" });
    const h = hub({
      resumeChild: async (coordId, t, old) => {
        const c = { id: `c${++n}`, repoId: t.repo, action: t.action, status: "working", startedAt: clock, steps: [], note: t.note, by: "coordinator", parent: coordId, branch: old.branch } as unknown as Run;
        runs.set(c.id, c);
        h.onRun(c);
        return { run: c };
      },
    });
    await post(h, "plan", { run: "co1", tasks: [task(), task({ title: "two", after: ["t1"] })] });
    await post(h, "start", { run: "co1" });
    await settled(h);
    const first = child("t1");
    first.status = "limited";
    first.endedAt = clock;
    first.error = LIMIT;
    first.limited = { at: clock, text: LIMIT };
    h.onRun(first);
    await settled(h);
    expect([card("t1")?.state, card("t1")?.outcome, card("t1")?.limited]).toEqual(["running", "waiting for capacity (resets 15:00)", 0]);
    expect(card("t2")).toMatchObject({ state: "queued", outcome: "waits for t1" });
    h.wake(() => true);
    await settled(h);
    const resumed = child("t1");
    expect(resumed.id).not.toBe(first.id);
    branches.set(resumed.id, { verdict: "auto", entry: entry("t1", "landed"), entries: [entry("t1", "landed")] });
    end(h, "t1");
    await settled(h);
    expect(card("t1")).toMatchObject({ state: "done", outcome: "landed" });
    expect(card("t2")?.state).toBe("running");
    expect((await hearAll(h)).filter((x) => x.includes("stays queued"))).toEqual([]);
  });

  /** a child that hit the limit, then the runner forgot (a restart) */
  async function limitedThenGone(h: CoordinatorHub): Promise<string> {
    await post(h, "plan", { run: "co1", tasks: [task()] });
    await post(h, "start", { run: "co1" });
    await settled(h);
    const first = child("t1");
    first.status = "limited";
    first.endedAt = clock;
    first.error = LIMIT;
    first.limited = { at: clock, text: LIMIT };
    h.onRun(first);
    await settled(h);
    expect(h.heldStarts().map((x) => x.id)).toEqual(["card:co1:t1"]);
    runs.delete(first.id);
    return first.id;
  }

  test("a limited child the runner no longer has fails its card on a wake, so nothing waits on it for good", async () => {
    clock = Date.UTC(2026, 9, 26, 12);
    const resumed: string[] = [];
    const h = hub({ resumeChild: async (_c, _t, old) => { resumed.push(old.id); throw new Error("not reached"); } });
    const id = await limitedThenGone(h);
    h.wake(() => true);
    await settled(h);
    expect([card("t1")?.state, card("t1")?.outcome]).toEqual(["failed", `its run ${id} is gone since it hit the limit (a restart), so nothing carries it on`]);
    expect(h.heldStarts()).toEqual([]);
    expect(resumed).toEqual([]);
  });

  test("'start anyway' on such a card says why nothing started", async () => {
    clock = Date.UTC(2026, 9, 26, 12);
    const h = hub({ resumeChild: async () => { throw new Error("not reached"); } });
    const id = await limitedThenGone(h);
    await expect(h.release("co1", "t1")).rejects.toThrow(`its run ${id} is gone`);
    expect(card("t1")?.state).toBe("failed");
  });
});

describe("a card with times", () => {
  const members = (ids: string[]) => ids.map((id) => ({ run: id, origin: `br-${id}`, profile: null }));
  const group = (over: Partial<RunGroup> = {}): RunGroup => ({ id: "g-a1b2c3d4", repoId: "web", repoPath: "/w", action: "ask", note: "n", expectedMembers: 3, members: members(["m1", "m2", "m3"]), state: "working", autoLand: false, startedAt: 1, ...over });
  let live: RunGroup | undefined;
  const memberRun = (id: string): Run => { const r = { id, repoId: "web", action: "ask", status: "working", startedAt: 1, steps: [], note: "n", parent: "co1" } as unknown as Run; runs.set(id, r); return r; };
  const groupHub = (over: Partial<CoordinatorDeps> = {}) => hub({
    group: (id) => (live?.id === id ? live : undefined),
    startChild: async (coordId, task) => {
      started.push({ coord: coordId, task: task.id });
      if (!task.times) return { run: memberRun(`solo-${task.id}`) };
      for (const m of ["m1", "m2", "m3"].slice(0, task.times)) memberRun(m);
      live = group({ expectedMembers: task.times, members: members(["m1", "m2", "m3"].slice(0, task.times)) });
      return { group: live };
    },
    ...over,
  });
  beforeEach(() => { live = undefined; });

  test("an edit sets times and an edit to 1 takes it off", async () => {
    const h = groupHub();
    coordinator({ status: "idle" });
    await post(h, "plan", { run: "co1", tasks: [task({ action: "ask" })] });
    expect((await post(h, "tasks", { run: "co1", id: "t1", times: 3 })).status).toBe(200);
    expect(card("t1")?.times).toBe(3);
    expect((await post(h, "tasks", { run: "co1", id: "t1", title: "kept" })).status).toBe(200);
    expect(card("t1")?.times).toBe(3);
    expect((await post(h, "tasks", { run: "co1", id: "t1", times: 1 })).status).toBe(200);
    expect(card("t1")?.times).toBeUndefined();
    expect((await post(h, "tasks", { run: "co1", id: "t1", times: 4 })).status).toBe(400);
  });

  test("a card with times starts one group and holds its members' places", async () => {
    const h = groupHub();
    coordinator({ status: "idle" });
    await post(h, "plan", { run: "co1", tasks: [task({ action: "ask", times: 3 }), task({ action: "ask" })] });
    await post(h, "start", { run: "co1" });
    await h.idle();
    expect(started).toEqual([{ coord: "co1", task: "t1" }]);
    expect(card("t1")).toMatchObject({ state: "running", group: "g-a1b2c3d4" });
    expect(card("t1")?.run).toBeUndefined();
    expect(card("t2")?.state).toBe("queued");
  });

  test("the next card goes once the members end", async () => {
    const h = groupHub();
    coordinator({ status: "idle" });
    await post(h, "plan", { run: "co1", tasks: [task({ action: "ask", times: 3 }), task({ action: "ask" })] });
    await post(h, "start", { run: "co1" });
    for (const id of ["m1", "m2", "m3"]) {
      const m = runs.get(id);
      if (!m) throw new Error("no member");
      m.status = "done";
      h.onRun(m);
    }
    await h.idle();
    expect(card("t2")?.state).toBe("running");
  });

  test("a repo short of slots keeps the card queued and asks for all of them", async () => {
    const asked: (number | undefined)[] = [];
    const h = groupHub({ repoFull: (_repo, need) => { asked.push(need); return (need ?? 1) > 1; } });
    coordinator({ status: "idle" });
    await post(h, "plan", { run: "co1", tasks: [task({ action: "ask", times: 2 })] });
    await post(h, "start", { run: "co1" });
    await h.idle();
    expect(started).toEqual([]);
    expect(card("t1")).toMatchObject({ state: "queued", outcome: "waiting for a branch slot in web" });
    expect(asked).toContain(2);
  });

  test("a busy start keeps the card queued", async () => {
    const h = groupHub({ startChild: async () => ({ busy: "web has 2 branch runs going" }) });
    coordinator({ status: "idle" });
    await post(h, "plan", { run: "co1", tasks: [task({ action: "ask", times: 2 })] });
    await post(h, "start", { run: "co1" });
    await h.idle();
    expect(card("t1")?.state).toBe("queued");
  });

  for (const [state, cardState, outcome] of [["picked", "done", "winner picked"], ["landed", "done", "landed"], ["needs-you", "failed", "needs you"], ["dropped", "failed", "dropped"]] as const) {
    test(`a group that reads ${state} settles its card on recheck and says so once`, async () => {
      const h = groupHub();
      const co = coordinator({ status: "idle" });
      await post(h, "plan", { run: "co1", tasks: [task({ action: "ask", times: 2 })] });
      await post(h, "start", { run: "co1" });
      h.recheck();
      expect(card("t1")?.state).toBe("running");
      live = group({ state, expectedMembers: 2 });
      h.recheck();
      h.recheck();
      await h.idle();
      expect(card("t1")).toMatchObject({ state: cardState, outcome });
      expect(said.filter((n) => n.text.includes(`outcome: ${outcome}`))).toHaveLength(1);
      expect(co.id).toBe("co1");
    });
  }

  test("a group that settled inside its start settles the card at once", async () => {
    const h = groupHub({ startChild: async () => { live = group({ state: "needs-you", reason: "nothing to pick from" }); return { group: live }; } });
    coordinator({ status: "idle" });
    await post(h, "plan", { run: "co1", tasks: [task({ action: "ask", times: 2 })] });
    await post(h, "start", { run: "co1" });
    await h.idle();
    expect(card("t1")).toMatchObject({ state: "failed", outcome: "needs you" });
  });

  test("a group card whose winner was picked lands later, and the card after it starts", async () => {
    const h = groupHub();
    coordinator({ status: "idle" });
    await post(h, "plan", { run: "co1", tasks: [task({ action: "ask", times: 2 }), task({ title: "two", after: ["t1"] })] });
    await post(h, "start", { run: "co1" });
    live = group({ state: "picked", expectedMembers: 2 });
    h.recheck();
    await h.idle();
    expect(card("t1")).toMatchObject({ state: "done", outcome: "winner picked" });
    expect(card("t2")).toMatchObject({ state: "queued", outcome: "waits for t1" });
    live = group({ state: "landed", expectedMembers: 2 });
    h.recheck();
    await h.idle();
    expect(card("t1")).toMatchObject({ state: "done", outcome: "landed" });
    expect(card("t2")?.state).toBe("running");
  });

  test("a group card whose picked winner is dropped fails, and the card after it hears it is blocked", async () => {
    const h = groupHub();
    coordinator({ status: "idle" });
    await post(h, "plan", { run: "co1", tasks: [task({ action: "ask", times: 2 }), task({ title: "two", after: ["t1"] })] });
    await post(h, "start", { run: "co1" });
    live = group({ state: "picked", expectedMembers: 2 });
    h.recheck();
    await h.idle();
    const t1 = card("t1");
    if (!t1) throw new Error("no t1");
    live = group({ state: "dropped", expectedMembers: 2 });
    h.recheck();
    await h.idle();
    expect(card("t1")).toMatchObject({ state: "failed", outcome: "dropped" });
    expect(card("t2")).toMatchObject({ state: "queued", outcome: "waits for t1, which failed" });
    const t2 = card("t2");
    if (!t2) throw new Error("no t2");
    const heard = await hearAll(h);
    expect(heard.filter((x) => x === lateFailNote(t1, "dropped"))).toHaveLength(1);
    // a group card has no branch a run could reopen it on
    expect(heard.filter((x) => x === blockedNote(t2, "waits for t1, which failed"))).toHaveLength(1);
  });

  test("a group card whose group needs Eric is read again: he picks a winner and lands it, and the card after it starts", async () => {
    const h = groupHub();
    coordinator({ status: "idle" });
    await post(h, "plan", { run: "co1", tasks: [task({ action: "ask", times: 2 }), task({ title: "two", after: ["t1"] })] });
    await post(h, "start", { run: "co1" });
    live = group({ state: "needs-you", reason: "the reviewers split", expectedMembers: 2 });
    h.recheck();
    await h.idle();
    expect(card("t1")).toMatchObject({ state: "failed", outcome: "needs you" });
    expect(card("t2")).toMatchObject({ state: "queued", outcome: "waits for t1, whose group needs Eric" });
    live = group({ state: "picked", expectedMembers: 2 });
    h.recheck();
    h.recheck();
    await h.idle();
    expect(card("t1")).toMatchObject({ state: "done", outcome: "winner picked" });
    expect(card("t2")).toMatchObject({ state: "queued", outcome: "waits for t1" });
    live = group({ state: "landed", expectedMembers: 2 });
    h.recheck();
    await h.idle();
    expect(card("t1")).toMatchObject({ state: "done", outcome: "landed" });
    expect(card("t2")?.state).toBe("running");
    const heard = await hearAll(h);
    expect(heard.filter((x) => x.includes("outcome: winner picked"))).toHaveLength(1);
    expect(heard.filter((x) => x.includes("stays queued"))).toEqual([]);
  });

  test("a group card whose group needed Eric and was dropped fails dropped, and the card after it hears it is blocked", async () => {
    const h = groupHub();
    coordinator({ status: "idle" });
    await post(h, "plan", { run: "co1", tasks: [task({ action: "ask", times: 2 }), task({ title: "two", after: ["t1"] })] });
    await post(h, "start", { run: "co1" });
    live = group({ state: "needs-you", reason: "the reviewers split", expectedMembers: 2 });
    h.recheck();
    await h.idle();
    const t1 = card("t1");
    if (!t1) throw new Error("no t1");
    live = group({ state: "dropped", expectedMembers: 2 });
    h.recheck();
    await h.idle();
    expect(card("t1")).toMatchObject({ state: "failed", outcome: "dropped" });
    expect(card("t2")).toMatchObject({ state: "queued", outcome: "waits for t1, which failed" });
    const t2 = card("t2");
    if (!t2) throw new Error("no t2");
    const heard = await hearAll(h);
    expect(heard.filter((x) => x === lateFailNote(t1, "dropped"))).toHaveLength(1);
    expect(heard.filter((x) => x === blockedNote(t2, "waits for t1, which failed"))).toHaveLength(1);
    // dropped is the group's last word: read again, nothing more is said
    h.recheck();
    expect((await hearAll(h)).filter((x) => x === lateFailNote(t1, "dropped"))).toHaveLength(1);
  });

  test("a group the backend no longer keeps fails its card", async () => {
    const h = groupHub();
    coordinator({ status: "idle" });
    await post(h, "plan", { run: "co1", tasks: [task({ action: "ask", times: 2 })] });
    await post(h, "start", { run: "co1" });
    live = undefined;
    h.recheck();
    expect(card("t1")).toMatchObject({ state: "failed", outcome: "its group is no longer kept" });
  });
});

/** every note said so far, after the coordinator went idle as often as it takes */
async function hearAll(h: CoordinatorHub): Promise<string[]> {
  for (let i = 0; i < 10; i++) {
    await settled(h);
    goIdle(h);
  }
  await settled(h);
  return said.map((s) => s.text);
}

describe("card fields on the plan and tasks routes", () => {
  test("a plan takes equip, workflow and after; a coordinator names a bundled or user workflow only", async () => {
    const h = hub();
    const ok = await post(h, "plan", { run: "co1", tasks: [task({ equip: { loadout: "quick" }, workflow: "review" }), task({ title: "two", after: ["t1"] })] }, coordCaller("co1"));
    expect(ok.status).toBe(200);
    expect(cards()).toMatchObject([
      { id: "t1", equip: { loadout: "quick" }, workflow: "review" },
      { id: "t2", after: ["t1"] },
    ]);
    expect(asked).toEqual([{ repo: "web", withRepo: false }]);
    expect(await post(h, "plan", { run: "co1", tasks: [task({ workflow: "local" })] }, coordCaller("co1"))).toEqual({ status: 400, body: { error: "tasks[0].workflow: no workflow local for web" } });
    expect(await post(h, "plan", { run: "co1", tasks: [task({ equip: { loadout: "quick", model: "opus" } })] }, coordCaller("co1"))).toEqual({
      status: 400,
      body: { error: "tasks[0].equip: a coordinator names a loadout; its fields are Eric's" },
    });
    expect(await post(h, "plan", { run: "co1", tasks: [task({ equip: { loadout: "gone" } })] })).toEqual({ status: 400, body: { error: "tasks[0].equip.loadout: no loadout gone in kit.json" } });
    expect(await post(h, "plan", { run: "co1", tasks: [task({ after: ["t9"] })] })).toEqual({ status: 400, body: { error: "tasks[0].after: no card t9" } });
    // Eric names the repo's own workflow from the page
    const own = await post(h, "plan", { run: "co1", tasks: [task({ workflow: "local", workflowRepo: true })] });
    expect(own.status).toBe(200);
    expect((own.body["added"] as CoordTask[])[0]).toMatchObject({ workflow: "local", workflowRepo: true });
    expect(asked.at(-1)).toEqual({ repo: "web", withRepo: true });
  });

  test("Minor 4: a codex loadout on plan, then build or a workflow is a 400 at plan and edit time", async () => {
    const h = hub({ loadouts: () => ({ base: [], loadouts: [lo(), lo({ name: "cx", harness: "codex" })], errors: [], servers: [] }) });
    expect(await post(h, "plan", { run: "co1", tasks: [task({ equip: { loadout: "cx" } })] }, coordCaller("co1"))).toEqual({
      status: 400,
      body: { error: "tasks[0].equip.loadout: cx runs codex; plan, then build needs Claude Code" },
    });
    expect(await post(h, "plan", { run: "co1", tasks: [task({ action: "ask", workflow: "review", equip: { loadout: "cx" } })] }, coordCaller("co1"))).toEqual({
      status: 400,
      body: { error: "tasks[0].equip.loadout: cx runs codex; a card's flow needs Claude Code" },
    });
    expect((await post(h, "plan", { run: "co1", tasks: [task({ action: "ask", equip: { loadout: "cx" } })] }, coordCaller("co1"))).status).toBe(200);
    expect(await post(h, "tasks", { run: "co1", id: "t1", action: "propose" })).toEqual({ status: 400, body: { error: "t1.equip.loadout: cx runs codex; plan, then build needs Claude Code" } });
    expect(card("t1")?.action).toBe("ask");
  });

  test("a proposed card's equip, workflow and after change through tasks", async () => {
    const h = hub();
    await post(h, "plan", { run: "co1", tasks: [task(), task({ title: "two" })] });
    expect((await post(h, "tasks", { run: "co1", id: "t2", equip: { loadout: "quick", effort: "high" }, workflow: "local", workflowRepo: true, after: ["t1"] })).status).toBe(200);
    expect(card("t2")).toMatchObject({ equip: { loadout: "quick", effort: "high" }, workflow: "local", workflowRepo: true, after: ["t1"] });
    expect(await post(h, "tasks", { run: "co1", id: "t1", after: ["t2"] })).toEqual({ status: 400, body: { error: "t1.after: t1 and t2 wait for each other" } });
    expect((await post(h, "tasks", { run: "co1", id: "t2", equip: null, workflow: null, after: null })).status).toBe(200);
    expect(card("t2")).toEqual({ id: "t2", title: "two", repo: "web", note: "the login form drops the email", action: "propose", state: "proposed" });
  });

  test("a queued card takes a new loadout and after, and nothing else, and may be removed", async () => {
    const h = hub();
    await post(h, "plan", { run: "co1", tasks: [task(), task({ title: "two", after: ["t1"] }), task({ title: "three", after: ["t1"] })] });
    await post(h, "start", { run: "co1" });
    expect(cards().map((t) => [t.id, t.state, t.outcome])).toEqual([
      ["t1", "running", undefined],
      ["t2", "queued", "waits for t1"],
      ["t3", "queued", "waits for t1"],
    ]);
    expect(await post(h, "tasks", { run: "co1", id: "t2", title: "other" })).toEqual({ status: 409, body: { error: "t2 is queued; only its loadout and after change" } });
    expect((await post(h, "tasks", { run: "co1", id: "t2", equip: { loadout: "quick" } })).status).toBe(200);
    expect(card("t2")).toMatchObject({ state: "queued", equip: { loadout: "quick" } });
    // taking its after off lets it start
    const off = await post(h, "tasks", { run: "co1", id: "t2", after: [] });
    expect(off.status).toBe(200);
    await settled(h);
    expect(card("t2")).toMatchObject({ state: "running" });
    expect(card("t2")?.after).toBeUndefined();
    expect(await post(h, "tasks", { run: "co1", id: "t3", remove: true })).toEqual({ status: 200, body: { ok: true, removed: "t3" } });
    expect(cards().map((t) => t.id)).toEqual(["t1", "t2"]);
  });
});

describe("the cards line under each note", () => {
  test("a card Eric started alone settles while the other stays proposed, and the note's last line says so", async () => {
    coordinator({ status: "idle" });
    const h = hub();
    await post(h, "plan", { run: "co1", tasks: [task(), task({ title: "two" })] });
    expect((await post(h, "start", { run: "co1", ids: ["t2"] })).status).toBe(200);
    expect(cards().map((t) => [t.id, t.state])).toEqual([["t1", "proposed"], ["t2", "running"]]);
    end(h, "t2", { status: "failed" });
    await settled(h);
    expect(said.length).toBe(1);
    expect(said[0]?.text.split("\n")[1]).toBe("task t2: two (repo web)");
    expect(said[0]?.cards).toBe("cards now: t1 proposed, t2 failed");
  });

  test("a hold's note carries the line too, read when it is said", async () => {
    coordinator({ status: "idle" });
    const h = hub();
    await post(h, "plan", { run: "co1", tasks: [task(), task({ title: "two" })] });
    await post(h, "hold", { run: "co1", held: true });
    await settled(h);
    expect(said.map((x) => [x.text, x.cards])).toEqual([[holdNote(true), "cards now: t1 proposed, t2 proposed"]]);
  });
});

describe("holding the goal", () => {
  test("a held goal queues its cards and starts none; resuming starts them; the chat hears both", async () => {
    coordinator({ status: "idle" });
    const h = hub();
    await post(h, "plan", { run: "co1", tasks: [task(), task({ title: "two" })] });
    expect(await post(h, "hold", { run: "co1", held: true })).toEqual({ status: 200, body: { ok: true, held: true } });
    expect(runs.get("co1")?.held).toBe(true);
    await post(h, "start", { run: "co1" });
    await settled(h);
    expect(cards().map((t) => [t.state, t.outcome])).toEqual([["queued", "the goal is held"], ["queued", "the goal is held"]]);
    expect(started).toEqual([]);
    expect(said.map((s) => s.text)).toEqual([holdNote(true)]);
    // a start with ids starts nothing either
    expect((await post(h, "start", { run: "co1", ids: ["t1"] })).status).toBe(200);
    expect(started).toEqual([]);
    goIdle(h);
    expect(await post(h, "hold", { run: "co1", held: false })).toEqual({ status: 200, body: { ok: true, held: false } });
    await settled(h);
    expect(runs.get("co1")?.held).toBeUndefined();
    expect(cards().map((t) => [t.state, t.outcome])).toEqual([["running", undefined], ["running", undefined]]);
    expect(said.map((s) => s.text)).toEqual([holdNote(true), holdNote(false)]);
  });

  test("holding twice says it once; a running child goes on", async () => {
    coordinator({ status: "idle" });
    const h = hub();
    await post(h, "plan", { run: "co1", tasks: [task()] });
    await post(h, "start", { run: "co1" });
    await post(h, "hold", { run: "co1", held: true });
    await post(h, "hold", { run: "co1", held: true });
    expect(child("t1").status).toBe("working");
    expect(card("t1")?.state).toBe("running");
    expect((await hearAll(h)).filter((t) => t === holdNote(true))).toHaveLength(1);
  });

  test("a coordinator's own token cannot hold, and held must be true or false", async () => {
    const h = hub();
    expect(await post(h, "hold", { run: "co1", held: true }, coordCaller("co1"))).toEqual({ status: 403, body: { error: "a coordinator proposes; holding the goal is Eric's" } });
    expect(await post(h, "hold", { run: "co1", held: "yes" })).toEqual({ status: 400, body: { error: "held must be true or false" } });
    expect(runs.get("co1")?.held).toBeUndefined();
  });
});

describe("start with ids", () => {
  test("starts the named cards only, and refuses a card that is not there or has started", async () => {
    const h = hub();
    await post(h, "plan", { run: "co1", tasks: [task(), task({ title: "two" }), task({ title: "three" })] });
    expect((await post(h, "start", { run: "co1", ids: ["t1"] })).status).toBe(200);
    const two = await post(h, "start", { run: "co1", ids: ["t2"] });
    expect(two.status).toBe(200);
    expect(cards().map((t) => t.state)).toEqual(["running", "running", "proposed"]);
    expect(started.map((s) => s.task)).toEqual(["t1", "t2"]);
    expect(await post(h, "start", { run: "co1", ids: ["t9"] })).toEqual({ status: 404, body: { error: "no card t9" } });
    expect(await post(h, "start", { run: "co1", ids: ["t1"] })).toEqual({ status: 409, body: { error: "t1 is running; only a proposed or queued card starts" } });
    expect(await post(h, "start", { run: "co1", ids: "t3" })).toEqual({ status: 400, body: { error: "ids must list card ids" } });
    expect(card("t3")?.state).toBe("proposed");
  });

  test("a queued card named goes before the cards queued ahead of it", async () => {
    full.add("web");
    const h = hub();
    await post(h, "plan", { run: "co1", tasks: [task(), task({ title: "two", repo: "api" }), task({ title: "three" }), task({ title: "four", repo: "api" })] });
    await post(h, "start", { run: "co1" });
    expect(cards().map((t) => [t.id, t.state])).toEqual([
      ["t1", "queued"],
      ["t2", "running"],
      ["t3", "queued"],
      ["t4", "running"],
    ]);
    full.delete("web");
    // room for one: t3 goes, t1 waits
    expect((await post(h, "start", { run: "co1", ids: ["t3"] })).status).toBe(200);
    expect(cards().map((t) => [t.id, t.state])).toEqual([
      ["t1", "queued"],
      ["t2", "running"],
      ["t3", "running"],
      ["t4", "running"],
    ]);
  });

  test("a card whose start is in flight is neither edited nor removed, and ends running with its child", async () => {
    let open = (): void => {};
    let reached = (): void => {};
    const atGate = new Promise<void>((r) => (reached = r));
    const gate = new Promise<void>((r) => (open = r));
    const h = hub({
      startChild: async (coordId, t) => {
        reached();
        await gate;
        started.push({ coord: coordId, task: t.id });
        const c = { id: `c${++n}`, repoId: t.repo, action: t.action, status: "working", startedAt: clock, steps: [], note: t.note, by: "coordinator", parent: coordId, branch: branch(`c${n}`) } as unknown as Run;
        runs.set(c.id, c);
        h.onRun(c);
        return { run: c };
      },
    });
    await post(h, "plan", { run: "co1", tasks: [task()] });
    const starting = post(h, "start", { run: "co1" });
    await atGate;
    expect(card("t1")?.state).toBe("queued");
    expect(await post(h, "tasks", { run: "co1", id: "t1", remove: true })).toEqual({ status: 409, body: { error: "t1 is starting" } });
    expect(await post(h, "tasks", { run: "co1", id: "t1", equip: { loadout: "quick" } })).toEqual({ status: 409, body: { error: "t1 is starting" } });
    open();
    expect((await starting).status).toBe(200);
    await settled(h);
    expect(card("t1")).toMatchObject({ state: "running", run: "c1" });
    expect(card("t1")?.equip).toBeUndefined();
    expect(started.map((s) => s.task)).toEqual(["t1"]);
  });

  test("a started card records its branch", async () => {
    const h = hub();
    await post(h, "plan", { run: "co1", tasks: [task()] });
    await post(h, "start", { run: "co1" });
    expect(card("t1")).toMatchObject({ run: "c1", branch: "br-c1" });
  });
});

describe("after waits for landed", () => {
  test("a card after another waits, and starts once that card lands through the queue", async () => {
    const h = hub();
    await post(h, "plan", { run: "co1", tasks: [task(), task({ title: "two", after: ["t1"] })] });
    await post(h, "start", { run: "co1" });
    expect(card("t2")).toMatchObject({ state: "queued", outcome: "waits for t1" });
    branches.set("c1", { verdict: "auto" });
    end(h, "t1");
    await settled(h);
    expect(card("t1")?.state).toBe("running");
    expect(card("t2")?.state).toBe("queued");
    branches.set("c1", { verdict: "auto", entry: entry("t1", "landed"), entries: [entry("t1", "landed")] });
    h.recheck();
    await settled(h);
    expect(card("t1")).toMatchObject({ state: "done", outcome: "landed" });
    expect(card("t2")).toMatchObject({ state: "running" });
    expect(card("t2")?.outcome).toBeUndefined();
  });

  test("Review Focus 1: a card that settled ready lands later by Eric's hand, and the card after it starts", async () => {
    coordinator({ status: "idle" });
    const h = hub();
    await post(h, "plan", { run: "co1", tasks: [task(), task({ title: "two", after: ["t1"] })] });
    await post(h, "start", { run: "co1" });
    branches.set("c1", { verdict: "approve" });
    end(h, "t1");
    await settled(h);
    expect(card("t1")).toMatchObject({ state: "done", outcome: "ready" });
    h.recheck();
    await settled(h);
    expect(card("t2")).toMatchObject({ state: "queued", outcome: "waits for t1" });
    branches.set("c1", { verdict: "approve", entry: entry("t1", "landed"), entries: [entry("t1", "landed")] });
    const t1 = card("t1");
    if (!t1) throw new Error("no t1");
    h.recheck();
    h.recheck();
    await settled(h);
    expect(card("t1")).toMatchObject({ state: "done", outcome: "landed" });
    expect(card("t2")?.state).toBe("running");
    expect((await hearAll(h)).filter((t) => t === landedNote(t1))).toHaveLength(1);
  });

  test("Review Focus 1: a card's run gone, its branch still says landed", async () => {
    const h = hub();
    await post(h, "plan", { run: "co1", tasks: [task(), task({ title: "two", after: ["t1"] })] });
    await post(h, "start", { run: "co1" });
    branches.set("c1", { verdict: "land" });
    end(h, "t1");
    await settled(h);
    expect(card("t1")).toMatchObject({ state: "done", outcome: "ready", branch: "br-c1" });
    const landed = entry("t1", "landed");
    runs.delete("c1");
    branches.set("c1", { entry: landed, entries: [landed] });
    h.recheck();
    await settled(h);
    expect(card("t1")?.outcome).toBe("landed");
    expect(card("t2")?.state).toBe("running");
  });

  test("Review Focus 1: a card that settled PR opened lands when its PR merges", async () => {
    coordinator({ status: "idle" });
    const h = hub();
    await post(h, "plan", { run: "co1", tasks: [task(), task({ title: "two", after: ["t1"] })] });
    await post(h, "start", { run: "co1" });
    branches.set("c1", { openPr: true, prUrl: "https://github.com/x/web/pull/7" });
    end(h, "t1");
    await settled(h);
    expect(card("t1")).toMatchObject({ state: "done", outcome: "PR opened" });
    expect(card("t2")?.state).toBe("queued");
    const t1 = card("t1");
    if (!t1) throw new Error("no t1");
    branches.set("c1", { openPr: true, prUrl: "https://github.com/x/web/pull/7", prMerged: true });
    h.recheck();
    await settled(h);
    expect(card("t1")?.outcome).toBe("landed");
    expect(card("t2")?.state).toBe("running");
    expect(await hearAll(h)).toContain(landedNote(t1));
  });

  test("Review Focus 5: a card after one that failed stays queued, and the manager hears it once", async () => {
    coordinator({ status: "idle" });
    const h = hub();
    await post(h, "plan", { run: "co1", tasks: [task(), task({ title: "two", after: ["t1"] })] });
    await post(h, "start", { run: "co1" });
    end(h, "t1", { status: "failed" });
    await settled(h);
    await h.pump("co1");
    await h.pump("co1");
    expect(card("t1")?.state).toBe("failed");
    expect(card("t2")).toMatchObject({ state: "queued", outcome: "waits for t1, which failed" });
    const t2 = card("t2");
    if (!t2) throw new Error("no t2");
    // t1 keeps its branch, so the note says a new run there may reopen it
    expect((await hearAll(h)).filter((t) => t === blockedNote(t2, "waits for t1, which failed", "t1"))).toHaveLength(1);
    expect(started.map((s) => s.task)).toEqual(["t1"]);
  });

  test("I1: a card after one that ended with no change is blocked, and the manager hears it once", async () => {
    coordinator({ status: "idle" });
    const h = hub();
    await post(h, "plan", { run: "co1", tasks: [task(), task({ title: "two", after: ["t1"] })] });
    await post(h, "start", { run: "co1" });
    end(h, "t1", { branch: "nothing" });
    await settled(h);
    await h.pump("co1");
    expect(card("t1")).toMatchObject({ state: "done", outcome: "no change" });
    expect(card("t2")).toMatchObject({ state: "queued", outcome: "waits for t1, which ended with no change" });
    const t2 = card("t2");
    if (!t2) throw new Error("no t2");
    // t1 has its branch, so a new run there may still reopen it
    expect((await hearAll(h)).filter((t) => t === blockedNote(t2, "waits for t1, which ended with no change", "t1"))).toHaveLength(1);
    expect(started.map((s) => s.task)).toEqual(["t1"]);
  });

  test("a card that settled ready reads landed off its work item once the queue has let its landed entry go", async () => {
    let work: Record<string, WorkState> = {};
    coordinator({ status: "idle" });
    const h = hub({ workState: (id) => work[id] });
    await post(h, "plan", { run: "co1", tasks: [task(), task({ title: "two", after: ["t1"] })] });
    await post(h, "start", { run: "co1" });
    branches.set("c1", { verdict: "approve" });
    end(h, "t1");
    await settled(h);
    expect(card("t1")).toMatchObject({ state: "done", outcome: "ready", work: "w-test2345" });
    // it landed, and newer landings in the repo pushed its entry out of the
    // queue's KEEP_LANDED before a recheck read it
    work = { "w-test2345": "landed" };
    branches.set("c1", { gone: true });
    h.recheck();
    await settled(h);
    expect(card("t1")).toMatchObject({ state: "done", outcome: "landed" });
    expect(card("t2")?.state).toBe("running");
  });

  test("I1: a card that settled ready whose branch Eric dropped fails dropped, and the card after it hears it is blocked", async () => {
    coordinator({ status: "idle" });
    const h = hub();
    await post(h, "plan", { run: "co1", tasks: [task(), task({ title: "two", after: ["t1"] })] });
    await post(h, "start", { run: "co1" });
    branches.set("c1", { verdict: "approve" });
    end(h, "t1");
    await settled(h);
    expect(card("t1")).toMatchObject({ state: "done", outcome: "ready" });
    const ready = card("t1");
    if (!ready) throw new Error("no t1");
    // dropped with its worktree: the landing queue keeps no record of it
    branches.set("c1", { gone: true });
    h.recheck();
    await settled(h);
    expect(card("t1")).toMatchObject({ state: "failed", outcome: "dropped" });
    expect(card("t2")).toMatchObject({ state: "queued", outcome: "waits for t1, which failed" });
    const t2 = card("t2");
    if (!t2) throw new Error("no t2");
    const heard = await hearAll(h);
    expect(heard.filter((t) => t === lateFailNote(ready, "dropped"))).toHaveLength(1);
    expect(heard.filter((t) => t === blockedNote(t2, "waits for t1, which failed"))).toHaveLength(1);
    // read again, it says nothing more
    h.recheck();
    expect((await hearAll(h)).filter((t) => t === lateFailNote(ready, "dropped"))).toHaveLength(1);
  });

  test("I1: a card whose PR closed unmerged fails PR closed, and still lands if its branch lands after all", async () => {
    coordinator({ status: "idle" });
    const h = hub();
    await post(h, "plan", { run: "co1", tasks: [task(), task({ title: "two", after: ["t1"] })] });
    await post(h, "start", { run: "co1" });
    branches.set("c1", { openPr: true, prUrl: "https://github.com/x/web/pull/7" });
    end(h, "t1");
    await settled(h);
    expect(card("t1")).toMatchObject({ state: "done", outcome: "PR opened" });
    branches.set("c1", { prUrl: "https://github.com/x/web/pull/7", prClosed: true });
    h.recheck();
    await settled(h);
    expect(card("t1")).toMatchObject({ state: "failed", outcome: "PR closed" });
    expect(card("t2")).toMatchObject({ state: "queued", outcome: "waits for t1, which failed" });
    // Eric lands the branch through the queue after all
    branches.set("c1", { prUrl: "https://github.com/x/web/pull/7", prClosed: true, entry: entry("t1", "landed"), entries: [entry("t1", "landed")] });
    h.recheck();
    await settled(h);
    expect(card("t1")).toMatchObject({ state: "done", outcome: "landed" });
    expect(card("t2")?.state).toBe("running");
  });

  test("Review Focus 5: a card after one that was removed says so", async () => {
    coordinator({ status: "idle" });
    const h = hub();
    await post(h, "plan", { run: "co1", tasks: [task(), task({ title: "two", after: ["t1"] })] });
    expect((await post(h, "tasks", { run: "co1", id: "t1", remove: true })).status).toBe(200);
    await post(h, "start", { run: "co1" });
    await settled(h);
    expect(card("t2")).toMatchObject({ state: "queued", outcome: "waits for t1, which was removed" });
    const t2 = card("t2");
    if (!t2) throw new Error("no t2");
    expect((await hearAll(h)).filter((t) => t === blockedNote(t2, "waits for t1, which was removed"))).toHaveLength(1);
    expect(started).toEqual([]);
  });
});

describe("a card follows its branch", () => {
  /** a later run on a card's branch (a fix, a follow-up, a resume) that
   *  names the coordinator, as the runner tells everyone of it */
  function onBranch(h: CoordinatorHub, taskId: string, over: Partial<Run> = {}): Run {
    const was = child(taskId);
    const r = { id: `f${++n}`, repoId: was.repoId, action: "ask", status: "working", startedAt: clock, steps: [], note: "fix it", parent: "co1", branch: { ...was.branch, state: "working" }, ...over } as unknown as Run;
    runs.set(r.id, r);
    h.onRun(r);
    return r;
  }
  const settleNotes = (texts: string[]): string[] => texts.filter((t) => t.startsWith("canopy: a task you started has settled"));

  test("a later run on its branch reopens a card that settled ready, and it settles again with a second note", async () => {
    coordinator({ status: "idle" });
    const h = hub();
    await post(h, "plan", { run: "co1", tasks: [task()] });
    await post(h, "start", { run: "co1" });
    branches.set("c1", { verdict: "approve" });
    const first = end(h, "t1", { result: "First go." });
    await settled(h);
    expect(card("t1")).toMatchObject({ state: "done", outcome: "ready", run: "c1" });
    const fix = onBranch(h, "t1");
    await settled(h);
    expect(card("t1")).toMatchObject({ state: "running", run: fix.id, branch: "br-c1", work: "w-test2345" });
    expect(card("t1")?.outcome).toBeUndefined();
    // the first child's later word does not take the card back
    h.onRun(first);
    await settled(h);
    expect(card("t1")?.run).toBe(fix.id);
    branches.set(fix.id, { verdict: "approve" });
    end(h, "t1", { result: "Fixed it." });
    await settled(h);
    expect(card("t1")).toMatchObject({ state: "done", outcome: "ready", run: fix.id });
    h.onRun(first);
    await settled(h);
    expect(card("t1")).toMatchObject({ state: "done", outcome: "ready", run: fix.id });
    const notes = settleNotes(await hearAll(h));
    expect(notes).toHaveLength(2);
    expect(notes[0]).toContain("result: First go.");
    expect(notes[1]).toContain("result: Fixed it.");
  });

  test("Minor 2: a card that used its limit resume and then takes Eric's fix waits at the fix's first limit, not fails", async () => {
    clock = Date.UTC(2026, 9, 26, 12);
    const LIMIT = "You've hit your limit · resets 3pm";
    const h = hub({
      resumeChild: async (coordId, t, old) => {
        const c = { id: `c${++n}`, repoId: t.repo, action: t.action, status: "working", startedAt: clock, steps: [], note: t.note, by: "coordinator", parent: coordId, branch: old.branch } as unknown as Run;
        runs.set(c.id, c);
        h.onRun(c);
        return { run: c };
      },
    });
    await post(h, "plan", { run: "co1", tasks: [task()] });
    await post(h, "start", { run: "co1" });
    await settled(h);
    const limit = (r: Run): void => {
      r.status = "limited";
      r.endedAt = clock;
      r.error = LIMIT;
      r.limited = { at: clock, text: LIMIT };
      h.onRun(r);
    };
    limit(child("t1"));
    await settled(h);
    h.wake(() => true);
    await settled(h);
    expect(card("t1")?.limited).toBe(1);
    branches.set(child("t1").id, { verdict: "approve" });
    end(h, "t1");
    await settled(h);
    expect(card("t1")).toMatchObject({ state: "done", outcome: "ready", limited: 1 });
    const fix = onBranch(h, "t1");
    await settled(h);
    expect(card("t1")).toMatchObject({ state: "running", run: fix.id });
    expect(card("t1")?.limited).toBeUndefined();
    limit(fix);
    await settled(h);
    expect([card("t1")?.state, card("t1")?.outcome, card("t1")?.limited]).toEqual(["running", "waiting for capacity (resets 15:00)", 0]);
  });

  test("a card that landed stays closed", async () => {
    const h = hub();
    await post(h, "plan", { run: "co1", tasks: [task()] });
    await post(h, "start", { run: "co1" });
    branches.set("c1", { verdict: "auto", entry: entry("t1", "landed"), entries: [entry("t1", "landed")] });
    end(h, "t1");
    await settled(h);
    expect(card("t1")).toMatchObject({ state: "done", outcome: "landed", run: "c1" });
    onBranch(h, "t1");
    await settled(h);
    expect(card("t1")).toMatchObject({ state: "done", outcome: "landed", run: "c1" });
  });

  test("a card that failed reopens; the card after it waits for it again and starts only once it lands", async () => {
    coordinator({ status: "idle" });
    const h = hub();
    await post(h, "plan", { run: "co1", tasks: [task(), task({ title: "two", after: ["t1"] })] });
    await post(h, "start", { run: "co1" });
    branches.set("c1", { verdict: "auto", entry: entry("t1", "red"), entries: [entry("t1", "red")] });
    end(h, "t1");
    await settled(h);
    expect(card("t1")).toMatchObject({ state: "failed", outcome: "sent back" });
    expect(card("t2")).toMatchObject({ state: "queued", outcome: "waits for t1, which failed" });
    const fix = onBranch(h, "t1");
    await settled(h);
    expect(card("t1")).toMatchObject({ state: "running", run: fix.id });
    expect(card("t2")).toMatchObject({ state: "queued", outcome: "waits for t1" });
    expect(started.map((s) => s.task)).toEqual(["t1"]);
    branches.set(fix.id, { verdict: "auto", entry: entry("t1", "landed"), entries: [entry("t1", "landed")] });
    end(h, "t1");
    await settled(h);
    expect(card("t1")).toMatchObject({ state: "done", outcome: "landed", run: fix.id });
    expect(card("t2")?.state).toBe("running");
    expect(started.map((s) => s.task)).toEqual(["t1", "t2"]);
  });

  test("a reopened card is not held to three at once, and counts as working after", async () => {
    const h = hub();
    await planFive(h);
    await post(h, "start", { run: "co1" });
    branches.set("c1", { verdict: "approve" });
    end(h, "t1");
    await settled(h);
    expect(cards().map((t) => t.state)).toEqual(["done", "running", "running", "running", "queued"]);
    onBranch(h, "t1");
    await settled(h);
    expect(cards().map((t) => t.state)).toEqual(["running", "running", "running", "running", "queued"]);
    end(h, "t2", { status: "failed" });
    await settled(h);
    expect(card("t5")?.state).toBe("queued");
    end(h, "t3", { status: "failed" });
    await settled(h);
    expect(card("t5")?.state).toBe("running");
  });

  test("a card waiting on its ready child takes the fix and drops the child's timer; a run beside a working one is not taken", async () => {
    const h = hub();
    await post(h, "plan", { run: "co1", tasks: [task()] });
    await post(h, "start", { run: "co1" });
    branches.set("c1", { verdict: "auto" });
    end(h, "t1");
    await settled(h);
    expect(card("t1")?.state).toBe("running");
    expect(h.waiting()).toBe(1);
    const fix = onBranch(h, "t1");
    await settled(h);
    expect(card("t1")).toMatchObject({ state: "running", run: fix.id });
    expect(h.waiting()).toBe(0);
    onBranch(h, "t1");
    await settled(h);
    expect(card("t1")?.run).toBe(fix.id);
  });

  test("a run on its branch is not taken by a coordinator that ended, or under any other parent", async () => {
    const h = hub();
    await post(h, "plan", { run: "co1", tasks: [task()] });
    await post(h, "start", { run: "co1" });
    branches.set("c1", { verdict: "approve" });
    end(h, "t1");
    await settled(h);
    onBranch(h, "t1", { parent: "someone" });
    await settled(h);
    expect(card("t1")).toMatchObject({ state: "done", outcome: "ready", run: "c1" });
    const co = runs.get("co1");
    if (!co) throw new Error("no co1");
    co.status = "stopped";
    h.onRun(co);
    onBranch(h, "t1");
    await settled(h);
    expect(card("t1")).toMatchObject({ state: "done", outcome: "ready", run: "c1" });
  });

  test("a resume in flight keeps its own word: a resumed child that ends inside its start settles the card on it", async () => {
    clock = Date.UTC(2026, 9, 26, 12);
    const LIMIT = "You've hit your limit · resets 3pm";
    const h = hub({
      resumeChild: async (coordId, t, old) => {
        const c = { id: `c${++n}`, repoId: t.repo, action: t.action, status: "working", startedAt: clock, steps: [], note: t.note, by: "coordinator", parent: coordId, branch: { ...old.branch, state: "working" } } as unknown as Run;
        runs.set(c.id, c);
        h.onRun(c);
        c.status = "failed";
        c.endedAt = clock;
        c.error = "it fell over";
        c.branch = { ...(old.branch as RunBranch), state: "nothing" };
        h.onRun(c);
        return { run: c };
      },
    });
    await post(h, "plan", { run: "co1", tasks: [task()] });
    await post(h, "start", { run: "co1" });
    const first = child("t1");
    first.status = "limited";
    first.endedAt = clock;
    first.error = LIMIT;
    first.limited = { at: clock, text: LIMIT };
    h.onRun(first);
    await settled(h);
    h.wake(() => true);
    await settled(h);
    expect(card("t1")).toMatchObject({ state: "failed", outcome: "failed", run: "c2", limited: 1 });
  });
});

describe("a card that names a workflow", () => {
  const flowOf = (taskId: string): Flow => {
    const f = flows.get(card(taskId)?.flow ?? "");
    if (!f) throw new Error(`${taskId} has no flow`);
    return f;
  };
  /** the card's flow moves, as the flows' change fan-out tells the hub */
  function move(h: CoordinatorHub, taskId: string, status: Flow["status"], state?: RunBranch["state"], over: Partial<Flow> = {}): Flow {
    const f = flowOf(taskId);
    f.status = status;
    if (status === "done" || status === "failed" || status === "stopped") f.endedAt = clock;
    else delete f.endedAt;
    if (state && f.branch) f.branch = { ...f.branch, state };
    Object.assign(f, over);
    h.onFlow(f);
    return f;
  }
  /** what the landing queue says of the card's flow's branch */
  const flowEntry = (taskId: string, state: LandEntry["state"]): LandEntry => {
    const b = flowOf(taskId).branch;
    return { id: b?.origin ?? "", repoId: "web", repoPath: "/r/web", branch: b?.name ?? "", target: "main", dir: b?.dir ?? "", note: "n", state, tries: 0, queuedAt: 1, updatedAt: 1 };
  };
  /** the same by the flow's id, once the flow is no longer kept */
  const flowEntryOf = (flowId: string, state: LandEntry["state"]): LandEntry => {
    const b = branch(flowId);
    return { id: b.origin, repoId: "web", repoPath: "/r/web", branch: b.name, target: "main", dir: b.dir, note: "n", state, tries: 0, queuedAt: 1, updatedAt: 1 };
  };

  test("a start answering a flow sets the card's flow and branch, and the flow counts as one working child", async () => {
    const h = hub();
    await post(h, "plan", { run: "co1", tasks: [task({ workflow: "review" }), task({ title: "two" }), task({ title: "three" }), task({ title: "four" })] });
    await post(h, "start", { run: "co1" });
    expect(card("t1")).toMatchObject({ state: "running", flow: "fl1", branch: "br-fl1", work: "w-test2345" });
    expect(card("t1")?.run).toBeUndefined();
    expect(cards().map((t) => t.state)).toEqual(["running", "running", "running", "queued"]);
    move(h, "t1", "gated");
    await settled(h);
    expect(card("t4")?.state).toBe("queued");
    // a flow that ended and waits on the landing queue holds no place
    move(h, "t1", "done", "ready");
    await settled(h);
    expect(card("t4")?.state).toBe("running");
  });

  test("a done flow whose branch is ready waits for the landing entry, then settles landed with the flow's note", async () => {
    coordinator({ status: "idle" });
    const h = hub();
    await post(h, "plan", { run: "co1", tasks: [task({ workflow: "review" })] });
    await post(h, "start", { run: "co1" });
    const t1 = card("t1");
    if (!t1) throw new Error("no t1");
    // done, its worktree not read yet
    move(h, "t1", "done", "working");
    await settled(h);
    expect(card("t1")?.state).toBe("running");
    branches.set("fl1", { verdict: "auto" });
    move(h, "t1", "done", "ready", { steps: [{ name: "Build", status: "passed", summary: "Built it." }] });
    await settled(h);
    expect(card("t1")?.state).toBe("running");
    branches.set("fl1", { verdict: "auto", entry: flowEntry("t1", "gate"), entries: [flowEntry("t1", "gate")] });
    h.recheck();
    await settled(h);
    expect(card("t1")?.state).toBe("running");
    const landed = { verdict: "auto" as const, entry: flowEntry("t1", "landed"), entries: [flowEntry("t1", "landed")] };
    branches.set("fl1", landed);
    h.recheck();
    await settled(h);
    expect(card("t1")).toMatchObject({ state: "done", outcome: "landed", flow: "fl1" });
    expect(said.map((x) => x.text)).toEqual([flowNote(t1, flowOf("t1"), landed)]);
    expect(said[0]?.text).toContain("result: review done, Build: Built it.");
  });

  test("a ready flow the queue never took settles ready once overdue, by the flow's end", async () => {
    const h = hub();
    await post(h, "plan", { run: "co1", tasks: [task({ workflow: "review" })] });
    await post(h, "start", { run: "co1" });
    move(h, "t1", "done", "ready");
    await settled(h);
    expect(card("t1")?.state).toBe("running");
    expect(h.waiting()).toBe(1);
    clock += 1000;
    h.recheck();
    expect(card("t1")).toMatchObject({ state: "done", outcome: "ready" });
    expect(h.waiting()).toBe(0);
  });

  test("a failed flow settles its card failed, a stopped one failed stopped", async () => {
    coordinator({ status: "idle" });
    const h = hub();
    await post(h, "plan", { run: "co1", tasks: [task({ workflow: "review" }), task({ title: "two", workflow: "review" })] });
    await post(h, "start", { run: "co1" });
    move(h, "t1", "failed", "nothing", { error: "the check failed" });
    move(h, "t2", "stopped", "uncommitted");
    await settled(h);
    expect(cards().map((t) => [t.state, t.outcome])).toEqual([
      ["failed", "failed"],
      ["failed", "stopped"],
    ]);
    expect((await hearAll(h)).map((x) => x.split("\n")[2])).toEqual(["outcome: failed", "outcome: stopped"]);
  });

  test("a stopped card flow picked up puts the card back to running, and it settles again", async () => {
    const h = hub();
    await post(h, "plan", { run: "co1", tasks: [task({ workflow: "review" }), task({ title: "two", workflow: "review" })] });
    await post(h, "start", { run: "co1" });
    move(h, "t1", "stopped", "uncommitted");
    move(h, "t2", "failed", "nothing");
    await settled(h);
    expect(card("t1")).toMatchObject({ state: "failed", outcome: "stopped" });
    move(h, "t1", "working", "working");
    await settled(h);
    expect(card("t1")).toMatchObject({ state: "running", flow: "fl1" });
    expect(card("t1")?.outcome).toBeUndefined();
    // a failed flow is not picked up, and its card stays as it settled
    move(h, "t2", "working", "working");
    await settled(h);
    expect(card("t2")).toMatchObject({ state: "failed", outcome: "failed" });
    branches.set("fl1", { verdict: "approve" });
    move(h, "t1", "done", "ready");
    await settled(h);
    expect(card("t1")).toMatchObject({ state: "done", outcome: "ready" });
  });

  test("a flow card's step runs and a card with an active flow are never adopted", async () => {
    const h = hub();
    await post(h, "plan", { run: "co1", tasks: [task({ workflow: "review" })] });
    await post(h, "start", { run: "co1" });
    const onItsBranch = (over: Partial<Run>): Run => {
      const r = { id: `f${++n}`, repoId: "web", action: "ask", status: "working", startedAt: clock, steps: [], note: "fix it", parent: "co1", branch: { ...branch("fl1"), state: "working" }, ...over } as unknown as Run;
      runs.set(r.id, r);
      h.onRun(r);
      return r;
    };
    onItsBranch({});
    await settled(h);
    expect(card("t1")).toMatchObject({ state: "running", flow: "fl1" });
    expect(card("t1")?.run).toBeUndefined();
    move(h, "t1", "failed", "nothing");
    await settled(h);
    expect(card("t1")).toMatchObject({ state: "failed", outcome: "failed" });
    onItsBranch({ flowStep: { workflow: "review", step: "Build", source: "bundled" } });
    await settled(h);
    expect(card("t1")).toMatchObject({ state: "failed", outcome: "failed" });
    expect(card("t1")?.run).toBeUndefined();
  });

  /** a run on the card's flow's branch that names no parent: a landing or
   *  PR fix, whose record the flow's last step run left with none */
  function parentless(over: Partial<Run> = {}): Run {
    const r = { id: `fx${++n}`, repoId: "web", action: "ask", status: "working", startedAt: clock, steps: [], note: "fix it", branch: { ...branch("fl1"), state: "working" }, ...over } as unknown as Run;
    runs.set(r.id, r);
    return r;
  }

  test("a flow card sent back reopens on a parentless run on its branch, settles again from that run, and the card after it starts once that run lands", async () => {
    coordinator({ status: "idle" });
    const h = hub();
    await post(h, "plan", { run: "co1", tasks: [task({ workflow: "review" }), task({ title: "two", after: ["t1"] })] });
    await post(h, "start", { run: "co1" });
    branches.set("fl1", { verdict: "auto", entry: flowEntry("t1", "red"), entries: [flowEntry("t1", "red")] });
    move(h, "t1", "done", "ready");
    await settled(h);
    expect(card("t1")).toMatchObject({ state: "failed", outcome: "sent back", flow: "fl1" });
    expect(card("t2")).toMatchObject({ state: "queued", outcome: "waits for t1, which failed" });
    const landed = flowEntry("t1", "landed");
    const fix = parentless();
    h.onRun(fix);
    await settled(h);
    expect(card("t1")).toMatchObject({ state: "running", run: fix.id, branch: "br-fl1", work: "w-test2345" });
    expect(card("t1")?.flow).toBeUndefined();
    expect(card("t1")?.outcome).toBeUndefined();
    expect(card("t2")).toMatchObject({ state: "queued", outcome: "waits for t1" });
    // the flow's later word no longer reaches the card
    const fl = flows.get("fl1");
    if (!fl) throw new Error("no fl1");
    h.onFlow({ ...fl, status: "done", endedAt: clock });
    await settled(h);
    expect(card("t1")).toMatchObject({ state: "running", run: fix.id });
    fix.status = "done";
    fix.endedAt = clock;
    fix.branch = { ...branch("fl1"), state: "ready" };
    fix.result = { text: "Fixed the gate.", durationMs: 1, turns: 1 };
    branches.set(fix.id, { verdict: "auto", entry: landed, entries: [landed] });
    h.onRun(fix);
    await settled(h);
    expect(card("t1")).toMatchObject({ state: "done", outcome: "landed", run: fix.id });
    expect(card("t2")?.state).toBe("running");
    const notes = (await hearAll(h)).filter((x) => x.startsWith("canopy: a task you started has settled"));
    expect(notes).toHaveLength(2);
    expect(notes[1]).toContain("result: Fixed the gate.");
  });

  test("a parentless run is not adopted when it is a flow's step, on a branch no card holds, beside an active flow, or for a coordinator that ended", async () => {
    const h = hub();
    await post(h, "plan", { run: "co1", tasks: [task({ workflow: "review" })] });
    await post(h, "start", { run: "co1" });
    const before = JSON.stringify(cards());
    // the card's flow is still active
    h.onRun(parentless());
    await settled(h);
    expect(JSON.stringify(cards())).toBe(before);
    move(h, "t1", "failed", "nothing");
    await settled(h);
    const failed = JSON.stringify(cards());
    h.onRun(parentless({ flowStep: { workflow: "review", step: "Build", source: "bundled" } }));
    h.onRun(parentless({ branch: { ...branch("elsewhere"), state: "working" } }));
    await settled(h);
    expect(JSON.stringify(cards())).toBe(failed);
    const co = runs.get("co1");
    if (!co) throw new Error("no co1");
    co.status = "stopped";
    h.onRun(co);
    h.onRun(parentless());
    await settled(h);
    expect(card("t1")).toMatchObject({ state: "failed", outcome: "failed", flow: "fl1" });
    expect(card("t1")?.run).toBeUndefined();
  });

  test("a card flow picked up after its coordinator ended leaves the card as it settled", async () => {
    const h = hub();
    await post(h, "plan", { run: "co1", tasks: [task({ workflow: "review" })] });
    await post(h, "start", { run: "co1" });
    move(h, "t1", "stopped", "uncommitted");
    await settled(h);
    const co = runs.get("co1");
    if (!co) throw new Error("no co1");
    co.status = "stopped";
    h.onRun(co);
    move(h, "t1", "working", "working");
    await settled(h);
    expect(card("t1")).toMatchObject({ state: "failed", outcome: "stopped" });
  });

  test("a flow the backend no longer keeps fails its card on recheck", async () => {
    const h = hub();
    await post(h, "plan", { run: "co1", tasks: [task({ workflow: "review" })] });
    await post(h, "start", { run: "co1" });
    flows.clear();
    h.recheck();
    expect(card("t1")).toMatchObject({ state: "failed", outcome: "its flow is no longer kept" });
  });

  test("a flow card whose ready branch waits for Eric outside the queue settles ready once its flow is no longer kept", async () => {
    coordinator({ status: "idle" });
    const h = hub();
    await post(h, "plan", { run: "co1", tasks: [task({ workflow: "review" })] });
    await post(h, "start", { run: "co1" });
    // the sort has yet to read the branch, so the card waits out the ready wait
    branches.set("fl1", { branchState: "ready", branchEnded: clock });
    move(h, "t1", "done", "ready");
    await settled(h);
    expect(card("t1")?.state).toBe("running");
    // the flows keep only the newest finished records
    flows.clear();
    h.recheck();
    await settled(h);
    expect(card("t1")?.state).toBe("running");
    // the sort leaves it to Eric, so nothing lands it by itself
    branches.set("fl1", { branchState: "ready", branchEnded: clock, verdict: "approve" });
    h.recheck();
    await settled(h);
    expect(card("t1")).toMatchObject({ state: "done", outcome: "ready" });
    expect((await hearAll(h)).filter((x) => x.includes("outcome: ready"))).toHaveLength(1);
  });

  test("a flow card whose flow is no longer kept and whose sort never says settles ready once the ready wait runs out", async () => {
    coordinator({ status: "idle" });
    const h = hub();
    await post(h, "plan", { run: "co1", tasks: [task({ workflow: "review" })] });
    await post(h, "start", { run: "co1" });
    branches.set("fl1", { branchState: "ready", branchEnded: clock });
    move(h, "t1", "done", "ready");
    flows.clear();
    h.recheck();
    await settled(h);
    expect(card("t1")?.state).toBe("running");
    clock += 1000;
    await new Promise((r) => setTimeout(r, 1100));
    await settled(h);
    expect(card("t1")).toMatchObject({ state: "done", outcome: "ready" });
  });

  test("Minor 3: a flow card waiting on the queue whose flow is no longer kept settles from its branch", async () => {
    coordinator({ status: "idle" });
    const h = hub();
    await post(h, "plan", { run: "co1", tasks: [task({ workflow: "review" }), task({ title: "two", workflow: "review" })] });
    await post(h, "start", { run: "co1" });
    branches.set("fl1", { verdict: "auto", entry: flowEntry("t1", "queued"), entries: [flowEntry("t1", "queued")] });
    branches.set("fl2", { verdict: "auto", entry: flowEntry("t2", "gate"), entries: [flowEntry("t2", "gate")] });
    move(h, "t1", "done", "ready");
    move(h, "t2", "done", "ready");
    await settled(h);
    expect(cards().map((t) => t.state)).toEqual(["running", "running"]);
    const t1 = card("t1");
    const t2 = card("t2");
    if (!t1 || !t2) throw new Error("no cards");
    // the flows keep only the newest finished records
    flows.clear();
    h.recheck();
    await settled(h);
    expect(cards().map((t) => t.state)).toEqual(["running", "running"]);
    const landedEntry = { ...flowEntryOf("fl1", "landed") };
    branches.set("fl1", { verdict: "auto", entry: landedEntry, entries: [landedEntry] });
    const red = { ...flowEntryOf("fl2", "red"), reason: "a gate went red" };
    branches.set("fl2", { verdict: "auto", entry: red, entries: [red] });
    h.recheck();
    await settled(h);
    expect(cards().map((t) => [t.state, t.outcome])).toEqual([
      ["done", "landed"],
      ["failed", "sent back"],
    ]);
    const heard = await hearAll(h);
    expect(heard).toContain(flowGoneNote(t1, "landed", { entry: landedEntry, entries: [landedEntry] }));
    expect(heard).toContain(flowGoneNote(t2, "sent back", { entry: red, entries: [red] }));
  });

  test("a flow card that settled ready lands later through its branch", async () => {
    const h = hub();
    await post(h, "plan", { run: "co1", tasks: [task({ workflow: "review" })] });
    await post(h, "start", { run: "co1" });
    branches.set("fl1", { verdict: "approve" });
    move(h, "t1", "done", "ready");
    await settled(h);
    expect(card("t1")).toMatchObject({ state: "done", outcome: "ready" });
    branches.set("fl1", { verdict: "approve", entry: flowEntry("t1", "landed"), entries: [flowEntry("t1", "landed")] });
    h.recheck();
    expect(card("t1")).toMatchObject({ state: "done", outcome: "landed" });
  });
});

describe("a card in a kept tree (FR-067 plan 2)", () => {
  const LIMIT = "You've hit your limit · resets 3pm";
  const FEAT_X = "trees:web/feat-x";
  /** the words a tree's start answers with while it is made, by branch */
  let making: Map<string, string>;
  /** every start the hub tried, `<coordinator>:<card>` */
  let tried: string[];

  beforeEach(() => {
    making = new Map();
    tried = [];
  });

  const treeRepo = (tree: string): string => `trees:web/${tree.replace(/\//g, "-")}`;

  /** an in-place run in a kept tree: no branch, `parent` the coordinator
   *  unless `over` says otherwise, as the runner tells everyone of it */
  function inTree(h: CoordinatorHub, repoId: string, over: Partial<Run> = {}): Run {
    const r = { id: `c${++n}`, repoId, action: "ask", status: "working", startedAt: clock, steps: [], note: "n", by: "coordinator", parent: "co1", ...over } as unknown as Run;
    runs.set(r.id, r);
    h.onRun(r);
    return r;
  }

  /** Eric's own run in a tree: it names no coordinator */
  function mine(h: CoordinatorHub, repoId: string): Run {
    const r = { id: `m${++n}`, repoId, action: "ask", status: "working", startedAt: clock, steps: [], note: "mine", by: "person" } as unknown as Run;
    runs.set(r.id, r);
    h.onRun(r);
    return r;
  }

  /** A hub whose start runs a tree card in place in its tree, busy while
   *  `making` names the branch or another run works there, and a plain card
   *  as a branch run. */
  function treeHub(over: Partial<CoordinatorDeps> = {}): CoordinatorHub {
    const h: CoordinatorHub = hub({
      startChild: async (coordId, t) => {
        tried.push(`${coordId}:${t.id}`);
        if (!t.tree) {
          started.push({ coord: coordId, task: t.id });
          const c = { id: `c${++n}`, repoId: t.repo, action: t.action, status: "working", startedAt: clock, steps: [], note: t.note, by: "coordinator", parent: coordId, branch: branch(`c${n}`) } as unknown as Run;
          runs.set(c.id, c);
          h.onRun(c);
          return { run: c };
        }
        const repoId = treeRepo(t.tree);
        const held = making.get(t.tree) ?? ([...runs.values()].some((r) => r.repoId === repoId && r.status === "working") ? `waiting for tree ${t.tree} to be free` : undefined);
        if (held) return { busy: held };
        started.push({ coord: coordId, task: t.id });
        return { run: inTree(h, repoId, { parent: coordId, action: t.action, note: t.note }) };
      },
      ...over,
    });
    return h;
  }

  /** one tree card on feat/x, started and settled done in its tree */
  async function doneInTree(h: CoordinatorHub): Promise<void> {
    await post(h, "plan", { run: "co1", tasks: [task({ tree: "feat/x" })] });
    await post(h, "start", { run: "co1" });
    end(h, "t1");
    await settled(h);
    expect(card("t1")).toMatchObject({ state: "done", outcome: "done in tree feat/x", run: "c1", treeRepo: FEAT_X });
  }

  describe("its own words", () => {
    test("a tree card keeps the words its start answered while a plain card in a full repo waits for a slot; onTrees tries it again", async () => {
      full.add("web");
      making.set("feat/x", "making tree feat/x");
      const h = treeHub();
      await post(h, "plan", { run: "co1", tasks: [task({ tree: "feat/x" }), task({ title: "two" })] });
      await post(h, "start", { run: "co1" });
      await settled(h);
      expect(cards().map((t) => [t.id, t.state, t.outcome])).toEqual([
        ["t1", "queued", "making tree feat/x"],
        ["t2", "queued", "waiting for a branch slot in web"],
      ]);
      expect(tried).toEqual(["co1:t1"]);
      h.onTrees();
      await settled(h);
      expect(card("t1")).toMatchObject({ state: "queued", outcome: "making tree feat/x" });
      expect(tried).toEqual(["co1:t1", "co1:t1"]);
      // the tree is ready: the next word from the trees starts it, in place
      making.delete("feat/x");
      h.onTrees();
      await settled(h);
      expect(card("t1")).toMatchObject({ state: "running", run: "c1", treeRepo: FEAT_X });
      expect(card("t1")?.outcome).toBeUndefined();
      expect(card("t1")?.branch).toBeUndefined();
      expect(card("t2")).toMatchObject({ state: "queued", outcome: "waiting for a branch slot in web" });
    });

    test("onTrees pumps a coordinator with a queued tree card, and not one whose queued cards are all plain", async () => {
      full.add("api");
      making.set("feat/x", "making tree feat/x");
      coordinator({ id: "co2", repoId: "api" });
      const h = treeHub();
      await post(h, "plan", { run: "co1", tasks: [task({ tree: "feat/x" })] });
      await post(h, "start", { run: "co1" });
      await post(h, "plan", { run: "co2", tasks: [task({ repo: "api" })] });
      await post(h, "start", { run: "co2" });
      await settled(h);
      expect(card("t1", "co2")).toMatchObject({ state: "queued", outcome: "waiting for a branch slot in api" });
      // a slot frees in api with no run ending: only a pump of co2 would start its card
      full.delete("api");
      h.onTrees();
      await settled(h);
      expect(tried).toEqual(["co1:t1", "co1:t1"]);
      expect(card("t1", "co2")?.state).toBe("queued");
    });

    test("cards on one tree go in plan order: a card whose start makes the tree holds the later ones on it this pass, even once the tree is ready", async () => {
      // the tree is ready the moment its first start has answered
      making = new (class extends Map<string, string> {
        override get(key: string): string | undefined {
          const words = super.get(key);
          this.delete(key);
          return words;
        }
      })([["feat/x", "making tree feat/x"]]);
      const h = treeHub();
      await post(h, "plan", { run: "co1", tasks: [task({ tree: "feat/x" }), task({ title: "two", tree: "feat/x" }), task({ title: "three", tree: "feat/y" })] });
      await post(h, "start", { run: "co1" });
      await settled(h);
      expect(cards().map((t) => [t.id, t.state, t.outcome])).toEqual([
        ["t1", "queued", "making tree feat/x"],
        ["t2", "queued", "making tree feat/x"],
        ["t3", "running", undefined],
      ]);
      expect(tried).toEqual(["co1:t1", "co1:t3"]);
      h.onTrees();
      await settled(h);
      expect(cards().map((t) => [t.id, t.state, t.outcome])).toEqual([
        ["t1", "running", undefined],
        ["t2", "queued", "waiting for tree feat/x to be free"],
        ["t3", "running", undefined],
      ]);
    });

    test("a tree card waiting for its tree to be free keeps those words, and starts once the run there ends", async () => {
      const h = treeHub();
      const his = mine(h, FEAT_X);
      await post(h, "plan", { run: "co1", tasks: [task({ tree: "feat/x" })] });
      await post(h, "start", { run: "co1" });
      await settled(h);
      expect(card("t1")).toMatchObject({ state: "queued", outcome: "waiting for tree feat/x to be free" });
      his.status = "stopped";
      his.endedAt = clock;
      h.onRun(his);
      await settled(h);
      expect(card("t1")).toMatchObject({ state: "running", treeRepo: FEAT_X });
      expect(card("t1")?.run).not.toBe(his.id);
    });
  });

  describe("settling", () => {
    test("a started tree card settles on its run alone: done in its tree, with the tree's note and no timer", async () => {
      coordinator({ status: "idle" });
      const h = treeHub();
      await post(h, "plan", { run: "co1", tasks: [task({ tree: "feat/x" })] });
      await post(h, "start", { run: "co1" });
      await settled(h);
      expect(card("t1")).toMatchObject({ state: "running", run: "c1", treeRepo: FEAT_X });
      const was = card("t1");
      if (!was) throw new Error("no t1");
      const run = end(h, "t1", { result: "Made the login keep the email." });
      await settled(h);
      expect(card("t1")).toMatchObject({ state: "done", outcome: "done in tree feat/x", run: "c1" });
      expect(h.waiting()).toBe(0);
      expect(said).toEqual([{ id: "co1", text: treeNote(was, run, "done in tree feat/x"), cards: "cards now: t1 done" }]);
    });

    test("a failed run settles its card failed, and a stopped one stopped", async () => {
      const h = treeHub();
      await post(h, "plan", { run: "co1", tasks: [task({ tree: "feat/x" }), task({ title: "two", tree: "feat/y" })] });
      await post(h, "start", { run: "co1" });
      await settled(h);
      end(h, "t1", { status: "failed" });
      end(h, "t2", { status: "stopped" });
      await settled(h);
      expect(cards().map((t) => [t.id, t.state, t.outcome])).toEqual([
        ["t1", "failed", "failed"],
        ["t2", "failed", "stopped"],
      ]);
      expect(h.waiting()).toBe(0);
      const notes = (await hearAll(h)).filter((x) => x.startsWith("canopy: a task you started has settled"));
      expect(notes).toHaveLength(2);
      expect(notes[0]).toContain("tree: feat/x, a kept worktree");
      expect(notes[1]).toContain("outcome: stopped");
    });

    test("a card after it, on the same tree, starts once it is done, and that start leaves the first card its own run", async () => {
      const h = treeHub();
      await post(h, "plan", { run: "co1", tasks: [task({ tree: "feat/x" }), task({ title: "two", tree: "feat/x", after: ["t1"] })] });
      await post(h, "start", { run: "co1" });
      await settled(h);
      expect(card("t2")).toMatchObject({ state: "queued", outcome: "waits for t1" });
      end(h, "t1");
      await settled(h);
      expect(card("t1")).toMatchObject({ state: "done", outcome: "done in tree feat/x", run: "c1" });
      expect(card("t2")).toMatchObject({ state: "running", run: "c2", treeRepo: FEAT_X });
      expect(started.map((s) => s.task)).toEqual(["t1", "t2"]);
    });
  });

  describe("adoption (Review Focus 2)", () => {
    test("a later run in its tree that names its coordinator reopens a done card; Eric's run there, with no parent, changes nothing", async () => {
      coordinator({ status: "idle" });
      const h = treeHub();
      await doneInTree(h);
      const his = mine(h, FEAT_X);
      await settled(h);
      expect(card("t1")).toMatchObject({ state: "done", outcome: "done in tree feat/x", run: "c1" });
      his.status = "done";
      his.endedAt = clock;
      h.onRun(his);
      await settled(h);
      expect(card("t1")).toMatchObject({ state: "done", run: "c1" });
      // a run there for another coordinator is not its either
      inTree(h, FEAT_X, { parent: "someone", status: "done" });
      await settled(h);
      expect(card("t1")).toMatchObject({ state: "done", run: "c1" });
      const later = inTree(h, FEAT_X);
      await settled(h);
      expect(card("t1")).toMatchObject({ state: "running", run: later.id, treeRepo: FEAT_X });
      expect(card("t1")?.outcome).toBeUndefined();
      end(h, "t1", { result: "Also kept the name." });
      await settled(h);
      expect(card("t1")).toMatchObject({ state: "done", outcome: "done in tree feat/x", run: later.id });
      const notes = (await hearAll(h)).filter((x) => x.startsWith("canopy: a task you started has settled"));
      expect(notes).toHaveLength(2);
      expect(notes[1]).toContain("result: Also kept the name.");
    });

    test("a failed tree card reopens on a later run in its tree; a run in another tree takes nothing", async () => {
      const h = treeHub();
      await post(h, "plan", { run: "co1", tasks: [task({ tree: "feat/x" })] });
      await post(h, "start", { run: "co1" });
      end(h, "t1", { status: "failed" });
      await settled(h);
      expect(card("t1")).toMatchObject({ state: "failed", outcome: "failed" });
      inTree(h, treeRepo("feat/y"));
      await settled(h);
      expect(card("t1")).toMatchObject({ state: "failed", run: "c1" });
      const later = inTree(h, FEAT_X);
      await settled(h);
      expect(card("t1")).toMatchObject({ state: "running", run: later.id });
    });

    test("with two cards on one tree, the later card takes a later run there", async () => {
      const h = treeHub();
      await post(h, "plan", { run: "co1", tasks: [task({ tree: "feat/x" }), task({ title: "two", tree: "feat/x" })] });
      await post(h, "start", { run: "co1" });
      await settled(h);
      expect(card("t2")).toMatchObject({ state: "queued", outcome: "waiting for tree feat/x to be free" });
      end(h, "t1");
      await settled(h);
      expect(card("t2")).toMatchObject({ state: "running", run: "c2" });
      expect(card("t1")).toMatchObject({ state: "done", run: "c1" });
      end(h, "t2");
      await settled(h);
      const later = inTree(h, FEAT_X);
      await settled(h);
      expect(card("t2")).toMatchObject({ state: "running", run: later.id });
      expect(card("t1")).toMatchObject({ state: "done", run: "c1" });
    });

    test("a follow-up on the first of two cards on one tree goes to that card, not to the later one", async () => {
      const h = treeHub({ followTree: async (coordId) => ({ run: inTree(h, FEAT_X, { parent: coordId }) }) });
      await post(h, "plan", { run: "co1", tasks: [task({ tree: "feat/x" }), task({ title: "two", tree: "feat/x" })] });
      await post(h, "start", { run: "co1" });
      await settled(h);
      end(h, "t1");
      await settled(h);
      end(h, "t2");
      await settled(h);
      expect((await post(h, "followup", { run: "co1", id: "t1" })).status).toBe(200);
      expect(card("t1")).toMatchObject({ state: "running", run: "c3" });
      expect(card("t2")).toMatchObject({ state: "done", run: "c2" });
    });
  });

  describe("the limit", () => {
    test("a tree card's child that hits the limit carries on in its tree after the reset: the note says so, and a wake resumes it with that card", async () => {
      clock = Date.UTC(2026, 9, 26, 12);
      coordinator({ status: "idle" });
      const resumed: [string, string | undefined, string, string][] = [];
      const h = treeHub({
        resumeChild: async (coordId, t, old, priority) => {
          resumed.push([t.id, t.tree, old.id, priority]);
          return { run: inTree(h, FEAT_X, { parent: coordId }) };
        },
      });
      await post(h, "plan", { run: "co1", tasks: [task({ tree: "feat/x" })] });
      await post(h, "start", { run: "co1" });
      await settled(h);
      const limit = (r: Run): void => {
        r.status = "limited";
        r.endedAt = clock;
        r.error = LIMIT;
        r.limited = { at: clock, text: LIMIT };
        h.onRun(r);
      };
      const first = child("t1");
      limit(first);
      await settled(h);
      expect([card("t1")?.state, card("t1")?.outcome, card("t1")?.limited]).toEqual(["running", "waiting for capacity (resets 15:00)", 0]);
      expect(said.map((s) => s.text)).toEqual(["canopy: task t1 (fix the login) stopped at the plan's usage limit; it carries on in tree feat/x after the reset"]);
      h.wake(() => true);
      await settled(h);
      expect(resumed).toEqual([["t1", "feat/x", first.id, "normal"]]);
      expect(card("t1")).toMatchObject({ state: "running", run: "c2", limited: 1 });
      expect(card("t1")?.outcome).toBeUndefined();
      // limited again after its resume: it fails, with the tree's note
      limit(child("t1"));
      await settled(h);
      expect([card("t1")?.state, card("t1")?.outcome]).toEqual(["failed", "the plan's usage limit, twice in a row"]);
      const note = (await hearAll(h)).find((x) => x.startsWith("canopy: a task you started has settled"));
      expect(note).toContain("tree: feat/x, a kept worktree");
    });

    /** A tree card whose child hit the limit and whose resume finds its tree
     *  busy (Eric's run there, or `merging`), as Task 4's resumeChild answers. */
    async function limitedTreeBusy(over: { merging?: () => boolean } = {}): Promise<{ h: CoordinatorHub; resumed: string[]; his: Run }> {
      clock = Date.UTC(2026, 9, 26, 12);
      coordinator({ status: "idle" });
      const resumed: string[] = [];
      const h = treeHub({
        resumeChild: async (coordId, t, _old, priority) => {
          resumed.push(`${t.id} ${priority}`);
          const busy = over.merging?.() === true || [...runs.values()].some((r) => r.repoId === FEAT_X && r.status === "working");
          if (busy) return { busy: "waiting for tree feat/x to be free" };
          return { run: inTree(h, FEAT_X, { parent: coordId }) };
        },
      });
      await post(h, "plan", { run: "co1", tasks: [task({ tree: "feat/x" })] });
      await post(h, "start", { run: "co1" });
      await settled(h);
      const first = child("t1");
      first.status = "limited";
      first.endedAt = clock;
      first.error = LIMIT;
      first.limited = { at: clock, text: LIMIT };
      h.onRun(first);
      await settled(h);
      // Eric starts a run in the tree while the card waits for the reset
      const his = mine(h, FEAT_X);
      h.wake(() => true);
      await settled(h);
      expect(resumed).toEqual(["t1 normal"]);
      expect(card("t1")).toMatchObject({ state: "running", run: first.id, limited: 0, outcome: "waiting for tree feat/x to be free" });
      return { h, resumed, his };
    }

    test("Fix 1: a resume that finds its tree busy keeps the tree's words; a recheck neither rewrites them nor says the limit again", async () => {
      const { h } = await limitedTreeBusy();
      h.recheck();
      await settled(h);
      expect(card("t1")).toMatchObject({ state: "running", limited: 0, outcome: "waiting for tree feat/x to be free" });
      const limitNotes = (await hearAll(h)).filter((x) => x.includes("stopped at the plan's usage limit"));
      expect(limitNotes).toEqual(["canopy: task t1 (fix the login) stopped at the plan's usage limit; it carries on in tree feat/x after the reset"]);
    });

    test("Fix 1: such a card stays on the held chip, and start anyway tries its resume as interactive", async () => {
      const { h, resumed } = await limitedTreeBusy();
      expect(h.heldStarts().map((x) => [x.id, x.why])).toEqual([["card:co1:t1", "waiting for tree feat/x to be free"]]);
      await h.release("co1", "t1");
      await settled(h);
      expect(resumed).toEqual(["t1 normal", "t1 interactive"]);
      expect(card("t1")).toMatchObject({ state: "running", limited: 0, outcome: "waiting for tree feat/x to be free" });
    });

    test("Fix 1: the run that held its tree ending tries the resume again, and the card carries on", async () => {
      const { h, resumed, his } = await limitedTreeBusy();
      his.status = "done";
      his.endedAt = clock;
      h.onRun(his);
      await settled(h);
      expect(resumed).toEqual(["t1 normal", "t1 normal"]);
      expect(card("t1")).toMatchObject({ state: "running", run: "c3", limited: 1 });
      expect(card("t1")?.outcome).toBeUndefined();
      expect(h.heldStarts()).toEqual([]);
    });

    test("Fix 1: a run ending in another tree tries nothing; the trees moving (a merge done) tries it again", async () => {
      let merging = true;
      const { h, resumed, his } = await limitedTreeBusy({ merging: () => merging });
      his.status = "done";
      his.endedAt = clock;
      h.onRun(his);
      await settled(h);
      // the merge still holds the tree: the retry answers busy again
      expect(resumed).toEqual(["t1 normal", "t1 normal"]);
      const other = inTree(h, treeRepo("feat/y"), { parent: undefined, by: "person" });
      other.status = "done";
      other.endedAt = clock;
      h.onRun(other);
      await settled(h);
      expect(resumed).toHaveLength(2);
      merging = false;
      h.onTrees();
      await settled(h);
      expect(resumed).toEqual(["t1 normal", "t1 normal", "t1 normal"]);
      expect(card("t1")).toMatchObject({ state: "running", limited: 1 });
    });
  });

  describe("the follow-up route", () => {
    test("the page's follow-up on a done tree card starts a run in its tree as interactive, and the card runs with it and settles again", async () => {
      const calls: [string, CoordTask, string | undefined, string][] = [];
      const h = treeHub({
        followTree: async (coordId, t, note, priority) => {
          calls.push([coordId, t, note, priority]);
          return { run: inTree(h, FEAT_X, { parent: coordId }) };
        },
      });
      await doneInTree(h);
      const before = card("t1");
      if (!before) throw new Error("no t1");
      const got = await post(h, "followup", { run: "co1", id: "t1", note: "also y" });
      expect(got.status).toBe(200);
      expect(got.body["ok"]).toBe(true);
      expect(got.body["run"]).toMatchObject({ id: "c2", parent: "co1", repoId: FEAT_X });
      expect(calls).toEqual([["co1", before, "also y", "interactive"]]);
      expect(card("t1")).toMatchObject({ state: "running", run: "c2", treeRepo: FEAT_X });
      expect(card("t1")?.outcome).toBeUndefined();
      end(h, "t1");
      await settled(h);
      expect(card("t1")).toMatchObject({ state: "done", outcome: "done in tree feat/x", run: "c2" });
      // a follow-up with no note leaves the words to the server
      expect((await post(h, "followup", { run: "co1", id: "t1" })).status).toBe(200);
      expect(calls.at(-1)?.[2]).toBeUndefined();
    });

    test("a failed tree card takes a follow-up too", async () => {
      const h = treeHub({ followTree: async (coordId) => ({ run: inTree(h, FEAT_X, { parent: coordId }) }) });
      await post(h, "plan", { run: "co1", tasks: [task({ tree: "feat/x" })] });
      await post(h, "start", { run: "co1" });
      end(h, "t1", { status: "failed" });
      await settled(h);
      expect((await post(h, "followup", { run: "co1", id: "t1", note: "try again" })).status).toBe(200);
      expect(card("t1")).toMatchObject({ state: "running", run: "c2" });
    });

    test("refuses in order: a coordinator's token, a branch card, a card at the limit, one at work, one not settled, one that never ran in its tree, a long note", async () => {
      const calls: string[] = [];
      const h = hub({
        followTree: async (_c, t) => {
          calls.push(t.id);
          throw new Error("not reached");
        },
      });
      const co = runs.get("co1");
      if (!co) throw new Error("no co1");
      const base: CoordTask = { id: "t1", title: "fix the login", repo: "web", note: "n", action: "ask", state: "done", outcome: "done in tree feat/x", tree: "feat/x", treeRepo: FEAT_X, run: "c1" };
      const own = (status: Run["status"], over: Partial<Run> = {}): void => {
        runs.set("c1", { id: "c1", repoId: FEAT_X, action: "ask", status, startedAt: 1, steps: [], note: "n", parent: "co1", ...over } as unknown as Run);
      };
      const ask = async (t: CoordTask, body: Record<string, unknown> = {}, caller: Caller = page) => {
        co.tasks = [t];
        return post(h, "followup", { run: "co1", id: "t1", note: "also y", ...body }, caller);
      };
      const long = "x".repeat(4001);
      const { tree: _tree, treeRepo: _treeRepo, ...plain } = base;
      own("done");
      expect(await ask({ ...plain, outcome: "ready", branch: "br-c1" }, {}, coordCaller("co1"))).toEqual({ status: 403, body: { error: "a coordinator proposes; a follow-up is Eric's" } });
      expect(await ask({ ...plain, outcome: "ready", branch: "br-c1" }, { note: long })).toEqual({ status: 400, body: { error: "t1 is not in a tree; follow a branch card up on its branch" } });
      expect(await ask({ ...plain, state: "proposed" })).toEqual({ status: 400, body: { error: "t1 is not in a tree; follow a branch card up on its branch" } });
      own("limited", { endedAt: 5, error: LIMIT, limited: { at: 5, text: LIMIT } });
      expect(await ask({ ...base, state: "running", outcome: "waiting for capacity (resets 15:00)", limited: 0 }, { note: long })).toEqual({ status: 409, body: { error: "t1 carries on after the reset" } });
      own("working");
      expect(await ask({ ...base, state: "running" }, { note: long })).toEqual({ status: 409, body: { error: "t1's run is at work; say it to the run" } });
      const { treeRepo: _r, run: _run, outcome: _o, ...fresh } = base;
      expect(await ask({ ...fresh, state: "proposed" }, { note: long })).toEqual({ status: 409, body: { error: "t1 is proposed; only a settled card in a tree takes a follow-up" } });
      expect(await ask({ ...fresh, state: "queued" })).toEqual({ status: 409, body: { error: "t1 is queued; only a settled card in a tree takes a follow-up" } });
      expect(await ask({ ...base, state: "dropped" })).toEqual({ status: 409, body: { error: "t1 is dropped; only a settled card in a tree takes a follow-up" } });
      // the carried finding: a tree card that failed before its tree started
      expect(await ask({ ...fresh, state: "failed", outcome: "tree feat/x failed: setup exited 3" }, { note: long })).toEqual({ status: 409, body: { error: "t1 never ran in its tree; start it again from the plan" } });
      own("done");
      expect(await ask(base, { note: long })).toEqual({ status: 400, body: { error: "note must be text of at most 4000 characters" } });
      expect(await ask(base, { note: 7 })).toEqual({ status: 400, body: { error: "note must be text of at most 4000 characters" } });
      expect(await ask(base, { id: "t9" })).toEqual({ status: 404, body: { error: "no card t9" } });
      expect(await ask(base, { run: "nope" })).toEqual({ status: 404, body: { error: "no run nope" } });
      expect(calls).toEqual([]);
    });

    test("a card whose follow-up is in flight answers that it is starting, and the first follow-up's run wins", async () => {
      let open = (): void => {};
      const gate = new Promise<void>((r) => {
        open = r;
      });
      let reached = (): void => {};
      const inside = new Promise<void>((r) => {
        reached = r;
      });
      const h = treeHub({
        followTree: async (coordId) => {
          reached();
          await gate;
          return { run: inTree(h, FEAT_X, { parent: coordId }) };
        },
      });
      await doneInTree(h);
      const first = post(h, "followup", { run: "co1", id: "t1" });
      await inside;
      expect(await post(h, "followup", { run: "co1", id: "t1", note: "x".repeat(4001) })).toEqual({ status: 409, body: { error: "t1 is starting" } });
      open();
      expect((await first).status).toBe(200);
      expect(card("t1")).toMatchObject({ state: "running", run: "c2" });
    });

    test("Review Focus 4: a follow-up the tree cannot take answers 409 with its words and leaves the card as it was", async () => {
      let answer = async (): Promise<ChildResume> => ({ busy: "waiting for tree feat/x to be free" });
      const h = treeHub({ followTree: () => answer() });
      await doneInTree(h);
      const before = card("t1");
      expect(await post(h, "followup", { run: "co1", id: "t1", note: "also y" })).toEqual({ status: 409, body: { error: "waiting for tree feat/x to be free" } });
      expect(card("t1")).toEqual(before);
      answer = async () => {
        throw new Error("tree feat/x is no longer kept in web");
      };
      expect(await post(h, "followup", { run: "co1", id: "t1", note: "also y" })).toEqual({ status: 409, body: { error: "tree feat/x is no longer kept in web" } });
      expect(card("t1")).toEqual(before);
    });
  });

  test("a goal that ends while its tree is made drops the queued tree card, and a later onTrees starts nothing", async () => {
    making.set("feat/x", "making tree feat/x");
    const h = treeHub();
    await post(h, "plan", { run: "co1", tasks: [task({ tree: "feat/x" })] });
    await post(h, "start", { run: "co1" });
    await settled(h);
    expect(card("t1")).toMatchObject({ state: "queued", outcome: "making tree feat/x" });
    const co = runs.get("co1");
    if (!co) throw new Error("no co1");
    co.status = "stopped";
    h.onRun(co);
    await settled(h);
    expect(card("t1")?.state).toBe("dropped");
    making.delete("feat/x");
    const before = tried.length;
    h.onTrees();
    await settled(h);
    expect(tried.length).toBe(before);
    expect(card("t1")?.state).toBe("dropped");
  });
});
