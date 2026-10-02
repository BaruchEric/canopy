# Token-free incubator stages

Status: draft, 2026-10-02. Follows the incubator spec (`2026-10-01-incubator-design.md`) and its amendment 2. Builds on `feat/incubator-phase-3`.

## The problem

Phase 3 keeps an incubator stage from holding canopy's credentials through its tool allowlist and an env scrub (`stageEnv`). That is not a boundary, for three reasons:

- **Agents run code.** Build-new's `bun run`, and any check that runs seed code, execute as canopy's uid in canopy's pid namespace. That code can read `/proc/<canopy>/environ`, which still holds the starting env with `GH_TOKEN`, `VERCEL_TOKEN`, the vault token and the transcribe key. It can also read the mounted `~/.ssh` keys and anything else canopy's container mounts.
- **Canopy runs git inside seeds.** The watcher, `getStatus`, the fetch, the peer pass and ship's clone all do this, as canopy and with canopy's full env. The seed's `.git/config` is written by the agents, so a `core.fsmonitor`, a filter driver, an `include.path`, `core.sshCommand` or an `ext::` url makes canopy's next status read run agent code as canopy.
- **Stage runs read the seed's own settings.** Stage Claude runs read `--setting-sources user,project,local`, so a step with only `Write` can drop a `.claude/settings.json` that gives the next step hooks or wider permissions. Codex reads a project's own config once the project is trusted.

## What this delivers

Three parts. Parts 1 and 2 are small, close live holes on the phase 3 branch, and should land before phase 3 merges. Part 3 is the container.

### Part 1: canopy's git never runs a seed's config

Every git command canopy runs on a path under `<root>/_incubator/` goes through a guard:

- The guard reads the seed's `.git/config` with `git config --file <f> --no-includes --list --null`, which parses and never follows an include.
- It allows only the keys canopy and plain commits write:
  - `core.repositoryformatversion`, `core.filemode`, `core.bare`, `core.logallrefupdates`, `core.ignorecase`, `core.precomposeunicode`, `core.symlinks`
  - `remote.<name>.url`, `remote.<name>.fetch`, `remote.<name>.pushurl`, `remote.<name>.tagopt`
  - `branch.<name>.remote`, `branch.<name>.merge`
  - `user.name`, `user.email`
  - `extensions.objectformat`
- Any other key refuses the command with the key named. So does a url holding `::`, or a url or pushurl that starts with `-`.
- A `.git` that is a file (a gitfile) or a symlink refuses, and so does one holding `commondir` or `config.worktree`, since either points git at a config the guard never read.
- The guard judges the `.git` git itself would use, walking up from the path to the seed's top folder. Every seed git call sets `GIT_CEILING_DIRECTORIES` to the seeds dir, so git never walks past it.
- Every allowed command also ignores submodules (`diff.ignoreSubmodules=all`, `submodule.recurse=false`, `fetch.recurseSubmodules=false`): a committed gitlink with its own `.git` folder would otherwise run that folder's config.
- The reading is memoized by the config file's mtime and size.
- Every allowed command also carries `-c core.fsmonitor=false -c core.hooksPath=/dev/null -c protocol.ext.allow=never`.
- The guard runs in `git()`, in `seed.ts`'s own git calls, before ship clones a seed, and in the peer gate before it serves one.
- A refused seed's card shows the reason as its scan error, and the Incubator parks the sprout with it. Normal repos are untouched.
- The guard reads the config, then git reads it again, so code still running in the seed could swap it in between. Canopy therefore runs no git in a seed while a stage process or check is alive there, and keeps the card's last status meanwhile. Once Part 3 lands, the runner kills each run's tree when it ends, so the seed is quiet between runs.

### Part 2: a stage reads no settings of the seed's

- A stage Claude run uses `--setting-sources user`.
- Codex reads a project's own config only once that project is trusted, and it records trust as a `[projects."<dir>"]` table in its config. Canopy removes any such table under `<root>/_incubator/` at start and again before every stage Codex run. `codex app-server` never asks to trust a folder, so nothing writes one back in between.

### Part 2b: nothing canopy starts on its own runs in a seed

- A task in a seed never starts by `keep` or start-with-panel: the task hub treats a seed as not the user's own.
- A shell in a seed never starts an agent: `start=agent`, resume, and restore with continue are refused with "a seed's agents run through the incubator; open a plain shell to work in it yourself". The UI opens a seed's panel with a plain shell.
- A commit suggestion for a seed runs its harness from a scratch folder, with the stage env, so it reads none of the seed's settings.
- The launcher does not build a seed.

### Part 3: stages run in a container with no tokens

**The stages container.** A new compose service, `stages`, built from a Dockerfile stage `stages`:

- It is the shells image's runtime, user, claude, codex, bun and git, without gh, plus one bundled file, the stage runner.
- It has its own pid namespace. No `pid: service:` and no `network_mode: service:`, so `/proc/<canopy>` is not in it.
- It holds no token: no `GH_TOKEN`, no Vercel or vault token, no `~/.ssh`, no `~/.config/git`, no root `.env`, no docker socket.
- It mounts exactly four things:
  - `<root>/_incubator` read-write, at the same absolute path as in canopy.
  - `<root>/_incubator/.shared` read-only over it, at the same path.
  - Its own Claude config dir (`CLAUDE_CONFIG_DIR`) and Codex home (`CODEX_HOME`) under the host's `~/.config/canopy-stages/`. Eric logs each one in once.
  - A named volume `stage-sock` for the runner's socket, which canopy also mounts.
- It sits on its own bridge network on a fixed subnet outside every range the mini's firewall lets reach host ports.

**The stage runner.** `canopy-stage-runner`, a Bun daemon listening on a unix socket in `stage-sock`. One connection carries one process:

- The first frame is a request: `{argv, cwd, env}`.
- After it come stdin frames, stdout and stderr frames, and one exit frame, all as JSON lines carrying base64 data.
- The runner refuses an `argv[0]` other than `claude`, `codex` or `sh`.
- It refuses a cwd whose realpath is not a direct, non-dot child of the stage root.
- It builds the child's env from its own minimal base (`PATH`, `HOME`, `LANG`, `TERM`, `CLAUDE_CONFIG_DIR`, `CODEX_HOME`) plus the request's `CANOPY_RUN`, `CANOPY_REPO` and `CANOPY_BACKEND`. Nothing else canopy sends is passed on.
- When the connection closes or a kill frame arrives, it kills the child and every descendant.
- A `hello` request answers with the harnesses on its PATH.

**Canopy's side.**

- `StageClient` turns the socket into the `RpcSpawn` shape the Codex driver already uses, plus an `exec` for checks.
- The Claude driver moves onto the same `RpcSpawn` seam.
- The Runner hands a stage run the stage spawn, and answers the driver's binary check from the runner's hello.
- A seed's checks run through the runner too.
- `@pick-check` and `@questions` are built-in checks. Canopy runs them in its own process over `readSeed`, because canopy's code is not in the stage image.

**Inputs and the workspace.**

- Before a stage, canopy copies the sprout's inputs to `.shared/inputs/<sprout id>/`.
- Before scout, it copies a workspace snapshot to `.shared/workspace/`: the devhub `manifest.json`, `references.json`, and the README.md of every project the manifest lists, capped.
- `withInputsRead` and `withWorkspaceRead` point there.
- Nothing from `canopy-config` is mounted.

**Policy.**

- With `CANOPY_STAGE_SOCKET` set, every stage runs through the runner. If the runner does not answer, a queued sprout stays queued, the incubator view says "the stage runner is not answering", and it starts on the next good hello. A flow whose step start finds the runner away parks, so it resumes.
- Compose starts canopy once the runner answers its healthcheck, and canopy waits for one bounded hello before it restores flows or starts sprouts.
- Without `CANOPY_STAGE_SOCKET`, stages start only when `CANOPY_INCUBATOR_UNISOLATED=1`, which is for a Mac backend and tests. Otherwise sprouts stay queued with "stages need the stage runner (CANOPY_STAGE_SOCKET), or CANOPY_INCUBATOR_UNISOLATED=1".
- `GET /api/incubator` says `isolated`, and the incubator view shows it.

**The network fence.**

- `scripts/stages-fence.sh` prints, and with `--apply` installs, `DOCKER-USER` rules. They drop traffic from the stages subnet to RFC 1918, CGNAT (100.64.0.0/10, the tailnet), link-local and the host's own addresses. Docker's embedded DNS and the internet stay reachable.
- The fence relies on the host's ufw default of deny incoming, since container-to-host traffic is INPUT, not FORWARD. The stages subnet must sit outside 172.16.0.0/12 and outside 192.168.48.0/20, the ranges ufw already lets in.
- A fence check bundled into the stages image (`/app/fence-check.js`, since that image holds no canopy CLI), run inside the container, probes canopy's tailnet address on :7850, the broker on :7855, the bridge gateway and a LAN address, and expects each to fail. It also expects `https://api.anthropic.com` to answer.

## What stays true, and residuals

- Ship stays in canopy, with the Vercel token. It never runs seed code: it clones, pushes and runs `vercel deploy` from a clean clone.
- The env scrub (`stageEnv`) stays as defense in depth for unisolated backends.
- **Residual:** a stage can read its own Claude and Codex OAuth credentials, in the stage config dirs. This is inherent to running the agent.
- **Residual:** a stage can write `_incubator/` itself (a `.git` there, a `.gitattributes`), so the guard never trusts it: seed git calls carry `GIT_CEILING_DIRECTORIES`, canopy runs no git in the seeds dir, and the scan never takes it as a repo.
- **Residual:** a stage can write any seed under `_incubator/`, including other sprouts' seeds. `.shared/` is read-only, but a stage can read every sprout's `.shared/inputs/`.
- **Residual:** what the user starts by hand in a seed (a task, a plain shell and whatever they type there, the guided panel's run button) runs in the shells container with its tokens. That is the user's act. The incubator view says so on a seed's sheet.
- **Residual:** stage egress to the internet is open, so an agent can still send what it can read: the seed, the shared inputs, its own OAuth credentials.
