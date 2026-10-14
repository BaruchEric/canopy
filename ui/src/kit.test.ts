import { describe, expect, test } from "bun:test";
import { cellAt, columns, mergeKit, rows } from "./kit";
import type { KitCell, KitInfo } from "../../src/core/types";

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
