# Landing queue, plan 1: branch runs and the queue (FR-012)

**Status:** not started.

**Goal:** a run can work on its own branch in its own worktree, and a
finished one lands on the repo's default branch through a per-repo queue
that rebases, runs the repo's gates and fast-forwards, sending a conflict or
a red gate back to the run. Every landing takes Eric's "land". Nothing is
pushed.

**Spec:** `docs/superpowers/specs/2026-10-15-landing-queue-design.md`, the
FR-012 half and the calls of 2026-10-15. FR-013 (review rules, `autoLand`)
is plan 2, not this one.

## What is there already

- `Runner.start` (`src/core/runner.ts`) runs with `cwd: repo.path` and
  refuses a second active run per repo (`activeFor`, `busyWith`). The
  server's run route repeats the check and refuses a remote or forge repo
  (`src/server/index.ts`, the route around `state.runner.start`).
- `settle` sets `outcome: changed | unchanged` from a status fingerprint.
- Only a chat takes a next message (`say`). A job run keeps its harness
  `session` id (`Run.session`), which session move already resumes from.
- The launcher makes detached PR worktrees under `buildsRoot()` inline
  (`src/core/launcher.ts`, `worktree add --detach`, `worktree remove
  --force`, `worktree prune`).
- `runCheck` (`src/core/check.ts`) runs one shell line headless with a
  10-minute timeout and returns `{exit, output}`.
- Flows persist one JSON file each under `flowsDir()` (`src/core/flowstore.ts`),
  read back at start. The landing records follow that shape.
- Peer sync fetches `peerRefspecs(peer)` (heads and wip) and walks
  `refs/heads/` for fast-forwards (`src/core/peersync.ts`). git here is 2.47,
  so negative refspecs work.
- The inbox lists asks and advice offers (`ui/src/inbox.ts`, `inboxItems` in
  the store). Advice comes from canopy itself (`GET /api/incubator/advice`,
  the `advice` event), which is the model for sent-back entries.

## Tasks

### 1. Worktrees (`src/core/worktree.ts`)
- [ ] `addRunTree(repo, dir, branch, base)`: `worktree prune`, then
  `worktree add -b <branch> <dir> <base>`. `removeRunTree(repo, dir,
  branch)`: `worktree remove --force`, `prune`, `branch -D`. `listRunTrees`
  parses `worktree list --porcelain` for dirs under the worktrees root.
- [ ] `rebaseOnto(dir, onto)`: `{ok}` or `{conflict: files}`, aborting on a
  conflict (`diff --name-only --diff-filter=U` before `rebase --abort`).
- [ ] `fastForward(repo, branch)`: `merge --ff-only` in the main checkout;
  `{ok}`, `{busy: files}` when local changes would be overwritten, or
  `{moved}` when it is not a fast-forward.
- [ ] `aheadOf(dir, base)` and `cleanTree(dir)` for the settle states.
- [ ] Move the launcher's PR worktree add and remove onto the same helpers
  (the detached form stays detached).
- [ ] `worktree.test.ts` on a scratch repo: add, rebase clean, rebase
  conflict aborted with the files named, ff-only refused by a dirty main
  checkout, ff-only after main moved, cleanup removes dir and branch.

### 2. Gates (`src/core/gates.ts`)
- [ ] `readGates(mainPath)`: `.canopy/gates.json` `{gates: [{name, run}],
  setup?}` from the main checkout, else the `package.json` scripts
  `typecheck`, `lint`, `test`, `build` that exist, as `bun run <name>`.
  A bad file is an error the queue shows, never a silent fallback.
- [ ] `gates.test.ts`: the file, the fallback, none, a bad file, and read
  from the main checkout when the branch carries a different file.

### 3. Branch runs (`src/core/runner.ts`, `src/core/types.ts`)
- [ ] `Run.branch?: {name, base, dir, state}` with `state` one of
  `working | ready | uncommitted | nothing | stopped` (browser-safe types).
- [ ] `start(…, {branch: true})`: worktree at
  `<configDir>/worktrees/<repo key>/<run id>`, branch
  `run/<slug of the note>-<run id>` from the default branch's tip
  (`origin/HEAD`, else `main`, else `master`). The cwd is the worktree, the
  gates' `setup` runs there first, and the prompt gains the line "commit
  your work on this branch with a message that says what changed, and do
  not push."
- [ ] `activeFor` ignores branch runs; a new `branchRunsFor(repoId)` caps
  them at 3 per repo (409 past that).
- [ ] `settle` on a branch run reads `ready` (ahead, clean), `uncommitted`
  or `nothing`, beside `outcome`.
- [ ] Refused for a remote or forge repo, a workspace run (`scope`), a stage
  run and a flow step: those keep the checkout.
- [ ] Server: the run route takes `branch` (boolean). Unset means on for
  `propose` and off otherwise (call 1).
- [ ] Records: a branch run's record is saved under
  `<configDir>/landing/runs/<id>.json` at start and at each state change.
  At start canopy reads them back; a run that was working reads `stopped`
  with its worktree kept.
- [ ] Tests: a branch run's cwd and prompt line, the 3-cap, the settle
  states, a remote repo refused, `propose` on by default, records read back
  as `stopped`.

### 4. Peer sync leaves `run/*` alone (`src/core/peersync.ts`)
- [ ] `peerRefspecs` adds `^refs/heads/run/*`; the local `refs/heads/` walks
  skip `run/`; the gate's `git-upload-pack` gets
  `-c uploadpack.hideRefs=refs/heads/run/`, keeping the gate's explicit
  minimal env as it is.
- [ ] `peersync.test.ts`: a `run/x` branch on the peer is not fetched and
  not fast-forwarded.

### 5. The queue model (`src/core/landing.ts`, pure)
- [ ] Entries `{runId, repoId, branch, state, reason?, tries}` with states
  `queued | rebasing | gate:<name> | landing | landed | conflict | red |
  waiting`, and `waiting` carrying `checkout not on <branch>`, `main
  checkout busy: <files>` or `main kept moving`.
- [ ] Transitions as the spec's four steps, the 3-try limit on main moving,
  a sent-back entry leaving the queue, and a fixed run rejoining at the end.
- [ ] `landing.test.ts`: every transition, the 3-try limit, rejoin at the
  end, checkout not on the default branch, no gates says so on the entry.

### 6. The loop and routes (`src/server/landing.ts`)
- [ ] `LandingHub`: one loop per repo, entries saved under
  `<configDir>/landing/queue/<repo key>.json`, the `landing` event on every
  change.
- [ ] The gates run through `runCheck` in the worktree, one at a time, the
  last 4000 characters of a red one kept as the reason.
- [ ] Routes: `GET /api/landing` (queues, orphans), `POST /api/landing/land
  {run}` (only a `ready` run, 409 otherwise), `POST /api/landing/fix {run}`,
  `POST /api/landing/orphan {dir, action: remove | queue}`.
- [ ] "Fix it" starts a follow-up run in the same worktree that resumes the
  run's `session` with the reason as its prompt, the way session move
  resumes one. When it settles `ready` it rejoins at the end.
- [ ] Start: list `<configDir>/worktrees/`, and a worktree with no record is
  an orphan offered "remove", and "queue anyway" when clean and ahead.
- [ ] Tests: land, a conflict sent back with files, a red gate sent back
  with its tail, main moving during gates, a busy main checkout, restart
  with queued entries and an orphan.

### 7. UI
- [ ] Run sheet: a "on a branch" toggle (on for propose), then the branch,
  its commits and the state, with "land" on a `ready` run.
- [ ] Repo panel: a "landing" section with the queue and each sent-back
  entry's reason, and "remove" or "queue anyway" on an orphan.
- [ ] Card chip: queued and sent-back counts.
- [ ] Inbox: one row per sent-back entry with "fix it", fed from
  `/api/landing` and the `landing` event like advice offers.
- [ ] UI tests for the pure parts (`ui/src/landing.ts`: chip counts, row
  text, which button a state gets).

### 8. CLI
- [ ] `canopy land <run>` and `canopy queue [repo]`, painted like the
  other run commands.

### 9. Docs
- [ ] `docs/architecture.md`: a "The landing queue" section, and the runner
  and peer sync sections updated.
- [ ] `SPEC.md`: the new state under the config dir (`worktrees/`,
  `landing/`).
- [ ] `README.md`: `land` and `queue`.
- [ ] `FEATURES.md`: FR-012 to In Progress, then Shipped.

### 10. Gates and the live check
- [ ] `bun run typecheck && bun run lint && bun test && bun run build`.
- [ ] Live, on canopy itself with a scratch server: a branch run that edits
  one doc lands and main fast-forwards with nothing pushed; two branch runs
  that edit the same line, where the second comes back as a conflict; a
  branch whose test fails comes back red with the tail; a restart with one
  entry queued picks it up again.

## Risks

- `runCheck`'s 10-minute timeout may be short for a repo whose full test
  run is long. A gate that times out reads red with "timed out", and the
  timeout can become a per-gate field later.
- A fresh worktree has no ignored files. canopy's own gates need
  `node_modules`, so canopy's repo gets a `.canopy/gates.json` whose `setup`
  is `bun install --frozen-lockfile`.
