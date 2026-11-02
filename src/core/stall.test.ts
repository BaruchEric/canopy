import { describe, expect, test } from "bun:test";
import { lastHeard, quiet, quietWords, STALL_AFTER, stallReason, stallResumeMessage, stallStep, stalledWhy, toolOpen, wrapUpMessage } from "./stall";
import type { Run, RunStep } from "./types";

const T0 = Date.UTC(2026, 10, 2, 9, 0);

const step = (at: number, extra: Partial<RunStep> = {}): RunStep => ({ id: String(at), at, kind: "text", text: "x", ...extra });

const run = (over: Partial<Run> = {}): Pick<Run, "status" | "chat" | "steps" | "startedAt" | "stall"> => ({
  status: "working",
  chat: false,
  steps: [step(T0)],
  startedAt: T0 - 1000,
  ...over,
});

describe("quiet", () => {
  test("a working job heard from STALL_AFTER ago with no tool open is quiet; a minute sooner it is not", () => {
    expect(quiet(run(), T0 + STALL_AFTER)).toBe(true);
    expect(quiet(run(), T0 + STALL_AFTER - 60_000)).toBe(false);
  });

  test("an open tool call is never quiet, however long it runs", () => {
    const r = run({ steps: [step(T0, { kind: "tool", tool: { name: "Bash", title: "bun test", status: "running" } })] });
    expect(toolOpen(r)).toBe(true);
    expect(quiet(r, T0 + 10 * STALL_AFTER)).toBe(false);
    const done = run({ steps: [step(T0, { kind: "tool", tool: { name: "Bash", title: "bun test", status: "ok" } })] });
    expect(quiet(done, T0 + STALL_AFTER)).toBe(true);
  });

  test("a chat, a waiting run and an idle one are never quiet", () => {
    expect(quiet(run({ chat: true }), T0 + 10 * STALL_AFTER)).toBe(false);
    expect(quiet(run({ status: "waiting" }), T0 + 10 * STALL_AFTER)).toBe(false);
    expect(quiet(run({ status: "idle" }), T0 + 10 * STALL_AFTER)).toBe(false);
  });

  test("the clock is the newest step, else the start", () => {
    expect(lastHeard(run({ steps: [step(T0), step(T0 + 5000), step(T0 + 2000)] }))).toBe(T0 + 5000);
    expect(lastHeard(run({ steps: [] }))).toBe(T0 - 1000);
  });
});

describe("stallStep", () => {
  test("warn on the first quiet, stop on the next, nothing once stopped", () => {
    expect(stallStep(run(), T0 + STALL_AFTER)).toBe("warn");
    expect(stallStep(run({ stall: { warned: T0 } }), T0 + STALL_AFTER)).toBe("stop");
    expect(stallStep(run({ stall: { warned: T0, stopped: T0 + 1 } }), T0 + STALL_AFTER)).toBeNull();
    expect(stallStep(run(), T0 + 1000)).toBeNull();
  });
});

describe("the words", () => {
  test("say the span the watchdog used", () => {
    expect(quietWords(STALL_AFTER)).toBe("20 minutes");
    expect(quietWords(60_000)).toBe("1 minute");
    expect(wrapUpMessage()).toBe("You have been quiet for 20 minutes. Finish what you are on, commit what is sound, and end the turn.");
    expect(stallReason()).toBe("it went quiet for 20 minutes after being told to wrap up, so canopy stopped it");
    expect(stallResumeMessage()).toContain("Carry on from where the last session left off");
    expect(stalledWhy("again")).toContain("went quiet twice");
    expect(stalledWhy("not-resumed", "repo gone")).toBe("it went quiet and canopy stopped it, but could not resume it: repo gone");
  });
});
