import { describe, expect, test } from "bun:test";
import {
  catalogOf, editsSettings, jsonOf, lastJsonObject, opArgs, outcomeOf, parseClaudeList, parseClaudeMarkets, parseCodexList, parseCodexMarkets,
  parseSettings, refusal, searchCatalog, serverLine, sourceProblem,
} from "./plugins";
import type { PluginAgentSeen, PluginMachineSeen } from "./types";

const claude = (over: Partial<PluginAgentSeen> = {}): PluginAgentSeen =>
  ({ agent: "claude", path: "/bin/claude", error: null, plugins: [], markets: [], declared: {}, declaredMarkets: {}, ...over });

const machine = (over: Partial<PluginMachineSeen> = {}): PluginMachineSeen =>
  ({ machine: "gpd", at: 0, away: null, shared: false, settingsDirty: false, commits: false, agents: [claude()], ...over });

describe("reading the CLIs", () => {
  test("claude's list: id, state, scope, servers as command lines, errors and notes", () => {
    const list = parseClaudeList([
      { id: "context-mode@context-mode", version: "2.1.8", scope: "user", enabled: false, mcpServers: { "context-mode": { command: "node", args: ["${CLAUDE_PLUGIN_ROOT}/server.mjs"] } }, errors: null, notes: null },
      { id: "vercel@claude-plugins-official", enabled: true, errors: ["x"], notes: ["run update"] },
      { version: "no id" },
    ]);
    expect(list).toEqual([
      { id: "context-mode@context-mode", version: "2.1.8", enabled: false, scope: "user", servers: { "context-mode": "node ${CLAUDE_PLUGIN_ROOT}/server.mjs" }, errors: [], notes: [] },
      { id: "vercel@claude-plugins-official", version: null, enabled: true, scope: null, servers: {}, errors: ["x"], notes: ["run update"] },
    ]);
    expect(parseClaudeList({})).toBeNull();
  });
  test("codex's list: the installed ones, enabled unless it says not", () => {
    expect(parseCodexList({ installed: [{ pluginId: "pdf@openai-bundled", version: "1", installed: true, enabled: true }, { pluginId: "x@y", installed: false }], available: [] }))
      .toEqual([{ id: "pdf@openai-bundled", version: "1", enabled: true, scope: null, servers: {}, errors: [], notes: [] }]);
    expect(parseCodexList([])).toBeNull();
  });
  test("marketplaces: claude's repo, url or path; codex's marketplaceSource or root", () => {
    expect(parseClaudeMarkets([{ name: "a", repo: "o/a" }, { name: "b", path: "/p" }, { name: "c" }])).toEqual([
      { name: "a", source: "o/a" }, { name: "b", source: "/p" }, { name: "c", source: "" },
    ]);
    expect(parseCodexMarkets({ marketplaces: [{ name: "x", root: "/r", marketplaceSource: { sourceType: "git", source: "o/x" } }, { name: "y", root: "/ry" }] }))
      .toEqual([{ name: "x", source: "o/x" }, { name: "y", source: "/ry" }]);
  });
  test("settings: enabledPlugins and extraKnownMarketplaces' sources; a file that does not parse reads empty", () => {
    expect(parseSettings(JSON.stringify({ enabledPlugins: { "a@m": true, "b@m": false, "c@m": "yes" }, extraKnownMarketplaces: { m: { source: { source: "github", repo: "o/m" } }, d: { source: { source: "directory", path: "/x" } } } })))
      .toEqual({ declared: { "a@m": true, "b@m": false }, declaredMarkets: { m: "o/m", d: "/x" } });
    expect(parseSettings("{")).toEqual({ declared: {}, declaredMarkets: {} });
  });
  test("json after a warning line, and the last result line", () => {
    expect(jsonOf("warning: old node\n[1, 2]")).toEqual([1, 2]);
    expect(jsonOf("")).toBeUndefined();
    expect(lastJsonObject('Cloning...\n{"outcome":"ok"}\n')).toEqual({ outcome: "ok" });
    expect(serverLine({ type: "http", url: "https://x/mcp" })).toBe("https://x/mcp");
  });
});

describe("what an op may do where", () => {
  test("an op edits settings.json unless it installs a plugin already enabled there or adds a marketplace it declares", () => {
    const a = claude({ declared: { "a@m": true, "b@m": false }, declaredMarkets: { m: "o/m" } });
    expect(editsSettings(a, "install", "a@m")).toBe(false);
    expect(editsSettings(a, "install", "b@m")).toBe(true);
    expect(editsSettings(a, "update", "a@m")).toBe(false);
    expect(editsSettings(a, "enable", "a@m")).toBe(true);
    expect(editsSettings(a, "market-add", undefined, "o/m")).toBe(false);
    expect(editsSettings(a, "market-add", undefined, "o/n")).toBe(true);
    expect(editsSettings({ ...a, agent: "codex" }, "uninstall", "a@m")).toBe(false);
  });
  test("a machine on the shared settings.json that does not commit dotclaude refuses an edit and names where to make it", () => {
    const m = machine({ shared: true, agents: [claude({ declared: { "a@m": true } })] });
    expect(refusal(m, { agent: "claude", op: "disable", id: "a@m" }, ["mac"])).toContain("Make it on mac");
    expect(refusal(m, { agent: "claude", op: "install", id: "a@m" }, ["mac"])).toBeNull();
    expect(refusal(m, { agent: "claude", op: "update", id: "a@m" }, ["mac"])).toBeNull();
    expect(refusal({ ...m, commits: true }, { agent: "claude", op: "disable", id: "a@m" }, ["mac"])).toBeNull();
    expect(refusal({ ...m, shared: false }, { agent: "claude", op: "disable", id: "a@m" }, [])).toBeNull();
    expect(refusal(m, { agent: "claude", op: "disable", id: "a@m" }, [])).toContain("none is marked");
  });
  test("away, a missing CLI, an agent the kit does not read, and codex's missing toggle", () => {
    expect(refusal(machine({ away: "no ssh" }), { agent: "claude", op: "update", id: "a@m" }, [])).toBe("gpd is away: no ssh");
    expect(refusal(machine({ agents: [claude({ path: null })] }), { agent: "claude", op: "update", id: "a@m" }, [])).toBe("claude is not installed on gpd");
    expect(refusal(machine(), { agent: "codex", op: "install", id: "a@m" }, [])).toContain("does not read codex");
    const cx = machine({ agents: [{ ...claude(), agent: "codex" }] });
    expect(refusal(cx, { agent: "codex", op: "disable", id: "a@m" }, [])).toContain("no command that turns a plugin off");
    expect(refusal(cx, { agent: "codex", op: "install", id: "a@m" }, [])).toBeNull();
  });
  test("argv: claude's ops name the user scope; codex's use add, remove and upgrade; bad names and sources are refused", () => {
    expect(opArgs({ agent: "claude", op: "install", id: "a@m" })).toEqual(["plugin", "install", "a@m", "--scope", "user", "--json"]);
    expect(opArgs({ agent: "claude", op: "install", id: "a@m", accept: "a".repeat(64) })).toEqual(["plugin", "install", "a@m", "--scope", "user", "--json", "--accept-command", "a".repeat(64)]);
    expect(opArgs({ agent: "claude", op: "market-add", source: "o/m" })).toEqual(["plugin", "marketplace", "add", "o/m", "--scope", "user", "--json"]);
    expect(opArgs({ agent: "codex", op: "uninstall", id: "a@m" })).toEqual(["plugin", "remove", "a@m", "--json"]);
    expect(opArgs({ agent: "codex", op: "market-update", name: "m" })).toEqual(["plugin", "marketplace", "upgrade", "m", "--json"]);
    expect(opArgs({ agent: "claude", op: "install", id: "--evil@m" })).toEqual({ error: "a plugin is named name@marketplace" });
    expect(opArgs({ agent: "claude", op: "install", id: "a" })).toEqual({ error: "a plugin is named name@marketplace" });
    expect(opArgs({ agent: "claude", op: "market-add", source: "--upload-pack=x" })).toEqual({ error: "a source cannot start with -" });
    expect(opArgs({ agent: "claude", op: "install", id: "a@m", accept: "nope" })).toEqual({ error: "accept is the sha256 the CLI showed" });
    expect(sourceProblem("a\nb")).toBe("a source is one line");
  });
});

describe("outcomes", () => {
  test("claude's result line decides; already enabled is the goal and reads ok", () => {
    expect(outcomeOf("claude", 0, '{"outcome":"ok","message":"Successfully enabled"}', "")).toEqual({ outcome: "ok", message: "Successfully enabled" });
    expect(outcomeOf("claude", 1, '{"outcome":"failed","message":"already enabled","alreadyInGoalState":true}', "✘ x")).toEqual({ outcome: "ok", message: "already enabled" });
    expect(outcomeOf("claude", 1, '{"outcome":"failed","message":"not found"}', "")).toEqual({ outcome: "failed", message: "not found" });
    expect(outcomeOf("claude", 1, "", "✘ Failed to install: nope\n")).toEqual({ outcome: "failed", message: "Failed to install: nope" });
  });
  test("a marketplace-declared command comes back to be shown and accepted", () => {
    const sha = "b".repeat(64);
    expect(outcomeOf("claude", 1, JSON.stringify({ outcome: "failed", message: "confirm", shownCommand: { command: "npx thing", sha256: sha } }), ""))
      .toEqual({ outcome: "confirm", message: "confirm", command: "npx thing", sha256: sha });
  });
  test("codex: the exit code", () => {
    expect(outcomeOf("codex", 0, '{"message":"added"}', "")).toEqual({ outcome: "ok", message: "added" });
    expect(outcomeOf("codex", 2, "", "error: no such plugin")).toEqual({ outcome: "failed", message: "error: no such plugin" });
  });
});

describe("the catalog", () => {
  const all = catalogOf("claude", {
    installed: [{ id: "remember@o" }],
    available: [
      { pluginId: "remember@o", name: "remember", description: "Continuous memory for Claude Code", marketplaceName: "o", installCount: 50 },
      { pluginId: "asana@o", name: "asana", description: "Connects Claude Code to Asana", marketplaceName: "o", installCount: 900 },
      { pluginId: "carbone@o", name: "carbone", description: "templating language reference", marketplaceName: "o" },
      { pluginId: "not an id", name: "x" },
    ],
  });
  test("reads the entries and marks what is installed", () => {
    expect(all.map((e) => [e.id, e.installed, e.installs])).toEqual([["remember@o", true, 50], ["asana@o", false, 900], ["carbone@o", false, null]]);
  });
  test("every word must match; the most installed first; the limit cuts after counting", () => {
    expect(searchCatalog(all, "memory", 10).entries.map((e) => e.id)).toEqual(["remember@o"]);
    expect(searchCatalog(all, "templat", 10).entries.map((e) => e.id)).toEqual(["carbone@o"]);
    expect(searchCatalog(all, "", 1)).toEqual({ total: 3, entries: [all[1]!] });
    expect(searchCatalog(all, "claude code", 10).entries.map((e) => e.id)).toEqual(["asana@o", "remember@o"]);
  });
});
