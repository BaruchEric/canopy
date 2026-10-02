import { describe, expect, test } from "bun:test";
import { budgetWord, fleetCounts, flowWord, oldestParked, ownRun, rewindLines, selectable, stepWord } from "./flows";
import type { Fleet, Flow, FlowStep, Repo, Run } from "../../src/core/types";

const flow = (o: Partial<Flow> = {}): Flow => ({
  id: "f", repoId: "r", workflow: "ship", verb: "ship", note: "", status: "working",
  steps: [{ name: "Gates", status: "passed" }, { name: "Commit", status: "running" }, { name: "Push", status: "pending" }],
  current: 1, startedAt: 0, ...o,
});

describe("flowWord", () => {
  test("says the step while working, needs you when parked or waiting, and the end otherwise", () => {
    expect(flowWord(flow(), false)).toBe("ship: Commit…");
    expect(flowWord(flow(), true)).toBe("ship, step 2 of 3: Commit");
    expect(flowWord(flow({ status: "gated" }), false)).toBe("needs you");
    expect(flowWord(flow({ status: "waiting" }), true)).toBe("ship: the agent needs you");
    expect(flowWord(flow({ status: "done" }), false)).toBe("done");
    expect(flowWord(flow({ status: "done", outcome: "unchanged" }), true)).toBe("ship: no change");
    expect(flowWord(flow({ status: "failed" }), true)).toBe("ship failed");
    expect(flowWord(flow({ status: "stopped" }), false)).toBe("stopped");
  });
});

describe("stepWord", () => {
  test.each<[FlowStep["status"], string]>([
    ["pending", "waiting its turn"], ["running", "the agent is working"], ["checking", "running the check"],
    ["gated", "waiting for you"], ["passed", "passed"], ["failed", "failed"], ["skipped", "skipped"],
  ])("%s", (status, word) => {
    expect(stepWord({ name: "x", status })).toBe(word);
  });
});

describe("fleetCounts and oldestParked", () => {
  const fleet: Fleet = { id: "F", workflow: "ship", verb: "ship", note: "", status: "working", startedAt: 0,
    repos: [{ repoId: "a", flowId: "fa" }, { repoId: "b", flowId: "fb" }, { repoId: "c" }, { repoId: "d", skipped: "nothing to commit" }] };
  const flows: Record<string, Flow> = {
    fa: flow({ id: "fa", repoId: "a", status: "gated", startedAt: 5 }),
    fb: flow({ id: "fb", repoId: "b", status: "waiting", startedAt: 2 }),
  };
  test("counts by state", () => {
    expect(fleetCounts(fleet, flows)).toEqual({ pending: 1, active: 2, needsYou: 2, done: 0, failed: 0, skipped: 1 });
  });
  test("the oldest parked flow comes first", () => {
    expect(oldestParked(fleet, flows)?.id).toBe("fb");
    expect(oldestParked({ ...fleet, repos: [] }, flows)).toBeUndefined();
  });
});

describe("selectable", () => {
  test("drops forge, unreadable and remote repos", () => {
    const base = { name: "x", path: "/x", group: "", source: "s", status: null } as Omit<Repo, "id">;
    const repos: Repo[] = [
      { ...base, id: "ok" },
      { ...base, id: "far", host: "box" },
      { ...base, id: "bad", error: "nope" },
      { ...base, id: "forge", forge: { kind: "forgejo", full: "o/n" } } as unknown as Repo,
    ];
    expect(selectable(repos).map((r) => r.id)).toEqual(["ok"]);
  });
});

describe("ownRun", () => {
  const run = (id: string): Run =>
    ({ id, repoId: "r", verb: "ask", status: "working", steps: [], startedAt: 0 }) as unknown as Run;
  test("skips a run a flow owns and keeps every other one", () => {
    const flowRuns = { "run-1": "flow-a" };
    expect(ownRun(flowRuns, run("run-1"))).toBe(false);
    expect(ownRun(flowRuns, run("run-2"))).toBe(true);
    expect(ownRun({}, run("run-1"))).toBe(true);
    expect([run("run-1"), run("run-2")].filter((r) => ownRun(flowRuns, r)).map((r) => r.id)).toEqual(["run-2"]);
  });
});

describe("budgetWord", () => {
  test("runs and hours spent of the budget, or null without one", () => {
    expect(budgetWord(flow())).toBeNull();
    expect(budgetWord(flow({ budget: { runs: 30, hours: 6 }, spent: { runs: 4, workMs: 4_320_000 } }))).toBe("4 of 30 runs, 1.2h of 6h");
    expect(budgetWord(flow({ budget: { runs: 2, hours: 0.5 } }))).toBe("0 of 2 runs, 0h of 0.5h");
    expect(budgetWord(flow({ budget: { runs: 1, hours: 1 } }))).toBe("0 of 1 run, 0h of 1h");
  });
});

describe("rewindLines", () => {
  test("one line per rewind, saying where the work went back to", () => {
    expect(rewindLines(flow())).toEqual([]);
    expect(
      rewindLines(
        flow({
          rewinds: [
            { from: "Test", to: "Test", reason: "check failed", at: 0 },
            { from: "Accept", to: "Build", reason: "only partly", at: 1 },
          ],
        }),
      ),
    ).toEqual(["Test tried again: check failed", "Accept sent it back to Build: only partly"]);
  });
});
