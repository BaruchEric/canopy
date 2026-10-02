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
    // parked at a gate: the flow is alive and waits on the human, so the slot stays taken
    expect(holdsSlot(sprout({ status: "parked" }), "gated")).toBe(true);
    expect(holdsSlot(sprout({ status: "parked" }), "failed")).toBe(false);
    expect(holdsSlot(sprout({ status: "queued" }), "gated")).toBe(false);
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
