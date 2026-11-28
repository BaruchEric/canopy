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
# loadouts, groups, work, land, queue, collisions, floorplan, archify,
# diagnosis, understand, capacity, costs, plugins, people, clip, clips,
# worktrees, workflow, health) talk to a scratch Bun server this script
# starts on a free port with its own config dir and HOME, and to nothing
# else: CANOPY_API, CANOPY_TOKEN and CANOPY_BACKEND are cleared first, so a
# canopy shell's settings never point either CLI at a real backend. Before
# it starts, the script seeds that config dir and HOME with things to
# list: a scratch repo with one command scenario, health checks the server
# finds down or off, a workflow of its own and modes over the bundled ones
# and, committed in it, two diagrams, a diagnosis and a knowledge graph; a
# second scratch repo with none of those; kit.json's loadouts, two work
# items, a finished group and a ready run whose repo does not exist;
# capacity.json's kept readings, three cost ledger rows, a stand-in
# claude-history the config names and a stand-in claude plugin CLI
# (src/core/pluginfake.ts) with plugins in its own state file, so no real
# ~/.claude is read; and the CLIs' own config dir with user workflows, one
# broken and one unlisted, which workflow list and show read when no
# --repo is given (workflow check, health lint and health init read local
# files and ask no server). Only calls that change nothing outside that
# server run: notes and work notes on its own store, keep awake's status
# (never a new mode), a scenario that runs `true` in the scratch repo, a
# sweep with nothing to close, pr, land, group and capacity picks with ids
# that do not exist or a run the server cannot land, the map section's
# reads, refusals and stops, a diagram's or the diagnosis's page saved
# into each side's scratch copy, the plugins listing (never an install, an
# op or a marketplace), workflow listings, drawings and checks of scratch
# files, and health listings and refusals (never a heal, an add or a
# remove that goes through). Nothing starts a run, a flow, a coordinator,
# an incubator stage, an analysis or a plugin prepare. A note's id, which
# each side mints, is masked.
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
 "defaults": {"loadout": "docs", "repos": {"app": "deep"}},
 "machines": {"scratch": {"backend": "scratch"}}, "plugins": ["claude"]}
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
# For capacity, costs and plugins. capacity.json keeps a standing hit on
# claude, codex's count from a run and Antigravity's from its CLI, every
# reset a year away so the words hold still. The ledger has three rows from
# a minute ago, in the file of their local month. A stand-in claude-history
# answers with the scratch app as one project with spend today, and
# config.json names it, marks app as the harness and names this backend
# scratch, the machine kit.json reads plugins on. The stand-in claude
# plugin CLI keeps two plugins and a marketplace in its state file, and
# settings.json turns three on; KIT_CLAUDE points the kit's scan at it.
read -r ledger_at month r_hit r_five r_week < <(env -u TZ "$bun" -e '
  const at = Date.now() - 60_000, d = new Date(at), y = d.getFullYear() + 1;
  console.log(at, `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`,
    Date.UTC(y, 0, 14, 15), Date.UTC(y, 0, 15, 15), Date.UTC(y, 0, 16, 15));')
# the path the scan reports, so the ledger's rows land on the app's card
app="$real/server/root/app"
cat >"$seed/capacity.json" <<JSON
{"hits": {"claude": {"window": "fiveHour", "at": $ledger_at, "resetsAt": $r_hit, "text": "You've hit your limit"}},
 "windows": {"codex": {"fiveHour": {"used": 0.4, "resetsAt": $r_five, "readAt": $ledger_at},
                       "weekly": {"used": 0.86, "resetsAt": $r_week, "readAt": $ledger_at}},
             "antigravity": {"source": "cli", "fiveHour": {"used": 0.04, "resetsAt": null, "readAt": $ledger_at}, "weekly": null}}}
JSON
mkdir -p "$seed/costs"
zero='{"input": 0, "cachedInput": 0, "output": 0, "reasoning": 0, "total": 0}'
cat >"$seed/costs/$month.jsonl" <<JSON
{"at": $ledger_at, "service": "claude", "provider": "anthropic", "model": "opus", "repo": "$app", "repoName": "app", "run": "r-1", "label": null, "session": "s-1", "usd": 2.5, "tokens": {"input": 100000, "cachedInput": 0, "output": 20000, "reasoning": 0, "total": 120000}, "seconds": null}
{"at": $ledger_at, "service": "codex", "provider": "openai", "model": "gpt-5", "repo": "$app", "repoName": "app", "run": "r-2", "label": null, "session": null, "usd": 1.25, "tokens": {"input": 4000, "cachedInput": 0, "output": 1000, "reasoning": 0, "total": 5000}, "seconds": null}
{"at": $ledger_at, "service": "speech", "provider": "speech", "model": "transcribe", "repo": null, "repoName": null, "run": null, "label": null, "session": null, "usd": null, "tokens": $zero, "seconds": 30}
JSON
history_bin="$scratch/server/home/dev/dev-tools/claude-history/bin/claude-history"
mkdir -p "$(dirname "$history_bin")"
cat >"$history_bin" <<SH
#!/bin/sh
case \$1 in
  projects) echo '[{"id": "p-app", "name": "app", "path": "$app", "sessions": 4, "tokens": 250000, "cost": 6.5, "first": null, "last": null, "commits": 2}]' ;;
  activity) echo "[{\\"project\\": \\"p-app\\", \\"day\\": \\"\$(date +%Y-%m-%d)\\", \\"sessions\\": 3, \\"cost\\": 4.25}]" ;;
  *) exit 2 ;;
esac
SH
chmod +x "$history_bin"
cat >"$seed/config.json" <<JSON
{"self": "scratch", "historyBin": "$history_bin", "harness": ["$scratch/server/root/app", "$app"]}
JSON
fake_claude=$("$bun" -e 'const { fakePluginCli } = await import(process.argv[1]); console.log(fakePluginCli(process.argv[2], "claude"));' \
  "$here/src/core/pluginfake.ts" "$scratch/server")
cat >"$scratch/server/home/.fake-claude-plugins.json" <<'JSON'
{"installed": {"superpowers@o": {"enabled": true, "version": "7.0.0"},
               "context-mode@cm": {"enabled": false, "version": "0.2.0", "servers": {"context-mode": "node s"}}},
 "markets": {"o": "x/o"}, "catalog": [{"id": "remember@o", "description": "memory", "installs": 5}]}
JSON
cat >"$scratch/server/home/.claude/settings.json" <<'JSON'
{"enabledPlugins": {"superpowers@o": true, "remember@o": true, "off@o": false}}
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
  CANOPY_AGENT_SCAN=0 CANOPY_TAILCHAN_URL=off CANOPY_TMUX=0 KIT_CLAUDE="$fake_claude" \
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
# capacity: the kept readings, a held start that does not exist, the usages
# and a down backend; read and set, which run the CLI readers, only as
# usages and against the down one
hcheck capacity capacity
hcheck capacity-list capacity list
(export TZ=Asia/Tokyo && hcheck capacity-tokyo capacity)
hcheck capacity-json capacity --json
hcheck capacity-on capacity --on nosuch
hcheck capacity-on-self capacity --on scratch --json
hcheck capacity-release-unknown capacity release flow:nope
hcheck capacity-release-usage capacity release
hcheck capacity-usage capacity what
hcheck capacity-list-extra capacity list extra
hcheck capacity-set-usage capacity set
hcheck capacity-set-hold capacity set --normal 2
hcheck capacity-set-usd capacity set --usd -1
hcheck capacity-needs capacity --backend
hcheck capacity-down capacity --backend "$down"
hcheck capacity-json-down capacity --json --backend "$down"
hcheck capacity-read-down capacity read --backend "$down"
hcheck capacity-set-down capacity set --low 60% --backend "$down"
# costs: the ledger and the stand-in archive over each window, the share
hcheck costs costs
hcheck costs-today costs --days 1
hcheck costs-month-share costs --days 30 --share
hcheck costs-share costs --share
hcheck costs-days-usage costs --days 5
hcheck costs-days-missing costs --days
hcheck costs-stray costs --share stray
hcheck costs-on costs --on nosuch
hcheck costs-on-self costs --on scratch --days 30
hcheck costs-origin costs --backend http://x/y
hcheck costs-down costs --backend "$down"
# plugins: only the listing reads; no install, op or marketplace runs
hcheck plugins plugins
hcheck plugins-status plugins status
hcheck plugins-claude plugins list --agent claude
hcheck plugins-codex plugins list --agent codex
hcheck plugins-machine plugins list --machine nosuch
hcheck plugins-machine-self plugins list --machine scratch --agent claude
hcheck plugins-agent-bad plugins --agent hermes
hcheck plugins-usage plugins frob x
hcheck plugins-op-usage plugins enable
hcheck plugins-market-usage plugins marketplace frob x
hcheck plugins-search-usage plugins search memory
hcheck plugins-search-nosuch plugins search memory --machine nosuch
hcheck plugins-down plugins --backend "$down"
hcheck plugins-commit-down plugins commit --backend "$down"
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
