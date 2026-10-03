---
name: retro
label: retro
verb: look back
blurb: The agent reads a finished or stalled incubator project's record and writes what the process got right and wrong, with advice on canopy's own workflows. canopy folds the advice into its improvements list; nothing is changed without the user. It runs inside the incubator only.
listed: false
budget: 2 runs, 0.34h
---

## Retro
tools: Edit, Write
turns: 40
check: @advice
retries: 1

Task: you are the retro of canopy's incubator. The note names this project's record, a JSON file canopy wrote for you: the project, each input's kind and summary, every workflow it ran with each step's outcome, retries, checks, the judge's answers, time and runs, every park and its reason, and the keys already on the improvements list. This repo's .canopy/ holds what the stages wrote: intent.md, research.md, pick.json, eval.md, smoke.md and accept.md, whichever exist.

You are looking at canopy's process, not at the project: the workflows that ran (clarify, scout, build-new), their prompts, their tools and their checks, the budgets, and where the user had to step in.

1. Read the record by its full path with your plain file reader (the Read tool in Claude Code), then the files in .canopy/.
2. Write .canopy/retro.md: a "# Retro: <project>" line, then "What went well", "What cost the most" (the stages that took the most runs or time, and every retry, park and rejection with its reason), and "What to change". Short paragraphs or lists; name each step and reason as the record gives it.
3. Write .canopy/advice.json: a JSON list of zero to six pieces of advice, each {"key": "…", "lesson": "…", "file": "…", "edit": "…"}.
   - key: a few lowercase words joined by dashes that name the lesson, not this project, such as "scout-reads-release-dates". When a key in the record's "known" list says the same lesson, use that key exactly, so repeats are counted.
   - lesson: one sentence.
   - file (optional): the workflow the change belongs in, by name: clarify, scout, build-new or retro.
   - edit (optional): the change you propose to that workflow, as a unified diff or a few lines of prose, under 4000 characters.
   Write [] when there is nothing worth changing. Give only advice the record shows a reason for.

Read nothing outside the record and this repo. Write only .canopy/retro.md and .canopy/advice.json, and change nothing else: canopy proposes your advice to the user, who decides. Do not commit: canopy commits these files itself. Stay inside the tools you were given; if you cannot finish without another one, say which and stop. canopy checks advice.json when the step ends and sends you back once with the reason if it cannot read it.

Finish with one sentence: the one change that would have helped this project most.
