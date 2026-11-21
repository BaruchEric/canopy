import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ARCHIFY_SKILL_PATH, isLeftOut, packageVersion, writePluginVersion } from "./archifyvendor";
import { changelogHeadlines, readPin, writeVersionConst } from "./floorplanvendor";
import { parseHealthFile } from "./repohealth";

const ROOT = join(import.meta.dir, "../..");

describe("Archify's own pieces", () => {
  test("only the rendered example pages are left out", () => {
    expect(isLeftOut("examples/web-app.architecture.html")).toBe(true);
    expect(isLeftOut("examples/web-app.architecture.json")).toBe(false);
    expect(isLeftOut("examples/locales/de.html")).toBe(false);
    expect(isLeftOut("assets/template.html")).toBe(false);
  });

  test("the plugin manifest's version moves and the rest stays", () => {
    const json = '{\n  "name": "archify",\n  "version": "3.2.0",\n  "license": "MIT"\n}\n';
    expect(writePluginVersion(json, "3.3.0")).toBe('{\n  "name": "archify",\n  "version": "3.3.0",\n  "license": "MIT"\n}\n');
    expect(() => writePluginVersion('{ "name": "archify" }', "3.3.0")).toThrow();
  });

  test("a package's version is x.y.z or nothing", () => {
    expect(packageVersion('{ "version": "3.2.0" }')).toBe("3.2.0");
    expect(packageVersion('{ "version": "3.3.0-beta.1" }')).toBeNull();
    expect(packageVersion("not json")).toBeNull();
  });

  test("ARCHIFY_VERSION is set by the shared writer", () => {
    expect(writeVersionConst('export const ARCHIFY_VERSION = "3.2.0";\n', "3.3.0", "ARCHIFY_VERSION")).toBe('export const ARCHIFY_VERSION = "3.3.0";\n');
    expect(() => writeVersionConst('export const FLOORPLAN_VERSION = "1.0.0";\n', "3.3.0", "ARCHIFY_VERSION")).toThrow("no ARCHIFY_VERSION line");
  });

  test("Archify's changelog headings and bold titles read", () => {
    const log = [
      "## [Unreleased]",
      "",
      "## [3.3.0] — 2026-12-01",
      "",
      "### Added",
      "",
      "- **One-page answers (explainer) (#993).** Ask your agent to answer as a page.",
      "  - **Authoring and delivery:** not a headline",
      "",
      "## [3.2.0] — 2026-10-18",
      "",
      "- **Old thing.** words",
    ].join("\n");
    expect(changelogHeadlines(log, "3.2.0", "3.3.0")).toEqual(["## [3.3.0] — 2026-12-01", "  - One-page answers (explainer) (#993)"]);
  });

  test("canopy's health file checks for a newer Archify with the script itself", () => {
    const { checks, errors } = parseHealthFile(readFileSync(join(ROOT, ".canopy/health.json"), "utf8"));
    expect(errors).toEqual([]);
    expect(checks.find((c) => c.name === "archify")).toMatchObject({ kind: "command", run: "bun scripts/archify-update.ts --check", heal: "none" });
  });
});

describe("bun run archify:update", () => {
  const SCRIPT = join(ROOT, "scripts/archify-update.ts");
  const git = (cwd: string, ...args: string[]): string => {
    const p = Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@t.test", "-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false", "-c", "init.defaultBranch=main", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
    if (p.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${p.stderr.toString()}`);
    return p.stdout.toString().trim();
  };
  const put = (dir: string, files: Record<string, string | null>): void => {
    for (const [path, text] of Object.entries(files)) {
      const abs = join(dir, path);
      if (text === null) rmSync(abs, { force: true });
      else {
        mkdirSync(dirname(abs), { recursive: true });
        writeFileSync(abs, text);
      }
    }
  };
  const lines = (...l: string[]): string => `${l.join("\n")}\n`;
  const SKILL_V1 = lines("# archify", "step one", "step two", "step three", "step four", "the end");

  /** An upstream with releases 1.0.0 and 1.1.0 and the skill in `archify/`,
   *  and a canopy checkout pinned to 1.0.0 with it in skills/archify. */
  function fixture(canopySkill = SKILL_V1, upstreamSkill = SKILL_V1.replace("the end", "the end, 1.1")) {
    const dir = mkdtempSync(join(tmpdir(), "ar-vendor-"));
    const up = join(dir, "upstream");
    const root = join(dir, "canopy");
    mkdirSync(up);
    git(up, "init", "-q");
    const v1 = {
      "archify/package.json": '{ "name": "archify", "version": "1.0.0" }\n',
      "archify/LICENSE": "MIT\n",
      "archify/SKILL.md": SKILL_V1,
      "archify/bin/archify.mjs": "export const a = 1;\n",
      "archify/bin/gone.mjs": "export const gone = 1;\n",
      "archify/examples/web.json": "{}\n",
      "archify/examples/web.html": "<html>a rendered page canopy leaves out</html>\n",
      "README.md": "not the skill\n",
      "CHANGELOG.md": lines("# Changelog", "", "## [1.0.0] — 2026-01-01", "", "- **First.** words"),
    };
    put(up, v1);
    git(up, "add", "-A");
    git(up, "commit", "-qm", "1.0.0");
    git(up, "tag", "-a", "v1.0.0", "-m", "1.0.0");
    const old = git(up, "rev-parse", "HEAD");
    put(up, {
      "archify/package.json": '{ "name": "archify", "version": "1.1.0" }\n',
      "archify/LICENSE": "Apache-2.0\n",
      "archify/NOTICE": "Archify\n",
      "archify/SKILL.md": upstreamSkill,
      "archify/bin/archify.mjs": "fetch('https://updates.example.test/stable.json');\n",
      "archify/bin/gone.mjs": null,
      "archify/bin/new.mjs": "export const fresh = 1;\n",
      "archify/examples/web.html": "<html>still left out</html>\n",
      "archify/examples/new.html": "<html>left out too</html>\n",
      "CHANGELOG.md": lines("# Changelog", "", "## [1.1.0] — 2026-02-01", "", "- **Second (#2).** words", "", "## [1.0.0] — 2026-01-01", "", "- **First.** words"),
    });
    git(up, "add", "-A");
    git(up, "commit", "-qm", "1.1.0");
    git(up, "tag", "-a", "v1.1.0", "-m", "1.1.0");

    mkdirSync(root);
    git(root, "init", "-q");
    const skill = `lib/archify/${ARCHIFY_SKILL_PATH}`;
    put(root, {
      [`${skill}/package.json`]: v1["archify/package.json"],
      [`${skill}/LICENSE`]: v1["archify/LICENSE"],
      [`${skill}/SKILL.md`]: canopySkill,
      [`${skill}/bin/archify.mjs`]: v1["archify/bin/archify.mjs"],
      [`${skill}/bin/gone.mjs`]: v1["archify/bin/gone.mjs"],
      [`${skill}/examples/web.json`]: v1["archify/examples/web.json"],
      "lib/archify/.claude-plugin/plugin.json": '{\n  "name": "archify",\n  "version": "1.0.0"\n}\n',
      "lib/archify/VENDOR.md": `# canopy's copy\n\nArchify at **1.0.0**, commit \`${old}\` (2026-01-01). More words.\n`,
      "src/core/archify.ts": 'export const ARCHIFY_VERSION = "1.0.0";\n',
    });
    git(root, "add", "-A");
    git(root, "commit", "-qm", "canopy");
    return { dir, up, root, skill: join(root, skill) };
  }
  const update = (root: string, up: string, ...more: string[]) => {
    const p = Bun.spawnSync(["bun", SCRIPT, "--root", root, "--upstream", up, "--no-test", ...more], { stdout: "pipe", stderr: "pipe" });
    return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
  };

  test("pulls the newest release into skills/archify, leaves the example pages out and moves every version", () => {
    const f = fixture();
    try {
      const r = update(f.root, f.up);
      expect(r.code).toBe(0);
      expect(readFileSync(join(f.skill, "SKILL.md"), "utf8")).toContain("the end, 1.1");
      expect(readFileSync(join(f.skill, "bin/archify.mjs"), "utf8")).toContain("updates.example.test");
      expect(existsSync(join(f.skill, "bin/gone.mjs"))).toBe(false);
      expect(existsSync(join(f.skill, "bin/new.mjs"))).toBe(true);
      expect(existsSync(join(f.skill, "NOTICE"))).toBe(true);
      expect(existsSync(join(f.skill, "examples/web.html"))).toBe(false);
      expect(existsSync(join(f.skill, "examples/new.html"))).toBe(false);
      expect(existsSync(join(f.skill, "examples/web.json"))).toBe(true);
      expect(existsSync(join(f.root, "lib/archify/README.md"))).toBe(false);
      expect(readPin(readFileSync(join(f.root, "lib/archify/VENDOR.md"), "utf8"))).toEqual({ version: "1.1.0", commit: git(f.up, "rev-parse", "HEAD"), date: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) });
      expect(readFileSync(join(f.root, "src/core/archify.ts"), "utf8")).toBe('export const ARCHIFY_VERSION = "1.1.0";\n');
      expect(readFileSync(join(f.root, "lib/archify/.claude-plugin/plugin.json"), "utf8")).toContain('"version": "1.1.0"');
      expect(r.out).toContain("Archify 1.0.0");
      expect(r.out).toContain("removed  skills/archify/bin/gone.mjs");
      expect(r.out).toContain("the license files changed (LICENSE, NOTICE)");
      expect(r.out).toContain("https://updates.example.test/stable.json");
      expect(r.out).toContain("- Second (#2)");

      const again = update(f.root, f.up);
      expect(again.code).toBe(2);
      expect(again.err).toContain("uncommitted changes");
      git(f.root, "add", "-A");
      git(f.root, "commit", "-qm", "1.1.0");
      expect(update(f.root, f.up).out).toContain("nothing to pull");
      const quiet = update(f.root, f.up, "--check");
      expect(quiet.code).toBe(0);
      expect(quiet.out.trim()).toBe("canopy has Archify 1.1.0, the newest release");
    } finally {
      rmSync(f.dir, { recursive: true, force: true });
    }
  });

  test("--check says in one line that a newer release is out", () => {
    const f = fixture();
    try {
      const r = update(f.root, f.up, "--check");
      expect(r.code).toBe(1);
      expect(r.err).toBe("");
      expect(r.out.trim()).toBe("Archify 1.1.0 is out and canopy has 1.0.0: run the task archify-update (bun run archify:update)");
      const away = update(f.root, join(f.dir, "missing"), "--check");
      expect(away.code).toBe(2);
      expect(away.err).toContain("could not ask");
    } finally {
      rmSync(f.dir, { recursive: true, force: true });
    }
  });

  test("an edit canopy made merges with upstream's change, or is left marked as a conflict", () => {
    const edited = SKILL_V1.replace("step one", "step one, canopy's way");
    const merged = fixture(edited);
    try {
      const r = update(merged.root, merged.up);
      expect(r.code).toBe(0);
      expect(r.out).toContain("merged canopy's edit into upstream's change  skills/archify/SKILL.md");
      const text = readFileSync(join(merged.skill, "SKILL.md"), "utf8");
      expect(text).toContain("step one, canopy's way");
      expect(text).toContain("the end, 1.1");
    } finally {
      rmSync(merged.dir, { recursive: true, force: true });
    }
    const clash = fixture(edited, SKILL_V1.replace("step one", "step one, upstream's way"));
    try {
      const r = update(clash.root, clash.up);
      expect(r.code).toBe(1);
      expect(r.out).toContain("CONFLICT  skills/archify/SKILL.md");
      expect(readFileSync(join(clash.skill, "SKILL.md"), "utf8")).toContain(">>>>>>> archify 1.1.0");
    } finally {
      rmSync(clash.dir, { recursive: true, force: true });
    }
  });

  test("--ref takes a named release, and an unknown one stops", () => {
    const f = fixture();
    try {
      expect(update(f.root, f.up, "--ref", "v1.0.0").out).toContain("nothing to pull");
      const r = update(f.root, f.up, "--ref", "nope");
      expect(r.code).toBe(2);
      expect(r.err).toContain("no tag, branch or commit called nope");
    } finally {
      rmSync(f.dir, { recursive: true, force: true });
    }
  });
});
