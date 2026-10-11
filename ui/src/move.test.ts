import { describe, expect, test } from "bun:test";
import type { MoveCheck, MoveOut, TermInfo } from "../../src/core/types";
import { closeUndoes, offersResume, runMove, statusOf, type MoveDeps, type MoveFailure, type MoveStep } from "./move";

const OUT = { session: "s", harness: "claude", path: "/a", branch: "main", head: "h", name: "s.jsonl", wip: null, move: "m" } as MoveOut;
const TERM = { id: "t" } as TermInfo;
/** a step that throws: with an HTTP status (an answer) or without (none
 *  came back), the first `times` calls (every call when left out) */
interface Fail {
  step: MoveStep;
  status?: number;
  times?: number;
}
const deps = (fail?: Fail, check: MoveCheck = { ok: true, path: "/b", existing: false }): MoveDeps & { calls: string[] } => {
  const calls: string[] = [];
  let thrown = 0;
  const at = <T>(s: MoveStep, v: T) => async () => {
    calls.push(s);
    if (s === fail?.step && thrown < (fail.times ?? Infinity)) {
      thrown++;
      const err = new Error(`${s} broke`);
      throw fail.status === undefined ? err : Object.assign(err, { status: fail.status });
    }
    return v;
  };
  return { calls, check: at("check", check), stop: at("stop", OUT), transcript: at("transcript", new Blob(["x"])), load: at("load", TERM), clean: at("clean", undefined) };
};
const failed = async (d: MoveDeps): Promise<MoveFailure> => {
  const r = await runMove(d, () => {});
  if (r.ok) throw new Error("the move went through");
  return r;
};

describe("runMove", () => {
  test("every step in order", async () => {
    const d = deps();
    const seen: MoveStep[] = [];
    expect(await runMove(d, (s) => seen.push(s))).toEqual({ ok: true, term: TERM });
    expect(seen).toEqual(["check", "stop", "transcript", "load", "clean"]);
  });
  test("a refused check stops before anything stops", async () => {
    const d = deps(undefined, { ok: false, reason: "dirty", path: "/b", existing: false });
    expect(await runMove(d, () => {})).toEqual({ ok: false, step: "check", error: "dirty", stopped: false, loaded: null, unknown: false, carried: null });
    expect(d.calls).toEqual(["check"]);
  });
  test("a stop with no answer counts as stopped, so the sheet offers resume here", async () => {
    expect(await failed(deps({ step: "stop" }))).toMatchObject({ step: "stop", stopped: true, loaded: null, unknown: false });
  });
  test("a stop that failed on the server (the snapshot) counts as stopped", async () => {
    expect(await failed(deps({ step: "stop", status: 500 }))).toMatchObject({ step: "stop", stopped: true });
  });
  test("a stop the source refused (409 already moving, say) touched nothing", async () => {
    const f = await failed(deps({ step: "stop", status: 409 }));
    expect(f).toMatchObject({ step: "stop", stopped: false, loaded: null });
    expect(offersResume(f)).toBe(false);
    expect(closeUndoes(f)).toBe(false);
  });
  test("a load the target refused says the agent was stopped and nothing loaded", async () => {
    const d = deps({ step: "load", status: 409 });
    const f = await failed(d);
    expect(f).toMatchObject({ step: "load", stopped: true, loaded: null, unknown: false });
    expect(d.calls.filter((c) => c === "load")).toHaveLength(1);
    expect(offersResume(f)).toBe(true);
    expect(closeUndoes(f)).toBe(true);
  });
  test("a load with no answer is tried once more, and a second answer carries on", async () => {
    const d = deps({ step: "load", times: 1 });
    expect(await runMove(d, () => {})).toEqual({ ok: true, term: TERM });
    expect(d.calls).toEqual(["check", "stop", "transcript", "load", "load", "clean"]);
  });
  test("a load with no answer twice is unknown: resume offered, but closing does not undo", async () => {
    const d = deps({ step: "load" });
    const f = await failed(d);
    expect(f).toMatchObject({ step: "load", stopped: true, loaded: null, unknown: true });
    expect(f.carried?.out).toBe(OUT);
    expect(d.calls.filter((c) => c === "load")).toHaveLength(2);
    expect(offersResume(f)).toBe(true);
    expect(closeUndoes(f)).toBe(false);
  });
  test("a retried load that is then refused is a plain failure", async () => {
    let n = 0;
    const d = deps();
    d.load = async () => {
      n++;
      throw n === 1 ? new Error("lost") : Object.assign(new Error("taken"), { status: 409 });
    };
    expect(await failed(d)).toMatchObject({ step: "load", unknown: false, error: "taken" });
  });
  test("a failed clean says the session already runs on the target", async () => {
    const f = await failed(deps({ step: "clean" }));
    expect(f).toMatchObject({ step: "clean", stopped: true, loaded: TERM });
    expect(offersResume(f)).toBe(false);
    expect(closeUndoes(f)).toBe(false);
  });
});

test("statusOf reads the status req puts on an answer, and nothing else", () => {
  expect(statusOf(Object.assign(new Error("x"), { status: 409 }))).toBe(409);
  expect(statusOf(new Error("did not answer"))).toBeNull();
  expect(statusOf("x")).toBeNull();
  expect(statusOf({ status: "409" })).toBeNull();
});
