import { describe, expect, test } from "bun:test";
import { ACTIONS } from "./actions";
import { cliArgs } from "./claudedrive";
import type { DriveCtx, RunDriver } from "./driver";
import { BRANCH_RUNS_PER_REPO, BranchCapError, Runner, type BranchStart } from "./runner";
import { DEFAULT_AGENT, type Harness, type Repo, type Run, type RunBranchState } from "./types";

/* Branch runs: a run in a worktree of its own on a run/ branch, for the
 * landing queue. The worktree itself is the server's to make; the Runner
 * takes it as given. */

class FakeDriver implements RunDriver {
  readonly label = "Claude Code";
  ctx: DriveCtx | null = null;
  started: string[] = [];
  stops = 0;
  constructor(readonly harness: Harness) {}
  check(): string | null {
    return null;
  }
  start(ctx: DriveCtx, message: string): void {
    this.ctx = ctx;
    this.started.push(message);
  }
  say(): void {}
  stop(): void {
    this.stops += 1;
  }
}

const repo = (id: string): Repo => ({ id, name: id, path: `/r/${id}`, group: "", source: "root", status: null });

const branchOf = (id: string, over: Partial<BranchStart> = {}): BranchStart => ({
  branch: { name: `run/x-${id}`, target: "main", base: "b0", dir: `/w/${id}`, state: "working", origin: id },
  ...over,
});

function setup(state: RunBranchState = "ready") {
  const made: FakeDriver[] = [];
  const changes: Run[] = [];
  const read: string[] = [];
  const runner = new Runner(
    {
      onChange: (r) => changes.push(structuredClone(r)),
      onGone: () => {},
      status: async () => null,
      branchState: async (r) => {
        read.push(r.id);
        return state;
      },
    },
    {
      driver: (h) => {
        const d = new FakeDriver(h);
        made.push(d);
        return d;
      },
    },
  );
  return { runner, made, changes, read };
}

const flush = () => new Promise<void>((r) => setTimeout(r, 0));
const done = (ctx: DriveCtx) => ctx.result({ text: "ok", durationMs: 1, turns: 1 }, null);

describe("a branch run", () => {
  test("works in its worktree, and its prompt says how its work lands", () => {
    const { runner, made } = setup();
    const run = runner.start(repo("a"), "propose", ACTIONS.propose, "add a thing", DEFAULT_AGENT, undefined, undefined, branchOf("a"));
    expect(run.branch).toMatchObject({ name: "run/x-a", dir: "/w/a", state: "working" });
    expect(made[0]?.ctx?.cwd).toBe("/w/a");
    const prompt = made[0]?.started[0] ?? "";
    expect(prompt).toContain("at /w/a");
    expect(prompt).not.toContain("/r/a");
    expect(prompt).toContain("Commit your work on this branch with a message that says what changed, and do not push.");
    expect(prompt.trimEnd().endsWith("once the user says so.")).toBe(true);
    expect(run.steps[0]).toMatchObject({ kind: "note", text: "on branch run/x-a in /w/a" });
  });

  test("shares nothing with the checkout: a checkout run and branch runs go side by side, at most three of those", () => {
    const { runner } = setup();
    runner.start(repo("a"), "ask", ACTIONS.ask, "x", DEFAULT_AGENT);
    expect(runner.activeFor("a")).toBeDefined();
    for (let i = 0; i < BRANCH_RUNS_PER_REPO; i++) {
      runner.start(repo("a"), "ask", ACTIONS.ask, "x", DEFAULT_AGENT, undefined, undefined, branchOf(`b${i}`));
    }
    expect(runner.branchRunsFor("a")).toHaveLength(BRANCH_RUNS_PER_REPO);
    expect(() => runner.start(repo("a"), "ask", ACTIONS.ask, "x", DEFAULT_AGENT, undefined, undefined, branchOf("b9"))).toThrow("3 branch runs going");
    // its own kind, so a coordinator's card can wait for a slot instead of failing
    expect(() => runner.start(repo("a"), "ask", ACTIONS.ask, "x", DEFAULT_AGENT, undefined, undefined, branchOf("b8"))).toThrow(BranchCapError);
    // a branch run alone does not make the checkout busy
    const { runner: r2 } = setup();
    r2.start(repo("c"), "ask", ACTIONS.ask, "x", DEFAULT_AGENT, undefined, undefined, branchOf("c1"));
    expect(r2.activeFor("c")).toBeUndefined();
    expect(() => r2.start(repo("c"), "ask", ACTIONS.ask, "y", DEFAULT_AGENT)).not.toThrow();
  });

  test("a workspace run is refused a branch", () => {
    const { runner } = setup();
    const scope = { workspace: "w", primary: "/r/a", others: [], skipped: [] };
    expect(() => runner.start(repo("a"), "ask", ACTIONS.ask, "x", DEFAULT_AGENT, undefined, scope, branchOf("a"))).toThrow("not on a branch");
  });

  test("settles from its worktree: ready is changed, nothing is unchanged", async () => {
    for (const [state, outcome] of [
      ["ready", "changed"],
      ["uncommitted", "changed"],
      ["nothing", "unchanged"],
    ] as const) {
      const { runner, made, read } = setup(state);
      const run = runner.start(repo("a"), "ask", ACTIONS.ask, "x", DEFAULT_AGENT, undefined, undefined, branchOf("a"));
      done(made[0]!.ctx!);
      await flush();
      expect(read).toEqual([run.id]);
      expect(runner.get(run.id)?.branch?.state).toBe(state);
      expect(runner.get(run.id)?.outcome).toBe(outcome);
    }
  });

  test("prepare runs in the worktree before the agent starts, and its notes land on the timeline", async () => {
    const { runner, made } = setup();
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const run = runner.start(repo("a"), "ask", ACTIONS.ask, "x", DEFAULT_AGENT, undefined, undefined, branchOf("a", {
      prepare: async (say) => {
        say("$ bun install --frozen-lockfile");
        await gate;
      },
    }));
    expect(made[0]?.started).toEqual([]);
    expect(runner.get(run.id)?.status).toBe("working");
    release();
    await flush();
    expect(made[0]?.started).toHaveLength(1);
    expect(runner.get(run.id)?.steps.some((s) => s.text === "$ bun install --frozen-lockfile")).toBe(true);
  });

  test("a prepare that throws fails the run before the agent starts", async () => {
    const { runner, made } = setup("nothing");
    const run = runner.start(repo("a"), "ask", ACTIONS.ask, "x", DEFAULT_AGENT, undefined, undefined, branchOf("a", {
      prepare: async () => {
        throw new Error("bun install exited 1");
      },
    }));
    await flush();
    await flush();
    expect(runner.get(run.id)?.status).toBe("failed");
    expect(runner.get(run.id)?.error).toBe("setup failed: bun install exited 1");
    expect(made[0]?.started).toEqual([]);
  });

  test("a stop while it sets up ends it there, and the agent never starts", async () => {
    const { runner, made } = setup("nothing");
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const run = runner.start(repo("a"), "ask", ACTIONS.ask, "x", DEFAULT_AGENT, undefined, undefined, branchOf("a", { prepare: () => gate }));
    runner.stop(run.id);
    expect(runner.get(run.id)?.status).toBe("stopped");
    release();
    await flush();
    expect(made[0]?.started).toEqual([]);
    expect(made[0]?.stops).toBe(0);
  });

  test("a spec's resume and message start a plain run on that session with that message", () => {
    const { runner, made } = setup();
    runner.start(repo("a"), "ask", { ...ACTIONS.ask, resume: "sess-2", message: "canopy restarted" }, "", DEFAULT_AGENT);
    expect(made[0]?.started).toEqual(["canopy restarted"]);
    expect(made[0]?.ctx?.spec.resume).toBe("sess-2");
  });

  test("a chat started with extras.resume hands the session to the driver", () => {
    const { runner, made } = setup();
    const run = runner.start(repo("a"), "chat", ACTIONS.chat, "", DEFAULT_AGENT, undefined, undefined, undefined, { resume: "s1" });
    runner.say(run.id, "carry on");
    expect(made[0]?.ctx?.spec.resume).toBe("s1");
  });

  test("a branch's resume wins over extras.resume", () => {
    const { runner, made } = setup();
    runner.start(repo("a"), "ask", ACTIONS.ask, "", DEFAULT_AGENT, undefined, undefined, branchOf("a", { resume: "b1", message: "go" }), { resume: "s1" });
    expect(made[0]?.ctx?.spec.resume).toBe("b1");
  });

  test("a fix-it run resumes the session with its own first message", () => {
    const { runner, made } = setup();
    runner.start(repo("a"), "ask", ACTIONS.ask, "", DEFAULT_AGENT, undefined, undefined, branchOf("a", { resume: "sess-1", message: "the queue sent it back" }));
    expect(made[0]?.started).toEqual(["the queue sent it back"]);
    expect(made[0]?.ctx?.spec.resume).toBe("sess-1");
    expect(cliArgs({ ...ACTIONS.ask, resume: "sess-1" })).toEqual(expect.arrayContaining(["--resume", "sess-1"]));
    expect(cliArgs(ACTIONS.ask)).not.toContain("--resume");
  });
});
