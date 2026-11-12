import { describe, expect, test } from "bun:test";
import type { AgentCard, ServerEvent } from "../core/types";
import { PulseHub, type PulseReading } from "./pulse";

const NOW = 10 * 3_600_000;

const card = (id: string, over: Partial<AgentCard> = {}): AgentCard => ({
  id,
  handle: id,
  node: "mini",
  harness: "claude",
  session: `s-${id}`,
  origin: "elsewhere",
  cwd: "/r",
  repo: null,
  branch: null,
  model: null,
  mode: null,
  state: "idle",
  waiting: null,
  caps: [],
  offers: [],
  notifyIdle: false,
  where: { os: "linux", container: false, pid: 1, term: null, canopy: null },
  transcript: null,
  startedAt: NOW - 3_600_000,
  seenAt: NOW,
  endedAt: null,
  ...over,
});

function hub(cards: AgentCard[], readings: Record<string, PulseReading | null>, own: (c: AgentCard) => boolean = () => true) {
  const events: ServerEvent[] = [];
  const reads: string[] = [];
  const h = new PulseHub({
    cards: () => cards,
    own,
    read: async (_harness, session) => {
      reads.push(session);
      const r = readings[session];
      if (r === undefined) throw new Error("no transcript");
      return r;
    },
    broadcast: (ev) => events.push(ev),
    every: 0,
    now: () => NOW,
  });
  return { h, events, reads };
}

const quiet: PulseReading = { background: [], tool: null, writtenAt: NOW };

describe("the pulse hub", () => {
  test("reads its own live cards with a session, and says what changed", async () => {
    const cards = [
      card("bg"),
      card("plain"),
      card("ended", { state: "ended" }),
      card("noSession", { session: null }),
      card("other", { harness: "other" }),
      card("away"),
    ];
    const { h, events, reads } = hub(
      cards,
      { "s-bg": { ...quiet, background: [{ id: "b1", kind: "shell", at: NOW - 60_000, until: null }] }, "s-plain": quiet },
      (c) => c.id !== "away",
    );
    await h.tick();
    expect(reads.sort()).toEqual(["s-bg", "s-plain"]);
    expect(events).toEqual([
      {
        type: "pulse",
        pulses: [
          { id: "bg", shells: 1, monitors: 0, agents: 0, tool: null, stalledSince: null },
          { id: "plain", shells: 0, monitors: 0, agents: 0, tool: null, stalledSince: null },
        ],
      },
    ]);
    expect(h.list().map((p) => p.id)).toEqual(["bg", "plain"]);
    // nothing moved: nothing said
    await h.tick();
    expect(events).toHaveLength(1);
  });

  test("a card that ends or whose transcript is gone is dropped", async () => {
    const cards = [card("a"), card("b")];
    const readings: Record<string, PulseReading | null> = { "s-a": quiet, "s-b": quiet };
    const { h, events } = hub(cards, readings);
    await h.tick();
    cards[0] = card("a", { state: "ended" });
    readings["s-b"] = null;
    await h.tick();
    expect(events.at(-1)).toEqual({ type: "pulse", pulses: [], gone: ["a", "b"] });
    expect(h.list()).toEqual([]);
  });

  test("a reading asked for while one runs follows it once", async () => {
    const { h, reads } = hub([card("a")], { "s-a": quiet });
    const first = h.tick();
    void h.tick();
    void h.tick();
    await first;
    // the follow-up reading runs once, after the first
    await new Promise((r) => setTimeout(r, 0));
    await h.tick();
    expect(reads.length).toBe(3);
  });

  test("with no interval it never reads on its own", () => {
    const { h, reads } = hub([card("a")], { "s-a": quiet });
    h.start();
    h.nudge();
    h.close();
    expect(reads).toEqual([]);
  });
});
