# Several canopy backends, one frontend

Today a canopy page talks to exactly one server, the one that served it:
`ui/src/api.ts` fetches relative `/api/...` paths, and the event stream and the
shell websockets are built off `location`. The Mac runs its own canopy on
loopback (launchd, `127.0.0.1:7850`) and the mini runs the shared backend
(`http://macmini-2018:7850` on the tailnet, `https://canopy.beric.ca` through
the Cloudflare tunnel and the beric-gate edge Worker). To see the Mac's repos
and shells from the phone, there is no way in at all.

This spec lets one page connect to several backends at once, on the tailnet
and off it (the phone needs both), and shows a repo that lives on several
machines as one card. It also changes what closing a panel does to its shells;
that part stands alone and can ship first.

What the user asked for, in their words: "allow multi canopy backend and allow
frontend to connect", "off-tailnet too, phone needs it", one card per repo with
a machine strip (option A), and "when closing Card don't terminate the shells
opened".

Out of scope, each a later spec if wanted: serving the SPA from Vercel (this
spec makes it possible, see "Hosting later"), a native client wrapper, a
containerized backend on the Mac (Docker on macOS is a Linux VM, which would
lose the launcher, the desktop openers and every macOS tool).

## 0. Closing a panel detaches its shells

Today `closePanel` (`ui/src/store.ts`) calls `endShells` on every shell tab the
panel held, which kills their tmux sessions. From now on:

- Closing a panel, or a solo, section or shell window, drops the tabs and
  leaves every shell held on its backend. Nothing is killed.
- A detached shell shows in the `▸_ n` shells picker and in `FrontOthers`
  like any other untabbed shell.
- Reopening that repo's panel brings its panel shells back as tabs.
  `adoptTerms` already adopts a panel shell once its panel is open, so this
  needs no new path.
- A shell ends only by the tab's ×, "end" in the shells picker, or exiting on
  its own. A busy shell, a Claude turn in progress included, is left running.
- `keepShells` snapshots a detached shell like any held one.

`hiddenTerms` is not involved: hiding is the explicit "hide here" in the
picker, which keeps a shell out of adoption; a detached panel shell is meant to
come back when its panel does.

## 1. Topology and the backend registry

A **backend** is one canopy server on one machine. It is named by its peer-sync
identity (`peers.self`, what `GET /api/peers` answers as `self`), so a backend
and its peer-sync name always agree. A backend with no peers config uses the
hostname's first label.

Each backend's config gains a `backends` array:

```json
"backends": [
  { "name": "mini", "public": "https://canopy.beric.ca", "tailnet": "http://macmini-2018:7850" },
  { "name": "mac",  "public": "https://mac.canopy.beric.ca", "tailnet": "https://erics-macbook-pro.tail2d2c60.ts.net:7850" }
]
```

`normalizeBackends` (pure, `src/core/backends.ts`, tested) validates it field
by field the way `normalizePeers` does: a slug name (`[a-z0-9-]+`, which is
what makes `|` safe as the id separator in section 2), `public` an https origin,
`tailnet` an http or https origin, at least one of the two, names unique.
`GET /api/backends` answers `{ self, backends }`. The order is the preference
order the client falls back through.

The page asks the backend that served it (the **home** backend) and caches the
answer in `canopy.settings` as `backends`, with a per-browser `hiddenBackends`
list. A page with no home backend (a static host, later) starts from the cache
or from a URL typed into Settings.

**Which URL.** A page loaded from a `*.beric.ca` origin uses every backend's
`public` URL. A page loaded from a tailnet host uses `tailnet` URLs and falls
back to `public` when the tailnet URL does not answer `/api/about` within 3s,
remembering the choice for the page's life. An https page never picks an http
tailnet URL, since the browser blocks that as mixed content; it goes straight
to `public`. The Mac should not leave through Cloudflare to reach itself,
which is why tailnet URLs exist at all. The pure `pickUrl(pageOrigin, backend)`
makes the first choice and is tested.

**Tunnels.** Each machine has its own Cloudflare tunnel and connector:

- mini: the tunnel it has now (`canopy.beric.ca`, ingress `http://canopy:7850`).
- mac: a **new** tunnel for `mac.canopy.beric.ca`, its connector a launchd agent
  pointed at `http://127.0.0.1:7850`. Not the parked
  `ca.beric.canopy-tunnel`, which is a connector on the mini's tunnel: two
  connectors on one tunnel share its ingress and Cloudflare splits requests
  between them.

The Mac's canopy keeps binding loopback only; the connector is what reaches it,
so its unauthenticated API is never on a network interface. A tailnet client
reaches the Mac through `tailscale serve --https=7850 http://127.0.0.1:7850`
(the Mac's serve already holds 443 for :3000), which also leaves canopy on
loopback. Since the Mac binds loopback, its gate does not take tailnet
hostnames on its own (`open` is false), so its own
`https://erics-macbook-pro.tail2d2c60.ts.net:7850` goes in its
`CANOPY_ORIGINS`.

**What stays per backend.** Sources, peers, agent settings, launcher settings,
workspaces, keepShells and the preview ports are each one backend's config.
Settings shows them for one backend at a time behind a backend picker, the
home backend first.

## 2. Client model

**Qualified ids.** Every id the store holds names its backend:
`mac|dev-tools/canopy`, `mini|dev-tools/canopy`. Backend names are slugs, so
splitting on the first `|` is unambiguous whatever the repo id holds (`/`, `:`,
`.`). The pure `qualify(backend, x)` and `unqualify(id)` in `ui/src/backends.ts`
are the only code that adds or strips the prefix, and they run only in
`ui/src/api.ts`:

- **Outbound.** A call that takes a repo id splits it, sends the plain id to
  that backend's base URL with `credentials: "include"`.
- **Inbound.** Every response and event is qualified before the store sees it:
  `Repo.id`, `Run`, `Flow`, `Fleet` (and its per-repo rows), `Job`,
  `TermInfo`, `KeptShell`, the `builds` event's `repoId`, and the history
  overview's repo keys. Run, flow, fleet and job ids are qualified too, since
  two servers may mint the same one.
- The agents and launchers maps are keyed by absolute path, and the same
  path can name different checkouts on different machines (the notebook
  resolves `/Users/ericbaruch` through a symlink), so the store keeps them per
  backend: `agents[backend][path]`. `agentFor(s, repo)` reads the repo's
  backend off its id.

To the rest of the store an id is still an opaque string, so most of it does
not change.

**Connections.** One `subscribe` per backend (the existing one, given a base
URL and `withCredentials`), each with its own watchdog, retry and
`onReconnect` refetch of that backend's state. `socketUrl` in `TermDock.tsx`
builds the shell websocket from the tab's backend (`wss` for an https base)
instead of `location.host`. A term tab's backend is its repo id's.

**The join.** `ui/src/checkouts.ts` (pure, tested):
`joinRepos(repos: Repo[]) → RepoCard[]`, `RepoCard = { key, name, checkouts }`.

- The key is the repo's first remote that `webUrl` (`core/access.ts`) maps to
  a web page, normalized to lowercase `host/owner/name`. Peer remotes never
  map, since their urls are ssh aliases. A repo with no such remote keys as
  `rel:<plain id>`, which is what peer-synced checkouts share anyway.
- Checkouts sort by the registry's order.
- Grouping, filters and sorting run over cards. A card's `changedAt` is the
  newest of its checkouts'; `dirtyOnly` keeps a card if any checkout is dirty;
  text filters match the name, which checkouts share.

**Machine strip.** A card shows one chip per checkout: the backend name, the
dirty count, ahead/behind. An offline backend's chip is grey and shows the
last state it reported. With one backend in the registry there is no strip.

**Panels.** A panel is one checkout: `panels` holds qualified repo ids and
every section works as it does today. The panel head gets a machine switcher
over the card's checkouts, which replaces the panel's id with the sibling's.
Opening a card picks the backend last used for that card (`checkoutPref` by
card key, in the layout), else the first online backend in registry order.

**Everything else.** Shells, runs, flows, fleets, jobs, devices and kept
shells merge into one list each, every row with its backend's name. The
cross-repo search groups the ids by backend and fans out one `POST /api/grep`
per backend. Desktop openers resolve per backend: `clientCaps` runs against
each backend's `ClientInfo` and helpers, since a helper registers with one
backend; `helperFor` sends the name that backend knows. Workspaces are the
home backend's.

## 3. Auth and CORS

**The origin gate.** `libraryOriginAllowed` (`src/core/library.ts`) gains a
fourth way in: `CANOPY_ORIGINS`, a comma-separated list of exact origins that
may drive this backend from another origin. A listed origin passes even when
`sec-fetch-site` is `cross-site`, which is what two tailnet hostnames are to a
browser. An unlisted one gets the 403 it gets today. The mini lists
`https://mac.canopy.beric.ca` and
`https://erics-macbook-pro.tail2d2c60.ts.net:7850`; the Mac lists
`https://canopy.beric.ca`, `http://macmini-2018:7850` and its own ts.net
origin. The mini's http tailnet page can call the Mac's https URL (an http
page may fetch https); the Mac's https page cannot call the mini's http one,
so it uses `canopy.beric.ca`, per `pickUrl`.

**CORS.** For a listed origin every `/api/*` answer carries
`Access-Control-Allow-Origin: <that origin>`,
`Access-Control-Allow-Credentials: true` and `Vary: Origin`. An `OPTIONS`
preflight from a listed origin is answered before any route runs, with
`Access-Control-Allow-Methods: GET, POST, DELETE`,
`Access-Control-Allow-Headers: content-type` and `Access-Control-Max-Age: 600`.
There is never a wildcard. An unlisted preflight gets a 403 with no CORS
headers.

**Websockets.** Browsers never preflight a websocket, so the origin check on
the upgrade is the whole defence for `/api/term` and `/api/helper`. Both sit
under `/api/`, so the gate already runs before the upgrade; the tests pin it.

**Off the tailnet.** `beric_gate` is `SameSite=Lax` with the `.beric.ca`
cookie domain, and every `*.beric.ca` host is one site, so the browser sends it
on fetches, `EventSource` (with `withCredentials`) and websockets from
`canopy.beric.ca` to `mac.canopy.beric.ca`. One sign-in covers every backend.
On the tailnet there is no cookie: tailnet membership is the trust edge, as
today.

**Edge Worker** (`homelab/services/beric-gate/edge/worker.ts`):

- A CORS preflight to a canopy host (an `OPTIONS` with `Origin` and
  `Access-Control-Request-Method`) goes to the origin without the gate check.
  A preflight runs nothing, and the request after it still needs the cookie.
- `mac.canopy.beric.ca` (and later `wsl.canopy.beric.ca`) join the gate with
  the policy `canopy.beric.ca` has.

**No session.** A cross-origin fetch with no session gets the Worker's 401
JSON (`{"error":"unauthorized","login":...}`, what it answers today). The
client marks that backend `signin` and links to the `login` it names, with
`next` set to the backend's URL.

## 4. Offline backends and errors

Each backend is `connecting`, `online`, `offline` (the stream failed or a
fetch got no answer) or `signin` (a 401 from the gate). The pure reducer
`backendState(prev, signal)` is tested. The top bar gets a backends chip, one
word per backend, rust for anything but `online` (as `PeersChip` does); its
popover lists each backend's state, the URL in use, a retry, and the sign-in
link for `signin`.

What a backend that is not online leaves behind:

- Its checkouts stay on their cards, grey, with the last state they reported.
  A card with no online checkout dims.
- A panel open on its checkout offers to switch to an online sibling.
- Its shell tabs stay and show "[backend offline]", reconnecting at the
  doubling waits `TermView` already uses.
- Its runs, flows and jobs keep their last state.

**Version skew.** Each backend's `/api/about` is compared with the page's
build through `sameBuild`. A mismatch shows on that backend's row in the chip
and is not an error, since the API only grows. A backend too old to answer
CORS shows as `offline` with that reason.

**One backend.** With no `backends` config the registry is the home backend
alone, under its own name, and none of the new UI shows: no chip, no machine
strip, no switcher.

## 5. Testing

Pure, with tests beside them:

- `qualify`/`unqualify` round-trips over every event and response shape the
  client qualifies.
- `joinRepos`: peer remotes ignored, the `rel:` fallback, a card's
  `changedAt` and dirty state, checkout order.
- `pickUrl` by page origin; `normalizeBackends`; `backendState`.
- `libraryOriginAllowed` against listed, unlisted, cross-site and tailnet
  cases.

Server (`startServer` with `CANOPY_ORIGINS` set):

- A listed preflight gets the right headers; a listed fetch and websocket
  upgrade go through; an unlisted origin gets 403 on both.
- No response anywhere carries `Access-Control-Allow-Origin: *`.

Two backends (`src/server/multi.test.ts`): two `startServer` instances on
scratch roots, the client's api layer run against both through an injected
fetch under `bun test`. It checks qualified ids, the join over a repo both
hold, event routing, and that a shell started on B is reached through B's
socket URL.

Store: closing a panel makes no `DELETE /api/terms`, and its shells come back
as tabs when the panel reopens (`adoptTerms` tests extended).

Edge Worker, in beric-gate's `edge/worker.test.ts`: a canopy preflight passes;
a bare `OPTIONS` and a cookieless `GET` still get the login; the new host is
gated.

By hand: the phone off the tailnet signs in once, sees the Mac's and the
mini's checkouts on one card, and opens a shell on each.

## Rollout

1. Section 0 alone (UI only), shipped and redeployed.
2. Server: `backends` config, `GET /api/backends`, `CANOPY_ORIGINS`, CORS.
   Deployed to both machines before any client uses it; nothing changes for a
   page that does not send a foreign origin.
3. Edge Worker preflight pass-through and the `mac.canopy.beric.ca` gate entry;
   the Mac's tunnel and launchd connector; `tailscale serve` on the Mac.
4. Client: registry, qualified ids, per-backend connections, join, machine
   strip, switcher, backends chip.

## Hosting later

With the client reaching every backend by URL, the SPA is static files any
backend or a static host can serve. Moving `canopy.beric.ca` to a static host
means the mini's backend takes a name of its own (`mini.canopy.beric.ca`) and
the page starts from the cached registry. That is a follow-up, not this spec.

## Amendments (2026-09-26, found while planning)

1. **Host names are one level deep.** Cloudflare's Universal SSL covers
   `*.beric.ca` and not `*.canopy.beric.ca`, so the Mac's public name is
   `canopy-mac.beric.ca`, not `mac.canopy.beric.ca` (later `canopy-wsl`).
   Everywhere above that says `mac.canopy.beric.ca` means `canopy-mac.beric.ca`.
2. **Every tailnet URL is https on a ts.net name.** A tailnet page on a ts.net
   origin calling `canopy.beric.ca` is cross-site, and `beric_gate` is
   `SameSite=Lax`, so the cookie would not go; and an https page cannot call
   an http tailnet URL. So the mini also gets `tailscale serve`, on
   `https://macmini-2018.tail2d2c60.ts.net:7849` (port checked free; the mini's
   serve already holds 443, 8443 and 9443) proxying `http://100.68.139.95:7850`.
   Tailnet URLs are then all https, `pickUrl` never meets mixed content, and a
   tailnet page never needs the cookie.
3. **A listed origin's own page passes without an Origin header.** Behind
   `tailscale serve` a backend sees its ts.net name as Host and the request as
   http, and a browser's same-origin GET sends no Origin at all. So the gate
   also accepts a request with no Origin, not marked `cross-site`, whose Host
   is the host of a listed origin. A rebound domain cannot send that Host.
4. **The Worker answers a canopy host's denials with CORS.** A credentialed
   cross-origin fetch whose answer lacks `Access-Control-Allow-Origin` is a
   network error to the page, so without this the client could never tell
   `signin` from `offline`. For a canopy host (`canopy.beric.ca`,
   `canopy-<name>.beric.ca`) and an `Origin` that is itself an https canopy
   host, the gate's non-2xx answer carries `Access-Control-Allow-Origin: <origin>`,
   `Access-Control-Allow-Credentials: true` and `Vary: Origin`. It reveals only
   the login URL the answer already holds.
5. **Two plans.** The first makes every backend reachable from another origin
   and ships section 0 (shells, server, Worker, tunnels, config). The second
   is the client (registry, qualified ids, connections, join, machine strip,
   switcher, chip), written against the code the first one lands.
