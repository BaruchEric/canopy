#!/usr/bin/env bash
# Runs a Playwright script against the headless shell setup.sh put under
# $CANOPY_BROWSER_DIR (default /tmp/canopy-browser): its libraries, fonts and
# browsers folder in the environment. A script outside that folder imports
# its launch.ts by absolute path, since a bare "playwright" import resolves
# only from there.
#   scripts/browser/run.sh <script.ts> [args...]
set -euo pipefail

DIR="${CANOPY_BROWSER_DIR:-/tmp/canopy-browser}"
if [ $# -lt 1 ]; then
  echo "usage: $0 <script.ts> [args...]" >&2
  exit 2
fi
[ -d "$DIR/node_modules/playwright" ] || { echo "no browser in $DIR; run scripts/browser/setup.sh" >&2; exit 1; }

export LD_LIBRARY_PATH="$DIR/libs/usr/lib/x86_64-linux-gnu${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
export FONTCONFIG_FILE="$DIR/fonts.conf"
export PLAYWRIGHT_BROWSERS_PATH="$DIR/browsers"
export PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
# Chromium's own config and cache writes stay in the folder too
export XDG_CONFIG_HOME="$DIR/xdg/config"
export XDG_CACHE_HOME="$DIR/xdg/cache"
mkdir -p "$XDG_CONFIG_HOME" "$XDG_CACHE_HOME"

exec bun run "$@"
