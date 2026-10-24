# Feature requests: canopy

## Open

### FR-025 · Copy the branch, PR link or run id from the keyboard
P3 · added 2026-10-23 · source: Eric (Linear UX study)
With a card or run focused, one shortcut copies its branch name, another its PR link, another its run id, as Linear's copy actions do for an issue's id, link and branch.

### FR-024 · ⌘K acts on the focused card
P2 · added 2026-10-23 · source: Eric (Linear UX study)
With a repo card focused or a set selected, ⌘K opens the command line with that repo already in the repo slot and offers the verbs that apply to it first. Today the command line wants the repo's name typed, where Linear's menu acts on whatever is selected.

### FR-023 · j/k through cards and rows, Space to peek
P2 · added 2026-10-23 · source: Eric (Linear UX study)
j and k (and the arrows) move a focus ring through the repo cards, trigger rows and inbox rows; Space opens the focused run's sheet over the list and Escape closes it without losing the place; Enter goes in. The most work of the Linear borrowings: it needs one focus model across the tree, the grid and the dock.

### FR-017 · Section headings show what changed and who is working
P2 · added 2026-10-22 · source: Eric (inq pen notes, 2026-10-21)
A topic section's heading in the tree and the grid carries more than the dirty count: lines added and removed across its repos, and how many agents are working in them right now. The note reads "show info in section headers, like changes (+/-), agents working".

### FR-019 · Drill from a card into a branch and its worktree
P3 · added 2026-10-22 · source: Eric (inq pen notes, 2026-10-14)
From a repo card, open one branch and see the changes in its worktree, not only the main checkout's. The note reads "drill to branch; work tree on changes", so confirm the intent before writing a spec.

### FR-020 · Quick notes and reminders
P3 · added 2026-10-22 · source: Eric (inq pen notes, 2026-10-14 and 2026-10-21)
Jot a note or set a reminder without leaving canopy, on a repo or on its own, and a reminder lands in the inbox when it comes due.

### FR-016 · One Library across backends
P2 · added 2026-10-18 · source: Eric (Mac vs mini Library compare)
A link, tag, note, move or new category made in one backend's Library shows up in the other's. Today each backend keeps its own copy of categories.json, references.json, tags.json, relations.json and health.json, and peer sync carries only commits, so the mini started from defaults and drifts again after every edit. Host-specific keys (host_root, terminal_app, trusted_origins) stay per machine.

### FR-015 · A cards width that holds
P3 · added 2026-10-15 · source: FR-003 fix
The cards area only gets what the dock leaves over: at least `--cards-min` (320px), and more only while the dock's columns fit inside its widest. Widening a column takes room from the cards until they reach the minimum, and nothing remembers a width Eric chose for them. A resizer between the cards and the dock, saved per screen layout profile like the sidebar's width, would let the cards keep a set width while the dock scrolls.

### FR-014 · A standing watcher agent per component
P3 · added 2026-10-14 · source: Eric (Anthropic "Redesigning source control" post)
One long-lived agent per component (the mini's compose stack, peer sync, tailchan) reads that component's logs and health on a schedule and posts to the inbox when something looks off, catching the slow, odd drift a fixed alert misses. Reference: the "superfans" in https://www.anthropic.com/engineering/redesigning-source-control.

### FR-009 · Wider first columns on an ultrawide
P3 · added 2026-10-07 · source: dock pass
At 3440 wide the dock stays near 1300px and leaves about 1000px of cards. New columns could start wider when the room is there.

### FR-008 · Phone side by side shows that other panels are open
P3 · added 2026-10-07 · source: dock pass
At 412 wide, "side by side" is a snap-scrolled row with no strip or dots, so nothing says other panels are open. "Panels as tabs" already shows them.

### FR-007 · The gear's layout radio reflects a split grid
P3 · added 2026-10-07 · source: dock pass
The gear still marks "panels side by side" once the dock is a grid of split cells.

## In Progress

## Shipped

### FR-022 · g then a letter switches views
P2 · added 2026-10-23 · source: Eric (Linear UX study) · shipped 2026-10-24
Two-key chords switch views from anywhere outside a text box, as Linear's G then I does: g then t for triggers, l for the Library, h for health, i for the incubator, s for sessions, b for the board. The chord list lives in the same table as FR-021's sheet.
Built 2026-10-24 with FR-021: g then g, b, s, t, i, l, p, h, c or k, within 1.5 s; the sheet lists them under "g then".

### FR-021 · ? shows every shortcut
P2 · added 2026-10-23 · source: Eric (Linear UX study) · shipped 2026-10-24
Pressing ? outside a text box opens a sheet of every keyboard shortcut on the current view. About a dozen single keys exist (/ f [ e w d * x s n :) and none is shown on the page; the sheet and the key handler should read one table so they cannot drift.
Built 2026-10-24: `SHORTCUTS` in ui/src/shortcuts.ts is the one table; App.tsx's key handler dispatches through it and the sheet (components/Keys.tsx) lists it.

### FR-018 · A sweep that closes what went idle
P2 · added 2026-10-22 · source: Eric (inq pen notes, 2026-10-14 and 2026-10-21) · shipped 2026-10-23
One command, and optionally a schedule, closes what nobody is using: PRs with no activity, idle shells and windows, agents that finished or stalled. It lists what it would close and waits for a yes before touching a PR. Written down on two separate pages.
Spec: docs/superpowers/specs/2026-10-22-sweep-design.md (2026-10-22).
Plan: docs/superpowers/plans/2026-10-22-sweep.md. Phase 1 (shells, chats and runs on demand) shipped 2026-10-22; phase 2 (the schedule, its ask in the inbox, the settings row) shipped 2026-10-23; phase 3 (PRs the gh login authored, closed with a comment and their branch kept, swept by one backend's own setting) shipped 2026-10-23. Checked live on 2026-10-23: the mini's sweep closed barucheric/canopy-trigger-test#5 with its comment and kept the sweep-live-test branch, and the schedule's 4 a.m. fire on 2026-10-24 found nothing to close.

### FR-010 · A coordinator that splits a goal into runs, on its own model and effort
P2 · added 2026-10-09 · source: Eric (Claude Code Projects video) · shipped 2026-10-17
One chat takes a goal, proposes the tasks, and starts a run per task, showing each as a card with a live one-line status. The coordinator gets its own model and effort (default low, since it mostly routes work), separate from the per-role settings the runs use. Reference: https://www.youtube.com/watch?v=omihvjf0A2k at 1:52 and 3:24.
Spec: docs/superpowers/specs/2026-10-16-coordinator-design.md; plan: docs/superpowers/plans/2026-10-17-coordinator.md. It runs only on the mini, in the fenced `coord` container, with a token that may read and post its own plan, and on a listener of its own. It needs `CANOPY_CALLERS=enforce`. Checked live on 2026-10-17: three cards proposed, edited and started; two landed, one was sent back by a red gate; each settle note reached the chat; a follow-up card was proposed; stopping dropped the queued card and revoked the token.

### FR-011 · A run keeps watching the PR it opened
P2 · added 2026-10-09 · source: Eric (Claude Code Projects video) · shipped 2026-10-16
When a run opens a PR, its footer shows the PR number, the diff size and a CI chip whose popover lists checks in progress and passed. Two toggles there: "auto-fix CI and address comments" (the run pushes fixes when checks fail and answers review comments) and "auto-merge when ready". Reference: https://www.youtube.com/watch?v=omihvjf0A2k at 2:15.
Spec: docs/superpowers/specs/2026-10-16-pr-watch-design.md; plan: docs/superpowers/plans/2026-10-16-pr-watch.md. Shipped as a branch run that lands or opens a PR, never both; canopy pushes every fix itself, and the PR shows under the run's branch line rather than in its footer.

### FR-013 · Review rules that tell a comment-only change from a logic change
P2 · added 2026-10-14 · source: Eric (Anthropic "Redesigning source control" post) · shipped 2026-10-16
Before a run's diff reaches Eric, canopy sorts it by what it touches: a change to comments, docs or formatting alone can land without a look, while anything under a sensitive path (the secret store, the peer gate) always waits for an explicit approval. The rules are set per repo. Reference: Antique's semantic approval constraints in https://www.anthropic.com/engineering/redesigning-source-control.
Spec: docs/superpowers/specs/2026-10-15-landing-queue-design.md (2026-10-15).
Plan: docs/superpowers/plans/2026-10-16-landing-queue-2.md, merged into main as e8f5e79 and deployed to the mini on 2026-10-16.

### FR-012 · A landing queue for finished runs
P2 · added 2026-10-14 · source: Eric (Anthropic "Redesigning source control" post) · shipped 2026-10-16
Finished runs land on main one at a time: canopy rebases each branch onto the current main, runs the repo's gates, and fast-forwards only when they pass, sending a conflict or a red gate back to that run instead of blocking the next. Two runs that each pass alone can still break main together, and the queue catches that. Reference: the Antique merge queue in https://www.anthropic.com/engineering/redesigning-source-control.
Spec: docs/superpowers/specs/2026-10-15-landing-queue-design.md (2026-10-15), calls made the same day.
Plan: docs/superpowers/plans/2026-10-15-landing-queue-1.md, merged into main as 6f6be30 and deployed to the mini on 2026-10-16.

### FR-003 · Bug: a column seam lags the pointer when the dock is scrolled to its start
P1 · added 2026-10-07 · source: dock pass · shipped 2026-10-14
With nothing scrolled off the left (scrollLeft 0) and the overflow hidden on the right, a shrink moved the column's far edge, and the seam lagged by the hidden overflow (43px with two default columns at 1440x900). Fixed: at the dock's widest, the part of a shrink the scroll cannot take back now widens the column's left neighbour, so the seam stays under the pointer; the first column's seam, which has no neighbour, pulls the hidden overflow in from the last column the moment its shrink outruns the scroll, so the dock narrows under the pointer (2026-10-15).

### FR-006 · Touch drag for tabs on tablet-size screens
P2 · added 2026-10-07 · source: dock pass · shipped 2026-10-07
On the unfolded Fold 8 (884x1000, touch) the strip, grid and drag handles show, but a touch drag does nothing (`startPanelDrag` returns on `pointerType` touch). Either take touch drags there or point to the gear's move, split and new-column entries. Seam resize by touch already works. Fixed: a finger resting 350ms on a tab or a panel name picks the panel up; a quicker swipe still scrolls.

### FR-005 · Drop previews stay inside the dock, and a dropped panel scrolls into view
P2 · added 2026-10-07 · source: dock pass · shipped 2026-10-07
The cell preview and the tab insertion mark are page-fixed and draw over the cards column (preview at x=554 with the dock starting at 590). After a drop or split the dock keeps a stale scrollLeft of about 42, so the leftmost column sits partly behind the cards. Fixed: previews are cut to the dock (`clipBox`), and a dropped panel scrolls into sight.

### FR-004 · Bug: the carousel toggle covers the last panel's close button
P1 · added 2026-10-07 · source: dock pass · shipped 2026-10-07
At 1440x900, whenever the dock is not scrolled fully right, the dock-corner ⇄ button sits on the rightmost panel head's ×, so close cannot be clicked (`elementFromPoint` there returns `.dock-carousel`). Fixed: the switch is no longer sticky and scrolls with the last column, inside the room its head or strip keeps for it.

### FR-001 · Workspace agent opens at the primary
P2 · added 2026-10-07 · source: Eric · shipped 2026-10-07
Opening a workspace in the agent opener starts one agent at the workspace's primary, with the other members on that machine passed as `--add-dir`, plus a tab each for members on another machine. The follow-up the Kilo borrowings spec named.

## Declined
