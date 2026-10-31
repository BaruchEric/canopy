import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exec } from "./exec";
import { pull } from "./git";

/** Two clones of one bare origin, `mine` set to pull with rebase. */
async function fixture(): Promise<{
  root: string;
  mine: string;
  other: string;
  git: (path: string, ...args: string[]) => Promise<string>;
}> {
  const root = await mkdtemp(join(tmpdir(), "canopy-pull-"));
  const origin = join(root, "origin.git"), mine = join(root, "mine"), other = join(root, "other");
  const git = async (path: string, ...args: string[]) => {
    const result = await exec(["git", "-C", path, ...args]);
    if (result.code !== 0) throw new Error(result.stderr);
    return result.stdout.trim();
  };
  await exec(["git", "init", "-q", "--bare", "-b", "main", origin]);
  for (const path of [mine, other]) {
    await exec(["git", "init", "-q", "-b", "main", path]);
    await git(path, "config", "user.name", "Test");
    await git(path, "config", "user.email", "test@example.invalid");
    await git(path, "remote", "add", "origin", origin);
  }
  await writeFile(join(other, "f.txt"), "one\n");
  await git(other, "add", "f.txt");
  await git(other, "commit", "-qm", "one");
  await git(other, "push", "-qu", "origin", "main");
  await git(mine, "pull", "-q", "origin", "main");
  await git(mine, "branch", "-q", "--set-upstream-to", "origin/main");
  await git(mine, "config", "pull.rebase", "true");
  return { root, mine, other, git };
}

describe("pull with pull.rebase set and an unstaged edit", () => {
  test("is already up to date when nothing is new", async () => {
    const { root, mine } = await fixture();
    try {
      await writeFile(join(mine, "f.txt"), "one\nedited\n");
      expect(await pull(mine)).toContain("Already up to date");
      expect(await readFile(join(mine, "f.txt"), "utf8")).toBe("one\nedited\n");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("fast-forwards past the edit when upstream leaves its file alone", async () => {
    const { root, mine, other, git } = await fixture();
    try {
      await writeFile(join(other, "theirs.txt"), "theirs\n");
      await git(other, "add", "theirs.txt");
      await git(other, "commit", "-qm", "theirs");
      await git(other, "push", "-q");
      await writeFile(join(mine, "f.txt"), "one\nedited\n");
      await pull(mine);
      expect(await git(mine, "log", "--format=%s")).toBe("theirs\none");
      expect(await readFile(join(mine, "f.txt"), "utf8")).toBe("one\nedited\n");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
