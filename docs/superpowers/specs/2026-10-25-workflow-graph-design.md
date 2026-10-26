# Workflow graph: parallel, conditional and manual steps (FR-034)

FR-034 asks for canopy's workflows to say more than "this step, then the
next": a step that waits on two earlier ones, a step that runs only when the
one before it changed something, a step a repo wants a person to release by
hand while the rest run on their own, and a picture of all that on the flow
sheet. The idea comes from three places the software-factory survey of
2026-10-25 turned up: OpenAI's Symphony keeps its policy in a version-
controlled `WORKFLOW.md` (github.com/openai/symphony); Fabro writes a
workflow as a Graphviz DOT graph of agent, command, conditional, parallel
and human-gate nodes with verification nodes layered in
(github.com/fabro-sh/fabro); Mastra Factory's board sets each stage to
manual or auto (github.com/mastra-ai/softwarefactory-template). canopy
already has the engine. What it lacks is the three edges that are not "next",
the per-repo switch, and the drawing. Ranked third in
`2026-10-25-software-factory-borrowings-design.md`.

## Where things stand (2026-10-25)

- **A workflow is a chain.** `parseWorkflow` (`src/core/workflow.ts`) reads
  frontmatter and one `##` per step with a key block: `tools`, `turns`,
  `check`, `gate` (`GATE_KINDS`: `continue`, `ask`, `verdict`, `judge`),
  `retries`, `back`, `evidence`, `agent`. `steps()` keeps the heading order
  and `Flow.current` is an index into it. `pass()` (`src/core/flow.ts`) goes
  to `current + 1`; `back:` is the only edge that is not "next", and it may
  only point at this step or an earlier one.
- **The gate decides, the step never.** `gate()` runs after the step's run
  and its `check`: `continue` passes, `ask` parks with "this step asks before
  the next one starts", `verdict` and `judge` ask Jev (`src/core/jev.ts`)
  and park when the gateway key is missing or the answer says no. A park is
  `FlowStatus` `gated` with `FlowStep.reason`, and `POST /api/flows/resume
  {id, choice}` takes `FlowChoice` `continue | retry | stop`.
- **No conditions.** A step always runs. The only way to skip work is a
  check-only step whose command exits 0.
- **No parallel.** One step's run at a time per flow; `Flows.start` locks the
  checkout (`activeFor`) unless the flow is on a branch (`Flow.branch`, a
  trigger's flow), where every step runs in the one worktree.
- **Triggers refuse `ask`.** `triggerPlan` (`src/core/trigger.ts`) returns a
  refusal string for a workflow with an `ask` step, since nobody answers an
  unattended flow.
- **Workflows come from three folders**, bundled, user and repo
  (`src/core/workflows.ts`), later winning by name; a trigger or fleet takes
  bundled and user only. Workflow files are sensitive under review rules
  (`lib/workflows/**`, `.canopy/workflows/**`), so a branch run cannot
  rewrite the flow that lands it.
- **The sheet is a strip.** `StepStrip` in `ui/src/components/FlowSheet.tsx`
  draws the steps in a row with the current one marked; `FlowConsole` shows
  the picked step's run. There is no `canopy workflow` command; the CLI
  starts flows through the API (`POST /api/repos/flow?id=`), and
  `GET /api/repos/workflows?id=` lists a repo's entries.

## The three new keys

The file stays markdown with one `##` per step. Three keys join the step's
block. Every one is optional, and a file that uses none parses and runs as
today.

### `after:` — what a step waits for

```
## Review
after: Build, Docs
tools: git-read, read
```

- `after` names one or more earlier steps, comma-separated. A step without
  `after` waits for the step above it, as now, so old files keep their order.
- The steps form a directed acyclic graph. `back:` is the one edge allowed to
  point backwards, and it still must name this step or an earlier heading.
  A cycle through `after` is a parse error ("step Review: after names a
  later step, Ship").
- Two steps whose `after` sets are both satisfied are **ready together**.
  Whether they run together is the next section's call.
- A step named by nobody's `after` and not followed by a step without
  `after` is a leaf. The flow is done when every leaf is done.
- `Flow.current` stays, as the index of the step the sheet follows. The real
  state moves to `FlowStep.status`, which already exists per step; `pass()`
  marks the step done and starts every step whose `after` is now all done.

### Running ready steps together

The simplest sound answer: **parallel steps run together only when none of
them changes the tree.** Two agents editing one checkout, or one worktree,
race each other, and a fan-in that merges two branches is a merge queue of
its own. canopy has one of those already, the landing queue, and a flow
should not grow a second one.

- A step is **read-only** when its `tools` expand to a subset of the
  read-only sets (`git-read`, `read`, and anything in `TOOL_SETS` that
  writes nothing: `bun` is not, since `bun test` may write) and it has no
  `check` that writes (a `check` line is a shell command, so a check-only
  step counts as read-only only when `check` is a `@gates` line or empty).
- Ready steps run together only when **all but at most one** are read-only.
  The one writing step runs beside the readers, which read the tree as it
  was when they started; a reader that reads a file the writer is editing
  gets whatever is on disk, which is the risk a review step takes today
  when Eric edits during a flow. Two writing steps ready together are run
  one after the other in heading order, and the sheet says "waits for Build
  (both change the tree)".
- `FLOW_PARALLEL` is 3, the same as `FLEET_CONCURRENCY` and
  `BRANCH_RUNS_PER_REPO`. More ready steps queue in heading order.
- Each parallel step is its own `Run` through the Runner, as now. A flow on
  a branch runs them all in the one worktree. A flow in the checkout holds
  the checkout once (`activeFor` counts the flow, not its runs), so the
  one-run-per-repo rule is unchanged from outside.
- `spent.runs` counts every run; the budget check runs before each start,
  so a fan-out of three can take the flow one or two runs past its budget,
  which is the same slack one long run has today (`overBudget`'s comment).
- A step that fails or parks while a sibling runs: the sibling finishes its
  run (nothing stops a Claude turn mid-edit), then the flow parks or fails
  with the first reason, and the sheet shows both.

### `when:` — a condition on a step

```
## Fix
when: verdict partial, verdict blocked
```

```
## Changelog
when: changed
```

- `when` is a comma-separated list of conditions on the steps it waits for
  (its `after` set, or the step above). Any one holding lets the step run;
  none holding **skips** it: `FlowStep.status` `skipped`, no run, no check,
  and its own dependants read it as done.
- The conditions: `verdict done | partial | blocked` (the waited step's
  `Verdict.answers.outcome.choice`), `judge meets | partly | misses`, `check
  pass | fail` (its `check.exit`), `changed` and `unchanged` (the status
  fingerprint before and after that step's run, as `outcome` is read for the
  flow today, taken per step), `skipped` (so a step can run in place of a
  skipped one), and `always` (the default when `when` is absent).
- A condition that names a gate the waited step has not got (`verdict done`
  after a `continue` step) is a parse error; the parser knows every step's
  gate.
- `check fail` is the one condition that makes a failing check **not** fail
  the flow: when some step waits on this step with `when: check fail`, the
  flow records the check and moves on to the dependants rather than parking,
  so "fix, then re-check" reads as two steps with `when`, where today it is
  `retries` and `back`. Both stay; `retries` is still the short way.
- `when` on a step with no predecessor is a parse error.

### `mode:` — manual or auto, and the repo's say

```
## Review
after: Build
mode: manual
```

- `mode: auto` (the default) is what happens today: the step starts as soon
  as its `after` set is done and its `when` holds. `mode: manual` parks the
  flow **before** the step as `gated` with the reason "Review waits for
  your go" and the step `status` `held`; `continue` starts it, `stop` ends
  the flow. This is the same park as `gate: ask`, moved from after a step to
  before one, and it reuses `resume` as is.
- The difference from `gate: ask`: `ask` is the workflow author's word,
  `mode` is the **repo's**. A new file `.canopy/workflows.json`, read from
  the main checkout at `HEAD` like `gates.json` and `review.json`, so a run
  on a branch cannot flip a step to auto on its way in:

```json
{
  "modes": {
    "ship": { "Push": "manual" },
    "spec-converge": { "Fix": "manual" },
    "*": { "Deploy": "manual" }
  }
}
```

  `modes[workflow][step]` overrides the file's `mode`; `"*"` applies to a
  step of that name in any workflow. A name that matches no step is left on
  the page as a warning, not an error, since the user folder's workflow may
  have been renamed. The file is sensitive under review rules (`.canopy/**`
  already is).
- Unattended flows (a trigger's, the incubator's, a fleet's) refuse a
  `manual` step the way `triggerPlan` refuses `ask` today: the refusal names
  the step and whether the file or the repo made it manual. So a repo that
  marks `Deploy` manual stops a scheduled flow from deploying, which is the
  point.

### What stays the same

`check`, `gate`, `retries`, `back`, `evidence`, `budget`, `tools`, `turns`,
`agent`, the frontmatter keys, `expects-change` and the flow's outcome, the
three sources and the sensitive paths. A file with none of the three keys is
a chain and runs exactly as before, which `flow.test.ts`'s existing cases
pin.

## The picture

### On the flow sheet

- `StepStrip` becomes `StepGraph` when the workflow has any `after` or
  `when`: an inline SVG, boxes in columns by depth (the longest `after`
  path from a root), arrows for `after`, a dashed arrow for `back`, a
  small diamond on an arrow for `when` with the condition as its label, and
  a hand glyph on a `manual` step. Colours are the stylesheet's tokens
  through `light-dark()`; nothing is hard-coded, and no library. A chain
  still gets the strip.
- Each box carries the step's state word (`waits`, `held`, `working`,
  `skipped`, `done`, `failed`), and a click picks it for `FlowConsole` as a
  strip click does. Two boxes working at once both pulse.
- The layout is pure: `graphOf(workflow)` in a new `ui/src/flowgraph.ts`
  returns `{ columns: string[][], edges: Edge[] }` and is tested; the
  component only draws. A graph wider than the sheet scrolls sideways; on a
  phone the picture folds under a "graph" disclosure and the strip stays.

### On the command line

- `canopy workflow show <name> [--repo R] [--dot]` prints the graph as text:
  one line per step, indented by depth, with `after`, `when`, `mode` and
  `gate`, and the repo's overrides marked `(repo)`. `--dot` prints Graphviz
  DOT for anyone who wants Fabro's picture; canopy does not render it.
- `canopy workflow check <file>` parses a file and prints its errors, so a
  user-folder workflow can be checked before a flow runs it.
- `canopy workflow list [--repo R]` prints the three sources' entries with
  their problems, which `GET /api/repos/workflows?id=` already returns.

## Routes and events

- `GET /api/repos/workflows?id=` (read) gains `graph` on each ok entry: the
  parsed `after`, `when` and `mode` per step, and `modes`, the repo file's
  overrides as read at `HEAD`, with any warning.
- `POST /api/repos/flow?id=` (operate) is unchanged.
- `POST /api/flows/resume {id, choice}` (operate) is unchanged; `continue`
  on a `held` step starts it.
- The `flow` SSE event carries the steps' new states. `FlowStep.status`
  gains `skipped` and `held`; `Flow.current` follows the newest started
  step, and the sheet reads the graph for the rest.
- The flows lock and `FlowRecord` are unchanged. A record from before this
  spec has no `after`; `FlowRecord.flow.steps` is replayed as a chain, since
  the workflow is copied into the record at start and an old copy has the
  old shape.

## Validation, all at parse time

- `after` names only earlier headings; a later one or an unknown one is an
  error that names both steps.
- No cycle through `after` (headings are ordered, so pointing backwards is
  enough to guarantee this; `back` is excluded from the check).
- `when` only on a step with a predecessor, and only naming gates its
  predecessors have.
- `mode` is `manual` or `auto`.
- A step with `retries` and `after` naming two steps: `back` must still
  name one step, this one or an earlier one, as today.
- A trigger's or incubator's plan refuses `manual` (file or repo) and `ask`.

## Components

- `src/core/workflow.ts`: the three keys, `graph` on `Workflow`, the
  validations, `readOnlyTools`.
- `src/core/types.ts`: `WorkflowStep.after: string[]`, `when: StepWhen[]`,
  `mode: "auto" | "manual"`; `StepStatus` adds `skipped`, `held`;
  `WorkflowEntry` adds `graph`.
- `src/core/flowmodes.ts` (new, pure): read `.canopy/workflows.json`
  (`{modes}`), apply overrides, warnings for unmatched names.
- `src/core/flow.ts`: `ready(flow)` (the steps whose `after` are done and
  `when` hold), `pass()` starting every ready step up to `FLOW_PARALLEL`
  with the read-only rule, `skip()`, the `held` park, per-step status
  fingerprints for `changed`.
- `src/core/trigger.ts` `triggerPlan` and the incubator's plan: refuse
  `manual`.
- `src/server/index.ts`: `GET /api/repos/workflows` reads the modes file at
  `HEAD` (through the same helper `gates.ts` uses).
- `src/cli/workflow.ts` (new): `show`, `check`, `list`.
- `ui/src/flowgraph.ts` (new, pure): `graphOf`, `stateWord`.
- `ui/src/components/FlowSheet.tsx`: `StepGraph`, the phone fold.
- `lib/workflows/`: no bundled file changes in plan 1. `sentry-triage-fix`
  could later read `when: verdict blocked` instead of its retries.

## Calls

Made on 2026-10-25:

1. **Keep markdown, no DOT input.** Fabro's DOT is a fine picture but a poor
   editor for prompts, and every bundled workflow is mostly prose. `--dot`
   is output only.
2. **Parallel only for readers.** One writer at a time per tree. A flow does
   not merge branches; the landing queue does. A workflow that wants two
   writers in parallel is two coordinator cards, not one flow.
3. **`mode` is the repo's, `gate: ask` is the author's.** The override file
   is read at `HEAD` so a branch run cannot loosen it, and unattended flows
   refuse `manual` outright rather than skipping the step.
4. **`when` skips, it does not fail.** A skipped step is done for its
   dependants. The one exception is `check fail` making a check non-fatal,
   because without it a conditional fix step could never be reached.
5. **Chains are untouched.** Every existing file parses to the same graph it
   ran as, and the strip stays for them.

For Eric:

6. Whether `FLOW_PARALLEL` should instead borrow the branch-slot cap
   (`BRANCH_RUNS_PER_REPO`) so a parallel flow on a branch and the
   coordinator's children share one budget for the repo. The spec keeps them
   separate.
7. Whether `when: unchanged` on `expects-change` workflows should also set
   the flow's outcome to "no change" early, or leave the outcome to the end
   as today.

## Out of scope

- Fan-in that merges two writing steps' trees. The landing queue is the
  merge.
- Sub-workflows (a step that runs another workflow). The coordinator covers
  cross-repo composition.
- A graphical editor. The file is the editor.
- Loops other than `retries`/`back`.

## Testing

- `workflow.test.ts`: `after` ordering, unknown and forward names, the cycle
  message, `when` on a root, `when` naming a gate the predecessor lacks,
  `mode` values, a file with none of the keys parsing to the same steps as
  before (fixture: every bundled workflow), `readOnlyTools` for each set.
- `flowmodes.test.ts`: overrides by workflow and `*`, unmatched names as
  warnings, a broken file as an error that holds the flow.
- `flow.test.ts` (fake runner): two readers run together and one writer
  waits; a sibling failing after the other finished; `skipped` making its
  dependants ready; `check fail` with a dependant not parking; `held` then
  `continue` starting the step and `stop` ending the flow; budget counted
  across a fan-out; a `FlowRecord` from before the keys replayed as a chain.
- `trigger.test.ts`: `triggerPlan` refusing a `manual` step with the
  source named (file or repo).
- `ui/src/flowgraph.test.ts`: columns by depth, edges, a chain producing one
  column per step, the state words.
- `cli/workflow.test.ts`: `show` text and `--dot` for a fixture, `check` on
  a broken file exiting 1.

## Plans

1. **Keys and engine**: parser, types, `flow.ts` ready set, `skipped`,
   `held`, the modes file, trigger refusal, tests. Chains unchanged.
2. **Picture and CLI**: `flowgraph.ts`, `StepGraph`, the API's `graph`,
   `canopy workflow show|check|list`.
3. **Bundled workflows** (optional, after both): rewrite
   `sentry-triage-fix` with `when`, and give `ship` a `Docs` reader beside
   `Gates` as the first parallel pair.
