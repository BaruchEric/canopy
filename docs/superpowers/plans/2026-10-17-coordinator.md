# The coordinator: one chat splits a goal into branch runs (FR-010)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Status:** built and deployed to the mini on 2026-10-17 (main 0efb28e).
Caller tokens run `enforce` on the Mac and the mini since that day, which
was the spec's gate for the merge. The fence and the lane were checked live
from inside `coord`. The first live check deployed a source-address lane,
and it did not hold, because docker-proxy rewrites every client to
192.168.48.1. The lane now uses a listener of its own (`CANOPY_COORD_PORT`).
Task 8's live run passed on 2026-10-17 with two scratch repos:
- three cards were proposed, one was edited, and they were started;
- two landed and one was sent back by a gate that always fails;
- each settle note reached the chat on its own idle turn, and a follow-up card was proposed;
- stopping the coordinator dropped the queued card, revoked the token and removed the seed folder.

From inside `coord`, the coordinator's own token got 403 on `repos/run`, `runs/say`, `coordinator/start`, `auth/approve` and `repos/diff`, and 200 on `tree` and `runs`. Shipped 2026-10-17.

**Goal:** a `coordinate` run is a chat that proposes tasks through
`POST /api/coordinator/plan`. Eric edits the cards and presses **start
these**. Each card then starts as a branch run with `Run.parent` set, at
most 3 at a time. Each child's outcome comes back into the chat as a note.
The coordinator runs isolated, on the mini only.

**Architecture:**
- `src/core/coordinator.ts` is pure: plan validation, the queue and the settle note.
- `src/server/coordinator.ts` is a `CoordinatorHub` shaped like `TriggerHub`: deps, `handle`, `onRun`.
- The coordinator's process runs through a second instance of the stage runner, in a new `coord` container. Its network rule reaches canopy's port and nothing else private. It gets `CANOPY_API` and a `coordinator` token bound to its run. That token holds `read` and `plan` and nothing more.

**Spec:** `docs/superpowers/specs/2026-10-16-coordinator-design.md`. Line
numbers below are at `8ff6cbf`.

## Global constraints

- `coordinator` callers hold `read` and `plan` (`src/core/callers.ts:25`). Every GET is `read` and `none` holds `read` too, so the spec's "read routes only" adds nothing and is not built. What matters is that no write but the plan is open to the token.
- `POST coordinator/plan` needs `plan`. `POST coordinator/tasks` (edit or remove a card) and `POST coordinator/start` (start these) need `operate`, which a coordinator does not hold.
- The plan route takes a plan only for the caller's own run: `caller.run === body.run`, and that run is a `coordinate` run that has not ended. A page or CLI (anything holding `operate`) may also post a plan for any coordinate run, which the tests use.
- At most 8 tasks per plan call and 20 per coordinator. A title is at most 120 characters, a note at most 4000. `action` is `propose` or `ask`. `repo` is a repo id this backend knows, and a local one (no remote host).
- 3 children work at once per coordinator (`FLEET_CONCURRENCY`). A child is also held while its repo has `BRANCH_RUNS_PER_REPO` branch runs, and starts when one frees.
- Children are branch runs, started like a trigger's (`startBranchRun`, `src/server/index.ts:824`). `Run.parent` holds the coordinator's id and `by` is `coordinator`.
- A child's asks go to the inbox as today. Nothing routes them to the coordinator.
- A settle note goes into the chat through `runner.say` only while the coordinator is `idle`. Notes wait in order and go one at a time, each on the next idle turn.
- Stopping the coordinator drops its queued cards (state `dropped`) and leaves running children alone.
- Runs live in memory, so `Run.tasks` and `Run.parent` die with a restart like the rest of a run. A child that a restart stopped is still sorted by the landing queue as today.
- The token is minted when the run starts and revoked when the run ends or is deleted (`CallerBook.dropRun`). At start the server drops every `coordinator` caller left in the book, since no run survives a restart.
- No isolated runner means no coordinator. When `CANOPY_COORD_SOCKET` is unset (the Mac), `coordinate` is refused with 409 "the coordinator runs only where an isolated coordinator runner is set up (docs/deploy.md, The coordinator)". `/api/about` reports `coordinator: boolean` so the UI can hide the action.
- Routing gets a `coordinate` role. With nothing set for it, it is the default agent at effort `low`. Its harness must be Claude Code.
- A coordinate run does not hold its repo. `Runner.activeFor` skips coordinate runs, and starting one skips the busy and workflow checks. One coordinate run per repo at a time. The run has `expectsChange: false`, so no outcome fingerprint reads the repo. It starts through its own `startCoordinator(state, repo, goal)`, not `startRepoRun`.
- The coordinator's process runs with `bypassPermissions`. The sandbox is the guard: it has no checkout, no canopy config, and a network that reaches canopy's port and nothing else private. Without that mode, every curl would become an inbox prompt.
- UI work follows DESIGN.md and `ui/src/styles.css` tokens. No CSS framework.

## Task 1: types, the action and the role

**Files:** `src/core/types.ts`, `src/core/actions.ts`, `src/core/route.ts`, `ui/src/agents.ts`, tests beside each.

- [ ] `CoordTask = { id: string; title: string; repo: string; note: string; action: "propose" | "ask"; state: "proposed" | "queued" | "running" | "done" | "failed" | "dropped"; run?: string; outcome?: string }`.
- [ ] `Run.parent?: string` and `Run.tasks?: CoordTask[]`. Add `"coordinate"` to `RUN_ACTIONS` (`types.ts:878`).
- [ ] Add `ACTIONS.coordinate` (`actions.ts:98-151`): mode `chat`, prompt read from `lib/coordinator.md` the way the ranger's prompt is read, plus the user's goal as the note. Add a case to `planWords` (`:155`).
- [ ] Add `coordinate` to `AGENT_ROLES` (`types.ts:761`), `ROLE_HARNESSES` and `ROLE_WORDS` (`route.ts:66-83`), and `ROLE_LABEL` and `ROLE_TITLE` (`ui/src/agents.ts:25,33`). `resolveAgent` applies a `forCoordinate` like `forSuggest` (`route.ts:256,274`): when no profile or role sets an effort for `coordinate`, the effort is `low`.
- [ ] Tests: the role resolves to effort low by default and honours a set effort. `isRunAction("coordinate")` is true. `planWords` has a case.

## Task 2: the pure coordinator logic

**Files:** `src/core/coordinator.ts` (new), `src/core/coordinator.test.ts` (new).

- [ ] `validatePlan(input: unknown, ctx: { known: (repo) => "local" | "remote" | null; have: number }): { tasks: Omit<CoordTask, "id" | "state">[] } | { error: string }`. Enforce the limits from Global constraints, and trim titles and notes. An error names the task index and the field.
- [ ] `nextToStart(tasks, ctx: { working: number; repoFull: (repo) => boolean }): CoordTask[]` returns the queued tasks to start now, in order, without passing 3 working. A task whose repo is full is skipped for this pass, and a later task in another repo may go ahead of it.
- [ ] `settleNote(task, run)` is one short user message:
  - the line "canopy: a task you started has settled";
  - the title, repo and outcome (landed, ready, sent back, failed, stopped);
  - the run's result line, cut to 600 characters;
  - the branch name and its landing state, or the PR URL.
- [ ] `childOutcome(run)` maps a settled child (status, `outcome`, `branch.state`) to the task's `done` or `failed` and to the outcome word.
- [ ] Tests for each, including: 9 tasks refused, an unknown repo, a remote repo, a bad action, 20 total, the 3-at-once cap, a full repo skipped, and note text for a landed, a sent-back and a failed child.

## Task 3: the caller rule and the run token

**Files:** `src/core/callers.ts`, `src/server/callers.ts`, `src/server/index.ts`, `src/core/runner.ts`, tests in `callers.test.ts`, `callers-route.test.ts` and `runner.test.ts`.

- [ ] RULES: `POST coordinator/plan` needs `plan`. `POST coordinator/tasks` and `coordinator/start` need `operate`. Pin all three in the route test, and add a check that a coordinator token gets 403 on `POST repos/run`, `runs/say`, `runs/stop`, `runs/answer`, `asks/answer`, `landing/*` and `auth/pair` approval.
- [ ] `Runner.start` takes an optional `env?: Record<string, string>` on its options. `runEnv` (`runner.ts:117`) merges it, and it reaches both the local spawn and the stage spawn.
- [ ] Starting a `coordinate` run mints `mint("coordinator", { label: \`coordinator ${repoId}\`, run: id })` and passes `CANOPY_TOKEN` and `CANOPY_API` (the `CANOPY_COORD_API` env value) in `env`. When the run ends or is deleted, call `CallerBook.dropRun(id)`, from the Runner's `onChange` fan-out (`index.ts:4116`). At server start, revoke every `coordinator` caller left in the book.
- [ ] Tests: the token's caller carries `run`, and `dropRun` revokes it. A restart's sweep drops a leftover coordinator caller.

## Task 4: the isolated coordinator runner

**Files:**
- `src/stage/runner.ts` and `src/core/stagewire.ts`: the env allowlist.
- `docker-compose.yml`, `Dockerfile` only if the stages target needs a change.
- `scripts/stages-fence.sh` and its test.
- `src/server/index.ts`: a second stage client.
- `docs/deploy.md`.

- [ ] The stage runner reads `CANOPY_STAGE_PASS_ENV`, a comma-separated list of extra names, from its own env. Those names are allowed through `childEnv` on top of `STAGE_PASSED_ENV`. Unset, nothing changes. Only `CANOPY_API` and `CANOPY_TOKEN` are accepted as extras; anything else is refused at startup with a log line, so a typo cannot widen the env. Test it in `stagewire.test.ts`.
- [ ] Add a compose service `coord`, built from the `stages` target. It is like `stages` with these differences:
  - `CANOPY_STAGE_ROOT=${HOST_HOME}/.local/share/canopy-coord/seeds` and `CANOPY_STAGE_SOCKET=/run/canopy-coord/runner.sock` on a `coord-sock` volume;
  - `CANOPY_STAGE_PASS_ENV=CANOPY_API,CANOPY_TOKEN`;
  - its own claude login at `${HOST_HOME}/.config/canopy-coord/claude` mounted at `/home/bun/.stage-claude`, and codex the same way;
  - no `_incubator` or `.shared` mounts, only the seeds folder;
  - network `coord-net`, bridge `br-canopy-crd`, subnet `10.250.14.0/24`, gateway `10.250.14.1`, `dns: [1.1.1.1, 9.9.9.9]` as stages has.

  The shells service does **not** join `coord-net`. A second network on shells could move canopy's default route behind the fence. Shells instead publishes `10.250.14.1:7850:7850`, canopy on the coord bridge's gateway. The fence accepts that one destination. Replies leave through host routing, not into the bridge. This was spiked on the mini on 2026-10-17 with throwaway containers and a throwaway bridge:
  - the gateway's published port answered;
  - the server container's own address, the LAN router, the tailnet address and another port on the gateway all timed out.

  For `up` to bind the published address, the network has to exist first, so `coord` must be in the same `up` as shells. Also mount the seeds folder at the same path and `coord-sock` on the canopy service. Pass it `CANOPY_COORD_SOCKET=/run/canopy-coord/runner.sock` and `CANOPY_COORD_API=http://10.250.14.1:7850`, both from `.env` and empty when unset.
- [ ] Check that canopy accepts a request on `10.250.14.1:7850`:
  - the bind address in the container;
  - any Host or origin gate (`previewHostOk`, `libraryOriginAllowed`, the DNS rebinding check).

  If a gate refuses, allow exactly the `CANOPY_COORD_API` host and add a test.
- [ ] Extend `stages-fence.sh` with the coordinator bridge. On `br-canopy-crd` the drops are the same as on stages, plus one ACCEPT ahead of them: `-i br-canopy-crd -d 10.250.14.1/32 -p tcp --dport 7850 -j ACCEPT`. IPv6 is dropped. `--apply` must stay idempotent and must put the ACCEPT above the drops, so it has to account for `-I` order. Extend the script's test (the stand-in iptables) to pin the order.
- [ ] In the server, when `CANOPY_COORD_SOCKET` is set, build a second `StageClient` on it. A `coordinate` run makes `<seeds>/<runId>` (mode 0700) and starts through that client with that cwd. Any other path refuses the action as in Global constraints. `/api/about` gets `coordinator: true` only when the socket is set and the client says hello.
- [ ] In `docs/deploy.md`, add a section "The coordinator":
  1. Make the host folders.
  2. Seed the claude login by copying `~/.config/canopy-stages/claude`.
  3. Set the `.env` names.
  4. Re-run `stages-fence.sh --install` as root.
  5. `bun run redeploy --shells --restart` (the first deploy adds a port to the shells, which recreates them).
  6. Check that a curl from the coord container reaches `http://10.250.14.1:7850/api/about` and times out on the LAN router.

## Task 5: the hub and its routes

**Files:** `src/server/coordinator.ts` (new), `src/server/coordinator.test.ts` (new), and the wiring in `src/server/index.ts`.

- [ ] `CoordinatorHub(deps)` takes these deps:
  - `run(id)` and `runs()`;
  - `startChild(coordId, task)`, which calls `startBranchRun` with `parent`;
  - `say(runId, text)`;
  - `repoFull(repo)`;
  - `known(repo)`;
  - `broadcast()`.
- [ ] Routes:
  - `POST /api/coordinator/plan {run, tasks}` validates the plan. It adds the tasks as `proposed`, with ids `t1`, `t2`, … per coordinator, and answers `{ok, added}`. An error answers 400 with the message, so the coordinator's curl sees why.
  - `POST /api/coordinator/tasks {run, id, title?, note?, repo?, action?, remove?}` edits or removes a `proposed` card, under the same limits.
  - `POST /api/coordinator/start {run}` moves every `proposed` card to `queued` and pumps.
- [ ] `onRun(run)` does three things:
  - When a child (`run.parent`) stops being active, it sets the task's state and outcome through `childOutcome`, queues its settle note and pumps.
  - When the coordinator itself goes `idle`, it says the next waiting note.
  - When the coordinator ends, it drops its queued cards and its waiting notes.
- [ ] `pump(coordId)` starts `nextToStart`. A failed start marks the task `failed` with the error as its outcome and queues a note.
- [ ] Wire it into `ServerState`, the `handle` chain (`index.ts:2582`) and the Runner's `onChange` fan-out (`:4116`). `startChild` reuses the trigger path (`:951`), so a child gets the repo's agent for its action and lands or opens a PR by the repo's PR default.
- [ ] Tests use a fake deps set:
  - start these starts 3 of 5 and queues 2;
  - a child settling starts the next and queues a note;
  - a note waits for idle;
  - stopping the coordinator drops the queued cards and leaves the children alone;
  - a plan for another run's id with a coordinator caller is refused;
  - editing a started card is refused.

## Task 6: the prompt

**Files:** `lib/coordinator.md` (new).

- [ ] Write the prompt in the voice of `lib/ranger.md`:
  - **Role.** It turns Eric's goal into at most 8 tasks, each one branch run's worth of work in one repo.
  - **Reading.** It reads with `curl -s "$CANOPY_API/api/tree"`, `/api/runs` and `/api/landing`, with `-H "X-Canopy-Token: $CANOPY_TOKEN"`.
  - **Proposing.** It proposes with `POST /api/coordinator/plan`, giving the JSON shape and one example. It checks the answer for an error and fixes the plan.
  - **Starting.** It never starts anything itself. Eric presses start these.
  - **Settle notes.** Each note says what to do next: propose follow-ups, answer Eric, or say it is done.
  - **Context.** It has no checkout of any repo, so it plans from the tree and from what Eric says. A task's note must stand alone, since the child sees only that note.

## Task 7: the UI

**Files:**
- `ui/src/components/RepoMenu.tsx`
- `ui/src/components/RunSheet.tsx`
- a new `ui/src/components/CoordTasks.tsx`
- `ui/src/store.ts`
- `ui/src/agents.ts` and `ui/src/components/AgentsView.tsx` (the role)
- `ui/src/styles.css`

- [ ] The card menu shows "coordinate" next to chat when `/api/about` says `coordinator`. It opens the same plan sheet as chat, and the note is the goal.
- [ ] In a coordinate run's sheet, `CoordTasks` sits above the composer. Each card shows:
  - the title, the repo and the note;
  - an edit form for `proposed` cards, with a remove button;
  - the state chip;
  - for a running or settled card, the child's one-line status (its newest timeline entry's summary) and its landing word (`runLanding`) or PR chip;
  - a link that opens the child's sheet.

  A **start these** button shows while any card is `proposed`.
- [ ] A child's sheet shows "started by coordinator <title>" with a link to the parent.
- [ ] The store gets `coordPlanEdit`, `coordRemove` and `coordStart`, which call the routes with the caller token like every other write.
- [ ] Run the UI typecheck and build, and test any pure helpers (the card's one-line status, its words). A browser check needs a real coordinate run, and the Mac refuses those, so it happens on the mini during Task 8's live check. Do not add a seam that runs a coordinator unsandboxed.

## Task 8: docs and the live check

- [ ] Docs:
  - `docs/architecture.md` gets a "The coordinator" section.
  - README.
  - SPEC.md, between its markers only if canopy generates them. Otherwise edit the prose.
  - FEATURES.md moves FR-010 to Shipped.
  - The spec's status line, and this plan's status line and the README row.
- [ ] Gates: `bun run typecheck && bun run lint && bun test && bun run build`.
- [ ] Live check on the mini after the deploy section's steps:
  - a goal across two scratch repos;
  - three tasks proposed, then edited, then started;
  - two land and one is sent back;
  - the coordinator proposes a follow-up from the note.
  - A curl with the coordinator's token to `POST /api/repos/run` gets 403.

## Risks

- **Fence order.** The ACCEPT must sit above the drops, or the coordinator cannot reach canopy. Worse, a misplaced ACCEPT can open more than one port. The script test pins it.
- **The claude login in `coord`.** The stages' login is a Max OAuth `.credentials.json`. A copy may be fine, but two copies that each refresh can invalidate each other if the refresh token rotates. Sharing the stages' folder is worse, because a stage could plant a hook there that runs inside the coordinator. If the copy breaks, Eric logs in once inside `coord`, and that step is his.
- **`BRANCH_RUNS_PER_REPO`.** Triggers and Eric's own branch runs share it, so a coordinator's card can wait a long time. The card says "waiting for a branch slot in <repo>".
