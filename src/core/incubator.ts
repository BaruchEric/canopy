/**
 * The incubator (docs/superpowers/specs/2026-10-01-incubator-design.md):
 * one Sprout per new project, carried from intake through clarify and on,
 * one workflow at a time through the existing Flows. It never runs an agent
 * itself. The record files, the seed, the scan, the vault and the speech
 * model are all dependencies, so the tests run it with fakes; the server
 * wires the real ones (server/incubator.ts, server/index.ts).
 */
import { join } from "node:path";
import { networkOrigin } from "./peersync";
import {
  INPUT_FILE_MAX,
  INPUT_TOTAL_MAX,
  SEEDS_DIR,
  SPROUT_CONCURRENCY,
  WORKFLOW_STATUS,
  briefText,
  briefTitle,
  firstLine,
  holdsSlot,
  inputKindOf,
  inputType,
  inputsIndex,
  nextWorkflow,
  parseQuestions,
  parseSummaries,
  safeInputName,
  sproutEnded,
  sproutSlug,
  sproutTitle,
  stageNote,
  withInputsRead,
  withSummaries,
  type ParsedQuestions,
} from "./sprout";
import { DAILY_EVENTS, dailyLine, dailyNoteHead, dailyNotePath, sproutNote, sproutNotePath, type NoteEvent } from "./sproutnote";
import type { Flow, FlowChoice, InputEntry, InputKind, InputVia, Repo, Sprout, SproutFlow, Workflow } from "./types";
import { findWorkflow, loadWorkflows } from "./workflows";

export class IncubatorError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface IntakeFile {
  label: string;
  type: string;
  data: Uint8Array;
}

export interface Intake {
  text: string;
  urls: string[];
  files: IntakeFile[];
  /** a repo url to clone into the seed; only when a project starts */
  repo?: string;
  via: InputVia;
}

export interface IncubatorStore {
  list(): Promise<Sprout[]>;
  save(s: Sprout): Promise<void>;
  writeInput(id: string, name: string, data: Uint8Array | string): Promise<void>;
  readInput(id: string, name: string): Promise<Uint8Array>;
  inputsDir(id: string): string;
  writeIndex(id: string, text: string): Promise<void>;
  dismiss(id: string): Promise<void>;
}

export interface IncubatorSeeds {
  /** a new seed repo with these files in its first commit; a repo url clones it */
  make(path: string, files: Record<string, string>, clone: string | undefined): Promise<void>;
  /** a plain file the agent wrote, or null; throws on a symlink */
  read(path: string, rel: string): Promise<string | null>;
  write(path: string, rel: string, text: string): Promise<void>;
  /** the named files only, as canopy */
  commit(path: string, rels: string[], message: string): Promise<void>;
  exists(path: string): boolean;
}

export interface IncubatorFlows {
  start(repo: Repo, workflow: Workflow, note: string): Promise<Flow>;
  get(id: string): Flow | undefined;
  resume(id: string, choice: FlowChoice): Flow;
  stop(id: string): Flow;
}

export interface NoteSink {
  /** the whole note; answers the revision to replace next, undefined when queued */
  put(path: string, text: string, rev: string | undefined): Promise<string | undefined>;
  /** a line at the end; `head` starts a note that is not there yet */
  append(path: string, line: string, head: string): Promise<void>;
}

export type Transcriber = (data: Uint8Array, name: string, type: string) => Promise<string>;

export interface IncubatorDeps {
  /** the launch root; seeds go under `<root>/_incubator/` */
  root: string;
  store: IncubatorStore;
  seeds: IncubatorSeeds;
  flows: IncubatorFlows;
  /** a workflow by name, from the bundled and the user's own only */
  workflow: (name: string) => Promise<Workflow | undefined>;
  /** rescans the launch root, so a new seed is a repo */
  rescan: () => Promise<void>;
  /** a repo in the scan by id */
  repo: (id: string) => Repo | undefined;
  transcribe: Transcriber | null;
  notes: NoteSink | null;
  onChange: (s: Sprout) => void;
  onGone: (id: string) => void;
  /** false keeps every sprout queued: the server tests drive the routes with no agent */
  autostart?: boolean;
  now?: () => number;
  newId?: () => string;
  log?: (line: string) => void;
}

/** what canopy commits to the seed after clarify and after answers; nothing raw */
export const SEED_FILES = [".canopy/brief.md", ".canopy/intent.md", ".canopy/inputs.md"];

/** A stage's workflow by name, from the bundled and the user's own sources
 *  only: a seed's own `.canopy/workflows/` (a cloned repo could ship one
 *  whose check runs a shell command) never replaces a stage. A fake host,
 *  not a fake path, is what keeps `loadWorkflows` off the repo source. */
export const incubatorWorkflow = async (name: string): Promise<Workflow | undefined> =>
  findWorkflow(await loadWorkflows({ path: "", host: "none" }), name);

export const newSproutId = (): string => `sp_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;

const msg = (err: unknown): string => String(err instanceof Error ? err.message : err);
const enc = new TextEncoder();
const dec = new TextDecoder();
const bytesOf = (data: Uint8Array | string): number => (typeof data === "string" ? enc.encode(data).byteLength : data.byteLength);

export class Incubator {
  private readonly sprouts = new Map<string, Sprout>();
  /** each owned flow's last status, so a broadcast that changes nothing is no transition */
  private readonly seen = new Map<string, Flow["status"]>();
  /** each sprout's vault writes, one after another */
  private readonly noteChain = new Map<string, Promise<void>>();
  /** each sprout's slow work (prepare, more input), one after another, so two
   *  never transcribe the same memo or write the index over each other */
  private readonly workChain = new Map<string, Promise<void>>();
  /** background work, for `idle` */
  private readonly pending = new Set<Promise<unknown>>();
  /** slugs claimed by an intake still writing its inputs, so two at once never share a folder */
  private readonly reserved = new Set<string>();
  private detached = false;

  constructor(private readonly deps: IncubatorDeps) {}

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  private log(line: string): void {
    (this.deps.log ?? console.error)(`incubator: ${line}`);
  }

  private track(p: Promise<unknown>): void {
    const q: Promise<unknown> = p
      .catch((err: unknown) => this.log(msg(err)))
      .finally(() => {
        this.pending.delete(q);
      });
    this.pending.add(q);
  }

  private serial(s: Sprout, work: () => Promise<void>): void {
    const next = (this.workChain.get(s.id) ?? Promise.resolve()).then(work).catch((err: unknown) => this.log(`${s.slug}: ${msg(err)}`));
    this.workChain.set(s.id, next);
    this.track(next);
  }

  /** resolves once the background work started so far has settled; tests */
  async idle(): Promise<void> {
    for (let i = 0; i < 100; i++) {
      await new Promise((r) => setTimeout(r, 0));
      if (this.pending.size === 0) return;
      await Promise.all(this.pending);
    }
  }

  list(): Sprout[] {
    return [...this.sprouts.values()].sort((a, b) => b.createdAt - a.createdAt);
  }

  get(id: string): Sprout | undefined {
    return this.sprouts.get(id);
  }

  ownsFlow(flowId: string): boolean {
    return this.ownerOf(flowId) !== undefined;
  }

  private ownerOf(flowId: string): Sprout | undefined {
    for (const s of this.sprouts.values()) if (s.flows.some((f) => f.flowId === flowId)) return s;
    return undefined;
  }

  /* ---------- intake ---------- */

  /** the intake as canopy takes it: links and the repo url checked, every
   *  file's type normalized, the size caps applied on top of `already` */
  private checkIntake(intake: Intake, already: number, allowRepo: boolean): Intake {
    const urls = intake.urls.map((u) => u.trim()).filter(Boolean);
    for (const u of urls) if (!/^https?:\/\/\S+$/i.test(u)) throw new IncubatorError(400, `not a web link: ${u}`);
    const repo = intake.repo?.trim() || undefined;
    if (repo && !allowRepo) throw new IncubatorError(400, "a repo is given when a project starts, not later");
    if (repo && !networkOrigin(repo)) throw new IncubatorError(400, `not a git url canopy can clone: ${repo}`);
    let total = already + bytesOf(intake.text);
    const files: IntakeFile[] = [];
    for (const f of intake.files) {
      const type = inputType(f.type, f.label);
      if (!type) throw new IncubatorError(415, `${f.label}: canopy takes audio, images, pdf, text and markdown`);
      if (f.data.byteLength > INPUT_FILE_MAX) throw new IncubatorError(413, `${f.label} is over 25 MB`);
      if (f.data.byteLength === 0) throw new IncubatorError(400, `${f.label} is empty`);
      total += f.data.byteLength;
      files.push({ ...f, type });
    }
    if (total > INPUT_TOTAL_MAX) throw new IncubatorError(413, "a project's inputs come to over 100 MB");
    if (!intake.text.trim() && urls.length === 0 && files.length === 0 && !repo) {
      throw new IncubatorError(400, "give an idea, a link, a file or a repo");
    }
    return { text: intake.text, urls, files, ...(repo ? { repo } : {}), via: intake.via };
  }

  /** one input written under inputs/ and added to the record */
  private async addEntry(
    s: Sprout,
    e: { kind: InputKind; label: string; type: string; via: InputVia; summary: string; processed: boolean; from?: number },
    file: string,
    data: Uint8Array | string,
  ): Promise<InputEntry> {
    const n = s.inputs.reduce((m, x) => Math.max(m, x.n), 0) + 1;
    const name = safeInputName(n, file);
    const entry: InputEntry = { ...e, n, name, at: this.now(), bytes: bytesOf(data) };
    // claimed before the write awaits, so an intake running beside this one takes the next number
    s.inputs.push(entry);
    try {
      await this.deps.store.writeInput(s.id, name, data);
    } catch (err) {
      s.inputs = s.inputs.filter((x) => x !== entry);
      throw err;
    }
    return entry;
  }

  private async takeInputs(s: Sprout, intake: Intake): Promise<void> {
    const via = intake.via;
    if (intake.text.trim()) {
      await this.addEntry(s, { kind: "text", label: "text", type: "text/markdown", via, summary: firstLine(intake.text), processed: true }, "text.md", intake.text);
    }
    for (const u of intake.urls) {
      await this.addEntry(s, { kind: "url", label: u, type: "text/uri-list", via, summary: "", processed: false }, "link.url", `${u}\n`);
    }
    if (intake.repo) {
      const summary = "the repo to start from, cloned into the seed";
      await this.addEntry(s, { kind: "url", label: intake.repo, type: "text/uri-list", via, summary, processed: true }, "repo.url", `${intake.repo}\n`);
    }
    for (const f of intake.files) {
      await this.addEntry(s, { kind: inputKindOf(f.type), label: f.label, type: f.type, via, summary: "", processed: false }, f.label, f.data);
    }
  }

  async create(intake: Intake): Promise<Sprout> {
    const clean = this.checkIntake(intake, 0, true);
    const id = (this.deps.newId ?? newSproutId)();
    const repoName = clean.repo?.replace(/\.git$/, "").split(/[/:]/).pop() ?? "";
    const first = clean.text.trim() || repoName || clean.urls[0] || "";
    const taken = (slug: string) =>
      this.reserved.has(slug) || this.deps.seeds.exists(join(this.deps.root, SEEDS_DIR, slug)) || this.list().some((x) => x.slug === slug);
    // claimed before the first await, and given back once the sprout holds it or the intake failed
    const slug = sproutSlug(first, id, taken);
    this.reserved.add(slug);
    const at = this.now();
    const s: Sprout = {
      id,
      slug,
      title: sproutTitle(clean.text, clean.repo ?? clean.urls[0] ?? clean.files[0]?.label ?? ""),
      status: "queued",
      repoId: `${SEEDS_DIR}/${slug}`,
      seedPath: join(this.deps.root, SEEDS_DIR, slug),
      ...(clean.repo ? { repo: clean.repo } : {}),
      prepared: false,
      inputs: [],
      clarified: false,
      reclarify: false,
      flows: [],
      spent: { runs: 0, workMs: 0 },
      createdAt: at,
      updatedAt: at,
    };
    try {
      await this.takeInputs(s, clean);
      this.sprouts.set(id, s);
    } finally {
      this.reserved.delete(slug);
    }
    await this.changed(s, "started");
    this.serial(s, () => this.prepare(s));
    return s;
  }

  /** every audio input not yet tried, into a transcript entry of its own */
  private async transcribeAll(s: Sprout): Promise<void> {
    const todo = s.inputs.filter((e) => e.kind === "audio" && !e.processed && !e.note);
    for (const e of todo) {
      if (!this.deps.transcribe) {
        e.note = "not transcribed: this backend has no speech model set up";
        continue;
      }
      let text: string;
      try {
        text = (await this.deps.transcribe(await this.deps.store.readInput(s.id, e.name), e.label, e.type)).trim();
      } catch (err) {
        e.note = `not transcribed: ${msg(err)}`;
        continue;
      }
      if (!text) {
        e.note = "not transcribed: the speech model heard nothing";
        continue;
      }
      const base = e.name.replace(/^\d+-/, "").replace(/\.[^.]*$/, "");
      await this.addEntry(
        s,
        { kind: "transcript", label: `${e.label} (transcript)`, type: "text/plain", via: e.via, summary: firstLine(text), processed: true, from: e.n },
        `${base}.txt`,
        text,
      );
      e.processed = true;
    }
  }

  /** the slow half of intake, behind the route's answer */
  private async prepare(s: Sprout): Promise<void> {
    // each step parks with its own name, so the reason says which one failed
    const step = async (label: string, work: () => Promise<void>): Promise<boolean> => {
      try {
        await work();
        return true;
      } catch (err) {
        await this.park(s, `could not ${label}: ${msg(err)}`);
        return false;
      }
    };
    if (!(await step("transcribe", () => this.transcribeAll(s)))) return;
    const index = inputsIndex(s.inputs);
    if (!(await step("write the inputs index", () => this.deps.store.writeIndex(s.id, index)))) return;
    const made = await step("make the seed", async () => {
      if (this.deps.seeds.exists(s.seedPath)) return;
      const t = s.inputs.find((e) => e.kind === "text");
      const text = t ? dec.decode(await this.deps.store.readInput(s.id, t.name)) : "";
      await this.deps.seeds.make(s.seedPath, { ".canopy/brief.md": briefText(s.title, text), ".canopy/inputs.md": index }, s.repo);
    });
    if (!made) return;
    if (!(await step("rescan for the seed", () => this.deps.rescan()))) return;
    if (this.detached || s.status !== "queued") return;
    s.prepared = true;
    await this.changed(s);
    this.pump();
  }

  /* ---------- stages ---------- */

  /** starts queued, prepared sprouts, oldest first, while a slot is free */
  private pump(): void {
    if (this.detached || this.deps.autostart === false) return;
    let free = SPROUT_CONCURRENCY - this.list().filter((s) => holdsSlot(s, this.currentFlow(s)?.status)).length;
    const queued = this.list()
      .filter((s) => s.status === "queued" && s.prepared)
      .sort((a, b) => a.createdAt - b.createdAt);
    for (const s of queued) {
      if (free <= 0) return;
      free -= 1;
      const name = nextWorkflow(s);
      // the slot is claimed here, before anything awaits
      s.status = WORKFLOW_STATUS[name] ?? "researching";
      delete s.parked;
      this.track(this.startStage(s, name));
    }
  }

  /** the current stage's flow while its outcome is not on record */
  private currentFlow(s: Sprout): Flow | undefined {
    const entry = s.flows.at(-1);
    return entry && !entry.outcome ? this.deps.flows.get(entry.flowId) : undefined;
  }

  /** pump set the status, so this sprout holds a slot: any throw on the way
   *  parks it, which gives the slot back */
  private async startStage(s: Sprout, name: string): Promise<void> {
    try {
      await this.launch(s, name);
    } catch (err) {
      await this.park(s, `${name} did not start: ${msg(err)}`);
    }
  }

  private async launch(s: Sprout, name: string): Promise<void> {
    const repo = this.deps.repo(s.repoId);
    if (!repo) return this.park(s, "the seed folder is gone");
    let wf = await this.deps.workflow(name);
    if (!wf) return this.park(s, `the ${name} workflow is not installed`);
    if (name === "clarify") wf = withInputsRead(wf, this.deps.store.inputsDir(s.id));
    if (this.detached || s.status === "stopped") return;
    const flow = await this.deps.flows.start(repo, wf, stageNote(s, this.deps.store.inputsDir(s.id)));
    if (name === "clarify") s.reclarify = false;
    s.flows.push({ workflow: name, flowId: flow.id });
    await this.changed(s);
    // Flows may have ended the flow inside start (a runner that throws, a
    // missing harness) and broadcast it before it was ours: read it now as a
    // transition, so a flow that never ran parks the sprout and frees the slot
    this.onFlow(flow);
  }

  /** every flow broadcast; only an owned flow whose status moved is acted on */
  onFlow(flow: Flow): void {
    if (this.detached) return;
    const s = this.ownerOf(flow.id);
    if (!s) return;
    if (this.seen.get(flow.id) === flow.status) return;
    this.seen.set(flow.id, flow.status);
    const entry = s.flows.at(-1);
    // only the current stage, and only until its outcome is on record: a
    // restart that broadcasts an old, finished flow again changes nothing
    if (!entry || entry.flowId !== flow.id || entry.outcome) return;
    // out of the Flows callback before anything starts another flow
    queueMicrotask(() => this.track(this.flowMoved(s, entry, flow)));
  }

  private async flowMoved(s: Sprout, entry: SproutFlow, flow: Flow): Promise<void> {
    if (this.detached || s.status === "stopped") return;
    if (flow.status === "gated") {
      const step = flow.steps[flow.current];
      // the flow lives on, waiting on the human: the sprout keeps its slot, so nothing is pumped
      return this.park(s, `${entry.workflow} waits${step ? ` after ${step.name}` : ""}: ${step?.reason ?? "a gate"}`, false);
    }
    if (flow.status === "working" || flow.status === "waiting") {
      if (s.status !== "parked") return;
      s.status = WORKFLOW_STATUS[entry.workflow] ?? "researching";
      delete s.parked;
      await this.changed(s);
      return;
    }
    entry.outcome = flow.status;
    s.spent = { runs: s.spent.runs + (flow.spent?.runs ?? 0), workMs: s.spent.workMs + (flow.spent?.workMs ?? 0) };
    if (flow.status !== "done") return this.park(s, `${entry.workflow} ${flow.status}${flow.error ? `: ${flow.error}` : ""}`);
    if (entry.workflow !== "clarify") return this.park(s, `nothing follows ${entry.workflow} yet`);
    try {
      await this.clarified(s);
    } catch (err) {
      await this.park(s, `could not read what clarify wrote: ${msg(err)}`);
    }
  }

  /** clarify finished: its questions, its summaries, its name for the project */
  private async clarified(s: Sprout): Promise<void> {
    const raw = await this.deps.seeds.read(s.seedPath, ".canopy/questions.json");
    const parsed: ParsedQuestions = raw === null ? { ok: true, questions: [] } : parseQuestions(raw);
    if (!parsed.ok) return this.park(s, `clarify wrote a questions.json canopy cannot read: ${parsed.error}`);
    const md = await this.deps.seeds.read(s.seedPath, ".canopy/inputs.md");
    if (md !== null) s.inputs = withSummaries(s.inputs, parseSummaries(md));
    const brief = await this.deps.seeds.read(s.seedPath, ".canopy/brief.md");
    const heading = brief === null ? null : briefTitle(brief);
    if (heading) s.title = heading;
    const index = inputsIndex(s.inputs);
    await this.deps.store.writeIndex(s.id, index);
    await this.deps.seeds.write(s.seedPath, ".canopy/inputs.md", index);
    try {
      await this.deps.seeds.commit(s.seedPath, SEED_FILES, `clarify: ${s.title}`);
    } catch (err) {
      // a link planted in the seed is refused here: the stage failed, nothing goes on
      return this.park(s, `could not commit clarify's files: ${msg(err)}`);
    }
    s.clarified = true;
    if (parsed.questions.length > 0 && !s.reclarify) {
      s.questions = parsed.questions;
      s.questionsAt = this.now();
      s.status = "clarifying";
      await this.changed(s, "questions");
    } else {
      // no questions, or more input came while clarify ran: on to the next stage
      s.status = "queued";
      await this.changed(s);
    }
    this.pump();
  }

  /** `pump` false for a gate: its flow still holds the slot */
  private async park(s: Sprout, reason: string, pump = true): Promise<void> {
    if (sproutEnded(s)) return;
    s.status = "parked";
    s.parked = reason;
    await this.changed(s, "parked");
    if (pump) this.pump();
  }

  /* ---------- every change ---------- */

  private async changed(s: Sprout, event?: NoteEvent): Promise<void> {
    s.updatedAt = this.now();
    if (this.detached) return;
    try {
      await this.deps.store.save(s);
    } catch (err) {
      this.log(`could not save ${s.id}: ${msg(err)}`);
    }
    this.deps.onChange(s);
    this.note(s, event);
  }

  /** the vault note, rewritten; a daily line for a start or a park */
  private note(s: Sprout, event?: NoteEvent): void {
    const notes = this.deps.notes;
    if (!notes) return;
    const snap = structuredClone(s);
    const write = async (): Promise<void> => {
      // a refused read (a planted link) leaves intent out rather than the whole note
      const intent = snap.prepared ? await this.deps.seeds.read(snap.seedPath, ".canopy/intent.md").catch(() => null) : null;
      const rev = await notes.put(sproutNotePath(snap.slug), sproutNote(snap, intent), s.noteRev);
      if (rev && rev !== s.noteRev) {
        s.noteRev = rev;
        if (!this.detached) await this.deps.store.save(s);
      }
      if (event && DAILY_EVENTS.has(event)) {
        const day = new Date(this.now());
        await notes.append(dailyNotePath(day), dailyLine(snap, event), dailyNoteHead(day));
      }
    };
    const next = (this.noteChain.get(s.id) ?? Promise.resolve())
      .then(write)
      .catch((err: unknown) => this.log(`the vault note for ${s.slug} was not written (${msg(err)}); it is tried again at the next change`));
    this.noteChain.set(s.id, next);
    this.track(next);
  }
}

