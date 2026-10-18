#!/bin/sh
# Fences the stages network and the coordinator's: every packet that comes
# in on either bridge (br-canopy-stg and br-canopy-crd, named in
# docker-compose.yml) for a private, tailnet, link-local, multicast,
# broadcast or 0.0.0.0/8 address is dropped, and the internet stays open;
# every IPv6 packet from either is dropped. The coordinator's bridge has one
# way through: canopy's port on that bridge's own gateway address
# (10.250.14.1:7850, where docker-compose.yml publishes it), accepted ahead
# of its drops.
#
# Linux takes a packet for any of its own addresses on any interface, and
# docker's DNAT for that published port matches anything not from the
# shells' own bridge, so 10.250.14.1:7850 would answer the LAN too. A drop
# for it from anywhere but br-canopy-crd and loopback closes that, with an
# ACCEPT for loopback above it (iptables takes one -i per rule).
#
# The rules sit in the raw table's PREROUTING, which runs before routing,
# docker's DNAT and every filter chain, so they cover the host's own
# addresses as well as forwarded traffic, and no filter chain's order
# (docker's, ufw's, tailscale's ts-forward) can get a packet past them. They
# match on the interface a packet arrived on, which nothing inside the
# container can change. Replies to the container's own connections arrive
# on the uplink or tailscale0, never on the bridge, so they pass.
# Container-to-container traffic on each bridge is dropped too (10.0.0.0/8);
# stages and coord are each alone on their network and nothing needs it.
#
# Every rule goes in with -I, at the top, so the ACCEPT goes in after the
# drops, and --apply puts it back on top whenever it is not the first rule
# for its bridge (a drop that went missing comes back in above it). The
# loopback ACCEPT is kept above the gateway's drop the same way.
#
# Usage: stages-fence.sh [--apply | --install]
#   (none)     print the rules, in the order they go in
#   --apply    insert the ones that are missing (root); a rerun changes
#              nothing
#   --install  write a root-owned copy of this script to
#              /usr/local/sbin/canopy-stages-fence and a systemd unit that
#              runs its --apply before docker starts (and whenever docker
#              starts), enable it and run it now (root)
#
# From the checkout, CANOPY_FENCE_IPTABLES, CANOPY_FENCE_IP6TABLES,
# CANOPY_FENCE_SYSTEMCTL and CANOPY_FENCE_ROOT point the script at stand-ins
# and a fixture root, for its tests. Only a file named stages-fence.sh with
# CHECKOUT=1 reads them: the installed copy has CHECKOUT=0, and any other
# name (the root-owned canopy-stages-fence.new the deploy docs install
# from) runs the real tools on the real paths.
set -eu

# --install writes 0 here in the installed copy
CHECKOUT=1
case ${0##*/} in
  stages-fence.sh) ;;
  *) CHECKOUT=0 ;;
esac

BRIDGE=br-canopy-stg
COORD_BRIDGE=br-canopy-crd
COPY=/usr/local/sbin/canopy-stages-fence
UNIT_NAME=canopy-stages-fence.service
UNIT=/etc/systemd/system/$UNIT_NAME

if [ "$CHECKOUT" = 1 ]; then
  IPT=${CANOPY_FENCE_IPTABLES:-iptables}
  IP6T=${CANOPY_FENCE_IP6TABLES:-ip6tables}
  SYSTEMCTL=${CANOPY_FENCE_SYSTEMCTL:-systemctl}
  ROOT=${CANOPY_FENCE_ROOT:-}
else
  IPT=iptables
  IP6T=ip6tables
  SYSTEMCTL=systemctl
  ROOT=
fi

# the v4 drops for the bridge $1
drops() {
  printf '%s\n' \
    "-i $1 -d 10.0.0.0/8 -j DROP" \
    "-i $1 -d 172.16.0.0/12 -j DROP" \
    "-i $1 -d 192.168.0.0/16 -j DROP" \
    "-i $1 -d 100.64.0.0/10 -j DROP" \
    "-i $1 -d 169.254.0.0/16 -j DROP" \
    "-i $1 -d 224.0.0.0/4 -j DROP" \
    "-i $1 -d 255.255.255.255/32 -j DROP" \
    "-i $1 -d 0.0.0.0/8 -j DROP"
}
V4=$(drops "$BRIDGE")
COORD_V4=$(drops "$COORD_BRIDGE")
# canopy's port on the coordinator bridge's gateway, and nothing else there
COORD_ACCEPT="-i $COORD_BRIDGE -d 10.250.14.1/32 -p tcp --dport 7850 -j ACCEPT"
# that port from anywhere else but loopback, the LAN and tailnet included
GW_DROP="! -i $COORD_BRIDGE -d 10.250.14.1/32 -p tcp --dport 7850 -j DROP"
LO_ACCEPT="-i lo -d 10.250.14.1/32 -p tcp --dport 7850 -j ACCEPT"
V6="-i $BRIDGE -j DROP
-i $COORD_BRIDGE -j DROP"

die() { printf 'stages-fence: %s\n' "$*" >&2; exit 1; }

mode=print
for a in "$@"; do
  case $a in
    --apply) mode=apply ;;
    --install) mode=install ;;
    *) printf 'usage: %s [--apply | --install]\n' "$0" >&2; exit 2 ;;
  esac
done

printf '%s\n%s\n%s\n%s\n%s\n' "$V4" "$COORD_V4" "$COORD_ACCEPT" "$GW_DROP" "$LO_ACCEPT" | sed 's/^/iptables -t raw -I PREROUTING /'
printf '%s\n' "$V6" | sed 's/^/ip6tables -t raw -I PREROUTING /'

# insert each rule of $2 with the command $1 unless it is already there
ensure() {
  while IFS= read -r r; do
    # word splitting is the point: each line is one rule's arguments
    # shellcheck disable=SC2086
    $1 -t raw -C PREROUTING $r 2>/dev/null || $1 -t raw -I PREROUTING $r
  done <<EOF
$2
EOF
}

# The ACCEPT must be the first rule for the coordinator's bridge, or a drop
# above it (10.0.0.0/8) takes canopy's port too. iptables -S prints the
# chain top first; a rule's words may come in another order there (-d ahead
# of -i) and gain an -m tcp, so the first line for the bridge is matched by
# its parts. Unless it is the ACCEPT, every copy of the ACCEPT goes and one
# goes back in on top.
accept_on_top() {
  first=$($IPT -t raw -S PREROUTING | grep -F -- " -i $COORD_BRIDGE " | grep -vF -- "! -i $COORD_BRIDGE " | head -n 1)
  case $first in
    *"-d 10.250.14.1/32"*"--dport 7850"*"-j ACCEPT"*) return 0 ;;
  esac
  # shellcheck disable=SC2086
  while $IPT -t raw -C PREROUTING $COORD_ACCEPT 2>/dev/null; do
    $IPT -t raw -D PREROUTING $COORD_ACCEPT
  done
  # shellcheck disable=SC2086
  $IPT -t raw -I PREROUTING $COORD_ACCEPT
}

# The loopback ACCEPT must sit above the gateway's drop, or the drop takes
# loopback too. Of the rules for 10.250.14.1 that are not the bridge's own
# (the drop's "! -i" and the ACCEPT's "-i lo"), the first must be the
# ACCEPT; otherwise every copy of it goes and one goes back in on top.
lo_above_drop() {
  first=$($IPT -t raw -S PREROUTING | grep -F -- "-d 10.250.14.1/32 " | grep -F -e "! -i $COORD_BRIDGE " -e " -i lo " | head -n 1)
  case $first in
    *" -i lo "*"--dport 7850"*"-j ACCEPT"*) return 0 ;;
  esac
  # shellcheck disable=SC2086
  while $IPT -t raw -C PREROUTING $LO_ACCEPT 2>/dev/null; do
    $IPT -t raw -D PREROUTING $LO_ACCEPT
  done
  # shellcheck disable=SC2086
  $IPT -t raw -I PREROUTING $LO_ACCEPT
}

unit() {
  cat <<EOF
[Unit]
Description=Fence the canopy stages and coordinator bridges ($BRIDGE, $COORD_BRIDGE) in the raw table
Before=docker.service

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=$COPY --apply

[Install]
WantedBy=multi-user.target
WantedBy=docker.service
EOF
}

# write $2 from stdin through a temp file beside it, mode $1
put() {
  t=$(mktemp "$2.XXXXXX")
  cat >"$t"
  chmod "$1" "$t"
  [ -n "$ROOT" ] || chown root:root "$t"
  mv "$t" "$2"
}

case $mode in
  apply)
    ensure "$IPT" "$V4"
    ensure "$IPT" "$COORD_V4"
    accept_on_top
    ensure "$IPT" "$GW_DROP"
    lo_above_drop
    ensure "$IP6T" "$V6"
    echo "applied"
    ;;
  install)
    [ -n "$ROOT" ] || [ "$(id -u)" = 0 ] || die "--install needs root"
    mkdir -p "$ROOT${COPY%/*}" "$ROOT${UNIT%/*}"
    # the copy is this file as read now, so read it before running this
    sed 's/^CHECKOUT=1$/CHECKOUT=0/' "$0" | put 0755 "$ROOT$COPY"
    grep -qx 'CHECKOUT=0' "$ROOT$COPY" || die "the copy at $ROOT$COPY did not get CHECKOUT=0"
    unit | put 0644 "$ROOT$UNIT"
    "$SYSTEMCTL" daemon-reload
    "$SYSTEMCTL" enable --now "$UNIT_NAME"
    # enable --now leaves a unit that already ran alone; this runs the new
    # copy's --apply now
    "$SYSTEMCTL" restart "$UNIT_NAME"
    echo "installed $COPY and $UNIT"
    ;;
esac
