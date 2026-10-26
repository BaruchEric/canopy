# Harness share: how much of the spend goes into canopy itself (FR-044)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Status:** planned 2026-10-26. Written on main at 1ac8fe7.

**Goal:** a repo can be marked as the harness; the costs view says what share of
the window's dollars and Claude sessions went into the harness repos, folds open
to eight weeks of plain CSS bars, turns rust past a per-browser threshold, and
puts one quiet line a week in the inbox when last week crossed it; `canopy costs`
prints the same sums and share from a terminal, and the ranger's brief carries
last week's figure.

**Architecture:** the mark is a path list in config beside favorites, linked
onto every `Repo` the same way and seeded once from canopy's own package name.
The sums the costs view already makes move from `ui/src` into `src/core`, so
the CLI and the ranger hub can share them, and `src/core/harnessshare.ts` adds
the pure share, the weeks and the words over them. The page keeps the threshold
and the said week per browser; no backend writes anything new but the mark.

**Tech Stack:** Bun, TypeScript strict, React 19, bun:test. No new
dependencies; no chart library.

**Spec:** `docs/superpowers/specs/2026-10-25-harness-share-design.md`, its
"Plans" list's one item. The index is
`docs/superpowers/specs/2026-10-25-software-factory-borrowings-design.md`.

## Global constraints

- The mark is `config.harness`, a path list beside `favorites` and `archived`, `null` until the first start seeds it; on the repo it is `Repo.harness?: true`; the route is `POST /api/repos/harness {harness: boolean}`, right `operate`.
- The seed marks a local repo whose root `package.json` is named `canopy`, once, only while `config.harness` is null.
- The card's menu item reads "counts as the harness", under "star".
- The threshold is the per-browser setting `harnessShareMax`, default 25, 5 to 90, 0 for off, in Settings' device tab as "harness share warning at __ %".
- The weeks are `WEEKS` (8) local weeks, Monday first, the newest partial, in dollars from the archive alone.
- The line reads `harness 23% of $41.20 · 31% of 48 sessions`; the percentage is rust at or over the threshold and moss under it; "—" when nothing was spent.
- The inbox line reads `last week 34% of Claude spend went into the harness (canopy, devhub)`, once per week key, the key kept in localStorage as `harnessSaid`.
- The bars are two spans with `width` set inline, `--moss` for rest, `--rust` for harness over the threshold and `--lichen` under it, under `.cost-share` in `styles.css`.
- The ranger's slot is `{{harnessShare}}`, filled as `34%, over the 25% line`.
- `canopy costs [--days 1|7|30] [--share]` reads every backend the home one lists, like `canopy health`.
- Every file the UI imports from `src/core/` stays browser-safe: no `node:` or `bun` import in `cards.ts`, `costsheet.ts`, `backendid.ts`, `historymerge.ts` or `harnessshare.ts`.
- Plain words, no em dashes, sentence case headings (the unslop rules apply to docs and commit messages).
- All four gates pass before a task is done: `bun run typecheck`, `bun run lint`, `bun test`, `bun run build`.

## Review focus

Inputs the spec implies and no section of it names. Each has a test in the task that owns the code.

1. A card with two checkouts where only one is marked counts as harness whole, so one repo never sits on both sides of the figure (Task 4).
2. A harness repo the archive does not map: its ledger dollars still count as harness and its sessions are 0, rather than the card dropping out of the figure (Task 4).
3. A `package.json` the seed cannot parse, or one without a name, is skipped and the seed still writes the list, so one broken file never leaves the config unseeded (Task 2).
4. A week key across the year boundary: `2027-01-01` is `2026-W53`, so the inbox's said key never repeats or skips at New Year (Task 4).
5. `--days` outside 1, 7 and 30 is refused with the usage line rather than passed to the backend (Task 11).

---

## File structure

- Modify `src/core/types.ts`: `Repo.harness`, `CanopyConfig.harness`.
- Modify `src/core/store.ts`: the default, the normalization, `setHarness`, `seedHarnessList`.
- Modify `src/core/favorite.ts` and `src/core/favorite.test.ts`: `linkHarness`.
- Modify `src/core/callers.ts` and `src/core/callers.test.ts`: `harness` among the repo operate actions.
- Modify `src/server/index.ts`: `state.harness`, `linkHarness` in `rebuildResult`, the route, `seedHarness`; create `src/server/harness.test.ts`.
- Create `src/core/cards.ts` (out of `ui/src/checkouts.ts`), `src/core/costsheet.ts` and `src/core/costsheet.test.ts` (out of `ui/src/costs.ts` and its test), `src/core/backendid.ts` (out of `ui/src/backends.ts`), `src/core/historymerge.ts` (out of `ui/src/qualify.ts`); the UI files re-export.
- Create `src/core/harnessshare.ts` and `src/core/harnessshare.test.ts`: the figure, the weeks, the words.
- Modify `src/core/history.ts` and `src/core/history.test.ts`, `src/server/index.ts` (the history cache and route), `ui/src/api.ts`: the 90-day window.
- Modify `ui/src/api.ts`, `ui/src/store.ts`, `ui/src/store.test.ts`, `ui/src/components/RepoMenu.tsx`: the page's mark.
- Modify `ui/src/settings.ts`, `ui/src/settings.test.ts`, `ui/src/components/Settings.tsx`: the threshold.
- Modify `ui/src/components/Costs.tsx`, `ui/src/styles.css`: the line and the table.
- Modify `ui/src/inbox.ts`, `ui/src/inbox.test.ts`, `ui/src/store.ts`, `ui/src/components/Inbox.tsx`: the weekly line.
- Modify `src/core/ranger.ts`, `src/core/ranger.test.ts`, `lib/ranger.md`, `src/server/ranger.ts`, `src/server/ranger.test.ts`, `src/server/index.ts`: the slot.
- Create `src/cli/costs.ts`, `src/cli/costs.test.ts`; modify `src/cli/health.ts`, `src/cli/index.ts`, `src/core/help.ts`, `README.md`.
- Modify `docs/architecture.md`, `SPEC.md`, `README.md`, `FEATURES.md`, `docs/superpowers/plans/README.md`.

---

### Task 1: the mark in core

**Files:**
- Modify: `src/core/types.ts:269-270` (`Repo.favorite`), `:640-641` (`CanopyConfig.favorites`); `src/core/store.ts:65-66` (the defaults), `:184-185` (the normalization), `:423-428` (after `setFavorite`); `src/core/favorite.ts`, `src/core/favorite.test.ts`; `src/core/callers.ts:42` (`REPO_OPERATE`), `src/core/callers.test.ts:61-63`

**Interfaces:**
- Consumes: `linkFavorites`, `setFavorite`, `withConfig` and `paths` as they are.
- Produces:

```ts
// src/core/types.ts, on Repo after favorite
/** set on a repo that counts as the harness, canopy itself (FR-044); not the
 *  agent harness (`Harness`) that runs in it */
harness?: true;
// on CanopyConfig after favorites
/** the repos that count as the harness, by path like favorites; null until
 *  the first start seeds it from canopy's own package name, after which the
 *  list, empty or not, is the user's */
harness: string[] | null;

// src/core/favorite.ts
/** `linkFavorites` for the harness mark: same object when a repo's mark did
 *  not move, the same array when none did. */
export function linkHarness(repos: Repo[], paths: ReadonlySet<string>): Repo[];

// src/core/store.ts
/** Marks or unmarks a repo as the harness by path. Returns every harness path. */
export async function setHarness(path: string, on: boolean): Promise<string[]>;
/** Writes the seed's list only while none has been written. Returns the list on disk. */
export async function seedHarnessList(paths: string[]): Promise<string[]>;
```

The default is `harness: null`; the normalization is `harness: Array.isArray(cfg.harness) ? paths(cfg.harness) : null`. `setHarness` starts from `[]` when the list is null. `REPO_OPERATE` gains `"harness"` after `"favorite"`, so `POST /api/repos/harness` needs `operate`.

- [ ] **Step 1: Write the failing tests**

In `src/core/favorite.test.ts`, beside the `linkFavorites` describe, importing `linkHarness` with it:

```ts
describe("linkHarness", () => {
  test("sets the mark on the paths given and clears it elsewhere", () => {
    const repos = [repo("a"), repo("b", { harness: true }), repo("c")];
    const out = linkHarness(repos, new Set(["/dev/a"]));
    expect(out.map((r) => r.harness)).toEqual([true, undefined, undefined]);
    expect("harness" in out[1]!).toBe(false);
    expect(out[2]).toBe(repos[2]!);
  });

  test("hands back the same array when nothing moved, and leaves the star alone", () => {
    const repos = [repo("a", { harness: true, favorite: true }), repo("b")];
    expect(linkHarness(repos, new Set(["/dev/a"]))).toBe(repos);
    expect(linkHarness(repos, new Set())[0]).toEqual(repo("a", { favorite: true }));
  });
});
```

In `src/core/callers.test.ts:61`, add `"harness"` to the operate list: `for (const a of ["run", "pull", "commit", "flow", "refresh", "harness"])`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test src/core/favorite.test.ts src/core/callers.test.ts`
Expected: FAIL (`linkHarness` is not exported; `/api/repos/harness` is not `operate`).

- [ ] **Step 3: Add the types, the store functions, `linkHarness` and the rule**

`linkHarness` is `linkFavorites` over `harness`; write it beside the star's, not as a generic over both, since the two fields have different comments to keep. Update the header comment of `favorite.ts`: "The star and the harness mark: both canopy's own, kept as path lists in the config and linked onto the scan's repos."

- [ ] **Step 4: Run the tests and typecheck**

Run: `bun test src/core/favorite.test.ts src/core/callers.test.ts src/core/store.test.ts && bun run typecheck`
Expected: PASS; typecheck clean (the only `CanopyConfig` literal is the defaults in `store.ts`).

- [ ] **Step 5: Commit**

```bash
git add src/core/types.ts src/core/store.ts src/core/favorite.ts src/core/favorite.test.ts src/core/callers.ts src/core/callers.test.ts
git commit -m "feat(harness): the harness mark in config and on the repo (FR-044)"
```

---

### Task 2: the route and the seed

**Files:**
- Modify: `src/server/index.ts:35` (the `linkFavorites` import), `:362` (`ServerState.favorites`), `:2233-2239` (`rebuildResult`), `:3951-3962` (after the favorite route), `:5054` (the state's `favorites`), `:5386-5387` (after the launch root check)
- Create: `src/server/harness.test.ts`

**Interfaces:**
- Consumes: Task 1's `linkHarness`, `setHarness`, `seedHarnessList`; `loadConfig`; `HttpError`, `json`, `broadcast`, `rebuildResult` as the favorite route uses them.
- Produces in `src/server/index.ts`:

```ts
/** the paths of the repos marked as the harness, kept in step with the
 *  config like `favorites` */
harness: Set<string>;   // on ServerState
/** At the first start with no list in the config: every local repo whose
 *  root package.json is named canopy counts as the harness. Writes the
 *  list, empty or not, so a later start never guesses. */
async function seedHarness(state: ServerState): Promise<void>;
```

Behaviour:
- The route sits with archive and favorite, ahead of the forge refusal (the mark is canopy's own): `POST /api/repos/harness?id=` with body `{harness}`; 400 `"harness must be true or false"` for anything but a boolean; `state.harness = new Set(await setHarness(repo.path, body.harness))`; the repo re-found by id, `linkHarness([now], state.harness)`, written back into `state.result.repos`, broadcast as a `repo` event and answered.
- `rebuildResult` wraps the chain once more: `linkHarness(linkFavorites(...), state.harness)`.
- `seedHarness`: `loadConfig()`; return when `cfg.harness !== null`; for each repo in `state.result.repos` with no `host` and no `forge`, read `join(r.path, "package.json")`, `JSON.parse` it, and keep the path when its `name` is `"canopy"`; a read or parse failure, or a file without a name, skips that repo. Then `state.harness = new Set(await seedHarnessList(found))` and `rebuildResult(state, state.result.repos)`, so the first `/api/tree` carries the marks. Called after the launch root check at `:5387`, before `listTerms`.

- [ ] **Step 1: Write the failing tests in `src/server/harness.test.ts`**

Modeled on `src/server/favorite.test.ts` (its header, scratch config dir, `url`, `tree`):

```ts
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../core/store";
import type { Repo } from "../core/types";
import { startServer } from "./index";

let scratch: string;
let root: string;
let server: { port: number; stop: () => void };
let saved: string | undefined;
const url = (p: string) => `http://127.0.0.1:${server.port}${p}`;
const mark = (id: string, body: unknown) => fetch(url(`/api/repos/harness?id=${id}`), { method: "POST", body: JSON.stringify(body) });
const tree = async () => ((await (await fetch(url("/api/tree"))).json()) as { repos: Repo[] }).repos;
const marked = async () => (await tree()).filter((r) => r.harness).map((r) => r.id).sort();

async function pkg(name: string, text: string): Promise<void> {
  await mkdir(join(root, name), { recursive: true });
  await writeFile(join(root, name, "package.json"), text);
  await Bun.$`git -C ${join(root, name)} init -q`.quiet();
}

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "canopy-harness-"));
  saved = process.env["CANOPY_CONFIG_DIR"];
  process.env["CANOPY_CONFIG_DIR"] = join(scratch, "config");
  root = join(scratch, "root");
  await pkg("app", '{"name":"app"}');
  await pkg("canopy", '{"name":"canopy"}');
  await pkg("broken", "not json");
  await pkg("nameless", "{}");
  server = await startServer({ root, port: 0 });
});

afterAll(async () => {
  server.stop();
  if (saved === undefined) delete process.env["CANOPY_CONFIG_DIR"];
  else process.env["CANOPY_CONFIG_DIR"] = saved;
  await rm(scratch, { recursive: true, force: true });
});

describe("the harness mark", () => {
  test("the first start marks canopy's own checkout, skips what it cannot read, and writes the list", async () => {
    expect(await marked()).toEqual(["canopy"]);
    expect((await loadConfig()).harness).toEqual([join(root, "canopy")]);
  });

  test("refuses a body without a boolean", async () => {
    expect((await mark("app", {})).status).toBe(400);
    expect((await mark("app", { harness: "yes" })).status).toBe(400);
  });

  test("marks a repo, keeps the mark across a rescan, and takes it off", async () => {
    const res = await mark("app", { harness: true });
    expect(res.status).toBe(200);
    expect(((await res.json()) as Repo).harness).toBe(true);
    await fetch(url("/api/rescan"), { method: "POST" });
    expect(await marked()).toEqual(["app", "canopy"]);
    expect(((await (await mark("canopy", { harness: false })).json()) as Repo).harness).toBeUndefined();
    await mark("app", { harness: false });
    expect(await marked()).toEqual([]);
    expect((await loadConfig()).harness).toEqual([]);
  });

  test("a later start never seeds again", async () => {
    server.stop();
    server = await startServer({ root, port: 0 });
    expect(await marked()).toEqual([]);
    expect((await loadConfig()).harness).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test src/server/harness.test.ts`
Expected: FAIL (nothing is marked; the route is unknown).

- [ ] **Step 3: Add the state, the route, the link and the seed**

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test src/server/harness.test.ts src/server/favorite.test.ts src/server/archive.test.ts && bun run typecheck`
Expected: PASS; typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/server/index.ts src/server/harness.test.ts
git commit -m "feat(harness): POST /api/repos/harness and the seed from canopy's package name"
```

---

### Task 3: the pure sums move to core

**Files:**
- Create: `src/core/cards.ts`, `src/core/costsheet.ts`, `src/core/costsheet.test.ts`, `src/core/backendid.ts`, `src/core/historymerge.ts`
- Modify: `ui/src/checkouts.ts:1-71`, `ui/src/backends.ts:1-33`, `ui/src/qualify.ts:208-240`, `ui/src/util.ts:35-45`, `ui/src/components/Costs.tsx:5`, `ui/src/costs.ts:1` (replace the moved implementation with re-exports)
- Delete: `ui/src/costs.test.ts` (moved)

**Interfaces:**
- Consumes: the existing exports and tests of `ui/src/checkouts.ts`, `ui/src/costs.ts`, `ui/src/backends.ts` and `ui/src/qualify.ts`, and the formatters in `ui/src/util.ts`. Their callers keep the same signatures through re-exports.
- Produces, every signature as it is today, in a new home:
  - `src/core/cards.ts`: `RepoCard`, `remoteKey`, `joinRepos` (from `ui/src/checkouts.ts:6-71`; `webUrl` comes from `./remote`).
  - `src/core/costsheet.ts`: everything `ui/src/costs.ts` exports (`COST_WINDOWS`, `CostWindow`, `ServedRow`, `CostLine`, `CostSheet`, `claudeByCard`, `ClaudeLead`, `claudeLeads`, `LeadSessions`, `sessionLines`, `costSheet`, `windowStart`, `usageWords`), with `RepoCard` from `./cards`, plus the two formatters out of `ui/src/util.ts:35-45`:

```ts
/** "$12.34", "$123" from a hundred up, "n/a" for none */
export function usdWord(n: number | null | undefined): string;
/** "1.2k", "3.4M", "1.20B" */
export function tokensWord(n: number): string;
```

  - `src/core/backendid.ts`: `SEP`, `Reg`, `qualify`, `split` (from `ui/src/backends.ts:8-33`).
  - `src/core/historymerge.ts`: `mergeHistory` (from `ui/src/qualify.ts:208-240`, with its `Available` type).
- The UI files keep every import working: `ui/src/checkouts.ts` ends its imports with `export { joinRepos, remoteKey, type RepoCard } from "../../src/core/cards";` and imports `RepoCard` for `leadOf`, `cardFavorite` and `cardChangedAt`; `ui/src/backends.ts` re-exports the four and imports what it still uses; `ui/src/qualify.ts` re-exports `mergeHistory`; `ui/src/util.ts` replaces the two bodies with `export { usdWord as usd, tokensWord as fmtTokens } from "../../src/core/costsheet";`. `Costs.tsx` imports from `"../../../src/core/costsheet"`.

- [ ] **Step 1: Move the files**

```bash
git mv ui/src/costs.ts src/core/costsheet.ts
git mv ui/src/costs.test.ts src/core/costsheet.test.ts
```

Fix the moved files' imports (`./costs` becomes `./costsheet`; `../../src/core/costs` becomes `./costs`; `../../src/core/types` becomes `./types`; `./checkouts` becomes `./cards`). The header comment of `costsheet.ts` says: pure and browser-safe; the costs view, `canopy costs` and the harness share import it.

- [ ] **Step 2: Cut `cards.ts`, `backendid.ts` and `historymerge.ts` out of the UI files, and add the re-exports**

Recreate `ui/src/costs.ts` as `export * from "../../src/core/costsheet";` after the move. Existing callers of the UI path keep working, including other plans written against that file. The implementation and its tests have one home in core.

- [ ] **Step 3: Run the moved and the neighbouring tests, then every gate**

Run: `bun test src/core/costsheet.test.ts ui/src/checkouts.test.ts ui/src/backends.test.ts ui/src/qualify.test.ts ui/src/store.test.ts && bun run typecheck && bun run lint && bun test && bun run build`
Expected: PASS, clean, built. Nothing in `src/core/cards.ts`, `costsheet.ts`, `backendid.ts` or `historymerge.ts` imports from `ui/` or from `node:`.

- [ ] **Step 4: Commit**

```bash
git add -A src/core/cards.ts src/core/costsheet.ts src/core/costsheet.test.ts src/core/backendid.ts src/core/historymerge.ts ui/src/checkouts.ts ui/src/backends.ts ui/src/qualify.ts ui/src/util.ts ui/src/components/Costs.tsx ui/src/costs.ts ui/src/costs.test.ts
git commit -m "refactor(costs): the cost sums, the cards, the backend ids and the history merge move to core"
```

---

### Task 4: the figure and the weeks

**Files:**
- Create: `src/core/harnessshare.ts`, `src/core/harnessshare.test.ts`

**Interfaces:**
- Consumes: `RepoCard` from `./cards`; `CostSheet` from `./costsheet`; `HistoryOverview`, `Repo` from `./types`.
- Produces in `src/core/harnessshare.ts`:

```ts
/** the weeks the table shows */
export const WEEKS = 8;
/** the warning line, percent: Yegge's own figure rounded; the page's
 *  setting overrides it per browser, the CLI and the ranger use it as is */
export const HARNESS_SHARE_MAX = 25;

export interface HarnessShare {
  /** dollars, reported plus estimated, in the window */
  usd: { harness: number; rest: number };
  /** Claude sessions started in the window, from the archive */
  sessions: { harness: number; rest: number };
  /** usd share, 0 to 1; null when nothing was spent */
  share: number | null;
  /** sessions share, the same */
  sessionShare: number | null;
}
export interface HarnessWeek {
  /** the week's Monday, YYYY-MM-DD */
  from: string;
  harness: number;
  rest: number;
  /** harness over both, 0 to 1; null with nothing spent that week */
  share: number | null;
}

/** a card is the harness when any of its checkouts is marked */
export const isHarnessCard = (card: Pick<RepoCard, "checkouts">): boolean;
/** the harness cards' names, in card order */
export function harnessNames(cards: readonly RepoCard[]): string[];
/** one card per repo, keyed by its id: a backend's own repos over its own overview */
export function cardsOf(repos: readonly Repo[]): RepoCard[];
/** the window's share: the sheet's repo lines by their card, est with usd;
 *  a line with no harness card (no repo, a name the page has no card for)
 *  is rest; sessions from `daySessions` over the window's last `days`,
 *  each card taking the checkout with the most */
export function harnessShare(sheet: Pick<CostSheet, "repos">, history: HistoryOverview | null, days: number, cards: readonly RepoCard[]): HarnessShare;
/** the archive's dollars folded into local weeks, Monday first, oldest
 *  first, the newest last and partial; each card takes the checkout with
 *  the most over the overview; the last `weeks` of them; [] without an
 *  available overview */
export function harnessWeeks(history: HistoryOverview | null, cards: readonly RepoCard[], weeks = WEEKS): HarnessWeek[];
/** the Monday of the week holding a YYYY-MM-DD, as YYYY-MM-DD */
export function weekFrom(day: string): string;
/** the ISO week of a YYYY-MM-DD, "2026-W43" */
export function weekKey(day: string): string;
```

Dates: a `YYYY-MM-DD` is read as a local date (`new Date(y, m - 1, d)`), the weekday Monday first is `(getDay() + 6) % 7`, and the Monday is the date less that. `weekKey`: the week's Thursday (the Monday plus three days) names the year; the number is `Math.ceil((daysSince(jan1OfThatYear, thursday) + 1) / 7)`, with day counts rounded from milliseconds so a clock change does not shift one. The oldest week of the table counts only the days the overview has.

- [ ] **Step 1: Write the failing tests in `src/core/harnessshare.test.ts`**

```ts
import { describe, expect, test } from "bun:test";
import type { RepoCard } from "./cards";
import { HARNESS_SHARE_MAX, WEEKS, cardsOf, harnessNames, harnessShare, harnessWeeks, isHarnessCard, weekFrom, weekKey } from "./harnessshare";
import type { HistoryOverview, Repo, RepoHistory } from "./types";

const repo = (id: string, over: Partial<Repo> = {}): Repo => ({ id, name: id.split("|").pop() ?? id, path: `/dev/${id}`, group: "", source: "root", status: null, ...over });
const canopy = repo("canopy", { harness: true });
const web = repo("web");
const cards: RepoCard[] = [
  { key: "github.com/e/canopy", name: "canopy", checkouts: [canopy, repo("mini|canopy")] },
  { key: "github.com/e/web", name: "web", checkouts: [web] },
];

/** 2026-10-10, a Saturday, to 2026-10-27, a Tuesday: a partial oldest week, two full ones, a partial newest */
const days = Array.from({ length: 18 }, (_, i) => `2026-10-${String(10 + i).padStart(2, "0")}`);
const between = (d: string, from: string, to: string) => d >= from && d <= to;
const hist = (spend: (d: string) => number, sessions: (d: string) => number): RepoHistory => ({ days: days.map(spend), daySessions: days.map(sessions) }) as RepoHistory;
const history: HistoryOverview = {
  available: true,
  days,
  maxDay: 3,
  fetchedAt: 0,
  repos: {
    canopy: hist((d) => (between(d, "2026-10-12", "2026-10-18") ? 1 : between(d, "2026-10-19", "2026-10-25") ? 3 : d === "2026-10-26" ? 2 : 0), (d) => (d >= "2026-10-21" ? 2 : 0)),
    // the mini's archive maps the same repo with less: the larger checkout counts
    "mini|canopy": hist(() => 0.5, () => 1),
    web: hist((d) => (d >= "2026-10-12" ? 1 : 0), () => 1),
  },
};
const lines = [
  { key: "github.com/e/canopy", usd: 20, est: 1 },
  { key: "github.com/e/web", usd: 10, est: 0 },
  { key: "\u0000none", usd: 0, est: 2 },
  { key: "name:gone", usd: 0.5, est: 0 },
];
const sheet = { repos: lines.map((l) => ({ ...l, label: l.key, detail: "", tokens: 0, seconds: 0, unpriced: 0, at: 0 })) };

test("the constants are the spec's", () => {
  expect([WEEKS, HARNESS_SHARE_MAX]).toEqual([8, 25]);
});

describe("harnessShare", () => {
  test("dollars by the line's card with estimates, sessions from the window's days by the larger checkout", () => {
    expect(harnessShare(sheet, history, 7, cards)).toEqual({ usd: { harness: 21, rest: 12.5 }, sessions: { harness: 14, rest: 7 }, share: 21 / 33.5, sessionShare: 14 / 21 });
  });
  test("nothing spent reads null", () => {
    expect(harnessShare({ repos: [] }, null, 7, cards)).toEqual({ usd: { harness: 0, rest: 0 }, sessions: { harness: 0, rest: 0 }, share: null, sessionShare: null });
  });
  test("a card marked on one checkout only is harness whole", () => {
    const onlyMini: RepoCard[] = [{ ...cards[0]!, checkouts: [repo("canopy"), repo("mini|canopy", { harness: true })] }, cards[1]!];
    expect(isHarnessCard(onlyMini[0]!)).toBe(true);
    expect(harnessShare(sheet, history, 7, onlyMini).usd).toEqual({ harness: 21, rest: 12.5 });
  });
  test("a harness repo the archive does not map still counts its dollars, with no sessions", () => {
    const devhub: RepoCard = { key: "rel:devhub", name: "devhub", checkouts: [repo("devhub", { harness: true })] };
    expect(harnessShare({ repos: [{ ...sheet.repos[0]!, key: "rel:devhub", usd: 3, est: 0 }] }, history, 7, [devhub, cards[1]!])).toEqual({ usd: { harness: 3, rest: 0 }, sessions: { harness: 0, rest: 7 }, share: 1, sessionShare: 0 });
  });
});

describe("harnessWeeks", () => {
  test("Monday weeks, the oldest and the newest partial, a week with nothing at null, the larger checkout", () => {
    expect(harnessWeeks(history, cards)).toEqual([
      { from: "2026-10-05", harness: 0, rest: 0, share: null },
      { from: "2026-10-12", harness: 7, rest: 7, share: 0.5 },
      { from: "2026-10-19", harness: 21, rest: 7, share: 0.75 },
      { from: "2026-10-26", harness: 2, rest: 2, share: 0.5 },
    ]);
  });
  test("the cap keeps the newest", () => {
    expect(harnessWeeks(history, cards, 3).map((w) => w.from)).toEqual(["2026-10-12", "2026-10-19", "2026-10-26"]);
  });
  test("no overview, or one that is not available, is no week", () => {
    expect(harnessWeeks(null, cards)).toEqual([]);
    expect(harnessWeeks({ available: false, reason: "down", fetchedAt: 0 }, cards)).toEqual([]);
  });
});

test("weekFrom and weekKey, across the year boundary too", () => {
  expect(weekFrom("2026-10-10")).toBe("2026-10-05");
  expect(weekFrom("2026-10-26")).toBe("2026-10-26");
  expect(weekFrom("2026-11-01")).toBe("2026-10-26");
  expect(weekKey("2026-10-19")).toBe("2026-W43");
  expect(weekKey("2026-10-25")).toBe("2026-W43");
  expect(weekKey("2026-10-26")).toBe("2026-W44");
  expect(weekKey("2025-12-29")).toBe("2026-W01");
  expect(weekKey("2027-01-01")).toBe("2026-W53");
});

test("harnessNames and cardsOf", () => {
  expect(harnessNames(cards)).toEqual(["canopy"]);
  expect(cardsOf([canopy, web]).map((c) => [c.key, c.name, c.checkouts.length, isHarnessCard(c)])).toEqual([["canopy", "canopy", 1, true], ["web", "web", 1, false]]);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test src/core/harnessshare.test.ts`
Expected: FAIL, the module is not found.

- [ ] **Step 3: Write `src/core/harnessshare.ts`**

Header comment: what the share is, Yegge's figure, that the file is pure and browser-safe, and that the page, the CLI and the ranger hub all read it.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test src/core/harnessshare.test.ts && bun run typecheck && bun run lint`
Expected: PASS, clean.

- [ ] **Step 5: Commit**

```bash
git add src/core/harnessshare.ts src/core/harnessshare.test.ts
git commit -m "feat(harness): the share of dollars and sessions, and the weeks, as pure sums"
```

---

### Task 5: the 90-day window

**Files:**
- Modify: `src/core/history.ts:140-145` (`historyOverview`), `src/core/history.test.ts`; `src/server/index.ts:309-312` (`ServerState.history`), `:1912-1970` (the cache), `:3266-3269` (the route), `:4959-4960` (the state's init); `ui/src/api.ts:416-417`

**Interfaces:**
- Consumes: `RING_DAYS`, `localDays`, `localMidnightIso` as they are; `HISTORY_WINDOWS`, `HistoryWindow` from `core/types.ts`.
- Produces:

```ts
// src/core/history.ts
export async function historyOverview(bin: string, repos: Repo[], now = new Date(), days = RING_DAYS): Promise<HistoryOverview>;
// src/server/index.ts
/** the day strip a window asks for: 90 for 90d, else the rings' 30 */
const overviewDays = (window: string | null): number;
async function loadHistory(state: ServerState, force = false, days = RING_DAYS): Promise<HistoryCache>;
// ui/src/api.ts
history: (refresh = false, b = homeName(), window?: HistoryWindow) => Promise<HistoryOverview>
```

`ServerState.history` becomes `Map<number, HistoryCache>` and `historyPending` a `Map<number, Promise<HistoryCache>>`, keyed by the day count, so the rings' 30-day strip and the costs view's 90-day one are cached apart under the same `HISTORY_TTL`. `GET /api/history?window=90d` answers the 90-day overview; any other `window`, or none, the 30-day one. The sessions route's `loadHistory(state)` at `:1976` and the ranger's (Task 10) keep the default. `api.history` adds `window=<w>` to the query when given, beside `refresh=1`.

- [ ] **Step 1: Write the failing test in `src/core/history.test.ts`**

A stand-in CLI: a shell script that answers `projects` with one project at the scratch folder and `activity` with one row on 2026-07-29, writing the `--since` it was given to a file:

```ts
describe("historyOverview", () => {
  test("covers the days asked for and asks the CLI from the first one", async () => {
    const dir = await mkdtemp(join(tmpdir(), "canopy-history-"));
    const bin = join(dir, "claude-history");
    const project = `{"id":"p1","name":"x","path":"${dir}","sessions":1,"tokens":1,"cost":1,"first":null,"last":null,"commits":0}`;
    await writeFile(bin, `#!/bin/sh\ncase "$1" in\n  projects) echo '[${project}]' ;;\n  activity) echo "$3" > "${dir}/since"; echo '[{"project":"p1","day":"2026-07-29","sessions":1,"cost":1.5}]' ;;\nesac\n`, { mode: 0o755 });
    const repos: Repo[] = [{ id: "x", name: "x", path: dir, group: "", source: "root", status: null }];
    const now = new Date(2026, 9, 26);
    try {
      const wide = await historyOverview(bin, repos, now, 90);
      if (!wide.available) throw new Error(wide.reason);
      expect([wide.days.length, wide.days[0], wide.repos["x"]?.days[0]]).toEqual([90, "2026-07-29", 1.5]);
      expect((await readFile(join(dir, "since"), "utf8")).trim()).toBe(localMidnightIso("2026-07-29"));
      const narrow = await historyOverview(bin, repos, now);
      if (!narrow.available) throw new Error(narrow.reason);
      expect([narrow.days.length, narrow.repos["x"]?.days.reduce((a, b) => a + b, 0)]).toEqual([30, 0]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
```

Import `mkdtemp`, `readFile`, `rm`, `writeFile` from `node:fs/promises`, `tmpdir` and `join`, `historyOverview` and `localMidnightIso` from `./history`, and `Repo` from `./types`.

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test src/core/history.test.ts`
Expected: FAIL (`days` is not a parameter; the wide strip has 30 days).

- [ ] **Step 3: Add the parameter, the keyed cache, the route's `window` and the client's**

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test src/core/history.test.ts src/server/ && bun run typecheck`
Expected: PASS; typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/core/history.ts src/core/history.test.ts src/server/index.ts ui/src/api.ts
git commit -m "feat(history): GET /api/history?window=90d, a 90-day overview cached beside the rings' 30"
```

---

### Task 6: the page's mark

**Files:**
- Modify: `ui/src/api.ts:1139-1147` (after `favorite`); `ui/src/store.ts:1318-1321` (the action types), `:4223-4231` (`favoriteRepo`), `:5142-5145` (`isFavorite`); `ui/src/store.test.ts:1970-1979` (the favorites test); `ui/src/components/RepoMenu.tsx:93-95` (the store hooks), `:225-229` (`star`), `:700-716` (the star button)

**Interfaces:**
- Consumes: `isHarnessCard` from `src/core/harnessshare.ts`; `cardOf`, `applyEvent`, `backendOf`, `qRepo`, `from`, `on`, `rq` as `favorite` uses them.
- Produces:

```ts
// ui/src/api.ts
/** marks a repo as the harness, or takes the mark off; answers the repo */
harness: (id: string, harness: boolean) => Promise<Repo>;
// ui/src/store.ts
/** marks one checkout; unmarking takes the mark off every checkout of its card */
harnessRepo: (repoId: string, harness: boolean) => Promise<void>;
/** whether the card a repo is on counts as the harness */
export function isHarness(s: CanopyState, repoId: string): boolean;
```

`harnessRepo` is `favoriteRepo` with `harness` in place of `favorite`. `isHarness` is `isFavorite` over `isHarnessCard`. In `RepoMenu.tsx`, after the star button inside the "in canopy" group:

```tsx
<button
  type="button"
  role="menuitem"
  className="menu-item"
  title={
    harness
      ? "Stop counting this repo as the harness"
      : "Count this repo as the harness, canopy itself: the costs view then says what share of the spend and the sessions went into it"
  }
  onClick={() => void markHarness()}
>
  <span className="menu-text">{harness ? "not the harness" : "counts as the harness"}</span>
  {harness && <span className="menu-fact">harness</span>}
</button>
```

with `const harnessRepo = useStore((s) => s.harnessRepo);`, `const harness = useStore((s) => isHarness(s, repo.id));` and a `markHarness` handler shaped like `star`.

- [ ] **Step 1: Write the failing test in `ui/src/store.test.ts`**

After the favorites test at `:1970-1979`, with the same `two()` setup, importing `isHarness` beside `isFavorite`:

```ts
test("isHarness reads the card: a mark on the other checkout counts here", () => {
  two();
  useStore.setState((s) => ({ repos: s.repos.map((r) => (r.id === "b|proj" ? { ...r, harness: true as const } : r)) }));
  const s = useStore.getState();
  expect(isHarness(s, "proj")).toBe(true);
  expect(isHarness(s, "b|proj")).toBe(true);
  expect(isHarness(s, "other")).toBe(false);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test ui/src/store.test.ts -t isHarness`
Expected: FAIL, `isHarness` is not exported.

- [ ] **Step 3: Add the api call, the action, the selector and the menu item**

- [ ] **Step 4: Run the tests, typecheck, lint and build**

Run: `bun test ui/src/store.test.ts && bun run typecheck && bun run lint && bun run build`
Expected: PASS, clean, built.

- [ ] **Step 5: Commit**

```bash
git add ui/src/api.ts ui/src/store.ts ui/src/store.test.ts ui/src/components/RepoMenu.tsx
git commit -m "feat(harness): counts as the harness in the card's menu"
```

---

### Task 7: the threshold setting

**Files:**
- Modify: `ui/src/settings.ts:105-208` (`Settings`), `:210-214` (beside `INBOX_TEXT`), `:216-265` (`DEFAULT_SETTINGS`), `:393-451` (`loadSettings`); `ui/src/settings.test.ts`; `ui/src/components/Settings.tsx:432-437` (after the notify row)

**Interfaces:**
- Consumes: `HARNESS_SHARE_MAX` from `src/core/harnessshare.ts`; `setSetting`; the number field at `ui/src/components/Ranger.tsx:310-325` as the shape to copy.
- Produces in `ui/src/settings.ts`:

```ts
/** the harness share's warning line, percent: 0 is off, else 5 to 90 */
export const HARNESS_SHARE = { min: 5, max: 90, off: 0 } as const;
/** a saved line: 0 kept, a whole percent clamped to the range, else the default */
export const harnessShareMaxOf = (v: unknown): number;
// on Settings
/** the costs view's harness line turns rust at this share, percent, and
 *  the inbox says so once a week; 0 turns both off */
harnessShareMax: number;
```

The default is `HARNESS_SHARE_MAX` (25). In `Settings.tsx`, one more device section after the notify row:

```tsx
{ tab: "device", key: "harness", words: "harness share warning line percent costs canopy itself inbox", node: <HarnessShareRow /> },
```

`HarnessShareRow` is a `section.settings-row` with the label "harness share", a `label.layout-field` reading "warning at" around an `input.settings-input` of `type="number"`, `min={0}`, `max={90}`, followed by "%", held as local text and committed on blur and Enter through `harnessShareMaxOf(Number(text))`, the way the ranger's "or past (MB)" field does; its hint: "The costs view's harness line turns rust at this share of the window's dollars, and the inbox gets one quiet line a week when last week crossed it. 0 turns both off."

- [ ] **Step 1: Write the failing tests in `ui/src/settings.test.ts`**

With the file's localStorage stand-in (the shape at `:26-30`):

```ts
describe("the harness share's line", () => {
  test("defaults to 25, keeps 0, clamps to 5 and 90, repairs junk", () => {
    expect(harnessShareMaxOf(undefined)).toBe(25);
    expect(harnessShareMaxOf(0)).toBe(0);
    expect(harnessShareMaxOf(3)).toBe(5);
    expect(harnessShareMaxOf(95)).toBe(90);
    expect(harnessShareMaxOf(40.6)).toBe(41);
    expect(harnessShareMaxOf("30")).toBe(25);
  });
  test("survives a reload, repaired", () => {
    const store = new Map<string, string>();
    (globalThis as { localStorage?: unknown }).localStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    };
    store.set("canopy.settings", JSON.stringify({ harnessShareMax: 40 }));
    expect(loadSettings().harnessShareMax).toBe(40);
    store.set("canopy.settings", JSON.stringify({ harnessShareMax: 200 }));
    expect(loadSettings().harnessShareMax).toBe(90);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test ui/src/settings.test.ts -t "harness share"`
Expected: FAIL, `harnessShareMaxOf` is not exported.

- [ ] **Step 3: Add the setting, its repair and the row**

- [ ] **Step 4: Run the tests, typecheck, lint and build**

Run: `bun test ui/src/settings.test.ts && bun run typecheck && bun run lint && bun run build`
Expected: PASS, clean, built.

- [ ] **Step 5: Commit**

```bash
git add ui/src/settings.ts ui/src/settings.test.ts ui/src/components/Settings.tsx
git commit -m "feat(harness): the harness share warning line, a per-browser setting"
```

---

### Task 8: the line and the weeks table

**Files:**
- Modify: `src/core/harnessshare.ts`, `src/core/harnessshare.test.ts`; `ui/src/components/Costs.tsx:5-9` (imports), `:142-156` (the header); `ui/src/styles.css:13096` (after `.cost-total b`)

**Interfaces:**
- Consumes: Task 4's functions and types; `mergeHistory` from `src/core/historymerge.ts`; `api.history(false, b, "90d")`; `usd` from `../util`; `isOnline` and the store's `history`, `settings`, `backendOrder`.
- Produces in `src/core/harnessshare.ts`:

```ts
/** "23%" or "—" */
export const pct = (share: number | null): string;
/** "rust" at or over the line, "moss" under it; null with nothing spent or the line at 0 */
export function shareTone(share: number | null, max: number): "rust" | "moss" | null;
/** the two spans' widths, whole percents that add to 100; null with nothing spent */
export function barWidths(share: number | null): { harness: string; rest: string } | null;
```

and in `Costs.tsx`:

```tsx
/** the 90-day overview of every online backend, read while the table is open; null before it answers or while closed */
function useWideHistory(open: boolean): HistoryOverview | null;
function HarnessLine({ sheet, history, days, cards }: { sheet: CostSheet; history: HistoryOverview | null; days: number; cards: readonly RepoCard[] });
```

`HarnessLine` renders right after the header, before the loading note, when `sheet` is there. It reads `max` from `s.settings.harnessShareMax`, `share = harnessShare(sheet, history, days, cards)`, `wide = useWideHistory(open)`, `weeks = harnessWeeks(wide ?? history, cards)`, `names = harnessNames(cards)`, `tone = shareTone(share.share, max)`:

```tsx
<details className="cost-share" open={open} onToggle={(e) => setOpen(e.currentTarget.open)}>
  <summary title={names.length ? `The harness: ${names.join(", ")}` : "No repo counts as the harness: mark one from its card's menu"}>
    harness <b className={tone ?? undefined}>{pct(share.share)}</b> of {usd(share.usd.harness + share.usd.rest)} · <b className={tone ?? undefined}>{pct(share.sessionShare)}</b> of {share.sessions.harness + share.sessions.rest} sessions
  </summary>
  {weeks.length === 0 ? (
    <p className="cost-note">{open && wide === null ? "reading 90 days…" : "No week to show: claude-history has no spend in these repos."}</p>
  ) : (
    <table>
      <thead><tr><th>week</th><th>harness</th><th>rest</th><th>share</th><th /></tr></thead>
      <tbody>
        {weeks.map((w, i) => {
          const t = shareTone(w.share, max);
          const bar = barWidths(w.share);
          return (
            <tr key={w.from}>
              <td>{w.from}{i === weeks.length - 1 && <small> so far</small>}</td>
              <td>{usd(w.harness)}</td>
              <td>{usd(w.rest)}</td>
              <td className={t ?? undefined}>{pct(w.share)}</td>
              <td>{bar && (
                <span className="cost-bar" aria-hidden="true">
                  <span className={`cost-bar-harness${t === "rust" ? " rust" : ""}`} style={{ width: bar.harness }} />
                  <span className="cost-bar-rest" style={{ width: bar.rest }} />
                </span>
              )}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  )}
</details>
```

`useWideHistory` follows `useLedger`'s shape: while `open`, `api.history(false, b, "90d")` for every online backend, the parts that answer merged with `mergeHistory` in backend order, a backend that fails left out; null while closed. CSS under `.cost-share`: the summary is a pointer in `--ink-dim` at 12px with `b` in `--ink`, `.rust` in `--rust` and `.moss` in `--moss`; the table has tabular numerals, right-aligned cells with the first column left, no bold heads; `.cost-bar` is an inline flex strip 140px by 8px on `--bark3` with rounded corners, its spans `display: block; height: 100%`, `.cost-bar-harness` on `--lichen`, `.cost-bar-harness.rust` on `--rust`, `.cost-bar-rest` on `--moss`. No new colors; the rings at `:3961` draw the same way.

- [ ] **Step 1: Write the failing tests in `src/core/harnessshare.test.ts`**

```ts
test("pct, shareTone and barWidths", () => {
  expect([pct(0.234), pct(1), pct(null)]).toEqual(["23%", "100%", "—"]);
  expect(shareTone(0.25, 25)).toBe("rust");
  expect(shareTone(0.249, 25)).toBe("rust");
  expect(shareTone(0.244, 25)).toBe("moss");
  expect(shareTone(0.9, 0)).toBeNull();
  expect(shareTone(null, 25)).toBeNull();
  expect(barWidths(0.754)).toEqual({ harness: "75%", rest: "25%" });
  expect(barWidths(null)).toBeNull();
});
```

Import `barWidths`, `pct` and `shareTone` with the rest.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test src/core/harnessshare.test.ts -t "pct"`
Expected: FAIL, the three are not exported.

- [ ] **Step 3: Add the three words, the hook, the line, the table and the CSS**

- [ ] **Step 4: Run the tests, typecheck, lint and build, then look at it**

Run: `bun test src/core/harnessshare.test.ts && bun run typecheck && bun run lint && bun run build`
Expected: PASS, clean, built. Then start a scratch server as the memory note "Scratch canopy server for UI checks" says, over a root that holds this checkout, and open the costs view: the line under the total reads `harness NN% of $… · NN% of N sessions`, folds open to the weeks with a bar per week and "so far" on the last row.

- [ ] **Step 5: Commit**

```bash
git add src/core/harnessshare.ts src/core/harnessshare.test.ts ui/src/components/Costs.tsx ui/src/styles.css
git commit -m "feat(costs): the harness share line and eight weeks of bars in the costs view"
```

---

### Task 9: the weekly line in the inbox

**Files:**
- Modify: `ui/src/inbox.ts` (the end), `ui/src/inbox.test.ts` (the end); `ui/src/store.ts:785` (after `advice`), `:2069` (its init), `:4223` (beside the actions), `:4927-4945` (beside `inboxItems`); `ui/src/components/Inbox.tsx:661` (after `<LandingNotices />`)

**Interfaces:**
- Consumes: `HarnessWeek`, `harnessWeeks`, `harnessNames`, `pct`, `weekKey` from `src/core/harnessshare.ts`; `allCards(s)`; `s.history`; `s.settings.harnessShareMax`.
- Produces:

```ts
// ui/src/inbox.ts
export const HARNESS_SAID_KEY = "canopy.harnessSaid";
export interface HarnessNotice {
  /** the week it is for, "2026-W43" */
  key: string;
  text: string;
}
/** The quiet line for the newest full week when its share is at or over
 *  `max`, unless this browser said it already (`said` is its key). Null at
 *  a line of 0, without a full week, or with nothing spent in it. */
export function harnessNotice(weeks: readonly HarnessWeek[], names: readonly string[], max: number, said: string | null): HarnessNotice | null;
// ui/src/store.ts
/** the week key of the harness line this browser noted, from localStorage */
harnessSaid: string | null;
sayHarness: (key: string) => void;
/** the inbox's harness line, memoized over the overview, the cards, the line and the said key */
export function harnessNoticeOf(s: CanopyState): HarnessNotice | null;
```

The text is `last week ${pct(share)} of Claude spend went into the harness (${names.join(", ")})`. The newest full week is the second to last of `weeks` (the last is the partial one). The store reads `HARNESS_SAID_KEY` at init inside a `try`, as `LAYOUT_KEY` is read at `:332`; `sayHarness` sets the field and writes the key. `harnessNoticeOf` memoizes like `inboxItems` over `s.history`, `s.repos`, `s.backendOrder`, `s.settings.harnessShareMax` and `s.harnessSaid`, computing `harnessNotice(harnessWeeks(s.history, cards), harnessNames(cards), max, said)` with `cards = allCards(s)`. In `Inbox.tsx`, a `HarnessNotice` component after `<LandingNotices />`: a `section.settings-row` with the label "harness", the text as a `settings-hint`, and a `button.mini` reading "noted" that calls `sayHarness(notice.key)`; nothing when the notice is null. It is no item, so the chip's count never sees it.

- [ ] **Step 1: Write the failing tests in `ui/src/inbox.test.ts`**

```ts
describe("the harness's weekly line", () => {
  const weeks = [
    { from: "2026-10-12", harness: 7, rest: 7, share: 0.5 },
    { from: "2026-10-19", harness: 17, rest: 33, share: 0.34 },
    { from: "2026-10-26", harness: 2, rest: 0, share: 1 },
  ];
  test("the newest full week at or over the line, once per week key", () => {
    expect(harnessNotice(weeks, ["canopy", "devhub"], 25, null)).toEqual({ key: "2026-W43", text: "last week 34% of Claude spend went into the harness (canopy, devhub)" });
    expect(harnessNotice(weeks, ["canopy", "devhub"], 34, null)?.key).toBe("2026-W43");
    expect(harnessNotice(weeks, ["canopy", "devhub"], 25, "2026-W43")).toBeNull();
    expect(harnessNotice(weeks, ["canopy", "devhub"], 25, "2026-W42")).not.toBeNull();
  });
  test("none under the line, at a line of 0, without a full week, or with nothing spent in it", () => {
    expect(harnessNotice(weeks, ["canopy"], 35, null)).toBeNull();
    expect(harnessNotice(weeks, ["canopy"], 0, null)).toBeNull();
    expect(harnessNotice(weeks.slice(-1), ["canopy"], 25, null)).toBeNull();
    expect(harnessNotice([{ from: "2026-10-19", harness: 0, rest: 0, share: null }, weeks[2]!], ["canopy"], 25, null)).toBeNull();
  });
});
```

Import `harnessNotice` with the rest.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test ui/src/inbox.test.ts -t "weekly line"`
Expected: FAIL, `harnessNotice` is not exported.

- [ ] **Step 3: Add the function, the store's key and selector, and the section**

- [ ] **Step 4: Run the tests, typecheck, lint and build**

Run: `bun test ui/src/inbox.test.ts ui/src/store.test.ts && bun run typecheck && bun run lint && bun run build`
Expected: PASS, clean, built.

- [ ] **Step 5: Commit**

```bash
git add ui/src/inbox.ts ui/src/inbox.test.ts ui/src/store.ts ui/src/components/Inbox.tsx
git commit -m "feat(inbox): one quiet line a week when the harness share crossed the line"
```

---

### Task 10: the ranger's slot

**Files:**
- Modify: `src/core/harnessshare.ts`, `src/core/harnessshare.test.ts`; `src/core/ranger.ts:216-225` (`BriefVars`), `:232-242` (`rangerBrief`); `src/core/ranger.test.ts:90-99`; `lib/ranger.md:29` (the end); `src/server/ranger.ts:188-189` (the deps), `:693-700` (the brief call); `src/server/ranger.test.ts:119` (the stub brief); `src/server/index.ts:5000-5030` (the hub's deps)

**Interfaces:**
- Consumes: `harnessWeeks`, `cardsOf`, `HARNESS_SHARE_MAX`; the server's `loadHistory(state)` (the 30-day overview holds three full weeks, enough for last week).
- Produces:

```ts
// src/core/harnessshare.ts
/** the newest full week's figure with the line, for the ranger: "34%, over
 *  the 25% line" or "12%, under the 25% line"; null without a full week or
 *  with nothing spent in it */
export function harnessSlot(weeks: readonly HarnessWeek[], max: number): string | null;
// src/core/ranger.ts, on BriefVars
/** last week's harness share with the line, "34%, over the 25% line"; null without one */
harnessShare: string | null;
// src/server/ranger.ts, on RangerHubDeps
/** last week's harness share for the brief; none when absent or when it throws */
harnessShare?: () => Promise<string | null>;
```

`rangerBrief`'s block regex takes `harnessShare` beside `previous` and `telegram`, and `vals.harnessShare` is `v.harnessShare ?? ""`. `lib/ranger.md` ends with:

```
{{#harnessShare}}
Harness share:
- Harness share last week: {{harnessShare}}. That is the share of this backend's Claude spend that went into canopy itself, the repos marked as the harness. You may say so in your weekly words to Eric; nothing in canopy acts on it.
{{/harnessShare}}
```

In `doLaunch`, `harnessShare: this.deps.harnessShare ? await this.deps.harnessShare().catch(() => null) : null` is read before `rangerBrief` is called, with a `launchCurrent(epoch)` check after the await like the others. In `index.ts` the hub's deps gain:

```ts
harnessShare: async () => harnessSlot(harnessWeeks((await loadHistory(state)).value, cardsOf(state.result.repos)), HARNESS_SHARE_MAX),
```

- [ ] **Step 1: Write the failing tests**

In `src/core/harnessshare.test.ts`:

```ts
test("harnessSlot names the newest full week against the line", () => {
  const weeks = harnessWeeks(history, cards);
  expect(harnessSlot(weeks, 25)).toBe("75%, over the 25% line");
  expect(harnessSlot(weeks, 80)).toBe("75%, under the 80% line");
  expect(harnessSlot(weeks.slice(-1), 25)).toBeNull();
  expect(harnessSlot([{ from: "2026-10-19", harness: 0, rest: 0, share: null }, weeks[3]!], 25)).toBeNull();
});
```

In `src/core/ranger.test.ts`, `vars` gains `harnessShare: null`, and the describe gets:

```ts
test("the harness share block stays only with a figure", () => {
  const t = "{{#harnessShare}}Share: {{harnessShare}}{{/harnessShare}}";
  expect(rangerBrief(t, vars)).toBe("");
  expect(rangerBrief(t, { ...vars, harnessShare: "34%, over the 25% line" })).toBe("Share: 34%, over the 25% line");
});
```

In `src/server/ranger.test.ts`, the stub brief at `:119` ends with `{{#harnessShare}} Share: {{harnessShare}}{{/harnessShare}}` (the existing exact-match test at `:189` still holds, since no dep means an empty block), and a new test beside the fresh-conversation ones:

```ts
test("the brief carries last week's harness share when the backend has one, and goes without it when the read fails", async () => {
  const h = hub({ harnessShare: async () => "34%, over the 25% line" });
  await h.start();
  await h.set({ on: true });
  await settled();
  expect(await readFile(join(dir(), "brief.md"), "utf8")).toContain("Share: 34%, over the 25% line");
  const h2 = hub({ harnessShare: async () => { throw new Error("no archive"); } });
  await h2.start();
  await h2.set({ on: true });
  await settled();
  expect(await readFile(join(dir(), "brief.md"), "utf8")).not.toContain("Share:");
});
```

Use the file's own helpers for turning the ranger on and waiting (read the test at `:168-190` and copy its calls where `set` and `settled` differ).

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test src/core/harnessshare.test.ts src/core/ranger.test.ts src/server/ranger.test.ts`
Expected: FAIL on the new tests only.

- [ ] **Step 3: Add the slot, the block, the brief line, the dep and the wiring**

- [ ] **Step 4: Run the tests and typecheck**

Run: `bun test src/core/harnessshare.test.ts src/core/ranger.test.ts src/server/ranger.test.ts && bun run typecheck && bun run lint`
Expected: PASS, clean.

- [ ] **Step 5: Commit**

```bash
git add src/core/harnessshare.ts src/core/harnessshare.test.ts src/core/ranger.ts src/core/ranger.test.ts lib/ranger.md src/server/ranger.ts src/server/ranger.test.ts src/server/index.ts
git commit -m "feat(ranger): the brief carries last week's harness share"
```

---

### Task 11: canopy costs

**Files:**
- Create: `src/cli/costs.ts`, `src/cli/costs.test.ts`
- Modify: `src/cli/health.ts:239-250` (the `targets` closure), `src/cli/index.ts:50-56` (the imports), `:849-850` (beside `health`); `src/core/help.ts:72` (before the health block); `README.md:64` (before the health lines)

**Interfaces:**
- Consumes: `Target`, `targetsOf`, `ask`, `Unreachable`, `errText`, `take`, `has` from `./health`; `apiBase` from `./api`; `bold`, `dim`, `moss`, `rust` from `./render`; `joinRepos`, `RepoCard` from `core/cards.ts`; `costSheet`, `CostSheet`, `CostLine`, `ServedRow`, `usageWords`, `usdWord`, `tokensWord` from `core/costsheet.ts`; `qualify`, `split`, `Reg` from `core/backendid.ts`; `mergeHistory` from `core/historymerge.ts`; `harnessShare`, `harnessWeeks`, `harnessNames`, `pct`, `shareTone`, `HARNESS_SHARE_MAX`, `HarnessShare`, `HarnessWeek` from `core/harnessshare.ts`; `CostReport` from `core/costs.ts`; `ScanResult`, `HistoryOverview`, `BackendEntry` from `core/types.ts`.
- Produces:

```ts
// src/cli/health.ts
/** Every backend the home one lists, in `targetsOf`'s order; home alone
 *  when --backend was given without --on; the one --on names, else `fail`. */
export async function backendTargets(home: string, opts: { given?: string; on?: string }, fail: (msg: string) => never): Promise<Target[]>;

// src/cli/costs.ts
export const COSTS_USAGE = "usage: canopy costs [--days 1|7|30] [--share] [--on NAME] [--backend URL]";
/** 1, 7 or 30 from --days, 7 unset, null for anything else */
export function daysOf(arg: string | undefined): 1 | 7 | 30 | null;
/** the window's total, then by service and by repo, the first `limit` repos */
export function costLines(sheet: CostSheet, days: number, limit = 15): string[];
/** "harness 23% of $41.20 · 31% of 48 sessions" */
export function shareLine(s: HarnessShare): string;
/** the figure naming the harness repos, then the weeks table */
export function shareLines(share: HarnessShare, weeks: readonly HarnessWeek[], names: readonly string[], max: number): string[];
export async function costsCommand(argv: string[], { fail }: { fail: (msg: string) => never }): Promise<void>;
```

`healthCommand`'s `targets()` closure calls `backendTargets(home, { given, on }, fail)` and keeps its memo. `costLines`: the first line is `today` or `<n> days`, a colon, `usdWord(sheet.usd)`, then ` + ≈ <est>` when `est > 0` and ` + <n> unpriced` when `unpriced > 0`; then `by service` and one line per service, `  ` + the label padded to 26 + a space + the amount padded to 10 on the left + two spaces + `usageWords(l, tokensWord)`, trailing spaces trimmed; the amount is the usd and `≈ ` the est joined with ` + `, else `unpriced` when the line has unpriced rows, else `$0.00`; then `by repo` the same way over the first `limit` repo lines, with `  … and <n> more` after when there are more; an empty group reads `  nothing`. `shareLines`: `shareLine` followed by two spaces and `(canopy, devhub)`, or `(no repo is marked as the harness)`; then the header `week`, `harness`, `rest`, `share` laid out as the test shows (the week padded to 10, the harness amount to 9 on the left, the rest to 8, the share to 5, two spaces between); one row per week, the last with `  so far`; with no weeks, one line `  no week to show: claude-history has no spend in these repos`. The share cells and the first line's percentages are painted `rust` or `moss` by `shareTone`, plain when it is null.

`costsCommand`: copies argv; `--backend`, `--on`, `--share`, `--days` through `daysOf` (null fails with `COSTS_USAGE`); anything left over fails with `COSTS_USAGE`; `home = apiBase(given)` checked as an http(s) origin like health; `targets = await backendTargets(home, { given, on }, fail)`; `reg: Reg = { home: targets[0]!.name, names: targets.map((t) => t.name) }`. For each target at once: `ask<ScanResult>(t, "GET", "/api/tree")`, `ask<HistoryOverview>(t, "GET", "/api/history?window=90d")` and `ask<CostReport>(t, "GET", \`/api/costs?days=${days}\`)`; a target where any of the three fails is left out and named after the output as `not counted: <name>: <why>`. Ids are qualified with `qualify(reg, t.name, id)`: the repos' ids, the overview's `repos` keys, and each row's `qid` from `repoId`, with `backend: t.name`. Then `cards = joinRepos(repos, reg.names, (id) => split(reg, id))`, `history = mergeHistory(overviews)`, `sheet = costSheet(rows, history, days, cards)`; print `costLines(sheet, days)`, then with `--share` `shareLines(harnessShare(sheet, history, days, cards), harnessWeeks(history, cards), harnessNames(cards), HARNESS_SHARE_MAX)`; `fail` when no backend answered.

`src/cli/index.ts`: `case "costs": return costsCommand(args, { fail });` beside `health`. `src/core/help.ts`, before the `canopy health` block:

```
  canopy costs [--days 1|7|30] [--share]
                                     what the paid services spent across every backend the home one lists, by service and by repo;
                                     --share adds the harness share, dollars and Claude sessions, and eight weeks of it
    --on NAME / --backend URL        as canopy health
```

`README.md`, before the `canopy health` lines:

```
canopy costs [--days 1|7|30]       # what the paid services spent, by service and by repo, across every backend the home one lists
canopy costs --share               # and the harness share: the dollars and Claude sessions that went into the repos marked as the harness, eight weeks of it
```

- [ ] **Step 1: Write the failing tests in `src/cli/costs.test.ts`**

```ts
import { describe, expect, test } from "bun:test";
import type { CostLine, CostSheet } from "../core/costsheet";
import type { HarnessShare, HarnessWeek } from "../core/harnessshare";
import { costLines, daysOf, shareLine, shareLines } from "./costs";

// colour codes off what the tests read, should a terminal turn them on
// eslint-disable-next-line no-control-regex
const plain = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

const line = (key: string, label: string, over: Partial<CostLine> = {}): CostLine => ({ key, label, detail: "", usd: 0, est: 0, tokens: 0, seconds: 0, unpriced: 0, at: 0, ...over });

test("daysOf", () => {
  expect([daysOf(undefined), daysOf("1"), daysOf("7"), daysOf("30"), daysOf("5"), daysOf("x")]).toEqual([7, 1, 7, 30, null, null]);
});

test("costLines: the total, by service, by repo", () => {
  const sheet: CostSheet = {
    usd: 41.2,
    est: 0.25,
    unpriced: 2,
    archive: true,
    services: [
      line("claude:anthropic", "Claude Code", { usd: 38.1, tokens: 1_200_000 }),
      line("codex:openai", "Codex · openai", { est: 0.25, tokens: 1000 }),
      line("speech:speech", "Dictation · speech", { unpriced: 2, seconds: 30 }),
    ],
    repos: [line("github.com/e/api", "api", { usd: 3, seconds: 120 })],
    runs: [],
  };
  expect(costLines(sheet, 7)).toEqual([
    "7 days: $41.20 + ≈ $0.25 + 2 unpriced",
    "by service",
    "  Claude Code                    $38.10  1.2M tokens",
    "  Codex · openai                ≈ $0.25  1.0k tokens",
    "  Dictation · speech            unpriced  30 s",
    "by repo",
    "  api                             $3.00  2.0 min",
  ]);
  expect(costLines({ ...sheet, services: [], repos: [] }, 1).slice(0, 3)).toEqual(["today: $41.20 + ≈ $0.25 + 2 unpriced", "by service", "  nothing"]);
  expect(costLines({ ...sheet, repos: [sheet.repos[0]!, line("b", "b"), line("c", "c")] }, 30, 2).at(-1)).toBe("  … and 1 more");
});

describe("the share", () => {
  const share: HarnessShare = { usd: { harness: 9.48, rest: 31.72 }, sessions: { harness: 15, rest: 33 }, share: 9.48 / 41.2, sessionShare: 15 / 48 };
  const weeks: HarnessWeek[] = [
    { from: "2026-10-05", harness: 0, rest: 0, share: null },
    { from: "2026-10-12", harness: 7, rest: 7, share: 0.5 },
    { from: "2026-10-19", harness: 21, rest: 7, share: 0.75 },
    { from: "2026-10-26", harness: 2, rest: 2, share: 0.5 },
  ];
  test("shareLine", () => {
    expect(plain(shareLine(share))).toBe("harness 23% of $41.20 · 31% of 48 sessions");
    expect(plain(shareLine({ usd: { harness: 0, rest: 0 }, sessions: { harness: 0, rest: 0 }, share: null, sessionShare: null }))).toBe("harness — of $0.00 · — of 0 sessions");
  });
  test("shareLines: the figure with the names, then the weeks", () => {
    expect(shareLines(share, weeks, ["canopy", "devhub"], 25).map(plain)).toEqual([
      "harness 23% of $41.20 · 31% of 48 sessions  (canopy, devhub)",
      "week          harness      rest  share",
      "2026-10-05      $0.00     $0.00      —",
      "2026-10-12      $7.00     $7.00    50%",
      "2026-10-19     $21.00     $7.00    75%",
      "2026-10-26      $2.00     $2.00    50%  so far",
    ]);
    expect(shareLines(share, [], [], 25).map(plain)).toEqual([
      "harness 23% of $41.20 · 31% of 48 sessions  (no repo is marked as the harness)",
      "  no week to show: claude-history has no spend in these repos",
    ]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test src/cli/costs.test.ts`
Expected: FAIL, the module is not found.

- [ ] **Step 3: Extract `backendTargets`, write `src/cli/costs.ts`, the `case`, the help and the README lines**

- [ ] **Step 4: Run the tests, typecheck and lint, then try it**

Run: `bun test src/cli/ && bun run typecheck && bun run lint`
Expected: PASS, clean. Then against the scratch server from Task 8: `bun bin/canopy.ts costs --days 7 --share --backend http://127.0.0.1:<port>` prints the total, the two groups, the figure and the weeks, the same numbers the page shows for 7 days.

- [ ] **Step 5: Commit**

```bash
git add src/cli/costs.ts src/cli/costs.test.ts src/cli/health.ts src/cli/index.ts src/core/help.ts README.md
git commit -m "feat(cli): canopy costs prints the spend by service and repo, and the harness share"
```

---

### Task 12: the docs and the gates

**Files:**
- Modify: `docs/architecture.md:97` (the ranger paragraph), `:355-365` (the "Costs" section); `SPEC.md:56`, `:59`, `:80` (after the costs decision); `README.md:137` (after the solo view bullet); `FEATURES.md:15-19` and `:135`; `docs/superpowers/plans/README.md`; this plan's Status line

**Interfaces:**
- Consumes: the completed interfaces from Tasks 1 to 11, the source spec, and the live-check results.
- Produces: documentation and feature status that describe the implemented scope, with later phases still marked open. No new runtime interface.

- [ ] **Step 1: `docs/architecture.md`**

In the Costs section: the first sentence names `ui/src/costs.ts`; it now says the sums are in `src/core/costsheet.ts`, with the cards in `core/cards.ts`, the backend ids in `core/backendid.ts` and `mergeHistory` in `core/historymerge.ts`, which the view, the CLI and the ranger hub share. After the section's last paragraph, one more, starting "The harness share (FR-044).": the mark (`config.harness`, `Repo.harness`, `linkHarness`, `setHarness`, the route and its `operate` right, `seedHarness` once from a `package.json` named canopy); `core/harnessshare.ts` (`harnessShare` over the sheet's repo lines and `daySessions`, `harnessWeeks` from the archive alone, Monday weeks, the newest partial, `WEEKS` 8, `weekKey`, `pct`, `shareTone`, `barWidths`, `harnessSlot`, `HARNESS_SHARE_MAX` 25); `GET /api/history?window=90d` and the cache keyed by days; the view's line, its `<details>` table and `.cost-share`, the per-browser `harnessShareMax` (0 off, 5 to 90), the inbox's `harnessNotice` once per week key under `canopy.harnessSaid`; `canopy costs` and `backendTargets`; the ranger's `{{harnessShare}}`. In the ranger paragraph at `:97`, where `rangerBrief`'s blocks are named, add `{{#harnessShare}}`.

- [ ] **Step 2: `SPEC.md`**

Line 56: "Config, workspaces, sources, agent and launch settings, and the archived, starred and harness repo lists: `~/.config/canopy/config.json` …". Line 59: "Per browser: preferences (the harness share's warning line among them), open panels, shell tabs and the week the harness line was last noted, in localStorage." After line 80: "- 2026-10-26: Which repos are the harness is a list in config, seeded once from canopy's own package name and never guessed again, because the share is a mirror Eric reads and a heuristic would move it under him."

- [ ] **Step 3: `README.md`**

After the solo view bullet at `:137`: "- **Costs.** `?view=costs` (`g` then `c`) is what the paid services spent over today, 7 or 30 days, by service, by repo and by run, with Claude's dollars from claude-history. Under the total, the harness share says what part of the dollars and the Claude sessions went into the repos marked as the harness (canopy's own, seeded once; **counts as the harness** in a card's menu marks another), folds open to eight weeks of bars, turns rust past the warning line in Settings' device tab (25% unless changed, 0 for off), and the inbox gets one quiet line a week when last week crossed it. `canopy costs --share` prints the same from a terminal."

- [ ] **Step 4: `FEATURES.md` and the plans README**

Move the `### FR-044` block from `## Open` to the top of `## Shipped`, append ` · shipped <date>` to its P3 line, and add a paragraph starting `Built <date>:` in the voice of the FR-047 entry: the mark and the seed, the core share and weeks, the 90-day window, the view's line and table, the setting, the inbox line, the ranger's slot, `canopy costs`, and what the live check showed. In `docs/superpowers/plans/README.md`, set this plan's row to shipped with the date, and set this plan's Status line to shipped with the merge commit.

- [ ] **Step 5: Run every gate**

Run: `bun run typecheck && bun run lint && bun test && bun run build`
Expected: all pass. Then `~/.claude/skills/verify-build/clean-rebuild.sh verify "cost-bar-harness"` proves the served bundle is the new one.

- [ ] **Step 6: Commit**

```bash
git add docs/architecture.md SPEC.md README.md FEATURES.md docs/superpowers/plans/README.md docs/superpowers/plans/2026-10-26-harness-share.md
git commit -m "docs(harness): architecture, SPEC, README and the feature list for the harness share"
```

---

## Live check, before the branch is called done

With a scratch canopy (the "Scratch canopy server for UI checks" memory note) on a fresh config dir, over a root that holds this checkout and one other repo:

1. The first start writes `harness: ["<this checkout>"]` into the scratch `config.json`; the checkout's card menu reads "not the harness", the other repo's "counts as the harness".
2. The costs view: under the total, `harness NN% of $… · NN% of N sessions`, rust or moss by the 25% line; it folds open to at most eight rows with a bar each and "so far" on the last; the 90-day read fills rows the 30-day overview did not have.
3. Settings, this device: "harness share warning at" set to 0 takes the colour off; set to 5 (when last week's share is over 5%) puts "last week NN% of Claude spend went into the harness (canopy)" at the inbox's foot, outside its count; "noted" removes it; a reload keeps it gone; `localStorage` holds `canopy.harnessSaid` as the week's key.
4. `bun bin/canopy.ts costs --days 7 --share --backend http://127.0.0.1:<port>` prints the same figure and the same rows.
5. With the ranger on (or after `canopy ranger restart`), `<config>/ranger/brief.md` holds "Harness share last week: NN%, over the 25% line" or "under".
6. "counts as the harness" on the other repo, then "not the harness" on both, then a restart of the scratch server: both stay unmarked and `config.json` holds `harness: []`.

## Decisions this plan makes beyond the spec

- The pure sums move from `ui/src` to `src/core` (`costsheet.ts`, `cards.ts`, `backendid.ts`, `historymerge.ts`, with `usd` and `fmtTokens` now re-exported by `ui/src/util.ts`), because `canopy costs` and the ranger hub need them and nothing under `src/` imports from `ui/`. The UI files re-export, so no other UI import changes.
- The share, the weeks and the words live in `src/core/harnessshare.ts`, not `ui/src/costs.ts` as the spec names (that file goes away with the move), and the name is not `harness.ts` because `core/harness.ts` is the agent-harness table. `Repo.harness` keeps the spec's name with a comment telling the two apart.
- `GET /api/history` takes `window=90d`, a query on the existing route rather than a new one; the spec's "Where things stand" has the overview covering a chosen window, but today it is a fixed 30 days (`RING_DAYS`) and the route takes only `refresh`. The server caches per day count; the 90-day overview stays in the costs view's own state so the rings keep their 30 columns.
- The CLI and the ranger use `HARNESS_SHARE_MAX` (25) for the line, since the threshold is a per-browser setting no backend sees.
- The inbox line stays at the foot until "noted" or the week turns; "once" is once per week key, and the key is written when Eric notes it, not when it renders, so a line nobody saw is not lost. It is no item, so the chip never counts it.
- `config.harness` is null until the seed runs and `[]` after a seed that found nothing, so an unmarked board is a choice and a later start never guesses. The seed runs after the first scan and before the server listens, so the first tree carries the marks.
- Sessions per card take the checkout with the most sessions in the window, as dollars take the checkout with the most dollars; the weeks take the checkout with the most dollars over the whole overview.
- The oldest week in the table counts only the days the overview has, since a 90-day strip starts mid-week; the table says nothing about it.
- The ranger's slot needs no `schedule` trigger source from FR-041: it is filled when the brief is written, and the ranger's own crons carry the weekly words. No task waits on another plan.
- The spec's call for Eric, a share chip on the top bar, is left as the spec recommends: the share stays in the costs view, and no chip is added.
