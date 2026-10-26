import { expect, test } from "bun:test";
import type { ScenarioRun } from "../core/types";
import { listLines, runLines } from "./scenarios";

test("listLines", () => {
  expect(listLines("dev-tools/canopy", { names: [{ name: "checkout", kind: "command" }, { name: "refund", kind: "judge" }], errors: [{ file: "x.md", error: "x.md: name must be a short name of letters, digits, dots, dashes or underscores" }] })).toEqual([
    "dev-tools/canopy",
    "  checkout         command",
    "  refund           judge",
    "  x.md             cannot be read: x.md: name must be a short name of letters, digits, dots, dashes or underscores",
  ]);
  expect(listLines("r", { names: [], errors: [] })).toEqual(["no scenarios for r; add one with canopy scenarios r add <name>"]);
});

test("runLines", () => {
  const run: ScenarioRun = { head: "h", at: 1, total: 3, passed: 1, score: 1 / 3, results: [{ name: "a", kind: "command", ok: true, tail: "fine" }, { name: "b", kind: "command", ok: false, tail: "lots\n1 fail" }] };
  expect(runLines(run)).toEqual(["scenarios 1/3 · 0.33", "  ok   a", "  red  b  1 fail"]);
});
