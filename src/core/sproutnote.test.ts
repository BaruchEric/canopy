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

describe("the retro in the note", () => {
  const retro = { for: "end" as const, state: "done" as const, at: 1, endedAt: 2, flowsSeen: 1, tries: 1, advice: [{ key: "clarify-asks-less", lesson: "Clarify asked\nwhat the brief said." }] };

  test("none before a retro is done", () => {
    expect(sproutNote(sprout(), null, "# Retro: x\n\nwords")).not.toContain("## Retro");
    expect(sproutNote(sprout({ retro: { ...retro, state: "running" } }), null, "words")).not.toContain("## Retro");
  });

  test("a done retro: its account without its heading, clipped, then its lessons", () => {
    const md = sproutNote(sprout({ status: "live", retro }), null, `# Retro: Change counter\n\nWhat went well: clarify.\n${"word ".repeat(2000)}`);
    expect(md).toContain("## Retro\n\nWhat went well: clarify.");
    expect(md).not.toContain("# Retro: Change counter");
    expect(md).toContain("…");
    expect(md).toContain("Advice:\n\n- clarify-asks-less: Clarify asked what the brief said.");
    const section = md.slice(md.indexOf("## Retro"));
    expect(section.length).toBeLessThan(4300);
  });

  test("a failed retro says why, and one with no advice says so", () => {
    expect(sproutNote(sprout({ retro: { ...retro, state: "failed", reason: "the retro failed: the run failed" } }), null)).toContain("The retro failed: the retro failed: the run failed");
    expect(sproutNote(sprout({ retro: { ...retro, advice: [] } }), null, "# Retro\n\nfine")).toContain("fine\n\nNo advice.");
  });
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
  test("going live and being turned down each put a line in the day", () => {
    expect(DAILY_EVENTS.has("live")).toBe(true);
    expect(DAILY_EVENTS.has("rejected")).toBe(true);
    expect(dailyLine(sprout({ status: "live", url: "https://change-counter.vercel.app" }), "live")).toContain(
      "- **incubator: Change counter** - live at https://change-counter.vercel.app. Note:",
    );
    expect(dailyLine(sprout({ status: "rejected", parked: "a coin app\nalready exists" }), "rejected")).toContain(
      "turned down at eval: a coin app already exists.",
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
  test("a park reason with newlines stays one line, in the note and in the daily line", () => {
    const s = sprout({ status: "parked", parked: "clarify failed: boom\n## not a heading\n- not an item" });
    const md = sproutNote(s, null);
    expect(md).toContain("Parked: clarify failed: boom ## not a heading - not an item\n");
    expect(md).not.toContain("\n## not a heading");
    const line = dailyLine(s, "parked");
    expect(line.trim().split("\n")).toHaveLength(1);
    expect(line).toContain("parked: clarify failed: boom ## not a heading - not an item.");
  });
  test("open questions are counted", () => {
    const q = { question: "Who?", header: "", options: [], multiSelect: false };
    expect(sproutNote(sprout({ questions: [q, { ...q, question: "Where?" }] }), null)).toContain("2 questions wait for the user.");
  });
  test("a live sprout's note names the pick, the private repo and the url; a rejected one says why", () => {
    const live = sproutNote(
      sprout({
        status: "live",
        pick: { kind: "new", host: "vercel", why: "nothing close exists" },
        privateRepo: "eric/change-counter",
        url: "https://change-counter.vercel.app",
      }),
      "Count coins.",
    );
    expect(live).toContain("status: live\n");
    expect(live).toContain("Live at https://change-counter.vercel.app.");
    expect(live).toContain("## Where it lives\n\n- Pick: new, on vercel. nothing close exists\n- Repo: https://github.com/eric/change-counter (private)\n- Url: https://change-counter.vercel.app\n");
    const no = sproutNote(sprout({ status: "rejected", parked: "a coin app already exists" }), null);
    expect(no).toContain("Turned down at eval: a coin app already exists");
    expect(no).not.toContain("## Where it lives");
  });
});
