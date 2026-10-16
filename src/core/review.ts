/** The review rules (FR-013): a repo's `.canopy/review.json`, canopy's own
 *  list of sensitive paths, and the sort that puts each file of a branch
 *  run's diff in a class and gives the run its verdict. Read from the main
 *  checkout, never the branch, like the gates, so a run cannot widen the
 *  rules it is judged by. */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { git } from "./exec";
import { guardedWhy } from "./explain";
import { LOCKFILES } from "./gates";
import { handOffFlag } from "./sprout";
import type { ReviewClass } from "./types";

export const REVIEW_FILE = ".canopy/review.json";
/** the classes `autoLand` may name; logic never lands unseen */
export const AUTO_CLASSES: readonly ReviewClass[] = ["docs", "comments", "format"];

export interface RulesFile {
  autoLand: ReviewClass[];
  approve: string[];
}

/** A repo's rules as its main checkout holds them: the file, no file, or
 *  a file that does not parse (every run then needs approval). */
export type Rules = ({ source: "file" } & RulesFile) | { source: "none" } | { source: "error"; error: string };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Why a glob from the rules file cannot be used, or null. `Bun.Glob`
 *  takes anything without complaint, so the checks are canopy's: a path
 *  inside the repo, and brackets and braces that close. */
function globFault(g: string): string | null {
  if (!g.trim()) return "is empty";
  if (g.startsWith("/")) return "starts with /; globs are relative to the repo";
  if (g.split("/").includes("..")) return "climbs out with ..";
  let square = 0;
  let curly = 0;
  for (const ch of g) {
    if (ch === "[") square++;
    else if (ch === "]") square--;
    else if (ch === "{") curly++;
    else if (ch === "}") curly--;
    if (square < 0 || curly < 0) return "closes a bracket it never opened";
  }
  return square || curly ? "leaves a bracket open" : null;
}

/** `.canopy/review.json`'s text as rules, or why it cannot be. Unknown
 *  keys are refused, since a misspelt `approve` would quietly drop every
 *  glob in it. */
export function parseRules(text: string): RulesFile | { error: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    return { error: `${REVIEW_FILE} is not JSON: ${String(err instanceof Error ? err.message : err)}` };
  }
  if (!isRecord(raw)) return { error: `${REVIEW_FILE} must be an object` };
  const extra = Object.keys(raw).filter((k) => k !== "autoLand" && k !== "approve");
  if (extra.length > 0) return { error: `${REVIEW_FILE}: unknown key ${extra.join(", ")}; it takes autoLand and approve` };
  const autoLand: ReviewClass[] = [];
  const auto = raw["autoLand"] ?? [];
  if (!Array.isArray(auto)) return { error: `${REVIEW_FILE}: autoLand must be a list` };
  for (const c of auto) {
    if (c === "logic") return { error: `${REVIEW_FILE}: logic cannot land on its own; autoLand takes docs, comments and format` };
    if (typeof c !== "string" || !(AUTO_CLASSES as readonly string[]).includes(c)) return { error: `${REVIEW_FILE}: autoLand has ${JSON.stringify(c)}; it takes docs, comments and format` };
    if (!autoLand.includes(c as ReviewClass)) autoLand.push(c as ReviewClass);
  }
  const approve: string[] = [];
  const globs = raw["approve"] ?? [];
  if (!Array.isArray(globs)) return { error: `${REVIEW_FILE}: approve must be a list of globs` };
  for (const g of globs) {
    if (typeof g !== "string") return { error: `${REVIEW_FILE}: approve has ${JSON.stringify(g)}, which is not a glob` };
    const fault = globFault(g);
    if (fault) return { error: `${REVIEW_FILE}: the glob ${g} ${fault}` };
    approve.push(g.trim());
  }
  return { autoLand, approve };
}

/** The repo's rules as its main checkout holds them now. */
export async function readRules(mainPath: string): Promise<Rules> {
  const text = await readFile(join(mainPath, REVIEW_FILE), "utf8").catch(() => null);
  if (text === null) return { source: "none" };
  const parsed = parseRules(text);
  return "error" in parsed ? { source: "error", error: parsed.error } : { source: "file", ...parsed };
}

/** Whether git in this checkout folds case (a Mac's default): the rules'
 *  globs then match case-folded, as the built-in names always do. */
export async function foldsCase(mainPath: string): Promise<boolean> {
  const r = await git(mainPath, ["config", "--bool", "core.ignorecase"]);
  return r.code === 0 && r.stdout.trim() === "true";
}

/** markdown and settings agents read as instructions, by file name */
const AGENT_FILES = new Set(["claude.md", "agents.md", "gemini.md", "skill.md", "spec.md", "design.md", ".windsurfrules", ".clinerules", "copilot-instructions.md"]);
/** folders whose files agents read as instructions (`.claude` and `.codex`
 *  are already guarded folders) */
const AGENT_DIRS = new Set([".cursor", ".agents", ".clinerules"]);

function agentWhy(low: string[]): string | null {
  const base = low.at(-1) ?? "";
  if (AGENT_FILES.has(base)) return "instructions agents read";
  if (low.slice(0, -1).some((x) => AGENT_DIRS.has(x))) return "instructions agents read";
  if (low[0] === ".github" && low[1] === "instructions") return "instructions agents read";
  return null;
}

/** Why one path is sensitive, or null: canopy's own list first (agent
 *  instructions, guarded folders and files, CI, deploy and hook config,
 *  lockfiles), then the repo's `approve` globs. */
export function sensitiveWhy(path: string, approve: readonly string[] = [], fold = false): string | null {
  const low = path.toLowerCase().split("/");
  const own = agentWhy(low) ?? guardedWhy(path) ?? handOffFlag(path) ?? (LOCKFILES.includes(path.split("/").pop() ?? "") ? "a lockfile" : null);
  if (own) return own;
  const subject = fold ? path.toLowerCase() : path;
  for (const g of approve) {
    if (new Bun.Glob(fold ? g.toLowerCase() : g).match(subject)) return `matches ${g} in ${REVIEW_FILE}`;
  }
  return null;
}

/** Why a file in a diff is sensitive, looking at both of a rename's or a
 *  copy's paths: moving a file out of a sensitive place is a change there.
 *  A delete's path is the old one already. */
export function fileSensitive(f: { path: string; from?: string }, approve: readonly string[] = [], fold = false): string | null {
  const now = sensitiveWhy(f.path, approve, fold);
  if (now || f.from === undefined) return now;
  const was = sensitiveWhy(f.from, approve, fold);
  return was ? `moved from ${f.from}: ${was}` : null;
}
