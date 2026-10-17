# A run keeps watching the PR it opened (FR-011)

FR-011 asks for a run that opens a PR to show the PR in its footer (number,
diff size, a CI chip whose popover lists the checks) and to offer two
toggles: "auto-fix CI and address comments" and "auto-merge when ready".
Canopy opens no PRs today, so this spec adds the PR first and the watching
after it.

## Where things stand (2026-10-16)

- **Nothing opens a PR or reads CI.** No code calls `gh pr` or reads check
  state. `core/github.ts` counts open PRs per repo (`PULLS_QUERY`, run by
  `refreshPulls` every 5 minutes on `remoteTimer`), and the launcher lists
  open PRs to check one out (`launcher.ts`). Both only read.
- **Branch runs never push.** `startBranchRun` (`server/index.ts`) makes a
  worktree and a `run/<slug>-<id>` branch. The prompt says "do not push",
  and the landing queue rebases, gates and fast-forwards main locally
  (`server/landing.ts`: "The queue never pushes"). Peer sync skips `run/*`.
- **canopy uses the `gh` CLI's own login.** The secret store holds
  `gh_token` for `.env` files and the GitHub MCP server, but canopy never
  sends it anywhere itself. On the mini, `gh` runs inside the canopy
  container, so its login has to be there.
- **A run can already be resumed with a reason.** "fix it" starts a
  follow-up run on the same worktree with `--resume` and `fixPrompt`, and a
  fix that settles ready rejoins the queue. Auto-fix reuses this.
- **The run sheet's footer** is `<footer className="sheet-foot">` in
  `Console` (`ui/src/components/RunSheet.tsx`), and `BranchBlock` holds the
  branch line with land and fix it.

## A branch run can open a PR instead of landing

A ready branch run (one that settled with commits and a clean worktree)
gets a third button beside "land" and "fix it": **open PR**. It:

1. Pushes `run/<slug>-<id>` to the repo's push remote (the upstream's
   remote, else `origin`), never with force.
2. Runs `gh pr create --head <branch> --base <target> --title <first commit
   subject> --body <run note + commit list>`, with `--draft` when the sheet
   says so.
3. Records `RunBranch.pr = {number, url, remote, head}` and takes the run
   out of the landing queue's ready list. A run is landed locally or opened
   as a PR, never both.

`canopy pr <run> [--draft]` does the same from the shell. The pre-flight
gets a choice next to "on a branch of its own": land here (today's default)
or open a PR when done. With "open a PR", a run that settles ready pushes
and opens its PR on its own, the way `auto` joins the queue.

A repo with no GitHub remote, or a machine where `gh auth status` fails,
shows open PR disabled with the reason.

## The watch

Canopy keeps a `PrWatch` per opened PR in `<configDir>/prs/<run id>.json`
and polls it with `gh pr view <n> --json
number,url,state,isDraft,additions,deletions,changedFiles,headRefOid,mergeable,mergeStateStatus,reviewDecision,statusCheckRollup,latestReviews`
plus review comments through `gh api repos/<slug>/pulls/<n>/comments`.

- **Cadence.** Every 30 s while a check is pending or a fix run is going,
  every 5 minutes otherwise, and not at all once the PR is merged or closed.
  All watches share one loop with no overlap and report to a health check
  `canopy:prs`.
- **State.** `PrState`: `checks` (each `{name, state: pending|pass|fail|skip,
  url}`), `review` (`approved | changes | none`), `mergeable`, `diff`
  (`+a -d, n files`), `head` (the commit the checks ran on), and the last
  comment id canopy has seen.
- **Event.** A `pr` SSE event carries the watch; `GET /api/prs` lists them.

## The footer

The footer shows `#123 · +40 −12 · 3 files` and a CI chip:
`checks: 2 running`, `checks passed`, `checks: 1 failed`. The chip's
popover lists each check with its state and a link. Two toggles sit under
it, both off until Eric turns them on for that run:

- **auto-fix CI and address comments**
- **auto-merge when ready**

The card's run chip shows the CI state too, and a failed check with
auto-fix off makes an inbox row ("PR #123: test failed"), like a
`sent-back` row.

## Auto-fix

With auto-fix on:

- **A failed check** starts a follow-up run on the PR's worktree, resuming
  the run's last session, with the check's name and the tail of
  `gh run view <id> --log-failed` (4000 characters). The prompt says to fix
  it, commit, and push to the same branch without force.
- **A new review comment** from someone with write access to the repo
  starts the same kind of run with the comment, its file and line. Comments
  from anyone else are listed in the footer and never reach a run, since a
  stranger's comment would otherwise be a way to drive the agent.
- One fix run at a time per PR. A fix that ends without pushing counts as
  a failed attempt. After **3** attempts on the same check or comment,
  auto-fix stops for that PR and leaves an inbox row.
- The fix run is a normal run: it shows on the agents board, takes the
  routing the `job` role resolves to, and asks for permission like any
  other run.

## Auto-merge

With auto-merge on, canopy merges when all of these hold on the same head
commit: every required check passed (no pending, no failed), the review
decision is not `changes`, `mergeable` is `MERGEABLE`, the PR is not a
draft, and no fix run is going. It runs `gh pr merge <n> --match-head-commit
<head> --<method>` from the main checkout, then deletes the remote branch
itself (`gh pr merge --delete-branch` would also try to switch the run's
worktree off its branch, and main is checked out elsewhere), with the method from the repo's
settings (squash when the repo allows only that, else merge). After the
merge, canopy removes the worktree and the local branch, and the main
checkout fetches.

A merge to a branch that deploys is a deploy. That is why auto-merge is off
for every run until Eric turns it on, unless the repo says otherwise:
`.canopy/prs.json` with `{"autoMerge": true}` makes the toggle start on for
that repo's PRs (canopy's own main does not deploy, so it can). Canopy
reads the file from the main checkout's HEAD when the PR opens, never from
the run's worktree, so a run cannot turn auto-merge on for itself by
editing it. The file sits in canopy's own `.canopy/review.json` approve
list for the same reason. There is no global setting.

## Components

- `src/core/pr.ts` (new, pure): `PrState`, parsing `gh pr view` JSON and
  the comments list, `checksWord`, `readyToMerge`, `fixPrompt` for a check
  and for a comment, the attempt counter.
- `src/core/worktree.ts`: `pushBranch` (no force).
- `src/server/prs.ts` (new): `PrHub` with the open-PR action, the watch
  loop, auto-fix, auto-merge, routes (`POST /api/prs/open {run, draft}`,
  `POST /api/prs/set {run, autoFix?, autoMerge?}`, `GET /api/prs`), the
  `pr` event and the health check.
- `src/core/types.ts`: `RunBranch.pr`, `PrWatch`, `PrState`, browser-safe.
- `src/server/landing.ts`: a run with a PR leaves the ready list and its
  orphan check knows PR worktrees.
- `src/cli/pr.ts` (new): `canopy pr <run> [--draft]`, `canopy prs [repo]`.
- UI: the footer block, the CI chip and popover, the two toggles, the
  pre-flight choice, the card chip, the inbox rows.

## Calls made (Eric, 2026-10-16)

1. **Land or PR, never both.** A branch run either lands locally through
   the queue or opens a PR. Changing course means dropping the PR.
2. **Auto-merge is per run, off by default, with a repo default.**
   `.canopy/prs.json` can turn it on for a repo's PRs, read from the main
   checkout's HEAD (see Auto-merge). No global default.
3. **Only comments from people with write access reach a run.** Everyone
   else's are shown, never acted on.
4. **Three fix attempts per check or comment, then stop.**
5. **`gh` on the mini is already logged in.** The canopy container has
   `gh` at `/usr/bin/gh`, logged in as BaruchEric through `GH_TOKEN`
   (checked 2026-10-16). The Mac uses Eric's own `gh` login.

## Testing

- `pr.test.ts`: parsing real `gh pr view` JSON (pending, failed, passed,
  skipped and neutral checks), `readyToMerge` on each blocking condition,
  head moving between read and merge, the attempt counter, comment trust.
- `prs.test.ts` with a fake `gh` on PATH: open PR pushes and records,
  open PR refused on a dirty worktree or with no remote, a failed check
  starts one fix run, a second failure while it runs does not start
  another, 3 attempts then an inbox row, auto-merge waits for every
  condition and passes `--match-head-commit`, a merged PR stops its watch,
  records read back after a restart.
- A live check against a scratch GitHub repo: open a PR from a branch run,
  break a check, watch auto-fix push a fix, approve, auto-merge.
