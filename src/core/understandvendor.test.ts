import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parseHealthFile } from "./repohealth";
import { readPin } from "./floorplanvendor";
import { UNDERSTAND_VERSION } from "./understand";
import { localPath, upstreamPath, writeVersionConst } from "./understandvendor";

const ROOT = join(import.meta.dir, "../..");

describe("where upstream's files land", () => {
  test("the plugin's folder is the copy's top, LICENSE comes along, the rest stays out", () => {
    expect(localPath("understand-anything-plugin/skills/understand/SKILL.md")).toBe("skills/understand/SKILL.md");
    expect(localPath("understand-anything-plugin/packages/viewer/bin/viewer.mjs")).toBe("packages/viewer/bin/viewer.mjs");
    expect(localPath("understand-anything-plugin/package.json")).toBe("package.json");
    expect(localPath("LICENSE")).toBe("LICENSE");
    expect(localPath("README.md")).toBeNull();
    expect(localPath("homepage/index.html")).toBeNull();
    expect(localPath("understand-anything-plugin/hooks/hooks.json")).toBeNull();
    expect(localPath("understand-anything-plugin/packages/mcp/package.json")).toBeNull();
    expect(localPath("understand-anything-plugin/pnpm-lock.yaml")).toBeNull();
    expect(localPath("understand-anything-plugin/pnpm-workspace.yaml")).toBeNull();
    // canopy's own files are never upstream's
    expect(localPath("understand-anything-plugin/VENDOR.md")).toBeNull();
    expect(localPath("understand-anything-plugin/bun.lock")).toBeNull();
    // a file whose name only starts like a left-out one is kept
    expect(localPath("understand-anything-plugin/hooks.md")).toBe("hooks.md");
  });

  test("upstreamPath goes back", () => {
    expect(upstreamPath("skills/understand/SKILL.md")).toBe("understand-anything-plugin/skills/understand/SKILL.md");
    expect(upstreamPath("LICENSE")).toBe("LICENSE");
  });

  test("sets UNDERSTAND_VERSION", () => {
    expect(writeVersionConst('export const UNDERSTAND_VERSION = "2.9.8";\n', "3.0.0")).toBe('export const UNDERSTAND_VERSION = "3.0.0";\n');
    expect(() => writeVersionConst("nothing here", "3.0.0")).toThrow("no UNDERSTAND_VERSION line");
  });
});

test("the vendored copy, VENDOR.md's pin and UNDERSTAND_VERSION agree", () => {
  const lib = join(ROOT, "lib/understand-anything");
  const pin = readPin(readFileSync(join(lib, "VENDOR.md"), "utf8"));
  expect(pin?.version).toBe(UNDERSTAND_VERSION);
  expect(pin?.commit).toMatch(/^[0-9a-f]{40}$/);
  for (const file of [".claude-plugin/plugin.json", "package.json", "packages/viewer/package.json"]) {
    const got: unknown = JSON.parse(readFileSync(join(lib, file), "utf8"));
    expect(got).toMatchObject({ version: UNDERSTAND_VERSION });
  }
});

test("canopy's health file checks for a newer release with the script itself", () => {
  const { checks, errors } = parseHealthFile(readFileSync(join(ROOT, ".canopy/health.json"), "utf8"));
  expect(errors).toEqual([]);
  expect(checks.find((c) => c.name === "understand")).toMatchObject({ kind: "command", run: "bun scripts/understand-update.ts --check", heal: "none" });
});

describe("bun run understand:update", () => {
  const SCRIPT = join(ROOT, "scripts/understand-update.ts");
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
  const viewer = (port: string): string => ["// the viewer", "const a = 1;", "const server = createServer((req, res) => {", "  const url = req.url;", "});", "const b = 2;", "const c = 3;", `let port = ${port};`, ""].join("\n");
  const P = "understand-anything-plugin";

  /** an upstream with releases v1.0.0 and v1.1.0, and a canopy checkout pinned to v1.0.0 with one edit */
  function fixture(canopyEdit: (s: string) => string, upstreamViewer: string) {
    const dir = mkdtempSync(join(tmpdir(), "ua-vendor-"));
    const up = join(dir, "upstream");
    const root = join(dir, "canopy");
    mkdirSync(up);
    git(up, "init", "-q");
    const v1 = {
      [`${P}/.claude-plugin/plugin.json`]: '{ "name": "understand-anything", "version": "1.0.0" }\n',
      [`${P}/packages/viewer/bin/viewer.mjs`]: viewer("5173"),
      [`${P}/skills/understand/a.mjs`]: "export const a = 1;\n",
      [`${P}/skills/understand/gone.mjs`]: "export const gone = 1;\n",
      [`${P}/hooks/hooks.json`]: "{}\n",
      [`${P}/pnpm-lock.yaml`]: "lockfileVersion: '9.0'\n",
      LICENSE: "MIT\n",
      "README.md": "left out\n",
    };
    put(up, v1);
    git(up, "add", "-A");
    git(up, "commit", "-qm", "1.0.0");
    git(up, "tag", "v1.0.0");
    const old = git(up, "rev-parse", "HEAD");
    put(up, {
      [`${P}/.claude-plugin/plugin.json`]: '{ "name": "understand-anything", "version": "1.1.0" }\n',
      [`${P}/packages/viewer/bin/viewer.mjs`]: upstreamViewer,
      [`${P}/skills/understand/a.mjs`]: "export const a = 2;\n",
      [`${P}/skills/understand/gone.mjs`]: null,
      [`${P}/skills/understand/new.mjs`]: "fetch('https://telemetry.example.test/ping');\n",
      [`${P}/hooks/hooks.json`]: '{ "changed": true }\n',
    });
    git(up, "add", "-A");
    git(up, "commit", "-qm", "feat: the second release");
    git(up, "tag", "v1.1.0");

    mkdirSync(root);
    git(root, "init", "-q");
    const lib = "lib/understand-anything";
    put(root, {
      [`${lib}/.claude-plugin/plugin.json`]: v1[`${P}/.claude-plugin/plugin.json`] ?? "",
      [`${lib}/packages/viewer/bin/viewer.mjs`]: canopyEdit(v1[`${P}/packages/viewer/bin/viewer.mjs`] ?? ""),
      [`${lib}/skills/understand/a.mjs`]: v1[`${P}/skills/understand/a.mjs`] ?? "",
      [`${lib}/skills/understand/gone.mjs`]: v1[`${P}/skills/understand/gone.mjs`] ?? "",
      [`${lib}/LICENSE`]: v1.LICENSE,
      [`${lib}/bun.lock`]: "canopy's lock\n",
      [`${lib}/VENDOR.md`]: `# canopy's copy\n\nUnderstand-Anything at **1.0.0**, commit \`${old}\` (2026-01-01). More words.\n`,
      "src/core/understand.ts": 'export const UNDERSTAND_VERSION = "1.0.0";\n',
    });
    git(root, "add", "-A");
    git(root, "commit", "-qm", "canopy");
    return { dir, up, root };
  }
  const update = (root: string, up: string, ...more: string[]) => {
    const p = Bun.spawnSync(["bun", SCRIPT, "--root", root, "--upstream", up, "--no-test", ...more], { stdout: "pipe", stderr: "pipe" });
    return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
  };
  const canopyEdit = (s: string): string => s.replace("  const url = req.url;", "  lastAsked = Date.now(); // canopy\n  const url = req.url;");

  test("pulls the newest release, merges canopy's edit, and keeps left-out files and canopy's own out of it", () => {
    const f = fixture(canopyEdit, viewer("5180"));
    try {
      const r = update(f.root, f.up);
      expect(r.err).toBe("");
      expect(r.code).toBe(0);
      const lib = join(f.root, "lib/understand-anything");
      const merged = readFileSync(join(lib, "packages/viewer/bin/viewer.mjs"), "utf8");
      expect(merged).toContain("lastAsked = Date.now(); // canopy");
      expect(merged).toContain("let port = 5180;");
      expect(readFileSync(join(lib, "skills/understand/a.mjs"), "utf8")).toBe("export const a = 2;\n");
      expect(existsSync(join(lib, "skills/understand/gone.mjs"))).toBe(false);
      expect(existsSync(join(lib, "skills/understand/new.mjs"))).toBe(true);
      expect(existsSync(join(lib, "hooks"))).toBe(false);
      expect(existsSync(join(lib, "pnpm-lock.yaml"))).toBe(false);
      expect(existsSync(join(lib, "README.md"))).toBe(false);
      expect(readFileSync(join(lib, "bun.lock"), "utf8")).toBe("canopy's lock\n");
      expect(readPin(readFileSync(join(lib, "VENDOR.md"), "utf8"))).toEqual({ version: "1.1.0", commit: git(f.up, "rev-parse", "HEAD"), date: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) });
      expect(readFileSync(join(f.root, "src/core/understand.ts"), "utf8")).toBe('export const UNDERSTAND_VERSION = "1.1.0";\n');
      expect(r.out).toContain("merged canopy's edit into upstream's change  packages/viewer/bin/viewer.mjs");
      expect(r.out).toContain("https://telemetry.example.test/ping");
      expect(r.out).toContain("- feat: the second release");

      const again = update(f.root, f.up);
      expect(again.code).toBe(2);
      expect(again.err).toContain("uncommitted changes");
      git(f.root, "add", "-A");
      git(f.root, "commit", "-qm", "1.1.0");
      expect(update(f.root, f.up).out).toContain("nothing to pull");
      const quiet = update(f.root, f.up, "--check");
      expect(quiet.code).toBe(0);
      expect(quiet.out.trim()).toBe("canopy has Understand-Anything 1.1.0, the newest release");
    } finally {
      rmSync(f.dir, { recursive: true, force: true });
    }
  });

  test("--check says in one line that a newer release is out", () => {
    const f = fixture(canopyEdit, viewer("5180"));
    try {
      const r = update(f.root, f.up, "--check");
      expect(r.code).toBe(1);
      expect(r.out.trim()).toBe("Understand-Anything 1.1.0 is out and canopy has 1.0.0: run the task understand-update (bun run understand:update)");
    } finally {
      rmSync(f.dir, { recursive: true, force: true });
    }
  });

  test("a change to the line canopy edits is a conflict left marked in the file", () => {
    const f = fixture(canopyEdit, viewer("5173").replace("  const url = req.url;", "  const url = new URL(req.url);"));
    try {
      const r = update(f.root, f.up);
      expect(r.code).toBe(1);
      expect(r.out).toContain("CONFLICT  packages/viewer/bin/viewer.mjs");
      expect(readFileSync(join(f.root, "lib/understand-anything/packages/viewer/bin/viewer.mjs"), "utf8")).toContain("<<<<<<< canopy");
    } finally {
      rmSync(f.dir, { recursive: true, force: true });
    }
  });
});
