import { describe, expect, test } from "bun:test";
import type { BranchWip, Elsewhere, RepoStatus, WorktreeWip } from "../../src/core/types";
import { changesHead, elsewhereChips, elsewhereLines } from "./elsewhere";

const wt = (path: string, files: number, unmerged = 0, branch: string | null = "agent"): WorktreeWip => ({
  path,
  branch,
  files,
  unmerged,
});
const br = (name: string, unmerged: number, at = 100): BranchWip => ({
  name,
  unmerged,
  push: { kind: "local" },
  at,
  subject: `on ${name}`,
});

describe("elsewhereChips", () => {
  test("nothing when there is nothing elsewhere", () => {
    expect(elsewhereChips(undefined, "main")).toEqual([]);
  });

  test("names a single worktree and branch, counts several", () => {
    const one: Elsewhere = { worktrees: [wt("/r/.claude/worktrees/a1", 3)], branches: [br("idea", 2)] };
    expect(elsewhereChips(one, "main").map((c) => c.text)).toEqual(["⧉ agent", "⑂ idea +2"]);
    const many: Elsewhere = {
      worktrees: [wt("/r/a", 1), wt("/r/b", 0, 2, null)],
      branches: [br("x", 1), br("y", 1)],
      stash: { count: 2, subject: "On main: parked", at: 100 },
    };
    const chips = elsewhereChips(many, "main");
    expect(chips.map((c) => c.text)).toEqual(["⧉ 2 worktrees", "⑂ 2 branches", "≡ 2 stashed"]);
    expect(chips[0]?.title).toBe("agent at /r/a: 1 change\ndetached at /r/b: 2 commits not on main");
  });

  test("a detached single worktree goes by its folder name", () => {
    expect(elsewhereChips({ worktrees: [wt("/r/wt/x9", 1, 0, null)], branches: [] }, "main")[0]?.text).toBe("⧉ x9");
  });
});

describe("elsewhereLines", () => {
  test("reports a worktree's tree, a new commit, a branch and the stash", () => {
    const before: Elsewhere = { worktrees: [wt("/r/a", 1)], branches: [br("x", 1, 100)] };
    const after: Elsewhere = {
      worktrees: [wt("/r/a", 2, 1)],
      branches: [br("x", 2, 200), br("y", 1)],
      stash: { count: 1, subject: "On main: parked", at: 300 },
    };
    expect(elsewhereLines(before, after)).toEqual([
      "worktree agent: 2 changes",
      "worktree agent: committed, 1 unmerged",
      "branch x moved: on x",
      "branch y: on y",
      "stashed: On main: parked",
    ]);
    expect(elsewhereLines(after, after)).toEqual([]);
    expect(elsewhereLines(after, { ...after, stash: undefined })).toEqual(["stash empty"]);
  });
});

describe("changesHead", () => {
  const status = (over: Partial<RepoStatus> = {}): RepoStatus => ({
    branch: "main",
    upstream: "origin/main",
    ahead: 0,
    behind: 0,
    files: [],
    lastCommit: null,
    user: null,
    ...over,
  });
  const file = { path: "a.ts", index: ".", worktree: "M", untracked: false, conflicted: false };
  const words = (st: RepoStatus | undefined, peers: { text: string; title: string }[] = []) => changesHead(st, peers).map((p) => p.text);

  test("a clean tree is its count alone", () => {
    expect(words(status())).toEqual(["0"]);
    expect(words(undefined)).toEqual(["0"]);
  });

  test("lines, upstream, peers, then the card's chips, in that order", () => {
    const st = status({
      files: [file, { ...file, path: "b.ts" }],
      lines: { added: 12, deleted: 3 },
      ahead: 2,
      behind: 1,
      elsewhere: { worktrees: [wt("/r/.claude/worktrees/x", 2)], branches: [br("idea", 1)], stash: { count: 1, subject: "s", at: 1 } },
    });
    expect(words(st, [{ text: "mini 4", title: "" }])).toEqual(["2", "+12", "−3", "↑2 not pushed", "↓1 behind", "mini 4", "⧉ agent", "⑂ idea +1", "≡ 1 stashed"]);
    const parts = changesHead(st, []);
    expect(parts[1]?.cls).toBe("n-add");
    expect(parts[2]?.cls).toBe("n-del");
    expect(parts.map((p) => p.cls).slice(3)).toEqual(["head-ahead", "head-behind", "elsewhere-worktree", "elsewhere-branch", "elsewhere-stash"]);
  });

  test("a side with no lines, or a backend that sends none, says nothing of them", () => {
    expect(words(status({ files: [file], lines: { added: 0, deleted: 5 } }))).toEqual(["1", "−5"]);
    expect(words(status({ files: [file] }))).toEqual(["1"]);
  });
});
