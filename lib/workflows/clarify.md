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
check: "${CANOPY_BUN:-bun}" --config=/dev/null --no-env-file -e 'const f = Bun.file(".canopy/questions.json"); if (await f.exists()) { let q; try { q = JSON.parse(await f.text()); } catch { console.error(".canopy/questions.json is not JSON"); process.exit(1); } const list = Array.isArray(q) ? q : q && q.questions; if (!Array.isArray(list) || !list.every((x) => x && typeof x.question === "string" && x.question.trim())) { console.error(".canopy/questions.json must be a JSON list of questions, each with its question text"); process.exit(1); } }'
retries: 1

Task: you are the clarify stage of canopy's incubator. The note names the project and the folder that holds the user's raw inputs; .canopy/inputs.md in this repo lists them, one line each.

1. Read every input in that folder: text, transcripts, earlier answers, images, pdfs, and the page behind each link (WebFetch). Open each file by its full path, the folder plus the name .canopy/inputs.md gives it, with your plain file reader (the Read tool in Claude Code); the index lists every file, so nothing needs listing, and no command is needed to inspect, convert or decode one. A recording's words are in the entry that says "transcript of [n]": read that, never the audio file itself. Read nothing outside that folder and this repo. If the note says this repo is a clone, skim its README and layout too. Do not copy any raw input into this repo.
2. Write .canopy/intent.md with four sections: "What the user said" (their own words where they are clear), "What this assumes", "What success looks like", and "Out of scope". If the file exists already (more input arrived), rewrite it to hold everything known now, and keep every "## Answers" section at its end as it is.
3. Rewrite .canopy/brief.md as a "# <short name for the project>" line and one short paragraph.
4. Rewrite .canopy/inputs.md: keep every "- [n] kind name:" line exactly as it is up to and including the colon, and put a one-line summary of that input after it in place of "not summarized yet". Keep the indented line under each entry. Do not add, remove or reorder entries.
5. Write .canopy/questions.json: a JSON list of zero to four questions, only ones whose answer would change what gets researched or built. Each is {"question": "…", "header": "a word or two", "options": [{"label": "…", "description": "…"}], "multiSelect": false}, with two to four options where you can; the user can always write their own answer. Write [] when nothing needs asking. canopy checks the file when the step ends and sends you back once with the reason if it cannot read it, so run nothing to check it yourself.

Edit and write only files under .canopy/. Do not commit: canopy commits these files itself. Stay inside the tools you were given; if you cannot finish without another one, say which and stop.

Finish with two sentences: what the project is, and how many questions you asked.
