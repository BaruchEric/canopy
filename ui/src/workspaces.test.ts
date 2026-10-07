import { describe, expect, test } from "bun:test";
import type { Repo, Workspace } from "../../src/core/types";
import { isPrimary, primaryRefusal, wsOf } from "./workspaces";

const a: Workspace = { name: "a", repos: ["/x", "/y"], primary: "/y", color: "sky" };
const b: Workspace = { name: "b", repos: ["/y"] };
const ws = [a, b];

describe("workspace helpers", () => {
  test("which workspaces hold a repo", () => {
    expect(wsOf(ws, "/y").map((w) => w.name)).toEqual(["a", "b"]);
    expect(wsOf(ws, "/z")).toEqual([]);
  });
  test("primary is the marked one, else the first member", () => {
    expect(isPrimary(a, "/y")).toBe(true);
    expect(isPrimary(a, "/x")).toBe(false);
    expect(isPrimary(b, "/y")).toBe(true);
  });
});

describe("which members can be a workspace's primary", () => {
  const repo = (over: Partial<Repo> = {}): Repo => ({ id: "alpha", name: "alpha", path: "/r/alpha", group: "", source: "launch", status: null, ...over });
  test("a plain local repo can", () => {
    expect(primaryRefusal(repo(), "/r/alpha")).toBeNull();
  });
  test("one missing from the tree, on another host, on the forge or a seed cannot, and says why", () => {
    expect(primaryRefusal(undefined, "/r/gone")).toBe("/r/gone is not in the tree");
    expect(primaryRefusal(repo({ host: "mini" }), "/r/alpha")).toBe("alpha is on mini; the primary has to be on this machine");
    expect(primaryRefusal(repo({ forge: { kind: "forgejo", slug: "eric/alpha", clone: "", branch: "main", updated: 0, private: false, empty: false } }), "/r/alpha")).toBe(
      "alpha is on the forge; the primary has to be a folder on this machine",
    );
    expect(primaryRefusal(repo({ id: "_incubator/sprig", name: "sprig" }), "/r/_incubator/sprig")).toBe("sprig is an incubator seed; its agents run through the incubator");
  });
});
