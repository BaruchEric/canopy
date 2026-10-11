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

/** what the load was handed, kept so the sheet can ask the target again */
export interface MoveCarried {
  out: MoveOut;
  transcript: Blob;
}

export interface MoveFailure {
  ok: false;
  step: MoveStep;
  error: string;
  /** the source's agent may have quit */
  stopped: boolean;
  /** the shell the target started, when it did */
  loaded: TermInfo | null;
  /** the load's answer never came back (no HTTP status, even on the retry):
   *  the target may already run the session */
  unknown: boolean;
  carried: MoveCarried | null;
}

export type MoveOutcome = { ok: true; term: TermInfo } | MoveFailure;

const text = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** the HTTP status a call failed with; null when no answer came back (the
 *  network, a tunnel's error page, a backend not reached yet) */
export function statusOf(err: unknown): number | null {
  if (typeof err !== "object" || err === null || !("status" in err)) return null;
  return typeof err.status === "number" ? err.status : null;
}

export async function runMove(deps: MoveDeps, onStep: (s: MoveStep) => void): Promise<MoveOutcome> {
  let step: MoveStep = "check";
  let stopped = false;
  let loaded: TermInfo | null = null;
  let carried: MoveCarried | null = null;
  const fail = (error: string, unknown = false): MoveFailure => ({ ok: false, step, error, stopped, loaded, unknown, carried });
  try {
    onStep(step);
    const c = await deps.check();
    if (!c.ok) return fail(c.reason ?? "the target cannot take it");
    onStep((step = "stop"));
    // the stop may quit the agent and then fail on the snapshot, or quit it
    // and lose the answer, so the source counts as stopped unless it said
    // no: a 4xx from out comes before anything is touched, except the 409 for an agent that did not quit in time; the source dropped its record then, so an undo would find nothing either way
    stopped = true;
    let out: MoveOut;
    try {
      out = await deps.stop();
    } catch (err) {
      const status = statusOf(err);
      if (status !== null && status < 500) stopped = false;
      throw err;
    }
    onStep((step = "transcript"));
    const blob = await deps.transcript(out);
    onStep((step = "load"));
    carried = { out, transcript: blob };
    try {
      loaded = await deps.load(out, blob);
    } catch (err) {
      if (statusOf(err) !== null) throw err;
      // no answer: the load may have run. The same shell name again either
      // starts it or finds the one the first call started
      try {
        loaded = await deps.load(out, blob);
      } catch (again) {
        if (statusOf(again) !== null) throw again;
        return fail(text(again), true);
      }
    }
    onStep((step = "clean"));
    await deps.clean();
    return { ok: true, term: loaded };
  } catch (err) {
    return fail(text(err));
  }
}

/** whether "resume here" is offered: the agent may have quit and no shell
 *  started on the target (an unknown load offers it as "resume here anyway") */
export const offersResume = (f: MoveFailure): boolean => f.stopped && f.loaded === null;

/** whether closing the sheet (or the sheet going away) undoes the move: only
 *  when the target surely did not take it, since an undo after a load that
 *  may have run would leave the session going on both machines */
export const closeUndoes = (f: MoveFailure): boolean => offersResume(f) && !f.unknown;
