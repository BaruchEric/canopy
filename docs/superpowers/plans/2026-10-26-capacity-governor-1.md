# Capacity governor, plan 1: the probes, the model and the limited status (FR-036)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Status:** implemented and verified locally 2026-10-26, based on main at 0fabbb3. The combined four gates and desktop/mobile browser checks passed, including clock advancement and hit expiry. Live quota and credential/refresh observations remain unobserved in the probes record. Endpoint reads, dispatch holds/retries and the credits lane remain unwired; deployment remains pending.

**Goal:** canopy can tell when a harness has hit the Max plan's usage window and
how much of it is left: a run whose reply is the limit text ends `limited`, not
`failed`; a `CapacityHub` keeps one reading per harness from the cost ledger and
from every limit hit, survives a restart, serves `GET /api/capacity` and the
`capacity` event; a top-bar chip shows each backend's windows and their resets
(FR-028). Nothing is held yet.

**Architecture:** a pure model (`core/capacity.ts`) reads the limit text, the
usage endpoint's answer and the ledger into one `Capacity` per harness and
decides `go` or a hold for a priority; `RunCtx` in `core/driver.ts` turns a
result or an exit whose text is a limit into the `limited` status for both
harnesses at once; `server/capacity.ts` owns the readings, `capacity.json`, the
clock and the route; the chip is `ui/src/capacity.ts` (pure) and
`components/Capacity.tsx`. The probes P1 to P5 are recorded in a dated note and
feed the fixtures. Plan 2 brings priorities on every start, `may` in each hub,
the retries of limited work, `canopy capacity` and the costs block; plan 3 the
credits lane, only on Eric's yes.

**Tech Stack:** Bun, TypeScript strict, React 19, bun:test. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-25-capacity-governor-design.md`, the
"Plans" list's item 1. The index is
`docs/superpowers/specs/2026-10-25-software-factory-borrowings-design.md`.

## Global constraints

- No API key and no SDK: runs keep driving the user's own `claude` and `codex` binaries (SPEC.md, 2026-08-24, and its Out of scope line). Nothing in this plan reads, copies or writes a credential; the usage endpoint is probed by hand in Task 1 and wired to nothing (Eric's call 8).
- The constants, verbatim from the spec: `READ_EVERY` 5 min, `READ_IDLE` 30 min, `HIT_HOLD` 60 min, `HIT_GRACE` 2 min, `LOW_HOLD` 0.70, `NORMAL_HOLD` 0.90, `WEEKLY_LOW_HOLD` 0.85. `observedFiveHourUsd` has no default: null leaves `used` unknown.
- The settings live under `capacity` in `config.json`: `lowHold`, `normalHold`, `weeklyLowHold`, `observedFiveHourUsd`, read through `normalizeCapacity`.
- `source: unknown` never holds. canopy never guesses a hold.
- `limited` is a `RunStatus` beside `failed`, with `error` the limit text. It is not a failure: it never lands in "waiting on you"'s failed group.
- A `hit` holds until `resetsAt` plus `HIT_GRACE`, then is dropped. A text that names no reset gets `resetsAt` = `at` + `HIT_HOLD`.
- The hit is written to `<configDir>/capacity.json` (0600). The file holds no credential.
- The chip's lines are `5h 32% · 2h10` and `week 61% · Thu`; moss under `LOW_HOLD`, lichen between the holds, rust while a hold stands or a hit is on; `unknown` reads "no reading".
- `GET /api/capacity` answers `CapacityInfo` `{capacity, held, settings}` and the `capacity` event is `{type: "capacity", capacity}`.
- Every file the UI imports from `src/core/` stays browser-safe: `core/capacity.ts` has no `node:` or `bun` import.
- Plain words, no em dashes, sentence case headings (the unslop rules apply to docs and commit messages).
- All four gates pass before a task is done: `bun run typecheck`, `bun run lint`, `bun test`, `bun run build`.

## Review focus

Inputs the spec implies and no section of it names. Each has a test in the task that owns the code.

1. A reply that mentions a limit in passing (an agent's summary that says "the rate limit handling is fine") on a result that is not an error: never read as a limit. Only a result's `problem` or an exit's stderr is read, so a sound job ends `done` (Task 3).
2. A limit text with no reset time in it: `resetsAt` is `at` + `HIT_HOLD`, so the hub still drops the hit after an hour and the grace, and nothing is held for good (Task 2 for the parse, Task 6 for the drop).
3. A `capacity.json` that cannot be parsed, or names a harness canopy does not know: the hub starts with no hit and the next hit rewrites the file, rather than the server failing to start (Task 6).
4. Ledger rows with `usd: null` (an older row, every Codex row): `observe` sums dollars alone, so `used` is never `NaN`, and a Codex harness stays `unknown` until a hit (Task 2).
5. A page on two backends where one answers `/api/capacity` and the other is older: the chip shows the one that answered and leaves the other out, and hides only when no backend answered (Task 7).

---

## File structure

- Create `docs/superpowers/specs/2026-10-26-capacity-probes.md`: the probes' record.
- Create `src/core/capacity.ts` (pure): `Window`, `Capacity`, `CapacityHit`, `CapacitySettings`, `readUsage`, `isLimitText`, `limitHit`, `hitStands`, `observe`, `stale`, `resetWord`, `decide`, `normalizeCapacity`, the constants.
- Create `src/core/capacity.test.ts`.
- Modify `src/core/types.ts`: `Priority`, `RunStatus` `limited`, `Run.limited`, `Flow.parkedFor` `capacity`, the `capacity` event, `CapacityInfo`, `HeldStart`, `CanopyConfig.capacity`.
- Modify `src/core/driver.ts` and `src/core/driver.test.ts`: `exitOutcome`'s `limited`, `RunCtx.result`, `RunCtx.exited`, `finish`.
- Modify `src/core/testdata/fake-claude.ts`, `src/core/claudedrive.test.ts`, `src/core/codexrun.test.ts`.
- Modify `src/core/flow.ts` and `src/core/flow.test.ts`: the `capacity` park and its resume.
- Modify `src/core/store.ts`: the `capacity` default and its normalisation.
- Create `src/server/capacity.ts` and `src/server/capacity.test.ts`: `CapacityHub`, `capacityFile`.
- Modify `src/server/index.ts`: `state.capacity`, the runner's `onChange`, the handle chain, start and stop. Modify `src/core/callers.test.ts`: one line.
- Create `ui/src/capacity.ts`, `ui/src/capacity.test.ts`, `ui/src/components/Capacity.tsx`.
- Modify `ui/src/store.ts`, `ui/src/api.ts`, `ui/src/components/TopBar.tsx`, `ui/src/fixit.ts`, `ui/src/components/RunSheet.tsx`, `ui/src/components/RunChip.tsx`, `ui/src/waiting.test.ts`, `ui/src/styles.css`.
- Modify `docs/architecture.md`, `SPEC.md`, `README.md`, `FEATURES.md`, `docs/superpowers/plans/README.md`.

---

### Task 1: the probes' record

**Files:**
- Create: `docs/superpowers/specs/2026-10-26-capacity-probes.md`

**Interfaces:**
- Consumes: probes P1 to P5 from the capacity-governor spec, observed CLI and protocol output, and the credential-location metadata. No credential value is recorded.
- Produces: the record the fixtures in Tasks 2, 3 and 4 cite. Its sections are `## P1`, `## P2`, `## P3`, `## P4`, `## P5` and `## What the code takes from this`, each probe with four parts: **Command** (as typed), **Observed** (verbatim, session ids and tokens blanked to `…`), **Answer** (one paragraph) and **Date**.

What each probe runs:
- **P1.** `claude -p "hi" --output-format stream-json --verbose; echo "exit $?"` against a spent 5-hour window. The record keeps every line of stdout and stderr and the exit code. It says whether the text came as a `result` (`is_error`, `subtype`, the `result` string), a `system` event, or stderr; whether it names the reset time, and in whose clock (compare it with `date` on the machine and with the Help Center's wording). A spent window cannot be made on demand without spending the window; the record says `not observed yet, <date>` when none was at hand while this plan was built, and the fixtures keep the spec's expected text until the probe is in.
- **P2.** Read the usage endpoint's shape from two public readers of it, ccusage (`github.com/ryoppippi/ccusage`, its usage or statusline source) and Orca (`github.com/stablyai/orca`): the URL, the headers it wants (the OAuth bearer and any `anthropic-beta` value), the fields per window (`utilization` and `resets_at`, and whether `utilization` is a percentage or a fraction), and how often they ask it. Confirm the shape with one read from the Mac, the credential piped from the keychain straight into the request and never into a file or the record. Then read Anthropic's Help Center pages "Use the Claude Agent SDK with your Claude plan" and "Monthly API credits for Max and Team plans" (Oct 7 2026) and write whether reading a number with the CLI's own stored credential is plainly within "You can still use ... third-party apps with your subscription limits", quoting the sentence it rests on. This is the input to Eric's call 8; the record recommends nothing and wires nothing.
- **P3.** Where the credential sits: on the Mac the keychain item `claude` keeps (`security find-generic-password -s "Claude Code-credentials"` without `-w` prints the item's metadata and never the secret); in the mini's container, `~/.claude/.credentials.json` under the bind mount (its mode and owner, from `ssh mini-host stat`). Whether `claude` refreshes it on its own: note the credential's expiry, run `claude -p "hi"` after it, and note the expiry again. canopy never writes it.
- **P4.** `codex exec "hi"; echo "exit $?"` against a spent Codex window, or, if none is at hand, what `codex app-server`'s `turn/completed` carries for a limit (`status`, `error.message`, `error.additionalDetails`) as its protocol documents; and whether `codex` exposes its usage anywhere canopy could read (the TUI's `/status`, an app-server method). If not, Codex is `observed` only, as the spec expects.
- **P5.** The weekly window's text beside the 5-hour one, from P1's output when a weekly limit hits, or the Help Center's wording until then; whether the word "week" is in it.

`## What the code takes from this` lists, one line each: the texts `limitHit` must read (P1, P4, P5), the keys and units `readUsage` must read (P2), and `source: endpoint` as "held for Eric's call 8" with the sentence from P2's terms reading.

- [ ] **Step 1: Write the record with P2, P3 and P4's protocol half**

These need no spent window. Keep every observed text verbatim, with the blanks above.

- [ ] **Step 2: Write P1, P5 and P4's spent-window half**

Run them if a window is spent during this plan; else write `not observed yet, <date>` as the **Observed** part and the spec's expected text as the **Answer**, marked "expected".

- [ ] **Step 3: Check the record names no secret**

Run: `grep -n -i -E 'sk-ant|accessToken|refreshToken|Bearer [A-Za-z0-9]' docs/superpowers/specs/2026-10-26-capacity-probes.md`
Expected: no lines.

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/specs/2026-10-26-capacity-probes.md
git commit -m "docs(capacity): the probes record for FR-036, P1 to P5"
```

---

### Task 2: the model

**Files:**
- Create: `src/core/capacity.ts`, `src/core/capacity.test.ts`
- Modify: `src/core/types.ts:820-822` (after `isHarness`, the `Priority` type)

**Interfaces:**
- Consumes: `Harness` from `core/types.ts`; `CostEntry` from `core/costs.ts` (type only).
- Produces in `src/core/types.ts`:

```ts
/** who may go first when the plan's window runs low (FR-036); plan 2 puts
 *  one on every start, this plan only defines it */
export const PRIORITIES = ["interactive", "normal", "low"] as const;
export type Priority = (typeof PRIORITIES)[number];
```

- Produces in `src/core/capacity.ts`:

```ts
export const READ_EVERY = 5 * 60_000;
export const READ_IDLE = 30 * 60_000;
export const HIT_HOLD = 60 * 60_000;
export const HIT_GRACE = 2 * 60_000;
export const FIVE_HOURS = 5 * 60 * 60_000;
export const LOW_HOLD = 0.7;
export const NORMAL_HOLD = 0.9;
export const WEEKLY_LOW_HOLD = 0.85;

export interface Window {
  /** the share spent, 0 to 1; the observed estimate may pass 1 */
  used: number;
  /** when the window resets; null for the observed estimate, which rolls */
  resetsAt: number | null;
  readAt: number;
}
export type CapacityWindow = "fiveHour" | "weekly";
export type CapacitySource = "endpoint" | "observed" | "unknown";
export interface CapacityHit {
  window: CapacityWindow;
  at: number;
  /** the text's reset time in the backend's clock, else `at` + HIT_HOLD */
  resetsAt: number;
  text: string;
}
export interface Capacity {
  harness: Harness;
  fiveHour: Window | null;
  weekly: Window | null;
  /** endpoint: read from the usage endpoint (P2); observed: inferred from a
   *  limit hit and the ledger; unknown: never read */
  source: CapacitySource;
  /** a limit hit the harness reported, until its reset passes */
  hit: CapacityHit | null;
}
export interface CapacitySettings {
  lowHold: number;
  normalHold: number;
  weeklyLowHold: number;
  /** what one 5-hour window is worth in Claude dollars, for the observed
   *  estimate; null leaves `used` unknown */
  observedFiveHourUsd: number | null;
}
export const DEFAULT_CAPACITY: CapacitySettings = { lowHold: LOW_HOLD, normalHold: NORMAL_HOLD, weeklyLowHold: WEEKLY_LOW_HOLD, observedFiveHourUsd: null };
/** each hold a number above 0 and at most 1, else its default; the dollar
 *  figure a finite number above 0, else null */
export function normalizeCapacity(v: unknown): CapacitySettings;
export const emptyCapacity = (harness: Harness): Capacity => ({ harness, fiveHour: null, weekly: null, source: "unknown", hit: null });

/** P2's answer as the two windows; a window whose fields are not there, or
 *  not numbers and a time, is null */
export function readUsage(json: unknown, now: number): { fiveHour: Window | null; weekly: Window | null };
/** whether a harness's words are the plan's usage limit (P1, P4, P5) */
export function isLimitText(text: string): boolean;
/** the text as a hit, or null when `isLimitText` says no */
export function limitHit(text: string, now: number): CapacityHit | null;
export const hitStands = (hit: CapacityHit | null, now: number): boolean => hit !== null && now < hit.resetsAt + HIT_GRACE;
/** no endpoint: `fiveHour.used` is the ledger's Claude dollars over the last
 *  five hours against the figure; a capacity read from the endpoint is left
 *  as it is, and so is a harness with no dollars in the ledger (Codex) */
export function observe(cap: Capacity, rows: readonly CostEntry[], settings: Pick<CapacitySettings, "observedFiveHourUsd">, now: number): Capacity;
/** a window read from the endpoint is not trusted past READ_EVERY */
export const stale = (w: Window | null, now: number): boolean => w === null || now - w.readAt > READ_EVERY;
/** a reset for a sentence: "15:00" on the same local day, else the weekday, "Thu" */
export function resetWord(ms: number, now: number): string;
export type Decision = "go" | { hold: "window" | "hit"; until: number | null; why: string };
export function decide(cap: Capacity, priority: Priority, settings: CapacitySettings, now: number): Decision;
```

Rules the tests pin:
- `readUsage` reads `{ five_hour: { utilization, resets_at }, seven_day: { utilization, resets_at } }`: `utilization` must be a finite number, above 1 a percentage (divided by 100), at most 1 a fraction, else that window is null; `resets_at` an ISO 8601 string or unix seconds, anything else `resetsAt: null`; `readAt: now`. A non-object leaves both windows null. Task 1's P2 record may rename a key or change a unit: then the fixture here follows the record and this list is updated in the same commit.
- `isLimitText`: true when the text matches `/\bhit your (?:\w+ )?limit\b/i` or `/\busage limit\b/i`; false for anything else, "rate limit" included (a 429 the CLI retries on its own is not the plan's window).
- `limitHit`: `window` is `weekly` when `/\bweek(?:ly)?\b/i` matches, else `fiveHour`. `resetsAt`: a trailing `|<digits>` (the older CLI's unix seconds) times 1000; else `resets (?:(Mon|Tue|Wed|Thu|Fri|Sat|Sun)\w* )?(\d{1,2})(?::(\d{2}))?\s*(am|pm)` in the backend's local clock, the next such time after `now` (today, else tomorrow; with a weekday, the next such weekday); else `now + HIT_HOLD`. `at: now`, `text: text.trim()`.
- `observe`: rows with `service === "claude"`, `at` within `(now - FIVE_HOURS, now]`, `usd` summed with null as 0; `cap.harness !== "claude"` or `cap.source === "endpoint"` returns `cap` unchanged; `observedFiveHourUsd === null` gives `fiveHour: null` and `source` `observed` when a hit stands else `unknown`; else `fiveHour: { used: sum / figure, resetsAt: null, readAt: now }`, `source: "observed"`. `weekly` is left as it was.
- `decide`: `interactive` is `go`. A standing hit holds `normal` and `low` with `{ hold: "hit", until: hit.resetsAt + HIT_GRACE, why: "the 5-hour window is spent (resets 15:00)" }` (the window's name is `5-hour` or `weekly`). Else a window from the endpoint that is `stale` reads as null. `normal` holds while `fiveHour.used >= normalHold`; `low` while `fiveHour.used >= lowHold` or `weekly.used >= weeklyLowHold`; the hold is `{ hold: "window", until: w.resetsAt, why: "the 5-hour window is at 92% (resets 15:00)" }`, the reset left out of `why` when `resetsAt` is null. Nothing else holds: `source: unknown` is `go`.

- [ ] **Step 1: Add `PRIORITIES` and `Priority` to `src/core/types.ts`**

After `isHarness` at `:822`. Run `bun run typecheck` to confirm.

- [ ] **Step 2: Write the failing tests in `src/core/capacity.test.ts`**

```ts
import { describe, expect, test } from "bun:test";
import type { CostEntry } from "./costs";
import { DEFAULT_CAPACITY, HIT_GRACE, HIT_HOLD, READ_EVERY, decide, emptyCapacity, hitStands, isLimitText, limitHit, normalizeCapacity, observe, readUsage, resetWord, stale, type Capacity } from "./capacity";

// bun test runs in UTC, so the backend's local clock is UTC here
const NOW = Date.UTC(2026, 9, 26, 12); // a Monday, noon
const AT_3PM = Date.UTC(2026, 9, 26, 15);
const THU_3PM = Date.UTC(2026, 9, 29, 15);
const SPENT = "You've hit your limit · resets 3pm";
const OLDER = "Claude AI usage limit reached|1793026800";
const CODEX = "usage limit reached\ntry later";
const WEEKLY = "You've hit your weekly limit · resets Thu 3pm";

const row = (at: number, usd: number | null, service: CostEntry["service"] = "claude"): CostEntry => ({ at, service, provider: "anthropic", model: null, repo: null, repoName: null, run: null, label: null, session: null, usd, tokens: null, seconds: null });
const cap = (over: Partial<Capacity> = {}): Capacity => ({ ...emptyCapacity("claude"), ...over });
const win = (used: number, resetsAt: number | null = AT_3PM, readAt = NOW) => ({ used, resetsAt, readAt });

describe("readUsage", () => {
  test("P2's shape: a percentage or a fraction, an ISO time or unix seconds", () => {
    expect(readUsage({ five_hour: { utilization: 32, resets_at: "2026-10-26T14:10:00Z" }, seven_day: { utilization: 0.61, resets_at: 1793026800 } }, NOW)).toEqual({
      fiveHour: { used: 0.32, resetsAt: Date.UTC(2026, 9, 26, 14, 10), readAt: NOW },
      weekly: { used: 0.61, resetsAt: AT_3PM, readAt: NOW },
    });
  });
  test("a window it does not recognise is null; garbage is two nulls", () => {
    expect(readUsage({ five_hour: { utilization: "lots" }, seven_day: { utilization: 5, resets_at: null } }, NOW)).toEqual({ fiveHour: null, weekly: { used: 0.05, resetsAt: null, readAt: NOW } });
    expect(readUsage("nope", NOW)).toEqual({ fiveHour: null, weekly: null });
    expect(readUsage(null, NOW)).toEqual({ fiveHour: null, weekly: null });
  });
});

describe("isLimitText and limitHit", () => {
  test("the texts the probes expect are limits; a rate limit and a summary are not", () => {
    for (const t of [SPENT, OLDER, CODEX, WEEKLY, "You've hit your limit"]) expect(isLimitText(t)).toBe(true);
    for (const t of ["", "rate limit exceeded, retrying", "I checked the rate limit handling", "stopped after 3 turns without finishing"]) expect(isLimitText(t)).toBe(false);
    expect(limitHit("stopped at the spending limit", NOW)).toBeNull();
  });
  test("a reset time is read in the backend's clock, as the next such time", () => {
    expect(limitHit(SPENT, NOW)).toEqual({ window: "fiveHour", at: NOW, resetsAt: AT_3PM, text: SPENT });
    expect(limitHit(SPENT, Date.UTC(2026, 9, 26, 16))?.resetsAt).toBe(Date.UTC(2026, 9, 27, 15));
    expect(limitHit("You've hit your limit · resets 3:30pm", NOW)?.resetsAt).toBe(Date.UTC(2026, 9, 26, 15, 30));
    expect(limitHit(OLDER, NOW)?.resetsAt).toBe(AT_3PM);
  });
  test("the weekly window, by its word, with a weekday", () => {
    expect(limitHit(WEEKLY, NOW)).toEqual({ window: "weekly", at: NOW, resetsAt: THU_3PM, text: WEEKLY });
  });
  test("no reset named: an hour from now", () => {
    expect(limitHit(CODEX, NOW)).toEqual({ window: "fiveHour", at: NOW, resetsAt: NOW + HIT_HOLD, text: CODEX });
  });
  test("a hit stands until its reset plus the grace", () => {
    const hit = limitHit(SPENT, NOW);
    expect(hitStands(hit, AT_3PM + HIT_GRACE - 1)).toBe(true);
    expect(hitStands(hit, AT_3PM + HIT_GRACE)).toBe(false);
    expect(hitStands(null, NOW)).toBe(false);
  });
});

describe("observe", () => {
  const H = 60 * 60_000;
  const rows = [row(NOW - H, 2), row(NOW - 4 * H, 1), row(NOW - 2 * H, null), row(NOW - 5 * H, 100), row(NOW - 6 * H, 5), row(NOW - H, 7, "codex"), row(NOW - H, 3, "voice")];
  test("Claude dollars over the last five hours against the figure; the edge and null dollars count nothing", () => {
    expect(observe(cap(), rows, { observedFiveHourUsd: 10 }, NOW)).toEqual(cap({ fiveHour: { used: 0.3, resetsAt: null, readAt: NOW }, source: "observed" }));
  });
  test("no figure: no window, and unknown unless a hit stands", () => {
    expect(observe(cap(), rows, DEFAULT_CAPACITY, NOW)).toEqual(cap());
    const hit = limitHit(SPENT, NOW);
    expect(observe(cap({ hit }), rows, DEFAULT_CAPACITY, NOW)).toEqual(cap({ hit, source: "observed" }));
  });
  test("a Codex harness and an endpoint reading are left as they are", () => {
    const codex = { ...emptyCapacity("codex") };
    expect(observe(codex, rows, { observedFiveHourUsd: 10 }, NOW)).toBe(codex);
    const read = cap({ fiveHour: win(0.5), source: "endpoint" });
    expect(observe(read, rows, { observedFiveHourUsd: 10 }, NOW)).toBe(read);
  });
});

test("stale: past READ_EVERY, or never read", () => {
  expect(stale(win(0.1, null, NOW - READ_EVERY), NOW)).toBe(false);
  expect(stale(win(0.1, null, NOW - READ_EVERY - 1), NOW)).toBe(true);
  expect(stale(null, NOW)).toBe(true);
});

test("resetWord: a time today, else a weekday", () => {
  expect(resetWord(AT_3PM, NOW)).toBe("15:00");
  expect(resetWord(THU_3PM, NOW)).toBe("Thu");
});

describe("decide", () => {
  const S = DEFAULT_CAPACITY;
  test("interactive always goes; unknown holds nothing", () => {
    const hit = limitHit(SPENT, NOW);
    expect(decide(cap({ hit, fiveHour: win(1) }), "interactive", S, NOW)).toBe("go");
    expect(decide(cap(), "low", S, NOW)).toBe("go");
  });
  test("the thresholds, per priority", () => {
    expect(decide(cap({ fiveHour: win(0.69), source: "endpoint" }), "low", S, NOW)).toBe("go");
    expect(decide(cap({ fiveHour: win(0.7), source: "endpoint" }), "low", S, NOW)).toEqual({ hold: "window", until: AT_3PM, why: "the 5-hour window is at 70% (resets 15:00)" });
    expect(decide(cap({ fiveHour: win(0.89), source: "endpoint" }), "normal", S, NOW)).toBe("go");
    expect(decide(cap({ fiveHour: win(0.9), source: "endpoint" }), "normal", S, NOW)).toEqual({ hold: "window", until: AT_3PM, why: "the 5-hour window is at 90% (resets 15:00)" });
    expect(decide(cap({ weekly: win(0.85, THU_3PM), source: "endpoint" }), "low", S, NOW)).toEqual({ hold: "window", until: THU_3PM, why: "the weekly window is at 85% (resets Thu)" });
    expect(decide(cap({ weekly: win(0.85, THU_3PM), source: "endpoint" }), "normal", S, NOW)).toBe("go");
    expect(decide(cap({ fiveHour: win(0.92, null), source: "observed" }), "normal", S, NOW)).toEqual({ hold: "window", until: null, why: "the 5-hour window is at 92%" });
  });
  test("the settings move the thresholds", () => {
    expect(decide(cap({ fiveHour: win(0.5), source: "endpoint" }), "low", { ...S, lowHold: 0.5 }, NOW)).toMatchObject({ hold: "window" });
  });
  test("a hit holds normal and low until its reset plus the grace, then is forgotten", () => {
    const hit = limitHit(SPENT, NOW);
    const c = cap({ hit, source: "observed" });
    expect(decide(c, "normal", S, NOW)).toEqual({ hold: "hit", until: AT_3PM + HIT_GRACE, why: "the 5-hour window is spent (resets 15:00)" });
    expect(decide(c, "low", S, AT_3PM + HIT_GRACE - 1)).toMatchObject({ hold: "hit" });
    expect(decide(c, "low", S, AT_3PM + HIT_GRACE)).toBe("go");
  });
  test("a stale endpoint window is no reading", () => {
    expect(decide(cap({ fiveHour: win(0.95, AT_3PM, NOW - READ_EVERY - 1), source: "endpoint" }), "low", S, NOW)).toBe("go");
  });
});

test("normalizeCapacity", () => {
  expect(normalizeCapacity(undefined)).toEqual(DEFAULT_CAPACITY);
  expect(normalizeCapacity({ lowHold: 0.5, normalHold: 2, weeklyLowHold: 0, observedFiveHourUsd: 40 })).toEqual({ lowHold: 0.5, normalHold: 0.9, weeklyLowHold: 0.85, observedFiveHourUsd: 40 });
  expect(normalizeCapacity({ observedFiveHourUsd: -1 }).observedFiveHourUsd).toBeNull();
  expect(normalizeCapacity({ observedFiveHourUsd: "40" }).observedFiveHourUsd).toBeNull();
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `bun test src/core/capacity.test.ts`
Expected: FAIL, the module is not found.

- [ ] **Step 4: Write `src/core/capacity.ts`**

Header comment: what a `Capacity` is, where each source comes from, that the file is pure and browser-safe, and that the fixtures come from the probes record. Import `Harness` and `Priority` as types from `./types` and `CostEntry` from `./costs`. `resetWord` uses `toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false })` for the time and `toLocaleDateString("en-US", { weekday: "short" })` for the weekday; "same local day" compares `getFullYear`, `getMonth` and `getDate`.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `bun test src/core/capacity.test.ts && bun run typecheck`
Expected: PASS, clean.

- [ ] **Step 6: Commit**

```bash
git add src/core/capacity.ts src/core/capacity.test.ts src/core/types.ts
git commit -m "feat(capacity): the capacity model: readUsage, limitHit, observe and decide (FR-036)"
```

---

### Task 3: the limited status

**Files:**
- Modify: `src/core/types.ts:1007-1016` (`RunStatus`), `:1232-1234` (after `Run.error`), `:2415` (`Flow.parkedFor`); `src/core/driver.ts:235-253` (`exitOutcome`), `:312-342` (a field on `RunCtx`), `:538-557` (`result`), `:559-567` (`exited`), `:569` (`finish`); `src/core/driver.test.ts:38` (the exit describe); `src/core/testdata/fake-claude.ts:11-56` (the header) and `:128` (`onUser`); `src/core/claudedrive.test.ts:25` (the mode union), `:96` (`done`); `ui/src/fixit.ts:33-40`; `ui/src/components/RunSheet.tsx:47-54`

**Interfaces:**
- Consumes: `isLimitText` from Task 2.
- Produces in `src/core/types.ts`:

```ts
export type RunStatus =
  | "working" | "waiting" | "idle" | "done" | "failed"
  /** the harness reported the plan's usage limit: the work is sound and
   *  waits for the reset (FR-036); `error` is the limit text */
  | "limited"
  | "stopped";

export interface Run {
  ...
  /** the last usage limit the harness reported on this run, as it said it;
   *  a job ends `limited` on it, a chat stays idle and carries it (FR-036) */
  limited?: { at: number; text: string };
}

export interface Flow { ...; parkedFor?: "budget" | "stage" | "capacity"; }
```

with the `parkedFor` comment extended: "or because its step's run ended `limited`; continuing runs the step again".

- Produces in `src/core/driver.ts`:

```ts
export function exitOutcome(flags, exit, label): { status: "done" | "failed" | "stopped" | "limited"; error?: string };
export class RunCtx {
  /** limited replies in a row on this process; a good reply starts it over */
  private limitedRow = 0;
  finish(status: "done" | "failed" | "stopped" | "limited", error?: string): void;
}
```

Behaviour:
- `exitOutcome`: after the stop, the caught error and the clean chat end, when `isLimitText(tail)`: `{ status: "limited", error: tail }`; else the failure it always gave.
- `RunCtx.result(result, problem)`: `this.run.result = result` first, as now; then when `problem !== null && isLimitText(problem)`, `this.limited(problem)` and return; else `this.limitedRow = 0` and the rest as now.
- `private limited(text)`: `this.run.limited = { at: Date.now(), text }`; `this.limitedRow += 1`; a chat on its first limited reply in a row: a note step `the plan's usage limit: <text>`, `denyAll`, status `idle` with `prompt` null when active, `changed()`; a chat on its second: `finish("failed", text)`; a job: `finish("limited", text)`.
- `RunCtx.exited`: when `out.status === "limited"`, set `run.limited` the same way and `finish("limited", out.error)`; the `away` logic applies only to a failure, as now.
- `fake-claude.ts` gains two modes, both documented in the header: `limited` answers every user message with `{ type: "result", subtype: "success", is_error: true, result: "You've hit your limit · resets 3pm", num_turns: 1, total_cost_usd: 0, duration_ms: 2, session_id: "sess-1" }`; `limitdie` writes `You've hit your limit · resets 3pm\n` to stderr and exits 1 before any result.
- `ui/src/fixit.ts` `FIX_WATCH` gains `limited: "the agent hit the plan's limit"`; `RunSheet.tsx` `STATUS_WORD` gains `limited: "waiting for capacity"`. Both are `Record<RunStatus, string>`, so typecheck needs them in this task; the rest of the page is Task 5.

- [ ] **Step 1: Write the failing tests in `src/core/driver.test.ts`**

A new `describe` after the exit one, using the file's `makeCtx` and `notes`:

```ts
describe("the plan's usage limit (FR-036)", () => {
  const LIMIT = "You've hit your limit · resets 3pm";
  const reply = { text: "", costUsd: 0, durationMs: 1, turns: 1 };
  test("a job's result whose problem is the limit ends the run limited, with the text", () => {
    const { run, ctx, ended } = makeCtx();
    ctx.result({ ...reply, text: LIMIT }, LIMIT);
    expect([run.status, run.error, run.limited?.text, ended]).toEqual(["limited", LIMIT, LIMIT, ["limited"]]);
  });
  test("a chat's limited reply goes idle with a note; a second in a row fails the run", () => {
    const { run, ctx } = makeCtx(true);
    ctx.result(reply, "usage limit reached\ntry later");
    expect([run.status, notes(run), run.limited?.text]).toEqual(["idle", ["the plan's usage limit: usage limit reached\ntry later"], "usage limit reached\ntry later"]);
    run.status = "working";
    ctx.result(reply, "usage limit reached");
    expect([run.status, run.error]).toEqual(["failed", "usage limit reached"]);
  });
  test("a good reply between two limited ones starts the count over", () => {
    const { run, ctx } = makeCtx(true);
    ctx.result(reply, LIMIT);
    run.status = "working";
    ctx.result({ ...reply, text: "fine" }, null);
    run.status = "working";
    ctx.result(reply, LIMIT);
    expect(run.status).toBe("idle");
  });
  test("a reply that mentions a limit in passing, or fails for another reason, is not one", () => {
    const a = makeCtx();
    a.ctx.result({ ...reply, text: "I checked the rate limit handling; usage limit tests pass" }, null);
    expect(a.run.status).toBe("done");
    const b = makeCtx();
    b.ctx.result(reply, "stopped after 3 turns without finishing");
    expect([b.run.status, b.run.limited]).toEqual(["failed", undefined]);
  });
  test("a process that dies with the limit on stderr is limited too, unless it was stopped", () => {
    expect(exitOutcome({ stopping: false, ending: false }, { code: 1, stderr: `${LIMIT}\n` }, "Claude Code")).toEqual({ status: "limited", error: LIMIT });
    expect(exitOutcome({ stopping: true, ending: false }, { code: 1, stderr: LIMIT }, "Claude Code")).toEqual({ status: "stopped" });
    expect(exitOutcome({ stopping: false, ending: true }, { code: 0, stderr: LIMIT }, "Claude Code")).toEqual({ status: "done" });
    const { run, ctx, ended } = makeCtx();
    ctx.exited({ code: 1, stderr: "usage limit reached" });
    expect([run.status, run.error, run.limited?.text, ended]).toEqual(["limited", "usage limit reached", "usage limit reached", ["limited"]]);
  });
});
```

- [ ] **Step 2: Write the failing tests in `src/core/claudedrive.test.ts`**

Add `"limited" | "limitdie"` to `drive`'s mode union and `r.status === "limited"` to `done`. A new `describe`:

```ts
describe("the plan's usage limit (FR-036)", () => {
  const LIMIT = "You've hit your limit · resets 3pm";
  test("a job whose result is the limit ends limited with the text", async () => {
    const d = await drive("limited");
    const run = await d.until(d.done, "the limit");
    expect([run.status, run.error, run.limited?.text, run.result?.costUsd]).toEqual(["limited", LIMIT, LIMIT, 0]);
    expect(d.ended).toEqual(["limited"]);
  });
  test("a chat's limited reply goes idle and is said in the timeline; the second in a row fails the run", async () => {
    const d = await drive("limited", "hello", undefined, { chat: true });
    await d.until((r) => r.status === "idle", "the first reply");
    expect(d.run.steps.filter((s) => s.kind === "note").map((s) => s.text)).toEqual([`the plan's usage limit: ${LIMIT}`]);
    d.run.status = "working";
    d.driver.say("again");
    const run = await d.until(d.done, "the second reply");
    expect([run.status, run.error]).toEqual(["failed", LIMIT]);
    // the fake is still up: a chat's failure kills nothing here, the Runner would
    d.driver.stop();
  });
  test("a CLI that exits with the limit on stderr ends limited", async () => {
    const d = await drive("limitdie");
    const run = await d.until(d.done, "the exit");
    expect([run.status, run.error]).toEqual(["limited", LIMIT]);
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `bun test src/core/driver.test.ts src/core/claudedrive.test.ts -t "FR-036"`
Expected: FAIL (`limited` is not a status; the fake has no such mode).

- [ ] **Step 4: Add the types, the two `RunCtx` paths, the fake's modes and the two UI words**

`driver.ts` imports `isLimitText` from `./capacity`. Update the `DriveCtx.result` comment: "A job ends with it: done, failed with `problem`, or limited when the problem is the plan's usage limit."

- [ ] **Step 5: Run the tests, typecheck and lint**

Run: `bun test src/core/driver.test.ts src/core/claudedrive.test.ts src/core/runner.test.ts ui/src/fixit.test.ts && bun run typecheck && bun run lint`
Expected: PASS, clean (`FIX_WATCH` and `STATUS_WORD` carry the new word; `activeStatus`, `isRunActive` and `runState` in `ui/src/allagents.ts` need no change, since `limited` is not active and reads as ended).

- [ ] **Step 6: Commit**

```bash
git add src/core/types.ts src/core/driver.ts src/core/driver.test.ts src/core/testdata/fake-claude.ts src/core/claudedrive.test.ts ui/src/fixit.ts ui/src/components/RunSheet.tsx
git commit -m "feat(capacity): a run whose reply is the plan's usage limit ends limited, not failed"
```

---

### Task 4: the Codex driver

**Files:**
- Modify: `src/core/codexrun.test.ts:1148-1155` (beside the failed-turn test)

**Interfaces:**
- Consumes: Task 3's `RunCtx.result`, which reads `turnResult`'s `problem` (`src/core/codexrun.ts:745-773`: a `failed` turn's `error.message` and `additionalDetails`, joined with a newline).
- Produces: nothing new. The Codex driver hands its turn's problem to `ctx.result` already, so the status comes from Task 3; this task pins it and records P4's text in the fixture.

- [ ] **Step 1: Write the test**

After "a failed turn fails a job with codex's error", using the file's `drive` and `d.ended` (widen `ended` to `limited` if it lists statuses):

```ts
test("a failed turn whose error is the plan's usage limit ends the job limited, not failed (FR-036)", async () => {
  const d = await drive(() => ({
    turns: [[{ complete: "failed", error: { message: "usage limit reached", codexErrorInfo: null, additionalDetails: "try later" } }]],
  }));
  const run = await d.until(d.ended, "the limit");
  expect([run.status, run.error, run.limited?.text]).toEqual(["limited", "usage limit reached\ntry later", "usage limit reached\ntry later"]);
});
```

Replace `usage limit reached` with P4's observed text when the probes record has one, in both the test and the record's "What the code takes" list; `isLimitText` in Task 2 gains a pattern if the text matches neither.

- [ ] **Step 2: Run the test to verify it passes**

Run: `bun test src/core/codexrun.test.ts -t "FR-036"`
Expected: PASS on Task 3's code alone. If it fails, the text did not match `isLimitText`: fix the pattern in `core/capacity.ts` with a line in `capacity.test.ts`, never the driver.

- [ ] **Step 3: Run the four gates**

Run: `bun run typecheck && bun run lint && bun test && bun run build`
Expected: all pass.

- [ ] **Step 4: Commit**

```bash
git add src/core/codexrun.test.ts src/core/capacity.ts src/core/capacity.test.ts
git commit -m "test(capacity): a Codex turn that fails on the usage limit ends the job limited"
```

---

### Task 5: a flow parks, and the page reads limited

**Files:**
- Modify: `src/core/flow.ts:384` (before the `failed` branch of `onRun`), `:406-434` (`resume`); `src/core/flow.test.ts`; `ui/src/components/RunChip.tsx:40-46`; `ui/src/components/RunSheet.tsx:471-476`; `ui/src/styles.css:4583-4585` (after `.st-stopped`); `ui/src/waiting.test.ts:63-100`

**Interfaces:**
- Consumes: `limitHit`, `resetWord` from Task 2; Task 3's status and `Flow.parkedFor` `capacity`; `FakeRunner.end(id, status, text, error)` in `flow.test.ts:78`.
- Produces: in `core/flow.ts`'s `onRun`, a step run that ends `limited` parks the flow: `live.flow.parkedFor = "capacity"` and `this.park(live, reason)` with `reason` = `waiting for capacity (resets <resetWord(hit.resetsAt, now)>)` when `limitHit(run.error ?? "", this.now())` reads it, else `waiting for capacity`. In `resume`, `parkedFor === "capacity"` with a choice other than `stop` deletes `parkedFor`, `resetStep(step)` and `runStep` again, as the budget park does without its grace; the session is not kept (plan 2 brings `--resume` with the retry). The page: `RunChip` says `<verb> waits for capacity` long and `limited` short; the run sheet shows, for `status === "limited"`, `<div className="outcome warn"><p>The plan's usage limit: {run.error}</p><p>The work is sound; it waits for the reset.</p></div>`; `.st-limited { --tone: var(--lichen); }` beside `.st-stopped`.

- [ ] **Step 1: Write the failing flow test in `src/core/flow.test.ts`**

In the `Flows` describe, with the file's `setup`, `repo`, `TWO` and `flush`:

```ts
test("a step run that ends limited parks the flow for capacity; continue runs the step again (FR-036)", async () => {
  const NOW = Date.UTC(2026, 9, 26, 12);
  const { runner, flows } = setup({ now: () => NOW });
  const flow = flows.start(repo(), TWO, "", DEFAULT_AGENT);
  runner.end("run1", "limited", "", "You've hit your limit · resets 3pm");
  await flush();
  const parked = flows.get(flow.id);
  expect([parked?.status, parked?.parkedFor, parked?.steps[0]?.status, parked?.steps[0]?.reason]).toEqual(["gated", "capacity", "gated", "waiting for capacity (resets 15:00)"]);
  flows.resume(flow.id, "continue");
  await flush();
  expect([flows.get(flow.id)?.steps[0]?.status, flows.get(flow.id)?.parkedFor, runner.specs.length]).toEqual(["running", undefined, 2]);
  const b = setup({ now: () => NOW });
  const fb = b.flows.start(repo(), TWO, "", DEFAULT_AGENT);
  b.runner.end("run1", "limited", "", "usage limit reached");
  await flush();
  expect(b.flows.get(fb.id)?.steps[0]?.reason).toBe("waiting for capacity (resets 13:00)");
});
```

- [ ] **Step 2: Write the failing page tests in `ui/src/waiting.test.ts`**

Beside the first `failedRows` test, with the file's `run` helper:

```ts
test("a limited run is not a failed row (FR-036)", () => {
  expect(failedRows([run("a", "limited", 5), run("b", "failed", 6)], {}, [])).toMatchObject([{ kind: "run", id: "b" }]);
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `bun test src/core/flow.test.ts ui/src/waiting.test.ts -t "FR-036"`
Expected: the flow test FAILS (the run reads as failed and the flow ends); the waiting test passes already, since `failedRows` keeps to `failed`, and stays as the pin.

- [ ] **Step 4: Implement the park, the resume, the chip and sheet words and the CSS**

`flow.ts` imports `limitHit` and `resetWord` from `./capacity`. Update the `parkedFor` comment in `types.ts` if Task 3 left it short.

- [ ] **Step 5: Run the tests, typecheck, lint and build**

Run: `bun test src/core/flow.test.ts ui/src && bun run typecheck && bun run lint && bun run build`
Expected: PASS, clean, built.

- [ ] **Step 6: Commit**

```bash
git add src/core/flow.ts src/core/flow.test.ts src/core/types.ts ui/src/components/RunChip.tsx ui/src/components/RunSheet.tsx ui/src/styles.css ui/src/waiting.test.ts
git commit -m "feat(capacity): a flow parks on a limited step and the page says waiting for capacity"
```

---

### Task 6: the settings, the hub and the route

**Files:**
- Create: `src/server/capacity.ts`, `src/server/capacity.test.ts`
- Modify: `src/core/types.ts:609-676` (`CanopyConfig`), `:1630` (after the `health` event), `:3272-3274` (after `HealthInfo`); `src/core/store.ts:77-79` (the defaults) and `:198-200` (`normalize`); `src/server/index.ts:232` (imports), `:328` (`ServerState`), `:3117-3118` (the handle chain), `:4738` (`onChange`), `:4900-4903` (after `health` is built), `:5911` (start), `:5956` (stop); `src/core/callers.test.ts:5-8`

**Interfaces:**
- Consumes: Task 2's model and `normalizeCapacity`; `readCosts` from `core/costledger.ts`; `configDir` from `core/store.ts`; `loadConfig`; `isHarness`, `HARNESSES` from `core/types.ts`; `json` as `server/health.ts:71` has it.
- Produces in `src/core/types.ts`:

```ts
export interface CanopyConfig { ...; /** the capacity governor's thresholds and the observed dollar figure (core/capacity, FR-036) */ capacity: CapacitySettings; }

/** a start a pump holds for capacity (plan 2 fills it; this plan serves none) */
export interface HeldStart { id: string; what: string; repoId: string; priority: Priority; why: string; since: number }
/** `GET /api/capacity` and the `capacity` event */
export interface CapacityInfo { capacity: Capacity[]; held: HeldStart[]; settings: CapacitySettings }

export type ServerEvent = ... | { type: "capacity"; capacity: CapacityInfo } | ...
```

(`Capacity` and `CapacitySettings` are `import type`d from `./capacity`; the cycle is type-only.) `store.ts` defaults `capacity: normalizeCapacity(undefined)` and normalises `capacity: normalizeCapacity(cfg.capacity)`.

- Produces in `src/server/capacity.ts`:

```ts
export const capacityFile = (): string => join(configDir(), "capacity.json");
/** P2's endpoint for one harness; wired to nothing until Eric's call 8 */
export type UsageReader = (harness: Harness) => Promise<unknown>;
export interface CapacityHubDeps {
  broadcast: (ev: ServerEvent) => void;
  /** the ledger's rows since `since` (readCosts) */
  ledger: (since: number) => Promise<CostEntry[]>;
  config: () => Promise<Pick<CanopyConfig, "capacity">>;
  /** where the hits live across restarts: capacityFile() */
  file: string;
  reader?: UsageReader | null;
  now?: () => number;
  /** ms between a change and its event, so a burst sends one; 250 */
  debounce?: number;
  /** READ_EVERY and READ_IDLE, for tests */
  timings?: { every: number; idle: number };
}
export class CapacityHub {
  constructor(deps: CapacityHubDeps);
  /** reads the file, drops expired hits, reads once, starts the clock */
  start(): Promise<void>;
  stop(): void;
  /** a run change: a new `limited` mark becomes its harness's hit */
  onRun(run: Run): void;
  get(harness: Harness): Capacity;
  /** one per HARNESSES entry, in that order */
  list(): Capacity[];
  info(): CapacityInfo;
  /** the readings now: the endpoint where there is a reader, else the ledger */
  refresh(): Promise<void>;
  /** null for a path outside /api/capacity */
  handle(req: Request, url: URL): Promise<Response | null>;
}
```

Behaviour:
- The file is `{ "hits": { "<harness>": CapacityHit } }`, written with `mode: 0o600` and `chmod`ed when it exists already; a file that is missing, does not parse, or holds a harness `isHarness` refuses or a hit missing a field is read as no hits, and the next write replaces it. A hit is dropped when `!hitStands(hit, now)`, at start and on every refresh, and the file is rewritten then; `start` awaits that write.
- `onRun`: a run with `limited` whose `at` differs from the last one seen for that run id: `hit = limitHit(run.limited.text, run.limited.at)` (null when the text no longer reads as one: ignore); `cap.hit = hit`; `cap.source` becomes `observed` unless it is `endpoint`; write the file; reschedule the clock at `every`; `changed()`.
- `refresh`: `settings = (await deps.config()).capacity`; `rows = await deps.ledger(now - FIVE_HOURS)` once; per harness: drop an expired hit; with a reader, `readUsage(await reader(h), now)` sets both windows and `source: "endpoint"` (a reader that throws keeps the last reading and logs once per harness); without one, `observe`. Then `changed()`.
- The clock: one timer, rescheduled after each refresh at `every` while any hit stands, else `idle`.
- `changed()` is the health hub's pattern (`server/health.ts:285-305`): debounced, the event only when `JSON.stringify(info())` differs from the last sent.
- `handle`: `GET /api/capacity` answers `json(this.info())`; anything else null. `GET` needs `read` by the default rule in `core/callers.ts`, so no rule is added; the test pins it.

Wiring in `src/server/index.ts`: `capacity: CapacityHub` on `ServerState` after `health`, built after `health` as

```ts
const capacity = new CapacityHub({
  broadcast: (ev) => broadcast(state, ev),
  ledger: (since) => (ledgerOff ? Promise.resolve([]) : readCosts(since)),
  config: loadConfig,
  file: capacityFile(),
  reader: null,
});
```

(`ledgerOff` is defined at `:4907` already; move the hub below it); `state.capacity.onRun(run)` after `state.costs.onRun(run)` at `:4738`; `const capacityRes = await state.capacity.handle(req, url); if (capacityRes) return capacityRes;` after the health line at `:3118`; `if (process.env["NODE_ENV"] !== "test") void state.capacity.start().catch((err) => console.error("canopy: capacity", err));` beside `state.landing.start()` at `:5911`; `state.capacity.stop()` beside `state.health.stop()` at `:5956`.

- [ ] **Step 1: Write the failing rights line in `src/core/callers.test.ts`**

In "a GET needs read" at `:5-8`, add `"/api/capacity"` to the list of paths.

- [ ] **Step 2: Write the failing tests in `src/server/capacity.test.ts`**

```ts
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CAPACITY, HIT_GRACE, type CapacitySettings } from "../core/capacity";
import type { CostEntry } from "../core/costs";
import type { CapacityInfo, Run, ServerEvent } from "../core/types";
import { CapacityHub } from "./capacity";

let dir = "";
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "canopy-capacity-"));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});
let hubs: CapacityHub[] = [];
afterEach(() => {
  for (const h of hubs) h.stop();
  hubs = [];
});

const NOW = Date.UTC(2026, 9, 26, 12);
const AT_3PM = Date.UTC(2026, 9, 26, 15);
const LIMIT = "You've hit your limit · resets 3pm";
const H = 60 * 60_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const limited = (over: Partial<Run> = {}): Run => ({ id: "r1", repoId: "a", action: "ask", verb: "ask", progress: "", expectsChange: false, chat: false, harness: "claude", note: "", status: "limited", startedAt: NOW, steps: [], prompt: null, error: LIMIT, limited: { at: NOW, text: LIMIT }, ...over });
const row = (at: number, usd: number | null, service: CostEntry["service"] = "claude"): CostEntry => ({ at, service, provider: "anthropic", model: null, repo: null, repoName: null, run: null, label: null, session: null, usd, tokens: null, seconds: null });

function hub(opts: { file?: string; rows?: CostEntry[]; reader?: (h: string) => Promise<unknown>; now?: number; settings?: Partial<CapacitySettings>; timings?: { every: number; idle: number } } = {}) {
  const events: CapacityInfo[] = [];
  const now = opts.now ?? NOW;
  const h = new CapacityHub({
    broadcast: (ev: ServerEvent) => {
      if (ev.type === "capacity") events.push(ev.capacity);
    },
    ledger: async () => opts.rows ?? [],
    config: async () => ({ capacity: { ...DEFAULT_CAPACITY, ...opts.settings } }),
    file: opts.file ?? join(dir, `${crypto.randomUUID()}.json`),
    reader: opts.reader ?? null,
    now: () => now,
    debounce: 5,
    timings: opts.timings ?? { every: 20, idle: 10_000 },
  });
  hubs.push(h);
  return { h, events };
}

test("a limited run becomes its harness's hit, the event goes out once, and the file keeps it at 0600", async () => {
  const file = join(dir, "hit.json");
  const { h, events } = hub({ file });
  await h.start();
  const before = events.length;
  h.onRun(limited());
  h.onRun(limited());
  await sleep(30);
  expect(h.get("claude")).toMatchObject({ source: "observed", hit: { window: "fiveHour", at: NOW, resetsAt: AT_3PM, text: LIMIT } });
  expect(h.get("codex").hit).toBeNull();
  expect(events.length).toBe(before + 1);
  expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ hits: { claude: { window: "fiveHour", at: NOW, resetsAt: AT_3PM, text: LIMIT } } });
  expect((await stat(file)).mode & 0o777).toBe(0o600);
});

test("a restart inside the window keeps the hit; one after the reset plus the grace drops it and rewrites the file", async () => {
  const file = join(dir, "restart.json");
  const a = hub({ file });
  await a.h.start();
  a.h.onRun(limited());
  await sleep(10);
  const b = hub({ file, now: AT_3PM });
  await b.h.start();
  expect(b.h.get("claude").hit?.text).toBe(LIMIT);
  const c = hub({ file, now: AT_3PM + HIT_GRACE });
  await c.h.start();
  expect(c.h.get("claude").hit).toBeNull();
  expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ hits: {} });
});

test("a file that cannot be read, or names a harness canopy lacks, starts clean and is replaced by the next hit", async () => {
  const file = join(dir, "bad.json");
  await writeFile(file, "{nope");
  const { h } = hub({ file });
  await h.start();
  expect(h.list().map((c) => c.hit)).toEqual([null, null]);
  await writeFile(file, JSON.stringify({ hits: { gemini: { window: "fiveHour", at: NOW, resetsAt: AT_3PM, text: "x" }, claude: { window: "fiveHour" } } }));
  const again = hub({ file });
  await again.h.start();
  expect(again.h.list().map((c) => c.hit)).toEqual([null, null]);
  again.h.onRun(limited());
  await sleep(10);
  expect(JSON.parse(await readFile(file, "utf8")).hits.claude.text).toBe(LIMIT);
});

test("the ledger: Claude dollars over the last five hours against the figure; no figure is no reading", async () => {
  const rows = [row(NOW - H, 2), row(NOW - 4 * H, 1), row(NOW - 2 * H, null), row(NOW - 6 * H, 5), row(NOW - H, 7, "codex")];
  const { h } = hub({ rows, settings: { observedFiveHourUsd: 10 } });
  await h.start();
  expect(h.get("claude")).toMatchObject({ fiveHour: { used: 0.3, resetsAt: null, readAt: NOW }, weekly: null, source: "observed" });
  expect(h.get("codex")).toMatchObject({ fiveHour: null, source: "unknown" });
  const none = hub({ rows });
  await none.h.start();
  expect(none.h.get("claude")).toMatchObject({ fiveHour: null, source: "unknown" });
});

test("a reader is asked at start, at every while a hit stands, at idle otherwise; the event only on change", async () => {
  let calls = 0;
  const reader = async () => {
    calls += 1;
    return { five_hour: { utilization: 32, resets_at: "2026-10-26T14:10:00Z" }, seven_day: { utilization: 61, resets_at: "2026-10-29T15:00:00Z" } };
  };
  const { h, events } = hub({ reader, timings: { every: 20, idle: 10_000 } });
  await h.start();
  expect(calls).toBe(2);
  expect(h.get("claude")).toMatchObject({ fiveHour: { used: 0.32, resetsAt: Date.UTC(2026, 9, 26, 14, 10), readAt: NOW }, weekly: { used: 0.61 }, source: "endpoint" });
  await sleep(80);
  expect(calls).toBe(2);
  const sent = events.length;
  h.onRun(limited());
  await sleep(120);
  expect(calls).toBeGreaterThanOrEqual(6);
  expect(h.get("claude").source).toBe("endpoint");
  expect(events.length).toBe(sent + 1);
});

test("GET /api/capacity answers the info with no held starts; other paths are not its", async () => {
  const { h } = hub({ settings: { lowHold: 0.6 } });
  await h.start();
  const res = await h.handle(new Request("http://x/api/capacity"), new URL("http://x/api/capacity"));
  const info = (await res!.json()) as CapacityInfo;
  expect(info.capacity.map((c) => c.harness)).toEqual(["claude", "codex"]);
  expect(info.held).toEqual([]);
  expect(info.settings.lowHold).toBe(0.6);
  expect(await h.handle(new Request("http://x/api/health"), new URL("http://x/api/health"))).toBeNull();
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `bun test src/server/capacity.test.ts src/core/callers.test.ts`
Expected: the hub's file is not found; the callers line passes already (a GET reads by default) and stays as the pin.

- [ ] **Step 4: Add the types, the config field, `src/server/capacity.ts` and the wiring**

Header for the hub: "The capacity readings: one `Capacity` per harness from the ledger, from every limited run and, once Eric's call 8 says so, from the usage endpoint; the hits across restarts in `capacity.json`; the route and the event. Bun-only."

- [ ] **Step 5: Run the tests, typecheck, lint and build**

Run: `bun test src/server/capacity.test.ts src/core/callers.test.ts src/core/store.test.ts src/server && bun run typecheck && bun run lint && bun run build`
Expected: PASS, clean, built. A server test that builds a `ServerState` by hand (grep `health: new HealthHub` in `src/server/*.test.ts`) gets a `capacity` the same way.

- [ ] **Step 6: Commit**

```bash
git add src/core/types.ts src/core/store.ts src/server/capacity.ts src/server/capacity.test.ts src/server/index.ts src/core/callers.test.ts
git commit -m "feat(capacity): the capacity hub reads the ledger and every limit hit, keeps the hit across restarts and serves /api/capacity"
```

---

### Task 7: the chip

**Files:**
- Create: `ui/src/capacity.ts`, `ui/src/capacity.test.ts`, `ui/src/components/Capacity.tsx`
- Modify: `ui/src/store.ts:766` (the state), `:1155` (the action), `:1688` (the event counter), `:1866`, `:2276` and `:2439` (beside each `loadHealth` call), `:2061` (the initial value), `:2497` (a backend's removal), `:3063-3067` (the event), `:3438-3447` (beside `loadHealth`); `ui/src/api.ts:642-645`; `ui/src/components/TopBar.tsx:814` and `:888`; `ui/src/styles.css:12042` (after `.health-count`)

**Interfaces:**
- Consumes: `Capacity`, `CapacitySettings`, `CapacityWindow`, `Window`, `hitStands`, `stale`, `decide` from `src/core/capacity.ts`; `CapacityInfo` from `src/core/types.ts`; `HANGS_RIGHT`, `leavesPop`, `useFitPop` from `ui/src/pop.ts` and `escapeCloses` from `ui/src/surface.ts`, as `Health.tsx:8-12` does.
- Produces in `ui/src/capacity.ts` (pure):

```ts
export const CAPACITY_GLYPH = "◔";
/** the reset: time left on the same local day, "2h10" or "35m" ("now" once past), else the weekday, "Thu"; "" for null */
export function windowWord(resetsAt: number | null, now: number): string;
/** "5h 32% · 2h10", "week 61% · Thu", "5h 40%" with no reset, "5h no reading" for null */
export function capacityLine(w: Window | null, kind: CapacityWindow, now: number): string;
/** how old a reading is: "just now" under a minute, else "3m ago", else "2h ago" */
export function ageWord(ms: number): string;
/** rust while a hit stands or normal work would be held; lichen while low work would be; else moss */
export function capacityTone(cap: Capacity, settings: CapacitySettings, now: number): "moss" | "lichen" | "rust";
export interface CapacityRow {
  backend: string;
  cap: Capacity;
  tone: "moss" | "lichen" | "rust";
  /** the two lines, or none for `unknown` with no hit */
  lines: string[];
  /** "endpoint, read 3m ago", "observed from the ledger", "no reading" */
  source: string;
}
/** every backend that answered, in `order`, one row per harness */
export function capacityRows(info: Readonly<Record<string, CapacityInfo>>, order: readonly string[], now: number): CapacityRow[];
/** the chip's word: "limit" while any hit stands, else the highest 5-hour share as "5h 32%", else "no reading" */
export function capacityWord(rows: readonly CapacityRow[]): string;
/** the worst tone over the rows; moss when there are none */
export function rowsTone(rows: readonly CapacityRow[]): "moss" | "lichen" | "rust";
```

`capacityTone` reads a stale endpoint window as null, as `decide` does: rust when `hitStands` or `decide(cap, "normal", ...)` holds, lichen when `decide(cap, "low", ...)` holds, else moss. A row's `source` for `endpoint` says how old the newer of its two windows is through `ageWord(now - readAt)`; `lines` holds `capacityLine` for each window that is not null. The popover's "limit hit <age>" uses `ageWord` too, so the file never reads the clock itself.

- Produces in `ui/src/components/Capacity.tsx`: `CapacityChip`, built like `HealthChip` (`Health.tsx:187-232`: `useFitPop`, `leavesPop`, `escapeCloses`, the `settings` wrapper and `settings-pop`), without a `PopGrip` (the popup registry is FR-047's; plan 2 adds the entry with the costs block). It renders null when `capacityRows` is empty. The button is `className={`mini capacity-chip ${tone}${open ? " on" : ""}`}` with the glyph and `capacityWord`, `aria-label` `Capacity: <word>`. The popover, `capacity-pop`, has a head `<h3 className="panel-label">capacity</h3>`, then per row: the backend's name (`baseName` is not needed; the backend key as `Health.tsx` shows it), the harness's name from `AGENT_NAME` in `ui/src/runs.ts`, the lines each on its own line coloured by the row's tone, the source, and for a standing hit `limit hit <ago>: <text>`; for a row with no lines, `no reading` and the line `set capacity.observedFiveHourUsd in config.json to estimate from the ledger`. Under the rows, when any run in the store has `status === "limited"`, a `waiting for capacity` label and one line per such run (`verb` and the repo's name, `error`), newest first. Nothing in the inbox.

- Produces in `ui/src/store.ts`: `capacity: Record<string, CapacityInfo>` beside `health`, `loadCapacity(backend?)` beside `loadHealth` with the same `capacityEvents` guard, the `capacity` event case, the load beside each `loadHealth` call, and the backend's entry dropped where `health`'s is. In `ui/src/api.ts`: `capacity: (b: string = homeName()) => req<CapacityInfo>(b, "/api/capacity")`; an older backend's 404 is caught in `loadCapacity`, as `loadHealth` catches, and leaves no entry.
- `TopBar.tsx`: `<CapacityChip />` before `<HealthChip />` in both clusters (`:814`, `:888`).
- CSS after `.health-count` at `:12042`: `.capacity-chip` as `.health-chip` (inline-flex, gap 4px, `color: var(--ink-faint)`), `.capacity-chip.lichen { color: var(--lichen); }`, `.capacity-chip.rust { color: var(--rust); }`, `.capacity-pop { width: 360px; }`, `.capacity-row` a block with a 4px gap and `.capacity-row .moss|.lichen|.rust` colouring their lines with the same tokens, `.capacity-limited` the list under the rows with no bullets. No new colours.

- [ ] **Step 1: Write the failing tests in `ui/src/capacity.test.ts`**

```ts
import { describe, expect, test } from "bun:test";
import { DEFAULT_CAPACITY, emptyCapacity, limitHit, type Capacity } from "../../src/core/capacity";
import type { CapacityInfo } from "../../src/core/types";
import { ageWord, capacityLine, capacityRows, capacityTone, capacityWord, rowsTone, windowWord } from "./capacity";

const NOW = Date.UTC(2026, 9, 26, 12);
const THU_3PM = Date.UTC(2026, 9, 29, 15);
const min = (n: number) => n * 60_000;
const win = (used: number, resetsAt: number | null = NOW + min(130)) => ({ used, resetsAt, readAt: NOW });
const cap = (over: Partial<Capacity> = {}): Capacity => ({ ...emptyCapacity("claude"), ...over });
const info = (capacity: Capacity[]): CapacityInfo => ({ capacity, held: [], settings: DEFAULT_CAPACITY });

test("windowWord: time left today, else the weekday", () => {
  expect(windowWord(NOW + min(130), NOW)).toBe("2h10");
  expect(windowWord(NOW + min(120), NOW)).toBe("2h00");
  expect(windowWord(NOW + min(35), NOW)).toBe("35m");
  expect(windowWord(NOW - 1, NOW)).toBe("now");
  expect(windowWord(THU_3PM, NOW)).toBe("Thu");
  expect(windowWord(null, NOW)).toBe("");
});

test("capacityLine and ageWord", () => {
  expect(capacityLine(win(0.32), "fiveHour", NOW)).toBe("5h 32% · 2h10");
  expect(capacityLine(win(0.61, THU_3PM), "weekly", NOW)).toBe("week 61% · Thu");
  expect(capacityLine(win(0.4, null), "fiveHour", NOW)).toBe("5h 40%");
  expect(capacityLine(null, "weekly", NOW)).toBe("week no reading");
  expect([ageWord(0), ageWord(min(3)), ageWord(min(125))]).toEqual(["just now", "3m ago", "2h ago"]);
});

describe("capacityTone", () => {
  const S = DEFAULT_CAPACITY;
  test("moss under the low hold, lichen between the holds, rust at the normal hold or on a hit", () => {
    expect(capacityTone(cap({ fiveHour: win(0.69), source: "endpoint" }), S, NOW)).toBe("moss");
    expect(capacityTone(cap({ fiveHour: win(0.7), source: "endpoint" }), S, NOW)).toBe("lichen");
    expect(capacityTone(cap({ weekly: win(0.85, THU_3PM), source: "endpoint" }), S, NOW)).toBe("lichen");
    expect(capacityTone(cap({ fiveHour: win(0.9), source: "endpoint" }), S, NOW)).toBe("rust");
    expect(capacityTone(cap({ hit: limitHit("You've hit your limit · resets 3pm", NOW), source: "observed" }), S, NOW)).toBe("rust");
    expect(capacityTone(cap(), S, NOW)).toBe("moss");
  });
});

test("capacityRows: every backend that answered, in order, one row per harness; the word and the tone over them", () => {
  const mac = info([cap({ fiveHour: win(0.32), weekly: win(0.61, THU_3PM), source: "endpoint" }), emptyCapacity("codex")]);
  const mini = info([cap({ fiveHour: win(0.75, null), source: "observed" }), emptyCapacity("codex")]);
  const rows = capacityRows({ mac, mini }, ["mini", "mac", "old"], NOW);
  expect(rows.map((r) => [r.backend, r.cap.harness, r.tone, r.lines])).toEqual([
    ["mini", "claude", "lichen", ["5h 75%"]],
    ["mini", "codex", "moss", []],
    ["mac", "claude", "moss", ["5h 32% · 2h10", "week 61% · Thu"]],
    ["mac", "codex", "moss", []],
  ]);
  expect(rows.map((r) => r.source)).toEqual(["observed from the ledger", "no reading", "endpoint, read just now", "no reading"]);
  expect(capacityWord(rows)).toBe("5h 75%");
  expect(rowsTone(rows)).toBe("lichen");
  expect(capacityRows({}, ["mac"], NOW)).toEqual([]);
  expect(capacityWord([])).toBe("no reading");
  const hit = capacityRows({ mac: info([cap({ hit: limitHit("usage limit reached", NOW), source: "observed" })]) }, ["mac"], NOW);
  expect([capacityWord(hit), rowsTone(hit)]).toEqual(["limit", "rust"]);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test ui/src/capacity.test.ts`
Expected: FAIL, the module is not found.

- [ ] **Step 3: Write `ui/src/capacity.ts`, the component, the store, the API call, the top bar and the CSS**

- [ ] **Step 4: Run the tests, typecheck, lint and build, then look at it**

Run: `bun test ui/src && bun run typecheck && bun run lint && bun run build`
Expected: PASS, clean, built. Then start a scratch server as the memory note "Scratch canopy server for UI checks" says, with `capacity.observedFiveHourUsd` set to `40` in its `config.json` and a few runs' worth of ledger rows copied from the Mac's `costs/`: the chip reads `5h <n>%` and its popover shows the two rows and the source; with no figure it reads `no reading` and the popover says how to set one.

- [ ] **Step 5: Commit**

```bash
git add ui/src/capacity.ts ui/src/capacity.test.ts ui/src/components/Capacity.tsx ui/src/store.ts ui/src/api.ts ui/src/components/TopBar.tsx ui/src/styles.css
git commit -m "feat(capacity): a top-bar chip shows each backend's usage windows and their resets (FR-028)"
```

---

### Task 8: the docs and the gates

**Files:**
- Modify: `docs/architecture.md:366` (a new section after "Costs"), `:11` (the `ClaudeDriver` sentence in "src/core"), `:134` (the `HealthChip` sentence in "Health"); `SPEC.md:57`; `README.md:112` (after the Keep awake bullet); `FEATURES.md:55-58`, `:80-82` and `:128`; `docs/superpowers/plans/README.md`

**Interfaces:**
- Consumes: the completed interfaces from Tasks 1 to 7, the source spec, and the live-check results.
- Produces: documentation and feature status that describe the implemented scope, with later phases still marked open. No new runtime interface.

- [ ] **Step 1: `docs/architecture.md`**

A new `## Capacity` section between "Costs" and "The secret store", starting "Capacity (FR-036, plan 1; FR-028's chip).", saying: `core/capacity.ts` is the model, pure and browser-safe, one `Capacity` per harness with `fiveHour` and `weekly` windows, a `source` (`endpoint`, `observed`, `unknown`) and a `hit`; `readUsage` reads the usage endpoint's answer (P2), `isLimitText` and `limitHit` read a harness's limit text (P1, P4, P5: the window from the word "week", the reset in the backend's clock, `HIT_HOLD` when none is named), `observe` the ledger's Claude dollars over the last five hours against `observedFiveHourUsd`, `decide` what a priority may do at `LOW_HOLD`, `NORMAL_HOLD`, `WEEKLY_LOW_HOLD` and on a hit until `HIT_GRACE` past its reset, holding nothing on `unknown`; `RunCtx.result` and `exitOutcome` in `core/driver.ts` end a run `limited` (a `RunStatus`, not a failure, with `error` the text and `Run.limited` the mark) when a result's problem or an exit's stderr is a limit, for both harnesses, a chat staying idle with the reply said as a note and failing on the second limited reply in a row; a flow parks `capacity` on it and `resume` runs the step again; `server/capacity.ts`'s `CapacityHub` (`state.capacity`) keeps the readings, reads the ledger on a clock (`READ_EVERY` while a hit stands, `READ_IDLE` otherwise), takes a hit from every `limited` run through `onRun`, writes the hits to `capacity.json` (0600, no credential) and drops them past the grace, has a `reader` seam for the endpoint that plan 1 wires to nothing (Eric's call 8), serves `GET /api/capacity` (`CapacityInfo`, `held` empty until plan 2) and the `capacity` event; the settings under `capacity` in the config (`normalizeCapacity`), edited by hand in plan 1; the page: `ui/src/capacity.ts` (`windowWord`, `capacityLine`, `capacityTone`, `capacityRows`, `capacityWord`) and `CapacityChip` in the top bar beside the health chip, its popover with the rows, the source and the limited runs under "waiting for capacity"; what plan 2 brings (priorities, `may` in the pumps, the retries, `canopy capacity`, the costs block). In "src/core" at `:11`, after the `ClaudeDriver` sentence, one sentence pointing at this section for the `limited` end. In "Health" at `:134`, after "`HealthChip` in the top bar's chips", add "beside `CapacityChip` (the Capacity section)".

- [ ] **Step 2: `SPEC.md`**

Line 57, after the `prices.json` clause: `, and capacity.json (the last usage-limit hit per harness, so a restart inside a spent window keeps it; no credential)` in the file's own style with backticks around the name. No decision changes: the 2026-08-24 decision and the Out of scope line stand.

- [ ] **Step 3: `README.md`**

After the Keep awake bullet at `:112`: `- **Capacity.** A top-bar chip shows how much of each login's usage window is spent and when it resets, per backend, from the cost ledger and from every limit the agent reports; a run that hits the limit ends as waiting for capacity rather than failed. Set capacity.observedFiveHourUsd in config.json to estimate from the ledger.`

- [ ] **Step 4: `FEATURES.md` and the plans README**

Move the `### FR-036` block from `## Open` to the top of `## In Progress` and append to its Spec line: `Plan 1 shipped <date> (the probes record, the model, the limited status in both harnesses, the capacity hub and capacity.json, the chip); plan 2 (priorities, the holds, the retries, canopy capacity, the costs block) open; plan 3 (the credits lane) held for Eric.` Move the `### FR-028` block to `## Shipped` with `· shipped <date>` on its second line and the sentence `Shipped as FR-036 plan 1's chip: one line per window and backend, with the reset.` In `docs/superpowers/plans/README.md`, add the row `| [Capacity governor, plan 1: the probes, the model and the limited status](2026-10-26-capacity-governor-1.md) | shipped | <date> | [capacity governor](../specs/2026-10-25-capacity-governor-design.md) |` above the scenario gates row, and set this plan's Status line to shipped with the merge commit.

- [ ] **Step 5: Run every gate**

Run: `bun run typecheck && bun run lint && bun test && bun run build`
Expected: all pass. Then `~/.claude/skills/verify-build/clean-rebuild.sh verify "capacityLine"` proves the served bundle is the new one.

- [ ] **Step 6: Commit**

```bash
git add docs/architecture.md SPEC.md README.md FEATURES.md docs/superpowers/plans/README.md docs/superpowers/plans/2026-10-26-capacity-governor-1.md
git commit -m "docs(capacity): architecture, SPEC, README and the feature list for plan 1"
```

---

## Live check, before the branch is called done

With a scratch canopy (the "Scratch canopy server for UI checks" memory note) on a throwaway repo:

1. `curl -s -H "X-Canopy-Token: $TOKEN" http://127.0.0.1:<port>/api/capacity` answers two capacities, `held: []` and the default settings; the chip is absent from the page while both read `no reading` only if no backend answered, so here it reads `no reading`.
2. Put `"capacity": { "observedFiveHourUsd": 40 }` in the scratch `config.json`, copy this month's `costs/<YYYY-MM>.jsonl` from the Mac's config dir beside it, restart: the chip reads `5h <n>%`, the popover says `observed from the ledger`.
3. Write `<scratch>/capacity.json` by hand as `{"hits":{"claude":{"window":"fiveHour","at":<now ms>,"resetsAt":<now ms + 600000>,"text":"You've hit your limit · resets 3pm"}}}`, restart: the chip reads `limit` in rust; twelve minutes later it is back to the share and the file reads `{"hits":{}}`.
4. Start a chat on the repo with a `claude` stand-in on PATH that prints the fake's `limited` result (`FAKE_CLAUDE_MODE=limited bun src/core/testdata/fake-claude.ts` behind a wrapper script named `claude`): the reply is said as the plan's limit, the chat stays open, the chip reads `limit`, `capacity.json` holds the hit, and the run is not in waiting on you's failed group.
5. A job the same way ends `waiting for capacity` on its chip and sheet, and `GET /api/runs` shows `status: "limited"`.

## Decisions this plan makes beyond the spec

- The `limited` end is read in one place for both harnesses, `RunCtx.result` and `exitOutcome` in `core/driver.ts`, rather than in each driver: both drivers already hand their turn's problem to `ctx.result`, and the driver tests pin the end as the spec asks. A text is read only from a result's problem or an exit's stderr, never from a reply's own text.
- `Run.limited` carries the hit for the hub, because a chat stays `idle` on a limited reply and its status cannot say so.
- "Twice in a row" is counted per process in plan 1: a chat's second limited reply fails the run. A job ends on its first; plan 2's retry keeps its own count across the runs it starts.
- The hub takes a `reader` seam and the server wires `null`: `source: endpoint` waits on P2's terms reading and Eric's call 8, so plan 1 runs `observed` or `unknown` and the chip says so. The settings are edited by hand in `config.json` like `prices.json`; `POST /api/capacity`, `/read` and `/release` come with plan 2's costs block and holds.
- `readUsage` reads the keys the public readers of the endpoint use (`five_hour`, `seven_day`, `utilization`, `resets_at`), a `utilization` above 1 as a percentage; P2's record corrects the fixture if the shape differs.
- P1 and P5 need a spent window: the record says `not observed yet` until one comes, and the fixtures hold the spec's expected text and the older `|<unix seconds>` form, which `limitHit` reads too.
- An observed window has no `resetsAt` (a rolling sum resets nowhere) and its `used` may pass 1; a stale endpoint window reads as no reading in `decide` and the tone, since a window read is never trusted for long.
- A flow parks on a limited step with `parkedFor: "capacity"` and `resume` runs the step again without its session; plan 2 resumes the session (`--resume`) when it starts the step on the capacity event.
- The chip's popover has no `PopGrip` in plan 1 (FR-047's popup registry would need an entry); the limited runs are listed there under "waiting for capacity", and waiting on you is untouched, since `failedRows` keeps to `failed` already.
- `windowWord` shows the time left on the same local day (`2h10`), as the spec's example line reads, and the weekday otherwise; `resetWord` in core shows the clock time (`15:00`) for a sentence.
- `Priority` lands in `types.ts` now, because `decide` takes one; nothing sets a priority on a start until plan 2.
- FR-028 moves to Shipped as absorbed by this chip (the spec's call 6).
