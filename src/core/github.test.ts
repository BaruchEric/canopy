import { describe, expect, test } from "bun:test";
import { AUTHORED_QUERY, githubSlug, linkPulls, parseAuthoredPulls, parsePullCounts, pullsFor } from "./github";
import type { Repo } from "./types";

const page = (nodes: unknown[], hasNextPage = false) => ({
  data: { viewer: { repositories: { pageInfo: { hasNextPage, endCursor: null }, nodes } } },
});
const node = (nameWithOwner: string, open: number) => ({
  nameWithOwner,
  url: `https://github.com/${nameWithOwner}`,
  pullRequests: { totalCount: open },
});

describe("parsePullCounts", () => {
  test("pages from --slurp fold into one map keyed by the lowercased slug", () => {
    const counts = parsePullCounts([page([node("BaruchEric/homelab", 1)], true), page([node("Org/Thing", 0)])]);
    expect([...counts]).toEqual([
      ["barucheric/homelab", { open: 1, url: "https://github.com/BaruchEric/homelab/pulls" }],
      ["org/thing", { open: 0, url: "https://github.com/Org/Thing/pulls" }],
    ]);
  });
  test("an archived repo carries the flag; a live one does not", () => {
    const counts = parsePullCounts(page([{ ...node("a/old", 0), isArchived: true }, { ...node("a/live", 1), isArchived: false }]));
    expect(counts.get("a/old")).toEqual({ open: 0, url: "https://github.com/a/old/pulls", archived: true });
    expect(counts.get("a/live")).toEqual({ open: 1, url: "https://github.com/a/live/pulls" });
  });
  test("one page comes as one object; junk nodes and junk bodies are skipped", () => {
    expect(parsePullCounts(page([node("a/b", 2), null, { nameWithOwner: "x/y" }])).size).toBe(1);
    expect(parsePullCounts({ errors: [{ message: "bad" }] }).size).toBe(0);
    expect(parsePullCounts("nope").size).toBe(0);
  });
});

describe("githubSlug", () => {
  test("every remote shape, lowercased, off GitHub only", () => {
    expect(githubSlug("git@github.com:BaruchEric/Homelab.git")).toBe("barucheric/homelab");
    expect(githubSlug("https://github.com/BaruchEric/homelab")).toBe("barucheric/homelab");
    expect(githubSlug("ssh://git@192.168.1.76:2222/eric/DigitalMe.git")).toBeNull();
    expect(githubSlug("/Users/e/repo")).toBeNull();
  });
});

const repo = (id: string, remotes?: string[], over: Partial<Repo> = {}): Repo => ({
  id,
  name: id,
  path: `/r/${id}`,
  group: "",
  source: "launch",
  status: null,
  ...(remotes ? { remotes } : {}),
  ...over,
});

describe("pullsFor and linkPulls", () => {
  const counts = parsePullCounts(page([node("BaruchEric/homelab", 3), node("BaruchEric/canopy", 0)]));
  test("the first GitHub remote the query knew wins; forgejo-only and unknown repos get none", () => {
    expect(pullsFor(repo("h", ["ssh://git@192.168.1.76:2222/eric/homelab.git", "git@github.com:BaruchEric/homelab.git"]), counts)?.open).toBe(3);
    expect(pullsFor(repo("d", ["ssh://git@192.168.1.76:2222/eric/DigitalMe.git"]), counts)).toBeUndefined();
    expect(pullsFor(repo("p", ["https://github.com/PostHog/posthog"]), counts)).toBeUndefined();
    expect(pullsFor(repo("n"), counts)).toBeUndefined();
  });
  test("linkPulls keeps the object when the count is the same and drops a count the map lost", () => {
    const stale = repo("c", ["git@github.com:BaruchEric/canopy.git"], { pulls: { open: 5, url: "x" } });
    const same = repo("h", ["git@github.com:BaruchEric/homelab.git"], { pulls: { open: 3, url: "https://github.com/BaruchEric/homelab/pulls" } });
    const gone = repo("g", ["git@github.com:BaruchEric/gone.git"], { pulls: { open: 1, url: "y" } });
    const [c, h, g] = linkPulls([stale, same, gone], counts);
    expect(c?.pulls).toEqual({ open: 0, url: "https://github.com/BaruchEric/canopy/pulls" });
    expect(h).toBe(same);
    expect(g?.pulls).toBeUndefined();
    expect("pulls" in (g ?? {})).toBe(false);
  });
  test("a forge-only repo never carries a count, whatever its remotes say", () => {
    const f = repo("f", ["git@github.com:BaruchEric/homelab.git"], {
      forge: { kind: "forgejo", slug: "eric/homelab", clone: "", branch: "main", updated: 0, private: false, empty: false },
    });
    expect(linkPulls([f], counts)[0]?.pulls).toBeUndefined();
  });
});

describe("parseAuthoredPulls", () => {
  const authoredPage = (nodes: unknown[], hasNextPage = false) => ({
    data: { viewer: { pullRequests: { pageInfo: { hasNextPage, endCursor: hasNextPage ? "c1" : null }, nodes } } },
  });
  const pr = (nameWithOwner: string, number: number, over: Record<string, unknown> = {}) => ({
    number,
    url: `https://github.com/${nameWithOwner}/pull/${number}`,
    title: `PR ${number}`,
    isDraft: false,
    updatedAt: "2026-10-01T12:00:00Z",
    headRefName: `run/fix-${number}`,
    autoMergeRequest: null,
    mergeQueueEntry: null,
    repository: { nameWithOwner, isArchived: false },
    ...over,
  });

  test("parseAuthoredPulls reads two pages and skips malformed nodes", () => {
    const got = parseAuthoredPulls([
      authoredPage([pr("BaruchEric/Canopy", 7), null, { number: 8 }, pr("a/b", 9, { updatedAt: "not a date" })], true),
      authoredPage([
        pr("org/thing", 3, { isDraft: true, autoMergeRequest: { enabledAt: "2026-10-02T00:00:00Z" }, mergeQueueEntry: { id: "q" }, repository: { nameWithOwner: "Org/Thing", isArchived: true } }),
      ]),
    ]);
    expect(got).toEqual([
      {
        slug: "barucheric/canopy", number: 7, url: "https://github.com/BaruchEric/Canopy/pull/7", title: "PR 7", branch: "run/fix-7", draft: false,
        updatedAt: Date.parse("2026-10-01T12:00:00Z"), autoMerge: false, queued: false, archived: false,
      },
      {
        slug: "org/thing", number: 3, url: "https://github.com/org/thing/pull/3", title: "PR 3", branch: "run/fix-3", draft: true,
        updatedAt: Date.parse("2026-10-01T12:00:00Z"), autoMerge: true, queued: true, archived: true,
      },
    ]);
    // one page comes as one object; a body with no list is empty
    expect(parseAuthoredPulls(authoredPage([pr("a/b", 1)]))).toHaveLength(1);
    expect(parseAuthoredPulls({ errors: [{ message: "bad" }] })).toEqual([]);
    expect(parseAuthoredPulls("nope")).toEqual([]);
  });

  test("AUTHORED_QUERY pages the viewer's open PRs", () => {
    expect(AUTHORED_QUERY).toContain("pullRequests(states: OPEN, first: 100, after: $endCursor)");
    expect(AUTHORED_QUERY).toContain("pageInfo { hasNextPage endCursor }");
  });
});
