#!/bin/sh
# Fences the stages network: every packet that comes in on its bridge
# (br-canopy-stg, named in docker-compose.yml) for a private, tailnet,
# link-local, multicast, broadcast or 0.0.0.0/8 address is dropped, and the
# internet stays open; every IPv6 packet from it is dropped.
#
# The drops sit in the raw table's PREROUTING, which runs before routing,
# docker's DNAT and every filter chain, so they cover the host's own
# addresses as well as forwarded traffic, and no filter chain's order
# (docker's, ufw's, tailscale's ts-forward) can get a packet past them. They
# match on the interface a packet arrived on, which nothing inside the
# container can change. Replies to the container's own connections arrive
# on the uplink or tailscale0, never on the bridge, so they pass.
# Container-to-container traffic on the bridge is dropped too (10.0.0.0/8);
# stages is alone on its network and nothing needs it.
#
# Usage: stages-fence.sh [--apply | --install]
#   (none)     print the rules
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

V4="-i $BRIDGE -d 10.0.0.0/8 -j DROP
-i $BRIDGE -d 172.16.0.0/12 -j DROP
-i $BRIDGE -d 192.168.0.0/16 -j DROP
-i $BRIDGE -d 100.64.0.0/10 -j DROP
-i $BRIDGE -d 169.254.0.0/16 -j DROP
-i $BRIDGE -d 224.0.0.0/4 -j DROP
-i $BRIDGE -d 255.255.255.255/32 -j DROP
-i $BRIDGE -d 0.0.0.0/8 -j DROP"
V6="-i $BRIDGE -j DROP"

die() { printf 'stages-fence: %s\n' "$*" >&2; exit 1; }

mode=print
for a in "$@"; do
  case $a in
    --apply) mode=apply ;;
    --install) mode=install ;;
    *) printf 'usage: %s [--apply | --install]\n' "$0" >&2; exit 2 ;;
  esac
done

printf '%s\n' "$V4" | sed 's/^/iptables -t raw -I PREROUTING /'
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

unit() {
  cat <<EOF
[Unit]
Description=Fence the canopy stages bridge ($BRIDGE) in the raw table
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
