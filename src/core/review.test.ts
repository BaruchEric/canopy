import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileSensitive, parseRules, readRules, sensitiveWhy } from "./review";

let root = "";
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
