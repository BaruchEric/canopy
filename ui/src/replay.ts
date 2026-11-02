/** The replay bar's arithmetic (FR-043 plan 2): a finished run's steps as
 *  a timeline to play at 1× or 4×, scrub and jump through.
 *
 *  A cursor counts the entries on show: the steps in order, then the end,
 *  where the run's outcome shows. Playing waits each entry's gap, the time
 *  between it and the one before as recorded, capped at `REPLAY_GAP`, so
 *  a long tool call or a night between chat messages does not stall it.
 *  Pure; the bar in RunSheet.tsx holds the cursor and the timer. */

import type { Run, RunReplay, RunStep } from "../../src/core/types";

/** the longest wait between two entries at 1× */
export const REPLAY_GAP = 3_000;
export const REPLAY_SPEEDS = [1, 4] as const;
export type ReplaySpeed = (typeof REPLAY_SPEEDS)[number];

export type ReplayJumpKind = "prompt" | "message" | "subagent" | "result";

export interface ReplayJump {
  kind: ReplayJumpKind;
  label: string;
  /** the cursor that shows this entry */
  cursor: number;
}

export interface ReplayTimeline {
  steps: readonly RunStep[];
  /** `gaps[i]`: ms at 1× before entry `i` shows; the last entry is the end */
  gaps: number[];
  jumps: ReplayJump[];
  /** the whole replay at 1×, ms */
  length: number;
}

const clampGap = (ms: number): number => (Number.isFinite(ms) ? Math.min(REPLAY_GAP, Math.max(0, ms)) : 0);

const clip = (text: string, max = 60): string => {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
};

/** The timeline of a replay: each entry's gap, and the places worth a jump
 *  (every prompt the harness asked, every message the user sent, each
 *  subagent's start and the result). */
export function replayTimeline(replay: Pick<RunReplay, "steps" | "asks">, run: Pick<Run, "startedAt" | "endedAt" | "result" | "status">): ReplayTimeline {
  const steps = replay.steps;
  const gaps: number[] = [];
  let last = run.startedAt;
  for (const step of steps) {
    gaps.push(clampGap(step.at - last));
    last = Math.max(last, step.at);
  }
  gaps.push(clampGap((run.endedAt ?? last) - last));
  const asks = new Set(replay.asks);
  const parents = new Set(steps.flatMap((s) => (s.parent ? [s.parent] : [])));
  const jumps: ReplayJump[] = [];
  steps.forEach((step, i) => {
    const cursor = i + 1;
    if (asks.has(step.id)) jumps.push({ kind: "prompt", label: clip((step.text ?? "").replace(/^asked: /, "")), cursor });
    else if (step.kind === "user") jumps.push({ kind: "message", label: clip(step.text ?? ""), cursor });
    else if (parents.has(step.id)) jumps.push({ kind: "subagent", label: clip(step.tool?.title ?? "a subagent"), cursor });
  });
  jumps.push({ kind: "result", label: run.result ? "the result" : `the end (${run.status})`, cursor: gaps.length });
  return { steps, gaps, jumps, length: gaps.reduce((a, b) => a + b, 0) };
}

/** the last cursor, where everything and the outcome show */
export const replayEnd = (t: Pick<ReplayTimeline, "gaps">): number => t.gaps.length;

/** where `cursor` stands in replay time at 1×, ms */
export function replayTime(t: Pick<ReplayTimeline, "gaps">, cursor: number): number {
  let ms = 0;
  for (let i = 0; i < Math.min(cursor, t.gaps.length); i++) ms += t.gaps[i] ?? 0;
  return ms;
}

/** how long, at `speed`, until the entry after `cursor` shows; null at the end */
export function nextGap(t: Pick<ReplayTimeline, "gaps">, cursor: number, speed: ReplaySpeed): number | null {
  if (cursor >= t.gaps.length) return null;
  return (t.gaps[Math.max(0, cursor)] ?? 0) / speed;
}

/** The run as the timeline shows it at `cursor`: the steps so far, still
 *  working and with no outcome until the end. The checklist is the run's
 *  last, so it waits for the end too. At the end it is the run with the
 *  replay's steps, which for a record a restart left empty are the wire's. */
export function replayView(run: Run, t: ReplayTimeline, cursor: number): Run {
  if (cursor >= replayEnd(t)) return { ...run, steps: [...t.steps] };
  return { ...run, steps: t.steps.slice(0, Math.max(0, cursor)), status: "working", prompt: null, result: undefined, todos: undefined, kept: true };
}

/** `ms` as m:ss */
export function replayClock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
