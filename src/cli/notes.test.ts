import { describe, expect, test } from "bun:test";
import type { QuickNote } from "../core/notes";
import { addBody, noteLines } from "./notes";

const note = (id: string, over: Partial<QuickNote> = {}): QuickNote => ({ id, text: `note ${id}`, createdAt: 1, ...over });

describe("addBody", () => {
  test("carries only what was given, the time as typed for the backend to read", () => {
    expect(addBody("x", undefined, undefined)).toEqual({ text: "x" });
    expect(addBody("x", "/repos/atlas", "in 30m")).toEqual({ text: "x", repo: "/repos/atlas", at: "in 30m" });
  });
});

describe("noteLines", () => {
  const now = 1_000_000_000;
  const notes = [
    note("n-plainone"),
    note("n-soondue1", { due: now + 5 * 60_000, repoId: "r1" }),
    note("n-inboxed1", { due: now - 60_000, remindedAt: now - 30_000 }),
    note("n-doneone1", { due: now - 3_600_000, remindedAt: now - 3_500_000, doneAt: now - 1000, text: "two  words\nand a line" }),
  ];
  test("open notes only, reminders first and the soonest at the top, each with its word", () => {
    const lines = noteLines(notes, now, false, (id) => (id === "r1" ? "atlas" : id));
    expect(lines.map((l) => l.split(/\s{2,}/))).toEqual([
      ["n-inboxed1", "in inbox", "note n-inboxed1"],
      ["n-soondue1", "in 5m", "atlas", "note n-soondue1"],
      ["n-plainone", "note n-plainone"],
    ]);
  });
  test("--all lists the done ones after, marked done, their text on one line", () => {
    const lines = noteLines(notes, now, true);
    expect(lines).toHaveLength(4);
    expect(lines[3]).toBe("n-doneone1  done                       two words and a line");
  });
});
