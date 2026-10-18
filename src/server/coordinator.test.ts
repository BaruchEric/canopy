import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { validatePlan, type ChildBranch } from "../core/coordinator";
import type { CoordTask, LandEntry, Run, RunBranch } from "../core/types";
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

const branch = (id: string, state: RunBranch["state"] = "working"): RunBranch => ({ name: `run/x-${id}`, target: "main", base: "b", dir: `/w/${id}`, state, origin: `br-${id}` });

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
    expect(await post(h, "tasks", { run: "co1", id: "t1", title: "other" })).toEqual({ status: 409, body: { error: "t1 is running; only a proposed card changes" } });
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
    expect("tasks" in validatePlan(body.tasks, { known: () => "local", have: 0 })).toBe(true);
  });
});
