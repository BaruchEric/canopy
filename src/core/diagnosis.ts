/**
 * Architecture Diagnosis of a repo (FR-075): Archify's Code Analysis, which
 * canopy's copy carries in lib/archify since 3.3.0, reads a checkout's
 * source and writes one standalone page: its findings (import cycles,
 * module cycles, hubs, concentration, complex functions) beside an Atlas of
 * every file, dependency and function. No model runs. The server calls the
 * CLI's `code-analysis prepare` itself, with arguments and a config canopy
 * writes, and the map section's diagnosis switch frames the page in a
 * sandboxed iframe, as it frames a diagram.
 *
 * This file is the pure half: the folder and file names, the CLI's
 * arguments, the config canopy writes for it, the repo's own settings, how
 * the analysis's overview and receipt read, and the words a report is shown
 * in. Browser-safe, so the page and the CLI say the same thing. The Bun
 * half is server/diagnosis.ts. Tested in diagnosis.test.ts.
 */

import { ARCHIFY_FOLDER } from "./archify";

/** the analysis's folder under the checkout's `.archify/`, one per checkout */
export const DIAGNOSIS_FOLDER = "diagnosis";

/** where the analysis lives, from the checkout's root */
export const DIAGNOSIS_PATH = `${ARCHIFY_FOLDER}/${DIAGNOSIS_FOLDER}`;

/** the folder inside it that `prepare` writes and rotates */
export const DIAGNOSIS_RUN_FOLDER = "analysis";

/** the page, inside that */
export const DIAGNOSIS_PAGE = "repo.analysis.html";

/** the summary beside the page, which canopy reads its counts from */
export const DIAGNOSIS_OVERVIEW = "overview.json";

/** the config canopy writes for a run, kept in the folder because the
 *  page's "recheck after edits" command names it */
export const DIAGNOSIS_CONFIG = "canopy-config.json";

/** a repo's own settings for its diagnosis, checked in */
export const DIAGNOSIS_SETTINGS = ".canopy/diagnosis.json";

/** the most a page may weigh before canopy refuses to send it. An analysis
 *  page carries the source it cites, so it is heavier than a diagram's. */
export const DIAGNOSIS_HTML_MAX = 64 * 1024 * 1024;

/** the languages Code Analysis reads, one per run, by its adapter's name */
export const DIAGNOSIS_LANGUAGES = ["ts", "py", "java", "go", "rust", "c", "cpp"] as const;
export type DiagnosisLanguage = (typeof DIAGNOSIS_LANGUAGES)[number];

/** a run's language: one of the above, or `auto` for the analysis to choose */
export type DiagnosisPick = DiagnosisLanguage | "auto";

export const isDiagnosisLanguage = (v: unknown): v is DiagnosisLanguage => typeof v === "string" && (DIAGNOSIS_LANGUAGES as readonly string[]).includes(v);
export const isDiagnosisPick = (v: unknown): v is DiagnosisPick => v === "auto" || isDiagnosisLanguage(v);

const LANGUAGE_WORDS: Record<DiagnosisLanguage, string> = { ts: "JS/TS", py: "Python", java: "Java", go: "Go", rust: "Rust", c: "C", cpp: "C++" };

/** A language as the page says it; a name canopy does not know stays as it is. */
export const languageWord = (language: string): string => (isDiagnosisLanguage(language) ? LANGUAGE_WORDS[language] : language);

export type DiagnosisSeverity = "error" | "warning" | "info";

/** One of the findings the analysis says to look at first. */
export interface DiagnosisLead {
  /** the rule, such as `coupling/import-cycle` */
  code: string;
  severity: DiagnosisSeverity;
  message: string;
  /** `path:line` in the checkout, when the finding has one place */
  where: string | null;
}

/** How this analysis differs from the one before it in the same folder. */
export interface DiagnosisChanges {
  /** false when the config, the rules or the files read changed between
   *  the two, so the counts below do not mean fixed or broken */
  comparable: boolean;
  /** findings that are new */
  added: number;
  /** findings no longer detected, which is not proof of a fix */
  gone: number;
  /** findings whose code changed */
  changed: number;
}

/** What canopy keeps of the analysis's `overview.json`. */
export interface DiagnosisFacts {
  /** the adapter that read the code, such as `ts` */
  language: string | null;
  /** source files analyzed, tests and generated files left out */
  files: number;
  findings: number;
  errors: number;
  warnings: number;
  /** what to look at first, at most LEADS_MAX */
  leads: DiagnosisLead[];
  /** source in languages this run did not read */
  others: { language: string; files: number }[];
  /** null for a first analysis */
  changes: DiagnosisChanges | null;
}

/** A checkout's analysis on disk. */
export interface DiagnosisReport {
  /** when the page was written, unix ms */
  builtAt: number;
  /** the page's size */
  bytes: number;
  /** null when the overview beside the page is missing or does not read */
  facts: DiagnosisFacts | null;
}

/** A repo's own settings (`.canopy/diagnosis.json`). */
export interface DiagnosisSettings {
  /** the language to read when a run asks for `auto` */
  language: DiagnosisLanguage | null;
  /** globs to leave out beside the analysis's defaults and what git ignores */
  exclude: string[];
}

/** A checkout's diagnosis as the route answers it. */
export interface DiagnosisInfo {
  report: DiagnosisReport | null;
  /** when the analysis going now started, unix ms */
  running: number | null;
  /** why the last analysis this server ran here failed, until one succeeds */
  failed: string | null;
  settings: DiagnosisSettings;
  /** the repo tracks the folder, so canopy will not write or remove it */
  tracked?: true;
}

const LEADS_MAX = 5;
const OTHERS_MAX = 10;
const TEXT_MAX = 600;
const EXCLUDE_MAX = 100;
const GLOB_MAX = 200;
/** the most paths git ignores that become excludes; a checkout past this
 *  keeps its folders, which are listed first */
const IGNORED_MAX = 300;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const count = (v: unknown): number => (typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : 0);
const text = (v: unknown, max = TEXT_MAX): string | null => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);
const lengthOf = (v: unknown): number => (Array.isArray(v) ? v.length : 0);

const isSeverity = (v: unknown): v is DiagnosisSeverity => v === "error" || v === "warning" || v === "info";

/** What canopy keeps of an `overview.json`. A clone may commit a folder of
 *  its own, so nothing is trusted: counts must be whole and not negative,
 *  text is cut, lists are capped, and a file with no counts reads as null. */
export function parseOverview(raw: unknown): DiagnosisFacts | null {
  if (!isRecord(raw) || !isRecord(raw["counts"])) return null;
  const counts = raw["counts"];
  const coverage = isRecord(raw["coverage"]) ? raw["coverage"] : {};
  const files = isRecord(coverage["files"]) ? coverage["files"] : {};
  const investigation = isRecord(raw["investigation"]) ? raw["investigation"] : {};
  const leads: DiagnosisLead[] = [];
  for (const l of Array.isArray(investigation["leads"]) ? investigation["leads"] : []) {
    if (leads.length >= LEADS_MAX) break;
    if (!isRecord(l)) continue;
    const message = text(l["message"]);
    if (!message) continue;
    leads.push({ code: text(l["code"], 80) ?? "finding", severity: isSeverity(l["severity"]) ? l["severity"] : "info", message, where: text(l["where"], 300) });
  }
  const others: DiagnosisFacts["others"] = [];
  for (const o of Array.isArray(coverage["otherLanguages"]) ? coverage["otherLanguages"] : []) {
    if (others.length >= OTHERS_MAX) break;
    const language = isRecord(o) ? text(o["adapter"], 20) : null;
    if (isRecord(o) && language && count(o["files"]) > 0) others.push({ language, files: count(o["files"]) });
  }
  const comparison = isRecord(raw["review"]) && isRecord(raw["review"]["comparison"]) ? raw["review"]["comparison"] : null;
  return {
    language: text(coverage["language"], 20),
    files: count(files["analyzed"]),
    findings: count(counts["findings"]),
    errors: count(counts["error"]),
    warnings: count(counts["warning"]),
    leads,
    others,
    changes: comparison
      ? { comparable: comparison["comparable"] !== false, added: lengthOf(comparison["new"]), gone: lengthOf(comparison["notDetected"]) + lengthOf(comparison["fixed"]), changed: lengthOf(comparison["evidenceChanged"]) }
      : null,
  };
}

/** A glob the analysis takes: short, one line, braces that close. Its
 *  matcher knows `**`, `*`, `?` and `{a,b}`, and stops a run on an open brace. */
function isGlob(v: unknown): v is string {
  if (typeof v !== "string" || !v.trim() || v.length > GLOB_MAX || /[\0\n\r]/.test(v)) return false;
  let depth = 0;
  for (let i = 0; i < v.length; i++) {
    if (v[i] === "\\") i++;
    else if (v[i] === "{") depth++;
    else if (v[i] === "}" && depth > 0) depth--;
  }
  return depth === 0;
}

/** A repo's settings, read leniently: a language canopy does not know and
 *  a glob the analysis would refuse are dropped. Only these two keys are
 *  read, so a checked-in file can never name a program for the analysis to
 *  run (its own config's `duplicates.executable`) or a TypeScript of the
 *  repo's to load. */
export function parseDiagnosisSettings(raw: unknown): DiagnosisSettings {
  if (!isRecord(raw)) return { language: null, exclude: [] };
  const exclude = (Array.isArray(raw["exclude"]) ? raw["exclude"] : [])
    .filter(isGlob)
    .map((g) => g.trim())
    .slice(0, EXCLUDE_MAX);
  return { language: isDiagnosisLanguage(raw["language"]) ? raw["language"] : null, exclude: [...new Set(exclude)] };
}

/** a path with the matcher's own characters escaped */
const literal = (path: string): string => path.replace(/[\\*?{},]/g, "\\$&");

/** What git ignores in a checkout, as globs: a folder (git names one with a
 *  trailing slash) with everything under it, a file by its path. Paths
 *  inside a folder already listed are dropped, folders come first, and the
 *  list stops at IGNORED_MAX. `paths` is `git ls-files --others --ignored
 *  --exclude-standard --directory -z`, split. */
export function ignoredGlobs(paths: readonly string[]): string[] {
  const clean = [...new Set(paths.filter((p) => p && !p.startsWith("/") && !/[\0\n\r]/.test(p) && !p.split("/").includes("..")))].sort();
  const folders: string[] = [];
  const files: string[] = [];
  for (const p of clean) {
    if (folders.some((f) => p.startsWith(f))) continue;
    if (p.endsWith("/")) folders.push(p);
    else files.push(p);
  }
  return [...folders.map((f) => `${literal(f)}**`), ...files.map(literal)].filter((g) => g.length <= GLOB_MAX * 4).slice(0, IGNORED_MAX);
}

/** The config canopy hands the analysis: its own default excludes (an
 *  `exclude` in a config replaces the default list whole), what git ignores
 *  and the repo's own globs. Nothing else is set, so duplicate detection,
 *  which runs a program the config names, stays off. `defaults` is the
 *  module's `config/defaults.json`. */
export function diagnosisConfig(defaults: unknown, ignored: readonly string[], settings: Pick<DiagnosisSettings, "exclude">): { exclude: string[] } {
  const base = isRecord(defaults) && Array.isArray(defaults["exclude"]) ? defaults["exclude"].filter((g): g is string => typeof g === "string") : [];
  return { exclude: [...new Set([...base, ...ignored, ...settings.exclude])] };
}

/** `node`'s arguments for one analysis: the CLI, `code-analysis prepare`,
 *  the checkout, the folder, English, the config, and the language unless
 *  the analysis is to choose. Every path is absolute. */
export function diagnosisArgs(o: { cli: string; root: string; out: string; config: string; language: DiagnosisLanguage | null }): string[] {
  return [o.cli, "code-analysis", "prepare", o.root, "--out", o.out, "--locale", "en", "--config", o.config, ...(o.language ? ["--language", o.language] : [])];
}

/** What `prepare` said: it prints one JSON receipt, `status` ok or error
 *  with diagnostics. A failure's words are the first diagnostic's, with a
 *  language to pick where the analysis could not choose one. */
export function parseReceipt(stdout: string, code: number): { ok: true } | { ok: false; message: string } {
  const line = stdout.trim().split("\n").pop() ?? "";
  let raw: unknown = null;
  try {
    raw = JSON.parse(line);
  } catch {
    // not a receipt: the exit code is all there is
  }
  if (isRecord(raw) && raw["status"] === "ok" && code === 0) return { ok: true };
  const first = isRecord(raw) && Array.isArray(raw["diagnostics"]) ? raw["diagnostics"].find(isRecord) : undefined;
  const message = first ? text(first["message"]) : null;
  if (!message) return { ok: false, message: `the analysis failed (exit ${code})` };
  const hint = first?.["code"] === "extract/adapter-ambiguous" ? " Pick the language to read and analyze again." : "";
  return { ok: false, message: `${message}${hint}` };
}

const plural = (n: number, one: string, many = `${one}s`): string => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

/** One line for a checkout's diagnosis, as the section and `canopy
 *  diagnosis` show it. `ago` words a unix-ms time. */
export function diagnosisLine(info: Pick<DiagnosisInfo, "report" | "running">, ago: (ms: number) => string): string {
  const r = info.report;
  if (!r) return info.running !== null ? "analyzing the code…" : "no diagnosis yet";
  const when = `analyzed ${ago(r.builtAt)}`;
  const f = r.facts;
  if (!f) return `${when}; its summary cannot be read`;
  const what = f.findings === 0 ? "nothing found" : `${plural(f.findings, "finding")}${f.errors ? ` (${plural(f.errors, "error")})` : ""}`;
  return `${what} in ${plural(f.files, "file")}${f.language ? ` of ${languageWord(f.language)}` : ""}, ${when}`;
}

/** The few words after the section's name while it shows the diagnosis. */
export function diagnosisHead(info: Pick<DiagnosisInfo, "report" | "running"> | null): string {
  if (!info) return "";
  if (info.running !== null) return "analyzing";
  const f = info.report?.facts;
  if (!f) return "";
  if (f.errors) return plural(f.errors, "error");
  return f.findings ? plural(f.findings, "finding") : "clean";
}

/** How this analysis differs from the last, in a line; null for a first one. */
export function changesLine(changes: DiagnosisChanges | null): string | null {
  if (!changes) return null;
  if (!changes.comparable) return "not comparable with the analysis before: the config, the rules or the files read changed";
  const parts = [changes.added ? `${changes.added} new` : "", changes.gone ? `${changes.gone} no longer detected` : "", changes.changed ? `${changes.changed} with changed code` : ""].filter(Boolean);
  return parts.length ? `since the analysis before: ${parts.join(", ")}` : "no change since the analysis before";
}

/** The languages a run left out, in a line; null when it read them all. */
export function othersLine(others: DiagnosisFacts["others"]): string | null {
  if (!others.length) return null;
  return `not read in this run: ${others.map((o) => `${plural(o.files, "file")} of ${languageWord(o.language)}`).join(", ")}`;
}
