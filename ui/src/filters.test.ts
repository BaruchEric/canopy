import { describe, expect, test } from "bun:test";
import type { Repo, RepoStatus } from "../../src/core/types";
import { applyQuery, countFacets, matchesFilter, NOBODY } from "./filters";

function repo(
  id: string,
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
    ? { id, name, path: `/x/${id}`, group: "g", status: null, error }
    : { id, name, path: `/x/${id}`, group: "g", status: st };
}

const file = { path: "a", index: ".", worktree: "M", untracked: false, conflicted: false };
const clash = { ...file, conflicted: true };
const eric = { name: "Eric", email: "eric@example.com" };
const work = { name: "Eric", email: "eric@work.example" };

const grove = [
  repo("g/dirty", { files: [file], user: eric }),
  repo("g/ahead", { ahead: 3, user: eric }),
  repo("g/behind", { behind: 2, user: work }),
  repo("g/clash", { files: [clash], user: eric }),
  repo("g/feature", { branch: "feat/x", user: work }),
  repo("g/detached", { branch: "(detached)", upstream: null, user: null }),
  repo("g/master", { branch: "master", user: eric }),
  repo("g/broken", null, "not a repo"),
];
const names = (list: Repo[]) => list.map((r) => r.name);
const none = { filters: [], users: [], attention: false, text: "" };

describe("matchesFilter", () => {
  test("each facet answers one question", () => {
    const pick = (f: Parameters<typeof matchesFilter>[1]) =>
      names(grove.filter((r) => matchesFilter(r, f)));
    expect(pick("changes")).toEqual(["dirty", "clash"]);
    expect(pick("unpushed")).toEqual(["ahead"]);
    expect(pick("behind")).toEqual(["behind"]);
    expect(pick("conflicts")).toEqual(["clash"]);
    expect(pick("off-main")).toEqual(["feature", "detached"]);
    expect(pick("no-upstream")).toEqual(["detached"]);
    expect(pick("unreadable")).toEqual(["broken"]);
  });
});

describe("applyQuery", () => {
  test("no query keeps everything", () => {
    expect(applyQuery(grove, none)).toHaveLength(grove.length);
  });

  test("status facets add up", () => {
    expect(names(applyQuery(grove, { ...none, filters: ["unpushed", "behind"] })))
      .toEqual(["ahead", "behind"]);
  });

  test("users add up too, and NOBODY picks repos with no identity", () => {
    expect(names(applyQuery(grove, { ...none, users: ["eric@work.example"] })))
      .toEqual(["behind", "feature"]);
    expect(names(applyQuery(grove, { ...none, users: [NOBODY] })))
      .toEqual(["detached", "broken"]);
  });

  test("dimensions narrow each other", () => {
    expect(
      names(
        applyQuery(grove, {
          filters: ["changes", "unpushed"],
          users: ["eric@example.com"],
          attention: true,
          text: "a",
        }),
      ),
    ).toEqual(["ahead", "clash"]);
  });

  test("text matches the id, not just the name, ignoring case", () => {
    expect(names(applyQuery(grove, { ...none, text: "G/DI" }))).toEqual(["dirty"]);
  });
});

describe("countFacets", () => {
  const facets = countFacets(grove);

  test("counts each facet across the whole scope", () => {
    expect(facets.filters).toEqual({
      changes: 2,
      unpushed: 1,
      behind: 1,
      conflicts: 1,
      "off-main": 2,
      "no-upstream": 1,
      unreadable: 1,
    });
  });

  test("lists identities busiest first, nobody last", () => {
    expect(facets.users.map((u) => [u.label, u.count])).toEqual([
      ["Eric <eric@example.com>", 4],
      ["Eric <eric@work.example>", 2],
      ["no identity", 2],
    ]);
    expect(facets.users[2]?.key).toBe(NOBODY);
  });

  test("a grove with identities everywhere has no nobody entry", () => {
    const all = countFacets([repo("g/a", { user: eric })]);
    expect(all.users.map((u) => u.label)).toEqual(["Eric"]);
  });
});
