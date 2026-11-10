import { describe, expect, test } from "bun:test";
import { goingOf } from "./going";
import type { CoordTask, Fleet, Flow, LandEntry, Run } from "./types";

const run = (over: Partial<Run>): Run => ({ id: "r1", repoId: "apps/web", action: "ask", verb: "asking", status: "working", progress: "reading .env for the key", ...over }) as Run;
const card = (state: CoordTask["state"]): CoordTask => ({ id: "t1", title: "a card", repo: "apps/web", note: "do it", action: "ask", state });
const flow = (over: Partial<Flow>): Flow => ({ id: "f1", repoId: "apps/web", workflow: "ship", verb: "shipping", note: "the secret plan", status: "working", steps: [{ name: "build" }, { name: "deploy" }], current: 1, startedAt: 0, ...over }) as Flow;
const fleet = (over: Partial<Fleet>): Fleet => ({ id: "g1", workflow: "ship", verb: "shipping", note: "all of them", repos: [], status: "working", startedAt: 0, ...over });
const entry = (over: Partial<LandEntry>): LandEntry => ({ id: "l1", repoId: "apps/web", repoPath: "/dev/apps/web", branch: "canopy/fix-the-login", target: "main", dir: "/tmp/x", note: "fix the login", state: "gate", tries: 0, queuedAt: 0, updatedAt: 0, ...over });

describe("what a restart would cut off", () => {
  test("a run working or waiting counts, an idle chat and an ended run do not", () => {
    const got = goingOf([run({ id: "a" }), run({ id: "b", status: "waiting" }), run({ id: "c", status: "idle", action: "chat" }), run({ id: "d", status: "done" }), run({ id: "e", status: "failed" })], [], [], []);
    expect(got).toEqual([
      { kind: "run", id: "a", repo: "apps/web", doing: "asking, working" },
      { kind: "run", id: "b", repo: "apps/web", doing: "asking, waiting on a prompt" },
    ]);
  });

  test("a coordinator between turns counts while a card is queued or running", () => {
    const coord = (tasks: CoordTask[]): Run => run({ id: "c", action: "coordinate", verb: "coordinating", status: "idle", tasks });
    expect(goingOf([coord([card("queued"), card("running"), card("done")])], [], [], [])).toEqual([
      { kind: "run", id: "c", repo: "apps/web", doing: "coordinating, idle with 2 cards queued or running" },
    ]);
    expect(goingOf([coord([card("queued")])], [], [], [])[0]?.doing).toBe("coordinating, idle with 1 card queued or running");
    expect(goingOf([coord([card("proposed"), card("done"), card("dropped")])], [], [], [])).toEqual([]);
    expect(goingOf([coord([])], [], [], [])).toEqual([]);
  });

  test("a flow working or waiting counts, by its step's place and not its name", () => {
    const got = goingOf([], [flow({}), flow({ id: "f2", status: "waiting", current: 0 }), flow({ id: "f3", status: "gated" }), flow({ id: "f4", status: "done" })], [], []);
    expect(got).toEqual([
      { kind: "flow", id: "f1", repo: "apps/web", doing: "shipping, at step 2 of 2" },
      { kind: "flow", id: "f2", repo: "apps/web", doing: "shipping, at step 1 of 2, waiting on a prompt" },
    ]);
  });

  test("a working fleet names its first three repos and counts the rest", () => {
    const repos = ["a", "b", "c", "d", "e"].map((repoId) => ({ repoId }));
    expect(goingOf([], [], [fleet({ repos }), fleet({ id: "g2", repos: repos.slice(0, 2) }), fleet({ id: "g3", status: "done", repos })], [])).toEqual([
      { kind: "fleet", id: "g1", repo: "a, b, c and 2 more", doing: "shipping" },
      { kind: "fleet", id: "g2", repo: "a, b", doing: "shipping" },
    ]);
  });

  test("a landing entry counts while it rebases, sets up, runs its gate or lands", () => {
    const states: LandEntry["state"][] = ["queued", "rebasing", "setup", "gate", "landing", "landed", "waiting", "conflict", "red", "moved"];
    const got = goingOf([], [], [], states.map((state, i) => entry({ id: `l${i}`, state, ...(state === "gate" ? { gate: "typecheck" } : {}) })));
    expect(got.map((g) => `${g.id} ${g.doing}`)).toEqual(["l1 rebasing", "l2 setup", "l3 gate (typecheck)", "l4 landing"]);
  });

  test("no line carries an agent's words: no progress, note, branch or step name", () => {
    const text = JSON.stringify(goingOf([run({}), run({ id: "w", status: "waiting" })], [flow({})], [fleet({ repos: [{ repoId: "a" }] })], [entry({})]));
    for (const leak of ["reading .env", "secret plan", "all of them", "fix-the-login", "fix the login", "deploy", "/dev/apps/web", "/tmp/x"]) expect(text).not.toContain(leak);
  });
});
