# Kit: agent plugins (FR-064)

2026-11-11. Asked as "add canopy plugins(full crud, disable, enable,
servers) like memory s, templates, connectors etc". Eric skipped the
questions, so the reading below is Claude's call.

## What it is

The kit already keeps skills and MCP servers in step on every machine. This
adds the third thing an agent loads: plugins. Claude Code and Codex both have
plugin marketplaces now, and Eric's machines carry different sets (the Mac
had 18 claude plugins and 40 codex ones on 2026-11-11, gpd 7, the mini 1).
The view answers "what does each machine's agent load, and what does it
bring" and lets him change it from any device, phone included.

The reading of the request:

- Full CRUD: install (create), list and read, update, uninstall (delete).
- Enable and disable: claude's per-plugin switch.
- Servers: both the MCP servers a plugin brings, shown on its row and its
  sheet, and the machines (servers) it is on, as the matrix's columns.
- "memory s, templates, connectors": the catalog search, with quick chips
  for memory, templates, connectors, MCP servers, review and design.
- Marketplaces: add, update, remove, since a plugin cannot be installed
  without its marketplace.

## Goals

- One matrix: a row per plugin, a column per machine and agent.
- Every op on any machine from the page and from `canopy plugins`.
- No change ever made in a way the agent would not make itself: through its
  CLI, or for codex's switch the same `config.toml` line codex writes.
- dotclaude's shared `settings.json` stays committable from one machine.

## Non-goals

- Writing plugin files by hand: `settings.json`, `installed_plugins.json`,
  the plugin cache, `config.toml`. The one exception is codex's switch
  (below), added the same day at Eric's "do Recommendations".
- Codex update. Its CLI has none; a marketplace upgrade brings new versions.
- Project-scope plugins (`--scope project|local`). Everything is user scope.
- Authoring plugins or marketplaces.

## Anti-goals

- An op on the mini or gpd that leaves an unstaged edit to a tracked
  dotclaude file. On the mini that stopped `dotclaude-pull` for three weeks.
- A marketplace's declared command running without a person reading it.

## How it works

### Reading

`kit.json` gets `plugins: ["claude", "codex"]`, the agents to manage. A
machine gets plugins for each listed agent its targets name
(`pluginAgentsOn`). Each kit scan runs one `sh` per machine
(`PLUGIN_SCAN_SCRIPT`) that finds each CLI (`KIT_CLAUDE`/`KIT_CODEX`, then
`command -v`, `~/.local/bin`, a login shell: gpd's claude is a mise shim),
and prints, base64-wrapped:

- `claude plugin list --json`, `claude plugin marketplace list --json`;
- `codex plugin list --json`, `codex plugin marketplace list --json`;
- `~/.claude/settings.json`;
- `git ls-files -t settings.json` in `~/.claude` and whether it differs from
  HEAD.

`H` means dotclaude tracks `settings.json` (the Mac, gpd, wsl): the machine is
`shared`. `S` (the mini's skip-worktree) or no dotclaude means the file is the
machine's own.

A cell is on, off, wanted (turned on by `settings.json`, not installed),
broken (claude reports load errors), none, or noagent (the machine is away or
the agent is not there).

### Changing

`POST /api/kit/plugins` (admin) with `{machine, agent, op, id | source | name,
accept?}`. One op at a time per machine, then that machine is rescanned.

| op | claude | codex |
|---|---|---|
| install | `plugin install id --scope user --json` | `plugin add id --json` |
| uninstall | `plugin uninstall id --scope user --json` | `plugin remove id --json` |
| update | `plugin update id --scope user --json` | refused |
| enable, disable | `plugin enable|disable id --scope user --json` | the `enabled` line in `config.toml` (below) |
| market-add | `plugin marketplace add src --scope user --json` | `plugin marketplace add src --json` |
| market-remove | `plugin marketplace remove name --scope user --json` | `plugin marketplace remove name --json` |
| market-update | `plugin marketplace update name --json` | `plugin marketplace upgrade name --json` |

claude prints one JSON object per op. `outcome: "failed"` with
`alreadyInGoalState` counts as done. One with `shownCommand {command, sha256}`
means the marketplace declares a command: the page shows it and "accept and
run" resends the op with `--accept-command <sha256>`.

### Shared settings.json

On a shared machine that does not commit dotclaude, an op that would change
`settings.json` is refused (409). Install, uninstall, enable, disable and both
marketplace add and remove write it. Update does not. Two cases write the
same bytes and go through: installing a plugin `settings.json` already turns
on, and adding a marketplace with the same source it already declares. That
is how gpd catches up on what the Mac turned on.

The page asks the same `refusal` before it draws a button, and offers the op
on the committing machine instead ("turn off on mac"). kit.json marks that
machine `machines.mac.commits: true`. With none marked, the refusal says to
mark one.

### Codex's switch

Codex's CLI is `codex plugin add|remove|list|marketplace`, with no switch.
Its `config.toml` has one: for each local plugin it installs, codex writes a
`[plugins."id"]` table with `enabled = true`, and `codex plugin list` reports
`enabled: false` once that line says false (checked on 2026-11-11 in a
scratch `CODEX_HOME`). So enable and disable for codex are
`CODEX_SWITCH_SCRIPT` (`core/pluginscan.ts`), run through `onHost` like the
scan, on `${CODEX_HOME:-$HOME/.codex}/config.toml`:

- `set id true|false` rewrites the first `enabled` line inside that one
  table (the header matched as a string, the table ending at the next `[`)
  into a copy made with `cp -p`, so the mode (600: the file can hold
  tokens) stays. It swaps the copy in with `mv` only when the file's
  checksum has not moved since it was read, and keeps the old bytes as
  `config.toml.canopy-before`. A link is refused rather than replaced.
- The server then runs `codex plugin list --json`. When the plugin reads
  the new state, `keep` drops the copy of before. When it does not, `undo`
  puts the old bytes back, unless something else wrote the file since.
- It never adds a table. A second table for the same plugin makes codex
  refuse its whole config ("duplicate key"), and every local plugin codex
  lists has one already.

A plugin the ChatGPT account brings (`@openai-curated-remote`, whose list
`source` is `remote`) ignores a table: `[plugins."x@openai-curated-remote"]
enabled = false` left it listed on. Those cells offer remove only, and
`refusal` says why. Codex's config is each machine's own, so a codex op is
never moved to the committing machine.

### Committing settings.json

The committing machine's line says "settings.json changed, not committed"
and offers "commit settings.json…". `GET /api/kit/plugins/commit?machine`
(operate) reads `~/.claude` there (`SETTINGS_READ_SCRIPT`): the branch,
`git hash-object settings.json`, and the file at HEAD and in the working
tree. `settingsChange` names what differs: plugins turned on, turned off or
dropped, marketplaces added, removed or with a new source, and other
top-level keys. It names keys only, never a value, since `env` can hold
secrets. `commitMessage` writes the message: one change in the subject, or
a count there and a list in the body.

`POST /api/kit/plugins/commit {machine, sha}` (admin) reads again, refuses
(409) when the bytes no longer hash to `sha`, and runs
`SETTINGS_COMMIT_SCRIPT`:

- `git commit -m <message> -- settings.json`, which commits that path
  alone and leaves anything else staged as it was;
- `git push`, with no terminal and ssh in batch mode, so a missing key
  fails at once with git's words instead of waiting on a prompt;
- a push turned away is rebased onto the remote (`pull --rebase
  --no-autostash`) and sent again, but only when no other tracked file is
  changed. Otherwise the commit stays local, the answer is `committed` with
  git's reason, and the checkout is never left mid-rebase. The scan counts
  the commits the upstream lacks, and the machine's line says "1 dotclaude
  commit not pushed" until a push from a terminal sends it.

The other machines on the shared file catch up at their next pull.
`canopy plugins commit [--machine M] [--dry-run]` does the same from a
terminal.

### The mini's paths

canopy on the mini runs as `/home/bun`, with the host's `~/.claude` mounted
at both `/home/bun/.claude` and `/home/eric/.claude`. claude records every
marketplace's `installLocation` and every plugin's `installPath` under its own
home and refuses one outside it: on 2026-11-11 a marketplace update from the
container failed with "corrupted installLocation", because the host's claude
had written `/home/eric/...`, and an install from the container would have
written `/home/bun/...` paths the host's claude could not open. So on its own
machine, when `CANOPY_HOST_HOME` is not its home, the backend runs `claude
plugin` with `HOME` at the host's home (the scan through `KIT_CLAUDE_HOME`),
and compose mounts the host's `.claude.json` at its host path too. codex
keeps the container's home: only `~/.codex` is mounted, at `/home/bun`.

### Catalog and details

`GET /api/kit/plugins/catalog` runs `plugin list --json --available`, keeps it
10 minutes per machine and agent (claude's runs to megabytes), and searches it
on the server: every word must match the id, name, marketplace or
description, most installed first. `fresh=1` reads again; any op on the
machine drops its copy. `GET /api/kit/plugins/details` is `claude plugin
details id` with the colours stripped: skills, agents, hooks, MCP servers and
what the plugin costs a session.

## Calls Claude made

- User scope only, since the kit is about a person's machines.
- Codex gets install and remove through its CLI and its switch through
  `config.toml`; its update is refused with the reason.
- A remove asks first. Install, update and the switch run on the click.
- A marketplace counts as added on a machine when the agent lists it or a
  plugin from it is installed there: claude installs from `synced` and codex
  from `openai-curated-remote` without listing either.
- A marketplace whose `settings.json` source is a folder (`/Users/...`) is
  not offered on other machines; the page says it is another machine's
  folder.
- `e` is the view's chord (`g` then `e`); `p` was taken by ports.
