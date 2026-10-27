# Work until merged, plan 2: the conflict loop and needs-you (FR-035)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

**Status:** written 2026-10-27 on main at 6c701c4 plus the trusted-comments commit. Call 7 (the forced push with a lease) was answered yes on 2026-10-27, so every task can start. Executed inline on 2026-10-27, Tasks 1 to 7; the rulings are in the final report and the commits.

**Goal:** A PR canopy opened that falls behind main or conflicts with it is rebased and pushed again by canopy, with a fix run for the conflicts; what canopy cannot finish reaches Eric through the inbox; and each trigger rule has its own health line.

**Architecture:** The PR watch gains one step before auto-fix: when GitHub says BEHIND or DIRTY on the head canopy pushed, the hub fetches, rebases the run's worktree, and pushes with `--force-with-lease` on the sha it pushed last; a conflict becomes a fix run with the files fenced, counted under the base sha. The trigger model reads the watch into two new states and a `needsYou` line, which the triggers page, the inbox and `canopy issues` show. The watch's rebase step is also a route and a CLI word.

**Tech Stack:** Bun, TypeScript strict, React 19, bun:test. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-25-work-until-merged-design.md`, sections "The conflict loop", "Needs you, and the digest" (the digest is plan 3's), "States", "Routes and CLI", and Plans item 2. Plan 1 is `docs/superpowers/plans/2026-10-26-work-until-merged-1.md`; its last section lists what its review changed in the spec.

## Global constraints

- A forced push happens only on a `run/*` branch canopy itself cut and pushed, only with `--force-with-lease=refs/heads/<branch>:<sha canopy pushed last>`, only after a rebase canopy ran or a fix run canopy started in the branch's own worktree, never on `target`, never with bare `--force`. `pushBranch` stays force-free for every other caller.
- Call 7 in the spec's Calls section (Eric's yes to the lease push) was given on 2026-10-27; Tasks 3 and 4 rest on it.
- The rebase runs before `readyToMerge`, which keeps refusing BEHIND and DIRTY, so a merge still happens only on a head GitHub calls MERGEABLE.
- Three conflict fixes per base sha (`MAX_ATTEMPTS`, 3), counted under `rebase:<base sha>`; then auto-fix gives up for the PR with "could not rebase onto <target> after 3 tries".
- A lease the remote refuses stops canopy for that PR: `gaveUp` and `error` both read "the branch moved on GitHub since canopy pushed; rebase it yourself", nothing is pushed, and the event reads Needs you.
- A trusted comment that arrives while a rebase goes waits: the comment loop runs after the rebase step, on the pushed head.
- `TriggerStatus` gains `rebasing` and `conflict`; `stalled` is plan 3's, which sets it. `eventLive` counts the two new states.
- `needsYou` is a sentence on the event, set only by the pure `from*` readers; the page's Needs you section is `needsYou` or the statuses it holds today.
- One health check per rule, `canopy:triggers:<rule name>`, replaces the shared `canopy:triggers`; a check goes when its rule goes.
- src/core files the UI imports stay browser-safe. Strict TypeScript, no `any` or casts in public signatures.
- Each task starts with a failing test and ends with its test, `bun run typecheck`, `bun run lint`, `bun test`, `bun run build`, and a commit.

## Review focus

1. A lease push against a remote branch that is gone (the PR was closed and its branch deleted between reads) is refused as stale, not pushed as new; the hub's words say the branch moved or is gone (Task 3).
2. A rebase on a worktree a stopped fix run left dirty ends in `rebaseOnto`'s error path, which gives up with the reason and pushes nothing (Task 4).
3. `mergeStateStatus` UNKNOWN, which GitHub answers right after a push (spec probe P2), never starts a rebase; only BEHIND and DIRTY do (Task 2).
4. `POST /api/prs/rebase` on a watch whose fix run is still going, or whose head is not the one canopy pushed, is refused with why, and starts nothing (Task 7).
5. `needsYou` goes away when the watch no longer needs anyone: auto-fix turned on again clears `gaveUp`, and the next `fromPr` drops the line (Task 5).

---

## File structure

- `src/core/pr.ts`: `readyToRebase`, `rebaseKey`, `fixPromptForConflict` beside `readyToMerge` and the other prompts. Pure.
- `src/core/types.ts`: `PrWatch.rebasing`.
- `src/core/worktree.ts`: `pushBranchLease` beside `pushBranch`.
- `src/core/trigger.ts`: the two states, `needsYou` on the event, `fromPr` reading the watch.
- `src/server/prs.ts`: the rebase step in `tick`, the lease push after a conflict fix in `finishFix`, `rebaseNow` and the route.
- `src/server/triggers.ts`, `src/server/index.ts`: `reportPoll` by rule and the per-rule checks.
- `ui/src/triggers.ts`, `ui/src/inbox.ts`, `ui/src/components/Inbox.tsx`: the sections, the words, the `trigger` inbox item.
- `src/cli/pr.ts`, `src/cli/issues.ts`: `canopy pr rebase`, `canopy issues --needs-you`.

---

### Task 1: One health check per trigger rule

**Files:**
- Modify `src/server/triggers.ts:150-160` (`TriggerDeps`), `:300-320` (`loadRules`), `:520-560` and `:975-985` (the `reportPoll` calls)
- Modify `src/server/index.ts:2530-2535`, `:2578`, `:5376` (the `reportPoll` wiring)
- Test: `src/server/triggers.test.ts` ("polling" describe, line 894)

**Interfaces:**
- Consumes: `HealthHub.add`, `remove`, `ids(prefix)`, `report` in `src/server/health.ts`.
- Produces: `TriggerDeps.reportPoll: (rule: string, r: ProbeResult) => void`; `TriggerDeps.rulesChanged?: (names: string[]) => void`, called from `loadRules` when the set of rule names differs from the last load; `TRIGGERS_CHECK = "canopy:triggers:"` in `src/server/index.ts` as the prefix, with `triggerCheckId(rule: string): string` giving `canopy:triggers:<rule>`.

- [ ] **Step 1: Write the failing tests** named "a failed listing is reported under its own rule, and the other rule's poll stays clean" and "rulesChanged fires with the names when triggers.json changes, once per change". The first writes two polling rules, makes `listIssues` throw for one, polls both, and asserts `reportPoll` was called with `("a", { state: "down", why: ... })` and `("b", { state: "ok" })`. The second loads rules twice with the same file (one call), edits the file (a second call with the new names), and asserts the names. Write both rules through the polling describe's `pollRules`, widened to take a list.

```ts
const reports: [string, ProbeResult][] = [];
const h = hub({ reportPoll: (rule, r) => reports.push([rule, r]), listIssues: async (rule) => { if (rule.name === "a") throw new Error("gh: 502"); return []; } });
await rulesFile([{ name: "a", source: "github", repo: "web/shop" }, { name: "b", source: "github", repo: "web/shop" }]);
await h.adopt(); // the lock holder polls, as the polling tests do
await h.poll("a"); await h.poll("b");
expect(reports).toEqual([["a", { state: "down", why: "gh: 502" }], ["b", { state: "ok" }]]);
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test src/server/triggers.test.ts -t "own rule|rulesChanged"`
Expected: FAIL: `reportPoll` is called with one argument, and `rulesChanged` is not a dep.

- [ ] **Step 3: Change `reportPoll` to take the rule name first**

In `src/server/triggers.ts` the dep becomes `reportPoll: (rule: string, r: ProbeResult) => void`; every call passes `rule.name` (or `name`) and drops the `${name}: ` prefix from its `why`, since the check is the rule's own. `loadRules` keeps the last names and calls `this.deps.rulesChanged?.(names)` when they differ (a sorted join compares them).

- [ ] **Step 4: Wire the per-rule checks in `src/server/index.ts`**

Replace the shared `state.health.add({ id: TRIGGERS_CHECK, ... })` and its `report` with `rulesChanged: (names) => { ... }`: for each name not in `state.health.ids(TRIGGERS_CHECK)`, `add({ id: triggerCheckId(name), label: \`issue polls: ${name}\`, scope: canopy, heal: "self" })` and `report(id, { state: "ok" })`, as the shared check reported at start; remove each kept id whose name is not in `names`. `reportPoll: (rule, r) => state.health.report(triggerCheckId(rule), r)`. Call `state.triggers.loadRules()` once at startup so the checks exist before the first poll.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `bun test src/server/triggers.test.ts`
Expected: PASS, including the old polling tests with their `reportPoll` stand-in widened to two arguments.

- [ ] **Step 6: Run typecheck, lint, the suite and the build**

Run: `bun run typecheck && bun run lint && bun test && bun run build`
Expected: PASS for all four. `src/server/health-canopy.test.ts` does not name the shared check; if the suite shows one that does, change its id to `canopy:triggers:<rule>`.

- [ ] **Step 7: Commit**

~~~sh
git add src/server/triggers.ts src/server/triggers.test.ts src/server/index.ts
git commit -m "feat(triggers): one health check per rule"
~~~

---

### Task 2: The pure rebase helpers

**Files:**
- Modify `src/core/types.ts:1343-1392` (`PrWatch`)
- Modify `src/core/pr.ts:121-187`
- Test: `src/core/pr.test.ts` (new describe "the rebase step" after "readyToMerge", line 181)

**Interfaces:**
- Consumes: `PrState.mergeState`, `PrState.head`, `PrWatch.pushed`, `fixing`, `attempts`; `MAX_ATTEMPTS` and `fence` in `pr.ts`.
- Produces: `PrWatch.rebasing?: { from: string }` (the head the rebase started from, present only while the hub rebases); `readyToRebase(s: PrState, w: Pick<PrWatch, "pushed" | "fixing" | "rebasing">): { ok: true } | { ok: false; why: string }`; `rebaseKey(base: string): string` giving `rebase:<base>`; `fixPromptForConflict(w: Pick<PrWatch, "number" | "branch" | "remote" | "target">, files: readonly string[]): string`.

- [ ] **Step 1: Write the failing tests** named "readyToRebase: only BEHIND or DIRTY, on the head canopy pushed, with no fix or rebase going" and "a conflict's prompt fences the files, names the remote and target, and says canopy pushes with a lease".

```ts
expect(readyToRebase(state({ mergeState: "BEHIND" }), watch())).toEqual({ ok: true });
expect(readyToRebase(state({ mergeState: "DIRTY" }), watch())).toEqual({ ok: true });
for (const [s, w, why] of [
  [state({ mergeState: "CLEAN" }), watch(), "it is not behind main (CLEAN)"],
  [state({ mergeState: "UNKNOWN" }), watch(), "it is not behind main (UNKNOWN)"],
  [state({ mergeState: "BEHIND", status: "merged" }), watch(), "it is merged"],
  [state({ mergeState: "BEHIND", head: "h2" }), watch(), "the head moved since canopy pushed"],
  [state({ mergeState: "BEHIND" }), watch({ fixing: { run: "f", key: "check:test" } }), "a fix is going"],
  [state({ mergeState: "BEHIND" }), watch({ rebasing: { from: "h1" } }), "a rebase is going"],
] as const) expect(readyToRebase(s, w)).toEqual({ ok: false, why });
expect(rebaseKey("abc")).toBe("rebase:abc");
const p = fixPromptForConflict(watch({ number: 12, branch: "run/x-b1", remote: "origin", target: "main" }), ["src/a.ts", "src/b.ts"]);
expect(p).toContain("PR #12 from run/x-b1: rebasing it onto origin/main stops on conflicts in 2 files.");
expect(p).toContain("<<<\nsrc/a.ts\nsrc/b.ts\n>>>");
expect(p).toContain("git fetch origin main");
expect(p).toContain("git rebase origin/main");
expect(p).toContain("keeping both the branch's intent and main's change");
expect(p).toContain("do not push: canopy pushes the branch to the PR once you end, with a lease on the commit it pushed last");
```

`state` and `watch` are the fixtures `pr.test.ts` already has for `readyToMerge`; give `watch()` a `pushed` of `"h1"` and `state()` a `head` of `"h1"`, and let `watch` take overrides if it does not yet.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test src/core/pr.test.ts -t "rebase"`
Expected: FAIL: `readyToRebase` is not exported.

- [ ] **Step 3: Add `rebasing` to `PrWatch` and the three helpers to `src/core/pr.ts`**

`readyToRebase` checks in this order: status not open ("it is <status>"), `mergeState` not BEHIND or DIRTY ("it is not behind main (<mergeState>)"), head moved, a fix going, a rebase going. `fixPromptForConflict` opens with the line the test pins ("1 file" when one), fences the files with `fence("The files", files.join("\n"))`, then: "In this worktree, run `git fetch <remote> <target>` and `git rebase <remote>/<target>`, resolve each listed file keeping both the branch's intent and <target>'s change, run the gates, and leave the branch rebased and committed; do not push: canopy pushes the branch to the PR once you end, with a lease on the commit it pushed last."

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test src/core/pr.test.ts`
Expected: PASS.

- [ ] **Step 5: Run typecheck, lint, the suite and the build**

Run: `bun run typecheck && bun run lint && bun test && bun run build`
Expected: PASS.

- [ ] **Step 6: Commit**

~~~sh
git add src/core/types.ts src/core/pr.ts src/core/pr.test.ts
git commit -m "feat(pr): readyToRebase, rebaseKey and the conflict prompt"
~~~

---

### Task 3: The lease push

**Files:**
- Modify `src/core/worktree.ts:177-187`
- Test: `src/core/worktree.test.ts` (the describe that holds `withRemote`, line 174)

**Interfaces:**
- Consumes: `git`, `why` and `PushResult` in `worktree.ts`; the test file's `withRemote(name)` and `sh` helpers.
- Produces: `pushBranchLease(dir: string, remote: string, branch: string, expect: string): Promise<PushResult>`: `git push --porcelain --force-with-lease=refs/heads/<branch>:<expect> <remote> refs/heads/<branch>:refs/heads/<branch>`, 120 s, `{ ok: true }` on code 0, else `{ rejected: why(r, "git push") }`.

- [ ] **Step 1: Write the failing tests** named "pushBranchLease pushes a rebased branch while the remote is at the sha canopy pushed", "refused with stale info once another clone moved the remote branch, and pushBranch refuses the same push without a lease", and "refused when the remote branch is gone". Each starts from `withRemote()`, pushes `run/p-p1` with `pushBranch` and keeps the sha as `expect`, then commits on main, rebases the branch onto main in the worktree (`sh(r, "rebase", "main")` on the branch), and:

```ts
expect(await pushBranchLease(r, "origin", "run/p-p1", expect)).toEqual({ ok: true });
expect(await sh(bare, "rev-parse", "refs/heads/run/p-p1")).toBe(await sh(r, "rev-parse", "HEAD"));
// second test: a clone pushes one more commit to run/p-p1 first
const refused = await pushBranchLease(r, "origin", "run/p-p1", expect);
expect("rejected" in refused && /stale info/.test(refused.rejected)).toBe(true);
expect("rejected" in (await pushBranch(r, "origin", "run/p-p1"))).toBe(true);
expect(await sh(bare, "rev-parse", "refs/heads/run/p-p1")).toBe(theirs);
// third test: sh(bare, "update-ref", "-d", "refs/heads/run/p-p1") first
expect("rejected" in (await pushBranchLease(r, "origin", "run/p-p1", expect))).toBe(true);
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test src/core/worktree.test.ts -t "pushBranchLease"`
Expected: FAIL: `pushBranchLease` is not exported.

- [ ] **Step 3: Add `pushBranchLease` to `src/core/worktree.ts`** under `pushBranch`, with a header comment naming the one caller it exists for (the PR watch's rebase step) and the rule that `pushBranch` stays force-free.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test src/core/worktree.test.ts`
Expected: PASS. The suite runs on macOS and in the mini's containers, so the flags are ones both gits accept (`--force-with-lease=<ref>:<sha>` has been in git since 1.8.5).

- [ ] **Step 5: Run typecheck, lint, the suite and the build**

Run: `bun run typecheck && bun run lint && bun test && bun run build`
Expected: PASS.

- [ ] **Step 6: Commit**

~~~sh
git add src/core/worktree.ts src/core/worktree.test.ts
git commit -m "feat(worktree): push a run branch with a lease on the sha canopy pushed"
~~~

---

### Task 4: The rebase step in the PR watch

**Files:**
- Modify `src/server/prs.ts:42` (imports), `:620-665` (`tick`), `:668-700` (`finishFix` and `startFix`)
- Test: `src/server/prs.test.ts` (new describe "the rebase step" after "auto-fix", line 458; `Gh` gains `mergeState: string`, default `"CLEAN"`, which `view()` puts in `mergeStateStatus`)

**Interfaces:**
- Consumes: `readyToRebase`, `rebaseKey`, `fixPromptForConflict`, `exhausted`, `MAX_ATTEMPTS` (Task 2); `pushBranchLease`, `rebaseOnto`, `revOf`, `dirtyFiles` (Task 3 and `worktree.ts`); `PrDeps.startFix`, `record`, `runOk`.
- Produces: in `tick`, for an open PR, before auto-fix: `if (w.autoFix && !w.fixing && w.gaveUp === undefined && readyToRebase(w.state, w).ok) w = await this.rebase(w);` then `if (w.autoFix && !w.fixing) w = await this.autoFix(w);` as today. `private async rebase(w: PrWatch): Promise<PrWatch>`. `finishFix` pushes a `rebase:` key's fix with `pushBranchLease(w.dir, w.remote, w.branch, w.pushed)` and any other key's with `pushBranch` as today. `startFix`'s label for a `rebase:` key is `fix PR #<n>: rebase onto <target> (<k>/3)`.

- [ ] **Step 1: Write the failing tests**:

"BEHIND on the head canopy pushed: fetched, rebased and pushed with a lease; the new head is pushed and read at the fresh pace". Open the PR with auto-fix on, set `w.gh.head` to the worktree head, commit `c.txt` on `path` main and push it to the bare, set `w.gh.mergeState = "BEHIND"`, `pollNow`. Assert `pr.pushed` is the worktree's new HEAD, that HEAD's parent is main's head, the bare's `run/thing-<id>` is at it, `pr.rebasing` is undefined, `pr.error` is undefined, and `w.fixes` is empty.

"DIRTY with a conflict starts one fix run with the files fenced, counted under the base sha; its push goes with the lease". Commit `a.txt` as "mine" in the worktree (after the world's `b.txt`) before `hub.open`, which pushes the branch, and set `gh.head` to the worktree head; commit `a.txt` as "theirs" on main and push; `mergeState = "DIRTY"`; `pollNow`. Assert one fix with `prompt` containing "stops on conflicts in 1 file." and "<<<\na.txt\n>>>", `label` `fix PR #7: rebase onto main (1/3)`, `pr.fixing` `{ run: "fix1", key: "rebase:<main head>" }`, `pr.attempts["rebase:<main head>"]` 1. Then resolve by hand in the worktree (fetch, `rebase origin/main` with the file taken as "theirs" plus "mine" and `GIT_EDITOR=true`), end the run (`w.active.delete("fix1")`), `pollNow`, and assert `pr.pushed` is the rebased head and the bare is at it.

"a lease the remote refuses gives up with the branch-moved words and pushes nothing". As the first test, but a clone pushes a commit to the run branch before the poll. Assert `pr.gaveUp` and `pr.error` are "the branch moved on GitHub since canopy pushed; rebase it yourself", `pr.pushed` is unchanged, the bare's branch is the clone's commit, and `w.fixes` is empty.

"three conflict fixes on one base, then auto-fix gives up". The DIRTY setup; end each fix run without resolving (`w.active.delete`, head unchanged, so `finishFix` counts it failed); after the third, assert `pr.gaveUp` is "could not rebase onto main after 3 tries" and `w.fixes` has 3.

"a rebase that errors gives up with the reason and pushes nothing" (review focus 2). The BEHIND setup, with an uncommitted edit to `b.txt` in the worktree. Assert `pr.gaveUp` starts with "could not rebase onto main:", `pr.pushed` unchanged, nothing pushed.

"a trusted comment that arrived while the PR was behind is fixed on the rebased head". The BEHIND setup plus `w.gh.comments = [comment by a trusted login]`, `perms` giving write. After `pollNow`: `pr.pushed` is the rebased head, then one fix whose prompt contains the comment and whose `key` is `comment:<id>`.

"auto-fix off: BEHIND starts no rebase".

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test src/server/prs.test.ts -t "rebase"`
Expected: FAIL: nothing is rebased, `pr.pushed` is the old head.

- [ ] **Step 3: Implement `rebase` in `src/server/prs.ts`**

`rebase(w)`: `git fetch <remote> <target>` in `w.dir` (60 s; a failure returns `{ ...w, error: \`fetching ${target}: <last line>\` }` and no gaveUp, so the next read tries again); `base = revOf(w.dir, \`${remote}/${target}\`)`; `key = rebaseKey(base)`; if `exhausted(w, key)` return `{ ...w, gaveUp: \`could not rebase onto ${target} after 3 tries\` }`; save and publish `{ ...w, rebasing: { from: w.pushed } }` so the page shows it; `r = await rebaseOnto(w.dir, \`${remote}/${target}\`)`. On `ok`: `head = revOf(w.dir, "HEAD")`, `pushBranchLease(w.dir, w.remote, w.branch, w.pushed)`; ok gives `{ ...rest, pushed: head }` with `rebasing`, `error` dropped; rejected gives `{ ...rest, error: MOVED, gaveUp: MOVED }` with `MOVED` the spec's sentence. On `conflict`: `this.startFix({ ...rest }, key, fixPromptForConflict(w, files))`. On `error`: `{ ...rest, error, gaveUp: \`could not rebase onto ${target}: ${error}\` }`. In `finishFix`, pick the push by `fixing.key.startsWith("rebase:")`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test src/server/prs.test.ts`
Expected: PASS, with every older auto-fix and auto-merge test unchanged (their `mergeState` default stays CLEAN).

- [ ] **Step 5: Run typecheck, lint, the suite and the build**

Run: `bun run typecheck && bun run lint && bun test && bun run build`
Expected: PASS.

- [ ] **Step 6: Commit**

~~~sh
git add src/server/prs.ts src/server/prs.test.ts
git commit -m "feat(prs): rebase a PR that fell behind, and fix its conflicts"
~~~

---

### Task 5: The two states and needs-you on the event

**Files:**
- Modify `src/core/trigger.ts:84-110` (`TriggerStatus`, `TRIGGER_STATUSES`), `:110-160` (`TriggerEvent`), `:779-792` (`fromPr`), `:902` (`eventLive`)
- Modify `ui/src/triggers.ts:16-70` (`SECTION_OF`, `STATUS_WORD`, `STATUS_TONE`), `:73-77` (`triggerSections`), `:83-100` (`outcomeLine`), `:128-138` (`triggersBadge`)
- Test: `src/core/trigger.test.ts` (the `fromPr` tests), `ui/src/triggers.test.ts:24-42, 85-95`

**Interfaces:**
- Consumes: `PrWatch.rebasing`, `fixing.key`, `gaveUp`, `approve`, `untrusted`, `state.head` (Tasks 2 and 4).
- Produces: `TriggerStatus` adds `"rebasing" | "conflict"`; `TriggerEvent.needsYou?: string`; `needsYouFromPr(w: PrWatch): string | undefined` exported from `trigger.ts` and used by `fromPr`; `triggerSections` puts an event with `needsYou` in "needs" whatever its status; `outcomeLine` returns `needsYou` first.

- [ ] **Step 1: Write the failing tests** in `trigger.test.ts`, named "fromPr reads rebasing and conflict from the watch, and back to review" and "needsYou from the PR: approval, auto-fix gave up, a comment without write access and nothing going; gone once the watch is clean":

```ts
const w = watch({ rebasing: { from: "h1" } });
expect(fromPr(ev, w, 5).status).toBe("rebasing");
expect(fromPr(ev, { ...w, rebasing: undefined, fixing: { run: "f", key: "rebase:b1" } }, 5).status).toBe("conflict");
expect(fromPr(ev, { ...w, rebasing: undefined, fixing: { run: "f", key: "check:test" } }, 5).status).toBe("review");
expect(needsYouFromPr(watch({ approve: { head: "h1", why: "infra/" } }))).toBe("it touches files that need your approval (infra/); merge it on GitHub yourself");
expect(needsYouFromPr(watch({ gaveUp: "could not rebase onto main after 3 tries" }))).toBe("auto-fix gave up: could not rebase onto main after 3 tries");
expect(needsYouFromPr(watch({ untrusted: [comment("ann")] }))).toBe("a review comment by ann, who has no write access, waits for you");
expect(needsYouFromPr(watch({ untrusted: [comment("ann")], fixing: { run: "f", key: "check:test" } }))).toBeUndefined();
const needy = fromPr(ev, watch({ gaveUp: "x" }), 5);
expect(needy.needsYou).toBe("auto-fix gave up: x");
expect(fromPr(needy, watch(), 6).needsYou).toBeUndefined();
```

`watch` here is the fixture at `trigger.test.ts:835`, widened from a status word to overrides over an open watch, and `comment(author)` a `PrComment` with that author. And in `ui/src/triggers.test.ts`: "an event with needsYou is in Needs you whatever its status, and rebasing and conflict are Working" (a `review` event with `needsYou` lands in `needs`; `rebasing` and `conflict` in `working`; `STATUS_WORD.rebasing` is "rebasing onto main", `STATUS_WORD.conflict` is "fixing a rebase conflict"; `outcomeLine` of the needy event is its `needsYou`; `triggersBadge` counts it).

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test src/core/trigger.test.ts ui/src/triggers.test.ts -t "rebasing|needsYou|needs you"`
Expected: FAIL: the statuses are not in the type and `needsYouFromPr` is not exported.

- [ ] **Step 3: Implement**

In `trigger.ts`: the two statuses with doc comments ("canopy is rebasing the PR's branch onto its target", "a rebase conflict is being fixed; the fix run is `runId`"), in `TRIGGER_STATUSES` after `review`; `eventLive` counts them. `needsYouFromPr(w)` in the order the test pins: `approve` on the head read, `gaveUp`, an untrusted comment with no fix and no rebase going (the newest comment's author). `fromPr`: status is merged, closed, `rebasing`, `conflict` (`fixing.key` starts with `rebase:`), else `review`; sets `needsYou` from `needsYouFromPr` and deletes it when undefined; the "nothing changed" early return compares `needsYou` too. In `ui/src/triggers.ts`: `SECTION_OF` adds the two under `working`, `STATUS_WORD` and `STATUS_TONE` (both `sky`) the words above, `triggerSections` reads `e.needsYou !== undefined ? "needs" : SECTION_OF[e.status]`, `outcomeLine` returns `e.needsYou` before anything else, `triggersBadge` counts `needsYou` with the needs statuses.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test src/core/trigger.test.ts ui/src/triggers.test.ts src/server/triggers.test.ts`
Expected: PASS. `src/server/triggers.test.ts` and `src/cli/issues.test.ts` hold exhaustive status lists only through `TRIGGER_STATUSES`; if typecheck names another `Record<TriggerStatus, ...>`, add the two keys there.

- [ ] **Step 5: Run typecheck, lint, the suite and the build**

Run: `bun run typecheck && bun run lint && bun test && bun run build`
Expected: PASS.

- [ ] **Step 6: Commit**

~~~sh
git add src/core/trigger.ts src/core/trigger.test.ts ui/src/triggers.ts ui/src/triggers.test.ts
git commit -m "feat(triggers): rebasing and conflict states, and what needs you"
~~~

---

### Task 6: The trigger item in the inbox

**Files:**
- Modify `ui/src/inbox.ts:40-50` (`InboxSource`, `InboxItem.kind`), `:100-120` (`InboxContext`), `:431-470` (`mergeInbox`)
- Modify `ui/src/components/Inbox.tsx:48` (`KIND_GLYPH`), `:301-320` (the row's body)
- Modify `ui/src/store.ts:4939` (the context passed to `mergeInbox`)
- Test: `ui/src/inbox.test.ts` ("mergeInbox" describe, line 97)

**Interfaces:**
- Consumes: `TriggerEvent.needsYou`, `short`, `key`, `title`, `branch`, `lastAt`, `repoId`, `service` (Task 5); `serviceOf` in `ui/src/triggers.ts`.
- Produces: `InboxSource` adds `"trigger"`; `InboxItem.kind` adds `"trigger"`; `InboxContext.triggers?: readonly TriggerEvent[]`; `triggerItem(e: TriggerEvent, ctx: InboxContext): InboxItem | null` with `key` `trigger:<e.id>`, `source` `"trigger"`, `who` the service's name, `where` `<short or key> via <backend>`, `title` `<short or key>: <needsYou>`, `detail` `e.title`, `at` `e.lastAt`, `left` and `until` null; `mergeInbox` adds one per event with `needsYou`, after the PR items, and drops it when an item with key `pr:<e.branch>` is already there.

- [ ] **Step 1: Write the failing tests** named "an event that needs you is an inbox item, named by its issue and what it needs" and "a PR's gave-up item speaks for its event, so the event adds no second item":

```ts
const e = event({ id: "mac|t1", short: "#12", title: "Login breaks", needsYou: "auto-fix gave up: x", branch: "b1", lastAt: 7 });
const [it] = mergeInbox([], {}, {}, 0, { ...ctx, triggers: [e] });
expect(it).toMatchObject({ key: "trigger:mac|t1", kind: "trigger", source: "trigger", who: "GitHub", title: "#12: auto-fix gave up: x", detail: "Login breaks", at: 7 });
const both = mergeInbox([], {}, {}, 0, { ...ctx, triggers: [e], prs: [watch({ id: "b1", gaveUp: "x" })] });
expect(both.map((i) => i.key)).toEqual(["pr:b1"]);
expect(mergeInbox([], {}, {}, 0, { ...ctx, triggers: [{ ...e, needsYou: undefined }] })).toEqual([]);
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test ui/src/inbox.test.ts -t "needs you|second item"`
Expected: FAIL: no item is made for the event.

- [ ] **Step 3: Implement `triggerItem` and the kind**

In `inbox.ts` as the Interfaces block says; `repoId` and `repo` from `ctx.repos` by `e.repoId` as `prItem` does, `backend` from `ctx.backendOf?.(e.id)`. In `Inbox.tsx`, `KIND_GLYPH.trigger` is `"!"` and the row's body for `kind === "trigger"` is the `ci`/`gave-up` shape (eyebrow `{item.repo} {item.title}`, the detail) with one `mini` button "open" that goes to the triggers view (`setView("triggers")` as the Triggers nav does). In `store.ts`, pass `triggers: Object.values(s.triggers).flatMap((t) => t.events)` beside `prs`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test ui/src/inbox.test.ts`
Expected: PASS.

- [ ] **Step 5: Run typecheck, lint, the suite and the build**

Run: `bun run typecheck && bun run lint && bun test && bun run build`
Expected: PASS. Check `ui/src/components/Inbox.tsx` renders the new kind with `bun run dev:web` and a stand-in event, or trust the typecheck of `KIND_GLYPH` (a `Record` over every kind) and the test.

- [ ] **Step 6: Commit**

~~~sh
git add ui/src/inbox.ts ui/src/inbox.test.ts ui/src/components/Inbox.tsx ui/src/store.ts
git commit -m "feat(inbox): an issue that needs you is an inbox item"
~~~

---

### Task 7: The rebase route, `canopy pr rebase`, `canopy issues --needs-you`, and the docs

**Files:**
- Modify `src/server/prs.ts:836-880` (`handle`), plus `rebaseNow`
- Modify `src/cli/pr.ts:1-60`, `src/cli/issues.ts:1-40`
- Modify `docs/architecture.md` ("The PR watch", "Triggers", "Health", "The command line" sections), `README.md:88-96`, `FEATURES.md` (FR-035), `SPEC.md` if its route list names `/api/prs/*`
- Test: `src/server/prs.test.ts` (the route, in "the rebase step"), `src/cli/pr.test.ts`, `src/cli/issues.test.ts`

**Interfaces:**
- Consumes: `rebase(w)` (Task 4), `readyToRebase` (Task 2), `PrError`; `ask`, `take`, `has` in `src/cli/health.ts`; `needsYou` (Task 5).
- Produces: `POST /api/prs/rebase {run}` (operate) answering the watch after the step, or `{error}` with 404 for no PR, 409 for "a fix is going; stop it first", "a rebase is going" and `readyToRebase`'s other refusals; `PrHub.rebaseNow(id: string): Promise<PrWatch>`; `canopy pr rebase <run> [--backend URL]`; `canopy issues [repo] [--needs-you] [--backend URL]`, whose "what it needs" column is `needsYou`, else `reason`, else `-`, and whose `--needs-you` keeps only events with `needsYou`.

- [ ] **Step 1: Write the failing tests**

In `prs.test.ts`: "POST rebase runs the step by hand with auto-fix off, and refuses while a fix goes or when the head moved" (review focus 4): the BEHIND setup with auto-fix off; `hub.handle(POST /api/prs/rebase {run})` answers 200 with `pushed` the rebased head; with `fixing` active, 409 and "a fix is going; stop it first"; with `gh.head` moved, 409 and "the head moved since canopy pushed".

In `cli/pr.test.ts`: "canopy pr rebase posts the run and prints the branch, target and new head" (a stand-in `fetch` answering the watch; output `run/x-b1: rebased onto main and pushed (h2 as 7 chars)`), and "the usage names rebase".

In `cli/issues.test.ts`: "the last column is what the issue needs, and --needs-you keeps only those".

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test src/server/prs.test.ts src/cli/pr.test.ts src/cli/issues.test.ts -t "rebase|needs"`
Expected: FAIL: the route answers 404, the CLI fails usage.

- [ ] **Step 3: Implement**

`rebaseNow(id)` through `this.queue`: find the watch (404), refuse an active fix and a rebase going (409), refuse `readyToRebase`'s `why` (409), then `await this.rebase(w)`, save, publish, return. The route is the `/api/prs/rebase` branch in `handle` beside `/api/prs/set`. `canopy pr rebase <run>` in `prCommand` as the third form in `PR_USAGE`. `issueLines` takes the `needsYou` column and a `needsOnly` boolean; `issuesCommand` reads `--needs-you` with `has`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test src/server/prs.test.ts src/cli/pr.test.ts src/cli/issues.test.ts`
Expected: PASS.

- [ ] **Step 5: Update the docs**

`docs/architecture.md`: in "The PR watch", the rebase step (when it runs, the lease, the three tries per base, the gave-up words, the route); in "Triggers", the two states, `needsYouFromPr`, the inbox item, the per-rule health checks, and that `canopy:triggers` is now a family; in "Health", the family under `canopy:triggers:`; in "The command line", `canopy pr rebase` and `--needs-you`. `README.md`: the two CLI lines. `FEATURES.md` FR-035: plan 2's status. This plan's Status line. `SPEC.md` only if it lists the PR routes.

- [ ] **Step 6: Run typecheck, lint, the suite and the build**

Run: `bun run typecheck && bun run lint && bun test && bun run build`
Expected: PASS.

- [ ] **Step 7: Commit**

~~~sh
git add src/server/prs.ts src/server/prs.test.ts src/cli/pr.ts src/cli/pr.test.ts src/cli/issues.ts src/cli/issues.test.ts docs/architecture.md README.md FEATURES.md docs/superpowers/plans/2026-10-27-work-until-merged-2.md
git commit -m "feat(prs): rebase by hand from the route and the CLI; canopy issues --needs-you"
~~~

---

## Live check, before the branch is called done

On the GitHub test repo (`BaruchEric/canopy-trigger-test`, cloned at `~/dev/playground/canopy-trigger-test`, with a scratch server as plan 1's live check used): label an issue `canopy`, let the poll open its PR with auto-fix on, then push a commit to main that touches a file the PR does not, and confirm the PR reads BEHIND, canopy rebases and pushes with the lease, the PR reads CLEAN, and `canopy issues` shows `review`. Then push a commit to main that edits a line the PR changed, confirm DIRTY starts a fix run whose prompt fences the file, and that its push goes. Then push a commit to the run branch by hand and confirm the next BEHIND gives up with the branch-moved words, the inbox shows the item, and `canopy issues --needs-you` lists it. Last, `canopy pr rebase <run>` on a watch with auto-fix off. Each merged fix removes the test repo's bug, so stage a new one before a rerun (memory: triggers-live-test).

## Decisions this plan makes beyond the spec

- `fixPromptForConflict(w, files)` rather than the spec's `(w, target, files)`: `w.target` and `w.remote` are on the watch already.
- A refused lease sets `gaveUp` as well as `error`, so the existing inbox item, the `set` toggle that clears `gaveUp`, and the "turn auto-fix on again to go on" path all apply; the spec names only `error`.
- `readyToRebase` does not read `autoFix`: the tick checks it, and the hand route runs the step regardless, which is what the spec's `POST /api/prs/rebase` is for.
- `stalled` is left for plan 3, which sets it; a status nothing sets is a lie on the page.
- Holding the Forgejo close until the remote has the commit is left out (the spec's Write-back section says why).
- The per-rule check reports `ok` when the rule is loaded, as the shared check did at start; its first poll overrides that.
