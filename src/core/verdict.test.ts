import { describe, expect, test } from "bun:test";
import { EVIDENCE_EACH, EVIDENCE_TOTAL, JUDGE_THRESHOLDS, THRESHOLDS, decide, decideJudge, judgeState, verdictState } from "./verdict";
import type { JudgeAnswers, VerdictAnswers } from "./types";

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

const judged = (o: Partial<JudgeAnswers> = {}): JudgeAnswers => ({
  fit: { choice: "meets", probabilities: { meets: 0.9, partly: 0.05, misses: 0.05 } },
  evidence: { probability: 0.9 },
  rules: { probability: 0.05 },
  ...o,
});

describe("decideJudge", () => {
  test("a confident meets with enough evidence and no broken rule goes", () => {
    expect(decideJudge(judged())).toEqual({ answers: judged(), go: true, rejected: false, reason: null });
  });

  test("meets exactly at the threshold goes; just under parks", () => {
    expect(decideJudge(judged({ fit: { choice: "meets", probabilities: { meets: JUDGE_THRESHOLDS.meets } } })).go).toBe(true);
    const under = decideJudge(judged({ fit: { choice: "meets", probabilities: { meets: 0.69 } } }));
    expect(under.go).toBe(false);
    expect(under.reason).toBe("not sure the work meets the intent");
  });

  test("a broken rule parks first, whatever the fit", () => {
    const j = decideJudge(judged({ rules: { probability: JUDGE_THRESHOLDS.rules } }));
    expect(j).toMatchObject({ go: false, rejected: false, reason: "the judge thinks something breaks the rules" });
  });

  test("a sure miss is a rejection; an unsure one only parks", () => {
    const sure = decideJudge(judged({ fit: { choice: "misses", probabilities: { misses: 0.7 } } }));
    expect(sure).toMatchObject({ go: false, rejected: true, reason: "the judge says the work misses the intent" });
    const unsure = decideJudge(judged({ fit: { choice: "misses", probabilities: { misses: 0.6 } } }));
    expect(unsure).toMatchObject({ go: false, rejected: false, reason: "the judge leans toward the work missing the intent" });
  });

  test("a sure miss on thin evidence parks instead of rejecting", () => {
    const j = decideJudge(judged({ fit: { choice: "misses", probabilities: { misses: 0.9 } }, evidence: { probability: 0.1 } }));
    expect(j).toMatchObject({ go: false, rejected: false, reason: "the judge says there is not enough to go on" });
  });

  test("too little evidence parks", () => {
    const j = decideJudge(judged({ evidence: { probability: 0.49 } }));
    expect(j).toMatchObject({ go: false, rejected: false, reason: "the judge says there is not enough to go on" });
  });

  test("partly parks", () => {
    const j = decideJudge(judged({ fit: { choice: "partly", probabilities: { partly: 0.9 } } }));
    expect(j.reason).toBe("the judge says it only partly meets the intent");
  });

  test("missing probabilities count as certain", () => {
    expect(decideJudge(judged({ fit: { choice: "meets" } })).go).toBe(true);
    expect(decideJudge(judged({ fit: { choice: "misses" } })).rejected).toBe(true);
  });
});

describe("judgeState", () => {
  test("names the task, the summary, the check and each file", () => {
    const s = judgeState({
      task: "Does it meet the intent?",
      summary: "built it",
      check: "ok",
      files: [{ path: ".canopy/intent.md", text: "be useful" }, { path: "gone.md", text: null }],
    });
    expect(s).toBe(
      "Task the work was judged against:\nDoes it meet the intent?\n\nStep summary:\nbuilt it\n\nCheck output:\nok\n\nFile .canopy/intent.md:\nbe useful\n\nFile gone.md: (missing)",
    );
  });

  test("clips each file and stops at the total", () => {
    const big = "x".repeat(EVIDENCE_EACH + 100);
    const files = [1, 2, 3, 4, 5].map((n) => ({ path: `f${n}.md`, text: big }));
    const s = judgeState({ task: "t", summary: "s", check: null, files });
    expect(s).toContain(`File f1.md:\n${"x".repeat(EVIDENCE_EACH)}\n[clipped]`);
    // three full files take 18 KB; the fourth gets what is left of 20 KB
    expect(s).toContain(`File f4.md:\n${"x".repeat(EVIDENCE_TOTAL - 3 * EVIDENCE_EACH)}\n[clipped]`);
    expect(s).not.toContain("File f5.md");
    expect(s.endsWith("(1 more file left out for room)")).toBe(true);
    expect(s).not.toContain("Check output");
  });
});
