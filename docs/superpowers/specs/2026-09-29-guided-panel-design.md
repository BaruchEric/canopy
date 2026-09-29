# Guided panel: user levels, onboarding, the anchored Claude shell

Date: 2026-09-29. Status: design, approved in conversation, awaiting spec review.

## Why

The repo panel today is built for someone who reads git porcelain: branch and
remote chips, six openers, workspaces, eight sections (changes, tasks, search,
history, peers, preview, launch, claude) and a plain shell at the bottom. A
non-technical person who builds by talking to Claude (vibe coding) needs three
things from it: tell Claude what to build, see the app running, and keep the
work. Everything else is noise to them.

Eric also wants the calmer panel for himself on some days, so the level is a
switch, not a one-way door.

## What the user asked for

1. Different flows and UI by user level, intermediate and advanced.
2. Intermediate is the default, with an onboarding-like first run.
3. The panel opens its anchored shell on its own when there is none.
4. Agent buttons on the shell tab row: play, stop, debug and the like.

## Decisions

- Two levels, `intermediate` and `advanced`. Intermediate is the vibe-coding
  panel; advanced is today's panel, unchanged.
- Chat-first: at intermediate the Claude shell is the panel, with a short
  action bar and a plain-words status line above it.
- The level is a separate component, not a preset over `sectionOrder` and
  `sectionsHidden`. A chat-first layout is not a reordering of sections, and a
  separate component leaves the advanced panel's code alone.
- No undo or discard button. A one-click discard is destructive for someone
  who cannot get the work back.

## The setting

`ui/src/settings.ts` gains two fields:

- `level: "intermediate" | "advanced"`.
- `onboarded: boolean`, true once the tour is dismissed.

Defaults: a browser with no saved `canopy.settings` gets `intermediate` and
`onboarded: false`. A browser that already has saved settings without a
`level` field gets `advanced` and `onboarded: true`, so an existing user's
panel does not change under them on upgrade. `readSettings` does this repair
the way it repairs `sectionOrder` today, through a pure `levelOf(saved)` that
is tested.

The switch lives in two places: a row in `Settings` ("panel: intermediate /
advanced", plus "show the tour again", which sets `onboarded` back to false),
and a layout group on the panel head's gear. The level is per browser and
applies to every panel in the window, solo and section windows included.

## The intermediate panel

`RepoPanel` in `Dock.tsx` renders `GuidedPanel` (new, `components/Guided.tsx`)
when `settings.level === "intermediate"` and the panel is not flipped by
"show more", else the current body. Both keep `PanelShells` as the footer, so
the shell and its pty are the same element across a level switch and nothing
remounts it.

Top to bottom:

1. **Head.** The repo name, the favorite star, close. No branch, remote,
   machine, workspace or opener chips. One status line in plain words from the
   pure `plainStatus(repo, task)` in a new `ui/src/guided.ts`:
   - "3 files changed, not saved yet" (dirty worktree)
   - "saved, not backed up yet" (clean, ahead of upstream)
   - "all saved and backed up" (clean, even with upstream)
   - "saved on this computer only" (clean, no upstream)
   - "can't read this project" (scan error)
   and, when the dev task is running, " · app running" (or "· app stopped
   with an error" when its last exit was a failure).
2. **Action bar.** Three buttons, wrapping on a phone:
   - **Run my app**: starts the repo's dev task (`devTask` in `tasks.ts`).
     Once it runs, the button becomes **Stop** and the preview section opens
     inline below the bar, paired with the dev task as it is today. With no
     dev task the button reads **Set up run** and types the setup prompt
     (below) into the Claude shell.
   - **Save my work**: types the save prompt into the Claude shell. Disabled
     with the title "nothing to save" when the tree is clean and not ahead.
   - **Show more**: flips this panel to the advanced body until the panel
     closes (component state, not a setting). The advanced head gets a
     **Show less** button in its place when the browser's level is
     intermediate.
3. **The Claude shell** fills the rest: `PanelShells` with its section
   unfolded and its height grown to fill the panel (`--panel-term-h` set to
   the remaining height rather than `PANEL_TERM_ROWS`). A drag on its grip
   still works and is saved the same way.

A forge-only card or a `host` repo has no shell and no tasks; `GuidedPanel`
shows the status line and a note ("open this project on its own machine")
instead of the bar.

## The anchored shell opens on its own

When a repo's panel opens (any path: `openPanel`, `openRepo`, a restored
layout, a solo window), and no shell tab with `place: "panel"` exists for that
repo, the store opens one, in both levels.

- It waits for the server's shell list: auto-open runs only after `init` has
  reconciled `terms` (`reconcileTerms`/`adoptTerms`), so a held shell from
  another device or a restart is adopted rather than doubled. The check is a
  pure `needsPanelShell(terms, repoId, loaded)` in `ui/src/term.ts`, tested.
- It runs once per panel open. A user who closes that tab gets no new one
  until the panel is opened again.
- Not for a forge card, a `host` repo, a repo with a scan error, or a backend
  that is not online.
- At intermediate the new shell starts Claude; at advanced it is a plain shell.

Starting Claude is server-side, the way resume already types its line: the
term socket takes `start=claude` on a new shell only, and the server types
`claudeLine(agentFor(repo))` in after the same beat `resumeTerm` uses. A join
or `attach=1` ignores it. Tested in `server/term.test.ts` against both the
plain pty and tmux.

## Shell tab buttons

On the `TermTabs` row in `TermDock.tsx`, next to the gear, for the tab showing
(both levels, strip and panel):

| button | does | shown when |
|---|---|---|
| ▶ | start the repo's dev task | a dev task exists and is not running |
| ■ | stop the dev task | the dev task is running |
| bug | type the debug prompt | the dev task's last exit was a failure, or it is running |
| ✓ | type the save prompt | the tree is dirty or ahead |

With no dev task, ▶ reads "set up run" and types the setup prompt. Each button
has a title that says what it does in words.

▶ and ■ call the store's existing task start and stop. The bug and ✓ buttons
type into a Claude shell: the showing tab when it is running Claude, else the
repo's panel shell. "Running Claude" is read from `agentIn` over the tmux pane
title and command, which `keep.ts` already does for a kept shell; `TermInfo`
gains `agent` so the browser can read it. When no shell of the repo runs
Claude, the button opens one with `start=claude` and types once it is up.

Typing goes through one new function, `typeInto(termId, text)`, exported
from `TermDock.tsx` over the `LIVE` map: a bracketed paste of the text, then
a carriage return, so Claude Code takes it as one message. No new server
route.

The prompts live in `ui/src/guided.ts`, pure and tested:

- save: "Save my work: commit everything with a clear message, then push."
- debug: "My app shows this error. Find the cause and fix it." followed by the
  dev task's last 40 log lines from `api.taskLog`, ANSI already stripped.
- setup: "Set up a way to run this app locally and tell me how to open it."

## Onboarding

The first intermediate panel a browser opens, with `onboarded` false, shows
three coach marks in order, each a small popover pointing at its target with
**Next** and **Skip tour**:

1. the Claude shell: "Tell Claude what you want to build, in your own words."
2. Run my app: "See your app running here."
3. Save my work: "Keep your changes. Claude saves and backs them up."

**Skip tour** or finishing the last step sets `onboarded`. The step logic is
a pure `tourStep(step, action)` in `guided.ts`; the popover is `Tour.tsx`,
portal-rendered like the menus and anchored to refs the panel passes in. It
does not show in a dockless window or when the panel is hidden in tabs mode.

## Files

- new `ui/src/guided.ts` (+ test): `plainStatus`, `levelOf`, prompts,
  `tourStep`.
- new `ui/src/components/Guided.tsx`: `GuidedPanel`, action bar.
- new `ui/src/components/Tour.tsx`.
- `ui/src/settings.ts`: `level`, `onboarded`.
- `ui/src/term.ts` (+ test): `needsPanelShell`.
- `ui/src/store.ts`: auto-open after reconcile and on panel open.
- `ui/src/components/Dock.tsx`: level switch in `RepoPanel`, show more/less.
- `ui/src/components/TermDock.tsx`: tab buttons, `typeInto`.
- `ui/src/components/Settings.tsx`: level row, tour reset.
- `src/server` term route and `src/core/types.ts`: `start=claude`,
  `TermInfo.agent`.
- `ui/src/styles.css`: guided head, action bar, tour.

## Testing

Unit tests for every pure function above. Server tests for `start=claude` on
a new shell and its absence on a join. A browser check with playwright-cli on
the built SPA at :7850: a fresh profile lands on intermediate with the tour,
an existing profile stays advanced, opening a panel starts one Claude shell
and a reload adopts it instead of opening a second, ▶/■ drive the dev task,
✓ types into the shell.

## Out of scope

Undo or discard. Changing the grid's repo cards. A beginner-worded changes
list (the advanced changes section is one "show more" away). Per-repo levels.

## Amendments

Made while planning and building, each smaller than what the sections above say:

1. `levelOf` lives in `ui/src/settings.ts` beside the other field repairs, not in `guided.ts`.
2. No `TermInfo.agent` on every list. `GET /api/terms/agent?term=` answers on demand, only when a button needs it: `agentIn` over `paneInfo` on tmux, and on a plain pty whether canopy started it with `start=claude`.
3. The auto-open skips dockless windows (solo, shell and section windows), the same rule `panelsStarted` follows.
4. At intermediate the shell fills the panel and has no height grip.
5. The auto-open adds its tab without focusing the panel, so a reload that brings back several panels keeps the one that was showing.
6. The tour looks for a target that is not mounted yet for a few seconds before passing over its step; the panel's shell mounts after the panel.
