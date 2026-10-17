# A credential for every caller of canopy's API

Date: 2026-10-16. Status: calls made, plan in
`docs/superpowers/plans/2026-10-16-caller-credential.md`. This blocks
the coordinator (FR-010, `2026-10-16-coordinator-design.md`, call 1).
Line numbers are at commit `1a5c5eb`.

## What it is and why

The coordinator is a chat run with curl and a token the server accepts
only on `/api/coordinator/plan` and reads. Eric's call on 2026-10-16: not
enough, since the API answers callers with no credential at all, so the
coordinator could `curl -X POST 127.0.0.1:7850/api/repos/run` bare. Before
it ships, every route that starts, stops or answers a run, or lets an agent
leave its role (shell input, settings and routing, secrets, peers), needs a
real per-caller credential, and the coordinator's carries none of those
rights.

## Where things stand (2026-10-16)

The only gate is the origin check (`src/server/index.ts:4399`).
`libraryOriginAllowed` passes any request with no `Origin` for `localhost`
or `127.0.0.1` (`src/core/library.ts:63-65`), and on an open bind for any
tailnet name (`:66`), so curl always gets in. `index.ts:4350` says so:
every mutating route is unauthenticated, and loopback or the tailnet is the
trust edge.

Each caller, how it reaches the API, and what it can do today:

- **The page.** Home at `http://127.0.0.1:7850` (the Mac's launchd server),
  `http://macmini-2018:7850`, the two `tailscale serve` names, and
  `canopy.beric.ca` / `canopy-mac.beric.ca` through cloudflared. The public
  names sit behind the beric-gate edge Worker, which forwards `X-Gate-User`
  as a plain header (`beric-gate/edge/worker.ts:360-367`). A page also calls
  other backends cross-site with `credentials: "include"` (`ui/src/api.ts:247`,
  `:1135`) under `CANOPY_ORIGINS`. It can do everything.
- **The CLI.** `land`/`queue` (`src/cli/land.ts:68`), `new` and
  `incubator` (`src/cli/index.ts:671`, `:682`), `ranger` (`:734`),
  `secrets` (`src/cli/secrets.ts:146`), `kit` (`src/cli/kit.ts:58`),
  `health` (`src/cli/health.ts:229`) dial `$CANOPY_API` or `127.0.0.1:7850`
  bare. `secrets unlock` passes `sameOriginOk` (`src/server/secrets.ts:52`)
  as any loopback caller with no Origin would.
- **Shells.** Each gets `CANOPY_API`, `CANOPY_TERM`, `CANOPY_REPO`,
  `CANOPY_BACKEND` (`canopyEnv`, `index.ts:1236`). The tailchan hook reads
  `GET /api/terms/watched`. A shell can do everything the page can.
- **The ranger.** A tmux session with `CANOPY_API` (`index.ts:4111`) that
  `lib/ranger.md` tells to `POST /api/repos/run` and `/api/ranger/wakes`.
- **Runs.** `claude -p` children get `CANOPY_RUN`, `CANOPY_REPO`,
  `CANOPY_BACKEND` (`runEnv`, `src/core/runner.ts:117`) laid over canopy's
  whole env (`spawnEnv`, `src/core/driver.ts:162`). No `CANOPY_API`, but
  `127.0.0.1:7850` answers them: on the Mac they share loopback, on the mini
  they live inside canopy's own container.
- **Helpers.** `canopy helper` dials the `/api/helper` socket
  (`index.ts:4404`) and opens what the page asks on its desktop. Nothing
  checks who registers.
- **Others.** `scripts/redeploy.sh` only reads (`/api/runs`, `/flows`,
  `/landing`). Peers use the ssh forced command `canopy peers gate`, stages
  cannot reach canopy past their fence (`docs/deploy.md:537`), and no
  backend calls another's API. The answer key (`ui/src/answerKey.ts:15`)
  and the secrets service's passkey sessions stay as they are.

## What a token can and cannot stop

On the mini a run has the uid and pid namespace of every shell. It can read
`/proc/<pid>/environ` of a shell or the ranger, read canopy's config
folder, use the tmux socket, and `ssh mini-host` to the host's docker
(`docs/deploy.md:178`). On the Mac everything runs as one user. So
per-caller tokens close the bare curl, and they keep a prompt-injected or
confused run to its own rights. They do not stop a run that sets out to
take a shell's token, a token file, or the tmux socket. That needs the run
isolated (call 1). This is the same bar the answer key states
(`docs/deploy.md:431-438`).

## The design

### Rights and kinds

Six rights: `read`, `plan`, `operate` (start, stop, answer or say to runs,
flows, fleets, jobs, tasks, workspace runs, landing, the incubator, git
writes, ranger wakes, tailchan sends), `shell` (open or join a shell, paste,
restore, move or end one), `admin` (agents profile and role, so yolo,
sources, kit writes, secrets writes, peers sync and `repos/peer`, launcher,
ranger restart and fresh, keep, sign-in approvals), plus `helper` for the
helper socket.

| Kind | Gets it by | Rights |
|---|---|---|
| page session | pairing (below) | read, operate, shell, admin |
| CLI | `canopy auth login`, a token file | read, operate, admin |
| shell | minted at shell start, `CANOPY_TOKEN` in its env | read, operate |
| ranger | minted at session start, `CANOPY_TOKEN` | read, operate |
| coordinator | minted per coordinator run, `CANOPY_TOKEN` | read, plan (its own run) |
| other runs | nothing, as today | read |
| helper | `canopy helper --pair`, a token file | helper |

The coordinator spec's `CANOPY_COORD_TOKEN` becomes `CANOPY_TOKEN`, so the
CLI finds one name in a shell, the ranger and the coordinator.

### The check at the edge

A new `src/core/callers.ts` (pure) holds the route table and `needs(method,
path, action)`. The default denies: any non-GET route not in the table
needs `admin`, so a new route is safe until someone files it. Every GET
needs only `read`; the GET actions of `/api/repos/<action>` change nothing.
The exceptions: the `/api/term` upgrade (with `start=agent` it starts an
agent) needs `shell`, `/api/helper` needs `helper`, and Library POSTs
(import, move, attach, edit a category in `~/dev`) need `admin`.

`src/server/callers.ts` holds `CallerBook`: tokens by SHA-256 hash, each
with kind, rights, label, and its run or term id. `route()` calls
`callerOf(req)` at its top, above the Library hand-off (`index.ts:4398`),
which today runs before the origin gate, and above the upgrades. The token
rides `X-Canopy-Token`, which keeps clear of the edge Worker's Bearer
exceptions (`hasBearer`, `worker.ts:144`). A missing token answers 401, a
token short of the right 403, both naming the right. The plan route also
checks that the body's `run` is the token's own.

Sockets cannot send headers. `POST /api/auth/ticket {for: "term"|"helper"}`
returns a 60-second, single-use ticket, which the socket URL carries as
`ticket=`. The event stream stays a plain read.

### Tokens in a child's env

A token is `cnp_<kind>_` plus 32 random bytes, base64url. Shell tokens go
in through `canopyEnv`, the ranger's through its `env`, the coordinator's
through `runEnv` for that run alone. `CANOPY_TOKEN` joins `INHERITED_ENV`
(`src/core/term.ts:146`), which the server deletes from its own env at
start (`index.ts:3821`), so a canopy started in a canopy shell never hands
that shell's token to its runs through `spawnEnv`.

Shells and the ranger outlive canopy on the mini, and a shell's env is set
once, so `CallerBook` keeps hashes, never tokens, in `<config>/callers.json`
(0600) and reloads them at start. An entry goes when its shell ends or its
run settles. Reading the file gives a run nothing usable; writing it is the
file access call 1 is about.

### Pairing a page or the CLI

A page without a token for a backend shows "sign in to <backend>" in the
top bar. Pressing it calls `POST /api/auth/pair {label}`, which answers a
pair id, a short code to compare, and a secret the page keeps. Every page
already signed in to that backend gets an inbox item: browser, address,
code, allow or deny. Allow is `POST /api/auth/approve` and needs `admin`,
so a run can ask but never approve. The waiting page claims its token with
the secret and keeps it in `localStorage` as `canopy.token.<backend
origin>`. Requests expire after 10 minutes; at most three wait at once.

While a backend has no session, it prints a one-time first code to its
stdout (`~/Library/Logs/canopy-server.log` on the Mac, `docker compose
logs canopy` on the mini), which the sign-in strip takes in place of an
approval. The local Mac page, `tailscale serve` names and the tunnel all
pair this way. A page pairs with each backend on its own,
and `x-canopy-token` joins `Access-Control-Allow-Headers`
(`src/core/cors.ts:31`) for the cross-site calls. Sessions last 30 days
from last use; settings lists and revokes them.

`canopy auth login [--backend]` pairs the CLI the same way and writes
`~/.config/canopy/token-<host>` (0600). The CLI sends `--token`, else that
file when it exists, else `CANOPY_TOKEN`, so `canopy secrets unlock` typed
in a canopy shell still carries `admin`.

## Migration and rollout

`CANOPY_CALLERS=off|log|enforce`, default `log` in the release that adds it.
In `log` every request runs as today, and a request that would be refused
is logged (kind or "none", route, Origin, user agent) and counted on
`GET /api/auth`, which the settings popover shows.

1. Ship in `log`. Pair the Mac page, the phone and the CLI on both machines.
2. Restart the ranger (`/api/ranger/fresh`) on both, so it carries a token.
3. Watch the log for a week on the Mac (launchd plist) and the mini (`.env`).
   Shells opened before the release carry no token. They keep working in
   `log`, and under `enforce` their CLI gets 401 saying to open a new
   shell.
4. Set `CANOPY_CALLERS=enforce` in the plist and `.env`. Rollback is `log`.
5. The coordinator merges only after both machines enforce.

## Components

- `src/core/callers.ts` (new, pure): rights, kinds, route table, `needs`.
- `src/server/callers.ts` (new): `CallerBook`, `callerOf`, pairing,
  tickets, the first code, `/api/auth/*`.
- `src/server/index.ts` (the check in `route()`, tokens for shells and the
  ranger), `src/core/runner.ts` (the coordinator's), `src/core/term.ts`,
  `src/core/cors.ts`.
- `src/cli/`: `canopy auth login|logout|status`, `helper --pair`, one
  `callerHeaders()` for every `fetch`.
- `ui/`: tokens per backend, the header on writes, socket tickets, the
  sign-in strip, inbox approvals, sessions in settings.
- `docs/deploy.md` and `docs/architecture.md`: the flag and a section.

## Calls for Eric

Eric took every recommendation on 2026-10-16. Call 1 means coordinator
runs are isolated. That isolation is the coordinator's work (FR-010), not
this spec's: it gets its own design with the coordinator plan, and the
coordinator stays off the Mac until a sandbox there is checked. This spec
ships tokens alone, in `log` and then `enforce`.

1. **The bar for the coordinator.** Tokens close bare calls. They do not
   stop a run that reads another caller's token or reaches tmux or `ssh
   mini-host`. Recommendation: run coordinator runs isolated, as the stage
   runner runs incubator stages (own pid namespace, no `~/.ssh`, no canopy
   config, no tmux socket), and keep the coordinator off the Mac until a
   sandbox there is checked. This is new work, not an existing mechanism:
   the stages fence drops every private address, so the coordinator would
   need a network or fence rule that reaches canopy's port alone. The other
   way is to accept the gap, as for secrets on 2026-10-14.
2. **Reads stay open.** Recommendation: yes for now. The coordinator needs
   reads, and a shell already reads every pane through tmux.
3. **The first session.** Recommendation: the one-time code in the log.
   Later, beric-gate could forward a signed identity that canopy checks with
   a public key. The `X-Gate-User` header it forwards now can be forged by
   anything that reaches canopy's port directly.
4. **Shell and ranger rights.** Recommendation: `operate` only. No `shell`,
   since an agent should not type into another shell through canopy, and no
   `admin`, so no agent turns yolo on.
5. **The CLI's rights.** Recommendation: read, operate and admin, from a
   token file. Any agent can read that file, which call 1 covers.
6. **Helpers and session length.** Recommendation: helpers enforced with
   everything else, sessions 30 days from last use.

## Testing

- `callers.test.ts`: every route maps to a right, an unknown non-GET needs
  `admin`, the term upgrade needs `shell`.
- Server, per kind (none, shell, ranger, coordinator, page) against a run
  start, `runs/answer`, a term upgrade, `agents/role` and the plan route:
  401 or 403 under `enforce`, a logged pass under `log`, a plan for another
  run refused.
- Pairing: a run asks but cannot approve; claims, first codes and tickets
  work once; requests expire. Restart: hashes reload, an ended shell's
  token is dead. Env: no `CANOPY_TOKEN` in canopy's own env or an ordinary
  run's.
- Live, on both machines: a bare `curl -X POST .../api/repos/run` from a
  run gets 401, and the page, `canopy land` in a shell and the ranger work.

## Risks

- A same-user run can still take a token (call 1).
- A route under the wrong right. The `admin` default and the table test
  limit it.
- A caller outside this repo that writes (a hook, a script). The log week
  is there to find it.
