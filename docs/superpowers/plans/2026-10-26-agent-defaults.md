# Agent defaults implementation plan

Status: implemented and verified in this checkout

Goal: implement the [agent defaults design](../specs/2026-10-26-agent-defaults-design.md).

## Work and completion checks

- [x] Extend `AgentRoutes`, `RepoAgent`, config normalization and resolver
  with named workflow/task maps. Verify precedence, legacy configs,
  missing profiles and reset behavior in routing tests.
- [x] Add server persistence, broadcast and resolve endpoints. Verify
  HTTP writes, malformed inputs, SSE and disk reloads.
- [x] Wire manual task runs, workflow steps, fleets, coordinator children,
  trigger work and restored workflows to the same resolution. Verify the
  actual runner receives routed settings and explicit steps win.
- [x] Add the server-backed Settings tab and shared routing UI, custom
  work-type picks, named route editors, effective previews and inherit.
  Verify browser saves and reloads through an isolated server.
- [x] Add optional Codex provider selection to normalization, argv,
  app-server starts and commit suggestions. Preserve provider when
  suggestions lower model/effort; retain old settings shapes.
- [x] Update run and ledger accounting, token deltas and cost grouping.
  Verify provider/model attribution and no duplicate usage after resume.
- [x] Run final lint, typecheck, build and full suite after integration.

## Verification

`bun test`: 5,259 passed, 5 skipped, 0 failed across 328 files.
`bun run typecheck`, `bun run lint`, `bun run build` and
`git diff --check` passed. The build retains its large-chunk advisory.

Browser checks used an isolated config and repo. System Codex
model/effort/provider, named workflow and repo task saves persisted across
reloads, and inherit removed only its own override. Propose shows an
incompatible inherited route and restricts new selections to Claude Code.
The 390px phone viewport has no horizontal overflow in Settings. Served
asset hashes matched the final build. The temporary browser and server
were closed after verification.

The HTTP-to-runner-to-ledger test verifies reported model/provider values,
selected settings snapshots, tokens and persistence after routing edits.
Accounting tests cover cumulative replies, resumed sessions, reported
zero-dollar costs and provider-independent Claude archive deduplication.

Budget target is 3 percentage points of weekly allowance. This session
does not expose a usage-limits reader, so no baseline or delta is available.
