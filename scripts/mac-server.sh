#!/bin/sh
# What the Mac's launchd agent (ca.beric.canopy-server) runs, so the server's
# keys stay out of the plist. A plist is copied whole at every edit and read
# out whole by `plutil -p` and `launchctl print`, keys included. They sit in
# one 600 file instead, the credentials bundle, as a map of environment names:
#
#   "providers": { "canopy": { "env": { "CANOPY_VOICE_KEY": "...", ... } } }
#
# Every CANOPY_ name there with text for a value is exported, then bun takes
# this process over, so launchd still watches the server itself. The
# arguments go to canopy as given (`ui ~/dev --port 7850 --no-open`). With no
# file, no jq or no map the server starts without the keys and says what
# that turns off. The log gets the names that were loaded, never a value.
#
#   CANOPY_KEYS_FILE  the file, default ~/.claude/credentials/.credentials.json
set -eu

ROOT=$(cd "$(dirname "$0")/.." && pwd)
KEYS=${CANOPY_KEYS_FILE:-$HOME/.claude/credentials/.credentials.json}

exports=""
if [ -r "$KEYS" ] && command -v jq >/dev/null 2>&1; then
  # @sh quotes each value for the eval below. The name test is what keeps a
  # key of the map from becoming shell words.
  exports=$(jq -r '(.providers.canopy.env // {}) | to_entries[]
    | select((.key | test("^CANOPY_[A-Z0-9_]+$")) and (.value | type == "string"))
    | "export \(.key)=\(.value | @sh)"' "$KEYS" 2>/dev/null) || exports=""
fi
if [ -n "$exports" ]; then
  eval "$exports"
  names=$(printf '%s\n' "$exports" | sed -n 's/^export \(CANOPY_[A-Z0-9_]*\)=.*/\1/p' | tr '\n' ' ')
  printf 'mac-server: from %s: %s\n' "$KEYS" "${names% }" >&2
fi

exec bun run "$ROOT/bin/canopy.ts" "$@"
