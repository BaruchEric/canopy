# Triggers: outside events start workflows

Status: built 2026-10-17, phase 1. Not committed or deployed yet.

## Why

Syntax's "You need to check out Pi Durable" (2026-10-16) showed an agent that fixes software overnight. A Sentry error sends a webhook, a triage step picks it up, the agent finds the root cause and fixes and tests it, a PR opens, it merges, and the issue is marked resolved in Sentry. Any screen can stop the agent mid-fix and resume it where it left off. Eric asked for a workflow engine seeded with that flow, with a similar UI.

canopy already has most of the engine. It has workflows and flows, durable flow records (being finished in parallel: step sessions resumed after a restart, request ids), branch runs in their own worktrees, the landing queue, and the PR watch with auto-fix and auto-merge. The missing piece was an outside event starting the work with nobody typing.

## Decisions

- **Triggered work runs on a branch run, not a flow.** A flow works in the main checkout and refuses only a repo with an active run or flow, not a dirty tree. A trigger fires while Eric is working or asleep, so it has to work on its own branch and end in a PR. The branch-run pipeline (worktree, sort, PR, auto-fix, auto-merge, cleanup) already does the video's fix, test, PR and merge steps.
- **One-step workflows only for now.** The seed `sentry-fix` is one step that triages, finds the cause, fixes, tests, runs the gates and commits. Running a multi-step flow inside a branch worktree is a later phase and a change to `flow.ts`.
- **Webhook ingress, signature-checked.** `POST /api/hooks/sentry/<rule>` is open in the callers table, and the hub checks Sentry's HMAC before it reads the body. The edge gate in front of canopy.beric.ca must let `/api/hooks/*` through.
- **One PR per issue.** Events are deduped by rule and issue id. Only a failed start, an ignored event or a merged fix (a regression) lets the issue start again.
- **One writer per config dir.** Only the holder of the flows lock writes events and starts runs, and any other server on the same config dir answers 503. The lock is per machine. What keeps the Mac and the mini from both acting on one issue is that Sentry posts to one address.
- **Secrets stay out of runs.** Rule secrets must be named `CANOPY_TRIGGER_*`. The server takes them out of its env at start, so the unattended run that reads attacker-shaped error text never holds the Sentry token. The seed's tools leave out `bun x`, `bunx` and `bun install`.
- **Unattended.** The run denies any tool outside the step's list rather than asking. A run with no fix commits nothing and the event reads "no fix".
- **Resolve on merge.** It runs only when the rule names a token variable. A test fire never calls Sentry.
- **Rules live in `<config dir>/triggers.json`, written by hand.** Secrets are named only by environment variable, which the secret store's dotenv sinks can fill.

## Not done

- Polling Sentry, where a webhook cannot reach the backend.
- Other sources (GitHub issues, a generic signed webhook).
- Multi-step flows on a branch.
- Editing rules from the page.
- The edge Worker change for `/api/hooks/*`.
