# The sweep: close what went idle

Status: design, 2026-10-22. FR-018. Written without a question round: Eric said "just spec it", so every call below that the pen note does not make is marked as mine. After a builder check Eric made one call: the sweep covers every open PR he authored, not only the ones canopy opened.

## Why

Eric wrote the same line on two pages of his pen notebook (2026-10-14 and 2026-10-21): "Add sweep request, cron? close all inactive PRs, windows, agents, etc." Canopy starts shells, agents, chats, runs and PRs easily and closes them only by hand, one at a time. They pile up. A board of forty shells where five are in use hides the five, the agents board fills with sessions idling at their prompt, finished runs stay in the list, and PRs canopy opened sit open for weeks.

## What it is

One action, on demand or on a schedule, that finds what has gone idle and closes it. It always produces a list first: each item with its kind, where it lives, how long it has been idle and why it counts as idle. On demand, Eric picks from the list. On a schedule, canopy closes the kinds he allowed to close on their own and puts the rest in the inbox as one ask.

## Goals

- One place to see everything idle across the backend, with a reason per item.
- Close in bulk, with a preview, from the page, the command line and the CLI.
- A schedule (the note's "cron?") that keeps the board clean overnight.
- Anything closed can be brought back where canopy already knows how: a shell restores with its history and its agent's session, a chat resumes its conversation.

## Non-goals

- Agents and windows canopy did not start. A Claude Code session in a kitty window, or one the registry sees on another machine outside canopy, is listed so Eric knows it is there, and never signalled or killed.
- Merging, rebasing or landing anything. The sweep closes; the landing queue and the PR watch keep their jobs.
- Deleting branches, worktrees with work in them, transcripts or logs.

## Anti-goals (a failure even if it works)

- Closing something Eric is using. A shell he typed into five minutes ago, a run that is working, an agent waiting on a permission, a chat he is mid-conversation with: none of these may ever be swept, schedule or not.
- Closing someone else's PR. Only PRs the gh login authored can be closed, whoever opened them (a canopy run, a Claude Code session, Eric by hand). A PR from anyone else on Eric's repos, a bot's included, is never a candidate.
- Losing work. A sweep that closes a shell must keep its history first, even with "keep shells" off.
- A schedule that closes PRs silently. PRs are public and other people see the close.

## What counts as idle

Each kind has an idle span, settable, with these defaults (my call):

| Kind | Idle when | Default span | Closing does | Brought back by |
|---|---|---|---|---|
| shell | no keystroke from any device and no output for the span, not a task or the ranger, and its agent (if any) is not working or waiting on a permission | 24h | snapshot its history as a kept shell, with its agent's session id, then end the tmux session | restore from the kept list, resuming that exact session |
| chat | a canopy Claude chat between turns (`RunStatus` `idle`) with no message for the span | 12h | stop it (`/api/runs/stop`) and keep a swept-chat record | "resume" on the record starts a chat with `resume` set to its session |
| run | a finished run (`done`, `failed`, `stopped`) older than the span and not held by the landing queue or a flow | 3d | dismiss it (`runner.dismiss`) | nothing to bring back; its transcript stays on disk |
| pr | an open PR the gh login authored, on any repo, whose GitHub `updatedAt` is older than the span, not in a merge queue or set to auto-merge, and with no canopy fix going | 14d | `gh pr close` with a comment naming the sweep; the branch stays on the remote | reopen on GitHub |
| outside agent | a registry card canopy did not start, idle or lost past the span | 24h | nothing: listed only | n/a |

Notes on the table:

- An open socket does not count as use. A page keeps a socket open for every tab it holds, shown or not, so with the page left open on the Mac every shell would read as attached and nothing would ever be swept. My call: only keystrokes and output count. A swept shell's tab ends under an open page, and the shell is one click from restored.
- A Codex chat is listed but never closed, since canopy has no way to resume one yet. My call.
- "No output" for a shell comes from tmux (`window_activity`, as `RANGER_FORMAT` already reads it), so it survives a canopy restart. "No keystroke" is `lastInput`, which is in memory only, so after a restart the shell's age is the later of the restart and its last output. My call: this errs toward keeping shells, which is the safe side.
- An agent idling at its prompt in a canopy shell is swept as its shell, not on its own. The registry card ends when the shell does.
- A shell with a hand-given name (`TermTab.label`) is skipped. My call: naming a shell is the closest thing canopy has to "keep this one", and it costs nothing to undo.
- The tasks, the ranger, the coordinator, incubator stages, flows in progress and anything a move is in the middle of are never candidates.

"Windows" in the note: canopy has no server-side record of browser windows. My call for this pass: a swept shell's tab ends on every device the way any ended shell's does (the socket closes with `TERM_GONE`), and an agent dock panel (`/agent/<card id>`) or agent window whose card the sweep ended closes with it. Repo panels stay, since a repo panel is not idle just because its shell was. kitty and Terminal windows are out of scope.

## How it works

**A pure planner.** `core/sweep.ts`, browser-safe and tested: `planSweep(inputs, settings, now)` takes the shells, runs, PR watches and registry cards the server already holds, plus the authored-PR list below, and returns `SweepItem[]` (`kind`, `id`, `repoId`, `where`, `idleSince`, `why`, `action`, `auto`). No I/O.

**A hub on the server.** `server/sweep.ts`'s `SweepHub` builds the plan from live state, and executes a picked subset. Each item is checked again just before it is closed, against fresh state, so a shell typed into between the preview and the click is left alone and reported as "in use now". The hub closes one item at a time through the existing paths: `endTerm` for shells (with a new `keep` option, below), the runner's stop for chats, `runner.dismiss` for runs, and for PRs a new `PrHub.sweepClose` when canopy watches the PR, else a plain close (below).

**The authored-PR list.** One GraphQL query through `gh api graphql --paginate`, beside `PULLS_QUERY` in `core/github.ts`: `viewer.pullRequests(states: OPEN)` with each PR's repo `nameWithOwner`, number, url, title, head branch, `isDraft`, `updatedAt`, `autoMergeRequest` and whether the repo is archived. A pure `parseAuthoredPulls` turns it into `AuthoredPr[]`. The hub asks when a sweep is planned, never on a timer, so it costs one query per sweep. An item's `repoId` is the local checkout whose GitHub remote matches, when there is one; a PR on a repo with no checkout is still listed, by its slug. A PR on an archived repo cannot be closed and is left out. Drafts are listed but unchecked in the sheet and never closed by the schedule (my call: a draft is often parked on purpose). A PR canopy does not watch is closed with `gh pr close <n> -R <slug> --comment "…"`, the same comment as `sweepClose`, and its branch stays. The recheck before closing reads that one PR again (`gh pr view --json updatedAt,state`), so a push since the preview spares it.

**Changes to existing code.**

- `endTerm` today forgets the shell's kept record. The sweep needs the opposite: take a snapshot through the keep path, then end the session and leave the record, even when the `keepShells` setting is off. Those records are tagged `swept: true` and expire after 14 days (my call), so they do not pile up in turn.
- `KeptShell` stores no session id, and a restore runs `claude --continue` or `codex resume --last` (`keep.ts`, `harness.ts`), which picks the newest conversation in the folder. Three agent shells swept from one repo would all come back on the same conversation. `KeptShell` gains `session` (from the registry card whose `where.canopy.term` names the shell), and a restore with one passes `--resume <id>` or `codex resume <id>`, falling back to today's behaviour without it. This fixes a restore after any keep, not only a sweep.
- Plain chats take `resume`, which today only `BranchStart` carries. A swept chat leaves a record in `<config dir>/sweep/chats.json` (run id, repo, harness, session, title, swept at), kept 14 days and listed in the sweep sheet's "swept" fold with a resume button, since `runner.dismiss` will drop the run itself.
- PR activity. `PrWatch.updatedAt` moves on every poll, so it never ages. The idle rule reads GitHub's `updatedAt` from the authored-PR list for every PR, watched or not, and a watched PR is matched to its watch by slug and number.
- `PrHub.close` deletes the remote branch. `sweepClose` closes the PR with a comment ("Closed by canopy's sweep after 14 days with no activity. Reopen it to pick it back up.") and keeps the branch, the worktree and the local branch. The watch stays, marked `swept`, polled once a day, and the landing record keeps `pr` so the branch does not slip back into the landing queue. If the PR is reopened on GitHub, the watch drops `swept` and goes back to its normal polling, so auto-fix, auto-merge and the cleanup after a merge still work. A swept watch with no reopen for 30 days is dropped as `close` drops it today. All my calls.

**Routes.** `GET /api/sweep` returns `{items, settings, lastRun, swept}`. `POST /api/sweep {ids}` closes those items and answers with each item's outcome (`closed`, `in use now`, `gone`, `failed: <why>`). `GET`/`POST /api/sweep/settings` reads and patches the settings. In the callers table every sweep route needs the `admin` right, which the page and the CLI hold. `operate` would be wrong: shells and the ranger hold it, and an agent in any shell could then close every shell. A `sweep` SSE event carries the plan when it changes, so an open sheet stays current.

**Settings** live in config as `sweep`: `{ on, cron, spans: {shell, chat, run, pr, outside}, auto: Kind[] }`. Defaults: off, `0 4 * * *`, the spans above, `auto: ["shell", "chat", "run"]`. PRs can be added to `auto` only from the settings row, which says plainly that it closes public PRs with no one looking.

**The schedule.** It uses `core/cron.ts` (`parseCron`, `nextFire`), checked by the hub on a one-minute tick. At each fire it plans, closes the `auto` items, and holds everything else that is closable (PRs by default) as one pending ask: "Sweep: 3 PRs idle 14+ days", with close all, pick, and dismiss. The inbox is built in the browser from server state, so the ask is a record the hub keeps in `<config dir>/sweep/ask.json`, carried on the `sweep` event, and a new `InboxSource` in `ui/src/inbox.ts` turns it into the row. A newer fire replaces an unanswered ask. A fire that finds nothing writes only a log line. A fire missed while canopy was down runs once at start, like a missed ranger cron.

**Which backend.** Each backend sweeps its own shells, chats and runs. PRs are swept only by the holder of the flows lock, the same writer rule the PR watch and the triggers use, so the Mac and the mini never both close one.

**The log.** `<config dir>/sweep/log.json` keeps the newest 50 sweeps: when, on demand or scheduled, what each item was, and its outcome. The feed gets one line per sweep ("sweep closed 7 shells, 2 chats, dismissed 11 runs").

## Where Eric sees it

- **The page.** A sweep sheet, opened from the command line (`sweep`) and from a broom button on the sessions view's status line and the agents board's bar. My call on placement: those two views are where the clutter shows. The sheet groups items by kind, each a row with a checkbox, where, how long idle and why, all checked except PRs. "Close N" runs it. Outside agents show at the bottom, without checkboxes. Settings (on, cron, spans, auto) sit in a Settings row beside the ranger's.
- **The CLI.** `canopy sweep` prints the plan. `canopy sweep --yes [--kind shell,chat]` closes it, PRs only when `--kind pr` names them. `--backend` as elsewhere.
- **The inbox**, for the scheduled ask.

Visual design follows DESIGN.md and the existing sheet patterns (the landing queue's and the ranger's).

## Tests

- `core/sweep.test.ts`: every rule in the table, including each exclusion (a working agent, a permission wait, a labelled shell, a task, the ranger, a run held by landing, a PR with a fix going), the restart case for `lastInput`, and span edges.
- `server/sweep.test.ts`: preview and close against stand-ins; the recheck turning an item into "in use now"; a swept shell restorable from its kept record with keep shells off, resuming its own session when two agent shells shared a folder; a swept chat resumed from its record; `sweepClose` keeping the branch and picking the watch back up on a reopen; a watched PR whose GitHub `updatedAt` is old but whose poll is fresh still counting as idle; an unwatched authored PR closed with its branch kept; another author's PR, an archived repo's and an auto-merge PR never offered; a push between preview and close sparing the PR; the schedule firing, closing `auto` kinds and filing the inbox ask; only the lock holder touching PRs.
- `ui` tests for the sheet's grouping and default checks.

## Left to the builder

- The exact layout of the sheet and its broom glyph, within DESIGN.md.
- How the hub reads tmux activity (one `list-sessions` with a format, as the task supervisor does, is the obvious path).
- Splitting this into phases. A sensible cut is shells, chats and runs on demand first, then the schedule, then PRs.

## Out of this pass

- PRs other people opened on Eric's repos.
- Stale worktrees and branches from stopped branch runs.
- Preview slots and dev servers left running (tasks have their own sweep for logs already).
