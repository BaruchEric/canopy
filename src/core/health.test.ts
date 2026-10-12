import { describe, expect, test } from "bun:test";
import { HEAL_MAX, HISTORY_MAX, fail, healDelay, healFailed, isBad, manualHeal, newCheck, observe, pass, summary, type HealthTimings } from "./health";
import type { HealMode, HealthCheck } from "./types";

const T: HealthTimings = { base: 1000, cap: 60_000, resetAfter: 300_000, healMax: HEAL_MAX };
const make = (heal: HealMode = "auto", now = 0): HealthCheck =>
  newCheck({ id: "canopy:x", label: "x", scope: { kind: "canopy" }, heal, button: heal === "auto" || heal === "button" }, now);

describe("newCheck", () => {
  test("starts unknown with nothing on record", () => {
    const c = make("auto", 5);
    expect(c.state).toBe("unknown");
    expect(c.since).toBe(5);
    expect(c.lastOk).toBeNull();
    expect(c.fails).toBe(0);
    expect(c.history).toEqual([]);
  });
});

describe("healDelay", () => {
  test("1 s doubling, capped at a minute", () => {
    expect([0, 1, 2, 3, 4, 5, 6, 7].map((n) => healDelay(n, T))).toEqual([1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000]);
  });
});

describe("observe", () => {
  test("a pass is ok, with lastOk and a history entry", () => {
    const { check, action } = observe(make(), pass("200 in 4ms"), 10, T);
    expect(check.state).toBe("ok");
    expect(check.lastOk).toBe(10);
    expect(check.detail).toBe("200 in 4ms");
    expect(check.history).toEqual([{ at: 10, state: "ok", why: null }]);
    expect(action).toBeNull();
  });

  test("a failure on a check nothing here heals is down", () => {
    const { check, action } = observe(make("none"), fail("gone"), 10, T);
    expect(check.state).toBe("down");
    expect(check.why).toBe("gone");
    expect(check.nextHeal).toBeNull();
    expect(action).toBeNull();
  });

  test("a failure on an auto check schedules a heal", () => {
    const { check, action } = observe(make("auto"), fail("gone"), 10, T);
    expect(check.state).toBe("healing");
    expect(check.nextHeal).toBe(1010);
    expect(action).toBe("heal");
  });

  test("a second failure while a heal is pending asks for nothing more", () => {
    const first = observe(make("auto"), fail("gone"), 10, T).check;
    const { check, action } = observe(first, fail("still"), 20, T);
    expect(check.state).toBe("healing");
    expect(check.nextHeal).toBe(1010);
    expect(check.why).toBe("still");
    expect(action).toBeNull();
  });

  test("history moves only on a change of state", () => {
    let c = make("none");
    c = observe(c, fail("a"), 1, T).check;
    c = observe(c, fail("b"), 2, T).check;
    c = observe(c, pass(), 3, T).check;
    expect(c.history.map((h) => h.state)).toEqual(["down", "ok"]);
    expect(c.since).toBe(3);
  });

  test("history keeps the newest HISTORY_MAX", () => {
    let c = make("none");
    for (let i = 0; i < HISTORY_MAX + 5; i++) c = observe(c, i % 2 === 0 ? pass() : fail("x"), i, T).check;
    expect(c.history).toHaveLength(HISTORY_MAX);
    expect(c.history.at(-1)?.at).toBe(HISTORY_MAX + 4);
  });

  test("off is never counted, and clears the fails", () => {
    const c = { ...make("auto"), fails: 3, state: "healing" as const, nextHeal: 99 };
    const { check, action } = observe(c, { state: "off" }, 10, T);
    expect(check.state).toBe("off");
    expect(check.fails).toBe(0);
    expect(check.nextHeal).toBeNull();
    expect(check.why).toBeNull();
    expect(action).toBeNull();
  });

  test("a piece restarting itself reads as healing on any mode", () => {
    const { check, action } = observe(make("self"), { state: "healing", why: "backoff" }, 10, T);
    expect(check.state).toBe("healing");
    expect(action).toBeNull();
  });

  test("a piece that gave up on its own is gave-up, with no escalation of ours", () => {
    const { check, action } = observe(make("self"), { state: "gave-up", why: "exited 5 times" }, 10, T);
    expect(check.state).toBe("gave-up");
    expect(action).toBeNull();
  });

  test("a failure after giving up stays given up and asks nothing", () => {
    const c = { ...make("auto"), state: "gave-up" as const, fails: HEAL_MAX };
    const { check, action } = observe(c, fail("x"), 10, T);
    expect(check.state).toBe("gave-up");
    expect(action).toBeNull();
  });

  test("a pass after giving up clears the fails", () => {
    const c = { ...make("auto"), state: "gave-up" as const, fails: HEAL_MAX };
    expect(observe(c, pass(), 10, T).check.fails).toBe(0);
  });

  test("fails survive a short spell of ok, and reset after RESET_AFTER", () => {
    let c: HealthCheck = { ...make("auto"), state: "healing", fails: 3, nextHeal: 5 };
    c = observe(c, pass(), 100, T).check;
    expect(c.fails).toBe(3);
    const soon = observe(c, fail("x"), 200, T);
    expect(soon.check.nextHeal).toBe(200 + healDelay(3, T));
    c = observe(c, pass(), 100 + T.resetAfter, T).check;
    expect(c.fails).toBe(0);
  });
});

describe("healFailed", () => {
  test("counts each failed heal, and gives up once at HEAL_MAX", () => {
    let c = observe(make("auto"), fail("gone"), 0, T).check;
    const actions: (string | null)[] = [];
    for (let i = 0; i < HEAL_MAX; i++) {
      const r = healFailed(c, "still gone", i * 100, T);
      c = r.check;
      actions.push(r.action);
    }
    expect(c.state).toBe("gave-up");
    expect(c.fails).toBe(HEAL_MAX);
    expect(c.nextHeal).toBeNull();
    expect(actions.filter((a) => a === "escalate")).toHaveLength(1);
    expect(actions.at(-1)).toBe("escalate");
    expect(actions.slice(0, -1).every((a) => a === "heal")).toBe(true);
  });

  test("schedules the next heal on the backoff curve", () => {
    const c = observe(make("auto"), fail("gone"), 0, T).check;
    const r = healFailed(c, "x", 50, T);
    expect(r.check.fails).toBe(1);
    expect(r.check.nextHeal).toBe(50 + 2000);
  });
});

test("a failed heal by hand on a button check is down, and schedules nothing", () => {
  const c = { ...make("button"), state: "healing" as const, nextHeal: 0 };
  const r = healFailed(c, "still held", 10, T);
  expect(r.check.state).toBe("down");
  expect(r.check.nextHeal).toBeNull();
  expect(r.action).toBeNull();
});

describe("manualHeal", () => {
  test("clears a give-up", () => {
    const c = { ...make("auto"), state: "gave-up" as const, fails: HEAL_MAX, why: "x" };
    const m = manualHeal(c, 10);
    expect(m.state).toBe("healing");
    expect(m.fails).toBe(0);
    expect(m.history.at(-1)).toEqual({ at: 10, state: "healing", why: "x" });
  });
});

describe("summary", () => {
  const at = (state: HealthCheck["state"], label: string = state, since = 0): HealthCheck => ({ ...make("none"), id: label, label, state, since });
  test("all well is ok", () => {
    expect(summary([at("ok"), at("off")], 0)).toEqual({ level: "ok", word: "ok", title: "every check is well", count: 0 });
  });
  test("any down or gave-up is bad, counted", () => {
    const s = summary([at("ok"), at("down", "tmux"), at("gave-up", "watch")], 0);
    expect(s.level).toBe("bad");
    expect(s.count).toBe(2);
    expect(s.word).toBe("2 down");
    expect(s.title).toContain("tmux");
  });
  test("healing is a warning", () => {
    expect(summary([at("healing", "tailchan")], 0)).toMatchObject({ level: "warn", count: 1, word: "1 healing" });
  });
  test("unknown warns only after a minute", () => {
    expect(summary([at("unknown", "u", 0)], 30_000).level).toBe("ok");
    expect(summary([at("unknown", "u", 0)], 61_000).level).toBe("warn");
  });
  test("isBad", () => {
    expect(isBad(at("down"))).toBe(true);
    expect(isBad(at("gave-up"))).toBe(true);
    expect(isBad(at("healing"))).toBe(false);
  });
});
