#!/usr/bin/env bash
# One-time setup, run on the mini as the host user, so a canopy shell can
# redeploy canopy: a key of its own under ~/.ssh (the shells container mounts
# ~/.ssh read-only), an authorized_keys line that lets that key run
# scripts/redeploy.sh and nothing else, and a known_hosts file pinning this
# host's key under the alias redeploy.sh dials it by. Safe to run again.
#
# What the key grants: a canopy shell already runs as this user's uid with
# write access to ~/dev and ~/.claude, so running this script (which builds
# the checkout with docker) adds no reach it did not have.
set -euo pipefail

HERE=$(cd "$(dirname "$0")/.." && pwd -P)
key="$HOME/.ssh/canopy_deploy"
auth="$HOME/.ssh/authorized_keys"
known="$HOME/.ssh/canopy_deploy_known_hosts"

[ "$(uname)" = Linux ] && command -v docker >/dev/null || { echo "run this on the docker host (the mini)" >&2; exit 1; }

if [ ! -f "$key" ]; then
  ssh-keygen -q -t ed25519 -N "" -C "canopy-deploy@$(hostname)" -f "$key"
  echo "made $key"
fi

pub=$(cut -d' ' -f1-2 "$key.pub")
line="restrict,command=\"$HERE/scripts/redeploy.sh --gate\" $pub canopy-deploy"
touch "$auth"
if grep -qF "$pub" "$auth"; then
  # the line for this key, replaced so the command follows the checkout
  grep -vF "$pub" "$auth" >"$auth.tmp" || true
  echo "$line" >>"$auth.tmp"
  cat "$auth.tmp" >"$auth" && rm "$auth.tmp"
  echo "refreshed the deploy key's line in $auth"
else
  cp "$auth" "$auth.bak-canopy-deploy"
  echo "$line" >>"$auth"
  echo "added the deploy key to $auth (backup $auth.bak-canopy-deploy)"
fi
chmod 600 "$auth"

hostkey=$(cut -d' ' -f1-2 /etc/ssh/ssh_host_ed25519_key.pub)
echo "canopy-deploy-host $hostkey" >"$known"
echo "pinned this host's key in $known"
echo "done: in a canopy shell, bun run redeploy status"
