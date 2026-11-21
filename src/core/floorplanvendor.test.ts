import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { FLOORPLAN_VERSION } from "./floorplan";
import { parseHealthFile } from "./repohealth";
import {
  addressesIn,
  changelogHeadlines,
  compareVersions,
  isText,
  newAddresses,
  newestRelease,
  planFile,
  readPin,
  releaseTagNames,
  writePin,
  writeVersionConst,
} from "./floorplanvendor";

const ROOT = join(import.meta.dir, "../..");
const bytes = (s: string): Uint8Array => new TextEncoder().encode(s);

describe("the pin", () => {
  const md = "This folder is Floorplan at **0.11.0**, commit `94f81b463b7617e06d873ac71323ce71644c8399` (2026-11-16). canopy uses it.";
  test("reads the release, commit and date", () => {
    expect(readPin(md)).toEqual({ version: "0.11.0", commit: "94f81b463b7617e06d873ac71323ce71644c8399", date: "2026-11-16" });
    expect(readPin("no pin here")).toBeNull();
  });
  test("moves the pin and leaves the rest", () => {
    const moved = writePin(md, { version: "0.12.0", commit: "a".repeat(40), date: "2026-12-01" });
    expect(readPin(moved)).toEqual({ version: "0.12.0", commit: "a".repeat(40), date: "2026-12-01" });
    expect(moved.endsWith("canopy uses it.")).toBe(true);
    expect(() => writePin("nothing", { version: "1.0.0", commit: "a".repeat(40), date: "2026-01-01" })).toThrow();
  });
  test("sets FLOORPLAN_VERSION", () => {
    expect(writeVersionConst('x\nexport const FLOORPLAN_VERSION = "0.11.0";\ny', "0.12.1")).toBe('x\nexport const FLOORPLAN_VERSION = "0.12.1";\ny');
    expect(() => writeVersionConst("const other = 1;", "1.0.0")).toThrow();
  });
  test("the vendored copy, VENDOR.md's pin and FLOORPLAN_VERSION agree", () => {
    const plugin: unknown = JSON.parse(readFileSync(join(ROOT, "lib/floorplan/.claude-plugin/plugin.json"), "utf8"));
    expect(plugin).toMatchObject({ version: FLOORPLAN_VERSION });
    expect(readPin(readFileSync(join(ROOT, "lib/floorplan/VENDOR.md"), "utf8"))?.version).toBe(FLOORPLAN_VERSION);
  });
});

test("canopy's health file checks for a newer release with the script itself", () => {
  const { checks, errors } = parseHealthFile(readFileSync(join(ROOT, ".canopy/health.json"), "utf8"));
  expect(errors).toEqual([]);
  // the script, not bun run, which echoes the command on stderr: a command
  // check shows its last line, and that would be the echo
  expect(checks.find((c) => c.name === "floorplan")).toMatchObject({ kind: "command", run: "bun scripts/floorplan-update.ts --check", heal: "none" });
});

describe("releases", () => {
  test("compares x.y.z by number", () => {
    expect(compareVersions("0.9.0", "0.10.0")).toBeLessThan(0);
    expect(compareVersions("1.0.0", "0.99.9")).toBeGreaterThan(0);
    expect(compareVersions("0.11.0", "0.11.0")).toBe(0);
  });
  test("takes the newest release tag, upstream's form or a plain one", () => {
    expect(newestRelease(["floorplan--v0.9.0", "floorplan--v0.11.0", "floorplan--v0.10.0", "something-else", ""])).toEqual({ tag: "floorplan--v0.11.0", version: "0.11.0" });
    expect(newestRelease(["v1.2.3", "v1.10.0"])).toEqual({ tag: "v1.10.0", version: "1.10.0" });
    expect(newestRelease(["main", "nightly"])).toBeNull();
  });
  test("reads tag names out of git ls-remote", () => {
    const out = "044cab95fb898b9788c4bf0d8b1c0711c226dd92\trefs/tags/floorplan--v0.8.0\nfcb2740d0063060151a35c562a55d113e7d9296c\trefs/tags/floorplan--v0.9.0\n\n";
    expect(releaseTagNames(out)).toEqual(["floorplan--v0.8.0", "floorplan--v0.9.0"]);
  });
});

describe("planFile", () => {
  const a = bytes("a");
  const b = bytes("b");
  const c = bytes("c");
  test("a file canopy never changed takes upstream's", () => {
    expect(planFile(a, a, a)).toBe("same");
    expect(planFile(a, a, b)).toBe("take");
    expect(planFile(null, null, b)).toBe("add");
    expect(planFile(a, a, null)).toBe("remove");
    expect(planFile(a, null, null)).toBe("same");
  });
  test("canopy's edit stays, or merges with upstream's change", () => {
    expect(planFile(a, b, a)).toBe("keep");
    expect(planFile(a, b, b)).toBe("same");
    expect(planFile(a, b, c)).toBe("merge");
  });
  test("a removal against an edit, or two additions, is a conflict", () => {
    expect(planFile(a, b, null)).toBe("conflict");
    expect(planFile(a, null, c)).toBe("conflict");
    expect(planFile(null, b, c)).toBe("conflict");
    expect(planFile(a, null, a)).toBe("keep");
  });
});

describe("text and addresses", () => {
  test("a NUL byte means binary", () => {
    expect(isText(bytes("plain"))).toBe(true);
    expect(isText(new Uint8Array([0x89, 0x50, 0, 1]))).toBe(false);
  });
  test("finds addresses and the ones a release adds", () => {
    expect(addressesIn("see https://example.com/a. and 'http://x.test/b?c=1', (https://y.test)")).toEqual(["https://example.com/a", "http://x.test/b?c=1", "https://y.test"]);
    expect(newAddresses(["https://a.test"], ["https://b.test", "https://a.test", "https://b.test"])).toEqual(["https://b.test"]);
  });
  test("the changelog's headlines between two releases", () => {
    const log = [
      "# Changelog",
      "",
      "## 0.12.0 (2026-12-01)",
      "",
      "- **New thing:** long words",
      "  - **nested:** not a headline",
      "- **Other fix** more words",
      "",
      "## 0.11.0 (2026-11-16)",
      "",
      "- **Old thing:** words",
    ].join("\n");
    expect(changelogHeadlines(log, "0.11.0", "0.12.0")).toEqual(["## 0.12.0 (2026-12-01)", "  - New thing", "  - Other fix"]);
    expect(changelogHeadlines(log, "0.12.0", "0.12.0")).toEqual([]);
  });
});

describe("bun run floorplan:update", () => {
  const SCRIPT = join(ROOT, "scripts/floorplan-update.ts");
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
  const serve = (waitlist: string, port: string): string => ["// the map's server", `const WAITLIST_URL = ${waitlist};`, "const a = 1;", "const b = 2;", "const c = 3;", "const d = 4;", `const PORT = ${port};`, ""].join("\n");

  /** an upstream with releases 1.0.0 and 1.1.0, and a canopy checkout pinned to 1.0.0 with one edit */
  function fixture(canopyEdit: (s: string) => string, upstreamServe: string) {
    const dir = mkdtempSync(join(tmpdir(), "fp-vendor-"));
    const up = join(dir, "upstream");
    const root = join(dir, "canopy");
    mkdirSync(up);
    git(up, "init", "-q");
    const v1 = {
      ".claude-plugin/plugin.json": '{ "name": "floorplan", "version": "1.0.0" }\n',
      LICENSE: "MIT\n",
      "skills/floorplan/assets/serve.mjs": serve("'https://wait.example.test/join'", "4378"),
      "skills/floorplan/scripts/a.mjs": "export const a = 1;\n",
      "skills/floorplan/scripts/gone.mjs": "export const gone = 1;\n",
      "README.md": "left out\n",
      "CHANGELOG.md": "# Changelog\n\n## 1.0.0 (2026-01-01)\n\n- **First:** words\n",
    };
    put(up, v1);
    git(up, "add", "-A");
    git(up, "commit", "-qm", "1.0.0");
    git(up, "tag", "floorplan--v1.0.0");
    const old = git(up, "rev-parse", "HEAD");
    put(up, {
      ".claude-plugin/plugin.json": '{ "name": "floorplan", "version": "1.1.0" }\n',
      "skills/floorplan/assets/serve.mjs": upstreamServe,
      "skills/floorplan/scripts/a.mjs": "export const a = 2;\n",
      "skills/floorplan/scripts/gone.mjs": null,
      "skills/floorplan/scripts/new.mjs": "fetch('https://telemetry.example.test/ping');\n",
      "CHANGELOG.md": "# Changelog\n\n## 1.1.0 (2026-02-01)\n\n- **Second:** words\n\n## 1.0.0 (2026-01-01)\n\n- **First:** words\n",
    });
    git(up, "add", "-A");
    git(up, "commit", "-qm", "1.1.0");
    git(up, "tag", "floorplan--v1.1.0");

    mkdirSync(root);
    git(root, "init", "-q");
    put(root, {
      "lib/floorplan/.claude-plugin/plugin.json": v1[".claude-plugin/plugin.json"],
      "lib/floorplan/LICENSE": v1.LICENSE,
      "lib/floorplan/skills/floorplan/assets/serve.mjs": canopyEdit(v1["skills/floorplan/assets/serve.mjs"]),
      "lib/floorplan/skills/floorplan/scripts/a.mjs": v1["skills/floorplan/scripts/a.mjs"],
      "lib/floorplan/skills/floorplan/scripts/gone.mjs": v1["skills/floorplan/scripts/gone.mjs"],
      "lib/floorplan/VENDOR.md": `# canopy's copy\n\nFloorplan at **1.0.0**, commit \`${old}\` (2026-01-01). More words.\n`,
      "src/core/floorplan.ts": 'export const FLOORPLAN_VERSION = "1.0.0";\n',
    });
    git(root, "add", "-A");
    git(root, "commit", "-qm", "canopy");
    return { dir, up, root };
  }
  const update = (root: string, up: string, ...more: string[]) => {
    const p = Bun.spawnSync(["bun", SCRIPT, "--root", root, "--upstream", up, "--no-test", ...more], { stdout: "pipe", stderr: "pipe" });
    return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
  };
  const canopyEdit = (s: string): string => s.replace("'https://wait.example.test/join'", "'' // canopy: off");

  test("pulls the newest release and merges canopy's edit into it", () => {
    const f = fixture(canopyEdit, serve("'https://wait.example.test/join'", "4400"));
    try {
      const r = update(f.root, f.up);
      expect(r.err).toBe("");
      expect(r.code).toBe(0);
      const lib = join(f.root, "lib/floorplan");
      const merged = readFileSync(join(lib, "skills/floorplan/assets/serve.mjs"), "utf8");
      expect(merged).toContain("const WAITLIST_URL = '' // canopy: off;");
      expect(merged).toContain("const PORT = 4400;");
      expect(readFileSync(join(lib, "skills/floorplan/scripts/a.mjs"), "utf8")).toBe("export const a = 2;\n");
      expect(existsSync(join(lib, "skills/floorplan/scripts/gone.mjs"))).toBe(false);
      expect(existsSync(join(lib, "skills/floorplan/scripts/new.mjs"))).toBe(true);
      expect(existsSync(join(lib, "README.md"))).toBe(false);
      expect(readPin(readFileSync(join(lib, "VENDOR.md"), "utf8"))).toEqual({ version: "1.1.0", commit: git(f.up, "rev-parse", "HEAD"), date: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) });
      expect(readFileSync(join(f.root, "src/core/floorplan.ts"), "utf8")).toBe('export const FLOORPLAN_VERSION = "1.1.0";\n');
      expect(r.out).toContain("merged canopy's edit into upstream's change  skills/floorplan/assets/serve.mjs");
      expect(r.out).toContain("https://telemetry.example.test/ping");
      expect(r.out).toContain("- Second");

      const again = update(f.root, f.up);
      expect(again.code).toBe(2);
      expect(again.err).toContain("uncommitted changes");
      git(f.root, "add", "-A");
      git(f.root, "commit", "-qm", "1.1.0");
      const current = update(f.root, f.up);
      expect(current.code).toBe(0);
      expect(current.out).toContain("nothing to pull");
      const quiet = update(f.root, f.up, "--check");
      expect(quiet.code).toBe(0);
      expect(quiet.out.trim()).toBe("canopy has Floorplan 1.1.0, the newest release");
    } finally {
      rmSync(f.dir, { recursive: true, force: true });
    }
  });

  test("--check says in one line that a newer release is out, dirty tree or not", () => {
    const f = fixture(canopyEdit, serve("'https://wait.example.test/join'", "4400"));
    try {
      writeFileSync(join(f.root, "lib/floorplan/LICENSE"), "MIT, edited\n");
      const r = update(f.root, f.up, "--check");
      expect(r.code).toBe(1);
      expect(r.err).toBe("");
      expect(r.out.trim()).toBe("Floorplan 1.1.0 is out and canopy has 1.0.0: run the task floorplan-update (bun run floorplan:update)");
      const away = update(f.root, join(f.dir, "missing"), "--check");
      expect(away.code).toBe(2);
      expect(away.err).toContain("could not ask");
    } finally {
      rmSync(f.dir, { recursive: true, force: true });
    }
  });

  test("a change to the line canopy edits is a conflict left marked in the file", () => {
    const f = fixture(canopyEdit, serve("'https://wait.example.test/v2'", "4378"));
    try {
      const r = update(f.root, f.up);
      expect(r.code).toBe(1);
      expect(r.out).toContain("CONFLICT  skills/floorplan/assets/serve.mjs");
      const text = readFileSync(join(f.root, "lib/floorplan/skills/floorplan/assets/serve.mjs"), "utf8");
      expect(text).toContain("<<<<<<< canopy");
      expect(text).toContain(">>>>>>> floorplan 1.1.0");
    } finally {
      rmSync(f.dir, { recursive: true, force: true });
    }
  });

  test("--ref takes a named release, and an unknown one stops", () => {
    const f = fixture(canopyEdit, serve("'https://wait.example.test/join'", "4400"));
    try {
      expect(update(f.root, f.up, "--ref", "floorplan--v1.0.0").out).toContain("nothing to pull");
      const r = update(f.root, f.up, "--ref", "nope");
      expect(r.code).toBe(2);
      expect(r.err).toContain("no tag, branch or commit called nope");
    } finally {
      rmSync(f.dir, { recursive: true, force: true });
    }
  });
});
