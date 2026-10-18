# Triggers: outside events start workflows

Status: phase 1 built, committed (a96ad71) and deployed to the mini on 2026-10-17. Phase 2 built on 2026-10-17 as planned below, with the changes listed after the plan.

## Why

Syntax's "You need to check out Pi Durable" (2026-10-16) showed an agent that fixes software overnight. A Sentry error sends a webhook, a triage step picks it up, the agent finds the root cause and fixes and tests it, a PR opens, it merges, and the issue is marked resolved in Sentry. Any screen can stop the agent mid-fix and resume it where it left off. Eric asked for a workflow engine seeded with that flow, with a similar UI.

canopy already has most of the engine. It has workflows and flows, durable flow records (being finished in parallel: step sessions resumed after a restart, request ids), branch runs in their own worktrees, the landing queue, and the PR watch with auto-fix and auto-merge. The missing piece was an outside event starting the work with nobody typing.

## Decisions

- **Triggered work runs on a branch run, not a flow.** A flow works in the main checkout and refuses only a repo with an active run or flow, not a dirty tree. A trigger fires while Eric is working or asleep, so it has to work on its own branch and end in a PR. The branch-run pipeline (worktree, sort, PR, auto-fix, auto-merge, cleanup) already does the video's fix, test, PR and merge steps.
- **One-step workflows first.** The seed `sentry-fix` is one step that triages, finds the cause, fixes, tests, runs the gates and commits. Phase 2 adds flows on a branch, below.
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
- Editing rules from the page.
- The edge Worker change for `/api/hooks/*`.

## Phase 2 plan: multi-step workflows on a branch

Today a trigger takes a one-step workflow, because a flow runs in the main checkout and a branch run is one Run. The plan is to let a flow run on a branch, so a trigger can run triage, fix and verify as separate steps with checks and gates between them.

1. **The flow owns the branch.** `Flows.start` takes an optional `branch` (name, target, base, dir, origin, openPr). The server cuts the worktree once, as `startBranchRun` does now, and hands it in. The `Flow` and its `FlowRecord` keep it, so a restart finds the worktree again.
2. **Every step runs in the worktree.** `FlowRunner.start` grows the runner's existing `branch` option. Each step's run gets the flow's branch with `state: "working"` and a new `inFlow: true` mark. The step's check runs with `cwd` set to the branch's dir, not the repo path. The outcome fingerprint reads the worktree's status.
3. **Landing waits for the flow.** `LandingHub.onRun` keeps the record up to date but does not sort a branch while its run carries `inFlow`. When the flow finishes, a new hook `onBranchDone(flow, lastRun)` sets the branch state from the worktree (nothing, uncommitted or committed) and lets landing sort it, open the PR and hand it to the PR watch as today. A flow that stops or fails leaves the worktree and branch in place, like a stopped branch run.
4. **Triggers follow the flow, not the run.** `TriggerEvent` gains `flowId`. `fromRun` becomes `fromFlow` for these events: working while the flow works, waiting on a gate (it needs Eric, so "Needs you"), stopped, failed. Stop and resume call the flow's own stop and resume, which already resume a cut-short step's Claude session (1e60c63). `triggerStep` stops refusing a workflow with more than one step. Gates of kind `ask` are refused in a trigger's workflow, since no one answers.
5. **Seed.** Split `sentry-fix` into Triage (read-only tools; exit with "not ours" to end the flow with no change), Fix (the current tools) and Verify (a `check: @gates` step). Keep the one-step version as the default until phase 2 has run on a real issue.

Risks: canopy-48's flow work in `flow.ts` is in flight, so land this after it settles. The landing hold on `inFlow` is the riskiest piece, because a missed `onBranchDone` would leave a finished branch that is never sorted. Restart recovery in `Flows` needs a test for it.

### What phase 2 changed from the plan

- `triggerStep` became `triggerPlan`: a plain one-step workflow is still a branch run, and anything with more steps, a check line or a verdict or judge gate is a flow. Only `ask` gates are refused.
- The landing queue holds a flow's steps through a `held` mark on the run's branch, and takes the branch through `LandingHub.handOver`, which writes the record again even when the held steps already wrote the same state.
- Resume does not fall back to a single run when the flow is still kept. `Flows.pickUp` reruns the stopped step, resuming its Claude session, and the later steps follow. The single-run fallback stays for a flow the server has let go of.
- The seed is a second workflow, `sentry-triage-fix` (Triage, then Fix checked by `@gates` with two retries). `sentry-fix` stays the default rule's workflow until the two-step one has run on a real Sentry issue.
- Both seeds tell the agent not to invent a business default: where the behaviour is undecided, it makes the case fail with a named error and says which decision is needed.
