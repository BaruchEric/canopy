import { describe, expect, test } from "bun:test";
import { ericsCrons, rangerCard, rangerLine, rangerTone, shownRangers, sizeWord, wakeWhen, worstTone } from "./ranger";
import { RANGER_DEFAULTS } from "../../src/core/ranger";
import type { AgentCard, RangerInfo } from "../../src/core/types";

const info = (over: Partial<RangerInfo> = {}): RangerInfo => ({
  on: true,
  state: "running",
  term: "0".repeat(32),
  handle: "ranger",
  backend: "mini",
  root: "/home/eric/dev",
  home: "/config/ranger/home",
  session: "35adf21d-777e-428a-aec9-639404e23258",
  transcript: null,
  fails: 0,
  restarts: 0,
  telegram: "off",
  settings: { ...RANGER_DEFAULTS, on: true },
  wakes: [],
  viewers: [],
  broker: true,
  ...over,
});

const card = (over: Partial<AgentCard>): AgentCard =>
  ({ id: "claude:x", handle: "ranger", session: "35adf21d-777e-428a-aec9-639404e23258", state: "idle", waiting: null, ...over }) as AgentCard;

describe("the ranger's words", () => {
  test("tone: fine running, on its way, or needing someone", () => {
    expect(rangerTone(info())).toBe("ok");
    expect(rangerTone(info(), card({ state: "waiting" }))).toBe("warn");
    expect(rangerTone(info({ state: "backoff" }))).toBe("busy");
    expect(rangerTone(info({ state: "gave-up" }))).toBe("warn");
    expect(rangerTone(info({ on: false, state: "off" }))).toBe("off");
    expect(worstTone(["ok", "busy", "ok"])).toBe("busy");
    expect(worstTone([])).toBe("off");
  });

  test("the chip shows each backend's ranger that is on, in the page's order", () => {
    const rangers = { mac: info({ backend: "mac" }), mini: info(), old: info({ on: false, state: "off" }) };
    expect(shownRangers(rangers, ["mini", "mac"]).map(([n]) => n)).toEqual(["mini", "mac"]);
    expect(shownRangers({}, ["mini"])).toEqual([]);
  });

  test("its card by the conversation it is on, and its line", () => {
    const cards = { a: card({ session: "other" }), b: card({ state: "working" }), c: card({ state: "ended" }) };
    expect(rangerCard(cards, info())?.state).toBe("working");
    expect(rangerCard(cards, info({ session: null }))).toBeUndefined();
    expect(rangerLine(info(), card({ state: "waiting", waiting: "permission: Bash" }))).toBe("waiting on you: permission: Bash");
    expect(rangerLine(info())).toBe("running");
    expect(rangerLine(info({ state: "trust" }))).toBe("waiting at Claude's trust prompt");
  });

  test("sizes and wakes in a few words", () => {
    expect(sizeWord(300 * 1024)).toBe("300 KB");
    expect(sizeWord(4.2 * 1024 * 1024)).toBe("4.2 MB");
    const now = 1_000_000_000;
    expect(wakeWhen({ id: "a", by: "ranger", prompt: "p", created: 0, run: "r1" }, now)).toBe("when run r1 ends");
    expect(wakeWhen({ id: "a", by: "eric", prompt: "p", created: 0, cron: "0 8 * * *", next: now + 3 * 3_600_000 }, now)).toBe("cron 0 8 * * * · next in 3h");
    expect(wakeWhen({ id: "a", by: "ranger", prompt: "p", created: 0, at: now - 1, next: now - 1 }, now)).toBe("due now");
    const r = info({ wakes: [{ id: "a", by: "eric", prompt: "p", created: 0, cron: "0 8 * * *" }, { id: "b", by: "ranger", prompt: "p", created: 0, cron: "0 9 * * *" }] });
    expect(ericsCrons(r).map((w) => w.id)).toEqual(["a"]);
  });
});
