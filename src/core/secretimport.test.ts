import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatOf } from "./secretfile";
import { fromClaudeJson, fromCodexToml, fromCredentials, fromDotenv, macSources, miniSources, readDotenv, scanFiles, sopsNames, suggestName } from "./secretimport";

describe("readers", () => {
  test("dotenv: every pair with a value", () => {
    expect(fromDotenv("/a/.env", "# c\nA=1\nB=\nexport C='x y'\n")).toEqual([
      { source: "/a/.env", key: "A", value: "1" },
      { source: "/a/.env", key: "C", value: "x y" },
    ]);
    expect(fromDotenv("/a/.env", "not a pair\n")).toEqual([]);
  });

  test("dotenv: a key written twice is found once, with its last value", () => {
    expect(fromDotenv("/a/.env", "A=1\nB=2\nA=3\n")).toEqual([
      { source: "/a/.env", key: "A", value: "3" },
      { source: "/a/.env", key: "B", value: "2" },
    ]);
  });

  test("dotenv: a notes file gives up its pairs, marked partial, and the numbers of the lines that are not pairs", () => {
    const text = ["# keys", "OPENAI_API_KEY=k1", "Wi-Fi-pass=hunter2", "router : admin / letmein", "GROQ_API_KEY = k2", "eric@10.0.0.2 pw", ""].join("\n");
    const r = readDotenv("/d/.env", text);
    expect(r.found).toEqual([
      { source: "/d/.env", key: "OPENAI_API_KEY", value: "k1", partial: true },
      { source: "/d/.env", key: "GROQ_API_KEY", value: "k2", partial: true },
    ]);
    expect(r.skipped).toEqual([3, 4, 6]);
  });

  test("dotenv: the later lines of a value that runs over several are skipped, never read as pairs", () => {
    const text = ['CERT="-----BEGIN', "Qw==", 'tail"', "AFTER=1", ""].join("\n");
    const r = readDotenv("/d/.env", text);
    expect(r.found.map((f) => f.key)).toEqual(["AFTER"]);
    expect(r.skipped).toEqual([1, 2, 3]);
  });

  test("dotenv: a closed quote with words after it is one bad line, and the next line is read", () => {
    const r = readDotenv("/d/.env", 'A="x" and more\nB=2\n');
    expect(r.found.map((f) => f.key)).toEqual(["B"]);
    expect(r.skipped).toEqual([1]);
  });

  test("dotenv: a file of pairs only is not partial", () => {
    const r = readDotenv("/d/.env", "A=1\n\n# c\nB=2\n");
    expect(r.found).toEqual([
      { source: "/d/.env", key: "A", value: "1" },
      { source: "/d/.env", key: "B", value: "2" },
    ]);
    expect(r.skipped).toEqual([]);
  });

  test("credentials: string leaves as dotted keys", () => {
    const text = JSON.stringify({ cloudflare: { api_token: "t1", account: { id: "a1" } }, kasa: { password: "p1", port: 9999 } });
    expect(fromCredentials("/c.json", text).map((f) => f.key)).toEqual(["cloudflare.api_token", "cloudflare.account.id", "kasa.password"]);
  });

  test("claude.json: MCP env and headers, top level and per project, skipping references", () => {
    const text = JSON.stringify({
      mcpServers: { github: { env: { GITHUB_TOKEN: "g1", REF: "${OTHER}" } }, linear: { headers: { Authorization: "Bearer l1" } } },
      projects: { "/Users/e/dev/x": { mcpServers: { db: { env: { DB_URL: "d1" } } } } },
      oauthAccount: { emailAddress: "not read" },
    });
    expect(fromClaudeJson("/h/.claude.json", text).map((f) => f.key)).toEqual([
      "mcpServers.github.env.GITHUB_TOKEN",
      "mcpServers.linear.headers.Authorization",
      "projects./Users/e/dev/x.mcpServers.db.env.DB_URL",
    ]);
  });

  test("codex config.toml: MCP env", () => {
    const text = '[mcp_servers.search]\ncommand = "x"\n[mcp_servers.search.env]\nAPI_KEY = "k1"\nPLAIN = "${HOME}"\n';
    expect(fromCodexToml("/h/.codex/config.toml", text)).toEqual([{ source: "/h/.codex/config.toml", key: "mcp_servers.search.env.API_KEY", value: "k1" }]);
  });

  test("sops: names only", () => {
    expect(sopsNames("/s.yaml", "DB_PASSWORD: ENC[AES256_GCM,data:x]\nsops:\n  version: 3\n")).toEqual([{ source: "/s.yaml", key: "DB_PASSWORD", value: null }]);
  });
});

describe("suggestName", () => {
  test.each([
    ["/opt/stacks/immich/.env", "DB_PASSWORD", "immich_db_password"],
    ["/Users/e/.claude/credentials/.credentials.json", "cloudflare.api_token", "cloudflare_api_token"],
    ["/Users/e/dev/.env", "OPENAI_API_KEY", "openai_api_key"],
    ["/Users/e/.claude.json", "mcpServers.github.env.GITHUB_TOKEN", "github_token"],
    ["/opt/stacks/executor/.env", "EXECUTOR_SECRET_KEY", "executor_secret_key"],
    ["/opt/stacks/beric-gate/.env", "GATE_OWNER_EMAIL", "beric-gate_gate_owner_email"],
    ["/Users/e/dev/.env", "9LIVES", "s_9lives"],
  ])("%s %s", (source, key, want) => {
    expect(suggestName(source, key)).toBe(want);
  });
});

test("formatOf: only dotenv and json sources can become sinks", () => {
  expect(formatOf("/opt/stacks/x/.env")).toBe("dotenv");
  expect(formatOf("/import/canopy.env")).toBe("dotenv");
  // a backend's own settings, kept outside its checkout under a bare name
  expect(formatOf("/home/eric/.config/canopy-deploy/env")).toBe("dotenv");
  expect(formatOf("/h/.claude/credentials/.credentials.json")).toBe("json");
  expect(formatOf("/h/.codex/config.toml")).toBeNull();
  expect(formatOf("/opt/stacks/memory/env.sops.yaml")).toBeNull();
  expect(formatOf("/h/.env/notes")).toBeNull();
  expect(formatOf("/h/myenv")).toBeNull();
});

describe("scanFiles and the source lists", () => {
  let dir = "";
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "canopy-import-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("reads what exists and names what does not", async () => {
    await writeFile(join(dir, ".env"), "A=1\n");
    const r = await scanFiles([
      { path: join(dir, ".env"), kind: "dotenv" },
      { path: join(dir, "gone.json"), kind: "credentials" },
    ]);
    expect(r.found).toEqual([{ source: join(dir, ".env"), key: "A", value: "1" }]);
    expect(r.missing).toEqual([join(dir, "gone.json")]);
    expect(r.skipped).toEqual([]);
  });

  test("names the lines of a dotenv file it could not read, by number", async () => {
    await writeFile(join(dir, ".env"), "A=1\na note\n");
    await writeFile(join(dir, "c.json"), '{"k": "v"}');
    const r = await scanFiles([
      { path: join(dir, ".env"), kind: "dotenv" },
      { path: join(dir, "c.json"), kind: "credentials" },
    ]);
    expect(r.found).toEqual([
      { source: join(dir, ".env"), key: "A", value: "1", partial: true },
      { source: join(dir, "c.json"), key: "k", value: "v" },
    ]);
    expect(r.skipped).toEqual([{ path: join(dir, ".env"), lines: [2] }]);
  });

  test("the mini's list: each stack's .env, the two sops files, and the extra files", async () => {
    await mkdir(join(dir, "immich"));
    await mkdir(join(dir, "memory"));
    const list = await miniSources(dir, ["/import/canopy.env"]);
    expect(list).toEqual([
      { path: join(dir, "immich", ".env"), kind: "dotenv" },
      { path: join(dir, "memory", ".env"), kind: "dotenv" },
      { path: join(dir, "memory", "env.sops.yaml"), kind: "sops" },
      { path: join(dir, "executor", "env.sops.yaml"), kind: "sops" },
      { path: "/import/canopy.env", kind: "dotenv" },
    ]);
  });

  test("the Mac's list", () => {
    expect(macSources("/Users/e", "/Users/e/dev").map((s) => s.kind)).toEqual(["credentials", "dotenv", "claude", "codex"]);
  });
});
