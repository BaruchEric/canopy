# The agent surface: `canopy mcp` and run tokens (FR-038)

FR-038 asks for canopy to be something an agent calls, not only something
Eric drives: a Claude or Codex session should be able to see the board,
start a branch run, read the landing queue, leave a note on its work and
wake the ranger, through tools it is given rather than a `curl` line it
guesses at. The idea comes from Orca's CLI that agents themselves call
(`orca worktree create`, `snapshot`; github.com/stablyai/orca), Paseo's MCP
server through which agents create worktrees, launch other agents and talk
to them (github.com/getpaseo/paseo) and Gas Town's `gt nudge`
(github.com/gastownhall/gastown). canopy has every route already; what is
missing is a token a run may hold, a lane that holds it to what the run
needs, and an MCP server that turns the routes into tools. This is what
lets FR-033's fan-outs, FR-037's handoff notes and FR-041's converge runs be
driven from inside a session. The overview is
`2026-10-25-software-factory-borrowings-design.md`.

## Where things stand (2026-10-25)

- Every API call carries a caller token (`core/callers.ts`,
  `server/callers.ts`). Kinds and rights: page (read, operate, shell,
  admin), cli (read, operate, admin), shell and ranger (read, operate),
  coordinator (read, plan), helper, none (read). `needs(method, path)` is
  the route table; a non-GET off the table needs `admin`.
- A pty shell and a tmux session get `CANOPY_TOKEN` through `shellEnv` and
  `newProcessEnv`; the ranger's session gets one through its `env`. **Runs
  get none** (`INHERITED_ENV` deletes a shell's token from canopy's own env
  at start). The one exception is the coordinator: `startCoordinator` mints
  a `coordinator` token bound to the run (`mint("coordinator", {run: id})`)
  and passes it as `CANOPY_TOKEN` with `CANOPY_API` through
  `StartExtras.env`; `CallerBook.dropRun` revokes it when the run settles.
- The coordinator's lane (`laneVerdict`, `laneAllows`, `LANE` in
  `server/callers.ts`) holds a coordinator's token to five exact routes on
  either listener, and its own listener (`CANOPY_COORD_PORT`) takes nothing
  but a coordinator's token. Its brief (`lib/coordinator.md`) teaches it
  `curl` with `$CANOPY_API`, `$CANOPY_TOKEN` and `$CANOPY_RUN`.
- A canopy shell's agent can already run `canopy <command>`: the CLI reads
  `CANOPY_TOKEN` when there is no token file (`src/cli/api.ts`). On a machine
  with a CLI token file, the CLI's admin token wins, so an agent in a shell
  on the Mac acts with Eric's own rights.
- canopy ships no MCP server of its own. `core/kitmcp.ts` writes other
  servers into an agent's config (Claude through `claude mcp add-json
  --scope user`, Codex by splicing `[mcp_servers.<name>]` tables into
  `config.toml`); `core/secretmcp.ts` is the secret store's allowance for a
  server. `cliArgs` passes `--strict-mcp-config` and no `--mcp-config`, so a
  run loads no server at all today.
- `Run.parent` names the coordinator that started a child. Nothing else
  starts a run from inside a run.

## Probes before plan 1

- **P1.** `claude -p --strict-mcp-config --mcp-config <file>` with a stdio
  server whose entry carries `env`: that the server starts, that its tools
  show as `mcp__canopy__<tool>`, that the `env` reaches the server process
  and not the agent's `Bash`, and whether `--mcp-config` takes a path, an
  inline JSON string, or both (a path keeps the token out of `ps`).
- **P2.** Whether `--allowedTools "mcp__canopy__*"` lets the tools run
  without a permission ask in print mode, so an unattended run can call
  them; and what the permission request looks like when it is not allowed,
  so `permissionAsk` can name the tool plainly.
- **P3.** Codex: `-c mcp_servers.canopy.command=...` and
  `-c mcp_servers.canopy.env.CANOPY_TOKEN=...` as command-line overrides
  (`core/harness.ts` already splices `-c` lines), the tool names Codex gives
  them (`mcpToolCall` items: `mcp__<server>__<tool>` in `codexrun.ts`), and
  whether a `-c` override is visible to the agent's shell through
  `shell_environment_policy` (it should not be: it is Codex's own config).
- **P4.** MCP server startup cost: how long `bun canopy mcp` takes to answer
  `initialize`, since `cliArgs` dropped servers for the start they add to
  every run. Under 300 ms is fine; more and the server is turned on only
  where asked.

## Design

### `canopy mcp`: the server

`src/core/canopymcp.ts` is a stdio MCP server, Bun-only, started as
`canopy mcp` (`src/cli/mcp.ts`). It speaks to one backend over the API with
the token it is given, and offers the tools that token's rights allow:
the server asks `GET /api/auth` once at start for `you` and lists tools
from `TOOLS_FOR[kind]`, so a `run` token never sees `canopy_land`. The
tools, each a thin call:

| tool | call | right |
| --- | --- | --- |
| `canopy_status` | `GET /api/tree`, folded to id, name, branch, dirty, ahead/behind, active run | read |
| `canopy_runs` | `GET /api/runs`, optionally one `id` with its last steps | read |
| `canopy_queue` | `GET /api/landing` for one repo or all | read |
| `canopy_health` | `GET /api/health`, bad checks first | read |
| `canopy_work_note` | `POST /api/work/note` (FR-037): a handoff note on this run's work item | plan |
| `canopy_run_start` | `POST /api/runs/child {repo, note, action}` (below) | plan |
| `canopy_say` | `POST /api/runs/say {id, text}` to a run this token is kin to | plan |
| `canopy_wake` | `POST /api/ranger/wakes {prompt, when}` with `by` the run | plan |
| `canopy_land` | `POST /api/landing/land {run}` | operate |
| `canopy_pr` | `POST /api/prs/open {run}` | operate |

Every tool answers plain text an agent can read, short by default, with
`--json` only on `canopy_runs` and `canopy_queue`. Errors come back as the
API's `{error}` text, never a stack. The server never retries a write.

The server reads `CANOPY_API`, `CANOPY_TOKEN` and `CANOPY_RUN` from its own
env, as the CLI does. In a canopy shell those are the shell's already, so
`claude mcp add canopy -- canopy mcp` (or the kit, below) gives Eric's own
sessions the tools at once with the shell's read+operate token. The ranger's
session gets them the same way, and its brief (`lib/ranger.md`) gains a
paragraph on them.

### Run tokens

A new caller kind `run` with rights `read` and `plan`. The runner mints one
for a branch run or a chat when the start says `tools: canopy`:

- `AgentSettings` gains `canopyTools: boolean` (default false), set per
  profile or per repo in the routes, and the pre-flight gets a "canopy
  tools" toggle that overrides it for one start. Off by default: every run
  starts as today, with no server and no token, and P4's start cost is paid
  only where asked.
- `startRepoRun` mints `mint("run", {label: "run <repo id>", run: id})` as
  `startCoordinator` does, chooses the run's id first (`StartExtras.id`),
  writes `<configDir>/runs/<id>/mcp.json` (0700 folder, 0600 file) holding
  `{mcpServers: {canopy: {command: "canopy", args: ["mcp"], env: {CANOPY_API,
  CANOPY_TOKEN, CANOPY_RUN}}}}`, and passes `--mcp-config <that file>` and
  `--allowedTools mcp__canopy__*` (P2) through a new `DriveSpec.mcpConfig`.
  Codex gets the same through `-c mcp_servers.canopy.*` (P3) in
  `agentArgs`. The token never enters the agent's own env, so a `Bash`
  `echo $CANOPY_TOKEN` finds nothing; the file is readable by the same user,
  so the token is scoped so that holding it gives nothing the tools do not
  (below). `CallerBook.dropRun` revokes it and the file is removed when the
  run settles, as the coordinator's is.
- A `run` token's rights: `read` as any token, and a `plan` the lane holds
  to its own run. `POST /api/runs/child` starts one branch run in the token's
  own repo, at `low` priority (FR-036), with `parent` set to the token's run
  and `by: "run"`, refused (409) when `RUN_CHILDREN` (3) children of this
  run are live, when the run's depth is already `RUN_DEPTH` (2: a run may
  start children, a child may not), when the repo's branch slots are full
  (the same `SlotsFullError`), or when the token's run is a trigger's
  unattended run (an unattended run reading outside text never starts
  work; `Run.unattended` is read). `canopy_say` may address the token's own
  parent and children only; `canopy_wake` sets `by` to the run and the
  wake line says which run asked; `canopy_work_note` is held to the run's
  own work item. Nothing a `run` token does can land, push, open a PR,
  answer a prompt, stop a run, or touch the config.

### The lane for runs

`laneVerdict` today has one list for the one kind it knows. It becomes a
table: `LANES: Partial<Record<CallerKind, Set<string>>>`, the coordinator's
five routes under `coordinator` and the `run` kind's under `run`:
`GET /api/tree`, `/api/runs`, `/api/landing`, `/api/health`, `/api/auth`;
`POST /api/runs/child`, `/api/runs/say`, `/api/ranger/wakes`,
`/api/work/note`. A `run` token off its lane is a 403 `{error}` logged once
per kind, method and path, on either listener, as the coordinator's is. No
second listener: a run's `claude` runs in canopy's own container (or on the
Mac as Eric's user) and holds its token by kind, not by where it dials
from; the coordinator's listener stays what it is, for the container that
cannot be trusted with `none`'s read.

The handlers read the caller (`callerOf`) and hold a `run` token to its own
run: `runs/child` and `work/note` take the run from the token when the body
names none and refuse (403) a body naming another; `runs/say` checks kin;
`ranger/wakes` stamps `by`. A page or the CLI keeps posting to those routes
with their own rights as today.

### Loops and depth

`Run.parent` is set from `StartExtras.parent` for a child of a run as it is
for a coordinator's child, and `Run.depth` (0 for a start from the page, a
trigger or a coordinator's card; parent's depth plus one) is kept on the
run. The runner refuses a child at depth `RUN_DEPTH`. The inbox and the run
sheet's `ParentLine` show the chain ("started by run 3f2a, which the
coordinator started"), and the agents board marks a card whose run holds
canopy tools with a small `⌁ tools` chip from its registry card
(`canopyTools` on `AgentCard`, set by the hook from the run's env marker
`CANOPY_TOOLS=1`, which rides in the agent's env since it is no secret).

### Teaching the agent

`lib/canopy-tools.md` is a short brief appended to the run's prompt when
`canopyTools` is on (through `ActionSpec.message`'s existing path, after the
repo's framing): what each tool does in one line, that `canopy_run_start`
begins a branch run that lands through the landing queue under the repo's
review rules and never pushes, that a child's note must stand alone (the
coordinator brief's rule), that `canopy_work_note` is where to leave what
the next session needs, and that the run has no right to land or push and
should say so rather than try. A `<config dir>/canopy-tools.md` replaces it
as `ranger.md`'s does.

### The kit

The kit's scan (`core/kitscan.ts`) learns `canopy` as a server it knows,
with `canopy mcp` as its command and no env of its own (the shell's env
carries the token), so "set up this machine" writes it for Claude and Codex
with the other servers, and `canopy kit` shows whether each agent has it.

### CLI

`canopy mcp` (the server; `--backend` as every command), `canopy mcp tools`
(prints the tool list for the token in hand, for a quick check), `canopy
runs child <repo> --note ... --parent <run>` (the same start the tool
makes, from a shell).

### Restart

A run token dies with its run as the coordinator's does: `prune` at start
drops `run` tokens whose run the landing records do not name as `stopped`
and removes their `mcp.json`. A `stopped` branch run that "fix it" resumes
gets a fresh token and file for the fix run.

## Components

- `src/core/canopymcp.ts` (new): the server, `TOOLS_FOR`, each tool's call
  and folding (pure folders tested).
- `src/cli/mcp.ts` (new), `src/cli/index.ts`: `canopy mcp`, `mcp tools`,
  `runs child`.
- `src/core/callers.ts`: the `run` kind, its rights, `runs/child` and
  `work/note` in the table, `LANES`.
- `src/server/callers.ts`: `laneVerdict` over `LANES`; `dropRun` removes
  the run's folder.
- `src/server/index.ts`: minting in `startRepoRun`, `mcp.json`,
  `POST /api/runs/child`, the kin check on `runs/say`, `by` on wakes.
- `src/core/runner.ts`, `src/core/driver.ts`, `src/core/claudedrive.ts`,
  `src/core/codexrun.ts`, `src/core/harness.ts`: `DriveSpec.mcpConfig`,
  `--mcp-config` and the allowed tools, Codex's `-c` lines, `Run.depth`.
- `src/core/types.ts`: `AgentSettings.canopyTools`, `Run.depth`,
  `AgentCard.canopyTools`.
- `src/core/kitscan.ts`, `src/core/kit.ts`: `canopy` as a known server.
- `lib/canopy-tools.md` (new), `lib/ranger.md` (a paragraph).
- `ui/src/components/AgentForm.tsx` (the toggle), the pre-flight, `RunSheet.tsx`
  (`ParentLine` chain), the agents board chip, `Inbox.tsx`.

## Calls

Made on 2026-10-25:

1. **MCP over a brief of `curl` lines.** The coordinator's brief works, but
   every new route means new prose, and a tool list is what a session
   reads first. The coordinator keeps its brief in v1; moving it onto
   `canopy mcp` is a follow-up once the lane table exists.
2. **The token rides in the MCP config file, not the agent's env.** It
   keeps `echo $CANOPY_TOKEN` empty and the agent's `Bash` unaware; it does
   not hide the token from a same-user process, and the design does not
   claim it does. The scope does the guarding.
3. **A `run` token holds `read` and a scoped `plan`, never `operate`.** An
   agent that could land its own work would bypass the review rules. Eric's
   sessions in canopy shells get the operate tools through their shell
   token, which is Eric's.
4. **Depth 2 and three children.** Enough for "split this into parts";
   not enough for a tree that fills the slots.
5. **Off by default.** P4's start cost and a smaller tool list for runs
   that need none.
6. **No second listener for runs.** The kind gates; the coordinator's
   listener stays for its container.

For Eric:

7. **Which profiles turn it on.** The ranger's session and Eric's own
   shells, surely; whether `propose` and coordinator children should, or
   only runs that name it.
8. **Codex parity in plan 1 or plan 2**, pending P3.

## Out of scope

- An agent answering another run's permission prompts or questions.
- An agent changing config, routes, review rules or gates.
- Tools over the shells (`canopy_shell_send`); the agent is in its own
  process and the shells are Eric's.
- A remote MCP transport. The server speaks stdio to the process that
  started it; the API is already remote.
- Moving the coordinator onto MCP (a follow-up).

## Testing

- `callers.test.ts`: the `run` kind's rights, `runs/child` and `work/note`
  filed, `LANES` pinned for both kinds, `laneVerdict` for a `run` token on
  and off its lane on either listener.
- `canopymcp.test.ts`: the tool list per kind, each folder on fixtures, an
  API error as text.
- `server/callers-route.test.ts`: a `run` token refused on `landing/land`
  (403) and let through on its lane; a body naming another run refused;
  `runs/say` to a non-kin refused.
- `runner.test.ts`: a child's `parent` and `depth`, the refusal at
  `RUN_DEPTH`, `RUN_CHILDREN`, an unattended run refused a child.
- `claudedrive.test.ts`: `cliArgs` with `mcpConfig` (the file path, the
  allowed tools); the fake CLI replays P1's `mcp__canopy__canopy_status`
  call and its result into a step.
- `server/index` tests: `mcp.json` written 0600 and removed at settle, the
  token revoked, the file gone after `prune` for a run that did not come
  back.
- `ui/src/agents.test.ts`: the toggle's rows; `RunSheet.test.ts`: the
  chain line.

## Plans

1. **The server and shell use**: `canopy mcp` with the shell's token, the
   kit entry, the ranger's paragraph. No new kind; Eric's sessions get the
   tools.
2. **Run tokens**: the `run` kind, `LANES`, `runs/child`, depth, the
   pre-flight toggle, `mcp.json`, Claude first (P1, P2).
3. **Codex and the brief**: P3's `-c` lines, `lib/canopy-tools.md`, the
   agents board chip.
