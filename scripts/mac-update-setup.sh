#!/bin/sh
# One-time setup, run on the mini as the host user, of the key the mini uses
# to bring the Mac's own canopy server up to origin's main
# (scripts/mac-update): ~/.ssh/canopy_mac_update, which canopy's containers
# see read-only, and ~/.ssh/canopy_mac_update_host, the user@address it
# dials, taken from the mac-peer alias peer sync already uses. It prints the
# authorized_keys line to add on the Mac, which this script cannot reach.
# The _host file's second line is the name the Mac's host key is known under
# in known_hosts (mac-peer's HostKeyAlias), since the address may not be.
# Safe to run again.
#
# What the key grants: fast-forward the Mac's checkout to origin's main,
# build it and restart its launchd server, from the mini's tailnet address
# only. Whoever can push to main and reach this key can therefore have the
# Mac run that commit, as a canopy shell on the mini can already have the
# mini run it.
#
#   CANOPY_MAC_SSH       user@address of the Mac, else mac-peer's
#   CANOPY_MAC_CHECKOUT  the checkout on the Mac, else dev/dev-tools/canopy
#                        under that user's home
#   CANOPY_MAC_FROM      the from= address, else this host's tailnet IPv4
set -eu

die() {
  printf 'mac-update-setup: %s\n' "$*" >&2
  exit 1
}

[ "$(uname)" = Linux ] || die "run this on the mini, the host the key dials from"
[ ! -f /.dockerenv ] || die "run this on the mini's host (ssh mini-host), not in a container: ~/.ssh is read-only here"

key="$HOME/.ssh/canopy_mac_update"
mac=${CANOPY_MAC_SSH:-$(ssh -G mac-peer 2>/dev/null | awk '$1 == "user" { u = $2 } $1 == "hostname" { h = $2 } END { if (u != "" && h != "") print u "@" h }')}
[ -n "$mac" ] || die "no mac-peer alias to read the Mac's address from; set CANOPY_MAC_SSH=user@address"
user=${mac%@*}
checkout=${CANOPY_MAC_CHECKOUT:-/Users/$user/dev/dev-tools/canopy}
from=${CANOPY_MAC_FROM:-$(tailscale ip -4 2>/dev/null | head -1)}
[ -n "$from" ] || die "no tailnet address for from=; set CANOPY_MAC_FROM"

if [ ! -f "$key" ]; then
  ssh-keygen -q -t ed25519 -N "" -C "canopy-mac-update@$(hostname)" -f "$key"
  echo "made $key"
fi
hostkey=${CANOPY_MAC_HOSTKEY:-$(ssh -G mac-peer 2>/dev/null | awk '$1 == "hostkeyalias" { print $2 }')}
printf '%s\n%s\n' "$mac" "${hostkey:-${mac#*@}}" >"${key}_host"
chmod 600 "$key" "${key}_host"

line=$(printf 'restrict,from="%s",command="%s/scripts/mac-update" %s' "$from" "$checkout" "$(cat "$key.pub")")
cat <<EOF
On the Mac, add the key with this command (a copy of authorized_keys goes
beside it first):

cp ~/.ssh/authorized_keys ~/.ssh/authorized_keys.bak-canopy-mac-update && printf '%s\n' '$line' >> ~/.ssh/authorized_keys

Then, from a canopy shell on the mini: bun run redeploy mac status
EOF
