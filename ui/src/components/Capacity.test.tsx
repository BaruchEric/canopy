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

test("a harness with no reading says so once and says what gives one: its next run on that backend", () => {
  const chip = renderToStaticMarkup(<ReadingRows rows={rows} now={NOW} where="chip" />);
  expect(count(chip, "no reading")).toBe(2);
  expect(chip).toContain("the next Claude Code run on mac reports it");
  expect(chip).toContain("the next Codex run on mac reports it");
  // nothing to set: the dollar figure is the costs view's own, for Claude alone
  expect(chip).not.toContain("dollar");
  const costs = renderToStaticMarkup(<ReadingRows rows={rows} now={NOW} where="costs" />);
  expect(count(costs, "no reading")).toBe(2);
  expect(costs).toContain("the next Claude Code run on mac reports it; until then a 5-hour window in Claude $ below estimates it from the ledger");
  expect(count(costs, "Claude $")).toBe(1);
  expect([count(chip, "capacity-hint"), count(costs, "capacity-hint")]).toEqual([2, 2]);
});

test("a harness with a run's count shows its windows and when they were read, and no hint", () => {
  const counted = capacityRows({ mac: { capacity: [{ ...emptyCapacity("claude"), weekly: { used: 0.56, resetsAt: Date.UTC(2026, 9, 29, 15), readAt: NOW - 3 * 60_000 }, source: "run" }], held: [], settings: DEFAULT_CAPACITY } }, ["mac"], NOW);
  const html = renderToStaticMarkup(<ReadingRows rows={counted} now={NOW} where="chip" />);
  expect(html).toContain("week 56% · Thu");
  expect(html).toContain("read from a run, 3m ago");
  expect(html).not.toContain("capacity-hint");
  expect(html).not.toContain("no reading");
});

test("Antigravity shows CLI readings without a hint, or the agy sign-in hint when unread", () => {
  const unread = capacityRows({ mac: { capacity: [emptyCapacity("antigravity")], held: [], settings: DEFAULT_CAPACITY } }, ["mac"], NOW);
  const unreadHtml = renderToStaticMarkup(<ReadingRows rows={unread} now={NOW} where="chip" />);
  expect(unreadHtml).toContain("install and sign in to agy on mac to read it");
  const read = capacityRows({
    mac: {
      capacity: [{
        ...emptyCapacity("antigravity"),
        fiveHour: { used: 0.04, resetsAt: NOW + 65 * 60_000, readAt: NOW - 2 * 60_000 },
        weekly: { used: 0.02, resetsAt: Date.UTC(2026, 9, 29, 15), readAt: NOW - 2 * 60_000 },
        source: "cli",
      }],
      held: [],
      settings: DEFAULT_CAPACITY,
    },
  }, ["mac"], NOW);
  const readHtml = renderToStaticMarkup(<ReadingRows rows={read} now={NOW} where="chip" />);
  expect(readHtml).toContain("5h 4% · 1h05");
  expect(readHtml).toContain("week 2% · Thu");
  expect(readHtml).toContain("read from the CLI, 2m ago");
  expect(readHtml).not.toContain("capacity-hint");
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
