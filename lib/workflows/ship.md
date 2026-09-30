---
name: ship
label: ship
verb: ship
blurb: The agent runs the project's gates, commits the changes the way the commit workflow does, then pushes the branch the way push does. A failing gate stops it before anything is committed.
when: dirty-or-unpushed
expects-change: true
---

## Gates
tools: bun, read
turns: 40
check: [ ! -f package.json ] || for s in typecheck lint test build; do grep -q "\"$s\"" package.json && { bun run "$s" || exit 1; }; done; exit 0

Task: run this project's own gates (typecheck, lint, tests, build, in whatever form the project defines them; look at package.json scripts, a Makefile, or CLAUDE.md). If a gate fails and the fix is obvious and inside this repo, fix it and run the gates again. Otherwise stop and say exactly what failed. Do not commit anything in this step. The check that runs after you does the same thing for a package.json project, running whichever of the typecheck, lint, test and build scripts that file defines.

## Commit
tools: git-read, git-commit
gate: verdict

Task: commit the current changes, so that git status is clean afterwards.
1. Look at git status and the full diff, including untracked files.
2. If an entry in git status is a submodule (git status --porcelain=v2 marks it with an S field, or git diff --submodule shows it), handle it inside the submodule first: go into its directory and commit there by the same rules (and when this task pushes, push the submodule before pushing this repo, so the pointer stays reachable), then stage the updated pointer in this repo and commit that. Untracked or modified content inside a submodule is a change to deal with, not a reason to stop.
3. For each file you would not commit on your own (build output, a stray backup, an editor file, something that looks accidental), ask with AskUserQuestion what to do with it: commit it, add it to .gitignore and commit that, delete it, or leave it. Do what the user picks. Skip the question only if the user's note already decided.
4. Stage what belongs together. If the changes are clearly unrelated, make more than one commit, each with its own coherent set of files. Otherwise make one.
5. Match the style of recent messages (git log --oneline -15): imperative subject under 65 characters, optional body explaining why.
6. Do not push.

## Push
tools: git-read, git-push
turns: 20

Task: push the current branch, so that it is no longer ahead of its upstream.
1. If the branch has an upstream, push to it. If not, push with -u to origin, or to the only remote if there is one; if several remotes and no origin, ask which one.
2. If the push is rejected because the remote is ahead: fetch, and rebase onto the upstream only if the rebase completes without conflicts. On any conflict abort the rebase, leave the repo as it was, and ask how to proceed.
3. If there are uncommitted changes as well, ask whether to commit them first (by the commit rules: submodules handled inside first, stray files decided one by one) or push only what is committed.
4. If the commits being pushed point at submodule commits that are not on the submodule's remote, push the submodule first.
5. Never force-push.
