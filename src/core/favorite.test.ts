import { describe, expect, test } from "bun:test";
import { linkFavorites } from "./favorite";
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
