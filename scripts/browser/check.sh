#!/usr/bin/env bash
# Drives this checkout's built page (dist/web) in the headless shell setup.sh
# installs: a scratch canopy server on a free port, scanning two throwaway
# repos (the runs pill's check wants a run in each, and the phone's wants one
# with work in it), with a clean environment
# (a canopy shell's own CANOPY_ settings would make it refuse the page), then
# check.ts against it. Everything it starts goes when it ends; the
# screenshots stay.
#   scripts/browser/check.sh            after bun run build
set -euo pipefail

DIR="${CANOPY_BROWSER_DIR:-/tmp/canopy-browser}"
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
SHOTS="${CANOPY_CHECK_SHOTS:-/tmp/canopy-check-shots}"
BUN="$(command -v bun)"

[ -f "$REPO/dist/web/index.html" ] || { echo "no dist/web; run bun run build first" >&2; exit 1; }
[ -d "$DIR/node_modules/playwright" ] || { echo "no browser in $DIR; run scripts/browser/setup.sh" >&2; exit 1; }

work="$(mktemp -d /tmp/canopy-check-XXXXXX)"
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
for name in demo twin; do
  mkdir -p "$work/root/$name"
  git -C "$work/root/$name" init -q -b main
  printf '# %s\n' "$name" >"$work/root/$name/README.md"
  git -C "$work/root/$name" -c user.name=check -c user.email=check@localhost add -A
  git -C "$work/root/$name" -c user.name=check -c user.email=check@localhost commit -qm init
done
# twin has work in it, so its panel on a phone holds a list of files, the box
# that filters them and a commit box: the tall column that once squeezed the
# section tabs to nothing
for i in 1 2 3 4 5 6 7 8; do
  printf 'export const part%s = %s;\n' "$i" "$i" >"$work/root/twin/part$i.ts"
done
printf 'changed\n' >>"$work/root/twin/README.md"

port="$("$BUN" -e 'const s = Bun.serve({ port: 0, fetch: () => new Response() }); console.log(s.port); s.stop(true);')"
env -i HOME="$work/home" PATH="$(dirname "$BUN"):/usr/local/bin:/usr/bin:/bin" SHELL=/bin/bash TERM=xterm-256color LANG=C.UTF-8 \
  CANOPY_CONFIG_DIR="$work/config" CANOPY_LOOPBACK_AUTH=1 CANOPY_PREVIEW_PORTS=0 CANOPY_NO_DESKTOP=1 \
  CANOPY_AGENT_SCAN=0 CANOPY_TAILCHAN_URL=off \
  "$BUN" "$REPO/bin/canopy.ts" ui "$work/root" --port "$port" --no-open >"$work/server.log" 2>&1 &
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

cp "$HERE/launch.ts" "$HERE/check.ts" "$DIR/"
"$HERE/run.sh" "$DIR/check.ts" "http://127.0.0.1:$port" "$SHOTS"
