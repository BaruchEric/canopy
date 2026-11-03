/** The triggers' daily line (FR-035, plan 3; the work-until-merged spec,
 *  "Needs you, and the digest"): once a day the lock holder's TriggerHub
 *  writes one line for the inbox's foot, and DMs it to the ranger when the
 *  ranger is on. "3 issues need you: #123 approval, #130 rebase, ENG-4
 *  question; 2 merged yesterday". Pure and browser-safe: the page draws the
 *  line, and its tests check that what the line counts is what the
 *  triggers page puts under Needs you. */

import { DEFAULT_SWEEP } from "./sweep";
import type { TriggerEvent } from "./trigger";

/** when the line is written: the sweep's default hour */
export const DIGEST_CRON = DEFAULT_SWEEP.cron;
/** the issues the line names before it says how many more */
export const DIGEST_LIST = 6;
/** how long the inbox shows a line */
export const DIGEST_SHOWN = 24 * 3_600_000;

/** One day's line, as written. */
export interface TriggerDigest {
  /** unix ms */
  at: number;
  text: string;
  /** the events the line counted as needing Eric, newest first; absent on
   *  a line written before canopy kept them */
  ids?: string[];
}

/** What an event waits on Eric for, in a word or two, or null when it waits
 *  on no one: the same events the triggers page puts under Needs you (a
 *  `needsYou` sentence, or a waiting, stopped, failed, ready, closed or
 *  stalled state). */
export function needWord(e: Pick<TriggerEvent, "status" | "needsYou" | "land">): string | null {
  if (e.status === "stalled") return "stalled";
  const n = e.needsYou;
  if (n !== undefined) {
    if (n.startsWith("it touches files that need your approval")) return "approval";
    // before the rebase words, which this sentence also holds
    if (n.startsWith("the branch has a commit canopy did not push")) return "pushed by hand";
    if (n.startsWith("a review comment")) return "comment";
    if (/rebase|branch moved/.test(n)) return "rebase";
    if (n.startsWith("auto-fix gave up")) return "gave up";
    return "needs you";
  }
  switch (e.status) {
    case "waiting":
      return "question";
    case "stopped":
      return "stopped";
    case "failed":
      return "failed";
    case "ready":
      return e.land === "queue" ? "not landed" : "no PR";
    case "closed":
      return "PR closed";
    default:
      return null;
  }
}

/** The local calendar day before `now`'s, as [from, to) in unix ms. */
export function yesterday(now: number): { from: number; to: number } {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  const to = d.getTime();
  d.setDate(d.getDate() - 1);
  return { from: d.getTime(), to };
}

/** the events that need Eric, with the word for each, newest first */
function needing(events: readonly TriggerEvent[]): { e: TriggerEvent; word: string }[] {
  return events.flatMap((e) => {
    const word = needWord(e);
    return word === null ? [] : [{ e, word }];
  }).sort((a, b) => b.e.lastAt - a.e.lastAt);
}

/** The ids of the events the day's line counts as needing Eric, in its
 *  order, kept with the line so the inbox knows when they stop waiting. */
export const digestIds = (events: readonly TriggerEvent[]): string[] => needing(events).map(({ e }) => e.id);

/** The day's line over every event kept, or null when nothing needs Eric
 *  and nothing merged yesterday: the newest that need him first, named by
 *  the issue's id and what it needs, and how many merged on the local day
 *  before `now`. */
export function digestLine(events: readonly TriggerEvent[], now: number): string | null {
  const needs = needing(events);
  const day = yesterday(now);
  const merged = events.filter((e) => e.status === "merged" && e.endedAt !== undefined && e.endedAt >= day.from && e.endedAt < day.to).length;
  if (needs.length === 0 && merged === 0) return null;
  const named = needs.slice(0, DIGEST_LIST).map(({ e, word }) => `${e.short ?? e.key} ${word}`);
  const more = needs.length > DIGEST_LIST ? ` and ${needs.length - DIGEST_LIST} more` : "";
  const head = needs.length === 0 ? "nothing needs you" : `${needs.length} ${needs.length === 1 ? "issue needs" : "issues need"} you: ${named.join(", ")}${more}`;
  return `${head}; ${merged === 0 ? "none" : merged} merged yesterday`;
}

/** The DM the ranger gets with the day's line. */
export const rangerDigest = (text: string): string => `[digest] canopy's daily line on trigger issues: ${text}`;

/** Whether the inbox still shows a line: under a day old. */
export const digestShown = (d: Pick<TriggerDigest, "at">, now: number): boolean => now - d.at < DIGEST_SHOWN;

/** Whether a line still says something true: it counted nothing waiting
 *  (its news is what merged), or one of the events it counted still waits
 *  on Eric. A line whose events were all resumed, fixed or dismissed would
 *  only send him to an empty Needs you. A line kept without ids stands. */
export function digestStands(d: Pick<TriggerDigest, "ids">, events: readonly TriggerEvent[]): boolean {
  if (d.ids === undefined || d.ids.length === 0) return true;
  const named = new Set(d.ids);
  return events.some((e) => named.has(e.id) && needWord(e) !== null);
}
