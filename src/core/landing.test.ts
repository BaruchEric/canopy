import { describe, expect, test } from "bun:test";
import {
  advance,
  enqueue,
  fixPrompt,
  holdAll,
  inQueue,
  landCounts,
  LandError,
  landWord,
  MAX_TRIES,
  nextEntry,
  pruneLanded,
  queueOf,
  restartWorking,
  retryWaiting,
  sentBack,
  TAIL_CHARS,
} from "./landing";
import type { LandEntry, LandingRun } from "./types";

const run = (id: string, over: Partial<LandingRun> = {}): LandingRun => ({
  id,
  runId: id,
  repoId: "canopy",
  repoPath: "/r/canopy",
  branch: `run/x-${id}`,
  target: "main",
  base: "b0",
  dir: `/w/canopy/${id}`,
  note: `note ${id}`,
  verb: "Plan, then build",
  harness: "claude",
  state: "ready",
  startedAt: 1,
  ...over,
});

const queued = (ids: string[], repoId = "canopy"): LandEntry[] => {
  let out: LandEntry[] = [];
  ids.forEach((id, i) => {
    out = enqueue(out, run(id, { repoId }), 100 + i);
  });
  return out;
};

describe("enqueue", () => {
  test("a ready run joins at the end", () => {
    const es = queued(["a", "b"]);
    expect(es.map((e) => [e.id, e.state, e.queuedAt])).toEqual([
      ["a", "queued", 100],
      ["b", "queued", 101],
    ]);
    expect(nextEntry(es, "canopy")?.id).toBe("a");
  });

  test("only a ready run, and not twice", () => {
    expect(() => enqueue([], run("a", { state: "uncommitted" }), 1)).toThrow(LandError);
    const es = queued(["a"]);
    expect(() => enqueue(es, run("a"), 2)).toThrow("in the queue already");
    const landed = es.map((e) => advance(e, { t: "landed", head: "h" }, 3));
    expect(() => enqueue(landed, run("a"), 4)).toThrow("landed already");
  });

  test("a sent-back entry rejoins at the end, its reason gone", () => {
    let es = queued(["a", "b"]);
    es = es.map((e) => (e.id === "a" ? advance(advance(e, { t: "begin" }, 200), { t: "conflict", files: ["x.ts"] }, 201) : e));
    expect(sentBack(es[0]!)).toBe(true);
    es = enqueue(es, run("a"), 300);
    expect(queueOf(es, "canopy").map((e) => e.id)).toEqual(["b", "a"]);
    const a = es.find((e) => e.id === "a")!;
    expect(a.reason).toBeUndefined();
    expect(a.tries).toBe(0);
  });
});

describe("advance", () => {
  const e0 = queued(["a"])[0]!;

  test("rebase, gates in order, land", () => {
    let e = advance(e0, { t: "begin" }, 1);
    expect(e.state).toBe("rebasing");
    e = advance(e, { t: "rebased", setup: false, first: "typecheck", noGates: false }, 2);
    expect([e.state, e.gate]).toEqual(["gate", "typecheck"]);
    e = advance(e, { t: "gate-ok", next: "test" }, 3);
    expect([e.state, e.gate]).toEqual(["gate", "test"]);
    e = advance(e, { t: "gate-ok", next: null }, 4);
    expect([e.state, e.gate]).toEqual(["landing", undefined]);
    e = advance(e, { t: "landed", head: "abc" }, 5);
    expect([e.state, e.head, e.landedAt]).toEqual(["landed", "abc", 5]);
    expect(inQueue(e)).toBe(false);
  });

  test("setup first when the lockfile moved", () => {
    let e = advance(advance(e0, { t: "begin" }, 1), { t: "rebased", setup: true, first: "test", noGates: false }, 2);
    expect(e.state).toBe("setup");
    e = advance(e, { t: "set-up", first: "test" }, 3);
    expect([e.state, e.gate]).toEqual(["gate", "test"]);
  });

  test("no gates lands and says so", () => {
    const e = advance(advance(e0, { t: "begin" }, 1), { t: "rebased", setup: false, first: null, noGates: true }, 2);
    expect([e.state, e.noGates]).toEqual(["landing", true]);
  });

  test("a red gate keeps the tail of its output", () => {
    const out = "x".repeat(TAIL_CHARS + 50) + "END";
    const e = advance(advance(e0, { t: "begin" }, 1), { t: "red", gate: "test", output: out }, 2);
    expect(e.state).toBe("red");
    expect(e.gate).toBe("test");
    expect(e.reason).toHaveLength(TAIL_CHARS);
    expect(e.reason?.endsWith("END")).toBe(true);
    expect(sentBack(e)).toBe(true);
  });

  test("main moving goes back to the rebase, then sends it back on the third", () => {
    let e = advance(e0, { t: "begin" }, 1);
    for (let i = 1; i < MAX_TRIES; i++) {
      e = advance(e, { t: "moved" }, 2);
      expect([e.state, e.tries]).toEqual(["rebasing", i]);
    }
    e = advance(e, { t: "moved" }, 3);
    expect([e.state, e.tries]).toEqual(["moved", MAX_TRIES]);
    expect(e.reason).toContain("kept moving");
  });

  test("a busy main checkout waits with the files", () => {
    const e = advance(advance(e0, { t: "begin" }, 1), { t: "busy", files: ["a.ts", "b.ts"] }, 2);
    expect([e.state, e.reason, e.files]).toEqual(["waiting", "main checkout busy: a.ts, b.ts", ["a.ts", "b.ts"]]);
    expect(inQueue(e)).toBe(true);
  });
});

describe("the queue", () => {
  test("waiting entries keep their place but are passed over, then retried", () => {
    let es = queued(["a", "b"]);
    es = es.map((e) => (e.id === "a" ? advance(e, { t: "busy", files: ["f"] }, 5) : e));
    expect(nextEntry(es, "canopy")?.id).toBe("b");
    expect(queueOf(es, "canopy").map((e) => e.id)).toEqual(["a", "b"]);
    es = retryWaiting(es, "canopy", 9);
    expect(nextEntry(es, "canopy")?.id).toBe("a");
    expect(es[0]!.reason).toBeUndefined();
  });

  test("a checkout not on the target holds every queued entry", () => {
    const es = holdAll([...queued(["a", "b"]), ...queued(["c"], "other")], "canopy", "checkout not on main", 5);
    expect(es.map((e) => [e.id, e.state, e.reason ?? ""])).toEqual([
      ["a", "waiting", "checkout not on main"],
      ["b", "waiting", "checkout not on main"],
      ["c", "queued", ""],
    ]);
    expect(nextEntry(es, "canopy")).toBeUndefined();
  });

  test("a restart puts a mid-turn entry back to queued, sent back and waiting stay", () => {
    let es = queued(["a", "b", "c"]);
    es = es.map((e) =>
      e.id === "a" ? advance(advance(e, { t: "begin" }, 1), { t: "rebased", setup: false, first: "test", noGates: false }, 2)
      : e.id === "b" ? advance(e, { t: "red", gate: "lint", output: "boom" }, 2)
      : advance(e, { t: "busy", files: ["x"] }, 2),
    );
    const back = restartWorking(es, 10);
    expect(back.map((e) => [e.id, e.state])).toEqual([
      ["a", "queued"],
      ["b", "red"],
      ["c", "waiting"],
    ]);
    expect(back[0]!.gate).toBeUndefined();
  });

  test("landed entries past the newest ten per repo go", () => {
    let es: LandEntry[] = [];
    for (let i = 0; i < 12; i++) es = enqueue(es, run(`r${i}`), i);
    es = es.map((e, i) => advance(e, { t: "landed", head: "h" }, 100 + i));
    const kept = pruneLanded(es);
    expect(kept).toHaveLength(10);
    expect(kept.some((e) => e.id === "r0" || e.id === "r1")).toBe(false);
  });
});

describe("words", () => {
  test("states as a list shows them", () => {
    const es = queued(["a", "b"]);
    expect(landWord(es[1]!, es)).toBe("queued 2nd");
    expect(landWord(advance(es[0]!, { t: "rebased", setup: false, first: "test", noGates: false }, 1), es)).toBe("gate: test");
    expect(landWord(advance(es[0]!, { t: "red", gate: "lint", output: "" }, 1), es)).toBe("red: lint");
  });

  test("counts for the chip", () => {
    let es = queued(["a", "b", "c"]);
    es = es.map((e) => (e.id === "c" ? advance(e, { t: "conflict", files: ["f"] }, 1) : e));
    expect(landCounts(es, "canopy")).toEqual({ queued: 2, back: 1 });
    expect(landCounts(es, "other")).toEqual({ queued: 0, back: 0 });
  });

  test("a fix prompt names the reason", () => {
    const e = queued(["a"])[0]!;
    expect(fixPrompt(advance(e, { t: "conflict", files: ["a.ts"] }, 1))).toContain("conflicts in a.ts");
    expect(fixPrompt(advance(e, { t: "red", gate: "test", output: "1 fail" }, 1))).toContain("1 fail");
    expect(fixPrompt(advance(e, { t: "red", gate: "test", output: "1 fail" }, 1))).toContain("Do not push.");
  });
});
