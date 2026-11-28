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
# loadouts, groups, work, land, queue, collisions, floorplan, archify,
# diagnosis, understand) talk to a scratch Bun server this script starts on
# a free port with its own config dir and HOME, and to nothing else:
# CANOPY_API, CANOPY_TOKEN and CANOPY_BACKEND are cleared first, so a
# canopy shell's settings never point either CLI at a real backend. Before
# it starts, the script seeds that config dir and HOME with things to list:
# a scratch repo with one command scenario and, committed in it, two
# diagrams, a diagnosis and a knowledge graph; a second scratch repo with
# none of those; kit.json's loadouts, two work items, a finished group and
# a ready run whose repo does not exist. Only calls that change nothing
# outside that server run: notes and work notes on its own store, keep
# awake's status (never a new mode), a scenario that runs `true` in the
# scratch repo, a sweep with nothing to close, pr, land and group picks
# with ids that do not exist or a run the server cannot land, the map
# section's reads, refusals and stops, and a diagram's or the diagnosis's
# page saved into each side's scratch copy. Nothing starts a run, a
# coordinator, an incubator stage, an analysis or a plugin prepare. A
# note's id, which each side mints, is masked.
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
gcheck commit-backend commit work -m "nothing yet" --backend http://127.0.0.1:1
both 'echo g >work/g.txt'
gcheck commit-all commit work --all -m "add g"
gcheck push-ff push work
gcheck push-backend push work --backend http://127.0.0.1:1
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
gcheck pull-backend pull work --backend
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
# The map section's verbs (floorplan, archify, diagnosis, understand) read
# what app holds, committed so a remove is refused, never done: two
# diagrams (one with finalize's receipt), a diagnosis with its overview, and
# a knowledge graph made at the first commit with code lessons beside it.
# The pages' times are years ahead, so each reads "just now" on both sides.
# plain is a repo with none of it.
mapped=$scratch/server/root/app
mkdir -p "$mapped/.archify/architecture-app-20260101-090000" "$mapped/.archify/sequence-login-20260102-090000" \
  "$mapped/.archify/diagnosis/analysis" "$mapped/.ua"
printf '<!doctype html><html><head><title>App &amp; its parts — map</title></head><body>app</body></html>\n' \
  >"$mapped/.archify/architecture-app-20260101-090000/app.html"
cat >"$mapped/.archify/architecture-app-20260101-090000/app.finalize-summary.json" <<'JSON'
{"command": "finalize", "status": "skipped", "type": "architecture",
 "gates": {"deliver": "pass", "check": "pass", "browser-check": "skipped"},
 "artifact": {"path": ".archify/architecture-app-20260101-090000/app.html"}}
JSON
printf '<html><body>login, no title</body></html>\n' >"$mapped/.archify/sequence-login-20260102-090000/login.html"
printf '<html><body>the analysis</body></html>\n' >"$mapped/.archify/diagnosis/analysis/repo.analysis.html"
cat >"$mapped/.archify/diagnosis/analysis/overview.json" <<'JSON'
{"verdict": "attention", "counts": {"findings": 270, "error": 2, "warning": 104, "info": 164, "accepted": 0},
 "review": {"baseline": null, "comparison": {"comparable": true, "reasons": [], "new": ["A"], "notDetected": ["B", "C"], "fixed": [], "evidenceChanged": ["D"], "unchanged": 266}},
 "investigation": {"leads": [
   {"id": "COUP-1", "code": "coupling/cycle", "severity": "error", "message": "2 modules depend on each other at package level: src → src/components → src.", "where": "src/App.tsx:1", "symbol": null},
   {"id": "COMP-1", "code": "complexity/function", "severity": "warning", "message": "handleApi has cyclomatic complexity 982.", "where": null}]},
 "coverage": {"language": "ts", "adapter": "typescript@5.9.3", "files": {"analyzed": 263, "excludedByRole": 147}, "otherLanguages": [{"adapter": "py", "files": 26}, {"adapter": "go", "files": 0}]}}
JSON
printf '{"project": {"analyzedAt": "2030-01-01T00:00:00.000Z", "gitCommitHash": "%s"}, "nodes": [{"type": "file"}, {"type": "file"}, {"type": "function"}], "edges": [{}], "layers": [{}, {}], "tour": [{}]}\n' \
  "$(git -C "$mapped" rev-parse HEAD)" >"$mapped/.ua/knowledge-graph.json"
echo '[]' >"$mapped/.ua/code-lessons.json"
git -C "$mapped" add -A
git -C "$mapped" commit -q -m "the map section"
touch -t 203001010000 "$mapped/.archify/architecture-app-20260101-090000/app.html" "$mapped/.archify/diagnosis/analysis/repo.analysis.html"
touch -t 203001020000 "$mapped/.archify/sequence-login-20260102-090000/login.html"
git init -q -b main "$scratch/server/root/plain"
git -C "$scratch/server/root/plain" commit -q --allow-empty -m first
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

# ---- the map section: floorplan, archify, diagnosis, understand ----
# Reads, refusals and stops only: a make, update, rebuild or revise starts
# a run, diagnosis run starts an analysis, and understand open or prepare
# installs a plugin, so none of them runs here. A save writes the page into
# each side's own scratch copy, and the two copies must match the repo's.

# samepage <name> <saved> <source> - both sides' saved page, byte for byte
samepage() {
  local name=$1 saved=$2 source=$3
  if cmp "$scratch/ts/$saved" "$source" && cmp "$scratch/rs/$saved" "$source"; then
    echo "same ($name): the saved $saved ($(wc -c <"$source" | tr -d ' ') bytes)"
  else
    echo "differs ($name): the saved $saved" >&2
    exit 1
  fi
}

hcheck floorplan floorplan app
hcheck floorplan-json floorplan app status --json
hcheck floorplan-path floorplan "$scratch/server/root/app"
hcheck floorplan-no-folder floorplan ./no-such-folder
hcheck floorplan-not-scanned floorplan "$scratch"
hcheck floorplan-open floorplan app open
hcheck floorplan-stop floorplan app stop
hcheck floorplan-note floorplan app open -m hi
hcheck floorplan-usage floorplan
hcheck floorplan-bad floorplan app draw
hcheck floorplan-unknown floorplan nosuch
hcheck floorplan-on floorplan app --on nosuch
hcheck floorplan-either floorplan app --backend "$CANOPY_API" --on x
hcheck floorplan-origin floorplan app --backend http://x/y
hcheck floorplan-down floorplan app --backend "$down"
hcheck archify archify app
hcheck archify-json archify app list --json
hcheck archify-none archify plain
hcheck archify-usage archify
hcheck archify-type archify app make --type mindmap
hcheck archify-type-rm archify app rm x --type erd
hcheck archify-note-rm archify app rm x -m why
hcheck archify-revise-note archify app revise architecture-app-20260101-090000
hcheck archify-rm-tracked archify app rm architecture-app-20260101-090000
hcheck archify-rm-unknown archify app rm nosuch
hcheck archify-rm-none archify plain rm nosuch
hcheck archify-rm-name archify app rm ../x
hcheck archify-save-unknown archify app save nosuch
hcheck archify-save-there archify app save architecture-app-20260101-090000 "$scratch/server.log"
gcheck archify-save archify app save architecture-app-20260101-090000
samepage archify-saved app.html "$mapped/.archify/architecture-app-20260101-090000/app.html"
gcheck archify-save-to archify app save sequence-login-20260102-090000 pages/login.html
samepage archify-saved-to pages/login.html "$mapped/.archify/sequence-login-20260102-090000/login.html"
gcheck archify-save-again archify app save architecture-app-20260101-090000
hcheck archify-unknown archify nosuch
hcheck archify-down archify app --backend "$down"
hcheck diagnosis diagnosis app
hcheck diagnosis-json diagnosis app status --json
hcheck diagnosis-none diagnosis plain
hcheck diagnosis-usage diagnosis
hcheck diagnosis-language diagnosis app run --language cobol
hcheck diagnosis-no-wait diagnosis app --no-wait
hcheck diagnosis-rm-tracked diagnosis app rm
hcheck diagnosis-rm-none diagnosis plain rm
hcheck diagnosis-save-none diagnosis plain save
gcheck diagnosis-save diagnosis app save
samepage diagnosis-saved repo.analysis.html "$mapped/.archify/diagnosis/analysis/repo.analysis.html"
gcheck diagnosis-save-again diagnosis app save
hcheck diagnosis-unknown diagnosis nosuch
hcheck diagnosis-down diagnosis app --backend "$down"
hcheck understand understand app
hcheck understand-json understand app status --json
hcheck understand-none understand plain
hcheck understand-stop understand app stop
hcheck understand-note understand app open -m hi
hcheck understand-usage understand
hcheck understand-bad understand app draw
hcheck understand-unknown understand nosuch
hcheck understand-on understand app --on nosuch
hcheck understand-down understand app --backend "$down"
