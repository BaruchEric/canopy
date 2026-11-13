# The manager: loadouts and a top view (FR-065)

2026-11-12. Asked as "adapt https://www.aihero.dev/the-home-repo-pattern to
create manager who orchestrate, coordinate etc new canopy worktrees providing
them model, skills, tools etc", then "focus on the goal user steering
workflows and UI from top view", then "do Recommendations and continue". Eric
handed over the how, so the approach and the calls marked below are Claude's,
waiting on his approval of this document.

Mockup (private canvas, sample data): https://claude.ai/artifact/K9QsTKbRNnvZViEFWVWZno,
with three artboards: the desktop top view, the equip sheet and the phone.

## What it is

The article's home repo is one repo holding an agent's skills, its steering
docs and pointers to every other repo. The agent runs from there, plans across
repos and starts work in a worktree per feature.

Most of that exists in Eric's setup already, spread out:

- dotclaude (`~/.claude`) holds the skills, the global CLAUDE.md and the
  kit's manifest, versioned and pulled onto every machine.
- canopy's Library knows every repo under `~/dev`, by category, with a line
  on each.
- The coordinator (FR-010) takes a goal, proposes one card per task across
  repos, starts each card as a branch run in its own worktree, and reports
  every outcome back into its chat.

Two things are missing, and this design adds them:

1. **Loadouts.** A named set of what a worker starts with: harness, model,
   effort, the skills it loads and the MCP servers it holds. Today a child
   gets the repo's job route, every skill Eric has, and no MCP server at
   all: `startCoordChild` passes no tools, and a run starts with
   `--strict-mcp-config` and no `--mcp-config`.
2. **A top view.** One screen above every worker of a goal, where Eric sees
   each worker's workflow step, what it was given and what waits on him, and
   steers from there: approve, release a gate, send back, say, stop, resume,
   hold. Today the steering is spread over the coordinator's chat, each run's
   sheet, the inbox and the landing view.

"The manager" is the coordinator with these two additions. It keeps its
name in the code; the page calls the screen the manager's top view.

## Why

Eric's word for the goal: him "steering workflows" "from top view". He runs
canopy from a desktop, a tablet and a phone, so the screen has to work on all
three, waiting items first.

## Goals

- A loadout names harness, model, effort, skills and MCP servers, and a run
  started with it gets exactly that, plus the repo's own checked-in skills
  and Eric's guardrails (`loadoutBase`).
- Loadouts live in the kit's manifest, so they are versioned, shared across
  machines, and checked against the skills and servers the kit knows.
- The manager picks a loadout and a workflow for each card. Eric can change
  either, and change a card's fields one by one, before the card starts.
- A card that names a workflow runs it as a flow on its own branch, so the
  workflow's gates become places Eric steers.
- A card can wait for another card (`after`).
- The top view shows one goal: a ring per card with one arc per step, the
  items that wait on Eric with their answers in place, a lane per worker with
  its step strip and loadout, and the manager's chat. It answers everything
  through routes canopy already has, plus the few below.
- Eric can hold a goal: no new card starts until he resumes it.
- Loadouts work outside the manager too, as a launch pick for any branch run.

## Non-goals

- No new home repo. dotclaude is the home. (The first mockup said
  `_manager`; it now says kit.json.)
- No grandchildren. A manager's worker never holds canopy's tools, so it
  cannot start runs of its own outside `COORD_AT_ONCE`.
- No workflow from a repo's own `.canopy/workflows/` chosen by the manager.
  It picks from the bundled and user workflows, whose text Eric or canopy
  wrote. Eric can still set a repo workflow on a card from the page.
- No unfenced manager. It keeps the 2026-10-16 isolation: no checkout, its
  own lane token, egress to Anthropic and canopy alone.
- No team sharing. canopy stays one person's tool.
- No editing a loadout from the page in this version, and no saving a card's
  changes back as a loadout. Loadouts are edited in `kit.json`.
- No per-step loadouts. One loadout per worker.
- No skills or MCP servers for Codex workers in this version.
- No pausing a flow between steps. Holding a goal stops new cards only.
- The manager still never starts anything itself. "start these" stays Eric's.

## Anti-goals

- The manager hands a worker a tool Eric never defined. It may only name a
  loadout. Only Eric changes the fields.
- A second place that holds skills or MCP definitions next to the kit.
- A top view that sends Eric into each run's sheet to answer it.
- A loadout that turns off Eric's guardrail skills.

## Constraints

- The coordinator runs only on the mini, under `CANOPY_CALLERS=enforce`, in
  the fenced `coord` container (SPEC.md, coordinator spec 2026-10-16).
  Loadouts and the top view's reading work on any backend.
- Children are branch runs, groups or branch flows, never the main checkout.
  `COORD_AT_ONCE` (3) and `BRANCH_RUNS_PER_REPO` hold.
- Runs spawn the user's `claude`, never the Agent SDK (SPEC.md, 2026-08-24).
- `src/core/` stays browser-safe where the UI imports it, strict TS with
  `noUncheckedIndexedAccess`, tests that pass on macOS and Linux.
- A run starts with `--setting-sources user,project,local` and
  `--strict-mcp-config` (`core/claudedrive.ts`). This design keeps both.

## Approaches

**A. Grow the coordinator (picked).** Cards gain a loadout, a workflow and
`after`; the launch path learns loadouts; a new view draws one coordinator's
goal from above. The home is dotclaude. It keeps the fence Eric asked for,
and reuses the card pump, settle notes, landing, the work ledger and
best-of-N. The cost: the manager still plans without reading code, from the
tree, the Library and what Eric says.

**B. A new manager in a home repo checkout, as the article has it.** An
interactive Claude session (like the ranger) in a `~/dev/_manager` repo, with
read access to every repo and canopy's MCP tools to start runs. It plans
better, since it can read code. It drops the fence Eric set on 2026-10-16,
which needs his yes, and duplicates the coordinator's pump and settling.

**C. The ranger as the manager.** The always-on agent already has
`--add-dir <root>` and canopy's tools. Teaching it to start loadout runs and
drawing the top view over its children reuses an agent that exists. It mixes
two jobs in one session (watching the machine and running goals), runs with
permissions asked, which stalls unattended work, and there is one per backend,
so two goals share one conversation.

Claude picked A: it is the only one that respects the isolation call without
a new yes, and every piece it needs (pump, settle, landing, ledger) is built.

## How it works

### Loadouts in kit.json

`kit.json` gains two blocks:

```json
"loadoutBase": { "skills": ["git-guardrails-claude-code", "blast-radius", "verify-build", "homelab:*"] },
"loadouts": {
  "homelab-ops": {
    "note": "changes to the mini's stacks and the tailnet broker",
    "harness": "claude",
    "model": "sonnet",
    "effort": "medium",
    "skills": ["homelab:tailchan", "homelab:macmini"],
    "mcp": ["executor", "wiki-memory"],
    "canopyTools": false
  }
}
```

- A pure parser beside the kit's (`parseLoadouts`, browser-safe, tested)
  checks: `harness` is a known one (default `claude`); `model` and `effort`
  are what that harness takes (`takesModel`, `takesEffort`); every `mcp`
  name is a key of the kit's `mcp` block whose shape claude can hold; a
  codex loadout has no `skills` or `mcp`; `note` is at most 200 characters.
  An error names the loadout and the field. A bad block fails only the
  loadouts, never the rest of the kit.
- `loadoutBase.skills` are skills every loadout keeps on. A name may end in
  `:*` to cover every skill with that prefix. The list above is Eric's
  current skillsets pins (`~/.claude/skillsets/pinned.json`).
- Skills are not checked at parse time, since the set differs per machine.
  They are checked at launch (below).
- `GET /api/loadouts` answers the parsed loadouts, each with its errors, and
  is part of the `kit` event's refresh. Read right; the coordinator's lane
  gets it.
- `canopyTools: true` serves a run Eric starts by hand. A coordinator's
  child and a group member start without canopy's tools whatever the
  loadout says, as the run route already refuses tools for both
  (`server/index.ts`, "a group or a coordinator starts without canopy
  tools").

### Starting a run with a loadout

A loadout resolves to three things at launch, in the process that spawns
`claude`:

1. **Agent settings.** `harness`, `model`, `effort` replace the route's. The
   rest of the route's settings (provider, yolo, extra) stay.
2. **A settings file.** Every skill on this machine that is neither in the
   loadout nor covered by `loadoutBase` gets `"off"` in `skillOverrides`.
   The listed ones get `"on"`, so a skill the user's settings demote still
   loads. canopy writes the file per run, 0600, beside the run's MCP config
   (`server/runtools.ts`), merged with the provider's settings file when the
   route names a provider, and passes it as `--settings`. It is removed with
   the MCP config. "Every skill on this machine" is the skills folder of the
   claude config dir the run uses plus the skills of the plugins it has on.
   A repo's own `.claude/skills/` are left alone: the repo's owner put them
   there for work in that repo (canopy's `redeploy` and `merge-main`).
   A loadout skill that machine lacks refuses the start with
   "loadout homelab-ops names homelab:tailchan, which mini does not have".
3. **An MCP config.** `mcpConfigJson` takes several entries: canopy's own
   when `canopyTools` is on (the run token, as today) and one per loadout
   server, built by the kit's `buildEntry` for claude (a server with secrets
   runs through `canopy-mcp-env`). `--strict-mcp-config` stays, so the run
   holds exactly these. `mcp__<server>__*` joins the run's allowed tools for
   each server, as `CANOPY_TOOL_RULE` does for canopy's. A server the kit
   does not want on this machine, or one the kit cannot build an entry for,
   refuses the start. One that fails to start where the run executes
   (probe P4) ends the run as failed at its init message, naming the
   server, so a run never goes on without a server its loadout names.

The run records `loadout` (the name) and `equip` (what it resolved to:
model, effort, skills, servers) so every view can show it. A loadout is also
a launch pick: the run route's `loadout` field (a run takes no
`LaunchPick` today; that type serves shells), the plan sheet and
`canopy run --loadout`.

### Cards carry a loadout, a workflow and `after`

`CoordTask` gains:

- `equip?: { loadout?: string; model?: string; effort?: string; skills?: string[]; mcp?: string[] }`.
  The coordinator may set `loadout` alone. The other fields are Eric's
  overrides of that loadout, set from the page or the CLI with the operate
  right, and only while the card is proposed or queued.
- `workflow?: string`. The manager may name a bundled or user workflow
  (the list `GET /api/coordinator/workflows` answers). Eric may also name
  one of the repo's own from the page, with his token.
- `after?: string[]`, ids of cards this one waits for.

`validatePlan` checks the loadout name exists and is valid, the workflow is
one the caller may name, `after` names cards of the same coordinator with no
cycle, and refuses `times` above 1 together with a workflow.

`after` waits for **landed**: the other card's branch merged, or its PR
merged. Ready, PR opened, or left to Eric does not count. Every card's
branch is cut from the tip of main (`cutBranch`), so in one repo only a
landed change is one the next card's branch has. Across repos the same rule
keeps the order simple. A ready branch that waits for Eric's land holds its
dependents until he lands it, which is the point: his land is the step.
`nextToStart` passes over a card while any card in its `after` has not
landed. A card behind one that failed or was dropped stays queued with the
outcome "waits for t1, which failed", and the manager hears it. Eric can
take a queued card's `after` off, or remove the card, since `edit` accepts
those two changes on a queued card as well as a proposed one.

Starting (`startCoordChild`):

- No workflow: a branch run as today, with the card's resolved loadout in
  place of the job route's agent. `times` 2 or 3 gives every member the same
  loadout.
- The same split triggers make, without their refusal of steps that ask
  (`triggerPlan` refuses those, since nobody is there; Eric is here). A
  workflow of one plain step is a branch run with that step's spec.
- Anything more: a flow on a branch (`cutBranch`, then `Flows.start` with
  `branch`), not marked unattended, so an `ask` gate parks and waits for Eric.
  The loadout's skills and servers apply to every step, and its servers are
  allowed on every step even where a step's `tools:` list leaves them out.
  A step that names its own `agent:` keeps that profile's model and effort,
  as a trigger's flow does (`live.agent(def.agent, …)` in `core/flow.ts`);
  other steps take the loadout's.

The card holds `flow` in place of `run` for a flow. It settles when the flow
ends: a done flow hands its branch to the landing queue, and the card then
waits for the queue's word exactly as a ready branch run's card does; a
stopped or failed flow fails the card. An active flow counts as one working
child.

### A card follows its branch

Today a card settles when its child stops, fails, is sent back or is left to
Eric, and a later run on the branch (a fix, a follow-up) has no `parent`.
Steering from the top view starts such runs, so the card has to follow them.
Any run canopy starts on a card's branch (a follow-up, a send back, a
resume, a fix, the usage limit's carry-on) carries the coordinator as
`parent`, becomes the card's `run`, puts the card back to running, and
settles it again with a new note to the manager. This generalizes what
`resumeLimited` does for the usage limit. Dependents keep waiting, since
they wait for landed.

### What each steering action does

- **Say to a worker.**
  - A worker waiting on a prompt gets an answer (`POST /api/runs/answer`).
  - A running Claude worker gets the words as a user message into its
    running session, through the driver's `nudge` (the stall watchdog's way
    in, `core/runner.ts`) and a new `POST /api/runs/nudge` with the operate
    right. `runs/say` only takes a chat between turns, and a worker is a
    job. A running Codex worker is refused in this version.
  - A settled worker gets a follow-up run on its branch with Eric's words
    (`startBranchFix`), which reopens the card.
- **Send back.** A branch whose landing verdict waits for Eric gets a
  follow-up run with his note (`startBranchFix`), which reopens the card.
  `POST /api/landing/fix` is not that path: it takes only a conflict, a red
  check or a moved base.
- **Land.** `POST /api/landing/land`.
- **Release a gate, or stop at it.** `POST /api/flows/resume`, which takes a
  flow parked at a gate, or `POST /api/flows/stop`.
- **Stop.** `POST /api/runs/stop` for a run, `POST /api/flows/stop` for a
  flow.
- **Resume a stopped worker.** A run resumes on its branch through
  `startBranchFix`. A stopped branch flow resumes through `Flows.pickUp`,
  which only the trigger hub calls today, through a new
  `POST /api/flows/pickup` with the operate right.
- **Start now.** `POST /api/coordinator/start` with `ids`.

### The manager's brief and reads

- The coordinator's lane gains `GET /api/loadouts` and
  `GET /api/coordinator/workflows`, a read that answers the bundled and user
  workflows only (name, label, blurb, steps and their gates). Neither reads
  anything out of a repo. `GET /api/repos/workflows` stays outside the lane:
  it needs the operate right, and a repo's own workflows are repo content,
  which the 2026-11-09 rule keeps behind a person's token.
- `lib/coordinator.md` gains a section: list the loadouts, pick one per card
  by what the task touches, say why in a line, name a workflow when the repo
  has one that fits, set `after` when one card needs another's change.
- `~/.claude/manager.md`, when the backend has it, is appended to the brief
  under "Eric's standing rules". That is the article's shared steering doc,
  kept in the home Eric already has.

### Holding a goal

`POST /api/coordinator/hold {run, held}` (operate). A held coordinator's
cards do not start, through "start these" or the pump; running children go
on. The run carries `held` so every page shows it. The manager hears "Eric
held the goal" and "Eric resumed the goal" as notes.

`POST /api/coordinator/start` takes an optional `ids` list, so the top view
can start one card ("start now") as well as all proposed ones.

### The top view

A new view, `?view=manager&run=<coordinator id>`, opened from the
coordinator sheet's head ("top view") and from the agents menu, which lists
the live coordinators. The mockup's layout, in canopy's tokens:

- **Goal head.** The goal (the coordinator's first message), the manager's
  model and effort, when it started, how many workers run and how many
  things wait on Eric. Actions: hold (or resume), add a task (posts a card
  through `/api/coordinator/plan`, which a page may do for any coordinator),
  end goal (stops the coordinator run).
- **Rings.** One ring per card, one arc per step, in card order, laid out in
  waves by `after`, with the manager's ring first (one arc per card). A
  flow's arcs are its workflow steps with the flow's step states (running
  and checking in sky, gated and held in lichen, passed in moss, failed in
  rust, to come in hair). A plain branch run's arcs are its lifecycle: plan
  (propose only), build, land, read from the run's status and its landing
  record. Under each ring: id, repo, state word, model. Selecting a ring
  selects its lane.
- **Needs you.** Every item of this goal that waits on Eric, answered in
  place, oldest first, through the actions above:
  - a child's prompt (plan approval, question, permission);
  - a child flow parked at a gate (release or stop);
  - a child branch whose landing verdict wants Eric (land or send back);
  - the manager's turn: proposed cards wait for "start these" (`coordTurn`),
    or the coordinator run holds a question prompt. Prose in its messages
    never counts, so an idle coordinator waiting on its children stays out
    of the list, as the 2026-11-11 change to `coordTurn` wants.
- **Workers.** A lane per card: id, title, state word, repo, branch,
  elapsed; its newest step line; the step strip (the flow sheet's
  `.step-strip` look); the equip chips (model and effort, skills, servers,
  loadout name). Actions: say, equip (proposed and queued cards only), stop,
  resume, start now (queued cards), open run (the run sheet), each as
  "What each steering action does" says.
- **Manager chat.** The coordinator's chat (`RunPane`), with a "to" switch:
  the manager (`runs/say`, since the coordinator is a chat), or one worker
  (the say action above).
- **Equip sheet.** For a proposed or queued card: pick a loadout, then
  override model, effort, skills (the machine's list, with a find box) and
  servers (the kit's `mcp` block). It writes through
  `POST /api/coordinator/tasks` with `equip`.
- **Phone.** Needs-you first, the rings in a strip that scrolls sideways,
  then a workers/chat switch like `CoordTasks`'s cards/chat on a phone, 44 px
  buttons, the equip sheet full height.

Everything updates from broadcasts canopy already sends (`run`, flows,
landing, PRs, `kit`). The view computes its rows in a pure, tested helper
beside the store (`ui/src/manager.ts`).

## Probes before plan 1

Run each against the installed `claude` on the Mac and in the mini's canopy
container, and write the answers into this section:

- **P1.** Does `claude` take `--settings` more than once, and if so how do
  two files merge? If it does, the provider file and the loadout file go
  separately and canopy writes no merged copy.
- **P2.** Under `-p --input-format stream-json`, does `skillOverrides` from
  `--settings` keep an "off" skill out of the model's list and the Skill
  tool? Does the flag's object merge with the user's `skillOverrides` key by
  key or replace it?
- **P3.** What names do plugin skills take in `skillOverrides`, and does a
  repo's own `.claude/settings.local.json` shadow the flag's overrides (the
  trap skillsets warns of)?
- **P4.** Which kit servers start for a run where runs execute, the mini's
  canopy container above all (HOME is `/home/bun` there)? Check one with
  secrets through `canopy-mcp-env`, `executor` (its headers helper lives
  under `~/.config/executor/`, which the container does not mount) and
  `wiki-memory` (it runs a script under `~/dev`). One that cannot start is
  refused at launch; mounting what it needs is its own request and Eric's
  yes.
- **P5.** Does one `--mcp-config` file with several servers under
  `--strict-mcp-config` load them all?
- **P6.** Does the claude driver's `nudge` deliver a user message into a
  running stream-json session without breaking the turn, and does Codex's
  driver have anything like it?

### Answers (2026-11-12, claude 2.1.323)

P1 to P5 ran on the Mac with `claude -p --input-format stream-json` and the
init message read back. P4 read the mini's `canopy-canopy-1` container.

- **P1.** A second `--settings` replaces the first: with two files, only the
  later file's `skillOverrides` took effect. canopy writes one file per run,
  the provider's settings with the loadout's `skillOverrides` laid over.
- **P2.** An "off" from `--settings` keeps the skill out of the init
  message's `skills` list. The flag's `skillOverrides` merges with the
  user's key by key: the user's own "off" entries stay off, and the flag's
  "on" brings back a skill the user turned off (`docktail`).
- **P3.** A plugin skill's key is `<plugin>:<folder>` (`homelab:tailchan`,
  `firebase:firebase-data-connect-basics`), a user skill's is its folder
  (`ripe`, not its SKILL.md name `cli-anything-ripe`). The flag beats a
  repo's `.claude/settings.local.json`: a local "on" lost to the flag's
  "off". A `"*": "off"` key does nothing, so canopy names every skill it
  turns off, taken from `listMentions` (`core/mentions.ts`), which reads the
  same folders and plugin manifest the CLI does. Skills from the claude.ai
  account (`anthropic-skills:*`) and Claude Code's bundled ones (`loop`,
  `code-review`) are not on disk and stay on. claude prints its init message
  only after the first user message, and the SessionStart hooks run first,
  so asking claude for its list before a run is not an option.
- **P4.** In the mini's canopy container HOME is `/home/bun`. `~/.claude` is
  mounted there (kit.json and `canopy-mcp-env` are present), but `~/dev` is
  mounted only at `/home/eric/dev` and `~/.config/executor` not at all, and
  `npx` is missing; `bash`, `bunx` and `node` are there. So `executor` cannot
  start, `wiki-memory` starts only if `~` expands to the host's home
  (`CANOPY_HOST_HOME`), `github` can, and the artcraft servers and
  `excalidraw` are Mac-only in the kit already. Two checks follow: the
  launch refuses a server the kit does not want on this machine or cannot
  build an entry for, and the run reads its init message's `mcp_servers`
  and ends failed, naming the server, when a loadout server is not
  `connected`.
- **P5.** One `--mcp-config` holding `pdfcraft` and `wiki-memory` under
  `--strict-mcp-config` loaded both (`connected`, source `dynamic`).
- **P6.** Left for plan 3. FR-066 (merged into main) adds words into a
  working run, and plan 3 builds on it rather than on a new `runs/nudge`.

## Phases

1. Loadouts end to end for a hand-started branch run: the probes, the
   kit.json blocks and parser, `GET /api/loadouts`, the launch (settings
   file, MCP config, allowed tools), the run's `loadout` and `equip`, the
   launch pick in the plan sheet, `canopy loadouts` and `canopy run
   --loadout`, the loadout shown on run cards. Shipped 2026-11-12 on branch
   `manager-loadouts` (plan 1). Known gaps: a fix or follow-up run on a
   loadout run's branch (`startBranchFix`) starts with the repo's agent, not
   the loadout (plan 2's cards carry `equip`); the "machine has this skill"
   check reads the repo's checkout while a branch run works in a worktree
   cut from the base; and claude 2.1.323 still lists a plugin's skills at
   init when `skillOverrides` turns them off, so only the user's own skills
   go off today.
2. Cards: `equip`, `workflow`, `after`, flows as children and their
   settling, a card following its branch, hold, `start` with `ids`, the
   brief and the lane reads, `manager.md`.
3. The steering routes (`runs/nudge`, `flows/pickup`, send back and resume
   through `startBranchFix`) and the top view on desktop, tablet and phone,
   with the equip sheet.

Later, each its own request: saving a card's changes as a loadout (a commit
to dotclaude through the kit's committing machine); a running worker's
loadout changed at its next step; per-step loadouts; Codex skills and
servers; holding a flow between steps; a compact repo index from the Library
for the manager to plan by area.

## Calls Claude made

1. Approach A, keeping the coordinator's fence.
2. dotclaude is the home: loadouts in `kit.json`, standing rules in
   `~/.claude/manager.md`. No `_manager` repo.
3. A card that names a workflow runs it as a flow, so its gates are where
   Eric steers; a card with none stays a branch run. (Eric's open question
   from the mockup; this is Claude's pick.)
4. Listed skills on, every other user and plugin skill off, `loadoutBase`
   and the repo's own skills kept on.
5. The manager names a loadout only; only Eric overrides fields.
6. A loadout's skills and servers cover every step of a flow; a step's own
   `agent:` still sets its model and effort.
7. Equip changes only before a card starts.
8. Codex loadouts take model and effort only, and a running Codex worker
   cannot be told anything.
9. `times` above 1 works with a loadout and is refused with a workflow.
10. "Pause all" in the mockup becomes "hold": no new card starts; running
    children go on.
11. Cards can wait for each other (`after`), and waiting means landed.
12. The manager's workers never hold canopy's tools.
13. The manager picks only bundled and user workflows; repo workflows are
    Eric's to set from the page.
14. A card follows every run canopy starts on its branch, and settles again.
15. A server that cannot start where the run executes refuses the start.

## Left to the builder

Module and component names, how the rings are drawn, the exact JSON of the
new routes beyond what is named here, the order of work inside a phase, and
the tests.
