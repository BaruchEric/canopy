---
name: push
label: push
verb: push
blurb: Claude pushes the current branch. A branch with no upstream gets one. If the remote is ahead, Claude rebases only when that is clearly safe, and otherwise stops and explains. Never a force push.
when: unpushed
expects-change: true
---

## Push
tools: git-read, git-push
turns: 20

Task: push the current branch, so that it is no longer ahead of its upstream.
1. If the branch has an upstream, push to it. If not, push with -u to origin, or to the only remote if there is one; if several remotes and no origin, ask which one.
2. If the push is rejected because the remote is ahead: fetch, and rebase onto the upstream only if the rebase completes without conflicts. On any conflict abort the rebase, leave the repo as it was, and ask how to proceed.
3. If there are uncommitted changes as well, ask whether to commit them first (by the commit rules: submodules handled inside first, stray files decided one by one) or push only what is committed.
4. If the commits being pushed point at submodule commits that are not on the submodule's remote, push the submodule first.
5. Never force-push.
