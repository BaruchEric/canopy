# canopy

A multi-repo git cockpit: point it at a directory and see every git repo under it as a live tree — then drill into changes, stage, commit (with AI-suggested messages), push, open repos in kitty / Terminal / VS Code / Finder or in an interactive Claude Code session, and group them into named workspaces. Web UI + full CLI.

The write-capable, many-repo complement to [diffscope](../diffscope) (single-repo, read-only).

## TL;DR

- **What:** one screen for the whole grove — every repo's branch, dirty files, ahead/behind, and last-commit age, live-updated as the filesystem changes.
- **How:** a Bun server scans for `.git` dirs, shells out to `git`, watches the root recursively, and streams updates to a React SPA over SSE. Commit messages come from the `claude` CLI (heuristic fallback). Whole jobs (commit, push, deploy, anything you type) drive the same CLI over stdio, with permission prompts and questions relayed to the browser.
- **Stack:** Bun + TypeScript (strict) server, React 19 + Vite + Zustand SPA, zero CSS frameworks. `bun test`, `tsc --noEmit`, `oxlint`.
- **Run:** `bun install && bun run build && bun link`, then `canopy ui ~/dev`.
- **Shared backend:** canopy can also run headless in a container as one always-on backend for every device on your tailnet, using your `claude` and `codex` subscriptions. The in-browser core (shells, Claude, git, search) is the same from any device; the macOS desktop openers and the launcher are hidden there, and VS Code becomes a client-side Remote-SSH link. See `docs/deploy.md` and `docs/prd-shared-backend.md`.

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
The shared backend on the mini serves `canopy.beric.ca` through the compose
`tunnel` service (a Cloudflare Tunnel under the `tunnel` profile, with
Cloudflare Access protecting the hostname); see "A public name" in
`docs/deploy.md`. The older macOS deployment ran as `ca.beric.canopy-server`.

## CLI

```bash
canopy [dir]                       # tree of every repo under dir (default: .)
canopy status [dir]                # only repos that need attention
canopy ui [dir] [--port N]         # web UI at http://127.0.0.1:7850 (--no-open: no browser tab)
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
canopy launch <repo>               # builds here, the repo's releases, its open pull requests
canopy launch <repo> v1.2.0        # install that release for this machine if needed, launch it
canopy launch <repo> --pr 42       # check the pull request out as a worktree, build, launch
canopy launch <repo> --here        # build this checkout with its build line, launch it
canopy launch <repo> --build "cargo build --release" --run "./target/release/app"
canopy source                      # the extra folders the UI scans
canopy source add ~/work           # scan another folder on this machine
canopy source add ~/dev --host wsl # …or one on an ssh host
canopy source add --forgejo https://git.example.com --token ~/secrets/forgejo.txt
canopy source rm <id>              # stop scanning it
```

## Web UI

- **Left rail** — the repo tree grouped by topic folder, with dirty counts rolled up. Drag its edge to resize; the panel-left button (or `[`) folds it away.
- **Center** — a dense card grid (auto-fills columns; ~16 across on a 7680px screen). Cards pulse when a repo changes on disk. Every card has a ⋯ menu: chat with Claude about the repo (**chat…**, in canopy), hand it a workflow (commit, push, ship, deploy, review) or a job (ask claude…), start an interactive Claude Code session at the repo (**agent**: a kitty window when kitty is installed, Terminal otherwise, held open at a prompt when the session ends; **herdr**: a [herdr](https://herdr.dev) workspace at the repo with Claude running in its pane, or the workspace the repo already has, focused), set the repo's **agent settings…**, open a **shell** at the repo inside canopy, or open the repo in kitty / Terminal / VS Code / Finder.
- **Agent settings** — per repo: model (fable, opus, sonnet, haiku, or claude's own default), effort (low to max), permissions (yolo, the default, for `--dangerously-skip-permissions`, or ask), and any extra flags for the claude command line. Saved on the server, keyed by repo path like workspaces, and applied wherever canopy starts Claude for that repo: the agent and herdr openers, workspace "open all" in agent or herdr, the CLI's `canopy open`, and every run and chat. The menu shows the current settings in one line; the sheet resets them in one click.
- **Runs** — a Claude job opens a pre-flight dialog (what will happen, an optional note), then a console that follows Claude step by step: every command with its output, Claude's own remarks, and a lichen "needs you" block whenever Claude asks a question or wants permission for something outside the job (allow once, allow all for this run, or deny). While a run is going the card's leaf edge carries sap; when it waits, the edge and a top-bar pill turn lichen. Finished runs stay on the card until dismissed. A workflow that expects a change and ends without moving git status says "no change" instead of "done" (see Workflows), so a flow that found nothing to do is not mistaken for one that did something.
- **Chat** — the same console with a message box: your first message starts Claude Code in the repo, every later one continues the same session (Claude keeps the context, canopy keeps the process). Your messages sit in the timeline with Claude's replies and tool calls; permission prompts and questions work as in a run. Between turns the chip says "chat open"; **end chat** closes the conversation and Claude Code exits. A chat counts as the repo's one run at a time.
- **Right dock** — click any repo to pin a full detail panel: file list with stage checkboxes (columns for the status letter, path, and when the file last changed on disk, newest first; click a heading to sort, drag one to reorder, type in the box to filter, or switch to **folders** for a heading per folder), inline diffs, commit box with **suggest** (Claude-written message), commit / commit+push, pull/push, openers, workspace membership, the commit log, and the repo's Claude sessions (below). Every commit in the log opens in place: the full hash (click to copy), author and time, the message body, then each file it touched with its status letter, lines added and removed, and a short bar (moss for added, rust for removed) scaled to the commit's biggest file. Click a file for the diff that commit made to it. Merges show against their first parent. The commits listed under a Claude session open the same way. Each of a panel's sections (changes, shell, search, history, launch, claude) folds by its heading, remembered per repo, and the open panels themselves come back after a reload. Panels stack side-by-side — on an ultrawide you can hold half a dozen repos open at once. Or set **open a repo** to **dock tabs** and the dock is one panel with the open repos as tabs across its top: a click on a card opens or brings forward its tab, a tab's × or a middle click closes it, and the tab beside it takes over. The panels behind the strip stay live, so a shell in one keeps running while another shows.
- **Remote activity** — every five minutes (and once soon after start) the server fetches your own remotes of every local repo in the background. A remote is yours when it is on GitHub and you can push to it (your login's, or an org's that grants push, asked once through gh) or when it is self-hosted (a Forgejo on the LAN, a NAS, a path). A clone of someone else's project has no remote of yours and is left alone; a fork fetches your fork and not its upstream, so a busy upstream never reads as your own activity. A fetch that moves a ref re-reads that repo, which is what keeps the behind counts honest. When one of your remotes has a branch with a commit the checkout does not (a push from another machine, a branch a cloud agent opened, a PR nobody checked out here), the card and the panel head carry a `⇣ origin/branch` chip (left out when that branch is the upstream itself, since the behind count already says so), the card's time counts it as the repo's last change, and the `recent` grouping moves the card with it; the time's tooltip names the branch. The feed reports each branch that moved. Next to it, `⇄ 2` is the repo's open pull requests on GitHub, counted in one query over every repo the gh login can see and linked to the list. Set `"fetch": false` in the config to keep the server from fetching your repos (the pull request count is a gh query, not a fetch, and keeps coming). Without gh, only self-hosted remotes count as yours.
- **Rings** — a card whose repo Claude has worked in this month carries a thin strip along its bottom edge: one column per local day, tinted in sap by that day's API-equivalent spend on a log scale shared by the whole grove. A quiet month leaves a faint ruler; a card Claude has never touched has no strip. Hover for the month's totals. The panel shows the same strip taller, with a tooltip per day.
- **Folders** — the root path in the top bar opens the list of folders canopy scans: the one it was started on, plus any you add, each with its repo count, a rescan, and a remove. Add a folder on this machine (changes show up live through a file watcher) or one on another host over ssh: pick a host from `~/.ssh/config`, give a path (`~/dev` works) or hit **browse** to walk the folders there one level at a time (repos are marked; breadcrumbs go back up; "use this folder" fills the path), and its repos join the grove with a host tag on the card. Remote repos get status, log, diffs, stage, commit, push, pull, and AI-suggested messages the same way, every git call riding one shared ssh connection per host; they are re-read every five minutes instead of watched. The kitty, Terminal, and agent openers start an ssh session at the repo; VS Code opens it through Remote-SSH; Finder cannot. Claude runs stay local: the run action refuses a remote repo. Repos under an extra folder carry ids like `wsl-dev:web-apps/ripe` and group under the folder's label. A remote host needs key-based login, git on its PATH, and a POSIX shell.
- **Self-hosted git** — the third kind of source is a Forgejo (or Gitea) server rather than a folder: give its address and a file holding an API token, and canopy lists what the server holds through `/api/v1/user/repos`. Those repos are bare on the server, so their cards carry no working state — a dashed border, the forge's description, its default branch, and when it was last pushed to. Each one is matched against the clones already on this machine by remote url, so by default only the repos you have no clone of get a card, and the header of the folder list flips that to every repo. A clone with no web link of its own picks up the forge's page. Clicking a forge card opens that page; its ⋯ menu offers the page and the ssh clone url, and nothing else — every git-driven route refuses a repo with no checkout. The token file's path is what gets stored, never the token; with no file named, `$CANOPY_FORGEJO_TOKEN` is read instead. The list is refreshed every five minutes.
- **Shells** — your login shell on a real pty at the repo (an ssh session there for a remote repo), rendered by xterm.js and bridged over a websocket, opened from a card's menu (**shell**, in canopy). Where it lands is a setting: the repo's panel (a foldable section pinned along the panel's bottom edge with its own tabs and a + for another, five lines tall until you drag its top edge, each panel's shell its own height; double-click resets), the strip along the bottom of the window (one tab per shell; drag its top edge to size it, arrow keys work on it too, double-click resets), a browser tab or a small window of its own, or **auto**, the panel when the repo has one open and the strip otherwise. A shell in a panel ends when you close the panel; the strip is where a shell outlives the view it opened from. Shells paint with the theme's own colors and follow a theme switch; a tab's × ends its shell. Shells live on the server, not the page: a reload, a closed tab or a dropped connection (the laptop asleep, the tunnel gone) leaves the shell and whatever runs in it going, and the window comes back to it, so a Claude session started in a canopy shell survives a reload. A dropped connection is rejoined on its own, first after a second and then at longer waits; a shell nobody has a tab for (opened in a window since closed) gets one where it was opened when the grove loads. With `tmux` installed, a shell survives the canopy server too: each one is a session on a tmux server of canopy's own (socket `tmux.sock` under the config dir, config `lib/tmux.conf`: no status bar, no prefix, so every key reaches the shell), each browser window on it is a client of its own, and a restarted canopy lists the sessions and hands the windows back to them, the last 2000 lines of what scrolled off ahead of the live screen. tmux draws on the terminal's normal screen, so xterm's own scrollback and mouse selection work as they would on a plain pty; the price is that tmux's copy mode and mouse handling are off. A remote repo's shell is the ssh session inside a local tmux session, so the other host needs no tmux. `CANOPY_TMUX=0`, or no tmux on PATH, is the plain pty: the shell outlives its window with the last 512KB of what it wrote, and a canopy restart ends it (the tab says so and goes on the next reload).
- **Preview** — the in-app browser: a repo panel's **preview** section (folded by default) frames the repo's dev server as it runs on the backend, so a Vite or Next app started in a canopy shell shows in the panel from any device. It offers the ports whose process runs in the repo (read off `/proc` on Linux, `lsof` on a Mac), picks the one there is when there is only one, and lists the ports no repo claims or takes any port typed in; a path box, reload and ↗ (the same preview in a browser tab) sit above the frame, which is drag-resizable. Each preview is proxied on a port of its own from a small pool (`CANOPY_PREVIEW_PORTS`, default `7860-7869`, `0` for off), HTTP and websockets both, so the app sees its own origin: absolute paths and HMR work unchanged, and it cannot reach canopy's API. The proxy dials loopback only and answers only to a loopback or tailnet host name; a preview is plain http on that port, so it works at the tailnet address but not through the https tunnel. What each repo previews is remembered per browser.
- **Search** — the magnifier in the top bar (or ⌘⇧F) searches file contents across every repo in view, so a narrowed grid narrows the search. It is `git grep` over tracked text files, fixed string, case-insensitive, so it works the same on a repo over ssh. Results group by repo with a count, then by file, each hit a line number and the matched line with the match lit; a repo unfolds on click and **panel** opens its dock panel with the same term in the panel's own **search** section. Clicking a hit opens the file at that line in VS Code (through `code -g`, or the Remote-SSH window for a remote repo). A repo answers at most 500 hits and says when it had more.
- **Shells picker** (`▸_ n` in the top bar, with a dot when a running shell has no tab here) — every shell the backend holds, whichever device started it: the repo, where it was opened, how long ago, and which other devices have it open. **join** puts it here as a tab (a panel shell opens its panel), **hide here** takes the tab away on this browser only and leaves the shell running for the others (a hidden shell is not taken back up on the next load), and **end** ends it on every device. Below that, **claude conversations**: pick a repo and it lists the Claude Code conversations started there on the backend, newest first, read straight off `~/.claude/projects` (the first prompt or Claude's summary, the branch, when); **resume** opens a new shell at the repo with `claude --resume <id>` and the repo's agent settings typed in, so a conversation started in any shell, on any device, carries on from another. Conversations started on a different machine live in that machine's `~/.claude` and are not listed.
- **Event feed** — a strip along the bottom, above the shells, that streams every server event across every source as it happens: a file edited or reverted in a repo, a commit landing, a branch switch, a rescan with the repos that came and went by name, a source failing or recovering, a run starting, each tool it calls, the prompt it parks on and how it ended, a workflow's steps and gates, a fleet's skips. Every line says when, which source, which repo (click it to open the panel), and what. Toggle it with the list glyph in the top bar or `e`; drag its top edge to size it. The chips narrow it to one source; **quiet lines** shows the re-reads that changed nothing; the list follows the newest line until you scroll up, then holds still and counts what arrived. It holds the last 500 lines and lives for the page.
- **Top bar** — workspace tabs (with one-click "open all in code/kitty"), a grouping switch, a needs-attention pill that doubles as a live count, a filters pill, and a repo filter (`/` to focus, `d` to toggle needs-attention, `f` for the filter menu, `s` to cycle grouping, `e` for the event feed, `x` for select mode).
- **Filters** — the pill opens chips for status facets (changes, unpushed, behind, conflicts, off main, no upstream, unreadable) and, when the grove commits as more than one person, one chip per git identity. Each chip carries the count it would show. Lit chips in a row add up; the rows, the attention toggle, and the text box narrow each other. The pill reads "2 filters" while anything is lit so a thinned grove is never mistaken for a small one.
- **Grouping** — `recent` (the default) buckets by the last change of any kind, a commit, an edit in the working tree or a commit on a remote branch the checkout does not have (today, this week, this month, this season, dormant, untouched), newest first; `folder` mirrors the disk layout; `activity` puts repos with changes first, then unpushed, behind, quiet, unreadable, each group newest change first; `name` is one flat list; `user` buckets by the identity each repo commits as (`user.name` / `user.email` as git resolves them inside that repo, so a per-folder `includeIf` shows up), with "no identity" and unreadable repos last. The tree and the grid always agree, and that includes folding: click a section heading in either and it folds in both, remembered per grouping mode.
- **Settings** (gear, top right) — where a click opens a repo (a dock panel beside the others, a tab in one dock panel, a new browser tab, or a small new window; cmd-click and shift-click always do tab and window), whether kitty and Terminal get a new window or a tab in the front one (for "open in" and the agent; canopy runs kitty as its own instance, listening socket-only, so tabs go there rather than to a kitty you started yourself; a Terminal tab needs Accessibility access for the server since it presses cmd-t), where a shell in canopy lands (auto, the panel, the strip, a new tab or window), theme (system / dark / light), and card density. Stored per browser in localStorage.
- **Solo view** — `/?repo=<id>&view=solo` shows one repo's panel on its own; that is what the tab and window targets open. Drag either edge of the panel to size it (double-click resets); the width is shared by every solo tab in the browser. `/?repo=<id>` alone opens the full UI with that repo pinned.

Light and dark themes follow the OS unless the setting says otherwise. Reduced motion respected.

## Claude runs

Each run is one Claude Code session in the repo's directory: canopy spawns the `claude` binary on your PATH in print mode with stream-json on stdin and stdout, so it runs on whatever your terminal `claude` runs on (a Claude Max login included), with no SDK and no API key. It loads your user and project settings and CLAUDE.md files the way a terminal session would, but no MCP servers. `ask claude…` pre-allows only read-only git; a workflow step pre-allows what its `tools:` line names (see Workflows); anything else asks in the console. The repo's agent settings ride along: `--model` and `--effort` as set, and yolo runs the session in `bypassPermissions` mode, so nothing asks. Runs live in server memory: the last 60 finished ones stay visible until dismissed or the server restarts. One run per repo at a time.

A chat is a run whose process outlives its first reply: stdin stays open after each `result`, the next message goes down it as another user message, and the CLI continues the session. Ending the chat closes stdin and the CLI exits on its own.

## Workflows

A workflow is a markdown file: frontmatter names it and sets its precondition, the body is a series of `##` steps run one at a time through the same Runner a plain job uses, with a gate between steps.

Frontmatter keys:

| key | meaning | default |
| --- | --- | --- |
| `name` | id, unique across the three sources, `[a-z0-9-]+` | file name without `.md` |
| `label` | menu text | name |
| `verb` | confirm button and the flow's title | label |
| `blurb` | one paragraph for the pre-flight | required |
| `when` | precondition: `dirty`, `unpushed`, `dirty-or-unpushed`, `any` | `any` |
| `expects-change` | a flow that leaves status untouched reports "no change" | false |
| `note` | placeholder for the note box; `note-required: true` makes it the task | optional |

A `##` heading is a step's name. The `key: value` lines right under it, up to the first blank line, are the step's keys; the rest of the section is the prompt:

| key | meaning | default |
| --- | --- | --- |
| `tools` | comma-separated: named sets `git-read`, `git-commit`, `git-push`, `bun`, `read`, or literal rules like `Bash(cargo:*)` | `git-read` |
| `turns` | max turns for this step's run | 30 |
| `check` | a shell command run in the repo after the run ends; exit 0 passes | none |
| `gate` | `continue`, `ask`, `verdict` | `continue` |

A step whose body is empty is check-only: no Claude run, just the command. Workflows come from three folders, later ones winning by `name`: `lib/workflows/*.md` (bundled with canopy), `$CANOPY_CONFIG_DIR/workflows/*.md` (yours, `~/.config/canopy/workflows` by default), and `<repo>/.canopy/workflows/*.md` (that repo only, local repos only). The bundled five: **commit** (stages what belongs, writes the message, does not push), **push** (pushes the branch, rebasing only when safe), **ship** (gates, then commit, then push, stopping before committing if a gate fails), **deploy** (works out how the project deploys and runs it after its own gates), **review** (reads the diff and recent commits and reports what looks wrong, changing nothing).

Every step's `check`, when present, runs after the step's Claude run ends and before the gate; a nonzero exit fails the step and the flow. Then the gate: `continue` starts the next step at once, `ask` parks the flow for you to continue, retry, or stop, and `verdict` hands the step's summary to an evaluator (Jev, over the Vercel AI Gateway) that decides the same three ways on its own. `verdict` needs `AI_GATEWAY_API_KEY` set in the server's environment; without it, a `verdict` gate behaves like `ask`.

Select several repos on the board (the select button in the top bar, or `x`) and run one workflow across all of them as a fleet: each repo whose precondition does not hold is skipped, the rest run up to three at a time, and the fleet's own sheet shows every repo's flow. Select mode starts with nothing picked. Click a card or a tree row to pick it, shift-click to pick (or unpick) everything from the last click to that one, tick a group heading to take the whole group, and use the bar along the bottom for all, none, invert, or just the repos in one state (with changes, unpushed, behind, and so on). ⌘A picks everything in view, Escape leaves. The count and the fleet only ever include picks the current filters show. All, none, invert and "only…" replace the selection with what is in view; a single pick a filter hides stays put and comes back when the filter clears.

`docs/workflows/example-update-deps.md` is a worked example meant to be copied to `$CANOPY_CONFIG_DIR/workflows/` rather than bundled, since a dependency bump belongs to you, not to canopy.

## herdr

[herdr](https://herdr.dev) is a terminal workspace manager for coding agents. The herdr opener drives its socket API through the `herdr` CLI (on PATH or at `~/.local/bin/herdr`): it lists panes to find a workspace already at the repo's folder and focuses it (starting Claude there if nothing runs in that pane), or creates one with `herdr workspace create --cwd <repo> --label <name> --focus` and starts Claude in its pane with `herdr agent start <name> --kind claude --pane <id> -- <flags>`, the flags being the repo's agent settings. A repo on another host gets a workspace whose pane runs the ssh session. When herdr's server is not running, canopy starts a herdr client in kitty (or Terminal) and waits for the socket.

## Launcher

The launch section of a repo's panel (folded by default; **builds & releases** in the card's menu opens it) is a generic take on [freecad-launcher](https://github.com/deltahedra3d/freecad-launcher): where that app manages FreeCAD's AppImages and builds its pull requests, canopy does the same for any repo with a GitHub remote, on this machine.

- **releases** lists the repo's releases from GitHub (through `gh`, so its login and rate limits apply), each with the one asset that fits this machine: a glob from the launch settings when one is set, else a guess from the names (the OS and arch words, then the preferred kind: `.dmg` before `.zip` on a Mac, `.AppImage` before a tarball on Linux). A release whose assets name only other platforms says so instead of guessing. **install** downloads the asset into `~/.config/canopy/builds/<owner>/<name>/release/<tag>/` and opens it up: a disk image's `.app` or `.pkg` is copied out, a zip or tarball extracted (one wrapping folder lifted away), a bare binary or AppImage made executable. Several versions sit side by side.
- **pull requests** lists the open ones. **build** fetches `pull/<n>/head`, checks it out as a git worktree under `.../pr/<n>/` (the repo's own checkout is untouched), and runs the repo's build line there; a later build of the same PR refreshes the worktree. Pull requests are built on this machine only: a repo on another host lists them but cannot build them.
- **builds** is what is here: the installed releases, the built pull requests, and **this checkout** when the settings give it a run line. **launch** starts one: an `.app` through `open -n`, a binary directly, a checkout through its run line from its root, all through your login shell so PATH is what your terminal has. A first launch of a build asks once (**run it?**). A launched build shows as **running** with a **stop** button until it exits (an `.app` is watched through `open -W`, and stop quits it by its executable's path), and a binary's or run line's output lands in `.../logs/`. Launches are counted per build, with the last time. The ✕ removes an installed release or a worktree.
- **settings…** (also **launch settings…** in the menu) are four lines per repo, saved on the server like agent settings: `build` (run in a worktree after the fetch, and in this checkout on build), `run` (launches a checkout), `release asset` (the glob), and `launch a release` (how an installed release starts, `{file}` being what the download unpacked; blank opens it the way its kind says).

Downloads and builds are **jobs**: each shows in the section with its progress and the tail of its output, can be stopped, and reports to the event feed. Not carried over from freecad-launcher: the 3D preview and the `.desktop` entries, which are FreeCAD's and Linux's respectively.

## Claude sessions

Every session Claude Code has ever run in a repo, not only the ones canopy started, comes from [claude-history](../claude-history): the per-project archive and index of transcripts, prompts, tool calls, tokens, cost and the commits made while a session was running, from this Mac, the other hosts it pulls, and claude.ai/code. canopy shells out to that CLI's `--json` reports and never opens its sqlite file, so the archive's schema stays its own business.

The panel's **claude** section shows the all-time session count and API-equivalent spend, the rings, then the sessions themselves: newest first, the last 30 / 90 days or all of them, each row a title (or the first prompt), where it ran when that was not this machine, and what it cost. Open a row for the session turn by turn: your prompt, Claude's reply, and the tools it used, with the commits made during the session underneath. **open note** opens the session's markdown note from the memory vault in Obsidian (or whatever opens markdown). The search box runs the archive's full-text search over this repo's sessions; matches come back as rows with the matching passage.

canopy finds the CLI at `historyBin` in its config, else `claude-history` on PATH, else `~/dev/dev-tools/claude-history/bin/claude-history`. Without it the rings stay off and the section says why. The overview (every repo's totals and days) is two CLI calls, cached for five minutes and rebuilt after a rescan; the archive itself is refreshed by claude-history's own hourly sync, so a session shows up here within the hour after it ends. Dollar figures are list-price API equivalents of the tokens, as claude-history counts them, not a bill.

## Peers

Peers keeps a full clone of every repo under the launch root in sync across your machines over ssh, pull-only: each one fetches every other peer's branches and its uncommitted work as a WIP snapshot, fast-forwards what it safely can, and leaves a real divergence or a branch that only exists on a peer for you to look at. Nothing ever writes into another machine's working tree. A peer's ssh key runs only `git-upload-pack` and three read-only queries behind a forced command, never a shell. It replaces a one-way rsync mirror with the model coworkers use: every machine keeps its own clone and resolves its own conflicts, and work moves between clones only through git.

In canopy's config (`~/.config/canopy/config.json`, or `$CANOPY_CONFIG_DIR/config.json`):

```json
{
  "self": "mac",
  "peers": [
    { "name": "mini", "alias": "macmini-ts", "root": "dev", "role": "git" },
    { "name": "gpd", "alias": "gpd", "root": "dev", "role": "git", "repos": ["dev-tools/*", "web-apps/keel"] },
    { "name": "qnap", "alias": "nas", "root": "/share/Arik/dev-mirror", "role": "mirror" }
  ],
  "peerSync": "dry",
  "seed": [".env", ".env.local", ".env.*.local"]
}
```

`self` is this machine's own name; `peers` is who it pulls from, each an ssh_config `alias` (never `user@host`) and a workspace `root` (home-relative unless absolute). `role: "git"` is a full coworker; `role: "mirror"` only ever receives the rsync mirror and is never pulled from. `repos` is an optional list of globs over repo ids, a peer with it clones and fetches only matching repos. `peerSync` is `off`, `dry` (compute and report everything, write nothing but the fetched refs) or `on`. `seed` is the allowlist of ignored files (`.env` and the like) copied once from a peer when a repo lacks them, never overwritten.

```bash
canopy peers status                       this machine's name, sync mode, and its peers
canopy peers init                         set up each peer's git remote in every repo
canopy peers sync [id]                    fetch every peer once, fast-forward, list WIP
canopy peers take <id> <peer> [branch]    land a peer's WIP here
canopy peers track <id> <peer> <branch>   a local branch at a peer's tip
canopy peers seed <id>                    copy allowlisted ignored files from a peer
canopy peers gate --root dir              what a peer key's authorized_keys entry runs
```

The CLI's peers commands are not serialized with a running server, so while the server runs prefer the UI's actions, which queue behind its own pass.

A peer reaches this machine through a dedicated ssh key whose `authorized_keys` entry forces the gate and nothing else:

```
restrict,command="<path to bun> <path to canopy>/bin/canopy.ts peers gate --root dev" ssh-ed25519 AAAA... canopy-peer@<machine>
```

`sshd` must not `AcceptEnv` `GIT_*` or `BUN_*` for that key. The default config accepts only `LANG` and `LC_*`, and either one reaching the gate's environment could run code before it does anything.

## State

- Config + workspaces: `~/.config/canopy/config.json` (override dir with `$CANOPY_CONFIG_DIR`). `historyBin` there points at the claude-history CLI when it is not on PATH; `fetch: false` turns the background fetch of your own repos off.
- Generated workspace files (`.code-workspace`, kitty sessions): `~/.config/canopy/workspaces/`.
- Workspaces store absolute repo paths, so they work from any scan root. A repo on another host is stored as `ssh://<host><path>`.
- Agent settings live under `agents` in the same config, keyed the same way; a repo set back to the defaults loses its entry. Launch settings live under `launchers` the same way.
- Installed releases, pull request worktrees, launch counts and launch logs: `~/.config/canopy/builds/<owner>/<name>/` by the repo's GitHub slug (`_local/<name>-<hash>` for a repo without one), with a `state.json` per repo.
- Extra folders live under `sources` in the same config, each with an id, a label, a kind (`local`, `ssh` or `forgejo`), the host for ssh, and the absolute path — or, for a forge, its address and the path of the file holding its API token. The launch root is never stored. ssh control sockets sit next to the config as `ssh-*`.

## Development

```bash
bun run dev        # API on :7850
bun run dev:web    # Vite dev server on :7851 (proxies /api)
bun run typecheck && bun run lint && bun test && bun run build
```
