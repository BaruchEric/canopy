# Cards that make a new project (FR-067 plan 3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A coordinator card with `action: "project"` makes a new project in this backend's incubator when Eric starts it, and follows the sprout until it is live or ends.

**Architecture:** A project card holds no real repo (its `repo` is the goal anchor `~goal`) and a `sprout` id in place of a `run`. The pure rules in `src/core/coordinator.ts` check it and map a sprout's status to the card's state and words. The hub (`src/server/coordinator.ts`) starts it through a new `startProject` dep and follows it through `onSprout` and `onSproutGone`, fed by the incubator's `onChange` and `onGone`. `src/server/index.ts` builds the intake in process. The page reads the sprout it already holds in `store.sprouts` for the ring and the lane.

**Tech Stack:** Bun, TypeScript strict, React 19 + Zustand, bun:test, Playwright headless check.

**Spec:** docs/superpowers/specs/2026-11-13-goal-from-the-top-design.md, "Part 3: cards that make a new project". Plans 1 and 2 are merged on main (60fb4ef5).

## Global Constraints

- The card: `action: "project"`; the coordinator sends no `repo` (or `"~goal"`), and canopy stores `repo: GOAL_ANCHOR` (`"~goal"`, src/core/coordinator.ts:24). `title` and `note` are the idea; `files` names goal files that go along as intake files.
- `CoordTask.sprout?: string` holds the sprout's id (`sp_` + 12 hex). A project card never sets `run`, `branch`, `work`, `group`, `flow`, `tree` or `treeRepo`.
- Validation refuses on a project card: `times`, `workflow`, `tree`, any `equip`, and a `files` name whose type the incubator refuses (`inputType("", name) === null`). Words, exactly: `${at}: a project card takes no times, workflow, tree or loadout`; `${at}.files: the incubator takes audio, images, pdf, text and markdown; ${name} is none of them`.
- When the incubator cannot take a project here, validation refuses every project card with the server's own words: `NO_STAGES` (src/server/incubator.ts:107) when stages are off and the queue is live, or `notKeeping(...)`'s words when this server does not keep the incubator. `PlanContext.projects: () => string | null` answers those words or null.
- Any card whose repo is an incubator seed (`isSeedId`, src/core/sprout.ts) is refused at plan time: `${at}.repo: ${repo} is an incubator seed; a card cannot work in it`. (The leaf rule: no card builds in the new project.)
- Intake: `text` = title, a blank line, note; `urls: []`; `files` = the card's goal files read from the goal folder, each `{label: name, type: inputType("", name), data}`; `via: "coordinator"` (new in `InputVia` and `VIA_WORD`, VIA_WORD word `from a coordinator's card`).
- Status mapping (`projectStep(s: Sprout)`), exact words:
  - `clarifying` with `questions?.length` → wait, needs you: `the project waits on your answers in the incubator`
  - `approving` → wait, needs you: `the project waits on your yes in the incubator`
  - `parked` → wait, needs you: `the project is parked: ${s.parked ?? "see the incubator"}`
  - `live` → done: `live as ${s.slug}` plus `, ${s.privateRepo}` when set
  - `handed-off` → done: `handed off as ${s.slug}` plus `, ${s.privateRepo}` when set
  - `rejected` → failed: `the project was rejected`; `stopped` → failed: `the project was stopped`
  - any other status → wait: `in the incubator: ${s.status}`
  - the sprout dismissed (`onGone`) → failed: `the project was dismissed`
- A project card takes no place under `COORD_AT_ONCE`: `nextToStart` gives it need 0 and never calls `repoFull` for it; `working()` already counts it 0. The incubator's own `SPROUT_CONCURRENCY` holds it.
- `afterMet` is true for a project card in state `done`.
- A project card is never reopened, never adopted, takes no follow-up and no say: `say` is none with `its project is in the incubator; answer it there`.
- The page: the ring's arcs are the sprout's `stageStrip` (ui/src/sprouts.ts:50), one arc per stage labelled with the stage, tone `done` → moss, `now` → sky, `stuck` → lichen, `todo` → hair; the lane shows **open in incubator** (title `Open the project in the incubator`), which calls `openView("incubator")` then `useStore.getState().showSprout(sproutId)`; the facts line reads `new project` where a card's repo goes.
- Strict TypeScript, no `as any`, no `!` on map lookups; relative imports; a src/core file the page imports stays browser-safe. Prose in plain sentences with no em dashes. Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`, no backticks in messages.

## Review Focus

1. A project card on a backend whose incubator cannot start one (stages off with the queue live, or the incubator kept by another canopy): the plan is refused in the server's words, and a card already queued fails at start with the same words, never a sprout created that no one runs.
2. The sprout changes before the card holds its id (`create` awaits `onChange` before returning): the card still ends in the right state, because the start reads the sprout's status after `create` answers and `recheck` reads it again.
3. A goal file the incubator refuses (a `.json` or `.csv`): refused at plan time with the file's name, not a 415 at start.
4. The kept run record (`runlog.ts`): a coordinator with a project card ends and its run.json writes and reads back with `action: "project"`, `repo: "~goal"` and `sprout`; an old record without them still reads.
5. The Mac page showing the mini's goal: the card's `sprout` is qualified like the store's sprout keys (`mini|sp_...`), so the ring and **open in incubator** find the sprout.

---

### Task 1: The card's type, its checks, and the kept record

**Files:**
- Modify: `src/core/types.ts` (`CoordTask` :1095: `action: "propose" | "ask" | "project"`, `sprout?: string`; `InputVia` :2621 adds `"coordinator"`)
- Modify: `src/core/sprout.ts` (`VIA_WORD` :193)
- Modify: `src/core/coordinator.ts` (`PlanContext.projects`, `checkCard`, `editCard`, `cardCarries`)
- Modify: `src/core/runlog.ts` (`isRun` task validator :96, `snapshot` :177)
- Modify: `src/core/help.ts:138` (the column list: add `tree`)
- Test: `src/core/coordinator.test.ts`, `src/core/runlog.test.ts`, `src/core/sprout.test.ts`

**Interfaces:**
- Produces: `CoordTask.action` includes `"project"`; `CoordTask.sprout?: string`; `export const isProjectCard = (t: Pick<CoordTask, "action">): boolean`; `PlanContext.projects: () => string | null`; `cardCarries(task).project?: string` (`new project`).
- Every caller that passes `task.action` as a run action (index.ts `startBranchRun`, `startGroup`, `ACTIONS[...]`, `startTreeRun`, ui `ACTION_WORD`) must keep typechecking: add `export type RunCardAction = Exclude<CoordTask["action"], "project">` and narrow with `isProjectCard` at the top of each start path. Do not widen `RunAction`.

- [ ] **Step 1: Write the failing tests** in `src/core/coordinator.test.ts`, a `describe("a project card (FR-067 plan 3)")` with a context whose `projects` answers null unless a test says otherwise:
  - `{title, note, action: "project"}` with no repo passes and is stored with `repo: "~goal"`; with `repo: "~goal"` too; with any other repo it is refused `t1.repo: a project card names no repo`.
  - each of `times: 2`, `workflow: "x"`, `tree: "feat/x"`, `equip: {loadout: "quick"}` is refused `t1: a project card takes no times, workflow, tree or loadout`.
  - `files: ["notes.md", "logo.png"]` with the goal holding both passes; `files: ["data.json"]` is refused `t1.files: the incubator takes audio, images, pdf, text and markdown; data.json is none of them`.
  - `projects: () => NO` refuses the card with `t1: NO`, and a plain card in the same plan still passes.
  - a plain card with `repo: "_incubator/shop"` (known local) is refused `t1.repo: _incubator/shop is an incubator seed; a card cannot work in it`.
  - `editCard` refuses turning a proposed plain card into a project card and the reverse: `t1: a card's action cannot change to or from project`; it accepts a new title and note on a proposed project card.
  - `cardCarries` of a project card has `project: "new project"`.
  - In `src/core/runlog.test.ts`: a coordinator whose card is `{action: "project", repo: "~goal", sprout: "sp_0123456789ab", state: "done", outcome: "live as shop"}` round-trips through `snapshot` and `isRun`; the plan 2 old-record test still passes.
  - In `src/core/sprout.test.ts`: an input entry with `via: "coordinator"` passes `isInputEntry`.
- [ ] **Step 2: Run** `bun test src/core/coordinator.test.ts src/core/runlog.test.ts src/core/sprout.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** The project checks sit in `checkCard` before the repo checks (a project card skips them). The seed refusal sits after the "another host" check. `projects()` is checked for a project card after its field checks. `snapshot` keeps `sprout` through `t()`; `isRun` accepts `"project"` and `sprout` as an optional string.
- [ ] **Step 4: Run** the same files, then `bun run typecheck`. Expected: PASS (fix every caller the action union reaches by narrowing, not by casts).
- [ ] **Step 5: Commit** `Coordinator: a project card, its checks and its kept record`

### Task 2: The pure rules for starting, waiting and settling a project card

**Files:**
- Modify: `src/core/coordinator.ts` (`afterMet` :345, `mayReopen` :353, `nextToStart` :398, `startNote`/`settleNote`, new `projectStep` and its words beside the tree words :591)
- Test: `src/core/coordinator.test.ts`

**Interfaces:**
- Consumes: Task 1's `isProjectCard`, `CoordTask.sprout`.
- Produces: `export type ProjectStep = { wait: string; needsYou: boolean } | { done: string } | { fail: string }`; `export function projectStep(s: Pick<Sprout, "status" | "questions" | "parked" | "slug" | "privateRepo">): ProjectStep`; `export const PROJECT_GONE = "the project was dismissed"`; `export function projectNote(task: CoordTask, words: string, state: "waits" | "done" | "failed"): string`.

- [ ] **Step 1: Write the failing tests:** `projectStep` for every row of the Global Constraints' mapping (a clarifying sprout without questions is a plain wait, `needsYou: false`); `nextToStart` starts a queued project card while three plain cards are working and never calls `repoFull` for it (a `repoFull` that throws for `"~goal"`); `afterMet` is true for a done project card and false for a running one; `afterWait` on a card after a failed project card names it as for any card; `mayReopen` is false for a project card; `projectNote` reads `t1 (new project "<title>") <words>` for waits, and the settle and start notes name `new project` where a card's repo goes.
- [ ] **Step 2: Run** `bun test src/core/coordinator.test.ts -t "project"`. Expected: FAIL.
- [ ] **Step 3: Implement** the signatures above.
- [ ] **Step 4: Run** `bun test src/core/coordinator.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit** `Coordinator: the pure rules for a project card's start, wait and settle`

### Task 3: The hub starts and follows a project card

**Files:**
- Modify: `src/server/coordinator.ts` (`CoordinatorDeps`, `ChildStart`, `pump` :549 and its result handling :640, `waitWords` :508, `recheck` :1008, `heldStarts` :895, `followRefusal`, new `onSprout`, `onSproutGone`)
- Test: `src/server/coordinator.test.ts`

**Interfaces:**
- Consumes: Tasks 1-2.
- Produces:
  - `CoordinatorDeps.startProject?: (coordId: string, task: CoordTask) => Promise<{ sprout: Pick<Sprout, "id" | "status" | "questions" | "parked" | "slug" | "privateRepo"> }>`; with no dep, a project card fails at start `this backend cannot make a project`.
  - `CoordinatorDeps.sprout?: (id: string) => Pick<Sprout, ...the same...> | undefined`.
  - `CoordinatorDeps.projects?: () => string | null`, passed into `PlanContext.projects` in `plan()` and `edit()` (default `() => null`).
  - `onSprout(s)`: for every going coordinator's running card whose `sprout === s.id`, apply `projectStep`: a wait sets `outcome` to the words (a note to the manager the first time `needsYou` turns true for that card, through `projectNote(..., "waits")`); done sets `state: "done"` and `outcome`; fail sets `state: "failed"` and `outcome`; done and fail queue `projectNote` and pump the goal (an `after` may be met).
  - `onSproutGone(id)`: a running card holding it fails `PROJECT_GONE` with its note.
- Rules: the pump's project branch calls `startProject`, sets `{state: "running", sprout: s.id}` and applies `projectStep(s)` at once (the sprout may have moved before the card held its id). A throw fails the card with its words, as for a run. `recheck` reads `deps.sprout` for each running project card: a sprout missing fails the card `PROJECT_GONE`, else `projectStep` applies; it never reads `deps.run` for a card with no `run`. `waitWords` gives a queued project card only the held and `after` words. `heldStarts` skips project cards. `followup` refuses a project card 409 `t1 is a project; answer it in the incubator`.

- [ ] **Step 1: Write the failing tests** in a `describe("a project card (FR-067 plan 3)")` with a `projectHub(over)` built on `hub()` adding a fake `startProject` (records the task, makes a sprout `sp_000000000001`, status from a test variable) and a fake `sprout(id)` reading a map:
  - start: the card goes running with `sprout`, no `run`; with three plain cards working it still starts.
  - a sprout that is already `clarifying` with questions when `create` answers leaves the card running with the needs-you words and one note.
  - `onSprout` with `live` and `privateRepo: "BaruchEric/shop"` settles done `live as shop, BaruchEric/shop` with a note, and a card `after: ["t1"]` then starts.
  - `onSprout` with `rejected` fails it; `onSproutGone` fails a running one with `the project was dismissed`; neither touches a card in another goal.
  - `recheck` with the sprout gone fails the card; with the sprout live settles it; a running project card never fails `its run is no longer kept`.
  - `startProject` throwing `NO` fails the card with `NO`; a hub with no `startProject` fails it `this backend cannot make a project`.
  - `followup` on a project card answers 409 with the words above.
- [ ] **Step 2: Run** `bun test src/server/coordinator.test.ts -t "project card"`. Expected: FAIL.
- [ ] **Step 3: Implement** the deps and rules above.
- [ ] **Step 4: Run** `bun test src/server/coordinator.test.ts src/core/coordinator.test.ts`, then typecheck. Expected: PASS.
- [ ] **Step 5: Commit** `Coordinator hub: a project card starts a sprout and follows it to live`

### Task 4: The server makes the intake and feeds the hub

**Files:**
- Modify: `src/server/incubator.ts` (`IncubatorHub`: `takesProjects(): string | null`, answering `notKeeping(this.keeping)` unless owner, then `NO_STAGES` when `this.stages().mode === "off" && this.inc.starts()`, else null)
- Modify: `src/server/index.ts` (`startCoordProject(state, coordId, task)`, the hub's deps `startProject`, `sprout`, `projects`; the incubator's `onChange` also calls `state.coordinator.onSprout(sprout)` and `onGone` calls `state.coordinator.onSproutGone(id)`; `startCoordChild` refuses a project card that reaches it: `t1 is a project card; it starts in the incubator`)
- Modify: `src/server/coordrunner.test.ts` (`up` takes an `incubator` option passed to `startServer`)
- Test: `src/server/coordrunner.test.ts`, `src/server/incubator.test.ts`

**Interfaces:**
- Consumes: Tasks 1-3; `cardFiles`/`goalFolder` (index.ts :2541, :1814); `Incubator.create(intake)` (core/incubator.ts:423); `inputType`.
- Produces: `startCoordProject(state, coordId, task): Promise<{ sprout: Sprout }>`: refuses with `takesProjects()`'s words; reads each of the card's files from the goal folder (the same refusals as `cardFiles` when the folder or a file is gone); calls `state.incubator.inc.create({ text: `${task.title}\n\n${task.note}`, urls: [], files, via: "coordinator" })`. The `onChange` hook guards on `state.coordinator` existing, since the incubator is built before the hub.

- [ ] **Step 1: Write the failing tests.**
  - `incubator.test.ts`: `takesProjects()` is null on the owner with autostart off; `NO_STAGES` with stages off and autostart on; `notKeeping`'s words after `notKeeping(0)`.
  - `coordrunner.test.ts`, a `describe("a project card")` on the "a goal from the top" setup (a top goal with files `idea.md` and `data.json`), served with `incubator: {autostart: false, stage: null, transcribe: null, notes: null, ship: null}`:
    1. A card `{action: "project", title: "Shop", note: "a tiny shop", files: ["idea.md"]}` starts: the card is running with `sprout`; `GET /api/incubator` lists that sprout with title `Shop`, status `queued`, and inputs holding the text and `idea.md`, each with `via: "coordinator"`; the card's outcome is `in the incubator: queued`.
    2. `files: ["data.json"]` is refused at plan with the Global Constraints' words.
    3. `DELETE /api/incubator?id=<sprout>` fails the card `the project was dismissed`.
    4. A second server with `incubator: {autostart: true, stage: null}` (stages off, queue live) refuses the plan with `NO_STAGES`.
    5. The coordinator ends (`POST /api/runs/stop`); its kept run.json (under the config dir's run log) holds the card with `action: "project"`, `repo: "~goal"` and `sprout`.
- [ ] **Step 2: Run** `bun test src/server/incubator.test.ts src/server/coordrunner.test.ts -t "project"`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `bun test src/server`, then the four gates (full suite detached as the repo's docs say).
- [ ] **Step 5: Commit** `Coordinator: a project card makes its sprout in the incubator in process`

### Task 5: The page and the CLI

**Files:**
- Modify: `ui/src/qualify.ts` (`qRun` task mapping: `sprout` through `q`)
- Modify: `ui/src/manager.ts` (`whoOf`, the arcs for a project card from `stageStrip`, `cardTone` lichen while its sprout waits on Eric, `Lane.sprout: string | null`, `say` none, `cardNeeds` adds a need for a project waiting on Eric with its words and the lane to open)
- Modify: `ui/src/coord.ts` (`cardStatus`: a running project card reads `needs you` while its outcome is a needs-you wait, else `running`, with the outcome as its line)
- Modify: `ui/src/components/ManagerView.tsx` (`LaneRow`: `new project` in place of the repo, **open in incubator** in place of open run)
- Modify: `ui/src/components/CoordTasks.tsx` (`ACTION_WORD.project = "new project"`, the facts line)
- Modify: `src/cli/coordinator.ts` (`cardLines`: the repo column reads `new project` and a column `sprout <id>`)
- Test: `ui/src/qualify.test.ts`, `ui/src/manager.test.ts`, `ui/src/coord.test.ts`, `src/cli/coordinator.test.ts`

**Interfaces:**
- Consumes: Tasks 1-2 (`isProjectCard`, `projectStep`'s words, exported for the page as `PROJECT_NEEDS_YOU: readonly string[]` prefixes or an `isProjectWait(outcome): boolean` in core).
- Produces: `ManagerInputs.sprouts?: Record<string, Sprout>` (the store's), passed by `ManagerView`.

- [ ] **Step 1: Write the failing tests:** `qRun` on backend `mini` qualifies a card's `sprout` to `mini|sp_0123456789ab` and its `repo` `~goal` to `mini|~goal`; `manager.test.ts`: a running project card whose sprout is `building` has arcs from `stageStrip` (labels in order, the `now` arc sky), lane `sprout` set, say none `its project is in the incubator; answer it there`, no `runId`; a sprout `clarifying` with questions makes the card's tone lichen and adds one need; a done project card's arcs are all moss; `coord.test.ts`: `cardStatus` of a running project card waiting on answers is `needs you`; `src/cli/coordinator.test.ts`: `cardLines` shows `new project` and `sprout sp_0123456789ab`.
- [ ] **Step 2: Run** those files. Expected: FAIL.
- [ ] **Step 3: Implement.** The open button: `openView("incubator"); useStore.getState().showSprout(lane.sprout)`. A sprout the page does not hold yet (an event not arrived) shows the card's outcome words and no arcs but one hair arc labelled `incubator`.
- [ ] **Step 4: Run** `bun test ui/src src/cli`, typecheck, lint, build. Expected: PASS.
- [ ] **Step 5: Commit** `Manager view and cards: a project card's stages, needs you, and open in incubator; the CLI's sprout column`

### Task 6: The browser check shows a project card

**Files:**
- Modify: `scripts/browser/check.ts` (the goal fixture and its 1440 and 390 checks)

- [ ] **Step 1:** Add card `t5`: `{ id: "t5", title: "A shop for the copy", repo: "~goal", note: "A tiny shop.", action: "project", state: "running", sprout: "sp_0123456789ab", outcome: "the project waits on your answers in the incubator" }`, and fulfill `/api/incubator` with one sprout `sp_0123456789ab` (`status: "clarifying"`, `questions` with one question, every required `Sprout` field filled).
- [ ] **Step 2:** At 1440 px: rings and lanes each grow by one; `#mgr-lane-t5` reads `new project`, has **open in incubator** and a `needs you` chip; clicking it lands on `view=incubator` with the sprout's sheet open. At 390 px: the lane's facts stay inside it and `manager-390-project.png` shows it.
- [ ] **Step 3: Run** `bash scripts/browser/check.sh`. Expected: every check passes. Look at the screenshots.
- [ ] **Step 4: Commit** `Browser check: a project card's lane, its needs you and open in incubator at 1440 and 390 px`

### Task 7: Docs and the coordinator's brief

**Files:**
- Modify: `lib/coordinator.md` (Planning: a project card paragraph; the card fields list; Hearing back: the project words)
- Modify: `docs/architecture.md` ("The coordinator": a `### Cards that make a new project` part after the kept-worktree part), `README.md` (the Manager bullet), `SPEC.md` (card fields), `FEATURES.md` is the controller's.
- Test: `src/server/coordinator.test.ts` (the brief test)

- [ ] **Step 1:** The brief test also expects `"project"` in the brief, and its first example still passes `validatePlan` with `projects: () => null`.
- [ ] **Step 2:** Write the brief's paragraph: when to plan one (Eric asks for a new app, site or tool, or the goal needs something no repo holds), its fields (`action: "project"`, no `repo`, title and note as the idea: what it is and for whom; `files` go along), what it refuses, that it is a leaf (plan no card in the new project; that is a later goal), that it waits on Eric's answers in the incubator, and that a card with `after` on it starts once the project is live or handed off. Then architecture, README and SPEC as listed.
- [ ] **Step 3: Run** the four gates. Expected: PASS.
- [ ] **Step 4: Commit** `Docs: cards that make a new project in the brief, architecture, README and SPEC`
