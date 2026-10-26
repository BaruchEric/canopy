# A PWA with web push for asks and "needs you" (FR-042)

FR-042 asks for canopy to reach Eric's phone when the page is closed: an
agent waiting on a permission, a branch sent back, a PR whose fix gave up, a
trigger event that needs him, a ranger that died. Paseo
(https://github.com/getpaseo/paseo), Happy and Orca
(https://github.com/stablyai/orca) each ship native iOS and Android apps for
this. canopy's answer is the page it already has, installed to the home
screen as a PWA, with web push from the backend. That closes most of the
gap at a fraction of the cost of two native apps, and it fits how canopy is
reached today: one origin behind the tailnet or Cloudflare Access, every
device the same page. Ranked 11th in
`2026-10-25-software-factory-borrowings-design.md`.

## Where things stand (2026-10-25)

- **The page is already phone-ready, not installable.** `ui/index.html` has
  the viewport with `interactive-widget=resizes-content`, two `theme-color`
  metas (`#fafbf8` light, `#121a14` dark) and a data-URL SVG favicon (three
  canopy circles over a trunk). There is no `manifest`, no service worker
  and no `setAppBadge` anywhere under `ui/` or `src/server/` (grep, this
  date). Vite builds one entry, `ui/src/main.tsx`, into `dist/web`; the
  server's static fallback (`src/server/index.ts` around line 5528) serves a
  file from `dist/web` when it exists and `index.html` otherwise.
- **Notifications stop when the tab goes.** `ui/src/notify.ts` is pure:
  `snapshot` keys every inbox item (`inbox:<key>`), turn row
  (`turn:<kind>:<id>`), failed row (`failed:<kind>:<id>`) and run
  (`done:<id>`); `transitions` gives the new waiting items and the runs that
  went working to done; `watch` is the burst guard with `QUIET` (10 s),
  re-seeding on page load and whenever a backend's connection signature
  changes. A `useStore.subscribe` in `store.ts` fires a `Notification` only
  outside `dockless()` windows, with the `notify` setting on, permission
  granted and the tab hidden; `NotifyRow` in the device tab asks for
  permission and says why it cannot (plain http, no `Notification`, denied).
  A closed tab hears nothing.
- **Telegram is the one out-of-page channel.** The ranger's wakes and its
  gave-up go out as DMs from canopy's bot through `ChanHub.dm` and
  `onRangerGaveUp` (`server/tailchan.ts`). Nothing else leaves the page.
- **The lists that count as "needs you".** `mergeInbox` (`ui/src/inbox.ts`:
  keys `ask:<id>`, `run:<id>`, `flow:<id>`, `sprout:<id>`), the waiting
  panel's `turnRows` and `failedRows` (`ui/src/waiting.ts`), the landing
  section's `sent-back` rows and held notices, the PR watch's red check with
  auto-fix off or given up, the triggers view's "Needs you" section. All of
  these are built client-side from per-backend state; the server has no one
  list of what waits on Eric.
- **A page's identity.** `clientId()` (`ui/src/client.ts`, 16 hex in
  localStorage `canopy.client`), a caller token per backend
  (`ui/src/callerToken.ts`, `canopy.token.<origin>`, sent as
  `X-Canopy-Token`), and an answer key (`ui/src/answerKey.ts`) that answers
  asks. `?view=agents&ask=<id>` (`Route.ask` in `ui/src/routes.ts`) already
  opens the inbox on one ask.
- **Egress.** The `canopy` compose service runs in the `shells` container's
  network namespace (`network_mode: "service:shells"`) on the compose default
  network, with ordinary outbound access. Only the coordinator's `coord`
  container is held to `coord-proxy`. So the backend can reach the push
  services (to confirm on the mini: `curl -sI https://fcm.googleapis.com`
  from a canopy shell).
- **Crypto precedent.** `src/core/secretcrypt.ts` and `kit.ts` use
  `crypto.subtle` already; `@simplewebauthn/server` is in `package.json` for
  the secret store's passkeys. Neither does VAPID.

## Probes before plan 1

- **P1. The home-screen page on iOS.** Install the page from Safari on the
  phone (over the tailnet and over canopy.beric.ca) and confirm it opens
  standalone, that `Notification.permission` is askable there, and that a
  `PushManager.subscribe` succeeds. iOS 16.4+ gives web push only to an
  installed web app; a Safari tab gets `undefined` for `pushManager`.
- **P2. The service worker behind Cloudflare Access.** `GET /sw.js` must
  come back as JavaScript with the Access cookie, not the sign-in page, and
  `navigator.serviceWorker.register` must succeed. If Access ever answers a
  fetch from the worker with a redirect, the worker must let it through
  (the worker never caches `/api`).
- **P3. One push end to end.** From the mini, sign a VAPID JWT with Web
  Crypto (`ECDSA` P-256, `ES256`), encrypt a payload with `aes128gcm`
  (RFC 8291) and POST it to a real subscription endpoint from a Chrome on
  the Mac and the installed page on the phone. If the hand-rolled encryption
  costs more than a day, take `web-push` (npm, MIT, no transitive native
  code) and record that in Calls.
- **P4. Badging.** `navigator.setAppBadge` on the installed page on iOS and
  on Android Chrome; which one clears it on open.

## The installable page

### Manifest

`ui/public/manifest.webmanifest`, copied as-is by Vite, linked from
`index.html` with `<link rel="manifest">`:

```json
{
  "name": "canopy",
  "short_name": "canopy",
  "start_url": "/",
  "scope": "/",
  "display": "standalone",
  "background_color": "#fafbf8",
  "theme_color": "#fafbf8",
  "icons": [
    { "src": "/icons/canopy-192.png", "sizes": "192x192", "type": "image/png" },
    { "src": "/icons/canopy-512.png", "sizes": "512x512", "type": "image/png" },
    { "src": "/icons/canopy-512-maskable.png", "sizes": "512x512", "type": "image/png", "purpose": "maskable" }
  ]
}
```

- The icons are rendered once from the favicon's SVG (the three circles and
  the trunk) by `scripts/icons.ts` into `ui/public/icons/` and checked in,
  so a build needs no image tooling. The maskable one has the bark
  background behind the circles. iOS reads `apple-touch-icon`, which
  `index.html` gains too (180×180).
- `start_url` is `/` and never a backend: the page already finds its home
  backend from the origin it loaded from and the registry, and a `?repo=` or
  `?view=` in the install URL would pin every launch to one view.
- `theme_color` stays the light bark; the dark one keeps coming from the
  `media` metas, which Chrome and Safari honour over the manifest.

### The service worker

`ui/sw.ts`, a second Vite entry built to `dist/web/sw.js` (its own
`build.rollupOptions.input` with `inlineDynamicImports`, no hashing on that
one file, since the registered path must stay `/sw.js`). Hand-written, under
150 lines, no workbox:

- **Install:** pre-cache nothing. **Fetch:** a navigation request is
  answered network-first with a fallback to the cached `index.html` when
  offline; a request for `/assets/*` (Vite's hashed bundles) is
  cache-first, since the hash is the version; everything else (`/api/*`,
  `/library/*`, websockets, `/icons`) passes straight through, never cached,
  never read. **Activate:** delete every cache whose name is not
  `canopy-<build>`.
- The cache name carries the build stamp. `__CANOPY_BUILD__` is already
  defined for the page from `readBuild()`; the worker entry gets the same
  define, and `versionLine` (`core/version.ts`) is the string. A new build
  gives a new name, so the old shell goes on the next activate; the page
  calls `registration.update()` when `/api/about` reports a server build
  other than its own, which the settings' about section already compares.
- **Push:** `self.addEventListener("push", …)` reads the JSON payload
  `{key, title, body, url}` and shows it with `tag: key` and `renotify:
  false`, so a second push for the same item replaces the first (the same
  rule `notify.ts` has for the tab). **Notification click:** focus a window
  on this origin if one is open and post it `{type: "canopy:open", url}`,
  else `clients.openWindow(url)`.
- The worker never sees a token. It holds no state beyond the cache.
- Registration happens in `main.tsx` after the first render, only when
  `window.isSecureContext`, and never under `bun test` or on the Vite dev
  server (port 7851), where the worker would cache the wrong origin's
  bundles.

## Web push

### Keys and subscriptions

- `<configDir>/push/vapid.json` (0600): one P-256 key pair, generated on
  first use with `crypto.subtle.generateKey({name: "ECDSA", namedCurve:
  "P-256"})`, exported as JWK, plus `subject` (`mailto:` from a new config
  field `push.subject`, default `mailto:canopy@localhost`). A backend that
  cannot write the file reports it on the device tab and offers no push.
- `<configDir>/push/subscriptions.json` (0600, written through a temp file
  and a rename like `callers.json`): one entry per client id,
  `{client, endpoint, keys: {p256dh, auth}, device, backend, createdAt,
  usedAt, failures}`. At most `PUSH_SUBS` (20) entries; a 21st drops the
  oldest `usedAt`. An endpoint the push service answers 404 or 410 for is
  removed at once; three other failures in a row (`PUSH_FAILS`) mark it
  `stale`, shown on the device tab, and a successful send clears the count.
- Each backend keeps its own file. A phone subscribed through the Mac's
  canopy is not subscribed on the mini's; the page subscribes to its home
  backend only (where `loadAsks`, presence and the answer key already go),
  and the home backend pushes for everything the page would show, since it
  already merges the other backends' state in the browser. See "What the
  server knows" below for how the server gets that list.

### Routes

- `GET /api/push/key` (right `read`): `{key: <base64url public key>,
  subject}`. Open, like any read: the public key is public.
- `POST /api/push/subscribe {subscription, client, device}` (right
  `operate`, the page's own caller token): stores or replaces the entry;
  409 when the client id already holds a different endpoint and the body
  does not say `replace: true`.
- `DELETE /api/push/subscribe?client=` (right `operate`): removes it.
  Called when the setting goes off and when the page's `pushManager`
  reports the subscription gone.
- `POST /api/push/test` (right `admin`): one push to every entry, the
  CLI's `canopy push test` and the device tab's "send a test".
- `GET /api/push` (right `admin`): the entries less their keys, with
  `device`, `createdAt`, `usedAt`, `failures`, `stale`, and `vapid: true |
  false`.
- Every write is on the `operate` row of the callers table
  (`core/callers.ts`): `{ methods: POST, paths: ["push/subscribe"], right:
  "operate" }` and the admin rows for `push/test`; `push/key` stays a plain
  GET. A `DELETE` not in the table needs `admin`, so the `DELETE` row is
  filed explicitly.

### What the server knows

The lists that count as "needs you" are built in the browser today. The
server gets a pure twin so it can push without a page:

- `core/push.ts` (browser-safe, pure, tested): `PushNote {key, title, body,
  url}` and `pushSnapshot(input)` over the server's own state (`asks` from
  `AskHub`, every run on a prompt or failed from the `Runner`, gated flows,
  `sent-back` landing entries and held notices from `LandingHub`, the PR
  watch's red-and-gave-up and `approve` holds from `PrHub`, trigger events in
  a state that needs Eric, the ranger's `gave-up`). The keys reuse the
  page's namespaces where one exists (`inbox:ask:<id>`, `inbox:run:<id>`,
  `landing:<branch id>`, `pr:<branch id>`, `trigger:<id>`, `ranger:<backend>`)
  so a click lands on the same thing the page would show.
- `pushTransitions(prev, next)` is `notify.ts`'s `transitions` with no run-
  done notes: a push wakes a phone, so only what waits on Eric or failed
  goes out; "Done" stays a tab notification. `pushable(prev, next, now,
  quietUntil)` is the burst guard: the first snapshot after start, and any
  after a backend reconnects or the flows lock changes hands (`adopt`),
  opens a `QUIET` window (10 s, the same constant) in which nothing fires.
- `server/push.ts`'s `PushHub` holds the keys and the file, follows the
  other hubs' broadcasts (`onChange` from the runner and the asks, landing,
  prs, triggers and ranger hubs, the same fan-out the SSE stream uses),
  recomputes the snapshot at most every `PUSH_DEBOUNCE` (2 s), and sends
  each new note to every subscription on its own serial queue. A note whose
  item is gone before the send goes (the ask was answered at the terminal)
  is dropped, not sent.
- **Presence.** A push while Eric is at the page is noise. `AskHub` already
  knows presence (the page's beat, `pagePresence`, every minute). A note is
  held `PUSH_PRESENT_HOLD` (90 s) while any page on this backend beat within
  the last 2 minutes, and dropped if the item is gone by then; an ask's own
  countdown may run shorter, so an ask with less than 2 minutes left goes at
  once.
- **Words.** The title is the list's own: "Waiting on you · <repo>", "Sent
  back · <repo>", "PR #n · <repo>", "Needs you · <rule>", "ranger gave up".
  The body is one line through `notify.ts`'s `line` (160 characters), with
  the agent's own `description` for a permission (the words `PermissionAsk`
  carries) and the gate's name for a red one. Never a command's raw text,
  never a file path outside the repo, never a token. The payload is at most
  `PUSH_BYTES` (3 KB; the push services allow 4).
- **The click.** `url` is a page route that exists: `?view=agents&ask=<id>`
  for an ask, `?repo=<id>` for a run, a sent-back branch or a PR (the panel
  opens its landing section), `?view=triggers` for an event, and `/` for the
  ranger (its chip is in the top bar). The page then reads the detail with
  its own token; nothing in the push grants anything.

### Sending

- A send is RFC 8030 + 8291 + 8292: `Authorization: vapid t=<JWT>,
  k=<public key>`, the JWT signed with the private key through
  `crypto.subtle.sign({name: "ECDSA", hash: "SHA-256"})` and the DER
  signature turned into the raw 64 bytes JWS wants; the payload encrypted
  `aes128gcm` with ECDH over the subscription's `p256dh` and `auth`
  (`crypto.subtle.deriveBits`, HKDF, AES-GCM, all in Web Crypto); `TTL:
  3600`, `Urgency: high` for an ask with a countdown, `normal` otherwise. All
  of it in `core/webpush.ts` (Bun-only for the key file, pure for the
  encoding, tested against the RFC 8291 test vector). If P3 shows this
  taking longer than a day, `web-push` replaces `core/webpush.ts` and the
  file format stays.
- A 201 is sent; a 404 or 410 removes the subscription; a 429 waits the
  `Retry-After`; a 413 drops the body and sends the title alone; anything
  else counts a failure.
- A health check `canopy:push` reads bad when the key file cannot be read
  or every subscription is stale, with the last error as its detail.

## The setting and its words

- The device tab's `NotifyRow` grows a second switch under the first:
  "push when the page is closed", off by default, kept per browser in the
  settings like `notify` (`settings.push`). Turning it on registers the
  worker if it is not yet, asks for permission (the same click rule),
  subscribes with the backend's key and posts the subscription; turning it
  off unsubscribes and deletes. The row says what stands in the way, in the
  manner of `whyNot`: "This page is on plain http; push needs https or
  localhost", "Push needs the page installed to the home screen on an
  iPhone: share → Add to Home Screen, then turn this on from there",
  "This browser has no push", "The backend has no push key (its config dir
  is read-only)", and "stale: the last 3 pushes failed" with "resubscribe".
- `notify` and `push` are independent. Both on means the tab notification
  while the page is hidden-but-open and the push when no page beats; the
  presence hold above keeps them from stacking.
- The badge: with `push` on, the worker sets `navigator.setAppBadge(n)`
  from the payload's `count` (the snapshot's size, sent with every push) and
  clears it on `notificationclick`; the page clears it on focus through
  `navigator.clearAppBadge` when `waitingCount` is 0. Where the API is
  missing nothing happens, and the tab title's `(n)` stays as before.
- The CLI: `canopy push test [--backend URL]` and `canopy push ls`.
- Telegram stays. The ranger's DMs are a conversation with an agent, two
  ways, and push is one way; a wake, a `say` and the ranger's own replies
  keep going through tailchan. Push adds the things that have no bot behind
  them.

## Security

- The push payload never carries a token, an answer key, a command line or
  a file's content. Everything a click shows is read by the page under its
  own caller token and, for an ask's answer, its answer key.
- The subscription endpoint is a capability to send to that browser, not to
  read anything; still, `subscriptions.json` is 0600 and its endpoints never
  go to another page (`GET /api/push` is `admin` and strips `keys`).
- The private VAPID key never leaves `vapid.json`; `GET /api/push/key` gives
  the public half only.
- The worker is same-origin and is served from `dist/web` like the page, so
  the edge gate (Cloudflare Access) stands in front of it as it does for the
  page; a worker cannot be registered cross-origin.
- `POST /api/push/subscribe` takes the page's own token (`operate`), so a
  shell's or run's token cannot subscribe a stranger's endpoint: shells and
  the ranger hold `operate` too, so the handler also requires the token's
  kind to be `page` (`callerOf(req).kind`), a first for a route, noted in
  `callers.test.ts`.

## Components

- `ui/public/manifest.webmanifest`, `ui/public/icons/*` (new), rendered by
  `scripts/icons.ts` (new).
- `ui/index.html`: manifest link, `apple-touch-icon`.
- `ui/sw.ts` (new) and `ui/vite.config.ts`: the second entry, unhashed.
- `ui/src/main.tsx`: registration; `ui/src/push.ts` (new, pure, tested):
  `pushWhyNot`, `pushPayload` parsing, badge helpers; `ui/src/store.ts`:
  `settings.push`, subscribe/unsubscribe, the `canopy:open` message handler;
  `components/NotifyRow.tsx`: the second switch and its words.
- `src/core/push.ts` (new, pure): snapshot, transitions, burst guard, words.
- `src/core/webpush.ts` (new): VAPID and `aes128gcm`.
- `src/server/push.ts` (new): `PushHub`, the routes, the file, the health
  check; `src/server/index.ts`: wiring and the `page`-kind check.
- `src/core/callers.ts`: the table rows.
- `src/cli/push.ts` (new): `canopy push test | ls`.
- `docs/architecture.md`: a "Push" section; `SPEC.md` Data and state:
  `push/` under the config dir.

## Calls

Made on 2026-10-25:

1. **A PWA, not native apps.** One page, one origin, no store accounts, and
   it already works on the phone. The gap left (no background sync, iOS
   needing the installed page) is accepted.
2. **The server builds its own "needs you" list** (`core/push.ts`) rather
   than the page relaying what it sees. A closed page cannot relay, which is
   the whole point.
3. **Home backend only.** A phone subscribes where its page loads; that
   backend's state already covers what the page would show. Two
   subscriptions to two backends would mean two pushes for one ask.
4. **"Done" is not pushed.** A push is for what waits on Eric or failed.
5. **Hand-rolled web push first, `web-push` as the fallback** after P3. The
   dependency list is short on purpose and `crypto.subtle` is already in
   use.
6. **Push holds while a page is present** (90 s), so the tab's notification
   and the phone's do not both fire for one thing.

For Eric:

7. The `mailto:` subject in `vapid.json` is sent to the push services on
   every push; pick the address (any works, it is a contact for abuse).
8. Whether `canopy.beric.ca`'s Access policy lets `/sw.js` and
   `/manifest.webmanifest` through as it does the page (P2), and whether the
   phone's Access session lasts long enough for a notification click to
   land on the page without a sign-in.
9. The 20-subscription cap and the 2 s debounce are guesses; say if a
   different number fits the devices you carry.

## Out of scope

- Native iOS and Android apps, and Paseo's clients (see
  `2026-10-25-paseo-interop-design.md`).
- Answering an ask from the notification itself (notification actions).
  The answer needs the page's answer key, and a background answer with no
  page is a second credential path; a later spec may add it once the key's
  home is settled.
- Offline work. The worker caches the shell so the page opens; every list
  needs the backend.
- Pushes for a run's "done", a landed branch, or a quiet notice.

## Testing

- `core/push.test.ts`: snapshot keys per source, transitions (new ask, a
  sent-back branch, a gave-up PR, a trigger needing Eric, a ranger gave-up;
  no "done"), the quiet window on start and on adopt, the present hold and
  its early release for a short countdown, the 160-character line, the
  3 KB cap.
- `core/webpush.test.ts`: the JWT header and claims, DER-to-raw signature,
  the RFC 8291 test vector encrypts to the published ciphertext, the
  `Authorization` and `Crypto-Key`-free headers for `aes128gcm`.
- `server/push.test.ts` (a stand-in push service): subscribe, replace with
  409 without `replace`, delete, 404/410 pruning, three failures to `stale`,
  the 20 cap, `test` reaching every entry, the file written 0600 through a
  rename, a `shell`-kind token refused on subscribe, `GET /api/push` with
  no keys.
- `callers.test.ts`: the new rows pinned.
- `ui/src/push.test.ts`: `pushWhyNot` for each case, payload parsing, badge
  count.
- By hand (P1–P4): install on the phone, one push over the tunnel and over
  the tailnet, a click landing on the right ask, the badge.

## Plans

1. **Installable page:** manifest, icons, the worker with its cache and
   version rule, registration, the device tab's words. Ships on its own and
   is useful without push.
2. **Push:** keys, subscriptions, `core/push.ts`, `PushHub`, the routes,
   the setting, the CLI, the health check. Needs P1–P3 answered first.
3. **Badge and polish:** `setAppBadge`, the present hold tuning after a
   week of use, `Retry-After` handling if the services ever answer 429.
