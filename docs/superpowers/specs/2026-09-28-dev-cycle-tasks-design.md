# The development cycle in canopy: tasks

The user wants the whole development loop inside canopy: run the app, watch its
output, its consoles and its logs, without a separate terminal or browser
devtools. That is four sub-projects, built in this order, each with its own spec:

1. **Tasks** (this spec): a repo's named processes (dev, test, typecheck, build)
   that canopy starts, stops, restarts and supervises, each with a terminal you
   can type into and a log kept on disk.
2. **Preview console**: the preview proxy injects a small script into HTML
   responses so the framed page's `console.*`, uncaught errors and failed
   requests come back to canopy, shown in one log view merged with the dev
   task's output.
3. **Gates**: typecheck, lint, test and build as an ordered set of tasks with a
   pass or fail per step, their output (tsc, eslint/biome, bun test) parsed into
   a list of `file:line` problems that open in VS Code.
4. **The loop**: the file watcher reruns the gates after an edit (debounced),
   the preview reloads when they go green, and a problems count shows on the
   card and in the feed.

Sub-projects 2 to 4 are out of scope here. Tasks are what they sit on.

## What the user asked for, and what was assumed

Said by the user: a task takes keyboard input (it is a named shell with a log);
task definitions come from both a checked-in repo file and canopy's own config,
the config overriding the repo per machine; tasks show as a panel section and
can also become a shell tab or a window of their own; a task can be flagged to
restart on failure and after a reboot, and flagged to start when its repo's
panel opens.

Assumed, not contradicted: tasks run on the backend (usually the mini) and work
from any device on the tailnet, as shells and preview do; they survive a canopy
redeploy the way shells do; own TS/Bun repos come first, Rust and Make through
the same detection.

Success: from a repo's panel you can start the dev server, see and type into its
terminal from any device, search its full log, restart it, and trust it to come
back after a crash or a reboot when flagged.

## Data model and config

A task is defined by a browser-safe type in `core/tasks.ts`:

```ts
interface TaskDef {
  name: string;        // unique per repo, ^[a-z0-9][a-z0-9._-]{0,39}$
  cmd: string;         // a shell line, run from the repo root or cwd
  cwd?: string;        // relative to the repo root, never escaping it
  dev?: boolean;       // the task the preview pairs with
  keep?: boolean;      // restart on failure and after a reboot
  withPanel?: boolean; // opening the repo's panel starts it
  hidden?: boolean;    // hides a detected task
}
```

Three layers, merged by name and field by field through the pure
`mergeTasks(detected, repoFile, override)`. Each merged task records its
`source` (`detected`, `repo` or `canopy`, the highest layer that set anything).

1. **Detected.** `detectTasks` reads `package.json` scripts, each as
   `bun run <script>` whatever lockfile the repo has (the user's always-bun
   rule), with `dev` flagged `dev: true`; `Cargo.toml` as `cargo build`,
   `cargo test` and `cargo run`; and a `Makefile`'s top-level targets, skipping
   dotted targets and pattern rules. The parsers (`parseScripts`, `parseCargo`,
   `parseMakeTargets`) are pure. Detection runs at scan time next to `meta.ts`
   and again when the tasks are read for a panel.
2. **Repo file.** `.canopy/tasks.json`, a `TaskDef[]`, checked in, so it travels
   through git and peer sync. `normalizeTaskDef` validates each entry field by
   field the way `normalizeAgent` does. A bad entry is dropped with its own
   error; a file that is not JSON is one error. Either way the other layers
   still apply, and the errors show in the section.
3. **Canopy config.** `tasks` in the config, keyed by repo path like `agents`,
   written through `setTasks`. An override equal to the layer under it is
   dropped, as `setAgent` drops an entry set back to defaults.

**The own-repo rule for auto flags.** A repo file's commands only run on a
click, but `keep` and `withPanel` would run them with none. So those two flags
from the repo file apply only when `pushAccess` (`core/access.ts`) says the repo
is the user's, the same judgement the background fetch uses. Elsewhere they are
shown as "suggested: keep" or "suggested: start with panel", and one click
copies them into the canopy layer. Flags from the canopy layer always apply.
The rule lives in `mergeTasks` as an `own: boolean` argument, so it is tested
with the merge.

**Runtime state.** The server hands the browser a `TaskInfo` per task: the
merged definition and its `source`, any `suggested` flags, `termId`, `status`
(`idle | running | exited | failed | backoff | gave-up`), `startedAt`,
`exitedAt`, `exitCode`, `restarts`, `viewers`. `termId` is the first 32 hex
digits of sha256(repo path, a NUL, task name), stable across restarts and
reboots, computed on the server.

**Desired state.** `tasks/state.json` under the config dir records
`want: running | stopped` per `termId`. Start sets `running`, stop sets
`stopped`. Reboot recovery reads it, so only flagged tasks that were meant to be
up come back. The same record keeps each task's last `exitCode` and `exitedAt`,
written when the supervisor first sees the task die, so "exit 1 · 3m ago"
survives a canopy restart and a reaped session (see Cleanup).

**Logs.** `tasks/<repo hash>/<name>.log` under the config dir, the volume the
shells container already shares. Raw bytes as the pty wrote them, ANSI and all.
At 2 MB the log rotates to `.log.1`, one old file kept. Search strips ANSI.

## Server and supervisor

- `core/tasks.ts`, pure and browser-safe: `mergeTasks`, `detectTasks` and its
  parsers, `normalizeTaskDef`, `taskTermId` (server-only caller),
  `nextDelay(fails)`, `taskStatus(...)`.
- `core/taskrun.ts`, Bun: the tmux calls, through `tmux.ts`'s existing builders
  plus new pure ones for `respawn-pane`, `pipe-pane` and a per-session
  `set-option`.
- `server/tasks.ts`: the routes and the supervisor; `state.tasks` for runtime
  state, `state.want` loaded from `tasks/state.json`.

**A task is a tmux session** on canopy's existing tmux server, named
`canopy-<termId>` like a shell, tagged `@canopy_task=<name>` alongside the
`@canopy_repo` and `@canopy_path` shells already carry, with
`remain-on-exit on` set on that session only. Because the id is a shell id, the
existing `/api/term?attach=1` websocket joins a task unchanged: viewers,
reconnects, touch scrolling and paste carry over.

**Start** is three calls, in this order:

1. `new-session -d` with `sleep 2147483647` as its command and the tags above.
2. Append `--- started <local time> · <cmd> ---` to the log, then
   `pipe-pane -o 'cat >> <log>'`.
3. `respawn-pane -k` with `sh -lc '<cmd>'` from the repo root (or `cwd`), or the
   ssh line for a remote repo.

The pipe is attached before the real command runs, which is the only way the log
gets the command's first output. Running the command directly, not typed into a
shell, makes the pane's exit status the task's. Restart repeats steps 2 and 3 on
the same pane, so viewers stay attached and watch it restart in place. The first
integration test checks that a pipe survives `respawn-pane`; if it does not,
restart re-issues `pipe-pane` too.

**Stop** sends `C-c`, waits 5 seconds, then `kill-session` if the pane still
lives. The log keeps the output. `want` becomes `stopped`.

**The supervisor** runs every 2 seconds: one `list-sessions` whose format adds
`#{@canopy_task}`, `#{pane_dead}`, `#{pane_dead_status}` and `#{pane_pid}`. It
diffs against the last reading and broadcasts a `tasks` event,
`{repoId, tasks: TaskInfo[]}`, only for repos whose tasks changed.

- **Keep running.** A task that dies non-zero with `keep` set and
  `want: running` is respawned after `nextDelay`: 1, 2, 4, 8, 16, 32, then 60
  seconds. The failure count resets after 60 seconds up. Five failures without
  such a stretch make it `gave-up`, with a feed line and, when `tailchanNotify`
  is on, a tailchan DM. A clean exit 0 is not restarted.
- **Reboot recovery.** After the first scan, every task with `keep` and
  `want: running` that has no session is started.
- **Start with panel.** The browser posts `start` with `reason: "panel"` when a
  panel opens. The server starts each `withPanel` task that is not already
  running and not `gave-up`. A task stopped by hand does start again on the
  next panel open; that is what the flag means.
- **Rotation.** Each tick checks log sizes. Past 2 MB it renames the log and
  re-issues `pipe-pane`, since the running `cat` keeps its descriptor on the
  renamed file otherwise.

**Cleanup.** Rotation caps each log at 4 MB (the live file and one old one);
what else piles up is what tasks that no longer exist leave behind. `taskSweep`
runs at startup and then hourly, the way `paste.ts` and `keep.ts` expire their
files, with the decisions in pure functions in `core/tasks.ts`:

- `expiredTaskLogs`: a task's `.log` and `.log.1` go once the task has no
  definition and no session and the log has not been written for
  `TASK_LOG_DAYS` (7, matching `KEEP_DAYS`). A repo's log folder goes once it is
  empty.
- `reapable`: a dead task session (`remain-on-exit` holds it) is killed once it
  has been dead for `TASK_REAP` (1 hour) with no viewers. Its exit is already in
  `state.json`, and the section shows a dead task's log tail rather than its
  pane, so nothing on screen is lost.
- `staleWants`: `want` entries whose task and session are both gone are dropped.

The sweep never kills a running process. A task whose definition disappears
while it runs is an **orphan**: it stays up and shows in the section and the top
bar chip with stop only. Canopy-config overrides for a repo that left the scan
stay, as `agents` and `launchers` do, so a repo that comes back keeps them.

**Shells stay clean.** `listTerms`, `adoptTerms`, the shells chip, keep's
snapshots and `KeptShells` pass over any session with `@canopy_task`.
`endTerm` refuses a task's id; only the task routes stop a task.

**Routes.** Every repo route answers 400 for a forge repo, like the rest of
`/api/repos/*`.

- `GET /api/repos/tasks?id=`: `{ tasks: TaskInfo[], errors: string[] }`.
- `POST /api/repos/tasks?id=`: `{ action: "start" | "stop" | "restart", name?, reason? }`.
  `name` is required except for `start` with `reason: "panel"`, which starts
  every `withPanel` task.
- `POST /api/repos/tasks/def?id=`: `{ name, def: TaskDef | null, target: "canopy" | "repo" }`.
  `canopy` writes the override (`null` clears it); `repo` rewrites
  `.canopy/tasks.json`, local repos only (400 for a `host` repo). A rename is a
  `null` for the old name and a def for the new.
- `GET /api/repos/tasks/log?id=&name=&q=&before=`: a page of log lines,
  newest last, each with the local time of the start marker it falls under;
  ANSI stripped when `q` is set, which filters case-insensitively.
- `GET /api/tasks`: every non-idle task across repos, for the top bar.

## UI

**The panel section.** `Tasks.tsx`, section key `tasks`, placed directly under
changes, open by default, through `Section` so it gets the fold and the gear
(zoom, layout, share, pop-out, order and hide).

- One line per task: a status dot (moss running, sky backoff, rust failed or
  gave-up, grey idle), the name with glyphs for keep, start-with-panel and dev,
  the command muted and clipped, the source tag, then uptime or
  `exit 1 · 3m ago`, and start, stop and restart.
- A click opens the task under the list. A running task is a `TermView` joined
  with `attach=1` on its `termId`, so keys work and every device watching sees
  the same screen. An idle or dead one shows its log's tail read-only. The
  height is dragged through `TermGrip` and kept per repo like
  `panelTermHeights`.
- A search box over the open task's log lists hits (time, line, context) from
  the log route. The terminal cannot scroll to a log line, so hits are their
  own list.
- Each task's ⋯ menu: edit, open as tab, pop out, hide (a detected task) or
  delete (a defined one), and accept suggested flags where there are any.
- File errors from the repo layer show at the top of the section.

**The edit sheet.** `{ kind: "task" }` in `RunSheet`: name, command, cwd, the
three flags, and where to save, this machine or the repo (the repo only for a
local repo; the file then shows in changes like any edit). "Add task" opens the
same sheet empty.

**Open as tab, pop out.** A task can sit in the panel's shells or the strip as a
tab with a ▶ badge (`TermTab.task`). Closing that tab drops the tab and never
stops the task, unlike a shell tab. Pop-out is
`view=shell&term=<termId>&attach=1`; `ShellSolo` honours `attach` so a popped
window cannot start a stray shell under a task's id.

**Around the app.**

- Card: `TaskChip` beside `RunChip`, `▶ 2` while tasks run, `✕ test` in rust
  when one failed or gave up.
- Top bar: a `▶ n` chip whose popover lists every non-idle task across repos,
  each with open (the panel, tasks unfolded, that task selected), restart and
  stop. A task whose repo left the scan shows "not in scan" with stop only.
- Feed: a `task` source with lines for started, exited with a code,
  restarting in n seconds, gave up and stopped, built by the pure `taskLines`
  in `ui/src/tasks.ts`. Supervisor ticks with no change make no line.
- Preview: with a running dev task and no saved choice, the preview section
  picks the port `ports.ts` already ties to the repo's cwd. With the dev task
  idle, the empty preview offers "start dev".

**Store and several backends.** The store keeps `tasks` by repo id, loaded on
panel open and replaced by `tasks` events, and `taskAll` for the chip, loaded at
init. `qTask` in `ui/src/qualify.ts` qualifies `repoId` and `termId`, `qEvent`
dispatches the `tasks` event through it, and `applyEvent` folds it into the
sending backend's slice. A task runs on the backend whose checkout the panel
shows.

## Errors

- No tmux (`tmuxBase()` null, or `CANOPY_TMUX=0`): the section says tasks need
  tmux, the routes answer 503. No plain-pty fallback.
- Start on a running task: 409. Stop on an idle one: a no-op 200. An unknown
  name: 404. A malformed body or name: 400.
- The log directory cannot be written: start answers 500 with the reason and
  starts nothing.
- The tmux server does not answer (the shells container restarting): the
  supervisor skips the tick and marks nothing dead, the `serverUp` lesson the
  shell code already learned. A session that is gone while the server answers
  counts as a failure with no exit code, so keep running applies.
- A task's definition disappears while it runs: it becomes an orphan, left
  running, stop only.
- The repo leaves the scan: its tasks keep running and show in the top bar
  chip, stop only.
- A remote host that does not answer: ssh exits 255, backoff applies, it gives
  up after five.
- A `cwd` that resolves outside the repo root: 400 on save, dropped with an
  error when it comes from the repo file.

## Testing

- `src/core/tasks.test.ts`: merge precedence and `source`, the own-repo flag
  rule and `suggested`, each parser, `normalizeTaskDef`, `cwd` containment,
  `nextDelay`, `taskStatus`, `taskTermId` stability, and `expiredTaskLogs`,
  `reapable` and `staleWants` with explicit times.
- `src/core/tmux.test.ts`: the new argv builders and the extended list format.
- `src/server/tasks.test.ts`, against real tmux like `term.test.ts`: the first
  output line reaches the log; restart keeps the session and its pipe; stop's
  grace and kill; exit codes; backoff and gave-up with short delays injected;
  reboot recovery (kill the tmux server, start a new server); shell lists never
  show a task; `endTerm` refuses a task; the own-repo rule end to end; the 400,
  404, 409 and 503 answers; rotation re-attaches the pipe; a reaped dead session
  keeps its exit line across a server restart; an orphan stays running through
  a sweep.
- `ui/src/tasks.test.ts`: chip text, status words, `taskLines`.
  `ui/src/qualify.test.ts`: `qTask`.
- In a browser after `bun run build`, through playwright-cli: start a dev task,
  watch the chips, type into it, restart it, search its log, and see the preview
  pick its port.

## Out of scope

Sub-projects 2 to 4 above. Task dependencies or ordering (gates will add
ordered sets). Tasks for forge-only cards. Environment variables per task beyond
what the login shell gives. Merging the launch section's `build`/`run` lines
into tasks; they stay as they are.
