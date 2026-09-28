import { describe, expect, test } from "bun:test";
import { linkArchived } from "./archive";
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

describe("linkArchived", () => {
  test("sets the flag on the paths given and clears it elsewhere", () => {
    const repos = [repo("a"), repo("b", { archived: true }), repo("c")];
    const out = linkArchived(repos, new Set(["/dev/a"]));
    expect(out.map((r) => r.archived)).toEqual([true, undefined, undefined]);
    expect("archived" in out[1]!).toBe(false);
    expect(out[2]).toBe(repos[2]!);
  });

  test("hands back the same array when nothing moved", () => {
    const repos = [repo("a", { archived: true }), repo("b")];
    expect(linkArchived(repos, new Set(["/dev/a"]))).toBe(repos);
  });
});
