# Capacity governor: subscription-limit-aware dispatch (FR-036)

FR-036 asks canopy to know how much of the Max plan's rolling usage windows
is left and to hold the work that can wait when the window runs low, so a
fan-out, a trigger or the ranger never spends the headroom Eric wants for
the chat he is in. The idea comes from Gas Town's `scheduler.max_polecats`
(github.com/gastownhall/gastown), which caps workers to keep off the rate
limit, Optio's provider usage-limits view (github.com/jonwiggins/optio) and
Claudexor's quota rotation. It absorbs FR-028 (what is left on each
subscription, in the status line). On a Max plan dollars are a report after
the fact; the 5-hour and weekly windows are the constraint that stops work
now, and canopy counts neither. The overview is
`2026-10-25-software-factory-borrowings-design.md`.

## Where things stand (2026-10-25)

- Runs spawn the user's own `claude` in print mode (`cliArgs` in
  `core/claudedrive.ts`) or `codex app-server` (`core/codexrun.ts`). Both
  report spend per reply: Claude `total_cost_usd` on its `result`, Codex
  `tokenUsage.total`. `RunCosts.onRun` turns the difference into a ledger
  row in `costs/<YYYY-MM>.jsonl` (`core/costledger.ts`, `core/costs.ts`).
  Nothing reads a window's utilization.
- A `result` with `is_error` or a subtype other than `success` ends a job as
  failed with `problem` (`claudedrive.ts` near `error_max_turns`,
  `error_max_budget_usd`). A limit hit lands there as a failed run with the
  limit text as its error; a flow fails its step, a landing fix stays sent
  back, a trigger event reads `failed`.
- Nothing decides whether a start may go now except the slot counts:
  `activeFor` (one checkout run per repo), `BRANCH_RUNS_PER_REPO`,
  `COORD_AT_ONCE`, a trigger's `branchSlotsTaken`. Each pump (landing's
  loop, `TriggerHub`, `CoordinatorHub`, `PrHub`'s auto-fix) starts work as
  soon as a slot is free.
- The costs view shows dollars by service, card, run and session, over
  today, 7 or 30 days. The top bar has chips for tasks, inbox, chan, shells,
  ranger and health (`TopBar.tsx`); none for spend or capacity.
- FR-028 (open, P3) asks for Orca's status-bar line: each subscription's
  used share beside its reset.
- SPEC.md's Out of scope: "Calling the Anthropic API directly or storing API
  keys for Claude." Decision 2026-08-24: runs drive the `claude` binary on the
  Max login, never the SDK.

## Probes before plan 1

Every number below rests on these. The fake CLI in `claudedrive.test.ts`
replays what they show.

- **P1.** What `claude -p --output-format stream-json` prints when the
  5-hour window is spent: a `result` with `is_error: true` and the limit
  text (expected "You've hit your limit · resets 3pm" or close), a
  `system` event, or a non-zero exit with the text on stderr; whether the
  text names the reset time, and in whose clock. Run it against a spent
  window on purpose (a cheap `-p "hi"` in a loop at the end of a window).
- **P2.** Whether the CLI reports a window's utilization. The interactive
  `/usage` reads an OAuth usage endpoint with the CLI's stored credential;
  Orca and ccusage read the same endpoint. Confirm the URL, the auth header
  it wants, its fields (per window: utilization as a fraction and
  `resets_at`), and how often it may be asked. Confirm that reading it with
  the CLI's own stored credential is within the Oct 7 2026 Help Center
  terms ("You can still use ... third-party apps with your subscription
  limits"): canopy would read a number, not drive a model. If it is not
  confirmable, `source: endpoint` is dropped and the governor runs on
  `observed` alone.
- **P3.** Where the credential sits on each machine (macOS keychain on the
  Mac; `~/.claude/.credentials.json` in the container's bind mount) and
  whether `claude` refreshes it on its own, so canopy never writes it.
- **P4.** What Codex prints at its limit (`codex app-server` has no window
  of its own that canopy knows; expected an error item with the text) and
  whether `codex` exposes usage at all. If not, Codex gets `observed` only.
- **P5.** Whether the limit text differs between the 5-hour and the weekly
  window, so `observed` can tell which one closed.

## Design

### The model: `core/capacity.ts`

Pure and browser-safe, tested. One `Capacity` per harness per backend:

```ts
interface Window { used: number; resetsAt: number | null; readAt: number }
interface Capacity {
  harness: Harness;
  fiveHour: Window | null;
  weekly: Window | null;
  /** endpoint: read from the usage endpoint (P2); observed: inferred from
   *  a limit hit and the ledger; unknown: never read */
  source: "endpoint" | "observed" | "unknown";
  /** a limit hit the harness reported, until its reset passes */
  hit: { window: "fiveHour" | "weekly"; at: number; resetsAt: number; text: string } | null;
}
```

- `readUsage(json)` parses P2's answer into the two windows; a field it
  does not recognise leaves that window null.
- `limitHit(text, now)` reads P1's text into `hit` (window from P5, reset
  time parsed in the backend's local time, `resetsAt` null when the text
  names none: then `HIT_HOLD` 60 min from `at`).
- `observe(cap, ledgerRows, now)`: with no endpoint, `fiveHour.used` is
  the ledger's Claude dollars over the last five hours divided by
  `OBSERVED_FIVE_HOUR_USD`, a setting with no default (null leaves `used`
  unknown and the governor holds nothing until a hit). Rough by design: it
  exists so a hit is not the first thing canopy learns.
- `stale(window, now)` is true past `READ_EVERY` (5 min) with an endpoint,
  so a window read is never trusted for long.

### Priorities

Every start carries a `Priority`, a new field on `StartExtras` and on
`Run` (`priority`), defaulting by who starts it:

- `interactive`: a run or chat the page or the CLI starts, a `propose` and
  its build, an ask, the ranger's conversation, a "fix it" Eric clicks.
- `normal`: a landing "fix it" the queue starts on its own, a PR watch
  auto-fix, a coordinator's children, a flow's steps after the first.
- `low`: a trigger event's run, a fan-out's runs (FR-033), a scheduled
  flow (FR-041), a warm-pool refill (FR-039), the sweep's and the spec
  converge's runs, anything a run starts through the agent surface
  (FR-038).

A pre-flight shows the priority as a chip and lets Eric raise it to
`interactive` for one start.

### The governor

`Governor` is pure: `decide(cap, priority, now)` returns `go` or
`{hold: "window" | "hit", until: number | null, why: string}`:

- `interactive` is never held.
- `normal` holds while `fiveHour.used >= NORMAL_HOLD` (0.90) or a `hit`
  stands.
- `low` holds while `fiveHour.used >= LOW_HOLD` (0.70), while
  `weekly.used >= WEEKLY_LOW_HOLD` (0.85), or a `hit` stands.
- A `hit` holds until `resetsAt` plus `HIT_GRACE` (2 min), then is
  dropped and the next read or start decides again.
- `source: unknown` holds nothing. canopy never guesses a hold.

The thresholds are settings (`capacity` in config: `lowHold`,
`normalHold`, `weeklyLowHold`, `observedFiveHourUsd`), normalised by
`normalizeCapacity`, with the defaults above.

### Where it hooks in

`server/capacity.ts` holds `CapacityHub` (`state.capacity`): one `Capacity`
per harness, read from the endpoint every `READ_EVERY` while any run or
pump is waiting on it and every `READ_IDLE` (30 min) otherwise, from the
ledger otherwise, and from every `limited` run end. It broadcasts
`{type: "capacity", capacity}` on change and offers `may(priority)` to the
pumps and the runner.

- `Runner.start` asks `may(extras.priority)` first. A held start throws
  `CapacityHeldError` with the reason; `startRepoRun` turns it into a 409
  `{error, until}` for the page and the CLI, and the pumps read it as "stay
  queued". No pump marks anything failed on it.
- The landing hub's "fix it" on its own, `PrHub`'s auto-fix, `TriggerHub`'s
  queue, `CoordinatorHub`'s `nextToStart` and the flows' next step each
  check `may` before they start, and each is pumped again on the `capacity`
  event, so a reset wakes them without a timer of their own. Their words:
  a queued trigger event reads `waiting for capacity (resets 14:00)`, a
  coordinator card's outcome the same, a flow parks `waiting` with that
  reason, a landing entry stays `conflict`/`red` with the fix not started
  and the inbox row says why.
- A run's `result` that `limitHit` reads ends the run as `limited`, a new
  `RunStatus` beside `failed`, with `error` the limit text. It is kept out
  of "waiting on you"'s failed group and listed under a "waiting for
  capacity" line instead. What retries it:
  - a flow step: the flow parks on it like `away` and runs the step again
    (resuming its session, `--resume`) once `may(normal)` says go;
  - a landing fix or PR fix: `rejoin` starts the fix again the same way;
  - a trigger event: reads `waiting`, resumed as `resume {id}` does;
  - a coordinator child: the card waits, not failed, and its note says so;
  - a chat: the reply is said as limited in the timeline and the chat stays
    `idle`; the composer shows the reset time.
  A run that is `limited` twice in a row fails with the text, so a wrong
  reading cannot loop.
- Codex gets the same `limited` path from P4's text and `observed` only.

### What is shown

- **Top bar:** a `CapacityChip` beside the health chip, one line per
  backend with a harness that has a reading: `5h 32% · 2h10` and
  `week 61% · Thu` (`capacityLine` in pure `ui/src/capacity.ts`, with
  `windowWord` for the reset: a time today, else a weekday). Moss under
  `LOW_HOLD`, lichen between the holds, rust while a hold stands or a hit
  is on. Its popover lists each held start (what, repo, priority, why,
  since when) with "start anyway" (a one-off `interactive` start, `operate`)
  and the readings' source and age. `unknown` shows "no reading" and how
  to get one (P2's setting, or the observed estimate's dollar figure).
- **Costs view:** a capacity block over the dollars, the same lines and the
  settings (thresholds, the observed dollar figure).
- **Pre-flight and run sheet:** the priority chip; a held start's sheet
  shows the reason and "start anyway".
- **Inbox:** nothing. A hold is not Eric's turn; the chip carries it.

### Routes and CLI

- `GET /api/capacity` (`read`): `CapacityInfo` `{capacity: Capacity[], held:
  HeldStart[], settings}`, also the `capacity` event.
- `POST /api/capacity` (`admin`): a settings patch.
- `POST /api/capacity/read` (`operate`): read the endpoint now.
- `POST /api/capacity/release {id}` (`operate`): start one held start as
  interactive.
- `canopy capacity [--json]` prints the lines; `canopy capacity release
  <id>`. `canopy run ... --priority low|normal|interactive` on the start
  commands.

### Restart

`CapacityHub` keeps nothing it cannot read again: the endpoint or the
ledger gives the windows, and a `hit` is written to
`<configDir>/capacity.json` (0600) so a restart inside a spent window does
not start low work at once. The file holds no credential. Held starts are
their owners' records (trigger events, coordinator cards, landing entries)
and come back with them.

### Security

canopy reads the usage endpoint with the CLI's own stored credential (P3),
never copies it, never writes it, and never passes it to a run, shell or
gate: the read runs in the server, and `gateEnv`/`stageEnv` already drop
what a child never gets. If P3 shows the credential is reachable only by
reading the CLI's file, the read is done by the server process alone and
the path is never logged. A run's priority is set by canopy, never by the
agent: the agent surface (FR-038) starts work at `low` and cannot raise it.

### The credits lane

The Oct 7 2026 Help Center says a Max plan now includes $100 (5x) or $200
(20x) a month of API credits that cover `claude -p` and the Agent SDK when
they are billed through an API key, and that work signed in with the plan
still draws from the plan's limits and never from the credits. Routing the
ranger and `low` work through a key funded by those credits would take them
off the windows this spec guards. If Eric says yes, the shape is:

- an `ANTHROPIC_API_KEY` held in the secret store (`eric/secrets`) and
  applied only to a named profile's `claude -p` process env through the
  Runner's `StartExtras.env`, never a shell, a gate, a stage or a page;
- the profile (`credits`, harness claude) picked per role in the routes
  (`core/route.ts`), so `low` roles and the ranger's jobs may name it and
  nothing else does;
- its spend read from the ledger's `total_cost_usd` as today and shown as
  "credits" beside the plan's windows, with the month's cap and what is left
  (the credits do not roll over);
- `capacity.ts` treating that profile as its own `Capacity` with
  `source: ledger`, held at `CREDITS_HOLD` 0.95 of the cap.

It reverses SPEC.md's Out of scope line and the 2026-08-24 decision, both
of which would need a dated decision in the same commit. The policy has
changed four times in 2026 (January, February, April, May/June, October),
so a key could stop covering `-p` work on any given month. The
recommendation is to hold: build the governor first, which stands on its
own, and revisit the lane once the terms have stood still for a quarter.

## Components

- `src/core/capacity.ts` (new): `Capacity`, `Window`, `readUsage`,
  `limitHit`, `observe`, `stale`, `Governor.decide`, `normalizeCapacity`,
  the constants.
- `src/server/capacity.ts` (new): `CapacityHub`, the endpoint read, the
  ledger read, `may`, the routes, the event, `capacity.json`.
- `src/core/runner.ts`: `priority` on `StartExtras` and `Run`,
  `CapacityHeldError`, the `limited` status.
- `src/core/claudedrive.ts`, `src/core/codexrun.ts`: a `result` or error
  item that `limitHit` reads ends the run `limited`.
- `src/core/flow.ts`, `src/server/landing.ts`, `src/server/prs.ts`,
  `src/server/triggers.ts`, `src/server/coordinator.ts`: `may` before a
  start, pumped on `capacity`, the `limited` retry.
- `src/core/types.ts`: `Priority`, `RunStatus` `limited`, `CapacityInfo`,
  the `capacity` event.
- `src/cli/capacity.ts` (new), `src/cli/index.ts`: `canopy capacity`,
  `--priority`.
- `ui/src/capacity.ts` (new, pure), `components/Capacity.tsx` (chip,
  popover, the costs block), `Costs.tsx`, the pre-flight's chip, the run
  sheet's reason, `waiting.ts` (`limited` out of failed).

## Calls

Made on 2026-10-25:

1. **No hold without a reading.** `source: unknown` never holds, because a
   wrong hold costs Eric more than a wrong start; the chip says "no
   reading" so the gap is visible.
2. **`limited` is a status, not a failure.** The work is sound; the window
   is spent. Retrying it after the reset is the point of the spec.
3. **Two `limited` ends in a row fail.** A misread text must not loop.
4. **Priorities are canopy's.** The agent never sets one; FR-038 starts at
   `low`.
5. **Thresholds are settings with defaults**, since Eric's week differs
   from a team's and the right numbers come from a month of readings.
6. **FR-028 closes into this spec.** The chip line is Orca's status bar
   line, per backend.

For Eric:

7. **The credits lane.** Yes or no, as above; the recommendation is hold.
8. **P2's terms.** If reading the usage endpoint with the CLI's credential
   is not clearly within the Oct 7 2026 terms, the governor runs
   `observed` only and the chip says so. Eric's call once P2 is in.
9. **The observed dollar figure.** With no endpoint, `observedFiveHourUsd`
   is a guess at what one window is worth in Claude dollars; a week of
   ledger rows against the windows' resets gives a number.

## Out of scope

- Rotating between logins or accounts (Claudexor). canopy has one login
  per machine.
- Per-model routing to spend less (Fabro's stylesheet routing). The routes
  already pick a profile per role.
- Counting tokens itself; the harnesses report what they report.
- A hold on interactive work. The person at the keyboard decides.

## Testing

- `capacity.test.ts`: `readUsage` on P2's shapes and on garbage,
  `limitHit` on P1's texts (with and without a reset time, each window,
  the local clock), `observe` on ledger rows across the five-hour edge,
  `decide` for each priority at each threshold, a hit's hold and its grace,
  `normalizeCapacity` on bad settings.
- `claudedrive.test.ts`: the fake CLI replays P1; the run ends `limited`
  with the text; a second `limited` fails.
- `server/capacity.test.ts` over a stand-in reader: reads at `READ_EVERY`
  only while something waits, the event on change, `capacity.json`
  written on a hit and read at start, `release`.
- `flow.test.ts`, `landing.test.ts`, `triggers.test.ts`,
  `coordinator.test.ts`: a held start stays queued with the reason and
  goes on the `capacity` event; a `limited` step, fix, event and child
  retries after the reset.
- `ui/src/capacity.test.ts`: `capacityLine`, `windowWord`, the tone.

## Plans

1. **Probes and the model**: P1–P5, `core/capacity.ts`, the `limited`
   status in both drivers, `CapacityHub` with the ledger reader; the chip.
2. **The governor in the pumps**: priorities on every start, `may` in each
   hub, the retries, `canopy capacity`, the costs block.
3. **The credits lane**, only on Eric's yes, with the SPEC.md decision.
