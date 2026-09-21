import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exec } from "./exec";
import { fetchRepo, getStatus, remoteRefs } from "./git";

/** A bare remote, a clone canopy would watch, and a second clone standing
 *  in for the other machine (or the cloud agent) that pushes to it. */
let root = "";
let here = "";
let elsewhere = "";

const sh = async (cwd: string, ...args: string[]): Promise<void> => {
  const r = await exec(["git", ...args], { cwd });
  if (r.code !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
};
const identity = async (cwd: string): Promise<void> => {
  await sh(cwd, "config", "user.email", "t@t");
  await sh(cwd, "config", "user.name", "t");
};
/** Commits land seconds apart in real life; here they would all share one
 *  second and tie on the committer date the tip is sorted by, so each one
 *  is stamped a minute after the last. */
let clock = 1_790_000_000;
const commitFile = async (cwd: string, name: string, msg: string): Promise<void> => {
  await writeFile(join(cwd, name), `${msg}\n`);
  await sh(cwd, "add", name);
  clock += 60;
  const r = await exec(["git", "commit", "-q", "-m", msg], {
    cwd,
    env: { GIT_AUTHOR_DATE: `${clock} +0000`, GIT_COMMITTER_DATE: `${clock} +0000` },
  });
  if (r.code !== 0) throw new Error(`git commit: ${r.stderr}`);
};

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "canopy-fetch-"));
  const bare = join(root, "remote.git");
  await exec(["git", "init", "-q", "--bare", "-b", "main", bare]);
  elsewhere = join(root, "elsewhere");
  await exec(["git", "clone", "-q", bare, elsewhere]);
  await identity(elsewhere);
  await commitFile(elsewhere, "a.txt", "first");
  await sh(elsewhere, "push", "-q", "-u", "origin", "main");
  here = join(root, "here");
  await exec(["git", "clone", "-q", bare, here]);
  await identity(here);
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("fetchRepo and the remote tip", () => {
  test("a clone in step with its remote has no tip and nothing to fetch", async () => {
    expect((await getStatus(here)).tip).toBeUndefined();
    expect(await fetchRepo(here)).toEqual({ changed: false });
  });

  test("a branch pushed from elsewhere becomes the tip once fetched", async () => {
    await sh(elsewhere, "checkout", "-q", "-b", "claude/tailcat");
    await commitFile(elsewhere, "b.txt", "tailcat");
    await sh(elsewhere, "push", "-q", "-u", "origin", "claude/tailcat");

    // nothing moves until the fetch: the checkout's status is only as fresh
    // as its remote-tracking refs
    expect((await getStatus(here)).tip).toBeUndefined();
    const before = await remoteRefs(here);
    expect(await fetchRepo(here)).toEqual({ changed: true });
    expect(await remoteRefs(here)).not.toBe(before);

    const st = await getStatus(here);
    expect(st.tip).toMatchObject({ ref: "origin/claude/tailcat", subject: "tailcat" });
    expect(st.tip?.at).toBeGreaterThan(0);
    expect(st.behind).toBe(0);
  });

  test("a commit on the tracked branch shows as behind, and the newest unmerged ref is the tip", async () => {
    await sh(elsewhere, "checkout", "-q", "main");
    await commitFile(elsewhere, "c.txt", "later on main");
    await sh(elsewhere, "push", "-q", "origin", "main");
    expect((await fetchRepo(here)).changed).toBe(true);
    const st = await getStatus(here);
    expect(st.behind).toBe(1);
    // origin/main is newer than the branch now, and not in the checkout either
    expect(st.tip?.ref).toBe("origin/main");
    expect(st.tip?.subject).toBe("later on main");
  });

  test("merging the remote tip clears it, pruning a deleted branch is a change", async () => {
    await sh(here, "merge", "-q", "--ff-only", "origin/main");
    expect((await getStatus(here)).tip?.ref).toBe("origin/claude/tailcat");
    await sh(elsewhere, "push", "-q", "origin", "--delete", "claude/tailcat");
    expect((await fetchRepo(here)).changed).toBe(true);
    expect((await getStatus(here)).tip).toBeUndefined();
  });

  test("only the remotes named are fetched, and only they can supply the tip", async () => {
    // a second remote standing in for a fork's upstream, with a branch of its own
    const upstream = join(root, "upstream.git");
    await exec(["git", "init", "-q", "--bare", "-b", "main", upstream]);
    const theirs = join(root, "theirs");
    await exec(["git", "clone", "-q", upstream, theirs]);
    await identity(theirs);
    await commitFile(theirs, "u.txt", "their work");
    await sh(theirs, "push", "-q", "-u", "origin", "main");
    await sh(here, "remote", "add", "upstream", upstream);

    expect(await fetchRepo(here, ["origin"])).toEqual({ changed: false });
    expect(await remoteRefs(here)).not.toContain("refs/remotes/upstream/");
    expect((await fetchRepo(here, ["upstream"])).changed).toBe(true);
    expect((await getStatus(here)).tip?.ref).toBe("upstream/main");
    expect((await getStatus(here, { tipRemotes: ["origin"] })).tip).toBeUndefined();
    expect((await getStatus(here, { tipRemotes: [] })).tip).toBeUndefined();
    expect(await fetchRepo(here, [])).toEqual({ changed: false });
    await sh(here, "remote", "remove", "upstream");
  });

  test("a remote that will not answer fails without a prompt and reports it", async () => {
    await sh(here, "remote", "add", "dead", "https://127.0.0.1:1/nobody/nothing.git");
    const r = await fetchRepo(here);
    expect(r.error).toBeTruthy();
    expect(r.changed).toBe(false);
  }, 20_000);
});
