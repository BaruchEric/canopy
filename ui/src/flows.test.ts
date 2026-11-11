import { describe, expect, test } from "bun:test";
import { budgetWord, continueWord, fleetCounts, flowWord, gateButtons, gateWords, oldestParked, ownRun, rewindLines, selectable, stepWord } from "./flows";
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
    ["gated", "waiting for you"], ["held", "waiting for your go"], ["passed", "passed"], ["failed", "failed"], ["skipped", "skipped"],
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

describe("continueWord", () => {
  test("held middle and final steps name the step that will actually start", () => {
    expect(continueWord(flow({ status: "gated", steps: [{ name: "Build", status: "passed" }, { name: "Lint", status: "held" }, { name: "Docs", status: "passed" }], current: 1 }))).toBe("start Lint");
    expect(continueWord(flow({ status: "gated", steps: [{ name: "Ship", status: "held" }], current: 0 }))).toBe("start Ship");
  });
  test("existing gate, budget and stage actions keep their labels", () => {
    expect(continueWord(flow({ status: "gated" }))).toBe("continue to Push");
    expect(continueWord(flow({ status: "gated", current: 2 }))).toBe("accept and finish");
    expect(continueWord(flow({ status: "gated", parkedFor: "budget" }))).toBe("allow one more step");
    expect(continueWord(flow({ status: "gated", parkedFor: "stage" }))).toBe("run the step again");
    expect(continueWord(flow({ status: "gated", parkedFor: "stage", stageCheck: true }))).toBe("run the check again");
  });
});

describe("gateWords and gateButtons (incubator review, P1)", () => {
  const judged = (go: boolean): FlowStep => ({
    name: "Accept",
    status: "gated",
    reason: go ? "a gate" : "the judge says it only partly meets the intent",
    judgment: { answers: { fit: { choice: go ? "meets" : "partly", probabilities: {} }, evidence: { probability: 0.9 }, rules: { probability: 0 } }, go, rejected: false, reason: go ? null : "only partly" },
  });
  const at = (step: FlowStep, o: Partial<Flow> = {}): Flow =>
    flow({ status: "gated", steps: [{ name: "Scaffold", status: "passed" }, { name: "Test", status: "passed" }, step], current: 2, ...o });
  const drawn = (f: Flow): string[] => gateButtons(gateWords(f)).map((b) => `${b.strong ? "*" : ""}${b.choice}: ${b.word}`);

  test("a gate that asks for a go leads with going on, and its retry is the step again", () => {
    expect(drawn(flow({ status: "gated" }))).toEqual(["*continue: continue to Push", "retry: retry this step"]);
    expect(drawn(at(judged(true)))).toEqual(["*continue: accept and finish", "retry: retry this step"]);
  });

  test("a judge's no: going on says anyway and comes second, and the retry goes back to the step that made the work", () => {
    const f = at(judged(false), { backTo: "Scaffold" });
    expect(drawn(f)).toEqual(["*retry: send it back to Scaffold", "continue: accept and finish anyway"]);
    expect(gateWords(f).title).toBe("Accept did not accept the work; this goes on with the work as it is");
  });

  test("a failed check and a verdict's no are refusals too; with no step to go back to, the retry is the step again", () => {
    const check: FlowStep = { name: "Gates", status: "gated", reason: "check failed with exit 1", check: { command: "bun test", exit: 1, output: "2 fail" } };
    expect(drawn(flow({ status: "gated", steps: [check, { name: "Commit", status: "pending" }], current: 0 }))).toEqual(["*retry: retry this step", "continue: continue to Commit anyway"]);
    const passed: FlowStep = { ...check, reason: "a gate", check: { command: "bun test", exit: 0, output: "" } };
    expect(drawn(flow({ status: "gated", steps: [passed, { name: "Commit", status: "pending" }], current: 0 }))).toEqual(["*continue: continue to Commit", "retry: retry this step"]);
  });

  test("a park with one way on has one button: the budget, the runner away, a failed run, the usage limit", () => {
    expect(drawn(flow({ status: "gated", parkedFor: "budget" }))).toEqual(["*continue: allow one more step"]);
    expect(drawn(flow({ status: "gated", parkedFor: "stage" }))).toEqual(["*continue: run the step again"]);
    expect(drawn(flow({ status: "gated", parkedFor: "failed" }))).toEqual(["*continue: run the step again"]);
    expect(drawn(flow({ status: "gated", parkedFor: "capacity" }))).toEqual(["*continue: start anyway"]);
    expect(gateWords(flow({ status: "gated", parkedFor: "failed" })).title).toContain("the steps before it stand");
    // a failed run at a step whose earlier try was refused is still one way on
    expect(drawn(at(judged(false), { parkedFor: "failed", backTo: "Scaffold" }))).toEqual(["*continue: run the step again"]);
  });
});
