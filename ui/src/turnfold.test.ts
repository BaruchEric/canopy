import { describe, expect, test } from "bun:test";
import type { RunStep, RunTool } from "../../src/core/types";
import { nestSteps } from "./runs";
import { failed, foldKey, foldTurns, foldWords, stepInFlight, took, type Fold, type TimelineItem } from "./turnfold";

const T0 = 1_800_000_000_000;
const at = (s: number) => T0 + s * 1000;
const user = (id: string, s: number, text = "do it"): RunStep => ({ id, at: at(s), kind: "user", text });
const text = (id: string, s: number, words = "done"): RunStep => ({ id, at: at(s), kind: "text", text: words });
const note = (id: string, s: number): RunStep => ({ id, at: at(s), kind: "note", text: "resumed" });
const tool = (id: string, s: number, status: RunTool["status"] = "ok", parent?: string): RunStep => ({
  id,
  at: at(s),
  kind: "tool",
  tool: { name: "Bash", title: `cmd ${id}`, status },
  ...(parent ? { parent } : {}),
});
/** a run that ended, with no end time known */
const fold = (steps: RunStep[], end: number | null = null): TimelineItem[] => foldTurns(nestSteps(steps), { live: false, end });
/** a run at work, read at `end` */
const live = (steps: RunStep[], end: number): TimelineItem[] => foldTurns(nestSteps(steps), { live: true, end });
/** the items as short words: a step by its id, a fold by its ids in brackets */
const shape = (items: readonly TimelineItem[]): string[] => items.map((i) => (i.kind === "fold" ? `[${i.nodes.map((n) => n.step.id).join(" ")}]` : i.node.step.id));
const folds = (items: readonly TimelineItem[]): Fold[] => items.flatMap((i) => (i.kind === "fold" ? [i] : []));

describe("foldTurns", () => {
  test("nothing to fold leaves every step as it is, in order", () => {
    expect(shape(fold([user("u1", 0), text("a1", 5)]))).toEqual(["u1", "a1"]);
    expect(fold([])).toEqual([]);
  });

  test("a turn's tool calls fold into one line between the message and the reply", () => {
    const items = fold([user("u1", 0), tool("t1", 1), tool("t2", 10), tool("t3", 30), text("a1", 41)]);
    expect(shape(items)).toEqual(["u1", "[t1 t2 t3]", "a1"]);
    const [f] = folds(items);
    expect(f?.id).toBe("t1");
    expect(f?.ms).toBe(40_000);
    expect(f?.live).toBe(false);
    expect(f && stepInFlight(f)).toBeNull();
  });

  test("the person's messages and Claude's words are never folded, and keep their order", () => {
    const items = fold([user("u1", 0), text("a1", 1), tool("t1", 2), tool("t2", 3), text("a2", 4), tool("t3", 5), tool("t4", 6), text("a3", 7), user("u2", 8), text("a4", 9)]);
    expect(shape(items)).toEqual(["u1", "a1", "[t1 t2]", "a2", "[t3 t4]", "a3", "u2", "a4"]);
  });

  test("each item says which turn it is in: 0 before the first message, one more for each", () => {
    const items = fold([tool("t0", 0), tool("t00", 1), user("u1", 2), tool("t1", 3), tool("t2", 4), text("a1", 5), user("u2", 6), text("a2", 7)]);
    expect(items.map((i) => i.turn)).toEqual([0, 1, 1, 1, 2, 2]);
  });

  test("a single tool call is left as the step: a fold of one hides it for nothing", () => {
    expect(shape(fold([user("u1", 0), tool("t1", 1), text("a1", 2)]))).toEqual(["u1", "t1", "a1"]);
  });

  test("a failed step shows in full and splits the fold around it", () => {
    const items = fold([user("u1", 0), tool("t1", 1), tool("t2", 2), tool("bad", 3, "error"), tool("t3", 4), tool("t4", 5), text("a1", 6)]);
    expect(shape(items)).toEqual(["u1", "[t1 t2]", "bad", "[t3 t4]", "a1"]);
    // the first fold runs up to the failed step, the second up to the reply
    expect(folds(items).map((f) => f.ms)).toEqual([2000, 2000]);
  });

  test("an Agent call folds with its subagent's steps under it, unless one of them failed", () => {
    const calm = fold([user("u1", 0), tool("ag", 1), tool("k1", 2, "ok", "ag"), tool("k2", 3, "ok", "ag"), tool("t2", 4), text("a1", 5)]);
    expect(shape(calm)).toEqual(["u1", "[ag t2]", "a1"]);
    expect(folds(calm)[0]?.nodes[0]?.kids.map((k) => k.id)).toEqual(["k1", "k2"]);
    const hurt = nestSteps([tool("ag", 1), tool("k1", 2, "error", "ag")]);
    expect(hurt[0] && failed(hurt[0])).toBe(true);
    expect(shape(fold([user("u1", 0), tool("t1", 1), tool("ag", 2), tool("k1", 3, "error", "ag"), tool("t2", 4), text("a1", 5)]))).toEqual(["u1", "t1", "ag", "t2", "a1"]);
  });

  test("canopy's own remarks stay in view and end a fold", () => {
    expect(shape(fold([user("u1", 0), tool("t1", 1), tool("t2", 2), note("n1", 3), tool("t3", 4), tool("t4", 5)]))).toEqual(["u1", "[t1 t2]", "n1", "[t3 t4]"]);
  });

  test("the turn in flight: the fold at the end of a run at work is live and names the step running", () => {
    const steps = [user("u1", 0), tool("t1", 1), tool("t2", 2), tool("t3", 20, "running")];
    const items = live(steps, at(25));
    expect(shape(items)).toEqual(["u1", "[t1 t2 t3]"]);
    const [f] = folds(items);
    expect(f?.live).toBe(true);
    expect(f && stepInFlight(f)?.id).toBe("t3");
    expect(f?.ms).toBe(24_000);
  });

  test("a live fold with no step running, between two calls, has no step in flight", () => {
    const [f] = folds(live([user("u1", 0), tool("t1", 1), tool("t2", 2)], at(9)));
    expect(f?.live).toBe(true);
    expect(f && stepInFlight(f)).toBeNull();
  });

  test("a subagent's running step is the one in flight", () => {
    const [f] = folds(live([user("u1", 0), tool("t1", 1), tool("ag", 2, "running"), tool("k1", 3, "ok", "ag"), tool("k2", 4, "running", "ag")], at(9)));
    expect(f && stepInFlight(f)?.id).toBe("k2");
  });

  test("only the last fold of a run at work is live; an earlier one in the same turn is done", () => {
    const items = live([user("u1", 0), tool("t1", 1), tool("t2", 2), text("a1", 3), tool("t3", 4), tool("t4", 5, "running")], at(8));
    expect(folds(items).map((f) => f.live)).toEqual([false, true]);
  });

  test("a fold that Claude's words follow is not live even while the run works", () => {
    const items = live([user("u1", 0), tool("t1", 1), tool("t2", 2), text("a1", 3)], at(8));
    expect(folds(items).map((f) => f.live)).toEqual([false]);
  });

  test("a run that ended with a fold last measures it to the run's end, or not at all with none known", () => {
    const steps = [user("u1", 0), tool("t1", 1), tool("t2", 2)];
    expect(folds(fold(steps, at(31)))[0]?.ms).toBe(30_000);
    expect(folds(fold(steps))[0]?.ms).toBeNull();
  });

  test("the fold keeps its id as the turn adds steps", () => {
    const one = folds(live([user("u1", 0), tool("t1", 1), tool("t2", 2)], at(3)))[0];
    const two = folds(live([user("u1", 0), tool("t1", 1), tool("t2", 2), tool("t3", 3), tool("t4", 4)], at(5)))[0];
    expect(one?.id).toBe("t1");
    expect(two?.id).toBe("t1");
  });
});

describe("the fold's line", () => {
  const nodes = nestSteps(Array.from({ length: 12 }, (_, i) => tool(`t${i}`, i)));

  test("says how long the work took and how many steps it was", () => {
    expect(foldWords({ nodes, ms: 40_000, live: false })).toBe("worked for 40s · 12 steps");
  });

  test("says working while the turn is live", () => {
    expect(foldWords({ nodes, ms: 40_000, live: true })).toBe("working for 40s · 12 steps");
  });

  test("leaves the time out under a second or with none known", () => {
    expect(foldWords({ nodes, ms: 400, live: false })).toBe("12 steps");
    expect(foldWords({ nodes, ms: null, live: false })).toBe("12 steps");
    expect(foldWords({ nodes, ms: null, live: true })).toBe("working · 12 steps");
  });

  test("a time in the fewest honest words", () => {
    expect(took(40_000)).toBe("40s");
    expect(took(59_400)).toBe("59s");
    expect(took(60_000)).toBe("1m");
    expect(took(95_000)).toBe("1m 35s");
    expect(took(3_600_000)).toBe("1h");
    expect(took(7_500_000)).toBe("2h 5m");
  });
});

describe("a fold's name on the page", () => {
  test("is its run's and its first step's, so two runs' folds never share one", () => {
    expect(foldKey("mac:r1", "s4")).toBe("mac:r1 s4");
    expect(foldKey("mac:r1", "s4")).not.toBe(foldKey("mac:r2", "s4"));
  });
});
