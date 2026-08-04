# canopy

A multi-repo git cockpit: point it at a directory and see every git repo under it as a live tree — then drill into changes, stage, commit (with AI-suggested messages), push, open repos in kitty / Terminal / VS Code / Finder, and group them into named workspaces. Web UI + full CLI.

The write-capable, many-repo complement to [diffscope](../diffscope) (single-repo, read-only).

## TL;DR

- **What:** one screen for the whole grove — every repo's branch, dirty files, ahead/behind, and last-commit age, live-updated as the filesystem changes.
- **How:** a Bun server scans for `.git` dirs, shells out to `git`, watches the root recursively, and streams updates to a React SPA over SSE. Commit messages come from the `claude` CLI (heuristic fallback).
- **Stack:** Bun + TypeScript (strict) server, React 19 + Vite + Zustand SPA, zero CSS frameworks. `bun test`, `tsc --noEmit`, `oxlint`.
- **Run:** `bun install && bun run build && bun link`, then `canopy ui ~/Arik/dev`.

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

- **Left rail** — the repo tree grouped by topic folder, with dirty counts rolled up.
- **Center** — a dense card grid (auto-fills columns; ~16 across on a 7680px screen). Cards pulse when a repo changes on disk. Hover a card for quick open-in buttons.
- **Right dock** — click any repo to pin a full detail panel: file list with stage checkboxes, inline diffs, commit box with **suggest** (Claude-written message), commit / commit+push, pull/push, openers, and workspace membership. Panels stack side-by-side — on an ultrawide you can hold half a dozen repos open at once.
- **Top bar** — workspace tabs (with one-click "open all in code/kitty"), a needs-attention filter, and fuzzy repo filter (`/` to focus, `d` to toggle dirty-only).

Light and dark themes follow the OS. Reduced motion respected.

## State

- Config + workspaces: `~/.config/canopy/config.json` (override dir with `$CANOPY_CONFIG_DIR`).
- Generated workspace files (`.code-workspace`, kitty sessions): `~/.config/canopy/workspaces/`.
- Workspaces store absolute repo paths, so they work from any scan root.

## Development

```bash
bun run dev        # API on :7850
bun run dev:web    # Vite dev server on :7851 (proxies /api)
bun run typecheck && bun run lint && bun test && bun run build
```
