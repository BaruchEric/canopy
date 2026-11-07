/**
 * Where a copy is heard (FR-054). `copyText` (share.ts) and the shells say
 * what they put on the clipboard here, and App, subscribed once, hands each
 * copy to the store, which keeps it on canopy's clipboard. A listener set,
 * as said.ts is, so share.ts never imports the store. `pageCopyText` reads
 * what a copy of the page's own text took, for App's document listener.
 * Pure and tested (clipsink.test.ts).
 */
import type { ClipSource } from "../../src/core/clips";

/** a copy as heard: its text, the kind of thing that made it, and where */
export interface Copied {
  text: string;
  source: ClipSource;
  /** a shell's repo, a gear's surface, a view */
  from?: string;
}

/** what `copyText` is told about a copy: who made it, and `keep: false`
 *  for one the clipboard itself made, which counts its own */
export interface CopyHow {
  source?: ClipSource;
  from?: string;
  keep?: boolean;
}

const listeners = new Set<(c: Copied) => void>();

/** Says a copy happened; every listener hears it. */
export function noteCopied(c: Copied): void {
  for (const l of listeners) l(c);
}

/** Hears every copy; the returned function stops it. */
export function onCopied(listener: (c: Copied) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Where a copy of the page's text is never kept: a shell, whose own copy
 *  says what it took; the secret store's view; a password box; anything
 *  marked `data-no-clip` (copyText's last-resort box among them). */
export const NO_CLIP = '.xterm, .term-screen, .secrets-view, [data-no-clip], input[type="password"]';

/** the parts of an element `pageCopyText` reads, so a test needs no DOM */
export interface CopyTarget {
  closest?: (sel: string) => unknown;
  tagName?: string;
  type?: string;
  value?: string;
  selectionStart?: number | null;
  selectionEnd?: number | null;
}

/**
 * What a copy of the page's own text took, or null when it is nothing to
 * keep. A text box's selection is its value between the marks, since the
 * document's selection is empty there; anything else is the document's
 * selection. Nothing under `NO_CLIP`, at the event's target or where the
 * selection starts.
 */
export function pageCopyText(target: CopyTarget | null, anchor: CopyTarget | null, selection: string): string | null {
  for (const el of [target, anchor]) if (el?.closest?.(NO_CLIP)) return null;
  const tag = target?.tagName?.toUpperCase();
  if (target && (tag === "INPUT" || tag === "TEXTAREA")) {
    if (tag === "INPUT" && target.type?.toLowerCase() === "password") return null;
    const a = target.selectionStart;
    const b = target.selectionEnd;
    if (typeof target.value !== "string" || a === null || a === undefined || b === null || b === undefined || b <= a) return null;
    return target.value.slice(a, b);
  }
  return selection.trim() ? selection : null;
}
