import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
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
  readElsewhere,
  stageFile,
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
      // a stash
      await writeFile(join(main, "f.txt"), "two\n");
      await run("stash", "push", "-q", "-m", "parked");

      const e = await readElsewhere(main);
      expect(e?.worktrees.map((w) => ({ ...w, path: w.path.endsWith("/wt") }))).toEqual([
        { path: true, branch: "agent", files: 1, unmerged: 0 },
      ]);
      expect(e?.branches.map((b) => [b.name, b.unmerged, b.push.kind, b.subject])).toEqual([
        ["idea", 1, "local", "an idea"],
      ]);
      expect(e?.stash).toMatchObject({ count: 1, subject: "On main: parked" });
      // the linked worktree's own card does not repeat what the main one shows
      expect(await readElsewhere(wt)).toBeUndefined();

      // a worktree folder deleted without a prune: its branch's commits
      // still show, now as a branch
      await exec(["git", "-C", wt, "-c", "user.name=t", "-c", "user.email=t@t", "add", "new.txt"]);
      await exec(["git", "-C", wt, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "agent work"]);
      await rm(wt, { recursive: true, force: true });
      const after = await readElsewhere(main);
      expect(after?.worktrees).toEqual([]);
      expect(after?.branches.map((b) => [b.name, b.unmerged])).toContainEqual(["agent", 1]);
    } finally {
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
