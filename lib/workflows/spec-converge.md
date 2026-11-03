---
name: spec-converge
label: converge SPEC.md with the code
verb: converge
blurb: One step reads SPEC.md's seven sections against the repo and reports what no longer holds, changing nothing. The next makes each named line true, touching only those lines, and commits on a branch of its own; the repo's gates must pass before the branch goes on. Nothing is pushed. A schedule rule runs it weekly; the branch then waits for a look, since SPEC.md is what every agent reads first.
when: any
expects-change: true
---

## Check
tools: git-read, read, Bash(ls:*), Bash(bun pm ls:*), Bash(cat:*)
turns: 40

Task: read SPEC.md and check each of its seven sections against the repository as it is. Change nothing in this step.

1. Stack and versions, against the lockfile (bun.lock, package-lock.json, Cargo.lock, go.sum, uv.lock, whichever the repo has) and the manifest. A version SPEC.md names that the lockfile does not have is drift. A runtime version (Bun, Node, Rust) is checked against what the repo pins (.tool-versions, mise.toml, .nvmrc, engines), and left alone when it pins nothing.
2. How it is built and run, against package.json's scripts, a Makefile, a justfile or Cargo.toml. A command SPEC.md lists that no longer exists is drift, and so is a script every agent needs (test, build, typecheck, lint) that SPEC.md leaves out.
3. Data and state, against what the code writes. Grep for the config folder, the file names and the environment variables the section names, and for writes (writeFile, Bun.write, or the language's equivalent) to paths the section does not name.
4. Decisions, against git log --since=<the date of SPEC.md's last commit, from git log -1 --format=%cI -- SPEC.md> --format='%h %s'. A commit whose subject reads like a decision (a dependency swapped, a protocol replaced, a thing removed) with no dated line for it is drift.
5. Out of scope, against the tree. A folder or a dependency that does what a line says the repo will not do is drift.
6. The file itself: under 120 lines, the seven headings in order, "none" rather than a missing section. Leave everything between the spec:begin and spec:end markers alone; it is canopy's, not the repo's.

A repository with no SPEC.md is not adopted: report that in one line, "not adopted: no SPEC.md", and nothing else.

No one answers this run. Do not ask questions. Your closing message is the report and nothing else, in this exact shape, and this shape overrides the ground rules' ask for prose: the first line is "drift: <count>" or "drift: none", then one line per item starting with "- " and the section's word (stack, commands, data, decisions, scope, shape), what SPEC.md says and what the repo has. For example:

drift: 3
- stack: SPEC.md says Vite 8.3.2, bun.lock has 8.4.0
- commands: SPEC.md lists bun run lint:fix, package.json has no such script
- decisions: 2026-10-20 "Voice runs on ElevenLabs' Realtime API" has no dated line

Nothing else about the repository goes in the message: no praise, no summary of what matched, no next steps.

## Fix
tools: git-read, git-commit, read, Edit, Write, Bash(ls:*)
turns: 40
check: @gates
retries: 1

Task: make SPEC.md true for the lines the Check step's report names, on the branch you are on.

1. If the report said "drift: none", or "not adopted", change nothing, commit nothing, and say so in one sentence. The spec workflow is what adopts a repo; this one does not write a SPEC.md from nothing.
2. Otherwise edit SPEC.md so each listed line is true. Touch only the lines the report names, and add the dated decision lines it asks for as one-liners with their why, in the form "2026-10-20: Voice runs on ElevenLabs' Realtime API, because the browser's speech API dropped words." Keep the file under 120 lines and the seven headings in their order.
3. Where README.md or CLAUDE.md repeat the same fact, fix them there too, and nowhere else.
4. Leave everything between the spec:begin and spec:end markers exactly as it is, in every file. Never change code, tests, the lockfile, anything under .canopy/, DESIGN.md or any styling: this step writes documentation only. A line in the report that would need a code change to become true is left as it is, and named in your closing sentence.
5. Commit on the branch with a subject like "docs: converge SPEC.md with the code" and a body that lists the lines you changed. Never commit anything under .canopy/, never write a token or a key into a file, and do not push: the branch lands through canopy, where someone looks at the diff first.

No one answers this run. Do not ask questions; when you cannot finish, leave the work committed or not at all and say what stopped you.

Finish with two sentences: which lines you made true, and anything in the report you left alone and why.
