import { expect, test } from "bun:test";
import type { DiagnosisInfo } from "../core/diagnosis";
import { DIAGNOSIS_USAGE, diagnosisLines, parseDiagnosisArgs } from "./diagnosis";

test("parseDiagnosisArgs reads the repo, the act and its words, and leaves the list alone", () => {
  const argv = ["shop", "run", "--language", "py", "--on", "mini"];
  expect(parseDiagnosisArgs(argv)).toEqual({ repo: "shop", act: "run", language: "py", wait: true, json: false, on: "mini" });
  expect(argv).toHaveLength(6);
  expect(parseDiagnosisArgs(["shop"])).toEqual({ repo: "shop", act: "status", json: false });
  expect(parseDiagnosisArgs(["./shop", "status", "--json"])).toMatchObject({ repo: "./shop", act: "status", json: true });
  expect(parseDiagnosisArgs(["shop", "run"])).toMatchObject({ act: "run", language: "auto", wait: true });
  expect(parseDiagnosisArgs(["shop", "run", "--no-wait"])).toMatchObject({ act: "run", wait: false });
  expect(parseDiagnosisArgs(["shop", "save"])).toMatchObject({ act: "save", file: null });
  expect(parseDiagnosisArgs(["shop", "save", "out.html"])).toMatchObject({ act: "save", file: "out.html" });
  expect(parseDiagnosisArgs(["shop", "rm", "--backend", "http://x:1"])).toMatchObject({ act: "rm", backend: "http://x:1" });
});

test("parseDiagnosisArgs refuses what it cannot run", () => {
  expect(parseDiagnosisArgs([])).toBe(DIAGNOSIS_USAGE);
  expect(parseDiagnosisArgs(["--json"])).toBe(DIAGNOSIS_USAGE);
  expect(parseDiagnosisArgs(["shop", "analyze"])).toBe(DIAGNOSIS_USAGE);
  expect(parseDiagnosisArgs(["shop", "status", "extra"])).toBe(DIAGNOSIS_USAGE);
  expect(parseDiagnosisArgs(["shop", "rm", "extra"])).toBe(DIAGNOSIS_USAGE);
  expect(parseDiagnosisArgs(["shop", "save", "a.html", "b.html"])).toBe(DIAGNOSIS_USAGE);
  expect(parseDiagnosisArgs(["shop", "run", "--language", "cobol"])).toContain("--language is auto or one of");
  expect(parseDiagnosisArgs(["shop", "rm", "--language", "ts"])).toContain("--language and --no-wait go with run");
  expect(parseDiagnosisArgs(["shop", "--no-wait"])).toContain("--language and --no-wait go with run");
  expect(parseDiagnosisArgs(["shop", "--backend", "http://x:1", "--on", "mini"])).toBe("use either --backend URL or --on NAME");
});

test("diagnosisLines says the findings, the changes, the leads, what was left out and a failure", () => {
  const now = Date.parse("2026-11-22T12:00:00.000Z");
  const none: DiagnosisInfo = { report: null, running: null, failed: null, settings: { language: null, exclude: [] } };
  expect(diagnosisLines(none, now)).toEqual(["no diagnosis yet"]);
  expect(diagnosisLines({ ...none, running: now }, now)).toEqual(["analyzing the code…"]);
  expect(diagnosisLines({ ...none, failed: "No language adapter matched the analyzed directory." }, now)).toEqual(["no diagnosis yet", "the last analysis failed: No language adapter matched the analyzed directory."]);
  const info: DiagnosisInfo = {
    ...none,
    tracked: true,
    running: now,
    report: {
      builtAt: now - 3 * 3600_000,
      bytes: 9,
      facts: {
        language: "ts",
        files: 263,
        findings: 270,
        errors: 2,
        warnings: 104,
        leads: [
          { code: "coupling/import-cycle", severity: "error", message: "16 files form a module-scope import cycle.", where: "ui/src/App.tsx:1" },
          { code: "complexity/function", severity: "warning", message: "handleApi has cyclomatic complexity 982.", where: null },
        ],
        others: [{ language: "py", files: 26 }],
        changes: { comparable: true, added: 1, gone: 0, changed: 2 },
      },
    },
  };
  expect(diagnosisLines(info, now)).toEqual([
    "270 findings (2 errors) in 263 files of JS/TS, analyzed 3h ago (in git)",
    "an analysis is going now",
    "since the analysis before: 1 new, 2 with changed code",
    "  error  16 files form a module-scope import cycle.  (ui/src/App.tsx:1)",
    "  warning  handleApi has cyclomatic complexity 982.",
    "not read in this run: 26 files of Python",
  ]);
});
