/**
 * The touched set per run and the words for the overlaps it finds. This file
 * is pure and browser-safe: the page draws the chips from it, and nothing
 * here holds or delays a run.
 */

import type { WrittenPaths } from "./explain";
import type { RepoFile, ReviewFile, Run, RunStep, RunTool } from "./types";

export const TOUCH_MAX = 500;
export const COLLISION_RESAY = 5;
export const PATHS_SHOWN = 5;

export interface Touched {
  run: string;
  /** the words chips and notes name the run by: its branch, else "<verb> run <id>" */
  name: string;
  /** the branch's id for a branch run, so the origin and its "fix it" runs read as one */
  origin?: string;
  /** FR-033's `Run.group`: members of one group never collide */
  group?: string;
  paths: Set<string>;
  /** directories a command moved or removed whole: `git mv src/a src/b`, `rm -r docs/old` */
  dirs: Set<string>;
  unknown: boolean;
}

export interface Collision {
  id: string;
  repoId: string;
  /** the run that just touched, and what it collided with */
  run: string;
  /** that run's name, as `Touched.name` */
  name: string;
  with: { kind: "run"; run: string; verb: string; name: string } | { kind: "branch"; origin: string; branch: string } | { kind: "checkout" };
  paths: string[];
  at: number;
}

/** one side a run is compared with */
export interface Side {
  touched: Touched;
  with: Collision["with"];
}

/** Normalize an absolute path without relying on a platform path module. */
function normalizeAbsolute(path: string): string {
  const parts: string[] = [];
  for (const part of path.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return `/${parts.join("/")}`;
}

/** `p` from `root`: the path under it, else `p` as given */
export function relPath(p: string, root: string): string {
  if (!p.startsWith("/")) return p;
  const abs = normalizeAbsolute(p);
  const base = normalizeAbsolute(root);
  if (abs === base) return ".";
  const prefix = base === "/" ? "/" : `${base}/`;
  return abs.startsWith(prefix) ? abs.slice(prefix.length) : p;
}

/** a Bash line's `WrittenPaths` as the step carries them: dirs with a trailing `/` */
export function toolTouch(w: WrittenPaths): Pick<RunTool, "paths" | "touchesUnknown"> {
  const paths = [...w.paths, ...w.dirs.map((path) => path.endsWith("/") ? path : `${path}/`)];
  const result: Pick<RunTool, "paths" | "touchesUnknown"> = {};
  if (paths.length) result.paths = paths;
  if (w.unknown) result.touchesUnknown = true;
  return result;
}

function addPath(t: Touched, path: string, folder = false): void {
  const isFolder = folder || path.endsWith("/");
  const value = isFolder && path.endsWith("/") ? path.slice(0, -1) : path;
  if (!value) return;
  const target = isFolder ? t.dirs : t.paths;
  if (target.has(value) || t.paths.size + t.dirs.size >= TOUCH_MAX) return;
  target.add(value);
}

/** extends `t` with one step and returns it; a tool step's `paths` only, nothing past TOUCH_MAX */
export function addStep(t: Touched, step: RunStep): Touched {
  if (step.kind !== "tool" || !step.tool) return t;
  if (step.tool.touchesUnknown) t.unknown = true;
  for (const path of step.tool.paths ?? []) addPath(t, path);
  return t;
}

/** the set from every step so far; `group` is `Run.group` once FR-033 ships */
export function touchedOf(run: Pick<Run, "id" | "verb" | "steps" | "branch">, group?: string): Touched {
  const touched: Touched = {
    run: run.id,
    name: run.branch?.name ?? `${run.verb} run ${run.id}`,
    ...(run.branch ? { origin: run.branch.origin } : {}),
    ...(group !== undefined ? { group } : {}),
    paths: new Set(),
    dirs: new Set(),
    unknown: false,
  };
  for (const step of run.steps) addStep(touched, step);
  return touched;
}

/** a queued or ready branch's set from its sort: each file's `path` and `from` */
export function fromFiles(run: string, origin: string, name: string, files: readonly Pick<ReviewFile, "path" | "from">[], group?: string): Touched {
  const touched: Touched = { run, origin, name, ...(group !== undefined ? { group } : {}), paths: new Set(), dirs: new Set(), unknown: false };
  for (const file of files) {
    addPath(touched, file.path);
    if (file.from) addPath(touched, file.from);
  }
  return touched;
}

/** the main checkout's set: `RepoStatus.files`; `run` is "checkout", `name` "your uncommitted changes" */
export function fromStatus(files: readonly Pick<RepoFile, "path">[]): Touched {
  const touched: Touched = { run: "checkout", name: "your uncommitted changes", paths: new Set(), dirs: new Set(), unknown: false };
  for (const file of files) addPath(touched, file.path);
  return touched;
}

/** "n files", or "500 files and more" once full */
export function touchedWords(t: Touched): string {
  const count = t.paths.size + t.dirs.size;
  const words = count >= TOUCH_MAX ? "500 files and more" : `${count} ${count === 1 ? "file" : "files"}`;
  return t.unknown ? `${words} and ran commands canopy could not read` : words;
}

const outside = (path: string): boolean => path.startsWith("/") || path.startsWith("~");
const insideDirectory = (path: string, dir: string): boolean => path === dir || path.startsWith(`${dir}/`);

/**
 * The paths both hold, plus any path of one under a dir of the other. [] for
 * the same run, origin or group, a full set on either side, and outside paths.
 */
export function overlap(a: Touched, b: Touched): string[] {
  if (a.run === b.run || (a.origin !== undefined && a.origin === b.origin) || (a.group !== undefined && a.group === b.group)) return [];
  if (a.paths.size + a.dirs.size >= TOUCH_MAX || b.paths.size + b.dirs.size >= TOUCH_MAX) return [];

  const matches = new Set<string>();
  for (const path of a.paths) {
    if (outside(path)) continue;
    if (b.paths.has(path) || [...b.dirs].some((dir) => !outside(dir) && insideDirectory(path, dir))) matches.add(path);
  }
  for (const path of b.paths) {
    if (outside(path)) continue;
    if ([...a.dirs].some((dir) => !outside(dir) && insideDirectory(path, dir))) matches.add(path);
  }
  for (const left of a.dirs) {
    if (outside(left)) continue;
    for (const right of b.dirs) {
      if (outside(right)) continue;
      if (insideDirectory(left, right)) matches.add(`${left}/`);
      else if (insideDirectory(right, left)) matches.add(`${right}/`);
    }
  }
  return [...matches].sort();
}

/** the pair's id, the same from either side: "a+b" sorted for two runs, "a+branch:q", "a+checkout" */
export function pairId(run: string, w: Collision["with"]): string {
  if (w.kind === "checkout") return `${run}+checkout`;
  if (w.kind === "branch") return `${run}+branch:${w.origin}`;
  return [run, w.run].sort().join("+");
}

/** the same collision from the other run's view (run kind only; `verb` is that run's) */
export function flipped(c: Collision, verb: string): Collision {
  if (c.with.kind !== "run") return c;
  return {
    ...c,
    run: c.with.run,
    name: c.with.name,
    with: { kind: "run", run: c.run, verb, name: c.name },
  };
}

/** Folds `me` against each side into the live list, retaining the first orientation and resaying only after enough new paths. */
export function collide(
  live: readonly Collision[],
  me: Touched,
  sides: readonly Side[],
  repoId: string,
  now: number,
  saidAt: ReadonlyMap<string, number>,
): { live: Collision[]; fresh: Collision[]; grown: Collision[] } {
  const prior = new Map(live.map((collision) => [collision.id, collision]));
  const stillInvolvingMe = (collision: Collision): boolean => collision.run === me.run || (collision.with.kind === "run" && collision.with.run === me.run);
  const next = live.filter((collision) => !stillInvolvingMe(collision));
  const fresh: Collision[] = [];
  const grown: Collision[] = [];
  const seen = new Set<string>();

  for (const side of sides) {
    const paths = overlap(me, side.touched);
    if (!paths.length) continue;
    const id = pairId(me.run, side.with);
    if (seen.has(id)) continue;
    seen.add(id);
    const previous = prior.get(id);
    const collision: Collision = previous
      ? { ...previous, paths }
      : { id, repoId, run: me.run, name: me.name, with: side.with, paths, at: now };
    next.push(collision);
    if (!previous) fresh.push(collision);
    else {
      const said = saidAt.get(id);
      if (said !== undefined && paths.length - said >= COLLISION_RESAY) grown.push(collision);
    }
  }

  return { live: next, fresh, grown };
}

export function pathList(paths: readonly string[]): string {
  const shown = paths.slice(0, PATHS_SHOWN).join(", ");
  const more = paths.length - PATHS_SHOWN;
  return more > 0 ? `${shown} and ${more} more` : shown;
}

/** "also being edited by <verb> run <id>: <paths>" */
export function noteLine(by: { verb: string; run: string }, paths: readonly string[]): string {
  return `also being edited by ${by.verb} run ${by.run}: ${pathList(paths)}`;
}

/** the other side's name: the run's, the branch's, or "your uncommitted changes" */
export function withName(w: Collision["with"]): string {
  if (w.kind === "checkout") return "your uncommitted changes";
  return w.kind === "branch" ? w.branch : w.name;
}

/** the note on the touching run's timeline */
export function collisionLine(c: Collision): string {
  if (c.with.kind === "run") return noteLine({ verb: c.with.verb, run: c.with.run }, c.paths);
  if (c.with.kind === "branch") return `also in queued branch ${c.with.branch}: ${pathList(c.paths)}`;
  return `also changed in the main checkout, uncommitted: ${pathList(c.paths)}`;
}

/** the inbox's line, and the attention row's for the checkout */
export function collisionNotice(c: Collision): string {
  if (c.with.kind === "checkout") return `your uncommitted changes to ${pathList(c.paths)} overlap ${c.name}; the landing will wait for them`;
  return `${c.name} and ${withName(c.with)} both edit ${pathList(c.paths)}`;
}

/** what an idle chat is told; `when` is "3m ago" */
export function collisionSay(c: Collision, when: string): string {
  const paths = c.paths.join(", ");
  if (c.with.kind === "checkout") return `canopy: the main checkout has uncommitted changes to these files: <<< ${paths} >>>. Carry on; the landing waits for them.`;
  const other = c.with.kind === "branch" ? `a queued branch (${c.with.branch})` : `another run (${c.with.verb}, started ${when})`;
  return `canopy: ${other} has edited these files since you started: <<< ${paths} >>>. Carry on; the queue rebases when you land.`;
}

/** what a coordinator is told about two of its children */
export function childrenSay(a: string, b: string, paths: readonly string[]): string {
  return `canopy: two of your runs (${a} and ${b}) edit the same files: <<< ${paths.join(", ")} >>>. Carry on or re-plan; nothing is held.`;
}
