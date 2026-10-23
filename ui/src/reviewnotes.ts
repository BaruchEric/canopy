/* Review notes: the user's remarks on lines of a diff, gathered per repo
   while reading its changes or its commits and handed to the repo's agent
   in one message. Kept in localStorage under their own key, through
   try/catch since storage can be blocked, and read with the storage as an
   argument, as answerKey.ts does. Pure but for those calls; tested. */
import { isSeedId } from "../../src/core/sprout";
import { fence } from "../../src/core/pr";
import type { Repo } from "../../src/core/types";

export const REVIEW_NOTES_STORE = "canopy.reviewNotes";

/** where a diff line comes from: the old file (a removed line) or the new one */
export type Side = "old" | "new";

export type LineKind = "add" | "del" | "ctx" | "hunk" | "meta";

/** One line of a diff as DiffView paints it. A line inside a hunk carries
 *  its numbers; anything else (headers, git's stderr) carries none. */
export type DiffLine = { kind: LineKind; text: string; oldLine?: number; newLine?: number };

/** A note on one line. `where` is "working tree", a commit hash, or a
 *  worktree path; `snippet` is the line as the diff showed it, so the
 *  agent can find it after the numbers move. */
export type Note = {
  id: string;
  repoId: string;
  path: string;
  where: string;
  side: Side;
  line: number;
  snippet: string;
  text: string;
};

export const WORKING_TREE = "working tree";

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** a line outside any hunk, classed by its prefix as DiffView always has */
const outside = (text: string): LineKind => {
  if (text.startsWith("+++") || text.startsWith("---")) return "meta";
  if (text.startsWith("@@")) return "hunk";
  if (text.startsWith("+")) return "add";
  if (text.startsWith("-")) return "del";
  if (text.startsWith("diff ") || text.startsWith("index ")) return "meta";
  return "ctx";
};

/** Reads a unified diff line by line. Inside a hunk the header's counts say
 *  how many old and new lines remain, so a removed `-- x` (shown `--- x`)
 *  stays a deletion and the hunk ends where git says, not where a prefix
 *  looks like a header. A `diff --git` line starts over, which is how the
 *  staged and unstaged halves of one file, joined, read as two diffs.
 *  Lines outside a hunk keep their prefix class and get no numbers, so
 *  plain text such as git's stderr reads as before and takes no notes. */
export function parseDiff(text: string): DiffLine[] {
  const raw = text.split("\n");
  // the newline that ends the text is not a line of its own
  if (raw.length > 1 && raw[raw.length - 1] === "") raw.pop();
  const out: DiffLine[] = [];
  let oldLeft = 0;
  let newLeft = 0;
  let oldAt = 0;
  let newAt = 0;
  for (const t of raw) {
    const inHunk = oldLeft > 0 || newLeft > 0;
    if (t.startsWith("diff --git ")) {
      oldLeft = newLeft = 0;
      out.push({ kind: "meta", text: t });
      continue;
    }
    // "\ No newline at end of file" follows its line, often the hunk's last
    if (t.startsWith("\\ ")) {
      out.push({ kind: "meta", text: t });
      continue;
    }
    if (inHunk) {
      if (t.startsWith("+") && newLeft > 0) {
        out.push({ kind: "add", text: t, newLine: newAt++ });
        newLeft--;
      } else if (t.startsWith("-") && oldLeft > 0) {
        out.push({ kind: "del", text: t, oldLine: oldAt++ });
        oldLeft--;
      } else if ((t.startsWith(" ") || t === "") && oldLeft > 0 && newLeft > 0) {
        out.push({ kind: "ctx", text: t, oldLine: oldAt++, newLine: newAt++ });
        oldLeft--;
        newLeft--;
      } else {
        // the counts and the lines disagree: stop numbering rather than guess
        oldLeft = newLeft = 0;
        out.push({ kind: outside(t), text: t });
      }
      continue;
    }
    const h = HUNK.exec(t);
    if (h) {
      oldAt = Number(h[1]);
      oldLeft = h[2] === undefined ? 1 : Number(h[2]);
      newAt = Number(h[3]);
      newLeft = h[4] === undefined ? 1 : Number(h[4]);
      out.push({ kind: "hunk", text: t });
      continue;
    }
    out.push({ kind: outside(t), text: t });
  }
  return out;
}

/** the side and number a note on this line is pinned to, or null when the
 *  line takes no note (headers, stderr) */
export function anchorOf(l: DiffLine): { side: Side; line: number } | null {
  if (l.kind === "del" && l.oldLine !== undefined) return { side: "old", line: l.oldLine };
  if ((l.kind === "add" || l.kind === "ctx") && l.newLine !== undefined) return { side: "new", line: l.newLine };
  return null;
}

/** whether a note sits on this line: same side, number and text, so a note
 *  left on the staged half does not show on the unstaged one at the same
 *  number, and an edit that moves the line drops it to the unmatched list */
export const noteOn = (n: Pick<Note, "side" | "line" | "snippet">, l: DiffLine): boolean => {
  const a = anchorOf(l);
  return a !== null && a.side === n.side && a.line === n.line && l.text === n.snippet;
};

/** whether the repo's agent can take notes: a seed's agents run through the
 *  incubator, and a forge or remote repo has no agent here */
export const takesNotes = (repo: Pick<Repo, "id" | "host" | "forge">): boolean => !repo.host && !repo.forge && !isSeedId(repo.id);

/** a fresh id; randomUUID is missing over plain http, which a tailnet
 *  address is */
export const noteId = (): string => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

const COMMIT = /^[0-9a-f]{7,64}$/;

const whereWords = (where: string): string =>
  where === WORKING_TREE ? "uncommitted, in the working tree" : COMMIT.test(where) ? `in commit ${where}` : `in the worktree at ${where}`;

/** The message the notes go to the agent in: grouped by file and where the
 *  diff came from, in the order they were left, each group's notes by line.
 *  The quoted line is file content, so it is fenced as data; the note under
 *  it is the user's own words, and is what the agent should act on. */
export function notesPrompt(notes: readonly Note[]): string {
  const groups = new Map<string, Note[]>();
  for (const n of notes) {
    const k = `${n.path}\0${n.where}`;
    const g = groups.get(k);
    if (g) g.push(n);
    else groups.set(k, [n]);
  }
  const parts: string[] = [];
  for (const g of groups.values()) {
    const [first] = g;
    if (!first) continue;
    const items = [...g]
      .sort((a, b) => a.line - b.line)
      .map((n) => {
        const at = n.side === "old" ? `removed line ${n.line} (old numbering)` : `line ${n.line}`;
        return `${at}:\n${fence("The line", n.snippet)}\nMy note: ${n.text}`;
      });
    parts.push(`## ${first.path} (${whereWords(first.where)})\n\n${items.join("\n\n")}`);
  }
  const count = notes.length === 1 ? "a note" : `${notes.length} notes`;
  // a peer-synced checkout diverges on a rewritten commit, so a note on one
  // asks for a change on top of it, never an amend
  const onCommit = notes.some((n) => COMMIT.test(n.where));
  const keep = onCommit ? " For notes on a commit, make new changes on top of it; do not amend or rewrite that commit." : "";
  return `I reviewed the diff and left ${count} on it. Each one quotes the line it is about, then says what I want. Work through them, and tell me what you changed for each.${keep}\n\n${parts.join("\n\n")}`;
}

type Store = Pick<Storage, "getItem" | "setItem" | "removeItem">;

const local = (): Store | null => {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
};

const isNote = (v: unknown): v is Note => {
  if (!v || typeof v !== "object") return false;
  const n = v as Record<string, unknown>;
  return (
    typeof n["id"] === "string" &&
    typeof n["repoId"] === "string" &&
    typeof n["path"] === "string" &&
    typeof n["where"] === "string" &&
    (n["side"] === "old" || n["side"] === "new") &&
    typeof n["line"] === "number" &&
    typeof n["snippet"] === "string" &&
    typeof n["text"] === "string"
  );
};

/** every repo's notes this browser holds; anything unreadable reads as none */
export function loadNotes(store: Store | null = local()): Record<string, Note[]> {
  try {
    const raw = store?.getItem(REVIEW_NOTES_STORE);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, Note[]> = {};
    for (const [repoId, list] of Object.entries(parsed)) {
      const notes = Array.isArray(list) ? list.filter(isNote).filter((n) => n.repoId === repoId) : [];
      if (notes.length) out[repoId] = notes;
    }
    return out;
  } catch {
    return {};
  }
}

/** Keeps the notes (none removes the key); false when storage refused, so
 *  they hold for this page only. */
export function saveNotes(all: Record<string, Note[]>, store: Store | null = local()): boolean {
  try {
    if (!store) return false;
    const kept = Object.fromEntries(Object.entries(all).filter(([, l]) => l.length > 0));
    if (Object.keys(kept).length === 0) store.removeItem(REVIEW_NOTES_STORE);
    else store.setItem(REVIEW_NOTES_STORE, JSON.stringify(kept));
    return true;
  } catch {
    return false;
  }
}

/** Applies a change to the stored notes, not to this page's copy, and keeps
 *  the result: a solo or pop-out window holds its own copy, and writing that
 *  whole would drop the notes another window left since. With no storage
 *  the page's own copy is all there is. */
export function updateNotes(
  held: Record<string, Note[]>,
  change: (all: Record<string, Note[]>) => Record<string, Note[]>,
  store: Store | null = local(),
): Record<string, Note[]> {
  const next = change(store ? loadNotes(store) : held);
  saveNotes(next, store);
  return next;
}

/** the notes with one added under its repo */
export function withNote(all: Record<string, Note[]>, note: Note): Record<string, Note[]> {
  return { ...all, [note.repoId]: [...(all[note.repoId] ?? []), note] };
}

/** the notes without the given ids on a repo; a repo left with none loses its key */
export function withoutNotes(all: Record<string, Note[]>, repoId: string, ids: ReadonlySet<string>): Record<string, Note[]> {
  const left = (all[repoId] ?? []).filter((n) => !ids.has(n.id));
  const next = { ...all };
  if (left.length) next[repoId] = left;
  else delete next[repoId];
  return next;
}
