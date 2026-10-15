import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exec } from "../core/exec";
import { mcpHash } from "../core/kit";
import { fakeClaude } from "../core/kitfake";
import type { KitApplyResult, KitMcpPreview, SecretsInfo, ServerEvent } from "../core/types";
import { KitHub } from "./kit";

let dirs: string[] = [];
let hubs: KitHub[] = [];
afterEach(() => {
  for (const h of hubs) h.stop();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  hubs = []; dirs = [];
});

const MANIFEST = {
  version: 1,
  machines: { mac: { backend: "mac" }, mini: { backend: "mini" }, gpd: { ssh: "gpd", via: "mac", dev: "/home/eric/dev" } },
  targets: [
    { agent: "claude", skills: "~/.claude/skills", mode: "store" },
    { agent: "codex", skills: "~/.codex/skills", mode: "link" },
  ],
  skills: {},
};

async function setup(manifest: unknown = MANIFEST) {
  const h = mkdtempSync(join(tmpdir(), "kithub-"));
  dirs.push(h);
  const store = join(h, ".claude");
  await exec(["git", "init", "-q", "-b", "main", store]);
  mkdirSync(join(store, "skills/ship"), { recursive: true });
  writeFileSync(join(store, "skills/ship/SKILL.md"), "x");
  await exec(["git", "-C", store, "add", "."]);
  await exec(["git", "-C", store, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"]);
  mkdirSync(join(h, ".codex/skills"), { recursive: true });
  const kitPath = join(store, "kit.json");
  writeFileSync(kitPath, typeof manifest === "string" ? manifest : JSON.stringify(manifest));
  const events: ServerEvent[] = [];
  // gpd answers like a Tailscale SSH browser check; everything local runs for real
  const run = async (host: string | null, cmd: string[], opts?: { env?: Record<string, string>; timeoutMs?: number }) =>
    host === "gpd" ? { code: 255, stdout: "", stderr: "# Tailscale SSH requires an additional check." } : exec(cmd, opts);
  const hub = new KitHub({ self: "mac", devRoot: join(h, "dev"), kitPath, broadcast: (e) => events.push(e), run, env: { HOME: h }, every: 0 });
  hubs.push(hub);
  return { h, hub, events };
}

describe("KitHub", () => {
  test("scans its own machine and the ssh machine it is via, and broadcasts", async () => {
    const { hub, events } = await setup();
    const info = await hub.scan();
    expect(info.ok).toBe(true);
    expect(info.machines.map((m) => m.machine)).toEqual(["mac", "gpd"]);
    expect(info.machines[1]!.seen.away).toBe("Tailscale SSH requires an additional check.");
    expect(info.machines[0]!.plan).toEqual([{ kind: "link", agent: "codex", name: "ship", link: "../../.claude/skills/ship" }]);
    expect(events.at(-1)).toEqual({ type: "kit", kit: info });
  });
  test("a machine whose scan throws reads away, and the scan still resolves (an unhandled rejection would end the server)", async () => {
    const { h } = await setup();
    const run = async (host: string | null, cmd: string[], opts?: { env?: Record<string, string>; timeoutMs?: number }) => {
      if (host === "gpd") throw new Error("spawn failed");
      return exec(cmd, opts);
    };
    const hub = new KitHub({ self: "mac", devRoot: join(h, "dev"), kitPath: join(h, ".claude/kit.json"), broadcast: () => {}, run, env: { HOME: h }, every: 0 });
    hubs.push(hub);
    const info = await hub.scan();
    expect(info.machines.map((m) => [m.machine, m.seen.away])).toEqual([["mac", null], ["gpd", "spawn failed"]]);
  });
  test("apply carries out the plan and rescans; a dry run changes nothing", async () => {
    const { hub } = await setup();
    await hub.scan();
    const dry = await hub.apply("mac", undefined, true);
    expect(dry.done).toHaveLength(1);
    expect(hub.info().machines[0]!.plan).toHaveLength(1);
    const real = await hub.apply("mac");
    expect(real.failed).toEqual([]);
    expect(hub.info().machines[0]!.plan).toEqual([]);
  });
  test("routes: GET, scan, apply; unknown machine 400, away machine 409", async () => {
    const { hub } = await setup();
    await hub.scan();
    const call = (method: string, path: string, body?: unknown) =>
      hub.handle(new Request(`http://x${path}`, { method, body: body ? JSON.stringify(body) : undefined }), new URL(`http://x${path}`));
    expect((await call("GET", "/api/kit"))!.status).toBe(200);
    expect((await call("POST", "/api/kit/scan"))!.status).toBe(200);
    expect((await call("POST", "/api/kit/apply", { machine: "nope" }))!.status).toBe(400);
    expect((await call("POST", "/api/kit/apply", { machine: "gpd" }))!.status).toBe(409);
    expect(await call("GET", "/api/other")).toBeNull();
  });
  test("a malformed kit.json is an error with no machines, and apply refuses (review focus 5)", async () => {
    const { hub } = await setup("{ not json");
    const info = await hub.scan();
    expect(info).toMatchObject({ ok: false, machines: [], cells: [] });
    expect(info.error).toContain("kit.json");
    await expect(hub.apply("mac")).rejects.toThrow();
  });
  test("an action not in the plan is refused", async () => {
    const { hub } = await setup();
    await hub.scan();
    await expect(hub.apply("mac", [{ kind: "remove", agent: "codex", name: "ship" }])).rejects.toThrow("not in the current plan");
  });
});

const HAND = { type: "stdio", command: "bunx", args: ["-y", "@modelcontextprotocol/server-github"], env: { GITHUB_PERSONAL_ACCESS_TOKEN: "hand-literal-0x6b" } };
const GH_DEF = { command: "bunx", args: ["-y", "@modelcontextprotocol/server-github"], url: null, env: ["GITHUB_PERSONAL_ACCESS_TOKEN"], headers: [] };
const MCP_MANIFEST = {
  version: 1,
  machines: { mac: { backend: "mac" } },
  targets: [
    { agent: "claude", skills: "~/.claude/skills", mode: "store", mcp: { file: "~/.claude.json", format: "claude-json" } },
    { agent: "codex", skills: "~/.codex/skills", mode: "link", mcp: { file: "~/.codex/config.toml", format: "codex-toml" } },
  ],
  skills: {},
  mcp: {
    github: { command: "bunx", args: ["-y", "@modelcontextprotocol/server-github"], env: { GITHUB_PERSONAL_ACCESS_TOKEN: "${secret:gh_token}" } },
    excalidraw: { command: "npx", args: ["-y", "excalidraw-render"], agents: ["claude"] },
  },
};

function storeInfo(allow: string[], sink: "same" | "waiting" = "same"): SecretsInfo {
  const meta = { description: "", tags: [], created: "2026-10-14T12:00:00.000Z", rotated: "2026-10-14T12:00:00.000Z", to: ["mac", "mini"], usedBy: ["mcp-github-mac"] };
  return {
    ok: true, error: null, backend: "mac", role: "reader", head: "abc", refused: null, lock: sink === "waiting" ? "locked" : "open", recipient: null,
    secrets: [{ name: "gh_token", allow, ...meta }],
    sinks: [{ id: "mcp-github-mac", machine: "mac", path: "/x", format: "dotenv", keys: { GITHUB_PERSONAL_ACCESS_TOKEN: "gh_token" }, state: { GITHUB_PERSONAL_ACCESS_TOKEN: sink }, error: null }],
    proposals: [], passkeys: [], session: false, firstPasskey: false, gate: "", unpushed: 0,
  };
}

async function setupMcp() {
  const h = mkdtempSync(join(tmpdir(), "kithub-mcp-"));
  dirs.push(h);
  const store = join(h, ".claude");
  await exec(["git", "init", "-q", "-b", "main", store]);
  mkdirSync(join(store, "skills"), { recursive: true });
  mkdirSync(join(store, "bin"));
  writeFileSync(join(store, "bin", "canopy-mcp-env"), "#!/bin/sh\n", { mode: 0o755 });
  writeFileSync(join(store, ".gitignore"), "mcp-env/\n.canopy-kit-mcp.json\n");
  mkdirSync(join(h, ".codex", "skills"), { recursive: true });
  writeFileSync(join(h, ".codex", "config.toml"), "");
  writeFileSync(join(h, ".claude.json"), JSON.stringify({ mcpServers: { github: HAND } }));
  const kitPath = join(store, "kit.json");
  writeFileSync(kitPath, JSON.stringify(MCP_MANIFEST));
  let secrets = storeInfo([]);
  const events: ServerEvent[] = [];
  const hub = new KitHub({
    self: "mac", devRoot: join(h, "dev"), kitPath, broadcast: (e) => events.push(e), env: { HOME: h, KIT_CLAUDE: fakeClaude(h) }, every: 0,
    secrets: async () => secrets, hostHome: h, procEnv: {},
  });
  hubs.push(hub);
  const grants = async () => [`mcp:github#${await mcpHash(GH_DEF)}`, "sink:mcp-github-mac"];
  const allow = async (sink: "same" | "waiting" = "same") => {
    secrets = storeInfo(await grants(), sink);
  };
  const route = async (method: string, path: string, body?: unknown) => {
    const res = await hub.handle(new Request(`http://x${path}`, { method, body: body === undefined ? undefined : JSON.stringify(body) }), new URL(`http://x${path}`));
    if (!res) throw new Error(`${path} not handled`);
    return { status: res.status, text: await res.text() };
  };
  const claudeServers = () => (JSON.parse(readFileSync(join(h, ".claude.json"), "utf8")) as { mcpServers: Record<string, unknown> }).mcpServers;
  return { h, hub, events, allow, route, claudeServers };
}

describe("KitHub and MCP servers", () => {
  test("cells and plans carry servers; KitInfo holds no raw entry; the allow sheet gets names and the hash", async () => {
    const { hub, events } = await setupMcp();
    const info = await hub.scan();
    const cell = (agent: string, name: string) => info.cells.find((c) => c.kind === "mcp" && c.agent === agent && c.skill === name);
    expect(info.machines[0]?.seen.away).toBeNull();
    expect(cell("claude", "github")?.state).toBe("not-allowed");
    expect(cell("claude", "excalidraw")?.state).toBe("missing");
    expect(info.machines[0]?.plan).toContainEqual({ kind: "mcp-set", agent: "claude", name: "excalidraw" });
    expect(info.machines[0]?.home).toBeTruthy();
    expect(info.mcp).toEqual([{ name: "github", def: GH_DEF, hash: await mcpHash(GH_DEF), env: { GITHUB_PERSONAL_ACCESS_TOKEN: "gh_token" }, headers: {}, machines: ["mac"], later: [] }]);
    expect(JSON.stringify(info)).not.toContain("hand-literal-0x6b");
    expect(JSON.stringify(events)).not.toContain("hand-literal-0x6b");
  });

  test("an allowance landing in the store republishes the kit, and only then can github be adopted (review focus 1)", async () => {
    const { hub, allow, route, claudeServers } = await setupMcp();
    await hub.scan();
    const early = await route("POST", "/api/kit/adopt", { machine: "mac", agent: "claude", names: ["github"] });
    expect(early.status).toBe(409);
    expect(early.text).toContain("not allowed");
    await allow();
    await hub.republish();
    expect(hub.info().cells.find((c) => c.agent === "claude" && c.skill === "github")?.state).toBe("adoptable");
    const r = await route("POST", "/api/kit/adopt", { machine: "mac", agent: "claude", names: ["github"] });
    expect(r.status).toBe(200);
    expect(claudeServers()["github"]).toMatchObject({ command: expect.stringContaining("/.claude/bin/canopy-mcp-env"), args: ["github", "--", "bunx", "-y", "@modelcontextprotocol/server-github"] });
    expect(hub.info().cells.find((c) => c.agent === "claude" && c.skill === "github")).toMatchObject({ state: "ok", restore: true });
    expect((await route("POST", "/api/kit/restore", { machine: "mac", agent: "claude", name: "github" })).status).toBe(200);
    expect(claudeServers()["github"]).toEqual(HAND);
  });

  test("an unlock that brings the sink to same republishes the kit, and only then can github be adopted (review focus 1)", async () => {
    const { hub, allow, route, events } = await setupMcp();
    await allow("waiting");
    await hub.scan();
    expect(hub.info().cells.find((c) => c.kind === "mcp" && c.agent === "claude" && c.skill === "github")).toMatchObject({ state: "no-sink", why: "waiting for unlock" });
    const early = await route("POST", "/api/kit/adopt", { machine: "mac", agent: "claude", names: ["github"] });
    expect(early.status).toBe(409);
    expect(early.text).toContain("waiting for unlock");
    await allow("same");
    const before = events.length;
    await hub.republish();
    expect(events.length).toBe(before + 1);
    expect(hub.info().cells.find((c) => c.kind === "mcp" && c.agent === "claude" && c.skill === "github")?.state).toBe("adoptable");
  });

  test("the preview masks the hand-made entry's values (review focus 3)", async () => {
    const { hub, allow, route } = await setupMcp();
    await allow();
    await hub.scan();
    const r = await route("GET", "/api/kit/preview?machine=mac&agent=claude&name=github");
    expect(r.status).toBe(200);
    const p = JSON.parse(r.text) as KitMcpPreview;
    expect(p.state).toBe("adoptable");
    expect(p.have).toMatchObject({ env: { GITHUB_PERSONAL_ACCESS_TOKEN: "•••" } });
    expect(p.want).toMatchObject({ args: ["github", "--", "bunx", "-y", "@modelcontextprotocol/server-github"] });
    expect(r.text).not.toContain("hand-literal-0x6b");
  });

  test("apply all writes what it plans and leaves an adoptable hand-made entry alone", async () => {
    const { hub, allow, route, claudeServers } = await setupMcp();
    await allow();
    await hub.scan();
    const github = () => hub.info().cells.find((c) => c.kind === "mcp" && c.agent === "claude" && c.skill === "github");
    expect(github()?.state).toBe("adoptable");
    const r = JSON.parse((await route("POST", "/api/kit/apply", { machine: "mac" })).text) as KitApplyResult;
    const touches = (a: { agent?: string; name?: string }) => a.agent === "claude" && a.name === "github";
    expect(r.done.filter((a) => "name" in a && touches(a))).toEqual([]);
    expect(r.failed.filter((f) => "name" in f.action && touches(f.action))).toEqual([]);
    expect(r.done).toContainEqual({ kind: "mcp-set", agent: "claude", name: "excalidraw" });
    expect(claudeServers()["github"]).toEqual(HAND);
    expect(claudeServers()["excalidraw"]).toEqual({ type: "stdio", command: "npx", args: ["-y", "excalidraw-render"] });
    expect(github()?.state).toBe("adoptable");
  });

  test("adopt, put back and the preview refuse what is not there", async () => {
    const { hub, route } = await setupMcp();
    await hub.scan();
    expect((await route("POST", "/api/kit/adopt", { machine: "mac" })).status).toBe(400);
    expect((await route("POST", "/api/kit/adopt", { machine: "nope", agent: "claude" })).status).toBe(400);
    expect((await route("POST", "/api/kit/adopt", { machine: "mac", agent: "claude", names: "github" })).status).toBe(400);
    expect((await route("POST", "/api/kit/adopt", { machine: "mac", agent: "claude", names: ["nope"] })).status).toBe(409);
    expect((await route("POST", "/api/kit/restore", { machine: "mac", agent: "claude" })).status).toBe(400);
    expect((await route("POST", "/api/kit/restore", { machine: "mac", agent: "claude", name: "github" })).status).toBe(409);
    expect((await route("GET", "/api/kit/preview?machine=mac&agent=claude&name=nope")).status).toBe(404);
    // adopt and put back are never in a plan, so apply refuses them
    expect((await route("POST", "/api/kit/apply", { machine: "mac", actions: [{ kind: "mcp-adopt", agent: "claude", name: "github" }] })).status).toBe(409);
  });
});
