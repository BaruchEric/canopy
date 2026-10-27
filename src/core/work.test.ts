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
    expect(out[1]?.text).toHaveLength(NOTE_CHARS);
    expect(addNote(out, note(3, "   "))).toEqual(out);
  });
  test("past NOTES_MAX the oldest fold into one earlier line, and fold again", () => {
    let notes: WorkNote[] = [];
    for (let i = 1; i <= NOTES_MAX + 1; i++) notes = addNote(notes, note(i));
    expect(notes).toHaveLength(NOTES_MAX);
    expect(notes[0]).toEqual({ at: 2, by: "canopy", text: "earlier: n1 · n2" });
    expect(notes[1]?.text).toBe("n3");
    notes = addNote(notes, note(NOTES_MAX + 2));
    expect(notes).toHaveLength(NOTES_MAX);
    expect(notes[0]).toEqual({ at: 3, by: "canopy", text: "earlier: n1 · n2 · n3" });
    expect(notes.at(-1)?.text).toBe(`n${NOTES_MAX + 2}`);
  });
  test("a folded line stays within NOTE_CHARS", () => {
    let notes: WorkNote[] = [];
    for (let i = 1; i <= NOTES_MAX + 1; i++) notes = addNote(notes, note(i, "y".repeat(NOTE_CHARS)));
    expect(notes[0]?.text.length).toBeLessThanOrEqual(NOTE_CHARS);
    expect(notes[0]?.text.startsWith("earlier: ")).toBe(true);
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
