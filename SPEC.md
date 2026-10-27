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

One developer (the owner) across a laptop, an always-on Linux backend, a tablet and a phone, all on one tailnet. Agents use it too: Claude sessions run inside its shells and drive it through the CLI, the HTTP API and `canopy mcp`, an MCP server over that API with the token the session holds. It is not built for teams. A public name is served only behind an authenticating proxy (Cloudflare Access). The proxy is still needed with caller tokens on: they guard what a call may change, but reads stay open and canopy has no sign-in for reading, so without the proxy anyone who reaches the name can read everything canopy shows.

## Stack and versions

- Bun 1.4.2 runs the server, the CLI and the tests (`bun test`).
- TypeScript 7.0.2, `strict` in both `tsconfig.json` and `ui/tsconfig.json`.
- React 19.3.0, Zustand 5.0.15, Vite 8.3.2 with @vitejs/plugin-react 6.1.1 for the SPA; a second Vite build makes the service worker (`ui/sw.ts`) into `dist/web/sw.js`.
- @xterm/xterm 6.0.0 for shells; tmux on the backend keeps them alive.
- ai 7.0.127 and @ai-sdk/gateway 4.0.103 for commit message suggestions.
- oxlint 1.86.0 for lint, configured in `.oxlintrc.json`; a hook called after an early return fails lint (`react/rules-of-hooks`).
- Plain CSS in `ui/src/styles.css`; no CSS framework.
- git, gh and the `claude` CLI are shelled out to, never linked.
- age-encryption 0.3.1 seals the secret store's values; @simplewebauthn/server 14.0.3 and @simplewebauthn/browser 14.0.0 are its passkey gate.

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
- Production: the Bun server on :7850 serves the built `dist/web` (the page, `sw.js`, `manifest.webmanifest` and `icons/`), so a stale build shows a stale UI.
- Shared backend: docker compose (`canopy`, `shells`, `stages`, `coord` (the coordinator's runner, always up, used only once `.env` sets `CANOPY_COORD_SOCKET`, `CANOPY_COORD_API` and `CANOPY_COORD_PORT` and canopy enforces caller tokens, its lane held on that port's own listener), `coord-proxy` (the coordinator's egress proxy, its one way to the internet, which tunnels to Anthropic's names alone), `secrets`, and `tunnel` under its profile). Deploy committed `main` with `bun run redeploy`; `bun run redeploy status` says what is running. See `docs/deploy.md`.
- Run `bun test` with `SHELL=/bin/bash` when an interactive zsh config slows shells down.

## Data and state

- Config, workspaces, sources, agent and launch settings, and the archived, starred and harness repo lists: `~/.config/canopy/config.json`, or `$CANOPY_CONFIG_DIR`.
- Next to it: `bin/canopy-mcp.js` (in compose, the MCP bundle copied at each backend start for the shells container's `canopy` launcher), `tmux.sock` (the shells' tmux server), `shells/` (kept-shell snapshots), `pastes/` (images pasted into shells and design-mode pictures, kept 7 days), `callers.json` (the token hashes of every signed-in page, CLI, helper, shell and the ranger, 0600) and, written by `canopy auth login` and `canopy helper --pair`, `token-<host>-<port>` and `token-helper-<host>-<port>` (0600), `tasks/` (state and logs), `ranger/` (the always-on agent's conversation, wakes and brief), `builds/` (installed releases and PR worktrees), `worktrees/<repo key>/<id>/` (branch runs' worktrees), `worktrees/<repo key>/warm-<n>/` (prepared worktrees for the next branch run) and `worktrees/<repo key>/warm.json` (the pool record, written only by the flows-lock holder), `scenarios/<repo key>/` (a repo's holdout scenarios, one markdown file each, written by hand and by `canopy scenarios add`; never synced with the repo), `runs/<id>/` (`wire.jsonl.gz`, both directions of the run's wire with secrets redacted, cut at 50 MB, and `run.json`, the run as it ended; `runs/index.json` lists them; kept 30 days by the sweep's transcript span, longer while the branch is in `landing/` or its PR is open), `landing/` (`runs/<id>.json` per branch run with its latest sort, `groups/<id>.json` per best-of-N group, `queue/<repo key>.json` per repo and `notices.json` for the queue's quiet lines, all written only by the server holding the flows lock), `prs/` (`<branch id>.json` per PR a branch run opened, written only by the server holding the flows lock), `work/` (`<id>.json` per work item: title, state, the runs, branches, PRs and events that served it and its notes, written only by the flows-lock holder and never synced between backends), `sweep/` (`chats.json`, the chats the sweep stopped, kept 14 days so each can be resumed, and `log.json`, the newest 50 closes; a shell the sweep closes leaves its snapshot in `shells/`, kept 14 days), `triggers.json` (the trigger rules, written by hand, naming secrets only by their environment variable; schedule rules add `cron`, `repo`, `only` and `land`, while a github or forgejo rule’s poll cron and write switch live there too) and `triggers/events.json` (hook, polled issue and schedule events, written only by the server holding the flows lock), `library/<root-hash>/` (the project library, with `sync.json`, the Library sync's stamps, written only by the canopy server, and `sync-backups/`, the newest 10 copies of the files a sync replaced), `costs/<YYYY-MM>.jsonl` (the cost ledger: a line per run reply, voice call and dictated clip), `capacity.json` (the last usage-limit hit per harness, retained across restarts, with no credential), and `prices.json` (optional, written by hand: the prices that turn usage into estimates).
- In a repo: `.canopy/tasks.json`, `.canopy/workflows/`, `.canopy/workflows.json` (which workflow steps a person releases by hand in this repo, read at HEAD), `.canopy/spec.json`, `.canopy/gates.json` (the landing queue's gates, setup line and default warm count), `.canopy/scenarios.json` (the scenarios' default run line, judge, minimum and timeout) and `.canopy/review.json` (what lands on its own and what needs an approval), all checked in by that repo's owner.
- Per browser: preferences (including the harness-share warning line), open panels, shell tabs and the week the harness notice was noted in localStorage (`canopy.harnessSaid`); the service worker's one cache, `canopy-<build>`, holds the page shell and hashed assets, never `/api` or `/library`.
- Runs live in server memory; the last 60 finished ones stay until a restart, and every run's record is kept under `runs/` for 30 days, from where `GET /api/runs/<id>` and `canopy run` read it after a restart. A branch run's record and its landing queue entry outlive a restart in `landing/`.
- Session history is read from claude-history's CLI (`--json`), never its sqlite file.
- The secret store: `secrets.json` in the private Forgejo repo `eric/secrets`, its values sealed with age and the file signed. On the mini the `secrets-data` volume holds the checkout, the keys, `passkeys.json`, `audit.jsonl` and `applied.json`. On every other backend, next to the config: `secrets/` (a pulled copy), `secrets-config.json` (the pinned key and remote), `secrets-key.age` (that machine's passphrase-wrapped key) and `secrets-applied.json`.
- No database of its own: git and the files above are the state.

## Decisions

- 2026-08-03: Shell out to `git` and parse porcelain v2, because the same call then runs locally or over ssh for a remote repo.
- 2026-08-24: Drive the user's own `claude` binary over stream-json, not the Agent SDK, because jobs must run on the user's Max login and settings (the SDK was tried and rolled back).
- 2026-10-26: canopy's MCP server uses the existing line JSON framing and the caller's own API token, because the small stdio protocol needs no SDK or second rights model. The shells image carries a launcher for its bundle on the config volume.
- 2026-08-24: No CSS framework; one stylesheet of `light-dark()` tokens, because themes only flip `color-scheme`.
- 2026-09-11: The devhub library moved into canopy, because one engine and one dashboard beat two copies of the data.
- 2026-09-21: Shells are tmux sessions on canopy's own server, because a shell must outlive a reload and a canopy restart.
- 2026-09-22: Headless shared backend in containers, with shells in a container of their own, because a redeploy must not kill open shells.
- 2026-09-24: Peers sync over git only, pull-only and fast-forward only, because work should move between machines through commits, never file copies.
- 2026-10-09: canopy takes only the doc half of the shared spec and keeps its design system in `ui/src/styles.css`, because its own palettes and tokens predate the shared DESIGN.md and differ from it.
- 2026-10-16: Every API call carries a caller token with rights (read, plan, operate, shell, admin, helper), checked at the top of `route()`, because a bare `curl -X POST` from a run must not be able to start or stop a run. It ships in `log` first, then `enforce`.
- 2026-10-14: Secrets live in one signed, age-sealed file in Forgejo, written only by a service on the mini behind passkeys, because a value must never sit in a container that shares the shells' namespaces or in a repo canopy syncs.
- 2026-10-20: Voice runs on ElevenLabs' Realtime API with the browser on the socket and the server only minting a 60-second client secret, because audio then never passes through canopy and the key never reaches the page. Its tools only read and navigate, because a misheard word must not commit, push or answer an ask.
- 2026-10-20: GPT-Live is a second voice engine beside ElevenLabs, with its own key (`CANOPY_LIVE_KEY`) and the page picking per browser. It has no client secret a page could open a session with, so the backend takes the page's WebRTC offer to OpenAI and hands back the answer; audio still never passes through canopy and the key never reaches the page. Its tools run on the Responses backend it delegates to, and the page answers them, as with Eleven.
- 2026-10-20: Dictation into fields and shells records in the page and transcribes on a backend through `CANOPY_TRANSCRIBE_URL`, the incubator's speech model, because the ElevenLabs voice key has no speech-to-text permission and the mini already serves Whisper through LiteLLM. The page uses home's model, else the first online backend with one.
- 2026-10-26: The harness repo list is explicit config, seeded once from a local `package.json` named `canopy`; later scans never guess again, since the list is a mark Eric controls.
- 2026-10-20: Costs take Claude's dollars from claude-history and keep a per-backend ledger for the rest, with no built-in prices, because the archive already counts every Claude session and only Claude reports dollars; the others are usage until a `prices.json` says what it costs.

## Out of scope

- Hosting git or replacing GitHub or Forgejo; canopy reads them.
- Multi-user accounts, permissions or teams.
- Calling the Anthropic API directly or storing API keys for Claude.
- Running a cloned third-party repo's tasks on its own.
