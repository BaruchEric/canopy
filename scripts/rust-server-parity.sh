#!/usr/bin/env bash
# Starts a scratch Bun server and a scratch canopy-server side by side, each
# on a free port with its own copy of one seeded config dir and the same
# scan root, asks both for every route the page reads on its first load,
# and diffs the answers. Exits 1 when a route canopy-server answers says
# something other than what the Bun server says; a route it does not answer
# yet (501) is listed and passes.
#
# The seed holds something for each ported route to read: backends (one of
# them not a URL), workspaces, launchers, agent profiles and roles, quick
# notes and screen layouts with good and bad records, the incubator's
# improvements list, the landing queue's notices, work items (open, closed,
# broken and misnamed) and kept worktrees of one repo on record, with an
# unrecorded detached one beside them. Both servers run under
# env -i with a scratch HOME, CANOPY_TMUX=0 and CANOPY_TAILCHAN_URL=off, so
# neither reads ~/.config/canopy, starts a shell or dials a broker, and
# neither takes port 7850.
#
# Answers are compared as JSON with keys sorted, millisecond clocks masked,
# the runtime field of /api/about masked and canopy-server's config dir
# named as the Bun server's.
#
#   bash scripts/rust-server-parity.sh
#
# CANOPY_PARITY_KEEP=1 keeps the scratch dir, with both answers to each
# route (bun.<route>, rs.<route>) and both logs, and leaves the servers
# running; it prints their ports and how to stop them.
set -euo pipefail
here=$(cd "$(dirname "$0")/.." && pwd)
bun=$(command -v bun)
server="$here/rust/target/debug/canopy-server"
(cd "$here/rust" && cargo build -q -p canopy-server)
[ -f "$here/dist/web/index.html" ] || (cd "$here" && bun run build >/dev/null)

S=$(mktemp -d "${TMPDIR:-/tmp}/canopy-server-parity.XXXXXX")
S=$(cd "$S" && pwd -P)
pids=()
stop() {
  for p in "${pids[@]}"; do kill "$p" 2>/dev/null || true; done
  rm -rf "$S"
}
if [ "${CANOPY_PARITY_KEEP:-}" = 1 ]; then
  trap 'echo "kept $S; stop with: kill ${pids[*]}"' EXIT
else
  trap stop EXIT
fi

mkdir -p "$S/root" "$S/home/.claude" "$S/seed"
for r in app web; do
  git init -q -b main "$S/root/$r"
  git -C "$S/root/$r" -c user.name=t -c user.email=t@t commit -q --allow-empty -m first
done
cat >"$S/seed/config.json" <<JSON
{"self": "scratch", "keepShells": true,
 "peers": [{"name": "mini", "alias": "eric@mini", "root": "/srv/dev", "role": "mirror", "repos": ["app", ""]}, {"name": "mini", "alias": "x", "root": "/y"}, {"name": "nb", "alias": "gpd", "root": "/a/../b"}],
 "backends": [{"name": "mini", "tailnet": "http://127.0.0.1:1"}, {"name": "bad name!"}, {"name": "pub", "public": "http://not-https.example"}],
 "workspaces": [{"name": "both", "repos": ["$S/root/app", "$S/root/web", 3], "primary": "$S/root/web", "color": "nope"}, {"name": 5}],
 "launchers": {"$S/root/app": {"app": "kitty"}},
 "profiles": {"fast": {"harness": "claude", "model": "haiku", "effort": "low", "yolo": true, "extra": " --x\u0001 "}, "Bad": {}},
 "agentRoles": {"chat": {"profile": "fast"}, "nope": {"profile": "fast"}},
 "agents": {"$S/root/app": {"model": "sonnet"}, "$S/root/web": {"roles": {"job": {"harness": "codex", "model": "gpt-5.5"}}}}}
JSON
cat >"$S/seed/notes.json" <<'JSON'
[{"doneAt": 1764300000500, "id": "n-abcdefgh", "text": "ship the port", "createdAt": 1764300000000, "repoId": "", "due": -1},
 {"id": "n-ABCDEFGH", "text": "bad id", "createdAt": 1},
 {"id": "n-abcdefg2", "text": "no time"},
 {"id": "n-abcdefg3", "text": "a reminder", "createdAt": 1764300000001.5, "repoId": "app", "due": 1764400000000},
 "not a note"]
JSON
cat >"$S/seed/screen-layouts.json" <<'JSON'
{"profiles": [
  {"id": "p-0123456789ab", "name": " desk ", "model": "", "width": 2560, "height": 1440.0, "dpr": 2,
   "layout": {"termFont": 12.5, "sidebarWidth": 240.5, "x": 1, "sectionsHidden": ["a", "a"], "level": "advanced",
              "tabs": {"split": {"dir": "row", "at": 0.95, "a": {"pane": "x"}, "b": {"pane": "y"}}, "panel": ["x"]},
              "paneSizes": {"lede": 200.4, "nope": 1}}},
  {"id": "p-0123456789ab", "name": "again", "width": 1000, "height": 800},
  {"id": "p-bbbbbbbbbbbb", "name": "too small", "width": 100, "height": 800},
  {"id": "bad", "name": "bad", "width": 1000, "height": 800}],
 "presets": {"preset-1920x1080": {"name": "office", "device": "dell", "width": 1920, "height": 1080, "layout": {"agents": "lanes"}},
             "preset-1x1": {"name": "none", "width": 1000, "height": 800}}}
JSON
mkdir -p "$S/seed/incubator" "$S/seed/landing" "$S/seed/work"
cat >"$S/seed/incubator/improvements.json" <<'JSON'
{"entries": {
  "scout-reads-npm": {"key": "scout-reads-npm", "lesson": "  Scout reads\n release dates   on npm. ", "file": "lib/workflows/scout.md", "edit": "+ a line",
    "from": [{"id": "sp_1", "title": "One", "at": 1764300000000}, {"id": "sp_2", "title": "Two", "at": 1764300001000.0}, {"id": "sp_3", "at": 5}]},
  "clarify-asks-less": {"key": "clarify-asks-less", "lesson": "Ask less.", "file": "../x.md",
    "from": [{"id": "sp_1", "title": "One", "at": 1764300000000}], "decided": {"accept": false, "at": 1764300002000, "count": 1}},
  "comes-back": {"key": "comes-back", "lesson": "Back again.", "decided": {"accept": true, "at": 1, "count": 1},
    "from": [{"id": "a", "title": "A", "at": 1}, {"id": "b", "title": "B", "at": 2}, {"id": "c", "title": "C", "at": 3}, {"id": "d", "title": "D", "at": 4}]},
  "b-tie": {"key": "b-tie", "lesson": "b", "from": [{"id": "x", "title": "X", "at": 7}]},
  "a-tie": {"key": "a-tie", "lesson": "a", "from": [{"id": "x", "title": "X", "at": 7}]},
  "123": {"key": "123", "lesson": "a number", "from": []},
  "Bad Key": {"key": "Bad Key", "lesson": "l", "from": []},
  "mismatch": {"key": "other", "lesson": "l", "from": []}}}
JSON
cat >"$S/seed/landing/notices.json" <<'JSON'
[{"id": "n1", "at": 1764300000000, "repoId": "app", "text": "landed run/a on its own"},
 {"id": "n2", "at": 1764300009000.0, "repoId": "web", "text": "held back"},
 {"at": 5, "text": "no id"}, "junk"]
JSON
cat >"$S/seed/work/w-testaaaa.json" <<'JSON'
{"id": "w-testaaaa", "title": "open on app", "repos": ["app"], "state": "open", "from": {"kind": "note"}, "runs": ["r-gone"], "branches": ["b-gone"], "prs": [], "events": [], "notes": [], "createdAt": 1764300000000, "updatedAt": 1764300000000}
JSON
cat >"$S/seed/work/w-testbbbb.json" <<'JSON'
{"id": "w-testbbbb", "title": "dropped on web", "repos": ["web"], "state": "dropped", "from": {"kind": "issue", "service": "linear", "key": "K-1"}, "runs": [], "branches": [], "prs": [{"number": 4, "url": "https://example.com/pr/4"}], "events": ["e1"], "notes": [{"at": 1764300009000, "by": "eric", "text": "not worth it"}], "createdAt": 1764300000000, "updatedAt": 1764300009000, "closedAt": 1764300009000, "reason": "not worth it"}
JSON
cat >"$S/seed/work/w-testcccc.json" <<'JSON'
{"id": "w-testcccc", "title": "open on both", "7": "an index key", "repos": ["app", "web"], "state": "open", "from": {"kind": "trigger", "event": "e2"}, "runs": [], "branches": [], "prs": [], "events": [], "notes": [], "createdAt": 1764300000000.0, "updatedAt": 1764300005000, "extra": {"b": 2.50, "a": 1.0}}
JSON
echo '{' >"$S/seed/work/broken.json"
sed 's/w-testcccc/w-testeeee/' "$S/seed/work/w-testcccc.json" >"$S/seed/work/w-testdddd.json"
for side in bun rs; do cp -R "$S/seed" "$S/config-$side"; done
# kept worktrees of app in each side's own trees folder: one on record, one
# on record as failed that follows main and is synced to it, and a detached
# one with no record; a branch is checked out once per side, hence -f
key=$(python3 -c 'import hashlib, os, sys; p = sys.argv[1]; print((os.path.basename(p) or "repo") + "-" + hashlib.sha1(p.encode()).hexdigest()[:8])' "$S/root/app")
main_rev=$(git -C "$S/root/app" rev-parse main)
git -C "$S/root/app" branch feat/x
git -C "$S/root/app" branch fix
for side in bun rs; do
  trees="$S/config-$side/trees/$key"
  git -C "$S/root/app" worktree add -q -f "$trees/feat-x" feat/x
  git -C "$S/root/app" worktree add -q -f "$trees/fix" fix
  git -C "$S/root/app" worktree add -q --detach "$trees/scratch" main
  echo dirty >"$trees/fix/new.txt"
  cat >"$trees/trees.json" <<JSON
{"trees": [{"slug": "feat-x", "branch": "feat/x", "base": "main", "port": 7901, "madeAt": 1764300000000, "caches": false, "state": "ready", "sync": false},
  {"slug": "fix", "branch": "fix", "base": "main", "port": 7.5, "madeAt": 1764300000000.0, "state": "failed", "why": "setup exited 1", "stopped": "", "sync": true, "syncedTo": "$main_rev", "extra": 1},
  {"slug": "nameless"}]}
JSON
done

free() { "$bun" -e 'const s = Bun.serve({ port: 0, fetch: () => new Response() }); console.log(s.port); s.stop(true);'; }
bp=$(free)
rp=$(free)
if [ "$bp" = 7850 ] || [ "$rp" = 7850 ]; then
  echo "a free port came back as 7850" >&2
  exit 1
fi
common=(HOME="$S/home" PATH="$(dirname "$bun"):/usr/local/bin:/usr/bin:/bin" SHELL=/bin/bash LANG=C.UTF-8 TZ=UTC
  CANOPY_LOOPBACK_AUTH=1 CANOPY_PREVIEW_PORTS=0 CANOPY_NO_DESKTOP=1 CANOPY_AGENT_SCAN=0 CANOPY_TAILCHAN_URL=off CANOPY_TMUX=0)
env -i "${common[@]}" CANOPY_CONFIG_DIR="$S/config-bun" \
  "$bun" "$here/bin/canopy.ts" ui "$S/root" --port "$bp" --no-open >"$S/bun.log" 2>&1 &
pids+=($!)
env -i "${common[@]}" CANOPY_CONFIG_DIR="$S/config-rs" \
  "$server" "$S/root" --port "$rp" --web "$here/dist/web" >"$S/rs.log" 2>&1 &
pids+=($!)
up=0
for _ in $(seq 1 120); do
  if curl -sf -o /dev/null "http://127.0.0.1:$bp/api/about" && curl -sf -o /dev/null "http://127.0.0.1:$rp/api/about"; then
    up=1
    break
  fi
  sleep 0.5
done
if [ $up = 0 ]; then
  echo "a server did not come up; logs in $S" >&2
  tail -5 "$S/bun.log" "$S/rs.log" >&2
  exit 1
fi
# a page's stream on each, so the devices list and the people have a
# browser on, and the repos that browser says it has open
for port in $bp $rp; do
  curl -sN "http://127.0.0.1:$port/api/events?client=0123456789abcdef&name=%20desk%20&platform=mac" >/dev/null 2>&1 &
  pids+=($!)
done
sleep 1
for port in $bp $rp; do
  curl -s -o /dev/null -X POST -H 'Content-Type: application/json' \
    -d '{"client":"0123456789abcdef","repos":["app","app","web"]}' "http://127.0.0.1:$port/api/people/at"
done
# the Bun server's first scan and its login-shell probe settle after the bind
sleep 5

routes="backends tree auth runs flows fleets agents helpers verdict jobs terms client devices terms/kept
  workspaces launchers tasks tailchan history peers registry asks incubator/stages incubator/advice incubator
  ranger agents/pulse health capacity kit landing trees prs triggers people work clips notes secrets layouts
  about worktrees voice sources work?repo=app work?state=dropped work?state=nope work?repo=nope"
same=0
unported=()
differ=()
for p in $routes; do
  f=$(echo "$p" | tr / _)
  for side in bun rs; do
    port=$bp
    [ $side = rs ] && port=$rp
    code=$(curl -s -o "$S/$side.$f.body" -w '%{http_code}' "http://127.0.0.1:$port/api/$p")
    {
      echo "status $code"
      python3 - "$S/$side.$f.body" <<'PY'
import json, sys
raw = open(sys.argv[1]).read().replace("/config-rs", "/config-bun")
def mask(v):
    if isinstance(v, dict): return {k: ("<runtime>" if k == "bun" else mask(x)) for k, x in v.items()}
    if isinstance(v, list): return [mask(x) for x in v]
    if isinstance(v, (int, float)) and not isinstance(v, bool) and 1_000_000_000_000 <= v < 10_000_000_000_000: return "<ms>"
    return v
try: print(json.dumps(mask(json.loads(raw)), indent=1, sort_keys=True))
except Exception: print(raw)
PY
    } >"$S/$side.$f"
  done
  if [ "$(head -1 "$S/rs.$f")" = "status 501" ]; then
    unported+=("$p")
  elif diff -q "$S/bun.$f" "$S/rs.$f" >/dev/null; then
    same=$((same + 1))
  else
    differ+=("$p")
    diff "$S/bun.$f" "$S/rs.$f" | head -20 || true
  fi
done
echo "same: $same"
echo "not ported (501): ${#unported[@]} (${unported[*]})"
if [ ${#differ[@]} -gt 0 ]; then
  echo "DIFFERS: ${differ[*]}" >&2
  exit 1
fi
[ "${CANOPY_PARITY_KEEP:-}" = 1 ] && echo "bun on :$bp, canopy-server on :$rp"
exit 0
