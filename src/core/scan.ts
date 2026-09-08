import { readdir, realpath, stat } from "node:fs/promises";
import { basename, dirname, join, relative } from "node:path";
import { onHost } from "./exec";
import { forgeRepo, listForgeRepos } from "./forge";
import { getStatus } from "./git";
import { parseLocator, toLocator } from "./host";
import { readMeta } from "./meta";
import { LAUNCH_SOURCE, type Repo, type ScanResult, type Source } from "./types";

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

export interface ScanOptions {
  maxDepth?: number;
  ignore?: string[];
}

/** Find directories containing a .git entry (dir or file — worktrees count).
 *  Does not descend below a found repo. */
export async function findRepoDirs(
  root: string,
  opts: ScanOptions = {},
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

/* ---------- the same walk on another host, as one `find` ---------- */

/** The `find` that mirrors `findRepoDirs`: every `.git` entry down to the
 *  depth limit, not descending into hidden or ignored folders. `find` still
 *  walks below a repo root, so `pruneNested` finishes the job. */
export function findCommand(
  root: string,
  opts: ScanOptions = {},
): string[] {
  const maxDepth = opts.maxDepth ?? 4;
  const ignore = opts.ignore ?? DEFAULT_IGNORE;
  const skip = [".*", ...ignore].flatMap((n, i) =>
    i === 0 ? ["-name", n] : ["-o", "-name", n],
  );
  return [
    "find",
    "-L",
    root,
    "-mindepth",
    "1",
    "-maxdepth",
    String(maxDepth + 1),
    "(",
    "-name",
    ".git",
    "-print0",
    "-prune",
    ")",
    "-o",
    "(",
    "(",
    ...skip,
    ")",
    "-prune",
    ")",
  ];
}

/** Drops every dir that sits inside another dir in the list, so a repo
 *  vendored under a repo counts once, as the local walk would have it. */
export function pruneNested(dirs: string[]): string[] {
  const out: string[] = [];
  for (const d of [...new Set(dirs)].sort()) {
    const last = out[out.length - 1];
    if (last !== undefined && (d === last || d.startsWith(last + "/"))) continue;
    out.push(d);
  }
  return out;
}

export async function findRepoDirsRemote(
  host: string,
  root: string,
  opts: ScanOptions = {},
): Promise<string[]> {
  const r = await onHost(host, findCommand(root, opts), { timeoutMs: 120_000 });
  // find exits 1 after any unreadable folder while still listing the rest;
  // only a silent failure (ssh refused, no such root) is worth stopping on.
  if (r.code !== 0 && !r.stdout) {
    throw new Error(r.stderr.trim() || `find failed on ${host}`);
  }
  const gits = r.stdout.split("\0").filter(Boolean);
  return pruneNested(gits.map((g) => dirname(g)));
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

/** The id a repo gets under a source: bare under the launch root, and
 *  `<source id>:<rel>` elsewhere so two sources holding a `web-apps/ripe`
 *  never collide. */
export function sourceRepoId(source: Source, rel: string): string {
  return source.launch ? rel : `${source.id}:${rel}`;
}

/** The path relative to its source root, back out of a repo id. */
export function repoRel(repo: Pick<Repo, "id" | "source">): string {
  return repo.source === LAUNCH_SOURCE
    ? repo.id
    : repo.id.slice(repo.source.length + 1);
}

/** The folder heading a repo files under. Under the launch root that is its
 *  top-level folder, as before; under an extra source, the source's label
 *  and then that folder, so a second `~/dev` reads as `wsl:dev/web-apps`. */
export function sourceGroup(source: Source, rel: string): string {
  const top = rel === "." ? "" : (rel.split("/")[0] ?? "");
  if (source.launch) return top;
  return top ? `${source.label}/${top}` : source.label;
}

/** The launch root as a source, for the CLI and for the server's first one. */
export function launchSource(root: string): Source {
  return {
    id: LAUNCH_SOURCE,
    kind: "local",
    label: basename(root) || root,
    path: root,
    launch: true,
  };
}

/** Every repo under one source, with status and meta read. Throws when the
 *  root cannot be listed at all; a repo that will not read becomes a card
 *  with an error instead. */
export async function scanSource(
  source: Source,
  opts: ScanOptions = {},
): Promise<Repo[]> {
  // A forge has no folder to walk: its API is the listing, and what comes
  // back are repos on a server, with no working copy to read a status from.
  if (source.kind === "forgejo") {
    const listed = await listForgeRepos(source);
    return listed.map((api) => forgeRepo(source, api));
  }
  const host = source.kind === "ssh" ? source.host : null;
  const dirs =
    host === null
      ? await findRepoDirs(source.path, opts)
      : await findRepoDirsRemote(host, source.path, opts);
  return withLimit(dirs, 8, async (dir): Promise<Repo> => {
    const rel = repoId(source.path, dir);
    const id = sourceRepoId(source, rel);
    const path = toLocator(host, dir);
    // Started here, awaited below: the meta read is its own file and process
    // work, so it overlaps getStatus instead of queueing in front of it. It
    // also stays outside the catch — a repo whose status will not parse still
    // has a remote worth linking to.
    const meta = readMeta(path);
    let status = null;
    let error: string | undefined;
    try {
      status = await getStatus(path);
    } catch (err) {
      error = String(err);
    }
    return {
      id,
      name: basename(dir),
      path,
      group: sourceGroup(source, rel),
      source: source.id,
      ...(host === null ? {} : { host }),
      ...(await meta),
      status,
      ...(error === undefined ? {} : { error }),
    };
  });
}

/** One local root on its own: the CLI's tree, and the tests. */
export async function scan(
  root: string,
  opts: ScanOptions = {},
): Promise<ScanResult> {
  const source = launchSource(root);
  const repos = await scanSource(source, opts);
  const scannedAt = Date.now();
  return {
    root,
    sources: [{ ...source, repos: repos.length, scannedAt }],
    repos,
    scannedAt,
  };
}

/** Re-read a single repo (after a mutation or fs event). A forge repo has
 *  no working copy to re-read: only its source's next scan changes it. */
export async function refreshRepo(repo: Repo): Promise<Repo> {
  if (repo.forge) return repo;
  try {
    return { ...repo, status: await getStatus(repo.path), error: undefined };
  } catch (err) {
    return { ...repo, status: null, error: String(err) };
  }
}

/** Whether a repo lives on another host: the card and the openers care. */
export const repoHost = (repo: Pick<Repo, "path">): string | null =>
  parseLocator(repo.path).host;
