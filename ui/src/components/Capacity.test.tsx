import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { DEFAULT_CAPACITY, emptyCapacity } from "../../../src/core/capacity";
import { capacityRows } from "../capacity";
import { ReadingRows } from "./Capacity";

const NOW = Date.UTC(2026, 9, 26, 12);
const rows = capacityRows({ mac: { capacity: [emptyCapacity("claude"), emptyCapacity("codex")], held: [], settings: DEFAULT_CAPACITY } }, ["mac"], NOW);
const count = (html: string, words: string): number => html.split(words).length - 1;

test("a harness with no reading says so once, and the Claude hint points at the figure from where the reader is", () => {
  const chip = renderToStaticMarkup(<ReadingRows rows={rows} now={NOW} where="chip" />);
  expect(count(chip, "no reading")).toBe(2);
  expect(chip).toContain("set the observed dollar figure in the costs view to estimate from the ledger");
  const costs = renderToStaticMarkup(<ReadingRows rows={rows} now={NOW} where="costs" />);
  expect(count(costs, "no reading")).toBe(2);
  expect(costs).toContain("set a 5-hour window in Claude $ below to estimate from the ledger");
  expect(costs).not.toContain("costs view");
  // one hint, for Claude; Codex has no ledger to estimate from
  expect([count(chip, "capacity-hint"), count(costs, "capacity-hint")]).toEqual([1, 1]);
});
