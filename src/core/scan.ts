import { readdir, realpath, stat } from "node:fs/promises";
import { basename, join, relative } from "node:path";
import { getStatus } from "./git";
import { readMeta } from "./meta";
import type { Repo, ScanResult } from "./types";

export const DEFAULT_IGNORE = [
  "node_modules",
  "dist",
  "build",
  "target",
  "vendor",
  ".venv",
  "venv",
  "__pycache__",
  ".next",
  ".cache",
  ".Trash",
  "Library",
];

/** Find directories containing a .git entry (dir or file — worktrees count).
 *  Does not descend below a found repo. */
export async function findRepoDirs(
  root: string,
  opts: { maxDepth?: number; ignore?: string[] } = {},
): Promise<string[]> {
  const maxDepth = opts.maxDepth ?? 4;
  const ignore = new Set(opts.ignore ?? DEFAULT_IGNORE);
  const found: string[] = [];
  // Real paths already walked — symlinks are followed, so without this a
  // link pointing at an ancestor would loop forever.
  const seen = new Set<string>();

  async function walk(dir: string, depth: number): Promise<void> {
    const real = await realpath(dir).catch(() => dir);
    if (seen.has(real)) return;
    seen.add(real);
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    if (entries.some((e) => e.name === ".git")) {
      found.push(dir);
      return;
    }
    if (depth >= maxDepth) return;
    // readdir reports symlinks as links, not directories; a symlinked folder
    // is a normal way to file a repo, so resolve those instead of skipping.
    const visible = entries.filter(
      (e) => !e.name.startsWith(".") && !ignore.has(e.name),
    );
    const plain = visible.filter((e) => e.isDirectory()).map((e) => e.name);
    const linked: string[] = [];
    for (const e of visible.filter((e) => e.isSymbolicLink())) {
      const target = await stat(join(dir, e.name)).catch(() => null);
      if (target?.isDirectory()) linked.push(e.name);
    }
    // Real directories first, so a repo reachable both directly and through a
    // symlink always gets the same id instead of racing for it.
    await Promise.all(plain.map((name) => walk(join(dir, name), depth + 1)));
    await Promise.all(linked.map((name) => walk(join(dir, name), depth + 1)));
  }

  const rootStat = await stat(root).catch(() => null);
  if (!rootStat?.isDirectory()) throw new Error(`not a directory: ${root}`);
  await walk(root, 0);
  return found.sort();
}

async function withLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = Array.from({ length: items.length });
  let next = 0;
  async function worker(): Promise<void> {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i] as T);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker),
  );
  return results;
}

export function repoId(root: string, repoPath: string): string {
  const rel = relative(root, repoPath);
  return rel === "" ? "." : rel;
}

export async function scan(
  root: string,
  opts: { maxDepth?: number; ignore?: string[] } = {},
): Promise<ScanResult> {
  const dirs = await findRepoDirs(root, opts);
  const repos = await withLimit(dirs, 8, async (dir): Promise<Repo> => {
    const id = repoId(root, dir);
    // Started here, awaited below: the meta read is its own file and process
    // work, so it overlaps getStatus instead of queueing in front of it. It
    // also stays outside the catch — a repo whose status will not parse still
    // has a remote worth linking to.
    const meta = readMeta(dir);
    let status = null;
    let error: string | undefined;
    try {
      status = await getStatus(dir);
    } catch (err) {
      error = String(err);
    }
    return {
      id,
      name: basename(dir),
      path: dir,
      group: id === "." ? "" : (id.split("/")[0] ?? ""),
      ...(await meta),
      status,
      ...(error === undefined ? {} : { error }),
    };
  });
  return { root, repos, scannedAt: Date.now() };
}

/** Re-read a single repo (after a mutation or fs event). */
export async function refreshRepo(root: string, repo: Repo): Promise<Repo> {
  try {
    return { ...repo, status: await getStatus(repo.path), error: undefined };
  } catch (err) {
    return { ...repo, status: null, error: String(err) };
  }
}
