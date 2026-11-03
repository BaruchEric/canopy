import { describe, expect, test } from "bun:test";
import { addNote, branchSlug, exportMarkdown, fromWord, HANDOFF_CHARS, HANDOFF_LEAD, handoffFence, handoffOf, isWorkId, mintId, NOTE_CHARS, NOTES_MAX, noteStamp, stateOf, titleOf, trailerLine, trailerOf, WORK_ID, WORK_TRAILER, workBranchName, workIdOf, type WorkItem, type WorkNote } from "./work";

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

describe("handoffOf", () => {
  test("the text under the closing message's ## Handoff heading, trimmed and cut to NOTE_CHARS", () => {
    expect(handoffOf("Done. The tests pass.\n\n## Handoff\n\nThe types test is flaky on Linux; rerun it once before blaming the change.\n")).toBe("The types test is flaky on Linux; rerun it once before blaming the change.");
    expect(handoffOf("## Handoff\nline one\nline two")).toBe("line one\nline two");
    expect(handoffOf("## Handoff\n" + "x".repeat(700))).toHaveLength(NOTE_CHARS);
  });
  test("the heading's level and case do not matter, and the last one wins", () => {
    expect(handoffOf("### handoff\nlower and deeper")).toBe("lower and deeper");
    expect(handoffOf("Handoff\nno heading mark")).toBeNull();
    expect(handoffOf("## Handoff\nfirst\n\n## Handoff\nsecond")).toBe("second");
  });
  test("text after it under a heading of its own level or above is not the handoff", () => {
    expect(handoffOf("## Handoff\nleave this\n\n## Next steps\nnot this")).toBe("leave this");
    expect(handoffOf("## Handoff\nleave this\n\n### Detail\nand this too")).toBe("leave this\n\n### Detail\nand this too");
  });
  test("nothing without the heading, or with nothing under it", () => {
    expect(handoffOf("Done. The tests pass.")).toBeNull();
    expect(handoffOf("## Handoff\n\n   \n")).toBeNull();
    expect(handoffOf("")).toBeNull();
  });
});

describe("handoffFence", () => {
  const note = (i: number, text: string, by = "canopy"): WorkNote => ({ at: Date.UTC(2026, 9, 26, 10, i), by, text });
  test("the lead, the notes as data between <<< and >>>, newest last", () => {
    const fence = handoffFence([note(0, "branch ready, sorted logic"), note(5, "sent back: conflict in 2 files"), note(9, "rebased it; the conflict was in the lockfile", "agent")]);
    expect(fence).toBe(`${HANDOFF_LEAD}\n<<<\n2026-10-26 10:00 canopy: branch ready, sorted logic\n2026-10-26 10:05 canopy: sent back: conflict in 2 files\n2026-10-26 10:09 agent: rebased it; the conflict was in the lockfile\n>>>`);
    expect(handoffFence([])).toBe("");
  });
  test("cut to HANDOFF_CHARS from the end, so the newest notes survive", () => {
    const notes = Array.from({ length: 12 }, (_, i) => note(i, `${i}:${"x".repeat(NOTE_CHARS - 3)}`));
    const fence = handoffFence(notes);
    const body = fence.slice(`${HANDOFF_LEAD}\n<<<\n`.length, -">>>".length);
    expect(body.length).toBeLessThanOrEqual(HANDOFF_CHARS + 2);
    expect(body.startsWith("…")).toBe(true);
    expect(body).toContain("canopy: 11:xxx");
    expect(body).not.toContain("canopy: 0:xxx");
    expect(fence.endsWith(">>>")).toBe(true);
  });
  test("a line break inside a note stays inside its line", () => {
    expect(handoffFence([note(1, "two\nlines")])).toContain("canopy: two lines\n>>>");
  });
});

describe("exportMarkdown", () => {
  const item: WorkItem = {
    id: "w-test2345",
    title: "Add a test",
    repos: ["dev-tools/canopy"],
    state: "review",
    from: { kind: "issue", service: "github", key: "o/r#12", link: "https://github.com/o/r/issues/12" },
    runs: ["r1", "fix1"],
    branches: ["b1"],
    prs: [{ number: 7, url: "https://github.com/o/r/pull/7" }],
    events: ["e1"],
    notes: [
      { at: Date.UTC(2026, 9, 26, 10, 0), by: "canopy", text: "branch ready, lands on its own" },
      { at: Date.UTC(2026, 9, 26, 10, 5), by: "agent", text: "the lockfile moved; rerun install" },
    ],
    createdAt: Date.UTC(2026, 9, 26, 9, 0),
    updatedAt: Date.UTC(2026, 9, 26, 10, 5),
  };
  test("title, state, links and the notes as a dated list, with the trailer last", () => {
    expect(exportMarkdown(item)).toBe([
      "# Add a test",
      "",
      "- id: w-test2345",
      "- state: review",
      "- repos: dev-tools/canopy",
      "- from: [github issue o/r#12](https://github.com/o/r/issues/12)",
      "- opened: 2026-10-26 09:00",
      "- branches: b1",
      "- runs: r1, fix1",
      "- PRs: [#7](https://github.com/o/r/pull/7)",
      "- events: e1",
      "",
      "## Notes",
      "",
      "- 2026-10-26 10:00 canopy: branch ready, lands on its own",
      "- 2026-10-26 10:05 agent: the lockfile moved; rerun install",
      "",
      "Canopy-Work: w-test2345",
      "",
    ].join("\n"));
  });
  test("a closed item says when and why; an empty item says so", () => {
    const dropped = exportMarkdown({ ...item, state: "dropped", closedAt: Date.UTC(2026, 9, 27, 8, 0), reason: "not worth it", from: { kind: "note" }, runs: [], branches: [], prs: [], events: [], notes: [] });
    expect(dropped).toContain("- state: dropped (not worth it)\n");
    expect(dropped).toContain("- closed: 2026-10-27 08:00\n");
    expect(dropped).toContain("- from: a note\n");
    expect(dropped).not.toContain("- branches:");
    expect(dropped).toContain("## Notes\n\n(none yet)\n");
  });
  test("noteStamp is the minute in UTC", () => {
    expect(noteStamp(Date.UTC(2026, 9, 26, 10, 5, 59))).toBe("2026-10-26 10:05");
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
