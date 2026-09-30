import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exec } from "./exec";
import { push } from "./git";
import { NO_PUSH } from "./peers";

for (const tracked of ["origin", "mini"]) {
  test(`push skips fetch-only peers when ${tracked} is tracked`, async () => {
    const root = await mkdtemp(join(tmpdir(), "canopy-push-fallback-"));
    const repo = join(root, "repo"), origin = join(root, "origin"), fork = join(root, "fork");
    const git = async (path: string, ...args: string[]) => {
      const result = await exec(["git", "-C", path, ...args]);
      if (result.code !== 0) throw new Error(result.stderr);
      return result.stdout.trim();
    };
    try {
      for (const path of [repo, origin, fork]) {
        const result = await exec(["git", "init", "-q", "-b", "main", ...(path === repo ? [] : ["--bare"]), path]);
        expect(result.code).toBe(0);
      }
      await git(repo, "-c", "user.email=test@example.invalid", "-c", "user.name=Test", "commit", "-qm", "fixture", "--allow-empty");
      await git(repo, "remote", "add", "origin", origin);
      await git(repo, "push", "-qu", "origin", "main");
      const deny = join(root, "deny");
      await writeFile(deny, '#!/bin/sh\necho "Permission denied" >&2\nexit 1\n', { mode: 0o700 });
      await git(repo, "config", "remote.origin.receivepack", deny);
      await git(repo, "remote", "add", "mini", origin);
      await git(repo, "config", "remote.mini.pushurl", NO_PUSH);
      await git(repo, "remote", "add", "zfork", fork);
      await git(repo, "config", "branch.main.remote", tracked);
      expect(await push(repo)).toContain("pushed to zfork");
      expect(await git(fork, "rev-parse", "main")).toBe(await git(repo, "rev-parse", "HEAD"));
      expect(await git(repo, "config", "branch.main.remote")).toBe(tracked);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}

test("push behind a tracked peer goes where pushDefault says, and a peer alone is not a target", async () => {
  const root = await mkdtemp(join(tmpdir(), "canopy-push-default-"));
  const repo = join(root, "repo"), origin = join(root, "origin"), fork = join(root, "fork");
  const git = async (path: string, ...args: string[]) => {
    const result = await exec(["git", "-C", path, ...args]);
    if (result.code !== 0) throw new Error(result.stderr);
    return result.stdout.trim();
  };
  try {
    for (const path of [repo, origin, fork]) {
      const result = await exec(["git", "init", "-q", "-b", "main", ...(path === repo ? [] : ["--bare"]), path]);
      expect(result.code).toBe(0);
    }
    await git(repo, "-c", "user.email=test@example.invalid", "-c", "user.name=Test", "commit", "-qm", "fixture", "--allow-empty");
    await git(repo, "remote", "add", "mini", origin);
    await git(repo, "config", "remote.mini.pushurl", NO_PUSH);
    await git(repo, "config", "branch.main.remote", "mini");
    await expect(push(repo)).rejects.toThrow("peer remotes are fetch-only");
    await git(repo, "remote", "add", "origin", origin);
    await git(repo, "remote", "add", "zfork", fork);
    await git(repo, "config", "remote.pushDefault", "zfork");
    expect(await push(repo)).toContain("pushed to zfork");
    expect(await git(fork, "rev-parse", "main")).toBe(await git(repo, "rev-parse", "HEAD"));
    expect((await exec(["git", "-C", origin, "rev-parse", "--verify", "-q", "main"])).code).not.toBe(0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
