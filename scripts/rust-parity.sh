#!/usr/bin/env bash
# Runs the TypeScript CLI and the Rust port (canopy-rs) side by side and
# diffs what they print. Exits 1 on the first difference.
#
# The read verbs (tree, status, the bare form, version) run on the same
# folder and only read it. The last column of the tree, how long ago the
# newest commit was, is masked: a scan of a big folder takes long enough
# for it to tick over between the two runs (treelines tests cover it).
#
# The git verbs (commit, push, pull) never touch a real repo: each CLI gets
# its own copy of the same scratch repos (a bare origin and clones of it),
# built with pinned names and dates so their commit hashes match, and each
# step runs on both copies in turn, the scratch path masked.
#
# Both run against a scratch config dir, so nothing under ~/.config/canopy
# is read or written.
#
#   bash scripts/rust-parity.sh [folder]   (default: this checkout's parent)
#
# CANOPY_PARITY_KEEP=1 keeps the scratch dir, with each step's two outputs
# (ts.<name>, rs.<name>), and says where it is.
set -euo pipefail
here=$(cd "$(dirname "$0")/.." && pwd)
dir=${1:-$(dirname "$here")}
scratch=$(mktemp -d)
if [ -n "${CANOPY_PARITY_KEEP:-}" ]; then
  trap 'echo "kept: $scratch"' EXIT
else
  trap 'rm -rf "$scratch"' EXIT
fi
real=$(cd "$scratch" && pwd -P)
export CANOPY_CONFIG_DIR="$scratch/config" NO_COLOR=1

(cd "$here/rust" && cargo build -q -p canopy-cli)
rs="$here/rust/target/debug/canopy-rs"
ts="$here/bin/canopy.ts"

# same: <name> <ts.out> <rs.out> <what> - diff two outputs, the scratch
# copies' paths and the tree's last column masked
same() {
  local name=$1 a=$2 b=$3 what=$4
  sed -E -i.bak -e "s#($real|$scratch)/(ts|rs)#<root>#g" -e 's/ [0-9]+(m|h|d|mo)$/ <ago>/' "$a" "$b"
  if diff -u "$a" "$b"; then
    echo "same ($name): canopy $what ($(wc -l <"$a" | tr -d ' ') lines)"
  else
    echo "differs ($name): canopy $what" >&2
    exit 1
  fi
}

# check <name> <args...> - both CLIs, the same folder
check() {
  local name=$1
  shift
  bun "$ts" "$@" >"$scratch/ts.$name" 2>&1 || echo "exit $?" >>"$scratch/ts.$name"
  "$rs" "$@" >"$scratch/rs.$name" 2>&1 || echo "exit $?" >>"$scratch/rs.$name"
  same "$name" "$scratch/ts.$name" "$scratch/rs.$name" "$*"
}

check tree tree "$dir"
check status status "$dir"
check bare "$dir"
check version --version
check missing tree "$scratch/no-such-folder"

# ---- the git verbs, on scratch repos ----

export GIT_CONFIG_GLOBAL="$scratch/gitconfig" GIT_CONFIG_NOSYSTEM=1
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t.invalid GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t.invalid
export GIT_AUTHOR_DATE="2026-01-01T00:00:00Z" GIT_COMMITTER_DATE="2026-01-01T00:00:00Z"
printf '[init]\n\tdefaultBranch = main\n[advice]\n\tdetachedHead = false\n' >"$GIT_CONFIG_GLOBAL"
mkdir "$scratch/ts" "$scratch/rs"

# both <shell> - the same change to each copy, run from its root
both() {
  local side
  for side in ts rs; do
    (cd "$scratch/$side" && eval "$1")
  done
}

# gcheck <name> <args...> - each CLI on its own copy, from its root, so the
# repo arguments read the same; stdout and stderr kept apart
gcheck() {
  local name=$1 side out
  shift
  for side in ts rs; do
    out="$scratch/$side.$name"
    if [ "$side" = ts ]; then
      (cd "$scratch/ts" && bun "$ts" "$@") >"$out.1" 2>"$out.2" && code=0 || code=$?
    else
      (cd "$scratch/rs" && "$rs" "$@") >"$out.1" 2>"$out.2" && code=0 || code=$?
    fi
    { cat "$out.1"; echo "--- stderr"; cat "$out.2"; echo "--- exit $code"; } >"$out"
  done
  same "$name" "$scratch/ts.$name" "$scratch/rs.$name" "$*"
}

both 'git init -q --bare origin.git
  git init -q seed && printf "a\nb\nc\n" >seed/f.txt && git -C seed add f.txt && git -C seed commit -q -m base
  git -C seed push -q ../origin.git main
  git clone -q origin.git work && git clone -q origin.git writer
  git init -q lonely && echo x >lonely/x && git -C lonely add x && git -C lonely commit -q -m one
  git clone -q origin.git detached && git -C detached checkout -q --detach'

gcheck commit-usage commit
gcheck commit-no-message commit work
gcheck commit-nothing-staged commit work -m "nothing yet"
gcheck commit-missing commit nosuch -m x
both 'echo g >work/g.txt'
gcheck commit-all commit work --all -m "add g"
gcheck push-ff push work
gcheck push-usage push
gcheck push-missing push nosuch
gcheck push-no-remote push lonely
gcheck push-detached push detached
both 'git -C writer pull -q && echo w >writer/w.txt && git -C writer add w.txt && git -C writer commit -q -m "writer w" && git -C writer push -q'
both 'echo h >work/h.txt && git -C work add h.txt'
gcheck commit-push commit work -m "add h" --push
gcheck pull-usage pull
both 'git -C writer pull -q && echo w2 >>writer/w.txt && git -C writer commit -qam "writer w2" && git -C writer push -q'
gcheck pull-ff pull work
both 'git -C writer pull -q && echo w3 >>writer/w.txt && git -C writer commit -qam "writer w3" && git -C writer push -q && touch work/.git/index.lock'
gcheck pull-locked pull work
both 'rm work/.git/index.lock && git -C work pull -q'

# the atlas case (FR-048): work takes "fix nav" from mac as a peer would,
# mac amends it and pushes the amend, and work has a commit of its own after
both 'git clone -q origin.git mac && printf "a\nb\nnew line\nc\n" >mac/f.txt && git -C mac commit -qam "fix nav"
  git -C work fetch -q ../mac main && git -C work merge -q --ff-only FETCH_HEAD
  printf "a\nb\nnew line\nanother\nc\n" >mac/f.txt && git -C mac commit -qa --amend --no-edit && git -C mac push -q
  echo k >work/k.txt && git -C work add k.txt && git -C work commit -q -m "work after"'
gcheck push-stale push work
gcheck push-drop-stale push work --drop-stale
