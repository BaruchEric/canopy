# Work until merged: issue intake from GitHub and Forgejo, and the conflict loop (FR-035)

FR-035 asks for the loop the software-factory survey of 2026-10-25 found in
Optio (github.com/jonwiggins/optio): a ticket becomes a branch, the branch
becomes a PR, and the agent is sent back in whenever CI goes red, the branch
falls behind, or a reviewer asks for a change, until the PR merges or a
person is needed. Symphony (github.com/openai/symphony) adds the restart of
a stalled agent; ccpm the "one issue, one worktree" rule. canopy has most of
the loop: Sentry and Linear start work on a branch, the PR watch fixes red
checks and trusted comments three times and merges under the review rules,
and the inbox and "waiting on you" are the needs-you queue. What is missing
is intake from the places Eric's own issues live, GitHub and Forgejo; the
one state the watch gives up on today, a branch that has fallen behind or
conflicts; a watchdog for a run that has gone quiet; and the write-back
that closes the issue. Ranked fourth in
`2026-10-25-software-factory-borrowings-design.md`.

## Where things stand (2026-10-25)

- **Two sources.** `TRIGGER_SOURCES` in `src/core/trigger.ts` is `sentry`
  and `linear`. A `TriggerRule` names a repo, a workflow, `secretEnv`
  (`CANOPY_TRIGGER_*`, taken out of the server's env at start by
  `takeTriggerSecrets`), filters, and an optional `tokenEnv` that writes
  back. `POST /api/hooks/<source>/<name>` is filed `open` in the callers
  table (`callers.ts` line 51) and `TriggerHub` checks the signature before
  it parses a word. `existing(events, rule, key)` keeps one event per issue
  under a rule; only `failed`, `ignored` or `merged` lets the same issue
  start again.
- **An issue by hand.** A branch run's note opening with `#123` or a GitHub
  issue URL starts from that issue (`parseIssueRef`, `fetchIssue` through
  `gh issue view`, `issueNote` in `src/core/issue.ts`). Nothing watches the
  issue afterwards; nothing comments or closes it.
- **The PR watch loops on checks and comments, not on the base.**
  `PrHub` (`src/server/prs.ts`) polls `gh pr view` and starts
  `startBranchFix` on a failed check or a trusted comment, `MAX_ATTEMPTS`
  (3) per key, then `gaveUp`. `readyToMerge` (`src/core/pr.ts`) refuses a
  head whose `mergeState` is `BLOCKED`, `BEHIND` or `DIRTY` as "branch
  protection blocks it" and stops there: a PR that merely needs a rebase
  waits for Eric forever.
- **Pushes are never forced.** `pushBranch` (`src/core/worktree.ts`) pushes
  `refs/heads/<b>:refs/heads/<b>` with `--porcelain` and no `--force`; the
  landing queue's `rebaseOnto` rewrites a branch only before it has been
  pushed. A rebased branch cannot be pushed today.
- **GitHub only.** `PrWatch.slug` is `owner/name` on GitHub, every read and
  write goes through `gh`, and `src/core/github.ts` reads pulls through
  GraphQL. Forgejo is a *source* (`src/core/forge.ts`: list repos through
  `/api/v1`, `TOKEN_ENV` `CANOPY_FORGEJO_TOKEN` or a token file,
  `linkForgeClones` to match a clone to its forge card); canopy neither
  reads nor writes Forgejo issues or PRs.
- **No watchdog.** `Runner` and `ClaudeDriver` know a run's `steps` and
  their `at`; nothing acts when the newest step is old. The sweep
  (`src/core/sweep.ts`) closes a run idle for days, not one stuck for an
  hour.
- **The states.** `TriggerStatus` is `queued, working, waiting, stopped,
  failed, no-fix, ready, review, merged, closed, ignored`, moved by
  `fromRun`, `fromFlow`, `fromPr` and `fromLanding`.

## Probes before plan 1

- **P1.** `git push --force-with-lease=refs/heads/<b>:<sha> <remote>
  <b>:<b>` against a remote branch that someone else moved: confirm it is
  refused with `stale info`, and that `--porcelain` reports it so `why()`
  reads it. The design assumes this.
- **P2.** `gh pr view --json mergeStateStatus` after the base moves:
  confirm `BEHIND` appears on a repo with "require branches to be up to
  date" on, and `DIRTY` on a conflicting PR, and how long GitHub takes to
  compute them after a push (the first read often says `UNKNOWN`).
- **P3.** GitHub issue webhooks: the `X-Hub-Signature-256` header is
  `sha256=<hex HMAC>` of the raw body, the `issues` event with `action:
  labeled` carries `label.name`, and `X-GitHub-Event` names the event.
- **P4.** Forgejo webhooks: the header is `X-Forgejo-Signature` (Gitea's
  `X-Gitea-Signature` on older servers), hex HMAC-SHA256 of the raw body;
  the `issues` event has `action: label_updated` and the issue's `labels`
  list, not the one label that changed. The design reads the list and uses
  `existing` to keep one event per issue.
- **P5.** `gh issue list --label canopy --state open --json number,title,
  body,labels,updatedAt` and Forgejo's `GET /api/v1/repos/{o}/{r}/issues?
  labels=canopy&state=open` for the polled path; and `gh api graphql` to
  close with a comment versus `gh issue close -c`.
- **P6.** How Claude Code's stream-json looks while a turn is still working
  with no tool call for ten minutes (a long `Bash`): confirm the last event
  was its `tool_use`, so "quiet" must mean no event *and* no running tool,
  or the watchdog would stop a legitimate long test run.

## Intake: two new sources

### The rules

`TRIGGER_SOURCES` grows to `sentry, linear, github, forgejo`. A rule for
either new source:

```json
{
  "name": "canopy-issues",
  "source": "github",
  "repo": "/Users/eric/dev/dev-tools/canopy",
  "workflow": "issue-fix",
  "labels": ["canopy"],
  "secretEnv": "CANOPY_TRIGGER_GH_CANOPY",
  "poll": "*/15 * * * *",
  "tokenEnv": "CANOPY_TRIGGER_GH_WRITE"
}
```

- `labels` is reused from the Linear rule: adding one of them to an open
  issue starts work. Default `canopy`.
- `secretEnv` holds the webhook secret. **It is optional for these two
  sources**, unlike Sentry and Linear: a rule without one has no hook
  (`/api/hooks/github/<name>` answers 404) and polls instead.
- `poll` is a cron line (`parseCron`, `nextFire` from `src/core/cron.ts`,
  at most `CRON_MAX`). With a hook it is the safety net for a delivery that
  never arrived; without one it is the only intake. Default `*/15 * * * *`
  when `secretEnv` is unset, none when it is set. Polling runs on the
  flows-lock holder only, like every other write to `triggers/events.json`.
- `api` defaults to `https://api.github.com` and, for Forgejo, must be set
  (there is no default host). For Forgejo the token for reads and writes is
  `tokenEnv`, falling back to the forge source's own token (`readToken` in
  `forge.ts`) when the repo's remote matches a configured forge source;
  for GitHub, reads go through `gh` as the issue start does today, and
  `tokenEnv` is only for a write-back identity other than gh's login
  (normally unset).
- `projects`, `levels`, `org`, `clientId` are a bad line on these sources,
  as `labels` is on Sentry.

### The hook

- `POST /api/hooks/github/<name>`: read at most 1 MiB, check
  `X-Hub-Signature-256` with `signatureOk` (constant time) before parsing,
  answer 401 on a miss. `X-GitHub-Event` must be `issues`; anything else is
  a quiet 200 (GitHub sends `ping` on install). `parseGithubIssue` takes
  `action: labeled` where `label.name` is one of the rule's labels and the
  issue is open and not a pull request (`pull_request` key absent), else
  null. `key` is the issue number, `short` is `#123`, `link` the HTML URL.
- `POST /api/hooks/forgejo/<name>`: the same with `X-Forgejo-Signature`
  (or `X-Gitea-Signature`), `X-Forgejo-Event: issues`, `action` in
  `label_updated`, `opened` (with a label already on), and the rule's label
  in `issue.labels[].name`. One event per issue, so a second
  `label_updated` on the same open issue finds the event through
  `existing` and bumps `count`, as a repeated Sentry alert does.
- Both are filed `open` already (`hooks/*`), and the edge gate must let
  `/api/hooks/*` through, as docs/deploy.md says for Sentry.

### Polling

`TriggerHub.poll(rule)` on the rule's cron: list open issues with the label
(P5), and for each one with no live event (`existing` finds none that is
not `failed | ignored | merged | closed`), make an `Incoming` as the hook
would and run it through the same `take`. A poll is skipped while the
previous one has not returned, and a listing that fails is one health line
(`canopy:triggers`), never an event. The poll reads at most `POLL_ISSUES`
(50) issues; a repo with more labelled issues waits for the next tick,
oldest first.

### The note and the workflow

`noteFor` leads with "GitHub issue #123 came in." or "Forgejo issue #123
came in.", so the branch reads `run/github-issue-123-…`; the title, body
(cut to `MAX_DESCRIPTION`), labels and the newest `ISSUE_COMMENTS` (10)
comments ride in the fence as data, as `issueNote` does for a hand-started
run. A new bundled `lib/workflows/issue-fix.md` (`listed: false`) has
`linear-issue`'s shape: check first that the issue is clear and small enough
for one run and commit nothing when it is not; otherwise the smallest fix
with a test, the gates, a commit, never a push. The rule may name another
bundled or user workflow; a repo-local one is refused as today.

### Where it lands

- A **GitHub** rule's run opens a PR (`openPr`), and the PR watch takes it
  from there: this is the Sentry and Linear path.
- A **Forgejo** rule's run lands through the **landing queue**, not a PR.
  canopy has no Forgejo PR watch (below, out of scope), the landing queue
  is canopy's own merge, and a Forgejo repo of Eric's is one whose main he
  owns. The event's `ready` state waits on the queue as a landing record
  does today; `fromLanding` moves it to `merged` when the record lands
  (the word stays `merged` so the page's sections hold). The run's branch
  is sorted under the repo's `.canopy/review.json` as any branch run is, so
  an `approve` verdict puts the event in Needs you.

## The conflict loop

### Behind or dirty

When a poll reads `mergeState` `BEHIND` or `DIRTY` on a PR canopy opened,
and no fix is going, and the head is the one canopy pushed:

1. The watch sets `rebasing` (a new `PrWatch.rebasing: { from: sha }`),
   runs `rebaseOnto(w.dir, <remote>/<target>)` after a `git fetch <remote>
   <target>` in the worktree. (A fix run must not be working in the
   worktree meanwhile; `fixing` already excludes it.)
2. On `ok`, canopy pushes with **`--force-with-lease=refs/heads/<branch>:
   <w.pushed>`**: the push goes only if the remote branch is still at the
   sha canopy itself pushed last. A lease that fails (someone pushed to the
   run branch by hand) sets `error` "the branch moved on GitHub since
   canopy pushed; rebase it yourself" and the event reads Needs you. On
   success `pushed` is the new head and the poll goes to its fresh pace.
3. On `conflict: files`, canopy starts a fix run through `startBranchFix`
   with a new `fixPromptForConflict(w, target, files)`: the conflicting
   files fenced between `<<<` and `>>>`, the instruction to rebase onto
   `<remote>/<target>` in this worktree, resolve each listed file keeping
   both the branch's intent and main's change, run the gates, and leave
   the branch rebased with no push. When the fix run ends `runOk`, canopy
   pushes with the lease as in step 2. Three tries per base sha
   (`attempts["rebase:<base sha>"]`), then `gaveUp` "could not rebase onto
   <target> after 3 tries".
4. On `error`, the same as a failed lease: Needs you with the reason.

`readyToMerge` keeps refusing `BEHIND` and `DIRTY`; the loop runs *before*
it, so a merge still happens only on a head GitHub calls `MERGEABLE`.

### Why a forced push here, when the spec says never

The landing queue never pushes and the PR watch never forces, and that
stays the rule for every branch a person might have touched. The exception
is narrow and stated:

- only a `run/*` branch canopy itself cut and pushed;
- only with a lease on the exact sha canopy last pushed, so any human push
  to that branch makes the lease fail and stops canopy;
- only after a rebase canopy ran (or a fix run canopy started) in the
  branch's own worktree;
- never on `target`, never on a branch with another name, and never with
  bare `--force`.

Without it a rebased branch is unpushable and every fallen-behind PR is
Eric's to fix by hand, which is the loop's whole point.

### Review comments after a rebase

A trusted comment that arrives while `rebasing` waits; the comment loop
runs once the rebase has pushed, on the new head. `seenComment` is
unchanged.

## The stall watchdog

- A run is **quiet** when its newest `RunStep.at` is older than
  `STALL_AFTER` (20 min) and no tool call is open (P6: the driver knows an
  open `tool_use` with no result). `Runner` checks every `STALL_EVERY`
  (60 s) over working runs that are not chats and not stage runs.
- First quiet: canopy says into the run (`Runner.say`, which a chat takes
  today and a job gains for this one message) "You have been quiet for 20
  minutes. Finish what you are on, commit what is sound, and end the turn."
  The run's `steps` get a `note` "told to wrap up". The step's `at` moves,
  so the clock restarts.
- Quiet again after that: the run is stopped (`stopped`, reason "stalled")
  and, for a branch run with a session, resumed **once** through
  `startBranchFix` with `PICKED_UP_NOTE`'s shape: the reason, "carry on
  from where the last session left off". `PrWatch`/`LandingRun` gain
  `stalls: number`; a second stall marks the event `stalled` for Eric and
  the run is not resumed.
- Interactive shells and the ranger are never watched. A `propose` run
  waiting on its plan is `waiting`, not quiet.

## Needs you, and the digest

The inbox and "waiting on you" stay the queue; this spec adds the reasons
and one line a day.

- `TriggerEvent.needsYou?: string` is set by `fromPr`/`fromLanding`/
  `fromRun` when: the sort says `approve`; an untrusted comment arrived and
  nothing else is going; auto-fix `gaveUp`; a rebase lease failed or gave
  up; a second stall; the run asked a question (`waiting` already shows
  it). The triggers view's "Needs you" section reads it, and
  `mergeInbox` gains a `trigger` item kind for events with `needsYou` and
  no open ask (today such an event shows only on the triggers page).
- **Digest.** Once a day at the sweep's hour (`DEFAULT_SWEEP.cron`), the
  hub writes one `LandNotice`-style line into the inbox's foot: "3 issues
  need you: #123 approval, #130 rebase, ENG-4 question; 2 merged
  yesterday". The ranger, when on, gets it as a DM through `ChanHub.dm`
  like a wake. No email, no Telegram of its own.

## States

`TriggerStatus` gains `rebasing` ("rebasing onto main"), `conflict` ("a
rebase conflict is being fixed"; the fix run is `runId`) and `stalled`.
`eventLive` counts the first two. The page's sections: Needs you (anything
with `needsYou`), Working (`queued, working, waiting, rebasing, conflict`),
In review, Fixed, Nothing to fix, Ignored, as today, with `stalled` under
Needs you.

## Write-back

- **GitHub.** When the PR opens, `gh issue comment <n> -b "Opened #<pr>
  from <branch>."` once (`linked`, as Linear's). On merge, `gh issue close
  <n> -c "Fixed by #<pr>."` (`resolved`). Both only when the rule's
  `write` is not `false` (new key, default true). On `no-fix` or `failed`,
  the same comment Linear's `issueNoteFor` builds, through `gh issue
  comment`. gh's login does these, as the PR watch's reads do.
- **Forgejo.** `POST /api/v1/repos/{o}/{r}/issues/{n}/comments` and `PATCH
  /api/v1/repos/{o}/{r}/issues/{n}` with `{state: "closed"}`, Bearer
  `tokenEnv` or the forge source's token, in a new `src/server/forgejo.ts`
  with the shape of `linear.ts` (`writer`, `mark`, a 2xx check, errors kept
  on the event, never thrown into the hub's loop). The landing record's
  `landed` is the merge.
- A token that cannot write leaves `resolved: { error }` on the event, as
  Sentry's resolve does; nothing retries forever.

## Routes and CLI

- `GET /api/triggers` (read) carries the new rules with `poll`'s next fire
  and the hook path or "polls every 15 min".
- `POST /api/triggers/poll {rule}` (operate) runs one poll now; the "try
  it" box gets a "poll now" beside "fire".
- `POST /api/prs/rebase {run}` (operate) runs the rebase step by hand on a
  PR that is behind, for a watch with `autoFix` off.
- `canopy issues [repo] [--needs-you]` (`src/cli/issues.ts`) prints the
  github and forgejo events as `canopy queue` prints the queue: issue,
  state, branch, PR, what it needs. `canopy pr rebase <run>` calls the
  route above.

## Components

- `src/core/trigger.ts`: the two sources, `parseGithubIssue`,
  `parseForgejoIssue`, `poll` on the rule, `needsYou`, the three states,
  `fixPromptForConflict` lives in `pr.ts` beside its siblings.
- `src/core/forgejoissues.ts` (new, pure): the API paths, `parseIssueList`,
  `parseIssueView`, the comment and close bodies.
- `src/core/pr.ts`: `fixPromptForConflict`, `rebaseKey`, `readyToRebase`
  (mergeState behind or dirty, head is `pushed`, no fix, no rebase going).
- `src/core/worktree.ts`: `pushBranchLease(dir, remote, branch, expect)`;
  `pushBranch` is unchanged.
- `src/core/runner.ts`: `quiet(run, now)`, the watchdog tick, `say` for a
  job's one message.
- `src/server/prs.ts`: the rebase step in `tick`, `rebasing` on the watch,
  the lease push after a conflict fix.
- `src/server/triggers.ts`: the two hooks, the poller on the lock holder,
  the digest, the Forgejo landing path (`openPr` off, `fromLanding` to
  `merged`).
- `src/server/forgejo.ts` (new): the writer.
- `src/server/index.ts`: `startTriggerRun` choosing queue or PR by source.
- `lib/workflows/issue-fix.md` (new, `listed: false`).
- `src/cli/issues.ts` (new), `src/cli/pr.ts` (`rebase`).
- `ui/src/triggers.ts`, `components/Triggers.tsx`: the sections, the poll
  button, the hook-or-poll line; `ui/src/inbox.ts`: the `trigger` item.

## Calls

Made on 2026-10-25:

1. **Forgejo issues land through the queue, not a PR.** No Forgejo PR watch
   in this spec. The landing queue is canopy's merge and the repos are
   Eric's own.
2. **Force only with a lease, only on `run/*`, only to canopy's own sha.**
   Stated above. `pushBranch` stays force-free for every other caller.
3. **Polling is first-class, not a fallback.** The Mac has no public hook
   address; a 15-minute poll is what makes GitHub intake work there at all.
4. **One bundled `issue-fix` workflow for both sources.** It is
   `linear-issue` with the fence's first line changed.
5. **The watchdog speaks before it stops.** One warning turn, then one
   resume, then Eric. Symphony restarts blindly; a resume with the reason
   is cheaper than a lost context.
6. **No new inbox surface.** `needsYou` feeds the inbox that exists.

For Eric:

7. The forced push with a lease is a change to the rule "never force" in
   `2026-10-16-pr-watch-design.md`. Say yes or the loop stops at BEHIND.
8. `STALL_AFTER` at 20 minutes: a long `bun test` on the mini can take ten.
   P6 decides whether an open tool call is enough to tell them apart.
9. Whether `write-back` to GitHub should use gh's login (Eric's) or a
   separate token so the comments read as canopy's. The spec uses gh.

## Out of scope

- A Forgejo PR watch (reads, checks, auto-merge against Forgejo PRs).
- GitLab, Jira, Notion intake.
- Issue triage (labelling, dedup, prioritising) without a human label.
  Astro's and Vercel's factories do this; canopy starts only on a label.
- Opening a PR on Forgejo.
- Reopening an issue when a merged fix is reverted.

## Testing

- `trigger.test.ts`: `parseGithubIssue` (labeled with the rule's label,
  another label, a closed issue, a pull request), `parseForgejoIssue`
  (`label_updated` with and without the label, `opened` with it),
  `existing` across the new states, `needsYou` for each reason, the three
  states in `fromPr`, a rule with `poll` and no `secretEnv`, bad lines
  (`projects` on github).
- `forgejoissues.test.ts`: list parsing, comment and close bodies.
- `pr.test.ts`: `readyToRebase`, `fixPromptForConflict` fences the files,
  `rebaseKey` attempts to 3 then gave up.
- `worktree.test.ts` (scratch repo with a bare remote): lease push
  succeeds at the expected sha; refused after the remote moved; the branch
  is rebased and pushed; `pushBranch` still refuses without a lease.
- `runner.test.ts` (fake driver): quiet after `STALL_AFTER` with no open
  tool; not quiet with a tool open; the wrap-up note; stop and one resume;
  the second stall marked.
- `server/prs.test.ts` (stand-in gh): BEHIND → rebase → lease push → fresh
  pace; DIRTY → conflict → fix run → push; lease failure → needs you;
  comment held during a rebase.
- `server/triggers.test.ts`: a github hook with a bad signature 401, a
  `ping` 200, a labelled issue starting a run, the poller on the lock
  holder only and skipped while running, a Forgejo event moving to
  `merged` on a landing record, the digest line once a day.
- `cli/issues.test.ts`: the listing's columns.
- `ui/src/triggers.test.ts`, `inbox.test.ts`: the sections and the
  `trigger` item.

## Plans

1. **Intake**: the two sources, hooks and polling, `issue-fix`, the Forgejo
   landing path, write-back, `canopy issues`. Nothing changes in the PR
   watch.
2. **The loop**: `readyToRebase`, the lease push, `fixPromptForConflict`,
   the states, `needsYou` and the inbox item, `canopy pr rebase`. Waits on
   call 7.
3. **Watchdog and digest**: the quiet check, wrap-up and resume, the daily
   line and the ranger DM.
