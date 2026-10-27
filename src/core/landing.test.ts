import { describe, expect, test } from "bun:test";
import {
  addNotice,
  advance,
  canLand,
  enqueue,
  entryFor,
  fixPrompt,
  landAllPick,
  MAX_NOTICES,
  rejoins,
  reviewWord,
  unqueue,
  holdAll,
  inQueue,
  landCounts,
  LandError,
  landWord,
  landAnyway,
  MAX_TRIES,
  nextEntry,
  pruneLanded,
  queueOf,
  restartWorking,
  retryWaiting,
  scenarioOf,
  SCENARIO_GATE,
  scoreGate,
  scoreOutput,
  sentBack,
  TAIL_CHARS,
} from "./landing";
import type { LandEntry, LandingRun, LandNotice, RunReview } from "./types";
import { touchedOf } from "./touch";

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
  test("an entry is marked when a working run's set holds its files, by that run's name, through to the fix prompt", () => {
    const working = [touchedOf({ id: "w", verb: "Plan, then build", steps: [{ id: "1", at: 1, kind: "tool", tool: { name: "Edit", title: "", status: "ok", paths: ["src/a.ts", "docs/"] } }], branch: { name: "run/x-w", target: "main", base: "b0", dir: "/w/w", state: "working", origin: "w" } })];
    const review: RunReview = { verdict: "land", files: [{ path: "src/a.ts", cls: "logic" }, { path: "docs/x.md", cls: "docs" }, { path: "z.ts", cls: "logic" }], base: "b", head: "h", at: 1 };
    const e = enqueue([], run("a", { review }), 1, undefined, working)[0];
    if (!e) throw new Error("expected the entry to be queued");
    expect(e.overlap).toEqual({ with: "run/x-w", paths: ["docs/x.md", "src/a.ts"] });
    expect(enqueue([], run("b", { review: { ...review, files: [{ path: "q.ts", cls: "logic" }] } }), 1, undefined, working)[0]?.overlap).toBeUndefined();
    expect(enqueue([], run("w", { review }), 1, undefined, working)[0]?.overlap).toBeUndefined();
    expect(enqueue([], run("c"), 1, undefined, working)[0]?.overlap).toBeUndefined();
    const back = advance(advance(e, { t: "begin" }, 2), { t: "conflict", files: ["src/a.ts"] }, 3);
    expect(back.overlap).toEqual(e.overlap);
    expect(fixPrompt(back)).toContain("canopy saw run/x-w editing these files while you worked: docs/x.md, src/a.ts.");
    expect(fixPrompt(back).endsWith("Do not push.")).toBe(true);
    const noOverlap = enqueue([], run("empty"), 1)[0];
    if (!noOverlap) throw new Error("expected the entry to be queued");
    const noOverlapBack = advance(advance(noOverlap, { t: "begin" }, 2), { t: "conflict", files: ["x"] }, 3);
    expect(fixPrompt(noOverlapBack)).not.toContain("canopy saw");
  });

  test("a recorded overlap carries into enqueue and a sent-back entry keeps its older overlap", () => {
    const review: RunReview = { verdict: "land", files: [{ path: "notes.md", cls: "logic" }], base: "b", head: "h", at: 1 };
    const remembered = { with: "run/x-c", paths: ["notes.md"] };
    const prior = enqueue([], run("d", { review, overlap: remembered }), 1)[0];
    if (!prior) throw new Error("expected the branch to be queued");
    expect(prior.overlap).toEqual(remembered);
    expect(fixPrompt(advance(advance(prior, { t: "begin" }, 2), { t: "conflict", files: ["notes.md"] }, 3))).toContain("canopy saw run/x-c editing these files while you worked: notes.md.");

    const working = [touchedOf({ id: "live", verb: "Ask", steps: [{ id: "1", at: 1, kind: "tool", tool: { name: "Edit", title: "", status: "ok", paths: ["notes.md"] } }], branch: { name: "run/x-live", target: "main", base: "b", dir: "/w/live", state: "working", origin: "live" } })];
    expect(enqueue([], run("d", { review, overlap: remembered }), 4, undefined, working)[0]?.overlap).toEqual({ with: "run/x-live", paths: ["notes.md"] });

    const sentBack = advance(advance(enqueue([], run("e", { review }), 5, undefined, working)[0]!, { t: "begin" }, 6), { t: "conflict", files: ["notes.md"] }, 7);
    expect(enqueue([sentBack], run("e", { review }), 8)[0]?.overlap).toEqual({ with: "run/x-live", paths: ["notes.md"] });
  });

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

const review = (verdict: RunReview["verdict"], over: Partial<RunReview> = {}): RunReview => ({ verdict, files: [], base: "b0", head: "h1", at: 1, ...over });
const sensitive = (n: number): RunReview["files"] => Array.from({ length: n }, (_, i) => ({ path: `s${i}`, cls: "logic" as const, sensitive: "x" }));

describe("review rules in the queue", () => {
  test("the flags ride on the entry through its turn and a restart", () => {
    const [e] = enqueue([], run("a"), 1, { auto: true, approved: "p1" });
    expect(e).toMatchObject({ auto: true, approved: "p1" });
    const mid = advance(advance(e!, { t: "begin" }, 2), { t: "rebased", setup: false, first: "test", noGates: false }, 3);
    expect(mid).toMatchObject({ state: "gate", auto: true, approved: "p1" });
    expect(restartWorking([mid], 4)[0]).toMatchObject({ state: "queued", auto: true, approved: "p1" });
    // a sent-back entry rejoining keeps them unless new ones are given
    const back = advance(mid, { t: "red", gate: "test", output: "x" }, 5);
    expect(enqueue([back], run("a"), 6)[0]).toMatchObject({ auto: true, approved: "p1" });
    expect(enqueue([back], run("a"), 6, {})[0]?.auto).toBeUndefined();
    expect(enqueue([], run("b"), 1)[0]).not.toHaveProperty("auto");
  });

  test("unqueue takes an entry out", () => {
    expect(unqueue(queued(["a", "b"]), "a").map((e) => e.id)).toEqual(["b"]);
  });

  test("a fix rejoins on its own only when its sort allows it", () => {
    expect(rejoins(review("auto"), { auto: true })).toEqual({ ok: true });
    expect(rejoins(review("land"), {})).toEqual({ ok: true });
    expect(rejoins(review("land"), { auto: true })).toMatchObject({ ok: false, why: expect.stringContaining("needs your land") });
    expect(rejoins(review("approve", { sensitiveId: "p1" }), { approved: "p1" })).toEqual({ ok: true });
    expect(rejoins(review("approve", { sensitiveId: "p2" }), { approved: "p1" })).toMatchObject({ ok: false, why: expect.stringContaining("changed the sensitive files") });
    expect(rejoins(review("approve", { sensitiveId: "p1" }), {})).toMatchObject({ ok: false, why: expect.stringContaining("touches sensitive files") });
  });

  test("land with a good, stale and missing approval", () => {
    expect(() => canLand(review("auto"))).not.toThrow();
    expect(() => canLand(review("land"))).not.toThrow();
    const r = review("approve", { sensitiveId: "p1", files: sensitive(2) });
    expect(() => canLand(r, "p1")).not.toThrow();
    expect(() => canLand(r, "p0")).toThrow("the branch changed since you looked");
    expect(() => canLand(r)).toThrow("it needs your approval: 2 sensitive files; look at the files and approve");
    let status = 0;
    try {
      canLand(r);
    } catch (err) {
      status = (err as LandError).status;
    }
    expect(status).toBe(409);
  });

  test("the words", () => {
    expect(reviewWord(review("auto"))).toBe("lands on its own");
    expect(reviewWord(review("land"))).toBe("needs your land");
    expect(reviewWord(review("land", { why: "no gates to run" }))).toBe("needs your land: no gates to run");
    expect(reviewWord(review("approve", { files: sensitive(1) }))).toBe("needs your approval: 1 sensitive file");
    expect(reviewWord(review("approve", { files: sensitive(2) }))).toBe("needs your approval: 2 sensitive files");
    expect(reviewWord(review("approve", { why: "review.json is not JSON" }))).toBe("needs your approval: review.json is not JSON");
  });

  test("notices keep the newest fifty", () => {
    let list: LandNotice[] = [];
    for (let i = 0; i < MAX_NOTICES + 5; i++) list = addNotice(list, { id: `n${i}`, entry: "a", repoId: "canopy", branch: "run/x", note: "", kind: "landed", at: i });
    expect(list.length).toBe(MAX_NOTICES);
    expect(list[0]?.id).toBe(`n${MAX_NOTICES + 4}`);
    expect(addNotice(list, { ...list[3]!, at: 99 }).filter((x) => x.id === list[3]!.id).length).toBe(1);
  });

  test("land all takes ready runs that need no approval", () => {
    const runs = [run("a", { review: review("auto") }), run("b", { review: review("land") }), run("c", { review: review("approve") }), run("d"), run("e", { state: "working" }), run("f", { repoId: "other" }), run("g", { review: review("auto"), pr: 4 })];
    const pick = landAllPick(runs, queued(["d"]), "canopy");
    expect([pick.take.map((r) => r.id), pick.skip.map((r) => r.id)]).toEqual([["a", "b"], ["c"]]);
  });
});

describe("scenarios", () => {
  test("after the last gate the entry moves through the scenarios, then lands", () => {
    let e = advance(enqueue([], run("s1"), 1)[0]!, { t: "begin" }, 2);
    e = advance(e, { t: "rebased", setup: false, first: "test", noGates: false }, 3);
    e = advance(e, { t: "gate-ok", next: null }, 4);
    expect(e.state).toBe("landing");
    e = advance(e, { t: "scenarios", first: "checkout-flow" }, 5);
    expect([e.state, e.gate, landWord(e, [e]), inQueue(e)]).toEqual(["scenarios", "checkout-flow", "scenario: checkout-flow", true]);
    e = advance(e, { t: "scenario-ok", next: "refund" }, 6);
    expect([e.state, e.gate]).toEqual(["scenarios", "refund"]);
    e = advance(e, { t: "scenario-ok", next: null }, 7);
    expect([e.state, e.gate]).toEqual(["landing", undefined]);
  });
  test("a red scenario reads as one, apart from a gate of the same name", () => {
    const base = advance(advance(enqueue([], run("s2"), 1)[0]!, { t: "begin" }, 2), { t: "scenarios", first: "test" }, 3);
    const e = advance(base, { t: "red", gate: `${SCENARIO_GATE}test`, output: "x".repeat(5000) + "\n2 fail" }, 4);
    expect([e.state, e.gate, landWord(e, [e]), scenarioOf(e.gate)]).toEqual(["red", "scenario: test", "red: scenario: test", "test"]);
    expect(e.reason?.length).toBe(TAIL_CHARS);
    expect(scenarioOf("test")).toBeNull();
    const p = fixPrompt(e);
    expect(p).toContain("scenario test failed after a rebase onto main");
    expect(p).toContain("is not shown");
    expect(p.endsWith("2 fail\n\nRebase onto main, fix what the output shows, run the repo's checks, and commit. Do not push.")).toBe(true);
    expect(p).not.toContain("the test gate failed");
  });
  test("a restart puts a mid-scenarios entry back in the queue", () => {
    const e = advance(advance(enqueue([], run("s3"), 1)[0]!, { t: "begin" }, 2), { t: "scenarios", first: "a" }, 3);
    const back = restartWorking([e], 9)[0]!;
    expect(back.state).toBe("queued");
    expect(back).not.toHaveProperty("gate");
  });
});

describe("judge scenarios plan 2", () => {
  const held = (id = "j"): LandEntry => advance(entryFor(run(id), 1), { t: "unjudged", name: "refund", why: "no gateway key" }, 2);
  test("a judge hold survives retries and restart without becoming runnable", () => {
    const e = held();
    expect(e).toMatchObject({ state: "judge", gate: "refund", reason: "scenario refund needs a judge: no gateway key" });
    expect([inQueue(e), sentBack(e), landWord(e, [e])]).toEqual([true, false, "needs a judge"]);
    expect(retryWaiting([e], "canopy", 3)).toEqual([e]);
    expect(restartWorking([e], 3)).toEqual([e]);
    expect(holdAll([e], "canopy", "checkout busy", 3)).toEqual([e]);
    expect(nextEntry([e], "canopy")).toBeUndefined();
    expect(queueOf([e], "canopy")).toEqual([e]);
    expect(landCounts([e], "canopy")).toEqual({ queued: 1, back: 0 });
  });
  test("land anyway preserves order and refuses every non-hold", () => {
    const a = entryFor(run("a"), 0);
    const e = held("b");
    const out = landAnyway([a, e], "b", 9);
    expect(out.find(x => x.id === "b")).toMatchObject({ state: "queued", skipJudge: true, queuedAt: 1, updatedAt: 9 });
    expect(out.find(x => x.id === "b")?.reason).toBeUndefined();
    expect(out.find(x => x.id === "b")?.gate).toBeUndefined();
    expect(nextEntry(out, "canopy")?.id).toBe("a");
    for (const state of ["queued", "rebasing", "setup", "gate", "scenarios", "landing", "landed", "waiting", "conflict", "red", "moved"] as const) {
      expect(() => landAnyway([{ ...a, state }], "a", 10)).toThrow("it is not held for a judge");
    }
    expect(() => landAnyway([], "missing", 10)).toThrow("no entry by that id");
  });
  test("a below-minimum score explains both failing and confident judge results", () => {
    const why = "the judge says what was observed only partly satisfies the story";
    expect(scoreOutput([{ name: "command", kind: "command", ok: false, tail: "ignore" }, { name: "refund", kind: "judge", ok: false, p: 0.3, why, tail: "observed no refund" }])).toBe(`scenario refund: ${why}\nobserved no refund`);
    expect(scoreOutput([{ name: "mail", kind: "judge", ok: true, p: 0.9, tail: "sent" }])).toBe("scenario mail: satisfaction 0.90\nsent");
    expect(scoreOutput([{ name: "missing", kind: "judge", ok: false, unjudged: "no gateway key" }])).toBe("scenario missing: no gateway key");
    expect(scoreGate(2 / 3, 0.8)).toBe("satisfaction 0.67 < 0.8");
    const e = advance(entryFor(run("j"), 1), { t: "red", gate: scoreGate(0.5, 1), output: "scenario refund: partly\nno refund" }, 2);
    expect(scenarioOf(e.gate)).toBeNull();
    expect(fixPrompt(e)).toContain("holdout scenarios scored satisfaction 0.50 < 1");
    expect(fixPrompt(e)).toContain("are not shown");
    expect(fixPrompt(e)).toContain("scenario refund: partly\nno refund");
    expect(fixPrompt(e)).toContain("Do not push.");
    expect(fixPrompt({ ...e, overlap: { with: "other-branch", paths: ["refund.ts"] } })).toContain("canopy saw other-branch editing these files while you worked: refund.ts");
  });
});
