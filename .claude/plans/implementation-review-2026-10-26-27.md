# Implementation review, October 26–27 plans

Reviewed 2026-10-27 against main at e9f7c04f64bfbe0682d04c49f1908d4eb2964511. Scope is all 16 plan files dated October 26 or 27. This is a review, with no production-source changes or external actions.

The planned implementation is broadly present. The October 27 PR conflict loop has two reproduced defects, and several plans still need deployment or live validation. The later phases described in the specs are outside these particular plans and remain open.

## Confirmed findings

### P2: A rejected conflict-fix lease can omit Needs you

At `src/server/prs.ts:726-727`, `finishFix` sends every rejected push through the generic `failed` helper. A conflict fix uses a lease, but this path does not set `gaveUp` or the prescribed branch-moved error. The ordinary rebase path does both at line 754.

Reproduced through the public hub methods with real scratch git repositories and a stand-in GitHub client: leave auto-fix and auto-merge off, invoke manual rebase on a conflicting PR, resolve the conflict, and push a human commit to the remote branch before the fix finishes. Git correctly preserves the human commit, but the watch has only a generic push error. `gaveUp` and `needsYouFromPr(watch)` are both undefined, so no Needs you trigger item appears.

This violates the October 27 plan's global constraint at line 21 and its decision at line 441. Apply the lease-refusal stop state in `finishFix` for rebase fixes, as the ordinary rebase path already does. Keep the force-free push behavior for other fixes.

### P2: A successful manual conflict recovery retains an old gaveUp

At `src/server/prs.ts:745-749`, a manual retry carries an existing `gaveUp` into the next conflict fix. When that fix succeeds, `finishFix` returns `done` at line 728 with the old `gaveUp` still present. The direct successful rebase path explicitly removes it at lines 755-757.

Reproduced by stopping the first conflict fix, invoking `rebaseNow` manually, resolving the second fix, and completing its push. The remote and recorded pushed head both advance successfully; a subsequent CLEAN read still reports the previous "a fix run did not finish" message through Needs you. Auto-fix stays blocked by the stale state. Clear the prior stop state for a successful manual recovery, including recovery that required a fix run.

## Coverage of the dated plans

“Present” means source, wiring, and focused test coverage were found for the stated phase. It does not certify unperformed live checks.

| Plan | Assessment | Implementation and test evidence |
| --- | --- | --- |
| Agent defaults | Present | `src/core/route.ts`, `src/server/agents.test.ts`, `AgentScopes.tsx`; the plan records isolated browser persistence checks |
| Agent surface 1 | Present locally | `src/core/canopymcp.ts`, `src/cli/mcp.ts`, kit and shells wiring; MCP/kit tests |
| Best-of-N 1 | Present, verification issue below | `src/core/group.ts`, `src/server/groups.ts`, server fan-out wiring; `groups.test.ts`, `group-start.test.ts` |
| Capacity governor 1 | Present within plan 1 | `src/core/capacity.ts`, `src/server/capacity.ts`, driver/flow handling, Capacity component and tests |
| Collision warnings | Present | touch model, driver paths, `src/server/collisions.ts`, queue/UI wiring and tests |
| Harness share | Present | `src/core/harnessshare.ts`, server mark/seed routes, costs/Ranger/UI/CLI tests |
| PWA and push 1 | Present in source and build | `ui/src/worker.ts`, `install.ts`, `ui/sw.ts`, manifest/icons and tests; worker builds successfully |
| Run replay 1 | Present | redaction/runlog modules, runner/driver wiring, kept-run routes, export/pruning and tests |
| Scenario gates 1 | Present | scenario parser/storage/pass, landing queue, routes/CLI/UI and tests |
| Scenario gates 2 | Present | verdict/judge modules, landing hold/bypass, CLI/UI and judge tests |
| Spec converge 1 | Present | schedule rules, clock, queue/fire handling and `src/server/schedules.test.ts` |
| Work ledger 1 | Present | work/workstore modules, start/landing/PR/trigger/coordinator integration, routes/CLI and tests |
| Work until merged 1 | Present, prior live check recorded | GitHub/Forgejo intake, hook/poll paths, issue-fix routing and write-back; plan records October 27 live runs |
| Work until merged 2 | Partial | Helpers, rebase loop, route/CLI, event/inbox states and per-rule health exist; the two defects above remain |
| Workflow graph 1 | Present locally | workflow parser, modes, readiness/conditions/parallel/manual engine, routes and tests |
| Worktree stacks 1 | Present | warm model/pool/routes, git moves, branch-start wiring, CLI/UI and tests |

## Verification

- `bun run typecheck`: passed.
- `bun run lint`: passed.
- `bun run build`: passed, with existing Vite chunk-size and future config-loader advisories.
- `git diff --check`: passed; the only non-ignored addition is this review report.
- Full `bun test`: **6,224 passed, 5 skipped, 1 failed** across 377 files in 366 seconds. The failure is in `src/server/group-start.test.ts:1030`, "repo land-all queues a standalone and only a picked non-PR group winner". It returned an empty queued list instead of the standalone run. The identical isolated invocation immediately passed. The test signals process exit without waiting for standalone readiness before calling land-all; asynchronous settlement can still be pending. Wait for that specific landing record to become ready before making the assertion. This is a test synchronization finding, not a demonstrated runtime defect. The full run is not green.
- Two focused regression repros: both fail against current source as described above. Command: `bun test ./.playwright-cli/plan-review-2026-10-27/pr-gaps.repro.ts`.

The repros and raw check logs are under `.playwright-cli/plan-review-2026-10-27/`, which is ignored by git. Their fixtures create and remove local scratch repositories. They make no GitHub calls.

## Remaining validation

- Agent surface: mini deployment and actual shell/ranger discovery remain pending in the status line.
- Capacity: real quota, credential, and refresh observations remain unobserved. The server intentionally has `reader: null`; endpoint reads and dispatch holds/retries belong to later phases.
- PWA: phone installation and Cloudflare Access behavior remain pending deployment.
- Workflow graph: the status line still leaves live checks pending.
- October 27 conflict loop: the plan lists a required live GitHub check at lines 434-436, but contains no completion record for it. Unit/integration tests do not prove that external check occurred.
- Other plans' scratch live scenarios were not rerun during this repository-only review. Prior recorded checks are identified above and are not presented as newly observed results.

The plan index explains that old checkboxes are not maintained. Unchecked boxes alone were not treated as missing implementation. Several index rows still name the integration branch even though its code is now merged into main. Agent defaults and the October 27 plan are absent from the index table.
