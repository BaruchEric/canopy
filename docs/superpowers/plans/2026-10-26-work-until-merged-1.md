# Work until merged, plan 1: issue intake from GitHub and Forgejo (FR-035)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

**Status:** plan 1 issue intake and write-back implemented and independently reviewed locally 2026-10-27 on `feat/oct26-batch`. GitHub/Forgejo live-service checks remain pending. Plans 2 (rebase and conflict loop) and 3 (stall watchdog) remain open. Written on main at 0b87546.

**Goal:** A labeled GitHub or Forgejo issue starts the bundled issue-fix workflow, carries the issue into a branch run, reaches the GitHub PR path or Forgejo landing queue, writes the result back once, and appears in canopy issues.

**Architecture:** Extend the pure trigger model for GitHub and Forgejo rules, payloads, and notes. TriggerHub handles signed hooks and lock-owned cron polling through shared list and detail readers. GitHub events keep the existing PR path; Forgejo events use the existing landing queue. Service writers handle comments and close actions without changing the PR watch.

**Tech Stack:** Bun, TypeScript strict, React 19, bun:test. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-25-work-until-merged-design.md`, Plans item 1; `docs/superpowers/specs/2026-10-25-software-factory-borrowings-design.md`.

## Global constraints

- The trigger sources are sentry, linear, github, and forgejo.
- GitHub and Forgejo rules default to the canopy label and the issue-fix workflow.
- A GitHub rule defaults api to https://api.github.com. A Forgejo rule must name api.
- secretEnv is optional for GitHub and Forgejo. Without secretEnv, a rule polls by default with */15 * * * *; with secretEnv, polling defaults off.
- poll is a cron line parsed by parseCron, at most CRON_MAX characters. Polling runs on the flows-lock holder.
- Hook bodies are at most 1 MiB. Verify the raw body signature before parsing it.
- Poll at most POLL_ISSUES (50) open issues per rule, oldest first. A rule poll never overlaps itself. A failed listing reports one canopy:triggers health check and creates no event.
- Carry the issue body up to MAX_DESCRIPTION (6000) and the newest ISSUE_COMMENTS (10) comments inside the issue fence.
- GitHub uses gh for reads and writes. Forgejo uses tokenEnv, then the matching configured Forgejo source token.
- The issue-fix workflow is bundled and listed: false. It checks that one run can do the work, adds a test for a small fix, runs the gates, commits, and never pushes.
- src/core files imported by the UI stay browser-safe. Use strict TypeScript without any or casts in public signatures.
- Each task starts with a failing test and ends with its test, bun run typecheck, bun run lint, bun test, bun run build, and a commit.
- Plan 2 owns the rebase loop, needsYou, and canopy pr rebase. Plan 3 owns the watchdog and digest. This plan changes no PR-watch code.

## Review focus

1. A GitHub ping or non-issues event answers 200 without an event; a bad X-Hub-Signature-256 with an invalid JSON body answers 401 before parsing, and a body over 1 MiB is rejected (Task 3).
2. A Forgejo opened issue with a rule label and a label_updated delivery whose issue.labels contains that label are accepted; a repeat increments count without starting another branch (Task 3).
3. A poll processes the oldest 50 issues, never overlaps for one rule, runs only on the flows-lock holder, and turns a failed listing into one health report without an event (Task 3).
4. Issue title, body, labels, and newest comment text stay inside the data fence; the body is cut at MAX_DESCRIPTION and at most ISSUE_COMMENTS comments are carried (Task 2).
5. A Forgejo event with a landed queue entry becomes merged after manual or automatic land (Task 4); a write failure stays on resolved.error and does not stop the next event delivery (Task 5).

---

## File structure

- Modify src/core/trigger.ts:11-284, 489-557, 647-741 for source rules, issue data, and event notes.
- Modify src/core/trigger.test.ts:97-175, 247-297, 447-589 for rule, issue, event, and landing assertions.
- Create src/core/forgejoissues.ts and src/core/forgejoissues.test.ts for Forgejo API paths and pure payload parsing.
- Modify src/server/triggers.ts:14-132, 176-261, 330-471, 669-731 for hooks, polling, and issue writes.
- Modify src/server/triggers.test.ts:89-486 for hook, poll, landing, and write-back tests.
- Create src/server/forgejo.ts and src/server/forgejo.test.ts for Forgejo read and write requests.
- Modify src/server/index.ts:1078-1085, 1281-1311, 5162-5167, 5251-5282, 5816-5842 for source readers, branch routing, landing events, and poll health.
- Create lib/workflows/issue-fix.md; modify src/core/workflow.test.ts:147-155, 227-239 to prove it parses and stays unlisted.
- Modify ui/src/api.ts:763-780, ui/src/api.test.ts:34-206, ui/src/store.ts:1182-1188, 3498-3519, ui/src/triggers.ts:1-119, ui/src/triggers.test.ts:24-87, and ui/src/components/Triggers.tsx:129-231 for the poll action and hook-or-poll rule line.
- Create src/cli/issues.ts and src/cli/issues.test.ts; modify src/cli/index.ts:100-136, 855-860 and src/core/help.ts:84-94.
- Modify docs/architecture.md:174-190, SPEC.md:54-58, README.md:76-89, and FEATURES.md:60-63 in the final task.

### Task 1: Extend trigger rules for issue sources

**Files:**
- Modify src/core/trigger.ts:11-284, 489-508
- Modify src/core/trigger.test.ts:97-175, 447-485

**Interfaces:**
- Consumes: TRIGGER_ENV_PREFIX from core/envnames.ts; parseCron and CRON_MAX from core/cron.ts.
- Produces: TriggerSource includes github and forgejo; TriggerRule has optional secretEnv and poll, optional write, and required api; TriggerRuleInfo has optional nextFire. Parsed GitHub and Forgejo rules default labels to ["canopy"] and workflow to "issue-fix".

- [x] **Step 1: Write failing tests** named “GitHub and Forgejo defaults”, “hook secret and poll defaults”, “bad source-specific fields”, “poll cron limits”, and “closed issue can start again”. Assert GitHub api is https://api.github.com; Forgejo requires api; no secretEnv gives poll "*/15 * * * *"; a configured secretEnv leaves poll absent; write defaults true and accepts false; labels, projects, levels, org, and clientId follow the source rules; a closed event no longer blocks an open issue from starting again.

```ts
const { rules, problems } = parseRules(JSON.stringify({ rules: [{ name: "gh", source: "github", repo: "web/shop" }] }));
expect(problems).toEqual([]);
expect(rules[0]).toMatchObject({ api: "https://api.github.com", labels: ["canopy"], workflow: "issue-fix", poll: "*/15 * * * *", write: true });
```
- [x] **Step 2: Run the test to verify it fails**

Run: bun test src/core/trigger.test.ts
Expected: FAIL because the two sources and their rule defaults are not defined.

- [x] **Step 3: Extend the rule model and parser in src/core/trigger.ts**

Add github and forgejo to TRIGGER_SOURCES and SERVICE_NAME. Validate poll through parseCron and CRON_MAX. Allow secretEnv to be omitted only for github and forgejo. Require api for forgejo. Reject projects, levels, org, and clientId on the new sources, and reject labels on sentry. Parse write as an optional boolean for the new sources, defaulting to true. Add nextFire?: number to TriggerRuleInfo. Add closed to the terminal states that let an issue be taken again.

- [x] **Step 4: Run the test to verify it passes**

Run: bun test src/core/trigger.test.ts
Expected: PASS with old Sentry and Linear defaults unchanged.

- [x] **Step 5: Run typecheck**

Run: bun run typecheck
Expected: PASS.

- [x] **Step 6: Run lint**

Run: bun run lint
Expected: PASS.

- [x] **Step 7: Run the full test suite**

Run: bun test
Expected: PASS.

- [x] **Step 8: Build**

Run: bun run build
Expected: PASS.

- [x] **Step 9: Commit**

~~~sh
git add src/core/trigger.ts src/core/trigger.test.ts
git commit -m "feat(triggers): accept github and forgejo rules"
~~~

### Task 2: Parse issue payloads and build fenced notes

**Files:**
- Modify src/core/trigger.ts:165-186, 290-404, 511-557
- Modify src/core/trigger.test.ts:175-297, 485-517
- Create src/core/forgejoissues.ts, src/core/forgejoissues.test.ts

**Interfaces:**
- Consumes: TriggerRule, Incoming, MAX_DESCRIPTION, and noteFor from Task 1; IssueView, parseIssueView, and ISSUE_COMMENTS from core/issue.ts.
- Produces in core/trigger.ts: parseGithubIssue(body: unknown, labels: readonly string[]): Incoming | null; parseForgejoIssue(body: unknown, labels: readonly string[]): Incoming | null; incomingFromIssueView(issue: IssueView): Incoming.
- Produces in core/forgejoissues.ts: ForgejoIssue.createdAt: string; forgejoIssuesPath(api: string, slug: string, label: string): string; forgejoIssuePath(api: string, slug: string, number: number): string; forgejoCommentsPath(api: string, slug: string, number: number): string; parseIssueList(body: unknown, label: string): ForgejoIssue[]; parseIssueView(body: unknown): ForgejoIssue | null; parseIssueComments(body: unknown): { author: string; body: string }[]; openedComment(pr: number, branch: string): string; fixedComment(pr: number): string; closedBody(): { state: "closed" }.

- [x] **Step 1: Write failing tests** for GitHub labeled actions, another label, closed issues, pull requests, and other actions; Forgejo label_updated with and without the label plus opened with an existing label; issue view mapping, createdAt parsing, and issue note text. Assert the note starts with "GitHub issue #123 came in." and its issue fence contains the title, truncated body, labels, and newest comments while excluding comments beyond ISSUE_COMMENTS. For Forgejo API helpers, assert the /api/v1/repos/{o}/{r}/issues path, open-state, label, oldest sort, limit and page query, issue comments path, open/closed filtering, PR exclusion, and the exact comment strings "Opened #12 from run/fix." and "Fixed by #12.".
- [x] **Step 2: Run the tests to verify they fail**

Run: bun test src/core/trigger.test.ts src/core/forgejoissues.test.ts
Expected: FAIL because the issue parsers and Forgejo helpers are absent.

- [x] **Step 3: Implement the pure source parsers and API helpers**

GitHub accepts action labeled only when label.name matches the rule, issue.state is open, and pull_request is absent. Forgejo accepts label_updated or opened only when the open issue's labels contain a rule label. Both carry number as key, #number as short, title, URL, body, labels, and available comments. Parse only JSON-shaped values; keep these files free of node and Bun imports.

- [x] **Step 4: Build notes from source data**

Have noteFor lead with "GitHub issue #123 came in." or "Forgejo issue #123 came in." Put title, body, labels, and the newest 10 comments in fence("The issue", ...). Cut the body at MAX_DESCRIPTION. Map an IssueView to the same Incoming shape for list and detail reads.

- [x] **Step 5: Run the tests to verify they pass**

Run: bun test src/core/trigger.test.ts src/core/forgejoissues.test.ts
Expected: PASS, including the existing Sentry, Linear, and issue-start note cases.

- [x] **Step 6: Run typecheck**

Run: bun run typecheck
Expected: PASS.

- [x] **Step 7: Run lint**

Run: bun run lint
Expected: PASS.

- [x] **Step 8: Run the full test suite**

Run: bun test
Expected: PASS.

- [x] **Step 9: Build**

Run: bun run build
Expected: PASS.

- [x] **Step 10: Commit**

~~~sh
git add src/core/trigger.ts src/core/trigger.test.ts src/core/forgejoissues.ts src/core/forgejoissues.test.ts
git commit -m "feat(triggers): parse github and forgejo issues"
~~~

### Task 3: Add signed hooks and lock-owned polling

**Files:**
- Modify src/server/triggers.ts:14-132, 176-261, 330-471, 669-731
- Modify src/server/triggers.test.ts:89-211, 325-342
- Modify src/server/index.ts:1078-1085, 5251-5282, 5816-5842
- Modify ui/src/api.ts:763-780, ui/src/api.test.ts:34-206, ui/src/store.ts:1182-1188, 3498-3519, ui/src/triggers.ts:1-119, ui/src/triggers.test.ts:24-87, ui/src/components/Triggers.tsx:129-231

**Interfaces:**
- Consumes: parseGithubIssue, parseForgejoIssue, incomingFromIssueView, ForgejoIssue helpers, TriggerRule.poll, and TriggerRuleInfo.nextFire from Tasks 1-2.
- Consumes: ProbeResult from core/health.
- Produces in TriggerDeps: listIssues(rule: TriggerRule, repo: Repo): Promise<Incoming[]>; readIssue(rule: TriggerRule, repo: Repo, issue: Incoming): Promise<Incoming>; reportPoll(result: ProbeResult): void.
- Produces in TriggerHub: poll(ruleName: string): Promise<void>; POST /api/triggers/poll { rule }; GET /api/triggers includes nextFire for each scheduled rule.
- Produces in the UI store and API: pollTrigger(backend: string, rule: string): Promise<void>.

- [x] **Step 1: Write failing tests** for signed GitHub and Forgejo hooks, including X-Gitea-Signature, bad signatures, a bad signature on invalid JSON returning 401 before parse, a body over 1 MiB, quiet 200 for ping and unrelated event names, 404 when secretEnv is absent, 503 when its env value is missing, poll-now, and GET info's nextFire. Redelivering the same Forgejo issue must increment count without starting another branch. Use 60 issue candidates to prove the poll returns the oldest 50 and leaves the 10 newer ones for a later tick; test multiple-label deduplication, flows-lock-only scheduling, and same-rule overlap with a deferred list response. Failed list and detail reads must report exactly one health result without making events. Add UI API and model assertions for the poll POST, a hook line, and a rule with no hook that says "polls every 15 min".

```ts
expect((await h.handle(githubReq("{", "sha256=bad"), githubUrl))?.status).toBe(401);
expect(h.list().map((event) => event.key)).toEqual(oldest.map((issue) => issue.key));
expect(h.list()).toHaveLength(50);
expect(new Set(h.list().map((event) => event.key)).size).toBe(50);
expect(listIssues).toHaveBeenCalledTimes(1);
await nonOwner.poll("gh");
expect(nonOwnerListIssues).not.toHaveBeenCalled();
const firstPoll = h.poll("gh");
await h.poll("gh");
releaseList();
await firstPoll;
expect(overlapListIssues).toHaveBeenCalledTimes(1);
```
- [x] **Step 2: Run the tests to verify they fail**

Run: bun test src/server/triggers.test.ts ui/src/api.test.ts ui/src/triggers.test.ts
Expected: FAIL because the routes, poll action, and rule display do not exist.

- [x] **Step 3: Extend the hook handler**

Keep the 1 MiB body limit and signature-before-parse order. For GitHub, accept X-Hub-Signature-256 with its sha256= prefix and require X-GitHub-Event: issues. For Forgejo, accept X-Forgejo-Signature or X-Gitea-Signature and require X-Forgejo-Event: issues. A non-issues event is a quiet 200. A source without secretEnv has no hook and answers 404.

- [x] **Step 4: Add source readers and the cron poller**

For each configured label, request the oldest 50 open issues from GitHub with `gh issue list --label <label> --state open --search "sort:created-asc" --limit 50 --json number,title,body,labels,createdAt,updatedAt`. For Forgejo use `GET /api/v1/repos/{o}/{r}/issues?labels=<label>&state=open&sort=oldest&limit=50&page=1`. Verify that Forgejo accepts the label name and returns the oldest page; if it does not, paginate until all matching candidates are read before sorting. Merge label results by issue number, sort the union by createdAt, and process no more than 50 issues for the rule. The list reader sorts and caps before returning Incoming[]; it does not rely on Incoming carrying a timestamp. Use `gh issue view` or the Forgejo detail and comments endpoints to fill each issue note. Resolve Forgejo source tokens by matching the local repo remote to a configured Forgejo source. Run scheduled polls on the flows-lock holder only and keep one in-flight poll per rule. Skip existing issues through existing and pass new items through the same detail reader and deliver path as hooks. Report list or detail read failures through the canopy:triggers health check and keep them out of events.

- [x] **Step 5: Add poll-now route and rule display**

Add POST /api/triggers/poll {rule}; the existing callers rule for triggers/* already requires operate. Add nextFire to rule info. The trigger card shows the hook path when secretEnv exists, shows "polls every 15 min" when the default poll replaces the hook, shows any explicit cron, and offers "poll now" beside "try it" when the rule has a poll.

- [x] **Step 6: Run the tests to verify they pass**

Run: bun test src/server/triggers.test.ts ui/src/api.test.ts ui/src/triggers.test.ts
Expected: PASS, including the lock and overlap cases.

- [x] **Step 7: Run typecheck**

Run: bun run typecheck
Expected: PASS.

- [x] **Step 8: Run lint**

Run: bun run lint
Expected: PASS.

- [x] **Step 9: Run the full test suite**

Run: bun test
Expected: PASS.

- [x] **Step 10: Build**

Run: bun run build
Expected: PASS.

- [x] **Step 11: Commit**

~~~sh
git add src/server/triggers.ts src/server/triggers.test.ts src/server/index.ts ui/src/api.ts ui/src/api.test.ts ui/src/store.ts ui/src/triggers.ts ui/src/triggers.test.ts ui/src/components/Triggers.tsx
git commit -m "feat(triggers): receive and poll issue sources"
~~~

### Task 4: Bundle issue-fix and route Forgejo work through the queue

**Files:**
- Create lib/workflows/issue-fix.md
- Modify src/core/workflow.test.ts:147-155, 227-239
- Modify src/core/trigger.ts:647-667
- Modify src/core/trigger.test.ts:575-589
- Modify src/server/index.ts:1281-1311, 5162-5167
- Modify src/server/triggers.ts:447-471
- Modify src/server/triggers.test.ts:211-313

**Interfaces:**
- Consumes: TriggerEvent.service, triggerPlan, and the existing startBranchRun/cutBranch behavior from server/index.ts.
- Produces the shared landing interface: fromLanding(e: TriggerEvent, notices: readonly LandNotice[], entries: readonly LandEntry[] = []): TriggerEvent and TriggerHub.onLanding(notices: readonly LandNotice[], entries?: readonly LandEntry[]): void. This accepts existing notice-only callers and the planned spec-converge-1 entries argument; either plan can land first.
- Produces: a bundled workflow named issue-fix with listed: false; github events start with openPr true; forgejo events start with openPr false; a Forgejo event whose branch has a LandEntry with state landed moves from ready to merged.

- [x] **Step 1: Write failing tests** proving issue-fix parses as a bundled workflow and is unlisted; GitHub starts through the PR path; Forgejo starts without openPr; a Forgejo ready event becomes merged when entries contain its landed branch, including manual and automatic land; a landed notice also merges through the hub callback; held notices continue to set the existing reason. Import LandEntry from core/types.ts for the entry fixture. Seed separate hubs with ready Forgejo events for the entry and notice callback assertions.

```ts
const landed: LandEntry = { id: "br1", repoId: "web/shop", repoPath: "/dev/web/shop", branch: "run/fix", target: "main", dir: "/tmp/run", note: "fix", state: "landed", tries: 0, queuedAt: 1, updatedAt: 9, landedAt: 9 };
expect(fromLanding(event({ service: "forgejo", status: "ready", branch: "br1" }), [], [landed])).toMatchObject({ status: "merged", endedAt: 9 });
expect(fromLanding(event({ service: "forgejo", status: "ready", branch: "br1" }), [], [{ ...landed, auto: true }]).status).toBe("merged");
expect(fromLanding(event({ service: "forgejo", status: "ready", branch: "br1" }), [notice({ kind: "landed", at: 11 })])).toMatchObject({ status: "merged", endedAt: 11 });
entryHub.onLanding([], [landed]);
expect(entryHub.list()[0]?.status).toBe("merged");
noticeHub.onLanding([notice({ kind: "landed", at: 11 })]);
expect(noticeHub.list()[0]).toMatchObject({ status: "merged", endedAt: 11 });
```
- [x] **Step 2: Run the tests to verify they fail**

Run: bun test src/core/workflow.test.ts src/core/trigger.test.ts src/server/triggers.test.ts
Expected: FAIL because issue-fix and source-specific landing behavior are absent.

- [x] **Step 3: Add lib/workflows/issue-fix.md**

Copy the one-step tool allowlist and gate instructions from linear-issue. State that the run first checks the issue is clear and small enough for one run; when it is not, it changes and commits nothing and names what is missing. For a suitable issue, make the smallest fix with a test, run the gates, commit on the branch, and never push.

- [x] **Step 4: Choose PR or queue from the event service**

In startTriggerRun, use event.service to keep GitHub on the existing open-PR path and give Forgejo a branch without openPr. Keep Sentry and Linear on their current PR path.

- [x] **Step 5: Observe landed queue entries**

Extend fromLanding to inspect the supplied LandEntry list for an entry whose id matches the event branch and whose state is landed, and the notices for a matching landed notice. A ready event with either signal becomes merged and clears reason, with endedAt set to entry.landedAt, then notice.at, then e.lastAt. This covers Forgejo queue lands and preserves the planned schedule trigger's landed-notice path. Preserve the newest held-notice behavior when there is no landed signal. Pass ev.landing.entries beside ev.landing.notices from the landing broadcast in server/index.ts.

- [x] **Step 6: Run the tests to verify they pass**

Run: bun test src/core/workflow.test.ts src/core/trigger.test.ts src/server/triggers.test.ts
Expected: PASS for both event routes, landed-notice-only transitions, held notices, and callers that omit entries.

- [x] **Step 7: Run typecheck**

Run: bun run typecheck
Expected: PASS.

- [x] **Step 8: Run lint**

Run: bun run lint
Expected: PASS.

- [x] **Step 9: Run the full test suite**

Run: bun test
Expected: PASS.

- [x] **Step 10: Build**

Run: bun run build
Expected: PASS.

- [x] **Step 11: Commit**

~~~sh
git add lib/workflows/issue-fix.md src/core/workflow.test.ts src/core/trigger.ts src/core/trigger.test.ts src/server/index.ts src/server/triggers.ts src/server/triggers.test.ts
git commit -m "feat(triggers): route forgejo issue work to landing"
~~~

### Task 5: Write issue results back to GitHub and Forgejo

**Files:**
- Create src/server/forgejo.ts, src/server/forgejo.test.ts
- Modify src/server/triggers.ts:85-132, 447-577
- Modify src/server/triggers.test.ts:211-486
- Modify src/server/index.ts:5251-5282
- Modify ui/src/triggers.ts:82-94, ui/src/triggers.test.ts:43-64

**Interfaces:**
- Consumes: TriggerRule.write, tokenEnv, event linked/resolved, Forgejo path and body helpers, and onLanding from Task 4.
- Produces in src/server/forgejo.ts: forgejoComment(rule: TriggerRule, slug: string, number: number, token: string, body: string): Promise<void>; forgejoClose(rule: TriggerRule, slug: string, number: number, token: string): Promise<void>.
- GitHub callbacks use gh with the repo path and optional GH_TOKEN from tokenEnv. Forgejo chooses tokenEnv, then the token for the matching configured Forgejo source.

- [x] **Step 1: Write failing tests** for GitHub's exact "Opened #12 from run/fix." comment on a PR, "Fixed by #12." close comment after merge, and no-fix/failed comments; Forgejo POST comment and PATCH {state: "closed"} after a landing event becomes merged; write: false; absent Forgejo token; non-2xx errors; and a failed close retained as resolved.error while the next event still delivers.

```ts
expect(openedComment(12, "run/fix")).toBe("Opened #12 from run/fix.");
expect(fixedComment(12)).toBe("Fixed by #12.");
expect(h.list()[0]).toMatchObject({ resolved: { error: "Forgejo answered 401" } });
```
- [x] **Step 2: Run the tests to verify they fail**

Run: bun test src/server/forgejo.test.ts src/server/triggers.test.ts ui/src/triggers.test.ts
Expected: FAIL because the Forgejo writer and GitHub write-back paths are absent.

- [x] **Step 3: Implement the Forgejo writer**

Build URLs through core/forgejoissues.ts. Send Bearer token and JSON. Treat every non-2xx response as an error. The comment body is the supplied text; the close body is {state: "closed"}.

- [x] **Step 4: Connect write-back to event transitions**

When write is not false, comment once when a GitHub PR opens and close once when the GitHub PR merges or a Forgejo landing record lands. In onLanding, call resolveIssue after storing the Forgejo event as merged; mark the write once so duplicate broadcasts do not repeat it. For no-fix or failed, reuse issueNoteFor. Keep each service error on linked.error or resolved.error and let the hub continue to the next event. A test fire performs no writes. Use gh's login by default for GitHub; tokenEnv supplies GH_TOKEN when configured. Forgejo uses tokenEnv or readToken from the matching configured source.

- [x] **Step 5: Update the trigger outcome words**

Show GitHub and Forgejo results with their service names. Keep the existing Sentry and Linear lines unchanged.

- [x] **Step 6: Run the tests to verify they pass**

Run: bun test src/server/forgejo.test.ts src/server/triggers.test.ts ui/src/triggers.test.ts
Expected: PASS, including a refused write that leaves resolved.error on the event.

- [x] **Step 7: Run typecheck**

Run: bun run typecheck
Expected: PASS.

- [x] **Step 8: Run lint**

Run: bun run lint
Expected: PASS.

- [x] **Step 9: Run the full test suite**

Run: bun test
Expected: PASS.

- [x] **Step 10: Build**

Run: bun run build
Expected: PASS.

- [x] **Step 11: Commit**

~~~sh
git add src/server/forgejo.ts src/server/forgejo.test.ts src/server/triggers.ts src/server/triggers.test.ts src/server/index.ts ui/src/triggers.ts ui/src/triggers.test.ts
git commit -m "feat(triggers): write issue results back"
~~~

### Task 6: Add canopy issues and update project docs

**Files:**
- Create src/cli/issues.ts, src/cli/issues.test.ts
- Modify src/cli/index.ts:100-136, 855-860
- Modify src/core/help.ts:84-94
- Modify README.md:76-89, docs/architecture.md:174-190, SPEC.md:54-58, FEATURES.md:60-63

**Interfaces:**
- Consumes: GET /api/triggers and TriggerEvent from Tasks 1-5; Target helpers and ask from cli/health.ts; the output shape of canopy queue from cli/land.ts.
- Produces: canopy issues [repo] [--backend URL], listing GitHub and Forgejo events with issue, state, branch, PR, and reason columns. The --needs-you filter waits for plan 2's needsYou field.

- [x] **Step 1: Write failing tests** for empty results, GitHub and Forgejo rows, missing branch or PR, a repo filter, a backend error, and the exact issue/state/branch/PR/reason columns.
- [x] **Step 2: Run the test to verify it fails**

Run: bun test src/cli/issues.test.ts
Expected: FAIL because canopy issues is not a command.

- [x] **Step 3: Implement src/cli/issues.ts**

Read trigger info using the same backend targeting rules as canopy queue. Keep only github and forgejo events. Print issue short or key, status, branch or "-", PR number or "-", and reason or "-". Accept one repo id and --backend URL.

- [x] **Step 4: Register the command and document it**

Add issues to COMMANDS and dispatch. Add its usage line to core/help.ts and README.md. Update the triggers architecture section, the SPEC.md triggers.json state description, and the FR-035 status to say plan 1 shipped while plans 2 and 3 remain planned. After merge, change this plan's Status line to shipped with the merge commit and leave docs/superpowers/plans/README.md for the orchestrator to update in the index.

- [x] **Step 5: Run the test to verify it passes**

Run: bun test src/cli/issues.test.ts
Expected: PASS for issue rows and filtering.

- [x] **Step 6: Run typecheck**

Run: bun run typecheck
Expected: PASS.

- [x] **Step 7: Run lint**

Run: bun run lint
Expected: PASS.

- [x] **Step 8: Run the full test suite**

Run: bun test
Expected: PASS.

- [x] **Step 9: Build**

Run: bun run build
Expected: PASS.

- [x] **Step 10: Commit**

~~~sh
git add src/cli/issues.ts src/cli/issues.test.ts src/cli/index.ts src/core/help.ts README.md docs/architecture.md SPEC.md FEATURES.md
git commit -m "feat(cli): list github and forgejo issues"
~~~

## Live check, before the branch is called done

Use a disposable GitHub issue labeled canopy and a disposable Forgejo issue labeled canopy on a configured local clone. Poll both once. Confirm the GitHub event opens a PR, the Forgejo event joins the landing queue, a manual land moves its event to merged, and each service gets the exact comment and close action. Confirm a rule with no secretEnv shows polling and returns 404 from its hook path. Inspect the PR-watch diff and confirm it has no changed file.

## Decisions this plan makes beyond the spec

- Use gh's login for GitHub comments and closes by default, with tokenEnv as the explicit GH_TOKEN override, following the spec's recommendation.
- Fetch issue details and comments through the source API after a hook or list result because those payloads do not carry the newest 10 comment bodies required by the run note.
- Keep canopy issues to the base listing in this plan. The spec lists --needs-you on the CLI while assigning needsYou to plan 2, so that flag ships with plan 2.
- The spec's Forgejo polling probe names labels=canopy but does not confirm that the target Forgejo accepts a label name or sort and pagination values in that request. The implementation task should verify the configured instance's endpoint before relying on that query; resolve label names to IDs if the endpoint requires IDs.
- A hook or poll result may not carry the newest comment bodies required by the issue note. Treat a detail-read failure as an intake failure: report it through canopy:triggers and create no partial event.

## What the review changed (fix pass, 2026-10-27)

The whole-branch review found four Important paths, fixed on the branch before merge. Each revises a line above or in the spec; plan 2's spec edit should carry them:

- A poll dedupes against any event (`anyEvent`), not the spec's `existing`: a listing only says the issue is still labelled, so a failed, closed or ignored issue would start over every tick. The readers list up to `LIST_ISSUES` (500) and the hub drops known issues before it reads the oldest `POLL_ISSUES` (50), so fifty known labelled issues in front no longer hide a new one.
- A Forgejo hook delivery dedupes against any event too (`knownEvent`): `label_updated` lists every label the issue has, not the one that changed. The spec's Intake section and probe P4 say `existing`; GitHub keeps `existing`, since `labeled` names the label put back on.
- The detail-read decision above is reversed for hooks: a delivery whose full read fails starts from its own title and body with "comments: not read" in the fence, since neither forge resends a failed delivery and a rule with a secret has no default poll. A poll's failed read still waits for the next tick.
- A Forgejo issue is still closed when its branch lands (the spec's "landed is the merge"), and the close names the landed commit and, after one fetch, the remote that still lacks it, since the landing queue never pushes. Closing only once the remote has the commit is a plan 2 call.
