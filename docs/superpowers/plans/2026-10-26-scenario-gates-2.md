# Scenario gates, plan 2: judge scenarios, the hold and the score (FR-032)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Status:** plan 2 implemented and independently reviewed locally 2026-10-27 on `main`. Plan 3 remains open. Written on main at 1ac8fe7.

**Goal:** a judge scenario runs in the queue's pass after the command ones: its
line's output, its evidence files and its story go to Jev, which says yes,
partly or no; the branch gets a satisfaction score and lands at `minimum`; a
judge that cannot answer holds the entry for Eric's "land anyway"; the agent
never sees the story.

**Architecture:** the questions and the decision are pure, in `core/verdict.ts`
beside the flows' judge, and the evaluator is `jevScenario` in `core/jev.ts`
beside `jevJudge`. `runScenarioSet` in `server/scenarios.ts` runs judge
scenarios after every command scenario passed, through a `judge` dep the tests
stand in for. The turn in `server/landing.ts` holds an unjudged entry in a new
`judge` state that `retry()` never requeues, sends a branch under `minimum` back
as `red` with a `satisfaction` gate, and takes `land` with `skipJudge` as "land
anyway". The sheet, the landing row, the inbox and the CLI carry the hold and
its words. Plan 3 brings the PR watch's pre-merge pass and the repo panel's
scenarios list; nothing here touches `server/prs.ts`.

**Tech Stack:** Bun, TypeScript strict, React 19, bun:test. No new dependencies:
Jev is reached through `ai` and `@ai-sdk/gateway` as the flows' judge is.

**Spec:** `docs/superpowers/specs/2026-10-25-scenario-gates-design.md`, the
"Plans" list's item 2. The index is
`docs/superpowers/specs/2026-10-25-software-factory-borrowings-design.md`.
Plan 1 is `docs/superpowers/plans/2026-10-26-scenario-gates-1.md`; this plan
starts where it ends and uses its names.

## Global constraints

- `SCENARIO_QUESTIONS` in `core/verdict.ts`, beside `JUDGE_QUESTIONS`: `satisfied` (choice): does what was observed satisfy the story as a user would read it? `yes`, `partly`, `no`. `evidence` (boolean): is the output and the files enough to say?
- `SCENARIO_THRESHOLDS`: `yes` at 0.7, evidence at 0.35.
- `scenarioState(story, output, files)` builds the text the way `judgeState` does, with the story first and the output fenced between `<<<` and `>>>` as data.
- A judge scenario's satisfaction is `P(yes)`; a command scenario's is 1 or 0. The branch's score is the mean. It lands when the score is at least `minimum` and no command scenario is red. Passing every per-scenario threshold does not bypass `minimum`.
- `.canopy/scenarios.json`: `judge` is `jev` or `off`; `off` parks every judge scenario as `ask`. `minimum` is the satisfaction a branch needs to land, 0 to 1, default 1. Plan 1's `parseScenariosFile` and `DEFAULT_SETTINGS` already hold both; this plan reads them.
- A judge that cannot answer (no key, `judge: off`, three failed attempts) holds the entry with "scenario <name> needs a judge". Command scenarios still ran and still count. Eric lands it by hand ("land anyway"), which is a `land` with `skipJudge: true` and is written on the entry.
- Below `minimum`, the entry is sent back as `red` with `gate: "satisfaction 0.62 < 1"` and the names of the scenarios that said `partly` or `no`, with their outputs.
- The scenario's own text never reaches the run; only the judge reads it. The hold's reason, the red's output, `fixPrompt`, the `landing` event and the record carry a scenario's name, the judge's words and the output tail, never its body.
- The judge is Jev through the Vercel AI Gateway, like the flows' judge: `hasGatewayKey()` in `core/jev.ts` says whether there is one (`AI_GATEWAY_API_KEY`); three attempts of 6 s each, as `withRetries` has them.
- Plan 1's constraints stand: `core/` files the UI imports stay browser-safe, red output is tailed to `TAIL_CHARS`, no `CANOPY_` name in a run line, plain words, no em dashes, sentence case headings, and all four gates pass before a task is done: `bun run typecheck`, `bun run lint`, `bun test`, `bun run build`.

## Review focus

Inputs the spec implies and no section of it names. Each has a test in the task that owns the code.

1. A judge scenario whose `run` line exits non-zero: not a red. The judge reads the output, so a crashed line reads as `no` or as not enough to go on, never as a silent pass (Task 3).
2. Jev answering a choice with no `probabilities`: `P(yes)` is 1 for `yes` and 0 otherwise, so the thresholds and the score always have a number (Task 1).
3. "land anyway" on an entry that is not held for a judge, whether queued, red, landed or unknown: refused, never a fresh land with the judge skipped (Task 2 for the pure function, Task 4 for the route).
4. The story reaching anywhere but the judge: the hold's reason, the red's output, the fix prompt, the `landing` event and the record carry the name, the judge's words and the output tail only (Task 4).
5. A restart while an entry is held: `adopt` reads it back held, and neither `restartWorking` nor `retry()` requeues it (Task 4).

---

## File structure

- Modify `src/core/types.ts`: `ScenarioSatisfied`, `ScenarioAnswers`, `ScenarioJudgment`; `LandState` gains `judge`; `LandEntry.skipJudge`; `ScenarioResult.why` and `.unjudged`; `ScenarioRun.skipped`.
- Modify `src/core/verdict.ts` and `src/core/verdict.test.ts`: `SCENARIO_QUESTIONS`, `SCENARIO_THRESHOLDS`, `scenarioState`, `decideScenario`, `evidenceParts` shared with `judgeState`.
- Modify `src/core/jev.ts` and `src/core/jev.test.ts`: `ScenarioEvaluator`, `jevScenario`.
- Modify `src/core/landing.ts` and `src/core/landing.test.ts`: the `judge` state, the `unjudged` event, `landAnyway`, `SCORE_GATE`, `scoreGate`, `scoreOutput`, `landWord`, `fixPrompt`.
- Modify `src/server/scenarios.ts` and `src/server/scenarios.test.ts` (both from plan 1): `ScenarioJudge`, `NO_JUDGE_KEY`, `JUDGE_OFF`, `ScenarioPass.judge`, `.evidence`, `.skipJudge`, the judge loop, `ScenarioDeps.judge`.
- Modify `src/server/landing.ts` and `src/server/landing.test.ts`: `LandingDeps.judge` and `.evidence`, the hold and the score in `turn`, `land(id, approve, skipJudge)`, `drop` on a held entry, the route's `skipJudge`.
- Modify `src/server/index.ts`: the two `judge` deps.
- Modify `src/cli/land.ts`, `src/cli/land.test.ts`, `src/cli/scenarios.ts` and `src/cli/scenarios.test.ts` (from plan 1), `README.md`.
- Modify `ui/src/api.ts`, `ui/src/store.ts`, `ui/src/landing.ts`, `ui/src/landing.test.ts`, `ui/src/inbox.ts`, `ui/src/inbox.test.ts`, `ui/src/components/Landing.tsx`, `ui/src/components/RunSheet.tsx`, `ui/src/components/Inbox.tsx`, `ui/src/styles.css`.
- Modify `docs/architecture.md`, `README.md`, `FEATURES.md`, `docs/superpowers/plans/README.md`.

---

### Task 1: the judge's questions and the evaluator

**Files:**
- Modify: `src/core/types.ts:1952` (after `JudgeFit`), `src/core/verdict.ts:67` (`JUDGE_QUESTIONS`) and `:138` (`judgeState`), `src/core/verdict.test.ts`, `src/core/jev.ts:74` (after `jevJudge`), `src/core/jev.test.ts`

**Interfaces:**
- Consumes: `EvidenceFile` from `core/types.ts`; `EVIDENCE_EACH`, `EVIDENCE_TOTAL`, `clipMiddle` in `verdict.ts`; `withRetries`, `gatewayApiKey`, `JEV_MODEL` and `experimental_evaluate` as `jevJudge` uses them in `jev.ts`.
- Produces in `src/core/types.ts`:

```ts
export type ScenarioSatisfied = "yes" | "partly" | "no";
/** the judge's answers to SCENARIO_QUESTIONS for one judge scenario */
export interface ScenarioAnswers {
  satisfied: { choice: ScenarioSatisfied; probabilities?: Record<string, number> };
  evidence: { probability: number };
}
/** what the judge said about one judge scenario */
export interface ScenarioJudgment {
  answers: ScenarioAnswers;
  /** P(yes): the scenario's satisfaction */
  p: number;
  /** at the thresholds: yes at 0.7 with evidence at 0.35 */
  ok: boolean;
  /** why not, one line; null when ok */
  reason: string | null;
}
```

- Produces in `src/core/verdict.ts`:

```ts
export const SCENARIO_QUESTIONS = {
  satisfied: {
    type: "choice",
    instructions: "Does what was observed satisfy the story as a user would read it?",
    criteria: {
      yes: "What was observed does what the story asks, as a user would read it",
      partly: "Some of the story is satisfied and some is missing, wrong, or unclear",
      no: "What was observed does not do what the story asks, or nothing useful was observed",
    },
  },
  evidence: {
    type: "boolean",
    instructions: "Is the output and the files enough to say?",
  },
} as const;
export const SCENARIO_THRESHOLDS = {
  /** yes needs at least this much probability */
  yes: 0.7,
  /** enough evidence needs at least this much; Jev's evidence answers run low, see JUDGE_THRESHOLDS */
  evidence: 0.35,
} as const;
/** The text the judge reads: the story first, the observed output fenced as
 *  data, then the evidence files as judgeState clips them. */
export function scenarioState(input: { story: string; output: string | null; files: EvidenceFile[] }): string;
export function decideScenario(answers: ScenarioAnswers): ScenarioJudgment;
/** the `File <path>:` parts judgeState builds, each clipped to EVIDENCE_EACH
 *  and all of them to EVIDENCE_TOTAL, with the left-out count; judgeState
 *  and scenarioState share it */
function evidenceParts(files: EvidenceFile[]): string[];
```

- Produces in `src/core/jev.ts`:

```ts
export type ScenarioEvaluator = (state: string) => Promise<ScenarioAnswers>;
/** The same classifier asked the scenario questions; throws on a choice
 *  outside yes, partly and no, as jevJudge does on an unknown fit. */
export const jevScenario: ScenarioEvaluator;
```

`scenarioState` is, for a story, an output and one file:

```
Story, as a user would read it:
<story, trimmed>

Observed output:
<<<
<output, trimmed, or (empty)>
>>>

File src/refund.ts:
<text>
```

With `output: null` the second part is one line, `Observed output: (no command ran)`. Parts join with a blank line, as `judgeState`'s do.

`decideScenario`: `p` is `answers.satisfied.probabilities?.["yes"]`, else 1 for a `yes` choice and 0 otherwise. Then, in order, each with the reason the test pins: evidence under `SCENARIO_THRESHOLDS.evidence` is "the judge says there is not enough to go on"; choice `no` is "the judge says what was observed does not satisfy the story"; choice `partly` is "the judge says what was observed only partly satisfies the story"; `p` under `SCENARIO_THRESHOLDS.yes` is "not sure what was observed satisfies the story"; else `ok` with `reason: null`. `p` is always `P(yes)`, whatever the choice, so a `partly` still carries its number to the score.

- [ ] **Step 1: Write the failing tests in `src/core/verdict.test.ts`**

After the `judgeState` describe, importing `decideScenario`, `scenarioState`, `SCENARIO_THRESHOLDS` and the `ScenarioAnswers` type:

```ts
const sat = (o: Partial<ScenarioAnswers> = {}): ScenarioAnswers => ({
  satisfied: { choice: "yes", probabilities: { yes: 0.9, partly: 0.07, no: 0.03 } },
  evidence: { probability: 0.8 },
  ...o,
});

describe("decideScenario", () => {
  test("yes with evidence is satisfied, and p is P(yes)", () => {
    expect(decideScenario(sat())).toMatchObject({ ok: true, p: 0.9, reason: null });
  });
  test("the thresholds: yes at 0.7, evidence at 0.35", () => {
    expect(SCENARIO_THRESHOLDS).toEqual({ yes: 0.7, evidence: 0.35 });
    expect(decideScenario(sat({ satisfied: { choice: "yes", probabilities: { yes: 0.7 } } }))).toMatchObject({ ok: true, p: 0.7 });
    expect(decideScenario(sat({ satisfied: { choice: "yes", probabilities: { yes: 0.69 } } }))).toMatchObject({ ok: false, p: 0.69, reason: "not sure what was observed satisfies the story" });
    expect(decideScenario(sat({ evidence: { probability: 0.35 } }))).toMatchObject({ ok: true });
    expect(decideScenario(sat({ evidence: { probability: 0.34 } }))).toMatchObject({ ok: false, p: 0.9, reason: "the judge says there is not enough to go on" });
  });
  test("partly and no keep their P(yes) for the score", () => {
    expect(decideScenario(sat({ satisfied: { choice: "partly", probabilities: { yes: 0.3, partly: 0.6, no: 0.1 } } }))).toMatchObject({ ok: false, p: 0.3, reason: "the judge says what was observed only partly satisfies the story" });
    expect(decideScenario(sat({ satisfied: { choice: "no", probabilities: { yes: 0.05, partly: 0.15, no: 0.8 } } }))).toMatchObject({ ok: false, p: 0.05, reason: "the judge says what was observed does not satisfy the story" });
  });
  test("no probabilities: P(yes) is 1 for yes and 0 otherwise", () => {
    expect(decideScenario(sat({ satisfied: { choice: "yes" } }))).toMatchObject({ ok: true, p: 1 });
    expect(decideScenario(sat({ satisfied: { choice: "partly" } })).p).toBe(0);
  });
});

describe("scenarioState", () => {
  test("the story first, the output fenced as data, then the files", () => {
    expect(scenarioState({ story: "A customer asks for a refund.\n", output: "refund 42 granted\n", files: [{ path: "src/refund.ts", text: "export {}" }, { path: "gone.ts", text: null }] })).toBe(
      "Story, as a user would read it:\nA customer asks for a refund.\n\nObserved output:\n<<<\nrefund 42 granted\n>>>\n\nFile src/refund.ts:\nexport {}\n\nFile gone.ts: (missing)",
    );
  });
  test("no run line, and an empty output", () => {
    expect(scenarioState({ story: "s", output: null, files: [] })).toBe("Story, as a user would read it:\ns\n\nObserved output: (no command ran)");
    expect(scenarioState({ story: "s", output: "  ", files: [] })).toBe("Story, as a user would read it:\ns\n\nObserved output:\n<<<\n(empty)\n>>>");
  });
  test("clips the files as judgeState does", () => {
    const big = "x".repeat(EVIDENCE_EACH + 100);
    expect(scenarioState({ story: "s", output: null, files: [{ path: "a", text: big }] })).toContain("[clipped: 100 characters]");
  });
});
```

- [ ] **Step 2: Write the failing live test in `src/core/jev.test.ts`**

Beside the `jev, live` describe, skipped the same way without a key:

```ts
describe("jevScenario, live", () => {
  test.skipIf(!hasGatewayKey())("a story the output satisfies", async () => {
    const answers = await jevScenario(
      scenarioState({
        story: "A customer asks for a refund on order 42. The reply names the order and says whether the refund is granted.",
        output: "Order 42: refund granted. The order shipped six days ago, inside the fourteen-day window.",
        files: [],
      }),
    );
    expect(["yes", "partly", "no"]).toContain(answers.satisfied.choice);
    expect(answers.evidence.probability).toBeGreaterThanOrEqual(0);
  }, 30_000);
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `bun test src/core/verdict.test.ts src/core/jev.test.ts`
Expected: FAIL, `decideScenario`, `scenarioState` and `jevScenario` are not exported.

- [ ] **Step 4: Add the types, the questions, the decision and the evaluator**

Pull `judgeState`'s file loop out as `evidenceParts` and call it from both; `judgeState`'s own tests must still pass unchanged. `jevScenario` follows `jevJudge` line for line with `SCENARIO_QUESTIONS`, an `isSatisfied` guard and the error `unexpected satisfied: <value>`.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `bun test src/core/verdict.test.ts src/core/jev.test.ts src/core/flow.test.ts && bun run typecheck`
Expected: PASS; the live test is skipped without a key and passes with one.

- [ ] **Step 6: Commit**

```bash
git add src/core/types.ts src/core/verdict.ts src/core/verdict.test.ts src/core/jev.ts src/core/jev.test.ts
git commit -m "feat(scenarios): the judge's questions, scenarioState, decideScenario and jevScenario (FR-032)"
```

---

### Task 2: the hold and the score in the queue's model

**Files:**
- Modify: `src/core/types.ts:1384` (`LandState`), `:1386` (`LandEntry`), the `ScenarioResult` and `ScenarioRun` plan 1 adds beside `LandingRun`; `src/core/landing.ts:22-25` (`inQueue`), `:28` (`LandEvent`), `:46` (`advance`), `:223` (`landWord`), `:257` (`fixPrompt`); `src/core/landing.test.ts`

**Interfaces:**
- Consumes: plan 1's `SCENARIO_GATE`, `scenarioOf`, the `scenarios` and `scenario-ok` events, `ScenarioResult`, `ScenarioRun`; the test file's `run`, `queued` and `entry` helpers.
- Produces in `src/core/types.ts`:

```ts
export type LandState = "queued" | "rebasing" | "setup" | "gate" | "scenarios" | "landing" | "landed" | "waiting" | "judge" | "conflict" | "red" | "moved";
```

with the comment on `judge`: "held: a judge scenario had no judge; it keeps its place until Eric's land anyway". `LandEntry` gains `/** Eric's "land anyway": the judge scenarios are left out of its pass */ skipJudge?: true`. `ScenarioResult` gains `/** a judge scenario under the thresholds: the judge's reason */ why?: string` and `/** a judge scenario the judge could not answer: why. It counts 0 and holds the entry */ unjudged?: string`, and `p`'s comment becomes "a judge scenario's P(yes)". `ScenarioRun` gains `/** judge scenarios "land anyway" left out of the pass */ skipped?: string[]`.

- Produces in `src/core/landing.ts`:

```ts
export type LandEvent = ... | { t: "unjudged"; name: string; why: string };
/** the prefix a red entry's gate carries when its score fell under minimum */
export const SCORE_GATE = "satisfaction ";
/** "satisfaction 0.62 < 1": the score to two places, the minimum as written */
export const scoreGate = (score: number, minimum: number): string;
/** What a branch under minimum is sent back with: each judge scenario not
 *  satisfied, with its name, the judge's reason and its output tail; never
 *  the story. If all passed their threshold, include each judge scenario's
 *  probability and tail so a low branch score never has an empty reason. */
export function scoreOutput(results: readonly ScenarioResult[]): string;
/** "land anyway": the entry held for a judge goes back to queued at its old
 *  place with skipJudge set. Throws a LandError for any other entry. */
export function landAnyway(entries: readonly LandEntry[], id: string, now: number): LandEntry[];
```

`inQueue` adds `judge`; `WORKING` does not, so `restartWorking` leaves a held entry alone, as `retryWaiting` and `holdAll` do by their own states. `advance` on `unjudged`: `next("judge", { gate: ev.name, reason: \`scenario ${ev.name} needs a judge: ${ev.why}\` })`. `landWord` says `needs a judge` in the `judge` state. `scoreOutput` takes every result with `kind === "judge"` and `!ok`, writes `scenario <name>: <why, else unjudged, else "did not run">` and then `\n<tail>` when there is one, and joins the parts with a blank line. If that set is empty, it uses every judge result and writes `scenario <name>: satisfaction <p to two places>` with its tail, so a below-minimum result whose scenarios all passed still explains the score. `landAnyway` throws `LandError("no entry by that id", 404)` when none matches and `LandError("it is not held for a judge")` when the entry's state is not `judge`; the entry comes back as `{ ...stripReason(e), state: "queued", skipJudge: true, updatedAt: now }` with its `queuedAt` kept. `fixPrompt` for a red entry whose gate starts with `SCORE_GATE` reads:

```
canopy's landing queue sent this branch (<branch>) back: its holdout scenarios scored <gate> after a rebase onto <target>. The scenarios are kept outside the repository and are not shown; the end of what each one observed, and what the judge said, is below:

<reason>

Rebase onto <target>, fix what the output shows, run the repo's checks, and commit. Do not push.
```

- [ ] **Step 1: Write the failing tests in `src/core/landing.test.ts`**

Import `landAnyway`, `scoreGate`, `scoreOutput` and `SCORE_GATE` with the rest, plus any of `holdAll`, `retryWaiting`, `restartWorking`, `nextEntry`, `queueOf` and `landCounts` the file does not import yet, and add:

```ts
describe("judge scenarios (plan 2)", () => {
  test("a judge that cannot answer holds the entry in its place, apart from waiting", () => {
    const base = advance(advance(enqueue([], run("j1"), 1)[0]!, { t: "begin" }, 2), { t: "scenarios", first: "refund" }, 3);
    const e = advance(base, { t: "unjudged", name: "refund", why: "no gateway key" }, 4);
    expect([e.state, e.gate, e.reason, landWord(e, [e]), inQueue(e), sentBack(e)]).toEqual(["judge", "refund", "scenario refund needs a judge: no gateway key", "needs a judge", true, false]);
    expect(retryWaiting([e], "canopy", 5)[0]!.state).toBe("judge");
    expect(restartWorking([e], 5)[0]!.state).toBe("judge");
    expect(holdAll([e], "canopy", "checkout not on main", 5)[0]!.state).toBe("judge");
    expect(nextEntry([e], "canopy")).toBeUndefined();
    expect(queueOf([e], "canopy").map((x) => x.id)).toEqual(["j1"]);
    expect(landCounts([e], "canopy")).toEqual({ queued: 1, back: 0 });
  });

  test("land anyway puts it back at its place with skipJudge, and only from the hold", () => {
    const [a, b] = queued(["a", "b"]);
    const held = advance(advance(b!, { t: "begin" }, 2), { t: "unjudged", name: "refund", why: "no gateway key" }, 3);
    const out = landAnyway([a!, held], "b", 9);
    expect(out[1]).toMatchObject({ id: "b", state: "queued", skipJudge: true, queuedAt: held.queuedAt, updatedAt: 9 });
    expect([out[1]!.gate, out[1]!.reason]).toEqual([undefined, undefined]);
    expect(queueOf(out, "canopy").map((e) => e.id)).toEqual(["a", "b"]);
    expect(nextEntry(out, "canopy")?.id).toBe("a");
    expect(() => landAnyway([a!, held], "a", 9)).toThrow("it is not held for a judge");
    expect(() => landAnyway([a!], "zz", 9)).toThrow("no entry by that id");
  });

  test("a score under minimum is its own red, and the fix prompt carries observations, never a story", () => {
    const results = [
      { name: "a", kind: "command" as const, ok: true, tail: "fine" },
      { name: "refund", kind: "judge" as const, ok: false, p: 0.3, why: "the judge says what was observed only partly satisfies the story", tail: "refund 42: no" },
      { name: "mail", kind: "judge" as const, ok: true, p: 0.9 },
      { name: "late", kind: "judge" as const, ok: false, unjudged: "no gateway key" },
    ];
    expect(scoreOutput(results)).toBe("scenario refund: the judge says what was observed only partly satisfies the story\nrefund 42: no\n\nscenario late: no gateway key");
    expect(scoreOutput([{ name: "mail", kind: "judge", ok: true, p: 0.9, tail: "sent" }])).toBe("scenario mail: satisfaction 0.90\nsent");
    expect(scoreGate(0.5, 1)).toBe("satisfaction 0.50 < 1");
    expect(scoreGate(2 / 3, 0.8)).toBe("satisfaction 0.67 < 0.8");
    const base = advance(enqueue([], run("j2"), 1)[0]!, { t: "begin" }, 2);
    const e = advance(base, { t: "red", gate: scoreGate(0.5, 1), output: scoreOutput(results) }, 3);
    expect([e.state, e.gate, landWord(e, [e]), scenarioOf(e.gate), e.gate?.startsWith(SCORE_GATE)]).toEqual(["red", "satisfaction 0.50 < 1", "red: satisfaction 0.50 < 1", null, true]);
    const p = fixPrompt(e);
    expect(p).toContain("its holdout scenarios scored satisfaction 0.50 < 1 after a rebase onto main");
    expect(p).toContain("are not shown");
    expect(p).toContain("scenario refund: the judge says");
    expect(p.endsWith("Rebase onto main, fix what the output shows, run the repo's checks, and commit. Do not push.")).toBe(true);
    expect(p).not.toContain("gate failed");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test src/core/landing.test.ts -t "plan 2"`
Expected: FAIL, `landAnyway` is not exported and the `unjudged` event is not handled.

- [ ] **Step 3: Add the types and the model**

`src/core/types.ts` and `src/core/landing.ts` as the Interfaces block says. Update `landing.ts`'s header comment: "...then the repo's scenarios, whose judge may hold an entry for Eric, then fast-forward main".

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test src/core/landing.test.ts src/cli/land.test.ts ui/src/landing.test.ts ui/src/inbox.test.ts && bun run typecheck`
Expected: PASS; typecheck clean. The UI's and the CLI's switches on `LandState` fall through to `e.state` or `e.gate` for a state they do not name, so nothing else changes yet.

- [ ] **Step 5: Commit**

```bash
git add src/core/types.ts src/core/landing.ts src/core/landing.test.ts
git commit -m "feat(scenarios): the judge hold, land anyway and the satisfaction gate in the queue's model"
```

---

### Task 3: the pass judges

**Files:**
- Modify: `src/server/scenarios.ts` (from plan 1: `ScenarioPass`, `runScenarioSet`, `ScenarioDeps`, the run route), `src/server/scenarios.test.ts` (from plan 1: `setFor`, `runner`, `hub`); `src/server/index.ts:59` (the `jev` import) and the `Scenarios` block plan 1 adds after the hub; the pass call in `src/server/landing.ts`'s `turn` (from plan 1)

**Interfaces:**
- Consumes: Task 1's `scenarioState`, `decideScenario`; `readEvidence` from `core/evidence.ts`; `tail` from `core/landing.ts`; `scoreOf` from `core/scenario.ts`; plan 1's `ScenarioPass`, `ScenarioRunner`, `runScenarioSet`, `ScenarioDeps`, `Scenarios`.
- Produces in `src/server/scenarios.ts`:

```ts
export type ScenarioJudge = (state: string) => Promise<ScenarioAnswers>;
/** why a judge scenario could not be judged */
export const NO_JUDGE_KEY = "no gateway key";
export const JUDGE_OFF = "the judge is off in .canopy/scenarios.json";

export interface ScenarioPass {
  ...plan 1's fields...
  /** judges one scenario's state (`jevScenario`); null when there is no gateway key */
  judge: ScenarioJudge | null;
  /** reads a scenario's evidence out of the worktree; `readEvidence` unless a test says otherwise */
  evidence?: (dir: string, paths: string[]) => Promise<EvidenceFile[]>;
  /** Eric's land anyway: judge scenarios are left out and named in `skipped` */
  skipJudge?: boolean;
}
export interface ScenarioDeps {
  ...plan 1's fields...
  judge: ScenarioJudge | null;
}
```

`runScenarioSet` after plan 1's command loop, only when no result is red and no file is in `errors`: for each judge scenario in file order, when `p.skipJudge`, its name goes to `skipped` and nothing runs; else its line, when it has one, runs through `p.run` under the set's timeout and `out` is `r.output || \`exited ${r.exit ?? "on a signal"}\``, whatever the exit (the exit is not the verdict), and `out` is null without a line. Then `why` is `JUDGE_OFF` when `p.settings.judge === "off"`, `NO_JUDGE_KEY` when `p.judge` is null, else null. With a `why` the result is `{ name, kind: "judge", ok: false, unjudged: why, tail? }`. Otherwise `files = await (p.evidence ?? readEvidence)(p.dir, s.evidence)`, and in a `try`, `j = decideScenario(await p.judge(scenarioState({ story: s.body, output: out, files })))` gives `{ name, kind: "judge", ok: j.ok, p: j.p, why?: j.reason, tail? }`; a throw gives `unjudged: \`the judge did not answer: ${errText(err)}\``. `tail` is `tail(out)` when a line ran. `onDone(result, next)` after each, where `next` is the name of the next scenario to run, command or judge, or null after the last. `total` is errors plus command scenarios plus the judge scenarios not skipped; `skipped` is on the run only when it has names. The copy is removed in `finally` as before.

The run route builds its pass with `judge: this.deps.judge` and no `skipJudge`. In `src/server/index.ts`, import `jevScenario` beside `jevJudge` and give the `Scenarios` deps `judge: hasGatewayKey() ? jevScenario : null`. The pass call in `src/server/landing.ts`'s `turn` gets `judge: null` for now; Task 4 replaces it.

- [ ] **Step 1: Write the failing tests in `src/server/scenarios.test.ts`**

Beside plan 1's helpers, with `ScenarioAnswers` imported from `../core/types` and `JUDGE_OFF`, `NO_JUDGE_KEY` from `./scenarios`:

```ts
const story = (name: string, run?: string, evidence?: string) => `---\nname: ${name}\nkind: judge\n${run ? `run: ${run}\n` : ""}${evidence ? `evidence: ${evidence}\n` : ""}---\nSECRET STORY ${name}\n`;
const YES: ScenarioAnswers = { satisfied: { choice: "yes", probabilities: { yes: 0.9, partly: 0.07, no: 0.03 } }, evidence: { probability: 0.8 } };
const PARTLY: ScenarioAnswers = { satisfied: { choice: "partly", probabilities: { yes: 0.3, partly: 0.6, no: 0.1 } }, evidence: { probability: 0.8 } };
const files = async (dir: string, paths: string[]) => paths.map((path) => ({ path, text: `${dir}:${path}` }));

test("judge scenarios run after the commands: the line's output and the evidence reach the judge, the story reaches only the judge", async () => {
  const repo = join(root, "r10");
  const dir = await setFor(repo, { "a.md": cmd("a", "make a"), "refund.md": story("refund", "curl refund", "src/refund.ts") });
  const set = await readScenarioSet(root, repo);
  const r = runner({ "curl refund": { exit: 7, output: "refund granted" } });
  const states: string[] = [];
  const done: [string, string | null][] = [];
  const out = await runScenarioSet({
    dir: "/wt", setDir: dir, set, settings: { ...DEFAULT_SETTINGS, timeout: 9 }, run: r.run, head: "h", now: 1,
    judge: async (state) => { states.push(state); return YES; },
    evidence: files,
    onDone: (x, next) => done.push([x.name, next]),
  });
  expect(r.calls.map(([, line, , ms]) => [line, ms])).toEqual([["make a", 9000], ["curl refund", 9000]]);
  expect(states).toHaveLength(1);
  expect(states[0]).toContain("Story, as a user would read it:\nSECRET STORY refund");
  expect(states[0]).toContain("<<<\nrefund granted\n>>>");
  expect(states[0]).toContain("File src/refund.ts:\n/wt:src/refund.ts");
  expect(done).toEqual([["a", "refund"], ["refund", null]]);
  expect(out).toMatchObject({ total: 2, passed: 2, results: [{ name: "a", ok: true }, { name: "refund", kind: "judge", ok: true, p: 0.9, tail: "refund granted" }] });
  expect(out.score).toBeCloseTo(0.95);
  expect(out.skipped).toBeUndefined();
  expect(JSON.stringify(out)).not.toContain("SECRET STORY");
});

test("a judge scenario under the thresholds is recorded with why and the pass goes on; a line without a run is judged on its files alone", async () => {
  const repo = join(root, "r11");
  const dir = await setFor(repo, { "mail.md": story("mail"), "refund.md": story("refund", "curl refund") });
  const set = await readScenarioSet(root, repo);
  const r = runner({ "curl refund": { exit: 1, output: "boom" } });
  const states: string[] = [];
  const out = await runScenarioSet({ dir: "/wt", setDir: dir, set, settings: DEFAULT_SETTINGS, run: r.run, head: "h", now: 1, judge: async (state) => { states.push(state); return state.includes("STORY mail") ? YES : PARTLY; }, evidence: files });
  expect(states[0]).toContain("Observed output: (no command ran)");
  expect(out.results).toEqual([
    { name: "mail", kind: "judge", ok: true, p: 0.9 },
    { name: "refund", kind: "judge", ok: false, p: 0.3, why: "the judge says what was observed only partly satisfies the story", tail: "boom" },
  ]);
  expect([out.total, out.passed]).toEqual([2, 1]);
  expect(out.score).toBeCloseTo(0.6);
});

test("no key, the judge off, or a judge that throws: the scenario is unjudged, counts 0, and the commands still count", async () => {
  const repo = join(root, "r12");
  const dir = await setFor(repo, { "a.md": cmd("a", "make a"), "refund.md": story("refund", "curl refund") });
  const set = await readScenarioSet(root, repo);
  const base = { dir: "/wt", setDir: dir, set, run: runner({ "curl refund": { exit: 0, output: "seen" } }).run, head: "h", now: 1, evidence: files };
  const noKey = await runScenarioSet({ ...base, settings: DEFAULT_SETTINGS, judge: null });
  expect(noKey).toMatchObject({ total: 2, passed: 1, score: 0.5, results: [{ name: "a", ok: true }, { name: "refund", kind: "judge", ok: false, unjudged: NO_JUDGE_KEY, tail: "seen" }] });
  const off = await runScenarioSet({ ...base, settings: { ...DEFAULT_SETTINGS, judge: "off" }, judge: async () => YES });
  expect(off.results[1]).toMatchObject({ unjudged: JUDGE_OFF });
  const down = await runScenarioSet({ ...base, settings: DEFAULT_SETTINGS, judge: async () => { throw new Error("gateway down"); } });
  expect(down.results[1]).toMatchObject({ ok: false, unjudged: "the judge did not answer: gateway down" });
  expect(down.results[1]!.p).toBeUndefined();
});

test("skipJudge leaves the judge scenarios out, names them, and runs no line of theirs", async () => {
  const repo = join(root, "r13");
  const dir = await setFor(repo, { "a.md": cmd("a", "make a"), "refund.md": story("refund", "curl refund") });
  const set = await readScenarioSet(root, repo);
  const r = runner({});
  let judged = 0;
  const out = await runScenarioSet({ dir: "/wt", setDir: dir, set, settings: DEFAULT_SETTINGS, run: r.run, head: "h", now: 1, judge: async () => { judged++; return YES; }, skipJudge: true });
  expect(r.calls.map((c) => c[1])).toEqual(["make a"]);
  expect(judged).toBe(0);
  expect(out).toEqual({ head: "h", at: 1, total: 1, passed: 1, score: 1, results: [{ name: "a", kind: "command", ok: true, tail: "exited 0" }], skipped: ["refund"] });
});

test("a red command stops the pass before any judge runs, and the judge scenario counts 0", async () => {
  const repo = join(root, "r14");
  const dir = await setFor(repo, { "a.md": cmd("a", "make a"), "refund.md": story("refund") });
  const set = await readScenarioSet(root, repo);
  let judged = 0;
  const out = await runScenarioSet({ dir: "/wt", setDir: dir, set, settings: DEFAULT_SETTINGS, run: runner({ "make a": { exit: 1, output: "1 fail" } }).run, head: "h", now: 1, judge: async () => { judged++; return YES; } });
  expect(judged).toBe(0);
  expect([out.total, out.passed, out.score, out.results.length]).toEqual([2, 0, 0, 1]);
});
```

And in plan 1's route test, `hub()` gains `judge: null` in its deps, with one more test:

```ts
test("the run route judges with the judge it was given", async () => {
  const repo = join(root, "r15");
  await mkdir(repo, { recursive: true });
  await setFor(repo, { "refund.md": story("refund") });
  const { call } = hub(repo, undefined, {}, async () => YES);
  const got = (await (await call("POST", "/api/scenarios/run", { repo: "r" }))!.json()) as ScenarioRun;
  expect(got.results).toEqual([{ name: "refund", kind: "judge", ok: true, p: 0.9 }]);
});
```

`hub` takes the judge as a fourth argument, `judge: ScenarioJudge | null = null`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test src/server/scenarios.test.ts`
Expected: FAIL on the new tests (`judge` is not a field of the pass; judge scenarios are left out).

- [ ] **Step 3: Implement the judge loop, the dep, the route's judge and the wiring**

Update the file's header: "...the pass runs the command scenarios, then the judge ones through Jev". The existing plan 1 test "judge scenarios are left out of the pass in plan 1" is replaced by the first test above.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test src/server/scenarios.test.ts src/server/landing.test.ts && bun run typecheck`
Expected: PASS; typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/server/scenarios.ts src/server/scenarios.test.ts src/server/landing.ts src/server/index.ts
git commit -m "feat(scenarios): the pass runs judge scenarios through Jev after the command ones"
```

---

### Task 4: the turn holds, scores and lands anyway

**Files:**
- Modify: `src/server/landing.ts:54` (`LandingDeps`), `:591` (`land`), `:662` (`drop`), `:791` (`turn`, at the pass plan 1 adds after the gates), `:915` (the land route); `src/server/landing.test.ts`; `src/server/index.ts:5162` (the hub's deps)

**Interfaces:**
- Consumes: Task 2's `landAnyway`, `scoreGate`, `scoreOutput` and the `unjudged` event; Task 3's `ScenarioJudge`, `ScenarioPass.judge`, `.evidence`, `.skipJudge`; Task 1's `jevScenario`; `readEvidence`; plan 1's test world (`scenRoot`, `scenarios`, `scenAnswers`, `addScenario`, `readyRun`, `entryOf`, `rehub`, `commit`).
- Produces in `src/server/landing.ts`:

```ts
export interface LandingDeps {
  ...
  /** judges one judge scenario (`jevScenario`); null without a gateway key, so judge scenarios hold */
  judge: ScenarioJudge | null;
  /** reads a judge scenario's evidence out of a worktree; `readEvidence` unless a test says otherwise */
  evidence?: (dir: string, paths: string[]) => Promise<EvidenceFile[]>;
}
/** `skipJudge` is "land anyway": only an entry held for a judge takes it,
 *  and it goes back to queued at its place with the flag written on it */
async land(id: string, approve?: string, skipJudge?: boolean): Promise<LandEntry>;
```

Behaviour:
- `turn` builds the pass with `judge: this.deps.judge`, `evidence: this.deps.evidence`, `skipJudge: e.skipJudge === true`, and its `onDone` moves on for `r.ok || r.kind === "judge"`. After the record is written and plan 1's red check (which fires only for a result with `kind === "command"`, errors included), in order: `unjudged = pass.results.find((r) => r.unjudged !== undefined)`, when found `this.step(e, { t: "unjudged", name: unjudged.name, why: unjudged.unjudged })` and `return`; then when `pass.score < settings.minimum`, `this.step(e, { t: "red", gate: scoreGate(pass.score, settings.minimum), output: scoreOutput(pass.results) })` and `return`. Else the moved check and the rest as before.
- `land` with `skipJudge`: `this.entries = landAnyway(this.entries, this.find(id)?.id ?? id, this.now())`, then `saveQueue`, `publish`, `kick`, and the entry is returned. `approve` is ignored on that path.
- `drop`: the refusal "it is in the queue; wait for it to land or come back" skips an entry in `judge`, since nothing is working its worktree; the rest of `drop` applies.
- The route: `skipJudge`, when given, must be a boolean, else 400 `"skipJudge must be true or false"`; `land(run, approve, skipJudge === true)`.
- `src/server/index.ts`: the hub's deps gain `judge: hasGatewayKey() ? jevScenario : null`, as the `Scenarios` deps did in Task 3; `evidence` is left to its default, `readEvidence`.

- [ ] **Step 1: Extend the test world in `src/server/landing.test.ts`**

In `World`: `judged: string[]` and `judgeAnswer: ScenarioAnswers | (() => ScenarioAnswers | Promise<ScenarioAnswers>)`. `world()` takes `judge?: false` in its options; the hub's deps get:

```ts
judge: opts.judge === false ? null : async (state) => {
  w.judged.push(state);
  return typeof w.judgeAnswer === "function" ? await w.judgeAnswer() : w.judgeAnswer;
},
evidence: async (dir, paths) => paths.map((path) => ({ path, text: `${dir}:${path}` })),
```

with `judgeAnswer: YES` to start; `rehub` gets `judge: null`. Constants `YES` and `PARTLY` as Task 3's tests have them. Two helpers:

```ts
const storyOf = (name: string, run?: string, evidence?: string) => `---\nname: ${name}\nkind: judge\n${run ? `run: ${run}\n` : ""}${evidence ? `evidence: ${evidence}\n` : ""}---\nSECRET STORY ${name}\n`;
/** the newest pass written on a branch's record, from the landing events, since a landed record is dropped */
const lastPass = (w: World, id: string): ScenarioRun | undefined =>
  w.events.flatMap((ev) => (ev.type === "landing" ? ev.landing.runs : [])).filter((r) => r.id === id && r.scenarios).at(-1)?.scenarios;
```

- [ ] **Step 2: Write the failing tests**

In a new `describe("judge scenarios (FR-032, plan 2)")`:

```ts
test("a judge scenario is judged after the commands and the branch lands with its satisfaction on the record", async () => {
  const w = await world();
  await addScenario(w, "a", "make a");
  await addScenario(w, "refund", undefined, storyOf("refund", "curl refund", "b.txt"));
  await readyRun(w, "sj1", "b.txt", "b\n");
  w.scenAnswers.set("curl refund", { exit: 0, output: "refund 42 granted" });
  await w.hub.land("sj1");
  await w.hub.idle();
  expect(entryOf(w, "sj1")?.state).toBe("landed");
  expect(w.scenarios.map((c) => c[1])).toEqual(["make a", "curl refund"]);
  expect(w.judged).toHaveLength(1);
  expect(w.judged[0]).toContain("SECRET STORY refund");
  expect(w.judged[0]).toContain("<<<\nrefund 42 granted\n>>>");
  expect(w.judged[0]).toContain("File b.txt:\n");
  expect(lastPass(w, "sj1")).toMatchObject({ total: 2, passed: 2, results: [{ name: "a", ok: true }, { name: "refund", kind: "judge", ok: true, p: 0.9, tail: "refund 42 granted" }] });
  expect(JSON.stringify(w.events)).not.toContain("SECRET STORY");
});

test("no gateway key: the entry holds as needs a judge in its place, the queue works on behind it, and land anyway lands it with the judge left out", async () => {
  const w = await world({ judge: false });
  await addScenario(w, "a", "make a");
  await addScenario(w, "refund", undefined, storyOf("refund", "curl refund"));
  await readyRun(w, "sj2", "b.txt", "b\n");
  await w.hub.land("sj2");
  await w.hub.idle();
  const held = entryOf(w, "sj2")!;
  expect([held.state, held.gate, held.reason]).toEqual(["judge", "refund", "scenario refund needs a judge: no gateway key"]);
  expect(w.scenarios.map((c) => c[1])).toEqual(["make a", "curl refund"]);
  expect(lastPass(w, "sj2")).toMatchObject({ total: 2, passed: 1, score: 0.5, results: [{ name: "a", ok: true }, { name: "refund", ok: false, unjudged: "no gateway key" }] });
  expect(await revOf(w.repo.path, "HEAD")).not.toBe(await revOf(runTreeDir(w.repo.path, "sj2", w.wts), "HEAD"));
  // retry() is for waiting entries; a held one stays
  w.hub.retry();
  await w.hub.idle();
  expect(entryOf(w, "sj2")?.state).toBe("judge");
  // another branch lands past it
  await readyRun(w, "sj3", "c.txt", "c\n");
  await w.hub.land("sj3");
  await w.hub.idle();
  expect([entryOf(w, "sj3")?.state, entryOf(w, "sj2")?.state]).toEqual(["landed", "judge"]);
  // a restart keeps the hold
  const again = rehub(w);
  await again.adopt();
  await again.idle();
  expect(again.info().entries.find((e) => e.id === "sj2")?.state).toBe("judge");
  // land anyway: queued again with the flag, the pass leaves the judge scenario out, and it lands
  const n = w.scenarios.length;
  const e = await w.hub.land("sj2", undefined, true);
  expect(e).toMatchObject({ state: "queued", skipJudge: true, queuedAt: held.queuedAt });
  await w.hub.idle();
  expect(entryOf(w, "sj2")?.state).toBe("landed");
  expect(w.scenarios.slice(n).map((c) => c[1])).toEqual(["make a"]);
  expect(lastPass(w, "sj2")).toMatchObject({ total: 1, passed: 1, score: 1, skipped: ["refund"] });
});

test("judge off in .canopy/scenarios.json holds the same way with its own words, and drop takes a held entry", async () => {
  const w = await world();
  await commit(w.repo.path, ".canopy/scenarios.json", '{"judge": "off"}');
  await addScenario(w, "refund", undefined, storyOf("refund"));
  await readyRun(w, "sj4", "b.txt", "b\n");
  await w.hub.land("sj4");
  await w.hub.idle();
  expect(entryOf(w, "sj4")?.reason).toBe("scenario refund needs a judge: the judge is off in .canopy/scenarios.json");
  expect(w.judged).toHaveLength(0);
  await w.hub.drop("sj4");
  expect(entryOf(w, "sj4")).toBeUndefined();
  expect(existsSync(runTreeDir(w.repo.path, "sj4", w.wts))).toBe(false);
});

test("a score under minimum sends the branch back with the satisfaction gate and the judge's observations, never the story", async () => {
  const w = await world();
  await addScenario(w, "a", "make a");
  await addScenario(w, "mail", undefined, storyOf("mail"));
  await addScenario(w, "refund", undefined, storyOf("refund", "curl refund"));
  await readyRun(w, "sj5", "b.txt", "b\n");
  w.scenAnswers.set("curl refund", { exit: 0, output: "refund 42: no" });
  w.judgeAnswer = () => (w.judged.at(-1)?.includes("STORY refund") ? PARTLY : YES);
  await w.hub.land("sj5");
  await w.hub.idle();
  const e = entryOf(w, "sj5")!;
  // (1 + 0.9 + 0.3) / 3
  expect([e.state, e.gate]).toEqual(["red", "satisfaction 0.73 < 1"]);
  expect(e.reason).toBe("scenario refund: the judge says what was observed only partly satisfies the story\nrefund 42: no");
  expect(JSON.stringify(w.hub.info())).not.toContain("SECRET STORY");
  expect(fixPrompt(e)).not.toContain("SECRET STORY");
  await w.hub.fix("sj5");
  expect(w.fixes).toHaveLength(1);
  expect(lastPass(w, "sj5")).toMatchObject({ total: 3, passed: 2 });
});

test("the boundary: minimum controls landing even when every scenario passes its own threshold", async () => {
  const w = await world();
  await commit(w.repo.path, ".canopy/scenarios.json", '{"minimum": 0.7}');
  await addScenario(w, "a", "make a");
  await addScenario(w, "mail", undefined, storyOf("mail"));
  await addScenario(w, "refund", undefined, storyOf("refund"));
  await readyRun(w, "sj6", "b.txt", "b\n");
  w.judgeAnswer = () => (w.judged.at(-1)?.includes("STORY refund") ? PARTLY : YES);
  await w.hub.land("sj6");
  await w.hub.idle();
  expect(entryOf(w, "sj6")?.state).toBe("landed");
  const w2 = await world();
  await addScenario(w2, "refund", undefined, storyOf("refund"));
  await readyRun(w2, "sj7", "b.txt", "b\n");
  await w2.hub.land("sj7");
  await w2.hub.idle();
  expect([entryOf(w2, "sj7")?.state, lastPass(w2, "sj7")?.score]).toEqual(["red", 0.9]);
  expect(entryOf(w2, "sj7")?.gate).toBe("satisfaction 0.90 < 1");
  const w3 = await world();
  await commit(w3.repo.path, ".canopy/scenarios.json", '{"minimum": 0.9}');
  await addScenario(w3, "refund", undefined, storyOf("refund"));
  await readyRun(w3, "sj9", "b.txt", "b\n");
  await w3.hub.land("sj9");
  await w3.hub.idle();
  expect([entryOf(w3, "sj9")?.state, lastPass(w3, "sj9")?.score]).toEqual(["landed", 0.9]);
});

test("land anyway on an entry that is not held is refused, as is a skipJudge that is not a boolean", async () => {
  const w = await world();
  await readyRun(w, "sj8", "b.txt", "b\n");
  await expect(w.hub.land("sj8", undefined, true)).rejects.toThrow("no entry by that id");
  await w.hub.land("sj8");
  await w.hub.idle();
  await expect(w.hub.land("sj8", undefined, true)).rejects.toThrow("it is not held for a judge");
  const res = (await w.hub.handle(new Request("http://x/api/landing/land", { method: "POST", body: JSON.stringify({ run: "sj8", skipJudge: "yes" }) }), new URL("http://x/api/landing/land")))!;
  expect(res.status).toBe(400);
  expect(await res.json()).toEqual({ error: "skipJudge must be true or false" });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `bun test src/server/landing.test.ts -t "plan 2"`
Expected: FAIL (`judge` is not a known dep; `land` takes two arguments).

- [ ] **Step 4: Implement the deps, the hold and the score in `turn`, `land`, `drop`, the route, and the hub's judge**

Update the module's header comment ("...the repo's scenarios, whose judge may hold an entry for Eric's land anyway..."). Import `fixPrompt` from `../core/landing` in the test. Give every `new LandingHub` in the tests the `judge` dep so typecheck holds.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `bun test src/server/landing.test.ts src/server/scenarios.test.ts src/server/prs.test.ts && bun run typecheck && bun run lint`
Expected: PASS, clean.

- [ ] **Step 6: Commit**

```bash
git add src/server/landing.ts src/server/landing.test.ts src/server/index.ts src/server/prs.test.ts
git commit -m "feat(scenarios): the queue holds for a judge, lands anyway on Eric's word and sends a low score back"
```

---

### Task 5: the CLI

**Files:**
- Modify: `src/cli/land.ts:10` (`LAND_USAGE`), `:13` (`backWords`), `:22` (`queueLines`), `:84` (the `land` branch); `src/cli/land.test.ts`; `src/cli/scenarios.ts` (`runLines`, from plan 1) and `src/cli/scenarios.test.ts`; `README.md:77` (after the `--approve` line)

**Interfaces:**
- Consumes: `SCORE_GATE` (Task 2); `has` from `./health`; plan 1's `runLines(run: ScenarioRun): string[]`.
- Produces in `src/cli/land.ts`:

```ts
export const LAND_USAGE =
  "usage: canopy land <run> [--approve <id>] [--skip-judge] [--backend URL]\n       canopy land --all [repo] [--backend URL]\n       canopy queue [repo] [--backend URL]";
```

`land` with `--skip-judge` posts `{ run, skipJudge: true }` and prints `${entry.branch}: queued again with the judge scenarios left out; the queue rebases it onto ${entry.target}, runs the gates and the command scenarios, and fast-forwards ${entry.target}`. `queueLines` writes a `judge` entry's row as `  needs a judge    ${e.branch}  ${e.reason}  land anyway: canopy land ${e.id} --skip-judge` (the word padded to 16 as the others are). `backWords` gives a red whose gate starts with `SCORE_GATE` the gate alone, with no "failed" after it. In `src/cli/scenarios.ts`, `runLines` writes a judge result's word as its `p` to two places, or `unjudged`, then the name and the why: the word is `padEnd(4)` and a space before the name, so `  ok   a` and `  red  b  1 fail` stay as plan 1 pinned them; the head line gains ` · ${skipped.length} left out` when the run has `skipped`.

- [ ] **Step 1: Write the failing tests**

In `src/cli/land.test.ts`, with the file's `rec` helper and its `advance` and `enqueue` imports:

```ts
test("an entry held for a judge, and a red for a low score", () => {
  const held = advance(advance(enqueue([], rec("b1"), 1)[0]!, { t: "begin" }, 2), { t: "unjudged", name: "refund", why: "no gateway key" }, 3);
  const low = advance(enqueue([], rec("b2"), 1)[0]!, { t: "red", gate: "satisfaction 0.73 < 1", output: "scenario refund: the judge says what was observed only partly satisfies the story\nrefund 42: no" }, 3);
  expect(queueLines({ runs: [], entries: [held, low], orphans: [] }, null)).toEqual([
    "dev-tools/canopy",
    "  needs a judge    run/x-b1  scenario refund needs a judge: no gateway key  land anyway: canopy land b1 --skip-judge",
    "  red: satisfaction 0.73 < 1 run/x-b2  refund 42: no",
  ]);
});
```

The red row is the existing one: `landWord` padded to 16, which a longer word overruns, then the branch and the last line of `backWords`. In `src/cli/scenarios.test.ts`, extend plan 1's `runLines` test:

```ts
test("runLines with judge results and skipped ones", () => {
  const run: ScenarioRun = { head: "h", at: 1, total: 3, passed: 2, score: 0.73, results: [
    { name: "a", kind: "command", ok: true },
    { name: "mail", kind: "judge", ok: true, p: 0.9 },
    { name: "refund", kind: "judge", ok: false, p: 0.3, why: "the judge says what was observed only partly satisfies the story", tail: "refund 42: no" },
    { name: "late", kind: "judge", ok: false, unjudged: "no gateway key" },
  ] };
  expect(runLines(run)).toEqual(["scenarios 2/3 · 0.73", "  ok   a", "  0.90 mail", "  0.30 refund  the judge says what was observed only partly satisfies the story", "  unjudged late  no gateway key"]);
  expect(runLines({ head: "h", at: 1, total: 1, passed: 1, score: 1, results: [{ name: "a", kind: "command", ok: true }], skipped: ["refund"] })[0]).toBe("scenarios 1/1 · 1.00 · 1 left out");
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test src/cli/land.test.ts src/cli/scenarios.test.ts`
Expected: FAIL on the two new tests.

- [ ] **Step 3: Implement the flag, the rows, the words and the README line**

The README line, after `canopy land <run> --approve <id>`:

```
canopy land <run> --skip-judge     # land anyway: a run held because a judge scenario had no judge; its judge scenarios are left out this once
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test src/cli/ && bun run typecheck && bun run lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/cli/land.ts src/cli/land.test.ts src/cli/scenarios.ts src/cli/scenarios.test.ts README.md
git commit -m "feat(scenarios): canopy land --skip-judge, the held row in canopy queue and judge results in scenarios run"
```

---

### Task 6: the page

**Files:**
- Modify: `ui/src/api.ts:828` (`land`); `ui/src/store.ts:1162` and `:3468` (`landRun`), `:3788` (the inbox's landing answer); `ui/src/landing.ts:124` (`RunLanding`), `:155` (`runLanding`), `:188` (`backLine`), the `scenarioLine` plan 1 adds; `ui/src/landing.test.ts`; `ui/src/inbox.ts:49` (`kind`), `:330` (`landingItem`), `:482` (`InboxAnswer`); `ui/src/inbox.test.ts:386-410`; `ui/src/components/Landing.tsx:129-140` (the queue rows); `ui/src/components/RunSheet.tsx:623` (`BranchBlock`), `:652` (after `canFix`), the `.run-scenarios` list plan 1 adds; `ui/src/components/Inbox.tsx:261` (beside `sent-back`); `ui/src/styles.css:4574` (after `.st-waiting`)

**Interfaces:**
- Consumes: `SCORE_GATE` (Task 2); `ScenarioResult`, `ScenarioRun` from `src/core/types.ts`; plan 1's `scenarioLine`, `scenarioTone` and the sheet's `.run-scenarios` block; the test files' `rec`, `run`, `info` and `entry`, `landing` helpers.
- Produces in `ui/src/landing.ts`:

```ts
export interface RunLanding { ...; /** held for a judge: "land anyway" applies */ canSkipJudge?: true }
/** "scenarios 7/8 · 0.88", with " · 1 left out" when land anyway left judge scenarios out */
export const scenarioLine = (s: Pick<ScenarioRun, "total" | "passed" | "score" | "skipped">): string;
/** a result's word in the sheet's list: ok, red, the judge's P(yes) to two places, or unjudged */
export const resultWord = (r: ScenarioResult): string;
```

`runLanding` sets `canSkipJudge: true` for an entry in `judge`, with `canFix` and `canPr` false. `backLine` gives a red whose gate starts with `SCORE_GATE` the gate alone. In `ui/src/inbox.ts`, `kind` gains `"needs-judge"`; `landingItem` also takes an entry in `judge` with no fix going, as `{ kind: "needs-judge", title: \`held ${e.branch}: needs a judge\`, detail: e.reason ?? "" }` under the same key and source; a sent-back item's `why` for a score red is the gate alone; `InboxAnswer`'s landing answer becomes `{ landing: "fix" | "drop" | "land" }`. `ui/src/api.ts`'s `land(id, approve?, skipJudge?)` adds `skipJudge: true` to the body when set; the store's `landRun(id, approve?, skipJudge?)` passes it on, and its inbox answer sends `"land"` to `landRun(item.id, undefined, true)` after closing the inbox.

The components:
- `Landing.tsx`: a queue row in `judge` gets a `landing-tools` span with "land anyway" (`mini strong`, title "Land it with its judge scenarios left out; its command scenarios ran and passed", `act(e.id, () => landRun(e.id, undefined, true))`) and "drop" (title "Give the branch up: its worktree and its commits go").
- `RunSheet.tsx`: after the `canFix` button, `l.canSkipJudge` shows "land anyway" with the same title, calling `landRun(b.origin, undefined, true)`. Each `.run-scenarios` item reads `resultWord(r)`, the name, the kind dim, then `r.why ?? r.unjudged` dim when there is one, then the tail as before; the item is `rust` when `!r.ok`.
- `Inbox.tsx`: `item.kind === "needs-judge"` renders an `.ask` like `sent-back`'s with the detail and two buttons, "land anyway" (`answer({ landing: "land" })`) and "drop" (`answer({ landing: "drop" })`).
- `styles.css`: `.st-judge { --tone: var(--lichen); }` after `.st-waiting`. No new colors.

- [ ] **Step 1: Write the failing tests in `ui/src/landing.test.ts`**

```ts
test("an entry held for a judge offers land anyway and nothing else", () => {
  const held = { ...enqueue([], rec("a"), 1)[0]!, state: "judge" as const, gate: "refund", reason: "scenario refund needs a judge: no gateway key" };
  expect(runLanding(run("a"), info([rec("a")], [held]))).toEqual({ word: "needs a judge", canLand: false, canFix: false, canPr: false, canSkipJudge: true, entry: held });
});

test("backLine, scenarioLine and resultWord for judge scenarios", () => {
  expect(backLine({ ...enqueue([], rec("a"), 1)[0]!, state: "red", gate: "satisfaction 0.73 < 1" })).toBe("satisfaction 0.73 < 1");
  expect(scenarioLine({ total: 1, passed: 1, score: 1, skipped: ["refund"] })).toBe("scenarios 1/1 · 1.00 · 1 left out");
  expect(scenarioLine({ total: 2, passed: 2, score: 0.95 })).toBe("scenarios 2/2 · 0.95");
  expect(resultWord({ name: "a", kind: "command", ok: true })).toBe("ok");
  expect(resultWord({ name: "a", kind: "command", ok: false })).toBe("red");
  expect(resultWord({ name: "r", kind: "judge", ok: true, p: 0.9 })).toBe("0.90");
  expect(resultWord({ name: "r", kind: "judge", ok: false, p: 0.3, why: "x" })).toBe("0.30");
  expect(resultWord({ name: "r", kind: "judge", ok: false, unjudged: "no gateway key" })).toBe("unjudged");
});
```

- [ ] **Step 2: Write the failing tests in `ui/src/inbox.test.ts`**

In the "landing queue's sent-back branches" describe, with its `entry` and `landing` helpers:

```ts
test("an entry held for a judge is an item with land anyway, and a low score reads as its gate", () => {
  const ctx = { repos: [repo("app")], cards: {}, landing: landing([
    entry({ id: "b4", state: "judge", gate: "refund", reason: "scenario refund needs a judge: no gateway key" }),
    entry({ id: "b5", state: "red", gate: "satisfaction 0.73 < 1", reason: "scenario refund: the judge says what was observed only partly satisfies the story" }),
  ]) };
  const items = mergeInbox([], {}, {}, 0, ctx);
  expect(items.map((i) => [i.key, i.kind, i.title, i.detail])).toEqual([
    ["landing:b4", "needs-judge", "held run/x-b4: needs a judge", "scenario refund needs a judge: no gateway key"],
    ["landing:b5", "sent-back", "sent run/x-b5 back: satisfaction 0.73 < 1", "scenario refund: the judge says what was observed only partly satisfies the story"],
  ]);
  expect(toRunAnswer({ landing: "land" })).toBeNull();
  expect(toAskAnswer({ landing: "land" })).toBeNull();
});
```

The `entry` helper's `branch` is `run/x-b1` for every id; give the two entries their own `branch` in the overrides, or match the titles to `run/x-b1`.

- [ ] **Step 3: Run the tests to verify they fail**

Run: `bun test ui/src/landing.test.ts ui/src/inbox.test.ts`
Expected: FAIL on the three new tests.

- [ ] **Step 4: Implement the helpers, the api and store, the components and the CSS**

- [ ] **Step 5: Run the tests, typecheck, lint and build**

Run: `bun test ui/src && bun run typecheck && bun run lint && bun run build`
Expected: PASS, clean, built. Then look at it: start a scratch server as the memory note "Scratch canopy server for UI checks" says, without `AI_GATEWAY_API_KEY` in its environment, with a repo that has one judge scenario; land a branch run; the landing row reads `needs a judge` with the reason, the sheet shows "land anyway", the inbox has the row; "land anyway" lands it and the sheet's line reads `scenarios 0/0 · 1.00 · 1 left out`.

- [ ] **Step 6: Commit**

```bash
git add ui/src/api.ts ui/src/store.ts ui/src/landing.ts ui/src/landing.test.ts ui/src/inbox.ts ui/src/inbox.test.ts ui/src/components/Landing.tsx ui/src/components/RunSheet.tsx ui/src/components/Inbox.tsx ui/src/styles.css
git commit -m "feat(scenarios): land anyway on the sheet, the landing row and the inbox, and judge results in the sheet's list"
```

---

### Task 7: the docs and the gates

**Files:**
- Modify: `docs/architecture.md` (the "Scenarios (FR-032, plan 1)." paragraph plan 1 adds under "The landing queue"), `README.md` (the landing queue sentence plan 1 adds to the features list), `FEATURES.md` (the `### FR-032` block, under `## In Progress` once plan 1 shipped), `docs/superpowers/plans/README.md`, this plan's Status line

**Interfaces:**
- Consumes: the completed interfaces from Tasks 1 to 6, the source spec, and the live-check results.
- Produces: documentation and feature status that describe the implemented scope, with later phases still marked open. No new runtime interface.

- [ ] **Step 1: `docs/architecture.md`**

Retitle the paragraph "Scenarios (FR-032, plans 1 and 2)." and replace its sentence about judge scenarios waiting for plan 2 with: judge scenarios run after every command scenario passed, through `deps.judge` (`jevScenario`, the same Jev classifier as the flows' judge gate, asked `SCENARIO_QUESTIONS`: `satisfied` as yes, partly or no, and `evidence`); the scenario's line runs first when it has one, its exit not the verdict, and its output, the evidence files read from the worktree with `readEvidence`, and the story go to the judge as `scenarioState` (the story, then the output fenced between `<<<` and `>>>` as data, then the files clipped as `judgeState` clips them); `decideScenario` applies `SCENARIO_THRESHOLDS` (yes at 0.7, evidence at 0.35) and keeps `P(yes)` as the scenario's satisfaction; the score is the mean (`scoreOf`), and a branch lands only when no command scenario is red and its score reaches `.canopy/scenarios.json`'s `minimum`, else it is sent back `red` with the gate `satisfaction 0.62 < 1` (`scoreGate`) and `scoreOutput` as its reason; a judge that cannot answer (no gateway key, `judge: off`, or the gateway failing three attempts) holds the entry in the `judge` state ("needs a judge"; `retry()` never requeues it, a restart keeps it, the loop works the entries behind it, and `drop` takes it), and "land anyway" (`POST /api/landing/land {run, skipJudge: true}`, `canopy land <run> --skip-judge`, the sheet, the landing row and the inbox's `needs-judge` row) puts it back at its place with `skipJudge` written on it, so its next pass leaves the judge scenarios out and names them in `ScenarioRun.skipped`; the story never leaves the judge.

- [ ] **Step 2: `SPEC.md`**

Nothing to change: no state file is added, and the "Data and state" list names files, not their fields. Confirm with `grep -n "landing/" SPEC.md` that the line plan 1 wrote still reads true.

- [ ] **Step 3: `README.md`**

In the landing queue's feature bullet, after plan 1's sentence, add one: a judge scenario's story is read by Jev against what the branch did, each branch gets a satisfaction figure, and a scenario with no judge holds the branch for "land anyway". The CLI line was added in Task 5.

- [ ] **Step 4: `FEATURES.md` and the plans README**

Append to the FR-032 block's Spec line: `Plan 2 shipped <date> (judge scenarios through Jev, the hold for a judge and land anyway, the score and minimum); plan 3 (the PR watch's pass, the repo panel's list) open.` In `docs/superpowers/plans/README.md`, set this plan's row to `shipped` with the date, or add it as the first row when the orchestrator has not: `| [Scenario gates, plan 2: judge scenarios, the hold and the score](2026-10-26-scenario-gates-2.md) | shipped | <date> | [scenario gates](../specs/2026-10-25-scenario-gates-design.md) |`. Set this plan's Status line to shipped with the merge commit.

- [ ] **Step 5: Run every gate**

Run: `bun run typecheck && bun run lint && bun test && bun run build`
Expected: all pass. Then `~/.claude/skills/verify-build/clean-rebuild.sh verify "resultWord"` proves the served bundle is the new one.

- [ ] **Step 6: Commit**

```bash
git add docs/architecture.md README.md FEATURES.md docs/superpowers/plans/README.md docs/superpowers/plans/2026-10-26-scenario-gates-2.md
git commit -m "docs(scenarios): architecture, README and the feature list for plan 2"
```

---

## Live check, before the branch is called done

With a scratch canopy (the "Scratch canopy server for UI checks" memory note) whose environment carries `AI_GATEWAY_API_KEY`, pointed at a throwaway repo with a `package.json` script for `test` only:

1. `canopy scenarios <repo> add refund --judge --run 'echo "Order 42: refund granted, shipped six days ago, inside the fourteen-day window"'`, then edit the file's story to "A customer asks for a refund on order 42. The reply names the order and says whether the refund is granted and why."
2. `canopy scenarios <repo> run` prints `scenarios 1/1 · 0.9x` and a `0.9x refund` line, the judge's own number.
3. With default `minimum: 1`, a branch scoring `0.9x` comes back with `satisfaction 0.9x < 1`, even when the judge's threshold passed. Commit `{"minimum": 0.7}` in the scratch repo's `.canopy/scenarios.json` and start another branch: it lands when the score reaches 0.7. The sheet folds open to `0.9x refund judge` and the output, and the landing record holds `scenarios` with `p`.
4. Restore `minimum: 1`, then change the run line to `echo "no such order"`; the next branch run comes back `red: satisfaction 0.xx < 1`, its reason is the judge's words and `no such order`, nothing of the story; "fix it" starts a run whose first message says the scenarios scored under one and shows the same, and the run's transcript never holds the story.
5. Stop the scratch server, start it again without the key: the next branch run holds as `needs a judge` with "scenario refund needs a judge: no gateway key"; the inbox shows the row; `canopy queue` prints the held row with the `--skip-judge` hint; `canopy land <id> --skip-judge` lands it and the sheet reads `scenarios 0/0 · 1.00 · 1 left out`.
6. With `{"judge": "off"}` committed in `.canopy/scenarios.json`, the hold's reason names the file; "drop" on the held row removes the branch.

## Decisions this plan makes beyond the spec

- The spec's per-scenario thresholds and branch minimum are separate checks. The mean must reach `minimum` even when every judge scenario passed its threshold. Default 1 is deliberately strict for probabilistic scores; a repo can choose a lower minimum in its sensitive settings file. The plan does not silently change that policy.
- Judge scenarios run after every command scenario passed, not in file order with them: a red command scenario is cheap and ends the pass before any Jev call, and the judge scenarios then count 0, as plan 1 counts anything after a red.
- A judge scenario's `run` line's exit is not its verdict; the judge reads whatever the line printed. The spec says a command scenario passes on exit 0 and says nothing of a judge scenario's exit.
- The hold is a state of its own, `judge`, not `waiting`: `retry()` requeues every waiting entry every 30 s and would run the gates and the command scenarios again and again for an entry only Eric can move. A held entry keeps its place, the loop works the entries behind it, a restart keeps it, and "drop" takes it, the one queued state drop takes, since nothing is working its worktree.
- "land anyway" takes the entry's turn again from the rebase, as every return to the queue does: the gates and the command scenarios run again at the head of the moment, the judge scenarios are left out and named on the record as `skipped`, out of `total` and the score. The flag dies with the entry: a "fix it" rejoin or a new land judges again.
- When the judge cannot answer, the judge scenario's line still runs and its tail is kept, so Eric reading "needs a judge" sees what was observed before he lands anyway.
- Under `minimum`, every judge scenario the judge did not pass is named with its reason and its tail: those it called `partly` or `no`, and those it was not sure of or found too little evidence for.
- `judge: off` holds like a missing key, as the spec's "parks every judge scenario as `ask`" says; its words name the file so Eric knows which to change.
- Call 9 stands as the spec recommends: the judge is Jev through the gateway, never `claude -p`.
- Call 8 stands as the spec pins it: `minimum` ranges 0 to 1 with default 1. A lower value is a repo's explicit setting, never inferred from the judge's threshold.
- `ApproveSheet` does not list a red scenario: a red sends the branch back, it never holds a landing for approval, and the landing section, the sheet and the inbox carry it.
