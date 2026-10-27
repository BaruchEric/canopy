import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exec } from "./exec";
import {
  commitFiles,
  getDiff,
  getLog,
  clearStaleLock,
  getStatus,
  isAccessDenied,
  isLockedIndex,
  isNoLogin,
  isHash,
  parseLog,
  parseNameStatusZ,
  parseNumstatZ,
  parseMtimes,
  parsePorcelainV2,
  parseRemoteTip,
  parseBranchWip,
  parseStash,
  parseUserConfig,
  parseWorktreeList,
  NET_TIMEOUT_MS,
  netError,
  push,
  readElsewhere,
  elsewhereDetail,
  stageFile,
  sumNumstat,
} from "./git";
import { heuristicMessage } from "./suggest";
import type { RepoFile } from "./types";

const SAMPLE = [
  "# branch.oid 1234abcd",
  "# branch.head main",
  "# branch.upstream origin/main",
  "# branch.ab +2 -1",
  "1 .M N... 100644 100644 100644 aaaa bbbb src/app with spaces.ts",
  "1 A. N... 000000 100644 100644 0000 cccc new.ts",
  "2 R. N... 100644 100644 100644 dddd eeee R100 renamed.ts\told name.ts",
  "u UU N... 100644 100644 100644 100644 ffff gggg hhhh conflict.ts",
  "? untracked file.md",
].join("\n");

async function gitOk(cwd: string, ...args: string[]) {
  const result = await exec(["git", "-C", cwd, ...args]);
  if (result.code !== 0) throw new Error(result.stderr.trim() || `git ${args.join(" ")} failed`);
  return result;
}

async function makeDivergedPushFixture(root: string, options: { fork?: boolean } = {}) {
  const seed = join(root, "seed");
  const origin = join(root, "origin.git");
  const work = join(root, "work");
  const originWriter = join(root, "origin-writer");
  const fork = join(root, "fork.git");
  const forkWriter = join(root, "fork-writer");
  const commitFile = async (cwd: string, path: string, contents: string, message: string) => {
    await writeFile(join(cwd, path), contents);
    await gitOk(cwd, "add", "--", path);
    await gitOk(cwd, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", message);
  };

  await exec(["git", "init", "-q", "-b", "main", seed]);
  await writeFile(join(seed, "tracked.txt"), "alpha\nbeta\ngamma\n");
  await gitOk(seed, "add", "tracked.txt");
  await gitOk(seed, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "base");
  await exec(["git", "init", "-q", "--bare", "--initial-branch=main", origin]);
  await gitOk(seed, "remote", "add", "origin", origin);
  await gitOk(seed, "push", "-q", "-u", "origin", "main");
  if (options.fork) {
    await exec(["git", "init", "-q", "--bare", "--initial-branch=main", fork]);
    await gitOk(seed, "remote", "add", "fork", fork);
    await gitOk(seed, "push", "-q", "-u", "fork", "main");
  }

  await exec(["git", "clone", "-q", origin, work]);
  await gitOk(work, "config", "user.name", "t");
  await gitOk(work, "config", "user.email", "t@t");
  await exec(["git", "clone", "-q", origin, originWriter]);
  await commitFile(originWriter, "origin-only.txt", "origin\n", "origin change");
  await gitOk(originWriter, "push", "-q", "origin", "main");

  if (options.fork) {
    await gitOk(work, "remote", "add", "fork", fork);
    await gitOk(work, "fetch", "-q", "fork");
    await exec(["git", "clone", "-q", fork, forkWriter]);
    await commitFile(forkWriter, "fork-only.txt", "fork\n", "fork change");
    await gitOk(forkWriter, "push", "-q", "origin", "main");
  }

  await commitFile(work, "local-only.txt", "local\n", "local change");
  return { work, origin, fork };
}

describe("parseRemoteTip", () => {
  const line = (ref: string, symref = "") => [ref, "0e1d6fd", "1790000000", "tailcat: the pieces", symref].join("\0");
  test("the first real branch, newest first as git sorted them", () => {
    expect(parseRemoteTip([line("origin/claude/tailcat"), line("forgejo/main")].join("\n") + "\n")).toEqual({
      ref: "origin/claude/tailcat",
      hash: "0e1d6fd",
      subject: "tailcat: the pieces",
      at: 1790000000,
    });
  });
  test("a remote's HEAD symref is skipped for the branch under it", () => {
    expect(parseRemoteTip([line("origin/HEAD", "refs/remotes/origin/main"), line("origin/main")].join("\n"))?.ref).toBe("origin/main");
  });
  test("nothing unmerged is no tip", () => {
    expect(parseRemoteTip("")).toBeUndefined();
    expect(parseRemoteTip(line("origin/HEAD", "refs/remotes/origin/main"))).toBeUndefined();
  });
});

describe("parseUserConfig", () => {
  test("reads both keys and keeps spaces in the name", () => {
    expect(
      parseUserConfig("user.name Eric Baruch\nuser.email eric@example.com\n"),
    ).toEqual({ name: "Eric Baruch", email: "eric@example.com" });
  });

  test("the last value for a key wins, as it does for git", () => {
    expect(
      parseUserConfig(
        [
          "user.name Eric Baruch",
          "user.email eric@example.com",
          "user.email eric@work.example",
        ].join("\n"),
      ),
    ).toEqual({ name: "Eric Baruch", email: "eric@work.example" });
  });

  test("one key alone is still an identity; none is null", () => {
    expect(parseUserConfig("user.email eric@example.com")).toEqual({
      name: "",
      email: "eric@example.com",
    });
    expect(parseUserConfig("")).toBeNull();
    expect(parseUserConfig("user.signingkey ABC")).toBeNull();
  });
});

describe("parsePorcelainV2", () => {
  const st = parsePorcelainV2(SAMPLE);

  test("branch and ahead/behind", () => {
    expect(st.branch).toBe("main");
    expect(st.upstream).toBe("origin/main");
    expect(st.ahead).toBe(2);
    expect(st.behind).toBe(1);
  });

  test("ordinary entries keep spaces in paths", () => {
    expect(st.files[0]).toEqual({
      path: "src/app with spaces.ts",
      index: ".",
      worktree: "M",
      untracked: false,
      conflicted: false,
    });
    expect(st.files[1]?.index).toBe("A");
  });

  test("renames carry the original path", () => {
    const r = st.files[2];
    expect(r?.path).toBe("renamed.ts");
    expect(r?.orig).toBe("old name.ts");
  });

  test("conflicts and untracked are flagged", () => {
    expect(st.files[3]?.conflicted).toBe(true);
    expect(st.files[4]).toMatchObject({
      path: "untracked file.md",
      untracked: true,
    });
  });

  test("C-quoted paths are decoded back to real filenames", () => {
    const q = parsePorcelainV2(
      [
        '? "caf\\303\\251.txt"',
        '? "quo\\"te.txt"',
        '? "back\\\\slash.txt"',
        '2 R. N... 100644 100644 100644 dddd eeee R100 "n\\303\\251w.ts"\t"\\303\\266ld.ts"',
      ].join("\n"),
    );
    expect(q.files.map((f) => f.path)).toEqual([
      "café.txt",
      'quo"te.txt',
      "back\\slash.txt",
      "néw.ts",
    ]);
    expect(q.files[3]?.orig).toBe("öld.ts");
  });

  test("detached head and no upstream", () => {
    const d = parsePorcelainV2(
      "# branch.oid 999\n# branch.head (detached)\n",
    );
    expect(d.branch).toBe("(detached)");
    expect(d.upstream).toBeNull();
    expect(d.ahead).toBe(0);
    expect(d.files).toHaveLength(0);
  });
});

describe("getDiff path containment", () => {
  test("refuses paths that leave the repo", async () => {
    for (const bad of ["/etc/passwd", "../outside.txt", "a/../../outside"]) {
      await expect(
        getDiff("/tmp", bad, { kind: "untracked" }),
      ).rejects.toThrow();
    }
  });
});

describe("isHash", () => {
  test("accepts abbreviated and full hashes only", () => {
    expect(isHash("cb914ee")).toBe(true);
    expect(isHash("5a4a6c6fe2cc739eae26d55effca9d0581fdf5f6")).toBe(true);
    for (const bad of ["", "abc", "HEAD", "main", "--output=x", "cb914ee\n"]) {
      expect(isHash(bad)).toBe(false);
    }
  });
});

describe("commit file listings", () => {
  // Verbatim shapes from `git show --numstat -z` and `--name-status -z`
  // for a commit that renamed and edited one file and touched a binary.
  const NUMSTAT = "1\t0\t\0old.txt\0new name.txt\0-\t-\tpic.bin\0";
  const NAMES = "R075\0old.txt\0new name.txt\0M\0pic.bin\0";

  test("numstat reads counts, binary dashes and rename pairs", () => {
    expect(parseNumstatZ(NUMSTAT)).toEqual([
      { path: "new name.txt", orig: "old.txt", added: 1, deleted: 0 },
      { path: "pic.bin", added: null, deleted: null },
    ]);
  });

  test("name-status keeps the letter and drops the similarity score", () => {
    expect(parseNameStatusZ(NAMES)).toEqual([
      { status: "R", path: "new name.txt", orig: "old.txt" },
      { status: "M", path: "pic.bin" },
    ]);
  });

  test("the two listings join on the new path", () => {
    expect(commitFiles(parseNumstatZ(NUMSTAT), parseNameStatusZ(NAMES))).toEqual([
      { path: "new name.txt", orig: "old.txt", status: "R", added: 1, deleted: 0 },
      { path: "pic.bin", status: "M", added: null, deleted: null },
    ]);
  });

  test("empty output is an empty commit, not a phantom file", () => {
    expect(parseNumstatZ("")).toEqual([]);
    expect(parseNameStatusZ("")).toEqual([]);
  });

  test("a path only numstat knows keeps the count with status X", () => {
    expect(commitFiles(parseNumstatZ("2\t2\ta.ts\0"), [])).toEqual([
      { path: "a.ts", status: "X", added: 2, deleted: 2 },
    ]);
  });
});

describe("getDiff commit target", () => {
  test("refuses a hash that is not a hash", async () => {
    await expect(
      getDiff("/tmp", "a.ts", { kind: "commit", hash: "--output=/tmp/x" }),
    ).rejects.toThrow(/invalid commit hash/);
  });

  test("checks the rename source against the repo too", async () => {
    await expect(
      getDiff("/tmp", "a.ts", { kind: "commit", hash: "abcdef0", orig: "../b" }),
    ).rejects.toThrow(/escapes/);
  });
});

describe("isAccessDenied", () => {
  test("recognises a remote refusing us", () => {
    const denials = [
      // Verbatim from pushing a third-party clone over HTTPS.
      "remote: Permission to ag-ui-protocol/ag-ui.git denied to BaruchEric.\n" +
        "fatal: unable to access 'https://github.com/ag-ui-protocol/ag-ui/': " +
        "The requested URL returned error: 403",
      "ERROR: Permission to BuilderIO/agent-native.git denied to BaruchEric.",
      "fatal: Authentication failed for 'https://github.com/x/y.git/'",
      "remote: Repository not found.",
    ];
    for (const d of denials) expect(isAccessDenied(d)).toBe(true);
  });

  test("does not mistake a rejected ref for a refused remote", () => {
    // Falling back to another remote on these would push a stale or
    // unrelated branch somewhere it was never meant to go.
    const rejections = [
      " ! [rejected]        main -> main (non-fast-forward)\n" +
        "error: failed to push some refs to 'origin'",
      "error: remote unpack failed: unable to create temporary object directory\n" +
        " ! [remote rejected] HEAD -> master (unpacker error)",
      "fatal: The current branch main has no upstream branch.",
      "1403 files changed, 403 insertions(+)",
    ];
    for (const r of rejections) expect(isAccessDenied(r)).toBe(false);
  });
});

describe("heuristicMessage", () => {
  const file = (path: string, untracked = false): RepoFile => ({
    path,
    index: ".",
    worktree: untracked ? "." : "M",
    untracked,
    conflicted: false,
  });

  test("groups by top-level area", () => {
    const msg = heuristicMessage([
      file("ui/a.tsx"),
      file("ui/b.tsx"),
      file("src/core/git.ts"),
    ]);
    expect(msg).toBe("update ui (2), src (1)");
  });

  test("all-untracked reads as add", () => {
    expect(heuristicMessage([file("README.md", true)])).toBe("add root (1)");
  });

  test("empty change set", () => {
    expect(heuristicMessage([])).toBe("update");
  });
});

describe("parseMtimes", () => {
  test("one entry per path, a blank line for a missing file", () => {
    expect(parseMtimes("1700000000\n\n1700000001\n", 3)).toEqual([
      1700000000,
      undefined,
      1700000001,
    ]);
  });
  test("short or garbled output never lengthens the list", () => {
    expect(parseMtimes("stat: illegal option\n", 2)).toEqual([
      undefined,
      undefined,
    ]);
    expect(parseMtimes("", 0)).toEqual([]);
  });
});

describe("stale index locks", () => {
  test("a refusal over the lock reads in two lines; a timeout and a plain failure as they are", () => {
    const git = "error: Unable to create '/r/.git/index.lock': File exists.\n\nAnother git process seems to be running in this repository, e.g.\nan editor opened by 'git commit'. Please make sure all processes\nare terminated then try again. If it still fails, a git process\nmay have crashed in this repository earlier:\nremove the file manually to continue.";
    expect(netError(git, "pull", 1000).message).toBe(
      "error: Unable to create '/r/.git/index.lock': File exists.\nAnother git process may be running, or one that died left this lock behind; canopy clears one over 10 minutes old.",
    );
    expect(netError("From origin\n * main", "pull", NET_TIMEOUT_MS).message).toEndWith(`git pull ran past ${NET_TIMEOUT_MS / 60_000} minutes and was stopped.`);
    expect(netError("", "push", 10).message).toBe("git push failed");
  });

  test("git's lock refusal reads as one", () => {
    expect(isLockedIndex("fatal: Unable to create '/r/.git/index.lock': File exists.\n\nAnother git process seems to be running")).toBe(true);
    expect(isLockedIndex("fatal: not a git repository")).toBe(false);
  });

  test("an old lock goes, a fresh one stays, and no lock says so", async () => {
    const dir = await mkdtemp(join(tmpdir(), "canopy-stale-"));
    try {
      await exec(["git", "-C", dir, "init", "-q"]);
      const lock = join(dir, ".git", "index.lock");
      await writeFile(lock, "");
      await expect(clearStaleLock(dir)).rejects.toThrow(/minutes old/);
      const old = new Date(Date.now() - 60 * 60_000);
      await utimes(lock, old, old);
      expect(await clearStaleLock(dir)).toBe(lock);
      expect(await Bun.file(lock).exists()).toBe(false);
      await expect(clearStaleLock(dir)).rejects.toThrow(/no index.lock/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("an old lock a live git still holds stays: a commit waiting on its editor", async () => {
    const dir = await mkdtemp(join(tmpdir(), "canopy-stale-live-"));
    const who = ["-c", "user.name=t", "-c", "user.email=t@t"];
    let commit: ReturnType<typeof Bun.spawn> | null = null;
    try {
      await exec(["git", "-C", dir, "init", "-q"]);
      await writeFile(join(dir, "f.txt"), "one\n");
      await exec(["git", "-C", dir, "add", "f.txt"]);
      await exec(["git", "-C", dir, ...who, "commit", "-q", "-m", "one"]);
      await writeFile(join(dir, "f.txt"), "two\n");
      // commit -a holds the lock for as long as its editor stays open
      commit = Bun.spawn(["git", "-C", dir, ...who, "commit", "-a"], { env: { ...process.env, GIT_EDITOR: "sleep 8;:" }, stdout: "ignore", stderr: "ignore" });
      const lock = join(dir, ".git", "index.lock");
      for (let i = 0; i < 100 && !(await Bun.file(lock).exists()); i++) await Bun.sleep(50);
      const old = new Date(Date.now() - 60 * 60_000);
      await utimes(lock, old, old);
      await expect(clearStaleLock(dir)).rejects.toThrow(/git is still running/);
      expect(await Bun.file(lock).exists()).toBe(true);
    } finally {
      commit?.kill();
      await commit?.exited;
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("line counts", () => {
  test("a numstat's lines in all, a binary file counting as none", () => {
    expect(sumNumstat(parseNumstatZ("3\t1\ta.ts\0-\t-\tlogo.png\0" + "2\t0\t\0old.ts\0new.ts\0"))).toEqual({ added: 5, deleted: 1 });
    expect(sumNumstat([])).toEqual({ added: 0, deleted: 0 });
  });

  test("a status counts tracked changes against HEAD, staged and not, and leaves them out on a clean tree", async () => {
    const dir = await mkdtemp(join(tmpdir(), "canopy-lines-"));
    try {
      const run = (...args: string[]) => exec(["git", "-C", dir, "-c", "user.name=t", "-c", "user.email=t@t", ...args]);
      await run("init", "-q");
      await writeFile(join(dir, "f.txt"), "one\ntwo\n");
      await run("add", "f.txt");
      await run("commit", "-q", "-m", "one");
      expect((await getStatus(dir, { tipRemotes: [] })).lines).toBeUndefined();
      await writeFile(join(dir, "f.txt"), "one\nthree\nfour\n");
      await run("add", "f.txt");
      await writeFile(join(dir, "f.txt"), "one\nthree\nfour\nfive\n");
      // an untracked file is in the files, not the lines
      await writeFile(join(dir, "new.txt"), "a\nb\n");
      const st = await getStatus(dir, { tipRemotes: [] });
      expect(st.files).toHaveLength(2);
      expect(st.lines).toEqual({ added: 3, deleted: 1 });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("getStatus in the background", () => {
  test("leaves the index alone, so it never holds index.lock against the user", async () => {
    const dir = await mkdtemp(join(tmpdir(), "canopy-locks-"));
    try {
      const run = (...args: string[]) => exec(["git", "-C", dir, ...args]);
      await run("init", "-q");
      await writeFile(join(dir, "f.txt"), "one\n");
      await run("add", "f.txt");
      await run("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "one");
      // the same content with a new mtime: a status that may write refreshes
      // the index's stat data and writes it back
      const later = new Date(Date.now() + 60_000);
      await utimes(join(dir, "f.txt"), later, later);
      const before = await readFile(join(dir, ".git", "index"));
      const status = await getStatus(dir, { tipRemotes: [] });
      expect(status.files).toEqual([]);
      expect(Buffer.compare(await readFile(join(dir, ".git", "index")), before)).toBe(0);
      // the control: plain git status does write it, so the check above can fail
      await run("status", "--porcelain");
      expect(Buffer.compare(await readFile(join(dir, ".git", "index")), before)).not.toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("parseWorktreeList", () => {
  test("reads branch, detached, bare and prunable records in order", () => {
    const text = [
      "worktree /r",
      "HEAD aaaa",
      "branch refs/heads/main",
      "",
      "worktree /r/.claude/worktrees/a",
      "HEAD bbbb",
      "branch refs/heads/feat/x",
      "locked",
      "",
      "worktree /tmp/gone",
      "HEAD cccc",
      "detached",
      "prunable gitdir file points to non-existent location",
      "",
    ].join("\n");
    expect(parseWorktreeList(text)).toEqual([
      { path: "/r", branch: "main", bare: false, prunable: false },
      { path: "/r/.claude/worktrees/a", branch: "feat/x", bare: false, prunable: false },
      { path: "/tmp/gone", branch: null, bare: false, prunable: true },
    ]);
  });
});

describe("parseBranchWip", () => {
  const line = (...f: string[]) => f.join("\0");
  test("reads the push state and the count ahead of HEAD", () => {
    const text = [
      line("local", "", "", "200", "only here", "", "3 0"),
      line("pushed", "origin/pushed", "", "150", "even", "", "1 4"),
      line("ahead", "origin/ahead", "ahead 2, behind 1", "120", "two more", "/r/wt", "5 1"),
      line("gone", "origin/gone", "gone", "100", "deleted there", "", "1 0"),
    ].join("\n");
    expect(parseBranchWip(text)).toEqual([
      { name: "local", push: { kind: "local" }, at: 200, subject: "only here", worktree: "", unmerged: 3 },
      { name: "pushed", push: { kind: "upstream", ref: "origin/pushed", unpushed: 0 }, at: 150, subject: "even", worktree: "", unmerged: 1 },
      { name: "ahead", push: { kind: "upstream", ref: "origin/ahead", unpushed: 2 }, at: 120, subject: "two more", worktree: "/r/wt", unmerged: 5 },
      { name: "gone", push: { kind: "gone", ref: "origin/gone" }, at: 100, subject: "deleted there", worktree: "", unmerged: 1 },
    ]);
  });

  test("leaves the count out when an older git could not give it", () => {
    expect(parseBranchWip(line("b", "", "", "1", "s", "") + "\n")).toEqual([
      { name: "b", push: { kind: "local" }, at: 1, subject: "s", worktree: "" },
    ]);
  });
});

describe("parseStash", () => {
  test("counts entries and keeps the newest", () => {
    expect(parseStash("300\0WIP on main: abc one\n200\0On main: two\n")).toEqual({
      count: 2,
      subject: "WIP on main: abc one",
      at: 300,
    });
    expect(parseStash("")).toBeUndefined();
  });
});

describe("readElsewhere", () => {
  test("timestamps detached worktrees from changed files, including nested untracked names, and falls back for deletions", async () => {
    const dir = await mkdtemp(join(tmpdir(), "canopy-worktree-time-"));
    const main = join(dir, "main");
    const wt = join(dir, "wt");
    try {
      const run = (...args: string[]) => exec(["git", "-C", main, "-c", "user.name=t", "-c", "user.email=t@t", ...args]);
      await exec(["git", "init", "-q", "-b", "main", main]);
      await writeFile(join(main, "f.txt"), "one\n");
      await writeFile(join(main, ".gitignore"), "ignored\n");
      await run("add", ".");
      await run("commit", "-q", "-m", "one");
      const log = await run("log", "-1", "--format=%ct");
      const committedAt = Number(log.stdout.trim());
      await run("worktree", "add", "-q", "--detach", wt);
      const worktreePath = await realpath(wt);
      await writeFile(join(wt, "f.txt"), "changed\n");
      await utimes(join(wt, "f.txt"), committedAt + 60, committedAt + 60);
      await mkdir(join(wt, "new folder"));
      const untracked = join(wt, "new folder", 'a "quoted" file.txt');
      await writeFile(untracked, "new\n");
      await utimes(untracked, committedAt + 120, committedAt + 120);
      await utimes(join(wt, "new folder"), committedAt - 60, committedAt - 60);
      await writeFile(join(wt, "ignored"), "ignored\n");
      await utimes(join(wt, "ignored"), committedAt + 180, committedAt + 180);

      expect((await readElsewhere(main))?.worktrees).toEqual([
        { path: worktreePath, branch: null, files: 2, unmerged: 0, at: committedAt + 120 },
      ]);
      await rm(untracked);
      expect((await readElsewhere(main))?.worktrees[0]?.at).toBe(committedAt + 60);
      await rm(join(wt, "f.txt"));
      expect((await readElsewhere(main))?.worktrees).toEqual([
        { path: worktreePath, branch: null, files: 1, unmerged: 0, at: committedAt },
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("finds a dirty worktree, an unmerged branch and the stash from the main checkout only", async () => {
    const dir = await mkdtemp(join(tmpdir(), "canopy-elsewhere-"));
    const main = join(dir, "main");
    const wt = join(dir, "wt");
    try {
      const run = (...args: string[]) =>
        exec(["git", "-C", main, "-c", "user.name=t", "-c", "user.email=t@t", ...args]);
      await exec(["git", "init", "-q", "-b", "main", main]);
      await writeFile(join(main, "f.txt"), "one\n");
      await run("add", "f.txt");
      await run("commit", "-q", "-m", "one");
      expect(await readElsewhere(main)).toBeUndefined();

      // a branch checked out nowhere, one commit past main
      await run("checkout", "-q", "-b", "idea");
      await writeFile(join(main, "g.txt"), "idea\n");
      await run("add", "g.txt");
      await run("commit", "-q", "-m", "an idea");
      await run("checkout", "-q", "main");
      // a linked worktree with an untracked file
      await run("worktree", "add", "-q", "-b", "agent", wt);
      await writeFile(join(wt, "new.txt"), "wip\n");
      const editedAt = 2_000_000_000;
      await utimes(join(wt, "new.txt"), editedAt, editedAt);
      // a stash
      await writeFile(join(main, "f.txt"), "two\n");
      await run("stash", "push", "-q", "-m", "parked");

      const e = await readElsewhere(main);
      expect(e?.worktrees.map((w) => ({ ...w, path: w.path.endsWith("/wt") }))).toEqual([
        { path: true, branch: "agent", files: 1, unmerged: 0, at: editedAt },
      ]);
      expect(e?.branches.map((b) => [b.name, b.unmerged, b.push.kind, b.subject])).toEqual([
        ["idea", 1, "local", "an idea"],
      ]);
      expect(e?.stash).toMatchObject({ count: 1, subject: "On main: parked" });
      // the drill: a branch's commits HEAD lacks, a worktree's entries
      const idea = await elsewhereDetail(main, { branch: "idea" });
      expect(idea.commits.map((c) => c.subject)).toEqual(["an idea"]);
      expect(idea).toMatchObject({ more: 0, files: [] });
      const agent = await elsewhereDetail(main, { branch: "agent", worktree: e?.worktrees[0]?.path ?? "" });
      expect(agent.commits).toEqual([]);
      expect(agent.files.map((f) => [f.path, f.untracked])).toEqual([["new.txt", true]]);
      // the linked worktree's own card does not repeat what the main one shows
      expect(await readElsewhere(wt)).toBeUndefined();

      // a worktree folder deleted without a prune: its branch's commits
      // still show, now as a branch
      await exec(["git", "-C", wt, "-c", "user.name=t", "-c", "user.email=t@t", "add", "new.txt"]);
      await exec(["git", "-C", wt, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "agent work"]);
      const committed = await exec(["git", "-C", wt, "log", "-1", "--format=%ct"]);
      expect((await readElsewhere(main))?.worktrees[0]).toMatchObject({ files: 0, unmerged: 1, at: Number(committed.stdout.trim()) });
      await rm(wt, { recursive: true, force: true });
      const after = await readElsewhere(main);
      expect(after?.worktrees).toEqual([]);
      expect(after?.branches.map((b) => [b.name, b.unmerged])).toContainEqual(["agent", 1]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a branch run's worktree and branch are the landing section's, not the card's", async () => {
    const dir = await mkdtemp(join(tmpdir(), "canopy-elsewhere-run-"));
    const prev = process.env["CANOPY_CONFIG_DIR"];
    process.env["CANOPY_CONFIG_DIR"] = join(dir, "config");
    const main = join(dir, "main");
    const wt = join(dir, "config", "worktrees", "main-1234abcd", "ab12cd34");
    try {
      const run = (cwd: string, ...args: string[]) => exec(["git", "-C", cwd, "-c", "user.name=t", "-c", "user.email=t@t", ...args]);
      await exec(["git", "init", "-q", "-b", "main", main]);
      await writeFile(join(main, "f.txt"), "one\n");
      await run(main, "add", "f.txt");
      await run(main, "commit", "-q", "-m", "one");
      await run(main, "worktree", "add", "-q", "-b", "run/x-ab12cd34", wt);
      await writeFile(join(wt, "g.txt"), "run\n");
      await run(wt, "add", "g.txt");
      await run(wt, "commit", "-q", "-m", "run work");
      await writeFile(join(wt, "h.txt"), "more\n");
      expect(await readElsewhere(main)).toBeUndefined();
    } finally {
      if (prev === undefined) delete process.env["CANOPY_CONFIG_DIR"];
      else process.env["CANOPY_CONFIG_DIR"] = prev;
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("stageFile", () => {
  test("a rename goes on or off the index as both of its paths", async () => {
    const dir = await mkdtemp(join(tmpdir(), "canopy-rename-"));
    try {
      const run = (...args: string[]) => exec(["git", "-C", dir, ...args]);
      await run("init", "-q");
      await writeFile(join(dir, "old.txt"), "hello\nworld\n");
      await run("add", "old.txt");
      await run("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "one");
      await run("mv", "old.txt", "new.txt");
      const row = (await getStatus(dir, { tipRemotes: [] })).files;
      expect(row.map((f) => [f.index, f.path, f.orig])).toEqual([["R", "new.txt", "old.txt"]]);
      // unticking the one row takes the whole rename off: nothing is left
      // staged, where unstaging the new path alone kept "D old.txt" staged
      await stageFile(dir, "new.txt", true, "old.txt");
      expect((await run("diff", "--cached", "--name-status")).stdout).toBe("");
      // and ticking it again puts the rename back
      await stageFile(dir, "new.txt", false, "old.txt");
      const again = (await getStatus(dir, { tipRemotes: [] })).files;
      expect(again.map((f) => [f.index, f.worktree, f.path, f.orig])).toEqual([["R", ".", "new.txt", "old.txt"]]);
      await expect(stageFile(dir, "new.txt", true, "../outside.txt")).rejects.toThrow("escapes");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("parseLog", () => {
  test("flags a row by its full hash and keeps the short one", () => {
    const line = (h: string, full: string) => [h, "subject: with, words", "t", "2 hours ago", full].join("\0");
    expect(parseLog(`${line("aaaaaaa", "a".repeat(40))}\n${line("bbbbbbb", "b".repeat(40))}\n`, new Set(["a".repeat(40)]))).toEqual([
      { hash: "aaaaaaa", subject: "subject: with, words", author: "t", when: "2 hours ago", unpushed: true },
      { hash: "bbbbbbb", subject: "subject: with, words", author: "t", when: "2 hours ago" },
    ]);
    expect(parseLog("", new Set())).toEqual([]);
  });
});

describe("getLog unpushed", () => {
  test("past the upstream, past every remote without one, nothing without a remote", async () => {
    const root = await mkdtemp(join(tmpdir(), "canopy-unpushed-"));
    const dir = join(root, "work");
    const bare = join(root, "origin.git");
    try {
      const run = (...args: string[]) => exec(["git", "-C", dir, ...args]);
      const commit = async (m: string) => {
        await writeFile(join(dir, "f.txt"), `${m}\n`);
        await run("add", "f.txt");
        await run("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", m);
      };
      await exec(["git", "init", "-q", dir]);
      await commit("one");
      const flags = async () => (await getLog(dir)).map((c) => [c.subject, !!c.unpushed]);
      // no remote: nowhere to push, so nothing is marked
      expect(await flags()).toEqual([["one", false]]);
      await exec(["git", "init", "-q", "--bare", bare]);
      await run("remote", "add", "origin", bare);
      // a remote but no upstream: every commit no remote branch has
      expect(await flags()).toEqual([["one", true]]);
      await run("push", "-q", "-u", "origin", "HEAD");
      await commit("two");
      await commit("three");
      expect(await flags()).toEqual([["three", true], ["two", true], ["one", false]]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("push before any remote", () => {
  test("says what is wrong with the folder, the HEAD or the repo", async () => {
    const root = await mkdtemp(join(tmpdir(), "canopy-push-"));
    const dir = join(root, "work");
    try {
      const run = (...args: string[]) => exec(["git", "-C", dir, ...args]);
      const refusal = (path: string) => push(path).then(() => "", (e: unknown) => (e as Error).message);
      // a folder that is not there, then one that is not a repo, keep git's words
      expect(await refusal(join(root, "missing"))).toContain("cannot change to");
      await exec(["mkdir", dir]);
      expect(await refusal(dir)).toContain("not a git repository");
      // a repo with no commits is on a branch, just one with nothing on it
      await exec(["git", "init", "-q", dir]);
      expect(await refusal(dir)).toBe("no remote configured");
      await writeFile(join(dir, "f.txt"), "one\n");
      await run("add", "f.txt");
      await run("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "one");
      await run("checkout", "-q", "--detach");
      expect(await refusal(dir)).toBe("detached HEAD — check out a branch first");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("automatic rebase after a rejected push", () => {
  test("still rebases and pushes when the destination is the tracked upstream", async () => {
    const root = await mkdtemp(join(tmpdir(), "canopy-push-upstream-"));
    try {
      const { work } = await makeDivergedPushFixture(root);
      const output = await push(work);

      expect(output).toContain("rebased onto the upstream first");
      expect((await gitOk(work, "rev-parse", "HEAD")).stdout.trim()).toBe(
        (await gitOk(work, "rev-parse", "refs/remotes/origin/main")).stdout.trim(),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("refuses before fetching when staged and unstaged changes are mixed", async () => {
    const root = await mkdtemp(join(tmpdir(), "canopy-push-staged-"));
    try {
      const { work } = await makeDivergedPushFixture(root);
      await writeFile(join(work, "tracked.txt"), "alpha\nstaged\nbeta\ngamma\n");
      await gitOk(work, "add", "tracked.txt");
      await writeFile(join(work, "tracked.txt"), "alpha\nstaged\nbeta\nunstaged\ngamma\n");

      const beforeHead = (await gitOk(work, "rev-parse", "HEAD")).stdout.trim();
      const beforeUpstream = (await gitOk(work, "rev-parse", "refs/remotes/origin/main")).stdout.trim();
      const beforeCached = (await gitOk(work, "diff", "--cached", "--", "tracked.txt")).stdout;
      const beforeWorktree = (await gitOk(work, "diff", "--", "tracked.txt")).stdout;
      const beforeIndex = await readFile(join(work, ".git", "index"));
      const message = await push(work).then(
        () => "",
        (error: unknown) => error instanceof Error ? error.message : String(error),
      );

      expect(message).toMatch(/\[rejected\].*(fetch first|non-fast-forward)/s);
      expect(message).toContain("The index has staged changes, so canopy left the rebase to you.");
      expect((await gitOk(work, "rev-parse", "HEAD")).stdout.trim()).toBe(beforeHead);
      expect((await gitOk(work, "rev-parse", "refs/remotes/origin/main")).stdout.trim()).toBe(beforeUpstream);
      expect(Buffer.compare(await readFile(join(work, ".git", "index")), beforeIndex)).toBe(0);
      expect((await gitOk(work, "diff", "--cached", "--", "tracked.txt")).stdout).toBe(beforeCached);
      expect((await gitOk(work, "diff", "--", "tracked.txt")).stdout).toBe(beforeWorktree);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  for (const setting of ["branch.main.pushRemote", "remote.pushDefault"]) {
    test(`does not rebase when ${setting} sends the bare push away from the upstream`, async () => {
      const root = await mkdtemp(join(tmpdir(), "canopy-push-override-"));
      try {
        const { work } = await makeDivergedPushFixture(root, { fork: true });
        await gitOk(work, "config", setting, "fork");

        const beforeHead = (await gitOk(work, "rev-parse", "HEAD")).stdout.trim();
        const beforeUpstream = (await gitOk(work, "rev-parse", "refs/remotes/origin/main")).stdout.trim();
        const beforeFork = (await gitOk(work, "rev-parse", "refs/remotes/fork/main")).stdout.trim();
        const message = await push(work).then(
          () => "",
          (error: unknown) => error instanceof Error ? error.message : String(error),
        );

        expect(message).toMatch(/\[rejected\].*(fetch first|non-fast-forward)/s);
        expect((await gitOk(work, "rev-parse", "HEAD")).stdout.trim()).toBe(beforeHead);
        expect((await gitOk(work, "rev-parse", "refs/remotes/origin/main")).stdout.trim()).toBe(beforeUpstream);
        expect((await gitOk(work, "rev-parse", "refs/remotes/fork/main")).stdout.trim()).toBe(beforeFork);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  }

  for (const destination of ["different push URL", "multiple URLs"]) {
    test(`does not rebase an upstream remote with ${destination}`, async () => {
      const root = await mkdtemp(join(tmpdir(), "canopy-push-url-"));
      try {
        const { work, fork } = await makeDivergedPushFixture(root, { fork: true });
        if (destination === "different push URL") await gitOk(work, "config", "remote.origin.pushurl", fork);
        else await gitOk(work, "config", "--add", "remote.origin.url", fork);
        const beforeHead = (await gitOk(work, "rev-parse", "HEAD")).stdout.trim();
        const beforeUpstream = (await gitOk(work, "rev-parse", "refs/remotes/origin/main")).stdout.trim();
        await expect(push(work)).rejects.toThrow(/\[rejected\].*(fetch first|non-fast-forward)/s);
        expect((await gitOk(work, "rev-parse", "HEAD")).stdout.trim()).toBe(beforeHead);
        expect((await gitOk(work, "rev-parse", "refs/remotes/origin/main")).stdout.trim()).toBe(beforeUpstream);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  }

  test("does not rebase a matching-mode push that can reject other branches", async () => {
    const root = await mkdtemp(join(tmpdir(), "canopy-push-matching-"));
    try {
      const { work } = await makeDivergedPushFixture(root);
      await gitOk(work, "config", "push.default", "matching");
      const beforeHead = (await gitOk(work, "rev-parse", "HEAD")).stdout.trim();
      const beforeUpstream = (await gitOk(work, "rev-parse", "refs/remotes/origin/main")).stdout.trim();
      const message = await push(work).then(
        () => "",
        (error: unknown) => error instanceof Error ? error.message : String(error),
      );

      expect(message).toMatch(/\[rejected\].*(fetch first|non-fast-forward)/s);
      expect((await gitOk(work, "rev-parse", "HEAD")).stdout.trim()).toBe(beforeHead);
      expect((await gitOk(work, "rev-parse", "refs/remotes/origin/main")).stdout.trim()).toBe(beforeUpstream);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("does not rebase a push controlled by a configured refspec", async () => {
    const root = await mkdtemp(join(tmpdir(), "canopy-push-refspec-"));
    try {
      const { work } = await makeDivergedPushFixture(root);
      await gitOk(work, "checkout", "-q", "-b", "side");
      await gitOk(work, "config", "remote.origin.push", "refs/heads/side:refs/heads/main");
      await gitOk(work, "checkout", "-q", "main");
      const beforeHead = (await gitOk(work, "rev-parse", "HEAD")).stdout.trim();
      const beforeUpstream = (await gitOk(work, "rev-parse", "refs/remotes/origin/main")).stdout.trim();
      const message = await push(work).then(
        () => "",
        (error: unknown) => error instanceof Error ? error.message : String(error),
      );

      expect(message).toMatch(/\[rejected\].*(fetch first|non-fast-forward)/s);
      expect((await gitOk(work, "rev-parse", "HEAD")).stdout.trim()).toBe(beforeHead);
      expect((await gitOk(work, "rev-parse", "refs/remotes/origin/main")).stdout.trim()).toBe(beforeUpstream);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("isNoLogin", () => {
  test("git asking for a login it has no terminal for", () => {
    expect(isNoLogin("fatal: could not read Username for 'https://github.com': terminal prompts disabled")).toBe(true);
    expect(isNoLogin("fatal: could not read Password for 'https://x@github.com': No such device or address")).toBe(true);
  });
  test("a refusal or a rejected ref is something else", () => {
    expect(isNoLogin("remote: Permission to a/b.git denied to c.")).toBe(false);
    expect(isNoLogin("! [rejected] main -> main (fetch first)")).toBe(false);
  });
});
