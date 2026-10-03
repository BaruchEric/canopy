# Incubator phase 4: renovate and extend. Implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** a scout pick of `renovate` or `extend` is carried out. A renovate pick of a github.com project under an allowed license becomes a private repo built from the upstream and deployed like a `new` one. An extend pick of one of the user's own repos becomes a branch `new/<slug>` pushed to that repo's GitHub remote, and the sprout ends `handed-off`. A `vercel+firebase` pick gets its Firebase project, Firestore rules and web config from canopy. An answer the user gives inside a stage's run is an input the judge reads.

**Architecture:** canopy's own code does every step that holds a token or reaches outside the seed, as phase 3's `ship` does. A new `core/seedsource.ts` resolves an extend target, reads a renovate upstream's license through `gh`, and rebuilds the seed in `.canopy-making` from a clone of the source plus a bundle of the old seed, then swaps it into place while the seed is quiet. Two new straight-line workflows, `renovate` and `extend`, do the agent work. The Shipper gains `pushBranch` (the hand-off) and the Firebase steps. `vercel+convex` and `mini` stay parked (amendment 6, rulings 9 and 12).

**Tech Stack:** Bun + TypeScript (strict), `bun:test`, `git` and `gh` on the backend, `firebase-tools@15.32.1` and node 22 in the canopy image, the Vercel REST API (`POST /v10/projects/:id/env`).

**Spec:** `docs/superpowers/specs/2026-10-01-incubator-design.md`, amendment 6, which this plan's rulings are.

## Rulings

Amendment 6, rulings 1 to 15, written before the first task. In short: extend resolves a target to the user's own pushable GitHub repo, rebuilds the seed from a clone of its remote's default branch, commits nothing of canopy's on the branch, and pushes only `refs/heads/new/<slug>`; renovate takes a github.com upstream whose GitHub license matches the pick's, strips its agent settings and ships like `new`; Firebase is canopy-made and canopy-deployed from a clean clone with a refused `firebase.json`; Convex and `mini` park; an answer inside a run is an input written to `.canopy/answers.md` and read by the judge.

## Global constraints

- TypeScript `"strict": true`; no `any`, no `as` casts on untrusted data, no non-null `!`.
- `src/core/types.ts`, `src/core/sprout.ts`, `src/core/deploy.ts`, `src/core/firebase.ts` and `ui/src/*` stay browser-safe: no Bun or node imports.
- Gates: `bun run typecheck && bun run lint && env -u TMUX SHELL=/bin/bash bun test && bun run build`.
- No allowlist entry holds `git push`, `gh`, `vercel`, `firebase` or `convex`.
- Tests use fixture repos in temp dirs and fakes for `gh`, `firebase` and the Vercel API. Nothing touches a real repo, account or remote.
- Never amend, rebase or force. Commit per task. No backticks in commit messages.

## Review focus

1. **A pick that names something not the user's**: an extend target under `_incubator/`, a remote repo, a third-party clone the login cannot push to, a renovate upstream off github.com or whose GitHub license differs from the pick's. Each parks with the reason. Tasks 3 and 5.
2. **The push.** Only `refs/heads/new/<slug>` to the recorded remote, no `+`, never `main`, never a branch that left its base or carries the incubator's notes. Task 6.
3. **Canopy commits on an extend seed.** None after the rebuild, from any of the six commit paths. Task 5.
4. **The process that holds `FIREBASE_TOKEN`.** An explicit env, a scratch home, a refused `firebase.json`, no `.firebaserc`, no link out of the clone. Tasks 8 and 9.
5. **The answer that went nowhere.** It is an input, in `.canopy/answers.md`, in the judge's text, and survives a rewind. Task 1.

---

## File structure

| File | What changes |
|---|---|
| `src/core/types.ts` | `SproutWork`, `FirebaseRecord`; `Sprout` gains `work?`, `branch?`, `firebase?` |
| `src/core/sprout.ts` | `BUILD_WORKFLOW`, `HAND_OFF`, `buildWorkflow`, the new `nextWorkflow`, `phaseRefusal`, `STEP_STATUS` for renovate and extend, `extendBranch`, `githubRepo`, `branchPushRefusal`, `NOTE_FILES`, `runAnswersText`, `runAnswersSummary`, `hostLine`; `parseSproutRecord` checks the new fields |
| `src/core/seedsource.ts` (new, Bun) | `seedSource(deps)`: `extendTarget`, `upstreamLicense`, `rebuild` |
| `src/core/seed.ts` | `dropAgentSettings` exported for the rebuild |
| `src/core/firebase.ts` (new, pure) | `firebaseConfigRefusal`, `firebaseProjectId`, `firebaseEnv` |
| `src/core/deploy.ts` | `deployReady` for `vercel+firebase` |
| `src/core/shipper.ts` | `pushBranch`, `firebaseProject`, `firebaseApp`, `firebaseDeploy`, `projectEnv`; `ShipConfig` gains the Firebase token and location |
| `src/core/incubator.ts` | the answer hook, the rebuild before a renovate or extend build, extend's commits skipped, `handOff`, the ship per host |
| `src/core/sproutnote.ts`, `src/core/tailchan.ts` | `handed-off` |
| `src/core/envnames.ts` | `FIREBASE_TOKEN` in `SECRET_ENV` |
| `src/server/index.ts`, `src/server/incubator.ts` | the answer hook on `/api/runs/answer`, the seed source wired |
| `lib/workflows/renovate.md`, `lib/workflows/extend.md` (new); `scout.md`, `build-new.md` | the build workflows; scout's target and host words; answers in the evidence |
| `Dockerfile`, `docker-compose.yml` | node 22 and firebase-tools in the canopy image; `FIREBASE_TOKEN`, `FIREBASE_LOCATION` on the canopy service |
| `ui/src/sprouts.ts`, `ui/src/components/Incubator.tsx` | the branch link, the word for a hand-off |
| `docs/architecture.md`, `docs/deploy.md` | the phase 4 notes and the mini's new `.env` names |

---

## Task 1: an answer inside a run is an input the judge reads

**Files:**
- Modify: `src/core/sprout.ts`, `src/core/incubator.ts`, `src/server/index.ts`, `src/core/incubator.test.ts`, `src/core/sprout.test.ts`, `lib/workflows/scout.md`, `lib/workflows/build-new.md`

**Interfaces:**
- Produces: `runAnswersText(where: string, questions: RunQuestion[], answers: Record<string, string>, at: number): string`, `runAnswersSummary(where, questions, answers): string` (sprout.ts); `Incubator.runAnswered(runId: string, questions: RunQuestion[], answers: Record<string, string>): Promise<boolean>`; `SEED_FILES` gains `.canopy/answers.md`.

- [ ] **Step 1: Failing tests.** In `sprout.test.ts`: the text has a heading naming the stage and step and each question with its answer; the summary is one line clipped at 200. In `incubator.test.ts`, with the fakes the file already has: a sprout in `researching` whose scout flow's current step has `runId` `run_1`; `runAnswered("run_1", [q], {[q.question]: "Extend clms"})` adds an input of kind `answers` via `answer`, writes `.canopy/answers.md` holding "Extend clms" and rewrites `.canopy/inputs.md`, leaves the pick and `reclarify` alone and the status `researching`; a second answer appends; a run no owned flow holds answers false and writes nothing; a retro flow's run answers false. A judge test in `verdict.test.ts` or `evidence.test.ts`: with `evidence: .canopy/intent.md .canopy/answers.md ...` the judge's text holds the answer.
- [ ] **Step 2: Implement** `runAnswersText`, `runAnswersSummary`, `Incubator.runAnswered` (finds the owner by the flow whose step holds the run id, skips retro flows, works through `serial` so the queue waits for the write), and in the server's `/api/runs/answer` capture the run's prompt questions before answering and call `incubator.runAnswered` after an `answers` reply.
- [ ] **Step 3: Evidence.** scout's Eval evidence becomes `.canopy/intent.md .canopy/answers.md .canopy/research.md .canopy/pick.json .canopy/eval.md`; build-new's Accept gains `.canopy/answers.md` after intent. A test in `workflows.test.ts` (or the scout test) pins both.
- [ ] **Step 4: Gates on the touched files, commit** `feat(incubator): an answer given inside a stage's run is an input the judge reads`.

## Task 2: the chain knows renovate, extend and the hand-off

**Files:**
- Modify: `src/core/types.ts`, `src/core/sprout.ts`, `src/core/sproutnote.ts`, `src/core/tailchan.ts`, `src/core/retro.ts` (if `endRetroDue` needs it), tests beside each.

**Interfaces:**
- Produces: `HAND_OFF = "hand-off"`, `BUILD_WORKFLOW: Record<PickKind, string>`, `nextWorkflow` (build by pick kind after the newest scout, then `SHIP` or `HAND_OFF`), `WORKFLOW_STATUS[HAND_OFF] = "deploying"`, `STEP_STATUS` for renovate (Renovate, Test, Accept) and extend (Build, Test, Accept), `phaseRefusal` per ruling 13, `extendBranch(slug)`, `githubRepo(url): {owner, name} | null`, `hostLine(host)`. `SproutWork { kind, from, base, target?, remote?, branch?, at }`, `Sprout.work?`, `Sprout.branch?`; `NoteEvent` gains `handed-off` (daily); `sproutNotice` says "<title> is handed off as a branch" on the channel; the note's "Where it lives" shows the branch.
- [ ] **Step 1: Failing tests** for each: `nextWorkflow` through new, renovate and extend picks; `phaseRefusal` for every kind and host, extend on `mini` going ahead; `githubRepo` for https, `.git`, ssh and scp forms and refusals; the record parser takes and refuses `work` and `branch`; the daily line and the tailchan line for a hand-off.
- [ ] **Step 2: Implement.** The Incubator's `changed()` treats `handed-off` as an end event (`endRetro`).
- [ ] **Step 3: Commit** `feat(incubator): the chain knows renovate, extend and a hand-off`.

## Task 3: the seed source, resolving a target and reading a license

**Files:**
- Create: `src/core/seedsource.ts`, `src/core/seedsource.test.ts`

**Interfaces:**
- Produces: `interface SeedSource { extendTarget(target: string): Promise<{ repoId: string; remote: string; owner: string; name: string }>; upstreamLicense(url: string): Promise<string | null>; rebuild(s: RebuildSpec): Promise<SproutWork> }`, `seedSource(deps: SeedSourceDeps)`. Deps: `exec`, `repos()` (the scan), `root`, `bundle`, `self`, `cloneUrl?` (tests map a GitHub url to a fixture path), `quiet` (`inQuietSeed`), `committed` (the mirror hook).
- [ ] **Step 1: Failing tests** with fixture repos: a target by id and by unique basename resolves; an id under `_incubator`, a dot folder, a remote repo, an extra-source id, a missing origin and a non-GitHub origin refuse with the reason; `gh api` answering no push permission, archived, or failing refuses; `upstreamLicense` reads `license.spdx_id` and answers null for none or `NOASSERTION`.
- [ ] **Step 2: Implement** with `git remote get-url origin` (local git in the user's repo) and `gh api repos/<o>/<r>`.
- [ ] **Step 3: Commit** `feat(incubator): canopy resolves an extend target to the user's own GitHub repo`.

## Task 4: the rebuild

**Files:**
- Modify: `src/core/seedsource.ts`, `src/core/seed.ts`, tests

**Interfaces:**
- `RebuildSpec { kind: "renovate" | "extend"; seedPath; id; slug; from: string /* clone url */; notes: Record<string, string> }`; answers `SproutWork`.
- [ ] **Step 1: Failing tests** against fixture repos (a bare "remote" with a `main` holding `.claude/settings.json`, a notes seed with two commits): extend leaves HEAD on `new/<slug>` at the remote's main, no `origin`, `incubator/notes` at the old seed's head, notes as plain files that `git status` does not show, the target's `.claude/settings.json` still there; renovate leaves `upstream` at the clean url, the settings stripped in a commit, the notes committed on top, `incubator/notes` kept; the old seed's folder is gone and nothing is left under `.canopy-making`; a failed clone leaves the old seed as it was.
- [ ] **Step 2: Implement.** Clone in `.canopy-making/<slug>.<id>.rework`, fetch the old seed's bundle, write the notes, swap in place inside `quiet`, call `committed`.
- [ ] **Step 3: Commit** `feat(incubator): canopy rebuilds a seed from the source a renovate or extend pick names`.

## Task 5: the Incubator builds renovate and extend

**Files:**
- Modify: `src/core/incubator.ts`, `src/core/incubator.test.ts`

- [ ] **Step 1: Failing tests** with a fake `SeedSource`: a renovate pick checks the GitHub license, rebuilds once and starts `renovate`; a license mismatch parks; an extend pick resolves its target, rebuilds and starts `extend`; a refused target parks with the reason; a restart or resume with `work` set does not rebuild; a new pick of another source on a rebuilt seed parks; after the rebuild no `seeds.commit` runs for an extend sprout from the answer, the inputs, clarify, scout, the build's end or the retro; the build's end commits `SEED_FILES` and the notes for renovate.
- [ ] **Step 2: Implement** `prepareBuild` in `launch`, `commitNotes` as the one way canopy commits seed files, and `built` for every build workflow.
- [ ] **Step 3: Commit** `feat(incubator): a renovate or extend pick is built on a seed canopy rebuilt for it`.

## Task 6: the hand-off

**Files:**
- Modify: `src/core/sprout.ts` (`branchPushRefusal`), `src/core/shipper.ts` (`pushBranch`), `src/core/incubator.ts` (`handOff`), tests

- [ ] **Step 1: Failing tests.** `branchPushRefusal` refuses `refs/heads/main`, `+refs/heads/new/<slug>`, another slug's branch and another remote. `pushBranch` against a fixture bare remote pushes `new/<slug>` only, refuses a branch not descending from the base and one touching `.canopy/intent.md` since the base, and a second push of moved history fails as not a fast-forward. The Incubator ends `handed-off` with `branch` and the retro due.
- [ ] **Step 2: Implement.**
- [ ] **Step 3: Commit** `feat(incubator): an extend ends as one branch pushed to the user's repo`.

## Task 7: the renovate and extend workflows

**Files:**
- Create: `lib/workflows/renovate.md`, `lib/workflows/extend.md`
- Modify: `lib/workflows/scout.md`, `lib/workflows/build-new.md`, `src/core/workflows.test.ts` (or the existing bundled-workflow test)

- [ ] **Step 1: Failing tests** that both parse, are unlisted, hold no push, `gh`, `vercel` or `firebase` tool, have the budgets of ruling 8, judge Accept with `.canopy/answers.md` in the evidence, and that scout's prompt names the target forms and the database host.
- [ ] **Step 2: Write the workflows.**
- [ ] **Step 3: Commit** `feat(incubator): the renovate and extend workflows`.

## Task 8: Firebase, pure

**Files:**
- Create: `src/core/firebase.ts`, `src/core/firebase.test.ts`
- Modify: `src/core/deploy.ts`, `src/core/deploy.test.ts`

- [ ] **Step 1: Failing tests:** `firebaseConfigRefusal` takes rules and indexes and emulators, refuses each refused key, hooks nested anywhere, a rules path with `..`, an absolute one, a non-string; `firebaseProjectId` is 6 to 30 characters, lowercase, starts with a letter; `firebaseEnv` maps an SDK config to both prefixes; `deployReady` for `vercel+firebase` with and without the token and the CLI.
- [ ] **Step 2: Implement. Commit** `feat(incubator): what a Firebase deploy may carry, pure`.

## Task 9: the Firebase ship

**Files:**
- Modify: `src/core/shipper.ts`, `src/core/incubator.ts`, tests

- [ ] **Step 1: Failing tests** with a fake `exec` and `fetch`: the firebase children get the explicit env and never the token on argv; the project, database and app are made once each and put on record; the Vercel env is written before the deploy; `firebase deploy --only firestore --project <id>` runs from a clone without `.firebaserc` or `.env`; a link leading out of the clone refuses the deploy.
- [ ] **Step 2: Implement. Commit** `feat(incubator): canopy makes and deploys a sprout's Firebase side`.

## Task 10: the server and the image

**Files:**
- Modify: `src/core/envnames.ts`, `src/server/index.ts`, `src/server/incubator.ts`, `Dockerfile`, `docker-compose.yml`, `src/server/compose.test.ts`

- [ ] **Step 1:** `FIREBASE_TOKEN` in `SECRET_ENV`; the ship config reads it and `FIREBASE_LOCATION`; the seed source wired with the scan, `bundleSeed`, `inQuietSeed` and the mirror hook. Compose puts both names on the canopy service only; a compose test pins that.
- [ ] **Step 2:** Dockerfile: node 22 copied from `node:22-bookworm-slim` and `firebase-tools@15.32.1` installed in the final stage only. Build `--target stages` and the default target; check `node --version` and `firebase --version` in the final image and that the stages image's checks still pass.
- [ ] **Step 3: Commit** `feat(incubator): the server wires phase 4 and the image carries firebase-tools`.

## Task 11: the page

**Files:**
- Modify: `ui/src/sprouts.ts`, `ui/src/sprouts.test.ts`, `ui/src/components/Incubator.tsx`

- [ ] **Step 1:** The strip marks every stage done for a hand-off (it does), the word says "handed off", the feed line says so, and the sheet shows the branch link beside the repo and url. Tests in `sprouts.test.ts`.
- [ ] **Step 2: Commit** `feat(incubator): the page shows a hand-off and its branch`.

## Task 12: the docs and the gates

- [ ] `docs/architecture.md`: the incubator section gains phase 4.
- [ ] `docs/deploy.md`: `FIREBASE_TOKEN` (made with `firebase login:ci` on the Mac, from a Google account kept for incubator projects), `FIREBASE_LOCATION`, the image change, and that Convex and `mini` stay parked.
- [ ] The four gates, then commit `docs(incubator): phase 4 in the architecture notes and the mini's deploy steps`.
