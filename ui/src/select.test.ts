import { describe, expect, test } from "bun:test";
import type { Repo, RepoStatus } from "../../src/core/types";
import {
  boardOrder,
  invertPick,
  PICK_FACETS,
  pickCount,
  pickState,
  pickWhere,
  rangeIds,
  setPick,
  togglePick,
} from "./select";

function repo(id: string, group: string, status: Partial<RepoStatus> | null, extra: Partial<Repo> = {}): Repo {
  const name = id.split("/").pop() ?? id;
  const st: RepoStatus | null = status && {
    branch: "main",
    upstream: "origin/main",
    ahead: 0,
    behind: 0,
    files: [],
    lastCommit: null,
    user: null,
    ...status,
  };
  return { id, name, path: `/x/${id}`, group, source: "launch", status: st, ...extra };
}

const file = { path: "a", index: ".", worktree: "M", untracked: false, conflicted: false };

describe("pickCount and pickState", () => {
  test("counts what is picked and names how much that is", () => {
    expect(pickCount(["a", "b"], ["a", "b", "c"])).toBe(2);
    expect(pickState([], ["a"])).toBe("none");
    expect(pickState(["a"], ["a", "b"])).toBe("some");
    expect(pickState(["a", "b", "z"], ["a", "b"])).toBe("all");
  });
  test("an empty set is none, not all", () => {
    expect(pickState(["a"], [])).toBe("none");
  });
});

describe("setPick and togglePick", () => {
  test("picking adds the missing ids after the ones already there", () => {
    expect(setPick(["b"], ["a", "b", "c"], true)).toEqual(["b", "a", "c"]);
  });
  test("unpicking drops only those ids", () => {
    expect(setPick(["a", "b", "z"], ["a", "b"], false)).toEqual(["z"]);
  });
  test("a group toggle fills the group until it is full, then clears it", () => {
    expect(togglePick(["z"], ["a", "b"])).toEqual(["z", "a", "b"]);
    expect(togglePick(["z", "a"], ["a", "b"])).toEqual(["z", "a", "b"]);
    expect(togglePick(["z", "a", "b"], ["a", "b"])).toEqual(["z"]);
  });
});

describe("invertPick", () => {
  test("flips every id in view and leaves the rest alone", () => {
    expect(invertPick(["a", "z"], ["a", "b", "c"])).toEqual(["z", "b", "c"]);
    expect(invertPick([], ["a"])).toEqual(["a"]);
    expect(invertPick(["a"], ["a"])).toEqual([]);
  });
});

describe("rangeIds", () => {
  const order = ["a", "b", "c", "d", "e"];
  test("runs from the anchor to the target inclusive, either way round", () => {
    expect(rangeIds(order, "b", "d")).toEqual(["b", "c", "d"]);
    expect(rangeIds(order, "d", "b")).toEqual(["b", "c", "d"]);
    expect(rangeIds(order, "c", "c")).toEqual(["c"]);
  });
  test("with no anchor on the board it is just the target", () => {
    expect(rangeIds(order, null, "c")).toEqual(["c"]);
    expect(rangeIds(order, "gone", "c")).toEqual(["c"]);
    expect(rangeIds(order, "a", "gone")).toEqual(["gone"]);
  });
});

describe("boardOrder", () => {
  test("follows the groups as the board lays them out and skips what cannot be picked", () => {
    const repos = [
      repo("web/one", "web", {}),
      repo("infra/two", "infra", {}),
      repo("web/three", "web", {}, { host: "box" }),
      repo("web/four", "web", null, { error: "nope" }),
      repo("infra/five", "infra", {}),
    ];
    expect(boardOrder(repos, "folder")).toEqual(["infra/five", "infra/two", "web/one"]);
  });
  test("a folded group is not on the board, so a range cannot cross into it", () => {
    const repos = [repo("a/one", "a", {}), repo("b/two", "b", {}), repo("c/three", "c", {})];
    expect(boardOrder(repos, "folder", ["folder:b"])).toEqual(["a/one", "c/three"]);
    expect(rangeIds(boardOrder(repos, "folder", ["folder:b"]), "a/one", "c/three")).toEqual(["a/one", "c/three"]);
  });
});

describe("pickWhere", () => {
  test("picks the repos in one state, never a remote or unreadable one", () => {
    const repos = [
      repo("a", "g", { files: [file] }),
      repo("b", "g", { ahead: 2 }),
      repo("c", "g", { files: [file] }, { host: "box" }),
      repo("d", "g", null, { error: "nope" }),
    ];
    expect(pickWhere(repos, "changes")).toEqual(["a"]);
    expect(pickWhere(repos, "unpushed")).toEqual(["b"]);
    expect(pickWhere(repos, "behind")).toEqual([]);
  });
  test("the bar never offers the unreadable facet", () => {
    expect(PICK_FACETS).not.toContain("unreadable");
    expect(PICK_FACETS.length).toBeGreaterThan(0);
  });
});
