# Cards in kept worktrees (FR-067, plan 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Status:** built 2026-11-14 (c469be43..60fb4ef5), merged to main and deployed (FR-067 in FEATURES.md).

**Goal:** A coordinator's card may carry `tree: "<branch>"`. It then runs in place in the kept worktree for that branch in its repo, one canopy finds or makes when Eric starts the card, and it settles when that run ends, outside the landing queue.

**Architecture:**
- `core/coordinator.ts` holds the pure rules: checking `tree`, the step a tree's state gives a start, the wait and settle words, and `after`.
- The hub (`server/coordinator.ts`) keeps a tree card's own wait words, settles it on its run, adopts a later run in the tree that names its coordinator, and takes Eric's follow-up through a new `POST /api/coordinator/followup`.
- `server/index.ts` finds or makes the tree through `BranchTrees`, scans the trees source when a fresh tree has no card yet, and starts an in-place run on the tree's own repo with `parent` set and never `child`. It pumps again on each `trees` event.
- The page shows "in tree <branch>", the tree's state and "open tree" on the card's lane. A settled tree card's say and resume go to the follow-up route.

**Tech Stack:** Bun, TypeScript (strict, `noUncheckedIndexedAccess`), React 19 + Zustand, bun:test, oxlint, Playwright for the browser check.

**Spec:** `docs/superpowers/specs/2026-11-13-goal-from-the-top-design.md`, Part 2, with "Constraints found". In `docs/architecture.md`, read only "The coordinator" (line 290) and the kept-trees paragraph of "Worktrees" (line 246); `grep -n '^## ' docs/architecture.md` finds them.

## Global Constraints

**The field and its words**
- The card field is `tree: "<branch>"`, checked with `isBranchName`. It names a branch of the card's own repo and is never qualified. `treeRepo` (the tree's own repo id, `trees:<repo key>/<slug>`) is set when the card's run starts; the page qualifies it.
- `validatePlan` refuses `tree` with `times` above 1, with a `workflow`, and on a card whose repo is itself a tree card.
- Words, exactly: `making tree <branch>` (queued while the tree is made), `waiting for tree <branch> to be free` (queued while another run or a merge holds it), `done in tree <branch>` (settled done), `tree <branch> failed: <why's non-empty lines joined with "; ">`, `in tree <branch>` (facts line), `open tree` (lane button).
- Only the kept trees of the coordinator's own backend count (`state.trees`).

**Running and settling**
- A tree card's run is an in-place run on the tree's repo, started with `StartExtras.parent` set and never `child`. It never goes through `startRepoRun`, whose `how.parent` sets `child` (`server/index.ts:1282`).
- A tree card holds no branch slot, mints no work item, never enters the landing queue, and counts against `COORD_AT_ONCE` (`core/coordinator.ts:16`) while its run is active.
- A tree card settled done meets `after`. `cardLanded` keeps its meaning, because `adopt` and the page's `sayTarget` read it.
- A tree card adopts only a later in-place run in its tree's repo whose `parent` is its coordinator. Eric's own runs there are never adopted.
- `GET /api/trees` (served by `BranchTrees.handle`, `server/branchtrees.ts:593`, answering `info()`) joins the coordinator's lane. `POST /api/coordinator/followup` needs operate and stays out of it.

**Everywhere**
- Never `as any`, never `!` on a map lookup, relative imports. A file the UI imports stays browser-safe (`core/coordinator.ts`, `core/treewords.ts`, `core/types.ts`).
- Tests that shell out use flags both BSD and GNU accept.
- All four gates (`bun run typecheck`, `bun run lint`, `bun test`, `bun run build`) pass at the end of every task that touches code.
- Comments and docs are plain prose with no em dashes.

## Review Focus

1. **A branch checked out elsewhere** (`tree: "main"`, or a branch another worktree holds): the card fails at once in git's words and no tree record is left. Pinned in Task 4.
2. **Eric's own run in the tree:** the card waits with the busy words and starts when his run ends; his later runs in the tree never reopen it. Pinned in Task 3 (adopt) and Task 4.
3. **A fresh tree with no card yet:** `WATCH_GIT_HINTS` (`server/index.ts:3573`) has no `""`, so the watcher never sees a worktree's `.git` file and nothing rescans. The start scans the trees source itself, and the run's `repoId` and `cwd` are the tree's, never the main checkout's. Pinned in Task 4.
4. **A tree removed or merged after its card ran:** a follow-up answers 409 with words, never a 500, and the card keeps its state. Pinned in Task 3 and Task 4.
5. **A tree that follows main while a card works in it:** `autoSync` waits instead of rebasing under the run. `treesAtWork` misses an agent waiting on its model, so active runs in a tree join `working`. Pinned in Task 2 and Task 4.

---

### Task 1: Checking `tree` on a plan

**Files:**
- Modify: `src/core/treewords.ts`. Move `isBranchName` here unchanged from `src/core/branchtrees.ts:126-139`, which pulls in Bun-only modules `core/coordinator.ts` must not import.
- Modify: `src/core/branchtrees.ts`. Re-export it on line 479 beside `removeRefusal` and `treeWords`, so `server/branchtrees.ts` and `branchtrees.test.ts` keep their imports.
- Modify: `src/core/types.ts`, `CoordTask` (:1095-1135).
- Modify: `src/core/coordinator.ts`: `PlanContext` (:44-56), `checkCard` (:115-182, called by `validatePlan` :214), `editCard` (:243), `CardCarries` and `cardCarries` (:838-860).
- Modify: the four `PlanContext` literals: `src/core/coordinator.test.ts:11` (`ctxOf`), `src/server/coordinator.test.ts:548`, `src/server/coordinator.ts:275` and `:317`.
- Modify: `src/server/coordinator.ts`, `CoordinatorDeps` (:66-109).
- Test: `src/core/coordinator.test.ts`

**Interfaces:**
- Produces:
  - `isBranchName(name: string): boolean` from `core/treewords.ts`.
  - `CoordTask.tree?: string` and `CoordTask.treeRepo?: string`.
  - `PlanContext.treeCard: (repo: string) => boolean`. `CoordinatorDeps.treeCard?: (repo: string) => boolean`; both hub literals pass `this.deps.treeCard ?? (() => false)`, and Task 4 wires the server's.
  - `CardCarries.tree?: string`, reading `in tree <branch>`.

- [x] **Step 1: Write the failing tests.** Add `treeCard: () => false` to `ctxOf`, then:

```ts
describe("a card in a kept tree", () => {
  const one = (over: Record<string, unknown>, ctx: Partial<PlanContext> = {}) => validatePlan([task({ action: "ask", ...over })], ctxOf(ctx));
  test("keeps the branch on the card", () => {
    expect(one({ tree: "feat/login" })).toEqual({ tasks: [{ title: "fix the login", repo: "web", note: "the login form drops the email", action: "ask", tree: "feat/login" }] });
  });
  test("refuses what is not a branch, and a tree with times or a workflow", () => {
    expect(one({ tree: 5 })).toEqual({ error: "tasks[0].tree must be a branch name" });
    expect(one({ tree: "has space" })).toEqual({ error: "tasks[0].tree: has space is not a branch name git accepts" });
    expect(one({ tree: "feat/x", times: 2 })).toEqual({ error: "tasks[0].tree: a card in a tree runs once, without a workflow" });
    expect(one({ tree: "feat/x", workflow: "review" }, { workflows: () => [{ name: "review", fromRepo: false }] })).toEqual({ error: "tasks[0].tree: a card in a tree runs once, without a workflow" });
  });
  test("refuses a tree on a tree card's own repo; a plain card there passes", () => {
    const ctx: Partial<PlanContext> = { known: (r) => (r === "trees:web/feat-x" ? "local" : known(r)), treeCard: (r) => r.startsWith("trees:") };
    expect(one({ repo: "trees:web/feat-x", tree: "feat/y" }, ctx)).toEqual({ error: 'tasks[0].repo: trees:web/feat-x is a kept worktree; name its repo and put the branch in "tree"' });
    expect("tasks" in one({ repo: "trees:web/feat-x" }, ctx)).toBe(true);
  });
  test("an edit keeps, clears or refuses the tree", () => {
    const t: CoordTask = { id: "t1", title: "x", repo: "web", note: "n", action: "ask", state: "proposed", tree: "feat/x" };
    expect(editCard(t, { note: "m" }, ctxOf())).toMatchObject({ task: { tree: "feat/x", note: "m" } });
    const cleared = editCard(t, { tree: null }, ctxOf());
    expect("task" in cleared ? cleared.task.tree : "refused").toBeUndefined();
    expect(editCard({ ...t, state: "queued" }, { tree: "feat/y" }, ctxOf())).toEqual({ error: "t1 is queued; only its loadout and after change" });
  });
  test("the facts line names the tree", () => {
    expect(cardCarries({ id: "t1", title: "x", repo: "web", note: "n", action: "ask", state: "queued", tree: "feat/x" }).tree).toBe("in tree feat/x");
  });
});
```

- [x] **Step 2: Run `bun test src/core/coordinator.test.ts -t "kept tree"`.** Expected: FAIL (the field is dropped; `treeCard` is not in `PlanContext`).

- [x] **Step 3: Implement.** In `checkCard`, after the files block and before `harnessRefusal`: absent passes; not a string, then not `isBranchName`, then `out.times` or `out.workflow`, then `ctx.treeCard(repo)` each return the error above in that order; else keep `out.tree`. In `editCard`, `"tree"` joins a queued card's refused keys (:246), and `tree` is carried as `files` is (`null` clears, absent keeps).

- [x] **Step 4: Run `bun test src/core/coordinator.test.ts src/core/branchtrees.test.ts src/server/coordinator.test.ts`, then `bun run typecheck`.** Expected: PASS.

- [x] **Step 5: Commit** `git commit -m "Coordinator: a card may name a kept tree by branch; isBranchName moves to treewords"`

---

### Task 2: Pure rules for starting, waiting and settling a tree card

**Files:**
- Modify: `src/core/coordinator.ts`: `mayReopen` (:317), `afterWait` (:329), `nextToStart` (:360-381, the `repoFull` read at :376), new exports beside `startNote` (:543).
- Modify: `src/core/treewords.ts` (`runsInTrees`).
- Test: `src/core/coordinator.test.ts`; Create: `src/core/treewords.test.ts`

**Interfaces:**
- Consumes: `CoordTask.tree` (Task 1).
- Produces, in `core/coordinator.ts`:
  - `treeMakingWords(branch)`, `treeBusyWords(branch)`, `treeDoneWords(branch)`: `string`. `treeFailWords(branch: string, why: string | undefined): string`, which reads `tree <branch> failed: its setup failed` when no line is left. `isTreeWait(outcome: string | undefined): boolean`, true for the making and busy words.
  - `type TreeStep = { add: true } | { wait: string } | { fail: string } | { start: true }` and `treeStep(branch: string, tree: { state: BranchTreeState; why?: string } | null, inUse: boolean): TreeStep`.
  - `afterMet(t: Pick<CoordTask, "state" | "outcome" | "tree">): boolean`: `cardLanded(t)`, or a tree card that is done. `afterWait` filters with it in place of `cardLanded`.
  - `treeSettled(run: Run, branch: string): { state: "done" | "failed"; outcome: string } | null`: `childOutcome(run)` with a done outcome replaced by the done words.
  - `treeNote(task: CoordTask, run: Run, outcome: string): string`: the four lines `settleNote` writes for a run with no branch (widen its `outcome` parameter to `string` or build them alike), then `tree: <branch>, a kept worktree; Eric merges it from there`.
- Produces, in `core/treewords.ts`: `runsInTrees(dirs: readonly string[], runs: readonly Run[], pathOf: (repoId: string) => string | undefined): Map<string, string>`, mapping each dir with an active in-place run (no `branch`) whose repo path is that dir to `run <id> (<verb>)`.

- [x] **Step 1: Write the failing tests.** In `src/core/coordinator.test.ts`, with the file's `child` helper (:79):

```ts
describe("tree cards: start, wait, settle", () => {
  const tc = (over: Partial<CoordTask> = {}): CoordTask => ({ id: "t1", title: "try it", repo: "web", note: "n", action: "ask", state: "queued", tree: "feat/x", ...over });
  const inPlace = (over: Partial<Run> = {}): Run => child({ branch: undefined, ...over });
  test("the step a tree's state gives", () => {
    expect(treeStep("feat/x", null, false)).toEqual({ add: true });
    expect(treeStep("feat/x", { state: "preparing" }, false)).toEqual({ wait: "making tree feat/x" });
    expect(treeStep("feat/x", { state: "merging" }, false)).toEqual({ wait: "waiting for tree feat/x to be free" });
    expect(treeStep("feat/x", { state: "failed", why: "setup exited 3\nbroken\n" }, false)).toEqual({ fail: "tree feat/x failed: setup exited 3; broken" });
    expect(treeStep("feat/x", { state: "failed" }, false)).toEqual({ fail: "tree feat/x failed: its setup failed" });
    expect(treeStep("feat/x", { state: "ready" }, true)).toEqual({ wait: "waiting for tree feat/x to be free" });
    expect(treeStep("feat/x", { state: "ready" }, false)).toEqual({ start: true });
  });
  test("its wait words", () => {
    expect([isTreeWait("making tree feat/x"), isTreeWait("waiting for tree feat/x to be free"), isTreeWait("waiting for a branch slot in web"), isTreeWait(undefined)]).toEqual([true, true, false, false]);
  });
  test("a full repo never holds it", () => {
    expect(nextToStart([tc(), tc({ id: "t2", tree: undefined })], { working: 0, repoFull: () => true, cards: [] }).map((t) => t.id)).toEqual(["t1"]);
  });
  test("done counts for after; cardLanded keeps its meaning; a failed tree card may reopen", () => {
    const next = tc({ id: "t2", tree: undefined, after: ["t1"] });
    const done = tc({ state: "done", outcome: "done in tree feat/x" });
    expect(afterWait(next, [done, next])).toBeNull();
    expect(cardLanded(done)).toBe(false);
    expect(afterWait(next, [tc({ state: "failed", outcome: "failed" }), next])).toEqual({ words: "waits for t1, which failed", blocked: true, reopens: "t1" });
  });
  test("settles on its run alone", () => {
    expect(treeSettled(inPlace(), "feat/x")).toEqual({ state: "done", outcome: "done in tree feat/x" });
    expect(treeSettled(inPlace({ status: "failed" }), "feat/x")).toEqual({ state: "failed", outcome: "failed" });
    expect(treeSettled(inPlace({ status: "stopped" }), "feat/x")).toEqual({ state: "failed", outcome: "stopped" });
    expect(treeSettled(inPlace({ proposalState: "turned down" }), "feat/x")).toEqual({ state: "failed", outcome: "plan turned down" });
    expect(treeSettled(inPlace({ status: "working" }), "feat/x")).toBeNull();
  });
  test("its note names the tree, not a branch to land", () => {
    expect(treeNote(tc({ state: "running", run: "c1" }), inPlace(), "done in tree feat/x")).toBe(
      ["canopy: a task you started has settled", "task t1: try it (repo web)", "outcome: done in tree feat/x", "result: Fixed the form and committed it.", "tree: feat/x, a kept worktree; Eric merges it from there"].join("\n"),
    );
  });
});
```

  In `src/core/treewords.test.ts` (Review Focus 5): dirs `["/c/trees/web/feat-x"]`; `pathOf` maps `trees:web/feat-x` to that dir and `web` to `/r/web`; runs are an active in-place `ask` run `c1` in `trees:web/feat-x`, a done one `c2` there, an active branch run `c3` there, and an active run `c4` in `web`. The map is exactly `/c/trees/web/feat-x` to `run c1 (ask)`.

- [x] **Step 2: Run `bun test src/core/coordinator.test.ts -t "tree cards" src/core/treewords.test.ts`.** Expected: FAIL (not exported).

- [x] **Step 3: Implement.** `mayReopen` is also true for a card with `tree` whose outcome is not `dropped` (a follow-up reopens it). `nextToStart` reads `repoFull` only for a card with no `tree`.

- [x] **Step 4: Run both files.** Expected: PASS.

- [x] **Step 5: Commit** `git commit -m "Coordinator: the pure rules for a tree card's start, wait, settle and after"`

---

### Task 3: The hub: queue, settling, adoption and the follow-up route

**Files:**
- Modify: `src/server/coordinator.ts`: `CoordinatorDeps` (:66-109), `waitWords` (:405), `pump` (:439-513; the busy branch :472-486 that swaps in `slotWord` (:112), and the run update :507-511), `adopt` (:569-586), `settle` (:598-632), `handle` (:988, its act list :992), new `onTrees` and `followup`.
- Modify: `src/core/callers.ts`: `"coordinator/followup"` joins the operate list (:141); `"GET /api/trees"` joins `LANES.coordinator` (:50-58).
- Test: `src/server/coordinator.test.ts`, `src/core/callers.test.ts`

**Interfaces:**
- Consumes: Task 2's words, `treeSettled`, `treeNote`, `isTreeWait`.
- Produces:
  - `CoordinatorDeps.followTree?: (coordId: string, task: CoordTask, note: string | undefined, priority: Priority) => Promise<ChildResume>`.
  - `CoordinatorHub.onTrees(): void`, which pumps each going coordinator holding a queued card with `tree`.
  - `CoordinatorHub.followup(caller: Caller | null, b: Record<string, unknown>): Promise<{ ok: true; run: Run }>`, reached as `POST /api/coordinator/followup {run, id, note?}`.
  - For a tree card, `startChild`'s `{ busy }` carries words the card keeps as its outcome.

- [x] **Step 1: Write the failing tests** in `src/server/coordinator.test.ts` with `hub()`, `coordinator()`, `said` and `sent`, overriding `startChild` to answer the tree card with an in-place child (`repoId: "trees:web/feat-x"`, no `branch`, `parent: coordId`) or a busy:
  - **Its own words.** With `full.add("web")`, a tree card answering `{ busy: "making tree feat/x" }` keeps that outcome while a plain card in `web` reads `waiting for a branch slot in web`. After `h.onTrees()` it still reads `making tree feat/x`. `onTrees` pumps a coordinator with a queued tree card and not one whose queued cards are all plain.
  - **Settling.** A started tree card is running with `treeRepo: "trees:web/feat-x"`. Its run ending done settles it done with `done in tree feat/x`; the note is `treeNote(card, run, "done in tree feat/x")` with the cards line under it, and `h.waiting()` is 0. Failed settles it failed with `failed`, stopped with `stopped`. A card `after: ["t1"]` starts once t1 is done.
  - **Adoption (Review Focus 2).** On a done tree card, a working run with `parent: "co1"`, `repoId: "trees:web/feat-x"` and no branch reopens it, running with that run. A run there with no `parent` changes nothing. With two tree cards on one tree, the later card takes the run.
  - **The limit.** A tree card's child ending `limited` says `canopy: task t1 (<title>) stopped at the plan's usage limit; it carries on in tree feat/x after the reset`, and `wake(() => true)` calls `resumeChild` with that card.
  - **The follow-up route** (`h.handle`). A page's `{run: "co1", id: "t1", note: "also y"}` on a done tree card calls `followTree("co1", card, "also y", "interactive")`, answers 200 `{ok: true, run}`, and sets the card running with that run. Refusals, in this order:
    - a coordinator's token: 403 `a coordinator proposes; a follow-up is Eric's`
    - a branch card: 400 `t1 is not in a tree; follow a branch card up on its branch`
    - a limited card (state `running`, `limited: 0`, its run limited and inactive): 409 `t1 carries on after the reset`
    - a card in `starting`: 409 `t1 is starting`
    - a running card whose run is working: 409 `t1's run is at work; say it to the run`
    - a proposed card: 409 `t1 is proposed; only a settled card in a tree takes a follow-up`
    - a note over 4000 characters: 400 `note must be text of at most 4000 characters`
    - `followTree` answering `{busy: "waiting for tree feat/x to be free"}`: 409 with those words
    - `followTree` throwing `tree feat/x is no longer kept in web`: 409 with those words, card unchanged (Review Focus 4)
  - **A goal ending while its tree is made** drops the queued tree card, and a later `onTrees()` calls `startChild` no more.

  In `src/core/callers.test.ts`: `needs("POST", "/api/coordinator/followup")` is `operate`; it joins the coordinator's refused list (:239); `LANES.coordinator` has `GET /api/trees`.

- [x] **Step 2: Run `bun test src/server/coordinator.test.ts src/core/callers.test.ts`.** Expected: FAIL.

- [x] **Step 3: Implement.**
  - `pump`: for a tree card, a busy that is not capacity goes into `passed` and the outcome as given, not `slotWord`; a started run's update adds `treeRepo: child.repoId`.
  - `waitWords`: for a tree card, never read `repoFull`; keep an outcome `isTreeWait` or `isCapacityWords` matches.
  - `settle`: the limited note uses the tree's words; after the limited branch a tree card settles on `treeSettled` and says `treeNote`, never reading `deps.landing` and setting no timer.
  - `adopt`, for a run with no `branch`: no `flowStep`, active, its coordinator going; candidates are cards with `tree` whose `treeRepo` is the run's `repoId`, in state running, done or failed; adopt nothing while any card of that tree is in `starting`; take the last candidate whose own run is not active, cancel its timer, set it running with the run, no outcome and no `limited`.
  - Nothing new wakes a card held by the busy words: `onRun` (:968-974) already pumps every coordinator when any run ends, Eric's included.
  - `followup`: refuse in the order listed; run the start in `this.queue` with `starting` held, taking its answer out by the side as `resumeLimited` does; on a run set the card running (no outcome, no `limited`) and `this.follow(run)`; a busy or a throw is a `CoordError` 409 with its words.

- [x] **Step 4: Run both files, then `bun run typecheck`.** Expected: PASS.

- [x] **Step 5: Commit** `git commit -m "Coordinator hub: tree cards keep their words, settle on their run, adopt a later run in the tree; POST /api/coordinator/followup"`

---

### Task 4: The server starts a tree card in its kept tree

**Files:**
- Modify: `src/server/branchtrees.ts`: `treeFor` beside `shellTree` (:260), which matches slug or branch and returns no state.
- Modify: `src/server/index.ts`:
  - `startCoordChild` (:2469-2548): a tree card goes to `startCoordTree` right after the loadout refusal and before the branch-slot count (`branchSlotsTaken` :2419). It so never reaches `startBranchRun` (:1630), `startGroup` (:1522) or `startCoordWorkflow` (:2550). The goal-files code (:2499-2509) moves into `cardFiles`, used by both paths.
  - New beside it: `cardFiles`, `treeCardFor`, `startTreeRun`, `startCoordTree`, `followCoordTree`. Hoist `resumeCoordChild`'s carry-on line (:2631) into a `const`.
  - The hub's deps (:7458-7488): `treeCard`, `followTree`, and `resumeChild` (:7462) sending a tree card to `followCoordTree` with that line.
  - The `BranchTrees` deps (:7174-7187): `broadcast` also calls `state.coordinator.onTrees()` on a `trees` event (`prepare` publishes one when it settles, `server/branchtrees.ts:333-356`); `working` (:7185) merges `runsInTrees(dirs, state.runner.list(), pathOf)` into `treesAtWork(dirs)`.
- Test: `src/server/branchtrees.test.ts`, `src/server/coordrunner.test.ts`

**Interfaces:**
- Consumes: Tasks 1-3; `BranchTrees.add(repo, branch, undefined, true)` (`server/branchtrees.ts:294`), which runs `git worktree add` before it returns, throws a `TreesError` (409 for a branch checked out elsewhere) and leaves no record on a throw; `scanOne` and `scanOpts`; `cardLoadout`, `withLoadout`, `needHarness`, `needCapacity`; `isTreeCard` and `TREES_SOURCE`.
- Produces:
  - `BranchTrees.treeFor(repoPath: string, branch: string): { slug: string; branch: string; dir: string; state: BranchTreeState; why?: string } | null`, matching `branch` exactly (never the slug); null when absent or its folder is gone.
  - `cardFiles(state, coordId, task): Promise<{ line: string | null; dirs: string[] }>`, throwing today's goal-files words.
  - `treeCardFor(state, dir): Promise<Repo | null>`: the trees source's repo at `dir`; when there is none, await `scanOne` of that source (`state.sources.find((s) => s.src.id === TREES_SOURCE)`) and look again. Never build a `Repo` by hand.
  - `startTreeRun(state, coordId, task, treeRepo: Repo, how: { message: string; spec: ActionSpec; priority: Priority; after?: Run }): Promise<ChildResume>`:
    - agent: `agentFor` with the card repo's path and the `job` route for the task's action, the card's loadout over it, `withLoadout` on `treeRepo`
    - refuse a propose spec on a harness other than claude (`plan, then build needs Claude Code`), then `needHarness`
    - note: the message alone when resuming, else the message plus `\n\n` and the files line when there is one
    - resume `how.after.session` when its harness and the agent's are both claude
    - extras `{ parent: coordId, priority (unless interactive), addDirs (when any), resume (when set) }`, never `child`
    - `needCapacity` first; then the in-use check (`state.flows.activeFor(id) ?? state.runner.activeFor(id)`) and `state.runner.start(treeRepo, task.action, how.spec, note, agent, "coordinator", undefined, undefined, extras)` share one synchronous stretch after the last await, so the one-run-per-repo throw (`runner.ts:431`) never races; in use answers `{ busy: treeBusyWords }`
    - a throw releases the loadout's files; a capacity hold answers busy; anything else throws on
  - `startCoordTree(state, coordId, task, repo, priority): Promise<ChildStart>`: `treeFor`; when ready, `treeCardFor` (null throws `tree <branch> is ready, but canopy's scan does not list <dir>`) and the in-use check; then `treeStep`. Add calls `state.trees.add(repo, tree, undefined, true)` and answers the making words; when `add` throws, a tree found by `treeFor` means another add made it (the making words), else the card fails with the throw's message. Wait is busy, fail throws, start is `startTreeRun` with `ACTIONS[task.action]` and the note.
  - `followCoordTree(state, coordId, task, message: string, priority): Promise<ChildResume>`: throws `<repo> is no longer in the tree` when the card's repo is gone and `tree <branch> is no longer kept in <repo name>` when `treeFor` is null; otherwise the step as above, starting with `ACTIONS.ask` and `after` set to the card's run.
  - The hub's `followTree` passes the trimmed note, or `Carry on with the task from where you stopped.`; its `treeCard` is true for a repo in `state.result.repos` that `isTreeCard` matches.

- [x] **Step 1: Write the failing tests.**
  - `branchtrees.test.ts` (its `world()`): after `add` of `Feat/Login`, `treeFor(path, "Feat/Login")` is `preparing` with the tree's dir, then `ready` after `idle()`; `treeFor(path, "feat-login")` is null; after `remove` it is null.
  - `coordrunner.test.ts`: add `"/api/trees"` to the lane loop (:387). A new `describe("cards in kept worktrees")` on its own root (`up`'s `root` parameter) with `app` (one commit on main) and `bad` (`.canopy/gates.json` `{"gates":[],"setup":"echo broken; exit 3"}` committed), served by `up("trees", fakeRunner({ answers: true, fenced: true }), COORD_ENV, 0, ["claude"], root)`. Cards start as `startCard` does (:466-477) and end with `finish`; each test uses its own branch.
    1. **Making the tree (Review Focus 3).** `{tree: "feat/x"}` goes running; `GET /api/trees` lists `feat/x` for `app` as ready; the child's `repoId` starts with `trees:`, equals the `/api/tree` repo whose `path` is the tree's `dir`, and equals the card's `treeRepo`; its `parent` is the coordinator, `depth` and `branch` are undefined, `ctx.cwd` is the dir. `finish` settles it done with `done in tree feat/x`.
    2. **Two cards on one tree.** While t1 runs, t2 is queued with `waiting for tree feat/two to be free`; finishing t1 starts t2 with the same `ctx.cwd`.
    3. **Eric's run (Review Focus 2).** `POST /api/trees/add {repo: "app", branch: "feat/mine"}`, wait for ready, `POST /api/rescan`, wait for the tree's repo in `/api/tree`, then `POST /api/repos/run?id=<its id> {action: "ask", note: "mine"}`. A card `{tree: "feat/mine"}` stays queued with the busy words; stopping Eric's run starts it; after it settles done, another run of Eric's in the tree leaves the card done with its own run.
    4. **Checked out elsewhere (Review Focus 1).** `{tree: "main"}` fails at once with an outcome containing `main` and `already` (git says "already checked out" or "already used by worktree"); `GET /api/trees` lists no tree on `main`.
    5. **A failed setup.** `{repo: "bad", tree: "feat/bad"}` fails with an outcome starting `tree feat/bad failed: setup exited 3`.
    6. **Follow-up and a removed tree (Review Focus 4).** After a card on `feat/f` settles done, the page's `POST /api/coordinator/followup {run, id: "t1", note: "also y"}` answers 200; the card runs with a new run whose `parent` is the coordinator, `ctx.cwd` is the dir, and message contains `also y`. Finish it, `POST /api/trees/remove {repo: "app", tree: "feat/f", force: true}`, and the follow-up answers 409 `tree feat/f is no longer kept in app`.
    7. **Main moving (Review Focus 5).** While a card works in `feat/s`, commit to `app`'s main; `GET /api/trees` comes to show `feat/s` with a `waiting` (`BranchTree.waiting`, `core/types.ts:1969`) starting `run ` (`until`, 10 s), and the tree's HEAD is unchanged.

- [x] **Step 2: Run `bun test src/server/branchtrees.test.ts src/server/coordrunner.test.ts -t "kept worktrees|treeFor|lane"`.** Expected: FAIL.

- [x] **Step 3: Implement** the pieces above.

- [x] **Step 4: Run `bun test src/server`, then all four gates.** Expected: PASS.

- [x] **Step 5: Commit** `git commit -m "Coordinator: a tree card makes or finds its kept tree and runs in place there with parent set"`

---

### Task 5: The page and the CLI

**Files:**
- Modify: `ui/src/qualify.ts`, `qRun`'s cards (:77-85): qualify `treeRepo`, leave `tree` plain.
- Modify: `ui/src/api.ts` (`coordFollowup` beside `coordStart` :1204); `ui/src/store.ts` (`coordFollowup` beside `followUp` :5388).
- Modify: `ui/src/manager.ts`: `SayTarget` (:40), `Lane` (:41), `ManagerInputs` (:44), `lifeArcs` (:261), `laneOf` (:462-509), new `treeSayTarget` beside `sayTarget` (:100).
- Modify: `ui/src/components/ManagerView.tsx`: `GoalView`'s inputs (:201), `sayWith` (:671), `sayHint` (:683), `LaneRow` (:726-833).
- Modify: `ui/src/components/CoordTasks.tsx` (facts line :205-229); `src/cli/coordinator.ts` (`cardLines` :82-94); `ui/src/styles.css` only if `.mgr-lane-facts .mono` does not cover the tree fact.
- Test: `ui/src/manager.test.ts`, `ui/src/qualify.test.ts`, `src/cli/coordinator.test.ts`

**Interfaces:**
- Consumes: `CoordTask.tree`/`treeRepo`, `cardCarries().tree`, `POST /api/coordinator/followup`; `repoTrees` (`ui/src/trees.ts:9`); `openView` (`ui/src/clirun.ts:35`).
- Produces:
  - `SayTarget` gains `{ kind: "tree"; coordId: string; cardId: string; branch: string }`.
  - `interface LaneTree { branch: string; state: BranchTreeState | null; cardId: string | null }`; `Lane.tree: LaneTree | null`. `state` is from `repoTrees(at.trees ?? {}, task.repo)?.trees.find((t) => t.branch === task.tree)`; `cardId` is `task.treeRepo`, else the `at.repos` repo whose `path` is that tree's `dir` on the card's backend (as `cardOf`, `ui/src/components/Trees.tsx:46-49`).
  - `ManagerInputs.trees?: Readonly<Record<string, BranchTreesInfo>>`, `ManagerInputs.repos?: readonly Repo[]`; without them a lane knows no state or card, so `App.tsx:103` stays as it is.
  - `treeSayTarget(task: CoordTask, run: Run | undefined, coord: Run): SayTarget`, in order: not started is none `it has not started`; run active is steer, or for Codex none `a Codex worker takes no message mid-turn`; `limited === 0` is none `it carries on after the reset`; coordinator ended is none `its goal has ended`; else tree.
  - `api.coordFollowup(runId: string, cardId: string, note?: string): Promise<{ ok: true; run: Run }>`, qualifying the answer as `api.followUp` does; the store's `coordFollowup(runId, cardId, note?): Promise<void>` adds the run to `s.runs`.

- [x] **Step 1: Write the failing tests.**
  - `manager.test.ts` (its `card`, `run`, `coord`, `at`, and a `BranchTree` at `/c/trees/canopy/feat-x`): a queued tree card with outcome `making tree feat/x`, given `trees` (state `preparing`) and `repos` (repo `trees:canopy/feat-x` at that dir), has lane `tree` `{ branch: "feat/x", state: "preparing", cardId: "trees:canopy/feat-x" }` and `live` `making tree feat/x`. A done tree card whose run `c1` is done (no branch) has say `{ kind: "tree", coordId: "k", cardId: "t1", branch: "feat/x" }` and `chatAim` offers its lane; `c1` stopped gives `canResume` true; `c1` working gives a steer; the coordinator ended gives none `its goal has ended`. A tree card's last arc is labelled `tree`, moss when done and hair while running.
  - `qualify.test.ts`: `qRun` turns a card's `treeRepo` `trees:app/feat-x` into `mini|trees:app/feat-x` and keeps `tree` `feat/x`.
  - `src/cli/coordinator.test.ts`: `cardLines` puts `in tree feat/x` after the files column of a card with `tree`.

- [x] **Step 2: Run `bun test ui/src/manager.test.ts ui/src/qualify.test.ts src/cli/coordinator.test.ts`.** Expected: FAIL.

- [x] **Step 3: Implement.**
  - `laneOf`: a tree card takes `treeSayTarget`; `canResume` is also true for a stopped run with a tree say. `GoalView` passes `trees: s.trees, repos: s.repos`.
  - `sayWith`'s tree case calls `coordFollowup(say.coordId, say.cardId, text)`; `sayHint` reads `say to <id>; a run in tree <branch> starts with this`.
  - `LaneRow`: the facts show `in tree <branch>` (plus ` · <state>` when not `ready`) as `.mono .mgr-tree` in place of the branch. With `lane.tree.cardId`, an **open tree** button (title `Open the tree's own card: its changes, files, tasks, preview and shells`) calls `openView("git")` then `openPanel(cardId)`, as `App.tsx:305-309` does. Resume on a tree say calls `coordFollowup` with no words, titled `Start a run in its tree where this one stopped`.
  - `CoordTasks` shows `carries.tree`, titled `runs in place in the kept tree for <branch>`. `cardLines` adds the tree column after files and grows its widths to eight.

- [x] **Step 4: Run all four gates.** Expected: PASS.

- [x] **Step 5: Commit** `git commit -m "Manager view and cards: in tree, the tree's state, open tree, and a follow-up in the tree; the CLI's tree column"`

---

### Task 6: The browser check shows a tree card's lane

**Files:**
- Modify: `scripts/browser/check.ts`: the goal fixture (:262-358), the 1440 px check (:386-407), the 390 px check (:428-455).

**Interfaces:**
- Consumes: Task 5's lane (`#mgr-lane-<id>`, `.mgr-tree`, the **open tree** button).

- [x] **Step 1: Extend the fixture.** Read each repo's `path` from `/api/tree` beside its `id`. Add card `t4`: `{ id: "t4", title: "Try the copy on a dev server", repo: repo("demo"), note: "Run the dev server and read the copy.", action: "ask", state: "queued", tree: "check/dev-server-for-the-copy-on-a-phone", outcome: "making tree check/dev-server-for-the-copy-on-a-phone" }`. In `goalPage`, fulfill `/api/trees` with one `BranchTreesInfo` whose `demo` holds that branch as `preparing`, its `dir` the `twin` repo's path so the lane finds a card to open, every `BranchTree` field filled. The fixture's comment says four cards.

- [x] **Step 2: Add the checks.** At 1440 px: 5 rings and 4 lanes (from 4 and 3), needs still 3 (a queued card raises none); `#mgr-lane-t4 .mgr-tree` reads `in tree check/dev-server-for-the-copy-on-a-phone · preparing`; the lane has **open tree**; after the screenshot, clicking it drops `view=manager` from `location.search`. At 390 px: the `.mgr-tree` right edge is within `#mgr-lane-t4`'s plus 0.5 px, the page's width check holds, and `manager-390-tree.png` shows the lane.

- [x] **Step 3: Run the check.** On the Mac, CLAUDE.md's `CANOPY_BROWSER_DIR` route with `bash scripts/browser/run.sh scripts/browser/check.ts`; elsewhere `bash scripts/browser/check.sh`. Expected: every check passes. Look at `manager-1440.png` and `manager-390-tree.png`.

- [x] **Step 4: Commit** `git commit -m "Browser check: a tree card's lane names its tree and state at 1440 px, stays inside its lane at 390 px, and open tree leaves the view"`

---

### Task 7: Docs and the coordinator's brief

**Files:**
- Modify: `lib/coordinator.md`: line 1 (a card in a kept tree runs in place there, not on a branch of its own); line 5 ("five routes" becomes "six"); "Seeing the board" (:7-12) gains `/api/trees` with `jq '[.repos[] | {repo: .repoId, trees: [.trees[] | {branch, state}]}]'`; "Planning" gains a paragraph on `"tree": "<branch>"` (use it when Eric names a worktree or a branch to keep, or the work wants a long-lived checkout such as a dev server or a branch to try by hand; name the main repo, never the tree's card; no `times` or `workflow`; cards on one tree run one after another; Eric merges the branch himself) with an example card; "Hearing back" (:56-61) gains `done in tree <branch>`, `tree <branch> failed: ...` and git's refusal of a branch checked out elsewhere.
- Modify: `docs/architecture.md`: in "The coordinator", `tree` among the plan route's card fields and the follow-up among its routes, then a `### Cards in kept worktrees` part after "A goal from the top" (the start steps and their words, why the start scans the trees source, settling and the limit carrying on in place, adoption and `after`, the follow-up route). In "Worktrees" (:246), one clause that `working` also counts active runs in a tree.
- Modify: `README.md`: the tree column in the CLI columns (:88); in the Manager bullet (:204), a card in a kept worktree (in tree, its state, open tree, say on a settled tree card).
- Modify: `SPEC.md`: `tree` and `treeRepo` among the card fields (:62); nothing else unless `grep -n -i "coordinat\|tree" SPEC.md` shows it wrong. `FEATURES.md` is the controller's.
- Test: `src/server/coordinator.test.ts`, the brief test (:539-549).

- [x] **Step 1: Write the failing test.** The brief test also expects `$CANOPY_API/api/trees` and `"tree"` in the brief; its first example plan still passes `validatePlan` (with `treeCard: () => false` from Task 1).
- [x] **Step 2: Run `bun test src/server/coordinator.test.ts -t "the brief"`.** Expected: FAIL.
- [x] **Step 3: Write the docs** in the repo's plain style.
- [x] **Step 4: Run all four gates.** Expected: PASS.
- [x] **Step 5: Commit** `git commit -m "Docs: cards in kept worktrees in the brief, architecture, README and SPEC"`
