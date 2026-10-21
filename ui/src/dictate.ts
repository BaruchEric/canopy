/**
 * The mic beside a text field: which fields take dictation, and how the
 * words land between what is already typed. Pure; `components/Dictate.tsx`
 * records the clip and puts the text in.
 */

/** what the predicate reads off a field; an HTMLElement has all of it */
export interface FieldLike {
  tagName: string;
  type?: string;
  readOnly?: boolean;
  disabled?: boolean;
  closest(selector: string): unknown;
}

/** the input types that hold words; a number, a date or a password does not */
const WORD_TYPES: ReadonlySet<string> = new Set(["text", "search", "url", "email", ""]);

/** Fields marked `data-no-dictate`, or inside one, are left alone, since a
 *  secret must not go to a speech model; one marked `data-mic` has a mic of
 *  its own. A shell's xterm is not a field: its words go in as a paste,
 *  which `components/Dictate.tsx` handles apart. */
export const NO_DICTATE = "[data-no-dictate], [data-mic], .xterm";

export function dictatable(el: FieldLike | null): boolean {
  if (!el || el.readOnly || el.disabled) return false;
  const tag = el.tagName.toUpperCase();
  if (tag === "TEXTAREA") return !el.closest(NO_DICTATE);
  if (tag !== "INPUT") return false;
  return WORD_TYPES.has((el.type ?? "").toLowerCase()) && !el.closest(NO_DICTATE);
}

/** What goes in at the caret: the words with a space before them when they
 *  would run into a word, and one after when a word follows. */
export function dictationText(before: string, said: string, after: string): string {
  const words = said.trim();
  if (!words) return "";
  const lead = before !== "" && !/\s$/.test(before) ? " " : "";
  const tail = after !== "" && !/^[\s.,;:!?)]/.test(after) ? " " : "";
  return lead + words + tail;
}
