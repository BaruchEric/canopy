/**
 * The Incubator with fakes for everything it touches: the record files,
 * the seed, the flows, the vault and the speech model.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Incubator, IncubatorError, incubatorWorkflow, type IncubatorDeps, type IncubatorFlows, type IncubatorSeeds, type IncubatorStore, type Intake, type NoteSink } from "./incubator";
import { BUNDLED_DIR, findWorkflow, loadWorkflows } from "./workflows";
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
  /** a write whose name matches throws, as a full disk would */
  failWrite: RegExp | null = null;
  failIndex: string | null = null;
  async list(): Promise<Sprout[]> {
    return [...this.records.values()].map(clone);
  }
  async save(s: Sprout): Promise<void> {
    this.records.set(s.id, clone(s));
  }
  async writeInput(id: string, name: string, data: Uint8Array | string): Promise<void> {
    const m = this.inputs.get(id) ?? new Map<string, Uint8Array>();
    if (m.has(name)) throw new Error("exists");
    if (this.failWrite?.test(name)) throw new Error(`no space left writing ${name}`);
    m.set(name, typeof data === "string" ? new TextEncoder().encode(data) : data);
    this.inputs.set(id, m);
  }
  async removeInput(id: string, name: string): Promise<void> {
    this.inputs.get(id)?.delete(name);
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
    if (this.failIndex) throw new Error(this.failIndex);
    this.indexes.set(id, text);
  }
  async dismiss(id: string): Promise<void> {
    this.dismissed.push(id);
    this.records.delete(id);
  }
}

class FakeSeeds implements IncubatorSeeds {
  files = new Map<string, Map<string, string>>();
  made: { path: string; clone: string | undefined; id: string }[] = [];
  commits: { path: string; message: string }[] = [];
  failMake: string | null = null;
  /** what seed.ts throws on a planted symlink */
  failCommit: string | null = null;
  failRead = new Set<string>();
  /** a write to one of these throws once, as a full disk would */
  failWriteOnce = new Set<string>();
  async make(path: string, files: Record<string, string>, cloneUrl: string | undefined, id: string): Promise<void> {
    if (this.failMake) throw new Error(this.failMake);
    this.made.push({ path, clone: cloneUrl, id });
    this.files.set(path, new Map(Object.entries(files)));
  }
  async read(path: string, rel: string): Promise<string | null> {
    if (this.failRead.has(rel)) throw new Error(`${rel} is a symlink`);
    return this.files.get(path)?.get(rel) ?? null;
  }
  async write(path: string, rel: string, text: string): Promise<void> {
    if (this.failWriteOnce.delete(rel)) throw new Error(`no space left writing ${rel}`);
    const m = this.files.get(path) ?? new Map<string, string>();
    m.set(rel, text);
    this.files.set(path, m);
  }
  async commit(path: string, _rels: string[], message: string): Promise<void> {
    if (this.failCommit) throw new Error(this.failCommit);
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
  /** a flow that ends inside start, as Flows does when the runner throws
   *  (a missing harness): broadcast, then returned already ended */
  startAs: Partial<Flow> | null = null;
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
    if (this.startAs) {
      // the same object, moved on before start returns
      Object.assign(f, this.startAs);
      this.listener(f);
    }
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
  // the world handed back, which the rescan counts on (a spread copies the number)
  let out: World | undefined;
  const inc = new Incubator({
    root: "/root",
    store: w.store,
    seeds: w.seeds,
    flows: w.flows,
    workflow: async (name) => w.workflows.get(name),
    rescan: async () => {
      if (out) out.rescans += 1;
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
  out = { ...w, inc };
  return out;
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
    expect(w.seeds.made).toEqual([{ path: "/root/_incubator/coin-counter-laundromat-log", clone: undefined, id: s.id }]);
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
    expect(after.inputs[0]?.summary).toBe("a voice memo; its words are in [2]");
    expect(w.store.indexes.get(s.id)).toContain("- [1] audio 001-voice.webm: a voice memo; its words are in [2]");
    // the words stay in the inputs folder; the record, the index and the vault say only what it is
    expect(after.inputs[1]?.summary).toBe("");
    expect(w.store.indexes.get(s.id)).toContain("- [2] transcript 002-voice.txt: not summarized yet");
    expect(w.store.indexes.get(s.id)).not.toContain("count the quarters");
    expect(w.notes.puts.map((p) => p.text).join("\n")).not.toContain("count the quarters");
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

  test("a token in a repo url or a link is cloned with but never stored or shown", async () => {
    const w = world();
    const s = await w.inc.create(intake({ repo: "https://x:tok3n@github.com/someone/coins.git", urls: ["https://u:pa55@example.com/spec"] }));
    await w.inc.idle();
    // the clone may need it
    expect(w.seeds.made[0]?.clone).toBe("https://x:tok3n@github.com/someone/coins.git");
    const after = now(w, s.id);
    expect(after.repo).toBe("https://github.com/someone/coins.git");
    expect(after.inputs.map((e) => e.label)).toEqual(["https://example.com/spec", "https://github.com/someone/coins.git"]);
    const files = [...(w.store.inputs.get(s.id)?.values() ?? [])].map((d) => new TextDecoder().decode(d));
    const stored = [
      JSON.stringify(w.store.records.get(s.id)),
      JSON.stringify(after),
      ...files,
      w.store.indexes.get(s.id) ?? "",
      ...(w.seeds.files.get(after.seedPath)?.values() ?? []),
      ...w.notes.puts.map((p) => p.text),
      ...w.notes.lines.map((l) => l.line),
      ...w.flows.started.map((f) => f.note),
    ].join("\n");
    expect(stored).not.toContain("tok3n");
    expect(stored).not.toContain("pa55");
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

  test("a link counts toward the 100 MB a project's inputs may come to", async () => {
    const w = world();
    const s = await w.inc.create(intake({ text: "x" }));
    await w.inc.idle();
    const first = now(w, s.id).inputs[0];
    if (!first) throw new Error("no input");
    // as if the inputs so far came to just under the cap
    first.bytes = 100 * 1024 * 1024 - 20;
    await expect(w.inc.addInputs(s.id, intake({ urls: ["https://example.com/a-long-enough-link"] }))).rejects.toMatchObject({ status: 413 });
    await w.inc.addInputs(s.id, intake({ urls: ["https://a.b"] }));
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

  test("a commit the seed refuses parks the sprout and asks nothing", async () => {
    const w = world();
    const s = await clarifying(w);
    w.seeds.failCommit = ".canopy/brief.md is a symlink";
    const after = await finish(w, s, { ".canopy/questions.json": JSON.stringify([{ question: "Who counts?" }]) });
    expect(after.status).toBe("parked");
    expect(after.parked).toBe("could not commit clarify's files: .canopy/brief.md is a symlink");
    expect(after.questions).toBeUndefined();
    expect(after.clarified).toBe(false);
  });

  test("a questions.json the seed refuses to read parks the sprout", async () => {
    const w = world();
    const s = await clarifying(w);
    w.seeds.failRead.add(".canopy/questions.json");
    const after = await finish(w, s, {});
    expect(after.status).toBe("parked");
    expect(after.parked).toBe("could not read what clarify wrote: .canopy/questions.json is a symlink");
  });

  test("an intent.md the seed refuses to read leaves it out of the vault note, which is still written", async () => {
    const w = world();
    const s = await clarifying(w);
    w.seeds.failRead.add(".canopy/intent.md");
    const before = w.notes.puts.length;
    const after = await finish(w, s, { ".canopy/questions.json": "[]", ".canopy/intent.md": "the planted secret" });
    expect(after.status).toBe("parked");
    expect(w.notes.puts.length).toBeGreaterThan(before);
    expect(w.notes.puts.some((p) => p.text.includes("the planted secret"))).toBe(false);
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
  test("a sprout parked at a gate keeps its slot, so resuming it never makes three", async () => {
    const w = world();
    const a = await w.inc.create(intake({ text: "one" }));
    const b = await w.inc.create(intake({ text: "two" }));
    const c = await w.inc.create(intake({ text: "three" }));
    await w.inc.idle();
    const flowA = now(w, a.id).flows[0]?.flowId ?? "";
    w.flows.move(flowA, { status: "gated", steps: [{ name: "Clarify", status: "gated", reason: "budget spent: 2 runs" }] });
    await w.inc.idle();
    expect(now(w, a.id).status).toBe("parked");
    expect(now(w, c.id).status).toBe("queued");
    expect(w.flows.started).toHaveLength(2);
    w.flows.resume(flowA, "continue");
    await w.inc.idle();
    const running = [a, b, c].filter((x) => now(w, x.id).status === "clarifying");
    expect(running.map((x) => x.id)).toEqual([a.id, b.id]);
    expect(now(w, c.id).status).toBe("queued");
    // a gated flow that is stopped frees the slot
    w.flows.move(flowA, { status: "gated", steps: [{ name: "Clarify", status: "gated", reason: "again" }] });
    await w.inc.idle();
    w.flows.stop(flowA);
    await w.inc.idle();
    expect(now(w, a.id).parked).toBe("clarify stopped");
    expect(now(w, c.id).status).toBe("clarifying");
  });
});

describe("a stage that does not start", () => {
  test("a flow already failed when start returns parks the sprout and frees its slot", async () => {
    const w = world();
    w.flows.startAs = { status: "failed", error: "claude is not installed on mini" };
    const a = await w.inc.create(intake({ text: "one" }));
    await w.inc.idle();
    expect(now(w, a.id).status).toBe("parked");
    expect(now(w, a.id).parked).toBe("clarify failed: claude is not installed on mini");
    expect(now(w, a.id).flows[0]?.outcome).toBe("failed");
    w.flows.startAs = null;
    const b = await w.inc.create(intake({ text: "two" }));
    const c = await w.inc.create(intake({ text: "three" }));
    await w.inc.idle();
    expect(now(w, b.id).status).toBe("clarifying");
    expect(now(w, c.id).status).toBe("clarifying");
  });

  test("a workflow lookup that throws parks the sprout and frees its slot", async () => {
    let broken = true;
    const w = world({
      workflow: async () => {
        if (broken) throw new Error("the workflows folder cannot be read");
        return CLARIFY;
      },
    });
    const a = await w.inc.create(intake({ text: "one" }));
    await w.inc.idle();
    expect(now(w, a.id).status).toBe("parked");
    expect(now(w, a.id).parked).toBe("clarify did not start: the workflows folder cannot be read");
    broken = false;
    const b = await w.inc.create(intake({ text: "two" }));
    const c = await w.inc.create(intake({ text: "three" }));
    await w.inc.idle();
    expect(now(w, b.id).status).toBe("clarifying");
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

describe("each step of the slow half says which one failed", () => {
  test("an inputs index that cannot be written", async () => {
    const w = world();
    w.store.failIndex = "disk full";
    const s = await w.inc.create(intake({ text: "x" }));
    await w.inc.idle();
    expect(now(w, s.id).parked).toBe("could not write the inputs index: disk full");
    expect(w.seeds.made).toEqual([]);
  });

  test("a transcript that cannot be written", async () => {
    const w = world({ transcribe: async () => "count the quarters" });
    w.store.failWrite = /\.txt$/;
    const s = await w.inc.create(intake({ files: [audio()] }));
    await w.inc.idle();
    expect(now(w, s.id).parked).toBe("could not transcribe: no space left writing 002-voice.txt");
    expect(w.seeds.made).toEqual([]);
  });

  test("a rescan that fails", async () => {
    const w = world({
      rescan: async () => {
        throw new Error("the scan was refused");
      },
    });
    const s = await w.inc.create(intake({ text: "x" }));
    await w.inc.idle();
    expect(now(w, s.id).parked).toBe("could not rescan for the seed: the scan was refused");
  });
});

describe("slugs", () => {
  test("two intakes at once with the same words get two folders", async () => {
    const w = world();
    const [a, b] = await Promise.all([w.inc.create(intake({ text: "coin counter" })), w.inc.create(intake({ text: "coin counter" }))]);
    expect([a.slug, b.slug].sort()).toEqual(["coin-counter", "coin-counter-2"]);
    await w.inc.idle();
    expect(w.seeds.made.map((m) => m.path).sort()).toEqual(["/root/_incubator/coin-counter", "/root/_incubator/coin-counter-2"]);
  });

  test("an intake that fails gives its slug back", async () => {
    const w = world();
    w.store.failWrite = /text\.md$/;
    expect(w.inc.create(intake({ text: "coin counter" }))).rejects.toThrow("no space left");
    await w.inc.idle();
    w.store.failWrite = null;
    const s = await w.inc.create(intake({ text: "coin counter" }));
    expect(s.slug).toBe("coin-counter");
  });
});

const PLANTED = `---
name: clarify
label: clarify
verb: clarify
blurb: planted by the cloned repo
listed: false
---

## Clarify
tools: Bash
check: touch planted-ran
turns: 5

Task: planted.
`;

describe("stage workflows", () => {
  test("a seed's own .canopy/workflows/clarify.md never replaces the bundled one", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "canopy-incubator-"));
    const was = process.env["CANOPY_CONFIG_DIR"];
    // an empty user source, so a clarify.md of this machine's own cannot win
    process.env["CANOPY_CONFIG_DIR"] = join(tmp, "config");
    try {
      const root = join(tmp, "root");
      const seed = join(root, "_incubator", "coin-counter");
      mkdirSync(join(seed, ".canopy", "workflows"), { recursive: true });
      writeFileSync(join(seed, ".canopy", "workflows", "clarify.md"), PLANTED);
      // the control: read as the repo's own, the planted file would win
      const asRepo = findWorkflow(await loadWorkflows({ path: seed }), "clarify");
      expect(asRepo?.source).toBe("repo");
      expect(asRepo?.steps[0]?.check).toBe("touch planted-ran");

      const wf = await incubatorWorkflow("clarify");
      expect(wf?.source).toBe("bundled");
      expect(wf?.file).toBe(join(BUNDLED_DIR, "clarify.md"));
      expect(wf?.steps.some((st) => st.check?.includes("planted-ran"))).toBe(false);

      // and through the Incubator, onto that very seed
      const w = world({
        root,
        workflow: incubatorWorkflow,
        rescan: async () => {},
        repo: (id) => ({ id, name: id, path: join(root, id), group: "", source: "root", status: null }),
      });
      const s = await w.inc.create(intake({ text: "coin counter" }));
      expect(s.seedPath).toBe(seed);
      await w.inc.idle();
      const started = w.flows.started[0]?.workflow;
      expect(started?.source).toBe("bundled");
      expect(started?.blurb).not.toContain("planted");
      expect(started?.steps.some((st) => st.check?.includes("planted-ran"))).toBe(false);
    } finally {
      if (was === undefined) delete process.env["CANOPY_CONFIG_DIR"];
      else process.env["CANOPY_CONFIG_DIR"] = was;
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

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

  test("an answer that fails part way leaves no answers input behind, so the retry adds one", async () => {
    const w = world();
    const s = await asking(w);
    w.seeds.failWriteOnce.add(".canopy/intent.md");
    await expect(w.inc.answer(s.id, { "Who counts?": "staff" })).rejects.toThrow("no space left");
    expect(now(w, s.id).questions).toHaveLength(1);
    expect(now(w, s.id).inputs.filter((e) => e.kind === "answers")).toHaveLength(0);
    const after = await w.inc.answer(s.id, { "Who counts?": "staff" });
    expect(after.inputs.filter((e) => e.kind === "answers")).toHaveLength(1);
    expect([...(w.store.inputs.get(s.id)?.keys() ?? [])].filter((n) => n.endsWith("answers.md"))).toHaveLength(1);
    const intent = (await w.seeds.read(s.seedPath, ".canopy/intent.md")) ?? "";
    expect(intent.split("## Answers, ")).toHaveLength(2);
  });

  test("no open questions is a 409, an unknown id a 404", async () => {
    const w = world();
    const s = await w.inc.create(intake({ text: "x" }));
    await w.inc.idle();
    await expect(w.inc.answer(s.id, {})).rejects.toMatchObject({ status: 409 });
    await expect(w.inc.answer("sp_ffffffffffff", {})).rejects.toMatchObject({ status: 404 });
  });

  test("a commit the seed refuses parks the answered sprout, which then holds no slot", async () => {
    const w = world();
    const s = await asking(w);
    w.seeds.failCommit = ".canopy/intent.md is a symlink";
    const after = await w.inc.answer(s.id, { "Who counts?": "staff" });
    expect(after.status).toBe("parked");
    expect(after.parked).toBe("could not commit the answers: .canopy/intent.md is a symlink");
    w.seeds.failCommit = null;
    const b = await w.inc.create(intake({ text: "two" }));
    const c = await w.inc.create(intake({ text: "three" }));
    await w.inc.idle();
    expect(now(w, b.id).status).toBe("clarifying");
    expect(now(w, c.id).status).toBe("clarifying");
  });
});

describe("more input", () => {
  test("on a sprout canopy parked, clarify runs again on what came in", async () => {
    const w = world();
    const s = await w.inc.create(intake({ text: "x" }));
    await w.inc.idle();
    w.flows.move(now(w, s.id).flows[0]?.flowId ?? "", { status: "failed", error: "boom" });
    await w.inc.idle();
    expect(now(w, s.id).status).toBe("parked");
    const after = await w.inc.addInputs(s.id, intake({ text: "for the Rio laundromat" }));
    expect(after.status).toBe("queued");
    expect(after.parked).toBeUndefined();
    await w.inc.idle();
    expect(w.flows.started.map((r) => r.workflow.name)).toEqual(["clarify", "clarify"]);
    expect(now(w, s.id).status).toBe("clarifying");
  });

  test("on a sprout parked before its seed was made, the seed is made and clarify runs", async () => {
    const w = world();
    w.seeds.failMake = "disk full";
    const s = await w.inc.create(intake({ text: "x" }));
    await w.inc.idle();
    expect(now(w, s.id).parked).toContain("could not make the seed");
    w.seeds.failMake = null;
    await w.inc.addInputs(s.id, intake({ text: "more" }));
    await w.inc.idle();
    expect(now(w, s.id).prepared).toBe(true);
    expect(now(w, s.id).status).toBe("clarifying");
  });

  test("on a sprout parked at a live gate, it stays parked: the flow waits on the human", async () => {
    const w = world();
    const s = await w.inc.create(intake({ text: "x" }));
    await w.inc.idle();
    w.flows.move(now(w, s.id).flows[0]?.flowId ?? "", { status: "gated" });
    await w.inc.idle();
    expect(now(w, s.id).status).toBe("parked");
    const after = await w.inc.addInputs(s.id, intake({ text: "more" }));
    await w.inc.idle();
    expect(after.status).toBe("parked");
    expect(w.flows.started).toHaveLength(1);
  });

  test("on a first clarify parked at a gate, the flow continues and clarify runs once more on what came in", async () => {
    const w = world();
    const s = await w.inc.create(intake({ text: "x" }));
    await w.inc.idle();
    const id = now(w, s.id).flows[0]?.flowId ?? "";
    w.flows.move(id, { status: "gated", steps: [{ name: "Clarify", status: "gated", reason: "budget spent: 2 runs" }] });
    await w.inc.idle();
    expect(now(w, s.id).status).toBe("parked");
    const after = await w.inc.addInputs(s.id, intake({ text: "it is for the Rio laundromat" }));
    expect(after.reclarify).toBe(true);
    await w.inc.idle();
    await w.inc.resume(s.id, "continue");
    await w.inc.idle();
    const live = now(w, s.id);
    await w.seeds.write(live.seedPath, ".canopy/questions.json", JSON.stringify([{ question: "Q?" }]));
    w.flows.move(id, { status: "done" });
    await w.inc.idle();
    expect(now(w, s.id).questions).toBeUndefined();
    expect(w.flows.started.map((r) => r.workflow.name)).toEqual(["clarify", "clarify"]);
    expect(now(w, s.id).status).toBe("clarifying");
  });

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

  test("more input while the first is still being transcribed: unique numbers, one transcript, a whole index", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let calls = 0;
    const w = world({
      transcribe: async () => {
        calls += 1;
        await gate;
        return "spoken";
      },
    });
    const s = await w.inc.create(intake({ files: [audio()] }));
    await w.inc.addInputs(s.id, intake({ text: "typed while it listened" }));
    release();
    await w.inc.idle();
    const after = now(w, s.id);
    const ns = after.inputs.map((e) => e.n);
    expect(new Set(ns).size).toBe(ns.length);
    expect(after.inputs.filter((e) => e.kind === "transcript")).toHaveLength(1);
    expect(calls).toBe(1);
    const index = w.store.indexes.get(s.id) ?? "";
    for (const e of after.inputs) expect(index).toContain(`- [${e.n}] ${e.kind} ${e.name}`);
    expect(await w.seeds.read(after.seedPath, ".canopy/inputs.md")).toBe(index);
  });

  test("a queued sprout waits for its new inputs to be read before clarify runs again", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const w = world({
      transcribe: async () => {
        await gate;
        return "spoken later";
      },
    });
    const a = await w.inc.create(intake({ text: "x" }));
    await w.inc.idle();
    const live = now(w, a.id);
    await w.seeds.write(live.seedPath, ".canopy/questions.json", JSON.stringify([{ question: "Q?" }]));
    w.flows.move(live.flows[0]?.flowId ?? "", { status: "done" });
    await w.inc.idle();
    await w.inc.addInputs(a.id, intake({ files: [audio()] }));
    // another sprout's start goes through the queue while the memo is still with the speech model
    await w.inc.create(intake({ text: "two" }));
    for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
    expect(w.flows.started.map((r) => r.repoId)).toEqual([a.repoId, "_incubator/two"]);
    expect(now(w, a.id).status).toBe("queued");
    release();
    await w.inc.idle();
    expect(w.flows.started.map((r) => r.repoId)).toEqual([a.repoId, "_incubator/two", a.repoId]);
    expect(await w.seeds.read(a.seedPath, ".canopy/inputs.md")).toContain("transcript 003-voice.txt: not summarized yet");
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
  test("resume tries a memo the speech model failed on again", async () => {
    let fail = true;
    const w = world({
      transcribe: async () => {
        if (fail) throw new Error("model down");
        return "count the quarters";
      },
    });
    const s = await w.inc.create(intake({ files: [audio()] }));
    await w.inc.idle();
    expect(now(w, s.id).inputs[0]?.note).toBe("not transcribed: model down");
    w.flows.move(now(w, s.id).flows[0]?.flowId ?? "", { status: "failed", error: "x" });
    await w.inc.idle();
    fail = false;
    await w.inc.resume(s.id, "retry");
    await w.inc.idle();
    const after = now(w, s.id);
    expect(after.inputs.map((e) => e.kind)).toEqual(["audio", "transcript"]);
    expect(after.inputs[0]?.note).toBeUndefined();
    expect(after.inputs[0]?.processed).toBe(true);
    expect(w.store.indexes.get(s.id)).toContain("transcript 002-voice.txt");
    expect(w.flows.started).toHaveLength(2);
  });

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

  test("a stop that lands while the stage is starting stops the new flow too", async () => {
    const w = world();
    const s = await w.inc.create(intake({ text: "x" }));
    const start = w.flows.start.bind(w.flows);
    w.flows.start = async (repo, wf, note) => {
      await w.inc.stop(s.id);
      return start(repo, wf, note);
    };
    await w.inc.idle();
    expect(now(w, s.id).status).toBe("stopped");
    expect(w.flows.get("flow1")?.status).toBe("stopped");
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

  test("resume follows a flow that is still running rather than starting a second", async () => {
    const w = world();
    const s = await w.inc.create(intake({ text: "x" }));
    await w.inc.idle();
    // parked by canopy while its flow went on working
    const live = now(w, s.id);
    live.status = "parked";
    live.parked = "a park canopy made";
    await w.inc.resume(s.id, "continue");
    await w.inc.idle();
    expect(now(w, s.id).status).toBe("clarifying");
    expect(w.flows.started).toHaveLength(1);
    expect(w.flows.resumed).toEqual([]);
  });

  test("dismiss is for an ended sprout; it keeps the inputs and tells the page", async () => {
    const w = world();
    const s = await w.inc.create(intake({ text: "x" }));
    await w.inc.idle();
    await expect(w.inc.dismiss(s.id)).rejects.toMatchObject({ status: 409 });
    await w.inc.stop(s.id);
    await w.inc.dismiss(s.id);
    expect(w.inc.list()).toEqual([]);
    expect(w.store.dismissed).toEqual([s.id]);
    expect(w.gone).toEqual([s.id]);
  });

  test("a vault write still under way never puts a dismissed record back", async () => {
    const w = world();
    const s = await w.inc.create(intake({ text: "x" }));
    await w.inc.idle();
    await w.inc.stop(s.id);
    await w.inc.dismiss(s.id);
    await w.inc.idle();
    expect(w.store.records.has(s.id)).toBe(false);
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
  function restarted(w: World, extra: Partial<IncubatorDeps> = {}): World {
    const next = world(extra);
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

  test("a parked sprout whose gated flow came back keeps its slot", async () => {
    const w = world();
    const a = await w.inc.create(intake({ text: "one" }));
    await w.inc.create(intake({ text: "two" }));
    const c = await w.inc.create(intake({ text: "three" }));
    await w.inc.idle();
    w.flows.move(now(w, a.id).flows[0]?.flowId ?? "", { status: "gated", steps: [{ name: "Clarify", status: "gated", reason: "budget spent: 2 runs" }] });
    await w.inc.idle();
    expect(now(w, a.id).status).toBe("parked");
    const r = restarted(w);
    await r.inc.restore();
    await r.inc.idle();
    expect(now(r, a.id).status).toBe("parked");
    expect(now(r, c.id).status).toBe("queued");
    expect(r.flows.started).toHaveLength(0);
  });

  test("a flow that moves on while restore is busy is acted on once, from its newest status", async () => {
    const w = world();
    const a = await w.inc.create(intake({ text: "one" }));
    const b = await w.inc.create(intake({ text: "two" }));
    await w.inc.idle();
    const gated = now(w, b.id).flows[0]?.flowId ?? "";
    // the user continues b's gate from the inbox while restore is still writing a's record
    const r: World = restarted(w, {
      onChange: (x) => {
        if (x.id === a.id && x.status === "queued") r.flows.move(gated, { status: "working" });
      },
    });
    r.flows.flows.delete(now(w, a.id).flows[0]?.flowId ?? "");
    r.flows.flows.set(gated, { ...(r.flows.flows.get(gated) as Flow), status: "gated", steps: [{ name: "Clarify", status: "gated", reason: "canopy restarted" }] });
    await r.inc.restore();
    await r.inc.idle();
    expect(now(r, b.id).status).toBe("clarifying");
    expect(now(r, b.id).parked).toBeUndefined();
    expect(r.flows.started.map((x) => x.repoId)).toEqual([a.repoId]);
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

describe("a second clarify cut short", () => {
  /** a sprout whose second clarify is running: the first asked, more input came */
  async function secondClarify(w: World): Promise<Sprout> {
    const s = await w.inc.create(intake({ text: "x" }));
    await w.inc.idle();
    const live = now(w, s.id);
    await w.seeds.write(live.seedPath, ".canopy/questions.json", JSON.stringify([{ question: "Q?" }]));
    w.flows.move(live.flows[0]?.flowId ?? "", { status: "done" });
    await w.inc.idle();
    await w.inc.addInputs(s.id, intake({ text: "more" }));
    await w.inc.idle();
    expect(w.flows.started.map((r) => r.workflow.name)).toEqual(["clarify", "clarify"]);
    return now(w, s.id);
  }

  test("a restart that lost its flow runs clarify again, not scout", async () => {
    const w = world();
    const s = await secondClarify(w);
    const r = world();
    r.workflows.set("scout", SCOUT);
    r.store.records = w.store.records;
    r.store.inputs = w.store.inputs;
    r.seeds.files = w.seeds.files;
    for (const p of w.seeds.files.keys()) r.repos.add(p.replace("/root/", ""));
    // r.flows starts empty: the second clarify's flow did not come back
    await r.inc.restore();
    await r.inc.idle();
    expect(r.flows.started.map((x) => x.workflow.name)).toEqual(["clarify"]);
    expect(now(r, s.id).status).toBe("clarifying");
  });

  test("a resume after it failed runs clarify again, not scout", async () => {
    const w = world();
    w.workflows.set("scout", SCOUT);
    const s = await secondClarify(w);
    w.flows.move(s.flows[1]?.flowId ?? "", { status: "failed", error: "x" });
    await w.inc.idle();
    expect(now(w, s.id).status).toBe("parked");
    await w.inc.resume(s.id, "retry");
    await w.inc.idle();
    expect(w.flows.started.map((x) => x.workflow.name)).toEqual(["clarify", "clarify", "clarify"]);
  });
});

describe("a stop is never undone", () => {
  /** a seed whose commit lets a stop land while it runs */
  function stopOnCommit(w: World, id: () => string): void {
    const commit = w.seeds.commit.bind(w.seeds);
    w.seeds.commit = async (path, rels, message) => {
      await w.inc.stop(id());
      return commit(path, rels, message);
    };
  }

  test("a stop while the answers are committed", async () => {
    const w = world();
    w.workflows.set("scout", SCOUT);
    const s = await w.inc.create(intake({ text: "x" }));
    await w.inc.idle();
    await w.seeds.write(s.seedPath, ".canopy/questions.json", JSON.stringify([{ question: "Q?" }]));
    w.flows.move(s.flows[0]?.flowId ?? "", { status: "done" });
    await w.inc.idle();
    stopOnCommit(w, () => s.id);
    const after = await w.inc.answer(s.id, { "Q?": "yes" });
    await w.inc.idle();
    expect(after.status).toBe("stopped");
    expect(now(w, s.id).status).toBe("stopped");
    expect(w.flows.started).toHaveLength(1);
  });

  test("a stop while clarify's files are committed, with or without questions", async () => {
    for (const questions of ["[]", JSON.stringify([{ question: "Q?" }])]) {
      const w = world();
      w.workflows.set("scout", SCOUT);
      const s = await w.inc.create(intake({ text: "x" }));
      await w.inc.idle();
      await w.seeds.write(s.seedPath, ".canopy/questions.json", questions);
      stopOnCommit(w, () => s.id);
      w.flows.move(s.flows[0]?.flowId ?? "", { status: "done" });
      await w.inc.idle();
      expect(now(w, s.id).status).toBe("stopped");
      expect(now(w, s.id).questions).toBeUndefined();
      expect(w.flows.started).toHaveLength(1);
    }
  });
});
