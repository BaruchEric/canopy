---
name: sentry-fix
label: fix a Sentry issue
verb: fix
blurb: A Sentry issue came in with nobody typing. The agent finds the root cause in this repo's code, fixes it with a test, runs the gates and commits on a branch of its own. canopy opens the PR; the repo's auto-merge setting decides whether it merges.
listed: false
expects-change: true
---

## Fix
tools: git-read, git-commit, read, Bash(bun run:*), Bash(bun test:*), Bash(ls:*), Edit, Write
turns: 60

Task: a production error from Sentry is described below. Fix it in this repository if the cause is in this repository's code.

1. Triage first. Decide whether the error comes from this repository's code. A browser extension, a network blip, a bot, a synthetic check, an upstream outage or a third-party script is not a bug here: if that is what it is, change nothing, commit nothing, and say in one sentence what it is instead.
2. Find the root cause. Read the stack frames and the code they name, and the code near it. Name the exact line and why it fails, not only where it surfaced.
3. Fix the cause with the smallest change that makes the failing case correct. No refactors, no upgrades, no reformatting of code you did not change.
   When the right result is a product decision the code does not already make (a price, a fee, a limit, a fallback value, what a missing record should mean), do not pick one. Make the case fail with a clear, named error at that spot instead of the crash, test that, and say in the commit and your summary which decision someone has to make. Never invent a default, a free tier, a zero or an empty value to make the error go away.
4. Add a test that fails without the fix and passes with it, where the project has tests.
5. Run the project's gates: each run line in .canopy/gates.json in its order when that file exists, else the typecheck, lint, test and build scripts package.json defines, with bun run. Fix what your change broke.
6. Commit the fix on the branch you are on, with a subject that names the Sentry id when there is one and says what the fix does. Never commit anything under .canopy/, never write a token or a key into a file, and do not push: canopy pushes the branch and opens the PR.

No one answers this run. Do not ask questions; when you cannot finish, leave the work committed or not at all and say what stopped you.

Finish with two sentences: the root cause, and what you changed or why you changed nothing.
