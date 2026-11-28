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
# notes and screen layouts with good and bad records, a historyBin that is
# not there, clips (pruned, pinned, a file, a duplicate, a bad source), a
# secrets key with a pin but no remote, the ranger's settings, record and
# wakes with Claude's settings giving the Telegram plugin to every session,
# an empty worktrees root and a gates file with a warm count. HOME holds no
# kit.json. Both servers run under env -i with a scratch HOME, CANOPY_TMUX=0
# and CANOPY_TAILCHAN_URL=off, so neither reads ~/.config/canopy, starts a
# shell or dials a broker, and neither takes port 7850.
#
# Answers are compared as JSON with keys sorted, millisecond clocks masked,
# the runtime field of /api/about masked, a volume's free bytes masked (the
# disk moves between two reads) and canopy-server's config dir named as the
# Bun server's. A few routes are asked again with a query (clips by id,
# history over 90 days).
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
{"self": "scratch", "keepShells": true, "historyBin": "$S/no/claude-history",
 "ranger": {"on": true, "telegram": true, "handle": "ranger-scratch", "profile": "Bad", "fresh": {"daily": null, "maxMb": 40.4}},
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
# the settings reads (settings_reads.rs): clips around now, so the prune's
# age cut lands well clear of either server's clock
now=$("$bun" -e 'console.log(Date.now())')
H=3600000
D=$((24 * H))
F=$(printf 'f%.0s' $(seq 1 64))
cat >"$S/seed/clips.json" <<JSON
[{"id": "c-aaaaaaaa", "text": "ship it", "source": "shell", "at": $((now - H)), "createdAt": $((now - 2 * H)), "count": 3, "from": " app \\n  main ", "device": {"id": "0123456789abcdef", "name": " desk ", "platform": "Mac OS"}},
 {"id": "c-bbbbbbbb", "text": "old", "source": "cli", "at": $((now - 20 * D))},
 {"id": "c-cccccccc", "text": "pinned old", "source": "page", "at": $((now - 20 * D)), "pinned": true},
 {"id": "c-dddddddd", "text": "x", "source": "clipboard", "at": $((now - 3 * H)), "cut": true, "file": {"name": "a/b.pdf", "type": "Application/PDF; q=1", "size": 3, "sha": "$F"}},
 {"id": "c-eeeeeeee", "text": "bad source", "source": "mail", "at": $now},
 {"id": "c-aaaaaaaa", "text": "again", "source": "page", "at": $now},
 {"id": "c-ffffffff", "text": "two", "source": "canopy", "at": $((now - 4 * H)), "count": 2.0, "cut": true},
 "nothing"]
JSON
# a key on disk reads locked (on a Mac canopy-server leaves it to the keychain: 501)
printf 'wrapped\n' >"$S/seed/secrets-key.age"
printf '{"pin": "%s=", "remote": null}\n' "$(printf 'A%.0s' $(seq 1 43))" >"$S/seed/secrets-config.json"
mkdir -p "$S/seed/ranger" "$S/seed/worktrees"
cat >"$S/seed/ranger/state.json" <<'JSON'
{"session": "0123abcd-0123-0123-0123-0123456789ab", "sessionAt": 1764300000000, "exitedAt": 1764300000500, "exitCode": null, "fails": 2.0, "previous": "x", "junk": true}
JSON
cat >"$S/seed/ranger/wakes.json" <<'JSON'
[{"id": "0000000a", "by": "eric", "prompt": "morning", "created": 7.0, "cron": "0 8 * * *", "next": 2.5},
 {"id": "0000000b", "by": "run", "from": "r-12", "prompt": "look", "created": 1, "run": "r-9"},
 {"id": "0000000c", "by": "ranger", "prompt": "at a time", "created": 1, "cron": "nope", "at": 5},
 {"id": "nothex!!", "by": "eric", "prompt": "x", "created": 1, "at": 5},
 {"id": "0000000d", "by": "run", "prompt": "no from", "created": 1, "run": "r-1"}]
JSON
cat >"$S/home/.claude/settings.json" <<'JSON'
{"enabledPlugins": {"telegram@claude-plugins-official": true}}
JSON
mkdir -p "$S/root/app/.canopy"
printf '{"gates": [{"name": "t", "run": " true "}], "warm": 2}\n' >"$S/root/app/.canopy/gates.json"
for side in bun rs; do cp -R "$S/seed" "$S/config-$side"; done

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
  about worktrees voice sources
  clips?ids=c-dddddddd,c-bbbbbbbb,nope history?window=90d&refresh=1"
same=0
unported=()
differ=()
# a query's ? must not glob
set -f
for p in $routes; do
  f=$(echo "$p" | tr '/?=,&' '_____')
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
    if isinstance(v, dict): return {k: ("<runtime>" if k == "bun" else "<free>" if k == "free" and isinstance(x, (int, float)) and x > 0 else mask(x)) for k, x in v.items()}
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
set +f
echo "same: $same"
echo "not ported (501): ${#unported[@]} (${unported[*]})"
if [ ${#differ[@]} -gt 0 ]; then
  echo "DIFFERS: ${differ[*]}" >&2
  exit 1
fi
[ "${CANOPY_PARITY_KEEP:-}" = 1 ] && echo "bun on :$bp, canopy-server on :$rp"
exit 0
