import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { link, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git } from "./exec";
import { commitSeed, makeSeed, readSeed, writeSeed } from "./seed";

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "canopy-seed-"));
});
afterAll(() => rm(dir, { recursive: true, force: true }));

const log = async (path: string) => (await git(path, ["log", "--format=%an <%ae>|%s"])).stdout.trim().split("\n");

/** an upstream repo with one commit by "u", holding the given files */
async function upstream(name: string, files: Record<string, string>, links: Record<string, string> = {}): Promise<string> {
  const up = join(dir, name);
  await mkdir(up);
  await git(up, ["init", "-q", "-b", "main"]);
  for (const [rel, text] of Object.entries(files)) {
    await mkdir(join(up, rel, ".."), { recursive: true });
    await writeFile(join(up, rel), text);
  }
  for (const [rel, target] of Object.entries(links)) await symlink(target, join(up, rel));
  // -f: the user's global ignore may name .mcp.json or settings.local.json
  await git(up, ["add", "-f", "--", ...Object.keys(files), ...Object.keys(links)]);
  await git(up, ["-c", "user.name=u", "-c", "user.email=u@x", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "first"]);
  return up;
}

describe("makeSeed", () => {
  test("a new idea is a fresh repo on main with the files in one canopy commit", async () => {
    const path = join(dir, "_incubator", "idea");
    await makeSeed(path, { ".canopy/brief.md": "# Idea\n", ".canopy/inputs.md": "# Inputs\n" }, undefined, { self: "mini" });
    expect(await readFile(join(path, ".canopy", "brief.md"), "utf8")).toBe("# Idea\n");
    expect((await git(path, ["branch", "--show-current"])).stdout.trim()).toBe("main");
    expect(await log(path)).toEqual(["canopy <canopy@mini>|seed: a new project from the incubator"]);
  });
  test("a folder that is there already is refused", async () => {
    const path = join(dir, "taken");
    await mkdir(path);
    await expect(makeSeed(path, {}, undefined, { self: "mini" })).rejects.toThrow("is there already");
  });
  test("a local path is never cloned", async () => {
    await expect(makeSeed(join(dir, "c1"), {}, "/etc", { self: "mini" })).rejects.toThrow("not a network git url");
  });
  test("a clone keeps its history, calls its remote upstream, and gets the files on top", async () => {
    const up = await upstream("upstream", { "README.md": "hi\n" });
    const path = join(dir, "_incubator", "cloned");
    await makeSeed(path, { ".canopy/brief.md": "# C\n" }, up, { self: "mini", originOk: () => true });
    expect((await git(path, ["remote"])).stdout.trim()).toBe("upstream");
    expect(await log(path)).toEqual(["canopy <canopy@mini>|seed: a new project from the incubator", "u <u@x>|first"]);
  });
  test("a clone loses the project's claude and mcp settings in a commit of its own, before anything runs", async () => {
    const up = await upstream("risky", {
      "README.md": "hi\n",
      ".claude/settings.json": '{"hooks":{}}\n',
      ".claude/settings.local.json": '{"permissions":{"allow":["Bash"]}}\n',
      ".claude/commands/x.md": "a command\n",
      ".mcp.json": '{"mcpServers":{}}\n',
    });
    const path = join(dir, "_incubator", "risky");
    await makeSeed(path, { ".canopy/brief.md": "# R\n" }, up, { self: "mini", originOk: () => true });
    expect(existsSync(join(path, ".claude", "settings.json"))).toBe(false);
    expect(existsSync(join(path, ".claude", "settings.local.json"))).toBe(false);
    expect(existsSync(join(path, ".mcp.json"))).toBe(false);
    expect(await readFile(join(path, ".claude", "commands", "x.md"), "utf8")).toBe("a command\n");
    expect(await readFile(join(path, ".canopy", "brief.md"), "utf8")).toBe("# R\n");
    const lines = await log(path);
    expect(lines[0]).toBe("canopy <canopy@mini>|seed: drop the cloned project's agent settings");
    expect(lines.slice(1)).toEqual(["canopy <canopy@mini>|seed: a new project from the incubator", "u <u@x>|first"]);
    const removed = (await git(path, ["show", "--name-status", "--format=", "HEAD"])).stdout.trim().split("\n").sort();
    expect(removed).toEqual(["D\t.claude/settings.json", "D\t.claude/settings.local.json", "D\t.mcp.json"]);
    expect((await git(path, ["status", "--porcelain"])).stdout).toBe("");
  });
  test("a clone whose .claude is a symlink loses the link itself", async () => {
    const up = await upstream("linked-claude", { "README.md": "hi\n", "conf/settings.json": '{"hooks":{}}\n' }, { ".claude": "conf" });
    const path = join(dir, "_incubator", "linked-claude");
    await makeSeed(path, {}, up, { self: "mini", originOk: () => true });
    expect(existsSync(join(path, ".claude"))).toBe(false);
    expect((await log(path))[0]).toBe("canopy <canopy@mini>|seed: drop the cloned project's agent settings");
    expect((await git(path, ["status", "--porcelain"])).stdout).toBe("");
  });
  test("a clone that carries its own .canopy symlink is refused, and the clean-up takes the link, not what it points at", async () => {
    const outside = join(dir, "clone-target");
    await mkdir(outside);
    await writeFile(join(outside, "brief.md"), "theirs\n");
    const up = await upstream("canopy-link", { "README.md": "hi\n" }, { ".canopy": outside });
    const path = join(dir, "_incubator", "canopy-link");
    await expect(makeSeed(path, { ".canopy/brief.md": "# L\n" }, up, { self: "mini", originOk: () => true })).rejects.toThrow("symlink");
    expect(existsSync(path)).toBe(false);
    expect(await readdir(outside)).toEqual(["brief.md"]);
    expect(await readFile(join(outside, "brief.md"), "utf8")).toBe("theirs\n");
  });
  test("a clone that fails leaves no folder behind", async () => {
    const path = join(dir, "_incubator", "nothing");
    await expect(makeSeed(path, {}, join(dir, "no-such-repo"), { self: "mini", originOk: () => true })).rejects.toThrow("git clone failed");
    expect(existsSync(path)).toBe(false);
  });
});

describe("commitSeed", () => {
  test("only the named files, and nothing when they did not change", async () => {
    const path = join(dir, "_incubator", "idea");
    await writeFile(join(path, ".canopy", "intent.md"), "want\n");
    await writeFile(join(path, "stray.txt"), "not mine\n");
    expect(await commitSeed(path, [".canopy/intent.md", ".canopy/missing.md"], "clarify: Idea", "mini")).toBe(true);
    expect((await log(path))[0]).toBe("canopy <canopy@mini>|clarify: Idea");
    expect((await git(path, ["status", "--porcelain"])).stdout).toContain("?? stray.txt");
    expect(await commitSeed(path, [".canopy/intent.md"], "again", "mini")).toBe(false);
  });
});

describe("readSeed and writeSeed", () => {
  test("a plain file reads; a missing one is null", async () => {
    const path = join(dir, "_incubator", "idea");
    expect(await readSeed(path, ".canopy/intent.md")).toBe("want\n");
    expect(await readSeed(path, ".canopy/nothing.md")).toBeNull();
    expect(await readSeed(path, "nowhere/nothing.md")).toBeNull();
  });
  test("a symlink is refused both ways, and so is a file too big to be the agent's words", async () => {
    const path = join(dir, "_incubator", "idea");
    await writeFile(join(dir, "secret"), "key\n");
    await symlink(join(dir, "secret"), join(path, ".canopy", "questions.json"));
    await expect(readSeed(path, ".canopy/questions.json")).rejects.toThrow("symlink");
    await expect(writeSeed(path, ".canopy/questions.json", "[]")).rejects.toThrow("symlink");
    expect(await readFile(join(dir, "secret"), "utf8")).toBe("key\n");
    await writeFile(join(path, ".canopy", "big.md"), "x".repeat(256 * 1024 + 1));
    await expect(readSeed(path, ".canopy/big.md")).rejects.toThrow("over 256 KB");
  });
  test("writeSeed makes the folder it needs", async () => {
    const path = join(dir, "_incubator", "idea");
    await writeSeed(path, ".canopy/deep/x.md", "x");
    expect(await readFile(join(path, ".canopy", "deep", "x.md"), "utf8")).toBe("x");
  });
  test("a .canopy folder swapped for a symlink out of the seed is refused both ways, and nothing lands outside", async () => {
    const path = join(dir, "_incubator", "swapped");
    await makeSeed(path, { ".canopy/intent.md": "mine\n" }, undefined, { self: "mini" });
    const outside = join(dir, "dot-ssh");
    await mkdir(outside);
    await writeFile(join(outside, "intent.md"), "private key\n");
    await rename(join(path, ".canopy"), join(path, "was-canopy"));
    await symlink(outside, join(path, ".canopy"));
    await expect(readSeed(path, ".canopy/intent.md")).rejects.toThrow("symlink");
    await expect(readSeed(path, ".canopy/nothing.md")).rejects.toThrow("symlink");
    await expect(writeSeed(path, ".canopy/new.md", "x")).rejects.toThrow("symlink");
    await expect(writeSeed(path, ".canopy/intent.md", "x")).rejects.toThrow("symlink");
    await expect(writeSeed(path, ".canopy/deep/x.md", "x")).rejects.toThrow("symlink");
    expect((await readdir(outside)).sort()).toEqual(["intent.md"]);
    expect(await readFile(join(outside, "intent.md"), "utf8")).toBe("private key\n");
  });
  test("a deeper folder that is a symlink is refused too", async () => {
    const path = join(dir, "_incubator", "swapped");
    const outside = join(dir, "elsewhere");
    await mkdir(outside);
    await rm(join(path, ".canopy"));
    await mkdir(join(path, ".canopy"));
    await symlink(outside, join(path, ".canopy", "deep"));
    await expect(readSeed(path, ".canopy/deep/x.md")).rejects.toThrow("symlink");
    await expect(writeSeed(path, ".canopy/deep/x.md", "x")).rejects.toThrow("symlink");
    await expect(writeSeed(path, ".canopy/deep/more/x.md", "x")).rejects.toThrow("symlink");
    expect(await readdir(outside)).toEqual([]);
  });
  test("a path that climbs out of the seed or starts at the root is refused", async () => {
    const path = join(dir, "_incubator", "idea");
    await expect(readSeed(path, "../cloned/.canopy/brief.md")).rejects.toThrow("inside the seed");
    await expect(readSeed(path, "/etc/hosts")).rejects.toThrow("inside the seed");
    await expect(writeSeed(path, ".canopy/../../escape.md", "x")).rejects.toThrow("inside the seed");
    await expect(writeSeed(path, "", "x")).rejects.toThrow("inside the seed");
    expect(existsSync(join(dir, "_incubator", "escape.md"))).toBe(false);
  });
  test("a hard link to a file outside the seed is refused both ways, and committed by neither", async () => {
    const path = join(dir, "_incubator", "idea");
    const outside = join(dir, "hard-secret");
    await writeFile(outside, "key\n");
    await link(outside, join(path, ".canopy", "linked.md"));
    await expect(readSeed(path, ".canopy/linked.md")).rejects.toThrow("hard link");
    await expect(writeSeed(path, ".canopy/linked.md", "x")).rejects.toThrow("hard link");
    await expect(commitSeed(path, [".canopy/linked.md"], "leak", "mini")).rejects.toThrow("hard link");
    expect(await readFile(outside, "utf8")).toBe("key\n");
  });
  test("writeSeed replaces a longer file whole", async () => {
    const path = join(dir, "_incubator", "idea");
    await writeSeed(path, ".canopy/short.md", "a long first version\n");
    await writeSeed(path, ".canopy/short.md", "short\n");
    expect(await readSeed(path, ".canopy/short.md")).toBe("short\n");
  });
  test("a seed that is itself a symlink is refused", async () => {
    const link = join(dir, "_incubator", "alias");
    await symlink(join(dir, "_incubator", "idea"), link);
    await expect(readSeed(link, ".canopy/intent.md")).rejects.toThrow("symlink");
    await expect(writeSeed(link, ".canopy/y.md", "y")).rejects.toThrow("symlink");
  });
});
