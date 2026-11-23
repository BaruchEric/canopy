/**
 * Architecture Diagnosis of a repo, its Bun half (FR-075): runs Archify's
 * Code Analysis on a checkout, reads what it wrote under the checkout's
 * `.archify/diagnosis/`, and removes it. The CLI's arguments, the config,
 * the readers and the words are core/diagnosis.ts.
 *
 * No model runs and nothing asks: the server calls `code-analysis prepare`
 * of canopy's own copy (lib/archify) with arguments it builds itself. The
 * analysis reads source and never runs the repo's code, hooks or package
 * scripts. It takes no config from the checkout: canopy writes one that
 * holds excludes alone, so its duplicate detection, which runs a program
 * the config names, stays off. One analysis goes per checkout at a time,
 * in the background; the page reads the route again until it ends.
 *
 * A clone may commit an `.archify/diagnosis/` of its own, so nothing here
 * trusts what is in it: links are never followed, the page must resolve
 * inside `.archify`, the overview is read as data, and the page is framed
 * in a sandboxed iframe at an opaque origin. canopy writes and removes the
 * folder only while git tracks nothing in it.
 */

import { lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  DIAGNOSIS_CONFIG,
  DIAGNOSIS_HTML_MAX,
  DIAGNOSIS_OVERVIEW,
  DIAGNOSIS_PAGE,
  DIAGNOSIS_PATH,
  DIAGNOSIS_RUN_FOLDER,
  DIAGNOSIS_SETTINGS,
  diagnosisArgs,
  diagnosisConfig,
  ignoredGlobs,
  parseDiagnosisSettings,
  parseOverview,
  parseReceipt,
  type DiagnosisFacts,
  type DiagnosisInfo,
  type DiagnosisPick,
  type DiagnosisSettings,
} from "../core/diagnosis";
import { ARCHIFY_FOLDER } from "../core/archify";
import { exec } from "../core/exec";
import { ARCHIFY_SKILL, ArchifyError, archifyEnv, keepOutOfGit } from "./archify";
import { floorplanNode, realRoot } from "./floorplan";

/** A refusal the route answers with: the words say what to do. `busy` is
 *  one that passes on its own, which the route answers 409. */
export class DiagnosisError extends Error {
  constructor(
    message: string,
    readonly busy = false,
  ) {
    super(message);
    this.name = "DiagnosisError";
  }
}

/** the analysis module in canopy's copy, whose default excludes a config replaces */
const MODULE_DEFAULTS = join(ARCHIFY_SKILL, "modules", "code-analysis", "config", "defaults.json");

/** how long one analysis may take: seconds for most repos, minutes for a
 *  large one, and a Rust run's first use builds Archify's helper */
const RUN_MS = 15 * 60_000;
/** the most of an overview or a settings file canopy reads */
const JSON_MAX = 16 * 1024 * 1024;

/** what the folder's own .gitignore says: everything in it, itself too */
export const DIAGNOSIS_IGNORE = "# canopy's Architecture Diagnosis (FR-075) stays out of git\n*\n";

/** the analyses going, by the checkout's real path, and since when */
const live = new Map<string, { since: number; done: Promise<void> }>();
/** why the last analysis of a checkout failed, until one succeeds */
const failures = new Map<string, string>();

/** lstat that answers null for a missing path */
const lst = (path: string) => lstatSync(path, { throwIfNoEntry: false }) ?? null;

/** A small JSON file, read as data: a plain file (never a link) no heavier
 *  than JSON_MAX, else null. */
function readJson(path: string): unknown {
  const s = lst(path);
  if (!s?.isFile() || s.size > JSON_MAX) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch {
    return null;
  }
}

/** The repo's own settings, from the working tree; the defaults when the
 *  file is missing or does not read. */
export const diagnosisSettings = (real: string): DiagnosisSettings => parseDiagnosisSettings(readJson(join(real, DIAGNOSIS_SETTINGS)));

/** Whether the repo tracks anything in the folder. */
async function isTracked(real: string): Promise<boolean> {
  const r = await exec(["git", "-C", real, "ls-files", "--", DIAGNOSIS_PATH], { timeoutMs: 10_000 });
  return r.code === 0 && r.stdout.trim() !== "";
}

/** The page of a checkout's analysis: a plain file reached through plain
 *  folders, inside `.archify` once every link is resolved. Null when there
 *  is none. */
function pageOf(real: string): { path: string; bytes: number; at: number } | null {
  const folders = [join(real, ARCHIFY_FOLDER), join(real, DIAGNOSIS_PATH), join(real, DIAGNOSIS_PATH, DIAGNOSIS_RUN_FOLDER)];
  if (!folders.every((f) => lst(f)?.isDirectory())) return null;
  const path = join(real, DIAGNOSIS_PATH, DIAGNOSIS_RUN_FOLDER, DIAGNOSIS_PAGE);
  const s = lst(path);
  if (!s?.isFile()) return null;
  if (!realpathSync(path).startsWith(realpathSync(join(real, ARCHIFY_FOLDER)) + "/")) return null;
  return { path, bytes: s.size, at: s.mtimeMs };
}

/** A checkout's diagnosis: the analysis on disk, the one going, the last
 *  failure and the repo's settings. */
export async function diagnosisInfo(root: string): Promise<DiagnosisInfo> {
  const real = realRoot(root);
  const page = pageOf(real);
  const facts: DiagnosisFacts | null = page ? parseOverview(readJson(join(real, DIAGNOSIS_PATH, DIAGNOSIS_RUN_FOLDER, DIAGNOSIS_OVERVIEW))) : null;
  return {
    report: page ? { builtAt: Math.round(page.at), bytes: page.bytes, facts } : null,
    running: live.get(real)?.since ?? null,
    failed: failures.get(real) ?? null,
    settings: diagnosisSettings(real),
    ...(page && (await isTracked(real)) ? { tracked: true as const } : {}),
  };
}

/** The analysis's page on disk, ready to send, no heavier than
 *  DIAGNOSIS_HTML_MAX. */
export function diagnosisPage(root: string): { path: string; bytes: number } {
  const page = pageOf(realRoot(root));
  if (!page) throw new DiagnosisError("there is no diagnosis here yet");
  if (page.bytes > DIAGNOSIS_HTML_MAX) {
    throw new DiagnosisError(`the page is ${Math.round(page.bytes / 1024 / 1024)} MB, past the ${DIAGNOSIS_HTML_MAX / 1024 / 1024} MB canopy sends; leave folders out with "exclude" in ${DIAGNOSIS_SETTINGS} and analyze again`);
  }
  return { path: page.path, bytes: page.bytes };
}

/** What git ignores in the checkout, as the analysis's globs: a kept
 *  worktree, a build folder, another tool's output. None when git cannot say. */
async function ignoredIn(real: string): Promise<string[]> {
  const r = await exec(["git", "-C", real, "ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z"], { timeoutMs: 30_000 });
  return r.code === 0 ? ignoredGlobs(r.stdout.split("\0")) : [];
}

/** The folder ready for a run: `.archify` kept out of git the way a
 *  diagram run keeps it, the diagnosis folder made with a `.gitignore` of
 *  its own (a repo that commits its diagrams has no ignore above it), and
 *  what a run cut short left behind cleared. Refuses a link in the way. */
async function readyFolder(real: string): Promise<string> {
  try {
    await keepOutOfGit(real);
  } catch (err) {
    if (err instanceof ArchifyError) throw new DiagnosisError(err.message);
    throw err;
  }
  const out = join(real, DIAGNOSIS_PATH);
  const there = lst(out);
  if (there && !there.isDirectory()) throw new DiagnosisError(`${DIAGNOSIS_PATH} is a link or a file, and canopy will not write through it`);
  mkdirSync(out, { recursive: true });
  if (!lst(join(out, ".gitignore"))) writeFileSync(join(out, ".gitignore"), DIAGNOSIS_IGNORE);
  for (const name of readdirSync(out)) if (name.startsWith(`${DIAGNOSIS_RUN_FOLDER}.next-`)) rmSync(join(out, name), { recursive: true, force: true });
  const run = lst(join(out, DIAGNOSIS_RUN_FOLDER));
  if (run && !run.isDirectory()) throw new DiagnosisError(`${DIAGNOSIS_PATH}/${DIAGNOSIS_RUN_FOLDER} is a link or a file, and canopy will not write through it`);
  return out;
}

/** What a finished run leaves that canopy has no use for: the run before
 *  (the page already holds the comparison with it) and the raw facts, the
 *  captured source that Archify's task commands read and the page embeds.
 *  Together they are most of the folder's weight. */
function trim(out: string): void {
  rmSync(join(out, `${DIAGNOSIS_RUN_FOLDER}.previous`), { recursive: true, force: true });
  rmSync(join(out, DIAGNOSIS_RUN_FOLDER, "raw-facts.json"), { force: true });
}

/** One analysis, start to end: the settings, the config, the CLI. Throws a
 *  DiagnosisError with the analysis's own words when it fails. */
async function analyze(real: string, pick: DiagnosisPick): Promise<void> {
  const out = await readyFolder(real);
  const settings = diagnosisSettings(real);
  const config = join(out, DIAGNOSIS_CONFIG);
  writeFileSync(config, `${JSON.stringify(diagnosisConfig(readJson(MODULE_DEFAULTS), await ignoredIn(real), settings), null, 2)}\n`);
  const node = floorplanNode();
  const args = diagnosisArgs({ cli: join(ARCHIFY_SKILL, "bin", "archify.mjs"), root: real, out, config, language: pick === "auto" ? settings.language : pick });
  const began = Date.now();
  const r = await exec([node, ...args], { cwd: real, timeoutMs: RUN_MS, env: archifyEnv(node) });
  // exec ends a command at its timeout and answers the code it died with
  if (r.code !== 0 && Date.now() - began >= RUN_MS) throw new DiagnosisError(`the analysis ran past ${RUN_MS / 60_000} minutes and was stopped; leave folders out with "exclude" in ${DIAGNOSIS_SETTINGS}`);
  const said = parseReceipt(r.stdout, r.code);
  if (!said.ok) throw new DiagnosisError(said.message);
  trim(out);
}

/** Starts an analysis of the checkout in the background and answers when
 *  it started. Refused while one goes there, and for a folder the repo
 *  tracks. `diagnosisInfo` says when it ended and why it failed. */
export async function startDiagnosis(root: string, pick: DiagnosisPick): Promise<number> {
  const real = realRoot(root);
  if (live.has(real)) throw new DiagnosisError("an analysis is going on this checkout already", true);
  if (await isTracked(real)) throw new DiagnosisError(`the repo tracks ${DIAGNOSIS_PATH}; canopy will not write over it`);
  // checked again: the await above let another start in
  if (live.has(real)) throw new DiagnosisError("an analysis is going on this checkout already", true);
  const since = Date.now();
  const done = analyze(real, pick).then(
    () => void failures.delete(real),
    (err: unknown) => void failures.set(real, err instanceof Error ? err.message : String(err)),
  );
  live.set(real, { since, done });
  void done.finally(() => live.delete(real));
  return since;
}

/** Resolves when the checkout's analysis ends, at once when none goes. */
export const diagnosisDone = (root: string): Promise<void> => live.get(realRoot(root))?.done ?? Promise.resolve();

/** Removes the checkout's analysis, refused while one goes and when the
 *  repo tracks the folder: a committed one goes with git. */
export async function removeDiagnosis(root: string): Promise<void> {
  const real = realRoot(root);
  if (live.has(real)) throw new DiagnosisError("an analysis is going on this checkout; remove it once it ends", true);
  const out = join(real, DIAGNOSIS_PATH);
  const there = lst(out);
  if (!there) throw new DiagnosisError("there is no diagnosis here yet");
  if (!lst(join(real, ARCHIFY_FOLDER))?.isDirectory()) throw new DiagnosisError(`${ARCHIFY_FOLDER} is a link, and canopy will not remove through it`);
  if (await isTracked(real)) throw new DiagnosisError(`the repo tracks ${DIAGNOSIS_PATH}; remove it with git`);
  // a link is removed as a link, never followed
  rmSync(out, { recursive: true, force: true });
  failures.delete(real);
}
