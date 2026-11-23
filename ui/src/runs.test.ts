import { describe, expect, test } from "bun:test";
import { settleNote } from "../../src/core/driver";
import type { Run, RunStep } from "../../src/core/types";
import { AGENT_NAME, agentWord, chatToSay, chatToShow, chipName, clock, harnessOf, hideTodoSteps, menuRun, moreTitle, needsMore, nestSteps, pillLine, pillRuns, pillText, progressWord, ranUnchanged, resultLine, reviseAnswer, flowBesideRuns, runBesideFlow, runsAtWork, runPanelLabel, runWord, settledProposal, tokenCount, tokenTitle } from "./runs";

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

  test("it names the agent only while every run is on the same one", () => {
    const x = run({ id: "x", harness: "codex" });
    const y = run({ id: "y", harness: "codex", status: "idle" });
    expect(pillText([x])).toBe("1 codex run");
    expect(pillText([x, y])).toBe("2 codex runs");
    expect(pillText([a, x])).toBe("2 runs");
    expect(pillText([a, c, x])).toBe("3 runs");
    // a run from before harnesses was Claude's
    expect(pillText([run({ harness: "claude" }), a])).toBe("2 claude runs");
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

  test("a run with a name goes by it, over what was asked (FR-073)", () => {
    expect(pillLine(run({ status: "idle", name: "pill menu", note: "fix the pill\nand the menu" }), 12 * 60_000)).toBe("chat open, your turn · 12m · pill menu");
  });
});

describe("several runs on one repo (FR-073)", () => {
  const branch = { name: "run/x", target: "main", base: "b", dir: "/w", origin: "o", state: "working" as const };
  const live = (id: string, status: Run["status"], startedAt: number, extra: Partial<Run> = {}) => ({ id, status, startedAt, chat: false, ...extra });

  test("the one chip shows the run that needs a person most, the newer of two alike", () => {
    const waiting = live("w", "waiting", 1);
    const working = live("k", "working", 5);
    const idle = live("i", "idle", 9);
    expect(needsMore(waiting, working)).toBe(true);
    expect(needsMore(working, idle)).toBe(true);
    expect(needsMore(idle, waiting)).toBe(false);
    expect(needsMore(live("n", "working", 6), working)).toBe(true);
    expect(needsMore(working, live("n", "working", 6))).toBe(false);
  });

  test("a message goes into the newest chat between turns, and a plain chat shows the newest going", () => {
    const runs = [
      live("job", "working", 9),
      live("old", "idle", 1, { chat: true }),
      live("new", "idle", 5, { chat: true }),
      live("busy", "working", 7, { chat: true }),
    ];
    expect(chatToSay(runs)?.id).toBe("new");
    expect(chatToShow(runs)?.id).toBe("busy");
    expect(chatToSay([live("job", "working", 9), live("busy", "working", 7, { chat: true })])).toBeUndefined();
    expect(chatToShow([live("job", "working", 9)])).toBeUndefined();
  });

  test("the runs a workflow would share the checkout with are the ones at work in it", () => {
    expect(runsAtWork([live("c", "idle", 1, { chat: true }), live("b", "working", 2, { branch })])).toEqual([]);
    expect(runsAtWork([live("c", "idle", 1, { chat: true }), live("j", "waiting", 2), live("k", "working", 3)]).map((r) => r.id)).toEqual(["j", "k"]);
  });

  test("a plan sheet says what the start will share the checkout with", () => {
    expect(flowBesideRuns([])).toBeNull();
    expect(flowBesideRuns(["peer sync"])).toBe("A run is at work in this checkout (peer sync). The workflow starts beside it, and its steps and checks see that run's changes, finished or not.");
    expect(flowBesideRuns(["peer sync", "chat"])).toStartWith("2 runs are at work in this checkout (peer sync, chat). The workflow starts beside them");
    expect(runBesideFlow("deploy")).toBe("The deploy workflow is going in this checkout. This run starts beside it, and the workflow's checks see what the run changes.");
  });

  test("a menu row says the name with the verb and state beside it, or the old words without one", () => {
    expect(menuRun({ status: "idle", verb: "chat", note: "", name: "peer sync" })).toEqual({ text: "peer sync", fact: "chat, your turn" });
    expect(menuRun({ status: "working", verb: "ask", note: "look at the build\nmore" })).toEqual({ text: "look at the build", fact: "ask, working" });
    expect(menuRun({ status: "waiting", verb: "plan", note: "x", name: "top bar" })).toEqual({ text: "top bar", fact: "plan, needs you" });
    expect(moreTitle([{ status: "idle", verb: "chat", note: "", name: "peer sync" }, { status: "idle", verb: "chat", note: "" }])).toBe("also going here: peer sync (chat, your turn); chat open, your turn");
    expect(chipName({ note: "look at the build\nmore" })).toBe("look at the build");
    expect(chipName({ note: "", name: "n".repeat(40) })).toBe(`${"n".repeat(31)}…`);
    expect(chipName({ note: "" })).toBe("");
    expect(runPanelLabel({ verb: "chat", name: "peer sync" }, "canopy")).toBe("peer sync · canopy");
    expect(runPanelLabel({ verb: "chat" }, "canopy")).toBe("chat · canopy");
    expect(menuRun({ status: "idle", verb: "chat", note: "" })).toEqual({ text: "chat open, your turn", fact: "show" });
    expect(menuRun({ status: "working", verb: "commit", note: "" })).toEqual({ text: "commit in progress", fact: "show" });
    expect(menuRun({ status: "waiting", verb: "commit", note: "" })).toEqual({ text: "commit needs you", fact: "show" });
    expect(menuRun({ status: "working", verb: "ask", note: "y".repeat(100) }).text).toBe(`${"y".repeat(71)}…`);
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
