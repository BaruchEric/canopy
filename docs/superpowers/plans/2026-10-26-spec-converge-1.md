# Spec converge, plan 1: the schedule trigger source (FR-041)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Status:** implemented on private `feat/oct26-batch`; final verification pending; not shipped on `main`. Plan 2 remains open.

**Goal:** a third trigger source, `schedule`: a rule in `triggers.json` with a
cron line fires on the flows-lock holder's 30 s tick, makes one event per
local repo it takes (or for the one repo it names), skips a repo whose last
run under the rule still goes, catches one missed slot up on start, lands its
branch through the landing queue by default (`land: queue`), can be fired by
hand for every repo or one (`fire {rule, repo}`), and shows its cron, next
fire, last fire and skips on its rule card.

**Architecture:** the pure half is `core/trigger.ts`: the rule's new keys in
`parseRules`, `dueRules` (which rules fire at a time, the repos each takes,
the skips) and `scheduleEvent`. The hub in `server/triggers.ts` ticks inside
its existing `pump`, keeps the slots it took in memory, and the server's
`startTriggerRun` honours `land` by cutting the branch without `openPr`. A
landed entry moves the event to `merged` through `fromLanding`. The triggers
view draws the rule card from `TriggerRuleInfo`'s new fields. Plan 2 brings
the `spec-converge` workflow, the report on the rows and the panel,
`canopy spec drift` and the board chip; nothing here depends on it.

**Tech Stack:** Bun, TypeScript strict, React 19, bun:test. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-25-spec-converge-design.md`, the
"Plans" list's item 1. The index is
`docs/superpowers/specs/2026-10-25-software-factory-borrowings-design.md`.

## Global constraints

- The rule shape is the spec's, verbatim: `{"name": "spec-weekly", "source": "schedule", "cron": "0 5 * * 1", "repo": "*", "workflow": "spec-converge", "land": "queue", "only": ["spec-adopted"]}`.
- `cron` is a five-field line read by `parseCron` in `core/cron.ts`, at most `CRON_MAX` (100) characters, required on a schedule rule; `repo: "*"` is allowed only on a schedule rule; `only` takes `spec-adopted`, `dirty`, `unpushed`, `clean`; `land` is `queue` or `pr`, default `queue` on a schedule rule and `pr` on the others.
- A schedule rule has no `secretEnv` and no hook: `POST /api/hooks/schedule/<name>` is 404. `projects`, `levels`, `labels`, `org`, `clientId`, `ignore` and `api` are bad lines on it.
- The tick is the hub's 30 s `pump`; only the holder of the flows lock fires. A slot missed while canopy was down fires once on start unless the next slot is less than an hour away (`SCHEDULE_CATCH_UP`, 3 600 000 ms), in which case the missed slot is forgiven and the rule waits for that one. A restart never refires a slot an event already took.
- `nextFire` reads the cron in the backend's local time; the mini's container takes `TZ` from `.env` (`docs/deploy.md`), so `0 5 * * 1` is 05:00 there (the spec's probe P3).
- One event per repo per fire, keyed `<repo key>@<fire minute ISO>` (`repoKey` from `core/worktree.ts`, `toISOString()` of the minute), `short` the date, `title` `<workflow> on <repo name>, <day>`, no `link`, `source: "schedule"`, `service: "schedule"`, `SERVICE_NAME.schedule` "Schedule". Events start `queued` and go through `begin` like any trigger's, so the branch-slot cap (`BRANCH_RUNS_PER_REPO`, 3) holds.
- A repo whose last event under the rule still goes is skipped with no event; the card reads "skipped <repo>: last run still going"; at most `SKIPS_KEPT` (20) skips per rule, in memory.
- `POST /api/triggers/fire {rule}` on a schedule rule fires every matching repo now, `{rule, repo}` one. Both `operate`, as the callers table already says for `triggers/*`.
- `src/core/trigger.ts` stays browser-safe: it imports `core/cron.ts` and `core/actions.ts` (both pure) and never `core/worktree.ts`; the hub passes the repo key in.
- Plain words, no em dashes, sentence case headings (the unslop rules apply to docs and commit messages). Bun pins JS dates to UTC under test, so every schedule test passes explicit dates; Monday 2026-11-02T05:00:00Z is the fixture slot.
- All four gates pass before a task is done: `bun run typecheck`, `bun run lint`, `bun test`, `bun run build`.

## Review focus

Inputs the spec implies and no section of it names. Each has a test in the task that owns the code.

1. A cron whose slot never comes again (`0 5 31 2 *`): the rule is never due, `next` is absent and the card reads "never fires again" rather than the tick throwing or firing (Task 2, Task 6).
2. A tick late by minutes (the serial queue was busy): the slot is the cron's minute, not the tick's, so the key and `firstAt` name the slot and the next fire is a period on, not a period after the delay (Task 2).
3. A fire where every repo is busy, or the rule's workflow cannot run: the slot is still marked taken, one skip says why, and the rule does not fire again every 30 s until the next slot (Task 4).
4. A rule whose cron is edited while canopy runs: the next fire follows the new line from the last fire, and a slot the old line took is not taken again (Task 2).
5. A `land: queue` event whose branch the queue sent back or holds for approval: the event stays `ready` with the queue's reason, and an entry Eric lands by hand (which raises no `landed` notice) still moves it to `merged` (Task 3).

---

## File structure

- Modify `src/core/trigger.ts`: `schedule` in `TRIGGER_SOURCES`, the rule's `cron`, `land`, `only` and optional `secretEnv`, `TriggerRuleInfo`'s `next`, `lastFire`, `skips` and optional `hook`, `TriggerEvent.land`, the `fired` delivery, `parseRules`; then the clock: `dueRules`, `scheduleRepos`, `takesRepo`, `scheduleBusy`, `lastFire`, `nextFireOf`, `scheduleKey`, `fireMinute`, `scheduleNote`, `scheduleEvent`; then `fromRun`, `fromFlow`, `fromLanding` for `land: queue`.
- Modify `src/core/trigger.test.ts`.
- Modify `src/core/review.test.ts`: the SPEC.md approval pin.
- Modify `src/server/triggers.ts` and `src/server/triggers.test.ts`: `TriggerDeps.repos`, the tick in `pump`, `since` and `marks`, the skips, `info()`, the hook's 404, `fire` with a repo, `onLanding` with entries, `writer` for a schedule rule.
- Modify `src/server/index.ts`: `startTriggerRun` honours `land`, the hub's `repos` dep, `onLanding` passes entries.
- Modify `ui/src/triggers.ts`, `ui/src/triggers.test.ts`, `ui/src/components/Triggers.tsx`, `ui/src/api.ts`, `ui/src/store.ts`, `ui/src/styles.css`.
- Modify `docs/architecture.md`, `FEATURES.md`, `docs/superpowers/plans/README.md`.

---

### Task 1: the rule

**Files:**
- Modify: `src/core/trigger.ts:11-15` (`TRIGGER_SOURCES`, `SERVICE_NAME`), `:17-57` (`TriggerRule`), `:59-70` (`TriggerRuleInfo`), `:98-147` (`TriggerEvent`), `:159-163` (`Delivery`), `:193-199` (`DEFAULTS`), `:238-285` (`parseRule`), `:534-557` (`newEvent`), `:758-762` (`SAMPLE_TITLE`)
- Modify: `src/core/trigger.test.ts:32-56` (the fixtures), `:97-173` (the `parseRules` describe)

**Interfaces:**
- Consumes: `parseCron`, `CRON_MAX` from `core/cron.ts`.
- Produces in `src/core/trigger.ts`:

```ts
export const TRIGGER_SOURCES = ["sentry", "linear", "schedule"] as const;
export const SERVICE_NAME: Record<TriggerSource, string> = { sentry: "Sentry", linear: "Linear", schedule: "Schedule" };
export const TRIGGER_LANDS = ["queue", "pr"] as const;
/** how a trigger's branch reaches main: through the landing queue under the repo's review rules, or by a PR */
export type TriggerLand = (typeof TRIGGER_LANDS)[number];
export const SCHEDULE_ONLY = ["spec-adopted", "dirty", "unpushed", "clean"] as const;
export type ScheduleOnly = (typeof SCHEDULE_ONLY)[number];
/** a repo a schedule fire passed over, named on the rule's card */
export interface ScheduleSkip {
  /** the repo's name, or the rule's `repo` when it is not in the tree, or "every repo" */
  repo: string;
  why: string;
  at: number;
}

export interface TriggerRule {
  name: string;
  source: TriggerSource;
  /** the repo's id or its absolute path; "*" on a schedule rule takes every local repo */
  repo: string;
  workflow: string;
  /** absent on a schedule rule: nothing signs a clock */
  secretEnv?: string;
  /** schedule: the five-field cron line, read in the backend's local time */
  cron?: string;
  land: TriggerLand;
  /** schedule: what narrows the repos "*" takes; empty takes every local repo */
  only: ScheduleOnly[];
  ... the other keys as they are
}

export interface TriggerRuleInfo extends TriggerRule {
  /** the hook's path; a schedule rule has none */
  hook?: string;
  /** true on a schedule rule, which has nothing to set */
  secretSet: boolean;
  tokenSet: boolean;
  agentSet: boolean;
  install?: string;
  problem?: string;
  /** schedule: the next fire, unix ms; absent when the line never comes again */
  next?: number;
  /** schedule: when the rule last made events, unix ms */
  lastFire?: number;
  /** schedule: repos passed over at recent fires, newest first, at most SKIPS_KEPT */
  skips?: ScheduleSkip[];
}

export interface TriggerEvent {
  ...
  /** how the branch reaches main; absent on an event from before the key, which opened a PR */
  land?: TriggerLand;
}

export type Delivery =
  | { kind: "started" | "queued" | "ignored"; event: TriggerEvent }
  | { kind: "duplicate"; event: TriggerEvent }
  | { kind: "skip"; why: string }
  /** a schedule rule fired by hand: the events made and the repos passed over */
  | { kind: "fired"; events: TriggerEvent[]; skipped: ScheduleSkip[] };
```

`DEFAULTS.schedule` is `{ workflow: "spec-converge", api: "", labels: [], levels: [] }`. `SAMPLE_TITLE.schedule` is `"fired by hand"`. `newEvent` sets `land: rule.land`.

`parseRule` rules, each with the message the test pins, after the name and source checks and before the return:
- `repo` of `"*"` on a sentry or linear rule: `repo "*" is allowed only on a schedule rule`.
- schedule without `cron`: `cron is required on a schedule rule: five fields, minute hour day-of-month month day-of-week`; longer than `CRON_MAX`: `cron must be at most 100 characters`; `parseCron` error: `cron: <its error>`. `cron` on another source: `cron is for a schedule rule`.
- schedule with `secretEnv`: `secretEnv is not read by a schedule rule: nothing signs a clock`. The other sources keep today's required `secretEnv` and its prefix rule.
- schedule with `projects`, `levels`, `ignore`, `org` or `api`: `<key> is not read by a schedule rule`. `labels`, `clientId`, `clientSecretEnv` and `organization` fall to the existing "is for a linear rule" messages. `tokenEnv` is kept as it is on every source.
- `land` absent: `queue` on schedule, `pr` else; anything but `queue` or `pr`: `land must be queue or pr, not <v>`.
- `only` on another source: `only is for a schedule rule`; a word outside `SCHEDULE_ONLY`: `only must be some of spec-adopted, dirty, unpushed, clean, not <w>`; absent: `[]`.
- A schedule rule's `api` is `""` and its `secretEnv` is left off the object.

- [ ] **Step 1: Write the failing tests in `src/core/trigger.test.ts`**

Add `land: "pr"` and `only: []` to the `RULE` and `LINEAR` fixtures (`:32-56`), then inside `describe("parseRules")`:

```ts
test("a schedule rule as the spec writes it, and its defaults", () => {
  const { rules, problems } = parseRules(JSON.stringify({ rules: [{ name: "spec-weekly", source: "schedule", cron: "0 5 * * 1", repo: "*", workflow: "spec-converge", land: "queue", only: ["spec-adopted"] }] }));
  expect(problems).toEqual([]);
  expect(rules[0]).toEqual({ name: "spec-weekly", source: "schedule", repo: "*", workflow: "spec-converge", cron: "0 5 * * 1", projects: [], levels: [], labels: [], ignore: [], api: "", land: "queue", only: ["spec-adopted"] });
  expect(parseRules(JSON.stringify({ rules: [{ name: "s", source: "schedule", cron: "@weekly", repo: "web/shop" }] })).rules[0]).toMatchObject({ workflow: "spec-converge", land: "queue", only: [] });
  expect(SERVICE_NAME.schedule).toBe("Schedule");
});

test("a sentry or linear rule lands by a PR unless it says queue, and never takes *, cron or only", () => {
  expect(parseRules(JSON.stringify({ rules: [{ name: "shop", repo: "web/shop", secretEnv: "CANOPY_TRIGGER_SHOP_SECRET", land: "queue" }] })).rules[0]?.land).toBe("queue");
  const { problems } = parseRules(
    JSON.stringify({
      rules: [
        { name: "a", repo: "*", secretEnv: "CANOPY_TRIGGER_S" },
        { name: "b", repo: "x", secretEnv: "CANOPY_TRIGGER_S", cron: "0 5 * * 1" },
        { name: "c", repo: "x", secretEnv: "CANOPY_TRIGGER_S", only: ["dirty"] },
        { name: "d", repo: "x", secretEnv: "CANOPY_TRIGGER_S", land: "merge" },
      ],
    }),
  );
  expect(problems).toEqual(['rule 1: repo "*" is allowed only on a schedule rule', "rule 2: cron is for a schedule rule", "rule 3: only is for a schedule rule", "rule 4: land must be queue or pr, not merge"]);
});

test("a schedule rule needs a cron that reads, and takes no hook secret or service keys", () => {
  const { problems } = parseRules(
    JSON.stringify({
      rules: [
        { name: "a", source: "schedule", repo: "*" },
        { name: "b", source: "schedule", repo: "*", cron: "0 5 * *" },
        { name: "c", source: "schedule", repo: "*", cron: "0 5 * * 1", secretEnv: "CANOPY_TRIGGER_S" },
        { name: "d", source: "schedule", repo: "*", cron: "0 5 * * 1", only: ["weekends"] },
        { name: "e", source: "schedule", repo: "*", cron: "0 5 * * 1", projects: ["x"] },
        { name: "f", source: "schedule", repo: "*", cron: "0 5 * * 1", labels: ["x"] },
        { name: "g", source: "schedule", repo: "*", cron: "0 5 * * 1", clientId: "x", clientSecretEnv: "CANOPY_TRIGGER_X" },
        { name: "h", source: "schedule", repo: "*", cron: "x".repeat(101) },
        { name: "i", source: "schedule", repo: "*", cron: "0 5 * * 1", api: "https://x" },
      ],
    }),
  );
  expect(problems).toEqual([
    "rule 1: cron is required on a schedule rule: five fields, minute hour day-of-month month day-of-week",
    "rule 2: cron: a cron line has five fields: minute hour day-of-month month day-of-week",
    "rule 3: secretEnv is not read by a schedule rule: nothing signs a clock",
    "rule 4: only must be some of spec-adopted, dirty, unpushed, clean, not weekends",
    "rule 5: projects is not read by a schedule rule",
    "rule 6: labels is for a linear rule",
    "rule 7: clientId is for a linear rule",
    "rule 8: cron must be at most 100 characters",
    "rule 9: api is not read by a schedule rule",
  ]);
});

test("newEvent carries the rule's land", () => {
  expect(newEvent(RULE, INC, "web/shop", "sentry", 1000, null).land).toBe("pr");
  expect(newEvent({ ...RULE, land: "queue" }, INC, "web/shop", "sentry", 1000, null).land).toBe("queue");
});
```

Import `SERVICE_NAME` with the rest.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test src/core/trigger.test.ts -t "parseRules|newEvent carries"`
Expected: FAIL (`schedule` is not a source; `land` and `only` are missing from the fixtures' equality).

- [ ] **Step 3: Add the source, the keys and the checks**

In `src/core/trigger.ts` as the Interfaces block says. Update the header comment: "an outside event (a Sentry issue, a labeled Linear issue) or a clock (a schedule rule's cron line) starts a workflow on a branch run of its own". `TriggerRuleInfo.hook` and `TriggerRule.secretEnv` turning optional breaks `src/server/triggers.ts:253` and `:708`; make the two reads `r.secretEnv ? this.env(r.secretEnv) !== undefined : true` and `!rule || rule.source !== source || !rule.secretEnv` so typecheck holds, and set `hook` only on a sentry or linear rule in `info()`. Task 4 tests both. In `ui/src/components/Triggers.tsx`, `hookAddress(origin, rule.hook ?? "")` at `:131` and a `fired` arm in the done text at `:103` (`${d.events.length} started, ${d.skipped.length} skipped`) keep the UI's typecheck green; Task 6 builds on both.

- [ ] **Step 4: Run the tests and typecheck**

Run: `bun test src/core/trigger.test.ts src/server/triggers.test.ts ui/src/triggers.test.ts && bun run typecheck`
Expected: PASS; typecheck clean (the UI reads `rule.hook` only through `hookAddress` in `Triggers.tsx:131`, which Task 6 guards; until then pass `rule.hook ?? ""` there).

- [ ] **Step 5: Commit**

```bash
git add src/core/trigger.ts src/core/trigger.test.ts src/server/triggers.ts ui/src/components/Triggers.tsx
git commit -m "feat(triggers): the schedule source's rule: cron, land, only and repo * (FR-041)"
```

---

### Task 2: the clock

**Files:**
- Modify: `src/core/trigger.ts` (after `sampleIncoming`, `:764-774`), `src/core/trigger.test.ts` (a new describe at the end)

**Interfaces:**
- Consumes: `parseCron`, `nextFire` from `core/cron.ts`; `checkWhen` from `core/actions.ts`; `Repo`, `SpecState` from `core/types.ts`; Task 1's `TriggerRule`, `ScheduleSkip`, `eventLive`.
- Produces in `src/core/trigger.ts`:

```ts
/** a slot missed while canopy was down fires on start unless the next one is nearer than this */
export const SCHEDULE_CATCH_UP = 60 * 60 * 1000;
/** the skips a rule's card keeps, newest first */
export const SKIPS_KEPT = 20;
/** the minute a time falls in, unix ms */
export const fireMinute = (t: number): number => Math.floor(t / 60_000) * 60_000;
/** one event per repo per fire: `<repo key>@<fire minute ISO>` */
export const scheduleKey = (repoKey: string, at: number): string => `${repoKey}@${new Date(fireMinute(at)).toISOString()}`;
/** when a schedule rule last made events: the newest `firstAt` among the events with its name and `service: "schedule"`, by hand or by the tick, or null */
export function lastFire(rule: string, events: readonly TriggerEvent[]): number | null;
/** the first slot strictly after `last`, or null: not a schedule rule, a cron that does not read, or one that never comes again */
export function nextFireOf(rule: TriggerRule, last: number): number | null;
/** whether a repo passes the rule's `only` words; a repo with an error never does */
export function takesRepo(rule: TriggerRule, repo: Repo): boolean;
/** the repos a schedule rule takes from the local list: the one it names, by id or path, or every one `only` lets through when it is "*" */
export function scheduleRepos(rule: TriggerRule, repos: readonly Repo[]): Repo[];
/** whether the repo's last event under the rule keeps it busy: queued, working, waiting, ready or in review */
export function scheduleBusy(events: readonly TriggerEvent[], rule: string, repoId: string): boolean;

export interface ScheduleClock {
  /** when this server began keeping events (adopt), for the catch-up rule */
  since: number;
  /** by rule name: when this server last fired or passed the rule over, or first saw it */
  marks: ReadonlyMap<string, number>;
}
export interface ScheduleFire {
  rule: TriggerRule;
  /** the slot, a whole minute, unix ms */
  at: number;
  repos: Repo[];
  skipped: ScheduleSkip[];
  /** set when a slot missed while canopy was down is forgiven because this
   *  nearer slot is under SCHEDULE_CATCH_UP away: the hub marks the rule at
   *  `at` and makes no event, and the nearer slot fires as a steady one */
  waits?: number;
}
/** Which schedule rules fire at `now`, with the repos each takes and the ones it passes over. Pure. */
export function dueRules(rules: readonly TriggerRule[], events: readonly TriggerEvent[], now: number, repos: readonly Repo[], clock: ScheduleClock): ScheduleFire[];
/** the run's first message: no outside issue, so nothing is fenced */
export function scheduleNote(rule: TriggerRule, repo: Pick<Repo, "name">, at: number): string;
/** a new queued event for one repo of a fire; `source` is "schedule" from the tick and "manual" from a fire by hand */
export function scheduleEvent(rule: TriggerRule, repo: Pick<Repo, "id" | "name">, repoKey: string, at: number, now: number, source: "schedule" | "manual"): TriggerEvent;
```

`dueRules`, per rule with `source === "schedule"`:
1. `last` is the greater of `lastFire(rule.name, events)` and `clock.marks.get(rule.name)`; neither means the hub has not marked the rule yet, so it is not due.
2. `next = nextFireOf(rule, last)`; null or after `now` is not due.
3. `next < clock.since` means the slot came due while canopy was down: when `upcoming = nextFireOf(rule, now)` is less than `SCHEDULE_CATCH_UP` away the fire is `{ rule, at: fireMinute(now), repos: [], skipped: [], waits: upcoming }` (the hub marks the rule and nothing else happens; at `upcoming` the mark makes it a steady slot); else the fire is at `fireMinute(now)` with its repos. `next >= clock.since` is a steady slot: the fire is at `next`.
4. `repos` is `scheduleRepos(rule, repos)` less every repo `scheduleBusy` says, each of those a skip `{ repo: name, why: "last run still going", at }`. A named repo not in the list is a skip `{ repo: rule.repo, why: "no repo <rule.repo> in the tree", at }`.

`takesRepo`: `spec-adopted` is `repo.spec !== undefined && repo.spec !== "not-adopted"`; `dirty` is `checkWhen(repo, "dirty").ok`; `unpushed` is `checkWhen(repo, "unpushed").ok`; `clean` is `!checkWhen(repo, "dirty").ok`; every word must hold.

`scheduleNote(rule, repo, at)` is exactly `<workflow> on <name>: scheduled by canopy's <rule name> rule (<cron>) for <ISO of the fire minute>. No outside issue came in; work from the repository as it is.` so the branch reads `run/<workflow>-on-<name>-…`.

`scheduleEvent`: `id` as `newEvent` makes one, `rule`, `source`, `service: "schedule"`, `key: scheduleKey(repoKey, at)`, `short` the local date of `at` as `YYYY-MM-DD`, `title` `<workflow> on <name>, <that date>`, `note: scheduleNote(...)`, `repoId`, `workflow: rule.workflow`, `status: "queued"`, `land: rule.land`, `count: 1`, `firstAt: now`, `lastAt: now`; no `link`, `level`, `project` or `culprit`.

- [ ] **Step 1: Write the failing tests in `src/core/trigger.test.ts`**

```ts
describe("the schedule clock (FR-041)", () => {
  const MONDAY = Date.parse("2026-11-02T05:00:00Z");
  const HOUR = 3_600_000;
  const WEEK = 7 * 86_400_000;
  const SCHED: TriggerRule = { name: "spec-weekly", source: "schedule", repo: "*", workflow: "spec-converge", cron: "0 5 * * 1", projects: [], levels: [], labels: [], ignore: [], api: "", land: "queue", only: [] };
  const status = (over: Partial<RepoStatus> = {}): RepoStatus => ({ branch: "main", upstream: "origin/main", ahead: 0, behind: 0, files: [], lastCommit: null, user: null, ...over });
  const repo = (id: string, over: Partial<Repo> = {}): Repo => ({ id, name: id.split("/")[1] ?? id, path: `/dev/${id}`, group: "web", source: "root", status: status(), ...over });
  const REPOS = [repo("web/shop", { spec: "in-sync" }), repo("web/blog")];
  const clock = (since: number, marks: [string, number][] = []): ScheduleClock => ({ since, marks: new Map(marks) });
  const fired = (at: number, repoId = "web/shop", over: Partial<TriggerEvent> = {}): TriggerEvent => ({ ...scheduleEvent(SCHED, repo(repoId), `${repoId.split("/")[1]}-1a2b3c4d`, at, at + 10_000, "schedule"), ...over });

  test("due at the slot and within its minute, not before; the slot is the cron's minute even when the tick is late", () => {
    const c = clock(MONDAY - 86_400_000, [["spec-weekly", MONDAY - 86_400_000]]);
    expect(dueRules([SCHED], [], MONDAY - 1, REPOS, c)).toEqual([]);
    const got = dueRules([SCHED], [], MONDAY + 29_000, REPOS, c);
    expect(got.map((f) => [f.rule.name, f.at, f.repos.map((r) => r.id), f.skipped])).toEqual([["spec-weekly", MONDAY, ["web/shop", "web/blog"], []]]);
    expect(dueRules([SCHED], [], MONDAY + 3 * 60_000, REPOS, c)[0]?.at).toBe(MONDAY);
    expect(dueRules([RULE], [], MONDAY, REPOS, c)).toEqual([]);
  });

  test("a rule the hub has not marked is not due; a fire moves the next slot a week on; a line that never comes again is never due", () => {
    expect(dueRules([SCHED], [], MONDAY, REPOS, clock(MONDAY - 1))).toEqual([]);
    const c = clock(MONDAY - 86_400_000);
    expect(dueRules([SCHED], [fired(MONDAY)], MONDAY + 90_000, REPOS, c)).toEqual([]);
    expect(dueRules([SCHED], [fired(MONDAY)], MONDAY + WEEK, REPOS, c)[0]?.at).toBe(MONDAY + WEEK);
    expect(nextFireOf(SCHED, MONDAY + 10_000)).toBe(MONDAY + WEEK);
    expect(nextFireOf({ ...SCHED, cron: "0 5 31 2 *" }, MONDAY)).toBeNull();
    expect(nextFireOf(RULE, MONDAY)).toBeNull();
    expect(dueRules([{ ...SCHED, cron: "0 5 31 2 *" }], [fired(MONDAY)], MONDAY + WEEK, REPOS, c)).toEqual([]);
  });

  test("the newer of the mark and the newest event is the last fire, so a slot taken is not taken twice and a new cron counts from it", () => {
    expect(lastFire("spec-weekly", [fired(MONDAY), fired(MONDAY - WEEK, "web/blog")])).toBe(MONDAY + 10_000);
    expect(lastFire("spec-weekly", [event({ rule: "spec-weekly" })])).toBeNull();
    const taken = clock(MONDAY - 86_400_000, [["spec-weekly", MONDAY + 5_000]]);
    expect(dueRules([SCHED], [fired(MONDAY - WEEK)], MONDAY + 60_000, REPOS, taken)).toEqual([]);
    const daily = { ...SCHED, cron: "0 5 * * *" };
    expect(dueRules([daily], [fired(MONDAY)], MONDAY + 86_400_000, REPOS, clock(MONDAY - 86_400_000))[0]?.at).toBe(MONDAY + 86_400_000);
  });

  test("a slot missed while canopy was down fires once on start at the current minute, unless the next is under an hour away, which is then waited for", () => {
    const late = MONDAY + 2 * HOUR + 30_000;
    const caught = dueRules([SCHED], [fired(MONDAY - WEEK)], late, REPOS, clock(late))[0]!;
    expect([caught.at, caught.repos.length, caught.waits]).toEqual([MONDAY + 2 * HOUR, 2, undefined]);
    const hourly = { ...SCHED, cron: "0 * * * *" };
    const ten = MONDAY + 50 * 60_000;
    expect(dueRules([hourly], [fired(MONDAY - HOUR)], ten, REPOS, clock(ten))).toEqual([{ rule: hourly, at: ten, repos: [], skipped: [], waits: MONDAY + HOUR }]);
    const marked = clock(ten, [["spec-weekly", ten]]);
    expect(dueRules([hourly], [fired(MONDAY - HOUR)], ten + 60_000, REPOS, marked)).toEqual([]);
    expect(dueRules([hourly], [fired(MONDAY - HOUR)], MONDAY + HOUR, REPOS, marked)[0]).toMatchObject({ at: MONDAY + HOUR, repos: REPOS, waits: undefined });
  });

  test("a repo whose last event under the rule still goes is skipped and named", () => {
    const c = clock(MONDAY - 1, [["spec-weekly", MONDAY - WEEK + 10_000]]);
    const fire = (s: TriggerStatus) => dueRules([SCHED], [fired(MONDAY - WEEK, "web/shop", { status: s })], MONDAY, REPOS, c)[0]!;
    for (const s of ["queued", "working", "waiting", "ready", "review"] as const) {
      expect([s, fire(s).repos.map((r) => r.id), fire(s).skipped]).toEqual([s, ["web/blog"], [{ repo: "shop", why: "last run still going", at: MONDAY }]]);
    }
    for (const s of ["merged", "failed", "no-fix", "stopped", "closed", "ignored"] as const) expect([s, fire(s).skipped]).toEqual([s, []]);
    expect(scheduleBusy([fired(MONDAY, "web/shop", { status: "review", rule: "other" })], "spec-weekly", "web/shop")).toBe(false);
  });

  test("only narrows the repos a * rule takes; a named repo is found by id or path, or skipped as missing", () => {
    const dirty = repo("web/wiki", { status: status({ files: [{ path: "a.md" } as RepoFile] }) });
    const ahead = repo("web/docs", { status: status({ ahead: 2 }) });
    const all = [...REPOS, dirty, ahead];
    expect(scheduleRepos({ ...SCHED, only: ["spec-adopted"] }, all).map((r) => r.id)).toEqual(["web/shop"]);
    expect(scheduleRepos({ ...SCHED, only: ["dirty"] }, all).map((r) => r.id)).toEqual(["web/wiki"]);
    expect(scheduleRepos({ ...SCHED, only: ["unpushed"] }, all).map((r) => r.id)).toEqual(["web/docs"]);
    expect(scheduleRepos({ ...SCHED, only: ["clean"] }, all).map((r) => r.id)).toEqual(["web/shop", "web/blog", "web/docs"]);
    expect(scheduleRepos({ ...SCHED, only: ["clean", "spec-adopted"] }, all).map((r) => r.id)).toEqual(["web/shop"]);
    expect(takesRepo({ ...SCHED, only: ["clean"] }, repo("x", { error: "not a repo" }))).toBe(false);
    expect(scheduleRepos({ ...SCHED, repo: "/dev/web/blog" }, all).map((r) => r.id)).toEqual(["web/blog"]);
    expect(scheduleRepos({ ...SCHED, repo: "web/none" }, all)).toEqual([]);
    const f = dueRules([{ ...SCHED, repo: "web/none" }], [], MONDAY, all, clock(MONDAY - 1, [["spec-weekly", MONDAY - 1]]))[0]!;
    expect([f.repos, f.skipped]).toEqual([[], [{ repo: "web/none", why: "no repo web/none in the tree", at: MONDAY }]]);
  });

  test("scheduleEvent: the key, the date, the title, the note, no link", () => {
    const e = scheduleEvent(SCHED, repo("web/shop"), "shop-1a2b3c4d", MONDAY + 15_000, MONDAY + 20_000, "schedule");
    expect(e).toMatchObject({ rule: "spec-weekly", source: "schedule", service: "schedule", key: "shop-1a2b3c4d@2026-11-02T05:00:00.000Z", short: "2026-11-02", title: "spec-converge on shop, 2026-11-02", repoId: "web/shop", workflow: "spec-converge", status: "queued", land: "queue", count: 1, firstAt: MONDAY + 20_000, lastAt: MONDAY + 20_000 });
    expect([e.link, e.level, e.project, e.culprit]).toEqual([undefined, undefined, undefined, undefined]);
    expect(e.note).toBe("spec-converge on shop: scheduled by canopy's spec-weekly rule (0 5 * * 1) for 2026-11-02T05:00:00.000Z. No outside issue came in; work from the repository as it is.");
    expect(scheduleEvent(SCHED, repo("web/shop"), "k", MONDAY, MONDAY, "manual").source).toBe("manual");
    expect(scheduleKey("k", MONDAY + 59_000)).toBe("k@2026-11-02T05:00:00.000Z");
    expect(fireMinute(MONDAY + 59_999)).toBe(MONDAY);
  });
});
```

Import `dueRules`, `fireMinute`, `lastFire`, `nextFireOf`, `scheduleBusy`, `scheduleEvent`, `scheduleKey`, `scheduleRepos`, `takesRepo`, `type ScheduleClock` from `./trigger` and `Repo`, `RepoFile`, `RepoStatus`, `TriggerStatus` from `./types` (`TriggerStatus` from `./trigger`).

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test src/core/trigger.test.ts -t "schedule clock"`
Expected: FAIL, the names are not exported.

- [ ] **Step 3: Write the clock**

In `src/core/trigger.ts`, a section headed `/* ---------- the schedule source (FR-041) ---------- */` after `sampleIncoming`. Import `parseCron`, `nextFire` from `./cron` and `checkWhen` from `./actions`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test src/core/trigger.test.ts src/core/cron.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/trigger.ts src/core/trigger.test.ts
git commit -m "feat(triggers): dueRules, the per-repo key, catch-up and skips for a schedule rule"
```

---

### Task 3: the event's path through the queue

**Files:**
- Modify: `src/core/trigger.ts:577-602` (`fromRun`), `:606-645` (`fromFlow`), `:662-667` (`fromLanding`); `src/core/trigger.test.ts:526-556` (the `fromRun` describe), `:634-682` (`fromFlow`), `:575-587` (`fromLanding`); `src/core/review.test.ts:204` (the sort describe)

**Interfaces:**
- Consumes: `LandEntry`, `LandNotice` from `core/types.ts`.
- Produces in `src/core/trigger.ts`:

```ts
/** A committed event follows the landing queue: a landed entry, or a landed
 *  notice, for its branch makes it merged with no PR; the newest held notice
 *  gives it its reason. `entries` is the queue as `LandingInfo.entries` has it. */
export function fromLanding(e: TriggerEvent, notices: readonly LandNotice[], entries: readonly LandEntry[] = []): TriggerEvent;
```

`fromLanding` on a `ready` event with a branch: an entry with `id === e.branch` and `state === "landed"`, or a `landed` notice for the branch, makes `{ ...e, status: "merged", endedAt: entry.landedAt ?? notice.at ?? e.lastAt }` with `reason` deleted; else the held logic as it is. `fromRun` (`:597`) and `fromFlow` (`:639`): the committed reason is `committed; the landing queue sorts the branch` when `e.land === "queue"`, else the existing PR wording.

- [ ] **Step 1: Write the failing tests**

In `src/core/trigger.test.ts`, inside `describe("fromRun")`:

```ts
test("a queue event's committed reason names the queue, not a PR", () => {
  const e = event({ runId: "r1", status: "working", land: "queue" });
  expect(fromRun(e, run({ status: "done", branch: { ...branch, state: "ready" } }), 5)).toMatchObject({ status: "ready", reason: "committed; the landing queue sorts the branch" });
});
```

Inside `describe("fromFlow")`:

```ts
test("a queue event's done flow says the queue sorts it", () => {
  const e = event({ flowId: "f1", status: "working", land: "queue" });
  expect(fromFlow(e, flow({ status: "done", branch: { ...branch, state: "ready" } }), 5).reason).toBe("committed; the landing queue sorts the branch");
});
```

Inside `describe("fromLanding")`:

```ts
test("a landed entry, or a landed notice, moves a committed event to merged with no PR", () => {
  const e = event({ status: "ready", branch: "br1", land: "queue", reason: "committed; the landing queue sorts the branch" });
  const byEntry = fromLanding(e, [], [{ id: "br1", state: "landed", landedAt: 7 } as LandEntry]);
  expect(byEntry).toMatchObject({ status: "merged", endedAt: 7 });
  expect([byEntry.reason, byEntry.pr]).toEqual([undefined, undefined]);
  expect(fromLanding(e, [notice({ kind: "landed", at: 9 })])).toMatchObject({ status: "merged", endedAt: 9 });
  expect(fromLanding(e, [], [{ id: "br1", state: "waiting" } as LandEntry])).toBe(e);
  expect(fromLanding(e, [notice({ why: "needs your approval: 1 sensitive file" })], [{ id: "br1", state: "waiting" } as LandEntry]).reason).toBe("needs your approval: 1 sensitive file");
});
```

Import `LandEntry` from `./types`. In `src/core/review.test.ts`, inside `describe("the sort")`:

```ts
test("a SPEC.md-only diff is docs and still waits for approval: FR-041 keeps it on the sensitive list", async () => {
  const r = await sortOf(await branchWith({ "SPEC.md": "# x\n\n## Stack\n- Vite 8.3.2\n" }, { "SPEC.md": "# x\n\n## Stack\n- Vite 8.4.0\n" }));
  expect([r.verdict, classesOf(r)]).toEqual(["approve", { "SPEC.md": "docs" }]);
  expect(r.files[0]?.sensitive).toBe("instructions agents read");
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test src/core/trigger.test.ts -t "queue event|landed entry" && bun test src/core/review.test.ts -t "SPEC.md-only"`
Expected: the trigger tests FAIL (the reason names a PR; a landed entry changes nothing). The review test PASSES already: it pins what is, and stays.

- [ ] **Step 3: Change the three readers**

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test src/core/trigger.test.ts src/core/review.test.ts src/server/triggers.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/trigger.ts src/core/trigger.test.ts src/core/review.test.ts
git commit -m "feat(triggers): a land: queue event follows the landing queue to merged, and SPEC.md stays sensitive"
```

---

### Task 4: the hub's tick, catch-up, skips and fire

**Files:**
- Modify: `src/server/triggers.ts:1-12` (header), `:85-132` (`TriggerDeps`), `:176-193` (the fields), `:244-261` (`info`), `:304-324` (`adopt`), `:399-420` (`pump`), `:465-471` (`onLanding`), `:473-484` (`writer`), `:581-587` (`fire`), `:684-691` (the fire route), `:704-709` (`hook`); `src/server/triggers.test.ts:12` (`REPO`), `:35-66` (`hub`), a new describe at the end

**Interfaces:**
- Consumes: Task 2's `dueRules`, `scheduleEvent`, `scheduleRepos`, `scheduleBusy`, `lastFire`, `nextFireOf`, `fireMinute`, `SKIPS_KEPT`, `ScheduleClock`, `ScheduleSkip`; Task 3's `fromLanding`; `repoKey` from `core/worktree.ts`; `LandEntry` from `core/types.ts`.
- Produces in `src/server/triggers.ts`:

```ts
export interface TriggerDeps {
  ...
  /** every repo a schedule rule on "*" may take: on this machine, not on the forge, not an incubator seed; none when absent */
  repos?: () => Repo[];
}
export class TriggerHub {
  /** a fire by hand: a sentry or linear rule takes a made-up issue; a schedule rule fires every matching repo, or the one `repo` names (its id or path), with `only` left aside */
  fire(name: string, title: string, repo?: string): Promise<Delivery>;
  /** the landing queue's state: a committed event follows its branch's entry and notices */
  onLanding(notices: readonly LandNotice[], entries?: readonly LandEntry[]): void;
  /** the queued pass, which the schedule tick leads; a call while one is going returns that one */
  pump(): Promise<void>;
}
```

Behaviour:
- Fields: `since = 0`, `marks = new Map<string, number>()`, `skips = new Map<string, ScheduleSkip[]>()`, `pumpP: Promise<void> | null`.
- `adopt()` sets `this.since = this.now()` before `pump()`.
- `pump()`: when `pumping`, return `this.pumpP`; else the pass is `this.pumpP = (async () => { await this.tickSchedules(); ...the queued loop as it is... })()`.
- `tickSchedules()`, inside `this.queue`: `await this.loadRules()`; for each schedule rule with no mark and no event (`lastFire` null) set `marks.set(name, now)` (a rule first seen takes its first slot after that moment, never a missed one); then for each fire from `dueRules(this.rules, this.list(), now, this.deps.repos?.() ?? [], { since: this.since, marks: this.marks })`: `marks.set(rule.name, now)`; a fire with `waits` does nothing more; else `problem = await this.deps.workflowProblem(rule.workflow, fire.repos[0])` when the fire has repos, and when it is a string the fire makes no event and one skip `{ repo: rule.repo === "*" ? "every repo" : rule.repo, why: problem, at: fire.at }`; else for each repo `event = scheduleEvent(rule, repo, repoKey(repo.path), fire.at, now, "schedule")`, `this.set(event)`, `await this.begin(event, repo)`. Every skip in `fire.skipped` and the problem's go to `this.skip(rule.name, s)`, which keeps the newest `SKIPS_KEPT`.
- `info()`: a schedule rule gets `next` from `nextFireOf(r, max(lastFire, mark))` when either exists, `lastFire` from `lastFire(r.name, this.list())`, `skips` from the map (or `[]`), no `hook`, `secretSet: true`. Its `problem`: for `repo: "*"`, `workflowProblem(r.workflow, first local repo)`, or `no local repo for a schedule rule on "*"` when `deps.repos` gives none; a named repo resolves as today. The other rules are as today.
- `hook()`: a schedule rule, having no `secretEnv`, is a 404 like a rule of another source.
- `fire(name, title, repo?)`: a schedule rule goes to `fireSchedule(rule, repo)` inside `this.queue`: `at = fireMinute(now)`; repos are `[deps.repo(repo)]` (404 `no repo <repo> in the tree` when unknown) or `scheduleRepos(rule, deps.repos())`; each busy one (`scheduleBusy`) is a skip, each other gets `scheduleEvent(..., "manual")`, `set`, `begin`; answers `{ kind: "fired", events, skipped }` and records the skips. Needs `keeping`, as `deliver` does. The route passes `b["repo"]` when it is a string.
- `onLanding(notices, entries = [])` hands both to `fromLanding`.
- `writer()` returns null for `e.service === "schedule"`: nothing writes back.

- [ ] **Step 1: Extend the test world in `src/server/triggers.test.ts`**

Beside `REPO` (`:12`): `const BLOG = { id: "web/blog", name: "blog", path: "/dev/web/blog" } as Repo;`. Import `repoKey` from `../core/worktree`, `scheduleEvent`, `parseRules` from `../core/trigger`, `LandEntry` from `../core/types`, and `mkdir` with the fs imports.

- [ ] **Step 2: Write the failing tests**

```ts
describe("the schedule source (FR-041)", () => {
  const MONDAY = Date.parse("2026-11-02T05:00:00Z");
  const HOUR = 3_600_000;
  const WEEK = 7 * 86_400_000;
  let t: number;
  const schedHub = (over: Partial<TriggerDeps> = {}) => hub({ now: () => t, repos: () => [REPO, BLOG], workflowProblem: async () => null, ...over });
  const schedRules = (extra: Record<string, unknown> = {}) =>
    writeFile(join(dir, "triggers.json"), JSON.stringify({ rules: [{ name: "spec-weekly", source: "schedule", cron: "0 5 * * 1", repo: "*", workflow: "spec-converge", ...extra }] }));
  const slot = (iso: string) => (e: TriggerEvent) => e.key.endsWith(`@${iso}`);

  beforeEach(async () => {
    t = MONDAY - 86_400_000;
    await schedRules();
  });

  test("a rule first seen on Sunday fires Monday at 05:00, once, one queued-then-working event per local repo, keyed by the slot", async () => {
    const h = schedHub();
    await h.adopt();
    await h.idle();
    expect(h.list()).toEqual([]);
    t = MONDAY - 60_000;
    await h.pump();
    expect(h.list()).toEqual([]);
    t = MONDAY + 20_000;
    await h.pump();
    const made = h.list().map((e) => [e.repoId, e.key, e.status, e.source, e.service, e.land, e.title]).sort();
    expect(made).toEqual([
      ["web/blog", `${repoKey("/dev/web/blog")}@2026-11-02T05:00:00.000Z`, "working", "schedule", "schedule", "queue", "spec-converge on blog, 2026-11-02"],
      ["web/shop", `${repoKey("/dev/web/shop")}@2026-11-02T05:00:00.000Z`, "working", "schedule", "schedule", "queue", "spec-converge on shop, 2026-11-02"],
    ]);
    t = MONDAY + 90_000;
    await h.pump();
    expect(h.list()).toHaveLength(2);
    const info = await h.info();
    expect(info.rules[0]).toMatchObject({ cron: "0 5 * * 1", land: "queue", only: [], next: Date.parse("2026-11-09T05:00:00Z"), lastFire: MONDAY + 20_000, skips: [], secretSet: true });
    expect([info.rules[0]?.hook, info.rules[0]?.problem]).toEqual([undefined, undefined]);
    await h.idle();
    const disk = JSON.parse(await readFile(join(dir, "triggers", "events.json"), "utf8")) as { events: TriggerEvent[] };
    expect(disk.events).toHaveLength(2);
  });

  test("a fire past the branch-slot cap leaves its events queued, and a run ending starts them", async () => {
    busy = "shop has 3 branch runs going";
    const h = schedHub();
    await h.adopt();
    t = MONDAY + 20_000;
    await h.pump();
    expect(h.list().map((e) => [e.status, e.reason])).toEqual([["queued", busy], ["queued", busy]]);
    busy = null;
    h.onRun(run({ id: "other", status: "done" }));
    await h.pump();
    expect(h.list().map((e) => e.status)).toEqual(["working", "working"]);
  });

  test("a slot missed while canopy was down fires once on start, at the current minute", async () => {
    const first = schedHub();
    await first.adopt();
    t = MONDAY + 20_000;
    await first.pump();
    await first.idle();
    expect(first.list()).toHaveLength(2);
    runs = [];
    t = MONDAY + WEEK + 2 * HOUR;
    const second = schedHub();
    await second.adopt();
    await second.idle();
    expect(second.list().filter(slot("2026-11-09T07:00:00.000Z")).map((e) => e.firstAt)).toEqual([t, t]);
    t += 60_000;
    await second.pump();
    expect(second.list()).toHaveLength(4);
  });

  test("an hourly rule that missed a slot and starts ten minutes before the next waits for it instead of catching up", async () => {
    await schedRules({ cron: "0 * * * *" });
    const rule = parseRules(await readFile(join(dir, "triggers.json"), "utf8")).rules[0]!;
    const old = { ...scheduleEvent(rule, REPO, repoKey(REPO.path), MONDAY - HOUR, MONDAY - HOUR + 10_000, "schedule"), status: "merged" as const };
    await mkdir(join(dir, "triggers"), { recursive: true });
    await writeFile(join(dir, "triggers", "events.json"), JSON.stringify({ events: [old] }));
    t = MONDAY + 50 * 60_000;
    const h = schedHub();
    await h.adopt();
    await h.idle();
    expect(h.list()).toHaveLength(1);
    expect((await h.info()).rules[0]?.next).toBe(MONDAY + HOUR);
    t = MONDAY + HOUR + 5_000;
    await h.pump();
    expect(h.list().filter(slot("2026-11-02T06:00:00.000Z"))).toHaveLength(2);
    expect(h.list()).toHaveLength(3);
  });

  test("a repo whose last run under the rule still goes is skipped, and the skip is on the rule", async () => {
    const h = schedHub();
    await h.adopt();
    t = MONDAY + 20_000;
    await h.pump();
    const shop = h.list().find((e) => e.repoId === "web/shop")!;
    const r = runs.find((x) => x.id === shop.runId)!;
    h.onRun({ ...r, status: "done", branch: { ...r.branch!, state: "ready" } });
    await h.pump();
    expect(h.get(shop.id)).toMatchObject({ status: "ready", reason: "committed; the landing queue sorts the branch" });
    const blog = h.list().find((e) => e.repoId === "web/blog")!;
    h.onRun({ ...runs.find((x) => x.id === blog.runId)!, status: "failed", error: "x" });
    await h.pump();
    t = MONDAY + WEEK + 20_000;
    await h.pump();
    expect(h.list().filter((e) => e.firstAt === t).map((e) => e.repoId)).toEqual(["web/blog"]);
    expect((await h.info()).rules[0]?.skips).toEqual([{ repo: "shop", why: "last run still going", at: MONDAY + WEEK }]);
  });

  test("a rule whose workflow cannot run takes its slot with one skip and no event", async () => {
    const h = schedHub({ workflowProblem: async (name) => `unknown workflow: ${name}` });
    await h.adopt();
    t = MONDAY + 20_000;
    await h.pump();
    expect(h.list()).toEqual([]);
    expect((await h.info()).rules[0]).toMatchObject({ problem: "unknown workflow: spec-converge", next: Date.parse("2026-11-09T05:00:00Z"), skips: [{ repo: "every repo", why: "unknown workflow: spec-converge", at: MONDAY }] });
    expect((await h.info()).rules[0]?.lastFire).toBeUndefined();
    t = MONDAY + 90_000;
    await h.pump();
    expect((await h.info()).rules[0]?.skips).toHaveLength(1);
  });

  test("fire by hand: one repo named, or every matching one, keyed by the minute and marked manual", async () => {
    const h = schedHub();
    await h.adopt();
    t = MONDAY + 3 * HOUR + 15_000;
    const one = await h.fire("spec-weekly", "", "web/shop");
    expect(one.kind === "fired" ? one.events.map((e) => [e.repoId, e.source, e.service, e.key.split("@")[1], e.status]) : one).toEqual([["web/shop", "manual", "schedule", "2026-11-02T08:00:00.000Z", "working"]]);
    const all = await h.fire("spec-weekly", "");
    expect(all.kind === "fired" ? [all.events.map((e) => e.repoId), all.skipped.map((s) => s.repo)] : all).toEqual([["web/blog"], ["shop"]]);
    expect((await h.info()).rules[0]?.lastFire).toBe(t);
    expect(h.fire("spec-weekly", "", "nope")).rejects.toThrow("no repo nope in the tree");
    const res = await h.handle(new Request("http://x/api/triggers/fire", { method: "POST", body: JSON.stringify({ rule: "spec-weekly", repo: "web/blog" }) }), new URL("http://x/api/triggers/fire"));
    expect(res?.status).toBe(201);
    expect(await res?.json()).toMatchObject({ kind: "fired", events: [], skipped: [{ repo: "blog", why: "last run still going" }] });
  });

  test("a schedule rule has no hook", async () => {
    const h = schedHub();
    await h.adopt();
    const res = await h.handle(new Request("http://x/api/hooks/schedule/spec-weekly", { method: "POST", body: "{}" }), new URL("http://x/api/hooks/schedule/spec-weekly"));
    expect(res?.status).toBe(404);
    expect(h.list()).toEqual([]);
  });

  test("a queue event lands: the entry's landed state moves it to merged, with no PR and no write-back", async () => {
    await schedRules({ tokenEnv: "CANOPY_TRIGGER_SHOP_TOKEN" });
    const h = schedHub();
    await h.adopt();
    const d = await h.fire("spec-weekly", "", "web/shop");
    const e = d.kind === "fired" ? d.events[0]! : undefined;
    const r = runs[0]!;
    h.onRun({ ...r, status: "done", branch: { ...r.branch!, state: "ready" } });
    expect(h.get(e!.id)?.status).toBe("ready");
    h.onLanding([], [{ id: r.branch!.origin, state: "landed", landedAt: t + 5 } as LandEntry]);
    await h.idle();
    expect(h.get(e!.id)).toMatchObject({ status: "merged", endedAt: t + 5 });
    expect(h.get(e!.id)?.pr).toBeUndefined();
    expect(resolved).toEqual([]);
  });

  test("a server without the flows lock computes nothing", async () => {
    const h = schedHub();
    t = MONDAY + 20_000;
    await h.pump();
    expect(h.list()).toEqual([]);
    expect(h.fire("spec-weekly", "")).rejects.toThrow("does not hold the flows lock");
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `bun test src/server/triggers.test.ts -t "FR-041"`
Expected: FAIL (`repos` is not a dep; the tick never runs; `fire` takes no repo).

- [ ] **Step 4: Implement the tick, the fields, `info`, `fire`, `onLanding` and `writer`**

Update the header comment: "the hooks Sentry and Linear post to, the clock a schedule rule fires on, the event records...". `pump` leads with the tick, inside the `keeping` guard.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `bun test src/server/triggers.test.ts src/core/trigger.test.ts && bun run typecheck`
Expected: PASS; typecheck clean (`onLanding`'s second parameter and `TriggerDeps.repos` are optional, so `src/server/index.ts` compiles until Task 5 wires them).

- [ ] **Step 6: Commit**

```bash
git add src/server/triggers.ts src/server/triggers.test.ts
git commit -m "feat(triggers): the schedule tick on the lock holder, catch-up on start, skips and fire by repo"
```

---

### Task 5: the server honours land, and the hub's repos

**Files:**
- Modify: `src/server/index.ts:1284-1309` (`startTriggerRun`: the comment, `:1301`, `:1304`), `:5165` (`onLanding`), `:5251-5279` (the hub's deps, after `:5272`)

**Interfaces:**
- Consumes: `isSeedPath` (`:1412`), `TriggerEvent.land` from Task 1, `onLanding(notices, entries)` from Task 4.
- Produces: nothing exported. `startTriggerRun` computes `const pr = event.land !== "queue";` and passes `pr` where `:1301` and `:1304` pass `true`, so a `queue` event's branch run and branch flow are cut without `openPr` and land as a hand-started branch run does: the sort says `auto`, `land` or `approve`, and the inbox row carries "look and land". The hub's deps gain

```ts
repos: () => state.result.repos.filter((r) => !r.host && !r.forge && !isSeedPath(state.root, r.path)),
```

and the landing broadcast at `:5165` becomes `state.triggers.onLanding(ev.landing.notices ?? [], ev.landing.entries)`.

- [ ] **Step 1: Make the three changes**

Update `startTriggerRun`'s comment: "A trigger event's branch run, or its flow on a branch ... the branch opens a PR when the event's `land` is `pr`, and lands through the queue when it is `queue`."

- [ ] **Step 2: Run typecheck, lint and the server suites**

Run: `bun run typecheck && bun run lint && bun test src/server`
Expected: clean, PASS.

- [ ] **Step 3: Commit**

```bash
git add src/server/index.ts
git commit -m "feat(triggers): a land: queue event cuts its branch without openPr, and the hub sees the local repos"
```

---

### Task 6: the rule card

**Files:**
- Modify: `ui/src/triggers.ts:43-55` (`STATUS_WORD`), `:79-94` (`serviceOf`, `outcomeLine`), the end of the file; `ui/src/triggers.test.ts`; `ui/src/components/Triggers.tsx:27-88` (`EventRow`, the `test fire` span at `:65`), `:90-127` (`FireForm`), `:129-188` (`RuleCard`), `:224-233` (the no-rules text); `ui/src/api.ts:768-770`; `ui/src/store.ts:1183-1184`, `:3510-3514`; `ui/src/styles.css` (after `.trigger-note` at `:12289-12293`)

**Interfaces:**
- Consumes: `TriggerRuleInfo` with `cron`, `next`, `lastFire`, `skips`, `land`, `only`, optional `hook`; `Delivery`'s `fired` kind; `ago` from `ui/src/util.ts`.
- Produces in `ui/src/triggers.ts`:

```ts
/** the state's word, with a queue event's ready read as the queue's */
export function statusWord(e: Pick<TriggerEvent, "status" | "land">): string;
/** "every local repo" or the repo's name, then the only words: "with a spec", "with changes", "with unpushed commits", "with a clean tree", joined by ", " */
export function scheduleWord(rule: Pick<TriggerRuleInfo, "repo" | "only">, repoName: string): string;
/** "next fire in 3 days" / "in 2 h" / "in 40 min" / "due now"; "never fires again" when next is absent */
export function nextFireWord(next: number | undefined, now: number): string;
```

and in `ui/src/api.ts` and `ui/src/store.ts`, `fireTrigger(backend, rule, title, repo?: string)`, the body `{ rule, title, ...(repo ? { repo } : {}) }`.

`statusWord`: `e.status === "ready" && e.land === "queue"` is `in the landing queue`, else `STATUS_WORD[e.status]`. `EventRow` and `triggersBadge`'s title use it. `outcomeLine`: a `merged` event with `service === "schedule"` and no `pr` reads `landed on main through the queue`; with a PR, null (the PR link shows). `nextFireWord` units: under 60 min `in <n> min`, under 48 h `in <n> h`, else `in <n> days`, with `n` rounded down; `next <= now` is `due now`.

`RuleCard` for a schedule rule: the facts line is `schedule → {scheduleWord(rule, repo)}`, `runs {workflow}`, `{rule.land === "queue" ? "lands through the queue" : "opens a PR"}`; the secret and writes-back spans are left out (`rule.secretEnv` is absent). In place of the hook block:

```tsx
<div className="trigger-hook">
  <code>{rule.cron}</code>
  <span>{nextFireWord(rule.next, Date.now())}</span>
  <span>{rule.lastFire ? `last fired ${ago(rule.lastFire / 1000)}` : "never fired"}</span>
</div>
{(rule.skips?.length ?? 0) > 0 && (
  <ul className="trigger-skips">
    {rule.skips?.map((s) => (
      <li key={`${s.repo}-${s.at}`} className="trigger-note">skipped {s.repo}: {s.why} <span title={new Date(s.at).toLocaleString()}>{ago(s.at / 1000)}</span></li>
    ))}
  </ul>
)}
```

The sentry and linear cards keep the hook block, guarded by `rule.hook`. `FireForm` for a schedule rule: a `<select aria-label="Which repo to fire">` whose first option is `every matching repo` (value `""`) and then every store repo with no `host` and no `forge` by name (value its id), and the button reads `fire now` with the title "Fire the rule now: one event per matching repo, skipped where the last run still goes"; `fireTrigger(backend, rule.name, "", repo || undefined)`; a `fired` answer shows `${d.events.length} started, ${d.skipped.length} skipped`. `EventRow`'s by-hand span reads `fired by hand` when `e.service === "schedule"`, `test fire` else. The no-rules paragraph names `schedule` as a source with "a cron line and a repo, or `*` for every local one". CSS: `.trigger-skips { list-style: none; margin: 0; padding: 0; }` beside `.trigger-note`; nothing else new.

- [ ] **Step 1: Write the failing tests in `ui/src/triggers.test.ts`**

```ts
describe("the schedule card (FR-041)", () => {
  test("statusWord reads a queue event's ready as the queue's", () => {
    expect(statusWord(ev({ status: "ready", land: "queue" }))).toBe("in the landing queue");
    expect(statusWord(ev({ status: "ready" }))).toBe("committed, no PR");
    expect(statusWord(ev({ status: "working", land: "queue" }))).toBe("fixing");
  });
  test("scheduleWord names the repos and the only words", () => {
    expect(scheduleWord({ repo: "*", only: [] }, "")).toBe("every local repo");
    expect(scheduleWord({ repo: "*", only: ["spec-adopted"] }, "")).toBe("every local repo with a spec");
    expect(scheduleWord({ repo: "*", only: ["clean", "unpushed"] }, "")).toBe("every local repo with a clean tree, with unpushed commits");
    expect(scheduleWord({ repo: "web/shop", only: ["dirty"] }, "shop")).toBe("shop with changes");
  });
  test("nextFireWord", () => {
    const now = Date.parse("2026-11-02T05:00:00Z");
    expect(nextFireWord(undefined, now)).toBe("never fires again");
    expect(nextFireWord(now - 1, now)).toBe("due now");
    expect(nextFireWord(now + 40 * 60_000, now)).toBe("next fire in 40 min");
    expect(nextFireWord(now + 2 * 3_600_000 + 1, now)).toBe("next fire in 2 h");
    expect(nextFireWord(now + 7 * 86_400_000, now)).toBe("next fire in 7 days");
  });
  test("a schedule event that landed says so; one with a PR leaves it to the link", () => {
    expect(outcomeLine(ev({ service: "schedule", status: "merged", land: "queue" }))).toBe("landed on main through the queue");
    expect(outcomeLine(ev({ service: "schedule", status: "merged", land: "pr", pr: { number: 1, url: "u" } }))).toBeNull();
    expect(outcomeLine(ev({ service: "schedule", status: "ready", land: "queue", reason: "needs your approval: 1 sensitive file" }))).toBe("needs your approval: 1 sensitive file");
  });
});
```

Import `nextFireWord`, `scheduleWord`, `statusWord` with the rest.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test ui/src/triggers.test.ts`
Expected: FAIL on the new describe.

- [ ] **Step 3: Implement the helpers, the card, the form, the API call and the CSS**

- [ ] **Step 4: Run the tests, typecheck, lint and build**

Run: `bun test ui/src && bun run typecheck && bun run lint && bun run build`
Expected: PASS, clean, built. Then look at it: start a scratch server as the memory note "Scratch canopy server for UI checks" says, with a `triggers.json` holding the spec's rule and `"workflow": "sentry-fix"` (the converge workflow comes with plan 2), open `?view=triggers`: the card reads `schedule → every local repo with a spec`, `cron 0 5 * * 1`, `next fire in N days`, `never fired`; "fire now" on one repo makes a row whose state reads `fixing`, then `in the landing queue` or `no fix`.

- [ ] **Step 5: Commit**

```bash
git add ui/src/triggers.ts ui/src/triggers.test.ts ui/src/components/Triggers.tsx ui/src/api.ts ui/src/store.ts ui/src/styles.css
git commit -m "feat(triggers): the schedule rule card: cron, next fire, last fire, skips and fire now per repo"
```

---

### Task 7: the docs and the gates

**Files:**
- Modify: `docs/architecture.md:176` (the sources sentence), `:178` (the rule shape), `:186` (the routes), after `:190` (a new paragraph); `FEATURES.md:30-34` and `:128`; `docs/superpowers/plans/README.md:7`

**Interfaces:**
- Consumes: the completed interfaces from Tasks 1 to 6, the source spec, and the live-check results.
- Produces: documentation and feature status that describe the implemented scope, with later phases still marked open. No new runtime interface.

- [ ] **Step 1: `docs/architecture.md`**

Line 176: "The sources are Sentry, Linear and a clock (below)." Line 178: the rule shape gains `land, cron?, only?` and one sentence: "`land` is `queue` (the branch lands through the landing queue under the repo's review rules) or `pr` (a PR opens); it defaults to `pr` on a Sentry or Linear rule and `queue` on a schedule rule." Line 186: "`POST /api/triggers/fire {rule, title}` runs a made-up issue through a Sentry or Linear rule and skips its filters; on a schedule rule, `{rule}` fires every matching repo now and `{rule, repo}` one." After line 190, one paragraph starting "The third source is a clock (`schedule`, FR-041 plan 1; `docs/superpowers/specs/2026-10-25-spec-converge-design.md`)." saying: the rule's keys (`cron` as `core/cron.ts` reads it in the backend's local time, `repo` an id or path or `"*"` for every local repo that is not on the forge or a seed, `only` with its four words through `checkWhen`, no `secretEnv` and no hook); `dueRules` is pure and the hub's `pump` leads with it on the lock holder; the last fire is the newest event's `firstAt` or the hub's in-memory mark, so a restart never refires a slot an event took, and a rule first seen takes its first slot after that moment; a slot missed while canopy was down fires once on start at the current minute unless the next is under `SCHEDULE_CATCH_UP` away; one event per repo keyed `<repo key>@<fire minute ISO>` with `short` the date, `title` "<workflow> on <repo>, <date>", `note` with nothing fenced since nothing came in; a repo whose last event is queued, live, ready or in review is skipped with no event and the card keeps `SKIPS_KEPT` skips; a fire whose workflow cannot run takes its slot with one skip; `land: queue` cuts the branch without `openPr`, `fromRun` says the queue sorts it, and `fromLanding` moves the event to `merged` from a landed entry or notice; `fire` by hand marks the events `manual` and counts as a fire; `GET /api/triggers` carries `cron`, `next`, `lastFire`, `skips`, `land`, `only`; the card and `fire now`.

- [ ] **Step 2: `FEATURES.md` and the plans README**

Move the `### FR-041` block (`:30-34`) to the top of `## In Progress` (`:128`) and append to its Spec line: `Plan 1 shipped <date> (the schedule source: the rule, the tick, catch-up, skips, land: queue, fire by repo, the rule card); plan 2 (the spec-converge workflow, the report, canopy spec drift, the chip) open.` In `docs/superpowers/plans/README.md`, add the first row: `| [Spec converge, plan 1: the schedule trigger source](2026-10-26-spec-converge-1.md) | shipped | <date> | [spec converge](../specs/2026-10-25-spec-converge-design.md) |` and set this plan's Status line to shipped with the merge commit. `SPEC.md` stays as it is: no state file is added and `triggers.json`'s line there is still true. `README.md` stays as it is: the CLI does not change in this plan.

- [ ] **Step 3: Run every gate**

Run: `bun run typecheck && bun run lint && bun test && bun run build`
Expected: all pass. Then `~/.claude/skills/verify-build/clean-rebuild.sh verify "nextFireWord"` proves the served bundle is the new one.

- [ ] **Step 4: Commit**

```bash
git add docs/architecture.md FEATURES.md docs/superpowers/plans/README.md docs/superpowers/plans/2026-10-26-spec-converge-1.md
git commit -m "docs(triggers): the schedule source in architecture, the feature list and the plans index"
```

---

## Live check, before the branch is called done

With a scratch canopy (the "Scratch canopy server for UI checks" memory note) scanning a folder with two throwaway repos, one holding a `.canopy/spec.json` and a SPEC.md:

1. `triggers.json` holds `{"rules": [{"name": "spec-weekly", "source": "schedule", "cron": "* * * * *", "repo": "*", "workflow": "sentry-fix", "land": "queue", "only": ["spec-adopted"]}]}` (the converge workflow comes with plan 2; `sentry-fix` commits nothing on a note with no issue). Within a minute the triggers view shows one event for the adopted repo and none for the other; its key in `triggers/events.json` ends in that minute's ISO; the card reads `cron * * * * *`, `next fire in 1 min`, `last fired just now`.
2. The next minute: the adopted repo is skipped while its run goes, the card lists `skipped <repo>: last run still going`, and no second event appears.
3. The run ends `no fix`; the following minute fires again.
4. Stop the server for three minutes and start it: no burst of three. A per-minute rule's next slot is always under an hour away, so the missed ones are forgiven and it fires once at the next minute. Then set the cron to a time just missed (`30 14 * * *` after stopping across 14:30) and start again: one event, keyed at the start minute.
5. With the CLI token: `curl -X POST .../api/triggers/fire -d '{"rule":"spec-weekly","repo":"<other repo id>"}'` answers `{"kind":"fired","events":[...],"skipped":[]}` and the row reads `fired by hand`; `curl -X POST .../api/hooks/schedule/spec-weekly` is a 404.
6. Change the rule to `"land": "pr"` and a cron a minute away: the run's branch gets `openPr` in its landing record; back on `queue`, a run that commits lands through the queue and its row reads `landed on main through the queue`.

## Decisions this plan makes beyond the spec

- The last fire is the newest event's `firstAt`, not `lastAt`: `lastAt` moves on a retry or a follow-up, `firstAt` is the fire. A hand fire counts as a fire, so the next slot is the first after it.
- The hub keeps an in-memory mark per rule beside the events: a rule first seen takes its first slot after that moment and never a missed one, a fire whose every repo is busy or whose workflow cannot run still takes its slot, a forgiven slot (the next one under an hour away) is a mark and not a fire, and `next` on the card is computed from the newer of the mark and the events rather than cached. Without the forgiving mark a sub-hour cron that missed a slot would defer forever, since its next slot is always under an hour away.
- `dueRules` takes the repos and a clock (`since`, `marks`) after the spec's three arguments, since which rules fire depends on both. The order of starts is `pump`'s, oldest first; the spec's `nextToStart` is the coordinator's and is not reused.
- A repo is busy for the skip when its last event under the rule is `queued`, `working`, `waiting`, `ready` or `review`: a PR waiting for a look is "last run still going" from the repo's side, as the spec's decision 5 means it.
- `only` applies to a named repo too, and `clean` means no changed files (the opposite of `dirty`); `spec-adopted` is `Repo.spec` set and not `not-adopted`, which is what the scan already reads. A repo `only` leaves out is not a skip, so the card is not twenty lines of "no spec" a week.
- A hand fire on one named repo leaves `only` aside, since Eric chose the repo, and marks its events `manual` like a test fire; the row reads "fired by hand".
- `fromLanding` reads the queue's entries as well as its notices, because a `landed` notice is raised only for a branch that landed on its own and a SPEC.md change is landed by hand.
- `TriggerRule.secretEnv` and `TriggerRuleInfo.hook` become optional (absent on a schedule rule) rather than carrying empty strings; `api` stays a string and is `""` on a schedule rule, which nothing calls.
- `land` is accepted on every source with `pr` as the default for Sentry and Linear, so FR-035 can adopt it without a second parse; `TriggerEvent.land` is written on the event so a rule edit never changes how an open branch lands.
- The `skips` on the card come from `GET /api/triggers` as `{ repo, why, at }[]`, `lastFire` is the key's name for "the last fire", and a fire by hand answers `{ kind: "fired", events, skipped }`.
