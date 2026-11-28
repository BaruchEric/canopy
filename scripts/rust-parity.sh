#!/usr/bin/env bash
# Runs the TypeScript CLI and the Rust port (canopy-rs) side by side and
# diffs what they print. Exits 1 on the first difference.
#
# The read verbs (tree, status, the bare form, version) run on the same
# folder and only read it. The last column of the tree, how long ago the
# newest commit was, is masked: a scan of a big folder takes long enough
# for it to tick over between the two runs (treelines tests cover it).
#
# The git verbs (commit, push, pull, fr) never touch a real repo: each CLI
# gets its own copy of the same scratch repos (a bare origin and clones of
# it), built with pinned names and dates so their commit hashes match, and
# each step runs on both copies in turn, the scratch path masked. fr reads
# and reserves feature numbers in a scratch repo with its own bare origin,
# and checks a list that gives one number twice; it never runs on canopy's
# checkout. canopy health init writes its starter file into each copy.
#
# Help: every verb's --help, and help <verb>, read from the same help.ts.
#
# The backend verbs (note, awake, issues, pr, prs, scenarios, sweep, kit,
# loadouts, groups, work, land, queue, collisions, workflow, health) talk
# to a scratch Bun server this script starts on a free port with its own
# config dir and HOME, and to nothing else: CANOPY_API, CANOPY_TOKEN and
# CANOPY_BACKEND are cleared first, so a canopy shell's settings never
# point either CLI at a real backend. Before it starts, the script seeds
# that config dir and HOME with things to list: a scratch repo with one
# command scenario, health checks the server finds down or off, a workflow
# of its own and modes over the bundled ones, kit.json's loadouts, two work
# items, a finished group and a ready run whose repo does not exist; and
# the CLIs' own config dir with user workflows, one broken and one
# unlisted, which workflow list and show read when no --repo is given
# (workflow check, health lint and health init read local files and ask no
# server). Only calls that change nothing outside that server run: notes
# and work notes on its own store, keep awake's status (never a new mode),
# a scenario that runs `true` in the scratch repo, a sweep with nothing to
# close, workflow listings, drawings and checks of scratch files, health
# listings and refusals (never a heal, an add or a remove that goes
# through), and pr, land and group picks with ids that do
# not exist or a run the server cannot land. Nothing starts a run, a flow,
# a coordinator or an incubator stage. A note's id, which each side mints,
# is masked.
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

# fr: a list that gives FR-001 and FR-003, with its own bare origin for the
# reservations, and one that gives FR-002 twice
both 'git init -q --bare fr-origin.git
  git init -q fr && printf "# Feature requests\n\n## Open\n\n### FR-001 · one\n\n### FR-003 · three\n" >fr/FEATURES.md
  git -C fr add FEATURES.md && git -C fr commit -q -m list && git -C fr remote add origin ../fr-origin.git && git -C fr push -q origin main
  git init -q fr-twice && printf "### FR-002 · a\n\n### FR-002 · b\n" >fr-twice/FEATURES.md
  git -C fr-twice add FEATURES.md && git -C fr-twice commit -q -m twice && mkdir no-git'
gcheck fr-usage fr what
gcheck fr-backend fr --backend http://127.0.0.1:1
gcheck fr-no-git fr -C no-git
gcheck fr-none fr -C fr
gcheck fr-next fr next -C fr
gcheck fr-check fr check -C fr
gcheck fr-check-twice fr check -C fr-twice
gcheck fr-reserve fr reserve -m "a new thing" -C fr
gcheck fr-reserve-json fr reserve --json -C fr
gcheck fr-list fr list -C fr
gcheck fr-list-json fr list --json -C fr
both 'printf "\n### FR-004 · a new thing\n" >>fr/FEATURES.md && git -C fr commit -qam "list FR-004" && git -C fr push -q origin main'
gcheck fr-listed fr -C fr
gcheck fr-listed-all fr --all -C fr

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
# health and workflow: checks the server finds down or off (nothing listens
# on port 1, there is no dev task, and a command check in a repo that is
# not the user's never runs), a bad entry, the repo's own workflow drawn as
# a graph, and modes over a bundled workflow with a step that is not there,
# committed so the server reads them at HEAD; a user workflow on the server
mkdir -p "$scratch/server/root/app/.canopy/workflows" "$seed/workflows"
cat >"$scratch/server/root/app/.canopy/health.json" <<'JSON'
{"checks": [
  {"name": "site", "kind": "http", "url": "http://127.0.0.1:1/health", "expect": 204},
  {"name": "db", "kind": "port", "port": 1, "every": 300},
  {"name": "dev", "kind": "task", "task": "dev", "heal": "none", "every": 300},
  {"name": "smoke", "kind": "command", "run": "true", "fix": "true", "heal": "none", "while": "dev"},
  {"name": "Bad Name", "kind": "port", "port": 2}
]}
JSON
cat >"$scratch/server/root/app/.canopy/workflows/tidy.md" <<'MD'
---
blurb: tidy the repo
---

## Sweep
tools: git-commit

sweep

## Lint
after: Sweep
tools: read
gate: verdict

lint

## Docs
after: Sweep
check: true
retries: 1
back: Sweep

docs

## Ship
after: Lint, Docs
when: verdict done, check pass
mode: manual

ship
MD
cat >"$scratch/server/root/app/.canopy/workflows.json" <<'JSON'
{"modes": {"tidy": {"Ship": "auto", "Gone": "manual"}, "*": {"Commit": "manual"}}}
JSON
printf -- '---\nblurb: served\n---\n\n## Do\n\nDo it.\n' >"$seed/workflows/served.md"
git -C "$scratch/server/root/app" add .canopy
git -C "$scratch/server/root/app" commit -q -m checks
# the CLIs' own user workflows: a graph, a broken file and an unlisted one
mkdir -p "$scratch/config/workflows" "$scratch/flows"
cp "$scratch/server/root/app/.canopy/workflows/tidy.md" "$scratch/config/workflows/fan.md"
printf -- '---\nname: broken\n---\n\n## Do\n\nx\n' >"$scratch/config/workflows/broken.md"
printf -- '---\nblurb: q\nlisted: false\n---\n\n## Q\n\nq\n' >"$scratch/config/workflows/quiet.md"
cp "$scratch/config/workflows/fan.md" "$scratch/flows/fan.md"
sed 's/when: verdict done, check pass/when: judge meets/' "$scratch/flows/fan.md" >"$scratch/flows/bad.md"
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

# workflow: this machine's bundled and user files, a scratch file checked,
# and the server's list for the scratch repo with its modes
hcheck workflow-usage workflow
hcheck workflow-bad workflow draw
hcheck workflow-list workflow list
hcheck workflow-show workflow show ship
hcheck workflow-show-dot workflow show ship --dot
hcheck workflow-show-user workflow show fan
hcheck workflow-show-broken workflow show broken
hcheck workflow-show-unlisted workflow show quiet
hcheck workflow-show-none workflow show nope
hcheck workflow-show-usage workflow show
hcheck workflow-check workflow check "$scratch/flows/fan.md"
hcheck workflow-check-bad workflow check "$scratch/flows/bad.md"
hcheck workflow-check-none workflow check "$scratch/flows/none.md"
hcheck workflow-check-usage workflow check a b
hcheck workflow-check-repo workflow check x --repo app
hcheck workflow-repo workflow list --repo app
hcheck workflow-repo-show workflow show tidy --repo app
hcheck workflow-repo-dot workflow show tidy --repo app --dot
hcheck workflow-repo-ship workflow show ship --repo app
hcheck workflow-repo-path workflow list --repo "$scratch/server/root/app"
hcheck workflow-repo-folder workflow list --repo "$scratch/no-such-folder"
hcheck workflow-repo-none workflow list --repo nosuch
hcheck workflow-repo-needs workflow list --repo
hcheck workflow-down workflow list --repo app --backend "$down"

# health: the scratch repo's checks, which the server found down or off
# long before now, so their states hold still; canopy's own pieces are left
# out, since a disk's free space moves between the two runs
hcheck health-repo health --repo app
hcheck health-repo-json health list --repo app --json
hcheck health-repo-bad health --repo app --bad
hcheck health-repo-none health --repo nosuch
hcheck health-nothing-down health --repo nosuch --bad
hcheck health-show health show repo:app:site
hcheck health-show-json health show repo:app:db --json
hcheck health-show-off health show repo:app:smoke
hcheck health-show-none health show nope
hcheck health-show-usage health show
hcheck health-heal-none health heal nope
hcheck health-heal-usage health heal
hcheck health-checks health checks app
hcheck health-checks-json health checks app --json
hcheck health-checks-path health checks "$scratch/server/root/app"
hcheck health-checks-none health checks nosuch
hcheck health-checks-usage health checks
hcheck health-rm-repo health rm app site
hcheck health-rm-none health rm app nope
hcheck health-rm-usage health rm app
hcheck health-add-kind health add app web
hcheck health-add-value health add app web --port
hcheck health-add-flag health add app web --port 80 --nope
hcheck health-add-name health add app "Bad Name" --port 80
hcheck health-add-port health add app web --port 70000
hcheck health-add-usage health add app
hcheck health-usage health what
hcheck health-extra health list extra
hcheck health-on health --on nosuch
hcheck health-origin health --backend http://x/y
hcheck health-down health --backend "$down"
hcheck health-down-json health --json --backend "$down"
hcheck health-watch-down health watch --backend "$down"
hcheck health-lint health lint "$scratch/server/root/app"
hcheck health-lint-none health lint "$scratch/no-such-folder"
both 'mkdir starter && printf "{\"scripts\": {\"dev\": \"vite\"}}\n" >starter/package.json'
gcheck health-init health init starter
gcheck health-init-again health init starter
gcheck health-lint-starter health lint starter
gcheck health-init-empty health init empty
