import { describe, expect, test } from "bun:test";
import {
  ADVICE_MAX,
  RETRO_PARK_WAIT,
  adviceWorkflow,
  decide,
  endRetroDue,
  flowDigest,
  foldAdvice,
  improvementsMd,
  offered,
  parkRetroDue,
  parseAdvice,
  retroRecord,
} from "./retro";
import type { Flow, Improvements, Sprout } from "./types";

const flow = (patch: Partial<Flow> = {}): Flow => ({
  id: "f1",
  repoId: "_incubator/coins",
  workflow: "scout",
  verb: "scout",
  note: "the note",
  status: "done",
  steps: [
    {
      name: "Research",
      status: "passed",
      runId: "r1",
      check: { command: "@pick-check", exit: 0, output: "pick ok: new on vercel" },
      summary: "picked new",
    },
    {
      name: "Eval",
      status: "passed",
      judgment: {
        answers: { fit: { choice: "meets" }, evidence: { probability: 0.9 }, rules: { probability: 0.1 } },
        go: true,
        rejected: false,
        reason: null,
      },
    },
  ],
  current: 1,
  startedAt: 100,
  endedAt: 900,
  tries: { Eval: 1 },
  rewinds: [{ from: "Eval", to: "Research", reason: "the pick misses the log", at: 500 }],
  spent: { runs: 3, workMs: 60_000 },
  budget: { runs: 8, hours: 1 },
  ...patch,
});

const sprout = (patch: Partial<Sprout> = {}): Sprout => ({
  id: "sp_000000000001",
  slug: "coins",
  title: "Coin counter",
  status: "live",
  repoId: "_incubator/coins",
  seedPath: "/root/_incubator/coins",
  prepared: true,
  inputs: [
    { n: 1, kind: "text", name: "001-text.md", label: "text", type: "text/markdown", at: 1, via: "sheet", bytes: 10, summary: "count coins", processed: true },
    {
      n: 2,
      kind: "url",
      name: "002-link.url",
      label: "https://secret-host.example/private-doc",
      type: "text/uri-list",
      at: 1,
      via: "sheet",
      bytes: 10,
      summary: "a page about coins",
      processed: true,
    },
  ],
  clarified: true,
  reclarify: false,
  flows: [{ workflow: "clarify", flowId: "f0", outcome: "done" }],
  spent: { runs: 4, workMs: 120_000 },
  noteRev: "rev-7",
  createdAt: 10,
  updatedAt: 1000,
  ...patch,
});

describe("flowDigest", () => {
  test("keeps each step's outcome, tries, check and judgment, the rewinds and the spend", () => {
    const d = flowDigest(flow());
    expect(d.status).toBe("done");
    expect(d.startedAt).toBe(100);
    expect(d.endedAt).toBe(900);
    expect(d.spent).toEqual({ runs: 3, workMs: 60_000 });
    expect(d.budget).toEqual({ runs: 8, hours: 1 });
    expect(d.steps[0]).toEqual({ name: "Research", status: "passed", tries: 0, check: { exit: 0, output: "pick ok: new on vercel" }, summary: "picked new" });
    expect(d.steps[1]).toEqual({
      name: "Eval",
      status: "passed",
      tries: 1,
      judgment: { fit: "meets", evidence: 0.9, rules: 0.1, go: true, rejected: false, reason: null },
    });
    expect(d.rewinds).toEqual([{ from: "Eval", to: "Research", reason: "the pick misses the log", at: 500 }]);
  });

  test("clips long text: a check's output keeps its end, where the failure is", () => {
    const long = `${"x".repeat(5000)}THE END`;
    const d = flowDigest(
      flow({
        error: "e".repeat(2000),
        steps: [{ name: "Scaffold", status: "failed", reason: "r".repeat(2000), check: { command: "sh", exit: 1, output: long }, summary: "s".repeat(5000) }],
      }),
    );
    const st = d.steps[0];
    expect(st?.check?.output.endsWith("THE END")).toBe(true);
    expect(st?.check?.output.length).toBeLessThanOrEqual(600);
    expect(st?.reason?.length).toBeLessThanOrEqual(300);
    expect(st?.summary?.length).toBeLessThanOrEqual(400);
    expect(d.error?.length).toBeLessThanOrEqual(300);
  });
});

describe("retroRecord", () => {
  test("holds no raw input, label or file, no note revision or seed path", () => {
    const rec = retroRecord(sprout(), new Map(), []);
    const text = JSON.stringify(rec);
    expect(text).not.toContain("secret-host");
    expect(text).not.toContain("001-text.md");
    expect(text).not.toContain("rev-7");
    expect(text).not.toContain("/root/_incubator");
    expect(rec.inputs).toEqual([
      { n: 1, kind: "text", summary: "count coins" },
      { n: 2, kind: "url", summary: "a page about coins" },
    ]);
  });

  test("a token in a park reason or a flow's error is stripped", () => {
    const s = sprout({
      status: "parked",
      parked: "deploy: https://x:ghp_TOKEN@github.com/a/b refused",
      parks: [{ at: 5, reason: "clone of https://me:hunter2@example.com/r failed" }],
      flows: [{ workflow: "scout", flowId: "f1", outcome: "failed", digest: flowDigest(flow({ status: "failed", error: "push to https://u:tok@host/x" })) }],
    });
    const text = JSON.stringify(retroRecord(s, new Map(), []));
    expect(text).not.toContain("ghp_TOKEN");
    expect(text).not.toContain("hunter2");
    expect(text).not.toContain("u:tok");
    expect(text).toContain("https://github.com/a/b");
  });

  test("a flow with no digest takes one read now, else its workflow and outcome alone", () => {
    const s = sprout({
      flows: [
        { workflow: "clarify", flowId: "gone", outcome: "done" },
        { workflow: "scout", flowId: "f1" },
      ],
    });
    const rec = retroRecord(s, new Map([["f1", flowDigest(flow({ status: "stopped" }))]]), []);
    expect(rec.flows[0]).toEqual({ workflow: "clarify", outcome: "done" });
    expect(rec.flows[1]?.workflow).toBe("scout");
    expect(rec.flows[1]?.digest?.status).toBe("stopped");
  });

  test("names the keys already on the list, so a lesson repeats under its key", () => {
    const rec = retroRecord(sprout(), new Map(), [{ key: "scout-reads-npm", lesson: "Scout reads npm dates.", count: 3 }]);
    expect(rec.known).toEqual([{ key: "scout-reads-npm", lesson: "Scout reads npm dates.", count: 3 }]);
    expect(rec.sprout.title).toBe("Coin counter");
    expect(rec.sprout.status).toBe("live");
  });
});

describe("parseAdvice", () => {
  const one = { key: "scout-reads-npm", lesson: "Scout should read release dates from npm." };

  test("a list or an object holding one", () => {
    expect(parseAdvice(JSON.stringify([one]))).toEqual({ ok: true, advice: [one] });
    expect(parseAdvice(JSON.stringify({ advice: [one] }))).toEqual({ ok: true, advice: [one] });
    expect(parseAdvice("[]")).toEqual({ ok: true, advice: [] });
  });

  test("refuses what is not a list of advice", () => {
    expect(parseAdvice("nope").ok).toBe(false);
    expect(parseAdvice("{}").ok).toBe(false);
    expect(parseAdvice(JSON.stringify(Array.from({ length: ADVICE_MAX + 1 }, (_, i) => ({ key: `k-${i}`, lesson: "l" })))).ok).toBe(false);
    expect(parseAdvice(JSON.stringify([{ key: "Has Spaces", lesson: "l" }])).ok).toBe(false);
    expect(parseAdvice(JSON.stringify([{ key: "k".repeat(61), lesson: "l" }])).ok).toBe(false);
    expect(parseAdvice(JSON.stringify([{ key: "k", lesson: "  " }])).ok).toBe(false);
    expect(parseAdvice(JSON.stringify([{ key: "k", lesson: "l", edit: "e".repeat(4001) }])).ok).toBe(false);
    expect(parseAdvice(JSON.stringify([{ key: "k", lesson: "l", file: "../../.env" }])).ok).toBe(false);
    expect(parseAdvice(JSON.stringify([{ key: "k", lesson: "l", file: "/etc/passwd" }])).ok).toBe(false);
    expect(parseAdvice(JSON.stringify([{ key: "k", lesson: "l", file: "src/core/sprout.ts" }])).ok).toBe(false);
    expect(parseAdvice(JSON.stringify([{ key: "k", lesson: "l", edit: 5 }])).ok).toBe(false);
  });

  test("a lesson is one line of at most 300; a file is kept as the workflow's name; extras and repeats go", () => {
    const parsed = parseAdvice(
      JSON.stringify([
        { key: "a", lesson: `first line\nsecond ${"w".repeat(400)}`, file: "lib/workflows/scout.md", edit: "- old\n+ new", extra: "dropped" },
        { key: "a", lesson: "a repeat" },
        { key: "b", lesson: "b", file: "build-new.md" },
        { key: "c", lesson: "c", file: "clarify" },
      ]),
    );
    if (!parsed.ok) throw new Error(parsed.error);
    expect(parsed.advice.map((a) => a.key)).toEqual(["a", "b", "c"]);
    expect(parsed.advice[0]?.lesson.startsWith("first line second")).toBe(true);
    expect(parsed.advice[0]?.lesson.length).toBeLessThanOrEqual(300);
    expect(parsed.advice[0]?.file).toBe("scout");
    expect(parsed.advice[0]?.edit).toBe("- old\n+ new");
    expect(Object.keys(parsed.advice[0] ?? {})).toEqual(["key", "lesson", "file", "edit"]);
    expect(parsed.advice[1]?.file).toBe("build-new");
    expect(parsed.advice[2]?.file).toBe("clarify");
  });

  test("adviceWorkflow takes a name, a .md or a lib/workflows path, and nothing else", () => {
    expect(adviceWorkflow("scout")).toBe("scout");
    expect(adviceWorkflow("scout.md")).toBe("scout");
    expect(adviceWorkflow("lib/workflows/build-new.md")).toBe("build-new");
    expect(adviceWorkflow("workflows/scout.md")).toBe("scout");
    expect(adviceWorkflow("../scout.md")).toBeNull();
    expect(adviceWorkflow("lib/workflows/../x.md")).toBeNull();
    expect(adviceWorkflow("Scout")).toBeNull();
    expect(adviceWorkflow("")).toBeNull();
  });
});

describe("the improvements list", () => {
  const empty: Improvements = { entries: {} };
  const a = { key: "scout-reads-npm", lesson: "Scout reads npm.", file: "scout" };

  test("a key counts each sprout once, and the newest lesson wins", () => {
    let st = foldAdvice(empty, [a], { id: "sp_1", title: "One" }, 10);
    expect(offered(st).map((o) => [o.key, o.count])).toEqual([["scout-reads-npm", 1]]);
    st = foldAdvice(st, [a], { id: "sp_1", title: "One" }, 20);
    expect(offered(st)[0]?.count).toBe(1);
    st = foldAdvice(st, [{ ...a, lesson: "Scout reads release dates on npm." }], { id: "sp_2", title: "Two" }, 30);
    const o = offered(st)[0];
    expect(o?.count).toBe(2);
    expect(o?.lesson).toBe("Scout reads release dates on npm.");
    expect(o?.titles).toEqual(["Two", "One"]);
    expect(o?.lastAt).toBe(30);
  });

  test("a dismissed key comes back after three more sprouts, an accepted one too", () => {
    for (const accept of [false, true]) {
      let st = foldAdvice(empty, [a], { id: "sp_1", title: "One" }, 10);
      const d = decide(st, a.key, accept, 11);
      if (!d) throw new Error("no key");
      st = d;
      expect(offered(st)).toEqual([]);
      st = foldAdvice(st, [a], { id: "sp_2", title: "Two" }, 20);
      st = foldAdvice(st, [a], { id: "sp_3", title: "Three" }, 30);
      expect(offered(st)).toEqual([]);
      st = foldAdvice(st, [a], { id: "sp_4", title: "Four" }, 40);
      expect(offered(st).map((o) => o.count)).toEqual([4]);
    }
    expect(decide(empty, "nope", true, 1)).toBeNull();
  });

  test("offers sort by count, then the newest", () => {
    let st = foldAdvice(empty, [{ key: "x", lesson: "x" }], { id: "sp_1", title: "One" }, 10);
    st = foldAdvice(st, [{ key: "y", lesson: "y" }], { id: "sp_2", title: "Two" }, 20);
    st = foldAdvice(st, [{ key: "x", lesson: "x" }], { id: "sp_3", title: "Three" }, 30);
    st = foldAdvice(st, [{ key: "z", lesson: "z" }], { id: "sp_4", title: "Four" }, 40);
    expect(offered(st).map((o) => o.key)).toEqual(["x", "z", "y"]);
  });

  test("the markdown lists every key, most repeated first, with what the user decided", () => {
    let st = foldAdvice(empty, [{ key: "x", lesson: "Lesson x.", file: "scout", edit: "+ a line" }], { id: "sp_1", title: "One" }, 10);
    st = foldAdvice(st, [{ key: "y", lesson: "Lesson y." }], { id: "sp_2", title: "Two" }, 20);
    st = foldAdvice(st, [{ key: "x", lesson: "Lesson x." }], { id: "sp_3", title: "Three" }, 30);
    st = decide(st, "y", false, 40) ?? st;
    const md = improvementsMd(st);
    expect(md.startsWith("# Incubator improvements")).toBe(true);
    expect(md.indexOf("x")).toBeLessThan(md.indexOf("Lesson y."));
    expect(md).toContain("Lesson x.");
    expect(md).toContain("2 projects");
    expect(md).toContain("scout");
    expect(md).toContain("+ a line");
    expect(md).toContain("dismissed");
  });
});

describe("when a retro comes due", () => {
  const parked = (patch: Partial<Sprout> = {}): Sprout => sprout({ status: "parked", parked: "deploy failed", parkedAt: 1_000, ...patch });

  test("a park with no live flow, a day on, once", () => {
    expect(parkRetroDue(parked(), 1_000 + RETRO_PARK_WAIT, false)).toBe(true);
    expect(parkRetroDue(parked(), 1_000 + RETRO_PARK_WAIT - 1, false)).toBe(false);
    expect(parkRetroDue(parked(), 1_000 + RETRO_PARK_WAIT, true)).toBe(false);
    // a park from before phase 5 has no parkedAt
    expect(parkRetroDue(parked({ parkedAt: undefined }), 1e15, false)).toBe(false);
    // one retro per park
    const had = parked({ retro: { for: "park", state: "done", at: 1_000 + RETRO_PARK_WAIT, flowsSeen: 1, tries: 1 } });
    expect(parkRetroDue(had, 1e15, false)).toBe(false);
    // a retro from before this park does not count
    const older = parked({ retro: { for: "park", state: "done", at: 500, flowsSeen: 1, tries: 1 } });
    expect(parkRetroDue(older, 1_000 + RETRO_PARK_WAIT, false)).toBe(true);
    expect(parkRetroDue(sprout({ parkedAt: 1 }), 1e15, false)).toBe(false);
  });

  test("an end, unless a stop follows a park retro with no flow run since", () => {
    expect(endRetroDue(sprout())).toBe(true);
    expect(endRetroDue(sprout({ status: "rejected" }))).toBe(true);
    expect(endRetroDue(sprout({ status: "parked" }))).toBe(false);
    const parkRetro = { for: "park" as const, state: "done" as const, at: 5, flowsSeen: 1, tries: 1 };
    expect(endRetroDue(sprout({ status: "stopped", retro: parkRetro }))).toBe(false);
    expect(endRetroDue(sprout({ status: "stopped", retro: { ...parkRetro, flowsSeen: 0 } }))).toBe(true);
    expect(endRetroDue(sprout({ status: "live", retro: parkRetro }))).toBe(true);
    expect(endRetroDue(sprout({ retro: { ...parkRetro, for: "end" } }))).toBe(false);
  });
});
