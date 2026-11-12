import { describe, expect, test } from "bun:test";
import { cellOf, cellOps, declaredOnly, isFolder, marketGap, mergePlugins, sheetColumns, missingMarket, pluginColumns, pluginRows, routeOf, serversOf, type PluginMachine } from "./plugins";
import type { KitInfo, PluginAgentSeen, PluginMachineSeen } from "../../src/core/types";

const claude = (over: Partial<PluginAgentSeen> = {}): PluginAgentSeen =>
  ({ agent: "claude", path: "/c", error: null, plugins: [], markets: [], declared: {}, declaredMarkets: {}, ...over });

const seen = (machine: string, over: Partial<PluginMachineSeen> = {}): PluginMachineSeen =>
  ({ machine, at: 0, away: null, shared: false, settingsDirty: false, commits: false, agents: [claude()], ...over });

const info = (plugins: PluginMachineSeen[]): KitInfo => ({ ok: true, error: null, machines: [], cells: [], plugins });

const sp = { id: "superpowers@o", version: "7", enabled: true, scope: "user", servers: {}, errors: [], notes: [] };
const cm = { id: "context-mode@cm", version: "2", enabled: false, scope: "user", servers: { "context-mode": "node s.mjs" }, errors: [], notes: [] };

const ms: PluginMachine[] = mergePlugins({
  mac: info([
    seen("mac", { shared: true, commits: true, agents: [claude({ plugins: [sp, cm], declared: { "superpowers@o": true, "homelab@homelab": true }, markets: [{ name: "o", source: "x/o" }] }), { ...claude(), agent: "codex" }] }),
    seen("gpd", { shared: true, agents: [claude({ plugins: [], declared: { "superpowers@o": true, "homelab@homelab": true }, markets: [{ name: "o", source: "x/o" }], declaredMarkets: { homelab: "/Users/e/dev/homelab", o: "x/o" } })] }),
    seen("wsl", { away: "no ssh" }),
  ]),
  mini: info([seen("mini", { agents: [claude({ plugins: [{ ...sp, errors: ["skills load failed"] }] })] })]),
});

describe("the plugins view's cells", () => {
  test("machines merge from every backend; an away machine makes no column", () => {
    expect(ms.map((m) => [m.machine, m.backend])).toEqual([["gpd", "mac"], ["mac", "mac"], ["mini", "mini"], ["wsl", "mac"]]);
    expect(pluginColumns(ms, { agent: null, machine: null })).toEqual([
      { machine: "gpd", agent: "claude" }, { machine: "mac", agent: "claude" }, { machine: "mac", agent: "codex" }, { machine: "mini", agent: "claude" },
    ]);
    expect(pluginColumns(ms, { agent: "codex", machine: null })).toEqual([{ machine: "mac", agent: "codex" }]);
  });
  test("on, off, wanted (turned on in settings.json, not installed), broken, none, and an agent the machine lacks", () => {
    const at = (machine: string, id: string, agent: "claude" | "codex" = "claude") => cellOf(ms, { machine, agent }, id).state;
    expect(at("mac", "superpowers@o")).toBe("on");
    expect(at("mac", "context-mode@cm")).toBe("off");
    expect(at("gpd", "superpowers@o")).toBe("wanted");
    expect(at("mini", "superpowers@o")).toBe("broken");
    expect(at("mini", "context-mode@cm")).toBe("none");
    expect(at("wsl", "superpowers@o")).toBe("noagent");
  });
  test("rows: installed or turned on anywhere; filtered by text (a server's name too) and by problems", () => {
    const cols = pluginColumns(ms, { agent: null, machine: null });
    expect(pluginRows(ms, cols, { agent: null, machine: null, problems: false, text: "" })).toEqual(["context-mode@cm", "homelab@homelab", "superpowers@o"]);
    expect(pluginRows(ms, cols, { agent: null, machine: null, problems: false, text: "context" })).toEqual(["context-mode@cm"]);
    expect(pluginRows(ms, cols, { agent: null, machine: null, problems: true, text: "" })).toEqual(["homelab@homelab", "superpowers@o"]);
    expect(serversOf(ms, "context-mode@cm")).toEqual({ "context-mode": "node s.mjs" });
  });
  test("ops a cell offers; codex has no update, and no switch for the account's plugins", () => {
    expect(cellOps(cellOf(ms, { machine: "mac", agent: "claude" }, "superpowers@o"), "claude")).toEqual(["disable", "update", "uninstall"]);
    expect(cellOps({ state: "on", plugin: { ...sp, scope: null }, why: "" }, "codex")).toEqual(["disable", "uninstall"]);
    expect(cellOps({ state: "off", plugin: { ...sp, enabled: false, scope: null }, why: "" }, "codex")).toEqual(["enable", "uninstall"]);
    expect(cellOps({ state: "on", plugin: { ...sp, account: true }, why: "" }, "codex")).toEqual(["uninstall"]);
    expect(cellOps({ state: "wanted", plugin: null, why: "" }, "claude")).toEqual(["install"]);
  });
});

describe("where an op runs", () => {
  test("an edit on a machine reading the shared settings.json moves to the machine that commits dotclaude", () => {
    const gpd = ms.find((m) => m.machine === "gpd")!;
    expect(routeOf(ms, gpd, { agent: "claude", op: "disable", id: "superpowers@o" })).toMatchObject({ machine: { machine: "mac" }, moved: true });
    expect(routeOf(ms, gpd, { agent: "claude", op: "install", id: "superpowers@o" })).toMatchObject({ machine: { machine: "gpd" }, moved: false });
    const mini = ms.find((m) => m.machine === "mini")!;
    expect(routeOf(ms, mini, { agent: "claude", op: "disable", id: "superpowers@o" })).toMatchObject({ machine: { machine: "mini" }, moved: false });
    expect(routeOf(ms, mini, { agent: "codex", op: "install", id: "a@b" })).toEqual({ why: "the kit does not read codex's plugins on mini" });
  });
  test("only a refusal over the shared settings.json moves: codex's config and a missing CLI stay the machine's own", () => {
    const local = { ...sp, id: "pdf@b", scope: null };
    const two: PluginMachine[] = [
      { ...seen("mac", { shared: true, commits: true, agents: [claude(), { ...claude(), agent: "codex", plugins: [local] }] }), backend: "mac" },
      { ...seen("gpd", { shared: true, agents: [claude({ path: null }), { ...claude(), agent: "codex", plugins: [] }] }), backend: "mac" },
    ];
    const gpd = two[1]!;
    expect(routeOf(two, gpd, { agent: "codex", op: "disable", id: "pdf@b" })).toEqual({ why: "pdf@b is not installed for codex on gpd" });
    expect(routeOf(two, gpd, { agent: "claude", op: "disable", id: "superpowers@o" })).toEqual({ why: "claude is not installed on gpd" });
  });
  test("a wanted plugin's marketplace that is not added here, and whether its source is a folder elsewhere", () => {
    expect(missingMarket(ms, { machine: "gpd", agent: "claude" }, "homelab@homelab")).toEqual({ name: "homelab", source: "/Users/e/dev/homelab" });
    expect(missingMarket(ms, { machine: "gpd", agent: "claude" }, "superpowers@o")).toBeNull();
    expect(isFolder("/Users/e/dev/homelab")).toBe(true);
    expect(isFolder("anthropics/claude-plugins-official")).toBe(false);
    expect(declaredOnly(ms.find((m) => m.machine === "gpd")!.agents[0]!)).toEqual([{ name: "homelab", source: "/Users/e/dev/homelab" }]);
  });
  test("an install needs its marketplace, listed or with a plugin from it installed", () => {
    const col = { machine: "mini", agent: "claude" as const };
    expect(marketGap(ms, col, cellOf(ms, col, "context-mode@cm"), "context-mode@cm")).toEqual({ name: "cm", source: "" });
    expect(marketGap(ms, col, cellOf(ms, col, "fresh@o"), "fresh@o")).toBeNull();
    const mac = { machine: "mac", agent: "claude" as const };
    expect(marketGap(ms, mac, cellOf(ms, mac, "context-mode@cm"), "context-mode@cm")).toBeNull();
    expect(marketGap(ms, mac, cellOf(ms, mac, "other@cm"), "other@cm")).toBeNull();
    expect(sheetColumns(ms, pluginColumns(ms, { agent: null, machine: null }), "context-mode@cm")).toEqual([
      { machine: "gpd", agent: "claude" }, { machine: "mac", agent: "claude" }, { machine: "mini", agent: "claude" },
    ]);
    const codex = { machine: "mac", agent: "codex" as const };
    expect(marketGap(ms, codex, cellOf(ms, codex, "gmail@openai-curated"), "gmail@openai-curated")).toEqual({ name: "openai-curated", source: "" });
  });
});
