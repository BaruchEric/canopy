# Token-free incubator stages

Status: built, 2026-10-02, on `feat/incubator-stages` (parts 1 to 2b on `feat/incubator-phase-3`). Follows the incubator spec (`2026-10-01-incubator-design.md`) and its amendment 2; that spec's amendment 3 sums this one up. Where this text and the code differ, this text was corrected to what was built.

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
- A `.git` that is a file (a gitfile) or a symlink refuses, and so does one holding `commondir` or `config.worktree`, since either points git at a config the guard never read. So does a `.git` with no `HEAD`, which git passes over on its way to another one.
- The guard judges the `.git` git itself would use, walking up from the path to the seed's top folder. Every seed git call sets `GIT_CEILING_DIRECTORIES` to the seeds dir, so git never walks past it.
- Every allowed command also ignores submodules (`diff.ignoreSubmodules=all`, `submodule.recurse=false`, `fetch.recurseSubmodules=false`): a committed gitlink with its own `.git` folder would otherwise run that folder's config.
- The reading is memoized by the config file's mtime and size.
- Every allowed command also carries `-c core.fsmonitor=false -c core.hooksPath=/dev/null -c protocol.ext.allow=never -c safe.bareRepository=explicit`. The last stops git taking a seed folder as a bare repo, with a `config` at its top, when its `.git` is unusable.
- The guard runs in `git()`, in `seed.ts`'s own git calls, before ship clones a seed, and in the peer gate before it serves one. The gate judges every folder upload-pack could open for the path asked, by its real path: inside a seed it must be the seed's folder or its `.git`, and the seed's folder must not hold a `HEAD` of its own.
- A refused seed's card shows the reason as its scan error, and the Incubator parks the sprout with it. Normal repos are untouched.
- The guard reads the config, then git reads it again, so code still running in the seed could swap it in between. Canopy therefore runs no git in a seed while a stage process or check is alive there, keeps the card's last status meanwhile, and reads it once the seed is quiet. Once Part 3 lands, the runner kills each run's tree when it ends, so the seed is quiet between runs.

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
- It builds the child's env from its own minimal base (`PATH`, `HOME`, `LANG`, `LC_ALL`, `TERM`, `CLAUDE_CONFIG_DIR`, `CODEX_HOME`) plus the request's `CANOPY_RUN`, `CANOPY_REPO` and `CANOPY_BACKEND`. Nothing else canopy sends is passed on: a request env carrying anything else, a token included, has it dropped.
- When the run ends, the connection closes or a kill frame arrives, it kills the child and every descendant in three layers: the tree it tracked, the child's process group, and every process whose cwd is inside the seed, sparing the trees of other live connections. Before it starts codex it drops every seed's trust from its own codex config.
- A `hello` request answers with the harnesses on its PATH.
- A `busy` request (`{seed}`) answers whether any process has its cwd in that seed. Once a stage run's own process has ended, canopy asks it until it says no before it reads the seed's status, so a process the run left behind counts, not only the pid canopy tracked. An answer that does not come within a bounded wait counts as quiet, with a log line.

**Canopy's side.**

- `StageClient` turns the socket into the `RpcSpawn` shape the Codex driver already uses, plus an `exec` for checks.
- The Claude driver moves onto the same `RpcSpawn` seam.
- The Runner hands a stage run the stage spawn, and answers the driver's binary check from the runner's hello.
- A seed's checks run through the runner too.
- `@pick-check` and `@questions` are built-in checks. Canopy runs them in its own process over `readSeed`, because canopy's code is not in the stage image.

**Inputs and the workspace.**

- Before a stage, canopy copies the sprout's inputs to `.shared/inputs/<sprout id>/`.
- Before scout, it copies a workspace snapshot to `.shared/workspace/<sprout id>/`: the devhub `manifest.json`, `references.json`, and the README.md of every project the manifest lists whose real path stays inside the workspace, capped. Each sprout gets its own, built in a temp folder of its own, so two scouts never swap one out from under the other.
- `withInputsRead` and `withWorkspaceRead` point there. Sharing happens in every mode, unisolated too.
- Nothing from `canopy-config` is mounted.

**Policy.**

- With `CANOPY_STAGE_SOCKET` set, every stage runs through the runner. If the runner does not answer, a queued sprout stays queued, the incubator view says "the stage runner is not answering", and it starts on the next good hello. A flow whose step or check finds the runner away, or whose run loses the runner under it, parks for the stage runner, and resumes on its own at the next good hello; a parked check reruns only the check. A park of the user's own (a gate) never resumes on its own.
- Compose starts canopy once the runner answers its healthcheck, and canopy waits for one bounded hello before it restores flows or starts sprouts.
- Without `CANOPY_STAGE_SOCKET`, stages start only when `CANOPY_INCUBATOR_UNISOLATED=1`, which is for a Mac backend and tests. Otherwise sprouts stay queued with "stages need the stage runner (CANOPY_STAGE_SOCKET), or CANOPY_INCUBATOR_UNISOLATED=1".
- `GET /api/incubator/stages` answers `{isolated, mode, waiting}` (`mode` is `runner`, `unisolated` or `off`), a `stages` event carries it on every change, and the incubator view shows it.

**The network fence.**

- The stages network is `stages-net`, 10.250.13.0/24, v4 only (`enable_ipv6: false`), on a host bridge docker names `br-canopy-stg` (`com.docker.network.bridge.name`; an interface name holds at most 15 characters).
- `scripts/stages-fence.sh` prints the rules, and with `--apply` inserts each one that is missing (`-C` before every `-I`, so a rerun changes nothing). They sit in the raw table's `PREROUTING` and match `-i br-canopy-stg`, the interface a packet arrived on, which nothing inside the container can change. They drop every packet to 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 100.64.0.0/10 (the tailnet), 169.254.0.0/16, 224.0.0.0/4, 255.255.255.255/32 and 0.0.0.0/8. `ip6tables -t raw -I PREROUTING -i br-canopy-stg -j DROP` drops every IPv6 packet from it.
- Raw `PREROUTING` runs before routing, docker's DNAT and every filter chain. So the drops cover the host's own addresses (INPUT) as well as forwarded traffic, and no filter chain's order (docker's, ufw's, tailscale's `ts-forward`) can let a packet past them. A ufw reload or a docker restart does not flush them. Replies to the container's own connections arrive on the uplink or `tailscale0`, never on the bridge, so they pass. Traffic between containers on the bridge is dropped too; stages is alone on its network.
- `--install`, run once as root, writes a root-owned copy of the script, with its `CHECKOUT` switch off, to `/usr/local/sbin/canopy-stages-fence`, and a oneshot unit, `canopy-stages-fence.service`, that runs the copy's `--apply` ordered `Before=docker.service` and is wanted by `multi-user.target` and `docker.service`. It enables the unit and runs it. The unit never runs the checkout's script, which canopy's containers and peer sync can write. The copy, and any copy not named `stages-fence.sh`, ignores the `CANOPY_FENCE_*` switches the tests use. The deploy docs install from a root-owned copy of the script made before it is read.
- Docker's embedded resolver forwards a container's queries from inside the container's namespace, through the fenced bridge, so the host's own upstream (the router, tailscale's 100.100.100.100) would be dropped. The stages service resolves through public servers instead: `dns: [1.1.1.1, 9.9.9.9]`.
- A fence check bundled into the stages image (`/app/fence-check.js`, since that image holds no canopy CLI; `src/stage/fencecheck.ts`), run inside the container, probes canopy's tailnet address on :7850 and the broker on :7855 (`CANOPY_FENCE_TAILNET_IP`), the bridge gateway, and a LAN address (`CANOPY_FENCE_LAN_IP`), and expects each to be blocked. It expects `https://api.anthropic.com` to be open. Each probe has a 4 s timeout. Only the timeout counts as blocked, since the fence drops and never answers. An answer, or a refused or reset connection, means a packet reached a host and counts as open. Any other failure, a lookup or a certificate, is an error, which matches no expectation, so a DNS failure never passes as the internet being open. The same check from canopy's container, which is not fenced, is the control.

## What stays true, and residuals

- Ship stays in canopy, with the Vercel token. It never runs seed code: it clones, pushes and runs `vercel deploy` from a clean clone.
- The env scrub (`stageEnv`) stays as defense in depth for unisolated backends.
- **Residual:** a stage can read its own Claude and Codex OAuth credentials, in the stage config dirs. This is inherent to running the agent.
- **Residual:** a stage can write `_incubator/` itself (a `.git` there, a `.gitattributes`), so the guard never trusts it: seed git calls carry `GIT_CEILING_DIRECTORIES`, canopy runs no git in the seeds dir, and the scan never takes it as a repo.
- **Residual:** a stage can write any seed under `_incubator/`, including other sprouts' seeds. `.shared/` is read-only, but a stage can read every sprout's `.shared/inputs/`.
- **Residual:** what the user starts by hand in a seed (a task, a plain shell and whatever they type there, the guided panel's run button) runs in the shells container with its tokens. That is the user's act. The incubator view says so on a seed's sheet.
- **Residual:** stage egress to the internet is open, so an agent can still send what it can read: the seed, the shared inputs, its own OAuth credentials.
- **Residual:** a stage process that calls `setsid` and then `chdir("/")`, or double-forks out of the tree, escapes the three kill layers at the end of its run: the tree, the process group, and the cwd sweep. The runner, as pid 1's child in its own pid namespace, also kills every orphan there at each run's end and every 30 s (`sweepOrphans`). It spares pid 1, itself, the trees of live connections, and trees whose top has ppid 0 (what `docker exec` starts, the healthcheck among them), and stops each process before it kills it. Such a process now lives until the next sweep, not until the container stops.
- **Residual:** while it lives, such a process can unlink the runner's socket and serve its own. It could then answer `busy: false` while seed processes live, pass the healthcheck, take later runs' spawn requests, and report shell checks as passed. Built-in checks and judge gates run in canopy and are out of its reach. A token is reachable through it: a false `busy: false` lets canopy run git in a seed, the process swaps that seed's `.git/config` between canopy's guard and git's own read, and git then runs the config's commands as canopy, which holds every token. This fix closes most of that. Orphans die at each run's end and every 30 s, and the canopy server runs no git in a seed while any stage is alive: a check or run in any seed, or a stage process until the runner calls its seed quiet, makes every seed busy, and a runner that keeps saying busy keeps them busy. What stays open is a process alive between two sweeps, and the peer gate (`canopy peers gate`), a process of its own that never sees the server's busy rule, so a peer's fetch still runs upload-pack in a seed while a stage is alive. The fix for both is to read seed status and serve seeds through the stage runner, so canopy runs no git in a seed at all. A socket taken over and then swept leaves the real runner unreachable, so stages park until the stages container restarts. Canopy and every stage process share the host uid across both containers, so no file mode or peer credential tells them apart. The socket fix: run the runner as root, have it drop its children to the `bun` user, and put the socket dir at `root:stagecaller 0750` with `group_add` on canopy.
- **Residual:** if the fence unit fails at boot, docker still starts stages unfenced. The unit is not `RequiredBy` docker, because that would take every container down. The deploy docs' after-reboot check is the net.
- **Residual:** the fence script can be swapped between reading it and running `sudo ... --install`, since the checkout is writable by canopy's containers and peer sync. The deploy docs narrow this by copying the script to a root-owned path first, reading that copy, and installing from it.
- **Residual:** a runner that dies during a check reads as a failed check and spends a retry. The check's connection closes with no exit frame, which reads as a kill (137), and only a runner that is away when a check starts makes the check wait for it.
- **Residual:** under mode `off` or `unisolated` no watch runs, so a stage park waits for a resume by hand.
