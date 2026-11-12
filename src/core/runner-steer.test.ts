import { describe, expect, test } from "bun:test";
import { ACTIONS } from "./actions";
import { Runner, SteerError, UnknownRunError } from "./runner";
import type { DriveCtx, RunDriver } from "./driver";
import { DEFAULT_AGENT, type Harness, type Repo } from "./types";

/** A person steering a run through the Runner (FR-066): who may send what,
 *  when, and what the timeline shows for it. */

const repo: Repo = { id: "app", name: "app", path: "/scratch/app", status: null, group: "", source: "root" };

/** a driver that records what reaches its wire and answers as told */
class SteerDriver implements RunDriver {
  readonly label = "Steer fixture";
  ctx: DriveCtx | null = null;
  steered: string[] = [];
  said: string[] = [];
  interrupts = 0;
  takes = true;
  stops = true;
  constructor(readonly harness: Harness = "claude") {}
  check() { return null; }
  start(ctx: DriveCtx) { this.ctx = ctx; ctx.session("session-1"); }
  say(text: string) { this.said.push(text); }
  steer(text: string) { if (this.takes) this.steered.push(text); return this.takes; }
  interrupt() { if (this.stops) this.interrupts++; return this.stops; }
  stop() { this.ctx?.exited({ code: 0, stderr: "" }); }
}

/** the same, with no mid-turn wire at all */
class PlainDriver implements RunDriver {
  readonly label = "Plain fixture";
  readonly harness = "claude";
  check() { return null; }
  start(ctx: DriveCtx) { ctx.session("s"); }
  say() {}
  stop() {}
}

const job = (driver: RunDriver, opts: { stage?: boolean } = {}) => {
  const runner = new Runner({ onChange: () => {}, onGone: () => {} }, { driver: () => driver, ...(opts.stage ? { stage: () => true } : {}) });
  const run = runner.start(repo, "ask", ACTIONS.ask, "build it", DEFAULT_AGENT);
  return { runner, run };
};

const chat = (driver: SteerDriver) => {
  const runner = new Runner({ onChange: () => {}, onGone: () => {} }, { driver: () => driver });
  const run = runner.start(repo, "chat", ACTIONS.chat, "", DEFAULT_AGENT);
  runner.say(run.id, "hello");
  return { runner, run };
};

const refusal = (act: () => unknown): string => {
  try { act(); } catch (err) { if (err instanceof SteerError) return err.message; throw err; }
  throw new Error("expected a refusal");
};

describe("say with steer", () => {
  test("a person's message reaches a working job's wire and shows as their step; the status stays", () => {
    const driver = new SteerDriver();
    const { runner, run } = job(driver);
    expect(run.status).toBe("working");
    runner.say(run.id, "  use bun  ", { steer: true });
    expect(driver.steered).toEqual(["use bun"]);
    expect(run.status).toBe("working");
    expect(run.steps.at(-1)).toMatchObject({ kind: "user", text: "use bun" });
  });

  test("without steer, the old rules stand: a job takes no message, a replying chat takes none", () => {
    const a = new SteerDriver();
    const { runner, run } = job(a);
    expect(refusal(() => runner.say(run.id, "hi"))).toBe("only a chat takes messages");
    expect(a.steered).toEqual([]);
    const b = new SteerDriver();
    const c = chat(b);
    expect(refusal(() => c.runner.say(c.run.id, "more"))).toBe("Steer fixture is still replying");
    expect(b.steered).toEqual([]);
  });

  test("a chat waiting for its next message takes it as a turn, steer or not", () => {
    const driver = new SteerDriver();
    const { runner, run } = chat(driver);
    driver.ctx?.result({ text: "hi", durationMs: 1, turns: 1 }, null);
    expect(run.status).toBe("idle");
    runner.say(run.id, "next", { steer: true });
    expect(driver.said).toEqual(["next"]);
    expect(driver.steered).toEqual([]);
    expect(run.status).toBe("working");
  });

  test("an ended run, a stage, a driver without the wire and an empty message are refused", () => {
    const ended = new SteerDriver();
    const e = job(ended);
    ended.ctx?.result({ text: "ok", durationMs: 1, turns: 1 }, null);
    ended.ctx?.exited({ code: 0, stderr: "" });
    expect(refusal(() => e.runner.say(e.run.id, "late", { steer: true }))).toBe("the run has ended");

    const staged = job(new SteerDriver(), { stage: true });
    expect(refusal(() => staged.runner.say(staged.run.id, "hi", { steer: true }))).toStartWith("an incubator stage takes no messages");

    const plain = job(new PlainDriver());
    expect(refusal(() => plain.runner.say(plain.run.id, "hi", { steer: true }))).toBe("Plain fixture takes no message mid-turn here");

    const empty = job(new SteerDriver());
    expect(refusal(() => empty.runner.say(empty.run.id, "   ", { steer: true }))).toBe("say something first");
  });

  test("a driver that cannot take it now says why, and no step is added", () => {
    const driver = new SteerDriver();
    driver.takes = false;
    const { runner, run } = job(driver);
    const before = run.steps.length;
    expect(refusal(() => runner.say(run.id, "hi", { steer: true }))).toBe("it cannot take a message just now: it is starting or ending");
    expect(run.steps.length).toBe(before);
  });

  test("an unknown run is its own error, for a 404", () => {
    const { runner } = job(new SteerDriver());
    expect(() => runner.say("nope", "hi", { steer: true })).toThrow(UnknownRunError);
    expect(() => runner.interrupt("nope")).toThrow(UnknownRunError);
  });
});

describe("interrupt", () => {
  test("stops a chat's reply and notes it; prompts the turn left waiting are denied", async () => {
    const driver = new SteerDriver();
    const { runner, run } = chat(driver);
    const asked = driver.ctx?.ask({ kind: "question", questions: [] }, "q1");
    expect(run.status).toBe("waiting");
    runner.interrupt(run.id);
    expect(driver.interrupts).toBe(1);
    expect(await asked).toEqual({ kind: "deny" });
    expect(run.steps.some((s) => s.kind === "note" && s.text === "you stopped the turn")).toBe(true);
    expect(driver.steered).toEqual([]);
  });

  test("with a message, a job's turn stops and the message goes next", () => {
    const driver = new SteerDriver();
    const { runner, run } = job(driver);
    runner.interrupt(run.id, "do the other thing");
    expect(driver.interrupts).toBe(1);
    expect(driver.steered).toEqual(["do the other thing"]);
    expect(run.steps.map((s) => s.text)).toContain("you stopped the turn; your message goes next");
    expect(run.steps.at(-1)).toMatchObject({ kind: "user", text: "do the other thing" });
  });

  test("a job is never stopped with nothing to go on with; stop ends it instead", () => {
    const driver = new SteerDriver();
    const { runner, run } = job(driver);
    expect(refusal(() => runner.interrupt(run.id))).toStartWith("a job stops its turn only for a message");
    expect(driver.interrupts).toBe(0);
  });

  test("a turn the driver cannot stop leaves the wire untouched", () => {
    const driver = new SteerDriver();
    driver.stops = false;
    const { runner, run } = job(driver);
    expect(refusal(() => runner.interrupt(run.id, "instead"))).toStartWith("there is no turn running to stop");
    expect(driver.steered).toEqual([]);
    expect(run.steps.some((s) => s.kind === "note")).toBe(false);
  });

  test("a chat between turns has nothing to stop, and a stage is never stopped", () => {
    const driver = new SteerDriver();
    const c = chat(driver);
    driver.ctx?.result({ text: "hi", durationMs: 1, turns: 1 }, null);
    expect(refusal(() => c.runner.interrupt(c.run.id))).toBe("nothing to stop: it waits for your message");
    const staged = job(new SteerDriver(), { stage: true });
    expect(refusal(() => staged.runner.interrupt(staged.run.id, "x"))).toStartWith("an incubator stage takes no messages");
  });
});
