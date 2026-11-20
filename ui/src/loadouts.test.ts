import { describe, expect, test } from "bun:test";
import type { Loadout, Mention, ProviderView } from "../../src/core/types";
import { equipFrom, equipTitle, fromWord, inheritedLabel, loadoutLabel, loadoutsFor, pluginLine, providersFor, serversHere, skillRows } from "./loadouts";

const L = (over: Partial<Loadout>): Loadout => ({ name: "x", note: "", harness: "claude", model: "default", effort: "default", skills: [], mcp: [], canopyTools: false, ...over });

describe("loadouts in the page", () => {
  test("a label names the model and effort only when they are not the default", () => {
    expect(loadoutLabel(L({ name: "homelab-ops", model: "sonnet", effort: "medium" }))).toBe("homelab-ops (sonnet, medium)");
    expect(loadoutLabel(L({ name: "docs" }))).toBe("docs");
    expect(loadoutLabel(L({ name: "fast", harness: "codex", model: "gpt-5.5" }))).toBe("fast (codex, gpt-5.5)");
  });
  test("a run's equip as a title, one line each", () => {
    expect(equipTitle({ loadout: "homelab-ops", model: "sonnet", effort: "medium", skills: ["homelab:tailchan"], mcp: ["executor"], off: 42 }))
      .toBe("loadout homelab-ops\nsonnet, medium\nskills: homelab:tailchan\nservers: executor\n42 skills off");
  });
  test("the plugins a run went without get a line of their own", () => {
    expect(equipTitle({ loadout: "docs", model: "haiku", effort: "default", skills: [], mcp: [], off: 40, pluginsOff: ["vercel", "firebase"] }))
      .toBe("loadout docs\nhaiku\n40 skills off\nplugins off: vercel, firebase");
    expect(equipTitle({ loadout: "docs", model: "default", effort: "default", skills: [], mcp: [], off: 0, pluginsOff: [] })).toBe("loadout docs");
  });
  test("a propose is offered no codex loadout; the other actions all of them", () => {
    const all = [L({ name: "docs" }), L({ name: "fast", harness: "codex" })];
    expect(loadoutsFor("propose", all).map((l) => l.name)).toEqual(["docs"]);
    expect(loadoutsFor("ask", all).map((l) => l.name)).toEqual(["docs", "fast"]);
    expect(loadoutsFor("ask", undefined)).toEqual([]);
  });
  test("an equip with nothing set leaves those lines out", () => {
    expect(equipTitle({ loadout: "docs", model: "default", effort: "default", skills: [], mcp: [], off: 0 })).toBe("loadout docs");
  });
  test("equipFrom keeps only what differs from the loadout", () => {
    const quick = L({ name: "quick", model: "haiku", effort: "low", skills: ["a", "b"], mcp: ["x"] });
    const same = { model: "haiku", effort: "low", skills: ["a", "b"], mcp: ["x"] };
    expect(equipFrom(quick, same)).toEqual({ loadout: "quick" });
    expect(equipFrom(quick, { ...same, model: "sonnet" })).toEqual({ loadout: "quick", model: "sonnet" });
    expect(equipFrom(quick, { ...same, skills: ["b", "a"] })).toEqual({ loadout: "quick" });
    expect(equipFrom(quick, { ...same, effort: "high", skills: ["a"], mcp: [] })).toEqual({ loadout: "quick", effort: "high", skills: ["a"], mcp: [] });
  });
  const W = (over: Partial<Mention>): Mention => ({ name: "x", kind: "skill", harness: "claude", from: "user", description: "d", ...over });
  const sp = W({ name: "superpowers:brainstorming", from: "plugin:superpowers", plugin: "superpowers@m", description: "plan" });
  test("a plugin wildcard in the kit base marks that plugin's skills covered and locked", () => {
    const rows = skillRows([sp, W({ name: "unslop" }), W({ name: "commit", kind: "command" })], "", [], ["superpowers:*"]);
    expect(rows.map((r) => [r.name, r.on, r.locked])).toEqual([["superpowers:brainstorming", true, true], ["unslop", false, false]]);
  });
  test("a plugin wildcard among the picks covers it too, and a listed skill is on but not locked", () => {
    expect(skillRows([sp], "", ["superpowers:*"], [])[0]).toMatchObject({ on: true, locked: true });
    expect(skillRows([W({ name: "unslop" })], "", ["unslop"], [])[0]).toMatchObject({ on: true, locked: false });
  });
  test("the find box narrows the rows by name or description", () => {
    expect(skillRows([sp, W({ name: "unslop", description: "prose" })], "PROSE", [], []).map((r) => r.name)).toEqual(["unslop"]);
  });
  test("a plugin skill's line says checking it turns on the whole plugin", () => {
    expect(pluginLine(sp)).toBe("Checking it turns on the whole superpowers plugin.");
    expect(pluginLine(W({ name: "unslop" }))).toBeNull();
    expect(skillRows([sp], "", [], [])[0]?.plugin).toBe("Checking it turns on the whole superpowers plugin.");
  });
  test("a server this backend refuses is left out of the saved equip", () => {
    const quick = L({ name: "quick", mcp: ["github", "executor"] });
    const servers = [{ name: "github", here: true }, { name: "executor", here: false }];
    const here = serversHere(quick.mcp, servers);
    expect(here).toEqual(["github"]);
    expect(equipFrom(quick, { model: "default", effort: "default", skills: [], mcp: here })).toEqual({ loadout: "quick", mcp: ["github"] });
  });
});

describe("inherited loadouts (FR-069)", () => {
  test("where a loadout came from, in words", () => {
    expect(fromWord({ from: "repo", key: "dev-tools/*" })).toBe("from dev-tools/*");
    expect(fromWord({ from: "machine", key: "mini" })).toBe("from machine mini");
    expect(fromWord({ from: "default" })).toBe("the kit's default");
    expect(fromWord({ from: null })).toBe("");
    expect(fromWord(undefined)).toBe("");
  });

  test("the plan sheet's first option names what a bare start takes", () => {
    const list = [L({ name: "feature", model: "opus" })];
    expect(inheritedLabel({ name: "feature", from: "repo", key: "dev-tools/*" }, list)).toBe("feature (opus), from dev-tools/*");
    expect(inheritedLabel(null, list)).toBe("the repo's route");
    expect(inheritedLabel({ name: null, from: null }, list)).toBe("the repo's route");
    expect(inheritedLabel({ name: null, from: "repo", key: "dev-tools/canopy" }, list)).toBe("the repo's route (dev-tools/canopy says none)");
    expect(inheritedLabel({ name: null, from: "machine", key: "mini" }, list)).toBe("the repo's route (machine mini says none)");
  });

  test("a run's title names its provider and where its loadout came from", () => {
    expect(equipTitle({ loadout: "offline", model: "default", effort: "default", skills: [], mcp: [], off: 0, provider: "local", from: { from: "machine", key: "mac" } }))
      .toBe("loadout offline, from machine mac\nprovider local");
  });
});

describe("a card's provider (FR-069)", () => {
  test("the card keeps a provider only when it differs from the loadout's", () => {
    const picks = { model: "default", effort: "default", skills: [], mcp: [] };
    expect(equipFrom(L({ name: "a" }), { ...picks, provider: "" })).toEqual({ loadout: "a" });
    expect(equipFrom(L({ name: "a", provider: "gw" }), { ...picks, provider: "gw" })).toEqual({ loadout: "a" });
    expect(equipFrom(L({ name: "a", provider: "gw" }), { ...picks, provider: "default" })).toEqual({ loadout: "a", provider: "default" });
    expect(equipFrom(L({ name: "a" }), { ...picks, provider: "local" })).toEqual({ loadout: "a", provider: "local" });
  });

  test("the sheet offers the harness's providers on this backend, and says which cannot serve", () => {
    const v = (id: string, harness: "claude" | "codex", state: ProviderView["state"]): ProviderView =>
      ({ id, note: "", harness, machines: null, central: true, envNames: [], keys: [], state, ...(state === "missing" ? { why: "no file" } : {}) });
    const list = [v("gw", "claude", "ok"), v("local", "claude", "hand"), v("far", "claude", "off"), v("gone", "claude", "missing"), v("or", "codex", "declared")];
    expect(providersFor("claude", list)).toEqual([
      { id: "gw", usable: true, why: "" }, { id: "local", usable: true, why: "" }, { id: "gone", usable: false, why: "no file" },
    ]);
    expect(providersFor("codex", list)).toEqual([{ id: "or", usable: true, why: "" }]);
    expect(providersFor("claude", undefined)).toEqual([]);
  });
});
