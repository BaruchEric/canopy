# Providers and default loadouts from kit.json (FR-069)

Eric's words, 2026-11-20: "add providers specific setting, skills, tools etc
centralized distributed down to servers, repos, cards etc".

## What exists

Skills, MCP servers and command-line tools are already central. kit.json in
dotclaude defines them once, and the kit places them on every machine. A
loadout (FR-065) bundles harness, model, effort, skills and servers, and a
run or a coordinator's card can name one.

Three things are not central:

1. **Providers.** A Claude provider is a settings file each backend keeps by
   hand at `~/.config/canopy/providers/<id>.json`. The Mac has `local`; the
   mini has none. Nothing says which provider exists where.
2. **A loadout cannot name a provider.** A card cannot put its worker on a
   gateway; a loadout keeps the route's provider or drops it.
3. **No default reaches a repo or a server.** A loadout applies only when a
   start names it. Routing (profiles, roles, repo overrides) is per backend
   and keyed by absolute path, which differs between the Mac and the mini.

## Design

kit.json gains two blocks, and a loadout gains one field.

```json
"providers": {
  "local": { "note": "llama-server on the Mac", "machines": ["mac"] },
  "gateway": {
    "note": "LiteLLM on the mini",
    "settings": { "env": { "ANTHROPIC_BASE_URL": "http://macmini-2018:4000", "ANTHROPIC_AUTH_TOKEN": "${env:GATEWAY_TOKEN}" } }
  },
  "openrouter": { "harness": "codex", "machines": ["mac"] }
},
"defaults": {
  "loadout": "quick",
  "machines": { "mini": "feature" },
  "repos": { "web-apps/clms": "frontend", "dev-tools/*": "feature" }
},
"loadouts": { "offline": { "harness": "claude", "provider": "local", "skills": [] } }
```

### Providers

- `harness` is `claude` (the default) or `codex`. `machines` lists kit
  machines; absent means every backend, including one kit.json does not name.
- A Claude provider with `settings` is written by each backend it is for, as
  `providers/<id>.json` (0600, through a rename), so every place that already
  passes `--settings` (shells, resumes, runs, the ranger, herdr, the commit
  suggestion) reads it unchanged.
- A string value in `settings` may hold `${env:NAME}`, read from the
  backend's own environment when it writes the file. kit.json never holds a
  token. `${secret:…}` is refused for now: the secret store has no provider
  sink yet.
- A backend in a container refuses a provider with `${env:…}`. Its config
  volume is mounted by the shells container, so the value would sit where any
  shell reads it, which is what the 2026-11-09 move of `.env` closed.
- A provider with no `settings` is declared only: each machine keeps its own
  hand-written file. That is how `local` stays, since its token is real.
- `providers/.canopy-kit.json` records what the kit wrote and the hash of each
  file. A file the kit did not write is the machine's own (`hand`) and is never
  overwritten. Adopt moves it to `providers/.canopy-kit-adopted/<id>.json` and
  writes the kit's; put back reverses that. A file the kit wrote and someone
  edited reads `drift` and is left alone. A provider leaving kit.json, or this
  machine, has its kit-written file removed.
- A Codex provider is declared only: the id names a `model_providers` entry in
  codex's own config.toml, which canopy does not write.

States per backend: `ok`, `hand`, `drift`, `missing` (declared, no file),
`unresolved` (an env name not set), `refused` (env on a container backend),
`declared` (codex), `off` (not for this machine).

### A loadout's provider

`loadouts.<name>.provider` names a kit provider of the loadout's harness.
A start resolves it before the route's: the run gets `provider` in its agent
settings, `RunEquip.provider` records it, and a restart, fix, fork or swept
chat keeps it. A backend the provider is not for refuses the start; it never
falls back to the login. A card's equip may override it (Eric only, like the
other fields), with another provider of the loadout's harness or `default`
for the harness's own login.

### Defaults

`defaults.loadout`, `defaults.machines.<machine>` and
`defaults.repos.<path>` each name a loadout. The path is the repo's path
under the backend's scan root, so `dev-tools/canopy` matches on the Mac and
the mini. A key with `*` matches by glob; an exact key beats a glob, and a
longer glob beats a shorter one.

A start with no loadout of its own takes the first of: repo, machine,
default. A start that names one keeps it. `none` (reserved; no loadout may
take the name) says "no loadout" outright and stops the inheritance.

Defaults apply to plain runs and chats (on a branch or not), a card's run,
tree run and workflow, and a child run. They do not apply to a best-of-N
group (each member's profile is the point), a workspace run, a repo on
another host or the forge, an incubator seed, shells, or the coordinator.
A default whose harness the start cannot run (a Codex loadout for plan, then
build, or for a card's flow) is passed over and named, as routing's
`skipped` is, rather than refusing the start. So is a default naming a
loadout kit.json does not hold.

`RunEquip.from` says where an inherited loadout came from (`repo`,
`machine`, `default`, with the key that matched), so the run sheet can say
"feature, from dev-tools/*".

## Surfaces

- `GET /api/loadouts` adds `defaults`, `providers` (this backend's states,
  env names and settings keys only, never values) and `machine`.
- `GET /api/loadouts/resolve?id=<repo>&action=` answers the loadout a start
  there would take and why.
- `POST /api/kit/providers/adopt` and `/restore` `{id}` (admin).
- CLI: `canopy loadouts` lists providers and defaults too;
  `canopy loadouts resolve <repo> [--action ACTION]`;
  `canopy loadouts adopt|restore <id>`; `canopy run --loadout none`.
- Kit view: a providers table (one cell per backend) and the defaults.
- The plan sheet's loadout pick shows the inherited one and offers `none`.
- The equip sheet opens a bare card on what it inherits, takes a provider
  (or the login) and offers `none`; the card form's loadout select offers the
  default and `none`.
- The run sheet and run chip name the provider and where the loadout came
  from.

## Not in this version

- Editing loadouts, defaults or providers from the page. kit.json is edited
  in dotclaude on the machine that commits it.
- Shells: an interactive agent still starts with every skill and the user's
  MCP servers.
- Writing Codex `model_providers` tables.
- Provider secrets through the secret store.

## Deploy order

An older parser drops a loadout with a field it does not know. So canopy
ships to every backend first (`bun run redeploy all`, the Mac's own build),
and only then does kit.json gain `provider` on a loadout. A top-level
`providers` or `defaults` block is ignored by an older backend.
