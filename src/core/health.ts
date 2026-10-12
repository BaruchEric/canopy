/**
 * Health's model (docs/superpowers/specs/2026-10-12-health-design.md): the
 * states a check moves through, the backoff between auto heals, when canopy
 * gives up, and the one word the top bar says for all of them. Pure and
 * browser-safe; the hub in server/health.ts owns the timers.
 */

import type { HealMode, HealthCheck, HealthScope, HealthState } from "./types";

/** heals in a row that may fail before canopy stops trying */
export const HEAL_MAX = 5;
/** a check ok this long forgets its failed heals, the ranger's rule */
export const RESET_AFTER = 5 * 60_000;
/** state changes kept per check */
export const HISTORY_MAX = 20;
/** an `unknown` check this old is worth a warning */
const UNKNOWN_WARN = 60_000;

export interface HealthTimings {
  /** the first wait before an auto heal, doubled per failed heal */
  base: number;
  cap: number;
  resetAfter: number;
  healMax: number;
}

export const HEALTH_TIMINGS: HealthTimings = { base: 1000, cap: 60_000, resetAfter: RESET_AFTER, healMax: HEAL_MAX };

/** What a probe saw. `off`: not set up here, with why when that is worth
 *  saying (a repo's check canopy will not run). `healing`: the piece is
 *  restarting itself. `gave-up`: the piece stopped restarting itself and
 *  said so on its own, so canopy escalates nothing. */
export type ProbeResult =
  | { state: "ok"; detail?: string }
  | { state: "down"; why: string; detail?: string }
  | { state: "off"; why?: string }
  | { state: "healing"; why: string }
  | { state: "gave-up"; why: string };

export const pass = (detail?: string): ProbeResult => (detail === undefined ? { state: "ok" } : { state: "ok", detail });
export const fail = (why: string, detail?: string): ProbeResult => (detail === undefined ? { state: "down", why } : { state: "down", why, detail });

export type HealAction = "heal" | "escalate" | null;

/** 1 s, doubling per failed heal, capped */
export const healDelay = (fails: number, t: HealthTimings = HEALTH_TIMINGS): number => Math.min(t.base * 2 ** fails, t.cap);

export const isBad = (c: Pick<HealthCheck, "state">): boolean => c.state === "down" || c.state === "gave-up";

export function newCheck(def: { id: string; label: string; scope: HealthScope; heal: HealMode; button: boolean }, now: number): HealthCheck {
  return { ...def, state: "unknown", why: null, since: now, lastOk: null, fails: 0, nextHeal: null, history: [] };
}

/** `c` moved to `state`, with a history entry when that is a change */
function moveTo(c: HealthCheck, state: HealthState, why: string | null, now: number): HealthCheck {
  if (c.state === state) return { ...c, why };
  const history = [...c.history, { at: now, state, why }].slice(-HISTORY_MAX);
  // the moment it came well or stopped being well, not every pass, so a
  // check that stays ok changes nothing worth sending
  const lastOk = state === "ok" || c.state === "ok" ? now : c.lastOk;
  return { ...c, state, why, since: now, history, lastOk };
}

/** A probe's answer. A pass clears the fails once the check has stayed well
 *  for `resetAfter` (or right away after a give-up); a failure on an `auto`
 *  check schedules a heal unless one is already pending, and anything else
 *  is down. */
export function observe(c: HealthCheck, r: ProbeResult, now: number, t: HealthTimings = HEALTH_TIMINGS): { check: HealthCheck; action: HealAction } {
  const { detail: _old, ...rest } = c;
  const base: HealthCheck = "detail" in r && r.detail !== undefined ? { ...rest, detail: r.detail } : rest;
  switch (r.state) {
    case "off":
      return { check: { ...moveTo(base, "off", r.why ?? null, now), fails: 0, nextHeal: null }, action: null };
    case "ok": {
      const fresh = c.state === "gave-up" || c.state === "unknown" || c.state === "off";
      const wellSince = c.state === "ok" ? c.since : now;
      const fails = fresh || now - wellSince >= t.resetAfter ? 0 : c.fails;
      return { check: { ...moveTo(base, "ok", null, now), fails, nextHeal: null }, action: null };
    }
    case "gave-up":
      return { check: { ...moveTo(base, "gave-up", r.why, now), nextHeal: null }, action: null };
    case "healing":
      if (c.state === "gave-up") return { check: { ...base, why: r.why }, action: null };
      return { check: moveTo(base, "healing", r.why, now), action: null };
    case "down":
      if (c.state === "gave-up") return { check: { ...base, why: r.why }, action: null };
      if (c.heal !== "auto") return { check: { ...moveTo(base, "down", r.why, now), nextHeal: null }, action: null };
      if (c.state === "healing" && c.nextHeal !== null) return { check: { ...base, why: r.why }, action: null };
      return { check: { ...moveTo(base, "healing", r.why, now), nextHeal: now + healDelay(c.fails, t) }, action: "heal" };
  }
}

/** A heal ran and the check still fails: one more on the count, and at
 *  `healMax` canopy gives up and escalates, once. */
export function healFailed(c: HealthCheck, why: string, now: number, t: HealthTimings = HEALTH_TIMINGS): { check: HealthCheck; action: HealAction } {
  // a hand ran it: it is down again until the next hand, never a loop
  if (c.heal !== "auto") return { check: { ...moveTo(c, "down", why, now), nextHeal: null }, action: null };
  const fails = c.fails + 1;
  if (fails >= t.healMax) return { check: { ...moveTo(c, "gave-up", why, now), fails, nextHeal: null }, action: "escalate" };
  return { check: { ...moveTo(c, "healing", why, now), fails, nextHeal: now + healDelay(fails, t) }, action: "heal" };
}

/** the button: whatever happened before, start counting again and heal now */
export function manualHeal(c: HealthCheck, now: number): HealthCheck {
  return { ...moveTo(c, "healing", c.why, now), fails: 0, nextHeal: now };
}

/** The top bar's word for every check: bad when any is down or gave up,
 *  a warning while any heals or has not answered for a minute. */
export function summary(checks: readonly HealthCheck[], now: number): { level: "ok" | "warn" | "bad"; word: string; title: string; count: number } {
  const counted = checks.filter((c) => c.state !== "off");
  const bad = counted.filter(isBad);
  if (bad.length) return { level: "bad", word: `${bad.length} down`, title: bad.map((c) => `${c.label}: ${c.why ?? c.state}`).join("\n"), count: bad.length };
  const warn = counted.filter((c) => c.state === "healing" || (c.state === "unknown" && now - c.since > UNKNOWN_WARN));
  if (warn.length) return { level: "warn", word: `${warn.length} healing`, title: warn.map((c) => `${c.label}: ${c.why ?? c.state}`).join("\n"), count: warn.length };
  return { level: "ok", word: "ok", title: "every check is well", count: 0 };
}
