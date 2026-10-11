import type { MoveCheck, MoveOut, TermInfo } from "../../src/core/types";

/*
 * A shell's agent session moved to another backend, step by step: the
 * target's check, the source's stop, the transcript off the source, the
 * target's load, the source's clean-up. Each step is one call to one
 * backend; the outcome says how far it got, so the sheet can offer the
 * right way back.
 */

export const MOVE_STEPS = ["check", "stop", "transcript", "load", "clean"] as const;
export type MoveStep = (typeof MOVE_STEPS)[number];

export interface MoveDeps {
  check(): Promise<MoveCheck>;
  stop(): Promise<MoveOut>;
  transcript(out: MoveOut): Promise<Blob>;
  load(out: MoveOut, transcript: Blob): Promise<TermInfo>;
  clean(): Promise<void>;
}

export type MoveOutcome =
  | { ok: true; term: TermInfo }
  | { ok: false; step: MoveStep; error: string; stopped: boolean; loaded: TermInfo | null };

const text = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export async function runMove(deps: MoveDeps, onStep: (s: MoveStep) => void): Promise<MoveOutcome> {
  let step: MoveStep = "check";
  let stopped = false;
  let loaded: TermInfo | null = null;
  try {
    onStep(step);
    const c = await deps.check();
    if (!c.ok) return { ok: false, step, error: c.reason ?? "the target cannot take it", stopped, loaded };
    onStep((step = "stop"));
    // the stop may quit the agent and then fail on the snapshot, so from
    // here on the source counts as stopped (its undo is a no-op otherwise)
    stopped = true;
    const out = await deps.stop();
    onStep((step = "transcript"));
    const blob = await deps.transcript(out);
    onStep((step = "load"));
    loaded = await deps.load(out, blob);
    onStep((step = "clean"));
    await deps.clean();
    return { ok: true, term: loaded };
  } catch (err) {
    return { ok: false, step, error: text(err), stopped, loaded };
  }
}
