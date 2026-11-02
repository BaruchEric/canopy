import { describe, expect, test } from "bun:test";
import { stallReason } from "./stall";
import { activityFor, carriedEvent, eventLive, fromRun, resumable, stalledEvent, TRIGGER_STATUSES, type TriggerEvent } from "./trigger";
import type { Run } from "./types";

const event = (over: Partial<TriggerEvent> = {}): TriggerEvent => ({
  id: "e1",
  rule: "shop",
  source: "github",
  service: "github",
  key: "12",
  short: "#12",
  title: "Login breaks",
  note: "",
  repoId: "web/shop",
  workflow: "issue-fix",
  status: "working",
  count: 1,
  firstAt: 1,
  lastAt: 1,
  runId: "r1",
  branch: "b1",
  ...over,
});

const run = (over: Partial<Run> = {}): Run => ({ id: "r1", status: "stopped", steps: [], branch: { origin: "b1", state: "ready" }, ...over }) as Run;

describe("the stall watchdog in the trigger model", () => {
  test("a run the watchdog stopped reads stopped with the stall's reason; one stopped by hand keeps its own", () => {
    expect(fromRun(event(), run({ stall: { warned: 1, stopped: 2 } }), 5)).toMatchObject({ status: "stopped", reason: stallReason() });
    expect(fromRun(event(), run(), 5)).toMatchObject({ status: "stopped", reason: "stopped before it finished" });
  });

  test("stalledEvent marks the event following the run, needing Eric; another run's or a PR's event is unchanged", () => {
    const e = event({ status: "stopped" });
    expect(stalledEvent(e, "r1", "quiet twice", 9)).toMatchObject({ status: "stalled", needsYou: "quiet twice", reason: "quiet twice", endedAt: 9 });
    expect(stalledEvent(e, "r2", "quiet twice", 9)).toBe(e);
    const onPr = event({ pr: { number: 3, url: "u" }, status: "review" });
    expect(stalledEvent(onPr, "r1", "quiet twice", 9)).toBe(onPr);
  });

  test("a stalled event stays so through the stopped run's later changes, and a new run on it moves it", () => {
    const stalled = stalledEvent(event(), "r1", "quiet twice", 9);
    expect(fromRun(stalled, run({ stall: { warned: 1, stopped: 2 } }), 10)).toBe(stalled);
  });

  test("carriedEvent follows the resumed run, working, with the stop's words gone", () => {
    const e = event({ status: "stopped", reason: stallReason(), endedAt: 3 });
    const next = carriedEvent(e, "r1", run({ id: "r2", status: "working" }), 11);
    expect(next).toMatchObject({ runId: "r2", status: "working", lastAt: 11 });
    expect(next.reason).toBeUndefined();
    expect(next.endedAt).toBeUndefined();
    expect(carriedEvent(e, "r9", run({ id: "r2" }), 11)).toBe(e);
  });

  test("stalled is a state of its own: resumable on a branch, not live, and its session hears it as an error", () => {
    expect(TRIGGER_STATUSES).toContain("stalled");
    const stalled = stalledEvent(event(), "r1", "it went quiet twice", 9);
    expect(resumable(stalled)).toBe(true);
    expect(resumable({ ...stalled, branch: undefined })).toBe(false);
    expect(eventLive(stalled)).toBe(false);
    expect(activityFor(event({ session: "s" }), { ...stalled, session: "s" })).toEqual({ type: "error", body: "Stopped: it went quiet twice." });
  });
});
