# canopy's copy of Floorplan

This folder is [Floorplan](https://github.com/haydenschmitty/floorplan) by Hayden Smith, MIT (see `LICENSE`), at **0.11.0**, commit `94f81b463b7617e06d873ac71323ce71644c8399` (2026-11-16). canopy uses it for the repo panel's map section and `canopy floorplan` (FR-070). `docs/architecture.md`, "The map (Floorplan)", says how the pieces fit.

A map run loads this folder with `claude --plugin-dir lib/floorplan`, so the skill is `floorplan:floorplan` and `${CLAUDE_SKILL_DIR}` is `lib/floorplan/skills/floorplan`. canopy's server runs `status.mjs` and `open.mjs` from here too.

## What is here

Only what the skill needs to run, kept as upstream lays it out:

- `.claude-plugin/plugin.json`
- `skills/floorplan/`, all of it: `SKILL.md`, `workflow.json`, `scripts/`, `assets/`, `references/`, `agents/openai.yaml`
- `LICENSE`

Left out: `docs/`, `tests/`, `tools/`, `.github/`, `.codex-plugin/`, `.agents/`, the README, changelog, contributing and security files, `package.json` and `CHECKSUMS.txt`. The checksums would no longer match after the patches below.

## What canopy changed

Two edits, both in `skills/floorplan/assets/serve.mjs`. Each one carries a comment that names this file.

1. `WAITLIST_URL` is the empty string, so the map's cloud waitlist is off. Upstream posts an email address to a Cloud Run service when someone joins the waitlist from the map. Here the map never asks, and nothing is sent.
2. `/api/cloud/claude-email` answers `{ email: null }`. Upstream reads the signed-in Claude account's email with `claude auth status` to pre-fill that waitlist form. canopy frames the map on its public names, so the account's address never reaches the page.

The build copies `serve.mjs` and `page-safety.mjs` into each repo's `floorplan/`. canopy starts a map's server only while those two files match this folder byte for byte (`src/server/floorplan.ts`). That way a clone's own committed `floorplan/` never runs here.

## Moving to a new release

1. Clone upstream at the new tag, then read its CHANGELOG and the diff of `skills/floorplan/` since the commit above.
2. Replace `.claude-plugin/plugin.json`, `skills/floorplan/` and `LICENSE` with the new ones.
3. Apply both edits to `serve.mjs` again. Then search the new `scripts/` and `assets/` for any other place that sends data off the machine, and turn it off the same way.
4. Update the version and commit at the top of this file, and `FLOORPLAN_VERSION` in `src/core/floorplan.ts`.
5. Check SKILL.md's steps against `floorplanTask` in `src/core/floorplan.ts`. That task tells the run to skip `open.mjs`, never to add the CLAUDE.local.md note, and to write only inside `floorplan/`. Check the scripts a run may start (`FLOORPLAN_SCRIPTS`) against the skill's `allowed-tools`.
6. Run `bun test src/server/floorplan.test.ts`. It builds a map from scratch with these scripts and starts, finds and stops its server.

Every map that was built with the old release keeps the old `serve.mjs`. canopy then refuses to start that map's server until the map is updated, because the update writes the new copy.
