# PRD: canopy as a shared backend

Status: draft
Owner: Eric
Last updated: 2026-09-21

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
running shells and their AI sessions, and for now that is fine. It is one user
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

- Surviving a container restart or a machine reboot. Deferred to Phase 4.
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

**Status (2026-09-22): the code is built and verified on a Mac; the mini deploy
remains.** Done: `--no-open`; a `Backend` capability on the tree (`openers`,
`sshHost`) computed by `backendCaps()`/`hostOpeners()`; the server refuses
openers, file-open and the launcher with a clear message when headless; the UI
hides the desktop openers, agent, herdr and the launch section and shows VS Code
as a `vscode-remote://` link; `CANOPY_NO_DESKTOP=1` forces the mode on a Mac;
`Dockerfile`, `docker-compose.yml` (tailscale sidecar, path-parity mount),
`.dockerignore`, `docs/deploy.md`. Verified: all four gates green, and against a
forced-headless server the API refuses openers/launch and the menu shows only
the in-browser core plus the VS Code link. Remains, on the mini: build and run
the compose, confirm the `codex` install, and the interactive `claude` / `codex`
/ `tailscale` logins.

**Scope.**

- A headless build and run mode. The server must start and serve without a
  desktop, without opening a browser (`--no-open`, already added), and without
  assuming macOS.
- A Dockerfile (Bun base, git, tmux, `claude`, `codex`, the Python 3 stdlib for
  the Library) and a docker-compose with:
  - the canopy service,
  - a `tailscale/tailscale` sidecar, the canopy service joining its network
    (`network_mode: service:ts`), so canopy is a node on the tailnet,
  - a bind mount of the canonical `~/dev` on the mini for the repo tree (ssh
    config and keys only for the repos kept on other hosts),
  - a persistent volume for `$CANOPY_CONFIG_DIR`,
  - volumes carrying the authenticated `claude` and `codex` subscription logins
    (`~/.claude`, `~/.codex`), no API keys.
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
- On a phone: the same, minus the desktop openers, which are absent from the menu
  rather than present and broken.
- Restarting the container loses the shells and their Claude sessions, and the
  UI recovers cleanly on reload (no orphan tabs, no errors). This is expected,
  not a bug.
- VS Code opens from a client through the Remote-SSH link at the right path.

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

**Scope.**

- **A client config and a capability handshake.** On connect, a client declares
  what it is and what it can drive: platform, whether a local helper is present,
  and which openers that helper supports. The store already keeps per-browser
  settings; this adds a capability set alongside them.
- **Capability-gated menus.** `RepoMenu` builds its "open in" and "with claude"
  groups from the client's advertised capabilities instead of assuming macOS.
  Absent capabilities are absent controls.
- **A small per-client helper.** A local daemon or native-messaging host on the
  client machine that the SPA calls to run an opener on that machine (`open -a
  kitty …` on a Mac, the Omarchy equivalent on Linux, and so on). The server's
  role shrinks to naming the intent ("open repo X, folder Y, in kitty"); the
  client's helper performs it. The existing pure argv builders in `openers.ts`
  move to the helper largely unchanged.
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
  mini.
- On a laptop without the helper: those controls are absent; VS Code and the core
  still work.
- On a phone: no terminal or file-manager openers; core intact.
- The backend host runs no `open`/desktop command for any client action.

**Risks and mitigations.**

- **Helper distribution and trust.** It runs local commands on request, so it
  needs a tight, authenticated local channel (loopback plus a per-client token).
  Treat it as a security surface from the start.
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

**Scope.**

- **Identity and presence.** The backend knows which clients are connected and
  shows it (who has a shell open, who is running a job). This turns "many
  devices, one me" into something the UI reflects and, later, coordinates.
- **Session portability.** Start a shell or a run on one device, see and resume
  it from another, because both are clients of the same backend. Much of this
  falls out of the shared-backend model; this phase makes it explicit.
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
  the tailnet.
- If the public edge is enabled, an unauthenticated request through it is
  refused and an authenticated one behaves as on the tailnet.

**Risks and mitigations.**

- **A machine-driving tool on a public edge.** The backend runs shells, Claude,
  and Codex with your logins. Keep tailnet-only as the default; the auth gate is
  load-bearing and gets designed before anything is exposed.

**Out of scope.** Durability, multi-user.

## Phase 4: durability

**Objective.** Stop losing work to a restart, then to a reboot. This is the "for
now" in "does not survive restart for now" coming due.

**Scope, in order of difficulty.**

- **Process-restart survival (mostly done).** The tmux backend already keeps
  shells and their Claude sessions across a canopy process restart. Bring it into
  the container so a canopy redeploy or crash inside the container does not drop
  the shells.
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
  (tmux in the container).
- After a mini reboot, canopy offers to restore each prior shell with its history
  and, for Claude shells, to continue the conversation.

**Open question.** Whether reboot restore is worth the complexity, or whether
"the shells are gone, reopen them, `claude --continue` picks the thread back up"
is enough. Decide with real usage from Phases 1 to 3.

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
- **Networking.** tailscale sidecar puts canopy on the tailnet, which is the
  default and only edge. A public Funnel or origin proxy stays optional and
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
- Every off-tailnet request without auth refused; with auth, full function.
  (Phase 3)
- A canopy redeploy inside the container drops no shells. (Phase 4)

## Decisions

Resolved 2026-09-21.

- **Repos: mounted, with ssh sources as the escape hatch.** The canonical `~/dev`
  workspace lives on the mini and is bind-mounted into the container, so git runs
  at full speed, the file watcher gives live updates, and a shell's `git`,
  `claude`, and `codex` all run in the one container where the logins live. Repos
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
- **Phase 2 helper: a loopback daemon.** A small authenticated HTTP server bound
  to `127.0.0.1` on the client, holding a per-client token and an allowlist of
  openers. The SPA calls it to run an opener on that machine, and the pure argv
  builders in `openers.ts` move into it almost unchanged. Not a browser
  extension, not a general URL scheme. VS Code is the exception: it keeps its own
  `vscode-remote://` scheme and needs no daemon.
- **Phase 3 edge: the tailnet is the edge.** Tailscale already reaches every one
  of your devices from anywhere, so for a single-user setup there is nothing to
  expose publicly. Presence and cross-device sessions are the real Phase 3 work
  and happen over the tailnet. A public Funnel or origin stays optional and
  behind an auth gate, built only if a device that cannot run Tailscale ever
  needs in.

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
- Phase 2: client capability handshake and a local helper, desktop openers follow
  the client, backend runs no desktop command.
- Phase 3: the tailnet as the edge, presence and cross-device session
  visibility, with public reach optional and gated.
- Phase 4: durability, from process-restart survival in the container to
  reboot-time restore and Claude `--continue`.
