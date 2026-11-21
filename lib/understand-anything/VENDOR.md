# canopy's copy of Understand-Anything

This folder is [Understand-Anything](https://github.com/Egonex-AI/Understand-Anything) by Yuxiang Lin and Infinite Universe, Inc., MIT (see `LICENSE`), at **2.9.8**, commit `b861852dda79273bd9d2e01c3160d42e2df510d2` (2026-11-15). canopy uses it for the knowledge graph in the repo panel's map section and for `canopy understand` (FR-072). `docs/architecture.md`, "The map's knowledge graph (Understand-Anything)", says how the pieces fit.

## What is here

Upstream's `understand-anything-plugin/` folder, laid out as upstream has it, plus upstream's `LICENSE`. That covers the plugin manifest, the skills, the agents, the skill source in `src/`, and the packages `core`, `dashboard`, `viewer` and the two tree-sitter wasm packages.

Left out:

- `hooks/`. Its PostToolUse hook would start node on every Bash call of a graph run, and its SessionStart hook says the graph is stale, which canopy's section already says. canopy makes a graph when someone asks for one, never on a commit.
- `packages/mcp/`. canopy does not serve the plugin's MCP server, and bun cannot install its link back to the plugin's root.
- `pnpm-lock.yaml` and `pnpm-workspace.yaml`. canopy installs with bun, from its own `bun.lock`.

Everything else in upstream's repo stays out too: the homepage, the tests, the translated READMEs, `.github/`, the install scripts and the other editors' plugin manifests.

## What canopy added and changed

- `bun.lock` is canopy's own. `bun install --lockfile-only` made it from upstream's `package.json` ranges, so the versions come from npm at the time it was made, not from upstream's pnpm lockfile.
- `package.json` gains `"workspaces": ["packages/*"]`. pnpm reads its workspace file, and bun reads this field.
- `packages/viewer/bin/viewer.mjs` stops itself once nothing has asked it for anything in `UNDERSTAND_IDLE_MS`, two hours unless set, as Floorplan's map server does. Upstream's runs until someone stops it. The edit is one block and one line, and each part carries a comment naming canopy.

## How canopy runs it

Upstream's skill scripts import a built core, and the viewer serves a built dashboard. canopy builds neither into this folder. The first graph run or open on a machine copies this folder to `<configDir>/understand/plugin-<version>-<hash>/`, runs `bun install --frozen-lockfile --ignore-scripts` there, builds `packages/core` and `packages/dashboard`, and puts the dashboard's build where the viewer serves it from (`src/server/understand.ts`, `prepare`). The hash covers every file here but this one, so an update or an edit makes a fresh copy, and the old one is removed once the new one is in. No install script runs, because the tree-sitter grammars' native builds are not needed: the core loads their `.wasm` files.

A graph run loads that copy with `claude --plugin-dir`, so the skill is `understand-anything:understand`. The viewer is the copy's `packages/viewer/bin/viewer.mjs`, which canopy starts with a token of its own. The dashboard loads its three fonts from Google Fonts, the page's only request off the machine. The graph and the code stay on the backend.

## Moving to a new release

canopy's health check `understand` (`.canopy/health.json`) runs `bun scripts/understand-update.ts --check` every six hours. It asks upstream for its tags without cloning, and the check goes down with the new version's number when a newer release is out.

Run `bun run understand:update`. canopy's panel lists it as the task `understand-update`. It does the mechanical part:

1. It clones upstream and takes its newest release tag (`vX.Y.Z`), or what `--ref` names: a tag, a branch or a commit.
2. It goes through upstream's plugin folder and `LICENSE` one file at a time, skipping what is left out above. A file canopy never changed becomes upstream's new one, and a file upstream added or removed is added or removed. A file canopy edited, `package.json` and `viewer.mjs` today, gets a three-way merge (`git merge-file`) with the pinned commit as the base, so the edits above carry over on their own. When upstream changed the same lines, the file keeps conflict markers and the run exits 1.
3. It moves the pin at the top of this file and `UNDERSTAND_VERSION` in `src/core/understand.ts`, which a test holds equal to `plugin.json` and `package.json`. When a `package.json` changed, it refreshes `bun.lock`.
4. It prints the web addresses the release adds to these files and upstream's commit subjects in the plugin since the pin.
5. It runs canopy's Understand-Anything tests with `CANOPY_UNDERSTAND_IT=1`, so the live test installs and builds the new copy in a scratch config dir, scans a repo with its scripts and serves a graph with its viewer.

It commits nothing, and it refuses to start while this folder or `src/core/understand.ts` hold uncommitted changes, so `git checkout -- lib/understand-anything src/core/understand.ts` drops a run. What is left for a person:

- Read the diff. Turn off any new address that sends data off the machine and name it here.
- Check `skills/understand/SKILL.md` against `understandTask` in `src/core/understand.ts`. That task tells the run the plugin is built, to stop before the dashboard, to go past the ignore-file confirmation, never to turn on auto-update, and to write only inside the graph's folder. The scripts a run may start are read from the skill's folder, so a new script is allowed with no change.
- Commit, push and deploy as for any change the backend serves. Each backend prepares the new copy on its next graph run or open.
