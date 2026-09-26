# tailchan in canopy

tailchan is the tailnet-only message broker on the mini (`homelab/services/tailchan`,
port 7855): channels, DMs, private channels, a clipboard channel and a blob store,
with a bash CLI and the homelab `tailchan` skill. This spec puts it to work in
canopy in four phases. The user asked for all four, phase 1 first.

## Phase 1: agents in canopy shells can use tailchan

A Claude session in a canopy shell on the mini runs `tailchan whoami` and gets
`claude-<6 of the session id>` on node `macmini-2018`, and can DM, wait and read
like a session on the Mac.

What stood in the way, and the fix for each:

- **The firewall.** ufw on the mini denies incoming by default and allows docker
  networks only in 172.16.0.0/12. canopy's compose network is 192.168.48.0/20, so
  a shell's request to the host's own tailnet address timed out. Fix: one ufw
  rule, tcp 7855 from 192.168.48.0/20 ("canopy to tailchan").
- **The broker's identity check.** Past the firewall, the request arrives from
  the bridge address, which is not 100.64.0.0/10 and which WhoIs cannot name.
  Fix: `TRUST_NETS` in the broker, `cidr=node` pairs (nothing wider than /16, so
  a slip cannot trust the LAN). The mini's `.env` sets
  `TRUST_NETS=192.168.48.0/20=macmini-2018`. Anything on canopy's compose network
  now counts as the mini. That includes the tunnel's cloudflared, which only
  forwards to canopy, and canopy already hands its Access users a shell on the
  mini, so this grants nothing new.
- **The CLI.** The dev tree is mounted at the host's path, so
  `/home/eric/dev/homelab/services/tailchan/tailchan` is already inside the
  container. `~/.claude/shell/bashrc` (dotclaude, sourced by the container's
  `~/.bashrc`) appends that directory to PATH when no `tailchan` is installed.
  The CLI's built-in default URL is the broker, so no config file is needed.
- **The skill.** The mini has no homelab plugin. `~/.claude/skills/tailchan` on
  the mini is a symlink to `/home/eric/dev/homelab/skills/tailchan`, which
  resolves inside the container for the same reason.

Nothing in the shells service or the Dockerfile's `shells` stage changed, so no
held shell was dropped. The container has no clipboard tool: `clip push -` and
`clip show` work there, `clip push` and `clip pull` against a local clipboard do
not. The browser's clipboard is phase 2.

## Phases 2 to 4: canopy itself speaks tailchan

### Configuration

The server talks to the broker only when it knows its address:
`CANOPY_TAILCHAN_URL`, else `TAILCHAN_URL`, else `TAILCHAN_URL` in
`~/.config/tailchan/env` (the CLI's own config, so the Mac's canopy needs nothing
new). The UI speaks as one handle: `CANOPY_TAILCHAN_AS`, else `TAILCHAN_HUMAN`
(env, then the same file), else `canopy-user`. canopy's own posts go out as
`canopy` to `#canopy`. Without a URL every `/api/tailchan*` route answers 503 and
the UI shows nothing tailchan.

### The server

- `src/core/tailchan.ts`, browser-safe and pure: `chanTarget("#x" | "@h")`,
  `dmPeer(channel, me)`, `shellHandle(repoName, termId)`, `parseSse(buffer)`, and
  the phase 3 notices (`runNotice`, `flowNotice`, `fleetNotice`). Tested.
- `src/core/chan.ts`, the client: `Chan` over an injected `fetch`, one method
  per broker call it uses (`who`, `channels`, `read`, `send`, `sub`, `putBlob`,
  `getBlob`, `stream`). `stream` reconnects at doubling waits up to 30s and
  resumes from the last id it saw, the way the CLI's `watch` does.
- The server keeps one stream open as the UI's handle, which follows its
  subscriptions and DMs, and broadcasts each message as a `chan` event. It also
  subscribes that handle to `#canopy` once, so canopy's own posts reach it. A
  message the UI sends is broadcast by the server too, since the broker never
  echoes a post to its sender.
- Routes: `GET /api/tailchan` (`TailchanInfo`: ready, the handle, `who`,
  `channels`, `notify`), `GET /api/tailchan/read?target=&n=`,
  `POST /api/tailchan/send {target, body, kind}` (text or clip),
  `POST /api/tailchan/put?target=&name=` (raw body, a blob plus its object
  message), `GET /api/tailchan/blob?id=`, `POST /api/tailchan/notify {on}`.

### Phase 2: the tailchan surface in the UI

- A top-bar chip, `✉ n`, where n counts messages that arrived since the popover
  was last open, not counting the UI's own.
- The popover: the conversations (subscribed channels and DMs, newest first),
  the open one's last 50 messages with a composer, the `who` list with a live
  dot (a click opens the DM), and a clipboard row: send the clipboard (from
  `navigator.clipboard` on a secure page, else a text box) and copy the latest
  clip. An object message links to `/api/tailchan/blob`.
- The feed gets a `tailchan` source, one line per message.
- The pure parts live in `ui/src/chan.ts` (conversation names, merging and
  capping messages, unread counts). Tested.

### Phase 3: canopy posts its events

When config `tailchanNotify` is on (a checkbox at the bottom of the tailchan
popover, off by default; it is the backend's setting, so it sits with tailchan
rather than in the per-browser Settings), canopy
posts to `#canopy`, silently: a run's end and outcome, a flow's end, a fleet's
end. Events that wait on the user go to the human handle as a DM, which pings
Telegram: a run parked on a permission or question prompt, and a flow stopped at
an `ask` gate. Each run, flow or fleet transition posts once.

### Phase 4: shells have handles

- Every new shell starts with `TAILCHAN_AS=<repo slug>-<4 of the shell id>`
  (`shellHandle`), set through `tmux new-session -e` or the pty's env, so a
  Claude session inside it is reachable under a name that says where it is.
  A restored shell keeps its id and so its handle. Shells started before this
  change keep the session-id default.
- `TermInfo` gains `handle`. The shells picker shows it, a live dot from the
  broker's `who`, and a "message" button that opens the popover on that DM.

## Testing

Unit tests for `tailchan.ts`, `ui/src/chan.ts` and the tmux argv with `-e`. A
server test runs the routes against a stand-in broker (a `Bun.serve` that
answers the few endpoints used). The end-to-end check for phases 2 to 4 is a
browser on the built UI: a DM from the CLI shows in the popover and the feed, a
reply from the composer reaches the CLI, and a new shell's `tailchan whoami`
prints its shell handle.

## Out of scope

Blob drops into a shell as a file, broker-side changes beyond `TRUST_NETS`, and
per-browser handles.
