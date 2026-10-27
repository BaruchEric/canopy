/**
 * A prompt box's menu at `/`, `$` and `@`: the agent's commands and skills,
 * and the repo's files, as the CLI offers them in a terminal. `useMentions`
 * watches a textarea's caret, reads each list once per repo, and hands back
 * the menu to draw beside the box and a key handler to run first. The pure
 * half is ../mentions.ts.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import type { Harness, Mention } from "../../../src/core/types";
import { api } from "../api";
import { applyPick, mentionAt, rankFiles, rankWords, sigilsFor, withFolders, type MentionAt } from "../mentions";

/** how long one repo's lists are good for before the next open reads again */
const WORDS_TTL = 30_000;
const FILES_TTL = 60_000;

type Held<T> = Map<string, { at: number; got: Promise<T> }>;
const words: Held<Mention[]> = new Map();
const files: Held<string[]> = new Map();

/** one read per repo per `ttl`; a failed read is not held */
function held<T>(store: Held<T>, key: string, ttl: number, load: () => Promise<T>): Promise<T> {
  const hit = store.get(key);
  const now = Date.now();
  if (hit && now - hit.at < ttl) return hit.got;
  const got = load().catch((err: unknown) => {
    store.delete(key);
    throw err;
  });
  store.set(key, { at: now, got });
  return got;
}

/** one row of the menu */
interface Row {
  /** what goes into the text after the sigil */
  value: string;
  hint: string;
  tag: string;
}

const tagOf = (w: Mention): string => w.from.replace(":", " ");

const rowsOf = (at: MentionAt, list: readonly Mention[], paths: readonly string[], harness: Harness | null): Row[] =>
  at.sigil === "@"
    ? rankFiles(paths, at.query).map((p) => ({ value: p, hint: "", tag: p.endsWith("/") ? "folder" : "" }))
    : rankWords(
        list.filter((w) => w.harness === harness),
        at.query,
      ).map((w) => ({ value: w.name, hint: w.alias ? `${w.alias} · ${w.description}` : w.description, tag: tagOf(w) }));

const keyOf = (at: MentionAt): string => `${at.sigil}${at.start}:${at.query}`;

const sameAt = (a: MentionAt | null, b: MentionAt | null): boolean =>
  a === b || (a !== null && b !== null && a.sigil === b.sigil && a.start === b.start && a.end === b.end && a.query === b.query);

/**
 * The menu for one textarea. `text` and `setText` are the box's state;
 * `repoId` says whose files and commands; `harness` which agent's words,
 * and none means files alone. Draw the menu in the flow beside the box
 * (before it for `above`, after it for `below`), call `onKeyDown` first in
 * the box's handler and stop when it answers true.
 */
export function useMentions({
  box,
  text,
  setText,
  repoId,
  harness,
  bare = false,
  side = "above",
}: {
  box: RefObject<HTMLTextAreaElement | null>;
  text: string;
  setText: (text: string) => void;
  repoId: string | undefined;
  harness?: Harness;
  /** the text goes to the agent as a message of its own, so `/` runs a
   *  command; a note folded into canopy's prompt is not */
  bare?: boolean;
  /** where the menu sits: over the box (a chat's, at the bottom) or under
   *  it (a note's); the caller places it in the DOM on that side */
  side?: "above" | "below";
}): { menu: ReactNode; onKeyDown: (e: KeyboardEvent<HTMLTextAreaElement>) => boolean } {
  const [at, setAt] = useState<MentionAt | null>(null);
  const [focused, setFocused] = useState(false);
  const [wordList, setWordList] = useState<Mention[] | null>(null);
  const [fileList, setFileList] = useState<string[] | null>(null);
  const [pick, setPick] = useState(0);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const sigils = useMemo(() => sigilsFor(harness ?? null, bare), [harness, bare]);

  // the box itself, once it is there: a note's mounts when its line or
  // element is picked, after the hook first ran
  const [el, setEl] = useState<HTMLTextAreaElement | null>(null);
  useEffect(() => {
    if (box.current !== el) setEl(box.current);
  });

  // where the caret stands: after every change of the text, and after it
  // moves on its own (arrows, a click)
  const place = useCallback(() => {
    const b = box.current;
    const next = b && repoId ? mentionAt(b.value, b.selectionStart ?? b.value.length, sigils) : null;
    // the same word stays the same object, so a key's own keyup (an arrow
    // moving the pick) changes nothing below
    setAt((prev) => (sameAt(prev, next) ? prev : next));
  }, [box, repoId, sigils]);
  useEffect(place, [place, text]);
  useEffect(() => {
    if (!el) return;
    const focus = () => setFocused(true);
    const blur = () => setFocused(false);
    el.addEventListener("keyup", place);
    el.addEventListener("click", place);
    el.addEventListener("focus", focus);
    el.addEventListener("blur", blur);
    setFocused(document.activeElement === el);
    return () => {
      el.removeEventListener("keyup", place);
      el.removeEventListener("click", place);
      el.removeEventListener("focus", focus);
      el.removeEventListener("blur", blur);
    };
  }, [el, place]);

  // the lists, read when a sigil first opens and held per repo
  useEffect(() => {
    setWordList(null);
    setFileList(null);
  }, [repoId]);
  const sigil = at?.sigil ?? null;
  useEffect(() => {
    if (!sigil || !repoId) return;
    let live = true;
    if (sigil === "@") {
      void held(files, repoId, FILES_TTL, () => api.files(repoId).then((r) => withFolders(r.files))).then(
        (f) => live && setFileList(f),
        () => live && setFileList([]),
      );
    } else {
      void held(words, repoId, WORDS_TTL, () => api.mentions(repoId)).then(
        (w) => live && setWordList(w),
        () => live && setWordList([]),
      );
    }
    return () => {
      live = false;
    };
  }, [sigil, repoId]);

  const rows = useMemo(() => (at ? rowsOf(at, wordList ?? [], fileList ?? [], harness ?? null) : []), [at, wordList, fileList, harness]);
  // back to the first row when the rows change, not when they are recomputed
  const rowsKey = rows.map((r) => r.value).join("\n");
  useEffect(() => setPick(0), [rowsKey]);
  const sel = Math.min(pick, Math.max(0, rows.length - 1));
  const open = at !== null && focused && rows.length > 0 && dismissed !== keyOf(at);
  useEffect(() => {
    if (open) listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
  }, [open, sel]);

  const accept = (row: Row) => {
    if (!at) return;
    const next = applyPick(text, at, row.value, harness);
    setText(next.text);
    const el = box.current;
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(next.caret, next.caret);
      place();
    });
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (!open) return false;
    // the key is the menu's alone: not the box's, and not the page's (a
    // sheet closes on Escape, a board moves on arrows)
    const take = () => {
      e.preventDefault();
      e.stopPropagation();
    };
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      take();
      const step = e.key === "ArrowDown" ? 1 : rows.length - 1;
      setPick((sel + step) % rows.length);
      return true;
    }
    if (e.key === "Enter" || e.key === "Tab") {
      take();
      const row = rows[sel];
      if (row) accept(row);
      return true;
    }
    if (e.key === "Escape") {
      take();
      setDismissed(keyOf(at));
      return true;
    }
    return false;
  };

  const menu: ReactNode = open ? (
    <ul ref={listRef} className={`mention-menu ${side}`} role="listbox" aria-label={at.sigil === "@" ? "Files" : "Commands and skills"}>
      {rows.map((row, i) => (
        <li
          // a user's and a repo's command may share a name
          key={`${row.tag} ${row.value}`}
          role="option"
          aria-selected={i === sel}
          className={`mention-row${i === sel ? " on" : ""}`}
          // on pointer down, before the box could lose focus to the click
          onPointerDown={(e) => {
            e.preventDefault();
            accept(row);
          }}
          onMouseEnter={() => setPick(i)}
        >
          <span className="mention-sigil" aria-hidden="true">
            {at.sigil}
          </span>
          <span className="mention-name">{row.value}</span>
          <span className="mention-hint">{row.hint}</span>
          {row.tag && <span className="mention-tag">{row.tag}</span>}
        </li>
      ))}
    </ul>
  ) : null;

  return { menu, onKeyDown };
}
