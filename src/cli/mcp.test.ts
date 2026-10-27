import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LineSplitter } from "../core/codexrpc";
import { tokenFile } from "./api";
import { apiOver, mcpToken, toolLines } from "./mcp";

const root = join(import.meta.dir, "../..");
const oldConfig = process.env["CANOPY_CONFIG_DIR"];
let server: ReturnType<typeof Bun.serve>;
let base = "";
let config = "";
const seen: { path: string; token: string | null; body: unknown }[] = [];

beforeAll(async () => {
  config = await mkdtemp(join(tmpdir(), "canopy-mcp-"));
  process.env["CANOPY_CONFIG_DIR"] = config;
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const path = new URL(req.url).pathname;
      seen.push({ path, token: req.headers.get("x-canopy-token"), body: req.method === "POST" ? await req.json() : null });
      if (path === "/api/auth") return Response.json({ you: "shell" });
      if (path === "/api/tree") return Response.json({ repos: [{ id: "a", name: "a", path: "/d/a", group: "", source: "root", status: { branch: "main", upstream: null, ahead: 0, behind: 0, files: [], lastCommit: null, user: null } }] });
      if (path === "/api/runs") return Response.json([]);
      if (path === "/api/runs/say") return Response.json({ error: "no run nope" }, { status: 404 });
      if (path === "/redirect") return new Response(null, { status: 302, headers: { location: "/api/runs/say" } });
      return Response.json({ error: "nope" }, { status: 404 });
    },
  });
  base = `http://127.0.0.1:${server.port}`;
  await writeFile(tokenFile(base), "file-token");
});
afterAll(async () => {
  server.stop(true);
  if (oldConfig === undefined) delete process.env["CANOPY_CONFIG_DIR"];
  else process.env["CANOPY_CONFIG_DIR"] = oldConfig;
  await rm(config, { recursive: true, force: true });
});

const env = () => ({ ...process.env, CANOPY_API: base, CANOPY_TOKEN: "env-token", CANOPY_CONFIG_DIR: config });
const msg = (value: unknown) => JSON.stringify(value) + "\n";

async function command(args: string[], extra: Record<string, string> = {}) {
  const child = Bun.spawn(["bun", "bin/canopy.ts", "mcp", ...args], { cwd: root, env: { ...env(), ...extra }, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { stdout, stderr, code };
}

test("the session token wins over the CLI token file", () => {
  expect(mcpToken(base, { CANOPY_TOKEN: "env-token" })).toBe("env-token");
  expect(mcpToken(base, {})).toBe("file-token");
  expect(mcpToken("http://127.0.0.1:1", {})).toBeNull();
});

test("a read token's tool listing excludes writes", () => {
  const lines = toolLines("none", "http://x");
  expect(lines[0]).toBe("tools for a none token on http://x");
  expect(lines).toHaveLength(5);
  expect(lines.slice(1).map((line) => line.trim().split(/\s+/)[0])).toEqual(["canopy_status", "canopy_runs", "canopy_queue", "canopy_health"]);
});

test("stdio replies preserve order and the session's token, including an API refusal", async () => {
  seen.length = 0;
  const child = Bun.spawn(["bun", "bin/canopy.ts", "mcp"], { cwd: root, env: env(), stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  for (const value of [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 2, method: "tools/list" },
    { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "canopy_status", arguments: {} } },
    { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "canopy_say", arguments: { id: "nope", text: "hi" } } },
  ]) child.stdin.write(msg(value));
  child.stdin.end();
  const [text, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  const replies: unknown[] = new LineSplitter().push(text).map((line): unknown => JSON.parse(line));
  expect(replies).toHaveLength(4);
  expect(replies[0]).toMatchObject({ id: 1, result: { protocolVersion: "2025-06-18", serverInfo: { name: "canopy" }, capabilities: { tools: {} } } });
  expect(replies[1]).toMatchObject({ id: 2, result: { tools: [{ name: "canopy_status" }, { name: "canopy_runs" }, { name: "canopy_queue" }, { name: "canopy_health" }, { name: "canopy_say" }, { name: "canopy_wake" }, { name: "canopy_land" }, { name: "canopy_pr" }] } });
  expect(replies[2]).toMatchObject({ id: 3, result: { content: [{ type: "text", text: "a  main" }] } });
  expect(replies[3]).toMatchObject({ id: 4, result: { content: [{ type: "text", text: "no run nope" }], isError: true } });
  expect(code).toBe(0);
  expect(stderr).toBe("");
  expect(seen.map(({ path, token }) => [path, token])).toEqual([["/api/auth", "env-token"], ["/api/tree", "env-token"], ["/api/runs", "env-token"], ["/api/runs/say", "env-token"]]);
});

test("tools prints only the listing; an unavailable backend fails on stderr", async () => {
  const ok = await command(["tools"]);
  expect(ok.code).toBe(0);
  expect(ok.stdout.trim().split("\n")).toHaveLength(9);
  expect(ok.stdout.split("\n")[0]).toBe(`tools for a shell token on ${base}`);
  expect(ok.stderr).toBe("");
  const down = await command(["tools"], { CANOPY_API: "http://127.0.0.1:1" });
  expect(down.code).toBe(1);
  expect(down.stdout).toBe("");
  expect(down.stderr).toContain("canopy mcp: http://127.0.0.1:1 did not answer");
});

test("API errors are reported once and redirects are never followed", async () => {
  seen.length = 0;
  const api = apiOver(base, "session-token");
  await expect(api.call("POST", "/api/runs/say", { id: "nope", text: "hi" })).rejects.toThrow("no run nope");
  await expect(api.call("POST", "/redirect", {})).rejects.toThrow(`${base} answered 302`);
  expect(seen.map(({ path }) => path)).toEqual(["/api/runs/say", "/redirect"]);
});

test("the shells bundle answers initialize and refuses commands other than mcp", async () => {
  const out = join(config, "bundle");
  const built = await Bun.build({ entrypoints: [join(root, "bin/canopy-mcp.ts")], target: "bun", outdir: out });
  expect(built.success).toBe(true);
  const file = join(out, "canopy-mcp.js");
  const refused = Bun.spawnSync(["bun", file, "status"], { env: env() });
  expect(refused.exitCode).toBe(1);
  expect(refused.stderr.toString()).toContain("only canopy mcp runs here");
  const child = Bun.spawn(["bun", file, "mcp"], { env: env(), stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  child.stdin.write(msg({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } }));
  child.stdin.end();
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  const reply: unknown = JSON.parse(stdout.trim());
  expect(reply).toMatchObject({ id: 1, result: { protocolVersion: "2024-11-05", serverInfo: { name: "canopy" } } });
  expect(code).toBe(0);
  expect(stderr).toBe("");
});
