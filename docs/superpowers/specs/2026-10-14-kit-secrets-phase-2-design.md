# Kit and secrets, phase 2: MCP servers, their secrets, and rotation's reach

Phase 2 of both `2026-10-14-kit-design.md` and `2026-10-14-secrets-design.md`.
Those specs hold the design; this file records what phase 2 builds, the
four calls Eric made on 2026-10-14 that change or settle them, and the
details they left open. Where this file and the two specs disagree, this
file wins and the specs carry a pointer here.

## Why

Phase 1 put every skill on every machine and agent and moved 140 secrets
into the store. MCP servers are still hand-made per machine: 16 in the
Mac's `~/.claude.json`, 4 in its Codex `config.toml`, one (`executor`) on
the mini, and `github` reads its token through `bash -c "gh auth token"`.
Phase 2 makes `kit.json` the one place servers are defined, gives a server
its secrets without any agent config file holding a value, and shows a
rotation's full reach before it happens.

Success: the Mac's 16 Claude servers and its Codex `wiki-memory` and `executor` are kit-managed
and unchanged in behaviour; `github` gets its token from the store through
`canopy-mcp-env`; the mini's servers come from the same manifest; no value
appears in `~/.claude.json`, `config.toml`, a route, a log line or the
transcript; rotating `gh_token` lists its sinks, the server and the
machines before the write.

## Calls made on 2026-10-14

1. **Full scope in one plan.** Projection, `${secret:}` through allowlists,
   the wrapper and its env sinks, headers, and rotation's impact list.
2. **MCP adopt moves into phase 2.** Every server the kit would manage
   already exists as a hand-made (foreign) entry, so without adopt phase 2
   changes nothing on the Mac. Adopting skills stays in phase 3.
3. **Claude's servers are written with the `claude mcp` CLI**, not by
   parsing `~/.claude.json`. Claude Code rewrites that file itself many
   times a session, and on the mini it is a single-file bind mount, where a
   temp-then-rename write fails.
4. **One gated allowance per server**, covering every machine, and it
   creates the server's env sinks in the same step.
5. **Rotation lists, phase 3 restarts.** Rotate shows sinks, servers and
   stacks before the write; the stack restart buttons stay in phase 3 with
   the forced-command key.

## The manifest's `mcp` block

As in the kit spec: `command` and `args`, or `url` and optional `headers`;
`env`; `agents` and `machines` filters (default every agent with an `mcp`
target, every machine). A value in `env` or `headers` is a literal, an
`${env:NAME}` or a `${secret:NAME}`. Phase 2 fills the block in dotclaude's
`kit.json` with today's servers: the 12 artcraft servers and `excalidraw`
as `machines: ["mac"]`, `wiki-memory`, `executor` and `github` for every
machine, and Codex's own `node_repl` and `computer-use` left foreign.

**The definition hash** is SHA-256 over the canonical JSON (sorted keys, no
spaces) of `{command, args, url, env: <sorted env names>, headers: <sorted
header names>}` exactly as the manifest writes them, before `~` or any
reference resolves. Literal values and the filters are left out, so a
moved machine filter does not void an allowance, and the same hash holds on
every machine. Any change to the command, args, url or the set of names
voids it.

## Writing the agents' config

**Claude.** Apply runs `claude mcp add-json --scope user <name> <json>` and
`claude mcp remove --scope user <name>`, with the `claude` path the scan
found (`command -v claude`, then `~/.local/bin/claude`, and only then
`command -v claude` in a login shell, which can be slow to start),
since gpd's non-interactive PATH lacks it. The scan still reads
`~/.claude.json` directly to see what is there. Ownership stays in
`~/.claude/.canopy-kit-mcp.json`. The plan's first task checks that
`add-json` keeps working through the mini's bind mount (Claude itself
writes that file there every session, so it is expected to).

**Codex.** `config.toml` keeps the kit spec's parse, change and write, with
the `# canopy-kit: managed` marker above each managed table. The write goes
in place (truncate and write, after checking the mtime has not moved since
the read) instead of temp-then-rename, because `~/.codex` is a bind mount
on the mini. Every byte outside managed tables stays as it was; a test
holds that.

**A server with secrets** is written as `command:
~/.claude/bin/canopy-mcp-env`, `args: [<server>, "--", <command>,
...<args>]`, with only the literal and `${env:}` entries in its `env`.
`${env:}` resolves from the canopy process's environment on that machine,
as in the kit spec.

**`canopy-mcp-env`** (POSIX sh, tracked in dotclaude at `bin/`, so the
mini's sparse checkout and gpd's pull bring it): reads
`~/.claude/mcp-env/<server>.env` line by line with `read -r`, takes the
dialect the dotenv sink writer emits, and exports each pair without ever
evaluating it (no `source`, no `eval`), then `exec`s the rest of its
arguments. A missing or unreadable file exits 1 with one line on stderr
naming the file, never a value. `--headers <server>` prints
`~/.claude/mcp-env/<server>.headers.json` as Claude's `headersHelper`
expects. A test runs it over values holding `$`, quotes, spaces, `=` and
backslashes and checks they arrive unchanged.

**Http servers with secret headers** get `headersHelper: "canopy-mcp-env
--headers <server>"` on Claude. On Codex they stay out and read "not
supported for codex", as the secrets spec says. No server in today's
manifest has secret headers; the support is there for the first one.

## Allowing a server its secrets

The kit view's cell for a server with `${secret:}` references reads "not
allowed" until a human allows it. "Allow" opens a sheet listing the server's
definition, its hash, the secrets it names and the machines it is placed
on, and sends one gated `mcp-allow` act to the secrets service with
`{server, hash, secrets, machines}`. In one signed commit the service:

- adds `mcp:<server>#<hash>` to each named secret's `allow` and removes any
  older `mcp:<server>#…` entry there;
- creates or updates, per machine, the dotenv sink `mcp-<server>-<machine>`
  at `~/.claude/mcp-env/<server>.env` (and the JSON sink
  `mcp-<server>-<machine>-headers` for headers), mapping each env name to
  its secret, which also seals those values to that machine through the
  phase 1 recipient rule.

`mcp-revoke {server}` (gated) undoes both. Deleting a secret is still
refused while an allowance uses it.

The kit reads allowances from the store's plaintext metadata (`allow`
needs no key), so it can tell "allowed", "not allowed" and "allowed for an
older definition" without a session. A server is written only when its
allowance matches the current hash and every one of its secrets has a sink
in step on that machine; otherwise it stays out of the agent's config and
the cell says which.

On gpd a server with secrets reads "phase 3", since the Mac writing gpd's
sinks over ssh is secrets phase 3. gpd's servers without secrets project
over ssh like its skills.

Sink paths stay absolute, as in phase 1: `mcp-allow` stores each machine's
own path, `/Users/ericbaruch/.claude/mcp-env/<server>.env` on the Mac and
the host path `/home/eric/.claude/mcp-env/<server>.env` on the mini, taking
each machine's home from its backend. The mini's `secrets` service gets a
bind mount of `${HOST_HOME}/.claude/mcp-env` at that same host path, and
the folder joins `CANOPY_SECRETS_SINK_ROOTS`, so the `startsWith` root check
passes unchanged. The Mac's writer has no root list, only the phase 1 rule
that a sink inside a scanned repo must be git-ignored there. `~/.claude` is
the dotclaude repo, so whether or not a backend scans it, dotclaude's
`.gitignore` gets `mcp-env/` first: the plan commits that and has every
machine pull it before the first `mcp-allow`. Each writer then adds
`~/.claude` to the roots `repoRefusal` checks, so a machine that has not
pulled the ignore line refuses the write and its sink reads the error. The sink writer creates the
folder 0700.

## Adopt (MCP only)

A server that exists in an agent's config but not in the ownership list is
foreign, as in phase 1. When the manifest defines a server of the same
name, the cell reads "foreign, kit has one" and offers "adopt". Adopt shows
the current entry next to what the kit would write, then on confirm records
the old entry in the ownership file (`adoptedFrom`, so one "put back"
restores it) and writes the kit's version. "Adopt all matching" in a column
header does every such server on that machine after one confirm. Neither
runs as part of "apply all", which still never touches a foreign entry.

Adopt asks for a confirm, not a passkey (Eric's call, 2026-10-14). The
passkey gate guards values,
and a server with secrets still gets nothing until its allowance passes the
gate. An agent that edits `kit.json` and adopts gains only the ability to
start a command, which it already has.

## Rotation's reach

`impactOf(file, name)` (pure, in `src/core/secretfile.ts` or a sibling)
returns, for one secret: every sink that maps it, by machine, with path and
keys; every MCP server it is allowed for, with the machines holding that
server's env sink; and the distinct `restart` stacks of those sinks.

- **Rotate** shows that list before the confirm. MCP servers carry the note
  that new agent sessions pick up the value and running ones keep the old
  one. Each stack shows its `docker compose ... up -d` line with a copy
  button; the restart button arrives in phase 3.
- After the write, the same list shows each sink's state from the next
  pass (`same`, `waiting` for a locked Mac, or the error).
- **Delete**'s refusal lists the same reach, so the human sees what still
  uses the secret.
- The secret sheet's "used by" uses `impactOf` too.

## Components

- `src/core/kit.ts`: parse and check the `mcp` block, `mcpHash`, MCP wants
  per machine and target, plan actions `mcp-set`, `mcp-remove`,
  `mcp-adopt`, `mcp-restore`, and the cell states `not-allowed`,
  `stale-allowance`, `no-sink`, `adoptable`, `unsupported`, `phase-3`.
- `src/core/kitscan.ts`: the `claude` path, the MCP entries of each file,
  the ownership file's MCP list.
- `src/core/kitmcp.ts` (new): the Claude CLI writer and the Codex TOML
  splice, kept out of `kitapply.ts`, which calls them.
- `src/core/secretfile.ts` and `src/secrets/service.ts`: `mcp-allow`,
  `mcp-revoke`, `impactOf`.
- `src/server/kit.ts`: `POST /api/kit/adopt` and `/restore`; allow and
  revoke go to the secrets routes like every gated act.
- UI: the kit matrix's server rows and the allow sheet (`Kit.tsx`,
  `ui/src/kit.ts`); the rotate preview and reach list (`Secrets.tsx`,
  `ui/src/secrets.ts`).
- dotclaude: `bin/canopy-mcp-env`, `.gitignore`, the `mcp` block in
  `kit.json`.
- `docker-compose.yml`: the `mcp-env` mount and sink root.

## Errors

- `claude mcp` exits non-zero: that action fails with its stderr (values
  never pass through it), the rest of the plan goes on.
- `config.toml` does not parse, or its mtime moved: the write is refused
  and the cell says why.
- An env sink not yet written (Mac locked): the server stays out and reads
  "waiting for unlock".
- The wrapper's file is missing at launch: the server fails to start with
  the file's name on stderr; the next kit scan reports it.

## Testing

- `mcpHash` is stable across key order and machines, and changes with each
  hashed field.
- Planning: allowed, not allowed, stale allowance, missing sink, gpd,
  Codex http with secrets, adopt and restore.
- The Codex splice keeps every byte outside managed tables; the Claude
  writer runs against a fake `claude` that records its argv.
- `canopy-mcp-env` passes awkward values through unchanged and never
  evaluates them.
- `mcp-allow` and `mcp-revoke` commit allowlist and sinks together and
  refuse without a session.
- `impactOf` over sinks, servers and stacks.
- The leak test grows to cover the kit routes, the written `~/.claude.json`
  and `config.toml`, and the apply log.
- A live check on the Mac and the mini: `github` adopted, allowed, started
  by a fresh Claude session, `gh` calls through it working, and the token
  absent from both config files.

## Settled while planning

The plan (`docs/superpowers/plans/2026-10-14-kit-secrets-phase-2.md`) read
the code and found these, which this file now follows:

- github's secret is `gh_token`, not `github-token`.
- `mcp-allow` carries the server's definition, env and header names and
  each machine's home, so the service recomputes the hash itself and
  builds each sink's absolute path.
- The mini's canopy scans as `/home/bun`, but server commands and sink
  paths use the host home (`CANOPY_HOST_HOME`), and the `canopy` and
  `shells` services also mount `~/.claude` at its host path.
- The `secrets` service cannot run git, so canopy's relay runs `git
  check-ignore` on `mcp-env/<server>.env` in dotclaude before it forwards
  `mcp-allow`, and answers 409 when the file is not ignored. dotclaude
  already ignores `mcp-env/`; it gains a line for `.canopy-kit-mcp.json`,
  which holds an adopted entry's old definition.
- A server may carry per-agent `options` (executor's `headersHelper` and
  `bearer_token_env_var`, wiki-memory's Codex timeouts), allowed only on
  servers without secrets, so the hash stays as defined above.
- Adopting a server with secrets is refused until it is allowed, so a
  working hand-made entry is never swapped for one that stays out.
- A server already written stays while its env sink reads "waiting"
  (a locked Mac after a restart), instead of being removed and added back.
- Revoke's env files are pruned by each writer's next pass.
- "No value in an agent config file" holds for kit-managed entries; a
  foreign entry is left as it is, and an adopt preview masks its values.

## Out of scope

Stack restarts, gpd's sinks, skill adopt, tools, OpenClaw, and per-cell
apply buttons for skills stay in phase 3.
