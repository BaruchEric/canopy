# The Rust port

canopy's backend and CLI are moving from Bun and TypeScript to Rust, on Eric's ask of 2026-11-27 ("migrate canopy to Rust"). The React page in `ui/` stays TypeScript: it already runs in the browser, and it imports its types and pure helpers from `src/core/`, which keep working while the server underneath changes.

This page is the ledger. It says what is in Rust, how it was checked, the rules a later session keeps, and every TypeScript module with its status, so the next session starts from here.

## Where it stands

The port runs beside the TypeScript. Bun still runs everything that ships: the Mac's launchd server, the mini's and De Soto's compose stacks, and the `canopy` CLI on every machine. Nothing switches until a cutover Eric says yes to.

`rust/` is a Cargo workspace of four crates:

| Crate | What it is | From |
|---|---|---|
| `canopy-core` | exec, ssh locators, the seed guard, config, remotes, card meta, the shared spec, git reads and writes, the stale-copy judge, the scan, the tree's lines, the build version, and the pure halves the ported verbs and routes read (backends, agent routing, harnesses, kept shells, launchers, notes, peers, screen layouts, workflows, fr, clips, costs and more) | `src/core/` |
| `canopy-auth` | caller tokens, rights, the callers book, the request gate, the auth routes, the origin gate, CORS | `src/core/callers.ts`, `src/server/callers.ts`, `src/core/library.ts`, `src/core/cors.ts` |
| `canopy-cli` | the binary `canopy-rs` | `src/cli/` |
| `canopy-server` | the binary `canopy-server`: the page, the tree and its stream, the first-load reads, the people and devices | `src/server/index.ts` and its feature modules |

Of 315 modules (106,675 lines of TypeScript under `src/core`, `src/server`, `src/cli`, `src/stage`, `src/egress` and `src/secrets`), 46 are ported, 50 are in part and 219 are not started. The table at the end lists each.

## What runs in Rust today

- `canopy-rs` answers `canopy [dir]`, `canopy tree`, `canopy status`, `canopy version`, `canopy commit <repo> [-m msg] [--all] [--push]`, `canopy push <repo> [--drop-stale]` and `canopy pull <repo>` itself. Any other verb goes to `bun bin/canopy.ts` with the same arguments and exit code, and so does any of these with a flag the port does not read yet: `--backend` on tree or status or in front of the repo (after it, commit, push and pull take it and run here, as index.ts does), `commit --ai`, `push test` and `push ls` (web push), or a flag the verb does not take. So `canopy-rs` can stand in for `canopy` now. `CANOPY_TS_CLI` points it at another entry.
- It also answers the backend verbs `canopy note` (add, list, done, delete), `canopy awake`, `canopy issues`, `canopy pr` (open and rebase), `canopy prs`, `canopy scenarios` (list, add, run), `canopy sweep`, `canopy kit` (status, apply), `canopy loadouts` (list, resolve, adopt, restore), `canopy groups` (list, pick), `canopy work` (list, show, note, close, export), `canopy land` (one run, `--all`, `--approve`, `--skip-judge`, followup), `canopy queue` and `canopy collisions` over HTTP (`api.rs`, `ask.rs`): the backend's address from `--backend`, else `$CANOPY_API`, else `127.0.0.1:7850`; the caller token from `--token`, the backend's token file or `$CANOPY_TOKEN`, with the flag and the variable kept to the backend the command was pointed at; each of a backend's addresses tried in turn, no redirect followed, an 8-second timeout. The client is reqwest on rustls with ring. A backend that does not answer is worded as Bun's fetch words it ("ECONNREFUSED: Unable to connect. ...", "getaddrinfo ENOTFOUND host", "The operation timed out.", the TLS handshake on a plain port), so a "did not answer" line reads the same from either CLI. A verb that asks every backend the home one lists (`kit`, `groups`, `work list`, `queue`, `collisions`) asks each in turn and prints a line for each one that does not answer, as the TypeScript does. These verbs write to `out.rs` and main prints it before the failure line, the order the TypeScript's own end leaves them in.
- On the same client it answers the map section's verbs, `canopy floorplan`, `canopy archify`, `canopy diagnosis` and `canopy understand` (their listings, `--json`, stops, refusals and a page saved to a path; a make, revise, analysis or plugin prepare goes to the server as the TypeScript sends it), and `canopy capacity`, `canopy costs`, `canopy plugins`, `canopy people`, `canopy clip` and `canopy clips` (text, a file's bytes up and down, pins), `canopy worktrees` (with `shell-init`), `canopy workflow` (list, show, `--dot`, check), `canopy health` (list, show, heal, watch, checks, add, rm, lint, init) and `canopy fr` (list, reserve, check, on the repo's own git and its origin). `mapsection.rs`, `clips.rs` and `health.rs` carry private copies of helpers that belong to verbs not ported yet (`run.ts`'s target pickers, a longer timeout on `ask_text`, an HTTP client for bytes and for an event stream); the ledger names them.
- `--token` is read for every verb but `source`, as index.ts reads it, and every verb's `--help` or `-h` (but `library`'s), `canopy help` and `canopy help <verb>` print from `help.ts`. canopy-rs reads `src/core/help.ts` when it is built (`include_str!`), so the two CLIs cannot print different help.
- The write half of `git.ts` runs in Rust (`gitwrite.rs`): a commit's detail and diff, stage and unstage, commit, push with its rebase of a rejected push and FR-048's stale-copy offer (`stalecopy.rs`), pull, and the stale `index.lock` sweep. Nothing calls the diff, stage or commit-detail functions outside the tests until the server's routes are ported.
- `canopy-server` serves the built page (`dist/web`, with the page as the fallback for client routes), `GET /api/tree` (the launch root, the config's extra folders and the kept worktrees' folder, each its own source, with the harnesses this backend can start), `/api/about`, `/api/sources` and the `/api/events` stream (`: hello`, a `scan` frame after each rescan, a named `ping` after 25 quiet seconds). Every request passes the same gate as the Bun server's `route()`: the preflight, the caller token or the loopback bypass, the coordinator's lane, the rights gate in `CANOPY_CALLERS` mode, the origin gate, then the auth routes.
- It answers the reads the page makes on its first load (`routes.rs`): backends, workspaces, launchers, agent routing, kept shells, the client's address, people, quick notes, screen layouts and, while peer sync is off, peers, each read from the config dir as the Bun server reads it. A stream opened with `?client=<id>&name=&platform=` puts its browser on `GET /api/devices` while it is open, with the person the gate found, and 300 ms after the last open or close every stream hears a `devices` frame and a `people` frame; `POST /api/people/at` records which repos a browser has open (`presence.rs`). The live lists of work this port does not run yet (runs, flows, fleets, jobs, helpers, agent pulses, an evaluator's verdict) answer what a Bun server that runs nothing answers. Where that empty answer would not be true, the route answers 501 instead: `/api/runs?kept=1` (the run log), `/api/terms` and `/api/terms/kept` where tmux runs, `/api/flows` and `/api/fleets` when the config dir keeps flow records the Bun server would take back at its start, `/api/verdict` with a gateway key set (`AI_GATEWAY_API_KEY`), and `/api/agents/pulse` with a broker's address. Jobs and helpers start empty on the Bun server too: a launch fills the one, a desktop helper's websocket the other. The Bun server deletes expired kept-shell records as it lists them; this port leaves them on disk and only leaves them out.
- Routes whose answer the Bun server decides by what the machine has (`gated.rs`) say what it says when the machine has none of it: the tasks without tmux, tailchan, its registry, asks, presence and guards without a broker's address, voice without its keys. Where the machine has one, the feature is not here yet, and the route answers 501.
- Every other API route, and any method other than the one a ported path answers, gets 501 with "not in the Rust port yet". Of the routes the page reads on its first load, 16 still do: history, the three incubator reads, ranger, health, capacity, kit, landing, trees, prs, triggers, work, clips, secrets and worktrees. Joining with an invite, people's roster changes, the Library, websockets and every feature route's writes are not here yet.
- `canopy-server` refuses to start without `CANOPY_CONFIG_DIR`, and defaults to port 7870, clear of the Bun server's preview ports (7860 to 7869). The Bun server owns `~/.config/canopy` and port 7850 until the cutover; two servers writing `callers.json` would corrupt it.

## How it was checked

- `cd rust && cargo test --workspace` runs 771 tests. Most are the TypeScript tests ported case by case: `exec.test.ts`, `host.test.ts`, `seedgit.test.ts`, `git.test.ts` (both halves, against real repos, the eight diverged-branch rebase cases and the seven amend cases included), `stalecopy.test.ts`, `scan.test.ts`, `meta.test.ts`, `spec.test.ts`, `treelines.test.ts`, `access.test.ts` (remotes), the callers tests, `api.test.ts`, `notes.test.ts`, `issues.test.ts`, `pr.test.ts`, the CLI's `scenarios`, `sweep`, `kit`, `loadouts`, `groups`, `work`, `land`, `floorplan`, `archify`, `diagnosis`, `understand`, `capacity`, `costs`, `plugins`, `people`, `clips`, `worktrees`, `fr`, `workflow` and `health` tests (each TS test has a Rust test named after it, the ones that share state run as named steps in the TS's order), and core's `workflow.test.ts`, `flowgraph.test.ts` and `fr.test.ts` with the clip functions of `clips.test.ts`. canopy-server's own tests drive its routes over a real socket: the first-load reads, the 501s, a page's stream on the devices list and gone when it closes. `land.test.ts` builds its entries with the queue's own `enqueue` and `advance`, which are not ported, so the Rust test writes the JSON those calls leave. The verbs' tests hand in a fake backend (`ask::tests::Fake`) as the TS tests hand in their own `ask`; `ask.rs`'s own tests run a raw HTTP server on a free port and check each way of not answering against the words Bun printed for it. No test makes a request to 127.0.0.1:7850.
- `canopy-auth`'s parity tests read fixtures the TypeScript wrote (`rust/crates/canopy-auth/scripts/gen-fixtures.ts`): what every route needs for 5,796 paths by 7 methods, 68,400 origin cases, and a `callers.json` the TS minted. The Rust reads that book, checks its 9 tokens and writes it back byte for byte; `scripts/check-rust.ts` checks the other direction.
- `bash scripts/rust-parity.sh [folder]` runs the TypeScript CLI and `canopy-rs` on the same folder against a scratch config dir and diffs tree, status, the bare form, version and a missing folder. On `~/dev` (175 lines of tree) every one came out byte-identical, with the last column (how long ago the newest commit was) masked because a scan of that size lets it tick over between the two runs. The script runs with `NO_COLOR`; under a real terminal (Python's `pty.spawn`) the colored tree of `~/dev/dev-tools` was byte-identical too, color codes and all.
- The same script then builds two identical sets of scratch repos (a bare origin, clones, a repo with no remote, a detached checkout), with names, dates and the global git config pinned so both sides make the same hashes, and runs each git step through both CLIs, stdout, stderr and exit code apart: commit's usage, no message, nothing staged, a missing repo, `--all` and `--push` (which rebases onto a newer upstream first); push fast-forward, usage, a missing repo, no remote and detached; pull usage, fast-forward and a held `index.lock`; and the atlas case, a push refused over an upstream amend and then `--drop-stale`. All 16 came out byte-identical. `CANOPY_PARITY_KEEP=1` keeps the scratch dir to read.
- The script diffs `canopy <verb> --help` and `canopy help <verb>` for all 62 words of `COMMANDS`, plus `canopy help` and `canopy --help`: 126 checks, all byte-identical.
- For the backend verbs it clears `CANOPY_API`, `CANOPY_TOKEN` and `CANOPY_BACKEND`, starts a scratch Bun server on a free port with its own config dir, and runs 32 steps through both CLIs: notes added (one with a reminder, one on a repo that does not exist, one read under `TZ=Asia/Tokyo`), listed, done, listed with `--all` and deleted; the usages; a note that does not exist; a `--backend` that is not an origin; a bogus `--token`; keep awake's status; issues and prs, with a repo and without; pr and pr rebase on a run that does not exist; and each verb pointed at a port nothing listens on. A note's id, which each side mints, is masked. All 32 came out byte-identical. Only calls that change nothing outside that scratch server run: no keep-awake mode, no real run.
- Before that server starts, the script seeds its config dir and HOME: a scratch repo with one commit, kit.json with a store target, two loadouts and defaults, two work items (one closed, so the work hub never moves it), a finished best-of-N group and a ready run whose repo does not exist, with a sensitive file waiting for approval. Then 56 more steps run through both CLIs: scenarios listed, added (by the TypeScript CLI, once) and run (the scenario runs `true` in the scratch repo); sweep with nothing to close, with `--yes`, and with a bad `--kind`; kit status and a dry-run apply; loadouts listed, as JSON, resolved in the repo and in one that does not exist; groups listed and a pick of a group that does not exist; work listed with filters, shown, exported and noted; the queue and collisions with and without a repo; `land` on the seeded run, which the scratch server refuses with "its diff could not be sorted" since its repo does not exist; and every verb's usages and a port nothing listens on. All 56 came out byte-identical. Nothing starts a run, a gate, a landing, a coordinator or an incubator stage.
- A third batch of steps covers the verbs ported since: the map section's listings, `--json`, stops, refusals and pages saved to each side's own copy (compared with `cmp`), capacity under two zones, costs over each window, the plugins listing against a stand-in plugin CLI, people's roster changes, clips (a file's raw bytes compared with `cmp`), worktrees with three kept trees, workflow listings, drawings and checks of scratch files, health listings, refusals, lint and init, and fr reserving on a scratch repo with its own bare origin. Steps that change the scratch server answer the same when run twice, work on an object of each side's own, or run after the TypeScript CLI cleared the way. In all the script runs 518 steps, every one byte-identical. No step starts a run, a flow, a heal, an analysis, a plugin install or a marketplace change.
- `bash scripts/rust-server-parity.sh` starts a scratch Bun server and a scratch canopy-server side by side on free ports, each with a copy of one seeded config dir (peers, backends with a bad name and a non-URL, workspaces, launchers, agent profiles and roles, notes and screen layouts with good and bad records) and the same scan root. It opens a page's stream on each and says which repos that browser has open, then asks both for the 44 routes the page reads on its first load and diffs the JSON with keys sorted and clocks masked: 28 came out the same, devices and people with the browser on included, and the 16 that answer 501 are listed. It exits 1 when a route canopy-server answers says something else.
- The built page, served by each server on a scratch port, was loaded at 1400 and 390 px in headless Chromium (`scripts/browser`): the screenshots from the two were byte-identical, with no page error on either.
- Under `script` (a real terminal), a push to a local server that answers 401 failed at once in both CLIs with the same bytes, Bun's red error included: git found no terminal to ask for a username on. The Rust exec had put a timed command in a process group of its own, which kept the terminal, so git would have stopped on a prompt it could not read until the 15-minute timeout. It now calls `setsid` as Bun's `detached: true` does.
- `canopy-server` was run on a scratch port and config dir against the real `dist/web`: the page and its assets load, `/api/tree` returns the scan, a cross-site Origin gets `{"error":"Foreign origin"}`, the stream says `: hello`, and with `CANOPY_CALLERS=log` it prints the TS's own "callers: would refuse" lines. It wrote nothing to its config dir.

No speed claim yet. Timings taken on 2026-11-27 ran on a machine at a load average near 90, and a single run of either CLI on `~/dev` varied from 7 to 40 seconds.

## Rules for the rest of the port

- State files round-trip byte for byte. A Rust module that writes a file the TypeScript also writes (config, callers, runs, notes, anything under `~/.config/canopy/` or a repo's `.canopy/`) must write what the TS would write, key order and trailing newline included, and read what the TS wrote. `serde_json` has `preserve_order` on for this.
- JavaScript's rules where output is compared: `pathx.rs` has Node's `path` functions, UTF-16 lengths for padding, JavaScript's sort order, JavaScript's whitespace for `trim` and `\s` (`JS_S`), and a field that is absent in TS JSON is `skip_serializing_if` in Rust while a `null` one is a plain `Option`. `js.rs` has what a template's `${x}` prints for a JSON value (`undefined`, `null`, `[object Object]`), `toFixed` (an exact tie rounds away from zero), and the truthiness and `??` reads of a field, which differ for `0` and `""`. `jsdate.rs` prints `toLocaleString()` as Bun does, always en-US ("12/1/2026, 9:00:00 AM") in the zone `TZ` names, whatever `LANG` says.
- canopy-rs builds from one file outside `rust/`: `src/core/help.ts`, read with `include_str!`. The page imports that file too, so it stays where it is after the cutover; a test fails if `HELP_TEXT` ever interpolates.
- No Rust test makes a request to `127.0.0.1:7850`, the live server's address. A verb's test hands in a fake backend; a test of the client runs its own server on a free port.
- Test against a scratch `CANOPY_CONFIG_DIR` and a port other than 7850, never the live server's state.
- Port a module with its tests. A behaviour the TypeScript tests check is a Rust test too.
- Tests run on macOS and Linux, so a test that shells out uses flags both BSD and GNU tools take.
- Blocking file work in async code goes through `spawn_blocking`; the scan's eight-at-a-time workers share one task.
- `unsafe_code` is denied workspace-wide; `rustix` covers signals. The one exception is `new_session` in `exec.rs`, a `pre_exec` hook that calls `setsid(2)`, because `CommandExt::setsid` is still unstable (rust#105376) and a timed command must lose the terminal as Bun's detached child does.
- Do not touch the Dockerfile, the compose files or the launchd agent for the port. The cutover changes them, once, with Eric's yes.

## What comes next

In about this order, each its own task:

1. The rest of the CLI's verbs (`run`, `runs`, `tenant`, `secrets`, `auth`, `incubator`, `coordinator`, `library`, `helper`, `mcp` and the others in `src/cli/` the ledger lists as not started), one at a time on the pattern `note` set: the verb's own parsing and failure words, its pure helpers with their tests, a fake backend in its tests, and its steps in the parity script. When `run.ts` lands, `mapsection.rs` and `worktrees.rs` drop their copies of its pickers; a byte-body and a streaming call on `ask::Client` let `clips.rs` and `health.rs` drop their own HTTP clients.
2. The rest of the first load: the 16 routes that still answer 501 (history, the incubator's three, ranger, health, capacity, kit, landing, trees, prs, triggers, work, clips, secrets, worktrees), the shells under tmux, the kept runs, peers with sync on, then the SSE events the page listens for beyond scan, devices and people. Most of them read state that runs, flows and the landing queue write, so they land with steps 3 to 5 more than before them.
3. Runs: `runner.ts`, `driver.ts`, `claudedrive.ts` and the stream-json fold, then `codexrun.ts` and `antigravity.ts`.
4. Shells: `term.ts` and the tmux bridge over websockets.
5. Flows, workflows, peers, the Library, people and tenants, the coordinator.
6. The separate processes: `src/stage`, `src/egress`, `src/secrets`.
7. The cutover: the launchd agent, the compose images and `canopy` on PATH switch to the Rust binaries, with the TS kept one release for a rollback. Eric said yes on 2026-11-27. It runs once canopy-server does what the Bun server does for runs, shells, flows and the landing queue (steps 3 to 6), not when the first load stops answering 501: a server that renders the board but cannot start a run or open a shell would take canopy away on every screen, and the restart would end live runs and lock the secrets key. Swapping only the CLI on PATH ahead of the server is not part of that yes.

## Every module

Status is `ported` when the module's behaviour and tests are in Rust, `partial` when some of it is (the notes say what), and `not started` otherwise. Line counts are the TypeScript file's.

### src/core

| Module | Lines | Status | Rust | Notes |
|---|---:|---|---|---|
| `access.ts` | 122 | partial | core `meta.rs` | listRemotes only |
| `acpfold.ts` | 379 | not started |  |  |
| `actions.ts` | 576 | not started |  |  |
| `activity.ts` | 811 | not started |  |  |
| `agent.ts` | 66 | partial | core `agent.rs` | `normalizeAgent` and `sameAgent`; no `describeAgent` or `withHarness` |
| `agentscan.ts` | 361 | not started |  |  |
| `agentstatus.ts` | 152 | not started |  |  |
| `antigravity.ts` | 614 | not started |  |  |
| `applied.ts` | 33 | not started |  |  |
| `archify.ts` | 327 | partial | core `archify.rs` | the types, `isArchifyPick`, `isPlainName`, `archifyLine`, `checksWord`, `typeWord` |
| `archifyvendor.ts` | 50 | not started |  |  |
| `archive.ts` | 23 | not started |  |  |
| `awake.ts` | 191 | not started |  |  |
| `backendid.ts` | 28 | ported | core `backendid.rs` |  |
| `backends.ts` | 50 | ported | core `backends.rs` | the config's list and this backend's name |
| `branchtrees.ts` | 464 | not started |  |  |
| `browse.ts` | 88 | not started |  |  |
| `build.ts` | 50 | ported | core `version.rs` |  |
| `builtincheck.ts` | 81 | not started |  |  |
| `callers.ts` | 314 | ported | auth `rights.rs` | checked against 5796 paths x 7 methods the TS answered |
| `canopymcp.ts` | 402 | not started |  |  |
| `capacity.ts` | 679 | partial | cli `capacity.rs` | `hitStands` and `resetWord` only |
| `cards.ts` | 67 | ported | core `cards.rs` |  |
| `chan.ts` | 319 | not started |  |  |
| `check.ts` | 145 | not started |  |  |
| `claudedrive.ts` | 794 | not started |  |  |
| `claudefold.ts` | 276 | not started |  |  |
| `cli.ts` | 14 | not started |  |  |
| `client.ts` | 57 | partial | auth `origin.rs` | isLoopback and isLoopbackHost only |
| `clips.ts` | 504 | partial | core `clips.rs` | `CLIP_FILE_MAX`, the secret checks, `textHead`, the UTF-8 read, `sniffType`, `sizeWord`, `clipKey`, the order, the kinds, `clipLine`, `agoWord`; not the store, devices, swatches or the served and inline kinds |
| `codexfold.ts` | 368 | not started |  |  |
| `codexrpc.ts` | 363 | not started |  |  |
| `codexrun.ts` | 1100 | not started |  |  |
| `codextrust.ts` | 80 | not started |  |  |
| `compose.ts` | 92 | not started |  |  |
| `coordinator.ts` | 1104 | not started |  |  |
| `cors.ts` | 33 | ported | auth `cors.rs` |  |
| `costledger.ts` | 172 | not started |  |  |
| `costs.ts` | 238 | partial | core `costs.rs` | `SERVICE_NAME` only |
| `costsheet.ts` | 273 | partial | core `costsheet.rs` | no detail, runs, `sessionLines` or `windowStart` |
| `cron.ts` | 246 | not started |  |  |
| `deploy.ts` | 190 | not started |  |  |
| `diagnosis.ts` | 312 | partial | core `diagnosis.rs` | the folder and page names, the languages, `diagnosisLine`, `changesLine`, `othersLine`, `languageWord`, `diagnosisFailure` |
| `digest.ts` | 111 | not started |  |  |
| `driver.ts` | 722 | not started |  |  |
| `emulatord.ts` | 236 | not started |  |  |
| `emulators.ts` | 246 | not started |  |  |
| `envnames.ts` | 83 | not started |  |  |
| `evidence.ts` | 37 | not started |  |  |
| `exec.ts` | 287 | ported | core `exec.rs` | exec, onHost, git, the seed guard's hook (`SeedGitHook`); a timed command gets a session of its own, as Bun's detached child does |
| `explain.ts` | 1296 | not started |  |  |
| `export.ts` | 110 | not started |  |  |
| `favorite.ts` | 32 | not started |  |  |
| `filekind.ts` | 62 | not started |  |  |
| `finder.ts` | 161 | not started |  |  |
| `firebase.ts` | 131 | not started |  |  |
| `floorplan.ts` | 221 | partial | core `floorplan.rs` | `floorplanLine` only |
| `floorplanvendor.ts` | 165 | not started |  |  |
| `flow.ts` | 1959 | not started |  |  |
| `flowgraph.ts` | 119 | ported | core `flowgraph.rs` |  |
| `flowmodes.ts` | 58 | partial | core `flowmodes.rs` | `applyModes` only; no `parseFlowModes` |
| `flowstore.ts` | 250 | not started |  |  |
| `forge.ts` | 224 | not started |  |  |
| `forgejoissues.ts` | 85 | not started |  |  |
| `forkcut.ts` | 164 | not started |  |  |
| `fr.ts` | 126 | ported | core `fr.rs` |  |
| `gatename.ts` | 4 | not started |  |  |
| `gates.ts` | 132 | not started |  |  |
| `git.ts` | 1309 | ported | core `git.rs`, `gitwrite.rs` | the read half in `git.rs`; commit detail, diff, stage, commit, push, pull and the lock sweep in `gitwrite.rs`, with `GitError` in place of the TS error classes |
| `github.ts` | 122 | not started |  |  |
| `going.ts` | 55 | not started |  |  |
| `group.ts` | 238 | partial | core `group.rs` | `groupWord` only; fan-out, scoring and the reviewer wait on runs |
| `guards.ts` | 121 | not started |  |  |
| `handoff.ts` | 93 | not started |  |  |
| `harness.ts` | 284 | partial | core `harness.rs` | the table, models, efforts and the cross-harness checks; no argv builders |
| `harnessshare.ts` | 201 | partial | core `harnessshare.rs` | no `barWidths`, `cardsOf`, `harnessSlot` or `weekKey` |
| `health.ts` | 130 | not started |  |  |
| `help.ts` | 283 | ported | cli `help.rs` | `HELP_TEXT` is read from this file at build time; `asksHelp` sits in `main.rs` |
| `helper.ts` | 231 | not started |  |  |
| `helperd.ts` | 267 | not started |  |  |
| `herdr.ts` | 248 | not started |  |  |
| `history.ts` | 248 | not started |  |  |
| `historymerge.ts` | 32 | ported | core `historymerge.rs` |  |
| `host.ts` | 110 | ported | core `host.rs` |  |
| `improvements.ts` | 94 | not started |  |  |
| `incubator.ts` | 1865 | not started |  |  |
| `issue.ts` | 243 | not started |  |  |
| `jev.ts` | 114 | not started |  |  |
| `keep.ts` | 262 | partial | core `keep.rs` | the read side: the records, `expiredShells`, `lostShells`; no writes, forgets or replays |
| `kit.ts` | 714 | not started |  |  |
| `kitapply.ts` | 142 | not started |  |  |
| `kitfake.ts` | 42 | not started |  |  |
| `kitmcp.ts` | 404 | not started |  |  |
| `kitscan.ts` | 359 | not started |  |  |
| `landing.ts` | 386 | partial | core `landing.rs` | `SCORE_GATE`, `inQueue`, `sentBack`, `stoppedWhole`, `queueOf`, `landWord` and `reviewWord`, read from the JSON `/api/landing` answers; the queue itself waits on the server |
| `launch.ts` | 292 | partial | core `launch.rs` | `normalizeLaunch` and `isDefaultLaunch`; no release assets, builds or the launch |
| `launcher.ts` | 838 | not started |  |  |
| `leftovers.ts` | 127 | not started |  |  |
| `library.ts` | 252 | partial | auth `origin.rs` | the origin gate only |
| `libsync.ts` | 432 | not started |  |  |
| `loadout.ts` | 482 | not started |  |  |
| `mentions.ts` | 310 | not started |  |  |
| `meta.ts` | 261 | ported | core `meta.rs` |  |
| `move.ts` | 243 | not started |  |  |
| `notes.ts` | 133 | partial | core `notes.rs` | the record, `openNotes`, `sortNotes`, `dueWord`, the id and the file read back (`parseNotes`); `isDue` and `remindDue` wait on the server's writes |
| `offer.ts` | 35 | not started |  |  |
| `openers.ts` | 737 | partial | server `harnesses.rs` | `findBinary`, `LoginHarnesses`, `harnessesFrom`, `backendCaps`; no openers |
| `panesizes.ts` | 129 | partial | core `screenlayouts.rs` | the panes table and `parsePaneSizes` |
| `passkeeper.ts` | 93 | not started |  |  |
| `paste.ts` | 63 | not started |  |  |
| `peers.ts` | 219 | partial | core `peers.rs` | `NO_PUSH` and the push URL, `normalizePeers`, `isSshAlias`, `peerSync`; no passes |
| `peersync.ts` | 1494 | not started |  |  |
| `people.ts` | 486 | partial | auth `people.rs`, core `people.rs`, server `people.rs` | roles and rights; `people.json` read record by record, scopes, role words and the lookups; no changes, invites or activity log |
| `pickscript.ts` | 236 | not started |  |  |
| `pluginfake.ts` | 177 | not started |  |  |
| `plugins.ts` | 426 | partial | cli `plugins.rs` | `isPluginAgent` and `opText` only |
| `pluginscan.ts` | 289 | not started |  |  |
| `ports.ts` | 277 | not started |  |  |
| `pr.ts` | 250 | partial | core `pr.rs` | `checksWord` only |
| `presence.ts` | 95 | ported | server `presence.rs` | `parseStream` and `devicesOf` |
| `preview.ts` | 480 | not started |  |  |
| `previewPublic.ts` | 34 | not started |  |  |
| `procs.ts` | 184 | not started |  |  |
| `providers.ts` | 212 | not started |  |  |
| `prscenarios.ts` | 57 | not started |  |  |
| `push.ts` | 351 | not started |  |  |
| `ranger.ts` | 365 | not started |  |  |
| `redact.ts` | 121 | not started |  |  |
| `remember.ts` | 265 | not started |  |  |
| `remote.ts` | 75 | ported | core `remote.rs` |  |
| `repohealth.ts` | 203 | partial | core `repohealth.rs` | no `mergeChecks` or the per-host blocking; bad JSON is worded by serde |
| `retro.ts` | 374 | not started |  |  |
| `review.ts` | 356 | not started |  |  |
| `route.ts` | 406 | partial | core `route.rs` | profiles, roles and repo overrides read back, `GET /api/agents`'s shape; no `resolveAgent` |
| `runerror.ts` | 55 | not started |  |  |
| `runlog.ts` | 536 | not started |  |  |
| `runname.ts` | 134 | not started |  |  |
| `runnamer.ts` | 83 | not started |  |  |
| `runner.ts` | 1267 | not started |  |  |
| `runtools.ts` | 48 | not started |  |  |
| `scan.ts` | 393 | partial | core `scan.rs` | local and ssh sources; forgejo sources are not |
| `scenario.ts` | 159 | not started |  |  |
| `scope.ts` | 353 | not started |  |  |
| `screenlayouts.ts` | 332 | partial | core `screenlayouts.rs` | the presets, the recommended layouts and the profile checks; matching a profile to a screen is the page's |
| `search.ts` | 86 | not started |  |  |
| `secretcrypt.ts` | 123 | not started |  |  |
| `secretfile.ts` | 348 | not started |  |  |
| `secretimport.ts` | 183 | not started |  |  |
| `secretlocal.ts` | 473 | not started |  |  |
| `secretmcp.ts` | 68 | not started |  |  |
| `secretsclient.ts` | 36 | not started |  |  |
| `secretwire.samples.ts` | 42 | not started |  |  |
| `secretwire.ts` | 300 | not started |  |  |
| `seed.ts` | 380 | not started |  |  |
| `seedgit.ts` | 237 | ported | core `seedgit.rs` | the stage runner's side of the hook waits on src/stage |
| `seedmirror.ts` | 173 | not started |  |  |
| `seedsource.ts` | 282 | not started |  |  |
| `sessionrules.ts` | 62 | not started |  |  |
| `sessions.ts` | 390 | not started |  |  |
| `shellname.ts` | 12 | not started |  |  |
| `shellwords.ts` | 359 | not started |  |  |
| `shipper.ts` | 682 | not started |  |  |
| `sidequestion.ts` | 75 | not started |  |  |
| `sinks.ts` | 412 | not started |  |  |
| `sinkssh.ts` | 129 | not started |  |  |
| `sinksync.ts` | 138 | not started |  |  |
| `spec.ts` | 192 | ported | core `spec.rs` | load, plan, sync and state |
| `sprout.ts` | 918 | not started |  |  |
| `sproutnote.ts` | 204 | not started |  |  |
| `sproutstore.ts` | 177 | not started |  |  |
| `stageclient.ts` | 497 | not started |  |  |
| `stageshare.ts` | 142 | not started |  |  |
| `stagetoken.ts` | 172 | not started |  |  |
| `stagewire.ts` | 391 | not started |  |  |
| `stalecopy.ts` | 186 | ported | core `stalecopy.rs` |  |
| `stall.ts` | 95 | not started |  |  |
| `steer.ts` | 68 | not started |  |  |
| `store.ts` | 698 | partial | core `store.rs` | config path, maxDepth, ignore, workspaces and flags; the other settings ride along as raw JSON |
| `suggest.ts` | 190 | not started |  |  |
| `sweep.ts` | 265 | partial | core `sweep.rs` | the kinds and `mayClose`; the planner waits on the server |
| `sweepstore.ts` | 182 | not started |  |  |
| `tailchan.ts` | 427 | not started |  |  |
| `taskrun.ts` | 165 | not started |  |  |
| `tasks.ts` | 515 | partial | core `tasks.rs` | names, patches, `tasks.json`, detection; no env filling, layer merge, backoff, status, logs or sweep |
| `tenant.ts` | 212 | not started |  |  |
| `term.ts` | 245 | not started |  |  |
| `tmux.ts` | 816 | not started |  |  |
| `todos.ts` | 42 | not started |  |  |
| `touch.ts` | 269 | partial | core `touch.rs` | `withName` only; the overlap scan waits on runs |
| `transcribe.ts` | 100 | not started |  |  |
| `treelines.ts` | 166 | partial | core `treelines.rs` | the tree and spec listings; the drift listing waits on trigger.ts |
| `treewords.ts` | 82 | partial | core `treewords.rs` | `treeWords` only |
| `treework.ts` | 267 | not started |  |  |
| `trigger.ts` | 1282 | not started |  |  |
| `types.ts` | 4875 | partial | core `types.rs` | the scan's types, `AwakeInfo`, `AWAKE_MODES` and `awakeWords`; the rest as they are needed |
| `understand.ts` | 284 | partial | core `understand.rs` | `understandLine`, `isWait`, `PREPARING_WORDS` |
| `understandvendor.ts` | 53 | not started |  |  |
| `vault.ts` | 177 | not started |  |  |
| `verdict.ts` | 201 | not started |  |  |
| `version.ts` | 50 | ported | core `version.rs` |  |
| `voice.ts` | 102 | not started |  |  |
| `voicelive.ts` | 120 | not started |  |  |
| `voicewire.ts` | 227 | not started |  |  |
| `warm.ts` | 233 | not started |  |  |
| `webpush.ts` | 206 | not started |  |  |
| `wirereplay.ts` | 409 | not started |  |  |
| `work.ts` | 257 | partial | core `work.rs` | `WORK_STATES`, `isWorkId`, `workIdOf`, `fromWord` and `noteStamp`; the store and the export wait on the server |
| `workflow.ts` | 373 | ported | core `workflow.rs` | the whole parser |
| `workflows.ts` | 71 | partial | core `workflows.rs` | no `readFlowModes`; a read error such as EISDIR is worded differently |
| `workstore.ts` | 116 | not started |  |  |
| `worktree.ts` | 367 | not started |  |  |

### src/server

| Module | Lines | Status | Rust | Notes |
|---|---:|---|---|---|
| `actor.ts` | 25 | not started |  |  |
| `answers.ts` | 40 | not started |  |  |
| `archify.ts` | 220 | not started |  |  |
| `asks.ts` | 362 | not started |  |  |
| `body.ts` | 33 | not started |  |  |
| `branchtrees.ts` | 719 | not started |  |  |
| `callers.ts` | 885 | ported | auth `book.rs`, `gate.rs`, `auth.rs` | reads and writes the same callers.json, both ways |
| `capacity.ts` | 717 | not started |  |  |
| `clips.ts` | 436 | not started |  |  |
| `collisions.ts` | 359 | not started |  |  |
| `coordinator.ts` | 1394 | not started |  |  |
| `diagnosis.ts` | 232 | not started |  |  |
| `floorplan.ts` | 212 | not started |  |  |
| `forgejo.ts` | 72 | not started |  |  |
| `goalfiles.ts` | 263 | not started |  |  |
| `groups.ts` | 1180 | not started |  |  |
| `health.ts` | 345 | not started |  |  |
| `healthstore.ts` | 122 | not started |  |  |
| `incubator.ts` | 271 | not started |  |  |
| `index.ts` | 9346 | partial | server `app.rs`, `gate.rs`, `routes.rs`, `gated.rs`, `tree.rs`, `presence.rs` | the page, tree, about, sources and the event stream with its devices; the first-load reads (backends, workspaces, launchers, agents, kept shells, client, peers with sync off, devices) and the empty live lists; the tmux, broker and voice gates; 16 first-load routes and every other answer 501 |
| `kit.ts` | 734 | not started |  |  |
| `landing.ts` | 1382 | not started |  |  |
| `layouts.ts` | 169 | partial | server `routes.rs` | `GET /api/layouts`, read at each call |
| `libsync.ts` | 496 | not started |  |  |
| `linear.ts` | 182 | not started |  |  |
| `notes.ts` | 266 | partial | server `routes.rs` | `GET /api/notes`; no writes or reminders |
| `peers.ts` | 173 | not started |  |  |
| `people.ts` | 609 | partial | server `people.rs` | `GET /api/people` and `POST /api/people/at`; no roster changes |
| `providers.ts` | 191 | not started |  |  |
| `prs.ts` | 1082 | not started |  |  |
| `prscenarios.ts` | 119 | not started |  |  |
| `pulse.ts` | 107 | not started |  |  |
| `push.ts` | 389 | not started |  |  |
| `ranger.ts` | 937 | not started |  |  |
| `registry.ts` | 233 | partial | server `gated.rs` | the answer with no broker |
| `repohealth.ts` | 391 | not started |  |  |
| `runtools.ts` | 85 | not started |  |  |
| `scenarios.ts` | 324 | not started |  |  |
| `scope.ts` | 145 | not started |  |  |
| `secrets.ts` | 332 | not started |  |  |
| `stacks.ts` | 85 | not started |  |  |
| `stalls.ts` | 151 | not started |  |  |
| `sweep.ts` | 624 | not started |  |  |
| `tailchan.ts` | 258 | partial | server `gated.rs` | the answer with no broker address |
| `tasks.ts` | 1024 | partial | server `gated.rs` | the answer with no tmux |
| `triggers.ts` | 1388 | not started |  |  |
| `understand.ts` | 441 | not started |  |  |
| `warm.ts` | 559 | not started |  |  |
| `work.ts` | 301 | not started |  |  |

### src/cli

| Module | Lines | Status | Rust | Notes |
|---|---:|---|---|---|
| `api.ts` | 71 | partial | cli `api.rs` | `apiBase`, `tokenFile` and `callerToken`, read from one `Caller`; `helperTokenFile` comes with `canopy helper` |
| `archify.ts` | 112 | ported | cli `archify.rs` |  |
| `auth.ts` | 195 | not started |  |  |
| `awake.ts` | 25 | ported | cli `awake.rs` |  |
| `capacity.ts` | 165 | ported | cli `capacity.rs` | holds `hitStands` and `resetWord` from core capacity.ts |
| `clips.ts` | 254 | ported | cli `clips.rs` | its own reqwest client for a file's bytes; Bun's MIME table by extension copied |
| `coordinator.ts` | 174 | not started |  |  |
| `costs.ts` | 174 | ported | cli `costs.rs` | the reads per target go out together; the first failure back is the one reported |
| `diagnosis.ts` | 117 | ported | cli `diagnosis.rs` |  |
| `drift.ts` | 57 | not started |  |  |
| `floorplan.ts` | 93 | ported | cli `floorplan.rs` |  |
| `fr.ts` | 294 | ported | cli `fr.rs` | every sub-command |
| `groups.ts` | 141 | ported | cli `groups.rs` |  |
| `health.ts` | 523 | ported | cli `health.rs`, `ask.rs` | list, show, heal, watch, checks, add, rm, lint, init; `ask`, `targetsOf` and the error classes in `ask.rs` |
| `incubator.ts` | 307 | not started |  |  |
| `index.ts` | 946 | partial | cli `main.rs` | tree, status, version, commit, push, pull, note, awake, issues, pr, prs, scenarios, sweep, kit, loadouts, groups, work, land, queue, collisions, floorplan, archify, diagnosis, understand, capacity, costs, plugins, people, clip, clips, worktrees, fr, workflow, health, help and `--token` run in Rust; every other verb goes to the TS CLI |
| `issues.ts` | 65 | ported | cli `issues.rs` |  |
| `kit.ts` | 95 | ported | cli `kit.rs` |  |
| `land.ts` | 164 | ported | cli `land.rs` | land, queue and collisions |
| `libsync.ts` | 63 | not started |  |  |
| `loadouts.ts` | 117 | ported | cli `loadouts.rs` |  |
| `mcp.ts` | 83 | not started |  |  |
| `newargs.ts` | 102 | not started |  |  |
| `notes.ts` | 74 | ported | cli `notes.rs` | the reminder's time printed by `jsdate.rs` |
| `peersroot.ts` | 19 | not started |  |  |
| `people.ts` | 243 | ported | cli `people.rs` | `statusWords` (auth.ts) copied into its tests only |
| `plugins.ts` | 165 | ported | cli `plugins.rs` | holds `isPluginAgent` and `opText` from core plugins.ts |
| `pr.ts` | 87 | ported | cli `prs.rs` |  |
| `push.ts` | 69 | not started |  |  |
| `render.ts` | 29 | partial | cli `main.rs`, `help.rs` | the tree's colors and the help's bold name |
| `run-transcripts.ts` | 270 | not started |  |  |
| `run.ts` | 305 | partial | cli `mapsection.rs`, `worktrees.rs` | private copies of `selectedTarget`, `repoId`, `folderOf`, `isPathArgument`; the verb is not started |
| `scenarios.ts` | 82 | ported | cli `scenarios.rs` |  |
| `secrets.ts` | 494 | not started |  |  |
| `sweep.ts` | 90 | ported | cli `sweep.rs` |  |
| `tenant.ts` | 419 | not started |  |  |
| `understand.ts` | 123 | ported | cli `understand.rs` |  |
| `work.ts` | 122 | ported | cli `work.rs` | `work note` reads the branch through `exec.rs` |
| `workflow.ts` | 186 | ported | cli `workflow.rs` | list, show, `--dot`, check |
| `worktrees.ts` | 358 | ported | cli `worktrees.rs` |  |

### src/stage

| Module | Lines | Status | Rust | Notes |
|---|---:|---|---|---|
| `fencecheck.ts` | 80 | not started |  |  |
| `logincheck.ts` | 203 | not started |  |  |
| `main.ts` | 105 | not started |  |  |
| `runner.ts` | 860 | not started |  |  |
| `settingscheck.ts` | 123 | not started |  |  |

### src/egress

| Module | Lines | Status | Rust | Notes |
|---|---:|---|---|---|
| `allow.ts` | 84 | not started |  |  |
| `main.ts` | 41 | not started |  |  |
| `proxy.ts` | 216 | not started |  |  |

### src/secrets

| Module | Lines | Status | Rust | Notes |
|---|---:|---|---|---|
| `audit.ts` | 42 | not started |  |  |
| `gate.ts` | 232 | not started |  |  |
| `main.ts` | 189 | not started |  |  |
| `pending.ts` | 64 | not started |  |  |
| `service.ts` | 733 | not started |  |  |
| `stacks.ts` | 80 | not started |  |  |
| `store.ts` | 220 | not started |  |  |
