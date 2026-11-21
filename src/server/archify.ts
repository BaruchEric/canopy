/**
 * Diagrams of a repo, their Bun half (FR-071): lists, reads and removes the
 * diagrams under a checkout's `.archify/`, keeps that folder out of git,
 * and gives a diagram run the env canopy's copy of Archify (lib/archify)
 * needs. The run's spec, the receipt reader and the words are
 * core/archify.ts.
 *
 * A clone may commit an `.archify/` of its own, so nothing here trusts what
 * is in it: names must be plain, links are never followed, every page
 * resolves inside the folder, receipts give only a file name to match, and
 * the page frames a diagram in a sandboxed iframe at an opaque origin.
 */

import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync, type Dirent } from "node:fs";
import { join } from "node:path";
import { claudeBinary } from "../core/claudedrive";
import { exec } from "../core/exec";
import {
  ARCHIFY_FOLDER,
  ARCHIFY_HTML_MAX,
  isPageName,
  isPlainName,
  parseFinalizeSummary,
  titleOfPage,
  typeOfFolder,
  type ArchifyDiagram,
  type FinalizeSummary,
} from "../core/archify";
import { floorplanNode, floorplanPath, realRoot } from "./floorplan";

/** canopy's copy of the plugin, which a diagram run loads with --plugin-dir */
export const ARCHIFY_PLUGIN = join(import.meta.dir, "../../lib/archify");
/** the skill inside it, where bin/archify.mjs is */
export const ARCHIFY_SKILL = join(ARCHIFY_PLUGIN, "skills", "archify");

/** A refusal the route answers 400 with: the words say what to do. */
export class ArchifyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArchifyError";
  }
}

/** the most diagrams a list reads, newest kept */
const LIST_MAX = 200;
/** how much of a page the list reads for its <title> */
const HEAD_BYTES = 8 * 1024;

/** The variables a diagram run gets: node's and claude's folders first on
 *  PATH (bun stands in for node where there is none, as for Floorplan),
 *  and Archify's update check off, since canopy updates its own copy. */
export function archifyEnv(node = floorplanNode()): Record<string, string> {
  return {
    PATH: floorplanPath(node, claudeBinary(), process.env["PATH"] ?? ""),
    ARCHIFY_UPDATE_CHECK_DISABLED: "1",
  };
}

/** lstat that answers null for a missing path */
const lst = (path: string) => lstatSync(path, { throwIfNoEntry: false }) ?? null;

const entries = (dir: string): Dirent[] => {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
};

/** The folders under `.archify/` the repo tracks, by name. */
async function trackedFolders(real: string): Promise<Set<string>> {
  const r = await exec(["git", "-C", real, "ls-files", "-z", "--", ARCHIFY_FOLDER], { timeoutMs: 10_000 });
  const out = new Set<string>();
  if (r.code !== 0) return out;
  for (const path of r.stdout.split("\0")) {
    const part = path.split("/")[1];
    if (part && path.split("/").length > 2) out.add(part);
  }
  return out;
}

/** Whether a checkout has an origin remote, which Archify's source
 *  evidence needs (its repository-evidence check reads `git remote get-url
 *  origin`). */
export async function hasOrigin(root: string): Promise<boolean> {
  const r = await exec(["git", "-C", root, "remote", "get-url", "origin"], { timeoutMs: 10_000 });
  return r.code === 0 && r.stdout.trim() !== "";
}

/** finalize's newest summary receipt in a folder or its review-<n>
 *  folders, read; null when none is there or none reads. */
function newestSummary(folder: string): FinalizeSummary | null {
  const found: { path: string; at: number }[] = [];
  const look = (dir: string, depth: number): void => {
    for (const e of entries(dir)) {
      const path = join(dir, e.name);
      if (e.isFile() && e.name.endsWith(".finalize-summary.json")) found.push({ path, at: statSync(path).mtimeMs });
      else if (depth === 0 && e.isDirectory() && /^review-\d+$/.test(e.name)) look(path, 1);
    }
  };
  look(folder, 0);
  found.sort((a, b) => b.at - a.at);
  for (const f of found) {
    try {
      const parsed = parseFinalizeSummary(JSON.parse(readFileSync(f.path, "utf8")));
      if (parsed) return parsed;
    } catch {
      // a receipt half written or not JSON: try the next
    }
  }
  return null;
}

/** A diagram folder's page and its facts: the page finalize's newest
 *  receipt names when it is there, else the newest page. Plain files only;
 *  a link is never a page. */
function pageOf(folder: string): { file: string; bytes: number; at: number; summary: FinalizeSummary | null } | null {
  const pages = entries(folder)
    .filter((e) => e.isFile() && isPageName(e.name))
    .map((e) => {
      const s = statSync(join(folder, e.name));
      return { file: e.name, bytes: s.size, at: s.mtimeMs };
    })
    .sort((a, b) => b.at - a.at);
  const newest = pages[0];
  if (!newest) return null;
  const summary = newestSummary(folder);
  const named = summary?.file ? pages.find((p) => p.file === summary.file) : undefined;
  return { ...(named ?? newest), summary };
}

/** a page's first few kilobytes, as text */
const headOf = (path: string): Promise<string> =>
  Bun.file(path)
    .slice(0, HEAD_BYTES)
    .text()
    .catch(() => "");

/** A checkout's diagrams, newest first: every plain folder under
 *  `.archify/` with a page in it. None when there is no such folder. */
export async function listDiagrams(root: string): Promise<ArchifyDiagram[]> {
  const real = realRoot(root);
  const dir = join(real, ARCHIFY_FOLDER);
  const top = lst(dir);
  if (!top?.isDirectory()) return [];
  const tracked = await trackedFolders(real);
  const out: ArchifyDiagram[] = [];
  for (const e of entries(dir)) {
    if (!e.isDirectory() || !isPlainName(e.name)) continue;
    const page = pageOf(join(dir, e.name));
    if (!page) continue;
    const title = titleOfPage(await headOf(join(dir, e.name, page.file)));
    out.push({
      id: e.name,
      file: page.file,
      title,
      type: page.summary?.type ?? typeOfFolder(e.name),
      bytes: page.bytes,
      builtAt: Math.round(page.at),
      checks: page.summary?.checks ?? null,
      ...(tracked.has(e.name) ? { tracked: true as const } : {}),
    });
  }
  out.sort((a, b) => b.builtAt - a.builtAt || a.id.localeCompare(b.id));
  return out.slice(0, LIST_MAX);
}

/** A diagram's folder, refused unless it is a plain name that is a real
 *  folder (not a link) under the checkout's own `.archify/`. */
function folderOf(root: string, id: string): { real: string; folder: string } {
  if (!isPlainName(id)) throw new ArchifyError("a diagram is named by its folder under .archify");
  const real = realRoot(root);
  const top = join(real, ARCHIFY_FOLDER);
  if (!lst(top)?.isDirectory()) throw new ArchifyError("there are no diagrams here yet");
  const folder = join(top, id);
  if (!lst(folder)?.isDirectory()) throw new ArchifyError(`there is no diagram ${id}`);
  return { real, folder };
}

/** A diagram's page on disk, ready to send: inside `.archify/` once every
 *  link is resolved, and no heavier than ARCHIFY_HTML_MAX. */
export function diagramPage(root: string, id: string): { path: string; file: string; bytes: number } {
  const { real, folder } = folderOf(root, id);
  const page = pageOf(folder);
  if (!page) throw new ArchifyError(`${id} has no page yet`);
  const path = join(folder, page.file);
  const inside = realpathSync(join(real, ARCHIFY_FOLDER)) + "/";
  if (!realpathSync(path).startsWith(inside)) throw new ArchifyError(`${id}/${page.file} leads outside .archify`);
  if (page.bytes > ARCHIFY_HTML_MAX) throw new ArchifyError(`${id}/${page.file} is ${Math.round(page.bytes / 1024 / 1024)} MB, past the ${ARCHIFY_HTML_MAX / 1024 / 1024} MB canopy sends`);
  return { path, file: page.file, bytes: page.bytes };
}

/** Removes a diagram's folder, refused when the repo tracks it: a
 *  committed diagram goes with git, as any tracked file does. */
export async function removeDiagram(root: string, id: string): Promise<void> {
  const { real, folder } = folderOf(root, id);
  if ((await trackedFolders(real)).has(id)) throw new ArchifyError(`the repo tracks .archify/${id}; remove it with git`);
  rmSync(folder, { recursive: true, force: true });
}

/** what the folder's own .gitignore says: everything in it, itself too */
export const ARCHIFY_IGNORE = "# canopy's Archify diagrams (FR-071) stay out of git\n*\n";

/** Keeps `.archify/` out of git before a run writes there, the way
 *  Floorplan's folder keeps itself out: a `.gitignore` of `*` inside it,
 *  written only when the folder has none and the repo tracks nothing
 *  under it (a repo that commits its diagrams keeps doing so). Refuses a
 *  `.archify` that is a link, which canopy never writes through. */
export async function keepOutOfGit(root: string): Promise<void> {
  const real = realRoot(root);
  const dir = join(real, ARCHIFY_FOLDER);
  const top = lst(dir);
  if (top?.isSymbolicLink()) throw new ArchifyError(".archify is a link, and canopy will not write through it");
  if (top && !top.isDirectory()) throw new ArchifyError(".archify is a file, not a folder");
  if (existsSync(join(dir, ".gitignore"))) return;
  const r = await exec(["git", "-C", real, "ls-files", "--", ARCHIFY_FOLDER], { timeoutMs: 10_000 });
  if (r.code !== 0 || r.stdout.trim()) return;
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, ".gitignore"), ARCHIFY_IGNORE);
}
