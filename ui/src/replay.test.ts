import { describe, expect, test } from "bun:test";
import type { Run, RunStep } from "../../src/core/types";
import { nextGap, REPLAY_GAP, replayClock, replayEnd, replayTime, replayTimeline, replayView } from "./replay";

const run = (over: Partial<Run> = {}): Run => ({
  id: "r1", repoId: "repo", action: "chat", verb: "Chat", progress: "", expectsChange: false, chat: true, harness: "claude",
  note: "", status: "done", startedAt: 1000, endedAt: 60_000, steps: [], prompt: null,
  result: { text: "done", costUsd: 0.1, durationMs: 5, turns: 1 }, todos: [{ id: "1", subject: "read", status: "completed" }], ...over,
});
const steps: RunStep[] = [
  { id: "1", at: 1500, kind: "user", text: "look at\nthe code" },
  { id: "2", at: 2000, kind: "tool", tool: { name: "Agent", title: "read math.ts", status: "ok" } },
  { id: "3", at: 2100, kind: "tool", tool: { name: "Bash", title: "git log", status: "ok" }, parent: "2" },
  { id: "ask1", at: 30_000, kind: "note", text: "asked: git push" },
  { id: "4", at: 29_000, kind: "text", text: "pushed" },
];

describe("replayTimeline", () => {
  const t = replayTimeline({ steps, asks: ["ask1"] }, run());

  test("gaps follow the recorded times, capped, never negative, with the end last", () => {
    expect(t.gaps).toEqual([500, 500, 100, REPLAY_GAP, 0, REPLAY_GAP]);
    expect(replayEnd(t)).toBe(steps.length + 1);
    expect(t.length).toBe(500 + 500 + 100 + REPLAY_GAP + REPLAY_GAP);
  });

  test("jumps to each prompt, message and subagent's start, and the result", () => {
    expect(t.jumps).toEqual([
      { kind: "message", label: "look at the code", cursor: 1 },
      { kind: "subagent", label: "read math.ts", cursor: 2 },
      { kind: "prompt", label: "git push", cursor: 4 },
      { kind: "result", label: "the result", cursor: 6 },
    ]);
    expect(replayTimeline({ steps: [], asks: [] }, run({ result: undefined, status: "stopped" })).jumps).toEqual([{ kind: "result", label: "the end (stopped)", cursor: 1 }]);
  });

  test("time, the next wait at each speed, and the clock", () => {
    expect(replayTime(t, 0)).toBe(0);
    expect(replayTime(t, 3)).toBe(1100);
    expect(nextGap(t, 3, 1)).toBe(REPLAY_GAP);
    expect(nextGap(t, 3, 4)).toBe(REPLAY_GAP / 4);
    expect(nextGap(t, replayEnd(t), 1)).toBeNull();
    expect(replayClock(65_400)).toBe("1:05");
  });
});

test("replayView shows the steps so far, working, until the end shows the run", () => {
  const t = replayTimeline({ steps, asks: ["ask1"] }, run());
  const mid = replayView(run(), t, 2);
  expect(mid.steps.map((s) => s.id)).toEqual(["1", "2"]);
  expect(mid).toMatchObject({ status: "working", prompt: null, kept: true });
  expect(mid.result).toBeUndefined();
  expect(mid.todos).toBeUndefined();
  const end = replayView(run(), t, replayEnd(t));
  expect(end.steps).toHaveLength(steps.length);
  expect(end).toMatchObject({ status: "done", result: { text: "done" } });
  expect(replayView(run(), t, -3).steps).toEqual([]);
});
