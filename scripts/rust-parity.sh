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
# Help: every verb's --help, and help <verb>, read from the same help.ts.
#
# The backend verbs (note, awake, issues, pr, prs, scenarios, sweep, kit,
# loadouts, groups, work, land, queue, collisions, people, clip, clips,
# worktrees) talk to a scratch Bun
# server this script starts on a free port with its own config dir and
# HOME, and to nothing else: CANOPY_API, CANOPY_TOKEN and CANOPY_BACKEND
# are cleared first, so a canopy shell's settings never point either CLI at
# a real backend. Before it starts, the script seeds that config dir and
# HOME with things to list: a scratch repo with one command scenario,
# kit.json's loadouts, two work items, a finished group and a ready run
# whose repo does not exist. Only calls that change nothing outside that
# server run: notes and work notes on its own store, keep awake's status
# (never a new mode), a scenario that runs `true` in the scratch repo, a
# sweep with nothing to close, and pr, land and group picks with ids that
# do not exist or a run the server cannot land. Nothing starts a run, a
# coordinator or an incubator stage. A note's id, which each side mints,
# is masked.
#
# people, clip and worktrees change that server (CANOPY_LOOPBACK_AUTH=1
# makes both CLIs its owner there). Each such step either answers the same
# when run twice (a role, a team, a pin set again, a tree's following
# switched again), or works on an object of its own side (@side in an
# argument is side-ts or side-rs, masked in the output), or runs after the
# TypeScript CLI cleared the way (clip clear, worktrees clean), so both
# find nothing. The TypeScript CLI seeds a team, two people, the clips to
# pin and drop, and three kept trees on the scratch repo; the people's
# ids, invite codes and times, side clips' ids and free disk are masked.
# Clips stay on the server's own store (CANOPY_TAILCHAN_URL=off), and no
# tree is made or removed outside its scratch config dir.
#
# Both run against a scratch config dir, so nothing under ~/.config/canopy
# is read or written.
#
#   bash scripts/rust-parity.sh [folder]   (default: this checkout's parent)
#
# CANOPY_PARITY_KEEP=1 keeps the scratch dir, with each step's two outputs
# (ts.<name>, rs.<name>), and says where it is.
set -euo pipefail
unset CANOPY_API CANOPY_TOKEN CANOPY_BACKEND
here=$(cd "$(dirname "$0")/.." && pwd)
dir=${1:-$(dirname "$here")}
scratch=$(mktemp -d)
server=""
cleanup() {
  if [ -n "$server" ]; then kill "$server" 2>/dev/null || true; fi
  if [ -n "${CANOPY_PARITY_KEEP:-}" ]; then
    echo "kept: $scratch"
  else
    rm -rf "$scratch"
  fi
}
trap cleanup EXIT
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

# ---- help, for every verb index.ts knows ----

check help help
check help-bare --help
verbs=$(awk '/export const COMMANDS = new Set\(\[/{f=1;next} f&&/\]\);/{exit} f' "$here/src/cli/index.ts" | grep -o '"[^"]*"' | tr -d '"')
for v in $verbs; do
  check "help-of-$v" "$v" --help
  check "help-for-$v" help "$v"
done

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

# ---- the backend verbs, against a scratch server ----

bun=$(command -v bun)
port=$("$bun" -e 'const s = Bun.serve({ port: 0, fetch: () => new Response() }); console.log(s.port); s.stop(true);')
mkdir -p "$scratch/server/root" "$scratch/server/home"
# Something for the listing verbs to print: a repo with one commit for the
# scenarios, kit.json's loadouts, two work items (one closed, so the hub
# never moves it), and a finished best-of-N group with its member's run.
# Nothing here is live, so the server starts no run, gate or landing.
seed=$scratch/server/config
git init -q -b main "$scratch/server/root/app"
git -C "$scratch/server/root/app" commit -q --allow-empty -m first
mkdir -p "$scratch/server/home/.claude" "$seed/work" "$seed/landing/groups" "$seed/landing/runs"
cat >"$seed/landing/runs/o-1.json" <<'JSON'
{"id": "o-1", "group": "g-0123abcd", "runId": "run-1", "repoId": "app", "repoPath": "/nowhere/app",
 "branch": "run/try-both-1", "target": "main", "base": "b0", "dir": "/nowhere/w1", "note": "try both",
 "verb": "ask", "harness": "claude", "state": "ready", "startedAt": 1764300000000,
 "review": {"verdict": "approve", "sensitiveId": "abc123", "base": "b0b0b0b0b0b0b0", "head": "h1h1h1h1h1h1h1", "at": 1,
            "files": [{"path": "README.md", "cls": "docs"}, {"path": "scripts/go.sh", "cls": "logic", "sensitive": "matches scripts/**"}]}}
JSON
cat >"$scratch/server/home/.claude/kit.json" <<'JSON'
{"version": 1, "targets": [{"agent": "claude", "skills": "~/.claude/skills", "mode": "store"}],
 "loadoutBase": {"skills": ["verify-build"]},
 "loadouts": {"docs": {"note": "quick docs", "harness": "claude", "model": "haiku", "effort": "low"},
              "deep": {"harness": "claude", "model": "opus", "effort": "high", "skills": ["a", "b"]}},
 "defaults": {"loadout": "docs", "repos": {"app": "deep"}}}
JSON
cat >"$seed/work/w-abcdefg2.json" <<'JSON'
{"id": "w-abcdefg2", "title": "Tidy the readme", "repos": ["app"], "state": "open", "from": {"kind": "note"},
 "runs": [], "branches": [], "prs": [], "events": [],
 "notes": [{"at": 1764300000000, "by": "eric", "text": "start with the install steps"}],
 "createdAt": 1764300000000, "updatedAt": 1764300000000}
JSON
cat >"$seed/work/w-hijklmn3.json" <<'JSON'
{"id": "w-hijklmn3", "title": "Fix the login", "repos": ["app", "web/api"], "state": "landed",
 "from": {"kind": "issue", "service": "github", "key": "o/app#12"},
 "runs": ["r1"], "branches": ["run/w-hijklmn3-fix-login"], "prs": [{"number": 7, "url": "https://example.com/o/app/pull/7"}],
 "events": [], "notes": [], "createdAt": 1764300000000, "updatedAt": 1764303600000, "closedAt": 1764303600000}
JSON
cat >"$seed/landing/groups/g-0123abcd.json" <<'JSON'
{"id": "g-0123abcd", "repoId": "app", "repoPath": "/nowhere/app", "action": "ask", "note": "try both",
 "expectedMembers": 2, "members": [{"run": "run-1", "origin": "o-1", "profile": "fast"}, {"run": "run-2", "origin": "o-2", "profile": null}],
 "state": "picked", "autoLand": false, "winner": "o-1", "pickedBy": "eric", "startedAt": 1764300000000, "endedAt": 1764303600000}
JSON
env -i HOME="$scratch/server/home" PATH="$(dirname "$bun"):/usr/local/bin:/usr/bin:/bin" SHELL=/bin/bash LANG=C.UTF-8 \
  CANOPY_CONFIG_DIR="$scratch/server/config" CANOPY_LOOPBACK_AUTH=1 CANOPY_PREVIEW_PORTS=0 CANOPY_NO_DESKTOP=1 \
  CANOPY_AGENT_SCAN=0 CANOPY_TAILCHAN_URL=off CANOPY_TMUX=0 \
  "$bun" "$ts" ui "$scratch/server/root" --port "$port" --no-open >"$scratch/server.log" 2>&1 &
server=$!
for _ in $(seq 1 60); do
  if curl -sf -o /dev/null "http://127.0.0.1:$port/api/notes"; then break; fi
  sleep 0.5
done
if ! curl -sf -o /dev/null "http://127.0.0.1:$port/api/notes"; then
  echo "the scratch server did not come up:" >&2
  tail -20 "$scratch/server.log" >&2
  exit 1
fi
export CANOPY_API="http://127.0.0.1:$port"
down="http://127.0.0.1:1"
# a reminder months away, so its words hold still between the two runs and
# the backend never delivers it mid-check
at="$(($(date +%Y) + 1))-06-01 09:00"

# hcheck <name> <args...> - both CLIs against the scratch server, stdout and
# stderr kept apart, the note ids masked. An argument @id is the id that
# side's own `hcheck note-add` printed.
hcheck() {
  local name=$1 side out a code
  shift
  for side in ts rs; do
    local args=()
    for a in "$@"; do
      if [ "$a" = @id ]; then a=$(cat "$scratch/$side.id"); fi
      args+=("$a")
    done
    out="$scratch/$side.$name"
    if [ "$side" = ts ]; then
      bun "$ts" "${args[@]}" >"$out.1" 2>"$out.2" && code=0 || code=$?
    else
      "$rs" "${args[@]}" >"$out.1" 2>"$out.2" && code=0 || code=$?
    fi
    if [ "$name" = note-add ]; then awk 'NR==1{print $1}' "$out.1" >"$scratch/$side.id"; fi
    { cat "$out.1"; echo "--- stderr"; cat "$out.2"; echo "--- exit $code"; } >"$out"
  done
  sed -E -i.bak 's/n-[a-z2-7]{8}/<note>/g' "$scratch/ts.$name" "$scratch/rs.$name"
  same "$name" "$scratch/ts.$name" "$scratch/rs.$name" "$*"
}

hcheck notes-none note list
hcheck note-add note add "pick up  the
parts"
hcheck note-add-repo note add "call the bank" --at "$at" --repo nosuch
hcheck note-add-at note add "call the bank" --at "$at"
(export TZ=Asia/Tokyo && hcheck note-add-tokyo notes add "in tokyo" --at "$at")
hcheck notes note list
hcheck note-done note done @id
hcheck notes-all note list --all
hcheck note-delete note rm @id
hcheck note-add-usage note add
hcheck note-done-usage note done
hcheck note-list-usage note list --at "in 5m"
hcheck note-unknown note done n-zzzzzzzz
hcheck note-origin note list --backend http://x/y
hcheck note-down note list --backend "$down"
hcheck note-token note list --token bogus
hcheck awake awake
hcheck awake-status awake status --token bogus
hcheck awake-usage awake sometimes
hcheck awake-down awake --backend "$down"
hcheck issues issues
hcheck issues-repo issues web/none --needs-you
hcheck issues-usage issues a b
hcheck issues-down issues --backend "$down"
hcheck prs prs
hcheck prs-repo prs tally
hcheck prs-usage prs a b
hcheck pr-usage pr
hcheck pr-unknown pr nosuch-run --draft
hcheck pr-rebase-unknown pr rebase nosuch-run
hcheck pr-rebase-usage pr rebase
hcheck pr-down pr rebase x --backend "$down"

# scenarios: the one command scenario the TypeScript CLI files first, run
# against the scratch repo (a judge would ask a model, so there is none)
bun "$ts" scenarios app add checkout --run true >/dev/null
hcheck scenarios-usage scenarios
hcheck scenarios-list scenarios app
hcheck scenarios-none scenarios nosuch
hcheck scenarios-run scenarios app run
hcheck scenarios-bad scenarios app what
hcheck scenarios-run-flag scenarios app add n --run
hcheck scenarios-down scenarios app --backend "$down"
hcheck sweep sweep
hcheck sweep-yes sweep --yes --kind shell,chat
hcheck sweep-kind sweep --kind shell,nope
hcheck sweep-usage sweep extra
hcheck sweep-origin sweep --backend http://x/y
hcheck kit kit
hcheck kit-dry kit apply --dry-run
hcheck kit-usage kit what
hcheck kit-down kit --backend "$down"
hcheck loadouts loadouts
hcheck loadouts-json loadouts --json
hcheck loadouts-resolve loadouts resolve app
hcheck loadouts-resolve-json loadouts resolve app --action ask --json
hcheck loadouts-resolve-space loadouts resolve "my app"
hcheck loadouts-on loadouts --on nosuch
hcheck loadouts-either loadouts --backend "$CANOPY_API" --on x
hcheck loadouts-action loadouts --action ask
hcheck loadouts-adopt loadouts adopt nosuch
hcheck loadouts-down loadouts --backend "$down"
hcheck groups groups
hcheck groups-repo groups app
hcheck groups-other groups nosuch
hcheck groups-pick-unknown groups pick g-99999999 run-1
hcheck groups-pick-usage groups pick g-0123abcd
hcheck groups-on groups --on nosuch
hcheck groups-needs groups --backend
hcheck groups-down groups --backend "$down"
hcheck work work
hcheck work-open work list --state open --repo app
hcheck work-state work list --state lost
hcheck work-show work show w-hijklmn3
hcheck work-show-usage work show nope
hcheck work-unknown work show w-zzzzzzz2
hcheck work-export work export w-abcdefg2
hcheck work-note-branch work note "no id here"
hcheck work-note work note w-abcdefg2 "both CLIs wrote this"
hcheck work-close-usage work close w-abcdefg2
hcheck work-down work --backend "$down"
hcheck queue queue
hcheck queue-repo queue app
hcheck collisions collisions
hcheck collisions-repo collisions app
hcheck queue-usage queue a b
hcheck land-usage land
hcheck land-unknown land nosuch-run
hcheck land-all land --all nosuch
hcheck land-followup-usage land followup
hcheck land-down land x --backend "$down"
hcheck land-approve land run-1

# ---- people, clip and worktrees: steps that change the scratch server ----

# scheck <name> <args...> - hcheck for a step that changes something on the
# scratch server. An argument's @side becomes side-ts or side-rs, so each
# CLI makes and drops an object of its own, and that name is masked in the
# output; @clip is the clip id seeded for that side. stdin is $IN, else
# /dev/null, and $MASK, a sed expression, masks what each side mints.
scheck() {
  local name=$1 side out a code
  shift
  for side in ts rs; do
    local args=()
    for a in "$@"; do
      a=${a//@side/side-$side}
      if [ "$a" = @clip ]; then a=$(cat "$scratch/$side.clip"); fi
      args+=("$a")
    done
    out="$scratch/$side.$name"
    if [ "$side" = ts ]; then
      bun "$ts" "${args[@]}" <"${IN:-/dev/null}" >"$out.1" 2>"$out.2" && code=0 || code=$?
    else
      "$rs" "${args[@]}" <"${IN:-/dev/null}" >"$out.1" 2>"$out.2" && code=0 || code=$?
    fi
    { cat "$out.1"; echo "--- stderr"; cat "$out.2"; echo "--- exit $code"; } >"$out"
  done
  local masks=(-e 's/side-(ts|rs)/side-<x>/g')
  if [ -n "${MASK:-}" ]; then masks+=(-e "$MASK"); fi
  sed -E -i.bak "${masks[@]}" "$scratch/ts.$name" "$scratch/rs.$name"
  same "$name" "$scratch/ts.$name" "$scratch/rs.$name" "$*"
}

# people: the loopback caller is the owner. The TypeScript CLI files a team
# and two people first; a step run twice gives the same answer (a role, a
# team, off and on set again), or works on a person of its own side. An
# invite's code and time and a minted id are masked.
bun "$ts" people teams add Rio --folder "$scratch/server/root" >/dev/null
bun "$ts" people add Avery --team rio --no-invite >/dev/null
bun "$ts" people add Guest --role viewer --no-invite >/dev/null
ids='s/(p|t)-[a-z2-7]{8}/<id>/g'
hcheck people people
hcheck people-list people list
hcheck people-teams people teams
hcheck people-me people me
hcheck people-activity people activity --limit 5
hcheck people-role people role avery admin
hcheck people-role-back people role avery member
hcheck people-team people team avery none
hcheck people-team-back people team avery rio
hcheck people-rename people rename guest Guest
hcheck people-off people off guest
hcheck people-on people on guest
hcheck people-uninvite people uninvite guest
MASK='s/cnv_[A-Za-z0-9_-]+/<code>/g; s/until .*:$/until <when>:/' scheck people-invite people invite guest --hours 2
MASK=$ids scheck people-add people add Pat-@side --role viewer --no-invite
MASK="$ids; s/cnv_[A-Za-z0-9_-]+/<code>/g; s/until .*:$/until <when>:/" scheck people-add-invite people add Sam-@side --team Rio
scheck people-remove people remove Pat-@side
scheck people-remove-sam people rm Sam-@side
MASK=$ids scheck people-teams-add people teams add Crew-@side --folder /srv/crew
MASK=$ids scheck people-teams-set people teams set Crew-@side --folder /srv/a --folder /srv/b
scheck people-teams-rm people teams remove Crew-@side
hcheck people-usage people what
hcheck people-add-usage people add
hcheck people-add-role people add x --role boss
hcheck people-add-hours people add x --hours 0
hcheck people-add-team people add x --team nosuch
hcheck people-role-bad people role avery boss
hcheck people-nobody people role nobody viewer
hcheck people-teams-usage people teams set
hcheck people-activity-usage people activity x
hcheck people-origin people --backend http://x/y
hcheck people-down people --backend "$down"

# clip: the scratch server's own clipboard (CANOPY_TAILCHAN_URL=off keeps
# it there). The same text or file put twice is one clip moved to the top,
# so both sides print the same id; a clip to drop is seeded for each side,
# and clear runs once the TypeScript CLI has cleared, so both find nothing.
printf 'piped  text\nline two\n' >"$scratch/clip.txt"
printf '\x89PNG\r\n\x1a\n\x00\x00\x00\x0dIHDR' >"$scratch/clip.png"
printf '\x89PNG\r\n\x1a\n\x00\x00\x00\x0dIHDRshot' >"$scratch/shot.png"
hcheck clip-none clip list
pin=$(bun "$ts" clip put "pin me" | awk '{print $1}')
hcheck clip-put clip put "first  text"
hcheck clip-words clip git log -n 5 --json
hcheck clip-link clip put https://example.com/a
IN=$scratch/clip.txt scheck clip-stdin clip
IN=$scratch/clip.png scheck clip-stdin-file clip put
hcheck clip-file clip --file "$scratch/shot.png"
hcheck clip-file-missing clip --file "$scratch/nosuch.png"
hcheck clip-file-dir clip -f "$scratch/server"
hcheck clip-file-usage clip list --file "$scratch/shot.png"
hcheck clip-secret clip put ghp_abcdefghijklmnopqrstuvwxyz0123456789
hcheck clip-blank clip put "  "
hcheck clips clips list
hcheck clip-list clip list -n 3
hcheck clip-json clip ls -n 2 --json
hcheck clip-get clip get 4
hcheck clip-get-id clip get "$pin"
hcheck clip-get-file-o clip get 1 -o "$scratch/got/clip.png"
hcheck clip-get-text-o clip get 3 -o "$scratch/got/text.txt"
# a file's bytes to stdout as they are, compared with cmp, since sed reads text
bun "$ts" clip get 1 <"/dev/null" >"$scratch/ts.clip-raw"
"$rs" clip get 1 <"/dev/null" >"$scratch/rs.clip-raw"
if cmp "$scratch/ts.clip-raw" "$scratch/rs.clip-raw" && cmp "$scratch/ts.clip-raw" "$scratch/shot.png"; then
  echo "same (clip-get-raw): canopy clip get 1 ($(wc -c <"$scratch/ts.clip-raw" | tr -d ' ') bytes)"
else
  echo "differs (clip-get-raw): canopy clip get 1" >&2
  exit 1
fi
hcheck clip-get-none clip get 99
hcheck clip-get-usage clip get 1 2
hcheck clip-pin clip pin "$pin"
hcheck clip-unpin clip unpin "$pin"
hcheck clip-pin-again clip pin "$pin"
bun "$ts" clip put "drop side-ts" | awk '{print $1}' >"$scratch/ts.clip"
bun "$ts" clip put "drop side-rs" | awk '{print $1}' >"$scratch/rs.clip"
MASK='s/c-[a-z2-7]{8}/<clip>/g' scheck clip-rm clip rm @clip
hcheck clip-rm-unknown clip delete c-zzzzzzzz
hcheck clip-pin-usage clip pin
hcheck clip-n clip list -n 1.5
hcheck clip-on clip list --on nosuch
hcheck clip-origin clip --backend http://x/y
hcheck clip-down clip list --backend "$down"
hcheck clip-put-down clip put x --backend "$down"
hcheck clip-pin-down clip pin c-zzzzzzzz --backend "$down"
hcheck clip-file-down clip --file "$scratch/shot.png" --backend "$down"
# unpinned first, so the list after shows no row whose age could tick over
bun "$ts" clip unpin "$pin" >/dev/null
bun "$ts" clip clear >/dev/null
hcheck clip-clear clip clear
hcheck clip-clear-usage clip clear x
hcheck clip-after clip list

# worktrees: kept trees on the scratch repo only. The TypeScript CLI makes
# one to keep and one for each side to remove, and waits for them to be
# ready; clean runs last, once the TypeScript CLI has cleaned, so both find
# nothing. Free disk and the ports of the side trees are masked.
bun "$ts" worktrees add app feat/kept --no-caches >/dev/null
bun "$ts" worktrees add app feat/side-ts --no-caches >/dev/null
bun "$ts" worktrees add app feat/side-rs --no-caches >/dev/null
for _ in $(seq 1 60); do
  trees=$(bun "$ts" worktrees app)
  case $trees in *preparing*) sleep 0.5 ;; *) break ;; esac
done
free='s/^free [0-9.,]+ (GB|MB) under/free <n> under/; s/"free": [0-9.e+]+/"free": <n>/'
MASK=$free scheck worktrees worktrees
MASK=$free scheck worktrees-repo worktrees app
MASK=$free scheck worktrees-path-form worktrees "$scratch/server/root/app"
MASK=$free scheck worktrees-json worktrees --json
hcheck worktrees-path worktrees path app feat/kept
hcheck worktrees-path-none worktrees path app nope
hcheck worktrees-auto-off worktrees auto app feat/kept off
hcheck worktrees-auto-on worktrees auto app feat/kept on
hcheck worktrees-sync worktrees sync app feat/kept
hcheck worktrees-add-twin worktrees add app feat/kept --no-caches
hcheck worktrees-add-none worktrees add nosuch feat/x
scheck worktrees-rm worktrees rm app feat/@side --delete-branch
hcheck worktrees-rm-none worktrees rm app nosuch
hcheck worktrees-merge-none worktrees merge app nosuch --no-squash
hcheck worktrees-warm worktrees warm app
hcheck worktrees-warm-0 worktrees warm app 0
hcheck worktrees-warm-bad worktrees warm app 3
hcheck worktrees-prune worktrees prune
hcheck worktrees-prune-repo worktrees prune app
hcheck worktrees-start worktrees start app nosuch
hcheck worktrees-stop worktrees stop app nosuch dev
hcheck worktrees-start-usage worktrees start app x --json
hcheck worktrees-shell-init worktrees shell-init
hcheck worktrees-shell-init-usage worktrees shell-init x
hcheck worktrees-usage worktrees app extra
hcheck worktrees-backend worktrees --backend
hcheck worktrees-origin worktrees --backend http://x/y
hcheck worktrees-down worktrees --backend "$down"
bun "$ts" worktrees clean >/dev/null
hcheck worktrees-clean worktrees clean
hcheck worktrees-clean-repo worktrees clean app
MASK=$free scheck worktrees-after worktrees
