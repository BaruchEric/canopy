# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

canopy — multi-repo git cockpit (Bun + TS server, React 19 + Vite SPA, full CLI). See README.md for commands and features.

## Commands

- Gates: `bun run typecheck && bun run lint && bun test && bun run build` — all four before calling anything done. Build is required: the server serves `dist/web`, so a stale build shows stale UI.
- Single test file: `bun test src/core/git.test.ts`
- Dev: `bun run dev` (API :7850) + `bun run dev:web` (Vite :7851, proxies /api). Production mode is the built SPA served by the Bun server on :7850 only.

## Architecture

- `src/core/` — pure logic, no HTTP: scan (find `.git` dirs, never descend below a repo root), git (porcelain-v2 parsing, all mutations), suggest (claude CLI shellout with heuristic fallback), openers (macOS `open`-based launchers + .code-workspace/kitty-session generation), store (config at `~/.config/canopy`, overridable via `$CANOPY_CONFIG_DIR` — tests rely on this), actions (browser-safe: labels, preconditions, and prompts for the Claude-driven actions; tested), runner (Bun-only: spawns the `claude` binary per run with stream-json on both ends, folds its messages into a plain `Run`, parks on permission/question prompts until `answer()`; on end, re-reads status and sets `outcome` changed/unchanged via `statusFingerprint`).
- `src/server/` — Bun.serve: REST + SSE (`/api/events`) + static. One recursive `fs.watch` on the scan root maps changed paths to the longest-matching repo id, debounces 400ms, re-reads status, broadcasts. Runs: `POST /api/repos/run?id=` starts one, `/api/runs` lists, `/api/runs/answer|stop` and `DELETE /api/runs?id=` drive it; every change broadcasts the whole `Run` as a `run` event (`run-gone` on dismiss).
- `src/cli/` — `bin/canopy.ts` entry; `render.ts` holds the ANSI tree renderer.
- `ui/` — separate tsconfig (both are typechecked). State in one Zustand store (`ui/src/store.ts`); server types imported directly from `src/core/types.ts` — keep that file browser-safe (no Bun/node imports). Per-browser preferences (grouping, open target, theme, density) live in `ui/src/settings.ts` under localStorage `canopy.settings`; grouping logic is pure in `ui/src/grouping.ts` (tested). `ui/src/routes.ts` reads `?repo=&view=solo`, which renders one panel edge to edge for the new-tab / new-window targets. `RepoMenu` is the per-card ⋯ menu (portal-rendered, keyboard-navigable); `RunSheet` is the one modal (pre-flight, then the run console); `RunChip` is the run's word on a card or panel. The store keeps `runs` by id and `sheet` for what the modal shows.
- Repo **ids** are paths relative to the scan root; **workspaces store absolute paths** (stable across roots). The API accepts ids and converts at the edge (`idToPath` in server).

## Conventions & gotchas

- `git status --porcelain=v2` paths are never quoted; fields split on single spaces with the path last (`splitN`). Rename entries carry `path\torig`.
- Untracked-file diffs use `git diff --no-index /dev/null <file>`, which exits 1 on success — don't treat that as an error.
- SSE clients buffered through some proxies/sandboxes may look silent; verify reactivity in a real browser before debugging the watcher (the watcher path was correct all along the one time this came up).
- Runs deliberately do not use `@anthropic-ai/claude-agent-sdk` (it was tried and rolled back): jobs must run on the user's own `claude` install and Max login. The runner spawns `claude -p --input-format stream-json --output-format stream-json --permission-prompt-tool stdio`; the prompt goes down stdin as a `user` message, permission requests come back as `control_request` (`subtype: can_use_tool`) and are answered with a `control_response` carrying `{behavior, updatedInput}`. `AskUserQuestion` arrives the same way and is answered by returning `updatedInput.answers`. Stdin must stay open until the `result` message (the CLI exits once it is closed). `--setting-sources user,project,local` so CLAUDE.md and permission rules apply; MCP servers are off (`--strict-mcp-config` with no `--mcp-config`).
- Design system lives entirely in `ui/src/styles.css` (bark/moss/lichen/rust/sky tokens as `light-dark()` pairs; the theme setting only flips `color-scheme` via `data-theme` on `<html>`). No CSS framework — keep it that way.
