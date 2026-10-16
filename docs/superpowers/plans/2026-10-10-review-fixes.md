# Review fixes, 2026-10-10

**Status:** shipped 2026-10-10 (aeb7c7e).

Scope: the six findings from the review of `492135f..49ba8dc`.
Execution is authorized by the user's instruction to fix all findings.

## Tasks and verification

1. **Ignored source files survive a move.** In `src/core/peersync.ts`, extend
   `resetBlocker(repo)` to refuse a reset when restoring HEAD would replace
   ignored content, including a formerly tracked `.env` and file/directory
   obstructions. Check before any cleanup. Add real Git fixtures in
   `src/core/peersync.test.ts`; assert refusal and unchanged contents.
2. **Unreadable transcripts cannot be replaced.** In `src/core/move.ts`, only
   genuine absence may bypass the prefix check. In `src/core/move.test.ts`,
   use an unreadable existing file and assert both conflict and placement
   refuse, with the original content preserved.
3. **Deleted wakes cannot be dispatched later.** In `src/server/ranger.ts`,
   recheck wake membership before each send. Add a deferred-send regression
   to `src/server/ranger.test.ts`.
4. **Off cancels an outstanding ranger launch.** Coordinate launch and off
   across asynchronous waits without deadlocking turn-on. Add deferred
   launch tests in the same ranger test file, including a start already
   handed to tmux.
5. **Remote action responses respect backend visibility.** In
   `ui/src/store.ts`, preserve a sprout response's backend when applying it.
   Add a pending action/hide regression in `ui/src/store.test.ts`.
6. **Workspace commands accept only supported members.** In
   `ui/src/clirun.ts`, reject remote-backend repos before calling the
   home-only workspace API; retain existing local behavior. Add a command
   regression proving the request is not sent for unsupported members.

For each task: add the regression, observe the expected failure, implement
the fix, and run the focused tests. Ranger and UI tasks have separate
workers; the coordinator owns move fixes, docs, integration, and final checks.

Update the corresponding sections of `docs/architecture.md` after fixes.
Run `bun run typecheck`, `bun run lint`, `bun test`, and `bun run build`.
Review the final diff and verify the original isolated repros now behave
correctly. No deployment or commit is part of this task.
