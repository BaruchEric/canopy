# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

canopy — multi-repo git cockpit (Bun + TS server, React 19 + Vite SPA, full CLI). See README.md for commands and features.

## Commands

- Gates: `bun run typecheck && bun run lint && bun test && bun run build` — all four before calling anything done. Build is required: the server serves `dist/web`, so a stale build shows stale UI.
- Redeploy the mini's shared backend: `bun run redeploy` (`status`, `log`, `--pull`, `--shells`), from the Mac, a canopy shell on the mini, or the mini itself; `scripts/redeploy.sh`, the `redeploy` skill, and `docs/deploy.md`.
- Single test file: `bun test src/core/git.test.ts`
- Dev: `bun run dev` (API :7850) + `bun run dev:web` (Vite :7851, proxies /api). Production mode is the built SPA served by the Bun server on :7850 only.
- Shared-backend mode: canopy runs headless in docker compose on the mini (`canopy`, `shells` holding the tmux server, `stages` for the incubator's agents, `tunnel` under its profile). See `docs/deploy.md`, `docs/prd-shared-backend.md` and "Shared-backend mode" in `docs/architecture.md`.

## Architecture

The per-module detail lives in `docs/architecture.md`, one section per area. Read the section for the code you touch before changing it, and when a change makes it wrong, update that file, not this one. This file stays short because Claude Code caps the combined size of instruction files.

- `src/core/` — pure logic, no HTTP: locators and ssh, git, scan, runs and their drivers (Claude and Codex), shells on tmux, workflows and flows, peers, launcher, search, history. Section "src/core".
- `src/server/` — Bun.serve: REST + SSE (`/api/events`) + static, one `SourceRuntime` per scanned folder. Section "src/server".
- `src/cli/` — `bin/canopy.ts` entry; `render.ts` paints `src/core/treelines.ts` lines (the tree, shared with the UI's command line) as ANSI.
- `ui/` — React SPA, separate tsconfig, one Zustand store in `ui/src/store.ts`, server types imported from `src/core/types.ts` (keep that file browser-safe: no Bun/node imports). Sections "ui/", "Gears", "The project bench", "The guided panel", "Layout and motion".
- Feature areas with their own sections: the command line, the in-app browser (preview), tailchan, the agent registry, asks and the inbox, guards and hand-off, tasks, the incubator, the Library, version, harnesses and routing, Codex headless.
- Repo **ids** are paths relative to the scan root (prefixed `<source id>:` under an extra source); **workspaces store absolute paths** (stable across roots; a remote repo's is its `ssh://` locator). The API accepts ids and converts at the edge (`idToPath` in server).

## Conventions & gotchas

- `git status --porcelain=v2` paths are never quoted; fields split on single spaces with the path last (`splitN`). Rename entries carry `path\torig`.
- Untracked-file diffs use `git diff --no-index /dev/null <file>`, which exits 1 on success — don't treat that as an error.
- `unpack` attaches a dmg through a hard link without the `.dmg` extension (`Stub.image`), `-nobrowse` on a private mountpoint, and retries with `-imagekey diskimage-class=CRawDiskImage` when hdiutil says "image not recognized" (a raw image is only told apart by its extension). The link is what keeps "Install this app?" helpers quiet: Vorssaint's disk image installer on this Mac sees every mount, even `-nobrowse` ones, and offers to install the one app on any mount whose `hdiutil info` image path ends in `.dmg`. The launcher tests build their fixture image mount-free (`makehybrid`, then `convert` to UDZO) for the same reason, and unregister the stub app bundle the `open -W` test hands to Launch Services, since the entry outlives the scratch dir.
- Remote repos assume a POSIX shell, key-based login, and git on the non-interactive PATH of the host (the QNAP has no git, so it can be added but every card there errors). `remoteCommand` single-quotes each argv word; `tildeQuote` keeps a leading `~` bare so the remote expands it. Openers for a remote path run `ssh -t host 'cd … && …'` (kitty, Terminal, agent) or `code --folder-uri vscode-remote://ssh-remote+host/path`; Finder throws.
- SSE clients buffered through some proxies/sandboxes may look silent; verify reactivity in a real browser before debugging the watcher (the watcher path was correct all along the one time this came up).
- Runs deliberately do not use `@anthropic-ai/claude-agent-sdk` (it was tried and rolled back): jobs must run on the user's own `claude` install and Max login. The runner spawns `claude -p --input-format stream-json --output-format stream-json --permission-prompt-tool stdio`; the prompt goes down stdin as a `user` message, permission requests come back as `control_request` (`subtype: can_use_tool`) and are answered with a `control_response` carrying `{behavior, updatedInput}`. `AskUserQuestion` arrives the same way and is answered by returning `updatedInput.answers`. Stdin must stay open until the `result` message (the CLI exits once it is closed, and a permission request after that fails) and until canopy's own control requests (`set_permission_mode`) settle; a `result` that arrives while a background subagent (`task_type: local_agent`) still runs is held and stdin stays open until the real one (the turn the subagents wake, or `heldGraceMs` after they finish if none begins), while a background shell never holds one. A chat keeps it open past the result and writes the next `user` message to continue the session. `--setting-sources user,project,local` so CLAUDE.md and permission rules apply (an incubator stage takes `user` alone); MCP servers are off (`--strict-mcp-config` with no `--mcp-config`).
- claude-history's `--json` shapes are passed through as-is (snake_case types in `types.ts`); its README calls them an API for canopy's sake, so change both sides together. Its CLI answers a bad lookup as plain text with exit 0; `report()` in history.ts turns that into a 404. Days are local: the CLI buckets with sqlite `localtime` and canopy builds the day list with the OS clock, which agree in the server but not under `bun test` (Bun pins JS Dates to UTC there), so tests pass explicit dates.
- Design system lives entirely in `ui/src/styles.css` (bark/moss/lichen/rust/sky tokens as `light-dark()` pairs; the theme setting only flips `color-scheme` via `data-theme` on `<html>`). No CSS framework — keep it that way.
- A fleet resolves its workflow once, from the bundled and user sources only (not a repo's own `.canopy/workflows/`), since a fleet runs the same file over every repo it touches and a repo-local override would make that not true. `loadWorkflows` skips the repo source whenever `repo.host` is truthy (it assumes a remote repo, no local `.canopy/`), so the server asks with `loadWorkflows({ path: "", host: "none" })` — a fake host, not a fake path, is what actually suppresses it.
- The peer gate (`canopy peers gate`, what a peer's forced ssh command runs) clears every `GIT_*` variable from its own process env before doing anything else, since those are git's own env-config channel (`GIT_CONFIG_PARAMETERS`, `uploadpack.packObjectsHook`, and the like) and left in place would let a peer who can influence this process's environment run something the moment `git-upload-pack` or an in-process `git()` call touches the working tree. It then hands `git-upload-pack` an explicit minimal env of its own (`PATH`, `HOME`, `GIT_PROTOCOL` and `LANG`/`LC_ALL` when set) rather than the process environment, reads the serving machine's config read-only (no quarantine-and-rename), and refuses every command on a config it cannot read or parse rather than falling back to defaults. `sshd` must not `AcceptEnv` `GIT_*` or `BUN_*` for the same reason. The default accepts only `LANG`/`LC_*`, and `BUN_OPTIONS=--preload` reaching the gate would run code before it does.

<!-- spec:begin v1.0.0 -->
This repo follows the shared repo spec, version 1.0.0.
- Read SPEC.md before changing how the project is built, run or stored, and keep it true when you do.
- Read DESIGN.md (when the repo has one) before adding or changing any UI.
- DESIGN.md applies to UI you add or change in this task. Do not restyle existing screens unless the task asks for it.
- Text between the spec:begin and spec:end markers is generated by canopy. Do not edit it by hand.
<!-- spec:end -->
