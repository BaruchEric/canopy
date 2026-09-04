import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { onHost } from "./exec";
import { tildeQuote } from "./host";
import type { Listing } from "./types";

/** `~` and `~/x` as the local home, else the path as given. */
export const expandHome = (p: string): string =>
  p === "~" || p === "" ? homedir() : p.startsWith("~/") ? join(homedir(), p.slice(2)) : p;

const parentOf = (p: string): string | null => (p === "/" ? null : dirname(p));

/** The visible subfolders of a local folder, each flagged when it holds a
 *  `.git`. Hidden folders stay out, as they do in the scan. */
export async function browseLocal(path: string): Promise<Listing> {
  const abs = resolve(expandHome(path));
  const st = await stat(abs).catch(() => null);
  if (!st?.isDirectory()) throw new Error(`not a folder: ${abs}`);
  const entries = await readdir(abs, { withFileTypes: true });
  const dirs: Listing["dirs"] = [];
  for (const e of entries) {
    if (e.name.startsWith(".")) continue;
    let isDir = e.isDirectory();
    if (!isDir && e.isSymbolicLink()) {
      const target = await stat(join(abs, e.name)).catch(() => null);
      isDir = target?.isDirectory() ?? false;
    }
    if (!isDir) continue;
    const repo = await stat(join(abs, e.name, ".git"))
      .then(() => true)
      .catch(() => false);
    dirs.push({ name: e.name, repo });
  }
  dirs.sort((a, b) => a.name.localeCompare(b.name));
  return { path: abs, parent: parentOf(abs), dirs };
}

/** One ssh round trip: the folder's real path, then one line per visible
 *  subfolder, `r` for one holding a `.git` and `d` otherwise. */
export function browseCommand(path: string): string[] {
  const loop =
    'for d in */; do d=${d%/}; [ -d "$d" ] || continue; ' +
    'if [ -e "$d/.git" ]; then printf "r %s\\n" "$d"; else printf "d %s\\n" "$d"; fi; done';
  return ["sh", "-c", `cd ${tildeQuote(path)} && pwd -P && ${loop}`];
}

export function parseBrowse(text: string): Listing {
  const [first = "", ...rest] = text.split("\n");
  const path = first.trim();
  if (!path.startsWith("/")) throw new Error("could not read the folder");
  const dirs: Listing["dirs"] = [];
  for (const line of rest) {
    const kind = line[0];
    const name = line.slice(2);
    if ((kind === "r" || kind === "d") && name) dirs.push({ name, repo: kind === "r" });
  }
  dirs.sort((a, b) => a.name.localeCompare(b.name));
  return { path, parent: parentOf(path), dirs };
}

export class SshError extends Error {}

export async function browseRemote(host: string, path: string): Promise<Listing> {
  const r = await onHost(host, browseCommand(path), { timeoutMs: 20_000 });
  if (r.code === 255) {
    throw new SshError(`ssh ${host}: ${r.stderr.trim() || "connection failed"}`);
  }
  if (r.code !== 0) throw new Error(r.stderr.trim() || `not a folder: ${path}`);
  return parseBrowse(r.stdout);
}
