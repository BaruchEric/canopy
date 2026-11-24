# Google Antigravity

Canopy runs Google Antigravity through the `agy` CLI installed on a backend,
with that machine's own Google login. Pick **antigravity** as the harness in
an agent profile, a role or a repo's agent settings. Shells, chats, jobs and
ordinary workflow steps take it. Canopy stores no Google key and no login.

A loadout a start names replaces a route's harness, model and effort
(FR-065). A default loadout from kit.json (FR-069) gives way to a narrower
route (FR-083): a repo routed to Antigravity runs agy on the mini even though
the mini's machine default is `feature`, which is Claude Code's. kit.json's
loadouts are all Claude Code's, so naming one of them at a start still runs
Claude Code.

## Setup on a backend

1. Install the CLI. Google's installer is
   `curl -fsSL https://antigravity.google/cli/install.sh | bash`; it puts the
   binary at `~/.local/bin/agy` and then runs `agy install`, which edits your
   shell's rc files. To skip that, download the binary from the manifest the
   script reads and copy it to `~/.local/bin/agy` yourself. `agy --version`
   checks it. The CLI updates itself in the background.
2. Sign in once in a terminal on that machine: run `agy` and pick "Log in with
   Google" (a browser opens; over ssh it prints a URL and takes the code
   back), or run `agy acp --login`. The login lives in the OS keyring.
   The first time agy's own screen opens on a machine, it asks for a color
   scheme and then for its terms of service, with the box that lets Google
   collect your interactions already ticked. Untick it if you want to. A run
   never shows these screens, but a shell waits on them until someone
   answers.
3. Reload canopy's page. The harness picker greys Antigravity out on a
   backend where canopy cannot find `agy` on its PATH or in your login shell.

On the mini and De Soto the image installs agy and mounts the host's
`~/.gemini` into the shells and `canopy` containers (docs/deploy.md, step 3).
The containers have no keyring, so agy keeps its login in the file
`~/.gemini/antigravity-cli/antigravity-oauth-token`; one `agy acp --login` in
a canopy shell there lasts across rebuilds.

Without a Google login, agy also takes a Gemini API key: set
`"modelProvider": "gemini"` in `~/.gemini/antigravity-cli/settings.json` and
put `GEMINI_API_KEY` in the environment canopy's server starts agy with. The
key alone does nothing.

## Models and effort

Leave the model at `default` to use agy's own choice. `agy models` lists what
your account offers, as ids with a thinking level in them, such as
`gemini-4-neon-high`. Either form works in the model field: the id from that
list, or the bare model (`gemini-4-neon`) with an effort. Effort is low,
medium, high, xhigh or max, and each model offers only some of them
(`gemini-3.1-pro` takes low and high). A run asks agy for the model and
thinking level at the start of its session and fails in words, naming what
agy offers, when one is not on offer. A shell passes them as `--model` and
`--effort`.

The provider field is for Claude Code and Codex gateways and is hidden for
Antigravity. A run that names a provider is refused.

## Permissions

Runs speak the Agent Client Protocol (ACP) v1 to `agy acp` over stdio. In ask
mode agy sends each action its permission settings do not already allow as a
prompt, and the prompt appears in the run like Claude Code's and Codex's:
allow, deny or allow all. A command's prompt shows the command, and any other
action's shows its input. Canopy answers agy "allow once" every time, even for
allow all, and keeps the allow-all scope itself, so it ends with the run and
never lands in agy's own settings. ACP's reply to agy says allow or reject
and nothing more, so a deny's reason waits until agy's turn ends and then
goes to it as the next message, which the run shows as "told Antigravity
why". The run carries on with agy's answer to it. An unattended run's fixed
reason goes once, not after every deny. Yolo passes
`--dangerously-skip-permissions`, and agy asks nothing.

The extra-flags box applies to shells only. A run with extra flags is refused
rather than started without them.

## What it does not do yet

- Coordinator, commit-message suggestions and incubator stages stay on Claude
  Code and Codex. So does plan-then-build.
- An Antigravity loadout takes a model and an effort. Claude skills and the
  kit's MCP servers are Claude Code's. canopy hands its own MCP server to agy
  in the ACP session setup, as it does for the other harnesses.
- Session moves and the sessions list read Claude Code's and Codex's files on
  disk. agy keeps its conversations elsewhere, so neither lists them.
- A side question cannot fork an Antigravity session. A finished run can start
  a new run from canopy's brief of its steps.
- Each run's tokens come from agy's own count and show on the run, a chat's
  summed over its turns; agy reports no dollar cost. Plan usage windows (5-hour
  and weekly) are read via `agy -p /usage --output-format json` (0 turns, 0
  tokens) at backend start, on the capacity schedule, on `canopy capacity read`,
  and after Antigravity runs finish, and feed the capacity chip and governor.

## How it was checked

The flags (`--model` takes either form, `--effort xhigh`, `/exit` quits the
TUI), the ACP handshake (protocol 1, `loadSession`, additional
directories), the `configOptions` (model, `thought_level`, mode), the -32000
"Authentication required" error, the permission request (string ids, `allow`
and `deny` options) and the usage counts were read off agy 1.5.15 on
2026-11-23. The driver tests in `src/core/antigravity.test.ts` replay those
shapes against a stand-in, `src/core/testdata/fake-agy-acp.ts`.

Then end to end through canopy on 2026-11-23, with agy 1.5.15 on all three
machines and `gemini-3.8-flash`. On the Mac: a profile made and edited in the
Routing view, a repo override to it, an ask run that asked before running a
command and writing a file (allow, then allow all), a two-turn chat that
remembered a word from its first turn, a side question refused in words, a
model agy does not offer failing the run with agy's list, and an Antigravity
shell starting `agy --model gemini-3.8-flash`. On the mini and De Soto: an
ask run that asked before `git rev-list --count HEAD` and answered after an
allow, and on the mini an Antigravity shell starting agy in the shells
container.

References: [ACP in the CLI](https://antigravity.google/docs/cli/acp/),
[CLI reference](https://antigravity.google/docs/cli/reference).
