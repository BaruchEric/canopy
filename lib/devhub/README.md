# Canopy library engine

`engine.py` incorporates `_devhub/devhub.py` from commit `fd893c9` under its
MIT license (included here). It retains project classification and organization,
references, tags, relations, notes, favorites, pins, archives, deployment discovery,
health reports, bulk Git actions, static export, and dev-server/port management.
`categories.default.json` contains only the reusable taxonomy, never personal
project metadata. Python 3.10+ is the only additional runtime; no pip packages.

`canopy.py` supplies Canopy's root and private state directory, performs first-run
metadata migration, serializes CLI/HTTP/background writes, and serves the library
behind Canopy's authenticated loopback proxy. The worker starts when Library or
Ports is first opened and exits with Canopy. Its random port and credential stay
in a mode-600 file in Canopy's state directory for `announce`; they never enter
browser HTML. The original helper's externally trusted origins are not imported.

The existing dashboard and editors run inside Canopy's app shell, using
`bridge.js` for repository navigation and theme changes. `theme.css` applies
Canopy's colors. The Git cockpit remains React; the library retains the Python
renderer's UI rather than duplicating the mature workflows in React.

Intentional engine adaptations: correct absolute paths on port-page Start,
wait for server readiness, preserve active port/command edits across polling, re-read edited port settings before launching, escape
inline port JSON, localhost dev URLs without personal DNS, propagate failed CLI
statuses, and omit standalone helper installation and gallery publishing from
CLI help. Canopy owns the service lifecycle. `_devhub`'s separate DNS setup,
endpoint-site deployment, and personal builds-gallery publishing remain in the
original repository; no resolver, LaunchAgent, or public deployment is installed.

Run the integration tests with `bun test src/core/library.test.ts`.
