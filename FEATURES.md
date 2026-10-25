# Feature requests: canopy

## Open

### FR-046 · Paseo interop study
P3 · added 2026-10-25 · source: Eric (software-factory survey, 2026-10-25; Paseo)
Paseo (getpaseo/paseo, Apache-2.0) has canopy's daemon-plus-clients shape, multi-host model, voice and worktrees, and the native phone apps canopy lacks. A two-half-day study with written thresholds decides between an adapter that speaks its protocol, a landing-queue plugin contributed upstream, or no, which is the default while FR-042 covers the phone.
Spec: docs/superpowers/specs/2026-10-25-paseo-interop-design.md (2026-10-25); index in 2026-10-25-software-factory-borrowings-design.md.

### FR-045 · The landing queue as a package others can adopt
P3 · added 2026-10-25 · source: Eric (software-factory survey, 2026-10-25)
The queue's pure model (states, review sorting, gates reading) and its git half (worktree add, rebase, fast-forward) become a Bun workspace package with no canopy types and a small `land` CLI, so Paseo, Orca or anyone with a CI can run the sort and the gates. No-go by default: go when a second consumer is real. Needs a licence and a name without "canopy" in it (github.com/juliensimon/canopy exists).
Spec: docs/superpowers/specs/2026-10-25-landing-package-design.md (2026-10-25).

### FR-044 · Harness share in the costs view
P3 · added 2026-10-25 · source: Eric (software-factory survey, 2026-10-25; Yegge's "20-25% of all my work")
Repos marked as the harness (canopy's own, by default) get a share figure in the costs view: the fraction of the window's dollars and Claude sessions that went into canopy itself, eight weeks of plain CSS bars, rust past a per-browser threshold (25%), one quiet inbox line a week at most, and `canopy costs --share`.
Spec: docs/superpowers/specs/2026-10-25-harness-share-design.md (2026-10-25).

### FR-043 · Run transcripts, replay and fork
P3 · added 2026-10-25 · source: Eric (software-factory survey, 2026-10-25; OrcaReplay)
canopy writes both directions of a run's wire to `<configDir>/runs/<id>/`, redacted and kept 30 days, so a finished run opens after a restart and replays in the sheet. "Fork from here" starts a new branch run from the original's base with `--fork-session`; a fork onto the other harness is a fenced summary handoff. `canopy run export` writes a markdown transcript.
Spec: docs/superpowers/specs/2026-10-25-run-replay-design.md (2026-10-25).

### FR-042 · A PWA with web push for asks and "needs you"
P2 · added 2026-10-25 · source: Eric (software-factory survey, 2026-10-25; Paseo, Happy, Orca mobile)
A manifest and a hand-written service worker that caches the shell only make canopy installable on a phone; web push (VAPID keys under the config dir, subscriptions per browser) tells the phone about a new ask, a sent-back branch, a check that gave up or a trigger event that needs Eric while the page is closed. A push carries the item's key and a title, never a token. Telegram stays for the ranger.
Spec: docs/superpowers/specs/2026-10-25-pwa-push-design.md (2026-10-25).

### FR-041 · Spec drift and convergence, on a schedule
P2 · added 2026-10-25 · source: Eric (software-factory survey, 2026-10-25; Spec Kit's converge, Spexcode)
A third trigger source, `schedule` (a cron line, fired by the flows-lock holder, one event per repo per fire, `repo: "*"` for every local repo with a SPEC.md), and a bundled `spec-converge` workflow: a read-only Check step compares SPEC.md with the lockfile, the scripts, the files the code writes and the dated decisions, then a Fix step edits it on a branch. SPEC.md is on the sensitive list, so the fix always waits for a look.
Spec: docs/superpowers/specs/2026-10-25-spec-converge-design.md (2026-10-25).

### FR-040 · Pre-edit collision warnings
P2 · added 2026-10-25 · source: Eric (software-factory survey, 2026-10-25; Concord, foremerge, juliensimon/canopy)
canopy already sees every Edit, Write and Bash call a run makes, so it keeps a live touched-path set per run and warns when two runs on one repo, or a queued branch and a working run, touch the same files: a chip on the landing rows, a quiet inbox line, one word into an idle chat. Never a hold. Members of one FR-033 group never collide with each other.
Spec: docs/superpowers/specs/2026-10-25-collision-warnings-design.md (2026-10-25).

### FR-039 · Per-worktree runtime stacks and a warm worktree pool
P3 · added 2026-10-25 · source: Eric (software-factory survey, 2026-10-25; Coasts, Treehouse)
`warm: N` in gates.json keeps prepared worktrees per repo so a branch run starts without `bun install`; a branch run may run the repo's dev task in its own worktree on allotted ports and preview it; a compose task runs per worktree under its own project name and is torn down on land or drop. canopy's own stack on the mini is refused.
Spec: docs/superpowers/specs/2026-10-25-worktree-stacks-design.md (2026-10-25).

### FR-038 · The agent surface: `canopy mcp` and run tokens
P1 · added 2026-10-25 · source: Eric (software-factory survey, 2026-10-25; Orca's CLI, Paseo's MCP, Gas Town's gt nudge)
`canopy mcp` is a stdio MCP server whose tools (status, runs, start a branch run, the queue, land, a work note, say, a wake, health) are filtered by the caller's kind; shells and the ranger use it with the tokens they have. A `run` caller kind, minted per run only when the profile turns it on and delivered through a 0600 `--mcp-config` file, lets a run start a child in its own repo (depth 2, three children) and post notes, and can never land, push, open a PR or answer a prompt.
Spec: docs/superpowers/specs/2026-10-25-agent-surface-design.md (2026-10-25).

### FR-037 · A durable work ledger
P2 · added 2026-10-25 · source: Eric (software-factory survey, 2026-10-25; Beads, Symphony)
A work item per branch (`w-xxxxxxxx`: title, repo, state derived from the hubs, the runs, branches, PRs, trigger events and coordinator cards that served it, and handoff notes) kept under `<configDir>/work/` by the flows-lock holder, not in the repo; git carries the id in the branch name, a `Canopy-Work:` commit trailer and the PR body, so `canopy work rebuild` re-derives the links. Notes are fenced into every later run on the branch; agents leave a `## Handoff` line in their closing text.
Spec: docs/superpowers/specs/2026-10-25-work-ledger-design.md (2026-10-25).

### FR-036 · Capacity governor: subscription-limit-aware dispatch
P1 · added 2026-10-25 · source: Eric (software-factory survey, 2026-10-25; Gas Town's max_polecats, Optio's usage view; absorbs FR-028)
Every start carries a priority (interactive, normal, low); a pure governor holds `low` work past 70% of the five-hour window and `normal` past 90%, never a chat or an ask, and a limit hit makes a run `limited` and retried after the reset rather than failed. A top-bar chip shows each login's windows and their resets (FR-028). The credits lane (an API key funded by the plan's monthly credits for the ranger and low work) is written out and held for Eric, since it reverses the 2026-08-24 decision.
Spec: docs/superpowers/specs/2026-10-25-capacity-governor-design.md (2026-10-25).

### FR-035 · Work until merged: issue intake from GitHub and Forgejo, and the conflict loop
P1 · added 2026-10-25 · source: Eric (software-factory survey, 2026-10-25; Optio, Symphony, ccpm)
Two new trigger sources, `github` and `forgejo`: a labelled issue, by webhook or by polling where no public hook address exists, starts a branch run on the bundled `issue-fix` workflow; GitHub issues go to a PR, Forgejo issues land through the queue; canopy comments the PR link and closes the issue on merge. The PR watch rebases a branch read `BEHIND` or `DIRTY` and pushes it with `--force-with-lease` to the sha it last pushed, starts a fix run on a conflict, and a stall watchdog warns, stops and resumes once.
Spec: docs/superpowers/specs/2026-10-25-work-until-merged-design.md (2026-10-25).

### FR-034 · Workflow graph: parallel, conditional and manual steps
P2 · added 2026-10-25 · source: Eric (software-factory survey, 2026-10-25; Fabro, Symphony's WORKFLOW.md, Mastra's stage modes)
Three optional step keys in the markdown format that exists: `after:` (steps ready together run side by side, read-only ones only), `when:` (verdict, check, changed or unchanged conditions that skip a step) and `mode: manual|auto` with a per-repo override in `.canopy/workflows.json`. An inline-SVG graph on the flow sheet and `canopy workflow show`. A file that uses none runs as today.
Spec: docs/superpowers/specs/2026-10-25-workflow-graph-design.md (2026-10-25).

### FR-033 · Best-of-N branch runs
P2 · added 2026-10-25 · source: Eric (software-factory survey, 2026-10-25; Orca, Claudexor, Anneal)
The pre-flight runs one note two or three times, across profiles if asked; the members share a group, gates and FR-032 scenarios dry-run on each ready one, a read-only `compare` run ranks them, and the winner is offered "land" by its own sort while the rest drop when it lands. A group sheet shows the members side by side with their diffstat, gates, score and cost. `canopy run --times`.
Spec: docs/superpowers/specs/2026-10-25-best-of-n-design.md (2026-10-25).

### FR-032 · Holdout scenario gates in the landing queue
P1 · added 2026-10-25 · source: Eric (software-factory survey, 2026-10-25; StrongDM, dark-factory)
End-to-end scenarios the agent never sees, kept under `<configDir>/scenarios/<repo key>/` outside every checkout, run in the queue after the repo's gates and before auto-merge; a red one sends the branch back with the scenario's name and the observed output, never its text; fuzzy scenarios are judged by Jev and the branch gets a satisfaction figure. `.canopy/scenarios.json` at HEAD sets the run line and the judge mode.
Spec: docs/superpowers/specs/2026-10-25-scenario-gates-design.md (2026-10-25).

### FR-028 · What is left on each subscription, in the status line
P3 · added 2026-10-24 · source: Eric (Orca video, 08:20)
Orca's status bar shows each subscription's usage beside its reset ("3% used 4h 32m", "24% used 6d 6h") for Claude, Codex and Grok. The costs view shows what was spent after the fact; this is the quota left now, so a long run can go to the harness with room.

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

### FR-016 · One Library across backends
P2 · added 2026-10-18 · source: Eric (Mac vs mini Library compare)
A link, tag, note, move or new category made in one backend's Library shows up in the other's. Today each backend keeps its own copy of categories.json, references.json, tags.json, relations.json and health.json, and peer sync carries only commits, so the mini started from defaults and drifts again after every edit. Host-specific keys (host_root, terminal_app, trusted_origins) stay per machine.
Spec: docs/superpowers/specs/2026-10-24-library-sync-design.md (2026-10-24). Phase 1 syncs the data; phase 2 replays folder moves when safe and asks otherwise (Eric's call). Phase 1 is live on the Mac and the mini since 2026-10-24 (d2cc24a, librarySync on for both).

## Shipped

### FR-029 · Design mode's copy and screenshot keys, and a draw mode
P3 · added 2026-10-24 · source: Eric (Orca video, Tonbi's AI Garage, 12:00 to 19:30), split from FR-027; Eric again 2026-10-25 (a preview toolbar's pick, remark, draw and clip buttons) · shipped 2026-10-25
While picking in Orca, C copies the hovered element and S screenshots it cropped to its box. A draw mode (pen, arrow, box, text, colours) over the page ends in Copy Markup for pasting into an agent. canopy's picker has neither. Eric's 2026-10-25 ask adds a clip of any box on the page, a remark on each picture, and the whole batch of picks, clips and notes organized by the agent and sent as one prompt.
Built 2026-10-25: C copies what the page reports about the element under the pointer, S takes its picture; ⬚ clip drags a box for a picture; ✎ draw puts pen, arrow, box and text marks in four colours over the page and snap takes a picture with them on it. Every picture opens the note form with a thumbnail, is saved on the backend beside pasted images (POST /api/repos/clip) and is named in the prompt for the agent to read; the marks go in words too (markupWords in ui/src/markup.ts). Pictures come from the screen-capture API with this tab preferred (ui/src/shots.ts), one share per session, on an https page or localhost; elsewhere the note goes with the box and the words. With two or more notes the prompt asks the agent to organize them by component and say its plan first. Checked on a scratch server in Chrome with the tab capture auto-picked (playwright-cli): the S key's element picture, a clipped box, a snap with a red arrow and a blue box drawn, three notes in the bar with thumbnails, and the copied prompt naming the three picture files and the marks in words. A still tab sends no new capture frames, so each wait for one is capped at 250 ms.

### FR-031 · Drag a tab from one shell window into another
P2 · added 2026-10-24 · source: Eric (canopy chat) · shipped 2026-10-24
A tab or a pane drags out of one shell window on the page into another (a card's shells, the strip along the bottom, the sessions view) and lands on the edge of the pane under the pointer, as a drag inside one window already did (FR-026). A shell moves between the strip and its own repo's card, a section between the strip, its card and a shell window, a chat or popup into the strip and a run into its card. A window that will not take the tab shows no drop. The tab menu moves it there too, which also works when the other window has no tab yet.
Built 2026-10-24: ui/src/panemove.ts (pure, tested) decides what each window takes and the id a page tab has once moved; usePaneDrag in components/SessionPanes.tsx keeps a page-wide list of shell windows and finds the one under the pointer with elementFromPoint, and moveTo carries the move out. A shell's place is the backend's: POST /api/terms/place sets tmux's @canopy_place, and every device's tab follows it (adoptPlaces). The strip along the bottom now splits as the sessions view does, from the same groups. A shell window of its own is another browser window, which a pointer drag cannot reach, so it keeps drags inside itself. Checked on a scratch server: a card's shell dragged to the strip's right edge, a strip tab dragged to a card pane's top edge, a section tab to the strip's left edge, both menu moves, a refused drop on another repo's card, and a reload of each. The strip's gear has "split tabs": split, as the sessions view (the default), or one at a time, where a tab dragged in lands as a tab of its own and the sessions view still splits them (the setting stripSplits, kept per screen); checked on a scratch server.

### FR-030 · A card's sections as tabs in a shell window
P2 · added 2026-10-24 · source: Eric (canopy chat) · shipped 2026-10-24
Any section of a card (history, files, changes and the rest) can leave the card and sit as a tab beside the shells, in every shell window: the card's shell section, the strip and the sessions view, and a shell window of its own. It splits with shells as a pane does. The arrangement is kept per kind of screen (phone, tablet, laptop, desktop, wide, ultra), and named templates, some seeded, can be saved, edited, deleted and loaded.
Built 2026-10-24, phases 1 to 3: ui/src/sectiontabs.ts (pure, tested) holds a section tab as its own record with a sec: id, so split groups hold it beside shells. A section's gear has "a tab in this card's shells" and "a tab in the shells strip", a shell tab's menu has "a section as a tab", and a shell window's gear lists the sections to add. The tab's close, its pane's close and "back to the card" put the section back. sectionTabs and the three split settings are kept per screen. Checked on a scratch server: history tabbed and split right with a new shell in a card, files in the strip and the sessions view (split down there, the new shell focused), changes split with the shell in a shell window, and a reload of each.
Phase 4 and more, 2026-10-24: chats and popups are tabs too (item tabs in ui/src/sectiontabs.ts): an agent run or coordinator from its sheet's gear, an agent session from the board's tile or the sessions view, and the inbox, waiting, tasks, health, shells, kept shells, ranger and tailchan popups from their gear, in the strip and the sessions view (a run in its card's shells too). Templates are a screen layout profile's tabs (ui/src/tabtemplates.ts): the presets come seeded by size, a profile's form takes this window's tabs, none or leave, and apply lands them on every open card. Window headers lay out in one row again. A run sheet's "a tab in its card's shells" was checked live on a scratch server with a real ask run: the sheet closed, the run sat beside the card's shell with its reply, and its ✕ closed the tab.

### FR-027 · Design mode batches annotations and picks who gets them
P2 · added 2026-10-24 · source: Eric (Orca video, Tonbi's AI Garage, 12:00 to 19:30) · shipped 2026-10-24
canopy's preview picker sends one element with one note. Orca's lets you pin several notes on the page before sending: each pick opens a popover with the element's selector path, a note and an intent (Change or Question), numbered dots mark the picked elements, and a bar reads "2 annotations ready" with Send and Copy All. Send asks where the notes go: a session waiting for input, or a new agent of any harness. While picking, C copies the element and S screenshots it cropped. A draw mode (pen, arrow, box, text, colours) ends in Copy Markup for pasting into an agent. The batching and the send-to picker are the parts worth taking first.
Built 2026-10-24: a pick's form takes a note and an intent (change it, ask about it); "add" keeps it and goes back to picking, "send now" sends the lot to the repo's agent. The page numbers each noted element with a blue badge (the `marks` message in core/pickscript.ts), and a bar over the frame lists the notes with send, copy all and clear. Send goes to the repo's agent, an agent running in one of the repo's shells, a new chat, or a new shell with either harness. The prompt is annotationsPrompt in ui/src/designmode.ts. Checked on a scratch server: two notes of each intent, the badges, the send menu finding claude in a shell, and the paste into it. The C and S keys and the draw mode moved to FR-029.

### FR-026 · Split panes in the sessions view
P2 · added 2026-10-24 · source: Eric (Orca video, Tonbi's AI Garage, 05:50) · shipped 2026-10-24
A tab in the sessions view splits right or down into panes, each its own shell, as Orca's terminal tabs do. Each pane has a header at its top right with a hand-off to the other harness (while an agent runs there), split right and close. The mouse does the rest: a click focuses a pane, the seams drag to resize, and a pane's header or a tab drags onto a pane's edge to split there. The tab menu gets split right and split down, and Ctrl+Shift+D and Alt+Shift+D split from the keyboard.
Built 2026-10-24: ui/src/splitpanes.ts (pure, tested) and components/SessionPanes.tsx; the groups are the per-browser setting sessionSplits. Checked on a scratch server: header and key splits, a seam drag, a pane dragged onto another's edge, a tab dragged onto a pane, close and out of the split, existing xterms kept through a split, and the phone width. The hand-off icon was checked live on 2026-10-24: with claude in a pane it opened codex in a new pane to the right. A repo's shell section splits too, with right-click tab menus, since 2026-10-24 (Eric looked for it there); checked on a scratch server: menu and key splits, the header split, a seam drag, a reload, a visit to the sessions view leaving the panel's groups alone, out of the split, a pane's close, a tab dragged onto a pane, the phone width and the bench.

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
