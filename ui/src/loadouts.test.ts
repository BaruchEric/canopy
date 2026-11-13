import { describe, expect, test } from "bun:test";
import type { Loadout } from "../../src/core/types";
import { equipFrom, equipTitle, loadoutLabel, loadoutsFor } from "./loadouts";

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
});
