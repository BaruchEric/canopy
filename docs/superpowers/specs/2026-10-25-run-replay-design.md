# Run transcripts, replay and fork (FR-043)

FR-043 asks for a run to outlive the server's memory: its wire kept on disk
so a finished run can be opened after a restart, stepped through at speed,
exported as a readable transcript, and forked from a point onto a new
branch or another model. The idea comes from OrcaReplay, the part of Orca
(github.com/stablyai/orca) that records a run and replays or forks it from a
checkpoint. canopy already logs each run's cost and shows its timeline
live; it keeps nothing of the run once the server restarts, so a failed
run from last night is a cost row and a worktree with no story. The
overview is `2026-10-25-software-factory-borrowings-design.md`.

## Where things stand (2026-10-25)

- A run's timeline is `Run.steps` (`RunStep`: `text`, `tool`, `note`,
  `user`, with `parent` for a subagent's steps), capped at `STEP_CAP` (400)
  with the oldest falling off, held in `Runner.live`; `KEEP_FINISHED` (60)
  finished runs stay for late-joining browsers until a restart. `GET
  /api/runs` serves what is in memory and nothing else.
- The wire is read once and folded: `ClaudeDriver` iterates `lines(proc.
  stdout)` and handles each message inside the class (`assistant`/`user`
  blocks into steps, `control_request` into prompts, `system` subtypes into
  the subagent set, `result` into `ctx.result`); `codexrun.ts` does the same
  for JSON-RPC items. Tool output is cut to `OUTPUT_CAP` (2000 characters)
  per step. The raw line is not kept.
- `Run.session` is Claude's session id or Codex's thread id. Claude writes
  its own transcript under `~/.claude/projects/<cwd slug>/<session>.jsonl`
  on the machine that ran it; Codex under `$CODEX_HOME/sessions/...`
  (`codexSessions` reads the first line for the sessions view).
  claude-history archives Claude's and canopy reads it through the CLI's
  `--json` (`core/history.ts`, `HistorySessionDetail`), never the sqlite.
- `--resume <session>` is how a landing "fix it" continues a branch's
  session (`DriveSpec.resume`); `--fork-session` is a flag canopy knows
  (`ranger.ts`'s `DROPPED` list) and never passes.
- The costs ledger has one row per reply (`costs/<YYYY-MM>.jsonl`), so a run
  has a cost history with no transcript behind it. The sweep's `run` span
  (3 days) drops finished runs from memory.
- A branch run's worktree and landing record outlive a restart; the run
  itself reads `stopped` with no steps.

## Probes before plan 1

- **P1.** `claude -p --resume <id> --fork-session`: that it starts a new
  session id with the old transcript as context, that the new id is in its
  `system`/`init`, and that `--model <other>` on the same line switches the
  model for the fork (expected yes: the model is per process).
- **P2.** A fork started in a worktree other than the original session's
  cwd: whether `--resume` finds the transcript (Claude files sessions under
  the cwd's slug, so a different cwd may not see it) and whether `--add-dir`
  or copying the transcript file into the new cwd's slug folder is needed.
  The design below assumes a copy is needed and says where.
- **P3.** The transcript file's shape: one JSON object per line with `uuid`
  and `parentUuid`, so a cut at a step is a prefix of the file plus the
  lines of its ancestors; whether a truncated file resumes cleanly, and what
  the CLI does with a file whose last line is a tool_use with no result
  (expected: it asks the model to continue). If a cut does not resume, v1
  forks whole sessions only.
- **P4.** Codex: whether `codex app-server` can resume a thread by id into a
  new one (`thread/fork` or `thread/resume`), or only `thread/resume`; if
  neither forks, Codex forks are the summary handoff only.
- **P5.** Gzip in Bun: `Bun.gzipSync` on a 50 MB file's memory, or a
  streaming `CompressionStream`, for the settle-time compression.

## Design

### The wire on disk

`core/runlog.ts` (Bun-only, small pure parts) writes each run's wire as it
arrives:

- `<configDir>/runs/<id>/wire.jsonl`: every stdout line the driver read
  (Claude's stream-json; Codex's JSON-RPC notifications and results), one
  per line, prefixed by canopy's own line `{"canopy": "start", at, run,
  repo, action, harness, argv: <redacted>}` and closed by `{"canopy":
  "end", at, status, error?}`. Lines canopy sent down stdin (answers,
  `set_permission_mode`, a chat's messages) are written too, as
  `{"canopy": "in", at, line}`, so a replay has both directions.
- `<configDir>/runs/<id>/run.json`: the `Run` as it stood at settle (steps,
  result, branch, parent, prompt history), written once; the live path
  changes nothing about how the browser gets a run.
- Written through one append stream per run, flushed per line; a write
  error ends logging for that run with a `note` step ("transcript stopped:
  <error>") and never fails the run.
- Size: past `RUN_LOG_MAX` (50 MB) the file is closed with a canopy `cut`
  line and nothing more is written; `run.json` is still written at settle.
- At settle, `wire.jsonl` is gzipped to `wire.jsonl.gz` (P5) and the plain
  file removed. The folder is `0700`, the files `0600`.
- Retention: the sweep gains a `transcript` span (`RUNS_KEEP`, 30 days) and
  removes a run's folder past it, `auto` by default; a run whose branch is
  still in the landing records or whose PR is open is kept whatever its
  age. `canopy run prune` does the same from the shell.
- A stage run (an incubator seed) is logged like any run; a coordinator's
  chat too. The ranger is an interactive session, not a run, and is out.

The driver change is one seam: `DriveCtx` gains `wire(dir: "in" | "out",
line: string)`, which the Runner wires to the run's log; both drivers call
it before they parse. Nothing about folding changes in plan 1.

### Opening a run after a restart

- `GET /api/runs/<id>` (`read`) answers the live run, else `run.json` from
  disk with `kept: true`; `GET /api/runs?kept=1` lists the kept runs'
  heads (id, repo, action, status, started, ended, cost) from a
  `<configDir>/runs/index.json` the logger appends to at settle (rebuilt
  from the folders when missing or unreadable).
- The run sheet opens a kept run read-only: the timeline, result, branch
  block (with the landing record's state), and a "kept" chip; no composer,
  no answer forms. A branch run that reads `stopped` after a restart opens
  its kept steps under the stopped notice, so "fix it" has its story.
- The sessions view and the costs view link a run's row to its kept sheet
  when the folder exists.
- Rebuilding `steps` from `wire.jsonl` instead of `run.json` is plan 2:
  the folding in both drivers is pulled into pure reducers (`foldClaude(
  state, m)` in `claudedrive.ts`, `foldCodex` in `codexrun.ts`) that the live
  path and the replay share, tested against the same fixtures. Until then
  `run.json` is the truth and the wire is for replay and export.

### Replay

A kept run's sheet gets a replay bar: play at 1× (steps appear at their
recorded `at` spacing, capped at `REPLAY_GAP` 3 s between steps), 4×, a
scrubber over the steps, and "jump to" the prompts, the result and each
subagent's start. Pure: `ui/src/replay.ts` turns `steps` and the `in` lines
into a timeline of `{at, step | answer}` and a cursor; the sheet renders
the prefix. Nothing runs; it is the recorded run shown in order.

### Fork

"fork from here" on a step of a kept or finished run:

- Claude, same harness: a new branch run on the same repo, cut from the
  original branch's `base` (so the fork starts where the original did, not
  from what it changed), with `DriveSpec.resume: <session>` and a new
  `DriveSpec.fork: true` that adds `--fork-session` (P1), and the profile
  picked in the fork sheet, which may name another model (`--model` rides
  as it does for any run). P2 decides the transcript's placement: when the
  CLI does not find the session from the worktree, canopy copies the
  transcript file into the worktree's slug folder under `~/.claude/projects/`
  before the start, and removes the copy when the run settles. A fork
  carries `Run.forkOf: {run, step}` and the sheet shows "forked from run
  3f2a at step 41".
- The cut: with P3 showing a prefix resumes, the copied transcript is cut
  at the step's line (the `uuid` chain to that message), so the fork knows
  nothing past it. Without that, v1 forks whole sessions and the "from
  here" is advisory: the fork's first message says "continue from <step's
  text>, disregarding what came after". The sheet says which it did.
- Codex: P4 decides whether a thread forks. Otherwise, and for every
  cross-harness fork (Claude to Codex or back), the fork is a summary
  handoff: `handoffBrief(run, step)` (pure, `core/handoff.ts`) renders the
  steps up to the cut as a fenced brief between `<<<` and `>>>` (the note,
  what was read, what was changed with file names, the last words), marked
  as data, and a fresh run starts on a new branch with that brief as its
  note and `forkOf` set. Tool output in the brief is cut to `OUTPUT_CAP` as
  the steps already are.
- A fork is a new run under every rule that holds today: slots, the
  governor (FR-036; a fork from the page is `interactive`), review rules
  when it lands. A fork of a trigger's unattended run is attended, since
  Eric asked for it.
- Routes: `POST /api/runs/fork {run, step, profile?}` (`operate`); the CLI
  `canopy run fork <id> --at <step> [--profile p]`.

### Export

`canopy run export <id> [--out file.md]` and `GET /api/runs/<id>/export`
(`read`) write a markdown transcript: a head (repo, action, note, agent and
model, when, cost, branch and where it landed), then the steps in order with
Claude's words as prose, each tool call folded as a `<details>` block with
its input and its output's first `EXPORT_OUTPUT` (40) lines, prompts and
their answers as a quoted pair, subagents indented under their `Agent` step,
and the result last. It is what a FEATURES.md source line or a bug report
wants to link.

### Privacy and what never leaves

The raw wire holds what the tools read: file contents, command output, a
`.env` a gate echoed, the text of a secret the agent printed. So:

- the folder is `0700`, the files `0600`, under the config dir, which peer
  sync never carries and the Library never serves;
- `runlog` redacts before it writes: every `CANOPY_` variable's value from
  the run's env, every value the secret store applied on this machine
  (`secrets-applied.json`'s names, read through the existing applied
  reader), and the caller token, each replaced by `<redacted:NAME>`; the
  `argv` in the `start` line has `--mcp-config` paths and any token blanked;
- the export redacts again on the way out, since a value can arrive in the
  wire by another spelling, and names the count of redactions at its foot;
- nothing of a run's wire is ever posted to tailchan, a PR, Linear or
  Sentry; the hubs read `Run` as today.

### Restart

The logger reopens nothing: a run that was going when canopy stopped has a
`wire.jsonl` with no `end` line, which the adopt pass closes with
`{"canopy": "end", status: "stopped"}` and gzips, and writes a `run.json`
from the last `Run` the landing record or the flows store holds (a run with
neither gets a head-only `run.json`). The index is rebuilt from the folders
when it disagrees with them.

## Components

- `src/core/runlog.ts` (new): the writer, the cut, the gzip, the index,
  the redaction (pure `redactLine` tested), `prune`.
- `src/core/driver.ts`: `DriveCtx.wire`; `src/core/claudedrive.ts`,
  `src/core/codexrun.ts`: call it on every line both ways; plan 2's
  `foldClaude`/`foldCodex` reducers.
- `src/core/runner.ts`: the log per run, `run.json` at settle,
  `Run.forkOf`, `DriveSpec.fork`.
- `src/core/handoff.ts` (new, pure): `handoffBrief`.
- `src/core/export.ts` (new, pure): the markdown.
- `src/server/index.ts`: `GET /api/runs/<id>`, `?kept=1`, `/export`,
  `POST /api/runs/fork`; the adopt pass's close.
- `src/core/sweep.ts`, `src/server/sweep.ts`: the `transcript` span.
- `src/core/callers.ts`: `runs/fork` filed `operate`.
- `src/cli/run.ts` (new): `canopy run show|export|fork|prune`.
- `ui/src/replay.ts` (new, pure), `components/RunSheet.tsx` (kept chip,
  replay bar, fork sheet, `forkOf` line), `Sessions.tsx` and `Costs.tsx`
  links.

## Calls

Made on 2026-10-25:

1. **Keep the raw wire, not only the folded steps.** The steps drop tool
   output past 2000 characters and the oldest past 400; a replay or a
   bug report wants what was said. The folded `run.json` is kept too, so
   plan 1 ships without touching the drivers' folding.
2. **Redact at write time and again at export.** A transcript on disk is a
   secret store of its own otherwise.
3. **A fork starts from the original's base, not its head.** Forking is
   "try the other way from here"; a fork that wants the original's commits
   is a "fix it" on that branch, which exists.
4. **Whole-session forks are acceptable for v1** if P3 says a cut does not
   resume cleanly; the sheet says so.
5. **30 days, swept with the rest**, kept while the branch or PR is live.

For Eric:

6. **Whether stage (incubator) runs are logged.** They read seeds' code and
   can be large; the default here is yes, with the same cap.
7. **The export's home**: the config dir alone, or also a `docs/runs/`
   folder in the repo for a run Eric wants to cite (a commit, so the
   review rules see it as docs).

## Out of scope

- Replaying a run against the model again (re-execution). A replay shows
  what happened; a fork runs anew.
- Diffing two runs' transcripts (FR-033's comparison reads the branches,
  not the wires).
- Syncing transcripts between backends. The archive (claude-history) is
  where Claude's sessions already meet across machines.
- A transcript viewer for sessions canopy did not start (the sessions view
  and claude-history cover them).

## Testing

- `runlog.test.ts`: lines both ways in order, the start and end lines, the
  cut at `RUN_LOG_MAX`, gzip at settle, `redactLine` on env values, applied
  secrets and tokens (and a value split across a line boundary is out of
  scope and said so), the index rebuilt from folders, `prune` keeping a run
  whose branch is live.
- `driver.test.ts`, `claudedrive.test.ts`, `codexrun.test.ts`: every line
  reaches `wire`; the fake CLI replays P1's fork `init` with the new session
  id; plan 2's reducers fold a recorded wire into the same `steps` the live
  path made.
- `handoff.test.ts`: the brief at a step, fenced, output cut, subagents
  indented.
- `export.test.ts`: the markdown on a fixture run, redaction count.
- `server` tests: `GET /api/runs/<id>` live then kept, `fork` on a kept run
  cutting from `base`, the transcript copy placed and removed (P2), the
  adopt pass closing an open wire.
- `ui/src/replay.test.ts`: the timeline, the cap, the jumps.

## Plans

1. **The wire on disk and kept runs**: `runlog`, `DriveCtx.wire`,
   `run.json`, `GET /api/runs/<id>`, the kept sheet, the sweep span,
   `canopy run show|export|prune`, redaction (P5).
2. **Replay and the pure reducers**: `foldClaude`/`foldCodex`, replay from
   the wire, the replay bar.
3. **Fork**: P1–P4, `--fork-session`, the transcript copy and cut, the
   summary handoff, `POST /api/runs/fork`, the fork sheet.
