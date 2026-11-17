import { afterEach, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { DEFAULT_CAPACITY, emptyCapacity } from "../../../src/core/capacity";
import type { HeldStart, Repo } from "../../../src/core/types";
import { capacityRows } from "../capacity";
import { setRegistry } from "../registry";
import { useStore } from "../store";
import { CapacityBlock, heldIds, ReadingRows } from "./Capacity";

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

const pristine = useStore.getState();
afterEach(() => {
  setRegistry("", [""]);
  useStore.setState(pristine, true);
});

const hold = (id: string, repoId: string): HeldStart => ({ id, what: "flow", repoId, priority: "low", why: "past the low hold", since: 1 });

test("a held start on another backend is released by the id that backend knows, however the page got it", () => {
  setRegistry("a", ["a", "mini"]);
  // the stream's capacity event qualifies the ids, an older read did not
  expect(heldIds("mini", hold("mini|flow:abc", "mini|proj"))).toEqual({ id: "flow:abc", repoId: "mini|proj" });
  expect(heldIds("mini", hold("flow:abc", "proj"))).toEqual({ id: "flow:abc", repoId: "mini|proj" });
  // home's ids are bare either way
  expect(heldIds("a", hold("flow:abc", "proj"))).toEqual({ id: "flow:abc", repoId: "proj" });
});

test("a held start from the stream names its repo, not the id twice qualified", () => {
  setRegistry("a", ["a", "mini"]);
  const info = { capacity: [emptyCapacity("claude")], held: [hold("mini|flow:abc", "mini|proj")], settings: DEFAULT_CAPACITY };
  useStore.setState({
    capacity: { mini: info },
    backendOrder: ["a", "mini"],
    repos: [{ id: "mini|proj", name: "the shop" } as unknown as Repo],
  });
  // a server render reads the store's first state, so it is set from the current one
  const initial = useStore.getInitialState();
  const before = { ...initial };
  Object.assign(initial, useStore.getState());
  try {
    expect(renderToStaticMarkup(<CapacityBlock />)).toContain("flow · the shop");
  } finally {
    Object.assign(initial, before);
  }
});
