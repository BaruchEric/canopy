---
name: commit
label: commit
verb: commit
blurb: Claude reads the diff, stages what belongs, writes the message in this repo's style and commits. Unrelated changes become separate commits. Nothing is pushed.
when: dirty
expects-change: true
---

## Commit
tools: git-read, git-commit

Task: commit the current changes, so that git status is clean afterwards.
1. Look at git status and the full diff, including untracked files.
2. If an entry in git status is a submodule (git status --porcelain=v2 marks it with an S field, or git diff --submodule shows it), handle it inside the submodule first: go into its directory and commit there by the same rules (and when this task pushes, push the submodule before pushing this repo, so the pointer stays reachable), then stage the updated pointer in this repo and commit that. Untracked or modified content inside a submodule is a change to deal with, not a reason to stop.
3. For each file you would not commit on your own (build output, a stray backup, an editor file, something that looks accidental), ask with AskUserQuestion what to do with it: commit it, add it to .gitignore and commit that, delete it, or leave it. Do what the user picks. Skip the question only if the user's note already decided.
4. Stage what belongs together. If the changes are clearly unrelated, make more than one commit, each with its own coherent set of files. Otherwise make one.
5. Match the style of recent messages (git log --oneline -15): imperative subject under 65 characters, optional body explaining why.
6. Do not push.
