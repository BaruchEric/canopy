/** The sweep sheet's pure half (FR-018): the plan grouped by kind, the
 *  picks it starts with, a close's outcomes in one line for the sheet and
 *  the feed, and which agent cards a close ended, so their panels and
 *  windows close with them. Tested in sweep.test.ts. */

import { mayClose } from "../../src/core/sweep";
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

/** What a close picked is no longer picked once the close is back: the
 *  picks as they stand (the defaults over `items` when none were changed)
 *  less the keys it sent, so a second close does not count them again. */
export function dropPicks(picks: ReadonlySet<string> | null, items: readonly SweepItem[], sent: readonly string[]): Set<string> {
  const next = new Set(picks ?? defaultPicks(items));
  for (const k of sent) next.delete(k);
  return next;
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

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** a number with at most `places` decimals, trailing zeros dropped */
const trim = (n: number, places: number): string => String(Number(n.toFixed(places)));

/**
 * A span as the ask's title says it: whole days from two days up ("14+
 * days"), hours from an hour ("24+ hours", "1.5+ hours"), minutes below
 * that, never fewer than one ("2+ minutes").
 */
export function spanWord(ms: number): string {
  const plus = (n: string, unit: string) => `${n}+ ${unit}${n === "1" ? "" : "s"}`;
  if (ms >= 2 * DAY && ms % DAY === 0) return plus(String(ms / DAY), "day");
  if (ms >= HOUR) return plus(trim(ms / HOUR, 1), "hour");
  return plus(String(Math.max(1, Math.round(ms / MINUTE))), "minute");
}

/** each kind's noun in the ask's title, one and many */
const ASK_NOUN: Record<SweepKind, [string, string]> = {
  shell: ["shell", "shells"],
  chat: ["chat", "chats"],
  run: ["finished run", "finished runs"],
  pr: ["PR", "PRs"],
  outside: ["outside agent", "outside agents"],
};

/** The scheduled fire's ask as one line: `"Sweep: 3 PRs idle 14+ days"`,
 *  a kind at a time in the sweep's order when it holds several, each with
 *  its own span from the settings. */
export function askTitle(items: readonly SweepItem[], spans: Readonly<Record<SweepKind, number>>): string {
  const parts = groupItems(items).map(({ kind, items: of }) => `${count(of.length, ...ASK_NOUN[kind])} idle ${spanWord(spans[kind])}`);
  return `Sweep: ${parts.join(", ")}`;
}

/** What "close all" on the ask sends: every key it may close (`mayClose`),
 *  ticked in the sheet or not, as a PR is not. The server answers a key
 *  held for the hand with "in use now", so a shell that has started a
 *  program since the fire is left for the sheet, where Eric can tick it. */
export function askCloses(items: readonly SweepItem[]): string[] {
  return items.filter(mayClose).map((i) => i.key);
}

/** Whether an answer to the ask, or its dismiss, failed only because no
 *  ask is pending: a 404, as when another device answered it first. That
 *  is done, not an error. A 400 (a key a newer fire's ask does not hold)
 *  stays an error, since the ask on screen is not the one pending. */
export function askGone(err: unknown): boolean {
  return err instanceof Error && (err as Error & { status?: unknown }).status === 404;
}

/** What the ask's "pick" starts the sheet with ticked: the same items
 *  "close all" would send, so a shell running a program starts unticked
 *  in the sheet too, where Eric can still tick it by hand. */
export function pickKeys(items: readonly SweepItem[]): string[] {
  return askCloses(items);
}

/** The auto kinds with `kind` added or dropped, in the sweep's order:
 *  computed over the newest settings the row holds, so two quick toggles
 *  each keep the other's change. */
export function nextAuto(cur: readonly SweepKind[], kind: SweepKind, on: boolean): SweepKind[] {
  return SWEEP_KINDS.filter((k) => (k === kind ? on : cur.includes(k)));
}

export type SpanUnit = "hours" | "days";

/** A span as the settings row shows it: in `unit` when the row has one
 *  picked, else whole days in days and anything else in hours; a span
 *  under an hour is a fraction of one (four places, and never rounded down
 *  to nothing). */
export function spanParts(ms: number, unit?: SpanUnit): { value: string; unit: SpanUnit } {
  const u: SpanUnit = unit ?? (ms >= DAY && ms % DAY === 0 ? "days" : "hours");
  const n = ms / (u === "days" ? DAY : HOUR);
  const value = trim(n, 4);
  return { value: value === "0" ? String(n) : value, unit: u };
}

/** what was typed in a span's box, in ms; null unless that comes to a
 *  finite number of ms above nought */
export function spanMs(typed: string, unit: SpanUnit): number | null {
  const t = typed.trim();
  const n = t === "" ? Number.NaN : Number(t);
  const ms = Math.round(n * (unit === "days" ? DAY : HOUR));
  // a number that rounds to nothing, or runs past what a number holds, is no span
  return Number.isFinite(ms) && ms > 0 ? ms : null;
}

/**
 * A span's unit switched in the settings row: the span stays as it is and
 * shows in the new unit (`spanParts(ms, to)`), so nothing is saved, and a
 * number typed and not yet saved is converted with it, to be saved on blur
 * or Enter as any edit. Typed text that is no span stays as it was.
 */
export function switchUnit(typed: string | undefined, from: SpanUnit, to: SpanUnit): { unit: SpanUnit; typed: string | undefined } {
  if (typed === undefined) return { unit: to, typed: undefined };
  const was = spanMs(typed, from);
  return { unit: to, typed: was === null ? typed : spanParts(was, to).value };
}
