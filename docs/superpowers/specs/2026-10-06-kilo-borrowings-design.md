# Kilo borrowings: plan then build, workspace primary, a movable dock

Date: 2026-10-06. Status: design, written from a watched demo and a CLI probe, awaiting Eric's review.

## Why

Kilo Desktop's launch demo (youtube.com/watch?v=J1FDLV8oYbc, 2026) showed four things canopy lacks:

1. A plan agent that reads the code, writes a step-by-step plan without touching anything, and hands off to a code agent on one click. The code agent keeps a live task list and fans the work out to subagents in parallel.
2. Workspaces whose folders include one marked primary, which tells the agent where new code goes, and an identity color per workspace.
3. A dock you can rearrange. You drag tabs between groups or under one another, resize every split, flip into a sideways-scrolling carousel, full-screen any pane, and pop a pane out to its own window and back.
4. A local model server. Out of scope here.

canopy already has most of the parts underneath. Runs speak Claude's stream-json protocol with the stdio permission tool, workspaces are stored and opened, and the dock has resizable panels, a tabbed mode and pop-out windows. This spec adds what is missing on top of them.

## What a probe of the real CLI showed

Claude Code 2.1.292, `claude -p --permission-mode plan --input-format stream-json --output-format stream-json --verbose --permission-prompt-tool stdio`, in a scratch repo, 2026-10-06. Every protocol decision below rests on these, and the fake CLI in tests must replay them.

- **P1.** `ExitPlanMode` arrives as `control_request` / `can_use_tool` with `tool_name: "ExitPlanMode"` and `input: { plan: "<markdown>" }`. Before that, plan mode writes the plan to `~/.claude/plans/<slug>.md` with `Write` and does not ask.
- **P2.** Answering it `allow` returns the tool result "User has approved your plan. You can now start coding." and the same turn goes on to edit files.
- **P3.** A host-sent `control_request` `{ subtype: "set_permission_mode", mode }` works mid-run. The CLI answers `control_response { subtype: "success", response: { mode } }` and emits `system` / `status` with the new `permissionMode`. Under `acceptEdits`, `Edit` and `Write` went through without asking and `Bash(bun test)` still asked.
- **P4.** The todo tool in this version is `TaskCreate` `{ subject, description, activeForm }` and `TaskUpdate` `{ taskId, status }`. The id comes back only in the result text, "Task #3 created successfully: ...". Older CLIs use `TodoWrite` `{ todos: [{ content, status, activeForm }] }`.
- **P5.** `Agent` subagents run in the background by default. The tool result says "Async agent launched successfully", the CLI emits `system` / `task_started`, and **a `result` arrives while the subagent is still running**. Then `system` / `task_notification`, a fresh `system` / `init`, and the turn continues to a second `result`. Messages from inside the subagent carry `parent_tool_use_id` set to the `Agent` tool_use id.
- **P7 (second probe).** Background tasks are reported in detail:
  - `system` / `task_started` carries `task_id`, `tool_use_id` and `task_type`, which is `local_agent` for a subagent and `local_bash` for a `run_in_background` shell.
  - `system` / `task_notification` carries the same `task_id` and a `status`. It fires once per task, both on completion (`completed`) and on `TaskStop` (`stopped`).
  - `system` / `background_tasks_changed` carries the full current list as `tasks: [{ task_id, task_type, ... }]`, and arrives before `task_started` and after each end. It is the authoritative list.
- **P8 (third probe).** The mode switch after a plan has two constraints:
  - **Order.** Answering `ExitPlanMode` `allow` resets the session to `default` mode. So `set_permission_mode` must be sent after the allow, not before. Probe 1 did it in that order and `acceptEdits` stuck.
  - **Bypass needs a launch flag.** Switching to `bypassPermissions` is refused with `error_code: "bypass_not_launched"` unless the process was started with `--allow-dangerously-skip-permissions`. With that flag (and `--permission-mode plan`), the switch succeeds and later `Bash` calls do not ask.
- **P9.** Plan mode writes every plan to `~/.claude/plans/<slug>.md` on the machine that runs the CLI. On the mini, that is the bind-mounted `~/.claude`. Each `propose` run leaves one file there, a side effect worth knowing. The probes for this spec left four such files, which were removed afterwards.
- **P6.** If the host closes stdin on that first `result`, every later permission request in the run fails with "Tool permission request failed: AbortError: Stream closed". `ClaudeDriver.drive` closes stdin on the first `result` of a non-chat run today, and `RunCtx.result` ends a job and denies a chat's waiting prompts on it. **This is a live bug in canopy now, for any run where Claude starts a background subagent.** The first plan fixes it before building on it.

## Decisions

### Plan then build (the "propose" action)

- A new run action `propose`, labelled "plan, then build…", verb "plan". It is one run and one session. Claude starts in `--permission-mode plan`. Approving is the `allow` answer to `ExitPlanMode`, and the same turn builds. Starting a second run would hit the one-active-run-per-repo rule and lose the context the plan was built from.
- `ExitPlanMode` becomes a new prompt kind, `proposal`, carrying the plan's markdown. It is answered three ways:
  - **approve, ask before commands.** Canopy answers `allow`, then sends `set_permission_mode` `acceptEdits`, in that order (P8).
  - **approve, run on its own.** Canopy answers `allow`, then sends `bypassPermissions`. This option shows only when the repo's agent settings have `yolo` on. Without yolo the user has not agreed to unasked commands anywhere, and a plan approval is not the place to start.
  - **Yolo launches.** A propose run on a yolo agent is launched with `--allow-dangerously-skip-permissions` beside `--permission-mode plan`, which is what lets the later switch succeed. If the bypass switch is refused anyway, canopy falls back to `acceptEdits` and notes it.
  - **revise.** A deny carrying the user's note. Claude stays in plan mode and proposes again.
- The names avoid two collisions. "Plan" is the pre-run note sheet (`Sheet` kind `plan`), and "tasks" are a repo's supervised processes. So the action is `propose`, the prompt is `proposal`, and the live list is `todos`.
- Claude only. Starting `propose` when the repo's job harness is Codex is refused with "plan, then build needs Claude Code". It is never offered to flows, fleets or incubator stages. An unattended run would deny `ExitPlanMode` and stall in plan mode.
- `maxTurns` is 200 per reply, since one reply covers both the plan and the build.
- The prompt asks Claude to:
  - track the approved plan's steps with its task tool;
  - hand independent steps to subagents in parallel;
  - run the repo's checks at the end.
  canopy orchestrates nothing. It shows what Claude does.
- The run keeps two new fields. `proposal` holds the latest plan text, shown as a card at the top of the run sheet after approval. `todos` holds the live checklist, built from P4 and shown pinned above the timeline.
- Steps gain `parent`, the step id of the `Agent` call they ran under, from P5's `parent_tool_use_id`. The timeline folds a subagent's steps under its `Agent` step with a count, so parallel subagents read as parallel lanes rather than one interleaved list.
- A todo list belongs to the main thread only. TaskCreate calls made inside a subagent are ignored for `todos`.

### Background subagents (the P6 fix)

- `ClaudeDriver` keeps the set of live subagent task ids, those with `task_type: "local_agent"` (P7). `task_started` adds one and `task_notification` removes one. `background_tasks_changed` replaces the set with its own list, filtered to `local_agent`, so a lost notification cannot hold a run forever.
- Background shells (`local_bash`) never hold a result. A `run_in_background` dev server would otherwise keep a job open for good.
- A `result` that arrives while the set is not empty is held. Stdin stays open, the run stays `working`, and nothing reaches `ctx.result`.
- The next `result` that arrives with the set empty is the real one.
- If the process exits while a result is held, the held one is applied before `exited`, so a run is never left without its result.

### Workspace primary and color

- `Workspace` gains two optional fields. `primary` is an absolute path that must be one of `repos`. `color` is one of `WS_COLORS = ["moss", "lichen", "rust", "sky", "bark"]`, the palette's own token names, never hex. Config normalization drops a `primary` that is not a member and a `color` that is not in the list.
- The effective primary is `primary ?? repos[0]`. A workspace is never without one.
- Removing the primary member clears `primary`, and the next member becomes the effective primary.
- `PATCH /api/workspaces` sets or clears `primary` and `color` without touching membership. `upsertWorkspace` merges repos, so it is the wrong tool for this.
- **Workspace runs.** `POST /api/workspaces/run` takes `{ name, action, note, client? }` and starts an `ask`, `chat` or `propose` run on the primary repo. It passes `--add-dir` for every other member that is a local folder. A member on another host or on the forge is skipped, and the run's first note names each skipped one.
- **Workspace prompt.** A workspace run's prompt names the workspace, the primary ("new code goes here") and the other folders. Its safety rule reads "Work only inside these folders" in place of "Work only inside this repository".
- **Workspace locking.** A workspace run is refused (409) when any local member has an active run or flow. While it runs, only the primary is locked by the runner; the other members are not. The card's change fingerprint covers the primary only. Both limits are accepted for v1 and written into `docs/architecture.md`.
- Workspace runs are Claude only for v1, refused for Codex with "workspace runs need Claude Code".
- `Run` gains `workspace?: string`, so the sheet and the feed say "in workspace bike-trips".
- **UI.** Workspace tabs show a color dot. A workspace menu offers set primary, color, "ask in workspace…", "chat in workspace…" and "plan, then build in workspace…". Member cards carry the workspace color as a left rule, and the primary carries a "primary" chip.

### The movable dock

**The first rule: a panel is never reparented or reordered in the DOM.** Moving a `RepoPanel` element reloads the preview's iframe, and remounting it drops a `TermView`. Every layout change is a data change that CSS places. Panels stay flat keyed children of `.dock`, rendered in a stable order (sorted by id), and placed by CSS `order` (phase A) or grid areas (phase B).

Phase A ships on its own:

- **Reorder.**
  - The store gains `movePanel(id, to)`, backed by a pure `movePanel` in `dock.ts`.
  - Dock tabs and panel heads drag with native HTML5 drag and drop, the way `ChangesList` columns do. Both are drop targets for each other.
  - Keyboard: Alt+Shift+←/→ on a focused dock tab or panel head moves it, and the panel gear gains "move left" and "move right".
- **Carousel.**
  - A setting `dockCarousel: boolean`, toggled by a button at the dock's top-right and by the panel gear.
  - When on, the cards column collapses (`.body.carousel`) and the dock takes the full width.
  - A panel may be as wide as the window less its handle. `dockRoom` lifts its cap.
  - The row scrolls sideways, with `scroll-snap-type: x proximity`.
  - Panning:
    - Dragging a pointer on a panel head or the dock gutter pans the row.
    - A vertical wheel over a panel head or the dock tabs pans it sideways.
    - Shift+wheel anywhere in the dock pans it, unless the element under the pointer scrolls sideways itself.
  - **Wheel events over a panel's scrollable content are never hijacked.**
  - Ctrl+Alt+←/→ snaps to the previous or next panel.
- **Full screen.**
  - "full screen" in the panel gear calls `document.documentElement.requestFullscreen()` and sets the panel's existing `surface-full` mode. It never calls it on the panel itself, since gear menus and sheets are portals to `body` and would vanish.
  - Leaving full screen in the browser (Esc, F11) returns the panel to normal through `fullscreenchange`.
  - Where `document.fullscreenEnabled` is false (iOS Safari), the entry falls back to `surface-full` alone and says "fill the window".
- **Pop out and back.**
  - "pop out" removes the panel from `panels`, records its slot in `popped: Record<id, number>`, and opens the solo window.
  - The pop-out's URL carries `popped=1`. Only a solo window with that marker joins a `BroadcastChannel("canopy:panes")`, so "open in a new tab", shift-click and a typed URL never take a panel out of the dock.
  - That window says `hello` with its id on load and `bye` on `pagehide`, and has a "back to the dock" button that says `return` and closes itself.
  - The main window puts a panel back at its slot on `return` or `bye`. On `hello` it removes the panel again, which covers a pop-out reloading.
  - On load, the main window asks `who` and returns every popped id no window answers within 1.5 s.
  - Dockless windows strip `popped` from their layout patch, as they already strip `panels`.

Phase B is gated on Eric's go-ahead, since it costs the most:

- **Groups and splits.**
  - The layout becomes `columns: DockColumn[]`. A `DockColumn` is `{ id, width, cells: DockCell[] }` and a `DockCell` is `{ id, panels: string[], active, share }`.
  - Today's side-by-side mode is one cell of one panel per column. Today's tabbed mode is one column with one cell holding every panel. `openIn` decides where a newly opened panel goes: a new column, or the active cell.
  - A pure `gridOf(columns)` turns the layout into one CSS grid. Column tracks come from the widths. Row tracks are the sorted union of every column's cell boundaries, so each cell spans the rows between its own boundaries. Each panel gets `grid-area` from its cell.
  - A cell's tab strip and the row splitters are separate, freely re-creatable elements placed in the same grid.
- **Dragging between cells.**
  - Pointer drag from a tab. A `.drag-shield` covers the dock while dragging, so iframes and terminals cannot swallow the pointer.
  - A pure `dropZone(rect, point)` returns `center` (join the cell as a tab), `below` or `above` (split the column), or `left` or `right` (a new column).
  - A translucent preview shows where the tab will land.
- `panels` stays as the flat open set, derived from the layout, so the rest of the app (feed, select, peers, the pop-out code) does not change.
- The layout persists per screen class with the other slotted sizes, so a phone and an ultrawide keep different arrangements. A phone shows one panel, and dragging and splitting are off below `PHONE`.

## Out of scope

- Kilo's local model server, model marketplace and auto router.
- Codex plan mode. Codex has `request_user_input` plan semantics, but no user has asked for it.
- Agent opener changes for workspaces. Using the primary as the agent tab's cwd is a cheap follow-up.

## Plans

1. `docs/superpowers/plans/2026-10-06-workspace-primary.md`: workspace primary, color and workspace runs. Small, and independent of the others.
2. `docs/superpowers/plans/2026-10-06-propose-approve-build.md`: the P6 fix, then `propose`. It builds on plan 1 only for the "plan, then build in workspace…" entry, which its last task adds if plan 1 has shipped.
3. `docs/superpowers/plans/2026-10-06-dock-layout-phase-a.md`: reorder, carousel, full screen, pop out and back.
4. `docs/superpowers/plans/2026-10-06-dock-layout-phase-b.md`: groups and splits. Waits on Eric's go-ahead.
