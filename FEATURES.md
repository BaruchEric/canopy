# Feature requests: canopy

## Open

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

### FR-003 · Bug: a column seam lags the pointer when the dock is scrolled to its start
P1 · added 2026-10-07 · source: dock pass
Mostly fixed on 2026-10-07: a seam drag now scrolls the dock to keep the seam under the pointer once the dock is at its widest. What is left: with nothing scrolled off the left (scrollLeft 0) and the overflow hidden on the right, a shrink moves the column's far edge, and the seam lags by the hidden overflow (43px with two default columns at 1440x900). Closing that needs the seam to take width from its left neighbour at the cap, which changes what a seam owns. Waiting on Eric's call.

## In Progress

## Shipped

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
