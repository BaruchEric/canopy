/** What the board's "state" grouping reads off the page's store (FR-079):
 *  which of a repo's runs and workflows count, and that a card is read
 *  whole. `cardState` (boardstate.ts) has the rules themselves. */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Flow, Repo, Run, TaskInfo } from "../../src/core/types";
import { TRACE_MS } from "./cardlive";
import { boardStates, useStore } from "./store";

const pristine = useStore.getState();
const NOW = 1_800_000_000_000;

const repo = (id: string): Repo => ({ id, name: id, path: `/dev/${id}`, group: "", source: "launch", status: null });
const run = (id: string, repoId: string, status: Run["status"], over: Partial<Run> = {}): Run => ({
  id,
  repoId,
  action: "ask",
  verb: "ask",
  progress: "asking",
  expectsChange: false,
  chat: false,
  harness: "claude",
  note: "",
  status,
  startedAt: 1,
  steps: [],
  prompt: null,
  ...over,
});
const flow = (id: string, repoId: string, status: Flow["status"], over: Partial<Flow> = {}): Flow => ({ id, repoId, workflow: "ship", verb: "ship", note: "", status, steps: [], current: 0, startedAt: 1, ...over });
const task = (repoId: string, over: Partial<TaskInfo>): TaskInfo => ({ name: "test", cmd: "bun test", repoId, source: "repo", termId: "0".repeat(32), status: "exited", live: false, restarts: 0, viewers: [], ...over });
const byId = <T extends { id: string }>(...all: T[]): Record<string, T> => Object.fromEntries(all.map((x) => [x.id, x]));

beforeEach(() => {
  useStore.setState({ ...pristine, repos: ["a", "b", "c", "d", "e"].map(repo), runs: {}, flowRuns: {}, flows: {}, taskAll: [], sheet: null }, true);
});

afterEach(() => {
  useStore.setState(pristine, true);
});

describe("boardStates", () => {
  test("reads each card in view: a prompt open, a run at work, one that ended, and nothing", () => {
    useStore.setState({ runs: byId(run("r1", "a", "waiting"), run("r2", "b", "working"), run("r3", "c", "done")) });
    expect(boardStates(useStore.getState(), NOW)).toEqual({ a: "needs", b: "working", c: "unread", d: "idle", e: "idle" });
  });

  test("a flow's step is its flow's to speak for, and a flow on a branch of its own is not the checkout's", () => {
    useStore.setState({
      runs: byId(run("step", "a", "waiting"), run("step2", "b", "working")),
      flowRuns: { step: "f1", step2: "f2" },
      flows: byId(flow("f1", "a", "working"), flow("f2", "b", "working", { branch: { name: "run/x", target: "main", base: "0", dir: "/t", origin: "t", state: "working" } })),
    });
    expect(boardStates(useStore.getState(), NOW)).toMatchObject({ a: "working", b: "idle" });
  });

  test("a flow parked at a gate needs you, and one that ended is unread until dismissed", () => {
    useStore.setState({ flows: byId(flow("f1", "a", "gated"), flow("f2", "b", "done")) });
    expect(boardStates(useStore.getState(), NOW)).toMatchObject({ a: "needs", b: "unread" });
    useStore.setState({ flows: {} });
    expect(boardStates(useStore.getState(), NOW)).toMatchObject({ a: "idle", b: "idle" });
  });

  test("a run going beside a workflow is read with it: its prompt needs you, its answer waits behind the work (FR-073)", () => {
    useStore.setState({
      runs: byId(run("ask", "a", "waiting"), run("chat", "b", "idle", { chat: true, steps: [{ id: "1", at: 1, kind: "text", text: "it builds" }] })),
      flows: byId(flow("f1", "a", "working"), flow("f2", "b", "working")),
    });
    expect(boardStates(useStore.getState(), NOW)).toMatchObject({ a: "needs", b: "working" });
  });

  test("a workflow whose check waits for the runs mid-turn beside it is at work, not waiting on you (FR-073)", () => {
    useStore.setState({
      runs: byId(run("ask", "a", "working", { name: "count the parts" })),
      flows: byId(flow("f1", "a", "working", { steps: [{ name: "build", status: "checking", waits: ["count the parts"] }] })),
    });
    expect(boardStates(useStore.getState(), NOW).a).toBe("working");
  });

  test("a workspace run counts on the card it started from, not on the other folders it works in, as the card's chip does", () => {
    useStore.setState({ runs: byId(run("ws", "a", "working", { alsoIn: ["b"] })) });
    expect(boardStates(useStore.getState(), NOW)).toMatchObject({ a: "working", b: "idle" });
  });

  test("a run in a worktree of its own is still the repo's run (FR-080)", () => {
    useStore.setState({ runs: byId(run("own", "a", "waiting", { branch: { name: "run/x", target: "main", base: "0", dir: "/t", origin: "t", state: "working" } })) });
    expect(boardStates(useStore.getState(), NOW).a).toBe("needs");
  });

  test("a snapshot opened from the run log is not a run left on its card", () => {
    useStore.setState({ runs: byId(run("old", "a", "done", { kept: true })) });
    expect(boardStates(useStore.getState(), NOW).a).toBe("idle");
  });

  test("a task that finished is the row's trace: unread for as long as the row shows it", () => {
    useStore.setState({ taskAll: [task("a", { exitedAt: NOW - 60_000 }), task("b", { exitedAt: NOW - TRACE_MS - 1 })] });
    expect(boardStates(useStore.getState(), NOW)).toMatchObject({ a: "unread", b: "idle" });
  });

  test("a card the filters leave out is not read", () => {
    useStore.setState({ runs: byId(run("r1", "a", "waiting")), filter: "b" });
    expect(boardStates(useStore.getState(), NOW)).toEqual({ b: "idle" });
  });
});
