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
# notes and screen layouts with good and bad records. Both servers run under
# env -i with a scratch HOME, CANOPY_TMUX=0 and CANOPY_TAILCHAN_URL=off, so
# neither reads ~/.config/canopy, starts a shell or dials a broker, and
# neither takes port 7850.
#
# Answers are compared as JSON with keys sorted, millisecond clocks masked,
# the runtime field of /api/about masked and canopy-server's config dir
# named as the Bun server's.
#
# Before the route diff the script waits for each server's first trigger
# tick (30 seconds after its start) and checks that both delivered the
# seeded reminder that is due: marked in notes.json and sent down the
# stream. After it, quick notes are written to both the same way (adds,
# edits, done, delete and each refusal), each answer compared with the
# minted ids and the clocks of this run masked, then the two notes.json
# files byte for byte under the same masks and the notes frames each
# stream heard. Last, canopy-rs's note verb runs against each server and
# must print the same.
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
rs_cli="$here/rust/target/debug/canopy-rs"
(cd "$here/rust" && cargo build -q -p canopy-server -p canopy-cli)
# the clocks this run makes are masked, and nothing older
t0=$(($(date +%s) * 1000))
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
for side in bun rs; do cp -R "$S/seed" "$S/config-$side"; done

free() { "$bun" -e 'const s = Bun.serve({ port: 0, fetch: () => new Response() }); console.log(s.port); s.stop(true);'; }
bp=$(free)
rp=$(free)
if [ "$bp" = 7850 ] || [ "$rp" = 7850 ]; then
  echo "a free port came back as 7850" >&2
  exit 1
fi
# A time typed for a reminder is read in TZ. Tokyo keeps no summer time
# and is not UTC, so a server that ignored TZ would show. Bun reads the
# zone's rules from ICU and Rust from the zone files; the canopy shell
# containers' Etc/UTC file holds Los Angeles's rules, so TZ=UTC there
# would part the two for no fault of either.
zone=Asia/Tokyo
common=(HOME="$S/home" PATH="$(dirname "$bun"):/usr/local/bin:/usr/bin:/bin" SHELL=/bin/bash LANG=C.UTF-8 TZ=$zone
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
# browser on, and the repos that browser says it has open; what each
# stream hears is kept for the notes frames
for side in bun rs; do
  port=$bp
  [ $side = rs ] && port=$rp
  curl -sN "http://127.0.0.1:$port/api/events?client=0123456789abcdef&name=%20desk%20&platform=mac" >"$S/$side.events" 2>/dev/null &
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
  about worktrees voice sources"
same=0
unported=()
differ=()

# mask.py <file>: the text as it is, with each note id as <note>, each
# clock this run made (t0 to two hours on) as <ms>, and canopy-server's
# config dir named as the Bun server's. Formatting, key order and every
# older or later number are left to compare.
cat >"$S/mask.py" <<'PY'
import re, sys
t0 = int(sys.argv[1])
text = open(sys.argv[2], encoding="utf-8", errors="replace").read().replace("/config-rs", "/config-bun")
text = re.sub(r"n-[a-z2-7]{8}", "<note>", text)
def clock(m):
    return "<ms>" if t0 <= float(m.group(0)) <= t0 + 7_200_000 else m.group(0)
sys.stdout.write(re.sub(r"(?<![0-9.])[0-9]{13}(?:\.[0-9]+)?(?![0-9])", clock, text))
PY
mask() { python3 "$S/mask.py" "$t0" "$1"; }
# compare <name> - bun.<name> against rs.<name>, counted in nsame or differ
nsame=0
nsteps=0
compare() {
  nsteps=$((nsteps + 1))
  if diff -q "$S/bun.$1" "$S/rs.$1" >/dev/null; then
    nsame=$((nsame + 1))
  else
    differ+=("$1")
    diff "$S/bun.$1" "$S/rs.$1" | head -20 || true
  fi
}
# notesframes <side>: the notes frames that side's stream heard, masked
notesframes() {
  grep '^data: {"type":"notes"' "$S/$1.events" >"$S/$1.frames.raw" || true
  mask "$S/$1.frames.raw"
}
# notesfile <side>: notes.json masked, its mode, and the notes files in the
# config dir, which a temp file left behind would show
notesfile() {
  mask "$S/config-$1/notes.json"
  python3 -c 'import os, sys; print("mode", oct(os.stat(sys.argv[1]).st_mode & 0o777))' "$S/config-$1/notes.json"
  (cd "$S/config-$1" && ls -a | grep '^notes' || true)
}

# The seeded reminder n-abcdefg3 has been due since 2025. Each server's
# trigger tick, 30 seconds after its start, delivers it: wait for both, so
# the route diff below reads the notes after it.
delivered() {
  curl -s "http://127.0.0.1:$1/api/notes" | python3 -c '
import json, sys
n = [x for x in json.load(sys.stdin).get("notes", []) if x.get("id") == "n-abcdefg3"]
sys.exit(0 if n and "remindedAt" in n[0] else 1)'
}
for _ in $(seq 1 90); do
  if delivered "$bp" && delivered "$rp"; then break; fi
  sleep 1
done
for side in bun rs; do
  port=$bp
  [ $side = rs ] && port=$rp
  if delivered "$port"; then echo "delivered"; else echo "not delivered"; fi >"$S/$side.remind"
  notesframes $side >"$S/$side.remind-frames"
  notesfile $side >"$S/$side.remind-file"
done
compare remind
compare remind-frames
compare remind-file

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

# nstep <name> <method> <path> [body] [slot] - the same call to both
# servers, the status and the answer compared under mask.py. @A to @D in
# the path or the body are the ids each side's own adds minted; a slot
# letter keeps the id this call's answer carries.
nstep() {
  local name=$1 method=$2 path=$3 body=${4:-} slot=${5:-} side port p b k code
  for side in bun rs; do
    port=$bp
    [ $side = rs ] && port=$rp
    p=$path
    b=$body
    for k in A B C D; do
      [ -f "$S/$side.id$k" ] || continue
      p=${p//@$k/$(cat "$S/$side.id$k")}
      b=${b//@$k/$(cat "$S/$side.id$k")}
    done
    local args=(-s -o "$S/$side.n-$name.body" -w '%{http_code}' -X "$method")
    [ -n "$b" ] && args+=(-H 'Content-Type: application/json' --data-binary "$b")
    code=$(curl "${args[@]}" "http://127.0.0.1:$port$p")
    if [ -n "$slot" ]; then
      python3 -c 'import json, sys; print(json.load(open(sys.argv[1]))["id"])' "$S/$side.n-$name.body" >"$S/$side.id$slot"
    fi
    { echo "status $code"; mask "$S/$side.n-$name.body"; echo; } >"$S/$side.n-$name"
  done
  compare "n-$name"
}
# a reminder months away, so its words hold still between the two runs
at="$(($(date +%Y) + 1))-06-01 09:00"
at2="$(($(date +%Y) + 1))-06-02 10:00"
# unix ms ten days on, with a fraction, as JSON.stringify writes it back
at_ms="$((t0 + 864000000)).5"
nstep add POST /api/notes '{"text": "  ask about the port ", "repo": "app", "at": "in 30m"}' A
nstep add-plain POST /api/notes '{"text": "a thought\nwith a second line"}' B
nstep add-ms POST /api/notes "{\"text\": \"by the clock\", \"at\": $at_ms, \"repo\": \"$S/root/web\"}" C
nstep add-iso POST /api/notes "{\"text\": \"on the day\", \"at\": \"$at\"}"
nstep add-clock POST /api/notes '{"text": "at a clock time", "at": "at 23:59"}' D
# gone again, since its words in a list would tick by the minute
nstep delete-clock DELETE '/api/notes?id=@D'
nstep add-empty POST /api/notes '{"text": "   "}'
nstep add-norepo POST /api/notes '{"text": "x", "repo": "/nowhere"}'
nstep add-badrepo POST /api/notes '{"text": "x", "repo": 3}'
nstep add-sometime POST /api/notes '{"text": "x", "at": "someday"}'
nstep add-badat POST /api/notes '{"text": "x", "at": true}'
nstep add-past POST /api/notes '{"text": "x", "at": 1}'
nstep add-gone POST /api/notes '{"text": "x", "at": "2020-01-01 09:00"}'
nstep add-baddate POST /api/notes '{"text": "x", "at": "2026-13-01 09:00"}'
nstep add-zero POST /api/notes '{"text": "x", "at": "in 0m"}'
nstep add-notjson POST /api/notes 'not json'
nstep edit POST /api/notes/edit "{\"id\": \"@A\", \"text\": \"ask about the Rust port\", \"repo\": \"web\", \"at\": \"$at2\"}"
nstep edit-clear POST /api/notes/edit '{"id": "@C", "repo": null, "at": null}'
nstep edit-same POST /api/notes/edit "{\"id\": \"@A\", \"at\": \"$at2\"}"
nstep edit-empty POST /api/notes/edit '{"id": "@A", "text": ""}'
nstep edit-nulltext POST /api/notes/edit '{"id": "@A", "text": null}'
nstep edit-unknown POST /api/notes/edit '{"id": "n-zzzzzzzz", "text": "x"}'
nstep edit-badid POST /api/notes/edit '{"id": 5}'
nstep done POST /api/notes/done '{"id": "@B"}'
nstep done-again POST /api/notes/done '{"id": "@B"}'
nstep done-bad POST /api/notes/done '{"id": "w-wrongkind"}'
nstep delete DELETE '/api/notes?id=@C'
nstep delete-again DELETE '/api/notes?id=@C'
nstep delete-bad DELETE '/api/notes?id=x'
nstep delete-none DELETE /api/notes
nstep other GET /api/notes/other
nstep slash GET /api/notes/
nstep put PUT /api/notes
nstep list GET /api/notes
for side in bun rs; do
  notesfile $side >"$S/$side.notes-file"
  notesframes $side >"$S/$side.notes-frames"
done
compare notes-file
compare notes-frames

# ccheck <name> <args...> - canopy-rs's note verb against the Bun server and
# against canopy-server, stdout, stderr and exit code, ids masked. @id is
# the id that side's own `ccheck add` printed.
mkdir -p "$S/cli-home" "$S/cli-config"
cli=(HOME="$S/cli-home" PATH="/usr/bin:/bin" LANG=C.UTF-8 TZ=$zone CANOPY_CONFIG_DIR="$S/cli-config")
ccheck() {
  local name=$1 side port a code out
  shift
  for side in bun rs; do
    port=$bp
    [ $side = rs ] && port=$rp
    local args=()
    for a in "$@"; do
      if [ "$a" = @id ]; then a=$(cat "$S/$side.cid"); fi
      args+=("$a")
    done
    out="$S/$side.c-$name"
    env -i "${cli[@]}" "$rs_cli" "${args[@]}" --backend "http://127.0.0.1:$port" >"$out.1" 2>"$out.2" && code=0 || code=$?
    if [ "$name" = add ]; then awk 'NR==1{print $1}' "$out.1" >"$S/$side.cid"; fi
    { cat "$out.1"; echo "--- stderr"; cat "$out.2"; echo "--- exit $code"; } >"$out.raw"
    mask "$out.raw" >"$out"
  done
  compare "c-$name"
}
ccheck list note list
ccheck add note add "pick up  the
parts" --repo app --at "$at"
ccheck list-open note list
ccheck done note done @id
ccheck list-all note list --all
ccheck delete note delete @id
ccheck unknown note done n-zzzzzzzz
ccheck norepo note add "x" --repo nosuch
ccheck sometime note add "x" --at someday

echo "same: $same"
echo "notes steps same: $nsame of $nsteps"
echo "not ported (501): ${#unported[@]} (${unported[*]})"
if [ ${#differ[@]} -gt 0 ]; then
  echo "DIFFERS: ${differ[*]}" >&2
  exit 1
fi
[ "${CANOPY_PARITY_KEEP:-}" = 1 ] && echo "bun on :$bp, canopy-server on :$rp"
exit 0
