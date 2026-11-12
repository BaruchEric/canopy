import { describe, expect, test } from "bun:test";
import { catalogLines, opLines, pluginLines } from "./plugins";
import type { PluginMachineSeen } from "../core/types";

const mac: PluginMachineSeen = {
  machine: "mac", at: 0, away: null, shared: true, settingsDirty: true, commits: true,
  agents: [{
    agent: "claude", path: "/c", error: null,
    plugins: [
      { id: "superpowers@o", version: "7.0.0", enabled: true, scope: "user", servers: {}, errors: [], notes: [] },
      { id: "context-mode@cm", version: null, enabled: false, scope: "user", servers: { "context-mode": "node s" }, errors: [], notes: [] },
    ],
    markets: [{ name: "o", source: "x/o" }],
    declared: { "superpowers@o": true, "remember@o": true, "off@o": false },
    declaredMarkets: {},
  }],
};

describe("canopy plugins", () => {
  test("a machine's lines: how it holds settings.json, each plugin, what settings.json wants, the marketplaces", () => {
    expect(pluginLines(mac, null)).toEqual([
      "mac  commits the shared settings.json, settings.json changed and not committed",
      "  claude  superpowers@o  on 7.0.0",
      "  claude  context-mode@cm  off  servers: context-mode",
      "  claude  remember@o  wanted: settings.json turns it on, not installed here",
      "  claude  marketplaces: o",
    ]);
    expect(pluginLines(mac, "codex")).toEqual(["mac  commits the shared settings.json, settings.json changed and not committed"]);
    expect(pluginLines({ ...mac, away: "no ssh" }, null)).toEqual(["mac  away: no ssh"]);
  });
  test("an op's line, and a command to accept", () => {
    expect(opLines({ machine: "mac", agent: "claude", op: "disable", outcome: "ok", message: "Successfully disabled" }, "superpowers@o"))
      .toEqual(["mac: turn off superpowers@o done: Successfully disabled"]);
    expect(opLines({ machine: "mac", agent: "claude", op: "install", outcome: "confirm", message: "", command: "npx x", sha256: "a".repeat(64) }, "x@o"))
      .toEqual(["mac: install x@o waits: the marketplace declares a command to run", "  npx x", `read it, then run the same command again with --accept ${"a".repeat(64)}`]);
  });
  test("a search's lines end with the count", () => {
    expect(catalogLines({ machine: "mac", agent: "claude", total: 2, entries: [{ id: "remember@o", name: "remember", marketplace: "o", description: "memory", version: null, installs: 5, installed: false }] }))
      .toEqual(["remember@o  5 installs  memory", "2 on mac for claude, 1 shown"]);
  });
});
