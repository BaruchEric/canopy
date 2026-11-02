import { describe, expect, test } from "bun:test";
import { failPass, PASS_FAILED, scenarioHold, settlePass } from "./prscenarios";
import type { PrWatch, ScenarioResult, ScenarioRun } from "./types";

const cmd = (name: string, ok: boolean, tail = ""): ScenarioResult => ({ name, kind: "command", ok, ...(tail ? { tail } : {}) });
const judge = (name: string, p: number, ok = p >= 0.7): ScenarioResult => ({ name, kind: "judge", ok, p });
const run = (results: ScenarioResult[], score = 1, head = "h1"): ScenarioRun => ({ head, at: 1, total: results.length, passed: results.filter((r) => r.ok).length, score, results });
const watch = (over: Partial<PrWatch> = {}): PrWatch =>
  ({ id: "b1", runId: "r1", repoId: "repo", repoPath: "/r", branch: "run/x", target: "main", dir: "/w", note: "", slug: "o/r", remote: "origin", number: 7, url: "", autoFix: false, autoMerge: true, pushed: "h1", attempts: {}, seenComment: 0, openedAt: 1, updatedAt: 1, ...over }) as PrWatch;

describe("scenarioHold", () => {
  test("a green pass at the minimum may go", () => {
    expect(scenarioHold(run([cmd("checkout", true)]), 1)).toBeNull();
    expect(scenarioHold(run([cmd("a", true), judge("refund", 0.9)], 0.95), 0.9)).toBeNull();
  });
  test("a red command scenario holds by its name, never its output", () => {
    expect(scenarioHold(run([cmd("checkout", false, "expected 2, got 3")], 0), 1)).toBe("scenario checkout failed");
    // a file that does not parse is a red result named by the file
    expect(scenarioHold(run([cmd("broken.md", false, "broken.md: frontmatter line is not key: value")], 0), 1)).toBe("scenario broken.md failed");
  });
  test("a judge that could not answer holds, after any red command", () => {
    const unjudged: ScenarioResult = { name: "refund", kind: "judge", ok: false, unjudged: "no gateway key" };
    expect(scenarioHold(run([cmd("a", true), unjudged], 0.5), 1)).toBe("scenario refund needs a judge: no gateway key");
    expect(scenarioHold(run([cmd("a", false), unjudged], 0), 1)).toBe("scenario a failed");
  });
  test("a score under the minimum holds with the judge scenarios that were not satisfied", () => {
    expect(scenarioHold(run([cmd("a", true), judge("refund", 0.4), judge("tone", 0.95)], 0.78), 1)).toBe("satisfaction 0.78 < 1, from refund");
    expect(scenarioHold(run([cmd("a", true), judge("tone", 0.9)], 0.95), 1)).toBe("satisfaction 0.95 < 1");
  });
});

describe("a pass's end on the watch", () => {
  test("settlePass keeps the pass, drops the running mark, and holds only a held head", () => {
    const green = run([cmd("checkout", true)]);
    expect(settlePass(watch({ checking: { head: "h1", since: 5 } }), "h1", green, 1)).toEqual(watch({ scenarios: green }));
    const red = run([cmd("checkout", false, "boom")], 0);
    expect(settlePass(watch({ checking: { head: "h1", since: 5 } }), "h1", red, 1)).toEqual(watch({ scenarios: red, approve: { head: "h1", why: "scenario checkout failed", by: "scenarios" } }));
  });
  test("failPass holds the head with fixed words unless told others, and keeps the last pass", () => {
    const last = run([cmd("checkout", true)], 1, "h0");
    expect(failPass(watch({ scenarios: last, checking: { head: "h1", since: 5 } }), "h1")).toEqual(watch({ scenarios: last, approve: { head: "h1", why: PASS_FAILED, by: "scenarios" } }));
    expect(failPass(watch(), "h1", "x").approve).toEqual({ head: "h1", why: "x", by: "scenarios" });
  });
});
