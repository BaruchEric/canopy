import { describe, expect, test } from "bun:test";
import {
  changesLine,
  diagnosisArgs,
  diagnosisConfig,
  diagnosisHead,
  diagnosisLine,
  ignoredGlobs,
  isDiagnosisPick,
  languageWord,
  othersLine,
  parseDiagnosisSettings,
  parseOverview,
  parseReceipt,
  type DiagnosisFacts,
  type DiagnosisReport,
} from "./diagnosis";

/** an overview as Code Analysis 3.3.0 writes one, cut to what canopy reads */
const OVERVIEW = {
  verdict: "attention",
  counts: { findings: 270, error: 2, warning: 104, info: 164, accepted: 0 },
  review: { baseline: null, comparison: { comparable: true, reasons: [], new: ["A"], notDetected: ["B", "C"], fixed: [], evidenceChanged: ["D"], unchanged: 266 } },
  investigation: {
    leads: [
      { id: "COUP-1", code: "coupling/cycle", severity: "error", message: "2 modules depend on each other at package level: src → src/components → src.", where: "src/App.tsx:1", symbol: null },
      { id: "COMP-1", code: "complexity/function", severity: "warning", message: "handleApi has cyclomatic complexity 982.", where: null },
    ],
  },
  coverage: { language: "ts", adapter: "typescript@5.9.3", files: { analyzed: 263, excludedByRole: 147 }, otherLanguages: [{ adapter: "py", files: 26 }, { adapter: "go", files: 0 }] },
};

const FACTS: DiagnosisFacts = {
  language: "ts",
  files: 263,
  findings: 270,
  errors: 2,
  warnings: 104,
  leads: [
    { code: "coupling/cycle", severity: "error", message: "2 modules depend on each other at package level: src → src/components → src.", where: "src/App.tsx:1" },
    { code: "complexity/function", severity: "warning", message: "handleApi has cyclomatic complexity 982.", where: null },
  ],
  others: [{ language: "py", files: 26 }],
  changes: { comparable: true, added: 1, gone: 2, changed: 1 },
};

describe("an analysis's overview", () => {
  test("reads to the counts, the leads, the languages left out and the changes", () => {
    expect(parseOverview(OVERVIEW)).toEqual(FACTS);
  });

  test("a first analysis has no changes, and one that is not comparable says so", () => {
    expect(parseOverview({ ...OVERVIEW, review: { baseline: null, comparison: null } })?.changes).toBeNull();
    expect(parseOverview({ ...OVERVIEW, review: { comparison: { comparable: false, new: [], notDetected: [] } } })?.changes).toEqual({ comparable: false, added: 0, gone: 0, changed: 0 });
  });

  test("trusts nothing a clone could have committed", () => {
    expect(parseOverview(null)).toBeNull();
    expect(parseOverview([])).toBeNull();
    expect(parseOverview({ coverage: {} })).toBeNull();
    const odd = parseOverview({
      counts: { findings: -4, error: "9", warning: 1.5 },
      coverage: { language: 7, files: "all", otherLanguages: "none" },
      investigation: { leads: [null, { message: "" }, { message: "x".repeat(5000), severity: "fatal", where: 3 }, ...Array.from({ length: 20 }, (_, i) => ({ message: `m${i}` }))] },
    });
    expect(odd).toMatchObject({ language: null, files: 0, findings: 0, errors: 0, warnings: 0, others: [], changes: null });
    expect(odd?.leads).toHaveLength(5);
    expect(odd?.leads[0]).toMatchObject({ code: "finding", severity: "info", where: null });
    expect(odd?.leads[0]?.message).toHaveLength(600);
  });
});

describe("a repo's settings", () => {
  test("keep a known language and globs the analysis takes", () => {
    expect(parseDiagnosisSettings({ language: "py", exclude: ["lib/**", " vendor/{a,b}/** ", "lib/**"] })).toEqual({ language: "py", exclude: ["lib/**", "vendor/{a,b}/**"] });
  });

  test("drop what they cannot be, and read nothing else", () => {
    expect(parseDiagnosisSettings(null)).toEqual({ language: null, exclude: [] });
    expect(parseDiagnosisSettings("lib/**")).toEqual({ language: null, exclude: [] });
    const got = parseDiagnosisSettings({
      language: "cobol",
      exclude: ["", 3, "a\nb", "open/{brace/**", "x".repeat(300), "ok/**"],
      // the analysis's own config can name a program to run and a TypeScript to load
      duplicates: { enabled: true, executable: "/tmp/evil" },
      typescript: { sdk: "project" },
    });
    expect(got).toEqual({ language: null, exclude: ["ok/**"] });
    expect(parseDiagnosisSettings({ exclude: Array.from({ length: 150 }, (_, i) => `d${i}/**`) }).exclude).toHaveLength(100);
  });
});

describe("what git ignores", () => {
  test("becomes globs: a folder with all under it, a file by its path, nothing twice", () => {
    expect(ignoredGlobs([".worktrees/", "dist/", "dist/web/", ".archify/", ".archify/.gitignore", ".DS_Store", "docs/.DS_Store", ""])).toEqual([".archify/**", ".worktrees/**", "dist/**", ".DS_Store", "docs/.DS_Store"]);
  });

  test("escapes the matcher's own characters and drops a path that leaves the checkout", () => {
    expect(ignoredGlobs(["out {old}/", "a*b.ts", "what?.js", "x,y/", "../up/", "/abs/", "a/../b.ts"])).toEqual(["out \\{old\\}/**", "x\\,y/**", "a\\*b.ts", "what\\?.js"]);
  });

  test("stops at 300, folders first", () => {
    const many = ignoredGlobs([...Array.from({ length: 400 }, (_, i) => `f${String(i).padStart(3, "0")}.log`), "build/"]);
    expect(many).toHaveLength(300);
    expect(many[0]).toBe("build/**");
  });
});

describe("the config canopy writes", () => {
  const defaults = { schema_version: 1, include: ["**/*.ts"], exclude: ["**/node_modules/**", "**/dist/**"], typescript: { sdk: "bundled" } };

  test("holds excludes alone: the defaults, what git ignores and the repo's own", () => {
    expect(diagnosisConfig(defaults, [".worktrees/**", "**/dist/**"], { exclude: ["lib/**"] })).toEqual({ exclude: ["**/node_modules/**", "**/dist/**", ".worktrees/**", "lib/**"] });
  });

  test("stands with defaults it cannot read", () => {
    expect(diagnosisConfig(null, [], { exclude: [] })).toEqual({ exclude: [] });
    expect(diagnosisConfig({ exclude: "all" }, ["a/**"], { exclude: [] })).toEqual({ exclude: ["a/**"] });
  });
});

describe("one analysis", () => {
  const where = { cli: "/app/lib/archify/skills/archify/bin/archify.mjs", root: "/home/eric/dev/shop", out: "/home/eric/dev/shop/.archify/diagnosis", config: "/home/eric/dev/shop/.archify/diagnosis/canopy-config.json" };

  test("is prepare with the checkout, the folder, English and canopy's config", () => {
    expect(diagnosisArgs({ ...where, language: null })).toEqual([where.cli, "code-analysis", "prepare", where.root, "--out", where.out, "--locale", "en", "--config", where.config]);
    expect(diagnosisArgs({ ...where, language: "rust" }).slice(-2)).toEqual(["--language", "rust"]);
  });

  test("never serves, never asks GitHub", () => {
    const args = diagnosisArgs({ ...where, language: "ts" });
    for (const word of ["start", "serve", "--pr", "--repository", "--ir"]) expect(args).not.toContain(word);
  });

  test("a receipt says ok, or why not", () => {
    expect(parseReceipt('{"schemaVersion":1,"status":"ok","command":"prepare"}\n', 0)).toEqual({ ok: true });
    // an ok receipt from a command that failed is not ok
    expect(parseReceipt('{"status":"ok"}', 2)).toEqual({ ok: false, message: "the analysis failed (exit 2)" });
    expect(parseReceipt('{"status":"error","diagnostics":[{"code":"extract/adapter-undetected","message":"No language adapter matched the analyzed directory."}]}', 2)).toEqual({
      ok: false,
      message: "No language adapter matched the analyzed directory.",
    });
    expect(parseReceipt('noise\n{"status":"error","diagnostics":[{"code":"extract/adapter-ambiguous","message":"More than one language adapter matches (py: 1 file, ts: 1 file); choose one explicitly."}]}', 2)).toEqual({
      ok: false,
      message: "More than one language adapter matches (py: 1 file, ts: 1 file); choose one explicitly. Pick the language to read and analyze again.",
    });
    expect(parseReceipt("", 143)).toEqual({ ok: false, message: "the analysis failed (exit 143)" });
  });
});

describe("the words", () => {
  const ago = () => "3h ago";
  const report: DiagnosisReport = { builtAt: 1, bytes: 9, facts: FACTS };

  test("a line says what was found, in what, and when", () => {
    expect(diagnosisLine({ report: null, running: null }, ago)).toBe("no diagnosis yet");
    expect(diagnosisLine({ report: null, running: 5 }, ago)).toBe("analyzing the code…");
    expect(diagnosisLine({ report, running: null }, ago)).toBe("270 findings (2 errors) in 263 files of JS/TS, analyzed 3h ago");
    expect(diagnosisLine({ report: { ...report, facts: { ...FACTS, findings: 1, errors: 0, files: 1204, language: null } }, running: null }, ago)).toBe("1 finding in 1,204 files, analyzed 3h ago");
    expect(diagnosisLine({ report: { ...report, facts: { ...FACTS, findings: 0, errors: 0 } }, running: null }, ago)).toBe("nothing found in 263 files of JS/TS, analyzed 3h ago");
    expect(diagnosisLine({ report: { ...report, facts: null }, running: null }, ago)).toBe("analyzed 3h ago; its summary cannot be read");
  });

  test("the head says analyzing, the errors, the findings or clean", () => {
    expect(diagnosisHead(null)).toBe("");
    expect(diagnosisHead({ report: null, running: null })).toBe("");
    expect(diagnosisHead({ report, running: 5 })).toBe("analyzing");
    expect(diagnosisHead({ report, running: null })).toBe("2 errors");
    expect(diagnosisHead({ report: { ...report, facts: { ...FACTS, errors: 0 } }, running: null })).toBe("270 findings");
    expect(diagnosisHead({ report: { ...report, facts: { ...FACTS, errors: 0, findings: 0 } }, running: null })).toBe("clean");
  });

  test("changes, languages left out and language names", () => {
    expect(changesLine(null)).toBeNull();
    expect(changesLine({ comparable: true, added: 1, gone: 2, changed: 1 })).toBe("since the analysis before: 1 new, 2 no longer detected, 1 with changed code");
    expect(changesLine({ comparable: true, added: 0, gone: 0, changed: 0 })).toBe("no change since the analysis before");
    expect(changesLine({ comparable: false, added: 4, gone: 0, changed: 0 })).toContain("not comparable");
    expect(othersLine([])).toBeNull();
    expect(othersLine([{ language: "py", files: 26 }, { language: "rust", files: 1 }])).toBe("not read in this run: 26 files of Python, 1 file of Rust");
    expect(languageWord("cpp")).toBe("C++");
    expect(languageWord("zig")).toBe("zig");
    expect(isDiagnosisPick("auto")).toBe(true);
    expect(isDiagnosisPick("ts")).toBe(true);
    expect(isDiagnosisPick("js")).toBe(false);
  });
});
