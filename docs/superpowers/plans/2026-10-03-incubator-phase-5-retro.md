# Incubator phase 5: retro, advice and the improvements list. Implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** every sprout that ends, and every park left 24 hours, gets a retro: an agent reads the sprout's record and writes `.canopy/retro.md` and `.canopy/advice.json`. Canopy checks the advice in code, folds it into `incubator/improvements.md` counting repeats by key, adds the retro to the vault note and the project sheet, and offers the advice in one inbox item. Accepting a piece opens a chat on the repo that owns the file, or the file itself.

**Architecture:** a bundled `retro` workflow run through the existing `Flows`, like every stage, but kept out of `Sprout.flows`: its flow id lives on `Sprout.retro`, so nothing that reads `flows.at(-1)` as the current stage sees it. The Incubator marks a retro due at an end or a 24-hour park, starts at most one at a time after the stages in `pump`, follows its flow apart from `flowMoved`, and records how it ended without ever parking the sprout. The pure parts (the record, the flow digest, `parseAdvice`, the fold and the list's markdown) live in `src/core/retro.ts`. The improvements state is a JSON file beside the markdown in the config dir (`src/core/improvements.ts`). The server adds `GET`/`POST /api/incubator/advice` and an `advice` event; accepting starts a chat run with yolo off.

**Tech Stack:** Bun + TypeScript (strict), `bun:test`, React 19 for the inbox and the sheet.

**Spec:** `docs/superpowers/specs/2026-10-01-incubator-design.md`, "Retro and the improvements list", and amendment 5, which holds every ruling this plan makes.

## Rulings

Amendment 5 in the spec, in short:

1. The record reaches the stage as `_incubator/.shared/record/<id>/record.json`, with no secrets and no raw inputs.
2. Each flow's digest is kept on the sprout when the flow ends.
3. The sprout keeps its last 20 parks and when the current one began.
4. Retro comes due at an end, and at a park left 24 hours with no live flow behind it; never for records from before phase 5.
5. Retro holds no slot; one runs at a time; a sprout waiting in the queue lets its retro finish first.
6. Retro survives a restart, and fails after being cut short three times.
7. A failed retro never parks and never changes the status.
8. `retro.md` is one step with bare Edit and Write, the record's Read and `@advice`.
9. `advice.json` is checked in code by `parseAdvice`; nothing applies an edit.
10. The improvements list counts distinct sprouts per key; a dismissal or an acceptance stands until three more.
11. One inbox item lists every key on offer.
12. Accepting opens a chat on canopy's own repo with yolo off, or the config-dir file.
13. The vault note and the sheet gain the retro.
14. The feed tells a retro's end; tailchan gets a silent channel line when it leaves advice.

## Global constraints

- TypeScript `"strict": true`; no `any`, no `as` casts on untrusted data, no non-null `!`.
- `src/core/types.ts`, `src/core/sprout.ts`, `src/core/retro.ts` and `ui/src/*` stay browser-safe.
- Gates: `bun run typecheck && bun run lint && env -u TMUX SHELL=/bin/bash bun test && bun run build`.
- Another branch (amendment 4) edits `src/core/incubator.ts`, `src/stage/runner.ts` and `src/core/seedgit.ts`. Keep the Incubator change to the retro hooks, and leave the stage runner, seed git and the busy rule alone.
- Copy follows the unslop rules. Commit messages carry no backticks. Commit after each task; never amend, rebase or force.

## Review focus

1. **Advice an agent wrote badly or hostilely:** a `file` that is a path out of the repo, a 1 MB lesson, 40 entries, a key with spaces, extra fields. `parseAdvice` refuses or clips each; the fold never holds anything else. Task 2.
2. **A retro that fails, stops, parks at its gate or is cut short by a restart.** The sprout's status and park reason never move. Task 5.
3. **The first start after the deploy.** Sprouts that ended or parked before phase 5 get no retro. Task 5.
4. **A resume while a park retro runs.** The next stage waits for the retro, never fails to start beside it. Task 5.
5. **The accepted chat.** Its agent has yolo off and no extra flags, and the edit reaches it quoted as a proposal. Task 6.

---

## File structure

| File | What changes |
|---|---|
| `src/core/types.ts` | `FlowDigest`, `SproutFlow.digest`, `SproutPark`, `SproutRetro`, `Advice`, `AdviceOffer`, `AdviceAccepted`; `Sprout` gains `parks`, `parkedAt`, `retro`; `SproutDetail.retro`; the `advice` event |
| `src/core/retro.ts` (new, pure) | `flowDigest`, `retroRecord`, `parseAdvice`, `adviceWorkflow`, `foldAdvice`, `offered`, `decide`, `improvementsMd`, `parkRetroDue`, `RETRO_FILES`, the caps |
| `src/core/sprout.ts` | `parseSproutRecord` checks the new fields; `withRecordRead` |
| `src/core/builtincheck.ts` | `@advice` |
| `lib/workflows/retro.md` (new) | the workflow |
| `src/core/workflows.ts` | `BUNDLED_ORDER` names retro |
| `src/core/stageshare.ts` | `shareRecord`; `unshare` removes the record |
| `src/core/improvements.ts` (new) | `AdviceFiles`: the state and the markdown in the config dir |
| `src/core/incubator.ts` | digests and parks; retro due, start, follow, end, restore; `tick`; the `advice` dep |
| `src/core/sproutnote.ts` | the Retro section |
| `src/server/incubator.ts` | `GET`/`POST /api/incubator/advice`; detail carries the retro |
| `src/server/index.ts` | the advice store, the accept hook (chat or file), the `advice` event, the 10-minute pump |
| `src/core/tailchan.ts`, `src/server/tailchan.ts` | the retro's channel line |
| `ui/src/sprouts.ts` | the strip's retro mark, the feed's retro lines |
| `ui/src/inbox.ts`, `ui/src/components/Inbox.tsx` | the `advice` item |
| `ui/src/store.ts`, `ui/src/api.ts` | the advice list, its event and its answer |
| `ui/src/components/Incubator.tsx` | the sheet's retro section |
| `docs/architecture.md` | the incubator section |

## Task 1: the spec amendment and this plan

- [ ] Append amendment 5 to the spec.
- [ ] Write this plan.
- [ ] Commit: `docs(incubator): amendment 5 and the phase 5 plan rule how retro runs and what advice may do`.

## Task 2: the retro's pure parts

**Files:** `src/core/types.ts`, `src/core/retro.ts`, `src/core/retro.test.ts`, `src/core/sprout.ts`, `src/core/sprout.test.ts`.

- [ ] Tests first, in `retro.test.ts`:
  - `flowDigest` keeps each step's name, status, tries, clipped reason, check exit and clipped output, the judgment's fit, evidence, rules, go and rejected; the rewinds; spent; times; the error. Long text is clipped.
  - `retroRecord` holds no input label, file name or raw text, no `noteRev` or `seedPath`, strips a token from a url in a park reason and in a flow's error, falls back to workflow and outcome for a flow with no digest, and lists the known keys.
  - `parseAdvice`: a list or `{advice}`; not JSON, not a list, more than 6, a bad key, an empty lesson, a lesson over 300 clipped to one line, an edit over 4000 refused, a `file` given as `scout`, `scout.md` or `lib/workflows/scout.md` kept as `scout`, a `file` with `..` or a slash elsewhere refused, a repeated key dropped, extra fields dropped.
  - `foldAdvice`: a new key counts 1; the same sprout again counts once; another sprout counts 2 and its lesson wins; a dismissed key is not offered until three more sprouts give it; an accepted key the same.
  - `offered` sorts by count, then the newest.
  - `improvementsMd` lists the keys most repeated first with their counts and decisions.
  - `parkRetroDue` is true only for a parked sprout with `parkedAt` 24 hours back, no live flow, and no retro since that park.
- [ ] `parseSproutRecord` tests: a record with a bad `retro`, `parks` or `digest` is refused; one without them reads as before.
- [ ] Implement, run the two files, commit: `feat(incubator): the retro's record, its advice and the improvements fold are pure and tested`.

## Task 3: the retro workflow and the advice check

**Files:** `lib/workflows/retro.md`, `src/core/builtincheck.ts`, `src/core/builtincheck.test.ts`, `src/core/workflows.ts`, `src/core/incubator.test.ts` (the bundled-parse test).

- [ ] Tests: `@advice` fails with no retro.md, with no advice.json, with a bad one (the reason names it), passes with `[]` and with good advice ("2 pieces of advice"); the bundled retro parses with one step, `@advice`, `retries: 1`, the budget, `listed: false`, bare Edit and Write, no web tool.
- [ ] Write the workflow and the check, add retro to `BUNDLED_ORDER`. Commit: `feat(incubator): the retro workflow writes a retro and advice that canopy checks in its own process`.

## Task 4: the record in the shared folder

**Files:** `src/core/stageshare.ts`, `src/core/stageshare.test.ts`, `src/core/sprout.ts`.

- [ ] Tests: `shareRecord` writes `.shared/record/<id>/record.json` whole and replaces an older one; an id that is not one is refused; `unshare` removes it. `withRecordRead` adds `Read(/<dir>/**)` to every step.
- [ ] Implement, commit: `feat(incubator): canopy shares a sprout's record with its retro under .shared`.

## Task 5: the Incubator runs retros

**Files:** `src/core/incubator.ts`, `src/core/incubator.test.ts`.

- [ ] Tests, with fakes and an overridable clock:
  - a live sprout's retro starts on the seed with the record shared and readable, the note naming the record; the sprout stays live; the retro holds no slot (two other sprouts still start).
  - a rejection and a stop bring a retro due; a sprout stopped right after a park retro with no new flow gets none.
  - a park with no flow behind it comes due 24 hours on (not at 23); one at a live gate never does; records with no `parkedAt` never do.
  - only one retro runs at a time; the second starts when the first ends.
  - while `isolation` says why, under autostart false, and after detach, no retro starts.
  - the retro's end: advice read and folded, files committed, `retro.state` done with the lessons; a failed or stopped flow, a gated one (stopped), an advice file canopy cannot read, and a refused commit each fail the retro with the reason and leave status and park reason as they were.
  - a sprout queued while its park retro runs waits, and starts when the retro ends.
  - a restart: a running retro whose flow came back is followed; one whose flow is gone is due again; the third cut short fails.
  - dismiss stops a running retro.
  - each flow's digest is on its entry once it ends; parks are kept, at most 20.
- [ ] Implement: `digest` and `parks` in `flowMoved`, `reject` and `park`; `retroDue` at the three ends; `startRetros` at the end of `pump`; `retroMoved` for retro flows; restore; `tick`. Commit: `feat(incubator): a retro runs when a sprout ends or a park waits a day, and never moves the sprout`.

## Task 6: the improvements list, the routes and accepting

**Files:** `src/core/improvements.ts`, `src/core/improvements.test.ts`, `src/server/incubator.ts`, `src/server/incubator.test.ts`, `src/server/index.ts`.

- [ ] Tests: `AdviceFiles` folds and renders through a rename at 0600 and reads back; a broken state file reads as empty with a log line. Server: `GET /api/incubator/advice` lists the offers; `POST` with `{key, accept: false}` dismisses and broadcasts `advice`; `{key, accept: true}` calls the accept hook and answers what it did; an unknown key 404; a bad body 400; a server without the lock 503.
- [ ] Accept hook in `index.ts`: resolve the workflow through `loadWorkflows`; bundled or none: canopy's repo by realpath, then by remote, start a chat with `{...agentFor(cfg, path, "chat"), yolo: false, extra: ""}` and the framed message; user: `openFile` on the config dir when the backend has openers, else the path. Commit: `feat(incubator): advice folds into improvements.md and an accepted lesson opens a chat with yolo off`.

## Task 7: the vault note and the sheet's text

**Files:** `src/core/sproutnote.ts`, `src/core/sproutnote.test.ts`, `src/core/incubator.ts`, `src/server/incubator.ts`.

- [ ] Tests: the note has a Retro section once a retro is done, with the text clipped and the lessons; none before. `detail` carries `retro`.
- [ ] Implement, commit: `feat(incubator): the vault note and the project's detail carry its retro`.

## Task 8: the page

**Files:** `ui/src/sprouts.ts`, `ui/src/sprouts.test.ts`, `ui/src/inbox.ts`, `ui/src/inbox.test.ts`, `ui/src/components/Inbox.tsx`, `ui/src/store.ts`, `ui/src/api.ts`, `ui/src/components/Incubator.tsx`, `ui/src/styles.css`.

- [ ] Tests: the strip marks retro done, now or stuck; the feed says a retro started, left N lessons or failed; `mergeInbox` makes one advice item from the offers, none when there are none.
- [ ] Implement the item (accept and dismiss per key, the edit shown, the chat opened or the path shown), the sheet's retro section, the store's advice list and event. Commit: `feat(incubator): the inbox offers retro advice and the project sheet shows the retro`.

## Task 9: tailchan

**Files:** `src/core/tailchan.ts`, its test, `src/server/tailchan.ts`.

- [ ] Test: a retro that ends done with advice is one silent channel line; done with none, failed or running is nothing. Commit: `feat(incubator): tailchan says when a retro leaves advice`.

## Task 10: docs, gates and a look

- [ ] `docs/architecture.md`'s incubator section.
- [ ] All four gates.
- [ ] A scratch server (`env -u TMUX CANOPY_CONFIG_DIR=/tmp/claude-501/<short> CANOPY_PREVIEW_PORTS=0 CANOPY_NO_DESKTOP=1 bun bin/canopy.ts ui <root> --port 7893 --no-open`) with a seeded improvements state and a live sprout with a done retro: the inbox item and the sheet, checked with playwright-cli. Kill its tmux server after.
- [ ] Commit: `docs(incubator): the architecture notes cover retro and advice`.

## After the plan

The mini takes this with a redeploy alone: no new env var, no new service. Sprouts from before it get no retro.
