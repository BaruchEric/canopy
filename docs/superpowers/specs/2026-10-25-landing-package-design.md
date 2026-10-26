# The landing queue as a package others can adopt (FR-045)

FR-045 asks whether the landing queue (a branch rebased, gated, sorted and
fast-forwarded onto main, with sensitive files held for approval) should
leave canopy's tree as a package other tools can run. The research
(`2026-10-25-software-factory-borrowings-design.md`, "Adopt, contribute, or
keep building?") found it is canopy's strongest feature and nearly alone in
open source: Gas Town's Refinery (https://github.com/gastownhall/gastown),
ADHDev, YYLO and Optio's CI-gated auto-merge
(https://github.com/jonwiggins/optio) come close, while Paseo
(https://github.com/getpaseo/paseo) and Orca (https://github.com/stablyai/orca)
stop at "review the diff" or "merge the winner". A package is how the idea
spreads without canopy itself going public. This spec says what the cut
would be, what it costs, and when it is worth making.

## Where things stand (2026-10-25)

- **The model is already pure.** `src/core/landing.ts` (269 lines) imports
  only types: `LandEntry` states (`queued`, `rebasing`, `setup`, `gate`,
  `landing`, `landed`, `waiting`, and the sent-back `conflict`, `red`,
  `moved`), `advance(entry, event, now)`, `enqueue`, `unqueue`, `rejoins`,
  `canLand`, `holdAll`, `retryWaiting`, `restartWorking`, `pruneLanded`,
  `landWord`, `landCounts`, `fixPrompt`, and the constants `MAX_TRIES` (3),
  `TAIL_CHARS` (4000), `KEEP_LANDED` (10), `MAX_NOTICES` (50). Its test
  (`landing.test.ts`, 279 lines) runs with no git.
- **The sort is pure but Bun-shaped.** `src/core/review.ts` (356 lines)
  holds `parseRules`, `readRules`, `sensitiveWhy`, `fileSensitive`,
  `parseRaw`, `classify`, `changedLines`, `sensitivePatchId` and
  `sortBranch`. It reaches for `Bun.Glob` (the `approve` globs),
  `Bun.Transpiler` (the `comments` and `format` classes, with `macro:
  false`) and `Bun.CryptoHasher` (the patch-id fallback), and imports
  `guardedWhy` from `explain.ts` (1034 lines, mostly command reading),
  `handOffFlag` from `sprout.ts` (885 lines, the incubator) and `LOCKFILES`
  from `gates.ts`. Those two imports pull in far more than the few path
  lists the sort needs.
- **The gates reader is small.** `src/core/gates.ts` (120 lines):
  `parseGatesFile`, `packageGates`, `readGates`, `gatesScript`, `LOCKFILES`,
  `touchesLockfile`; it imports `shellQuote` from `host.ts`.
- **The git half goes through canopy's exec.** `src/core/worktree.ts` (261
  lines): `addRunTree`, `rebaseOnto` (`{ok} | {conflict: files} | {error}`),
  `ffMain` (`{ok} | {busy: files} | {moved} | {error}`), `removeRunTree`,
  `treeState`, `aheadOf`, `dirtyFiles`, `pushBranch`, `pushRemote`,
  `defaultBranch`, `repoKey`, `runBranchName`. It imports `git` from
  `exec.ts` (which runs locally or over ssh by locator) and `configDir`
  from `store.ts` for `worktreesRoot`.
- **The gate runner.** `runGate(dir, command)` in `src/core/check.ts` runs
  one line under `gateEnv` (`envnames.ts`: every `CANOPY_*` and the logins
  stripped) through `ledLine` with a 10-minute timeout.
- **The consumer.** `src/server/landing.ts` (953 lines) is `LandingHub`: the
  per-repo loop, the records under `<configDir>/landing/`, the routes, the
  broadcasts, the orphans, the PR hand-off. It takes `LandingDeps` injected
  and is tested over stand-ins (`server/landing.test.ts`, 725 lines).
- **The formats are documented in prose only.** `.canopy/gates.json` and
  `.canopy/review.json` are described in
  `2026-10-15-landing-queue-design.md` and `docs/architecture.md`; there is
  no schema file, and the only examples name canopy's own paths.
- **Licence.** The repo has no `LICENSE` file and `package.json` has no
  `license` field, so canopy is all rights reserved by default.
  `package.json` names `https://github.com/BaruchEric/canopy` as the
  homepage. The research flagged `github.com/juliensimon/canopy`, a macOS
  app for parallel Claude Code worktrees with "one-click merge": the name is
  taken in exactly this space.
- **No CI of canopy's own.** There is no `.github/` or `.forgejo/`
  workflows folder; the gates run through the landing queue and `bun run`.

## The cut

### What moves

A Bun workspace package at `packages/landing/` (package name below), with
its own `package.json`, `tsconfig.json`, `README.md` and tests, and
canopy's root `package.json` gaining `"workspaces": ["packages/*"]`. One
lockfile, one `bun test`, one `bun run typecheck` (the root tsconfig adds
the package's `references`). The package has no HTTP, no canopy types and
no knowledge of a `Run`:

```ts
// what a consumer hands in: a branch in a worktree, cut from base,
// landing on target in the main checkout at repo
export interface LandCandidate {
  id: string;            // the consumer's own id for the branch
  repo: string;          // the main checkout
  worktree: string;
  branch: string;
  base: string;          // the commit the branch was cut from
  target: string;        // the branch it lands on
}

export interface LandingDeps {
  exec: Exec;                                  // (cwd, argv, opts) => {exit, stdout, stderr}
  runGate: (dir: string, line: string) => Promise<{exit: number; output: string}>;
  now: () => number;
  transpile?: (loader: "ts" | "tsx" | "js" | "jsx", text: string) => string | null;
  glob?: (pattern: string, subject: string) => boolean;
  log?: (line: string) => void;
}

export { advance, enqueue, unqueue, rejoins, canLand, landWord, ... } from "./model";
export { readGates, parseGatesFile, packageGates, gatesScript } from "./gates";
export { readReview, parseRules, sortDiff, sensitiveWhy, fileSensitive } from "./review";
export { rebaseOnto, ffMain, treeState, aheadOf, dirtyFiles, addWorktree, removeWorktree } from "./git";
export class LandingQueue { /* one repo: enqueue, tick, entries, on(event) */ }
```

- `model.ts` is `landing.ts` with its types moved in (`LandEntry`,
  `LandState`, `LandNotice`, `RunReview` renamed `Review`). Nothing else
  changes; the tests move with it.
- `review.ts` loses its three Bun globals and two imports. `Bun.Glob`
  becomes `deps.glob`, with the package defaulting to `Bun.Glob` when
  `globalThis.Bun` exists and to `path.matchesGlob` (Node 22+) otherwise.
  `Bun.CryptoHasher` becomes `node:crypto`'s `createHash`. `Bun.Transpiler`
  becomes `deps.transpile`: the package defaults to the transpiler when
  running under Bun, and without one the `comments` and `format` classes
  are never given (every JS/TS change sorts `logic`), which the README says
  plainly. `guardedWhy`'s path list and `handOffFlag`'s file list move
  into the package as `sensitive.ts` (the guarded folders `.git`,
  `.canopy`, `.claude`, `.codex`, `.vscode`, `.husky`, `.githooks`,
  `.devcontainer`, `.idea`; the files `package.json`, `.npmrc`, `.yarnrc`,
  `bunfig.toml`, `.envrc`, `.gitmodules`; CI, deploy and hook config; the
  agent instruction files and folders `AGENT_FILES` and `AGENT_DIRS`;
  `LOCKFILES`), and `explain.ts` and `sprout.ts` import those lists back
  from the package so canopy keeps one list. `.canopy/` stays in the list
  under that name: it is the queue's own config folder, and a consumer may
  rename it through `deps`.
- `gates.ts` moves whole; `shellQuote` comes along as a one-function
  module.
- `git.ts` is `worktree.ts` less `worktreesRoot`, `repoKey`,
  `runBranchName`, `pushBranch` and `pushRemote` (the PR watch's), with
  every call going through `deps.exec` instead of `exec.ts`'s `git`. A
  consumer passes where worktrees live; canopy passes
  `<configDir>/worktrees`.
- `LandingQueue` is the loop that `LandingHub.turn` runs today, for one
  repo, with no files and no broadcasts: `enqueue(candidate, flags)`,
  `tick()` (rebase, setup on a lockfile change, each gate, the moved
  recheck, fast-forward, cleanup), `entries`, and an `on(event)` the
  consumer uses to write records and tell its UI. `LandingHub` keeps the
  records, the orphans, the review sort's timing, the PR hand-off and the
  routes, and drives one `LandingQueue` per repo.

### What stays in canopy

`server/landing.ts` and its routes; the records' files and the flows lock;
the `stopped`/`whole` reading after a restart; `fixPrompt`'s wording for a
Claude session; the PR watch's `openPr`; `runGate`'s `gateEnv` (the
package's `runGate` is injected, and canopy's injects the one that strips
its env). The UI imports the package's pure words (`landWord`,
`reviewWord`) through `src/core` re-exports, so `ui/` never imports from
`packages/` directly and the browser-safe rule holds.

### The CLI

`packages/landing/bin/land.ts`, run as `bunx <name> land <branch>` in a
checkout, for someone without canopy:

```
land <branch> [--target main] [--approve <id>] [--dry-run]
   sort the diff from the merge base and print each file's class and why;
   then rebase in a temporary worktree, run the gates, fast-forward target.
   A sensitive file prints its id and stops unless --approve names it.
land check [--base origin/main]
   sort and gates only, exit 1 on logic-with-no-gates, red, or sensitive
   without approval; for CI.
land init
   write .canopy/gates.json from package.json's scripts and a review.json
   with autoLand: ["docs"] and an empty approve list.
```

`land check` is what a GitHub Actions or Forgejo Actions job runs as a
required status check: the package ships `examples/github-land-check.yml`
and `examples/forgejo-land-check.yml` (`bun install`, `bunx <name> check
--base origin/${{ github.base_ref }}`), which turns a plain repo's merge
queue into one that knows the sort. Nothing in the examples names a host or
a token beyond the runner's own.

### Documentation

`README.md` in the package: the three files (`gates.json`, `review.json`,
the branch naming the consumer chooses), the classes and why each is
conservative (a comment at the end of a code line is logic; a type change is
logic), the sensitive list, the queue's states, and the Bun/Node difference.
`schema/gates.schema.json` and `schema/review.schema.json` are new, written
from `parseGatesFile` and `parseRules`, and canopy's own parsers gain a test
that the schemas accept what they accept. Every example path is generic
(`src/payments/**`, `deploy/**`); none of canopy's own `approve` globs,
hosts or repo names appear.

### Upstream paths

- **Paseo.** Its daemon takes plugins that add screens, slash commands and
  providers and run with the daemon's access
  (`2026-10-25-paseo-interop-design.md`, "Where things stand"). A
  `paseo-land` plugin would call this package on an agent's worktree when
  the agent finishes: sort, gates, and either fast-forward or hold with the
  sensitive files listed in the plugin's screen. That is the contribution
  the research meant by "a landing-queue plugin upstream"; it needs
  FR-046's study to say whether a plugin can read an agent's worktree and
  branch and whether Paseo wants one.
- **Orca.** Its "compare the results and merge the winner" is a merge with
  no gates. A hook that runs `land check` on the winner before the merge is
  the smallest useful contribution; whether Orca takes hooks is unknown
  (to confirm).
- **A contribution PR** carries the package as a dependency, the plugin or
  hook, its tests, and the README's words; never canopy's code or paths.

## Cost

- The move is mechanical but wide: four modules, their tests (about 900
  lines), `LandingHub`'s loop pulled apart from its files and broadcasts,
  two list extractions out of `explain.ts` and `sprout.ts`, and the
  re-exports the UI needs. Call it two to three days, and a week before the
  `land` CLI and the schemas are done.
- Two places then have to stay honest. The rule is one copy: the package's
  tests are canopy's tests moved, canopy's `bun test` runs the workspace,
  and canopy's own `.canopy/gates.json` runs the package's suite as part of
  `bun test`, so a change that breaks the package cannot land in canopy.
  The package gets a `SPEC.md` of its own through `canopy spec sync`.
- Publishing adds a release step (`bun publish` from the workspace, a
  version in the package's `package.json`, a changelog) and a public mirror
  of the package's history (`git subtree split --prefix packages/landing`
  pushed to a public repo), since canopy's own history stays private.
- The benefit without a consumer is testability and a cleaner
  `LandingHub`. That is real, but not worth a week on its own: the queue
  works and is tested today.

## Go or no-go

Go on plan 1 when any one of these is true:

1. FR-046's study comes back "contribute" (Paseo takes a plugin and its
   worktree model fits).
2. A second consumer is real: a repo of Eric's that wants `land check` in
   CI without canopy, or a person who asked.
3. Eric decides to write about the landing queue publicly and wants
   something to point at.

Otherwise no-go: the cut stays in this spec, and `LandingHub` is refactored
only when its own work (FR-032's scenario gates, FR-033's best-of-N) needs
it, along the seams named here so the later move is cheaper.

## Components

- `packages/landing/` (new): `package.json`, `tsconfig.json`, `README.md`,
  `src/model.ts`, `src/review.ts`, `src/sensitive.ts`, `src/gates.ts`,
  `src/git.ts`, `src/queue.ts`, `src/index.ts`, `bin/land.ts`, `schema/`,
  `examples/`, and the moved tests.
- Root `package.json`: `workspaces`; `tsconfig.json`: the reference;
  `.canopy/gates.json`: the package's tests already run under `bun test`.
- `src/core/landing.ts`, `review.ts`, `gates.ts`, `worktree.ts`: become
  thin re-exports plus what stays (`worktreesRoot`, `repoKey`,
  `runBranchName`, `pushBranch`, `pushRemote`, `fixPrompt`).
- `src/core/explain.ts`, `sprout.ts`: import the path lists from the
  package.
- `src/server/landing.ts`: drives `LandingQueue`; keeps files, routes,
  orphans, the PR hand-off.
- `docs/architecture.md` "The landing queue": the package boundary;
  `SPEC.md`: the workspace in "How it is built and run".

## Calls

Made on 2026-10-25:

1. **A workspace package, not a separate repo, first.** One lockfile, one
   test run and one typecheck keep the two halves honest without a second
   checkout. A public mirror by `git subtree split` comes only with
   publishing.
2. **Node gets `logic` for comments and format.** The transpiler check is
   what makes those classes safe; without it the sort is conservative, which
   is the right failure. A `transpile` dep lets a Node user plug esbuild in.
3. **The sensitive lists move into the package** and canopy imports them
   back, so there is one list. The alternative, two lists, drifts.
4. **`LandingHub` keeps the files and broadcasts.** The package knows one
   repo and no disk; records, the flows lock and SSE are canopy's.
5. **No-go by default.** The cut waits for a consumer; the seams are named
   so later work follows them.

For Eric:

6. **Licence.** The package needs one to be used by anyone; MIT matches
   Gas Town, Orca, Fabro and Optio, and Paseo's Apache-2.0 is compatible
   with it. canopy itself has no `LICENSE` file today and `package.json`
   no `license`; deciding the package's licence is a good moment to decide
   canopy's, even if canopy's stays "all rights reserved".
7. **Name.** `canopy` is taken in this space (juliensimon/canopy) and
   `@canopy/*` reads as that project's. Choose between `landq` (short,
   free on npm to confirm), `@beric/landing` (a scope you own), or another.
8. **Publishing canopy's history.** A `subtree split` publishes the
   package's commits with their messages and authorship; the messages
   today name hosts (`mini`) and repos. Either the split's history is
   rewritten once, or the public repo starts from a squash. Your call.
9. **Whether the GitHub Action example is wanted at all**, given canopy's
   repos land through canopy and most have no Actions.

## Out of scope

- Publishing canopy itself.
- A hosted service or a GitHub App that lands PRs; the package runs in a
  checkout.
- The PR watch, the review notes, the coordinator: canopy's, not the
  queue's.
- Replacing the sort's conservative classes with an LLM judge (FR-032 adds
  judging as a gate, not as a class).

## Testing

- The moved tests pass unchanged against the package's modules, run from
  the root `bun test`.
- `review.test.ts` gains the Node path: with `transpile` undefined, a
  comment-only change sorts `logic`; with a stub that returns equal output,
  it sorts `comments`.
- `queue.test.ts`: `LandingQueue` over a stand-in `exec` replays
  `server/landing.test.ts`'s loop cases (clean rebase, conflict, red gate,
  main moving three times, busy main, lockfile setup) with no files.
- `server/landing.test.ts` keeps its route, record and orphan cases and
  drops the loop cases the package now owns.
- `bin/land.test.ts` on a scratch repo: `check` exits 1 on red and on a
  sensitive file without `--approve`, 0 otherwise; `init` writes both
  files; `land` fast-forwards a clean branch and leaves a conflicting one.
- `schema.test.ts`: the parsers and the schemas agree on the fixtures.

## Plans

1. **The cut:** the workspace, the five modules and `LandingQueue`, the
   list extraction, `LandingHub` on top of it, every test green. Only on a
   go.
2. **The CLI and the schemas:** `land`, `check`, `init`, the README, the
   two Actions examples.
3. **Publish and contribute:** licence and name settled, the public mirror,
   the first release, and the Paseo plugin or Orca hook FR-046 points at.
