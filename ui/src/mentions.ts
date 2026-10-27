/**
 * A prompt box's menu at `/`, `$` and `@`, the pure half: which word the
 * caret is in, which commands, skills or files match it, and the text once
 * one is picked. The component is components/Mentions.tsx. Tested in
 * mentions.test.ts.
 */
import type { Harness, Mention } from "../../src/core/types";

export type Sigil = "/" | "$" | "@";

/** the word the caret is in, from its sigil to the next space */
export interface MentionAt {
  sigil: Sigil;
  start: number;
  end: number;
  /** what follows the sigil up to the caret */
  query: string;
}

/** how many rows a menu shows */
export const MENU_CAP = 12;

const blank = (c: string | undefined): boolean => c === undefined || /\s/.test(c);

/** Which sigils a box offers. `@` names a file at the start of any word,
 *  for either agent; `$` a Codex skill, at the start of any word too; `/`
 *  opens Codex's skills as well, with picks inserted as `$skill`. For
 *  Claude Code, `/` is a command the CLI reads only as a message's first
 *  character, so only a box whose text goes to the agent as a message of
 *  its own (`bare`) offers it. A note is folded into canopy's prompt, and
 *  a chat's first message too, so neither does. */
export function sigilsFor(harness: Harness | null, bare = false): Sigil[] {
  const out: Sigil[] = ["@"];
  if (harness === "codex") out.push("$", "/");
  if (harness === "claude" && bare) out.push("/");
  return out;
}

/** The `/word`, `$word` or `@path` the caret is in, if any, among the
 *  `sigils` the box offers; `/` only as the first character. */
export function mentionAt(text: string, caret: number, sigils: readonly Sigil[]): MentionAt | null {
  const at = Math.max(0, Math.min(caret, text.length));
  let start = at;
  while (start > 0 && !blank(text[start - 1])) start--;
  let end = at;
  while (end < text.length && !blank(text[end])) end++;
  const sigil = text[start];
  if (sigil === "/") {
    if (start !== 0 || !sigils.includes("/")) return null;
  } else if (sigil === "$") {
    if (!sigils.includes("$")) return null;
  } else if (sigil !== "@" || !sigils.includes("@")) {
    return null;
  }
  return { sigil, start, end, query: text.slice(start + 1, at) };
}

/** every character of `q` in `s`, in order */
export function subsequence(q: string, s: string): boolean {
  let i = 0;
  for (const c of s) {
    if (c === q[i]) i++;
    if (i === q.length) return true;
  }
  return q.length === 0;
}

const FROM_RANK = (from: string): number => (from.startsWith("project") ? 0 : from.startsWith("user") ? 1 : from === "builtin" ? 2 : 3);

/** The commands and skills matching `query`, best first: a name's start,
 *  then a part's after a plugin's colon, then anywhere in the name, its
 *  alias or its description, then the letters in order. With no query, the
 *  repo's own first, then the user's, the CLI's, the plugins'. */
export function rankWords(words: readonly Mention[], query: string, cap = MENU_CAP): Mention[] {
  const q = query.toLowerCase();
  const scored: { w: Mention; s: number }[] = [];
  for (const w of words) {
    const name = w.name.toLowerCase();
    let s = 0;
    if (!q) s = 1;
    else if (name.startsWith(q)) s = 6;
    else if (name.split(":").some((p) => p.startsWith(q))) s = 5;
    else if (name.includes(q)) s = 4;
    else if (w.alias?.toLowerCase().includes(q)) s = 3;
    else if (w.description.toLowerCase().includes(q)) s = 2;
    else if (subsequence(q, name)) s = 1;
    if (s > 0) scored.push({ w, s });
  }
  scored.sort((a, b) => b.s - a.s || FROM_RANK(a.w.from) - FROM_RANK(b.w.from) || a.w.name.localeCompare(b.w.name));
  return scored.slice(0, cap).map((x) => x.w);
}

/** Every folder the files sit in, as `dir/`, before the files, so a
 *  mention can name a folder for the agent to read whole. */
export function withFolders(files: readonly string[]): string[] {
  const dirs = new Set<string>();
  for (const f of files) {
    let i = f.indexOf("/");
    while (i >= 0) {
      dirs.add(f.slice(0, i + 1));
      i = f.indexOf("/", i + 1);
    }
  }
  return [...[...dirs].sort(), ...files];
}

const isFolder = (p: string): boolean => p.endsWith("/");
const trimmed = (p: string): string => (isFolder(p) ? p.slice(0, -1) : p);
const depthOf = (p: string): number => trimmed(p).split("/").length;
const baseOf = (p: string): string => {
  const t = trimmed(p);
  return t.slice(t.lastIndexOf("/") + 1);
};
const isHidden = (p: string): boolean => trimmed(p).split("/").some((part) => part.startsWith("."));

/** The paths matching `query`, best first: a name's start, then anywhere
 *  in the name, then the path's start, then anywhere in it, then the
 *  letters in order; shorter paths first among equals, dotfiles last.
 *  With no query, the top level, folders first. */
export function rankFiles(paths: readonly string[], query: string, cap = MENU_CAP): string[] {
  const q = query.toLowerCase();
  if (!q) {
    return [...paths]
      .sort((a, b) => Number(isHidden(a)) - Number(isHidden(b)) || depthOf(a) - depthOf(b) || Number(isFolder(b)) - Number(isFolder(a)) || a.localeCompare(b))
      .slice(0, cap);
  }
  const scored: { p: string; s: number }[] = [];
  for (const p of paths) {
    const low = p.toLowerCase();
    const base = baseOf(low);
    let s = 0;
    if (base.startsWith(q)) s = 6;
    else if (base.includes(q)) s = 5;
    else if (low.startsWith(q)) s = 4;
    else if (low.includes(q)) s = 3;
    else if (subsequence(q, low)) s = 1;
    if (s === 0) continue;
    if (isHidden(p) && !q.startsWith(".")) s -= 0.5;
    scored.push({ p, s });
  }
  scored.sort((a, b) => b.s - a.s || a.p.length - b.p.length || a.p.localeCompare(b.p));
  return scored.slice(0, cap).map((x) => x.p);
}

/** The text with the word at `at` replaced by the sigil and `value`, and a
 *  space after a word or a file so typing goes on; a folder gets none, so
 *  the menu stays open on what is inside it. Codex skills picked at `/`
 *  use the agent's `$skill` invocation. */
export function applyPick(text: string, at: MentionAt, value: string, harness?: Harness): { text: string; caret: number } {
  const sigil = at.sigil === "/" && harness === "codex" ? "$" : at.sigil;
  const insert = sigil + value + (isFolder(value) ? "" : " ");
  return { text: text.slice(0, at.start) + insert + text.slice(at.end), caret: at.start + insert.length };
}
