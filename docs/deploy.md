# Deploying canopy as a shared backend

This runs canopy headless in a container on an always-on Linux box (the mini,
on Omarchy) and serves it to every device on your tailnet. It is Phases 1 to
4 of `prd-shared-backend.md`: the in-browser core (git, shells, Claude,
search, diffs, history) works from any device; the desktop openers (kitty,
Terminal, VS Code, Finder, the agent, herdr) run on whichever of your machines
runs `canopy helper`, and the launcher is hidden because a container has no
desktop. Without a helper, VS Code stays as a client-side Remote-SSH link.
Every browser on the backend sees the same shells and runs, and the top bar
says which of your devices are on and what they are in.

The shells live in a container of their own (the `shells` service, a tmux
server), so a canopy redeploy or crash leaves them running with whatever is
in them, a `claude` typed into a shell included. A run or chat started from
the console is not a shell: it is a `claude -p` the canopy container spawns,
and it dies with canopy. A reboot of the mini ends the tmux server, and with
`keepShells` on canopy offers each lost shell back: a new shell at the same
repo, under the same name, with what the old one printed ahead of it. The
processes are gone, so a shell that had Claude in it is offered a
`claude --continue`. The switch is in settings and ships off; it is on for the
mini.

## What runs where

- **Backend:** one container on the mini. The mini is already a tailnet node,
  so canopy's port is published on the mini's tailnet address only and every
  device reaches it as `http://macmini-2018:7850` (MagicDNS) or the tailnet
  IP. Nothing listens on the LAN. The in-app browser's preview ports,
  7860-7869, are published the same way (see "Previews" below).
- **Clients:** any browser on the tailnet. Same cockpit everywhere. VS Code
  opens on the client over Remote-SSH into the mini.
- **Helpers:** `canopy helper` on each desktop you want the openers on (the
  laptop, the notebook). It dials the backend and runs kitty, VS Code and the
  rest there when you click them in that machine's browser. See below.
- **Shells and runs:** on the backend, shared by every browser. A shell you
  open on the laptop is a tab on the phone the moment it exists, and joining
  it there shows the same scrollback. A run shows which device started it.
  The shells themselves run in the `shells` container: a tmux server in the
  foreground on the socket in the config volume, which canopy's own tmux
  client joins from the canopy container. Every mount canopy has, that
  container has too, since `git`, `claude` and `codex` typed into a shell run
  there.

## Prerequisites on the mini

1. Docker and the compose plugin.
2. The repos you want to scan live on the mini, under one root (the default is
   `/home/eric/dev`). This is the mounted, live-watched tree. Since
   2026-09-24 git moves the repos between the Mac and the mini through
   canopy's own peer sync (`peers` and `peerSync: "on"` in each machine's
   config, see the README): each side pulls the other's commits over ssh,
   fast-forwards what it can, and shows the other's uncommitted work as a
   "WIP on mac" chip to take. `_control/scripts/sync-dev-to-mini.sh` still
   runs every two hours, but it now carries only what is not in a repo: every
   repo on either machine is excluded from it, and it deletes on the mini
   what the Mac dropped (each deleted file kept for a week under
   `~/.cache/sync-dev-to-mini/backup/`). It asks the backend to rescan
   afterwards. Peer sync needs, on each machine, a `canopy_peer` key whose
   public half sits in the other machine's `authorized_keys` behind
   `restrict,command="<bun> <canopy>/bin/canopy.ts peers gate --root dev"`,
   and an ssh alias for the other (`mini-peer` on the Mac, `mac-peer` on the
   mini) using that key. The gate runs from the host checkout, not the
   container, so the mini's `~/dev/dev-tools/canopy` needs `bun install`
   after a dependency change. The container mounts the host's
   `~/.config/git` so a wip snapshot ignores what host git ignores, and
   `git-lfs` must be installed on the host for any repo that uses it, or its
   files read as modified. To stop peer sync, set `peerSync` to `"off"` in
   both configs; nothing else needs undoing.
3. `claude` and `codex` logged in on the mini so `~/.claude` and `~/.codex`
   exist. The container mounts those logins; it uses your subscriptions, never
   an API key. If a token expires, log in again on the mini and the container
   picks it up.
4. An ssh host on each client that reaches the mini, named to match
   `CANOPY_SSH_HOST` (`macmini-2018` on the mini), for VS Code Remote-SSH.

## Configure

Create a `.env` next to `docker-compose.yml` (it is gitignored):

```
CANOPY_LISTEN=100.68.139.95     # the mini's tailnet IP: tailscale ip -4
CANOPY_SSH_HOST=macmini-2018    # the ssh alias clients use for VS Code
DEV_ROOT=/home/eric/dev
HOST_HOME=/home/eric
GH_TOKEN=...                    # optional: gh auth token, for PR counts and releases
VERCEL_AI_GATEWAY_API_KEY=...   # optional: lets verdict gates evaluate
# HOST_UID=1000                 # id -u and id -g of that user, when not 1000
# HOST_GID=1000
# COMPOSE_PROFILES=tunnel       # optional: the public name, see "A public name" below
# TUNNEL_TOKEN=eyJ...
# CANOPY_PUBLIC_ORIGIN=https://canopy.beric.ca
```

`CANOPY_LISTEN` is where docker publishes the port. Leave it unset and canopy
answers on the mini's loopback only, so a missing `.env` never puts it on the
LAN. `DEV_ROOT` is mounted into the container at the same path, so `git` in
the container and VS Code Remote-SSH on the mini both see
`/home/eric/dev/<repo>`. Keep that parity; a different in-container mount path
breaks the VS Code link.

## Run

```
docker compose up -d --build
```

Then install the unit that brings it back after a reboot (see the gotcha
below for why compose alone does not):

```
sudo cp lib/canopy-backend.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now canopy-backend
```

Reach it from any device on the tailnet at `http://macmini-2018:7850`. The
first load lists your repos; open a shell, start a Claude chat, read a diff. On
a phone the desktop openers are simply absent.

To pick up new canopy code, run `bun run redeploy` in the checkout. On the
Mac it fast-forwards the mini's checkout to the Mac's committed `main` through
the `mac` peer remote and deploys there. In a canopy shell on the mini it
deploys the mini's own checkout (`--pull` takes the Mac's first) over ssh to
the host, with a key whose `authorized_keys` line runs only
`scripts/redeploy.sh --gate`; `scripts/redeploy-setup.sh` on the mini makes
that key once. The compose run is detached and logged under
`~/.cache/canopy-deploy/` (`bun run redeploy log`), `bun run redeploy status`
says what is running, and a deploy that would recreate the shells container
stops unless given `--shells`. By hand it is the same command as above; the
canopy image rebuilds and its container is replaced. The rsync no longer
carries canopy's checkout, so an uncommitted change on the Mac never reaches
the mini's build, and a dirty checkout on the mini is not fast-forwarded. Config in
the `canopy-config` volume survives, and so do the shells: they are held by
the `shells` container, whose image (the `shells` stage of the Dockerfile,
everything but canopy's code) does not change when canopy's code does, so
compose leaves that container alone. The recreated canopy logs "shells on
tmux (/usr/bin/tmux), n held from before" and every browser's tabs rejoin.

Two things do drop the shells, and both are visible in the `up` output as
"Container canopy-shells-1 Recreated". A change to the `shells` stage (the
apt line, the user, the claude or codex install, either tmux conf under
`lib/`) rebuilds
that image, and a base image bump (`oven/bun:1` moving) may also move
Debian's tmux, and a tmux client and server of different versions refuse each
other, so after a base bump restart both services in one `up` rather than
canopy alone. Plan either for a moment when nothing is running in a shell.
`docker compose up -d --force-recreate --no-deps canopy` is the crash
rehearsal: canopy alone comes back and the shells stay.

## Previews (the in-app browser)

A repo panel's **preview** section frames the repo's dev server. The dev
server runs in a canopy shell, so it listens on the `shells` container's
loopback; canopy runs in that container's network namespace
(`network_mode: service:shells`), and its process namespace too (`pid:
service:shells`) so it can read which repo each listening process runs in.
Both containers' ports are therefore published on the `shells` service:
7850 for canopy, 7860-7869 for the previews. Each preview gets one of those
ports to itself and canopy proxies it to the dev server's port, websockets
(HMR) included, so a preview is its own origin and the app's absolute paths
work unchanged.

- The first `docker compose up -d` after this layout arrived recreates the
  `shells` container (its ports and network changed), which ends every
  shell once. Pick a quiet moment.
- A preview is plain http on the backend's own port, so it works at the
  tailnet address, not through the Cloudflare tunnel (which carries only
  canopy's port, over https). The section says so there.
- `CANOPY_PREVIEW_PORTS` (default `7860-7869`, `0` for off) sets the pool.
  Change the published range in compose to match.
- The tunnel's `http://canopy:7850` still resolves: `shells` carries the
  network alias `canopy`.

## A host that is not on the tailnet

Add the sidecar override, which makes a `tailscale/tailscale` container the
tailnet node and joins the shells container (and with it canopy) to its
network. canopy is then reachable as
`http://canopy:7850` (the sidecar's hostname) with no port published on the
host. Put a `TS_AUTHKEY=tskey-auth-…` from the tailscale admin console in
`.env` and run:

```
docker compose -f docker-compose.yml -f docker-compose.sidecar.yml up -d --build
```

## A public name: Cloudflare Tunnel

For a device off the tailnet, the `tunnel` service puts canopy on a public
name (`canopy.beric.ca`) through a Cloudflare Tunnel. cloudflared dials out
to Cloudflare, so nothing new is published on the mini. It sits under the
compose profile `tunnel` and runs only where `.env` turns that on.

**canopy has no login of its own.** Anyone who reaches that hostname gets
every shell, run and git action on the mini. Keep a Cloudflare Access
application on the hostname (Zero Trust → Access → Applications, allowing
only your own email) before the tunnel goes up, and leave it on.

1. In Zero Trust → Networks → Tunnels, create a tunnel (type cloudflared) and
   copy its token. Give it a public hostname, `canopy.beric.ca`, with the
   service `http://canopy:7850`: canopy by its service name on the compose
   network. The ingress lives in the dashboard, not in this repo.
2. Add to `.env`:

   ```
   COMPOSE_PROFILES=tunnel
   TUNNEL_TOKEN=eyJ...
   CANOPY_PUBLIC_ORIGIN=https://canopy.beric.ca
   ```

   `CANOPY_PUBLIC_ORIGIN` is exact: `https://`, the host, no trailing slash.
   canopy only answers `/api` requests for a host other than a local or
   tailnet name when they match it and carry `X-Forwarded-Proto: https`,
   which Cloudflare adds. Without it, the page loads but every API call is
   refused with `Foreign origin`.
3. `docker compose up -d --build`. `docker compose logs tunnel` should show
   four "Registered tunnel connection" lines.

The tunnel publishes no port, so it does not wait for the tailnet the way
canopy does. Its `restart: unless-stopped` brings it back after a reboot, and
`canopy-backend.service` leaves it alone. A redeploy of canopy does not touch
it either. It gets 502s for the moment canopy is being replaced, and that is
all. Error 1033 on the hostname means no cloudflared is connected for the
tunnel: `docker compose ps tunnel` and its logs say why (an empty or revoked
token is the usual one).

If the hostname was served before by a cloudflared on another machine (the
Mac, as `ca.beric.canopy-server`), point the hostname at this tunnel and
stop that one. Two connectors on one tunnel share its traffic, and the
dashboard ingress (`http://canopy:7850`) means nothing on the Mac.

With the sidecar override, canopy shares the `ts` container's network (by way
of the shells container's) and has no name of its own on the compose network: use `http://ts:7850` as the
hostname's service there.

Every browser that comes in through the tunnel reaches canopy from the
cloudflared container's address. Presence tells them apart anyway (it goes
by browser, not by address). The helper auto-pick, which goes by address,
cannot. Pick a helper by name in settings on a device that uses the public
name.

## The desktop openers: canopy helper

A container has no desktop, so the openers run on your own machine through a
helper that dials the backend:

```
canopy helper --backend http://macmini-2018:7850
```

It registers under the machine's hostname with the openers it finds on PATH
(kitty, the `code` CLI, herdr, and on a Mac always Terminal, Finder and the
agent) and keeps the socket up, reconnecting at doubling waits when the
backend restarts. Then, in the browser on that machine, open the settings
popover and pick the helper under "desktop openers"; the pick is saved in that
browser. From then on "open in" and "with claude" in a card's menu, a search
hit, and a workspace's code and kitty buttons all open on that machine, with
the repo reached over ssh as `ssh://$CANOPY_SSH_HOST<path>` (so the ssh alias
in `.env` must resolve on the helper's machine, the same one the VS Code link
uses). A repo added as an ssh source keeps its own host in the locator; the
helper's ssh config has to know that host too.

Why the pick is by hand: the backend matches a browser to a helper by name,
not by address. Docker's published port hands the container its own gateway
(`192.168.48.1` here) as the source of every connection, so every browser and
every helper look alike to it; the backend reports such an address as shared
and never adopts a helper by it. Where addresses do come through (a backend
run straight on a host, not in a container), a browser with no pick adopts
the one helper at its own address. The settings popover shows the address the
browser is seen as.

`--name` and `--openers kitty,code` override what it registers as and offers;
`CANOPY_BACKEND` stands in for `--backend`. On Linux the openers are kitty
(`--detach`, also for the agent, held open), `code`, and `xdg-open` for the
folder; there is no Terminal.app there. Keep it running as a user service: on
a Mac a launchd agent with `bun /path/to/canopy/bin/canopy.ts helper --backend
…` and `KeepAlive` (on the MacBook that is `ca.beric.canopy-helper` in
`~/Library/LaunchAgents`, logging to `~/Library/Logs/canopy-helper.log`), on
Linux a systemd user unit with `Restart=always`. A
browser with no helper picked still gets the shell, the VS Code link and the
whole in-browser core; the open routes answer 400 saying to run the helper.

## Devices

Every browser profile on the backend is a device: it makes itself an id once
(in localStorage, so a private window is a new device while it lives), names
itself off the user agent ("Mac, Chrome", "Android, Chrome") unless you give it
a name under "this device" in the settings popover, and says both on its event
stream and on every shell socket. The `⌘ n` chip in the top bar counts the
devices on the backend; its popover lists each one with its platform, how long
it has been on, how many windows it has open, and which repos it has a shell in
("in a shell at canopy"). Two windows of one profile are one device.

`GET /api/devices` is the list, `GET /api/terms` lists the held shells with
their `viewers` (the device names with a socket on each), and both broadcast
on the event stream (`devices`, `terms`) whenever they change, so a shell
opened on one device becomes a tab on every other without a reload: in the
strip, or in the repo's panel when it was opened there (the panel opens to
show it). Presence labels; it never authorizes. The id and the name are what
the browser sends, which is fine among one person's devices on a tailnet and
is one more reason nothing here is exposed past it.

## Codex

The Dockerfile installs `codex` via `bun add -g @openai/codex` and `nodejs`
next to it, since the codex npm wrapper launches on node. If that package
name is wrong for your setup, install codex your own way in the final image (a
`RUN` line, or a mounted binary that is a linux-x64 build), and rebuild. codex
runs inside the in-browser shell on your Codex subscription, using the mounted
`~/.codex`; canopy does not shell out to it directly, so a missing codex does
not stop canopy from starting.

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

- The launcher (install, build, launch): it needs the checkout and a desktop
  on one machine. The server refuses it with a clear message and the UI hides
  it. Release and pull request listings read through `gh`, which the image
  carries (the final stage, so installing it did not touch the shells image),
  logged in by `GH_TOKEN` from `.env`. That login is also git's credential
  helper for github.com in the canopy container (`GIT_CONFIG_*` in
  `docker-compose.yml`), so the panel's push and the background fetch of a
  private https remote work. Not in the shells container, which has no `gh`:
  a `git push` typed into a shell there still has no login. The desktop
  openers are not off, they moved: see the helper section above.
- The history section (the rings, sessions, the Claude panel). It reads
  through the claude-history CLI, and the archive it reads lives in the vault
  on the Mac alone. The archive's projects are keyed by Mac paths
  (`/Users/ericbaruch/dev/...`) while the mini's repos sit at
  `/home/eric/dev/...`, and canopy matches the two by realpath. So pointing
  `historyBin` at the mini's checkout would show nothing. Turning it on takes
  a copy of the archive on the mini plus a path map, or a CLI run over ssh on
  the Mac. Until then the overview answers `available: false` and the section
  stays empty.
- Without a helper, VS Code is the one opener kept, as a
  `vscode-remote://ssh-remote+<host>` link built from `CANOPY_SSH_HOST`, and a
  search hit's file open answers 400. With a helper picked, both go through it.

## ssh sources

Repos you keep on another host (not on the mini) can still appear: add them in
the UI as ssh sources. The mounted `~/.ssh` gives the container the keys and
host aliases. Those repos are re-read on a timer rather than live-watched, and a
shell into them is an ssh session, so that host needs its own git, `claude`, and
`codex` if you want the AI tools there.

## Gotchas met on the way

- The backend does not come back from a reboot on its own, which is what
  `lib/canopy-backend.service` is for. At boot docker starts its
  `unless-stopped` containers before tailscaled has assigned the tailnet
  address, so publishing the port on that address fails with "cannot assign
  requested address" and the canopy container exits 255. Docker does not
  retry a networking failure, and a later `docker compose up -d` on that
  container starts it with no published port at all (`NetworkSettings.Ports`
  comes back empty), so the fix is to recreate it: the unit waits for an
  address on `tailscale0`, brings the shells container up, and recreates
  canopy alone. The shells container has no published port, so it is never
  the one that fails. Seen and fixed on the mini 2026-09-22.
- `depends_on … service_healthy` orders a compose `up`; it does not order
  the daemon's `unless-stopped` restarts after a host reboot. If canopy is up
  before the shells container's socket and a browser opens a shell in that
  window, canopy's tmux client starts a server of its own inside the canopy
  container, and those shells die with the next redeploy while the log says
  nothing. Two reboots of the mini did not hit it (`docker top
  canopy-canopy-1 | grep tmux` came back empty both times, and the unit above
  starts the shells container first), but the check is worth doing after a
  reboot; the image has no `ps`, so `docker top` is the way. If a tmux is
  there, `docker compose up -d --force-recreate --no-deps canopy` once
  nothing is running in a shell.

- The server bound `127.0.0.1` inside the container, so docker's published
  port DNAT'd to the container's ethernet address and hit a wall. The compose
  sets `CANOPY_BIND=0.0.0.0`; the published port on the tailnet address is
  what keeps it off the LAN.
- The container first ran as root. git over a tree owned by the host user
  was "dubious ownership" everywhere, and claude refuses
  `--dangerously-skip-permissions` as root, which is what every canopy run
  passes. So the container runs as the image's `bun` user, remapped to the
  host uid and gid by build args (`HOST_UID`/`HOST_GID` in `.env`, 1000 by
  default), and the tree, `~/.claude` and `~/.codex` are its own files. The
  image keeps `safe.directory '*'` for a tree owned by a uid the build args
  did not name.
- A container sets no `SHELL`, and the image has no zsh, so the in-browser
  shell used to start `/bin/zsh` and die at once. `userShell()` now falls back
  to bash off a Mac, and the image sets `SHELL=/bin/bash` besides.
- `codex` is an npm wrapper whose launcher runs on node; bun does not satisfy
  its shebang, so the image installs `nodejs` too. The image also points
  `bun add -g` at `/usr/local/bin`, which the `bun` user cannot write, so
  `BUN_INSTALL_BIN` is moved under its home.
- The Library (the `/library/*` workspace manager) refused every request as a
  "Foreign origin": its CSRF guard took only localhost or a configured HTTPS
  proxy origin. With `CANOPY_BIND` set beyond loopback it now takes a
  same-origin request by a tailnet name too (an address in 100.64/10, a
  `.ts.net` name, or a bare machine name); a dotted public name is still
  refused, since a domain someone else controls could resolve to the same
  address.
