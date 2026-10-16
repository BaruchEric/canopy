# Landing queue, plan 2: review rules and auto-land (FR-013)

**Status:** built 2026-10-16 on branch worktree-agent-ae6d48a4cc8d79d7e
(45684c6..63053b0 and this status commit), with the six amendments of the
review that is landing on main separately, not merged into main, not
deployed. Gates green: typecheck, lint, 4000 tests pass with 9 skipped,
build. The live check passed against a scratch canopy at 63053b0 with the
real claude CLI doing every run: a README edit and a doc-comment edit to
a `.ts` file each joined on their own, landed and left a landed notice,
with nothing pushed; a new function waited for land; an
`oxlint-disable` comment sorted as logic ("a directive"); an edit under
`secret/**` and a `git rm` of `.canopy/review.json` each needed approval;
the diff route served the listed file and refused another; land without
the id and with a stale one were refused; an approval given before main
moved landed after the rebase with the same id; land all took the two
logic runs and named the approval one; and `canopy land` printed the file,
how to look and the `--approve` command, which then landed it. The Mac's
git was not reachable to check for `patch-id --verbatim`; the SHA-256
fallback is in place either way.

**Goal:** before a branch run reaches Eric, canopy sorts every file in its
diff into docs, comments, format or logic and marks the ones under a
sensitive path. A run whose files are all in the repo's `autoLand` classes,
with none sensitive, joins the landing queue on its own and leaves a quiet
"landed" line. A run with a logic file waits for "land" as in plan 1. A run
with a sensitive file waits for "land" from a sheet that lists those files
with their diffs, and "land all" skips it. Nothing is pushed.

**Spec:** `docs/superpowers/specs/2026-10-15-landing-queue-design.md`, the
FR-013 half and the calls of 2026-10-15 (call 2 put `autoLand` in this
plan). It builds on plan 1, merged into main as 6f6be30.

## What is there already

- `LandingHub` (`src/server/landing.ts`) keeps a `LandingRun` per branch
  and works one loop per repo. `turn()` rebases onto the main checkout's
  HEAD, runs `setup` when the rebase brought a lockfile change, runs each
  gate, checks HEAD has not moved, then `ffMain`. `land(id)` is sync and
  queues any `ready` run. `onRun` puts a "fix it" run that settles `ready`
  straight back in the queue.
- `src/core/landing.ts` is the pure model: `advance`, `enqueue`,
  `queueOf`, `landWord`, `fixPrompt`. `LandEntry` and `LandingRun` are in
  `src/core/types.ts` and carry `base`, `target` and `dir`.
- `src/core/gates.ts` reads `.canopy/gates.json` from the main checkout,
  never the branch, and a broken file throws and holds the queue
  (`parseGatesFile` names each fault). `LOCKFILES` lists the lockfiles.
  Canopy's own repo has a `.canopy/gates.json` with a `setup` line.
- `guardedPath` (`src/core/explain.ts`) checks `GUARDED_DIRS` and
  `GUARDED_FILES`, neither exported. `handOffFlag` (`src/core/sprout.ts`)
  answers CI, deploy and hook config with a reason in words.
- The incubator's hand-off binds a yes to what was looked at
  (`handOff.head`, `flagged`), the precedent for an approval here.
- `DiffView({diff})` (`ui/src/components/DiffView.tsx`) paints a unified
  diff.
- The inbox (`ui/src/inbox.ts`) lists what waits on Eric. Plan 1 added a
  `sent-back` row per branch with no fix going. Nothing in it is quiet.
- Bun 1.4.3's `Bun.Transpiler` runs macros by default. Checked on
  2026-10-16: transforming `import {m} from "./m.ts" with { type: "macro" }`
  ran `m.ts` and inlined what it returned. With `macro: false` the same
  call throws "Macros are disabled". The sort transpiles text a run wrote,
  inside the server, so this is the one setting that must not be missed.
- Checked on git 2.47: `git diff ... | git patch-id --verbatim` gives the
  same id after a line shift above the change and a new id for a
  trailing-space change. `--verbatim` and `--stable` cannot be combined.

## Calls

1. **An approval is for the sensitive files' patch id, not a commit.** The
   sheet approves `git diff <base> <head> -- <sensitive files> | git
   patch-id --verbatim`. The queue's rebase changes the commit but not that
   id, and a fix that touches a sensitive file changes it, so it needs a new
   approval. `--verbatim`, since whitespace matters in YAML and Makefiles.
2. **The sort runs again after every rebase**, with the rules the main
   checkout holds at that moment, before `setup` and the gates. An entry
   that joined on its own and no longer sorts `auto`, or an approved entry
   whose sensitive patch id moved, leaves the queue and waits as `ready`
   with a notice saying why. Rules on main may have narrowed since it
   settled.
3. **The transpiler never runs macros.** Options are `macro: false`,
   `deadCodeElimination: false` and `trimUnusedImports: false`, and a file
   whose text holds a macro import attribute (`type: "macro"` in any quote
   or spacing) is logic before the transpiler sees it. A throw on either
   side is logic.
4. **Docs means `.md`, `.markdown`, `.rst` and `.adoc`, and some `.txt`.**
   A `.txt` file is docs only inside a `docs` folder (one at any depth) or
   when named `README`, `LICENSE`, `CHANGELOG`, `NOTICE` or `AUTHORS`.
   Anywhere else it is logic, since `requirements.txt`, `CMakeLists.txt`
   and `robots.txt` are read by programs. A `.mdx` file is code, since it
   imports and renders JSX. Any other file in a `docs` folder sorts as it
   would anywhere else, since docs sites build from code kept there.
5. **An added file sorts like any other**, so a new `.md` is docs. A
   deleted, renamed or copied file, a mode change, a symlink, a submodule,
   a binary file and a file over 512 KB are logic.
6. **`logic` in `autoLand` is a parse error.** It would land everything
   unseen, which is a ship pipeline, not a review rule.
7. **A broken `review.json` makes every run `approve`**, with the parse
   error as the reason, rather than falling back to no rules. Its `approve`
   globs cannot be read, so no file can be called safe. Like a broken gates
   file, it is loud rather than quiet.
8. **Nothing lands on its own in a repo with no gates.** Auto-land leans on
   the gates as the only check, and plan 1 lands a no-gates entry only on
   Eric's say. The verdict reads `land` with "no gates to run".
9. **The "landed" line is a notice, not an inbox item.** `LandingInfo`
   gains `notices` (landed on its own, held back from landing on its own),
   kept 50 and saved to `<configDir>/landing/notices.json`. The inbox shows
   them at its foot under "landed on its own", outside the count and the
   badge, and "seen" clears them. The inbox otherwise lists only what waits
   on Eric, and the spec asks for a line, not an ask.
10. **"Land all" lands a repo's ready runs whose verdict is `land`.** It is
    `POST /api/landing/land-all {repo}`, a button in the landing section
    when two or more are ready, and `canopy land --all [repo]`. Each
    `approve` run is skipped and named in the answer.
11. **The CLI approves by the id it printed.** `canopy land <run>` on an
    `approve` run prints the sensitive files, each with its reason, and the
    command `canopy land <run> --approve <id>`. A different id is a 409.
12. **Canopy's own `approve` list adds `src/cli/index.ts`, `scripts/**`,
    `lib/**` and `spec/**`** to the spec's: the peer gate's env handling
    sits in `src/cli/index.ts`, and `scripts/` holds the redeploy gate and
    `canopy-mcp-env`. Moving the gate to its own file is a change to the
    gate, so this plan leaves it. `lib/**` takes the place of
    `lib/workflows/**` (call 17) and holds the workflow prompts, the
    ranger's prompt and the tmux config the shells load. `spec/**` holds
    the blocks canopy writes into other repos' `CLAUDE.md`.
13. **A "fix it" run rejoins on its own only when the sort allows it:** the
    verdict is `auto`, or it is `land` and the entry was queued by Eric's
    "land", or it is `approve` and the entry's approved id still matches.
    Otherwise the branch waits as `ready` with a notice.
14. **`land` sorts again every time** before it queues, with the main
    checkout's rules then, so a sheet opened an hour ago cannot land on
    stale rules. A plan 1 record with no sort is sorted at `adopt`.
15. **The diff route serves only files the sort listed.**
    `GET /api/landing/diff?id=&path=` refuses a path that is not in the
    run's current sort, so it never reads an arbitrary file.
16. **The sensitive check covers both sides of a rename or copy and the
    old path of a delete**, so deleting `.canopy/review.json` or moving a
    file out of `scripts/` asks for approval.
17. **The built-in agent instruction list adds `.cursor/**`, `.agents/**`,
    `.github/copilot-instructions.md`, `.github/instructions/**`,
    `.windsurfrules` and `.clinerules`.** `.claude` and `.codex` are
    already covered through the guarded dirs. `lib/workflows/**` leaves the
    built-in list, since only canopy reads that path, and moves to canopy's
    own `review.json` (call 12).
18. **When the repo's `core.ignorecase` is true (a Mac checkout), the
    repo's `approve` globs match case-folded**, as the built-in names
    already do.

## Tasks

### 1. Types (`src/core/types.ts`, browser-safe)
- [ ] `ReviewClass = "docs" | "comments" | "format" | "logic"`.
  `ReviewFile {path, cls, why?, sensitive?}`: `why` says why a file is
  logic ("renamed", "a changed line holds @ts-ignore"), `sensitive` why it
  is sensitive ("CI config", "named in review.json's approve").
- [ ] `RunReview {head, base, files, verdict: "auto" | "land" | "approve",
  rules: "file" | "none" | {error}, gates: boolean, sensitiveId?, why?,
  at}`. `why` is the verdict in words when it is not the obvious one ("no
  gates to run", the rules file's error).
- [ ] `LandingRun.review?`, `LandEntry.auto?: true` (joined on its own),
  `LandEntry.approved?: string` (the sensitive id Eric approved).
- [ ] `LandNotice {id, repoId, branch, kind: "landed" | "held", text, at}`
  and `LandingInfo.notices`.

### 2. Rules and sensitive paths (`src/core/review.ts`, new)
- [ ] `parseRules(text)` in the shape of `parseGatesFile`: `autoLand` a
  subset of docs, comments and format (call 6), `approve` a list of globs,
  each compiled with `Bun.Glob` so a bad one is an error that names it.
  `readRules(mainPath)` reads `.canopy/review.json` from the main checkout:
  `{source: "file", autoLand, approve}`, `{source: "none"}`, or
  `{error}` (call 7).
- [ ] `sensitiveWhy(path, approve)`: the reason or null. Canopy's own list
  first: the guarded dirs and files (export a `guardedWhy` from
  `explain.ts` rather than the sets), `handOffFlag`, `LOCKFILES`,
  `CLAUDE.md`, `AGENTS.md`, `GEMINI.md`, `SKILL.md`, `SPEC.md` and
  `DESIGN.md` at any depth with case folded, and `.cursor/**`, `.agents/**`,
  `.github/copilot-instructions.md`, `.github/instructions/**`,
  `.windsurfrules` and `.clinerules` (call 17). Then the repo's globs.
  Both sides of a rename or copy are checked, and the old path of a
  delete (call 16). `.canopy/review.json` and `.canopy/gates.json` are
  sensitive through `.canopy/`, and a test says so.
- [ ] `review.test.ts` (rules half): a good file, `logic` refused, a bad
  glob named, not JSON, no file. Sensitive: `.github/workflows/ci.yml`,
  `bun.lock`, `docs/CLAUDE.md`, `.cursor/rules/style.mdc`, `.clinerules`,
  `.canopy/review.json`, a repo glob, a deleted `.canopy/review.json`, a
  file renamed out of `scripts/` under a `scripts/**` glob, and
  `README.md` and `lib/workflows/ship.md` not sensitive.

### 3. The sort (`src/core/review.ts`)
- [ ] `classify(file)` for one file, from its `git diff --raw` entry, its
  old and new text and its changed lines. Order: status and mode (call 5),
  size, extension (call 4: `.md`, `.markdown`, `.rst` and `.adoc` are
  docs, a `.txt` only in a `docs` folder or named `README`, `LICENSE`,
  `CHANGELOG`, `NOTICE` or `AUTHORS`, and any other non-JS file, `.mdx`
  included, is logic), then for a JS or TS file: a changed line matching
  the directive pattern is logic; the macro guard (call 3); then comments
  when every changed line is blank or a comment line and both sides
  transpile to the same text, format when the two texts match with all
  whitespace taken out and transpile the same, else logic. The directives
  are one case-insensitive pattern covering `@ts-nocheck`, `@ts-check`,
  `@ts-ignore`, `@ts-expect-error`, `eslint-disable` and `eslint-enable`,
  `oxlint-disable` and `oxlint-enable`, `biome-ignore`, `deno-lint-ignore`,
  `prettier-ignore`, `c8 ignore`, `istanbul ignore`, `@jsx`,
  `@jsxImportSource`, `@jsxFrag`, `@jsxRuntime`, `@vite-ignore`, webpack
  magic comments, `@__PURE__`, `#__PURE__`, `__NO_SIDE_EFFECTS__`,
  `sourceMappingURL`, a triple-slash reference (`/// <reference`),
  `"use client"`, `"use server"` and a shebang. Canopy lints with oxlint,
  so an `oxlint-disable` sorted as a comment would land a lint rule turned
  off unseen.
- [ ] The transpiler is one `Bun.Transpiler` per loader (`ts`, `tsx`, `js`,
  `jsx`; `.mjs` and `.cjs` as `js`) with the options in call 3.
- [ ] `sortBranch(dir, target, rules, hasGates)`: the merge base with
  `target`, `git diff --raw -z --find-renames --no-ext-diff <base> HEAD`,
  each file's two sides with `git show`, each JS or TS file's `-U0` lines.
  The verdict: `approve` when any file is sensitive or the rules errored,
  else `auto` when the rules file exists, the repo has gates and every
  class is in `autoLand`, else `land`. `sensitiveId` from call 1, computed
  only when there are sensitive files.
- [ ] `review.test.ts` (sort half), on scratch repos: each class; a block
  comment closed early; `// x` inside a template string; a type-only
  change (logic); a reflowed function (format); an added `@ts-ignore`, an
  `eslint-disable` and an `oxlint-disable` (logic); an end-of-line comment
  (logic); a macro import whose module writes a sentinel file, which stays
  absent and sorts logic; rename, delete, mode change, symlink and binary
  (logic); a new `.md` (docs); `docs/build.ts` (sorted as code); the
  sensitive id the same after main gains lines above the change and
  different after a trailing-space edit; no gates turns `auto` into
  `land`.

### 4. The model (`src/core/landing.ts`)
- [ ] `enqueue(entries, run, now, {auto?, approved?})` keeps the flags on
  the entry. `unqueue(entries, id)` takes an entry out. `rejoins(review,
  entry)` is call 13 as a pure answer with a reason.
- [ ] `canLand(review, approve?)`: `approve` needs the matching id, a stale
  or missing one is a `LandError` 409 that says to look again.
- [ ] `reviewWord(review)`: "lands on its own", "needs your land", "needs
  your approval: 2 sensitive files", and the `why` when there is one.
  `addNotice(list, n)` keeps the newest 50.
- [ ] `landing.test.ts`: the flags survive `advance`, `rejoins` for each
  verdict and how the entry was queued, `canLand` with a good, stale and
  missing id, the words, the notice cap.

### 5. The hub (`src/server/landing.ts`)
- [ ] One sort at a time per branch. `onRun`: a run that ends `ready` is
  sorted, then joins on its own when the verdict is `auto` and it has no
  entry (a notice when it lands), or for a fix run, rejoins per call 13
  (a notice when it does not).
- [ ] `land(id, approve?)` becomes async: sort again (call 14), then
  `canLand`, then enqueue with `approved`. `landAll(repoId)` per call 10.
- [ ] `turn()`: after a clean rebase, sort again against the new HEAD with
  the rules then (call 2). A held entry is unqueued with a "held" notice
  and its run stays `ready` with the new sort.
- [ ] An `auto` entry that lands adds a "landed" notice. Notices are saved
  to `landing/notices.json` in the same ordered writes as the records.
  `adopt` reads them back and sorts every `ready` record without a sort.
- [ ] Routes: `POST /api/landing/land {run, approve?}`,
  `POST /api/landing/land-all {repo}`,
  `GET /api/landing/diff?id=&path=` (call 15),
  `POST /api/landing/seen {ids}`.
- [ ] Tests with the fake check: a docs run joins on its own and lands
  with a notice; a logic run waits; a sensitive run refuses `land` without
  an id, lands with the right one and refuses a stale one; land-all skips
  the sensitive run and names it; rules narrowed on main while an auto
  entry is queued hold it with a notice; a fix that changes a sensitive
  file does not rejoin; the diff route refuses an unlisted path; notices
  and sorts read back after a restart.

### 6. Canopy's own rules (`.canopy/review.json`)
- [ ] `autoLand: ["docs", "comments", "format"]`, and `approve` holding
  the spec's list plus `src/secrets/**`, `src/server/secrets.ts`,
  `src/core/peers.ts`, `src/server/peers.ts`, `src/cli/index.ts`,
  `scripts/**`, `lib/**` and `spec/**` (call 12). Check each glob matches
  a file in the tree.
- [ ] A test reads the file and checks `src/core/peersync.ts`,
  `src/cli/index.ts`, `lib/ranger.md` and `spec/blocks/agents.md` are
  sensitive and `README.md` is docs.

### 7. UI
- [ ] `ui/src/landing.ts`: the verdict word for a ready row and the run
  sheet, which ready runs "land all" would take, the notice lines. Tests.
- [ ] `components/Landing.tsx`: each ready row shows its verdict; a `land`
  run keeps "land"; an `approve` run's button is "look and land", which
  opens the approve sheet; "land all" in the section's head with two or
  more ready; an entry that joined on its own reads "joined on its own".
- [ ] The approve sheet: each sensitive file with its reason, unfolding to
  its diff (`DiffView`, from the diff route), and "approve and land",
  which posts the id the sheet was opened with. A 409 reloads the sort and
  says the branch changed since.
- [ ] `RunSheet.tsx`: the branch line shows the verdict, and "land" opens
  the approve sheet when it needs one.
- [ ] Store and api: `landRun(id, approve?)`, `landAll(repoId)`,
  `landingDiff(id, path)`, `seenLanding(ids)`. The inbox's foot lists the
  notices with "seen", kept out of `inboxItems` so neither the count nor
  `Waiting.tsx` sees them (call 9).

### 8. CLI (`src/cli/land.ts`)
- [ ] `canopy land <run> [--approve <id>]` and `canopy land --all [repo]`
  (call 11). `canopy queue` shows each ready run's verdict and marks an
  entry that joined on its own.
- [ ] `queueLines` tests for the verdict words; a test for the printed
  approve command.

### 9. Docs
- [ ] `docs/architecture.md`: a paragraph on review rules in "The landing
  queue": the classes, the sensitive list, the verdict, the patch id, the
  re-sort after a rebase, notices, and the macro setting with why.
- [ ] `SPEC.md`: `landing/notices.json`. `README.md`: `land --all` and
  `--approve`, and `.canopy/review.json`.
- [ ] `FEATURES.md`: FR-013 to In Progress, then Shipped. The plans
  README's row for this plan.

### 10. Gates and the live check
- [ ] `bun run typecheck && bun run lint && bun test && bun run build`.
- [ ] Live, on canopy itself with a scratch server and the real claude CLI
  doing every run: a README edit joins on its own, lands, and leaves a
  notice with nothing pushed; a comment-only edit to a `.ts` file does the
  same; a logic change waits for "land"; a comment-only edit to
  `src/core/peersync.ts` waits for approval, the sheet shows its diff, and
  approving lands it; a run that adds `// @ts-ignore` waits; narrowing
  `autoLand` on main while an auto entry is queued holds it with a notice.

## Risks

- The sort reads each changed JS or TS file twice through the transpiler
  in the server process. A run with hundreds of changed files is slow to
  sort. Past 300 files the verdict is `land` without reading them, and the
  `why` says so.
- The comment check is conservative on purpose, so some harmless edits
  read as logic, such as an end-of-line comment. That is the spec's intent.
- Old and new text go through the same transpiler in one sort, so a Bun
  upgrade cannot make two equal sides differ.
- `git patch-id --verbatim` has to exist on every backend. Check the Mac's
  git in task 3. If it is missing there, fall back to SHA-256 over
  `git diff -U0` with the hunk headers' line numbers taken out, and say so
  in the plan's status line.

## Calls the build made

1. **Canopy checks the globs itself.** `Bun.Glob` takes any pattern
   without throwing, so `parseRules` refuses a glob that starts with `/`,
   climbs out with `..`, or leaves a bracket or brace open. An unknown key
   is a parse error too, since a misspelt `approve` would drop every glob.
2. **With the rules broken, an approval names the whole diff.** No file can
   be called safe, so `sensitiveId` is the patch id of every file.
3. **Format is checked before comments**, so a change that is whitespace
   alone sorts as format even when its changed lines are blank.
4. **In a docs folder, a file is docs unless its extension is code,
   config, or markup or styles a site builds from** (`.html`, `.svg`,
   `.mdx`, `.vue`, `.css` and their kin). A file with no extension there is
   logic. A new executable file is logic, like a mode change.
5. **The macro guard also takes a quoted key** (`"type": "macro"`). An
   escaped attribute it misses reaches the transpiler, which refuses it
   with `macro: false`, and that is logic. The test proves with a sentinel
   module that neither form runs.
6. **Past 300 files the paths are still checked**, so a huge run that
   touches a sensitive file still needs approval rather than land.
7. **Any entry whose rebase sort says `approve` without a matching
   approval leaves the queue**, Eric's plain "land" included, so rules that
   narrowed on main hold it too, not only `auto` and approved entries.
8. **A sort that fails holds.** `land` answers 409, a fix does not rejoin,
   and a turn takes the entry out with a held notice.
9. **"Land all" takes runs in the order they finished**, and the button
   shows with two or more ready and at least one it would take.
10. **Canopy's approve list adds `src/core/sinkssh.ts`** (the secret
    store's ssh sinks) and leaves out `src/server/peers.ts`, which does not
    exist. The peer routes sit in `src/server/index.ts`, which is not on
    the list, since nearly every server change would then need approval.
11. **`canopy land` on an `approve` run also prints a `git diff` line** to
    look with before the `--approve` command.
12. **`LandingInfo.notices` is optional**, since an older backend sends
    none. A queued entry with an approval reads "approved" in the page and
    in `canopy queue`.