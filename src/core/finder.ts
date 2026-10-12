/**
 * The files section's server half: the files of a repo's working tree, and
 * one file's bytes, wherever the repo lives. Tested in finder.test.ts.
 */
import { realpath, stat } from "node:fs/promises";
import { join, sep } from "node:path";
import { git, onHost } from "./exec";
import { parseLocator, tildeQuote } from "./host";
import type { RepoFiles } from "./types";

/** how many paths one listing hands back before it is cut */
export const FILES_LIMIT = 50_000;
/** the most bytes one read hands back: a local file streams, a remote one
 *  rides ssh as base64 and is held whole, so it gets less */
export const RAW_MAX = { local: 200 * 1024 * 1024, remote: 25 * 1024 * 1024 };

export class FinderError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** A path from the repo's root, or null for anything that could step out of
 *  it: empty, absolute, a `..` part, a backslash or a NUL. */
export function safeRel(p: string): string | null {
  if (p === "" || p.startsWith("/") || p.includes("\0") || p.includes("\\")) return null;
  const parts = p.split("/");
  if (parts.some((x) => x === "" || x === "." || x === "..")) return null;
  return p;
}

/** `git ls-files -z` output as a sorted list of distinct paths, cut at
 *  `limit`. An unmerged path comes once per stage, so it is folded. */
export function parseFiles(out: string, limit = FILES_LIMIT): RepoFiles {
  const seen = new Set<string>();
  for (const p of out.split("\0")) if (p) seen.add(p);
  const all = [...seen].sort();
  return { files: all.slice(0, limit), truncated: all.length > limit };
}

/** Every file in the working tree that git does not ignore: what is tracked
 *  and what is new. Ignored paths (node_modules, dist, .env) stay out, so a
 *  listing is the repo's own files and never its build or its secrets. */
export async function listFiles(repoPath: string, limit = FILES_LIMIT): Promise<RepoFiles> {
  const r = await git(repoPath, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], 30_000);
  if (r.code !== 0) throw new FinderError(500, r.stderr.trim() || "git ls-files failed");
  return parseFiles(r.stdout, limit);
}

/** One file's bytes, its size and when it last changed. */
export interface RawFile {
  body: Blob | Uint8Array;
  size: number;
  mtime: number | null;
}

const tooBig = (rel: string, size: number, max: number) =>
  new FinderError(413, `${rel} is ${size} bytes, more than the ${max} this view reads`);

/** Read one file under a repo, refusing anything that resolves outside it
 *  (a symlink to elsewhere included) and anything over `max` bytes. */
export async function readRaw(repoPath: string, rel: string, max: number): Promise<RawFile> {
  const { host, path } = parseLocator(repoPath);
  if (host === null) return readLocal(path, rel, max);
  return readRemote(host, path, rel, Math.min(max, RAW_MAX.remote));
}

async function readLocal(root: string, rel: string, max: number): Promise<RawFile> {
  const cap = Math.min(max, RAW_MAX.local);
  const top = await realpath(root).catch(() => null);
  if (top === null) throw new FinderError(404, `no folder at ${root}`);
  const real = await realpath(join(top, rel)).catch(() => null);
  if (real === null) throw new FinderError(404, `no file at ${rel}`);
  if (!real.startsWith(top + sep)) throw new FinderError(403, `${rel} leads outside the repo`);
  const st = await stat(real);
  if (!st.isFile()) throw new FinderError(400, `${rel} is not a file`);
  if (st.size > cap) throw tooBig(rel, st.size, cap);
  return { body: Bun.file(real), size: st.size, mtime: st.mtimeMs };
}

/** One ssh round trip that checks the file resolves inside the repo, prints
 *  its size, and when it fits, its bytes as base64. Exit codes: 3 no repo
 *  folder, 4 no such file, 5 outside the repo, 6 over the cap (the size was
 *  printed). `realpath` is coreutils on Linux and in macOS since 13. */
export function rawCommand(root: string, rel: string, max: number): string[] {
  const script = [
    `cd ${tildeQuote(root)} 2>/dev/null || exit 3`,
    "top=$(pwd -P)",
    '[ -f "./$1" ] || exit 4',
    'p=$(realpath "./$1") || exit 4',
    'case "$p" in "$top"/*) ;; *) exit 5 ;; esac',
    `n=$(wc -c < "$p" | tr -d ' ')`,
    'echo "$n"',
    `[ "$n" -le ${max} ] || exit 6`,
    'base64 < "$p"',
  ].join("\n");
  return ["sh", "-c", script, "sh", rel];
}

async function readRemote(host: string, root: string, rel: string, max: number): Promise<RawFile> {
  const r = await onHost(host, rawCommand(root, rel, max), { timeoutMs: 120_000 });
  const nl = r.stdout.indexOf("\n");
  const size = Number(nl < 0 ? r.stdout.trim() : r.stdout.slice(0, nl));
  if (r.code === 3) throw new FinderError(404, `no folder at ${root} on ${host}`);
  if (r.code === 4) throw new FinderError(404, `no file at ${rel}`);
  if (r.code === 5) throw new FinderError(403, `${rel} leads outside the repo`);
  if (r.code === 6) throw tooBig(rel, size, max);
  if (r.code === 255) throw new FinderError(502, `ssh ${host}: ${r.stderr.trim() || "connection failed"}`);
  if (r.code !== 0 || nl < 0) throw new FinderError(500, r.stderr.trim() || `could not read ${rel}`);
  const body = Buffer.from(r.stdout.slice(nl + 1), "base64");
  return { body: new Uint8Array(body), size: body.length, mtime: null };
}
