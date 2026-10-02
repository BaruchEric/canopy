import { describe, expect, test } from "bun:test";
import {
  answersText,
  briefTitle,
  holdsSlot,
  inputKindOf,
  inputType,
  inputsIndex,
  isSeedId,
  lastDone,
  localStamp,
  nextWorkflow,
  parsePick,
  parseQuestions,
  pickRefusal,
  phaseRefusal,
  parseSproutRecord,
  parseSummaries,
  safeInputName,
  SHIP,
  sproutEnded,
  statusFor,
  sproutSlug,
  sproutTitle,
  withInputsRead,
  withWorkspaceRead,
  workspaceLine,
  urlWithoutSecret,
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
    // a transcript's summary is clarify's, since its own words never go to the vault
    const memo: InputEntry = { n: 9, kind: "transcript", name: "009-v.txt", label: "v.webm (transcript)", type: "text/plain", at: 1, via: "sheet", bytes: 4, summary: "", processed: true, from: 8 };
    expect(withSummaries([memo], new Map([[9, "wants a tally per machine"]]))[0]?.summary).toBe("wants a tally per machine");
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
  test("withWorkspaceRead adds devhub's two indexes and READMEs under the root, and nothing wider", () => {
    const wf = { steps: [{ name: "Research", tools: ["WebFetch"] }] } as unknown as Workflow;
    const next = withWorkspaceRead(wf, "/work/dev");
    expect(next.steps[0]?.tools).toEqual([
      "WebFetch",
      "Read(//work/dev/_devhub/manifest.json)",
      "Read(//work/dev/_devhub/references.json)",
      "Read(//work/dev/**/README.md)",
    ]);
    expect(wf.steps[0]?.tools).toEqual(["WebFetch"]);
    expect(workspaceLine("/work/dev")).toBe("The workspace's devhub manifest is /work/dev/_devhub/manifest.json and its saved references are /work/dev/_devhub/references.json.");
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

  const full = sprout({
    status: "clarifying",
    repo: "https://github.com/a/b",
    inputs: [
      { n: 1, kind: "audio", name: "001-voice.webm", label: "voice.webm", type: "audio/webm", at: 1, via: "sheet", bytes: 3, summary: "", processed: true, note: "x" },
      { n: 2, kind: "transcript", name: "002-voice.txt", label: "voice.webm (transcript)", type: "text/plain", at: 1, via: "sheet", bytes: 6, summary: "spoken", processed: true, from: 1 },
    ],
    clarified: true,
    questions: [{ question: "Who counts?", header: "", options: [{ label: "staff", description: "" }], multiSelect: false }],
    questionsAt: 5,
    flows: [{ workflow: "clarify", flowId: "abcd1234", outcome: "done" }],
    spent: { runs: 1, workMs: 60_000 },
    parked: "why",
    noteRev: "7",
  });

  test("a whole record round-trips, and the root it was written for passes through", () => {
    expect(parseSproutRecord(JSON.stringify(full))).toEqual(full);
    const stamped = { ...full, root: "/root" };
    expect(parseSproutRecord(JSON.stringify(stamped))).toEqual(stamped);
  });

  test("a record whose parts restore reads are malformed is null", () => {
    const bad = (patch: Record<string, unknown>) => parseSproutRecord(JSON.stringify({ ...full, ...patch }));
    const input = full.inputs[0];
    expect(bad({ inputs: [null] })).toBeNull();
    expect(bad({ inputs: [{ ...input, n: "1" }] })).toBeNull();
    expect(bad({ inputs: [{ ...input, kind: "video" }] })).toBeNull();
    expect(bad({ inputs: [{ ...input, via: "mail" }] })).toBeNull();
    expect(bad({ inputs: [{ ...input, processed: "yes" }] })).toBeNull();
    expect(bad({ inputs: [{ ...input, from: "1" }] })).toBeNull();
    expect(bad({ flows: ["abcd1234"] })).toBeNull();
    expect(bad({ flows: [{ workflow: "clarify" }] })).toBeNull();
    expect(bad({ flows: [{ workflow: "clarify", flowId: "abcd1234", outcome: 3 }] })).toBeNull();
    expect(bad({ spent: null })).toBeNull();
    expect(bad({ spent: { runs: 1 } })).toBeNull();
    expect(bad({ prepared: "true" })).toBeNull();
    expect(bad({ clarified: 1 })).toBeNull();
    expect(bad({ reclarify: null })).toBeNull();
    expect(bad({ updatedAt: "now" })).toBeNull();
    expect(bad({ questions: {} })).toBeNull();
    expect(bad({ questions: [{ question: "Q?" }] })).toBeNull();
    expect(bad({ questions: [{ ...full.questions?.[0], options: ["staff"] }] })).toBeNull();
    expect(bad({ questionsAt: "5" })).toBeNull();
    expect(bad({ parked: 1 })).toBeNull();
    expect(bad({ noteRev: 7 })).toBeNull();
    expect(bad({ repo: false })).toBeNull();
  });
});

describe("urlWithoutSecret", () => {
  test("an http(s) url loses its userinfo, an ssh url its password only, anything else is as given", () => {
    expect(urlWithoutSecret("https://x:tok3n@github.com/a/b.git")).toBe("https://github.com/a/b.git");
    expect(urlWithoutSecret("HTTP://tok3n@host:8080/r?q=a@b")).toBe("HTTP://host:8080/r?q=a@b");
    expect(urlWithoutSecret("https://a:p@ss@host/r")).toBe("https://host/r");
    expect(urlWithoutSecret("ssh://git:secret@host/r.git")).toBe("ssh://git@host/r.git");
    expect(urlWithoutSecret("ssh://git@host/r.git")).toBe("ssh://git@host/r.git");
    expect(urlWithoutSecret("git@github.com:a/b.git")).toBe("git@github.com:a/b.git");
    expect(urlWithoutSecret("https://github.com/a/b")).toBe("https://github.com/a/b");
  });
  test("a password holding a raw /, ? or # still goes", () => {
    expect(urlWithoutSecret("https://u:p/q@host/x")).toBe("https://host/x");
    expect(urlWithoutSecret("https://u:p?q@host/x")).toBe("https://host/x");
    expect(urlWithoutSecret("https://u:p#q@host/x")).toBe("https://host/x");
    expect(urlWithoutSecret("https://u:p/q@r@host/x")).toBe("https://host/x");
    expect(urlWithoutSecret("https://u:p/q@host/x@y")).toBe("https://host/x@y");
    expect(urlWithoutSecret("https://u:p/q@host")).toBe("https://host");
    expect(urlWithoutSecret("ssh://git:se/cret@host/r.git")).toBe("ssh://git@host/r.git");
  });
  test("an @ in the path, query or after a port is left alone, and so is the scp form", () => {
    for (const url of [
      "https://host/x@y",
      "https://medium.com/@user/post",
      "https://registry.npmjs.org/@scope/pkg",
      "https://host/a@b/c",
      "https://host:8080/a@b",
      "https://host:8080/r?q=a@b",
      "https://host?a=b:c@d",
      "https://host/p:q@r",
      "https://[::1]:8080/a@b",
      "https://[::1]/a@b",
      "git@host:x/y",
    ]) {
      expect(urlWithoutSecret(url)).toBe(url);
    }
  });
});

describe("answersText", () => {
  test("a question named like an Object.prototype key reads as no answer, not a function", () => {
    const q = (question: string) => ({ question, header: "", options: [], multiSelect: false });
    const text = answersText([q("constructor"), q("toString"), q("Who counts?")], { "Who counts?": "the owner" }, 0);
    expect(text).toContain("- constructor\n  (no answer)");
    expect(text).toContain("- toString\n  (no answer)");
    expect(text).toContain("- Who counts?\n  the owner");
  });
});

describe("the pick", () => {
  const pick = (o: Record<string, unknown>): string => JSON.stringify({ kind: "new", host: "vercel", why: "nothing close exists", ...o });

  test("a new pick on vercel reads back with its why clipped to one line", () => {
    const p = parsePick(pick({ why: `fits\n  the stack ${"x".repeat(600)}`, extra: 1 }));
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    expect(p.pick.kind).toBe("new");
    expect(p.pick.host).toBe("vercel");
    expect(p.pick.why.startsWith("fits the stack x")).toBe(true);
    expect(p.pick.why.length).toBe(500);
    expect(Object.keys(p.pick).sort()).toEqual(["host", "kind", "why"]);
  });

  test("not JSON, not an object, a kind or host off the list, and no why are refused with the reason", () => {
    expect(parsePick("{nope")).toEqual({ ok: false, error: "pick.json is not JSON" });
    expect(parsePick("[]")).toEqual({ ok: false, error: "pick.json must be an object" });
    expect(parsePick(pick({ kind: "fork" }))).toEqual({ ok: false, error: "kind must be one of new, renovate, extend" });
    expect(parsePick(pick({ host: "netlify" }))).toEqual({ ok: false, error: "host must be one of vercel, vercel+firebase, vercel+convex, mini" });
    expect(parsePick(pick({ why: "  " }))).toEqual({ ok: false, error: "why must say in a sentence why this pick" });
  });

  test("a renovate pick needs an https target, kept without its secret; a new pick drops any target", () => {
    expect(parsePick(pick({ kind: "renovate", license: "MIT" }))).toEqual({ ok: false, error: "a renovate pick needs target: the upstream's https url" });
    expect(parsePick(pick({ kind: "renovate", license: "MIT", target: "/home/eric/dev/x" }))).toEqual({ ok: false, error: "a renovate pick needs target: the upstream's https url" });
    const r = parsePick(pick({ kind: "renovate", license: "MIT", target: "https://u:tok@github.com/a/b" }));
    expect(r.ok && r.pick.target).toBe("https://github.com/a/b");
    const n = parsePick(pick({ target: "https://github.com/a/b" }));
    expect(n.ok && n.pick.target).toBe(undefined);
    expect(parsePick(pick({ kind: "extend" }))).toEqual({ ok: false, error: "an extend pick needs target: the repo it extends" });
  });

  test("pickRefusal holds the license rules, phaseRefusal holds phase 3 to new picks on vercel", () => {
    const base = { kind: "renovate" as const, host: "vercel" as const, why: "w", target: "https://github.com/a/b" };
    expect(pickRefusal(base)).toBe("a renovate pick needs the upstream's SPDX license");
    expect(pickRefusal({ ...base, license: "AGPL-3.0" })).toBe("AGPL-3.0 is not on the allowed license list");
    expect(pickRefusal({ ...base, license: "MIT" })).toBe(null);
    expect(pickRefusal({ kind: "new", host: "vercel", why: "w" })).toBe(null);
    expect(phaseRefusal({ kind: "new", host: "vercel", why: "w" })).toBe(null);
    expect(phaseRefusal({ ...base, license: "MIT" })).toBe("a renovate pick arrives in phase 4; the research is in .canopy/research.md");
    expect(phaseRefusal({ kind: "new", host: "vercel+convex", why: "w" })).toBe("deploying to vercel+convex arrives in phase 4; the research is in .canopy/research.md");
  });

  test("a record with a pick, a repo and a url reads back; a bad pick refuses the record", () => {
    const rec = {
      id: "sp_0123456789ab", slug: "s", title: "t", status: "live", repoId: "_incubator/s", seedPath: "/r/_incubator/s",
      prepared: true, inputs: [], clarified: true, reclarify: false, flows: [], spent: { runs: 0, workMs: 0 }, createdAt: 1, updatedAt: 1,
      pick: { kind: "new", host: "vercel", why: "w" }, privateRepo: "eric/s", url: "https://s.vercel.app",
    };
    expect(parseSproutRecord(JSON.stringify(rec))?.url).toBe("https://s.vercel.app");
    expect(parseSproutRecord(JSON.stringify({ ...rec, pick: { kind: "new", host: "aws", why: "w" } }))).toBe(null);
    expect(parseSproutRecord(JSON.stringify({ ...rec, url: 7 }))).toBe(null);
  });
});

describe("the chain", () => {
  const base = (o: Partial<Sprout> = {}): Sprout => ({
    id: "sp_0123456789ab", slug: "s", title: "t", status: "queued", repoId: "_incubator/s", seedPath: "/r/_incubator/s",
    prepared: true, inputs: [], clarified: true, reclarify: false, flows: [], spent: { runs: 0, workMs: 0 }, createdAt: 1, updatedAt: 1, ...o,
  });
  const done = (workflow: string, n: number) => ({ workflow, flowId: `f${n}`, outcome: "done" });
  const pick = { kind: "new" as const, host: "vercel" as const, why: "w" };

  test("clarify, then scout, then build-new, then canopy's ship", () => {
    expect(nextWorkflow(base({ clarified: false }))).toBe("clarify");
    expect(nextWorkflow(base({ reclarify: true, pick }))).toBe("clarify");
    expect(nextWorkflow(base({ flows: [done("clarify", 1)] }))).toBe("scout");
    expect(nextWorkflow(base({ pick, flows: [done("clarify", 1), done("scout", 2)] }))).toBe("build-new");
    expect(nextWorkflow(base({ pick, flows: [done("clarify", 1), done("scout", 2), done("build-new", 3)] }))).toBe(SHIP);
  });

  test("a build from before the newest scout does not count", () => {
    const flows = [done("clarify", 1), done("scout", 2), done("build-new", 3), done("clarify", 4), done("scout", 5)];
    expect(nextWorkflow(base({ pick, flows }))).toBe("build-new");
    expect(lastDone(base({ flows }), "scout")).toBe(4);
    expect(lastDone(base({ flows }), "retro")).toBe(-1);
  });

  test("a running sprout's status follows the step in progress", () => {
    expect(statusFor("build-new", "Scaffold")).toBe("building");
    expect(statusFor("build-new", "Test")).toBe("testing");
    expect(statusFor("build-new", "Accept")).toBe("accepting");
    expect(statusFor("build-new", undefined)).toBe("building");
    expect(statusFor("scout", "Eval")).toBe("researching");
    expect(statusFor(SHIP, undefined)).toBe("deploying");
    expect(statusFor("clarify", "Clarify")).toBe("clarifying");
  });
});

test("isSeedId: a sprout's seed on the launch root, not the making folder or a lookalike", () => {
  expect(isSeedId("_incubator/coin")).toBe(true);
  expect(isSeedId("_incubator/.coin.abc.making")).toBe(false);
  expect(isSeedId("_incubator")).toBe(false);
  expect(isSeedId("_incubator/coin/sub")).toBe(false);
  expect(isSeedId("_incubatorx/coin")).toBe(false);
  expect(isSeedId("src2:_incubator/coin")).toBe(false);
  expect(isSeedId("mini|_incubator/coin")).toBe(true);
});
