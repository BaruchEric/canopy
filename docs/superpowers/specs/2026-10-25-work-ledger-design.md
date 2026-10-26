# A durable work ledger (FR-037)

FR-037 asks for a record of each piece of work that outlives the run that
did it: what it was, which branches, runs, PRs and events served it, where
it stands, and a line or two from whoever last touched it on what the next
hand should know. The idea is Beads (github.com/gastownhall/beads), the
git-backed issue and memory ledger under Gas Town, which Steve Yegge says
was the one part that survived every version of his harness
("The Shape of Things to Come", yegge.ai), and Symphony's rule that the
tracker, not the session, is the unit of work (github.com/openai/symphony).
canopy's tmux keeps processes alive and its landing records keep branches,
but a piece of *work* has no identity: three runs, a PR and a trigger event
on one issue are four records that know nothing of each other, and a
replacement session starts from the note alone. Ranked sixth in
`2026-10-25-software-factory-borrowings-design.md`.

## Where things stand (2026-10-25)

- **Runs are memory.** `Run` (`src/core/types.ts`) lives in the Runner; the
  last 60 finished stay until a restart. `Run.note`, `Run.result.text`,
  `Run.session` and `Run.branch` are what a later reader has.
- **Branches are records.** `LandingRun` in `<configDir>/landing/runs/<branch
  id>.json` carries `runId` (the latest run on the branch), `note`,
  `session`, `review`, `pr`. "Fix it" resumes `session` with the reason.
  `PrWatch` in `<configDir>/prs/<branch id>.json` carries the PR.
- **Events and cards.** `TriggerEvent` in `triggers/events.json` names its
  `branch`, `runId`, `flowId` and `pr`. A coordinator's cards are
  `Run.tasks` on the coordinator and die with it.
- **The id in git.** `runBranchName(note, runId)` (`src/core/worktree.ts`)
  gives `run/<slug>-<run id>`; the run id is the only identity a branch
  carries, and it names a run, not the work. `branchLine`
  (`src/core/actions.ts`) tells the agent to commit and not push; it asks
  for no trailer. `prBody` (`src/core/pr.ts`) puts the note and the commit
  subjects in the PR.
- **Notes are nowhere.** FEATURES.md is kept by hand. FR-020 (quick notes
  and reminders) is open. The inbox shows asks and sent-back branches, not
  "where this stands".
- **Lock and writers.** Landing records, PR watches and trigger events are
  written only by the holder of the flows lock (`adopt`/`detach`), one
  serial queue each. A second server on the same config dir reads and
  never writes.
- **`.canopy/tasks.json` is supervised processes.** The word "task" is
  taken twice over (tasks, and a coordinator's cards). This spec says
  **work item**.

## The work item

```ts
interface WorkItem {
  /** `w-` and 8 lowercase base32 characters, minted by canopy */
  id: string;
  title: string;
  /** repo ids on this backend; a coordinator's goal may span several */
  repos: string[];
  state: "open" | "working" | "review" | "landed" | "dropped";
  /** where it came from */
  from: { kind: "note" } | { kind: "issue"; service: string; key: string; link?: string }
      | { kind: "coordinator"; run: string; card: string } | { kind: "trigger"; event: string };
  /** everything that served it, newest last */
  runs: string[];
  branches: string[];       // RunBranch.origin
  prs: { number: number; url: string }[];
  events: string[];         // TriggerEvent.id
  /** handoff notes, oldest first */
  notes: { at: number; by: string; text: string }[];
  createdAt: number;
  updatedAt: number;
  closedAt?: number;
  /** why it was dropped */
  reason?: string;
}
```

- `by` is `eric` for a note from the page or the CLI (the caller's label),
  `agent` for one the run left, `canopy` for the lines canopy writes
  itself (below). A note is at most `NOTE_CHARS` (600) characters; an item
  keeps at most `NOTES_MAX` (40), oldest folded into one "earlier: …" line.
- The state is derived, never set by a run: `open` with nothing going,
  `working` while any of its runs is active or a branch is `working`,
  `review` once a branch is `ready` (queued, sorted, or a PR open),
  `landed` when a branch landed or a PR merged, `dropped` when Eric drops
  it or every branch was dropped. `canopy work close` sets `landed` or
  `dropped` by hand with a reason.

### Where it is kept

`<configDir>/work/<id>.json`, one file per item, written only by the holder
of the flows lock through one serial queue, read back at `adopt` like the
landing records. `work/archive.jsonl` holds compacted items (below). The
ledger does not sync between backends; the Mac's and the mini's are
separate, as the cost ledgers are, and the page reads every online
backend's and qualifies the ids (`qual`).

**Not in the repo.** Beads kept its ledger in the repo and spent a year on
merge conflicts between agents writing it on parallel branches before it
moved to Dolt. canopy's rule (SPEC.md, 2026-09-24) is that work moves
between machines through commits and nothing else, and a `.canopy/work/`
file every branch run edits would be the one file every branch conflicts
on at rebase. So the ledger is the server's, and **git carries the id**,
not the ledger:

- the branch is `run/<id>-<slug>` in place of `run/<slug>-<run id>`
  (`runBranchName` takes the item id; the run id stays on the record);
- `branchLine` asks for a trailer, `Canopy-Work: w-xxxxxxxx`, on every
  commit, and `prBody` puts `Canopy-Work: w-xxxxxxxx` on its last line;
- a run's closing text may end with a `## Handoff` section (below).

So a rebuilt config dir, or the other backend, can find what served an
item with `git log --all --grep='Canopy-Work: w-xxxxxxxx'` and
`gh pr list --search 'Canopy-Work: w-xxxxxxxx'`, and `canopy work rebuild
<repo>` does exactly that to re-derive `branches`, `prs` and the commit
subjects for an item the ledger lost. The trailer is a request to the
agent, not a gate: a commit without it costs nothing but that rebuild.

### When one is made

Every branch gets an item. `startBranchRun` (`src/server/index.ts`) is the
one place branches are cut, so it is the one place items are minted:

- A branch run from the pre-flight: a new item with the note's first line
  as its title (an issue start uses the issue's title and `from: issue`).
- A trigger's run or flow: `from: trigger`, titled by the event's `title`.
- A coordinator's child: `from: coordinator`, titled by the card's title.
  The coordinator's goal is **not** an item of its own in v1; the cards are
  the work.
- "Fix it", a resume, a PR fix run, a conflict fix: the same item (the
  record carries `work`), its `runs` appended.
- A checkout run (no branch) gets no item. It leaves no branch to name and
  ends in the checkout Eric sees.

`LandingRun`, `PrWatch` and `TriggerEvent` gain `work: string`. The hub
that moves each of them calls `WorkHub.note(id, …)` with the line canopy
writes: "branch ready, sorted logic", "sent back: conflict in 2 files",
"PR #41 opened", "fix 2 of 3 for check test", "landed". These are the
`by: canopy` lines, so an item's notes read as a history without anyone
typing.

## Handoff

The point of the ledger is that the next session starts informed.

- **Into a run.** Every run on an item's branch that is not its first (fix
  it, resume, PR fix, conflict fix, a coordinator's retry) gets the item's
  notes ahead of its message, fenced as data between `<<<` and `>>>` with
  the lead "What the last hands left on this work:", newest last, cut to
  `HANDOFF_CHARS` (3000) from the end. A first run gets nothing; its note
  is its brief.
- **Out of a run.** `branchLine` gains one sentence: "Before you end, leave
  one or two lines for whoever picks this up next, under a `## Handoff`
  heading at the end of your closing message." `fromRun`'s shape in
  `src/core/work.ts` (`handoffOf(text)`) takes the text under that heading
  from `Run.result.text`, cut to `NOTE_CHARS`, as a `by: agent` note. Once
  FR-038 (`2026-10-25-agent-surface-design.md`) gives a branch run a token,
  the agent may also call `canopy work note "<text>"` mid-run, which
  reaches the same route; the closing heading stays as the way that needs
  no token.
- **From Eric.** The run sheet's branch block shows the item's title and
  its last two notes, with a one-line box "leave a note"; the `work` view
  has the same per item; `canopy work note <id> "<text>"` from a shell.

A note is never an instruction canopy acts on. It is text shown to the next
agent as data, and to Eric.

## Views

- **`work` view** (`?view=work`, `g w`): items by state, Needs you first
  (any whose branch sorts `approve`, is sent back with no fix going, or
  whose event `needsYou` is set, FR-035), then working, review, open,
  and a folded landed/dropped for the last 30 days. Each row: title, repos,
  state word, the newest note, and the branch, PR, event and run links. A
  row opens a sheet with the full notes and the box. A filter by repo and a
  search over titles and notes, client-side.
- **Run sheet.** Under the branch line: "work: <title>", the last two
  notes, the box.
- **Landing section and triggers view.** Each row's title links to the
  item; nothing else changes.
- **Card chip.** The repo card's landing chip already counts queued and
  sent back; items add nothing to the card.
- **FR-020.** A quick note on a repo may later attach to an item (`canopy
  work note` with no id on a repo with one open item does); the spec for
  FR-020 decides the rest.

## Routes and CLI

- `GET /api/work[?repo=&state=]` (read): `WorkInfo { items, archived:
  number }`, also the `work` SSE event on every change (the whole list,
  like `prs`).
- `GET /api/work/one?id=` (read): one item with every note.
- `POST /api/work/note {id, text}` (operate; a run-bound token from FR-038
  may post for its own item only, as a coordinator's token may plan for its
  own run): appends a `by` note.
- `POST /api/work/close {id, state: "landed" | "dropped", reason?}`
  (operate): by hand; refused (409) while a run on it is active.
- `POST /api/work/rebuild {repo}` (operate): walks `git log --all` for the
  trailer and `gh pr list` for the search, and fills `branches`, `prs` and
  a `by: canopy` note "rebuilt from git" on each item found; makes items
  for ids it finds that the ledger lacks, titled by the first commit
  subject. Refused on a repo with a host.
- `GET /api/work/export?id=` (read): the item as markdown (title, state,
  links, notes as a dated list), for pasting into FEATURES.md or an issue.
- CLI (`src/cli/work.ts`): `canopy work [list] [--repo R] [--state S]`,
  `canopy work show <id>`, `canopy work note <id> "<text>"` (inside a
  canopy shell on a branch worktree, `<id>` may be omitted: the CLI reads
  the branch name under the cwd), `canopy work close <id> --landed |
  --dropped [-m why]`, `canopy work rebuild <repo>`, `canopy work export
  <id>`.

## Compaction

A sweep pass once a day (the sweep's hour, `DEFAULT_SWEEP.cron`) moves items
`landed` or `dropped` for more than `ARCHIVE_AFTER` (90 days) to
`work/archive.jsonl`, one line each: id, title, repos, state, closedAt, the
first and last note. The file is append-only and `canopy work show` reads
it when the id is not in `work/`. Nothing is deleted.

## Restart and the lock

Items are read at `adopt`, written at `detach` and after every change
through the serial queue. A run that was working when canopy stopped
leaves its item `working` until `afterRestart` moves it with the run's
record (`stopped` run, item back to `open` with a `by: canopy` note "cut
off by a restart"). A branch run's item id is in the branch name, so an
orphaned worktree the landing hub finds names its item.

## Components

- `src/core/work.ts` (new, pure, browser-safe): `WorkItem`, `mintId`
  (8 base32 chars from 40 random bits, `w-` prefix, `WORK_ID` regex),
  `stateOf(item, deps)`, `addNote` with the fold, `handoffOf(text)`,
  `handoffFence(notes)`, `workBranchName(id, note)`, `WORK_TRAILER`,
  `trailerOf(message)`, `exportMarkdown`.
- `src/core/workstore.ts` (new, Bun): read and write `work/`, the archive
  append, `rebuildFromGit(repo, gh)` over `git log --all --format=%H%x00%s
  %x00%(trailers:key=Canopy-Work,valueonly)`.
- `src/server/work.ts` (new): `WorkHub` with the serial queue, the routes,
  the `work` event, `note()` for the other hubs, the compaction tick, the
  rebuild.
- `src/core/worktree.ts`: `runBranchName` takes the item id;
  `branchSlug` unchanged.
- `src/core/actions.ts`: `branchLine` gains the trailer and the handoff
  sentence; `branchPrompt` takes the fenced notes for a non-first run.
- `src/core/pr.ts`: `prBody` adds the trailer line.
- `src/core/types.ts`: `LandingRun.work`, `PrWatch.work`,
  `TriggerEvent.work`, `Run.work`, `CoordTask.work`; the `work` event.
- `src/server/index.ts`: `startBranchRun` mints or takes an item;
  `startBranchFix` passes the notes.
- `src/server/landing.ts`, `prs.ts`, `triggers.ts`, `coordinator.ts`: one
  `work.note()` call per state change.
- `src/cli/work.ts` (new).
- `ui/src/work.ts` (new, pure: rows, sections, search), `components/
  Work.tsx` (the view and the sheet), `RunSheet.tsx` (the block),
  `shortcuts.ts` (`g w`), `store.ts` (`work`, `loadWork`, the event).

## Calls

Made on 2026-10-25:

1. **Server-side ledger, id in git.** Not a file in the repo (Beads'
   conflicts, canopy's git-only peer rule); the branch name, a commit
   trailer and the PR body carry the id, and `rebuild` re-derives the
   links. The ledger is a cache of what git knows plus the notes git does
   not.
2. **Every branch has an item, no checkout run does.** A branch is the
   unit of landing; a checkout run ends in front of Eric.
3. **State is derived.** Nobody sets `working` or `review`; the hubs do, by
   what they already know. Only `close` is by hand.
4. **Handoff by heading first, by token second.** `## Handoff` in the
   closing text needs nothing new in the run's env; FR-038 adds the
   mid-run way.
5. **No sync between backends.** Like costs. The id in git is what the
   other machine finds.
6. **The word is work item.** Not task, not card, not issue.

For Eric:

7. Whether the branch name should change shape (`run/w-xxxxxxxx-<slug>`),
   which moves where the run id lives (only on the record) and touches
   `peersync`'s `run/*` exclusion (unchanged, still `run/*`) and every test
   that reads a branch name.
8. Whether the coordinator's goal should be an item too, with the cards as
   children, or stay as v1 has it (cards only).
9. Whether a `by: agent` note should be shown to the next agent at all, or
   only Eric's and canopy's lines, given that a run reading an earlier
   run's words is a run reading text an agent wrote. The spec shows all
   three, fenced as data.

## Out of scope

- A kanban or ordering of open items; the view is by state and time.
- Dependencies between items.
- Writing items into FEATURES.md or an issue tracker on their own;
  `export` is the bridge.
- Syncing the ledger between backends.
- Items for shells, chats or interactive sessions.

## Testing

- `work.test.ts`: `mintId` shape, `stateOf` for each combination of run,
  branch, PR and event state, `addNote` folding past `NOTES_MAX` and
  cutting at `NOTE_CHARS`, `handoffOf` with and without the heading and
  with text after it, `handoffFence` cut from the end, `workBranchName`,
  `trailerOf`, `exportMarkdown`.
- `workstore.test.ts` (scratch dir and repo): write, read back, archive
  line, `rebuildFromGit` over commits with and without the trailer and a
  trailer in a merge commit.
- `server/work.test.ts` (stand-in hubs): an item minted at branch start,
  notes from each hub's state change, `close` refused while a run is
  active, the compaction moving a 91-day-old landed item and leaving a
  60-day one, a note posted by a run-bound token for another item refused.
- `landing.test.ts`, `prs.test.ts`, `triggers.test.ts`: the `work` field
  carried and the `note()` calls made (one assertion each, no new
  scenarios).
- `actions.test.ts`: `branchLine` with the trailer and the handoff
  sentence; `branchPrompt` with fenced notes for a non-first run and none
  for a first.
- `cli/work.test.ts`: the listing and `note` reading the id from the branch
  under the cwd.
- `ui/src/work.test.ts`: sections, Needs you first, the search.

## Plans

1. **The ledger**: `work.ts`, `workstore.ts`, `WorkHub`, items minted at
   branch start, the hubs' notes, the branch name and trailer, `canopy work
   list|show|note|close`.
2. **Handoff and views**: the fenced notes into non-first runs,
   `handoffOf`, the run sheet block, the `work` view, `export`.
3. **Rebuild and compaction**: `rebuildFromGit`, `canopy work rebuild`, the
   archive, the sweep tick.
