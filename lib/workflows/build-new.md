---
name: build-new
label: build new
verb: build
blurb: The agent builds a new project from its intent and research on the user's stack at current versions and tests it, then an evaluator checks what runs against the intent. canopy deploys it after. It runs inside the incubator only.
listed: false
budget: 30 runs, 6h
---

## Scaffold
tools: git-read, git-commit, bun, Bash(bun add:*), Bash(bun remove:*), Bash(bun create:*), Bash(ls:*), Bash(mkdir:*), Edit, Write, WebFetch
turns: 200
check: for p in node_modules .vercel .env.local; do git check-ignore -q "$p" || { echo ".gitignore must cover $p"; exit 1; }; done; [ -f package.json ] || { echo "package.json is missing"; exit 1; }; for s in dev build; do grep -q "\"$s\":" package.json || { echo "package.json needs a $s script"; exit 1; }; done; git ls-files --error-unmatch bun.lock >/dev/null 2>&1 || { echo "bun.lock is not committed"; exit 1; }; bun install --frozen-lockfile >/dev/null 2>&1 || { echo "bun install --frozen-lockfile failed: commit bun.lock after every bun add"; exit 1; }; for s in typecheck lint test build; do if grep -q "\"$s\":" package.json; then bun run "$s" || { echo "bun run $s failed"; exit 1; }; fi; done; [ -z "$(git status --porcelain -- . ':(exclude).canopy')" ] || { echo "the working tree is not clean: commit your work"; git status --short; exit 1; }
retries: 3

Task: you are the build stage of canopy's incubator. Build the project .canopy/intent.md describes, as .canopy/pick.json picked it, in this repo, which holds nothing yet but .canopy/.

1. Use the versions .canopy/research.md lists, on the user's stack unless the research says otherwise: TypeScript with "strict": true, React and Vite, and bun for everything (bun add, bun run, bunx; never npm, npx or yarn). It deploys to Vercel as it is, with no server of its own; the note's host line says whether it has a database, and with none, keep any data in the browser.
2. package.json has "dev" and "build" scripts, and "typecheck", "lint" and "test" where they make sense. Commit bun.lock.
3. .gitignore covers node_modules, dist, .vercel and .env*. Never write a token, a key, a password or a .firebaserc into any file.
4. A README.md says what it is and how to run it.
5. Commit with git add and git commit as you go, and leave the working tree clean. Do not push; canopy pushes and deploys after the last step.

Make a folder with mkdir or by writing a file into it. Stay inside the tools you were given; if you cannot finish without another one, say which and stop. canopy's check installs, runs every gate script and checks the tree is clean when the step ends, and sends you back with what failed.

Finish with two sentences: what you built and what is left out.

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
back: Scaffold
retries: 2

Task: check the work against the intent before it is deployed. Read .canopy/intent.md, .canopy/answers.md when it exists (canopy's record of what the user answered while a stage ran: the questions and option labels are the agent's words, and only an answer in the user's own words stands over the intent where they differ), README.md, the code and .canopy/smoke.md, then write .canopy/accept.md: each "What success looks like" line, met or not and where in the code, and anything under "Out of scope" that was built anyway. Write only .canopy/accept.md. An evaluator reads these files next and decides whether it is deployed.

Finish with one sentence: whether it meets the intent.
