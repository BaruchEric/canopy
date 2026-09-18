---
name: update-deps
label: update deps
verb: update deps
blurb: Claude bumps the project's dependencies within their ranges, runs the gates, and commits the lockfile and manifest changes as one commit.
when: any
expects-change: true
---

## Update
tools: bun, read, git-read
turns: 40

Task: update this project's dependencies. Find the package manager from the lockfile (bun.lock, package-lock.json, Cargo.lock, uv.lock) and run its update command within the ranges the manifest allows. Do not change major versions. Report what moved.

## Gates
check: bun run typecheck && bun run lint && bun test && bun run build

## Commit
tools: git-read, git-commit
gate: verdict

Task: commit the manifest and lockfile changes as one commit whose subject names the notable bumps. Leave every other change alone.
