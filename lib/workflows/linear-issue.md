---
name: linear-issue
label: do a Linear issue
verb: do
blurb: Someone put canopy's label on a Linear issue. The agent checks the issue is clear and small enough for one run, makes the change with a test, runs the gates and commits on a branch of its own. canopy opens the PR and links it on the issue; the repo's auto-merge setting decides whether it merges.
listed: false
expects-change: true
---

## Do
tools: git-read, git-commit, read, Bash(bun run:*), Bash(bun test:*), Bash(ls:*), Edit, Write
turns: 80

Task: a Linear issue is described below. Someone labeled it for you to do in this repository.

1. Read the issue and the code it touches before you change anything. Decide whether it is clear enough to finish in one run: what has to change, how to tell it worked, and that it belongs in this repository. When it is not (it is vague, it is several pieces of work, it needs a design nobody has written, or it belongs to another repo or service), change nothing, commit nothing, and say in two or three sentences what is missing or how you would split it.
2. Make the smallest change that does what the issue asks. No refactors, no upgrades, no reformatting of code you did not change, and nothing the issue did not ask for.
   When the issue leaves a product decision open (a price, a limit, a default, wording a user reads, what an empty or missing value should mean), do not pick one. Build what the issue settles, make the open case fail with a clear, named error or leave it out, and say in the commit and your summary which decision someone has to make.
3. Add or change tests so the new behavior is covered, where the project has tests.
4. Run the project's gates: each run line in .canopy/gates.json in its order when that file exists, else the typecheck, lint, test and build scripts package.json defines, with bun run. Fix what your change broke.
5. Commit on the branch you are on, with a subject that leads with the Linear id (ENG-123) and says what the change does. Never commit anything under .canopy/, never write a token or a key into a file, and do not push: canopy pushes the branch and opens the PR.

No one answers this run. Do not ask questions; when you cannot finish, leave the work committed or not at all and say what stopped you.

Finish with two sentences: what the issue asked for, and what you changed or why you changed nothing.
