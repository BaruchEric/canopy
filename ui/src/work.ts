/** The work view's model (FR-037): every shown backend's items as rows, in
 *  sections with the ones that need Eric first, the repo filter and the
 *  search, and the tab's count. Pure; Work.tsx and WorkBlock.tsx draw it. */

import { sentBack } from "../../src/core/landing";
import type { TriggersInfo } from "../../src/core/trigger";
import type { LandingInfo } from "../../src/core/types";
import type { WorkInfo, WorkItem, WorkNote, WorkState } from "../../src/core/work";
import type { Badge } from "./badges";

export interface WorkRow {
  backend: string;
  item: WorkItem;
  /** why it waits on Eric, else null */
  needs: string | null;
}

export type WorkSectionKey = "needs" | "working" | "review" | "open" | "closed";

export interface WorkSection {
  key: WorkSectionKey;
  title: string;
  rows: WorkRow[];
  /** the section opens folded: the landed and dropped */
  folded?: true;
}

/** how long a landed or dropped item stays in the folded section */
export const CLOSED_DAYS = 30;

/** what the page knows beyond the ledger, by backend: ids under the page's own names */
export interface WorkFacts {
  landing: Readonly<Record<string, LandingInfo>>;
  triggers: Readonly<Record<string, Pick<TriggersInfo, "events">>>;
  /** an id as this page holds it: the backend's name over the backend's own id */
  qual: (backend: string, id: string) => string;
}

const SECTIONS: readonly { key: WorkSectionKey; title: string; folded?: true }[] = [
  { key: "needs", title: "Needs you" },
  { key: "working", title: "Working" },
  { key: "review", title: "In review" },
  { key: "open", title: "Open" },
  { key: "closed", title: "Landed and dropped, last 30 days", folded: true },
];

/** the row's edge colour per state; a row that needs Eric is rust whatever its state */
export const STATE_TONE: Readonly<Record<WorkState, string>> = {
  open: "",
  working: "sky",
  review: "lichen",
  landed: "moss",
  dropped: "",
};

/** Why an open item waits on Eric: a branch whose sort says approve, one
 *  sent back with no fix going, or a trigger event that names what it needs
 *  (FR-035). Null when nothing does. */
export function needsOf(backend: string, item: WorkItem, facts: WorkFacts): string | null {
  if (item.closedAt !== undefined) return null;
  const landing = facts.landing[backend];
  const branches = new Set(item.branches.map((id) => facts.qual(backend, id)));
  for (const entry of landing?.entries ?? []) {
    if (!branches.has(entry.id) || !sentBack(entry) || entry.fixing !== undefined) continue;
    return `sent back: ${entry.reason ?? entry.state}`;
  }
  const queued = new Set((landing?.entries ?? []).map((entry) => entry.id));
  for (const rec of landing?.runs ?? []) {
    if (!branches.has(rec.id) || queued.has(rec.id) || rec.pr !== undefined) continue;
    if (rec.state === "ready" && rec.review?.verdict === "approve") return "its sort says approve: look and land";
  }
  const events = new Set(item.events.map((id) => facts.qual(backend, id)));
  for (const event of facts.triggers[backend]?.events ?? []) {
    if (events.has(event.id) && event.needsYou !== undefined) return event.needsYou;
  }
  return null;
}

/** Every shown backend's items as rows, newest change first. */
export function workRows(work: Readonly<Record<string, WorkInfo>>, order: readonly string[], facts: WorkFacts): WorkRow[] {
  const rows = order.flatMap((backend) => (work[backend]?.items ?? []).map((item) => ({ backend, item, needs: needsOf(backend, item, facts) })));
  rows.sort((a, b) => b.item.updatedAt - a.item.updatedAt);
  return rows;
}

const sectionOf = (row: WorkRow, now: number): WorkSectionKey | null => {
  const { item } = row;
  if (item.state === "landed" || item.state === "dropped") {
    return now - (item.closedAt ?? item.updatedAt) <= CLOSED_DAYS * 86_400_000 ? "closed" : null;
  }
  if (row.needs !== null) return "needs";
  return item.state;
};

/** The rows in their sections, empty ones left out; a closed item older
 *  than CLOSED_DAYS shows nowhere. */
export function workSections(rows: readonly WorkRow[], now = Date.now()): WorkSection[] {
  return SECTIONS.map((s) => ({ ...s, rows: rows.filter((row) => sectionOf(row, now) === s.key) })).filter((s) => s.rows.length > 0);
}

/** The rows on one repo, by the page's id for it; every row with none. */
export function onRepo(rows: readonly WorkRow[], repo: string | null, qual: WorkFacts["qual"]): WorkRow[] {
  if (repo === null) return [...rows];
  return rows.filter((row) => row.item.repos.some((id) => qual(row.backend, id) === repo));
}

/** The rows whose title, id, repos or notes hold every word of the search. */
export function searchWork(rows: readonly WorkRow[], query: string): WorkRow[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [...rows];
  return rows.filter((row) => {
    const { item } = row;
    const text = [item.title, item.id, ...item.repos, ...item.notes.map((note) => `${note.by} ${note.text}`)].join("\n").toLowerCase();
    return words.every((word) => text.includes(word));
  });
}

/** The repos the rows name, as the page's ids, each once and in order of appearance. */
export function reposOf(rows: readonly WorkRow[], qual: WorkFacts["qual"]): string[] {
  const seen = new Set<string>();
  for (const row of rows) for (const id of row.item.repos) seen.add(qual(row.backend, id));
  return [...seen];
}

/** The newest notes, newest last, as the run sheet's block and a row show them. */
export const lastNotes = (item: Pick<WorkItem, "notes">, n = 2): WorkNote[] => item.notes.slice(-n);

/** the view's tab count: the items that need Eric, rust, else the working ones, sky */
export function workBadge(rows: readonly WorkRow[]): Badge | null {
  const needs = rows.filter((row) => row.needs !== null && row.item.closedAt === undefined);
  if (needs.length > 0) return { text: String(needs.length), tone: "rust", title: needs.map((row) => `${row.item.title}: ${row.needs}`).join("\n") };
  const working = rows.filter((row) => row.item.state === "working");
  if (working.length > 0) return { text: String(working.length), tone: "sky", title: working.map((row) => row.item.title).join("\n") };
  return null;
}
