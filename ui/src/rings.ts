/** The rings: one column per local day, tinted by that day's spend. Pure, so
 *  the card, the panel and the tests share the arithmetic. */
import type { RepoHistory } from "../../src/core/types";

/** The faintest tint a day with any spend at all gets, so a five-cent day
 *  still reads as a day Claude was here. */
export const RING_FLOOR = 0.22;

/** 0 for a quiet day; otherwise a log ramp from RING_FLOOR to 1 against the
 *  heaviest day in the grove, so a $2 day and a $200 day both show, in order. */
export function ringLevel(cost: number, max: number): number {
  if (!(cost > 0)) return 0;
  if (!(max > 0) || cost >= max) return 1;
  const t = Math.log1p(cost) / Math.log1p(max);
  return Math.min(1, RING_FLOOR + (1 - RING_FLOOR) * t);
}

export interface Recent {
  sessions: number;
  cost: number;
  /** index into the overview's days of the last day with a session, or -1 */
  lastDay: number;
}

/** What the day arrays add up to. */
export function recentOf(h: RepoHistory): Recent {
  let sessions = 0;
  let cost = 0;
  let lastDay = -1;
  for (let i = 0; i < h.days.length; i++) {
    const s = h.daySessions[i] ?? 0;
    sessions += s;
    cost += h.days[i] ?? 0;
    if (s > 0) lastDay = i;
  }
  return { sessions, cost, lastDay };
}
