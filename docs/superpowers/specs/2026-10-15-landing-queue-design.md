# Landing queue and review rules (FR-012, FR-013)

FR-012 asks for finished runs to land on main one at a time: rebase, gates,
fast-forward, and a conflict or red gate sent back to the run. FR-013 asks
for each run's diff to be sorted before it reaches Eric, so a comment-only
change can land without a look and a change under a sensitive path always
waits. FR-013 decides what the queue may land on its own, so the two share
this spec. FR-012 comes first and works without FR-013.

## Where things stand (2026-10-15)

- **A run has no branch.** It works in the repo's checkout (`runner.ts`,
  cwd is `repo.path`), one active run per repo. `settle` sets
  `outcome: changed | unchanged` from git status before and after.
- **Nothing lands a run.** `propose` tells Claude not to commit unless the
  note asks. Eric lands work with the bundled `commit`, `push` and `ship`
  workflows or by hand.
- **No repo declares its gates.** Each workflow repeats `for s in typecheck
  lint test build … bun run $s`. `runCheck` (`check.ts`) runs one shell line
  headless with a 10-minute timeout and returns `{exit, output}`.
- **git.ts has no rebase, merge or branch helper.** `peersync.ts` has
  `ancestor` and `fastForward` (`merge --ff-only`). The launcher's PR builds
  are the only worktrees canopy makes, inline in `launcher.ts`.
- **Sensitive paths exist twice, for other uses.** `handOffFlag` and
  `scriptsFlag` (`sprout.ts`) flag CI, deploy, hook and package-manager
  files for the incubator. `guardedPath` (`explain.ts`) covers `.git`,
  `.canopy`, `.claude`, `package.json` and the like. Neither knows the secret
  store or the peer gate.

## FR-012: the landing queue

### A run on its own branch

The queue needs something to rebase, so a run can start on a branch:

- A new run option `branch: true`. Canopy creates a worktree at
  `<configDir>/worktrees/<repo key>/<run id>` on a new branch
  `run/<slug>-<short id>` from the default branch's tip, and the run's cwd
  is that worktree. It then runs the repo's gate setup (below) there, so the
  agent and the gates find `node_modules`. The one-run-per-repo rule does not apply to branch runs,
  since they share no working tree; at most 3 branch runs per repo run at
  once, as for a fleet.
- The run's prompt gains one line: commit your work on this branch with a
  message that says what changed, and do not push.
- When it settles, a branch run reads `ready` (commits ahead of its base, a
  clean worktree), `uncommitted` (changes left in the worktree), or
  `nothing` (no commits). Only `ready` can be queued.
- Local repos only. A remote repo's run keeps working in its checkout.
- Peer sync fetches every branch. `run/*` branches are left out of peer
  sync, so a half-done run never reaches another machine.
- **Restarts.** Runs are kept in memory today. A branch run's record and
  every queue entry are saved under `<configDir>/landing/`, one JSON file
  each, like flows. At start canopy reads them back, lists
  `<configDir>/worktrees/`, and shows a worktree with no record as
  "orphaned" with "remove" and "queue anyway" (when it is clean and ahead).
  A run that was working when canopy stopped reads `stopped`; its worktree
  stays.

### The queue

One queue per repo, worked by one loop in the server. A "land" on a `ready`
run puts it at the end. The queue lands on the repo's default branch
(`origin/HEAD`, else `main`, else `master`). It works only while the main
checkout has that branch checked out; otherwise every entry waits as
"checkout not on <branch>". For each entry, in order:

1. **Rebase.** In the run's worktree, `git rebase <main>` onto the main
   checkout's current `HEAD`. On a conflict: `rebase --abort`, and the entry
   is sent back with the conflicting files.
2. **Gates.** Run the repo's gates in the worktree, one at a time, stopping
   at the first red one. On red, the entry is sent back with the gate's name
   and the last 4000 characters of its output.
3. **Fast-forward.** If main's `HEAD` moved while the gates ran, go back to
   step 1 (at most 3 times, then send back as "main kept moving"). Otherwise
   `git merge --ff-only run/<…>` in the main checkout. Git refuses when the
   checkout's own uncommitted changes touch the same files. The entry then
   waits as "main checkout busy" with the files named, and the loop moves to
   the next entry.
4. **Clean up.** Remove the worktree and delete the branch.

The queue never pushes. Main is the deployed branch for most of Eric's
repos, and pushing it stays an explicit push, ship or deploy.

**Sent back** means the entry leaves the queue, the run reads `conflict` or
`red`, and the inbox gets one item with the reason. "Fix it" on that item
continues the run's session in its worktree with the reason as the next
message, and when it settles `ready` again it rejoins the queue at the end.

### The repo's gates

A new file `.canopy/gates.json`:

```json
{ "gates": [
  { "name": "typecheck", "run": "bun run typecheck" },
  { "name": "lint", "run": "bun run lint" },
  { "name": "test", "run": "bun test" },
  { "name": "build", "run": "bun run build" }
] }
```

Without the file, canopy uses the `package.json` scripts named `typecheck`,
`lint`, `test` and `build` that exist, in that order, run with `bun run`. A
repo with neither has no gates, and the queue says so on each entry rather
than landing silently.

`setup` (optional, a shell line such as `bun install --frozen-lockfile`)
runs once when the worktree is made and again after a rebase that changed
the lockfile. A fresh worktree has no git-ignored files: no `node_modules`,
no `.env`, no build output. Canopy copies nothing ignored into it. A gate
that needs a `.env` names it in `setup` (for example, a symlink to the main
checkout's file), so the repo decides what crosses over. The gates are read
from the main checkout, never from
the run's branch, so a run cannot loosen its own gates. The bundled
workflows' inline gate loop can move to read the same list later.

### The view

- The run sheet shows the branch, its commits and the state (`ready`,
  `queued 2nd`, `rebasing`, `gate: test`, `landed`, `conflict`, `red`).
- The repo panel gets a "landing" section listing the queue, with "land" for
  each `ready` run and the reason on each sent-back one.
- A card chip shows how many runs are queued or sent back.
- `canopy land <run>` and `canopy queue [repo]` in the CLI.

## FR-013: review rules

### Sorting a diff

Canopy sorts every file in a `ready` run's diff (`git diff <base>...run/<…>`)
into one class:

- **docs:** `.md` and `.txt` files, and anything under `docs/`, except
  markdown that instructs agents or runs commands, which is sensitive
  (below). `.mdx` is logic, since it can carry code.
- **comments:** a `.ts`, `.tsx`, `.js`, `.jsx`, `.mjs` or `.cjs` file whose
  changed lines are all blank or comment lines, and whose old and new text
  give the same output from `Bun.Transpiler` (so a `*/` that ends a block
  early, or a comment inside a string, is caught).
- **format:** such a file whose old and new text are equal once every
  whitespace character is removed, and whose transpiled output is the same.
- **logic:** everything else, including every other language, JSON, a
  deleted or renamed file, and a mode change.

A changed line holding a directive that switches a gate off counts as
logic, whatever else it holds: `@ts-nocheck`, `@ts-ignore`,
`@ts-expect-error`, `eslint-disable`, `biome-ignore`, `prettier-ignore`,
`/// <reference`, `"use client"`, `"use server"`, a shebang.

The checks are conservative on purpose. A comment added at the end of a code
line counts as logic, since the line has code on it. A change to a type
counts as logic, even though the transpiler strips types.

### Sensitive paths

A file is sensitive when it matches the repo's `approve` globs or canopy's
own list, which reuses `guardedPath` and `handOffFlag`: `.canopy/**`,
`.claude/**`, `.github/**`, `.husky/**`, hooks, CI and deploy config,
`package.json` and lockfiles. The list adds markdown that agents read as
instructions or that runs commands: `CLAUDE.md`, `AGENTS.md`, `GEMINI.md`,
`SKILL.md`, `SPEC.md`, `DESIGN.md` at any depth, and workflow files
(`lib/workflows/**`, `.canopy/workflows/**`), whose `check:` lines run as
shell. Sensitivity is separate from the class. A
comment-only change to a sensitive file is still sensitive.

### The rules file

`.canopy/review.json`, read from the main checkout like the gates:

```json
{
  "autoLand": ["docs", "comments", "format"],
  "approve": ["src/secrets/**", "src/core/secret*.ts", "src/core/peersync.ts", "docker/**", "Dockerfile", "docker-compose*.yml"]
}
```

- A run whose files are all in `autoLand` classes and none is sensitive
  joins the queue on its own when it settles `ready`. The inbox gets a quiet
  "landed" line afterwards, not an ask.
- A run with any logic file waits for "land", as in FR-012.
- A run with any sensitive file waits for "land" from a sheet that lists the
  sensitive files and links each one's diff. "Land all" skips such runs.
- Without the file, nothing lands on its own, and canopy's own list still
  marks sensitive files.
- Every change to `.canopy/review.json` or `.canopy/gates.json` is
  sensitive, so a run cannot widen its own rules on the way in.

Canopy's own repo gets a `review.json` with the `approve` list above.

## Components

- `src/core/worktree.ts` (new): add, remove and list run worktrees, rebase,
  abort, fast-forward, branch delete. The launcher's PR worktrees move onto
  it.
- `src/core/runner.ts`: the `branch` option, the worktree cwd, the settle
  states, the 3-per-repo limit for branch runs.
- `src/core/landing.ts` (new): the queue model (pure: entries, states,
  transitions) and `src/server/landing.ts` for the loop, routes and events.
- `src/core/gates.ts` (new): read `.canopy/gates.json` or derive from
  `package.json`.
- `src/core/review.ts` (new): the classes, the sensitive check, the rules
  file.
- `src/core/peersync.ts`: skip `run/*`.
- UI: the run sheet's branch block, the landing section, the card chip, the
  sensitive-files sheet, inbox items.

## Open calls

1. **Branch runs by default.** Off by default with a toggle on the run sheet,
   or on by default for `propose`, whose output is most often a feature.
2. **Auto-land at all.** FR-013's `autoLand` lets a run change main with no
   human click. It is opt-in per repo, but it is the first thing in canopy
   that commits to main on its own.
3. **The commit message.** The run writes it (as above), or canopy squashes
   the branch into one commit with a message from the run's result.
4. **Workflows and fleets.** Whether a workflow's steps can run on a branch
   too. Left out of the first plan.

## Testing

- `worktree.test.ts` on a scratch repo: add, rebase clean, rebase conflict
  aborted, ff-only refused by a dirty main checkout, cleanup.
- `landing.test.ts`: the state machine, main moving during gates, the 3-try
  limit, a sent-back entry rejoining at the end, a checkout not on the
  default branch, records read back after a restart and an orphaned
  worktree.
- `gates.test.ts`: the file, the `package.json` fallback, read from main and
  not the branch.
- `review.test.ts`: each class with fixtures (a block comment closed early,
  a comment inside a template string, a type-only change, a reflowed
  function, an added `@ts-ignore` or `eslint-disable`), sensitive globs, a
  `CLAUDE.md` or workflow file edit, rules changes always sensitive.
- `peersync.test.ts`: `run/*` not fetched.
