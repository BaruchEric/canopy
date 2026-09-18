import { git } from "./exec";
import type { GrepHit, GrepResult } from "./types";

/** how many hits one repo hands back before the list is cut */
export const GREP_LIMIT = 500;
/** how much of a matched line rides to the browser */
export const LINE_CLIP = 240;

/** `git grep` over tracked text files: fixed string, case-insensitive, with
 *  the line and column of the first match. `-z` keeps paths verbatim and
 *  `-e` keeps a query that starts with a dash from reading as a flag. */
export function grepArgs(query: string): string[] {
  return ["grep", "-n", "-I", "--column", "-z", "-i", "-F", "-e", query, "--"];
}

/** Cut a long line down to `width` characters around column `col`, so a
 *  minified line does not flood the list. The column moves with the cut. */
export function clipLine(
  text: string,
  col: number,
  width = LINE_CLIP,
): { text: string; col: number } {
  if (text.length <= width) return { text, col };
  // Keep the match a third of the way in, so what follows it shows too.
  const start = Math.max(0, Math.min(col - 1 - Math.floor(width / 3), text.length - width));
  const end = Math.min(text.length, start + width);
  const head = start > 0 ? "…" : "";
  const tail = end < text.length ? "…" : "";
  return { text: `${head}${text.slice(start, end)}${tail}`, col: col - start + head.length };
}

/** Read `git grep -n --column -z` output: one `path\0line\0col\0text\n`
 *  record per hit. Stops after `limit` hits and says so. */
export function parseGrep(out: string, limit: number): GrepResult {
  const hits: GrepHit[] = [];
  let truncated = false;
  for (const rec of out.split("\n")) {
    if (rec === "") continue;
    if (hits.length >= limit) {
      truncated = true;
      break;
    }
    const [file, line, col, ...rest] = rec.split("\0");
    if (file === undefined || line === undefined || col === undefined) continue;
    // Indentation says nothing about the match and eats a narrow panel.
    const raw = rest.join("\0");
    const text = raw.trimStart();
    const clipped = clipLine(text, Math.max(1, Number(col) - (raw.length - text.length)));
    hits.push({ file, line: Number(line), col: clipped.col, text: clipped.text });
  }
  return { hits, truncated };
}

/** Search one repo's tracked files, wherever the repo lives. Exit 1 is
 *  git's "no match", not an error. */
export async function searchRepo(
  repoPath: string,
  query: string,
  opts: { limit?: number; timeoutMs?: number } = {},
): Promise<GrepResult> {
  const r = await git(repoPath, grepArgs(query), opts.timeoutMs ?? 20_000);
  if (r.code === 1 && r.stdout === "") return { hits: [], truncated: false };
  if (r.code !== 0 && r.code !== 1) {
    throw new Error(r.stderr.trim() || `git grep exited ${r.code}`);
  }
  return parseGrep(r.stdout, opts.limit ?? GREP_LIMIT);
}

/** `Promise.all` with at most `n` jobs in flight; results keep input order. */
export async function mapPool<T, R>(
  items: readonly T[],
  n: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = [];
  // One iterator shared by every worker: each pulls the next job when free.
  const queue = items.entries();
  const worker = async (): Promise<void> => {
    for (let r = queue.next(); !r.done; r = queue.next()) {
      const [i, item] = r.value;
      out[i] = await fn(item);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(n, items.length)) }, worker));
  return out;
}
