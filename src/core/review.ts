/** The review rules (FR-013): a repo's `.canopy/review.json`, canopy's own
 *  list of sensitive paths, and the sort that puts each file of a branch
 *  run's diff in a class and gives the run its verdict. Read from the main
 *  checkout, never the branch, like the gates, so a run cannot widen the
 *  rules it is judged by. */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { exec, git } from "./exec";
import { guardedWhy } from "./explain";
import { LOCKFILES } from "./gates";
import { handOffFlag } from "./sprout";
import type { ReviewClass, ReviewFile, ReviewVerdict, RunReview } from "./types";

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

/* ---------- the sort ---------- */

/** past this many files a run's files are not read, only their paths checked */
export const MAX_FILES = 300;
/** a file bigger than this is logic without being read */
export const MAX_BYTES = 512 * 1024;

type Loader = "ts" | "tsx" | "js" | "jsx";
const JS_LOADERS: Record<string, Loader> = { ".ts": "ts", ".mts": "ts", ".cts": "ts", ".tsx": "tsx", ".js": "js", ".mjs": "js", ".cjs": "js", ".jsx": "jsx" };
/** prose, wherever it sits */
const DOC_EXT = new Set([".md", ".markdown", ".rst", ".adoc"]);
/** the names a `.txt` file outside a docs folder is prose under; any other
 *  (requirements.txt, CMakeLists.txt, robots.txt) is read by a program */
const TXT_NAMES = new Set(["readme", "license", "licence", "changelog", "notice", "authors", "contributors", "copying"]);
/** extensions that sort as code even in a docs folder: scripts, config, and
 *  markup or styles a docs site builds from */
const CODE_EXT = new Set([
  ...Object.keys(JS_LOADERS),
  ".sh", ".bash", ".zsh", ".fish", ".ps1", ".py", ".rb", ".pl", ".php", ".lua", ".go", ".rs", ".java", ".kt", ".swift", ".c", ".h", ".cc", ".cpp", ".cs",
  ".json", ".jsonc", ".json5", ".yml", ".yaml", ".toml", ".ini", ".cfg", ".conf", ".env", ".xml",
  ".html", ".htm", ".svg", ".mdx", ".vue", ".svelte", ".astro", ".css", ".scss", ".sass", ".less",
]);

/** A changed line holding any of these turns a check off or changes what a
 *  build does, though the transpiler drops it as a comment. Canopy lints
 *  with oxlint, so an oxlint-disable sorted as a comment would land a lint
 *  rule turned off unseen. */
export const DIRECTIVE =
  /@ts-(?:nocheck|check|ignore|expect-error)|\b(?:eslint|oxlint)-(?:disable|enable)|biome-ignore|deno-lint-ignore|prettier-ignore|\bc8\s+ignore|istanbul\s+ignore|@jsx(?:importsource|frag|runtime)?\b|@vite-ignore|\bwebpack\w*\s*:|[@#]__pure__|__no_side_effects__|sourcemappingurl|^\s*\/\/\/\s*<reference|["'`]use (?:client|server)["'`]|^#!/i;
/** an import attribute that makes Bun run the module while transpiling */
const MACRO = /type["'`]?\s*:\s*["'`]macro["'`]/;

/** One transpiler per loader. Macros off: the sort reads text a run wrote,
 *  inside the server, and Bun runs a macro import by default. Nothing is
 *  trimmed, so both sides keep everything they had. */
const transpilers = new Map<Loader, Bun.Transpiler>();
function transpile(loader: Loader, code: string): string {
  let t = transpilers.get(loader);
  if (!t) {
    // `macro: false` is what turns them off; the typings know only a map
    const opts = { loader, macro: false, deadCodeElimination: false, trimUnusedImports: false };
    t = new Bun.Transpiler(opts as unknown as ConstructorParameters<typeof Bun.Transpiler>[0]);
    transpilers.set(loader, t);
  }
  return t.transformSync(code);
}

const extOf = (path: string): string => {
  const base = path.split("/").pop() ?? "";
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot).toLowerCase() : "";
};
const stemOf = (path: string): string => (path.split("/").pop() ?? "").replace(/\.[^.]*$/, "").toLowerCase();
const inDocs = (path: string): boolean => path.toLowerCase().split("/").slice(0, -1).includes("docs");
/** blank, or a line that is a comment from its first character */
const commentLine = (line: string): boolean => {
  const t = line.trim();
  return t === "" || t.startsWith("//") || t.startsWith("/*") || t.startsWith("*");
};

/** One entry of `git diff --raw`. */
export interface RawEntry {
  status: string;
  oldMode: string;
  newMode: string;
  oldSha: string;
  newSha: string;
  path: string;
  from?: string;
}

/** `git diff --raw -z --no-abbrev`'s output as entries. */
export function parseRaw(out: string): RawEntry[] {
  const parts = out.split("\0");
  const list: RawEntry[] = [];
  for (let i = 0; i < parts.length; i++) {
    const head = parts[i] ?? "";
    if (!head.startsWith(":")) continue;
    const [oldMode = "", newMode = "", oldSha = "", newSha = "", status = ""] = head.slice(1).split(" ");
    const letter = status.charAt(0);
    if (letter === "R" || letter === "C") {
      list.push({ status: letter, oldMode, newMode, oldSha, newSha, from: parts[i + 1] ?? "", path: parts[i + 2] ?? "" });
      i += 2;
    } else {
      list.push({ status: letter, oldMode, newMode, oldSha, newSha, path: parts[i + 1] ?? "" });
      i += 1;
    }
  }
  return list;
}

/** What `classify` reads for one file: its two sides (null when absent)
 *  and its changed lines, both removed and added. */
export interface FileSides {
  old: string | null;
  new: string | null;
  changed: string[];
}

type Sorted = { cls: ReviewClass; why?: string };
const NO_SHA = /^0+$/;
const logic = (why?: string): Sorted => (why ? { cls: "logic", why } : { cls: "logic" });

/** The class of one file from its raw entry alone, or null when its text
 *  has to be read. */
export function classifyEntry(e: RawEntry): Sorted | null {
  if (e.status === "D") return logic("deleted");
  if (e.status === "R") return logic(`renamed from ${e.from ?? "?"}`);
  if (e.status === "C") return logic(`copied from ${e.from ?? "?"}`);
  if (e.status !== "A" && e.status !== "M") return logic(e.status === "T" ? "its type changed" : `git status ${e.status}`);
  if (e.newMode === "120000") return logic("a symlink");
  if (e.newMode === "160000") return logic("a submodule");
  if (e.status === "M" && e.oldMode !== e.newMode) return logic(`mode ${e.oldMode} to ${e.newMode}`);
  if (e.status === "A" && e.newMode === "100755") return logic("an executable file");
  return null;
}

/** The class of one file whose text was read. */
export function classify(path: string, sides: FileSides): Sorted {
  if ((sides.old ?? "").includes("\0") || (sides.new ?? "").includes("\0")) return logic("binary");
  const ext = extOf(path);
  if (DOC_EXT.has(ext)) return { cls: "docs" };
  if (ext === ".txt") return inDocs(path) || TXT_NAMES.has(stemOf(path)) ? { cls: "docs" } : logic("a .txt file outside docs, which a program may read");
  const loader = JS_LOADERS[ext];
  if (!loader) return inDocs(path) && ext !== "" && !CODE_EXT.has(ext) ? { cls: "docs" } : logic();
  for (const line of sides.changed) {
    const m = DIRECTIVE.exec(line);
    if (m) return logic(`a directive: ${m[0].trim()}`);
  }
  const oldText = sides.old ?? "";
  const newText = sides.new ?? "";
  // before the transpiler ever sees it, so no macro can run
  if (MACRO.test(oldText) || MACRO.test(newText)) return logic("a macro import");
  let same: boolean;
  try {
    same = transpile(loader, oldText) === transpile(loader, newText);
  } catch {
    return logic("does not parse");
  }
  if (!same) return logic();
  if (oldText.replace(/\s+/g, "") === newText.replace(/\s+/g, "")) return { cls: "format" };
  if (sides.changed.every(commentLine)) return { cls: "comments" };
  return logic();
}

/** The changed lines of a `-U0` diff, removed and added, headers left out. */
export function changedLines(diff: string): string[] {
  const out: string[] = [];
  let inHunk = false;
  for (const line of diff.split("\n")) {
    if (line.startsWith("@@")) inHunk = true;
    else if (line.startsWith("diff --git ")) inHunk = false;
    else if (inHunk && (line.startsWith("+") || line.startsWith("-"))) out.push(line.slice(1));
  }
  return out;
}

async function blob(dir: string, sha: string): Promise<{ size: number; text: string | null }> {
  if (NO_SHA.test(sha)) return { size: 0, text: null };
  const size = Number((await git(dir, ["cat-file", "-s", sha])).stdout.trim()) || 0;
  if (size > MAX_BYTES) return { size, text: null };
  const r = await git(dir, ["cat-file", "blob", sha]);
  return { size, text: r.code === 0 ? r.stdout : null };
}

/** The id an approval names: `git patch-id --verbatim` over the sensitive
 *  files' diff, which a rebase leaves alone and any change to those files
 *  moves. Without patch-id, SHA-256 over the diff with the hunk headers'
 *  line numbers taken out. */
export async function sensitivePatchId(dir: string, base: string, head: string, paths: readonly string[]): Promise<string> {
  const d = await git(dir, ["diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--binary", base, head, "--", ...paths], 60_000);
  const p = await exec(["git", "-C", dir, "patch-id", "--verbatim"], { input: d.stdout, timeoutMs: 30_000 });
  const id = p.code === 0 ? (p.stdout.trim().split(/\s+/)[0] ?? "") : "";
  if (id) return id;
  const plain = d.stdout.replace(/^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/gm, "@@");
  return `sha256:${new Bun.CryptoHasher("sha256").update(plain).digest("hex")}`;
}

/** Sorts a branch run's diff against its target: every file's class and
 *  sensitivity, and the verdict. `approve` when any file is sensitive or
 *  the rules are broken; `auto` when the repo has a rules file and gates
 *  and every class is in `autoLand`; else `land`. */
export async function sortBranch(dir: string, target: string, rules: Rules, hasGates: boolean, fold = false, now = Date.now()): Promise<RunReview> {
  const head = (await git(dir, ["rev-parse", "HEAD"])).stdout.trim();
  const base = (await git(dir, ["merge-base", target, "HEAD"])).stdout.trim() || target;
  const raw = await git(dir, ["diff", "--raw", "-z", "--no-abbrev", "--find-renames", "--no-ext-diff", "--no-textconv", base, "HEAD"], 60_000);
  if (raw.code !== 0) throw new Error(`git diff: ${raw.stderr.trim().split("\n").pop() ?? `exited ${raw.code}`}`);
  const entries = parseRaw(raw.stdout);
  const approve = rules.source === "file" ? rules.approve : [];
  const many = entries.length > MAX_FILES;
  const files: ReviewFile[] = [];
  for (const e of entries) {
    let c = many ? logic(`not read: over ${MAX_FILES} files`) : classifyEntry(e);
    if (!c) {
      const [a, b] = await Promise.all([blob(dir, e.oldSha), blob(dir, e.newSha)]);
      if (a.size > MAX_BYTES || b.size > MAX_BYTES) c = logic("over 512 KB");
      else {
        const js = JS_LOADERS[extOf(e.path)] !== undefined;
        const changed = js ? changedLines((await git(dir, ["diff", "-U0", "--no-ext-diff", "--no-textconv", base, "HEAD", "--", e.path])).stdout) : [];
        c = classify(e.path, { old: a.text, new: b.text, changed });
      }
    }
    const sensitive = fileSensitive(e, approve, fold);
    files.push({ path: e.path, ...(e.from !== undefined ? { from: e.from } : {}), ...c, ...(sensitive ? { sensitive } : {}) });
  }
  const touchy = files.filter((f) => f.sensitive);
  const verdictOf = (): { verdict: ReviewVerdict; why?: string } => {
    if (rules.source === "error") return { verdict: "approve", why: rules.error };
    if (touchy.length > 0) return { verdict: "approve" };
    if (many) return { verdict: "land", why: `over ${MAX_FILES} files, not read` };
    if (files.length === 0) return { verdict: "land", why: `no change against ${target}` };
    if (rules.source === "none") return { verdict: "land", why: "no review rules" };
    if (files.every((f) => rules.autoLand.includes(f.cls))) return hasGates ? { verdict: "auto" } : { verdict: "land", why: "no gates to run" };
    return { verdict: "land" };
  };
  const review: RunReview = { ...verdictOf(), files, base, head, at: now };
  // with the rules broken no file can be called safe, so an approval
  // names the whole diff
  const bound = touchy.length > 0 ? touchy : rules.source === "error" ? files : [];
  if (bound.length > 0) review.sensitiveId = await sensitivePatchId(dir, base, head, [...new Set(bound.flatMap((f) => (f.from !== undefined ? [f.from, f.path] : [f.path])))]);
  return review;
}
