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

canopy's health check `floorplan` (`.canopy/health.json`) runs `bun scripts/floorplan-update.ts --check` every six hours. That asks upstream for its tags without cloning, and the check goes down with the new version's number when a newer release is out.

Run `bun run floorplan:update`. canopy's panel lists it as the task `floorplan-update`. It does the mechanical part:

1. It clones upstream and takes its newest release tag (`floorplan--vX.Y.Z`), or what `--ref` names: a tag, a branch or a commit.
2. It goes through `.claude-plugin/plugin.json`, `skills/floorplan/` and `LICENSE` one file at a time. A file canopy never changed becomes upstream's new one, and a file upstream added or removed is added or removed. A file canopy edited, `serve.mjs` today, gets a three-way merge (`git merge-file`) with the pinned commit as the base, so both edits above carry over to the new release on their own. When upstream changed the same lines, the file keeps conflict markers and the run exits 1.
3. It moves the pin at the top of this file and `FLOORPLAN_VERSION` in `src/core/floorplan.ts`, which a test holds equal to `plugin.json`.
4. It prints the web addresses the release adds to these files and the headlines of upstream's changelog since the pin.
5. It runs canopy's Floorplan tests, including `src/server/floorplan.test.ts`, which builds a map from scratch with the new scripts and starts, finds and stops its server.

It commits nothing, and it refuses to start while this folder or `src/core/floorplan.ts` hold uncommitted changes, so `git checkout -- lib/floorplan src/core/floorplan.ts` drops a run. What is left for a person:

- Read the diff. Turn off any new address that sends data off the machine, the way the two edits above do, and name it here.
- Check SKILL.md's steps against `floorplanTask` in `src/core/floorplan.ts`. That task tells the run to skip `open.mjs`, never to add the CLAUDE.local.md note, and to write only inside `floorplan/`. Check the scripts a run may start (`FLOORPLAN_SCRIPTS`) against the skill's `allowed-tools`.
- Commit, push and deploy as for any change the backend serves.

Every map that was built with the old release keeps the old `serve.mjs`. canopy then refuses to start that map's server until the map is updated, because the update writes the new copy.
