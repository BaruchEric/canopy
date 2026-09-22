# Deploying canopy as a shared backend

This runs canopy headless in a container on an always-on Linux box (the mini,
on Omarchy) and serves it to every device on your tailnet. It is Phase 1 of
`prd-shared-backend.md`: the in-browser core (git, shells, Claude, search,
diffs, history) works from any device; the macOS desktop openers and the
launcher are hidden because a container has no desktop. VS Code stays, as a
client-side Remote-SSH link.

A container restart drops the running shells and their AI sessions. That is
expected for now (Phase 4 is durability).

## What runs where

- **Backend:** one container on the mini, plus a tailscale sidecar it shares a
  network with, so canopy is reachable at the tailnet name on port 7850.
- **Clients:** any browser on the tailnet. Same cockpit everywhere. VS Code
  opens on the client over Remote-SSH into the mini.

## Prerequisites on the mini

1. Docker and the compose plugin.
2. The repos you want to scan live on the mini, under one root (the default is
   `/home/eric/dev`). This is the mounted, live-watched tree.
3. `claude` and `codex` logged in on the mini so `~/.claude` and `~/.codex`
   exist. The container mounts those logins; it uses your subscriptions, never
   an API key. If a token expires, log in again on the mini and the container
   picks it up.
4. A tailscale auth key for the sidecar (a reusable or ephemeral key from the
   tailscale admin console).
5. An ssh host on each client that reaches the mini, named to match
   `CANOPY_SSH_HOST` (default `canopy`), for VS Code Remote-SSH.

## Configure

Create a `.env` next to `docker-compose.yml`:

```
TS_AUTHKEY=tskey-auth-xxxxxxecho
DEV_ROOT=/home/eric/dev
HOST_HOME=/home/eric
CANOPY_SSH_HOST=canopy
```

`DEV_ROOT` is mounted into the container at the same path, so `git` in the
container and VS Code Remote-SSH on the mini both see `/home/eric/dev/<repo>`.
Keep that parity; a different in-container mount path breaks the VS Code link.

## Run

```
docker compose up -d --build
```

Reach it from any device on the tailnet at `http://canopy:7850` (or the mini's
tailnet IP). The first load lists your repos; open a shell, start a Claude chat,
read a diff. On a phone the desktop openers are simply absent.

## Codex

The Dockerfile installs `codex` via `bun add -g @openai/codex` on a best-effort
basis. If that package name is wrong for your setup, install codex your own way
in the final image (a `RUN` line, or a mounted binary that is a linux-x64
build), and rebuild. codex runs inside the in-browser shell on your Codex
subscription, using the mounted `~/.codex`; canopy does not shell out to it
directly, so a missing codex does not stop canopy from starting.

## Try it on a Mac first

To see the shared-backend UI without a container, run canopy on your Mac with
the headless behaviour forced:

```
CANOPY_NO_DESKTOP=1 CANOPY_SSH_HOST=canopy bun bin/canopy.ts ui ~/dev --port 7899
```

The desktop openers and the launcher drop from the menus, and VS Code shows as a
Remote-SSH link, exactly as they will on the mini. The in-browser shells and
Claude still work locally.

## What is off in this mode

- The desktop openers (kitty, Terminal, Finder, agent, herdr) and the launcher.
  The server refuses them with a clear message and the UI hides them. The
  in-browser shell and the in-browser Claude cover what they did.
- The `jev` verdict evaluator needs a gateway API key, which we do not set, so
  `verdict` workflow gates fall back to `ask`.
- VS Code is the one opener kept, as a `vscode-remote://ssh-remote+<host>` link
  built from `CANOPY_SSH_HOST`. Opening a file from a search hit still runs on
  the backend and is refused here; that becomes a client link in Phase 2.

## ssh sources

Repos you keep on another host (not on the mini) can still appear: add them in
the UI as ssh sources. The mounted `~/.ssh` gives the container the keys and
host aliases. Those repos are re-read on a timer rather than live-watched, and a
shell into them is an ssh session, so that host needs its own git, `claude`, and
`codex` if you want the AI tools there.
