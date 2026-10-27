# Workflow graph, plan 1: after, when and mode in the parser and the flow engine (FR-034)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Status:** plan 1 implemented and independently reviewed locally 2026-10-27 on `feat/oct26-batch`. Live checks remain pending; plans 2 and 3 remain open. Written on main at 1ac8fe7.

**Goal:** a workflow step can say what it waits for (`after:`), when it runs
(`when:`) and whether a person releases it (`mode:`); the flow engine runs the
steps as a graph, read-only steps side by side, a conditional step skipped, a
manual step held until a continue; a repo's `.canopy/workflows.json` has the
last word on modes; a trigger, fleet or incubator stage refuses a workflow nobody
could attend; and every chain workflow parses and runs exactly as it does
today.

**Architecture:** the parser (`core/workflow.ts`) reads the three keys into
`WorkflowStep.after`, `when` and `mode`, with `after` written out as the step
above when the line is absent, so one shape reaches the engine and plan 2's
picture. A pure module (`core/flowmodes.ts`) parses and applies the modes
file; a Bun-only reader beside `loadWorkflows` reads it at HEAD. The engine
(`core/flow.ts`) drops the "current step then the next" walk for one pass,
`advance`, that skips, holds and starts every ready step under the parallel
rule and ends the flow when every step is done; a park or failure while a
sibling runs is applied when the last live run ends. `Flow.current` stays as
the step the sheet follows. The strip, the API's `graph`, the CLI and the
bundled files wait for plans 2 and 3.

**Tech Stack:** Bun, TypeScript strict, React 19, bun:test. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-25-workflow-graph-design.md`, the
"Plans" list's item 1. The index is
`docs/superpowers/specs/2026-10-25-software-factory-borrowings-design.md`.

Left to later plans: plan 2 brings `ui/src/flowgraph.ts`, `StepGraph`, the
`graph` and `modes` fields of `GET /api/repos/workflows?id=` and
`canopy workflow show|check|list`; plan 3 rewrites the bundled workflows.

## Global constraints

- The three keys are `after`, `when` and `mode`, each optional, in a step's key block. `after` is a comma-separated list of earlier headings. `when` is a comma-separated list from `always`, `verdict done`, `verdict partial`, `verdict blocked`, `judge meets`, `judge partly`, `judge misses`, `check pass`, `check fail`, `changed`, `unchanged`, `skipped`. `mode` is `auto` or `manual`.
- A file that uses none of the keys parses to a chain and runs as before. No existing case in `src/core/workflow.test.ts` or `src/core/flow.test.ts` is edited; Task 1 adds a fixture test over every bundled workflow.
- `FLOW_PARALLEL` is 3, its own constant, beside `FLEET_CONCURRENCY`.
- Ready steps run together only when all but at most one are read-only. A step is read-only when every rule in its `tools` is in the `git-read` or `read` set and its `check` is null or the `@gates` line.
- A manual step parks the flow before it starts: flow `gated`, step `held`, reason `<Step> waits for your go`. `continue` starts it, `stop` ends the flow.
- A trigger, fleet or incubator stage refuses `manual` and `ask` steps before starting a flow, naming the step and whether the workflow file or repo made it manual.
- The modes file is `.canopy/workflows.json`, `{ "modes": { "<workflow>": { "<step>": "manual" | "auto" }, "*": { ... } } }`, read from the main checkout at HEAD. A name that matches no step is a warning, never an error.
- `check fail` is the one condition that makes a failing check not fail the flow. A verdict or judge that says no still parks.
- Every file the UI imports from `src/core/` stays browser-safe: `FlowSheet.tsx` imports `core/flow.ts`, so neither it nor `core/workflow.ts` nor `core/flowmodes.ts` gets a `node:` or `bun` import.
- Strict TypeScript with `noUncheckedIndexedAccess`; no `any`, no `as` casts in the new code.
- Plain words, no em dashes, sentence case headings; commit messages in the repo's `type(scope): summary` form with no backticks.
- All four gates pass before a task is done: `bun run typecheck`, `bun run lint`, `bun test`, `bun run build`.

## Review focus

Inputs the spec implies and no section of it names. Each has a test in the task that owns the code.

1. A stop while two steps' runs are live: both runs are stopped and the flow ends `stopped` only once the second has ended, so a branch's worktree is never read mid-edit (Task 3).
2. A rewind (`retries` with `back`) while a read-only sibling runs: the sibling keeps its run and its owner, and only the steps without a live run are reset (Task 3).
3. A condition on a predecessor that was skipped: `verdict done`, `check pass` and `changed` do not hold, `skipped` and `always` do, so a skipped step never looks like a passed one (Task 4).
4. A tree whose fingerprint cannot be read after a step: `changed` holds and `unchanged` does not, so a step that follows real work is not skipped in silence (Task 4).
5. A held flow restored from disk after a restart: it comes back held with no run started, and `continue` starts the step (Task 5).

---

## File structure

- Modify `src/core/types.ts`: `STEP_WHENS`, `StepWhen`, `STEP_MODES`, `StepMode`; `WorkflowStep.after`, `when`, `mode`, `modeFrom`; `StepStatus` gains `held`; `FlowStep.changed`; the `Flow.current` comment.
- Modify `src/core/workflow.ts` and `src/core/workflow.test.ts`: the three keys and their validation, `READ_ONLY_SETS`, `readOnlyTools`, `readOnlyStep`, `RecordedWorkflow`, `chained`, `unattendedRefusal`, the bundled fixture test.
- Modify `src/core/trigger.test.ts` and `src/core/incubator.test.ts`: their `WorkflowStep` literals take the three keys.
- Modify `ui/src/flows.ts`, `ui/src/flows.test.ts`, `ui/src/feed.ts`, `ui/src/feed.test.ts`, `ui/src/styles.css`: the word, the feed line and the strip's dot for `held`.
- Create `src/core/flowmodes.ts` (pure) and `src/core/flowmodes.test.ts`: `FLOW_MODES_FILE`, `FlowModes`, `parseFlowModes`, `applyModes`.
- Modify `src/core/workflows.ts` and `src/core/workflows.test.ts`: `readFlowModes`.
- Modify `src/core/flow.ts` and `src/core/flow.test.ts`: `FLOW_PARALLEL`, `ready`, `settled`, `whenHolds`, `FlowHooks.fingerprint`, `FlowRecord.workflow` as `RecordedWorkflow`, `startFleet`'s `workflowFor`, the engine's `advance`.
- Modify `src/core/trigger.ts`: `triggerPlan` through `unattendedRefusal`.
- Modify `src/core/incubator.ts`: `launch` refuses a stage nobody could attend.
- Modify `src/server/index.ts`: `withRepoModes`, the flow and fleet routes, `triggerSpec(name, repo)`, the `fingerprint` hook.
- Modify `docs/architecture.md`, `SPEC.md`, `README.md`, `FEATURES.md`, `docs/superpowers/plans/README.md`.

---

### Task 1: the three keys in the parser and the types

**Files:**
- Modify: `src/core/types.ts:1866-1894` (`WORKFLOW_WHENS` through `WorkflowStep`), `:2352` (`StepStatus`), `:2355-2375` (`FlowStep`), `:2385-2392` (`Flow.current`'s comment)
- Modify: `src/core/workflow.ts:117-141` (`step`), `:143-174` (`steps`), `src/core/workflow.test.ts`
- Modify: `src/core/trigger.test.ts:616`, `src/core/incubator.test.ts:27` (step literals)
- Modify: `ui/src/flows.ts:10-18`, `ui/src/flows.test.ts:24-31`, `ui/src/feed.ts:336-342`, `ui/src/feed.test.ts:243-252`, `ui/src/styles.css:8058` (after `.step-seg.st-gated .dot`)

**Interfaces:**
- Consumes: `TOOL_SETS` from `core/actions.ts`; `oneOf`, `keyBlock`, `Bad` in `workflow.ts`.
- Produces in `src/core/types.ts`:

```ts
export const STEP_WHENS = ["always", "verdict done", "verdict partial", "verdict blocked", "judge meets", "judge partly", "judge misses", "check pass", "check fail", "changed", "unchanged", "skipped"] as const;
export type StepWhen = (typeof STEP_WHENS)[number];
export const STEP_MODES = ["auto", "manual"] as const;
export type StepMode = (typeof STEP_MODES)[number];

export interface WorkflowStep {
  // ...the fields as today, then:
  /** the steps this one waits for, by heading: what `after:` names, or the
   *  step above when the line is absent; empty for the first step */
  after: string[];
  /** conditions on the steps it waits for; any one holding lets it run and
   *  none holding skips it; `["always"]` when the line is absent */
  when: StepWhen[];
  /** `manual` parks the flow before the step until a continue */
  mode: StepMode;
  /** set when the repo's `.canopy/workflows.json` decided the mode */
  modeFrom?: "repo";
}
export type StepStatus = "pending" | "running" | "checking" | "gated" | "held" | "passed" | "failed" | "skipped";
export interface FlowStep {
  // ...as today, then:
  /** whether the step's run moved the tree's fingerprint; absent for a
   *  check-only step and when the tree could not be read */
  changed?: boolean;
}
```

`Flow.current`'s comment becomes "index of the step the sheet follows: the newest started, or the one parked or held".

- Produces in `src/core/workflow.ts`:

```ts
export const READ_ONLY_SETS = ["git-read", "read"] as const;
/** every rule in `tools` is in a read-only set */
export function readOnlyTools(tools: readonly string[]): boolean;
/** read-only tools and no check that writes: none, or the `@gates` line
 *  (`GATES_CHECK` in gates.ts, written here so this file stays pure) */
export function readOnlyStep(step: Pick<WorkflowStep, "tools" | "check">): boolean;
/** A workflow as a record from before the graph keys may hold it */
export type RecordedWorkflow = Omit<Workflow, "steps"> & {
  steps: (Omit<WorkflowStep, "after" | "when" | "mode"> & Partial<Pick<WorkflowStep, "after" | "when" | "mode">>)[];
};
/** The chain a workflow ran as before the keys: `after` the step above,
 *  `when` always and `mode` auto on every step that has none */
export function chained(wf: RecordedWorkflow): Workflow;
/** Why no one could attend this workflow unwatched: its first step that
 *  asks, or is manual, named with who made it so; null when every step
 *  runs on its own. `where` reads like "a trigger's run". */
export function unattendedRefusal(wf: Workflow, where: string): string | null;
```

Parse rules, each with the error text the test pins. `after` and `when` are validated in `steps()` beside `back`, where the earlier steps are in hand:
- `after`: split on `,`, trimmed, empties dropped, duplicates dropped. Absent or empty: the step above, or `[]` for the first step. A name no heading has: `step <name>: after names no step called <x>`. Its own: `step <name>: after names itself`. A later heading: `step <name>: after names a later step, <x>`.
- `when`: split and trimmed the same way. Absent or empty: `["always"]`. A word outside `STEP_WHENS`: `step <name>: when must be one of <STEP_WHENS joined by ", ">, not <x>`. An explicit line on a step whose `after` is empty: `step <name>: when needs a step before it to wait on`. `verdict …` with no step in `after` whose gate is `verdict`: `step <name>: when <x> needs a step before it with gate: verdict`; `judge …` the same with `gate: judge`; `check …` with no step in `after` that has a check: `step <name>: when <x> needs a step before it with a check`.
- `mode`: `oneOf(keys.get("mode"), STEP_MODES, \`step ${name}: mode\`, "auto")`.
- `back` is checked as today, and a step may carry `retries`, `back` and `after` together.

`unattendedRefusal` walks the steps in heading order and returns, for the first offender:
- `gate: ask`: `<wf>'s <step> step asks before the next one starts, and no one answers <where>`
- `mode: manual`: `<wf>'s <step> step waits for a go, made manual by <by>, and no one gives one in <where>`, with `<by>` `its workflow file`, or `the repo's .canopy/workflows.json` when `modeFrom` is `repo`.

- [ ] **Step 1: Write the failing tests in `src/core/workflow.test.ts`**

Add after the `listed` describe:

```ts
describe("after, when and mode", () => {
  const graph = (review = "", fix = "", docs = "") =>
    `---\nblurb: b\n---\n\n## Build\ntools: git-read, git-commit\n\nbuild\n\n## Review\ntools: read\ngate: verdict\n${review}\n\nreview\n\n## Fix\nafter: Review\n${fix}\n\nfix\n\n## Docs\nafter: Build\ntools: read\n${docs}\n\ndocs\n`;

  test("reads the keys, and writes the chain out where a step has none", () => {
    const e = parseWorkflow(graph("", "when: verdict partial, verdict blocked\nmode: manual"), meta);
    if (!e.ok) throw new Error(e.error);
    expect(e.workflow.steps.map((s) => s.after)).toEqual([[], ["Build"], ["Review"], ["Build"]]);
    expect(e.workflow.steps.map((s) => s.when)).toEqual([["always"], ["always"], ["verdict partial", "verdict blocked"], ["always"]]);
    expect(e.workflow.steps.map((s) => s.mode)).toEqual(["auto", "auto", "manual", "auto"]);
    expect(e.workflow.steps[2]).not.toHaveProperty("modeFrom");
  });

  test("after is trimmed and deduped", () => {
    const e = parseWorkflow(`---\nblurb: b\n---\n\n## A\n\na\n\n## B\n\nb\n\n## C\nafter: A ,, B, A\n\nc\n`, meta);
    if (!e.ok) throw new Error(e.error);
    expect(e.workflow.steps[2]?.after).toEqual(["A", "B"]);
  });

  test.each<[string, string]>([
    [graph("", "after: Nope"), "step Fix: after names no step called Nope"],
    [graph("", "after: Fix"), "step Fix: after names itself"],
    [graph("", "after: Docs"), "step Fix: after names a later step, Docs"],
    [graph("", "when: sometimes"), "step Fix: when must be one of always, verdict done, verdict partial, verdict blocked, judge meets, judge partly, judge misses, check pass, check fail, changed, unchanged, skipped, not sometimes"],
    [graph("", "", "when: verdict done"), "step Docs: when verdict done needs a step before it with gate: verdict"],
    [graph("", "when: judge meets"), "step Fix: when judge meets needs a step before it with gate: judge"],
    [graph("", "when: check fail"), "step Fix: when check fail needs a step before it with a check"],
    [graph("", "mode: sometimes"), "step Fix: mode must be one of auto, manual, not sometimes"],
    [`---\nblurb: b\n---\n\n## A\nwhen: always\n\na\n`, "step A: when needs a step before it to wait on"],
  ])("refuses %s", (text, error) => {
    const e = parseWorkflow(text, meta);
    expect(e.ok).toBe(false);
    if (!e.ok) expect(e.error).toBe(error);
  });

  test("retries, back and after go together", () => {
    const e = parseWorkflow(graph("", "after: Review\nretries: 1\nback: Build"), meta);
    expect(e.ok).toBe(true);
  });

  test("every bundled workflow and the example are chains", async () => {
    const dir = join(import.meta.dir, "../../lib/workflows");
    const files = (await readdir(dir)).filter((n) => n.endsWith(".md")).map((n) => join(dir, n));
    files.push(join(import.meta.dir, "../../docs/workflows/example-update-deps.md"));
    for (const file of files) {
      const e = parseWorkflow(await readFile(file, "utf8"), { name: "x", source: "bundled", file });
      if (!e.ok) throw new Error(`${file}: ${e.error}`);
      const names = e.workflow.steps.map((s) => s.name);
      expect(e.workflow.steps.map((s) => s.after)).toEqual(names.map((_, i) => (i === 0 ? [] : [names[i - 1]])));
      expect(e.workflow.steps.every((s) => s.when.length === 1 && s.when[0] === "always" && s.mode === "auto")).toBe(true);
    }
  });
});

describe("readOnlyTools and readOnlyStep", () => {
  const t = (line: string) => {
    const e = parseWorkflow(`---\nblurb: b\n---\n\n## A\ntools: ${line}\n\na\n`, meta);
    if (!e.ok) throw new Error(e.error);
    return e.workflow.steps[0]!.tools;
  };
  test("the read-only sets, and nothing else", () => {
    expect(readOnlyTools(t("git-read"))).toBe(true);
    expect(readOnlyTools(t("read"))).toBe(true);
    expect(readOnlyTools(t("git-read, read"))).toBe(true);
    expect(readOnlyTools(t("bun"))).toBe(false);
    expect(readOnlyTools(t("git-commit"))).toBe(false);
    expect(readOnlyTools(t("git-push"))).toBe(false);
    expect(readOnlyTools(t("read, Bash(ls:*)"))).toBe(false);
    expect(readOnlyTools(t("Edit"))).toBe(false);
  });
  test("a check that is not the gates line makes a step a writer", () => {
    expect(readOnlyStep({ tools: t("read"), check: null })).toBe(true);
    expect(readOnlyStep({ tools: t("read"), check: GATES_CHECK })).toBe(true);
    expect(readOnlyStep({ tools: t("read"), check: "bun test" })).toBe(false);
    expect(readOnlyStep({ tools: t("bun"), check: null })).toBe(false);
  });
});

test("chained fills the keys an old record lacks and leaves the rest", () => {
  const e = parseWorkflow(SHIP, meta);
  if (!e.ok) throw new Error(e.error);
  const old: RecordedWorkflow = { ...e.workflow, steps: e.workflow.steps.map(({ after: _a, when: _w, mode: _m, ...s }) => s) };
  expect(chained(old)).toEqual(e.workflow);
  expect(chained(e.workflow)).toEqual(e.workflow);
});

describe("unattendedRefusal", () => {
  const e = parseWorkflow(SHIP, meta);
  if (!e.ok) throw new Error(e.error);
  const ship = e.workflow;
  test("names the first step that asks, or is manual, and who made it so", () => {
    expect(unattendedRefusal(ship, "a trigger's run")).toBe("ship's Push step asks before the next one starts, and no one answers a trigger's run");
    const manual: Workflow = { ...ship, steps: ship.steps.map((s) => (s.name === "Commit" ? { ...s, mode: "manual" } : s)) };
    expect(unattendedRefusal(manual, "an incubator stage")).toBe("ship's Commit step waits for a go, made manual by its workflow file, and no one gives one in an incubator stage");
    const repo: Workflow = { ...ship, steps: ship.steps.map((s) => (s.name === "Commit" ? { ...s, mode: "manual", modeFrom: "repo" } : s)) };
    expect(unattendedRefusal(repo, "a trigger's run")).toBe("ship's Commit step waits for a go, made manual by the repo's .canopy/workflows.json, and no one gives one in a trigger's run");
    const plain: Workflow = { ...ship, steps: ship.steps.map((s) => ({ ...s, gate: "continue" })) };
    expect(unattendedRefusal(plain, "a trigger's run")).toBeNull();
  });
});
```

Import `readdir` beside `readFile`, `GATES_CHECK` from `./gates`, `type Workflow` from `./types`, and `chained`, `readOnlyStep`, `readOnlyTools`, `unattendedRefusal`, `type RecordedWorkflow` from `./workflow`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test src/core/workflow.test.ts`
Expected: FAIL on the new tests; the parser has no `after`.

- [ ] **Step 3: Add the types, the keys, the helpers and the UI's words**

`src/core/types.ts` as the Interfaces block says. `src/core/workflow.ts`: `step()` reads the three raw lines; `steps()` writes `after` out, validates it with `when` beside `back`; the four exports. Update the file's header comment with one sentence on the three keys. Then, so typecheck holds: the `WorkflowStep` literals in `src/core/trigger.test.ts:616` and `src/core/incubator.test.ts:27` gain `after: [], when: ["always"], mode: "auto"`; `STEP_WORD` in `ui/src/flows.ts` gains `held: "waiting for your go"`, and `ui/src/flows.test.ts`'s `stepWord` table gains `["held", "waiting for your go"]`; `ui/src/feed.ts` says `step <name> held<why>` for a `held` step, after the `gated` line, and `ui/src/feed.test.ts`'s flow test adds one assertion: a flow whose second step is `{ name: "push", status: "held", reason: "push waits for your go" }` yields `"step push held: push waits for your go"`; `ui/src/styles.css` gets `.step-seg.st-held .dot { background: var(--lichen); }` after the `st-gated` rule, the same token, no new colour.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test src/core/workflow.test.ts src/core/trigger.test.ts src/core/incubator.test.ts src/core/flow.test.ts ui/src/flows.test.ts ui/src/feed.test.ts && bun run typecheck`
Expected: PASS, typecheck clean. The existing `flow.test.ts` cases pass untouched: the engine still walks `current`.

- [ ] **Step 5: Run the gates and commit**

Run: `bun run typecheck && bun run lint && bun test && bun run build`
Expected: all pass.

```bash
git add src/core/types.ts src/core/workflow.ts src/core/workflow.test.ts src/core/trigger.test.ts src/core/incubator.test.ts ui/src/flows.ts ui/src/flows.test.ts ui/src/feed.ts ui/src/feed.test.ts ui/src/styles.css
git commit -m "feat(workflow): after, when and mode keys in the parser, with the held step status (FR-034)"
```

---

### Task 2: the modes file

**Files:**
- Create: `src/core/flowmodes.ts`, `src/core/flowmodes.test.ts`
- Modify: `src/core/workflows.ts:41-56` (after `loadWorkflows`), `src/core/workflows.test.ts`

**Interfaces:**
- Consumes: `STEP_MODES`, `StepMode`, `Workflow` from `core/types.ts`; `showAtHead(repo, path)` from `core/worktree.ts`.
- Produces in `src/core/flowmodes.ts` (pure, browser-safe):

```ts
export const FLOW_MODES_FILE = ".canopy/workflows.json";
/** `modes[workflow][step]`; the workflow `"*"` is any workflow */
export type FlowModes = Record<string, Record<string, StepMode>>;
/** the file's text as modes, or why it cannot be; a file without `modes` is empty */
export function parseFlowModes(text: string): FlowModes | { error: string };
/** The workflow with the repo's say laid over its steps: `modes[wf.name][step]`
 *  first, else `modes["*"][step]`; a step the repo decided carries
 *  `modeFrom: "repo"`. One warning per entry under `wf.name` that names no
 *  step. The input is left as it was. */
export function applyModes(wf: Workflow, modes: FlowModes): { workflow: Workflow; warnings: string[] };
```

Errors, each naming the file: `.canopy/workflows.json is not JSON: <message>`; `.canopy/workflows.json must be an object`; `.canopy/workflows.json: modes must be an object of workflow names`; `.canopy/workflows.json: modes.<wf> must be an object of step names`; `.canopy/workflows.json: modes.<wf>.<step> must be auto or manual, not <v>`. A warning reads `.canopy/workflows.json: modes.<wf>.<step> names no step of <wf>`. Entries under `"*"` never warn, since a workflow without that step is the normal case.

- Produces in `src/core/workflows.ts` (Bun-only):

```ts
/** The repo's `.canopy/workflows.json` as HEAD holds it, so a branch cannot
 *  change a step's mode on its way in; empty when HEAD has none; throws on
 *  one that is there and wrong, like `readGates`. */
export async function readFlowModes(repoPath: string): Promise<FlowModes>;
```

- [ ] **Step 1: Write the failing tests in `src/core/flowmodes.test.ts`**

```ts
import { describe, expect, test } from "bun:test";
import { applyModes, FLOW_MODES_FILE, parseFlowModes } from "./flowmodes";
import { parseWorkflow } from "./workflow";

const SHIP = `---\nblurb: b\n---\n\n## Gates\ncheck: @gates\n\n## Commit\n\ncommit\n\n## Push\nmode: manual\n\npush\n`;
const ship = () => {
  const e = parseWorkflow(SHIP, { name: "ship", source: "bundled", file: "/ship.md" });
  if (!e.ok) throw new Error(e.error);
  return e.workflow;
};

describe("parseFlowModes", () => {
  test("the shape, and an empty file", () => {
    expect(parseFlowModes('{"modes":{"ship":{"Push":"manual"},"*":{"Deploy":"manual"}}}')).toEqual({ ship: { Push: "manual" }, "*": { Deploy: "manual" } });
    expect(parseFlowModes("{}")).toEqual({});
  });
  test.each<[string, string]>([
    ["[]", `${FLOW_MODES_FILE} must be an object`],
    ['{"modes":[]}', `${FLOW_MODES_FILE}: modes must be an object of workflow names`],
    ['{"modes":{"ship":"manual"}}', `${FLOW_MODES_FILE}: modes.ship must be an object of step names`],
    ['{"modes":{"ship":{"Push":"sometimes"}}}', `${FLOW_MODES_FILE}: modes.ship.Push must be auto or manual, not sometimes`],
  ])("refuses %s", (text, error) => {
    expect(parseFlowModes(text)).toEqual({ error });
  });
  test("not JSON", () => {
    const r = parseFlowModes("{");
    expect("error" in r && r.error.startsWith(`${FLOW_MODES_FILE} is not JSON: `)).toBe(true);
  });
});

describe("applyModes", () => {
  test("the workflow's entry wins over *, the repo's say is marked, and the file's mode can be put back to auto", () => {
    const wf = ship();
    const { workflow, warnings } = applyModes(wf, { ship: { Commit: "manual", Push: "auto" }, "*": { Commit: "auto", Gates: "manual" } });
    expect(workflow.steps.map((s) => [s.mode, s.modeFrom])).toEqual([["manual", "repo"], ["manual", "repo"], ["auto", "repo"]]);
    expect(warnings).toEqual([]);
    expect(wf.steps.map((s) => s.mode)).toEqual(["auto", "auto", "manual"]);
    expect(wf.steps[0]).not.toHaveProperty("modeFrom");
  });
  test("an entry that names no step is a warning, and * never warns", () => {
    const { workflow, warnings } = applyModes(ship(), { ship: { Deploy: "manual" }, "*": { Nowhere: "manual" } });
    expect(warnings).toEqual([`${FLOW_MODES_FILE}: modes.ship.Deploy names no step of ship`]);
    expect(workflow.steps.map((s) => s.mode)).toEqual(["auto", "auto", "manual"]);
  });
  test("no modes leaves the workflow as it was", () => {
    const wf = ship();
    expect(applyModes(wf, {})).toEqual({ workflow: wf, warnings: [] });
  });
});
```

- [ ] **Step 2: Write the failing test in `src/core/workflows.test.ts`**

Make a git repo the way `src/core/worktree.test.ts`'s `repo()` does (`exec(["git", "init", "-q", "-b", "main", dir])` from `./exec`, the identity config, one commit), under a temp dir removed in `afterAll`:

```ts
describe("readFlowModes", () => {
  test("reads the file at HEAD, not the folder; none is empty; a wrong one throws", async () => {
    const dir = await gitRepo();
    expect(await readFlowModes(dir)).toEqual({});
    await commit(dir, ".canopy/workflows.json", '{"modes":{"ship":{"Push":"manual"}}}');
    await writeFile(join(dir, ".canopy", "workflows.json"), '{"modes":{"ship":{"Push":"auto"}}}');
    expect(await readFlowModes(dir)).toEqual({ ship: { Push: "manual" } });
    await commit(dir, ".canopy/workflows.json", "[]");
    await expect(readFlowModes(dir)).rejects.toThrow(".canopy/workflows.json must be an object");
  });
});
```

`gitRepo()` and `commit(dir, file, text)` are this file's own small helpers, written like `worktree.test.ts`'s.

- [ ] **Step 3: Run the tests to verify they fail**

Run: `bun test src/core/flowmodes.test.ts src/core/workflows.test.ts`
Expected: FAIL, `./flowmodes` is not found and `readFlowModes` is not exported.

- [ ] **Step 4: Write `src/core/flowmodes.ts` and `readFlowModes`**

Header comment for `flowmodes.ts`: the file's path and shape, that it is read at HEAD by `readFlowModes` in `workflows.ts`, and that the file is pure. `readFlowModes` is `showAtHead` then `parseFlowModes`, throwing `new Error(error)`.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `bun test src/core/flowmodes.test.ts src/core/workflows.test.ts`
Expected: PASS.

- [ ] **Step 6: Run the gates and commit**

Run: `bun run typecheck && bun run lint && bun test && bun run build`
Expected: all pass.

```bash
git add src/core/flowmodes.ts src/core/flowmodes.test.ts src/core/workflows.ts src/core/workflows.test.ts
git commit -m "feat(workflow): .canopy/workflows.json gives a repo the last word on step modes"
```

---

### Task 3: the ready set, steps side by side, and the flow's end

**Files:**
- Modify: `src/core/flow.ts:33` (constants), `:73-84` (`FlowRecord`), `:114-150` (`FlowHooks`), `:163-184` (`LiveFlow`), `:343-398` (`onRun`), `:400-450` (`resume`), `:474-492` (`pickUp`), `:494-531` (`stop`, `stopped`), `:573-601` (`restoreOne`), `:811-865` (`resetStep` through `summaries`), `:867-943` (`runStep`), `:945-1117` (`afterRun` through `end`); `src/core/flow.test.ts`

**Interfaces:**
- Consumes: Task 1's `readOnlyStep`, `chained`, `RecordedWorkflow` from `./workflow`; `overBudget`, `stepSpec` as they are.
- Produces in `src/core/flow.ts`:

```ts
/** how many steps of one flow run at once */
export const FLOW_PARALLEL = 3;
/** whether step i counts as done for the steps after it: passed, skipped,
 *  or failed on a check that a dependant waits on with `check fail` */
export function settled(flow: Flow, workflow: Workflow, i: number): boolean;
/** the pending steps whose `after` are all settled, in heading order */
export function ready(flow: Flow, workflow: Workflow): number[];
export interface FlowHooks {
  // ...as today, then:
  /** a fingerprint of the tree's git state, read in the repo's path, which
   *  is the worktree on a branch; null when it cannot be read. Taken before
   *  and after each step's run for `when: changed` (Task 4). */
  fingerprint?: (repo: Repo) => Promise<string | null>;
}
export interface FlowRecord {
  // ...as today, but:
  /** the workflow it started with; a record from before the graph keys
   *  lacks them and is replayed as the chain it ran as (`chained`) */
  workflow: RecordedWorkflow;
}
```

`LiveFlow` gains `checking: Map<number, AbortController>` in place of the single controller, `marks: Map<number, string>` for Task 4, and `pending?: { park: number } | { end: "failed" | "stopped"; error?: string }`, a park or an end requested while sibling runs were live. Private methods take the step's index: `runStep(live, i)`, `check(live, i)`, `gate(live, i)`, `park(live, i, reason, as: "gated" | "held" = "gated")`, `fail(live, i, reason)`, `pass(live, i)`, `skip(live, i)` (Task 4), `rewind(live, i, reason)`, `refuse(live, i, reason, otherwise)`; today's `end` body becomes `finish(live, status, error?)`; `advance(live)` is the one pass that moves the flow after any step settles; `liveSteps(live): number[]` is the steps whose status is `running` or `checking`.

The rules, in the order `advance` applies them:
1. A flow that is not active returns.
2. With `live.pending` set: while any step is live, the flow's status follows the live runs (`waiting` when one waits, else `working`) and nothing starts. Once none is live, a `park` makes the flow `gated` with `current` at that step and the clock stopped, and an `end` calls `finish`; `pending` is cleared.
3. Else, a step already `gated` or `held` (a second sibling parked while the first was continued) parks the flow on it: `gated`, `current` there.
4. Else the ready set: each ready step in heading order is skipped when its `when` does not hold (Task 4, `whenHolds`), and the set is taken again until nothing more is skipped.
5. The steps left are started in heading order while fewer than `FLOW_PARALLEL` are live. A step that is not read-only (`readOnlyStep`) starts only when no live step is a writer; otherwise it stays `pending` with `reason` `waits for <the live writer's name> (both change the tree)`, cleared when it starts. A `manual` step is parked as `held` with `<name> waits for your go` (Task 5) instead of started. Before each start with a body, `overBudget` is checked as today: over and no grace parks that step with `parkedFor: "budget"` and ends the pass.
6. When no step is pending, live, gated or held, the flow finishes `done`.
7. `current` moves to each step as it starts, so it ends on the newest.

How the rest changes:
- `onRun` finds the step by `flow.steps.findIndex((s) => s.runId === run.id)`. A run that keeps going updates the clock and the flow's status from every live run, not this one alone. A run that ends `failed` calls `fail(live, i, reason)`; `stopped` sets the step failed with `stopped` and requests `pending = { end: "stopped" }` unless an end is pending already; `done` goes on to `afterRun(live, i)`.
- `park` marks the step and its reason at once, so the sheet shows it, and sets `pending = { park: i }` and `current = i` only when nothing is pending yet; then `advance`. `fail` marks the step `failed` with its reason and sets `pending = { end: "failed", error }` the same way; a stop replaces a pending fail, nothing replaces a stop.
- `pass(live, i)`: the step `passed`, its reason and the flow's `retryReason` dropped, then `advance`.
- `resume` reads the step at `flow.current` as today: `continue` on a `gated` step is `pass`; on a `held` step it is `runStep` (Task 5); `retry` resets and reruns it; `stop` fails it with `stopped at the gate` and finishes `stopped`. The budget and stage branches reset their step and call `advance`.
- `stop`: a gated flow resumes with `stop`; else `pending = { end: "stopped" }`, every live step's run is stopped through the runner, every running check is aborted with the grace timer as today, and with nothing live the flow finishes at once.
- `rewind(live, i, reason)`: the range `to..i` by heading index is reset as today, except steps with a live run, which keep going; then `advance` rather than `runStep`.
- `summaries(live)` lists every `passed` step in heading order.
- `restoreOne` takes `chained(rec.workflow)` as the live workflow; a flow caught mid-step resets every `running` or `checking` step with its session kept, sets `restarted`, and calls `advance`. `pickUp` resets every step failed as `stopped` with its session kept and every `skipped` step to `pending`, then `advance`.
- `start` ends with `advance` in place of `runStep`.
- `record(live)` writes `live.workflow` as today; `FlowRecord.workflow`'s type is the only change there.

A chain reads the same: one ready step at a time, `current` on it, every park at once since nothing else is live.

- [ ] **Step 1: Write the failing tests in `src/core/flow.test.ts`**

In a new `describe("after: the ready set (FR-034)")`, with this fixture beside `TWO`:

```ts
const FAN = wf(`---
name: fan
verb: fan
blurb: b
---

## Build
tools: git-read, git-commit

build

## Lint
after: Build
tools: git-read

lint

## Docs
after: Build
tools: read

docs

## Ship
after: Lint, Docs
tools: git-push

ship
`);
```

```ts
test("two readers run together after their step, and the fan-in waits for both", async () => {
  const { runner, flows } = setup();
  const flow = flows.start(repo(), FAN, "", DEFAULT_AGENT);
  expect(flow.steps.map((s) => s.status)).toEqual(["running", "pending", "pending", "pending"]);
  runner.end("run1", "done", "built");
  await flush();
  expect(flows.get(flow.id)?.steps.map((s) => s.status)).toEqual(["passed", "running", "running", "pending"]);
  expect(flows.get(flow.id)?.current).toBe(2);
  expect(runner.specs.map((s) => s.label)).toEqual(["Build", "Lint", "Docs"]);
  runner.end("run2", "done", "linted");
  await flush();
  expect(flows.get(flow.id)?.steps[3]?.status).toBe("pending");
  runner.end("run3", "done", "documented");
  await flush();
  expect(flows.get(flow.id)?.steps[3]?.status).toBe("running");
  expect(runner.specs[3]?.task).toContain("- Lint: linted\n- Docs: documented");
  runner.end("run4", "done", "shipped");
  await flush();
  expect(flows.get(flow.id)?.status).toBe("done");
  expect(flows.get(flow.id)?.spent?.runs).toBe(4);
});

test("two writers ready together run one after the other, and the waiting one says why", async () => {
  const W = wf(`---\nblurb: b\n---\n\n## A\ntools: git-commit\n\na\n\n## B\nafter: A\ntools: git-commit\n\nb\n\n## C\nafter: A\ntools: git-commit\n\nc\n`);
  const { runner, flows } = setup();
  const flow = flows.start(repo(), W, "", DEFAULT_AGENT);
  runner.end("run1", "done", "a");
  await flush();
  expect(flows.get(flow.id)?.steps.map((s) => s.status)).toEqual(["passed", "running", "pending"]);
  expect(flows.get(flow.id)?.steps[2]?.reason).toBe("waits for B (both change the tree)");
  runner.end("run2", "done", "b");
  await flush();
  expect(flows.get(flow.id)?.steps[2]).toMatchObject({ status: "running" });
  expect(flows.get(flow.id)?.steps[2]?.reason).toBeUndefined();
});

test("a writer runs beside readers, and more than FLOW_PARALLEL ready steps queue in heading order", async () => {
  const many = `---\nblurb: b\n---\n\n## A\ntools: read\n\na\n\n## B\nafter: A\ntools: git-commit\n\nb\n\n## C\nafter: A\ntools: read\n\nc\n\n## D\nafter: A\ntools: read\n\nd\n\n## E\nafter: A\ntools: read\n\ne\n`;
  const { runner, flows } = setup();
  const flow = flows.start(repo(), wf(many), "", DEFAULT_AGENT);
  runner.end("run1", "done", "a");
  await flush();
  expect(FLOW_PARALLEL).toBe(3);
  expect(flows.get(flow.id)?.steps.map((s) => s.status)).toEqual(["passed", "running", "running", "running", "pending"]);
  runner.end("run2", "done", "b");
  await flush();
  expect(flows.get(flow.id)?.steps[4]?.status).toBe("running");
});

test("a sibling that fails lets the other finish, then the flow fails with the first reason and shows both", async () => {
  const { runner, flows } = setup();
  const flow = flows.start(repo(), FAN, "", DEFAULT_AGENT);
  runner.end("run1", "done", "built");
  await flush();
  runner.end("run2", "failed", "", "lint blew up");
  await flush();
  expect(flows.get(flow.id)?.status).toBe("working");
  expect(flows.get(flow.id)?.steps[1]).toMatchObject({ status: "failed", reason: "lint blew up" });
  runner.end("run3", "done", "documented");
  await flush();
  const f = flows.get(flow.id);
  expect([f?.status, f?.error]).toEqual(["failed", "lint blew up"]);
  expect(f?.steps.map((s) => s.status)).toEqual(["passed", "failed", "passed", "skipped"]);
  expect(runner.specs).toHaveLength(3);
});

test("a sibling that parks waits for the other, then the flow parks; continue goes on", async () => {
  const ASKS = wf(FAN_TEXT.replace("## Lint\nafter: Build\ntools: git-read\n", "## Lint\nafter: Build\ntools: git-read\ngate: ask\n"));
  const { runner, flows } = setup();
  const flow = flows.start(repo(), ASKS, "", DEFAULT_AGENT);
  runner.end("run1", "done", "built");
  await flush();
  runner.end("run2", "done", "linted");
  await flush();
  expect(flows.get(flow.id)?.status).toBe("working");
  expect(flows.get(flow.id)?.steps[1]).toMatchObject({ status: "gated", reason: "this step asks before the next one starts" });
  runner.end("run3", "done", "documented");
  await flush();
  expect([flows.get(flow.id)?.status, flows.get(flow.id)?.current]).toEqual(["gated", 1]);
  flows.resume(flow.id, "continue");
  await flush();
  expect(flows.get(flow.id)?.steps.map((s) => s.status)).toEqual(["passed", "passed", "passed", "running"]);
});

test("a stop with two runs live stops both and ends once the second has ended", async () => {
  const { runner, flows } = setup();
  runner.stop = (id) => {
    runner.stopped.push(id);
    const run = runner.runs.get(id);
    if (!run) throw new Error(id);
    return run;
  };
  const flow = flows.start(repo(), FAN, "", DEFAULT_AGENT);
  runner.end("run1", "done", "built");
  await flush();
  flows.stop(flow.id);
  expect(runner.stopped).toEqual(["run2", "run3"]);
  runner.end("run2", "stopped");
  await flush();
  expect(flows.get(flow.id)?.status).toBe("working");
  runner.end("run3", "stopped");
  await flush();
  expect(flows.get(flow.id)?.status).toBe("stopped");
  expect(flows.get(flow.id)?.steps.map((s) => s.status)).toEqual(["passed", "failed", "failed", "skipped"]);
});

test("a rewind leaves a running sibling alone", async () => {
  const R = wf(`---\nblurb: b\n---\n\n## Build\ntools: git-commit\n\nbuild\n\n## Docs\nafter: Build\ntools: read\n\ndocs\n\n## Test\nafter: Build\ncheck: bun test\nretries: 1\nback: Build\n`);
  let calls = 0;
  const { runner, flows } = setup({ check: () => (++calls < 2 ? { exit: 1, output: "fail" } : { exit: 0, output: "ok" }) });
  const flow = flows.start(repo(), R, "", DEFAULT_AGENT);
  runner.end("run1", "done", "built");
  await flush();
  const f = flows.get(flow.id);
  expect(f?.rewinds?.[0]).toMatchObject({ from: "Test", to: "Build" });
  expect(f?.steps[1]).toMatchObject({ status: "running", runId: "run2" });
  expect(f?.steps[0]).toMatchObject({ status: "running", runId: "run3" });
  expect(runner.dismissed).toEqual(["run1"]);
  runner.end("run2", "done", "documented");
  await flush();
  runner.end("run3", "done", "built again");
  await flush();
  expect(flows.get(flow.id)?.status).toBe("done");
});

test("the budget is checked before each start of a fan-out", async () => {
  const B = wf(`---\nblurb: b\nbudget: 2 runs, 9h\n---\n\n## A\ntools: read\n\na\n\n## B\nafter: A\ntools: read\n\nb\n\n## C\nafter: A\ntools: read\n\nc\n`);
  const { runner, flows } = setup();
  const flow = flows.start(repo(), B, "", DEFAULT_AGENT);
  runner.end("run1", "done", "a");
  await flush();
  let f = flows.get(flow.id);
  expect(f?.steps.map((s) => s.status)).toEqual(["passed", "running", "gated"]);
  expect([f?.status, f?.parkedFor, f?.steps[2]?.reason]).toEqual(["working", "budget", "budget spent: 2 runs"]);
  runner.end("run2", "done", "b");
  await flush();
  expect(flows.get(flow.id)?.status).toBe("gated");
  flows.resume(flow.id, "continue");
  await flush();
  f = flows.get(flow.id);
  expect([f?.parkedFor, f?.steps[2]?.status]).toEqual([undefined, "running"]);
});

test("a record from before the keys is replayed as the chain it ran as", () => {
  const old: RecordedWorkflow = { ...TWO, steps: TWO.steps.map(({ after: _a, when: _w, mode: _m, ...s }) => s) };
  const a = setup();
  const flow = a.flows.start(repo(), TWO, "", DEFAULT_AGENT);
  const rec: FlowRecord = { v: 1, flow: structuredClone(flow), repoPath: "/tmp/r", workflow: old, before: "", savedAt: 0 };
  const b = setup();
  b.flows.restore([rec], () => repo(), sameAgent);
  expect(b.flows.get(flow.id)?.steps.map((s) => s.status)).toEqual(["running", "pending"]);
  expect(b.runner.specs).toHaveLength(1);
});

test("a restart reruns every step that was running", () => {
  const a = setup();
  const flow = a.flows.start(repo(), FAN, "", DEFAULT_AGENT);
  a.runner.end("run1", "done", "built");
  const b = setup();
  b.flows.restore([lastRecord(a.saved, flow.id)], () => repo(), sameAgent);
  expect(b.runner.specs.map((s) => s.label)).toEqual(["Lint", "Docs"]);
  expect(b.runner.specs.every((s) => s.task.startsWith(RESTART_NOTE))).toBe(true);
});
```

`FAN_TEXT` is the template string `FAN` is parsed from, kept as a constant so the ask variant can be made from it. Import `FLOW_PARALLEL` from `./flow` and `type RecordedWorkflow` from `./workflow`. The `lastRecord` test needs `await flush()` after the `end` if the record is written asynchronously; keep whichever makes it pass. The `TWO` cases above the new describe stay as they are: they pin a chain.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test src/core/flow.test.ts -t "FR-034"`
Expected: FAIL; after Build only Lint starts, `FLOW_PARALLEL` is not exported.

- [ ] **Step 3: Rewrite the engine around `advance`**

The Interfaces block and the rules above. Rewrite the file's header comment: "Flows: one workflow on one repo, as a graph of steps. Every step is a normal Run through the Runner; steps whose `after` are done start together when all but one of them only read; between a step's run and the next come the check and the gate." The hooks and the public methods keep their names.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test src/core/flow.test.ts src/core/incubator.test.ts src/core/trigger.test.ts && bun run typecheck`
Expected: PASS, every existing case included; typecheck clean.

- [ ] **Step 5: Run the gates and commit**

Run: `bun run typecheck && bun run lint && bun test && bun run build`
Expected: all pass.

```bash
git add src/core/flow.ts src/core/flow.test.ts
git commit -m "feat(flow): steps run as a graph, read-only siblings side by side, the flow ends when every step is done"
```

---

### Task 4: when, skipped steps and the non-fatal check

**Files:**
- Modify: `src/core/flow.ts` (`advance`'s rule 4, `check`, `runStep`, `onRun`, the `whenHolds` and `skip` additions), `src/core/flow.test.ts`

**Interfaces:**
- Consumes: Task 3's `advance`, `settled`, `ready`, `FlowHooks.fingerprint`, `LiveFlow.marks`.
- Produces in `src/core/flow.ts`:

```ts
/** whether step i's `when` holds, from the outcomes of the steps it waits for */
export function whenHolds(flow: Flow, workflow: Workflow, i: number): boolean;
```

A condition holds when it holds on any step in `after`:
- `always`: holds.
- `verdict done | partial | blocked`: that step's `verdict.answers.outcome.choice`.
- `judge meets | partly | misses`: its `judgment.answers.fit.choice`.
- `check pass`: its `check.exit` is 0; `check fail`: it has a `check` and the exit is not 0.
- `changed`: its `changed` is true, or it has a `runId` and `changed` is absent (the tree could not be read, so the work counts). `unchanged`: `changed` is false, or it has no `runId` (skipped, or check-only).
- `skipped`: its status is `skipped`.

`skip(live, i)`: status `skipped`, reason `none of its conditions held: <when joined by ", ">`, no run, no check; `advance` takes the ready set again, since its dependants may now be ready.

`settled` (Task 3) counts a `failed` step as done when some step lists it in `after` with `check fail` in `when`. In `check`, a non-zero exit on such a step, once `rewind` has nothing left, records `step.check`, marks the step `failed` with `check failed with exit <n>` and calls `advance` rather than parking or failing the flow; a flow can then end `done` with that step `failed`.

`changed`: `runStep` takes the fingerprint before the run starts, through `hooks.fingerprint(workRepo(live))` when the hook is set, into `live.marks`; `onRun` on a `done` run reads it again and writes `step.changed` when both reads came back, then drops the mark. A check-only step takes no mark. The marks are live state, not written on the record: a step rerun after a restart takes a fresh one.

- [ ] **Step 1: Write the failing tests in `src/core/flow.test.ts`**

In a new `describe("when: conditions (FR-034)")`:

```ts
const COND = wf(`---
blurb: b
---

## Review
tools: read
gate: verdict

review

## Fix
after: Review
when: verdict partial, verdict blocked
tools: git-commit

fix

## Changelog
after: Fix
when: changed
tools: git-commit

log

## Done
after: Changelog

done
`);
const doneVerdict = (): VerdictAnswers => ({ outcome: { choice: "done" }, needsYou: { probability: 0 }, offScope: { probability: 0 } });
const partialVerdict = (): VerdictAnswers => ({ outcome: { choice: "partial" }, needsYou: { probability: 0 }, offScope: { probability: 0 } });

test("a verdict of done skips Fix, a skipped step counts as unchanged, and Done still runs", async () => {
  const { runner, flows } = setup({ evaluator: async () => doneVerdict() });
  const flow = flows.start(repo(), COND, "", DEFAULT_AGENT);
  runner.end("run1", "done", "reviewed");
  await flush();
  const f = flows.get(flow.id);
  expect(f?.steps.map((s) => s.status)).toEqual(["passed", "skipped", "skipped", "running"]);
  expect(f?.steps[1]?.reason).toBe("none of its conditions held: verdict partial, verdict blocked");
  expect(f?.steps[2]?.reason).toBe("none of its conditions held: changed");
  expect(runner.specs[1]?.task).toContain("- Review: reviewed");
  expect(runner.specs[1]?.task).not.toContain("Fix:");
  runner.end("run2", "done", "finished");
  await flush();
  expect(flows.get(flow.id)?.status).toBe("done");
});

test("a verdict of partial parks as today; continue keeps it, so Fix runs, and changed is read per step", async () => {
  const prints = ["r1", "r1", "f1", "f2", "l1", "l1"];
  const { runner, flows } = setup({ evaluator: async () => partialVerdict(), fingerprint: async () => prints.shift() ?? null });
  const flow = flows.start(repo(), COND, "", DEFAULT_AGENT);
  runner.end("run1", "done", "reviewed");
  await flush();
  expect(flows.get(flow.id)?.status).toBe("gated");
  flows.resume(flow.id, "continue");
  await flush();
  expect(flows.get(flow.id)?.steps[1]?.status).toBe("running");
  runner.end("run2", "done", "fixed");
  await flush();
  expect(flows.get(flow.id)?.steps[1]?.changed).toBe(true);
  expect(flows.get(flow.id)?.steps[2]?.status).toBe("running");
  runner.end("run3", "done", "logged");
  await flush();
  expect(flows.get(flow.id)?.steps[2]?.changed).toBe(false);
  expect(flows.get(flow.id)?.steps[3]?.status).toBe("running");
});

test("a tree that cannot be read counts as changed, and a check-only step as unchanged", async () => {
  const T = wf(`---\nblurb: b\n---\n\n## Work\ntools: git-commit\n\nwork\n\n## Gates\nafter: Work\ncheck: true\n\n## IfChanged\nafter: Work\nwhen: changed\n\nx\n\n## IfSame\nafter: Gates\nwhen: unchanged\n\ny\n\n## IfMoved\nafter: Gates\nwhen: changed\n\nz\n`);
  const { runner, flows } = setup({ fingerprint: async () => null });
  const flow = flows.start(repo(), T, "", DEFAULT_AGENT);
  runner.end("run1", "done", "worked");
  await flush();
  const f = flows.get(flow.id);
  expect(f?.steps[0]?.changed).toBeUndefined();
  expect(f?.steps.map((s) => s.status)).toEqual(["passed", "passed", "running", "running", "skipped"]);
});

test("skipped lets a step run in place of a skipped one, and the other conditions do not hold on it", async () => {
  const S = wf(`---\nblurb: b\n---\n\n## Review\ngate: verdict\n\nreview\n\n## Fix\nafter: Review\nwhen: verdict partial\ncheck: true\n\nfix\n\n## Fallback\nafter: Fix\nwhen: skipped\n\nfb\n\n## Other\nafter: Fix\nwhen: check pass\n\nother\n`);
  const { runner, flows } = setup({ evaluator: async () => doneVerdict() });
  const flow = flows.start(repo(), S, "", DEFAULT_AGENT);
  runner.end("run1", "done", "reviewed");
  await flush();
  expect(flows.get(flow.id)?.steps.map((s) => s.status)).toEqual(["passed", "skipped", "running", "skipped"]);
});

test("check fail with a dependant does not fail the flow: the dependant runs and the flow ends done", async () => {
  const C = wf(`---\nblurb: b\n---\n\n## Build\ntools: git-commit\ncheck: bun test\n\nbuild\n\n## Fix\nafter: Build\nwhen: check fail\ntools: git-commit\n\nfix\n\n## Recheck\nafter: Fix\ncheck: bun test\n`);
  let calls = 0;
  const { runner, flows, checks } = setup({ check: () => (++calls === 1 ? { exit: 1, output: "1 fail" } : { exit: 0, output: "ok" }) });
  const flow = flows.start(repo(), C, "", DEFAULT_AGENT);
  runner.end("run1", "done", "built");
  await flush();
  let f = flows.get(flow.id);
  expect(f?.status).toBe("working");
  expect(f?.steps[0]).toMatchObject({ status: "failed", reason: "check failed with exit 1", check: { exit: 1, output: "1 fail" } });
  expect(f?.steps[1]?.status).toBe("running");
  runner.end("run2", "done", "fixed");
  await flush();
  f = flows.get(flow.id);
  expect(checks).toEqual(["bun test", "bun test"]);
  expect(f?.status).toBe("done");
  expect(f?.steps.map((s) => s.status)).toEqual(["failed", "passed", "passed"]);
});

test("retries come first; the route is taken once they are spent", async () => {
  const C = wf(`---\nblurb: b\n---\n\n## Build\ntools: git-commit\ncheck: bun test\nretries: 1\n\nbuild\n\n## Fix\nafter: Build\nwhen: check fail\n\nfix\n`);
  const { runner, flows } = setup({ check: () => ({ exit: 1, output: "fail" }) });
  const flow = flows.start(repo(), C, "", DEFAULT_AGENT);
  runner.end("run1", "done", "built");
  await flush();
  expect(flows.get(flow.id)?.tries).toEqual({ Build: 1 });
  expect(flows.get(flow.id)?.steps[0]?.status).toBe("running");
  runner.end("run2", "done", "built again");
  await flush();
  expect(flows.get(flow.id)?.steps.map((s) => s.status)).toEqual(["failed", "running"]);
});

test("a condition over several predecessors holds when it holds on one of them", async () => {
  const M = wf(`---\nblurb: b\n---\n\n## A\ncheck: true\n\n## B\ncheck: false\n\n## C\nafter: A, B\nwhen: check fail\n\nc\n`);
  const { runner, flows } = setup({ check: (cmd) => ({ exit: cmd === "false" ? 1 : 0, output: "" }) });
  const flow = flows.start(repo(), M, "", DEFAULT_AGENT);
  await flush();
  expect(flows.get(flow.id)?.steps.map((s) => s.status)).toEqual(["passed", "failed", "running"]);
  runner.end("run1", "done", "c");
  await flush();
  expect(flows.get(flow.id)?.status).toBe("done");
});
```

`setup()` gains a `fingerprint?: (repo: Repo) => Promise<string | null>` option passed through to the hooks. `whenHolds` gets one direct test: a flow whose first step is `skipped` and whose second has `when: ["verdict done"]`, built by hand from `COND`, returns false, and with `when: ["skipped"]` true.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test src/core/flow.test.ts -t "when: conditions"`
Expected: FAIL; Fix runs after any verdict and a failing check fails the flow.

- [ ] **Step 3: Implement `whenHolds`, `skip`, the route and the marks**

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test src/core/flow.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the gates and commit**

Run: `bun run typecheck && bun run lint && bun test && bun run build`
Expected: all pass.

```bash
git add src/core/flow.ts src/core/flow.test.ts
git commit -m "feat(flow): when skips a step, check fail routes to a dependant, changed is read per step"
```

---

### Task 5: manual steps held for a go

**Files:**
- Modify: `src/core/flow.ts` (`advance`'s rule 5, `resume`), `src/core/flow.test.ts`

**Interfaces:**
- Consumes: Task 3's `park(live, i, reason, as)`, `advance`; `WorkflowStep.mode` from Task 1.
- Produces: nothing new is exported. `advance` parks a ready `manual` step as `held` with `<name> waits for your go` before any run; `resume`'s `continue` on a `held` step at `flow.current` resets nothing and calls `runStep(live, i)`, `retry` does the same, `stop` fails it with `stopped at the gate` and finishes `stopped`. A held step is a park: while a sibling run is live it waits in `pending` like any other.

- [ ] **Step 1: Write the failing tests in `src/core/flow.test.ts`**

In a new `describe("mode: manual (FR-034)")`:

```ts
const HELD = wf(`---\nblurb: b\n---\n\n## Build\ntools: git-commit\n\nbuild\n\n## Review\nafter: Build\nmode: manual\ntools: read\n\nreview\n\n## Ship\nafter: Review\n\nship\n`);

test("a manual step holds the flow before it runs; continue starts it", async () => {
  const { runner, flows } = setup();
  const flow = flows.start(repo(), HELD, "", DEFAULT_AGENT);
  runner.end("run1", "done", "built");
  await flush();
  const f = flows.get(flow.id);
  expect([f?.status, f?.current]).toEqual(["gated", 1]);
  expect(f?.steps[1]).toMatchObject({ status: "held", reason: "Review waits for your go" });
  expect(runner.specs).toHaveLength(1);
  flows.resume(flow.id, "continue");
  await flush();
  expect(flows.get(flow.id)?.steps[1]).toMatchObject({ status: "running", runId: "run2" });
  expect(flows.get(flow.id)?.steps[1]?.reason).toBeUndefined();
  runner.end("run2", "done", "reviewed");
  await flush();
  expect(flows.get(flow.id)?.steps[2]?.status).toBe("running");
});

test("stop at a hold ends the flow, and retry is a continue", async () => {
  const a = setup();
  const fa = a.flows.start(repo(), HELD, "", DEFAULT_AGENT);
  a.runner.end("run1", "done", "built");
  await flush();
  a.flows.resume(fa.id, "stop");
  expect(a.flows.get(fa.id)?.status).toBe("stopped");
  expect(a.flows.get(fa.id)?.steps.map((s) => s.status)).toEqual(["passed", "failed", "skipped"]);
  expect(a.flows.get(fa.id)?.steps[1]?.reason).toBe("stopped at the gate");
  const b = setup();
  const fb = b.flows.start(repo(), HELD, "", DEFAULT_AGENT);
  b.runner.end("run1", "done", "built");
  await flush();
  b.flows.resume(fb.id, "retry");
  await flush();
  expect(b.flows.get(fb.id)?.steps[1]?.status).toBe("running");
});

test("a hold while a sibling runs waits for it", async () => {
  const H = wf(`---\nblurb: b\n---\n\n## Build\n\nbuild\n\n## Review\nafter: Build\nmode: manual\ntools: read\n\nreview\n\n## Docs\nafter: Build\ntools: read\n\ndocs\n`);
  const { runner, flows } = setup();
  const flow = flows.start(repo(), H, "", DEFAULT_AGENT);
  runner.end("run1", "done", "built");
  await flush();
  expect(flows.get(flow.id)?.status).toBe("working");
  expect(flows.get(flow.id)?.steps.map((s) => s.status)).toEqual(["passed", "held", "running"]);
  runner.end("run2", "done", "documented");
  await flush();
  expect([flows.get(flow.id)?.status, flows.get(flow.id)?.current]).toEqual(["gated", 1]);
});

test("a held flow restored from disk comes back held, and continue starts the step", async () => {
  const a = setup();
  const flow = a.flows.start(repo(), HELD, "", DEFAULT_AGENT);
  a.runner.end("run1", "done", "built");
  await flush();
  const b = setup();
  b.flows.restore([lastRecord(a.saved, flow.id)], () => repo(), sameAgent);
  expect(b.flows.get(flow.id)?.status).toBe("gated");
  expect(b.flows.get(flow.id)?.steps[1]?.status).toBe("held");
  expect(b.runner.specs).toHaveLength(0);
  b.flows.resume(flow.id, "continue");
  await flush();
  expect(b.runner.specs[0]?.label).toBe("Review");
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test src/core/flow.test.ts -t "mode: manual"`
Expected: FAIL; Review starts on its own.

- [ ] **Step 3: Implement the hold**

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test src/core/flow.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the gates and commit**

Run: `bun run typecheck && bun run lint && bun test && bun run build`
Expected: all pass.

```bash
git add src/core/flow.ts src/core/flow.test.ts
git commit -m "feat(flow): a manual step holds the flow for a go, and continue starts it"
```

---

### Task 6: the refusal, and the modes at every start

**Files:**
- Modify: `src/core/trigger.ts:560-573` (`triggerPlan`), `src/core/trigger.test.ts:615-631`
- Modify: `src/core/incubator.ts:1108-1134` (`launch`), `src/core/incubator.test.ts` (the `answers` describe at `:774`)
- Modify: `src/core/flow.ts:622-651` (`startFleet`), `:729-743` (`startPending`), `src/core/flow.test.ts` (the `fleets` describe at `:458`)
- Modify: `src/server/index.ts:32` (the git import), `:1258-1278` (`triggerSpec`), `:1292` (its call), `:1356-1362` (beside `stepProfileRefusal`), `:3722-3728` (the fleet route), `:4313-4331` (the flow route), `:4852` (the hooks, after `status`)

**Interfaces:**
- Consumes: Task 1's `unattendedRefusal`; Task 2's `readFlowModes`, `applyModes`; `getStatus` from `core/git.ts`; `statusFingerprint` from `core/types.ts`.
- Produces in `src/core/trigger.ts`: `triggerPlan` returns `unattendedRefusal(wf, "a trigger's run")` when it is not null, in place of its `asks` lines; the rest of the function is unchanged.
- Produces in `src/core/incubator.ts`: `launch` parks the sprout with `unattendedRefusal(wf, "an incubator stage")` once `wf` is final and before `flows.start`. A seed's own `.canopy/workflows.json` is never read: a seed may be a stranger's clone, as its `.canopy/workflows/` is never read.
- Produces in `src/core/flow.ts`:

```ts
startFleet(
  repos: Repo[],
  workflow: Workflow,
  note: string,
  agentFor: (repo: Repo, profile?: string) => AgentSettings,
  request?: string,
  /** the workflow each repo runs, with its own modes laid over; a throw
   *  skips the repo with the message as its reason */
  workflowFor: (repo: Repo) => Workflow = () => workflow,
): Fleet;
```

`startPending` calls `lf.workflowFor(repo)` inside its `try`, then `unattendedRefusal(wf, "a fleet's run")` before `this.start`. A refusal throws with that reason, so a manual or asking workflow is skipped without starting a flow, as a broken modes file or busy repo is. Apply this check to the resolved per-repo workflow, after overrides.

- Produces in `src/server/index.ts`:

```ts
/** The workflow with the repo's `.canopy/workflows.json` laid over its steps'
 *  modes, read at HEAD. A broken file is a 400 with its message; an entry
 *  that names no step is logged, since the page shows it only in plan 2. */
async function withRepoModes(repo: Repo, wf: Workflow): Promise<Workflow>;
async function triggerSpec(name: string, repo: Repo): Promise<...the same union...>;
```

- The flow route starts `await withRepoModes(repo, wf)`.
- The fleet route reads each unskipped repo's modes before `startFleet`, into a `Map<string, Workflow | string>` by repo id (the string is a broken file's message), and passes `workflowFor` as `(r) => { const w = byRepo.get(r.id); if (typeof w === "string") throw new Error(w); return w ?? wf; }`.
- `triggerSpec` applies `applyModes(wf, await readFlowModes(repo.path)).workflow` before `triggerPlan`; a broken file throws, and `startTriggerRun` fails the event with that message as it does for an unknown workflow.
- The hooks gain `fingerprint: async (repo) => { try { return statusFingerprint(await getStatus(repo.path)); } catch { return null; } }`; `getStatus` joins the import from `../core/git`.

- [ ] **Step 1: Write the failing tests**

In `src/core/trigger.test.ts`'s `triggerPlan` describe:

```ts
test("a manual step is refused, naming the file or the repo", () => {
  expect(triggerPlan(wf([step({ mode: "manual" }), step({ name: "Two" })]))).toBe("sentry-fix's Fix step waits for a go, made manual by its workflow file, and no one gives one in a trigger's run");
  expect(triggerPlan(wf([step({ mode: "manual", modeFrom: "repo" })]))).toBe("sentry-fix's Fix step waits for a go, made manual by the repo's .canopy/workflows.json, and no one gives one in a trigger's run");
});
```

In `src/core/incubator.test.ts`, inside the `answers` describe beside "going on assumptions says so and goes on":

```ts
test("a stage with a manual step parks with the reason, before any flow starts", async () => {
  const w = world();
  w.workflows.set("scout", { ...SCOUT, steps: SCOUT.steps.map((s) => ({ ...s, mode: "manual" })) });
  const s = await asking(w);
  await w.inc.answer(s.id, null);
  await w.inc.idle();
  expect(now(w, s.id).parked).toBe("scout's Clarify step waits for a go, made manual by its workflow file, and no one gives one in an incubator stage");
  expect(w.flows.started.map((x) => x.workflow.name)).toEqual(["clarify"]);
});
```

In `src/core/flow.test.ts`'s `fleets` describe:

```ts
test("a fleet refuses a manual workflow after repo overrides and skips an unreadable modes file", () => {
  const { runner, flows } = setup();
  const a = { ...repo(), id: "a", name: "a" };
  const b = { ...repo(), id: "b", name: "b" };
  const manual: Workflow = { ...TWO, steps: TWO.steps.map((s) => ({ ...s, mode: "manual", modeFrom: "repo" })) };
  const fleet = flows.startFleet([a, b], TWO, "", () => DEFAULT_AGENT, undefined, (r) => {
    if (r.id === "b") throw new Error(".canopy/workflows.json must be an object");
    return manual;
  });
  expect(fleet.repos).toEqual([
    { repoId: "a", skipped: `${TWO.name}'s First step waits for a go, made manual by the repo's .canopy/workflows.json, and no one gives one in a fleet's run` },
    { repoId: "b", skipped: ".canopy/workflows.json must be an object" },
  ]);
  expect(runner.specs).toHaveLength(0);
  expect(fleet.repos.every((entry) => entry.flowId === undefined)).toBe(true);
});
```

Add sibling tests with a file-authored manual first step and an `ask` first step. Both leave `runner.specs` empty and put `unattendedRefusal(resolvedWorkflow, "a fleet's run")` on the repo's `skipped` field. A resolved workflow with only automatic steps and no `ask` still starts its first run. Keep the existing automatic-fleet tests.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test src/core/trigger.test.ts src/core/incubator.test.ts src/core/flow.test.ts -t "manual"`
Expected: FAIL on the three new tests.

- [ ] **Step 3: Implement the refusal, `workflowFor`, `withRepoModes` and the wiring**

Update `triggerPlan`'s doc comment: "A step that asks, or waits for a go, is refused, since no one is there." Update `launch`'s neighbour comment the same way.

- [ ] **Step 4: Run the tests and typecheck**

Run: `bun test src/core/trigger.test.ts src/core/incubator.test.ts src/core/flow.test.ts && bun run typecheck && bun run lint`
Expected: PASS, clean.

- [ ] **Step 5: Run the gates and commit**

Run: `bun run typecheck && bun run lint && bun test && bun run build`
Expected: all pass.

```bash
git add src/core/trigger.ts src/core/trigger.test.ts src/core/incubator.ts src/core/incubator.test.ts src/core/flow.ts src/core/flow.test.ts src/server/index.ts
git commit -m "feat(flow): a trigger or stage refuses a manual step, and every start reads the repo's modes at HEAD"
```

---

### Task 7: the docs

**Files:**
- Modify: `docs/architecture.md:11` (the `workflow (...)` and `flow (class \`Flows\`...)` paragraphs of the `src/core` section), `:17` (the "Workflows and flows" paragraph), `:112` (the incubator's sentence "Stages load workflows from the bundled and user sources only"), `:182` (the sentence "A step that asks before the next one starts is refused, since no one answers")
- Modify: `SPEC.md:58`, `README.md:224-233`, `FEATURES.md:65-68` and `:128`, `docs/superpowers/plans/README.md`, this plan's Status line

**Interfaces:**
- Consumes: the completed interfaces from Tasks 1 to 6, the source spec, and the live-check results.
- Produces: documentation and feature status that describe the implemented scope, with later phases still marked open. No new runtime interface.

- [ ] **Step 1: `docs/architecture.md`**

In the `src/core` section's `workflow (...)` paragraph, after the `evidence` clause: one sentence on the three keys, `after` written out as the step above, the `when` grammar, the parse errors naming both steps, `readOnlyStep`, `chained` for old records and `unattendedRefusal`; then one sentence on `flowmodes.ts` (`parseFlowModes`, `applyModes`, `modeFrom`, the `*` entry, warnings) and `readFlowModes` in `workflows.ts` reading it at HEAD. In the `flow (class \`Flows\`...)` paragraph, replace "one Run per workflow step through the pure `stepSpec`" with the graph: `advance` as the one pass, `ready` and `settled`, `FLOW_PARALLEL` and the one-writer rule with `waits for <step> (both change the tree)`, `whenHolds` and `skipped` with its reason, `check fail` as the one non-fatal check, `changed` per step through the `fingerprint` hook, `held` and `<step> waits for your go`, a park or failure applied when the last live run ends, `current` as the newest started or the parked step, a restart rerunning every live step, and `FlowRecord.workflow` as `RecordedWorkflow`. In line 17, after the `resume` clause: "`continue` on a `held` step starts it". At line 112, after "never a seed's own `.canopy/workflows/`": "nor its `.canopy/workflows.json`; a stage with an `ask` or `manual` step parks the sprout with `unattendedRefusal`'s line". At line 182, replace the sentence with: "A step that asks, or is manual by its file or the repo's `.canopy/workflows.json`, is refused through `unattendedRefusal`, since no one is there; the repo's modes are read at HEAD in `triggerSpec` before the plan is made."

In the fleet paragraph, describe `workflowFor` applying each repo's modes and `unattendedRefusal` skipping an unattended manual or asking workflow before any run starts.

- [ ] **Step 2: `SPEC.md`**

Line 58: add `.canopy/workflows.json` ("which workflow steps a person releases by hand in this repo, read at HEAD") to the in-repo list after `.canopy/workflows/`.

- [ ] **Step 3: `README.md`**

In the step keys table after the `gate` row, three rows:

```
| `after` | the steps this one waits for, comma-separated earlier headings; steps whose `after` are all done run together when all but one of them only read | the step above |
| `when` | conditions on the steps it waits for, comma-separated; any one holding runs the step and none skips it: `always`, `verdict done`, `verdict partial`, `verdict blocked`, `judge meets`, `judge partly`, `judge misses`, `check pass`, `check fail`, `changed`, `unchanged`, `skipped` | `always` |
| `mode` | `manual` parks the flow before the step until you continue; `auto` starts it as soon as it is ready | `auto` |
```

After the paragraph that ends "without it, a `verdict` gate behaves like `ask`", one paragraph: a step's `check fail` with a dependant that waits on it with `when: check fail` records the check and goes on instead of failing the flow; `.canopy/workflows.json` (`{"modes": {"ship": {"Push": "manual"}, "*": {"Deploy": "manual"}}}`), read from the last commit, overrides a step's `mode` for that repo, `*` for any workflow; a trigger, fleet or incubator stage refuses a workflow with an `ask` or `manual` step before starting it, naming the step and the source of a manual mode; a fleet records the refusal as that repo's skipped reason and continues with eligible repos.

- [ ] **Step 4: `FEATURES.md` and the plans README**

Move the `### FR-034` block from `## Open` to the top of `## In Progress`. Record plan 1 as implemented locally 2026-10-27, with combined batch verification and live checks pending. Keep plans 2 and 3 open and the Shipped column empty. The coordinator owns the merged full-suite/build run, live check and final status; this documentation task does not mark the work shipped or deployed.

- [ ] **Step 5: Run every gate**

Run: `bun run typecheck && bun run lint && bun test && bun run build`
Expected: all pass. Then `~/.claude/skills/verify-build/clean-rebuild.sh verify "waiting for your go"` proves the served bundle is the new one.

- [ ] **Step 6: Commit**

```bash
git add docs/architecture.md SPEC.md README.md FEATURES.md docs/superpowers/plans/README.md docs/superpowers/plans/2026-10-26-workflow-graph-1.md
git commit -m "docs(workflow): architecture, SPEC, README and the feature list for FR-034 plan 1"
```

---

## Live check, before the branch is called done

With a scratch canopy (the "Scratch canopy server for UI checks" memory note) pointed at a throwaway repo with one commit, and this file at `<scratch config>/workflows/graph-try.md`:

```
---
blurb: tries the graph keys
---

## Build
tools: git-read, git-commit

Add a line to notes.md and commit it.

## Lint
after: Build
tools: read

Say in one line whether notes.md reads well.

## Docs
after: Build
tools: read

Say in one line what notes.md is about.

## Ship
after: Lint, Docs
mode: manual
tools: git-read

Say that the branch is ready.
```

1. Start `graph-try` from the repo's menu. After Build, the strip shows Lint and Docs running at once, then Ship `held` with "Ship waits for your go" in the sheet; continue starts it; the flow ends done with every step passed.
2. Commit `.canopy/workflows.json` in the repo as `{"modes": {"graph-try": {"Lint": "manual"}}}` and start again: the flow holds before Lint while Docs runs, then shows the hold; stop ends it with Lint failed "stopped at the gate".
3. Commit `.canopy/workflows.json` as `[]`: `POST /api/repos/flow?id=<repo>` with `{"workflow": "graph-try"}` answers 400 with ".canopy/workflows.json must be an object".
4. `canopy ship` on a repo with no modes file runs as it did: Gates, then Commit, then Push, one at a time.

## Decisions this plan makes beyond the spec

- `after` is written out at parse time as the step above when the line is absent, and `when` as `["always"]`, so the engine and plan 2's picture read one shape; `chained` gives a record from before the keys the same. An explicit `when:` on the first step is the error, not the default.
- A condition over several predecessors holds when it holds on any one of them, and the parse-time gate check asks for one predecessor with that gate or check.
- `changed` holds on a predecessor that ran and whose tree could not be fingerprinted, so a step that follows real work is not skipped in silence; a skipped or check-only predecessor counts as unchanged.
- A verdict or judge that says no still parks, as the spec's call 4 keeps `check fail` the one non-fatal outcome; `when: verdict partial` routes after the continue.
- A step whose failing check was routed keeps status `failed` with its reason, and the flow can end `done` with it, since the dependant was the plan for that failure.
- A park, hold or failure while a sibling's run is live is written on the step at once and applied to the flow when the last live run ends; a stop stops every live run and ends when the last has. A rewind resets its range except steps with a live run.
- Fleets take each repo's modes through `startFleet`'s `workflowFor` and refuse a manual or asking workflow before starting it, as the spec requires for unattended flows. A skipped repo carries the refusal, while other repos whose resolved workflow is automatic can run.
- The incubator reads no seed's `.canopy/workflows.json`, as it reads no seed's `.canopy/workflows/`.
- Call 6: `FLOW_PARALLEL` stays its own constant, 3, as the spec keeps it. Call 7: the flow's outcome is read at the end as today; `when: unchanged` does not set it early.
- The modes file's warnings are logged in plan 1; plan 2 puts them on the page.
- Per-step fingerprints are live state, not written on the record; a step rerun after a restart takes a fresh mark.
- `FlowRecord.workflow` is typed `RecordedWorkflow`, since a record on disk may hold the old shape.
- `graph` on `WorkflowEntry` waits for plan 2; the steps carry the keys, and the API has nothing to add until the page reads it.
- `StepStatus` already had `skipped` for the steps an end leaves behind; a step skipped by `when` reuses it with a reason naming the conditions, and `pickUp` resets both kinds to `pending`, as it does today.
- Implementation ruling, 2026-10-27: Task 6's unattended refusal required two narrow exceptions to the unchanged-tests constraint. The fleet-slot fixture now parks at a verdict gate without an evaluator; the fleet-idempotency fixture uses a local automatic copy of TWO. All original slot, count and idempotency assertions remain, and explicit ask/manual refusal tests cover the new rule.
- Review added per-attempt identities across asynchronous preparation, checks and gates, plus per-step park causes and optional pending terminal intent in `FlowRecord`. Reset reconciles parked state; stop cancels preparation barriers. A working record with pending failure or stop ends with that intent after restart without new work.
- Server flow/fleet starts and startup restore await `whenStarted`, which covers only pre-start preparations. Work adoption precedes flow restore; active branch flows own their work item before a Run exists. Policy-read errors become individual trigger-rule problems, while direct starts still reject malformed modes.
