---
name: spec
label: adopt spec
verb: adopt the spec
blurb: canopy writes the shared repo spec's blocks into this repo (SPEC.md, the AGENTS.md or CLAUDE.md pointer, and DESIGN.md when the repo took the visual half), the agent fills in a new SPEC.md's sections from the code, you look it over, and it is committed. Nothing is pushed and no existing screen is restyled. The visual half is opt-in: canopy spec sync <repo> --visual.
when: any
expects-change: true
---

## Sync
check: "$CANOPY_CLI" spec sync .

## Fill
tools: git-read, read, Edit, Write
turns: 40
gate: ask
check: "$CANOPY_CLI" spec check .
retries: 1

Task: canopy has just written the shared repo spec into this repo. Make SPEC.md true for this repo.
1. Read SPEC.md. Leave everything between the spec:begin and spec:end markers exactly as it is, in every file.
2. Fill each of the seven sections that is still empty or a placeholder, from what the repo shows: the README, the manifest and lockfile, the build and test scripts, CLAUDE.md or AGENTS.md. Sections 1, 3 and 4 must not be empty; write "none" in any other section the repo gives you nothing for. Keep the whole file under 120 lines.
3. Sections someone already wrote stay as they are, unless they contradict the code; then fix only that line.
4. Do not change code, DESIGN.md, or any styling. Do not commit.

Finish with one line per section saying where its content came from.

## Commit
tools: git-read, git-commit
check: "$CANOPY_CLI" spec check .

Task: commit the spec adoption, so git status shows none of it afterwards.
1. Stage SPEC.md, AGENTS.md, CLAUDE.md, DESIGN.md and .canopy/spec.json, whichever changed. If git ignores .canopy/, leave spec.json out rather than forcing it in.
2. Leave any other change in the working tree alone; it is not part of this.
3. Match the style of recent messages (git log --oneline -15), for example "docs: adopt shared repo spec v1.0.0".
4. Do not push.
