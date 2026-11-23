import { describe, expect, test } from "bun:test";
import { ACTIONS, checkoutFull, type ActionSpec } from "./actions";
import type { DriveCtx, RunDriver } from "./driver";
import { CHECKOUT_RUNS_PER_REPO, Runner, SteerError, UnknownRunError, type BranchStart, type RunnerOptions } from "./runner";
import { sideMessage, sideNote } from "./sidequestion";
import { DEFAULT_AGENT, type Harness, type Repo, type Run } from "./types";

/* A side question beside a live run (FR-077): the chat it starts, what the
 * parent hears of it (nothing), the starts that are refused, and the model
 * a side question changes between its turns. */

/** A driver that runs nothing: the test plays the harness through `ctx`.
 *  `takes` is what its `model` answers: null for yes, else why not. */
class FakeDriver implements RunDriver {
  readonly label = "Claude Code";
  ctx: DriveCtx | null = null;
  started: string[] = [];
  said: string[] = [];
  models: string[] = [];
  takes: string | null = null;
  constructor(readonly harness: Harness) {}
  check(): string | null {
    return null;
  }
  start(ctx: DriveCtx, message: string): void {
    this.ctx = ctx;
    this.started.push(message);
  }
  say(text: string): void {
    this.said.push(text);
  }
  model(model: string): Promise<string | null> {
    this.models.push(model);
    return Promise.resolve(this.takes);
  }
  stop(): void {}
}

/** A harness that keeps one model for a conversation: no `model` at all. */
class FixedDriver implements RunDriver {
  readonly label = "Fixed";
  ctx: DriveCtx | null = null;
  constructor(readonly harness: Harness) {}
  check(): string | null {
    return null;
  }
  start(ctx: DriveCtx): void {
    this.ctx = ctx;
  }
  say(): void {}
  stop(): void {}
}

const repo = (id: string, path = `/tmp/${id}`): Repo => ({ id, name: id, path, group: "", source: "root", status: null });
const OK = { text: "ok", durationMs: 1, turns: 1 };
const SESSION = "aaaaaaaa-0000-4000-8000-000000000001";

function setup(opts: RunnerOptions = {}) {
  const made: FakeDriver[] = [];
  const changes: Run[] = [];
  const runner = new Runner(
    { onChange: (r) => changes.push(structuredClone(r)), onGone: () => {} },
    {
      driver: (h) => {
        const d = new FakeDriver(h);
        made.push(d);
        return d;
      },
      ...opts,
    },
  );
  const driver = (i: number): FakeDriver => {
    const d = made[i];
    if (!d) throw new Error(`no driver ${i}`);
    return d;
  };
  const ctx = (i: number): DriveCtx => {
    const c = driver(i).ctx;
    if (!c) throw new Error(`driver ${i} was never started`);
    return c;
  };
  /** a job at work in the checkout that has its session, as a harness gives it at once */
  const job = (id: string, note = "migrate the billing checkout", spec: ActionSpec = ACTIONS.ask, extras: Parameters<Runner["start"]>[8] = {}): Run => {
    const run = runner.start(repo(id), "ask", spec, note, DEFAULT_AGENT, undefined, undefined, undefined, extras);
    ctx(made.length - 1).session(SESSION);
    return run;
  };
  return { runner, made, changes, driver, ctx, job };
}

describe("a side question", () => {
  test("starts a chat on the parent's repo, forked from its session, and the parent hears nothing", () => {
    const { runner, driver, ctx, job, changes } = setup();
    const parent = job("r");
    const before = structuredClone(parent);
    const heard = changes.filter((r) => r.id === parent.id).length;
    const side = runner.side(parent.id, "  what is the retry backoff default?  ", DEFAULT_AGENT, "the laptop");

    expect(side).toMatchObject({
      repoId: "r",
      action: "chat",
      chat: true,
      status: "working",
      harness: "claude",
      by: "the laptop",
      sideOf: { run: parent.id, title: "migrate the billing checkout" },
      name: "what is the retry backoff default",
      nameBy: "words",
    });
    expect(side.id).not.toBe(parent.id);
    // its own timeline: where it started, then the question as it was typed
    expect(side.steps.map((s) => [s.kind, s.text])).toEqual([
      ["note", sideNote("migrate the billing checkout")],
      ["user", "what is the retry backoff default?"],
    ]);
    // the forked session is told what a side question is, with the question last
    expect(driver(1).started).toEqual([sideMessage("what is the retry backoff default?")]);
    expect(ctx(1).spec).toMatchObject({ resume: SESSION, fork: true, allowedTools: ACTIONS.chat.allowedTools });
    expect(ctx(1).cwd).toBe("/tmp/r");

    // the parent: no step, no message, no change broadcast, and still at work
    expect(parent).toEqual(before);
    expect(driver(0).said).toEqual([]);
    expect(driver(0).started).toHaveLength(1);
    expect(changes.filter((r) => r.id === parent.id)).toHaveLength(heard);
    expect(runner.activeRunsFor("r").map((r) => r.id)).toEqual([parent.id, side.id]);
  });

  test("is asked of a run mid-turn, waiting on a prompt, or a chat between turns", async () => {
    const { runner, ctx, job } = setup();
    const working = job("a");
    expect(working.status).toBe("working");
    expect(runner.side(working.id, "one").sideOf?.run).toBe(working.id);

    const waiting = job("b");
    void ctx(2).ask({ kind: "question", questions: [{ question: "which?", header: "which", options: [{ label: "x", description: "" }], multiSelect: false }] }, "q-1");
    expect(waiting.status).toBe("waiting");
    expect(runner.side(waiting.id, "two").sideOf?.run).toBe(waiting.id);

    const chat = runner.start(repo("c"), "chat", ACTIONS.chat, "hello", DEFAULT_AGENT);
    ctx(4).session(SESSION);
    ctx(4).result(OK, null);
    expect(chat.status).toBe("idle");
    expect(runner.side(chat.id, "three").sideOf?.run).toBe(chat.id);
  });

  test("runs on the parent's harness, whose session it forks, with the model it was given", () => {
    const { runner, ctx, job } = setup();
    const parent = runner.start(repo("r"), "ask", ACTIONS.ask, "look", { ...DEFAULT_AGENT, harness: "codex" });
    ctx(0).session("thread-1");
    const side = runner.side(parent.id, "what is the port", { ...DEFAULT_AGENT, harness: "claude", model: "gpt-6-luna" });
    expect(side.harness).toBe("codex");
    expect(side.agentSettings).toMatchObject({ harness: "codex", model: "gpt-6-luna" });
    expect(ctx(1).spec).toMatchObject({ resume: "thread-1", fork: true });

    const claude = job("s");
    expect(runner.side(claude.id, "and here", { ...DEFAULT_AGENT, model: "haiku" }).agentSettings).toMatchObject({ harness: "claude", model: "haiku" });
  });

  test("of a branch run starts in the run's worktree, where its session is filed", () => {
    const { runner, ctx } = setup();
    const branch: BranchStart = { branch: { name: "run/b1", target: "main", base: "base", dir: "/scratch/b1", state: "working", origin: "b1", work: "w-test2345" } };
    const parent = runner.start(repo("r"), "ask", ACTIONS.ask, "on a branch", DEFAULT_AGENT, undefined, undefined, branch);
    ctx(0).session(SESSION);
    const side = runner.side(parent.id, "which files did you touch");
    expect(ctx(1).cwd).toBe("/scratch/b1");
    expect(side.branch).toBeUndefined();
    expect(side.sideOf?.run).toBe(parent.id);
    expect(side.steps[0]).toMatchObject({ kind: "note", text: sideNote("on a branch") });
    // the worktree is the side question's folder until it ends, so a land keeps it
    expect(runner.sidesIn("/scratch/b1")).toBe(1);
    expect(runner.sidesIn("/tmp/r")).toBe(0);
    ctx(1).result(OK, null);
    expect(runner.sidesIn("/scratch/b1")).toBe(1);
    runner.stop(side.id);
    expect(runner.sidesIn("/scratch/b1")).toBe(0);
  });

  test("keeps the folders the parent's session reads beside its own", () => {
    const { runner, ctx, job } = setup();
    const parent = job("r", "with files", ACTIONS.ask, { addDirs: ["/goal/files"] });
    runner.side(parent.id, "what is in the files");
    expect(ctx(1).spec.addDirs).toEqual(["/goal/files"]);
  });

  test("stays open when its parent ends, and ends by itself", () => {
    const { runner, ctx, job } = setup();
    const parent = job("r");
    const side = runner.side(parent.id, "what is the port");
    ctx(0).result(OK, null);
    expect(parent.status).toBe("done");
    expect(side.status).toBe("working");
    ctx(1).result(OK, null);
    expect(side.status).toBe("idle");
    // a later message in the side thread is a plain turn of its own
    runner.say(side.id, "and the host?");
    expect(side.steps.at(-1)).toMatchObject({ kind: "user", text: "and the host?" });
    runner.stop(side.id);
    expect(runner.get(parent.id)?.steps.some((s) => s.kind === "user")).toBe(false);
  });
});

describe("a side question refused", () => {
  test("the parent is gone", () => {
    const { runner } = setup();
    expect(() => runner.side("nope1234", "what is the port")).toThrow(UnknownRunError);
  });

  test("the parent has ended", () => {
    const { runner, ctx, job } = setup();
    const parent = job("r");
    ctx(0).result(OK, null);
    expect(() => runner.side(parent.id, "what is the port")).toThrow(SteerError);
    expect(() => runner.side(parent.id, "what is the port")).toThrow("the run has ended");
  });

  test("the parent has no session yet", () => {
    const { runner } = setup();
    const opened = runner.start(repo("r"), "chat", ACTIONS.chat, "", DEFAULT_AGENT);
    expect(() => runner.side(opened.id, "what is the port")).toThrow(new SteerError("the run has no session to fork yet: ask once it has begun"));
    const begun = runner.start(repo("s"), "ask", ACTIONS.ask, "look", DEFAULT_AGENT);
    expect(() => runner.side(begun.id, "what is the port")).toThrow("no session to fork yet");
  });

  test("the checkout is full", () => {
    const { runner, job } = setup();
    const parent = job("r");
    for (let i = 1; i < CHECKOUT_RUNS_PER_REPO; i += 1) job("r", `task ${i}`);
    expect(() => runner.side(parent.id, "what is the port")).toThrow(new SteerError(checkoutFull("r", CHECKOUT_RUNS_PER_REPO)));
    expect(runner.activeRunsFor("r")).toHaveLength(CHECKOUT_RUNS_PER_REPO);
  });

  test("nothing was asked, the parent is a side question itself, or the repo is an incubator seed", () => {
    const { runner, ctx, job } = setup({ stage: (r) => r.id === "seed" });
    const parent = job("r");
    expect(() => runner.side(parent.id, "   ")).toThrow(new SteerError("write the question first"));
    const side = runner.side(parent.id, "what is the port");
    ctx(1).session("bbbbbbbb-0000-4000-8000-000000000002");
    expect(() => runner.side(side.id, "and the host")).toThrow("a side question already");
    const staged = job("seed", "step one");
    expect(() => runner.side(staged.id, "what is the port")).toThrow(new SteerError("an incubator stage takes no side question"));
  });
});

describe("a side question's model", () => {
  const between = () => {
    const s = setup();
    const parent = s.job("r");
    const side = s.runner.side(parent.id, "what is the port", { ...DEFAULT_AGENT, model: "haiku" });
    s.ctx(1).session("bbbbbbbb-0000-4000-8000-000000000002");
    s.ctx(1).result(OK, null);
    return { ...s, parent, side };
  };

  test("changes between its turns: the harness is asked, the run says so, and its timeline notes it", async () => {
    const { runner, driver, side, changes } = between();
    expect(side.status).toBe("idle");
    const after = await runner.remodel(side.id, "sonnet");
    expect(driver(1).models).toEqual(["sonnet"]);
    expect(after.agentSettings).toMatchObject({ harness: "claude", model: "sonnet" });
    expect(after.steps.at(-1)).toMatchObject({ kind: "note", text: "model: sonnet, from the next message on" });
    expect(changes.at(-1)).toMatchObject({ id: side.id, agentSettings: { model: "sonnet" } });
  });

  test("asked for the model it has changes nothing", async () => {
    const { runner, driver, side } = between();
    const steps = side.steps.length;
    await runner.remodel(side.id, "haiku");
    expect(driver(1).models).toEqual([]);
    expect(side.steps).toHaveLength(steps);
  });

  test("is refused mid-reply, on a run that is no side question, on an ended one, and for a name the harness does not take", async () => {
    const { runner, ctx, parent, side } = between();
    await expect(runner.remodel(parent.id, "sonnet")).rejects.toThrow(new SteerError("only a side question changes its model once it has started"));
    await expect(runner.remodel(side.id, "gpt-6-luna")).rejects.toThrow(new SteerError("claude takes no model named gpt-6-luna"));
    await expect(runner.remodel("nope1234", "sonnet")).rejects.toThrow(UnknownRunError);
    runner.say(side.id, "and the host?");
    await expect(runner.remodel(side.id, "sonnet")).rejects.toThrow(new SteerError("it is mid-reply: pick the model once it has answered"));
    ctx(1).result(OK, null);
    runner.stop(side.id);
    ctx(1).exited({ code: 0, stderr: "" });
    await expect(runner.remodel(side.id, "sonnet")).rejects.toThrow(new SteerError("the run has ended"));
  });

  test("stays as it was when the harness says no, or has no way to change it", async () => {
    const { runner, driver, side } = between();
    driver(1).takes = "no answer";
    await expect(runner.remodel(side.id, "opus")).rejects.toThrow(new SteerError("the model stays as it was: no answer"));
    expect(side.agentSettings?.model).toBe("haiku");

    const fixed: FixedDriver[] = [];
    const other = new Runner({ onChange: () => {}, onGone: () => {} }, { driver: (h) => {
      const d = new FixedDriver(h);
      fixed.push(d);
      return d;
    } });
    const parent = other.start(repo("r"), "ask", ACTIONS.ask, "look", DEFAULT_AGENT);
    fixed[0]?.ctx?.session(SESSION);
    const side2 = other.side(parent.id, "what is the port");
    fixed[1]?.ctx?.result(OK, null);
    await expect(other.remodel(side2.id, "opus")).rejects.toThrow(new SteerError("the model stays as it was: Fixed changes no model mid-conversation"));
  });
});
