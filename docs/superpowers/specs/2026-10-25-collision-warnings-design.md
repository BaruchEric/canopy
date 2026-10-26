# Pre-edit collision warnings (FR-040)

FR-040 asks canopy to say, while two runs are still working, that they are
editing the same files, rather than at rebase time when the queue sends the
second one back with a conflict. The idea comes from Concord MCP and
foremerge, where runs declare the files they intend to touch, and from
juliensimon/canopy's "collision detection" between parallel Claude Code
worktrees (https://github.com/juliensimon/canopy). Canopy needs no
declaration: it reads every tool call a run makes off stream-json, so the
set of files a run has touched is already in the server, step by step. The
feature is a model over what is there, a few words in the right places, and
nothing that stops a run. Ranked ninth in
`2026-10-25-software-factory-borrowings-design.md`, and small.

## Where things stand (2026-10-25)

- `ClaudeDriver` (`core/claudedrive.ts`) makes a `RunStep` of kind `tool`
  for every `tool_use` block, with `RunTool {name, title, status, output}`;
  the title comes from `describeTool(name, input, cwd)` (`core/actions.ts`)
  and holds the file for `Edit`, `Write`, `Read`. The input itself is not
  kept on the step. `codexrun.ts` makes the same steps from `itemTool`.
- A permission prompt carries more: `PermissionAsk.paths` for a file tool
  and `command`/`cwd` for Bash (`permissionAsk` in `claudedrive.ts`,
  `approvalPrompt` in `codexrun.ts`). A run under `acceptEdits` or a
  remembered rule edits without a prompt, so prompts alone miss most edits.
- `core/explain.ts` reads a shell line: `splitShell` gives each simple
  command's words and the files its redirects write and read;
  `explainCommand` sets `writes`, `deletes` and `outside` flags; `reaches`
  normalises every path-shaped word against the cwd. It does not list the
  files a command writes.
- A branch run's files are listed exactly once it settles ready:
  `sortBranch` (`core/review.ts`) walks `git diff --raw` from the merge base
  and keeps them as `RunReview.files`.
- The main checkout's own uncommitted files are on `RepoStatus.files`,
  re-read on every change and broadcast with the repo.
- The queue finds out late: a conflict at `rebaseOnto` sends the entry back
  with the files; a main checkout whose own changes touch the same files
  makes `ffMain` answer `busy`.
- `Runner.say` takes a message only on an idle chat; a job run cannot be
  spoken to mid-run. `ctx.note` adds a one-line remark to any run's
  timeline.
- `LandNotice` has two kinds, `landed` and `held`, kept in
  `landing/notices.json` and listed at the inbox's foot outside its count.

## The touched set

### Per step

`RunTool` gains `paths?: string[]`: the files a tool call touches, as paths
from the repo's root, set by the driver at `tool_use` time from the input:

- `Edit`, `Write`, `MultiEdit`, `NotebookEdit`: `file_path` or
  `notebook_path`, resolved against the run's cwd (the worktree or the
  checkout) and made relative; a path outside the repo is kept as absolute
  and never matched (it is `outside`, which the inbox already shows).
- `Bash`: `writtenPaths(command, root, cwd)`, new in `core/explain.ts`
  beside `explainCommand`: every redirect target `splitShell` lists as
  written, and the operands of the writers canopy already names (`mv`, `cp`
  (its last operand), `rm`, `touch`, `tee`, `sed -i`, `git mv`, `git rm`,
  `git checkout -- <path>`, `git restore`), each through `reaches`. A
  command that is `opaque` or `vague` adds no paths and sets
  `RunTool.touchesUnknown: true`, which the words below read as "and ran
  commands canopy could not read".
- Codex: `itemTool`'s `apply_patch` and file-change items carry their paths
  (to confirm against the 0.159 schema: the `fileChange` item lists
  `changes[].path`); a `commandExecution` item goes through `writtenPaths`.
- `Read`, `Grep`, `Glob` and every other tool add nothing. Reading is not
  touching.

The paths ride on the step, so the run's broadcast carries them and the
page can draw the set with no new event. At most `TOUCH_MAX` (500) distinct
paths per run; past that the set reads "500 files and more" and matching
stops, since a run rewriting the tree is not a collision case.

### Per run

`core/touch.ts` (new, pure, browser-safe, tested) folds steps into a
`Touched`:

```ts
interface Touched {
  run: string;
  /** the branch's id for a branch run, so the origin and its "fix it" runs read as one */
  origin?: string;
  group?: string;
  paths: Set<string>;
  /** directories a command moved or removed whole: `git mv src/a src/b`, `rm -r docs/old` */
  dirs: Set<string>;
  unknown: boolean;
}
```

`touchedOf(run)` builds it from `run.steps`; `addStep(t, step)` extends it
as steps arrive. `overlap(a, b)` is the paths both hold, plus any path of
one under a dir of the other. Two `Touched` with the same `origin` or the
same `group` never overlap: a branch and its fix-it runs are one piece of
work, and the members of a best-of-N group (`2026-10-25-best-of-n-design.md`)
touch the same files by design.

### What a run is compared with

`CollisionHub` (`server/collisions.ts`, or a block in `LandingHub` if it
stays under 200 lines; the pure model is in `core/touch.ts` either way)
keeps a `Touched` per live run on this backend, built from the runner's
`onChange`. For each change it compares the run with, in the same repo:

1. **Other live runs**: branch runs and the checkout's run or flow step.
2. **Queued and ready branches that are not live**: their `review.files`
   from the landing record, since the run ended and the diff is the
   truth. A `stopped` run with a sort counts the same way.
3. **The main checkout's own uncommitted files**: `RepoStatus.files` of the
   repo, which are Eric's (or a shell's) and would make the landing wait
   as "main checkout busy".

A match is a `Collision`:

```ts
interface Collision {
  id: string;
  repoId: string;
  /** the run that just touched, and what it collided with */
  run: string;
  with: { kind: "run"; run: string; verb: string } | { kind: "branch"; origin: string; branch: string } | { kind: "checkout" };
  paths: string[];
  at: number;
}
```

One collision per pair is kept live, its `paths` growing as more overlap
appears; the hub says something the first time a pair collides and again
only when the overlap gains `COLLISION_RESAY` (5) paths. A pair whose runs
both ended, or whose branches both left the queue, drops out of the live
list. Nothing is written to disk: the sets are rebuilt from `Run.steps` as
runs are adopted, and a run a restart stopped has no live set, only its
sort's files.

## What canopy says

The rule is: say it where the work is, never stop anything.

- **The run's timeline.** `ctx.note` on the touching run: "also being
  edited by <verb> run <short id>: src/a.ts, src/b.ts" (at most 5 paths,
  then "and n more"). A job cannot be told more than this, and the note is
  in its session's transcript for a later "fix it" to read.
- **A chat run**, idle: `Runner.say` with the same line, framed as data:
  "canopy: another run (<verb>, started <when>) has edited these files
  since you started: <<< paths >>>. Carry on; the queue rebases when you
  land." Once per pair. A chat that is working hears it at its next idle,
  if the collision still stands. A coordinator is a chat, so it hears that
  two of its children collide and may re-plan; it is not held.
- **The landing section.** A run's row and a queued entry's row get a
  `⚠ overlaps` chip with the other side's name; folding it lists the
  paths. `LandEntry.overlap?: {with: string; paths: string[]}` is set at
  enqueue when the entry's files meet a working run's set, so Eric knows a
  rebase conflict is likely before the turn finds it. The chip is a word,
  not a hold; the turn runs as before.
- **The run sheet.** The branch line shows the chip; the diff's file list
  marks shared files.
- **The inbox's foot.** A `collision` kind on `LandNotice`: "<branch> and
  <branch> both edit src/a.ts", kept with the others in
  `landing/notices.json`, cleared by the same `POST /api/landing/seen`,
  outside the count. Nothing asks.
- **The checkout case.** When the other side is Eric's own uncommitted
  work, the words are "your uncommitted changes to src/a.ts overlap <run>;
  the landing will wait for them". The "waiting on you" panel's attention
  row for the repo gets the same line, since that is where Eric sees his
  dirty repos.
- **"fix it" after a conflict.** `fixPrompt` adds, when the entry had an
  `overlap`, "canopy saw run <id> editing these files while you worked",
  so the agent knows the conflict is from a neighbour and not from main
  moving.

## The compare sheet (FR-033)

The group sheet shows, from the members' `Touched` sets, the files every
member touched and the files only one did, two short lists over the table.
No collision is raised inside a group.

## Routes and CLI

- `LandingInfo.collisions: Collision[]` rides on `GET /api/landing` and the
  `landing` event. No new route.
- `canopy queue [repo]` prints "overlaps with <run>: a.ts, b.ts" under an
  entry that has one; `canopy collisions [repo]` lists the live ones with
  their paths.

## Components

- `src/core/touch.ts` (new): `Touched`, `Collision`, `touchedOf`,
  `addStep`, `overlap`, `collide`, `TOUCH_MAX`, `COLLISION_RESAY`,
  `collisionLine`.
- `src/core/explain.ts`: `writtenPaths`.
- `src/core/claudedrive.ts`, `src/core/codexrun.ts`: `RunTool.paths` and
  `touchesUnknown` at tool time.
- `src/core/types.ts`: `RunTool.paths`, `RunTool.touchesUnknown`,
  `LandEntry.overlap`, `LandNotice.kind` `collision`,
  `LandingInfo.collisions`.
- `src/core/landing.ts`: `enqueue` taking the working sets, `fixPrompt`'s
  line.
- `src/server/collisions.ts` (new) or `server/landing.ts`: the hub, the
  notes, the says.
- `src/cli/land.ts`: the queue line; `canopy collisions`.
- UI: `ui/src/landing.ts` (`overlapChip`), `Landing.tsx`, `RunSheet.tsx`,
  `Waiting.tsx`'s attention row, `GroupSheet.tsx` (FR-033).
- `docs/architecture.md`: a paragraph under "The landing queue".

## Calls

Made on 2026-10-25:

1. **No declarations.** An agent asked to declare what it will touch
   declares what it thinks; the tool calls say what it did. Concord's
   reservations also need every agent to use the same MCP; canopy's runs
   already go through canopy.
2. **Never a hold.** Two runs editing one file is often fine (one adds a
   function, one fixes a typo) and the rebase settles it. A hold would
   trade a cheap conflict for an idle slot. The coordinator may re-plan on
   its own words; canopy does not plan for it.
3. **Reads are not touches.** A run that reads a file another is editing
   has stale knowledge, not a conflict. Saying so would drown the signal.
4. **A directory moved or removed counts.** `git mv src/a src/b` collides
   with every edit under `src/a`, which `rebase` will report as a rename
   conflict later.
5. **Group members and fix-it runs never collide with their own.** Same
   `group` or same `origin` is one piece of work.

For Eric:

6. Whether the coordinator should hold a card whose repo has a working run
   touching the same area. The card's note is prose; guessing its files is
   unreliable, so the spec only tells the coordinator. A later `paths` hint
   on a card (`validatePlan` accepting globs) would make a hold exact.
7. Whether the chat's `say` is welcome or noise. It is on by default and a
   per-repo agent setting `collisionSay: false` turns it off; the notes and
   chips stay.

## Out of scope

- Runs on other backends. Peers move work through git, so a run on the mini
  and one on the Mac meet at a pull, not here.
- Agents canopy did not start (a Claude session in a terminal). Its hook
  posts asks, not tool calls; the registry card has no file list. The
  main checkout's dirty files cover the common case anyway.
- Line-level overlap. Files are the unit git conflicts on in practice.
- Locking or reservation. See call 2.

## Testing

- `touch.test.ts`: `touchedOf` over a run with Edit, Write, NotebookEdit,
  a Bash `sed -i`, a redirect, `git mv` of a dir, an opaque `sh -c` (no
  paths, `unknown`), a path outside the repo (kept, never matched),
  `TOUCH_MAX`; `overlap` on paths and dirs; same origin and same group
  never collide; `collide` over the three sources; the resay threshold.
- `explain.test.ts`: `writtenPaths` for each writer, redirects, `cp`'s last
  operand, a heredoc into a file, nothing for `cat`, `grep`, `git diff`.
- `claudedrive.test.ts`, `codexrun.test.ts`: `RunTool.paths` on the step
  from the fake CLI's tool_use and from a fileChange item.
- `landing.test.ts`: `enqueue` sets `overlap`; `fixPrompt` carries the
  line; the `collision` notice kind.
- `server/collisions.test.ts` over a stand-in runner: a note on the job, a
  say to an idle chat and none to a working one, a say at its next idle, a
  checkout-side collision from `RepoStatus.files`, a pair dropped when both
  runs end, the set rebuilt from an adopted run's steps.
- UI: `landing.test.ts`'s `overlapChip` words; the group sheet's shared and
  single lists.

## Plans

1. `RunTool.paths`, `writtenPaths`, `core/touch.ts`, the hub with notes,
   notices and chips, the queue-time overlap, `canopy queue`'s line. One
   plan; the whole feature is small.
