# Incubator phase 2: intake and clarify, implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A project goes into canopy as text, links, files, voice or a repo, gets a seed repo and a sprout record, is clarified by an agent that may ask up to four questions through the inbox, and is written up in the vault, with a + project sheet and an incubator view to drive it.

**Architecture:** A new `Incubator` class (`src/core/incubator.ts`) owns one `Sprout` per project and drives the phase 1 `Flows` one workflow at a time. It never runs an agent itself. Everything it touches is an injected dependency: the record files (`sproutstore.ts`), the seed repo (`seed.ts`), the vault gateway (`vault.ts`), the speech model (`transcribe.ts`), the scan and the flows. The pure parts (`sprout.ts`, `sproutnote.ts`) are browser-safe and tested. `server/incubator.ts` holds the routes. The UI adds an incubator view, two sheets, a clarify item in the inbox and a feed kind.

**Tech Stack:** Bun, TypeScript strict, `bun:test`, React 19, Zustand, the memory gateway's `/write` API at mem.beric.ca, an OpenAI-compatible `/v1/audio/transcriptions` endpoint (LiteLLM on the mini).

**Where to run it:** in a worktree made through superpowers:using-git-worktrees, branched from phase 1's branch (or from `main` once phase 1 has merged), never on `main` in the user's checkout: the user commits there while this runs, and peer sync carries `main` to the mini.

**Spec:** `docs/superpowers/specs/2026-10-01-incubator-design.md`, sections "Sprouts and the Incubator", "Inputs, clarification and memory", "UI", "API and CLI", "Errors". This is plan 2 of 5. It builds on phase 1 (`docs/superpowers/plans/2026-10-01-incubator-phase-1-flow-engine.md`) and uses these of its symbols: `Flow.spent`, `Flow.parkedFor`, `Workflow.budget` and the `budget:` frontmatter key, `Flows.restore` and the restore call it adds to `startServer`, `Flows.detach` and the `state.flows.detach()` line it adds to `stop()`.

## Global constraints

- `"strict": true` stays on in both tsconfigs; no `any`, no non-null `!`; a cast only after a runtime check, with a comment.
- `src/core/types.ts`, `src/core/sprout.ts`, `src/core/sproutnote.ts` and `src/core/tailchan.ts` stay browser-safe: no Bun or node imports (the UI imports them).
- Use `bun`/`bunx` only. Run the suite as `SHELL=/bin/bash bun test` (the zsh startup makes it flaky).
- Gates before calling anything done: `bun run typecheck && bun run lint && SHELL=/bin/bash bun test && bun run build`.
- Commit after each task with a conventional subject; no backticks in commit messages; end each message with `Claude-Session: https://claude.ai/code/session_01DMvREFYoLgpGe2oQNWq1Xu`. Never push.
- Prose (comments, docs, UI copy) follows the unslop rules: no em dashes, plain words, sentence case.
- No test reaches mem.beric.ca or any speech model: `vaultConfig` and `transcribeConfig` answer null under `NODE_ENV=test`, and the server tests pass their own stand-ins.
- Spec values, verbatim: sprout ids are `"sp_" + 12 hex`; seeds live at `<root>/_incubator/<slug>`; raw inputs at `$CANOPY_CONFIG_DIR/incubator/<id>/inputs/`, never in the seed; the record at `$CANOPY_CONFIG_DIR/incubator/<id>/sprout.json` and the index at `incubator/<id>/inputs.md`; only `brief.md`, `intent.md` and `inputs.md` under `.canopy/` are committed to the seed; 25 MB per file and 100 MB per sprout's inputs (413 past either); audio, image, pdf, text and markdown types (415 otherwise); zero to four clarify questions; "go on assumptions" skips them; at most two sprouts run at a time (`SPROUT_CONCURRENCY`), and one waiting on answers holds no slot; the vault note at `02 - Dev/incubator/<slug>.md`, rewritten on each change; a daily-note line when a sprout starts or parks; clarify's budget is 2 runs and 20 minutes, written `budget: 2 runs, 0.34h` (phase 1's parser takes decimal hours only).
- One deliberate change from the spec: the spec's ⌘N cannot be caught by a page in Chrome or Safari (the browser opens a window first), so the shortcut is a bare `n`, like `e`, `d`, `x` and `s`.

## Review focus

1. A `.canopy/intent.md` or `questions.json` that the agent made a symlink (to `~/.ssh/id_ed25519`, say) must never be read, so its target never reaches the vault note. `readSeed` refuses a symlink and anything over 256 KB. Pinned in Task 7.
2. `server.stop()` (a test, a redeploy) must not park every sprout when `Flows.stopAll` ends their flows. `Incubator.detach()` runs before it. Pinned in Tasks 9 and 10.
3. A restart while questions are open brings the inbox item back from `sprout.json`, and a restart mid-stage either finds the flow phase 1 restored or runs the stage again. Pinned in Task 9.
4. A voice memo alone, with no speech model set up, still makes a sprout: the slug comes from the id, the audio entry says "not transcribed", and clarify runs. Pinned in Task 8.
5. Real uploads carry MIME parameters (`audio/webm;codecs=opus`), Safari records `audio/mp4`, and a dropped `.md` often arrives as `""` or `application/octet-stream`. All three are accepted and a zip is refused with 415. Pinned in Tasks 1 and 10.

## File map

| File | Change |
|---|---|
| `src/core/types.ts` | `SPROUT_STATUSES`, `SproutStatus`, `InputKind`, `InputVia`, `InputEntry`, `SproutFlow`, `Sprout`, `SproutDetail`; `Workflow.listed`; `incubator` and `incubator-gone` events |
| `src/core/sprout.ts` (new, pure) | slugs, titles, upload types, input names, the inputs index and summaries, questions, answers, slots, `withInputsRead`, `parseSproutRecord` |
| `src/core/sproutnote.ts` (new, pure) | `sproutNote`, `sproutNotePath`, `dailyNotePath`, `dailyNoteHead`, `dailyLine`, `NoteEvent`, `DAILY_EVENTS` |
| `src/core/vault.ts` (new, Bun) | `vaultConfig`, `VaultNotes`, `VaultError`, `vaultNotes` |
| `src/core/transcribe.ts` (new, Bun) | `transcribeConfig`, `transcribe`, `transcriber` |
| `src/core/sproutstore.ts` (new, Bun) | `SproutFiles`, `incubatorDir` |
| `src/core/seed.ts` (new, Bun) | `makeSeed`, `commitSeed`, `readSeed`, `writeSeed`, `seedOps` |
| `src/core/incubator.ts` (new, Bun) | `Incubator`, `IncubatorError`, the dependency interfaces |
| `src/core/workflow.ts`, `src/core/workflows.ts`, `lib/workflows/clarify.md` | the `listed` key, the clarify workflow |
| `src/core/tailchan.ts`, `src/server/tailchan.ts` | `sproutNotice`, `ChanHub.onSprout`, sprout flows left to the sprout |
| `src/server/incubator.ts` (new), `src/server/index.ts` | the routes and the wiring |
| `src/cli/newargs.ts` (new), `src/cli/index.ts` | `canopy new`, `canopy incubator list|show` |
| `ui/src/sprouts.ts` (new), `ui/src/inbox.ts`, `ui/src/feed.ts`, `ui/src/qualify.ts`, `ui/src/routes.ts` | the pure UI parts |
| `ui/src/store.ts`, `ui/src/api.ts` | sprout state and actions |
| `ui/src/components/Incubator.tsx` (new), `Inbox.tsx`, `Prompts.tsx`, `Feed.tsx`, `RunSheet.tsx`, `TopBar.tsx`, `ui/src/App.tsx`, `ui/src/styles.css` | the view, the sheets, the inbox item, the button |
| `docker-compose.yml`, `docs/deploy.md`, `CLAUDE.md` | env and docs |

---

### Task 1: The sprout types and the pure helpers

**Files:**
- Modify: `src/core/types.ts` (a new section before `/* ---------- flows` near line 1150; two lines in `ServerEvent` near line 851)
- Create: `src/core/sprout.ts`
- Modify: `ui/src/qualify.ts` (the `switch (ev.type)` near line 80), `ui/src/feed.ts` (the `switch (ev.type)` in `describeEvent` near line 369)
- Test: `src/core/sprout.test.ts`

**Interfaces:**
- Consumes: `RunQuestion`, `RunQuestionOption`, `Workflow` (existing, `src/core/types.ts`).
- Produces (types): `SPROUT_STATUSES`, `SproutStatus`, `InputKind = "text" | "audio" | "image" | "url" | "file" | "transcript" | "answers"`, `InputVia = "sheet" | "cli" | "answer"`, `InputEntry {n, kind, name, label, type, at, via, bytes, summary, processed, from?, note?}`, `SproutFlow {workflow, flowId, outcome?}`, `Sprout {id, slug, title, status, repoId, seedPath, repo?, prepared, inputs, clarified, reclarify, questions?, questionsAt?, flows, spent, parked?, noteRev?, createdAt, updatedAt}`, `SproutDetail {sprout, brief, intent, inputsIndex, research}`, events `{type: "incubator"; sprout}` and `{type: "incubator-gone"; id}`.
- Produces (`src/core/sprout.ts`): `SPROUT_CONCURRENCY = 2`, `INPUT_FILE_MAX`, `INPUT_TOTAL_MAX`, `QUESTIONS_MAX = 4`, `SEEDS_DIR = "_incubator"`, `isSproutId(id)`, `sproutSlug(text, id, taken)`, `sproutTitle(text, fallback)`, `briefTitle(md)`, `firstLine(text, max?)`, `inputType(type, name): string | null`, `inputKindOf(type): InputKind`, `safeInputName(n, label)`, `localStamp(at)`, `sizeWord(bytes)`, `inputsIndex(entries)`, `parseSummaries(md): Map<number, string>`, `withSummaries(entries, map)`, `ParsedQuestions`, `parseQuestions(text)`, `answersText(questions, answers | null, at)`, `briefText(title, text)`, `stageNote(sprout, inputsDir)`, `RUNNING_STATUSES`, `holdsSlot(s)`, `sproutEnded(s)`, `WORKFLOW_STATUS`, `nextWorkflow(s)`, `withInputsRead(workflow, dir)`, `parseSproutRecord(text): Sprout | null`.

- [ ] **Step 1: Add the types**

In `src/core/types.ts`, just above the line `/* ---------- flows: one workflow running on one repo ---------- */`, add:

```ts
/* ---------- the incubator: new projects from an idea, a link or a repo ---------- */

export const SPROUT_STATUSES = [
  "queued",
  "clarifying",
  "researching",
  "building",
  "testing",
  "accepting",
  "deploying",
  "live",
  "parked",
  "rejected",
  "handed-off",
  "stopped",
] as const;
export type SproutStatus = (typeof SPROUT_STATUSES)[number];

export type InputKind = "text" | "audio" | "image" | "url" | "file" | "transcript" | "answers";
export type InputVia = "sheet" | "cli" | "answer";

/** One thing the user gave a sprout. The raw file stays under the sprout's
 *  inputs/ folder on the backend; only this entry and its summary go further. */
export interface InputEntry {
  /** 1-based, in the order the inputs arrived; never reused */
  n: number;
  kind: InputKind;
  /** the file under inputs/, "003-voice.webm" */
  name: string;
  /** what the user called it: a file's own name, the link, "text" */
  label: string;
  /** MIME type, parameters dropped */
  type: string;
  at: number;
  via: InputVia;
  bytes: number;
  /** one line; "" until clarify writes one (text, transcripts and answers carry their own) */
  summary: string;
  /** transcribed, or summarized by clarify */
  processed: boolean;
  /** a transcript's audio input */
  from?: number;
  /** why it was not processed: "not transcribed: …" */
  note?: string;
}

export interface SproutFlow {
  workflow: string;
  flowId: string;
  /** how the flow ended, once it has */
  outcome?: string;
}

/** One project in the incubator. */
export interface Sprout {
  /** "sp_" + 12 hex */
  id: string;
  /** the seed's folder name, fixed at intake */
  slug: string;
  title: string;
  status: SproutStatus;
  /** the seed's repo id, `_incubator/<slug>` */
  repoId: string;
  seedPath: string;
  /** a repo url the intake clones into the seed */
  repo?: string;
  /** the seed is made and the inputs intake processes are processed */
  prepared: boolean;
  inputs: InputEntry[];
  /** clarify ran and canopy read what it wrote */
  clarified: boolean;
  /** an input arrived after clarify, so clarify runs again before the next stage */
  reclarify: boolean;
  /** the open clarify batch, when it waits on the user */
  questions?: RunQuestion[];
  questionsAt?: number;
  flows: SproutFlow[];
  spent: { runs: number; workMs: number };
  /** why it is parked, one line */
  parked?: string;
  /** the vault note's revision, for the next replace */
  noteRev?: string;
  createdAt: number;
  updatedAt: number;
}

/** what the sheet shows beyond the record: the seed's own words */
export interface SproutDetail {
  sprout: Sprout;
  brief: string | null;
  intent: string | null;
  inputsIndex: string;
  research: string | null;
}

```

In the `ServerEvent` union, after the line `| { type: "fleet-gone"; id: string }`, add:

```ts
  /** a sprout, whole, whenever it changes; home backend only */
  | { type: "incubator"; sprout: Sprout }
  | { type: "incubator-gone"; id: string }
```

- [ ] **Step 2: Keep the exhaustive switches compiling**

In `ui/src/qualify.ts`, in `qEvent`'s `switch (ev.type)`, put these two cases next to `case "registry":` and `case "asks":` so they fall through to the same `return ev;`:

```ts
    // the incubator is the home backend's alone, and the store drops any
    // other backend's
    case "incubator":
    case "incubator-gone":
```

In `ui/src/feed.ts`, in `describeEvent`'s switch, after the `case "asks":` line and its return, add:

```ts
    case "incubator":
    case "incubator-gone":
      return [];
```

Task 11 replaces that `return [];` with the sprout lines.

- [ ] **Step 3: Write the failing test**

Create `src/core/sprout.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import {
  answersText,
  briefTitle,
  holdsSlot,
  inputKindOf,
  inputType,
  inputsIndex,
  localStamp,
  nextWorkflow,
  parseQuestions,
  parseSproutRecord,
  parseSummaries,
  safeInputName,
  sproutEnded,
  sproutSlug,
  sproutTitle,
  withInputsRead,
  withSummaries,
} from "./sprout";
import type { InputEntry, Sprout, Workflow } from "./types";

const at = new Date(2026, 9, 1, 14, 3).getTime();

const entry = (n: number, kind: InputEntry["kind"], name: string, extra: Partial<InputEntry> = {}): InputEntry => ({
  n,
  kind,
  name,
  label: name,
  type: "text/plain",
  at,
  via: "sheet",
  bytes: 2048,
  summary: "",
  processed: false,
  ...extra,
});

const sprout = (extra: Partial<Sprout> = {}): Sprout => ({
  id: "sp_0123456789ab",
  slug: "s",
  title: "s",
  status: "queued",
  repoId: "_incubator/s",
  seedPath: "/root/_incubator/s",
  prepared: true,
  inputs: [],
  clarified: false,
  reclarify: false,
  flows: [],
  spent: { runs: 0, workMs: 0 },
  createdAt: 1,
  updatedAt: 1,
  ...extra,
});

describe("sproutSlug", () => {
  test("the first words, lowercase, without the small ones", () => {
    expect(sproutSlug("A tiny app for the laundromat's change machine!", "sp_0123456789ab", () => false)).toBe(
      "tiny-app-laundromat-s-change-machine",
    );
  });
  test("accents fold and the length is capped", () => {
    const slug = sproutSlug("Café menu builder with extremely long words everywhere you look", "sp_0123456789ab", () => false);
    expect(slug.startsWith("cafe-menu-builder")).toBe(true);
    expect(slug.length).toBeLessThanOrEqual(40);
    expect(slug.endsWith("-")).toBe(false);
  });
  test("a voice memo alone gets a name from the id", () => {
    expect(sproutSlug("", "sp_0123456789ab", () => false)).toBe("idea-012345");
  });
  test("a taken name gets -2, then -3", () => {
    const taken = new Set(["notes", "notes-2"]);
    expect(sproutSlug("notes", "sp_0123456789ab", (s) => taken.has(s))).toBe("notes-3");
  });
});

describe("titles", () => {
  test("the first line, heading marks dropped, cut at a word", () => {
    expect(sproutTitle("# Laundry tracker\nmore", "x")).toBe("Laundry tracker");
    expect(sproutTitle("", "voice.webm")).toBe("voice.webm");
    expect(sproutTitle("", "")).toBe("a new project");
    const long = sproutTitle("word ".repeat(40), "x");
    expect(long.length).toBeLessThanOrEqual(80);
    expect(long.endsWith("…")).toBe(true);
  });
  test("briefTitle reads the first # heading", () => {
    expect(briefTitle("intro\n# Change counter\n\nbody")).toBe("Change counter");
    expect(briefTitle("no heading")).toBeNull();
  });
});

describe("inputType", () => {
  test("parameters drop and the kinds canopy takes pass", () => {
    expect(inputType("audio/webm;codecs=opus", "voice.webm")).toBe("audio/webm");
    expect(inputType("audio/mp4", "voice.m4a")).toBe("audio/mp4");
    expect(inputType("image/png", "shot.png")).toBe("image/png");
    expect(inputType("application/pdf", "a.pdf")).toBe("application/pdf");
    expect(inputType("text/plain", "a.txt")).toBe("text/plain");
  });
  test("an empty or generic type is read off the extension", () => {
    expect(inputType("", "notes.md")).toBe("text/markdown");
    expect(inputType("application/octet-stream", "notes.md")).toBe("text/markdown");
    expect(inputType("text/x-markdown", "notes.markdown")).toBe("text/markdown");
  });
  test("anything else is refused", () => {
    expect(inputType("application/zip", "a.zip")).toBeNull();
    expect(inputType("", "run.sh")).toBeNull();
  });
  test("the kind follows the type", () => {
    expect(inputKindOf("audio/mpeg")).toBe("audio");
    expect(inputKindOf("image/heic")).toBe("image");
    expect(inputKindOf("application/pdf")).toBe("file");
  });
});

describe("input names and the index", () => {
  test("a numbered, flat, safe name", () => {
    expect(safeInputName(3, "My Voice: memo.webm")).toBe("003-My-Voice-memo.webm");
    expect(safeInputName(12, "../../etc/passwd")).toBe("012-passwd");
    expect(safeInputName(1, "...")).toBe("001-input");
  });
  test("localStamp is the local wall clock", () => {
    expect(localStamp(at)).toBe("2026-10-01 14:03");
  });
  test("the index lists every entry and reads back its summaries", () => {
    const entries = [
      entry(1, "text", "001-text.md", { summary: "a change counter", processed: true }),
      entry(2, "url", "002-link.url", { label: "https://example.com/a:b" }),
      entry(3, "audio", "003-voice.webm", { note: "not transcribed: no speech model" }),
    ];
    const md = inputsIndex(entries);
    expect(md).toContain("- [1] text 001-text.md: a change counter");
    expect(md).toContain("- [2] url 002-link.url: not summarized yet");
    expect(md).toContain("  2 KB, from the page, 2026-10-01 14:03, https://example.com/a:b");
    expect(md).toContain("- [3] audio 003-voice.webm: not transcribed: no speech model");
    // clarify fills a summary in; the placeholders read as nothing
    const written = md.replace("002-link.url: not summarized yet", "002-link.url: a pricing page for coin counters");
    const map = parseSummaries(written);
    expect(map.get(2)).toBe("a pricing page for coin counters");
    expect(map.has(3)).toBe(false);
    const next = withSummaries(entries, map);
    expect(next[1]?.summary).toBe("a pricing page for coin counters");
    expect(next[1]?.processed).toBe(true);
    // a text entry keeps its own first line
    expect(withSummaries(entries, new Map([[1, "other"]]))[0]?.summary).toBe("a change counter");
  });
});

describe("parseQuestions", () => {
  test("a list, or {questions}, at most four, options as strings or objects", () => {
    const five = Array.from({ length: 5 }, (_, i) => ({ question: `q${i}?`, options: ["a", { label: "b", description: "bee" }] }));
    const r = parseQuestions(JSON.stringify(five));
    if (!r.ok) throw new Error(r.error);
    expect(r.questions).toHaveLength(4);
    expect(r.questions[0]).toEqual({
      question: "q0?",
      header: "",
      options: [
        { label: "a", description: "" },
        { label: "b", description: "bee" },
      ],
      multiSelect: false,
    });
    const wrapped = parseQuestions(JSON.stringify({ questions: [{ question: "who?", header: "audience and more", multiSelect: true }] }));
    if (!wrapped.ok) throw new Error(wrapped.error);
    expect(wrapped.questions[0]?.header).toBe("audience and");
    expect(wrapped.questions[0]?.multiSelect).toBe(true);
  });
  test("an empty list is no questions; duplicates drop", () => {
    expect(parseQuestions("[]")).toEqual({ ok: true, questions: [] });
    const dup = parseQuestions(JSON.stringify([{ question: "x?" }, { question: "x?" }]));
    expect(dup.ok && dup.questions.length).toBe(1);
  });
  test("what is not a list of questions is an error", () => {
    expect(parseQuestions("{").ok).toBe(false);
    expect(parseQuestions('{"a":1}').ok).toBe(false);
    expect(parseQuestions('[{"options":["a"]}]').ok).toBe(false);
  });
});

describe("answersText", () => {
  const qs = [{ question: "Who uses it?", header: "", options: [], multiSelect: false }];
  test("each question with its answer", () => {
    expect(answersText(qs, { "Who uses it?": "staff" }, at)).toBe("## Answers, 2026-10-01 14:03\n\n- Who uses it?\n  staff\n");
  });
  test("going on assumptions says so", () => {
    expect(answersText(qs, null, at)).toContain("chose to go on assumptions");
  });
});

describe("slots and stages", () => {
  test("a running stage holds a slot; waiting on answers, queued, parked and ended do not", () => {
    expect(holdsSlot(sprout({ status: "clarifying" }))).toBe(true);
    expect(holdsSlot(sprout({ status: "researching" }))).toBe(true);
    expect(holdsSlot(sprout({ status: "clarifying", questions: [{ question: "q", header: "", options: [], multiSelect: false }] }))).toBe(false);
    expect(holdsSlot(sprout({ status: "queued" }))).toBe(false);
    expect(holdsSlot(sprout({ status: "parked" }))).toBe(false);
    expect(sproutEnded(sprout({ status: "stopped" }))).toBe(true);
    expect(sproutEnded(sprout({ status: "parked" }))).toBe(false);
  });
  test("clarify first, again after new input, then scout", () => {
    expect(nextWorkflow(sprout())).toBe("clarify");
    expect(nextWorkflow(sprout({ clarified: true, reclarify: true }))).toBe("clarify");
    expect(nextWorkflow(sprout({ clarified: true }))).toBe("scout");
  });
  test("withInputsRead adds an absolute read rule to every step and leaves the original alone", () => {
    const wf = { name: "clarify", steps: [{ name: "A", tools: ["Edit"] }] } as unknown as Workflow;
    const next = withInputsRead(wf, "/config/incubator/sp_0123456789ab/inputs");
    expect(next.steps[0]?.tools).toEqual(["Edit", "Read(//config/incubator/sp_0123456789ab/inputs/**)"]);
    expect(wf.steps[0]?.tools).toEqual(["Edit"]);
  });
});

describe("parseSproutRecord", () => {
  test("a record round-trips; a broken or foreign one is null", () => {
    const s = sprout();
    expect(parseSproutRecord(JSON.stringify(s))).toEqual(s);
    expect(parseSproutRecord(JSON.stringify(s).slice(0, 40))).toBeNull();
    expect(parseSproutRecord(JSON.stringify({ ...s, id: "nope" }))).toBeNull();
    expect(parseSproutRecord(JSON.stringify({ ...s, status: "growing" }))).toBeNull();
  });
});
```

- [ ] **Step 4: Run it to see it fail**

Run: `SHELL=/bin/bash bun test src/core/sprout.test.ts`
Expected: FAIL, `Cannot find module './sprout'`.

- [ ] **Step 5: Write `src/core/sprout.ts`**

```ts
/**
 * The incubator's pure parts (spec 2026-10-01-incubator-design.md): slugs
 * and titles, what an upload is taken as, the inputs index and the
 * summaries clarify writes back into it, clarify's questions, the answers
 * as text, and which sprouts hold one of the running slots. Browser-safe:
 * the UI imports it.
 */
import { SPROUT_STATUSES, type InputEntry, type InputKind, type InputVia, type RunQuestion, type RunQuestionOption, type Sprout, type SproutStatus, type Workflow } from "./types";

/** how many sprouts run a stage at once; the rest wait their turn */
export const SPROUT_CONCURRENCY = 2;
/** one upload, and everything one sprout was given */
export const INPUT_FILE_MAX = 25 * 1024 * 1024;
export const INPUT_TOTAL_MAX = 100 * 1024 * 1024;
/** clarify asks at most this many at once */
export const QUESTIONS_MAX = 4;
/** where seeds live under the launch root */
export const SEEDS_DIR = "_incubator";

const ID = /^sp_[0-9a-f]{12}$/;
export const isSproutId = (id: string): boolean => ID.test(id);

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const oneLine = (s: string, max = 200): string => s.replace(/\s+/g, " ").trim().slice(0, max);

const STOP_WORDS = new Set(["a", "an", "the", "to", "for", "of", "and", "or", "with", "my", "i", "we", "that", "this", "it"]);
const SLUG_WORDS = 6;
const SLUG_MAX = 40;

/** A folder name from the first words of the idea; `idea-<id>` when there
 *  are none (a voice memo alone), then `-2`, `-3` while the name is taken.
 *  Fixed at intake: flows and the scan know the seed by it. */
export function sproutSlug(text: string, id: string, taken: (slug: string) => boolean): string {
  const words = text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .split(/[^a-z0-9]+/)
    .filter((w) => w && !STOP_WORDS.has(w));
  const base = words.slice(0, SLUG_WORDS).join("-").slice(0, SLUG_MAX).replace(/-+$/, "") || `idea-${id.slice(3, 9)}`;
  let slug = base;
  for (let i = 2; taken(slug); i++) slug = `${base}-${i}`;
  return slug;
}

const clip = (t: string, max: number): string => (t.length <= max ? t : `${t.slice(0, max - 1).replace(/\s+\S*$/, "")}…`);

/** the first non-empty line, heading marks dropped, up to 80 characters */
export function sproutTitle(text: string, fallback: string): string {
  const line = text
    .split("\n")
    .map((l) => l.replace(/^#+\s*/, "").trim())
    .find(Boolean);
  return clip(line || fallback.trim() || "a new project", 80);
}

/** the brief's `# ` heading, which clarify writes as the project's name */
export function briefTitle(md: string): string | null {
  const line = md.split("\n").find((l) => /^#\s+\S/.test(l));
  return line ? clip(oneLine(line.replace(/^#\s+/, "")), 80) : null;
}

export const firstLine = (text: string, max = 120): string => clip(oneLine(text.split("\n").find((l) => l.trim()) ?? "", 1000), max);

const BY_EXT: Record<string, string> = {
  md: "text/markdown",
  markdown: "text/markdown",
  txt: "text/plain",
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  heic: "image/heic",
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  mp4: "audio/mp4",
  wav: "audio/wav",
  webm: "audio/webm",
  ogg: "audio/ogg",
  oga: "audio/ogg",
  flac: "audio/flac",
};

/** The type an upload is taken as, parameters dropped: audio, an image, a
 *  pdf, text or markdown by its own type, else by its extension (a dropped
 *  `.md` often comes as "" or octet-stream); null for anything else. */
export function inputType(type: string, name: string): string | null {
  const t = (type.split(";")[0] ?? "").trim().toLowerCase();
  if (/^(audio|image)\/[a-z0-9.+-]+$/.test(t) || t === "application/pdf" || t === "text/plain" || t === "text/markdown") return t;
  const ext = /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase();
  return (ext && BY_EXT[ext]) || null;
}

export function inputKindOf(type: string): InputKind {
  if (type.startsWith("audio/")) return "audio";
  if (type.startsWith("image/")) return "image";
  return "file";
}

/** `003-voice.webm`: the order, then the name with anything but letters,
 *  digits, dot, dash and underscore made a dash; never a path */
export function safeInputName(n: number, label: string): string {
  const base = label.split(/[/\\]/).pop() ?? "";
  const clean = base.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[.-]+/, "").slice(0, 80);
  return `${String(n).padStart(3, "0")}-${clean || "input"}`;
}

const pad2 = (n: number): string => String(n).padStart(2, "0");

/** `2026-10-01 14:03`, the backend's local wall clock */
export function localStamp(at: number): string {
  const d = new Date(at);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

export function sizeWord(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

const VIA_WORD: Record<InputVia, string> = { sheet: "from the page", cli: "from the command line", answer: "an answer in the inbox" };
const NO_SUMMARY = "not summarized yet";

export const INPUTS_HEAD =
  "# Inputs\n\nEvery input given for this project, in order. The raw files stay on the canopy backend; this index and its one-line summaries are what is kept here.\n";

/** The index: one `- [n] kind name: summary` line per input (the form
 *  clarify fills in and `parseSummaries` reads back), with the details on
 *  an indented line under it. */
export function inputsIndex(entries: readonly InputEntry[]): string {
  const lines = entries.map((e) => {
    const extra = [
      sizeWord(e.bytes),
      VIA_WORD[e.via],
      localStamp(e.at),
      e.from ? `transcript of [${e.from}]` : "",
      e.kind !== "text" && e.kind !== "answers" && e.label !== e.name ? oneLine(e.label) : "",
    ]
      .filter(Boolean)
      .join(", ");
    return `- [${e.n}] ${e.kind} ${e.name}: ${oneLine(e.summary || e.note || NO_SUMMARY)}\n  ${extra}`;
  });
  return `${INPUTS_HEAD}\n${lines.join("\n")}\n`;
}

const SUMMARY_LINE = /^- \[(\d+)\] [a-z]+ [^:\n]*: (.+)$/;

/** the summaries clarify wrote into the index, by input number */
export function parseSummaries(md: string): Map<number, string> {
  const out = new Map<number, string>();
  for (const line of md.split("\n")) {
    const m = SUMMARY_LINE.exec(line.trimEnd());
    if (!m) continue;
    const summary = oneLine(m[2] ?? "");
    if (!summary || summary === NO_SUMMARY || summary.startsWith("not transcribed")) continue;
    out.set(Number(m[1]), summary);
  }
  return out;
}

/** the kinds whose summary clarify writes; text, transcripts and answers carry their own */
const SUMMARIZED: ReadonlySet<InputKind> = new Set<InputKind>(["url", "image", "file"]);

export function withSummaries(entries: readonly InputEntry[], map: ReadonlyMap<number, string>): InputEntry[] {
  return entries.map((e) => {
    const summary = map.get(e.n);
    return summary && SUMMARIZED.has(e.kind) ? { ...e, summary, processed: true } : e;
  });
}

export type ParsedQuestions = { ok: true; questions: RunQuestion[] } | { ok: false; error: string };

/** clarify's `.canopy/questions.json`: a list (or `{questions}`) of at most
 *  four, each with its options as strings or `{label, description}` */
export function parseQuestions(text: string): ParsedQuestions {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, error: "questions.json is not JSON" };
  }
  const list: unknown = Array.isArray(raw) ? raw : isObj(raw) ? raw["questions"] : null;
  if (!Array.isArray(list)) return { ok: false, error: "questions.json must be a list of questions" };
  const out: RunQuestion[] = [];
  for (const q of list as unknown[]) {
    if (!isObj(q) || typeof q["question"] !== "string" || !q["question"].trim()) {
      return { ok: false, error: "every question needs its question text" };
    }
    const question = oneLine(q["question"], 300);
    if (out.some((o) => o.question === question)) continue;
    const options: RunQuestionOption[] = [];
    const given: unknown[] = Array.isArray(q["options"]) ? (q["options"] as unknown[]) : [];
    for (const o of given.slice(0, 6)) {
      const label = typeof o === "string" ? oneLine(o, 60) : isObj(o) && typeof o["label"] === "string" ? oneLine(o["label"], 60) : "";
      if (!label || options.some((x) => x.label === label)) continue;
      const description = isObj(o) && typeof o["description"] === "string" ? oneLine(o["description"]) : "";
      options.push({ label, description });
    }
    const header = typeof q["header"] === "string" ? q["header"].trim().slice(0, 12).trim() : "";
    out.push({ question, header, options, multiSelect: q["multiSelect"] === true });
    if (out.length === QUESTIONS_MAX) break;
  }
  return { ok: true, questions: out };
}

/** the answers as they go into intent.md and the inputs: each question
 *  with its answer, or that the user went on assumptions */
export function answersText(questions: readonly RunQuestion[], answers: Readonly<Record<string, string>> | null, at: number): string {
  const head = `## Answers, ${localStamp(at)}`;
  if (!answers) return `${head}\n\nThe user chose to go on assumptions: research goes on with what this file assumes.\n`;
  const lines = questions.map((q) => `- ${q.question}\n  ${oneLine(answers[q.question] ?? "", 1000) || "(no answer)"}`);
  return `${head}\n\n${lines.join("\n")}\n`;
}

/** the seed's first brief, until clarify rewrites it */
export function briefText(title: string, text: string): string {
  return `# ${title}\n\n${text.trim() || "No text was given; clarify writes the brief from the other inputs."}\n`;
}

/** the note every stage's flow starts with, which each step's prompt carries */
export function stageNote(s: Sprout, inputsDir: string): string {
  return [
    `This is the incubator project "${s.title}" (${s.id}).`,
    `The user's raw inputs are in ${inputsDir}; .canopy/inputs.md in this repo indexes them.`,
    s.repo ? `The seed is a clone of ${s.repo}; its remote is called upstream.` : "",
  ]
    .filter(Boolean)
    .join(" ");
}

/** the statuses with a stage in progress */
export const RUNNING_STATUSES: ReadonlySet<SproutStatus> = new Set<SproutStatus>([
  "clarifying",
  "researching",
  "building",
  "testing",
  "accepting",
  "deploying",
]);

/** whether a sprout holds one of the running slots: a stage in progress,
 *  except clarify waiting on the user's answers */
export const holdsSlot = (s: Sprout): boolean => RUNNING_STATUSES.has(s.status) && !(s.status === "clarifying" && s.questions?.length);

const ENDED: ReadonlySet<SproutStatus> = new Set<SproutStatus>(["live", "rejected", "handed-off", "stopped"]);
export const sproutEnded = (s: Sprout): boolean => ENDED.has(s.status);

/** the status a sprout shows while a workflow runs for it */
export const WORKFLOW_STATUS: Readonly<Record<string, SproutStatus>> = {
  clarify: "clarifying",
  scout: "researching",
  "build-new": "building",
  renovate: "building",
  extend: "building",
};

/** the workflow a queued sprout runs next; phase 3 adds the builds after scout */
export const nextWorkflow = (s: Sprout): string => (!s.clarified || s.reclarify ? "clarify" : "scout");

/** A copy of the workflow whose every step may also read the sprout's raw
 *  inputs: `//` makes the rule an absolute path for Claude Code. */
export function withInputsRead(wf: Workflow, dir: string): Workflow {
  const rule = `Read(/${dir}/**)`;
  return { ...wf, steps: wf.steps.map((st) => ({ ...st, tools: [...st.tools, rule] })) };
}

/** a sprout.json read back; null for a broken or foreign file */
export function parseSproutRecord(text: string): Sprout | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isObj(raw)) return null;
  const { id, slug, title, status, repoId, seedPath, inputs, flows, createdAt } = raw;
  if (typeof id !== "string" || !isSproutId(id) || typeof slug !== "string" || typeof title !== "string") return null;
  if (typeof repoId !== "string" || typeof seedPath !== "string" || typeof createdAt !== "number") return null;
  if (typeof status !== "string" || !(SPROUT_STATUSES as readonly string[]).includes(status)) return null;
  if (!Array.isArray(inputs) || !Array.isArray(flows)) return null;
  // canopy's own file: past these checks it is taken as written
  return raw as unknown as Sprout;
}
```

- [ ] **Step 6: Run it**

Run: `SHELL=/bin/bash bun test src/core/sprout.test.ts`
Expected: PASS.

- [ ] **Step 7: Typecheck and lint**

Run: `bun run typecheck && bun run lint`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/core/types.ts src/core/sprout.ts src/core/sprout.test.ts ui/src/qualify.ts ui/src/feed.ts
git commit -m "feat(incubator): the sprout record and its pure helpers

Claude-Session: https://claude.ai/code/session_01DMvREFYoLgpGe2oQNWq1Xu"
```

---

### Task 2: The clarify workflow, kept out of the menus

**Files:**
- Modify: `src/core/types.ts` (`Workflow`), `src/core/workflow.ts` (`parseWorkflow`), `src/core/workflows.ts` (`BUNDLED_ORDER`), `src/server/index.ts` (the `workflows` action near line 2451, the `flow` action near line 2509, `POST /api/fleet` near line 2085)
- Create: `lib/workflows/clarify.md`
- Test: `src/core/workflow.test.ts`, `src/core/workflows.test.ts`

**Interfaces:**
- Consumes: `parseWorkflow`, `bool` (existing in `workflow.ts`); phase 1's `budget:` key.
- Produces: `Workflow.listed?: false` (absent means listed); the bundled `clarify` workflow, `listed: false`, one step `Clarify` with tools `git-read` plus `Edit`, `Write`, `WebFetch`, `budget: 2 runs, 0.34h`.

The step's tools are bare `Edit` and `Write`, not rules scoped to `.canopy/`: a codex-routed run picks its sandbox off a bare rule (`threadPolicy` gives workspace-write only then) and `autoAnswer` matches only bare ones, so scoped rules would leave codex read-only and park every write in the inbox. The prompt keeps the agent to `.canopy/`, and canopy commits only the three files the spec names.

- [ ] **Step 1: Write the failing tests**

In `src/core/workflow.test.ts`, add:

```ts
describe("listed", () => {
  const meta = { name: "w", source: "bundled" as const, file: "/w.md" };
  const text = (line: string) => `---\nblurb: b\n${line}---\n\n## A\n\nDo it.\n`;
  test("absent or true is listed; false marks it", () => {
    const plain = parseWorkflow(text(""), meta);
    expect(plain.ok && plain.workflow.listed).toBeUndefined();
    const yes = parseWorkflow(text("listed: true\n"), meta);
    expect(yes.ok && yes.workflow.listed).toBeUndefined();
    const no = parseWorkflow(text("listed: false\n"), meta);
    expect(no.ok && no.workflow.listed).toBe(false);
  });
  test("anything else is an error", () => {
    const bad = parseWorkflow(text("listed: maybe\n"), meta);
    expect(bad.ok).toBe(false);
  });
});
```

In `src/core/workflows.test.ts`, change the expected names in the first test to:

```ts
    expect(names).toEqual(["commit", "push", "ship", "deploy", "review", "clarify", "broken", "tidy"]);
```

and add a test after it:

```ts
  test("the bundled clarify is the incubator's own: unlisted, budgeted, one step", async () => {
    const clarify = findWorkflow(await loadWorkflows({ path: "", host: "none" }), "clarify");
    expect(clarify?.listed).toBe(false);
    expect(clarify?.budget).toEqual({ runs: 2, hours: 0.34 });
    expect(clarify?.steps.map((s) => s.name)).toEqual(["Clarify"]);
    expect(clarify?.steps[0]?.tools).toEqual(expect.arrayContaining(["Edit", "Write", "WebFetch", "Bash(git status:*)"]));
  });
```

- [ ] **Step 2: Run them to see them fail**

Run: `SHELL=/bin/bash bun test src/core/workflow.test.ts src/core/workflows.test.ts`
Expected: FAIL; `listed: false` is not read and there is no clarify workflow.

- [ ] **Step 3: The `listed` key**

In `src/core/types.ts`, in `interface Workflow`, after `noteRequired: boolean;`, add:

```ts
  /** false keeps the workflow out of the menus and the fleet picker: the
   *  incubator's own stages; absent means listed */
  listed?: false;
```

In `src/core/workflow.ts`, in `parseWorkflow`, after the `const when: WorkflowWhen = …` line, add:

```ts
    const listedRaw = keys.get("listed");
    const listed = listedRaw === undefined || listedRaw === "" ? true : bool(listedRaw, "listed");
```

and in the `workflow` object literal, after `noteRequired: bool(keys.get("note-required"), "note-required"),`, add:

```ts
      ...(listed ? {} : { listed: false as const }),
```

In `src/core/workflows.ts`, change `BUNDLED_ORDER` to:

```ts
const BUNDLED_ORDER = ["commit", "push", "ship", "deploy", "review", "clarify"];
```

- [ ] **Step 4: Keep unlisted workflows off the menus and out of fleets and manual flows**

In `src/server/index.ts`:

1. In the `if (method === "GET" && action === "workflows")` branch, replace `return json(await loadWorkflows(repo));` with:

```ts
      // the incubator's stages run only from the incubator
      return json((await loadWorkflows(repo)).filter((e) => !e.ok || e.workflow.listed !== false));
```

2. In the `if (method === "POST" && action === "flow")` branch, change `if (!wf) {` handling so an unlisted one reads as unknown: right after `const wf = findWorkflow(entries, b.workflow);` add:

```ts
      if (wf?.listed === false) return json({ error: `${wf.name} runs only inside the incubator` }, 400);
```

3. In `POST /api/fleet`, right after the line `const wf = findWorkflow(await loadWorkflows({ path: "", host: "none" }), b.workflow);`, add the same line:

```ts
    if (wf?.listed === false) return json({ error: `${wf.name} runs only inside the incubator` }, 400);
```

- [ ] **Step 5: Write `lib/workflows/clarify.md`**

```markdown
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
```

- [ ] **Step 6: Run the tests**

Run: `SHELL=/bin/bash bun test src/core/workflow.test.ts src/core/workflows.test.ts`
Expected: PASS.

- [ ] **Step 7: Typecheck, lint and the server suite**

Run: `bun run typecheck && bun run lint && SHELL=/bin/bash bun test src/server`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/core/types.ts src/core/workflow.ts src/core/workflows.ts src/core/workflow.test.ts src/core/workflows.test.ts src/server/index.ts lib/workflows/clarify.md
git commit -m "feat(incubator): the clarify workflow, kept off the menus

Claude-Session: https://claude.ai/code/session_01DMvREFYoLgpGe2oQNWq1Xu"
```

---

### Task 3: The vault note's text

**Files:**
- Create: `src/core/sproutnote.ts`
- Test: `src/core/sproutnote.test.ts`

**Interfaces:**
- Consumes: `localStamp`, `sizeWord` (Task 1); `Sprout`, `SproutStatus` (Task 1).
- Produces: `type NoteEvent = "started" | "questions" | "input" | "parked" | "stopped"`, `DAILY_EVENTS: ReadonlySet<NoteEvent>` (started, parked), `sproutNotePath(slug)`, `sproutNote(s, intent: string | null): string`, `dailyNotePath(d: Date)`, `dailyNoteHead(d: Date)`, `dailyLine(s, event): string`.

The daily note path and heading follow the vault's own: `01 - Daily Notes/10 - October 2026/2026-10-01.md`, frontmatter `status/project/type/created`, then `# Thursday, October 1, 2026` and `## Index`. Built from local date getters, so the tests build dates with `new Date(y, m, d, h)`, never ISO strings (`bun test` pins JS dates to UTC).

- [ ] **Step 1: Write the failing test**

Create `src/core/sproutnote.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { DAILY_EVENTS, dailyLine, dailyNoteHead, dailyNotePath, sproutNote, sproutNotePath } from "./sproutnote";
import type { Sprout } from "./types";

const day = new Date(2026, 9, 1, 9, 30);

const sprout = (extra: Partial<Sprout> = {}): Sprout => ({
  id: "sp_0123456789ab",
  slug: "change-counter",
  title: "Change counter",
  status: "clarifying",
  repoId: "_incubator/change-counter",
  seedPath: "/root/_incubator/change-counter",
  prepared: true,
  inputs: [
    { n: 1, kind: "text", name: "001-text.md", label: "text", type: "text/markdown", at: day.getTime(), via: "sheet", bytes: 40, summary: "count coins at the laundromat", processed: true },
    { n: 2, kind: "audio", name: "002-voice.webm", label: "voice.webm", type: "audio/webm", at: day.getTime(), via: "sheet", bytes: 9000, summary: "", processed: false, note: "not transcribed: no speech model" },
  ],
  clarified: false,
  reclarify: false,
  flows: [{ workflow: "clarify", flowId: "abcdef01", outcome: "done" }],
  spent: { runs: 1, workMs: 180_000 },
  createdAt: day.getTime(),
  updatedAt: day.getTime(),
  ...extra,
});

describe("daily note", () => {
  test("the path and the head follow the vault's own", () => {
    expect(dailyNotePath(day)).toBe("01 - Daily Notes/10 - October 2026/2026-10-01.md");
    const head = dailyNoteHead(day);
    expect(head.startsWith("---\nstatus: active\nproject: personal\ntype: log\ncreated: 2026-10-01\n---\n")).toBe(true);
    expect(head).toContain("# Thursday, October 1, 2026\n\n## Index\n");
  });
  test("a line for a start and a park; the others stay out of the daily note", () => {
    expect(DAILY_EVENTS.has("started")).toBe(true);
    expect(DAILY_EVENTS.has("parked")).toBe(true);
    expect(DAILY_EVENTS.has("input")).toBe(false);
    expect(dailyLine(sprout(), "started")).toBe(
      "\n- **incubator: Change counter** - started in canopy's incubator as _incubator/change-counter. Note: [[02 - Dev/incubator/change-counter|change-counter]]\n",
    );
    expect(dailyLine(sprout({ status: "parked", parked: "the scout workflow is not installed" }), "parked")).toContain(
      "parked: the scout workflow is not installed.",
    );
  });
});

describe("sproutNote", () => {
  test("the path", () => {
    expect(sproutNotePath("change-counter")).toBe("02 - Dev/incubator/change-counter.md");
  });
  test("intent, the inputs index with summaries, stages and spending; nothing raw", () => {
    const md = sproutNote(sprout(), "## What the user said\n\nCount coins.");
    expect(md).toContain("status: clarifying");
    expect(md).toContain("# Change counter");
    expect(md).toContain("## What the user said\n\nCount coins.");
    expect(md).toContain("- [1] text text: count coins at the laundromat");
    expect(md).toContain("- [2] audio voice.webm: not transcribed: no speech model");
    expect(md).toContain("- clarify: done");
    expect(md).toContain("1 agent run, 3 minutes of agent work.");
  });
  test("a parked sprout says why; one with no intent yet says so", () => {
    const md = sproutNote(sprout({ status: "parked", parked: "budget spent: 2 runs" }), null);
    expect(md).toContain("Parked: budget spent: 2 runs");
    expect(md).toContain("Clarify has not written the intent yet.");
  });
  test("open questions are counted", () => {
    const q = { question: "Who?", header: "", options: [], multiSelect: false };
    expect(sproutNote(sprout({ questions: [q, { ...q, question: "Where?" }] }), null)).toContain("2 questions wait for the user.");
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `SHELL=/bin/bash bun test src/core/sproutnote.test.ts`
Expected: FAIL, `Cannot find module './sproutnote'`.

- [ ] **Step 3: Write `src/core/sproutnote.ts`**

```ts
/**
 * The vault's view of a sprout: one note per project at
 * `02 - Dev/incubator/<slug>.md`, rewritten whole at each change, and a
 * line in that day's daily note when a project starts or parks (later
 * phases add live and rejected). An index and summaries only: no raw input
 * and no transcript ever reaches the vault. Pure, so it is tested.
 */
import type { Sprout, SproutStatus } from "./types";

export type NoteEvent = "started" | "questions" | "input" | "parked" | "stopped";

/** the events that also put a line in the day's note */
export const DAILY_EVENTS: ReadonlySet<NoteEvent> = new Set<NoteEvent>(["started", "parked"]);

export const sproutNotePath = (slug: string): string => `02 - Dev/incubator/${slug}.md`;

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const pad2 = (n: number): string => String(n).padStart(2, "0");
const ymd = (d: Date): string => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;

export function dailyNotePath(d: Date): string {
  return `01 - Daily Notes/${pad2(d.getMonth() + 1)} - ${MONTHS[d.getMonth()] ?? ""} ${d.getFullYear()}/${ymd(d)}.md`;
}

/** what a daily note starts with when canopy is the first to write that day */
export function dailyNoteHead(d: Date): string {
  return [
    "---",
    "status: active",
    "project: personal",
    "type: log",
    `created: ${ymd(d)}`,
    "---",
    `# ${DAYS[d.getDay()] ?? ""}, ${MONTHS[d.getMonth()] ?? ""} ${d.getDate()}, ${d.getFullYear()}`,
    "",
    "## Index",
    "",
  ].join("\n");
}

const link = (s: Sprout): string => `[[${sproutNotePath(s.slug).replace(/\.md$/, "")}|${s.slug}]]`;

export function dailyLine(s: Sprout, event: NoteEvent): string {
  const what =
    event === "started"
      ? `started in canopy's incubator as ${s.repoId}`
      : event === "parked"
        ? `parked: ${s.parked ?? "no reason given"}`
        : event;
  return `\n- **incubator: ${s.title}** - ${what}. Note: ${link(s)}\n`;
}

const STATUS_WORD: Record<SproutStatus, string> = {
  queued: "Waiting its turn.",
  clarifying: "Clarifying what is wanted.",
  researching: "Researching what exists.",
  building: "Building.",
  testing: "Testing.",
  accepting: "Checking the work against the intent.",
  deploying: "Deploying.",
  live: "Live.",
  parked: "Parked.",
  rejected: "Rejected.",
  "handed-off": "Handed off as a branch.",
  stopped: "Stopped by the user.",
};

function statusLine(s: Sprout): string {
  if (s.status === "parked") return `Parked: ${s.parked ?? "no reason given"}`;
  const n = s.questions?.length ?? 0;
  return n ? `${STATUS_WORD[s.status]} ${n} ${n === 1 ? "question waits" : "questions wait"} for the user.` : STATUS_WORD[s.status];
}

function spentLine(s: Sprout): string {
  const runs = s.spent.runs;
  const minutes = Math.round(s.spent.workMs / 60_000);
  return `${runs} agent ${runs === 1 ? "run" : "runs"}, ${minutes} ${minutes === 1 ? "minute" : "minutes"} of agent work.`;
}

const flat = (t: string): string => t.replace(/\s+/g, " ").trim();

/** the whole note; `intent` is the seed's intent.md, null before clarify wrote one */
export function sproutNote(s: Sprout, intent: string | null): string {
  const inputs = s.inputs.map((e) => `- [${e.n}] ${e.kind} ${flat(e.label)}: ${flat(e.summary || e.note || "not summarized yet")}`);
  const stages = s.flows.map((f) => `- ${f.workflow}: ${f.outcome ?? "running"}`);
  return [
    "---",
    "type: project",
    `status: ${s.status}`,
    `created: ${ymd(new Date(s.createdAt))}`,
    "source: canopy incubator",
    `seed: ${s.repoId}`,
    "---",
    `# ${s.title}`,
    "",
    statusLine(s),
    "",
    "## Intent",
    "",
    intent?.trim() || "Clarify has not written the intent yet.",
    "",
    "## Inputs",
    "",
    ...(inputs.length ? inputs : ["None yet."]),
    "",
    "## Stages",
    "",
    ...(stages.length ? stages : ["None has run yet."]),
    "",
    "## Spent",
    "",
    spentLine(s),
    "",
    "<!-- canopy rewrites this note at each change; edits here are replaced -->",
    "",
  ].join("\n");
}
```

- [ ] **Step 4: Run it**

Run: `SHELL=/bin/bash bun test src/core/sproutnote.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/sproutnote.ts src/core/sproutnote.test.ts
git commit -m "feat(incubator): the vault note and the daily line, as text

Claude-Session: https://claude.ai/code/session_01DMvREFYoLgpGe2oQNWq1Xu"
```

---

### Task 4: Writing to the vault through the gateway

**Files:**
- Create: `src/core/vault.ts`
- Test: `src/core/vault.test.ts`

**Interfaces:**
- Consumes: nothing of this plan's.
- Produces: `interface VaultConfig { url: string; token: string }`, `vaultConfig(env?): VaultConfig | null`, `class VaultError extends Error { status }`, `class VaultNotes { put(path, text, rev: string | undefined): Promise<string | undefined>; append(path, line, head): Promise<void> }`, `vaultNotes(cfg): VaultNotes | null`. Task 8's `NoteSink` interface has exactly `put` and `append` with these signatures, so `VaultNotes` fits it without importing it.

The gateway's write API (`~/dev/infra/memory-gateway`, `src/gateway/index.ts` and `writes.ts`), as checked for this plan:

- `POST /write {op, path, content, base_rev?}` with `Authorization: Bearer <token>`. `200 {rev, seq, hash, path}` committed; `202 {outboxId}` queued, no rev; `409 {error: "exists" | "stale-base" | "interleaved", headRev}`; `404` for append or replace on a missing note; `400` for replace without `base_rev`; `401`/`403` for the token.
- `GET /file?path=` answers the note with an `x-vault-rev` header (may be `""`), 404 when missing.
- `append` never conflicts.

So `put` creates when it has no rev, replaces with the rev it has, takes the `headRev` a 409 hands back (or reads it off `/file`) and tries again, and creates again on a 404. canopy owns these notes, so overwriting a newer edit is the intent. `append` on a missing daily note creates it with the head and the line; if that create meets 409 `exists` (another writer just made it), it appends again.

- [ ] **Step 1: Write the failing test**

Create `src/core/vault.test.ts`:

```ts
/** VaultNotes against a stand-in gateway with the real one's write rules. */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { VaultError, VaultNotes, vaultConfig } from "./vault";

const notes = new Map<string, { text: string; rev: number }>();
let revs = 0;
let queueNext = false;
let server: ReturnType<typeof Bun.serve>;

const reply = (body: unknown, status = 200) => Response.json(body, { status });

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      if (req.headers.get("authorization") !== "Bearer t0k") return reply({ error: "no token" }, 401);
      const url = new URL(req.url);
      if (url.pathname === "/file" && req.method === "GET") {
        const n = notes.get(url.searchParams.get("path") ?? "");
        if (!n) return reply({ error: "not found" }, 404);
        return new Response(n.text, { headers: { "x-vault-rev": String(n.rev) } });
      }
      if (url.pathname !== "/write" || req.method !== "POST") return reply({ error: "no route" }, 404);
      const b = (await req.json()) as { op: string; path: string; content: string; base_rev?: string };
      if (queueNext) {
        queueNext = false;
        return reply({ outboxId: 1 }, 202);
      }
      const n = notes.get(b.path);
      const commit = (text: string) => {
        revs += 1;
        notes.set(b.path, { text, rev: revs });
        return reply({ rev: String(revs), seq: revs, hash: "h", path: b.path });
      };
      if (b.op === "create") return n ? reply({ error: "exists", headRev: String(n.rev) }, 409) : commit(b.content);
      if (!n) return reply({ error: `${b.path} does not exist` }, 404);
      if (b.op === "append") return commit(n.text + b.content);
      if (b.op === "replace") {
        if (b.base_rev === undefined) return reply({ error: "replace needs base_rev" }, 400);
        return b.base_rev === String(n.rev) ? commit(b.content) : reply({ error: "stale-base", headRev: String(n.rev) }, 409);
      }
      return reply({ error: "bad op" }, 400);
    },
  });
});

afterAll(() => server.stop(true));

beforeEach(() => {
  notes.clear();
  queueNext = false;
});

const vault = (token = "t0k") => new VaultNotes({ url: `http://127.0.0.1:${server.port}`, token });

describe("put", () => {
  test("no rev creates; the rev it returns replaces", async () => {
    const r1 = await vault().put("a.md", "one", undefined);
    expect(notes.get("a.md")?.text).toBe("one");
    const r2 = await vault().put("a.md", "two", r1);
    expect(notes.get("a.md")?.text).toBe("two");
    expect(r2).not.toBe(r1);
  });
  test("a stale rev takes the head's and still writes", async () => {
    await vault().put("a.md", "one", undefined);
    const rev = await vault().put("a.md", "mine", "999");
    expect(notes.get("a.md")?.text).toBe("mine");
    expect(rev).toBe(String(notes.get("a.md")?.rev));
  });
  test("no rev on a note that exists (a lost record) replaces it", async () => {
    await vault().put("a.md", "old", undefined);
    await vault().put("a.md", "new", undefined);
    expect(notes.get("a.md")?.text).toBe("new");
  });
  test("a rev for a note that went away creates it again", async () => {
    await vault().put("gone.md", "back", "5");
    expect(notes.get("gone.md")?.text).toBe("back");
  });
  test("queued is no rev", async () => {
    queueNext = true;
    expect(await vault().put("q.md", "x", undefined)).toBeUndefined();
  });
  test("a refused token throws with its status", async () => {
    const err = await vault("wrong").put("a.md", "x", undefined).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(VaultError);
    expect((err as VaultError).status).toBe(401);
  });
});

describe("append", () => {
  test("a missing daily note is made with its head, then appended to", async () => {
    await vault().append("d.md", "\n- one\n", "# Day\n");
    expect(notes.get("d.md")?.text).toBe("# Day\n\n- one\n");
    await vault().append("d.md", "\n- two\n", "# Day\n");
    expect(notes.get("d.md")?.text).toBe("# Day\n\n- one\n\n- two\n");
  });
});

describe("vaultConfig", () => {
  test("off without a token and under bun test; the default gateway otherwise", () => {
    expect(vaultConfig({})).toBeNull();
    expect(vaultConfig({ CANOPY_VAULT_TOKEN: "x", NODE_ENV: "test" })).toBeNull();
    expect(vaultConfig({ CANOPY_VAULT_TOKEN: " x " })).toEqual({ url: "https://mem.beric.ca", token: "x" });
    expect(vaultConfig({ CANOPY_VAULT_TOKEN: "x", CANOPY_VAULT_URL: "http://gw:8787/" })).toEqual({ url: "http://gw:8787", token: "x" });
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `SHELL=/bin/bash bun test src/core/vault.test.ts`
Expected: FAIL, `Cannot find module './vault'`.

- [ ] **Step 3: Write `src/core/vault.ts`**

```ts
/**
 * The incubator's writes to the memory vault, through the gateway's write
 * API (the one `vault write` uses) with a token of canopy's own,
 * `CANOPY_VAULT_TOKEN`. Only the token in the env is read, never the
 * vault CLI's token file, and nothing under `bun test`: the tests pass a
 * stand-in.
 */

export interface VaultConfig {
  url: string;
  token: string;
}

export function vaultConfig(env: Record<string, string | undefined> = process.env): VaultConfig | null {
  if (env["NODE_ENV"] === "test") return null;
  const token = env["CANOPY_VAULT_TOKEN"]?.trim();
  if (!token) return null;
  const url = (env["CANOPY_VAULT_URL"]?.trim() || "https://mem.beric.ca").replace(/\/+$/, "");
  return { url, token };
}

export class VaultError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);

const TIMEOUT = 20_000;

export class VaultNotes {
  constructor(
    private readonly cfg: VaultConfig,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  private auth(): Record<string, string> {
    return { authorization: `Bearer ${this.cfg.token}` };
  }

  private async write(op: "create" | "append" | "replace", path: string, content: string, baseRev?: string): Promise<{ status: number; body: Record<string, unknown> }> {
    const res = await this.fetcher(`${this.cfg.url}/write`, {
      method: "POST",
      headers: { ...this.auth(), "content-type": "application/json" },
      body: JSON.stringify({ op, path, content, ...(baseRev ? { base_rev: baseRev } : {}) }),
      signal: AbortSignal.timeout(TIMEOUT),
    });
    const body: unknown = await res.json().catch(() => ({}));
    return { status: res.status, body: isObj(body) ? body : {} };
  }

  private refused(path: string, r: { status: number; body: Record<string, unknown> }): VaultError {
    return new VaultError(r.status, `${path}: ${str(r.body["error"]) ?? `the gateway answered ${r.status}`}`);
  }

  /** the note's revision as the gateway has it now; undefined when there is none */
  private async headRev(path: string): Promise<string | undefined> {
    const res = await this.fetcher(`${this.cfg.url}/file?path=${encodeURIComponent(path)}`, {
      headers: this.auth(),
      signal: AbortSignal.timeout(TIMEOUT),
    });
    await res.arrayBuffer().catch(() => undefined);
    if (res.status === 404) return undefined;
    if (!res.ok) throw new VaultError(res.status, `${path}: reading it answered ${res.status}`);
    return str(res.headers.get("x-vault-rev"));
  }

  /** Writes the whole note. Answers the revision to replace it with next,
   *  or undefined when the gateway queued the write. */
  async put(path: string, text: string, rev: string | undefined): Promise<string | undefined> {
    let base = rev;
    for (let attempt = 0; attempt < 3; attempt++) {
      const r = base ? await this.write("replace", path, text, base) : await this.write("create", path, text);
      if (r.status === 200) return str(r.body["rev"]);
      if (r.status === 202) return undefined;
      if (r.status === 404 && base) {
        base = undefined;
        continue;
      }
      if (r.status === 409) {
        base = str(r.body["headRev"]) ?? (await this.headRev(path));
        if (!base) throw new VaultError(409, `${path}: in conflict, with no revision to replace yet`);
        continue;
      }
      throw this.refused(path, r);
    }
    throw new VaultError(409, `${path}: still in conflict after three tries`);
  }

  /** Adds a line at the end; a note that is not there yet is made from `head`. */
  async append(path: string, line: string, head: string): Promise<void> {
    const r = await this.write("append", path, line);
    if (r.status === 200 || r.status === 202) return;
    if (r.status !== 404) throw this.refused(path, r);
    const c = await this.write("create", path, `${head}${line}`);
    if (c.status === 200 || c.status === 202) return;
    if (c.status !== 409) throw this.refused(path, c);
    // made by someone else a moment ago
    const again = await this.write("append", path, line);
    if (again.status !== 200 && again.status !== 202) throw this.refused(path, again);
  }
}

export const vaultNotes = (cfg: VaultConfig | null): VaultNotes | null => (cfg ? new VaultNotes(cfg) : null);
```

- [ ] **Step 4: Run it**

Run: `SHELL=/bin/bash bun test src/core/vault.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/vault.ts src/core/vault.test.ts
git commit -m "feat(incubator): write notes through the memory gateway

Claude-Session: https://claude.ai/code/session_01DMvREFYoLgpGe2oQNWq1Xu"
```

---

### Task 5: Transcribing a voice memo

**Files:**
- Create: `src/core/transcribe.ts`
- Test: `src/core/transcribe.test.ts`

**Interfaces:**
- Consumes: nothing of this plan's.
- Produces: `interface TranscribeConfig { url: string; key: string | null; model: string }`, `transcribeConfig(env?): TranscribeConfig | null`, `TRANSCRIBE_TIMEOUT`, `transcribe(cfg, data: Uint8Array, name, type, fetcher?, timeoutMs?): Promise<string>`, `transcriber(cfg): ((data, name, type) => Promise<string>) | null`.

The mini has no whisper of its own and voice-svc speaks only. The endpoint is any OpenAI-compatible `POST <url>/v1/audio/transcriptions` (multipart `file`, `model`, `response_format=json`, answer `{text}`); on the mini that is LiteLLM on :4000 with a model named `transcribe` (see "Ops after the code lands" at the end).

- [ ] **Step 1: Write the failing test**

Create `src/core/transcribe.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { transcribe, transcribeConfig, type TranscribeConfig } from "./transcribe";

let server: ReturnType<typeof Bun.serve>;
let answer: () => Response = () => Response.json({ text: " hello there " });
let seen: { model: string; name: string; type: string; size: number; auth: string | null } | null = null;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      if (new URL(req.url).pathname !== "/v1/audio/transcriptions") return new Response("no", { status: 404 });
      const form = await req.formData();
      const file = form.get("file");
      seen = {
        model: String(form.get("model")),
        name: typeof file === "string" || !file ? "" : file.name,
        type: typeof file === "string" || !file ? "" : file.type,
        size: typeof file === "string" || !file ? 0 : file.size,
        auth: req.headers.get("authorization"),
      };
      return answer();
    },
  });
});

afterAll(() => server.stop(true));

const cfg = (): TranscribeConfig => ({ url: `http://127.0.0.1:${server.port}`, key: "k", model: "transcribe" });
const audio = new Uint8Array([1, 2, 3, 4]);

describe("transcribe", () => {
  test("posts the file and the model, answers the text trimmed", async () => {
    expect(await transcribe(cfg(), audio, "voice.webm", "audio/webm")).toBe("hello there");
    expect(seen).toEqual({ model: "transcribe", name: "voice.webm", type: "audio/webm", size: 4, auth: "Bearer k" });
  });
  test("an error status, an answer that is not JSON, or one with no text all throw", async () => {
    answer = () => new Response("model not found", { status: 404 });
    await expect(transcribe(cfg(), audio, "v.webm", "audio/webm")).rejects.toThrow("answered 404: model not found");
    answer = () => new Response("<html>", { status: 200 });
    await expect(transcribe(cfg(), audio, "v.webm", "audio/webm")).rejects.toThrow("not JSON");
    answer = () => Response.json({ words: [] });
    await expect(transcribe(cfg(), audio, "v.webm", "audio/webm")).rejects.toThrow("no text");
    answer = () => Response.json({ text: "ok" });
  });
});

describe("transcribeConfig", () => {
  test("off without a url and under bun test; the model defaults to transcribe", () => {
    expect(transcribeConfig({})).toBeNull();
    expect(transcribeConfig({ CANOPY_TRANSCRIBE_URL: "http://x:4000", NODE_ENV: "test" })).toBeNull();
    expect(transcribeConfig({ CANOPY_TRANSCRIBE_URL: "http://x:4000/" })).toEqual({ url: "http://x:4000", key: null, model: "transcribe" });
    expect(transcribeConfig({ CANOPY_TRANSCRIBE_URL: "http://x:4000", CANOPY_TRANSCRIBE_KEY: "k", CANOPY_TRANSCRIBE_MODEL: "whisper" })).toEqual({
      url: "http://x:4000",
      key: "k",
      model: "whisper",
    });
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `SHELL=/bin/bash bun test src/core/transcribe.test.ts`
Expected: FAIL, `Cannot find module './transcribe'`.

- [ ] **Step 3: Write `src/core/transcribe.ts`**

```ts
/**
 * A voice memo into text at intake, through any OpenAI-compatible
 * transcription endpoint (`CANOPY_TRANSCRIBE_URL`, a key and a model name
 * beside it). Off with no url, and always off under `bun test`.
 */

export interface TranscribeConfig {
  /** the server's origin; `/v1/audio/transcriptions` is added */
  url: string;
  key: string | null;
  model: string;
}

export function transcribeConfig(env: Record<string, string | undefined> = process.env): TranscribeConfig | null {
  if (env["NODE_ENV"] === "test") return null;
  const url = env["CANOPY_TRANSCRIBE_URL"]?.trim();
  if (!url) return null;
  return {
    url: url.replace(/\/+$/, ""),
    key: env["CANOPY_TRANSCRIBE_KEY"]?.trim() || null,
    model: env["CANOPY_TRANSCRIBE_MODEL"]?.trim() || "transcribe",
  };
}

/** a long memo takes a while; past this the audio is kept untranscribed */
export const TRANSCRIBE_TIMEOUT = 180_000;

export async function transcribe(
  cfg: TranscribeConfig,
  data: Uint8Array,
  name: string,
  type: string,
  fetcher: typeof fetch = fetch,
  timeoutMs = TRANSCRIBE_TIMEOUT,
): Promise<string> {
  const form = new FormData();
  // a copy, so the part is a plain ArrayBuffer-backed view
  form.append("file", new File([new Uint8Array(data)], name || "audio", { type: type || "application/octet-stream" }));
  form.append("model", cfg.model);
  form.append("response_format", "json");
  const res = await fetcher(`${cfg.url}/v1/audio/transcriptions`, {
    method: "POST",
    body: form,
    headers: cfg.key ? { authorization: `Bearer ${cfg.key}` } : {},
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`the speech model answered ${res.status}: ${text.trim().slice(0, 200)}`);
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error("the speech model's answer is not JSON");
  }
  if (typeof body !== "object" || body === null || typeof (body as { text?: unknown }).text !== "string") {
    throw new Error("the speech model's answer has no text");
  }
  // checked just above
  return (body as { text: string }).text.trim();
}

export const transcriber = (cfg: TranscribeConfig | null): ((data: Uint8Array, name: string, type: string) => Promise<string>) | null =>
  cfg ? (data, name, type) => transcribe(cfg, data, name, type) : null;
```

- [ ] **Step 4: Run it**

Run: `SHELL=/bin/bash bun test src/core/transcribe.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/transcribe.ts src/core/transcribe.test.ts
git commit -m "feat(incubator): transcribe voice memos through an OpenAI-style endpoint

Claude-Session: https://claude.ai/code/session_01DMvREFYoLgpGe2oQNWq1Xu"
```

---

### Task 6: The sprout record files

**Files:**
- Create: `src/core/sproutstore.ts`
- Test: `src/core/sproutstore.test.ts`

**Interfaces:**
- Consumes: `isSproutId`, `parseSproutRecord` (Task 1); `configDir` (existing, `src/core/store.ts:105`).
- Produces: `incubatorDir(): string` (`$CANOPY_CONFIG_DIR/incubator`), `class SproutFiles` with `list(): Promise<Sprout[]>`, `save(s): Promise<void>`, `writeInput(id, name, data: Uint8Array | string): Promise<void>`, `readInput(id, name): Promise<Uint8Array>`, `inputsDir(id): string`, `writeIndex(id, text): Promise<void>`, `dismiss(id): Promise<void>`. These match Task 8's `IncubatorStore`.

Layout: `incubator/<id>/sprout.json`, `incubator/<id>/inputs.md`, `incubator/<id>/inputs/<name>`, all 0600 in 0700 folders, the volume the shells container shares. A dismissed sprout's folder moves to `incubator/.dismissed/<id>`: every input the user gave stays logged, as the spec asks, and `list` passes over it.

- [ ] **Step 1: Write the failing test**

Create `src/core/sproutstore.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SproutFiles } from "./sproutstore";
import type { Sprout } from "./types";

let dir: string;
let files: SproutFiles;

const sprout = (id: string): Sprout => ({
  id,
  slug: "s",
  title: "s",
  status: "queued",
  repoId: "_incubator/s",
  seedPath: "/root/_incubator/s",
  prepared: false,
  inputs: [],
  clarified: false,
  reclarify: false,
  flows: [],
  spent: { runs: 0, workMs: 0 },
  createdAt: 1,
  updatedAt: 1,
});

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "canopy-sprouts-"));
  files = new SproutFiles(dir);
});

afterAll(() => rm(dir, { recursive: true, force: true }));

describe("SproutFiles", () => {
  test("a saved sprout lists back, private to the user", async () => {
    await files.save(sprout("sp_000000000001"));
    expect((await files.list()).map((s) => s.id)).toEqual(["sp_000000000001"]);
    expect((await stat(join(dir, "sp_000000000001", "sprout.json"))).mode & 0o777).toBe(0o600);
    expect((await stat(join(dir, "sp_000000000001"))).mode & 0o777).toBe(0o700);
  });
  test("a half-written record is skipped, not fatal", async () => {
    await files.save(sprout("sp_000000000002"));
    await writeFile(join(dir, "sp_000000000002", "sprout.json"), '{"id": "sp_0000');
    expect((await files.list()).map((s) => s.id)).toEqual(["sp_000000000001"]);
  });
  test("inputs are written once, read back, and never outside the folder", async () => {
    const id = "sp_000000000001";
    await files.writeInput(id, "001-text.md", "hello");
    expect(new TextDecoder().decode(await files.readInput(id, "001-text.md"))).toBe("hello");
    await expect(files.writeInput(id, "001-text.md", "again")).rejects.toThrow();
    await expect(files.writeInput(id, "../escape", "x")).rejects.toThrow("not an input name");
    await expect(files.writeInput(id, ".hidden", "x")).rejects.toThrow("not an input name");
    await expect(files.writeInput("../../etc", "a", "x")).rejects.toThrow("not a sprout id");
    expect((await stat(join(files.inputsDir(id), "001-text.md"))).mode & 0o777).toBe(0o600);
  });
  test("the index is written beside the record", async () => {
    await files.writeIndex("sp_000000000001", "# Inputs\n");
    expect(await readFile(join(dir, "sp_000000000001", "inputs.md"), "utf8")).toBe("# Inputs\n");
  });
  test("dismiss keeps the inputs under .dismissed and drops the sprout from the list", async () => {
    await files.dismiss("sp_000000000001");
    expect(await files.list()).toEqual([]);
    expect(await readFile(join(dir, ".dismissed", "sp_000000000001", "inputs", "001-text.md"), "utf8")).toBe("hello");
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `SHELL=/bin/bash bun test src/core/sproutstore.test.ts`
Expected: FAIL, `Cannot find module './sproutstore'`.

- [ ] **Step 3: Write `src/core/sproutstore.ts`**

```ts
/**
 * The incubator's files under the config dir: one folder per sprout with
 * its record, its inputs index and its raw inputs. Raw inputs live here and
 * never in the seed, which is peer-synced and whose WIP snapshots take
 * untracked files.
 */
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isSproutId, parseSproutRecord } from "./sprout";
import { configDir } from "./store";
import type { Sprout } from "./types";

export const incubatorDir = (): string => join(configDir(), "incubator");

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export class SproutFiles {
  constructor(private readonly dir: string = incubatorDir()) {}

  private home(id: string): string {
    if (!isSproutId(id)) throw new Error(`not a sprout id: ${id}`);
    return join(this.dir, id);
  }

  inputsDir(id: string): string {
    return join(this.home(id), "inputs");
  }

  private input(id: string, name: string): string {
    if (!NAME.test(name)) throw new Error(`not an input name: ${name}`);
    return join(this.inputsDir(id), name);
  }

  async list(): Promise<Sprout[]> {
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch {
      return [];
    }
    const out: Sprout[] = [];
    for (const name of names.filter(isSproutId).sort()) {
      const text = await readFile(join(this.dir, name, "sprout.json"), "utf8").catch(() => null);
      const s = text === null ? null : parseSproutRecord(text);
      if (s && s.id === name) out.push(s);
      else console.error(`incubator: skipped ${name}/sprout.json, which is missing or unreadable`);
    }
    return out;
  }

  /** whole, through a rename, so a crash leaves the old record or the new one */
  async save(s: Sprout): Promise<void> {
    const home = this.home(s.id);
    await mkdir(home, { recursive: true, mode: 0o700 });
    const tmp = join(home, `.sprout.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`);
    await writeFile(tmp, `${JSON.stringify(s, null, 2)}\n`, { mode: 0o600 });
    await rename(tmp, join(home, "sprout.json"));
  }

  /** once: an input is never overwritten */
  async writeInput(id: string, name: string, data: Uint8Array | string): Promise<void> {
    const file = this.input(id, name);
    await mkdir(this.inputsDir(id), { recursive: true, mode: 0o700 });
    await writeFile(file, data, { mode: 0o600, flag: "wx" });
  }

  async readInput(id: string, name: string): Promise<Uint8Array> {
    return new Uint8Array(await readFile(this.input(id, name)));
  }

  async writeIndex(id: string, text: string): Promise<void> {
    const home = this.home(id);
    await mkdir(home, { recursive: true, mode: 0o700 });
    await writeFile(join(home, "inputs.md"), text, { mode: 0o600 });
  }

  async dismiss(id: string): Promise<void> {
    const away = join(this.dir, ".dismissed");
    await mkdir(away, { recursive: true, mode: 0o700 });
    await rename(this.home(id), join(away, id));
  }
}
```

- [ ] **Step 4: Run it**

Run: `SHELL=/bin/bash bun test src/core/sproutstore.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/sproutstore.ts src/core/sproutstore.test.ts
git commit -m "feat(incubator): sprout records and raw inputs under the config dir

Claude-Session: https://claude.ai/code/session_01DMvREFYoLgpGe2oQNWq1Xu"
```

---

### Task 7: The seed repo

**Files:**
- Create: `src/core/seed.ts`
- Test: `src/core/seed.test.ts`

**Interfaces:**
- Consumes: `git`, `exec` (existing, `src/core/exec.ts`); `networkOrigin` (existing, `src/core/peersync.ts:386`); `IncubatorSeeds` (Task 8, type only: write this file's `seedOps` to the shape given here, and Task 8 declares the interface with the same members).
- Produces: `makeSeed(path, files: Record<string, string>, clone: string | undefined, opts: { self: string; originOk?: (url: string) => boolean; cloneTimeoutMs?: number }): Promise<void>`, `commitSeed(path, rels, message, self): Promise<boolean>`, `readSeed(path, rel): Promise<string | null>`, `writeSeed(path, rel, text): Promise<void>`, `SEED_READ_MAX = 256 * 1024`, `seedOps(self): { make, read, write, commit, exists }`.

The seed is a plain git repo at `<root>/_incubator/<slug>`: `git init -b main` for a new idea, or a clone of the given repo with its `origin` renamed `upstream` (phase 4's renovate adds the private repo as `origin`). Every commit is canopy's, by environment identity like a peer WIP snapshot, so a machine with no `user.email` still commits. `readSeed` refuses a symlink and a file over 256 KB: the agent writes these files, and a symlinked `intent.md` would otherwise carry its target into the vault note.

- [ ] **Step 1: Write the failing test**

Create `src/core/seed.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git } from "./exec";
import { commitSeed, makeSeed, readSeed, writeSeed } from "./seed";

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "canopy-seed-"));
});
afterAll(() => rm(dir, { recursive: true, force: true }));

const log = async (path: string) => (await git(path, ["log", "--format=%an <%ae>|%s"])).stdout.trim().split("\n");

describe("makeSeed", () => {
  test("a new idea is a fresh repo on main with the files in one canopy commit", async () => {
    const path = join(dir, "_incubator", "idea");
    await makeSeed(path, { ".canopy/brief.md": "# Idea\n", ".canopy/inputs.md": "# Inputs\n" }, undefined, { self: "mini" });
    expect(await readFile(join(path, ".canopy", "brief.md"), "utf8")).toBe("# Idea\n");
    expect((await git(path, ["branch", "--show-current"])).stdout.trim()).toBe("main");
    expect(await log(path)).toEqual(["canopy <canopy@mini>|seed: a new project from the incubator"]);
  });
  test("a folder that is there already is refused", async () => {
    const path = join(dir, "taken");
    await mkdir(path);
    await expect(makeSeed(path, {}, undefined, { self: "mini" })).rejects.toThrow("is there already");
  });
  test("a local path is never cloned", async () => {
    await expect(makeSeed(join(dir, "c1"), {}, "/etc", { self: "mini" })).rejects.toThrow("not a network git url");
  });
  test("a clone keeps its history, calls its remote upstream, and gets the files on top", async () => {
    const up = join(dir, "upstream");
    await mkdir(up);
    await git(up, ["init", "-q", "-b", "main"]);
    await writeFile(join(up, "README.md"), "hi\n");
    await git(up, ["add", "README.md"]);
    await git(up, ["-c", "user.name=u", "-c", "user.email=u@x", "commit", "-q", "-m", "first"]);
    const path = join(dir, "_incubator", "cloned");
    await makeSeed(path, { ".canopy/brief.md": "# C\n" }, up, { self: "mini", originOk: () => true });
    expect((await git(path, ["remote"])).stdout.trim()).toBe("upstream");
    expect(await log(path)).toEqual(["canopy <canopy@mini>|seed: a new project from the incubator", "u <u@x>|first"]);
  });
});

describe("commitSeed", () => {
  test("only the named files, and nothing when they did not change", async () => {
    const path = join(dir, "_incubator", "idea");
    await writeFile(join(path, ".canopy", "intent.md"), "want\n");
    await writeFile(join(path, "stray.txt"), "not mine\n");
    expect(await commitSeed(path, [".canopy/intent.md", ".canopy/missing.md"], "clarify: Idea", "mini")).toBe(true);
    expect((await log(path))[0]).toBe("canopy <canopy@mini>|clarify: Idea");
    expect((await git(path, ["status", "--porcelain"])).stdout).toContain("?? stray.txt");
    expect(await commitSeed(path, [".canopy/intent.md"], "again", "mini")).toBe(false);
  });
});

describe("readSeed and writeSeed", () => {
  test("a plain file reads; a missing one is null", async () => {
    const path = join(dir, "_incubator", "idea");
    expect(await readSeed(path, ".canopy/intent.md")).toBe("want\n");
    expect(await readSeed(path, ".canopy/nothing.md")).toBeNull();
  });
  test("a symlink is refused both ways, and so is a file too big to be the agent's words", async () => {
    const path = join(dir, "_incubator", "idea");
    await writeFile(join(dir, "secret"), "key\n");
    await symlink(join(dir, "secret"), join(path, ".canopy", "questions.json"));
    await expect(readSeed(path, ".canopy/questions.json")).rejects.toThrow("symlink");
    await expect(writeSeed(path, ".canopy/questions.json", "[]")).rejects.toThrow("symlink");
    await writeFile(join(path, ".canopy", "big.md"), "x".repeat(256 * 1024 + 1));
    await expect(readSeed(path, ".canopy/big.md")).rejects.toThrow("over 256 KB");
  });
  test("writeSeed makes the folder it needs", async () => {
    const path = join(dir, "_incubator", "idea");
    await writeSeed(path, ".canopy/deep/x.md", "x");
    expect(await readFile(join(path, ".canopy", "deep", "x.md"), "utf8")).toBe("x");
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `SHELL=/bin/bash bun test src/core/seed.test.ts`
Expected: FAIL, `Cannot find module './seed'`.

- [ ] **Step 3: Write `src/core/seed.ts`**

```ts
/**
 * A sprout's seed: the git repo at `<root>/_incubator/<slug>` that the scan
 * shows as a card and every stage's agent works in. canopy makes it,
 * writes the `.canopy/` files the spec names, and commits them as itself.
 * The agent writes these files too, so canopy reads them as plain files
 * only: never through a symlink, never past 256 KB.
 */
import { existsSync } from "node:fs";
import { lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { exec, git } from "./exec";
import { networkOrigin } from "./peersync";

export const SEED_READ_MAX = 256 * 1024;

/** environment identity, not config: the backend's own git identity may be
 *  unset (a container), and these commits are canopy's */
const identity = (self: string): Record<string, string> => ({
  GIT_AUTHOR_NAME: "canopy",
  GIT_AUTHOR_EMAIL: `canopy@${self}`,
  GIT_COMMITTER_NAME: "canopy",
  GIT_COMMITTER_EMAIL: `canopy@${self}`,
});

const firstLine = (s: string): string => s.trim().split("\n")[0] ?? "";

export async function commitSeed(path: string, rels: string[], message: string, self: string): Promise<boolean> {
  const present = rels.filter((r) => existsSync(join(path, r)));
  if (present.length === 0) return false;
  const add = await git(path, ["add", "--", ...present]);
  if (add.code !== 0) throw new Error(`git add: ${firstLine(add.stderr)}`);
  const staged = await git(path, ["diff", "--cached", "--quiet", "--", ...present]);
  if (staged.code === 0) return false;
  const c = await git(path, ["-c", "commit.gpgsign=false", "commit", "-q", "-m", message, "--", ...present], 30_000, identity(self));
  if (c.code !== 0) throw new Error(`git commit: ${firstLine(c.stderr)}`);
  return true;
}

export async function makeSeed(
  path: string,
  files: Record<string, string>,
  clone: string | undefined,
  opts: { self: string; originOk?: (url: string) => boolean; cloneTimeoutMs?: number },
): Promise<void> {
  if (existsSync(path)) throw new Error(`${path} is there already`);
  await mkdir(dirname(path), { recursive: true });
  if (clone) {
    if (!(opts.originOk ?? networkOrigin)(clone)) throw new Error(`not a network git url: ${clone}`);
    const r = await exec(["git", "clone", "--quiet", "--", clone, path], {
      timeoutMs: opts.cloneTimeoutMs ?? 600_000,
      env: { GIT_TERMINAL_PROMPT: "0" },
    });
    if (r.code !== 0) {
      await rm(path, { recursive: true, force: true });
      throw new Error(`git clone failed: ${firstLine(r.stderr)}`);
    }
    const mv = await git(path, ["remote", "rename", "origin", "upstream"]);
    if (mv.code !== 0) throw new Error(`git remote rename: ${firstLine(mv.stderr)}`);
  } else {
    await mkdir(path);
    const r = await git(path, ["init", "-q", "-b", "main"]);
    if (r.code !== 0) throw new Error(`git init: ${firstLine(r.stderr)}`);
  }
  for (const [rel, text] of Object.entries(files)) await writeSeed(path, rel, text);
  await commitSeed(path, Object.keys(files), "seed: a new project from the incubator", opts.self);
}

/** a file the agent wrote, or null when it is not there */
export async function readSeed(path: string, rel: string): Promise<string | null> {
  const file = join(path, rel);
  const st = await lstat(file).catch(() => null);
  if (!st) return null;
  if (st.isSymbolicLink()) throw new Error(`${rel} is a symlink; canopy reads only plain files in the seed`);
  if (!st.isFile()) throw new Error(`${rel} is not a file`);
  if (st.size > SEED_READ_MAX) throw new Error(`${rel} is over 256 KB`);
  return readFile(file, "utf8");
}

export async function writeSeed(path: string, rel: string, text: string): Promise<void> {
  const file = join(path, rel);
  const st = await lstat(file).catch(() => null);
  if (st?.isSymbolicLink()) throw new Error(`${rel} is a symlink; canopy writes only plain files in the seed`);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, text);
}

/** the seed operations as the Incubator takes them */
export function seedOps(self: string) {
  return {
    make: (path: string, files: Record<string, string>, clone: string | undefined) => makeSeed(path, files, clone, { self }),
    read: readSeed,
    write: writeSeed,
    commit: async (path: string, rels: string[], message: string): Promise<void> => {
      await commitSeed(path, rels, message, self);
    },
    exists: (path: string): boolean => existsSync(path),
  };
}
```

- [ ] **Step 4: Run it**

Run: `SHELL=/bin/bash bun test src/core/seed.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/seed.ts src/core/seed.test.ts
git commit -m "feat(incubator): the seed repo, made and committed as canopy

Claude-Session: https://claude.ai/code/session_01DMvREFYoLgpGe2oQNWq1Xu"
```

---

### Task 8: The Incubator, from intake through clarify

**Files:**
- Create: `src/core/incubator.ts`
- Test: `src/core/incubator.test.ts`

**Interfaces:**
- Consumes: everything in `src/core/sprout.ts` (Task 1); `NoteEvent`, `DAILY_EVENTS`, `sproutNote`, `sproutNotePath`, `dailyNotePath`, `dailyNoteHead`, `dailyLine` (Task 3); `networkOrigin` (existing); `isFlowActive`, `Flow`, `FlowChoice`, `Repo`, `Workflow` (existing types); phase 1's `Flow.spent`.
- Produces:
  - `class IncubatorError extends Error { status }`
  - `interface IntakeFile { label; type; data: Uint8Array }`, `interface Intake { text; urls; files; repo?; via: InputVia }`
  - `interface IncubatorStore` (`list`, `save`, `writeInput`, `readInput`, `inputsDir`, `writeIndex`, `dismiss`: the `SproutFiles` methods of Task 6)
  - `interface IncubatorSeeds { make(path, files, clone): Promise<void>; read(path, rel): Promise<string | null>; write(path, rel, text): Promise<void>; commit(path, rels, message): Promise<void>; exists(path): boolean }` (Task 7's `seedOps`)
  - `interface IncubatorFlows { start(repo, workflow, note): Promise<Flow>; get(id): Flow | undefined; resume(id, choice: FlowChoice): Flow; stop(id): Flow }`
  - `interface NoteSink { put(path, text, rev): Promise<string | undefined>; append(path, line, head): Promise<void> }` (Task 4's `VaultNotes`)
  - `type Transcriber = (data: Uint8Array, name: string, type: string) => Promise<string>`
  - `interface IncubatorDeps { root; store; seeds; flows; workflow(name): Promise<Workflow | undefined>; rescan(): Promise<void>; repo(id): Repo | undefined; transcribe: Transcriber | null; notes: NoteSink | null; onChange(s); onGone(id); autostart?; now?; newId?; log? }`
  - `SEED_FILES`, `newSproutId()`
  - `class Incubator` with `list()`, `get(id)`, `ownsFlow(flowId)`, `create(intake)`, `onFlow(flow)`, `idle()`. Task 9 adds the rest.

How it moves:

- `create` checks the intake (400 nothing given or a bad link or repo url, 415 a type canopy does not take, 413 past 25 MB a file or 100 MB in all), writes every input under the sprout's `inputs/`, saves the record as `queued`, and answers. Everything slow happens behind it in `prepare`: transcription, the seed (a clone can take minutes), the index, and a rescan so the seed is a repo the flows can find by its id `_incubator/<slug>`. A route answering after a clone would meet the tunnel's timeout.
- `pump` starts queued, prepared sprouts while fewer than `SPROUT_CONCURRENCY` hold a slot. It claims the slot by setting the status before anything awaits, so two pumps in a row never start the same sprout twice.
- A stage is a flow: `startStage` looks the workflow up (a missing one parks the sprout with "the scout workflow is not installed", which is where every sprout stops in this phase), gives clarify read access to the inputs folder through `withInputsRead`, and starts it with `stageNote`.
- `onFlow` sees every broadcast of every flow. It acts only when an owned flow's status changed since it last looked, and leaves the work to a microtask so it never starts a flow inside another flow's callback.
- A gated flow parks the sprout with the gate's reason; one running again unparks it. A flow that failed or stopped parks it. A clarify flow that finished is read back: questions (parked in the inbox, holding no slot) or none (queued for research), the summaries clarify wrote into `inputs.md`, the title from the brief's heading, and a commit of the three `.canopy/` files.
- Every change saves the record, broadcasts it, and rewrites the vault note one write at a time per sprout (so each replace has the revision the last one returned); a start and a park also put a line in the daily note. A vault failure is logged and tried again at the next change; it never stops a sprout.

- [ ] **Step 1: Write the failing test**

Create `src/core/incubator.test.ts`:

```ts
/**
 * The Incubator with fakes for everything it touches: the record files,
 * the seed, the flows, the vault and the speech model.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { Incubator, IncubatorError, type IncubatorDeps, type IncubatorFlows, type IncubatorSeeds, type IncubatorStore, type Intake, type NoteSink } from "./incubator";
import type { Flow, FlowChoice, Repo, Sprout, Workflow } from "./types";

const CLARIFY: Workflow = {
  name: "clarify",
  label: "clarify",
  verb: "clarify",
  blurb: "b",
  when: "any",
  expectsChange: false,
  notePlaceholder: "",
  noteRequired: false,
  listed: false,
  steps: [{ name: "Clarify", tools: ["Edit"], turns: 40, check: null, gate: "continue", body: "Clarify.", retries: 0, back: "Clarify", evidence: [] }],
  budget: { runs: 2, hours: 0.34 },
  source: "bundled",
  file: "/clarify.md",
};
const SCOUT: Workflow = { ...CLARIFY, name: "scout", verb: "scout", listed: false, file: "/scout.md" };

const clone = <T>(v: T): T => structuredClone(v);

class FakeStore implements IncubatorStore {
  records = new Map<string, Sprout>();
  inputs = new Map<string, Map<string, Uint8Array>>();
  indexes = new Map<string, string>();
  dismissed: string[] = [];
  async list(): Promise<Sprout[]> {
    return [...this.records.values()].map(clone);
  }
  async save(s: Sprout): Promise<void> {
    this.records.set(s.id, clone(s));
  }
  async writeInput(id: string, name: string, data: Uint8Array | string): Promise<void> {
    const m = this.inputs.get(id) ?? new Map<string, Uint8Array>();
    if (m.has(name)) throw new Error("exists");
    m.set(name, typeof data === "string" ? new TextEncoder().encode(data) : data);
    this.inputs.set(id, m);
  }
  async readInput(id: string, name: string): Promise<Uint8Array> {
    const d = this.inputs.get(id)?.get(name);
    if (!d) throw new Error(`no input ${name}`);
    return d;
  }
  inputsDir(id: string): string {
    return `/config/incubator/${id}/inputs`;
  }
  async writeIndex(id: string, text: string): Promise<void> {
    this.indexes.set(id, text);
  }
  async dismiss(id: string): Promise<void> {
    this.dismissed.push(id);
    this.records.delete(id);
  }
}

class FakeSeeds implements IncubatorSeeds {
  files = new Map<string, Map<string, string>>();
  made: { path: string; clone: string | undefined }[] = [];
  commits: { path: string; message: string }[] = [];
  failMake: string | null = null;
  async make(path: string, files: Record<string, string>, cloneUrl: string | undefined): Promise<void> {
    if (this.failMake) throw new Error(this.failMake);
    this.made.push({ path, clone: cloneUrl });
    this.files.set(path, new Map(Object.entries(files)));
  }
  async read(path: string, rel: string): Promise<string | null> {
    return this.files.get(path)?.get(rel) ?? null;
  }
  async write(path: string, rel: string, text: string): Promise<void> {
    const m = this.files.get(path) ?? new Map<string, string>();
    m.set(rel, text);
    this.files.set(path, m);
  }
  async commit(path: string, _rels: string[], message: string): Promise<void> {
    this.commits.push({ path, message });
  }
  exists(path: string): boolean {
    return this.files.has(path);
  }
}

class FakeFlows implements IncubatorFlows {
  flows = new Map<string, Flow>();
  started: { repoId: string; workflow: Workflow; note: string }[] = [];
  resumed: { id: string; choice: FlowChoice }[] = [];
  listener: (f: Flow) => void = () => {};
  private n = 0;
  async start(repo: Repo, workflow: Workflow, note: string): Promise<Flow> {
    this.n += 1;
    const f: Flow = {
      id: `flow${this.n}`,
      repoId: repo.id,
      workflow: workflow.name,
      verb: workflow.verb,
      note,
      status: "working",
      steps: workflow.steps.map((s) => ({ name: s.name, status: "running" })),
      current: 0,
      startedAt: 0,
    };
    this.flows.set(f.id, f);
    this.started.push({ repoId: repo.id, workflow, note });
    this.listener(f);
    return f;
  }
  get(id: string): Flow | undefined {
    return this.flows.get(id);
  }
  /** a flow moving on, as Flows broadcasts it */
  move(id: string, patch: Partial<Flow>): Flow {
    const was = this.flows.get(id);
    if (!was) throw new Error(`no flow ${id}`);
    const f = { ...was, ...patch };
    this.flows.set(id, f);
    this.listener(f);
    return f;
  }
  resume(id: string, choice: FlowChoice): Flow {
    this.resumed.push({ id, choice });
    return this.move(id, { status: "working" });
  }
  stop(id: string): Flow {
    return this.move(id, { status: "stopped" });
  }
}

class FakeNotes implements NoteSink {
  puts: { path: string; text: string; rev: string | undefined }[] = [];
  lines: { path: string; line: string }[] = [];
  fail = false;
  private rev = 0;
  async put(path: string, text: string, rev: string | undefined): Promise<string | undefined> {
    if (this.fail) throw new Error("gateway down");
    this.puts.push({ path, text, rev });
    this.rev += 1;
    return String(this.rev);
  }
  async append(path: string, line: string): Promise<void> {
    if (this.fail) throw new Error("gateway down");
    this.lines.push({ path, line });
  }
}

interface World {
  inc: Incubator;
  store: FakeStore;
  seeds: FakeSeeds;
  flows: FakeFlows;
  notes: FakeNotes;
  changes: Sprout[];
  gone: string[];
  logs: string[];
  rescans: number;
  workflows: Map<string, Workflow>;
  repos: Set<string>;
}

let ids = 0;
function world(extra: Partial<IncubatorDeps> = {}): World {
  const w = {
    store: new FakeStore(),
    seeds: new FakeSeeds(),
    flows: new FakeFlows(),
    notes: new FakeNotes(),
    changes: [] as Sprout[],
    gone: [] as string[],
    logs: [] as string[],
    rescans: 0,
    workflows: new Map([["clarify", CLARIFY]]),
    repos: new Set<string>(),
  };
  const inc = new Incubator({
    root: "/root",
    store: w.store,
    seeds: w.seeds,
    flows: w.flows,
    workflow: async (name) => w.workflows.get(name),
    rescan: async () => {
      w.rescans += 1;
      // the scan finds every seed that has been made
      for (const p of w.seeds.files.keys()) w.repos.add(p.replace("/root/", ""));
    },
    repo: (id) => (w.repos.has(id) ? { id, name: id, path: `/root/${id}`, group: "", source: "root", status: null } : undefined),
    transcribe: null,
    notes: w.notes,
    onChange: (s) => w.changes.push(clone(s)),
    onGone: (id) => w.gone.push(id),
    now: () => 1_000,
    newId: () => `sp_${String(++ids).padStart(12, "0")}`,
    log: (line) => w.logs.push(line),
    ...extra,
  });
  w.flows.listener = (f) => inc.onFlow(f);
  return { ...w, inc };
}

const intake = (extra: Partial<Intake> = {}): Intake => ({ text: "", urls: [], files: [], via: "sheet", ...extra });
const audio = (label = "voice.webm") => ({ label, type: "audio/webm;codecs=opus", data: new Uint8Array([1, 2, 3]) });

/** the sprout as the Incubator holds it now */
const now = (w: World, id: string): Sprout => {
  const s = w.inc.get(id);
  if (!s) throw new Error(`no sprout ${id}`);
  return s;
};

beforeEach(() => {
  ids = 0;
});

describe("intake", () => {
  test("text makes a sprout, a seed, a rescan, then clarify with the inputs readable", async () => {
    const w = world();
    const s = await w.inc.create(intake({ text: "A coin counter for the laundromat\nwith a log", urls: ["https://example.com/coins"] }));
    expect(s.status).toBe("queued");
    expect(s.slug).toBe("coin-counter-laundromat-log");
    expect(s.repoId).toBe("_incubator/coin-counter-laundromat-log");
    expect(s.inputs.map((e) => [e.n, e.kind, e.name])).toEqual([
      [1, "text", "001-text.md"],
      [2, "url", "002-link.url"],
    ]);
    await w.inc.idle();
    const after = now(w, s.id);
    expect(after.prepared).toBe(true);
    expect(after.status).toBe("clarifying");
    expect(w.seeds.made).toEqual([{ path: "/root/_incubator/coin-counter-laundromat-log", clone: undefined }]);
    expect(await w.seeds.read(after.seedPath, ".canopy/brief.md")).toBe("# A coin counter for the laundromat\n\nA coin counter for the laundromat\nwith a log\n");
    expect(await w.seeds.read(after.seedPath, ".canopy/inputs.md")).toContain("- [2] url 002-link.url: not summarized yet");
    expect(w.rescans).toBe(1);
    expect(w.flows.started).toHaveLength(1);
    const run = w.flows.started[0];
    expect(run?.workflow.steps[0]?.tools).toContain(`Read(//config/incubator/${s.id}/inputs/**)`);
    expect(run?.note).toContain(`/config/incubator/${s.id}/inputs`);
    expect(after.flows).toEqual([{ workflow: "clarify", flowId: "flow1" }]);
    // the record, the note and the daily line
    expect(w.store.records.get(s.id)?.status).toBe("clarifying");
    expect(w.notes.puts.at(-1)?.path).toBe("02 - Dev/incubator/coin-counter-laundromat-log.md");
    expect(w.notes.lines.map((l) => l.line)).toEqual([expect.stringContaining("started in canopy's incubator")]);
    expect(after.noteRev).toBe(String(w.notes.puts.length));
  });

  test("a voice memo alone, with no speech model: named from the id, marked not transcribed, still clarified", async () => {
    const w = world();
    const s = await w.inc.create(intake({ files: [audio()] }));
    expect(s.slug).toBe("idea-000000");
    expect(s.inputs[0]?.type).toBe("audio/webm");
    await w.inc.idle();
    const after = now(w, s.id);
    expect(after.inputs[0]?.note).toBe("not transcribed: this backend has no speech model set up");
    expect(after.status).toBe("clarifying");
    expect(w.store.indexes.get(s.id)).toContain("- [1] audio 001-voice.webm: not transcribed");
  });

  test("a voice memo with a speech model gets a transcript entry of its own", async () => {
    const w = world({ transcribe: async () => "count the quarters\nand the dimes" });
    const s = await w.inc.create(intake({ files: [audio()] }));
    await w.inc.idle();
    const after = now(w, s.id);
    expect(after.inputs.map((e) => [e.n, e.kind, e.name, e.from])).toEqual([
      [1, "audio", "001-voice.webm", undefined],
      [2, "transcript", "002-voice.txt", 1],
    ]);
    expect(after.inputs[0]?.processed).toBe(true);
    expect(after.inputs[1]?.summary).toBe("count the quarters");
    expect(new TextDecoder().decode(w.store.inputs.get(s.id)?.get("002-voice.txt"))).toBe("count the quarters\nand the dimes");
  });

  test("a speech model that fails leaves the audio raw with the reason", async () => {
    const w = world({
      transcribe: async () => {
        throw new Error("the speech model answered 404: no such model");
      },
    });
    const s = await w.inc.create(intake({ files: [audio()] }));
    await w.inc.idle();
    expect(now(w, s.id).inputs[0]?.note).toBe("not transcribed: the speech model answered 404: no such model");
  });

  test("a repo is cloned into the seed", async () => {
    const w = world();
    const s = await w.inc.create(intake({ repo: "https://github.com/someone/coins.git" }));
    expect(s.slug).toBe("coins");
    await w.inc.idle();
    expect(w.seeds.made[0]?.clone).toBe("https://github.com/someone/coins.git");
  });

  test("the intake refuses nothing, a bad link, a local repo, a zip and an oversized file", async () => {
    const w = world();
    const status = (p: Promise<unknown>) => p.then(() => 0, (e: unknown) => (e instanceof IncubatorError ? e.status : -1));
    expect(await status(w.inc.create(intake({ text: "  " })))).toBe(400);
    expect(await status(w.inc.create(intake({ urls: ["ftp://x"] })))).toBe(400);
    expect(await status(w.inc.create(intake({ repo: "/home/eric/secret" })))).toBe(400);
    expect(await status(w.inc.create(intake({ files: [{ label: "a.zip", type: "application/zip", data: new Uint8Array([1]) }] })))).toBe(415);
    expect(await status(w.inc.create(intake({ files: [{ label: "big.png", type: "image/png", data: new Uint8Array(25 * 1024 * 1024 + 1) }] })))).toBe(413);
    expect(w.inc.list()).toEqual([]);
  });

  test("a seed that cannot be made parks the sprout with why", async () => {
    const w = world();
    w.seeds.failMake = "git clone failed: Repository not found.";
    const s = await w.inc.create(intake({ text: "x" }));
    await w.inc.idle();
    expect(now(w, s.id).status).toBe("parked");
    expect(now(w, s.id).parked).toBe("could not make the seed: git clone failed: Repository not found.");
    expect(w.notes.lines.map((l) => l.line)).toEqual([expect.stringContaining("started"), expect.stringContaining("parked: could not make the seed")]);
  });

  test("a seed the scan does not find parks it", async () => {
    const w = world({ rescan: async () => {} });
    const s = await w.inc.create(intake({ text: "x" }));
    await w.inc.idle();
    expect(now(w, s.id).parked).toBe("the seed folder is gone");
  });
});

describe("clarify's outcome", () => {
  async function clarifying(w: World, text = "coin counter"): Promise<Sprout> {
    const s = await w.inc.create(intake({ text, urls: ["https://example.com/coins"] }));
    await w.inc.idle();
    return now(w, s.id);
  }
  const finish = async (w: World, s: Sprout, files: Record<string, string>) => {
    for (const [rel, text] of Object.entries(files)) await w.seeds.write(s.seedPath, rel, text);
    const flowId = s.flows.at(-1)?.flowId ?? "";
    w.flows.move(flowId, { status: "done", spent: { runs: 1, workMs: 60_000 } });
    await w.inc.idle();
    return now(w, s.id);
  };

  test("questions wait in the record, hold no slot, and the title and summaries come back", async () => {
    const w = world();
    const s = await clarifying(w);
    const index = (await w.seeds.read(s.seedPath, ".canopy/inputs.md")) ?? "";
    const after = await finish(w, s, {
      ".canopy/questions.json": JSON.stringify([{ question: "Who counts?", options: ["staff", "owner"] }]),
      ".canopy/brief.md": "# Coin counter\n\nCounts coins.",
      ".canopy/intent.md": "## What the user said\n\nCount coins.",
      ".canopy/inputs.md": index.replace("002-link.url: not summarized yet", "002-link.url: a page about coin counters"),
    });
    expect(after.status).toBe("clarifying");
    expect(after.clarified).toBe(true);
    expect(after.questions?.map((q) => q.question)).toEqual(["Who counts?"]);
    expect(after.questionsAt).toBe(1_000);
    expect(after.title).toBe("Coin counter");
    expect(after.inputs[1]?.summary).toBe("a page about coin counters");
    expect(after.flows[0]?.outcome).toBe("done");
    expect(after.spent).toEqual({ runs: 1, workMs: 60_000 });
    expect(w.seeds.commits.at(-1)?.message).toBe("clarify: Coin counter");
    // the slot is free: a second and a third sprout both start
    await w.inc.create(intake({ text: "two" }));
    await w.inc.create(intake({ text: "three" }));
    await w.inc.idle();
    expect(w.flows.started).toHaveLength(3);
  });

  test("no questions goes on to research, which parks while scout is not installed", async () => {
    const w = world();
    const after = await finish(w, await clarifying(w), { ".canopy/questions.json": "[]" });
    expect(after.status).toBe("parked");
    expect(after.parked).toBe("the scout workflow is not installed");
  });

  test("with scout installed, research starts", async () => {
    const w = world();
    w.workflows.set("scout", SCOUT);
    const after = await finish(w, await clarifying(w), { ".canopy/questions.json": "[]" });
    expect(after.status).toBe("researching");
    expect(w.flows.started.map((r) => r.workflow.name)).toEqual(["clarify", "scout"]);
    // only clarify reads the raw inputs
    expect(w.flows.started[1]?.workflow.steps[0]?.tools).toEqual(["Edit"]);
  });

  test("a questions.json canopy cannot read parks the sprout", async () => {
    const w = world();
    const after = await finish(w, await clarifying(w), { ".canopy/questions.json": "{nope" });
    expect(after.status).toBe("parked");
    expect(after.parked).toBe("clarify wrote a questions.json canopy cannot read: questions.json is not JSON");
  });

  test("a gate parks the sprout with its reason, and running again unparks it", async () => {
    const w = world();
    const s = await clarifying(w);
    const id = s.flows[0]?.flowId ?? "";
    w.flows.move(id, { status: "gated", steps: [{ name: "Clarify", status: "gated", reason: "budget spent: 2 runs" }] });
    await w.inc.idle();
    expect(now(w, s.id).status).toBe("parked");
    expect(now(w, s.id).parked).toBe("clarify waits after Clarify: budget spent: 2 runs");
    w.flows.move(id, { status: "working" });
    await w.inc.idle();
    expect(now(w, s.id).status).toBe("clarifying");
    expect(now(w, s.id).parked).toBeUndefined();
  });

  test("a flow that fails parks the sprout; a broadcast that changes nothing does nothing", async () => {
    const w = world();
    const s = await clarifying(w);
    const id = s.flows[0]?.flowId ?? "";
    const before = w.changes.length;
    w.flows.move(id, { status: "working" });
    await w.inc.idle();
    expect(w.changes.length).toBe(before);
    w.flows.move(id, { status: "failed", error: "the repo is not in the scan any more" });
    await w.inc.idle();
    expect(now(w, s.id).parked).toBe("clarify failed: the repo is not in the scan any more");
  });
});

describe("the queue", () => {
  test("two run at once; the third waits its turn and starts when one parks", async () => {
    const w = world();
    const a = await w.inc.create(intake({ text: "one" }));
    await w.inc.create(intake({ text: "two" }));
    const c = await w.inc.create(intake({ text: "three" }));
    await w.inc.idle();
    expect(w.flows.started).toHaveLength(2);
    expect(now(w, c.id).status).toBe("queued");
    w.flows.move(now(w, a.id).flows[0]?.flowId ?? "", { status: "failed", error: "x" });
    await w.inc.idle();
    expect(w.flows.started).toHaveLength(3);
    expect(now(w, c.id).status).toBe("clarifying");
  });
});

describe("the vault", () => {
  test("a failing gateway is logged and never stops a sprout", async () => {
    const w = world();
    w.notes.fail = true;
    const s = await w.inc.create(intake({ text: "x" }));
    await w.inc.idle();
    expect(now(w, s.id).status).toBe("clarifying");
    expect(w.logs.some((l) => l.includes("vault note") && l.includes("gateway down"))).toBe(true);
  });
  test("no gateway, no notes", async () => {
    const w = world({ notes: null });
    const s = await w.inc.create(intake({ text: "x" }));
    await w.inc.idle();
    expect(now(w, s.id).noteRev).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `SHELL=/bin/bash bun test src/core/incubator.test.ts`
Expected: FAIL, `Cannot find module './incubator'`.

- [ ] **Step 3: Write `src/core/incubator.ts`**

```ts
/**
 * The incubator (docs/superpowers/specs/2026-10-01-incubator-design.md):
 * one Sprout per new project, carried from intake through clarify and on,
 * one workflow at a time through the existing Flows. It never runs an agent
 * itself. The record files, the seed, the scan, the vault and the speech
 * model are all dependencies, so the tests run it with fakes; the server
 * wires the real ones (server/incubator.ts, server/index.ts).
 */
import { join } from "node:path";
import { networkOrigin } from "./peersync";
import {
  INPUT_FILE_MAX,
  INPUT_TOTAL_MAX,
  SEEDS_DIR,
  SPROUT_CONCURRENCY,
  WORKFLOW_STATUS,
  briefText,
  briefTitle,
  firstLine,
  holdsSlot,
  inputKindOf,
  inputType,
  inputsIndex,
  nextWorkflow,
  parseQuestions,
  parseSummaries,
  safeInputName,
  sproutEnded,
  sproutSlug,
  sproutTitle,
  stageNote,
  withInputsRead,
  withSummaries,
  type ParsedQuestions,
} from "./sprout";
import { DAILY_EVENTS, dailyLine, dailyNoteHead, dailyNotePath, sproutNote, sproutNotePath, type NoteEvent } from "./sproutnote";
import type { Flow, FlowChoice, InputEntry, InputKind, InputVia, Repo, Sprout, SproutFlow, Workflow } from "./types";

export class IncubatorError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface IntakeFile {
  label: string;
  type: string;
  data: Uint8Array;
}

export interface Intake {
  text: string;
  urls: string[];
  files: IntakeFile[];
  /** a repo url to clone into the seed; only when a project starts */
  repo?: string;
  via: InputVia;
}

export interface IncubatorStore {
  list(): Promise<Sprout[]>;
  save(s: Sprout): Promise<void>;
  writeInput(id: string, name: string, data: Uint8Array | string): Promise<void>;
  readInput(id: string, name: string): Promise<Uint8Array>;
  inputsDir(id: string): string;
  writeIndex(id: string, text: string): Promise<void>;
  dismiss(id: string): Promise<void>;
}

export interface IncubatorSeeds {
  /** a new seed repo with these files in its first commit; a repo url clones it */
  make(path: string, files: Record<string, string>, clone: string | undefined): Promise<void>;
  /** a plain file the agent wrote, or null; throws on a symlink */
  read(path: string, rel: string): Promise<string | null>;
  write(path: string, rel: string, text: string): Promise<void>;
  /** the named files only, as canopy */
  commit(path: string, rels: string[], message: string): Promise<void>;
  exists(path: string): boolean;
}

export interface IncubatorFlows {
  start(repo: Repo, workflow: Workflow, note: string): Promise<Flow>;
  get(id: string): Flow | undefined;
  resume(id: string, choice: FlowChoice): Flow;
  stop(id: string): Flow;
}

export interface NoteSink {
  /** the whole note; answers the revision to replace next, undefined when queued */
  put(path: string, text: string, rev: string | undefined): Promise<string | undefined>;
  /** a line at the end; `head` starts a note that is not there yet */
  append(path: string, line: string, head: string): Promise<void>;
}

export type Transcriber = (data: Uint8Array, name: string, type: string) => Promise<string>;

export interface IncubatorDeps {
  /** the launch root; seeds go under `<root>/_incubator/` */
  root: string;
  store: IncubatorStore;
  seeds: IncubatorSeeds;
  flows: IncubatorFlows;
  /** a workflow by name, from the bundled and the user's own only */
  workflow: (name: string) => Promise<Workflow | undefined>;
  /** rescans the launch root, so a new seed is a repo */
  rescan: () => Promise<void>;
  /** a repo in the scan by id */
  repo: (id: string) => Repo | undefined;
  transcribe: Transcriber | null;
  notes: NoteSink | null;
  onChange: (s: Sprout) => void;
  onGone: (id: string) => void;
  /** false keeps every sprout queued: the server tests drive the routes with no agent */
  autostart?: boolean;
  now?: () => number;
  newId?: () => string;
  log?: (line: string) => void;
}

/** what canopy commits to the seed after clarify and after answers; nothing raw */
export const SEED_FILES = [".canopy/brief.md", ".canopy/intent.md", ".canopy/inputs.md"];

export const newSproutId = (): string => `sp_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;

const msg = (err: unknown): string => String(err instanceof Error ? err.message : err);
const enc = new TextEncoder();
const dec = new TextDecoder();
const bytesOf = (data: Uint8Array | string): number => (typeof data === "string" ? enc.encode(data).byteLength : data.byteLength);

export class Incubator {
  private readonly sprouts = new Map<string, Sprout>();
  /** each owned flow's last status, so a broadcast that changes nothing is no transition */
  private readonly seen = new Map<string, Flow["status"]>();
  /** each sprout's vault writes, one after another */
  private readonly noteChain = new Map<string, Promise<void>>();
  /** background work, for `idle` */
  private readonly pending = new Set<Promise<unknown>>();
  private detached = false;

  constructor(private readonly deps: IncubatorDeps) {}

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  private log(line: string): void {
    (this.deps.log ?? console.error)(`incubator: ${line}`);
  }

  private track(p: Promise<unknown>): void {
    const q: Promise<unknown> = p
      .catch((err: unknown) => this.log(msg(err)))
      .finally(() => {
        this.pending.delete(q);
      });
    this.pending.add(q);
  }

  /** resolves once the background work started so far has settled; tests */
  async idle(): Promise<void> {
    for (let i = 0; i < 100; i++) {
      await new Promise((r) => setTimeout(r, 0));
      if (this.pending.size === 0) return;
      await Promise.all([...this.pending]);
    }
  }

  list(): Sprout[] {
    return [...this.sprouts.values()].sort((a, b) => b.createdAt - a.createdAt);
  }

  get(id: string): Sprout | undefined {
    return this.sprouts.get(id);
  }

  ownsFlow(flowId: string): boolean {
    return this.ownerOf(flowId) !== undefined;
  }

  private ownerOf(flowId: string): Sprout | undefined {
    for (const s of this.sprouts.values()) if (s.flows.some((f) => f.flowId === flowId)) return s;
    return undefined;
  }

  /* ---------- intake ---------- */

  /** the intake as canopy takes it: links and the repo url checked, every
   *  file's type normalized, the size caps applied on top of `already` */
  private checkIntake(intake: Intake, already: number, allowRepo: boolean): Intake {
    const urls = intake.urls.map((u) => u.trim()).filter(Boolean);
    for (const u of urls) if (!/^https?:\/\/\S+$/i.test(u)) throw new IncubatorError(400, `not a web link: ${u}`);
    const repo = intake.repo?.trim() || undefined;
    if (repo && !allowRepo) throw new IncubatorError(400, "a repo is given when a project starts, not later");
    if (repo && !networkOrigin(repo)) throw new IncubatorError(400, `not a git url canopy can clone: ${repo}`);
    let total = already + bytesOf(intake.text);
    const files: IntakeFile[] = [];
    for (const f of intake.files) {
      const type = inputType(f.type, f.label);
      if (!type) throw new IncubatorError(415, `${f.label}: canopy takes audio, images, pdf, text and markdown`);
      if (f.data.byteLength > INPUT_FILE_MAX) throw new IncubatorError(413, `${f.label} is over 25 MB`);
      if (f.data.byteLength === 0) throw new IncubatorError(400, `${f.label} is empty`);
      total += f.data.byteLength;
      files.push({ ...f, type });
    }
    if (total > INPUT_TOTAL_MAX) throw new IncubatorError(413, "a project's inputs come to over 100 MB");
    if (!intake.text.trim() && urls.length === 0 && files.length === 0 && !repo) {
      throw new IncubatorError(400, "give an idea, a link, a file or a repo");
    }
    return { text: intake.text, urls, files, ...(repo ? { repo } : {}), via: intake.via };
  }

  /** one input written under inputs/ and added to the record */
  private async addEntry(
    s: Sprout,
    e: { kind: InputKind; label: string; type: string; via: InputVia; summary: string; processed: boolean; from?: number },
    file: string,
    data: Uint8Array | string,
  ): Promise<InputEntry> {
    const n = s.inputs.reduce((m, x) => Math.max(m, x.n), 0) + 1;
    const name = safeInputName(n, file);
    await this.deps.store.writeInput(s.id, name, data);
    const entry: InputEntry = { ...e, n, name, at: this.now(), bytes: bytesOf(data) };
    s.inputs.push(entry);
    return entry;
  }

  private async takeInputs(s: Sprout, intake: Intake): Promise<void> {
    const via = intake.via;
    if (intake.text.trim()) {
      await this.addEntry(s, { kind: "text", label: "text", type: "text/markdown", via, summary: firstLine(intake.text), processed: true }, "text.md", intake.text);
    }
    for (const u of intake.urls) {
      await this.addEntry(s, { kind: "url", label: u, type: "text/uri-list", via, summary: "", processed: false }, "link.url", `${u}\n`);
    }
    if (intake.repo) {
      const summary = "the repo to start from, cloned into the seed";
      await this.addEntry(s, { kind: "url", label: intake.repo, type: "text/uri-list", via, summary, processed: true }, "repo.url", `${intake.repo}\n`);
    }
    for (const f of intake.files) {
      await this.addEntry(s, { kind: inputKindOf(f.type), label: f.label, type: f.type, via, summary: "", processed: false }, f.label, f.data);
    }
  }

  async create(intake: Intake): Promise<Sprout> {
    const clean = this.checkIntake(intake, 0, true);
    const id = (this.deps.newId ?? newSproutId)();
    const repoName = clean.repo?.replace(/\.git$/, "").split(/[/:]/).pop() ?? "";
    const first = clean.text.trim() || repoName || clean.urls[0] || "";
    const taken = (slug: string) => this.deps.seeds.exists(join(this.deps.root, SEEDS_DIR, slug)) || this.list().some((x) => x.slug === slug);
    const slug = sproutSlug(first, id, taken);
    const at = this.now();
    const s: Sprout = {
      id,
      slug,
      title: sproutTitle(clean.text, clean.repo ?? clean.urls[0] ?? clean.files[0]?.label ?? ""),
      status: "queued",
      repoId: `${SEEDS_DIR}/${slug}`,
      seedPath: join(this.deps.root, SEEDS_DIR, slug),
      ...(clean.repo ? { repo: clean.repo } : {}),
      prepared: false,
      inputs: [],
      clarified: false,
      reclarify: false,
      flows: [],
      spent: { runs: 0, workMs: 0 },
      createdAt: at,
      updatedAt: at,
    };
    await this.takeInputs(s, clean);
    this.sprouts.set(id, s);
    await this.changed(s, "started");
    this.track(this.prepare(s));
    return s;
  }

  /** every audio input not yet tried, into a transcript entry of its own */
  private async transcribeAll(s: Sprout): Promise<void> {
    const todo = s.inputs.filter((e) => e.kind === "audio" && !e.processed && !e.note);
    for (const e of todo) {
      if (!this.deps.transcribe) {
        e.note = "not transcribed: this backend has no speech model set up";
        continue;
      }
      let text: string;
      try {
        text = (await this.deps.transcribe(await this.deps.store.readInput(s.id, e.name), e.label, e.type)).trim();
      } catch (err) {
        e.note = `not transcribed: ${msg(err)}`;
        continue;
      }
      if (!text) {
        e.note = "not transcribed: the speech model heard nothing";
        continue;
      }
      const base = e.name.replace(/^\d+-/, "").replace(/\.[^.]*$/, "");
      await this.addEntry(
        s,
        { kind: "transcript", label: `${e.label} (transcript)`, type: "text/plain", via: e.via, summary: firstLine(text), processed: true, from: e.n },
        `${base}.txt`,
        text,
      );
      e.processed = true;
    }
  }

  /** the slow half of intake, behind the route's answer */
  private async prepare(s: Sprout): Promise<void> {
    try {
      await this.transcribeAll(s);
      const index = inputsIndex(s.inputs);
      await this.deps.store.writeIndex(s.id, index);
      if (!this.deps.seeds.exists(s.seedPath)) {
        const t = s.inputs.find((e) => e.kind === "text");
        const text = t ? dec.decode(await this.deps.store.readInput(s.id, t.name)) : "";
        await this.deps.seeds.make(s.seedPath, { ".canopy/brief.md": briefText(s.title, text), ".canopy/inputs.md": index }, s.repo);
      }
      await this.deps.rescan();
    } catch (err) {
      await this.park(s, `could not make the seed: ${msg(err)}`);
      return;
    }
    if (this.detached || s.status !== "queued") return;
    s.prepared = true;
    await this.changed(s);
    this.pump();
  }

  /* ---------- stages ---------- */

  /** starts queued, prepared sprouts, oldest first, while a slot is free */
  private pump(): void {
    if (this.detached || this.deps.autostart === false) return;
    let free = SPROUT_CONCURRENCY - this.list().filter(holdsSlot).length;
    const queued = this.list()
      .filter((s) => s.status === "queued" && s.prepared)
      .sort((a, b) => a.createdAt - b.createdAt);
    for (const s of queued) {
      if (free <= 0) return;
      free -= 1;
      const name = nextWorkflow(s);
      // the slot is claimed here, before anything awaits
      s.status = WORKFLOW_STATUS[name] ?? "researching";
      delete s.parked;
      this.track(this.startStage(s, name));
    }
  }

  private async startStage(s: Sprout, name: string): Promise<void> {
    const repo = this.deps.repo(s.repoId);
    if (!repo) return this.park(s, "the seed folder is gone");
    let wf = await this.deps.workflow(name);
    if (!wf) return this.park(s, `the ${name} workflow is not installed`);
    if (name === "clarify") wf = withInputsRead(wf, this.deps.store.inputsDir(s.id));
    if (this.detached || s.status === "stopped") return;
    let flow: Flow;
    try {
      flow = await this.deps.flows.start(repo, wf, stageNote(s, this.deps.store.inputsDir(s.id)));
    } catch (err) {
      return this.park(s, `${name} did not start: ${msg(err)}`);
    }
    if (name === "clarify") s.reclarify = false;
    s.flows.push({ workflow: name, flowId: flow.id });
    this.seen.set(flow.id, flow.status);
    await this.changed(s);
  }

  /** every flow broadcast; only an owned flow whose status moved is acted on */
  onFlow(flow: Flow): void {
    if (this.detached) return;
    const s = this.ownerOf(flow.id);
    if (!s) return;
    if (this.seen.get(flow.id) === flow.status) return;
    this.seen.set(flow.id, flow.status);
    const entry = s.flows.at(-1);
    // only the current stage, and only until its outcome is on record: a
    // restart that broadcasts an old, finished flow again changes nothing
    if (!entry || entry.flowId !== flow.id || entry.outcome) return;
    // out of the Flows callback before anything starts another flow
    queueMicrotask(() => this.track(this.flowMoved(s, entry, flow)));
  }

  private async flowMoved(s: Sprout, entry: SproutFlow, flow: Flow): Promise<void> {
    if (this.detached || s.status === "stopped") return;
    if (flow.status === "gated") {
      const step = flow.steps[flow.current];
      return this.park(s, `${entry.workflow} waits${step ? ` after ${step.name}` : ""}: ${step?.reason ?? "a gate"}`);
    }
    if (flow.status === "working" || flow.status === "waiting") {
      if (s.status !== "parked") return;
      s.status = WORKFLOW_STATUS[entry.workflow] ?? "researching";
      delete s.parked;
      await this.changed(s);
      return;
    }
    entry.outcome = flow.status;
    s.spent = { runs: s.spent.runs + (flow.spent?.runs ?? 0), workMs: s.spent.workMs + (flow.spent?.workMs ?? 0) };
    if (flow.status !== "done") return this.park(s, `${entry.workflow} ${flow.status}${flow.error ? `: ${flow.error}` : ""}`);
    if (entry.workflow !== "clarify") return this.park(s, `nothing follows ${entry.workflow} yet`);
    try {
      await this.clarified(s);
    } catch (err) {
      await this.park(s, `could not read what clarify wrote: ${msg(err)}`);
    }
  }

  private async commit(s: Sprout, message: string): Promise<void> {
    try {
      await this.deps.seeds.commit(s.seedPath, SEED_FILES, message);
    } catch (err) {
      this.log(`could not commit to ${s.slug}: ${msg(err)}`);
    }
  }

  /** clarify finished: its questions, its summaries, its name for the project */
  private async clarified(s: Sprout): Promise<void> {
    const raw = await this.deps.seeds.read(s.seedPath, ".canopy/questions.json");
    const parsed: ParsedQuestions = raw === null ? { ok: true, questions: [] } : parseQuestions(raw);
    if (!parsed.ok) return this.park(s, `clarify wrote a questions.json canopy cannot read: ${parsed.error}`);
    const md = await this.deps.seeds.read(s.seedPath, ".canopy/inputs.md");
    if (md !== null) s.inputs = withSummaries(s.inputs, parseSummaries(md));
    const brief = await this.deps.seeds.read(s.seedPath, ".canopy/brief.md");
    const heading = brief === null ? null : briefTitle(brief);
    if (heading) s.title = heading;
    const index = inputsIndex(s.inputs);
    await this.deps.store.writeIndex(s.id, index);
    await this.deps.seeds.write(s.seedPath, ".canopy/inputs.md", index);
    await this.commit(s, `clarify: ${s.title}`);
    s.clarified = true;
    if (parsed.questions.length > 0 && !s.reclarify) {
      s.questions = parsed.questions;
      s.questionsAt = this.now();
      s.status = "clarifying";
      await this.changed(s, "questions");
    } else {
      // no questions, or more input came while clarify ran: on to the next stage
      s.status = "queued";
      await this.changed(s);
    }
    this.pump();
  }

  private async park(s: Sprout, reason: string): Promise<void> {
    if (sproutEnded(s)) return;
    s.status = "parked";
    s.parked = reason;
    await this.changed(s, "parked");
    this.pump();
  }

  /* ---------- every change ---------- */

  private async changed(s: Sprout, event?: NoteEvent): Promise<void> {
    s.updatedAt = this.now();
    if (this.detached) return;
    try {
      await this.deps.store.save(s);
    } catch (err) {
      this.log(`could not save ${s.id}: ${msg(err)}`);
    }
    this.deps.onChange(s);
    this.note(s, event);
  }

  /** the vault note, rewritten; a daily line for a start or a park */
  private note(s: Sprout, event?: NoteEvent): void {
    const notes = this.deps.notes;
    if (!notes) return;
    const snap = structuredClone(s);
    const write = async (): Promise<void> => {
      const intent = snap.prepared ? await this.deps.seeds.read(snap.seedPath, ".canopy/intent.md") : null;
      const rev = await notes.put(sproutNotePath(snap.slug), sproutNote(snap, intent), s.noteRev);
      if (rev && rev !== s.noteRev) {
        s.noteRev = rev;
        if (!this.detached) await this.deps.store.save(s);
      }
      if (event && DAILY_EVENTS.has(event)) {
        const day = new Date(this.now());
        await notes.append(dailyNotePath(day), dailyLine(snap, event), dailyNoteHead(day));
      }
    };
    const next = (this.noteChain.get(s.id) ?? Promise.resolve())
      .then(write)
      .catch((err: unknown) => this.log(`the vault note for ${s.slug} was not written (${msg(err)}); it is tried again at the next change`));
    this.noteChain.set(s.id, next);
    this.track(next);
  }
}
```

- [ ] **Step 4: Run it**

Run: `SHELL=/bin/bash bun test src/core/incubator.test.ts`
Expected: PASS. If the `CLARIFY` literal fails to typecheck, phase 1's `WorkflowStep` or `Workflow` fields differ from `retries`, `back`, `evidence` and `budget`: match them to phase 1's `src/core/types.ts`.

- [ ] **Step 5: Typecheck and lint**

Run: `bun run typecheck && bun run lint`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/core/incubator.ts src/core/incubator.test.ts
git commit -m "feat(incubator): intake, the seed, the queue and clarify's outcome

Claude-Session: https://claude.ai/code/session_01DMvREFYoLgpGe2oQNWq1Xu"
```

---

### Task 9: Answers, more input, stop, resume, dismiss and restore

**Files:**
- Modify: `src/core/incubator.ts`
- Test: `src/core/incubator.test.ts` (append)

**Interfaces:**
- Consumes: the class and the fakes of Task 8; `answersText`, `inputsIndex`, `holdsSlot`, `sproutEnded`, `isSproutId` (Task 1); `isFlowActive` (existing).
- Produces, on `Incubator`: `detail(id): Promise<SproutDetail>`, `answer(id, answers: Record<string, string> | null): Promise<Sprout>`, `addInputs(id, intake): Promise<Sprout>`, `stop(id): Promise<Sprout>`, `resume(id, choice: "continue" | "retry"): Promise<Sprout>`, `dismiss(id): Promise<void>`, `restore(): Promise<void>`, `detach(): void`. Every refusal is an `IncubatorError`: 404 for an unknown id, 409 for a sprout in the wrong state.

- [ ] **Step 1: Write the failing tests**

Append to `src/core/incubator.test.ts`:

```ts
describe("answers", () => {
  async function asking(w: World): Promise<Sprout> {
    const s = await w.inc.create(intake({ text: "coin counter" }));
    await w.inc.idle();
    const live = now(w, s.id);
    await w.seeds.write(live.seedPath, ".canopy/questions.json", JSON.stringify([{ question: "Who counts?", options: ["staff"] }]));
    await w.seeds.write(live.seedPath, ".canopy/intent.md", "## What the user said\n\nCount coins.\n");
    w.flows.move(live.flows[0]?.flowId ?? "", { status: "done" });
    await w.inc.idle();
    return now(w, s.id);
  }

  test("answers become an input and the end of intent.md, then research", async () => {
    const w = world();
    w.workflows.set("scout", SCOUT);
    const s = await asking(w);
    const after = await w.inc.answer(s.id, { "Who counts?": "staff" });
    expect(after.questions).toBeUndefined();
    const last = after.inputs.at(-1);
    expect(last?.kind).toBe("answers");
    expect(last?.via).toBe("answer");
    expect(new TextDecoder().decode(w.store.inputs.get(s.id)?.get(last?.name ?? ""))).toContain("- Who counts?\n  staff");
    expect((await w.seeds.read(s.seedPath, ".canopy/intent.md")) ?? "").toContain("Count coins.\n\n## Answers, ");
    expect(w.seeds.commits.at(-1)?.message).toBe("answers: coin counter");
    await w.inc.idle();
    expect(now(w, s.id).status).toBe("researching");
  });

  test("going on assumptions says so and goes on", async () => {
    const w = world();
    const s = await asking(w);
    await w.inc.answer(s.id, null);
    expect((await w.seeds.read(s.seedPath, ".canopy/intent.md")) ?? "").toContain("chose to go on assumptions");
    await w.inc.idle();
    expect(now(w, s.id).parked).toBe("the scout workflow is not installed");
  });

  test("no open questions is a 409, an unknown id a 404", async () => {
    const w = world();
    const s = await w.inc.create(intake({ text: "x" }));
    await w.inc.idle();
    await expect(w.inc.answer(s.id, {})).rejects.toMatchObject({ status: 409 });
    await expect(w.inc.answer("sp_ffffffffffff", {})).rejects.toMatchObject({ status: 404 });
  });
});

describe("more input", () => {
  test("while questions wait, they are dropped and clarify runs again", async () => {
    const w = world();
    const s = await w.inc.create(intake({ text: "x" }));
    await w.inc.idle();
    const live = now(w, s.id);
    await w.seeds.write(live.seedPath, ".canopy/questions.json", JSON.stringify([{ question: "Q?" }]));
    w.flows.move(live.flows[0]?.flowId ?? "", { status: "done" });
    await w.inc.idle();
    const after = await w.inc.addInputs(s.id, intake({ text: "it is for the Rio laundromat" }));
    expect(after.questions).toBeUndefined();
    expect(after.reclarify).toBe(true);
    await w.inc.idle();
    expect(w.flows.started.map((r) => r.workflow.name)).toEqual(["clarify", "clarify"]);
    expect(now(w, s.id).reclarify).toBe(false);
    expect(w.store.indexes.get(s.id)).toContain("- [2] text 002-text.md: it is for the Rio laundromat");
  });

  test("while clarify runs, its questions are passed over and it runs once more", async () => {
    const w = world();
    const s = await w.inc.create(intake({ text: "x" }));
    await w.inc.idle();
    await w.inc.addInputs(s.id, intake({ text: "more" }));
    const live = now(w, s.id);
    await w.seeds.write(live.seedPath, ".canopy/questions.json", JSON.stringify([{ question: "Q?" }]));
    w.flows.move(live.flows[0]?.flowId ?? "", { status: "done" });
    await w.inc.idle();
    expect(now(w, s.id).questions).toBeUndefined();
    expect(w.flows.started.map((r) => r.workflow.name)).toEqual(["clarify", "clarify"]);
  });

  test("a repo is refused after the start, and an ended sprout takes nothing", async () => {
    const w = world();
    const s = await w.inc.create(intake({ text: "x" }));
    await expect(w.inc.addInputs(s.id, intake({ repo: "https://github.com/a/b" }))).rejects.toMatchObject({ status: 400 });
    await w.inc.stop(s.id);
    await expect(w.inc.addInputs(s.id, intake({ text: "y" }))).rejects.toMatchObject({ status: 409 });
  });
});

describe("stop, resume and dismiss", () => {
  test("stop ends the flow, frees the slot, and later flow news is ignored", async () => {
    const w = world();
    const a = await w.inc.create(intake({ text: "one" }));
    await w.inc.create(intake({ text: "two" }));
    const c = await w.inc.create(intake({ text: "three" }));
    await w.inc.idle();
    const stopped = await w.inc.stop(a.id);
    expect(stopped.status).toBe("stopped");
    expect(w.flows.get(stopped.flows[0]?.flowId ?? "")?.status).toBe("stopped");
    await w.inc.idle();
    expect(now(w, a.id).status).toBe("stopped");
    expect(now(w, c.id).status).toBe("clarifying");
  });

  test("resume continues a gated flow, or queues a sprout canopy parked itself", async () => {
    const w = world();
    const s = await w.inc.create(intake({ text: "x" }));
    await w.inc.idle();
    const id = now(w, s.id).flows[0]?.flowId ?? "";
    w.flows.move(id, { status: "gated", steps: [{ name: "Clarify", status: "gated", reason: "budget spent: 2 runs" }] });
    await w.inc.idle();
    const back = await w.inc.resume(s.id, "continue");
    expect(back.status).toBe("clarifying");
    expect(w.flows.resumed).toEqual([{ id, choice: "continue" }]);
    await w.inc.idle();
    expect(now(w, s.id).status).toBe("clarifying");
    // a park with no gated flow behind it runs the stage again
    w.flows.move(id, { status: "failed", error: "x" });
    await w.inc.idle();
    expect(now(w, s.id).status).toBe("parked");
    await w.inc.resume(s.id, "retry");
    await w.inc.idle();
    expect(w.flows.started).toHaveLength(2);
    await expect(w.inc.resume(s.id, "continue")).rejects.toMatchObject({ status: 409 });
  });

  test("dismiss is for an ended sprout; it keeps the inputs and tells the page", async () => {
    const w = world();
    const s = await w.inc.create(intake({ text: "x" }));
    await w.inc.idle();
    await expect(w.inc.dismiss(s.id)).rejects.toMatchObject({ status: 409 });
    await w.inc.stop(s.id);
    await w.inc.dismiss(s.id);
    await expect(w.inc.list()).toEqual([]);
    expect(w.store.dismissed).toEqual([s.id]);
    expect(w.gone).toEqual([s.id]);
  });

  test("detail reads the seed's own words", async () => {
    const w = world();
    const s = await w.inc.create(intake({ text: "x" }));
    await w.inc.idle();
    await w.seeds.write(s.seedPath, ".canopy/intent.md", "want");
    const d = await w.inc.detail(s.id);
    expect(d.intent).toBe("want");
    expect(d.brief).toContain("# x");
    expect(d.research).toBeNull();
    expect(d.inputsIndex).toContain("- [1] text 001-text.md: x");
  });
});

describe("restart", () => {
  /** a second Incubator over the first one's records, seeds and flows */
  function restarted(w: World): World {
    const next = world();
    next.store.records = w.store.records;
    next.store.inputs = w.store.inputs;
    next.seeds.files = w.seeds.files;
    next.flows.flows = w.flows.flows;
    for (const p of w.seeds.files.keys()) next.repos.add(p.replace("/root/", ""));
    return next;
  }

  test("open questions come back as they were", async () => {
    const w = world();
    const s = await w.inc.create(intake({ text: "x" }));
    await w.inc.idle();
    const live = now(w, s.id);
    await w.seeds.write(live.seedPath, ".canopy/questions.json", JSON.stringify([{ question: "Q?" }]));
    w.flows.move(live.flows[0]?.flowId ?? "", { status: "done" });
    await w.inc.idle();
    const r = restarted(w);
    await r.inc.restore();
    await r.inc.idle();
    expect(now(r, s.id).questions?.map((q) => q.question)).toEqual(["Q?"]);
    expect(r.flows.started).toHaveLength(0);
  });

  test("a stage whose flow is gone runs again; one whose flow came back gated parks", async () => {
    const w = world();
    const a = await w.inc.create(intake({ text: "one" }));
    const b = await w.inc.create(intake({ text: "two" }));
    await w.inc.idle();
    const r = restarted(w);
    r.flows.flows.delete(now(w, a.id).flows[0]?.flowId ?? "");
    const gated = now(w, b.id).flows[0]?.flowId ?? "";
    r.flows.flows.set(gated, { ...(r.flows.flows.get(gated) as Flow), status: "gated", steps: [{ name: "Clarify", status: "gated", reason: "canopy restarted" }] });
    r.flows.listener = (f) => r.inc.onFlow(f);
    await r.inc.restore();
    await r.inc.idle();
    expect(r.flows.started.map((x) => x.workflow.name)).toEqual(["clarify"]);
    expect(now(r, a.id).status).toBe("clarifying");
    expect(now(r, b.id).status).toBe("parked");
  });

  test("a sprout caught before its seed was made is prepared again", async () => {
    const w = world({ rescan: async () => new Promise<void>(() => {}) });
    const s = await w.inc.create(intake({ text: "x" }));
    const r = world();
    r.store.records = w.store.records;
    r.store.inputs = w.store.inputs;
    await r.inc.restore();
    await r.inc.idle();
    expect(now(r, s.id).prepared).toBe(true);
    expect(now(r, s.id).status).toBe("clarifying");
  });
});

describe("detach", () => {
  test("after detach, a flow stopping under a server shutdown neither parks nor saves", async () => {
    const w = world();
    const s = await w.inc.create(intake({ text: "x" }));
    await w.inc.idle();
    const saved = structuredClone(w.store.records.get(s.id));
    w.inc.detach();
    w.flows.move(now(w, s.id).flows[0]?.flowId ?? "", { status: "stopped" });
    await w.inc.idle();
    expect(now(w, s.id).status).toBe("clarifying");
    expect(w.store.records.get(s.id)).toEqual(saved);
  });
});
```

The `as Flow` in the restart test is a test's own fixture, read from the map it just filled.

- [ ] **Step 2: Run them to see them fail**

Run: `SHELL=/bin/bash bun test src/core/incubator.test.ts`
Expected: FAIL; `answer`, `addInputs`, `stop`, `resume`, `dismiss`, `detail`, `restore` and `detach` are not functions.

- [ ] **Step 3: Add the methods**

In `src/core/incubator.ts`, add `answersText` and `isSproutId` to the import from `./sprout`, and make the import from `./types` one line that brings the value `isFlowActive` beside the types, `SproutDetail` added: `import { isFlowActive, type Flow, type FlowChoice, type InputEntry, type InputKind, type InputVia, type Repo, type Sprout, type SproutDetail, type SproutFlow, type Workflow } from "./types";`. Then add these methods to the class, after `create`:

```ts
  private need(id: string): Sprout {
    const s = isSproutId(id) ? this.sprouts.get(id) : undefined;
    if (!s) throw new IncubatorError(404, "no such project");
    return s;
  }

  async detail(id: string): Promise<SproutDetail> {
    const s = this.need(id);
    const read = (rel: string): Promise<string | null> => (s.prepared ? this.deps.seeds.read(s.seedPath, rel).catch(() => null) : Promise.resolve(null));
    const [brief, intent, research] = await Promise.all([read(".canopy/brief.md"), read(".canopy/intent.md"), read(".canopy/research.md")]);
    return { sprout: s, brief, intent, inputsIndex: inputsIndex(s.inputs), research };
  }

  /** the clarify batch answered, or skipped with null ("go on assumptions") */
  async answer(id: string, answers: Record<string, string> | null): Promise<Sprout> {
    const s = this.need(id);
    const questions = s.questions;
    if (s.status !== "clarifying" || !questions?.length) throw new IncubatorError(409, "this project has no open questions");
    const askedAt = s.questionsAt;
    // taken at once, so a second answer racing this one finds none
    delete s.questions;
    delete s.questionsAt;
    try {
      const text = answersText(questions, answers, this.now());
      const n = questions.length;
      const summary = answers ? `answered ${n} ${n === 1 ? "question" : "questions"}` : "went on assumptions";
      await this.addEntry(s, { kind: "answers", label: "answers", type: "text/markdown", via: "answer", summary, processed: true }, "answers.md", text);
      const intent = (await this.deps.seeds.read(s.seedPath, ".canopy/intent.md")) ?? "";
      await this.deps.seeds.write(s.seedPath, ".canopy/intent.md", intent.trim() ? `${intent.trimEnd()}\n\n${text}` : text);
      const index = inputsIndex(s.inputs);
      await this.deps.store.writeIndex(s.id, index);
      await this.deps.seeds.write(s.seedPath, ".canopy/inputs.md", index);
    } catch (err) {
      s.questions = questions;
      if (askedAt !== undefined) s.questionsAt = askedAt;
      throw err;
    }
    await this.commit(s, `answers: ${s.title}`);
    s.status = "queued";
    await this.changed(s);
    this.pump();
    return s;
  }

  /** more inputs; after clarify has looked, clarify looks again before the next stage */
  async addInputs(id: string, intake: Intake): Promise<Sprout> {
    const s = this.need(id);
    if (sproutEnded(s)) throw new IncubatorError(409, "this project has ended; start a new one");
    const clean = this.checkIntake(intake, s.inputs.reduce((t, e) => t + e.bytes, 0), false);
    await this.takeInputs(s, clean);
    if (s.clarified || s.status === "clarifying") s.reclarify = true;
    if (s.status === "clarifying" && s.questions) {
      delete s.questions;
      delete s.questionsAt;
      s.status = "queued";
    }
    await this.changed(s, "input");
    this.track(this.afterInputs(s));
    return s;
  }

  private async afterInputs(s: Sprout): Promise<void> {
    await this.transcribeAll(s);
    const index = inputsIndex(s.inputs);
    await this.deps.store.writeIndex(s.id, index);
    if (s.prepared) {
      await this.deps.seeds.write(s.seedPath, ".canopy/inputs.md", index);
      await this.commit(s, `inputs: ${s.title}`);
    }
    await this.changed(s);
    this.pump();
  }

  async stop(id: string): Promise<Sprout> {
    const s = this.need(id);
    if (sproutEnded(s)) return s;
    s.status = "stopped";
    delete s.parked;
    delete s.questions;
    delete s.questionsAt;
    const cur = s.flows.at(-1);
    const f = cur ? this.deps.flows.get(cur.flowId) : undefined;
    if (f && isFlowActive(f)) {
      try {
        this.deps.flows.stop(f.id);
      } catch (err) {
        this.log(`could not stop flow ${f.id}: ${msg(err)}`);
      }
    }
    await this.changed(s, "stopped");
    this.pump();
    return s;
  }

  /** a parked sprout goes on: its gated flow resumed, else its stage run again */
  async resume(id: string, choice: "continue" | "retry"): Promise<Sprout> {
    const s = this.need(id);
    if (s.status !== "parked") throw new IncubatorError(409, "only a parked project resumes");
    const reason = s.parked;
    const cur = s.flows.at(-1);
    const f = cur ? this.deps.flows.get(cur.flowId) : undefined;
    delete s.parked;
    if (cur && f?.status === "gated") {
      // the status first, so the flow's own broadcast finds it running
      s.status = WORKFLOW_STATUS[cur.workflow] ?? "researching";
      try {
        this.deps.flows.resume(f.id, choice);
      } catch (err) {
        s.status = "parked";
        if (reason !== undefined) s.parked = reason;
        throw new IncubatorError(409, msg(err));
      }
      await this.changed(s);
      return s;
    }
    s.status = "queued";
    await this.changed(s);
    if (s.prepared) this.pump();
    else this.track(this.prepare(s));
    return s;
  }

  /** an ended sprout off the list; its seed, inputs and vault note stay */
  async dismiss(id: string): Promise<void> {
    const s = this.need(id);
    if (!sproutEnded(s)) throw new IncubatorError(409, "stop the project first");
    await this.deps.store.dismiss(id);
    this.sprouts.delete(id);
    this.deps.onGone(id);
  }

  /** The sprouts the last server left, after phase 1 restored its flows: a
   *  stage whose flow came back is followed again, one whose flow is gone
   *  runs again, and one caught before its seed was made is prepared again. */
  async restore(): Promise<void> {
    for (const s of await this.deps.store.list()) this.sprouts.set(s.id, s);
    for (const s of this.sprouts.values()) {
      if (sproutEnded(s)) continue;
      if (!s.prepared) {
        if (s.status === "queued") this.track(this.prepare(s));
        continue;
      }
      const cur = s.flows.at(-1);
      if (!cur || !holdsSlot(s)) continue;
      const f = this.deps.flows.get(cur.flowId);
      if (!f) {
        s.status = "queued";
        await this.changed(s);
        continue;
      }
      this.seen.set(f.id, f.status);
      if (f.status !== "working" && f.status !== "waiting") queueMicrotask(() => this.track(this.flowMoved(s, cur, f)));
    }
    this.pump();
  }

  /** before the server stops every flow: nothing after this is saved or acted on */
  detach(): void {
    this.detached = true;
  }
```

- [ ] **Step 4: Run it**

Run: `SHELL=/bin/bash bun test src/core/incubator.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck and lint**

Run: `bun run typecheck && bun run lint`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/core/incubator.ts src/core/incubator.test.ts
git commit -m "feat(incubator): answers, more input, stop, resume, dismiss and restore

Claude-Session: https://claude.ai/code/session_01DMvREFYoLgpGe2oQNWq1Xu"
```

---
### Task 10: The routes, the wiring and the tailchan notices

**Files:**
- Create: `src/server/incubator.ts`
- Modify: `src/server/index.ts` (imports; `ServerState` near line 273; the `Flows` hooks near line 2725; the state literal near line 2838; the route delegation near line 1780; phase 1's `state.flows.restore(` call; `stop()` near line 3201; the `startServer` options near line 2666)
- Modify: `src/core/tailchan.ts` (`sproutNotice`), `src/server/tailchan.ts` (`ChanHub.onSprout`, `isSproutFlow`)
- Test: `src/server/incubator.test.ts`, `src/core/tailchan.test.ts` (append)

**Interfaces:**
- Consumes: `Incubator`, `IncubatorError`, `Intake`, `IntakeFile`, `NoteSink`, `Transcriber` (Tasks 8 and 9); `SproutFiles` (Task 6); `seedOps` (Task 7); `vaultConfig`, `vaultNotes` (Task 4); `transcribeConfig`, `transcriber` (Task 5); `INPUT_TOTAL_MAX` (Task 1); `scanOne`, `scanOpts`, `broadcast`, `stepProfileRefusal`, `needStepHarnesses`, `stepAgentFor`, `loadWorkflows`, `findWorkflow`, `LAUNCH_SOURCE`, `selfName` (existing in `index.ts`); phase 1's `state.flows.restore` and `state.flows.detach`.
- Produces:
  - `readIntake(req: Request): Promise<Intake>`: 415 for anything but multipart, 413 for a body over 101 MB by its length, 400 for a form that does not parse. Fields: `text` (repeatable, joined by a blank line), `url` or `urls[]` (repeatable), `repo`, `file` or `files[]` (repeatable), `via` (`cli`, else `sheet`). The page and the CLI send `url` and `file`; the spec's `urls[]` and `files[]` are read too.
  - `class IncubatorHub { constructor(inc: Incubator); handle(req, url): Promise<Response | null>; onFlow(flow); ownsFlow(id); restore(); detach() }`
  - Routes: `GET /api/incubator` (`Sprout[]`, newest first), `POST /api/incubator` (multipart, 201 `Sprout`), `DELETE /api/incubator?id=`, `GET /api/incubator/one?id=` (`SproutDetail`), `POST /api/incubator/input?id=` (multipart, `Sprout`), `POST /api/incubator/answer?id=` `{answers}` or `{skip: true}`, `POST /api/incubator/stop?id=`, `POST /api/incubator/resume?id=` `{choice: "continue" | "retry"}`, as the spec's API table has them. An `IncubatorError` answers its own status.
  - Events: `{type: "incubator", sprout}` on every change, `{type: "incubator-gone", id}` on dismiss.
  - `startServer({ incubator: { autostart?, transcribe?, notes? } })` for tests; `CANOPY_INCUBATOR_AUTOSTART=0` holds every sprout queued without code (a scratch server, or a pause).
  - `sproutNotice(s: Sprout, prev: { status: SproutStatus; asking: boolean } | undefined): Notice | null`; `ChanHub.onSprout(s)`; `ChanHubDeps.isSproutFlow?: (flowId: string) => boolean`, so the incubator's own flows post nothing of their own.

- [ ] **Step 1: Write the failing notice test**

Append to `src/core/tailchan.test.ts`, and add `sproutNotice` to its import from `./tailchan` and `Sprout` to its type import:

```ts
describe("sproutNotice", () => {
  const base: Sprout = {
    id: "sp_000000000001",
    slug: "coins",
    title: "Coin counter",
    status: "clarifying",
    repoId: "_incubator/coins",
    seedPath: "/root/_incubator/coins",
    prepared: true,
    inputs: [],
    clarified: true,
    reclarify: false,
    flows: [],
    spent: { runs: 0, workMs: 0 },
    createdAt: 0,
    updatedAt: 0,
  };
  test("questions are a DM once, while they wait", () => {
    const q = (question: string) => ({ question, header: "", options: [], multiSelect: false });
    const asking = { ...base, questions: [q("Who?"), q("Where?")] };
    expect(sproutNotice(asking, { status: "clarifying", asking: false })).toEqual({ to: "human", text: "Coin counter: 2 questions before research, in canopy's inbox" });
    expect(sproutNotice(asking, { status: "clarifying", asking: true })).toBeNull();
  });
  test("a park is a DM with why; going live or being turned down goes to the channel", () => {
    expect(sproutNotice({ ...base, status: "parked", parked: "the scout workflow is not installed" }, { status: "clarifying", asking: false })).toEqual({
      to: "human",
      text: "Coin counter is parked: the scout workflow is not installed",
    });
    expect(sproutNotice({ ...base, status: "live" }, { status: "deploying", asking: false })?.to).toBe("channel");
    expect(sproutNotice({ ...base, status: "rejected" }, { status: "researching", asking: false })?.text).toBe("Coin counter was turned down at eval");
  });
  test("every other move is quiet", () => {
    expect(sproutNotice({ ...base, status: "researching" }, { status: "queued", asking: false })).toBeNull();
    expect(sproutNotice({ ...base, status: "parked", parked: "x" }, { status: "parked", asking: false })).toBeNull();
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `SHELL=/bin/bash bun test src/core/tailchan.test.ts`
Expected: FAIL, `sproutNotice` is not exported.

- [ ] **Step 3: Add `sproutNotice`**

In `src/core/tailchan.ts`, add `Sprout` and `SproutStatus` to the type import from `./types`, then after `fleetNotice`:

```ts
/** A sprout's questions or park is a DM, since someone has to look; going
 *  live or being turned down is a channel line. Once per transition. */
export function sproutNotice(s: Sprout, prev: { status: SproutStatus; asking: boolean } | undefined): Notice | null {
  const asking = (s.questions?.length ?? 0) > 0;
  if (asking && !prev?.asking) {
    const n = s.questions?.length ?? 0;
    return { to: "human", text: `${s.title}: ${n} ${n === 1 ? "question" : "questions"} before research, in canopy's inbox` };
  }
  if (s.status === prev?.status) return null;
  if (s.status === "parked") return { to: "human", text: `${s.title} is parked: ${s.parked ?? "no reason given"}` };
  if (s.status === "live") return { to: "channel", text: `${s.title} is live` };
  if (s.status === "rejected") return { to: "channel", text: `${s.title} was turned down at eval` };
  return null;
}
```

- [ ] **Step 4: Run it**

Run: `SHELL=/bin/bash bun test src/core/tailchan.test.ts`
Expected: PASS.

- [ ] **Step 5: Teach `ChanHub` the sprouts**

In `src/server/tailchan.ts`:

1. Add `sproutNotice` to the import from `../core/tailchan`, and `Sprout`, `SproutStatus` to the type import from `../core/types`.
2. In `ChanHubDeps`, after `isFlowRun`, add:

```ts
  /** whether a flow is one of the incubator's stages, which the sprout speaks for */
  isSproutFlow?: (flowId: string) => boolean;
```

3. Beside the `fleets` map, add `private sprouts = new Map<string, { status: SproutStatus; asking: boolean }>();`.
4. In `onFlow`, after `this.flows.set(flow.id, flow.status);`, add `if (this.deps.isSproutFlow?.(flow.id)) return;`.
5. After `onFleet`, add:

```ts
  onSprout(s: Sprout): void {
    const prev = this.sprouts.get(s.id);
    this.sprouts.set(s.id, { status: s.status, asking: (s.questions?.length ?? 0) > 0 });
    this.say(sproutNotice(s, prev));
  }
```

6. In `forget(id)`, add `this.sprouts.delete(id);` beside the other deletes.

- [ ] **Step 6: Write the failing server test**

Create `src/server/incubator.test.ts`:

```ts
/**
 * The incubator's routes on a real server, with autostart off so no agent
 * runs: intake (text, a voice memo, a markdown file sent the way a browser
 * often sends one, refusals), the seed landing in the scan, answers, stop
 * and dismiss, the events, and clarify kept out of every repo's list.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ScanResult, ServerEvent, Sprout, SproutDetail, WorkflowEntry } from "../core/types";
import { startServer } from "./index";

let scratch: string;
let root: string;
let previous: string | undefined;
let server: { port: number; stop: () => void };
const url = (p: string) => `http://127.0.0.1:${server.port}${p}`;

async function until(pred: () => boolean | Promise<boolean>, what: string, ms = 15_000): Promise<void> {
  const start = Date.now();
  while (!(await pred())) {
    if (Date.now() - start > ms) throw new Error(`gave up waiting for ${what}`);
    await Bun.sleep(50);
  }
}

const post = (path: string, form: FormData) => fetch(url(path), { method: "POST", body: form });
const postJson = (path: string, body: unknown) =>
  fetch(url(path), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const detail = async (id: string) => (await (await fetch(url(`/api/incubator/one?id=${id}`))).json()) as SproutDetail;

function form(fields: Record<string, string | Blob | [Blob, string]>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) {
    if (Array.isArray(v)) f.append(k, v[0], v[1]);
    else f.append(k, v);
  }
  return f;
}

/** the first event of a type after `act` */
async function eventAfter(type: ServerEvent["type"], act: () => Promise<unknown>): Promise<ServerEvent> {
  const ctl = new AbortController();
  const res = await fetch(url("/api/events"), { signal: ctl.signal });
  const body = res.body;
  if (!body) throw new Error("no stream");
  const reader = body.getReader();
  const dec = new TextDecoder();
  let buf = dec.decode((await reader.read()).value);
  await act();
  try {
    for (;;) {
      for (const chunk of buf.split("\n\n")) {
        const data = chunk.split("\n").find((l) => l.startsWith("data: "));
        if (!data) continue;
        const ev = JSON.parse(data.slice(6)) as ServerEvent;
        if (ev.type === type) return ev;
      }
      const { value, done } = await reader.read();
      if (done) throw new Error("the stream ended");
      buf += dec.decode(value);
    }
  } finally {
    ctl.abort();
  }
}

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "canopy-inc-"));
  previous = process.env["CANOPY_CONFIG_DIR"];
  process.env["CANOPY_CONFIG_DIR"] = join(scratch, "config");
  root = join(scratch, "root");
  await Bun.$`mkdir -p ${join(root, "app")} && git -C ${join(root, "app")} init -q`.quiet();
  server = await startServer({
    root,
    port: 0,
    chan: null,
    harnesses: ["claude"],
    incubator: { autostart: false, transcribe: async () => "count the quarters", notes: null },
  });
});

afterAll(async () => {
  server.stop();
  if (previous === undefined) delete process.env["CANOPY_CONFIG_DIR"];
  else process.env["CANOPY_CONFIG_DIR"] = previous;
  await rm(scratch, { recursive: true, force: true });
});

describe("intake", () => {
  test("an idea answers at once, then its seed is a repo in the scan with one commit by canopy", async () => {
    const res = await post("/api/incubator", form({ text: "A coin counter for the laundromat", url: "https://example.com/coins" }));
    expect(res.status).toBe(201);
    const s = (await res.json()) as Sprout;
    expect(s.status).toBe("queued");
    expect(s.repoId).toBe("_incubator/coin-counter-laundromat");
    await until(async () => ((await (await fetch(url("/api/tree"))).json()) as ScanResult).repos.some((r) => r.id === s.repoId), "the seed in the scan");
    await until(async () => (await detail(s.id)).sprout.prepared, "the sprout prepared");
    expect(existsSync(join(root, "_incubator/coin-counter-laundromat/.canopy/brief.md"))).toBe(true);
    const log = await Bun.$`git -C ${join(root, "_incubator/coin-counter-laundromat")} log --format=%an%x09%s`.text();
    expect(log.trim()).toMatch(/^canopy\tseed: a new project from the incubator$/);
    const d = await detail(s.id);
    expect(d.brief).toContain("# A coin counter for the laundromat");
    expect(d.inputsIndex).toContain("- [2] url 002-link.url: not summarized yet");
    const list = (await (await fetch(url("/api/incubator"))).json()) as Sprout[];
    expect(list.map((x) => x.id)).toContain(s.id);
  });

  test("a voice memo with its codec named comes in as audio and gets its transcript", async () => {
    const memo = new Blob([new Uint8Array([1, 2, 3])], { type: "audio/webm;codecs=opus" });
    const res = await post("/api/incubator", form({ file: [memo, "voice.webm"] }));
    expect(res.status).toBe(201);
    const s = (await res.json()) as Sprout;
    expect(s.inputs[0]?.type).toBe("audio/webm");
    await until(async () => (await detail(s.id)).sprout.inputs.some((e) => e.kind === "transcript"), "the transcript");
    const t = (await detail(s.id)).sprout.inputs.find((e) => e.kind === "transcript");
    expect(t?.summary).toBe("count the quarters");
  });

  test("a markdown file sent as octet-stream is taken as markdown", async () => {
    const md = new Blob(["# notes\n"], { type: "application/octet-stream" });
    const res = await post("/api/incubator", form({ file: [md, "notes.md"] }));
    expect(res.status).toBe(201);
    expect(((await res.json()) as Sprout).inputs[0]?.type).toBe("text/markdown");
  });

  test("a zip, a JSON body, an empty form and an oversized file are refused", async () => {
    const zip = new Blob([new Uint8Array([1])], { type: "application/zip" });
    expect((await post("/api/incubator", form({ file: [zip, "a.zip"] }))).status).toBe(415);
    expect((await postJson("/api/incubator", { text: "x" })).status).toBe(415);
    expect((await post("/api/incubator", form({ text: " " }))).status).toBe(400);
    const big = new Blob([new Uint8Array(25 * 1024 * 1024 + 1)], { type: "image/png" });
    expect((await post("/api/incubator", form({ file: [big, "big.png"] }))).status).toBe(413);
  });

  test("a new sprout is broadcast", async () => {
    const ev = await eventAfter("incubator", () => post("/api/incubator", form({ text: "a broadcast idea" })));
    expect(ev.type === "incubator" && ev.sprout.title).toBe("a broadcast idea");
  });
});

describe("the rest of the routes", () => {
  test("answers need open questions; an unknown id is a 404", async () => {
    const s = (await (await post("/api/incubator", form({ text: "answers idea" }))).json()) as Sprout;
    expect((await postJson(`/api/incubator/answer?id=${s.id}`, { skip: true })).status).toBe(409);
    expect((await postJson("/api/incubator/answer?id=sp_ffffffffffff", { answers: {} })).status).toBe(404);
    expect((await postJson(`/api/incubator/answer?id=${s.id}`, { answers: { q: 1 } })).status).toBe(400);
  });

  test("more input takes no repo", async () => {
    const s = (await (await post("/api/incubator", form({ text: "input idea" }))).json()) as Sprout;
    expect((await post(`/api/incubator/input?id=${s.id}`, form({ repo: "https://github.com/a/b" }))).status).toBe(400);
    const res = await post(`/api/incubator/input?id=${s.id}`, form({ text: "one more thing" }));
    expect(res.status).toBe(200);
    expect(((await res.json()) as Sprout).inputs.map((e) => e.n)).toEqual([1, 2]);
  });

  test("stop, then dismiss, which keeps the inputs under .dismissed", async () => {
    const s = (await (await post("/api/incubator", form({ text: "stop idea" }))).json()) as Sprout;
    expect((await fetch(url(`/api/incubator?id=${s.id}`), { method: "DELETE" })).status).toBe(409);
    expect((await postJson(`/api/incubator/resume?id=${s.id}`, { choice: "sideways" })).status).toBe(400);
    const stopped = (await (await postJson(`/api/incubator/stop?id=${s.id}`, {})).json()) as Sprout;
    expect(stopped.status).toBe("stopped");
    const ev = await eventAfter("incubator-gone", () => fetch(url(`/api/incubator?id=${s.id}`), { method: "DELETE" }));
    expect(ev.type === "incubator-gone" && ev.id).toBe(s.id);
    expect(existsSync(join(scratch, "config/incubator/.dismissed", s.id))).toBe(true);
    const list = (await (await fetch(url("/api/incubator"))).json()) as Sprout[];
    expect(list.some((x) => x.id === s.id)).toBe(false);
  });

  test("clarify is in no repo's list of workflows", async () => {
    const list = (await (await fetch(url("/api/repos/workflows?id=app"))).json()) as WorkflowEntry[];
    expect(list.some((e) => (e.ok ? e.workflow.name : e.name) === "clarify")).toBe(false);
  });
});
```

- [ ] **Step 7: Run it to see it fail**

Run: `SHELL=/bin/bash bun test src/server/incubator.test.ts`
Expected: FAIL; `startServer` does not take `incubator` and `/api/incubator` answers 404.

- [ ] **Step 8: Write `src/server/incubator.ts`**

```ts
/**
 * The incubator's routes (core/incubator.ts does the work). Intake is
 * multipart so a voice memo or an image comes in as it is; the rest is JSON.
 */
import { INPUT_TOTAL_MAX } from "../core/sprout";
import { IncubatorError, type Incubator, type Intake, type IntakeFile } from "../core/incubator";
import type { Flow } from "../core/types";

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const strings = (vs: FormDataEntryValue[]): string[] => vs.filter((v): v is string => typeof v === "string");

/** a little over the inputs' cap, for the form's own framing */
const BODY_MAX = INPUT_TOTAL_MAX + 1024 * 1024;

export async function readIntake(req: Request): Promise<Intake> {
  const type = (req.headers.get("content-type") ?? "").toLowerCase();
  if (!type.startsWith("multipart/form-data")) throw new IncubatorError(415, "send a project as multipart/form-data");
  const length = Number(req.headers.get("content-length") ?? "0");
  if (length > BODY_MAX) throw new IncubatorError(413, "a project's inputs come to over 100 MB");
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    throw new IncubatorError(400, "the form could not be read");
  }
  const files: IntakeFile[] = [];
  for (const v of [...form.getAll("file"), ...form.getAll("files[]")]) {
    if (typeof v === "string") continue;
    files.push({ label: v.name || "upload", type: v.type, data: new Uint8Array(await v.arrayBuffer()) });
  }
  const repo = form.get("repo");
  return {
    text: strings(form.getAll("text")).join("\n\n"),
    urls: strings([...form.getAll("url"), ...form.getAll("urls[]")]),
    files,
    ...(typeof repo === "string" && repo.trim() ? { repo } : {}),
    via: form.get("via") === "cli" ? "cli" : "sheet",
  };
}

const isAnswers = (v: unknown): v is Record<string, string> => isObj(v) && Object.values(v).every((x) => typeof x === "string");

export class IncubatorHub {
  constructor(readonly inc: Incubator) {}

  onFlow(flow: Flow): void {
    this.inc.onFlow(flow);
  }

  ownsFlow(flowId: string): boolean {
    return this.inc.ownsFlow(flowId);
  }

  restore(): Promise<void> {
    return this.inc.restore();
  }

  detach(): void {
    this.inc.detach();
  }

  async handle(req: Request, url: URL): Promise<Response | null> {
    const path = url.pathname;
    if (path !== "/api/incubator" && !path.startsWith("/api/incubator/")) return null;
    const method = req.method;
    const id = url.searchParams.get("id") ?? "";
    try {
      if (path === "/api/incubator" && method === "GET") return json(this.inc.list());
      if (path === "/api/incubator" && method === "POST") return json(await this.inc.create(await readIntake(req)), 201);
      if (path === "/api/incubator" && method === "DELETE") {
        await this.inc.dismiss(id);
        return json({ ok: true });
      }
      if (path === "/api/incubator/one" && method === "GET") return json(await this.inc.detail(id));
      if (path === "/api/incubator/input" && method === "POST") return json(await this.inc.addInputs(id, await readIntake(req)));
      if (method === "POST" && (path === "/api/incubator/answer" || path === "/api/incubator/stop" || path === "/api/incubator/resume")) {
        if (path === "/api/incubator/stop") return json(await this.inc.stop(id));
        const b: unknown = await req.json().catch(() => null);
        if (!isObj(b)) return json({ error: "send a JSON object" }, 400);
        if (path === "/api/incubator/resume") {
          const choice = b["choice"];
          if (choice !== "continue" && choice !== "retry") return json({ error: "choice is continue or retry" }, 400);
          return json(await this.inc.resume(id, choice));
        }
        if (b["skip"] === true) return json(await this.inc.answer(id, null));
        const answers = b["answers"];
        if (!isAnswers(answers)) return json({ error: "answers are each question's text to an answer's text" }, 400);
        return json(await this.inc.answer(id, answers));
      }
      return json({ error: "not found" }, 404);
    } catch (err) {
      if (err instanceof IncubatorError) return json({ error: err.message }, err.status);
      throw err;
    }
  }
}
```

- [ ] **Step 9: Wire it into the server**

In `src/server/index.ts`:

1. Imports, beside the others of their kind:

```ts
import { Incubator, type NoteSink, type Transcriber } from "../core/incubator";
import { seedOps } from "../core/seed";
import { SproutFiles } from "../core/sproutstore";
import { transcribeConfig, transcriber } from "../core/transcribe";
import { vaultConfig, vaultNotes } from "../core/vault";
import { IncubatorHub } from "./incubator";
```

2. In `interface ServerState`, after `asks: AskHub;`:

```ts
  /** new projects carried from an idea through clarify and on (core/incubator.ts) */
  incubator: IncubatorHub;
```

3. In the `startServer` options, after `asks?: …`:

```ts
  /** the incubator: tests turn autostart off and pass a speech model and vault of their own */
  incubator?: { autostart?: boolean; transcribe?: Transcriber | null; notes?: NoteSink | null };
```

4. In the `new Flows(runner, {` hooks, make `onChange` tell the incubator too:

```ts
    onChange: (flow) => {
      broadcast(state, { type: "flow", flow });
      state.chan.onFlow(flow);
      state.incubator.onFlow(flow);
    },
```

5. In the `ChanHub` deps of the state literal, after `isFlowRun`, add:

```ts
      isSproutFlow: (flowId) => state.incubator.ownsFlow(flowId),
```

6. Just above `const state: ServerState = {`, add:

```ts
  const vault = vaultConfig();
  const speech = transcribeConfig();
  if (process.env["NODE_ENV"] !== "test") {
    if (!vault) console.error("incubator: no CANOPY_VAULT_TOKEN, so no vault notes");
    if (!speech) console.error("incubator: no CANOPY_TRANSCRIBE_URL, so voice memos stay untranscribed");
  }
```

7. In the state literal, after the `asks: new AskHub(…),` entry:

```ts
    incubator: new IncubatorHub(
      new Incubator({
        root,
        store: new SproutFiles(),
        seeds: seedOps(selfName(cfg.self, hostname())),
        flows: {
          // the same checks a flow started from a repo's menu passes
          start: async (repo, wf, note) => {
            const c = await loadConfig();
            const refused = stepProfileRefusal(c, wf);
            if (refused) throw new Error(refused);
            await needStepHarnesses(state, c, wf, [repo.path]);
            return state.flows.start(repo, wf, note, (profile) => stepAgentFor(c, repo.path, profile));
          },
          get: (id) => state.flows.get(id),
          resume: (id, choice) => state.flows.resume(id, choice),
          stop: (id) => state.flows.stop(id),
        },
        // the bundled and the user's own only: a repo's .canopy/workflows never replaces a stage
        workflow: async (name) => findWorkflow(await loadWorkflows({ path: "", host: "none" }), name),
        rescan: async () => {
          const rt = state.sources.find((s) => s.src.id === LAUNCH_SOURCE);
          if (!rt) return;
          // a scan already under way may have walked past the new seed
          if (rt.scanning) await rt.scanning;
          await scanOne(state, rt, scanOpts(state, await loadConfig()));
          broadcast(state, { type: "scan", result: state.result });
        },
        repo: (id) => state.result.repos.find((r) => r.id === id),
        transcribe: opts.incubator?.transcribe !== undefined ? opts.incubator.transcribe : transcriber(speech),
        notes: opts.incubator?.notes !== undefined ? opts.incubator.notes : vaultNotes(vault),
        onChange: (sprout) => {
          broadcast(state, { type: "incubator", sprout });
          state.chan.onSprout(sprout);
        },
        onGone: (id) => {
          broadcast(state, { type: "incubator-gone", id });
          state.chan.forget(id);
        },
        // CANOPY_INCUBATOR_AUTOSTART=0 holds every sprout queued: a scratch
        // server for a UI check, or a pause while something is wrong
        autostart: opts.incubator?.autostart ?? process.env["CANOPY_INCUBATOR_AUTOSTART"] !== "0",
      }),
    ),
```

8. In the route delegation, after `if (askRes) return askRes;`:

```ts
  const incubatorRes = await state.incubator.handle(req, url);
  if (incubatorRes) return incubatorRes;
```

9. After phase 1's `state.flows.restore(…);` call, add:

```ts
  // the sprouts the last server left, once their flows are back
  await state.incubator.restore();
```

10. In the returned `stop()`, put `state.incubator.detach();` on the line before phase 1's `state.flows.detach();`.

- [ ] **Step 10: Run the tests**

Run: `SHELL=/bin/bash bun test src/server/incubator.test.ts src/core/tailchan.test.ts src/server/tailchan.test.ts`
Expected: PASS.

- [ ] **Step 11: Run the whole suite and the gates**

Run: `bun run typecheck && bun run lint && SHELL=/bin/bash bun test`
Expected: PASS. The server suite starts many servers; every one now builds an Incubator over `$CANOPY_CONFIG_DIR/incubator`, which each test points at its own scratch dir.

- [ ] **Step 12: Commit**

```bash
git add src/server/incubator.ts src/server/incubator.test.ts src/server/index.ts src/server/tailchan.ts src/core/tailchan.ts src/core/tailchan.test.ts
git commit -m "feat(incubator): the routes, the server wiring and the tailchan notices

Claude-Session: https://claude.ai/code/session_01DMvREFYoLgpGe2oQNWq1Xu"
```

---
### Task 11: The page's pure parts: stage strip, words, inbox, feed and route

**Files:**
- Create: `ui/src/sprouts.ts`, `ui/src/sprouts.test.ts`
- Modify: `ui/src/inbox.ts` (`InboxSource`, `InboxItem`, `InboxContext`, `flowItem`, `mergeInbox`, `InboxAnswer`, `toRunAnswer`, `toAskAnswer`), `ui/src/feed.ts` (`FeedKind`, `FeedSnapshot`, `describeEvent`), `ui/src/routes.ts` (`sproutHere`, `dropSproutHere`)
- Test: `ui/src/inbox.test.ts`, `ui/src/feed.test.ts`, `ui/src/routes.test.ts` (append each)

**Interfaces:**
- Consumes: `Sprout`, `SproutStatus`, `InputKind`, `ServerEvent` (Task 1); `nextWorkflow`, `sproutEnded`, `isSproutId` (Task 1, browser-safe); phase 1's `Flow.parkedFor`.
- Produces:
  - `ui/src/sprouts.ts`: `STAGES` (`clarify, research, eval, build, test, accept, deploy, retro`), `type Stage`, `type StageMark = "done" | "now" | "stuck" | "todo"`, `stageAt(s): Stage | null`, `stageStrip(s): { stage: Stage; mark: StageMark }[]`, `sproutWord(s): string`, `needsYou(s): boolean`, `sortSprouts(list): Sprout[]`, `INPUT_GLYPH: Record<InputKind, string>`, `sproutLines(ev, prev, at): FeedLine[]`.
  - `ui/src/inbox.ts`: `InboxSource` gains `"sprout"`, `InboxItem["kind"]` gains `"clarify"` (the spec's name for the question batch), `InboxItem.budget?: true` (a gate a flow's budget parked), `InboxContext.sprouts?: readonly Sprout[]`, `InboxAnswer` gains `{ skip: true }` ("go on assumptions").
  - `ui/src/feed.ts`: `FeedKind` gains `"incubator"`; `FeedSnapshot.sprouts?: Record<string, Sprout>`.
  - `ui/src/routes.ts`: `sproutHere(search: string): string | null` (`?view=incubator&sprout=<id>`), `dropSproutHere(): void`.

- [ ] **Step 1: Write the failing tests**

Create `ui/src/sprouts.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import type { Sprout } from "../../src/core/types";
import type { FeedSnapshot } from "./feed";
import { needsYou, sortSprouts, sproutLines, sproutWord, stageAt, stageStrip } from "./sprouts";

const sprout = (over: Partial<Sprout> = {}): Sprout => ({
  id: "sp_000000000001",
  slug: "coins",
  title: "Coin counter",
  status: "queued",
  repoId: "_incubator/coins",
  seedPath: "/root/_incubator/coins",
  prepared: true,
  inputs: [],
  clarified: false,
  reclarify: false,
  flows: [],
  spent: { runs: 0, workMs: 0 },
  createdAt: 1,
  updatedAt: 1,
  ...over,
});
const q = (question: string) => ({ question, header: "", options: [], multiSelect: false });
const marks = (s: Sprout) => stageStrip(s).map((x) => `${x.stage}:${x.mark}`).join(" ");

describe("the stage strip", () => {
  test("a fresh sprout has clarify next and nothing done", () => {
    expect(stageAt(sprout())).toBeNull();
    expect(marks(sprout())).toBe("clarify:todo research:todo eval:todo build:todo test:todo accept:todo deploy:todo retro:todo");
  });
  test("clarifying is now; parked there is stuck", () => {
    expect(marks(sprout({ status: "clarifying" })).startsWith("clarify:now research:todo")).toBe(true);
    const parked = sprout({ status: "parked", parked: "x", flows: [{ workflow: "clarify", flowId: "f1", outcome: "failed" }] });
    expect(stageAt(parked)).toBe("clarify");
    expect(marks(parked).startsWith("clarify:stuck research:todo")).toBe(true);
  });
  test("queued after clarify has clarify done and research waiting", () => {
    const s = sprout({ clarified: true, flows: [{ workflow: "clarify", flowId: "f1", outcome: "done" }] });
    expect(marks(s).startsWith("clarify:done research:todo")).toBe(true);
  });
  test("researching covers research; parked in scout is stuck at research", () => {
    expect(marks(sprout({ status: "researching", clarified: true })).startsWith("clarify:done research:now eval:todo")).toBe(true);
    const s = sprout({ status: "parked", parked: "the scout workflow is not installed", clarified: true, flows: [{ workflow: "clarify", flowId: "f1", outcome: "done" }] });
    // the park names scout, which has no flow of its own yet: the stage is the one after the last flow
    expect(stageAt(s)).toBe("research");
  });
  test("live is done through deploy", () => {
    expect(marks(sprout({ status: "live", clarified: true }))).toBe("clarify:done research:done eval:done build:done test:done accept:done deploy:done retro:todo");
  });
});

describe("words and order", () => {
  test("a word for each state that matters here", () => {
    expect(sproutWord(sprout({ prepared: false }))).toBe("making the seed");
    expect(sproutWord(sprout())).toBe("waiting its turn to clarify");
    expect(sproutWord(sprout({ clarified: true }))).toBe("waiting its turn for research");
    expect(sproutWord(sprout({ status: "clarifying" }))).toBe("clarifying");
    expect(sproutWord(sprout({ status: "clarifying", questions: [q("a"), q("b")] }))).toBe("2 questions for you");
    expect(sproutWord(sprout({ status: "rejected" }))).toBe("turned down at eval");
  });
  test("questions and parks need you; the rest do not", () => {
    expect(needsYou(sprout({ status: "clarifying", questions: [q("a")] }))).toBe(true);
    expect(needsYou(sprout({ status: "parked", parked: "x" }))).toBe(true);
    expect(needsYou(sprout({ status: "clarifying" }))).toBe(false);
  });
  test("what needs you first, then what runs, then what ended; newest first in each", () => {
    const list = [
      sprout({ id: "sp_000000000001", status: "stopped", updatedAt: 9 }),
      sprout({ id: "sp_000000000002", status: "clarifying", updatedAt: 2 }),
      sprout({ id: "sp_000000000003", status: "parked", parked: "x", updatedAt: 1 }),
      sprout({ id: "sp_000000000004", status: "queued", updatedAt: 5 }),
    ];
    expect(sortSprouts(list).map((s) => s.id.slice(-1))).toEqual(["3", "4", "2", "1"]);
  });
});

describe("feed lines", () => {
  const snap = (sprouts: Record<string, Sprout>): FeedSnapshot => ({ repos: [], sources: [], runs: {}, flows: {}, fleets: {}, workspaces: [], sprouts });
  test("a new sprout, a status change, questions, a park and a dismissal", () => {
    const s = sprout();
    expect(sproutLines({ type: "incubator", sprout: s }, snap({}), 5).map((l) => l.text)).toEqual(["new project in the incubator"]);
    const c = sprout({ status: "clarifying" });
    expect(sproutLines({ type: "incubator", sprout: c }, snap({ [s.id]: s }), 5).map((l) => l.text)).toEqual(["clarifying"]);
    const asking = sprout({ status: "clarifying", questions: [q("a")] });
    expect(sproutLines({ type: "incubator", sprout: asking }, snap({ [s.id]: c }), 5).map((l) => l.text)).toEqual(["1 question for you"]);
    const parked = sprout({ status: "parked", parked: "the scout workflow is not installed" });
    const [line] = sproutLines({ type: "incubator", sprout: parked }, snap({ [s.id]: c }), 5);
    expect(line).toMatchObject({ kind: "incubator", repo: "Coin counter", repoId: "_incubator/coins", text: "parked: the scout workflow is not installed", quiet: false });
    expect(sproutLines({ type: "incubator-gone", id: s.id }, snap({ [s.id]: s }), 5).map((l) => [l.text, l.quiet])).toEqual([["dismissed", true]]);
  });
  test("a save that changes nothing a person reads is quiet", () => {
    const s = sprout({ status: "clarifying" });
    const [line] = sproutLines({ type: "incubator", sprout: { ...s, updatedAt: 9 } }, snap({ [s.id]: s }), 5);
    expect(line?.quiet).toBe(true);
  });
});
```

Append to `ui/src/inbox.test.ts` (add `Sprout` to its type import):

```ts
describe("the incubator in the inbox", () => {
  const sprout: Sprout = {
    id: "sp_000000000001",
    slug: "coins",
    title: "Coin counter",
    status: "clarifying",
    repoId: "_incubator/coins",
    seedPath: "/root/_incubator/coins",
    prepared: true,
    inputs: [],
    clarified: true,
    reclarify: false,
    questions: [{ question: "Who counts?", header: "", options: [], multiSelect: false }],
    questionsAt: 20_000,
    flows: [],
    spent: { runs: 0, workMs: 0 },
    createdAt: 0,
    updatedAt: 0,
  };
  test("open questions are one clarify item; a sprout without them is none", () => {
    const items = mergeInbox([], {}, {}, 30_000, { ...ctx, sprouts: [sprout, { ...sprout, id: "sp_000000000002", questions: [] }] });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ key: "sprout:sp_000000000001", source: "sprout", kind: "clarify", who: "clarify", repo: "Coin counter", where: "canopy incubator", title: "1 question before research", at: 20_000 });
    expect(items[0]?.questions?.[0]?.question).toBe("Who counts?");
  });
  test("a gate a budget parked says so", () => {
    const items = mergeInbox([], {}, { f: flow({ id: "f", parkedFor: "budget" }) }, 30_000, ctx);
    expect(items[0]?.budget).toBe(true);
  });
  test("going on assumptions is no answer to a run or an ask", () => {
    expect(toRunAnswer({ skip: true })).toBeNull();
    expect(toAskAnswer({ skip: true })).toBeNull();
  });
});
```

Append to `ui/src/routes.test.ts` (add `sproutHere` to its import from `./routes`):

```ts
describe("sproutHere", () => {
  test("the incubator view's sprout, and nothing else", () => {
    expect(sproutHere("?view=incubator&sprout=sp_0123456789ab")).toBe("sp_0123456789ab");
    expect(sproutHere("?view=git&sprout=sp_0123456789ab")).toBeNull();
    expect(sproutHere("?view=incubator&sprout=../x")).toBeNull();
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `SHELL=/bin/bash bun test ui/src/sprouts.test.ts ui/src/inbox.test.ts ui/src/routes.test.ts`
Expected: FAIL; `./sprouts` does not exist, `sproutHere` is not exported, `sprouts` is not an `InboxContext` field.

- [ ] **Step 3: Write `ui/src/sprouts.ts`**

```ts
/** The incubator's words and arithmetic for the page: the stage strip, the
 *  status words, the order of the cards, and the feed's lines. Pure. */
import { nextWorkflow, sproutEnded } from "../../src/core/sprout";
import type { InputKind, ServerEvent, Sprout, SproutStatus } from "../../src/core/types";
import type { FeedLine, FeedSnapshot } from "./feed";

export const STAGES = ["clarify", "research", "eval", "build", "test", "accept", "deploy", "retro"] as const;
export type Stage = (typeof STAGES)[number];
export type StageMark = "done" | "now" | "stuck" | "todo";

/** a running status's stage; research and eval are one flow (scout), shown as research */
const STATUS_STAGE: Partial<Record<SproutStatus, Stage>> = {
  clarifying: "clarify",
  researching: "research",
  building: "build",
  testing: "test",
  accepting: "accept",
  deploying: "deploy",
};

const WORKFLOW_STAGE: Readonly<Record<string, Stage>> = {
  clarify: "clarify",
  scout: "research",
  "build-new": "build",
  renovate: "build",
  extend: "build",
  retro: "retro",
};

/** The stage a sprout is at: its running status's, else the stage of the
 *  workflow it runs next (where a park or a queue leaves it); null before
 *  anything has run. */
export function stageAt(s: Sprout): Stage | null {
  const running = STATUS_STAGE[s.status];
  if (running) return running;
  if (s.flows.length === 0 && !s.clarified) return null;
  const last = s.flows.at(-1);
  // a flow that did not finish is where it stopped; one that did hands on to the next
  if (last && last.outcome !== "done") return WORKFLOW_STAGE[last.workflow] ?? null;
  return WORKFLOW_STAGE[nextWorkflow(s)] ?? null;
}

export function stageStrip(s: Sprout): { stage: Stage; mark: StageMark }[] {
  if (s.status === "live" || s.status === "handed-off") {
    return STAGES.map((stage) => ({ stage, mark: stage === "retro" ? "todo" : "done" }));
  }
  const at = stageAt(s);
  const i = at ? STAGES.indexOf(at) : 0;
  const stuck = s.status === "parked" || s.status === "rejected" || s.status === "stopped";
  const waiting = s.status === "queued";
  return STAGES.map((stage, j) => ({
    stage,
    mark: j < i ? "done" : j === i && at && !waiting ? (stuck ? "stuck" : "now") : "todo",
  }));
}

const STATUS_WORD: Record<SproutStatus, string> = {
  queued: "waiting its turn",
  clarifying: "clarifying",
  researching: "researching",
  building: "building",
  testing: "testing",
  accepting: "accepting",
  deploying: "deploying",
  live: "live",
  parked: "parked",
  rejected: "turned down at eval",
  "handed-off": "handed off",
  stopped: "stopped",
};

export function sproutWord(s: Sprout): string {
  const n = s.questions?.length ?? 0;
  if (s.status === "clarifying" && n > 0) return `${n} ${n === 1 ? "question" : "questions"} for you`;
  if (s.status === "queued") {
    if (!s.prepared) return "making the seed";
    return nextWorkflow(s) === "clarify" ? "waiting its turn to clarify" : "waiting its turn for research";
  }
  return STATUS_WORD[s.status];
}

export const needsYou = (s: Sprout): boolean => s.status === "parked" || (s.status === "clarifying" && (s.questions?.length ?? 0) > 0);

/** what needs you, then what runs or waits its turn, then what ended; newest change first in each */
export function sortSprouts(list: readonly Sprout[]): Sprout[] {
  const rank = (s: Sprout): number => (needsYou(s) ? 0 : sproutEnded(s) ? 2 : 1);
  return [...list].sort((a, b) => rank(a) - rank(b) || b.updatedAt - a.updatedAt);
}

export const INPUT_GLYPH: Record<InputKind, string> = {
  text: "¶",
  audio: "♪",
  image: "▣",
  url: "↗",
  file: "▤",
  transcript: "✎",
  answers: "✓",
};

/** The feed's lines for a sprout's event, against what the store held before. */
export function sproutLines(ev: Extract<ServerEvent, { type: "incubator" | "incubator-gone" }>, prev: FeedSnapshot, at: number): FeedLine[] {
  const line = (s: Pick<Sprout, "title" | "repoId">, text: string, quiet = false): FeedLine => ({
    at,
    kind: "incubator",
    source: "",
    repoId: s.repoId,
    repo: s.title,
    text,
    quiet,
  });
  if (ev.type === "incubator-gone") {
    const was = prev.sprouts?.[ev.id];
    return [was ? line(was, "dismissed", true) : { at, kind: "incubator", source: "", text: "a project dismissed", quiet: true }];
  }
  const s = ev.sprout;
  const before = prev.sprouts?.[s.id];
  if (!before) return [line(s, "new project in the incubator")];
  const lines: FeedLine[] = [];
  if (before.title !== s.title) lines.push(line(s, `now called ${s.title}`));
  const asking = (s.questions?.length ?? 0) > 0;
  const wasAsking = (before.questions?.length ?? 0) > 0;
  if (before.status !== s.status || asking !== wasAsking) {
    lines.push(line(s, s.status === "parked" ? `parked: ${s.parked ?? "no reason given"}` : sproutWord(s)));
  }
  const added = s.inputs.filter((e) => e.via !== "answer").length - before.inputs.filter((e) => e.via !== "answer").length;
  if (added > 0) lines.push(line(s, `${added} more ${added === 1 ? "input" : "inputs"}`));
  if (lines.length === 0) lines.push(line(s, sproutWord(s), true));
  return lines;
}
```

The parked-in-scout test expects `stageAt` to say research: the last flow (clarify) finished, so the stage is `nextWorkflow`'s, which is scout's. A park in clarify itself has an unfinished last flow, so it stays at clarify.

- [ ] **Step 4: Extend the inbox**

In `ui/src/inbox.ts`:

1. Add `Sprout` to the type import from `../../src/core/types`.
2. `export type InboxSource = "ask" | "run" | "flow" | "sprout";`
3. In `InboxItem`, change `kind` to `kind: "permission" | "question" | "guard" | "gate" | "clarify";`, update the `key` comment to "unique across the four", and add after `promptId?`:

```ts
  /** a gate the flow's budget parked: continuing grants one more step */
  budget?: true;
```

4. In `InboxContext`, add:

```ts
  /** the incubator's sprouts, home's alone; one with open questions is an item */
  sprouts?: readonly Sprout[];
```

5. In `flowItem`'s returned object, after `until: null,`, add `...(flow.parkedFor === "budget" ? { budget: true as const } : {}),`.
6. After `flowItem`, add:

```ts
function sproutItem(s: Sprout, ctx: InboxContext): InboxItem | null {
  const n = s.questions?.length ?? 0;
  if (s.status !== "clarifying" || n === 0) return null;
  return {
    key: `sprout:${s.id}`,
    source: "sprout",
    id: s.id,
    kind: "clarify",
    repoId: ctx.repos.some((r) => r.id === s.repoId) ? s.repoId : null,
    repo: s.title,
    who: "clarify",
    where: "canopy incubator",
    title: `${n} ${n === 1 ? "question" : "questions"} before research`,
    detail: "",
    ...(s.questions ? { questions: s.questions } : {}),
    at: s.questionsAt ?? s.updatedAt,
    left: null,
    until: null,
  };
}
```

7. In `mergeInbox`, before the sort, add:

```ts
  for (const s of ctx.sprouts ?? []) {
    const it = sproutItem(s, ctx);
    if (it) items.push(it);
  }
```

8. `InboxAnswer` gains a fifth member, `| { skip: true }`, with the comment "clarify's questions passed over: go on assumptions". In both `toRunAnswer` and `toAskAnswer`, the first line becomes `if ("choice" in a || "skip" in a) return null;`.

- [ ] **Step 5: Extend the feed**

In `ui/src/feed.ts`:

1. Add `| "incubator"` to `FeedKind`, after `| "ask"`.
2. In `FeedSnapshot`, after `presence?`, add:

```ts
  /** the incubator's sprouts by id, so a status change can be told from a save */
  sprouts?: Record<string, Sprout>;
```

and `Sprout` to its type import.
3. Add `import { sproutLines } from "./sprouts";` beside the other line makers.
4. Replace Task 1's `return [];` under `case "incubator": case "incubator-gone":` with `return sproutLines(ev, prev, at);`.

`Feed.tsx`'s `KIND_WORD` is a `Record<FeedKind, string>`, so the typecheck fails until Task 13 adds `incubator: "incubator"` to it. Add that one entry now: in `ui/src/components/Feed.tsx`, after the `ask:` entry of `KIND_WORD`, add `incubator: "incubator",`.

- [ ] **Step 6: Add the route**

In `ui/src/routes.ts`, after `dropAskHere`, add (and `isSproutId` imported from `../../src/core/sprout`):

```ts
/** `?view=incubator&sprout=<id>`: the incubator with that project open, the
 *  link `canopy new` prints */
export function sproutHere(search: string): string | null {
  const q = new URLSearchParams(search);
  const id = q.get("sprout");
  return q.get("view") === "incubator" && id && isSproutId(id) ? id : null;
}

/** Takes `sprout=` off this window's URL once the sheet has it. */
export function dropSproutHere() {
  const u = new URL(window.location.href);
  if (!u.searchParams.has("sprout")) return;
  u.searchParams.delete("sprout");
  window.history.replaceState(null, "", u.toString());
}
```

- [ ] **Step 7: Run the tests**

Run: `SHELL=/bin/bash bun test ui/src/sprouts.test.ts ui/src/inbox.test.ts ui/src/routes.test.ts ui/src/feed.test.ts`
Expected: PASS.

- [ ] **Step 8: Typecheck and lint**

Run: `bun run typecheck && bun run lint`
Expected: PASS. A `Record<InboxItem["kind"], …>` or `Record<InboxSource, …>` in `Inbox.tsx` now misses a key: add `clarify: "✎"` to `KIND_GLYPH` and `sprout: "incubator"` to `SOURCE_WORD` there (Task 13 builds the rest of that component's handling).

- [ ] **Step 9: Commit**

```bash
git add ui/src/sprouts.ts ui/src/sprouts.test.ts ui/src/inbox.ts ui/src/inbox.test.ts ui/src/feed.ts ui/src/routes.ts ui/src/routes.test.ts ui/src/components/Feed.tsx ui/src/components/Inbox.tsx
git commit -m "feat(incubator): the page's stage strip, words, inbox item, feed lines and link

Claude-Session: https://claude.ai/code/session_01DMvREFYoLgpGe2oQNWq1Xu"
```

---
### Task 12: The store and the api

**Files:**
- Modify: `ui/src/api.ts`, `ui/src/store.ts`
- Test: `ui/src/store.test.ts` (append)

**Interfaces:**
- Consumes: `Sprout`, `SproutDetail` (Task 1); `InboxItem`, `InboxAnswer`, `mergeInbox`'s `ctx.sprouts` (Task 11); the routes of Task 10.
- Produces:
  - `api.sprouts()`, `api.sprout(id): Promise<SproutDetail>`, `api.newSprout(form: FormData): Promise<Sprout>`, `api.addSproutInputs(id, form): Promise<Sprout>`, `api.answerSprout(id, body: { answers: Record<string, string> } | { skip: true }): Promise<Sprout>`, `api.stopSprout(id)`, `api.resumeSprout(id, choice: "continue" | "retry")`, `api.dismissSprout(id)`. All on the home backend.
  - Store state: `sprouts: Record<string, Sprout>`, `sproutsReady: boolean`.
  - Store actions: `loadSprouts()`, `createSprout(form): Promise<Sprout>`, `addSproutInputs(id, form)`, `answerSprout(id, answers | null)`, `stopSprout(id)`, `resumeSprout(id, choice)`, `dismissSprout(id)`, `showSprout(id)`, `openNewSprout()`.
  - `Sheet` gains `{ kind: "new-sprout" }` and `{ kind: "sprout"; id: string }`.
  - `applyEvent` takes `incubator` and `incubator-gone` from home alone; `inboxItems` includes sprouts with open questions; `answerInbox` routes a `sprout` item.

- [ ] **Step 1: Write the failing store test**

Append inside `describe("several backends", () => {` in `ui/src/store.test.ts`, after the test "asks are home's alone, and an answer goes back the way its item came" (it uses that block's `start`, `backendAnswers`, `twoBackends`, `scanOf`, `repo` and `settle`), and add `Sprout` to the file's type import:

```ts
  test("the incubator is home's alone; its questions are in the inbox and answered there", async () => {
    const asking: Sprout = {
      id: "sp_000000000001",
      slug: "coins",
      title: "Coin counter",
      status: "clarifying",
      repoId: "_incubator/coins",
      seedPath: "/a/_incubator/coins",
      prepared: true,
      inputs: [],
      clarified: true,
      reclarify: false,
      questions: [{ question: "Who counts?", header: "", options: [], multiSelect: false }],
      questionsAt: 5,
      flows: [],
      spent: { runs: 0, workMs: 0 },
      createdAt: 1,
      updatedAt: 5,
    };
    const answered: Sprout = { ...asking, status: "queued", questions: undefined, questionsAt: undefined, updatedAt: 6 };
    const posted: { path: string; body: unknown }[] = [];
    await start(
      (path, init) => {
        if (init?.method === "POST") posted.push({ path, body: JSON.parse(String(init.body ?? "null")) });
        return backendAnswers(scanOf("/a", [repo("proj")]), [], {
          "/api/backends": twoBackends,
          "/api/incubator": [asking],
          "/api/incubator/answer": answered,
        })(path, init);
      },
      backendAnswers(scanOf("/b", [repo("proj")]), []),
    );
    await settle();
    let s = useStore.getState();
    expect(s.sproutsReady).toBe(true);
    expect(Object.keys(s.sprouts)).toEqual([asking.id]);
    const item = inboxItems(s).find((i) => i.source === "sprout");
    if (!item) throw new Error("no sprout item in the inbox");
    expect(item.key).toBe(`sprout:${asking.id}`);
    // b's incubator is not this page's
    useStore.getState().applyEvent({ type: "incubator", sprout: { ...asking, id: "sp_000000000002" } }, "b");
    expect(Object.keys(useStore.getState().sprouts)).toEqual([asking.id]);
    // going on assumptions is a skip, to home
    await useStore.getState().answerInbox(item, { skip: true });
    expect(posted.find((p) => p.path.startsWith("/api/incubator/answer"))).toEqual({ path: `/api/incubator/answer?id=${asking.id}`, body: { skip: true } });
    s = useStore.getState();
    expect(s.sprouts[asking.id]?.status).toBe("queued");
    expect(inboxItems(s).some((i) => i.source === "sprout")).toBe(false);
    expect(s.feed.some((l) => l.kind === "incubator" && l.text === "waiting its turn for research")).toBe(true);
    useStore.getState().applyEvent({ type: "incubator-gone", id: asking.id });
    expect(useStore.getState().sprouts).toEqual({});
  });
```

In the test "a registry of one talks to nothing but the page's own origin", add `"/api/incubator",` to the expected list, after `"/api/asks",`.

- [ ] **Step 2: Run it to see it fail**

Run: `SHELL=/bin/bash bun test ui/src/store.test.ts`
Expected: FAIL; `sproutsReady` is undefined and `/api/incubator` is never asked.

- [ ] **Step 3: Add the api calls**

In `ui/src/api.ts`, add `Sprout` and `SproutDetail` to the type import from `../../src/core/types`, and after `answerAsk` in the `api` object:

```ts
  /** the incubator, the home backend's alone */
  sprouts: () => req<Sprout[]>(homeName(), "/api/incubator"),
  sprout: (id: string) => req<SproutDetail>(homeName(), `/api/incubator/one?id=${encodeURIComponent(id)}`),
  /** multipart, so a voice memo or an image goes as it is */
  newSprout: (form: FormData) => req<Sprout>(homeName(), "/api/incubator", { method: "POST", body: form }),
  addSproutInputs: (id: string, form: FormData) =>
    req<Sprout>(homeName(), `/api/incubator/input?id=${encodeURIComponent(id)}`, { method: "POST", body: form }),
  answerSprout: (id: string, body: { answers: Record<string, string> } | { skip: true }) =>
    req<Sprout>(homeName(), `/api/incubator/answer?id=${encodeURIComponent(id)}`, { method: "POST", body: JSON.stringify(body) }),
  stopSprout: (id: string) => req<Sprout>(homeName(), `/api/incubator/stop?id=${encodeURIComponent(id)}`, { method: "POST", body: "{}" }),
  resumeSprout: (id: string, choice: "continue" | "retry") =>
    req<Sprout>(homeName(), `/api/incubator/resume?id=${encodeURIComponent(id)}`, { method: "POST", body: JSON.stringify({ choice }) }),
  dismissSprout: (id: string) => req<{ ok: true }>(homeName(), `/api/incubator?id=${encodeURIComponent(id)}`, { method: "DELETE" }),
```

`req` sets `Content-Type: application/json` only for a string body, so a `FormData` body keeps the multipart type and boundary `fetch` gives it.

- [ ] **Step 4: Add the store state and actions**

In `ui/src/store.ts`:

1. Add `Sprout` to the type import from `../../src/core/types`.
2. In `Sheet`, add `| { kind: "new-sprout" }` and `| { kind: "sprout"; id: string }`.
3. In the `CanopyState` interface, after `presence: Presence | null;`:

```ts
  /** the incubator's sprouts by id, the home backend's alone */
  sprouts: Record<string, Sprout>;
  /** whether home answered the incubator's list */
  sproutsReady: boolean;
```

and after `answerInbox`'s declaration:

```ts
  /** reads the incubator's list off the home backend */
  loadSprouts: () => Promise<void>;
  /** a new project from the + project sheet or ⌘N; answers before the seed is made */
  createSprout: (form: FormData) => Promise<Sprout>;
  addSproutInputs: (id: string, form: FormData) => Promise<Sprout>;
  /** clarify's questions answered, or null to go on assumptions */
  answerSprout: (id: string, answers: Record<string, string> | null) => Promise<void>;
  stopSprout: (id: string) => Promise<void>;
  resumeSprout: (id: string, choice: "continue" | "retry") => Promise<void>;
  dismissSprout: (id: string) => Promise<void>;
  showSprout: (id: string) => void;
  openNewSprout: () => void;
```

4. In the initial state, after `presence: null,` (beside `asksReady: false,`), add `sprouts: {},` and `sproutsReady: false,`.
5. In `init`, after `void get().loadAsks();`, add `void get().loadSprouts();`. In `resync`, inside `if (b === get().home) {`, add the same line after `void get().loadAsks();`.
6. After the `answerInbox` implementation, add:

```ts
  loadSprouts: async () => {
    try {
      const list = await api.sprouts();
      set({ sprouts: Object.fromEntries((Array.isArray(list) ? list : []).map((s) => [s.id, s])), sproutsReady: true });
    } catch {
      set({ sprouts: {}, sproutsReady: false });
    }
  },
  createSprout: async (form) => {
    const s = await api.newSprout(form);
    get().applyEvent({ type: "incubator", sprout: s });
    return s;
  },
  addSproutInputs: async (id, form) => {
    const s = await api.addSproutInputs(id, form);
    get().applyEvent({ type: "incubator", sprout: s });
    return s;
  },
  answerSprout: async (id, answers) => {
    const s = await api.answerSprout(id, answers ? { answers } : { skip: true });
    get().applyEvent({ type: "incubator", sprout: s });
  },
  stopSprout: async (id) => {
    get().applyEvent({ type: "incubator", sprout: await api.stopSprout(id) });
  },
  resumeSprout: async (id, choice) => {
    get().applyEvent({ type: "incubator", sprout: await api.resumeSprout(id, choice) });
  },
  dismissSprout: async (id) => {
    await api.dismissSprout(id);
    get().applyEvent({ type: "incubator-gone", id });
  },
  showSprout: (id) => set({ sheet: { kind: "sprout", id } }),
  openNewSprout: () => set({ sheet: { kind: "new-sprout" } }),
```

Each action applies its own answer as an event, so the card and the feed move at once; the broadcast that follows finds the same sprout and adds only a quiet line.

7. In `answerInbox`, as its first branch:

```ts
    if (item.source === "sprout") {
      if ("skip" in answer) return get().answerSprout(item.id, null);
      if (!("answers" in answer)) throw new Error("clarify's questions take answers, or go on assumptions");
      return get().answerSprout(item.id, answer.answers);
    }
```

8. In `applyEvent`, add `|| ev.type === "incubator" || ev.type === "incubator-gone"` to the home-only condition (the line that names `chan`, `workspaces`, `registry` and `asks`), and update its comment to "workspaces, tailchan, the agent registry, the asks and the incubator are the home backend's alone". After the `if (ev.type === "asks") { … }` block, add:

```ts
    if (ev.type === "incubator") {
      set((s) => ({ sprouts: { ...s.sprouts, [ev.sprout.id]: ev.sprout } }));
      return;
    }
    if (ev.type === "incubator-gone") {
      set((s) => {
        if (!(ev.id in s.sprouts)) return {};
        const { [ev.id]: _gone, ...sprouts } = s.sprouts;
        return { sprouts };
      });
      return;
    }
```

If lint refuses the unused `_gone`, write the delete as `const sprouts = { ...s.sprouts }; delete sprouts[ev.id]; return { sprouts };`.

9. In `feedView`, after `presence: s.presence,`, add `sprouts: s.sprouts,`.
10. In `inboxItems`, add `sprouts: Record<string, Sprout>` to the `inboxIn` type, `inboxIn.sprouts === s.sprouts` to the memo test, `sprouts: s.sprouts` to the saved `inboxIn`, and `sprouts: Object.values(s.sprouts),` to the context `mergeInbox` gets. Update its comment to "the home broker's open asks, the incubator's questions, every backend's runs on a prompt and flows at a gate".

- [ ] **Step 5: Run it**

Run: `SHELL=/bin/bash bun test ui/src/store.test.ts`
Expected: PASS.

- [ ] **Step 6: Typecheck and lint**

Run: `bun run typecheck && bun run lint`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add ui/src/api.ts ui/src/store.ts ui/src/store.test.ts
git commit -m "feat(incubator): the page's store and api for sprouts

Claude-Session: https://claude.ai/code/session_01DMvREFYoLgpGe2oQNWq1Xu"
```

---
### Task 13: The incubator view, the + project sheet and the inbox's clarify item

**Files:**
- Create: `ui/src/components/Incubator.tsx`
- Modify: `ui/src/components/Prompts.tsx` (`Questions`), `ui/src/components/Inbox.tsx` (`InboxRow`), `ui/src/components/RunSheet.tsx` (`Body`), `ui/src/components/TopBar.tsx`, `ui/src/App.tsx`, `ui/src/styles.css`

**Interfaces:**
- Consumes: Task 11's `sprouts.ts`, `sproutHere`, `dropSproutHere`; Task 12's store actions and `api.sprout`; `INPUT_FILE_MAX`, `inputType`, `inputKindOf`, `sizeWord` (Task 1, browser-safe); the existing `InboxChip`, `Questions`, `ago`.
- Produces: `IncubatorView({ onGit })`, `NewSproutSheet()`, `SproutSheet({ id })`, `NewProjectButton()`; `Questions` takes `declineLabel?` and `declineTitle?`; the `incubator` view in `ViewNav`; the `n` key.

There are no component tests in this repo; the pure parts are tested in Task 11 and the store in Task 12. This task ends with a check in a real browser against a scratch server (Step 9).

- [ ] **Step 1: Let `Questions` name its decline**

In `ui/src/components/Prompts.tsx`, add two props to `Questions` after `onDecline?: () => void;`:

```ts
  /** the decline button's word and tooltip; "decline" by default */
  declineLabel?: string;
  declineTitle?: string;
```

destructure them, and on the decline button (near line 196) use `title={declineTitle ?? "Leave it unanswered: the agent is told you declined"}` and `{declineLabel ?? "decline"}` as its text.

- [ ] **Step 2: Write `ui/src/components/Incubator.tsx`**

```tsx
/**
 * The incubator: one card per new project with its stage strip, the
 * + project sheet that takes an idea in words, links, files, a voice memo
 * or a repo, and one project's sheet (intent, inputs, the chain of flows,
 * what it spent, and add input, stop, resume, dismiss).
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useShallow } from "zustand/react/shallow";
import { INPUT_FILE_MAX, inputKindOf, inputType, sizeWord } from "../../../src/core/sprout";
import type { SproutDetail } from "../../../src/core/types";
import { api } from "../api";
import { dropSproutHere, sproutHere } from "../routes";
import { INPUT_GLYPH, STAGES, needsYou, sortSprouts, sproutWord, stageStrip, type StageMark } from "../sprouts";
import { useStore } from "../store";
import { ago } from "../util";
import { InboxChip } from "./Inbox";
import { Questions } from "./Prompts";

const errText = (err: unknown) => String(err instanceof Error ? err.message : err);

const MARK_WORD: Record<StageMark, string> = { done: "done", now: "in progress", stuck: "stopped here", todo: "not yet" };

export function NewProjectButton() {
  const ready = useStore((s) => s.sproutsReady);
  const open = useStore((s) => s.openNewSprout);
  if (!ready) return null;
  return (
    <button type="button" className="mini new-project" title="A new project from an idea, a link, a file, a voice memo or a repo (n)" onClick={open}>
      + project
    </button>
  );
}

function StageStrip({ id }: { id: string }) {
  const marks = useStore(useShallow((s) => {
    const sp = s.sprouts[id];
    return sp ? stageStrip(sp).map((x) => x.mark) : [];
  }));
  // stageStrip lists the stages in STAGES order, so a mark's index is its stage
  return (
    <ol className="stage-strip" aria-label="Stages">
      {marks.map((mark, i) => (
        <li key={STAGES[i]} className={`stage ${mark}`} title={`${STAGES[i]}: ${MARK_WORD[mark]}`}>
          {STAGES[i]}
        </li>
      ))}
    </ol>
  );
}

function SproutCard({ id }: { id: string }) {
  const s = useStore((st) => st.sprouts[id]);
  const show = useStore((st) => st.showSprout);
  if (!s) return null;
  return (
    <button type="button" className={`sprout-card${needsYou(s) ? " needs" : ""}`} onClick={() => show(s.id)}>
      <span className="sprout-head">
        <span className="sprout-title">{s.title}</span>
        <span className={`sprout-word st-${s.status}`}>{sproutWord(s)}</span>
      </span>
      <StageStrip id={s.id} />
      {s.parked && <span className="sprout-parked">{s.parked}</span>}
      <span className="sprout-meta">
        {s.inputs.length} {s.inputs.length === 1 ? "input" : "inputs"} · {s.spent.runs} {s.spent.runs === 1 ? "run" : "runs"} · {ago(s.updatedAt / 1000)}
      </span>
    </button>
  );
}

export function IncubatorView({ onGit }: { onGit?: () => void }) {
  const ready = useStore((s) => s.sproutsReady);
  const ids = useStore(useShallow((s) => sortSprouts(Object.values(s.sprouts)).map((x) => x.id)));
  const show = useStore((s) => s.showSprout);
  // `canopy new` prints a link to its project: open it once the list is in
  useEffect(() => {
    const id = sproutHere(window.location.search);
    if (!id || !ready) return;
    show(id);
    dropSproutHere();
  }, [ready, show]);
  return (
    <section className="incubator-view" aria-label="Incubator">
      <div className="agents-bar">
        <NewProjectButton />
        <span className="agents-has">
          <InboxChip onGit={onGit} />
        </span>
      </div>
      {!ready ? (
        <p className="sheet-empty">The home backend has no incubator to show, or has not answered yet.</p>
      ) : ids.length === 0 ? (
        <div className="incubator-empty">
          <p>Nothing in the incubator. A project starts from an idea, a link, a file, a voice memo or a repo, and is clarified and researched before anything is built.</p>
          <NewProjectButton />
        </div>
      ) : (
        <div className="sprout-grid">
          {ids.map((id) => (
            <SproutCard key={id} id={id} />
          ))}
        </div>
      )}
    </section>
  );
}

/** Records a voice memo where the page may use the microphone (a secure
 *  page), else offers a file picker for audio, which on a phone opens its
 *  own recorder. */
function Recorder({ onFiles }: { onFiles: (files: File[]) => void }) {
  const can = window.isSecureContext && typeof MediaRecorder !== "undefined" && Boolean(navigator.mediaDevices?.getUserMedia);
  const rec = useRef<MediaRecorder | null>(null);
  const [recording, setRecording] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(
    () => () => {
      const r = rec.current;
      if (!r) return;
      r.onstop = null;
      if (r.state !== "inactive") r.stop();
      for (const t of r.stream.getTracks()) t.stop();
    },
    [],
  );
  if (!can) {
    return (
      <label className="mini" title="The microphone needs an https page; this picks a recording instead, and a phone offers to make one">
        upload a voice memo
        <input
          type="file"
          accept="audio/*"
          hidden
          onChange={(e) => {
            if (e.target.files) onFiles(Array.from(e.target.files));
            e.target.value = "";
          }}
        />
      </label>
    );
  }
  const start = async () => {
    setErr(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      // Safari records mp4 only
      const type = MediaRecorder.isTypeSupported("audio/webm") ? "audio/webm" : "audio/mp4";
      const r = new MediaRecorder(stream, { mimeType: type });
      const chunks: Blob[] = [];
      r.ondataavailable = (e) => {
        if (e.data.size > 0) chunks.push(e.data);
      };
      r.onstop = () => {
        for (const t of stream.getTracks()) t.stop();
        rec.current = null;
        setRecording(false);
        if (chunks.length === 0) return;
        const ext = type === "audio/webm" ? "webm" : "m4a";
        onFiles([new File(chunks, `voice-${Date.now()}.${ext}`, { type: r.mimeType || type })]);
      };
      rec.current = r;
      r.start();
      setRecording(true);
    } catch (e) {
      setErr(errText(e));
    }
  };
  return (
    <>
      {recording ? (
        <button type="button" className="mini strong recording" onClick={() => rec.current?.stop()}>
          ■ stop recording
        </button>
      ) : (
        <button type="button" className="mini" onClick={() => void start()}>
          ● record
        </button>
      )}
      {err && <span className="note err">{err}</span>}
    </>
  );
}

/** The inputs a project starts from or takes later, as one form, with the
 *  sheet's body and footer. */
function IntakeForm({
  lead,
  allowRepo,
  busy,
  error,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  lead?: ReactNode;
  allowRepo: boolean;
  busy: boolean;
  error: string | null;
  submitLabel: string;
  onSubmit: (form: FormData) => void;
  onCancel: () => void;
}) {
  const [text, setText] = useState("");
  const [links, setLinks] = useState("");
  const [repo, setRepo] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [refused, setRefused] = useState<string | null>(null);
  const [over, setOver] = useState(false);
  const add = (list: File[]) => {
    const ok: File[] = [];
    const bad: string[] = [];
    for (const f of list) {
      if (!inputType(f.type, f.name)) bad.push(`${f.name}: canopy takes audio, images, pdf, text and markdown`);
      else if (f.size > INPUT_FILE_MAX) bad.push(`${f.name} is over 25 MB`);
      else ok.push(f);
    }
    setFiles((fs) => [...fs, ...ok]);
    setRefused(bad.length ? bad.join("; ") : null);
  };
  const urls = links.split(/\s+/).filter(Boolean);
  const ready = !busy && (text.trim().length > 0 || urls.length > 0 || files.length > 0 || (allowRepo && repo.trim().length > 0));
  const submit = () => {
    if (!ready) return;
    const form = new FormData();
    if (text.trim()) form.append("text", text);
    for (const u of urls) form.append("url", u);
    if (allowRepo && repo.trim()) form.append("repo", repo.trim());
    for (const f of files) form.append("file", f, f.name);
    form.append("via", "sheet");
    onSubmit(form);
  };
  return (
    <>
      <div className="sheet-body plan intake">
        {lead}
        <textarea
          className="plan-note intake-text"
          rows={6}
          placeholder="The idea, in as many words as you like"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") submit();
          }}
          aria-label="The idea"
        />
        <div
          className={`drop-zone${over ? " over" : ""}`}
          onDragOver={(e) => {
            e.preventDefault();
            setOver(true);
          }}
          onDragLeave={() => setOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setOver(false);
            add(Array.from(e.dataTransfer.files));
          }}
        >
          <span className="dim">Drop images, voice memos, pdfs or notes here, or</span>
          <label className="mini">
            pick files
            <input
              type="file"
              multiple
              hidden
              accept="audio/*,image/*,application/pdf,text/plain,text/markdown,.md,.markdown,.txt"
              onChange={(e) => {
                if (e.target.files) add(Array.from(e.target.files));
                e.target.value = "";
              }}
            />
          </label>
          <Recorder onFiles={add} />
        </div>
        {files.length > 0 && (
          <ul className="intake-files">
            {files.map((f, i) => (
              <li key={`${f.name}-${i}`}>
                <span aria-hidden="true">{INPUT_GLYPH[inputKindOf(inputType(f.type, f.name) ?? "")]}</span> {f.name} <span className="dim">{sizeWord(f.size)}</span>
                <button type="button" className="mini" aria-label={`Remove ${f.name}`} onClick={() => setFiles((fs) => fs.filter((_, j) => j !== i))}>
                  ✕
                </button>
              </li>
            ))}
          </ul>
        )}
        {refused && <p className="note err">{refused}</p>}
        <textarea className="plan-note intake-links" rows={2} placeholder="Links, one per line" value={links} onChange={(e) => setLinks(e.target.value)} aria-label="Links" />
        {allowRepo && (
          <input
            className="intake-line"
            type="url"
            placeholder="A git repo to start from (optional)"
            value={repo}
            onChange={(e) => setRepo(e.target.value)}
            aria-label="A git repo to start from"
          />
        )}
        {error && <p className="note err">{error}</p>}
      </div>
      <footer className="sheet-foot">
        <span className="sheet-hint">Everything here is kept as it came, and only its index and summaries go to the vault.</span>
        <button type="button" className="mini" onClick={onCancel}>
          cancel
        </button>
        <button type="button" className="mini strong" disabled={!ready} onClick={submit}>
          {busy ? "sending…" : submitLabel}
        </button>
      </footer>
    </>
  );
}

function SheetHead({ eyebrow, title, sub }: { eyebrow: string; title: string; sub?: string }) {
  const close = useStore((s) => s.closeSheet);
  return (
    <header className="sheet-head">
      <div>
        <div className="eyebrow">{eyebrow}</div>
        <h2 className="sheet-title">
          {title} {sub && <span className="sheet-repo">{sub}</span>}
        </h2>
      </div>
      <button type="button" className="mini close" onClick={close} aria-label="Close">
        ✕
      </button>
    </header>
  );
}

export function NewSproutSheet() {
  const close = useStore((s) => s.closeSheet);
  const create = useStore((s) => s.createSprout);
  const show = useStore((s) => s.showSprout);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = (form: FormData) => {
    setBusy(true);
    setError(null);
    create(form).then(
      (s) => show(s.id),
      (e: unknown) => {
        setError(errText(e));
        setBusy(false);
      },
    );
  };
  return (
    <>
      <SheetHead eyebrow="incubator" title="a new project" />
      <IntakeForm
        lead={<p className="blurb">Clarify reads everything given here and asks at most four questions; research then looks for something to renovate or extend before anything new is built.</p>}
        allowRepo
        busy={busy}
        error={error}
        submitLabel="start"
        onSubmit={submit}
        onCancel={close}
      />
    </>
  );
}

export function SproutSheet({ id }: { id: string }) {
  const close = useStore((s) => s.closeSheet);
  const sprout = useStore((s) => s.sprouts[id]);
  const showFlow = useStore((s) => s.showFlow);
  const answerSprout = useStore((s) => s.answerSprout);
  const addSproutInputs = useStore((s) => s.addSproutInputs);
  const stopSprout = useStore((s) => s.stopSprout);
  const resumeSprout = useStore((s) => s.resumeSprout);
  const dismissSprout = useStore((s) => s.dismissSprout);
  const [detail, setDetail] = useState<SproutDetail | null>(null);
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const updatedAt = sprout?.updatedAt;
  // the seed's own words, read again whenever the sprout moves
  useEffect(() => {
    let live = true;
    api.sprout(id).then(
      (d) => {
        if (live) setDetail(d);
      },
      () => {},
    );
    return () => {
      live = false;
    };
  }, [id, updatedAt]);
  const act = (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    fn()
      .catch((e: unknown) => setError(errText(e)))
      .finally(() => setBusy(false));
  };

  if (!sprout) {
    return (
      <>
        <p className="sheet-empty">That project is not in the incubator any more.</p>
        <footer className="sheet-foot">
          <span className="spacer" />
          <button type="button" className="mini" onClick={close}>
            close
          </button>
        </footer>
      </>
    );
  }
  const ended = sprout.status === "live" || sprout.status === "rejected" || sprout.status === "handed-off" || sprout.status === "stopped";
  if (adding) {
    return (
      <>
        <SheetHead eyebrow="add to" title={sprout.title} />
        <IntakeForm
          lead={<p className="blurb">After clarify has looked, more input sends the project back to clarify before research.</p>}
          allowRepo={false}
          busy={busy}
          error={error}
          submitLabel="add"
          onSubmit={(form) => act(() => addSproutInputs(id, form).then(() => setAdding(false)))}
          onCancel={() => setAdding(false)}
        />
      </>
    );
  }
  const asking = sprout.status === "clarifying" && (sprout.questions?.length ?? 0) > 0;
  const minutes = Math.round(sprout.spent.workMs / 60_000);
  return (
    <>
      <SheetHead eyebrow={`incubator · ${sproutWord(sprout)}`} title={sprout.title} sub={sprout.repoId} />
      <div className="sheet-body plan sprout-sheet">
        <StageStrip id={sprout.id} />
        {sprout.status === "parked" && (
          <div className="ask">
            <div className="eyebrow">parked</div>
            <p>{sprout.parked}</p>
            <div className="ask-row">
              <button type="button" className="mini strong" disabled={busy} onClick={() => act(() => resumeSprout(id, "continue"))}>
                continue
              </button>
              <button type="button" className="mini" disabled={busy} onClick={() => act(() => resumeSprout(id, "retry"))}>
                retry
              </button>
            </div>
          </div>
        )}
        {asking && sprout.questions && (
          <Questions
            questions={sprout.questions}
            who="clarify"
            busy={busy}
            onAnswer={(answers) => act(() => answerSprout(id, answers))}
            onDecline={() => act(() => answerSprout(id, null))}
            declineLabel="go on assumptions"
            declineTitle="Research goes on with what clarify assumed, and intent.md says you chose that"
          />
        )}
        <h3 className="eyebrow">intent</h3>
        {detail?.intent ? <pre className="sprout-doc">{detail.intent}</pre> : <p className="dim">Clarify has not written it yet.</p>}
        <h3 className="eyebrow">inputs</h3>
        <ul className="sprout-inputs">
          {sprout.inputs.map((e) => (
            <li key={e.n}>
              <span aria-hidden="true">{INPUT_GLYPH[e.kind]}</span> <span className="sprout-input-label">{e.label}</span>{" "}
              <span className="dim">{e.summary || e.note || "not summarized yet"}</span>
            </li>
          ))}
        </ul>
        {detail?.research && (
          <>
            <h3 className="eyebrow">research</h3>
            <pre className="sprout-doc">{detail.research}</pre>
          </>
        )}
        {sprout.flows.length > 0 && (
          <>
            <h3 className="eyebrow">stages run</h3>
            <ol className="sprout-flows">
              {sprout.flows.map((f) => (
                <li key={f.flowId}>
                  <button type="button" className="mini" onClick={() => showFlow(f.flowId)}>
                    {f.workflow}
                  </button>{" "}
                  <span className="dim">{f.outcome ?? "running"}</span>
                </li>
              ))}
            </ol>
          </>
        )}
        <p className="dim">
          {sprout.spent.runs} {sprout.spent.runs === 1 ? "run" : "runs"}, {minutes} {minutes === 1 ? "minute" : "minutes"} of agent work so far
        </p>
        {error && <p className="note err">{error}</p>}
      </div>
      <footer className="sheet-foot">
        {ended ? (
          <button type="button" className="mini" disabled={busy} title="Off the list; the seed, the inputs and the vault note stay" onClick={() => act(() => dismissSprout(id).then(close))}>
            dismiss
          </button>
        ) : (
          <>
            <button type="button" className="mini" disabled={busy} onClick={() => setAdding(true)}>
              add input
            </button>
            <button type="button" className="mini" disabled={busy} onClick={() => act(() => stopSprout(id))}>
              stop
            </button>
          </>
        )}
        <span className="spacer" />
        <button type="button" className="mini" onClick={close}>
          close
        </button>
      </footer>
    </>
  );
}
```

- [ ] **Step 3: Teach the inbox row the clarify item and a budget gate**

In `ui/src/components/Inbox.tsx`'s `InboxRow` (Task 11 already added `clarify` to `KIND_GLYPH` and `sprout` to `SOURCE_WORD`):

1. In `openSheet`, add `else if (item.source === "sprout") st.showSprout(item.id);`.
2. Replace the `Questions` element's spread line `{...(item.source === "ask" ? { onDecline: () => answer({ behavior: "deny" }) } : {})}` with:

```tsx
              {...(item.source === "ask"
                ? { onDecline: () => answer({ behavior: "deny" }) }
                : item.source === "sprout"
                  ? {
                      onDecline: () => answer({ skip: true }),
                      declineLabel: "go on assumptions",
                      declineTitle: "Research goes on with what clarify assumed, and intent.md says you chose that",
                    }
                  : {})}
```

3. In the gate block, the continue button's text becomes `{item.budget ? "allow one more step" : "continue"}` with `title={item.budget ? "The budget is spent; this lets one more step run, then it parks again" : undefined}`, and the retry button renders only when `!item.budget`.
4. The "open the …" button's word becomes `{item.source === "run" ? "run" : item.source === "sprout" ? "project" : "workflow"}`.

- [ ] **Step 4: Put the sheets in `RunSheet`**

In `ui/src/components/RunSheet.tsx`, import `NewSproutSheet` and `SproutSheet` from `./Incubator`, and in `Body`, before `if (sheet.kind === "flow")`, add:

```tsx
  if (sheet.kind === "new-sprout") return <NewSproutSheet />;
  if (sheet.kind === "sprout") return <SproutSheet id={sheet.id} />;
```

- [ ] **Step 5: The top bar's button**

In `ui/src/components/TopBar.tsx`, import `NewProjectButton` from `./Incubator`. In the desktop bar, add `<NewProjectButton />` inside the `topbar-group` span after `<SearchButton />`; in the phone bar, add it at the start of the `tb-line tb-tools tb-scroll` row. It renders nothing while home has no incubator.

- [ ] **Step 6: The view and the key**

In `ui/src/App.tsx`:

1. Import `IncubatorView` from `./components/Incubator`.
2. Add to `VIEWS`, after `agents`: `{ key: "incubator", label: "incubator", title: "Incubator: new projects from an idea, clarified and researched before anything is built" },`. Update the `ViewNav` comment from "The four views" to "The views".
3. `const OTHER_VIEWS = ["library", "ports", "agents", "incubator"];`
4. In the render, replace the `view === "agents" ? (…) : (<Library … />)` pair with:

```tsx
      {view === "agents" ? (
        <AgentsView onGit={() => navigate("git")} />
      ) : view === "incubator" ? (
        <IncubatorView onGit={() => navigate("git")} />
      ) : (
        <Library ports={view === "ports"} project={project} onRepo={showRepo} onPorts={() => navigate("ports")} />
      )}
```

5. In `onKey`, after `if (t.tagName === "INPUT" || t.tagName === "TEXTAREA") return;` and before `if (OTHER_VIEWS.includes(view)) return;`, add:

```ts
      // n: a new project, from the board or the incubator (⌘N is the
      // browser's new window, which a page cannot take)
      if (e.key === "n" && !e.metaKey && !e.ctrlKey && !e.altKey && (view === "git" || view === "incubator")) {
        const st = useStore.getState();
        if (st.sproutsReady && !st.sheet && !document.querySelector('[role="dialog"], [role="menu"]')) {
          e.preventDefault();
          st.openNewSprout();
        }
        return;
      }
```

- [ ] **Step 7: The styles**

Append to `ui/src/styles.css`:

```css
/* ---------- incubator ---------- */
.incubator-view {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: auto;
}
.incubator-empty {
  margin: 48px auto;
  max-width: 34rem;
  padding: 0 16px;
  color: var(--ink-dim);
  display: grid;
  gap: 12px;
  justify-items: start;
}
.sprout-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(min(100%, 320px), 1fr));
  gap: 12px;
  padding: 14px 16px;
}
.sprout-card {
  display: grid;
  gap: 8px;
  text-align: left;
  background: var(--bark1);
  border: 1px solid var(--hair);
  border-radius: var(--r-card);
  padding: 10px 12px;
  color: var(--ink);
  cursor: pointer;
}
.sprout-card.needs {
  border-color: color-mix(in srgb, var(--rust) 50%, var(--hair));
}
.sprout-head {
  display: flex;
  gap: 8px;
  align-items: baseline;
  justify-content: space-between;
}
.sprout-title {
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.sprout-word {
  color: var(--ink-dim);
  font-size: 12px;
  white-space: nowrap;
}
.sprout-word.st-parked,
.sprout-word.st-rejected {
  color: var(--rust);
}
.sprout-word.st-live {
  color: var(--moss);
}
.sprout-parked {
  color: var(--rust);
  font-size: 12px;
}
.sprout-meta {
  color: var(--ink-faint);
  font-size: 12px;
}
.stage-strip {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin: 0;
  padding: 0;
  list-style: none;
}
.stage {
  font-size: 11px;
  padding: 1px 6px;
  border-radius: var(--r);
  border: 1px solid var(--hair);
  color: var(--ink-faint);
}
.stage.done {
  color: var(--moss);
  border-color: color-mix(in srgb, var(--moss) 40%, var(--hair));
}
.stage.now {
  color: var(--sky);
  border-color: var(--sky);
}
.stage.stuck {
  color: var(--rust);
  border-color: var(--rust);
}
.drop-zone {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  padding: 12px;
  border: 1px dashed var(--hair);
  border-radius: var(--r);
}
.drop-zone.over {
  border-color: var(--sky);
  background: color-mix(in srgb, var(--sky) 8%, transparent);
}
.intake-files,
.sprout-inputs,
.sprout-flows {
  margin: 0;
  padding: 0;
  list-style: none;
  display: grid;
  gap: 4px;
  font-size: 13px;
}
.intake-line {
  width: 100%;
}
.recording {
  color: var(--rust);
}
.sprout-doc {
  white-space: pre-wrap;
  font-family: var(--mono);
  font-size: 12px;
  max-height: 16rem;
  overflow: auto;
  margin: 0;
  padding: 8px;
  background: var(--bark2);
  border-radius: var(--r);
}
```

- [ ] **Step 8: The gates**

Run: `bun run typecheck && bun run lint && SHELL=/bin/bash bun test && bun run build`
Expected: PASS.

- [ ] **Step 9: Check it in a browser**

Start a scratch server on a throwaway root with one repo, autostart off so no agent runs:

```bash
mkdir -p /tmp/claude-501/inc-root/app && git -C /tmp/claude-501/inc-root/app init -q
env -u TMUX CANOPY_CONFIG_DIR=/tmp/claude-501/inc-cfg CANOPY_PREVIEW_PORTS=0 CANOPY_NO_DESKTOP=1 CANOPY_INCUBATOR_AUTOSTART=0 \
  bun bin/canopy.ts ui /tmp/claude-501/inc-root --port 7893 --no-open
```

Then, with `playwright-cli` (open `http://127.0.0.1:7893/?view=incubator`, `resize 1440 900`, screenshots into the session scratchpad, read each one):

1. The incubator view shows the empty state and "+ project".
2. `n` opens the sheet; type an idea, add a link, drop nothing, press start. The sheet becomes the project's sheet, "waiting its turn to clarify" (autostart is off), the strip all "not yet".
3. The git view shows the seed's card `_incubator/<slug>` after a moment, and the feed has "new project in the incubator".
4. "add input" then "add" with a line of text: the inputs list grows to 2.
5. "stop", then "dismiss": the card leaves the incubator view.
6. Resize to 390 x 844: the view's cards stack, the sheet scrolls, nothing scrolls sideways.

Stop the server, `tmux -S /tmp/claude-501/inc-cfg/tmux.sock kill-server`, and remove `/tmp/claude-501/inc-root`, `/tmp/claude-501/inc-cfg` and the `.playwright-cli/` folder it leaves in the working directory.

- [ ] **Step 10: Commit**

```bash
git add ui/src/components/Incubator.tsx ui/src/components/Prompts.tsx ui/src/components/Inbox.tsx ui/src/components/RunSheet.tsx ui/src/components/TopBar.tsx ui/src/App.tsx ui/src/styles.css
git commit -m "feat(incubator): the incubator view, the + project sheet and clarify in the inbox

Claude-Session: https://claude.ai/code/session_01DMvREFYoLgpGe2oQNWq1Xu"
```

---
### Task 14: `canopy new` and `canopy incubator`

**Files:**
- Create: `src/cli/newargs.ts`, `src/cli/newargs.test.ts`
- Modify: `src/cli/index.ts` (`HELP`, `COMMANDS`, two `case`s)

**Interfaces:**
- Consumes: the routes of Task 10; `Sprout`, `SproutDetail` (Task 1).
- Produces:
  - `parseNewArgs(argv: string[], env: Record<string, string | undefined>): NewArgs | { error: string }` with `interface NewArgs { text: string; files: string[]; urls: string[]; repo?: string; backend: string }`. The backend is `--backend`, else `CANOPY_API` (what every canopy shell has), else `http://127.0.0.1:7850`.
  - `sproutLink(backend, id)`: `<backend>/?view=incubator&sprout=<id>`.
  - `canopy new "<idea>" [--file <path>]... [--url <url>]... [--repo <url>] [--backend URL]`, `canopy incubator list | show <id> [--backend URL]`.

- [ ] **Step 1: Write the failing test**

Create `src/cli/newargs.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { parseNewArgs, sproutLink } from "./newargs";

describe("parseNewArgs", () => {
  test("the idea, repeated files and links, a repo", () => {
    expect(parseNewArgs(["a", "coin", "counter", "--file", "a.png", "--url", "https://x.test", "--file", "b.m4a", "--repo", "https://github.com/a/b"], {})).toEqual({
      text: "a coin counter",
      files: ["a.png", "b.m4a"],
      urls: ["https://x.test"],
      repo: "https://github.com/a/b",
      backend: "http://127.0.0.1:7850",
    });
  });
  test("the backend: the flag, else the shell's CANOPY_API, else loopback", () => {
    expect(parseNewArgs(["x", "--backend", "http://mini:7850/"], { CANOPY_API: "http://127.0.0.1:9" })).toMatchObject({ backend: "http://mini:7850" });
    expect(parseNewArgs(["x"], { CANOPY_API: "http://127.0.0.1:9" })).toMatchObject({ backend: "http://127.0.0.1:9" });
  });
  test("nothing given, a flag with no value, or a backend that is not a web origin is an error", () => {
    expect(parseNewArgs([], {})).toEqual({ error: "give an idea, --file, --url or --repo" });
    expect(parseNewArgs(["x", "--file"], {})).toEqual({ error: "--file needs a value" });
    expect(parseNewArgs(["x", "--backend", "mini"], {})).toEqual({ error: "--backend must be an http(s) origin, got mini" });
  });
  test("a link to the project in the page", () => {
    expect(sproutLink("http://mini:7850", "sp_0123456789ab")).toBe("http://mini:7850/?view=incubator&sprout=sp_0123456789ab");
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `SHELL=/bin/bash bun test src/cli/newargs.test.ts`
Expected: FAIL, `Cannot find module './newargs'`.

- [ ] **Step 3: Write `src/cli/newargs.ts`**

```ts
/** `canopy new`'s arguments, read without touching the disk or the network. */

export interface NewArgs {
  text: string;
  files: string[];
  urls: string[];
  repo?: string;
  backend: string;
}

const VALUED = new Set(["--file", "--url", "--repo", "--backend"]);

export function parseNewArgs(argv: string[], env: Record<string, string | undefined>): NewArgs | { error: string } {
  const words: string[] = [];
  const files: string[] = [];
  const urls: string[] = [];
  let repo: string | undefined;
  let backend: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? "";
    if (!VALUED.has(a)) {
      words.push(a);
      continue;
    }
    const v = argv[i + 1];
    if (v === undefined || v.startsWith("--")) return { error: `${a} needs a value` };
    i += 1;
    if (a === "--file") files.push(v);
    else if (a === "--url") urls.push(v);
    else if (a === "--repo") repo = v;
    else backend = v;
  }
  const origin = (backend ?? env["CANOPY_API"] ?? "http://127.0.0.1:7850").replace(/\/+$/, "");
  if (!/^https?:\/\/[^/\s]+$/.test(origin)) return { error: `--backend must be an http(s) origin, got ${backend ?? origin}` };
  const text = words.join(" ").trim();
  if (!text && files.length === 0 && urls.length === 0 && !repo) return { error: "give an idea, --file, --url or --repo" };
  return { text, files, urls, ...(repo ? { repo } : {}), backend: origin };
}

export const sproutLink = (backend: string, id: string): string => `${backend.replace(/\/+$/, "")}/?view=incubator&sprout=${id}`;
```

- [ ] **Step 4: Run it**

Run: `SHELL=/bin/bash bun test src/cli/newargs.test.ts`
Expected: PASS.

- [ ] **Step 5: Add the commands**

In `src/cli/index.ts`:

1. Imports: `basename` beside `join, resolve` from `node:path`; `import { parseNewArgs, sproutLink } from "./newargs";`; and `Sprout`, `SproutDetail` in the type import from `../core/types`.
2. In `HELP`, before the `canopy version` line:

```
  canopy new "<idea>" [--file f]... [--url u]... [--repo url]
                                     start a project in the incubator; prints its link
  canopy incubator list | show <id>  the incubator's projects, or one project
    --backend URL                    the backend (default: $CANOPY_API, else 127.0.0.1:7850)
```

3. Add `"new"` and `"incubator"` to `COMMANDS`.
4. Before the `case "version":` line, add:

```ts
    case "new": {
      const parsed = parseNewArgs(args, process.env);
      if ("error" in parsed) return fail(parsed.error);
      const form = new FormData();
      if (parsed.text) form.append("text", parsed.text);
      for (const u of parsed.urls) form.append("url", u);
      if (parsed.repo) form.append("repo", parsed.repo);
      for (const path of parsed.files) {
        const f = Bun.file(path);
        if (!(await f.exists())) return fail(`no such file: ${path}`);
        form.append("file", new File([await f.arrayBuffer()], basename(path), { type: f.type }), basename(path));
      }
      form.append("via", "cli");
      const res = await fetch(`${parsed.backend}/api/incubator`, { method: "POST", body: form }).catch((err: unknown) =>
        fail(`${parsed.backend} did not answer: ${String(err instanceof Error ? err.message : err)}`),
      );
      const body = (await res.json().catch(() => ({}))) as Partial<Sprout> & { error?: string };
      if (!res.ok || !body.id) return fail(body.error ?? `the backend answered ${res.status}`);
      console.log(`${moss(body.id)} ${body.title ?? ""}`);
      console.log(sky(sproutLink(parsed.backend, body.id)));
      return;
    }
    case "incubator": {
      const fromEnv = process.env["CANOPY_API"];
      const backend = (opt(args, "--backend") ?? fromEnv ?? "http://127.0.0.1:7850").replace(/\/+$/, "");
      if (!/^https?:\/\//.test(backend)) return fail(`--backend must be an http(s) origin, got ${backend}`);
      const get = async <T>(path: string): Promise<T> => {
        const res = await fetch(`${backend}${path}`).catch((err: unknown) => fail(`${backend} did not answer: ${String(err instanceof Error ? err.message : err)}`));
        const body = (await res.json().catch(() => ({}))) as T & { error?: string };
        if (!res.ok) return fail(body.error ?? `the backend answered ${res.status}`);
        return body;
      };
      const sub = args[0] ?? "list";
      if (sub === "list") {
        const list = await get<Sprout[]>("/api/incubator");
        if (list.length === 0) console.log(dim("nothing in the incubator"));
        for (const s of list) {
          const why = s.parked ? dim(` (${s.parked})`) : s.questions?.length ? dim(` (${s.questions.length} questions waiting)`) : "";
          console.log(`${moss(s.id)}  ${s.status.padEnd(11)} ${s.title}${why}`);
        }
        return;
      }
      if (sub === "show") {
        const id = args[1];
        if (!id) return fail("usage: canopy incubator show <id>");
        const d = await get<SproutDetail>(`/api/incubator/one?id=${encodeURIComponent(id)}`);
        const s = d.sprout;
        console.log(`${bold(s.title)} ${dim(s.repoId)}`);
        console.log(`${s.status}${s.parked ? `: ${s.parked}` : ""}`);
        console.log(dim(`${s.spent.runs} runs, ${Math.round(s.spent.workMs / 60_000)} min of agent work`));
        if (d.intent) console.log(`\n${d.intent.trim()}`);
        console.log(`\n${d.inputsIndex.trim()}`);
        console.log(`\n${sky(sproutLink(backend, s.id))}`);
        return;
      }
      return fail("usage: canopy incubator list | show <id>");
    }
```

If the typecheck says `fail`'s `never` does not narrow `res` after the `.catch`, write the fetch as a `try { … } catch (err) { return fail(…) }` block instead; the behaviour is the same.

- [ ] **Step 6: Try it against the scratch server**

With the Task 13 scratch server running (`CANOPY_INCUBATOR_AUTOSTART=0`, port 7893):

```bash
bun bin/canopy.ts new "a shelf of seed packets, sorted by month" --backend http://127.0.0.1:7893
bun bin/canopy.ts incubator list --backend http://127.0.0.1:7893
bun bin/canopy.ts incubator show <the id it printed> --backend http://127.0.0.1:7893
```

Expected: an id and a `?view=incubator&sprout=` link; the list shows it `queued`; `show` prints the inputs index with `[1] text 001-text.md`. Opening the link in the browser opens that project's sheet.

- [ ] **Step 7: Typecheck, lint, commit**

Run: `bun run typecheck && bun run lint`
Expected: PASS.

```bash
git add src/cli/newargs.ts src/cli/newargs.test.ts src/cli/index.ts
git commit -m "feat(incubator): canopy new and canopy incubator list and show

Claude-Session: https://claude.ai/code/session_01DMvREFYoLgpGe2oQNWq1Xu"
```

---

### Task 15: Deploy settings, docs and the last gates

**Files:**
- Modify: `docker-compose.yml` (the `canopy` service's `environment`), `docs/deploy.md`, `CLAUDE.md`

**Interfaces:**
- Consumes: the env names of Tasks 4, 5 and 10: `CANOPY_VAULT_TOKEN`, `CANOPY_VAULT_URL`, `CANOPY_TRANSCRIBE_URL`, `CANOPY_TRANSCRIBE_KEY`, `CANOPY_TRANSCRIBE_MODEL`, `CANOPY_INCUBATOR_AUTOSTART`.
- Produces: the compose env that passes them through from the mini's `.env`; the docs.

- [ ] **Step 1: Compose**

In `docker-compose.yml`, in the `canopy` service's `environment:` block (near lines 107 to 145), after the last `CANOPY_*` entry, add:

```yaml
      # The incubator. The vault token is the memory gateway's, scoped
      # `agent`; transcription is any OpenAI-style /v1/audio/transcriptions
      # (LiteLLM on the mini). Every value here is readable by the agents
      # canopy starts: canopy shares the shells container's pid namespace,
      # so /proc/<canopy>/environ is in reach, the same as GH_TOKEN. Mint
      # the vault token for this alone and revoke it if it ever leaks.
      CANOPY_VAULT_TOKEN: ${CANOPY_VAULT_TOKEN:-}
      CANOPY_VAULT_URL: ${CANOPY_VAULT_URL:-}
      CANOPY_TRANSCRIBE_URL: ${CANOPY_TRANSCRIBE_URL:-}
      CANOPY_TRANSCRIBE_KEY: ${CANOPY_TRANSCRIBE_KEY:-}
      CANOPY_TRANSCRIBE_MODEL: ${CANOPY_TRANSCRIBE_MODEL:-}
      CANOPY_INCUBATOR_AUTOSTART: ${CANOPY_INCUBATOR_AUTOSTART:-}
```

Empty defaults, never `:?`: the backend runs without either and says so once in its log. If that block is a list (`- NAME=value`) rather than a map, write the same entries in its form.

Run: `docker compose config --quiet`
Expected: no output, exit 0. If docker is not on this machine, skip this line; the redeploy in the ops section runs compose anyway.

- [ ] **Step 2: `docs/deploy.md`**

Add a section after the tailchan one:

```markdown
## The incubator

New projects run on the backend that holds the launch root: seeds go to
`<root>/_incubator/<slug>`, the raw inputs and records to
`$CANOPY_CONFIG_DIR/incubator/` (0700, kept after a dismiss under
`.dismissed/`). Two optional settings in the mini's `.env`:

- `CANOPY_VAULT_TOKEN`: a memory gateway token with the `agent` scope,
  minted for canopy alone (`POST /tokens {"name":"canopy-incubator","scopes":["agent"]}`
  with the owner token). Without it there are no vault notes or daily lines.
  `CANOPY_VAULT_URL` overrides `https://mem.beric.ca`.
- `CANOPY_TRANSCRIBE_URL` (the `/v1` base of an OpenAI-style server, LiteLLM
  on the mini), `CANOPY_TRANSCRIBE_KEY`, `CANOPY_TRANSCRIBE_MODEL` (default
  `transcribe`). Without them a voice memo stays raw, marked "not
  transcribed", and clarify is told.

Both are readable by the agents canopy starts (the shared pid namespace).
`CANOPY_INCUBATOR_AUTOSTART=0` holds every project queued, for a pause.
```

- [ ] **Step 3: `CLAUDE.md`**

In `CLAUDE.md`'s Architecture list, after the "Tasks" bullet, add one bullet:

```markdown
- The incubator (`docs/superpowers/specs/2026-10-01-incubator-design.md`, phase 2 plan `docs/superpowers/plans/2026-10-01-incubator-phase-2-intake-clarify.md`): a new project from an idea, links, files, a voice memo or a repo, as a `Sprout` (`types.ts`) carried one workflow at a time through the existing `Flows`. `core/sprout.ts` (browser-safe, pure, tested) holds slugs, titles, what an upload is taken as (`inputType`, parameters dropped, `.md` by extension), the inputs index and the summaries clarify writes back, `parseQuestions` (at most `QUESTIONS_MAX`), `answersText`, `holdsSlot` (`SPROUT_CONCURRENCY` 2; a sprout waiting on questions holds none) and `nextWorkflow`. `core/incubator.ts`'s `Incubator` (deps injected, tested with fakes) answers an intake before anything slow: `prepare` transcribes (`core/transcribe.ts`, an OpenAI-style endpoint), makes the seed at `<root>/_incubator/<slug>` through `core/seed.ts` (a clone only of a `networkOrigin` url, the remote renamed `upstream`, commits as `canopy@<self>` of the `.canopy/` files alone, `readSeed` refusing a symlink), rescans, then `pump` starts the next stage; `onFlow` follows each owned flow's status on a microtask, and clarify's end reads `questions.json`, the summaries and the brief's title. Records live under `$CANOPY_CONFIG_DIR/incubator/` (`core/sproutstore.ts`); each change rewrites the vault note `02 - Dev/incubator/<slug>.md` and, for a start or park, appends to the daily note, through the memory gateway (`core/vault.ts`, `CANOPY_VAULT_TOKEN`, a failure logged and tried at the next change). The `clarify` workflow is `listed: false`: out of every repo's menu and refused by the flow and fleet routes. `server/incubator.ts` is the routes (`/api/incubator`, multipart intake, 415 and 413 by type and size), `restore()` runs after the flows' and `detach()` before they stop. UI: `ui/src/sprouts.ts` (pure: the stage strip, words, order, feed lines), the inbox's `sprout` source with kind `clarify` and "go on assumptions" as `{skip: true}`, `components/Incubator.tsx` (the `incubator` view, the + project sheet with a recorder on a secure page, the project's sheet), the `n` key; CLI `canopy new` and `canopy incubator list|show`. `CANOPY_INCUBATOR_AUTOSTART=0` keeps every sprout queued.
```

- [ ] **Step 4: The gates and the stale-build check**

Run: `bun run typecheck && bun run lint && SHELL=/bin/bash bun test && bun run build`
Expected: PASS.

Run: `~/.claude/skills/verify-build/clean-rebuild.sh check`
Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add docker-compose.yml docs/deploy.md CLAUDE.md
git commit -m "docs(incubator): deploy settings, the deploy doc and the CLAUDE.md bullet

Claude-Session: https://claude.ai/code/session_01DMvREFYoLgpGe2oQNWq1Xu"
```

---

## Ops after the code lands

Each step changes the mini or an outside service, so each waits on Eric's go-ahead, and none runs as part of the tasks above.

1. **A speech model on LiteLLM.** Add a `transcribe` model to the mini's LiteLLM config (Groq's `whisper-large-v3-turbo` is the cheap, fast one; OpenAI's `whisper-1` the fallback). From inside the canopy container, check it answers:
   `docker compose exec canopy sh -c 'curl -s -H "Authorization: Bearer $CANOPY_TRANSCRIBE_KEY" -F model=transcribe -F file=@/app/testdata/hello.m4a "$CANOPY_TRANSCRIBE_URL/audio/transcriptions"'`
   with any short recording in place of `hello.m4a`. A 404 means the model name is not in LiteLLM's list; a connection refused means the container cannot reach LiteLLM's port (the same ufw rule tailchan needed).
2. **The vault token.** Mint it with the owner token from `~/.config/vault/token`: `POST https://mem.beric.ca/tokens {"name":"canopy-incubator","scopes":["agent"]}`. The `agent` scope is the narrowest that can write `02 - Dev/` and the daily notes; it can also write most other folders, which is why it is minted for canopy alone. Record its name in the vault's token list so it can be revoked.
3. **The mini's `.env`.** Add `CANOPY_VAULT_TOKEN`, `CANOPY_TRANSCRIBE_URL`, `CANOPY_TRANSCRIBE_KEY` (and `CANOPY_TRANSCRIBE_MODEL` if not `transcribe`). Never commit it.
4. **Redeploy** through the `redeploy` skill (`bun run redeploy`), after the branch is merged and the peer pass has carried it to the mini. Then: the log has no "no CANOPY_VAULT_TOKEN" line; `canopy new "a test idea"` from a mini shell gives a link; the vault gets `02 - Dev/incubator/test-idea.md` and a line in today's daily note; clarify runs and ends with questions in the inbox or a park at "the scout workflow is not installed". Stop and dismiss the test sprout; its seed stays at `~/dev/_incubator/test-idea` until removed by hand.

## What comes after

- **Phase 3, research and pick:** the `scout` workflow (research, eval with the judge gate), `parsePick` and `pickRefusal`, `rejected`, and the build stages' entry point after the pick.
- **Phase 4, build to live:** `build-new`, `renovate`, `extend`, the host list and deploy, `live` and `handed-off`, the URL on the sheet.
- **Phase 5, retro and advice:** the `retro` workflow on every ended sprout, the `advice` inbox kind, accepted advice written back into the workflows, and the stats in the vault note.
