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
