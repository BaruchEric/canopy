import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exec } from "./exec";
import { DropRefused, dropStaleCopies, push, StaleCopyError, staleCopies } from "./git";
import { newestStale } from "./stalecopy";

/** The atlas case (FR-048): a bare origin and two clones, `mac` and `gpd`.
 *  The Mac commits "fix nav", gpd takes it from the Mac as a peer would
 *  (fetched and fast-forwarded, never pushed), then the Mac amends it and
 *  pushes the amend. `amend` is f.txt as the amend leaves it. */
async function atlas(amend = "a\nb\nnew line\nanother\nc\n"): Promise<{
  root: string;
  mac: string;
  gpd: string;
  git: (path: string, ...args: string[]) => Promise<string>;
  commit: (path: string, file: string, body: string, message: string) => Promise<void>;
}> {
  const root = await mkdtemp(join(tmpdir(), "canopy-push-amend-"));
  const origin = join(root, "origin.git"), mac = join(root, "mac"), gpd = join(root, "gpd");
  const git = async (path: string, ...args: string[]) => {
    const r = await exec(["git", "-C", path, ...args]);
    if (r.code !== 0) throw new Error(r.stderr);
    return r.stdout.trim();
  };
  const commit = async (path: string, file: string, body: string, message: string) => {
    await writeFile(join(path, file), body);
    await git(path, "add", file);
    await git(path, "commit", "-qm", message);
  };
  await exec(["git", "init", "-q", "--bare", "-b", "main", origin]);
  for (const path of [mac, gpd]) {
    await exec(["git", "init", "-q", "-b", "main", path]);
    await git(path, "config", "user.name", "Test");
    await git(path, "config", "user.email", "test@example.invalid");
    await git(path, "config", "rerere.enabled", "false");
    await git(path, "remote", "add", "origin", origin);
  }
  await commit(mac, "f.txt", "a\nb\nc\n", "base");
  await git(mac, "push", "-qu", "origin", "main");
  await git(gpd, "pull", "-q", "origin", "main");
  await git(gpd, "branch", "-q", "--set-upstream-to", "origin/main");
  await writeFile(join(mac, "f.txt"), "a\nb\nnew line\nc\n");
  await git(mac, "commit", "-qam", "fix nav", "-m", "the body");
  await git(gpd, "fetch", "-q", mac, "main");
  await git(gpd, "merge", "-q", "--ff-only", "FETCH_HEAD");
  await writeFile(join(mac, "f.txt"), amend);
  await git(mac, "commit", "-qa", "--amend", "--no-edit");
  await git(mac, "push", "-q");
  return { root, mac, gpd, git, commit };
}

const refusal = (p: Promise<unknown>): Promise<unknown> => p.then(() => null, (err: unknown) => err);

describe("a push rejected over an upstream amend", () => {
  test("names the amend, leaves the branch, and dropping the stale copy keeps the work after it", async () => {
    const { root, mac, gpd, git, commit } = await atlas();
    try {
      await commit(gpd, "g.txt", "mine\n", "gpd work");
      const stale = await git(gpd, "rev-parse", "HEAD~1");
      const before = await git(gpd, "rev-parse", "HEAD");
      const amend = await git(mac, "rev-parse", "HEAD");
      const err = await refusal(push(gpd));
      expect(err).toBeInstanceOf(StaleCopyError);
      const offer = (err as StaleCopyError).offer;
      expect(offer).toEqual({ branch: "main", upstream: "origin/main", onto: amend, copies: [{ stale, copy: amend, subject: "fix nav" }], kept: 1 });
      expect((err as Error).message).toMatch(/\[rejected\].*(fetch first|non-fast-forward)/s);
      expect((err as Error).message).toContain("hit a conflict in f.txt");
      expect((err as Error).message).toContain(`Upstream holds an amended copy of ${stale.slice(0, 7)} fix nav (${amend.slice(0, 7)}`);
      expect(await git(gpd, "rev-parse", "HEAD")).toBe(before);
      expect(await git(gpd, "status", "--porcelain")).toBe("");

      const moved = await dropStaleCopies(gpd, { stale: newestStale(offer), onto: offer.onto });
      expect(moved.kept).toBe(1);
      expect(moved.out).toContain(`dropped ${stale.slice(0, 7)} fix nav: upstream holds its amend ${amend.slice(0, 7)}`);
      expect(await git(gpd, "log", "--format=%s", "HEAD")).toBe("gpd work\nfix nav\nbase");
      expect(await git(gpd, "rev-parse", "HEAD~1")).toBe(amend);
      expect(await readFile(join(gpd, "f.txt"), "utf8")).toBe("a\nb\nnew line\nanother\nc\n");
      await push(gpd);
      expect(await git(gpd, "rev-parse", "origin/main")).toBe(await git(gpd, "rev-parse", "HEAD"));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("with nothing after the stale copy, the branch lands on the amend", async () => {
    const { root, mac, gpd, git } = await atlas();
    try {
      const err = (await refusal(push(gpd))) as StaleCopyError;
      expect(err.offer.kept).toBe(0);
      const moved = await dropStaleCopies(gpd, { stale: newestStale(err.offer), onto: err.offer.onto });
      expect(moved.kept).toBe(0);
      expect(await git(gpd, "rev-parse", "HEAD")).toBe(await git(mac, "rev-parse", "HEAD"));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("an amend that rewrote the commit's own line is not a superset, so nothing is offered", async () => {
    const { root, gpd } = await atlas("a\nb\nnew line, reworded\nc\n");
    try {
      const err = await refusal(push(gpd));
      expect(err).toBeInstanceOf(Error);
      expect(err).not.toBeInstanceOf(StaleCopyError);
      expect((err as Error).message).toContain("hit a conflict in f.txt");
      expect((err as Error).message).toContain("leaves out lines");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("an amend the plain rebase gets past still pushes on its own", async () => {
    const { root, gpd, git, commit } = await atlas("a\nb\nnew line\nc\n\n\n\nfar below\n");
    try {
      await commit(gpd, "g.txt", "mine\n", "gpd work");
      const out = await push(gpd);
      expect(out).toContain("rebased onto the upstream first");
      expect(await git(gpd, "log", "--format=%s", "origin/main")).toBe("gpd work\nfix nav\nbase");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a conflict on a later commit of its own gets no offer", async () => {
    // the plain rebase drops the stale copy and stops on gpd's own commit
    const { root, gpd, commit } = await atlas("a\nb\nnew line\nc\n\n\n\nfar below\n");
    try {
      await commit(gpd, "f.txt", "a\nb\nnew line\nc\n\n\n\nmine below\n", "gpd work");
      const err = await refusal(push(gpd));
      expect(err).not.toBeInstanceOf(StaleCopyError);
      expect((err as Error).message).toContain("hit a conflict in f.txt");
      expect((err as Error).message).not.toContain("amended copy");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a stale copy above a commit upstream lacks is refused, with the reason", async () => {
    const { root, mac, gpd, git, commit } = await atlas();
    try {
      // gpd's own commit under its copy of fix nav: picked on top, message and author time kept
      const fixNav = await git(gpd, "rev-parse", "HEAD");
      await git(gpd, "reset", "-q", "--hard", "HEAD~1");
      await commit(gpd, "g.txt", "mine\n", "gpd work");
      await git(gpd, "cherry-pick", "--allow-empty", fixNav);
      // the facts are read against the upstream as last fetched
      await git(gpd, "fetch", "-q");
      const found = await staleCopies(gpd);
      expect(found?.verdict).toEqual({ kind: "refuse", why: expect.stringContaining("sits on 1 commit of your own") });
      await expect(dropStaleCopies(gpd, { stale: await git(gpd, "rev-parse", "HEAD"), onto: await git(mac, "rev-parse", "HEAD") })).rejects.toThrow(DropRefused);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a dirty tree, a branch that moved since, and a conflict while replaying each leave the branch as it was", async () => {
    const { root, mac, gpd, git, commit } = await atlas();
    try {
      // gpd's own edit of the line the amend added next to: replaying it onto the amend conflicts
      await commit(gpd, "f.txt", "a\nb\nnew line, edited here\nc\n", "gpd edit");
      const err = (await refusal(push(gpd))) as StaleCopyError;
      expect(err).toBeInstanceOf(StaleCopyError);
      const want = { stale: newestStale(err.offer), onto: err.offer.onto };
      const before = await git(gpd, "rev-parse", "HEAD");

      await writeFile(join(gpd, "f.txt"), "uncommitted\n");
      await expect(dropStaleCopies(gpd, want)).rejects.toThrow("uncommitted changes to f.txt");
      await git(gpd, "checkout", "--", "f.txt");

      await expect(dropStaleCopies(gpd, { ...want, onto: before })).rejects.toThrow("moved since canopy looked");

      const stopped = await refusal(dropStaleCopies(gpd, want));
      expect(stopped).toBeInstanceOf(DropRefused);
      expect((stopped as Error).message).toMatch(/hit a conflict in f\.txt \(replaying [0-9a-f]{7} gpd edit\)/);
      expect(await git(gpd, "rev-parse", "HEAD")).toBe(before);
      expect(await git(gpd, "status", "--porcelain")).toBe("");
      expect(await git(gpd, "rev-parse", "origin/main")).toBe(await git(mac, "rev-parse", "HEAD"));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
