# Manager, plan 2: cards carry a loadout, a workflow and `after`

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

Status: built and reviewed on branch `manager-cards` 2026-11-12; waiting on merge and deploy.

**Goal:** A coordinator's card names a loadout, a workflow and the cards it waits for; it starts with that loadout, runs that workflow as a flow on its branch, waits until the cards it names have landed, follows every later run on its branch, and Eric can hold the goal or start one card.

**Architecture:** The pure half (`src/core/coordinator.ts`) gains the card fields' checks, the `after` rule, a flow's settle rule and the new notes. The hub (`src/server/coordinator.ts`) gains hold, start with ids, edits of queued cards, cards that land after they settled, flow children and adopting a later run on a card's branch. `src/server/index.ts` starts a card's child with plan 1's loadout machinery (factored out of `startRepoRun`), as a branch run, a group or a branch flow, and keeps a run's loadout on every restart. The coordinator's lane gains two reads, and its brief gains a section plus Eric's `~/.claude/manager.md`.

**Tech Stack:** Bun, TypeScript (strict, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`), React 19 with Zustand, `bun test`, oxlint, Vite.

**Spec:** `docs/superpowers/specs/2026-11-12-manager-design.md`, sections "Cards carry a loadout, a workflow and `after`", "A card follows its branch", "The manager's brief and reads", "Holding a goal", "Phases" item 2, "Calls Claude made" 3 to 15. Plan 1 (`docs/superpowers/plans/2026-11-12-manager-loadouts.md`) is merged; its loadout machinery is what this plan reuses.

## Global Constraints

- The coordinator's token names a loadout and nothing else: `model`, `effort`, `skills` and `mcp` on a card are Eric's, set with the operate right (spec Calls 5, anti-goal "hands a worker a tool Eric never defined").
- A proposed card changes in every field; a queued card changes only its `equip` and `after`, or is removed; any other state changes nothing.
- `after` waits for **landed**: a card whose state is `done` and outcome `landed` (its branch landed, or its PR merged). Ready, PR opened, winner picked or left to Eric does not count.
- A coordinator may name only bundled and user workflows. A repo's own workflow is set by Eric from the page, and the card records that it came from the repo. A start loads the workflow from the source the card names, never by name alone through the repo's list.
- `times` above 1 with a workflow is refused. `times` above 1 with a loadout gives every member the same loadout.
- A manager's worker never holds canopy's tools (`withTools` false for every card child).
- Every step of a card's flow runs Claude Code. A step with its own `agent:` keeps that profile's model and effort; every other step takes the loadout's. The loadout's skills and servers cover every step.
- A held coordinator starts no card, through "start these", a start with ids or the pump. Running children go on.
- Limits stay: `COORD_AT_ONCE` 3, `MAX_PLAN` 8, `MAX_TASKS` 20, `BRANCH_RUNS_PER_REPO`.
- A new POST route gets a row in `RULES` (`src/core/callers.ts`) with the operate right; an unlisted POST needs admin.
- Runs keep `--setting-sources user,project,local` and `--strict-mcp-config`, and one `--settings` file at most.
- `src/core/coordinator.ts`, `src/core/loadout.ts` and `src/core/trigger.ts` stay browser-safe.
- Tests pass on macOS and Linux. A test that needs a kit sets `CANOPY_KIT` to a scratch file before `startServer`. Bun pins dates to UTC under test.
- Prose in comments, docs and messages: plain words, no em dashes. Commit messages have no backticks and end with `Claude-Session: https://claude.ai/code/session_01BR8Nn8uhcR6LN74aB1WYBc`.
- Before each commit: `bun run typecheck`, `bun run lint`, and the tests of the files the task touched. Task 9 runs the full `bun test` and `bun run build`.

## Review Focus

1. Eric lands a card that settled `ready` (or merges its PR) long after it settled: the card turns `landed` and a card waiting for it starts. Test in Task 2.
2. A coordinator names `review` for a card in a repo whose `.canopy/workflows/review.md` exists: the card runs the bundled `review`. Test in Task 6.
3. A stall resume, landing fix or PR fix on a card's branch: the card reopens, the new run keeps the card's loadout, and no child or depth refusal stops it. Tests in Tasks 4 and 5.
4. A card's flow stopped and picked up again, after a server restart: its next step still gets the settings file and the servers. Test in Task 6.
5. A card whose `after` names a card that failed, was dropped or was removed: it stays queued with "waits for t1, which failed" (or "was dropped", "was removed"), and the manager hears it once. Test in Task 2.

---

### Task 1: Card fields and their checks

**Files:**
- Modify: `src/core/types.ts` (`CoordTask` at about line 1095, `Run` at 1324)
- Modify: `src/core/coordinator.ts`
- Test: `src/core/coordinator.test.ts`

**Interfaces:**
- Produces, in `types.ts`:

```ts
/** What a card starts with (FR-065): a kit.json loadout and Eric's overrides of it. */
export interface CardEquip {
  loadout?: string;
  model?: string;
  effort?: AgentEffort;
  skills?: string[];
  mcp?: string[];
}
// CoordTask gains:
equip?: CardEquip;
workflow?: string;
/** Eric picked the repo's own workflow of that name */
workflowRepo?: true;
/** ids of cards of the same coordinator this one waits for, until each has landed */
after?: string[];
/** the child flow's id, in place of `run` */
flow?: string;
/** the child's branch (`RunBranch.origin`), once it started */
branch?: string;
// Run gains:
/** a coordinator Eric held: none of its cards starts until he resumes it */
held?: true;
```

- Produces, in `coordinator.ts`:

```ts
export interface PlanContext {
  known: (repo: string) => "local" | "remote" | null;
  /** every card the coordinator holds now */
  cards: readonly CoordTask[];
  /** the number the next new card takes: the plan's cards are t<next>, t<next+1>, ... */
  next: number;
  loadouts: LoadoutsInfo;
  /** the workflows a card in this repo may name */
  workflows: (repo: string) => readonly { name: string; fromRepo: boolean }[];
  by: "coordinator" | "person";
}
export function validatePlan(input: unknown, ctx: PlanContext): { tasks: PlannedTask[] } | { error: string };
export function editCard(t: CoordTask, b: Record<string, unknown>, ctx: PlanContext): { task: CoordTask } | { error: string };
export const cardLanded: (t: Pick<CoordTask, "state" | "outcome">) => boolean;
export function afterWait(task: CoordTask, cards: readonly CoordTask[]): { words: string; blocked: boolean } | null;
export function nextToStart(tasks: readonly CoordTask[], ctx: { working: number; repoFull: (repo: string, need?: number) => boolean; cards: readonly CoordTask[]; held?: boolean; first?: readonly string[] }): CoordTask[];
export const MAY_LAND_LATER: readonly ChildOutcomeWord[]; // ["ready", "PR opened", "winner picked"]
export function flowSettled(flow: Pick<Flow, "status" | "branch">, b: ChildBranch, overdue: boolean): { state: "done" | "failed"; outcome: ChildOutcomeWord } | null;
export function flowNote(task: CoordTask, flow: Flow, landing?: ChildLanding): string;
export function landedNote(task: CoordTask): string;
export function blockedNote(task: CoordTask, words: string): string;
export function holdNote(held: boolean): string;
// ChildLanding gains: prMerged?: true
```

- [ ] **Step 1: Write the failing tests** in `coordinator.test.ts`, one `test` each:
  - `validatePlan` with `by: "coordinator"` and `equip: { loadout: "quick", model: "opus" }` answers `{ error: "tasks[0].equip: a coordinator names a loadout; its fields are Eric's" }`; with `equip: { loadout: "quick" }` it keeps `equip` as given.
  - An unknown loadout answers `tasks[0].equip.loadout: no loadout nope in kit.json`; overrides with no loadout answer `tasks[0].equip: name a loadout before changing its fields`; a codex loadout with `skills` answers `tasks[0].equip: a codex loadout takes no skills or servers`; a model the loadout's harness does not take answers `tasks[0].equip.model: claude does not take gpt-6-sol`.
  - `workflow: "review"` passes when `ctx.workflows(repo)` lists it, sets `workflowRepo: true` only when the match has `fromRepo`, and answers `tasks[0].workflow: no workflow nope for <repo>` otherwise; `workflow` with `times: 2` answers `tasks[0]: a card with a workflow starts one run`.
  - With `cards` t1 and t2 and `next: 3`, a plan of two tasks where the second has `after: ["t1", "t3"]` passes; `after: ["t9"]` answers `tasks[1].after: no card t9`; `after: ["t4"]` on the second task answers `tasks[1].after: a card cannot wait for itself`; tasks whose `after` is `["t4"]` and `["t3"]` answer `tasks[0].after: t3 and t4 wait for each other` (a longer cycle names its cards in order, `t3, t4 and t5 wait for each other`).
  - `editCard` on a proposed card changes `title` and `after`; on a queued card changes `equip` and `after` and answers `t1 is queued; only its loadout and after change` for `note`; on a running card answers `t1 is running; only a proposed or queued card changes`.
  - `afterWait`: t2 after t1 queued is `{ words: "waits for t1", blocked: false }`; after t1 and t3 both unlanded, `"waits for t1 and t3"`; t1 failed gives `{ words: "waits for t1, which failed", blocked: true }`, dropped `"which was dropped"`, an id with no card `"which was removed"`; t1 done with outcome `landed` gives null; t1 done with outcome `ready` gives `"waits for t1"`.
  - `nextToStart` returns nothing when `held`; skips a card `afterWait` holds; with `first: ["t3"]` returns t3 before t1 when both fit.
  - `childOutcome` with `{ prMerged: true }` on a ready branch is `landed`.
  - `flowSettled`: a working, waiting or gated flow is null; failed is `{ state: "failed", outcome: "failed" }`; stopped is failed `stopped`; done with branch `nothing` is done `no change`, `uncommitted` failed `uncommitted`, `ready` behaves as `childSettled` does for a ready branch (waits while its entry is in the queue, `landed` once landed, `ready` once overdue).
  - `holdNote(true)` is `canopy: Eric held the goal; no new card starts until he resumes it`; `holdNote(false)` is `canopy: Eric resumed the goal; queued cards start again`; `landedNote` starts `canopy: task t1 (` and ends `) landed; cards that wait for it can start`; `blockedNote(t2, "waits for t1, which failed")` is `canopy: task t2 (<title>) waits for t1, which failed; it stays queued until Eric takes its after off or removes it`.

- [ ] **Step 2: Run them and see them fail.** Run: `bun test src/core/coordinator.test.ts`. Expected: FAIL on the new names.

- [ ] **Step 3: Implement.** Take the branch half of `childOutcome` (from the `b === "working"` line down) into one private helper that `childOutcome` and `flowSettled` share, so a done flow's branch settles exactly as a run's. `flowNote` follows `settleNote`'s lines, with `result:` set to `<workflow> <status>` and, when a step has a `reason` or `summary`, `, <step name>: <that line>`. Update every caller of the old `validatePlan(input, { known, have })` signature so the tree type-checks (the hub's call sites change for real in Task 2; here pass `cards`, `next`, an empty `LoadoutsInfo`, `workflows: () => []` and `by` from the caller).

- [ ] **Step 4: Run the tests and see them pass.** Run: `bun test src/core/coordinator.test.ts src/server/coordinator.test.ts`. Expected: PASS.

- [ ] **Step 5: Commit** ("Coordinator cards: equip, workflow and after on a card, and their checks").

---

### Task 2: The hub: hold, start with ids, queued edits, `after`, cards that land later

**Files:**
- Modify: `src/server/coordinator.ts`, `src/server/index.ts` (the `new CoordinatorHub({...})` deps at about line 6919, its `landing` dep at 6932)
- Modify: `src/core/callers.ts` (the `RULES` row holding `coordinator/tasks` and `coordinator/start`, about line 130)
- Test: `src/server/coordinator.test.ts`, `src/core/callers.test.ts`

**Interfaces:**
- Consumes: Task 1's `PlanContext`, `validatePlan`, `editCard`, `afterWait`, `nextToStart`, `cardLanded`, `MAY_LAND_LATER`, `landedNote`, `blockedNote`, `holdNote`.
- Produces, on `CoordinatorDeps`:

```ts
loadouts: () => LoadoutsInfo;
/** the workflows a card in this repo may name: bundled and user ones, and the repo's own when `withRepo` */
workflows: (repo: string, withRepo: boolean) => Promise<{ name: string; fromRepo: boolean }[]>;
/** what the landing queue and the PR watch know of a branch by its origin, once its run is gone */
branch?: (origin: string) => ChildBranch;
```

- Produces routes: `POST /api/coordinator/start {run, ids?: string[]}`, `POST /api/coordinator/hold {run, held: boolean}` (operate), and `plan`/`tasks` taking `equip`, `workflow`, `after`. `plan` and `edit` become `async`.

- [ ] **Step 1: Write the failing tests** in `coordinator.test.ts` (its fake deps gain `loadouts`, `workflows`, `branch`):
  - hold: `POST hold {held: true}` sets `run.held`, a following `start` queues the proposed cards and starts none, the manager's chat gets `holdNote(true)`; `{held: false}` clears it, the queued cards start, and the chat gets `holdNote(false)`. A coordinator's own token answers 403 `a coordinator proposes; holding the goal is Eric's`.
  - start with ids: `{ids: ["t2"]}` queues t2 only and starts it; `{ids: ["t9"]}` answers 404 `no card t9`; a running id answers 409 `t1 is running; only a proposed or queued card starts`; with t1 and t3 queued and room for one, `{ids: ["t3"]}` starts t3 first.
  - a queued card's `after` changes through `tasks`; a queued card is removed through `{remove: true}`.
  - after: t2 after t1 waits with outcome `waits for t1`; t1 settles `landed` and t2 starts.
  - Review Focus 1: t1 settles `ready` (its sort leaves it to Eric), t2 waits; the fake `landing` then answers t1's entry as `landed`, `recheck()` turns t1's outcome to `landed`, the chat gets `landedNote(t1)`, and t2 starts. The same with `prMerged: true` on a card that settled `PR opened`.
  - Review Focus 5: t1 fails; t2 keeps `queued` with outcome `waits for t1, which failed`, and the chat gets `blockedNote` once across two pumps. Removing t1 (a proposed t1 removed before start) gives `which was removed`.
- [ ] **Step 2: Run them and see them fail.** Run: `bun test src/server/coordinator.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** In the pump, a held coordinator sets every queued card's outcome to `the goal is held` and starts nothing; each queued card's `afterWait` words become its outcome, and a `blocked` one queues `blockedNote` once per card and words. Keep the `first` ids per coordinator from the last start with ids until those cards started. On a start, set the card's `branch` to the child's `branch.origin`. `recheck()` also looks at `done` cards whose outcome is in `MAY_LAND_LATER`: a card's run (or `deps.branch(card.branch)` when the run is gone), or for a group card the group's state, says landed, the card's outcome becomes `landed`, `landedNote` is queued and the coordinator is pumped. In `index.ts`, the `landing` dep sets `prMerged: true` when `state.prs.info()` has the branch's PR with `state.status === "merged"`, `branch` answers the same by origin, `loadouts` is `state.kit.loadouts()`, and `workflows` lists `loadWorkflows({ path: "", host: "none" })` (and `loadWorkflows(repo)` for `withRepo`) entries that parse and are not `listed: false`, marking `fromRepo` for `source === "repo"`. A plan from a coordinator token passes `by: "coordinator"` and `withRepo` false; a person passes `by: "person"` and `withRepo` true. Add `coordinator/hold` to the operate row in `RULES` and a test in `callers.test.ts` that it needs operate.
- [ ] **Step 4: Run the tests and see them pass.** Run: `bun test src/server/coordinator.test.ts src/core/callers.test.ts src/server/coordrunner.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit** ("Coordinator: hold a goal, start chosen cards, after waits for landed").

---

### Task 3: A card's child starts with its loadout

**Files:**
- Modify: `src/core/loadout.ts`, `src/server/index.ts` (`planLoadout` at about 1352, `startRepoRun` 1213-1296, `startGroup` 1449, `startCoordChild` 2093)
- Test: `src/core/loadout.test.ts`, `src/server/coordrunner.test.ts`

**Interfaces:**
- Consumes: `CardEquip` (Task 1), plan 1's `planLoadoutStart`, `loadoutFiles`, `LoadoutStartPlan`.
- Produces:

```ts
// core/loadout.ts
/** The loadout a card starts with: the named one with Eric's overrides laid over, never holding canopy's tools. */
export function cardLoadout(equip: CardEquip, info: LoadoutsInfo): Loadout | { refused: string };
// server/index.ts
async function planLoadout(state: ServerState, repo: Repo, loadout: string | Loadout, agent: AgentSettings): Promise<LoadoutStartPlan>;
/** the agent and extras a start takes for a loadout; never sets `child` */
async function withLoadout(state: ServerState, repo: Repo, loadout: string | Loadout, routed: AgentSettings, base: StartExtras, withTools: boolean): Promise<{ agent: AgentSettings; extras: StartExtras; release: () => Promise<void> }>;
// GroupStart gains: loadout?: Loadout
```

- [ ] **Step 1: Write the failing tests.** In `loadout.test.ts`: `cardLoadout({ loadout: "feature", model: "sonnet", skills: ["unslop"] }, info)` keeps the name `feature`, the harness and effort, takes `sonnet` and `["unslop"]`, and has `canopyTools: false` even when the loadout says true; an unknown name answers `{ refused: "no loadout nope in kit.json" }`. In `coordrunner.test.ts` (scratch `CANOPY_KIT` with a loadout `quick` on haiku), a card with `equip: { loadout: "quick" }` started through "start these" makes a child whose `equip.loadout` is `quick`, whose agent model is `haiku`, which holds no canopy tools, and whose settings file exists while it runs; a card with `times: 2` and the loadout gives both members `equip.loadout` `quick`; a card naming a loadout that is gone from kit.json fails with outcome `no loadout quick in kit.json`.
- [ ] **Step 2: Run them and see them fail.** Run: `bun test src/core/loadout.test.ts src/server/coordrunner.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** `planLoadout` with a `Loadout` object plans it by laying it into the info's list under its own name before `planLoadoutStart`. Take `startRepoRun`'s plan-and-files lines into `withLoadout` and call it from there, so the hand-started path does not change. `startCoordChild` resolves `cardLoadout(task.equip, state.kit.loadouts())` when `task.equip?.loadout` is set (a refusal throws, which fails the card with its words), starts the branch run with `withLoadout(..., false)` extras plus `{ parent: coordId, priority? }`, and releases the files when the start throws. `startGroup` with `GroupStart.loadout` starts each member through `withLoadout` in place of its profile. The hand-started route's refusal of a loadout with `times` above 1 stays.
- [ ] **Step 4: Run the tests and see them pass.** Run: `bun test src/core/loadout.test.ts src/server/coordrunner.test.ts src/server/loadout-route.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit** ("Coordinator cards start with their loadout, groups too").

---

### Task 4: Restarts keep the run's loadout

**Files:**
- Modify: `src/core/types.ts` (`LandingRun` at about 1782, `SweptChat` at 3755), `src/core/loadout.ts`, `src/server/landing.ts` (the record built from a run, about line 577), `src/server/index.ts` (`startBranchFix` 1909, `startForkRun` 1764, `startSweptChat` 1017, and where a swept chat's record is made)
- Test: `src/core/loadout.test.ts`, `src/server/loadout-route.test.ts`

**Interfaces:**
- Consumes: `withLoadout`, `planLoadout` (Task 3).
- Produces:

```ts
// core/loadout.ts
/** The loadout a run started with, rebuilt from its equip, so a restart gets the same one whatever kit.json says now. */
export function loadoutOfEquip(equip: RunEquip, harness: Harness): Loadout;
// LandingRun gains: equip?: RunEquip   (copied from the run, as canopyTools is)
// SweptChat gains:  equip?: RunEquip
```

- [ ] **Step 1: Write the failing tests.** In `loadout.test.ts`: `loadoutOfEquip` keeps name, model, effort, skills and mcp, takes the harness given, `canopyTools: false`, note empty. In `loadout-route.test.ts` (it already starts loadout runs on a scratch server): a branch run started with loadout `docs` and settled ready, then fixed through `POST /api/landing/fix`, starts a run whose `equip.loadout` is `docs` with the same model and a settings file; the same after the loadout was taken out of kit.json; a fork of a loadout run (`POST /api/runs/fork`) carries the same `equip.loadout`.
- [ ] **Step 2: Run them and see them fail.** Run: `bun test src/core/loadout.test.ts src/server/loadout-route.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** The landing record copies `run.equip`. `startBranchFix` with `rec.equip` starts through `withLoadout(state, repo, loadoutOfEquip(rec.equip, rec.harness), agent, base, holdsTools)`; its `parent` and `depth` stay as they are, and it never sets `child`. `startForkRun` does the same from `original.equip`, and `startSweptChat` from `c.equip`, which the sweep records from the run it sweeps.
- [ ] **Step 4: Run the tests and see them pass.** Run: `bun test src/core/loadout.test.ts src/server/loadout-route.test.ts src/server/landing.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit** ("A fix, a fork and a swept chat's restart keep the run's loadout").

---

### Task 5: A card follows its branch

**Files:**
- Modify: `src/server/coordinator.ts` (`follow`, `settle`)
- Test: `src/server/coordinator.test.ts`, `src/server/coordrunner.test.ts`

**Interfaces:**
- Consumes: `CoordTask.branch` (Tasks 1 and 2), `cardLanded`.
- Produces: no new names. A run whose `parent` is a coordinator and whose `branch.origin` equals a card's `branch` becomes that card's `run` when the card has not landed: the card goes back to `running`, its outcome clears, and it settles again with a new note.

- [ ] **Step 1: Write the failing tests.** In `coordinator.test.ts`: t1 settles `ready`; a new run with `parent` the coordinator and the same `branch.origin` arrives through `onRun`; t1 is `running` with that run, then settles again and the chat gets a second settle note. A card that settled `landed` is not reopened. A card t2 after t1 does not start while t1 runs again. In `coordrunner.test.ts`: a card child whose branch is fixed through `POST /api/landing/fix` reopens its card, and the fix run has the card's loadout and no child refusal (Review Focus 3).
- [ ] **Step 2: Run them and see them fail.** Run: `bun test src/server/coordinator.test.ts src/server/coordrunner.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** in `follow`: when no card has `run === child.id`, look for a card of `child.parent` whose `branch` is `child.branch?.origin` and that is not `cardLanded`; adopt the run (keep `limited` as `resumeLimited` left it), then `settle`. Confirm the landing record keeps `parent` for a card's child, so every `startBranchFix` caller (landing fix, PR fix, stall resume, trigger follow-up) carries it.
- [ ] **Step 4: Run the tests and see them pass.** Run the same command. Expected: PASS.
- [ ] **Step 5: Commit** ("A coordinator card follows every run on its branch and settles again").

---

### Task 6: A card that names a workflow

**Files:**
- Modify: `src/core/trigger.ts` (`triggerPlan` at 773), `src/core/types.ts` (`Flow` at about 2907), `src/core/flow.ts` (`Flows.start` 444, `FlowRunner.start`'s extras type 207, the step start at 1400, `FlowHooks` at about 250), `src/core/coordinator.ts` (none new beyond Task 1), `src/server/coordinator.ts` (`ChildStart`, the pump, `working`, `onFlow`, `recheck`), `src/server/index.ts` (`startCoordChild`, the flows' `onChange` at about 6094, the hub deps), `src/server/runtools.ts` (the boot sweep)
- Test: `src/core/trigger.test.ts`, `src/core/flow.test.ts`, `src/server/coordinator.test.ts`, `src/server/coordrunner.test.ts`

**Interfaces:**
- Produces:

```ts
// core/trigger.ts: triggerPlan = unattendedRefusal first, then this
export function workflowPlan(wf: Workflow): { kind: "run"; task: string; tools: string[]; turns: number } | { kind: "flow" } | string;
// types.ts, Flow gains: equip?: RunEquip
// flow.ts
type StepExtras = Pick<StartExtras, "settings" | "mcpConfig" | "servers" | "equip">;
// Flows.start opts gain: equip?: RunEquip
// FlowHooks gains: stepExtras?: (flow: Flow) => StepExtras | undefined
// server/coordinator.ts
export type ChildStart = { run: Run } | { group: RunGroup } | { flow: Flow } | { busy: string };
// CoordinatorDeps gains: flow?: (id: string) => Flow | undefined
```

- [ ] **Step 1: Write the failing tests.**
  - `trigger.test.ts`: `workflowPlan` of a workflow with an `ask` gate is `{ kind: "flow" }`; `triggerPlan` of the same still answers its refusal; one plain step is `{ kind: "run", ... }`.
  - `flow.test.ts`: a flow started with `equip` keeps it on the flow; with `hooks.stepExtras` answering `{ settings: "/x.json", servers: ["s"], equip }`, every step's runner start gets those extras; after `pickUp` of a stopped branch flow the next step gets them too.
  - `coordinator.test.ts` (fake `flow` dep): a start answering `{ flow }` sets the card's `flow` and `branch`, and the flow counts as one working child; `onFlow` with the flow done and its branch ready waits for the landing entry, then settles `landed` with a `flowNote`; failed settles `failed`; stopped settles `failed` `stopped`; a stopped card flow that turns working again (picked up) puts the card back to `running`.
  - `coordrunner.test.ts` (scratch user workflow `two-steps` with steps `build` and `check`, the second gated `ask`; loadout `quick`): a card with `workflow: "two-steps"` and `equip: { loadout: "quick" }` starts a branch flow, not a run; its first step's run has `equip.loadout` `quick` and a settings file under the flow's own key; that file is still there after the step's run ended; the flow parks at the ask gate and is not marked unattended. A one-plain-step workflow starts a branch run with the step's spec. Review Focus 2: the repo holds `.canopy/workflows/review.md` with a different label, a coordinator card names `review`, and the flow's workflow has `source: "bundled"`. Review Focus 4: stop the card's flow, restart the server on the same config dir, `pickUp` it, and its next step's start has the settings file and servers.
- [ ] **Step 2: Run them and see them fail.** Run: `bun test src/core/trigger.test.ts src/core/flow.test.ts src/server/coordinator.test.ts src/server/coordrunner.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - `startCoordChild` with `task.workflow` loads it from `loadWorkflows(repo)` when `task.workflowRepo`, else from `loadWorkflows({ path: "", host: "none" })`, applies `withRepoModes`, and takes `workflowPlan`. A string fails the card with it.
  - A run plan starts a branch run with the step's spec, as `triggerSpec`'s run case builds it but without `unattended`, and the loadout as in Task 3.
  - A flow plan cuts the branch under `withBranchStart` and calls `state.flows.start(repo, { ...wf, agentRole: "job" }, task.note, select, { branch, priority, equip })`. `select(profile)` answers the profile's agent for a step that names one, else the loadout's planned agent. A step whose agent is not Claude Code refuses the start: `step <name> of <workflow> runs <harness>; a card's flow needs Claude Code`.
  - The settings file and `mcp.json` are written under the key `flow-<flow id>` (plan 1's `writeRunSettings` and `writeMcpConfig` take any id). `stepExtras` answers their paths, `flow.equip.mcp` as `servers` and `flow.equip` for a flow that has `equip`. The flows' `onChange` removes the two files when a flow ends `done` or `failed`. The boot sweep leaves `flow-*` files alone. Confirm `dropRunTools` at a step's end removes only files keyed by that run's id.
  - In the hub, `working` counts a running card with an active flow as one. `onFlow` settles a card whose `flow` is that flow's id through `flowSettled`, with `deps.branch(flow.branch.origin)` and the overdue clock from `flow.endedAt`. It also puts a card that failed `stopped` back to `running` when its flow is active again. `recheck()` covers running flow cards.
- [ ] **Step 4: Run the tests and see them pass.** Run the same command plus `bun test src/server/flows.test.ts src/core/flow-runner.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit** ("A coordinator card that names a workflow runs it as a flow on its branch").

---

### Task 7: The manager's reads and brief

**Files:**
- Modify: `src/core/callers.ts` (`LANES.coordinator` at about line 51), `src/server/callers.ts` (the coordinator lane's 403 text, about 583), `src/core/coordinator.ts`, `src/server/coordinator.ts` (`handle`), `src/server/index.ts` (`coordinatorBrief` at 1591), `lib/coordinator.md`
- Test: `src/server/callers.test.ts` (the exact lane set at about 534), `src/server/callers-route.test.ts`, `src/core/coordinator.test.ts`, `src/server/coordrunner.test.ts`

**Interfaces:**
- Produces:

```ts
// core/coordinator.ts
export interface CoordWorkflow { name: string; label: string; blurb: string; source: "bundled" | "user"; steps: { name: string; gate: GateKind; mode: StepMode }[] }
export function coordWorkflows(entries: readonly WorkflowEntry[]): CoordWorkflow[];
/** the brief with Eric's standing rules from ~/.claude/manager.md under their own heading; the brief alone when there are none */
export function withStandingRules(brief: string, rules: string | null): string;
// route: GET /api/coordinator/workflows (read right) answers CoordWorkflow[]
// LANES.coordinator gains "GET /api/loadouts" and "GET /api/coordinator/workflows"
```

- [ ] **Step 1: Write the failing tests.** `coordWorkflows` keeps only parsed, listed, bundled and user entries and never carries `file` or a step's `body`; `withStandingRules(brief, "  Prefer the quick loadout.\n")` is `${brief}\n\n## Eric's standing rules\n\nPrefer the quick loadout.`, and with null or blank rules it is the brief. In `callers.test.ts`, the pinned coordinator lane is the old set plus the two GETs; in `callers-route.test.ts`, a coordinator token reads `GET /api/loadouts` and `GET /api/coordinator/workflows` and still gets 403 on `GET /api/repos/workflows`. In `coordrunner.test.ts`, with a scratch HOME holding `.claude/manager.md`, the coordinator's prompt contains `## Eric's standing rules` and the file's text.
- [ ] **Step 2: Run them and see them fail.** Run: `bun test src/core/coordinator.test.ts src/server/callers.test.ts src/server/callers-route.test.ts src/server/coordrunner.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** The route lists `loadWorkflows({ path: "", host: "none" })` through `coordWorkflows`. `coordinatorBrief` reads `join(homedir(), ".claude", "manager.md")` (a missing file is no rules) and passes the brief through `withStandingRules`. The lane's 403 text names the new reads. In `lib/coordinator.md`: "Seeing the board" lists five reads; a new section "Equipping cards" says to read `/api/loadouts` and `/api/coordinator/workflows`, give each card `"equip": {"loadout": "<name>"}` picked by what the task touches with the reason in one line of the reply, name a `"workflow"` only when one fits and never with `times`, and set `"after": ["t1"]` when a card needs another's change landed first; that the plan's cards take the next numbers in order (if the cards so far end at t4, the first new one is t5); that model, effort, skills and servers are Eric's; and "Hearing back" adds the landed, waits-for and held notes.
- [ ] **Step 4: Run the tests and see them pass.** Run the same command. Expected: PASS.
- [ ] **Step 5: Commit** ("Coordinator: reads loadouts and workflows, and its brief carries Eric's standing rules").

---

### Task 8: Cards on the page show what they carry; hold and start one

**Files:**
- Modify: `ui/src/coord.ts` (`CoordEdit` at 13, `cardStatus` at 88), `ui/src/components/CoordTasks.tsx`, `ui/src/api.ts` (`coordTask` 1190, `coordStart` 1196), `ui/src/store.ts` (about 1629 and 5307), `ui/src/styles.css`
- Test: `ui/src/coord.test.ts`, `ui/src/components/CoordTasks.test.tsx`

**Interfaces:**
- Produces:

```ts
// ui/src/coord.ts
export type CoordEdit = Partial<Pick<CoordTask, "title" | "note" | "repo" | "action" | "times" | "equip" | "workflow" | "after">>;
/** the words a card's facts line adds: its loadout (with "changed" when Eric overrode a field), its workflow, "after t1, t3" */
export function cardCarries(task: CoordTask): { loadout?: { word: string; title: string }; workflow?: string; after?: string };
// ui/src/api.ts
coordStart(runId: string, ids?: string[]): Promise<...>;
coordHold(runId: string, held: boolean): Promise<...>;
// store: coordStart(runId, ids?), coordHold(runId, held)
```

- [ ] **Step 1: Write the failing tests.** `cardCarries` of a card with `equip: { loadout: "feature" }` gives `loadout.word` `feature`, with `model: "sonnet"` too gives `feature, changed` and a title naming `model sonnet`; `workflow: "review"` gives `review`; `after: ["t1", "t3"]` gives `after t1, t3`. In `CoordTasks.test.tsx`: the facts line shows the three; a held active coordinator's head shows a "resume" button and the words "held", an unheld one a "hold" button; a proposed card has a "start" button that calls `coordStart(run.id, [task.id])`; the card form offers a loadout select (none plus the store's loadouts) and an after field, and saving sends `equip` and `after`.
- [ ] **Step 2: Run them and see them fail.** Run: `bun test ui/src/coord.test.ts ui/src/components/CoordTasks.test.tsx`. Expected: FAIL.
- [ ] **Step 3: Implement** with the existing card styles (`facts`, `coord-chip`); a chip's full detail goes in its `title`. The workflow pick in the form lists the repo's workflows from `api.workflows(repoId)` when the form opens. Buttons are at least 44 px tall on a phone.
- [ ] **Step 4: Run the tests and see them pass**, then the gates: `bun run typecheck`, `bun run lint`. Then watch it on a served build: `bash scripts/browser/check.sh` plus a Playwright script through `scripts/browser/run.sh` (or the Mac's Chrome) against a scratch server whose config dir holds a kept coordinator run with cards carrying a loadout, a workflow and `after`, at 1440 and 390 wide. Save screenshots in the plan's workspace and name them in the report.
- [ ] **Step 5: Commit** ("Coordinator cards show their loadout, workflow and after; hold and start one card").

---

### Task 9: Docs and the whole suite

**Files:**
- Modify: `README.md` (the coordinator bullet), `docs/architecture.md` (the coordinator section and the loadouts paragraph; `grep -n '^## ' docs/architecture.md` to find them), `SPEC.md` (a run's `held`, a card's new fields, flow files under `run-tools`), `FEATURES.md` (FR-065 phase 2), `docs/superpowers/specs/2026-11-12-manager-design.md` (Phases item 2: shipped, and every place this plan differs), `docs/superpowers/plans/README.md`, this plan's Status line

- [ ] **Step 1:** Update each doc above where this plan's change makes it wrong or leaves it silent.
- [ ] **Step 2:** Run every gate: `bun run typecheck`, `bun run lint`, `bun test`, `bun run build`. Expected: all exit 0.
- [ ] **Step 3: Commit** ("Manager plan 2 docs: cards carry a loadout, a workflow and after").

The controller merges, pushes, deploys (`bun run redeploy all`), and on the mini starts one small coordinator against a scratch repo with the `quick` loadout to watch a card start, settle and report, and checks the cards in Eric's Chrome.
