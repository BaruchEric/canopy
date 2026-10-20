import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exec } from "./exec";
import { isBehind, push } from "./git";

describe("isBehind", () => {
  test("a ref the remote rejected for having commits we lack", () => {
    expect(isBehind(" ! [rejected]        main -> main (fetch first)\nerror: failed to push some refs")).toBe(true);
    expect(isBehind(" ! [rejected]        main -> main (non-fast-forward)\nerror: failed to push some refs")).toBe(true);
  });
  test("a refusal, a hook or a stale lease is something else", () => {
    expect(isBehind("remote: Permission to a/b.git denied to c.")).toBe(false);
    expect(isBehind(" ! [remote rejected] main -> main (pre-receive hook declined)")).toBe(false);
    expect(isBehind(" ! [rejected]        main -> main (stale info)")).toBe(false);
  });
});

/** Two clones of one bare origin: `other` pushes first, `mine` is behind. */
async function fixture(): Promise<{
  root: string;
  mine: string;
  other: string;
  git: (path: string, ...args: string[]) => Promise<string>;
  commit: (path: string, file: string, body: string, message: string) => Promise<void>;
}> {
  const root = await mkdtemp(join(tmpdir(), "canopy-push-rebase-"));
  const origin = join(root, "origin.git"), mine = join(root, "mine"), other = join(root, "other");
  const git = async (path: string, ...args: string[]) => {
    const result = await exec(["git", "-C", path, ...args]);
    if (result.code !== 0) throw new Error(result.stderr);
    return result.stdout.trim();
  };
  const commit = async (path: string, file: string, body: string, message: string) => {
    await writeFile(join(path, file), body);
    await git(path, "add", file);
    await git(path, "commit", "-qm", message);
  };
  await exec(["git", "init", "-q", "--bare", "-b", "main", origin]);
  for (const path of [mine, other]) {
    await exec(["git", "init", "-q", "-b", "main", path]);
    await git(path, "config", "user.name", "Test");
    await git(path, "config", "user.email", "test@example.invalid");
    await git(path, "remote", "add", "origin", origin);
  }
  await commit(other, "f.txt", "one\n", "one");
  await git(other, "push", "-qu", "origin", "main");
  await git(mine, "pull", "-q", "origin", "main");
  await git(mine, "branch", "-q", "--set-upstream-to", "origin/main");
  return { root, mine, other, git, commit };
}

describe("push behind its upstream", () => {
  test("rebases its own commit onto the upstream and pushes", async () => {
    const { root, mine, other, git, commit } = await fixture();
    try {
      await commit(other, "theirs.txt", "theirs\n", "theirs");
      await git(other, "push", "-q");
      await commit(mine, "ours.txt", "ours\n", "ours");
      // an unstaged edit rides through the rebase on the autostash
      await writeFile(join(mine, "f.txt"), "one\nedited\n");
      expect(await push(mine)).toContain("rebased onto the upstream first");
      expect(await git(mine, "log", "--format=%s", "origin/main")).toBe("ours\ntheirs\none");
      expect(await readFile(join(mine, "f.txt"), "utf8")).toBe("one\nedited\n");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("drops a commit whose change is already upstream", async () => {
    const { root, mine, other, git, commit } = await fixture();
    try {
      await commit(other, "f.txt", "two\n", "bump from there");
      await git(other, "push", "-q");
      await commit(mine, "f.txt", "two\n", "bump from here");
      const out = await push(mine);
      expect(out).toMatch(/dropped [0-9a-f]{7} bump from here/);
      expect(await git(mine, "rev-parse", "HEAD")).toBe(await git(other, "rev-parse", "HEAD"));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a conflict puts the branch back and names the file", async () => {
    const { root, mine, other, git, commit } = await fixture();
    try {
      await commit(other, "f.txt", "theirs\n", "theirs");
      await git(other, "push", "-q");
      await commit(mine, "f.txt", "ours\n", "ours");
      const before = await git(mine, "rev-parse", "HEAD");
      await expect(push(mine)).rejects.toThrow("hit a conflict in f.txt");
      expect(await git(mine, "rev-parse", "HEAD")).toBe(before);
      expect(await git(mine, "status", "--porcelain")).toBe("");
      expect(await git(other, "rev-parse", "HEAD")).toBe(await git(mine, "rev-parse", "origin/main"));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("leaves a branch with its own merge commits alone", async () => {
    const { root, mine, other, git, commit } = await fixture();
    try {
      await commit(other, "theirs.txt", "theirs\n", "theirs");
      await git(other, "push", "-q");
      await git(mine, "checkout", "-qb", "side");
      await commit(mine, "side.txt", "side\n", "side");
      await git(mine, "checkout", "-q", "main");
      await commit(mine, "ours.txt", "ours\n", "ours");
      await git(mine, "merge", "-q", "--no-ff", "-m", "merge side", "side");
      const before = await git(mine, "rev-parse", "HEAD");
      await expect(push(mine)).rejects.toThrow("merge commits of its own");
      expect(await git(mine, "rev-parse", "HEAD")).toBe(before);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
