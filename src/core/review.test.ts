import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exec } from "./exec";
import { changedLines, classify, fileSensitive, MAX_FILES, parseRaw, parseRules, readRules, sensitiveWhy, sortBranch, type Rules } from "./review";
import type { RunReview } from "./types";

let root = "";
let n = 0;
const sh = async (cwd: string, ...args: string[]): Promise<string> => {
  const r = await exec(["git", ...args], { cwd });
  if (r.code !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
};
const put = async (cwd: string, files: Record<string, string | null>): Promise<void> => {
  for (const [name, body] of Object.entries(files)) {
    if (body === null) await rm(join(cwd, name), { force: true });
    else {
      await mkdir(join(cwd, name, ".."), { recursive: true });
      await writeFile(join(cwd, name), body);
    }
  }
};
const commitAll = async (cwd: string, msg = "c"): Promise<void> => {
  await sh(cwd, "add", "-A");
  await sh(cwd, "commit", "-q", "-m", msg);
};

/** A repo whose main holds `before`, and a branch `run` off it holding
 *  `after` on top; returns the repo's folder, checked out on the branch. */
async function branchWith(before: Record<string, string | null>, after: Record<string, string | null> | ((dir: string) => Promise<void>)): Promise<string> {
  const dir = join(root, `sort${++n}`);
  await exec(["git", "init", "-q", "-b", "main", dir]);
  await sh(dir, "config", "user.email", "t@t");
  await sh(dir, "config", "user.name", "t");
  await put(dir, { "seed.txt": "seed\n", ...before });
  await commitAll(dir);
  await sh(dir, "checkout", "-q", "-b", "run");
  if (typeof after === "function") await after(dir);
  else await put(dir, after);
  await commitAll(dir);
  return dir;
}

const RULES: Rules = { source: "file", autoLand: ["docs", "comments", "format"], approve: ["scripts/**"] };
const sortOf = (dir: string, rules: Rules = RULES, hasGates = true): Promise<RunReview> => sortBranch(dir, "main", rules, hasGates, false, 1);
const classesOf = (r: RunReview) => Object.fromEntries(r.files.map((f) => [f.path, f.why ? `${f.cls}: ${f.why}` : f.cls]));
const one = async (before: Record<string, string>, after: Record<string, string | null>) => classesOf(await sortOf(await branchWith(before, after)));

const TS = "/**\n * Adds.\n */\nexport function add(a: number, b: number): number {\n  return a + b;\n}\n";
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "canopy-review-"));
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("the rules file", () => {
  test("a good file", () => {
    expect(parseRules(JSON.stringify({ autoLand: ["docs", "format", "docs"], approve: ["src/secrets/**", " Dockerfile "] }))).toEqual({
      autoLand: ["docs", "format"],
      approve: ["src/secrets/**", "Dockerfile"],
    });
    expect(parseRules("{}")).toEqual({ autoLand: [], approve: [] });
  });

  test("logic never lands on its own", () => {
    expect(parseRules(JSON.stringify({ autoLand: ["docs", "logic"] }))).toEqual({ error: ".canopy/review.json: logic cannot land on its own; autoLand takes docs, comments and format" });
    expect(parseRules(JSON.stringify({ autoLand: ["prose"] }))).toEqual({ error: '.canopy/review.json: autoLand has "prose"; it takes docs, comments and format' });
  });

  test("a bad glob is named", () => {
    expect(parseRules(JSON.stringify({ approve: ["src/[ab/**"] }))).toEqual({ error: ".canopy/review.json: the glob src/[ab/** leaves a bracket open" });
    expect(parseRules(JSON.stringify({ approve: ["/etc/**"] }))).toMatchObject({ error: expect.stringContaining("the glob /etc/** starts with /") });
    expect(parseRules(JSON.stringify({ approve: ["../x"] }))).toMatchObject({ error: expect.stringContaining("climbs out") });
    expect(parseRules(JSON.stringify({ approve: [3] }))).toMatchObject({ error: expect.stringContaining("3, which is not a glob") });
  });

  test("not JSON, not an object, a misspelt key", () => {
    expect(parseRules("{")).toMatchObject({ error: expect.stringContaining("is not JSON") });
    expect(parseRules("[]")).toEqual({ error: ".canopy/review.json must be an object" });
    expect(parseRules(JSON.stringify({ aprove: ["x"] }))).toEqual({ error: ".canopy/review.json: unknown key aprove; it takes autoLand and approve" });
  });

  test("read from the main checkout: the file, no file, a broken file", async () => {
    const repo = join(root, "rules");
    await mkdir(join(repo, ".canopy"), { recursive: true });
    expect(await readRules(repo)).toEqual({ source: "none" });
    await writeFile(join(repo, ".canopy", "review.json"), JSON.stringify({ autoLand: ["docs"], approve: ["x/**"] }));
    expect(await readRules(repo)).toEqual({ source: "file", autoLand: ["docs"], approve: ["x/**"] });
    await writeFile(join(repo, ".canopy", "review.json"), "{");
    expect(await readRules(repo)).toMatchObject({ source: "error", error: expect.stringContaining("is not JSON") });
  });
});

describe("sensitive paths", () => {
  test("canopy's own list", () => {
    expect(sensitiveWhy(".github/workflows/ci.yml")).toBe("GitHub Actions or repo settings");
    expect(sensitiveWhy("bun.lock")).toBe("a lockfile");
    expect(sensitiveWhy("web/package-lock.json")).toBe("a lockfile");
    expect(sensitiveWhy("docs/CLAUDE.md")).toBe("instructions agents read");
    expect(sensitiveWhy("pkg/Skill.md")).toBe("instructions agents read");
    expect(sensitiveWhy(".canopy/review.json")).toBe("under .canopy/, whose files run code");
    expect(sensitiveWhy(".canopy/gates.json")).toBe("under .canopy/, whose files run code");
    expect(sensitiveWhy("package.json")).toBe("package.json, which names programs that run");
    expect(sensitiveWhy("Dockerfile")).toBe("deploy config");
    expect(sensitiveWhy("README.md")).toBeNull();
    expect(sensitiveWhy("src/a.ts")).toBeNull();
  });

  test("agent instructions wherever an agent looks for them", () => {
    for (const p of [".cursor/rules/x.md", ".agents/a.md", ".github/copilot-instructions.md", ".github/instructions/ts.instructions.md", ".windsurfrules", ".clinerules", ".clinerules/one.md", ".claude/commands/x.md", ".codex/x.md"]) {
      expect([p, sensitiveWhy(p)]).toEqual([p, expect.any(String)]);
    }
    expect(sensitiveWhy(".github/copilot-instructions.md")).toBe("instructions agents read");
  });

  test("canopy's own workflow folder is not on the built-in list; a repo names it", () => {
    expect(sensitiveWhy("lib/workflows/ship.md")).toBeNull();
    expect(sensitiveWhy("lib/workflows/ship.md", ["lib/**"])).toBe("matches lib/** in .canopy/review.json");
  });

  test("a repo glob, folded only when the checkout folds case", () => {
    expect(sensitiveWhy("scripts/deploy.sh", ["scripts/**"])).toBe("matches scripts/** in .canopy/review.json");
    expect(sensitiveWhy("Scripts/deploy.sh", ["scripts/**"])).toBeNull();
    expect(sensitiveWhy("Scripts/deploy.sh", ["scripts/**"], true)).toBe("matches scripts/** in .canopy/review.json");
    expect(sensitiveWhy("src/core/Secrets.ts", ["src/core/secret*.ts"], true)).toBe("matches src/core/secret*.ts in .canopy/review.json");
  });

  test("a rename or copy is judged by both its paths", () => {
    expect(fileSensitive({ path: "tools/deploy.sh", from: "scripts/deploy.sh" }, ["scripts/**"])).toBe("moved from scripts/deploy.sh: matches scripts/** in .canopy/review.json");
    expect(fileSensitive({ path: "scripts/deploy.sh", from: "tools/deploy.sh" }, ["scripts/**"])).toBe("matches scripts/** in .canopy/review.json");
    expect(fileSensitive({ path: "notes/review.json", from: ".canopy/review.json" })).toBe("moved from .canopy/review.json: under .canopy/, whose files run code");
    expect(fileSensitive({ path: "b.md", from: "a.md" })).toBeNull();
  });
});

describe("the pieces of the sort", () => {
  test("raw entries, renames included", () => {
    const z = ":100644 100644 aaa bbb M\0a.ts\0:100644 100644 ccc ddd R087\0old.md\0new.md\0:000000 100644 000 eee A\0n.md\0";
    expect(parseRaw(z)).toEqual([
      { status: "M", oldMode: "100644", newMode: "100644", oldSha: "aaa", newSha: "bbb", path: "a.ts" },
      { status: "R", oldMode: "100644", newMode: "100644", oldSha: "ccc", newSha: "ddd", from: "old.md", path: "new.md" },
      { status: "A", oldMode: "000000", newMode: "100644", oldSha: "000", newSha: "eee", path: "n.md" },
    ]);
  });

  test("changed lines leave the headers out", () => {
    const d = "diff --git a/x.ts b/x.ts\nindex 1..2 100644\n--- a/x.ts\n+++ b/x.ts\n@@ -1 +1 @@\n--- a removed comment line\n+// added\n";
    expect(changedLines(d)).toEqual(["-- a removed comment line", "// added"]);
  });

  test("txt, mdx and a docs folder", () => {
    const sides = { old: "a\n", new: "b\n", changed: [] };
    expect(classify("requirements.txt", sides)).toEqual({ cls: "logic", why: "a .txt file outside docs, which a program may read" });
    expect(classify("CMakeLists.txt", sides).cls).toBe("logic");
    expect(classify("LICENSE.txt", sides).cls).toBe("docs");
    expect(classify("docs/notes.txt", sides).cls).toBe("docs");
    expect(classify("guide.rst", sides).cls).toBe("docs");
    expect(classify("page.mdx", sides).cls).toBe("logic");
    expect(classify("docs/page.mdx", sides).cls).toBe("logic");
    expect(classify("docs/site.css", sides).cls).toBe("logic");
    expect(classify("docs/diagram.excalidraw", sides).cls).toBe("docs");
    expect(classify("docs/Makefile", sides).cls).toBe("logic");
  });

  test("every directive the pattern names", () => {
    const base = "export const x = 1;\n";
    for (const d of ["// @ts-nocheck", "// @ts-check", "// @ts-ignore", "// @ts-expect-error", "// eslint-disable-next-line", "/* eslint-enable */", "// oxlint-disable-next-line no-console", "/* oxlint-enable */", "// biome-ignore lint: x", "// deno-lint-ignore", "// prettier-ignore", "/* c8 ignore next */", "/* istanbul ignore next */", "/** @jsx h */", "/** @jsxImportSource preact */", "/* @vite-ignore */", "/* webpackChunkName: \"a\" */", "/*#__PURE__*/", "/* @__NO_SIDE_EFFECTS__ */", "//# sourceMappingURL=x.map", "/// <reference types=\"bun\" />", "#!/usr/bin/env bun"]) {
      const got = classify("x.ts", { old: base, new: `${d}\n${base}`, changed: [d] });
      expect([d, got.cls, got.why?.startsWith("a directive: ")]).toEqual([d, "logic", true]);
    }
  });
});

describe("the sort", () => {
  test("each class, and a verdict of auto when they all may land", async () => {
    const dir = await branchWith(
      { "README.md": "# x\n", "a.ts": TS, "b.ts": "export function f(a: number, b: number) { return a + b; }\n" },
      { "README.md": "# x\n\nMore words.\n", "a.ts": TS.replace("Adds.", "Adds two numbers."), "b.ts": "export function f(a: number, b: number) {\n  return a + b;\n}\n", "docs/new.md": "new\n" },
    );
    const r = await sortOf(dir);
    expect(classesOf(r)).toEqual({ "README.md": "docs", "a.ts": "comments", "b.ts": "format", "docs/new.md": "docs" });
    expect(r.verdict).toBe("auto");
    expect(r.sensitiveId).toBeUndefined();
    expect([r.base, r.head]).toEqual([await sh(dir, "rev-parse", "main"), await sh(dir, "rev-parse", "HEAD")]);
  });

  test("a code change is logic and waits for land", async () => {
    const r = await sortOf(await branchWith({ "a.ts": TS }, { "a.ts": TS.replace("a + b", "a - b") }));
    expect([r.verdict, classesOf(r)]).toEqual(["land", { "a.ts": "logic" }]);
  });

  test("what the comment check sees through", async () => {
    expect(await one({ "a.ts": "/*\n * note\n */\nexport const x = 1;\n" }, { "a.ts": "/*\n */ export const y = 2; /*\n */\nexport const x = 1;\n" })).toEqual({ "a.ts": "logic" });
    expect(await one({ "a.ts": "export const s = `a\nb`;\n" }, { "a.ts": "export const s = `a\n// x\nb`;\n" })).toEqual({ "a.ts": "logic" });
    expect(await one({ "a.ts": "export const a: number = 1;\n" }, { "a.ts": "export const a: 1 = 1;\n" })).toEqual({ "a.ts": "logic" });
    expect(await one({ "a.ts": "export const x = 1;\n" }, { "a.ts": "export const x = 1; // the one\n" })).toEqual({ "a.ts": "logic" });
    expect(await one({ "a.ts": "export const x = 1;\n" }, { "a.ts": "// @ts-ignore\nexport const x = 1;\n" })).toEqual({ "a.ts": "logic: a directive: @ts-ignore" });
    expect(await one({ "a.ts": "export const x = 1;\n" }, { "a.ts": "// eslint-disable-next-line\nexport const x = 1;\n" })).toEqual({ "a.ts": "logic: a directive: eslint-disable" });
    expect(await one({ "a.ts": "export const x = 1;\n" }, { "a.ts": "// oxlint-disable-next-line no-console\nexport const x = 1;\n" })).toEqual({ "a.ts": "logic: a directive: oxlint-disable" });
    expect(await one({ "a.ts": "export const x = 1;\n" }, { "a.ts": "export const x = ;\n// broken\n" })).toEqual({ "a.ts": "logic: does not parse" });
  });

  test("a macro import never runs: the guard catches the plain form, and the transpiler refuses the rest", async () => {
    const sentinel = join(root, `macro-ran-${n}`);
    const macro = `import { writeFileSync } from "node:fs";\nexport function m() { writeFileSync(${JSON.stringify(sentinel)}, "ran"); return 1; }\n`;
    const plain = await one({ "m.ts": macro, "a.ts": "export const v = 1;\n" }, { "a.ts": 'import { m } from "./m.ts" with { type: "macro" };\nexport const v = m();\n' });
    expect(plain["a.ts"]).toBe("logic: a macro import");
    const quoted = await one({ "m.ts": macro, "a.ts": "export const v = 1;\n" }, { "a.ts": 'import { m } from "./m.ts" with { "type": "macro" };\nexport const v = m();\n' });
    expect(quoted["a.ts"]).toBe("logic: a macro import");
    // an escape the guard cannot read reaches the transpiler, which refuses it
    const escaped = await one({ "m.ts": macro, "a.ts": "export const v = 1;\n" }, { "a.ts": 'import { m } from "./m.ts" with { type: "\\u006dacro" };\nexport const v = m();\n' });
    expect(escaped["a.ts"]).toBe("logic: does not parse");
    expect(existsSync(sentinel)).toBe(false);
  });

  test("a rename, a delete, a mode change, a symlink and a binary file are logic", async () => {
    const dir = await branchWith({ "old.md": "o\n", "gone.md": "g\n", "run.sh": "echo\n", "pic.md": "p\n" }, async (d) => {
      await rename(join(d, "old.md"), join(d, "new.md"));
      await rm(join(d, "gone.md"));
      await chmod(join(d, "run.sh"), 0o755);
      await symlink("new.md", join(d, "link.md"));
      await writeFile(join(d, "pic.md"), Buffer.from([0x50, 0, 0x4e, 0x47]));
    });
    expect(classesOf(await sortOf(dir))).toEqual({
      "new.md": "logic: renamed from old.md",
      "gone.md": "logic: deleted",
      "run.sh": "logic: mode 100644 to 100755",
      "link.md": "logic: a symlink",
      "pic.md": "logic: binary",
    });
  });

  test("a new markdown file is docs, a script in docs is code", async () => {
    expect(await one({}, { "notes/new.md": "hi\n", "docs/build.ts": "export const x = 1;\n", "docs/guide.txt": "words\n" })).toEqual({
      "notes/new.md": "docs",
      "docs/build.ts": "logic",
      "docs/guide.txt": "docs",
    });
  });

  test("a sensitive file needs approval, a comment-only change included, with an id", async () => {
    const r = await sortOf(await branchWith({ "scripts/go.ts": TS }, { "scripts/go.ts": TS.replace("Adds.", "Adds them.") }));
    expect(r.verdict).toBe("approve");
    expect(r.files).toEqual([{ path: "scripts/go.ts", cls: "comments", sensitive: "matches scripts/** in .canopy/review.json" }]);
    expect(r.sensitiveId).toMatch(/^[0-9a-f]{40}$/);
  });

  test("deleting the rules file, or moving a script out of scripts/, needs approval", async () => {
    const del = await sortOf(await branchWith({ ".canopy/review.json": "{}\n" }, { ".canopy/review.json": null }));
    expect([del.verdict, del.files[0]?.sensitive]).toEqual(["approve", "under .canopy/, whose files run code"]);
    const moved = await sortOf(
      await branchWith({ "scripts/deploy.sh": "echo deploy\n" }, async (d) => {
        await mkdir(join(d, "tools"));
        await rename(join(d, "scripts/deploy.sh"), join(d, "tools/deploy.sh"));
      }),
    );
    expect(moved.verdict).toBe("approve");
    expect(moved.files[0]).toMatchObject({ path: "tools/deploy.sh", from: "scripts/deploy.sh", sensitive: "moved from scripts/deploy.sh: matches scripts/** in .canopy/review.json" });
    expect(moved.sensitiveId).toBeTruthy();
  });

  test("the sensitive id stays when main gains lines above the change and moves on a trailing space", async () => {
    const body = Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n") + "\n";
    const dir = await branchWith({ "scripts/s.sh": body }, { "scripts/s.sh": body.replace("line 15", "line fifteen") });
    const first = await sortOf(dir);
    await sh(dir, "checkout", "-q", "main");
    await put(dir, { "scripts/s.sh": `# head\n# more\n${body}` });
    await commitAll(dir, "main moves");
    await sh(dir, "checkout", "-q", "run");
    await sh(dir, "rebase", "-q", "main");
    const again = await sortOf(dir);
    expect(again.head).not.toBe(first.head);
    expect(again.sensitiveId).toBe(first.sensitiveId!);
    await put(dir, { "scripts/s.sh": `# head\n# more\n${body.replace("line 15", "line fifteen ")}` });
    await commitAll(dir, "a trailing space");
    expect((await sortOf(dir)).sensitiveId).not.toBe(first.sensitiveId!);
  });

  test("no rules, no gates, broken rules and too many files", async () => {
    const dir = await branchWith({ "README.md": "a\n" }, { "README.md": "b\n" });
    expect(await sortOf(dir, { source: "none" })).toMatchObject({ verdict: "land", why: "no review rules" });
    expect(await sortOf(dir, RULES, false)).toMatchObject({ verdict: "land", why: "no gates to run" });
    expect(await sortOf(dir, { source: "error", error: "bad" })).toMatchObject({ verdict: "approve", why: "bad" });
    expect(await sortOf(dir, { source: "file", autoLand: ["comments"], approve: [] })).toMatchObject({ verdict: "land" });
    const many = await sortOf(await branchWith({}, Object.fromEntries(Array.from({ length: MAX_FILES + 1 }, (_, i) => [`n/${i}.md`, "x\n"]))));
    expect([many.verdict, many.why, many.files.length, many.files[0]?.why]).toEqual(["land", `over ${MAX_FILES} files, not read`, MAX_FILES + 1, `not read: over ${MAX_FILES} files`]);
  });
});
