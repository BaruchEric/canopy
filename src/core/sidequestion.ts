/** A side question (FR-077): a message that opens with `btw` in a run's box
 *  goes to a chat forked from the run's session, beside the run, and the run
 *  gets no word of it. Here: what counts as one in a box, why a run takes
 *  none now, and what the forked session is told first. Pure and
 *  browser-safe: the box, the Runner and the CLI share it. */

import { isRunActive, type Run } from "./types";

/** the word a side question opens with */
export const SIDE_WORD = "btw";

/** `btw` as a message's first word, any case, then a comma or a colon or
 *  white space, then the question */
const SIDE = /^\s*btw(?:[,:]\s*|\s+)([\s\S]*)$/i;

/** The question a box's text asks beside the run, or null when the text is
 *  no side question: its first word is not `btw`, or nothing follows the
 *  word yet (`btw` alone may still become `btween`). "" once the word and
 *  its space are typed and the question is not. */
export function sideQuestion(text: string): string | null {
  const hit = SIDE.exec(text);
  return hit ? (hit[1] ?? "").trim() : null;
}

/** A box's text as a side question: the word put in front of what is there. */
export function withSideWord(text: string): string {
  if (sideQuestion(text) !== null) return text;
  const rest = text.replace(/^\s+/, "");
  // `btw` typed and nothing after it: the space makes it one
  return /^btw$/i.test(rest.trim()) ? `${SIDE_WORD} ` : `${SIDE_WORD} ${rest}`;
}

/** A side question's text as a plain message: what followed the word. */
export function withoutSideWord(text: string): string {
  const hit = SIDE.exec(text);
  return hit ? (hit[1] ?? "") : text;
}

/** What `sideRefusal` reads of a run. */
export type SideParent = Pick<Run, "status" | "action" | "session" | "sideOf" | "kept">;

/** Why a run takes no side question now, or null. A side question forks
 *  the run's session, so the run has to be going and to have one. Both
 *  harnesses fork a session mid-turn, so a turn in flight is no refusal. */
export function sideRefusal(run: SideParent): string | null {
  if (run.kept || !isRunActive(run)) return "the run has ended, and a side question is asked beside one that is going; fork it to go on from its end";
  if (run.action === "coordinate") return "a coordinator takes no side question";
  if (run.sideOf) return "this is a side question already: ask it here, or beside the run it started from";
  if (!run.session) return "the run has no session to fork yet: ask once it has begun";
  return null;
}

/** The note that opens a side question's own timeline. */
export const sideNote = (title: string): string => `a side question beside "${title}", on a fork of its session as it stood; that run got no message and works on`;

/** The first message of the forked session: what a side question is, that
 *  the run it was forked from is still at work in the same folder, and the
 *  question. The session above it is the parent's, so the repo's facts and
 *  rules are known already. */
export function sideMessage(question: string): string {
  return [
    "This is a side question. This conversation is a fork of a run that is still at work in this folder: everything above is that run's session as it stood when the question was asked, and that run carries on with its task by itself.",
    "",
    "Rules for this side conversation:",
    "- Answer the question below, and any later message here. Do not carry on the run's task, and do not finish, repeat or retry anything it had started.",
    "- A tool call shown above as interrupted, or with no result, is still running in the run you were forked from. Do not run it again.",
    "- Change no file and run nothing that changes the repository, its git state or anything outside it, unless a message here asks for that in so many words.",
    "- The run and other agents are working in this folder at the same time as you. Files may change or show as uncommitted while you read: leave them as they are.",
    "- Keep the answer short and in plain prose unless more is asked for.",
    "",
    "The side question:",
    question.trim(),
  ].join("\n");
}
