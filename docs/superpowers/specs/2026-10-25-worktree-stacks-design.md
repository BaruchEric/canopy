# Per-worktree runtime stacks and a warm worktree pool (FR-039)

FR-039 asks for a branch run to start in a worktree that already has its
dependencies installed, and to be able to run the repo's app in that
worktree on its own ports, so the agent (and Eric, from the preview) can see
the branch running beside the main checkout rather than only its diff. The
idea comes from Coasts and Treehouse, two of the small projects in the
software-factory lists that boot one docker-compose stack per worktree and
keep a warm pool of worktrees with `node_modules` in place. canopy has the
worktrees, the supervised tasks, the preview and the compose stack; this
spec joins them. The overview is
`2026-10-25-software-factory-borrowings-design.md`.

## Where things stand (2026-10-25)

- A branch run's worktree is cut at start: `startBranchRun` (`server/index.ts`)
  calls `addRunTree` (`core/worktree.ts`) into
  `<configDir>/worktrees/<repo key>/<run id>` on `run/<slug>-<id>` from the
  default branch's tip, then runs the gates' `setup` line there
  (`.canopy/gates.json`, `parseGatesFile`) as the run's `prepare`, under
  `gateEnv`. A fresh worktree has no ignored files, so `setup` is usually
  `bun install --frozen-lockfile` and takes its time on every start.
  `removeRunTree` removes it at land or drop; `listRunTreeDirs` finds
  orphans at adopt.
- The launcher checks PRs out as worktrees of its own under
  `<configDir>/builds/` (`core/launcher.ts`, `detachedTree`).
- Tasks are a repo's named processes (`core/tasks.ts`, `taskrun.ts`,
  `server/tasks.ts`): `.canopy/tasks.json` holds `{name, cmd, cwd?, dev?,
  keep?, withPanel?, hidden?}`, merged with manifests and canopy's per-machine
  overrides; a task runs on tmux through `startTaskSession` with
  `taskCommand` (`BROWSER=none exec sh -lc <cmd>` in the repo's folder or
  `cwd`). A `TaskDef` has no `env`; a port is whatever the command picks.
- The preview (`core/preview.ts`) proxies a loopback port the backend sees
  through one of `CANOPY_PREVIEW_PORTS` (7860-7869); `POST /api/preview
  {port}` hands out a slot; `core/ports.ts` lists what listens and
  `repoOfCwd` ties a port to a repo by its process's folder. A worktree's
  process has the worktree as its cwd, which `repoOfCwd` does not know.
- Health has a `compose` check kind (`core/repohealth.ts`), and the mini runs
  canopy itself as a compose stack (`canopy`, `shells`, `stages`, `coord`,
  `coord-proxy`, `secrets`, `tunnel`), deployed by `bun run redeploy`.
- Nothing reads free disk. A worktree is made until `git` fails.

## Probes before plan 1

- **P1.** `bun install --frozen-lockfile` in a worktree whose `node_modules`
  is a copy from a sibling worktree at the same lockfile: that it is a
  no-op in well under a second, and that `bun.lock` unchanged means nothing
  to do. Same for `npm ci` and `pnpm install --frozen-lockfile` on one repo
  each, since `setup` is the repo's own line.
- **P2.** `git worktree add` then `git checkout -B run/<...> <base>` inside
  an existing worktree: that the branch moves cleanly, that ignored files
  stay, and that `git worktree list` shows the new branch for it.
- **P3.** `docker compose -p <name> up -d` twice with two project names from
  one `docker-compose.yml`: that two stacks coexist when the published ports
  come from env, and what `compose` prints when they collide. Also `docker
  compose -p <name> down -v` leaving the other stack alone.
- **P4.** `vite --port 0`, `next dev -p 0` and Bun's `serve({port: 0})`:
  which dev servers take an OS-chosen port and print it, since a task that
  does cannot be told its port in advance and must be read from
  `listeningPorts` instead.
- **P5.** Reading free bytes on a path with Bun: `statfs` through
  `node:fs`, or `df -k <dir>` parsed, on macOS and in the container.

## Design

### The warm pool

`.canopy/gates.json` gains `warm` (0–`WARM_MAX` 2, default 0): how many
prepared worktrees canopy keeps for this repo. With `warm: 1`:

- `WarmPool` (`server/warm.ts`, model in pure `core/warm.ts`) keeps
  `<configDir>/worktrees/<repo key>/warm-<n>` as a detached worktree at the
  default branch's tip with `setup` run, and a record
  `<configDir>/worktrees/<repo key>/warm.json` (`{trees: [{dir, base,
  lockfile, madeAt}]}`), written by the holder of the flows lock as the
  landing records are.
- A branch run takes a warm tree when one is there: `startBranchRun` moves
  the folder to `<run id>`, `git checkout -B run/<...> <tip>` (P2), and runs
  `setup` again only when `lockfileStamp` (the lockfile's size and mtime,
  `LOCKFILES` from `core/review.ts`'s list) differs from the record's, which
  P1 says is a no-op anyway. The run's first note says "started in a warm
  worktree" or "no warm worktree; setup ran".
- Refill: a take, a land, a drop, or the default branch moving past a warm
  tree by `WARM_BEHIND` (20 commits, `aheadOf`) or `WARM_AGE` (24 h) makes
  the pool re-cut it in the background: `removeRunTree`, `addRunTree`
  detached, `setup`. One refill at a time per backend (`WARM_AT_ONCE`), at
  `low` priority under FR-036's governor (it is `setup`'s CPU and network,
  not a model, but the hold keeps canopy quiet while Eric works), and never
  while the repo's main checkout is mid-rebase or the landing loop is in
  `landing`. A refill that fails leaves the slot empty with the error in
  `warm.json` and a `canopy:worktrees` health detail; it is tried again on
  the next tick (`WARM_RETRY` 10 min).
- Peer sync and the landing queue ignore `warm-*` as they ignore nothing
  else: `listRunTreeDirs` is taught the name, so a warm tree is never an
  orphan, and `peersync.ts` fetches no branch from it (it has none).
- Disk: a refill is refused when `freeBytes(worktreesRoot)` (P5) is under
  `WORKTREE_DISK_MIN` (5 GB), with the reason in health; a branch run still
  cuts its own tree, since Eric asked for it. Each warm tree's size is read
  at refill (`du -sk`) and shown.

### A task per worktree

A branch run may run the repo's `dev` task in its own worktree:

- `TaskDef` gains `env?: Record<string, string>` with `${PORT}` and
  `${WORKTREE}` slots, so a repo writes `{"name": "dev", "cmd": "vite --port
  $PORT", "env": {"PORT": "${PORT}"}, "dev": true}` once and it holds for the
  main checkout and every worktree. `${PORT}` is filled by `allotPort`
  (`core/ports.ts`): a port from `CANOPY_TASK_PORTS` (default `7900-7949`,
  parsed as `CANOPY_PREVIEW_PORTS` is) that nothing listens on, held per
  worktree in `warm.json`'s sibling `ports.json` until the task ends. A
  task whose command picks its own port (P4) is read back from
  `listeningPorts` by the pane's pid.
- Where it runs: `startTaskSession` with the worktree as the locator's
  path; the tmux session is `task:<repo key>:<branch id>:<name>` and its
  `TaskMeta` carries `worktree: <dir>`, so `parseTaskPanes` lists it apart
  from the checkout's task and the panel shows it under the run, not the
  repo. `cwd` stays inside the worktree.
- Who starts it: the run sheet of a branch run gets "run the app here"
  (operate; `POST /api/repos/tasks/start {name, worktree: <branch id>}`),
  the pre-flight a "start the dev task in the worktree" toggle, and an agent
  with canopy tools (FR-038) a `canopy_task_start` on its own worktree alone.
  A trigger's unattended run never starts one.
- The preview: the run sheet's "preview this branch" calls `POST
  /api/preview {port}` with the worktree task's port; the preview section's
  port list names it `dev · run/<branch>` since `repoOfCwd` learns the
  worktrees' folders from the landing records.
- The task dies with the worktree: land, drop, and the sweep's close all
  stop it first (`stopTask` in `server/tasks.ts`), and `removeRunTree`
  refuses a worktree with a live task pane until it is gone. A restart
  takes a worktree task back like any kept task, matched by its session's
  `worktree`; one whose worktree is gone is ended with a note.
- The gates stay apart: a gate runs under `gateEnv` in the worktree while
  the task runs; the task's port and env never enter the gate's env, and
  `setup` never stops or starts a task.

### A compose stack per worktree

For a repo whose `dev` task is `docker compose up` (or whose health has a
`compose` check):

- `TaskDef` gains `compose?: true`, set by hand or read when `cmd` starts
  with `docker compose`. canopy adds `-p <repo key>-<branch id>` and `env`
  with `${PORT}` (and `${PORT_2}`, `${PORT_3}` for a stack with several
  published ports, each allotted) so two stacks coexist (P3); the compose
  file reads them as `${PORT}` in its `ports:` lines, which is the repo's
  own convention to adopt.
- Cleanup is `docker compose -p <name> down -v` on land, drop and sweep,
  run with a `COMPOSE_DOWN_MS` (60 s) timeout and reported in the run
  sheet; an image is never removed.
- canopy's own stack is never touched: a repo whose path is canopy's own
  checkout on the mini (`repoKey` equals the deploy's) is refused with
  "canopy's own stack is deployed by redeploy, not run as a task", and
  `redeploy` stays the one way.
- Docker absent (the Mac without Docker Desktop running, a backend without
  it) refuses the task with the missing binary's name, as `missingHarness`
  does for an agent.

### Listing and health

- `GET /api/worktrees` (`read`): per repo, the live run worktrees (with the
  run, branch, state, any task and its port), the warm trees (base, age,
  size, lockfile stamp, refilling or error) and orphans. Also the
  `worktrees` SSE event on change.
- `canopy worktrees [repo] [--json]` prints it; `canopy worktrees warm
  <repo> [N]` sets `warm` in canopy's per-machine layer over the repo's
  file, since a clone's file must not make a machine build its dependencies
  on its own (the health model's rule); `canopy worktrees prune` removes
  orphans and stale warm trees.
- `canopy:worktrees` health check: ok with a detail of trees and free disk;
  bad under `WORKTREE_DISK_MIN` or when a refill has failed `WARM_FAILS` (3)
  times; `heal` runs `prune`.
- The landing section's head shows "1 warm" per repo, and the repo card's
  elsewhere list leaves warm trees out as it leaves run worktrees out.

### Restart

`warm.json` and `ports.json` are read at adopt with the landing records,
by the holder of the flows lock. A warm tree the record names but the disk
lacks is dropped from the record; one on disk the record lacks is removed
(it has no branch, so nothing is lost). A task pane whose worktree folder
is gone is ended.

### Security

A warm tree runs the repo's `setup` under `gateEnv` with nobody asked,
exactly as a branch run's `prepare` does today, from the main checkout's
`gates.json`, never a branch's. A worktree task runs as the checkout's does,
with the shell's env less `PRIVATE_ENV`, in a folder the agent writes: it is
the repo's own dev server, started by Eric or by a run Eric started, and
never by a trigger. A compose stack is bound to loopback by the repo's
compose file; canopy publishes nothing of its own.

## Components

- `src/core/warm.ts` (new, pure): the record, `lockfileStamp`, `stale`,
  `nextRefill`, `allotPort`, the constants.
- `src/server/warm.ts` (new): `WarmPool`, the refill loop, `freeBytes`,
  `GET /api/worktrees`, the event, the health check.
- `src/core/worktree.ts`: `takeWarm` (move and `checkout -B`), warm names in
  `listRunTreeDirs`, `du`.
- `src/core/gates.ts`: `warm` in the file.
- `src/core/tasks.ts`, `src/core/taskrun.ts`, `src/server/tasks.ts`:
  `env`, `compose`, `worktree` on a task, the start route's `worktree`,
  the stop before `removeRunTree`.
- `src/core/ports.ts`: `CANOPY_TASK_PORTS`, worktree folders in
  `repoOfCwd`.
- `src/server/index.ts`, `src/server/landing.ts`: taking a warm tree in
  `startBranchRun`, stopping the task and the stack on land and drop.
- `src/core/sweep.ts`, `src/server/sweep.ts`: the task and stack on a
  swept run.
- `src/cli/worktrees.ts` (new), `src/cli/index.ts`.
- `ui/src/components/Landing.tsx` ("1 warm"), `RunSheet.tsx` ("run the app
  here", "preview this branch", the task's line), the pre-flight toggle,
  `Preview.tsx` (the port's name), `Health.tsx`.

## Calls

Made on 2026-10-25:

1. **Warm trees are detached, not on a branch**, so peer sync, the landing
   queue and the elsewhere list have nothing to learn about them, and a
   take is one `checkout -B`.
2. **A warm tree is taken by moving the folder**, not by copying
   `node_modules` into a fresh one: a move is instant and `git` is told
   nothing new.
3. **`warm` is set per machine over the repo's file.** A clone's
   `gates.json` saying `warm: 2` must not make the mini run its `setup`
   on its own; the repo's line is a default Eric adopts, as health's
   `auto` is.
4. **Ports are allotted by canopy** from a range of its own, so two
   worktrees of one repo never fight over `5173`, and a dev server that
   picks its own port (P4) is read back rather than fought.
5. **Compose stacks publish through env the compose file reads.** canopy
   rewrites no compose file.
6. **`WORKTREE_DISK_MIN` refuses warm trees, never a run Eric starts.**

For Eric:

7. **The default range `7900-7949`** and whether the mini's compose
   publishes it (it must not; the preview reaches loopback).
8. **Whether `propose` runs should start the dev task on their own** when
   the repo has one, or only on the toggle.

## Out of scope

- A warm pool for the launcher's PR builds (they have their own folder and
  build line).
- Sharing one `node_modules` between worktrees by link (pnpm's store does
  this already; a repo that wants it writes it into `setup`).
- Running a worktree's task on another host (ssh repos get no branch runs).
- Snapshots or caching of built output beyond what the repo's own tools do.

## Testing

- `warm.test.ts`: `lockfileStamp`, `stale` by commits and by age,
  `nextRefill` with one at a time and the disk guard, `allotPort` skipping
  listeners and held ports, the record read back with a missing folder and
  an unrecorded one.
- `worktree.test.ts` on a scratch repo: a detached warm tree taken with
  `checkout -B`, ignored files kept, `listRunTreeDirs` leaving `warm-*` out
  of orphans.
- `server/warm.test.ts` over stand-in `setup` and `freeBytes`: a take then a
  refill, a refill refused under the disk floor with the health detail, a
  failed refill retried, nothing refilled during `landing`.
- `tasks.test.ts`: `env` with `${PORT}` and `${WORKTREE}` filled, `compose`
  read from the command, the `-p` name; `server/tasks.test.ts`: a worktree
  task listed under its run, stopped before `removeRunTree`, ended at
  restart when its folder is gone.
- `preview.test.ts`: a worktree's port named by its branch.
- `landing-run.test.ts`: land and drop stop the task and the stack first.
- `cli/worktrees.test.ts`: the listing, `warm`, `prune`.

## Plans

1. **The warm pool**: `warm` in `gates.json`, `WarmPool`, taking a tree in
   `startBranchRun`, `canopy worktrees`, the health check (P1, P2, P5).
2. **Tasks in worktrees**: `env`, `allotPort`, the start route's
   `worktree`, the preview's name, the run sheet's buttons, cleanup on
   land/drop/sweep (P4).
3. **Compose stacks**: `compose`, `-p`, the published-port env, `down -v`,
   the refusal for canopy's own stack (P3).
