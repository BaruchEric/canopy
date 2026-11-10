import { describe, expect, test } from "bun:test";
import { settleNote } from "../../src/core/driver";
import type { Run, RunStep } from "../../src/core/types";
import { AGENT_NAME, agentWord, clock, harnessOf, hideTodoSteps, nestSteps, pillLine, pillRuns, pillText, progressWord, ranUnchanged, resultLine, reviseAnswer, runWord, settledProposal, tokenCount, tokenTitle } from "./runs";

describe("a run's words", () => {
  test("its harness, and a run from before harnesses was Claude's", () => {
    expect(harnessOf({ harness: "codex" })).toBe("codex");
    expect(harnessOf({})).toBe("claude");
    expect(AGENT_NAME.codex).toBe("Codex");
    expect(AGENT_NAME.claude).toBe("Claude Code");
    expect(agentWord("claude")).toBe("claude");
  });

  test("the footer: tokens and reported cost, hiding Codex's compatibility zero", () => {
    expect(resultLine({ text: "", turns: 3, durationMs: 187_000, costUsd: 0.042 })).toBe("3 turns · 3:07 · $0.04");
    expect(resultLine({ text: "", turns: 1, durationMs: 5_000, tokens: { input: 900, cachedInput: 100, output: 300, reasoning: 50, total: 1200 } })).toBe(
      "1 turn · 0:05 · 1.2k tokens",
    );
    // a codex result's zero cost is for older pages; this one shows its tokens
    expect(
      resultLine({ text: "", turns: 1, durationMs: 5_000, costUsd: 0, tokens: { input: 900, cachedInput: 100, output: 300, reasoning: 50, total: 1200 } }),
    ).toBe("1 turn · 0:05 · 1.2k tokens");
    expect(resultLine({ text: "", turns: 1, durationMs: 5_000, costUsd: 0.02, tokens: { input: 900, cachedInput: 100, output: 300, reasoning: 50, total: 1200 } })).toBe(
      "1 turn · 0:05 · 1.2k tokens · $0.02",
    );
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

/** a commit run at work, started at 0 */
const run = (extra: Partial<Run> = {}): Pick<Run, "id" | "status" | "verb" | "progress" | "expectsChange" | "startedAt" | "note"> & Partial<Run> => ({
  id: "r",
  status: "working",
  verb: "commit",
  progress: "committing",
  expectsChange: true,
  startedAt: 0,
  note: "",
  ...extra,
});

describe("a run in a word", () => {
  test("the chip's word and the panel's, by status", () => {
    expect([runWord(run()), runWord(run(), true)]).toEqual(["committing…", "claude is committing"]);
    expect([runWord(run({ status: "waiting" })), runWord(run({ status: "waiting", harness: "codex" }), true)]).toEqual(["needs you", "commit: codex needs you"]);
    expect([runWord(run({ status: "idle" })), runWord(run({ status: "idle" }), true)]).toEqual(["chat open", "chat open, your turn"]);
    expect(["done", "limited", "failed", "stopped"].map((status) => runWord(run({ status: status as Run["status"] }), true))).toEqual([
      "commit done",
      "commit waits for capacity",
      "commit failed",
      "commit stopped",
    ]);
  });

  test("an approved plan is building, whatever the action's word", () => {
    expect(runWord(run({ progress: "planning", proposalState: "approved" }))).toBe("building…");
  });

  test("a commit that moved nothing says so, a read that moved nothing is done", () => {
    const still = run({ status: "done", outcome: "unchanged" });
    expect(ranUnchanged(still)).toBe(true);
    expect([runWord(still), runWord(still, true)]).toEqual(["no change", "commit: no change"]);
    expect(runWord(run({ status: "done", outcome: "unchanged", expectsChange: false }))).toBe("done");
  });
});

describe("the top bar's runs pill", () => {
  const a = run({ id: "a" });
  const b = run({ id: "b", status: "waiting" });
  const c = run({ id: "c", status: "idle" });
  const d = run({ id: "d", status: "waiting" });

  test("the runs that need an answer come first, each lot in the order given", () => {
    expect(pillRuns([a, b, c, d]).map((r) => r.id)).toEqual(["b", "d", "a", "c"]);
    expect(pillRuns([a, c]).map((r) => r.id)).toEqual(["a", "c"]);
    expect(pillRuns([])).toEqual([]);
  });

  test("its words count the waiting ones, else every run", () => {
    expect(pillText([a])).toBe("1 claude run");
    expect(pillText([a, c])).toBe("2 claude runs");
    expect(pillText([a, b, c])).toBe("1 needs you");
    expect(pillText([b, d])).toBe("2 need you");
  });

  test("a row says what the run is at, how long it has gone and what was asked", () => {
    expect(pillLine(a, 20_000)).toBe("claude is committing · just started");
    expect(pillLine(run({ status: "idle", note: "fix the pill\nand the menu" }), 12 * 60_000)).toBe("chat open, your turn · 12m · fix the pill");
    expect(pillLine(run({ status: "waiting" }), 185 * 60_000)).toBe("commit: claude needs you · 3h 05m");
    // a clock behind the backend's never counts backwards
    expect(pillLine(run({ startedAt: 5_000 }), 0)).toBe("claude is committing · just started");
  });

  test("a long note is cut to one short line", () => {
    expect(pillLine(run({ note: "x".repeat(100) }), 0).split(" · ")[2]).toBe(`${"x".repeat(71)}…`);
    // a cut that lands after a space leaves none before the ellipsis
    expect(pillLine(run({ note: `${"x".repeat(70)} and more` }), 0).split(" · ")[2]).toBe(`${"x".repeat(70)}…`);
    expect(pillLine(run({ note: "x".repeat(72) }), 0).split(" · ")[2]).toBe("x".repeat(72));
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
