---
name: review
label: review
verb: review
blurb: The agent reads the uncommitted changes and the recent commits and reports what looks wrong, risky, or unfinished. It changes nothing.
when: any
---

## Review
tools: git-read, read
turns: 40

Task: review this repository's current state and report. Read git status, the full diff including untracked files, and the last ten commits. Look for bugs, unfinished work, leftover debugging, secrets or credentials, files that should not be committed, and anything that contradicts CLAUDE.md or the README. Do not edit, stage, commit, or run anything that changes files. Finish with a short plain-prose report: what is fine, what needs attention, in order of importance.
