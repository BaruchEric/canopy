#!/usr/bin/env bash
# Runs the TypeScript CLI and the Rust port (canopy-rs) on the same folder
# and diffs what they print: the tree, status and version. Read-only: both
# run against a scratch config dir, so nothing under ~/.config/canopy is
# read or written. Exits 1 on the first difference. The last column, how
# long ago the newest commit was, is masked: a scan of a big folder takes
# long enough for it to tick over between the two runs (treelines tests
# cover it).
#
#   bash scripts/rust-parity.sh [folder]   (default: this checkout's parent)
set -euo pipefail
here=$(cd "$(dirname "$0")/.." && pwd)
dir=${1:-$(dirname "$here")}
scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT
export CANOPY_CONFIG_DIR="$scratch/config" NO_COLOR=1

(cd "$here/rust" && cargo build -q -p canopy-cli)
rs="$here/rust/target/debug/canopy-rs"

check() {
  local name=$1
  shift
  bun "$here/bin/canopy.ts" "$@" >"$scratch/ts.$name" 2>&1 || echo "exit $?" >>"$scratch/ts.$name"
  "$rs" "$@" >"$scratch/rs.$name" 2>&1 || echo "exit $?" >>"$scratch/rs.$name"
  sed -E -i.bak 's/ [0-9]+(m|h|d|mo)$/ <ago>/' "$scratch/ts.$name" "$scratch/rs.$name"
  if diff -u "$scratch/ts.$name" "$scratch/rs.$name"; then
    echo "same: canopy $* ($(wc -l <"$scratch/ts.$name" | tr -d ' ') lines)"
  else
    echo "differs: canopy $*" >&2
    exit 1
  fi
}

check tree tree "$dir"
check status status "$dir"
check bare "$dir"
check version --version
check missing tree "$scratch/no-such-folder"
