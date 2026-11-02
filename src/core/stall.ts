/** The stall watchdog's pure half (FR-035, plan 3;
 *  docs/superpowers/specs/2026-10-25-work-until-merged-design.md, "The
 *  stall watchdog"). A job is quiet when nothing has come from it for
 *  `STALL_AFTER` and no tool call is open: a long test run is an open
 *  call, so it never reads as quiet. The first quiet spell gets one
 *  message to wrap up; the next stops the run, and the server resumes a
 *  branch run's session once. The Runner applies these on its tick and
 *  the server's `StallHub` decides the resume. Browser-safe. */

import type { Run } from "./types";

/** how long a job may say nothing, with no tool call open, before it is quiet */
export const STALL_AFTER = 20 * 60_000;
/** how often the watchdog looks */
export const STALL_EVERY = 60_000;
/** the stalls a branch takes before it is left for Eric: the first is
 *  resumed, the second is not */
export const STALLS_RESUMED = 1;

/** the timeline's note when the wrap-up message went down */
export const WRAP_UP_NOTE = "told to wrap up";

/** A span as the messages say it: "20 minutes", "1 minute". */
export function quietWords(ms: number): string {
  const m = Math.max(1, Math.round(ms / 60_000));
  return m === 1 ? "1 minute" : `${m} minutes`;
}

/** When the run was last heard from: its newest step, else its start. */
export function lastHeard(run: Pick<Run, "steps" | "startedAt">): number {
  let at = run.startedAt;
  for (const s of run.steps) if (s.at > at) at = s.at;
  return at;
}

/** Whether a tool call is open: the harness sent its call and no result yet. */
export function toolOpen(run: Pick<Run, "steps">): boolean {
  return run.steps.some((s) => s.tool?.status === "running");
}

/** A working job that has said nothing for `after` with no tool call open.
 *  A chat between turns is idle and a run on a prompt is waiting, so
 *  neither is ever quiet. */
export function quiet(run: Pick<Run, "status" | "chat" | "steps" | "startedAt">, now: number, after = STALL_AFTER): boolean {
  if (run.status !== "working" || run.chat) return false;
  return now - lastHeard(run) >= after && !toolOpen(run);
}

/** What the watchdog does to a watched run now: tell it to wrap up the
 *  first time it is quiet, stop it when it is quiet again after that. */
export function stallStep(run: Pick<Run, "status" | "chat" | "steps" | "startedAt" | "stall">, now: number, after = STALL_AFTER): "warn" | "stop" | null {
  if (!quiet(run, now, after) || run.stall?.stopped !== undefined) return null;
  return run.stall ? "stop" : "warn";
}

/** The one message a quiet run is sent. */
export function wrapUpMessage(after = STALL_AFTER): string {
  return `You have been quiet for ${quietWords(after)}. Finish what you are on, commit what is sound, and end the turn.`;
}

/** The note a quiet run gets when its harness takes no message mid-turn. */
export function noWrapUpNote(label: string, after = STALL_AFTER): string {
  return `quiet for ${quietWords(after)}; ${label} takes no message mid-turn, so canopy waits once more before it stops the run`;
}

/** The note on a run stopped for going quiet again. */
export function stallStopNote(after = STALL_AFTER): string {
  return `stopped: quiet for ${quietWords(after)} again after being told to wrap up`;
}

/** Why a stalled run reads as stopped. */
export function stallReason(after = STALL_AFTER): string {
  return `it went quiet for ${quietWords(after)} after being told to wrap up, so canopy stopped it`;
}

/** The first message of the run that resumes a stalled branch run's
 *  session: the reason, then where to carry on, as `PICKED_UP_NOTE` says it. */
export function stallResumeMessage(after = STALL_AFTER): string {
  return `canopy stopped your last session: it was quiet for ${quietWords(after)}, and quiet again after being told to wrap up. Carry on from where the last session left off: read the worktree's state, finish the task, and commit what is sound.`;
}

/** Why a stalled run is left for Eric rather than resumed. */
export type StallLeft = "again" | "no-session" | "not-resumed";

/** The sentence an event that stalled for good needs Eric for. */
export function stalledWhy(why: StallLeft, detail?: string): string {
  switch (why) {
    case "again":
      return "it went quiet twice on its branch, so canopy stopped it; resume it or look at the branch yourself";
    case "no-session":
      return "it went quiet and canopy stopped it; it has no Claude session to resume, so resume it or look at the branch yourself";
    case "not-resumed":
      return `it went quiet and canopy stopped it, but could not resume it${detail ? `: ${detail}` : ""}`;
  }
}
