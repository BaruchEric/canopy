/**
 * The incubator (docs/superpowers/specs/2026-10-01-incubator-design.md):
 * one Sprout per new project, carried from intake through clarify and on,
 * one workflow at a time through the existing Flows. It never runs an agent
 * itself. The record files, the seed, the scan, the vault and the speech
 * model are all dependencies, so the tests run it with fakes; the server
 * wires the real ones (server/incubator.ts, server/index.ts).
 */
import { join } from "node:path";
import { isVercelAppUrl } from "./deploy";
import { networkOrigin } from "./peersync";
import type { Shipper } from "./shipper";
import {
  BUILD_FILES,
  INPUT_FILE_MAX,
  INPUT_TOTAL_MAX,
  SEEDS_DIR,
  SCOUT_FILES,
  SHIP,
  SPROUT_CONCURRENCY,
  RUNNING_STATUSES,
  WORKFLOW_STATUS,
  answersText,
  briefText,
  briefTitle,
  firstLine,
  holdsSlot,
  inputKindOf,
  inputType,
  inputsIndex,
  isSproutId,
  nextWorkflow,
  parsePick,
  parseQuestions,
  phaseRefusal,
  pickRefusal,
  parseSummaries,
  safeInputName,
  sproutEnded,
  sproutSlug,
  sproutTitle,
  stageNote,
  statusFor,
  urlWithoutSecret,
  withInputsRead,
  withSummaries,
  withWorkspaceRead,
  workspaceLine,
  type ParsedQuestions,
} from "./sprout";
import { DAILY_EVENTS, dailyLine, dailyNoteHead, dailyNotePath, sproutNote, sproutNotePath, type NoteEvent } from "./sproutnote";
import { isFlowActive, type Flow, type FlowChoice, type InputEntry, type InputKind, type InputVia, type Repo, type Sprout, type SproutDetail, type SproutFlow, type Workflow } from "./types";
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
  /** an input taken back, when what it was written for failed */
  removeInput(id: string, name: string): Promise<void>;
  readInput(id: string, name: string): Promise<Uint8Array>;
  inputsDir(id: string): string;
  writeIndex(id: string, text: string): Promise<void>;
  dismiss(id: string): Promise<void>;
}

export interface IncubatorSeeds {
  /** a new seed repo with these files in its first commit; a repo url
   *  clones it. `id` is the sprout's, which keys the folder it is built in. */
  make(path: string, files: Record<string, string>, clone: string | undefined, id: string): Promise<void>;
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
  /** canopy's own deploy; null when this backend has none */
  ship?: Shipper | null;
  onChange: (s: Sprout) => void;
  onGone: (id: string) => void;
  /** false keeps every sprout queued: the server tests drive the routes with no agent */
  autostart?: boolean;
  /** Why no stage may start now (the stage runner is away, or stages are
   *  not set up to run anywhere), or null to go. While it says why, a
   *  queued sprout stays queued and holds no slot; canopy's own ship still
   *  goes. The server calls `pump` again once the runner answers. */
  isolation?: () => string | null;
  /** the reason queued sprouts wait, each time it changes (`waiting`) */
  onWaiting?: (why: string | null) => void;
  now?: () => number;
  newId?: () => string;
  log?: (line: string) => void;
}

/** what canopy commits to the seed after clarify and after answers; nothing raw */
/** a flow moved when its status or its step did: the sprout's status follows the step */
const seenKey = (f: Flow): string => `${f.status}:${f.current}`;

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
  private readonly seen = new Map<string, string>();
  /** each sprout's vault writes, one after another */
  private readonly noteChain = new Map<string, Promise<void>>();
  /** each sprout's slow work (prepare, more input), one after another, so two
   *  never transcribe the same memo or write the index over each other */
  private readonly workChain = new Map<string, Promise<void>>();
  /** how many pieces of slow work each sprout has waiting, so the queue
   *  never starts a stage on inputs that are still being read */
  private readonly busy = new Map<string, number>();
  /** background work, for `idle` */
  private readonly pending = new Set<Promise<unknown>>();
  /** slugs claimed by an intake still writing its inputs, so two at once never share a folder */
  private readonly reserved = new Set<string>();
  /** a repo url as the user gave it, token and all, kept in memory only
   *  until the clone: the record, the inputs and the vault get it without
   *  its userinfo. A restart before the clone clones the clean url. */
  private readonly cloneFrom = new Map<string, string>();
  private detached = false;
  /** why the last pump held a queued stage back, or null */
  private held: string | null = null;

  constructor(private readonly deps: IncubatorDeps) {}

  /** why queued sprouts wait for their next stage, or null when none does */
  waiting(): string | null {
    return this.held;
  }

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

  /** the sprout's slow work, after what is already waiting; the queue moves once it is done */
  private serial(s: Sprout, work: () => Promise<void>): void {
    this.busy.set(s.id, (this.busy.get(s.id) ?? 0) + 1);
    const next = (this.workChain.get(s.id) ?? Promise.resolve())
      .then(work)
      .catch((err: unknown) => this.log(`${s.slug}: ${msg(err)}`))
      .finally(() => {
        const left = (this.busy.get(s.id) ?? 1) - 1;
        if (left > 0) this.busy.set(s.id, left);
        else this.busy.delete(s.id);
        this.pump();
      });
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
  private checkIntake(intake: Intake, already: number, allowRepo: boolean): { clean: Intake; cloneFrom: string | undefined } {
    const given = intake.urls.map((u) => u.trim()).filter(Boolean);
    for (const u of given) if (!/^https?:\/\/\S+$/i.test(u)) throw new IncubatorError(400, `not a web link: ${urlWithoutSecret(u)}`);
    // a token in a link is never stored or shown
    const urls = given.map(urlWithoutSecret);
    const cloneFrom = intake.repo?.trim() || undefined;
    if (cloneFrom && !allowRepo) throw new IncubatorError(400, "a repo is given when a project starts, not later");
    if (cloneFrom && !networkOrigin(cloneFrom)) throw new IncubatorError(400, `not a git url canopy can clone: ${urlWithoutSecret(cloneFrom)}`);
    const repo = cloneFrom ? urlWithoutSecret(cloneFrom) : undefined;
    let total = already + bytesOf(intake.text);
    // a link is stored as a file of its own, so it counts like one
    for (const u of [...urls, ...(repo ? [repo] : [])]) total += bytesOf(`${u}\n`);
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
    return { clean: { text: intake.text, urls, files, ...(repo ? { repo } : {}), via: intake.via }, cloneFrom };
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
    const { clean, cloneFrom } = this.checkIntake(intake, 0, true);
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
      if (cloneFrom && cloneFrom !== clean.repo) this.cloneFrom.set(id, cloneFrom);
    } finally {
      this.reserved.delete(slug);
    }
    await this.changed(s, "started");
    this.serial(s, () => this.prepare(s));
    return s;
  }

  private need(id: string): Sprout {
    const s = isSproutId(id) ? this.sprouts.get(id) : undefined;
    if (!s) throw new IncubatorError(404, "no such project");
    return s;
  }

  async detail(id: string): Promise<SproutDetail> {
    const s = this.need(id);
    // a refused read (a planted link) shows as nothing rather than failing the sheet
    const read = (rel: string): Promise<string | null> => (s.prepared ? this.deps.seeds.read(s.seedPath, rel).catch(() => null) : Promise.resolve(null));
    const [brief, intent, research] = await Promise.all([read(".canopy/brief.md"), read(".canopy/intent.md"), read(".canopy/research.md")]);
    return { sprout: s, brief, intent, inputsIndex: inputsIndex(s.inputs), research };
  }

  /** the clarify batch answered, or skipped with null ("go on assumptions") */
  async answer(id: string, answers: Record<string, string> | null): Promise<Sprout> {
    const s = this.need(id);
    const questions = s.questions;
    if (s.status !== "clarifying" || !questions?.length) throw new IncubatorError(409, "this project has no open questions");
    const askedAt = s.questionsAt;
    // taken at once, so a second answer racing this one finds none
    delete s.questions;
    delete s.questionsAt;
    let entry: InputEntry | null = null;
    try {
      const text = answersText(questions, answers, this.now());
      const n = questions.length;
      const summary = answers ? `answered ${n} ${n === 1 ? "question" : "questions"}` : "went on assumptions";
      const intent = (await this.deps.seeds.read(s.seedPath, ".canopy/intent.md")) ?? "";
      entry = await this.addEntry(s, { kind: "answers", label: "answers", type: "text/markdown", via: "answer", summary, processed: true }, "answers.md", text);
      const index = inputsIndex(s.inputs);
      await this.deps.store.writeIndex(s.id, index);
      await this.deps.seeds.write(s.seedPath, ".canopy/inputs.md", index);
      // last, so a retry after any throw above appends the answers once
      await this.deps.seeds.write(s.seedPath, ".canopy/intent.md", intent.trim() ? `${intent.trimEnd()}\n\n${text}` : text);
    } catch (err) {
      // the answers input goes with the failed attempt, so a retry adds one, not a second
      if (entry) {
        const taken = entry;
        s.inputs = s.inputs.filter((x) => x !== taken);
        await this.deps.store.removeInput(s.id, taken.name).catch((e: unknown) => this.log(`${s.slug}: could not take back ${taken.name}: ${msg(e)}`));
      }
      // a stop that landed meanwhile keeps the questions dropped
      if (!sproutEnded(s)) {
        s.questions = questions;
        if (askedAt !== undefined) s.questionsAt = askedAt;
      }
      throw err;
    }
    // a refused commit parks the sprout, which gives its slot back
    if (!(await this.commit(s, `answers: ${s.title}`, "answers"))) return s;
    // a stop that landed while the answers were written stays a stop
    if (sproutEnded(s)) return s;
    s.status = "queued";
    await this.changed(s);
    this.pump();
    return s;
  }

  /** more inputs; after clarify has looked, clarify looks again before the next stage */
  async addInputs(id: string, intake: Intake): Promise<Sprout> {
    const s = this.need(id);
    if (sproutEnded(s)) throw new IncubatorError(409, "this project has ended; start a new one");
    // a deploy cannot take the new input in, and would go live over it
    if (s.status === "deploying") throw new IncubatorError(409, "this project is deploying; add to it once the deploy ends");
    const { clean } = this.checkIntake(intake, s.inputs.reduce((t, e) => t + e.bytes, 0), false);
    await this.takeInputs(s, clean);
    // a clarify still under way (running, waiting or parked at a gate) has
    // not read these, so another follows it whenever it ends
    const last = s.flows.at(-1);
    if (s.clarified || s.status === "clarifying" || (last?.workflow === "clarify" && !last.outcome)) this.reclarify(s);
    if (s.status === "clarifying" && s.questions) {
      delete s.questions;
      delete s.questionsAt;
      s.status = "queued";
    }
    // A sprout canopy parked, with no flow of it alive, goes back in the
    // queue so clarify reads what came in. One parked at a live gate stays
    // parked: its flow waits on the human.
    let requeued = false;
    if (s.status === "parked") {
      const f = this.currentFlow(s);
      if (!f || !isFlowActive(f)) {
        delete s.parked;
        s.status = "queued";
        requeued = true;
      }
    }
    // the sprout is busy from here, so the queue waits for the new inputs to be read
    this.serial(s, () => this.afterInputs(s));
    if (requeued && !s.prepared) this.serial(s, () => this.prepare(s));
    await this.changed(s, "input");
    return s;
  }

  private async afterInputs(s: Sprout): Promise<void> {
    // a transcript clarify has not read means it reads again
    if ((await this.transcribeAll(s)) > 0 && s.clarified) this.reclarify(s);
    const index = inputsIndex(s.inputs);
    await this.deps.store.writeIndex(s.id, index);
    if (s.prepared) {
      await this.deps.seeds.write(s.seedPath, ".canopy/inputs.md", index);
      try {
        await this.deps.seeds.commit(s.seedPath, SEED_FILES, `inputs: ${s.title}`);
      } catch (err) {
        // a stage may be running, so this parks nothing: the next stage's own commit says it
        this.log(`${s.slug}: could not commit the inputs index: ${msg(err)}`);
      }
    }
    await this.changed(s);
  }

  /** the seed's files committed as canopy; a refusal (a planted link) parks the sprout */
  private async commit(s: Sprout, message: string, what: string): Promise<boolean> {
    try {
      await this.deps.seeds.commit(s.seedPath, SEED_FILES, message);
      return true;
    } catch (err) {
      await this.park(s, `could not commit the ${what}: ${msg(err)}`);
      return false;
    }
  }

  /** A clarify that was cut short (failed, stopped, or lost in a restart)
   *  after an earlier one finished runs again: launch cleared `reclarify`
   *  when it started, and without this the queue would go on to scout with
   *  the new inputs never clarified. */
  private clarifyAgain(s: Sprout, entry: SproutFlow | undefined): void {
    if (entry?.workflow === "clarify" && s.clarified) this.reclarify(s);
  }

  private stopFlow(f: Flow): void {
    if (!isFlowActive(f)) return;
    try {
      this.deps.flows.stop(f.id);
    } catch (err) {
      this.log(`could not stop flow ${f.id}: ${msg(err)}`);
    }
  }

  async stop(id: string): Promise<Sprout> {
    const s = this.need(id);
    if (sproutEnded(s)) return s;
    // the status first, so the flow's own broadcast finds the sprout stopped
    s.status = "stopped";
    delete s.parked;
    delete s.questions;
    delete s.questionsAt;
    const cur = s.flows.at(-1);
    const f = cur ? this.deps.flows.get(cur.flowId) : undefined;
    if (f) this.stopFlow(f);
    await this.changed(s, "stopped");
    this.pump();
    return s;
  }

  /** a parked sprout goes on: its gated flow resumed, else its stage run again */
  async resume(id: string, choice: "continue" | "retry"): Promise<Sprout> {
    const s = this.need(id);
    if (s.status !== "parked") throw new IncubatorError(409, "only a parked project resumes");
    const reason = s.parked;
    // a memo the speech model failed on is tried again
    const retry = this.untranscribed(s);
    const cur = s.flows.at(-1);
    const f = cur && !cur.outcome ? this.deps.flows.get(cur.flowId) : undefined;
    if (cur && f && isFlowActive(f)) {
      // the status first, so the flow's own broadcast finds it running
      s.status = WORKFLOW_STATUS[cur.workflow] ?? "researching";
      delete s.parked;
      if (f.status === "gated") {
        try {
          this.deps.flows.resume(f.id, choice);
        } catch (err) {
          s.status = "parked";
          if (reason !== undefined) s.parked = reason;
          throw new IncubatorError(409, msg(err));
        }
      }
      if (retry > 0 && s.prepared) this.serial(s, () => this.afterInputs(s));
      // a flow still running is followed again rather than started a second time
      await this.changed(s);
      return s;
    }
    delete s.parked;
    s.status = "queued";
    this.clarifyAgain(s, cur);
    // the queue waits for a retried memo before the stage starts
    if (retry > 0 && s.prepared) this.serial(s, () => this.afterInputs(s));
    await this.changed(s);
    if (s.prepared) this.pump();
    else this.serial(s, () => this.prepare(s));
    return s;
  }

  /** the audio inputs that came out with no transcript, made ready to be
   *  tried again; how many there were */
  private untranscribed(s: Sprout): number {
    let n = 0;
    for (const e of s.inputs) {
      if (e.kind === "audio" && !e.processed && e.note?.startsWith("not transcribed")) {
        delete e.note;
        n += 1;
      }
    }
    return n;
  }

  /** an ended sprout off the list; its seed, inputs and vault note stay */
  async dismiss(id: string): Promise<void> {
    const s = this.need(id);
    if (!sproutEnded(s)) throw new IncubatorError(409, "stop the project first");
    // off the list first, so no write starts; then the writes under way finish
    // before the record moves, so none of them puts it back
    this.sprouts.delete(id);
    await Promise.all([this.noteChain.get(id), this.workChain.get(id)]);
    try {
      await this.deps.store.dismiss(id);
    } catch (err) {
      this.sprouts.set(id, s);
      throw err;
    }
    this.noteChain.delete(id);
    this.workChain.delete(id);
    this.cloneFrom.delete(id);
    for (const f of s.flows) this.seen.delete(f.flowId);
    this.deps.onGone(id);
  }

  /** The sprouts the last server left, after phase 1 restored its flows (a
   *  flow keeps its id): a stage whose flow came back is followed again, one
   *  whose flow is gone runs again, one caught before its seed was made is
   *  prepared again, and open questions wait as they were. */
  async restore(): Promise<void> {
    let records: Sprout[];
    try {
      records = await this.deps.store.list();
    } catch (err) {
      this.log(`could not read the sprout records: ${msg(err)}`);
      return;
    }
    // Every record and every flow's status is taken in before the first
    // await, so a flow broadcast that lands while restore writes is a
    // transition from what restore saw, handled once by onFlow.
    for (const s of records) this.sprouts.set(s.id, s);
    const requeued: Sprout[] = [];
    const moves: { s: Sprout; entry: SproutFlow; flow: Flow; status: Flow["status"] }[] = [];
    for (const s of records) {
      try {
        if (sproutEnded(s)) continue;
        if (!s.prepared) {
          if (s.status === "queued") this.serial(s, () => this.prepare(s));
          continue;
        }
        const entry = s.flows.at(-1);
        const flow = entry && !entry.outcome ? this.deps.flows.get(entry.flowId) : undefined;
        if (entry && flow) {
          this.seen.set(flow.id, seenKey(flow));
          const running = flow.status === "working" || flow.status === "waiting";
          // a parked sprout behind a gated flow, or a running one behind a running flow, is as it was
          const settled = s.status === "parked" ? flow.status === "gated" : RUNNING_STATUSES.has(s.status) && running;
          if (!settled) moves.push({ s, entry, flow, status: flow.status });
          continue;
        }
        // a stage in progress with no flow left to follow (or whose end was
        // never taken in) runs again
        if (holdsSlot(s)) {
          s.status = "queued";
          delete s.parked;
          this.clarifyAgain(s, entry);
          requeued.push(s);
        }
      } catch (err) {
        this.log(`could not restore ${s.id}: ${msg(err)}`);
      }
    }
    for (const s of requeued) await this.changed(s);
    for (const m of moves) {
      // onFlow already took in a newer status while restore was writing
      if (this.seen.get(m.flow.id) !== seenKey(m.flow)) continue;
      await this.flowMoved(m.s, m.entry, m.flow).catch((err: unknown) => this.log(`could not restore ${m.s.id}: ${msg(err)}`));
    }
    this.pump();
  }

  /** before the server stops every flow: nothing after this is saved or acted on */
  detach(): void {
    this.detached = true;
  }

  /** every audio input not yet tried, into a transcript entry of its own;
   *  answers how many transcripts it added */
  private async transcribeAll(s: Sprout): Promise<number> {
    let added = 0;
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
      const t = await this.addEntry(
        s,
        // The words stay in the inputs folder: a transcript's words never go
        // to the vault (the spec), so the note and inputs.md say "not
        // summarized yet", the line clarify's prompt tells it to fill in
        { kind: "transcript", label: `${e.label} (transcript)`, type: "text/plain", via: e.via, summary: "", processed: true, from: e.n },
        `${base}.txt`,
        text,
      );
      e.processed = true;
      // clarify reads the transcript, never the recording, so the recording's
      // line says where its words went rather than waiting on a summary
      e.summary = `a voice memo; its words are in [${t.n}]`;
      added += 1;
    }
    return added;
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
    if (!(await step("transcribe", async () => void (await this.transcribeAll(s))))) return;
    const index = inputsIndex(s.inputs);
    if (!(await step("write the inputs index", () => this.deps.store.writeIndex(s.id, index)))) return;
    const made = await step("make the seed", async () => {
      if (this.deps.seeds.exists(s.seedPath)) return;
      const t = s.inputs.find((e) => e.kind === "text");
      const text = t ? dec.decode(await this.deps.store.readInput(s.id, t.name)) : "";
      await this.deps.seeds.make(s.seedPath, { ".canopy/brief.md": briefText(s.title, text), ".canopy/inputs.md": index }, this.cloneFrom.get(s.id) ?? s.repo, s.id);
    });
    if (!made) return;
    // the token, if there was one, is not needed again; a failed clone keeps it for the retry
    this.cloneFrom.delete(s.id);
    if (!(await step("rescan for the seed", () => this.deps.rescan()))) return;
    if (this.detached || s.status !== "queued") return;
    s.prepared = true;
    // the work chain moves the queue once this is done
    await this.changed(s);
  }

  /* ---------- stages ---------- */

  /** Starts queued, prepared sprouts, oldest first, while a slot is free.
   *  While `isolation` says why no stage may start, a sprout whose next
   *  step is a stage stays queued and claims no slot; one at canopy's own
   *  ship still goes. */
  pump(): void {
    if (this.detached || this.deps.autostart === false) return;
    const why = this.deps.isolation?.() ?? null;
    let free = SPROUT_CONCURRENCY - this.list().filter((s) => holdsSlot(s, this.currentFlow(s)?.status)).length;
    const queued = this.list()
      .filter((s) => s.status === "queued" && s.prepared && !this.busy.has(s.id))
      .sort((a, b) => a.createdAt - b.createdAt);
    // apart from the slots: a sprout bound for a stage is held for the
    // runner whether or not a slot is free for it
    const held = why !== null && queued.some((s) => nextWorkflow(s) !== SHIP) ? why : null;
    for (const s of queued) {
      if (free <= 0) break;
      const name = nextWorkflow(s);
      if (why !== null && name !== SHIP) continue;
      free -= 1;
      // the slot is claimed here, before anything awaits
      s.status = statusFor(name, undefined);
      delete s.parked;
      this.track(name === SHIP ? this.ship(s) : this.startStage(s, name));
    }
    if (held !== this.held) {
      this.held = held;
      this.deps.onWaiting?.(held);
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
    if (name === "scout") wf = withWorkspaceRead(wf, this.deps.root);
    if (this.detached || s.status === "stopped") return;
    const base = stageNote(s, this.deps.store.inputsDir(s.id));
    const note = name === "scout" ? `${base} ${workspaceLine(this.deps.root)}` : base;
    const flow = await this.deps.flows.start(repo, wf, note);
    s.flows.push({ workflow: name, flowId: flow.id });
    if (sproutEnded(s)) {
      // a stop that landed while the flow was starting ends it too
      this.stopFlow(flow);
      await this.changed(s);
      return;
    }
    if (name === "clarify") s.reclarify = false;
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
    const key = seenKey(flow);
    if (this.seen.get(flow.id) === key) return;
    this.seen.set(flow.id, key);
    const entry = s.flows.at(-1);
    // only the current stage, and only until its outcome is on record: a
    // restart that broadcasts an old, finished flow again changes nothing
    if (!entry || entry.flowId !== flow.id || entry.outcome) return;
    // out of the Flows callback before anything starts another flow
    queueMicrotask(() => this.track(this.flowMoved(s, entry, flow)));
  }

  private async flowMoved(s: Sprout, entry: SproutFlow, flow: Flow): Promise<void> {
    // an outcome on record means this flow's end was already taken in
    if (this.detached || s.status === "stopped" || entry.outcome) return;
    const step = flow.steps[flow.current];
    if (flow.status === "gated") {
      if (entry.workflow === "scout" && step?.judgment?.rejected) {
        return this.reject(s, entry, flow, step.judgment.reason ?? step.reason ?? "the judge turned the idea down");
      }
      // the flow lives on, waiting on the human: the sprout keeps its slot, so nothing is pumped
      return this.park(s, `${entry.workflow} waits${step ? ` after ${step.name}` : ""}: ${step?.reason ?? "a gate"}`, false);
    }
    if (flow.status === "working" || flow.status === "waiting") {
      // back from a park, or on to the next step: the status follows the step in progress
      const want = statusFor(entry.workflow, step?.name);
      if (s.status !== "parked" && (s.status === want || !RUNNING_STATUSES.has(s.status))) return;
      s.status = want;
      delete s.parked;
      await this.changed(s);
      return;
    }
    entry.outcome = flow.status;
    s.spent = { runs: s.spent.runs + (flow.spent?.runs ?? 0), workMs: s.spent.workMs + (flow.spent?.workMs ?? 0) };
    if (flow.status !== "done") return this.park(s, `${entry.workflow} ${flow.status}${flow.error ? `: ${flow.error}` : ""}`);
    try {
      if (entry.workflow === "clarify") await this.clarified(s);
      else if (entry.workflow === "scout") await this.scouted(s);
      else if (entry.workflow === "build-new") await this.built(s);
      else await this.park(s, `nothing follows ${entry.workflow} yet`);
    } catch (err) {
      await this.park(s, `could not read what ${entry.workflow} wrote: ${msg(err)}`);
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
    // a stop that landed while clarify's files were read and committed stays a stop
    if (sproutEnded(s)) return;
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

  /** scout finished: its pick, read as untrusted and held to the limits in code */
  private async scouted(s: Sprout): Promise<void> {
    const raw = await this.deps.seeds.read(s.seedPath, ".canopy/pick.json");
    if (raw === null) return this.park(s, "scout ended without a .canopy/pick.json");
    const parsed = parsePick(raw);
    if (!parsed.ok) return this.park(s, `scout wrote a pick canopy cannot read: ${parsed.error}`);
    try {
      await this.deps.seeds.commit(s.seedPath, [...SEED_FILES, ...SCOUT_FILES], `scout: ${s.title}`);
    } catch (err) {
      return this.park(s, `could not commit scout's files: ${msg(err)}`);
    }
    const refused = pickRefusal(parsed.pick) ?? phaseRefusal(parsed.pick);
    if (refused) return this.park(s, refused);
    if (sproutEnded(s)) return;
    // input that came while scout ran: clarify reads it, and scout picks again
    if (!s.reclarify) s.pick = parsed.pick;
    s.status = "queued";
    await this.changed(s);
    this.pump();
  }

  /** build-new finished: its notes committed, then canopy's own ship */
  private async built(s: Sprout): Promise<void> {
    try {
      await this.deps.seeds.commit(s.seedPath, BUILD_FILES, `build: ${s.title}`);
    } catch (err) {
      return this.park(s, `could not commit the build's notes: ${msg(err)}`);
    }
    if (sproutEnded(s)) return;
    s.status = "queued";
    await this.changed(s);
    this.pump();
  }

  /** the judge turned the idea down at eval: an end, not a park */
  private async reject(s: Sprout, entry: SproutFlow, flow: Flow, reason: string): Promise<void> {
    entry.outcome = "rejected";
    s.spent = { runs: s.spent.runs + (flow.spent?.runs ?? 0), workMs: s.spent.workMs + (flow.spent?.workMs ?? 0) };
    s.status = "rejected";
    s.parked = reason;
    this.stopFlow(flow);
    await this.changed(s, "rejected");
    this.pump();
  }

  /** canopy's own deploy, after build-new: never an agent's step. Each
   *  thing made is put on record as soon as it exists, so a resume or a
   *  restart makes nothing twice. A stop that lands mid-deploy cannot halt
   *  vercel, but the sprout stays stopped. */
  private async ship(s: Sprout): Promise<void> {
    const ship = this.deps.ship ?? null;
    if (!s.pick) return this.park(s, "nothing was picked to deploy");
    if (!ship) return this.park(s, "this backend has no deploy set up");
    const ready = ship.ready(s.pick.host);
    if (ready) return this.park(s, ready);
    try {
      if (!s.privateRepo) {
        s.privateRepo = await ship.createRepo(s.slug, s.title);
        await this.changed(s);
      }
      if (!s.vercelProject) {
        s.vercelProject = await ship.project(s.slug, s.seedPath);
        await this.changed(s);
      }
      if (sproutEnded(s)) return;
      await ship.push(s.seedPath, s.privateRepo);
      if (sproutEnded(s)) return;
      const url = await ship.deploy(s.seedPath, s.vercelProject);
      if (sproutEnded(s)) return;
      if (!isVercelAppUrl(url)) return this.park(s, `the deploy answered ${url}, which is not a vercel.app address`);
      s.url = url;
      s.status = "live";
      delete s.parked;
      await this.changed(s, "live");
      this.pump();
    } catch (err) {
      await this.park(s, `deploy: ${msg(err)}`);
    }
  }

  /** new input means clarify reads again, and a pick made before it no longer stands */
  private reclarify(s: Sprout): void {
    s.reclarify = true;
    delete s.pick;
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

  /** off the list: dismissed, so nothing writes its record again */
  private gone(s: Sprout): boolean {
    return this.sprouts.get(s.id) !== s;
  }

  private async changed(s: Sprout, event?: NoteEvent): Promise<void> {
    s.updatedAt = this.now();
    if (this.detached || this.gone(s)) return;
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
        if (!this.detached && !this.gone(s)) await this.deps.store.save(s);
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

