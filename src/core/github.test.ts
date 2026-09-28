import { describe, expect, test } from "bun:test";
import { githubSlug, linkPulls, parsePullCounts, pullsFor } from "./github";
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
