#!/usr/bin/env bash
# One-time setup, run on the mini as the host user, so the secrets service
# can restart a compose project after it rewrote that project's .env (phase 3
# spec, part A1): a key of its own in ~/.config/canopy-restart (the secrets
# container mounts that folder read-only at /restart), an authorized_keys
# line that lets the key run scripts/canopy-restart and nothing else, from
# the canopy_default network only, and a known_hosts file pinning this
# host's key at the address the container dials. Safe to run again.
#
# What the key grants: list the projects under /opt/stacks and run
# `docker compose up -d` for one of them with its own files. A canopy shell
# already has more through mini-host (docs/deploy.md, "Host control").
set -euo pipefail

HERE=$(cd "$(dirname "$0")/.." && pwd -P)
dir="$HOME/.config/canopy-restart"
key="$dir/key"
auth="$HOME/.ssh/authorized_keys"
host=${CANOPY_RESTART_HOST:-192.168.48.1}
from=${CANOPY_RESTART_FROM:-192.168.48.0/20}

[ "$(uname)" = Linux ] && command -v docker >/dev/null || { echo "run this on the docker host (the mini)" >&2; exit 1; }
command -v jq >/dev/null || { echo "canopy-restart needs jq on the host: sudo pacman -S jq" >&2; exit 1; }

mkdir -p "$dir"
chmod 700 "$dir"
if [ ! -f "$key" ]; then
  ssh-keygen -q -t ed25519 -N "" -C "canopy-restart@$(hostname)" -f "$key"
  echo "made $key"
fi
chmod 600 "$key"

pub=$(cut -d' ' -f1-2 "$key.pub")
line="restrict,command=\"$HERE/scripts/canopy-restart\",from=\"$from\" $pub canopy-restart"
mkdir -p "$HOME/.ssh"
touch "$auth"
if grep -qF "$pub" "$auth"; then
  # the line for this key, replaced so the command follows the checkout
  grep -vF "$pub" "$auth" >"$auth.tmp" || true
  echo "$line" >>"$auth.tmp"
  cat "$auth.tmp" >"$auth" && rm "$auth.tmp"
  echo "refreshed the restart key's line in $auth"
else
  cp "$auth" "$auth.bak-canopy-restart"
  echo "$line" >>"$auth"
  echo "added the restart key to $auth (backup $auth.bak-canopy-restart)"
fi
chmod 600 "$auth"

hostkey=$(cut -d' ' -f1-2 /etc/ssh/ssh_host_ed25519_key.pub)
echo "$host $hostkey" >"$dir/known_hosts"
echo "pinned this host's key for $host in $dir/known_hosts"
echo "done: redeploy, then the Secrets view lists the stacks it can restart"
