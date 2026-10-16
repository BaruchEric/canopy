# Feature requests: canopy

## Open

### FR-015 · A cards width that holds
P3 · added 2026-10-15 · source: FR-003 fix
The cards area only gets what the dock leaves over: at least `--cards-min` (320px), and more only while the dock's columns fit inside its widest. Widening a column takes room from the cards until they reach the minimum, and nothing remembers a width Eric chose for them. A resizer between the cards and the dock, saved per screen layout profile like the sidebar's width, would let the cards keep a set width while the dock scrolls.

### FR-014 · A standing watcher agent per component
P3 · added 2026-10-14 · source: Eric (Anthropic "Redesigning source control" post)
One long-lived agent per component (the mini's compose stack, peer sync, tailchan) reads that component's logs and health on a schedule and posts to the inbox when something looks off, catching the slow, odd drift a fixed alert misses. Reference: the "superfans" in https://www.anthropic.com/engineering/redesigning-source-control.

### FR-013 · Review rules that tell a comment-only change from a logic change
P2 · added 2026-10-14 · source: Eric (Anthropic "Redesigning source control" post)
Before a run's diff reaches Eric, canopy sorts it by what it touches: a change to comments, docs or formatting alone can land without a look, while anything under a sensitive path (the secret store, the peer gate) always waits for an explicit approval. The rules are set per repo. Reference: Antique's semantic approval constraints in https://www.anthropic.com/engineering/redesigning-source-control.
Spec: docs/superpowers/specs/2026-10-15-landing-queue-design.md (2026-10-15), not built. Plan 2 of the landing queue, after FR-012's.

### FR-011 · A run keeps watching the PR it opened
P2 · added 2026-10-09 · source: Eric (Claude Code Projects video)
When a run opens a PR, its footer shows the PR number, the diff size and a CI chip whose popover lists checks in progress and passed. Two toggles there: "auto-fix CI and address comments" (the run pushes fixes when checks fail and answers review comments) and "auto-merge when ready". Reference: https://www.youtube.com/watch?v=omihvjf0A2k at 2:15.

### FR-010 · A coordinator that splits a goal into runs, on its own model and effort
P2 · added 2026-10-09 · source: Eric (Claude Code Projects video)
One chat takes a goal, proposes the tasks, and starts a run per task, showing each as a card with a live one-line status. The coordinator gets its own model and effort (default low, since it mostly routes work), separate from the per-role settings the runs use. Reference: https://www.youtube.com/watch?v=omihvjf0A2k at 1:52 and 3:24.

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

### FR-012 · A landing queue for finished runs
P2 · added 2026-10-14 · source: Eric (Anthropic "Redesigning source control" post)
Finished runs land on main one at a time: canopy rebases each branch onto the current main, runs the repo's gates, and fast-forwards only when they pass, sending a conflict or a red gate back to that run instead of blocking the next. Two runs that each pass alone can still break main together, and the queue catches that. Reference: the Antique merge queue in https://www.anthropic.com/engineering/redesigning-source-control.
Spec: docs/superpowers/specs/2026-10-15-landing-queue-design.md (2026-10-15), calls made the same day.
Plan: docs/superpowers/plans/2026-10-15-landing-queue-1.md, built 2026-10-16 on its own branch, waiting to be merged.

## Shipped

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
