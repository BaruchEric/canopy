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
# Usage: redeploy.sh [--pull] [--shells] [--restart] [--force] [--expect SHA] | status | log
#   --pull    fast-forward the mini's checkout to the Mac's main first
#             (always on from the Mac)
#   --shells  go ahead when the deploy would recreate the shells container,
#             which ends every shell, the one running this included
#   --restart recreate the canopy container even when the deploy changes
#             nothing in it; the shells stay
#   --force   go ahead when recreating the canopy container would cut off
#             work it has going (runs, flows, fleets, the landing queue);
#             it does not stand in for --shells
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
      --pull | --shells | --restart | --force | status | log) args+=("$w") ;;
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
pull=0 shells=0 restart=0 force=0 expect=""
cmd=deploy
while [ $# -gt 0 ]; do
  case $1 in
    --pull) pull=1 ;;
    --shells) shells=1 ;;
    --restart) restart=1 ;;
    --force) force=1 ;;
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
  for c in canopy-shells-1 canopy-canopy-1 canopy-coord-1 canopy-tunnel-1; do
    docker inspect -f "$c  {{.State.Status}} since {{.State.StartedAt}}" "$c" 2>/dev/null || echo "$c  missing"
  done
  # the shells also publish 7850 on the coordinator bridge's gateway
  # (10.250.14.1), which is not the address to report
  echo "port      $(docker port canopy-shells-1 7850 2>/dev/null | grep -v '^10\.250\.14\.1:' | head -1 || true)"
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
    [ "$restart" = 1 ] && again+=(--restart)
    [ "$force" = 1 ] && again+=(--force)
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

# The stages service's bind mounts, resolved the way compose resolves them
# (the environment, then .env, then the default in docker-compose.yml).
# job() runs in a detached shell that has neither envval nor .env, so they
# are worked out here and exported.
STAGE_DEV_ROOT=${DEV_ROOT:-$(envval DEV_ROOT)}
STAGE_DEV_ROOT=${STAGE_DEV_ROOT:-/home/eric/dev}
STAGE_HOST_HOME=${HOST_HOME:-$(envval HOST_HOME)}
STAGE_HOST_HOME=${STAGE_HOST_HOME:-/home/eric}

# the whole deploy, detached from this session
job() {
  set -o pipefail
  echo "== $(date) deploying $sha"
  docker compose build || { echo "build failed"; return 1; }
  # a bind mount's missing host folder is made by docker, as root, and the
  # shells container's user could never write a login into it
  mkdir -p "$HOME/.convex" || { echo "could not make $HOME/.convex"; return 1; }
  # the same for the stages: a root .shared would stop canopy copying a
  # stage's inputs in, and a root login folder would keep the stages' own
  # claude and codex logins out
  mkdir -p "$STAGE_DEV_ROOT/_incubator" "$STAGE_DEV_ROOT/_incubator/.shared" \
    "$STAGE_HOST_HOME/.config/canopy-stages/claude" "$STAGE_HOST_HOME/.config/canopy-stages/codex" ||
    { echo "could not make the stages folders; up would make them as root"; return 1; }
  # the coordinator's runner: its seeds (canopy makes a 0700 folder per run
  # there) and its own claude and codex logins. Made whether or not .env
  # turns the coordinator on, since coord always runs and canopy always
  # mounts the seeds
  mkdir -p "$STAGE_HOST_HOME/.local/share/canopy-coord/seeds" \
    "$STAGE_HOST_HOME/.config/canopy-coord/claude" "$STAGE_HOST_HOME/.config/canopy-coord/codex" &&
    chmod 700 "$STAGE_HOST_HOME/.local/share/canopy-coord/seeds" ||
    { echo "could not make the coordinator's folders; up would make them as root"; return 1; }
  # the secrets service writes the MCP env files here as root and chowns each
  # to the folder's owner; a folder docker made would be root's, and 0700
  # keeps every other user out
  mkdir -p "$STAGE_HOST_HOME/.claude/mcp-env" && chmod 700 "$STAGE_HOST_HOME/.claude/mcp-env" ||
    { echo "could not make $STAGE_HOST_HOME/.claude/mcp-env; up would make it as root"; return 1; }
  # the restart key's folder (scripts/restart-setup.sh fills it); the
  # secrets service mounts it read-only, so a root-made one would stay empty
  mkdir -p "$STAGE_HOST_HOME/.config/canopy-restart" && chmod 700 "$STAGE_HOST_HOME/.config/canopy-restart" ||
    { echo "could not make $STAGE_HOST_HOME/.config/canopy-restart; up would make it as root"; return 1; }
  # what up would do, read once; a grep -q on the pipe itself can exit before
  # compose has written everything, and pipefail turns that SIGPIPE into a miss
  plan=$(docker compose --dry-run up -d 2>&1 || true)
  if grep -q 'canopy-shells-1.*Recreate' <<<"$plan"; then
    if [ "$shells" != 1 ]; then
      echo "this deploy recreates the shells container, which ends every shell."
      echo "run it again with --shells when nothing needs them."
      return 3
    fi
    echo "recreating the shells container: every shell ends"
  fi
  # Recreating canopy cuts off what it has going: a run working or waiting on
  # a prompt, a flow or fleet mid-step, a landing entry rebasing, in setup, at
  # its gate or landing. Any of those stops the deploy with exit 4 unless
  # --force. Only a plan that leaves canopy running as it is (the same commit
  # rebuilds to the same image) without --restart skips the check; a plan
  # this cannot read is checked. A canopy that does not answer has nothing going.
  if [ "$force" != 1 ] && { [ "$restart" = 1 ] || ! grep -q 'canopy-canopy-1.*Running' <<<"$plan" ||
    grep -Eq 'canopy-(canopy|shells)-1.*Recreate' <<<"$plan"; }; then
    # not the coordinator bridge's gateway, which the shells publish 7850 on
    # too: this host's checks go to canopy's own address
    addr=$(docker port canopy-shells-1 7850 2>/dev/null | grep -v '^10\.250\.14\.1:' | head -1 || true)
    got=0
    if [ -n "$addr" ]; then
      runs=$(curl -fsS -m 10 "http://$addr/api/runs" 2>/dev/null) || got=$?
    fi
    if [ -z "$addr" ] || { [ "$got" != 0 ] && [ "$got" != 22 ]; }; then
      echo "canopy is not answering${addr:+ on $addr}, so nothing there is cut off"
    elif [ "$got" = 22 ]; then
      echo "canopy answers on $addr but would not list its runs, so this cannot tell what it has going."
      echo "check canopy, or run it again with --force."
      return 1
    elif ! command -v jq >/dev/null 2>&1; then
      echo "canopy answers on $addr, but this host has no jq to read what it has going."
      echo "install jq, or run it again with --force."
      return 1
    else
      # a route that does not answer (an older backend) has nothing going
      work=$(
        jq -r '.[] | select(.status == "working" or .status == "waiting")
          | "  run \(.id)  \(.repoId)  \(.verb), \(if .status == "waiting" then "waiting on a prompt"
            elif (.progress // "") != "" then .progress else "working" end)"' <<<"$runs"
        curl -fsS -m 10 "http://$addr/api/flows" 2>/dev/null | jq -r '.[] | select(.status == "working" or .status == "waiting")
          | "  flow \(.id)  \(.repoId)  \(.verb), at step \(.steps[.current].name // .current)\(if .status == "waiting" then ", waiting on a prompt" else "" end)"'
        curl -fsS -m 10 "http://$addr/api/fleets" 2>/dev/null | jq -r '.[] | select(.status == "working")
          | [.repos[].repoId] as $r
          | "  fleet \(.id)  \($r[:3] | join(", "))\(if ($r | length) > 3 then " and \(($r | length) - 3) more" else "" end)  \(.verb)"'
        curl -fsS -m 10 "http://$addr/api/landing" 2>/dev/null | jq -r '.entries[]?
          | select(.state == "rebasing" or .state == "setup" or .state == "gate" or .state == "landing")
          | "  landing \(.id)  \(.repoId)  \(.state)\(if .gate then " (\(.gate))" else "" end), \(.branch)"'
      )
      if [ -n "$work" ]; then
        echo "canopy has work going that recreating its container would cut off:"
        printf '%s\n' "$work"
        echo "wait for it to finish, or run it again with --force to cut it off."
        return 4
      fi
      echo "canopy has no work going that recreating it would cut off"
    fi
  fi
  before=$(docker inspect -f '{{.Id}}' canopy-canopy-1 2>/dev/null || true)
  docker compose up -d || {
    echo "up failed; what holds 7850:"
    ss -ltnp 2>/dev/null | grep ':7850 ' || true
    return 1
  }
  # up leaves a container alone when nothing in it changed (the same commit
  # rebuilds to the same image); --restart asks for a fresh one anyway
  if [ "$restart" = 1 ] && [ "$(docker inspect -f '{{.Id}}' canopy-canopy-1 2>/dev/null || true)" = "$before" ]; then
    echo "recreating the canopy container: nothing in it changed"
    docker compose up -d --no-deps --force-recreate canopy || { echo "could not recreate the canopy container"; return 1; }
  fi
  ready=0
  for _ in $(seq 1 30); do
    # Probe inside the container's network namespace and require this build:
    # an old startup log or a published port does not prove it is serving.
    if docker compose exec -T canopy bun -e '
      try {
        const res = await fetch("http://127.0.0.1:7850/api/about", { signal: AbortSignal.timeout(1000) });
        const about = await res.json();
        process.exit(res.ok && about.commit === process.argv[1] ? 0 : 1);
      } catch { process.exit(1); }
    ' "$CANOPY_COMMIT" >/dev/null 2>&1; then ready=1; break; fi
    sleep 1
  done
  if [ "$ready" != 1 ]; then
    echo "backend did not become ready at $CANOPY_COMMIT"
    docker compose logs canopy --tail 20 --no-log-prefix
    return 1
  fi
  port=$(docker port canopy-shells-1 7850 2>/dev/null | grep -v '^10\.250\.14\.1:' | head -1 || true)
  [ -n "$port" ] || { echo "the shells container has no published port; free 7850 and run: docker compose up -d --force-recreate shells canopy"; return 1; }
  docker compose logs canopy --tail 4 --no-log-prefix
  echo "$sha on $port, $(date)" >"$LOGS/deployed"
  echo "== deployed $sha on $port"
}
export -f job
export sha shells restart force LOGS CANOPY_COMMIT CANOPY_COMMITTED STAGE_DEV_ROOT STAGE_HOST_HOME
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
