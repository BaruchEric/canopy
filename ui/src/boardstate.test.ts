import { describe, expect, test } from "bun:test";
import type { RunStep } from "../../src/core/types";
import { BOARD_STATES, cardState, type CardFacts } from "./boardstate";
import { TRACE_MS } from "./cardlive";

const NOW = 1_800_000_000_000;
const NONE: CardFacts = { agents: [], runs: [], flows: [], endedAt: null };
const facts = (over: Partial<CardFacts>): CardFacts => ({ ...NONE, ...over });
const said: RunStep[] = [
  { id: "1", at: NOW - 60_000, kind: "user", text: "does it build?" },
  { id: "2", at: NOW - 30_000, kind: "text", text: "it does" },
];

describe("cardState", () => {
  test("the groups come in the order of how pressing they are", () => {
    expect([...BOARD_STATES]).toEqual(["needs", "working", "unread", "idle"]);
  });

  test("a card with nothing on it is idle", () => {
    expect(cardState(NONE, NOW)).toBe("idle");
  });

  test("an agent that waits on you needs you, as the live row says", () => {
    expect(cardState(facts({ agents: ["working", "waiting"] }), NOW)).toBe("needs");
  });

  test("an agent at its prompt with nothing asked is idle, not waiting on you", () => {
    expect(cardState(facts({ agents: ["idle"] }), NOW)).toBe("idle");
  });

  test("a run with a prompt open and a flow parked at a gate need you", () => {
    expect(cardState(facts({ runs: [{ status: "waiting", steps: [] }] }), NOW)).toBe("needs");
    expect(cardState(facts({ flows: [{ status: "gated" }] }), NOW)).toBe("needs");
    expect(cardState(facts({ flows: [{ status: "waiting" }] }), NOW)).toBe("needs");
  });

  test("needing you wins over work going beside it", () => {
    expect(cardState(facts({ runs: [{ status: "working", steps: [] }, { status: "waiting", steps: [] }] }), NOW)).toBe("needs");
    expect(cardState(facts({ agents: ["working"], flows: [{ status: "gated" }] }), NOW)).toBe("needs");
  });

  test("an agent, a run or a flow at work is working", () => {
    expect(cardState(facts({ agents: ["working"] }), NOW)).toBe("working");
    expect(cardState(facts({ runs: [{ status: "working", steps: [] }] }), NOW)).toBe("working");
    expect(cardState(facts({ flows: [{ status: "working" }] }), NOW)).toBe("working");
  });

  test("a stalled agent is still in its turn; one with background work is at its prompt", () => {
    expect(cardState(facts({ agents: ["stalled"] }), NOW)).toBe("working");
    expect(cardState(facts({ agents: ["background"] }), NOW)).toBe("idle");
  });

  test("work going wins over something finished beside it", () => {
    expect(cardState(facts({ runs: [{ status: "done", steps: said }, { status: "working", steps: [] }] }), NOW)).toBe("working");
  });

  test("a run that ended and was not dismissed is unread, however it ended", () => {
    for (const status of ["done", "failed", "stopped", "limited"] as const) {
      expect(cardState(facts({ runs: [{ status, steps: said }] }), NOW)).toBe("unread");
    }
  });

  test("a flow that ended and was not dismissed is unread", () => {
    for (const status of ["done", "failed", "stopped"] as const) {
      expect(cardState(facts({ flows: [{ status }] }), NOW)).toBe("unread");
    }
  });

  test("a chat between turns is unread once Claude has answered in it", () => {
    expect(cardState(facts({ runs: [{ status: "idle", steps: said }] }), NOW)).toBe("unread");
    expect(cardState(facts({ runs: [{ status: "idle", steps: [{ id: "1", at: NOW, kind: "tool", tool: { name: "Read", title: "a.ts", status: "ok" } }] }] }), NOW)).toBe("unread");
  });

  test("a chat with nothing said yet, or only the person's words and canopy's notes, is idle", () => {
    expect(cardState(facts({ runs: [{ status: "idle", steps: [] }] }), NOW)).toBe("idle");
    expect(
      cardState(
        facts({
          runs: [
            {
              status: "idle",
              steps: [
                { id: "1", at: NOW, kind: "user", text: "hello" },
                { id: "2", at: NOW, kind: "note", text: "resumed" },
              ],
            },
          ],
        }),
        NOW,
      ),
    ).toBe("idle");
  });

  test("the trace of the last thing that left the row is unread for as long as the row shows it", () => {
    expect(cardState(facts({ endedAt: NOW - 60_000 }), NOW)).toBe("unread");
    expect(cardState(facts({ endedAt: NOW - TRACE_MS + 1 }), NOW)).toBe("unread");
    expect(cardState(facts({ endedAt: NOW - TRACE_MS }), NOW)).toBe("idle");
    expect(cardState(facts({ endedAt: NOW - 2 * TRACE_MS }), NOW)).toBe("idle");
  });
});
