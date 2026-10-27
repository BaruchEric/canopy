/** Local run transcripts: <runs>/<id>/{wire.jsonl,wire.jsonl.gz,run.json}
 *  and an atomic index.json. Canopy adds start/in/cut/end lines. Bun-only;
 *  the UI never imports this file. Payload redaction is core/redact.ts's. */
import { chmodSync, closeSync, constants, fchmodSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Applied } from "./applied";
import type { WireDir } from "./driver";
import { PRIVATE_ENV, TRIGGER_ENV_PREFIX } from "./envnames";
import { redactArgv, redactLine, secretValues, type Secret } from "./redact";
import { configDir } from "./store";
import { AGENT_EFFORTS, type Harness, type KeptRunHead, type Run, type RunBranch, type RunStep } from "./types";

export const RUN_LOG_MAX = 50 * 1024 * 1024;
export const WIRE = "wire.jsonl";
export const WIRE_GZ = "wire.jsonl.gz";
export const RUN_FILE = "run.json";
export const INDEX = "index.json";
const REJECTED = ".privacy-rejected";
export const RUN_ID = /^[A-Za-z0-9_-]{1,64}$/;
export const runsDir = (): string => join(configDir(), "runs");
type Terminal = KeptRunHead["status"];
export type CanopyLine =
  | { canopy: "start"; at: number; run: string; repo: string; action: string; harness: Harness; argv: string[] }
  | { canopy: "in"; at: number; line: string }
  | { canopy: "cut"; at: number; bytes: number }
  | { canopy: "end"; at: number; status: Terminal; error?: string };

/** Routing/schema facts may coincide with ordinary CANOPY context values.
 *  Private/applied credentials and caller tokens never receive that exemption. */
export interface RunLogPrivacy {
  secrets: readonly Secret[];
  credentials: readonly Secret[];
}
export interface RunLogInit {
  dir: string;
  run: Pick<Run, "id" | "repoId" | "action" | "harness">;
  argv: readonly string[];
  secrets: readonly Secret[];
  credentials?: readonly Secret[];
  onError: (why: string) => void;
  now?: () => number;
  max?: number;
}
export interface RunLogger {
  open(run: Run, argv: readonly string[], env: Readonly<Record<string, string>>, onError: (why: string) => void): RunLog | null;
}
const record = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const text = (v: unknown): v is string => typeof v === "string";
const number = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const boolean = (v: unknown): v is boolean => typeof v === "boolean";
const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every(text);
const oneOf = (v: unknown, values: readonly string[]): boolean => text(v) && values.includes(v);
const optional = (v: Record<string, unknown>, key: string, check: (x: unknown) => boolean): boolean => v[key] === undefined || check(v[key]);
const strFields = (v: Record<string, unknown>, keys: readonly string[]): boolean => keys.every((key) => text(v[key]));
const optStrFields = (v: Record<string, unknown>, keys: readonly string[]): boolean => keys.every((key) => optional(v, key, text));
const terminal = (v: unknown): v is Terminal => v === "done" || v === "failed" || v === "stopped" || v === "limited";
const harness = (v: unknown): v is Harness => v === "claude" || v === "codex";
const errText = (e: unknown): string => e instanceof Error ? e.message : String(e);

function isBranch(v: unknown): v is RunBranch {
  return record(v) && strFields(v, ["name", "target", "base", "dir", "origin"]) && oneOf(v["state"], ["working", "ready", "uncommitted", "nothing", "stopped"]) &&
    optStrFields(v, ["work", "group"]) && optional(v, "openPr", (x) => x === true) && optional(v, "held", (x) => x === true);
}
function isStep(v: unknown): v is RunStep {
  return record(v) && text(v["id"]) && number(v["at"]) && oneOf(v["kind"], ["text", "tool", "note", "user"]) && optStrFields(v, ["text", "parent"]) &&
    optional(v, "tool", (x) => record(x) && strFields(x, ["name", "title"]) && oneOf(x["status"], ["running", "ok", "error"]) && optional(x, "output", text) && optional(x, "paths", strings) && optional(x, "touchesUnknown", (b) => b === true));
}
function isPrompt(v: unknown): boolean {
  if (v === null) return true;
  if (!record(v) || !text(v["id"])) return false;
  switch (v["kind"]) {
    case "permission": return strFields(v, ["tool", "title", "detail"]) && optStrFields(v, ["description", "command", "cwd", "noRule"]) && optional(v, "paths", strings);
    case "proposal": return text(v["plan"]) && boolean(v["auto"]);
    case "question": return Array.isArray(v["questions"]) && v["questions"].every((q: unknown) => record(q) && strFields(q, ["question", "header"]) && boolean(q["multiSelect"]) && Array.isArray(q["options"]) && q["options"].every((o: unknown) => record(o) && strFields(o, ["label", "description"])));
    default: return false;
  }
}
function isRun(v: unknown): v is Run {
  if (!record(v) || !strFields(v, ["id", "repoId", "action", "verb", "progress", "note"]) || !harness(v["harness"]) || !terminal(v["status"]) ||
    !boolean(v["expectsChange"]) || !boolean(v["chat"]) || !number(v["startedAt"]) || !optional(v, "endedAt", number) || !Array.isArray(v["steps"]) || !v["steps"].every(isStep) || !isPrompt(v["prompt"])) return false;
  return optStrFields(v, ["session", "by", "workspace", "proposal", "error", "awayWhy", "parent"]) && optional(v, "kept", (x) => x === true) && optional(v, "away", boolean) &&
    optional(v, "outcome", (x) => x === "changed" || x === "unchanged") && optional(v, "proposalState", (x) => oneOf(x, ["waiting", "approved", "approved-auto", "sent back", "turned down"])) &&
    optional(v, "branch", isBranch) && optional(v, "limited", (x) => record(x) && number(x["at"]) && text(x["text"])) &&
    optional(v, "flowStep", (x) => record(x) && strFields(x, ["workflow", "step"]) && oneOf(x["source"], ["bundled", "user", "repo"])) &&
    optional(v, "agentSettings", (x) => record(x) && harness(x["harness"]) && text(x["model"]) && oneOf(x["effort"], AGENT_EFFORTS) && optional(x, "provider", text)) &&
    optional(v, "todos", (x) => Array.isArray(x) && x.every((t: unknown) => record(t) && strFields(t, ["id", "subject"]) && oneOf(t["status"], ["pending", "in_progress", "completed"]) && optional(t, "active", text))) &&
    optional(v, "result", (x) => record(x) && text(x["text"]) && number(x["durationMs"]) && number(x["turns"]) && optional(x, "costUsd", number) && optStrFields(x, ["model", "provider"]) && optional(x, "tokens", (t) => record(t) && ["input", "cachedInput", "output", "reasoning", "total"].every((key) => number(t[key])))) &&
    optional(v, "tasks", (x) => Array.isArray(x) && x.every((t: unknown) => record(t) && strFields(t, ["id", "title", "repo", "note"]) && oneOf(t["action"], ["propose", "ask"]) && oneOf(t["state"], ["proposed", "queued", "running", "done", "failed", "dropped"]) && optStrFields(t, ["run", "work", "outcome"])));
}

function credentialName(name: string): boolean {
  return PRIVATE_ENV.some((n) => n === name) || name === "CANOPY_TOKEN" || /(?:^|_)(?:TOKEN|KEY|SECRET|PASSWORD|CREDENTIAL|AUTH)(?:_|$)/.test(name) || name.startsWith(TRIGGER_ENV_PREFIX) || !name.startsWith("CANOPY_");
}
function privacyOf(init: Pick<RunLogInit, "secrets" | "credentials">): RunLogPrivacy {
  return { secrets: init.secrets, credentials: init.credentials ?? init.secrets.filter((s) => credentialName(s.name)) };
}
class CredentialCollision extends Error {
  constructor() { super("credential collides with required transcript metadata"); }
}
function trusted<T extends string | number | boolean | null>(value: T, privacy: RunLogPrivacy): T {
  const source = String(value);
  if (redactLine(source, privacy.credentials).count > 0) throw new CredentialCollision();
  return value;
}
/** Every arbitrary protocol scalar and dynamic key passes redaction. */
function payload(v: unknown, privacy: RunLogPrivacy): unknown {
  if (text(v)) return redactLine(v, privacy.secrets).line;
  if (Array.isArray(v)) return v.map((x: unknown) => payload(x, privacy));
  if (record(v)) return Object.fromEntries(Object.entries(v).map(([key, value]) => [redactLine(key, privacy.secrets).line, payload(value, privacy)]));
  if (number(v) || boolean(v) || v === null) { const redacted = redactLine(String(v), privacy.secrets); return redacted.count ? redacted.line : v; }
  return v;
}
/** Only typed schema keys and numeric, boolean or null facts enter here. */
function checkFacts(v: unknown, privacy: RunLogPrivacy): void {
  if (number(v) || boolean(v) || v === null) trusted(v, privacy);
  else if (Array.isArray(v)) v.forEach((x: unknown) => checkFacts(x, privacy));
  else if (record(v)) for (const [key, value] of Object.entries(v)) { trusted(key, privacy); checkFacts(value, privacy); }
}
function snapshot(run: Run, privacy: RunLogPrivacy): Run {
  const r = (s: string): string => redactLine(s, privacy.secrets).line;
  const t = <T extends string>(s: T): T => trusted(s, privacy);
  const safe: Run = {
    id: t(run.id), repoId: t(run.repoId), action: r(run.action), verb: r(run.verb), progress: r(run.progress),
    expectsChange: run.expectsChange, chat: run.chat, harness: t(run.harness), note: r(run.note), status: t(run.status),
    startedAt: run.startedAt, steps: run.steps.map((step) => ({
      id: t(step.id), at: step.at, kind: t(step.kind), ...(step.text !== undefined ? { text: r(step.text) } : {}),
      ...(step.parent !== undefined ? { parent: t(step.parent) } : {}),
      ...(step.tool ? { tool: { name: r(step.tool.name), title: r(step.tool.title), status: t(step.tool.status),
        ...(step.tool.output !== undefined ? { output: r(step.tool.output) } : {}),
        ...(step.tool.paths ? { paths: step.tool.paths.map(r) } : {}), ...(step.tool.touchesUnknown ? { touchesUnknown: true } : {}),
      } } : {}),
    })), prompt: null,
  };
  const strings: (keyof Pick<Run, "session" | "by" | "workspace" | "proposal" | "error" | "awayWhy">)[] = ["session", "by", "workspace", "proposal", "error", "awayWhy"];
  for (const key of strings) { const value = run[key]; if (value !== undefined) safe[key] = r(value); }
  if (run.endedAt !== undefined) safe.endedAt = run.endedAt;
  if (run.kept) safe.kept = true;
  if (run.away !== undefined) safe.away = run.away;
  if (run.outcome) safe.outcome = t(run.outcome);
  if (run.parent) safe.parent = t(run.parent);
  if (run.proposalState) safe.proposalState = t(run.proposalState);
  if (run.agentSettings) safe.agentSettings = { harness: t(run.agentSettings.harness), model: r(run.agentSettings.model), effort: t(run.agentSettings.effort), ...(run.agentSettings.provider !== undefined ? { provider: r(run.agentSettings.provider) } : {}) };
  if (run.flowStep) safe.flowStep = { workflow: r(run.flowStep.workflow), step: r(run.flowStep.step), source: t(run.flowStep.source) };
  if (run.limited) safe.limited = { at: run.limited.at, text: r(run.limited.text) };
  if (run.branch) {
    const b = run.branch;
    safe.branch = { name: r(b.name), target: r(b.target), base: r(b.base), dir: r(b.dir), origin: t(b.origin), state: t(b.state),
      ...(b.work !== undefined ? { work: t(b.work) } : {}), ...(b.group !== undefined ? { group: t(b.group) } : {}), ...(b.openPr ? { openPr: true } : {}), ...(b.held ? { held: true } : {}),
    };
  }
  if (run.result) {
    const result = run.result;
    safe.result = { text: r(result.text), durationMs: result.durationMs, turns: result.turns,
      ...(result.costUsd !== undefined ? { costUsd: result.costUsd } : {}),
      ...(result.tokens ? { tokens: { input: result.tokens.input, cachedInput: result.tokens.cachedInput, output: result.tokens.output, reasoning: result.tokens.reasoning, total: result.tokens.total } } : {}),
      ...(result.model !== undefined ? { model: r(result.model) } : {}), ...(result.provider !== undefined ? { provider: r(result.provider) } : {}),
    };
  }
  if (run.todos) safe.todos = run.todos.map((todo) => ({ id: t(todo.id), subject: r(todo.subject), status: t(todo.status), ...(todo.active !== undefined ? { active: r(todo.active) } : {}) }));
  if (run.tasks) safe.tasks = run.tasks.map((task) => ({ id: t(task.id), title: r(task.title), repo: t(task.repo), note: r(task.note), action: t(task.action), state: t(task.state), ...(task.run ? { run: t(task.run) } : {}), ...(task.work ? { work: t(task.work) } : {}), ...(task.outcome !== undefined ? { outcome: r(task.outcome) } : {}) }));
  const prompt = run.prompt;
  if (prompt?.kind === "proposal") safe.prompt = { id: t(prompt.id), kind: t(prompt.kind), plan: r(prompt.plan), auto: prompt.auto };
  if (prompt?.kind === "permission") safe.prompt = { id: t(prompt.id), kind: t(prompt.kind), tool: r(prompt.tool), title: r(prompt.title), detail: r(prompt.detail),
    ...(prompt.description !== undefined ? { description: r(prompt.description) } : {}), ...(prompt.command !== undefined ? { command: r(prompt.command) } : {}), ...(prompt.cwd !== undefined ? { cwd: r(prompt.cwd) } : {}), ...(prompt.noRule !== undefined ? { noRule: r(prompt.noRule) } : {}), ...(prompt.paths ? { paths: prompt.paths.map(r) } : {}),
  };
  if (prompt?.kind === "question") safe.prompt = { id: t(prompt.id), kind: t(prompt.kind), questions: prompt.questions.map((q) => ({ question: r(q.question), header: r(q.header), multiSelect: q.multiSelect, options: q.options.map((o) => ({ label: r(o.label), description: r(o.description) })) })) };
  checkFacts(safe, privacy);
  if (!isRun(safe)) throw new Error("invalid run snapshot");
  return safe;
}
function wireText(line: string, privacy: RunLogPrivacy): string {
  try { const value: unknown = JSON.parse(line); return JSON.stringify(payload(value, privacy)); }
  catch { return redactLine(line, privacy.secrets).line; }
}

let temp = 0;
function directory(path: string, create = false): boolean {
  if (create) {
    if (exists(path) && !lstatSync(path).isDirectory()) throw new Error("transcript directory is not a real directory");
    mkdirSync(path, { recursive: true, mode: 0o700 });
  }
  try { return lstatSync(path).isDirectory() && !lstatSync(path).isSymbolicLink(); } catch { return false; }
}
function exists(path: string): boolean { try { lstatSync(path); return true; } catch { return false; } }
function fileFd(path: string, flags: number): number {
  const fd = openSync(path, flags | constants.O_NOFOLLOW, 0o600);
  const stat = fstatSync(fd);
  try {
    if (!stat.isFile() || stat.nlink !== 1) throw new Error("transcript file is not singly owned and regular");
    fchmodSync(fd, 0o600); return fd;
  } catch (error) { closeSync(fd); throw error; }
}
function read(path: string): string | null {
  let fd: number | undefined;
  try { fd = fileFd(path, constants.O_RDONLY); return readFileSync(fd, "utf8"); }
  catch { return null; } finally { if (fd !== undefined) closeSync(fd); }
}
function atomic(path: string, text: string): void {
  const tmp = `${path}.tmp-${process.pid}-${++temp}`;
  let fd: number | undefined;
  try {
    fd = fileFd(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL);
    fchmodSync(fd, 0o600); writeFileSync(fd, text); closeSync(fd); fd = undefined;
    if (exists(path) && !lstatSync(path).isFile()) throw new Error("transcript target is not a regular file");
    renameSync(tmp, path);
  } finally { if (fd !== undefined) closeSync(fd); rmSync(tmp, { force: true }); }
}
/** Failed disk exclusion must never reopen a record through a read path.
 *  Keep it quarantined in this process until a marker or removal succeeds. */
const quarantined = new Set<string>();
function quarantineKey(folder: string): string { try { return realpathSync(folder); } catch { return resolve(folder); } }
function rejectFolder(folder: string): void {
  const key = quarantineKey(folder);
  quarantined.add(key);
  let durable = exists(join(folder, REJECTED));
  try { atomic(join(folder, REJECTED), ""); durable = true; } catch { /* deletion is independent of marker creation */ }
  try { rmSync(folder, { recursive: true }); durable = true; } catch { /* retain quarantine if no durable marker exists */ }
  if (durable) quarantined.delete(key);
}
function rejected(folder: string): boolean {
  if (!quarantined.has(quarantineKey(folder)) && !exists(join(folder, REJECTED))) return false;
  rejectFolder(folder); // retry exclusion when the filesystem becomes writable
  return true;
}
function folders(dir: string): string[] {
  if (!directory(dir)) return [];
  return readdirSync(dir).filter((id) => RUN_ID.test(id) && directory(join(dir, id)) && !rejected(join(dir, id))).sort();
}
function parse(text: string | null): unknown { try { return text === null ? null : JSON.parse(text); } catch { return null; } }
function safeFolder(dir: string, id: string): string | null { return RUN_ID.test(id) && directory(dir) && directory(join(dir, id)) ? join(dir, id) : null; }
async function gzip(folder: string): Promise<void> {
  const source = join(folder, WIRE); const target = join(folder, WIRE_GZ); const tmp = `${target}.tmp-${process.pid}-${++temp}`;
  let input: number | undefined; let output: number | undefined;
  try {
    input = fileFd(source, constants.O_RDONLY);
    output = fileFd(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL); fchmodSync(output, 0o600);
    await Bun.write(Bun.file(output), new Response(Bun.file(input).stream().pipeThrough(new CompressionStream("gzip"))));
    closeSync(input); input = undefined; closeSync(output); output = undefined;
    if (exists(target) && !lstatSync(target).isFile()) throw new Error("transcript gzip target is not regular");
    renameSync(tmp, target); rmSync(source);
  } finally { if (input !== undefined) closeSync(input); if (output !== undefined) closeSync(output); rmSync(tmp, { force: true }); }
}
let queue: Promise<unknown> = Promise.resolve();
function serialized<T>(fn: () => Promise<T> | T): Promise<T> { const task = queue.then(fn); queue = task.catch(() => {}); return task; }

export function headOf(run: Run): KeptRunHead {
  if (!terminal(run.status)) throw new Error("a kept run must be terminal");
  return { id: run.id, repo: run.repoId, action: run.action, verb: run.verb, harness: run.harness, status: run.status, started: run.startedAt, ended: run.endedAt ?? run.startedAt, cost: run.result?.costUsd ?? null, ...(run.session ? { session: run.session } : {}), ...(run.branch ? { origin: run.branch.origin } : {}) };
}
export async function readKeptRun(dir: string, id: string): Promise<Run | null> {
  const folder = safeFolder(dir, id); if (!folder || rejected(folder)) return null;
  try { chmodSync(folder, 0o700); } catch { return null; }
  const value = parse(read(join(folder, RUN_FILE)));
  return isRun(value) && value.id === id ? { ...value, kept: true } : null;
}
async function startOf(folder: string): Promise<unknown> {
  let fd: number | undefined;
  let cancel: (() => Promise<void>) | undefined;
  try {
    const plain = exists(join(folder, WIRE));
    fd = fileFd(join(folder, plain ? WIRE : WIRE_GZ), constants.O_RDONLY);
    const stream = Bun.file(fd).stream();
    const reader = (plain ? stream : stream.pipeThrough(new DecompressionStream("gzip"))).getReader();
    cancel = () => reader.cancel();
    const decoder = new TextDecoder(); let first = "";
    while (first.length < 1024 * 1024) {
      const chunk = await reader.read();
      if (chunk.done) return parse(first + decoder.decode());
      first += decoder.decode(chunk.value, { stream: true });
      const newline = first.indexOf("\n"); if (newline !== -1) return parse(first.slice(0, newline));
    }
    return null;
  } catch { return null; } finally { await cancel?.().catch(() => {}); if (fd !== undefined) closeSync(fd); }
}
async function headOnly(folder: string, id: string): Promise<Run | null> {
  const start = await startOf(folder);
  if (!record(start) || start["canopy"] !== "start" || start["run"] !== id || !number(start["at"]) || !text(start["repo"]) || !text(start["action"]) || !harness(start["harness"])) return null;
  let ended: number;
  try { ended = lstatSync(join(folder, exists(join(folder, WIRE)) ? WIRE : WIRE_GZ)).mtimeMs; } catch { return null; }
  return { id, repoId: start["repo"], action: start["action"], verb: start["action"], progress: "", expectsChange: false, chat: false, harness: start["harness"], note: "", status: "stopped", startedAt: start["at"], endedAt: Math.max(start["at"], ended), steps: [], prompt: null };
}
async function rebuild(dir: string, strict = false): Promise<KeptRunHead[]> {
  const heads: KeptRunHead[] = [];
  for (const id of folders(dir)) { const run = await readKeptRun(dir, id) ?? await headOnly(join(dir, id), id); if (run) heads.push(headOf(run)); }
  if (directory(dir)) {
    try { chmodSync(dir, 0o700); atomic(join(dir, INDEX), JSON.stringify(heads) + "\n"); }
    catch (error) { if (strict) throw error; }
  }
  return heads;
}
export const rebuildIndex = (dir: string): Promise<KeptRunHead[]> => serialized(() => rebuild(dir));
export const listKept = (dir: string): Promise<KeptRunHead[]> => rebuildIndex(dir);
async function drop(dir: string, id: string): Promise<boolean> {
  const folder = safeFolder(dir, id); if (!folder) return false;
  rmSync(folder, { recursive: true }); return true;
}
export const dropKept = (dir: string, id: string): Promise<boolean> => serialized(async () => { const removed = await drop(dir, id); if (removed) await rebuild(dir); return removed; });
export const pruneKept = (dir: string, keepMs: number, live: ReadonlySet<string>, now = Date.now()): Promise<{ removed: string[]; kept: number }> => serialized(async () => {
  const heads = await rebuild(dir); const removed: string[] = [];
  if (Number.isFinite(keepMs) && keepMs >= 0 && Number.isFinite(now)) for (const head of heads) {
    if (now - head.ended > keepMs && !live.has(head.id) && !(head.origin && live.has(head.origin)) && await drop(dir, head.id)) removed.push(head.id);
  }
  await rebuild(dir); return { removed, kept: heads.length - removed.length };
});

export class RunLog {
  readonly folder: string;
  private fd: number | undefined;
  private bytes = 0;
  private failed = false;
  private cut = false;
  private settled: Promise<void> | undefined;
  private privacy: RunLogPrivacy;
  private now: () => number;
  constructor(private init: RunLogInit) {
    if (!RUN_ID.test(init.run.id)) throw new Error("invalid run id");
    this.privacy = privacyOf(init); this.now = init.now ?? Date.now;
    const start: CanopyLine = { canopy: "start", at: this.now(), run: trusted(init.run.id, this.privacy), repo: trusted(init.run.repoId, this.privacy), action: redactLine(init.run.action, init.secrets).line, harness: trusted(init.run.harness, this.privacy), argv: redactArgv(init.argv, init.secrets) };
    directory(init.dir, true); chmodSync(init.dir, 0o700);
    this.folder = join(init.dir, init.run.id); directory(this.folder, true); chmodSync(this.folder, 0o700);
    try {
      this.fd = fileFd(join(this.folder, WIRE), constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND); fchmodSync(this.fd, 0o600);
      this.bytes = fstatSync(this.fd).size; checkFacts(start, this.privacy); trusted(start.canopy, this.privacy); this.bounded(JSON.stringify(start));
      if (this.cut) {
        // A header too large for the wire never writes its argv. A private
        // provisional snapshot retains enough identity for restart recovery.
        const head: Run = { id: init.run.id, repoId: init.run.repoId, action: init.run.action, verb: init.run.action, harness: init.run.harness, progress: "", expectsChange: false, chat: false, note: "", status: "stopped", startedAt: start.at, steps: [], prompt: null };
        atomic(join(this.folder, RUN_FILE), JSON.stringify(snapshot(head, this.privacy)) + "\n");
      }
    } catch (error) { this.close(); this.discardCredentialCollision(error); throw error; }
  }
  private discardCredentialCollision(error: unknown): void {
    if (error instanceof CredentialCollision && safeFolder(this.init.dir, this.init.run.id)) {
      rejectFolder(this.folder);
    }
  }
  private close(): void {
    const fd = this.fd; this.fd = undefined;
    if (fd !== undefined) try { closeSync(fd); } catch { /* already gone */ }
  }
  private error(error: unknown): void {
    if (this.failed) return; this.failed = true; this.close(); this.discardCredentialCollision(error);
    try { this.init.onError(redactLine(errText(error), this.privacy.secrets).line); } catch { /* logging cannot fail the run */ }
  }
  private append(line: string): void { if (this.fd === undefined) return; const bytes = Buffer.from(line + "\n"); let offset = 0; while (offset < bytes.length) { const written = writeSync(this.fd, bytes, offset, bytes.length - offset); if (written === 0) throw new Error("transcript write made no progress"); offset += written; } this.bytes += bytes.length; }
  private bounded(line: string): void {
    if (this.bytes + Buffer.byteLength(line + "\n") <= (this.init.max ?? RUN_LOG_MAX)) { this.append(line); return; }
    const cut: CanopyLine = { canopy: "cut", at: this.now(), bytes: this.bytes };
    checkFacts(cut, this.privacy); trusted(cut.canopy, this.privacy);
    this.append(JSON.stringify(cut)); this.cut = true; this.close();
  }
  wire(dir: WireDir, line: string): void {
    if (this.failed || this.cut || this.settled) return;
    try {
      const sanitized = wireText(line, this.privacy);
      if (dir === "out") this.bounded(sanitized);
      else {
        const incoming: CanopyLine = { canopy: "in", at: this.now(), line: sanitized };
        checkFacts(incoming, this.privacy); trusted(incoming.canopy, this.privacy);
        this.bounded(JSON.stringify(incoming));
      }
    } catch (error) { this.error(error); }
  }
  settle(run: Run): Promise<void> {
    if (!this.settled) this.settled = this.finish(run).catch((error: unknown) => this.error(error));
    return this.settled;
  }
  private async finish(run: Run): Promise<void> {
    if (this.failed) return;
    const safe = snapshot(run, this.privacy);
    if (!terminal(safe.status)) throw new Error("snapshot must be terminal");
    if (safe.id !== this.init.run.id) throw new Error("snapshot run id does not match log");
    if (!this.cut) {
      const end: CanopyLine = { canopy: "end", at: this.now(), status: trusted(safe.status, this.privacy), ...(safe.error ? { error: safe.error } : {}) };
      checkFacts(end, this.privacy); trusted(end.canopy, this.privacy); this.bounded(JSON.stringify(end));
    }
    this.close();
    if (!safeFolder(this.init.dir, safe.id)) throw new Error("transcript folder disappeared");
    atomic(join(this.folder, RUN_FILE), JSON.stringify(safe) + "\n");
    await serialized(() => rebuild(this.init.dir, true)); await gzip(this.folder);
  }
}

export class DiskRunLogger implements RunLogger {
  private applied: Applied = {};
  private appliedState: "initial" | "absent" | "complete" | "unavailable" = "initial";
  private dir: string;
  private env: () => Readonly<Record<string, string | undefined>>;
  private appliedFile: string;
  constructor(private opts: { dir?: string; env?: () => Readonly<Record<string, string | undefined>>; appliedFile?: string; now?: () => number; max?: number } = {}) {
    this.dir = opts.dir ?? runsDir(); this.env = opts.env ?? (() => process.env); this.appliedFile = opts.appliedFile ?? join(configDir(), "secrets-applied.json");
  }
  async refresh(): Promise<void> { this.refreshNow(); }
  private refreshNow(): void {
    let fd: number | undefined;
    let source: string;
    try {
      fd = fileFd(this.appliedFile, constants.O_RDONLY);
      source = readFileSync(fd, "utf8");
    } catch (error) {
      const initiallyAbsent = record(error) && error["code"] === "ENOENT" && (this.appliedState === "initial" || this.appliedState === "absent");
      this.appliedState = initiallyAbsent ? "absent" : "unavailable";
      return;
    } finally { if (fd !== undefined) closeSync(fd); }
    const value = parse(source);
    if (!record(value)) { this.appliedState = "unavailable"; return; }
    const applied: [string, Record<string, string>][] = [];
    for (const [sink, entries] of Object.entries(value)) {
      if (!record(entries) || !Object.values(entries).every(text)) { this.appliedState = "unavailable"; return; }
      const stamps: [string, string][] = [];
      for (const [name, stamp] of Object.entries(entries)) if (text(stamp)) stamps.push([name, stamp]);
      applied.push([sink, Object.fromEntries(stamps)]);
    }
    // Never discard known credential names on a partial or failed read.
    this.applied = Object.fromEntries(applied); this.appliedState = "complete";
  }
  /** Caller recovery must supply current secrets explicitly, never raw hints. */
  currentSecrets(env: Readonly<Record<string, string>> = {}): RunLogPrivacy {
    this.refreshNow();
    if (this.appliedState === "unavailable") throw new Error("applied secret names unavailable; transcript disabled");
    return this.knownSecrets(env);
  }
  private knownSecrets(env: Readonly<Record<string, string>>): RunLogPrivacy {
    const secrets = secretValues({ ...this.env(), ...env }, this.applied);
    const applied = new Set(Object.values(this.applied).flatMap(Object.keys));
    return { secrets, credentials: secrets.filter((s) => credentialName(s.name) || applied.has(s.name)) };
  }
  open(run: Run, argv: readonly string[], env: Readonly<Record<string, string>>, onError: (why: string) => void): RunLog | null {
    this.refreshNow();
    const privacy = this.knownSecrets(env);
    try {
      if (this.appliedState === "unavailable") throw new Error("applied secret names unavailable; transcript disabled");
      return new RunLog({ dir: this.dir, run, argv, ...privacy, onError, now: this.opts.now, max: this.opts.max });
    }
    catch (error) { try { onError(redactLine(errText(error), privacy.secrets).line); } catch { /* logging cannot fail the run */ } return null; }
    finally { void this.refresh(); }
  }
}

/** Recovery receives current secrets explicitly because hints are payload. */
export async function closeOpen(dir: string, hint: (id: string) => Partial<Pick<Run, "verb" | "note" | "session" | "branch">> | undefined, privacy: RunLogPrivacy, now = Date.now()): Promise<string[]> {
  if (!privacy || !Array.isArray(privacy.secrets) || !Array.isArray(privacy.credentials)) throw new Error("recovery requires current transcript secrets");
  return serialized(async () => {
    const closed: string[] = [];
    for (const id of folders(dir)) {
      const folder = join(dir, id); const path = join(folder, WIRE); const original = read(path); if (original === null) continue;
      const lines = original.split("\n").filter(Boolean); const first = parse(lines[0] ?? null);
      const existing = await readKeptRun(dir, id);
      const start = record(first) && first["canopy"] === "cut" && existing ? { canopy: "start", run: id, repo: existing.repoId, action: existing.action, harness: existing.harness, at: existing.startedAt } : first;
      if (!record(start) || start["canopy"] !== "start" || start["run"] !== id || !number(start["at"]) || !text(start["repo"]) || !text(start["action"]) || !harness(start["harness"])) continue;
      try {
        if (existing) snapshot(existing, privacy); // validate every typed routing fact before retaining it
        const ended = lines.some((line) => { const v = parse(line); return record(v) && (v["canopy"] === "end" || v["canopy"] === "cut"); });
        const hints = hint(id);
        const recovered: Run = { id, repoId: start["repo"], action: start["action"], verb: hints?.verb ?? start["action"], progress: "", expectsChange: false, chat: false, harness: start["harness"], note: hints?.note ?? "", status: "stopped", startedAt: start["at"], endedAt: now, steps: [], prompt: null,
          ...(hints?.session !== undefined ? { session: hints.session } : {}), ...(hints?.branch ? { branch: hints.branch } : {}),
        };
        const recoveryPrivacy: RunLogPrivacy = { credentials: privacy.credentials, secrets: [...privacy.secrets, { name: "CANOPY_RUN", value: id }, { name: "CANOPY_REPO", value: start["repo"] }] };
        // Existing bytes already passed the old logger's boundary. Only new
        // hints and the new end marker are serialized here, avoiding a second
        // pass over generated redaction markers in an existing snapshot/wire.
        const provisional = existing && existing.endedAt === undefined;
        const safe = existing ? (provisional ? { ...existing, endedAt: now } : existing) : snapshot(recovered, recoveryPrivacy);
        if (!terminal(safe.status)) continue;
        trusted(id, privacy); trusted(safe.repoId, privacy); trusted(safe.harness, privacy); trusted(safe.status, privacy); checkFacts(safe, privacy);
        const end: CanopyLine = { canopy: "end", at: now, status: safe.status };
        checkFacts(end, privacy); trusted(end.canopy, privacy);
        if (!ended) atomic(path, original + (original.endsWith("\n") ? "" : "\n") + JSON.stringify(end) + "\n");
        if (!existing || provisional) atomic(join(folder, RUN_FILE), JSON.stringify(safe) + "\n");
        chmodSync(folder, 0o700); await gzip(folder); closed.push(id);
      } catch (error) {
        if (error instanceof CredentialCollision) {
          rejectFolder(folder);
        }
        // Other corrupt or unsafe candidates do not compromise recovery peers.
      }
    }
    await rebuild(dir); return closed;
  });
}
