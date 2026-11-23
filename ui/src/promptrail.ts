/** The prompt rail's arithmetic (FR-078): the messages a person sent in a
 *  run as the rail down its timeline's edge lists them, each with its first
 *  words, the first words of the reply and its place, and the rail's small
 *  decisions: which tick is marked, where a step from the keyboard lands,
 *  how far a jump scrolls and which timeline the keys steer.
 *  Pure; PromptRail.tsx holds the observers and does the scrolling. */

import type { RunStep } from "../../src/core/types";

/** a rail shows from the second message on: one message is nowhere to go */
export const RAIL_MIN = 2;
/** how much of a message, and of the reply after it, a tick's card holds */
export const RAIL_LABEL = 90;
export const RAIL_REPLY = 180;
/** How near the end counts as the end, px: the same 48 the timeline's own
 *  scroll handler follows its newest step within. */
export const FOLLOW_SLACK = 48;

export interface RailItem {
  /** the message's step id, which its element in the timeline carries as `data-prompt` */
  id: string;
  /** its place among the messages, from 1 */
  n: number;
  /** the message's first words */
  label: string;
  /** the first words the agent said after it, "" when it has said none */
  reply: string;
}

/** `text` on one line, cut at a word where one is near, with an ellipsis */
export function firstWords(text: string, max: number): string {
  const one = text.replace(/\s+/g, " ").trim();
  if (one.length <= max) return one;
  const cut = one.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/** The rail's items: every message the person sent, in order. The reply is
 *  the agent's first words before the next message; a subagent's steps are
 *  neither a message nor a reply. */
export function railItems(steps: readonly RunStep[]): RailItem[] {
  const items: RailItem[] = [];
  let open: RailItem | null = null;
  for (const step of steps) {
    if (step.parent) continue;
    if (step.kind === "user") {
      open = { id: step.id, n: items.length + 1, label: firstWords(step.text ?? "", RAIL_LABEL), reply: "" };
      items.push(open);
    } else if (step.kind === "text" && open && !open.reply) {
      open.reply = firstWords(step.text ?? "", RAIL_REPLY);
    }
  }
  return items;
}

/** "49 of 96" */
export const railPlace = (n: number, total: number): string => `${n} of ${total}`;

/** a tick's name for a screen reader: its place, then the message's first words */
export const tickLabel = (item: Pick<RailItem, "n" | "label">, total: number): string =>
  `Message ${railPlace(item.n, total)}${item.label ? `: ${item.label}` : ""}`;

/** Which message is marked, from 0, or -1 with none. `passed` counts the
 *  messages that have reached the reading line or scrolled above it, so
 *  the last of them is the one being read. At the end of the timeline the
 *  newest message is, wherever it sits. A jump's own target (`held`) wins
 *  until the view next moves: a message crosses the line, or the
 *  timeline's end comes or goes. */
export function railMarked(v: { total: number; passed: number; atEnd: boolean; held: number | null }): number {
  if (v.total <= 0) return -1;
  const last = v.total - 1;
  if (v.held !== null && v.held >= 0 && v.held <= last) return v.held;
  if (v.atEnd) return last;
  return Math.max(0, Math.min(last, v.passed - 1));
}

/** Where a step from the marked message lands: the message before or
 *  after, by its index, or "end" for the newest step once the last message
 *  is behind. A step back from a message that has scrolled out above goes
 *  to that message first, since its top is the nearest one before the view. */
export function railStep(v: { marked: number; dir: 1 | -1; total: number; above: boolean }): number | "end" | null {
  if (v.total <= 0) return null;
  const from = Math.max(0, Math.min(v.total - 1, v.marked));
  if (v.dir === -1) return v.above ? from : Math.max(0, from - 1);
  return from + 1 >= v.total ? "end" : from + 1;
}

/** How far a jump scrolls: `wanted` held inside what the timeline can
 *  scroll (`max`, its scroll height less its own), and whether the timeline
 *  follows its newest step from there, which it does when the jump lands at
 *  the end. */
export function jumpTop(wanted: number, max: number): { top: number; follow: boolean } {
  const room = Math.max(0, max);
  const top = Math.max(0, Math.min(room, wanted));
  return { top, follow: room - top < FOLLOW_SLACK };
}

/** How far up its own height a tick's card slides, as a percent: none at
 *  the rail's top, all of it at the foot and half in the middle, so the
 *  card stays beside its tick and inside the rail without being measured. */
export function cardSlide(center: number, height: number): number {
  if (!(height > 0)) return 50;
  return Math.round(Math.max(0, Math.min(1, center / height)) * 100);
}

/** Whether a run's own message box gives the keys to the rail: only while
 *  it holds no words. With a draft in it, Alt and the arrows stay the
 *  browser's caret moves, so the rail never takes an editing key from it. */
export const boxIsEmpty = (text: string): boolean => text.trim() === "";

/** what the keys know of one rail on the page */
export interface RailSeat {
  /** drawn: not in a hidden panel, and not a timeline that shows no rail */
  shown: boolean;
  /** inside the sheet that is over the page */
  modal: boolean;
  /** how deep the timeline's parent sits when it holds the keyboard's focus, 0 when it does not */
  focus: number;
  /** the last timeline the pointer was over */
  pointed: boolean;
}

/** Which rail a key steps, by its index, or -1: one that is drawn; inside
 *  the sheet over the page when there is one; then the one whose timeline
 *  holds the focus, the deepest when a timeline sits inside another's box
 *  (a side chat's); then the one last pointed at; then the first. */
export function pickRail(seats: readonly RailSeat[]): number {
  let pool = seats.map((seat, i) => ({ seat, i })).filter((x) => x.seat.shown);
  const narrow = (keep: (seat: RailSeat) => boolean) => {
    const kept = pool.filter((x) => keep(x.seat));
    if (kept.length > 0) pool = kept;
  };
  narrow((s) => s.modal);
  const deepest = Math.max(0, ...pool.map((x) => x.seat.focus));
  if (deepest > 0) narrow((s) => s.focus === deepest);
  narrow((s) => s.pointed);
  return pool[0]?.i ?? -1;
}
