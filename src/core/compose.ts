/**
 * A compose stack per worktree (FR-039 plan 3): the pure half, browser-safe.
 * Which tasks are compose tasks, the project name a folder gets, the docker
 * commands, and reading what docker answers. The name is always worked out
 * from the folder: nothing here takes one from a record or a request, so
 * `down -v` can only reach a project canopy named for that worktree.
 */
import type { TaskDef } from "./types";

/** how long `down` gets (spec) */
export const COMPOSE_DOWN_MS = 60_000;

export const OWN_STACK = "canopy's own stack is deployed by redeploy, not run as a task";

/** the two folders canopy makes worktrees under */
export interface ComposeRoots {
  runs: string;
  kept: string;
}

export const isComposeTask = (def: Pick<TaskDef, "cmd" | "compose">): boolean => def.compose ?? /^docker\s+compose(\s|$)/.test(def.cmd);

/** why a compose task's `cmd` cannot run in a worktree; null when it can */
export function composeCmdError(cmd: string): string | null {
  const own = /(^|\s)(-p\S*|--project-name(=\S*)?)(\s|$)/.test(cmd) || /(^|\s)COMPOSE_PROJECT_NAME=/.test(cmd);
  return own ? "this cmd names its own compose project; canopy names the project in a worktree" : null;
}

/** a folder's name in what compose allows; a dot becomes two dashes, which
 *  a repo key or a slug never has, so two names stay two */
const clean = (s: string): string => s.toLowerCase().replace(/\./g, "--").replace(/[^a-z0-9_-]/g, "-");

/** `<root>/<repo key>/<leaf>` as its two parts; null for anything else */
function under(dir: string, root: string): [string, string] | null {
  if (!dir.startsWith(`${root}/`)) return null;
  const parts = dir.slice(root.length + 1).split("/");
  const [key, leaf] = parts;
  if (parts.length !== 2 || !key || !leaf || key === "." || key === ".." || leaf === "." || leaf === "..") return null;
  return [key, leaf];
}

/** The project a worktree's stack runs as: `cw-` for a run's, `ck-` for a
 *  kept one's, since a slug can equal a run's id. Null for any folder that
 *  is not one of canopy's worktrees, which has no project of canopy's. */
export function projectName(dir: string, roots: ComposeRoots): string | null {
  const run = under(dir, roots.runs);
  if (run) return `cw-${clean(run[0])}-${clean(run[1])}`;
  const kept = under(dir, roots.kept);
  return kept ? `ck-${clean(kept[0])}-${clean(kept[1])}` : null;
}

/** The one way to `down`: it takes the folder, never a name. Null for a
 *  folder that has no project of canopy's, canopy's own stack among them.
 *  An image is never removed. */
export function composeDownArgs(dir: string, roots: ComposeRoots, volumes: boolean): string[] | null {
  const name = projectName(dir, roots);
  return name === null ? null : ["compose", "-p", name, "down", ...(volumes ? ["-v"] : [])];
}

export const composeLsArgs = (name: string): string[] => ["compose", "ls", "-a", "--format", "json", "--filter", `name=${name}`];

export const volumeLsArgs = (name: string): string[] => ["volume", "ls", "--filter", `label=com.docker.compose.project=${name}`, "--format", "{{.Name}}"];

/** The project `name` from `compose ls`, by exact match: the filter is a
 *  substring. Null when it has no containers, "unreadable" when the answer
 *  is not the list. */
export function parseComposeLs(out: string, name: string): { files: string[] } | null | "unreadable" {
  if (!out.trim()) return null;
  let list: unknown;
  try {
    list = JSON.parse(out);
  } catch {
    return "unreadable";
  }
  if (!Array.isArray(list)) return "unreadable";
  const hit = (list as { Name?: unknown; ConfigFiles?: unknown }[]).find((p) => p?.Name === name);
  if (!hit) return null;
  const files = typeof hit.ConfigFiles === "string" ? hit.ConfigFiles.split(",").filter(Boolean) : [];
  return { files };
}

/** whether every compose file sits inside the folder, under any of its
 *  names (a symlinked temp folder has two); no files means it cannot be told */
export function configInside(files: readonly string[], dirs: readonly string[]): boolean {
  return files.length > 0 && files.every((f) => dirs.some((d) => f.startsWith(`${d}/`)));
}

/** Volumes labelled to the project but not named after it: a compose file
 *  gave them a fixed name, so another stack may share them (P3). */
export function foreignVolumes(out: string, name: string): string[] {
  return out.split("\n").map((v) => v.trim()).filter((v) => v && !v.startsWith(`${name}_`));
}
