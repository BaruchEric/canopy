/** The triggers view's model: every shown backend's events in sections, the
 *  words for each state, and the tab's count. Pure; Triggers.tsx draws it. */

import { SERVICE_NAME, eventLive, resumable, retryable, type TriggerEvent, type TriggerRuleInfo, type TriggerStatus, type TriggersInfo } from "../../src/core/trigger";
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
  rebasing: "working",
  conflict: "working",
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
  rebasing: "rebasing onto main",
  conflict: "fixing a rebase conflict",
  merged: "merged",
  closed: "PR closed",
  ignored: "ignored",
};

export function statusWord(e: Pick<TriggerEvent, "status" | "land">): string {
  return e.status === "ready" && e.land === "queue" ? "in the landing queue" : STATUS_WORD[e.status];
}

export const STATUS_TONE: Record<TriggerStatus, "moss" | "lichen" | "rust" | "sky" | "faint"> = {
  queued: "faint",
  working: "sky",
  waiting: "lichen",
  stopped: "lichen",
  failed: "rust",
  "no-fix": "faint",
  ready: "lichen",
  review: "sky",
  rebasing: "sky",
  conflict: "sky",
  merged: "moss",
  closed: "rust",
  ignored: "faint",
};

/** The section an event sits in: Needs you while its PR waits on Eric
 *  (`needsYou`), else the one its state names. */
const sectionOf = (e: Pick<TriggerEvent, "status" | "needsYou">): SectionKey => (e.needsYou !== undefined ? "needs" : SECTION_OF[e.status]);

/** Every shown backend's events, newest first within each section, and
 *  only the sections that hold any. */
export function triggerSections(triggers: Readonly<Record<string, TriggersInfo>>, order: readonly string[]): TriggerSection[] {
  const rows: TriggerRow[] = order.flatMap((backend) => (triggers[backend]?.events ?? []).map((event) => ({ backend, event })));
  rows.sort((a, b) => b.event.lastAt - a.event.lastAt);
  return SECTIONS.map((s) => ({ ...s, rows: rows.filter((r) => sectionOf(r.event) === s.key) })).filter((s) => s.rows.length > 0);
}

/** The service an event came from: an event written while Sentry was the only one names none. */
export const serviceOf = (e: Pick<TriggerEvent, "service">): string => SERVICE_NAME[e.service ?? "sentry"];

/** The line under an event's title: what became of it past its state. */
export function outcomeLine(e: TriggerEvent): string | null {
  if (e.needsYou !== undefined) return e.needsYou;
  const name = serviceOf(e);
  const linear = e.service === "linear";
  const forge = e.service === "github" || e.service === "forgejo";
  if (e.status === "merged") {
    if (e.service === "schedule") return e.pr ? null : "landed on main through the queue";
    if (e.source === "manual") return `a test fire, so ${name} was not told`;
    if (!e.resolved) return `merged; the rule ${forge ? "does not write back" : "holds no token"}, so the issue stays open in ${name}`;
    if ("at" in e.resolved) return forge ? `Closed in ${name}` : linear ? "Moved to done in Linear" : "Resolved in Sentry";
    return `merged, but ${name} refused ${forge ? "the close" : linear ? "the move to done" : "the resolve"}: ${e.resolved.error}`;
  }
  if (e.status === "review" && e.linked && "error" in e.linked) return `${name} refused the PR's link: ${e.linked.error}`;
  return e.reason ?? null;
}

/** Whether a rule writes back to its service, the words the rule's card
 *  shows for that, and why. A GitHub or Forgejo rule writes as gh's login
 *  or with the forge's token unless its `write` is off; a Sentry or Linear
 *  rule needs its token, or the Linear app's. */
export function ruleWrites(rule: Pick<TriggerRuleInfo, "source" | "write" | "tokenSet" | "agentSet">): { on: boolean; words: string; why: string } {
  const name = SERVICE_NAME[rule.source];
  const forge = rule.source === "github" || rule.source === "forgejo";
  const on = forge ? rule.write !== false : rule.tokenSet || rule.agentSet;
  const why =
    rule.source === "github"
      ? "canopy comments the PR's link on the issue, or why a run ended without one, and closes it once the PR merges; write: false in the rule turns this off"
      : rule.source === "forgejo"
        ? "canopy comments on the issue when a run ends without a fix, and closes it once its branch lands; write: false in the rule turns this off"
        : rule.source === "linear"
          ? "A Linear API key, or the Linear app's own token, lets canopy put the PR's link on the issue and move it to done once the fix merges"
          : "A Sentry token lets canopy mark the issue resolved once the fix merges";
  const words = on ? (rule.source === "sentry" ? "resolves in Sentry" : `writes back to ${name}`) : `leaves issues open in ${name}`;
  return { on, words, why };
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
  const needs = events.filter((e) => sectionOf(e) === "needs");
  if (needs.length > 0) {
    return { text: String(needs.length), tone: "rust", title: needs.map((e) => `${e.short ?? e.key}: ${e.needsYou ?? statusWord(e)}`).join("\n") };
  }
  const going = events.filter((e) => e.status === "queued" || eventLive(e));
  if (going.length === 0) return null;
  return { text: String(going.length), tone: "sky", title: `${going.length} ${going.length === 1 ? "fix" : "fixes"} going` };
}

/** The address to paste into the service's webhook settings: the backend's own origin and the hook's path. */
export const hookAddress = (origin: string, hook: string): string => `${origin.replace(/\/+$/, "")}${hook}`;

const EVERY = /^\*\/(\d+)$/;

/** The words for a rule's poll line: the common every-N-minutes and
 *  every-N-hours lines read as such, any other as the cron line itself. */
export function pollWords(cron: string): string {
  const line = cron.trim();
  const [min = "", hour = "", dom = "", mon = "", dow = ""] = line.split(/\s+/);
  const daily = dom === "*" && mon === "*" && dow === "*";
  if (daily && hour === "*") {
    if (min === "*" || min === "*/1") return "polls every minute";
    const m = EVERY.exec(min);
    if (m) return `polls every ${m[1]} min`;
  }
  if (daily && min === "0") {
    if (hour === "*" || hour === "*/1") return "polls every hour";
    const h = EVERY.exec(hour);
    if (h) return `polls every ${h[1]} hours`;
  }
  return `polls on ${line}`;
}

/** How a rule's issues reach canopy: the hook's address when the rule has
 *  a secret (a Sentry or Linear rule always has), and the poll's words when
 *  it polls. A GitHub or Forgejo rule with both has the poll as its safety net. */
export function ruleIntake(rule: Pick<TriggerRuleInfo, "hook" | "secretEnv" | "poll">, origin: string): { hook: string | null; poll: string | null } {
  return { hook: rule.secretEnv && rule.hook ? hookAddress(origin, rule.hook) : null, poll: rule.poll ? pollWords(rule.poll) : null };
}

export function scheduleWord(rule: Pick<TriggerRuleInfo, "repo" | "only">, repoName: string): string {
  const words = { "spec-adopted": "with a spec", dirty: "with changes", unpushed: "with unpushed commits", clean: "with a clean tree" };
  return `${rule.repo === "*" ? "every local repo" : repoName}${rule.only.length ? ` ${rule.only.map((only) => words[only]).join(", ")}` : ""}`;
}

export function nextFireWord(next: number | undefined, now: number): string {
  if (next === undefined) return "never fires again";
  if (next <= now) return "due now";
  const minutes = Math.floor((next - now) / 60_000);
  if (minutes < 60) return `next fire in ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return hours < 48 ? `next fire in ${hours} h` : `next fire in ${Math.floor(hours / 24)} days`;
}
