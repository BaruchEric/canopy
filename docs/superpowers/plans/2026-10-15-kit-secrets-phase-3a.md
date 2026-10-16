# Kit and secrets phase 3, part A: stack restarts and gpd's sinks

**Status:** built 2026-10-15, not yet committed or deployed. The live steps (run `scripts/restart-setup.sh` on the mini, redeploy, allow gpd's servers with secrets) wait for the commit.

**Goal:** rotating a stack's secret ends with a restart button that brings the
right compose project up on the new value, and gpd's servers with secrets get
their values from the store through `canopy-mcp-env`, written by the Mac's
canopy over ssh.

**Spec:** `docs/superpowers/specs/2026-10-15-kit-secrets-phase-3-design.md`,
part A and the calls of 2026-10-15.

## Tasks

### 1. The project a sink restarts
- [x] `stackFor(sink, machine, projects)` in `src/core/secretfile.ts`: a set
  `restart` wins, `"none"` is none, otherwise the one running project whose
  first config file sits directly in `/opt/stacks/<dir>/` for a mini sink at
  `/opt/stacks/<dir>/…`.
- [x] `impactOf` and `metaList` take an optional resolver, so the writer's
  stacks are projects and a reader keeps the set field alone.
- [x] `SecretSinkInfo` gains `restart` and `stack`; `SecretsInfo` gains
  `stacks` (each project with its config files) and `stacksError`.
- [x] `sink-set` carries `restart`; the sink editor shows the field and the
  derived project.

### 2. The forced command
- [x] `scripts/canopy-restart` (sh + jq): `list` prints each project under
  `/opt/stacks` with its config files; `restart <project>` refuses a bad name
  and a project with a file outside `/opt/stacks`, runs `up -d` with the
  project's own files and its output thrown away, waits up to 60 s for
  containers to leave `starting`, and prints service, state and health per
  container.
- [x] Tests under a fake `docker` on PATH, including a `ps` that would echo a
  secret in a command line.
- [x] `scripts/restart-setup.sh`: the key in `~/.config/canopy-restart/`, the
  `restrict,command=…,from="192.168.48.0/20"` line, and a `known_hosts`
  pinning `192.168.48.1`.

### 3. The service side
- [x] `src/secrets/stacks.ts`: `list` and `restart` over ssh with the key,
  output parsed, nothing else kept.
- [x] `stack-restart {project}` act: gated, audited with the exit code,
  refused for an unknown project and while any of its sinks has a key
  `waiting` or an error. The project list refreshes at start, every 5 minutes
  and after a restart.
- [x] `main.ts` builds the runner when `/restart/key` exists; `docker-compose.yml`
  mounts `${HOST_HOME}/.config/canopy-restart` read-only at `/restart`, and
  redeploy makes that folder first.

### 4. gpd's sinks
- [x] `src/core/sinkssh.ts`: probe (with gpd's `$HOME`), read, write (value
  as base64 on stdin, temp file and rename, 0600), the repo refusal, and the
  mcp-env prune, all over `onHost`.
- [x] `SecretsReader` writes the sinks of the ssh machines it reaches (kit
  machines with `via` this backend): waiting while locked, "away" with the
  reason, a retry on the next pull while one was away.
- [x] The writer and the reader stop reporting `phase 3`; `mcp-allow` takes
  gpd.

### 5. The kit
- [x] `serverReady` plans an ssh machine's servers with secrets like any
  other; the `phase-3` state and `KitMcpView.later` go.

### 6. The page
- [x] The reach list's stack row: the copy line from the project's files, and
  a restart button on the gate page with a session, disabled while a sink of
  that project waits; after it, each container's state.

### 7. Docs and checks
- [x] `docs/architecture.md` (the secret store), `docs/deploy.md` (host
  control: the restart key), and the spec where the build settled a detail.
- [x] typecheck, lint, tests, build.
