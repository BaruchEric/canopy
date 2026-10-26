# Holdout scenario gates (FR-032)

FR-032 asks the landing queue to hold every branch to a set of scenarios the
agent never saw: end-to-end stories kept outside its worktree, run after the
repo's own gates, with a satisfaction figure per branch. The idea is
StrongDM's software factory (scenarios as holdout sets, a probabilistic
satisfaction score; https://rywalker.com/research/strongdm-factory) and the
sealed-envelope tests of DUBSOpenHub's dark-factory
(https://github.com/wippa-studios/awesome-software-factories). It matters
because gates.json is the one check between an agent and main, and an agent
that can read the tests can write to them: "return true" passes `bun test`.
A test the agent cannot see is the cheapest defence against that, and the
queue is the one place every branch already passes through. Ranked first in
`2026-10-25-software-factory-borrowings-design.md`.

## Where things stand (2026-10-25)

- `core/gates.ts` reads `.canopy/gates.json` from the main checkout
  (`readGates`; `Gates` is `{gates: [{name, run}], setup?, source}`), else the
  `package.json` scripts in `PACKAGE_GATES`. The queue's `turn` in
  `server/landing.ts` runs each gate through `deps.check` (`runGate` in
  `core/check.ts`: `ledLine`, `gateEnv`, `CHECK_TIMEOUT`, output capped at
  `CHECK_OUTPUT_CAP`) and sends a red one back with `{t: "red", gate, output}`.
  Every gate runs in the run's worktree, which holds only the branch.
- `LandState` has `gate` for the gate running; `LandEntry.gate` names it and
  `reason` carries the output tail (`TAIL_CHARS`, 4000). `landWord` says
  "gate: test".
- The review verdict (`core/review.ts`) is `auto` only when the repo has
  gates (`hasGates`); a repo with none never lands on its own.
- The judge exists: `core/jev.ts` (`jevJudge`, `hasGatewayKey`,
  `AI_GATEWAY_API_KEY`), `core/verdict.ts` (`JUDGE_QUESTIONS`,
  `JUDGE_THRESHOLDS`, `judgeState`, `decideJudge`) and `core/evidence.ts`
  (`readEvidence` reads files out of a repo). A flow's `gate: judge` step
  parks as `ask` when there is no key (`flow.ts`, `hooks.judge` null).
- The PR watch sorts a head before auto-merge (`PrHub.screen`, `sortRun`)
  and holds it for Eric on `approve`; nothing runs in the worktree there.
- Nothing in canopy is hidden from a run. The agent's worktree holds the
  branch, and `.canopy/**` is sensitive under the review rules, so a run
  cannot edit the gates it is held to; but it can read every test it must
  pass, and so can rewrite them.

## Scenarios

### Where they live

Scenarios live outside every checkout, under
`<configDir>/scenarios/<repo key>/`, one file each, written by Eric and by
`canopy scenarios add`. `repoKey` is the one the worktrees use. Nothing in a
worktree, a branch or the main checkout names them, so a run that works
"only inside this repository" never meets them, and `git grep` finds
nothing.

This is a boundary of attention, not a sandbox. The agent runs as Eric's
user on the backend, and a yolo run could read the config dir. The review
rules make the same bargain for `.canopy/review.json`, and the tool lists of
unattended workflows (`sentry-fix`, `linear-issue`) keep reads inside the
repo. A run that reads `~/.config/canopy/scenarios/` has gone outside the
project, which `explainCommand` flags and the inbox shows.

The repo's main checkout carries `.canopy/scenarios.json`, read at `HEAD`
like gates and review rules, so a branch cannot loosen it:

```json
{
  "run": "bun test \"$SCENARIO_DIR\"",
  "judge": "jev",
  "minimum": 1,
  "timeout": 600
}
```

- `run` is the default line for a command scenario that names none of its
  own. `judge` is `jev` or `off`; `off` parks every judge scenario as
  `ask`. `minimum` is the satisfaction a branch needs to land, 0 to 1,
  default 1. `timeout` in seconds, default 600, at most 1800.
- Without the file, the scenarios still run: the default line is
  `bun test "$SCENARIO_DIR"`, judge on, minimum 1. The file exists to be
  reviewed; a change to it is sensitive like every `.canopy/**` edit.

### The file

Markdown with frontmatter, like a workflow file:

```
---
name: checkout-flow
kind: command
run: bun test "$SCENARIO_DIR/checkout.test.ts"
---
```

```
---
name: refund-explains-itself
kind: judge
run: bun run start:test & sleep 2; curl -s localhost:3000/refund/42; kill %1
evidence: src/refund.ts
---
A customer asks for a refund on an order shipped a week ago. The reply
names the order, says whether the refund is granted, and says why in one
sentence a customer would understand.
```

- `name` matches `GATE_NAME` (`gates.ts`). `kind` is `command` or `judge`.
  A command scenario passes on exit 0. A judge scenario's `run` is optional;
  its output, its `evidence` files read from the worktree (`readEvidence`,
  paths inside the repo only, the `evidenceKey` check from `workflow.ts`)
  and its body are what the judge reads.
- Files beside the markdown (`checkout.test.ts`, fixtures) belong to the
  scenario set. The whole folder is copied to a fresh temp dir before each
  run and `SCENARIO_DIR` points there, so a scenario's own line cannot
  change the set. The copy is removed after. The name has no `CANOPY_`
  prefix, so `gateEnv` keeps it.
- `core/scenario.ts` (new, pure, browser-safe) parses a file into a
  `Scenario` and the folder's list into a `ScenarioSet`; a bad file is named
  and the rest still run, as a bad trigger rule is.

### The judge's questions

`SCENARIO_QUESTIONS` in `core/verdict.ts`, beside `JUDGE_QUESTIONS`:

- `satisfied` (choice): does what was observed satisfy the story as a user
  would read it? `yes`, `partly`, `no`.
- `evidence` (boolean): is the output and the files enough to say?

`SCENARIO_THRESHOLDS`: `yes` at 0.7, evidence at 0.35 (Jev's evidence
answers run low; see `JUDGE_THRESHOLDS`). `scenarioState(story, output,
files)` builds the text the way `judgeState` does, with the story first and
the output fenced between `<<<` and `>>>` as data. The scenario's own text
never reaches the run; only the judge reads it.

A judge scenario's satisfaction is `P(yes)`; a command scenario's is 1 or
0. The branch's score is the mean. It lands when the score is at least
`minimum` and no command scenario is red.

## In the landing queue

### The turn

`turn` runs the scenarios after the last gate and before the moved check:

1. `e = step(e, {t: "scenarios", first})` moves the entry to a new state
   `scenarios`; `landWord` says "scenario: checkout-flow". `LandState`
   gains `scenarios`; `WORKING` includes it.
2. Each scenario runs in order through `deps.scenario(dir, scenario,
   setDir)`, a command through `runGate`'s path with `SCENARIO_DIR` added
   to its env, a judge one through `jevJudge` after its `run` (if any) and
   its evidence are read. One at a time, under the file's `timeout`.
3. A red command scenario sends the entry back: `{t: "red", gate:
   "scenario: <name>", output}` with the observed output tail, never the
   file's body. `fixPrompt` says "scenario <name> failed; its output is
   below" and nothing about what the scenario tests. The agent gets the
   failing observation, as a user's bug report would read.
4. A judge scenario below threshold is recorded and the run goes on; the
   score decides at the end. Below `minimum`, the entry is sent back as
   `red` with `gate: "satisfaction 0.62 < 1"` and the names of the
   scenarios that said `partly` or `no`, with their outputs.
5. A judge that cannot answer (no key, `judge: off`, three failed attempts)
   holds the entry as `waiting` with "scenario <name> needs a judge", the
   way a judge gate parks a flow. Command scenarios still ran and still
   count. Eric lands it by hand from the sheet ("land anyway"), which is
   a `land` with `skipJudge: true` and is written on the entry.
6. The result is written on the record: `LandingRun.scenarios`:

```ts
interface ScenarioRun {
  /** the branch head they ran against */
  head: string;
  at: number;
  total: number;
  passed: number;
  /** the mean satisfaction, 0 to 1 */
  score: number;
  results: { name: string; kind: "command" | "judge"; ok: boolean; p?: number; tail?: string }[];
}
```

The record is saved under `<configDir>/landing/runs/<id>.json` with the
rest, by the holder of the flows lock. A rebase moves the head, so the
scenarios run again in the next turn; nothing is cached across heads.

### Sorting and auto-land

- `sortBranch`'s `hasGates` becomes "the repo has gates or scenarios", so a
  repo whose only check is a scenario set may still sort `auto`. An `auto`
  entry passes through the same turn, so it lands only with the scenarios
  green and the score at `minimum`. Nothing changes in `review.ts` beyond
  that flag.
- A repo with scenarios and no `.canopy/scenarios.json` gets the defaults.
  A broken file holds the queue like a broken gates file does.
- "Land all" and `canopy land --all` skip nothing new: a scenario failure
  is a sent-back entry like a red gate.

### The PR watch

Before `merge`, after `screen` says the head may go, `PrHub` runs the
scenarios in the PR's worktree at the head it read (the watch keeps the
worktree while it holds the branch). A red one, or a score under `minimum`,
sets `approve` with "scenario <name> failed" and the output tail, and
leaves the merge to Eric, as a sensitive file would. The run is cached by
head on the watch (`PrWatch.scenarios`), since the watch reads every 30 s
and a head changes only on a push. Auto-fix does not fire on a scenario:
the agent cannot see what it is fixing against, and a fix loop with a
hidden target spends turns for nothing. Eric reads the output and starts
"fix it" if he wants.

## The view

- The run sheet's branch line gets the score after the gates: "gates ✓ ·
  scenarios 7/8 · 0.91", rust when sent back on one. Each result folds
  open to its name, kind, satisfaction and the output tail. The scenario's
  body is never served to the page from a run's sheet.
- The landing section's row says "scenario: <name>" while running and the
  score once done. A sent-back row's reason reads as a red gate's does.
- `ApproveSheet` lists a red scenario's name and output beside the
  sensitive files, since both hold a landing for Eric.
- The repo panel's landing section head shows a `scenarios n` chip when the
  repo has a set, which opens the scenarios list.

## Routes and CLI

- `GET /api/scenarios?repo=` (`admin`): the set's names, kinds and each
  file's text. `admin` because the text is the holdout; a page signed in
  as a page has it, a shell token (`read`, `operate`) does not, so an
  agent in a canopy shell cannot read the set through the API either.
- `GET /api/scenarios/names?repo=` (`read`): names and kinds only, for the
  chip and the CLI list.
- `POST /api/scenarios {repo, name, kind, run?, body}` (`admin`) writes a
  file; `DELETE /api/scenarios?repo=&name=` (`admin`) removes one.
- `POST /api/scenarios/run {repo, run?}` (`operate`): run the set against a
  branch run's worktree (`run`), else against the main checkout, and answer
  a `ScenarioRun`. Against the main checkout it is a check of the set
  itself: a scenario that fails on main is wrong, not the branch.
- CLI (`src/cli/scenarios.ts`): `canopy scenarios <repo>` lists names and
  kinds; `canopy scenarios <repo> add <name> [--judge] [--run CMD]` writes a
  template and prints its path; `canopy scenarios <repo> run [<run>]`; a
  `--backend URL` as every command. The CLI's token is `admin`, so `add`
  and a plain `cat` of the file work from Eric's shell.
- The `landing` SSE event carries the record, so the page needs no new
  event. A `scenarios` event `{repo, names}` tells the chip when the set
  changes.

## Components

- `src/core/scenario.ts` (new): `Scenario`, `ScenarioSet`, `parseScenario`,
  `readScenarioSet(configDir, repoKey)`, `parseScenariosFile`
  (`.canopy/scenarios.json`), `scoreOf`, `scenarioWord`.
- `src/core/verdict.ts`: `SCENARIO_QUESTIONS`, `SCENARIO_THRESHOLDS`,
  `scenarioState`, `decideScenario`. `src/core/jev.ts`: `jevScenario`.
- `src/core/landing.ts`: the `scenarios` state, `LandEvent` `scenarios`,
  `scenario-ok`, `landWord`, `fixPrompt` for a scenario red.
- `src/core/check.ts`: `runScenario(dir, line, setDir)`, `runGate` with an
  extra env name.
- `src/server/landing.ts`: the turn's scenario pass, `deps.scenario`,
  `skipJudge`, the record's `scenarios`.
- `src/server/prs.ts`: the pre-merge scenario pass, `PrWatch.scenarios`.
- `src/server/scenarios.ts` (new): the routes, the folder, the temp copy.
- `src/cli/scenarios.ts` (new) and `cli/index.ts`'s case.
- `src/core/review.ts`: `hasGates` takes scenarios into account.
- UI: `ui/src/landing.ts` (`scenarioLine`), `components/Landing.tsx`,
  `components/RunSheet.tsx` (the branch line's score and results),
  `ApproveSheet`, the chip, a `Scenarios` list in the repo panel.
- `docs/architecture.md`: a "Scenarios" paragraph under "The landing queue".

## Calls

Made on 2026-10-25:

1. **Outside the repo, in the config dir.** Not an encrypted file in the
   repo: a sealed file travels with the repo but a run can still see that
   it exists and where the key would be, and the secret store's key lives
   on the same machine. Outside, there is nothing to find. The price is
   that a set does not travel between the Mac and the mini; see For Eric.
2. **Scenarios run after the gates, not with them.** A red gate is cheap
   and tells the agent what to fix; a scenario is slower and tells it only
   what was observed. Running gates first keeps the queue's turn short on
   the common failure.
3. **The agent gets the observation, never the story.** "fix it" carries
   the scenario's name and output tail. The story stays with Eric and the
   judge. A fix that cannot see the target may miss; that is the point.
4. **No auto-fix on a scenario in the PR watch.** For the same reason.
5. **A judge that cannot answer holds, it does not fail.** No gateway key
   is a configuration gap, not a bad branch. "land anyway" is Eric's word.
6. **Scenarios count as gates for `auto`.** A repo whose protection is a
   scenario set should not need a `bun run typecheck` to land docs on its
   own.

For Eric:

7. Whether a set should travel between backends. The options are a
   `canopy scenarios export | import` pair over a tarball, or an orphan
   branch `canopy/scenarios` in the repo that no worktree ever checks out
   and the gate reads with `git show`. The branch fits the peers decision
   (2026-09-24: work moves through git) but puts the text inside the repo
   an agent can `git show`.
8. Whether `minimum` below 1 is wanted at all. StrongDM scores
   probabilistically because its scenarios run thousands of times an hour.
   Canopy runs a handful once per head, so 1 may be the only honest value.
9. The judge is Jev through the Vercel AI Gateway, like the flows' judge.
   A scenario judge on Claude through Eric's own `claude -p` would keep it
   under the subscription, at the cost of a long call per scenario and the
   2026-08-24 decision's spirit (the judge is not a run). Not proposed here.

## Out of scope

- A digital twin of third-party services (StrongDM's DTU). A scenario that
  needs Stripe talks to a sandbox the repo's own `setup` provides.
- Scenarios for checkout runs, workflows or fleets: only branch runs pass
  through the queue, and only they are held.
- Generating scenarios with an agent. Eric writes them; an agent that
  wrote the holdout would hold the key.
- Running scenarios on a schedule against main (a health check or FR-041's
  schedule trigger could do it later).

## Testing

- `scenario.test.ts`: parse both kinds, a missing name, a `run` with a
  `CANOPY_` word (refused), `evidence` outside the repo (refused), a bad
  file named and the rest kept, `scoreOf` over mixed results, the
  `.canopy/scenarios.json` defaults and limits.
- `verdict.test.ts`: `scenarioState` fences the output, `decideScenario`
  at the thresholds.
- `landing.test.ts`: the `scenarios` state in `advance`, a red command
  scenario sent back with the name and tail and no body, a score under
  `minimum`, a judge that cannot answer holding as `waiting`, `skipJudge`
  landing it, the record's `scenarios` written and read back.
- `server/landing.test.ts` over a stand-in `deps.scenario`: the turn's
  order (gates, then scenarios, then the moved check), the temp copy made
  and removed, `SCENARIO_DIR` in the env and no `CANOPY_` name, a rebase
  running them again.
- `server/prs.test.ts`: the pre-merge pass holding on a red, cached by
  head, no auto-fix fired.
- `review.test.ts`: `auto` with scenarios and no gates.
- `cli/scenarios.test.ts`: the list, `add`'s template, `run` against a run
  and against main.
- UI: `landing.test.ts`'s `scenarioLine` words.

## Plans

1. `core/scenario.ts`, the queue's scenario pass with command scenarios
   only, the record, the sheet's line, `canopy scenarios`. Lands on its own.
2. Judge scenarios: the questions, `jevScenario`, the hold, "land anyway",
   the score and `minimum`.
3. The PR watch's pre-merge pass and the repo panel's list.
