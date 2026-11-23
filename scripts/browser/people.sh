#!/usr/bin/env bash
# Drives people, roles, teams and invites (FR-074) on this checkout's built
# page (dist/web), in the headless shell setup.sh installs: a scratch canopy
# server on a free port that enforces who calls and signs no loopback page in
# (check.sh's server does, so nothing there meets the sign-in screen), over
# three throwaway repos, two of them in the folder a team is given; then
# people.ts against it. Everything it starts goes when it ends; the
# screenshots stay.
#   scripts/browser/people.sh
set -euo pipefail

DIR="${CANOPY_BROWSER_DIR:-/tmp/canopy-browser}"
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
SHOTS="${CANOPY_PEOPLE_SHOTS:-/tmp/canopy-people-shots}"
BUN="$(command -v bun)"

[ -d "$DIR/node_modules/playwright" ] || { echo "no browser in $DIR; run scripts/browser/setup.sh" >&2; exit 1; }

# the page under test is this checkout's source: a build older than it is built again first
built="$REPO/dist/web/index.html"
newer=""
if [ -f "$built" ]; then
  newer="$(find "$REPO/ui" "$REPO/src/core" "$REPO/package.json" -type f -newer "$built" -print -quit)"
fi
if [ ! -f "$built" ] || [ -n "$newer" ]; then
  if [ -n "$newer" ]; then echo "dist/web is older than ${newer#"$REPO/"}; building"; else echo "no dist/web; building"; fi
  if ! log="$(cd "$REPO" && "$BUN" run build 2>&1)"; then
    printf '%s\n' "$log" | tail -40 >&2
    echo "the build failed, so there is no page to check" >&2
    exit 1
  fi
fi

work="$(mktemp -d /tmp/canopy-people-XXXXXX)"
server=""
cleanup() {
  if [ -n "$server" ]; then
    kill "$server" 2>/dev/null || true
    wait "$server" 2>/dev/null || true
  fi
  if [ -S "$work/config/tmux.sock" ]; then tmux -S "$work/config/tmux.sock" kill-server 2>/dev/null || true; fi
  rm -rf "$work"
}
trap cleanup EXIT

mkdir -p "$work/config" "$work/home"
for name in rio/app rio/site other/tool; do
  mkdir -p "$work/root/$name"
  git -C "$work/root/$name" init -q -b main
  printf '# %s\n' "$name" >"$work/root/$name/README.md"
  git -C "$work/root/$name" -c user.name=check -c user.email=check@localhost add -A
  git -C "$work/root/$name" -c user.name=check -c user.email=check@localhost commit -qm init
done
# the folder as canopy will name it: /tmp is a link on a Mac
team="$(cd "$work/root/rio" && pwd -P)"

port="$("$BUN" -e 'const s = Bun.serve({ port: 0, fetch: () => new Response() }); console.log(s.port); s.stop(true);')"
env -i HOME="$work/home" PATH="$(dirname "$BUN"):/usr/local/bin:/usr/bin:/bin" SHELL=/bin/bash TERM=xterm-256color LANG=C.UTF-8 \
  CANOPY_CONFIG_DIR="$work/config" CANOPY_CALLERS=enforce CANOPY_PREVIEW_PORTS=0 CANOPY_NO_DESKTOP=1 \
  CANOPY_AGENT_SCAN=0 CANOPY_TAILCHAN_URL=off \
  "$BUN" "$REPO/bin/canopy.ts" ui "$(cd "$work/root" && pwd -P)" --port "$port" --no-open >"$work/server.log" 2>&1 &
server=$!

for _ in $(seq 1 60); do
  if curl -sf -o /dev/null "http://127.0.0.1:$port/"; then break; fi
  sleep 0.5
done
if ! curl -sf -o /dev/null "http://127.0.0.1:$port/"; then
  echo "the scratch server did not come up:" >&2
  tail -20 "$work/server.log" >&2
  exit 1
fi

cp "$HERE/launch.ts" "$HERE/people.ts" "$DIR/"
"$HERE/run.sh" "$DIR/people.ts" "http://127.0.0.1:$port" "$work/server.log" "$SHOTS" "$team"
