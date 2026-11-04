import { describe, expect, test } from "bun:test";
import { areKin, childRefusal, mcpConfigJson, RUN_CHILDREN, RUN_DEPTH } from "./runtools";

const run = (over: Partial<{ id: string; status: "working" | "done" | "idle"; depth: number; unattended: true }> = {}) => ({ id: "aaaa1111", status: "working" as const, ...over });

describe("childRefusal", () => {
  test("a run at depth 0 under the limit may start a child", () => {
    expect(RUN_CHILDREN).toBe(3);
    expect(RUN_DEPTH).toBe(2);
    expect(childRefusal(run(), 0)).toBeNull();
    expect(childRefusal(run({ status: "idle" }), 2)).toBeNull();
  });
  test("a gone or ended parent, an unattended one, a child and a full house each say why", () => {
    expect(childRefusal(undefined, 0)).toContain("gone");
    expect(childRefusal(run({ status: "done" }), 0)).toContain("has ended");
    expect(childRefusal(run({ unattended: true }), 0)).toContain("unattended");
    expect(childRefusal(run({ depth: 1 }), 0)).toContain("a child does not start children");
    expect(childRefusal(run(), RUN_CHILDREN)).toContain("3 children going");
  });
});

test("kin is a parent and its child, either way round, and nothing wider", () => {
  const parent = { id: "p" };
  const child = { id: "c", parent: "p" };
  const sibling = { id: "s", parent: "p" };
  expect(areKin(parent, child)).toBe(true);
  expect(areKin(child, parent)).toBe(true);
  expect(areKin(child, sibling)).toBe(false);
  expect(areKin(parent, { id: "x" })).toBe(false);
});

test("mcpConfigJson is the shape Claude's --mcp-config reads", () => {
  expect(JSON.parse(mcpConfigJson({ command: "/bin/bun", args: ["/c/bin/canopy-mcp.ts", "mcp"], env: { CANOPY_RUN: "r" } }))).toEqual({
    mcpServers: { canopy: { command: "/bin/bun", args: ["/c/bin/canopy-mcp.ts", "mcp"], env: { CANOPY_RUN: "r" } } },
  });
});
