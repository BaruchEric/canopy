import { describe, expect, test } from "bun:test";
import type { MoveCheck, MoveOut, TermInfo } from "../../src/core/types";
import { runMove, type MoveDeps, type MoveStep } from "./move";

const OUT = { session: "s", harness: "claude", path: "/a", branch: "main", head: "h", name: "s.jsonl", wip: null } as MoveOut;
const TERM = { id: "t" } as TermInfo;
const deps = (fail?: MoveStep, check: MoveCheck = { ok: true, path: "/b", existing: false }): MoveDeps & { calls: string[] } => {
  const calls: string[] = [];
  const at = <T>(s: MoveStep, v: T) => async () => {
    calls.push(s);
    if (s === fail) throw new Error(`${s} broke`);
    return v;
  };
  return { calls, check: at("check", check), stop: at("stop", OUT), transcript: at("transcript", new Blob(["x"])), load: at("load", TERM), clean: at("clean", undefined) };
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
    expect(await runMove(d, () => {})).toEqual({ ok: false, step: "check", error: "dirty", stopped: false, loaded: null });
    expect(d.calls).toEqual(["check"]);
  });
  test("a failed stop counts as stopped, so the sheet offers resume here", async () => {
    expect(await runMove(deps("stop"), () => {})).toMatchObject({ ok: false, step: "stop", stopped: true, loaded: null });
  });
  test("a failed load says the agent was stopped and nothing loaded", async () => {
    expect(await runMove(deps("load"), () => {})).toMatchObject({ ok: false, step: "load", stopped: true, loaded: null });
  });
  test("a failed clean says the session already runs on the target", async () => {
    expect(await runMove(deps("clean"), () => {})).toMatchObject({ ok: false, step: "clean", stopped: true, loaded: TERM });
  });
});
