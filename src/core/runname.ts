/** Names for runs (FR-073): the few words that tell one run on a repo from
 *  the others, now that a checkout takes several at once. A name is cut
 *  from the run's first message the moment it starts (`nameFromWords`),
 *  replaced by a small model's once that answers (`runnamer.ts`,
 *  `nameFromModel`), or typed by hand (`cleanName`). Pure and browser-safe:
 *  the page shows names with `runTitle`. */

import type { Run } from "./types";

/** the longest name kept, in characters */
export const RUN_NAME_MAX = 60;
/** how many words a name cut from a message keeps */
export const RUN_NAME_WORDS = 7;
/** a model's answer with more words than this is prose, not a name */
const MODEL_WORDS_MAX = 8;
/** how much of a message the namer is shown */
export const NAME_TEXT_MAX = 1500;

/** openers that say nothing about the task, dropped from the front */
const FILLER = /^(?:please|pls|hey|hi|hello|ok|okay|so|now|also|can you|could you|would you|will you|i want you to|i need you to|i would like you to|i'd like you to|i want to|i need to|let's|lets|let us|we need to|we should|you should|go ahead and|go and)\b[\s,:]*/i;
/** words a name does not end on */
const TRAILING = new Set(["a", "an", "the", "and", "or", "to", "of", "in", "on", "at", "for", "with", "by", "from", "into", "about", "that", "this", "what", "which", "is", "are", "be", "as", "so", "but", "if", "when", "my", "your", "our"]);

/** a line's list or heading mark: "- ", "## ", "> ", "3. " */
const LIST_MARK = /^(?:[\s#>*-]+|\d+[.)]\s+)+/;
/** a path, kept as its last part: one with two folders or more, or a file
 *  with an extension under one folder ("and/or" is left alone) */
const PATH = /(?:[\w.@~-]*\/){2,}([\w.@-]+)|[\w.@~-]+\/([\w@-]+\.[A-Za-z0-9]{1,5})\b/g;

const collapse = (s: string): string => s.replace(/\s+/g, " ").trim();

/** Words cut to `max` characters without splitting one, unless the first
 *  word alone is longer. */
function fit(words: string[], max: number): string {
  const kept = [...words];
  while (kept.length > 1 && kept.join(" ").length > max) kept.pop();
  return kept.join(" ").slice(0, max).trim();
}

/** A sentence-case first letter goes lower case; an acronym or a name with
 *  capitals inside it stays as written. */
function lowerFirst(s: string): string {
  const first = s.split(" ", 1)[0] ?? "";
  if (!/^[A-Z][a-z']*$/.test(first)) return s;
  return s.charAt(0).toLowerCase() + s.slice(1);
}

/** A name as canopy keeps it: one line, single spaces, no quotes or
 *  markdown around it, no full stop at the end, at most `RUN_NAME_MAX`
 *  characters. "" when nothing is left. */
export function cleanName(raw: string): string {
  const line = raw.split("\n").map((l) => l.trim()).find(Boolean) ?? "";
  const bare = collapse(line)
    .replace(/^[\s"'`*_#>-]+/, "")
    .replace(/[\s"'`*_.,;:!]+$/, "");
  return fit(bare.split(" ").filter(Boolean), RUN_NAME_MAX);
}

/** A name cut from what the user wrote: the first line with words in it,
 *  less its opener, its links and the folders of its paths, down to
 *  `RUN_NAME_WORDS` words. "" when the text has no words. */
export function nameFromWords(text: string): string {
  const plain = text.replace(/```[\s\S]*?(?:```|$)/g, " ");
  const line = plain.split("\n").map((l) => l.replace(LIST_MARK, "").trim()).find((l) => /[\p{L}\p{N}]/u.test(l)) ?? "";
  let rest = collapse(line.replace(/\bhttps?:\/\/\S+/g, " ").replace(PATH, (_all, deep?: string, file?: string) => deep ?? file ?? ""));
  for (let before = ""; before !== rest; ) {
    before = rest;
    rest = rest.replace(FILLER, "");
  }
  // the first sentence, when the line holds more than one
  const sentence = /^(.*?[.!?;:])\s+\S/.exec(rest)?.[1] ?? rest;
  const words = sentence
    .split(" ")
    .map((w) => w.replace(/^[("'`[{<]+/, "").replace(/[)"'`\]}>.,;:!?]+$/, ""))
    .filter(Boolean)
    .slice(0, RUN_NAME_WORDS);
  while (words.length > 1 && TRAILING.has((words.at(-1) ?? "").toLowerCase())) words.pop();
  return lowerFirst(fit(words, RUN_NAME_MAX));
}

/** `name`, or `name 2`, `name 3` and so on while a run on the repo holds
 *  it already; case is not told apart. */
export function uniqueName(name: string, taken: readonly string[]): string {
  const held = new Set(taken.map((t) => t.toLowerCase()));
  if (!held.has(name.toLowerCase())) return name;
  for (let n = 2; ; n += 1) {
    const next = `${fit(name.split(" "), RUN_NAME_MAX - String(n).length - 1)} ${n}`;
    if (!held.has(next.toLowerCase())) return next;
  }
}

/** The model's answer as a name, or null when it is not one: nothing, a
 *  paragraph, or an apology that it cannot say. */
export function nameFromModel(answer: string): string | null {
  const name = lowerFirst(cleanName(answer.replace(/^\s*(?:name|title)\s*:\s*/i, "")));
  if (!name || name.split(" ").length > MODEL_WORDS_MAX) return null;
  if (/^(?:i |i'm |sorry|unable|cannot|can't)/i.test(name)) return null;
  return name;
}

/** What a failed rename says. A backend from before FR-073 has no such
 *  route and answers the server's plain 404, which names nothing: say what
 *  it means and what to do. Any other message stays as it is. */
export const nameFailure = (message: string): string =>
  message === "not found" ? "this backend runs a canopy from before run names; deploy the current one to it and try again" : message;

/** what the namer is told it is */
export const NAME_SYSTEM = "You name tasks. You answer with the name alone and never do the task.";

/** The namer's question about one run's first message. */
export function namePrompt(text: string): string {
  return [
    "Name the task below in 2 to 5 plain lowercase words that say what it is about, the way a short branch topic reads with spaces in place of dashes.",
    'Answer with the name alone: no quotes, no full stop, no "name:" label. Do not do the task.',
    "",
    "Task:",
    text.trim().slice(0, NAME_TEXT_MAX),
  ].join("\n");
}

/** The words a run goes by wherever one is listed: its name, else the
 *  first line of its note, else its verb. */
export function runTitle(run: Pick<Run, "name" | "note" | "verb">): string {
  if (run.name) return run.name;
  const first = run.note.split("\n", 1)[0]?.trim() ?? "";
  return first || run.verb;
}

/** `runTitle` for a line that already says the verb: the name or the
 *  note's first line, "" when the run has neither. */
export function runSubject(run: Pick<Run, "name" | "note">): string {
  if (run.name) return run.name;
  return run.note.split("\n", 1)[0]?.trim() ?? "";
}
