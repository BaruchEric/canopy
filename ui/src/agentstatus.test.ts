import { describe, expect, test } from "bun:test";
import type { AgentCard, AgentPulse, Ask } from "../../src/core/types";
import { cardStatus, factsFrom, mergePulses, pulseIn, statusFrom, type Pulses } from "./agentstatus";

const pulse = (id: string, over: Partial<AgentPulse> = {}): AgentPulse => ({ id, shells: 0, monitors: 0, agents: 0, tool: null, stalledSince: null, ...over });

const card = (id: string, over: Partial<AgentCard> = {}): AgentCard => ({
  id,
  handle: id,
  node: "mini",
  harness: "claude",
  session: id,
  origin: "elsewhere",
  cwd: "/r",
  repo: null,
  branch: null,
  model: null,
  mode: null,
  state: "waiting",
  waiting: "your turn",
  caps: [],
  offers: [],
  notifyIdle: false,
  where: { os: "linux", container: false, pid: 1, term: null, canopy: null },
  transcript: null,
  startedAt: 0,
  seenAt: 0,
  endedAt: null,
  ...over,
});

const ask = (agent: string, state: Ask["state"]): Ask => ({
  id: `q-${agent}`,
  agent,
  handle: agent,
  node: "mini",
  kind: "permission",
  tool: "Bash",
  title: "run it?",
  detail: "",
  route: "remote",
  waitUntil: 0,
  state,
  createdAt: 0,
});

describe("the page's status of a card", () => {
  test("a pulse from whichever backend reads the card", () => {
    const pulses: Pulses = { mini: { a: pulse("a", { shells: 1 }) }, mac: { b: pulse("b") } };
    expect(pulseIn(pulses, "a")?.shells).toBe(1);
    expect(pulseIn(pulses, "b")).toEqual(pulse("b"));
    expect(pulseIn(pulses, "c")).toBeUndefined();
  });

  test("the pulses and the open asks laid over the card", () => {
    const pulses: Pulses = { mini: { bg: pulse("bg", { monitors: 1 }) } };
    const asks = { 1: ask("asks", "open"), 2: ask("done", "answered") };
    const status = statusFrom(factsFrom(pulses, asks));
    expect(status(card("bg"))).toBe("background");
    expect(status(card("asks"))).toBe("waiting");
    expect(status(card("done"))).toBe("idle");
    expect(factsFrom(pulses, asks)(card("plain"))).toEqual({});
    expect(cardStatus(card("bg"))).toBe("idle");
  });
});

describe("merging a backend's pulses", () => {
  test("changes in, gone out, the same object when nothing moved", () => {
    const held = { a: pulse("a"), b: pulse("b") };
    expect(mergePulses(held, [])).toBe(held);
    expect(mergePulses(held, [], ["z"])).toBe(held);
    expect(mergePulses(undefined, [pulse("a")])).toEqual({ a: pulse("a") });
    const next = mergePulses(held, [pulse("a", { shells: 2 }), pulse("c")], ["b"]);
    expect(next).toEqual({ a: pulse("a", { shells: 2 }), c: pulse("c") });
    expect(held).toEqual({ a: pulse("a"), b: pulse("b") });
  });
});
