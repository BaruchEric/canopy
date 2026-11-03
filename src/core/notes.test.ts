import { describe, expect, test } from "bun:test";
import { dueWord, isNoteId, mintNoteId, QUICK_NOTE_CHARS, noteText, openNotes, parseNotes, remindDue, sortNotes, type QuickNote } from "./notes";

const note = (id: string, over: Partial<QuickNote> = {}): QuickNote => ({ id, text: id, createdAt: 1_000, ...over });

describe("mintNoteId", () => {
  test("n- and eight base32 characters", () => {
    const id = mintNoteId(() => new Uint8Array([0, 0, 0, 0, 0]));
    expect(id).toBe("n-aaaaaaaa");
    expect(isNoteId(id)).toBe(true);
    expect(isNoteId(mintNoteId())).toBe(true);
  });
  test("a work id, a bare word and the wrong length are not note ids", () => {
    expect(isNoteId("w-aaaaaaaa")).toBe(false);
    expect(isNoteId("n-aaaa")).toBe(false);
    expect(isNoteId("notes")).toBe(false);
    expect(isNoteId(3)).toBe(false);
  });
});

describe("noteText", () => {
  test("trims, keeps inner newlines, and caps the length", () => {
    expect(noteText("  ask Eric\nabout atlas  ")).toBe("ask Eric\nabout atlas");
    expect(noteText("x".repeat(QUICK_NOTE_CHARS + 20))).toHaveLength(QUICK_NOTE_CHARS);
    expect(noteText("   ")).toBe("");
  });
});

describe("parseNotes", () => {
  test("reads the file's array, dropping records that are not notes", () => {
    const v = [
      { id: "n-aaaaaaaa", text: "one", createdAt: 1 },
      { id: "n-bbbbbbbb", text: "two", createdAt: 2, repoId: "r1", due: 50, remindedAt: 60, doneAt: 70 },
      { id: "w-cccccccc", text: "a work id", createdAt: 3 },
      { id: "n-dddddddd", text: 4, createdAt: 4 },
      { id: "n-eeeeeeee", text: "no time" },
      "nothing",
      { id: "n-ffffffff", text: "odd extras", createdAt: 5, repoId: 7, due: "soon" },
    ];
    expect(parseNotes(v)).toEqual([
      { id: "n-aaaaaaaa", text: "one", createdAt: 1 },
      { id: "n-bbbbbbbb", text: "two", createdAt: 2, repoId: "r1", due: 50, remindedAt: 60, doneAt: 70 },
      { id: "n-ffffffff", text: "odd extras", createdAt: 5 },
    ]);
  });
  test("anything but an array is no notes", () => {
    expect(parseNotes(null)).toEqual([]);
    expect(parseNotes({ notes: [] })).toEqual([]);
    expect(parseNotes("[]")).toEqual([]);
  });
});

describe("openNotes and sortNotes", () => {
  test("open leaves the done ones out", () => {
    const list = [note("n-aaaaaaaa"), note("n-bbbbbbbb", { doneAt: 5 })];
    expect(openNotes(list).map((n) => n.id)).toEqual(["n-aaaaaaaa"]);
  });
  test("a reminder comes before a plain note, the soonest first; plain notes newest first", () => {
    const list = [
      note("n-plainold", { createdAt: 10 }),
      note("n-latedue1", { due: 300, createdAt: 11 }),
      note("n-plainnew", { createdAt: 20 }),
      note("n-soondue1", { due: 100, createdAt: 12 }),
    ];
    expect(sortNotes(list).map((n) => n.id)).toEqual(["n-soondue1", "n-latedue1", "n-plainnew", "n-plainold"]);
  });
});

describe("remindDue", () => {
  test("a reminder whose time has come is marked once; a done, a reminded or a later one is left", () => {
    const list = [
      note("n-duenow11", { due: 100 }),
      note("n-duelater", { due: 500 }),
      note("n-remindd1", { due: 50, remindedAt: 60 }),
      note("n-doneone1", { due: 50, doneAt: 70 }),
      note("n-nodue111"),
    ];
    const r = remindDue(list, 200);
    expect(r.delivered.map((n) => n.id)).toEqual(["n-duenow11"]);
    expect(r.notes.find((n) => n.id === "n-duenow11")?.remindedAt).toBe(200);
    expect(r.notes.filter((n) => n.id !== "n-duenow11")).toEqual(list.filter((n) => n.id !== "n-duenow11"));
    // the same list again delivers nothing more
    expect(remindDue(r.notes, 300).delivered).toEqual([]);
  });
  test("the list is the same object when nothing came due", () => {
    const list = [note("n-duelater", { due: 500 })];
    expect(remindDue(list, 200).notes).toBe(list);
  });
});

describe("dueWord", () => {
  const now = 1_000_000_000;
  test("ahead: in Nm, in Nh, in Nd", () => {
    expect(dueWord(now + 30_000, now)).toBe("in 1m");
    expect(dueWord(now + 5 * 60_000, now)).toBe("in 5m");
    expect(dueWord(now + 90 * 60_000, now)).toBe("in 1h 30m");
    expect(dueWord(now + 3 * 3_600_000, now)).toBe("in 3h");
    expect(dueWord(now + 2 * 86_400_000 + 3_600_000, now)).toBe("in 2d");
  });
  test("past: Nm ago, up to days", () => {
    expect(dueWord(now - 20_000, now)).toBe("now");
    expect(dueWord(now - 5 * 60_000, now)).toBe("5m ago");
    expect(dueWord(now - 26 * 3_600_000, now)).toBe("1d ago");
  });
});
