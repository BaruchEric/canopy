import type { GrepHit } from "../../src/core/types";

/** the hits of one file, as the list shows them */
export interface FileHits {
  file: string;
  hits: GrepHit[];
}

/** Fold a repo's hits into one group per file, files in the order git grep
 *  printed them (its tree order) and the hits in line order under each. */
export function groupHits(hits: readonly GrepHit[]): FileHits[] {
  const byFile = new Map<string, GrepHit[]>();
  for (const h of hits) {
    const list = byFile.get(h.file);
    if (list) list.push(h);
    else byFile.set(h.file, [h]);
  }
  return [...byFile].map(([file, list]) => ({ file, hits: list }));
}

/** The three pieces of a matched line: what comes before the match at
 *  1-based column `col`, the `len` characters matched, and the rest. */
export function markHit(
  text: string,
  col: number,
  len: number,
): { before: string; match: string; after: string } {
  const start = Math.min(Math.max(0, col - 1), text.length);
  const end = Math.min(text.length, start + len);
  return { before: text.slice(0, start), match: text.slice(start, end), after: text.slice(end) };
}
