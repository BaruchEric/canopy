import { describe, expect, test } from "bun:test";
import { settleNote } from "../../src/core/driver";
import type { RunStep } from "../../src/core/types";
import { AGENT_NAME, agentWord, clock, harnessOf, hideTodoSteps, nestSteps, progressWord, resultLine, reviseAnswer, settledProposal, tokenCount, tokenTitle } from "./runs";

describe("a run's words", () => {
  test("its harness, and a run from before harnesses was Claude's", () => {
    expect(harnessOf({ harness: "codex" })).toBe("codex");
    expect(harnessOf({})).toBe("claude");
    expect(AGENT_NAME.codex).toBe("Codex");
    expect(AGENT_NAME.claude).toBe("Claude Code");
    expect(agentWord("claude")).toBe("claude");
  });

  test("the footer: the tokens where there are some, else the cost", () => {
    expect(resultLine({ text: "", turns: 3, durationMs: 187_000, costUsd: 0.042 })).toBe("3 turns · 3:07 · $0.04");
    expect(resultLine({ text: "", turns: 1, durationMs: 5_000, tokens: { input: 900, cachedInput: 100, output: 300, reasoning: 50, total: 1200 } })).toBe(
      "1 turn · 0:05 · 1.2k tokens",
    );
    // a codex result's zero cost is for older pages; this one shows its tokens
    expect(
      resultLine({ text: "", turns: 1, durationMs: 5_000, costUsd: 0, tokens: { input: 900, cachedInput: 100, output: 300, reasoning: 50, total: 1200 } }),
    ).toBe("1 turn · 0:05 · 1.2k tokens");
    expect(resultLine({ text: "", turns: 2, durationMs: 0 })).toBe("2 turns · 0:00");
    expect(tokenTitle({ text: "", turns: 1, durationMs: 0 })).toBeNull();
    expect(tokenTitle({ text: "", turns: 1, durationMs: 0, tokens: { input: 9, cachedInput: 3, output: 2, reasoning: 1, total: 11 } })).toBe(
      "9 in (3 cached), 2 out (1 reasoning), 11 in all",
    );
  });

  test("token counts and clocks at a glance", () => {
    expect([950, 1000, 1250, 48_400, 999_000, 1_300_000].map(tokenCount)).toEqual(["950", "1k", "1.3k", "48k", "999k", "1.3M"]);
    expect(clock(61_999)).toBe("1:01");
    expect(clock(-5)).toBe("0:00");
  });
});

const s = (id: string, extra: Partial<RunStep> = {}): RunStep => ({ id, at: 0, kind: "tool", tool: { name: "Bash", title: id, status: "ok" }, ...extra });

describe("plan, then build in the timeline", () => {
  test("subagent steps fold under their Agent step, in order", () => {
    const steps = [s("a", { tool: { name: "Agent", title: "agent: read", status: "running" } }), s("b", { parent: "a" }), s("c"), s("d", { parent: "a" })];
    expect(nestSteps(steps).map((n) => [n.step.id, n.kids.map((k) => k.id)])).toEqual([
      ["a", ["b", "d"]],
      ["c", []],
    ]);
  });

  test("a step whose parent is unknown stays at the top level", () => {
    expect(nestSteps([s("x", { parent: "gone" })]).map((n) => n.step.id)).toEqual(["x"]);
  });

  test("todo tool steps hide only when the checklist shows", () => {
    const steps = [s("t", { tool: { name: "TaskCreate", title: "todo: a", status: "ok" } }), s("b")];
    expect(hideTodoSteps(steps, true).map((x) => x.id)).toEqual(["b"]);
    expect(hideTodoSteps(steps, false).map((x) => x.id)).toEqual(["t", "b"]);
  });

  test("a subagent's todo steps stay, since its list never reaches the checklist", () => {
    const steps = [s("a", { tool: { name: "Agent", title: "agent: read", status: "ok" } }), s("t", { parent: "a", tool: { name: "TaskCreate", title: "todo: a", status: "ok" } })];
    expect(hideTodoSteps(steps, true).map((x) => x.id)).toEqual(["a", "t"]);
  });

  test("a revise sends its note, and an empty one still reads as a revise", () => {
    expect(reviseAnswer("  smaller steps \n")).toEqual({ kind: "deny", message: "smaller steps" });
    expect(reviseAnswer("   ")).toEqual({ kind: "deny", message: "Revise the plan." });
    expect(settleNote({ id: "p", kind: "proposal", plan: "x", auto: false }, reviseAnswer(""))).toBe("sent the plan back: Revise the plan.");
  });

  test("the plan card shows once the latest proposal is settled, never while it waits", () => {
    const at = { prompt: null };
    expect(settledProposal({ ...at })).toBeNull();
    expect(settledProposal({ ...at, proposal: "1. x", proposalState: "waiting" })).toBeNull();
    // a run from before the state was kept shows no card
    expect(settledProposal({ ...at, proposal: "1. x" })).toBeNull();
    expect(settledProposal({ ...at, proposal: "1. x", proposalState: "approved" })).toBe("approved");
    expect(settledProposal({ ...at, proposal: "1. x", proposalState: "approved-auto" })).toBe("approved-auto");
    expect(settledProposal({ ...at, proposal: "1. x", proposalState: "sent back" })).toBe("sent back");
    expect(settledProposal({ ...at, proposal: "1. x", proposalState: "turned down" })).toBe("turned down");
    // the one on show in the form below is not repeated as a card
    expect(settledProposal({ prompt: { id: "p", kind: "proposal", plan: "1. x", auto: false }, proposal: "1. x", proposalState: "sent back" })).toBeNull();
  });

  test("the chip says building once the plan is approved", () => {
    expect(progressWord({ progress: "planning" })).toBe("planning");
    expect(progressWord({ progress: "planning", proposalState: "waiting" })).toBe("planning");
    expect(progressWord({ progress: "planning", proposalState: "sent back" })).toBe("planning");
    expect(progressWord({ progress: "planning", proposalState: "approved" })).toBe("building");
    expect(progressWord({ progress: "planning", proposalState: "approved-auto" })).toBe("building");
    expect(progressWord({ progress: "working" })).toBe("working");
  });
});
