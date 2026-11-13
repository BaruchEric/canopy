import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { blockedNote, holdNote, landedNote, validatePlan, type ChildBranch } from "../core/coordinator";
import { EMPTY_LOADOUTS } from "../core/loadout";
import type { RunGroup } from "../core/group";
import type { CoordTask, LandEntry, Loadout, LoadoutsInfo, Run, RunBranch } from "../core/types";
import type { Caller } from "./callers";
import { CoordinatorHub, type CoordinatorDeps } from "./coordinator";

let runs: Map<string, Run>;
let said: { id: string; text: string }[];
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

const lo = (over: Partial<Loadout> = {}): Loadout => ({ name: "quick", note: "", harness: "claude", model: "default", effort: "default", skills: [], mcp: [], canopyTools: false, ...over });
const kit: LoadoutsInfo = { base: [], loadouts: [lo()], errors: [] };

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
      const child = { id: `c${++n}`, repoId: task.repo, action: task.action, status: "working", startedAt: clock, steps: [], note: task.note, by: "coordinator", parent: coordId, branch: branch(`c${n}`) } as unknown as Run;
      runs.set(child.id, child);
      // the runner tells everyone about a run before its start returns
      h.onRun(child);
      return { run: child };
    },
    say: (id, text) => {
      const co = runs.get(id);
      if (co?.status !== "idle") throw new Error("still replying");
      said.push({ id, text });
      co.status = "working";
      h.onRun(co);
    },
    repoFull: (repo) => full.has(repo),
    known: (repo) => (repo === "web" || repo === "api" ? "local" : repo === "mini:box" ? "remote" : null),
    landing: (run) => branches.get(run.id) ?? {},
    // a child's branch is br-<child id>, so the branch's facts are its child's
    branch: (origin) => branches.get(origin.replace(/^br-/, "")) ?? {},
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
    h.onFlow({ status: "working", branch: {} });
    await settled(h);
    expect(card("t1")?.state).toBe("queued");
    h.onFlow({ status: "done" });
    await settled(h);
    expect(card("t1")?.state).toBe("queued");
    h.onFlow({ status: "done", branch: {} });
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
    expect("tasks" in validatePlan(body.tasks, { known: () => "local", cards: [], next: 1, loadouts: EMPTY_LOADOUTS, workflows: () => [], by: "person" })).toBe(true);
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
    expect((await hearAll(h)).filter((t) => t === blockedNote(t2, "waits for t1, which failed"))).toHaveLength(1);
    expect(started.map((s) => s.task)).toEqual(["t1"]);
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
