# PRD: canopy as a shared backend

Status: Phases 1 to 4 resolved (2026-09-22): 1 to 3 deployed and verified, Phase 4's redeploy survival deployed and verified, its reboot restore decided against for now
Owner: Eric
Last updated: 2026-09-22

## Summary

Today canopy runs on the machine you sit at, and it quietly assumes the server's
host and your desktop are the same computer. This document is the plan to break
that assumption: run one always-on canopy in a container on the mini (now on
Omarchy, so a plain Linux host), serve it to every device on the tailnet and
beyond, and give each client the same in-browser cockpit. The few actions that
touch a physical desktop, the openers, become client capabilities: advertised
per client, run on the client, hidden where the client cannot do them.

The work is staged. Phase 1 is the headless container and a uniform in-browser
core from any device. Phase 2 makes the desktop openers follow the client.
Phase 3 makes the multi-device experience first-class over the tailnet, presence
and cross-device sessions, with any public reach optional and gated. Phase 4 is
durability, which is explicitly out of scope until then. A restart loses the
running shells and their AI sessions, and for now that is fine (as of
2026-09-22 a canopy restart no longer does; a reboot still does). It is one user
(you), on one tailnet, using your `claude` and `codex` subscriptions, no API
keys.

## Background and current state

canopy is a multi-repo git cockpit: a Bun + TypeScript server, a React 19 + Vite
SPA, and a CLI. The server scans a folder for `.git` dirs, runs git, watches the
tree, and streams updates to the browser over SSE. It also hosts shells (xterm
in the browser over a websocket to a pty), runs the user's `claude` binary for
jobs and chat, and drills into commits and diffs.

Two facts shape this plan:

- **The core is already host-of-the-backend and that is correct.** Git state,
  shells, runs, search, diffs, history, and chat all belong to wherever the repo
  physically lives. Serving them from one backend to many clients needs almost
  no rethinking. The SPA is already one app, the state already lives on the
  server, and per-browser preferences already live in each client's
  localStorage.
- **The openers are the exception.** "Open in kitty / Terminal / Finder / VS
  Code", the agent and herdr launchers, and the app launcher build an argv and
  run it on the server's host through macOS `open` and `osascript`. When the
  server was your own Mac, that was your desktop. With the backend on the mini,
  the server running `open` targets the mini's desktop, which is wrong or
  headless. An audit of the coupling is in the appendix.

Phase 0 already happened in part: shells now survive a canopy process restart
through a private tmux server (built this session, not yet shipped). That is
process-restart survival, not machine-reboot survival, and it is orthogonal to
this plan. It stays useful but is not required by Phase 1.

## Goals

- One always-on canopy backend, containerized, on the mini, reachable from any
  device on the tailnet.
- Identical core behavior in every client browser: git, shells, Claude, search,
  diffs, history, chat. A phone gets the same core a laptop does.
- Actions that touch a desktop are client capabilities, gated by a per-client
  config and executed on the client, never silently run on the backend host.
- A path past the tailnet ("and beyond") with real authentication.

## Non-goals (for now)

- Surviving a container restart or a machine reboot. Deferred to Phase 4
  (a container restart is survived since 2026-09-22; a reboot is not).
- Multi-user or multi-tenant canopy. One user, many devices.
- Replacing the local-Mac mode. `canopy ui ~/dev` on a Mac stays exactly as it
  is; this adds a deployment shape, it does not remove one.
- Freezing and resuming a live Claude process. No design does this; Phase 4
  reconstructs sessions, it does not resume processes.

## Target architecture

One backend, many thin clients.

- **Backend.** Headless canopy in a container on the mini. It serves the SPA and
  the API, scans repos that live on the mini or arrive as ssh sources, hosts the
  shells and the Claude runs, and is on the tailnet through a tailscale sidecar.
  It has no desktop and does not try to open one.
- **Client.** Any browser on the tailnet. It renders the cockpit, holds only its
  own preferences and layout in localStorage, and declares its capabilities to
  the backend on connect. Optionally it runs a small local helper that lets the
  browser drive that machine's own desktop for the openers.
- **The cut.** Every action is either a backend-host action (runs where the repo
  is, identical for all clients) or a client-host action (runs on the client,
  gated by capability). Nothing that touches a desktop runs on the backend.

```
   phone        laptop            mini (Omarchy, Linux)
  browser      browser  +helper   +-----------------------------+
     |            |        |       |  container: canopy (headless) |
     +----- tailnet -------+------>|   SPA + API + SSE            |
                  |                |   git scan + fs.watch        |
     vscode-remote://ssh...        |   tmux shells (ptys)         |
     (opens on the client)         |   claude runs / chat         |
                                   |  tailscale sidecar           |
                                   +-----------------------------+
                                        |  repos on the mini
                                        |  or ssh sources ->  other hosts
```

## Personas and scenarios

- **At the mini.** Local browser to `127.0.0.1:7850`. Full desktop openers work
  because the client and the backend are the same machine. This is the baseline
  the others are measured against.
- **On the laptop.** Browser over the tailnet. Core is identical to the mini.
  VS Code opens locally through a Remote-SSH link into the mini. With the Phase 2
  helper, kitty and Terminal open on the laptop too.
- **On the phone.** Browser over the tailnet. Core works: read status, open a
  shell, drive a Claude run, read diffs, chat. The desktop openers are hidden,
  not broken.
- **Off the tailnet (Phase 3).** Reach canopy through an authenticated public
  origin. Same client model, plus an auth gate.

## The action model

The one concept the whole plan rests on.

- **Backend-host actions** stay server-side and are the same for every client:
  the in-browser shell, Claude runs and chat, all git operations, commit / push
  / pull, search, diffs, history, workflows and fleets. These belong to the repo,
  and the repo is on the backend. No change beyond deployment.
- **Client-host actions** are the openers. They belong to the machine the user
  is sitting at. Each is advertised per client and executed on the client. When
  the client cannot do one, the UI hides it rather than showing a dead control.

How a client-host action runs, cleanest first:

| Opener | Mechanism | Needs a helper? |
| --- | --- | --- |
| VS Code (repo on the mini) | `vscode-remote://ssh-remote+mini/<path>` link | No |
| VS Code (repo local to the client) | `vscode://file/<path>` link | No |
| kitty / Terminal | local helper runs the terminal on the client | Yes |
| Finder / file manager | local helper opens the folder on the client | Yes |
| agent / herdr | local helper starts the session on the client | Yes |
| in-browser shell / Claude | already backend-host, no opener needed | n/a |

The in-browser shell already gives a terminal at the repo and the in-browser
Claude already gives the agent, so for a remote backend the native terminal
openers are partly redundant. VS Code is the opener that clearly still earns its
place, and it is the one that needs no helper.

## Phase 1: containerized headless backend on the mini

**Objective.** One canopy backend in a container on the mini, serving the full
in-browser core to any device on the tailnet, with the desktop openers reduced
to what needs no client helper.

**Status (2026-09-22): deployed on the mini and verified from a second
device.** The container runs from the repo checkout at
`/home/eric/dev/dev-tools/canopy` (`docker compose up -d --build`, settings in
its `.env`), published on the mini's tailnet address only, reachable as
`http://macmini-2018:7850`. The mini is already a tailnet node, so there is no
sidecar in the default compose; `docker-compose.sidecar.yml` keeps that shape
for a host that is not. Verified over the tailnet from the Mac with a probe
script against the API: the tree carries `backend.openers=false` and
`sshHost=macmini-2018`; a shell opens in bash at the repo with `claude` and
`codex` on its PATH, is held after its socket drops and ends on request; a
Claude chat answers (`PONG`, on the mounted Max login, no API key); grep, log,
commit and per-file diff answer; the openers, file-open and the launcher's
install/build/launch refuse with `NO_DESKTOP`; a file written on the mini
raises a `repo` event through the bind mount within a second; and a container
restart brings the API back in two seconds with no orphan shells, an old tab's
rejoin answered `4404 that shell is gone`.

Four things the container taught us, all fixed: a container sets no `SHELL`
and the image has no zsh, so `userShell()` now falls back to bash off a Mac
and the image sets `SHELL=/bin/bash` (before that every tmux session died at
birth); claude refuses `--dangerously-skip-permissions` as root, so the
container runs as the image's `bun` user remapped to the host uid, which also
makes the mounted tree, `~/.claude` and `~/.codex` its own files; the image's
`BUN_INSTALL_BIN=/usr/local/bin` is not writable by that user, so global
installs go under its home; and the Library's CSRF guard took only localhost
or an HTTPS proxy origin, so `/library/*` was a 403 from every device until
`libraryOriginAllowed` learned that a same-origin request by a tailnet name
is as good as one by localhost when the server listens beyond loopback. Still
off, by omission rather than design: the history section, since the image has
no claude-history (see deploy.md for the `historyBin` line once its checkout
is on the mini). The mini's `~/dev` is a
mirror of the Mac's since the same day (see the Decisions section): the first
sync landed 139 repos, the backend rescanned on its own at the end of the run,
and the phone and the Mac both see them.

**Scope.**

- A headless build and run mode. The server must start and serve without a
  desktop, without opening a browser (`--no-open`, already added), and without
  assuming macOS.
- A Dockerfile (Bun base, git, tmux, `claude`, `codex`, nodejs for codex's
  wrapper, the Python 3 stdlib for the Library, running as the host user) and
  a docker-compose with:
  - the canopy service, its port published on the host's tailnet address
    (`CANOPY_LISTEN` in `.env`, loopback when unset) since the mini is
    already a tailnet node,
  - a `tailscale/tailscale` sidecar as an override file
    (`docker-compose.sidecar.yml`, `network_mode: service:ts`) for a host that
    is not on the tailnet,
  - a bind mount of the canonical `~/dev` on the mini for the repo tree (ssh
    config and keys only for the repos kept on other hosts),
  - a persistent volume for `$CANOPY_CONFIG_DIR`,
  - bind mounts carrying the authenticated `claude` and `codex` subscription
    logins (`~/.claude`, `~/.claude.json`, `~/.codex`), no API keys.
- Gate every host-touching opener behind a capability check that, in Phase 1, is
  a static "this backend has no desktop". Those openers are hidden. VS Code stays
  as a Remote-SSH link, computed from the repo's locator, and works because a
  link is client-side by nature. A hidden opener never errors.
- The launcher (dmg / `.app` / `open -W`) is macOS-only and is disabled on a
  Linux backend, cleanly, with a one-line reason in the UI.

**Requirements.**

- The server refuses none of its core routes on Linux. Shells, runs, git,
  search, diffs, history, chat all work in the container.
- `fs.watch` recursive works against the mounted repo tree on Omarchy (native
  Linux inotify, so this holds; verify for bind mounts).
- `claude` and `codex` run on linux-x64 (the 2018 mini is Intel) with the
  mounted subscription logins, no API keys. A `claude` run started from any
  client executes in the container; `codex` runs the same way inside a shell.
- Reaching `http://<mini-tailnet-name>:7850` from a laptop and a phone renders
  the same cockpit and the same repos.

**Deliverables.** `Dockerfile`, `docker-compose.yml`, a short `docs/deploy.md`,
the opener capability gate (Phase 1 form), the Linux launcher disable, and the
VS Code Remote-SSH link path.

**Acceptance criteria.**

- From a second device on the tailnet: open a repo, open a shell, type in it,
  start a Claude chat, get a reply, read a diff, run a search. All succeed.
  (Met 2026-09-22 from the Mac against the mini, at the API.)
- On a phone: the same, minus the desktop openers, which are absent from the menu
  rather than present and broken. (Met 2026-09-22 on the Fold 8 over the
  tailnet, driven through Chrome's DevTools socket: the card menu holds chat,
  ask, agent settings, shell, the git remote and the VS Code Remote-SSH link
  and nothing else; a shell opened from it runs bash in the container with
  `claude` and `codex` on PATH.)
- Restarting the container loses the shells and their Claude sessions, and the
  UI recovers cleanly on reload (no orphan tabs, no errors). This is expected,
  not a bug. (Met: the API is back in two seconds, `/api/terms` is empty, and
  a tab naming the old shell is told it is gone.)
- VS Code opens from a client through the Remote-SSH link at the right path.
  (The link is `vscode-remote://ssh-remote+macmini-2018/home/eric/dev/<repo>`;
  the Mac's ssh config has that alias.)

**Risks and mitigations.**

- **Bind-mount file watching.** Native Linux is fine; confirm inotify fires
  through the specific mount. If a mount is flaky, fall back to the ssh-source
  path, where the repo is walked rather than watched.
- **Claude auth in a container.** The one real setup cost. Mount an already
  logged-in `~/.claude` into the config volume, or log in once inside the volume.
  Document it in `deploy.md`.
- **Arch.** Intel mini means linux-x64; note it so an Apple-silicon-on-Asahi mini
  would need arm64 instead.

**Out of scope.** Any client helper, any durability, any off-tailnet reach.

## Phase 2: client capability model and the local opener helper

**Objective.** Make the desktop openers follow the client. A laptop opens kitty
on the laptop; a phone shows no terminal opener; the backend never runs a
desktop command.

**Status (2026-09-22): deployed on the mini and verified from the Mac.** The
shape changed from the plan below in two respects, both recorded under
Decisions: the helper dials the backend rather than the browser dialling the
helper, and a browser names its helper rather than being matched by address.
`canopy helper --backend http://macmini-2018:7850` on a client opens a
websocket to `GET /api/helper?name=&platform=&openers=` and stays on it
(reconnecting at doubling waits when the backend restarts, seen live across a
redeploy); the backend keys helpers by name, lists them at `GET /api/helpers`
and broadcasts the list as a `helpers` SSE event on every attach and detach;
`GET /api/client` says what it knows of a browser (its address, whether that
is the backend's own Mac, whether it is a proxy's address many browsers
share). The browser derives what it can open through the pure `clientCaps`
(`core/client.ts`): its picked helper (the `helper` setting, chosen once in
the settings popover), else the one helper at its own address when that
address is real, else the backend's own desktop when it is on it, else
nothing. The three open routes (`/api/repos/open`, `/api/repos/openfile`,
`/api/workspaces/open`) take `helper` in the body and relay an intent to that
helper with the repo rewritten to `ssh://$CANOPY_SSH_HOST<path>`, waiting for
its reply (20s, then 504); a helper's error is the request's 502. The helper
runs the same `openIn`, `openFile` and `openGroup` a Mac backend does, now
with Linux argv builders next to the macOS ones (kitty `--detach`, `xdg-open`
for the folder, no Terminal.app, agent through kitty). `RepoMenu`, the
workspace buttons and the settings popover read the derived caps; the VS Code
link shows when the client has no `code` opener. Pure protocol in
`core/helper.ts` and decisions in `core/client.ts` (both tested), daemon in
`core/helperd.ts`, relay tested end to end against a real server with a fake
helper in `server/helper.test.ts`, CLI `canopy helper`. Verified: with the
helper running on the Mac and picked in Chrome there, "kitty" in the canopy
card's menu at `http://macmini-2018:7850` opened a kitty window on the Mac
running `ssh -t macmini-2018 cd /home/eric/dev/dev-tools/canopy && exec
$SHELL -l`, and the mini showed the login from the Mac's tailnet address with
its shell in that folder; the container ran nothing. The rest of the menu
(shell, chat, workflows) is unchanged.

**Scope.**

- **A client config and a capability handshake.** On connect, a client declares
  what it is and what it can drive: platform, whether a local helper is present,
  and which openers that helper supports. The store already keeps per-browser
  settings; this adds a capability set alongside them.
- **Capability-gated menus.** `RepoMenu` builds its "open in" and "with claude"
  groups from the client's advertised capabilities instead of assuming macOS.
  Absent capabilities are absent controls.
- **A small per-client helper.** A daemon on the client machine that runs an
  opener there (`open -a kitty …` on a Mac, the Omarchy equivalent on Linux,
  and so on). The server's role shrinks to naming the intent ("open repo X,
  folder Y, in kitty"); the client's helper performs it. The existing pure argv
  builders in `openers.ts` are what the helper runs, unchanged. As built: the
  helper dials the backend and the backend relays; see Decisions for why the
  SPA does not call the helper directly.
- **Keep VS Code as a link.** No helper needed; it stays the zero-dependency
  path.

**Requirements.**

- No opener ever executes on the backend host. The server exposes intent, the
  client executes.
- A client with no helper still gets VS Code links and the full in-browser core.
- The helper is optional per machine and per opener. Missing helper means missing
  controls, never errors.

**Deliverables.** The capability handshake and its wire type, the menu gate, a
reference helper for macOS and for Omarchy/Linux, and helper install docs.

**Acceptance criteria.**

- On a laptop with the helper: kitty and Terminal open on the laptop, not on the
  mini. (Met 2026-09-22: kitty on the Mac from the mini's UI, see the status
  note.)
- On a laptop without the helper: those controls are absent; VS Code and the core
  still work. (Met: `client.openers` is empty without a helper, the menu shows
  the VS Code link and the shell, and the core is untouched.)
- On a phone: no terminal or file-manager openers; core intact. (Met by the same
  gate; a phone runs no helper.)
- The backend host runs no `open`/desktop command for any client action. (Met:
  a headless backend answers 400 for the open routes unless a helper is
  attached for the asking address, and then only relays.)

**Risks and mitigations.**

- **Helper distribution and trust.** It runs local commands on request, so the
  channel it takes orders on matters. As built the helper accepts intents only
  over the socket it opened itself, to the backend it was pointed at, over the
  tailnet; nothing listens on the client. The backend is the trust edge, as it
  already is for every mutating git route. A stranger on the tailnet could
  attach a helper under your address only by sharing your machine.
- **Matching a browser to a helper.** The first build matched by source
  address and fell over at once on the mini: docker's published port hands the
  container its own gateway (`192.168.48.1`) as the source of every
  connection (the `docker-proxy` for 7850 is there next to the DNAT rule, and
  the proxy is what delivers the tailnet traffic), so the Mac's browser, its
  helper and the phone all looked alike. So the browser names its helper
  (picked once in settings, kept in that browser), the backend reads its
  default gateway off `/proc/net/route` and marks that address as shared so
  no browser adopts a helper by it, and adoption by address is kept only for
  a backend that sees real addresses (one run straight on a host). The
  settings popover shows the address the browser is seen as. The trust
  question this raises, that any browser on the tailnet can pick any attached
  helper, is the same single-user trust the whole backend already rests on.
- **Cross-platform openers.** kitty and a Mac Terminal have no shared model.
  Define the opener set per platform in the helper rather than pretending one
  argv fits all.

**Out of scope.** Off-tailnet reach, durability.

## Phase 3: the tailnet as the edge

**Objective.** Make the multi-device experience first-class over the tailnet:
know which client is which, and see and resume sessions across your devices.
Tailscale already reaches every one of your devices from anywhere, so this phase
is about presence and portability, not public exposure. A public edge stays
optional and gated.

**Status (2026-09-22): deployed on the mini and verified from the Mac and the
Fold.** Presence is by browser, not by address: every browser profile makes
itself a 16-hex id once (localStorage `canopy.client`), names itself from the
`device` setting or a guess off the user agent ("Mac, Chrome", "Android,
Chrome"), and sends both on its event stream (`GET /api/events?client=&name=
&platform=`) and on every shell socket (`client=`). The backend folds the
streams into one `Device` per id (`core/presence.ts`, pure and tested) and
broadcasts the list as a `devices` event (debounced 300ms) on every join and
leave; `GET /api/devices` is the same list on demand. Shells carry their
viewers: `TermInfo.viewers` names the devices with a socket on that shell, and
the whole list broadcasts as a `terms` event whenever a shell starts, ends, or
gains or loses a viewer, so a browser learns of a shell opened elsewhere
without polling. A run records the browser that started it (`Run.by`, the
device name) and the console shows it; that part is tested, not exercised
live. The UI has one new piece, the devices
chip in the top bar (`Devices.tsx`: a count, and a popover listing each device
with its platform, how long it has been on, its window count, and the repos
it has a shell in) and one new setting, "this device", the name a browser
shows as. Portability: the store adopts held shells at load and live through
`adoptTerms` (`ui/src/term.ts`, tested), so a shell opened on one device is a
tab on every other, in the strip or in its repo's panel, and joining it
attaches with the same scrollback. Verified live: the Mac's strip shell
appeared as a tab on the Fold and attached with identical scrollback; a shell
the Fold opened at `_control` arrived on the Mac's already-loaded page as a
tab and attached; `GET /api/devices` listed "Mac, Chrome" and "Android,
Chrome", and the popover on the Mac showed both "in a shell at `_control`".
The public edge stays deferred: nothing is exposed and no auth gate was
built, which is the default this phase set out with, so Phase 3 is complete
without it. Shells did not survive the redeploys made during this phase; that
is Phase 4's first bullet, not a Phase 3 claim. Feed lines for devices and
shells (`describeEvent` in `ui/src/feed.ts`) and the server-side tests in
`server/presence.test.ts` (devices from streams, the live shell list with
viewers, a run's `by`) came with it.

**Scope.**

- **Identity and presence.** The backend knows which clients are connected and
  shows it (who has a shell open, who is running a job). This turns "many
  devices, one me" into something the UI reflects and, later, coordinates.
  Built: the devices chip, `Run.by`, and shell viewers.
- **Session portability.** Start a shell or a run on one device, see and resume
  it from another, because both are clients of the same backend. Much of this
  falls out of the shared-backend model; this phase makes it explicit. Built:
  the `terms` event and `adoptTerms` make a shell a tab everywhere as soon as
  it exists; runs were already visible everywhere through the `run` event.
- **Optional public reach (deferred by default).** If a device that cannot run
  Tailscale ever needs in, expose the backend through an authenticated origin
  (tailscale Funnel or a reverse proxy at `canopy.beric.ca`, the seam
  `CANOPY_PUBLIC_ORIGIN` already exists) with an auth gate in front of every
  route, stream, and socket. Not built unless that need appears; the default is
  tailnet-only.

**Requirements.**

- Presence is best-effort and never blocks the core.
- If the optional public edge is ever enabled, no route, stream, or socket is
  reachable through it without auth, and no user data goes in URLs or query
  strings.

**Deliverables.** A presence model in the store and a small UI for it,
cross-device session visibility, and (only if enabled) the auth gate and origin
configuration.

**Acceptance criteria.**

- A shell started on the laptop is visible and resumable from the phone, both on
  the tailnet. Met 2026-09-22, in both directions.
- If the public edge is enabled, an unauthenticated request through it is
  refused and an authenticated one behaves as on the tailnet.

**Risks and mitigations.**

- **A machine-driving tool on a public edge.** The backend runs shells, Claude,
  and Codex with your logins. Keep tailnet-only as the default; the auth gate is
  load-bearing and gets designed before anything is exposed.
- **A client id is a claim, not an identity.** The 16-hex id and the name are
  whatever the browser sends; presence trusts them. That is fine on a tailnet
  of one person's devices and is one more reason the public edge needs an auth
  gate before it exists. A wrong claim costs nothing but a misleading line in
  the popover, since presence gates no action.

**Out of scope.** Durability, multi-user.

## Phase 4: durability

**Objective.** Stop losing work to a restart, then to a reboot. This is the "for
now" in "does not survive restart for now" coming due.

**Status (2026-09-22): redeploy survival deployed on the mini and verified;
reboot restore decided against for now (see Decisions).** The tmux server
that holds every shell runs in a container of its own, the `shells` service
in `docker-compose.yml`, built from a `shells` stage of the same Dockerfile
(the runtime, the user, claude, codex, `lib/tmux.conf` and no canopy code)
and started as `tmux -S /config/tmux.sock -f /app/lib/tmux-server.conf -D`:
the server in the foreground, on the socket in the shared config volume,
with `exit-empty off` (the shared conf's `on` would end it before the first
shell). It has every mount canopy has, since the shells now run there. What
it holds is the shells and what runs in them; a run or chat from the console
is a `claude -p` the canopy container spawns and still ends with canopy. A
healthcheck (`tmux -S … list-sessions`, exit 0 with no session) gates
canopy's start through `depends_on`, so canopy's first `new-session` cannot
start a server of its own inside the canopy container, where it would die
with it. Nothing in canopy changed: its tmux client already spoke to the
socket under the config dir, `listTerms` already adopted the sessions it
found at startup, and the two images come off one base so client and server
agree on the protocol. Verified: with a shell open at `canopy` holding a
marker line, `docker compose up -d --force-recreate --no-deps canopy` (the
crash case) and then `docker compose up -d --build` after a code change
(the redeploy case) each brought canopy back saying "1 held from before",
the `shells` container's start time did not move, and rejoining the shell
from a socket and from the Mac's already-open page replayed the marker. The
migration itself dropped the two shells the old container's tmux held, once,
since that server lived and died with the canopy container.

**Scope, in order of difficulty.**

- **Process-restart survival (done).** The tmux backend already keeps
  shells and their Claude sessions across a canopy process restart. Bring it into
  the container so a canopy redeploy or crash inside the container does not drop
  the shells. Built as the `shells` service, above.
- **Reboot survival of the terminal.** A machine reboot kills the tmux server;
  no in-memory design survives it. Persist each shell's scrollback to disk and,
  on boot, offer to relaunch the shell at the same repo with its history
  restored. This restores the terminal, not the live processes in it.
- **Reboot survival of the work, not the process.** For a shell that was running
  Claude, remember the repo and the session and offer `claude --continue` /
  `--resume` on boot. This reconstructs the conversation; it does not resume a
  frozen process, because that is not possible.

**Requirements.**

- Durability is opt-in and bounded (a cap on persisted scrollback, a retention
  window), so it does not grow without limit.
- A restored shell is clearly marked as restored, not as never having stopped.

**Deliverables.** Scrollback persistence, a boot-time restore flow, and the
Claude `--continue` reattach offer.

**Acceptance criteria.**

- After a container restart, shells and their Claude sessions are still live
  (tmux in the container). Met 2026-09-22.
- After a mini reboot, canopy offers to restore each prior shell with its history
  and, for Claude shells, to continue the conversation. Not adopted; see the
  open question.

**Open question, decided 2026-09-22.** Whether reboot restore is worth the
complexity, or whether "the shells are gone, reopen them, `claude --continue`
picks the thread back up" is enough. Decided: enough, for now. Under
Decisions.

## Cross-cutting requirements

- **Security.** The backend runs shells and Claude with the user's login. Keep
  it tailnet-only by default (Phase 1 and 2). The Phase 2 helper and the Phase 3
  public edge are the two new attack surfaces; both get authenticated channels
  before they carry anything.
- **AI auth.** Every phase needs a logged-in `claude` and `codex` in the
  container, both on their subscriptions, no API keys. Mounted `~/.claude` and
  `~/.codex` on persistent volumes are the baseline; refresh by logging in on the
  mini when a token expires. The `jev` verdict evaluator needs a gateway API key,
  so it stays off and `verdict` gates fall back to `ask`.
- **Repo sourcing.** The canonical `~/dev` lives on the mini and is mounted; any
  repo kept on another host arrives as an ssh source. Per repo, a deployment
  decision, not a code change; both already work.
- **Networking.** The host's own tailscale (or the sidecar override, for a
  host without one) puts canopy on the tailnet, which is the default and only
  edge; the port is published on the tailnet address alone, never the LAN. A public Funnel or origin proxy stays optional and
  gated; `CANOPY_PUBLIC_ORIGIN` is the existing seam for it.
- **Portability.** Keep `src/core/types.ts` browser-safe, keep the pure opener
  argv builders pure so they can move to the client helper unchanged, and keep
  the openers behind the capability gate so a non-desktop backend degrades
  cleanly rather than erroring.

## Success metrics

- Open the same repo's shell and Claude from three devices (mini, laptop, phone)
  with identical core behavior. (Phase 1)
- Zero desktop commands executed on the backend host for any client action.
  (Phase 2)
- A shell opened on one device is a tab on every other without a reload, and
  joining it shows the same scrollback. (Phase 3, met 2026-09-22)
- Every off-tailnet request without auth refused; with auth, full function.
  (Phase 3, only if the public edge is ever enabled; it is not)
- A canopy redeploy inside the container drops no shells. (Phase 4, met
  2026-09-22)

## Decisions

Resolved 2026-09-21.

- **Repos: mounted, with ssh sources as the escape hatch.** The canonical `~/dev`
  workspace lives on the mini and is bind-mounted into the container, so git runs
  at full speed, the file watcher gives live updates, and a shell's `git`,
  `claude`, and `codex` all run in the one container where the logins live.
  Decided 2026-09-22: the Mac stays canonical and the mini's `~/dev` is a
  mirror of it, pushed by `_control/scripts/sync-dev-to-mini.sh` (rsync over
  the tailnet, additive, no `--delete`, the notebook leg's excludes) on the
  `ca.beric.sync-dev-to-mini` launch agent every two hours, with a rescan of
  the backend after each run. So the container scans and watches a copy that
  trails the Mac by at most two hours, and a commit made in a container shell
  lands on the mini's copy, not the Mac's; pushing to the remote and pulling on
  the Mac is how such a change comes home. Repos
  you deliberately keep on another host stay there and come in as ssh sources
  (re-read on a timer, no watcher, and that host needs its own git and CLIs). It
  is a per-repo choice, not a lock-in; canopy already mixes both. You edit the
  mounted tree from any client through VS Code Remote-SSH into the mini.
- **AI auth: mounted subscription logins, no API keys.** Mount the mini user's
  `~/.claude` and `~/.codex` into persistent volumes so `claude` uses the Max
  subscription login and `codex` uses the ChatGPT/Codex subscription, both as
  OAuth, never an API key. Refresh by logging in on the mini when a token
  expires; no secret is baked into the image. Consequence: the `jev` verdict
  evaluator needs a gateway API key, so it stays off and `verdict` gates fall
  back to `ask`. That is consistent with no-API and is fine.
- **Phase 2 helper: the helper dials the backend; the backend relays.**
  Decided 2026-09-22, replacing the loopback daemon planned on 2026-09-21. The
  loopback daemon needed the SPA, served from a plain-http tailnet origin, to
  call `127.0.0.1` on the client, which Chrome's local network access rules
  block or prompt for, and the prompt would have sat in front of every click.
  Instead `canopy helper` on the client opens a websocket out to the backend
  and registers its openers; the backend matches a helper to a browser by the
  address both reach it from and relays open intents down that socket. No
  browser policy is in the way, nothing listens on the client, and the pure
  argv builders stay where they are: the helper imports `openIn`, `openFile`
  and `openGroup` from `core/openers.ts` and runs them on its own platform.
  Not a browser extension, not a general URL scheme. VS Code is still a plain
  link when the client has no `code` opener. The launcher stays on the backend
  (it needs the repo's checkout and a desktop on the same machine) and is
  still gated by `backend.openers`; only the openers moved to the client. The
  browser picks its helper by name (see the risk note in Phase 2 for why not
  by address); with one desktop per person that is one click per browser.
- **Phase 3 edge: the tailnet is the edge.** Tailscale already reaches every one
  of your devices from anywhere, so for a single-user setup there is nothing to
  expose publicly. Presence and cross-device sessions are the real Phase 3 work
  and happen over the tailnet. A public Funnel or origin stays optional and
  behind an auth gate, built only if a device that cannot run Tailscale ever
  needs in. Held to on 2026-09-22: Phase 3 shipped with no public edge.
- **Phase 3 presence: a browser is known by an id it makes, not by its
  address.** Decided 2026-09-22. Every client behind docker's userland proxy
  reaches the container from the proxy's own address (the `shared` flag Phase
  2 added), so the address tells two devices apart no better than it told a
  helper from its browser. Each browser profile mints a random id once and
  keeps it in localStorage, sends it with a name on its event stream and its
  shell sockets, and the backend folds those streams into devices. Two
  windows of one profile are one device with two streams, which is the
  reading a person wants ("my Mac", not "tab 3"). A private window is a new
  device for as long as it lives, and clearing site data makes a new one;
  both acceptable. Not a login, not an account: it labels, it never
  authorizes.
- **Phase 4 durability: the tmux server gets its own container; reboot
  restore is not built.** Decided 2026-09-22. The shells died on every
  redeploy because the tmux server lived inside the canopy container, so
  moving it out (the `shells` service) is the whole of redeploy and crash
  survival, with no canopy code. What is left is a reboot of the mini, and
  that is rare and planned (the box updates on a schedule you set), so the
  PRD's own test, real usage, says the restore flow is not worth what it
  costs: a snapshot loop over every pane, a records store with retention, a
  restore route and a marked-restored tab state in the UI, all to bring
  back scrollback whose useful part, the Claude conversation, claude-history
  already archives and `claude --continue` in a fresh shell at the repo
  brings back. So after a reboot the shells are gone, the tabs say so, and
  you reopen the ones you want. Revisit if a reboot ever loses something
  that mattered and was not in the archive. The gap this leaves is honest:
  a plain shell's history (a build's output, a long command) does not come
  back.

## Appendix: what containerizes and what is macOS-only

From an audit of the current code.

- **Containerizes cleanly.** The Bun server, SSE, static serving, git scan and
  mutations, `fs.watch`, the tmux shells and ptys, the `claude` runner and chat,
  search, history (given the archive), diffs, workflows, fleets, and the Python
  Library. This is the whole core.
- **macOS-only, must be gated or moved to the client.**
  - `openers.ts`: `open`, `open -a kitty.app`, `open -a Terminal`, `osascript`
    for Terminal and the agent, kitty session files, Finder. No Linux fallback
    today; these are the client-host actions.
  - `launcher.ts`: `open -n -W` for `.app`, `hdiutil` for dmg, `ditto` for zip
    on darwin (with an `unzip` branch already present for non-darwin). The launch
    itself is macOS-only and is disabled on a Linux backend.
  - VS Code via `code` and `vscode-remote://` is the exception: the URL scheme is
    client-side and cross-platform, so it stays.

## Appendix: phase map at a glance

- Phase 1: headless container on the mini, uniform in-browser core to any tailnet
  client, host openers hidden except VS Code links, no durability.
- Phase 2: `canopy helper` dials the backend and the browser picks it, so the
  desktop openers follow the client and the backend runs no desktop command.
  Deployed and verified 2026-09-22.
- Phase 3: the tailnet as the edge, presence and cross-device session
  visibility, with public reach optional and gated. Deployed and verified
  2026-09-22 with no public edge.
- Phase 4: durability, from process-restart survival in the container to
  reboot-time restore and Claude `--continue`. The first is the `shells`
  service, deployed and verified 2026-09-22; the rest is decided against
  for now.
