import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exec } from "../core/exec";
import { fakePluginCli, seedFakePlugins } from "../core/pluginfake";
import type { PluginCatalog, PluginCommitPreview, PluginOpResult, ServerEvent } from "../core/types";
import { KitHub } from "./kit";

let dirs: string[] = [];
let hubs: KitHub[] = [];
afterEach(() => {
  for (const h of hubs) h.stop();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  hubs = []; dirs = [];
});

const manifest = (commits: boolean, plugins: string[] = ["claude", "codex"]) => ({
  version: 1,
  machines: { mac: { backend: "mac", ...(commits ? { commits: true } : {}) }, gpd: { ssh: "gpd", via: "mac", dev: "/home/eric/dev" } },
  targets: [
    { agent: "claude", skills: "~/.claude/skills", mode: "store" },
    { agent: "codex", skills: "~/.codex/skills", mode: "link" },
  ],
  skills: {},
  plugins,
});

const CODEX_CONFIG = [
  'model = "gpt-6"',
  "# kept as it is",
  "",
  "[marketplaces.openai-bundled]",
  'source = "/bundled"',
  "",
  '[plugins."pdf@openai-bundled"]',
  "enabled = true",
  "",
  '[plugins."stuck@openai-bundled"]',
  "enabled = true",
  "",
  "[features]",
  "enabled = true",
  "",
].join("\n");

const SETTINGS = { enabledPlugins: { "superpowers@official": true, "remember@official": true }, extraKnownMarketplaces: { official: { source: { source: "github", repo: "anthropics/official" } } } };

/** a home whose ~/.claude is a dotclaude checkout with settings.json tracked, and fake claude and codex */
async function setup(opts: { commits?: boolean; plugins?: string[]; hostHome?: string } = {}) {
  const h = mkdtempSync(join(tmpdir(), "kitplugins-"));
  dirs.push(h);
  const store = join(h, ".claude");
  await exec(["git", "init", "-q", "-b", "main", store]);
  mkdirSync(join(store, "skills/ship"), { recursive: true });
  writeFileSync(join(store, "skills/ship/SKILL.md"), "x");
  writeFileSync(join(store, "settings.json"), JSON.stringify(SETTINGS, null, 2));
  await exec(["git", "-C", store, "add", "."]);
  await exec(["git", "-C", store, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"]);
  mkdirSync(join(h, ".codex/skills"), { recursive: true });
  const kitPath = join(store, "kit.json");
  writeFileSync(kitPath, JSON.stringify(manifest(opts.commits ?? false, opts.plugins)));
  const bin = join(h, "bin");
  mkdirSync(bin);
  const log = join(h, "plugin.log");
  seedFakePlugins(h, "claude", {
    installed: {
      "superpowers@official": { enabled: true, version: "7.0.0" },
      "context-mode@cm": { enabled: false, servers: { "context-mode": { command: "node", args: ["server.mjs"] } } },
    },
    markets: { official: "anthropics/official" },
    catalog: [
      { id: "superpowers@official", description: "skills", installs: 10 },
      { id: "remember@official", description: "Continuous memory", installs: 5 },
      { id: "fresh@official", description: "a new one", installs: 1 },
      { id: "needs-cmd@official", description: "runs a command" },
    ],
  });
  seedFakePlugins(h, "codex", {
    installed: {
      "pdf@openai-bundled": { enabled: true },
      "gmail@openai-curated-remote": { enabled: true, remote: true },
      "stuck@openai-bundled": { enabled: true },
    },
    markets: { "openai-bundled": "/bundled" },
    catalog: [{ id: "gmail@openai-curated" }],
  });
  // codex's own config: a comment, a marketplace, and the tables it writes for local plugins
  writeFileSync(join(h, ".codex/config.toml"), CODEX_CONFIG, { mode: 0o600 });
  const env = { HOME: h, KIT_CLAUDE: fakePluginCli(bin, "claude"), KIT_CODEX: fakePluginCli(bin, "codex"), FAKE_PLUGIN_LOG: log };
  const events: ServerEvent[] = [];
  const run = async (host: string | null, cmd: string[], o?: { env?: Record<string, string>; timeoutMs?: number }) =>
    host === "gpd" ? { code: 255, stdout: "", stderr: "# Tailscale SSH requires an additional check." } : exec(cmd, o);
  const hub = new KitHub({ self: "mac", devRoot: join(h, "dev"), kitPath, broadcast: (e) => events.push(e), run, env, every: 0, ...(opts.hostHome ? { hostHome: opts.hostHome } : {}) });
  hubs.push(hub);
  await hub.scan();
  const calls = () => readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as string[]);
  const settings = () => JSON.parse(readFileSync(join(store, "settings.json"), "utf8")) as typeof SETTINGS;
  const dirty = async () => (await exec(["git", "-C", store, "status", "--porcelain", "--", "settings.json"])).stdout.trim() !== "";
  return { h, hub, events, calls, settings, dirty, store };
}

const post = async (hub: KitHub, body: unknown): Promise<{ status: number; data: unknown }> => {
  const req = new Request("http://x/api/kit/plugins", { method: "POST", body: JSON.stringify(body) });
  const res = await hub.handle(req, new URL(req.url));
  if (!res) throw new Error("no response");
  return { status: res.status, data: await res.json() };
};

describe("the kit's plugins", () => {
  test("a scan reads each agent's plugins, marketplaces and settings, and that settings.json is shared and clean", async () => {
    const { hub } = await setup();
    const ps = hub.info().plugins ?? [];
    expect(ps.map((p) => [p.machine, p.away])).toEqual([["mac", null], ["gpd", "Tailscale SSH requires an additional check."]]);
    const mac = ps[0]!;
    expect([mac.shared, mac.settingsDirty, mac.commits]).toEqual([true, false, false]);
    const c = mac.agents.find((a) => a.agent === "claude")!;
    expect(c.plugins.map((p) => [p.id, p.enabled])).toEqual([["superpowers@official", true], ["context-mode@cm", false]]);
    expect(c.plugins[1]!.servers).toEqual({ "context-mode": "node server.mjs" });
    expect(c.markets).toEqual([{ name: "official", source: "anthropics/official" }]);
    expect(c.declared).toEqual(SETTINGS.enabledPlugins);
    expect(mac.agents.find((a) => a.agent === "codex")!.plugins.map((p) => p.id)).toEqual(["pdf@openai-bundled", "gmail@openai-curated-remote", "stuck@openai-bundled"]);
  });

  test("no plugins in kit.json: no plugin scan and no plugins in the info", async () => {
    const { hub, calls } = await setup({ plugins: [] });
    expect(hub.info().plugins).toBeUndefined();
    expect(() => calls()).toThrow();
  });

  test("on the shared settings.json, a machine that does not commit dotclaude refuses an edit and catches up with a declared plugin", async () => {
    const { hub, settings, dirty } = await setup();
    const refused = await post(hub, { machine: "mac", agent: "claude", op: "disable", id: "superpowers@official" });
    expect(refused.status).toBe(409);
    expect(String((refused.data as { error: string }).error)).toContain("kit.json machines.<name>.commits");
    const caught = (await post(hub, { machine: "mac", agent: "claude", op: "install", id: "remember@official" })).data as PluginOpResult;
    expect(caught.outcome).toBe("ok");
    expect(await dirty()).toBe(false);
    expect(settings()).toEqual(SETTINGS);
    expect(hub.info().plugins![0]!.agents[0]!.plugins.map((p) => p.id)).toContain("remember@official");
    expect((await post(hub, { machine: "mac", agent: "claude", op: "install", id: "fresh@official" })).status).toBe(409);
  });

  test("the machine that commits dotclaude edits it, and the view says settings.json changed", async () => {
    const { hub, settings, dirty } = await setup({ commits: true });
    const r = await hub.pluginOp({ machine: "mac", agent: "claude", op: "disable", id: "superpowers@official" });
    expect(r).toMatchObject({ outcome: "ok", op: "disable" });
    expect(settings().enabledPlugins["superpowers@official"]).toBe(false);
    expect(await dirty()).toBe(true);
    const mac = hub.info().plugins![0]!;
    expect(mac.settingsDirty).toBe(true);
    expect(mac.agents[0]!.plugins.find((p) => p.id === "superpowers@official")?.enabled).toBe(false);
    // turning off what is off is the op's goal
    expect((await hub.pluginOp({ machine: "mac", agent: "claude", op: "disable", id: "superpowers@official" })).outcome).toBe("ok");
    expect((await hub.pluginOp({ machine: "mac", agent: "claude", op: "uninstall", id: "context-mode@cm" })).outcome).toBe("ok");
    expect(hub.info().plugins![0]!.agents[0]!.plugins.map((p) => p.id)).toEqual(["superpowers@official"]);
  });

  test("a marketplace-declared command comes back to be shown, and runs once its sha256 is sent", async () => {
    const { hub, calls } = await setup({ commits: true });
    const first = await hub.pluginOp({ machine: "mac", agent: "claude", op: "install", id: "needs-cmd@official" });
    expect(first.outcome).toBe("confirm");
    if (first.outcome !== "confirm") return;
    expect(first.command).toBe("run-me");
    const installs = () => calls().filter((c) => c[2] === "install");
    expect(installs()).toEqual([["claude", "plugin", "install", "needs-cmd@official", "--scope", "user", "--json"]]);
    const second = await hub.pluginOp({ machine: "mac", agent: "claude", op: "install", id: "needs-cmd@official", accept: first.sha256 });
    expect(second.outcome).toBe("ok");
    expect(installs().at(-1)).toEqual(["claude", "plugin", "install", "needs-cmd@official", "--scope", "user", "--json", "--accept-command", first.sha256]);
  });

  test("codex: add and remove run through its CLI", async () => {
    const { hub } = await setup();
    const added = await hub.pluginOp({ machine: "mac", agent: "codex", op: "install", id: "gmail@openai-curated" });
    expect(added.outcome).toBe("ok");
    expect(hub.info().plugins![0]!.agents.find((a) => a.agent === "codex")!.plugins.map((p) => p.id))
      .toEqual(["pdf@openai-bundled", "gmail@openai-curated-remote", "stuck@openai-bundled", "gmail@openai-curated"]);
    expect((await post(hub, { machine: "mac", agent: "codex", op: "update", id: "pdf@openai-bundled" })).status).toBe(400);
  });

  test("codex's switch: the plugin's enabled line in config.toml, its mode kept, and nothing else touched", async () => {
    const { h, hub } = await setup();
    const file = join(h, ".codex/config.toml");
    const codexOf = () => hub.info().plugins![0]!.agents.find((a) => a.agent === "codex")!;
    expect(codexOf().plugins.find((p) => p.id === "gmail@openai-curated-remote")?.account).toBe(true);
    const off = await hub.pluginOp({ machine: "mac", agent: "codex", op: "disable", id: "pdf@openai-bundled" });
    expect(off).toMatchObject({ outcome: "ok", message: "turned off in config.toml" });
    expect(readFileSync(file, "utf8")).toBe(CODEX_CONFIG.replace('[plugins."pdf@openai-bundled"]\nenabled = true', '[plugins."pdf@openai-bundled"]\nenabled = false'));
    expect(statSync(file).mode & 0o777).toBe(0o600);
    // no copy of before and no temporary file is left beside it
    expect(readdirSync(join(h, ".codex")).sort()).toEqual(["config.toml", "skills"]);
    expect(codexOf().plugins.find((p) => p.id === "pdf@openai-bundled")?.enabled).toBe(false);
    expect((await hub.pluginOp({ machine: "mac", agent: "codex", op: "disable", id: "pdf@openai-bundled" })).message).toContain("already off");
    expect((await hub.pluginOp({ machine: "mac", agent: "codex", op: "enable", id: "pdf@openai-bundled" })).outcome).toBe("ok");
    expect(readFileSync(file, "utf8")).toBe(CODEX_CONFIG);
  });

  test("codex's switch is refused for the account's plugins and one not installed, and put back when codex does not follow it", async () => {
    const { h, hub } = await setup();
    const file = join(h, ".codex/config.toml");
    const remote = await post(hub, { machine: "mac", agent: "codex", op: "disable", id: "gmail@openai-curated-remote" });
    expect(remote.status).toBe(409);
    expect(String((remote.data as { error: string }).error)).toContain("ChatGPT account");
    expect((await post(hub, { machine: "mac", agent: "codex", op: "disable", id: "nope@openai-bundled" })).status).toBe(409);
    // codex lists it on whatever config.toml says: the edit goes back, byte for byte
    const stuck = await hub.pluginOp({ machine: "mac", agent: "codex", op: "disable", id: "stuck@openai-bundled" });
    expect(stuck.outcome).toBe("failed");
    expect(stuck.message).toBe("codex still lists stuck@openai-bundled on after the edit; config.toml is back as it was");
    expect(readFileSync(file, "utf8")).toBe(CODEX_CONFIG);
    expect(readdirSync(join(h, ".codex")).sort()).toEqual(["config.toml", "skills"]);
    // a plugin codex lists with no table of its own: nothing is added
    writeFileSync(file, CODEX_CONFIG.replace('[plugins."pdf@openai-bundled"]\nenabled = true\n', ""));
    const bare = await hub.pluginOp({ machine: "mac", agent: "codex", op: "disable", id: "pdf@openai-bundled" });
    expect(bare).toMatchObject({ outcome: "failed", message: 'config.toml has no [plugins."pdf@openai-bundled"] table' });
  });

  test("the catalog is read once, searched, and read again after an op", async () => {
    const { hub, calls } = await setup({ commits: true });
    const reads = () => calls().filter((c) => c.includes("--available")).length;
    const one = await hub.catalog("mac", "claude", "memory", 10);
    expect(one.entries.map((e) => [e.id, e.installed])).toEqual([["remember@official", false]]);
    await hub.catalog("mac", "claude", "", 2);
    expect(reads()).toBe(1);
    await hub.pluginOp({ machine: "mac", agent: "claude", op: "install", id: "remember@official" });
    const again: PluginCatalog = await hub.catalog("mac", "claude", "memory", 10);
    expect(reads()).toBe(2);
    expect(again.entries[0]!.installed).toBe(true);
    const req = new Request("http://x/api/kit/plugins/catalog?machine=mac&agent=claude&q=new&limit=5");
    const res = await hub.handle(req, new URL(req.url));
    expect(((await res!.json()) as PluginCatalog).entries.map((e) => e.id)).toEqual(["fresh@official"]);
  });

  test("details come back as plain text; an away machine and a bad request are refused", async () => {
    const { hub } = await setup();
    expect((await hub.details("mac", "claude", "superpowers@official")).text).toBe("superpowers@official 1.0.0\n  Skills (1)  one\n  MCP servers (0)");
    await expect(hub.details("gpd", "claude", "superpowers@official")).rejects.toThrow("gpd is away");
    expect((await post(hub, { machine: "mac", agent: "claude", op: "explode" })).status).toBe(400);
    expect((await post(hub, { machine: "mac", agent: "claude", op: "install", id: "-x@y" })).status).toBe(400);
  });

  test("where canopy's home is not the host's (the mini), claude runs under the host's home and records its paths", async () => {
    // the mini mounts the host's ~/.claude at both homes; the fake keeps its state beside it
    const host = mkdtempSync(join(tmpdir(), "kitplugins-host-"));
    dirs.push(host);
    const { h, hub } = await setup({ commits: true, hostHome: host });
    symlinkSync(join(h, ".claude"), join(host, ".claude"));
    symlinkSync(join(h, ".fake-claude-plugins.json"), join(host, ".fake-claude-plugins.json"));
    await hub.scan();
    const r = await hub.pluginOp({ machine: "mac", agent: "claude", op: "install", id: "fresh@official" });
    expect(r.outcome).toBe("ok");
    const j = JSON.parse(readFileSync(join(h, ".claude/plugins/installed_plugins.json"), "utf8")) as { plugins: Record<string, { installPath: string }[]> };
    expect(j.plugins["fresh@official"]![0]!.installPath).toBe(join(host, ".claude/plugins/cache/official/fresh/1.0.0"));
    // the scan reads claude under the host's home too, codex under its own
    const seen = hub.info().plugins?.find((m) => m.machine === "mac");
    expect(seen?.agents.find((a) => a.agent === "claude")?.plugins.map((p) => p.id)).toContain("fresh@official");
    expect(seen?.agents.find((a) => a.agent === "codex")?.plugins.map((p) => p.id)).toEqual(["pdf@openai-bundled", "gmail@openai-curated-remote", "stuck@openai-bundled"]);
  });
});

describe("committing dotclaude's settings.json", () => {
  /** the store with an upstream: a bare remote it pushes to, and a second clone that can move it ahead */
  async function remote(store: string, h: string) {
    const bare = join(h, "dotclaude.git");
    await exec(["git", "init", "-q", "--bare", "-b", "main", bare]);
    await exec(["git", "-C", store, "config", "user.name", "t"]);
    await exec(["git", "-C", store, "config", "user.email", "t@t"]);
    await exec(["git", "-C", store, "remote", "add", "origin", bare]);
    await exec(["git", "-C", store, "push", "-q", "-u", "origin", "main"]);
    const other = join(h, "other");
    await exec(["git", "clone", "-q", bare, other]);
    const ahead = async (file: string) => {
      await exec(["git", "-C", other, "pull", "-q", "--rebase"]);
      writeFileSync(join(other, file), "elsewhere");
      await exec(["git", "-C", other, "add", "."]);
      await exec(["git", "-C", other, "-c", "user.name=o", "-c", "user.email=o@o", "commit", "-qm", `add ${file}`]);
      await exec(["git", "-C", other, "push", "-q"]);
    };
    const log = async (dir: string) => (await exec(["git", "-C", dir, "log", "--format=%s", "origin/main"])).stdout.trim().split("\n");
    return { bare, ahead, log };
  }

  const preview = async (hub: KitHub, machine: string) => {
    const req = new Request(`http://x/api/kit/plugins/commit?machine=${machine}`);
    const res = await hub.handle(req, new URL(req.url));
    return { status: res!.status, data: (await res!.json()) as PluginCommitPreview & { lines: string[]; error?: string } };
  };
  const commit = async (hub: KitHub, body: unknown) => {
    const req = new Request("http://x/api/kit/plugins/commit", { method: "POST", body: JSON.stringify(body) });
    const res = await hub.handle(req, new URL(req.url));
    return { status: res!.status, data: (await res!.json()) as Record<string, unknown> };
  };

  test("the preview names what changed, never a value; the commit holds settings.json alone and pushes", async () => {
    const { h, hub, store, dirty } = await setup({ commits: true });
    const { log } = await remote(store, h);
    expect((await preview(hub, "mac")).data.error).toBe("mac's settings.json has nothing to commit");
    await hub.pluginOp({ machine: "mac", agent: "claude", op: "disable", id: "superpowers@official" });
    const s = JSON.parse(readFileSync(join(store, "settings.json"), "utf8")) as Record<string, unknown>;
    writeFileSync(join(store, "settings.json"), JSON.stringify({ ...s, env: { TOKEN: "s3cret" } }, null, 2));
    // another file changed and staged stays out of the commit
    writeFileSync(join(store, "notes.md"), "mine");
    await exec(["git", "-C", store, "add", "notes.md"]);
    const p = await preview(hub, "mac");
    expect(p.status).toBe(200);
    expect(p.data.change).toEqual({ on: [], off: ["superpowers@official"], dropped: [], marketsAdded: [], marketsRemoved: [], marketsChanged: [], other: ["env"] });
    expect(p.data.lines).toEqual(["turns off superpowers@official", "also changes env"]);
    expect(JSON.stringify(p.data)).not.toContain("s3cret");
    expect(p.data.message).toBe("settings.json: 2 changes\n\n- turn off superpowers@official\n- change env\n\nCommitted from canopy on mac.");
    const r = await commit(hub, { machine: "mac", sha: p.data.sha });
    expect(r.data).toMatchObject({ outcome: "pushed" });
    expect(await dirty()).toBe(false);
    expect((await log(store))[0]).toBe("settings.json: 2 changes");
    const shown = (await exec(["git", "-C", store, "show", "--name-only", "--format=", "HEAD"])).stdout.trim();
    expect(shown).toBe("settings.json");
    expect((await exec(["git", "-C", store, "diff", "--cached", "--name-only"])).stdout.trim()).toBe("notes.md");
    expect(hub.info().plugins![0]!.settingsDirty).toBe(false);
    expect(hub.info().plugins![0]!.unpushed).toBeUndefined();
  });

  test("bytes that changed since the preview, a machine that does not commit, and a bad request are refused", async () => {
    const { h, hub, store } = await setup({ commits: true });
    await remote(store, h);
    await hub.pluginOp({ machine: "mac", agent: "claude", op: "disable", id: "superpowers@official" });
    const p = await preview(hub, "mac");
    writeFileSync(join(store, "settings.json"), readFileSync(join(store, "settings.json"), "utf8") + "\n");
    const stale = await commit(hub, { machine: "mac", sha: p.data.sha });
    expect(stale.status).toBe(409);
    expect(stale.data["error"]).toBe("settings.json changed since it was shown; look at it again");
    expect((await commit(hub, { machine: "mac", sha: "nope" })).status).toBe(400);
    const { hub: other } = await setup();
    expect((await preview(other, "mac")).data.error).toContain("does not mark mac as the machine dotclaude is committed on");
  });

  test("a push turned away is rebased onto the remote and sent again, unless another tracked file is changed", async () => {
    const { h, hub, store } = await setup({ commits: true });
    const { ahead, log } = await remote(store, h);
    await ahead("a.md");
    await hub.pluginOp({ machine: "mac", agent: "claude", op: "disable", id: "superpowers@official" });
    const first = await commit(hub, { machine: "mac", sha: (await preview(hub, "mac")).data.sha });
    expect(first.data).toMatchObject({ outcome: "pushed" });
    expect((await log(store)).slice(0, 2)).toEqual(["settings.json: turn off superpowers@official", "add a.md"]);
    await ahead("b.md");
    await hub.pluginOp({ machine: "mac", agent: "claude", op: "enable", id: "superpowers@official" });
    writeFileSync(join(store, "skills/ship/SKILL.md"), "an edit of Eric's own");
    const second = await commit(hub, { machine: "mac", sha: (await preview(hub, "mac")).data.sha });
    expect(second.data["outcome"]).toBe("committed");
    expect(String(second.data["message"])).toContain("the push failed");
    // the checkout is not left mid-rebase, and the edit is where it was
    expect((await exec(["git", "-C", store, "status", "--porcelain", "--untracked-files=no"])).stdout.trim()).toBe("M skills/ship/SKILL.md");
    expect(readFileSync(join(store, "skills/ship/SKILL.md"), "utf8")).toBe("an edit of Eric's own");
    // the commit the remote lacks shows on the machine after the rescan
    expect(hub.info().plugins![0]!.unpushed).toBe(1);
  });
});
