# canopy's copy of Archify

This folder is [Archify](https://github.com/tt-a1i/archify) by tt-a1i, MIT at this release (see `skills/archify/LICENSE`), at **3.2.0**, commit `208acba8d412335185b2056fedf54b3405df43fb` (2026-10-18). canopy uses it for the diagrams in the repo panel's map section and `canopy archify` (FR-071). `docs/architecture.md`, "Diagrams (Archify)", says how the pieces fit.

A diagram run loads this folder with `claude --plugin-dir lib/archify`, so the skill is `archify:archify`. The run calls the skill's CLI as `node lib/archify/skills/archify/bin/archify.mjs` by its absolute path, which is the command canopy's permission rule allows.

## What is here

- `skills/archify/`: upstream's `archify/` folder, the package its installer copies, byte for byte except that the rendered example pages `examples/*.html` are left out. They are about 830 KB each, 13 MB in all, and nothing at run time reads them: `doctor`, `demo` and the Type router use the example JSON files, which are kept.
- `.claude-plugin/plugin.json`: canopy's own. Upstream ships no Claude plugin, only the skill, so canopy wraps it as one for `--plugin-dir`. Its version follows the skill's `package.json`, and a test holds the two, `skill-release.json`, the pin above and `ARCHIFY_VERSION` in `src/core/archify.ts` equal.
- `VENDOR.md`, this file.

## What canopy changed

Nothing inside `skills/archify/`. What canopy needs it gets from the outside:

- **The update check is off.** `finalize` and `deliver` fetch `https://tt-a1i.github.io/archify/skill-updates/archify/stable.json` to say when a newer Archify is out. canopy sets `ARCHIFY_UPDATE_CHECK_DISABLED=1` in a diagram run's env (`archifyEnv`), so that address is never asked. canopy updates this copy itself (below).
- **The run's task** (`archifyTask` in `src/core/archify.ts`) names the folder under `.archify/` canopy chose, gives the CLI's absolute path, says to draw without source evidence in a checkout with no origin remote (Archify refuses `--repo-root` there, and the run would otherwise stop to ask), counts a finalize whose only miss is a browser check skipped for want of Chrome as delivered, and tells the run not to open the page, not to give the update notice, and never to write the `[archify explainer: …]` line into a rules file, which SKILL.md's Output section offers.

Other addresses in the code, none of which a diagram run asks: `bin/preview.mjs` serves a page on loopback only when someone asks to preview one, and `renderers/shared/brand-marks.mjs` fetches a brand's logo only from a web address the user gives it. The rest are schema ids and links in the brand table and the docs.

## Browser checks

`finalize` ends with `browser-check`, which drives Chrome, Chromium or Edge to measure the page. Where it finds none (canopy's own containers on the mini have none), it exits 2 with the gate `skipped` and the others passed, and canopy lists the diagram as "checked, no browser check". `ARCHIFY_CHROME` names a browser when one is installed somewhere unusual.

## Moving to a new release

Upstream tags releases `vX.Y.Z`. After 3.2.0 it moved to Apache-2.0 (commit `9c306ee8`, "license: adopt Apache-2.0 while preserving historical MIT grants"), so a later release brings `NOTICE` and `LICENSE-MIT` into `archify/`. Keep both: Apache-2.0, section 4(d), asks for the NOTICE to travel with the copy.

1. Clone upstream shallowly at the tag (the whole history is about 1.7 GB): `git clone --depth 1 --branch vX.Y.Z https://github.com/tt-a1i/archify`.
2. Replace `skills/archify/` with its `archify/`, leaving out `examples/*.html`, and set the version in `.claude-plugin/plugin.json`, the pin above and `ARCHIFY_VERSION`.
3. Read the diff. Turn off any new address a diagram run would ask, by an env variable or the task, and name it here. Check SKILL.md's steps against `archifyTask`, and the CLI's path against `archifyTools`.
4. Run `node lib/archify/skills/archify/bin/archify.mjs doctor` and `bun test src/core/archify.test.ts src/server/archify.test.ts src/server/archify-route.test.ts`, then commit, push and deploy as for any change the backend serves.

Diagrams drawn with the old release keep working: each page is standalone HTML.
