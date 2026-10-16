import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exec } from "../core/exec";
import { mcpHash } from "../core/kit";
import { fakeClaude } from "../core/kitfake";
import type { KitApplyResult, KitMcpPreview, SecretsInfo, ServerEvent } from "../core/types";
import { KitHub, type KitHubDeps } from "./kit";

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

/** no digits, so maskEntry leaves the path as it is */
const HOST = "/home/hostside";

async function setupMcp(over: Partial<KitHubDeps> = {}) {
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
  // a held read answers only when the test releases it, with what the test gives
  const held: Promise<SecretsInfo>[] = [];
  const hold = () => {
    let release: (info: SecretsInfo) => void = () => {};
    held.push(new Promise<SecretsInfo>((r) => { release = r; }));
    return release;
  };
  const events: ServerEvent[] = [];
  const hub = new KitHub({
    self: "mac", devRoot: join(h, "dev"), kitPath, broadcast: (e) => events.push(e), env: { HOME: h, KIT_CLAUDE: fakeClaude(h) }, every: 0,
    // the host's home differs from the scan's HOME, as on the mini (/home/eric beside /home/bun)
    secrets: () => held.shift() ?? Promise.resolve(secrets), hostHome: HOST, procEnv: {},
    ...over,
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
  return { h, kitPath, hub, events, allow, grants, hold, route, claudeServers };
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
    expect(info.machines[0]?.home).toBe(HOST);
    expect(info.machines[0]?.seen.home).not.toBe(HOST);
    expect(info.mcp).toEqual([{ name: "github", def: GH_DEF, hash: await mcpHash(GH_DEF), env: { GITHUB_PERSONAL_ACCESS_TOKEN: "gh_token" }, headers: {}, machines: ["mac"] }]);
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
    expect(claudeServers()["github"]).toMatchObject({ command: `${HOST}/.claude/bin/canopy-mcp-env`, args: ["github", "--", "bunx", "-y", "@modelcontextprotocol/server-github"] });
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
    expect(p.want).toMatchObject({ command: `${HOST}/.claude/bin/canopy-mcp-env`, args: ["github", "--", "bunx", "-y", "@modelcontextprotocol/server-github"] });
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

  test("two adopts that overlap on one machine both keep their hand-made entries (final review 1)", async () => {
    const { h, hub, allow } = await setupMcp();
    writeFileSync(join(h, ".codex", "config.toml"), '[mcp_servers.github]\ncommand = "bunx"\nargs = ["-y", "@modelcontextprotocol/server-github"]\n');
    await allow();
    await hub.scan();
    const [a, b] = await Promise.all([hub.adopt("mac", "claude", ["github"]), hub.adopt("mac", "codex", ["github"])]);
    expect([a.failed, b.failed]).toEqual([[], []]);
    const owned = JSON.parse(readFileSync(join(h, ".claude", ".canopy-kit-mcp.json"), "utf8")) as { placed: Record<string, string[]>; adoptedFrom: Record<string, Record<string, unknown>> };
    expect(owned.placed).toEqual({ claude: ["github"], codex: ["github"] });
    expect(Object.keys(owned.adoptedFrom.claude ?? {})).toEqual(["github"]);
    expect(Object.keys(owned.adoptedFrom.codex ?? {})).toEqual(["github"]);
  });

  test("an apply that overlaps an adopt keeps the adopt's record, and a refused call does not stop the next (final review 1)", async () => {
    const { h, hub, allow } = await setupMcp();
    await allow();
    await hub.scan();
    const [bad, a, b] = await Promise.allSettled([hub.adopt("mac", "claude", ["nope"]), hub.adopt("mac", "claude", ["github"]), hub.apply("mac")]);
    expect(bad.status).toBe("rejected");
    expect(a.status).toBe("fulfilled");
    expect(b.status).toBe("fulfilled");
    const owned = JSON.parse(readFileSync(join(h, ".claude", ".canopy-kit-mcp.json"), "utf8")) as { placed: Record<string, string[]>; adoptedFrom: Record<string, Record<string, unknown>> };
    expect(owned.placed["claude"]).toEqual(["excalidraw", "github"]);
    expect(Object.keys(owned.adoptedFrom.claude ?? {})).toEqual(["github"]);
  });

  test("adopt and adopt all are refused while dotclaude does not ignore the ownership file (final review 9)", async () => {
    const { h, hub, allow, route, claudeServers } = await setupMcp();
    writeFileSync(join(h, ".claude", ".gitignore"), "mcp-env/\n");
    await allow();
    await hub.scan();
    for (const body of [{ machine: "mac", agent: "claude", names: ["github"] }, { machine: "mac", agent: "claude" }]) {
      const r = await route("POST", "/api/kit/adopt", body);
      expect(r.status).toBe(409);
      expect(r.text).toContain("dotclaude does not ignore .canopy-kit-mcp.json here");
    }
    expect(claudeServers()["github"]).toEqual(HAND);
  });

  test("an MCP scan that fails paints each server the reason instead of an empty table (final review 5)", async () => {
    const run: KitHubDeps["run"] = async (host, cmd, opts) =>
      cmd[3] === "kit-mcp-scan" ? { code: 2, stdout: "", stderr: "sh: base64: not found\n" } : exec(cmd, opts);
    const { hub } = await setupMcp({ run });
    const info = await hub.scan();
    const servers = info.cells.filter((c) => c.kind === "mcp");
    expect(servers.map((c) => `${c.agent}/${c.skill} ${c.state}`).sort()).toEqual(["claude/excalidraw away", "claude/github away", "codex/github away"]);
    expect(servers[0]?.why).toBe("the MCP scan failed: sh: base64: not found");
    expect(info.machines[0]?.plan.filter((a) => a.kind.startsWith("mcp-"))).toEqual([]);
  });

  test("the host's home is what the kit writes; the scan still reads under HOME (ruling 6)", async () => {
    const { h, hub, allow, route } = await setupMcp();
    await allow();
    const info = await hub.scan();
    expect(info.machines[0]).toMatchObject({ home: HOST, seen: { home: h } });
    const p = JSON.parse((await route("GET", "/api/kit/preview?machine=mac&agent=claude&name=github")).text) as KitMcpPreview;
    // the hand-made entry came from HOME's .claude.json, the planned wrapper from the host's home
    expect(p.have).toMatchObject({ command: "bunx" });
    expect(p.want).toMatchObject({ command: `${HOST}/.claude/bin/canopy-mcp-env` });
  });

  test("a republish that waits on the store while kit.json changes leaves the new kit's plan (fix round 1)", async () => {
    const { hub, kitPath, hold, route } = await setupMcp();
    await hub.scan();
    const release = hold();
    const late = hub.republish();
    // kit.json drops excalidraw and gains fetch while that republish waits
    const { excalidraw: _, ...rest } = MCP_MANIFEST.mcp;
    writeFileSync(kitPath, JSON.stringify({ ...MCP_MANIFEST, mcp: { ...rest, fetch: { command: "uvx", args: ["mcp-server-fetch"], agents: ["claude"] } } }));
    await hub.scan();
    release(storeInfo([]));
    await late;
    const mcp = hub.info().cells.filter((c) => c.kind === "mcp" && c.agent === "claude").map((c) => c.skill);
    expect(mcp).toContain("fetch");
    expect(mcp).not.toContain("excalidraw");
    expect(hub.info().machines[0]?.plan).toContainEqual({ kind: "mcp-set", agent: "claude", name: "fetch" });
    expect(hub.info().machines[0]?.plan).not.toContainEqual({ kind: "mcp-set", agent: "claude", name: "excalidraw" });
    expect((await route("GET", "/api/kit/preview?machine=mac&agent=claude&name=excalidraw")).status).toBe(404);
    expect((await route("GET", "/api/kit/preview?machine=mac&agent=claude&name=fetch")).status).toBe(200);
  });

  test("two publishes that answer out of order leave the newer one's result (fix round 1)", async () => {
    const { hub, grants, hold } = await setupMcp();
    await hub.scan();
    const allowed = storeInfo(await grants());
    const releaseOlder = hold();
    const older = hub.republish();
    const releaseNewer = hold();
    const newer = hub.republish();
    releaseNewer(allowed);
    await newer;
    releaseOlder(storeInfo([]));
    await older;
    expect(hub.info().cells.find((c) => c.kind === "mcp" && c.agent === "claude" && c.skill === "github")?.state).toBe("adoptable");
  });
});

describe("skill adopt, put back and tools (phase 3 part B)", () => {
  /** a scratch home with a store holding ship, for the backend's machine or for gpd */
  async function scratchHome(prefix: string): Promise<string> {
    const h = mkdtempSync(join(tmpdir(), prefix));
    dirs.push(h);
    const store = join(h, ".claude");
    await exec(["git", "init", "-q", "-b", "main", store]);
    mkdirSync(join(store, "skills/ship"), { recursive: true });
    writeFileSync(join(store, "skills/ship/SKILL.md"), "x");
    await exec(["git", "-C", store, "add", "."]);
    await exec(["git", "-C", store, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"]);
    mkdirSync(join(h, ".codex/skills"), { recursive: true });
    return h;
  }
  const ALL_OS = (line: string) => ({ darwin: line, arch: line, debian: line });
  // the tests may run in a container themselves; the mac and gpd here are hosts unless a test says
  async function setupB(tools: unknown = {}, container = "0") {
    const mac = await scratchHome("kithub-b-mac-");
    const gpd = await scratchHome("kithub-b-gpd-");
    const manifest = { ...MANIFEST, tools };
    const kitPath = join(mac, ".claude/kit.json");
    writeFileSync(kitPath, JSON.stringify(manifest));
    // gpd runs on its own scratch home, as ssh would run it there
    const hosts: (string | null)[] = [];
    const run = async (host: string | null, cmd: string[], opts?: { env?: Record<string, string>; timeoutMs?: number; input?: string }) => {
      hosts.push(host);
      return exec(cmd, host === "gpd" ? { ...opts, env: { HOME: gpd, KIT_CONTAINER: "0" } } : opts);
    };
    const hub = new KitHub({ self: "mac", devRoot: join(mac, "dev"), kitPath, broadcast: () => {}, run, env: { HOME: mac, KIT_CONTAINER: container }, every: 0 });
    hubs.push(hub);
    const route = async (method: string, path: string, body?: unknown) =>
      (await hub.handle(new Request(`http://x${path}`, { method, body: body ? JSON.stringify(body) : undefined }), new URL(`http://x${path}`)))!;
    const cell = (machine: string, skill: string, kind?: "tool") => hub.info().cells.find((c) => c.machine === machine && c.skill === skill && c.kind === kind && (kind === "tool" || c.agent === "codex"));
    return { mac, gpd, hub, route, cell, hosts };
  }

  test("adopt over ssh moves gpd's hand-made skill aside and links; put back brings it back", async () => {
    const { gpd, hub, route, cell, hosts } = await setupB();
    mkdirSync(join(gpd, ".codex/skills/ship"));
    writeFileSync(join(gpd, ".codex/skills/ship/SKILL.md"), "gpd's own");
    await hub.scan();
    expect(cell("gpd", "ship")?.state).toBe("adoptable");
    // never in a plan, so apply all leaves it alone
    expect(hub.info().machines.find((m) => m.machine === "gpd")?.plan).toEqual([]);
    const r = await route("POST", "/api/kit/skill-adopt", { machine: "gpd", agent: "codex", name: "ship" });
    expect(r.status).toBe(200);
    expect(((await r.json()) as KitApplyResult).failed).toEqual([]);
    expect(hosts).toContain("gpd");
    expect(readFileSync(join(gpd, ".codex/.canopy-kit-adopted/ship/SKILL.md"), "utf8")).toBe("gpd's own");
    expect(cell("gpd", "ship")).toMatchObject({ state: "ok", restore: true });
    expect((await route("POST", "/api/kit/skill-adopt", { machine: "gpd", agent: "codex", name: "ship" })).status).toBe(409);
    const back = await route("POST", "/api/kit/skill-restore", { machine: "gpd", agent: "codex", name: "ship" });
    expect(((await back.json()) as KitApplyResult).failed).toEqual([]);
    expect(readFileSync(join(gpd, ".codex/skills/ship/SKILL.md"), "utf8")).toBe("gpd's own");
    expect(cell("gpd", "ship")?.state).toBe("adoptable");
    expect(cell("gpd", "ship")?.restore).toBeUndefined();
  });
  test("adopt and put back are refused where the cell does not offer them, and an adopt is never an apply action", async () => {
    const { hub, route } = await setupB();
    await hub.scan();
    expect((await route("POST", "/api/kit/skill-adopt", { machine: "mac", agent: "codex", name: "ship" })).status).toBe(409);
    expect((await route("POST", "/api/kit/skill-restore", { machine: "mac", agent: "codex", name: "ship" })).status).toBe(409);
    expect((await route("POST", "/api/kit/skill-adopt", { machine: "mac", agent: "codex" })).status).toBe(400);
    await expect(hub.apply("mac", [{ kind: "skill-adopt", agent: "codex", name: "ship", link: "../../.claude/skills/ship" }])).rejects.toThrow("not in the current plan");
  });
  test("apply takes one cell's actions alone", async () => {
    const { mac, hub } = await setupB();
    mkdirSync(join(mac, ".claude/skills/desk"), { recursive: true });
    writeFileSync(join(mac, ".claude/skills/desk/SKILL.md"), "x");
    await exec(["git", "-C", join(mac, ".claude"), "add", "."]);
    await exec(["git", "-C", join(mac, ".claude"), "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "desk"]);
    await hub.scan();
    expect(hub.info().machines[0]!.plan).toHaveLength(2);
    const r = await hub.apply("mac", [{ kind: "link", agent: "codex", name: "desk", link: "../../.claude/skills/desk" }]);
    expect(r.done).toHaveLength(1);
    expect(hub.info().machines[0]!.plan).toEqual([{ kind: "link", agent: "codex", name: "ship", link: "../../.claude/skills/ship" }]);
  });

  test("tools: a missing tool installs from its line and checks again; ok, sudo and unknown tools are refused", async () => {
    const { mac, hub, route, cell } = await setupB({
      marker: { check: "[ -f \"$HOME/installed\" ] || exit 127", install: ALL_OS("touch \"$HOME/installed\"") },
      rooted: { check: "kit-no-such-tool-x9", install: ALL_OS("sudo pacman -S --noconfirm x9") },
      fine: { check: "true" },
    });
    await hub.scan();
    expect(cell("mac", "marker", "tool")).toMatchObject({ state: "missing", install: "touch \"$HOME/installed\"" });
    expect(cell("mac", "rooted", "tool")).toMatchObject({ state: "missing", sudo: true });
    expect(cell("mac", "fine", "tool")?.state).toBe("ok");
    // gpd's tools come from its own run
    expect(cell("gpd", "fine", "tool")?.state).toBe("ok");
    const refused = async (body: unknown, status: number, text: string) => {
      const r = await route("POST", "/api/kit/install", body);
      expect(r.status).toBe(status);
      expect(((await r.json()) as { error: string }).error).toContain(text);
    };
    await refused({ machine: "mac", tool: "rooted", line: "sudo pacman -S --noconfirm x9" }, 409, "uses sudo");
    await refused({ machine: "mac", tool: "nope", line: "x" }, 404, "not a tool kit.json lists");
    await refused({ machine: "mac", tool: "fine", line: "true" }, 409, "nothing to install");
    await refused({ machine: "mac", tool: "marker", line: "touch \"$HOME/other\"" }, 409, "has changed since it was shown");
    await refused({ machine: "mac", tool: "marker" }, 400, "required");
    const r = await route("POST", "/api/kit/install", { machine: "mac", tool: "marker", line: "touch \"$HOME/installed\"" });
    expect(r.status).toBe(200);
    expect(((await r.json()) as { code: number }).code).toBe(0);
    expect(existsSync(join(mac, "installed"))).toBe(true);
    expect(cell("mac", "marker", "tool")?.state).toBe("ok");
    // never part of apply all
    expect(hub.info().machines[0]!.plan.every((a) => a.kind === "link")).toBe(true);
  });

  test("tools: a machine that checks in a container shows its line and refuses the install", async () => {
    const { mac, hub, route, cell } = await setupB({ marker: { check: "[ -f \"$HOME/installed\" ] || exit 127", install: ALL_OS("touch \"$HOME/installed\"") } }, "1");
    await hub.scan();
    expect(cell("mac", "marker", "tool")).toMatchObject({ state: "missing", container: true });
    // gpd is a host, so its line still runs
    expect(cell("gpd", "marker", "tool")?.container).toBeUndefined();
    const r = await route("POST", "/api/kit/install", { machine: "mac", tool: "marker", line: "touch \"$HOME/installed\"" });
    expect(r.status).toBe(409);
    expect(((await r.json()) as { error: string }).error).toContain("add marker to the image");
    expect(existsSync(join(mac, "installed"))).toBe(false);
  });
});
