---
name: sentry-triage-fix
label: triage, fix and gate a Sentry issue
verb: fix
blurb: A Sentry issue came in with nobody typing. One step reads the code and decides whether the error is this repo's and why it fails; the next fixes it with a test and commits on a branch of its own, and the repo's gates must pass before the branch goes on, or the fix is sent back with what failed. canopy opens the PR; the repo's auto-merge setting decides whether it merges.
listed: false
expects-change: true
---

## Triage
tools: git-read, read, Bash(ls:*)
turns: 30

Task: a production error from Sentry is described below. Read; change nothing in this step.

1. Decide whether the error comes from this repository's code. A browser extension, a network blip, a bot, a synthetic check, an upstream outage or a third-party script is not a bug here.
2. If it is this repository's, find the root cause. Read the stack frames and the code they name, and the code near it. Name the exact file and line and why it fails, not only where it surfaced.
3. Say whether the right behaviour there is already decided by the code, its tests or its docs, or whether it is a product decision (a price, a fee, a limit, a fallback value, what a missing record should mean) that no one has made.

No one answers this run. Do not ask questions. Finish with three short lines: "ours" or "not ours: <what it is>", the root cause with its file and line, and "decided: <the behaviour>" or "undecided: <the decision someone has to make>".

## Fix
tools: git-read, git-commit, read, Bash(bun run:*), Bash(bun test:*), Bash(ls:*), Edit, Write
turns: 60
check: @gates
retries: 2

Task: fix the error the Triage step looked at, on the branch you are on.

1. If Triage said "not ours", change nothing, commit nothing, and say so in one sentence.
2. If the behaviour is decided, fix the root cause with the smallest change that makes the failing case correct. No refactors, no upgrades, no reformatting of code you did not change.
3. If Triage said "undecided", do not pick a behaviour. Make the case fail with a clear, named error at that spot instead of the crash, and say in the commit which decision someone has to make. Never invent a default, a free tier, a zero or an empty value to make the error go away.
4. Add a test that fails without the change and passes with it, where the project has tests.
5. Run the project's gates (each run line in .canopy/gates.json in order when that file exists, else the typecheck, lint, test and build scripts package.json defines, with bun run) and fix what your change broke. canopy runs them again after this step, and sends the step back with their output when they fail.
6. Commit on the branch, with a subject that names the Sentry id when there is one and says what the change does. Never commit anything under .canopy/, never write a token or a key into a file, and do not push: canopy pushes the branch and opens the PR.

No one answers this run. Do not ask questions; when you cannot finish, leave the work committed or not at all and say what stopped you.

Finish with two sentences: the root cause, and what you changed or why you changed nothing.
