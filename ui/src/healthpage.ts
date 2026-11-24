/**
 * The health page (FR-087): every backend's checks as a chart recorder.
 * A verdict, what is in trouble, each check's states over one shared
 * window on every backend, and the changes. A server keeps a check's
 * history in memory (core/health.ts, HISTORY_MAX changes), so a record
 * starts when its backend last started and the page never guesses what
 * came before. Pure; tested in healthpage.test.ts.
 */

import { HISTORY_MAX, isBad } from "../../src/core/health";
import type { HealthCheck, HealthState } from "../../src/core/types";
import { awayWhy, SERVER_TITLE, span, type ConnLike } from "./health";

/** one stretch of a record: the state held from `from` to `to` */
export interface Stretch {
  from: number;
  to: number;
  state: HealthState;
  why: string | null;
}

/** A check's states between `from` and `to`, from its history; nothing
 *  before its first record. The last stretch carries the check's own why,
 *  which a probe refreshes without a new history entry. */
export function record(check: HealthCheck, from: number, to: number): Stretch[] {
  const events = check.history.length > 0 ? check.history : check.state === "unknown" ? [] : [{ at: check.since, state: check.state, why: check.why }];
  const out: Stretch[] = [];
  events.forEach((e, i) => {
    const next = events[i + 1];
    const start = Math.max(e.at, from);
    const end = Math.min(next ? next.at : to, to);
    const why = !next && e.state === check.state ? (check.why ?? e.why) : e.why;
    if (end > start) out.push({ from: start, to: end, state: e.state, why });
  });
  return out;
}

/** how much a state weighs when several checks share one line: off never
 *  counts, trouble outweighs everything */
const WEIGHT: Record<HealthState, number> = { off: 0, ok: 1, unknown: 2, healing: 2, down: 3, "gave-up": 3 };

/** The worst state of several records at every moment, as one record: a
 *  backend's pulse. A moment no record covers is left out. */
export function worstOf(records: readonly (readonly Stretch[])[]): Stretch[] {
  const cuts = [...new Set(records.flatMap((r) => r.flatMap((s) => [s.from, s.to])))].sort((a, b) => a - b);
  const out: Stretch[] = [];
  for (let i = 0; i + 1 < cuts.length; i++) {
    const a = cuts[i] as number;
    const b = cuts[i + 1] as number;
    let worst: Stretch | null = null;
    for (const r of records) {
      const s = r.find((x) => x.from <= a && x.to >= b);
      if (s && (!worst || WEIGHT[s.state] > WEIGHT[worst.state])) worst = s;
    }
    if (!worst) continue;
    const last = out[out.length - 1];
    if (last && last.to === a && last.state === worst.state) last.to = b;
    else out.push({ from: a, to: b, state: worst.state, why: worst.why });
  }
  return out;
}

/** the stretch a record holds at `t`, or null where it has none */
export const stretchAt = (r: readonly Stretch[], t: number): Stretch | null => r.find((s) => s.from <= t && t <= s.to) ?? null;

export interface PageBackend {
  name: string;
  /** why the page cannot reach it, or null while it can */
  away: string | null;
  /** its checks; none while it is away, since what it last said means nothing then */
  checks: HealthCheck[];
  /** its first record, about when its server last started */
  since: number | null;
}

/** every shown backend, in the page's order */
export function pageBackends(health: Readonly<Record<string, readonly HealthCheck[]>>, order: readonly string[], conns: Readonly<Record<string, ConnLike>>): PageBackend[] {
  return order.map((name) => {
    const conn = conns[name];
    if (conn?.status.state !== "online") return { name, away: awayWhy(conn), checks: [], since: null };
    const checks = [...(health[name] ?? [])];
    const starts = checks.map((c) => c.history[0]?.at ?? (c.state === "unknown" ? null : c.since)).filter((t): t is number => t !== null);
    return { name, away: null, checks, since: starts.length > 0 ? Math.min(...starts) : null };
  });
}

/** the page's window: back to the oldest record, so the tapes spend their
 *  width on what was seen, at least two minutes and at most a day */
export const WINDOW_MIN = 2 * 60_000;
export const WINDOW_MAX = 24 * 3_600_000;

export function pageWindow(backends: readonly PageBackend[], now: number): { from: number; to: number } {
  const starts = backends.map((b) => b.since).filter((t): t is number => t !== null);
  const first = starts.length > 0 ? Math.min(...starts) : now - WINDOW_MIN;
  const width = Math.min(WINDOW_MAX, Math.max(WINDOW_MIN, now - first));
  return { from: now - width, to: now };
}

/** One check across backends: a row of the matrix. A backend with no cell
 *  does not run that check, which is not the same as running it off. */
export interface PageRow {
  key: string;
  label: string;
  /** what the row's section is called, for a row shown away from it */
  where: string;
  cells: Record<string, HealthCheck>;
}

export interface PageSection {
  key: string;
  title: string;
  repo: boolean;
  rows: PageRow[];
}

const sectionKey = (c: HealthCheck, repoName: (repoId: string) => string): { key: string; title: string; repo: boolean } => {
  if (c.scope.kind === "canopy") return { key: "server", title: SERVER_TITLE, repo: false };
  const title = repoName(c.scope.repoId);
  return { key: `repo\u0000${title}`, title, repo: true };
};

/** The matrix: the server's own checks, then each repo by name, each check
 *  a row across backends, joined by its section and label since a repo's
 *  id differs from one backend to the next. Rows off wherever they run go
 *  to `off`, at the foot of the page. */
export function pageSections(backends: readonly PageBackend[], repoName: (repoId: string) => string): { sections: PageSection[]; off: PageRow[] } {
  const sections = new Map<string, PageSection>();
  for (const b of backends) {
    for (const c of b.checks) {
      const s = sectionKey(c, repoName);
      let sec = sections.get(s.key);
      if (!sec) {
        sec = { ...s, rows: [] };
        sections.set(s.key, sec);
      }
      const key = `${s.key}\u0000${c.label}`;
      let row = sec.rows.find((r) => r.key === key);
      if (!row) {
        row = { key, label: c.label, where: s.title, cells: {} };
        sec.rows.push(row);
      }
      row.cells[b.name] = c;
    }
  }
  const off: PageRow[] = [];
  const out: PageSection[] = [];
  for (const sec of sections.values()) {
    const live = sec.rows.filter((r) => Object.values(r.cells).some((c) => c.state !== "off"));
    off.push(...sec.rows.filter((r) => !live.includes(r)));
    if (live.length > 0) out.push({ ...sec, rows: live.sort((a, b) => a.label.localeCompare(b.label)) });
  }
  out.sort((a, b) => Number(a.repo) - Number(b.repo) || a.title.localeCompare(b.title));
  off.sort((a, b) => a.label.localeCompare(b.label) || a.where.localeCompare(b.where));
  return { sections: out, off };
}

/** a check that has not answered for this long is in trouble too */
const QUIET_AFTER = 60_000;

export interface Trouble {
  backend: string;
  where: string;
  /** its row's key in the matrix */
  row: string;
  check: HealthCheck;
}

const troubled = (c: HealthCheck, now: number): boolean => isBad(c) || c.state === "healing" || (c.state === "unknown" && now - c.since > QUIET_AFTER);

/** Every check down, given up, healing or long silent, the worst first */
export function troubles(backends: readonly PageBackend[], repoName: (repoId: string) => string, now: number): Trouble[] {
  const out: (Trouble & { at: number })[] = [];
  backends.forEach((b, at) => {
    for (const c of b.checks) {
      if (!troubled(c, now)) continue;
      const s = sectionKey(c, repoName);
      out.push({ backend: b.name, where: s.title, row: `${s.key}\u0000${c.label}`, check: c, at });
    }
  });
  out.sort((x, y) => WEIGHT[y.check.state] - WEIGHT[x.check.state] || x.at - y.at || x.check.label.localeCompare(y.check.label));
  return out.map(({ at: _at, ...t }) => t);
}

/** "mac", "mac and mini", "mac, mini and desoto" */
export function listWords(names: readonly string[]): string {
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

const checks = (n: number) => `${n} ${n === 1 ? "check" : "checks"}`;
const are = (n: number) => (n === 1 ? "is" : "are");

export interface Verdict {
  level: "ok" | "warn" | "bad";
  head: string;
  sub: string;
}

/** The page's first line: whether anything needs you, and how much is watched */
export function verdict(backends: readonly PageBackend[], trouble: readonly Trouble[]): Verdict {
  const here = backends.filter((b) => b.away === null);
  const gone = backends.filter((b) => b.away !== null && b.away !== "connecting").map((b) => b.name);
  const coming = backends.filter((b) => b.away === "connecting").map((b) => b.name);
  const all = here.flatMap((b) => b.checks);
  const off = all.filter((c) => c.state === "off").length;
  const live = all.length - off;
  const bad = trouble.filter((t) => isBad(t.check)).length;
  const healing = trouble.filter((t) => t.check.state === "healing").length;
  const quiet = trouble.length - bad - healing;
  const parts: string[] = [];
  parts.push(here.length > 0 ? `${checks(live)} on ${listWords(here.map((b) => b.name))}${off > 0 ? `, and ${off} more ${are(off)} off` : ""}.` : "No backend is answering.");
  if (gone.length > 0 && bad > 0) parts.push(`${listWords(gone)} ${gone.length === 1 ? "is" : "are"} offline.`);
  if (coming.length > 0) parts.push(`Still reaching ${listWords(coming)}.`);
  const sub = parts.join(" ");
  if (bad > 0) return { level: "bad", head: `${checks(bad)} ${are(bad)} down`, sub };
  if (gone.length > 0) return { level: "bad", head: `${listWords(gone)} ${gone.length === 1 ? "is" : "are"} offline`, sub };
  if (healing > 0 && quiet === 0) return { level: "warn", head: `${checks(healing)} ${are(healing)} healing`, sub };
  if (healing + quiet > 0) return { level: "warn", head: `${checks(healing + quiet)} ${healing + quiet === 1 ? "has" : "have"} not settled`, sub };
  if (coming.length > 0 && here.length === 0) return { level: "warn", head: "Reaching the backends", sub };
  return { level: "ok", head: "Every check is well", sub };
}

/** A backend's word at the end of its pulse */
export function backendWord(b: PageBackend, now: number): { text: string; tone: "moss" | "lichen" | "rust" | "faint" } {
  if (b.away === "connecting") return { text: "connecting", tone: "lichen" };
  if (b.away !== null) return { text: b.away, tone: "rust" };
  const bad = b.checks.filter(isBad).length;
  if (bad > 0) return { text: `${bad} down`, tone: "rust" };
  const unsettled = b.checks.filter((c) => troubled(c, now)).length;
  if (unsettled > 0) return { text: `${unsettled} healing`, tone: "lichen" };
  if (b.checks.length === 0) return { text: "no checks", tone: "faint" };
  return { text: "all well", tone: "moss" };
}

/** The cell's word: nothing while ok, since the line already says so */
export function cellWord(c: HealthCheck, now: number): string {
  switch (c.state) {
    case "ok":
      return "";
    case "off":
      return "off";
    case "down":
      return `down ${span(now - c.since)}`;
    case "gave-up":
      return "gave up";
    case "healing":
      return "healing";
    case "unknown":
      return "checking";
  }
}

/** one state change of one check, for the log */
export interface Change {
  at: number;
  backend: string;
  where: string;
  label: string;
  from: HealthState | null;
  to: HealthState;
  why: string | null;
}

/** Every recorded change, the newest first. A check's first reading when
 *  its server started (ok or off) is where its record begins, not a change. */
export function changes(backends: readonly PageBackend[], repoName: (repoId: string) => string): Change[] {
  const out: Change[] = [];
  for (const b of backends) {
    for (const c of b.checks) {
      const where = sectionKey(c, repoName).title;
      c.history.forEach((e, i) => {
        const from = i > 0 ? (c.history[i - 1]?.state ?? null) : null;
        const whole = c.history.length < HISTORY_MAX;
        if (i === 0 && whole && (e.state === "ok" || e.state === "off")) return;
        out.push({ at: e.at, backend: b.name, where, label: c.label, from, to: e.state, why: e.why });
      });
    }
  }
  return out.sort((a, b) => b.at - a.at || a.label.localeCompare(b.label));
}

/** what a change did, as a verb: "went down", "came back" */
export function changeWord(c: Pick<Change, "from" | "to">): string {
  switch (c.to) {
    case "ok":
      return c.from === null ? "started ok" : c.from === "off" ? "came on" : "came back";
    case "down":
      return c.from === null ? "started down" : "went down";
    case "gave-up":
      return "gave up";
    case "healing":
      return "healing";
    case "off":
      return "turned off";
    case "unknown":
      return "checking";
  }
}
