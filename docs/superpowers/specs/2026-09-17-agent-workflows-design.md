# Agent workflows: design

Date: 2026-09-17. Status: approved in brainstorming, awaiting spec review.

## Goal

Turn canopy's one-shot Claude actions into workflows: named, multi-step jobs written as markdown files, run one step at a time through the existing Runner, with a gate between steps, and runnable across many repos at once. Today's commit, push and deploy actions become the first bundled workflows. Two later projects build on this one and are out of scope here: feature request ingestion from several sources into FEATURES.md, and anything Jev does beyond judging a gate.

## What exists

- `src/core/actions.ts`: six hard-coded actions (commit, push, commit-push, deploy, ask, chat), each a prompt, an allowlist and a turn cap, plus `canRun` preconditions, `repoFacts` and the ground rules paragraph.
- `src/core/runner.ts`: spawns `claude -p` with stream-json both ways per run, folds messages into a `Run`, parks on permission and question prompts, answers through `answer()`, keeps a chat open across `say()`, and sets `outcome` from the status fingerprint when the run ends. One active run per repo.
- `ui/src/components/RunSheet.tsx`: pre-flight, the run console, the chat composer. `RunChip` is the card's word. `RepoMenu` lists the actions under "with claude".
- `src/core/agent.ts`, `store.ts`: per-repo agent settings (model, effort, yolo, extra flags) that every launcher reads.
- `src/core/search.ts`: `mapPool`, the bounded fan-out, and `GREP_CONCURRENCY`.
- `~/dev/ai-tools/jev-lab/src/lib/jev.ts`: an evaluator over the Vercel AI Gateway that takes state plus typed questions and returns a probability per option, with retries and a scripted fake for tests. `triage.ts` shows the pattern: questions as a const object, a pure `decide()` with thresholds in one object.

## 1. The workflow file

One markdown file per workflow. Frontmatter is the identity, the body is the steps.

```markdown
---
name: ship
label: ship
verb: ship
blurb: Runs the project's gates, commits what is there, and pushes the branch.
when: dirty-or-unpushed
expects-change: true
---

## Gates
tools: bun
turns: 30
check: bun run typecheck && bun run lint && bun test && bun run build

Run the project's own gates. Fix a failing gate only when the fix is
obvious and inside this repo. Otherwise stop and say what failed.

## Commit
tools: git-read, git-commit
turns: 30
gate: verdict

Task: commit the current changes, so that git status is clean afterwards.
...

## Push
tools: git-read, git-push
turns: 20

Task: push the current branch ...
```

Frontmatter keys:

| key | meaning | default |
| --- | --- | --- |
| `name` | id, unique across the three sources, `[a-z0-9-]+` | file name without `.md` |
| `label` | menu text | name |
| `verb` | confirm button and the flow's title | label |
| `blurb` | one paragraph for the pre-flight | required |
| `when` | precondition: `dirty`, `unpushed`, `dirty-or-unpushed`, `any` | `any` |
| `expects-change` | a flow that leaves status untouched reports "no change" | false |
| `note` | placeholder for the note box; `note-required: true` makes it the task | optional |

Step block: a `##` heading is the step name. The lines right under it that match `key: value` up to the first blank line are the step's keys. The rest of the section is the prompt.

| key | meaning | default |
| --- | --- | --- |
| `tools` | comma-separated: named sets `git-read`, `git-commit`, `git-push`, `bun`, `read`, or literal rules like `Bash(cargo:*)` | `git-read` |
| `turns` | max turns for this step's run | 30 |
| `check` | a shell command run in the repo after the run ends; exit 0 passes | none |
| `gate` | `continue`, `ask`, `verdict` | `continue` |

The named sets expand to the constants that live in actions.ts today. A step whose body is empty is a check-only step: no Claude run, just the command.

Sources, later winning by `name`:

1. bundled: `lib/workflows/*.md` inside canopy
2. user: `$CANOPY_CONFIG_DIR/workflows/*.md`
3. repo: `<repo>/.canopy/workflows/*.md`, local repos only

Parsing is pure and tested in `src/core/workflow.ts` (browser-safe): `parseWorkflow(text, source) -> Workflow | { error }`. Loading is Bun-only in `src/core/workflows.ts`: `loadWorkflows(repo)` reads the three sources and returns the merged list including the broken ones, each carrying `source` and `error`. The menu shows a broken one greyed with the error as its tooltip. Workflows are re-read on every request for the list, so an edit shows on the next menu open; there is no watcher.

## 2. The engine

New Bun-only orchestrator in `src/core/flow.ts`, class `Flows`, with hooks like `RunnerHooks`: `onChange(flow)`, `onGone(id)`, and the Runner it drives. It is built against a small interface of Runner (`start`, `get`, `stop`, and a change callback) so tests use a fake.

Types, in `src/core/types.ts` (browser-safe):

```ts
type FlowStatus = "working" | "waiting" | "gated" | "done" | "failed" | "stopped";
type StepStatus = "pending" | "running" | "checking" | "gated" | "passed" | "failed" | "skipped";

interface FlowStep {
  name: string;
  status: StepStatus;
  runId?: string;
  check?: { command: string; exit: number; output: string };
  verdict?: Verdict;
  /** Claude's closing summary, the last text step of the run */
  summary?: string;
  /** why a gate parked or a step failed, shown in the sheet */
  reason?: string;
}

interface Flow {
  id: string;
  repoId: string;
  workflow: string;
  verb: string;
  fleetId?: string;
  note: string;
  status: FlowStatus;
  steps: FlowStep[];
  current: number;
  startedAt: number;
  endedAt?: number;
  outcome?: "changed" | "unchanged";
}
```

Life of a flow:

1. `start(repo, workflow, note, agent)` refuses when the repo has an active run or flow. It fingerprints status, marks step 0 running and starts a Run.
2. A step's Run gets an `ActionSpec` built by the pure `stepSpec(workflow, index, note, summaries)`: prompt = ground rules + repo facts + the user's note + "Earlier steps:" with each earlier step's name and summary + the step body. Allowed tools and turns from the step keys. The spec's verb is `<workflow verb> · <step name>`, which is what the chip shows.
3. When the Run ends (`done`), the flow reads the last text step as the summary, runs `check` if any through `onHost` in the repo, then the gate. A Run that ends `failed` or `stopped` fails or stops the flow.
4. Gate result: continue starts the next step; park sets the flow `gated` with the reason; the last step passing ends the flow `done` with `outcome` from the fingerprint when the workflow expects change.
5. `resume(id, "continue" | "retry" | "stop")` on a gated flow. Continue accepts the step as it stands. Retry runs the same step again with the gate's reason appended to its prompt, replacing the step's run; the summaries of earlier steps are unchanged. Stop ends the flow. (Brainstorming said skip; a step has already run by the time its gate parks, so retry is the useful third choice. `skipped` remains a step status for a fleet's precondition skips and for the steps after a stop.)
6. `stop(id)` stops the current Run and the flow. `dismiss(id)` drops a finished flow, and drops its Runs from the Runner.
7. `flow` events broadcast the whole Flow on every change, `flow-gone` on dismiss. The step's Run still broadcasts as a `run`, so the console component is unchanged.

Flow `waiting` mirrors the Run's `waiting`: the Run's prompt is where the answer goes, through the existing `/api/runs/answer`.

Runner change: `start(repo, spec: ActionSpec, note, agent)` instead of an action name, with `Run.action` becoming a plain string used for the chip and the sheet title (`ask`, `chat`, or the step's verb). `EXPECTS_CHANGE` and `PROGRESS` move onto the spec as `expectsChange` and `progress`. The busy check in Runner counts both.

## 3. Gates

The `check` runs first on every step that has one, whatever the gate. It runs through `onHost` with the repo as cwd, output capped like stderr is in the runner. Exit zero passes; anything else fails the step and the flow, with the output in the step for the sheet.

Then the gate:

- `continue`: next step.
- `ask`: park with the summary and continue, retry and stop buttons.
- `verdict`: the evaluator gets a state made of the summary, the check output if any, and one line saying whether status changed. Questions, in `src/core/verdict.ts` (browser-safe, pure):

```ts
const verdictQuestions = {
  outcome: { type: "choice", instructions: "Did the step finish its task?",
    criteria: {
      done: "The task is complete and the summary reports what was done",
      partial: "Some of the task was done and the rest was left, deferred, or explained away",
      blocked: "Nothing or almost nothing was done because of an error, a conflict, or a missing decision",
    } },
  needsYou: { type: "boolean", instructions: "Does the summary ask the user to decide or check something?" },
  offScope: { type: "boolean", instructions: "Did the step touch anything outside the repository or beyond what the task asked?" },
} as const;
```

`decide(answers) -> { go: true } | { go: false; reason }` with `THRESHOLDS` in one object: continue only when outcome is `done` with probability at or above 0.7, needsYou below 0.5 and offScope below 0.5. Anything else parks with a one-line reason built from the failing answer. The `Verdict` stored on the step carries the answers and the decision, so the sheet can show the bars the way jev-lab's inspector does.

`src/core/jev.ts` is the evaluator ported from jev-lab: `ai` and `@ai-sdk/gateway` as dependencies, key from `AI_GATEWAY_API_KEY` or `VERCEL_AI_GATEWAY_API_KEY`, three short attempts. `Flows` takes an `Evaluator | null`; null (no key) makes every `verdict` gate behave as `ask`, and the pre-flight says so in one line. A gateway error at gate time also falls back to ask, with the error as the reason.

## 4. Fleet

```ts
interface Fleet {
  id: string;
  workflow: string;
  verb: string;
  note: string;
  /** every repo it was given, with why the skipped ones were skipped */
  repos: { repoId: string; flowId?: string; skipped?: string }[];
  status: "working" | "done" | "stopped";
  startedAt: number;
  endedAt?: number;
}
```

`Flows.startFleet(repos, workflow, note, agentFor)` filters through the workflow's `when` and the repo's readability and forge status, records the skipped ones with the reason, and starts flows up to `FLEET_CONCURRENCY` (3). As a flow ends, the next pending repo starts. A flow parked on a gate or a prompt still counts against the cap, so a fleet of questions cannot fan out past three at a time. `stopFleet(id)` stops the running flows and drops the pending ones. The fleet ends when every flow has ended.

Pre-flight for a fleet lists the repos that will run and the skipped ones grouped by reason. The fleet sheet shows one row per repo with a chip (pending, the step name, gated, waiting, done, failed, skipped), the oldest parked flow's prompt or gate in a strip at the top, and, once all have ended, one line per repo: outcome and the first sentence of the last summary. Clicking a row opens that flow's sheet.

`fleet` and `fleet-gone` events, same shape as flows.

## 5. UI and API

Routes:

- `GET /api/repos/workflows?id=` the merged list for one repo, broken ones included with `error`
- `POST /api/repos/flow?id=` `{workflow, note}` starts one, 201 with the Flow; 400 for a forge repo, a broken workflow, or a busy repo
- `GET /api/flows`, `POST /api/flows/resume {id, choice}`, `POST /api/flows/stop {id}`, `DELETE /api/flows?id=`
- `POST /api/fleet {workflow, ids, note}` 201 with the Fleet; `POST /api/fleet/stop {id}`; `GET /api/fleets`; `DELETE /api/fleet?id=`

UI:

- `RepoMenu`, under "with claude": the repo's workflows by label, broken ones disabled with the error, then ask and chat as today, then agent settings. The store fetches the list when the menu opens and keeps it per repo until the next open.
- `RunSheet` gains `{kind: "flow", flowId}`: a step strip across the top (one segment per step, coloured by status, the current one marked), beneath it the current step's run console unchanged, and when gated the summary, the verdict bars if any, and the three buttons. A done flow shows every step folded with its summary.
- `RunSheet` gains `{kind: "fleet", fleetId}` as described in section 4, and `{kind: "fleet-plan", workflow}` for the pre-flight.
- Select mode: a top-bar toggle. Cards show a tick, the set starts as the repos in view minus forge and unreadable ones, click toggles, and a bar along the bottom shows the count with a workflow picker and a start button. Leaving select mode clears the set. Nothing about selection persists.
- `RunChip` on a card shows the step's verb for a flow. A gated or waiting flow uses the same attention colour a waiting run does.
- The store keeps `flows` and `fleets` by id beside `runs`, applies the four new events, and drops a flow's sheet when it goes.

## 6. Migration and the bundled set

- `lib/workflows/commit.md`, `push.md`, `deploy.md`: one step each, the prompt lifted from `TASKS` verbatim, `when` from `canRun`.
- `lib/workflows/ship.md`: three steps, gates (Claude runs them and fixes the obvious, then the check confirms), commit, push. Replaces commit-push, whose prompt duplicated the other two.
- `lib/workflows/review.md`: read-only, `tools: read, git-read`, reports on the diff and changes nothing.
- `docs/workflows/example-update-deps.md`: a documented user example, not bundled.
- `actions.ts` keeps ask, chat, the ground rules, the named tool sets, `repoFacts` and `canRun` (now taking a `when` value). `RUN_ACTIONS`, `EXPECTS_CHANGE` and `PROGRESS` go.
- README and CLAUDE.md gain the workflow file format and the three sources.

## 7. Testing

Pure and unit tested:

- `workflow.test.ts`: frontmatter and defaults, step keys, tool set expansion, an empty-body check-only step, duplicate step names, a missing blurb, a bad `when`, a bad `gate`.
- `flow.test.ts`: `stepSpec` prompt assembly, and the flow state machine against a fake Runner that ends runs on command: continue, ask then continue, ask then retry, ask then stop, a failing check, a failed run, a stopped run, and the busy refusal.
- `verdict.test.ts`: `decide` at and around each threshold, and the reason text.
- fleet in `flow.test.ts`: precondition skipping, the cap, a parked flow holding a slot, stop dropping the pending ones, and the summary shape.
- `jev.test.ts`: the live test, skipped without a key.
- UI: the select-set arithmetic and the step strip states as pure functions with tests, like `grouping.ts` and `rings.ts`.

Gates before done: `bun run typecheck && bun run lint && bun test && bun run build`, then the running server checked in a browser with one bundled workflow and one fleet of two repos.

## Out of scope

- Feature request ingestion (next spec; it is a user workflow plus source connectors).
- Jev anywhere but the verdict gate.
- Repo-level workflows on remote repos.
- Watching the workflow folders for changes.
- Workflows that branch or run steps in parallel.
