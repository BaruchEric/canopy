import { describe, expect, test } from "bun:test";
import type { Workspace } from "../../src/core/types";
import { isPrimary, wsOf } from "./workspaces";

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
