#!/usr/bin/env bash
# Shells on tmux, side by side: starts a scratch Bun server and a scratch
# canopy-server, each with tmux on and a config dir of its own (so each has
# its own tmux server on <config>/tmux.sock), opens one shell on each over
# the /api/term websocket with a ticket, as the page does, and drives both
# through the same steps: the list, the kept records, the pane's text and
# screen, watched and agent, a rename and a move, the socket leaving, the
# end, and the refusals (a rejoin for a shell that is gone, a malformed
# name, an unknown repo, keys for no shell). Each answer is compared as JSON
# with keys sorted, millisecond clocks masked and canopy-server's config dir
# named as the Bun server's. Exits 1 when a step differs.
#
# Every tmux command here carries the scratch socket (-S), and the scratch
# dir sits under /tmp so the socket's path stays short. Both servers run
# under env -i with a scratch HOME, CANOPY_TAILCHAN_URL=off and loopback
# auth, so neither reads ~/.config/canopy, dials a broker or takes port 7850.
#
#   bash scripts/rust-shell-parity.sh
#
# CANOPY_PARITY_KEEP=1 keeps the scratch dir with both answers to each step
# (bun.<step>, rs.<step>) and both logs.
set -euo pipefail
here=$(cd "$(dirname "$0")/.." && pwd)
bun=$(command -v bun)
tmux=$(command -v tmux || true)
if [ -z "$tmux" ]; then
  echo "no tmux on this machine: nothing to compare" >&2
  exit 0
fi
server="$here/rust/target/debug/canopy-server"
(cd "$here/rust" && cargo build -q -p canopy-server)
[ -f "$here/dist/web/index.html" ] || (cd "$here" && bun run build >/dev/null)

S=$(mktemp -d /tmp/csp.XXXXXX)
S=$(cd "$S" && pwd -P)
pids=()
stop() {
  for p in "${pids[@]}"; do kill "$p" 2>/dev/null || true; done
  for side in bun rs; do
    [ -S "$S/config-$side/tmux.sock" ] && "$tmux" -S "$S/config-$side/tmux.sock" kill-server 2>/dev/null || true
  done
  [ "${CANOPY_PARITY_KEEP:-}" = 1 ] && echo "kept $S" || rm -rf "$S"
}
trap stop EXIT

mkdir -p "$S/root" "$S/home" "$S/seed/shells"
for r in app web; do
  git init -q -b main "$S/root/$r"
  git -C "$S/root/$r" -c user.name=t -c user.email=t@t commit -q --allow-empty -m first
done
echo '{"self": "scratch"}' >"$S/seed/config.json"
# two kept records: one an hour old, offered, and one a month old, expired
now=$(date +%s)000
old=$((now - 30 * 86400000))
recent=$((now - 3600000))
echo "{\"id\":\"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\",\"repoId\":\"app\",\"path\":\"$S/root/app\",\"place\":\"strip\",\"startedAt\":$recent,\"savedAt\":$recent,\"lines\":3,\"agent\":null,\"label\":\"kept\"}" >"$S/seed/shells/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.json"
echo "{\"id\":\"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\",\"repoId\":\"web\",\"path\":\"$S/root/web\",\"place\":\"panel\",\"startedAt\":$old,\"savedAt\":$old,\"lines\":1,\"agent\":\"claude\"}" >"$S/seed/shells/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.json"
for side in bun rs; do cp -R "$S/seed" "$S/config-$side"; done

free() { "$bun" -e 'const s = Bun.serve({ port: 0, fetch: () => new Response() }); console.log(s.port); s.stop(true);'; }
bp=$(free)
rp=$(free)
if [ "$bp" = 7850 ] || [ "$rp" = 7850 ]; then
  echo "a free port came back as 7850" >&2
  exit 1
fi
common=(HOME="$S/home" PATH="$(dirname "$bun"):/usr/local/bin:/usr/bin:/bin" SHELL=/bin/bash LANG=C.UTF-8 TZ=UTC
  CANOPY_LOOPBACK_AUTH=1 CANOPY_PREVIEW_PORTS=0 CANOPY_NO_DESKTOP=1 CANOPY_AGENT_SCAN=0 CANOPY_TAILCHAN_URL=off)
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
# a page's stream on each, so the shell's socket has a device to name
for port in $bp $rp; do
  curl -sN "http://127.0.0.1:$port/api/events?client=0123456789abcdef&name=desk&platform=mac" >/dev/null 2>&1 &
  pids+=($!)
done
sleep 2

cat >"$S/drive.ts" <<'TS'
// One server through the steps, each answer saved as "status N\n<body>".
const [port, out] = process.argv.slice(2);
const base = `http://127.0.0.1:${port}`;
const ID = "0123456789abcdef0123456789abcdef";
const GONE = "ffffffffffffffffffffffffffffffff";
const save = (step: string, status: number, body: string) => Bun.write(`${out}.${step}`, `status ${status}\n${body}`);
async function call(step: string, path: string, init?: RequestInit) {
  const res = await fetch(base + path, init);
  await save(step, res.status, await res.text());
}
const post = (body: unknown): RequestInit => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
async function ticket(): Promise<string> {
  const res = await fetch(`${base}/api/auth/ticket`, post({ for: "term" }));
  return ((await res.json()) as { ticket: string }).ticket;
}
async function until(pred: () => boolean, what: string) {
  for (let i = 0; i < 300 && !pred(); i++) await Bun.sleep(50);
  if (!pred()) throw new Error(`gave up waiting for ${what}`);
}
function open(q: Record<string, string>) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/api/term?${new URLSearchParams(q)}`);
  ws.binaryType = "arraybuffer";
  let text = "";
  const frames: string[] = [];
  let closed: { code: number; reason: string } | null = null;
  ws.onmessage = (e: MessageEvent<ArrayBuffer | string>) => {
    if (typeof e.data === "string") frames.push(e.data);
    else text += new TextDecoder().decode(new Uint8Array(e.data));
  };
  ws.onclose = (e) => (closed = { code: e.code, reason: e.reason });
  return { ws, text: () => text, frames, closed: () => closed };
}

const shell = open({ id: "app", term: ID, place: "panel", cols: "100", rows: "30", client: "0123456789abcdef", label: " parity ", ticket: await ticket() });
// typed once the prompt is up: a line sent while the shell starts is echoed
// early, and the Bun server counts no keystroke before the shell is held
await until(() => shell.text().includes("$ "), "the prompt");
shell.ws.send(new TextEncoder().encode("printf 'parity-%s\\n' ok\n"));
await until(() => shell.text().includes("parity-ok"), "the shell's line");
await Bun.sleep(500);
await call("terms", "/api/terms");
await call("kept", "/api/terms/kept");
await call("text", `/api/terms/text?term=${ID}`);
await call("screen", `/api/terms/screen?term=${ID}`);
await call("watched", `/api/terms/watched?term=${ID}`);
await call("agent", `/api/terms/agent?term=${ID}`);
await call("label", "/api/terms/label", post({ term: ID, label: "renamed" }));
await call("place", "/api/terms/place", post({ term: ID, place: "strip" }));
await call("terms-after", "/api/terms");
shell.ws.close();
await until(() => shell.closed() !== null, "the socket to close");
await Bun.sleep(300);
await call("terms-left", "/api/terms");
const rejoin = open({ id: "app", term: ID, attach: "1", cols: "100", rows: "30", ticket: await ticket() });
await until(() => rejoin.text().includes("parity-ok"), "the rejoin's screen");
await call("terms-rejoined", "/api/terms");
await call("delete", `/api/terms?term=${ID}`, { method: "DELETE" });
await until(() => rejoin.closed() !== null, "the exit");
await save("exit", rejoin.closed()?.code ?? 0, JSON.stringify(rejoin.frames));
await call("terms-ended", "/api/terms");
await call("kept-ended", "/api/terms/kept");
await call("delete-again", `/api/terms?term=${ID}`, { method: "DELETE" });
await call("text-gone", `/api/terms/text?term=${GONE}`);
await call("keys-gone", "/api/terms/keys", post({ term: GONE, key: "escape" }));
await call("label-bad", "/api/terms/label", post({ term: ID }));
await call("bad-name", "/api/term?id=app&term=t1");
await call("bad-repo", `/api/term?id=nope&term=${ID}`);
const gone = open({ id: "app", term: GONE, attach: "1", ticket: await ticket() });
await until(() => gone.closed() !== null, "the refusal");
await save("rejoin-gone", gone.closed()?.code ?? 0, gone.closed()?.reason ?? "");
const kept = open({ id: "app", term: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", ticket: await ticket() });
await until(() => kept.closed() !== null, "the refusal");
await save("start-kept", kept.closed()?.code ?? 0, kept.closed()?.reason ?? "");
process.exit(0);
TS
for side in bun rs; do
  port=$bp
  [ $side = rs ] && port=$rp
  if ! env -i HOME="$S/home" PATH="$(dirname "$bun"):/usr/bin:/bin" "$bun" "$S/drive.ts" "$port" "$S/raw-$side" >"$S/drive-$side.log" 2>&1; then
    echo "the $side steps failed:" >&2
    cat "$S/drive-$side.log" >&2
    exit 1
  fi
done

steps="terms kept text screen watched agent label place terms-after terms-left terms-rejoined delete exit
  terms-ended kept-ended delete-again text-gone keys-gone label-bad bad-name bad-repo rejoin-gone start-kept"
same=0
differ=()
for step in $steps; do
  for side in bun rs; do
    python3 - "$S/raw-$side.$step" >"$S/$side.$step" <<'PY'
import json, sys
status, _, raw = open(sys.argv[1]).read().replace("/config-rs", "/config-bun").partition("\n")
def mask(v):
    if isinstance(v, dict): return {k: mask(x) for k, x in v.items()}
    if isinstance(v, list): return [mask(x) for x in v]
    if isinstance(v, (int, float)) and not isinstance(v, bool) and 1_000_000_000_000 <= v < 10_000_000_000_000: return "<ms>"
    return v
print(status)
try: print(json.dumps(mask(json.loads(raw)), indent=1, sort_keys=True))
except Exception: print(raw)
PY
  done
  if diff -q "$S/bun.$step" "$S/rs.$step" >/dev/null; then
    same=$((same + 1))
  else
    differ+=("$step")
    diff "$S/bun.$step" "$S/rs.$step" | head -20 || true
  fi
done
echo "same: $same of $(echo $steps | wc -w)"
if [ ${#differ[@]} -gt 0 ]; then
  echo "DIFFERS: ${differ[*]}" >&2
  exit 1
fi
exit 0
