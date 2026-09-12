# canopy

A multi-repo git cockpit: point it at a directory and see every git repo under it as a live tree — then drill into changes, stage, commit (with AI-suggested messages), push, open repos in kitty / Terminal / VS Code / Finder or in an interactive Claude Code session, and group them into named workspaces. Web UI + full CLI.

The write-capable, many-repo complement to [diffscope](../diffscope) (single-repo, read-only).

## TL;DR

- **What:** one screen for the whole grove — every repo's branch, dirty files, ahead/behind, and last-commit age, live-updated as the filesystem changes.
- **How:** a Bun server scans for `.git` dirs, shells out to `git`, watches the root recursively, and streams updates to a React SPA over SSE. Commit messages come from the `claude` CLI (heuristic fallback). Whole jobs (commit, push, deploy, anything you type) drive the same CLI over stdio, with permission prompts and questions relayed to the browser.
- **Stack:** Bun + TypeScript (strict) server, React 19 + Vite + Zustand SPA, zero CSS frameworks. `bun test`, `tsc --noEmit`, `oxlint`.
- **Run:** `bun install && bun run build && bun link`, then `canopy ui ~/dev`.

## Project library and dev servers

Canopy now includes `_devhub`'s workspace-management features. Run
`canopy ui ~/dev` and choose **Library** or **Ports** beside **Git cockpit**.
Library organizes projects and saved references with categories, tags, notes,
favorites, pins, archives, relations, sortable lists, and a file explorer. Its
project details link back to Canopy's Git panel. Ports manages assignments,
command detection, and starting, opening, stopping, and restarting dev servers.
Library also provides bulk Fetch/Sync and individual Fetch/Pull/Push/Sync.

These features require **Python 3.10+** and operate on the UI's launch folder.
Use the workspace parent (`~/dev` for the existing `_devhub`), not Canopy's own
checkout. Remote and Forgejo sources continue to work in the Git cockpit;
Library currently manages the local launch folder.

On first use, Canopy copies durable metadata from `<root>/_devhub` when present:
categories, overrides, links, notes, favorites, pins, archives, tags, references,
relations, and cached health. Your current uncommitted metadata is included.
The source files are left intact; subsequent edits go to
`~/.config/canopy/library/<root-hash>/` (or `$CANOPY_CONFIG_DIR/library/`). This is
a one-time migration, not two-way synchronization. Explicit project move/rename
and import actions still modify project folders, as they did in `_devhub`.

All library commands share that same state:

```bash
canopy library --root ~/dev --help
canopy library --root ~/dev doctor
canopy library --root ~/dev classify
canopy library --root ~/dev import https://example.org --title "A useful reference"
canopy library --root ~/dev tag my-project active personal
canopy library --root ~/dev note my-project "Next steps"
canopy library --root ~/dev relate my-project another-project
canopy library --root ~/dev attach "A useful reference" my-project
canopy library --root ~/dev set-link my-project --deployed https://example.org
canopy library --root ~/dev ports
canopy library --root ~/dev dev my-project --dry-run
canopy library --root ~/dev announce --project my-project --port 6100
canopy library --root ~/dev git sync
canopy library --root ~/dev build --no-fetch --no-check
canopy library --root ~/dev index
```

`build` discovers nested projects and deployment targets; omit `--no-check` for
live URL health checks and `--no-fetch` to fetch repositories. `index` exports a
static snapshot in the state directory without staging Git files. Refresh the
Library after CLI changes. Dev-server launching retains macOS Terminal/iTerm/Kitty
support. Canopy starts and stops its own library helper; no separate helper or
LaunchAgent is needed. Personal DNS setup and standalone gallery/endpoint-site
publishing stay in `_devhub`.

## Existing tunnel deployment

For an authenticated HTTPS reverse proxy, set `CANOPY_PUBLIC_ORIGIN` to its
exact origin (for example `https://canopy.beric.ca`) in the server environment.
Library requests then accept that host with `X-Forwarded-Proto: https`, while
retaining same-origin checks. Bun still binds only to loopback. Authentication
must remain enabled on the proxy; this setting does not provide authentication.
The existing macOS deployment runs as `ca.beric.canopy-server`, with
Cloudflare Access protecting `canopy.beric.ca`.

## CLI

```bash
canopy [dir]                       # tree of every repo under dir (default: .)
canopy status [dir]                # only repos that need attention
canopy ui [dir] [--port N]         # web UI at http://127.0.0.1:7850
canopy commit <repo> -m "msg"      # commit staged changes
canopy commit <repo> --ai --all --push   # AI message, stage everything, push
canopy suggest <repo>              # print an AI-suggested commit message
canopy push <repo> | pull <repo>
canopy open <repo> --app kitty     # kitty | terminal | code | finder | agent | herdr
canopy open <repo> --app agent     # interactive Claude Code in a terminal at the repo
canopy open <repo> --app herdr     # the same, as a herdr workspace (herdr.dev)
canopy ws                          # list workspaces
canopy ws create <name> <dirs...>  # group repos
canopy ws open <name> --app code   # one multi-root VS Code window
canopy ws open <name> --app kitty  # one kitty window, a tab per repo
canopy source                      # the extra folders the UI scans
canopy source add ~/work           # scan another folder on this machine
canopy source add ~/dev --host wsl # …or one on an ssh host
canopy source add --forgejo https://git.example.com --token ~/secrets/forgejo.txt
canopy source rm <id>              # stop scanning it
```

## Web UI

- **Left rail** — the repo tree grouped by topic folder, with dirty counts rolled up. Drag its edge to resize; the panel-left button (or `[`) folds it away.
- **Center** — a dense card grid (auto-fills columns; ~16 across on a 7680px screen). Cards pulse when a repo changes on disk. Every card has a ⋯ menu: chat with Claude about the repo (**chat…**, in canopy), hand it a job (commit, push, commit and push, deploy, ask claude…), start an interactive Claude Code session at the repo (**agent**: a kitty window when kitty is installed, Terminal otherwise, held open at a prompt when the session ends; **herdr**: a [herdr](https://herdr.dev) workspace at the repo with Claude running in its pane, or the workspace the repo already has, focused), set the repo's **agent settings…**, or open the repo in kitty / Terminal / VS Code / Finder.
- **Agent settings** — per repo: model (fable, opus, sonnet, haiku, or claude's own default), effort (low to max), permissions (ask, or yolo for `--dangerously-skip-permissions`), and any extra flags for the claude command line. Saved on the server, keyed by repo path like workspaces, and applied wherever canopy starts Claude for that repo: the agent and herdr openers, workspace "open all" in agent or herdr, the CLI's `canopy open`, and every run and chat. The menu shows the current settings in one line; the sheet resets them in one click.
- **Runs** — a Claude job opens a pre-flight dialog (what will happen, an optional note), then a console that follows Claude step by step: every command with its output, Claude's own remarks, and a lichen "needs you" block whenever Claude asks a question or wants permission for something outside the job (allow once, allow all for this run, or deny). While a run is going the card's leaf edge carries sap; when it waits, the edge and a top-bar pill turn lichen. Finished runs stay on the card until dismissed. A commit or push that ends without moving git status says "no change" instead of "done", so a run that found nothing to do is not mistaken for one that did something.
- **Chat** — the same console with a message box: your first message starts Claude Code in the repo, every later one continues the same session (Claude keeps the context, canopy keeps the process). Your messages sit in the timeline with Claude's replies and tool calls; permission prompts and questions work as in a run. Between turns the chip says "chat open"; **end chat** closes the conversation and Claude Code exits. A chat counts as the repo's one run at a time.
- **Right dock** — click any repo to pin a full detail panel: file list with stage checkboxes, inline diffs, commit box with **suggest** (Claude-written message), commit / commit+push, pull/push, openers, workspace membership, the commit log, and the repo's Claude sessions (below). Every commit in the log opens in place: the full hash (click to copy), author and time, the message body, then each file it touched with its status letter, lines added and removed, and a short bar (moss for added, rust for removed) scaled to the commit's biggest file. Click a file for the diff that commit made to it. Merges show against their first parent. The commits listed under a Claude session open the same way. Panels stack side-by-side — on an ultrawide you can hold half a dozen repos open at once.
- **Rings** — a card whose repo Claude has worked in this month carries a thin strip along its bottom edge: one column per local day, tinted in sap by that day's API-equivalent spend on a log scale shared by the whole grove. A quiet month leaves a faint ruler; a card Claude has never touched has no strip. Hover for the month's totals. The panel shows the same strip taller, with a tooltip per day.
- **Folders** — the root path in the top bar opens the list of folders canopy scans: the one it was started on, plus any you add, each with its repo count, a rescan, and a remove. Add a folder on this machine (changes show up live through a file watcher) or one on another host over ssh: pick a host from `~/.ssh/config`, give a path (`~/dev` works) or hit **browse** to walk the folders there one level at a time (repos are marked; breadcrumbs go back up; "use this folder" fills the path), and its repos join the grove with a host tag on the card. Remote repos get status, log, diffs, stage, commit, push, pull, and AI-suggested messages the same way, every git call riding one shared ssh connection per host; they are re-read every five minutes instead of watched. The kitty, Terminal, and agent openers start an ssh session at the repo; VS Code opens it through Remote-SSH; Finder cannot. Claude runs stay local: the run action refuses a remote repo. Repos under an extra folder carry ids like `wsl-dev:web-apps/ripe` and group under the folder's label. A remote host needs key-based login, git on its PATH, and a POSIX shell.
- **Self-hosted git** — the third kind of source is a Forgejo (or Gitea) server rather than a folder: give its address and a file holding an API token, and canopy lists what the server holds through `/api/v1/user/repos`. Those repos are bare on the server, so their cards carry no working state — a dashed border, the forge's description, its default branch, and when it was last pushed to. Each one is matched against the clones already on this machine by remote url, so by default only the repos you have no clone of get a card, and the header of the folder list flips that to every repo. A clone with no web link of its own picks up the forge's page. Clicking a forge card opens that page; its ⋯ menu offers the page and the ssh clone url, and nothing else — every git-driven route refuses a repo with no checkout. The token file's path is what gets stored, never the token; with no file named, `$CANOPY_FORGEJO_TOKEN` is read instead. The list is refreshed every five minutes.
- **Top bar** — workspace tabs (with one-click "open all in code/kitty"), a grouping switch, a needs-attention pill that doubles as a live count, a filters pill, and a repo filter (`/` to focus, `d` to toggle needs-attention, `f` for the filter menu, `s` to cycle grouping).
- **Filters** — the pill opens chips for status facets (changes, unpushed, behind, conflicts, off main, no upstream, unreadable) and, when the grove commits as more than one person, one chip per git identity. Each chip carries the count it would show. Lit chips in a row add up; the rows, the attention toggle, and the text box narrow each other. The pill reads "2 filters" while anything is lit so a thinned grove is never mistaken for a small one.
- **Grouping** — `folder` mirrors the disk layout; `activity` puts repos with changes first, then unpushed, behind, quiet, unreadable; `recent` buckets by last commit (today, this week, this month, this season, dormant); `name` is one flat list; `user` buckets by the identity each repo commits as (`user.name` / `user.email` as git resolves them inside that repo, so a per-folder `includeIf` shows up), with "no identity" and unreadable repos last. The tree and the grid always agree, and that includes folding: click a section heading in either and it folds in both, remembered per grouping mode.
- **Settings** (gear, top right) — where a click opens a repo (dock panel, new tab, or a small new window; cmd-click and shift-click always do tab and window), theme (system / dark / light), and card density. Stored per browser in localStorage.
- **Solo view** — `/?repo=<id>&view=solo` shows one repo's panel on its own; that is what the tab and window targets open. Drag either edge of the panel to size it (double-click resets); the width is shared by every solo tab in the browser. `/?repo=<id>` alone opens the full UI with that repo pinned.

Light and dark themes follow the OS unless the setting says otherwise. Reduced motion respected.

## Claude runs

Each run is one Claude Code session in the repo's directory: canopy spawns the `claude` binary on your PATH in print mode with stream-json on stdin and stdout, so it runs on whatever your terminal `claude` runs on (a Claude Max login included), with no SDK and no API key. It loads your user and project settings and CLAUDE.md files the way a terminal session would, but no MCP servers. Each action pre-allows only the commands its name promises (commit: `git add`/`git commit`; push: `git push`; deploy: `bun run`, `bun test`, and friends) plus read-only git; anything else asks in the console. The repo's agent settings ride along: `--model` and `--effort` as set, and yolo runs the session in `bypassPermissions` mode, so nothing asks. Runs live in server memory: the last 60 finished ones stay visible until dismissed or the server restarts. One run per repo at a time.

A chat is a run whose process outlives its first reply: stdin stays open after each `result`, the next message goes down it as another user message, and the CLI continues the session. Ending the chat closes stdin and the CLI exits on its own.

## herdr

[herdr](https://herdr.dev) is a terminal workspace manager for coding agents. The herdr opener drives its socket API through the `herdr` CLI (on PATH or at `~/.local/bin/herdr`): it lists panes to find a workspace already at the repo's folder and focuses it (starting Claude there if nothing runs in that pane), or creates one with `herdr workspace create --cwd <repo> --label <name> --focus` and starts Claude in its pane with `herdr agent start <name> --kind claude --pane <id> -- <flags>`, the flags being the repo's agent settings. A repo on another host gets a workspace whose pane runs the ssh session. When herdr's server is not running, canopy starts a herdr client in kitty (or Terminal) and waits for the socket.

## Claude sessions

Every session Claude Code has ever run in a repo, not only the ones canopy started, comes from [claude-history](../claude-history): the per-project archive and index of transcripts, prompts, tool calls, tokens, cost and the commits made while a session was running, from this Mac, the other hosts it pulls, and claude.ai/code. canopy shells out to that CLI's `--json` reports and never opens its sqlite file, so the archive's schema stays its own business.

The panel's **claude** section shows the all-time session count and API-equivalent spend, the rings, then the sessions themselves: newest first, the last 30 / 90 days or all of them, each row a title (or the first prompt), where it ran when that was not this machine, and what it cost. Open a row for the session turn by turn: your prompt, Claude's reply, and the tools it used, with the commits made during the session underneath. **open note** opens the session's markdown note from the memory vault in Obsidian (or whatever opens markdown). The search box runs the archive's full-text search over this repo's sessions; matches come back as rows with the matching passage.

canopy finds the CLI at `historyBin` in its config, else `claude-history` on PATH, else `~/dev/dev-tools/claude-history/bin/claude-history`. Without it the rings stay off and the section says why. The overview (every repo's totals and days) is two CLI calls, cached for five minutes and rebuilt after a rescan; the archive itself is refreshed by claude-history's own hourly sync, so a session shows up here within the hour after it ends. Dollar figures are list-price API equivalents of the tokens, as claude-history counts them, not a bill.

## State

- Config + workspaces: `~/.config/canopy/config.json` (override dir with `$CANOPY_CONFIG_DIR`). `historyBin` there points at the claude-history CLI when it is not on PATH.
- Generated workspace files (`.code-workspace`, kitty sessions): `~/.config/canopy/workspaces/`.
- Workspaces store absolute repo paths, so they work from any scan root. A repo on another host is stored as `ssh://<host><path>`.
- Agent settings live under `agents` in the same config, keyed the same way; a repo set back to the defaults loses its entry.
- Extra folders live under `sources` in the same config, each with an id, a label, a kind (`local`, `ssh` or `forgejo`), the host for ssh, and the absolute path — or, for a forge, its address and the path of the file holding its API token. The launch root is never stored. ssh control sockets sit next to the config as `ssh-*`.

## Development

```bash
bun run dev        # API on :7850
bun run dev:web    # Vite dev server on :7851 (proxies /api)
bun run typecheck && bun run lint && bun test && bun run build
```
