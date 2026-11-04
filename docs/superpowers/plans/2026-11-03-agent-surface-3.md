# Agent surface, plan 3: Codex and the brief (FR-038)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Status:** in progress on branch `fr-038-plans-2-3`, 2026-11-03.

**Goal:** a Codex run holds canopy's tools the way a Claude run does, an agent holding them is told what they are and where they stop, and the agents board says which runs hold them.

**Architecture:** three small pieces on top of plan 2. Codex gets `-c mcp_servers.canopy.*` lines in `appServerArgs`, built from a new `DriveSpec.mcpServer`, and `canopy mcp --run-config <file>` reads the same 0600 file Claude's server gets. `lib/canopy-tools.md` joins the prompt through a new `ActionSpec.brief`, inside `buildPrompt`, so a chat's first message stays last. The board's chip reads `Run.canopyTools`.

**Tech Stack:** Bun, TypeScript strict, bun:test. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-25-agent-surface-design.md`, the "Plans" list's item 3. Plan 2 is `2026-11-03-agent-surface-2.md`.

## Probe P3 (2026-11-03, codex-cli 0.166.0, logged in with ChatGPT)

Driven through `codex app-server --listen stdio://` as `codexrun.ts` drives it (`experimentalApi: false`, `approvalPolicy: "untrusted"`, `sandbox: "read-only"`), against a scratch stdio MCP server.

- **`-c` lines work.** `-c mcp_servers.canopy.command=...` and `-c mcp_servers.canopy.args=[...]` start the server: `mcpServer/startupStatus/updated` says `canopy` is `ready`, and the server sees `initialize`, `notifications/initialized` and `tools/list`. They override this machine's own `[mcp_servers.canopy]`, which the kit writes as `canopy mcp`.
- **The wire names.** The item is `mcpToolCall` with `server: "canopy"` and `tool: "canopy_status"`. The spec's `mcp__<server>__<tool>` is not what this wire says, so nothing in canopy matches on that form.
- **Approval, the part the spec missed.** With no approval key the item stays `inProgress`, `tools/call` never reaches the server, and no request reaches the client in 100 s, with `approvals_reviewer="user"` as well. A run would stall on its first tool. `-c mcp_servers.canopy.default_tools_approval_mode="approve"` is a key in the 0.166.0 binary's `RawMcpServerConfig`; with it the call completes in 1 ms with no ask. `codex exec` with no key fails at once: "MCP tool call requires approval, but approval policy is never".
- **Env.** `-c mcp_servers.canopy.env.X=...` reaches the server and not the agent's shell: `printenv` there came back empty. The spec's `CANOPY_TOKEN` line is still wrong, since a `-c` value sits on argv, which `ps` shows and the run log records through `startArgv`. So the token stays in the file and the `-c` lines carry only its path.

## Global constraints

- A token never appears on argv, in the agent's env, or in the run log. `-c` lines carry a path.
- `canopy mcp --run-config` fails rather than fall back to any other token.
- No key Codex was not seen to honour. `default_tools_approval_mode` is the one approval key, and only on `mcp_servers.canopy`.
- A chat's first message stays last in its prompt (`FIRST_MESSAGE`).
- Plan 2's limits apply unchanged: everything is held in `LANES` and the handlers, whichever harness calls.

## Calls

- Spec call 16: the chip reads `Run.canopyTools`, not an `AgentCard` field set by a hook. The hook lives in tailchan's repo, and the run record already says it, so the env marker `CANOPY_TOOLS=1` is not needed.
- Spec call 17: `--run-config` replaces the spec's `-c ...env.CANOPY_TOKEN` line.

## File structure

- `src/core/codexrun.ts`: `codexMcpFlags`, `appServerArgs` takes the server.
- `src/core/driver.ts`, `src/core/runner.ts`: `mcpServer` on the spec and the extras, the brief on the live spec.
- `src/core/actions.ts`: `ActionSpec.brief`, placed in `buildPrompt`.
- `src/cli/mcp.ts`: `--run-config`.
- `src/server/runtools.ts`: `toolsBrief`. `src/server/index.ts`: `runTools`, `toolsRefusal`, `startBranchFix`.
- `lib/canopy-tools.md` (new).
- `ui/src/components/Board.tsx`, `ui/src/components/RunSheet.tsx`, `ui/src/styles.css`.

### Task 1: the Codex lines and `--run-config`

- [ ] Tests in `codexrun.test.ts` (flags in order, no token, paths quoted) and `src/cli/mcp.test.ts` (reads the file's env, an unreadable file fails).
- [ ] `DriveSpec.mcpServer`, `StartExtras.mcpServer`, `runTools` sets it, `toolsRefusal` lets Codex through.

### Task 2: the brief

- [ ] Tests in `actions.test.ts` (after the rules on a job, before the first message in a chat) and the route test (a run with tools gets the brief, a run without none, the config dir's copy wins).
- [ ] `lib/canopy-tools.md`, `toolsBrief`, a fix that starts fresh carries it.

### Task 3: the chip and the pre-flight

- [ ] `ToolsPreflight` shows for Codex. The tile shows `⌁ tools` while the card's run is live and holds them.

### Task 4: docs and gates

- [ ] `docs/architecture.md` "Callers and tokens" and "The agents board", SPEC.md if it went wrong, the plan index, this Status line.
- [ ] typecheck, lint, test, build, and a live check with real `codex`.
