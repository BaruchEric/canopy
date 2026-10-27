import { describe, expect, test } from "bun:test";
import { enqueue } from "../core/landing";
import type { LandingInfo, LandingRun, LandNotice, Repo, RepoFile, Run, RunStep } from "../core/types";
import { CollisionHub } from "./collisions";

const edit = (id: string, ...paths: string[]): RunStep => ({ id, at: 1, kind: "tool", tool: { name: "Edit", title: `edit ${paths[0] ?? ""}`, status: "ok", ...(paths.length ? { paths } : {}) } });
const branch = (id: string): NonNullable<Run["branch"]> => ({ name: `run/x-${id}`, target: "main", base: "b0", dir: `/w/${id}`, state: "working", origin: id });
const run = (id: string, steps: RunStep[], over: Partial<Run> = {}): Run => ({ id, repoId: "canopy", action: "propose", verb: "Plan, then build", progress: "", expectsChange: true, chat: false, harness: "claude", note: `work ${id}`, status: "working", startedAt: 1_000, steps, prompt: null, branch: branch(id), ...over });
const file = (path: string): RepoFile => ({ path, index: ".", worktree: "M", untracked: false, conflicted: false });

interface WorldValues {
  notes: [string, string][];
  says: [string, string][];
  notices: Omit<LandNotice, "id" | "at">[];
  published: number;
  off: boolean;
  refuse: number;
  landing: LandingInfo;
  repo: Repo;
  remembered: [string, { with: string; paths: string[] }][];
}

function world(opts: { groupOf?: (r: Run) => string | undefined; sayOff?: (path: string) => boolean | Promise<boolean> } = {}) {
  const runs = new Map<string, Run>();
  const w: WorldValues = {
    notes: [],
    says: [],
    notices: [],
    published: 0,
    off: false,
    refuse: 0,
    landing: { runs: [], entries: [], orphans: [] },
    repo: { id: "canopy", name: "canopy", path: "/r/canopy", group: "", source: "root", status: null },
    remembered: [],
  };
  const hub = new CollisionHub({
    runs: () => [...runs.values()],
    repo: (id) => (id === "canopy" ? w.repo : undefined),
    landing: () => w.landing,
    note: (id, text) => w.notes.push([id, text]),
    say: (id, text) => {
      if (w.refuse > 0) {
        w.refuse -= 1;
        throw new Error("still replying");
      }
      w.says.push([id, text]);
    },
    notify: (n) => w.notices.push(n),
    rememberOverlap: (origin, overlap) => w.remembered.push([origin, overlap]),
    publish: () => {
      w.published += 1;
    },
    sayOff: opts.sayOff ?? (() => w.off),
    ...(opts.groupOf ? { groupOf: opts.groupOf } : {}),
    now: () => 61_000,
  });
  const see = (r: Run): Run => {
    runs.set(r.id, r);
    hub.onRun(r);
    return r;
  };
  return { w, hub, see };
}

describe("two live runs", () => {
  test("a note on each from its own side, one notice, the list, and a second note only after five more paths", () => {
    const { w, hub, see } = world();
    see(run("a", [edit("1", "x.ts")]));
    see(run("b", [edit("1", "x.ts", "y.ts")]));
    expect(w.notes).toEqual([
      ["b", "also being edited by Plan, then build run a: x.ts"],
      ["a", "also being edited by Plan, then build run b: x.ts"],
    ]);
    expect(w.notices).toEqual([{ entry: "b", repoId: "canopy", branch: "run/x-b", note: "work b", kind: "collision", why: "run/x-b and run/x-a both edit x.ts" }]);
    expect(hub.list()).toEqual([{ id: "a+b", repoId: "canopy", run: "b", name: "run/x-b", with: { kind: "run", run: "a", verb: "Plan, then build", name: "run/x-a" }, paths: ["x.ts"], at: 61_000 }]);
    expect(w.published).toBe(1);
    see(run("a", [edit("1", "x.ts"), edit("2", "y.ts")]));
    expect([w.notes.length, hub.list()[0]?.paths]).toEqual([2, ["x.ts", "y.ts"]]);
    see(run("a", [edit("1", "x.ts"), edit("2", "y.ts"), edit("3", "p1", "p2", "p3", "p4")]));
    see(run("b", [edit("1", "x.ts", "y.ts"), edit("2", "p1", "p2", "p3", "p4")]));
    expect(w.notes.slice(2)).toEqual([
      ["b", "also being edited by Plan, then build run a: p1, p2, p3, p4, x.ts and 1 more"],
      ["a", "also being edited by Plan, then build run b: p1, p2, p3, p4, x.ts and 1 more"],
    ]);
    expect([w.notices.length, w.says]).toEqual([1, []]);
    expect(hub.working("canopy").map((t) => t.run).sort()).toEqual(["a", "b"]);
  });

  test("a pair goes when a run ends; a run first seen with many steps starts whole", () => {
    const { hub, see } = world();
    see(run("a", [edit("1", "x.ts"), edit("2", "y.ts"), edit("3", "z.ts")]));
    const first = hub.working("canopy")[0];
    expect(first ? [...first.paths] : []).toEqual(["x.ts", "y.ts", "z.ts"]);
    see(run("b", [edit("1", "z.ts")]));
    expect(hub.list()).toHaveLength(1);
    see(run("a", [], { status: "done", endedAt: 2_000 }));
    expect([hub.list(), hub.working("canopy").map((t) => t.run)]).toEqual([[], ["b"]]);
    see(run("b", [], { status: "limited", endedAt: 3_000 }));
    expect(hub.working("canopy")).toEqual([]);
  });

  test("the group hook: two runs of one group never collide", () => {
    const { hub, see } = world({ groupOf: (r) => (r.note === "work a" || r.note === "work b" ? "g-1" : undefined) });
    see(run("a", [edit("1", "x.ts")]));
    see(run("b", [edit("1", "x.ts")]));
    see(run("c", [edit("1", "x.ts")]));
    expect(hub.list().map((c) => c.id).sort()).toEqual(["a+c", "b+c"]);
  });
});

describe("chats", () => {
  const chat = (id: string, steps: RunStep[], status: Run["status"], over: Partial<Run> = {}) => run(id, steps, { chat: true, verb: "chat", branch: undefined, status, ...over });
  test("an idle chat hears it once, a working one at its next idle while the pair stands, and a refused say stays pending", async () => {
    const { w, see } = world();
    see(chat("c", [edit("1", "x.ts")], "idle"));
    see(run("a", [edit("1", "x.ts")]));
    await Bun.sleep(0);
    expect(w.says).toEqual([["c", "canopy: another run (Plan, then build, started 1m) has edited these files since you started: <<< x.ts >>>. Carry on; the queue rebases when you land."]]);
    see(run("a", [edit("1", "x.ts"), edit("2", "y.ts")]));
    expect(w.says).toHaveLength(1);
    see(chat("d", [edit("1", "q.ts")], "working"));
    see(run("b", [edit("1", "q.ts")]));
    expect(w.says).toHaveLength(1);
    w.refuse = 1;
    see(chat("d", [edit("1", "q.ts")], "idle"));
    await Bun.sleep(0);
    expect(w.says).toHaveLength(1);
    see(chat("d", [edit("1", "q.ts")], "idle"));
    await Bun.sleep(0);
    expect(w.says[1]?.[0]).toBe("d");
    see(chat("e", [edit("1", "r.ts")], "working"));
    see(run("f", [edit("1", "r.ts")]));
    see(run("f", [], { status: "done", endedAt: 2_000 }));
    see(chat("e", [edit("1", "r.ts")], "idle"));
    expect(w.says).toHaveLength(2);
  });

  test("an async say-off check rechecks the idle state before speaking and keeps the pending pair", async () => {
    let release = () => {};
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { w, see } = world({ sayOff: async () => {
      await waiting;
      return false;
    } });
    see(chat("c", [edit("1", "x.ts")], "idle"));
    see(run("a", [edit("1", "x.ts")]));
    see(chat("c", [edit("1", "x.ts")], "working"));
    release();
    await Bun.sleep(0);
    expect(w.says).toEqual([]);
    see(chat("c", [edit("1", "x.ts")], "idle"));
    await Bun.sleep(0);
    expect(w.says).toHaveLength(1);
  });

  test("collisionSay off: the notes and the notice stay, the say goes", async () => {
    const { w, see } = world();
    w.off = true;
    see(chat("c", [edit("1", "x.ts")], "idle"));
    see(run("a", [edit("1", "x.ts")]));
    await Bun.sleep(0);
    expect([w.notes.length, w.notices.length, w.says]).toEqual([2, 1, []]);
  });

  test("a coordinator hears that two of its children collide", async () => {
    const { w, see } = world();
    see(chat("p", [], "idle", { action: "coordinate", verb: "coordinate" }));
    see(run("a", [edit("1", "x.ts")], { parent: "p" }));
    see(run("b", [edit("1", "x.ts")], { parent: "p" }));
    await Bun.sleep(0);
    expect(w.says).toEqual([["p", "canopy: two of your runs (run/x-b and run/x-a) edit the same files: <<< x.ts >>>. Carry on or re-plan; nothing is held."]]);
  });
});

describe("the queue and the checkout", () => {
  test("remembers both branch sides of a live overlap, ignores repeats and never records checkout overlap", () => {
    const { w, hub, see } = world();
    see(run("a", [edit("1", "x.ts")]));
    see(run("b", [edit("1", "x.ts")]));
    expect(w.remembered).toEqual([
      ["b", { with: "run/x-a", paths: ["x.ts"] }],
      ["a", { with: "run/x-b", paths: ["x.ts"] }],
    ]);
    const publishes = w.published;
    see(run("b", [edit("1", "x.ts")]));
    expect([w.remembered.length, w.published]).toEqual([2, publishes]);

    see(run("a", [edit("1", "x.ts"), edit("2", "y.ts")]));
    see(run("b", [edit("1", "x.ts"), edit("2", "y.ts")]));
    expect(w.remembered.slice(-2)).toEqual([
      ["b", { with: "run/x-a", paths: ["x.ts", "y.ts"] }],
      ["a", { with: "run/x-b", paths: ["x.ts", "y.ts"] }],
    ]);
    const grownPublishes = w.published;
    const grownRemembers = w.remembered.length;
    see(run("b", [edit("1", "x.ts"), edit("2", "y.ts")]));
    expect([w.remembered.length, w.published]).toEqual([grownRemembers, grownPublishes]);

    w.repo = { ...w.repo, status: { branch: "main", upstream: null, ahead: 0, behind: 0, files: [file("x.ts")], lastCommit: null, user: null } };
    hub.onRepo(w.repo);
    expect(w.remembered).toHaveLength(grownRemembers);
  });

  test("remembers a live run against a ready branch on both landing records", () => {
    const { w, see } = world();
    const rec: LandingRun = { id: "q", runId: "r-q", repoId: "canopy", repoPath: "/r/canopy", branch: "run/x-q", target: "main", base: "b0", dir: "/w/q", note: "n", verb: "Ask", harness: "claude", state: "ready", startedAt: 1, review: { verdict: "land", files: [{ path: "x.ts", cls: "logic" }], base: "b", head: "h", at: 1 } };
    w.landing = { runs: [rec], entries: enqueue([], rec, 1), orphans: [] };

    see(run("a", [edit("1", "x.ts")]));

    expect(w.remembered).toEqual([
      ["a", { with: "run/x-q", paths: ["x.ts"] }],
      ["q", { with: "run/x-a", paths: ["x.ts"] }],
    ]);
  });

  test("a live overlap follows a run into its ready landing record", () => {
    const { w, hub, see } = world();
    const first = run("a", [edit("a1", "x.ts")]);
    const second = run("b", [edit("b1", "x.ts")]);
    see(first);
    see(second);
    expect(hub.list()[0]?.with.kind).toBe("run");

    const rec: LandingRun = { id: "b", runId: "b", repoId: "canopy", repoPath: "/r/canopy", branch: "run/x-b", target: "main", base: "b0", dir: "/w/b", note: "work b", verb: "Plan, then build", harness: "claude", state: "ready", startedAt: 1, review: { verdict: "land", files: [{ path: "x.ts", cls: "logic" }], base: "b", head: "h", at: 1 } };
    see(run("b", [], { status: "done", endedAt: 2_000 }));
    expect(hub.list()).toEqual([]);
    w.landing = { runs: [rec], entries: enqueue([], rec, 1), orphans: [] };
    hub.onLanding(w.landing);

    expect(hub.list().map((collision) => collision.id)).toEqual(["a+branch:b"]);
    expect(w.notices.at(-1)?.why).toBe("run/x-a and run/x-b both edit x.ts");
  });

  test("a queued branch's sorted files, never a fix-it run's own branch, and the pair goes when the branch lands", () => {
    const { w, hub, see } = world();
    const rec: LandingRun = { id: "q", runId: "r-q", repoId: "canopy", repoPath: "/r/canopy", branch: "run/x-q", target: "main", base: "b0", dir: "/w/q", note: "n", verb: "Ask", harness: "claude", state: "ready", startedAt: 1, review: { verdict: "land", files: [{ path: "x.ts", cls: "logic" }], base: "b", head: "h", at: 1 } };
    w.landing = { runs: [rec], entries: enqueue([], rec, 1), orphans: [] };
    see(run("a", [edit("1", "x.ts")]));
    expect(hub.list()).toEqual([{ id: "a+branch:q", repoId: "canopy", run: "a", name: "run/x-a", with: { kind: "branch", origin: "q", branch: "run/x-q" }, paths: ["x.ts"], at: 61_000 }]);
    expect(w.notes).toEqual([["a", "also in queued branch run/x-q: x.ts"]]);
    expect(w.notices[0]?.why).toBe("run/x-a and run/x-q both edit x.ts");
    see(run("fix1", [edit("1", "x.ts")], { branch: { ...branch("q"), name: "run/x-q" } }));
    expect(hub.list().map((c) => c.id).sort()).toEqual(["a+branch:q", "a+fix1"]);
    see(run("fix1", [], { status: "done", endedAt: 2_000, branch: { ...branch("q"), name: "run/x-q" } }));
    expect(hub.list().map((c) => c.id)).toEqual(["a+branch:q"]);
    const entry = w.landing.entries.find((candidate) => candidate.id === "q");
    if (!entry) throw new Error("expected the branch to have a queue entry");
    w.landing = { ...w.landing, entries: [{ ...entry, state: "landed" }] };
    hub.onLanding(w.landing);
    expect([hub.list(), w.published]).toEqual([[], 4]);
  });

  test("a held judge entry remains a queued branch for collision warnings", () => {
    const { w, hub, see } = world();
    const rec: LandingRun = { id: "q", runId: "r-q", repoId: "canopy", repoPath: "/r/canopy", branch: "run/x-q", target: "main", base: "b0", dir: "/w/q", note: "n", verb: "Ask", harness: "claude", state: "ready", startedAt: 1, review: { verdict: "land", files: [{ path: "x.ts", cls: "logic" }], base: "b", head: "h", at: 1 } };
    w.landing = { runs: [rec], entries: enqueue([], rec, 1), orphans: [] };
    const entry = w.landing.entries[0];
    if (!entry) throw new Error("expected the branch to have a queue entry");
    Object.assign(entry, { state: "judge" });

    see(run("a", [edit("1", "x.ts")]));

    expect(hub.list().map((collision) => collision.id)).toEqual(["a+branch:q"]);
  });

  test("the checkout's uncommitted files overlap branch runs, never the checkout's own run", () => {
    const { w, hub, see } = world();
    w.repo = { ...w.repo, status: { branch: "main", upstream: null, ahead: 0, behind: 0, files: [file("x.ts")], lastCommit: null, user: null } };
    see(run("a", [edit("1", "x.ts")]));
    expect(hub.list()).toEqual([{ id: "a+checkout", repoId: "canopy", run: "a", name: "run/x-a", with: { kind: "checkout" }, paths: ["x.ts"], at: 61_000 }]);
    expect(w.notes).toEqual([["a", "also changed in the main checkout, uncommitted: x.ts"]]);
    expect(w.notices[0]?.why).toBe("your uncommitted changes to x.ts overlap run/x-a; the landing will wait for them");
    see(run("k", [edit("1", "x.ts")], { branch: undefined, verb: "Ask" }));
    expect(hub.list().map((c) => c.id).sort()).toEqual(["a+checkout", "a+k"]);
    const status = w.repo.status;
    if (!status) throw new Error("expected a checkout status");
    w.repo = { ...w.repo, status: { ...status, files: [] } };
    hub.onRepo(w.repo);
    expect(hub.list().map((c) => c.id)).toEqual(["a+k"]);
  });
});
