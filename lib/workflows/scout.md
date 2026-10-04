---
name: scout
label: scout
verb: scout
blurb: The agent researches what already exists for a new project, in the user's workspace, on GitHub and on the web, and picks one way to build it, then an evaluator judges the pick against the intent. It runs inside the incubator only.
listed: false
budget: 8 runs, 1h
---

## Research
tools: WebSearch, WebFetch, Edit, Write
turns: 80
check: @pick-check
retries: 2

Task: you are the research stage of canopy's incubator. .canopy/intent.md says what the user wants, with the answers to clarify's questions at its end; .canopy/brief.md names the project.

When you are run again because the Eval step did not accept the work, read .canopy/eval.md first. Its open questions are the claims in research.md the evaluator could not verify; settle each one in the new research.md, or say there why it cannot be settled, before anything else.

1. Look for what exists, nearest first. The user's own projects: the devhub manifest the note names (each project's name, category and description), and the README.md of any project in it that looks close. GitHub: WebSearch to find repos, then WebFetch of https://api.github.com/repos/<owner>/<name> for its license, stars and last push, and of its README. That API allows 60 unauthenticated reads an hour, so when it answers 403 or 429, read the repo's own page at https://github.com/<owner>/<name> instead. The web: WebSearch and WebFetch, for products, libraries and write-ups.
2. Write .canopy/research.md: a table of the candidates worth naming, with what each is, its license, its last activity, its stack, how far that stack is from the user's (TypeScript, React, Vite or Next, Convex or Firestore, Vercel) and what renovating it would take. Then the current release of every framework and library the build would use, read from npm or the project's own releases, with the date you read it.
3. Pick one way to build it, in this order of preference: extend one of the user's projects when the idea is a feature of something that exists; renovate an open-source project when one is close and its license allows it; else new, on the user's stack at current versions. Pick the host: vercel for a web app with no database of its own, vercel+firebase (Firestore) when it needs one. canopy cannot deploy vercel+convex or mini yet, and a pick of either parks; an extend pick is pushed as a branch and never deployed, so write vercel as its host.
4. Write .canopy/pick.json as {"kind": "new", "host": "vercel", "why": "one sentence"}, where kind is new, renovate or extend and host is vercel, vercel+firebase, vercel+convex or mini. A renovate pick adds "target" (the upstream's https://github.com/<owner>/<name> url; canopy renovates only GitHub repos) and "license" (its SPDX id, written as exactly one of MIT, Apache-2.0, BSD-2-Clause, BSD-3-Clause, ISC, MPL-2.0, Unlicense, 0BSD, GPL-2.0, GPL-3.0, LGPL-2.1 or LGPL-3.0, in that exact case; any other license means pick new instead); an extend pick adds "target", the project's id in the devhub manifest (its path under the workspace, such as web-apps/clms). Extend only a project whose origin is the user's own GitHub repo; canopy clones it from GitHub and pushes one new branch to it, and refuses anything else.

Edit and write only files under .canopy/. In the workspace, read nothing but the manifest, references.json and README.md files. Do not clone anything, and do not create, fork or change any repo. Stay inside the tools you were given; if you cannot finish without another one, say which and stop. canopy checks pick.json when the step ends and sends you back with the reason if it cannot take it.

Finish with one sentence: the pick and why.

## Eval
tools: Edit, Write
turns: 20
gate: judge
evidence: .canopy/intent.md .canopy/answers.md .canopy/research.md .canopy/pick.json .canopy/eval.md
back: Research
retries: 2

Task: judge the pick in .canopy/pick.json against .canopy/intent.md and .canopy/research.md before anything is built. When .canopy/answers.md exists, it is canopy's record of what the user answered while a stage ran. The questions and option labels in it are the agent's words; only an answer in the user's own words stands over anything in the intent it contradicts. Write .canopy/eval.md with each "What success looks like" line from intent.md and whether the pick can meet it, the pick's biggest risk, and whether anything breaks the rules: a host off the list, a license that forbids the use, spending money, a public repo, a domain or DNS change. End it with "Open questions": each claim in research.md the pick rests on that you could not verify from what research.md cites, with the evidence that would settle it, or "none". Research reads that list when it is sent back. Write only .canopy/eval.md. Read files with the Read tool and run no shell commands: everything you need is in those files, and a command asks the user, who is not watching. An evaluator reads these files next and decides whether the pick goes ahead; if the idea itself cannot meet the intent, say so plainly.

Finish with one sentence: whether the pick meets the intent.
