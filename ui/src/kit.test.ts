import { describe, expect, test } from "bun:test";
import { adoptableIn, allowAct, cellAt, columns, homesFor, mcpViewsOf, mergeKit, rows, serverAt, serverRows, sheetFor, sheetKey } from "./kit";
import { parseAct } from "../../src/core/secretwire";
import type { KitCell, KitInfo, KitMachineView, KitMcpView } from "../../src/core/types";

const c = (machine: string, agent: string, skill: string, state: KitCell["state"]): KitCell => ({ machine, agent, skill, state, why: "" });
const info = (cells: KitCell[]): KitInfo => ({ ok: true, error: null, machines: [], cells });

describe("kit view helpers", () => {
  const byBackend = {
    mac: info([c("mac", "claude", "ship", "ok"), c("mac", "codex", "ship", "missing"), c("gpd", "claude", "*", "away")]),
    mini: info([c("mini", "claude", "ship", "ok"), c("mini", "hermes", "omarchy", "local")]),
    broken: { ok: false, error: "kit.json: bad", machines: [], cells: [] },
  };
  test("mergeKit keeps every backend's cells and lists the errors", () => {
    const m = mergeKit(byBackend);
    expect(m.cells).toHaveLength(5);
    expect(m.errors).toEqual([{ backend: "broken", error: "kit.json: bad" }]);
  });
  test("columns: machine then agent, claude first in each", () => {
    expect(columns(mergeKit(byBackend).cells)).toEqual([
      { machine: "gpd", agent: "claude" },
      { machine: "mac", agent: "claude" }, { machine: "mac", agent: "codex" },
      { machine: "mini", agent: "claude" }, { machine: "mini", agent: "hermes" },
    ]);
  });
  test("rows: skills sorted, filtered by problems and text, never the away row", () => {
    const cells = mergeKit(byBackend).cells;
    const all = { agent: null, machine: null, problems: false, text: "" };
    expect(rows(cells, all)).toEqual(["omarchy", "ship"]);
    expect(rows(cells, { ...all, problems: true })).toEqual(["ship"]);
    expect(rows(cells, { ...all, text: "oma" })).toEqual(["omarchy"]);
    expect(rows(cells, { ...all, agent: "hermes" })).toEqual(["omarchy"]);
  });
  test("cellAt", () => {
    expect(cellAt(mergeKit(byBackend).cells, "ship", "mac", "codex")?.state).toBe("missing");
    expect(cellAt(mergeKit(byBackend).cells, "ship", "mini", "hermes")).toBeNull();
  });
});

describe("server rows", () => {
  const s = (machine: string, agent: string, name: string, state: KitCell["state"]): KitCell => ({ ...c(machine, agent, name, state), kind: "mcp" });
  const cells = [c("mac", "claude", "ship", "ok"), s("mac", "claude", "github", "adoptable"), s("mac", "codex", "github", "missing"), s("mac", "claude", "ship", "local")];
  const all = { agent: null, machine: null, problems: false, text: "" };
  test("skills and servers keep to their own tables, even with one name", () => {
    expect(rows(cells, all)).toEqual(["ship"]);
    expect(serverRows(cells, all)).toEqual(["github", "ship"]);
    expect(cellAt(cells, "ship", "mac", "claude")?.state).toBe("ok");
    expect(serverAt(cells, "ship", "mac", "claude")?.state).toBe("local");
  });
  test("adoptableIn lists one column's adoptable servers", () => {
    expect(adoptableIn(cells, "mac", "claude")).toEqual(["github"]);
    expect(adoptableIn(cells, "mac", "codex")).toEqual([]);
  });
  test("the allow act carries every machine's home, and parses as the service will read it", () => {
    const v: KitMcpView = { name: "github", def: { command: "bunx", args: ["-y", "@modelcontextprotocol/server-github"], url: null, env: ["GITHUB_PERSONAL_ACCESS_TOKEN"], headers: [] }, hash: "a".repeat(64), env: { GITHUB_PERSONAL_ACCESS_TOKEN: "gh_token" }, headers: {}, machines: ["mac", "mini", "gpd"] };
    const view = (machine: string, home?: string): KitMachineView => ({ machine, seen: { machine, at: 1, away: null, home: "", store: null, targets: [], sources: {} }, plan: [], ...(home ? { home } : {}) });
    expect(homesFor(v, [view("mac", "/Users/e")])).toEqual({ why: "No home known yet for mini, gpd; rescan." });
    // gpd's home comes from the Mac's ssh scan of it (phase 3)
    const h = homesFor(v, [view("mac", "/Users/e"), view("mini", "/home/eric"), view("gpd", "/home/eric")]);
    if (!("homes" in h)) throw new Error("no homes");
    const act = allowAct(v, h.homes);
    expect(parseAct(act)).toEqual(act);
    expect(mcpViewsOf({ mac: { ...info([]), mcp: [v] }, mini: { ...info([]), mcp: [v] } })).toEqual([v]);
  });
  test("a backend from before machine homes needs the new build, and backends that hash a server apart block its allow (final review 7)", () => {
    const v: KitMcpView = { name: "github", def: { command: "bunx", args: [], url: null, env: ["T"], headers: [] }, hash: "a".repeat(64), env: { T: "gh_token" }, headers: {}, machines: ["mac", "mini"] };
    const view = (machine: string, home?: string): KitMachineView => ({ machine, seen: { machine, at: 1, away: null, home: "", store: null, targets: [], sources: {} }, plan: [], ...(home ? { home } : {}) });
    expect(homesFor(v, [view("mac", "/Users/e"), view("mini")])).toEqual({ why: "The backend for mini reports no home, so it runs an older canopy; update it to the new build, then allow." });
    const older = { ...v, hash: "b".repeat(64), def: { ...v.def, args: ["-y"] } };
    expect(mcpViewsOf({ mac: { ...info([]), mcp: [v] }, mini: { ...info([]), mcp: [older] } })).toEqual([{ ...v, split: ["mac", "mini"] }]);
  });
});

describe("server sheets", () => {
  const s = (state: KitCell["state"], restore?: boolean): KitCell => ({ ...c("mac", "claude", "github", state), kind: "mcp", ...(restore ? { restore } : {}) });
  test("each sheet has its own key, so a sheet for another server or column starts fresh", () => {
    expect(sheetKey({ kind: "allow", name: "github" })).not.toBe(sheetKey({ kind: "allow", name: "wiki-memory" }));
    expect(sheetKey({ kind: "adopt", machine: "mac", agent: "claude", names: ["a"] })).not.toBe(sheetKey({ kind: "adopt", machine: "mac", agent: "codex", names: ["a"] }));
    expect(sheetKey({ kind: "adopt", machine: "mac", agent: "claude", names: ["a"] })).not.toBe(sheetKey({ kind: "adopt", machine: "mac", agent: "claude", names: ["a", "b"] }));
    expect(sheetKey({ kind: "restore", machine: "mac", agent: "claude", name: "a" })).not.toBe(sheetKey({ kind: "adopt", machine: "mac", agent: "claude", names: ["a"] }));
    expect(sheetKey({ kind: "allow", name: "github" })).toBe(sheetKey({ kind: "allow", name: "github" }));
  });
  test("a cell opens the sheet its state calls for, and an allow only when the kit has the server's view", () => {
    expect(sheetFor(null, "github", true)).toBeNull();
    expect(sheetFor(s("adoptable"), "github", true)).toEqual({ kind: "adopt", machine: "mac", agent: "claude", names: ["github"] });
    expect(sheetFor(s("ok", true), "github", true)).toEqual({ kind: "restore", machine: "mac", agent: "claude", name: "github" });
    expect(sheetFor(s("not-allowed"), "github", true)).toEqual({ kind: "allow", name: "github" });
    expect(sheetFor(s("stale-allowance"), "github", true)).toEqual({ kind: "allow", name: "github" });
    expect(sheetFor(s("not-allowed"), "github", false)).toBeNull();
    expect(sheetFor(s("ok"), "github", true)).toBeNull();
  });
});
