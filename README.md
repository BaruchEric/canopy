# canopy

canopy is a workbench for building software with Claude across every repo you have and every machine they live on. It started as a multi-repo git cockpit: point it at `~/dev` and every repo under it is a live card with its branch, dirty files, ahead/behind and last change. It still is that. Around the board it grew the rest of the loop: a shell at every repo that outlives the page, Claude Code in those shells or driven as jobs, chats and workflows, the app's dev server run as a supervised task and framed right in the repo's panel, and the same screen on a laptop, a tablet or a phone. Web UI and a full CLI.

The write-capable, many-repo complement to [diffscope](../diffscope) (single-repo, read-only).

## TL;DR

- One screen for the whole grove. A Bun server finds every `.git` dir under the folders you give it (on this machine, over ssh, or on a Forgejo), shells out to `git`, watches the tree, and streams changes to a React SPA over SSE. Stage, commit (Claude writes the message if you ask), push, pull, drill into any commit's diff.
- Claude is the `claude` binary on the backend, with your login and your settings, never an API key or an SDK. It runs in canopy's shells, or canopy drives it over stdio for jobs, chats and multi-step workflows, relaying its permission prompts and questions to the browser.
- The dev loop lives in the panel: tasks run and supervise a repo's dev server, tests and builds on tmux, the preview frames the running app, and the project bench puts changes, app, shells and log on one screen.
- It usually runs as one always-on backend in a container on a Linux box on the tailnet (the mini), reached from any device over the tailnet or a Cloudflare tunnel. Shells survive a reload and a redeploy, and with keep shell history on, a reboot gives back each one's terminal and history. Several backends can share one board, with a repo checked out on two machines shown as one card. See `docs/deploy.md` and `docs/prd-shared-backend.md`.
- Bun + TypeScript (strict) server, React 19 + Vite + Zustand SPA, xterm.js, no CSS framework. `bun test`, `tsc --noEmit`, `oxlint`.
- **Run:** `bun install && bun run build && bun link`, then `canopy ui ~/dev`.

## What it is for

A few ideas decided most of what canopy grew into.

- **Walking away loses nothing.** A reload, a closed tab, a laptop that sleeps, a phone that drops off the network, a canopy redeploy: each shell is a session on a tmux server of canopy's own and keeps running, and the page rejoins it. With keep shell history on, a reboot of the backend brings each shell back with its screen and history, and a Claude shell with a one-click `claude --continue`.
- **Any device gets the whole core.** Git, shells, Claude, search, diffs, tasks and preview are the backend's and look the same from every browser. A phone gets a key bar under each shell, touch scrolling and pinch to size the text. Only the things that need a real desktop (kitty, Terminal, VS Code, Finder) go through a small helper on the machine you sit at. Without one they hide, and VS Code becomes a Remote-SSH link.
- **Your Claude, as you run it.** Every Claude canopy starts loads your user and project settings and CLAUDE.md files, with the model, effort and permissions you set per repo.
- **Several machines, one picture.** Multiple backends merge onto one board, and peers keep each machine's clones in step over git, pull-only, so work moves between machines only through git: a branch fast-forwards when that is safe, and a divergence or another machine's uncommitted work waits for you to take it.
- **Other people's repos are left alone.** The background fetch reaches only remotes you can push to or host yourself, and a cloned project's task file cannot start a process on its own.
- **Calm by default.** A new browser gets the guided panel: Claude in a shell, run my app, save my work. The advanced panel, with every section and chip, is one switch away.

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
canopy ws open <name> --app agent  # one agent at the primary, the other members as --add-dir
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
canopy helper [--backend URL]      # lend this machine's desktop openers to a shared backend
canopy spec status [dir]           # every local repo against the shared repo spec
canopy spec sync <repo> [--visual] # write the spec into a repo (--visual adds DESIGN.md)
canopy spec check [repo]           # exit 1 unless the repo's spec text is in sync
canopy version                     # the version and commit (also --version, -V)
```

## Web UI

- **Left rail.** The repo tree grouped by topic folder, with dirty counts rolled up. Drag its edge to resize; the panel-left button (or `[`) folds it away.
- **Center.** A dense card grid (auto-fills columns; ~16 across on a 7680px screen). Cards pulse when a repo changes on disk. Every card has a ⋯ menu: chat with Claude about the repo (**chat…**, in canopy), hand it a workflow (commit, push, ship, deploy, review) or a job (ask claude…), start an interactive Claude Code session at the repo (**agent**: a kitty window when kitty is installed, Terminal otherwise, held open at a prompt when the session ends; **herdr**: a [herdr](https://herdr.dev) workspace at the repo with Claude running in its pane, or the workspace the repo already has, focused), set the repo's **agent settings…**, open a **shell** at the repo inside canopy, or open the repo in kitty / Terminal / VS Code / Finder.
- **Agent settings.** Per repo: model (fable, opus, sonnet, haiku, or claude's own default), effort (low to max), permissions (yolo, the default, for `--dangerously-skip-permissions`, or ask), and any extra flags for the claude command line. Saved on the server, keyed by repo path like workspaces, and applied wherever canopy starts Claude for that repo: the agent and herdr openers, workspace "open all" in agent or herdr, the CLI's `canopy open`, and every run and chat. The menu shows the current settings in one line; the sheet resets them in one click.
- **Runs.** A Claude job opens a pre-flight dialog (what will happen, an optional note), then a console that follows Claude step by step: every command with its output, Claude's own remarks, and a lichen "needs you" block whenever Claude asks a question or wants permission for something outside the job (allow once, allow all for this run, or deny). While a run is going the card's leaf edge carries sap; when it waits, the edge and a top-bar pill turn lichen. Finished runs stay on the card until dismissed. A workflow that expects a change and ends without moving git status says "no change" instead of "done" (see Workflows), so a flow that found nothing to do is not mistaken for one that did something.
- **Chat.** The same console with a message box: your first message starts Claude Code in the repo, every later one continues the same session (Claude keeps the context, canopy keeps the process). Your messages sit in the timeline with Claude's replies and tool calls; permission prompts and questions work as in a run. Between turns the chip says "chat open"; **end chat** closes the conversation and Claude Code exits. A chat counts as the repo's one run at a time.
- **Right dock.** Click any repo to pin a full detail panel: file list with stage checkboxes (columns for the status letter, path, and when the file last changed on disk, newest first; click a heading to sort, drag one to reorder, type in the box to filter, or switch to **folders** for a heading per folder), inline diffs, commit box with **suggest** (Claude-written message), commit / commit+push, pull/push, openers, workspace membership, the commit log, and the repo's Claude sessions (below). Every commit in the log opens in place: the full hash (click to copy), author and time, the message body, then each file it touched with its status letter, lines added and removed, and a short bar (moss for added, rust for removed) scaled to the commit's biggest file. Click a file for the diff that commit made to it. Merges show against their first parent. The commits listed under a Claude session open the same way. Each of a panel's sections (changes, tasks, search, history, peers, preview, launch, claude, and the shells along its foot) folds by its heading, remembered per repo, and the open panels themselves come back after a reload. Panels stack side by side, so on an ultrawide you can hold half a dozen repos open at once. Or set **open a repo** to **dock tabs** and the dock is one panel with the open repos as tabs across its top: a click on a card opens or brings forward its tab, a tab's × or a middle click closes it, and the tab beside it takes over. The panels behind the strip stay live, so a shell in one keeps running while another shows.
- **Guided panel.** Settings' **level** picks how much a panel shows. **Intermediate**, what a new browser gets, is for building by talking to Claude: a plain-words status line ("2 files changed, not saved yet", "all saved and backed up", "app running"), **Run my app** and **Stop**, **Save my work**, and the shell with Claude already running in it. A panel opens its own shell when the repo has none, at either level; at intermediate that shell starts Claude. A three-step tour points at the shell, the app and the save button on first use. **show more** flips one panel to the full view until it closes. **Advanced** is the full panel everywhere. At either level the shell's tab row carries ▶/■ for the dev task, 🐞 (asks Claude to fix the app's error, with the task's last 40 lines of output) and ✓ (asks Claude to commit and push), or **set up run** when the repo has no dev task yet. A prompt goes into a Claude already running in one of the repo's shells without pressing Enter, since Claude may be in the middle of a question of its own; with none running, it opens a new shell whose Claude starts with the prompt as its first message.
- **Project bench.** ⧉ on a panel head (or on its preview, tasks or shells) brings the project to the front: its changes down the left, the running app, its shells under the app and the dev task's log beside them, all on one screen over a dimmed board. A bar along the top switches between the projects that have a panel open or a shell or task running, and picks one part to fill the bench (changes, app, shell or log). ⧉ on a part inside the bench does the same. Escape steps back one level: the part, then the bench. On a phone the bench shows one part at a time.
- **Gears.** Every panel, section, shell row and the feed has a ⚙ with its own zoom, its layout (fill the panel or the window, float in front, pop out into a window of its own), and share: copy its text, capture it as an image, or paste into it. A shell's copy is tmux's own clean text, not what the browser happened to draw. A panel's gear also reorders and hides its sections.
- **Remote activity.** Every five minutes (and once soon after start) the server fetches your own remotes of every local repo in the background. A remote is yours when it is on GitHub and you can push to it (your login's, or an org's that grants push, asked once through gh) or when it is self-hosted (a Forgejo on the LAN, a NAS, a path). A clone of someone else's project has no remote of yours and is left alone; a fork fetches your fork and not its upstream, so a busy upstream never reads as your own activity. A fetch that moves a ref re-reads that repo, which is what keeps the behind counts honest. When one of your remotes has a branch with a commit the checkout does not (a push from another machine, a branch a cloud agent opened, a PR nobody checked out here), the card and the panel head carry a `⇣ origin/branch` chip (left out when that branch is the upstream itself, since the behind count already says so), the card's time counts it as the repo's last change, and the `recent` grouping moves the card with it; the time's tooltip names the branch. The feed reports each branch that moved. Next to it, `⇄ 2` is the repo's open pull requests on GitHub, counted in one query over every repo the gh login can see and linked to the list. Set `"fetch": false` in the config to keep the server from fetching your repos (the pull request count is a gh query, not a fetch, and keeps coming). Without gh, only self-hosted remotes count as yours.
- **Work elsewhere in the repo.** A main checkout's card also says what the repo holds outside its own tree: `⧉ agent` for a linked worktree with uncommitted changes or commits the checkout does not have (Claude's agent worktrees under `.claude/worktrees/` included, canopy's own pull request builds left out), `⑂ idea +2` for a local branch checked out nowhere with commits HEAD lacks, and `≡ 2 stashed`. Several of a kind collapse to a count, and the tooltip lists each one. The panel's changes section has a row per item, with **open** on a worktree that is a card of its own, and the feed reports a worktree's tree changing, a branch moving and the stash growing. None of it counts toward the card's own dirty state or the `activity` grouping, which stay about this checkout. In the CLI they show as `⧉1 ⑂2 ≡1` after the summary.
- **Rings.** A card whose repo Claude has worked in this month carries a thin strip along its bottom edge: one column per local day, tinted in sap by that day's API-equivalent spend on a log scale shared by the whole grove. A quiet month leaves a faint ruler; a card Claude has never touched has no strip. Hover for the month's totals. The panel shows the same strip taller, with a tooltip per day.
- **Folders.** The root path in the top bar opens the list of folders canopy scans: the one it was started on, plus any you add, each with its repo count, a rescan, and a remove. Add a folder on this machine (changes show up live through a file watcher) or one on another host over ssh: pick a host from `~/.ssh/config`, give a path (`~/dev` works) or hit **browse** to walk the folders there one level at a time (repos are marked; breadcrumbs go back up; "use this folder" fills the path), and its repos join the grove with a host tag on the card. Remote repos get status, log, diffs, stage, commit, push, pull, and AI-suggested messages the same way, every git call riding one shared ssh connection per host; they are re-read every five minutes instead of watched. The kitty, Terminal, and agent openers start an ssh session at the repo; VS Code opens it through Remote-SSH; Finder cannot. Claude runs stay local: the run action refuses a remote repo. Repos under an extra folder carry ids like `wsl-dev:web-apps/ripe` and group under the folder's label. A remote host needs key-based login, git on its PATH, and a POSIX shell.
- **Self-hosted git.** The third kind of source is a Forgejo (or Gitea) server rather than a folder: give its address and a file holding an API token, and canopy lists what the server holds through `/api/v1/user/repos`. Those repos are bare on the server, so their cards carry no working state: a dashed border, the forge's description, its default branch, and when it was last pushed to. Each one is matched against the clones already on this machine by remote url, so by default only the repos you have no clone of get a card, and the header of the folder list flips that to every repo. A clone with no web link of its own picks up the forge's page. Clicking a forge card opens that page; its ⋯ menu offers the page and the ssh clone url, and nothing else, since every git-driven route refuses a repo with no checkout. The token file's path is what gets stored, never the token; with no file named, `$CANOPY_FORGEJO_TOKEN` is read instead. The list is refreshed every five minutes.
- **Shells.** Your login shell on a real pty at the repo (an ssh session there for a remote repo), rendered by xterm.js and bridged over a websocket, opened from a card's menu (**shell**, in canopy). Where it lands is a setting: the repo's panel (a foldable section pinned along the panel's bottom edge with its own tabs and a + for another, five lines tall until you drag its top edge, each panel's shell its own height; double-click resets), the strip along the bottom of the window (one tab per shell; drag its top edge to size it, arrow keys work on it too, double-click resets), a browser tab or a small window of its own, or **auto**, the panel when the repo has one open and the strip otherwise. Closing a panel leaves its shells running: they sit in the shells picker meanwhile and come back as tabs when the panel opens again. Shells paint with the theme's own colors and follow a theme switch; a tab's × ends its shell. Shells live on the server, not the page: a reload, a closed tab or a dropped connection (the laptop asleep, the tunnel gone) leaves the shell and whatever runs in it going, and the window comes back to it, so a Claude session started in a canopy shell survives a reload. A dropped connection is rejoined on its own, first after a second and then at longer waits; a shell nobody has a tab for (opened in a window since closed) gets one where it was opened when the grove loads. With `tmux` installed, a shell survives the canopy server too: each one is a session on a tmux server of canopy's own (socket `tmux.sock` under the config dir, config `lib/tmux.conf`: no status bar, no prefix, so every key reaches the shell), each browser window on it is a client of its own, and a restarted canopy lists the sessions and hands the windows back to them, the last 2000 lines of what scrolled off ahead of the live screen. tmux draws on the terminal's normal screen, so xterm's own scrollback and mouse selection work as they would on a plain pty; the price is that tmux's copy mode and mouse handling are off. A remote repo's shell is the ssh session inside a local tmux session, so the other host needs no tmux. On a phone or tablet (a touch screen as the main pointer) a key bar sits under each shell with what a phone keyboard lacks: esc, tab, ⇧tab (Claude Code's mode), the arrows (held, they repeat), ^C, ^D, home, end, page up and down, a ⌨ that brings the keyboard up, and sticky **ctrl** and **alt**, lit until the next key from the bar or the keyboard (ctrl then `r` is ^R); the page shrinks for the on-screen keyboard rather than hiding the shells under it. A **paste** key reads the clipboard when the page is https or localhost (the tunnel, not the tailnet's plain http). A finger drag scrolls the shell (a program that owns the screen, like `less`, gets the arrows or wheel turns it would from a mouse), a flick keeps it going, and a pinch sizes the text, remembered per browser for every shell. A tap focuses the shell without bringing up the keyboard; the keyboard comes up only for the ⌨ key or a tap on a text field, anywhere in canopy, so a dialog opening or a shell connecting no longer pops it. `CANOPY_TMUX=0`, or no tmux on PATH, is the plain pty: the shell outlives its window with the last 512KB of what it wrote, and a canopy restart ends it (the tab says so and goes on the next reload).
- **Preview.** The in-app browser: a repo panel's **preview** section (folded by default) frames the repo's dev server as it runs on the backend, so a Vite or Next app started in a canopy shell shows in the panel from any device. It offers the ports whose process runs in the repo (read off `/proc` on Linux, `lsof` on a Mac), picks the one there is when there is only one, and lists the ports no repo claims or takes any port typed in; a path box, reload and ↗ (the same preview in a browser tab) sit above the frame, which is drag-resizable. Each preview is proxied on a port of its own from a small pool (`CANOPY_PREVIEW_PORTS`, default `7860-7869`, `0` for off), HTTP and websockets both, so the app sees its own origin: absolute paths and HMR work unchanged, and it cannot reach canopy's API. The proxy dials loopback only and answers only to a loopback or tailnet host name; on the tailnet a preview is plain http on its port. An https page cannot frame plain http, so behind the tunnel `CANOPY_PREVIEW_PUBLIC` (for example `https://canopy-p{slot}.beric.ca`) gives each slot a public name of its own, which `docs/deploy.md` wires up. A checkout on another backend previews through that backend's own slots. When the repo has a dev task (see Tasks), the preview offers to start it and pairs with it. What each repo previews is remembered per browser.
- **Search.** The magnifier in the top bar (or ⌘⇧F) searches file contents across every repo in view, so a narrowed grid narrows the search. It is `git grep` over tracked text files, fixed string, case-insensitive, so it works the same on a repo over ssh. Results group by repo with a count, then by file, each hit a line number and the matched line with the match lit; a repo unfolds on click and **panel** opens its dock panel with the same term in the panel's own **search** section. Clicking a hit opens the file at that line in VS Code (through `code -g`, or the Remote-SSH window for a remote repo). A repo answers at most 500 hits and says when it had more.
- **Shells picker** (`▸_ n` in the top bar, with a dot when a running shell has no tab here). Every shell the backend holds, whichever device started it: the repo, where it was opened, how long ago, and which other devices have it open. **join** puts it here as a tab (a panel shell opens its panel), **hide here** takes the tab away on this browser only and leaves the shell running for the others (a hidden shell is not taken back up on the next load), and **end** ends it on every device. Below that, **claude conversations**: pick a repo and it lists the Claude Code conversations started there on the backend, newest first, read straight off `~/.claude/projects` (the first prompt or Claude's summary, the branch, when); **resume** opens a new shell at the repo with `claude --resume <id>` and the repo's agent settings typed in, so a conversation started in any shell, on any device, carries on from another. Conversations started on a different machine live in that machine's `~/.claude` and are not listed.
- **Images into Claude.** Paste or drop an image on a shell and canopy uploads it to the backend (png, jpeg, gif or webp, up to 20MB, cleared after a week) and pastes its path, which Claude Code attaches as an image. A browser terminal only carries text, and the backend has no clipboard of its own, so this is how a screenshot from a phone reaches a Claude running on the mini.
- **Kept shells** (`⟲ n` in the top bar). With **keep shell history** on in Settings, the backend snapshots every shell's screen and history once a minute. tmux dies with a reboot; the snapshots do not. After one, the chip lists what the reboot took (repo, how long ago, lines, the agent it was running), and **restore** starts each shell again under its old name, so every saved tab and link comes back to it with the old history above the new prompt. **restore + continue** also types `claude --continue` into a shell that was running Claude. A snapshot nobody restores is forgotten after seven days.
- **Devices** (`⌘ n` in the top bar). Every browser with the page open, named from Settings' **this device** or its user agent, how long it has been on and how many windows it has, and which shell each is looking at. A run records the device that started it. Presence only labels; it grants nothing.
- **Event feed.** A strip along the bottom, above the shells, that streams every server event across every source as it happens: a file edited or reverted in a repo, a commit landing, a branch switch, a rescan with the repos that came and went by name, a source failing or recovering, a run starting, each tool it calls, the prompt it parks on and how it ended, a workflow's steps and gates, a fleet's skips. Every line says when, which source, which repo (click it to open the panel), and what. Toggle it with the list glyph in the top bar or `e`; drag its top edge to size it. The chips narrow it to one source; **quiet lines** shows the re-reads that changed nothing; the list follows the newest line until you scroll up, then holds still and counts what arrived. It holds the last 500 lines and lives for the page.
- **Top bar.** The version next to the name (hover for the commit), workspace tabs (with one-click "open all in code/kitty"), a grouping switch, a needs-attention pill that doubles as a live count, a filters pill, and a repo filter (`/` to focus, `d` to toggle needs-attention, `f` for the filter menu, `*` for favorites only, `s` to cycle grouping, `e` for the event feed, `x` for select mode). The chips beside them appear when there is something to say: running tasks, shells (`▸_ n`), devices (`⌘ n`), kept shells (`⟲ n`), backends, peers and tailchan (`✉`). On a phone the bar takes three rows, and on anything narrower than 1100px the tree becomes a drawer.
- **Filters.** The pill opens chips for status facets (changes, unpushed, behind, conflicts, off main, no upstream, unreadable) and, when the grove commits as more than one person, one chip per git identity. Each chip carries the count it would show. Lit chips in a row add up; the rows, the attention toggle, and the text box narrow each other. The pill reads "2 filters" while anything is lit so a thinned grove is never mistaken for a small one.
- **Stars and archive.** ☆ on a card or panel head stars the repo in canopy; **★ favorites only** in the filter menu (or `*`) narrows to them, and the ★ grouping puts them first. **archive** in a card's menu hides a repo you are done with, as does archiving it on GitHub; the filter menu's **hide archived** chip, on by default, brings them back when turned off.
- **Grouping.** `recent` (the default) buckets by the last change of any kind, a commit, an edit in the working tree or a commit on a remote branch the checkout does not have (today, this week, this month, this season, dormant, untouched), newest first; `folder` mirrors the disk layout; `activity` puts repos with changes first, then unpushed, behind, quiet, unreadable, each group newest change first; `name` is one flat list; `favorites` (★) puts starred repos first, then the rest, each newest change first; `user` buckets by the identity each repo commits as (`user.name` / `user.email` as git resolves them inside that repo, so a per-folder `includeIf` shows up), with "no identity" and unreadable repos last. The tree and the grid always agree, and that includes folding: click a section heading in either and it folds in both, remembered per grouping mode.
- **Settings** (gear, top right) holds where a click opens a repo (a dock panel beside the others, a tab in one dock panel, a new browser tab, or a small new window; cmd-click and shift-click always do tab and window), whether kitty and Terminal get a new window or a tab in the front one (for "open in" and the agent; canopy runs kitty as its own instance, listening socket-only, so tabs go there rather than to a kitty you started yourself; a Terminal tab needs Accessibility access for the server since it presses cmd-t), where a shell in canopy lands (auto, the panel, the strip, a new tab or window), the panel's **level** (intermediate or advanced, and the tour again), what **this device** is called in the devices list, **keep shell history** (the backend's switch, not the browser's), theme (system / dark / light, and a palette: forest, everforest, gruvbox, nord, solarized, catppuccin, tokyo night, rosé pine, dracula, vivid, neon or contrast, each with a light and a dark side and every one held to the same text contrast, and a **more contrast** switch that pulls any palette's text, lines and grounds further apart), and card density. All but keep shell history are stored per browser in localStorage. At the bottom, **about**: the server's version and commit (linked to GitHub), its host, uptime, Bun and platform, the scan root, and the build this page was bundled from, with a reload offered when the two differ (a page left open across a redeploy, or a `dist/web` older than the server). The same is `GET /api/about`; the docker image has no `.git`, so `bun run redeploy` passes the commit in as `CANOPY_COMMIT`, and `redeploy status` prints what is running.
- **Backends.** Canopy can show several backends' checkouts on one board. Give one canopy's `backends` config the others' URLs, and give each of those the first one's origin in `CANOPY_ORIGINS` (`docs/deploy.md`); a repo checked out on both machines then gets one card with a word per machine (dirty count, ahead/behind, the lead in full ink, faint and italic for one that is not answering). The panel head gets a switcher between them, and shells, runs, flows, fleets, devices and search all merge across machines with each row naming which one it is on. A **backends** chip in the top bar shows every backend's word (rust for anything but online) and opens a popover with each one's state, the URL this page is using for it, a retry, a sign-in link when the gate asked for one, and a "show here" box that hides or restores it; **Settings** gets a matching picker so desktop openers, keep-shell-history and **about** scope to one backend at a time. Workspaces, tailchan and the project library stay the page's own machine's. With one backend (the default) none of this shows, and every id is exactly what it was before.
- **Solo view.** `/?repo=<id>&view=solo` shows one repo's panel on its own; that is what the tab and window targets open. Drag either edge of the panel to size it (double-click resets); the width is shared by every solo tab in the browser. `/?repo=<id>` alone opens the full UI with that repo pinned.

Light and dark follow the OS unless the setting says otherwise, in whichever palette is picked; the shells and the Library follow both. Reduced motion respected.

## Tasks

A task is one of a repo's named processes (the dev server, tests, a typecheck, a build) that canopy runs and watches on the backend. Each one is a tmux session you can join and type into like a shell, with its output kept in a log on disk (`tasks/logs/` under the config dir, rotated when it grows) that stays searchable after the process ends.

canopy finds tasks on its own in `package.json` scripts, a `Cargo.toml` and a `Makefile`. A checked-in `.canopy/tasks.json` adds or changes them for everyone who clones the repo, and the edit sheet in the panel stores this machine's own changes in canopy's config, which win:

```json
[
  { "name": "dev", "cmd": "bun run dev", "dev": true, "keep": true, "withPanel": true },
  { "name": "e2e", "cmd": "bunx playwright test", "cwd": "web" },
  { "name": "lint", "hidden": true }
]
```

`dev` marks the task the preview pairs with, one per repo. `keep` restarts it when it fails (after 1, 2, 4 seconds and on up to a minute, giving up after five quick failures) and after the backend itself restarts. `withPanel` starts it when the repo's panel opens. `hidden` drops a detected task you do not want. `keep` and `withPanel` apply only in a repo whose remote is yours, so a project you cloned from someone else never starts a process by itself. Like shells, tasks survive a canopy redeploy.

The panel's **tasks** section lists them with start, stop, restart, a window of their own and edit. A card carries a chip for its running tasks, and the top bar lists every running task across the grove. In the project bench the tasks sit along the side and the picked one's live terminal or log fills the log pane.

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

## The shared repo spec

`spec/` is one spec for every repo canopy scans, versioned in `spec/manifest.json`: `SPEC.template.md`, a seven-section SPEC.md every repo keeps (what it is, who uses it, stack, how it is built and run, data, decisions, out of scope), and `DESIGN.md`, one visual system in Google's [DESIGN.md](https://github.com/google-labs-code/design.md) format (check it with `bunx @google/design.md@0.4.0 lint spec/DESIGN.md`). A repo adopts it with `canopy spec sync <repo>` or the bundled **spec** workflow, run on one repo or as a fleet: canopy writes marker blocks (`<!-- spec:begin vX.Y.Z -->…<!-- spec:end -->`) into SPEC.md and AGENTS.md or CLAUDE.md, DESIGN.md whole only for a repo that opts into the visual half (`--visual`), and records the version and each block's sha256 in `.canopy/spec.json`; the workflow's agent then fills in a new SPEC.md's sections. Text outside the blocks stays the repo's. The scan reads each local checkout's state: **spec text in sync**, **behind** (an older version, untouched), **drifted** (a block or DESIGN.md edited by hand) or **not adopted**. The board's filter menu has **spec drift** and **no spec** chips, and the select bar can pick by them, so a fleet of the spec workflow brings every drifted repo up to date. "In sync" means the text matches, not that the code follows DESIGN.md. Bump the version in the manifest whenever the spec changes; every adopted repo then reads as behind.

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

## tailchan

When the backend knows a [tailchan](../../homelab/services/tailchan) broker (`CANOPY_TAILCHAN_URL`, `TAILCHAN_URL`, or the CLI's own `~/.config/tailchan/env`), the top bar gets **✉**: the channels and DMs the UI's handle (`CANOPY_TAILCHAN_AS`, else `TAILCHAN_HUMAN`) is in, a composer, file drops, the clipboard both ways, and who has been around. Messages also land in the event feed. Every shell started then runs with `TAILCHAN_AS=<repo>-<4 hex of its id>`, so a Claude session inside it answers to that name, and the shells picker has a **message** button for it. A checkbox in the popover has canopy post its runs, flows and fleets to `#canopy`, and DM you when a prompt or a gate waits on you. Without a broker none of this shows. See `docs/deploy.md` for the container on the mini.

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

## Project library and dev servers

Canopy includes `_devhub`'s workspace-management features. Run
`canopy ui ~/dev` and choose **library** or **ports** beside **git** in the top bar.
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

## A public name

For an authenticated HTTPS reverse proxy, set `CANOPY_PUBLIC_ORIGIN` to its
exact origin (for example `https://canopy.beric.ca`) in the server environment.
Library requests then accept that host with `X-Forwarded-Proto: https`, while
retaining same-origin checks. Bun still binds only to loopback. Authentication
must remain enabled on the proxy; this setting does not provide authentication.
The shared backend on the mini serves `canopy.beric.ca` through the compose
`tunnel` service (a Cloudflare Tunnel under the `tunnel` profile, with
Cloudflare Access protecting the hostname); see "A public name" in
`docs/deploy.md`. The older macOS deployment ran as `ca.beric.canopy-server`.

## State

- Config + workspaces: `~/.config/canopy/config.json` (override dir with `$CANOPY_CONFIG_DIR`). `historyBin` there points at the claude-history CLI when it is not on PATH; `fetch: false` turns the background fetch of your own repos off.
- Generated workspace files (`.code-workspace`, kitty sessions): `~/.config/canopy/workspaces/`.
- Next to the config: `tmux.sock` (the shells' tmux server), `shells/` (kept-shell snapshots, 0600), `pastes/` (images pasted into shells), `tasks/state.json` and `tasks/logs/` (what each task wants, how it last exited, its output).
- Per-browser preferences (grouping, where a click opens, theme, level, text sizes, which sections show) live in that browser's localStorage, along with the open panels and shell tabs.
- Workspaces store absolute repo paths, so they work from any scan root. A repo on another host is stored as `ssh://<host><path>`.
- Agent settings live under `agents` in the same config, keyed the same way; a repo set back to the defaults loses its entry. Launch settings live under `launchers` the same way.
- Installed releases, pull request worktrees, launch counts and launch logs: `~/.config/canopy/builds/<owner>/<name>/` by the repo's GitHub slug (`_local/<name>-<hash>` for a repo without one), with a `state.json` per repo.
- Extra folders live under `sources` in the same config, each with an id, a label, a kind (`local`, `ssh` or `forgejo`), the host for ssh, and the absolute path, or for a forge its address and the path of the file holding its API token. The launch root is never stored. ssh control sockets sit next to the config as `ssh-*`.

## Development

```bash
bun run dev        # API on :7850
bun run dev:web    # Vite dev server on :7851 (proxies /api)
bun run typecheck && bun run lint && bun test && bun run build
```
