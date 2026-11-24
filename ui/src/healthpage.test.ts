import { describe, expect, test } from "bun:test";
import { HISTORY_MAX } from "../../src/core/health";
import type { HealthCheck, HealthEvent } from "../../src/core/types";
import { backendWord, cellWord, changes, changeWord, listWords, pageBackends, pageSections, pageWindow, record, stretchAt, troubles, verdict, worstOf, WINDOW_MAX, WINDOW_MIN, type PageBackend } from "./healthpage";

const ev = (at: number, state: HealthEvent["state"], why: string | null = null): HealthEvent => ({ at, state, why });

const check = (id: string, history: HealthEvent[], over: Partial<HealthCheck> = {}): HealthCheck => {
  const last = history[history.length - 1];
  return {
    id,
    label: id,
    scope: { kind: "canopy" },
    state: last?.state ?? "unknown",
    why: last?.why ?? null,
    since: last?.at ?? 0,
    lastOk: null,
    heal: "none",
    fails: 0,
    nextHeal: null,
    button: false,
    history,
    ...over,
  };
};

const repo = (repoId: string) => ({ scope: { kind: "repo" as const, repoId } });
const online = { status: { state: "online" } };
const names = (id: string) => id.replace(/^\w+:/, "");
const backend = (name: string, checks: HealthCheck[]): PageBackend => ({ name, away: null, checks, since: Math.min(...checks.map((c) => c.history[0]?.at ?? c.since)) });

describe("record", () => {
  test("nothing before the first record, and the last stretch runs to the end", () => {
    const c = check("a", [ev(100, "ok"), ev(200, "down", "refused"), ev(250, "ok")]);
    expect(record(c, 0, 400)).toEqual([
      { from: 100, to: 200, state: "ok", why: null },
      { from: 200, to: 250, state: "down", why: "refused" },
      { from: 250, to: 400, state: "ok", why: null },
    ]);
  });

  test("clipped to the window, dropping what ended before it", () => {
    const c = check("a", [ev(100, "down", "x"), ev(200, "ok"), ev(300, "healing", "y")]);
    expect(record(c, 220, 320).map((s) => [s.from, s.to, s.state])).toEqual([
      [220, 300, "ok"],
      [300, 320, "healing"],
    ]);
  });

  test("the last stretch takes the check's fresher why", () => {
    const c = check("a", [ev(100, "down", "old")], { why: "new" });
    expect(record(c, 0, 200)[0]?.why).toBe("new");
  });

  test("a check with no history and no answer has no record", () => {
    expect(record(check("a", [], { state: "unknown", since: 5 }), 0, 100)).toEqual([]);
    expect(record(check("a", [], { state: "down", since: 50, why: "w" }), 0, 100)).toEqual([{ from: 50, to: 100, state: "down", why: "w" }]);
  });
});

describe("worstOf", () => {
  test("the worst state at every moment, joined where it holds", () => {
    const a = record(check("a", [ev(0, "ok"), ev(40, "down", "x"), ev(60, "ok")]), 0, 100);
    const b = record(check("b", [ev(20, "ok"), ev(50, "healing", "h"), ev(80, "ok")]), 0, 100);
    expect(worstOf([a, b]).map((s) => [s.from, s.to, s.state])).toEqual([
      [0, 40, "ok"],
      [40, 60, "down"],
      [60, 80, "healing"],
      [80, 100, "ok"],
    ]);
  });

  test("off never outweighs ok, and a gap stays a gap", () => {
    const a = record(check("a", [ev(10, "off")]), 0, 100);
    const b = record(check("b", [ev(50, "ok")]), 0, 100);
    expect(worstOf([a, b]).map((s) => [s.from, s.to, s.state])).toEqual([
      [10, 50, "off"],
      [50, 100, "ok"],
    ]);
    expect(worstOf([[{ from: 0, to: 10, state: "ok", why: null }], [{ from: 20, to: 30, state: "ok", why: null }]]).map((s) => [s.from, s.to])).toEqual([
      [0, 10],
      [20, 30],
    ]);
  });

  test("stretchAt finds the stretch under a moment", () => {
    const r = record(check("a", [ev(0, "ok"), ev(50, "down", "x")]), 0, 100);
    expect(stretchAt(r, 70)?.state).toBe("down");
    expect(stretchAt(r, 120)).toBeNull();
  });
});

describe("pageBackends and pageWindow", () => {
  test("an away backend has no checks, and the window reaches its oldest record", () => {
    const now = 10 * 3_600_000;
    const bs = pageBackends(
      { mac: [check("a", [ev(now - 3_600_000, "ok")])], mini: [check("b", [ev(now - 60_000, "ok")])] },
      ["mini", "mac", "desoto"],
      { mac: online, mini: online, desoto: { status: { state: "offline", reason: "timed out" } } },
    );
    expect(bs.map((b) => [b.name, b.away, b.checks.length])).toEqual([
      ["mini", null, 1],
      ["mac", null, 1],
      ["desoto", "offline: timed out", 0],
    ]);
    expect(pageWindow(bs, now)).toEqual({ from: now - 3_600_000, to: now });
  });

  test("the window is at least two minutes and at most a day", () => {
    const now = 100 * 3_600_000;
    expect(pageWindow([backend("a", [check("x", [ev(now - 1000, "ok")])])], now).from).toBe(now - WINDOW_MIN);
    expect(pageWindow([backend("a", [check("x", [ev(0, "ok")])])], now).from).toBe(now - WINDOW_MAX);
    expect(pageWindow([], now).from).toBe(now - WINDOW_MIN);
  });
});

describe("pageSections", () => {
  test("the server first, then repos by name, a check joined across backends by section and label", () => {
    const mac = backend("mac", [
      check("canopy:t", [ev(0, "ok")], { label: "tailchan" }),
      check("repo:mac:/a/ripe:dev", [ev(0, "ok")], { label: "dev", ...repo("mac:/a/ripe") }),
      check("repo:mac:/a/home:dev", [ev(0, "ok")], { label: "dev", ...repo("mac:/a/home") }),
    ]);
    const mini = backend("mini", [
      check("canopy:t", [ev(0, "down", "x")], { label: "tailchan" }),
      check("repo:mini:/b/ripe:dev", [ev(0, "ok")], { label: "dev", ...repo("mini:/b/ripe") }),
    ]);
    const { sections } = pageSections([mac, mini], (id) => id.split("/").pop() ?? id);
    expect(sections.map((s) => s.title)).toEqual(["server", "home", "ripe"]);
    expect(sections[0]?.rows[0]?.cells.mini?.state).toBe("down");
    expect(Object.keys(sections[2]?.rows[0]?.cells ?? {})).toEqual(["mac", "mini"]);
    expect(Object.keys(sections[1]?.rows[0]?.cells ?? {})).toEqual(["mac"]);
  });

  test("a check off wherever it runs goes to the foot, and an emptied section goes", () => {
    const mac = backend("mac", [check("canopy:p", [ev(0, "off", "no browser")], { label: "push" }), check("repo:r:site", [ev(0, "off")], { label: "site", ...repo("mac:r") })]);
    const mini = backend("mini", [check("canopy:p", [ev(0, "ok")], { label: "push" })]);
    const { sections, off } = pageSections([mac, mini], names);
    expect(sections.map((s) => s.title)).toEqual(["server"]);
    expect(off.map((r) => `${r.where}/${r.label}`)).toEqual(["r/site"]);
  });
});

describe("troubles and verdict", () => {
  const now = 1_000_000;
  test("down before healing, and a check silent past a minute counts", () => {
    const b = backend("mac", [
      check("h", [ev(now - 10, "healing", "restarting")]),
      check("d", [ev(now - 10, "down", "refused")]),
      check("ok", [ev(now - 10, "ok")]),
      check("q", [], { state: "unknown", since: now - 120_000 }),
      check("fresh", [], { state: "unknown", since: now - 1000 }),
    ]);
    expect(troubles([b], names, now).map((t) => t.check.id)).toEqual(["d", "h", "q"]);
  });

  test("well, down, offline and healing say so", () => {
    const well = backend("mac", [check("a", [ev(0, "ok")]), check("b", [ev(0, "off")])]);
    expect(verdict([well], [])).toEqual({ level: "ok", head: "Every check is well", sub: "1 check on mac, and 1 more is off." });

    const sick = backend("mini", [check("a", [ev(0, "down", "x")]), check("b", [ev(0, "down", "y")])]);
    const gone: PageBackend = { name: "desoto", away: "offline: timed out", checks: [], since: null };
    const v = verdict([well, sick, gone], troubles([well, sick, gone], names, now));
    expect(v.level).toBe("bad");
    expect(v.head).toBe("2 checks are down");
    expect(v.sub).toBe("3 checks on mac and mini, and 1 more is off. desoto is offline.");

    expect(verdict([well, gone], [])).toMatchObject({ level: "bad", head: "desoto is offline" });

    const heal = backend("mac", [check("a", [ev(0, "healing", "x")])]);
    expect(verdict([heal], troubles([heal], names, now))).toMatchObject({ level: "warn", head: "1 check is healing" });
  });

  test("a backend's word and a cell's", () => {
    expect(backendWord(backend("mac", [check("a", [ev(0, "ok")])]), 0)).toEqual({ text: "all well", tone: "moss" });
    expect(backendWord(backend("mac", [check("a", [ev(0, "down")])]), 0)).toEqual({ text: "1 down", tone: "rust" });
    expect(backendWord({ name: "x", away: "connecting", checks: [], since: null }, 0).tone).toBe("lichen");
    expect(cellWord(check("a", [ev(0, "ok")]), 10)).toBe("");
    expect(cellWord(check("a", [ev(0, "down")]), 180_000)).toBe("down 3m");
  });

  test("listWords joins names as a sentence does", () => {
    expect(listWords(["mac"])).toBe("mac");
    expect(listWords(["mac", "mini"])).toBe("mac and mini");
    expect(listWords(["mac", "mini", "desoto"])).toBe("mac, mini and desoto");
  });
});

describe("changes", () => {
  test("newest first, leaving out where a record begins", () => {
    const b = backend("mac", [check("a", [ev(10, "ok"), ev(20, "down", "refused"), ev(30, "ok")]), check("b", [ev(5, "off")]), check("c", [ev(15, "down", "never up")])]);
    const log = changes([b], names);
    expect(log.map((c) => [c.at, c.label, changeWord(c)])).toEqual([
      [30, "a", "came back"],
      [20, "a", "went down"],
      [15, "c", "started down"],
    ]);
  });

  test("a full history's first entry is a change whose start fell off", () => {
    const history = Array.from({ length: HISTORY_MAX }, (_, i) => ev(i, i % 2 === 0 ? "ok" : "down", null));
    expect(changes([backend("mac", [check("a", history)])], names)).toHaveLength(HISTORY_MAX);
  });
});
