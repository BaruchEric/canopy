# Worktree stacks, plan 2: a repo's dev task in a worktree (FR-039)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Status:** in progress on branch `fr-039-plans-2-3`.

**Goal:** a branch run can run the repo's `dev` task in its own worktree on a port of its own, so Eric previews the branch running beside the main checkout. The task is started from the run sheet, the pre-flight toggle or `canopy worktrees start`, is listed under the run and never under the repo, shows up by branch in the preview's port list, and ends before its worktree goes at land, drop, a merged PR, a kept tree's removal and the sweep.

**Architecture:** a task's definition gains `env` with `${PORT}`, `${PORT_2}`, `${PORT_3}` and `${WORKTREE}` slots (pure, `core/tasks.ts`). `BranchTrees` becomes the one port allotter: kept trees and tasks both draw from `CANOPY_TREE_PORTS` through `treePort`, and what a task holds is held in `BranchTrees` beside the trees' own ports. `TaskHub` runs a task in a worktree under the repo's own record: `TaskRecord.path` stays the main checkout's path, a `tree` field says where it runs, and the term id is hashed over the worktree folder. Definitions are read from the main checkout, as `setup` is. Landing, PR and tree removal await a `stopTree` hook before the folder goes.

**Tech Stack:** Bun, TypeScript strict, React 19, bun:test. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-25-worktree-stacks-design.md`, the "Plans" list's item 2. Plan 1 is `2026-10-26-worktree-stacks-1.md`.

## What changed from the spec, and why

Kept worktrees (FR-051) shipped after the spec and already allot ports. The spec's design moves as follows.

| Spec | This plan | Why |
| --- | --- | --- |
| `allotPort` in `core/ports.ts`, new `CANOPY_TASK_PORTS` | `treePort` and `treePorts` in `core/branchtrees.ts`, `CANOPY_TREE_PORTS`, one new pure `treePortsFor` for several ports | `TREE_PORTS_DEFAULT` is already `7900-7949`, reserved for this. Two allotters on one range would hand out the same port. |
| `ports.json` beside `warm.json` | ports on the task's record in `tasks/state.json`, seeded into `BranchTrees` at start | The record already outlives a restart and says who holds the port. A second file would have to agree with it. |
| Session named `task:<repo key>:<branch id>:<name>` | term id hashed over the worktree folder and the task's name (`taskTermId`) | Sessions are named by that hash; a folder per run makes it unique. |
| `POST /api/repos/tasks/start {name, worktree}` | `POST /api/repos/tasks {action, name, worktree}` | That is the route that exists. Its rule in `callers.ts` is already `operate`, so no rights change. |
| `repoOfCwd` learns the worktrees' folders | `treeOfPort` (`core/ports.ts`), a separate `tree` field on `ListeningPort` | With the parent's `repo` id on a worktree's port, `portsFor` counts it as the repo's own and `defaultPort` can quietly preview a branch. |
| Read a port back "by the pane's pid" | read back by the listener's folder (`portUnder`) | P4: Next's listener is a child process of the pane, so the pane's pid never holds the port. The cwd matched for every server tried. |
| "the sweep's close" stops the task | the task hub's own sweep ends a task whose worktree is gone, and the sweep's `run` close ends the tasks of a branch no landing record holds | The sweep removes no worktrees (plan 1), and `heldRuns` keeps any run with a landing record out of it. See "Decisions". |

Also new since the spec: tasks in a kept tree's card. That card's repo is the tree itself, so its tasks are ordinary tasks. `${PORT}` there is the tree's own port, and removing or merging the tree stops them first.

## Probe P4 (run 2026-11-03, Mac, Bun 1.4.4, vite 8.3.2, next 15.5.4)

| Server | `--port 0` | `PORT` in the env | Where the listener is |
| --- | --- | --- | --- |
| `vite --port 0` | takes an OS port, prints it (`http://localhost:49381/`) | ignored: took 5173 with `PORT=7941` | the started process; cwd is the project |
| `next dev -p 0` | takes an OS port, prints it (`http://localhost:49509`) | honoured: `PORT=7942` listened on 7942 | a child of the started process; cwd is the project |
| `Bun.serve({port: 0})` | takes an OS port, `server.port` has it | honoured when `port` is left out: `PORT=7943` listened on 7943 | the started process |

What follows: vite needs the port on its command line, so the documented line is `vite --port $PORT --strictPort`; without `--strictPort` it moves to another port on a conflict and the allotted port stops being true. A task with no `env` is read back from `listeningPorts` by the listener's folder.

## Global constraints

- `env` is a task's field, in `.canopy/tasks.json` and canopy's layer. Names match `[A-Za-z_][A-Za-z0-9_]*`, values are one line, and a `${...}` other than `PORT`, `PORT_2` to `PORT_9` or `WORKTREE` is refused when the file is read.
- A task gets a port only by asking for one in `env`. `${PORT}` holds in all three places: the main checkout (allotted, held by the task), a run worktree (allotted, held by the task), and a kept tree's card (the tree's own port; `${PORT_2}` and up are allotted).
- One allotter. `BranchTrees.takenPorts` holds the trees' ports and what tasks hold, so neither side hands out the other's. A held port goes back when the task stops or dies with no restart coming.
- `TaskRecord.path` is always the main checkout's. `tree: {id, dir, branch}` says the task runs in a worktree. `TaskRecord` and the pane's `@canopy_worktree` option carry it across a restart.
- Definitions come from the main checkout, as `setup` does, so a run cannot change what its own start button runs. The command then runs in the worktree, where `bun run dev` reads the branch's `package.json`.
- The client names a worktree by its branch id. The server resolves the folder; a path from a client is never used.
- Worktree tasks travel apart from the repo's list: `TasksResult.trees`, and `trees` on the `tasks` event. `devTask`, `taskChip` and `taskLines` match by name, and a second `dev` in the list would corrupt them.
- A trigger's run never starts one: only the pre-flight, the run sheet and the CLI do.
- `core/ports.ts` keeps its Bun imports; nothing new from it reaches the UI. `core/tasks.ts` stays browser-safe.
- All four gates pass before a task is done.

## Review focus

1. A dev task with `keep` in a worktree that dies: it restarts in the worktree on the same port, not in the main checkout (Task 3).
2. Two starts at once: never the same port (Task 2).
3. A task in the sheet saved through the repo target keeps its `env` (Task 1).
4. Land with a dev server up: the server stops before `removeRunTree`, and a stop that fails does not undo the landing (Task 5).
5. A restart with a worktree task whose folder went while canopy was down: it is ended with a note and its port released (Task 3).
6. A worktree task's name equal to the main checkout's: both run, each with its own session, and the repo's list shows only its own (Task 3).

---

## File structure

- Modify `src/core/types.ts`: `TaskTree`, `env`, record and info fields, `TasksResult.trees`, `ListeningPort.tree`, the `tasks` event, `WorktreeRepoInfo.runs[].task`.
- Modify `src/core/tasks.ts` and test: `env` in the patch, `portSlots`, `fillEnv`, `overrideOf`, `parseTaskState`.
- Modify `src/core/tmux.ts` and test: `TaskMeta.tree`, the pane format.
- Modify `src/core/branchtrees.ts`, `src/server/branchtrees.ts` and tests: `treePortsFor`, `hold`, `release`, `seed`, `stopTree`.
- Modify `src/core/ports.ts` and test: `portUnder`, `treeOfPort`.
- Modify `src/server/tasks.ts`, new `src/server/tasks-tree.test.ts`.
- Modify `src/server/landing.ts`, `src/server/prs.ts`, `src/server/sweep.ts` and tests.
- Modify `src/server/warm.ts`: the run's task in the listing.
- Modify `src/server/index.ts`: wiring, `/api/ports`, the pre-flight flag.
- Modify `src/core/runner.ts`: `StartExtras.devTask`.
- Modify `src/cli/worktrees.ts`, its test, `src/core/help.ts`.
- Modify `ui/src/api.ts`, `ui/src/store.ts`, `ui/src/tasks.ts`, `ui/src/preview.ts` and tests, `ui/src/components/RunSheet.tsx`, `ui/src/components/Preview.tsx`.
- Modify `docs/architecture.md`, `README.md`, `SPEC.md`, the spec's Calls, `docs/superpowers/plans/README.md`.

---

### Task 1: `env` on a task

**Files:** `src/core/types.ts`, `src/core/tasks.ts`, `src/core/tasks.test.ts`, `src/server/tasks.ts` (`setDef`).

- [ ] Tests first: a good `env` survives `normalizeTaskPatch`; a bad name, a newline, a non-string value and `${NOPE}` are refused with the task's name; `portSlots` counts to the highest slot named; `fillEnv` fills `${PORT}`, `${PORT_2}` and `${WORKTREE}`; `overrideOf` keeps `env` only when it differs; `mergeTasks` lets a higher layer replace `env` whole.
- [ ] Implement. `setDef`'s repo target keeps a task's `env` when the patch names none, since the sheet does not edit it.

### Task 2: one allotter

**Files:** `src/core/branchtrees.ts`, `src/core/branchtrees.test.ts`, `src/server/branchtrees.ts`, `src/server/branchtrees.test.ts`.

```ts
/** `count` ports for `key`, walking forward from its hash past `taken`; null when the range is short */
export function treePortsFor(key: string, count: number, ports: readonly number[], taken: ReadonlySet<number>): number[] | null;

class BranchTrees {
  /** ports for a task, kept until `release`; the same owner keeps what it has */
  hold(owner: string, key: string, count: number): Promise<number[] | null>;
  release(owner: string): void;
  /** what a restart read back from the task records */
  seed(owner: string, ports: readonly number[]): void;
}
```

- [ ] Tests first: `treePortsFor` skips taken ports and answers null when short; two `hold`s at once get different ports; a held port is not given to a new tree and a tree's port is not held; a held port comes back after `release`; `hold` with the same owner answers the same ports.
- [ ] Implement. The choice and the write to `held` sit in one synchronous stretch after the `listening` await, which is what keeps two holds apart.

### Task 3: a task in a worktree

**Files:** `src/core/tmux.ts`, `src/core/tmux.test.ts`, `src/core/ports.ts`, `src/server/tasks.ts`, new `src/server/tasks-tree.test.ts`.

```ts
export interface TaskHubDeps {
  /** the one allotter (BranchTrees) */
  ports?: { hold(owner: string, key: string, count: number): Promise<number[] | null>; release(owner: string): void; seed(owner: string, ports: readonly number[]): void };
  /** a kept tree's port, by the folder a card's repo path is */
  keptPort?: (dir: string) => number | null;
  /** a run worktree of this repo, by its branch id; null when there is none */
  treeOf?: (repo: Repo, id: string) => TaskTree | null;
  /** what listens now, to read a port back */
  listening?: () => Promise<Listening[]>;
  /** said when a task's worktree went missing */
  ended?: (repoId: string, text: string) => void;
}

class TaskHub {
  /** every task in a folder, stopped and forgotten before the folder goes; the lines to report */
  endTree(dir: string): Promise<string[]>;
  /** whether anything still runs in a folder */
  busy(dir: string): boolean;
  /** starts a task in a worktree, the dev task when none is named */
  startTree(repo: Repo, tree: TaskTree, name?: string): Promise<TasksResult>;
  /** the running tasks in worktrees and what they hold, for the port list */
  treeHolds(): TreeHold[];
}
```

- [ ] Tests first, over a stand-in tmux as `tasks-hub.test.ts` does: a start with `worktree` runs in the folder with the filled `env`; its term id differs from the checkout's; it is in `trees` and not in `tasks`; a stop releases the port; a `keep` task's death restarts it in the worktree; a restart with the folder gone ends it; a dev task with no `env` is read back by folder.
- [ ] Implement `launch`'s `tree`, `stopTask`'s folder, `act`'s `worktree`, `tasksOf`'s `trees`, the hub's sweep, `recover` and the read-back.

### Task 4: the preview's name

**Files:** `src/core/ports.ts`, `src/core/ports.test.ts`, `src/server/index.ts`, `ui/src/preview.ts`, its test, `ui/src/components/Preview.tsx`.

- [ ] Tests first: `treeOfPort` names a held port `dev · run/x` and a port under a worktree's folder `run/x`, and a plain port nothing; `portsFor` lists a worktree's ports as `branches`, never `mine` or `loose`; `defaultPort` is unchanged because `mine` holds none.
- [ ] Implement and show `branches` in the port list.

### Task 5: cleanup

**Files:** `src/server/landing.ts`, `src/server/prs.ts`, `src/server/branchtrees.ts`, `src/core/branchtrees.ts` (`mergeTree`), `src/server/sweep.ts`, tests.

- [ ] Tests first: land, drop and an orphan's remove await `stopTree` before the folder goes and tell its lines to the work item; a merged PR does the same; a stop that throws does not undo a land; `removeRunTree` is refused while `busy` says so on drop; a kept tree's remove, clean and merge stop first; the sweep's run close ends the tasks of a branch with no landing record and leaves a held one alone.
- [ ] Implement.

### Task 6: where it starts

**Files:** `src/core/runner.ts`, `src/server/index.ts`, `src/server/warm.ts`, `src/cli/worktrees.ts`, its test, `src/core/help.ts`, `ui/src/api.ts`, `ui/src/store.ts`, `ui/src/tasks.ts`, its test, `ui/src/components/RunSheet.tsx`.

- [ ] Tests first: `treeTask` picks a branch's task out of the store's list; the words for its line; the CLI's `worktrees start` posts the right body and prints the port.
- [ ] Wire `treeOf`, `start`/`stop` in the CLI, the run's task in `GET /api/worktrees`, the pre-flight flag (started after `prepare`, a failure said, not thrown), and the run sheet's "run the app here", "stop" and "preview this branch".

### Task 7: docs and gates

- [ ] `docs/architecture.md` (Worktrees, Tasks), `README.md`, `SPEC.md`, the spec's Calls, the plans README.
- [ ] `bun run typecheck`, `bun run lint`, `bun test`, `bun run build`.

---

## Live check, before the branch is called done

With a scratch canopy pointed at a throwaway repo whose `.canopy/tasks.json` is `[{"name": "dev", "cmd": "bun serve.ts", "env": {"PORT": "${PORT}"}, "dev": true}]`:

1. Start a branch run, then `canopy worktrees start <branch id>`: the line prints `dev on :79xx`, and the port answers.
2. `canopy worktrees` shows the task under the run.
3. `GET /api/ports` lists the port with `tree.name` `dev · run/<branch>`.
4. Drop the branch: the session is gone before the folder, and the port is free for the next start.

## Decisions this plan makes beyond the spec

- `${PORT}` in the main checkout is allotted from the same range, held by the task. A repo that writes `env` once gets a port everywhere, which is what the spec asks.
- A task on a repo over ssh with `env` is refused: the port would be allotted on the wrong machine, and ssh repos get no branch runs.
- The pre-flight toggle is shown for one run on a branch, not for best-of-N, and starts the task after `prepare` so `node_modules` is there. A dev task that fails to start is said in the run and never fails the run.
- `canopy_task_start`, the agent's own start tool, needs FR-038's run tokens, so it is left to that work.
- The top bar does not list worktree tasks: its one action stops by repo and name, which cannot say which worktree. They show on the run sheet and in `canopy worktrees`.
- The sweep's meaning: `planSweep` offers no run with a landing record, so a live branch is never swept. What is left is a branch nothing holds, such as a PR's tree kept for unmerged work. The sweep's `run` close ends that branch's tasks; the hub's own hourly sweep ends tasks whose folder is gone. An idle dev server on a branch still waiting in the queue stays up.
- `canopy task` does not exist as a CLI verb, so the start and stop live under `canopy worktrees`.
