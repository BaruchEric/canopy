#!/bin/sh
# Fences the stages network (10.250.13.0/24): no private, tailnet or
# link-local address, the internet open. DOCKER-USER covers forwarded
# traffic. Traffic to the host itself is INPUT, which ufw's default deny
# incoming already refuses for this subnet, since ufw lets only
# 172.16.0.0/12 docker nets in. Docker's embedded DNS answers at 127.0.0.11
# inside the container's own namespace, so it is never forwarded and the
# 10.0.0.0/8 drop cannot reach it.
#
# Usage: stages-fence.sh [--apply] [--persist]
#   (none)     print the rules
#   --apply    install the ones missing from DOCKER-USER (root); a rerun
#              changes nothing
#   --persist  write them into ufw's after.rules as a marked block (root),
#              replacing the block a run before wrote; then `ufw reload`
#
# CANOPY_FENCE_IPTABLES and CANOPY_FENCE_AFTER_RULES point the script at a
# stand-in iptables and after.rules, for its tests.
set -eu
NET=10.250.13.0/24
IPT=${CANOPY_FENCE_IPTABLES:-iptables}
AFTER=${CANOPY_FENCE_AFTER_RULES:-/etc/ufw/after.rules}
BEGIN='# canopy-stages begin'
END='# canopy-stages end'

# The rules, in the order -I inserts them. -I puts each on top, so the last
# one listed ends up first: replies to connections the container opened go
# through before any drop.
RETURN_RULE="-s $NET -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN"
RULES="-s $NET -d 10.0.0.0/8 -j DROP
-s $NET -d 172.16.0.0/12 -j DROP
-s $NET -d 192.168.0.0/16 -j DROP
-s $NET -d 100.64.0.0/10 -j DROP
-s $NET -d 169.254.0.0/16 -j DROP
$RETURN_RULE"

die() { printf 'stages-fence: %s\n' "$*" >&2; exit 1; }

apply=0 persist=0
for a in "$@"; do
  case $a in
    --apply) apply=1 ;;
    --persist) persist=1 ;;
    *) printf 'usage: %s [--apply] [--persist]\n' "$0" >&2; exit 2 ;;
  esac
done

printf '%s\n' "$RULES" | sed 's/^/-I DOCKER-USER /'

# The block for after.rules: the same rules appended, so in reverse, which
# leaves them in the order the inserts give.
block() {
  printf '%s\n*filter\n:DOCKER-USER - [0:0]\n' "$BEGIN"
  printf '%s\n' "$RULES" | awk '{ l[NR] = $0 } END { for (i = NR; i > 0; i--) print "-A DOCKER-USER " l[i] }'
  printf 'COMMIT\n%s\n' "$END"
}

if [ $apply = 1 ]; then
  # a rule already there is left alone; when a drop had to go back in on
  # top, the RETURN is moved back above it
  moved=0
  while IFS= read -r r; do
    # word splitting is the point: each line is one rule's arguments
    # shellcheck disable=SC2086
    if $IPT -C DOCKER-USER $r 2>/dev/null; then
      if [ "$r" = "$RETURN_RULE" ] && [ $moved = 1 ]; then
        # shellcheck disable=SC2086
        $IPT -D DOCKER-USER $r
        # shellcheck disable=SC2086
        $IPT -I DOCKER-USER $r
      fi
    else
      # shellcheck disable=SC2086
      $IPT -I DOCKER-USER $r
      moved=1
    fi
  done <<EOF
$RULES
EOF
  if command -v ufw >/dev/null 2>&1; then
    ufw status | grep -q "Status: active" || echo "warning: ufw is not active; container-to-host traffic is not refused"
  else
    echo "warning: no ufw here; container-to-host traffic is not refused"
  fi
  echo "applied"
  [ $persist = 1 ] || echo "they last until the next reboot or ufw reload; --persist keeps them"
fi

if [ $persist = 1 ]; then
  [ -f "$AFTER" ] || die "no $AFTER; is ufw installed?"
  # one well-formed block or none: a begin with no end would take the rest
  # of ufw's file with it
  awk -v b="$BEGIN" -v e="$END" '
    $0 == b { if (inb || seen) bad = 1; inb = 1; seen = 1; next }
    $0 == e { if (!inb) bad = 1; inb = 0; next }
    END { exit (bad || inb) ? 1 : 0 }
  ' "$AFTER" || die "$AFTER has a broken canopy-stages block (a begin without its end, or two); fix it by hand"
  blk=$(mktemp "$AFTER.XXXXXX")
  tmp=$(mktemp "$AFTER.XXXXXX")
  trap 'rm -f "$blk" "$tmp"' EXIT
  block >"$blk"
  # the temp file takes the original's mode, so the rename keeps it
  cp -p "$AFTER" "$tmp"
  awk -v b="$BEGIN" -v e="$END" -v bf="$blk" '
    BEGIN { while ((getline l < bf) > 0) blk = blk l "\n" }
    $0 == b { printf "%s", blk; skip = 1; done = 1; next }
    skip && $0 == e { skip = 0; next }
    skip { next }
    { print }
    END { if (!done) printf "\n%s", blk }
  ' "$AFTER" >"$tmp"
  cp -p "$AFTER" "$AFTER.canopy-stages.bak"
  mv "$tmp" "$AFTER"
  echo "persisted in $AFTER (the old file is $AFTER.canopy-stages.bak); now: ufw reload"
fi
