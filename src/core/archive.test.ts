import { describe, expect, test } from "bun:test";
import { archivedBy, linkArchived } from "./archive";
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
    const repos = [repo("a"), repo("b", { archived: "canopy" }), repo("c")];
    const out = linkArchived(repos, new Set(["/dev/a"]));
    expect(out.map((r) => r.archived)).toEqual(["canopy", undefined, undefined]);
    expect("archived" in out[1]!).toBe(false);
    expect(out[2]).toBe(repos[2]!);
  });

  test("GitHub's flag archives a repo, and canopy's mark wins over it", () => {
    const gh = { open: 0, url: "u", archived: true as const };
    expect(archivedBy(repo("a", { pulls: gh }), new Set())).toBe("github");
    expect(archivedBy(repo("a", { pulls: gh }), new Set(["/dev/a"]))).toBe("canopy");
    expect(archivedBy(repo("a", { pulls: { open: 2, url: "u" } }), new Set())).toBeUndefined();
    const out = linkArchived([repo("a", { pulls: gh, archived: "canopy" })], new Set());
    expect(out[0]?.archived).toBe("github");
  });

  test("hands back the same array when nothing moved", () => {
    const repos = [repo("a", { archived: "canopy" }), repo("b")];
    expect(linkArchived(repos, new Set(["/dev/a"]))).toBe(repos);
  });
});
