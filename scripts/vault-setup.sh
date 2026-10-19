#!/usr/bin/env bash
# One-time setup, run inside the shells container, so a canopy shell can read
# and write the memory vault: takes a gateway token on stdin, keeps it at
# /config/vault/token (0600), and writes the config the shells' `vault` reads
# (VAULT_CONFIG in docker-compose.yml). The token is never an argument, so it
# stays out of ps and shell history. Safe to run again: a new token replaces
# the old one.
#
# The token is one of its own with the agent scope (everything but
# 06 - Personal/ and the raw history, and no writes to the archive). Issue it
# where an owner token lives and pipe it straight in; docs/deploy.md, "The
# memory vault", has the line.
set -euo pipefail

dir=/config/vault
gateway=${VAULT_GATEWAY:-https://mem.beric.ca}

[ -d /config ] && [ -w /config ] || { echo "run this in the shells container, where /config is canopy's config volume" >&2; exit 1; }
[ "${VAULT_CONFIG:-}" = "$dir/config.json" ] && command -v vault >/dev/null || { echo "this shells container predates vault: bun run redeploy --shells, then run this again" >&2; exit 1; }
[ -t 0 ] && { echo "pipe the token in: ... | $0" >&2; exit 1; }

token=$(tr -d '[:space:]')
[ -n "$token" ] || { echo "no token on stdin" >&2; exit 1; }

mkdir -p "$dir" && chmod 700 "$dir"
umask 077
printf '%s\n' "$token" >"$dir/token.tmp" && mv "$dir/token.tmp" "$dir/token"
printf '{\n  "gateway": "%s",\n  "tokenFile": "%s/token"\n}\n' "$gateway" "$dir" >"$dir/config.json.tmp" && mv "$dir/config.json.tmp" "$dir/config.json"
echo "vault config written to $dir/config.json"

# the first pull proves the token; a refused one exits 1 and says so
vault pull
vault status
