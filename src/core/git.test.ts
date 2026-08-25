import { describe, expect, test } from "bun:test";
import {
  commitFiles,
  getDiff,
  isAccessDenied,
  isHash,
  parseNameStatusZ,
  parseNumstatZ,
  parsePorcelainV2,
  parseUserConfig,
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
