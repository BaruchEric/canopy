/** The triggers view's model: every shown backend's events in sections, the
 *  words for each state, and the tab's count. Pure; Triggers.tsx draws it. */

import { SERVICE_NAME, eventLive, resumable, retryable, type TriggerEvent, type TriggerStatus, type TriggersInfo } from "../../src/core/trigger";
import type { Badge } from "./badges";

export interface TriggerRow {
  backend: string;
  event: TriggerEvent;
}

export type SectionKey = "needs" | "working" | "review" | "fixed" | "nofix" | "ignored";

export interface TriggerSection {
  key: SectionKey;
  title: string;
  rows: TriggerRow[];
}

const SECTION_OF: Record<TriggerStatus, SectionKey> = {
  waiting: "needs",
  stopped: "needs",
  failed: "needs",
  ready: "needs",
  closed: "needs",
  queued: "working",
  working: "working",
  review: "review",
  merged: "fixed",
  "no-fix": "nofix",
  ignored: "ignored",
};

const SECTIONS: readonly { key: SectionKey; title: string }[] = [
  { key: "needs", title: "Needs you" },
  { key: "working", title: "Working" },
  { key: "review", title: "In review" },
  { key: "fixed", title: "Fixed" },
  { key: "nofix", title: "Nothing to fix" },
  { key: "ignored", title: "Ignored" },
];

export const STATUS_WORD: Record<TriggerStatus, string> = {
  queued: "queued",
  working: "fixing",
  waiting: "asking",
  stopped: "stopped",
  failed: "failed",
  "no-fix": "no fix",
  ready: "committed, no PR",
  review: "PR open",
  merged: "merged",
  closed: "PR closed",
  ignored: "ignored",
};

export const STATUS_TONE: Record<TriggerStatus, "moss" | "lichen" | "rust" | "sky" | "faint"> = {
  queued: "faint",
  working: "sky",
  waiting: "lichen",
  stopped: "lichen",
  failed: "rust",
  "no-fix": "faint",
  ready: "lichen",
  review: "sky",
  merged: "moss",
  closed: "rust",
  ignored: "faint",
};

/** Every shown backend's events, newest first within each section, and
 *  only the sections that hold any. */
export function triggerSections(triggers: Readonly<Record<string, TriggersInfo>>, order: readonly string[]): TriggerSection[] {
  const rows: TriggerRow[] = order.flatMap((backend) => (triggers[backend]?.events ?? []).map((event) => ({ backend, event })));
  rows.sort((a, b) => b.event.lastAt - a.event.lastAt);
  return SECTIONS.map((s) => ({ ...s, rows: rows.filter((r) => SECTION_OF[r.event.status] === s.key) })).filter((s) => s.rows.length > 0);
}

/** The service an event came from: an event written while Sentry was the only one names none. */
export const serviceOf = (e: Pick<TriggerEvent, "service">): string => SERVICE_NAME[e.service ?? "sentry"];

/** The line under an event's title: what became of it past its state. */
export function outcomeLine(e: TriggerEvent): string | null {
  const name = serviceOf(e);
  const linear = e.service === "linear";
  if (e.status === "merged") {
    if (e.source === "manual") return `a test fire, so ${name} was not told`;
    if (!e.resolved) return `merged; the rule holds no token, so the issue stays open in ${name}`;
    if ("at" in e.resolved) return linear ? "Moved to done in Linear" : "Resolved in Sentry";
    return `merged, but ${name} refused ${linear ? "the move to done" : "the resolve"}: ${e.resolved.error}`;
  }
  if (e.status === "review" && e.linked && "error" in e.linked) return `Linear refused the PR's link: ${e.linked.error}`;
  return e.reason ?? null;
}

/** What can be done to an event right now, in the order the row shows them. */
export function eventActs(e: TriggerEvent): ("stop" | "resume" | "retry" | "dismiss")[] {
  const acts: ("stop" | "resume" | "retry" | "dismiss")[] = [];
  if (e.status === "queued" || eventLive(e)) acts.push("stop");
  if (resumable(e)) acts.push("resume");
  if (retryable(e)) acts.push("retry");
  if (e.status !== "queued" && !eventLive(e)) acts.push("dismiss");
  return acts;
}

/** The tab's count: events that need Eric, else the ones going. */
export function triggersBadge(triggers: Readonly<Record<string, Pick<TriggersInfo, "events">>>): Badge | null {
  const events = Object.values(triggers).flatMap((t) => t.events);
  const needs = events.filter((e) => SECTION_OF[e.status] === "needs");
  if (needs.length > 0) {
    return { text: String(needs.length), tone: "rust", title: needs.map((e) => `${e.short ?? e.key}: ${STATUS_WORD[e.status]}`).join("\n") };
  }
  const going = events.filter((e) => e.status === "queued" || eventLive(e));
  if (going.length === 0) return null;
  return { text: String(going.length), tone: "sky", title: `${going.length} ${going.length === 1 ? "fix" : "fixes"} going` };
}

/** The address to paste into Sentry's integration or Linear's webhook: the backend's own origin and the hook's path. */
export const hookAddress = (origin: string, hook: string): string => `${origin.replace(/\/+$/, "")}${hook}`;
