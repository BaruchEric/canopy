#!/usr/bin/env bash
# Redeploy the shared canopy backend (docker compose on the mini) from
# wherever this runs:
#
#   on the Mac        ssh to the mini, fast-forward its checkout to the Mac's
#                     main through the peer remote, then deploy there
#   in a canopy shell ssh to the host this container runs on, with the
#                     deploy key whose authorized_keys line only runs this
#                     script, and deploy the checkout the shell sees
#   on the mini       deploy directly
#
# Usage: redeploy.sh [--pull] [--shells] [--expect SHA] | status | log
#   --pull    fast-forward the mini's checkout to the Mac's main first
#             (always on from the Mac)
#   --shells  go ahead when the deploy would recreate the shells container,
#             which ends every shell, the one running this included
#   --expect  refuse unless the checkout's HEAD is this commit after pulling
#   status    what is deployed and running
#   log       the last deploy's log
#
# The compose run is detached on the host and logged under
# ~/.cache/canopy-deploy, so a shell that goes with the shells container, or
# a dropped ssh, does not stop a deploy halfway. One-time setup of the key a
# canopy shell uses: scripts/redeploy-setup.sh on the mini.
set -euo pipefail

HERE=$(cd "$(dirname "$0")/.." && pwd -P)
MINI=${CANOPY_DEPLOY_MINI:-macmini-2018}
MINI_CHECKOUT=${CANOPY_DEPLOY_CHECKOUT:-dev/dev-tools/canopy}
LOGS="$HOME/.cache/canopy-deploy"

die() { printf 'redeploy: %s\n' "$*" >&2; exit 1; }

# a value from the checkout's .env, which the container mounts too
envval() { [ -f "$HERE/.env" ] && sed -n "s/^$1=//p" "$HERE/.env" | tail -1 | tr -d '"' || true; }

# ---------- the forced command: only this script's own words get through
if [ "${1:-}" = "--gate" ]; then
  read -r -a words <<<"${SSH_ORIGINAL_COMMAND:-}"
  args=()
  i=0
  while [ $i -lt ${#words[@]} ]; do
    w=${words[$i]}
    case $w in
      redeploy | redeploy.sh) ;;
      --pull | --shells | status | log) args+=("$w") ;;
      --expect)
        i=$((i + 1))
        sha=${words[$i]:-}
        [[ $sha =~ ^[0-9a-f]{7,40}$ ]] || die "--expect wants a commit hash"
        args+=(--expect "$sha")
        ;;
      *) die "refused: $w" ;;
    esac
    i=$((i + 1))
  done
  CANOPY_DEPLOY_HOST_SIDE=1 exec "$0" "${args[@]}"
fi

# ---------- the Mac: hand over to the mini
if [ "$(uname)" = "Darwin" ]; then
  git -C "$HERE" diff --quiet HEAD -- 2>/dev/null || echo "redeploy: uncommitted changes here do not reach the mini; only commits do" >&2
  head=$(git -C "$HERE" rev-parse HEAD)
  branch=$(git -C "$HERE" branch --show-current)
  [ "$branch" = main ] || die "the mini deploys main; this checkout is on $branch"
  case " $* " in *" status "* | *" log "*) exec ssh "$MINI" "~/$MINI_CHECKOUT/scripts/redeploy.sh $*" ;; esac
  exec ssh "$MINI" "~/$MINI_CHECKOUT/scripts/redeploy.sh --pull --expect $head $*"
fi

# ---------- a canopy shell: ask the host
if [ -z "${CANOPY_DEPLOY_HOST_SIDE:-}" ] && ! command -v docker >/dev/null 2>&1; then
  [ -f /.dockerenv ] || die "no docker here and not in a canopy container"
  key="$HOME/.ssh/canopy_deploy"
  [ -f "$key" ] || die "no deploy key at $key; run scripts/redeploy-setup.sh on the mini once"
  host=${CANOPY_DEPLOY_HOST:-$(envval CANOPY_LISTEN)}
  [ -n "$host" ] || die "no host to reach: set CANOPY_DEPLOY_HOST or CANOPY_LISTEN in $HERE/.env"
  home=$(envval HOST_HOME)
  user=${CANOPY_DEPLOY_USER:-${home##*/}}
  exec ssh -i "$key" -o IdentitiesOnly=yes -o BatchMode=yes \
    -o HostKeyAlias=canopy-deploy-host -o UserKnownHostsFile="$HOME/.ssh/canopy_deploy_known_hosts" \
    -o StrictHostKeyChecking=yes "${user:-eric}@$host" redeploy "$@"
fi

# ---------- the host
pull=0 shells=0 expect=""
cmd=deploy
while [ $# -gt 0 ]; do
  case $1 in
    --pull) pull=1 ;;
    --shells) shells=1 ;;
    --expect) expect=${2:-}; shift ;;
    status | log) cmd=$1 ;;
    *) die "unknown argument: $1" ;;
  esac
  shift
done

cd "$HERE"
mkdir -p "$LOGS"

if [ "$cmd" = log ]; then
  last=$(ls -1t "$LOGS"/*.log 2>/dev/null | head -1)
  [ -n "$last" ] || die "no deploy logged yet"
  echo "== $last"
  cat "$last"
  exit 0
fi

if [ "$cmd" = status ]; then
  echo "checkout  $(git log -1 --format='%h %s' HEAD)"
  [ -f "$LOGS/deployed" ] && echo "deployed  $(cat "$LOGS/deployed")"
  for c in canopy-shells-1 canopy-canopy-1 canopy-tunnel-1; do
    docker inspect -f "$c  {{.State.Status}} since {{.State.StartedAt}}" "$c" 2>/dev/null || echo "$c  missing"
  done
  echo "port      $(docker port canopy-shells-1 7850 2>/dev/null | head -1 || true)"
  echo "running   $(docker exec canopy-canopy-1 bun bin/canopy.ts version 2>/dev/null || echo unknown)"
  docker compose logs canopy --tail 3 --no-log-prefix 2>/dev/null | sed 's/^/log       /'
  exit 0
fi

exec 9>"$LOGS/lock"
flock -n 9 || die "another deploy is running; redeploy.sh log shows it"

if [ $pull = 1 ]; then
  self=$(git hash-object "$HERE/scripts/redeploy.sh")
  git fetch -q mac main || die "could not fetch from the Mac (the mac peer remote)"
  if git merge-base --is-ancestor mac/main HEAD; then
    :
  elif git merge-base --is-ancestor HEAD mac/main; then
    git merge -q --ff-only mac/main || die "could not fast-forward: the checkout has changes in the way"
  else
    die "the mini's main and the Mac's have both moved; merge them first"
  fi
  # the pull brought a new copy of this script: run that one, or the deploy
  # it describes waits for the next run
  if [ "$(git hash-object "$HERE/scripts/redeploy.sh")" != "$self" ]; then
    again=()
    [ "$shells" = 1 ] && again+=(--shells)
    [ -n "$expect" ] && again+=(--expect "$expect")
    exec 9>&-
    exec bash "$HERE/scripts/redeploy.sh" "${again[@]}"
  fi
fi
if [ -n "$expect" ]; then
  [ "$(git rev-parse HEAD)" = "$(git rev-parse "$expect^{commit}" 2>/dev/null)" ] ||
    die "the checkout is at $(git rev-parse --short HEAD), not ${expect:0:7}"
fi

log="$LOGS/$(date +%Y%m%d-%H%M%S).log"
rc="$log.rc"
sha=$(git log -1 --format='%h %s' HEAD)
# the image has no .git; these stamp /api/about and the UI with the commit
CANOPY_COMMIT=$(git rev-parse HEAD)
CANOPY_COMMITTED=$(git log -1 --format=%cI HEAD)
echo "redeploy: $sha (log $log)"

# the whole deploy, detached from this session
job() {
  set -o pipefail
  echo "== $(date) deploying $sha"
  docker compose build || { echo "build failed"; return 1; }
  # a bind mount's missing host folder is made by docker, as root, and the
  # shells container's user could never write a login into it
  mkdir -p "$HOME/.convex"
  if docker compose --dry-run up -d 2>&1 | grep -q 'canopy-shells-1.*Recreate'; then
    if [ "$shells" != 1 ]; then
      echo "this deploy recreates the shells container, which ends every shell."
      echo "run it again with --shells when nothing needs them."
      return 3
    fi
    echo "recreating the shells container: every shell ends"
  fi
  docker compose up -d || {
    echo "up failed; what holds 7850:"
    ss -ltnp 2>/dev/null | grep ':7850 ' || true
    return 1
  }
  for _ in $(seq 1 30); do
    if docker compose logs canopy --since 2m 2>/dev/null | grep -q 'canopy →'; then break; fi
    sleep 1
  done
  port=$(docker port canopy-shells-1 7850 2>/dev/null | head -1 || true)
  [ -n "$port" ] || { echo "the shells container has no published port; free 7850 and run: docker compose up -d --force-recreate shells canopy"; return 1; }
  docker compose logs canopy --tail 4 --no-log-prefix
  echo "$sha on $port, $(date)" >"$LOGS/deployed"
  echo "== deployed $sha on $port"
}
export -f job
export sha shells LOGS CANOPY_COMMIT CANOPY_COMMITTED
setsid nohup bash -c 'job; echo $? > "$0"' "$rc" >"$log" 2>&1 </dev/null &

# follow along; if this session goes, the deploy carries on
tail -n +1 -F "$log" 2>/dev/null &
tailer=$!
while [ ! -s "$rc" ]; do sleep 1; done
sleep 0.5
kill $tailer 2>/dev/null || true
code=$(cat "$rc")
ls -1t "$LOGS"/*.log | tail -n +21 | xargs -r rm -f
find "$LOGS" -name '*.rc' -mtime +7 -delete 2>/dev/null || true
exit "$code"
