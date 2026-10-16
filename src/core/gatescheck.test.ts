import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gatesCheck, gateTools, runCheck } from "./check";
import { exec } from "./exec";

const scratch: string[] = [];
afterAll(async () => {
  for (const d of scratch) await rm(d, { recursive: true, force: true });
});

const git = (dir: string, ...args: string[]) =>
  exec(["git", "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd: dir });

/** a repo with `committed` in its first commit and `loose` written after it */
async function repo(committed: Record<string, string>, loose: Record<string, string> = {}): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "canopy-gatescheck-"));
  scratch.push(dir);
  await git(dir, "init", "-q");
  const put = async (files: Record<string, string>): Promise<void> => {
    for (const [rel, text] of Object.entries(files)) {
      await mkdir(join(dir, rel, ".."), { recursive: true });
      await writeFile(join(dir, rel), text);
    }
  };
  await put(committed);
  if (Object.keys(committed).length > 0) {
    await git(dir, "add", "-A");
    await git(dir, "commit", "-q", "-m", "first");
  }
  await put(loose);
  return dir;
}

/** what `@gates` does in a repo: the script it becomes, run as a check */
async function run(dir: string): Promise<{ exit: number; output: string }> {
  const script = await gatesCheck(dir);
  return typeof script === "string" ? runCheck({ path: dir }, script) : script;
}

const gatesFile = (gates: { name: string; run: string }[]): string => JSON.stringify({ gates, setup: "echo setup-ran" });

describe("a workflow's @gates check runs the repo's gates", () => {
  test("the committed gates file, in order, stopping at the first red one with its exit", async () => {
    const dir = await repo({
      ".canopy/gates.json": gatesFile([
        { name: "one", run: "echo first-ran # a comment cuts nothing off" },
        { name: "two", run: "echo second-ran; exit 3" },
        { name: "three", run: "echo third-ran" },
      ]),
    });
    const r = await run(dir);
    expect(r.exit).toBe(3);
    expect(r.output).toContain("gates from .canopy/gates.json: one, two, three");
    expect(r.output).toContain("first-ran");
    expect(r.output).toContain("second-ran");
    expect(r.output).toContain("gate two failed");
    expect(r.output).not.toContain("third-ran");
    // setup belongs to a fresh worktree, not to the checkout a workflow runs in
    expect(r.output).not.toContain("setup-ran");
  });

  test("every gate green passes", async () => {
    const dir = await repo({ ".canopy/gates.json": gatesFile([{ name: "ok", run: "true" }]) });
    expect(await run(dir)).toEqual({ exit: 0, output: "gates from .canopy/gates.json: ok\n== ok: true\nevery gate passed" });
  });

  test("an edit to the gates file the last commit does not hold leaves the gates as they were", async () => {
    const dir = await repo(
      { ".canopy/gates.json": gatesFile([{ name: "strict", run: "exit 1" }]) },
      { ".canopy/gates.json": gatesFile([{ name: "loose", run: "true" }]) },
    );
    const r = await run(dir);
    expect(r.exit).toBe(1);
    expect(r.output).toContain("gate strict failed");
  });

  test("a gates file not yet committed does not count, and says so", async () => {
    const dir = await repo(
      { "package.json": JSON.stringify({ scripts: { lint: "echo lint-ran" } }) },
      { ".canopy/gates.json": gatesFile([{ name: "skip", run: "true" }]) },
    );
    const r = await run(dir);
    expect(r.exit).toBe(0);
    expect(r.output).toContain(".canopy/gates.json is not committed");
    expect(r.output).toContain("gates from package.json: lint");
    expect(r.output).toContain("lint-ran");
  });

  test("package.json's scripts from the working tree, and a word elsewhere in the file is no gate", async () => {
    const dir = await repo({}, { "package.json": JSON.stringify({ scripts: { build: "echo build-ran" }, dependencies: { test: "1.0.0", typecheck: "1.0.0" } }) });
    const r = await run(dir);
    expect(r.exit).toBe(0);
    expect(r.output).toContain("gates from package.json: build");
    expect(r.output).toContain("build-ran");
  });

  test("no gates file and no gate scripts pass and say so", async () => {
    const dir = await repo({ "README.md": "hi" });
    const r = await run(dir);
    expect(r.exit).toBe(0);
    expect(r.output).toContain("no gates");
  });

  test("a broken committed gates file fails with why, and nothing runs", async () => {
    const dir = await repo({ ".canopy/gates.json": "{", "package.json": JSON.stringify({ scripts: { test: "echo test-ran" } }) });
    const r = await gatesCheck(dir);
    expect(typeof r).not.toBe("string");
    expect(r).toMatchObject({ exit: 1 });
    expect(JSON.stringify(r)).toContain(".canopy/gates.json is not JSON");
  });

  test("a folder that is no repo fails rather than passing with no gates", async () => {
    const dir = await mkdtemp(join(tmpdir(), "canopy-gatescheck-bare-"));
    scratch.push(dir);
    const r = await gatesCheck(dir);
    expect(r).toMatchObject({ exit: 1 });
  });
});

describe("a step checked by @gates may run each gate's line", () => {
  test("the committed gates file's lines, as Bash rules", async () => {
    const dir = await repo({ ".canopy/gates.json": gatesFile([{ name: "rs", run: "cargo test" }, { name: "fmt", run: "cargo fmt --check" }]) });
    expect(await gateTools(dir)).toEqual(["Bash(cargo test)", "Bash(cargo fmt --check)"]);
  });

  test("a broken gates file gives none, and the check says why", async () => {
    const dir = await repo({ ".canopy/gates.json": "{" });
    expect(await gateTools(dir)).toEqual([]);
  });
});
