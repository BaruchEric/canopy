# Agent surface, plan 2: run tokens (FR-038)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Status:** implemented on branch `fr-038-plans-2-3`, 2026-11-03; not merged or deployed.

**Goal:** a branch run or a chat may hold canopy's tools. When the start asks for them, the runner mints a `run` token for that run, writes it into a 0600 `mcp.json` and passes the file through `--mcp-config`. The token holds `read` and a `plan` the handlers hold to its own run: it can read the board, start up to three children of its own run in its own repo, say to its kin, wake the ranger and leave a note on its own work item. It cannot land, push, open a PR, answer a prompt, stop a run or touch the config. Off by default: no profile turns it on and a run with it off starts exactly as today.

**Architecture:** four layers. `core/callers.ts` gains the kind, the `LANES` table and the routes filed `plan`. `core/runtools.ts` is pure: the limits, the kin rule, the file's contents. `server/runtools.ts` writes and removes the file and mints and drops the token. `server/index.ts` wires them into `startRepoRun`, `startBranchFix`, `POST /api/runs/child` and the settle and restart paths. Every scope check lives in a handler, never in the MCP server, because the agent's own `Bash` can read its `mcp.json` and call the API directly.

**Tech Stack:** Bun, TypeScript strict, bun:test. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-25-agent-surface-design.md`, the "Plans" list's item 2. Plan 1 is `2026-10-26-agent-surface-1.md`.

## Probes (2026-11-03, Claude Code 2.1.317)

A scratch stdio server and a throwaway token, run the way `cliArgs` runs `claude`, then once more against the real `bin/canopy-mcp.ts` with a stub backend.

- **P1.** `--strict-mcp-config --mcp-config <file>` starts the server. `--mcp-config` takes a path or an inline JSON string, and it is variadic (`<configs...>`), so a flag must follow it. We pass the path, which keeps the token out of `ps`. The init line reports `mcp_servers: [{name: "canopy", status: "connected", source: "dynamic"}]`, and the tools show as `mcp__canopy__<tool>`. The entry's `env` reached the server (`PROBE_TOKEN=throwaway...`) and not the agent's `Bash` (`echo "[$PROBE_TOKEN]"` printed `[]`). The tools are deferred: the model first calls `ToolSearch` with `select:mcp__canopy__canopy_status`, which needs no permission. Claude sends `server/discover` before `initialize`. Canopy's server answers that with -32601 and Claude carries on: the real server connected, listed its tools and served `canopy_status`.
- **P2.** `--allowedTools "mcp__canopy__*"` lets a call run in `--permission-mode default` with no ask. Without it the wire shows `control_request` `can_use_tool` with `tool_name: "mcp__canopy__canopy_status"`, `display_name: "Canopy Status"` and `mcp_server: {name: "canopy", source: "dynamic"}`. `permissionAsk` already titles an `mcp__` name through `actions.ts`, so nothing there changes.
- **P4.** Spawn to the `initialize` reply against a stub backend, 7 runs at load 6.3: `bin/canopy.ts` 107 ms median, `bin/canopy-mcp.ts` 36 ms, a built bundle 19 ms. All are under 300 ms, so P4 forces nothing. Off by default stands as a call on its own (a smaller tool list, and a credential only where asked).

## Live check (2026-11-03, real `claude` against a scratch server in enforce)

A branch ask with `canopyTools` called `canopy_status`, `canopy_work_note` and `canopy_run_start` through `bin/canopy-mcp.ts` with no prompt. The child started with `parent`, depth 1 and its own file. The file was 0600 in a 0700 folder. With the token from that file, `GET /api/runs` answered 200, and `POST /api/landing/land`, a run's stop and `POST /api/repos/run` answered 403 from the lane. A child in the other repo, a child under another parent and a cron wake answered 403 from their handlers. When the parent ended, its file and its entry in `callers.json` were gone and the child's stayed while the child worked.

The first pass failed the child at start, which is how spec call 15 came about. `CANOPY_LOOPBACK_AUTH=1` is credential-named with the value `1`, so the run log's collision check removed `runs/<id>/` whole, and the file with it. The run log still stops on that scratch server, and the run now carries on.

## Global constraints

- `run` holds `read` and `plan`, never `operate`, and is not in `PAIR_KINDS`.
- The token rides in `<config dir>/run-tools/<id>.mcp.json` (0700 folder, 0600 file; spec call 15) and never in the agent's env or on argv.
- The file's `command` is `process.execPath` and its args are `[<canopy>/bin/canopy-mcp.ts, "mcp"]`, not `canopy` off the PATH: launchd's and the container's PATH may lack it, and this path is three times faster to start.
- The `run` lane is `GET /api/tree`, `/api/runs`, `/api/landing`, `/api/health`, `/api/auth` and `POST /api/runs/child`, `/api/runs/say`, `/api/ranger/wakes`, `/api/work/note`, on the main listener. On the coordinator's listener a run token gets the `token` verdict, even on a route in its lane.
- `RUN_CHILDREN` is 3 live children, `RUN_DEPTH` is 2: depth 0 may start a child at depth 1, depth 1 may not.
- A coordinator's card is depth 0 with a `parent`, so depth is passed on its own and `parent` alone never means "a run's child".
- `AgentSettings.canopyTools` is optional, so no literal in the repo changes.
- Off by default: no route, profile or default turns it on.
- All four gates pass: `bun run typecheck`, `bun run lint`, `bun test`, `bun run build`.

## Review focus

Inputs the spec implies and no section of it names. Each has a test in the task that owns the code.

1. A run token calling a route over plain HTTP with a body the MCP tool would never send: another run as `parent`, another repo, another work item, `by: "eric"` on a wake. Refused or overwritten by the handler (Task 4).
2. A run token on the coordinator's listener, on a route in its own lane: the `token` verdict (Task 1).
3. A cron wake from a run: refused, since a run's rights end with it and a schedule would outlive it (Task 4).
4. Two `runs/child` posts at once with two slots of `RUN_CHILDREN` left: the third and fourth children both pass any check made before the branch is cut, so the count is made again in `Runner.start`, which is synchronous (Task 3).
5. A profile with tools on and a trigger's run: no token is minted, and a child naming that run as parent is refused because `Run.unattended` is set (Task 3, Task 4).
6. `CANOPY_RUN` set and `CANOPY_TOKEN` missing, on the Mac where a CLI token file exists: `canopy mcp` must not fall back to the CLI's admin token (Task 5).
7. A run start that fails after the mint (slots full, a bad branch, capacity): the token is revoked and the file gone (Task 4).
8. A resumed fix of a child: it keeps the depth, so a stall or a fix cannot reset a child to depth 0 and start grandchildren (Task 4).
9. A second `--allowedTools` flag or a plain word after `--mcp-config`: pinned by the `cliArgs` test (Task 3).
10. A chat as `canopy_say`'s target works; a branch run answers the runner's own "only a chat takes messages", which reaches the agent as text. The kin check still comes first (Task 4).

---

## File structure

- Create `src/core/runtools.ts` and test: `RUN_CHILDREN`, `RUN_DEPTH`, `CANOPY_TOOL_RULE`, `RUN_CHILD_ACTIONS`, `childRefusal`, `areKin`, `mcpConfigJson`.
- Create `src/server/runtools.ts` and test: `mcpConfigPath`, `writeMcpConfig`, `removeMcpConfig`, `sweepMcpConfigs`.
- Modify `src/core/callers.ts`, `src/server/callers.ts`: the kind, the plan routes, `LANES`.
- Modify `src/core/types.ts`, `src/core/agent.ts`: `AgentSettings.canopyTools`, `Run.depth`, `Run.canopyTools`, `Run.unattended`, `LandingRun` fields, `RangerWake.from`.
- Modify `src/core/driver.ts`, `src/core/claudedrive.ts`, `src/core/runner.ts`, `src/core/runlog.ts`: `DriveSpec.mcpConfig`, `StartExtras`, the child check, the snapshot.
- Modify `src/server/index.ts`: `startRepoRun`, `startBranchFix`, `POST /api/runs/child`, the kin check, the settle and restart paths.
- Modify `src/server/ranger.ts`, `src/core/ranger.ts`, `lib/ranger.md`: the stamped wake.
- Modify `src/server/work.ts`: the note held to the run's item.
- Modify `src/server/stalls.ts`: a run's child gets the watchdog; a coordinator's child still does not.
- Modify `src/core/canopymcp.ts`, `src/cli/mcp.ts`: `canopy_work_note`, `canopy_run_start`, no CLI-token fallback under `CANOPY_RUN`.
- Modify `src/cli/index.ts`, `src/core/help.ts`, `README.md`: `canopy runs child`, `--tools`.
- Modify `ui/src/components/AgentForm.tsx`, `RunSheet.tsx`, `CoordTasks.tsx`, `ui/src/store.ts`, `ui/src/api.ts`: the toggles and the chain line.
- Modify `docs/architecture.md`, `SPEC.md`, the design doc's Calls.

---

### Task 1: the kind, the plan routes and `LANES`

**Files:** `src/core/callers.ts`, `src/server/callers.ts`, `src/core/callers.test.ts`, `src/server/callers.test.ts`, `src/core/canopymcp.ts` (the `TOOLS_FOR` row)

- [ ] Tests first: `allows("run", "operate")` false, `allows("run", "plan")` true, `run` not in `PAIR_KINDS`; `needs` gives `plan` for `POST runs/child`, `runs/say`, `ranger/wakes`, `work/note`, and `operate` for `DELETE ranger/wakes`, `POST work/close`, `runs/stop`, `runs/answer`, `landing/land`, `prs/open`; `LANES` pinned for both kinds; `laneVerdict` for a run token on and off its lane on both listeners.
- [ ] Move `LANE` into `LANES` in `core/callers.ts`; `laneAllows(kind, method, path)`; `laneVerdict` over the table; the refusal's words and log line per kind; `KINDS` gains `run`.
- [ ] Commit.

### Task 2: settings and the run's new fields

**Files:** `src/core/types.ts`, `src/core/agent.ts`, `src/core/agent.test.ts`, `src/core/runlog.ts`

- [ ] Tests first: `normalizeAgent` keeps `canopyTools: true` and drops anything else; `sameAgent` tells a toggled copy apart; `describeAgent` says `canopy tools`.
- [ ] `Run.depth?`, `Run.canopyTools?`, `Run.unattended?`; `LandingRun.parent?`, `depth?`, `canopyTools?`; the kept snapshot carries them.
- [ ] Commit.

### Task 3: the wire and the runner's child check

**Files:** `src/core/runtools.ts`, `src/core/driver.ts`, `src/core/claudedrive.ts`, `src/core/runner.ts`, tests

- [ ] Tests first. `cliArgs` with `mcpConfig`: `--mcp-config <file>` then a flag, one `--allowedTools` holding the action's rules and `mcp__canopy__*`, none of it without the field. `Runner`: a child's `parent` and `depth`, a coordinator's child stays depth 0, refusals at `RUN_CHILDREN`, `RUN_DEPTH`, an unattended parent and a gone parent, all raised by `Runner.start` as `ChildRefusedError`. A fake CLI replays P1's `mcp__canopy__canopy_status` call into a step.
- [ ] `childRefusal` pure in `core/runtools.ts`; `Runner.childRefusal(parent)` reads the live map; `Runner.start` checks under `extras.child`.
- [ ] Commit.

### Task 4: minting, the file and the handlers

**Files:** `src/server/runtools.ts`, `src/server/index.ts`, `src/server/work.ts`, `src/server/ranger.ts`, `src/core/ranger.ts`, `src/server/stalls.ts`, `lib/ranger.md`, tests

- [ ] Tests first, over HTTP with a fake harness on a scratch repo, one server in `enforce`: the file is 0600 in a 0700 folder and holds the token, the run's env does not; the token dies and the file goes when the run settles; a start that fails leaves neither; a restart drops every `run` token and removes its file; a run token is 403 on `landing/land`, `prs/open`, `runs/stop`, `runs/answer`, `runs/fork`, `agents/profile`, `repos/run`; `runs/child` naming another repo or parent is 403; a fourth live child, a grandchild and an unattended parent are 409; `runs/say` to a stranger is 403 and to a kin chat is 200; a wake's `by` is stamped and `cron` refused; `work/note` naming another item is 403.
- [ ] `startRepoRun` takes `RunStartOptions`; `runToolsFor` mints, writes and hands back the extras and a release; `POST /api/runs/child`; `tools` on `repos/run`, refused for a group, a coordinator, a seed and, until plan 3, Codex.
- [ ] `startBranchFix` gives a fresh token to a fix of a tools run and keeps its depth and parent.
- [ ] Commit.

### Task 5: the tools

**Files:** `src/core/canopymcp.ts`, `src/cli/mcp.ts`, tests

- [ ] Tests first: `TOOLS_FOR.run` is the read tools and the plan tools and never `canopy_land` or `canopy_pr`; `canopy_run_start` posts `{repo, note, action, parent}`; `canopy_work_note` posts `{id, text}`; the wake stops claiming `by: "eric"` for a run; `mcpToken` with `CANOPY_RUN` set ignores the token file.
- [ ] Commit.

### Task 6: the CLI

**Files:** `src/cli/index.ts`, `src/core/help.ts`, `README.md`

- [ ] `canopy runs child <repo> --note ... --parent <run>`; `--tools` and `--no-tools` on the run start. Tests in the CLI's own file.
- [ ] Commit.

### Task 7: the UI

**Files:** `ui/src/components/AgentForm.tsx`, `RunSheet.tsx`, `CoordTasks.tsx`, `ui/src/api.ts`, `ui/src/store.ts`, `ui/src/styles.css` only if a class is new, tests

- [ ] The form's toggle; the pre-flight's toggle, hidden for a coordinator, a group, a seed and Codex; `ParentLine` tells a run's parent from a coordinator and shows the chain.
- [ ] Commit.

### Task 8: docs and gates

- [ ] `docs/architecture.md` "Callers and tokens"; `SPEC.md` (state and a decision line); the design doc's Calls; `README.md`.
- [ ] Full `bun run typecheck`, `bun run lint`, `bun test`, `bun run build`. Commit.
