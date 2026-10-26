# Best-of-N branch runs (FR-033)

FR-033 asks for one note to start two or three branch runs at once, each in
its own worktree and, when asked, each with its own agent profile, and for
canopy to compare what came back and land the one that is best. The idea is
Orca's fan-out ("fan one prompt across five agents, each in its own isolated
git worktree, compare the results and merge the winner";
https://github.com/stablyai/orca), with Claudexor's cross-model runs and
Anneal's two independent reviewers behind the scoring. Canopy has the
worktrees, the per-repo cap, the gates and the queue; what is missing is the
group that ties the members together, a reviewer, and a compare sheet.
Ranked second in `2026-10-25-software-factory-borrowings-design.md`.

## Where things stand (2026-10-25)

- A branch run is one run on one branch. `startRepoRun` (`server/index.ts`)
  takes `branch` and `pr` from the run route's body, refuses when
  `branchRunsFor(repo.id).length >= BRANCH_RUNS_PER_REPO` (3,
  `core/runner.ts`), and `startBranchRun` cuts the branch with `cutBranch`
  and starts the run with a `BranchStart`. The agent comes from the repo's
  `job` route (`resolveAgent`); the body carries no profile pick.
- `Run` carries `branch` (`RunBranch`, with `origin`), `parent` for a
  coordinator's child and `tasks` for a coordinator. There is no field that
  ties two runs together as siblings.
- `LandingHub` keeps one `LandingRun` per branch, sorts it when it settles
  `ready` (`settled`), and offers land, fix it and drop. `drop` removes the
  worktree and the branch. Gates run only inside a queue turn.
- The coordinator (`core/coordinator.ts`, `COORD_AT_ONCE` 3) starts one
  branch run per card and reads the branch's landing word; `nextToStart`
  passes over a repo whose slots are full.
- The costs ledger (`core/costs.ts` `CostEntry`) carries `run` and
  `session`; the costs view sums by run (`costSheet`'s `runs`).
- The judge (`core/jev.ts`) answers fixed questions about one piece of
  work. Nothing in canopy compares two.
- The CLI has no command that starts a plain run (to confirm:
  `cli/index.ts` has `land`, `pr`, `commit`, `push`, no `run`).

## The group

### Starting one

The run route's body gains two fields, read only with `branch: true`:

```json
{ "action": "propose", "note": "…", "branch": true, "times": 3, "profiles": ["default", "codex-fast", "default"], "autoLand": false }
```

- `times` is 1 to `GROUP_MAX` (3, which is `BRANCH_RUNS_PER_REPO`). With 1
  nothing changes. `profiles` names a profile per member (`isProfileName`,
  own-only lookup as everywhere); shorter than `times`, the last name
  repeats; absent, every member takes the repo's `job` route. A profile a
  member cannot run (`propose` needs Claude Code) refuses the whole start,
  400, before any branch is cut.
- The members need `times` free branch slots. A repo with fewer refuses,
  409, with the count, as a single branch run does today. The members start
  together; one start that throws tears down the branches already cut
  (`removeRunTree`) and answers its error.
- Every member is a plain branch run with the same note and action, and
  `Run.group` set to the group's id (`g-<8 hex>`), copied to its
  `LandingRun`. The group is a record of its own, not a run.

```ts
interface RunGroup {
  id: string;
  repoId: string;
  repoPath: string;
  action: RunAction;
  note: string;
  /** in start order; `origin` is the branch's id */
  members: { run: string; origin: string; profile: string | null }[];
  state: "working" | "scoring" | "reviewing" | "picked" | "landed" | "dropped" | "needs-you";
  autoLand: boolean;
  /** each member's standing once the group scores */
  scores?: Record<string, MemberScore>;
  /** the reviewer run and what it said */
  review?: { run: string; ranking: string[]; why: Record<string, string> } | { run: string; error: string };
  /** the winner's origin, once picked (by the reviewer, or by Eric) */
  winner?: string;
  pickedBy?: "reviewer" | "eric";
  startedAt: number;
  endedAt?: number;
}

interface MemberScore {
  state: RunBranchState | "failed";
  /** gates and scenarios run dry in the worktree */
  gates?: { ok: boolean; red?: string; tail?: string };
  scenarios?: { score: number; passed: number; total: number };
  verdict?: ReviewVerdict;
  /** +n −m over the merge base */
  diffstat?: { files: number; added: number; removed: number };
  /** dollars or tokens from the ledger, as the costs view sums them */
  cost?: { usd: number; tokens: number };
}
```

Records live in `<configDir>/landing/groups/<id>.json`, written by the
holder of the flows lock through the same `adopt`/`detach` handshake as the
landing records, one serial queue. A member's landing record is the same
one it has today; the group only reads it.

### Settling

`GroupHub` (`server/groups.ts`) follows the runner (`onRun`) and the
landing hub's broadcast. A group is `working` until every member has left
`working` (`ready`, `uncommitted`, `nothing`, `stopped`, or the run failed).
Then it scores:

1. Members that are not `ready` are out, with their state as the score.
   A group with no `ready` member reads `needs-you` with "nothing to pick
   from", and every member stays for fix it or drop as a single run would.
2. Each ready member gets a dry pass: `LandingHub.dryGates(origin)` runs
   the repo's setup (when the worktree has none yet) and gates in the
   member's worktree through the same `deps.check` as a turn, and the
   scenarios of `2026-10-25-scenario-gates-design.md` where the repo has a
   set, with no rebase and no landing. The result is written on the member's
   `LandingRun.dry` (`{head, gates, scenarios}`) and on the group's score.
   One member at a time per repo, since gates may share ports.
3. The sort each member already has (`review`) gives its verdict and the
   diffstat comes from `git diff --shortstat <base>...<head>`.
4. One ready member needs no reviewer: it is the winner, `pickedBy:
   "reviewer"` with the ranking of one. Two or more go to the reviewer.

### The reviewer

The reviewer is a run, not a judge question: ranking diffs needs the diffs
read, and Jev answers fixed questions about one text. It is a `compare`
action (`ACTIONS.compare`, verb "compare", never offered in a menu) started
in the repo's main checkout with tools `git-read, read` and `turns` 40,
under the repo's `flow` route, `unattended` (a tool outside the list is
denied, never asked). Its prompt names the note, each member's branch and
the line `git diff <base>...<branch>` to read it with, the dry results
(green or red, with the red gate's tail fenced between `<<<` and `>>>` as
data), and asks for a closing block:

```
<<<compare
{"ranking": ["run/add-retry-a1b2", "run/add-retry-c3d4"], "why": {"run/add-retry-a1b2": "one sentence", "run/add-retry-c3d4": "one sentence"}}
>>>
```

`parseCompare` (`core/group.ts`, pure) reads the last such block; a block
that is missing, names a branch that is not a member, or ranks fewer than
every green member fails the review, and the group reads `needs-you` with
the reviewer's closing text, so Eric picks. A red member may be ranked but
never wins: `pickWinner` takes the first ranked member whose gates passed
and whose scenarios met `minimum`; with none green the group is
`needs-you` with "no member passed the gates".

`reviewers: 2` on the start (the Anneal pattern) runs two reviewer runs,
the second with the members in reverse order so neither anchors on first
position. They must agree on the winner; otherwise `needs-you` with both
rankings. Default 1. The reviewer runs count for the repo's checkout as
any run does (`activeFor`), so they wait for a checkout run to end, and a
second reviewer runs after the first.

The reviewer's cost is a ledger row like any run's, with the group's id, so
the compare sheet shows what the choosing cost beside what the work cost.

### Landing the winner

- The winner's own sort decides, as for a single branch run: `land` waits
  for Eric, `approve` opens the `ApproveSheet`, `auto` joins the queue on
  its own only when the group was started with `autoLand: true`. The
  pre-flight's toggle says "land the winner on its own when its files
  allow"; off by default, since a fan-out is Eric choosing to look.
- "land the winner" on the group sheet is `POST /api/landing/land {run}` on
  the winner; `GroupHub` hears the landing word and moves to `landed`.
- Losers stay until the winner lands or Eric drops the group, then are
  dropped through `LandingHub.drop`, worktrees removed. A loser dropped by
  the group leaves a `held`-style notice ("not picked: <branch>, <why>") in
  `landing/notices.json`, not an inbox item. "keep" on a loser's row holds
  it for `LOSER_KEEP` (24 h); the sweep drops it after, as it drops the
  stale.
- "pick this one" on any green member overrides the reviewer:
  `pickedBy: "eric"`. "fix it" on a member works as today and the group
  scores again when it settles ready.
- A group whose winner is sent back from the queue (red after rebase,
  conflict) reads `needs-you` with the entry's reason; "fix it" rejoins as
  for a single run. No loser is promoted on its own.

## The view

- The pre-flight (`Sheet` kind `plan`) gets a `times` segmented control,
  1 / 2 / 3, shown only with the branch toggle on and only where the repo
  has the free slots (greyed with "2 of 3 slots free" otherwise). With 2 or
  3, a row per member offers the profile (the routes' names, "repo's
  default" first), a `reviewers` 1 / 2 pair and the auto-land toggle.
- A new sheet `{kind: "group", groupId}` (`components/GroupSheet.tsx`),
  opened from the landing section's group row, a member's `ParentLine`
  ("one of 3") and the inbox item. One column per member: profile, state,
  gates (green or the red gate's name), scenario score, verdict chip,
  diffstat, cost, the reviewer's sentence, and "open its run", "pick this
  one", "fix it", "drop". The winner's column is marked. Under the table,
  the reviewer's run line and "run the review again".
- The landing section lists a group as one row ("best of 3: <note>", state
  word from `groupWord`) folding to its members, so a repo's section does
  not triple in height. The card chip counts a group once.
- The inbox gets `group` as an `InboxItem.kind`: "best of 3 ready: pick"
  for `needs-you`, with the group sheet as its target. A `picked` group
  waiting for "land the winner" is listed under "waiting on you" with the
  ready runs, not as an ask.
- The costs view's "By run and chat" folds a group's members and reviewer
  into one line ("best of 3 · <verb>") with the sum, and the line opens
  the group sheet. The compare table's cost column comes from the same
  rows (`CostEntry.group`).

## Routes and CLI

- `GET /api/groups` (`read`): every group this backend keeps, in the
  `landing` SSE event's shape as `LandingInfo.groups`.
- `POST /api/groups/pick {group, run}` (`operate`): Eric's pick.
- `POST /api/groups/review {group}` (`operate`): run the reviewer again.
- `POST /api/groups/drop {group, keep?: string[]}` (`operate`): drop every
  member but the kept ones.
- The run route's body as above. `canopy run <repo> <action> [-m note]
  --times 3 [--profiles a,b,c] [--reviewers 2] [--auto-land]` is the CLI's
  first plain run command (`cli/run.ts`), and `canopy groups [repo]` lists
  groups the way `canopy queue` lists entries, with `canopy groups pick
  <group> <run>`.

## Interactions

- **One run per repo.** Members are branch runs and share no working tree,
  so the checkout's rule does not apply; the slot cap does.
- **Collision warnings** (`2026-10-25-collision-warnings-design.md`).
  Members of one group touch the same files by design. The touched-set
  model takes `Run.group` and never raises a collision between two runs of
  one group; the compare sheet shows the files every member touched and
  the files only one did, which is what the reviewer should look at.
- **The capacity governor** (`2026-10-25-capacity-governor-design.md`). A
  group's members start with priority `low`, so a fan-out never takes the
  room an interactive chat or a trigger's fix needs. When the governor
  holds a member, the group waits `working` with "2 of 3 started" rather
  than scoring early; a member it never starts within `GOVERNOR_WAIT`
  settles as out, with that reason.
- **The coordinator.** A card may carry `times` (1 to 3, in `validatePlan`
  with the other limits); the hub starts a group through the same path and
  settles the card on the group's word (landed, picked and waiting, needs
  you). Second plan.
- **The PR watch.** A group whose start said `pr: true` opens a PR for the
  winner alone, through `openPr` once picked; losers never push.
- **Restart.** Group records are adopted with the landing records; a group
  `working` reads its members' states again; a `reviewing` group whose
  reviewer run is gone runs the review again; a `scoring` group scores
  again (a dry pass is idempotent).

## Components

- `src/core/group.ts` (new, pure): `RunGroup`, `MemberScore`,
  `GROUP_MAX`, `LOSER_KEEP`, `settleGroup`, `pickWinner`, `parseCompare`,
  `comparePrompt`, `groupWord`, `agree` (two rankings).
- `src/core/types.ts`: `Run.group`, `LandingRun.group`, `LandingRun.dry`,
  `LandingInfo.groups`, `CostEntry.group`, `InboxItem.kind` `group`.
- `src/core/actions.ts`: `compare` in `ACTIONS`, unlisted.
- `src/server/groups.ts` (new): `GroupHub`, its routes, the records.
- `src/server/landing.ts`: `dryGates(origin)`, `drop` from a group, the
  `landing` event carrying groups.
- `src/server/index.ts`: the body's `times`, `profiles`, `reviewers`,
  `autoLand`; `startGroup` beside `startBranchRun`; the reviewer's start.
- `src/core/costledger.ts`: the row's `group`.
- `src/core/coordinator.ts`: `times` on a card (plan 2).
- `src/cli/run.ts` (new), `src/cli/groups.ts` (new), `cli/index.ts`.
- UI: the pre-flight's controls (`RunSheet.tsx`), `GroupSheet.tsx`,
  `ui/src/groups.ts` (pure: `memberColumns`, `groupWord`, `costOfGroup`),
  `Landing.tsx`'s group row, `inbox.ts`'s `group` kind, `costs.ts`'s fold.
- `docs/architecture.md`: a "Best of N" section after "The landing queue".

## Calls

Made on 2026-10-25:

1. **The reviewer is a run, not a judge call.** A ranking needs the diffs
   read and reasons given; Jev classifies one text against fixed
   questions. The run costs a few minutes and a few cents, which the
   compare sheet shows.
2. **A red member never wins.** The reviewer may prefer its approach, but
   the gates are the repo's word. Eric can still pick it and fix it.
3. **Losers go when the winner lands, not when it is picked.** Picking is
   cheap to undo; landing is not. 24 h "keep" for a look.
4. **Auto-land is off by default for a group.** The sort may say `auto`
   for a docs change, but a fan-out is a choice to compare, and landing
   before Eric saw the compare defeats it.
5. **`GROUP_MAX` is the slot cap.** Three is Orca's useful range too; five
   agents on one note is a bill, not a comparison, on a Max plan.

For Eric:

6. Whether `profiles` should allow Codex members for `propose`. Today
   `propose` needs Claude Code (its plan prompt); a Codex member would have
   to run `ask`. The spec refuses the mix; allowing `ask` members beside
   `propose` ones is a small change if wanted.
7. Whether two reviewers (Anneal) are worth the default. One is proposed;
   `reviewers: 2` is there for sensitive repos.

## Out of scope

- Fan-out across backends (a member on the mini, one on the Mac). Groups
  are per backend like the queue.
- Merging the best parts of two members. The winner lands whole.
- A group over checkout runs, workflows or fleets.
- Learning which profile wins over time. The costs view and the group
  records hold the data; a later report could read them.

## Testing

- `group.test.ts`: `settleGroup` over every member state mix, `pickWinner`
  with a red first-ranked member, `parseCompare` (missing block, a
  non-member, a short ranking, two blocks: the last wins), `agree`,
  `groupWord`, `GROUP_MAX` and `profiles` padding.
- `server/groups.test.ts` over a stand-in runner and landing hub: a group
  that starts three, one that cannot cut its third branch and tears down,
  scoring order one member at a time, a reviewer that fails to parse
  reading `needs-you`, Eric's pick, losers dropped on land and kept with
  "keep", adoption after a restart in each state.
- `server/landing.test.ts`: `dryGates` runs setup once and the gates with
  no rebase, writes `dry`, and a dry red leaves the record `ready`.
- `runner.test.ts`: members count against the slot cap; `Run.group` on
  every change from the first.
- `costledger.test.ts`: rows carry `group`.
- `coordinator.test.ts`: `times` limits and a card settling on a group's
  word.
- UI: `groups.test.ts` (`memberColumns`, `costOfGroup`), `inbox.test.ts`
  (`group` kind), `costs.test.ts` (the fold).

## Plans

1. Groups of one profile: the body, `startGroup`, the records, dry gates,
   the reviewer run and `parseCompare`, the group sheet, land the winner,
   losers dropped. `canopy run --times`.
2. Profiles per member, `reviewers: 2`, the coordinator's `times`, the
   costs fold, the collision suppression once FR-040 lands.
