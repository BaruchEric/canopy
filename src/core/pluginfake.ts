/** Stand-ins for `claude plugin` and `codex plugin`, for tests only. Each
 *  appends its argv to $FAKE_PLUGIN_LOG as one JSON line and keeps its
 *  state in $HOME/.fake-<agent>-plugins.json:
 *  `{installed: {id: {enabled, version}}, markets: {name: source}, catalog: [{id, description, installs}]}`.
 *  The claude one edits $HOME/.claude/settings.json the way claude 2.1.322
 *  does (install and enable set enabledPlugins[id] true, disable false,
 *  uninstall drops it, a marketplace add of a source not declared adds it),
 *  and records installPaths under $HOME in installed_plugins.json. A
 *  catalog entry whose id starts `needs-cmd` asks for a command to be
 *  accepted, with the sha256 of "run-me". */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PluginAgent } from "./types";

const script = (agent: PluginAgent): string => `#!/usr/bin/env bun
const fs = require("node:fs");
const crypto = require("node:crypto");
const agent = ${JSON.stringify(agent)};
const args = process.argv.slice(2);
if (process.env.FAKE_PLUGIN_LOG) fs.appendFileSync(process.env.FAKE_PLUGIN_LOG, JSON.stringify([agent, ...args]) + "\\n");
const home = process.env.HOME;
const stateFile = home + "/.fake-" + agent + "-plugins.json";
const st = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, "utf8")) : {};
st.installed ??= {}; st.markets ??= {}; st.catalog ??= [];
const save = () => fs.writeFileSync(stateFile, JSON.stringify(st));
const settingsFile = home + "/.claude/settings.json";
const settings = () => (fs.existsSync(settingsFile) ? JSON.parse(fs.readFileSync(settingsFile, "utf8")) : {});
const writeSettings = (s) => fs.writeFileSync(settingsFile, JSON.stringify(s, null, 2));
const out = (o) => console.log(JSON.stringify(o));
const fail = (msg, code = 1, extra = {}) => { out({ outcome: "failed", message: msg, ...extra }); console.error("✘ " + msg); process.exit(code); };
const installedFile = home + "/.claude/plugins/installed_plugins.json";
const recordInstall = (id, version) => {
  if (agent !== "claude") return;
  fs.mkdirSync(home + "/.claude/plugins", { recursive: true });
  const j = fs.existsSync(installedFile) ? JSON.parse(fs.readFileSync(installedFile, "utf8")) : { version: 2, plugins: {} };
  const [name, mk] = id.split("@");
  j.plugins[id] = [{ scope: "user", installPath: home + "/.claude/plugins/cache/" + mk + "/" + name + "/" + version, version }];
  fs.writeFileSync(installedFile, JSON.stringify(j, null, 2) + "\\n");
};
if (args[0] !== "plugin") { console.error("usage"); process.exit(2); }
const sub = args[1];
const rest = args.slice(2).filter((a) => !a.startsWith("--") && a !== "user");
const json = args.includes("--json");
if (sub === "list") {
  const installed = Object.entries(st.installed).map(([id, p]) => agent === "claude"
    ? { id, version: p.version ?? "1.0.0", scope: "user", enabled: p.enabled, installPath: home + "/x", mcpServers: p.servers, errors: p.errors ?? null, notes: null }
    : { pluginId: id, name: id.split("@")[0], marketplaceName: id.split("@")[1], version: p.version ?? "1.0.0", installed: true, enabled: p.enabled });
  if (args.includes("--available")) {
    const available = st.catalog.map((c) => agent === "claude"
      ? { pluginId: c.id, name: c.id.split("@")[0], description: c.description ?? "", marketplaceName: c.id.split("@")[1], installCount: c.installs }
      : { pluginId: c.id, name: c.id.split("@")[0], marketplaceName: c.id.split("@")[1], installed: !!st.installed[c.id], enabled: !!st.installed[c.id] });
    out({ installed, available });
  } else out(agent === "claude" ? installed : { installed, available: [] });
  process.exit(0);
}
if (sub === "marketplace") {
  const op = args[2];
  const arg = args.slice(3).filter((a) => !a.startsWith("--") && a !== "user")[0];
  if (op === "list") {
    out(agent === "claude"
      ? Object.entries(st.markets).map(([name, source]) => ({ name, source: "github", repo: source }))
      : { marketplaces: Object.entries(st.markets).map(([name, source]) => ({ name, root: "/r/" + name, marketplaceSource: { sourceType: "git", source } })) });
    process.exit(0);
  }
  if (op === "add") {
    const name = arg.split("/").pop();
    st.markets[name] = arg; save();
    if (agent === "claude") {
      const s = settings(); s.extraKnownMarketplaces ??= {};
      const had = s.extraKnownMarketplaces[name];
      if (!had || had.source.repo !== arg) { s.extraKnownMarketplaces[name] = { source: { source: "github", repo: arg } }; writeSettings(s); }
    }
    out({ command: "marketplace-add", outcome: "ok", marketplace: name, message: "added " + name });
    process.exit(0);
  }
  if (op === "remove") {
    if (!st.markets[arg]) fail("Marketplace " + arg + " not found");
    delete st.markets[arg]; save();
    if (agent === "claude") { const s = settings(); if (s.extraKnownMarketplaces) { delete s.extraKnownMarketplaces[arg]; writeSettings(s); } }
    out({ outcome: "ok", message: "removed " + arg });
    process.exit(0);
  }
  if (op === "update" || op === "upgrade") { out({ outcome: "ok", message: "updated " + (arg ?? "all") }); process.exit(0); }
  console.error("usage"); process.exit(2);
}
const id = rest[0];
if (sub === "details") { console.log("\\u001b[1m" + id + "\\u001b[0m 1.0.0\\n  Skills (1)  one\\n  MCP servers (0)"); process.exit(0); }
const p = st.installed[id];
const goal = (msg) => { out({ command: sub, outcome: "failed", plugin: id, message: msg, failureCode: "already_in_goal_state", alreadyInGoalState: true }); process.exit(1); };
if (sub === "install" || sub === "add") {
  if (p) { out({ command: "install", outcome: "ok", plugin: id, message: "Plugin " + id + " is already installed" }); process.exit(0); }
  const c = st.catalog.find((x) => x.id === id);
  if (!c) fail("Plugin " + id + " not found in marketplace");
  if (id.startsWith("needs-cmd")) {
    const sha = crypto.createHash("sha256").update("run-me").digest("hex");
    const at = args.indexOf("--accept-command");
    if (at < 0 || args[at + 1] !== sha) fail("The marketplace declares a command to run", 1, { shownCommand: { command: "run-me", sha256: sha } });
  }
  st.installed[id] = { enabled: true, version: "1.0.0" }; save();
  recordInstall(id, "1.0.0");
  if (agent === "claude") { const s = settings(); s.enabledPlugins ??= {}; if (s.enabledPlugins[id] !== true) { s.enabledPlugins[id] = true; writeSettings(s); } }
  out({ command: "install", outcome: "ok", plugin: id, message: "Successfully installed plugin: " + id });
  process.exit(0);
}
if (!p) fail("Plugin " + id + " is not installed");
if (sub === "uninstall" || sub === "remove") {
  delete st.installed[id]; save();
  if (agent === "claude") { const s = settings(); if (s.enabledPlugins) { delete s.enabledPlugins[id]; writeSettings(s); } }
  out({ command: "uninstall", outcome: "ok", plugin: id, message: "Successfully uninstalled plugin: " + id });
  process.exit(0);
}
if (sub === "enable" || sub === "disable") {
  const want = sub === "enable";
  if (p.enabled === want) goal("Plugin " + id + " is already " + sub + "d");
  p.enabled = want; save();
  const s = settings(); s.enabledPlugins ??= {}; s.enabledPlugins[id] = want; writeSettings(s);
  out({ command: sub, outcome: "ok", plugin: id, message: "Successfully " + sub + "d plugin: " + id });
  process.exit(0);
}
if (sub === "update") { p.version = "1.1.0"; save(); recordInstall(id, "1.1.0"); out({ command: "update", outcome: "ok", plugin: id, message: "updated " + id }); process.exit(0); }
console.error("usage"); process.exit(2);
`;

/** writes the fake CLI for one agent into dir and returns its path */
export function fakePluginCli(dir: string, agent: PluginAgent): string {
  const path = join(dir, `fake-${agent}`);
  writeFileSync(path, script(agent), { mode: 0o755 });
  return path;
}

export interface FakePluginState {
  installed?: Record<string, { enabled: boolean; version?: string; servers?: Record<string, unknown>; errors?: string[] }>;
  markets?: Record<string, string>;
  catalog?: { id: string; description?: string; installs?: number }[];
}

/** seeds a fake's state under a home */
export function seedFakePlugins(home: string, agent: PluginAgent, state: FakePluginState): void {
  writeFileSync(join(home, `.fake-${agent}-plugins.json`), JSON.stringify(state));
}
