# Incubator hardening: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** on an isolated backend canopy runs no git in a seed: every git call it makes there runs in the stages container as the token-free stage user. With that, a seed is busy only while its own stage is, so one sprout's long build no longer stalls another's transitions. The stage runner runs as root behind a group-gated socket, and the stages container is read-only with a tmpfs home.

**Architecture:**
- Task 1 adds a `git` request to the stage wire and the runner, and `StageClient.git`/`gitToFile` on canopy's side.
- Task 2 routes `git()`'s seed calls through it on an isolated backend and makes the busy rule per seed there. Its first test is the live bug: two seeds, a live stage in one, and the other's scout-to-build commit going through at once.
- Task 3 moves the ship's clone off the seed and onto a bundle.
- Task 4 keeps a mirror per seed for the peer gate, makes the gate run no git in a seed, and takes seeds out of the peer pass on an isolated backend.
- Task 5 runs the runner as root, drops each child through `setpriv`, and gates the socket on a group.
- Task 6 makes the stages container read-only.
- Task 7 is the docs and the gates.

**Tech stack:** Bun + TypeScript (strict), `bun:test`, Docker compose on the mini.

**Spec:** amendment 4 of `docs/superpowers/specs/2026-10-01-incubator-design.md`, and the residuals in `docs/superpowers/specs/2026-10-02-incubator-token-free-stages-design.md`.

**Base:** `main` at `32052f0`, branch `feat/incubator-hardening`. Another branch (phase 5, retro) edits `src/core/incubator.ts` at the same time, so this plan does not touch that file: the bug lives in `seedOps.commit` and the server's busy rule.

## Rulings made while planning

The spec amendment holds them in full; in short:

1. One general `git` request, not narrow kinds, because `git()` is the seam every seed git call already goes through. The runner runs it with `SEED_GIT_FLAGS`, an env of its own, in a seed's top folder only, and refuses a request env name off a short list.
2. A git request waits for the fence and the runner's presence like a spawn. While the runner is away or unfenced, seed git answers `SEED_AWAY`, handled like `SEED_BUSY`. No fallback to local git.
3. Per-seed busy on an isolated backend; the global rule stays on an unisolated one.
4. The ship clones a bundle. The peer gate serves a canopy-owned mirror at `<root>/.canopy-mirrors/<slug>/.git`, refuses a seed with no mirror, and runs no git in a seed on any backend.
5. On an isolated backend seeds leave the peer pass, the peer routes, the background fetch and `cloneMissing`.
6. The runner is root; children drop through `setpriv`; writability is judged from `stat` for the stage uid; the socket dir is `root:stagecaller 0750`, set at every start.
7. The stage uid stays the host uid.
8. `read_only: true` with tmpfs `/home/bun` (0700, 2 GB) and `/tmp` (1777, 1 GB); `BUN_RUNTIME_TRANSPILER_CACHE_PATH=0` for the root runner.

## Global constraints

- **Bun everywhere.** Run tests with `env -u TMUX SHELL=/bin/bash bun test`.
- **The four gates before calling it done:** `bun run typecheck && bun run lint && env -u TMUX SHELL=/bin/bash bun test && bun run build`.
- **Commits:** one per task, never amended, rebased or pushed. No backticks in messages. Each ends with a blank line and `Claude-Session: https://claude.ai/code/session_01Mr87dWwXTvcmuDtWZLM7Zu`.
- **Nothing live.** No ssh to the mini, no redeploy, no request to its address, no restart of the Mac's :7850. Everything is verified here.
- **`src/core/types.ts` and `src/core/stagewire.ts` stay browser-safe.**
- **Prose:** no em dashes, sentence case, plain words.

## Review focus

1. **No git as canopy in a seed on an isolated backend.** Every path: the scan, the watcher, the diff and commit routes, `seedOps.commit`, the ship, the mirror. A runner that is away must never send a call back to local git.
2. **Every child of a root runner drops.** Git included. Nothing the runner starts keeps root or the stagecaller group.
3. **The gate never opens a seed.** Not by its literal path, not by a suffix enter_repo probes, not through a symlink.
4. **One seed's stage holds only that seed.** And within that seed nothing canopy writes lands while the stage is alive.

---

## File structure

| File | Responsibility |
|---|---|
| `src/core/stagewire.ts` | the `git` request; `SEED_GIT_ENV`, the request env names a git request may carry |
| `src/stage/runner.ts` | the `git` handler; the `as` option (drop through `setpriv`); `writableBy` |
| `src/stage/main.ts` | root start: stage uid and gid, socket dir and socket modes |
| `src/core/stageclient.ts` | `git` and `gitToFile` |
| `src/core/exec.ts` | `setSeedGit`: `git()` routes seed calls through it; `seedGitToFile` |
| `src/core/seedgit.ts` | `SEED_AWAY`, `seedHeld`, `seedBusyFor` (the per-seed and the global rule) |
| `src/core/runner.ts` | `stageAliveIn(path)` |
| `src/core/seedmirror.ts` (new) | `bundleSeed`, `SeedMirrors`, `mirrorPath`, `MIRRORS_DIR` |
| `src/core/shipper.ts` | push and deploy clone a bundle |
| `src/core/seed.ts` | `seedOps` takes an after-commit hook (the mirror) |
| `src/core/peersync.ts` | the gate's list and seeds calls skip seeds; `cloneMissing` skips |
| `src/cli/index.ts` | the gate maps a seed path to its mirror |
| `src/core/codextrust.ts` | keeps the config's owner |
| `src/server/index.ts` | wiring |
| `Dockerfile`, `docker-compose.yml`, `src/server/compose.test.ts` | root runner, setpriv, group, read-only |
| `docs/architecture.md`, `docs/deploy.md` | docs |

---

### Task 1: the stage runner runs git in a seed

**Files:**
- Modify: `src/core/stagewire.ts`, `src/core/stagewire.test.ts`
- Modify: `src/stage/runner.ts`, `src/stage/runner.test.ts`
- Modify: `src/core/stageclient.ts`, `src/core/stageclient.test.ts`

**Interfaces:**
- `StageRequest` gains `{ t: "git"; seed: string; args: string[]; env: Record<string, string> }`.
- `SEED_GIT_ENV: readonly string[]`: `GIT_OPTIONAL_LOCKS`, `GIT_AUTHOR_NAME`, `GIT_AUTHOR_EMAIL`, `GIT_COMMITTER_NAME`, `GIT_COMMITTER_EMAIL`.
- `requestRefusal` refuses a git request whose seed is not absolute or whose env names anything off `SEED_GIT_ENV`.
- `gitEnv(own, asked, root)`: the child env for a git request.
- The runner answers a git request as a spawn: out, err and exit frames, or one refusal.
- `StageClient.git(seed, args, { timeoutMs, env })` resolves to an `ExecResult` with `away` set when the runner did not answer or refused for its fence; `gitToFile(seed, args, file, opts)` streams stdout into the file.

- [ ] **Step 1: Failing tests.**
  - stagewire: a git request parses; a non-absolute seed, or an env holding `GIT_INDEX_FILE`, is refused.
  - runner: `git rev-parse HEAD` in a real seed answers the commit; the seed's `core.fsmonitor` does not run (a marker file stays absent); `GIT_CONFIG_GLOBAL` and `HOME` reach the child as the runner's own; the seed's subfolder, a dot folder and a path outside the root are refused; an unfenced runner refuses with `fenced`; an env name off the list is refused before anything starts; an orphan sweep during a long git spares it.
  - stageclient: `git` returns stdout byte for byte; `gitToFile` writes a 1 MB stdout to the file intact; a socket nobody listens on answers `away`.
- [ ] **Step 2: Run them, see them fail.**
- [ ] **Step 3: Implement.** The runner's git handler reuses the seed check, the fence wait and `resolveProgram`; it skips the codex sweep and the settings check, which steer claude and codex, not git. It tracks the process as a run so the sweeps spare it, and ends it with `killTree` and the group, not a seed sweep.
- [ ] **Step 4: Run them, see them pass.**
- [ ] **Step 5: Commit.** `feat(stages): the stage runner runs git in a seed as the stage user, behind the fence`

### Task 2: a seed's git goes through the runner, and a seed is busy on its own

**Files:**
- Modify: `src/core/exec.ts`, `src/core/seedgit.ts`, `src/core/runner.ts`, `src/server/index.ts`
- Test: `src/server/seedrunner.test.ts` (new), `src/core/seedgit.test.ts`, `src/core/exec.test.ts`

**Interfaces:**
- `setSeedGit(hook: SeedGitHook | null)`, `SeedGitHook = { run(path, args, opts), toFile(path, args, file, opts) }`. With a hook set, `git()` on a seed path runs the busy check and the guard, then the hook, never local git.
- `SEED_AWAY`, and `seedHeld(text)`: true for `SEED_BUSY` or `SEED_AWAY`. The scan, `scheduleRefresh`, `freshStatus` and `inQuietSeed` use `seedHeld`.
- `seedBusyFor({ isolated, checks, aliveIn, aliveAny })` in seedgit.ts: per seed when isolated, any seed otherwise. `Runner.stageAliveIn(path)`.

- [ ] **Step 1: The failing test** (`src/server/seedrunner.test.ts`). A real stage runner on a temp socket (fence probe answered as blocked, writability stubbed), a server with that client, and two seeds. A held run on `beta` is active. Then:
  - `seedOps(self).commit(alpha, [".canopy/pick.json"], "scout: alpha")` resolves within a second and the commit is in alpha's log;
  - alpha's card reads a fresh status at once;
  - `seedBusy(beta)` is true and a commit in beta waits until beta's run stops.
- [ ] **Step 2: Run it, see it fail** (alpha's commit waits on beta).
- [ ] **Step 3: More tests.** exec: with a hook set, a seed path never reaches local git (the hook sees the args); an away hook answers `SEED_AWAY`; a non-seed path ignores the hook. seedgit: `seedBusyFor` both ways. Server: a runner that is away keeps a seed card's last status.
- [ ] **Step 4: Implement.** The server sets the hook whenever `stage` is set (the isolated backend), from `stageFor()`: a null client answers `SEED_AWAY`. The busy predicate becomes `seedBusyFor`.
- [ ] **Step 5: Run the suite.** The unisolated "holds every seed busy" test still passes unchanged.
- [ ] **Step 6: Commit.** `fix(incubator): a seed is busy only while its own stage is, once canopy's seed git runs through the stage runner`

### Task 3: the ship clones a bundle, never the seed

**Files:**
- Create: `src/core/seedmirror.ts`, `src/core/seedmirror.test.ts`
- Modify: `src/core/exec.ts` (`seedGitToFile`), `src/core/shipper.ts`, `src/core/shipper.test.ts`

**Interfaces:**
- `seedGitToFile(path, args, file, timeoutMs)`: through the hook when set, else guarded local git with stdout to the file.
- `bundleSeed(seedPath, file): Promise<{ head: string }>`: waits for the seed to be quiet, writes `git bundle create - --all HEAD` to the file, reads HEAD with `git bundle list-heads`, and throws on a seed with no commit.
- `ShipDeps.bundle?` (defaults to `bundleSeed`).

- [ ] **Step 1: Failing tests.** seedmirror: a bundle of a real seed clones to the same HEAD; a seed with no commit throws "has no commit yet"; a refused seed (an fsmonitor) throws the guard's reason. shipper: push clones the bundle and pushes the bundle's HEAD commit, not whatever HEAD the clone picked; deploy checks out that commit detached; neither runs anything with the seed's path as a clone source.
- [ ] **Step 2: Implement**, dropping `guardOrThrow` and `whenSeedsQuiet` from the shipper (the bundle carries both).
- [ ] **Step 3: Commit.** `feat(incubator): the ship clones a bundle of the seed, never the seed itself`

### Task 4: mirrors for the peer gate, and seeds out of the peer pass

**Files:**
- Modify: `src/core/seedmirror.ts` (`SeedMirrors`), `src/core/seed.ts` (`seedOps` after-commit hook), `src/core/peersync.ts`, `src/cli/index.ts`, `src/server/index.ts`
- Test: `src/core/seedmirror.test.ts`, `src/core/peersync.test.ts`, `src/core/peers.test.ts` (or wherever the gate is tested)

**Interfaces:**
- `MIRRORS_DIR = ".canopy-mirrors"`, `mirrorPath(root, seedPath)`.
- `SeedMirrors(root).sync(seedPath)`: one at a time per seed; a no-op while the seed's refs and HEAD match what the mirror last took and the mirror is there.
- The gate: `mirrorFor(root, path)` maps `<root>/_incubator/<slug>` and `<root>/_incubator/<slug>/.git` to the mirror; `seedReachRefusal(path, suffixes)` refuses any other path whose candidates lead into the seeds dir.
- `serveList` reports a seed with `origin: null` without git; `serveSeeds` and `serveSeed` refuse a seed.
- `PassOptions.skip?: (id) => boolean`, honoured by `syncAll` and `cloneMissing`.

- [ ] **Step 1: Failing tests.** A mirror of a real seed has its refs and HEAD; a second sync with nothing new runs no bundle; a deleted mirror comes back. The gate maps both seed path forms to the mirror and refuses a seed without one, a symlink into a seed, and a suffix that lands in one. `serveList` runs no git in a seed (a seed whose config would fail every git still lists). `cloneMissing` with `skip` clones no seed id.
- [ ] **Step 2: Implement.** The server keeps one `SeedMirrors`, syncs after `seedOps.commit`, after a seed's outcome read and at the top of each activity pass. On an isolated backend `peerable` and `fetchLocal` leave seeds out and the pass's `skip` names them.
- [ ] **Step 3: Commit.** `feat(peers): the gate serves a seed from canopy's mirror and runs no git in a seed`

### Task 5: the runner runs as root behind a group-gated socket

**Files:**
- Modify: `src/stage/runner.ts`, `src/stage/main.ts`, `src/core/codextrust.ts`, `Dockerfile`, `docker-compose.yml`
- Test: `src/stage/runner.test.ts`, `src/core/codextrust.test.ts`, `src/server/compose.test.ts`

**Interfaces:**
- `RunnerOptions.as?: { uid: number; gid: number; setpriv: string }`: every child's argv is `[setpriv, --reuid=uid, --regid=gid, --clear-groups, --no-new-privs, --, program, ...args]`.
- `writableBy(st, uid, gid): boolean`, pure; with `as` set, `resolveProgram` judges by it.
- `socketModes(dir, socket, gid)`: chown root and chmod 0750 on the dir, 0660 on the socket (main.ts, when root).

- [ ] **Step 1: Failing tests.** `writableBy` for owner, group and other bits, and for root's own files. A runner with `as` and a stand-in setpriv that records its argv starts children through it, git included. The codex sweep keeps the file's uid and gid (checked with a stubbed chown). compose: `group_add` on canopy holds `${STAGECALLER_GID:-7850}`, stages passes it as a build arg, and the stages image ends `USER root` after the writability checks, holds `setpriv`, and bakes `CANOPY_STAGE_UID`, `CANOPY_STAGE_GID` and `CANOPY_STAGE_CALLER_GID`.
- [ ] **Step 2: Implement.** main.ts refuses to start as root without a non-zero stage uid.
- [ ] **Step 3: Commit.** `feat(stages): the stage runner runs as root, drops every child, and only canopy's group reaches its socket`

### Task 6: the stages container is read-only

**Files:**
- Modify: `docker-compose.yml`, `Dockerfile`, `src/server/compose.test.ts`

- [ ] **Step 1: Failing tests.** compose: stages has `read_only: true`, a tmpfs at `/home/bun` owned by `${HOST_UID:-1000}:${HOST_GID:-1000}` with mode 0700 and a size, and one at `/tmp` with mode 1777. The stages image sets `BUN_RUNTIME_TRANSPILER_CACHE_PATH=0`.
- [ ] **Step 2: Implement.**
- [ ] **Step 3: Commit.** `feat(stages): the stages container is read-only, with a tmpfs home that lasts until it restarts`

### Task 7: the docs and the gates

**Files:**
- Modify: `docs/architecture.md`, `docs/deploy.md`, and `CLAUDE.md` only if a gotcha there became wrong.

- [ ] **Step 1:** architecture.md: the incubator section's token-free paragraph gains the seam, the per-seed rule, the bundle, the mirrors and the gate, the root runner and the read-only container.
- [ ] **Step 2:** deploy.md: the mini deploy for this branch, step by step, with what needs sudo and what Eric runs by hand, and checks after it.
- [ ] **Step 3:** The four gates.
- [ ] **Step 4: Commit.** `docs(incubator): the hardening in the architecture notes and the mini's deploy steps`

---

## After the plan: what Eric runs on the mini

The deploy docs' "Hardening (amendment 4)" steps, after this branch merges: add `STAGECALLER_GID` to `.env` only if 7850 is taken, `bun run redeploy`, then the checks (the runner's `id`, the socket dir's modes, a stage write to `/` failing, a seed card reading, a Mac peer fetch of one seed through its mirror).
