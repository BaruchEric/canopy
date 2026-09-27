# Multi-backend, plan 1: every backend reachable Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Closing a panel stops killing its shells, and every canopy backend (the mini and the Mac) can be driven from another canopy origin, on the tailnet over https ts.net names and off it through the beric-gate edge.

**Architecture:** The server grows a `backends` config and `GET /api/backends`, an origin allowlist (`CANOPY_ORIGINS`) in the existing origin gate, and CORS for listed origins. The edge Worker in beric-gate lets canopy CORS preflights through and puts CORS on its own denials for canopy hosts. Ops work gives the Mac its own Cloudflare tunnel (`canopy-mac.beric.ca`) and both machines a `tailscale serve` https name. Plan 2 (the client) is written after this lands.

**Tech Stack:** Bun + TypeScript (strict), React 19 + Zustand (one store change), Cloudflare Workers, Cloudflare Tunnel (cloudflared), Tailscale serve, launchd, docker compose on the mini.

**Spec:** `docs/superpowers/specs/2026-09-26-multi-backend-design.md`, sections 0, 1 (server half), 3, and amendments 1 to 4.

## Global Constraints

- Gates before calling anything done, in canopy: `bun run typecheck && bun run lint && bun test && bun run build`.
- beric-gate gates: `bun run typecheck && bun test` in `~/dev/homelab/services/beric-gate`.
- `bun`/`bunx` only; never npm/npx.
- `src/core/types.ts` stays browser-safe (no Bun or node imports); so does any new `src/core/*.ts` the UI imports.
- No `Access-Control-Allow-Origin: *` anywhere, ever.
- Canopy on the Mac keeps binding `127.0.0.1` only; nothing in this plan sets `CANOPY_BIND` on the Mac.
- Never run two cloudflared connectors on one tunnel. The Mac gets a new tunnel; the parked `ca.beric.canopy-tunnel` stays parked.
- Host names: `canopy-mac.beric.ca` (not `mac.canopy.beric.ca`); tailnet URLs `https://erics-macbook-pro.tail2d2c60.ts.net:7850` and `https://macmini-2018.tail2d2c60.ts.net:7849`.
- Commit messages: no backticks; end with `Claude-Session: https://claude.ai/code/session_01HJpZzCB58kTqvUGjFAsR31`.
- Commit on `main` is fine; do not push (pushing deploys). The mini gets code through peer sync and `bun run redeploy`, which the ops task runs.
- Prose (comments, docs, commit messages) follows the unslop rules: no em dashes, plain words, sentence case.

## Review Focus

1. **A same-origin page behind `tailscale serve` must still work.** The browser sends no Origin on a same-origin GET, Bun sees `http://` and the ts.net Host. Expect 200, not 403. Pinned in Task 3 (`libraryOriginAllowed` host rule) and Task 4 (server test with the Host header).
2. **A listed origin opening a shell websocket must work, an unlisted one must not.** Browsers never preflight websockets. Pinned in Task 4.
3. **SSE from a listed origin must carry CORS headers.** `EventSource` with `withCredentials` fails silently without them. Pinned in Task 4.
4. **A cookieless request to a canopy host must still get the login, only the preflight passes.** A bare `OPTIONS` without `Access-Control-Request-Method` is not a preflight. Pinned in Task 5.
5. **Closing a panel on one browser must not end a shell another device is watching.** Pinned in Task 1 (no `DELETE /api/terms` on close).

---

### Task 1: Closing a panel detaches its shells

**Files:**
- Modify: `ui/src/store.ts:1024-1036` (`closePanel`), `ui/src/store.ts:1541-1552` (`endShells` doc comment)
- Test: `ui/src/store.test.ts` (inside `describe("shells this window ends or restores", ...)`)

**Interfaces:**
- Consumes: `adoptTerms` (`ui/src/term.ts:96`), `openPanel`, `applyEvent({type:"terms"})` as they are.
- Produces: `closePanel(id)` no longer calls the server.

- [ ] **Step 1: Write the failing test**

Add inside the existing `describe("shells this window ends or restores", ...)` block in `ui/src/store.test.ts`, after the `restoring over a tab...` test. It reuses `app`, `info`, `answer`, `calls` from that block.

```ts
  test("closing a panel leaves its shells running and its reopening brings them back", () => {
    globalThis.fetch = answer({ ok: true });
    const shell = "f".repeat(32);
    const panelTab = { id: shell, repoId: "app", name: "app", path: "/dev/app", place: "panel" as const };
    const held: TermInfo = { ...info(shell), place: "panel" };
    useStore.setState({ repos: [app], panels: ["app"], activePanel: "app", terms: [panelTab], shells: [held], hiddenTerms: [] });
    useStore.getState().closePanel("app");
    expect(calls).toEqual([]);
    expect(useStore.getState().terms).toEqual([]);
    // the server still lists it; with its panel closed it waits
    useStore.getState().applyEvent({ type: "terms", terms: [held] });
    expect(useStore.getState().terms).toEqual([]);
    useStore.getState().openPanel("app");
    expect(useStore.getState().terms.map((t) => t.id)).toEqual([shell]);
  });
```

- [ ] **Step 2: Run it to see it fail**

Run: `bun test ui/src/store.test.ts -t "closing a panel"`
Expected: FAIL, `calls` is `["DELETE /api/terms?term=fff…"]`, not `[]`.

- [ ] **Step 3: Make `closePanel` detach**

In `ui/src/store.ts`, replace the `closePanel` body:

```ts
  closePanel: (id) => {
    const s = get();
    // A panel's shells outlive it: closing only drops the tabs, and the
    // shells stay held on the backend, in the shells picker, until their
    // own × or "end". Reopening the panel adopts them back as tabs.
    const mine = (t: TermTab) => t.repoId === id && t.place === "panel";
    const terms = s.terms.filter((t) => !mine(t));
    set({
      panels: s.panels.filter((p) => p !== id),
      activePanel: nextActive(s.panels, id, s.activePanel),
      terms,
      frontShells: keepFront(s.frontShells, terms),
    });
  },
```

And update the `endShells` doc comment so it no longer names panels:

```ts
/** Ends the shells behind some tabs on the server. Closing a socket only
 *  detaches, so this is the one way a tab's × hangs a shell up. One that
 *  already exited needs nothing. */
```

- [ ] **Step 4: Run the test and the file**

Run: `bun test ui/src/store.test.ts`
Expected: PASS, every test in the file.

- [ ] **Step 5: Update CLAUDE.md**

In `CLAUDE.md`, the sentence under "ui/" that reads `since a socket closing only detaches, \`closeTerm\` and \`closePanel\` end the shells behind the tabs they drop through \`DELETE /api/terms\` (\`endShells\`), a panel shell living with its panel.` becomes:

```
since a socket closing only detaches, `closeTerm` ends the shell behind the tab it drops through `DELETE /api/terms` (`endShells`); `closePanel` only drops its panel shells' tabs, leaving the shells held, and `openPanel` adopts them back.
```

- [ ] **Step 6: Gates and commit**

Run: `bun run typecheck && bun run lint && bun test && bun run build`
Expected: all pass.

```bash
git add ui/src/store.ts ui/src/store.test.ts CLAUDE.md
git commit -m "feat(ui): closing a panel leaves its shells running

Claude-Session: https://claude.ai/code/session_01HJpZzCB58kTqvUGjFAsR31"
```

---

### Task 2: The backends config and GET /api/backends

**Files:**
- Create: `src/core/backends.ts`, `src/core/backends.test.ts`, `src/server/backends.test.ts`
- Modify: `src/core/types.ts` (add `BackendEntry`, `CanopyConfig.backends`), `src/core/store.ts:22-39` (defaults), `src/core/store.ts:90-117` (normalize), `src/server/index.ts` (route next to `/api/peers`, near line 1874)

**Interfaces:**
- Consumes: `isPeerName` from `src/core/peers.ts` (browser-safe).
- Produces:
  - `interface BackendEntry { name: string; public?: string; tailnet?: string }` in `src/core/types.ts`
  - `normalizeBackends(v: unknown): BackendEntry[]` and `selfName(self: string | null, host: string): string` in `src/core/backends.ts`
  - `GET /api/backends` answering `{ self: string; backends: BackendEntry[] }`

- [ ] **Step 1: Write the failing unit tests**

`src/core/backends.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { normalizeBackends, selfName } from "./backends";

describe("normalizeBackends", () => {
  test("keeps well-formed entries in order", () => {
    const v = [
      { name: "mini", public: "https://canopy.beric.ca", tailnet: "https://macmini-2018.tail2d2c60.ts.net:7849" },
      { name: "mac", public: "https://canopy-mac.beric.ca" },
    ];
    expect(normalizeBackends(v)).toEqual(v);
  });
  test("a public url must be an https origin, a tailnet one http or https", () => {
    expect(normalizeBackends([{ name: "a", public: "http://x.example" }])).toEqual([]);
    expect(normalizeBackends([{ name: "a", public: "https://x.example/path" }])).toEqual([]);
    expect(normalizeBackends([{ name: "a", tailnet: "http://macmini-2018:7850" }])).toEqual([
      { name: "a", tailnet: "http://macmini-2018:7850" },
    ]);
    expect(normalizeBackends([{ name: "a", tailnet: "ftp://x" }])).toEqual([]);
  });
  test("drops an entry with no url, a bad name, or a name already taken", () => {
    expect(
      normalizeBackends([
        { name: "a" },
        { name: "Bad Name", public: "https://x.example" },
        { name: "a|b", public: "https://x.example" },
        { name: "b", public: "https://x.example" },
        { name: "b", public: "https://y.example" },
      ]),
    ).toEqual([{ name: "b", public: "https://x.example" }]);
  });
  test("anything but an array is no backends", () => {
    expect(normalizeBackends(null)).toEqual([]);
    expect(normalizeBackends({ name: "a" })).toEqual([]);
  });
});

describe("selfName", () => {
  test("the peer name when set", () => {
    expect(selfName("mini", "whatever.local")).toBe("mini");
  });
  test("else the hostname's first label as a slug", () => {
    expect(selfName(null, "Erics-MacBook-Pro.local")).toBe("erics-macbook-pro");
    expect(selfName(null, "macmini-2018")).toBe("macmini-2018");
  });
  test("a label that does not start with a letter gets one", () => {
    expect(selfName(null, "2018box")).toBe("b-2018box");
    expect(selfName(null, "")).toBe("canopy");
  });
});
```

- [ ] **Step 2: Run to see them fail**

Run: `bun test src/core/backends.test.ts`
Expected: FAIL, `Cannot find module './backends'`.

- [ ] **Step 3: Add the type**

In `src/core/types.ts`, right before `export interface CanopyConfig`:

```ts
/** Another canopy server this page may connect to: its name (a peer name,
 *  so `|` can never appear in it) and where it answers. `public` is an
 *  https origin behind the edge gate; `tailnet` an origin on the tailnet. */
export interface BackendEntry {
  name: string;
  public?: string;
  tailnet?: string;
}
```

And inside `CanopyConfig`, after `seed: string[];`:

```ts
  /** the canopy backends a page served from here may connect to, in the
   *  order a client falls back through (see the multi-backend spec) */
  backends: BackendEntry[];
```

- [ ] **Step 4: Write `src/core/backends.ts`**

```ts
import { isPeerName } from "./peers";
import type { BackendEntry } from "./types";

/** whether `v` is exactly an origin (no path, query or trailing slash) with
 *  one of the protocols given */
function isOrigin(v: unknown, protocols: readonly string[]): v is string {
  if (typeof v !== "string") return false;
  try {
    const u = new URL(v);
    return protocols.includes(u.protocol) && u.origin === v;
  } catch {
    return false;
  }
}

/** The config's `backends`, validated field by field like `normalizePeers`:
 *  a peer name, at least one url, `public` https, `tailnet` http or https,
 *  names unique (the first wins). */
export function normalizeBackends(v: unknown): BackendEntry[] {
  if (!Array.isArray(v)) return [];
  const out: BackendEntry[] = [];
  for (const raw of v) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    const name = r["name"];
    if (typeof name !== "string" || !isPeerName(name)) continue;
    if (out.some((b) => b.name === name)) continue;
    const entry: BackendEntry = { name };
    if (r["public"] !== undefined) {
      if (!isOrigin(r["public"], ["https:"])) continue;
      entry.public = r["public"];
    }
    if (r["tailnet"] !== undefined) {
      if (!isOrigin(r["tailnet"], ["http:", "https:"])) continue;
      entry.tailnet = r["tailnet"];
    }
    if (!entry.public && !entry.tailnet) continue;
    out.push(entry);
  }
  return out;
}

/** This backend's name: its peer name when set, else its hostname's first
 *  label as a peer-name slug. */
export function selfName(self: string | null, host: string): string {
  if (self) return self;
  const label = (host.split(".")[0] ?? "").toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 30);
  if (!label) return "canopy";
  return /^[a-z]/.test(label) ? label : `b-${label}`;
}
```

- [ ] **Step 5: Run the unit tests**

Run: `bun test src/core/backends.test.ts`
Expected: PASS.

- [ ] **Step 6: Wire the config**

In `src/core/store.ts`: import `normalizeBackends` from `./backends`; in `defaults()` add `backends: [],` after `seed`; in `normalize()` add after the `seed:` line:

```ts
    backends: normalizeBackends(cfg.backends),
```

- [ ] **Step 7: Write the failing route test**

`src/server/backends.test.ts`:

```ts
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "./index";

let scratch: string;
let server: { port: number; stop: () => void };
const saved: Record<string, string | undefined> = {};
const backends = [{ name: "mini", public: "https://canopy.beric.ca" }];

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "canopy-backends-"));
  for (const k of ["CANOPY_CONFIG_DIR", "CANOPY_TMUX"]) saved[k] = process.env[k];
  process.env["CANOPY_CONFIG_DIR"] = join(scratch, "config");
  process.env["CANOPY_TMUX"] = "0";
  await mkdir(join(scratch, "config"), { recursive: true });
  await writeFile(join(scratch, "config", "config.json"), JSON.stringify({ self: "mac", backends: [...backends, { name: "bad" }] }));
  await mkdir(join(scratch, "root"), { recursive: true });
  server = await startServer({ root: join(scratch, "root"), port: 0, chan: null });
});

afterAll(async () => {
  server.stop();
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  await rm(scratch, { recursive: true, force: true });
});

test("GET /api/backends names this backend and the valid entries", async () => {
  const res = await fetch(`http://127.0.0.1:${server.port}/api/backends`);
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ self: "mac", backends });
});
```

- [ ] **Step 8: Run to see it fail**

Run: `bun test src/server/backends.test.ts`
Expected: FAIL, status 404 (no such route).

- [ ] **Step 9: Add the route**

In `src/server/index.ts`, import `selfName` from `../core/backends`, and add right before `if (path === "/api/peers" && method === "GET") {`:

```ts
  if (path === "/api/backends" && method === "GET") {
    const cfg = await loadConfig();
    return json({ self: selfName(cfg.self, hostname()), backends: cfg.backends });
  }
```

(`hostname` is already imported from `node:os` at the top of the file.)

- [ ] **Step 10: Run the tests**

Run: `bun test src/server/backends.test.ts src/core/backends.test.ts src/core/store.test.ts`
Expected: PASS.

- [ ] **Step 11: Gates and commit**

Run: `bun run typecheck && bun run lint && bun test && bun run build`
Expected: all pass.

```bash
git add src/core/backends.ts src/core/backends.test.ts src/server/backends.test.ts src/core/types.ts src/core/store.ts src/server/index.ts
git commit -m "feat(server): a backends config and GET /api/backends

Claude-Session: https://claude.ai/code/session_01HJpZzCB58kTqvUGjFAsR31"
```

---

### Task 3: CANOPY_ORIGINS in the origin gate

**Files:**
- Create: `src/core/cors.ts`, `src/core/cors.test.ts`
- Modify: `src/core/library.ts:41-62` (`libraryOriginAllowed`)
- Test: `src/core/library.test.ts` (new `test` in `describe("workspace library integration", ...)`)

**Interfaces:**
- Produces:
  - `parseOrigins(raw: string | undefined): string[]` in `src/core/cors.ts`
  - `corsHeaders(origin: string | null, origins: readonly string[]): Record<string, string> | null`
  - `PREFLIGHT_HEADERS: Record<string, string>`
  - `libraryOriginAllowed(req, publicOrigin?, open = false, origins: readonly string[] = [])`: the fourth parameter is new.

- [ ] **Step 1: Write the failing tests for cors.ts**

`src/core/cors.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { PREFLIGHT_HEADERS, corsHeaders, parseOrigins } from "./cors";

describe("parseOrigins", () => {
  test("keeps exact http and https origins, trimmed, in order", () => {
    expect(parseOrigins(" https://canopy.beric.ca , http://macmini-2018:7850 ")).toEqual([
      "https://canopy.beric.ca",
      "http://macmini-2018:7850",
    ]);
  });
  test("drops a path, a wildcard, another scheme, and empties", () => {
    expect(parseOrigins("https://a.example/x,*,ftp://b.example,,https://c.example")).toEqual(["https://c.example"]);
  });
  test("nothing set is no origins", () => {
    expect(parseOrigins(undefined)).toEqual([]);
    expect(parseOrigins("")).toEqual([]);
  });
});

describe("corsHeaders", () => {
  const origins = ["https://canopy.beric.ca"];
  test("a listed origin gets itself back, with credentials", () => {
    expect(corsHeaders("https://canopy.beric.ca", origins)).toEqual({
      "Access-Control-Allow-Origin": "https://canopy.beric.ca",
      "Access-Control-Allow-Credentials": "true",
      Vary: "Origin",
    });
  });
  test("an unlisted or missing origin gets nothing", () => {
    expect(corsHeaders("https://evil.example", origins)).toBeNull();
    expect(corsHeaders(null, origins)).toBeNull();
  });
  test("the preflight answer never names a wildcard", () => {
    expect(Object.values(PREFLIGHT_HEADERS).some((v) => v.includes("*"))).toBe(false);
  });
});
```

- [ ] **Step 2: Run to see them fail**

Run: `bun test src/core/cors.test.ts`
Expected: FAIL, `Cannot find module './cors'`.

- [ ] **Step 3: Write `src/core/cors.ts`**

```ts
/** The origins another canopy page may drive this backend from, read off
 *  `CANOPY_ORIGINS` (comma separated). Only exact http(s) origins survive,
 *  so a typo cannot widen it and a `*` is never one. */
export function parseOrigins(raw: string | undefined): string[] {
  if (!raw) return [];
  const out: string[] = [];
  for (const part of raw.split(",")) {
    const v = part.trim();
    if (!v) continue;
    try {
      const u = new URL(v);
      if ((u.protocol === "http:" || u.protocol === "https:") && u.origin === v) out.push(v);
    } catch {
      // not an origin
    }
  }
  return out;
}

/** The CORS headers for a listed origin: that origin back, never `*`, with
 *  credentials so the gate's cookie rides along. Null for anything else. */
export function corsHeaders(origin: string | null, origins: readonly string[]): Record<string, string> | null {
  if (!origin || !origins.includes(origin)) return null;
  return { "Access-Control-Allow-Origin": origin, "Access-Control-Allow-Credentials": "true", Vary: "Origin" };
}

/** What a preflight from a listed origin is told on top of `corsHeaders`:
 *  the methods and the one header the client sends. */
export const PREFLIGHT_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Methods": "GET, POST, DELETE",
  "Access-Control-Allow-Headers": "content-type",
  "Access-Control-Max-Age": "600",
};
```

- [ ] **Step 4: Run the cors tests**

Run: `bun test src/core/cors.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing gate tests**

Add to `src/core/library.test.ts`, inside `describe("workspace library integration", ...)`, after the tailnet-name test:

```ts
  test("a listed origin may call from another site, and its own page may by host", () => {
    const listed = ["https://canopy.beric.ca", "https://erics-macbook-pro.tail2d2c60.ts.net:7850"];
    const req = (host: string, headers: Record<string, string> = {}) =>
      new Request(`http://${host}/api/tree`, { headers });
    // another canopy page, cross-site to the browser
    expect(libraryOriginAllowed(req("127.0.0.1:7850", { origin: "https://canopy.beric.ca", "sec-fetch-site": "cross-site" }), undefined, false, listed)).toBe(true);
    // the page tailscale serve hands out: https to the browser, http here, no Origin on a GET
    expect(libraryOriginAllowed(req("erics-macbook-pro.tail2d2c60.ts.net:7850", { "sec-fetch-site": "same-origin" }), undefined, false, listed)).toBe(true);
    // the same page's POST carries its https Origin
    expect(libraryOriginAllowed(req("erics-macbook-pro.tail2d2c60.ts.net:7850", { origin: "https://erics-macbook-pro.tail2d2c60.ts.net:7850" }), undefined, false, listed)).toBe(true);
    // unlisted stays out, and so does a cross-site request with no Origin to a listed host
    expect(libraryOriginAllowed(req("127.0.0.1:7850", { origin: "https://evil.example" }), undefined, false, listed)).toBe(false);
    expect(libraryOriginAllowed(req("erics-macbook-pro.tail2d2c60.ts.net:7850", { "sec-fetch-site": "cross-site" }), undefined, false, listed)).toBe(false);
    // no list, no change from before
    expect(libraryOriginAllowed(req("127.0.0.1:7850", { origin: "https://canopy.beric.ca" }))).toBe(false);
  });
```

- [ ] **Step 6: Run to see it fail**

Run: `bun test src/core/library.test.ts -t "a listed origin"`
Expected: FAIL on the first expectation (false, not true).

- [ ] **Step 7: Extend `libraryOriginAllowed`**

In `src/core/library.ts`, extend the doc comment with one more paragraph and change the function:

```ts
/** ...existing paragraph...
 *  `origins` are the other canopy pages allowed to drive this backend
 *  (`CANOPY_ORIGINS`). A listed Origin passes even cross-site, which two
 *  tailnet names are to a browser; a request with no Origin passes when its
 *  Host is a listed origin's host and it is not marked cross-site, which is
 *  a listed page's own same-origin GET behind `tailscale serve`. */
export function libraryOriginAllowed(
  req: Request,
  publicOrigin?: string,
  open = false,
  origins: readonly string[] = [],
): boolean {
  const url = new URL(req.url);
  const origin = req.headers.get("origin");
  const site = req.headers.get("sec-fetch-site");
  if (origin && origins.includes(origin)) return true;
  if (!origin && site !== "cross-site" && origins.some((o) => new URL(o).host === url.host)) return true;
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (site === "cross-site") return false;
  if (local && (!origin || origin === url.origin)) return true;
  if (open && tailnetHost(url.hostname) && (!origin || origin === url.origin)) return true;
  if (!publicOrigin) return false;
  try {
    const configured = new URL(publicOrigin);
    return configured.protocol === "https:" && configured.origin === publicOrigin &&
      url.host === configured.host && req.headers.get("x-forwarded-proto") === "https" &&
      (!origin || origin === configured.origin);
  } catch {
    return false;
  }
}
```

(`parseOrigins` has already dropped anything `new URL` would throw on, so `new URL(o)` here is safe.)

- [ ] **Step 8: Run the library tests**

Run: `bun test src/core/library.test.ts`
Expected: PASS, the old tests included.

- [ ] **Step 9: Commit**

Run: `bun run typecheck && bun run lint`
Expected: pass.

```bash
git add src/core/cors.ts src/core/cors.test.ts src/core/library.ts src/core/library.test.ts
git commit -m "feat(server): CANOPY_ORIGINS lets named canopy pages through the origin gate

Claude-Session: https://claude.ai/code/session_01HJpZzCB58kTqvUGjFAsR31"
```

---

### Task 4: CORS and preflight on the server

**Files:**
- Modify: `src/server/index.ts:2434-2470` (the `Bun.serve` `fetch` handler)
- Test: `src/server/origin.test.ts`

**Interfaces:**
- Consumes: `parseOrigins`, `corsHeaders`, `PREFLIGHT_HEADERS` (Task 3), `libraryOriginAllowed(req, publicOrigin, open, origins)` (Task 3).
- Produces: every `/api/*` answer to a listed origin carries `corsHeaders`; `OPTIONS /api/*` is a preflight answer (204 listed, 403 otherwise).

- [ ] **Step 1: Write the failing server tests**

In `src/server/origin.test.ts`:

1. Add `"CANOPY_ORIGINS"` to the env keys saved in `beforeAll`, and set it before `startServer`:

```ts
const LISTED = "https://canopy-mac.example";
const SERVED = "https://box.tail0000.ts.net:7850";
// in beforeAll, next to CANOPY_PUBLIC_ORIGIN:
  process.env["CANOPY_ORIGINS"] = `${LISTED},${SERVED}`;
```

2. Add a new `describe` at the end of the file:

```ts
describe("another canopy page", () => {
  test("a listed origin's preflight is answered, an unlisted one is refused", async () => {
    const ok = await fetch(api("/api/repos/refresh?id=app"), {
      method: "OPTIONS",
      headers: { origin: LISTED, "access-control-request-method": "POST", "access-control-request-headers": "content-type" },
    });
    expect(ok.status).toBe(204);
    expect(ok.headers.get("access-control-allow-origin")).toBe(LISTED);
    expect(ok.headers.get("access-control-allow-credentials")).toBe("true");
    expect(ok.headers.get("access-control-allow-methods")).toContain("POST");
    const no = await fetch(api("/api/repos/refresh?id=app"), {
      method: "OPTIONS",
      headers: { origin: EVIL, "access-control-request-method": "POST" },
    });
    expect(no.status).toBe(403);
    expect(no.headers.get("access-control-allow-origin")).toBeNull();
  });

  test("a listed origin's calls go through and say so, cross-site or not", async () => {
    const res = await fetch(api("/api/repos/refresh?id=app"), {
      method: "POST",
      headers: { origin: LISTED, "sec-fetch-site": "cross-site", "content-type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe(LISTED);
    expect(res.headers.get("vary")).toBe("Origin");
  });

  test("a listed page's own GET behind tailscale serve carries no Origin and is let in", async () => {
    const res = await fetch(api("/api/tree"), { headers: { host: "box.tail0000.ts.net:7850", "sec-fetch-site": "same-origin" } });
    expect(res.status).toBe(200);
  });

  test("the event stream answers a listed origin with CORS", async () => {
    const res = await fetch(api("/api/events"), { headers: { origin: LISTED } });
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe(LISTED);
    await res.body?.cancel();
  });

  test("a listed origin opens a shell socket", async () => {
    const term = "abcdef0123456789abcdef0123456789";
    const q = new URLSearchParams({ id: "app", term, place: "strip", cols: "80", rows: "24" });
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/api/term?${q}`, { headers: { origin: LISTED } });
    const opened = await new Promise<boolean>((resolve) => {
      ws.onopen = () => resolve(true);
      ws.onerror = () => resolve(false);
      ws.onclose = () => resolve(false);
    });
    ws.close();
    await fetch(api(`/api/terms?term=${term}`), { method: "DELETE" });
    expect(opened).toBe(true);
  });

  test("nothing ever says any origin will do", async () => {
    for (const headers of [{}, { origin: LISTED }, { origin: EVIL }] as Record<string, string>[]) {
      const res = await fetch(api("/api/tree"), { headers });
      expect(res.headers.get("access-control-allow-origin")).not.toBe("*");
    }
  });
});
```

- [ ] **Step 2: Run to see them fail**

Run: `bun test src/server/origin.test.ts`
Expected: the new preflight test FAILS (OPTIONS answers 404 or 403 without CORS headers), and the others fail on missing `access-control-allow-origin`.

- [ ] **Step 3: Wire CORS into the handler**

In `src/server/index.ts`:

1. Import: `import { PREFLIGHT_HEADERS, corsHeaders, parseOrigins } from "../core/cors";`
2. Next to `const publicOrigin = process.env["CANOPY_PUBLIC_ORIGIN"];` add:

```ts
  // Other canopy pages (another machine's, or this one's own behind
  // tailscale serve) that may drive this backend; see the multi-backend spec.
  const origins = parseOrigins(process.env["CANOPY_ORIGINS"]);
```

3. Rename the existing `fetch: async (req, srv) => { ... }` body into a local function declared just above `const server = bind(port, () =>`, and make `fetch` wrap it. The route function keeps every line of the old body except its first (`const url = new URL(req.url);`), which moves to the wrapper, and its origin-gate call gains `origins`:

```ts
  const route = async (req: Request, srv: Bun.Server<Socket>, url: URL): Promise<Response | undefined> => {
    if (url.pathname === "/api/library" || url.pathname === "/library" || url.pathname.startsWith("/library/")) return library.handle(req);
    if (url.pathname.startsWith("/api/") && !libraryOriginAllowed(req, publicOrigin, beyondLoopback, origins)) {
      return json({ error: "Foreign origin" }, 403);
    }
    // ...the rest of the old body, unchanged...
  };
```

and in `Bun.serve`:

```ts
      fetch: async (req, srv) => {
        const url = new URL(req.url);
        const api = url.pathname.startsWith("/api/");
        const cors = api ? corsHeaders(req.headers.get("origin"), origins) : null;
        // A preflight runs nothing: answer it before any route, and only for
        // a listed origin.
        if (api && req.method === "OPTIONS") {
          return cors
            ? new Response(null, { status: 204, headers: { ...cors, ...PREFLIGHT_HEADERS } })
            : json({ error: "Foreign origin" }, 403);
        }
        const res = await route(req, srv, url);
        if (!res || !cors) return res;
        // a proxied or streamed answer may hold immutable headers; rewrap it
        const out = new Response(res.body, res);
        for (const [k, v] of Object.entries(cors)) out.headers.set(k, v);
        return out;
      },
```

- [ ] **Step 4: Run the origin tests**

Run: `bun test src/server/origin.test.ts`
Expected: PASS, old and new.

- [ ] **Step 5: Run the whole server suite**

Run: `bun test src/server`
Expected: PASS. The SSE, term and helper tests exercise the rewrapped responses.

- [ ] **Step 6: Document**

In `CLAUDE.md`, in the `src/server/` paragraph after the sentence about `CANOPY_PUBLIC_ORIGIN` (the origin gate, `libraryOriginAllowed`), add:

```
`CANOPY_ORIGINS` (comma-separated exact origins, `parseOrigins` in `core/cors.ts`) names the other canopy pages that may drive this backend: `libraryOriginAllowed` lets a listed Origin through even cross-site, and a request with no Origin whose Host is a listed origin's host (a listed page's own GET behind `tailscale serve`); every `/api/*` answer to a listed origin carries `corsHeaders` (that origin, credentials, `Vary: Origin`, never `*`), and an `OPTIONS` preflight is answered before any route (204 with `PREFLIGHT_HEADERS`, else 403). `GET /api/backends` is `{ self, backends }` off config `backends` (`normalizeBackends` and `selfName` in `core/backends.ts`); see `docs/superpowers/specs/2026-09-26-multi-backend-design.md`.
```

In `docs/deploy.md`, add a section at the end:

```markdown
## Other canopy pages (multi-backend)

A backend answers another canopy page only when that page's origin is in
`CANOPY_ORIGINS`, comma separated, exact origins. The mini's `.env` and the
Mac's launchd plist each list the other machine's public and tailnet origins
plus their own ts.net origin. See the multi-backend spec for the values.
```

- [ ] **Step 7: Gates and commit**

Run: `bun run typecheck && bun run lint && bun test && bun run build`
Expected: all pass.

```bash
git add src/server/index.ts src/server/origin.test.ts CLAUDE.md docs/deploy.md
git commit -m "feat(server): CORS and preflight for the origins CANOPY_ORIGINS lists

Claude-Session: https://claude.ai/code/session_01HJpZzCB58kTqvUGjFAsR31"
```

---

### Task 5: The edge Worker lets canopy preflights through and answers denials with CORS

**Repo:** `~/dev/homelab` (git root), package `services/beric-gate`.

**Files:**
- Modify: `services/beric-gate/edge/worker.ts` (new helpers near `hasWebSocketUpgrade`, line ~108; handler after the native bypass, line ~395; the denial return, line ~431)
- Test: `services/beric-gate/edge/worker.test.ts`

**Interfaces:**
- Produces: `isCanopyHost(hostname: string): boolean` and `canopyPreflight(request: Request, hostname: string): boolean` (exported for the tests).

- [ ] **Step 1: Write the failing tests**

Append to `services/beric-gate/edge/worker.test.ts`:

```ts
describe("canopy hosts", () => {
  const originOnly = (calls: string[]) =>
    createHandler({
      fetch: async (input) => {
        calls.push(String(input instanceof Request ? input.url : input));
        if (String(input) === DEFAULT_CHECK_URL) {
          return new Response(JSON.stringify({ error: "unauthorized", login: "https://auth.beric.ca/_gate/login" }), {
            status: 401,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response(null, { status: 204, headers: { "Access-Control-Allow-Origin": "https://canopy.beric.ca" } });
      },
    });

  test("a CORS preflight reaches the origin without the gate check", async () => {
    const calls: string[] = [];
    const res = await originOnly(calls)(
      new Request("https://canopy-mac.beric.ca/api/repos/refresh?id=app", {
        method: "OPTIONS",
        headers: { Origin: "https://canopy.beric.ca", "Access-Control-Request-Method": "POST" },
      }),
      env(),
    );
    expect(res.status).toBe(204);
    expect(calls).toEqual(["https://canopy-mac.beric.ca/api/repos/refresh?id=app"]);
  });

  test("an OPTIONS that is not a preflight, or on another host, is checked", async () => {
    for (const req of [
      new Request("https://canopy-mac.beric.ca/api/tree", { method: "OPTIONS", headers: { Origin: "https://canopy.beric.ca" } }),
      new Request("https://gev.beric.ca/api/x", { method: "OPTIONS", headers: { Origin: "https://canopy.beric.ca", "Access-Control-Request-Method": "POST" } }),
    ]) {
      const calls: string[] = [];
      const res = await originOnly(calls)(req, env());
      expect(res.status).toBe(401);
      expect(calls).toEqual([DEFAULT_CHECK_URL]);
    }
  });

  test("a denial to another canopy page is readable by it", async () => {
    const res = await originOnly([])(
      new Request("https://canopy-mac.beric.ca/api/about", { headers: { Origin: "https://canopy.beric.ca" } }),
      env(),
    );
    expect(res.status).toBe(401);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("https://canopy.beric.ca");
    expect(res.headers.get("Access-Control-Allow-Credentials")).toBe("true");
    expect(await res.json()).toEqual({ error: "unauthorized", login: "https://auth.beric.ca/_gate/login" });
  });

  test("a denial to any other origin carries no CORS", async () => {
    for (const origin of ["https://evil.example", "http://canopy.beric.ca", "https://gev.beric.ca"]) {
      const res = await originOnly([])(
        new Request("https://canopy-mac.beric.ca/api/about", { headers: { Origin: origin } }),
        env(),
      );
      expect(res.status).toBe(401);
      expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
    }
  });
});
```

- [ ] **Step 2: Run to see them fail**

Run (in `~/dev/homelab/services/beric-gate`): `bun test edge/worker.test.ts -t "canopy hosts"`
Expected: FAIL, the preflight gets 401 and the denial has no `Access-Control-Allow-Origin`.

- [ ] **Step 3: Add the helpers**

In `edge/worker.ts`, after `hasWebSocketUpgrade`:

```ts
const CANOPY_HOST = /^canopy(?:-[a-z0-9-]+)?\.beric\.ca$/;

/** canopy.beric.ca and every canopy-<machine>.beric.ca backend */
export function isCanopyHost(hostname: string): boolean {
  return CANOPY_HOST.test(hostname.toLowerCase());
}

/** A CORS preflight to a canopy backend. It carries no cookie (browsers never
 *  send one on a preflight) and runs nothing on the backend, which answers it
 *  for the canopy pages it lists; the request after it is checked as usual. */
export function canopyPreflight(request: Request, hostname: string): boolean {
  return request.method === "OPTIONS" && isCanopyHost(hostname)
    && request.headers.has("Origin") && request.headers.has("Access-Control-Request-Method");
}

/** The gate's denial of a canopy host, readable by another canopy page: a
 *  credentialed cross-origin fetch without these headers is a bare network
 *  error, and the page could not tell "sign in" from "offline". Only for an
 *  https canopy origin, and it reveals only the login the answer holds. */
function canopyDenial(request: Request, hostname: string, response: Response): Response {
  const origin = request.headers.get("Origin");
  if (!origin || !isCanopyHost(hostname)) return response;
  let from: URL;
  try {
    from = new URL(origin);
  } catch {
    return response;
  }
  if (from.protocol !== "https:" || from.origin !== origin || !isCanopyHost(from.hostname)) return response;
  const headers = new Headers(response.headers);
  headers.set("Access-Control-Allow-Origin", origin);
  headers.set("Access-Control-Allow-Credentials", "true");
  headers.append("Vary", "Origin");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
```

- [ ] **Step 4: Use them in the handler**

In `createHandler`'s returned function, right after the `isNativeBypass` block:

```ts
    if (canopyPreflight(request, hostname)) {
      return forwardToOrigin(fetcher, request, env, url);
    }
```

and change the denial line:

```ts
    if (gateResponse.status < 200 || gateResponse.status >= 300) return canopyDenial(request, hostname, noStore(gateResponse));
```

- [ ] **Step 5: Run the Worker tests and the gate's gates**

Run: `bun test edge/worker.test.ts && bun run typecheck && bun test`
Expected: PASS.

- [ ] **Step 6: Commit (in the homelab repo)**

```bash
cd ~/dev/homelab
git add services/beric-gate/edge/worker.ts services/beric-gate/edge/worker.test.ts
git commit -m "feat(edge): canopy preflights pass, canopy denials carry CORS

Claude-Session: https://claude.ai/code/session_01HJpZzCB58kTqvUGjFAsR31"
```

---

### Task 6: Put it live: tunnel, tailscale serve, config, Worker, redeploy

Ops only. Everything is driven from the Mac with existing credentials (`~/.claude/credentials/.credentials.json`, `providers.cloudflare.{account_id, api_token}`). Put helper scripts in the session scratchpad, not the repo. Probes go in script files: the context-mode hook refuses curl and inline fetches in Bash.

**Files:**
- Modify (outside the repo): `~/Library/LaunchAgents/ca.beric.canopy-server.plist`, `~/.config/canopy/config.json` (Mac), `/home/eric/.config/canopy/config.json` inside the mini's config volume (via the container), the mini's `~/dev/dev-tools/canopy/.env`
- Create (outside the repo): `~/Library/LaunchAgents/ca.beric.canopy-mac-tunnel.plist`, `~/.cloudflared/canopy-mac.token` (0600)

- [ ] **Step 1: Mac tunnel through the Cloudflare API**

Write `$SCRATCH/cf-tunnel.ts` and run it with `bun`. It must:

1. `POST accounts/{account}/cfd_tunnel` with `{ "name": "canopy-mac", "config_src": "cloudflare" }` (reuse an existing `canopy-mac` tunnel if `GET accounts/{account}/cfd_tunnel?name=canopy-mac&is_deleted=false` finds one).
2. `PUT accounts/{account}/cfd_tunnel/{id}/configurations` with
   `{ "config": { "ingress": [ { "hostname": "canopy-mac.beric.ca", "service": "http://127.0.0.1:7850" }, { "service": "http_status:404" } ] } }`.
3. Create or update the DNS record in zone `beric.ca`: `CNAME canopy-mac → {id}.cfargotunnel.com`, `proxied: true`.
4. `GET accounts/{account}/cfd_tunnel/{id}/token` and write it to `~/.cloudflared/canopy-mac.token` with mode 0600. Never print it.
5. Print the tunnel id and the DNS record id only.

- [ ] **Step 2: Mac connector under launchd**

Write `~/Library/LaunchAgents/ca.beric.canopy-mac-tunnel.plist`: Label `ca.beric.canopy-mac-tunnel`, `ProgramArguments` = `/opt/homebrew/bin/cloudflared`, `tunnel`, `--no-autoupdate`, `run`, `--token-file`, `/Users/ericbaruch/.cloudflared/canopy-mac.token`; `KeepAlive` true, `RunAtLoad` true, logs to `~/Library/Logs/canopy-mac-tunnel.log`. Then `launchctl bootstrap gui/$UID ~/Library/LaunchAgents/ca.beric.canopy-mac-tunnel.plist`.

Verify: `tail -5 ~/Library/Logs/canopy-mac-tunnel.log` shows `Registered tunnel connection`. Confirm `ca.beric.canopy-tunnel` is still not loaded: `launchctl list | grep canopy` lists `ca.beric.canopy-server` and `ca.beric.canopy-mac-tunnel` only.

- [ ] **Step 3: The Worker covers the new host, then deploy it**

Write `$SCRATCH/cf-worker.ts`:

1. `GET zones/{zone}/workers/routes`. If no route pattern covers `canopy-mac.beric.ca` (a `*.beric.ca/*` pattern counts), `POST` one: `{ "pattern": "canopy-mac.beric.ca/*", "script": "beric-auth-edge" }`. Print the patterns.
2. Bundle: `bun build ~/dev/homelab/services/beric-gate/edge/worker.ts --target browser --format esm --outfile $SCRATCH/worker.js`.
3. Upload with bindings kept: `PUT accounts/{account}/workers/scripts/beric-auth-edge` as multipart, metadata `{ "main_module": "worker.js", "compatibility_date": "2026-09-20", "keep_bindings": ["secret_text", "plain_text", "service"] }` and the `worker.js` part as `application/javascript+module`.

Verify with a probe script (`$SCRATCH/probe-edge.ts`, run with bun):
- `GET https://canopy-mac.beric.ca/api/about` with `Origin: https://canopy.beric.ca` → 401, JSON with `login`, `access-control-allow-origin: https://canopy.beric.ca`.
- `OPTIONS https://canopy-mac.beric.ca/api/tree` with `Origin: https://canopy.beric.ca`, `Access-Control-Request-Method: GET` → reaches the Mac's canopy. Until Step 5 sets `CANOPY_ORIGINS` it answers 403 from canopy (JSON `Foreign origin`), which proves the Worker let it through.
- `GET https://canopy.beric.ca/api/about` → still 401 as before (nothing else broke).

`GATE_SSO_HOSTS` on the mini is `beric.ca,*.beric.ca` (checked while planning), so the central gate already accepts the new host; no gate change.

- [ ] **Step 4: tailscale serve on both machines**

Mac: `tailscale serve --bg --https=7850 http://127.0.0.1:7850`. Verify `tailscale serve status` lists `https://erics-macbook-pro.tail2d2c60.ts.net:7850` next to the existing 443 entry.

Mini: first `ssh macmini-2018 'ss -ltnH | grep -c ":7849 "'` must print `0`. Then `ssh macmini-2018 'sudo tailscale serve --bg --https=7849 http://100.68.139.95:7850'` (drop `sudo` if the mini's operator is set; if neither works without a password, hand Eric that one command). Verify `tailscale serve status` on the mini lists `:7849`.

- [ ] **Step 5: Origins and backends on the Mac**

1. Add to the plist's `EnvironmentVariables` (create the dict if missing) with `plutil -replace`:
   - `CANOPY_PUBLIC_ORIGIN` = `https://canopy-mac.beric.ca`
   - `CANOPY_ORIGINS` = `https://canopy.beric.ca,https://macmini-2018.tail2d2c60.ts.net:7849,https://erics-macbook-pro.tail2d2c60.ts.net:7850,http://macmini-2018:7850,http://100.68.139.95:7850`
2. In `~/.config/canopy/config.json`, set `backends` (read the file first, change only this key):

```json
"backends": [
  { "name": "mini", "public": "https://canopy.beric.ca", "tailnet": "https://macmini-2018.tail2d2c60.ts.net:7849" },
  { "name": "mac", "public": "https://canopy-mac.beric.ca", "tailnet": "https://erics-macbook-pro.tail2d2c60.ts.net:7850" }
]
```

   If the Mac's `self` is not `mac`, use its actual `self` as the name.
3. Reload: `launchctl bootout gui/$UID/ca.beric.canopy-server && launchctl bootstrap gui/$UID ~/Library/LaunchAgents/ca.beric.canopy-server.plist`. KeepAlive does not re-read the plist on a plain kill, so the bootout is needed.

- [ ] **Step 6: Origins and backends on the mini, then redeploy**

1. In the mini's `~/dev/dev-tools/canopy/.env` add (never print the file; edit with a targeted `sed`/append over ssh):
   `CANOPY_ORIGINS=https://canopy-mac.beric.ca,https://erics-macbook-pro.tail2d2c60.ts.net:7850,https://macmini-2018.tail2d2c60.ts.net:7849`
2. Check `docker-compose.yml` passes `CANOPY_ORIGINS` into the canopy service's environment. If it does not, add `CANOPY_ORIGINS: ${CANOPY_ORIGINS:-}` next to `CANOPY_PUBLIC_ORIGIN` in the repo's `docker-compose.yml`, run the gates, and commit that on the Mac (`feat(deploy): pass CANOPY_ORIGINS to canopy`) before redeploying.
3. Set the same `backends` value in the mini's canopy config (the `canopy_canopy-config` volume) with the same care as the Mac: read, change one key, write. Use the mini's actual `self` for its entry.
4. `bun run redeploy` from the Mac (it waits for the peer pass to bring the commits over). Verify per the redeploy skill: `canopy-shells-1 Running` (not recreated) and `docker compose logs canopy --tail 6` showing shells held from before.

- [ ] **Step 7: Verify end to end**

`$SCRATCH/probe-multi.ts` (bun), each line printed as pass or fail:

1. `GET https://macmini-2018.tail2d2c60.ts.net:7849/api/about` → 200, commit is the new HEAD.
2. `GET https://erics-macbook-pro.tail2d2c60.ts.net:7850/api/about` → 200.
3. `GET https://erics-macbook-pro.tail2d2c60.ts.net:7850/api/backends` with `Origin: https://macmini-2018.tail2d2c60.ts.net:7849` → 200, `access-control-allow-origin` echoes it, body lists both backends.
4. `OPTIONS https://macmini-2018.tail2d2c60.ts.net:7849/api/repos/refresh?id=.` with `Origin: https://erics-macbook-pro.tail2d2c60.ts.net:7850`, `Access-Control-Request-Method: POST` → 204.
5. `GET https://erics-macbook-pro.tail2d2c60.ts.net:7850/api/tree` with `Origin: https://evil.example` → 403.
6. `OPTIONS https://canopy-mac.beric.ca/api/tree` with `Origin: https://canopy.beric.ca`, `Access-Control-Request-Method: GET` → 204 with `access-control-allow-origin: https://canopy.beric.ca`.
7. `GET https://canopy-mac.beric.ca/api/about` with no cookie → 401 JSON.

Then in a real browser (Chrome MCP or playwright-cli, per the memory note use playwright-cli for screenshots): open `https://canopy-mac.beric.ca`, sign in through the gate, and confirm the Mac's canopy loads and a shell opens. That is the Mac reachable off the tailnet as its own page, which is what this plan ships on its own; the single page over both backends is plan 2.

- [ ] **Step 8: Record it**

Update the memory note `canopy-mini-container-deploy.md` (or a new `canopy-multi-backend.md` linked from it and from `MEMORY.md`) with: the Mac tunnel's name and launchd label, the two `tailscale serve` ports, where `CANOPY_ORIGINS` lives on each machine, and that the parked `ca.beric.canopy-tunnel` must stay parked. Add `canopy-mac.beric.ca` to `~/dev/homelab/services/beric-home/inventory.yml` next to the `canopy` entry (read the entry's shape first and copy it), commit in the homelab repo.

---

## Plan 2 (next, not in this file)

Written after this plan lands, against the code it leaves: the client registry (`GET /api/backends`, `canopy.settings.backends`, `pickUrl`), `qualify`/`unqualify` and the per-shape inbound qualification in `ui/src/api.ts`, one `subscribe` per backend with `withCredentials`, backend-aware `socketUrl`, `joinRepos` and the card model, the machine strip, the panel's machine switcher and `checkoutPref`, merged shells/runs/flows/jobs lists with machine words, per-backend `clientCaps`, the backends chip with `backendState`, and the Settings backend picker.
