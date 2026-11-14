# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

canopy is a workbench for building software with Claude across many repos and machines. A Bun server finds every git repo under the folders it is given, streams their state to a React SPA, keeps shells alive on tmux, and drives the user's own `claude` (or `codex`) binary for jobs, chats and workflows. A CLI (`canopy`) does everything the UI does. SPEC.md is the one-page summary of stack, state and decisions; read it first.

## Commands

```bash
bun install
bun run typecheck          # tsc for the server (tsconfig.json) and the SPA (ui/tsconfig.json)
bun run lint               # oxlint over src, ui/src, bin
bun test                   # every *.test.ts under src and ui/src
bun test src/core/git.test.ts          # one file
bun test src/core/git.test.ts -t "name"  # one test by name
bun run build              # vite build of ui/ into dist/web
```

- All four gates (typecheck, lint, test, build) pass before work counts as done. The build matters: the server serves `dist/web`, so a stale build shows a stale UI.
- Dev: `bun run dev` (API on :7850, restarts on change) plus `bun run dev:web` (Vite on :7851, proxying `/api` and `/library` to :7850).
- Production locally: `bun run build && bun link`, then `canopy ui ~/dev`. On the Mac a launchd agent keeps a server on :7850.
- Browser check where there is no Chrome (canopy's own containers): `bash scripts/browser/setup.sh` installs a headless Chromium under `/tmp/canopy-browser` without root, and `bash scripts/browser/check.sh` drives the built page from a scratch server, building it first when `dist/web` is missing or older than the source: the first load, every view, a phone (the top bar's first row, a panel's section tabs, field sizes), the runs pill's menu, the manager view (a goal kept in the run log opens as ended; a live goal with three cards at 1440, 900 and 390 px, with its equip sheet on a phone; the new goal's box at 1440 and 390 px, its `@` menu and a file's chip, and the top bar's entry to it), a shell, and the two load failures. `scripts/browser/run.sh <script.ts>` runs any other Playwright script there. On a Mac, setup.sh does not run (it needs apt); make a folder with `playwright@1.65.0` installed by bun, an empty `fonts.conf`, `launch.ts` copied in and `browsers` linked to `~/Library/Caches/ms-playwright`, then run `run.sh` with `CANOPY_BROWSER_DIR` set to it. `launch.ts` takes the newest headless shell there for the Mac's platform.
- The shared backend on the mini (docker compose) deploys committed `main` with `bun run redeploy` (`status`, `log`, `--pull`, `--shells`, `--restart`, `--force`). From the Mac, `bun run redeploy desoto` does the same for the De Soto backend, which pulls from GitHub, so push first, and `all` does both. See `docs/deploy.md` and the `redeploy` skill.
- A change the backend or the page serves ships with its deploy. After the push, run `bun run build` so the Mac's server on :7850 serves the new page, then `bun run redeploy` for the mini (`all` when De Soto should get it too). Never pass `--force` unasked: without it the redeploy stops with exit 4 while a run, flow or landing is live (retry when they finish, and say so), and with it they are cut off. Restarting the Mac's launchd server locks the secrets key until Eric unlocks it, so restart it only when server code changed and name the unlock under Blocked by me. Eric typed a deploy prompt in this repo 65 times in the 120 days to 2026-11-11.
- A backend's stage runner signs in to claude with a year-long token: `bun run stage-token [mini | desoto | here] [stages | coord | all]` mints one and saves it on the host. It needs a real terminal and a person to click "Authorize" in the browser. The health checks "stages' claude login" and "coordinator's claude login" say when one is due.

## Architecture

Four entry points share one core:

- `src/core/` holds the logic and the types, with no HTTP. Most files are pure and tested. Files that need Bun (pty, spawn, fs) usually say so in their header comment.
- `src/server/index.ts` is the Bun.serve app: REST, an SSE stream at `/api/events`, websockets for shells, and the static SPA. Every request goes through `route()`, which checks the caller token, the origin and auth before any handler runs. The other files in `src/server/` are feature modules the index wires in.
- `src/cli/index.ts` (entry `bin/canopy.ts`) is the CLI. Most commands are HTTP calls to a running backend (`--backend`, else `$CANOPY_API`, else `127.0.0.1:7850`) carrying an `X-Canopy-Token` header (`src/cli/api.ts`). `canopy ui` starts the server itself.
- `ui/` is the React 19 SPA: one Zustand store in `ui/src/store.ts`, components in `ui/src/components/`, pure helpers beside the store with their own tests.
- `src/stage/`, `src/egress/` and `src/secrets/` are separate processes bundled into their own containers (the incubator's stage runner, the coordinator's egress proxy, the secret store service).

How the main pieces fit:

- **Repos and git.** A repo's locator is an absolute path or `ssh://<host><path>`. `core/exec.ts` runs a command locally or over ssh by locator, so git code never knows where a repo lives. git is shelled out to and its porcelain v2 output parsed in `core/git.ts`. The server holds one `SourceRuntime` per scanned folder, watches local sources with `fs.watch`, polls ssh and Forgejo sources, and broadcasts each changed repo over SSE.
- **Runs.** `core/runner.ts` owns live runs (one per repo at a time). A `RunDriver` (`core/driver.ts`) owns one run's process and wire: `claudedrive.ts` speaks Claude Code's stream-json over stdio, `codexrun.ts` speaks Codex's app-server JSON-RPC. Permission requests and questions park the run as a prompt the browser answers. A flow (`core/flow.ts`) runs a workflow file (`core/workflow.ts`, markdown with one `##` per step) as a chain of ordinary runs with checks and gates between steps.
- **Shells.** `core/term.ts` bridges a pty to a websocket. Shells are tmux sessions on canopy's own tmux server (`tmux.sock` in the config dir), so they outlive a reload and a server restart. In compose, that tmux server lives in the separate `shells` container so a redeploy leaves it running.
- **Several backends, one page.** A page talks to every backend in the registry, not only the one that served it. IDs the UI holds are prefixed with the backend name (`ui/src/backends.ts`). Peers keep each machine's clones in step over git, pull-only and fast-forward only (`core/peers.ts`, `core/peersync.ts`).
- **State.** There is no database. Config and every feature's state are files under `~/.config/canopy/` (or `$CANOPY_CONFIG_DIR`), per-repo settings are checked-in files under a repo's `.canopy/`, and live runs sit in server memory. SPEC.md "Data and state" lists every file.

## Conventions

- Strict TypeScript with `noUncheckedIndexedAccess` and `verbatimModuleSyntax` in both tsconfigs. Imports are relative; there is no path alias.
- The UI imports server types and pure helpers straight from `src/core/` (`types.ts`, `peers.ts` and others). A file the UI imports must stay browser-safe: no Bun or node imports.
- Styling is one stylesheet, `ui/src/styles.css`, with `light-dark()` tokens. No CSS framework, and the theme setting only flips `color-scheme`.
- oxlint enforces `react/rules-of-hooks` as an error, so a hook after an early return fails lint.
- Runs never use the Agent SDK or an API key. They spawn the user's installed `claude` so the user's Max login, settings and CLAUDE.md files apply (SPEC.md, 2026-08-24).
- The suite runs on macOS and on Linux (inside the mini's containers), so a test that shells out must use flags both BSD and GNU tools accept. `bun test` preloads `src/test-env.ts`, which clears the `CANOPY_*` variables a canopy shell inherits so tests never reach a live server. Bun pins JS dates to UTC under test, so tests that care about local days pass explicit dates.

## Docs

- `docs/architecture.md` has one section per feature area and runs to about 400 KB. Don't read it whole: `grep -n '^## ' docs/architecture.md` lists the sections, then read the one for the code you are changing. Update that section when a change makes it wrong.
- README.md covers CLI usage and features. FEATURES.md is the feature-request list. `docs/superpowers/specs/` and `plans/` hold the dated design docs behind larger features.
- Update SPEC.md in the same commit as a change that makes it wrong.

<!-- spec:begin v1.0.0 -->
This repo follows the shared repo spec, version 1.0.0.
- Read SPEC.md before changing how the project is built, run or stored, and keep it true when you do.
- Read DESIGN.md (when the repo has one) before adding or changing any UI.
- DESIGN.md applies to UI you add or change in this task. Do not restyle existing screens unless the task asks for it.
- Text between the spec:begin and spec:end markers is generated by canopy. Do not edit it by hand.
<!-- spec:end -->
