import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DIAGNOSIS_CONFIG, DIAGNOSIS_PATH } from "../core/diagnosis";
import { exec } from "../core/exec";
import { ARCHIFY_IGNORE } from "./archify";
import { DIAGNOSIS_IGNORE, DiagnosisError, diagnosisDone, diagnosisInfo, diagnosisPage, removeDiagnosis, startDiagnosis } from "./diagnosis";

// A small checkout analyzed by canopy's own copy of Archify's Code Analysis:
// the real `code-analysis prepare`, its real page and overview, no model.
// Two files import each other, so the analysis has an import cycle to find;
// a folder git ignores and a folder the repo's settings leave out each hold
// one more cycle, which must not be found.
let root = "";
const git = (...args: string[]) => exec(["git", "-c", "user.email=t@example.com", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...args], { cwd: root });

/** two modules that import each other, in `dir` */
function cycle(dir: string): void {
  mkdirSync(join(root, dir), { recursive: true });
  writeFileSync(join(root, dir, "a.ts"), 'import { b } from "./b";\nexport const a = (n: number): number => (n > 0 ? b(n - 1) : 0);\n');
  writeFileSync(join(root, dir, "b.ts"), 'import { a } from "./a";\nexport const b = (n: number): number => (n > 0 ? a(n - 1) : 1);\n');
}

const out = () => join(root, DIAGNOSIS_PATH);

async function analyze(pick: Parameters<typeof startDiagnosis>[1] = "auto") {
  await startDiagnosis(root, pick);
  await diagnosisDone(root);
  return diagnosisInfo(root);
}

beforeAll(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "canopy-diagnosis-")));
  cycle("src");
  cycle("kept-tree/src");
  cycle("vendored");
  writeFileSync(join(root, ".gitignore"), "kept-tree/\n");
  mkdirSync(join(root, ".canopy"));
  writeFileSync(join(root, ".canopy", "diagnosis.json"), JSON.stringify({ exclude: ["vendored/**"], duplicates: { enabled: true, executable: join(root, "never-run") } }));
  await git("init", "-q");
  await git("add", "-A");
  await git("commit", "-qm", "init");
});

afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

describe("a checkout's diagnosis, through the real analysis", () => {
  test("none yet reads as none, with the repo's settings", async () => {
    expect(await diagnosisInfo(root)).toEqual({ report: null, running: null, failed: null, settings: { language: null, exclude: ["vendored/**"] } });
    expect(() => diagnosisPage(root)).toThrow(DiagnosisError);
    expect(removeDiagnosis(root)).rejects.toThrow("no diagnosis here yet");
  });

  test("an analysis goes in the background, one at a time, and leaves a page, its counts and a clean git status", async () => {
    const since = await startDiagnosis(root, "auto");
    expect((await diagnosisInfo(root)).running).toBe(since);
    const second = await startDiagnosis(root, "auto").then(
      () => null,
      (e: unknown) => e,
    );
    expect(second instanceof DiagnosisError && second.busy).toBe(true);
    expect(removeDiagnosis(root)).rejects.toThrow("an analysis is going");
    await diagnosisDone(root);

    const info = await diagnosisInfo(root);
    expect(info.running).toBeNull();
    expect(info.failed).toBeNull();
    expect(info.tracked).toBeUndefined();
    const facts = info.report?.facts;
    // src's two files alone: the ignored tree and the folder the settings
    // leave out are not read
    expect(facts).toMatchObject({ language: "ts", files: 2, changes: null });
    expect(facts?.errors).toBeGreaterThan(0);
    expect(facts?.leads.some((l) => l.code === "coupling/import-cycle" && l.message.includes("src/a.ts"))).toBe(true);
    expect(JSON.stringify(facts)).not.toContain("kept-tree");
    expect(JSON.stringify(facts)).not.toContain("vendored");

    const page = diagnosisPage(root);
    expect(page.bytes).toBe(info.report?.bytes ?? -1);
    expect(readFileSync(page.path, "utf8")).toContain("Code Analysis");

    // out of git by both ignores, and trimmed of what canopy has no use for
    expect(readFileSync(join(root, ".archify", ".gitignore"), "utf8")).toBe(ARCHIFY_IGNORE);
    expect(readFileSync(join(out(), ".gitignore"), "utf8")).toBe(DIAGNOSIS_IGNORE);
    expect((await git("status", "--porcelain")).stdout.trim()).toBe("");
    expect(existsSync(join(out(), "analysis", "raw-facts.json"))).toBe(false);
    expect(existsSync(join(out(), "analysis", "findings.json"))).toBe(true);
  }, 120_000);

  test("the config canopy wrote holds excludes alone, whatever the repo's settings say", () => {
    const config: unknown = JSON.parse(readFileSync(join(out(), DIAGNOSIS_CONFIG), "utf8"));
    if (typeof config !== "object" || config === null || !("exclude" in config)) throw new Error("the config holds no exclude");
    expect(Object.keys(config)).toEqual(["exclude"]);
    expect(config.exclude).toContain("**/node_modules/**");
    expect(config.exclude).toContain("kept-tree/**");
    expect(config.exclude).toContain("vendored/**");
  });

  test("a second analysis says what changed since the first, and keeps no run before", async () => {
    cycle("src/more");
    const info = await analyze();
    expect(info.failed).toBeNull();
    expect(info.report?.facts?.files).toBe(4);
    expect(info.report?.facts?.changes).toMatchObject({ comparable: true });
    expect(info.report?.facts?.changes?.added).toBeGreaterThan(0);
    expect(existsSync(join(out(), "analysis.previous"))).toBe(false);
    rmSync(join(root, "src", "more"), { recursive: true });
  }, 120_000);

  test("a failed analysis says why, keeps the page before, and a good one clears it", async () => {
    const before = (await diagnosisInfo(root)).report?.builtAt;
    // Go's adapter wants a go.mod at the root and stops before it runs go
    const failed = await analyze("go");
    expect(failed.failed).toBeTruthy();
    expect(failed.running).toBeNull();
    expect(failed.report?.builtAt).toBe(before ?? -1);
    expect((await git("status", "--porcelain")).stdout.trim()).toBe("");
    expect((await analyze("ts")).failed).toBeNull();
  }, 120_000);

  test("a run cut short leaves nothing for the next to trip on", async () => {
    mkdirSync(join(out(), "analysis.next-abc123"));
    const info = await analyze();
    expect(info.failed).toBeNull();
    expect(existsSync(join(out(), "analysis.next-abc123"))).toBe(false);
  }, 120_000);

  test("remove takes the folder", async () => {
    await removeDiagnosis(root);
    expect(existsSync(out())).toBe(false);
    expect((await diagnosisInfo(root)).report).toBeNull();
  });
});

describe("a folder canopy did not make", () => {
  test("a link is never a page and is never written through", async () => {
    const elsewhere = realpathSync(mkdtempSync(join(tmpdir(), "canopy-diagnosis-out-")));
    try {
      mkdirSync(join(elsewhere, "analysis"), { recursive: true });
      writeFileSync(join(elsewhere, "analysis", "repo.analysis.html"), "<title>not ours</title>");
      mkdirSync(join(root, ".archify"), { recursive: true });
      symlinkSync(elsewhere, out());
      expect((await diagnosisInfo(root)).report).toBeNull();
      expect(() => diagnosisPage(root)).toThrow(DiagnosisError);
      const info = await analyze();
      expect(info.failed).toContain("is a link or a file");
      expect(existsSync(join(elsewhere, DIAGNOSIS_CONFIG))).toBe(false);
      // removing it removes the link, not what it points at
      await removeDiagnosis(root);
      expect(existsSync(join(elsewhere, "analysis", "repo.analysis.html"))).toBe(true);
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  test("one the repo tracks is shown, and neither written over nor removed", async () => {
    mkdirSync(join(out(), "analysis"), { recursive: true });
    writeFileSync(join(out(), "analysis", "repo.analysis.html"), "<title>committed</title>");
    writeFileSync(join(out(), "analysis", "overview.json"), JSON.stringify({ counts: { findings: 3, error: 1, warning: 2 }, coverage: { language: "ts", files: { analyzed: 9 } } }));
    await git("add", "-f", DIAGNOSIS_PATH);
    await git("commit", "-qm", "a committed diagnosis");
    const info = await diagnosisInfo(root);
    expect(info.tracked).toBe(true);
    expect(info.report?.facts).toMatchObject({ findings: 3, errors: 1, files: 9 });
    expect(diagnosisPage(root).bytes).toBeGreaterThan(0);
    expect(startDiagnosis(root, "auto")).rejects.toThrow("the repo tracks");
    expect(removeDiagnosis(root)).rejects.toThrow("remove it with git");
    expect(readFileSync(join(out(), "analysis", "repo.analysis.html"), "utf8")).toBe("<title>committed</title>");
  });
});
