---
name: renovate
label: renovate
verb: renovate
blurb: The agent renovates the open-source project scout picked, cloned into the seed by canopy, onto the user's stack at current versions and toward the intent, and tests it, then an evaluator checks what runs against the intent. canopy deploys it after. It runs inside the incubator only.
listed: false
budget: 30 runs, 6h
---

## Renovate
tools: git-read, git-commit, bun, Bash(bun add:*), Bash(bun remove:*), Bash(bun create:*), Bash(ls:*), Bash(mkdir:*), Edit, Write, WebFetch
turns: 200
check: for p in node_modules .vercel .env.local; do git check-ignore -q "$p" || { echo ".gitignore must cover $p"; exit 1; }; done; [ -f package.json ] || { echo "package.json is missing"; exit 1; }; for s in dev build; do grep -q "\"$s\":" package.json || { echo "package.json needs a $s script"; exit 1; }; done; git ls-files --error-unmatch bun.lock >/dev/null 2>&1 || { echo "bun.lock is not committed"; exit 1; }; bun install --frozen-lockfile >/dev/null 2>&1 || { echo "bun install --frozen-lockfile failed: commit bun.lock after every bun add"; exit 1; }; for s in typecheck lint test build; do if grep -q "\"$s\":" package.json; then bun run "$s" || { echo "bun run $s failed"; exit 1; }; fi; done; [ -z "$(git status --porcelain -- . ':(exclude).canopy')" ] || { echo "the working tree is not clean: commit your work"; git status --short; exit 1; }
retries: 3

Task: you are the renovate stage of canopy's incubator. This repo is a clone of the open-source project .canopy/pick.json names (its remote is called upstream); .canopy/intent.md says what the user wants from it and .canopy/research.md what renovating it takes.

1. Bring it onto the user's stack at the versions .canopy/research.md lists, as far as the research says it should go: TypeScript with "strict": true, React and Vite or Next, and bun for everything (bun add, bun run, bunx; never npm, npx or yarn). Replace a lockfile of another package manager with bun.lock.
2. Change it toward the intent: what "What success looks like" in .canopy/intent.md asks for, and nothing under "Out of scope".
3. Keep the upstream's LICENSE file and its copyright lines as they are. README.md says what this is, that it is a renovation of the upstream (name and url), and how to run it.
4. package.json has "dev" and "build" scripts, and "typecheck", "lint" and "test" where they make sense. Commit bun.lock.
5. .gitignore covers node_modules, dist, .vercel and .env*. Never write a token, a key or a password into any file.
6. Commit with git add and git commit as you go, and leave the working tree clean. Do not push; canopy pushes to a private repo of the user's and deploys after the last step.

The note's host line says what the host gives the project. Stay inside the tools you were given; if you cannot finish without another one, say which and stop. canopy's check installs, runs every gate script and checks the tree is clean when the step ends, and sends you back with what failed.

Finish with two sentences: what you changed and what is left out.

## Test
tools: git-read, git-commit, bun, Bash(bun add:*), Bash(curl:*), Bash(ls:*), KillShell, Edit, Write
turns: 120
check: for s in typecheck lint test build; do if grep -q "\"$s\":" package.json; then bun run "$s" || { echo "bun run $s failed"; exit 1; }; fi; done; grep -q '^status: 2' .canopy/smoke.md 2>/dev/null || { echo ".canopy/smoke.md must start with the status the running app answered, a 2xx"; exit 1; }; [ -z "$(git status --porcelain -- . ':(exclude).canopy')" ] || { echo "the working tree is not clean: commit your fixes"; git status --short; exit 1; }
retries: 3

Task: make sure the project runs.

1. Run every gate script package.json has (typecheck, lint, test, build) and fix what fails.
2. Start the app with "bun run dev --port 4317 --strictPort" as a background command (if the port is taken, the next free one up to 4399), fetch it with curl, then stop that background command.
3. Write .canopy/smoke.md: a first line "status: <the HTTP status>", then the page's title and the first lines of visible text, then how each "What success looks like" line in .canopy/intent.md can be seen in the running app.
4. Commit every fix and leave the tree clean. Do not push.

Stay inside the tools you were given; if you cannot finish without another one, say which and stop.

Finish with one sentence: whether it runs.

## Accept
tools: Edit, Write
turns: 20
gate: judge
evidence: .canopy/intent.md .canopy/answers.md .canopy/pick.json .canopy/smoke.md .canopy/accept.md README.md
back: Renovate
retries: 2

Task: check the work against the intent before it is deployed. Read .canopy/intent.md, .canopy/answers.md when it exists (what the user answered while a stage ran, which stands over the intent where they differ), README.md, the code and .canopy/smoke.md, then write .canopy/accept.md: each "What success looks like" line, met or not and where in the code, anything under "Out of scope" that was built anyway, and whether the upstream's LICENSE and credit are still there. Write only .canopy/accept.md. An evaluator reads these files next and decides whether it is deployed.

Finish with one sentence: whether it meets the intent.
