import { describe, expect, test } from "bun:test";
import { linkFavorites, linkHarness } from "./favorite";
import type { Repo } from "./types";

const repo = (id: string, extra: Partial<Repo> = {}): Repo => ({
  id,
  name: id,
  path: `/dev/${id}`,
  group: "",
  source: "root",
  status: null,
  ...extra,
});

describe("linkFavorites", () => {
  test("sets the star on the paths given and clears it elsewhere", () => {
    const repos = [repo("a"), repo("b", { favorite: true }), repo("c")];
    const out = linkFavorites(repos, new Set(["/dev/a"]));
    expect(out.map((r) => r.favorite)).toEqual([true, undefined, undefined]);
    expect("favorite" in out[1]!).toBe(false);
    expect(out[2]).toBe(repos[2]!);
  });

  test("hands back the same array when nothing moved", () => {
    const repos = [repo("a", { favorite: true }), repo("b")];
    expect(linkFavorites(repos, new Set(["/dev/a"]))).toBe(repos);
  });
});

describe("linkHarness", () => {
  test("sets the mark on the paths given and clears it elsewhere", () => {
    const repos = [repo("a"), repo("b", { harness: true }), repo("c")];
    const out = linkHarness(repos, new Set(["/dev/a"]));
    expect(out.map((r) => r.harness)).toEqual([true, undefined, undefined]);
    expect(Object.hasOwn(out[1] ?? {}, "harness")).toBe(false);
    expect(out[2]).toBe(repos[2]);
  });

  test("hands back the same array when nothing moved, and leaves the star alone", () => {
    const repos = [repo("a", { harness: true, favorite: true }), repo("b")];
    expect(linkHarness(repos, new Set(["/dev/a"]))).toBe(repos);
    expect(linkHarness(repos, new Set())[0]).toEqual(repo("a", { favorite: true }));
  });
});
