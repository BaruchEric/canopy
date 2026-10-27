import type { HistoryOverview, RepoHistory } from "./types";

type Available = Extract<HistoryOverview, { available: true }>;

/** Several backends' archive overviews as one, on the first available
 *  one's days: a day it does not cover drops out of the others' arrays and
 *  a day they lack is 0, so every ring on the board shares one strip. One
 *  overview is handed back as it is. */
export function mergeHistory(parts: readonly HistoryOverview[]): HistoryOverview | null {
  if (parts.length === 1) return parts[0] ?? null;
  const ok = parts.filter((p): p is Available => p.available);
  const base = ok[0];
  if (!base) return parts[0] ?? null;
  const at = new Map(base.days.map((d, i) => [d, i]));
  const align = (days: string[], vals: number[]): number[] => {
    const out = base.days.map(() => 0);
    days.forEach((d, i) => {
      const j = at.get(d);
      if (j !== undefined) out[j] = vals[i] ?? 0;
    });
    return out;
  };
  const repos: Record<string, RepoHistory> = {};
  let maxDay = 0;
  for (const p of ok) {
    maxDay = Math.max(maxDay, p.maxDay);
    for (const [id, h] of Object.entries(p.repos)) {
      repos[id] = p === base ? h : { ...h, days: align(p.days, h.days), daySessions: align(p.days, h.daySessions) };
    }
  }
  return { available: true, days: base.days, maxDay, repos, fetchedAt: base.fetchedAt };
}
