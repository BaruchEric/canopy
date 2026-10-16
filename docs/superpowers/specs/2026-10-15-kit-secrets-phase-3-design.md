# Kit and secrets, phase 3: stack restarts, gpd's sinks, and the kit's leftovers

Phase 3 of both `2026-10-14-kit-design.md` and `2026-10-14-secrets-design.md`,
after `2026-10-14-kit-secrets-phase-2-design.md`. Those specs hold the design;
this file records what phase 3 builds, what the probes on 2026-10-15 found,
and the calls still open. Where this file and the earlier specs disagree,
this file wins.

Phase 3 comes in two parts. Part A (restarts, gpd's sinks, gpd's servers with
secrets) has its own plan. Part B (per-cell apply, skill adopt, tools) has
`docs/superpowers/plans/2026-10-15-kit-phase-3b.md`; OpenClaw stays out for now.

## Why

Phase 2 left two gaps that a human fills by hand today:

- Rotating a secret rewrites the stack's `.env`, but the stack keeps the old
  value until someone runs `docker compose up -d` on the mini with the right
  project name and files. The proven rotation of `buzz_redis_password` needed
  `docker compose -p buzz-prod -f compose.yml -f compose.mini.yml up -d`, and
  nothing in canopy knows that line.
- gpd has no sinks, so its `github` MCP server reads "phase 3" in the kit and
  stays out of its agents' config.

Success for part A: rotating a stack's secret ends with a restart button that
brings the right compose project up on the new value, and gpd's `github`
server runs from the store's `gh_token` through `canopy-mcp-env`, with no
value in any argv, config file, log line or the transcript.

## What the probes found (2026-10-15)

- **No sink names a stack.** All 14 sinks in the store have no `restart`, so
  rotate lists no stacks today and the copy line in `ui/src/secrets.ts`
  (`restartLine`) never shows.
- **That copy line is wrong anyway.** It prints `cd /opt/stacks/<stack> &&
  docker compose up -d`. For buzz that starts a second project named `buzz`
  next to the running `buzz-prod`. For memory it is right only because the
  langfuse overlay must stay off.
- **Compose projects don't follow one shape.** `docker compose ls --format
  json` on the mini reports each running project with its name and
  `ConfigFiles`: `buzz-prod` from `compose.yml,compose.mini.yml`,
  `collaborative-memory` and `music-assistant` from `compose.yaml`, a second
  project `music-assistant-alexa` from a subfolder, `openclaw-assistant` from
  a `compose.json` under `collaborative-memory/`, and `canopy` from
  `/home/eric/dev/dev-tools/canopy`, outside `/opt/stacks`.
- **The `secrets` container is on `canopy_default`** (192.168.48.2,
  subnet 192.168.48.0/20, gateway 192.168.48.1), the same network the
  `mini-host` key's `from=` already allows. No `canopy-restart` key exists yet.
- **OpenClaw does not load a folder dropped into its managed skills dir.**
  `openclaw skills list --json` (2026.9.2) names `managedSkillsDir:
  /home/node/.openclaw/skills` and `workspaceDir:
  /home/node/.openclaw/workspace`. A valid `SKILL.md` placed at
  `managedSkillsDir/canopy-kit-probe/` read "not found" from both `skills
  info` and `skills list`. The probe was removed. The 53 skills it lists are
  51 `openclaw-bundled` and 2 `openclaw-extra` (from `plugin-skills/`).
  The kit spec's copy mode into that folder would place files OpenClaw
  ignores.
- **`kit.json` has no `tools` block.**

## Part A1: stack restarts

**Which stack a sink restarts.** A sink's `restart` field names a compose
project, not a folder. When a mini sink has no `restart` and its path is
`/opt/stacks/<dir>/<file>`, canopy derives the project from the running
projects: the one whose first config file sits directly in
`/opt/stacks/<dir>/`. Exactly one match is the default; none or several reads
"no stack" and asks for the field to be set. `restart: "none"` turns the
default off for a sink whose stack must not restart on a write. The sink
sheet shows the derived project next to the field.

**The restart key.** A new key pair in `~/.config/canopy-restart/` on the
mini, made once by `scripts/restart-setup.sh`. Its `authorized_keys` line
forces the script in the checkout:

```
restrict,command="<checkout>/scripts/canopy-restart",from="192.168.48.0/20" ssh-ed25519 … canopy-restart
```

The `secrets` service mounts the private key read-only, plus a pinned
`known_hosts` for `192.168.48.1`, since its root filesystem is read-only and
ssh cannot record the host key. The stack name travels in
`SSH_ORIGINAL_COMMAND`, never as a shell word.

**`canopy-restart`** (POSIX sh plus `jq`, at `scripts/canopy-restart`, run
in place from the checkout; as built, `list` prints each project under
`/opt/stacks` with its files for the copy line and the derived default):

1. Takes `restart <project>` from `SSH_ORIGINAL_COMMAND`; the name must match `^[a-z0-9][a-z0-9_-]{0,63}$`.
2. Reads `docker compose ls -a --format json` and finds the project of that
   name. It refuses a project whose config files are not all under
   `/opt/stacks/`, so `canopy` itself (restarted by `bun run redeploy`) and
   anything in a home folder are out.
3. Runs `docker compose -p <name> -f <file> [-f <file>…] up -d` with exactly
   the files the project was started with, so an overlay that was off stays
   off.
4. Waits up to 60 s for containers to leave `starting`, then prints one
   line per container from `docker compose -p <name> ps
   --format '{{.Service}}\t{{.State}}\t{{.Health}}'` and exits with
   compose's code. Never `--format json`: its `Command` and `Labels` fields
   carry interpolated values, and buzz's redis runs with `--requirepass
   <value>` in its command. `up -d`'s own output goes to `/dev/null`.

**The button.** Rotate's reach list (phase 2) gains a "restart" button per
stack, gated and behind a confirm, sent as a `stack-restart {project}` act to
the secrets service. The button is enabled only once every sink that names
the project reads `same` for the rotated secret, so a restart never picks up
the old value. The service runs the ssh call, logs the act in the audit log
(project, passkey, exit code; never output that could hold a value), and
returns each container's state from the `ps` output. The view shows those as
running, healthy or exited. As built, the script itself waits out
`starting`, so there is no `ps`-only form of the act.

**The copy line** becomes the same `docker compose -p … -f … up -d` the script
would run, built from the project's config files, for when the button is
refused or the key is not installed.

## Part A2: gpd's sinks

gpd has no canopy backend and no key, and the Mac's canopy owns its sinks, as
the secrets spec says. The value is already sealed to the Mac for any gpd
sink (`recipientsFor`), so no recipient changes.

- **A `SinkIO` over ssh** (`src/core/sinkssh.ts`), plugged into the existing
  `syncSink`. `read` runs a fixed sh script on gpd through `onHost("gpd", …)`
  that prints the file as base64 on one line, or a "missing" line. `write`
  sends the new text as base64 on stdin to a second fixed script, which
  writes a temp file in the same folder with mode 0600, then renames it over
  the target. No value appears in argv, and the sink writer's merge (keep
  every key the sink does not name) runs on the Mac, unchanged.
- **The repo check** runs on gpd in the same read script: when the path is
  inside a git work tree, `git check-ignore` must ignore it, or the write is
  refused, as on the Mac.
- **Paths and home.** A gpd sink's path is absolute
  (`/home/eric/.claude/mcp-env/github.env`). `mcp-allow` takes gpd's home
  from the kit scan's `home` for gpd, since there is no backend to ask.
- **Away.** Tailscale SSH's browser check, gpd booted into Windows, or no
  answer within the kit's fetch timeout makes every gpd sink read "away" with
  the reason, kept until the next pass. The 5-minute pass is the only retry.
  As built, "away" is the sink's error text (`gpd is away: <reason>`), not a
  key state, and the next pull passes again even on an unchanged head.
- **Locked.** While the Mac is locked, gpd's sinks read "waiting", like the
  Mac's own.
- **Prune.** The mcp-env prune runs over the same ssh path for gpd's folder.
- **Drift** compares in the unlocked Mac canopy's memory, as for its own
  sinks.

The "phase 3" key state on gpd sinks (`secretlocal.ts`) goes away.

## Part A3: gpd's MCP servers with secrets

With A2 in place, the kit plans gpd's servers with secrets like the Mac's:
allowed for the current hash, and every env sink `same` on gpd. The
`phase-3` cell state is removed. `mcp-allow` for `github` gains gpd in its
machines when Eric allows it again from the sheet (the hash is unchanged, so
this only adds gpd's sink).

## Part B: the kit's leftovers

The calls below settle how each one works; part B's plan comes after part A.

**Per-cell apply.** Phase 1's "apply all here" applies a machine's whole plan.
A cell's own button would apply that cell's actions only, through
`POST /api/kit/apply {machine, actions}`. Nothing open beyond the layout.

**Skill adopt.** A foreign skill folder in a `link` target (Codex, Hermes)
with the same name as a store skill reads "foreign, kit has one". Adopt would
move the folder out of the agent's skills dir to
`~/.canopy-kit-adopted/<agent>/<name>`, record it in the ownership file, and
place the link. Put back would reverse it. An untracked skill in Claude's
store ("local") can only join the kit through a dotclaude commit, which stays
Eric's.

**Tools.** The kit spec's `tools` block (`check`, `install` per OS). Canopy
runs `check` on each machine and shows the result. An `install` line that
needs no sudo runs from an "install" button; a sudo line (`sudo pacman`
cannot prompt over a non-interactive ssh) is a copy line.

**OpenClaw (not planned).** The probe above shows copy mode into
`managedSkillsDir` does nothing. The candidates are `openclaw skills install <local dir>`, which may
register a skill properly but has no uninstall command, and the workspace's
`skills/` folder, which is untested. One more probe on a scratch skill, run
in the workspace folder first, would decide which, once Eric decides canopy should manage OpenClaw at all.
Until then it stays out of `targets`.

## Calls made on 2026-10-15

1. **Restarts derive the project by default.** A sink with no `restart`
   restarts the running project found from its folder, as above. `restart`
   overrides it and `"none"` turns it off.
2. **Install the `canopy-restart` key.** Yes.
3. **Tools install runs.** Canopy runs a tool's `install` when the line needs
   no sudo, and shows a sudo line as a copy line, since a non-interactive ssh
   cannot answer the password prompt.
4. **OpenClaw stays out** until someone knows whether canopy should manage
   its skills. It is not in `targets` and part B does not plan it.

## Components (part A)

- `scripts/canopy-restart`, `scripts/restart-setup.sh`, and the folder's 0700 step in `scripts/redeploy.sh`.
- `docker-compose.yml`: the `secrets` service mounts the restart key and its
  `known_hosts` read-only.
- `src/core/secretfile.ts`: `restart: "none"`, and `impactOf` returns stacks
  as projects with their derived or set source.
- `src/secrets/service.ts`: the `stack-restart` act, gated, audited.
- `src/core/sinkssh.ts` (new): the ssh `SinkIO` and its two scripts.
- `src/core/secretlocal.ts`: gpd's sinks through the ssh IO, "away" state,
  gpd's prune.
- `src/core/kit.ts`: drop `phase-3`, plan gpd servers with secrets.
- UI: the restart button and container states in `Secrets.tsx`; the new
  `restartLine` in `ui/src/secrets.ts`; gpd's column in `Kit.tsx`.
- `docs/deploy.md`: the restart key under "Host control".

## Errors

- The project is not running and has no match: the button reads "no stack"
  and the copy line falls back to the folder's single compose file, if it
  has exactly one.
- The script refuses (name, path outside `/opt/stacks`): the act fails with
  the script's one-line reason.
- `up -d` fails: the exit code and each container's state, no compose
  output (it can echo interpolated values).
- gpd away: sinks read "away" with the ssh reason; nothing written, nothing
  pruned.

## Testing

- `canopy-restart` under a fake `docker` on PATH: a bad name, a project
  outside `/opt/stacks`, `canopy`, a two-file project kept as two files.
- The derived project: one match, none, two (music-assistant and its alexa
  subfolder resolve to `music-assistant` only, since alexa's file is in a
  subfolder), `none`.
- `stack-restart` is refused without a session (the request table test) and
  until every sink reads `same`.
- The ssh `SinkIO` against a fake `onHost` that records argv and stdin: the
  value is never in argv, the write script renames, a missing file, an
  unignored path in a repo, away.
- The leak test covers the restart act's audit entry, the ssh argv, and the
  script's stdout under a fake `docker` whose `ps` and `up` echo a fixture
  secret in a command line.
- A live check: rotate `buzz_redis_password`, restart `buzz-prod` from the
  button, both containers healthy; allow `github` on gpd, a fresh Claude
  session on gpd lists the server, and the token is absent from gpd's
  `~/.claude.json`.
