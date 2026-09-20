import { describe, expect, test } from "bun:test";
import type { Repo, RepoStatus } from "../../src/core/types";
import { changedAt, groupRepos, newestEdit } from "./grouping";

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
    user: null,
    ...status,
  };
  return error
    ? { id, name, path: `/x/${id}`, group, source: "launch", status: null, error }
    : { id, name, path: `/x/${id}`, group, source: "launch", status: st };
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

  test("activity groups by what needs a hand, newest change first inside each", () => {
    expect(ids(groupRepos(grove, "activity", NOW))).toEqual([
      ["needs attention", ["delta", "alpha"]],
      ["unpushed", ["beta"]],
      ["behind upstream", ["gamma"]],
      ["quiet", ["zeta", "fresh"]],
      ["unreadable", ["omega"]],
    ]);
  });

  test("recent buckets by commit age when nothing is edited, newest first, untouched last", () => {
    expect(ids(groupRepos(grove, "recent", NOW))).toEqual([
      ["today", ["zeta"]],
      ["this week", ["beta"]],
      ["this month", ["delta"]],
      ["this season", ["alpha"]],
      ["dormant", ["gamma"]],
      ["untouched", ["fresh", "omega"]],
    ]);
  });

  test("recent goes by the last commit or edit, whichever is newer", () => {
    const hour = 3600;
    const edited = (daysAgo: number, at: number) => ({ ...file, mtime: NOW - daysAgo * DAY + at });
    const grove = [
      // committed a month ago, edited an hour ago: today, ahead of a commit from this morning
      repo("web/alpha", "web", { files: [edited(0, -hour)], lastCommit: at(40) }),
      repo("web/zeta", "web", { lastCommit: at(0.5) }),
      // a stale edit does not pull a fresh commit back
      repo("tools/beta", "tools", { files: [edited(20, 0)], lastCommit: at(3) }),
      // an edit with no mtime (a remote stat that failed) counts for nothing
      repo("tools/delta", "tools", { files: [file], lastCommit: at(10) }),
      // no commit but an edit is still a change
      repo("web/fresh", "web", { files: [edited(2, 0)], lastCommit: null }),
      repo("tools/omega", "tools", null, "not a repo"),
    ];
    expect(ids(groupRepos(grove, "recent", NOW))).toEqual([
      ["today", ["alpha", "zeta"]],
      ["this week", ["fresh", "beta"]],
      ["this month", ["delta"]],
      ["untouched", ["omega"]],
    ]);
  });

  test("changedAt is the newer of commit and edit, newestEdit the file that set it", () => {
    const r = repo("web/x", "web", {
      files: [{ ...file, path: "old", mtime: NOW - 5 * DAY }, { ...file, path: "new", mtime: NOW - DAY }],
      lastCommit: at(3),
    });
    expect(newestEdit(r)).toEqual({ path: "new", at: NOW - DAY });
    expect(changedAt(r)).toBe(NOW - DAY);
    expect(changedAt(repo("web/y", "web", { files: [file], lastCommit: at(3) }))).toBe(NOW - 3 * DAY);
    expect(newestEdit(repo("web/z", "web", { lastCommit: at(3) }))).toBeNull();
  });

  test("name is one flat list", () => {
    expect(ids(groupRepos(grove, "name", NOW))).toEqual([
      ["a to z", ["alpha", "beta", "delta", "fresh", "gamma", "omega", "zeta"]],
    ]);
  });

  test("user buckets by identity, nobody and unreadable last", () => {
    const eric = { name: "Eric", email: "eric@example.com" };
    const work = { name: "Eric", email: "eric@work.example" };
    const bot = { name: "", email: "bot@example.com" };
    const who = [
      repo("a/one", "a", { user: eric }),
      repo("a/two", "a", { user: { ...eric, email: "ERIC@example.com" } }),
      repo("a/three", "a", { user: work }),
      repo("a/four", "a", { user: bot }),
      repo("a/five", "a", { user: null }),
      repo("a/six", "a", null, "not a repo"),
    ];
    const groups = groupRepos(who, "user", NOW);
    expect(ids(groups)).toEqual([
      ["bot@example.com", ["four"]],
      ["Eric <eric@example.com>", ["one", "two"]],
      ["Eric <eric@work.example>", ["three"]],
      ["no identity", ["five"]],
      ["unreadable", ["six"]],
    ]);
    expect(groups[1]?.hint).toBe("eric@example.com");
  });

  test("user keeps a plain name when nobody shares it", () => {
    const g = groupRepos(
      [repo("a/one", "a", { user: { name: "Eric", email: "eric@example.com" } })],
      "user",
      NOW,
    );
    expect(g.map((x) => x.label)).toEqual(["Eric"]);
  });

  test("empty input yields no groups in every mode", () => {
    for (const mode of ["recent", "folder", "activity", "name", "user"] as const) {
      expect(groupRepos([], mode, NOW)).toEqual([]);
    }
  });
});
