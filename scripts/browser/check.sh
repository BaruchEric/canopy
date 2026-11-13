#!/usr/bin/env bash
# Drives this checkout's built page (dist/web) in the headless shell setup.sh
# installs, building it first when it is missing or older than the source:
# a scratch canopy server on a free port, scanning two throwaway
# repos (the runs pill's check wants a run in each, and the phone's wants one
# with work in it) and keeping one ended coordinator in its run log (the
# manager view's), with a clean environment
# (a canopy shell's own CANOPY_ settings would make it refuse the page), then
# check.ts against it. Everything it starts goes when it ends; the
# screenshots stay.
#   scripts/browser/check.sh
set -euo pipefail

DIR="${CANOPY_BROWSER_DIR:-/tmp/canopy-browser}"
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
SHOTS="${CANOPY_CHECK_SHOTS:-/tmp/canopy-check-shots}"
BUN="$(command -v bun)"

[ -d "$DIR/node_modules/playwright" ] || { echo "no browser in $DIR; run scripts/browser/setup.sh" >&2; exit 1; }

# The page under test is this checkout's source, so a build older than the
# source is built again first. A pull or a deploy moves the source and leaves
# dist/web as it was: on 2026-11-10 a run on the mini drove the day before's
# build, failed for a chunk that build never had, and passed a view that
# build showed the board for.
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

# a coordinator that ended, kept in the run log the way canopy keeps one
# (core/runlog.ts: runs/<id>/run.json, the folder 0700, the file 0600). It
# answers by its id and is gone from /api/runs, so the manager view's check
# opens it and wants "This goal has ended", never a blank page.
kept="$work/config/runs/check-ended"
mkdir -p "$kept"
chmod 700 "$work/config/runs" "$kept"
now=$(($(date +%s) * 1000))
cat >"$kept/run.json" <<EOF
{"id":"check-ended","repoId":"demo","action":"coordinate","verb":"coordinate","progress":"","expectsChange":false,"chat":true,"harness":"claude","note":"Tidy the README of every repo","status":"stopped","startedAt":$((now - 3600000)),"endedAt":$((now - 600000)),"steps":[{"id":"u1","at":$((now - 3600000)),"kind":"user","text":"Tidy the README of every repo"}],"prompt":null,"tasks":[{"id":"t1","title":"Tidy the README","repo":"demo","note":"Say what the repo is in its first line","action":"ask","state":"done","outcome":"landed"}]}
EOF
chmod 600 "$kept/run.json"

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
