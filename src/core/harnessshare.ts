/** The reported and estimated dollars and archived Claude sessions that went
 *  into repos marked as the harness. Yegge's 25% figure is the default line.
 *  Pure and browser-safe; the costs view, CLI and ranger hub share it. */
import type { RepoCard } from "./cards";
import type { CostSheet } from "./costsheet";
import type { HistoryOverview, Repo } from "./types";

/** the weeks the table shows */
export const WEEKS = 8;
/** Yegge's default warning line, in percent */
export const HARNESS_SHARE_MAX = 25;

export interface HarnessShare {
  /** dollars, reported plus estimated, in the window */
  usd: { harness: number; rest: number };
  /** Claude sessions started in the window, from the archive */
  sessions: { harness: number; rest: number };
  /** harness dollars over total dollars; null when nothing was spent */
  share: number | null;
  /** harness sessions over total sessions; null when none started */
  sessionShare: number | null;
}

export interface HarnessWeek {
  /** the week's Monday, YYYY-MM-DD */
  from: string;
  harness: number;
  rest: number;
  /** harness dollars over the total; null when nothing was spent */
  share: number | null;
}

/** A card counts as the harness if any backend's checkout is marked. */
export const isHarnessCard = (card: Pick<RepoCard, "checkouts">): boolean =>
  card.checkouts.some((repo) => repo.harness === true);

/** The marked cards' names in board order. */
export function harnessNames(cards: readonly RepoCard[]): string[] {
  return cards.filter(isHarnessCard).map((card) => card.name);
}

/** One card per repo, keyed by its id, for a backend's own overview. */
export function cardsOf(repos: readonly Repo[]): RepoCard[] {
  return repos.map((repo) => ({ key: repo.id, name: repo.name, checkouts: [repo] }));
}

/** The window's dollars by the sheet's repo lines, and sessions by the
 *  largest checkout for each card over the selected archive days. */
export function harnessShare(
  sheet: Pick<CostSheet, "repos">,
  history: HistoryOverview | null,
  days: number,
  cards: readonly RepoCard[],
): HarnessShare {
  const marked = new Map(cards.map((card) => [card.key, isHarnessCard(card)]));
  const usd = { harness: 0, rest: 0 };
  for (const line of sheet.repos) {
    const amount = line.usd + line.est;
    if (marked.get(line.key) === true) usd.harness += amount;
    else usd.rest += amount;
  }

  const sessions = { harness: 0, rest: 0 };
  if (history?.available) {
    const from = Math.max(0, history.days.length - days);
    for (const card of cards) {
      let largest = 0;
      for (const checkout of card.checkouts) {
        const archive = history.repos[checkout.id];
        if (!archive) continue;
        const count = archive.daySessions.slice(from).reduce((sum, day) => sum + day, 0);
        largest = Math.max(largest, count);
      }
      if (isHarnessCard(card)) sessions.harness += largest;
      else sessions.rest += largest;
    }
  }

  return {
    usd,
    sessions,
    share: shareOf(usd.harness, usd.rest),
    sessionShare: shareOf(sessions.harness, sessions.rest),
  };
}

/** The archive's dollars by local week, using each card's largest checkout
 *  over the full overview rather than summing duplicate checkout histories. */
export function harnessWeeks(
  history: HistoryOverview | null,
  cards: readonly RepoCard[],
  weeks = WEEKS,
): HarnessWeek[] {
  if (!history?.available) return [];
  const byWeek = new Map<string, { harness: number; rest: number }>();
  for (const day of history.days) {
    const from = weekFrom(day);
    if (!byWeek.has(from)) byWeek.set(from, { harness: 0, rest: 0 });
  }

  for (const card of cards) {
    const lead = largestOverviewCheckout(card, history);
    if (!lead) continue;
    const amountByDay = history.repos[lead.id]?.days ?? [];
    for (let index = 0; index < history.days.length; index++) {
      const day = history.days[index];
      if (day === undefined) continue;
      const bucket = byWeek.get(weekFrom(day));
      if (!bucket) continue;
      const amount = amountByDay[index] ?? 0;
      if (isHarnessCard(card)) bucket.harness += amount;
      else bucket.rest += amount;
    }
  }

  const limit = Number.isFinite(weeks) ? Math.max(0, Math.floor(weeks)) : WEEKS;
  const ordered = [...byWeek.entries()];
  const newest = limit === 0 ? [] : ordered.slice(-limit);
  return newest.map(([from, amounts]) => ({
    from,
    ...amounts,
    share: shareOf(amounts.harness, amounts.rest),
  }));
}

/** The local Monday that starts this date's week. */
export function weekFrom(day: string): string {
  const monday = localDay(day);
  const sinceMonday = (monday.getDay() + 6) % 7;
  monday.setDate(monday.getDate() - sinceMonday);
  return formatDay(monday);
}

/** The ISO week key; the week's Thursday supplies its year. */
export function weekKey(day: string): string {
  const thursday = localDay(weekFrom(day));
  thursday.setDate(thursday.getDate() + 3);
  const year = thursday.getFullYear();
  const elapsed = Math.round(
    (Date.UTC(year, thursday.getMonth(), thursday.getDate()) - Date.UTC(year, 0, 1)) / 86_400_000,
  );
  const week = Math.ceil((elapsed + 1) / 7);
  return `${year}-W${String(week).padStart(2, "0")}`;
}

function largestOverviewCheckout(
  card: RepoCard,
  history: Extract<HistoryOverview, { available: true }>,
): { id: string; usd: number } | undefined {
  let best: { id: string; usd: number } | undefined;
  for (const checkout of card.checkouts) {
    const archive = history.repos[checkout.id];
    if (!archive) continue;
    const usd = archive.days.reduce((sum, amount) => sum + amount, 0);
    if (usd > (best?.usd ?? 0)) best = { id: checkout.id, usd };
  }
  return best;
}

function shareOf(harness: number, rest: number): number | null {
  const total = harness + rest;
  return total > 0 ? harness / total : null;
}

function localDay(day: string): Date {
  const [year = 0, month = 1, date = 1] = day.split("-").map(Number);
  return new Date(year, month - 1, date);
}

function formatDay(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}
