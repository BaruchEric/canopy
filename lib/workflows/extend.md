---
name: extend
label: extend
verb: extend
blurb: The agent builds a feature into one of the user's own projects, on a new branch of a clone canopy made, and tests it, then an evaluator checks the change against the intent. canopy pushes the branch after; it never merges or deploys. It runs inside the incubator only.
listed: false
budget: 20 runs, 4h
---

## Build
tools: git-read, git-commit, bun, Bash(bun add:*), Bash(bun remove:*), Bash(ls:*), Bash(mkdir:*), Edit, Write, WebFetch
turns: 200
check: b=$(git symbolic-ref --short HEAD 2>/dev/null); case "$b" in new/*) ;; *) echo "stay on the branch canopy made (new/...); HEAD is on ${b:-no branch}"; exit 1;; esac; if [ -f bun.lock ]; then bun install --frozen-lockfile >/dev/null 2>&1 || { echo "bun install --frozen-lockfile failed: commit bun.lock after every bun add"; exit 1; }; fi; if [ -f package.json ]; then for s in typecheck lint test build; do if grep -q "\"$s\":" package.json; then bun run "$s" || { echo "bun run $s failed"; exit 1; }; fi; done; fi; [ -z "$(git status --porcelain -- . ':(exclude).canopy')" ] || { echo "the working tree is not clean: commit your work"; git status --short; exit 1; }
retries: 3

Task: you are the extend stage of canopy's incubator. This repo is a clone of one of the user's own projects, on a branch canopy made for this work. .canopy/intent.md says what the user wants added to it, and .canopy/research.md what the research found.

1. Read the project first: its README.md, any CLAUDE.md or AGENTS.md, and the code near what you change. Follow its conventions, its stack and its package manager as they are.
2. Build what "What success looks like" in .canopy/intent.md asks for, as a change to this project, and nothing under "Out of scope". Keep the change as small as the intent allows: no rewrites, no upgrades it does not need, no reformatting of code you did not change.
3. Add or update tests for what you changed where the project has tests.
4. Commit with git add and git commit on the branch you are on, and leave the working tree clean. Never commit anything under .canopy/ (git does not see those files; do not force them in), never switch or make branches, and do not push: canopy pushes this branch to the user's repo after the last step, and the user merges it or not.
5. Never write a token, a key or a password into any file.

The note's host line says what canopy does with the branch. Stay inside the tools you were given; if you cannot finish without another one, say which and stop. canopy's check runs every gate script the project has and checks the tree is clean when the step ends, and sends you back with what failed.

Finish with two sentences: what you changed and what is left out.

## Test
tools: git-read, git-commit, bun, Bash(bun add:*), Bash(curl:*), Bash(ls:*), KillShell, Edit, Write
turns: 120
check: if [ -f package.json ]; then for s in typecheck lint test build; do if grep -q "\"$s\":" package.json; then bun run "$s" || { echo "bun run $s failed"; exit 1; }; fi; done; fi; [ -s .canopy/smoke.md ] || { echo ".canopy/smoke.md must say how the change was tried and what it did"; exit 1; }; [ -z "$(git status --porcelain -- . ':(exclude).canopy')" ] || { echo "the working tree is not clean: commit your fixes"; git status --short; exit 1; }
retries: 3

Task: make sure the change works in the project.

1. Run every gate script package.json has (typecheck, lint, test, build) and fix what fails.
2. Try the change the way the project is used: for a web app, start it with its dev script as a background command on a free port from 4317 to 4399, fetch the page the change is on with curl, then stop it; for a library or a command, run its tests or the command.
3. Write .canopy/smoke.md: how you tried it, what it answered (for a web app, the HTTP status first), and how each "What success looks like" line in .canopy/intent.md can be seen.
4. Commit every fix and leave the tree clean. Do not push.

Stay inside the tools you were given; if you cannot finish without another one, say which and stop.

Finish with one sentence: whether the change works.

## Accept
tools: git-read, Edit, Write
turns: 20
gate: judge
evidence: .canopy/intent.md .canopy/answers.md .canopy/pick.json .canopy/smoke.md .canopy/accept.md README.md
back: Build
retries: 2

Task: check the change against the intent before canopy pushes its branch to the user's repo. Read .canopy/intent.md, .canopy/answers.md when it exists (canopy's record of what the user answered while a stage ran: the questions and option labels are the agent's words, and only an answer in the user's own words stands over the intent where they differ), the commits on this branch (git log and git show), the code they touch and .canopy/smoke.md, then write .canopy/accept.md: each "What success looks like" line, met or not and where in the change, anything under "Out of scope" that was changed anyway, and anything the change breaks or rewrites that it did not need to. Write only .canopy/accept.md. An evaluator reads these files next and decides whether the branch is pushed.

Finish with one sentence: whether the change meets the intent.
