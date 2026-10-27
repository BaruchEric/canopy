import { describe, expect, test } from "bun:test";
import { redactArgv, redactLine, secretValues } from "./redact";

const token = `cnp_coordinator_${"a".repeat(43)}`;

describe("secretValues", () => {
  test("collects nonempty canopy, private and applied environment values in deterministic longest order", () => {
    const env = { CANOPY_B: "same", CANOPY_A: "same", CANOPY_SHORT: "x", CANOPY_EMPTY: "", CANOPY_UNSET: undefined, VERCEL_TOKEN: "private-secret", APPLIED: "applied-secret", OTHER: "public" };
    expect(secretValues(env, { sink: { APPLIED: "stamp", MISSING: "stamp" } })).toEqual([
      { name: "APPLIED", value: "applied-secret" }, { name: "VERCEL_TOKEN", value: "private-secret" },
      { name: "CANOPY_A", value: "same" }, { name: "CANOPY_B", value: "same" }, { name: "CANOPY_SHORT", value: "x" },
    ]);
    expect(secretValues({})).toEqual([]);
  });
});

describe("redactLine", () => {
  test("replaces every occurrence, preferring whole longest matches even for unsorted callers", () => {
    expect(redactLine("abc ab abc", [{ name: "SHORT", value: "ab" }, { name: "LONG", value: "abc" }])).toEqual({ line: "<redacted:LONG> <redacted:SHORT> <redacted:LONG>", count: 3 });
  });
  test("known tokens take their secret name and unknown caller kinds take token", () => {
    const other = `cnp_shell_${"b".repeat(43)}`;
    expect(redactLine(`${token} ${other}`, [{ name: "CANOPY_TOKEN", value: token }])).toEqual({ line: "<redacted:CANOPY_TOKEN> <redacted:token>", count: 2 });
  });
  test("one-character values and token-shaped names never rescan generated markers", () => {
    expect(redactLine("x abc", [{ name: "CANOPY_A", value: "x" }, { name: "CANOPY_B", value: "abc" }, { name: "LETTER", value: "a" }, { name: "EMPTY", value: "" }])).toEqual({ line: "<redacted:CANOPY_A> <redacted:CANOPY_B>", count: 2 });
    expect(redactLine("secret", [{ name: token, value: "secret" }])).toEqual({ line: `<redacted:${token}>`, count: 1 });
  });
  test("matches literal metacharacters and leaves unrelated input intact", () => {
    expect(redactLine('a.* a.*', [{ name: "LITERAL", value: "a.*" }])).toEqual({ line: "<redacted:LITERAL> <redacted:LITERAL>", count: 2 });
    expect(redactLine('{"type":"result"}', [])).toEqual({ line: '{"type":"result"}', count: 0 });
  });
});

test("redactArgv hides both mcp config forms without scanning their generated marker", () => {
  const argv = ["claude", "--mcp-config", "/private/file", "--mcp-config=/other/file", token, "--mcp-config"];
  expect(redactArgv(argv, [{ name: "LETTER", value: "r" }])).toEqual([
    "claude", "--mcp-config", "<redacted:mcp-config>", "--mcp-config=<redacted:mcp-config>", "<redacted:token>", "--mcp-config",
  ]);
  expect(argv[2]).toBe("/private/file");
});

test("mcp argv prefixes still redact original secrets while generated markers stay intact", () => {
  expect(redactArgv(["--mcp-config=/path", "--mcp-config", "/path"], [{ name: "FLAG", value: "mcp" }])).toEqual([
    "--<redacted:FLAG>-config=<redacted:mcp-config>", "--<redacted:FLAG>-config", "<redacted:mcp-config>",
  ]);
});
