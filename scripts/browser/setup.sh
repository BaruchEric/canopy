#!/usr/bin/env bash
# A headless Chromium that Playwright can drive, for a Debian container with
# no Chrome libraries and no root, such as canopy's own containers. All of it
# lands under $CANOPY_BROWSER_DIR (default /tmp/canopy-browser) and nothing is
# installed system-wide, so a new container needs it again. check.sh drives
# canopy's page with it; run.sh runs any other Playwright script.
#
# The steps: Playwright with bun, its Chromium headless shell, then the shared
# libraries that shell needs and some fonts, as Debian packages fetched by a
# private apt setup (update and download run as any user once apt's state and
# cache point at a folder of its own) and unpacked with dpkg -x. Each step is
# skipped when its result is already there.
set -euo pipefail

DIR="${CANOPY_BROWSER_DIR:-/tmp/canopy-browser}"
HERE="$(cd "$(dirname "$0")" && pwd)"
PLAYWRIGHT=1.65.0
# what the headless shell links against beyond a slim Debian 13, and fonts
PKGS=(
  at-spi2-common fonts-dejavu-mono fonts-dejavu-core fonts-liberation
  libasound2-data libasound2t64 libatomic1 libglib2.0-0t64 libatk1.0-0t64
  libdbus-1-3 libxau6 libxdmcp6 libxcb1 libx11-data libx11-6 libxext6 libxi6
  libatspi2.0-0t64 libatk-bridge2.0-0t64 libdrm-common libdrm2
  libwayland-server0 libx11-xcb1 libxcb-dri3-0 libxcb-present0 libxcb-randr0
  libxcb-sync1 libxcb-xfixes0 libxshmfence1 libgbm1 libnspr4 libnss3
  libxcomposite1 libxdamage1 libxfixes3 xkb-data libxkbcommon0 libxrender1
  libxrandr2
)

say() { printf 'browser setup: %s\n' "$*"; }
for tool in bun apt-get dpkg ldd; do
  command -v "$tool" >/dev/null || { say "needs $tool (a Debian container with bun)"; exit 1; }
done
mkdir -p "$DIR"
cd "$DIR"

# 1. Playwright, installed where a script copied into this folder finds it
if [ ! -d node_modules/playwright ]; then
  say "installing playwright $PLAYWRIGHT"
  printf '{ "name": "canopy-browser", "private": true, "type": "module" }\n' >package.json
  BUN_INSTALL_CACHE_DIR="$DIR/.bun-cache" bun add "playwright@$PLAYWRIGHT" >/dev/null
fi
cp "$HERE/launch.ts" "$DIR/launch.ts"

# 2. the headless shell
export PLAYWRIGHT_BROWSERS_PATH="$DIR/browsers"
shell_path() { ls -d "$DIR"/browsers/chromium_headless_shell-*/chrome-headless-shell-linux64/chrome-headless-shell 2>/dev/null | head -n 1; }
if [ -z "$(shell_path)" ]; then
  say "downloading the Chromium headless shell"
  bunx playwright install chromium-headless-shell
fi
shell="$(shell_path)"
[ -n "$shell" ] || { say "playwright installed no headless shell under $DIR/browsers"; exit 1; }

# 3. its libraries and fonts, unless they are all here already
LIBS="$DIR/libs/usr/lib/x86_64-linux-gnu"
missing() { LD_LIBRARY_PATH="$LIBS" ldd "$shell" | grep 'not found' || true; }
if [ -n "$(missing)" ] || [ ! -d "$DIR/libs/usr/share/fonts" ]; then
  say "fetching ${#PKGS[@]} Debian packages"
  mkdir -p apt/state/lists/partial apt/cache/archives/partial apt/etc/sources.list.d apt/etc/apt.conf.d apt/etc/preferences.d debs libs
  # Debian's own sources only: a third-party list that fails to update would stop apt-get
  if [ -f /etc/apt/sources.list.d/debian.sources ]; then cp /etc/apt/sources.list.d/debian.sources apt/etc/sources.list.d/; fi
  list=/dev/null
  if [ -f /etc/apt/sources.list ] && grep -q '^deb ' /etc/apt/sources.list; then list=/etc/apt/sources.list; fi
  cat >apt/apt.conf <<EOF
Dir::State "$DIR/apt/state";
Dir::State::status "/var/lib/dpkg/status";
Dir::Cache "$DIR/apt/cache";
Dir::Etc::SourceList "$list";
Dir::Etc::SourceParts "$DIR/apt/etc/sources.list.d";
Dir::Etc::Preferences "/dev/null";
Dir::Etc::PreferencesParts "$DIR/apt/etc/preferences.d";
Dir::Etc::Parts "$DIR/apt/etc/apt.conf.d";
Debug::NoLocking "true";
APT::Sandbox::User "$(id -un)";
EOF
  export APT_CONFIG="$DIR/apt/apt.conf"
  apt-get update -qq
  (cd debs && apt-get download -qq "${PKGS[@]}")
  for deb in debs/*.deb; do dpkg -x "$deb" libs; done
  # the package lists and apt's cache of them (about 270 MB) only serve the download
  rm -rf apt/state/lists apt/cache
  still="$(missing)"
  if [ -n "$still" ]; then
    say "the headless shell still lacks:"
    printf '%s\n' "$still"
    exit 1
  fi
fi

# 4. fonts: the container has none of its own
mkdir -p fontcache
cat >fonts.conf <<EOF
<?xml version="1.0"?>
<!DOCTYPE fontconfig SYSTEM "urn:fontconfig:fonts.dtd">
<fontconfig>
  <dir>$DIR/libs/usr/share/fonts</dir>
  <cachedir>$DIR/fontcache</cachedir>
  <include ignore_missing="yes">$DIR/libs/etc/fonts/conf.d</include>
  <alias><family>sans-serif</family><prefer><family>Liberation Sans</family><family>DejaVu Sans</family></prefer></alias>
  <alias><family>serif</family><prefer><family>Liberation Serif</family><family>DejaVu Serif</family></prefer></alias>
  <alias><family>monospace</family><prefer><family>Liberation Mono</family><family>DejaVu Sans Mono</family></prefer></alias>
  <alias><family>system-ui</family><prefer><family>Liberation Sans</family><family>DejaVu Sans</family></prefer></alias>
  <alias><family>ui-monospace</family><prefer><family>Liberation Mono</family><family>DejaVu Sans Mono</family></prefer></alias>
  <alias binding="same"><family>Arial</family><accept><family>Liberation Sans</family></accept></alias>
  <alias binding="same"><family>Helvetica</family><accept><family>Liberation Sans</family></accept></alias>
  <alias binding="same"><family>Courier New</family><accept><family>Liberation Mono</family></accept></alias>
</fontconfig>
EOF

# 5. proof: the shell starts and reports its version
cat >"$DIR/probe.ts" <<'EOF'
import { launch } from "./launch.ts";
const browser = await launch();
console.log(`browser setup: chromium ${browser.version()} starts`);
await browser.close();
EOF
"$HERE/run.sh" "$DIR/probe.ts"
say "ready in $DIR ($(du -sh "$DIR" | cut -f1))"
