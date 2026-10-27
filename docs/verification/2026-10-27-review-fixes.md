# October 27 review follow-up

The October 26 batch is merged into main. Both the Mac backend and mini were verified running `e9f7c04` before this follow-up. Old references to an unmerged integration branch or pending batch deployment were stale.

## Fixes

- A rejected conflict-fix lease now sets the same branch-moved error and stop state as a direct rebase. A competing human commit remains on the remote and the PR reaches Needs you even when automatic fixing and merging are off.
- A successful manual conflict recovery clears the old stop state, removes Needs you, and permits later automatic fixes. Failed or stopped attempts keep their stop state; ordinary fixes still use force-free pushes.
- The land-all integration test waits for its standalone landing record to become ready before making the request, using the existing condition-wait helper.
- The Mac Ranger now selects an explicit Claude profile named `ranger`. The global shell/default profile remains Codex. The mini already uses Claude for Ranger and needed no configuration change. Both Rangers and their health checks were verified running/healthy.

## Verification

Both original PR reproductions failed before the source change and pass after it. The durable regression tests pass in `src/server/prs.test.ts`, including a later automatic fix after manual recovery. The entire PR test file passes, 57 tests. The focused land-all file passes, 24 tests. Typecheck, lint and a clean production build pass. The full suite passes with `SHELL=/bin/bash bun test`: 6,227 passed, 5 skipped, 0 failed across 377 files in 361 seconds. An independent review of the PR fix found no issues.

An isolated live GitHub check used `BaruchEric/canopy-trigger-test` PR #12 with disposable base and run branches. The production PR hub, real git and real GitHub verified stopped-fix recovery, a successful lease push reaching CLEAN, and a later rejected lease preserving a human commit and producing Needs you. Conflict resolution was controlled by the harness rather than an autonomous agent. The PR was closed and both temporary remote branches were deleted. The test did not change main. Automatic BEHIND handling remains covered by integration tests; the live check exercised DIRTY and manual rebase.

The local production PWA served the worker and manifest with the correct MIME types. Chromium activated the worker, cached only `/` and hashed assets after a controlled reload, and displayed the cached offline page while the browser network was disabled. Restoring connectivity returned the app. API and Library paths pass through the worker by design.

MCP stdio initialization, discovery of all eight tools, and real `canopy_health` and `canopy_queue` calls passed against the Mac and mini backends with saved CLI session tokens. This verifies transport and API wiring; it does not establish interactive Claude/Codex or shell/Ranger token discovery.

The workflow graph passed three live API scenarios on an isolated server with real Claude Haiku jobs: Build committed `notes.md`, Lint and Docs ran in parallel, Ship held until a manual resume and the flow finished; a committed repo override held Lint while Docs ran and stopping the flow failed Lint at its gate; a malformed modes file returned 400 without creating a flow. The scratch server, root and config were removed after verification. No production workflow ran.

## Remaining observations

- Physical phone installation needs a connected, unlocked device. None was available through adb during this follow-up. Authenticated service-worker delivery on the public origin needs a browser session through `auth.beric.ca`; an unauthenticated request correctly returned 401. Neither check is represented as passed.
- The capacity endpoint on each backend returns both harnesses, no held work, and unknown usage readings. This is the implemented plan 1 behavior. Real exhausted-window, credential and refresh observations remain unobserved; no quota was deliberately exhausted and no endpoint reader or paid credits lane was enabled. Those later phases remain open.
