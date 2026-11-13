# Manager, plan 3: steering routes and the top view

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

Status: written 2026-11-12 on branch `manager-top`.

**Goal:** Eric steers one goal from one screen. `?view=manager&run=<coordinator>` shows the goal's cards as rings, every item that waits on him with its answer in place, a lane per worker with its step strip and loadout, and the manager's chat, on a desktop, a tablet and a phone. Every steering action has a route the page and the CLI can call and a coordinator's token cannot.

**Architecture:** Two routes close the steering gaps. `POST /api/flows/pickup` picks a stopped branch flow up (`Flows.pickUp`, which only the trigger hub reached so far). `POST /api/landing/followup` starts a later run on a settled branch with a person's words or none (`startBranchFix`), and plan 2's adoption turns that run back into the card's. Saying to a working worker stays FR-066's `POST /api/runs/say`. The page computes the view's rows in a pure helper, `ui/src/manager.ts`, from what the store already holds (runs, flows, landing, PRs, kit loadouts). `ui/src/components/ManagerView.tsx` and `EquipSheet.tsx` draw them and call the routes. The CLI gains `canopy coordinator`, `canopy land followup` and `canopy run pickup`.

**Tech Stack:** Bun, TypeScript (strict, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`), React 19 with Zustand, `bun test`, oxlint, Vite.

**Spec:** `docs/superpowers/specs/2026-11-12-manager-design.md`, sections "What each steering action does", "The top view", "Phases" item 3, Calls 7, 8 and 10. Plans 1 and 2 are merged (`2026-11-12-manager-loadouts.md`, `2026-11-12-manager-cards.md`). FR-066 (`FEATURES.md`) replaced the spec's `runs/nudge`: a person's `POST /api/runs/say` steers a working run, so this plan adds no nudge route. Mockup (sample data, its own colors; build in canopy's tokens): https://claude.ai/artifact/K9QsTKbRNnvZViEFWVWZno, saved at `/private/tmp/claude-501/-Users-ericbaruch-dev-dev-tools-canopy/5f1fae0b-a1ec-4baa-b087-892d8ee7f24b/scratchpad/mockup/project/{Main,Equip,Phone}.dc.html`. A code map with file:line anchors is at `/private/tmp/claude-501/-Users-ericbaruch-dev-dev-tools-canopy/5f1fae0b-a1ec-4baa-b087-892d8ee7f24b/scratchpad/plan3-map.md`.

## Global Constraints

- Two new routes and no others: `POST /api/flows/pickup {id}` and `POST /api/landing/followup {id, note?}`. Both need the operate right. `flows/pickup` gets its own `RULES` row in `src/core/callers.ts`; `landing/followup` is covered by the `landing/*` row. A coordinator's token gets 403 on both (its lane leaves them out), pinned in `src/core/callers.test.ts` (the `refused` list near line 229) and `src/server/callers.test.ts` (the gate list near line 445).
- A follow-up never puts a second writer on a branch. It answers 409 while a run or a flow works on the branch, while the branch has any landing entry: in the queue (`inQueue` in `src/core/landing.ts`: queued, waiting, judge, rebasing, setup, gate, scenarios, landing), sent back (conflict, red, moved; those have `POST /api/landing/fix`), or landed. A follow-up is for a branch outside the queue: a ready run waiting for Eric's land, a stopped or failed run. It answers 404 when canopy holds no landing record for the id.
- A follow-up keeps the record's `parent`, so a coordinator's card adopts the new run (plan 2), and the run keeps the card's loadout (`startBranchFix` rebuilds it from `rec.equip`). A person's words go in as the reason unfenced; Linear's fence is for text anyone can write.
- Equip changes only on a proposed or queued card. The sheet sends a whole `CardEquip` (`POST /api/coordinator/tasks` replaces the object). A Codex loadout takes model and effort only.
- The model a worker runs on is `run.agentSettings?.model ?? run.equip?.model`. Never read the model from `equip` alone.
- Ring and chip colors: `--sky` running or checking, `--lichen` gated, held or waits on you, `--moss` passed or landed, `--rust` failed, sent back or dropped, `--hair` to come. One stylesheet, `ui/src/styles.css`, `light-dark()` tokens, no CSS framework.
- Phone is `PHONE` (`(max-width: 760px)`, `ui/src/media.ts`) through `useMedia` and CSS media queries, never `window.innerWidth` read once. At 390 px the page has no sideways scroll, buttons are at least 44 px tall, and the rings scroll sideways inside their own strip.
- A qualified id in a URL (`mini|ed71ddfb`) goes through `encodeURIComponent`.
- Files the UI imports from `src/core/` stay browser-safe. `react/rules-of-hooks` is an error: no hook after an early return.
- Component tests use `renderToStaticMarkup` (`ui/src/components/CoordTasks.test.tsx` is the pattern); there is no DOM library.
- Tests pass on macOS and Linux. `bun test` preloads `src/test-env.ts`. Bun pins dates to UTC under test.
- Prose in comments, docs, copy and messages: plain words, no em dashes. Commit messages have no backticks and end with `Claude-Session: https://claude.ai/code/session_01BR8Nn8uhcR6LN74aB1WYBc`.
- Before each commit: `bun run typecheck`, `bun run lint`, and the tests of the files the task touched. Task 10 runs the full `bun test` and `bun run build`.

## Review Focus

1. Eric sends a card back while its branch sits in the landing queue (queued or rebasing) or while its fix runs: the follow-up answers 409 and nothing starts in the worktree. Tests in Task 3.
2. A card's flow stopped, the server restarted, and the flow picked up through `POST /api/flows/pickup`: its next step still gets the settings file and the servers. Test in Task 2 (replaces the `pickUpFlow` hook).
3. A gate, or a question on a flow's step run, shows in "needs you" and is answered there. The prompt lives on `runs[flow.steps[i].runId]`, not on the card's run. Tests in Tasks 7 and 8.
4. `?view=manager&run=` names a coordinator that ended and left `/api/runs`, or an id nobody knows: the view says the goal has ended and lists the live coordinators, never a blank page. Test in Task 8.
5. A phone at 390 px: needs-you first, the rings in a strip that scrolls sideways, no sideways page scroll, 44 px buttons, the equip sheet full height. Checked in Task 10's browser check.

---

### Task 1: The brief names the goal's repo and leaves `run` out

The two live checks on the mini (2026-11-12) showed both: coordinator 45024cc7 asked which repo, and both coordinators lost their first plan POST to `"run": "'"$CANOPY_RUN"'"` inside a quoted heredoc ("the body must be a JSON object").

**Files:**
- Modify: `src/core/coordinator.ts` (beside `withStandingRules`, about line 636)
- Modify: `src/server/index.ts` (`coordinatorBrief`, about line 1672, and its call in `startCoordinator`)
- Modify: `lib/coordinator.md` (the plan example, about lines 33 to 46)
- Test: `src/core/coordinator.test.ts`

**Interfaces:**
- Produces: `export function goalRepoLine(repoId: string): string` in `src/core/coordinator.ts`. `coordinatorBrief(repo: Repo): Promise<string>` in `src/server/index.ts` appends it after the brief, before the standing rules.

- [ ] **Step 1: Write the failing tests** in `src/core/coordinator.test.ts`:
  - `goalRepoLine("playground/canopy-trigger-test")` equals `"Eric started this goal at the repo playground/canopy-trigger-test. Plan its cards there unless the goal names other repos; do not ask which repo."`
  - `lib/coordinator.md` (read with `Bun.file`) does not contain `"run": "<your run id>"`, and does contain `leave "run" out`.
- [ ] **Step 2: Run** `bun test src/core/coordinator.test.ts -t "goalRepoLine|brief"`. Expected: FAIL.
- [ ] **Step 3: Implement.** `coordinatorBrief(repo)` returns `withStandingRules(`${brief}\n\n${goalRepoLine(repo.id)}`, rules)`. In `lib/coordinator.md`, drop `"run"` from the instruction and the example, and say: the body is `{"tasks": [...]}`; leave "run" out, canopy fills in your own run. Keep the quoted-heredoc advice.
- [ ] **Step 4: Run** the same tests. Expected: PASS.
- [ ] **Step 5: Commit** "Coordinator brief: name the repo the goal started at, and leave run out of the plan body".

### Task 2: `POST /api/flows/pickup`

**Files:**
- Modify: `src/core/callers.ts` (the `flows/resume`, `flows/stop` row)
- Modify: `src/server/index.ts` (the flows routes near `/api/flows/resume`, about line 5022; delete `pickUpFlow` from `start()`'s return type, about 6090, and its body, about 7989)
- Test: `src/core/callers.test.ts`, `src/server/callers.test.ts`, `src/server/flows.test.ts`, `src/server/coordrunner.test.ts`

**Interfaces:**
- Produces: `POST /api/flows/pickup {id: string}` answers 200 with the picked-up `Flow`. Errors: 400 when `id` is not a string; 404 `unknown flow: <id>`; 409 for "only a flow on a branch can be picked up" and "the flow is <status>, not stopped" (`Flows.pickUp`'s own words, `src/core/flow.ts` about line 828).

- [ ] **Step 1: Write the failing tests.**
  - `src/core/callers.test.ts`: add `["POST", "/api/flows/pickup"]` and `["POST", "/api/landing/followup"]` to the coordinator's `refused` list; add a test that `needs("POST", "/api/flows/pickup")` is `"operate"`.
  - `src/server/callers.test.ts`: add both routes to the "a coordinator at the gate" list; each answers 403.
  - `src/server/flows.test.ts`: a stopped branch flow picked up through the route answers 200 with `status` `"working"`; an unknown id answers 404; a flow that is working answers 409; a flow with no branch answers 409.
  - `src/server/coordrunner.test.ts` "Review Focus 4" (about line 817): replace `s.pickUpFlow(flowId)` with a `POST /api/flows/pickup {id: flowId}` carrying the page token the test already uses; expect 200, then the same settings-file and servers assertions. Remove `pickUpFlow` from the `Up` type.
- [ ] **Step 2: Run** those four files. Expected: the new tests FAIL.
- [ ] **Step 3: Implement** the route beside `/api/flows/resume` and the `RULES` entry (`flows/pickup` in the operate row). Map the three `pickUp` errors to their statuses by message. Delete the `pickUpFlow` hook.
- [ ] **Step 4: Run** the four files. Expected: PASS. `grep -rn pickUpFlow src` finds nothing.
- [ ] **Step 5: Commit** "Flows: POST /api/flows/pickup picks a stopped branch flow up; the test hook goes".

### Task 3: `POST /api/landing/followup`

**Files:**
- Modify: `src/core/landing.ts` (a pure refusal check)
- Modify: `src/server/index.ts` (the route, beside the landing routes' dispatch, calling `startBranchFix` at about line 2017)
- Test: `src/core/landing.test.ts`, `src/server/landing-run.test.ts`, `src/server/coordrunner.test.ts`

**Interfaces:**
- Produces: `export function followupRefusal(rec: LandingRun | undefined, entry: LandEntry | undefined, busy: boolean, id: string): { status: 404 | 409; error: string } | null` in `src/core/landing.ts`. `busy` is true when a live run or an active flow works on `rec.id`'s branch. Messages: 404 `"canopy holds no branch <id>; it was dropped or never ran"`; 409 `"a run is working on this branch; say to it instead"`; 409 `"it is in the landing queue (<state>); wait for it, or drop it from the queue first"`; 409 `"it was sent back (<state>); fix it from the landing queue instead"`; 409 `"it has landed"`.
- Produces: `POST /api/landing/followup {id: string, note?: string}`. `id` is the branch origin (`LandingRun.id`). It calls `startBranchFix(state, rec, reason, label, rec.pr === undefined, { priority: "interactive" })` where `reason` is the trimmed note, or `"Carry on with the task from where you stopped."` when the note is empty or missing, and `label` is `"follow-up"` with a note and `"resume"` without. Answers 201 `{run: Run}`. `startBranchFix`'s own errors pass through.

- [ ] **Step 1: Write the failing tests.**
  - `src/core/landing.test.ts`, `followupRefusal`: undefined record gives 404; `busy` gives the run message; an entry in each of `queued`, `waiting`, `judge`, `rebasing`, `setup`, `gate`, `scenarios`, `landing` gives the queue message naming the state; `conflict`, `red` and `moved` give the sent-back message; `landed` gives "it has landed"; no entry with `rec.state` `"ready"` or `"stopped"` gives null.
  - `src/server/landing-run.test.ts`: a ready branch run's follow-up with `note: "rename the flag"` answers 201, and the new run's first user message contains "rename the flag" and its `branch.origin` is the record's id; a second follow-up while that run works answers 409; a follow-up on a branch queued for landing answers 409 and starts nothing (count runs before and after); an unknown id answers 404.
  - `src/server/coordrunner.test.ts`: a card whose child settled `ready` gets a follow-up through the route; the card goes back to `running` with the new run as its `run`, the run's `equip.loadout` is the card's loadout, and the card settles again with a new note to the coordinator.
- [ ] **Step 2: Run** the three files. Expected: the new tests FAIL.
- [ ] **Step 3: Implement** `followupRefusal`, then the route: read `rec = state.landing.record(id)`, the entry from the landing info, and `busy` from the runner and flows, refuse through `followupRefusal`, then call `startBranchFix`.
- [ ] **Step 4: Run** the three files. Expected: PASS.
- [ ] **Step 5: Commit** "Landing: POST /api/landing/followup starts a later run on a settled branch, never beside another writer".

### Task 4: A profile step reports its own model

**Files:**
- Modify: `src/core/flow.ts` (`FlowHooks.stepExtras`, about line 267, and its call, about 1419)
- Modify: `src/server/index.ts` (`flowStepExtras`, about line 1372)
- Test: `src/server/coordrunner.test.ts` or `src/server/flows.test.ts`, whichever already starts a card flow with a profile step

**Interfaces:**
- Produces: `stepExtras?: (flow: Flow, step: FlowStep) => StepExtras | undefined`. For a step with `profile`, `flowStepExtras` returns `equip` with `model` and `effort` set to the agent that step runs on (the same `select(profile)` agent `startCoordWorkflow` builds); the settings file, MCP config and servers stay the flow's.

- [ ] **Step 1: Write the failing test:** a card flow whose loadout is `quick` (haiku, low) and whose second step names a profile on another model: that step's run has `agentSettings.model` equal to `equip.model`, and the first step's `equip.model` is haiku.
- [ ] **Step 2: Run** it. Expected: FAIL (`equip.model` reads haiku on the profile step).
- [ ] **Step 3: Implement.** Pass the step through the hook; resolve the profile's agent once per flow start and keep it where `flowStepExtras` can read it, or resolve it again with the same `agentFor` call.
- [ ] **Step 4: Run** it and `src/core/flow.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit** "Flows: a profile step's run reports the profile's model and effort".

### Task 5: CLI verbs for steering

**Files:**
- Create: `src/cli/coordinator.ts`, `src/cli/coordinator.test.ts`
- Modify: `src/cli/index.ts` (`COMMANDS` and the `switch`), `src/cli/land.ts` (`followup`), `src/cli/run.ts` (`pickup`), `src/core/help.ts`
- Test: `src/cli/land.test.ts`, `src/cli/run.test.ts`, `src/cli/verbs.test.ts` (unchanged; it must keep passing)

**Interfaces:**
- `canopy coordinator [--backend URL | --on NAME] [--json]`: the live coordinators, one line each: id, repo, held or not, card counts (`cardCounts`), goal's first line.
- `canopy coordinator <run> [--json]`: that coordinator's cards, one line each: id, state, repo, loadout word (`cardCarries`), workflow, after, title.
- `canopy coordinator hold <run>` and `canopy coordinator resume <run>`: `POST /api/coordinator/hold {run, held}`.
- `canopy coordinator start <run> [id ...]`: `POST /api/coordinator/start {run, ids?}`; no ids starts every proposed card.
- `canopy land followup <branch> [-m words]`: `POST /api/landing/followup`; prints the new run's id.
- `canopy run pickup <flow>`: `POST /api/flows/pickup`; prints the flow's id and status.
- Pure: `export function coordinatorLines(runs: Run[]): string[]` and `export function cardLines(run: Run): string[]` in `src/cli/coordinator.ts`.

- [ ] **Step 1: Write the failing tests:** `coordinatorLines` lists only `action === "coordinate"` runs that are active; `cardLines` prints `t1  queued  playground/x  quick  spec  after t2  sync the spec` for a fixture card (columns padded the way `src/cli/loadouts.ts` pads); the CLI test pattern of `land.test.ts` for `followup` sends `{id, note}` and prints the run id; `run pickup` sends `{id}`. Every new verb has a `verbHelp` line (verbs.test.ts).
- [ ] **Step 2: Run** the CLI tests. Expected: FAIL.
- [ ] **Step 3: Implement** with `ask` and `backendTargets` from `src/cli/health.ts`, as `src/cli/loadouts.ts` does.
- [ ] **Step 4: Run** `bun test src/cli`. Expected: PASS.
- [ ] **Step 5: Commit** "CLI: canopy coordinator, land followup and run pickup".

### Task 6: What the page needs from the server and the store

**Files:**
- Modify: `src/core/types.ts` (`LoadoutsInfo`, about line 4216)
- Modify: `src/server/kit.ts` (`loadoutsInfo`, about line 279)
- Modify: `ui/src/api.ts` (the exported `api` object), `ui/src/store.ts`
- Modify: `ui/src/components/RunSheet.tsx` (`RunPane`, about line 1281)
- Test: `src/server/kit.test.ts`, `src/server/loadout-route.test.ts`

**Interfaces:**
- Produces: `LoadoutsInfo.servers: { name: string; here: boolean }[]`, every name in the kit's `mcp` block, sorted, where `here` is false when a run on this backend would refuse the server (the same check plan 1's launch runs in `withLoadout`). Names only: no `def`, `env` or headers. A coordinator's `GET /api/loadouts` keeps answering `{base, loadouts}` only.
- Produces in `ui/src/api.ts`: `coordPlan(runId: string, tasks: Array<{title: string; repo: string; note: string; action: "ask" | "propose"}>): Promise<{ok: true}>` (`POST /api/coordinator/plan`), `pickUpFlow(flowId: string): Promise<Flow>`, `followUp(id: string, note?: string): Promise<{run: Run}>`.
- Produces in the store: `pickUpFlow(flowId: string): Promise<void>` (writes the flow into `flows` like `resumeFlow`), `followUp(id: string, note?: string): Promise<void>`, `coordAdd(runId: string, task: {...}): Promise<void>`.
- Produces: `RunPane` takes an optional `onSend?: (text: string) => Promise<void>` and `to?: string` (the composer's placeholder names whom the words go to). Without them it behaves as today.

- [ ] **Step 1: Write the failing tests:** `loadoutsInfo` lists every kit server with `here`; a server the kit keeps off this machine reads `here: false`; the coordinator's `/api/loadouts` answer has no `servers` key.
- [ ] **Step 2: Run** them. Expected: FAIL.
- [ ] **Step 3: Implement** the field, the api methods, the store actions and the `RunPane` props.
- [ ] **Step 4: Run** the two server test files and `bun run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** "Manager page plumbing: the kit's server names, pickup, follow-up and plan calls, and a RunPane that sends elsewhere".

### Task 7: `ui/src/manager.ts`, the view's rows

**Files:**
- Create: `ui/src/manager.ts`, `ui/src/manager.test.ts`

**Interfaces:**
- Consumes: `cardStatus`, `cardCarries`, `coordTurn`, `cardCounts` (`ui/src/coord.ts`); `runLanding` (`ui/src/landing.ts`); `STEP_WORD`, `gateButtons`, `gateWords` (`ui/src/flows.ts`); `isRunActive`, `isFlowActive`.
- Produces:

```ts
export type Tone = "sky" | "lichen" | "moss" | "rust" | "hair";
export interface Arc { label: string; tone: Tone }
export interface Ring { id: string; title: string; repo: string | null; word: string; tone: Tone; model: string | null; arcs: Arc[]; at: string | null; wave: number }
export type NeedKind = "prompt" | "gate" | "landing" | "cards";
export interface Need { key: string; kind: NeedKind; card: string | null; who: string; what: string; detail: string; since: number; runId?: string; prompt?: RunPrompt; flowId?: string; landingId?: string; canLand?: boolean }
export type SayTarget = { kind: "steer"; runId: string } | { kind: "followup"; landingId: string } | { kind: "none"; why: string };
export interface Lane { id: string; title: string; word: string; tone: Tone; repo: string; branch: string | null; startedAt: number | null; live: string | null; steps: Arc[]; loadout: string | null; model: string | null; effort: string | null; skills: number; servers: number; equipTitle: string; runId: string | null; flowId: string | null; landingId: string | null; canEquip: boolean; canStartNow: boolean; canStop: boolean; canResume: boolean; say: SayTarget }
export interface Goal { text: string; model: string | null; effort: string | null; startedAt: number; working: number; waiting: number; held: boolean; ended: boolean }
export interface ManagerRows { goal: Goal; rings: Ring[]; needs: Need[]; lanes: Lane[] }
export interface ManagerInputs { runs: Record<string, Run>; flows: Record<string, Flow>; landing: LandingInfo; prs: readonly PrWatch[]; loadouts: readonly Loadout[] }
export function managerRows(coord: Run, at: ManagerInputs): ManagerRows;
export function sayTarget(task: CoordTask, run: Run | undefined, flow: Flow | undefined, landing: LandingInfo): SayTarget;
export function waves(tasks: readonly CoordTask[]): Map<string, number>;
export function liveCoordinators(runs: Record<string, Run>): Run[];
```

Rules the tests pin:
- `rings[0]` is the manager's: `id` `"manager"`, one arc per card in card order, each arc the card's tone.
- A card with a flow gets one arc per workflow step, toned by step status (running and checking sky, gated and held lichen, passed moss, failed rust, pending and skipped hair). `at` is `"2/3"` for the step in hand.
- A card with a plain run gets lifecycle arcs: `plan` (only when `action` is `propose`), `build`, `land`. Build is sky while the run is active, moss once it settled ready, rust when it failed or stopped. Land is hair until ready, lichen while the landing verdict waits for Eric or the entry was sent back, sky while the entry is in flight, moss once landed, rust once dropped.
- `waves`: a card with no `after`, or whose `after` names no card in the list, is wave 0; otherwise one more than the highest wave it names. A cycle does not loop: a card in one gets the wave it had when the cycle was found, capped at the card count.
- `needs`, oldest `since` first, then card order:
  - a prompt on a card's run, or on any step run of the card's flow (`runs[flow.steps[i].runId].prompt`), or on the coordinator itself; `since` is the run's newest step's `at`, else its `startedAt`;
  - a card flow whose status is `gated`; `since` is the gated step's run's `endedAt`, else the flow's `startedAt`;
  - a card branch whose `runLanding` says it can land with verdict `land` or `approve`, or was sent back, or waits on the judge;
  - the manager's turn: `coordTurn(coord)` non-null gives one `cards` item. Prose in a message never counts.
- `sayTarget`: an active Claude run (or the active step run of an active flow) is `steer`; an active Codex run is `none` with "a Codex worker takes no message mid-turn"; a settled card is `followup` when `followupRefusal` (Task 3, `src/core/landing.ts`) on its landing record and entry, with `busy` false, gives null, and otherwise `none` with that refusal's error; a proposed or queued card is `none` "it has not started"; a landed card is `none` "it has landed"; a gated flow is `none` "release or stop its gate first"; a stopped flow is `none` "pick its flow up first".
- A lane's `model` is `run.agentSettings?.model ?? run.equip?.model`, else the card's `equip.model`, else its loadout's model. `canEquip` for proposed and queued cards; `canStartNow` for proposed and queued cards while the goal is not held; `canStop` while its run or flow is active; `canResume` for a stopped run with a landing record or a stopped branch flow.
- `goal.text` is the coordinator's first user step's text, else its `note`; `working` counts lanes with an active run or flow; `waiting` is `needs.length`; `ended` is `!isRunActive(coord)`.
- `liveCoordinators`: active runs with `action === "coordinate"`, newest first.

- [ ] **Step 1: Write the failing tests** for each rule above with fixtures in the style of `ui/src/coord.test.ts` (`run(id, over)`, `card(over)`, a `none: LandingInfo`). Include: a gated flow card whose Fill step's run holds a question prompt gives both a `gate` item and a `prompt` item with that step run's `runId`; a queued card `after: ["t1"]` sits in wave 1; a ready card whose landing review verdict is `land` gives a `landing` item with `canLand`.
- [ ] **Step 2: Run** `bun test ui/src/manager.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the module. It imports types and pure helpers only.
- [ ] **Step 4: Run** it. Expected: PASS.
- [ ] **Step 5: Commit** "Manager: the top view's rows, rings, needs-you list and lanes as a pure helper".

### Task 8: The top view

**Files:**
- Create: `ui/src/components/ManagerView.tsx`, `ui/src/components/ManagerView.test.tsx`
- Modify: `ui/src/App.tsx` (`VIEW_GROUPS` "agents" group, `OTHER_VIEWS`, `badgeOf`, the render chain), `ui/src/components/LazyViews.tsx`, `ui/src/routes.ts` (`managerHere(search: string): string | null`), `ui/src/shortcuts.ts` (`GO` row `m`), `ui/src/components/CoordTasks.tsx` (a "top view" button in `div.coord-head`), `ui/src/styles.css`

**Interfaces:**
- Consumes: `managerRows`, `liveCoordinators`, `sayTarget` (Task 7); the store actions of Task 6 and the existing `coordHold`, `coordStart`, `coordPlanEdit`, `answerRun`, `resumeFlow`, `stopFlow`, `stopRun`, `landRun`, `sayRun`, `showRun`, `showFlow`; `RunPromptForm` (`ui/src/components/Prompts.tsx`); `RunPane` with `onSend` and `to` (Task 6).
- Produces: `export function ManagerView(): JSX.Element`, reading `run` from the URL through `managerHere(location.search)` and following `popstate`.

What it draws (the mockup's layout, in canopy's tokens):
- With no `run`, or a `run` the store does not hold: the live coordinators across backends, each a row that opens its goal (`?view=manager&run=<encodeURIComponent(id)>`), headed "Pick a goal" or, for an unknown or ended run, "This goal has ended". With exactly one live coordinator and no `run`, it opens that one.
- Goal head: the goal text, the manager's model and effort, the start time, `working` and `waiting`. Actions: hold or resume, add a task (a small form: title, repo picked from the tree, note, action; `coordAdd`), end goal (`stopRun` on the coordinator, behind a second press).
- Rings: one per card in waves (a wave label "after t1" between waves), the manager's first; each a button that selects its lane; under each: id, repo, state word, model. Draw each ring as an SVG of arc paths with a 4 degree gap, one path per arc, stroke `var(--<tone>)`; the step in hand reads in the center.
- Needs you: each item with its controls in place. A prompt renders `RunPromptForm` and answers through `answerRun(runId, promptId, answer)`. A gate shows `gateButtons(gateWords(flow))` and "stop here" (`resumeFlow`). A landing item for a ready branch offers "land" (`landRun`; when the record needs approval, open the store's approve sheet as the landing view does) and "send back" (a note box, then `followUp(landingId, note)`). A sent-back entry offers "fix it" (`fixLanding`); one waiting on the judge offers "land anyway" (`landRun` with `skipJudge`). Drop stays in the landing view. A `cards` item offers "start these" (`coordStart`). Empty: "Nothing waits on you."
- Workers: a lane per card: id, title, state word, repo, branch, elapsed; its newest step line; the step strip (`ol.step-strip` markup and classes from `FlowSheet.tsx`); the equip chips (model and effort, skills count, servers count, loadout name, with `equipTitle` as the title). Actions: say (a box; the send goes by `sayTarget`: `sayRun` for `steer`, `followUp` for `followup`; `none` disables the box and shows its reason), equip (opens `EquipSheet`, Task 9; proposed and queued only), stop (`stopRun` or `stopFlow`), resume (`followUp(landingId)` with no note, or `pickUpFlow`), start now (`coordStart(run, [id])`), open run (`showRun` or `showFlow`).
- Manager chat: `RunPane` for the coordinator, with a "to" switch: the manager (the default, `sayRun` on the coordinator) or one worker (its lane's say target).
- Wide (over 1100 px): rings across the top, then needs-you and workers in a main column beside the chat. Tablet (761 to 1100 px): one column, chat last. Phone: needs-you first, then the rings strip (sideways scroll, `scroll-snap`), then a workers/chat switch like `CoordTasks`'s on a phone; 44 px buttons.
- Entry points: the agents group's "manager" view (`g` `m`), and a "top view" button in `CoordTasks`'s head that navigates to `?view=manager&run=<encodeURIComponent(run.id)>`.

- [ ] **Step 1: Write the failing tests** in `ManagerView.test.tsx`, store seeded through `useStore.setState` as `GateButtons.test.tsx` does: a store with one coordinator and a gated card renders a `section[aria-label="needs you"]` holding the gate's buttons; a run id the store lacks renders "This goal has ended" and the live coordinators; with `matchMedia` stubbed to phone, "needs you" comes before the rings in the markup and the workers/chat switch shows. `shortcuts.test.ts` keeps passing with the `m` row. `managerHere("?view=manager&run=mini%7Ced71ddfb")` is `"mini|ed71ddfb"`.
- [ ] **Step 2: Run** the new and touched tests. Expected: FAIL.
- [ ] **Step 3: Implement** the component, the routing, the entry points and the CSS (classes prefixed `mgr-`).
- [ ] **Step 4: Run** the tests, `bun run typecheck`, `bun run lint`. Expected: PASS.
- [ ] **Step 5: Commit** "Manager: the top view at ?view=manager, on desktop, tablet and phone".

### Task 9: The equip sheet

**Files:**
- Create: `ui/src/components/EquipSheet.tsx`, `ui/src/components/EquipSheet.test.tsx`
- Modify: `ui/src/loadouts.ts` (the pure part), `ui/src/loadouts.test.ts`, `ui/src/styles.css`

**Interfaces:**
- Produces: `export function equipFrom(loadout: Loadout, picks: { model: string; effort: string; skills: readonly string[]; mcp: readonly string[] }): CardEquip` in `ui/src/loadouts.ts`: `{loadout: loadout.name}` plus only the fields that differ from the loadout's own values (skills and servers compared as sets).
- Produces: `export function EquipSheet(props: { run: Run; task: CoordTask; onDone: () => void }): JSX.Element`.

What it draws (the Equip mockup): the loadouts `loadoutsFor(task.action, kit)` offers as buttons; model and effort as segmented picks from `HARNESS[loadout.harness]`'s models and efforts; skills from `api.mentions(task.repo)` filtered to `kind === "skill"` and `harness === "claude"`, with a find box and a count; servers from `LoadoutsInfo.servers`, a server with `here: false` disabled with "not on <backend>"; a summary line; "apply to <id>" (`coordPlanEdit(run.id, task.id, {equip: equipFrom(...)})`) and "cancel". A plugin skill's row says that checking it turns on the whole plugin (plan 1 turns plugins on and off whole). A Codex loadout greys skills and servers with "a Codex worker takes model and effort only". The note under the head says a queued card takes the change when it starts. On a phone the sheet is full height.

- [ ] **Step 1: Write the failing tests:** `equipFrom` with no changes gives `{loadout: "quick"}`; with the model changed gives `{loadout: "quick", model: "sonnet"}`; skills in another order compare equal. The sheet's markup lists the loadouts, disables a server with `here: false`, and greys skills for a codex loadout.
- [ ] **Step 2: Run** them. Expected: FAIL.
- [ ] **Step 3: Implement** it, and open it from the lane's equip action in `ManagerView`.
- [ ] **Step 4: Run** the tests, typecheck and lint. Expected: PASS.
- [ ] **Step 5: Commit** "Manager: the equip sheet sets a card's loadout and its overrides".

### Task 10: Browser check, docs and the full gates

**Files:**
- Modify: `scripts/browser/check.ts`, `scripts/browser/check.sh`
- Modify: `README.md`, `SPEC.md`, `docs/architecture.md` (the coordinator section), `FEATURES.md` (FR-065), `lib/coordinator.md` if Task 1 left it short, `docs/superpowers/specs/2026-11-12-manager-design.md`, `docs/superpowers/plans/README.md`, this plan's Status line

- [ ] **Step 1: Browser check.** Add `manager` to the views the check visits. Seed the scratch config with a kept coordinator run holding three cards (one queued `after` another, one with a flow) in the run log's format (`src/core/runlog.ts`), then open `?view=manager&run=<id>` at 1440 px, 900 px and 390 px. Check: at 390 px `document.documentElement.scrollWidth <= 390`, every `.mgr button` is at least 44 px tall, needs-you comes before the rings. Save a screenshot per width.
- [ ] **Step 2: Docs.** README: the top view and the new CLI verbs. SPEC.md: the two routes and the view. architecture.md: the coordinator section gains the routes, the top view and how a card follows a follow-up. FEATURES.md FR-065: plan 3 shipped. The design doc: replace the `runs/nudge` lines in "What each steering action does" with FR-066's `runs/say`, mark phase 3 built with where it differs, and add a "Known gaps" list holding plan 2's four parked cases (a group card that later fails after "winner picked"; a landed entry pruned past `KEEP_LANDED` reads dropped; a pruned flow's card fails while its ready branch waits; a card waiting for capacity reads failed to its dependants). plans/README.md: a row for this plan, and plans 1 and 2 marked shipped 2026-11-12.
- [ ] **Step 3: Gates.** `bun run typecheck`, `bun run lint`, `bun test`, `bun run build`. Expected: all pass.
- [ ] **Step 4: Commit** "FR-065: plan 3, the top view and the steering routes; docs and the browser check".
