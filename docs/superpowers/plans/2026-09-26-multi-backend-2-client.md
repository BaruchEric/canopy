# Several canopy backends, one frontend: plan 2, the client

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One canopy page connects to every backend in the registry at once, shows a repo that lives on several machines as one card with a machine strip, and drives each checkout on its own backend.

**Architecture:** The page asks its own backend (home) for `GET /api/backends`, then opens one connection per other backend at a URL `pickUrl` chooses. Ids from another backend carry `<name>|` in front; the home backend's stay bare (spec amendment 6), so a single-backend page is byte-for-byte what it was. `ui/src/api.ts` is the only code that adds or strips a prefix, through `ui/src/registry.ts`; the store holds one merged list of everything, replaces one backend's slice at a time, and the board joins checkouts into cards through the pure `joinRepos`.

**Tech Stack:** Bun 1.4, TypeScript strict (`noUncheckedIndexedAccess`), React 19, Zustand, bun:test. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-09-26-multi-backend-design.md` (sections 1 client half, 2, 4, 5, and amendments 6 to 8). Plan 1 (`docs/superpowers/plans/2026-09-26-multi-backend-1-reachable.md`) landed the server half: `GET /api/backends` answering `{ self, backends: BackendEntry[] }`, `CANOPY_ORIGINS`, CORS, the edge Worker and the tunnels. It is live on both machines, and both answer `self` as an entry in their own `backends`.

## Global Constraints

- Use `bun`/`bunx` only. No new dependencies.
- Gates, all four, before a task is done: `bun run typecheck && bun run lint && bun test && bun run build`.
- `ui/` code imports only browser-safe modules: `src/core/types.ts`, `src/core/version.ts`, `src/core/client.ts`, `src/core/presence.ts`, `src/core/tailchan.ts`, `src/core/flow.ts`, and the new `src/core/remote.ts`. Never `src/core/access.ts`, `exec.ts` or anything that imports Bun or node.
- The home backend's ids stay bare; every other backend's ids read `<name>|<id>`. Only `ui/src/api.ts` (through `ui/src/registry.ts`) adds or strips the prefix, except that the store mints a new shell's id with `qual(backend, termId())`.
- The existing assertions in `ui/src/store.test.ts` (relative URLs like `DELETE /api/terms?term=<id>`) are the proof that the single-backend path did not change. Do not edit them to make them pass. If one fails, the code is wrong.
- With one backend in the registry (no `backends` config, or only `self`), no new UI shows: no backends chip, no machine strip, no switcher, no backend picker in Settings, and no request goes anywhere but the page's own origin.
- A Zustand selector that builds a new array goes through `useShallow`, and every element it returns must be a stable reference across unrelated state changes (cards come from a memo), or React re-renders forever and unmounts the tree.
- Commit messages: no backticks; end with the line `Claude-Session: https://claude.ai/code/session_01HJpZzCB58kTqvUGjFAsR31`.
- Comments and UI copy follow the repo's voice: plain words, sentence case, no em dashes. Styles only in `ui/src/styles.css` with the existing tokens; no CSS framework.
- Never put a qualified id (`mac|…`) on the wire to a backend, and never show one to the user: print a repo's name, a plain id, or the backend's name as its own word.

## Review Focus

1. **A backend that is offline when the page loads.** Its saved panels and shell tabs must survive the home scan (not pruned, not dropped from the saved layout) and come back when it answers. Test in Task 5.
2. **A foreign id reaching a server.** Every outbound call must send the plain id to the right base URL. Test in Task 4 (`multi.test.ts` drives a foreign checkout's log, stage and shell through qualified ids).
3. **Two checkouts of one remote on one backend.** They stay two cards, so a single-backend board is unchanged. Test in Task 3.
4. **Render loops.** `visibleCards`/`visibleRepos` return the same element references for the same repos, pref and states. Test in Task 6.
5. **An event from backend B naming an id home also has.** It updates B's checkout, never home's, and a scan from B never prunes home's panels. Test in Task 5.

---

### Task 1: the pure backend helpers

**Files:**
- Create: `ui/src/backends.ts`
- Test: `ui/src/backends.test.ts`

**Interfaces:**
- Consumes: `BackendEntry`, `LAUNCH_SOURCE` from `src/core/types.ts`.
- Produces (later tasks rely on these names exactly):
  - `SEP = "|"`, `interface Reg { home: string; names: readonly string[] }`
  - `qualify(reg, backend, id): string`, `split(reg, id): [string, string]`
  - `onPublicSide(pageHost, entries): boolean`, `interface UrlPick { first: string | null; fallback: string | null }`, `pickUrl(pageOrigin, entry, entries): UrlPick`
  - `type BackendState`, `interface BackendStatus { state; reason?; login? }`, `type BackendSignal`, `backendState(prev, signal): BackendStatus` (returns `prev` itself when nothing changed)
  - `sliceIn<T>(reg, list, from, next, idOf): T[]`
  - `wsUrl(base, page, path): string`
  - `isLaunchSource(source): boolean`

- [ ] **Step 1: Write the failing test**

`ui/src/backends.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import {
  backendState,
  isLaunchSource,
  onPublicSide,
  pickUrl,
  qualify,
  sliceIn,
  split,
  wsUrl,
  type BackendStatus,
  type Reg,
} from "./backends";
import type { BackendEntry } from "../../src/core/types";

const reg: Reg = { home: "mini", names: ["mini", "mac"] };
const entries: BackendEntry[] = [
  { name: "mini", public: "https://canopy.beric.ca", tailnet: "https://macmini-2018.tail2d2c60.ts.net:7849" },
  { name: "mac", public: "https://canopy-mac.beric.ca", tailnet: "https://erics-macbook-pro.tail2d2c60.ts.net:7850" },
];
const mini = entries[0]!;
const mac = entries[1]!;

describe("qualify and split", () => {
  test("home ids stay bare", () => {
    expect(qualify(reg, "mini", "dev-tools/canopy")).toBe("dev-tools/canopy");
    expect(split(reg, "dev-tools/canopy")).toEqual(["mini", "dev-tools/canopy"]);
  });
  test("another backend's ids carry its name", () => {
    const id = qualify(reg, "mac", "dev-tools/canopy");
    expect(id).toBe("mac|dev-tools/canopy");
    expect(split(reg, id)).toEqual(["mac", "dev-tools/canopy"]);
  });
  test("round trips ids holding slashes, colons, dots and bars", () => {
    for (const plain of [".", "work:a/b", "x|y", "a.b/c", "0123456789abcdef0123456789abcdef"]) {
      for (const b of reg.names) expect(split(reg, qualify(reg, b, plain))).toEqual([b, plain]);
    }
  });
  test("a home id with a bar stays home unless the prefix names another backend", () => {
    expect(split(reg, "notes|2026")).toEqual(["mini", "notes|2026"]);
    expect(split(reg, "mini|x")).toEqual(["mini", "mini|x"]);
  });
  test("a backend no longer in the registry reads as home", () => {
    expect(split({ home: "mini", names: ["mini"] }, "mac|a")).toEqual(["mini", "mac|a"]);
  });
});

describe("which url", () => {
  test("public side by host or parent domain", () => {
    expect(onPublicSide("canopy.beric.ca", entries)).toBe(true);
    expect(onPublicSide("canopy-wsl.beric.ca", entries)).toBe(true);
    expect(onPublicSide("erics-macbook-pro.tail2d2c60.ts.net", entries)).toBe(false);
    expect(onPublicSide("127.0.0.1", entries)).toBe(false);
    expect(onPublicSide("localhost", entries)).toBe(false);
    expect(onPublicSide("macmini-2018", entries)).toBe(false);
  });
  test("a page on the public side uses public urls", () => {
    expect(pickUrl("https://canopy.beric.ca", mac, entries)).toEqual({ first: "https://canopy-mac.beric.ca", fallback: null });
  });
  test("a tailnet page uses the tailnet url and falls back to public", () => {
    expect(pickUrl("https://macmini-2018.tail2d2c60.ts.net:7849", mac, entries)).toEqual({
      first: "https://erics-macbook-pro.tail2d2c60.ts.net:7850",
      fallback: "https://canopy-mac.beric.ca",
    });
  });
  test("the Mac's loopback page takes the tailnet url", () => {
    expect(pickUrl("http://127.0.0.1:7850", mini, entries)).toEqual({
      first: "https://macmini-2018.tail2d2c60.ts.net:7849",
      fallback: "https://canopy.beric.ca",
    });
  });
  test("an https page never picks an http url", () => {
    const nb: BackendEntry = { name: "nb", tailnet: "http://notebook:7850", public: "https://canopy-nb.beric.ca" };
    expect(pickUrl("https://macmini-2018.tail2d2c60.ts.net:7849", nb, [...entries, nb])).toEqual({
      first: "https://canopy-nb.beric.ca",
      fallback: null,
    });
  });
  test("an http page may take an http tailnet url", () => {
    const nb: BackendEntry = { name: "nb", tailnet: "http://notebook:7850" };
    expect(pickUrl("http://macmini-2018:7850", nb, [...entries, nb])).toEqual({ first: "http://notebook:7850", fallback: null });
  });
  test("a url that is the page's own origin is skipped", () => {
    expect(pickUrl("https://erics-macbook-pro.tail2d2c60.ts.net:7850", mac, entries)).toEqual({
      first: "https://canopy-mac.beric.ca",
      fallback: null,
    });
  });
  test("no usable url", () => {
    expect(pickUrl("https://canopy.beric.ca", { name: "x", tailnet: "http://x:1" }, entries)).toEqual({ first: null, fallback: null });
  });
  test("a trailing slash or path is dropped", () => {
    expect(pickUrl("https://canopy.beric.ca", { name: "x", public: "https://canopy-x.beric.ca/" }, entries).first).toBe(
      "https://canopy-x.beric.ca",
    );
  });
});

describe("backendState", () => {
  const connecting: BackendStatus = { state: "connecting" };
  test("an answer or an open stream is online", () => {
    expect(backendState(connecting, { kind: "answered" })).toEqual({ state: "online" });
    expect(backendState({ state: "offline", reason: "x" }, { kind: "stream-open" })).toEqual({ state: "online" });
  });
  test("no answer is offline with the reason", () => {
    expect(backendState({ state: "online" }, { kind: "unreachable", reason: "no answer" })).toEqual({
      state: "offline",
      reason: "no answer",
    });
    expect(backendState({ state: "online" }, { kind: "stream-lost" }).state).toBe("offline");
  });
  test("the gate's 401 is signin, and a dropped stream after it stays signin", () => {
    const s = backendState(connecting, { kind: "signin", login: "https://beric.ca/login" });
    expect(s).toEqual({ state: "signin", login: "https://beric.ca/login" });
    expect(backendState(s, { kind: "stream-lost" })).toBe(s);
    expect(backendState(s, { kind: "unreachable", reason: "x" })).toBe(s);
    expect(backendState(s, { kind: "answered" })).toEqual({ state: "online" });
  });
  test("a retry is connecting", () => {
    expect(backendState({ state: "offline", reason: "x" }, { kind: "retry" })).toEqual({ state: "connecting" });
  });
  test("nothing changed hands back the same object", () => {
    const on: BackendStatus = { state: "online" };
    expect(backendState(on, { kind: "answered" })).toBe(on);
    const off: BackendStatus = { state: "offline", reason: "x" };
    expect(backendState(off, { kind: "unreachable", reason: "x" })).toBe(off);
    expect(backendState(off, { kind: "stream-lost" })).toBe(off);
    expect(backendState(connecting, { kind: "retry" })).toBe(connecting);
  });
});

describe("sliceIn", () => {
  const ids = (xs: { id: string }[]) => xs.map((x) => x.id);
  test("replaces one backend's part and keeps registry order", () => {
    const list = [{ id: "a" }, { id: "mac|a" }, { id: "b" }];
    const out = sliceIn(reg, list, "mac", [{ id: "mac|c" }, { id: "mac|d" }], (x) => x.id);
    expect(ids(out)).toEqual(["a", "b", "mac|c", "mac|d"]);
    expect(ids(sliceIn(reg, out, "mini", [{ id: "z" }], (x) => x.id))).toEqual(["z", "mac|c", "mac|d"]);
  });
  test("with one backend the next list is the list", () => {
    const next = [{ id: "a" }];
    expect(sliceIn({ home: "mini", names: ["mini"] }, [{ id: "b" }], "mini", next, (x) => x.id)).toBe(next);
  });
});

describe("wsUrl", () => {
  test("home is the page's own host", () => {
    expect(wsUrl("", { protocol: "https:", host: "canopy.beric.ca" }, "/api/term?x=1")).toBe("wss://canopy.beric.ca/api/term?x=1");
    expect(wsUrl("", { protocol: "http:", host: "127.0.0.1:7850" }, "/api/term")).toBe("ws://127.0.0.1:7850/api/term");
  });
  test("another backend is its own base", () => {
    expect(wsUrl("https://canopy-mac.beric.ca", { protocol: "http:", host: "x" }, "/api/term")).toBe("wss://canopy-mac.beric.ca/api/term");
    expect(wsUrl("http://notebook:7850", { protocol: "http:", host: "x" }, "/api/term")).toBe("ws://notebook:7850/api/term");
  });
});

test("isLaunchSource", () => {
  expect(isLaunchSource("launch")).toBe(true);
  expect(isLaunchSource("mac|launch")).toBe(true);
  expect(isLaunchSource("work")).toBe(false);
  expect(isLaunchSource("mac|work")).toBe(false);
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `bun test ui/src/backends.test.ts`
Expected: FAIL, cannot find module `./backends`.

- [ ] **Step 3: Write the module**

`ui/src/backends.ts`:

```ts
import { LAUNCH_SOURCE, type BackendEntry } from "../../src/core/types";

/* Several canopy backends behind one page. Pure, so the api layer, the
   store and the tests share one reading of an id and of which URL to use. */

/** What stands between a backend's name and an id it minted. Backend names
 *  are slugs, so the first one in an id is always this. */
export const SEP = "|";

/** The backends a page talks to: the one that served it, and all of them
 *  in the registry's order (home among them). */
export interface Reg {
  home: string;
  names: readonly string[];
}

/** An id as the page holds it. The home backend's ids stay bare, so a page
 *  with one backend holds what it held before there were several. */
export function qualify(reg: Reg, backend: string, id: string): string {
  return backend === reg.home ? id : `${backend}${SEP}${id}`;
}

/** The backend an id belongs to and the id that backend knows. A prefix
 *  counts only when it names another backend in the registry, so a home id
 *  with a bar in it stays home. */
export function split(reg: Reg, id: string): [string, string] {
  const i = id.indexOf(SEP);
  if (i > 0) {
    const name = id.slice(0, i);
    if (name !== reg.home && reg.names.includes(name)) return [name, id.slice(i + 1)];
  }
  return [reg.home, id];
}

/** A host less its first label; an address or a one- or two-label name is
 *  its own parent. */
function parentOf(host: string): string {
  if (/^[\d.]+$/.test(host) || host.includes(":")) return host;
  const parts = host.split(".");
  return parts.length > 2 ? parts.slice(1).join(".") : host;
}

/** Whether a page is on the public side: its host, or its parent domain, is
 *  a public URL's. The gate's cookie is scoped to that parent, so only such
 *  a page can carry a sign-in to another backend. */
export function onPublicSide(pageHost: string, entries: readonly BackendEntry[]): boolean {
  const page = parentOf(pageHost);
  return entries.some((e) => {
    if (!e.public) return false;
    const host = new URL(e.public).hostname;
    return host === pageHost || parentOf(host) === page;
  });
}

export interface UrlPick {
  /** the URL to try; null when the entry has none this page can use */
  first: string | null;
  /** the URL to fall back to when `first` does not answer */
  fallback: string | null;
}

/** Which of a backend's URLs this page should use. A public-side page uses
 *  `public`; any other uses `tailnet` and falls back to `public`. An https
 *  page never takes an http URL (mixed content), and a URL that is the
 *  page's own origin is skipped, since that backend is home. */
export function pickUrl(pageOrigin: string, entry: BackendEntry, entries: readonly BackendEntry[]): UrlPick {
  const page = new URL(pageOrigin);
  const usable = (u: string | undefined): string | null => {
    if (!u) return null;
    const origin = new URL(u).origin;
    if (page.protocol === "https:" && !origin.startsWith("https:")) return null;
    return origin === page.origin ? null : origin;
  };
  const pub = usable(entry.public);
  const tail = usable(entry.tailnet);
  if (onPublicSide(page.hostname, entries)) return { first: pub ?? tail, fallback: null };
  return tail ? { first: tail, fallback: pub } : { first: pub, fallback: null };
}

export type BackendState = "connecting" | "online" | "offline" | "signin";

export interface BackendStatus {
  state: BackendState;
  /** why it is offline */
  reason?: string;
  /** the gate's login page, when it asked for a sign-in */
  login?: string;
}

/** What the api layer saw of a backend. */
export type BackendSignal =
  /** a response came back, whatever its status (bar the gate's 401) */
  | { kind: "answered" }
  /** no response: a network error, a CORS refusal, a timeout */
  | { kind: "unreachable"; reason: string }
  /** the gate answered 401 with where to sign in */
  | { kind: "signin"; login: string }
  | { kind: "stream-open" }
  | { kind: "stream-lost" }
  /** the page is trying again */
  | { kind: "retry" };

/** A backend's state after a signal; `prev` itself when nothing changed, so
 *  the store does not churn. A dropped stream after a sign-in prompt is
 *  still a sign-in: the gate refuses the stream the same way. */
export function backendState(prev: BackendStatus, sig: BackendSignal): BackendStatus {
  switch (sig.kind) {
    case "answered":
    case "stream-open":
      return prev.state === "online" ? prev : { state: "online" };
    case "signin":
      return prev.state === "signin" && prev.login === sig.login ? prev : { state: "signin", login: sig.login };
    case "unreachable":
      if (prev.state === "signin") return prev;
      return prev.state === "offline" && prev.reason === sig.reason ? prev : { state: "offline", reason: sig.reason };
    case "stream-lost":
      if (prev.state === "signin" || prev.state === "offline") return prev;
      return { state: "offline", reason: "the event stream dropped" };
    case "retry":
      return prev.state === "connecting" ? prev : { state: "connecting" };
  }
}

/** A merged list with one backend's part replaced by `next`, in registry
 *  order and, within a backend, in the order each came. With one backend
 *  it is `next` itself. */
export function sliceIn<T>(reg: Reg, list: readonly T[], from: string, next: T[], idOf: (t: T) => string): T[] {
  if (reg.names.length <= 1) return next;
  const rank = (t: T): number => {
    const i = reg.names.indexOf(split(reg, idOf(t))[0]);
    return i < 0 ? reg.names.length : i;
  };
  const kept = list.filter((t) => split(reg, idOf(t))[0] !== from);
  return [...kept, ...next].sort((a, b) => rank(a) - rank(b));
}

/** The websocket URL for a path on a backend: the page's own host for home
 *  (an empty base), else the backend's base with ws in place of http. */
export function wsUrl(base: string, page: { protocol: string; host: string }, path: string): string {
  if (!base) return `${page.protocol === "https:" ? "wss" : "ws"}://${page.host}${path}`;
  return `${base.replace(/^http/, "ws")}${path}`;
}

/** Whether a source id is a backend's launch root, whichever backend. */
export const isLaunchSource = (source: string): boolean =>
  source === LAUNCH_SOURCE || source.endsWith(`${SEP}${LAUNCH_SOURCE}`);
```

- [ ] **Step 4: Run it to see it pass**

Run: `bun test ui/src/backends.test.ts`
Expected: PASS, every test.

- [ ] **Step 5: Gates and commit**

Run the four gates. Then:

```bash
git add ui/src/backends.ts ui/src/backends.test.ts
git commit -m "feat(ui): pure helpers for several backends: ids, urls, state

Claude-Session: https://claude.ai/code/session_01HJpZzCB58kTqvUGjFAsR31"
```

---

### Task 2: qualifying what a backend sends

**Files:**
- Create: `ui/src/qualify.ts`
- Test: `ui/src/qualify.test.ts`

**Interfaces:**
- Consumes: `qualify`, `split`, `Reg` from Task 1; server types.
- Produces: `type Q = (id: string) => string`; `qRepo`, `qSource`, `qScan`, `qRun`, `qFlow`, `qFleet`, `qJob`, `qTerm`, `qKept`, `qDevice`, `qHistory`, `qGrep`, `qEvent(q, ev)`; `mergeHistory(parts): HistoryOverview | null`.

- [ ] **Step 1: Write the failing test**

`ui/src/qualify.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { qualify, split, type Reg } from "./backends";
import {
  mergeHistory,
  qDevice,
  qEvent,
  qFleet,
  qFlow,
  qGrep,
  qHistory,
  qJob,
  qKept,
  qRepo,
  qRun,
  qScan,
  qTerm,
} from "./qualify";
import type {
  Device,
  Fleet,
  Flow,
  HistoryOverview,
  Job,
  KeptShell,
  Repo,
  RepoHistory,
  Run,
  ScanResult,
  ServerEvent,
  TermInfo,
} from "../../src/core/types";

const reg: Reg = { home: "mini", names: ["mini", "mac"] };
const q = (id: string) => qualify(reg, "mac", id);
const back = (id: string) => split(reg, id);

const repo = { id: "a/b", name: "b", path: "/x/a/b", group: "a", source: "launch", status: null } as Repo;
const run = { id: "r1", repoId: "a/b" } as Run;
const flow = { id: "f1", repoId: "a/b", fleetId: "fl1", steps: [{ name: "s", status: "passed", runId: "r1" }, { name: "t", status: "pending" }] } as Flow;
const fleet = { id: "fl1", repos: [{ repoId: "a/b", flowId: "f1" }, { repoId: "c", skipped: "clean" }] } as Fleet;
const job = { id: "j1", repoId: "a/b" } as Job;
const term = { id: "0123456789abcdef0123456789abcdef", repoId: "a/b" } as TermInfo;
const kept = { id: "0123456789abcdef0123456789abcdef", repoId: "a/b" } as KeptShell;
const device = { id: "00ff00ff00ff00ff", name: "phone" } as Device;

describe("shapes", () => {
  test("a repo, its source and a forge clone's id", () => {
    const out = qRepo(q, { ...repo, forge: { clonedAs: "a/c" } } as Repo);
    expect(out.id).toBe("mac|a/b");
    expect(out.source).toBe("mac|launch");
    expect(out.forge?.clonedAs).toBe("mac|a/c");
    expect(back(out.id)).toEqual(["mac", "a/b"]);
    expect(repo.id).toBe("a/b");
  });
  test("a scan's repos and sources", () => {
    const scan = { root: "/x", repos: [repo], sources: [{ id: "launch", label: "x" }], scannedAt: 1, backend: { openers: false, sshHost: null } } as unknown as ScanResult;
    const out = qScan(q, scan);
    expect(out.repos[0]?.id).toBe("mac|a/b");
    expect(out.sources[0]?.id).toBe("mac|launch");
    expect(out.root).toBe("/x");
  });
  test("runs, flows, fleets, jobs, shells, kept shells, devices", () => {
    expect(qRun(q, run)).toMatchObject({ id: "mac|r1", repoId: "mac|a/b" });
    const f = qFlow(q, flow);
    expect(f).toMatchObject({ id: "mac|f1", repoId: "mac|a/b", fleetId: "mac|fl1" });
    expect(f.steps[0]?.runId).toBe("mac|r1");
    expect(f.steps[1]?.runId).toBeUndefined();
    const fl = qFleet(q, fleet);
    expect(fl.id).toBe("mac|fl1");
    expect(fl.repos).toEqual([{ repoId: "mac|a/b", flowId: "mac|f1" }, { repoId: "mac|c", skipped: "clean" }]);
    expect(qJob(q, job)).toMatchObject({ id: "mac|j1", repoId: "mac|a/b" });
    expect(qTerm(q, term)).toMatchObject({ id: `mac|${term.id}`, repoId: "mac|a/b" });
    expect(qKept(q, kept)).toMatchObject({ id: `mac|${kept.id}`, repoId: "mac|a/b" });
    expect(qDevice(q, device).id).toBe("mac|00ff00ff00ff00ff");
  });
  test("history keys and grep rows", () => {
    const h = { available: true, days: [], maxDay: 0, fetchedAt: 1, repos: { "a/b": {} as RepoHistory } } as HistoryOverview;
    const out = qHistory(q, h);
    expect(out.available && Object.keys(out.repos)).toEqual(["mac|a/b"]);
    const off: HistoryOverview = { available: false, reason: "x", fetchedAt: 1 };
    expect(qHistory(q, off)).toBe(off);
    expect(qGrep(q, { repo: "a/b", hits: [], truncated: false }).repo).toBe("mac|a/b");
  });
});

describe("qEvent", () => {
  test("every event that carries an id comes out qualified", () => {
    const cases: [ServerEvent, (e: ServerEvent) => string[]][] = [
      [{ type: "repo", repo }, (e) => (e.type === "repo" ? [e.repo.id] : [])],
      [{ type: "run", run }, (e) => (e.type === "run" ? [e.run.id, e.run.repoId] : [])],
      [{ type: "run-gone", id: "r1" }, (e) => (e.type === "run-gone" ? [e.id] : [])],
      [{ type: "flow", flow }, (e) => (e.type === "flow" ? [e.flow.id, e.flow.repoId] : [])],
      [{ type: "flow-gone", id: "f1" }, (e) => (e.type === "flow-gone" ? [e.id] : [])],
      [{ type: "fleet", fleet }, (e) => (e.type === "fleet" ? [e.fleet.id, ...e.fleet.repos.map((r) => r.repoId)] : [])],
      [{ type: "fleet-gone", id: "fl1" }, (e) => (e.type === "fleet-gone" ? [e.id] : [])],
      [{ type: "job", job }, (e) => (e.type === "job" ? [e.job.id, e.job.repoId] : [])],
      [{ type: "job-gone", id: "j1" }, (e) => (e.type === "job-gone" ? [e.id] : [])],
      [{ type: "builds", repoId: "a/b", what: "built", build: "local" }, (e) => (e.type === "builds" ? [e.repoId] : [])],
      [{ type: "terms", terms: [term] }, (e) => (e.type === "terms" ? e.terms.flatMap((t) => [t.id, t.repoId]) : [])],
      [{ type: "devices", devices: [device] }, (e) => (e.type === "devices" ? e.devices.map((d) => d.id) : [])],
      [{ type: "kept", kept: [kept] }, (e) => (e.type === "kept" ? e.kept.flatMap((k) => [k.id, k.repoId]) : [])],
    ];
    for (const [ev, ids] of cases) {
      const out = ids(qEvent(q, ev));
      expect(out.length).toBeGreaterThan(0);
      for (const id of out) expect(back(id)[0]).toBe("mac");
    }
  });
  test("a scan event qualifies its repos", () => {
    const scan = { root: "/x", repos: [repo], sources: [], scannedAt: 1, backend: { openers: false, sshHost: null } } as unknown as ScanResult;
    const out = qEvent(q, { type: "scan", result: scan });
    expect(out.type === "scan" && out.result.repos[0]?.id).toBe("mac|a/b");
  });
  test("events keyed by path or by name pass through", () => {
    for (const ev of [
      { type: "agents", agents: {} },
      { type: "launchers", launchers: {} },
      { type: "workspaces", workspaces: [] },
      { type: "helpers", helpers: [] },
      { type: "peers", seen: [] },
    ] as ServerEvent[]) {
      expect(qEvent(q, ev)).toBe(ev);
    }
  });
});

describe("mergeHistory", () => {
  const h = (days: number[]): RepoHistory => ({
    project: "p",
    sessions: 1,
    costUsd: 0,
    tokens: 0,
    commits: 0,
    first: null,
    last: null,
    days,
    daySessions: days,
  });
  const home: HistoryOverview = { available: true, days: ["2026-09-24", "2026-09-25", "2026-09-26"], maxDay: 5, fetchedAt: 1, repos: { a: h([1, 2, 3]) } };
  const mac: HistoryOverview = { available: true, days: ["2026-09-25", "2026-09-26", "2026-09-27"], maxDay: 9, fetchedAt: 2, repos: { "mac|a": h([7, 8, 9]) } };
  test("lines the others up on the first one's days", () => {
    const out = mergeHistory([home, mac]);
    expect(out?.available).toBe(true);
    if (!out?.available) return;
    expect(out.days).toEqual(home.days);
    expect(out.repos["a"]?.days).toEqual([1, 2, 3]);
    expect(out.repos["mac|a"]?.days).toEqual([0, 7, 8]);
    expect(out.repos["mac|a"]?.daySessions).toEqual([0, 7, 8]);
    expect(out.maxDay).toBe(9);
  });
  test("one overview is itself, none is null, unavailable ones step aside", () => {
    expect(mergeHistory([home])).toBe(home);
    expect(mergeHistory([])).toBeNull();
    const off: HistoryOverview = { available: false, reason: "x", fetchedAt: 1 };
    expect(mergeHistory([off])).toBe(off);
    expect(mergeHistory([off, mac])?.available).toBe(true);
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `bun test ui/src/qualify.test.ts`
Expected: FAIL, cannot find module `./qualify`.

- [ ] **Step 3: Write the module**

`ui/src/qualify.ts`:

```ts
import type {
  Device,
  Fleet,
  Flow,
  GrepRepoResult,
  HistoryOverview,
  Job,
  KeptShell,
  Repo,
  RepoHistory,
  Run,
  ScanResult,
  ServerEvent,
  SourceState,
  TermInfo,
} from "../../src/core/types";

/* What one backend sends, with every id it minted given the backend's name
   (through `q`), so two backends' ids never meet. Pure; the api layer is
   the only caller outside the tests. Paths, names and settings maps keyed
   by path pass through: they belong to the backend and are kept per
   backend by the store. */

/** An id mapper: `qualify` with the registry and a backend filled in. */
export type Q = (id: string) => string;

export const qRepo = (q: Q, r: Repo): Repo => ({
  ...r,
  id: q(r.id),
  source: q(r.source),
  ...(r.forge?.clonedAs !== undefined ? { forge: { ...r.forge, clonedAs: q(r.forge.clonedAs) } } : {}),
});

export const qSource = (q: Q, s: SourceState): SourceState => ({ ...s, id: q(s.id) });

export const qScan = (q: Q, t: ScanResult): ScanResult => ({
  ...t,
  repos: t.repos.map((r) => qRepo(q, r)),
  sources: t.sources.map((s) => qSource(q, s)),
});

export const qRun = (q: Q, r: Run): Run => ({ ...r, id: q(r.id), repoId: q(r.repoId) });

export const qFlow = (q: Q, f: Flow): Flow => ({
  ...f,
  id: q(f.id),
  repoId: q(f.repoId),
  ...(f.fleetId !== undefined ? { fleetId: q(f.fleetId) } : {}),
  steps: f.steps.map((st) => (st.runId !== undefined ? { ...st, runId: q(st.runId) } : st)),
});

export const qFleet = (q: Q, f: Fleet): Fleet => ({
  ...f,
  id: q(f.id),
  repos: f.repos.map((r) => ({
    ...r,
    repoId: q(r.repoId),
    ...(r.flowId !== undefined ? { flowId: q(r.flowId) } : {}),
  })),
});

export const qJob = (q: Q, j: Job): Job => ({ ...j, id: q(j.id), repoId: q(j.repoId) });

export const qTerm = (q: Q, t: TermInfo): TermInfo => ({ ...t, id: q(t.id), repoId: q(t.repoId) });

export const qKept = (q: Q, k: KeptShell): KeptShell => ({ ...k, id: q(k.id), repoId: q(k.repoId) });

/** A device's id is the browser's own, the same on every backend; qualified,
 *  one browser on two backends is two rows, each with its backend's word. */
export const qDevice = (q: Q, d: Device): Device => ({ ...d, id: q(d.id) });

export const qHistory = (q: Q, h: HistoryOverview): HistoryOverview =>
  h.available ? { ...h, repos: Object.fromEntries(Object.entries(h.repos).map(([id, v]) => [q(id), v])) } : h;

export const qGrep = (q: Q, g: GrepRepoResult): GrepRepoResult => ({ ...g, repo: q(g.repo) });

export function qEvent(q: Q, ev: ServerEvent): ServerEvent {
  switch (ev.type) {
    case "repo":
      return { ...ev, repo: qRepo(q, ev.repo) };
    case "scan":
      return { ...ev, result: qScan(q, ev.result) };
    case "run":
      return { ...ev, run: qRun(q, ev.run) };
    case "flow":
      return { ...ev, flow: qFlow(q, ev.flow) };
    case "fleet":
      return { ...ev, fleet: qFleet(q, ev.fleet) };
    case "job":
      return { ...ev, job: qJob(q, ev.job) };
    case "run-gone":
    case "flow-gone":
    case "fleet-gone":
    case "job-gone":
      return { ...ev, id: q(ev.id) };
    case "builds":
      return { ...ev, repoId: q(ev.repoId) };
    case "terms":
      return { ...ev, terms: ev.terms.map((t) => qTerm(q, t)) };
    case "devices":
      return { ...ev, devices: ev.devices.map((d) => qDevice(q, d)) };
    case "kept":
      return { ...ev, kept: ev.kept.map((k) => qKept(q, k)) };
    case "workspaces":
    case "agents":
    case "launchers":
    case "helpers":
    case "peers":
    case "chan":
      return ev;
  }
}

type Available = Extract<HistoryOverview, { available: true }>;

/** Several backends' archive overviews as one, on the first available
 *  one's days: a day it does not cover drops out of the others' arrays and
 *  a day they lack is 0, so every ring on the board shares one strip. One
 *  overview is handed back as it is. */
export function mergeHistory(parts: readonly HistoryOverview[]): HistoryOverview | null {
  if (parts.length === 1) return parts[0] ?? null;
  const ok = parts.filter((p): p is Available => p.available);
  const base = ok[0];
  if (!base) return parts[0] ?? null;
  const at = new Map(base.days.map((d, i) => [d, i]));
  const align = (days: string[], vals: number[]): number[] => {
    const out = base.days.map(() => 0);
    days.forEach((d, i) => {
      const j = at.get(d);
      if (j !== undefined) out[j] = vals[i] ?? 0;
    });
    return out;
  };
  const repos: Record<string, RepoHistory> = {};
  let maxDay = 0;
  for (const p of ok) {
    maxDay = Math.max(maxDay, p.maxDay);
    for (const [id, h] of Object.entries(p.repos)) {
      repos[id] = p === base ? h : { ...h, days: align(p.days, h.days), daySessions: align(p.days, h.daySessions) };
    }
  }
  return { available: true, days: base.days, maxDay, repos, fetchedAt: base.fetchedAt };
}
```

- [ ] **Step 4: Run it to see it pass**

Run: `bun test ui/src/qualify.test.ts`
Expected: PASS. If `GrepRepoResult` needs more fields than `{ repo, hits, truncated }` in the test literal, add them from `src/core/types.ts` rather than casting.

- [ ] **Step 5: Gates and commit**

```bash
git add ui/src/qualify.ts ui/src/qualify.test.ts
git commit -m "feat(ui): qualify every id a backend sends, merge archive overviews

Claude-Session: https://claude.ai/code/session_01HJpZzCB58kTqvUGjFAsR31"
```

---

### Task 3: the join (cards and checkouts)

**Files:**
- Create: `src/core/remote.ts` (moved out of `access.ts`)
- Modify: `src/core/access.ts` (re-export what moved)
- Create: `ui/src/checkouts.ts`
- Test: `ui/src/checkouts.test.ts`

**Interfaces:**
- Consumes: `split`, `Reg` (Task 1); `changedAt` from `ui/src/grouping.ts`.
- Produces: `src/core/remote.ts` exporting `RemoteRef`, `parseRemote`, `isGitHub`, `isSelfHosted`, `webUrl`; `ui/src/checkouts.ts` exporting `interface RepoCard { key: string; name: string; checkouts: Repo[] }`, `remoteKey(repo): string | null`, `joinRepos(repos, names, split): RepoCard[]`, `leadOf(card, pref, online, backendOf): Repo`, `cardChangedAt(card): number`.

- [ ] **Step 1: Move the pure remote helpers**

`webUrl` lives in `src/core/access.ts`, which imports `./exec` (Bun), so the browser cannot import it. Create `src/core/remote.ts` holding, moved verbatim with their doc comments, `RemoteRef`, `parseRemote`, `isGitHub`, `WEB_FORGES` (not exported), `isSelfHosted` and `webUrl`. It imports nothing. In `access.ts`, delete those definitions and add at the top:

```ts
import { isSelfHosted, parseRemote } from "./remote";
export { isGitHub, isSelfHosted, parseRemote, webUrl, type RemoteRef } from "./remote";
```

(import whatever else `access.ts` still uses from the moved code). No other file changes: every existing importer keeps importing from `./access`. Run `bun test src/core` and `bun run typecheck`; both pass unchanged.

- [ ] **Step 2: Write the failing test**

`ui/src/checkouts.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { split, type Reg } from "./backends";
import { cardChangedAt, joinRepos, leadOf, remoteKey } from "./checkouts";
import type { Repo } from "../../src/core/types";

const reg: Reg = { home: "mini", names: ["mini", "mac"] };
const sp = (id: string) => split(reg, id);
const backendOf = (id: string) => sp(id)[0];
const names = reg.names;

function repo(id: string, remotes: string[] = [], over: Partial<Repo> = {}): Repo {
  const plain = sp(id)[1];
  return { id, name: plain.slice(plain.lastIndexOf("/") + 1), path: `/x/${plain}`, group: "", source: "launch", status: null, remotes, ...over };
}

describe("remoteKey", () => {
  test("the first remote with a web page, lowercased", () => {
    expect(remoteKey(repo("a", ["mini:/Users/e/dev/a", "git@github.com:Eric-M3Max/Canopy.git"]))).toBe("github.com/eric-m3max/canopy");
  });
  test("peer remotes and a self-hosted ssh remote have none", () => {
    expect(remoteKey(repo("a", ["mac:/Users/e/dev/a", "ssh://git@forge.lan:2222/e/a.git"]))).toBeNull();
  });
});

describe("joinRepos", () => {
  test("one card for the same remote on two backends, in registry order", () => {
    const mac = repo("mac|dev/canopy", ["https://github.com/eric-M3Max/canopy"]);
    const mini = repo("dev/canopy", ["git@github.com:eric-M3Max/canopy.git"]);
    const cards = joinRepos([mac, mini], names, sp);
    expect(cards).toHaveLength(1);
    expect(cards[0]?.key).toBe("github.com/eric-m3max/canopy");
    expect(cards[0]?.name).toBe("canopy");
    expect(cards[0]?.checkouts).toEqual([mini, mac]);
  });
  test("peer-synced checkouts without a web remote meet on their plain id", () => {
    const cards = joinRepos([repo("x", ["mac:/Users/e/dev/x"]), repo("mac|x", ["mini:/home/e/dev/x"])], names, sp);
    expect(cards.map((c) => c.key)).toEqual(["rel:x"]);
    expect(cards[0]?.checkouts).toHaveLength(2);
  });
  test("a second checkout of one remote on one backend gets its own card", () => {
    const cards = joinRepos([repo("a", ["https://github.com/o/n"]), repo("b", ["https://github.com/o/n"])], names, sp);
    expect(cards.map((c) => c.key)).toEqual(["github.com/o/n", "github.com/o/n#b"]);
  });
  test("a single backend's repos come out one card each, in order", () => {
    const list = [repo("b"), repo("a", ["https://github.com/o/a"]), repo("c")];
    expect(joinRepos(list, ["mini"], (id) => ["mini", id]).map((c) => c.checkouts[0])).toEqual(list);
  });
  test("a forge-only repo never joins", () => {
    const forge = repo("f", ["https://github.com/o/n"], { forge: { clonedAs: "a" } as Repo["forge"] });
    const cards = joinRepos([repo("a", ["https://github.com/o/n"]), forge], names, sp);
    expect(cards.map((c) => c.key)).toEqual(["github.com/o/n", "forge:f"]);
  });
});

describe("leadOf and cardChangedAt", () => {
  const mini = repo("a", ["https://github.com/o/a"]);
  const mac = repo("mac|a", ["https://github.com/o/a"]);
  const card = joinRepos([mini, mac], names, sp)[0]!;
  test("the preferred backend when it is online", () => {
    expect(leadOf(card, "mac", () => true, backendOf)).toBe(mac);
  });
  test("the first online one when the preferred is not", () => {
    expect(leadOf(card, "mac", (b) => b === "mini", backendOf)).toBe(mini);
    expect(leadOf(card, undefined, (b) => b === "mac", backendOf)).toBe(mac);
  });
  test("the preferred, then the first, when none is online", () => {
    expect(leadOf(card, "mac", () => false, backendOf)).toBe(mac);
    expect(leadOf(card, undefined, () => false, backendOf)).toBe(mini);
  });
  test("a card changed when its newest checkout did", () => {
    const at = (n: number) => ({ branch: "main", files: [], ahead: 0, behind: 0, lastCommit: { at: n } }) as unknown as Repo["status"];
    const c = joinRepos([{ ...mini, status: at(10) }, { ...mac, status: at(30) }], names, sp)[0]!;
    expect(cardChangedAt(c)).toBe(30);
  });
});
```

- [ ] **Step 3: Run it to see it fail**

Run: `bun test ui/src/checkouts.test.ts`
Expected: FAIL, cannot find module `./checkouts`.

- [ ] **Step 4: Write the module**

`ui/src/checkouts.ts`:

```ts
import type { Repo } from "../../src/core/types";
import { webUrl } from "../../src/core/remote";
import { changedAt } from "./grouping";

/** One repo on the board, with every machine that has it checked out. */
export interface RepoCard {
  /** what ties its checkouts: the first remote with a web page as
   *  lowercase host/owner/name, `rel:<plain id>` without one, `forge:<id>`
   *  for a repo that lives only on a forge; `#<plain id>` after it for a
   *  second checkout on one backend */
  key: string;
  name: string;
  /** at most one per backend, in the registry's order; never empty */
  checkouts: Repo[];
}

/** A repo's first remote that maps to a web page, as lowercase
 *  host/owner/name. A peer remote is an ssh alias and never maps. */
export function remoteKey(repo: Repo): string | null {
  for (const url of repo.remotes ?? []) {
    const web = webUrl(url);
    if (!web) continue;
    const u = new URL(web);
    return `${u.host}${u.pathname}`.toLowerCase();
  }
  return null;
}

/** Every repo as a card, checkouts of one repo on different backends on
 *  one card. A second checkout on a backend that already has one on the
 *  card gets its own, so one backend's board is one card per repo, in the
 *  order given. */
export function joinRepos(
  repos: readonly Repo[],
  names: readonly string[],
  split: (id: string) => [string, string],
): RepoCard[] {
  const rank = (r: Repo): number => {
    const i = names.indexOf(split(r.id)[0]);
    return i < 0 ? names.length : i;
  };
  const byKey = new Map<string, RepoCard>();
  const out: RepoCard[] = [];
  for (const r of [...repos].sort((a, b) => rank(a) - rank(b))) {
    const [backend, plain] = split(r.id);
    let key = r.forge ? `forge:${r.id}` : (remoteKey(r) ?? `rel:${plain}`);
    if (byKey.get(key)?.checkouts.some((c) => split(c.id)[0] === backend)) key = `${key}#${plain}`;
    let card = byKey.get(key);
    if (!card) {
      card = { key, name: r.name, checkouts: [] };
      byKey.set(key, card);
      out.push(card);
    }
    card.checkouts.push(r);
  }
  return out;
}

/** The checkout a card shows and opens: the one last used for it while
 *  its backend is online, else the first online one, else the last used,
 *  else the first. */
export function leadOf(
  card: RepoCard,
  pref: string | undefined,
  online: (backend: string) => boolean,
  backendOf: (id: string) => string,
): Repo {
  const on = (c: Repo) => online(backendOf(c.id));
  const mine = (c: Repo) => backendOf(c.id) === pref;
  return (
    card.checkouts.find((c) => mine(c) && on(c)) ??
    card.checkouts.find(on) ??
    card.checkouts.find(mine) ??
    (card.checkouts[0] as Repo)
  );
}

/** When anything on the card last changed: its newest checkout's change. */
export const cardChangedAt = (card: RepoCard): number => Math.max(0, ...card.checkouts.map(changedAt));
```

- [ ] **Step 5: Run it to see it pass**

Run: `bun test ui/src/checkouts.test.ts src/core`
Expected: PASS.

- [ ] **Step 6: Gates and commit**

```bash
git add src/core/remote.ts src/core/access.ts ui/src/checkouts.ts ui/src/checkouts.test.ts
git commit -m "feat(ui): join checkouts of one repo into a card

Claude-Session: https://claude.ai/code/session_01HJpZzCB58kTqvUGjFAsR31"
```

---

### Task 4: the registry and a routed api

**Files:**
- Create: `ui/src/registry.ts`
- Modify: `ui/src/api.ts` (whole file: every method routes by id or takes a backend)
- Test: `ui/src/api.test.ts` (extend), create `src/server/multi.test.ts`

**Interfaces:**
- Consumes: Tasks 1 and 2.
- Produces:
  - `ui/src/registry.ts`: `setRegistry(home: string, names: string[]): void`, `setBase(name: string, base: string): void`, `registry(): Reg`, `homeName(): string`, `backendNames(): readonly string[]`, `backendOf(id): string`, `plainOf(id): string`, `qual(backend, id): string`, `baseOf(backend): string` (`""` for a backend with no base set, which is the page's own origin), `isHome(id): boolean`.
  - `ui/src/api.ts`: every existing method keeps its name and its existing leading parameters; methods that answer for a whole backend take an optional trailing `b = homeName()`; `api.backends()`; `api.startFleet` returns `Promise<Fleet[]>`; `onBackendSignal(fn: (backend: string, sig: BackendSignal) => void): void`; `resolveBase(entry, pageOrigin, entries): Promise<string | null>`; `subscribe(b, onEvent, onReconnect?, who?)`; `readFrame(b, data): ServerEvent | null`; `socketUrl(b, path): string`.

The module `ui/src/registry.ts` in full:

```ts
import { qualify, split, type Reg } from "./backends";

/* Which backends this page talks to and at what base URL. Module state, set
   once by the store's init (and changed when a backend is hidden or shown);
   until then everything is home and every base is the page's own origin. */

let reg: Reg = { home: "", names: [""] };
const bases = new Map<string, string>();

export function setRegistry(home: string, names: string[]): void {
  reg = { home, names: names.includes(home) ? names : [home, ...names] };
}

/** A backend's base URL, "" for the page's own origin. */
export function setBase(name: string, base: string): void {
  bases.set(name, base.replace(/\/+$/, ""));
}

export const registry = (): Reg => reg;
export const homeName = (): string => reg.home;
export const backendNames = (): readonly string[] => reg.names;
export const backendOf = (id: string): string => split(reg, id)[0];
export const plainOf = (id: string): string => split(reg, id)[1];
export const qual = (backend: string, id: string): string => qualify(reg, backend, id);
export const baseOf = (backend: string): string => bases.get(backend) ?? "";
export const isHome = (id: string): boolean => backendOf(id) === reg.home;
```

What `api.ts` must do (read the whole current file first; every method below keeps its current URL and body):

1. **`req`** becomes `req<T>(b: string, path: string, init?: RequestInit): Promise<T>`. It fetches `baseOf(b) + path`, with `credentials: "include"` when the base is not empty (another origin; the gate's cookie must ride along) and the default otherwise. It sets `Content-Type: application/json` only when `init.body` is a string and `init.headers` is not given, so a GET is a simple request with no preflight (`pasteImage` and `chanPut` keep their own headers). It keeps today's defensive JSON parsing and error messages. Signals, through the hook `onBackendSignal` registers (one listener; a no-op until set):
   - `fetch` throws (network error, CORS refusal): signal `{ kind: "unreachable", reason: "<b> did not answer" }`, then throw `new Error(\`${b} did not answer\`)`.
   - status 401 and the body parses with a string `login`: signal `{ kind: "signin", login }`, then throw with the body's `error`.
   - anything else: signal `{ kind: "answered" }`, then return or throw as today.
2. **Ids out.** A method whose first argument is a repo, run, flow, fleet, job or shell id does `const [b, id] = split(registry(), arg)` and sends the plain `id` to `b`. `resumeClaude(repoId, term, …)` sends `plainOf(term)`. `removeSource(id)`/`rescanSource(id)` route by the source id (sources are qualified like repos).
3. **Ids in.** Every answer that carries ids is qualified for the backend it came from before it is returned, through Task 2's helpers with `q = (id) => qual(b, id)`. When `b === homeName()` return the answer as it came (skip the mapping, so a home answer is the same object shape it always was). The ones that need it: `tree`, `rescan`, `addSource`, `removeSource`, `rescanSource`, `sources` (`qSource`), `stage` and `peerAction` (`qRepo`, keeping the `take` field), `history` (`qHistory`), `terms`, `kept` (its `kept` list), `restoreShell`, `resumeClaude` (`qTerm`), `runs`, `run`, `answerRun`, `stopRun`, `say` (`qRun`), `flows`, `startFlow`, `resumeFlow`, `stopFlow` (`qFlow`), `fleets`, `stopFleet` (`qFleet`), `jobs`, `install`, `build`, `stopJob` (`qJob`), `devices` (`qDevice`), `grep` (no ids), `grepAll` (`qGrep`).
4. **Whole-backend reads** take an optional trailing `b: string = homeName()`: `tree`, `rescan`, `sources`, `addSource(input, b)`, `hosts`, `browse(path, host?, b)`, `agents`, `history(refresh, b)`, `terms`, `kept`, `setKeeping(on, b)`, `runs`, `flows`, `fleets`, `jobs`, `verdict`, `about`, `client`, `helpers`, `devices`, `launchers`, `peers`. New: `backends: () => req<{ self: string | null; backends: BackendEntry[] }>(homeName(), "/api/backends")`.
5. **Home only**, no backend parameter: `workspaces`, `wsAdd`, `wsRemove`, `wsOpen`, `tailchan`, `chanRead`, `chanSend`, `chanPut`, `chanNotify`, `ports`, `preview`, and `chanBlobUrl` (stays relative).
6. **Fan-out.** `grepAll(q, ids)` groups the ids by backend, sends one `POST /api/grep` per backend with that backend's plain ids, qualifies each row, and answers one row per id in the order given; a backend whose call fails answers `{ repo: id, hits: [], truncated: false, error: <message> }` for each of its ids (match the real `GrepRepoResult` field names). `startFleet(workflow, ids, note)` does the same grouping and answers `Fleet[]`, one per backend, in registry order.
7. **`resolveBase(entry, pageOrigin, entries)`**: `pickUrl`; no `first` → `null`; `first` with no `fallback` → `first`; else probe `first + "/api/about"` with `credentials: "include"` and `AbortSignal.timeout(3000)`, and answer `first` when any response comes back, else `fallback`.
8. **`subscribe(b, onEvent, onReconnect?, who?)`**: as today, but the URL is `baseOf(b) + "/api/events?…"`, the `EventSource` is opened with `{ withCredentials: baseOf(b) !== "" }`, `onopen` signals `stream-open`, `onerror` signals `stream-lost` (both through the same hook, for `b`), and each frame goes through `readFrame(b, data)` (exported: `JSON.parse`, then `qEvent` with `b`'s mapper; `null` for a malformed frame; the home backend's frames come back unmapped).
9. **`socketUrl(b, path)`**: `wsUrl(baseOf(b), location, path)`.

Tests:

- [ ] **Step 1: Unit tests in `ui/src/api.test.ts`** (keep the existing `streamAction` tests). Stub `globalThis.fetch` (restore it in `afterEach`, the way `store.test.ts` does) and set a registry of `home: "a"`, names `["a", "b"]`, `setBase("b", "http://b.test")`. Assert:
  - `api.log("b|x/y")` fetches `http://b.test/api/repos/log?id=x%2Fy` with `credentials: "include"` and no `Content-Type` header; `api.log("x/y")` fetches the relative `/api/repos/log?id=x%2Fy`.
  - `api.runs("b")` answers runs whose `id` and `repoId` carry `b|`; `api.runs()` answers the home runs untouched.
  - `api.stage("b|x", "f", false)` posts to `http://b.test/api/repos/stage?id=x` with `Content-Type: application/json` and answers a repo with id `b|x`.
  - `api.grepAll("q", ["x", "b|y", "z"])` makes two requests (one per backend, bodies `{"q":"q","ids":["x","z"]}` and `{"q":"q","ids":["y"]}`) and answers rows for `x`, `b|y`, `z` in that order; when b's request throws, b's row carries `error` and the others do not.
  - `api.startFleet("w", ["x", "b|y"], "")` answers two fleets, the second's id and repo ids qualified.
  - a thrown fetch signals `unreachable` for that backend; a 401 with `{"error":"unauthorized","login":"https://x/login"}` signals `signin`; a 404 signals `answered`.
  - `readFrame("b", JSON.stringify({ type: "run-gone", id: "r" }))` is `{ type: "run-gone", id: "b|r" }`; `readFrame("b", "nope")` is `null`.

- [ ] **Step 2: Two real backends, `src/server/multi.test.ts`.** Model the setup on `src/server/term.test.ts` (scratch roots, `CANOPY_CONFIG_DIR`, `startServer({ root, port: 0 })`, the same tmux or pty env it uses). Make two scratch roots each holding a repo at the same relative path `proj` whose `origin` is the same `https://github.com/o/proj`, and a second repo only in B. Start server A and server B. Set the registry to home `a` with names `["a", "b"]`, `setBase("a", "http://127.0.0.1:<A>")`, `setBase("b", "http://127.0.0.1:<B>")`. Then assert:
  - `api.tree("a")` has `proj`; `api.tree("b")` has `b|proj` and the B-only repo qualified.
  - `joinRepos([...a.repos, ...b.repos], ["a", "b"], (id) => split(registry(), id))` has one card whose checkouts are `proj` and `b|proj`, and a card for the B-only repo.
  - `api.log("b|proj")` answers B's log (commit a distinguishable message in B's repo and check for it), `api.stage("b|proj", <an untracked file>, false)` answers a repo with id `b|proj` whose status shows the file staged.
  - `api.terms("b")` is empty; open a `WebSocket` to `socketUrl("b", "/api/term?" + new URLSearchParams({ id: "proj", term: <32 hex>, place: "strip", cols: "80", rows: "24" }))`, wait for the first binary frame, then `api.terms("b")` lists one shell with id `b|<the hex>` and `api.terms("a")` lists none. End it with `api.endTerm("b|<the hex>")`.
  - Event routing: read B's `/api/events` with `fetch` (Bun has no `EventSource`), trigger `api.rescan("b")`, read `data:` lines until a `scan` frame arrives, and check `readFrame("b", line)` names `b|proj`.
  - Stop both servers in `afterAll`.

- [ ] **Step 3: Write `registry.ts` and rewrite `api.ts` as above.** Run `bun test ui/src/api.test.ts src/server/multi.test.ts`, then all four gates. `ui/src/store.test.ts` must pass without edits: its relative-URL assertions are the proof that home requests are unchanged.

- [ ] **Step 4: Commit**

```bash
git add ui/src/registry.ts ui/src/api.ts ui/src/api.test.ts src/server/multi.test.ts
git commit -m "feat(ui): route every api call to its backend and qualify what comes back

Claude-Session: https://claude.ai/code/session_01HJpZzCB58kTqvUGjFAsR31"
```

The store and components still call the api the old way after this task (they pass bare ids and no backend), which is exactly the home path, so the app works unchanged. If a call site no longer typechecks (`startFleet` now answers an array; `subscribe` now takes a backend first), make the smallest change that keeps today's behaviour (`subscribe(homeName(), …)`, open the first fleet's sheet); Task 5 does the real work.

---

### Task 5: the store holds every backend

**Files:**
- Modify: `ui/src/store.ts`, `ui/src/settings.ts`, `ui/src/feed.ts` (only as the new `from` argument needs), `ui/src/peers.ts` (`peerable` through `isLaunchSource`), `ui/src/term.ts` (a `termFor(backend)` minting helper if cleaner)
- Test: `ui/src/store.test.ts` (new `describe` blocks only; existing tests untouched), `ui/src/peers.test.ts` (one case), `ui/src/settings.test.ts` (new fields)

**Interfaces:**
- Consumes: Tasks 1, 2, 4.
- Produces, for Tasks 6 and 7:
  - `interface Conn { name: string; base: string; status: BackendStatus; about: About | null; backend: Backend; client: ClientInfo; helpers: HelperInfo[]; keeping: boolean; peerSync: PeerSync }` exported from `store.ts`.
  - State: `conns: Record<string, Conn>` (every backend in the registry, home among them), `home: string`, `backendOrder: string[]` (the registry's names, hidden ones left out), `agents: Record<string, Record<string, AgentSettings>>` and `launchers: Record<string, Record<string, LaunchSettings>>` keyed by backend then path, `histories: Record<string, HistoryOverview>` with `history` the `mergeHistory` of them in registry order, `parkedTerms: TermTab[]`, `checkoutPref: Record<string, string>` (card key → backend name, persisted in the layout).
  - The top-level `backend`, `client`, `helpers` and `keeping` fields are removed; their readers use `connOf(s, name)`. Selectors: `connOf(s, name = s.home): Conn`, `homeConn(s)`, `isOnline(s, name): boolean`, `capsFor(s, name = s.home)`, `helperFor(s, name = s.home)`, `agentFor(s, repo)` and `launchFor(s, repo)` reading the repo's backend's map, `multi(s): boolean` (more than one backend in `backendOrder`).
  - Actions: `applyEvent(ev, from = home)`, `connect(name)` (load and subscribe one non-home backend), `retryBackend(name)`, `hideBackend(name, hidden: boolean)`, `setCheckoutPref(key, backend)`, `setKeeping(on, backend = home)`, `addSource(input, backend = home)`.
  - Settings: `backends: BackendEntry[]` (the cached registry) and `hiddenBackends: string[]`, validated in `loadSettings` like the other fields.

What changes, in order:

1. **Registry first.** `init` starts with `api.backends()` (a failure, from a server too old to have the route, means a registry of the home backend alone under the name `"home"`). Home is `self ?? "home"`; the names are the entries' names in order, home first if the answer left it out, minus `settings.hiddenBackends` (never hiding home). Call `setRegistry`, store `backends` in settings, set `home`, `backendOrder` and a `Conn` per name (`status: { state: "connecting" }` for the others, `online` for home once its load lands). Register `onBackendSignal` to fold each signal into `conns[name].status` through `backendState`, setting state only when the returned object is a new one.
2. **Home loads as today.** Keep the existing `Promise.all` and its all-or-nothing `loadError` for home; its answers now land in `conns[home]` (backend from the tree, client, helpers, keeping), `agents[home]`, `launchers[home]`. Home's shell tabs reconcile exactly as now, but only the saved tabs whose id is home's (`isHome(t.id)`); every other saved tab goes into `parkedTerms`.
3. **Every other backend connects after home.** For each non-home name, `connect(name)`: `resolveBase(entry, location.origin, backends)` (when `null`, mark it offline with the reason "no URL this page can use" and stop), `setBase`, then the same reads home makes (tree, runs, flows, fleets, jobs, agents, launchers, terms, kept, client, helpers, devices, about, verdict is home only) with `name` as the backend. A failure marks it offline (the signal hook already did) and leaves a retry to `retryBackend`. On success merge each into state through `sliceIn` (repos, sources, shells, kept, devices; runs, flows, fleets, jobs are records, so add that backend's entries after dropping its old ones), then move its parked tabs in through `reconcileTerms(parkedOf(name), heldOf(name), reposOf(name), panels, hidden)` and drop them from `parkedTerms`. Then `subscribe(name, (ev) => get().applyEvent(ev, name), onReconnect, identity(...))`, with an `onReconnect` that re-reads that backend's slice the way home's does. Load its history into `histories[name]` and recompute `history`. Keep each backend's unsubscribe in a module `Map` so `hideBackend` and the init's returned cleanup close them all.
4. **`applyEvent(ev, from = home)`.** `repo`, `run`, `flow`, `fleet`, `job` and the `*-gone` events work on the merged records as now (their ids are already qualified). The whole-list events replace only `from`'s part: `scan` (repos and sources through `sliceIn`; `root` only for home; `conns[from].backend`), `terms` (shells through `sliceIn`, then `adoptTerms` over the merged list), `devices`, `kept`, `helpers` (`conns[from].helpers`), `agents` and `launchers` (`agents[from]`), and `peers` (home's `peerSeen`; `conns[from].peerSync` through a per-backend `readPeers`). `workspaces` and `chan` apply only when `from` is home. The feed: pass `describeEvent` the state as `from` saw it (repos and sources filtered to `from`'s) and `agents[from]`, so a scan from one backend does not read the other's repos as gone. `treeState(s, tree, from)` prunes only `from`'s panels, widths, heights and folds: extend `pruneByRepo(map, repos, mine?)` with an optional predicate so keys of other backends are kept.
5. **Parked tabs are saved.** `layoutOf(s).terms` is `[...s.terms, ...s.parkedTerms]`, so a backend that is offline at load keeps its tabs in the saved layout until it answers. Panels whose backend has not loaded stay in `panels` (a home scan never prunes them).
6. **Per-backend reads.** `agentFor(s, repo)` is `s.agents[backendOf(repo.id)]?.[repo.path] ?? DEFAULT_AGENT`; the same for `launchFor`. `setAgent`/`setLaunch` store the answered map under the repo's backend. `capsFor(s, name)` is `clientCaps(conn.client, conn.helpers, s.settings.helper)` for that conn; `openApp(id, app)` passes `helperFor(s, backendOf(id))`. `setKeeping(on, backend)` writes `conns[backend].keeping`.
7. **Shells on another backend.** Every place that mints a shell id for a repo (`openTerm`, `resumeClaude`, and any other `termId()` caller) uses `qual(backendOf(repoId), termId())`. `endedShells`, `hiddenTerms` and `skipped` hold qualified ids unchanged.
8. **Fleets.** `startFleet` takes the `Fleet[]` answer, stores each, and shows the first.
9. **Hiding a backend.** `hideBackend(name, true)` closes its stream, drops its repos, sources, shells, kept, devices, runs, flows, fleets, jobs, agents, launchers and history from state, drops its tabs from `terms` (they stay in the saved layout through `parkedTerms`), writes `settings.hiddenBackends`, and calls `setRegistry` without it. `hideBackend(name, false)` undoes that and calls `connect(name)`. Home cannot be hidden.
10. **`peerable`** in `ui/src/peers.ts` uses `isLaunchSource(repo.source)` in place of `repo.source === LAUNCH_SOURCE`; add a test that a repo whose source is `mac|launch` is peerable.

Tests (new `describe` blocks in `ui/src/store.test.ts`; do not touch the existing ones). Stub `fetch` by URL: relative URLs are home `a`, `http://b.test/...` is backend `b`. `/api/backends` answers `{ self: "a", backends: [{ name: "a", tailnet: "http://a.test" }, { name: "b", tailnet: "http://b.test" }] }`. Stub `globalThis.EventSource` with a small fake class that records its URL and options (Bun has none) and restore it after. Under `bun test` there is no `location`: `init` uses `globalThis.location?.origin ?? "http://localhost"` as the page origin, which makes `pickUrl` choose `http://b.test` with no fallback and no probe. Each test resets the store (`useStore.setState`) and the registry.

- [ ] **Step 1: Write these tests, run them to see them fail.**
  - A registry of one (`/api/backends` answers `self: "a"` and `backends: []`): `init` makes no request to any absolute URL, `conns` has only `a`, `multi` is false, and one `EventSource` was opened, on the relative `/api/events…` URL with no `withCredentials`.
  - Two backends: after `init`, `repos` holds home's `proj` and `b|proj`, `runs` holds home's and b's under distinct ids, two event sources are open (b's with `withCredentials: true` and URL `http://b.test/api/events…`).
  - `applyEvent({ type: "repo", repo: { …, id: "b|proj" } }, "b")` changes b's checkout and leaves home's `proj` object untouched (`toBe` the old one).
  - `applyEvent({ type: "scan", result: <b's scan without proj> }, "b")` with the panels `["proj", "b|proj"]` open drops only `b|proj`.
  - A home scan while b has not loaded yet (b's fetches never resolve) keeps a saved `b|x` panel and keeps a saved b shell tab in the saved layout (read `localStorage` or `layoutOf`).
  - b's fetch throwing marks `conns.b.status.state` `offline`; a 401 with a `login` marks it `signin`; home stays `online`.
  - `agentFor` reads the repo's own backend's map (the same path set differently on `a` and `b` gives each repo its own).
  - `openTerm("b|proj")` makes a tab whose id starts `b|` and whose `repoId` is `b|proj`.
- [ ] **Step 2: Implement. Run `bun test ui/src`; the new tests pass and every existing test passes unedited.**
- [ ] **Step 3: Fix every reader of the removed fields** (`s.backend`, `s.client`, `s.helpers`, `s.keeping` in components: `Settings.tsx`, `TopBar.tsx`, `RepoMenu.tsx`, `Dock.tsx`, `Devices.tsx`, and any other `grep` finds) to read `homeConn(s)` for now, keeping today's behaviour; Tasks 6 and 7 make them per backend. Run all four gates.
- [ ] **Step 4: Commit**

```bash
git add ui/src
git commit -m "feat(ui): the store connects to every backend and keeps each one's slice

Claude-Session: https://claude.ai/code/session_01HJpZzCB58kTqvUGjFAsR31"
```

---

### Task 6: cards, the machine strip and the panel's machines

**Files:**
- Modify: `ui/src/store.ts` (selectors), `ui/src/grouping.ts`, `ui/src/filters.ts`, `ui/src/components/RepoGrid.tsx`, `ui/src/components/Sidebar.tsx`, `ui/src/components/Dock.tsx`, `ui/src/components/RepoMenu.tsx`, `ui/src/components/TermDock.tsx`, `ui/src/components/Solo.tsx`, `ui/src/components/Search.tsx`, `ui/src/components/Preview.tsx` (only if the section gate lives there), `ui/src/routes.ts`, `ui/src/styles.css`
- Test: `ui/src/store.test.ts` (selectors), `ui/src/grouping.test.ts`, `ui/src/filters.test.ts`, `ui/src/routes.test.ts`

**Interfaces:**
- Consumes: Tasks 3 and 5.
- Produces: `visibleCards(s): RepoCard[]`, `cardOf(s, repoId): RepoCard | undefined`, `visibleRepos(s): Repo[]` (now the lead checkout of each visible card), `switchCheckout(fromId, toId)` action; `groupRepos(repos, mode, now?, at?)`.

1. **Cards in the store.** `allCards(s)` is `joinRepos(scopedRepos(s), s.backendOrder, (id) => split(registry(), id))`, memoized on the identity of `scopedRepos(s)`'s input (`s.repos`, `s.settings.forge`, `s.activeWs`, `s.workspaces`) and `s.backendOrder`, so the same state gives the same card objects. `scopedRepos` keeps only home checkouts while a workspace is active (spec amendment 8). `visibleCards(s)`: a card is in view when `applyQuery(card.checkouts, query).length > 0`, memoized on `allCards`' result and the query fields. `visibleRepos(s)` is `visibleCards(s).map(lead)` where `lead` is `leadOf(card, s.checkoutPref[card.key], (b) => isOnline(s, b), backendOf)`, memoized on the cards, `checkoutPref` and each backend's state, returning the same array while none of those change. With one backend every card has one checkout and `visibleRepos` holds exactly the repos it held before. Everything downstream that reads `visibleRepos` (select mode, search, the tree) now works over leads with no change.
2. **Text filter.** `applyQuery`'s text matches the plain id (the part after a foreign prefix): pass it a `plain` function, or strip in the store; a `mac|` prefix must never be what a search matches. Test it in `filters.test.ts`.
3. **Grouping by the card's time.** `groupRepos(repos, mode, now, at = changedAt)`: `recent` buckets and the `byChange` order use `at`. `RepoGrid` and `Sidebar` pass `(r) => cardChangedAt(cardOf(s, r.id))` when `multi(s)`. Test that `at` changes the bucket.
4. **The machine strip.** In `RepoCard` (`RepoGrid.tsx`), when `multi(s)`, a row of chips under the card's name, one per checkout in card order: the backend name, the dirty count when there is one, `↑n`/`↓n` when ahead or behind. The lead's chip is marked current. A backend that is not online greys its chip (`title` says its state and reason) and shows its last state. Clicking a chip opens that checkout's panel (`openRepo(checkout.id)`) and sets `checkoutPref[card.key]`; it does not bubble to the card. A card none of whose checkouts is online gets a dimmed class. The tree row in `Sidebar.tsx` shows the backend names as a short trailing word list when `multi(s)`.
5. **The panel's machines.** In `RepoPanel`'s head, right after `RepoLink`, when the repo's card has more than one checkout: a small segmented row of backend names; the current one marked; choosing another calls `switchCheckout(id, sibling.id)`, which replaces the id in `panels` and `activePanel` and sets `checkoutPref`. When the panel's backend is not online, a line under the head says `<name> is offline` (or `sign in to <name>` with the login link) and offers the online siblings. A panel whose repo is not in `repos` because its backend has not loaded renders a placeholder panel (head with the plain id and the backend's name, the state line, a close button) instead of nothing.
6. **Per-backend openers.** `RepoMenu` and `RepoPanel` gate openers with `capsFor(s, backendOf(repo.id))` and read `sshHost` and `openers` off `connOf(s, backendOf(repo.id)).backend` for the VS Code remote link and the launch section. `Search.tsx`'s open-at-line passes `helperFor(s, backendOf(row.repo))`. The preview section and the panel's Library link show only for a home repo (`isHome(repo.id)`).
7. **Names, never qualified ids.** Replace the raw-id print sites with the plain id (`plainOf`) plus the backend name when it is not home: the panel head (`Dock.tsx` `panel-name`), `DockTabs`' tab name, `Sidebar.tsx`'s `title`, the search sheet's row, `RunSheet.tsx`'s `sheet-repo`, `FlowSheet.tsx`'s flow header.
8. **Shells.** `socketUrl` in `TermDock.tsx` becomes `api`'s `socketUrl(backendOf(tab.id), "/api/term?" + q)` with `id: plainOf(tab.repoId)` and `term: plainOf(tab.id)` in the query. When a socket drops and the tab's backend is not online, write `[backend offline]` once to the terminal before the rejoin waits start; the rejoin loop is unchanged. `routes.ts`'s shell route accepts a term of `<name>|<32 hex>` as well as bare hex (a popped-out foreign shell): widen `TERM_ID` to `/^(?:[a-z0-9-]+\|)?[0-9a-f]{32}$/` and test both. `Solo.tsx`/`ShellSolo`: while the route's repo is not found and its backend is `connecting`, show the loading state rather than "not found".

Tests:

- [ ] **Step 1: Write the failing tests**: `visibleRepos` over two backends holding `proj` and `b|proj` answers one lead (home's while both online; b's after `setCheckoutPref(key, "b")`; home's again when b goes offline); calling `visibleRepos` and `visibleCards` twice on the same state returns the same array and the same card objects (`toBe`), and after an unrelated `set({ filter: s.filter })` too; with one backend `visibleRepos` equals the old `applyQuery(scopedRepos(s), …)` result element for element; `switchCheckout` swaps the id in `panels` and `activePanel`; the `groupRepos` `at` test; the text filter test; the route test.
- [ ] **Step 2: Implement, run `bun test ui/src`, then all four gates.**
- [ ] **Step 3: Look at it.** Start a second canopy on a scratch root and port (`CANOPY_CONFIG_DIR=<scratch> bun run bin/canopy.ts ui <scratch root> --port 7860 --no-open`, with that config's `backends` naming both it and a dev server) and the dev server on the real root with `CANOPY_ORIGINS` listing the dev page's origin; open the dev page in a browser (playwright-cli, per the project memory; never a file:// url) and check one card with two chips, the switcher, and a shell on the second backend. Report what you saw.
- [ ] **Step 4: Commit**

```bash
git add ui/src
git commit -m "feat(ui): one card per repo with a machine strip, and a machine switcher on the panel

Claude-Session: https://claude.ai/code/session_01HJpZzCB58kTqvUGjFAsR31"
```

---

### Task 7: the backends chip, Settings and the machine words

**Files:**
- Create: `ui/src/components/Backends.tsx`
- Modify: `ui/src/components/TopBar.tsx`, `ui/src/components/Settings.tsx`, `ui/src/components/Sources.tsx`, `ui/src/components/Shells.tsx`, `ui/src/components/KeptShells.tsx`, `ui/src/components/Devices.tsx`, `ui/src/components/FlowSheet.tsx`, `ui/src/components/Feed.tsx`, `ui/src/term.ts` (`otherShells`), `ui/src/styles.css`
- Test: `ui/src/term.test.ts` (`otherShells` with a machine word)

**Interfaces:**
- Consumes: Task 5's `conns`, `backendOrder`, `multi`, `retryBackend`, `hideBackend`, `setKeeping(on, backend)`, `addSource(input, backend)`; `sameBuild` from `src/core/version.ts`; `PAGE_BUILD` from `ui/src/build.ts`.

1. **`BackendsChip`** in `Backends.tsx`, modelled on `DevicesChip` in `Devices.tsx` (local `open`, `useFitPop`, outside click and Escape close, `.settings-pop`). Rendered in `TopBar` next to `PeersChip` only when `multi(s)`. The trigger shows one word per backend in `backendOrder`, rust (the `PeersChip` class for an offline peer) for any state but `online`. The popover lists every backend in the registry, hidden ones too: name, a state word (`connecting`, `online`, `offline`, `sign in`), the reason when offline, the URL in use (`base`, or "this page" for home), a version note when `about` is known and `!sameBuild(about, PAGE_BUILD)` ("another build", not an error), a `retry` button for a non-home backend not online (`retryBackend`), a `sign in` link for `signin` (`login` with `next` set to the backend's base URL: add `?next=` or `&next=` to the login URL, encoded), and a "show here" checkbox bound to `hideBackend` (disabled for home).
2. **Settings.** When `multi(s)`, a `Seg` at the top of `SettingsMenu` picks which backend the backend-scoped rows show, home first (component state, starting at home). The rows it scopes: desktop openers (that backend's helpers and `capsFor(s, name)`), keep shell history (`connOf(s, name).keeping`, `setKeeping(on, name)`), and `AboutRow` (`api.about(name)`). The per-browser rows are unchanged. With one backend nothing new shows.
3. **Sources.** `SourcesMenu` lists sources grouped under each backend's name when `multi(s)` (remove and rescan already route by the qualified source id), and the add form gets a backend `Seg` (home first) that `addSource(input, backend)`, `api.hosts(backend)` and `api.browse(path, host, backend)` use.
4. **Machine words in lists**, only when `multi(s)`, as a small `.machine` word after the repo name, never a qualified id: the shells picker rows (`Shells.tsx`), kept shells (`KeptShells.tsx`), a device's rows and "in a shell at" repos (`Devices.tsx`; "this browser" compares `plainOf(d.id)` with `clientId()`), fleet rows (`FlowSheet.tsx`), `otherShells`' labels in `term.ts` (take a `word(id)` parameter, default none, and test it), and the feed's source labels (`Feed.tsx` `labelOf`: a foreign source reads `<label> · <name>`).

- [ ] **Step 1: Test `otherShells` with a machine word, see it fail, implement it.**
- [ ] **Step 2: Build the chip, the Settings picker, the Sources grouping and the words. Run all four gates.**
- [ ] **Step 3: Look at it** the same way as Task 6 step 3: the chip with two words, one taken offline (stop the second server) goes rust and its checkouts grey, retry brings it back after restarting it, the Settings picker switches the about row between the two.
- [ ] **Step 4: Commit**

```bash
git add ui/src
git commit -m "feat(ui): backends chip, a backend picker in settings, machine words in lists

Claude-Session: https://claude.ai/code/session_01HJpZzCB58kTqvUGjFAsR31"
```

---

### Task 8: docs

**Files:**
- Modify: `CLAUDE.md`, `docs/deploy.md`, `README.md` (only if it lists features the way it does for other views)

Describe what plans 1 and 2 made, in the voice and density of the surrounding text (read the whole of `CLAUDE.md` first; it is one long paragraph per area): the registry (`GET /api/backends`, `ui/src/registry.ts`, `ui/src/backends.ts` with `pickUrl` and the public side, `backendState`), home ids bare and other ids `<name>|<id>` (only `api.ts` adds or strips), `ui/src/qualify.ts`, `ui/src/checkouts.ts` (`joinRepos`, `leadOf`, the card key rules), the store's `conns`, `applyEvent(ev, from)`, `parkedTerms`, `checkoutPref`, per-backend `agents`/`launchers`/`histories`, the machine strip, the panel switcher, `BackendsChip`, the Settings backend picker, what stays home-only (spec amendment 8), and `src/server/multi.test.ts`. In `docs/deploy.md`, add the origins each machine lists in `CANOPY_ORIGINS` (the mini adds `http://127.0.0.1:7850` and `http://localhost:7850` for the Mac's own page) and how to check the multi-backend page after a deploy.

- [ ] **Step 1: Edit the docs.**
- [ ] **Step 2: Commit**

```bash
git add CLAUDE.md docs/deploy.md README.md
git commit -m "docs: several backends on one page

Claude-Session: https://claude.ai/code/session_01HJpZzCB58kTqvUGjFAsR31"
```

---

## Rollout (the controller, after the final review)

1. Fast-forward `main` to the branch, run the four gates on `main`, `bun run build`.
2. Add `http://127.0.0.1:7850,http://localhost:7850` to the mini's `CANOPY_ORIGINS` in its `.env` (spec amendment 7).
3. `git push origin main`, then `bun run redeploy` for the mini (the shells container must not be recreated).
4. Reload the Mac's server: `launchctl kickstart -k gui/$UID/ca.beric.canopy-server`.
5. Verify: `~/.claude/skills/verify-build/clean-rebuild.sh verify checkoutPref` on the Mac and in the mini's container; `GET /api/backends` on both; in a browser, the Mac's `http://127.0.0.1:7850` and `https://canopy.beric.ca` each show one card with two machine chips for a repo both hold, and a shell opens on the other backend.
