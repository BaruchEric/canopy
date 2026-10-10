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
   after a dependency change. Both containers mount the host's
   `~/.config/git`, so a wip snapshot ignores what host git ignores and a
   commit typed into a shell has the host's identity, and
   `git-lfs` must be installed on the host for any repo that uses it, or its
   files read as modified. To stop peer sync, set `peerSync` to `"off"` in
   both configs; nothing else needs undoing.
3. `claude` and `codex` logged in on the mini so `~/.claude` and `~/.codex`
   exist. The container mounts those logins; it uses your subscriptions, never
   an API key. If a token expires, log in again on the mini and the container
   picks it up. The shells container also mounts `~/.convex`, which
   `bun run redeploy` creates on the host. Log in once with
   `bunx convex login --no-open` in a canopy shell (or on the host) and the
   login stays in that folder across rebuilds. Without it `convex dev` asks
   to log in, and under `bun run --filter` (no TTY) that exits 1 with
   "Cannot prompt for input in non-interactive terminals".
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
# CANOPY_PREVIEW_PUBLIC=https://canopy-p{slot}.beric.ca   # optional: previews on the public page, see "A public name"
# TAILCHAN_URL=http://100.68.139.95:7855   # optional: the tailchan broker, see "tailchan" below
# TAILCHAN_HUMAN=eric                       # the handle the UI speaks tailchan as
TZ=America/Los_Angeles          # the host's zone by name: canopy's local time (the ranger's crons and daily hour, the history's days)
```

`TZ` is there because Bun takes the time zone from its name. The host's
`/etc/localtime`, mounted into both containers, changes what `date` and sqlite
read but not what Bun reads, since the image's file is a link named `Etc/UTC`.
Without it canopy runs on UTC. canopy hands its `TZ` to every tmux session it
starts (shells, tasks and the ranger), so they get the host's local time too.

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
stops unless given `--shells`. A deploy of the commit already running changes
nothing, so compose leaves every container up; `--restart` recreates the
canopy container anyway, and the shells stay. By hand it is the same command as above; the
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
- Another machine's plain http canopy page (the Mac's loopback one, with
  this backend in its backends list) frames a checkout here at
  `CANOPY_PREVIEW_HOST`, which compose fills from `CANOPY_LISTEN`, the
  tailnet IP the slots are published on. It has to be the IP: `*.ts.net` is
  on the HSTS preload list, so a browser upgrades an http frame on a
  MagicDNS name to https, which the slots do not speak. `/api/ports` hands it
  out as `host`.
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
4. Optional, previews on the public page. That page is https, so it cannot
   frame the preview ports' plain http, and each preview port needs a public
   name of its own: one ingress rule per port, `canopy-p7860.beric.ca` to
   `http://canopy:7860` through `canopy-p7869.beric.ca` to
   `http://canopy:7869`, each with a proxied CNAME to the tunnel, then
   `CANOPY_PREVIEW_PUBLIC=https://canopy-p{slot}.beric.ca` in `.env`. Check
   that the gate covers the new names before a preview runs on them: an
   anonymous `curl https://canopy-p7860.beric.ca/` must answer 401. On
   beric.ca the `*.beric.ca/*` gate route does that, and its `.beric.ca`
   cookie also signs in the framed preview, but only inside a page on
   beric.ca itself: the cookie is `SameSite=Lax`, so a frame under any other
   site (the Mac's `http://127.0.0.1:7850`, a `*.ts.net` address) gets the
   gate's sign-in, and a sign-in there never sticks. The panel uses the
   public names only on such a page.

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
`CANOPY_BACKEND` stands in for `--backend` when it is an http(s) origin (a
canopy shell sets it to the backend's name, which the helper ignores). On Linux the openers are kitty
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

## tailchan

[tailchan](../../../homelab/services/tailchan) is the tailnet-only message
broker on the mini (port 7855): channels, DMs, a clipboard channel and a file
drop, with a bash CLI and the homelab `tailchan` skill. canopy uses it in two
ways.

**From a shell.** An agent in a canopy shell runs `tailchan` like one on the
Mac. The CLI is the repo copy under the mounted dev tree, put on PATH by
`~/.claude/shell/bashrc`, and the skill is `~/.claude/skills/tailchan` on the
mini, a symlink into the same tree. Every shell started while canopy knows a
broker runs with `TAILCHAN_AS=<repo>-<4 hex of the shell id>`, so its agent
answers to a name that says where it is; the shells picker shows that handle,
whether it is listening, and a "message" button. The container has no clipboard
tool, so `clip push -` and `clip show` work there and `clip push`/`clip pull`
do not.

**From the UI.** With `TAILCHAN_URL` in `.env` the server keeps a stream open as
`TAILCHAN_HUMAN` and the top bar gets `✉`: conversations, a composer, files,
the clipboard both ways, and who has been around. Messages land in the feed
too. The checkbox at the bottom has canopy post its runs, flows and fleets to
`#canopy` and DM you (a Telegram ping) when a prompt or a gate waits on you.
On a Mac canopy reads the CLI's own `~/.config/tailchan/env`, so it needs
nothing new.

The broker and canopy share the mini, which takes two things on the host,
both done on 2026-09-25: a ufw rule allowing tcp 7855 from canopy's compose
network (192.168.48.0/20; ufw's default only lets 172.16.0.0/12 in), and
`TRUST_NETS=192.168.48.0/20=macmini-2018` in the broker's `.env`, since a
request from the bridge address is not a tailnet address and WhoIs cannot name
it. If the compose network is ever recreated on another subnet, both follow it
(`docker network inspect canopy_default`).

### Asks, presence and guards

An agent's permission prompt, question or guard hit is an *ask* at the
broker, and canopy's `?` chip (top bar, and the agents view's bar) is the
inbox that answers it, beside canopy's own runs on a prompt and workflows at
a gate. Reading asks needs only `TAILCHAN_URL`; answering them, the away
switch, the presence beat and editing guards take an **answer key**, which
each browser holds for itself:

1. Give every device you answer from a secret of its own, in the broker's
   `.env` on the mini: `ANSWER_TOKENS=phone:<secret>,macbook:<secret>`
   (comma-separated `name:secret` pairs). The name is what an answer is
   logged under (`Erics-Phone@phone`), and dropping one pair revokes that
   device alone. Recreate the broker.
2. On each device, open canopy's Settings, paste that device's secret into
   **answer key**, save, and **test key** (one presence beat: "ok" or
   "refused"). The key stays in that browser's storage
   (`canopy.answerKey`); the page sends it to its own backend, as
   `X-Canopy-Answer-Key`, on those four writes only, and canopy passes it to
   the broker as its Bearer token without keeping or logging it.
3. Neither canopy holds a secret: no `TAILCHAN_ANSWER_TOKEN` in this `.env`,
   nothing in the Mac's launchd plist, and never one in
   `~/.config/tailchan/env`, which every agent's CLI reads. A secret in the
   server would answer for anything that can reach it: canopy's API on the
   loopback answers every shell on the machine (each has `CANOPY_API`), and
   on the mini canopy shares the shells' pid namespace as the same user, so
   any agent can read its environment from `/proc`. A deploy that still sets
   `TAILCHAN_ANSWER_TOKEN` should drop it; canopy no longer reads it. Where
   the browser and the agents share a user (the Mac), a determined agent can
   still dig a key out of the browser's storage: the key stops accidents and
   casual prompt-injected tries, not that.
4. On every machine an agent runs on, `tailchan agent install` puts the
   hooks in `~/.claude/settings.json` and `~/.codex/hooks.json`. Codex runs no
   user hook until it is trusted once per machine: open `/hooks` in a codex
   session and trust them (`tailchan agent doctor` checks, and says so).

Without a key the inbox still lists the asks and says to add one in
Settings. How long an ask waits for you depends on presence: typing or
pointing anywhere on a canopy page that holds a key (its shells included)
keeps you `here`, and an ask waits a minute in canopy before it goes back to
the agent's terminal; a quarter hour without makes you `away`, and an ask
then waits half an hour and DMs you (Telegram) a link to
`?view=agents&ask=<id>`. The away switch in the inbox
pins it. An agent in a canopy shell someone typed into within two minutes
keeps its prompt at that terminal (`GET /api/terms/watched`, which the hook
asks). Guards are edited in the agents view's routing tab.

## The incubator

New projects run on the backend that holds the launch root: seeds go to
`<root>/_incubator/<slug>`, the raw inputs and records to
`$CANOPY_CONFIG_DIR/incubator/` (0700, kept after a dismiss under
`.dismissed/`). Only the server that holds the flows lock restores or starts
them; another server on the same config dir lists them read-only and answers
an intake with 503. Two optional settings in the mini's `.env`:

- `CANOPY_VAULT_TOKEN`: a memory gateway token with the `agent` scope,
  minted for canopy alone (`POST /tokens {"name":"canopy-incubator","scopes":["agent"]}`
  with the owner token). Without it there are no vault notes or daily lines.
  `CANOPY_VAULT_URL` overrides `https://mem.beric.ca`.
- `CANOPY_TRANSCRIBE_URL` (the origin of an OpenAI-style server, LiteLLM on
  the mini, for example `http://100.68.139.95:4000`; canopy appends
  `/v1/audio/transcriptions`), `CANOPY_TRANSCRIBE_KEY` and
  `CANOPY_TRANSCRIBE_MODEL` (default `transcribe`). Without a URL a voice
  memo stays raw, marked "not transcribed", and clarify is told.
- `VERCEL_TOKEN` and, for a team that is not the token's own account,
  `VERCEL_SCOPE` (the team's slug). With them, a project that passes its
  accept step gets a private GitHub repo under the `gh` login, a push, a
  Vercel project of its own name and a production deploy, all from
  canopy's own code. Without the token the project parks at deploy with
  "add VERCEL_TOKEN to <backend>'s .env". Make the token at
  vercel.com/account/tokens, scoped to one team kept for incubator
  projects. Before each deploy canopy sets the project's Vercel
  Authentication to protect previews only (`ssoProtection.deploymentType`
  `preview`), on that project alone, never team-wide. The url a project goes
  live on, and the one its smoke GET hits, is the shortest `vercel.app` alias
  the API lists, or the deployment's own hash url when it lists none, and
  Standard Protection keeps a hash url behind Vercel's login. A production
  url still behind a login (password protection, a team policy) answers 401
  and parks the project with that reason. Lift it for that project, then
  resume.
- `FIREBASE_TOKEN` and, optionally, `FIREBASE_LOCATION` (a Firestore
  location id, default `nam5`). With the token, a `vercel+firebase` project
  gets a Firebase project of its own (id from its slug plus six hex
  characters), a default Firestore database at that location and a web app,
  and the web app's config goes into the Vercel project's env before the
  deploy. canopy then deploys the Firestore rules and indexes, and nothing
  else, from a clean clone of what it pushed. Without the token the project
  parks at deploy with "add FIREBASE_TOKEN to <backend>'s .env". Make the
  token with `firebase login:ci` in a real terminal on any machine with the
  CLI (it opens a browser, so it cannot run from a harness), signed in to a
  Google account kept for incubator projects, not your main one. The token
  can create projects on that account, so treat it like the Vercel token.
  firebase-tools 15.32.1 still takes it but warns that `FIREBASE_TOKEN` is
  deprecated in favor of a service account key; the warning goes to stderr,
  not into the `--json` result canopy reads. Check it before bumping the
  pin: a major version that drops the variable breaks this path.
  `firebase-tools` is pinned in the image under `/opt/firebase`, owned by
  root and off the default PATH; compose hands canopy alone
  `CANOPY_FIREBASE_PATH` to find it. Its version and every dependency come
  from `docker/firebase/package.json` and `bun.lock`, installed with
  `--frozen-lockfile`; to move the pin, change the version there, run
  `bun install --lockfile-only` in that folder inside `oven/bun:1`, and
  commit both files.
- `GH_TOKEN` (already in `.env` for the rest of canopy) is also what an
  extend pushes its `new/<slug>` branch with, so it needs contents write on
  the repos you want extended. A fine-grained token limited to some repos is
  fine: before it rebuilds the seed, canopy asks GitHub whether the login
  can push, and a repo it cannot push parks the project with that reason.
  Push rights are not enough: the repo's owner must be the `gh` login
  itself, or an owner listed under `extendOwners` in canopy's
  `config.json` (empty by default), so an employer's or an org's repo the
  token happens to reach is refused. canopy pushes the one branch, never a
  tag or another ref, and opens no pull request. It pushes only after you
  say yes in the inbox: the item lists the commits and files, with any
  change to CI, deploy config, hooks or `package.json` scripts at the top,
  since the push runs the repo's Actions and preview builds with its
  secrets.

canopy reads the vault token, the transcribe key, the Vercel token and the
Firebase token once at start and then deletes all four from its own environment, so no shell, run or tmux server it
starts inherits them. `/proc/<canopy>/environ` still keeps the values the
process started with. The incubator's agents cannot reach it once they run in
the `stages` container (below), which has its own pid namespace; on a backend
that runs them unisolated, they can.
`CANOPY_INCUBATOR_AUTOSTART=0` holds every project queued, for a pause.

## Stages

The incubator's agents and their checks run in the `stages` container, not in
canopy's: no token in its env, its own pid namespace and network
(`stages-net`, 10.250.13.0/24, v4 only, on a host bridge named
`br-canopy-stg`), the seeds under `_incubator/` and nothing else of the
workspace, and its own claude and codex logins. canopy starts processes there
only through the stage runner's socket. The design is
`docs/superpowers/specs/2026-10-02-incubator-token-free-stages-design.md`,
part 3.

The fence is `scripts/stages-fence.sh`. It drops every packet that arrives on
`br-canopy-stg` for a private, tailnet, link-local, multicast or broadcast
address, and every IPv6 packet from it, in the raw table's PREROUTING. That
runs before routing, docker's DNAT and every filter chain, so it covers the
host's own addresses too, and neither ufw, docker nor tailscale's
`ts-forward` can get a packet past it. The internet stays open. Until the
fence is in place the stages network has open outbound to everything the host
can reach, so it goes in before the first `up`.

Setting it up on the mini, once, in one session:

**0. Two things that would undo the fence.** Arch's stock `/etc/nftables.conf`
starts with `flush ruleset`, which would wipe the raw table along with
docker's rules, and ufw with `MANAGE_BUILTINS=yes` flushes the built-in
chains on a reload.

```
systemctl is-enabled nftables.service iptables.service ip6tables.service   # each: disabled (or not-found)
grep MANAGE_BUILTINS /etc/default/ufw                    # MANAGE_BUILTINS=no
```

**1. Copy the script where only root can change it, and read that copy.**
The checkout is writable by canopy's containers and peer sync, so the file
read and the file installed must be one root-owned copy:

```
sudo install -m 0755 -o root -g root scripts/stages-fence.sh /usr/local/sbin/canopy-stages-fence.new
less /usr/local/sbin/canopy-stages-fence.new
sh /usr/local/sbin/canopy-stages-fence.new   # prints the rules, changes nothing
```

**2. Install the fence** from that copy, then remove it:

```
sudo sh /usr/local/sbin/canopy-stages-fence.new --install
diff /usr/local/sbin/canopy-stages-fence.new /usr/local/sbin/canopy-stages-fence   # only the CHECKOUT line differs
sudo rm /usr/local/sbin/canopy-stages-fence.new
sudo iptables -t raw -S PREROUTING      # the eight drops on -i br-canopy-stg, no ACCEPT above them
sudo ip6tables -t raw -S PREROUTING     # the one v6 drop
sudo ufw reload && sudo iptables -t raw -S PREROUTING   # still there
```

`--install` writes a root-owned copy of the script it was run as, read at that
moment, to `/usr/local/sbin/canopy-stages-fence` and the unit
`/etc/systemd/system/canopy-stages-fence.service`, a oneshot that runs the
copy's `--apply`, ordered before `docker.service` and wanted by it. It enables
the unit and runs it. The unit never runs the checkout's script. A copy under
any name but `stages-fence.sh` reads none of the `CANOPY_FENCE_*` test
switches, so the `.new` copy installs the real paths whatever the env holds.
The unit is ordered first but fails open: if its `--apply` fails at boot,
docker still starts stages, unfenced (see "After a reboot" below). The stage
runner then starts nothing: its probe of `CANOPY_FENCE_PROBE` (step 4) gets
an answer, and canopy holds every stage and says "stages unfenced". The rules
need nothing docker makes, since `-i` matches the bridge by name, so they can
go in before the bridge exists. After a change to the script, repeat steps 1
and 2; `--apply` alone adds any missing rule and changes nothing on a rerun.

**3. A `stages-net` from before the bridge name.** One made before
`docker-compose.yml` named the bridge keeps docker's `br-<id>`, and the fence
matches nothing on it. If the network exists (a first deploy has none, and the
inspect says so) and this prints an empty line, remove it:

```
docker network inspect canopy_stages-net -f '{{index .Options "com.docker.network.bridge.name"}}'
docker compose rm -sf stages && docker network rm canopy_stages-net
```

**4. The fence probe, then build and start.** Set the probe target in `.env`:

```
CANOPY_FENCE_PROBE=http://192.168.1.1/
```

It must be a URL past the mini that answers HTTP whenever nothing drops the
packet: the LAN router's page is the usual one. The stage runner probes it at
start and every 5 minutes and starts nothing until a probe times out, which
only the fence makes happen. An answer means the fence is down. A lookup or
certificate failure says nothing either way, and holds the stages too. The
mini's own addresses and the stages bridge gateway will not do: ufw drops
those on INPUT with or without the fence, so their timeout proves nothing.
Unset or empty, every stage waits and the incubator says "stages unfenced"
with "set CANOPY_FENCE_PROBE".

Then build and start with `bun run redeploy`. Before compose runs it makes
the stages' host folders (off `DEV_ROOT` and `HOST_HOME` in `.env`), since
docker would make a missing bind mount as root: a root `.shared` stops canopy
copying a stage's inputs in, and a root login folder keeps the logins out.
`mkdir -p` leaves a folder docker already made alone, so check the owners:

```
stat -c '%U %n' ~/dev/_incubator ~/dev/_incubator/.shared ~/.config/canopy-stages/claude ~/.config/canopy-stages/codex
sudo chown -R "$(id -un):$(id -gn)" <each one that says root>
docker compose exec -u bun stages claude --version
docker compose exec -u bun stages codex --version
```

By hand the folders are
`mkdir -p ~/dev/_incubator/.shared ~/.config/canopy-stages/claude ~/.config/canopy-stages/codex`
and the deploy is `docker compose build stages canopy && docker compose up -d`,
which leaves out the commit stamp and the shells guard that redeploy adds.

canopy `depends_on` stages being healthy, so a broken stages image keeps
canopy down too. If canopy does not come up after a deploy, the first look is
`docker compose ps` and `docker compose logs stages`.

In the stages image claude and codex are root's, under `/opt/stage-tools`,
and the PATH holds root-owned folders only, so no stage can change what a
later one runs; the build fails if that is not so. claude does not update
itself there (`DISABLE_AUTOUPDATER=1`): a rebuild of stages is the update.
Before every start the stage runner also reads the stages' claude settings
(`settings.json` and `settings.local.json` in
`~/.config/canopy-stages/claude`) and codex config (`config.toml` in
`~/.config/canopy-stages/codex`) and refuses while either holds a key off
its short list, since a stage could have written hooks, an env, an MCP
server or a model provider there for every later stage. The step fails with
the file and the key; remove the key by hand, then retry the step:

```
cat ~/.config/canopy-stages/claude/settings.json ~/.config/canopy-stages/codex/config.toml
```

claude may keep `$schema`, `model` and `theme`; codex may keep `model`,
`model_reasoning_effort`, `model_reasoning_summary`, `model_verbosity`,
`personality`, `service_tier`, `preferred_auth_method` and the `[notice]`
table.

**5. The bridge.** `ip -br link show br-canopy-stg` on the host shows it.
Without it the fence has nothing to match: go back to step 3.

**6. DNS, then the fence check.** docker's resolver forwards the container's
queries from inside its namespace, through the fenced bridge, so the stages
service uses public servers (`dns:` in compose). Check what it forwards to:

```
docker compose exec stages cat /etc/resolv.conf   # "# ExtServers:" names 1.1.1.1 and 9.9.9.9, nothing private
```

Then the fence check, inside stages:

```
docker compose exec -e CANOPY_FENCE_TAILNET_IP=$(tailscale ip -4) \
  -e CANOPY_FENCE_LAN_IP=192.168.1.1 stages bun /app/fence-check.js
```

Every line should say `ok`. Only a timeout counts as blocked, since the fence
drops and never answers. canopy itself makes the same test on one target
before it runs any stage: the stage runner holds every spawn until its probe
of `CANOPY_FENCE_PROBE` (step 4) times out, and again from any probe that gets
an answer. This check is still worth running, since that probe covers one
target and a fence that drops it while letting something else through would
pass it. Any answer, or a refused or reset connection, means a
packet reached a host and counts as open, and a lookup or certificate failure
is an error. A target with nothing listening still says `BAD` without the
fence, except where ufw drops the packet on INPUT, which also ends in a
timeout: the bridge gateway and :7855 on the mini's own address read `ok` from
stages with or without the fence. The `iptables -t raw -S` listing in step 2
is what shows the fence there. For the LAN, name a host on the LAN (the
router, 192.168.1.1, or the NAS). The same check from canopy's container,
which is not fenced, is the control that gives the targets meaning: each
target stages should not reach should say `BAD` there (it answers, or refuses,
from a subnet ufw lets in), or an `ok` for it in stages proves nothing:

```
docker compose exec -e CANOPY_FENCE_TAILNET_IP=$(tailscale ip -4) \
  -e CANOPY_FENCE_LAN_IP=192.168.1.1 canopy bun /app/src/stage/fencecheck.ts
```

The mini's own tailnet address tests the drop ahead of docker's DNAT. Run the
stages check once more with `CANOPY_FENCE_TAILNET_IP` set to another node,
the Mac (`tailscale status` shows its address): that probe would leave through
`tailscale0`, so it is the one that shows the tailnet part of the fence
holding.
An asleep Mac times out too, so run the control check from canopy with the
Mac's address as well: its line there has to say `BAD` (the Mac answering),
or the `ok` in stages proves nothing.

**7. The logins**, in a real terminal on the mini (they are interactive).
The stages container runs as root (the stage runner drops each stage to
`bun`), so every exec that acts as a stage names the user. First claude,
then check where it put its account file:

```
docker compose exec -u bun -it stages claude              # then /login
docker compose exec stages ls -la /home/bun/.stage-claude/.claude.json   # should be there
docker compose exec stages ls -la /home/bun/.claude.json                 # should not
```

With `CLAUDE_CONFIG_DIR` set to `/home/bun/.stage-claude` (the image sets it)
the file belongs inside that folder, which is the mounted
`~/.config/canopy-stages/claude`. If it landed at `/home/bun/.claude.json`
instead, it sits in the home's tmpfs and the next restart of stages loses it,
with the login. Then `touch ~/.config/canopy-stages/claude.json` on the host
(a missing file would be made as a folder), add
`${HOST_HOME:-/home/eric}/.config/canopy-stages/claude.json:/home/bun/.claude.json`
to the stages service's volumes, `docker compose up -d stages`, and log in
again. Then codex:

```
docker compose exec -u bun -it stages codex login --device-auth
```

**After a reboot**, check that the fence came up before docker. The unit is
only ordered ahead of `docker.service`, so if its `--apply` fails, docker
still starts stages, unfenced:

```
systemctl is-active canopy-stages-fence   # active
sudo iptables -t raw -S PREROUTING        # the drops
```

If the unit failed, the incubator says "stages unfenced" and nothing runs
until the fence is back and the next probe, within 5 minutes, times out.

**8. The incubator word.** The incubator view should now say "stages
isolated". "stages unfenced" means the runner answers but its probe got
through, failed, or has no target: its title says which.

### Hardening (amendment 4)

The design is amendment 4 of
`docs/superpowers/specs/2026-10-01-incubator-design.md`. What changes on the
mini:

- canopy runs no git in a seed. Every git call it makes there (a card's
  status, its commit after scout, the ship's bundle, a mirror sync) runs in
  the stages container through the runner, as the stage user. While the
  runner is away a seed card keeps its last status and canopy's commit
  waits; nothing falls back.
- A seed is busy only while its own stage is, so one sprout's long build no
  longer holds the other sprout.
- The peer gate serves a seed from canopy's mirror at
  `~/dev/.canopy-mirrors/<slug>/.git`, never from the seed, and seeds leave
  the mini's own peer pass. A peer still reads the mini's seeds, at most one
  activity pass behind; a commit made to a peer's copy of a seed stays there.
- The stage runner runs as root and drops every child to `bun` with no
  groups. Its socket folder is `root:7850 0750`, and canopy holds gid 7850
  through `group_add`. No group by that name has to exist on the host.
- The stages container is read-only. The stage user's home and `/tmp` are
  tmpfs, so whatever a stage leaves there ends when stages restarts.

The deploy, once this is on main:

**1. Pick the caller gid.** On the mini, both of these should print
nothing; if either prints a line, put a free gid in `.env` as
`STAGECALLER_GID=<gid>` (it must not be `HOST_GID`):

```
getent group 7850
grep -E '^(HOST_GID|STAGECALLER_GID)=7850 It runs the incubator only with
`CANOPY_INCUBATOR_UNISOLATED=1`, which gives up all of part 3: stages run as
canopy, in its pid namespace and network. Parts 1 and 2 still hold.

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
  carries (the shells stage, so the shells have it too), logged in by
  `GH_TOKEN` from `.env`. That login is also git's credential helper for
  github.com in both containers (`GIT_CONFIG_*` in `docker-compose.yml`), so
  the panel's push, the background fetch of a private https remote and a
  `git push` typed into a shell all work. The desktop openers are not off,
  they moved: see the helper section above.
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

## Other canopy pages (multi-backend)

A backend answers another canopy page only when that page's origin is in
`CANOPY_ORIGINS`, comma separated, exact origins. This is a separate list
from each machine's own `backends` config (what `GET /api/backends` answers,
which URLs to dial): `CANOPY_ORIGINS` says who may call *this* machine,
`backends` says which *other* machines this page should call. The mini's
`.env` and the Mac's launchd plist each list the other machine's public and
tailnet origins plus their own ts.net origin. Prefer an https origin in
`CANOPY_ORIGINS` where the page allows it: a plain http page sends no
`Sec-Fetch-Site` header, which the origin gate otherwise uses to tell a
same-origin request apart from a cross-site one.

What each machine's `CANOPY_ORIGINS` should hold, once the rollout below has
added the mini's two loopback entries:

```
# the mini's .env
CANOPY_ORIGINS=https://canopy-mac.beric.ca,https://erics-macbook-pro.tail2d2c60.ts.net:7850,https://macmini-2018.tail2d2c60.ts.net:7849,http://127.0.0.1:7850,http://localhost:7850

# the Mac's launchd plist (ca.beric.canopy-server)
CANOPY_ORIGINS=https://canopy.beric.ca,https://macmini-2018.tail2d2c60.ts.net:7849,https://erics-macbook-pro.tail2d2c60.ts.net:7850,http://macmini-2018:7850,http://100.68.139.95:7850
```

Both machines list both tailnet https origins (each `tailscale serve` name,
amendment 2), since a page opened from either tailnet address may reach
either backend, and each other's public `beric.ca` origin, since a page
opened from one public name is home to that machine and needs the other's
permission to call it as a foreign backend. The mini also lists the Mac's own
page, `http://127.0.0.1:7850` and `http://localhost:7850`: the Mac's canopy
binds loopback only, so its own page is home there at that address, and it
needs the mini's permission the same way (amendment 7). The Mac lists the
mini's plain http tailnet addresses, `http://macmini-2018:7850` and
`http://100.68.139.95:7850`, for the matching case when the mini's own page
is open off `tailscale serve`, at the plain port canopy publishes directly.
Add a machine's origins on both sides before its client code ships, so a page
never sends a foreign origin nobody has listed yet.

**After a deploy**, check the multi-backend page actually reaches every
backend:

1. Run `~/.claude/skills/verify-build/clean-rebuild.sh verify checkoutPref`
   on the Mac and inside the mini's container, so a stale `dist/web` is not
   what you are about to check.
2. `GET /api/backends` on each machine and confirm its `backends` array
   names the other one with the right public and tailnet URLs (this is that
   machine's own config, not `CANOPY_ORIGINS`).
3. Open the page in a browser, both at a public name
   (`https://canopy.beric.ca` or `https://canopy-mac.beric.ca`) and at the
   Mac's own `http://127.0.0.1:7850`, the amendment 7 case the mini's
   loopback origins exist for. Look for the backends chip in the top bar:
   it shows as soon as this machine's own `backends` config names another
   one, whether or not that other one currently answers, so a missing chip
   means the config (or `GET /api/backends`) is wrong, not that the other
   backend is unreachable.
4. Open the chip's popover: both backends should read "online", each with the
   URL this page is actually using (`this page` for home, an origin for the
   other). Tell the reasons apart before touching `CANOPY_ORIGINS`: "*did not
   answer*" is a fetch that got no response at all (check the URL is right
   and reachable, e.g. `curl <url>/api/about`, before suspecting the origin
   gate); "*the event stream dropped*" can mean the backend is down just as
   easily as a CORS refusal on the stream, so confirm a plain fetch to that
   backend works before chasing `CANOPY_ORIGINS`; "*no URL this page can
   use*" means the `backends` entry itself has no public or tailnet URL this
   page's protocol can reach, which is a config problem on this machine, not
   the other one.
5. Find a repo checked out on both machines: its card should carry two
   machine chips, and clicking the non-home one should open that checkout's
   panel and, from there, a shell on the other machine.
 ~/dev/dev-tools/canopy/.env
```

**2. Deploy** with `bun run redeploy`, from the Mac or the mini, as usual.
It rebuilds both images; compose recreates stages for the read-only change
and canopy for the group. Nothing here needs sudo: the runner sets the
socket folder's owner and mode itself at every start, so the `stage-sock`
volume made before (owned by `bun`) needs no hand fix, and canopy makes
`.canopy-mirrors` as the host user.

**3. Check the runner and the socket:**

```
docker compose exec stages ps -eo user,group,args | grep stage-runner
                                        # root root bun /app/stage-runner.js
docker compose exec stages ls -ldn /run/canopy-stage /run/canopy-stage/runner.sock
                                        # drwxr-x--- 0 7850 and srw-rw---- 0 7850
docker compose exec canopy id           # groups=... includes 7850
docker compose exec -u bun stages ls /run/canopy-stage
                                        # Permission denied: a stage cannot reach the socket
docker compose logs stages | grep 'stages run as'
                                        # stages run as 1000:1000 with no groups; the socket is for group 7850 alone
```

**4. Check what a stage can write:**

```
docker compose exec -u bun stages sh -c 'touch /opt/x; touch /usr/local/bin/x; touch ~/ok && echo home ok; touch /tmp/ok && echo tmp ok'
                                        # two "Read-only file system", then home ok and tmp ok
docker compose exec -u bun stages sh -c 'cp /bin/true /tmp/t && /tmp/t && cp /bin/true ~/t && ~/t && echo exec ok'
                                        # exec ok: both tmpfs take exec, which bun create and bunx need
docker compose exec stages ls -la /home/bun/.stage-claude/.claude.json /home/bun/.stage-codex
                                        # the logins are still there (they are mounts, not the tmpfs)
```

If a login is gone, redo step 7 above.

**5. Check the incubator.** The incubator view says "stages isolated", and
each seed's card shows its status. Start a sprout, or wait for a running
one's next stage, and during it:

```
docker compose exec stages ps -eo user,group,supgrp,args | grep -E 'claude|codex'
                                        # bun bun - ... : the stage user, no supplementary group
```

**6. Check the mirrors and the gate.** After one activity pass (a minute or
so after start):

```
ls ~/dev/.canopy-mirrors
git -C ~/dev/.canopy-mirrors/<slug>/.git log -1 --oneline   # the seed's HEAD
```

Then, on the Mac, a fetch of that seed from the mini goes through the gate
to the mirror:

```
git -C ~/dev/_incubator/<slug> fetch mini && git -C ~/dev/_incubator/<slug> rev-parse mini/main
```

The sha matches the mini's `git -C ~/dev/_incubator/<slug> rev-parse main`.
A seed that has no mirror yet answers "canopy has no mirror of this seed
yet" until the next pass makes one.

**Back out** by redeploying the commit before the merge. The mirrors folder
can stay; nothing reads it then.

**A Mac backend** has no stages container. It runs the incubator only with
`CANOPY_INCUBATOR_UNISOLATED=1`, which gives up all of part 3: stages run as
canopy, in its pid namespace and network. Parts 1 and 2 still hold.

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
  carries (the shells stage, so the shells have it too), logged in by
  `GH_TOKEN` from `.env`. That login is also git's credential helper for
  github.com in both containers (`GIT_CONFIG_*` in `docker-compose.yml`), so
  the panel's push, the background fetch of a private https remote and a
  `git push` typed into a shell all work. The desktop openers are not off,
  they moved: see the helper section above.
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

## Other canopy pages (multi-backend)

A backend answers another canopy page only when that page's origin is in
`CANOPY_ORIGINS`, comma separated, exact origins. This is a separate list
from each machine's own `backends` config (what `GET /api/backends` answers,
which URLs to dial): `CANOPY_ORIGINS` says who may call *this* machine,
`backends` says which *other* machines this page should call. The mini's
`.env` and the Mac's launchd plist each list the other machine's public and
tailnet origins plus their own ts.net origin. Prefer an https origin in
`CANOPY_ORIGINS` where the page allows it: a plain http page sends no
`Sec-Fetch-Site` header, which the origin gate otherwise uses to tell a
same-origin request apart from a cross-site one.

What each machine's `CANOPY_ORIGINS` should hold, once the rollout below has
added the mini's two loopback entries:

```
# the mini's .env
CANOPY_ORIGINS=https://canopy-mac.beric.ca,https://erics-macbook-pro.tail2d2c60.ts.net:7850,https://macmini-2018.tail2d2c60.ts.net:7849,http://127.0.0.1:7850,http://localhost:7850

# the Mac's launchd plist (ca.beric.canopy-server)
CANOPY_ORIGINS=https://canopy.beric.ca,https://macmini-2018.tail2d2c60.ts.net:7849,https://erics-macbook-pro.tail2d2c60.ts.net:7850,http://macmini-2018:7850,http://100.68.139.95:7850
```

Both machines list both tailnet https origins (each `tailscale serve` name,
amendment 2), since a page opened from either tailnet address may reach
either backend, and each other's public `beric.ca` origin, since a page
opened from one public name is home to that machine and needs the other's
permission to call it as a foreign backend. The mini also lists the Mac's own
page, `http://127.0.0.1:7850` and `http://localhost:7850`: the Mac's canopy
binds loopback only, so its own page is home there at that address, and it
needs the mini's permission the same way (amendment 7). The Mac lists the
mini's plain http tailnet addresses, `http://macmini-2018:7850` and
`http://100.68.139.95:7850`, for the matching case when the mini's own page
is open off `tailscale serve`, at the plain port canopy publishes directly.
Add a machine's origins on both sides before its client code ships, so a page
never sends a foreign origin nobody has listed yet.

**After a deploy**, check the multi-backend page actually reaches every
backend:

1. Run `~/.claude/skills/verify-build/clean-rebuild.sh verify checkoutPref`
   on the Mac and inside the mini's container, so a stale `dist/web` is not
   what you are about to check.
2. `GET /api/backends` on each machine and confirm its `backends` array
   names the other one with the right public and tailnet URLs (this is that
   machine's own config, not `CANOPY_ORIGINS`).
3. Open the page in a browser, both at a public name
   (`https://canopy.beric.ca` or `https://canopy-mac.beric.ca`) and at the
   Mac's own `http://127.0.0.1:7850`, the amendment 7 case the mini's
   loopback origins exist for. Look for the backends chip in the top bar:
   it shows as soon as this machine's own `backends` config names another
   one, whether or not that other one currently answers, so a missing chip
   means the config (or `GET /api/backends`) is wrong, not that the other
   backend is unreachable.
4. Open the chip's popover: both backends should read "online", each with the
   URL this page is actually using (`this page` for home, an origin for the
   other). Tell the reasons apart before touching `CANOPY_ORIGINS`: "*did not
   answer*" is a fetch that got no response at all (check the URL is right
   and reachable, e.g. `curl <url>/api/about`, before suspecting the origin
   gate); "*the event stream dropped*" can mean the backend is down just as
   easily as a CORS refusal on the stream, so confirm a plain fetch to that
   backend works before chasing `CANOPY_ORIGINS`; "*no URL this page can
   use*" means the `backends` entry itself has no public or tailnet URL this
   page's protocol can reach, which is a config problem on this machine, not
   the other one.
5. Find a repo checked out on both machines: its card should carry two
   machine chips, and clicking the non-home one should open that checkout's
   panel and, from there, a shell on the other machine.
