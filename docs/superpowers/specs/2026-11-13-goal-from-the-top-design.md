# A goal from the top (FR-067)

2026-11-13. Source: Eric, "start from top chat (with defaults set for Providers) flow with defaults set for coordinate routing, such as model and effort etc and than base on user prompts and or attachments, repos etc start existing canopy cards and worktrees or create new ones". It came right after he asked why a coordinator is tied to one repo to start.

Every choice below that Eric did not make is marked **(call)**. Claude made those calls so the work could go ahead, and each one can be changed.

## Intent

A coordinator starts today from one repo card's ⋯ menu. Eric wants to start a goal from the top of canopy instead, the way he would open a chat: write what should get done, attach files, name repos if he wants to, and let the manager plan cards across the repos. Those cards can work in existing repos and kept worktrees, or make new worktrees and new projects. Its agent comes from the backend's `coordinate` routing (model, effort), not from whichever repo he happened to click.

The goal is not tied to any repo, and the manager view is where he starts goals as well as steers them.

## Goals

1. A composer at the top that starts a coordinator at no repo. It takes a goal, files, the repos Eric names, and a model and effort that default to the backend's `coordinate` route.
2. Cards that run in place in a kept worktree: an existing one, or a new one canopy makes for a branch the card names.
3. Cards that make a new project through the incubator and follow it until it is live.

## Non-goals

- A run with no repo id. `Run.repoId` stays required (about 126 UI references and the server's records lean on it). A top-level goal uses one fixed anchor id instead (Part 1).
- A coordinator that writes anything itself. It keeps its 2026-10-16 fence: a token to read and plan, no checkout, egress to Anthropic only. Canopy makes trees and projects, and only when Eric starts the card.
- A Codex coordinator, or a provider gateway reachable from the coordinator's sandbox. The coordinate route's provider is passed as it is today.
- New repos made any way other than the incubator (no bare `git init` on the scan root).

## Anti-goals

- Anything starting before Eric presses start these or start on a card.
- Attached files ending up in a commit. Files never go into a worktree; runs read them from a folder beside it.
- A goal that disappears from the page because its anchor is not a repo in the tree.

## Constraints found

- Only a backend whose `/api/about` says `coordinator: true` runs one. Today that is the mini; the Mac and De Soto say false.
- `startCoordinator` (server/index.ts) needs a `Repo`. It checks host, forge and seed, refuses a second coordinator at the same repo (also in `Runner.start`), takes `agentFor(config, repo.path, "coordinate")` with harness claude, yolo and no extra flags, and starts in `<CANOPY_COORD_ROOT>/<run id>`, which is removed when the run ends. That path is the same in the canopy and coord containers.
- The brief ends with `goalRepoLine(repo.id)`: "plan its cards there unless the goal names other repos; do not ask which repo".
- `validatePlan` requires each card's repo to be a local repo id this backend holds.
- `startCoordChild` starts every card as a branch run (`startBranchRun`), so a card naming a kept tree's card would branch off it, which is wrong.
- Kept trees (FR-051) live under `<configDir>/trees/<repo key>/<slug>/` and show in the tree as repos from the `trees` source. `BranchTrees.add(repo, branch, base, caches)` makes one in the background (`preparing`, then `ready` or `failed`), and refuses a tree card or a branch that already has a tree.
- The incubator takes an intake as multipart (`readIntake`: `text`, `url`, `file`, `repo`), runs stages in its own container, and needs stages on the backend (`NO_STAGES`).
- Run chats take no attachments today. Claude Code's Read tool reads images, so a file path the model is told about is enough.
- The page never prunes runs by repo (`pruneByRepo` covers panels, folds and tabs only), and the server's lookups of a run's repo fall back to the id (`?? run.repoId`).
- `ActionSpec.addDirs` already passes `--add-dir` to Claude (used by workspace runs).

## Approaches considered

- **A. Make `repoId` optional.** It would be the truest model, but it touches about 126 UI references, the runner, the sweep, costs and transcripts. Too wide for what it buys.
- **B. Anchor top-level goals to a real repo:** Eric's pick, the first named repo, or a configured home repo such as dotclaude. This keeps the tie Eric asked to remove, and the mini's tree has no dotclaude checkout.
- **C. A fixed anchor id that is not a repo (picked, call).** The run's `repoId` is `~goal`, a server-built `Repo` with the scan root as its path, never in the tree. The UI names it "goal". Several goals can run at once, since the one-coordinator-per-repo check skips the anchor. It costs a handful of places that print a run's repo, and those already fall back to the id.

## Part 1: a goal from the top

### What Eric sees

The manager view's goal list (`?view=manager` with no goal named) opens with a composer above the goals going:

```
new goal                                         runs on mini
┌────────────────────────────────────────────────────────────┐
│ what should get done? @ names a repo                       │
│                                                            │
└────────────────────────────────────────────────────────────┘
 [shot.png ×] [notes.md ×]   + attach
 Claude Code · model [opus ▾] · effort [high ▾]    (from mini's coordinate route)
                                                 [start goal]
```

- **Opening it.** The top bar gets a "new goal" button that opens `?view=manager&new=1` with the composer focused **(call)**. While a goal is open, its head gets "new goal" beside "add a task".
- **The box.** Typing `@` offers the coordinator backend's local repos (not hosts, forges or seeds), and a pick writes `@<repo id>`. The named repos are sent as `repos[]` alongside the text.
- **Files.** Attach, paste or drop: at most 10 files, 25 MB in all **(call)**. Each shows as a chip with ×.
- **Model and effort.** Two selects default to the backend's `coordinate` role (`routes.roles.coordinate`, else the default). The harness is fixed to Claude Code. The line names where the defaults come from.
- **The backend.** The composer targets the backends whose about says `coordinator`. With one, it names it. With several, it shows a select. With none, it says so and start goal is off.
- **Starting.** Start goal posts, then opens `?view=manager&run=<id>`. An error shows under the box and keeps the text and files.
- **Phone.** Full width, with fields at least 44 px tall.

### Server

`POST /api/coordinator/new` as multipart, with right `operate` like the other coordinator writes (`/api/coordinator/start` already starts a goal's cards). A page or CLI token may use it; a coordinator's token may not.

- **Fields:** `goal` (text, required, at most 20,000 characters), `repos[]` (repo ids, at most 20, each a local non-seed repo this backend holds), `file`/`files[]` (at most 10, 25 MB in all), and `model` and `effort` (optional, validated as the agent form validates them).
- **Folder.** It makes the coordinator's folder as today, plus a files folder `<CANOPY_COORD_ROOT>/goal-files/<run id>/` (0700) that outlives the run. Names go through `clipLabel`, and duplicates get ` (2)`. A start that fails removes both folders.
- **Settings.** The agent is `agentFor(config, null, "coordinate")`: the role's route with no repo override. `model` and `effort` replace that route's, and harness, yolo and extra stay as today.
- **The brief.** It ends with `goalTopLine(repos, files)` instead of `goalRepoLine`:

  > Eric started this goal from canopy's top, at no repo. He named these repos: a, b. Plan there first. His files are in <dir>: x.png, notes.md. Read each before you plan. A card may list the files its worker needs in `files`. When the goal leaves the repo open, ask which.

  The coordinator is given `--add-dir <files dir>`.
- **The anchor.** `GOAL_ANCHOR = "~goal"` in `core/coordinator.ts`. `goalAnchor(root)` builds the `Repo`. `Runner.start` and the route skip the one-coordinator check for it. `coordinatorFor(repoId)` still answers for real repos.
- **Card files.** A card's `files` (names from its goal's files, checked in `validatePlan`) gives its child `addDirs: [files dir]` and a line under the note: "Files from Eric for this task: <absolute paths>". This works for a card of any goal, as long as the goal has files.
- **Pruning.** A goal-files folder whose coordinator is not live and whose newest file is older than 7 days is removed at each start and once at server start **(call)**.

### CLI

```
canopy coordinator new "<goal>" [--repo ID]... [--file PATH]... [--model M] [--effort E] [--on NAME]
```

It prints the run id and the manager URL. It is `new`, since `canopy coordinator start <run> [id ...]` already starts a goal's cards.

### What the anchor changes in the UI

- `repoWord(s, repoId)` answers "goal" for the anchor.
- Places that print a run's repo name use it: the run sheet head, the dock tab label, run solo, the section tab, agent focus, the inbox and the feed.
- The manager view's goal head reads "goal from the top" in place of a repo.
- `AddTask` already falls back to the first repo when the coordinator's repo is not among its choices.
- The chat composer's mentions ask for no repo's commands when the repo is the anchor.

## Part 2: cards in kept worktrees

- **The field.** A card may carry `tree: "<branch>"`. The card then runs in place in the kept tree for that branch in the card's repo, where a plain card would cut a run branch.
- **Validation.** `validatePlan` checks `isBranchName`, refuses `tree` with `times` or a `workflow` **(call: no flows in a tree in this version)**, and refuses a card whose repo is itself a tree card. The coordinator names the tree by branch on the main repo.
- **Starting the card** (Eric's press, `startCoordChild`):
  1. Find the repo's tree for the branch (`BranchTrees` by branch).
  2. If there is none, call `add(repo, branch, undefined, true)`.
  3. While the tree is `preparing`, the card reads "making tree <branch>" and holds its place.
  4. A tree that fails fails the card with the tree's `why`.
  5. Once the tree is `ready`, start the card's action as an in-place run on the tree's own repo id (`startRepoRun`, no branch), with `parent` set.
- **Settling.** The card settles when that run ends: done with the outcome "done in tree <branch>", or failed or stopped as today. It never goes through the landing queue. The tree's branch is Eric's to merge from the tree, as with any kept tree.
- **For `after`.** A tree card counts as landed for its dependants once it settles done **(call)**.
- **Pick-up and follow-up.** A later in-place run in the same tree (Eric's, or the manager chat aimed at the worker) is adopted the way a branch card adopts a run on its branch.
- **The brief.** `GET /api/trees` joins the coordinator's lane (`core/callers.ts`, its route set), and the brief tells the coordinator about it (the kept trees, each with repo, branch and state) and when to use `tree`: Eric names a worktree or a branch to keep, or the work wants a long-lived checkout (a dev server, a branch to try by hand).
- **The UI.** The card facts line gets "in tree <branch>". The lane shows the tree's state while it is being made, plus "open tree", which opens the tree's card.

## Part 3: cards that make a new project

- **The card.** `action: "project"` carries no `repo`. Its title and note are the idea, and its `files` go along as intake files.
- **Validation.** `validatePlan` accepts it only when the backend's incubator can run stages (else `NO_STAGES` as the card's error). It refuses `times`, `workflow`, `tree` and a loadout.
- **Starting the card.** Canopy calls the incubator's intake in process: text = title + note, the card's files, `via: "coordinator"`. The card holds `sprout` in place of `run`.
- **Following the sprout:**
  - waiting on clarify questions: "needs you", with a link to the sprout in the incubator view
  - live or handed off: done, with the outcome naming the new repo id
  - rejected or stopped: failed
  - parked: "needs you"
- **Places.** A project card does not count against `COORD_AT_ONCE`. The incubator's own concurrency (`SPROUT_CONCURRENCY`) holds it **(call)**.
- **For `after`.** A project card counts as landed when its sprout is live **(call)**.
- **The UI.** The ring shows the sprout's stage and the lane shows "open in incubator".

## Order and delivery

Three plans, built one after another, each merged to main, deployed with `bun run redeploy all`, and checked live on the mini from Chrome at 1440 px and at phone width before the next one starts:

1. **Plan 1, a goal from the top:** anchor, start route, files, brief line, composer, top bar entry, CLI.
2. **Plan 2, cards in kept worktrees.**
3. **Plan 3, cards that make a new project.**

## Left to the builder

- The exact top-bar spot for "new goal" and its shortcut key, if a free one fits.
- How the composer reuses `useMentions`. It needs a backend-wide repo list, not one repo's commands.
- The exact multipart parsing (reuse `readIntake`'s pattern).
