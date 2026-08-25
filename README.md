# canopy

A multi-repo git cockpit: point it at a directory and see every git repo under it as a live tree — then drill into changes, stage, commit (with AI-suggested messages), push, open repos in kitty / Terminal / VS Code / Finder, and group them into named workspaces. Web UI + full CLI.

The write-capable, many-repo complement to [diffscope](../diffscope) (single-repo, read-only).

## TL;DR

- **What:** one screen for the whole grove — every repo's branch, dirty files, ahead/behind, and last-commit age, live-updated as the filesystem changes.
- **How:** a Bun server scans for `.git` dirs, shells out to `git`, watches the root recursively, and streams updates to a React SPA over SSE. Commit messages come from the `claude` CLI (heuristic fallback). Whole jobs (commit, push, deploy, anything you type) drive the same CLI over stdio, with permission prompts and questions relayed to the browser.
- **Stack:** Bun + TypeScript (strict) server, React 19 + Vite + Zustand SPA, zero CSS frameworks. `bun test`, `tsc --noEmit`, `oxlint`.
- **Run:** `bun install && bun run build && bun link`, then `canopy ui ~/dev`.

## CLI

```bash
canopy [dir]                       # tree of every repo under dir (default: .)
canopy status [dir]                # only repos that need attention
canopy ui [dir] [--port N]         # web UI at http://127.0.0.1:7850
canopy commit <repo> -m "msg"      # commit staged changes
canopy commit <repo> --ai --all --push   # AI message, stage everything, push
canopy suggest <repo>              # print an AI-suggested commit message
canopy push <repo> | pull <repo>
canopy open <repo> --app kitty     # kitty | terminal | code | finder
canopy ws                          # list workspaces
canopy ws create <name> <dirs...>  # group repos
canopy ws open <name> --app code   # one multi-root VS Code window
canopy ws open <name> --app kitty  # one kitty window, a tab per repo
```

## Web UI

- **Left rail** — the repo tree grouped by topic folder, with dirty counts rolled up. Drag its edge to resize; the panel-left button (or `[`) folds it away.
- **Center** — a dense card grid (auto-fills columns; ~16 across on a 7680px screen). Cards pulse when a repo changes on disk. Every card has a ⋯ menu: hand a job to Claude (commit, push, commit and push, deploy, ask claude…) or open the repo in kitty / Terminal / VS Code / Finder.
- **Runs** — a Claude job opens a pre-flight dialog (what will happen, an optional note), then a console that follows Claude step by step: every command with its output, Claude's own remarks, and a lichen "needs you" block whenever Claude asks a question or wants permission for something outside the job (allow once, allow all for this run, or deny). While a run is going the card's leaf edge carries sap; when it waits, the edge and a top-bar pill turn lichen. Finished runs stay on the card until dismissed. A commit or push that ends without moving git status says "no change" instead of "done", so a run that found nothing to do is not mistaken for one that did something.
- **Right dock** — click any repo to pin a full detail panel: file list with stage checkboxes, inline diffs, commit box with **suggest** (Claude-written message), commit / commit+push, pull/push, openers, workspace membership, the commit log, and the repo's Claude sessions (below). Every commit in the log opens in place: the full hash (click to copy), author and time, the message body, then each file it touched with its status letter, lines added and removed, and a short bar (moss for added, rust for removed) scaled to the commit's biggest file. Click a file for the diff that commit made to it. Merges show against their first parent. The commits listed under a Claude session open the same way. Panels stack side-by-side — on an ultrawide you can hold half a dozen repos open at once.
- **Rings** — a card whose repo Claude has worked in this month carries a thin strip along its bottom edge: one column per local day, tinted in sap by that day's API-equivalent spend on a log scale shared by the whole grove. A quiet month leaves a faint ruler; a card Claude has never touched has no strip. Hover for the month's totals. The panel shows the same strip taller, with a tooltip per day.
- **Top bar** — workspace tabs (with one-click "open all in code/kitty"), a grouping switch, a needs-attention pill that doubles as a live count, a filters pill, and a repo filter (`/` to focus, `d` to toggle needs-attention, `f` for the filter menu, `s` to cycle grouping).
- **Filters** — the pill opens chips for status facets (changes, unpushed, behind, conflicts, off main, no upstream, unreadable) and, when the grove commits as more than one person, one chip per git identity. Each chip carries the count it would show. Lit chips in a row add up; the rows, the attention toggle, and the text box narrow each other. The pill reads "2 filters" while anything is lit so a thinned grove is never mistaken for a small one.
- **Grouping** — `folder` mirrors the disk layout; `activity` puts repos with changes first, then unpushed, behind, quiet, unreadable; `recent` buckets by last commit (today, this week, this month, this season, dormant); `name` is one flat list; `user` buckets by the identity each repo commits as (`user.name` / `user.email` as git resolves them inside that repo, so a per-folder `includeIf` shows up), with "no identity" and unreadable repos last. The tree and the grid always agree, and that includes folding: click a section heading in either and it folds in both, remembered per grouping mode.
- **Settings** (gear, top right) — where a click opens a repo (dock panel, new tab, or a small new window; cmd-click and shift-click always do tab and window), theme (system / dark / light), and card density. Stored per browser in localStorage.
- **Solo view** — `/?repo=<id>&view=solo` shows one repo's panel edge to edge; that is what the tab and window targets open. `/?repo=<id>` alone opens the full UI with that repo pinned.

Light and dark themes follow the OS unless the setting says otherwise. Reduced motion respected.

## Claude runs

Each run is one Claude Code session in the repo's directory: canopy spawns the `claude` binary on your PATH in print mode with stream-json on stdin and stdout, so it runs on whatever your terminal `claude` runs on (a Claude Max login included), with no SDK and no API key. It loads your user and project settings and CLAUDE.md files the way a terminal session would, but no MCP servers. Each action pre-allows only the commands its name promises (commit: `git add`/`git commit`; push: `git push`; deploy: `bun run`, `bun test`, and friends) plus read-only git; anything else asks in the console. Runs live in server memory: the last 60 finished ones stay visible until dismissed or the server restarts. One run per repo at a time.

## Claude sessions

Every session Claude Code has ever run in a repo, not only the ones canopy started, comes from [claude-history](../claude-history): the per-project archive and index of transcripts, prompts, tool calls, tokens, cost and the commits made while a session was running, from this Mac, the other hosts it pulls, and claude.ai/code. canopy shells out to that CLI's `--json` reports and never opens its sqlite file, so the archive's schema stays its own business.

The panel's **claude** section shows the all-time session count and API-equivalent spend, the rings, then the sessions themselves: newest first, the last 30 / 90 days or all of them, each row a title (or the first prompt), where it ran when that was not this machine, and what it cost. Open a row for the session turn by turn: your prompt, Claude's reply, and the tools it used, with the commits made during the session underneath. **open note** opens the session's markdown note from the memory vault in Obsidian (or whatever opens markdown). The search box runs the archive's full-text search over this repo's sessions; matches come back as rows with the matching passage.

canopy finds the CLI at `historyBin` in its config, else `claude-history` on PATH, else `~/dev/dev-tools/claude-history/bin/claude-history`. Without it the rings stay off and the section says why. The overview (every repo's totals and days) is two CLI calls, cached for five minutes and rebuilt after a rescan; the archive itself is refreshed by claude-history's own hourly sync, so a session shows up here within the hour after it ends. Dollar figures are list-price API equivalents of the tokens, as claude-history counts them, not a bill.

## State

- Config + workspaces: `~/.config/canopy/config.json` (override dir with `$CANOPY_CONFIG_DIR`). `historyBin` there points at the claude-history CLI when it is not on PATH.
- Generated workspace files (`.code-workspace`, kitty sessions): `~/.config/canopy/workspaces/`.
- Workspaces store absolute repo paths, so they work from any scan root.

## Development

```bash
bun run dev        # API on :7850
bun run dev:web    # Vite dev server on :7851 (proxies /api)
bun run typecheck && bun run lint && bun test && bun run build
```
