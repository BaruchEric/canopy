/** The sweep sheet's pure half (FR-018): the plan grouped by kind, the
 *  picks it starts with, a close's outcomes in one line for the sheet and
 *  the feed, and which agent cards a close ended, so their panels and
 *  windows close with them. Tested in sweep.test.ts. */

import { SWEEP_KINDS, type AgentCard, type SweepItem, type SweepKind, type SweepLogEntry, type SweepOutcome } from "../../src/core/types";

/** each kind's heading in the sheet */
export const KIND_HEAD: Record<SweepKind, string> = {
  shell: "shells",
  chat: "chats",
  run: "finished runs",
  pr: "PRs",
  outside: "agents canopy did not start",
};

/** The items a kind at a time, in the sweep's order (outside agents
 *  last), each kind's items in the plan's order; a kind with none is left
 *  out. */
export function groupItems(items: readonly SweepItem[]): { kind: SweepKind; items: SweepItem[] }[] {
  return SWEEP_KINDS.map((kind) => ({ kind, items: items.filter((i) => i.kind === kind) })).filter((g) => g.items.length > 0);
}

/** what the sheet starts ticked: the plan's checked items it may close */
export function defaultPicks(items: readonly SweepItem[]): Set<string> {
  return new Set(items.filter((i) => i.checked && i.closable).map((i) => i.key));
}

/** A log entry's outcomes, read as data from a file a hand may have
 *  edited: an entry with no list has none, and an outcome with no key is
 *  left out. */
export function outcomesOf(entry: SweepLogEntry): SweepOutcome[] {
  const list: unknown = entry.outcomes;
  if (!Array.isArray(list)) return [];
  return list.filter((o): o is SweepOutcome => typeof o === "object" && o !== null && typeof (o as { key?: unknown }).key === "string");
}

const kindOf = (key: string): string => key.slice(0, Math.max(0, key.indexOf(":")));

const count = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

const NOUN: Partial<Record<SweepKind, [string, string]>> = {
  shell: ["shell", "shells"],
  chat: ["chat", "chats"],
  pr: ["PR", "PRs"],
};

/**
 * One close in words: `"closed 7 shells, 2 chats, dismissed 11 runs; 1 in
 * use now"`. Runs are dismissed, every other kind closed; what was not
 * closed follows the semicolon. A close that closed nothing says so first.
 */
export function sweepSummary(outcomes: readonly SweepOutcome[]): string {
  const done = outcomes.filter((o) => o.result === "closed");
  const closed: string[] = [];
  for (const kind of SWEEP_KINDS) {
    const noun = NOUN[kind];
    if (!noun) continue;
    const n = done.filter((o) => kindOf(o.key) === kind).length;
    if (n > 0) closed.push(count(n, noun[0], noun[1]));
  }
  const runs = done.filter((o) => kindOf(o.key) === "run").length;
  const head = [closed.length > 0 ? `closed ${closed.join(", ")}` : "", runs > 0 ? `dismissed ${count(runs, "run")}` : ""].filter(Boolean).join(", ");
  const left = (["in use now", "gone", "failed"] as const)
    .map((r) => [r, outcomes.filter((o) => o.result === r).length] as const)
    .filter(([, n]) => n > 0)
    .map(([r, n]) => `${n} ${r}`);
  return [head || "closed nothing", left.join(", ")].filter(Boolean).join("; ");
}

/** how long after a close an entry still counts as news to a page that had
 *  not read the sweep before its event came */
const FRESH_FOR = 60_000;

/**
 * The log entry an event brings that this page has not seen, or null. The
 * hub sends the whole info on every close, resume and settings change, so
 * the same `lastRun` arrives again and again; only a newer one is news.
 * `seen` is the `at` of the entry the page holds, null when it holds the
 * sweep with no entry, undefined when it never read the sweep, in which
 * case only an entry from the last minute counts.
 */
export function freshEntry(seen: number | null | undefined, entry: SweepLogEntry | null, now: number): SweepLogEntry | null {
  if (!entry) return null;
  if (seen === undefined) return now - entry.at < FRESH_FOR ? entry : null;
  return seen === null || entry.at > seen ? entry : null;
}

/**
 * The agent cards a close ended: for each shell closed, its made card
 * (`shell:<id>`) and every registry card whose `where.canopy.term` names
 * it; for each chat closed or run dismissed, `run:<id>` and the cards whose
 * `where.canopy.run` names it. With `backend`, a registry card counts only
 * when it is on that backend, the one the sweep ran on.
 */
export function endedCards(entry: SweepLogEntry, cards: readonly AgentCard[], backend?: string): Set<string> {
  const out = new Set<string>();
  for (const o of outcomesOf(entry)) {
    if (o.result !== "closed") continue;
    const kind = kindOf(o.key);
    const id = o.key.slice(kind.length + 1);
    const shell = kind === "shell";
    if (!shell && kind !== "chat" && kind !== "run") continue;
    out.add(`${shell ? "shell" : "run"}:${id}`);
    for (const c of cards) {
      const on = c.where.canopy;
      if (!on || (backend !== undefined && on.backend !== backend)) continue;
      if (shell ? on.term === id : on.run === id) out.add(c.id);
    }
  }
  return out;
}

/** A sheet row: an item and, once a close has run over it, how it went. */
export interface SweepRow {
  item: SweepItem;
  outcome?: SweepOutcome;
}

/**
 * What the sheet lists: the plan as it is now and, after a close, the
 * items that close took from it, each with its outcome in place. The hub's
 * new plan no longer has what it closed, so those come from the items the
 * sheet sent; one the plan still has shows as the plan has it.
 */
export function sheetRows(items: readonly SweepItem[], done: { items: readonly SweepItem[]; outcomes: readonly SweepOutcome[] } | null): SweepRow[] {
  const outcome = new Map((done?.outcomes ?? []).map((o) => [o.key, o]));
  const live = new Set(items.map((i) => i.key));
  const rows: SweepRow[] = items.map((item) => {
    const o = outcome.get(item.key);
    return o ? { item, outcome: o } : { item };
  });
  for (const item of done?.items ?? []) {
    const o = outcome.get(item.key);
    if (o && !live.has(item.key)) rows.push({ item, outcome: o });
  }
  return rows;
}
