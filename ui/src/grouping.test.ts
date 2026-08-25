import { describe, expect, test } from "bun:test";
import type { Repo, RepoStatus } from "../../src/core/types";
import { groupRepos } from "./grouping";

const NOW = 1_800_000_000;
const DAY = 86_400;

function repo(
  id: string,
  group: string,
  status: Partial<RepoStatus> | null,
  error?: string,
): Repo {
  const name = id.split("/").pop() ?? id;
  const st: RepoStatus | null = status && {
    branch: "main",
    upstream: "origin/main",
    ahead: 0,
    behind: 0,
    files: [],
    lastCommit: null,
    ...status,
  };
  return error
    ? { id, name, path: `/x/${id}`, group, status: null, error }
    : { id, name, path: `/x/${id}`, group, status: st };
}

const file = { path: "a", index: ".", worktree: "M", untracked: false, conflicted: false };
const at = (daysAgo: number) => ({ hash: "h", subject: "s", at: NOW - daysAgo * DAY });

const grove = [
  repo("web/zeta", "web", { lastCommit: at(0.5) }),
  repo("web/alpha", "web", { files: [file, file], lastCommit: at(40) }),
  repo("tools/beta", "tools", { ahead: 2, lastCommit: at(3) }),
  repo("tools/gamma", "tools", { behind: 5, lastCommit: at(200) }),
  repo("tools/delta", "tools", { files: [file], lastCommit: at(10) }),
  repo("tools/omega", "tools", null, "not a repo"),
  repo("web/fresh", "web", { lastCommit: null }),
];

const ids = (groups: ReturnType<typeof groupRepos>) =>
  groups.map((g) => [g.label, g.repos.map((r) => r.name)] as const);

describe("groupRepos", () => {
  test("folder keeps the topic layout, names sorted inside", () => {
    expect(ids(groupRepos(grove, "folder", NOW))).toEqual([
      ["tools", ["beta", "delta", "gamma", "omega"]],
      ["web", ["alpha", "fresh", "zeta"]],
    ]);
  });

  test("folder labels the scan root itself as .", () => {
    const g = groupRepos([repo(".", "", { lastCommit: at(1) })], "folder", NOW);
    expect(g.map((x) => x.label)).toEqual(["."]);
  });

  test("activity puts the busiest repos first and unreadable ones last", () => {
    expect(ids(groupRepos(grove, "activity", NOW))).toEqual([
      ["needs attention", ["alpha", "delta"]],
      ["unpushed", ["beta"]],
      ["behind upstream", ["gamma"]],
      ["quiet", ["zeta", "fresh"]],
      ["unreadable", ["omega"]],
    ]);
  });

  test("recent buckets by commit age, newest first, no commit at the end", () => {
    expect(ids(groupRepos(grove, "recent", NOW))).toEqual([
      ["today", ["zeta"]],
      ["this week", ["beta"]],
      ["this month", ["delta"]],
      ["this season", ["alpha"]],
      ["dormant", ["gamma"]],
      ["no commits", ["fresh", "omega"]],
    ]);
  });

  test("name is one flat list", () => {
    expect(ids(groupRepos(grove, "name", NOW))).toEqual([
      ["a to z", ["alpha", "beta", "delta", "fresh", "gamma", "omega", "zeta"]],
    ]);
  });

  test("empty input yields no groups in every mode", () => {
    for (const mode of ["folder", "activity", "recent", "name"] as const) {
      expect(groupRepos([], mode, NOW)).toEqual([]);
    }
  });
});
