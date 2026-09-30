# Agents: harness routing, a tailnet registry, the human in the loop

Date: 2026-09-30. Status: design, awaiting review. Touches two repos: canopy,
and the tailchan broker in `homelab/services/tailchan` (plus its CLI and the
homelab `tailchan` skill).

## What the user asked for

1. Agent harness routing and switching (Claude Code, Codex, …), with a UI to
   configure it per app, repo, process and agent.
2. A registry of every agent, wherever it was started, canopy or not.
3. The registry handles peer to peer, group subscriptions, and what each agent
   can do: an agent says "I'm on the Mac and can do X", "I'm in a container and
   can provide Y".
4. A human in the loop.

Decided in conversation:

- The registry lives in the **tailchan broker**. It is one per tailnet, it
  already names every caller's machine through WhoIs, and agents outside canopy
  already reach it through the CLI. canopy displays and edits the registry; it
  doesn't host it.
- Agents join the registry through **harness hooks plus a process scan**. Hooks
  give state and session ids. Each canopy backend's scan catches the agents that
  have no hooks.
- The first cut routes between **Claude Code and Codex**.
- Human in the loop reaches **any agent through hooks**. A permission or
  question hook posts the prompt to the broker and waits. If nobody answers
  before a timeout, it falls back to the terminal prompt.

What was assumed, for review:

- "Per process" means the kind of work canopy starts an agent for: an
  interactive shell, a chat, a job, a flow step, a commit-message suggestion.
  These are called **roles** below. It does not mean the dev-cycle tasks. An
  agent as a supervised task could come later.
- "Per agent" means named **profiles** ("deep" = opus/max, "review" =
  codex/high). A route points at a profile. Changing the profile changes every
  route that points at it, which is what makes switching one click.
- Registry data and asks are the home backend's alone, like tailchan and
  workspaces (multi-backend amendment 8). Every backend still scans its own
  machine.

## What already exists

| # | Exists | Gap |
|---|---|---|
| 1 | `AgentSettings` per repo path (model, effort, yolo, extra), Claude only. `claudeArgs` feeds `claudeLine`, `resumeLine`, herdr and the runner. `AgentKind = "claude" \| "codex"` and `agentIn` already recognise codex. Both containers mount `~/.codex`, and the shells image installs codex. | No harness field. Model and effort are Claude's enums. The runner speaks only Claude's stream-json. `continueLine`, `KeptShells`, `runsClaude` and the herdr opener assume Claude. |
| 2 | canopy knows its own runs and shells, and detects an agent in a pane on demand. `claudeSessions` reads history files. The broker's `/v1/who` gives handle, node and last seen. _control's PostToolUse hook posts inactive sessions to :7842. | An agent started in kitty, herdr, VS Code, or over ssh on another machine is no live thing anywhere. |
| 3 | tailchan DMs, channels, private channels and subscriptions. `shellHandle` gives a canopy shell a handle. Helpers and `Backend` list a machine's openers. | No per-agent card: where it runs, what it can do, which harness and model. A message to an agent is only read when the agent thinks to run `tailchan inbox`. |
| 4 | A run parks on a permission or `AskUserQuestion` prompt, and the browser answers it. Flows have `ask` and `verdict` gates. `runNotice` DMs the human, which pings Telegram. | Only canopy's headless runs are covered. A prompt in an interactive shell, canopy's or anyone's, can't be routed. |

`DEFAULT_AGENT.yolo` is on, so most canopy-started agents never ask
permission. For them the human in the loop means questions, idle-waiting-on-you,
and the guards in phase 5. Agents started by hand outside canopy prompt by
default, and for them permission routing is the main feature.

## Phase 0: spikes

Each spike decides a detail below. Each is a one-hour measurement with the
result written into this spec as an amendment.

1. **Claude, interactive `PermissionRequest`.** Does the terminal prompt wait
   for the hook, or show beside it? If it waits, a remote wait delays anyone at
   the terminal, which is why routing has a local rule (phase 4). If both show,
   the first answer wins, and the local rule can relax. Codex is known: the hook
   runs first, and the prompt shows only when the hook returns no decision.
2. **Claude, `AskUserQuestion` from a `PreToolUse` hook in an interactive
   session.** Can `permissionDecision: "allow"` with `updatedInput.answers`
   answer it? The docs cover `-p` only.
3. **A detached watcher from `SessionStart`.** Does a `setsid nohup` child
   outlive the hook, and does walking up from the hook's `$PPID` find the
   harness process (`claude`, a version-string comm, `codex`, or `node …/codex`)?
4. **`asyncRewake`.** Can an async `SessionStart` hook that blocks on a DM wake
   an idle Claude when it exits 2?
5. **Codex hook trust.** Does a hook in `~/.codex/hooks.json` need a one-time
   `/hooks` trust per machine, and does editing the file re-ask? Does
   `--no-daemon` keep commands in the pane's process tree and env?
6. **Codex in tmux.** What `pane_current_command` reads for a bun-installed
   codex (`node` or `codex`), and whether `agentIn` still sees it.
7. **herdr.** Does `herdr agent start --kind codex` exist?

## Phase 1: harnesses and routing

### The harness setting

`AgentSettings` gains `harness`. The whole shape stays browser-safe in
`core/types.ts`:

```ts
export const HARNESSES = ["claude", "codex"] as const;
export type Harness = (typeof HARNESSES)[number]; // AgentKind becomes an alias

export interface AgentSettings {
  harness: Harness;   // absent in an old entry, read as "claude"
  model: string;      // claude: an AGENT_MODELS alias; codex: "default" or a name matching MODEL_RE
  effort: AgentEffort; // AGENT_EFFORTS gains "ultra" (codex only)
  yolo: boolean;
  extra: string;
}
```

`core/harness.ts` (new, browser-safe, pure, tested) has one `HarnessInfo` per
harness. Every Claude-specific builder becomes a lookup in that table:

| | claude | codex |
|---|---|---|
| binary | `claude` | `codex` |
| model | `--model <alias>` (closed list) | `-m <name>` (open; a hint list for the form) |
| effort | `--effort <x>` | `-c model_reasoning_effort=<x>` |
| yolo on | `--dangerously-skip-permissions` | `--dangerously-bypass-approvals-and-sandbox` |
| yolo off | (prompts) | `-a on-request -s workspace-write` |
| always | | `--no-daemon`, so the process, env and `TAILCHAN_AS` stay in the pane (spike 5) |
| first message | positional | positional |
| resume | `--resume <uuid>` | `codex resume <uuid>` |
| continue | `claude --continue` | `codex resume --last` |
| sessions | `~/.claude/projects/<folder>/*.jsonl` | first line (`session_meta`) of `$CODEX_HOME/sessions/**/rollout-*.jsonl`, the last 30 days, memoized by mtime, skipping `source.subagent` |

`normalizeAgent` validates per harness. It drops an effort the harness doesn't
take and a model that doesn't fit, falling back field by field, so a stale
value never reaches a command line. `agentArgs(a)` replaces `claudeArgs`, and
`agentLine(a, prompt?)` replaces `claudeLine`. `resumeLine`, `continueLine`,
`agentShellCommand`, the kitty and Terminal builders and `sshSessionArgs` all
take the harness. `continueLine(kind)` stops returning null for codex. The
herdr opener passes `--kind <harness>` if spike 7 says it exists, and otherwise
refuses codex with a plain error. `backendCaps` gains `harnesses` (which
binaries are on the backend's PATH), so the UI greys out a harness a machine
lacks, and a route to one fails with "codex is not installed on mini" instead
of a dead shell.

### Roles, profiles and resolution

```ts
export const AGENT_ROLES = ["shell", "chat", "job", "flow", "suggest"] as const;
export type AgentPick = { profile: string } | AgentSettings;
export interface RepoAgent { all?: AgentPick; roles?: Partial<Record<AgentRole, AgentPick>> }
```

- `shell` covers every interactive start: the panel's own shell with
  `start=agent`, a new agent shell, resume, the agent and herdr openers, and the
  guided panel's asks.
- `chat` and `job` are the runner's two modes.
- `flow` is a workflow step.
- `suggest` is the commit-message suggestion.

Backend config (`~/.config/canopy`) gains:

- `profiles: Record<string, AgentSettings>`. `default` always exists and is
  the backend default.
- `agentRoles: Partial<Record<AgentRole, AgentPick>>`.

`agents[path]` becomes `AgentSettings | RepoAgent`. An old entry reads as
`{ all: entry }`, so nothing needs migrating.

`resolveAgent(cfg, path, role, explicit?)` in `core/route.ts` (pure, tested)
returns `{ settings, from, profile? }`. The first layer that is present wins:

1. **explicit**: the launch picker, or a workflow step's `agent: <profile>`
2. **repo × role**: `agents[path].roles[role]`
3. **repo**: `agents[path].all`
4. **role**: `agentRoles[role]`
5. **default**: `profiles.default`
6. **builtin**: `DEFAULT_AGENT`

The repo beats the role on purpose: a repo override is the more deliberate
choice. The UI always shows where a setting came from (`from`), so the order
never surprises. A pick naming a missing profile falls through to the next
layer, and the UI flags it. In phase 1 only `shell` may resolve to codex; the
other roles get codex in phase 2. Every current caller of `agentFor` moves to
`resolveAgent` with its role. `agentLine` in `startServer` becomes
`agentLine(repo, role)`.

The socket's `start=claude` becomes `start=agent`, with an optional
`profile=`. The tab's `start: "claude"` becomes `start: "agent"` and
`TermTab.harness`. `askClaude` becomes `askAgent` and pastes into the first
candidate that `/api/terms/agent` says runs any harness. `guided.ts` copy says
"your agent" where it said Claude. `pendingClaude` and `runsClaude` generalize
the same way. `KeptShells` offers "restore + continue" for either harness.

### The UI

- **The agents view**, a fourth tab in `ViewNav` (git, library, ports,
  agents). Phase 1 ships its **routing** tab; phase 3 adds the registry tab.
  - Profiles: a list you can add to, edit and delete (`default` can't be
    deleted). Each is `AgentForm` with a harness picker in front. The model
    field is a select for Claude and a text box with a datalist for Codex.
  - Roles: one row per role, each with a profile picker or "default".
  - Repo overrides: one row per repo that has an entry, with a whole-repo pick,
    a pick per role, and reset. "Add override" searches the scan.
  - Effective: pick a repo and see each role's resolved harness, model and
    `from`.
- The per-repo "agent settings…" sheet (`{kind:"agent"}`) becomes that repo's
  override row: the whole-repo pick, per-role picks, and the effective column.
- **Switching at launch.** `RepoMenu`'s "with claude" group becomes "with an
  agent", with "new claude shell" and "new codex shell" (each a profile pick
  that overrides the route for that one start). The shell strip's `+` gets the
  same choice on a long press or a right click.
- Routes are the backend's own. On a board with several backends, the view
  edits the backend picked in `SettingsMenu`'s backend picker, as keep-shells
  already does.

Routes: `GET /api/agents` becomes `{ profiles, roles, repos }`, and the
`agents` event carries the same. `POST /api/agents/profile` `{name, settings |
null}`, `POST /api/agents/role` `{role, pick | null}`, and
`POST /api/repos/agent?id=` take `RepoAgent`. All are normalized server-side.
`GET /api/agents/resolve?id=` returns the effective table.

## Phase 2: Codex headless

`runner.ts` keeps the `Runner` class and its hooks and moves the per-harness
wire behind a `RunDriver`:

```ts
interface RunDriver {
  start(ctx: DriveCtx): void;             // spawn, send the first message
  say(text: string): void;                 // a chat's next turn
  answer(p: RunPrompt, a: RunAnswer): void;
  stop(): void;                            // interrupt, then kill
}
```

`ClaudeDriver` is today's stream-json code, unchanged. `CodexDriver`
(`core/codexrun.ts`) speaks `codex app-server` over stdio, one process per run:

- It sends `initialize` and `initialized`, then `thread/start {cwd,
  approvalPolicy: "on-request", sandbox: "workspace-write", model}`, then
  `turn/start {input, effort}`. `codex exec` can't be used because it forces
  approvals to `never`.
- `item/*` notifications become `RunStep`s:
  - `agent_message` becomes `text`.
  - `command_execution` becomes a tool step named `Bash`, titled by its
    command.
  - `file_change` becomes `Edit`, with its paths.
  - `mcp_tool_call` and `web_search` become tools under their own names.
  - `describeTool` and `toolDetail` in `actions.ts` learn these.
- `item/commandExecution/requestApproval` and
  `item/fileChange/requestApproval` become a `permission` prompt.
  `item/tool/requestUserInput` becomes a `question`. Answers go back as
  `accept`, `acceptForSession` (for "allow all") or `decline` under the
  request's id.
- A job's `allowedTools` are Claude rule strings. For Codex, canopy enforces
  them itself: an approval whose command, unwrapped from `bash -lc`, is a
  single simple command (no `;`, `|`, `&`, `$` or backtick) matching a rule's
  word prefix is accepted without asking. File changes are accepted when the
  rules include `Edit` or `Write`. Everything else parks for the human, as a
  Claude run does.
- `turn/completed` becomes the result. `RunResult.costUsd` becomes optional,
  and `tokens` is added from `usage`. A chat's next turn is `turn/start` on
  the same thread, and `stop()` is `turn/interrupt`, then a kill.
- `Run` gains `harness` and `session` (Claude's session id, Codex's thread id).
  Both drivers fill `session`, which is what makes a run resumable in a shell
  later.
- `suggest` for Codex is `codex exec --sandbox read-only --ephemeral -o <tmp>
  "<prompt>"`. It needs no tools and so no approvals.
- The app-server is marked experimental. The driver reads `codex --version`
  and warns in the run's first note when it is outside the tested range (from
  0.158).

## Phase 3: the registry

### The broker (homelab)

A new table, and routes beside the existing ones. Every card belongs to the
node that wrote it, and only that node can change it. The node is the part of
the caller's identity that WhoIs authenticates. The handle is self-declared, as
before.

```ts
type AgentState = "working" | "idle" | "waiting" | "ended" | "lost";
interface AgentCard {
  id: string;            // `${harness}:${session}`, or `scan:${node}:${ns}:${pid}`
  handle: string;        // what a DM goes to
  node: string;          // from WhoIs, never from the body
  harness: Harness | "other";
  session: string | null;
  origin: "canopy-shell" | "canopy-run" | "elsewhere" | "scan";
  cwd: string;
  repo: string | null;   // the remote as a web url: the key canopy joins cards on
  branch: string | null;
  model: string | null;
  mode: string | null;   // permission mode as the harness reports it
  state: AgentState;
  waiting: string | null; // one line: what it waits on
  caps: string[];
  offers: string[];
  where: {
    os: string; container: boolean; pid: number | null;
    term: string | null;                           // TERM_PROGRAM: kitty, vscode, …
    canopy: { backend: string; term?: string; run?: string } | null;
  };
  transcript: string | null;
  startedAt: number; seenAt: number; endedAt: number | null;
}
```

- `PUT /v1/agents/:id` upserts a card. `PATCH` sets `state`, `waiting` and
  `seenAt`. `DELETE` marks it ended. Each is refused (403) for a card another
  node owns.
- `POST /v1/agents/beat {alive: id[], ended: id[]}` is the watcher's batch
  beat.
- `POST /v1/agents/scan {container, procs}` replaces the caller node's scan
  cards in that pid namespace. A process whose pid a hooked card on the same
  node and namespace already names makes no card.
- `GET /v1/agents?state=live|all&node=&repo=&cap=&harness=` lists cards.
  `cap` repeats, and every listed cap must be present. `GET /v1/agents/:id`
  gets one.
- A card not beaten for 3 minutes turns `lost`. Ended and lost cards are kept 7
  days.
- Every state change, not every beat, is posted on channel `agents` as a
  `kind: event` message with `meta.silent`, so a follower hears the registry
  through the existing stream. The sweep deletes that channel's messages after 7
  days.
- The broker's `identify` is refactored so tests can inject WhoIs. New
  `server.test.ts` covers the ownership rules, the scan dedupe, `lost`, and the
  cap query.

### Joining: hooks

`tailchan agent hook <harness>` (new, in the bash CLI) reads the hook JSON on
stdin and handles each event. It fails open everywhere: a broker that doesn't
answer within 2 s means exit 0 and no decision.

| event | does |
|---|---|
| `SessionStart` (async) | Builds the card: session, cwd, the git remote and branch, the model, `permission_mode`, `transcript_path`, and the harness pid (spike 3). `where.canopy` comes from `CANOPY_BACKEND`, `CANOPY_TERM` and `CANOPY_RUN`, which canopy now sets on every shell and run, like `TAILCHAN_AS`. Caps are below. Then `PUT`, a subscription to `repo.<slug>` (phase 5), and starting the watcher if it isn't running. |
| `UserPromptSubmit`, `PreToolUse` (async, throttled to 1 per 20 s) | `PATCH state=working` |
| `Stop` | `PATCH state=idle`. Phase 5 adds message delivery. |
| `Notification` `idle_prompt` / `agent_needs_input` | `PATCH state=waiting`, `waiting="your turn"` |
| `PermissionRequest` | Phase 4 |
| `SessionEnd` (async) | `DELETE` |

The handle is `TAILCHAN_AS` when set (a canopy shell's `shellHandle`),
otherwise `<harness>-<first 6 of the session id>`, the rule the CLI already
uses for Claude. The watcher, `tailchan agent watch`, is one process per
machine (flock). It keeps a pid file per card under `~/.cache/tailchan/agents/`
and sends one batch beat every 60 s: the pids that are still alive, and the
ones that died, as ended. It exits when it has nothing left to watch.

`tailchan agent install [claude|codex]` merges the hooks into
`~/.claude/settings.json` (with jq, idempotently, marked so a re-run finds its
own entries) and into `~/.codex/hooks.json`. Every hook command is
`sh -c 'command -v tailchan >/dev/null && exec tailchan agent hook claude ||
exit 0'`, so a synced dotclaude on a machine without the CLI does nothing.
Codex's user hooks need a one-time trust per machine (spike 5), which
`tailchan agent doctor` checks and explains. canopy runs set `CANOPY_RUN`, and
the hook then registers the run with `origin: canopy-run` but never answers its
`PermissionRequest`, since canopy's own stdio channel does.

### Joining: the scan

Each canopy backend scans its own machine every 30 s for agents without hooks.
`core/agentscan.ts` is pure and tested except for the fs walk:

- **Linux:** `/proc/*/comm`, `cmdline`, `cwd` and `stat`. The pid, comm and cwd
  walk is lifted out of `procListeners` in `ports.ts` so both share it.
- **macOS:** `ps -axo pid=,ppid=,lstart=,comm=,args=`, then
  `lsof -a -d cwd -p <pids> -Fpn` (`parseLsofCwd` exists).
- **Classify:** `claude`, a version-string comm with a `claude` argv, `codex`,
  or `node …/codex/…` and its native child. The child is counted once, by its
  parent.

The backend posts `/v1/agents/scan` as the `canopy` bot. canopy on the mini
shares the shells container's pid namespace, so it sees the shells' agents, but
not agents started on the mini's host outside docker. The spec accepts that.

### Capabilities

`caps` are short strings. `tailchan agent caps` probes them once per day per
machine and caches them in `~/.cache/tailchan/caps.json`:

- `os:<darwin|linux>`, `arch:<x86_64|arm64>`.
- `container`: `/.dockerenv` or `/run/.containerenv`.
- `desktop`: darwin with no `SSH_CONNECTION`, or linux with `WAYLAND_DISPLAY`
  or `DISPLAY`.
- `gh` (`gh auth status`), `docker` (`docker info`), `gpu` (`nvidia-smi`, or
  darwin arm64).
- `tool:<name>` for each of a fixed list found on PATH: git, bun, node,
  python3, cargo, go, xcodebuild, docker, kubectl, vercel, flyctl, tailscale.
- `harness:<id>` for each harness found.
- `human:<line>`, one per line of `~/.config/tailchan/caps`: what a person
  declares for a machine, such as "iphone-simulator", "prod-ssh" or "printer".

`offers` are an agent's own words: `tailchan agent offer "I can run the iOS
build and send screenshots"` appends to the card of the session it runs in. The
query is `tailchan agents --cap desktop --cap tool:xcodebuild`, which answers
"who can do X" for another agent. The `tailchan` skill documents it.

### canopy

- `server/registry.ts`, `RegistryHub` (`state.registry`), home backend only.
  It lists `/v1/agents?state=all` at start, follows the `agents` channel, and
  broadcasts a `registry` event carrying the changed cards. It answers
  `GET /api/registry`. Without a broker it answers 503 and the UI shows nothing
  registry-related. The settings event stays `agents`.
- `ui/src/registry.ts` is pure and tested:
  - `cardsFor(repoCard, cards)` joins cards to repo cards by `repo` (web url),
    the key `joinRepos` already uses, and falls back to cwd under a local
    checkout's path.
  - `stateWord`, `whereWord` ("kitty on ericmac", "canopy shell on mini",
    "container on mini").
  - `groupCards` by machine or by repo.
- **The registry tab of the agents view** shows every agent, grouped by machine
  or repo, live first, then the last day's ended and lost cards (folded). A row
  shows:
  - harness glyph, handle, repo and branch;
  - state (rust for waiting, dim for lost), model, how long;
  - where, cap chips, offers.
  Its actions:
  - **message**: `openChan("@handle")`.
  - **join**: for a canopy shell on a shown backend, `bringTerm` on
    `qual(backend, term)`.
  - **transcript**: a local file, opened with `openFile`.
  - **hand off**, from phase 5.
- On a repo card, an agent chip `✦ n` counts that repo's live agents anywhere.
  It is rust when one is waiting, and its tooltip lists them. The panel gets an
  `agents` section (in `DEFAULT_CLOSED`) with the same rows scoped to the repo.
- The feed gets an `agents` source: started, waiting, ended, lost.

## Phase 4: the human in the loop

### Asks in the broker

```ts
interface Ask {
  id: string; agent: string; handle: string; node: string;
  kind: "permission" | "question" | "guard";
  tool: string | null; title: string; detail: string;   // detail may hold the tool's input
  questions?: RunQuestion[];
  route: "remote" | "local"; waitUntil: number;
  state: "open" | "answered" | "expired" | "withdrawn" | "local";
  answer?: { behavior: "allow" | "deny"; message?: string;
             answers?: Record<string, string>; always?: boolean };
  answeredBy?: string; createdAt: number; answeredAt?: number;
}
```

- `POST /v1/asks` is called by the hook. The broker decides `route` and
  `waitUntil` (below) and returns the ask.
- `GET /v1/asks/:id/wait?timeout=` long-polls until the ask is answered,
  expired or withdrawn. The hook re-polls until `waitUntil`.
- `GET /v1/asks?state=open` lists open asks. `DELETE /v1/asks/:id` withdraws
  one: the hook was killed or the session ended. Only the owning node can
  withdraw.
- `POST /v1/asks/:id/answer` requires an **answer token**, `ANSWER_TOKENS` in
  the broker's env (`name:secret` pairs, so the log says which canopy
  answered). canopy has `CANOPY_TAILCHAN_ANSWER_TOKEN`. The CLI has no answer
  command, and the token is never in `~/.config/tailchan/env`. On the mini the
  token sits in canopy's compose env, which the shells service doesn't get. On
  the Mac, canopy and the agents run as the same user, so a yolo agent that
  goes looking can read it. The token stops accidents and casual
  prompt-injected attempts, not a determined agent with the user's own rights.
  The spec says so rather than claiming more.
- Asks are posted on channel `asks` (silent), and followers hear them there.
  The human gets a DM only when the route is remote and the human is away. It
  carries the handle, node, repo and a one-line title (the tool and its
  description, never its input), plus a link to
  `https://canopy.beric.ca/?view=agents&ask=<id>`. The broker's Telegram
  forwarding already only sends text previews. Asks are kept 7 days.

### Where an ask goes

The pure `askRoute({presence, watched, kind}, now)` decides, tested on both
sides:

- **watched** means the agent is in a canopy shell that a browser typed into in
  the last 2 minutes. The hook asks the local canopy for this with
  `GET $CANOPY_API/api/terms/watched?term=$CANOPY_TERM` and a 300 ms timeout.
  canopy sets `CANOPY_API` (its own loopback address and port) on its shells
  beside `CANOPY_TERM`. The hook reaches it in both deployments, since on the
  mini canopy shares the shells container's network. canopy's term socket stamps
  `lastInput` on every keystroke frame. An agent outside canopy is never
  watched.
- **presence** is the human's state, stored in the broker:
  - `here` is refreshed by canopy at most once a minute while any browser sends
    input.
  - It turns `away` after `AWAY_AFTER` (15 min) without a refresh.
  - A pinned `away` (a top-bar toggle, `PUT /v1/presence`, token required)
    holds until it is cleared.

| | route | wait |
|---|---|---|
| watched | local | 0: the hook returns no decision, and the terminal shows its prompt |
| here, not watched | remote | `HERE_WAIT`, 60 s, then local |
| away | remote | `AWAY_WAIT`, 30 min, then local. The hook's configured `timeout` is 1860 s. |

If spike 1 finds that Claude shows its prompt beside a waiting hook, the
watched rule stays anyway: an ask shown in two places at once is noise.
Expired asks never become allow. A broker that goes away mid-wait means no
decision. The terminal prompt is always the floor.

### The hooks

- **`PermissionRequest`** (claude and codex): posts the ask with `tool_name`,
  a description, and `tool_input` as `detail`, then waits. On an answer it
  prints the `hookSpecificOutput` decision: `allow`, with `updatedPermissions`
  from `always` (Claude only, a rule for that tool in the session), or `deny`
  with the message. On anything else it prints nothing.
- **`PreToolUse` matching `AskUserQuestion`** (Claude, if spike 2 holds): the
  same round trip with `kind: question`. On an answer it returns `allow` with
  `updatedInput.answers`. Codex questions from a TUI stay in the terminal;
  Codex runs in canopy get theirs through the app-server.
- **Idle** (`Notification` `idle_prompt`) is not an ask. It is the card's
  `waiting`, and it pings only when the human is away and the agent has
  `notifyIdle` (a card flag set by `tailchan agent notify on`, off by
  default).

### canopy's inbox

- `server/asks.ts`, `AskHub`, home backend only. It follows the `asks` channel
  and merges three sources into `InboxItem[]` (pure `mergeInbox`, tested): the
  broker's open asks, canopy's own runs waiting on a prompt, and flows at an
  `ask` gate. It broadcasts an `inbox` event.
  - `POST /api/inbox/answer` `{source, id, answer}` routes the answer. A run
    goes to `runner.answer`, a flow to `flows.resume`, and a broker ask to
    `/v1/asks/:id/answer` with the token.
  - `POST /api/presence` `{away: boolean}` sets presence.
  - canopy's term socket calls `presenceBeat()`, which is debounced.
- **The top bar's `? n` chip** is rust with any open item. Its popover lists
  them oldest first: repo, handle, where, and how long left before the ask
  falls back to the terminal. It reuses `RunSheet`'s permission and question
  forms (`allow` / `allow always` / `deny`, and the option lists). A phone gets
  the bottom sheet. `?view=agents&ask=` opens the popover on one item. The chip
  holds the away toggle.
- An answered or expired item leaves with a feed line saying who answered it
  and where: "allowed in canopy", "answered at the terminal" (the hook
  withdraws when the terminal prompt wins), or "expired to the terminal".

## Phase 5: agent to agent, guards, hand-off

- **Delivery.** A message to an agent is only useful if the agent sees it.
  - On `UserPromptSubmit`, the hook peeks at the handle's inbox and adds any
    unread DMs, and at most 3 group lines, as `additionalContext`, then
    advances the cursor.
  - On `Stop`, when an unread **DM** is waiting and `stop_hook_active` is
    false, the hook blocks the stop with the DM as the reason, so the agent
    handles it before it idles.
  - Idle wake, if spike 4 holds: an `asyncRewake` watcher started at
    `SessionStart` blocks on the handle's DMs and exits 2 with the message.
  - Codex gets the first two, since it has both events.
- **Groups.** `SessionStart` subscribes the handle to `repo.<owner>-<name>`, so
  every agent in a repo, on any machine, shares a channel. The human reaches
  all of them from canopy's tailchan popover, and they coordinate there ("I'm
  on the migration; leave `db/` alone"). Any other group is a plain
  `tailchan sub`. Group lines are never `Stop`-injected, since that would be
  noise.
- **Loop guard.** The broker refuses (429) more than 20 DMs a minute from one
  non-human handle to other non-human handles. A message carries
  `meta.reply_to`, and the hook never injects a message whose chain back to a
  human is longer than 6 hops.
- **Guards**, for yolo agents. The broker keeps a list of rules in Claude's
  rule syntax (`Bash(git push --force:*)`, `Bash(rm -rf:*)`,
  `Bash(bun run redeploy:*)`), edited in the agents view's routing tab. The
  `PreToolUse` hook caches the list for 5 minutes. A match raises a `guard` ask
  whatever the permission mode, and the ask is routed as above. A local route
  returns `permissionDecision: "ask"` if the harness honours it under bypass
  (a spike when this phase starts), and otherwise waits remote with no local
  fallback, then denies with "held for Eric; ask again later".
- **Hand-off.** "Switch to codex" (or back) on a registry row or a shell tab
  opens a new shell in the same repo with the other harness. Its first message
  is: "Continue the work of the <harness> session whose transcript is
  <path>. Read its last part first." The path is the card's `transcript` when
  the target shell runs where the file is. Otherwise, since the path can't
  reach the other machine, the transcript's last 200 lines go as a blob, and
  the message names the blob.

## Files

- **canopy core:**
  - New: `harness.ts`, `route.ts`, `codexrun.ts`, `agentscan.ts`.
  - Changed: `agent.ts`, `types.ts` (`Harness`, `AgentRole`, `AgentPick`,
    `RepoAgent`, `AgentCard`, `Ask`, `InboxItem`, `Run.harness`,
    `Run.session`, `RunResult.tokens`), `openers.ts`, `herdr.ts`,
    `sessions.ts` (plus `codexSessions`), `keep.ts`, `runner.ts` (the
    `RunDriver` split), `actions.ts`, `suggest.ts`, `flow.ts`, `workflow.ts`
    (`agent:` frontmatter), `store.ts`, `ports.ts` (the shared proc walk),
    `tailchan.ts`.
- **canopy server:**
  - New: `registry.ts`, `asks.ts`.
  - `index.ts` changes: the agent routes, `start=agent`, the `CANOPY_*` env on
    shells and runs, `/api/terms/watched`, `/api/presence`, `/api/inbox*`,
    `/api/registry`, the scan timer.
- **canopy ui:**
  - New: `registry.ts`, `inbox.ts` (pure, tested), `components/AgentsView.tsx`
    (routing and registry tabs), `components/Inbox.tsx`.
  - Changed: `RunSheet.tsx` (`AgentForm` with a harness, the prompt forms
    exported for reuse), `RepoMenu.tsx`, `AgentButtons.tsx`, `guided.ts`,
    `KeptShells.tsx`, `TopBar.tsx`, `RepoGrid.tsx` (the chip), `Dock.tsx` (the
    section), `feed.ts`, `store.ts`, `api.ts`, `qualify.ts`.
- **Broker:** `server.ts` (the tables, routes, presence, answer tokens, the
  sweep), plus a new `server.test.ts`.
- **CLI:** `tailchan agent hook|install|doctor|watch|caps|offer|notify` and
  `tailchan agents`.
- **Docs:** the homelab `tailchan` skill documents the agent commands. This
  repo's `CLAUDE.md` gets one bullet per phase.

## Testing

- **Pure modules:** each gets its own test file. The harness argv table,
  `normalizeAgent` per harness, `resolveAgent` over every layer and a missing
  profile, the scan parsers (`/proc` fixtures and `ps`/`lsof` text), the card
  join, `askRoute`, `mergeInbox`, and the hook-output builders. The hook is
  bash, so its output builders are tested through the CLI against fixture
  stdin in a `bun test` that shells out.
- **`CodexDriver`:** runs against a stand-in app-server (a Bun script speaking
  the subset of JSON-RPC used, answering from a script of events). One opt-in
  test, under `CANOPY_CODEX_IT=1`, runs a real codex in a scratch repo.
- **The broker:** `server.test.ts` with an injected WhoIs. It covers card
  ownership across nodes, the scan dedupe by namespace, `lost` after missed
  beats, the ask wait and answer paths, a refused answer without a token, and
  the 429.
- **canopy server:** tests against a stand-in broker, in the pattern of
  `server/tailchan.test.ts`: the registry follow, the inbox merge across all
  three sources, answer routing, and `watched`.
- **End to end,** in a real browser on the built UI:
  - A Claude started by hand in kitty on the Mac shows in the registry.
  - Its permission prompt shows in the `? n` chip on the phone, and allowing
    it there runs the tool.
  - The same prompt in a canopy shell being typed into goes to the terminal.

## Risks

- `codex app-server` is marked experimental, and codex moves quickly (0.158
  dropped `mcp-server` and `--full-auto`). The driver reads the version and
  warns, and the stand-in server pins the protocol subset canopy uses, so a
  change shows up as a failing test and not a silent stall.
- Hook latency on every event: all but `PermissionRequest`, `Stop` and the
  question hook are async, and those three cost one local curl with a 2 s cap
  when there is nothing to do.
- `tool_input` in the broker's database can hold secrets (a command line with a
  token). Asks are kept 7 days and only shown in canopy. Telegram gets titles
  only.
- The answer token's limit is stated in phase 4, not hidden.

## Out of scope

Harnesses beyond Claude Code and Codex (the table leaves room for Gemini CLI or
opencode); agents on machines off the tailnet; ending or steering an agent
canopy didn't start; cost accounting across agents; the registry as an MCP
server; picking an agent automatically by load or caps; Telegram inline answer
buttons (the link to canopy covers the phone); a dev-cycle task that is an
agent.

## Amendments

### 1. Phase 0, measured (2026-09-30, Claude Code 2.1.286, codex 0.158, in the shells container)

- **Claude's permission dialog does not wait for the hook.** It is drawn at
  once, beside a `PermissionRequest` hook that is still waiting, and the first
  answer wins. A late hook decision closes an open dialog. When the terminal
  answers first, the hook's later answer is ignored and the hook is not killed.
  So a remote ask never delays anyone at a Claude terminal, and the hook needs
  another way to learn that the terminal answered: the next hook event from the
  same session (`PreToolUse`, `PostToolUse`, `Stop`, `UserPromptSubmit`,
  `SessionEnd`) withdraws that session's open ask with `why: terminal`.
  `PermissionRequest` stdin has no `tool_use_id`. The `watched` rule stays for
  the reason phase 4 gives.
- **Codex runs the hook first.** Its approval prompt shows only after a
  `PermissionRequest` hook returns no decision, so for Codex a remote wait
  does hold the terminal prompt. The `watched` rule matters more there, and
  while the human is `here` a Codex ask waits `HERE_WAIT` at most.
- **`AskUserQuestion` from `PreToolUse` works in an interactive session.** An
  `allow` with `updatedInput.answers` (keys are the full question text) skips
  the picker. Free text works too.
- **The watcher works.** A `setsid nohup` child started from `SessionStart`
  (sync or async) outlives the hook and is reparented to pid 1. Claude hooks
  get `$CLAUDE_PID`, the harness itself, so no ancestry walk is needed for
  Claude. On Linux Claude's comm is `claude`, not a version string. Hooks
  inherit `TAILCHAN_AS` and `TMUX_PANE` from the launching shell.
- **`asyncRewake` wakes an idle Claude,** and it does so best on `Stop`, where
  it re-arms after every turn, including the one it woke. The woken turn's
  `Stop` arrives with `stop_hook_active: true`, and the waiter must not skip
  on it. The wording matters: a bare imperative was refused as hook feedback,
  while "tailchan: new DM for this session from @peer (delivered by the
  tailchan hook the user installed): …" was acted on. Phase 5's idle wake is a
  second `Stop` entry with `asyncRewake`, one waiter per session.
- **Codex user hooks need trust.** Without it Codex shows "Hooks need review"
  and runs none. Trust is a hash of the hook's definition in `config.toml`, so
  the installer keeps each command string fixed, and `tailchan agent doctor`
  says to trust them once in `/hooks`. Codex's `SessionStart` fires lazily,
  with the first prompt.
- **Codex environment.** The user's `shell_environment_policy.inherit = "core"`
  keeps `TAILCHAN_AS` and `CANOPY_*` from the commands Codex runs, though its
  hooks see them. canopy's codex line adds
  `-c 'shell_environment_policy.set.<VAR>="…"'` for each. A plain `codex`
  launch starts a shared daemon, so canopy always passes `--no-daemon`.
- **Codex in tmux** reads `pane_current_command` = `node` (a bun install) and a
  pane title of the folder, then `<thread> | <folder>`. `agentIn` now also
  looks for a `/codex` argv under the pane's pid.
- **herdr** takes `--kind codex`.

### 2. Phase 2, measured against the real app-server

- Item types are camelCase (`agentMessage`, `commandExecution`, `fileChange`,
  `mcpToolCall`, `webSearch`). A command arrives wrapped as
  `/bin/sh -lc '<script>'`.
- The version comes from `initialize`'s `userAgent`, so no `codex --version`
  is spawned.
- `acceptForSession` is not always offered. "Allow all" falls back to
  `accept`, and canopy lets the later ones through itself.
- File-change approvals carry no paths; the `fileChange` item just before one
  does.
- Codex asks questions outside plan mode only with
  `features.default_mode_request_user_input`, which the driver sets on its
  own thread.
- Codex's sandbox (bwrap) cannot make a user namespace in the shells
  container. Every `workspace-write` command fails there and Codex asks to rerun
  it outside the sandbox, which is still an approval per command and so still
  a gate for a job's rules.
- The driver takes prompts back through `ctx.ask()`'s promise instead of a
  driver `answer()`. The queue, "allow all", stop's deny-all and the notes stay
  in one shared `RunCtx`.

### 3. Phase 3, canopy's side, as built

- `ui/src/registry.ts` was already the multi-backend registry, so the pure
  card module is `ui/src/agentcards.ts`; the components are
  `components/Registry.tsx`.
- A Mac's `comm` is the executable's path and may hold spaces, and only the
  last `ps` column can, so the scan asks `ps` twice: `pid=,ppid=,lstart=,args=`
  (with `-ww`, in the C locale) and `pid=,comm=`.
- A card joins a repo card on any of a checkout's remotes and its link, not
  only the first remote that maps, since a hook takes origin first.
- The broker posts its own `lost` transitions off its tick, so the follow
  re-lists only on each (re)connect and every 5 minutes, which is what
  catches a card the week's sweep deleted (sent as `gone`).
- Every backend with a broker both scans and follows; the page reads only
  its home backend's registry, as it does tailchan.
- `CANOPY_API` is the server on the machine's loopback
  (`http://127.0.0.1:<port>`), set on every new local shell with
  `CANOPY_TERM`, `CANOPY_BACKEND` and `CANOPY_REPO`.
- The transcript action opens a file only for a card from a canopy shell or
  run on the home backend, through a home checkout, since canopy's openers
  take a repo and a path in it.
