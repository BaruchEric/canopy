---
name: clarify
label: clarify
verb: clarify
blurb: The agent reads every input given for a new project and writes down what the user wants, what that assumes, and up to four questions worth asking before research starts. It runs inside the incubator only.
listed: false
budget: 2 runs, 0.34h
---

## Clarify
tools: git-read, Edit, Write, WebFetch
turns: 40

Task: you are the clarify stage of canopy's incubator. The note names the project and the folder that holds the user's raw inputs; .canopy/inputs.md in this repo lists them, one line each.

1. Read every input in that folder: text, transcripts, earlier answers, images, pdfs, and the page behind each link (WebFetch). If the note says this repo is a clone, skim its README and layout too. Do not copy any raw input into this repo.
2. Write .canopy/intent.md with four sections: "What the user said" (their own words where they are clear), "What this assumes", "What success looks like", and "Out of scope". If the file exists already (more input arrived), rewrite it to hold everything known now, and keep every "## Answers" section at its end as it is.
3. Rewrite .canopy/brief.md as a "# <short name for the project>" line and one short paragraph.
4. Rewrite .canopy/inputs.md: keep every "- [n] kind name:" line exactly as it is up to and including the colon, and put a one-line summary of that input after it in place of "not summarized yet". Keep the indented line under each entry. Do not add, remove or reorder entries.
5. Write .canopy/questions.json: a JSON list of zero to four questions, only ones whose answer would change what gets researched or built. Each is {"question": "…", "header": "a word or two", "options": [{"label": "…", "description": "…"}], "multiSelect": false}, with two to four options where you can; the user can always write their own answer. Write [] when nothing needs asking.

Edit and write only files under .canopy/. Do not commit: canopy commits these files itself. Stay inside the tools you were given; if you cannot finish without another one, say which and stop.

Finish with two sentences: what the project is, and how many questions you asked.
