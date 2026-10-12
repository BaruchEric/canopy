# Health: what is broken, and canopy fixing what it can

The user wants quiet failures to stop being quiet. Something inside a running
canopy breaks (tailchan drops, the ranger dies, a watcher stops, a backend goes
unreachable) and nobody knows until a feature misbehaves. Canopy should show
it, and fix what it safely can. Later canopy also runs operations for some of
the user's repos (their health, their status, keeping them up), and a repo's
card changes with what that repo is.

That is two projects on one engine, built in this order:

1. **The health core and canopy's own health** (phase 1).
2. **Repo operations** (phase 2): per-repo checks, heals and an adaptive card.

This spec covers both, so the engine is built knowing a repo can be a subject.

## What the user asked for, and what was assumed

Said by the user:

- The target failure is a piece inside a running canopy breaking quietly
  (option 2 of the first question), not the whole server going down.
- Healing depends on the piece (option 4): the safe pieces heal themselves with
  backoff and give up after repeated failures; the pieces whose restart could
  rerun work get a button and nothing automatic.
- One health view, placeable anywhere: a top-bar chip with a popover, a dock
  panel, its own page, and on a repo's card.
- Canopy will manage some repos' operations, health and status, so a repo card
  adapts to the case.
- Phase 1 first, then phase 2.

Assumed, not contradicted:

- Escalation after a give-up is a row in the Waiting panel plus a best-effort
  tailchan DM, the way the ranger and tasks escalate today. Canopy cannot raise
  an ask of its own (asks come from agents' hooks through the broker), and the
  broker may be the thing that is down.
- History is in memory: the last 20 transitions per check. A canopy restart
  starts it fresh.
- A repo opts in by declaring checks in `.canopy/health.json` or canopy's
  config, layered the way tasks are. Nothing is detected in phase 2's first
  cut, so a repo with no checks keeps the plain git card.
- Restarting the canopy server itself when it hangs is out of scope (that is
  the compose stack's job, option 1 of the first question).

Success: when tailchan, the registry, asks, a watcher, the ranger, tmux or the
stage runner fails, the chip turns amber or red within a minute, the popover
says what and since when, the safe pieces come back on their own, and a piece
that keeps failing lands in Waiting with a DM. In phase 2, a repo with a
declared endpoint shows "up 42ms" or "down 3m" on its card, and an own repo's
crashed dev task comes back by itself.

## The model (pure, `src/core/health.ts`)

Browser-safe, no Bun imports, fully unit tested.

A **check** is one thing that can be well or not:

```ts
type HealthState = "ok" | "down" | "healing" | "gave-up" | "off" | "unknown";
type HealMode = "auto" | "button" | "self" | "none";

interface HealthCheck {
  id: string;            // "canopy:tailchan", "canopy:watch:<source>", "repo:<repoId>:<name>"
  label: string;         // "tailchan stream"
  scope: { kind: "canopy" } | { kind: "repo"; repoId: string };
  state: HealthState;
  why: string | null;    // the last failure's words, null when ok
  since: number;         // when the state last changed
  lastOk: number | null;
  heal: HealMode;
  fails: number;         // heals that did not bring it back, in a row
  nextHeal: number | null;
  detail?: string;       // "200 in 42ms", "pid 4411 holds the flows"
  history: HealthEvent[]; // newest last, at most HISTORY_MAX (20)
}
interface HealthEvent { at: number; state: HealthState; why: string | null }
```

- `ok`: the last probe passed.
- `down`: the last probe failed and no heal is pending (a `button`, `self` or
  `none` check, or an `auto` one between heals).
- `healing`: an auto heal is scheduled or running.
- `gave-up`: `HEAL_MAX` (5) heals in a row did not bring it back. Auto healing
  stops until a manual heal or a passing probe.
- `off`: not set up here (no broker, no stage runner). Never counted bad.
- `unknown`: no probe has answered yet.

`self` means the piece heals itself (the ranger, tasks, the stage runner's own
redial) and health only reports. `none` means nothing here can fix it (tmux
lives in the shells container, which compose restarts).

**Transitions** are one pure function:

```ts
observe(check, result: { ok: boolean; why?: string; detail?: string; off?: boolean }, now, timings)
  → { check, action: "heal" | "escalate" | null }
```

- A pass resets `fails` once the check has been ok for `RESET_AFTER` (5 min),
  the ranger's rule. A pass after `gave-up` clears it.
- A failure on an `auto` check schedules a heal at `nextHeal = now +
  backoff(fails)`: 1 s, doubling, capped at 60 s, the same curve as tasks. The
  hub runs the heal and probes again. A failed re-probe increments `fails`.
- At `fails === HEAL_MAX` the check goes `gave-up` and the action is
  `escalate`, once per give-up.
- `history` gets an entry only on a state change, so a flapping check costs 20
  entries, not a stream.
- `manualHeal(check, now)` clears `gave-up` and `fails` and runs the heal, for
  the button. It works on `auto` and `button` checks alike.

`summary(checks)` gives the chip's word: `{ level: "ok" | "warn" | "bad",
word, title }`. `bad` when any check is `down` or `gave-up`, `warn` when any
is `healing` or `unknown` for over a minute, `ok` otherwise. `off` checks are
left out.

## The hub (`src/server/health.ts`)

`HealthHub` owns every check and the timers. It is kept out of
`server/index.ts`, which only registers checks and wires the routes.

```ts
hub.add({ id, label, scope, heal, every?, probe?, doHeal? })
hub.report(id, result)      // a push source: tailchan's onState, the ranger's state
hub.remove(id)              // a source or a repo that went away
hub.heal(id)                // the button
hub.list(): HealthCheck[]
hub.stop()
```

- A check with `probe` and `every` is polled, never two probes at once (the
  stage watch's `beating` rule). A check without one is fed by `report`.
- Heals run one at a time per check, and a heal that throws counts as a failed
  heal.
- Every change goes out as a `{ type: "health", checks }` event, but only when
  the JSON differs from the last one sent (`tellStages`' rule), debounced
  250 ms.
- `escalate` calls the `onGaveUp(check)` dependency, which `ChanHub.post`s a DM
  to the human, best effort, whatever the notify switch says (the ranger's
  rule). The check's `gave-up` state is what puts it in Waiting.

Routes:

- `GET /api/health`: `{ checks: HealthCheck[] }`.
- `POST /api/health/heal?id=`: runs the heal now. 404 for an unknown id, 409
  for a check whose heal mode is `self` or `none`.

## Phase 1: canopy's own checks

Most checks adapt status canopy already computes. Few new probes.

| Check | Source | Heal |
|---|---|---|
| `canopy:tailchan` tailchan stream | `ChanHub` passes `onState` to its `follow` | `self` (see below) |
| `canopy:registry` agent registry stream | `RegistryHub` passes `onState` | `self` |
| `canopy:asks` asks stream | `AskHub` passes `onState` | `self` |
| `canopy:ranger` the ranger | `RangerInfo.state` on every change | `self`, button runs `/api/ranger/restart` |
| `canopy:tmux` shells server | probe: `tmux -S <sock> list-sessions` every 30 s | `none` |
| `canopy:stages` stage runner | the stage watch's up and down | `self` |
| `canopy:watch:<source>` file watcher per local source | probe: `rt.watcher` is set, every 30 s; an `error` on the watcher reports at once | `auto`: close and `startWatcher` again |
| `canopy:flows` flows records | the lock's outcome at start | `button`: take the lock and restore |
| `canopy:activity` activity pass | the pass's outcome | `self` (the next pass) |
| `canopy:remote` remote refresh | the pass's outcome | `self` |
| `canopy:keep` keepShells | the pass's outcome | `self` |
| `canopy:gone` cards for checkouts that are gone | a repo's refresh errors and its `.git` is not on disk (moved, renamed, deleted) | `self`: rescan its source, which drops the card |

Checks for things not set up here (no broker, no stage runner, keepShells off)
report `off`.

**Tailchan's heal lives in `Chan.follow`.** The broker writes `: ping` every
20 s. `follow` keeps a silence deadline (`FOLLOW_SILENCE`, 60 s) reset on every
raw chunk `reader.read()` returns, since `parseSse` drops comments. When the
deadline passes it aborts the fetch and the existing catch redials. This fixes
the registry and asks streams too, since they use the same `follow`. No outer
restart loop wraps a follow that already redials forever. `ChanHub.start()` is
guarded against a second call.

**The flows lock is a button, not a heal.** Winning the lock means restoring
the flows and the incubator, which reruns mid-step flows. The check is `down`
with "canopy pid N keeps the flows" while another server holds the lock. When
that pid is gone the words say so, and the button takes the lock and runs the
same restore the startup does (extracted from `startServer` into one function
both call).

**A remote backend being unreachable** is the page's knowledge, not the
server's: `ui/src/backends.ts` already tracks connecting, online, offline and
signin for each backend. The UI adds a client-side check per backend from that
state. The server does not probe other backends.

## Phase 1: the UI

One component, `HealthList` (`ui/src/components/Health.tsx`), shows checks
grouped by scope, each row with its state word, why, since, detail and the
heal button when the mode allows one. A row opens to show its history. Pure
helpers in `ui/src/health.ts` (sorting, grouping, the words), tested.

It is rendered in three hosts:

- **The chip**, `HealthChip` in `TopBar`: a drawn pulse glyph and nothing else
  while all is well (`ink-faint`); amber with a count on `warn`, rust with a
  count on `bad`. One per backend when the page shows several, like the stages
  word. A click opens the popover with `HealthList`. The popover's head has
  "open as panel" and "open page".
- **The dock panel**, reserved id `/health` (`HEALTH_PANEL`, beside
  `WAITING_PANEL` and `CLI_PANEL`, added to `isReservedPanel`). It docks,
  tabs, splits and moves like any panel.
- **The page**, `health` in `VIEWS` (`?view=health`), the same list at full
  width with every row's history open.

The store keeps `health` per backend, with an event counter so a late GET does
not overwrite a newer event (the stages entry's rule). The command line gets
`health`, which opens the page.

Waiting's `failedRows` adds every `gave-up` check, newest first, each opening
the health panel on its row.

The CLI gets `canopy health`, which prints the running server's checks
(`GET /api/health`), one line each, exit 1 when any is `down` or `gave-up`. A
compose healthcheck or a script can use it.

## Phase 2: repo operations

### Declaring checks

A repo's checks come from `.canopy/health.json` (checked in) and canopy's
config `health` keyed by repo path (per machine), the config overriding the
repo file by name, as tasks do:

```json
{
  "checks": [
    { "name": "site", "kind": "http", "url": "http://127.0.0.1:5173/", "expect": 200, "every": 30 },
    { "name": "api",  "kind": "port", "port": 7850 },
    { "name": "dev",  "kind": "task", "task": "dev", "heal": "auto" },
    { "name": "db",   "kind": "compose", "service": "postgres", "heal": "button" },
    { "name": "smoke","kind": "command", "run": "bun run smoke", "every": 300 }
  ]
}
```

Kinds:

- `http`: a GET with a timeout (5 s default). Ok on the expected status (any
  2xx or 3xx when unset). `detail` is the status and the time taken.
- `port`: a TCP connect to `host` (default `127.0.0.1`) and `port`.
- `task`: the named task's status from the tasks hub. Running is ok.
- `compose`: `docker compose ps --format json <service>` in the repo. Running
  and healthy (or with no healthcheck) is ok.
- `command`: runs in the repo with a timeout (30 s default). Exit 0 is ok, and
  the last line of output is `detail` or `why`.

Heals:

- `heal: "auto" | "button" | "none"`, default `button`.
- A `task` check's heal restarts the task through the tasks hub. A `compose`
  check's heal is `docker compose restart <service>`. Any check can name
  `"fix": "<command>"`, which is its heal instead.
- `every` is seconds, default 30, at least 5.

**Safety.** A `command`, `compose` or `fix` from the repo's own file runs code
the repo wrote, so it follows the own-repo rule exactly as a task's `keep` does:
in a repo `own` does not say is the user's, those checks are listed as `off`
with "not run: not your repo" and nothing runs. Anything that runs in the
checkout (`task`, `compose`, `command`, a `fix`) runs for local repos only. A
repo on another host or a forge gets only `http` and `port`, and not those
when they point at a loopback address, which would be canopy's machine. Seeds
get none of the ones that run in the checkout. `auto` from a repo's own file is
honoured only in own repos, so a clone's file can never make canopy restart
anything by itself.

Changed while building phase 2: canopy's own layer (the checks added in the
panel, kept in canopy's config) is the user's own words, so the own-repo rule
does not hold it back. A `command`, `compose` or `fix` added there runs on a
clone too, and its `auto` stays `auto`. The local-only and seed rules still
apply to it.

The checks are read at scan time and again when the file changes (the watcher
already sees `.canopy/`). `parseHealthFile` and `mergeChecks` are pure and
tested, and they report errors per entry the way `parseTaskFile` does.

### The card adapts

A repo with no checks keeps today's card. A repo with checks gets an
operations line on its card, a coloured-text fact like branch and tip (the
one-box-deep rule, no nested badge):

- all ok: `up` in moss, with the first `http` check's time ("up · 42ms");
- some down: `2 of 3 up` in amber, the down names in the title;
- all down or any gave up: `down 3m` in rust;
- healing: `healing` in lichen.

A repo whose checks are bad takes the card's attention styling, so it sorts
and filters with the repos that need a look. The board's filters gain
`health-bad`.

The repo panel gets a **health** section (`health` in `SECTION_KEYS`) showing
`HealthList` for that repo's checks, with a heal button per row and an "add
check" sheet that writes canopy's config layer (kind, name, the kind's fields,
heal, every). Editing the repo's own file stays a file edit.

The chip, panel and page from phase 1 list repo checks under each repo's name.

## Error handling

- A probe that throws counts as a failed probe with the error's message as
  `why`.
- A probe that hangs is cut at its timeout (`http` 5 s, `command` 30 s,
  `compose` 10 s, tmux 5 s) and fails with "timed out".
- A heal that throws counts as a failed heal.
- A listener or broadcast that throws is caught and logged, and never stops
  the hub (the stage client's rule).
- `hub.stop()` clears every timer and drops pending heals, so a test or a
  shutdown leaves nothing running.

## Testing

- `src/core/health.test.ts`: every transition in `observe`, the backoff curve,
  the give-up at `HEAL_MAX`, the reset after `RESET_AFTER`, the history cap and
  the summary levels. Pure, with explicit times.
- `src/server/health.test.ts`: the hub with fake probes and a fake clock:
  polling one at a time, the heal loop, give-up calling `onGaveUp` once, the
  event sent only on a change, the routes' 404 and 409.
- `src/core/chan.test.ts` (or the existing tailchan test): the follow aborts
  and redials after `FOLLOW_SILENCE` with no bytes, and a `: ping` comment keeps
  it alive.
- `ui/src/health.test.ts`: grouping, sorting and words.
- Phase 2: `parseHealthFile` and `mergeHealth` (layering, errors, the own-repo
  rule), each probe kind against a local fixture (an HTTP server on a random
  port, a closed port, a command that exits 1), and the card's word for each
  mix of states.
- A live check on a scratch server: kill the tailchan broker connection and
  watch the chip go and come back; break a watcher; declare an `http` check on
  a repo and stop its dev task.

## Out of scope

- Restarting canopy itself when it hangs, and compose healthchecks on the
  canopy service. `canopy health` makes that a later one-line change.
- Probing other backends from the server.
- Persisting history across restarts.
- Detecting checks from a repo's files (a compose file, a dev port).
- Health for the Library child and the preview proxy.
