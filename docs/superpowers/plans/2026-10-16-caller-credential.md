# Caller credentials: a token for every caller of canopy's API

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Status:** planned 2026-10-16. Eric took every recommendation in the
spec's "Calls for Eric". Isolating coordinator runs (call 1) belongs to the
coordinator plan, not this one.

**Goal:** every non-GET route, the term socket and the helper socket need a
per-caller token carrying the right for that route. The flag starts at `log`
and moves to `enforce` after a week.

**Architecture:** a pure route table (`src/core/callers.ts`) says which
right each request needs. A `CallerBook` (`src/server/callers.ts`) keeps
token hashes, pairing requests and tickets. `route()` checks the two at
its top, above the Library hand-off. Shells and the ranger get
`CANOPY_TOKEN` when they start. The page and the CLI pair with a code. The
CLI, the page and the helper send `X-Canopy-Token`. Sockets carry a
one-time `ticket=`.

**Tech stack:** Bun + TS server, React 19 SPA, `bun test`.

**Spec:** `docs/superpowers/specs/2026-10-16-caller-credential-design.md`.
Line numbers below are at `9603292`.

## Global constraints

- Six rights: `read`, `plan`, `operate`, `shell`, `admin`, `helper`.
- Kinds and rights:
  - page: read, operate, shell, admin.
  - cli: read, operate, admin.
  - shell: read, operate.
  - ranger: read, operate.
  - coordinator: read, plan.
  - none: read.
  - helper: helper.
- Every GET needs only `read`, and `none` has `read`, so reads stay open (call 2).
- A non-GET route missing from the table needs `admin`.
- Header `X-Canopy-Token`. A token is `cnp_<kind>_` plus 32 random bytes in base64url. The book stores SHA-256 hex, never the token.
- `<configDir>/callers.json`, mode 0600, in a 0700 directory.
- Tickets live 60 s and work once. Pair requests expire after 10 min, and at most 3 wait at once.
- Page and CLI sessions last 30 days from last use. Shell, ranger and helper tokens last until revoked or until their term ends.
- `CANOPY_CALLERS=off|log|enforce`, default `log`.
- Refusals:
  - 401 `{error, need}` when there is no token, or an unknown one.
  - 403 `{error, need}` when the token lacks the right.
  - Neither body has a `login` field: `ui/src/api.ts:189` reads `login` as the edge gate's sign-in.
- The page keeps tokens in `localStorage` under `canopy.token.<backend origin>`. The CLI keeps one at `<configDir>/token-<host>-<port>`, 0600.
- The CLI picks its token from `--token`, else the token file, else `CANOPY_TOKEN`.

## Review focus

1. A shell opened before this release carries no token. Under `log` its CLI works. Under `enforce` a write gets 401 saying "open a new shell". Test in Task 3.
2. Canopy restarts while shells live on (the mini). Hashes reload and old shell tokens still work. A token whose term is gone dies at the first prune. Test in Task 4.
3. A canopy 401 must not look like the edge's sign-in. The UI must not show "sign in" through the gate. The CLI's `ask()` must stop trying the next URL on a canopy 401 (`src/cli/health.ts:213`). Tests in Tasks 6 and 7.
4. The helper redials with backoff (`src/core/helperd.ts:134`), so every dial fetches a fresh ticket. A reused ticket gets 401. Test in Task 6.
5. A page signed in to two backends never sends backend A's token to backend B. A cross-site preflight allows `x-canopy-token`. Test in Task 7.

---

### Task 1: The route table (`src/core/callers.ts`, pure)

**Files:** create `src/core/callers.ts` and `src/core/callers.test.ts`.

**Interfaces:**
- Produces:
  - `type Right = "read" | "plan" | "operate" | "shell" | "admin" | "helper"`
  - `type CallerKind = "page" | "cli" | "shell" | "ranger" | "coordinator" | "helper" | "none"`
  - `KIND_RIGHTS: Record<CallerKind, readonly Right[]>`
  - `needs(method: string, path: string, query?: URLSearchParams): Right | "open"`
  - `allows(kind: CallerKind, right: Right | "open"): boolean`

"open" covers the routes that pairing needs before a caller has a token:
`POST /api/auth/pair`, `/api/auth/claim` and `/api/auth/first`.

The table, by path. The `/api/repos/<action>` POSTs key on the action.
Anything left out falls through to `admin`:

- **open:** `POST auth/pair`, `auth/claim`, `auth/first`.
- **read (POSTs that change nothing):**
  - `POST grep`, `remembered/check`, `repos/movecheck`
  - `POST auth/ticket`. Its handler checks the ticket's own right, `shell` or `helper`.
- **operate:**
  - Runs: `POST runs/answer|stop|say`, `DELETE runs`.
  - Flows, fleets and jobs: `POST flows/resume|stop`, `DELETE flows`, `POST|DELETE fleet`, `POST fleet/stop`, `DELETE jobs`, `POST jobs/stop`.
  - Workspaces: `POST|DELETE|PATCH workspaces`, `POST workspaces/run|open`.
  - Repo actions: `POST repos/{run,flow,resume,stage,commit,push,pull,unlock,note,favorite,spec,suggest,refresh}`.
  - Repo health and tasks: `POST|DELETE repos/health`, `POST repos/tasks`, `repos/tasks/def`.
  - Landing and PRs: `POST landing/*`, `prs/*`.
  - Incubator: `POST|DELETE incubator`, `POST incubator/*`.
  - Ranger wakes: `POST|DELETE ranger/wakes`.
  - Tailchan: `POST tailchan/send|put|notify`.
  - Asks and presence: `POST asks/answer`, `presence`, `presence/beat`.
  - Layouts: `POST|DELETE layouts`, `POST layouts/reset`.
  - Other: `POST rescan`, `POST preview`.
- **shell:**
  - `POST terms/restore|paste|move/out|move/finish|move/undo`
  - `DELETE terms`, `DELETE terms/kept`
  - `POST repos/agent`, `repos/movein`
  - the `/api/term` upgrade
- **helper:** the `/api/helper` upgrade.
- **admin** (written out for the test; the default covers them anyway):
  - Agents and peers: `POST agents/profile|role`, `peers/sync`, `repos/peer`.
  - Sources: `POST|DELETE sources`, `POST sources/rescan`.
  - Kit, secrets and the ranger: `POST kit/*`, `secrets/*`, `ranger`, `ranger/restart|fresh`.
  - Other: `POST keep`, `health/heal`, `remembered/forget`, `PUT guards`.
  - Repo actions: `POST repos/{archive,open,openfile,launch,halt,install,uninstall,build,launcher}`.
  - Library: Library POSTs (`/api/library*`, `/library/*`).
  - Auth: `POST auth/approve|deny|revoke`.

- [ ] **Step 1: Write the failing tests** in `callers.test.ts`:
  - `needs("GET", "/api/runs")` is `"read"`, for every GET row above.
  - The `repos` rows: `needs("POST", "/api/repos/run")` is `"operate"`, and so are `pull` and `commit`. `needs("POST", "/api/repos/peer")` and `repos/launch` are `"admin"`.
  - `needs("POST", "/api/runs/answer")` is `"operate"`, and `needs("POST", "/api/agents/role")` is `"admin"`.
  - `needs("POST", "/api/made-up")` and `needs("PUT", "/api/runs")` are `"admin"`.
  - `needs("GET", "/api/term")` is `"shell"`, and `needs("GET", "/api/helper")` is `"helper"`. Upgrades are GETs, so these two are the GET exceptions.
  - `needs("POST", "/library/refresh")` is `"admin"`, and `needs("GET", "/library/x")` is `"read"`.
  - `needs("POST", "/api/auth/pair")` is `"open"`.
  - `allows("shell", "admin")` is false, `allows("none", "read")` is true, `allows("none", "operate")` is false, `allows("coordinator", "operate")` is false, and `allows("helper", "read")` is false.
- [ ] **Step 2:** `bun test src/core/callers.test.ts`. Expected: FAIL, the module is missing.
- [ ] **Step 3:** implement. Keep the file browser-safe (no Bun or node imports), so `ui/` can show the right a 403 named.
- [ ] **Step 4:** the same command. Expected: PASS.
- [ ] **Step 5:** commit `feat(callers): the route table and the rights each caller kind holds`.

### Task 2: The book (`src/server/callers.ts`)

**Files:** create `src/server/callers.ts` and `src/server/callers.test.ts`.

**Interfaces:**
- Consumes: Task 1's types.
- Produces:
  - `type Caller = { id: string; kind: CallerKind; label: string; term?: string; run?: string; created: number; used: number }`
  - `class CallerBook`, constructed as `constructor(opts?: { file?: string; now?: () => number })`
    - `mint(kind, { label, term?, run? }): { token: string; caller: Caller }`
    - `check(token: string | null): Caller | null`. It bumps `used` and turns down page and cli sessions unused for 30 days.
    - `revoke(id: string): boolean`, `dropTerm(term: string): void`, `dropRun(run: string): void`
    - `prune(liveTerms: ReadonlySet<string>): void`. It drops shell callers whose term is gone.
    - `list(): Caller[]`
    - `ticket(callerId: string, right: "shell" | "helper"): string`
    - `redeem(ticket: string, right): Caller | null`
    - Pairing:
      - `pair(label: string, addr: string): { id, code, secret } | { error }`
      - `pending(): { id, label, addr, code, at }[]`
      - `approve(id): boolean`, `deny(id): boolean`
      - `claim(id, secret): string | "waiting" | null`. It mints by the label prefix the caller sent: `"cli "` mints a `cli` token, `"helper "` a `helper` token, anything else a `page` session.
    - First code: `firstCode(): string | null`, null once a page or cli session exists. `useFirst(code, pairId): boolean`, which approves that pair when the code matches.
- Persistence follows `ScreenLayouts.update` (`src/server/layouts.ts:89-104`): chained writes, `mkdir 0o700`, a tmp file written `0o600`, then `rename`. Only callers persist, as `{hash, ...Caller}`. Pairs, tickets and the first code live in memory.
- Codes are 6 characters from `ABCDEFGHJKLMNPQRSTUVWXYZ23456789`. Secrets and tickets are 32 random bytes in base64url.

- [ ] **Step 1: Write the failing tests:**
  - **Mint and check:** `check(token)?.kind` is `"shell"`. `check("cnp_shell_x")` and `check(null)` are null.
  - **Persistence:** the file holds no token string. A second `CallerBook` on the same file checks the first's token. The file mode is `0o600`.
  - **Expiry:** a `page` session unused for 30 days plus 1 ms checks null with a fake `now`. A `shell` token does not expire.
  - **Drops:** `dropTerm("t1")` kills that term's token. `prune(new Set(["t2"]))` kills t1's token and keeps t2's.
  - **Tickets:** `redeem` works once, fails after 60 s, and fails for the other right.
  - **Pairing:**
    - A fourth `pair` while three wait is an error.
    - A pair is gone after 10 min.
    - `claim` with the wrong secret is null, `"waiting"` before `approve`, and a token after it. A second `claim` is null.
    - `deny` makes `claim` null.
  - **First code:** non-null on an empty book. `useFirst` with it approves the pair. It is null after that claim, and null on a book that holds a page session from disk.
- [ ] **Step 2:** `bun test src/server/callers.test.ts`. Expected: FAIL.
- [ ] **Step 3:** implement.
- [ ] **Step 4:** the same command. Expected: PASS.
- [ ] **Step 5:** commit `feat(callers): CallerBook keeps token hashes, tickets and pairing`.

### Task 3: The check in `route()` and `/api/auth/*`

**Files:**
- Modify:
  - `src/server/index.ts`: the server state, `route()` at `:4437` (above the Library hand-off at `:4438`), the term upgrade `:4453-4495`, the helper upgrade `:4444-4452`, and `addCanopyChecks` at `:1924`.
  - `src/core/cors.ts:31`
  - `src/server/callers.ts`: add `callerOf` and `authRoute`.
- Test: `src/server/callers-route.test.ts`, modelled on `src/server/origin.test.ts`: scratch config dir, `CANOPY_TMUX=0`, env saved and restored.

**Interfaces:**
- Produces:
  - `callerOf(book: CallerBook, req: Request, url: URL): Caller | null`. It reads the `x-canopy-token` header, or `ticket=` on the two upgrades through `redeem`.
  - `callersMode(env = process.env): "off" | "log" | "enforce"`. An unknown value means `log`, with one warning line.
  - `class CallerGate`, built as `{ book, mode, log }`
    - `gate(req, url): Response | null`, which answers null to pass
    - `refused: { count: number; recent: { kind, route, origin, ua, at }[] }`, with the newest 20.
  - `authRoute(book, gate, req, url, caller): Promise<Response | null>`. Its routes:
    - `GET /api/auth` answers `{mode, refused, callers: list(), pending: pending(), you: caller?.kind ?? "none"}`.
    - `POST auth/pair {label}`
    - `POST auth/claim {id, secret}`. It answers `{token}` or `{waiting: true}`, or 404.
    - `POST auth/first {id, code}`
    - `POST auth/approve|deny {id}`
    - `POST auth/revoke {id}`
    - `POST auth/ticket {for}`. It needs the caller to hold that right.
  - Event `{type: "auth", pending}` on the SSE stream whenever pairs change.
- Rules:
  - In `log`, a would-refuse request passes. It logs `callers: would refuse <kind> <method> <path> (needs <right>)` once per kind, method and path per process, and counts every time.
  - In `enforce` the refusal names the right: `{error: "this call needs the <right> right; run canopy auth login, or open a new shell", need}`.
  - `off` skips everything except `/api/auth`.
  - Print the first code to stdout at start, and again whenever it changes, as `canopy: first sign-in code <CODE> (good until a page or the CLI signs in)`.
  - Add a `canopy:callers` health check reporting the mode and the refused count. Warn while the mode is `log` and refusals exist.
- CORS: `"Access-Control-Allow-Headers": "content-type, x-canopy-token"`.

- [ ] **Step 1: Write the failing tests**, one server per mode:
  - **enforce:**
    - A bare `POST /api/repos/run` gets 401, and `need` is `"operate"`.
    - The same request with a minted shell token passes the gate. Assert the status is not 401 or 403.
    - With that shell token, `POST /api/agents/role` gets 403 with need `"admin"`, and `POST /library/refresh` gets 403.
    - `GET /api/runs` gets 200 bare.
    - A term upgrade without a ticket is refused. With a ticket from `POST /api/auth/ticket {for:"term"}`, made using a page token, it opens.
    - A refusal body has no `login` key.
  - **log:** the bare POST passes. `GET /api/auth` then shows `refused.count` at least 1, and `recent[0].kind` is `"none"`.
  - **off:** the bare POST passes and the count stays 0.
  - **Pairing over HTTP:**
    - `pair` answers a code.
    - `approve` without a token gets 401, and with a shell token gets 403.
    - `first` with the printed first code makes `claim` answer a token. That token passes `POST /api/agents/role` at the gate.
  - **Preflight:** an OPTIONS request from an allowed origin lists `x-canopy-token`.
- [ ] **Step 2:** `bun test src/server/callers-route.test.ts`. Expected: FAIL.
- [ ] **Step 3:** implement.
  - `ServerState` holds `callers: CallerBook` and `gate: CallerGate`.
  - `route()` begins with `const caller = callerOf(...)`, then `authRoute`, then `gate.gate`. The Library and the origin gate follow.
  - The upgrades pass `caller` through, so the term socket knows who opened it.
- [ ] **Step 4:** the same command, then `bun test src/server/origin.test.ts`. Expected: PASS. The default mode is `log`, so no other server test changes.
- [ ] **Step 5:** commit `feat(callers): check every caller at the top of route, with /api/auth for pairing`.

### Task 4: Tokens for shells and the ranger

**Files:**
- Modify:
  - `src/core/term.ts:146`: add `"CANOPY_TOKEN"` to `INHERITED_ENV`, so `index.ts:3843` deletes it from canopy's own env.
  - `src/server/index.ts`: `canopyEnv` `:1250`, the ranger's `env` at `:4133-4141`, every place a term leaves state, and start-up after terms are restored.
  - `lib/ranger.md`: every `curl` that POSTs sends `-H "X-Canopy-Token: $CANOPY_TOKEN"`.
- Test: `src/server/callers-env.test.ts`.

**Interfaces:**
- `canopyEnv` drops any token the book holds for that term id, mints a new one (`kind: "shell"`, `label: "shell <repo>"`, `term: id`), and sets `CANOPY_TOKEN`. The book keeps only hashes, so it can't hand an old token back; a restore or resume that starts a new process gets a new token.
- A tmux shell that outlived canopy keeps its env and its token, and the reloaded book still checks that token (Review Focus 2).
- The ranger mints `kind: "ranger"`, `term: <ranger term id>` in its `env(term)` callback, and drops the old one first.
- Call `state.callers.dropTerm(id)` wherever a term is deleted from server state. Find them with `grep -n "terms.delete(" src/server/index.ts`.
- After the start-up restore, call `state.callers.prune(new Set(<live term ids>))`.
- Runs: `runEnv` (`src/core/runner.ts:117`) stays unchanged, so ordinary runs carry no token. The coordinator's token is minted by the coordinator plan through `runEnv`.

- [ ] **Step 1: Write the failing tests:**
  - A term started through the API, with `CANOPY_TMUX=0` and a pty, has `CANOPY_TOKEN` starting `cnp_shell_` in its env. Read it back with `env` through `terms/text`, or assert on the `canopyEnv` return value through an exported helper.
  - After `DELETE /api/terms?id=` the book no longer checks that token.
  - `process.env.CANOPY_TOKEN` set before `startServer` is gone after it.
  - A run's spawn env (`spawnEnv` on a `runEnv` ctx) has no `CANOPY_TOKEN`.
  - A second `startServer` on the same config dir, with no live terms, prunes the shell token.
- [ ] **Step 2:** `bun test src/server/callers-env.test.ts`. Expected: FAIL.
- [ ] **Step 3:** implement.
- [ ] **Step 4:** the same command, plus `bun test src/server/ranger.test.ts src/server/term.test.ts`. Expected: PASS.
- [ ] **Step 5:** commit `feat(callers): shells and the ranger carry CANOPY_TOKEN; runs carry none`.

### Task 5: The CLI sends its token

**Files:**
- Create `src/cli/api.ts` and `src/cli/api.test.ts`.
- Modify every site listed under "Interfaces".

**Interfaces:**
- Produces:
  - `apiBase(given?: string): string`, the `--backend` value, else `CANOPY_API`, else `http://127.0.0.1:7850`, with trailing slashes trimmed.
  - `tokenFile(base: string): string`, which is `join(configDir(), "token-" + host + "-" + port)`.
  - `callerToken(base: string, flag?: string): string | null`, taking the flag, else the file, else `CANOPY_TOKEN`.
  - `callerHeaders(base, flag?, extra?: HeadersInit): Headers`
- Sites:
  - `ask()` in `src/cli/health.ts:198`. It always sends `callerHeaders`. A 401 or 403 whose JSON has `need` is final: print its `error` and exit 1. Only a 401 without `need` keeps today's try-the-next-URL behaviour (`:213`).
  - Raw fetches: `health.ts:409`, `index.ts:674`, `:690`, `:742`, `secrets.ts:153`, `:193`.
  - The repeated base expressions at `index.ts:685`, `:737`, `secrets.ts:146`, `newargs.ts:33` become `apiBase`.
  - `lib/devhub/canopy.py` (`/library/api/dev/register`) reads the same token file and sends the header.

- [ ] **Step 1: Write the failing tests:**
  - `callerToken` prefers the flag, then the file, then the env. A file holding only whitespace counts as no token.
  - `tokenFile("http://127.0.0.1:7850/")` ends with `token-127.0.0.1-7850`.
  - `ask()` against a stub server: a 403 `{need:"admin"}` gives exit 1 with that error and asks no second URL. A 401 without `need` still moves to the next URL.
  - `canopy land` against an `enforce` server: bare it exits 1, and with `--token` from a minted cli caller it succeeds.
- [ ] **Step 2:** `bun test src/cli/api.test.ts src/cli/health.test.ts`. Expected: FAIL.
- [ ] **Step 3:** implement, then add `--token` to the global flags in `src/core/help.ts`.
- [ ] **Step 4:** the same command, then the whole `src/cli` suite. Expected: PASS.
- [ ] **Step 5:** commit `feat(cli): one apiBase and callerHeaders for every call to canopy`.

### Task 6: `canopy auth` and the helper's pairing

**Files:**
- Create `src/cli/auth.ts` and `src/cli/auth.test.ts`.
- Modify:
  - `src/cli/index.ts`: `COMMANDS`, the case, and `helper` at `:195`.
  - `src/core/helperd.ts`: `dial()` at `:134`.
  - `src/core/help.ts`.

**Interfaces:**
- `canopy auth login [--backend URL] [--code CODE]`:
  1. `pair` with label `cli <hostname>`.
  2. Print the code and say: approve it in the canopy inbox, or pass the first code from the log with `--code`.
  3. With `--code`, call `auth/first`.
  4. Poll `claim` every 2 s for 10 min.
  5. Write the token file with mode 0600.
- `canopy auth logout` revokes its own caller, then removes the file. `canopy auth status` prints the mode, `you`, and the refused count from `GET /api/auth`.
- `canopy helper --pair` runs the same flow with label `helper <hostname>`, so `claim` mints a `helper` token (Task 2's label rule). The token goes to `token-helper-<host>-<port>`.
- `helperd.dial()` fetches `POST /api/auth/ticket {for: "helper"}` with the helper token before every `new WebSocket`, and adds `&ticket=` to `helperUrl`'s result. Without a token file it dials as today, which passes under `log`.

- [ ] **Step 1: Write the failing tests:**
  - **Login:** against an `enforce` server, `auth login --code <first code>` writes a 0600 file, and `canopy land` then succeeds.
  - **Logout:** after `auth logout`, the same token gets 401.
  - **Helper redial:** the helper dials twice, and the server sees two different tickets. Replaying the first ticket gets 401.
- [ ] **Step 2:** `bun test src/cli/auth.test.ts src/core/helperd.test.ts`. Expected: FAIL.
- [ ] **Step 3:** implement.
- [ ] **Step 4:** the same command. Expected: PASS.
- [ ] **Step 5:** commit `feat(cli): canopy auth login, logout and status; the helper pairs and dials with a ticket`.

### Task 7: The page signs in, sends its token, and approves pairs

**Files:**
- Create `ui/src/callerToken.ts` and `ui/src/callerToken.test.ts`, modelled on `ui/src/answerKey.ts`.
- Modify:
  - `ui/src/api.ts`: `req` at `:161` and `blobReq` at `:246`.
  - `ui/src/components/Library.tsx:30`, `:57`.
  - `ui/src/components/TermDock.tsx:145`, `:319`.
  - `ui/src/store.ts`, `ui/src/inbox.ts`, `ui/src/components/Inbox.tsx`, `ui/src/components/TopBar.tsx`, `ui/src/components/Settings.tsx`, `ui/src/styles.css`.

**Interfaces:**
- `ui/src/callerToken.ts`:
  - `originOf(base: string): string`, where `""` maps to `location.origin`.
  - `readToken(origin, store?)` and `writeToken(origin, token | null, store?)`, with try/catch around storage.
  - `tokenHeaders(origin, init?: HeadersInit): Headers`
- `req` merges `tokenHeaders(originOf(b))` into the init it already builds. It keeps `Content-Type` when the caller passed headers.
- A 401 or 403 whose JSON has `need` sets that backend's `auth` state to `"needed"`. It never goes through the `signin` path.
- The term socket:
  - `connect` becomes async. It fetches `POST /api/auth/ticket {for: "term"}` and appends `ticket=`.
  - Under `log` with no token, the ticket call answers 401. The socket then dials without a ticket, which passes in `log`.
- The store:
  - `authByBackend: Record<string, { mode, you, pending, refused }>`, loaded from `GET /api/auth` in the three load places, and the `auth` event handler.
  - `signIn(backend)`: pair, wait on claim, write the token. `useFirstCode(backend, code)`.
  - `approvePair(backend, id)`, `denyPair`, `revokeCaller`.
- The inbox gets source `"auth"` and kind `"pair"`, with one item per pending pair on a backend where this page holds a page token. Its row shows the label (a browser, `cli <host>` or `helper <host>`), the address and the code, with allow and deny buttons.
- The top bar shows a strip when a backend's mode is not `off`, `you` is `"none"`, and the store holds no token for it:
  - `sign in to <backend>`
  - Pressing it shows the code and "waiting for approval", plus a field for the first code.
  - It uses the existing chip styles in `styles.css`. There is no DESIGN.md, so follow the tokens there.
- Settings gets a "Signed in" section: the mode, the refused count, and each caller with label, kind, last use and a revoke button.

- [ ] **Step 1: Write the failing tests:**
  - `callerToken.test.ts`:
    - Tokens for `http://a:7850` and `http://b:7850` stay apart.
    - `tokenHeaders` on an origin with no token adds no header.
    - A throwing storage leaves reads null and writes silent.
  - `store.test.ts`:
    - `req` against a stubbed fetch sends `x-canopy-token` for backend A and not for backend B.
    - A 403 `{need}` marks `authByBackend[a]` and does not set the conn to `signin`.
    - `/api/auth` joins the expected load list.
  - `inbox.test.ts`: a pending pair becomes an `auth` item keyed `auth:<backend>:<id>`.
- [ ] **Step 2:** `bun test ui/src/callerToken.test.ts ui/src/store.test.ts ui/src/inbox.test.ts`. Expected: FAIL.
- [ ] **Step 3:** implement.
- [ ] **Step 4:** the same command. Expected: PASS.
- [ ] **Step 5:** commit `feat(ui): sign in per backend, send the token, approve pairs from the inbox`.

### Task 8: Docs, gates and the live check in `log`

- [ ] `docs/architecture.md`: a "Callers and tokens" section covering the table, the book, the modes, tickets and pairing. Add one line to "src/server" saying `route()` checks callers first. Add the section to the CLAUDE.md feature list.
- [ ] `docs/deploy.md`:
  - `CANOPY_CALLERS` in the Mac launchd plist and the mini's `.env`.
  - Where the first code prints.
  - The rollout steps from the spec's "Migration and rollout".
- [ ] `SPEC.md`: `callers.json` and the `token-*` files in the config dir list. README: `canopy auth`, `--token`, `helper --pair`. FEATURES.md: a line under FR-010's prerequisites.
- [ ] Gates: `bun run typecheck && bun run lint && bun test && bun run build`. Expected: all pass.
- [ ] The live check, on a scratch server with its own config dir and port (see the memory note "Scratch canopy server for UI checks"):
  1. Run in `enforce`. A bare `curl -X POST .../api/repos/run` gets 401, and `/api/runs` gets 200.
  2. The page signs in with the first code.
  3. A second browser profile pairs, and the first page approves it from the inbox.
  4. `canopy auth login` works.
  5. In a canopy shell, `canopy land` succeeds and `curl -X POST .../api/agents/role` gets 403.
  6. The ranger's wake POST succeeds.
- [ ] Ship to `main` only when Eric asks. After the deploy, the rollout steps are Eric's:
  1. Pair the Mac page, the phone, and the CLI on both machines.
  2. Restart the ranger fresh.
  3. Watch for a week.
  4. Switch to `enforce`.

## Risks

- A route filed under the wrong right. The `admin` default and the table test limit the damage, and the week in `log` shows any route a real caller needs.
- A caller outside this repo that writes, such as a Claude hook or a script in `~/dev`. The `recent` list on `GET /api/auth` names it.
- Shells opened before the release lose their CLI writes under `enforce`. The 401 says to open a new shell.
