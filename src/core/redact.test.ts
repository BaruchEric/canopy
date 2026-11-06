import { describe, expect, test } from "bun:test";
import { redactArgv, redactLine, secretValues } from "./redact";

const token = `cnp_coordinator_${"a".repeat(43)}`;

describe("secretValues", () => {
  test("a switch that holds no secret is left out, even under a name that sounds like one", () => {
    expect(secretValues({ CANOPY_LOOPBACK_AUTH: "1", CANOPY_TOKEN: "t" })).toEqual([{ name: "CANOPY_TOKEN", value: "t" }]);
    // named by an applied file, it is that file's secret after all
    expect(secretValues({ CANOPY_LOOPBACK_AUTH: "1" }, { sink: { CANOPY_LOOPBACK_AUTH: "stamp" } })).toEqual([{ name: "CANOPY_LOOPBACK_AUTH", value: "1" }]);
  });

  test("the compose service's and the dev task's switches are left out, so no digit or mode word is redacted", () => {
    const env = { CANOPY_TMUX: "1", CANOPY_CALLERS: "enforce", CANOPY_AGENT_SCAN: "0", CANOPY_NO_DESKTOP: "1", CANOPY_INCUBATOR_AUTOSTART: "0", CANOPY_INCUBATOR_UNISOLATED: "1", CANOPY_PREVIEW_PORTS: "0", CANOPY_TOKEN: "t" };
    expect(secretValues(env)).toEqual([{ name: "CANOPY_TOKEN", value: "t" }]);
    expect(redactLine("reply 1 of 10, enforce 0", secretValues(env))).toEqual({ line: "reply 1 of 10, enforce 0", count: 0 });
  });

  test("the folders and sockets a backend runs from are left out, so a path that contains one stays whole", () => {
    const env = { CANOPY_CONFIG_DIR: "/config", CANOPY_HOST_HOME: "/home/eric", CANOPY_STAGE_SOCKET: "/run/canopy-stage/runner.sock", CANOPY_API: "http://127.0.0.1:7850/?t=x" };
    expect(secretValues(env)).toEqual([{ name: "CANOPY_API", value: "http://127.0.0.1:7850/?t=x" }]);
    expect(redactLine("edit src/config.ts in /home/eric/dev", secretValues(env))).toEqual({ line: "edit src/config.ts in /home/eric/dev", count: 0 });
  });

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

describe("whole caller-token protection on original input", () => {
  const unknown = `cnp_shell_${"b".repeat(43)}`;
  test("prefix and inner short secrets cannot expose the random suffix", () => {
    for (const value of ["c", "cnp_", "shell_", "b"]) {
      expect(redactLine(unknown, secretValues({ CANOPY_SHORT: value }))).toEqual({ line: "<redacted:token>", count: 1 });
    }
  });
  test("a preceding literal crossing into a token protects the entire token too", () => {
    expect(redactLine(`prefix${unknown}`, [{ name: "CROSS", value: "prefixcnp_" }])).toEqual({
      line: "<redacted:CROSS><redacted:token>", count: 2,
    });
  });
  test("exact known tokens and longer enclosing values keep their named marker", () => {
    const secrets = [{ name: "SHORT", value: "c" }, { name: "CANOPY_TOKEN", value: unknown }];
    expect(redactLine(unknown, secrets)).toEqual({ line: "<redacted:CANOPY_TOKEN>", count: 1 });
    expect(redactLine(`prefix${unknown}end`, [...secrets, { name: "LONG", value: `prefix${unknown}end` }])).toEqual({ line: "<redacted:LONG>", count: 1 });
  });
  test("argv protects prefix and crossing overlaps without corrupting generated markers", () => {
    const secrets = secretValues({ CANOPY_SHORT: "c", CANOPY_CROSS: "prefixcnp_" });
    expect(redactArgv([unknown, `prefix${unknown}`, "--mcp-config", unknown, `--mcp-config=${unknown}`], secrets)).toEqual([
      "<redacted:token>", "<redacted:CANOPY_CROSS><redacted:token>",
      "--m<redacted:CANOPY_SHORT>p-<redacted:CANOPY_SHORT>onfig", "<redacted:mcp-config>",
      "--m<redacted:CANOPY_SHORT>p-<redacted:CANOPY_SHORT>onfig=<redacted:mcp-config>",
    ]);
  });
});
