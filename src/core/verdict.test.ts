import { describe, expect, test } from "bun:test";
import { THRESHOLDS, decide, verdictState } from "./verdict";
import type { VerdictAnswers } from "./types";

const answers = (o: Partial<VerdictAnswers> = {}): VerdictAnswers => ({
  outcome: { choice: "done", probabilities: { done: 0.9, partial: 0.05, blocked: 0.05 } },
  needsYou: { probability: 0.1 },
  offScope: { probability: 0.1 },
  ...o,
});

describe("decide", () => {
  test("a confident done with nothing for the user goes", () => {
    const v = decide(answers());
    expect(v.go).toBe(true);
    expect(v.reason).toBeNull();
  });

  test("done exactly at the threshold goes; just under parks", () => {
    expect(decide(answers({ outcome: { choice: "done", probabilities: { done: THRESHOLDS.done } } })).go).toBe(true);
    const v = decide(answers({ outcome: { choice: "done", probabilities: { done: THRESHOLDS.done - 0.01 } } }));
    expect(v.go).toBe(false);
    expect(v.reason).toContain("not sure");
  });

  test("partial and blocked park with the outcome named", () => {
    expect(decide(answers({ outcome: { choice: "partial" } })).reason).toContain("partly");
    expect(decide(answers({ outcome: { choice: "blocked" } })).reason).toContain("blocked");
  });

  test("needs you parks at the threshold", () => {
    const v = decide(answers({ needsYou: { probability: THRESHOLDS.needsYou } }));
    expect(v.go).toBe(false);
    expect(v.reason).toContain("asks you");
  });

  test("off scope parks at the threshold", () => {
    const v = decide(answers({ offScope: { probability: THRESHOLDS.offScope } }));
    expect(v.go).toBe(false);
    expect(v.reason).toContain("outside");
  });

  test("missing probabilities count as certain", () => {
    expect(decide(answers({ outcome: { choice: "done" } })).go).toBe(true);
  });
});

describe("verdictState", () => {
  test("names each part so the classifier can tell them apart", () => {
    const s = verdictState({ summary: "Committed 2 files.", check: "ok\n", changed: true });
    expect(s).toContain("Step summary:\nCommitted 2 files.");
    expect(s).toContain("Check output:\nok");
    expect(s).toContain("git status changed during the step: yes");
  });
  test("leaves out what is unknown", () => {
    const s = verdictState({ summary: "", check: null, changed: null });
    expect(s).toContain("(no summary)");
    expect(s).not.toContain("Check output");
    expect(s).not.toContain("git status changed");
  });
});
