import { describe, expect, test } from "bun:test";
import { ACTIONS, busyWith, checkoutFull, SHARED_CHECKOUT, type ActionSpec } from "./actions";
import type { DriveCtx, RunDriver } from "./driver";
import { CHECKOUT_RUNS_PER_REPO, Runner, SteerError, UnknownRunError, type RunnerOptions } from "./runner";
import { DEFAULT_AGENT, type Harness, type Repo, type Run } from "./types";

/* Several runs in one checkout (FR-073): how many, which starts are still
 * refused, the name each run goes by, and what a run is told when it starts
 * beside others. */

/** A driver that runs nothing: the test plays the harness through `ctx`. */
class FakeDriver implements RunDriver {
  readonly label = "Claude Code";
  ctx: DriveCtx | null = null;
  started: string[] = [];
  said: string[] = [];
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
  stop(): void {}
}

const repo = (id: string, path = `/tmp/${id}`): Repo => ({ id, name: id, path, group: "", source: "root", status: null });
const OK = { text: "ok", durationMs: 1, turns: 1 };
const flush = () => new Promise<void>((r) => setTimeout(r, 0));

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
  /** ends the run the `i`th driver was made for */
  const end = (i: number): void => {
    const d = made[i];
    if (!d) throw new Error(`no driver ${i}`);
    if (!d.ctx) throw new Error(`driver ${i} was never started`);
    d.ctx.result(OK, null);
  };
  const ask = (id: string, note: string, extras: Parameters<Runner["start"]>[8] = {}, spec: ActionSpec = ACTIONS.ask): Run =>
    runner.start(repo(id), "ask", spec, note, DEFAULT_AGENT, undefined, undefined, undefined, extras);
  const chat = (id: string, note = "", extras: Parameters<Runner["start"]>[8] = {}): Run =>
    runner.start(repo(id), "chat", ACTIONS.chat, note, DEFAULT_AGENT, undefined, undefined, undefined, extras);
  return { runner, made, changes, end, ask, chat };
}

describe("runs sharing a checkout", () => {
  test("a job and two chats start on one repo, and each is listed", () => {
    const { runner, ask, chat } = setup();
    const a = chat("r");
    const b = ask("r", "look at the build");
    const c = chat("r", "and the tests");
    expect(runner.activeRunsFor("r").map((run) => run.id)).toEqual([a.id, b.id, c.id]);
    // the checkout's holder, for what still waits on a free one
    expect(runner.activeFor("r")?.id).toBe(a.id);
    expect(runner.activeRunsFor("other")).toEqual([]);
  });

  test("a chat between turns is not at work; a job and a chat mid-turn are", () => {
    const { runner, ask, chat, end } = setup();
    chat("r");
    expect(runner.busyFor("r")).toBeUndefined();
    const job = ask("r", "look");
    expect(runner.busyFor("r")?.id).toBe(job.id);
    end(1);
    expect(runner.busyFor("r")).toBeUndefined();
    const talking = chat("r", "hello");
    expect(runner.busyFor("r")?.id).toBe(talking.id);
  });

  test("the checkout is full at the cap, and a run's end makes room", () => {
    const { runner, ask, end } = setup();
    for (let i = 0; i < CHECKOUT_RUNS_PER_REPO; i += 1) ask("r", `task ${i}`);
    expect(runner.checkoutRefusal(repo("r"))).toBe(checkoutFull("r", CHECKOUT_RUNS_PER_REPO));
    expect(() => ask("r", "one more")).toThrow(checkoutFull("r", CHECKOUT_RUNS_PER_REPO));
    // another repo has its own count
    expect(() => ask("s", "elsewhere")).not.toThrow();
    end(0);
    expect(runner.checkoutRefusal(repo("r"))).toBeNull();
    expect(() => ask("r", "one more")).not.toThrow();
  });

  test("an incubator seed keeps one run at a time", () => {
    const { runner, ask } = setup({ stage: (r) => r.id === "seed" });
    const first = ask("seed", "step one");
    expect(runner.checkoutRefusal(repo("seed"))).toBe(busyWith("seed", first.verb));
    expect(() => ask("seed", "step two")).toThrow(busyWith("seed", first.verb));
  });

  test("a workflow's step at work keeps other starts out, and its own steps in", () => {
    const { runner, ask, chat } = setup();
    const flow = Symbol("flow");
    const step: ActionSpec = { ...ACTIONS.ask, verb: "ship · build", flowStep: { workflow: "ship", step: "build", source: "bundled" } };
    const one = ask("r", "build it", { flowOwner: flow }, step);
    expect(runner.checkoutRefusal(repo("r"))).toBe(busyWith("r", one.verb));
    expect(() => chat("r")).toThrow(busyWith("r", one.verb));
    expect(() => ask("r", "test it", { flowOwner: flow }, step)).not.toThrow();
    // another workflow's step is refused nothing here: its flow weighed the
    // checkout when it started, which `Flows.start` does
    expect(runner.checkoutRefusal(repo("r"), Symbol("other"))).toBeNull();
  });

  test("a workflow's step starts beside a chat that was there before it", () => {
    const { runner, ask, chat } = setup();
    chat("r");
    const flow = Symbol("flow");
    expect(() => ask("r", "build it", { flowOwner: flow }, { ...ACTIONS.ask, flowStep: { workflow: "ship", step: "build", source: "bundled" } })).not.toThrow();
    expect(runner.activeRunsFor("r")).toHaveLength(2);
  });
});

describe("what a run is told about the others", () => {
  test("only a run that starts beside others gets the rule and the note", () => {
    const { made, ask } = setup();
    const first = ask("r", "tidy the imports");
    const second = ask("r", "fix the flaky test");
    expect(made[0]?.started[0]).not.toContain(SHARED_CHECKOUT);
    expect(made[1]?.started[0]).toContain(SHARED_CHECKOUT);
    expect(first.steps.filter((s) => s.kind === "note")).toEqual([]);
    expect(second.steps[0]).toMatchObject({ kind: "note", text: "sharing the checkout with another run: tidy the imports" });
  });

  test("a chat opened with nothing to say is told when it first speaks", () => {
    const { runner, made, ask, chat } = setup();
    const idle = chat("r");
    expect(idle.steps).toEqual([]);
    ask("r", "fix the flaky test");
    const said = runner.say(idle.id, "what changed today");
    expect(made[0]?.started[0]).toContain(SHARED_CHECKOUT);
    expect(made[0]?.started[0]).toContain("First message from the user:\nwhat changed today");
    // its timeline says so too, ahead of the message, and once
    expect(said.steps.map((s) => [s.kind, s.text])).toEqual([
      ["note", "sharing the checkout with another run: fix the flaky test"],
      ["user", "what changed today"],
    ]);
    made[0]?.ctx?.result(OK, null);
    expect(runner.say(idle.id, "and yesterday").steps.filter((s) => s.kind === "note")).toHaveLength(1);
  });

  test("a chat on a repo by itself is told nothing of it", () => {
    const { runner, made, chat } = setup();
    const only = chat("r");
    const said = runner.say(only.id, "hello");
    expect(made[0]?.started[0]).not.toContain(SHARED_CHECKOUT);
    expect(said.steps.filter((s) => s.kind === "note")).toEqual([]);
  });

  test("the note counts the runs it shares with", () => {
    const { ask, chat } = setup();
    ask("r", "tidy the imports");
    chat("r", "peer sync");
    const third = ask("r", "third");
    expect(third.steps[0]?.text).toBe("sharing the checkout with 2 other runs: tidy the imports, peer sync");
  });
});

describe("a run's name", () => {
  test("is cut from its first message, and numbered when another run holds it", () => {
    const { ask, chat } = setup();
    const a = ask("r", "Please fix the top bar on a phone");
    const b = chat("r", "fix the top bar on a phone");
    const elsewhere = ask("s", "fix the top bar on a phone");
    expect(a).toMatchObject({ name: "fix the top bar on a phone", nameBy: "words" });
    expect(b.name).toBe("fix the top bar on a phone 2");
    expect(elsewhere.name).toBe("fix the top bar on a phone");
  });

  test("a chat opened with nothing to say is named by its first message", () => {
    const { runner, chat } = setup();
    const run = chat("r");
    expect(run.name).toBeUndefined();
    runner.say(run.id, "why is the build slow?");
    expect(run).toMatchObject({ name: "why is the build slow", nameBy: "words" });
    // later messages leave the name alone
    run.status = "idle";
    runner.say(run.id, "and the tests");
    expect(run.name).toBe("why is the build slow");
  });

  test("a name the caller gives is kept as typed and never asked about", () => {
    let asked = 0;
    const { ask } = setup({ namer: async () => ((asked += 1), "a model's name") });
    const run = ask("r", "do the thing", { name: '  "Card 4: landing retries."  ' });
    expect(run).toMatchObject({ name: "Card 4: landing retries", nameBy: "hand" });
    expect(asked).toBe(0);
  });

  test("the model's name replaces the words' once it answers, and the page hears it", async () => {
    const texts: string[] = [];
    const { ask, changes } = setup({ namer: async (text) => (texts.push(text), "phone top bar overflow") });
    const run = ask("r", "Please fix the top bar on a phone, it wraps");
    expect(run.nameBy).toBe("words");
    await flush();
    expect(run).toMatchObject({ name: "phone top bar overflow", nameBy: "model" });
    expect(texts).toEqual(["Please fix the top bar on a phone, it wraps"]);
    expect(changes.at(-1)).toMatchObject({ id: run.id, name: "phone top bar overflow" });
  });

  test("the model's name is numbered too when another run took it first", async () => {
    const { ask } = setup({ namer: async () => "same name" });
    const a = ask("r", "first task");
    const b = ask("r", "second task");
    await flush();
    expect([a.name, b.name].sort()).toEqual(["same name", "same name 2"]);
  });

  test("a rename, the run's end or no answer keeps what the run has", async () => {
    let answer: (name: string | null) => void = () => {};
    const { runner, ask, end, changes } = setup({ namer: () => new Promise((r) => (answer = r)) });
    const renamed = ask("r", "first task");
    const mine = answer;
    runner.rename(renamed.id, "mine");
    mine("the model's");
    await flush();
    expect(renamed).toMatchObject({ name: "mine", nameBy: "hand" });

    const ended = ask("r", "second task");
    const late = answer;
    end(1);
    const heard = changes.length;
    late("too late");
    await flush();
    expect(ended).toMatchObject({ name: "second task", nameBy: "words" });
    expect(changes.length).toBe(heard);

    const silent = ask("r", "third task");
    answer(null);
    await flush();
    expect(silent).toMatchObject({ name: "third task", nameBy: "words" });
  });

  test("a namer that throws leaves the words' name", async () => {
    const { ask } = setup({ namer: async () => { throw new Error("no claude"); } });
    const run = ask("r", "first task");
    await flush();
    expect(run).toMatchObject({ name: "first task", nameBy: "words" });
  });

  test("the model is asked only for runs a person started, and not while low work is held", async () => {
    const asked: string[] = [];
    const namer = async (text: string) => (asked.push(text), null);
    const { ask } = setup({ namer });
    ask("r", "one of a group", { group: "g1" });
    ask("r", "a card's child", { parent: "co123456" });
    ask("r", "low work", { priority: "low" });
    ask("r", "no one watches", {}, { ...ACTIONS.ask, unattended: "No one answers this run." });
    ask("r", "mine");
    expect(asked).toEqual(["mine"]);

    const held = setup({ namer, may: (_h, priority) => (priority === "low" ? { hold: "window", until: null, why: "the window is nearly spent" } : "go") });
    const run = held.ask("r", "while held");
    await flush();
    expect(asked).toEqual(["mine"]);
    expect(run.nameBy).toBe("words");
  });

  test("a flow's step, an incubator stage and a run with nothing said have none", () => {
    const { ask, chat } = setup({ stage: (r) => r.id === "seed" });
    expect(ask("r", "build it", { flowOwner: Symbol("f") }, { ...ACTIONS.ask, flowStep: { workflow: "ship", step: "build", source: "bundled" } }).name).toBeUndefined();
    expect(ask("seed", "a stage's step").name).toBeUndefined();
    expect(chat("s").name).toBeUndefined();
  });

  test("renaming cleans the name and refuses nothing, an ended run and an unknown one", () => {
    const { runner, ask, end, changes } = setup();
    const run = ask("r", "first task");
    const before = changes.length;
    expect(runner.rename(run.id, "  the  landing   queue. ")).toMatchObject({ name: "the landing queue", nameBy: "hand" });
    expect(changes.length).toBe(before + 1);
    expect(() => runner.rename(run.id, "  ")).toThrow(new SteerError("write a name first"));
    expect(() => runner.rename("nope", "x")).toThrow(UnknownRunError);
    end(0);
    expect(() => runner.rename(run.id, "later")).toThrow(new SteerError("the run has ended"));
    expect(run.name).toBe("the landing queue");
  });
});
