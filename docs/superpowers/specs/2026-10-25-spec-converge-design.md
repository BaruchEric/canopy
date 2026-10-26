# Spec drift and convergence, on a schedule (FR-041)

FR-041 asks canopy to notice when a repo's SPEC.md stops being true and to
open the fix itself. The rule in every repo canopy scans is "update SPEC.md
in the same commit as the change that makes it wrong"; agents and people
both forget, and the file drifts a line at a time until the next agent reads
a stack version that is two majors old. GitHub Spec Kit's `/speckit.converge`
(github.com/github/spec-kit) closes the loop between spec and code on
request; Spexcode's drift detection dispatches a fixer when its spec tree
and the code disagree. canopy has the pieces: a SPEC.md convention with
seven fixed sections, review rules under which docs land on their own, a
trigger engine that runs an unattended workflow on a branch, and `cron.ts`.
This spec adds the one trigger source canopy lacks, a clock, and the one
bundled workflow that reads SPEC.md against the repo. Ranked tenth in
`2026-10-25-software-factory-borrowings-design.md`; the `schedule` source
is also what `2026-10-25-capacity-governor-design.md` (FR-036) and
`2026-10-25-harness-share-design.md` (FR-044) lean on for anything timed.

## Where things stand (2026-10-25)

- **SPEC.md is text canopy checks the edges of.** `src/core/spec.ts` knows
  the shared blocks between `spec:begin` and `spec:end`, their hashes in
  `.canopy/spec.json`, and the states `in-sync`, `behind`, `drifted`, `not
  adopted` (`specState`). "Drifted" means a *block* was edited by hand. The
  seven sections' truth against the code is nobody's to check; the
  bundled `spec` workflow (`lib/workflows/spec.md`) fills them once, on
  adoption, with `gate: ask`.
- **Triggers fire on hooks.** `TRIGGER_SOURCES` is `sentry`, `linear`
  (`src/core/trigger.ts`; FR-035 adds `github` and `forgejo`). Every rule
  is started by a POST to `/api/hooks/<source>/<name>` or by `POST
  /api/triggers/fire {rule, title}`. Nothing in the hub runs on a clock.
- **The clock exists.** `parseCron`, `nextFire`, `isCron`, `CRON_MAX` in
  `src/core/cron.ts`, used by the ranger's wakes (`ranger/wakes.json`) and
  the sweep (`DEFAULT_SWEEP.cron`). Both run on one backend's own timer;
  the sweep's and the ranger's are per backend and never on the flows
  lock.
- **An unattended run on a branch.** `startTriggerRun` cuts a branch, runs
  the rule's workflow as a branch run or a branch flow (`triggerPlan`),
  denies every tool outside the step's list, and hands the branch to the
  landing hub with `openPr` so a PR opens. The workflow comes from the
  bundled and user folders only.
- **Review rules and SPEC.md.** `sortBranch` (`src/core/review.ts`) sorts
  a `.md` change as `docs`, which canopy's own `review.json` lets land on
  its own. But `sensitiveWhy` lists `SPEC.md` (with `CLAUDE.md`,
  `AGENTS.md`, `DESIGN.md`, `SKILL.md`) as an agent instruction file, so
  every change to it sorts `approve` whatever its class.
- **No CLI starts a flow.** The CLI has `canopy spec status|sync|check`
  (`src/cli/index.ts` case `spec`); flows start only from the page or a
  trigger (`POST /api/repos/flow`).

## Probes before plan 1

- **P1.** `git log -1 --format=%cI -- SPEC.md` and `git log --since=<that>
  --name-only --format=` give the Check step what moved since SPEC.md was
  last touched; confirm `--since` takes an ISO date with an offset on both
  macOS and the container's git.
- **P2.** How a trigger flow's steps see each other: the Fix step's prompt
  carries the Check step's closing text today (`retryReason` carries a
  rewind's reason; confirm `flow.ts` passes the previous step's `summary`
  into the next prompt, or the Fix step must re-read). The design assumes
  the previous step's summary is in the next step's prompt as it is for
  `sentry-triage-fix`.
- **P3.** `nextFire` across the backend's `TZ` (the container's comes from
  `.env`, docs/deploy.md): a rule at `0 5 * * 1` fires at 05:00 local on
  the mini, which is what Eric means.

## The `schedule` source

### The rule

```json
{
  "name": "spec-weekly",
  "source": "schedule",
  "cron": "0 5 * * 1",
  "repo": "*",
  "workflow": "spec-converge",
  "land": "queue",
  "only": ["spec-adopted"]
}
```

- `cron` is a five-field line, `parseCron`, at most `CRON_MAX`. Required
  for this source; a bad line is left out and named on the page like any
  bad rule.
- `repo` is one repo's id or path, or `"*"`: every local repo this backend
  scans (no `host`, no `forge`, not a seed). `"*"` is allowed only on a
  `schedule` rule.
- `only` narrows `"*"`: `spec-adopted` (a `.canopy/spec.json` and a
  SPEC.md), `dirty`, `unpushed`, `clean` (the `WorkflowWhen` words through
  `checkWhen`). Default none, so a schedule rule on `"*"` with a workflow
  of its own runs everywhere.
- `land` is `queue` (the branch lands through the landing queue under the
  repo's review rules, as a hand-started branch run does) or `pr` (a PR
  opens, the Sentry and Linear path). Default `queue` for a schedule rule:
  a scheduled touch-up of docs needs no pull request, and the landing
  section's "look and land" is where Eric sees it. FR-035 may adopt the
  same key for its sources.
- No `secretEnv`, no hook (`/api/hooks/schedule/*` is 404), no `tokenEnv`
  unless the workflow writes somewhere; `projects`, `levels`, `labels`,
  `org`, `clientId` are bad lines on it.

### Firing

- `TriggerHub` keeps `nextFire` per schedule rule in memory, computed from
  the rule and the last fire kept on the newest event of that rule
  (`lastAt`), so a restart does not refire a slot it already took. A fire
  that came due while canopy was down fires **once** on start, like a
  ranger cron (`cronAfter`'s rule), unless the next slot is less than an
  hour away.
- The tick is the hub's existing 30 s queue pass. **Only the holder of the
  flows lock fires**, since only it writes `triggers/events.json`; a second
  server on the same config dir computes nothing.
- A fire on `repo: "*"` makes one event per matching repo, keyed
  `<repo key>@<fire minute ISO>`, `short` the date, `title` "<workflow> on
  <repo name>, <day>", `link` none, `source: "schedule"`, `service:
  "schedule"` (`SERVICE_NAME` "Schedule"). Events start `queued` and go
  through the same branch-slot cap (`BRANCH_RUNS_PER_REPO`) and the same
  `nextToStart` order as any trigger's, so a fleet of twenty repos runs
  three at a time and the rest wait as `queued`.
- A repo whose previous event under this rule is still live (`eventLive`,
  or `ready` with a branch not yet landed) is **skipped** for this fire,
  with no event made: the page shows "skipped <repo>: last run still
  going" in the rule's card, kept to the newest 20 skips in memory.
- `POST /api/triggers/fire {rule}` on a schedule rule fires it now for
  every matching repo; `{rule, repo}` for one. Both `operate`.

### The ranger alternative, and why not

The ranger has cron wakes already, and a wake could tell it to start the
workflow on each repo. Three things make the trigger the right home: there
is no CLI that starts a flow, so the ranger would need one and would do by
conversation what the hub does by record; a ranger turn is an interactive
Claude session with permissions on, where a trigger's run is unattended and
denies what its step did not list; and a trigger's event is a record on
disk per repo, with resume, retry and the triggers page, where a wake is a
DM. The ranger's crons stay for what needs a conversation.

## The `spec-converge` workflow

`lib/workflows/spec-converge.md`, bundled, `listed: true` (Eric may run it
from a card's menu or as a fleet, too), `when: any`, `expects-change: true`.

```
## Check
tools: git-read, read, Bash(ls:*), Bash(bun pm ls:*), Bash(cat:*)
turns: 40
```

Task, in short: read SPEC.md's seven sections and check each against the
repo, changing nothing. The prompt names what to compare:

1. **Stack and versions** against the lockfile (`bun.lock`, `package-lock
   .json`, `Cargo.lock`, `go.sum`, `uv.lock`) and the manifest; a version
   SPEC.md names that the lockfile does not have is drift.
2. **How it is built and run** against `package.json` scripts, a
   `Makefile`, `justfile`, `Cargo.toml`; a command SPEC.md lists that no
   longer exists, or a script every agent needs (`test`, `build`) that
   SPEC.md omits, is drift.
3. **Data and state** against what the code writes: grep for the config
   dir, file names and env variables the section names, and for `writeFile`
   or the language's equivalent on paths the section does not name.
4. **Decisions** against `git log --since=<SPEC.md's last commit>
   --format='%h %s'` for a commit whose subject reads like a decision
   (a dependency swapped, a protocol replaced, a thing removed) with no
   dated line for it.
5. **Out of scope** against the tree: a folder or dependency that does what
   a line says the repo will not do.
6. The 120-line cap, the seven headings in order, "none" rather than a
   missing section.

The step ends with the report as its closing text, in a fixed shape the Fix
step and the page read:

```
drift: 3
- stack: SPEC.md says Vite 8.3.2, bun.lock has 8.4.0
- commands: SPEC.md lists `bun run lint:fix`, package.json has no such script
- decisions: 2026-10-20 "Voice runs on ElevenLabs' Realtime API" has no dated line
```

or the one line `drift: none`. Nothing else about the repo.

```
## Fix
tools: git-read, git-commit, read, Edit, Write, Bash(ls:*)
turns: 40
check: @gates
retries: 1
```

Task: when the Check step said `drift: none`, change nothing, commit
nothing, and say so in one sentence. Otherwise edit SPEC.md so each listed
line is true, touching only the lines the report names and the dated
decision lines it asks for (one-liners, "2026-10-20: …, because …"); where
README.md or CLAUDE.md repeat the same fact, fix them too; leave everything
between `spec:begin` and `spec:end` as it is; never change code, the
lockfile, `.canopy/`, DESIGN.md or any styling; commit with a subject like
"docs: converge SPEC.md with the code"; do not push. A repo with no SPEC.md
is "not adopted": say so and commit nothing (the `spec` workflow adopts).

A `drift: none` run commits nothing, so its branch reads `nothing` and the
event `no-fix`: the triggers page's "Nothing to fix" section is the weekly
all-clear. The extra Fix run costs one short turn; once FR-034 ships,
`when:` could gain a `says "drift: none"` condition to skip it (call 7).

The Check step changes nothing by its tools, so the only writer is Fix, and
`@gates` runs the repo's gates on the branch before the landing queue runs
them again. Both are kept: a failed gate sends the flow back once
(`retries: 1`) with the gate's output, where the queue would only send the
branch back to the inbox.

## Where it lands, and the approval

The branch's diff is SPEC.md, perhaps README.md and CLAUDE.md: all `docs`
class. Under canopy's own `review.json` docs land on their own. **But
SPEC.md and CLAUDE.md are on canopy's sensitive list** (`sensitiveWhy`:
agent instruction files), so the sort is `approve` and the branch waits for
"look and land" with the diff open, in the landing section and the inbox;
on the `pr` path, auto-merge leaves it for Eric the same way.

The alternative is a narrow key, say `"autoLandSensitive": ["SPEC.md"]`,
letting a docs-class SPEC.md change land unseen. This spec says **no**, and
recommends keeping the approval:

- SPEC.md is the first file every agent reads. An unattended agent
  rewriting what the next agent takes as truth is the one loop that must
  have a person in it, and the `approve` verdict exists for exactly this
  file class.
- The cost is one click a week per repo with drift, with the diff in front
  of Eric. The drift report is three lines; so is the diff.
- A repo that wants it anyway can already list `SPEC.md` nowhere sensitive
  only by changing canopy's list, which is not per repo on purpose.

So the inbox row for a converge branch shows the drift report (the Check
step's summary, carried as the event's `summary`) above "look and land",
and that is the whole review.

## Reading the report

- `TriggerEvent.summary` holds the Check step's closing text (`fromFlow`
  takes the first step's summary for this workflow; today `fromRun` takes
  a run's). The triggers view shows it folded under the row; the landing
  section's row and the inbox row show its first line ("drift: 3").
- **The repo panel's spec section** gains one line under the sync state:
  "drift checked <relative time>: none" or "drift: 3, fix waiting to land"
  with a link to the event. It reads the newest `spec-converge` event for
  the repo from the store's `triggers`.
- `canopy spec drift [repo]` prints the newest report per repo (every
  repo when none is named) with its date and where the fix stands; `--all`
  includes repos with `drift: none`. It reads `GET /api/triggers`.
- The board's filter menu gains a **spec drift found** chip beside **spec
  drift** (the text-block one), which is `treelines`' `SPEC_WORDS` with one
  more word, `stale`, for a repo whose newest converge event has `drift: n`
  and no landed fix.

## Routes

- `GET /api/triggers` (read): schedule rules carry `cron`, `next` (unix
  ms), `land`, `only`, the last fire and the skips.
- `POST /api/triggers/fire {rule, repo?}` (operate): as above.
- Everything else is the trigger engine as it stands: `resume`, `retry`,
  `stop`, `DELETE /api/triggers/events?id=`.

## Components

- `src/core/trigger.ts`: `schedule` in `TRIGGER_SOURCES`, `cron`, `land`,
  `only`, `repo: "*"` on the rule (`parseRules` validation), `scheduleKey`,
  `dueRules(rules, events, now)` (pure: which rules fire at `now` and the
  repos each takes, with the skip reasons), `newEvent` for a fire.
- `src/core/cron.ts`: unchanged; `nextFire` and `parseCron` as they are.
- `src/server/triggers.ts`: the schedule tick on the lock holder, the
  catch-up fire on start, `fire` with `repo`, `land: queue` passing
  `openPr: false` to `startTriggerRun`, `summary` from a flow's first step.
- `src/server/index.ts`: `startTriggerRun` honours `land`.
- `lib/workflows/spec-converge.md` (new); `BUNDLED_ORDER` in
  `src/core/workflows.ts` gains it after `spec`.
- `src/core/treelines.ts`: the `stale` word; `src/core/scan.ts` or the
  store: the repo's newest converge event joined to its card (client-side,
  `ui/src/triggers.ts`).
- `src/cli/index.ts`: `canopy spec drift [repo] [--all]`.
- `ui/src/triggers.ts`: `scheduleWord`, `nextFireWord`, `driftOf(event)`;
  `components/Triggers.tsx`: the rule card's cron, next fire, skips, a
  "fire now" per repo; the folded report. `ui/src/landing.ts`, `inbox.ts`:
  the report's first line on the row. `components/Dock.tsx`: the spec
  section's line. `ui/src/filters.ts`: the chip.

## Calls

Made on 2026-10-25:

1. **A trigger source, not a ranger cron.** Records, resume and retry,
   unattended tools, no CLI needed. Stated above.
2. **`land: queue` by default for schedules.** A weekly docs fix does not
   need a pull request; the landing section is the review.
3. **Keep SPEC.md's approval.** The file every agent reads is the file a
   person looks at. The inbox row shows the report so the look is short.
4. **Two steps, the first read-only.** The checker cannot edit, by its
   tools. The `drift: none` case costs one short Fix run; FR-034's `when`
   can remove it later.
5. **One event per repo per fire, skipped while the last is live.** No
   pile-up of converge branches on a repo whose fix waits for a look.
6. **The report has a fixed shape.** `drift: n` or `drift: none` first,
   then one line per item with the section's name; the page and the CLI
   parse the first line only.

For Eric:

7. Whether FR-034's `when:` should gain `says "<text>"` (the previous
   step's summary starts with the text) so the Fix step is skipped on
   `drift: none`. The spec is written to work without it.
8. The default cadence for canopy's own repos: the spec suggests `0 5 *
   * 1` (Monday 05:00 on the mini) on `repo: "*"` with `only:
   ["spec-adopted"]`, written into the mini's `triggers.json` by hand.
9. Whether `land: pr` should be the default for a repo whose main is
   protected on GitHub, read from `gh repo view`, or whether `queue`
   everywhere and Eric's own key is simpler. The spec says the key.

## Out of scope

- Checking DESIGN.md against the UI; "in sync means the text matches, not
  that the code follows DESIGN.md" stays true.
- Drift in the other direction: code that contradicts a decision. The
  Check step names the decision; it does not propose reverting code.
- Spec Kit's `/speckit.*` flow (constitution, specify, plan, tasks). The
  seven-section SPEC.md is canopy's shape.
- A schedule rule that runs any workflow needing a person (`gate: ask`, or
  FR-034's `mode: manual`): refused as today.
- Anything on a repo with a host or on the forge.

## Testing

- `trigger.test.ts`: `parseRules` for a schedule rule (cron required, bad
  cron named, `"*"` only on schedule, `only` words, `land` values, bad
  keys), `dueRules` at a fire minute and a minute off, the catch-up rule
  after a gap, the skip for a live event, the per-repo key, `fromFlow`
  taking the first step's summary.
- `workflow.test.ts`: `spec-converge.md` parses, its steps' tools and
  gates as written.
- `server/triggers.test.ts` (stand-in flows and landing): a fire on `"*"`
  making one event per matching repo and queuing past the cap; the tick
  firing only on the lock holder; `land: queue` leaving `openPr` off and
  `fromLanding` moving the event to `merged` on land; `fire {rule, repo}`.
- `review.test.ts`: a SPEC.md-only diff sorts `docs` and `approve`, pinned
  so the approval cannot be lost by accident.
- `cli` test: `canopy spec drift` printing the report's first line per
  repo.
- `ui/src/triggers.test.ts`: `driftOf` on both shapes; `filters.test.ts`:
  the chip.

## Plans

1. **The clock**: `schedule` source, `dueRules`, the tick, catch-up, skips,
   `land`, `fire {rule, repo}`, the rule card. Independent of the workflow.
2. **The workflow and the report**: `spec-converge.md`, `summary` from the
   Check step, the row lines, the spec section's line, `canopy spec drift`,
   the chip. Then Eric writes the rule into the mini's `triggers.json`.
