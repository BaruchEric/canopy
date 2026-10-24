import { describe, expect, test } from "bun:test";
import type { AgentCard } from "../../src/core/types";
import {
  boardCards,
  boardGroups,
  boardKey,
  boardOrder,
  focusOf,
  followTarget,
  keepShell,
  laneSegs,
  nextWaiting,
  nthCard,
  focusAwayAfter,
  planBoard,
  quickAnswers,
  recommendBoard,
  startedWaiting,
  stepLayout,
  TYPING_HOLD,
  wallColumns,
  type BoardGroup,
  type PlanOptions,
} from "./board";

let n = 0;
function card(over: Partial<AgentCard> = {}): AgentCard {
  n++;
  return {
    id: `claude:s${n}`,
    handle: `app-${n}`,
    node: "macmini-2018",
    harness: "claude",
    session: `s${n}`,
    origin: "elsewhere",
    cwd: "/dev/app",
    repo: "https://github.com/Me/App",
    branch: "main",
    model: null,
    mode: null,
    state: "idle",
    waiting: null,
    caps: [],
    offers: [],
    notifyIdle: false,
    where: { os: "linux", container: false, pid: 40 + n, term: null, canopy: null },
    transcript: null,
    startedAt: 1_000,
    seenAt: 2_000,
    endedAt: null,
    ...over,
  };
}

const opts = (over: Partial<PlanOptions> = {}): PlanOptions => ({ focus: null, width: 1600, narrow: false, focusOpen: false, focusAway: false, ...over });
const one = (cards: AgentCard[]): BoardGroup[] => [{ key: "", label: "", cards }];
const slotOf = (plan: ReturnType<typeof planBoard>, id: string) => plan.slots.find((s) => s.id === id);

describe("boardOrder", () => {
  test("waiting first with the longest wait first, then working, idle, lost, ended", () => {
    const ended = card({ state: "ended", endedAt: 5 });
    const idle = card({ state: "idle" });
    const late = card({ id: "late", state: "waiting" });
    const early = card({ id: "early", state: "waiting" });
    const work = card({ state: "working" });
    const lost = card({ state: "lost" });
    const trail = { late: [{ state: "waiting" as const, at: 900 }], early: [{ state: "waiting" as const, at: 100 }] };
    expect(boardOrder([ended, idle, late, early, work, lost], trail).map((c) => c.id)).toEqual(["early", "late", work.id, idle.id, lost.id, ended.id]);
  });
});

describe("boardCards", () => {
  test("keeps the running and the recently stopped", () => {
    const now = 10 * 3_600_000;
    const live = card({ state: "working" });
    const fresh = card({ state: "ended", endedAt: now - 60_000 });
    const old = card({ state: "ended", endedAt: now - 5 * 3_600_000 });
    expect(boardCards([live, fresh, old], now).map((c) => c.id)).toEqual([live.id, fresh.id]);
  });
});

describe("boardGroups", () => {
  test("one nameless group, or groups by machine", () => {
    const a = card({ node: "mac" });
    const b = card({ node: "gpd", state: "working" });
    expect(boardGroups([a, b], "none", {})).toEqual([{ key: "", label: "", cards: [b, a] }]);
    expect(boardGroups([a, b], "machine", {}).map((g) => g.label)).toEqual(["gpd", "mac"]);
    expect(boardGroups([], "none", {})).toEqual([]);
  });
});

describe("focusOf", () => {
  test("the picked card while it is there, else the first", () => {
    const [a, b] = [card(), card()];
    expect(focusOf([a, b], b.id)).toBe(b.id);
    expect(focusOf([a, b], "gone")).toBe(a.id);
    expect(focusOf([], null)).toBeNull();
  });
});

describe("planBoard", () => {
  const cards = () => [card({ state: "waiting" }), card({ state: "working" }), card({ state: "working" }), card({ state: "idle" }), card({ state: "ended", endedAt: 3 })];

  test("rail: every other card a row with answers, the focus spanning the second track", () => {
    const cs = cards();
    const plan = planBoard("rail", one(cs), opts({ focus: cs[1]!.id }));
    expect(slotOf(plan, cs[1]!.id)).toEqual({ id: cs[1]!.id, area: "1 / 2 / 6 / 3", mode: "term", acts: false });
    expect(slotOf(plan, cs[0]!.id)).toEqual({ id: cs[0]!.id, area: "1 / 1 / 2 / 2", mode: "row", acts: true });
    expect(plan.rows).toBe("max-content max-content max-content max-content 1fr");
  });

  test("every layout places every card exactly once", () => {
    const cs = cards();
    for (const l of ["rail", "wall", "spotlight", "dashboard", "triage", "lanes"] as const) {
      const plan = planBoard(l, one(cs), opts());
      expect(plan.slots.map((s) => s.id).sort()).toEqual(cs.map((c) => c.id).sort());
    }
  });

  test("rail grouped: a heading before each group's rows", () => {
    const a = card({ node: "mac" });
    const b = card({ node: "gpd" });
    const c = card({ node: "gpd" });
    const groups = boardGroups([a, b, c], "machine", {});
    const plan = planBoard("rail", groups, opts({ focus: a.id }));
    expect(plan.furn.map((f) => [f.label, f.area])).toEqual([["gpd", "1 / 1 / 2 / 2"]]);
    expect(slotOf(plan, b.id)?.area).toBe("2 / 1 / 3 / 2");
  });

  test("wall: columns fit the width and rows fill in order", () => {
    expect(wallColumns(9, 2000)).toBe(3);
    expect(wallColumns(9, 700)).toBe(2);
    expect(wallColumns(1, 2000)).toBe(1);
    const cs = cards();
    const plan = planBoard("wall", one(cs), opts({ width: 2000 }));
    expect(plan.columns).toBe("repeat(3, minmax(0, 1fr))");
    expect(slotOf(plan, cs[3]!.id)?.area).toBe("2 / 1 / 3 / 2");
    expect(plan.slots.every((s) => s.mode === "term")).toBe(true);
  });

  test("spotlight: the focus takes the 3 by 3 block, a lone card the whole board", () => {
    const cs = cards();
    const plan = planBoard("spotlight", one(cs), opts({ focus: cs[3]!.id }));
    expect(slotOf(plan, cs[3]!.id)?.area).toBe("1 / 1 / 4 / 4");
    expect(slotOf(plan, cs[0]!.id)?.area).toBe("1 / 4 / 3 / 7");
    expect(plan.slots.every((s) => s.mode === "term")).toBe(true);
    expect(slotOf(plan, cs[3]!.id)?.acts).toBe(false);
    expect(slotOf(plan, cs[0]!.id)?.acts).toBe(true);
    const solo = planBoard("spotlight", one([cs[0]!]), opts());
    expect(solo.slots).toEqual([{ id: cs[0]!.id, area: "1 / 1 / 2 / 2", mode: "term", acts: false }]);
  });

  test("spotlight: past eight, chips below", () => {
    const cs = Array.from({ length: 10 }, () => card());
    const plan = planBoard("spotlight", one(cs), opts());
    expect(slotOf(plan, cs[9]!.id)).toEqual({ id: cs[9]!.id, area: "5 / 2 / 6 / 3", mode: "chip", acts: false });
    expect(plan.rows).toBe("repeat(4, minmax(0, 1fr)) max-content");
  });

  test("dashboard: waits as rows on the left, work as tiles, the rest as chips under a heading", () => {
    const cs = cards();
    const plan = planBoard("dashboard", one(cs), opts());
    expect(slotOf(plan, cs[0]!.id)).toEqual({ id: cs[0]!.id, area: "3 / 1 / 4 / 3", mode: "row", acts: true });
    expect(slotOf(plan, cs[1]!.id)?.area).toBe("3 / 3 / 5 / 5");
    expect(slotOf(plan, cs[2]!.id)?.area).toBe("3 / 5 / 5 / 7");
    expect(slotOf(plan, cs[4]!.id)?.mode).toBe("chip");
    expect(plan.furn.map((f) => f.key)).toEqual(["summary", "h:waiting", "h:working", "h:rest"]);
    expect(plan.furn.find((f) => f.key === "h:rest")?.area).toBe("5 / 1 / 6 / 7");
    expect(plan.rows).toBe("max-content max-content max-content minmax(4.75rem, 1fr) max-content max-content");
  });

  test("dashboard: three waits beside one band of work stack at their height", () => {
    const cs = [card({ state: "waiting" }), card({ state: "waiting" }), card({ state: "waiting" }), card({ state: "working" })];
    const plan = planBoard("dashboard", one(cs), opts());
    expect(slotOf(plan, cs[2]!.id)?.area).toBe("5 / 1 / 6 / 3");
    expect(slotOf(plan, cs[3]!.id)?.area).toBe("3 / 3 / 7 / 5");
    expect(plan.rows).toBe("max-content max-content max-content max-content max-content minmax(4.75rem, 1fr)");
  });

  test("dashboard: past one band, the waits and the work share the region", () => {
    const cs = [card({ state: "waiting" }), ...Array.from({ length: 3 }, () => card({ state: "working" }))];
    const plan = planBoard("dashboard", one(cs), opts());
    expect(slotOf(plan, cs[3]!.id)?.area).toBe("5 / 3 / 7 / 5");
    expect(plan.rows).toBe("max-content max-content minmax(4.75rem, 1fr) minmax(4.75rem, 1fr) minmax(4.75rem, 1fr) minmax(4.75rem, 1fr)");
  });

  test("triage: a column per state, counted in its head", () => {
    const cs = cards();
    const plan = planBoard("triage", one(cs), opts());
    expect(slotOf(plan, cs[2]!.id)?.area).toBe("3 / 2 / 4 / 3");
    expect(slotOf(plan, cs[4]!.id)?.area).toBe("2 / 4 / 3 / 5");
    expect(plan.furn.map((f) => f.count)).toEqual([1, 2, 1, 1]);
  });

  test("triage grouped: swimlanes, each as deep as its fullest column", () => {
    const a = card({ node: "mac", state: "working" });
    const b = card({ node: "mac", state: "working" });
    const c = card({ node: "gpd", state: "idle" });
    const plan = planBoard("triage", boardGroups([a, b, c], "machine", {}), opts());
    expect(plan.rows).toBe("max-content max-content max-content max-content max-content max-content 1fr");
    expect(slotOf(plan, c.id)?.area).toBe("6 / 3 / 7 / 4");
  });

  test("lanes: a row each across both tracks, the axis on top", () => {
    const cs = cards();
    const plan = planBoard("lanes", one(cs), opts());
    expect(slotOf(plan, cs[0]!.id)).toEqual({ id: cs[0]!.id, area: "2 / 1 / 3 / 3", mode: "lane", acts: false });
    expect(plan.furn[0]?.kind).toBe("axis");
  });

  test("narrow: the rail is a list until an agent opens, then that agent alone", () => {
    const cs = cards();
    const list = planBoard("rail", one(cs), opts({ narrow: true, focus: cs[1]!.id }));
    expect(list.columns).toBe("minmax(0, 1fr)");
    expect(list.slots.every((s) => s.mode === "row")).toBe(true);
    const open = planBoard("rail", one(cs), opts({ narrow: true, focusOpen: true, focus: cs[1]!.id }));
    expect(open.slots.filter((s) => s.mode !== "hidden")).toEqual([{ id: cs[1]!.id, area: "1 / 1 / 2 / 2", mode: "term", acts: false }]);
  });

  test("narrow triage: each state's head over its rows", () => {
    const cs = cards();
    const plan = planBoard("triage", one(cs), opts({ narrow: true }));
    expect(plan.furn.map((f) => f.area)).toEqual(["1 / 1 / 2 / 2", "3 / 1 / 4 / 2", "6 / 1 / 7 / 2", "8 / 1 / 9 / 2"]);
  });

  test("the focus away: the rail takes the whole board", () => {
    const cs = cards();
    const plan = planBoard("rail", one(cs), opts({ focusAway: true }));
    expect(plan.columns).toBe("minmax(0, 1fr)");
    expect(plan.slots.every((s) => s.mode === "row")).toBe(true);
  });

  test("nothing to show", () => {
    expect(planBoard("wall", [], opts()).slots).toEqual([]);
  });
});

describe("keys", () => {
  test("next waiting goes round the waits in order", () => {
    const [a, b, c] = [card({ state: "waiting" }), card({ state: "working" }), card({ state: "waiting" })];
    expect(nextWaiting([a, b, c], null)).toBe(a.id);
    expect(nextWaiting([a, b, c], a.id)).toBe(c.id);
    expect(nextWaiting([a, b, c], c.id)).toBe(a.id);
    expect(nextWaiting([b], b.id)).toBeNull();
  });

  test("a number is a place, counted from one", () => {
    const [a, b] = [card(), card()];
    expect(nthCard([a, b], 2)).toBe(b.id);
    expect(nthCard([a, b], 3)).toBeNull();
  });

  test("layouts step round", () => {
    expect(stepLayout("rail", -1)).toBe("lanes");
    expect(stepLayout("lanes", 1)).toBe("rail");
  });

  test("boardKey leaves modified keys and fields alone", () => {
    const k = (key: string, over = {}) => ({ key, metaKey: false, ctrlKey: false, altKey: false, ...over });
    expect(boardKey(k("w"), false)).toBe("next");
    expect(boardKey(k("3"), false)).toBe(3);
    expect(boardKey(k("w"), true)).toBeNull();
    expect(boardKey(k("w", { metaKey: true }), false)).toBeNull();
    expect(boardKey(k("0"), false)).toBeNull();
  });
});

describe("follow", () => {
  test("a card that starts waiting, or takes a new wait", () => {
    const a = card({ state: "working" });
    const b = card({ state: "waiting", waiting: "x" });
    const before = { [a.id]: a, [b.id]: b };
    const a2 = { ...a, state: "waiting" as const, seenAt: 9 };
    const b2 = { ...b, waiting: "y", seenAt: 5 };
    expect(startedWaiting(before, { [a.id]: a2, [b.id]: b2 })).toEqual([a.id, b.id]);
    expect(startedWaiting(before, before)).toEqual([]);
  });

  test("holds off while typing, skips one no longer waiting", () => {
    const a = card({ state: "waiting" });
    const b = card({ state: "working" });
    const cards = { [a.id]: a, [b.id]: b };
    expect(followTarget([b.id, a.id], cards, 0, 10_000)).toBe(a.id);
    expect(followTarget([a.id], cards, 9_000, 9_000 + TYPING_HOLD - 1)).toBeNull();
  });
});

describe("keepShell", () => {
  test("the newest first, at most three", () => {
    expect(keepShell(["a", "b", "c"], "d")).toEqual(["d", "a", "b"]);
    expect(keepShell(["a", "b"], "b")).toEqual(["b", "a"]);
  });
});

describe("quickAnswers", () => {
  test("allow and deny a permission", () => {
    expect(quickAnswers({ kind: "permission" })?.map((a) => a.label)).toEqual(["allow", "deny"]);
  });

  test("a single one-choice question's options; anything more needs the form", () => {
    const q = { question: "Port?", header: "port", multiSelect: false, options: [{ label: "8080", description: "" }, { label: "9000", description: "" }] };
    expect(quickAnswers({ kind: "question", questions: [q] })?.[1]?.answer).toEqual({ answers: { "Port?": "9000" } });
    expect(quickAnswers({ kind: "question", questions: [q, q] })).toBeNull();
    expect(quickAnswers({ kind: "question", questions: [{ ...q, multiSelect: true }] })).toBeNull();
  });
});

describe("laneSegs", () => {
  test("seen until the first mark, then the states marked", () => {
    const c = card({ state: "working", startedAt: 100 });
    const segs = laneSegs(c, [{ state: "waiting", at: 300 }, { state: "working", at: 500 }], 0, 1000);
    expect(segs).toEqual([
      { from: 100, to: 300, state: "seen" },
      { from: 300, to: 500, state: "waiting" },
      { from: 500, to: 1000, state: "working" },
    ]);
  });

  test("a lost card runs on as lost from its last beat", () => {
    const c = card({ state: "lost", startedAt: 100, seenAt: 400 });
    expect(laneSegs(c, [{ state: "working", at: 100 }], 0, 1000)).toEqual([
      { from: 100, to: 400, state: "working" },
      { from: 400, to: 1000, state: "lost" },
    ]);
  });

  test("cut at the timeline's start", () => {
    const c = card({ state: "idle", startedAt: 100 });
    expect(laneSegs(c, [], 500, 900)).toEqual([{ from: 500, to: 900, state: "seen" }]);
  });
});

describe("recommendBoard", () => {
  test("the wall on every screen", () => {
    expect(recommendBoard(3840, 1600)).toBe("wall");
    expect(recommendBoard(1512, 982)).toBe("wall");
    expect(recommendBoard(390, 844)).toBe("wall");
  });
});

describe("focusAwayAfter", () => {
  const P = "/agent-focus";
  test("out on the pane's hello, back on its bye or a return, and deaf to other panes", () => {
    expect(focusAwayAfter(false, { type: "hello", id: P }, P)).toBe(true);
    expect(focusAwayAfter(true, { type: "bye", id: P }, P)).toBe(false);
    expect(focusAwayAfter(true, { type: "return", id: P }, P)).toBe(false);
    expect(focusAwayAfter(true, { type: "close", id: P }, P)).toBe(false);
    expect(focusAwayAfter(true, { type: "show", id: P, card: "a" }, P)).toBe(true);
    expect(focusAwayAfter(true, { type: "who" }, P)).toBe(true);
    expect(focusAwayAfter(false, { type: "hello", id: "app" }, P)).toBe(false);
    expect(focusAwayAfter(true, { type: "bye", id: "app" }, P)).toBe(true);
    expect(focusAwayAfter(true, null, P)).toBe(true);
  });
});

describe("boardOrder and sessions", () => {
  const ran = (run: string): AgentCard["where"] => ({ os: "linux", container: true, pid: 9, term: null, canopy: { backend: "mac", run } });
  const job = card({ id: "job", origin: "canopy-run", state: "waiting", where: ran("r1") });
  const chatty = card({ id: "chat", origin: "canopy-run", state: "working", where: ran("r2") });
  const coord = card({ id: "coord", origin: "canopy-run", state: "idle", where: ran("r3") });
  const shell = card({ id: "shell", origin: "canopy-shell", state: "idle" });
  const term = card({ id: "term", origin: "elsewhere", state: "waiting" });
  const gone = card({ id: "gone", origin: "canopy-shell", state: "ended", endedAt: 5 });
  const chat = (c: AgentCard) => c.id === "chat";
  const ids = (cards: readonly AgentCard[]) => cards.map((c) => c.id);

  test("running sessions first, then runs at work or waiting, then the rest", () => {
    expect(ids(boardOrder([gone, coord, chatty, job, shell], {}))).toEqual(["shell", "job", "chat", "coord", "gone"]);
    expect(ids(boardOrder([gone, coord, chatty, job, shell], {}, chat))).toEqual(["chat", "shell", "job", "coord", "gone"]);
  });

  test("groups keep the order, and w takes a session's wait before an older run's", () => {
    expect(ids(boardGroups([job, shell, chatty], "none", {}, chat)[0]!.cards)).toEqual(["chat", "shell", "job"]);
    expect(ids(boardGroups([job, shell, chatty], "repo", {}, chat)[0]!.cards)).toEqual(["chat", "shell", "job"]);
    const trail = { job: [{ state: "waiting" as const, at: 100 }], term: [{ state: "waiting" as const, at: 900 }] };
    const order = boardOrder([job, term], trail);
    expect(nextWaiting(order, null)).toBe("term");
    expect(nextWaiting(order, "term")).toBe("job");
  });
});
