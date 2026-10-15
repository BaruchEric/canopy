import { describe, expect, test } from "bun:test";
import { AGE_HEAD, emptyFile, fileProblems, type SecretFile } from "./secretfile";
import { mcpAllowFile, mcpRevokeFile, type McpAllowance } from "./secretmcp";

const R = "age1xtc4cftnu55fn3enurt9jexnrenmru3w0xl93uz5q20e34mefs6stg2vra";
const SEALED = `${AGE_HEAD}\nnot really sealed\n-----END AGE ENCRYPTED FILE-----\n`;
const STAMP = "2026-10-14T12:00:00.000Z";
const H1 = "1".repeat(64);
const H2 = "2".repeat(64);

function base(): SecretFile {
  const f = emptyFile({ mini: R, mac: R, breakglass: R });
  const e = { description: "", tags: [], created: STAMP, rotated: STAMP, to: ["breakglass", "mini"], value: SEALED };
  f.secrets["gh_token"] = { ...e, allow: [] };
  f.secrets["hook_key"] = { ...e, allow: [] };
  f.secrets["cf_token"] = { ...e, allow: ["sink:dns"] };
  f.sinks["dns"] = { machine: "mini", path: "/opt/stacks/dns/.env", format: "dotenv", keys: { CF_TOKEN: "cf_token" } };
  return f;
}
const github = (over: Partial<McpAllowance> = {}): McpAllowance => ({
  server: "github", hash: H1, env: { GITHUB_PERSONAL_ACCESS_TOKEN: "gh_token" }, headers: {}, homes: { mac: "/Users/e", mini: "/home/eric" }, ...over,
});
const file = (r: { file: SecretFile } | { error: string }): SecretFile => {
  if ("error" in r) throw new Error(r.error);
  return r.file;
};

describe("mcpAllowFile", () => {
  test("adds the allow entry and one env sink per machine, tagged, in one file", () => {
    const f = file(mcpAllowFile(base(), github()));
    expect(f.secrets["gh_token"]?.allow).toEqual([`mcp:github#${H1}`, "sink:mcp-github-mac", "sink:mcp-github-mini"]);
    expect(f.sinks["mcp-github-mac"]).toEqual({ machine: "mac", path: "/Users/e/.claude/mcp-env/github.env", format: "dotenv", keys: { GITHUB_PERSONAL_ACCESS_TOKEN: "gh_token" } });
    expect(f.sinks["mcp-github-mini"]?.path).toBe("/home/eric/.claude/mcp-env/github.env");
    expect(f.sinks["dns"]).toEqual(base().sinks["dns"]);
    expect(f.secrets["cf_token"]?.allow).toEqual(["sink:dns"]);
    expect(fileProblems(f).filter((p) => !p.includes("sealed to"))).toEqual([]);
  });

  test("headers get a json sink of their own", () => {
    const f = file(mcpAllowFile(base(), { server: "hook", hash: H1, env: {}, headers: { Authorization: "hook_key" }, homes: { mini: "/home/eric" } }));
    expect(f.sinks["mcp-hook-mini-headers"]).toEqual({ machine: "mini", path: "/home/eric/.claude/mcp-env/hook.headers.json", format: "json", keys: { Authorization: "hook_key" } });
    expect(f.sinks["mcp-hook-mini"]).toBeUndefined();
  });

  test("allowing again replaces the old entry and drops a machine taken out", () => {
    const once = file(mcpAllowFile(base(), github()));
    const twice = file(mcpAllowFile(once, github({ hash: H2, homes: { mini: "/home/eric" } })));
    expect(twice.secrets["gh_token"]?.allow).toEqual([`mcp:github#${H2}`, "sink:mcp-github-mini"]);
    expect(twice.sinks["mcp-github-mac"]).toBeUndefined();
  });

  test("refuses gpd, a secret the store lacks, no secrets at all, and a path another sink writes", () => {
    const err = (r: { file: SecretFile } | { error: string }) => ("error" in r ? r.error : "");
    expect(err(mcpAllowFile(base(), github({ homes: { gpd: "/home/eric" } })))).toContain("phase 3");
    expect(err(mcpAllowFile(base(), github({ env: { X: "gone" } })))).toContain("gone");
    expect(err(mcpAllowFile(base(), github({ env: {} })))).toContain("names no secret");
    const f = base();
    f.sinks["other"] = { machine: "mini", path: "/home/eric/.claude/mcp-env/github.env", format: "dotenv", keys: { A: "cf_token" } };
    expect(err(mcpAllowFile(f, github()))).toContain("sink other already writes");
  });
});

describe("mcpRevokeFile", () => {
  test("takes out the allow entries and the sinks, and leaves the rest as it was", () => {
    const allowed = file(mcpAllowFile(base(), github()));
    const back = file(mcpRevokeFile(allowed, "github"));
    expect(back.sinks).toEqual(base().sinks);
    expect(back.secrets).toEqual(base().secrets);
  });
  test("a server with no allowance is an error", () => {
    expect(mcpRevokeFile(base(), "github")).toEqual({ error: "github has no allowance" });
  });
});
