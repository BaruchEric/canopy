# canopy

<!-- spec:begin v1.0.0 -->
How to keep this file (shared repo spec 1.0.0):
- SPEC.md says what this repo is, how it is built and why. It is the first file a person or an agent reads.
- Keep the seven sections below, in this order, under the same headings. Write "none" rather than drop one.
- Sections 1, 3 and 4 are required: what it is, the stack with versions, and the exact commands to build, test and run.
- Stay under 120 lines. Link to longer docs rather than copying them here.
- Decisions are dated one-liners with their why: "2026-10-04: Bun over Node, because the CLI starts faster."
- Update SPEC.md in the same commit as the change that makes it wrong.
- Out of scope lists what this repo will not do, so an agent does not add it.
- Commands are written as they are typed, one per line, from the repo root.
- Name versions as the lockfile has them, not "latest".
- No secrets, tokens or hostnames that are private.
<!-- spec:end -->

## What it is

A workbench for building software with Claude across every repo and machine you have: a live board of every git repo under a folder, shells that outlive the page, and Claude Code run as shells, jobs, chats and workflows. Web UI and a full CLI.

## Who uses it

One developer (the owner) across a laptop, an always-on Linux backend, a tablet and a phone, all on one tailnet. Agents use it too: Claude sessions run inside its shells and drive it through the CLI and the HTTP API. It is not built for teams. A public name is served only behind an authenticating proxy (Cloudflare Access), since canopy has no sign-in of its own.

## Stack and versions

- Bun 1.4.2 runs the server, the CLI and the tests (`bun test`).
- TypeScript 7.0.2, `strict` in both `tsconfig.json` and `ui/tsconfig.json`.
- React 19.3.0, Zustand 5.0.15, Vite 8.3.2 with @vitejs/plugin-react 6.1.1 for the SPA.
- @xterm/xterm 6.0.0 for shells; tmux on the backend keeps them alive.
- ai 7.0.127 and @ai-sdk/gateway 4.0.103 for commit message suggestions.
- oxlint 1.86.0 for lint.
- Plain CSS in `ui/src/styles.css`; no CSS framework.
- git, gh and the `claude` CLI are shelled out to, never linked.

## How it is built and run

```
bun install
bun run typecheck
bun run lint
bun test
bun run build
bun link
canopy ui ~/dev
```

- Development: `bun run dev` (API on :7850) and `bun run dev:web` (Vite on :7851, proxying `/api`).
- Production: the Bun server on :7850 serves the built `dist/web`, so a stale build shows a stale UI.
- Shared backend: docker compose (`canopy`, `shells`, `stages`, and `tunnel` under its profile). Deploy committed `main` with `bun run redeploy`; `bun run redeploy status` says what is running. See `docs/deploy.md`.
- Run `bun test` with `SHELL=/bin/bash` when an interactive zsh config slows shells down.

## Data and state

- Config, workspaces, sources, agent and launch settings: `~/.config/canopy/config.json`, or `$CANOPY_CONFIG_DIR`.
- Next to it: `tmux.sock` (the shells' tmux server), `shells/` (kept-shell snapshots), `pastes/`, `tasks/` (state and logs), `builds/` (installed releases and PR worktrees), `library/<root-hash>/` (the project library).
- In a repo: `.canopy/tasks.json`, `.canopy/workflows/` and `.canopy/spec.json`, all checked in by that repo's owner.
- Per browser: preferences, open panels and shell tabs in localStorage.
- Runs live in server memory; the last 60 finished ones stay until a restart.
- Session history is read from claude-history's CLI (`--json`), never its sqlite file.
- No database of its own: git and the files above are the state.

## Decisions

- 2026-08-03: Shell out to `git` and parse porcelain v2, because the same call then runs locally or over ssh for a remote repo.
- 2026-08-24: Drive the user's own `claude` binary over stream-json, not the Agent SDK, because jobs must run on the user's Max login and settings (the SDK was tried and rolled back).
- 2026-08-24: No CSS framework; one stylesheet of `light-dark()` tokens, because themes only flip `color-scheme`.
- 2026-09-11: The devhub library moved into canopy, because one engine and one dashboard beat two copies of the data.
- 2026-09-21: Shells are tmux sessions on canopy's own server, because a shell must outlive a reload and a canopy restart.
- 2026-09-22: Headless shared backend in containers, with shells in a container of their own, because a redeploy must not kill open shells.
- 2026-09-24: Peers sync over git only, pull-only and fast-forward only, because work should move between machines through commits, never file copies.
- 2026-10-09: canopy takes only the doc half of the shared spec and keeps its design system in `ui/src/styles.css`, because its own palettes and tokens predate the shared DESIGN.md and differ from it.

## Out of scope

- Hosting git or replacing GitHub or Forgejo; canopy reads them.
- Multi-user accounts, permissions or teams.
- Calling the Anthropic API directly or storing API keys for Claude.
- Running a cloned third-party repo's tasks on its own.
