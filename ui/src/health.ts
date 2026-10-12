/**
 * Health in the page (docs/superpowers/specs/2026-10-12-health-design.md):
 * every backend's checks as rows, a backend the page cannot reach as a row
 * of its own, grouped and sorted for the list the chip, the panel and the
 * page share. Pure; tested in health.test.ts.
 */

import { isBad, summary } from "../../src/core/health";
import type { HealthCheck, HealthState } from "../../src/core/types";

/** the dock panel's id: a leading slash never names a repo */
export const HEALTH_PANEL = "/health";
export const isHealthPanel = (id: string): boolean => id === HEALTH_PANEL;
export const HEALTH_NAME = "health";
/** its mark on its head and its tab */
export const HEALTH_GLYPH = "∿";

export interface HealthRow {
  backend: string;
  check: HealthCheck;
}

export const STATE_WORD: Record<HealthState, string> = {
  ok: "ok",
  down: "down",
  healing: "healing",
  "gave-up": "gave up",
  off: "off",
  unknown: "checking",
};

/** the colour a state's word takes */
export const STATE_TONE: Record<HealthState, "moss" | "lichen" | "rust" | "faint"> = {
  ok: "moss",
  healing: "lichen",
  unknown: "lichen",
  down: "rust",
  "gave-up": "rust",
  off: "faint",
};

interface ConnLike {
  status: { state: string; reason?: string };
}

/** A backend the page cannot reach, as a check: what it last said of its
 *  own checks means nothing while it is away. */
function awayCheck(backend: string, conn: ConnLike | undefined, now: number): HealthCheck {
  const state = conn?.status.state ?? "connecting";
  const reason = conn?.status.reason;
  return {
    id: "backend",
    label: `the ${backend} backend`,
    scope: { kind: "canopy" },
    state: state === "connecting" ? "unknown" : "down",
    why: state === "signin" ? "sign in to it" : state === "connecting" ? "connecting" : `offline${reason ? `: ${reason}` : ""}`,
    since: now,
    lastOk: null,
    heal: "none",
    fails: 0,
    nextHeal: null,
    button: false,
    history: [],
  };
}

/** Every shown backend's checks, in the page's backend order; a backend that
 *  is not online is one row saying so. */
export function healthRows(health: Readonly<Record<string, readonly HealthCheck[]>>, order: readonly string[], conns: Readonly<Record<string, ConnLike>>, now: number): HealthRow[] {
  const rows: HealthRow[] = [];
  for (const backend of order) {
    const conn = conns[backend];
    if (conn?.status.state !== "online") {
      rows.push({ backend, check: awayCheck(backend, conn, now) });
      continue;
    }
    for (const check of health[backend] ?? []) rows.push({ backend, check });
  }
  return rows;
}

const rank = (c: HealthCheck): number => (isBad(c) ? 0 : c.state === "healing" || c.state === "unknown" ? 1 : c.state === "ok" ? 2 : 3);

export interface HealthGroup {
  key: string;
  title: string;
  backend: string;
  /** the repo's id on its backend, for a repo's group */
  repoId: string | null;
  rows: HealthRow[];
}

/** By backend, then canopy's own pieces and each repo; the bad first in a
 *  group, then by label. `names` gives a repo's name by its qualified id. */
export function groupRows(rows: readonly HealthRow[], many: boolean, name: (backend: string, repoId: string) => string = (_b, id) => id): HealthGroup[] {
  const groups = new Map<string, HealthGroup>();
  for (const row of rows) {
    const { scope } = row.check;
    const repoId = scope.kind === "repo" ? scope.repoId : null;
    const key = `${row.backend}\u0000${repoId ?? ""}`;
    let g = groups.get(key);
    if (!g) {
      const what = repoId === null ? "canopy" : name(row.backend, repoId);
      g = { key, title: many ? `${row.backend} · ${what}` : what, backend: row.backend, repoId, rows: [] };
      groups.set(key, g);
    }
    g.rows.push(row);
  }
  for (const g of groups.values()) g.rows.sort((a, b) => rank(a.check) - rank(b.check) || a.check.label.localeCompare(b.check.label));
  return [...groups.values()];
}

/** the chip's word over every row */
export const healthSummary = (rows: readonly HealthRow[], now: number) => summary(rows.map((r) => r.check), now);

/** every backend's checks of one repo, by its qualified id */
export function repoChecks(health: Readonly<Record<string, readonly HealthCheck[]>>, repoId: string): HealthCheck[] {
  const out: HealthCheck[] = [];
  for (const list of Object.values(health)) for (const c of list) if (c.scope.kind === "repo" && c.scope.repoId === repoId) out.push(c);
  return out;
}

/** the qualified ids of the repos with a check down or given up */
export function badRepoIds(health: Readonly<Record<string, readonly HealthCheck[]>>): Set<string> {
  const out = new Set<string>();
  for (const list of Object.values(health)) for (const c of list) if (c.scope.kind === "repo" && isBad(c)) out.add(c.scope.repoId);
  return out;
}

/** how long, in the fewest words: 40s, 3m, 2h, 5d */
export function span(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

export interface RepoWord {
  text: string;
  tone: "moss" | "lichen" | "rust";
  title: string;
}

/** The card's word for a repo's checks, or null when it has none that run
 *  here. One check speaks for itself ("up · 42ms", "down 3m"); several
 *  count ("2 of 3 up"). */
export function repoWord(checks: readonly HealthCheck[], now: number): RepoWord | null {
  const live = checks.filter((c) => c.state !== "off");
  if (live.length === 0) return null;
  const title = live.map((c) => `${c.label}: ${STATE_WORD[c.state]}${c.why ? `, ${c.why}` : c.detail ? `, ${c.detail}` : ""}`).join("\n");
  const bad = live.filter(isBad);
  const up = live.filter((c) => c.state === "ok").length;
  if (live.length === 1) {
    const c = live[0];
    if (!c) return null;
    if (isBad(c)) return { text: `${c.state === "gave-up" ? "gave up" : "down"} ${span(now - c.since)}`, tone: "rust", title };
    if (c.state === "healing") return { text: "healing", tone: "lichen", title };
    if (c.state === "unknown") return { text: "checking", tone: "lichen", title };
    const ms = /in (\d+ms)$/.exec(c.detail ?? "")?.[1];
    return { text: ms ? `up · ${ms}` : "up", tone: "moss", title };
  }
  if (bad.length > 0) return { text: `${bad.length} of ${live.length} down`, tone: "rust", title };
  if (up < live.length) return { text: `${up} of ${live.length} up`, tone: "lichen", title };
  return { text: `${up} up`, tone: "moss", title };
}
