# The Rust port

canopy's backend and CLI are moving from Bun and TypeScript to Rust, on Eric's ask of 2026-11-27 ("migrate canopy to Rust"). The React page in `ui/` stays TypeScript: it already runs in the browser, and it imports its types and pure helpers from `src/core/`, which keep working while the server underneath changes.

This page is the ledger. It says what is in Rust, how it was checked, the rules a later session keeps, and every TypeScript module with its status, so the next session starts from here.

## Where it stands

The port runs beside the TypeScript. Bun still runs everything that ships: the Mac's launchd server, the mini's and De Soto's compose stacks, and the `canopy` CLI on every machine. Nothing switches until a cutover Eric says yes to.

`rust/` is a Cargo workspace of four crates:

| Crate | What it is | From |
|---|---|---|
| `canopy-core` | exec, ssh locators, the seed guard, config, remotes, card meta, the shared spec, git reads, the scan, the tree's lines, the build version | `src/core/` |
| `canopy-auth` | caller tokens, rights, the callers book, the request gate, the auth routes, the origin gate, CORS | `src/core/callers.ts`, `src/server/callers.ts`, `src/core/library.ts`, `src/core/cors.ts` |
| `canopy-cli` | the binary `canopy-rs` | `src/cli/` |
| `canopy-server` | the binary `canopy-server` | `src/server/index.ts` |

Of 315 modules (106,675 lines of TypeScript under `src/core`, `src/server`, `src/cli`, `src/stage`, `src/egress` and `src/secrets`), 11 are ported, 12 are in part and 292 are not started. The table at the end lists each.

## What runs in Rust today

- `canopy-rs` answers `canopy [dir]`, `canopy tree`, `canopy status` and `canopy version` itself. Any other verb, and any of those with a flag, goes to `bun bin/canopy.ts` with the same arguments and exit code, so `canopy-rs` can stand in for `canopy` now. `CANOPY_TS_CLI` points it at another entry.
- `canopy-server` serves the built page (`dist/web`, with the page as the fallback for client routes), `GET /api/tree`, `/api/about`, `/api/sources` and the `/api/events` stream (`: hello`, then a `scan` frame after each rescan, every 30 seconds). Every request passes the same gate as the Bun server's `route()`: the preflight, the caller token or the loopback bypass, the coordinator's lane, the rights gate in `CANOPY_CALLERS` mode, the origin gate, then the auth routes. Every other API route answers 501 with "not in the Rust port yet". People's folder scopes, the Library, websockets and every feature route are not here yet.
- `canopy-server` refuses to start without `CANOPY_CONFIG_DIR`, and defaults to port 7860. The Bun server owns `~/.config/canopy` and port 7850 until the cutover; two servers writing `callers.json` would corrupt it.

## How it was checked

- `cd rust && cargo test --workspace` runs 300 tests. Most are the TypeScript tests ported case by case: `exec.test.ts`, `host.test.ts`, `seedgit.test.ts`, `git.test.ts` (the read half, against real repos), `scan.test.ts`, `meta.test.ts`, `spec.test.ts`, `treelines.test.ts`, `access.test.ts` (remotes), and the callers tests.
- `canopy-auth`'s parity tests read fixtures the TypeScript wrote (`rust/crates/canopy-auth/scripts/gen-fixtures.ts`): what every route needs for 5,796 paths by 7 methods, 68,400 origin cases, and a `callers.json` the TS minted. The Rust reads that book, checks its 9 tokens and writes it back byte for byte; `scripts/check-rust.ts` checks the other direction.
- `bash scripts/rust-parity.sh [folder]` runs the TypeScript CLI and `canopy-rs` on the same folder against a scratch config dir and diffs tree, status, the bare form, version and a missing folder. On `~/dev` (175 lines of tree) every one came out byte-identical, with the last column (how long ago the newest commit was) masked because a scan of that size lets it tick over between the two runs.
- `canopy-server` was run on a scratch port and config dir against the real `dist/web`: the page and its assets load, `/api/tree` returns the scan, a cross-site Origin gets `{"error":"Foreign origin"}`, the stream says `: hello`, and with `CANOPY_CALLERS=log` it prints the TS's own "callers: would refuse" lines. It wrote nothing to its config dir.

No speed claim yet. Timings taken on 2026-11-27 ran on a machine at a load average near 90, and a single run of either CLI on `~/dev` varied from 7 to 40 seconds.

## Rules for the rest of the port

- State files round-trip byte for byte. A Rust module that writes a file the TypeScript also writes (config, callers, runs, notes, anything under `~/.config/canopy/` or a repo's `.canopy/`) must write what the TS would write, key order and trailing newline included, and read what the TS wrote. `serde_json` has `preserve_order` on for this.
- JavaScript's rules where output is compared: `pathx.rs` has Node's `path` functions, UTF-16 lengths for padding, JavaScript's sort order, JavaScript's whitespace for `trim` and `\s` (`JS_S`), and a field that is absent in TS JSON is `skip_serializing_if` in Rust while a `null` one is a plain `Option`.
- Test against a scratch `CANOPY_CONFIG_DIR` and a port other than 7850, never the live server's state.
- Port a module with its tests. A behaviour the TypeScript tests check is a Rust test too.
- Tests run on macOS and Linux, so a test that shells out uses flags both BSD and GNU tools take.
- Blocking file work in async code goes through `spawn_blocking`; the scan's eight-at-a-time workers share one task.
- `unsafe_code` is denied workspace-wide; `rustix` covers signals.
- Do not touch the Dockerfile, the compose files or the launchd agent for the port. The cutover changes them, once, with Eric's yes.

## What comes next

In about this order, each its own task:

1. `git.ts`'s write half (stage, commit, push, pull, diff) and the remaining CLI verbs that need only core and HTTP (`src/cli/api.ts`), so `canopy-rs` stops delegating the common ones.
2. The server's read routes the page calls on load, then the SSE events the page listens for, so the page renders from `canopy-server` with no 501 on first load.
3. Runs: `runner.ts`, `driver.ts`, `claudedrive.ts` and the stream-json fold, then `codexrun.ts` and `antigravity.ts`.
4. Shells: `term.ts` and the tmux bridge over websockets.
5. Flows, workflows, peers, the Library, people and tenants, the coordinator.
6. The separate processes: `src/stage`, `src/egress`, `src/secrets`.
7. The cutover: the launchd agent, the compose images and `canopy` on PATH switch to the Rust binaries, with the TS kept one release for a rollback.

## Every module

Status is `ported` when the module's behaviour and tests are in Rust, `partial` when some of it is (the notes say what), and `not started` otherwise. Line counts are the TypeScript file's.

### src/core

| Module | Lines | Status | Rust | Notes |
|---|---:|---|---|---|
| `access.ts` | 122 | partial | core `meta.rs` | listRemotes only |
| `acpfold.ts` | 379 | not started |  |  |
| `actions.ts` | 576 | not started |  |  |
| `activity.ts` | 811 | not started |  |  |
| `agent.ts` | 66 | not started |  |  |
| `agentscan.ts` | 361 | not started |  |  |
| `agentstatus.ts` | 152 | not started |  |  |
| `antigravity.ts` | 614 | not started |  |  |
| `applied.ts` | 33 | not started |  |  |
| `archify.ts` | 327 | not started |  |  |
| `archifyvendor.ts` | 50 | not started |  |  |
| `archive.ts` | 23 | not started |  |  |
| `awake.ts` | 191 | not started |  |  |
| `backendid.ts` | 28 | not started |  |  |
| `backends.ts` | 50 | not started |  |  |
| `branchtrees.ts` | 464 | not started |  |  |
| `browse.ts` | 88 | not started |  |  |
| `build.ts` | 50 | ported | core `version.rs` |  |
| `builtincheck.ts` | 81 | not started |  |  |
| `callers.ts` | 314 | ported | auth `rights.rs` | checked against 5796 paths x 7 methods the TS answered |
| `canopymcp.ts` | 402 | not started |  |  |
| `capacity.ts` | 679 | not started |  |  |
| `cards.ts` | 67 | not started |  |  |
| `chan.ts` | 319 | not started |  |  |
| `check.ts` | 145 | not started |  |  |
| `claudedrive.ts` | 794 | not started |  |  |
| `claudefold.ts` | 276 | not started |  |  |
| `cli.ts` | 14 | not started |  |  |
| `client.ts` | 57 | partial | auth `origin.rs` | isLoopback and isLoopbackHost only |
| `clips.ts` | 504 | not started |  |  |
| `codexfold.ts` | 368 | not started |  |  |
| `codexrpc.ts` | 363 | not started |  |  |
| `codexrun.ts` | 1100 | not started |  |  |
| `codextrust.ts` | 80 | not started |  |  |
| `compose.ts` | 92 | not started |  |  |
| `coordinator.ts` | 1104 | not started |  |  |
| `cors.ts` | 33 | ported | auth `cors.rs` |  |
| `costledger.ts` | 172 | not started |  |  |
| `costs.ts` | 238 | not started |  |  |
| `costsheet.ts` | 273 | not started |  |  |
| `cron.ts` | 246 | not started |  |  |
| `deploy.ts` | 190 | not started |  |  |
| `diagnosis.ts` | 312 | not started |  |  |
| `digest.ts` | 111 | not started |  |  |
| `driver.ts` | 722 | not started |  |  |
| `emulatord.ts` | 236 | not started |  |  |
| `emulators.ts` | 246 | not started |  |  |
| `envnames.ts` | 83 | not started |  |  |
| `evidence.ts` | 37 | not started |  |  |
| `exec.ts` | 287 | ported | core `exec.rs` | exec, onHost, git, the seed guard's hook (`SeedGitHook`) |
| `explain.ts` | 1296 | not started |  |  |
| `export.ts` | 110 | not started |  |  |
| `favorite.ts` | 32 | not started |  |  |
| `filekind.ts` | 62 | not started |  |  |
| `finder.ts` | 161 | not started |  |  |
| `firebase.ts` | 131 | not started |  |  |
| `floorplan.ts` | 221 | not started |  |  |
| `floorplanvendor.ts` | 165 | not started |  |  |
| `flow.ts` | 1959 | not started |  |  |
| `flowgraph.ts` | 119 | not started |  |  |
| `flowmodes.ts` | 58 | not started |  |  |
| `flowstore.ts` | 250 | not started |  |  |
| `forge.ts` | 224 | not started |  |  |
| `forgejoissues.ts` | 85 | not started |  |  |
| `forkcut.ts` | 164 | not started |  |  |
| `fr.ts` | 126 | not started |  |  |
| `gatename.ts` | 4 | not started |  |  |
| `gates.ts` | 132 | not started |  |  |
| `git.ts` | 1309 | partial | core `git.rs` | the read half: status, elsewhere, log, fetch and their parsers; commit, push, pull, stage and diff are not |
| `github.ts` | 122 | not started |  |  |
| `going.ts` | 55 | not started |  |  |
| `group.ts` | 238 | not started |  |  |
| `guards.ts` | 121 | not started |  |  |
| `handoff.ts` | 93 | not started |  |  |
| `harness.ts` | 284 | not started |  |  |
| `harnessshare.ts` | 201 | not started |  |  |
| `health.ts` | 130 | not started |  |  |
| `help.ts` | 283 | not started |  |  |
| `helper.ts` | 231 | not started |  |  |
| `helperd.ts` | 267 | not started |  |  |
| `herdr.ts` | 248 | not started |  |  |
| `history.ts` | 248 | not started |  |  |
| `historymerge.ts` | 32 | not started |  |  |
| `host.ts` | 110 | ported | core `host.rs` |  |
| `improvements.ts` | 94 | not started |  |  |
| `incubator.ts` | 1865 | not started |  |  |
| `issue.ts` | 243 | not started |  |  |
| `jev.ts` | 114 | not started |  |  |
| `keep.ts` | 262 | not started |  |  |
| `kit.ts` | 714 | not started |  |  |
| `kitapply.ts` | 142 | not started |  |  |
| `kitfake.ts` | 42 | not started |  |  |
| `kitmcp.ts` | 404 | not started |  |  |
| `kitscan.ts` | 359 | not started |  |  |
| `landing.ts` | 386 | not started |  |  |
| `launch.ts` | 292 | not started |  |  |
| `launcher.ts` | 838 | not started |  |  |
| `leftovers.ts` | 127 | not started |  |  |
| `library.ts` | 252 | partial | auth `origin.rs` | the origin gate only |
| `libsync.ts` | 432 | not started |  |  |
| `loadout.ts` | 482 | not started |  |  |
| `mentions.ts` | 310 | not started |  |  |
| `meta.ts` | 261 | ported | core `meta.rs` |  |
| `move.ts` | 243 | not started |  |  |
| `notes.ts` | 133 | not started |  |  |
| `offer.ts` | 35 | not started |  |  |
| `openers.ts` | 737 | not started |  |  |
| `panesizes.ts` | 129 | not started |  |  |
| `passkeeper.ts` | 93 | not started |  |  |
| `paste.ts` | 63 | not started |  |  |
| `peers.ts` | 219 | not started |  |  |
| `peersync.ts` | 1494 | not started |  |  |
| `people.ts` | 486 | partial | auth `people.rs` | roles and rights; the people store and teams are not |
| `pickscript.ts` | 236 | not started |  |  |
| `pluginfake.ts` | 177 | not started |  |  |
| `plugins.ts` | 426 | not started |  |  |
| `pluginscan.ts` | 289 | not started |  |  |
| `ports.ts` | 277 | not started |  |  |
| `pr.ts` | 250 | not started |  |  |
| `presence.ts` | 95 | not started |  |  |
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
| `repohealth.ts` | 203 | not started |  |  |
| `retro.ts` | 374 | not started |  |  |
| `review.ts` | 356 | not started |  |  |
| `route.ts` | 406 | not started |  |  |
| `runerror.ts` | 55 | not started |  |  |
| `runlog.ts` | 536 | not started |  |  |
| `runname.ts` | 134 | not started |  |  |
| `runnamer.ts` | 83 | not started |  |  |
| `runner.ts` | 1267 | not started |  |  |
| `runtools.ts` | 48 | not started |  |  |
| `scan.ts` | 393 | partial | core `scan.rs` | local and ssh sources; forgejo sources are not |
| `scenario.ts` | 159 | not started |  |  |
| `scope.ts` | 353 | not started |  |  |
| `screenlayouts.ts` | 332 | not started |  |  |
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
| `stalecopy.ts` | 186 | not started |  |  |
| `stall.ts` | 95 | not started |  |  |
| `steer.ts` | 68 | not started |  |  |
| `store.ts` | 698 | partial | core `store.rs` | config path, loadConfig's maxDepth and ignore; the other settings ride along as raw JSON |
| `suggest.ts` | 190 | not started |  |  |
| `sweep.ts` | 265 | not started |  |  |
| `sweepstore.ts` | 182 | not started |  |  |
| `tailchan.ts` | 427 | not started |  |  |
| `taskrun.ts` | 165 | not started |  |  |
| `tasks.ts` | 515 | not started |  |  |
| `tenant.ts` | 212 | not started |  |  |
| `term.ts` | 245 | not started |  |  |
| `tmux.ts` | 816 | not started |  |  |
| `todos.ts` | 42 | not started |  |  |
| `touch.ts` | 269 | not started |  |  |
| `transcribe.ts` | 100 | not started |  |  |
| `treelines.ts` | 166 | partial | core `treelines.rs` | the tree and spec listings; the drift listing waits on trigger.ts |
| `treewords.ts` | 82 | not started |  |  |
| `treework.ts` | 267 | not started |  |  |
| `trigger.ts` | 1282 | not started |  |  |
| `types.ts` | 4875 | partial | core `types.rs` | the scan's types; the rest as they are needed |
| `understand.ts` | 284 | not started |  |  |
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
| `work.ts` | 257 | not started |  |  |
| `workflow.ts` | 373 | not started |  |  |
| `workflows.ts` | 71 | not started |  |  |
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
| `index.ts` | 9346 | partial | server `app.rs`, `gate.rs` | the page, /api/tree, /api/about, /api/sources, /api/events and the request gate; every other route answers 501 |
| `kit.ts` | 734 | not started |  |  |
| `landing.ts` | 1382 | not started |  |  |
| `layouts.ts` | 169 | not started |  |  |
| `libsync.ts` | 496 | not started |  |  |
| `linear.ts` | 182 | not started |  |  |
| `notes.ts` | 266 | not started |  |  |
| `peers.ts` | 173 | not started |  |  |
| `people.ts` | 609 | not started |  |  |
| `providers.ts` | 191 | not started |  |  |
| `prs.ts` | 1082 | not started |  |  |
| `prscenarios.ts` | 119 | not started |  |  |
| `pulse.ts` | 107 | not started |  |  |
| `push.ts` | 389 | not started |  |  |
| `ranger.ts` | 937 | not started |  |  |
| `registry.ts` | 233 | not started |  |  |
| `repohealth.ts` | 391 | not started |  |  |
| `runtools.ts` | 85 | not started |  |  |
| `scenarios.ts` | 324 | not started |  |  |
| `scope.ts` | 145 | not started |  |  |
| `secrets.ts` | 332 | not started |  |  |
| `stacks.ts` | 85 | not started |  |  |
| `stalls.ts` | 151 | not started |  |  |
| `sweep.ts` | 624 | not started |  |  |
| `tailchan.ts` | 258 | not started |  |  |
| `tasks.ts` | 1024 | not started |  |  |
| `triggers.ts` | 1388 | not started |  |  |
| `understand.ts` | 441 | not started |  |  |
| `warm.ts` | 559 | not started |  |  |
| `work.ts` | 301 | not started |  |  |

### src/cli

| Module | Lines | Status | Rust | Notes |
|---|---:|---|---|---|
| `api.ts` | 71 | not started |  |  |
| `archify.ts` | 112 | not started |  |  |
| `auth.ts` | 195 | not started |  |  |
| `awake.ts` | 25 | not started |  |  |
| `capacity.ts` | 165 | not started |  |  |
| `clips.ts` | 254 | not started |  |  |
| `coordinator.ts` | 174 | not started |  |  |
| `costs.ts` | 174 | not started |  |  |
| `diagnosis.ts` | 117 | not started |  |  |
| `drift.ts` | 57 | not started |  |  |
| `floorplan.ts` | 93 | not started |  |  |
| `fr.ts` | 294 | not started |  |  |
| `groups.ts` | 141 | not started |  |  |
| `health.ts` | 523 | not started |  |  |
| `incubator.ts` | 307 | not started |  |  |
| `index.ts` | 946 | partial | cli `main.rs` | tree, status and version run in Rust; every other verb goes to the TS CLI |
| `issues.ts` | 65 | not started |  |  |
| `kit.ts` | 95 | not started |  |  |
| `land.ts` | 164 | not started |  |  |
| `libsync.ts` | 63 | not started |  |  |
| `loadouts.ts` | 117 | not started |  |  |
| `mcp.ts` | 83 | not started |  |  |
| `newargs.ts` | 102 | not started |  |  |
| `notes.ts` | 74 | not started |  |  |
| `peersroot.ts` | 19 | not started |  |  |
| `people.ts` | 243 | not started |  |  |
| `plugins.ts` | 165 | not started |  |  |
| `pr.ts` | 87 | not started |  |  |
| `push.ts` | 69 | not started |  |  |
| `render.ts` | 29 | partial | cli `main.rs` | the tree's colors |
| `run-transcripts.ts` | 270 | not started |  |  |
| `run.ts` | 305 | not started |  |  |
| `scenarios.ts` | 82 | not started |  |  |
| `secrets.ts` | 494 | not started |  |  |
| `sweep.ts` | 90 | not started |  |  |
| `tenant.ts` | 419 | not started |  |  |
| `understand.ts` | 123 | not started |  |  |
| `work.ts` | 122 | not started |  |  |
| `workflow.ts` | 186 | not started |  |  |
| `worktrees.ts` | 358 | not started |  |  |

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
