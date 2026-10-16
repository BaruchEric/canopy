# The kit: one set of skills, MCP servers and tools for every agent

Date: 2026-10-14. Status: design, approved in conversation, awaiting review of
this file. Touches canopy and dotclaude (`~/.claude`, `eric-M3Max/dotclaude`).
Its MCP secrets come from the secret store, which has its own spec
(`2026-10-14-secrets-design.md`).

## What the user asked for

"Centralize skills, tools etc for all agents, servers etc", then, in answer to
questions:

- Canopy owns it: a feature with a UI, not a script beside it.
- The mini's `~/.claude` becomes a dotclaude checkout, its credentials,
  sessions and settings left as they are.
- Every agent that can load skills gets the shared set, wherever it runs:
  Claude Code, Codex, and the other agents on the mini.

## What exists today (2026-10-14)

| Machine | Claude skills | Codex skills | Other |
|---|---|---|---|
| Mac | 68 in dotclaude, plus `craft`, `ripe`, `hyperframes` as untracked links to Mac paths | `budget-workflow`, `capture-workflow`, `qnap-nas-control` (real dirs) | 16 user MCP servers in `~/.claude.json`, 4 in `~/.codex/config.toml` |
| mini | 3 links (`diagnose-crash`, `omarchy` into `/usr/share/omarchy`, `tailchan` into `~/dev/homelab`) | the two Omarchy links | Hermes at `~/.hermes/skills` (the Omarchy two); OpenClaw in a container mounting `/opt/stacks/openclaw/data/config` as `~/.openclaw` |
| gpd | dotclaude checkout, 5 commits behind, plus Omarchy's `diagnose-crash` | the two Omarchy links | |

The canopy containers on the mini (`canopy`, `shells`) bind-mount the host's
`~/.claude`, `~/.claude.json` and `~/.codex` under `/home/bun`, and `DEV_ROOT`
at its host path. Codex already loads a symlinked skill (the Omarchy ones).

## Decisions

- **dotclaude stays the store.** `~/.claude/skills` is where Claude Code reads
  skills natively, gpd already pulls it, and the mini will. Canopy does not hold
  a second copy; it reads the checkout on each machine and projects from it.
- **Canopy is the control plane.** It reads a manifest, looks at each machine,
  works out what differs, shows it, and fixes it on request.
- **The manifest is `~/.claude/kit.json`**, tracked in dotclaude.
- **Canopy only touches what it placed.** Each target keeps a list of the names
  canopy put there. Anything else (Omarchy's skills, a skill made by hand) is
  "foreign": shown, never removed or overwritten.
- **No secret values in the manifest.** An MCP server's env names secrets by
  reference; values are resolved on the target machine at apply time.

## The manifest

```jsonc
{
  "version": 1,
  "machines": {
    "mac":  { "backend": "mac" },
    "mini": { "backend": "mini" },
    "gpd":  { "ssh": "gpd", "via": "mac", "dev": "/home/eric/dev" }
  },
  "targets": [
    { "agent": "claude", "skills": "~/.claude/skills", "mode": "store",
      "mcp": { "file": "~/.claude.json", "format": "claude-json" } },
    { "agent": "codex",  "skills": "~/.codex/skills",  "mode": "link",
      "mcp": { "file": "~/.codex/config.toml", "format": "codex-toml" } },
    { "agent": "hermes", "skills": "~/.hermes/skills", "mode": "link",
      "machines": ["mini"] },
    { "agent": "openclaw", "skills": "/opt/stacks/openclaw/data/config/skills",
      "mode": "copy", "machines": ["mini"] }
  ],
  "skills": {
    "default": { "agents": ["*"], "machines": ["*"] },
    "only": {
      "desk":    { "agents": ["claude"] },
      "craft":   { "source": "dev:dev-tools/craft/skill" }
    },
    "exclude": ["*-workspace", "synced"]
  },
  "mcp": {
    "wiki-memory": {
      "command": "bash", "args": ["~/dev/homelab/services/memory/wiki-mcp.sh"],
      "agents": ["claude", "codex"]
    },
    "executor": {
      "url": "https://macmini-2018.tail2d2c60.ts.net:8443/mcp",
      "agents": ["claude", "codex"]
    },
    "github": {
      "command": "bunx", "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": { "GITHUB_PERSONAL_ACCESS_TOKEN": "${secret:github-token}" },
      "agents": ["claude", "codex"]
    },
    "photocraft": {
      "command": "~/.local/share/artcraft/photocraft/photocraft-cli", "args": ["mcp"],
      "agents": ["claude"], "machines": ["mac"]
    }
  },
  "tools": {
    "sops": { "check": "sops --version",
              "install": { "darwin": "brew install sops", "arch": "sudo pacman -S --noconfirm sops" } }
  }
}
```

- A skill is every folder under `skills/` that git tracks in the store and
  `exclude` does not match. An untracked entry in a machine's store (the
  mini's Omarchy links, the Mac's `craft` link today) reads "local": shown,
  never managed. `default` says who gets it; `only` overrides one skill.
  `source` names a skill that lives outside the store, as `dev:<path>` under
  the machine's dev root (the backend's scan root, or `dev` for an ssh
  machine), which is the same path on the mini's host and in its containers.
  The kit links it into the store as an absolute link. Where the source is
  missing, the cell reads "no source here" rather than an error.
- Scans skip dot entries in every skills dir (Codex's `.system`), and
  Claude's `synced` org mirror is excluded by name.
- `machines` maps a manifest name to the canopy backend that owns it, or to an
  ssh host for a machine no backend runs on (gpd). `via` names the backend
  that reaches it, and `dev` its dev root.
- `mode`: `store` is the store itself (nothing to place), `link` places a
  relative symlink (`../../.claude/skills/<name>`), `copy` places a copy with a
  content hash, for an agent in a container that cannot follow a link out of
  its mount.
- A `~` in a server's `command` or `args` resolves to that machine's home when
  the file is written. Today's `github` entry runs `gh auth token` inside a
  `bash -c` line; under the kit it takes the token from the secret store
  instead.
- `${secret:NAME}` resolves through the secret store; `${env:NAME}` through the
  environment of the canopy process on that machine. An unresolved reference
  leaves that server out of the file and marks it "unresolved" in the view.
- A reference alone grants nothing. `kit.json` sits in a repo any agent can
  edit, so an agent could add a server whose command prints its env. The store
  resolves `${secret:NAME}` for an MCP server only when that secret's own
  signed allowlist names the server (`mcp:<name>#<hash>`), and the allowlist
  is edited only behind the store's human gate. A reference the allowlist does not cover reads
  "not allowed" in the view, and the server stays out of the file.
- A server with secrets is written as a launch through
  `~/.claude/bin/canopy-mcp-env`, which loads a 0600 env file the secret
  store writes; no agent config file holds a value (the secrets spec has the
  details).
- A server's `command` or `args` changing after its secrets were allowed
  voids the allowance until a human confirms it again (the store keeps a hash
  of the server's definition with each allowance).

Relative links matter: from `~/.codex/skills/x` the link `../../.claude/skills/x`
resolves on the host and inside the containers, where both folders sit under
`/home/bun`.

## Ownership

Each skills target holds `.canopy-kit.json`: `{ "placed": { "<name>": "<hash
or link>" } }`. The MCP targets record their managed names in the same file
next to the skills dir (Claude: `~/.claude/.canopy-kit-mcp.json`; Codex: a
`# canopy-kit: managed` comment above each managed `[mcp_servers.<name>]`
table). Apply only adds, updates or removes names in that list. A name that
exists but is not in the list is foreign; apply never touches it, and the view
offers "adopt" (add it to the list, replacing it with the store's version)
only as an explicit action, in phase 3. Until then a foreign entry is shown and left alone.

## Components

`src/core/kit.ts` (browser-safe, pure, tested): `parseKit` (manifest with
errors per field), `wantFor(kit, machine)` (desired skills, servers and tools
per target), `planKit(want, seen)` (a list of `KitAction`: `link`, `copy`,
`update`, `remove`, `mcp-set`, `mcp-remove`, `tool-missing`, `pull`), and
`cellsOf` (the matrix the UI paints: a row per skill, server or tool, a column
per machine and agent, a cell `ok | missing | drift | foreign | unresolved |
no-source | away`).

`src/core/kitscan.ts`: `seeKit(machine)` reads a machine's state through
`onHost` (so an ssh machine is read the same way): the store's skill folders
with a tree hash, each target's entries (link target, or hash), the ownership
files, the MCP entries of each file, `tools` check exits, and the store
checkout's branch, dirty flag and ahead/behind.

`src/core/kitapply.ts`: carries out a plan on one machine. Writes are atomic
(temp then rename). `~/.claude.json` and `config.toml` are parsed, the managed
keys changed, and written back with everything else as it was; a parse failure
refuses the write. `pull` runs `git pull --ff-only` in the store. A dirty tree
is normal (the Mac's dotclaude has local edits most days), and git itself
refuses only when an incoming commit touches a locally changed path; the view
then names the paths. A diverged branch refuses and says so. Nothing stashes,
resets or commits in the store.

`src/server/kit.ts`: `GET /api/kit` (manifest, cells, plan per machine this
backend owns), `POST /api/kit/apply` (`{machine, actions?}`; all of the plan
when no actions), `POST /api/kit/adopt` (phase 3), and a `kit` SSE event after each scan.
On the mini canopy runs in a container, so the host paths the kit writes that
the `canopy` service does not already mount (`~/.hermes`, and
`/opt/stacks/openclaw/data/config` for phase 3) get bind mounts on that
service alone: `~/.hermes` under `/home/bun` like `~/.claude`, so `~` and the
relative links mean the same inside and out, and `/opt/stacks` at its host
path (the secret store's sinks need it too). A backend scans its own machine at start, after each apply, on the view's
rescan button (`POST /api/kit/scan`) and every 10 minutes; the backend an ssh
machine names in `via` scans that machine on the same clock.

UI: a `kit` view (`components/Kit.tsx`, pure helpers in `ui/src/kit.ts`). The
page merges each backend's cells like the incubator merges sprouts. The matrix
has filters (agent, machine, only problems), a cell's popover says what it is
and offers its one action, and a column header offers "apply all here". The
store's own state (behind, dirty) sits above each machine's column.

CLI: `canopy kit status [--machine m]`, `canopy kit apply [--machine m]
[--dry-run]`.

## The one-time setup (done by hand in phase 1, recorded in `docs/deploy.md`)

1. The mini's `~/.claude` becomes a checkout. Back up the folder first, then
   `git init`, add `origin`, fetch, and turn on a non-cone sparse checkout
   that leaves out `/settings.json` and `/settings.local.json` before the
   first checkout. Git then never writes either file there, whatever upstream
   does, so the mini keeps its own settings and a pull never stops on them.
   Untracked files (`.credentials.json`, sessions, projects, the three skill
   links) stay as they are; the Omarchy links stay Omarchy's (the mini's sparse
   checkout leaves dotclaude's `skills/omarchy` out). The global `CLAUDE.md` does land on the mini, which has none today;
   phase 1 adds a short mini section to it next to the notebook's, so agents
   there are not told Mac-only rules.
   The `stages` service does not mount the host's `~/.claude` (only `canopy`
   and `shells` do), so fenced stage agents see none of this.
2. gpd's checkout pulls the 5 commits it is behind.
3. Codex's three Mac-only skills move into the store (Codex-only via `only`).

## Phases

1. Manifest, scan, the read-only matrix (view and CLI), skill projection for
   Claude, Codex and Hermes, the mini conversion and the gpd pull.
2. MCP projection, using the secret store for references, and MCP adopt.
   `2026-10-14-kit-secrets-phase-2-design.md` settles the details and wins
   where it differs from this file (Claude's servers go through `claude mcp`,
   Codex's file is written in place).
3. Tools, OpenClaw copies, adopt, and the per-cell apply buttons in the UI (phase 1's apply is
   the CLI's). OpenClaw is unverified: `openclaw.json` has a `skills` block
   with no load paths, and `/opt/stacks/openclaw/data/config/skills` (the
   container's `~/.openclaw/skills`) does not exist yet. Phase 3 starts by
   confirming OpenClaw loads skills from that folder before copying anything.
   `2026-10-15-kit-secrets-phase-3-design.md` records that probe (OpenClaw
   2026.9.2 ignores a folder placed there) and the calls still open.
   Part B (per-cell apply, skill adopt, tools) is built by
   `docs/superpowers/plans/2026-10-15-kit-phase-3b.md`. Skill adopt moves a
   hand-made entry to `.canopy-kit-adopted/<name>` beside the agent's
   skills dir, not under `~`, and records it in that dir's
   `.canopy-kit.json`; that plan says why.

## Out of scope

- Incubator stages. The stage runner refuses a stage claude settings or codex
  config holding a key off its allowlist, and stages read user settings only;
  the kit does not write either.
- Claude plugins: listed in the view (from `settings.json`), not managed.
- Agents inside other containers than OpenClaw's, until one is named.

## Errors

- ssh needs a browser check (Tailscale SSH on gpd): the column reads "away"
  with the reason; nothing retries faster than the 10-minute clock.
- A target dir that does not exist is made only when its agent's own folder
  exists (`~/.hermes` for Hermes); otherwise the column reads "agent not
  installed".
- A link that resolves outside the store, or a copy whose hash differs from
  what the ownership file recorded, is drift (someone edited it in place); the
  view shows it and apply asks before overwriting.

## Testing

- `kit.test.ts`: manifest parsing, `wantFor` over machines and agents, `planKit`
  against fixtures (foreign entries untouched, drift, unresolved secrets).
- `kitscan.test.ts` and `kitapply.test.ts` over a scratch home: links resolve
  relatively, copies hash, `~/.claude.json` and `config.toml` keep unmanaged
  keys byte for byte, a parse failure refuses.
- `server/kit.test.ts`: the routes and the event with a stand-in scan.
- `ui/src/kit.test.ts`: cells and filters.
