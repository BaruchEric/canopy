# Incubator phase 1: the flow engine, implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Flows survive a canopy restart, retry and rewind on their own, stop at a budget, and can be judged against an intent through a new `judge` gate.

**Architecture:** Every change lives in the existing `Flows` class (`src/core/flow.ts`) and the workflow parser, with two new Bun-side helpers: `flowstore.ts` writes one JSON record per flow under the config dir, and `evidence.ts` reads a judge step's files out of the repo. The server wires them in, restores records after the first scan, and stops saving before it stops. The UI shows the judge's answers, the budget and the rewinds in the existing `FlowSheet`.

**Tech Stack:** Bun, TypeScript strict, `bun:test`, React 19, the Vercel AI Gateway through `@ai-sdk/gateway` and `ai`'s `experimental_evaluate` (already used by `src/core/jev.ts`).

**Spec:** `docs/superpowers/specs/2026-10-01-incubator-design.md`, section "Changes to the flow engine". This is plan 1 of 5; phases 2 to 5 (intake and clarify, scout and build-new, renovate and extend, retro) each get their own plan once the phase before has landed.

## Global constraints

- `"strict": true` stays on in both tsconfigs; no `any`, no non-null `!`; a cast only after a runtime check, with a comment.
- `src/core/types.ts`, `src/core/flow.ts`, `src/core/workflow.ts` and `src/core/verdict.ts` stay browser-safe: no Bun or node imports (the UI imports them).
- Use `bun`/`bunx` only. Run the suite as `SHELL=/bin/bash bun test` (the zsh startup makes it flaky).
- Gates before calling anything done: `bun run typecheck && bun run lint && SHELL=/bin/bash bun test && bun run build`.
- Commit after each task with a conventional subject; no backticks in commit messages; end each message with `Claude-Session: https://claude.ai/code/session_01DMvREFYoLgpGe2oQNWq1Xu`. Never push.
- Prose (comments, docs, UI copy) follows the unslop rules: no em dashes, plain words, sentence case.
- Spec values, verbatim: judge passes only with `fit` = meets at 0.7 or more, `evidence` at 0.5 or more, and `rules` under 0.3; `misses` at 0.7 or more is a rejection; evidence clipped to 6 KB each and 20 KB in all; budget frontmatter reads `budget: <runs> runs, <hours>h`; records at `$CANOPY_CONFIG_DIR/flows/<id>.json`; the restart note reads "canopy restarted during this step; read the repo's state and finish the step".

## Review focus

1. A record half-written when the machine died (truncated JSON) must be skipped with a log line, never stop the server from starting. Pinned in Task 8.
2. A test or redeploy calling `server.stop()` must not save every flow as stopped; a gated flow is still gated on disk afterwards. Pinned in Tasks 7 and 9.
3. The retry count must survive a restart, so a flow that used one of two retries gets exactly one more. Pinned in Task 7.
4. A flow parked on its budget must still resume after a restart (the park reason is on the record, not in memory). Pinned in Task 7.
5. An evidence path that is a symlink out of the repo must read as missing, not as the file it points at. Pinned in Task 8.

## File map

| File | Change |
|---|---|
| `src/core/types.ts` | `judge` gate kind; `WorkflowStep.retries/back/evidence`; `Workflow.budget`; `FlowBudget`; `JudgeFit`, `JudgeAnswers`, `Judgment`, `EvidenceFile`; `FlowStep.judgment`; `Flow.budget/spent/tries/rewinds/retryReason/parkedFor/grace/restarted`; `FlowRewind` |
| `src/core/workflow.ts` | parse `retries`, `back`, `evidence`, `budget` |
| `src/core/verdict.ts` | `JUDGE_QUESTIONS`, `JUDGE_THRESHOLDS`, `decideJudge`, `judgeState`, `EVIDENCE_EACH`, `EVIDENCE_TOTAL` |
| `src/core/jev.ts` | `withRetries`, `jevJudge`, `JudgeEvaluator` |
| `src/core/flow.ts` | judge gate, rewinds, budgets and clock, records, `restore`, `detach` |
| `src/core/flowstore.ts` (new, Bun) | `FlowFiles`, `loadFlowRecords`, `parseFlowRecord`, `flowsDir` |
| `src/core/evidence.ts` (new, Bun) | `readEvidence` |
| `src/server/index.ts` | wire the hooks, restore after the scan, detach on stop |
| `ui/src/flows.ts`, `ui/src/components/FlowSheet.tsx`, `ui/src/styles.css` | `budgetWord`, `rewindLines`, judge bars, budget-park button |
| `CLAUDE.md` | the flow, workflow and verdict bullets |
| tests | `workflow.test.ts`, `verdict.test.ts`, `flow.test.ts`, `flowstore.test.ts`, `evidence.test.ts`, `server/flows.test.ts`, `ui/src/flows.test.ts` |

---

### Task 1: Workflow keys for retries, rewinds, evidence and budgets

**Files:**
- Modify: `src/core/types.ts:1093-1128` (`GATE_KINDS`, `WorkflowStep`, `Workflow`)
- Modify: `src/core/workflow.ts`
- Test: `src/core/workflow.test.ts`

**Interfaces:**
- Produces: `GATE_KINDS = ["continue", "ask", "verdict", "judge"]`; `WorkflowStep.retries: number`, `WorkflowStep.back: string` (a step name, default the step's own), `WorkflowStep.evidence: string[]`; `interface FlowBudget { runs: number; hours: number }`; `Workflow.budget: FlowBudget | null`.

- [ ] **Step 1: Write the failing tests**

Append to `src/core/workflow.test.ts`:

```ts
describe("retries, back, evidence and budget", () => {
  const three = (keys: string, front = "") =>
    `---\nblurb: b\n${front}---\n\n## First\n\nOne.\n\n## Second\n${keys}\n\nTwo.\n\n## Third\n\nThree.\n`;

  test("defaults: no retries, back to itself, no evidence, no budget", () => {
    const e = parseWorkflow(`---\nblurb: b\n---\n\n## Do\n\nWork.\n`, meta);
    if (!e.ok) throw new Error(e.error);
    expect(e.workflow.budget).toBeNull();
    expect(e.workflow.steps[0]?.retries).toBe(0);
    expect(e.workflow.steps[0]?.back).toBe("Do");
    expect(e.workflow.steps[0]?.evidence).toEqual([]);
  });

  test("reads every key", () => {
    const e = parseWorkflow(
      three("gate: judge\nretries: 2\nback: First\nevidence: .canopy/intent.md .canopy/research.md", "budget: 30 runs, 6h\n"),
      meta,
    );
    if (!e.ok) throw new Error(e.error);
    expect(e.workflow.budget).toEqual({ runs: 30, hours: 6 });
    const s = e.workflow.steps[1];
    expect(s?.gate).toBe("judge");
    expect(s?.retries).toBe(2);
    expect(s?.back).toBe("First");
    expect(s?.evidence).toEqual([".canopy/intent.md", ".canopy/research.md"]);
  });

  test("a single run and fractional hours", () => {
    const e = parseWorkflow(three("", "budget: 1 run, 0.5h\n"), meta);
    if (!e.ok) throw new Error(e.error);
    expect(e.workflow.budget).toEqual({ runs: 1, hours: 0.5 });
  });

  test.each<[string, string, string]>([
    ["retries: -1", "", "retries must be a whole number from 0 to 10"],
    ["retries: 11", "", "retries must be a whole number from 0 to 10"],
    ["retries: two", "", "retries must be a whole number from 0 to 10"],
    ["back: Third", "", "back must name this step or an earlier one, not Third"],
    ["back: Nope", "", "back names no step called Nope"],
    ["gate: judge\nevidence: /etc/passwd", "", "evidence must be paths inside the repo, not /etc/passwd"],
    ["gate: judge\nevidence: ../x.md", "", "evidence must be paths inside the repo, not ../x.md"],
    ["evidence: a.md", "", "evidence is only read by gate: judge"],
    ["", "budget: lots\n", 'budget must read like "30 runs, 6h", not lots'],
    ["", "budget: 0 runs, 1h\n", 'budget must read like "30 runs, 6h", not 0 runs, 1h'],
    ["", "budget: 3 runs, 0h\n", 'budget must read like "30 runs, 6h", not 3 runs, 0h'],
  ])("refuses %p %p", (keys, front, error) => {
    const e = parseWorkflow(three(keys, front), meta);
    expect(e.ok).toBe(false);
    if (!e.ok) expect(e.error).toContain(error);
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `bun test src/core/workflow.test.ts`
Expected: FAIL. `budget` is undefined, `retries` undefined, and the refusals parse fine.

- [ ] **Step 3: Add the types**

In `src/core/types.ts`, change `GATE_KINDS` and extend the two interfaces:

```ts
export const GATE_KINDS = ["continue", "ask", "verdict", "judge"] as const;
```

Add to `WorkflowStep`, after `agent?`:

```ts
  /** how many times a check or gate that says no sends the flow back before
   *  it fails or parks as it would without retries; 0 is never */
  retries: number;
  /** the step a retry goes back to: this step's own name or an earlier one's */
  back: string;
  /** repo-relative files a judge gate reads beside the summary */
  evidence: string[];
```

Add above `Workflow`:

```ts
/** What a workflow may spend before it parks: agent step runs and hours of
 *  working time. */
export interface FlowBudget {
  runs: number;
  hours: number;
}
```

Add to `Workflow`, after `steps`:

```ts
  /** null when the workflow sets none */
  budget: FlowBudget | null;
```

- [ ] **Step 4: Parse the keys**

In `src/core/workflow.ts`, add `type FlowBudget` to the `./types` import, then add below `agentKey`:

```ts
const MAX_RETRIES = 10;
const BUDGET = /^(\d+)\s+runs?\s*,\s*(\d+(?:\.\d+)?)\s*h$/;

function retriesKey(v: string | undefined, name: string): number {
  if (v === undefined || v === "") return 0;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0 || n > MAX_RETRIES) {
    throw new Bad(`step ${name}: retries must be a whole number from 0 to ${MAX_RETRIES}, not ${v}`);
  }
  return n;
}

function evidenceKey(v: string | undefined, name: string): string[] {
  if (v === undefined || v === "") return [];
  const paths = v.split(/\s+/).filter(Boolean);
  for (const p of paths) {
    if (p.startsWith("/") || p.split("/").includes("..")) {
      throw new Bad(`step ${name}: evidence must be paths inside the repo, not ${p}`);
    }
  }
  return paths;
}

function budgetKey(v: string | undefined): FlowBudget | null {
  if (v === undefined || v === "") return null;
  const m = BUDGET.exec(v);
  const runs = Number(m?.[1]);
  const hours = Number(m?.[2]);
  if (!m || !(runs > 0) || !(hours > 0)) throw new Bad(`budget must read like "30 runs, 6h", not ${v}`);
  return { runs, hours };
}
```

Replace the body of `step()` from `const profile = …` to the end with:

```ts
  const profile = agentKey(keys.get("agent"), `step ${name}: agent`) ?? agent;
  const evidence = evidenceKey(keys.get("evidence"), name);
  if (evidence.length > 0 && gate !== "judge") throw new Bad(`step ${name}: evidence is only read by gate: judge`);
  return {
    name,
    tools: tools(keys.get("tools")),
    turns,
    check,
    gate,
    body,
    retries: retriesKey(keys.get("retries"), name),
    back: keys.get("back") || name,
    evidence,
    ...(profile ? { agent: profile } : {}),
  };
```

In `steps()`, replace the two lines after the loop (`flush();` and the empty check) with:

```ts
  flush();
  if (out.length === 0) throw new Bad("no steps: a workflow needs at least one ## heading");
  out.forEach((s, i) => {
    const to = out.findIndex((t) => t.name === s.back);
    if (to === -1) throw new Bad(`step ${s.name}: back names no step called ${s.back}`);
    if (to > i) throw new Bad(`step ${s.name}: back must name this step or an earlier one, not ${s.back}`);
  });
  return out;
```

In `parseWorkflow`, add after `steps: …,`:

```ts
      budget: budgetKey(keys.get("budget")),
```

- [ ] **Step 5: Run the tests**

Run: `bun test src/core/workflow.test.ts src/core/workflows.test.ts`
Expected: PASS, the old tests included.

- [ ] **Step 6: Typecheck**

Run: `bun run typecheck`
Expected: PASS. If a hand-built `WorkflowStep` or `Workflow` literal fails, add the new fields with their defaults (`retries: 0, back: <its name>, evidence: []`, `budget: null`).

- [ ] **Step 7: Commit**

```bash
git add src/core/types.ts src/core/workflow.ts src/core/workflow.test.ts
git commit -m "feat(workflow): retries, back, evidence and budget keys

Claude-Session: https://claude.ai/code/session_01DMvREFYoLgpGe2oQNWq1Xu"
```

---

### Task 2: The judge's questions, decision and evaluator

**Files:**
- Modify: `src/core/types.ts` (after `Verdict`, and `FlowStep`)
- Modify: `src/core/verdict.ts`
- Modify: `src/core/jev.ts`
- Test: `src/core/verdict.test.ts`

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces: `type JudgeFit = "meets" | "partly" | "misses"`; `interface JudgeAnswers { fit: { choice: JudgeFit; probabilities?: Record<string, number> }; evidence: { probability: number }; rules: { probability: number } }`; `interface Judgment { answers: JudgeAnswers; go: boolean; rejected: boolean; reason: string | null }`; `interface EvidenceFile { path: string; text: string | null }`; `FlowStep.judgment?: Judgment`; `decideJudge(answers: JudgeAnswers): Judgment`; `judgeState(input: { task: string; summary: string; check: string | null; files: EvidenceFile[] }): string`; `EVIDENCE_EACH = 6144`, `EVIDENCE_TOTAL = 20480`; `type JudgeEvaluator = (state: string) => Promise<JudgeAnswers>`; `jevJudge: JudgeEvaluator`.

- [ ] **Step 1: Write the failing tests**

Append to `src/core/verdict.test.ts` (and add `EVIDENCE_EACH, EVIDENCE_TOTAL, JUDGE_THRESHOLDS, decideJudge, judgeState` to the `./verdict` import, `JudgeAnswers` to the type import):

```ts
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
```

- [ ] **Step 2: Run them to see them fail**

Run: `bun test src/core/verdict.test.ts`
Expected: FAIL on the missing exports.

- [ ] **Step 3: Add the types**

In `src/core/types.ts`, after `Verdict`:

```ts
export type JudgeFit = "meets" | "partly" | "misses";

export interface JudgeAnswers {
  fit: { choice: JudgeFit; probabilities?: Record<string, number> };
  evidence: { probability: number };
  rules: { probability: number };
}

/** A judge gate's decision: go on, park, or turn the work down. */
export interface Judgment {
  answers: JudgeAnswers;
  go: boolean;
  /** the judge is sure the work misses; a retry would not help */
  rejected: boolean;
  /** why it may not go, one line; null when go */
  reason: string | null;
}

/** One file a judge step reads; text null when missing or outside the repo. */
export interface EvidenceFile {
  path: string;
  text: string | null;
}
```

In `FlowStep`, after `verdict?`:

```ts
  judgment?: Judgment;
```

- [ ] **Step 4: Write the decision**

In `src/core/verdict.ts`, change the type import to `import type { EvidenceFile, JudgeAnswers, Judgment, Verdict, VerdictAnswers } from "./types";` and append:

```ts
/** What a judge gate asks: whether the work is right, not whether the step
 *  finished. A deploy touches the world outside the repo by design, which
 *  the verdict's off-scope question would park. */
export const JUDGE_QUESTIONS = {
  fit: {
    type: "choice",
    instructions: "Does the work meet the intent and the task it was judged against?",
    criteria: {
      meets: "The work does what the intent and the task ask, and nothing important is missing",
      partly: "Some of what was asked is there, and some is missing, wrong, or only planned",
      misses: "The work does not do what was asked, or the idea itself does not hold up",
    },
  },
  evidence: {
    type: "boolean",
    instructions: "Is what was read (the summary, the check output and the files) enough to trust that answer?",
  },
  rules: {
    type: "boolean",
    instructions:
      "Does anything break the rules: a host not on the allowed list, a license that forbids this use, spending money, a public repository, or a change to a domain or DNS?",
  },
} as const;

export const JUDGE_THRESHOLDS = {
  /** meets needs at least this much probability */
  meets: 0.7,
  /** enough evidence needs at least this much */
  evidence: 0.5,
  /** a broken rule at this much or more parks */
  rules: 0.3,
  /** misses at this much or more is a rejection */
  misses: 0.7,
} as const;

export function decideJudge(answers: JudgeAnswers): Judgment {
  const { fit, evidence, rules } = answers;
  const no = (reason: string, rejected = false): Judgment => ({ answers, go: false, rejected, reason });
  if (rules.probability >= JUDGE_THRESHOLDS.rules) return no("the judge thinks something breaks the rules");
  const p = fit.probabilities?.[fit.choice] ?? 1;
  if (fit.choice === "misses" && p >= JUDGE_THRESHOLDS.misses) return no("the judge says the work misses the intent", true);
  if (evidence.probability < JUDGE_THRESHOLDS.evidence) return no("the judge says there is not enough to go on");
  if (fit.choice === "misses") return no("the judge leans toward the work missing the intent");
  if (fit.choice === "partly") return no("the judge says it only partly meets the intent");
  if (p < JUDGE_THRESHOLDS.meets) return no("not sure the work meets the intent");
  return { answers, go: true, rejected: false, reason: null };
}

export const EVIDENCE_EACH = 6 * 1024;
export const EVIDENCE_TOTAL = 20 * 1024;

/** The text the judge reads: the step's task as the criteria, its summary,
 *  the check's output, then each evidence file clipped to EVIDENCE_EACH
 *  characters and all of them to EVIDENCE_TOTAL. */
export function judgeState(input: { task: string; summary: string; check: string | null; files: EvidenceFile[] }): string {
  const parts = [
    `Task the work was judged against:\n${input.task.trim() || "(none)"}`,
    `Step summary:\n${input.summary.trim() || "(no summary)"}`,
  ];
  if (input.check !== null) parts.push(`Check output:\n${input.check.trim() || "(empty)"}`);
  let room = EVIDENCE_TOTAL;
  let left = 0;
  for (const f of input.files) {
    if (f.text === null) {
      parts.push(`File ${f.path}: (missing)`);
      continue;
    }
    if (room <= 0) {
      left += 1;
      continue;
    }
    const cap = Math.min(EVIDENCE_EACH, room);
    const body = f.text.length > cap ? `${f.text.slice(0, cap)}\n[clipped]` : f.text;
    room -= Math.min(f.text.length, cap);
    parts.push(`File ${f.path}:\n${body}`);
  }
  if (left > 0) parts.push(`(${left} more file${left === 1 ? "" : "s"} left out for room)`);
  return parts.join("\n\n");
}
```

- [ ] **Step 5: Run the tests**

Run: `bun test src/core/verdict.test.ts`
Expected: PASS.

- [ ] **Step 6: Add the evaluator**

In `src/core/jev.ts`, change the imports to:

```ts
import { JUDGE_QUESTIONS, VERDICT_QUESTIONS } from "./verdict";
import type { JudgeAnswers, JudgeFit, VerdictAnswers, VerdictOutcome } from "./types";
```

Replace the whole `export const jev: Evaluator = …` block with:

```ts
/** One short attempt at a time, retried while the error says it may help. */
async function withRetries<T>(attemptOnce: (signal: AbortSignal) => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await attemptOnce(AbortSignal.timeout(ATTEMPT_TIMEOUT_MS));
    } catch (error) {
      if (attempt >= ATTEMPTS || !isRetryable(error)) throw error;
    }
  }
}

export const jev: Evaluator = (state) =>
  withRetries(async (abortSignal) => {
    const gateway = createGateway({ apiKey: gatewayApiKey() });
    const result = await evaluate({
      model: gateway.evaluationModel(JEV_MODEL),
      state,
      questions: VERDICT_QUESTIONS,
      maxRetries: 0,
      abortSignal,
    });
    const a = result.answers;
    const choice = a.outcome.choice;
    if (!isOutcome(choice)) throw new Error(`unexpected outcome: ${String(choice)}`);
    return {
      outcome: { choice, probabilities: a.outcome.probabilities },
      needsYou: { probability: a.needsYou.probability },
      offScope: { probability: a.offScope.probability },
    };
  });

export type JudgeEvaluator = (state: string) => Promise<JudgeAnswers>;

const isFit = (v: unknown): v is JudgeFit => v === "meets" || v === "partly" || v === "misses";

/** The same classifier asked the judge's questions. */
export const jevJudge: JudgeEvaluator = (state) =>
  withRetries(async (abortSignal) => {
    const gateway = createGateway({ apiKey: gatewayApiKey() });
    const result = await evaluate({
      model: gateway.evaluationModel(JEV_MODEL),
      state,
      questions: JUDGE_QUESTIONS,
      maxRetries: 0,
      abortSignal,
    });
    const a = result.answers;
    const choice = a.fit.choice;
    if (!isFit(choice)) throw new Error(`unexpected fit: ${String(choice)}`);
    return {
      fit: { choice, probabilities: a.fit.probabilities },
      evidence: { probability: a.evidence.probability },
      rules: { probability: a.rules.probability },
    };
  });
```

- [ ] **Step 7: Typecheck, and one live call when a key is at hand**

Run: `bun run typecheck`
Expected: PASS.

If `AI_GATEWAY_API_KEY` or `VERCEL_AI_GATEWAY_API_KEY` is set in this shell, run:

```bash
bun -e 'import { jevJudge } from "./src/core/jev"; console.log(JSON.stringify(await jevJudge("Task the work was judged against:\nA page that says hello.\n\nStep summary:\nThe page says hello at /.")))'
```

Expected: JSON with `fit.choice` one of meets, partly, misses. Without a key, say in the task report that the live call was skipped.

- [ ] **Step 8: Commit**

```bash
git add src/core/types.ts src/core/verdict.ts src/core/verdict.test.ts src/core/jev.ts
git commit -m "feat(verdict): a judge gate's questions, decision and evaluator

Claude-Session: https://claude.ai/code/session_01DMvREFYoLgpGe2oQNWq1Xu"
```

---

### Task 3: The judge gate in Flows

**Files:**
- Modify: `src/core/flow.ts` (imports, `FlowHooks`, `gate()`)
- Test: `src/core/flow.test.ts`

**Interfaces:**
- Consumes: `decideJudge`, `judgeState` (Task 2); `WorkflowStep.evidence` (Task 1).
- Produces: `FlowHooks.judge?: ((state: string) => Promise<JudgeAnswers>) | null`; `FlowHooks.evidence?: (repo: Repo, paths: string[]) => Promise<EvidenceFile[]>`; `FlowStep.judgment` set at a judge gate.

- [ ] **Step 1: Extend the test setup**

In `src/core/flow.test.ts`, add `JudgeAnswers` and `EvidenceFile` to the `./types` import, then replace `setup` with:

```ts
function setup(opts: {
  check?: (cmd: string) => CheckResult;
  evaluator?: ((state: string) => Promise<VerdictAnswers>) | null;
  judge?: ((state: string) => Promise<JudgeAnswers>) | null;
  evidence?: (repo: Repo, paths: string[]) => Promise<EvidenceFile[]>;
  status?: () => Promise<Repo["status"]>;
} = {}) {
  const runner = new FakeRunner();
  const changes: Flow[] = [];
  const gone: string[] = [];
  const checks: string[] = [];
  const fleets: Fleet[] = [];
  const fleetGone: string[] = [];
  const flows = new Flows(runner, {
    onChange: (f) => changes.push(structuredClone(f)),
    onGone: (id) => gone.push(id),
    onFleet: (f) => fleets.push(structuredClone(f)),
    onFleetGone: (id) => fleetGone.push(id),
    check: async (_repo, command) => {
      checks.push(command);
      return opts.check ? opts.check(command) : { exit: 0, output: "" };
    },
    evaluator: opts.evaluator ?? null,
    judge: opts.judge ?? null,
    evidence: opts.evidence,
    status: opts.status,
  });
  runner.onChange = (run) => flows.onRun(run);
  return { runner, flows, changes, gone, checks, fleets, fleetGone };
}
```

- [ ] **Step 2: Write the failing tests**

Append to `src/core/flow.test.ts`:

```ts
const MEETS: JudgeAnswers = { fit: { choice: "meets", probabilities: { meets: 0.9 } }, evidence: { probability: 0.9 }, rules: { probability: 0 } };

const JUDGED = wf(`---
blurb: b
---

## Build

Build it.

## Accept
gate: judge
evidence: .canopy/intent.md

Does it meet the intent?

## Ship

Ship it.
`);

describe("the judge gate", () => {
  test("reads the evidence, asks the judge, and goes on a meets", async () => {
    const states: string[] = [];
    const asked: string[][] = [];
    const { runner, flows } = setup({
      judge: async (s) => {
        states.push(s);
        return MEETS;
      },
      evidence: async (_r, paths) => {
        asked.push(paths);
        return [{ path: ".canopy/intent.md", text: "be useful" }];
      },
    });
    const flow = flows.start(repo(), JUDGED, "", DEFAULT_AGENT);
    runner.end("run1", "done", "built");
    await flush();
    runner.end("run2", "done", "it does");
    await flush();
    const f = flows.get(flow.id);
    expect(asked).toEqual([[".canopy/intent.md"]]);
    expect(states[0]).toContain("Task the work was judged against:\nDoes it meet the intent?");
    expect(states[0]).toContain("Step summary:\nit does");
    expect(states[0]).toContain("File .canopy/intent.md:\nbe useful");
    expect(f?.steps[1]?.judgment?.go).toBe(true);
    expect(f?.current).toBe(2);
    expect(f?.steps[2]?.status).toBe("running");
  });

  test("a sure miss parks as a rejection", async () => {
    const { runner, flows } = setup({ judge: async () => ({ ...MEETS, fit: { choice: "misses", probabilities: { misses: 0.9 } } }) });
    const flow = flows.start(repo(), JUDGED, "", DEFAULT_AGENT);
    runner.end("run1", "done", "built");
    await flush();
    runner.end("run2", "done", "it does not");
    await flush();
    const f = flows.get(flow.id);
    expect(f?.status).toBe("gated");
    expect(f?.steps[1]?.judgment?.rejected).toBe(true);
    expect(f?.steps[1]?.reason).toBe("the judge says the work misses the intent");
  });

  test("without a judge it asks; a judge that fails parks with the error", async () => {
    const a = setup({ judge: null });
    const fa = a.flows.start(repo(), JUDGED, "", DEFAULT_AGENT);
    a.runner.end("run1", "done", "x");
    await flush();
    a.runner.end("run2", "done", "y");
    await flush();
    expect(a.flows.get(fa.id)?.steps[1]?.reason).toBe("no gateway key, so the judgment is yours");

    const b = setup({ judge: async () => { throw new Error("gateway down"); } });
    const fb = b.flows.start(repo(), JUDGED, "", DEFAULT_AGENT);
    b.runner.end("run1", "done", "x");
    await flush();
    b.runner.end("run2", "done", "y");
    await flush();
    expect(b.flows.get(fb.id)?.steps[1]?.reason).toBe("judgment unavailable: gateway down");
  });

  test("evidence that cannot be read reaches the judge as missing", async () => {
    const states: string[] = [];
    const { runner, flows } = setup({
      judge: async (s) => {
        states.push(s);
        return MEETS;
      },
      evidence: async () => { throw new Error("EACCES"); },
    });
    flows.start(repo(), JUDGED, "", DEFAULT_AGENT);
    runner.end("run1", "done", "x");
    await flush();
    runner.end("run2", "done", "y");
    await flush();
    expect(states[0]).toContain("File .canopy/intent.md: (missing)");
  });
});
```

- [ ] **Step 3: Run them to see them fail**

Run: `bun test src/core/flow.test.ts`
Expected: FAIL; the judge gate falls through the `switch` and the flow never moves.

- [ ] **Step 4: Implement**

In `src/core/flow.ts`, change the verdict import to `import { decide, decideJudge, judgeState, verdictState } from "./verdict";` and add `type EvidenceFile` and `type JudgeAnswers` to the `./types` import. Add to `FlowHooks` after `evaluator`:

```ts
  /** null or absent when there is no gateway key: judge gates then ask */
  judge?: ((state: string) => Promise<JudgeAnswers>) | null;
  /** reads a judge step's evidence files out of the repo */
  evidence?: (repo: Repo, paths: string[]) => Promise<EvidenceFile[]>;
```

Add a module-level helper above `class Flows`:

```ts
const errText = (err: unknown): string => String(err instanceof Error ? err.message : err);
```

Add this case to the `switch (def.gate)` in `gate()`, after the `verdict` case:

```ts
      case "judge": {
        const judge = this.hooks.judge;
        if (!judge) {
          this.park(live, "no gateway key, so the judgment is yours");
          return;
        }
        let files: EvidenceFile[] = [];
        if (def.evidence.length > 0 && this.hooks.evidence) {
          try {
            files = await this.hooks.evidence(live.repo, def.evidence);
          } catch {
            files = def.evidence.map((path) => ({ path, text: null }));
          }
        } else {
          files = def.evidence.map((path) => ({ path, text: null }));
        }
        if (!isFlowActive(live.flow)) return;
        try {
          const answers = await judge(
            judgeState({ task: def.body, summary: step.summary ?? "", check: step.check?.output ?? null, files }),
          );
          if (!isFlowActive(live.flow)) return;
          const j = decideJudge(answers);
          step.judgment = j;
          if (j.go) await this.pass(live);
          else this.park(live, j.reason ?? "the judge said no");
        } catch (err) {
          if (!isFlowActive(live.flow)) return;
          this.park(live, `judgment unavailable: ${errText(err)}`);
        }
        return;
      }
```

- [ ] **Step 5: Run the tests**

Run: `bun test src/core/flow.test.ts`
Expected: PASS, the old tests included.

- [ ] **Step 6: Commit**

```bash
git add src/core/flow.ts src/core/flow.test.ts
git commit -m "feat(flow): the judge gate reads evidence and asks the judge

Claude-Session: https://claude.ai/code/session_01DMvREFYoLgpGe2oQNWq1Xu"
```

---

### Task 4: Retries and rewinds

**Files:**
- Modify: `src/core/types.ts` (`Flow`, new `FlowRewind`)
- Modify: `src/core/flow.ts` (`FlowHooks.now`, `LiveFlow`, `runStep`, `check`, `gate`, `resume`, new `refuse`, `rewind`, `resetStep`, `now`)
- Test: `src/core/flow.test.ts`

**Interfaces:**
- Consumes: `WorkflowStep.retries`, `WorkflowStep.back` (Task 1); the judge case (Task 3).
- Produces: `Flow.retryReason?: string`, `Flow.tries?: Record<string, number>`, `Flow.rewinds?: FlowRewind[]`, `interface FlowRewind { from: string; to: string; reason: string; at: number }`; `FlowHooks.now?: () => number`; private `Flows.resetStep(step)`, `Flows.rewind(live, reason): boolean`, `Flows.now()`.

- [ ] **Step 1: Write the failing tests**

In `src/core/flow.test.ts`, add `now?: () => number;` to `setup`'s options and `now: opts.now,` to the hooks it passes. Then append:

```ts
const CHECKED_RETRY = wf(`---
blurb: b
---

## Build

Build it.

## Test
check: bun test
retries: 2
back: Build
`);

describe("retries", () => {
  test("a failing check goes back to its back step with the reason, and passes once the check does", async () => {
    let calls = 0;
    const { runner, flows } = setup({ check: () => (++calls < 3 ? { exit: 1, output: "2 fail" } : { exit: 0, output: "ok" }) });
    const flow = flows.start(repo(), CHECKED_RETRY, "", DEFAULT_AGENT);
    runner.end("run1", "done", "built");
    await flush();
    expect(flows.get(flow.id)?.current).toBe(0);
    expect(flows.get(flow.id)?.tries).toEqual({ Test: 1 });
    expect(flows.get(flow.id)?.rewinds?.[0]).toMatchObject({ from: "Test", to: "Build" });
    expect(runner.specs[1]?.task).toContain("the Test step did not accept the work: check failed with exit 1:\n2 fail");
    expect(runner.dismissed).toEqual(["run1"]);
    runner.end("run2", "done", "built again");
    await flush();
    runner.end("run3", "done", "built a third time");
    await flush();
    expect(flows.get(flow.id)?.status).toBe("done");
    expect(flows.get(flow.id)?.tries).toEqual({ Test: 2 });
  });

  test("out of retries, a failing check fails the flow as it did before", async () => {
    const { runner, flows } = setup({ check: () => ({ exit: 1, output: "fail" }) });
    const flow = flows.start(repo(), CHECKED_RETRY, "", DEFAULT_AGENT);
    for (const id of ["run1", "run2", "run3"]) {
      runner.end(id, "done", "x");
      await flush();
    }
    const f = flows.get(flow.id);
    expect(f?.status).toBe("failed");
    expect(f?.steps[1]?.reason).toBe("check failed with exit 1");
    expect(runner.specs.length).toBe(3);
  });

  test("a judge that says partly sends the work back, then parks once retries run out", async () => {
    const J = wf(`---\nblurb: b\n---\n\n## Build\n\nBuild.\n\n## Accept\ngate: judge\nretries: 1\nback: Build\n\nJudge.\n`);
    const partly: JudgeAnswers = { fit: { choice: "partly", probabilities: { partly: 0.9 } }, evidence: { probability: 0.9 }, rules: { probability: 0 } };
    const { runner, flows } = setup({ judge: async () => partly });
    const flow = flows.start(repo(), J, "", DEFAULT_AGENT);
    for (const id of ["run1", "run2", "run3", "run4"]) {
      runner.end(id, "done", "x");
      await flush();
    }
    const f = flows.get(flow.id);
    expect(f?.status).toBe("gated");
    expect(f?.current).toBe(1);
    expect(f?.steps[1]?.reason).toBe("the judge says it only partly meets the intent");
    expect(runner.specs.length).toBe(4);
  });

  test("a rejection and a missing evaluator never retry", async () => {
    const J = wf(`---\nblurb: b\n---\n\n## Accept\ngate: judge\nretries: 2\n\nJudge.\n`);
    const a = setup({ judge: async () => ({ fit: { choice: "misses", probabilities: { misses: 0.9 } }, evidence: { probability: 0.9 }, rules: { probability: 0 } }) });
    const fa = a.flows.start(repo(), J, "", DEFAULT_AGENT);
    a.runner.end("run1", "done", "x");
    await flush();
    expect(a.flows.get(fa.id)?.status).toBe("gated");
    expect(a.flows.get(fa.id)?.tries).toBeUndefined();

    const V = wf(`---\nblurb: b\n---\n\n## One\ngate: verdict\nretries: 2\n\nx\n`);
    const b = setup({ evaluator: null });
    const fb = b.flows.start(repo(), V, "", DEFAULT_AGENT);
    b.runner.end("run1", "done", "x");
    await flush();
    expect(b.flows.get(fb.id)?.steps[0]?.reason).toContain("no gateway key");
    expect(b.flows.get(fb.id)?.tries).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `bun test src/core/flow.test.ts`
Expected: FAIL. The check fails the flow at once and `tries` is undefined.

- [ ] **Step 3: Add the types**

In `src/core/types.ts`, above `Flow`:

```ts
/** A check or gate that said no and sent the flow back. */
export interface FlowRewind {
  /** the step that said no */
  from: string;
  /** the step the flow went back to */
  to: string;
  reason: string;
  at: number;
}
```

Add to `Flow`, after `outcome?`:

```ts
  /** why the current step is running again, carried into its next prompt */
  retryReason?: string;
  /** retries used, by step name */
  tries?: Record<string, number>;
  /** every rewind, oldest first */
  rewinds?: FlowRewind[];
```

- [ ] **Step 4: Implement**

In `src/core/flow.ts`:

1. Add `type FlowStep` to the `./types` import; `resetStep` takes one.
2. Add to `FlowHooks`:

```ts
  /** the clock, for tests; Date.now otherwise */
  now?: () => number;
```

3. In `LiveFlow`, delete the `retry?: string` field and its comment.
4. Add a module-level helper next to `errText`:

```ts
/** The end of a check's output, which is where a failure says what failed. */
const tailOf = (s: string, n = 2000): string => (s.length > n ? s.slice(-n) : s);
```

5. Add these private methods to `Flows`, after `prune()`:

```ts
  private now(): number {
    return this.hooks.now?.() ?? Date.now();
  }

  /** Back to pending, its run dismissed and everything it said dropped. */
  private resetStep(step: FlowStep | undefined): void {
    if (!step) return;
    if (step.runId) {
      try {
        this.runner.dismiss(step.runId);
      } catch {
        // still active or already gone
      }
    }
    delete step.runId;
    delete step.check;
    delete step.verdict;
    delete step.judgment;
    delete step.summary;
    delete step.reason;
    step.status = "pending";
  }

  /** A check or gate said no: back to the step's `back` while it has retries
   *  left, else whatever it would have done without retries. */
  private refuse(live: LiveFlow, reason: string, otherwise: () => void): void {
    if (!this.rewind(live, reason)) otherwise();
  }

  private rewind(live: LiveFlow, reason: string): boolean {
    const { flow, workflow } = live;
    const def = workflow.steps[flow.current];
    if (!def || def.retries <= 0) return false;
    const tries = (flow.tries ??= {});
    const used = tries[def.name] ?? 0;
    if (used >= def.retries) return false;
    tries[def.name] = used + 1;
    const found = workflow.steps.findIndex((s) => s.name === def.back);
    const to = found === -1 || found > flow.current ? flow.current : found;
    for (let i = to; i <= flow.current; i++) this.resetStep(flow.steps[i]);
    const toName = workflow.steps[to]?.name ?? def.name;
    (flow.rewinds ??= []).push({ from: def.name, to: toName, reason, at: this.now() });
    flow.retryReason = to === flow.current ? reason : `the ${def.name} step did not accept the work: ${reason}`;
    flow.current = to;
    void this.runStep(live);
    return true;
  }
```

6. In `runStep`, replace

```ts
    const spec = stepSpec(workflow, flow.current, this.summaries(live), live.retry);
    delete live.retry;
```

with

```ts
    const spec = stepSpec(workflow, flow.current, this.summaries(live), flow.retryReason);
    delete flow.retryReason;
```

7. In `check()`, replace the `if (r.exit !== 0) { … }` block with:

```ts
    if (r.exit !== 0) {
      const reason = `check failed with exit ${r.exit}`;
      this.refuse(live, `${reason}:\n${tailOf(r.output)}`, () => {
        step.status = "failed";
        step.reason = reason;
        this.end(live, "failed", reason);
      });
      return;
    }
```

8. In the `verdict` case of `gate()`, replace `else this.park(live, v.reason ?? "the verdict said no");` with:

```ts
          else {
            const reason = v.reason ?? "the verdict said no";
            this.refuse(live, reason, () => this.park(live, reason));
          }
```

9. In the `judge` case, replace `else this.park(live, j.reason ?? "the judge said no");` with:

```ts
          else if (j.rejected) this.park(live, j.reason ?? "the judge turned the work down");
          else {
            const reason = j.reason ?? "the judge said no";
            this.refuse(live, reason, () => this.park(live, reason));
          }
```

10. In `resume()`, replace the whole `if (choice === "retry") { … }` block with:

```ts
    if (choice === "retry") {
      if (step.reason) live.flow.retryReason = step.reason;
      this.resetStep(step);
      void this.runStep(live);
      return live.flow;
    }
```

- [ ] **Step 5: Run the tests**

Run: `bun test src/core/flow.test.ts`
Expected: PASS, including the old "retry runs the same step again with the reason, replacing its run".

- [ ] **Step 6: Commit**

```bash
git add src/core/types.ts src/core/flow.ts src/core/flow.test.ts
git commit -m "feat(flow): retries rewind to the back step with the reason

Claude-Session: https://claude.ai/code/session_01DMvREFYoLgpGe2oQNWq1Xu"
```

---

### Task 5: Budgets

**Files:**
- Modify: `src/core/types.ts` (`Flow`)
- Modify: `src/core/flow.ts` (`overBudget`, `LiveFlow.since`, `start`, `onRun`, `runStep`, `park`, `end`, `resume`, new `clock`, `spentNow`)
- Test: `src/core/flow.test.ts`

**Interfaces:**
- Consumes: `Workflow.budget`, `FlowBudget` (Task 1); `now()`, `resetStep()` (Task 4).
- Produces: `overBudget(budget: FlowBudget | null, spent: { runs: number; workMs: number }): string | null` (exported); `Flow.budget?: FlowBudget`, `Flow.spent?: { runs: number; workMs: number }`, `Flow.parkedFor?: "budget"`, `Flow.grace?: number`.

- [ ] **Step 1: Write the failing tests**

In `src/core/flow.test.ts`, add `overBudget` to the `./flow` import and a method to `FakeRunner`:

```ts
  /** moves a run between working and waiting without ending it */
  set(id: string, status: Run["status"]): void {
    const run = this.runs.get(id);
    if (!run) throw new Error(id);
    run.status = status;
    this.onChange(run);
  }
```

Append:

```ts
describe("overBudget", () => {
  test("says which limit was reached, runs first", () => {
    expect(overBudget(null, { runs: 99, workMs: 9e9 })).toBeNull();
    expect(overBudget({ runs: 3, hours: 1 }, { runs: 2, workMs: 0 })).toBeNull();
    expect(overBudget({ runs: 3, hours: 1 }, { runs: 3, workMs: 0 })).toBe("budget spent: 3 runs");
    expect(overBudget({ runs: 3, hours: 1 }, { runs: 1, workMs: 3_600_000 })).toBe("budget spent: 1h");
  });
});

describe("budgets", () => {
  const ABC = (budget: string) => wf(`---\nblurb: b\nbudget: ${budget}\n---\n\n## A\n\na\n\n## B\n\nb\n\n## C\n\nc\n`);

  test("parks before the run that would pass the run budget; continue grants one more step", async () => {
    const { runner, flows } = setup();
    const flow = flows.start(repo(), ABC("2 runs, 9h"), "", DEFAULT_AGENT);
    expect(flow.budget).toEqual({ runs: 2, hours: 9 });
    runner.end("run1", "done", "a");
    await flush();
    runner.end("run2", "done", "b");
    await flush();
    let f = flows.get(flow.id);
    expect(f?.status).toBe("gated");
    expect(f?.parkedFor).toBe("budget");
    expect(f?.steps[2]?.reason).toBe("budget spent: 2 runs");
    expect(f?.spent?.runs).toBe(2);
    flows.resume(flow.id, "continue");
    await flush();
    f = flows.get(flow.id);
    expect(f?.parkedFor).toBeUndefined();
    expect(f?.steps[2]?.status).toBe("running");
    runner.end("run3", "done", "c");
    await flush();
    expect(flows.get(flow.id)?.status).toBe("done");
  });

  test("parks on working time", async () => {
    let t = 0;
    const { runner, flows } = setup({ now: () => t });
    const flow = flows.start(repo(), ABC("9 runs, 1h"), "", DEFAULT_AGENT);
    t = 3_600_000;
    runner.end("run1", "done", "a");
    await flush();
    const f = flows.get(flow.id);
    expect(f?.steps[1]?.reason).toBe("budget spent: 1h");
    expect(f?.spent?.workMs).toBe(3_600_000);
  });

  test("time waiting on a prompt or parked at a gate is not counted", async () => {
    let t = 0;
    const W = wf(`---\nblurb: b\nbudget: 9 runs, 1h\n---\n\n## A\ngate: ask\n\na\n\n## B\n\nb\n`);
    const { runner, flows } = setup({ now: () => t });
    const flow = flows.start(repo(), W, "", DEFAULT_AGENT);
    t = 10 * 60_000;
    runner.set("run1", "waiting");
    t += 2 * 3_600_000;
    runner.set("run1", "working");
    t += 5 * 60_000;
    runner.end("run1", "done", "a");
    await flush();
    t += 5 * 3_600_000;
    flows.resume(flow.id, "continue");
    await flush();
    const f = flows.get(flow.id);
    expect(f?.spent?.workMs).toBe(15 * 60_000);
    expect(f?.steps[1]?.status).toBe("running");
  });

  test("stop at a budget park stops the flow", async () => {
    const { runner, flows } = setup();
    const flow = flows.start(repo(), ABC("1 run, 9h"), "", DEFAULT_AGENT);
    runner.end("run1", "done", "a");
    await flush();
    flows.resume(flow.id, "stop");
    expect(flows.get(flow.id)?.status).toBe("stopped");
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `bun test src/core/flow.test.ts`
Expected: FAIL on the missing `overBudget` export.

- [ ] **Step 3: Add the fields**

In `src/core/types.ts`, add `FlowBudget` usage to `Flow` after `rewinds?`:

```ts
  /** the workflow's budget, copied at start for the sheet */
  budget?: FlowBudget;
  /** agent step runs started and working time so far */
  spent?: { runs: number; workMs: number };
  /** set while the flow is parked because its budget is spent */
  parkedFor?: "budget";
  /** steps granted past the budget by continuing a budget park */
  grace?: number;
```

- [ ] **Step 4: Implement**

In `src/core/flow.ts`, add `type FlowBudget` to the `./types` import, then:

1. Below `stepAgent`, add:

```ts
/** Which limit a flow has reached, as the park reason, or null. */
export function overBudget(budget: FlowBudget | null, spent: { runs: number; workMs: number }): string | null {
  if (!budget) return null;
  if (spent.runs >= budget.runs) return `budget spent: ${budget.runs} runs`;
  if (spent.workMs >= budget.hours * 3_600_000) return `budget spent: ${budget.hours}h`;
  return null;
}

const spentOf = (flow: Flow): { runs: number; workMs: number } => (flow.spent ??= { runs: 0, workMs: 0 });
```

2. In `LiveFlow`, add:

```ts
  /** when the working clock last started; absent while it is stopped */
  since?: number;
```

3. In `start()`, add to the `flow` literal after `startedAt`:

```ts
      ...(workflow.budget ? { budget: workflow.budget } : {}),
      spent: { runs: 0, workMs: 0 },
```

4. Add private methods after `now()`:

```ts
  /** Working time runs while a step's run works or its check and gate run,
   *  and stops while the run waits on a prompt or the flow is parked. */
  private clock(live: LiveFlow, on: boolean): void {
    const now = this.now();
    if (on) {
      live.since ??= now;
      return;
    }
    if (live.since === undefined) return;
    spentOf(live.flow).workMs += now - live.since;
    delete live.since;
  }

  private spentNow(live: LiveFlow): { runs: number; workMs: number } {
    const s = spentOf(live.flow);
    return { runs: s.runs, workMs: s.workMs + (live.since === undefined ? 0 : this.now() - live.since) };
  }
```

5. In `onRun`, inside the `working | waiting | idle` branch, add after `const status = …`:

```ts
      this.clock(live, status === "working");
```

6. In `runStep`, after `if (!def || !step) return;`, add:

```ts
    if (def.body) {
      const over = overBudget(workflow.budget, this.spentNow(live));
      if (over) {
        if ((flow.grace ?? 0) > 0) {
          flow.grace = (flow.grace ?? 0) - 1;
        } else {
          flow.parkedFor = "budget";
          this.park(live, over);
          return;
        }
      }
    }
    this.clock(live, true);
```

and right after `step.runId = run.id;`, add:

```ts
    spentOf(flow).runs += 1;
```

7. In `park()`, add `this.clock(live, false);` as its first line after the `if (!step) return;`. In `end()`, add `this.clock(live, false);` after the `if (!isFlowActive(live.flow)) return;` line.

8. In `resume()`, after `if (!step) throw new Error("no current step");`, add:

```ts
    if (live.flow.parkedFor === "budget" && choice !== "stop") {
      // continue and retry both mean: allow one more step, and run the one that was waiting
      delete live.flow.parkedFor;
      live.flow.grace = (live.flow.grace ?? 0) + 1;
      this.resetStep(step);
      void this.runStep(live);
      return live.flow;
    }
    delete live.flow.parkedFor;
```

- [ ] **Step 5: Run the tests**

Run: `bun test src/core/flow.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/core/types.ts src/core/flow.ts src/core/flow.test.ts
git commit -m "feat(flow): a budget of runs and working hours parks the flow

Claude-Session: https://claude.ai/code/session_01DMvREFYoLgpGe2oQNWq1Xu"
```

---

### Task 6: Records, restore and detach in Flows

**Files:**
- Modify: `src/core/types.ts` (`Flow.restarted`)
- Modify: `src/core/flow.ts` (`FlowRecord`, `FlowHooks.save/forget`, `stepSpec`, `emit`, `dismiss`, `prune`, `runStep`, new `restore`, `detach`, `record`)
- Test: `src/core/flow.test.ts`

**Interfaces:**
- Consumes: everything above.
- Produces: `interface FlowRecord { v: 1; flow: Flow; workflow: Workflow; before: string; savedAt: number }`; `FlowHooks.save?: (rec: FlowRecord) => void` (the consumer must serialize at once: the flow object keeps changing); `FlowHooks.forget?: (id: string) => void`; `Flows.restore(records: FlowRecord[], resolve: (repoId: string) => Repo | undefined, agentFor: (repo: Repo) => StepAgent): void`; `Flows.detach(): void`; `stepSpec(wf, index, summaries, retryReason?, restarted?)`; `RESTART_NOTE`.

- [ ] **Step 1: Write the failing tests**

In `src/core/flow.test.ts`, add `type FlowRecord` and `RESTART_NOTE` to the `./flow` import. In `setup`, add `const saved: FlowRecord[] = []; const forgotten: string[] = [];` and these hooks:

```ts
    save: (rec) => saved.push(JSON.parse(JSON.stringify(rec)) as FlowRecord),
    forget: (id) => forgotten.push(id),
```

and return `saved` and `forgotten` with the rest. Append:

```ts
const lastRecord = (saved: FlowRecord[], id: string): FlowRecord => {
  const rec = saved.filter((r) => r.flow.id === id).at(-1);
  if (!rec) throw new Error(`no record for ${id}`);
  return JSON.parse(JSON.stringify(rec)) as FlowRecord;
};
const sameAgent = () => () => DEFAULT_AGENT;

describe("records and restore", () => {
  test("a gated flow comes back gated and goes on from its snapshot", async () => {
    const a = setup();
    const flow = a.flows.start(repo(), TWO, "", DEFAULT_AGENT);
    a.runner.end("run1", "done", "first done");
    await flush();
    const b = setup();
    b.flows.restore([lastRecord(a.saved, flow.id)], () => repo(), sameAgent);
    expect(b.flows.get(flow.id)?.status).toBe("gated");
    expect(b.runner.specs.length).toBe(0);
    b.flows.resume(flow.id, "continue");
    await flush();
    expect(b.runner.specs[0]?.verb).toBe("do two · Second");
    expect(b.runner.specs[0]?.task).toContain("First: first done");
  });

  test("a flow caught mid-step reruns that step with the restart note, the rerun counted", async () => {
    const a = setup();
    const flow = a.flows.start(repo(), TWO, "", DEFAULT_AGENT);
    const b = setup();
    b.flows.restore([lastRecord(a.saved, flow.id)], () => repo(), sameAgent);
    expect(b.runner.specs[0]?.task.startsWith(RESTART_NOTE)).toBe(true);
    expect(b.flows.get(flow.id)?.steps[0]).toMatchObject({ status: "running", runId: "run1" });
    expect(b.flows.get(flow.id)?.spent?.runs).toBe(2);
    expect(b.flows.get(flow.id)?.restarted).toBeUndefined();
  });

  test("the retry count survives, so a flow with one retry left gets exactly one", async () => {
    const fail = () => ({ exit: 1, output: "fail" });
    const a = setup({ check: fail });
    const flow = a.flows.start(repo(), CHECKED_RETRY, "", DEFAULT_AGENT);
    a.runner.end("run1", "done", "x");
    await flush();
    const rec = lastRecord(a.saved, flow.id);
    expect(rec.flow.tries).toEqual({ Test: 1 });
    const b = setup({ check: fail });
    b.flows.restore([rec], () => repo(), sameAgent);
    b.runner.end("run1", "done", "x");
    await flush();
    b.runner.end("run2", "done", "x");
    await flush();
    expect(b.flows.get(flow.id)?.status).toBe("failed");
    expect(b.flows.get(flow.id)?.tries).toEqual({ Test: 2 });
    expect(b.runner.specs.length).toBe(2);
  });

  test("a budget park still resumes after a restart", async () => {
    const W = wf(`---\nblurb: b\nbudget: 1 run, 9h\n---\n\n## A\n\na\n\n## B\n\nb\n`);
    const a = setup();
    const flow = a.flows.start(repo(), W, "", DEFAULT_AGENT);
    a.runner.end("run1", "done", "a");
    await flush();
    const b = setup();
    b.flows.restore([lastRecord(a.saved, flow.id)], () => repo(), sameAgent);
    expect(b.flows.get(flow.id)?.parkedFor).toBe("budget");
    b.flows.resume(flow.id, "continue");
    await flush();
    expect(b.flows.get(flow.id)?.steps[1]?.status).toBe("running");
  });

  test("a flow whose repo left the scan fails with the reason; a finished one stays finished; a fleet id is dropped", async () => {
    const a = setup();
    const working = a.flows.start(repo(), TWO, "", DEFAULT_AGENT);
    const rec = lastRecord(a.saved, working.id);
    rec.flow.fleetId = "gone";
    const b = setup();
    b.flows.restore([rec], () => undefined, sameAgent);
    const f = b.flows.get(working.id);
    expect(f?.status).toBe("failed");
    expect(f?.error).toBe("the repo is not in the scan any more");
    expect(f?.fleetId).toBeUndefined();
    expect(b.runner.specs.length).toBe(0);

    const c = setup();
    const done = c.flows.start(repo(), TWO, "", DEFAULT_AGENT);
    c.flows.stop(done.id);
    await flush();
    const d = setup();
    d.flows.restore([lastRecord(c.saved, done.id)], () => repo(), sameAgent);
    expect(d.flows.get(done.id)?.status).toBe("stopped");
    expect(d.runner.specs.length).toBe(0);
  });

  test("detach stops saving, so a server stopping does not save every flow as stopped", async () => {
    const a = setup();
    const flow = a.flows.start(repo(), TWO, "", DEFAULT_AGENT);
    a.runner.end("run1", "done", "x");
    await flush();
    const before = a.saved.length;
    a.flows.detach();
    a.flows.stopAll();
    expect(a.flows.get(flow.id)?.status).toBe("stopped");
    expect(a.saved.length).toBe(before);
    expect(lastRecord(a.saved, flow.id).flow.status).toBe("gated");
  });

  test("dismissing forgets the record", async () => {
    const a = setup();
    const flow = a.flows.start(repo(), TWO, "", DEFAULT_AGENT);
    a.flows.stop(flow.id);
    await flush();
    a.flows.dismiss(flow.id);
    expect(a.forgotten).toEqual([flow.id]);
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `bun test src/core/flow.test.ts`
Expected: FAIL on the missing exports.

- [ ] **Step 3: Add the field**

In `src/core/types.ts`, add to `Flow` after `grace?`:

```ts
  /** set between a restore and the rerun of the step the restart cut short */
  restarted?: boolean;
```

- [ ] **Step 4: Implement**

In `src/core/flow.ts`, add `DEFAULT_AGENT` to the `./types` value import, then:

1. Below the `CheckResult` interface, add:

```ts
/** What a flow leaves on disk: the flow, the workflow it started with (so a
 *  file edited since does not change a flow in progress), and the status
 *  fingerprint its outcome is judged against. */
export interface FlowRecord {
  v: 1;
  flow: Flow;
  workflow: Workflow;
  before: string;
  savedAt: number;
}

export const RESTART_NOTE = "canopy restarted during this step; read the repo's state and finish the step.";
```

2. Add to `FlowHooks`:

```ts
  /** keeps a flow on disk; called on every change with the live objects, so
   *  it must serialize at once */
  save?: (rec: FlowRecord) => void;
  /** drops a flow's record */
  forget?: (id: string) => void;
```

3. Change `stepSpec`'s signature and task line:

```ts
export function stepSpec(
  wf: Workflow,
  index: number,
  summaries: { name: string; summary: string }[],
  retryReason?: string,
  restarted = false,
): ActionSpec {
```

and

```ts
    task: [restarted ? RESTART_NOTE : "", earlier, retry, step.body].filter(Boolean).join("\n\n"),
```

4. Add a field `private saving = true;` to `Flows`, and replace `emit()` with:

```ts
  private emit(live: LiveFlow): void {
    this.hooks.onChange(live.flow);
    if (this.saving) this.hooks.save?.(this.record(live));
  }

  private record(live: LiveFlow): FlowRecord {
    return { v: 1, flow: live.flow, workflow: live.workflow, before: live.before, savedAt: this.now() };
  }

  /** Stops saving: the server calls it before stopping every flow on its way
   *  down, so the records keep what was running for the next server. */
  detach(): void {
    this.saving = false;
  }
```

5. In `dismiss()`, after `this.live.delete(id);`, add `this.hooks.forget?.(id);`. In `prune()`, after `this.live.delete(oldest.flow.id);`, add `this.hooks.forget?.(oldest.flow.id);`.

6. In `runStep`, after the `this.clock(live, true);` line from Task 5, add:

```ts
    const restarted = flow.restarted === true;
    delete flow.restarted;
```

and pass it: `stepSpec(workflow, flow.current, this.summaries(live), flow.retryReason, restarted)`.

7. Add `restore` after `dismiss()`:

```ts
  /** Takes back the flows a stopped server left on disk. A gated or finished
   *  flow comes back as it was; one caught mid-step reruns that step, its run
   *  having gone with the old process. Fleets are not kept, so a fleet id is
   *  dropped. `resolve` finds a repo by id in the current scan. */
  restore(records: FlowRecord[], resolve: (repoId: string) => Repo | undefined, agentFor: (repo: Repo) => StepAgent): void {
    for (const rec of records) {
      const flow = rec.flow;
      if (this.live.has(flow.id)) continue;
      delete flow.fleetId;
      const repo = resolve(flow.repoId);
      const live: LiveFlow = {
        flow,
        repo: repo ?? { id: flow.repoId, name: flow.repoId, path: "", group: "", source: "", status: null },
        workflow: rec.workflow,
        agent: repo ? agentFor(repo) : () => DEFAULT_AGENT,
        before: rec.before,
      };
      this.live.set(flow.id, live);
      if (!isFlowActive(flow)) {
        this.emit(live);
        continue;
      }
      if (!repo) {
        const step = flow.steps[flow.current];
        if (step) {
          step.status = "failed";
          step.reason = "the repo is not in the scan any more";
        }
        this.end(live, "failed", "the repo is not in the scan any more");
        continue;
      }
      if (flow.status === "gated") {
        this.emit(live);
        continue;
      }
      this.resetStep(flow.steps[flow.current]);
      flow.restarted = true;
      flow.status = "working";
      void this.runStep(live);
    }
    this.prune();
  }
```

- [ ] **Step 5: Run the tests**

Run: `bun test src/core/flow.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/core/types.ts src/core/flow.ts src/core/flow.test.ts
git commit -m "feat(flow): flows save a record and come back from one

Claude-Session: https://claude.ai/code/session_01DMvREFYoLgpGe2oQNWq1Xu"
```

---

### Task 7: The record files and the evidence reader

**Files:**
- Create: `src/core/flowstore.ts`
- Create: `src/core/evidence.ts`
- Test: `src/core/flowstore.test.ts`, `src/core/evidence.test.ts`

**Interfaces:**
- Consumes: `FlowRecord` (Task 6); `EVIDENCE_EACH` (Task 2); `EvidenceFile` (Task 2); `configDir()` from `src/core/store.ts`.
- Produces: `flowsDir(): string`; `parseFlowRecord(text: string): FlowRecord | null`; `loadFlowRecords(dir?: string): Promise<FlowRecord[]>`; `class FlowFiles { constructor(dir?: string); save(rec: FlowRecord): void; forget(id: string): void; idle(): Promise<void> }`; `readEvidence(repoPath: string, paths: string[]): Promise<EvidenceFile[]>`.

- [ ] **Step 1: Write the failing tests**

Create `src/core/flowstore.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FlowFiles, loadFlowRecords, parseFlowRecord } from "./flowstore";
import { parseWorkflow } from "./workflow";
import type { FlowRecord } from "./flow";

const e = parseWorkflow(`---\nblurb: b\n---\n\n## One\n\nx\n`, { name: "t", source: "bundled", file: "/t.md" });
if (!e.ok) throw new Error(e.error);
const workflow = e.workflow;

const rec = (id: string, status: "gated" | "done" = "gated"): FlowRecord => ({
  v: 1,
  before: "",
  savedAt: 0,
  workflow,
  flow: { id, repoId: "app", workflow: "t", verb: "t", note: "", status, steps: [{ name: "One", status: "gated" }], current: 0, startedAt: 0 },
});

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "canopy-flows-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("parseFlowRecord", () => {
  test("takes a well-formed record", () => {
    expect(parseFlowRecord(JSON.stringify(rec("abcdef01")))?.flow.id).toBe("abcdef01");
  });
  test.each<[string, string]>([
    ["truncated JSON", JSON.stringify(rec("abcdef01")).slice(0, 40)],
    ["another version", JSON.stringify({ ...rec("abcdef01"), v: 2 })],
    ["an id that is no flow id", JSON.stringify(rec("../../x"))],
    ["steps that do not match the workflow", JSON.stringify({ ...rec("abcdef01"), flow: { ...rec("abcdef01").flow, steps: [] } })],
    ["a current step out of range", JSON.stringify({ ...rec("abcdef01"), flow: { ...rec("abcdef01").flow, current: 3 } })],
  ])("refuses %s", (_what, text) => {
    expect(parseFlowRecord(text)).toBeNull();
  });
});

describe("FlowFiles", () => {
  test("keeps the last save, private to the user, and forgets on request", async () => {
    const files = new FlowFiles(dir);
    const a = rec("abcdef01");
    files.save(a);
    files.save({ ...a, flow: { ...a.flow, note: "second" } });
    await files.idle();
    const path = join(dir, "abcdef01.json");
    expect(parseFlowRecord(await readFile(path, "utf8"))?.flow.note).toBe("second");
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    files.forget("abcdef01");
    await files.idle();
    expect(await Bun.file(path).exists()).toBe(false);
  });
});

describe("loadFlowRecords", () => {
  test("reads every good record and skips a broken one or one under the wrong name", async () => {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "abcdef01.json"), JSON.stringify(rec("abcdef01")));
    await writeFile(join(dir, "abcdef02.json"), JSON.stringify(rec("abcdef02", "done")));
    await writeFile(join(dir, "abcdef03.json"), "{\"v\":1,\"flow\":");
    await writeFile(join(dir, "abcdef04.json"), JSON.stringify(rec("abcdef05")));
    await writeFile(join(dir, "notes.txt"), "not a record");
    const ids = (await loadFlowRecords(dir)).map((r) => r.flow.id);
    expect(ids).toEqual(["abcdef01", "abcdef02"]);
  });
  test("a missing folder is no records", async () => {
    expect(await loadFlowRecords(join(dir, "nope"))).toEqual([]);
  });
});
```

Create `src/core/evidence.test.ts`:

```ts
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readEvidence } from "./evidence";
import { EVIDENCE_EACH } from "./verdict";

let scratch: string;
let repoDir: string;
beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "canopy-evidence-"));
  repoDir = join(scratch, "repo");
  await mkdir(join(repoDir, ".canopy"), { recursive: true });
  await writeFile(join(repoDir, ".canopy/intent.md"), "be useful");
  await writeFile(join(repoDir, "big.md"), "y".repeat(EVIDENCE_EACH * 5));
  await writeFile(join(scratch, "secret.txt"), "outside");
  await symlink(join(scratch, "secret.txt"), join(repoDir, "link.md"));
});
afterAll(async () => {
  await rm(scratch, { recursive: true, force: true });
});

test("reads files in the repo, only the head of a big one, and nothing outside it", async () => {
  const files = await readEvidence(repoDir, [".canopy/intent.md", "big.md", "link.md", "missing.md", "../secret.txt"]);
  expect(files[0]).toEqual({ path: ".canopy/intent.md", text: "be useful" });
  expect(files[1]?.text?.length).toBe(EVIDENCE_EACH * 2);
  expect(files[2]).toEqual({ path: "link.md", text: null });
  expect(files[3]).toEqual({ path: "missing.md", text: null });
  expect(files[4]).toEqual({ path: "../secret.txt", text: null });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `bun test src/core/flowstore.test.ts src/core/evidence.test.ts`
Expected: FAIL, the modules do not exist.

- [ ] **Step 3: Write `src/core/flowstore.ts`**

```ts
/** Flows on disk: one JSON record per flow under the config dir, written
 *  through a temp file and a rename so a crash never leaves half a record
 *  under the real name. Bun/node only; the server is the one caller. */

import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { FlowRecord } from "./flow";
import { configDir } from "./store";

export const flowsDir = (): string => join(configDir(), "flows");

/** a flow id: the first group of a UUID */
const ID = /^[0-9a-f]{8}$/;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** A record this canopy can run, or null. Checks the shape the engine relies
 *  on (an id fit for a filename, one flow step per workflow step, a current
 *  step in range); the rest is the engine's own output. */
export function parseFlowRecord(text: string): FlowRecord | null {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isObject(v) || v["v"] !== 1 || typeof v["before"] !== "string") return null;
  const flow = v["flow"];
  const workflow = v["workflow"];
  if (!isObject(flow) || !isObject(workflow)) return null;
  const id = flow["id"];
  const steps = flow["steps"];
  const wsteps = workflow["steps"];
  const current = flow["current"];
  if (typeof id !== "string" || !ID.test(id) || typeof flow["repoId"] !== "string") return null;
  if (!Array.isArray(steps) || !Array.isArray(wsteps) || steps.length !== wsteps.length) return null;
  if (typeof current !== "number" || !Number.isInteger(current) || current < 0 || current >= steps.length) return null;
  // the checks above cover every field the engine reads before trusting it
  return v as unknown as FlowRecord;
}

export async function loadFlowRecords(dir = flowsDir()): Promise<FlowRecord[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const out: FlowRecord[] = [];
  for (const name of names.filter((n) => n.endsWith(".json")).sort()) {
    const text = await readFile(join(dir, name), "utf8").catch(() => null);
    const rec = text === null ? null : parseFlowRecord(text);
    if (rec && name === `${rec.flow.id}.json`) out.push(rec);
    else console.error(`flows: skipping ${name}, not a flow record this canopy can read`);
  }
  return out;
}

/** Writes records as the engine saves them. Each save is serialized at once
 *  and only the newest per flow is written; one write per flow at a time. */
export class FlowFiles {
  /** the next text to write per id; "" means delete */
  private pending = new Map<string, string>();
  private writing = new Set<string>();

  constructor(private dir = flowsDir()) {}

  save(rec: FlowRecord): void {
    this.pending.set(rec.flow.id, JSON.stringify(rec));
    void this.drain(rec.flow.id);
  }

  forget(id: string): void {
    this.pending.set(id, "");
    void this.drain(id);
  }

  /** resolves once every write queued so far is done */
  async idle(): Promise<void> {
    while (this.writing.size > 0) await new Promise((r) => setTimeout(r, 5));
  }

  private async drain(id: string): Promise<void> {
    if (this.writing.has(id)) return;
    this.writing.add(id);
    try {
      while (this.pending.has(id)) {
        const text = this.pending.get(id) ?? "";
        this.pending.delete(id);
        const path = join(this.dir, `${id}.json`);
        if (text === "") {
          await rm(path, { force: true });
          continue;
        }
        await mkdir(this.dir, { recursive: true, mode: 0o700 });
        const tmp = `${path}.tmp`;
        await writeFile(tmp, text, { mode: 0o600 });
        await rename(tmp, path);
      }
    } catch (err) {
      console.error(`flows: could not save ${id}: ${String(err instanceof Error ? err.message : err)}`);
    } finally {
      this.writing.delete(id);
    }
  }
}
```

- [ ] **Step 4: Write `src/core/evidence.ts`**

```ts
/** Reads a judge step's evidence out of a local repo. Each path is resolved
 *  through symlinks and refused when that lands outside the repo, and only
 *  the head of a big file is read, since the judge reads a clipped part
 *  anyway. Bun-only. */

import { realpath } from "node:fs/promises";
import { join, sep } from "node:path";
import type { EvidenceFile } from "./types";
import { EVIDENCE_EACH } from "./verdict";

export async function readEvidence(repoPath: string, paths: string[]): Promise<EvidenceFile[]> {
  const root = await realpath(repoPath);
  return Promise.all(
    paths.map(async (path): Promise<EvidenceFile> => {
      try {
        const full = await realpath(join(root, path));
        if (!full.startsWith(root + sep)) return { path, text: null };
        return { path, text: await Bun.file(full).slice(0, EVIDENCE_EACH * 2).text() };
      } catch {
        return { path, text: null };
      }
    }),
  );
}
```

- [ ] **Step 5: Run the tests**

Run: `bun test src/core/flowstore.test.ts src/core/evidence.test.ts`
Expected: PASS. If the repo's tmp dir is itself under a symlink (macOS `/var` to `/private/var`), the `realpath` on `root` is what keeps the containment check right; do not drop it.

- [ ] **Step 6: Commit**

```bash
git add src/core/flowstore.ts src/core/flowstore.test.ts src/core/evidence.ts src/core/evidence.test.ts
git commit -m "feat(flow): flow records on disk and the evidence reader

Claude-Session: https://claude.ai/code/session_01DMvREFYoLgpGe2oQNWq1Xu"
```

---

### Task 8: The server keeps flows across a restart

**Files:**
- Modify: `src/server/index.ts` (imports near line 47; `new Flows(` near line 2725; after the first scan near line 2858; `stop()` near line 3201)
- Test: `src/server/flows.test.ts` (new)

**Interfaces:**
- Consumes: `FlowFiles`, `loadFlowRecords` (Task 7); `readEvidence` (Task 7); `jevJudge` (Task 2); `Flows.restore`, `Flows.detach` (Task 6); `stepAgentFor` (existing, `src/server/index.ts:633`).
- Produces: flows restored at startup; records written on every change and dropped on dismiss.

- [ ] **Step 1: Write the failing test**

Create `src/server/flows.test.ts`:

```ts
/**
 * Flows outlive the server: a gated flow on disk comes back gated, one whose
 * repo left the scan comes back failed and its record says so, dismissing
 * drops the record, and stopping the server leaves a gated record gated.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FlowRecord } from "../core/flow";
import { killServer, tmuxBase } from "../core/tmux";
import type { Flow } from "../core/types";
import { parseWorkflow } from "../core/workflow";
import { startServer } from "./index";

const e = parseWorkflow(`---\nname: two\nverb: do two\nblurb: b\n---\n\n## First\ngate: ask\n\nOne.\n\n## Second\n\nTwo.\n`, {
  name: "two",
  source: "bundled",
  file: "/two.md",
});
if (!e.ok) throw new Error(e.error);
const TWO = e.workflow;

const rec = (id: string, repoId: string, status: "gated" | "working"): FlowRecord => ({
  v: 1,
  before: "",
  savedAt: 0,
  workflow: TWO,
  flow: {
    id,
    repoId,
    workflow: "two",
    verb: "do two",
    note: "",
    status,
    steps: [
      status === "gated" ? { name: "First", status: "gated", reason: "this step asks before the next one starts" } : { name: "First", status: "running" },
      { name: "Second", status: "pending" },
    ],
    current: 0,
    startedAt: 0,
  },
});

let scratch: string;
let previous: string | undefined;
let server: { port: number; stop: () => void } | null = null;
let flowsDir: string;

const api = (path: string, init?: RequestInit) => fetch(`http://127.0.0.1:${server?.port ?? 0}${path}`, init);
const onDisk = async (id: string): Promise<FlowRecord | null> => {
  const text = await readFile(join(flowsDir, `${id}.json`), "utf8").catch(() => null);
  return text === null ? null : (JSON.parse(text) as FlowRecord);
};
async function until(pred: () => Promise<boolean>, what: string, ms = 5000): Promise<void> {
  const start = Date.now();
  while (!(await pred())) {
    if (Date.now() - start > ms) throw new Error(`gave up waiting for ${what}`);
    await Bun.sleep(25);
  }
}

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "canopy-flows-srv-"));
  previous = process.env["CANOPY_CONFIG_DIR"];
  process.env["CANOPY_CONFIG_DIR"] = join(scratch, "config");
  flowsDir = join(scratch, "config", "flows");
  await mkdir(flowsDir, { recursive: true });
  for (const r of [rec("abcdef01", "app", "gated"), rec("abcdef02", "gone", "working"), rec("abcdef03", "app", "gated")]) {
    await writeFile(join(flowsDir, `${r.flow.id}.json`), JSON.stringify(r));
  }
  const root = join(scratch, "root");
  await Bun.$`mkdir -p ${join(root, "app")} && git -C ${join(root, "app")} init -q`.quiet();
  server = await startServer({ root, port: 0, harnesses: ["claude"] });
});

afterAll(async () => {
  server?.stop();
  const base = tmuxBase();
  if (base) await killServer(base);
  if (previous === undefined) delete process.env["CANOPY_CONFIG_DIR"];
  else process.env["CANOPY_CONFIG_DIR"] = previous;
  await rm(scratch, { recursive: true, force: true });
});

test("a gated flow comes back gated; one whose repo is gone comes back failed, on disk too", async () => {
  const flows = (await (await api("/api/flows")).json()) as Flow[];
  expect(flows.find((f) => f.id === "abcdef01")?.status).toBe("gated");
  const gone = flows.find((f) => f.id === "abcdef02");
  expect(gone?.status).toBe("failed");
  expect(gone?.error).toBe("the repo is not in the scan any more");
  await until(async () => (await onDisk("abcdef02"))?.flow.status === "failed", "the failed record");
});

test("stopping and dismissing a flow drops its record", async () => {
  const res = await api("/api/flows/resume", { method: "POST", body: JSON.stringify({ id: "abcdef01", choice: "stop" }) });
  expect(((await res.json()) as Flow).status).toBe("stopped");
  expect((await api("/api/flows?id=abcdef01", { method: "DELETE" })).status).toBe(200);
  await until(async () => (await onDisk("abcdef01")) === null, "the record to go");
});

test("stopping the server leaves a gated record gated", async () => {
  server?.stop();
  server = null;
  await Bun.sleep(100);
  expect((await onDisk("abcdef03"))?.flow.status).toBe("gated");
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `SHELL=/bin/bash bun test src/server/flows.test.ts`
Expected: FAIL; `/api/flows` is empty.

- [ ] **Step 3: Wire it in**

In `src/server/index.ts`:

1. Change `import { hasGatewayKey, jev } from "../core/jev";` to `import { hasGatewayKey, jev, jevJudge } from "../core/jev";` and add:

```ts
import { readEvidence } from "../core/evidence";
import { FlowFiles, loadFlowRecords } from "../core/flowstore";
```

2. Just above `const flows = new Flows(runner, {`, add `const flowFiles = new FlowFiles();`. Inside that hooks object, after `evaluator: hasGatewayKey() ? jev : null,`, add:

```ts
    judge: hasGatewayKey() ? jevJudge : null,
    evidence: (repo, paths) => readEvidence(repo.path, paths),
    save: (rec) => flowFiles.save(rec),
    forget: (id) => flowFiles.forget(id),
```

3. After `if (launch?.src.error) throw new Error(launch.src.error);`, add:

```ts
  // The flows the last server left, now that the scan can name their repos.
  state.flows.restore(
    await loadFlowRecords(),
    (id) => state.result.repos.find((r) => r.id === id),
    (repo) => (profile) => stepAgentFor(cfg, repo.path, profile),
  );
```

4. In the returned `stop()`, put `state.flows.detach();` on the line before `state.flows.stopAll();`.

- [ ] **Step 4: Run it**

Run: `SHELL=/bin/bash bun test src/server/flows.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the whole server suite**

Run: `SHELL=/bin/bash bun test src/server`
Expected: PASS. Every other server test now writes records into its own scratch config dir; none should mind.

- [ ] **Step 6: Commit**

```bash
git add src/server/index.ts src/server/flows.test.ts
git commit -m "feat(server): flows come back after a restart, judge gates read evidence

Claude-Session: https://claude.ai/code/session_01DMvREFYoLgpGe2oQNWq1Xu"
```

---

### Task 9: The flow sheet shows the judge, the budget and the rewinds

**Files:**
- Modify: `ui/src/flows.ts`
- Modify: `ui/src/components/FlowSheet.tsx` (line 94 and the `Gate` component near line 155)
- Modify: `ui/src/styles.css` (after `.gate-summary`, line 4338)
- Test: `ui/src/flows.test.ts`

**Interfaces:**
- Consumes: `Flow.budget`, `Flow.spent`, `Flow.rewinds`, `Flow.parkedFor`, `FlowStep.judgment` (Tasks 2, 4, 5).
- Produces: `budgetWord(flow: Flow): string | null`; `rewindLines(flow: Flow): string[]`.

- [ ] **Step 1: Write the failing tests**

Append to `ui/src/flows.test.ts` (add `budgetWord, rewindLines` to the `./flows` import):

```ts
describe("budgetWord", () => {
  test("runs and hours spent of the budget, or null without one", () => {
    expect(budgetWord(flow())).toBeNull();
    expect(budgetWord(flow({ budget: { runs: 30, hours: 6 }, spent: { runs: 4, workMs: 4_320_000 } }))).toBe("4 of 30 runs, 1.2h of 6h");
    expect(budgetWord(flow({ budget: { runs: 2, hours: 0.5 } }))).toBe("0 of 2 runs, 0h of 0.5h");
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
```

- [ ] **Step 2: Run them to see them fail**

Run: `bun test ui/src/flows.test.ts`
Expected: FAIL on the missing exports.

- [ ] **Step 3: Write the words**

Append to `ui/src/flows.ts`:

```ts
/** "4 of 30 runs, 1.2h of 6h" for a flow with a budget, null without one. */
export function budgetWord(flow: Flow): string | null {
  if (!flow.budget) return null;
  const s = flow.spent ?? { runs: 0, workMs: 0 };
  const hours = Math.round(s.workMs / 360_000) / 10;
  return `${s.runs} of ${flow.budget.runs} runs, ${hours}h of ${flow.budget.hours}h`;
}

/** One line per rewind, oldest first. */
export const rewindLines = (flow: Flow): string[] =>
  (flow.rewinds ?? []).map((r) =>
    r.from === r.to ? `${r.from} tried again: ${r.reason}` : `${r.from} sent it back to ${r.to}: ${r.reason}`,
  );
```

- [ ] **Step 4: Run them**

Run: `bun test ui/src/flows.test.ts`
Expected: PASS.

- [ ] **Step 5: Show them in the sheet**

In `ui/src/components/FlowSheet.tsx`:

1. Add `Judgment` to the type import from `../../../src/core/types` (next to `Verdict`), and `budgetWord, rewindLines` to the import from `../flows`.
2. Change line 94's condition to `w.steps.some((s) => s.gate === "verdict" || s.gate === "judge") && !verdictReady` and its text to `"No gateway key on the server, so verdict and judge gates will ask you instead."`.
3. Add below `VerdictBars`:

```tsx
function JudgeBars({ judgment }: { judgment: Judgment }) {
  const fit = judgment.answers.fit;
  const rows: [string, number][] = [
    ["meets", fit.probabilities?.["meets"] ?? (fit.choice === "meets" ? 1 : 0)],
    ["enough to go on", judgment.answers.evidence.probability],
    ["breaks a rule", judgment.answers.rules.probability],
  ];
  return (
    <dl className="verdict-bars">
      {rows.map(([label, p]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd><span className="bar" style={{ width: `${Math.round(p * 100)}%` }} /><span className="pct">{Math.round(p * 100)}%</span></dd>
        </div>
      ))}
    </dl>
  );
}
```

4. In `Gate`, after `const last = …`, add:

```tsx
  const budget = budgetWord(flow);
  const rewinds = rewindLines(flow);
  const overBudget = flow.parkedFor === "budget";
```

then after `{step.verdict && <VerdictBars verdict={step.verdict} />}` add:

```tsx
      {step.judgment && <JudgeBars judgment={step.judgment} />}
      {budget && <p className="gate-budget">{budget}</p>}
      {rewinds.length > 0 && (
        <ul className="gate-rewinds">
          {rewinds.map((line, i) => <li key={i}>{line}</li>)}
        </ul>
      )}
```

and change the continue button's label expression to:

```tsx
          {overBudget ? "allow one more step" : last ? "accept and finish" : `continue to ${flow.steps[flow.current + 1]?.name ?? "the next step"}`}
```

and hide the retry button on a budget park (both choices do the same there): wrap it as `{!overBudget && (<button …>retry this step</button>)}`.

5. In `ui/src/styles.css`, after the `.gate-summary` rule, add:

```css
.gate-budget, .gate-rewinds { font-size: 12px; color: var(--ink-dim); }
.gate-budget { margin: 4px 0; }
.gate-rewinds { margin: 4px 0; padding-left: 16px; }
```

- [ ] **Step 6: Typecheck and lint**

Run: `bun run typecheck && bun run lint`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add ui/src/flows.ts ui/src/flows.test.ts ui/src/components/FlowSheet.tsx ui/src/styles.css
git commit -m "feat(ui): the flow sheet shows the judge, the budget and the rewinds

Claude-Session: https://claude.ai/code/session_01DMvREFYoLgpGe2oQNWq1Xu"
```

---

### Task 10: Docs and the full gates

**Files:**
- Modify: `CLAUDE.md` (the `workflow`, `flow` and `verdict` parts of the `src/core/` bullet; the workflows-and-flows part of the `src/server/` bullet)

**Interfaces:**
- Consumes: everything above.

- [ ] **Step 1: Update CLAUDE.md**

In the `src/core/` bullet:

1. After the `workflow (browser-safe, pure and tested: …)` sentence that ends with `checked against PROFILE_RE)`, add: `; a step's key block also takes retries (0 to 10), back (this step's name or an earlier one's, where a retry rewinds to), and evidence (repo-relative files, only with gate: judge), and the frontmatter takes budget: <runs> runs, <hours>h`.
2. In the `flow (class Flows: …)` part, after `continue, ask, or verdict through an injected evaluator hook`, add: `, or judge through the judge hook with the step's evidence read by the evidence hook (evidence.ts, realpath-contained, the head of each file)`; after `resume() continues, retries or stops a gated flow`, add: `; a check or gate that says no rewinds to the step's back while it has retries left (tries, rewinds and retryReason ride on the Flow), a judge's rejection and a missing or failing evaluator never retry; a budget parks before the run that would pass it (parkedFor, grace; working time stops while a run waits on a prompt or the flow is parked); every change is saved through the save hook as a FlowRecord (the flow, a snapshot of its workflow, the status fingerprint) by flowstore.ts's FlowFiles under $CANOPY_CONFIG_DIR/flows/<id>.json, restore() takes them back after the first scan (gated stays gated, a flow caught mid-step reruns the step with RESTART_NOTE, one whose repo left the scan fails), and detach() stops saving before the server stops every flow`.
3. In the `verdict (browser-safe, pure and tested: …)` part, add after `verdictState builds the text …`: `; JUDGE_QUESTIONS (fit meets/partly/misses, evidence, rules), decideJudge (go at meets 0.7, evidence 0.5, rules under 0.3; misses at 0.7 is a rejection) and judgeState (the step's task as the criteria, evidence clipped to EVIDENCE_EACH and EVIDENCE_TOTAL) are the judge gate's; jev.ts's jevJudge asks them`.

In the `src/server/` bullet, after `GET /api/flows lists every flow`, add: `(including the ones restored from disk at startup)`.

- [ ] **Step 2: Run every gate**

Run: `bun run typecheck && bun run lint && SHELL=/bin/bash bun test && bun run build`
Expected: all four PASS. A failure is fixed in the task that owns the code, not papered over here.

- [ ] **Step 3: Check the build is fresh**

Run: `~/.claude/skills/verify-build/clean-rebuild.sh check`
Expected: exit 0.

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: flows persist, retry, budget and judge

Claude-Session: https://claude.ai/code/session_01DMvREFYoLgpGe2oQNWq1Xu"
```

---

## What comes after this plan

Phases 2 to 5 of the spec each get their own plan, written once this one has landed, since each builds on what this one leaves: the sprout record, intake and clarify (phase 2), scout, build-new and the Vercel deploy (phase 3), renovate and extend (phase 4), the retro and the improvements list (phase 5). Deploying this phase to the mini is the `redeploy` skill's job and is not part of this plan.
