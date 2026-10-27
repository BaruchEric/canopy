# Work ledger, plan 1: a work item per branch, minted at start and carried by git (FR-037)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Status:** implemented and independently reviewed locally 2026-10-27 on `feat/oct26-batch`. Plans 2 and 3 remain open. Written on main at 1ac8fe7.

**Goal:** every branch run gets a work item, `w-xxxxxxxx`, kept under
`<configDir>/work/` by the holder of the flows lock; the branch is named after
it, the agent is asked for a `Canopy-Work:` trailer on every commit and the PR
body ends with one; the landing queue, the PR watch, the triggers and the
coordinator each write a line on the item as they move it; `canopy work`
lists, shows, notes and closes items.

**Architecture:** a pure model (`core/work.ts`) owns the id, the branch name,
the trailer, the notes and the derived state; a Bun store (`core/workstore.ts`)
reads and writes one file per item; a hub (`server/work.ts`) holds the items,
mints at branch start, takes the other hubs' lines through a small `WorkSink`
dep, derives each item's state from facts the server hands it, and serves the
routes and the `work` event. The item id rides on `RunBranch`, so every run on
a branch, a fix, a flow's step and a coordinator's child, carries it without a
new runner parameter.

**Tech Stack:** Bun, TypeScript strict, React 19, bun:test. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-25-work-ledger-design.md`, the
"Plans" list's item 1. The index is
`docs/superpowers/specs/2026-10-25-software-factory-borrowings-design.md`.
Plan 2 (handoff notes fenced into later runs, `handoffOf`, the run sheet block,
the `work` view, export) and plan 3 (rebuild from git, compaction) are left to
their own plans.

## Global constraints

- An id is `w-` and 8 characters of the lowercase base32 alphabet `abcdefghijklmnopqrstuvwxyz234567`, from 40 random bits: `WORK_ID = /^w-[a-z2-7]{8}$/`.
- Items live at `<configDir>/work/<id>.json`, one file each, written only by the holder of the flows lock through one serial queue and read back at `adopt`. Nothing in the repo; the ledger never syncs between backends.
- A branch run's branch is `run/<id>-<slug>` in place of `run/<slug>-<run id>`; the run id stays on the record and the worktree folder. `peersync`'s `run/*` exclusion is unchanged.
- The trailer is `Canopy-Work: w-xxxxxxxx` (`WORK_TRAILER` is `Canopy-Work`): `branchLine` asks for it on every commit, `prBody` puts it on its last line. It is a request to the agent, never a gate.
- A note is at most `NOTE_CHARS` (600) characters; an item keeps at most `NOTES_MAX` (40), the oldest folded into one `earlier: …` line.
- `by` is `canopy` for the lines the hubs write, and the caller's label (else `eric`) for a note from the page or the CLI. Agents write no notes in plan 1: FR-038 run tokens are only specified.
- The state is derived (`open`, `working`, `review`, `landed`, `dropped`); nothing sets `working` or `review` by hand. Only `close` is by hand, and it is refused (409) while a run on the item is active.
- Every branch gets an item; a checkout run gets none; the coordinator's goal is not an item.
- Every file the UI imports from `src/core/` stays browser-safe: `core/work.ts` has no `node:` or `bun` import; `mintId` uses the global `crypto`.
- Plain words, no em dashes, sentence case headings (the unslop rules apply to docs and commit messages). No backticks in commit messages.
- All four gates pass before a task is done: `bun run typecheck`, `bun run lint`, `bun test`, `bun run build`.

## Review focus

Inputs the spec implies and no section of it names. Each has a test in the task that owns the code.

1. A landing record, PR watch or event from before the ledger, with no `work`: the hubs write nothing and nothing throws, and a fix run on it starts with a `branchLine` that asks for no trailer (Task 2 for the line, Task 5 for the record).
2. A line for an id the ledger does not hold (the file was lost, or it is the other backend's id): dropped with a log line, never minted into a titleless item (Task 4).
3. A branch whose name is not `run/w-…-slug` (an orphan queued from the landing section, an old branch): `workIdOf` is null, and `canopy work note` without an id says the folder is not on a work branch rather than posting to nothing (Task 1 for the parse, Task 9 for the words).
4. A run that cannot start after its item was minted (the slots filled, the harness refused): the item is closed `dropped` with the reason, not left `open` forever with no branch (Task 8).
5. A long-lived item past forty lines: the oldest fold into one `earlier:` line, the item stays at `NOTES_MAX`, the newest line is never lost and a folded line never exceeds `NOTE_CHARS` (Task 1).

---

## File structure

- Create `src/core/work.ts` (pure): `WorkItem`, `WorkState`, `WorkFrom`, `WorkNote`, `WorkInfo`, `WorkStart`, `WorkFacts`, `WorkSink`, the constants, `mintId`, `isWorkId`, `branchSlug` (moved from `worktree.ts`), `workBranchName`, `workIdOf`, `titleOf`, `fromWord`, `trailerLine`, `trailerOf`, `addNote`, `stateOf`.
- Create `src/core/work.test.ts`.
- Modify `src/core/worktree.ts`: re-export `branchSlug`, drop `runBranchName`; `src/core/worktree.test.ts`.
- Modify `src/core/types.ts`: `RunBranch.work`, `LandingRun.work`, `PrWatch.work`, `CoordTask.work`, the `work` event. `src/core/trigger.ts`: `TriggerEvent.work`.
- Modify `src/core/actions.ts` and `src/core/actions.test.ts`: `branchLine` asks for the trailer. `src/core/pr.ts` and `src/core/pr.test.ts`: `prBody` ends with it.
- Create `src/core/workstore.ts` (Bun) and `src/core/workstore.test.ts`.
- Create `src/server/work.ts` (`WorkHub`) and `src/server/work.test.ts`; modify `src/core/callers.ts` and `src/core/callers.test.ts`.
- Modify `src/server/landing.ts`, `src/server/landing.test.ts`: `LandingDeps.work`, the record's `work`, the lines.
- Modify `src/server/prs.ts`, `src/server/prs.test.ts`: `PrDeps.work`, the watch's `work`, the lines.
- Modify `src/server/triggers.ts`, `src/server/triggers.test.ts`, `src/server/coordinator.ts`, `src/server/coordinator.test.ts`: the same.
- Modify `src/core/issue.ts`, `src/core/issue.test.ts`: `resolveIssueNote` says which issue it read.
- Modify `src/server/index.ts`, `src/server/landing-run.test.ts`: minting at branch start, the hub, its routes and events, adopt and detach.
- Create `src/cli/work.ts`, `src/cli/work.test.ts`; modify `src/cli/index.ts`, `src/core/help.ts`, `README.md`.
- Modify `docs/architecture.md`, `SPEC.md`, `FEATURES.md`, `docs/superpowers/plans/README.md`.

---

### Task 1: the model

**Files:**
- Create: `src/core/work.ts`, `src/core/work.test.ts`
- Modify: `src/core/worktree.ts:6` (the header's branch form), `:30-40` (`branchSlug`, `runBranchName`); `src/core/worktree.test.ts:70-75`

**Interfaces:**
- Consumes: `LandState`, `RunBranchState` from `core/types.ts` (type imports only).
- Produces, all in `src/core/work.ts`:

```ts
export const WORK_ID = /^w-[a-z2-7]{8}$/;
export const NOTE_CHARS = 600;
export const NOTES_MAX = 40;
export const TITLE_CHARS = 120;
export const WORK_TRAILER = "Canopy-Work";
export const WORK_STATES = ["open", "working", "review", "landed", "dropped"] as const;
export type WorkState = (typeof WORK_STATES)[number];
export type WorkFrom =
  | { kind: "note" }
  | { kind: "issue"; service: string; key: string; link?: string }
  | { kind: "coordinator"; run: string; card: string }
  | { kind: "trigger"; event: string };
export interface WorkNote {
  at: number;
  /** `canopy` for a hub's line, the caller's label for one from the page or the CLI */
  by: string;
  text: string;
}
export interface WorkItem {
  /** `w-` and 8 lowercase base32 characters, minted by canopy */
  id: string;
  title: string;
  /** repo ids on this backend */
  repos: string[];
  state: WorkState;
  from: WorkFrom;
  /** everything that served it, newest last */
  runs: string[];
  /** `RunBranch.origin` */
  branches: string[];
  prs: { number: number; url: string }[];
  /** `TriggerEvent.id` */
  events: string[];
  /** oldest first */
  notes: WorkNote[];
  createdAt: number;
  updatedAt: number;
  closedAt?: number;
  /** why it was dropped */
  reason?: string;
}
export interface WorkInfo {
  items: WorkItem[];
  /** compacted items (plan 3); 0 until then */
  archived: number;
}
/** what a branch start says about the item it mints */
export interface WorkStart {
  title: string;
  from: WorkFrom;
}
/** what the server knows of an item's runs and branches, for its state */
export interface WorkFacts {
  /** any of its runs is active */
  active: boolean;
  /** each branch a landing record names; a landed or merged one is gone from here, so the hub closes the item first */
  branches: { state: RunBranchState; land?: LandState; pr?: "open" | "merged" | "closed" }[];
}
/** how the other hubs reach the ledger; `WorkHub` implements it */
export interface WorkSink {
  /** a `by: canopy` line */
  note(id: string, text: string): void;
  /** the item's end, with the line that says how */
  close(id: string, state: "landed" | "dropped", text: string): void;
  /** a PR or trigger event that now serves the item; kept once */
  link(id: string, ref: { pr: { number: number; url: string } } | { event: string }): void;
}
/** `w-` and 8 base32 characters from 5 random bytes; `random` is the global crypto unless a test says otherwise */
export function mintId(random?: (n: number) => Uint8Array): string;
export const isWorkId = (v: unknown): v is string => typeof v === "string" && WORK_ID.test(v);
/** moved here from worktree.ts, unchanged */
export function branchSlug(note: string): string;
export const workBranchName = (id: string, note: string): string => `run/${id}-${branchSlug(note)}`;
/** the id a `run/<id>-<slug>` branch carries, else null */
export function workIdOf(branch: string | null | undefined): string | null;
/** the note's first non-empty line, whitespace folded, cut to TITLE_CHARS; "untitled work" when there is none */
export function titleOf(note: string): string;
/** "a note", "github issue o/r#12", "coordinator c1, card t2", "trigger event e1" */
export function fromWord(from: WorkFrom): string;
export const trailerLine = (id: string): string => `${WORK_TRAILER}: ${id}`;
/** the id of the last whole line `Canopy-Work: <id>` in a commit message, else null */
export function trailerOf(message: string): string | null;
/** `note` trimmed and cut to NOTE_CHARS, appended; past NOTES_MAX the oldest fold into one line */
export function addNote(notes: readonly WorkNote[], note: WorkNote): WorkNote[];
export function stateOf(item: Pick<WorkItem, "state" | "closedAt">, facts: WorkFacts): WorkState;
```

`mintId`: 5 bytes, read 5 bits at a time most significant first, each mapped through the alphabet `abcdefghijklmnopqrstuvwxyz234567`.

`addNote`'s fold: when the list would be longer than `NOTES_MAX`, the oldest `length - NOTES_MAX + 1` notes become one `{ at: <the newest of them>.at, by: "canopy", text }` where `text` is `earlier: ` followed by their texts, each with a leading `earlier: ` removed and cut to 80 characters, joined by ` · `, the whole cut to `NOTE_CHARS`. A note whose text is empty after trimming is not added.

`stateOf`, in order: `closedAt` set keeps `item.state`; any branch with `land` `landed` or `pr` `merged` is `landed`; `active` or any branch `working` is `working`; any branch `ready` or `stopped`, or with `land` set, or with `pr` `open`, is `review`; else `open`.

In `src/core/worktree.ts`: `export { branchSlug } from "./work";` replaces the function; `runBranchName` goes; the header comment's branch form becomes `run/<work id>-<slug>`. `issue.test.ts` imports `branchSlug` from `./worktree` and keeps working.

- [ ] **Step 1: Write the failing tests in `src/core/work.test.ts`**

```ts
import { describe, expect, test } from "bun:test";
import { addNote, branchSlug, fromWord, isWorkId, mintId, NOTE_CHARS, NOTES_MAX, stateOf, titleOf, trailerLine, trailerOf, WORK_ID, WORK_TRAILER, workBranchName, workIdOf, type WorkNote } from "./work";

describe("ids", () => {
  test("mintId is w- and eight base32 characters from 40 random bits", () => {
    expect(mintId(() => new Uint8Array([0, 0, 0, 0, 0]))).toBe("w-aaaaaaaa");
    expect(mintId(() => new Uint8Array([255, 255, 255, 255, 255]))).toBe("w-77777777");
    const a = mintId();
    expect(a).toMatch(WORK_ID);
    expect(mintId()).not.toBe(a);
    expect(isWorkId("w-test2345")).toBe(true);
    expect([isWorkId("w-test1234"), isWorkId("W-TEST2345"), isWorkId("w-test234"), isWorkId(12)]).toEqual([false, false, false, false]);
  });
});

describe("the branch name", () => {
  test("run/<id>-<slug>, and the id read back off it", () => {
    expect(branchSlug("Fix the README's typo!")).toBe("fix-the-readme-s-typo");
    expect(branchSlug("   ")).toBe("run");
    expect(branchSlug("a".repeat(50))).toHaveLength(32);
    expect(workBranchName("w-test2345", "add a test")).toBe("run/w-test2345-add-a-test");
    expect(workIdOf("run/w-test2345-add-a-test")).toBe("w-test2345");
    expect(workIdOf("run/w-test2345-run")).toBe("w-test2345");
    expect([workIdOf("run/add-a-test-ab12cd34"), workIdOf("main"), workIdOf(null), workIdOf("run/w-test1234-x")]).toEqual([null, null, null, null]);
  });
});

describe("the trailer", () => {
  test("the line, and reading it back from a commit message", () => {
    expect(WORK_TRAILER).toBe("Canopy-Work");
    expect(trailerLine("w-test2345")).toBe("Canopy-Work: w-test2345");
    expect(trailerOf("feat: a thing\n\nMore words.\n\nCanopy-Work: w-test2345\n")).toBe("w-test2345");
    expect(trailerOf("feat: a thing\n\nCanopy-Work: w-test2345\nClaude-Session: https://x\n")).toBe("w-test2345");
    expect(trailerOf("feat: a thing\n\nCanopy-Work: w-test2345\n\nCanopy-Work: w-other234\n")).toBe("w-other234");
    expect([trailerOf("feat: a thing"), trailerOf("Canopy-Work: nope"), trailerOf("see Canopy-Work: w-test2345 in the body")]).toEqual([null, null, null]);
  });
});

test("titleOf is the note's first line, folded and cut", () => {
  expect(titleOf("\n\n  Add   a test\nmore\n")).toBe("Add a test");
  expect(titleOf("x".repeat(200))).toHaveLength(120);
  expect(titleOf("   ")).toBe("untitled work");
  expect(titleOf("GitHub issue #12: Login redirect loops\nWork from this issue.")).toBe("GitHub issue #12: Login redirect loops");
});

test("fromWord", () => {
  expect(fromWord({ kind: "note" })).toBe("a note");
  expect(fromWord({ kind: "issue", service: "github", key: "o/r#12", link: "https://github.com/o/r/issues/12" })).toBe("github issue o/r#12");
  expect(fromWord({ kind: "coordinator", run: "c1", card: "t2" })).toBe("coordinator c1, card t2");
  expect(fromWord({ kind: "trigger", event: "e1" })).toBe("trigger event e1");
});

describe("addNote", () => {
  const note = (i: number, text = `n${i}`): WorkNote => ({ at: i, by: "canopy", text });
  test("appends, trims and cuts to NOTE_CHARS; an empty line is not added", () => {
    const out = addNote([note(1)], note(2, `  ${"x".repeat(700)}  `));
    expect(out.map((n) => n.at)).toEqual([1, 2]);
    expect(out[1]!.text).toHaveLength(NOTE_CHARS);
    expect(addNote(out, note(3, "   "))).toEqual(out);
  });
  test("past NOTES_MAX the oldest fold into one earlier line, and fold again", () => {
    let notes: WorkNote[] = [];
    for (let i = 1; i <= NOTES_MAX + 1; i++) notes = addNote(notes, note(i));
    expect(notes).toHaveLength(NOTES_MAX);
    expect(notes[0]).toEqual({ at: 2, by: "canopy", text: "earlier: n1 · n2" });
    expect(notes[1]!.text).toBe("n3");
    notes = addNote(notes, note(NOTES_MAX + 2));
    expect(notes).toHaveLength(NOTES_MAX);
    expect(notes[0]).toEqual({ at: 3, by: "canopy", text: "earlier: n1 · n2 · n3" });
    expect(notes.at(-1)!.text).toBe(`n${NOTES_MAX + 2}`);
  });
  test("a folded line stays within NOTE_CHARS", () => {
    let notes: WorkNote[] = [];
    for (let i = 1; i <= NOTES_MAX + 1; i++) notes = addNote(notes, note(i, "y".repeat(NOTE_CHARS)));
    expect(notes[0]!.text.length).toBeLessThanOrEqual(NOTE_CHARS);
    expect(notes[0]!.text.startsWith("earlier: ")).toBe(true);
  });
});

describe("stateOf", () => {
  const open = { state: "open" as const };
  test("derived from the runs and branches, in order", () => {
    expect(stateOf(open, { active: false, branches: [] })).toBe("open");
    expect(stateOf(open, { active: true, branches: [] })).toBe("working");
    expect(stateOf(open, { active: false, branches: [{ state: "working" }] })).toBe("working");
    expect(stateOf(open, { active: false, branches: [{ state: "ready" }] })).toBe("review");
    expect(stateOf(open, { active: false, branches: [{ state: "ready", land: "red" }] })).toBe("review");
    expect(stateOf(open, { active: false, branches: [{ state: "stopped" }] })).toBe("review");
    expect(stateOf(open, { active: false, branches: [{ state: "ready", pr: "open" }] })).toBe("review");
    expect(stateOf(open, { active: false, branches: [{ state: "nothing" }, { state: "uncommitted" }] })).toBe("open");
    expect(stateOf(open, { active: false, branches: [{ state: "ready", land: "landed" }] })).toBe("landed");
    expect(stateOf(open, { active: false, branches: [{ state: "ready", pr: "merged" }] })).toBe("landed");
    // a run going beats a sent-back branch: the fix is on its way
    expect(stateOf(open, { active: true, branches: [{ state: "ready", land: "conflict" }] })).toBe("working");
  });
  test("a closed item keeps its state whatever the facts say", () => {
    expect(stateOf({ state: "dropped", closedAt: 5 }, { active: true, branches: [{ state: "working" }] })).toBe("dropped");
    expect(stateOf({ state: "landed", closedAt: 5 }, { active: false, branches: [] })).toBe("landed");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test src/core/work.test.ts`
Expected: FAIL, the module is not found.

- [ ] **Step 3: Write `src/core/work.ts`, move `branchSlug`, drop `runBranchName`**

Header comment: the work item, where items live, that git carries the id in the branch name and the trailer, and that the file is pure and browser-safe. In `src/core/worktree.test.ts:70-75`, take the `branchSlug` and `runBranchName` lines out of the "a branch slug is lower case words from the note" test (both moved to `work.test.ts`); the test keeps nothing, so remove it.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test src/core/work.test.ts src/core/worktree.test.ts src/core/issue.test.ts && bun run typecheck`
Expected: PASS; typecheck fails only in `src/server/index.ts` on the `runBranchName` import, which Task 8 removes. If that one error blocks the commit's gates, change `src/server/index.ts:222` to import `workBranchName` from `../core/work` and `:1193` to `workBranchName(id, note)` now, where `id` is still the run id; Task 8 moves the real id in.

- [ ] **Step 5: Commit**

```bash
git add src/core/work.ts src/core/work.test.ts src/core/worktree.ts src/core/worktree.test.ts src/server/index.ts
git commit -m "feat(work): the work item model, its id, branch name, trailer, notes and derived state (FR-037)"
```

---

### Task 2: the id on the records and in git

**Files:**
- Modify: `src/core/types.ts:1259-1280` (`RunBranch`), `:991-1008` (`CoordTask`), `:1325` (`PrWatch`), `:1479-1508` (`LandingRun`), `:1585` (after the `prs` event); `src/core/trigger.ts:98-146` (`TriggerEvent`), `:527` (the comment naming the branch form); `src/core/actions.ts:233-244`; `src/core/actions.test.ts`; `src/core/pr.ts:211-215`; `src/core/pr.test.ts`

**Interfaces:**
- Consumes: `trailerLine`, `WorkItem` from Task 1.
- Produces in `src/core/types.ts`:

```ts
export interface RunBranch {
  /** `run/<work id>-<slug>` */
  name: string;
  ...
  /** the work item this branch serves (FR-037), in its name too; every run on the branch carries it */
  work?: string;
}
export interface LandingRun { ...; /** the branch's work item (FR-037); a record from before the ledger has none */ work?: string }
export interface PrWatch { ...; /** the branch's work item (FR-037) */ work?: string }
export interface CoordTask { ...; /** the child's work item, once it started (FR-037) */ work?: string }
export type ServerEvent = ... | { type: "prs"; prs: PrWatch[] }
  /** every work item, whole, whenever one changes (FR-037) */
  | { type: "work"; items: WorkItem[] } | ...
```

with `import type { WorkItem } from "./work"` (a type-only cycle with `work.ts`, erased at build). `TriggerEvent.work?: string` in `core/trigger.ts` with the comment "the branch's work item (FR-037)". The store takes events by `if` on `ev.type` (`ui/src/store.ts:3034-3045`), so the new member needs no UI change in plan 1.

- Produces in `src/core/actions.ts`:

```ts
export function branchLine(b: { name: string; dir: string; target: string; work?: string }): string;
export function branchPrompt(repo: Repo, spec: ActionSpec, note: string, b: { name: string; dir: string; target: string; work?: string }): string;
```

`branchLine` with `work` ends with one more sentence, after a space: `End every commit message with the line "Canopy-Work: <work>" after a blank line: the trailer that ties the commit to this work.` Without `work` the paragraph is as today.

- Produces in `src/core/pr.ts`: `prBody(note: string, commits: readonly string[], work?: string): string`, which with `work` ends with `\n\n` and `trailerLine(work)`.

- [ ] **Step 1: Write the failing tests**

In `src/core/actions.test.ts`, importing `branchLine` and `branchPrompt` with the rest:

```ts
describe("branchLine", () => {
  test("asks for the work trailer on every commit, and nothing of it without an item", () => {
    const b = { name: "run/w-test2345-add-a-test", dir: "/w/x", target: "main", work: "w-test2345" };
    const line = branchLine(b);
    expect(line.startsWith("You work on the branch run/w-test2345-add-a-test, in a worktree of its own at /w/x, cut from main.")).toBe(true);
    expect(line.endsWith('End every commit message with the line "Canopy-Work: w-test2345" after a blank line: the trailer that ties the commit to this work.')).toBe(true);
    expect(branchLine({ name: "run/x", dir: "/w/x", target: "main" })).not.toContain("Canopy-Work");
    expect(branchPrompt(repo(), ACTIONS.ask, "add a test", b)).toContain('"Canopy-Work: w-test2345"');
  });
});
```

In `src/core/pr.test.ts`, importing `prBody`:

```ts
describe("prBody", () => {
  test("the note, the commits, and the work trailer on the last line", () => {
    expect(prBody("add a test", ["feat: a", "fix: b"], "w-test2345")).toBe("add a test\n\nCommits:\n- feat: a\n- fix: b\n\nOpened by canopy from a branch run.\n\nCanopy-Work: w-test2345");
    expect(prBody("", [])).toBe("A canopy branch run.\n\nOpened by canopy from a branch run.");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test src/core/actions.test.ts src/core/pr.test.ts`
Expected: FAIL on the two new tests.

- [ ] **Step 3: Add the fields, the event, the sentence and the last line**

Update the comments that name the old branch form: `src/core/types.ts:1260`, `src/core/trigger.ts:527`, `src/core/peers.ts:55`.

- [ ] **Step 4: Run the tests, typecheck and lint**

Run: `bun test src/core/actions.test.ts src/core/pr.test.ts src/core/trigger.test.ts && bun run typecheck && bun run lint`
Expected: PASS, clean.

- [ ] **Step 5: Commit**

```bash
git add src/core/types.ts src/core/trigger.ts src/core/peers.ts src/core/actions.ts src/core/actions.test.ts src/core/pr.ts src/core/pr.test.ts
git commit -m "feat(work): the item id on branches, records, watches, events and cards; the trailer in branchLine and prBody"
```

---

### Task 3: the store

**Files:**
- Create: `src/core/workstore.ts`, `src/core/workstore.test.ts`

**Interfaces:**
- Consumes: `configDir` from `core/store.ts`; `WorkItem`, `isWorkId` from Task 1.
- Produces in `src/core/workstore.ts` (Bun: `node:fs/promises`, `node:path`):

```ts
export const workDir = (): string => join(configDir(), "work");
/** every `<id>.json` under `dir` whose id and title read, in id order; one that does not is logged and left alone; no folder is none */
export async function readWorkItems(dir: string): Promise<WorkItem[]>;
/** `<dir>/<id>.json`, the folder made, written whole through `<path>.tmp-<pid>` and a rename */
export async function writeWorkItem(dir: string, item: WorkItem): Promise<void>;
```

A file reads when its value is an object with `isWorkId(id)` and a string `title`; the log line is `work: <file> unreadable, left alone: <why>`.

- [ ] **Step 1: Write the failing tests in `src/core/workstore.test.ts`**

```ts
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkItem } from "./work";
import { readWorkItems, writeWorkItem } from "./workstore";

let root = "";
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "canopy-workstore-"));
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

const item = (id: string): WorkItem => ({ id, title: `work ${id}`, repos: ["r"], state: "open", from: { kind: "note" }, runs: [], branches: [], prs: [], events: [], notes: [], createdAt: 1, updatedAt: 1 });

test("one file per item, read back in id order; a bad file is skipped; no folder is none", async () => {
  const dir = join(root, "work1");
  expect(await readWorkItems(dir)).toEqual([]);
  await writeWorkItem(dir, item("w-testbbbb"));
  await writeWorkItem(dir, item("w-testaaaa"));
  await writeFile(join(dir, "broken.json"), "{");
  await writeFile(join(dir, "w-testcccc.json"), JSON.stringify({ id: "nope" }));
  expect((await readdir(dir)).sort()).toEqual(["broken.json", "w-testaaaa.json", "w-testbbbb.json", "w-testcccc.json"]);
  expect((await readWorkItems(dir)).map((i) => i.id)).toEqual(["w-testaaaa", "w-testbbbb"]);
  expect(JSON.parse(await readFile(join(dir, "w-testaaaa.json"), "utf8"))).toEqual(item("w-testaaaa"));
});

test("a write replaces the file whole and leaves no temp file", async () => {
  const dir = join(root, "work2");
  await writeWorkItem(dir, item("w-testaaaa"));
  await writeWorkItem(dir, { ...item("w-testaaaa"), title: "renamed" });
  expect(await readdir(dir)).toEqual(["w-testaaaa.json"]);
  expect((await readWorkItems(dir))[0]?.title).toBe("renamed");
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test src/core/workstore.test.ts`
Expected: FAIL, the module is not found.

- [ ] **Step 3: Write `src/core/workstore.ts`**

Header: "The work ledger on disk: one JSON file per item under `<configDir>/work/`. Bun-only; the hub that writes through here is `server/work.ts`."

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test src/core/workstore.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/workstore.ts src/core/workstore.test.ts
git commit -m "feat(work): read and write one file per work item under the config dir"
```

---

### Task 4: the hub, its routes and their rights

**Files:**
- Create: `src/server/work.ts`, `src/server/work.test.ts`
- Modify: `src/core/callers.ts:59` (beside the `landing/*, prs/*` rule), `src/core/callers.test.ts` (after the coordinator's describe, around `:165`)

**Interfaces:**
- Consumes: Task 1's model, Task 3's store; `Caller` from `server/callers.ts` (a type import); `Run`, `ServerEvent` from `core/types.ts`.
- Produces in `src/server/work.ts`:

```ts
export interface WorkDeps {
  broadcast: (ev: ServerEvent) => void;
  /** what the hubs know of an item's runs and branches, for its state */
  facts: (item: WorkItem) => WorkFacts;
  dir?: string;
  now?: () => number;
  /** the ids minted; `mintId()` unless a test says otherwise */
  mintId?: () => string;
}
export class WorkHub implements WorkSink {
  constructor(deps: WorkDeps);
  /** every item, newest updated first; `repo` keeps the ones naming it, `state` the ones in it */
  info(repo?: string, state?: WorkState): WorkInfo;
  get(id: string): WorkItem | undefined;
  /** a new open item, kept at once; the id is the caller's to put in the branch name */
  mint(start: WorkStart & { repos: string[] }): WorkItem;
  /** a line on the item; `by` is `canopy` unless said; an unknown id is logged and dropped */
  note(id: string, text: string, by?: string): void;
  /** the item's end, with the line that says how; `dropped` keeps `text` as the reason */
  close(id: string, state: "landed" | "dropped", text: string, by?: string): void;
  link(id: string, ref: { pr: { number: number; url: string } } | { event: string }): void;
  /** the runner's every change: a run whose branch names an item is written on it, and the state follows */
  onRun(run: Run): void;
  /** the landing queue or the PR watch moved: every open item's state is derived again */
  recheck(): void;
  /** takes the files the last server left, writes what was minted before the lock, derives every state; writes from now on */
  adopt(): Promise<void>;
  detach(): void;
  /** resolves once every write asked for so far is on disk */
  idle(): Promise<void>;
  /** null for a path outside /api/work */
  handle(req: Request, url: URL, caller: Caller | null): Promise<Response | null>;
}
```

Behaviour:
- Every change goes `set(item)`: `updatedAt` is `now()`, the state is `stateOf(item, deps.facts(item))`, the item is kept, written through one serial queue when `keeping` (as `PrHub.queue`), and `{ type: "work", items }` is broadcast.
- `mint`: `{ id, title, repos, state: "open", from, runs: [], branches: [], prs: [], events: [], notes: [], createdAt: at, updatedAt: at }`.
- `note`: `addNote(item.notes, { at: now(), by: by ?? "canopy", text })`; a text empty after trimming changes nothing. An unknown id logs `work: no item <id> for the line "<text>"` and returns.
- `close`: `state`, `closedAt: now()`, `reason: text` when `dropped` (removed when `landed`), then the line as a note.
- `onRun`: `id = run.branch?.work`; no item, nothing; else `run.id` joins `runs` and `run.branch.origin` joins `branches`, each once, and the item is set (which derives the state) even when the lists did not change.
- `recheck`: every item without `closedAt` is set again; one whose derived state is unchanged is not written.
- Routes, JSON like `landing.ts`'s `json` helper:
  - `GET /api/work[?repo=&state=]` answers `info(repo, state)`; a `state` not in `WORK_STATES` is 400 `state must be one of open, working, review, landed, dropped`.
  - `GET /api/work/one?id=` answers the item; 400 `id is required`; 404 `no work item by that id`.
  - `POST /api/work/note {id, text}`: 400 `id and text are required`; 404 as above; `by` is `caller?.label || "eric"`; answers the item.
  - `POST /api/work/close {id, state, reason?}`: 400 `state must be landed or dropped`; 404; 409 `a run on it is still going` when `facts(item).active`; the line is `closed by hand as <state>` with `: <reason>` when one is given, `by` as for a note; answers the item.
  - any other path under `/api/work` is 404 `{ error: "not found" }`.

Rights in `src/core/callers.ts`, written out so the test pins them:

```ts
// a note or a close on a work item is an operator's; its reads are the default
{ methods: POST, paths: ["work/*"], right: "operate" },
```

- [ ] **Step 1: Write the failing rights test in `src/core/callers.test.ts`**

```ts
describe("the work ledger's routes", () => {
  test("reads are read, a note or a close operate", () => {
    expect(needs("GET", "/api/work")).toBe("read");
    expect(needs("GET", "/api/work/one")).toBe("read");
    expect(needs("POST", "/api/work/note")).toBe("operate");
    expect(needs("POST", "/api/work/close")).toBe("operate");
    expect(allows("shell", needs("POST", "/api/work/note"))).toBe(true);
    expect(allows("coordinator", needs("POST", "/api/work/close"))).toBe(false);
  });
});
```

- [ ] **Step 2: Write the failing hub tests in `src/server/work.test.ts`**

```ts
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Run, ServerEvent } from "../core/types";
import { NOTE_CHARS, NOTES_MAX, type WorkFacts, type WorkItem } from "../core/work";
import type { Caller } from "./callers";
import { WorkHub } from "./work";

let root = "";
let n = 0;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "canopy-workhub-"));
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

const IDS = ["w-testaaaa", "w-testbbbb", "w-testcccc"];
const page: Caller = { id: "p1", kind: "page", label: "page mac", created: 0, used: 0 };

function hub(dir = join(root, `w${++n}`)) {
  const events: ServerEvent[] = [];
  const facts = new Map<string, WorkFacts>();
  let ids = 0;
  let clock = 1000;
  const h = new WorkHub({
    broadcast: (ev) => events.push(ev),
    facts: (item) => facts.get(item.id) ?? { active: false, branches: [] },
    dir,
    now: () => ++clock,
    mintId: () => IDS[ids++]!,
  });
  const call = (method: string, path: string, body?: unknown, caller: Caller | null = page) =>
    h.handle(new Request(`http://x${path}`, { method, ...(body ? { body: JSON.stringify(body), headers: { "content-type": "application/json" } } : {}) }), new URL(`http://x${path}`), caller);
  return { h, events, facts, dir, call };
}

const run = (id: string, work: string, origin: string, status: Run["status"] = "working"): Run =>
  ({ id, repoId: "r", status, branch: { name: `run/${work}-x`, target: "main", base: "b", dir: "/w", state: status === "working" ? "working" : "ready", origin, work } }) as unknown as Run;

describe("the ledger", () => {
  test("mint keeps an open item, writes it, and the work event carries the list", async () => {
    const { h, events, dir } = hub();
    await h.adopt();
    const item = h.mint({ title: "Add a test", from: { kind: "note" }, repos: ["r"] });
    expect(item).toMatchObject({ id: "w-testaaaa", title: "Add a test", repos: ["r"], state: "open", from: { kind: "note" }, runs: [], branches: [], prs: [], events: [], notes: [] });
    expect(item.createdAt).toBe(item.updatedAt);
    await h.idle();
    expect(JSON.parse(await readFile(join(dir, "w-testaaaa.json"), "utf8"))).toEqual(item);
    expect(events.at(-1)).toEqual({ type: "work", items: [item] });
    expect(h.info()).toEqual({ items: [item], archived: 0 });
  });

  test("the sink's lines: by canopy, cut, folded past NOTES_MAX; an unknown id is dropped, never minted", async () => {
    const { h } = hub();
    await h.adopt();
    const { id } = h.mint({ title: "t", from: { kind: "note" }, repos: ["r"] });
    h.note(id, `  ${"x".repeat(700)}  `);
    expect(h.get(id)?.notes).toEqual([{ at: expect.any(Number), by: "canopy", text: "x".repeat(NOTE_CHARS) }]);
    for (let i = 0; i < NOTES_MAX; i++) h.note(id, `n${i}`);
    expect(h.get(id)?.notes).toHaveLength(NOTES_MAX);
    expect(h.get(id)?.notes[0]?.text.startsWith("earlier: ")).toBe(true);
    h.note(id, "   ");
    expect(h.get(id)?.notes).toHaveLength(NOTES_MAX);
    h.note("w-nope2345", "lost");
    h.link("w-nope2345", { event: "e1" });
    h.close("w-nope2345", "dropped", "gone");
    expect(h.info().items.map((i) => i.id)).toEqual([id]);
  });

  test("a run on the item's branch is written on it, and the state follows the facts", async () => {
    const { h, facts } = hub();
    await h.adopt();
    const { id } = h.mint({ title: "t", from: { kind: "note" }, repos: ["r"] });
    facts.set(id, { active: true, branches: [{ state: "working" }] });
    h.onRun(run("r1", id, "b1"));
    h.onRun(run("r1", id, "b1"));
    h.onRun(run("r9", "w-nope2345", "b9"));
    expect(h.get(id)).toMatchObject({ runs: ["r1"], branches: ["b1"], state: "working" });
    facts.set(id, { active: false, branches: [{ state: "ready", land: "queued" }] });
    h.recheck();
    expect(h.get(id)?.state).toBe("review");
    h.onRun(run("fix1", id, "b1", "done"));
    expect(h.get(id)?.runs).toEqual(["r1", "fix1"]);
    h.close(id, "landed", "landed on main");
    expect(h.get(id)).toMatchObject({ state: "landed", closedAt: expect.any(Number) });
    expect(h.get(id)?.reason).toBeUndefined();
    expect(h.get(id)?.notes.at(-1)?.text).toBe("landed on main");
    facts.set(id, { active: false, branches: [] });
    h.recheck();
    expect(h.get(id)?.state).toBe("landed");
  });

  test("link keeps each PR and event once", async () => {
    const { h } = hub();
    await h.adopt();
    const { id } = h.mint({ title: "t", from: { kind: "note" }, repos: ["r"] });
    h.link(id, { pr: { number: 7, url: "https://github.com/o/r/pull/7" } });
    h.link(id, { pr: { number: 7, url: "https://github.com/o/r/pull/7" } });
    h.link(id, { event: "e1" });
    h.link(id, { event: "e1" });
    expect(h.get(id)).toMatchObject({ prs: [{ number: 7, url: "https://github.com/o/r/pull/7" }], events: ["e1"] });
  });

  test("adopt reads the items the last server left, and writes what was minted before the lock", async () => {
    const first = hub();
    const early = first.h.mint({ title: "before the lock", from: { kind: "note" }, repos: ["r"] });
    await first.h.adopt();
    await first.h.idle();
    const again = hub(first.dir);
    await again.h.adopt();
    expect(again.h.get(early.id)?.title).toBe("before the lock");
  });
});

describe("the routes", () => {
  test("list and one with their filters; a note carries the caller's label; close by hand", async () => {
    const { h, facts, call } = hub();
    await h.adopt();
    const a = h.mint({ title: "A", from: { kind: "note" }, repos: ["r1"] });
    const b = h.mint({ title: "B", from: { kind: "trigger", event: "e1" }, repos: ["r2"] });
    const list = (await (await call("GET", "/api/work"))!.json()) as { items: WorkItem[]; archived: number };
    expect(list.items.map((i) => i.id)).toEqual([b.id, a.id]);
    expect(((await (await call("GET", "/api/work?repo=r1"))!.json()) as { items: WorkItem[] }).items.map((i) => i.id)).toEqual([a.id]);
    expect(((await (await call("GET", "/api/work?state=open"))!.json()) as { items: WorkItem[] }).items).toHaveLength(2);
    expect((await call("GET", "/api/work?state=nope"))!.status).toBe(400);
    expect(((await (await call("GET", `/api/work/one?id=${a.id}`))!.json()) as WorkItem).title).toBe("A");
    expect((await call("GET", "/api/work/one?id=w-nope2345"))!.status).toBe(404);
    expect((await call("GET", "/api/work/one"))!.status).toBe(400);
    const noted = (await call("POST", "/api/work/note", { id: a.id, text: "try the other branch first" }))!;
    expect(noted.status).toBe(200);
    expect(h.get(a.id)?.notes).toEqual([{ at: expect.any(Number), by: "page mac", text: "try the other branch first" }]);
    await call("POST", "/api/work/note", { id: a.id, text: "from nobody" }, null);
    expect(h.get(a.id)?.notes.at(-1)?.by).toBe("eric");
    expect((await call("POST", "/api/work/note", { id: a.id }))!.status).toBe(400);
    facts.set(a.id, { active: true, branches: [{ state: "working" }] });
    expect((await call("POST", "/api/work/close", { id: a.id, state: "dropped", reason: "not worth it" }))!.status).toBe(409);
    facts.set(a.id, { active: false, branches: [] });
    expect((await call("POST", "/api/work/close", { id: a.id, state: "nope" }))!.status).toBe(400);
    const closed = (await call("POST", "/api/work/close", { id: a.id, state: "dropped", reason: "not worth it" }))!;
    expect(closed.status).toBe(200);
    expect(h.get(a.id)).toMatchObject({ state: "dropped", reason: "not worth it" });
    expect(h.get(a.id)?.notes.at(-1)).toMatchObject({ by: "page mac", text: "closed by hand as dropped: not worth it" });
    expect(await call("GET", "/api/other")).toBeNull();
    expect((await call("GET", "/api/work/nope"))!.status).toBe(404);
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `bun test src/core/callers.test.ts src/server/work.test.ts`
Expected: FAIL on the rights test and the module not found.

- [ ] **Step 4: Add the rule and write `src/server/work.ts`**

Header: "The work ledger's server half (FR-037): the items, minted at branch start, the lines the other hubs write on them, the derived state, the routes and the `work` event. The model is `core/work.ts`; the files are `core/workstore.ts`. Only the server holding the flows lock writes them (`adopt`), as with the landing records."

- [ ] **Step 5: Run the tests to verify they pass**

Run: `bun test src/core/callers.test.ts src/server/work.test.ts && bun run typecheck && bun run lint`
Expected: PASS, clean.

- [ ] **Step 6: Commit**

```bash
git add src/server/work.ts src/server/work.test.ts src/core/callers.ts src/core/callers.test.ts
git commit -m "feat(work): the work hub, its lines, derived states, routes and rights"
```

---

### Task 5: the landing queue writes its lines

**Files:**
- Modify: `src/server/landing.ts:54-81` (`LandingDeps`), `:297` (adopt's stopped record), `:397-419` (`settled`), `:423-439` (`rejoin`), `:443-491` (`onRun`, the record at `:451`), `:591-612` (`land`), `:617-641` (`landAll`), `:646-657` (`fix`), `:662-676` (`drop`), `:791-875` (`turn`); `src/server/landing.test.ts:26-116` (`World`, `world`), `:118-128` (`readyRun`), `:133-145` (`rehub`)

**Interfaces:**
- Consumes: `WorkSink` from Task 1; `reviewWord`, `landWord` from `core/landing.ts`.
- Produces: `LandingDeps.work?: WorkSink` with the comment "the work ledger: one line per move of a branch that has an item (FR-037)". Two private helpers:

```ts
/** a line on the item of a record, when it has one */
private tell(id: string, text: string): void;   // this.deps.work?.note(this.runs.get(id)?.work, text)
private end(id: string, state: "landed" | "dropped", text: string): void;
```

The lines, each exact:
- `onRun`, the new record: `...(b.work ? { work: b.work } : {})`.
- `adopt`, a working record read as stopped: `cut off by a restart`.
- `settled`, after `resort` gives a review: `branch ready, <reviewWord(review)>`; for a record with `openPr`, before `openPr` is called: `branch ready, opening a PR`.
- `rejoin`, after `resort` gives a review: `fix ready, <reviewWord(review)>`.
- the `enqueue` calls: `land` and `landAll` `queued to land`; `settled`'s auto join `joined the queue on its own`; `rejoin` `back in the queue`.
- `turn`: conflict `sent back: conflict in <n> file` or `files`; red `sent back: <gate> failed`; `moved` when the entry's state is `moved` after the step, `sent back: main kept moving`; landed `end(e.id, "landed", "landed on <target>")` before `dropRun`.
- `fix`: `fix started: <landWord(entry, this.entries)>`.
- `drop`: `end(target.id, "dropped", "dropped with its worktree")` before `dropRun`.

Holds and waits write nothing: the retry timer would repeat them every 30 s.

- [ ] **Step 1: Extend the test world in `src/server/landing.test.ts`**

In `World`: `notes: string[]`, `closes: string[]`. In `world()`, start both empty and give the hub `work: { note: (id, t) => w.notes.push(`${id} ${t}`), close: (id, s, t) => w.closes.push(`${id} ${s} ${t}`), link: () => {} }`; `rehub` gets the same object, pushing into the same `w`. `fakeRun`'s `b` parameter and `readyRun` gain `work?: string`, which lands on the branch as `work`.

- [ ] **Step 2: Write the failing tests**

In a new `describe("the work ledger (FR-037)")`:

```ts
test("the record carries the branch's item, and the queue writes its lines on it", async () => {
  const w = await world();
  await readyRun(w, "wk1", "b.txt", "b\n", "w-test2345");
  await w.hub.idle();
  expect(w.hub.record("wk1")?.work).toBe("w-test2345");
  expect(w.notes).toHaveLength(1);
  expect(w.notes[0]).toMatch(/^w-test2345 branch ready, /);
  await w.hub.land("wk1");
  await w.hub.idle();
  expect(w.notes.slice(1)).toEqual(["w-test2345 queued to land"]);
  expect(w.closes).toEqual(["w-test2345 landed landed on main"]);
});

test("sent back, fix it and a drop each write a line; a record without an item writes none", async () => {
  const w = await world();
  await readyRun(w, "wk2", "a.txt", "two\n");
  await readyRun(w, "wk3", "a.txt", "three\n", "w-fix23456");
  await w.hub.idle();
  await w.hub.land("wk2");
  await w.hub.idle();
  await w.hub.land("wk3");
  await w.hub.idle();
  expect(entryOf(w, "wk3")?.state).toBe("conflict");
  expect(w.notes).toEqual([expect.stringMatching(/^w-fix23456 branch ready, /), "w-fix23456 queued to land", "w-fix23456 sent back: conflict in 1 file"]);
  expect(w.closes).toEqual([]);
  await w.hub.fix("wk3");
  expect(w.notes.at(-1)).toBe("w-fix23456 fix started: conflict");
  await w.hub.drop("wk3");
  expect(w.closes).toEqual(["w-fix23456 dropped dropped with its worktree"]);
});

test("a working record read after a restart says it was cut off", async () => {
  const w = await world();
  await w.hub.adopt();
  w.hub.onRun(fakeRun(w.repo.id, { name: "run/w-test2345-x", target: "main", base: "b", dir: join(w.wts, "x"), origin: "wk4", work: "w-test2345" }, "working"));
  await w.hub.flushed();
  const again = rehub(w);
  await again.adopt();
  expect(again.record("wk4")?.state).toBe("stopped");
  expect(w.notes).toEqual(["w-test2345 cut off by a restart"]);
});
```

The second test follows the shape of "two runs on the same line" at `:207`: two runs writing `a.txt` conflict once the first lands.

- [ ] **Step 3: Run the tests to verify they fail**

Run: `bun test src/server/landing.test.ts -t "FR-037"`
Expected: FAIL (`work` is not a known dep; the record has no `work`).

- [ ] **Step 4: Implement the dep, the record's field and the lines**

- [ ] **Step 5: Run the tests to verify they pass**

Run: `bun test src/server/landing.test.ts src/server/landing-run.test.ts && bun run typecheck`
Expected: PASS; typecheck clean (the dep is optional, so `index.ts` compiles before Task 8).

- [ ] **Step 6: Commit**

```bash
git add src/server/landing.ts src/server/landing.test.ts
git commit -m "feat(work): the landing queue carries the item on its record and writes a line per move"
```

---

### Task 6: the PR watch writes its lines

**Files:**
- Modify: `src/server/prs.ts:145-174` (`PrDeps`), `:359-412` (`open`), `:641` (the closed line in `poll`), `:688-700` (`startFix`), `:820-835` (`merged`); `src/server/prs.test.ts:99-176` (`world`)

**Interfaces:**
- Consumes: `WorkSink`; `prBody` from Task 2; `MAX_ATTEMPTS` from `core/pr.ts`.
- Produces: `PrDeps.work?: WorkSink` with the same comment as the landing hub's. The lines:
  - `open`: the watch gets `...(rec.work ? { work: rec.work } : {})`; `prBody(rec.note, subjects, rec.work)`; after `save`, `link(work, { pr: { number, url } })` then `PR #<number> opened`.
  - `startFix`: `fix <n> of <MAX_ATTEMPTS> for <what>` where `what` is `check <name>` for a `check:` key and `a review comment` otherwise, written when the fix run started.
  - `poll`, right after the `whoClosed` line, when `had.state?.status !== "closed"` and `w.state?.status === "closed"`: `PR #<number> closed`.
  - `merged`: `close(work, "landed", "PR #<number> merged")` before `forget`.

- [ ] **Step 1: Extend the test world in `src/server/prs.test.ts`**

`world(opts: { repoDefault?: string; work?: string })`: with `work`, the record is `{ ...rec, work }`. `World` gains `notes: string[]`, `closes: string[]`, `links: [string, unknown][]`, and `make()` passes `work: { note: (id, t) => w.notes.push(`${id} ${t}`), close: (id, s, t) => w.closes.push(`${id} ${s} ${t}`), link: (id, ref) => w.links.push([id, ref]) }`.

- [ ] **Step 2: Write the failing tests**

```ts
describe("the work ledger (FR-037)", () => {
  test("open links and notes the PR with the trailer in its body; a fix counts its try; a merge closes the item as landed", async () => {
    const w = await world({ work: "w-test2345" });
    const pr = await w.hub.open(w.rec.id);
    expect(pr.work).toBe("w-test2345");
    const create = w.gh.calls.find((c) => c[0] === "pr" && c[1] === "create")!;
    expect(create.at(-1)?.endsWith("\n\nCanopy-Work: w-test2345")).toBe(true);
    expect(w.links).toEqual([["w-test2345", { pr: { number: 7, url: "https://github.com/o/r/pull/7" } }]]);
    expect(w.notes).toEqual(["w-test2345 PR #7 opened"]);
    await w.hub.set(w.rec.id, { autoFix: true });
    w.gh.head = await revOf(w.dir, "HEAD");
    w.gh.checks = [checkRun("test", "COMPLETED", "FAILURE")];
    await pollNow(w);
    expect(w.notes.at(-1)).toBe("w-test2345 fix 1 of 3 for check test");
    await endFix(w, "fix1", "c.txt");
    w.gh.state = "MERGED";
    await pollNow(w);
    expect(w.closes).toEqual(["w-test2345 landed PR #7 merged"]);
  });

  test("a watch from before the ledger writes nothing", async () => {
    const w = await world();
    await w.hub.open(w.rec.id);
    expect([w.notes, w.links, w.closes]).toEqual([[], [], []]);
    const body = w.gh.calls.find((c) => c[1] === "create")!.at(-1)!;
    expect(body).not.toContain("Canopy-Work");
  });
});
```

The auto-fix steps are the ones "a failed check starts one fix run" at `:310` makes; `endFix` and `pollNow` are the file's helpers.

- [ ] **Step 3: Run the tests to verify they fail**

Run: `bun test src/server/prs.test.ts -t "FR-037"`
Expected: FAIL (`work` is not a known dep).

- [ ] **Step 4: Implement the dep, the watch's field, the body's last line and the lines**

- [ ] **Step 5: Run the tests to verify they pass**

Run: `bun test src/server/prs.test.ts && bun run typecheck`
Expected: PASS, clean.

- [ ] **Step 6: Commit**

```bash
git add src/server/prs.ts src/server/prs.test.ts
git commit -m "feat(work): the PR watch links the PR to its item, ends the body with the trailer and writes a line per move"
```

---

### Task 7: the triggers and the coordinator

**Files:**
- Modify: `src/server/triggers.ts:85-132` (`TriggerDeps`), `:277` (`set`), `:373-396` (`begin`); `src/server/triggers.test.ts:30-62` (`run`, `hub`); `src/server/coordinator.ts:33-40` (`CoordinatorDeps`), `:250` (the card goes `running`), `:298-301` (`settle`); `src/server/coordinator.test.ts:42` (`branch`), `:47-82` (`hub`)

**Interfaces:**
- Consumes: `WorkSink`.
- Produces: `TriggerDeps.work?: WorkSink` and `CoordinatorDeps.work?: WorkSink`, the same comment as the landing hub's.
  - `begin`: the event gets `work` from `out.run.branch?.work` or `out.flow.branch?.work` when set, and `link(work, { event: event.id })` is called once the event is set.
  - `set(e)`: with the event before it as `prev`, when `e.work` is set, `e.status !== prev?.status` and `e.status` is `no-fix`, `failed` or `stopped`: `trigger event <e.short ?? e.key> <e.status>` with `: <e.reason>` when there is one. Merged, closed and review are the PR watch's lines.
  - the coordinator, when a card goes `running`: `work: child.branch?.work` on the card (left out when the child has none); `settle`, once `got` is known: `card <task.id> settled: <got.outcome>` on `task.work`.

- [ ] **Step 1: Write the failing trigger test**

Give the `run` helper's branch (`triggers.test.ts:30`) `work: "w-test2345"`. Then, in a new describe:

```ts
describe("the work ledger (FR-037)", () => {
  test("an event carries its branch's item, links it, and notes an end the other hubs do not", async () => {
    const notes: string[] = [];
    const links: [string, unknown][] = [];
    const h = hub({ work: { note: (id, t) => notes.push(`${id} ${t}`), close: () => {}, link: (id, ref) => links.push([id, ref]) } });
    await h.adopt();
    await h.handle(hookReq(issueBody()), new URL("http://x/api/hooks/sentry/shop"));
    const [e] = h.list();
    expect(e?.work).toBe("w-test2345");
    expect(links).toEqual([["w-test2345", { event: e!.id }]]);
    h.onRun({ ...runs[0]!, status: "done", branch: { ...runs[0]!.branch!, state: "nothing" } });
    await h.idle();
    expect(notes).toEqual(["w-test2345 trigger event SHOP-1A no-fix: the agent committed nothing: it found no fix to make"]);
  });
});
```

- [ ] **Step 2: Write the failing coordinator test**

Give the `branch` helper (`coordinator.test.ts:42`) `work: "w-test2345"`. Then, beside "a ready child waits for the landing queue's word" at `:349`, copying its steps up to the landed entry:

```ts
test("a card carries its child's item and notes how it settled", async () => {
  const notes: string[] = [];
  coordinator({ status: "idle" });
  const h = hub({ work: { note: (id, t) => notes.push(`${id} ${t}`), close: () => {}, link: () => {} } });
  await post(h, "plan", { run: "co1", tasks: [task()] });
  await post(h, "start", { run: "co1" });
  expect(card("t1")?.work).toBe("w-test2345");
  branches.set("c1", { verdict: "auto" });
  end(h, "t1", { result: "Fixed it." });
  await settled(h);
  branches.set("c1", { verdict: "auto", entry: entry("t1", "landed"), entries: [entry("t1", "landed")] });
  h.recheck();
  await settled(h);
  expect(card("t1")).toMatchObject({ state: "done", outcome: "landed", work: "w-test2345" });
  expect(notes).toEqual(["w-test2345 card t1 settled: landed"]);
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `bun test src/server/triggers.test.ts src/server/coordinator.test.ts -t "FR-037|carries its child"`
Expected: FAIL on the two new tests only.

- [ ] **Step 4: Implement both deps and their lines**

- [ ] **Step 5: Run the tests to verify they pass**

Run: `bun test src/server/triggers.test.ts src/server/coordinator.test.ts src/core/trigger.test.ts src/core/coordinator.test.ts && bun run typecheck`
Expected: PASS, clean.

- [ ] **Step 6: Commit**

```bash
git add src/server/triggers.ts src/server/triggers.test.ts src/server/coordinator.ts src/server/coordinator.test.ts
git commit -m "feat(work): trigger events and coordinator cards carry their item and write their lines"
```

---

### Task 8: minted at branch start, wired into the server

**Files:**
- Modify: `src/core/issue.ts:121-129` (`resolveIssueNote`), `src/core/issue.test.ts:121-132`; `src/server/index.ts:222` (the worktree import), `:332-343` (`ServerState`), `:1070` (the branch start in `startRepoRun`), `:1078-1085` (`issueNoteFor`), `:1087-1101` (`startBranchRun`), `:1183-1218` (`cutBranch`, the name at `:1193`, the branch at `:1216`), `:1232-1250` (`startBranchFix`, `b` at `:1237`), `:1301-1310` (`startTriggerRun`), `:1338` (`startCoordChild`), `:3114-3115` (the handle chain, after the coordinator), `:4742-4745` (the runner's `onChange`), `:5162-5176` (the landing hub's deps), `:5192-5205` (the PR hub's), `:5251` (the trigger hub's), `:5283` (the coordinator's), `:5791-5795` (adopt), `:5981-5983` (detach); `src/server/landing-run.test.ts:92-118`

**Interfaces:**
- Consumes: `WorkHub` from Task 4; `titleOf`, `workBranchName`, `WorkSink`, `WorkStart` from Task 1; `isRunActive` from `core/types.ts`.
- Produces in `src/core/issue.ts`:

```ts
/** the issue a note was swapped for, when one was */
export interface IssueFrom { number: number; title: string; url: string; slug: string }
export async function resolveIssueNote(note: string, deps: { slug: () => Promise<string | null>; gh: GhRun }): Promise<{ note: string; issue?: IssueFrom } | { error: string }>;
```

`issue` is set only when an issue was read, so the no-ref answers stay `{ note }`.

- Produces in `src/server/index.ts`:

```ts
/** the branch runs' ledger: an item per branch and the lines on it (server/work) */
work: WorkHub;   // on ServerState, after coordinator
async function issueNoteFor(repo: Repo, note: string): Promise<{ note: string; work?: WorkStart }>;
async function startBranchRun(state, repo, action, note, agent, by, pr = false, spec = ACTIONS[action], extras: StartExtras = {}, work: WorkStart = { title: titleOf(note), from: { kind: "note" } }): Promise<Run>;
async function cutBranch(repo: Repo, note: string, pr: boolean, work: string): Promise<BranchStart>;
```

Behaviour:
- `issueNoteFor` returns `{ note, work: { title: issue.title, from: { kind: "issue", service: "github", key: `${issue.slug}#${issue.number}`, link: issue.url } } }` when the note came from an issue; `startRepoRun` passes it as the last argument.
- `startBranchRun`: `const item = state.work.mint({ ...work, repos: [repo.id] })` first; then `cutBranch(repo, note, pr, item.id)` and the runner's start inside one `try`; on any throw, `state.work.close(item.id, "dropped", `the run did not start: ${message}`)` before the existing handling, and the throw carries as today.
- `cutBranch`: `const name = workBranchName(work, note)`; the branch gets `work`; `id` stays the branch's own id for the worktree folder and `origin`.
- `startBranchFix`: `b` gets `...(rec.work ? { work: rec.work } : {})`, so a fix on a ledger-era record asks for the trailer and one on an older record does not.
- `startTriggerRun`: the run path passes `{ title: event.title, from: { kind: "trigger", event: event.id } }`; the flow path mints the same way, cuts with the id, and on a throw closes the item as above.
- `startCoordChild` passes `{ title: task.title, from: { kind: "coordinator", run: coordId, card: task.id } }`.
- The hub: `work: new WorkHub({ broadcast: (ev) => broadcast(state, ev), facts: (item) => ({ active: item.runs.some((id) => { const r = state.runner.get(id); return r !== undefined && isRunActive(r); }), branches: item.branches.flatMap((id) => { const rec = state.landing.record(id); if (!rec) return []; const entry = state.landing.info().entries.find((e) => e.id === id); const pr = state.prs.info().find((w) => w.id === id); return [{ state: rec.state, ...(entry ? { land: entry.state } : {}), ...(pr?.state ? { pr: pr.state.status } : {}) }]; }) }) })`, built after the coordinator.
- The sink the four hubs get as `work`: three closures over `state.work` (`note`, `close`, `link`), late-bound like the other deps, so `state` is read when a line is written and not when the literal is built.
- The landing hub's `broadcast` adds `if (ev.type === "landing") state.work.recheck();` beside the coordinator's recheck; the PR hub's adds the same for `prs`.
- `onChange`: `state.work.onRun(run)` after `state.coordinator.onRun(run)`.
- The handle chain: `const workRes = await state.work.handle(req, url, caller); if (workRes) return workRes;` after the coordinator's line.
- adopt: `await state.work.adopt()` before `state.landing.adopt()`, so the landing hub's restart lines find their items; detach: `state.work.detach()` after `state.triggers.detach()`.
- The comment at `:1088` names the new branch form.

- [ ] **Step 1: Write the failing issue test**

In `src/core/issue.test.ts`'s `resolveIssueNote` describe, in the first test:

```ts
expect("issue" in got && got.issue).toEqual({ number: 12, title: "Login redirect loops", url: "https://github.com/o/r/issues/12", slug: "o/r" });
```

using the `url` the file's `fakeGh` fixture answers for issue 12 (read it; adjust the string to the fixture, not the fixture to the string).

- [ ] **Step 2: Write the failing API test in `src/server/landing-run.test.ts`**

After the first test in "branch runs over the API", following its calls:

```ts
test("a branch run is named after its work item, which is written at start and asked for as a trailer", async () => {
  const start = await call("/api/repos/run?id=proj", { action: "ask", note: "add a file", branch: true });
  const run = (await start.json()) as Run;
  expect(run.branch?.work).toMatch(/^w-[a-z2-7]{8}$/);
  expect(run.branch?.name).toBe(`run/${run.branch?.work}-add-a-file`);
  const file = join(scratch, "config", "work", `${run.branch!.work}.json`);
  await until(async () => (existsSync(file) ? true : null), "the item to be written");
  const item = JSON.parse(await readFile(file, "utf8")) as { title: string; state: string; from: unknown; repos: string[]; runs: string[]; branches: string[] };
  expect(item).toMatchObject({ title: "add a file", from: { kind: "note" }, repos: ["proj"], runs: [run.id], branches: [run.branch!.origin] });
  await until(async () => ((await runOf(run.id))?.branch?.state === "ready" ? true : null), "the run to settle ready");
  expect(prompts.at(-1)?.message).toContain(`"Canopy-Work: ${run.branch!.work}"`);
  const got = await (await fetch(`${base}/api/work/one?id=${run.branch!.work}`, { headers })).json() as { state: string; notes: { by: string; text: string }[] };
  expect(got.state).toBe("review");
  expect(got.notes[0]).toMatchObject({ by: "canopy" });
  expect(got.notes[0]?.text.startsWith("branch ready, ")).toBe(true);
});
```

`base`, `headers`, `call`, `runOf`, `prompts`, `scratch` and `until` are the file's own; read its first test and use the names it has for the server's address and token headers (the `call` helper shows them). Import `readFile` beside the file's `node:fs/promises` imports.

- [ ] **Step 3: Run the tests to verify they fail**

Run: `bun test src/core/issue.test.ts src/server/landing-run.test.ts -t "resolveIssueNote|named after its work item"`
Expected: FAIL (no `issue` on the answer; the branch has no `work`).

- [ ] **Step 4: Implement the wiring**

- [ ] **Step 5: Run the tests, then every gate**

Run: `bun test src/core/issue.test.ts src/server/landing-run.test.ts src/server/start.test.ts && bun run typecheck && bun run lint && bun test && bun run build`
Expected: PASS, clean, built. A test elsewhere that pins the old `run/<slug>-<id>` form (`grep -rn "run/add-a-file-\|run/plan-a-thing-" src`) is updated to the new one in this step; `landing-run.test.ts:96` and `:122` are two.

- [ ] **Step 6: Commit**

```bash
git add src/core/issue.ts src/core/issue.test.ts src/server/index.ts src/server/landing-run.test.ts
git commit -m "feat(work): every branch run mints a work item and is named after it; the hub is wired, adopted and routed"
```

---

### Task 9: `canopy work`

**Files:**
- Create: `src/cli/work.ts`, `src/cli/work.test.ts`
- Modify: `src/cli/index.ts:100-116` (`COMMANDS`), `:855-860` (a `case "work"` beside `land`); `src/core/help.ts:86-89` (after the `canopy prs` line); `README.md:86` (after the `canopy prs` line)

**Interfaces:**
- Consumes: `ask`, `errText`, `has`, `take`, `targetsOf`, `Unreachable`, `Target` from `./health` as `src/cli/pr.ts` does; `currentBranch` from `core/worktree.ts`; `fromWord`, `isWorkId`, `WORK_STATES`, `workIdOf`, `WorkItem`, `WorkInfo` from `core/work.ts`.
- Produces in `src/cli/work.ts`:

```ts
export const WORK_USAGE =
  'usage: canopy work [list] [--repo R] [--state S] [--backend URL]\n       canopy work show <id> [--backend URL]\n       canopy work note [<id>] "<text>" [--backend URL]\n       canopy work close <id> --landed | --dropped [-m why] [--backend URL]';
/** one line per item: the id, its state, its repos, its title and the newest line; `backend` as a heading line when given */
export function listLines(items: readonly WorkItem[], backend = ""): string[];
/** the item in full: the title line, the facts line, the links line, then every note dated */
export function showLines(item: WorkItem): string[];
export async function workCommand(argv: string[], { fail }: { fail: (msg: string) => never }): Promise<void>;
```

`listLines` for one item: `<id>  <state padded to 8> <repos joined by "," padded to 18> <title>` and, with a note, `  · <by>: <text>`. `showLines`:

```
<id>  <title>
state: <state>   repos: <repos joined by ", ">   from: <fromWord>
branches: <ids or none>   runs: <ids or none>   PRs: <#n url or none>   events: <ids or none>
notes:
  <YYYY-MM-DD HH:MM>  <by>  <text>
```

with `none` for an empty list, the date `new Date(at).toISOString().slice(0, 16).replace("T", " ")`, and `  (none yet)` under `notes:` when there are none. `workCommand`: `list` (or no word) asks every backend the home one lists for `GET /api/work` with the `repo` and `state` query, as `canopy prs` does, and prints `listLines` per backend, `no work items` when none answered with any; `show`, `note` and `close` go to home (or `--backend`). `note` with no id, or a first word that is not an id, reads `workIdOf(await currentBranch(process.cwd()))` and fails with `no work id given, and this folder is not on a run/w-… branch` when that is null. `close` needs exactly one of `--landed` and `--dropped` (`fail(WORK_USAGE)` otherwise) and sends `-m` as `reason`; it prints `<id> closed as <state>`. `note` prints `noted on <id>`.

The README gets, after the `canopy prs` line:

```
canopy work [--repo R] [--state S]  # every work item: id, state, repos, title and its newest line; one item per branch run, kept under <configDir>/work/
canopy work show <id>              # the item in full: what served it and every line on it
canopy work note [<id>] "<text>"   # a line on an item; inside a run's worktree the id is read off the branch
canopy work close <id> --landed | --dropped [-m why]   # end an item by hand; refused while a run on it is going
```

and `src/core/help.ts` the same four in its column form.

- [ ] **Step 1: Write the failing tests in `src/cli/work.test.ts`**

```ts
import { expect, test } from "bun:test";
import type { WorkItem } from "../core/work";
import { listLines, showLines } from "./work";

const item = (over: Partial<WorkItem> = {}): WorkItem => ({
  id: "w-test2345",
  title: "Add a test",
  repos: ["dev-tools/canopy"],
  state: "review",
  from: { kind: "note" },
  runs: ["r1", "fix1"],
  branches: ["b1"],
  prs: [{ number: 7, url: "https://github.com/o/r/pull/7" }],
  events: [],
  notes: [
    { at: Date.UTC(2026, 9, 26, 10, 0), by: "canopy", text: "branch ready, lands on its own" },
    { at: Date.UTC(2026, 9, 26, 10, 5), by: "canopy", text: "PR #7 opened" },
  ],
  createdAt: 1,
  updatedAt: 2,
  ...over,
});

test("listLines", () => {
  expect(listLines([item()])).toEqual(["w-test2345  review   dev-tools/canopy   Add a test  · canopy: PR #7 opened"]);
  expect(listLines([item({ notes: [], state: "open" })], "mini")).toEqual(["mini", "w-test2345  open     dev-tools/canopy   Add a test"]);
  expect(listLines([])).toEqual([]);
});

test("showLines", () => {
  expect(showLines(item())).toEqual([
    "w-test2345  Add a test",
    "state: review   repos: dev-tools/canopy   from: a note",
    "branches: b1   runs: r1, fix1   PRs: #7 https://github.com/o/r/pull/7   events: none",
    "notes:",
    "  2026-10-26 10:00  canopy  branch ready, lands on its own",
    "  2026-10-26 10:05  canopy  PR #7 opened",
  ]);
  expect(showLines(item({ notes: [], prs: [], runs: [], branches: [], from: { kind: "trigger", event: "e1" } })).slice(1)).toEqual([
    "state: review   repos: dev-tools/canopy   from: trigger event e1",
    "branches: none   runs: none   PRs: none   events: none",
    "notes:",
    "  (none yet)",
  ]);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test src/cli/work.test.ts`
Expected: FAIL, the module is not found.

- [ ] **Step 3: Write `src/cli/work.ts`, the `case`, the help lines and the README lines**

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test src/cli/ && bun run typecheck && bun run lint`
Expected: PASS, clean.

- [ ] **Step 5: Commit**

```bash
git add src/cli/work.ts src/cli/work.test.ts src/cli/index.ts src/core/help.ts README.md
git commit -m "feat(work): canopy work lists, shows, notes and closes work items"
```

---

### Task 10: the docs and the gates

**Files:**
- Modify: `docs/architecture.md:148` (the branch form in "The landing queue"), `:206` (a new section before "## The kit"), `SPEC.md:57`, `README.md` (the landing queue's feature paragraph), `FEATURES.md:50-53` and `:128`, `docs/superpowers/plans/README.md`

**Interfaces:**
- Consumes: the completed interfaces from Tasks 1 to 9, the source spec, and the live-check results.
- Produces: documentation and feature status that describe the implemented scope, with later phases still marked open. No new runtime interface.

- [ ] **Step 1: `docs/architecture.md`**

At line 148, `run/<slug>-<id>` becomes `run/<work id>-<slug>` with "(the work ledger, below)". Before `## The kit`, a new section `## The work ledger` of one or two paragraphs, starting "FR-037 (`docs/superpowers/specs/2026-10-25-work-ledger-design.md`, plan 1).", saying: an item per branch, `WorkItem` in `core/work.ts` (the id's form, `mintId`, the title, `from`, the lists, the notes with `NOTE_CHARS` and `NOTES_MAX` and the `earlier:` fold, `stateOf` and its order); where items live and that only the lock holder writes them through `server/work.ts` (`adopt`, `detach`, the serial queue, `workstore.ts`); that `startBranchRun` mints before `cutBranch`, the branch is `workBranchName`, the id rides on `RunBranch.work` to the landing record, the PR watch, the event and the card, and a start that fails closes the item `dropped`; the trailer asked for by `branchLine` and put last by `prBody`, with `trailerOf` for plan 3's rebuild; the `WorkSink` the four hubs hold and each line they write (the list from Tasks 5 to 7); the `facts` the server derives a state from and when `recheck` runs; the routes and their rights; the `work` event; the CLI; and that handoff into runs, the view, export, rebuild and compaction are plans 2 and 3.

- [ ] **Step 2: `SPEC.md`**

Line 57: after `prs/`, add `work/` ("`<id>.json` per work item: its title, state, the runs, branches, PRs and events that served it and the lines on it, written only by the server holding the flows lock; never synced between backends").

- [ ] **Step 3: `README.md`**

In the features list, in the landing queue's paragraph (find it with `grep -n "landing queue" README.md`), one sentence: every branch run gets a work item under the config dir, named in its branch and asked for as a `Canopy-Work:` trailer on its commits, on which the queue, the PR watch, the triggers and the coordinator write a line as they move it; `canopy work` reads and adds to it. The CLI lines were added in Task 9.

- [ ] **Step 4: `FEATURES.md` and the plans README**

Move the `### FR-037` block from `## Open` to the top of `## In Progress` and append to its Spec line: `Plan 1 shipped <date> (the ledger, items minted at branch start, the hubs' lines, the branch name and trailer, canopy work); plans 2 (handoff into runs, the work view, export) and 3 (rebuild from git, compaction) open.` In `docs/superpowers/plans/README.md`, set this plan's row to `shipped` with the date, and set this plan's Status line to shipped with the merge commit.

- [ ] **Step 5: Run every gate**

Run: `bun run typecheck && bun run lint && bun test && bun run build`
Expected: all pass. Then `~/.claude/skills/verify-build/clean-rebuild.sh verify "workIdOf"` proves the served bundle is the new one (the UI bundles `core/work.ts` through `types.ts`'s event import).

- [ ] **Step 6: Commit**

```bash
git add docs/architecture.md SPEC.md README.md FEATURES.md docs/superpowers/plans/README.md docs/superpowers/plans/2026-10-26-work-ledger-1.md
git commit -m "docs(work): architecture, SPEC, README and the feature list for plan 1"
```

---

## Live check, before the branch is called done

With a scratch canopy (the "Scratch canopy server for UI checks" memory note) pointed at a throwaway repo with a `main` and a `package.json` `test` script:

1. Start a branch run from the pre-flight with the note `add a file`. The run sheet names a branch `run/w-xxxxxxxx-add-a-file`; `~/.config/<scratch>/work/w-xxxxxxxx.json` exists before the agent's first message; the first message's last paragraph asks for `Canopy-Work: w-xxxxxxxx`.
2. `canopy work` lists the item as `working` with its title; once the run settles ready, `canopy work show w-xxxxxxxx` reads `review` with a `branch ready, …` line by canopy.
3. `canopy work note "look at the second commit first"` from inside the run's worktree (a canopy shell there) lands on the item with the shell token's label; the same from `~` fails with the "not on a run/w-… branch" line.
4. `git -C <worktree> log -1 --format=%B` shows the trailer the agent wrote; `canopy land <run>` lands it, `canopy work` reads `landed` and the item's last line is `landed on main`.
5. A second run, `canopy pr <run>`: the PR body on GitHub ends with `Canopy-Work: w-yyyyyyyy`; `canopy work show` lists `PRs: #n <url>` and `PR #n opened`.
6. `canopy work close w-yyyyyyyy --dropped -m "superseded"` while the run is still going is refused with `a run on it is still going`; after it ends, it closes and the line reads `closed by hand as dropped: superseded`.
7. Restart the scratch server mid-run: the item reads `cut off by a restart`; `canopy work` still lists it.

## Decisions this plan makes beyond the spec

- The branch name changes shape to `run/<id>-<slug>` (the spec's call 7 for Eric): taken as the spec's body gives it, since the id in the name is what makes an orphaned worktree, a rebuilt config dir or the other backend name its item. `runBranchName` goes and `workBranchName` replaces it; `branchSlug` moves to `core/work.ts` and `worktree.ts` re-exports it, so the model stays browser-safe.
- The id rides on `RunBranch.work`, and the spec's `Run.work` is read as `run.branch?.work`: a flow's step runs and every fix copy the branch (`branchOf` in `core/flow.ts`, `b` in `startBranchFix`), so the id travels without a runner parameter, and a checkout run, which has no branch, has no item.
- `LandingRun.work`, `PrWatch.work`, `TriggerEvent.work` and `CoordTask.work` are optional: records from before the ledger have none, and every hub writes nothing for them.
- The hubs reach the ledger through a `WorkSink` dep of three calls (`note`, `close`, `link`) rather than holding the hub, so their tests stand it in; `landed`, `merged` and `dropped` are `close` calls, since the record and its facts vanish with the branch and a derived state alone would read `open` after a land.
- Holds and waits write no line: the retry timer would repeat one every 30 s.
- The coordinator's goal is not an item and its cards are (call 8, the spec's v1); the coordinator writes one line per settled card.
- `WorkInfo.archived` is 0 until plan 3 writes the archive; the field is there so the route's shape does not change.
- `POST /api/work/*` needs `operate` for every operator; the run-bound token's "its own item only" rule waits for FR-038's tokens.
- The `by: agent` question (call 9) is plan 2's, with the handoff heading.
- `resolveIssueNote` says which issue it read, so an issue start's item is titled by the issue and `from: issue` without parsing the note back.
