/**
 * The voice conversation's pure half: the mic's samples into 24 kHz PCM
 * and base64, the answer's audio back out, the realtime events into the
 * lines the panel shows, and the model's tool calls answered from what the
 * page already holds. The browser half (mic, speaker, socket) is
 * voicecall.ts.
 */
import type { Ask, Job, Repo, Run } from "../../src/core/types";
import { VOICE_VIEWS, isVoiceTool, type VoiceContext, type VoiceView } from "../../src/core/voicewire";
import { voiceChat } from "./voicecontext";

/** Linear resampling that carries its place across chunks, so a stream cut
 *  into 128-sample blocks comes out as one continuous signal. */
export class Resampler {
  private t = 0;
  private prev = 0;
  constructor(
    readonly from: number,
    readonly to: number,
  ) {}

  push(input: Float32Array): Float32Array {
    if (this.from === this.to) return input.slice();
    const step = this.from / this.to;
    // the previous chunk's last sample sits at index 0, so a step can land between chunks
    const at = (i: number): number => (i === 0 ? this.prev : (input[i - 1] ?? 0));
    const last = input.length;
    const out: number[] = [];
    let t = this.t;
    while (t < last) {
      const i = Math.floor(t);
      const f = t - i;
      out.push(at(i) * (1 - f) + at(i + 1) * f);
      t += step;
    }
    this.t = t - last;
    if (last > 0) this.prev = input[last - 1] ?? 0;
    return Float32Array.from(out);
  }
}

/** samples in [-1, 1] as 16-bit little-endian PCM */
export function toPcm16(samples: Float32Array): Uint8Array {
  const out = new Uint8Array(samples.length * 2);
  const view = new DataView(out.buffer);
  samples.forEach((s, i) => {
    const c = Math.max(-1, Math.min(1, s));
    view.setInt16(i * 2, c < 0 ? c * 0x8000 : c * 0x7fff, true);
  });
  return out;
}

export function fromPcm16(bytes: Uint8Array): Float32Array {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = new Float32Array(Math.floor(bytes.byteLength / 2));
  for (let i = 0; i < out.length; i++) out[i] = view.getInt16(i * 2, true) / 0x8000;
  return out;
}

/** in slices, since one String.fromCharCode spread over a long buffer overflows the stack */
export function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export function fromBase64(text: string): Uint8Array {
  const s = atob(text);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

// ---- the panel's lines -----------------------------------------------------

export type VoicePhase = "connecting" | "listening" | "hearing" | "thinking" | "speaking" | "ended";

export interface VoiceLine {
  /** the realtime item id, or the call id for a tool line */
  id: string;
  who: "you" | "canopy" | "tool";
  text: string;
}

export interface VoiceState {
  phase: VoicePhase;
  lines: VoiceLine[];
  error: string | null;
}

export const VOICE_START: VoiceState = { phase: "connecting", lines: [], error: null };

/** the panel keeps the last few exchanges */
export const VOICE_LINES = 24;

/** one realtime server event, loosely: only the fields canopy reads */
export interface VoiceEvent {
  type: string;
  item_id?: string;
  call_id?: string;
  name?: string;
  delta?: string;
  transcript?: string;
  arguments?: string;
  error?: { message?: string };
}

const TEXT_FIELDS = ["item_id", "call_id", "name", "delta", "transcript", "arguments"] as const;

/** a socket message as an event, keeping only the string fields read here;
 *  null for anything that is not one */
export function parseVoiceEvent(text: string): VoiceEvent | null {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof v !== "object" || v === null || !("type" in v) || typeof v.type !== "string") return null;
  const e: VoiceEvent = { type: v.type };
  const fields = new Map(Object.entries(v));
  for (const k of TEXT_FIELDS) {
    const f = fields.get(k);
    if (typeof f === "string") e[k] = f;
  }
  const err = fields.get("error");
  if (typeof err === "object" && err !== null && "message" in err && typeof err.message === "string") e.error = { message: err.message };
  return e;
}

const upsert = (lines: VoiceLine[], line: VoiceLine, join: boolean): VoiceLine[] => {
  const i = lines.findIndex((l) => l.id === line.id && l.who === line.who);
  if (i < 0) return [...lines, line].slice(-VOICE_LINES);
  const next = lines.slice();
  const old = next[i];
  next[i] = { ...line, text: join && old ? old.text + line.text : line.text };
  return next;
};

/** what a tool line says while the model looks something up */
export const TOOL_WORDS: Record<string, string> = {
  overview: "looked over every repo",
  list_repos: "listed repos",
  needs_me: "checked what is waiting on you",
  list_runs: "checked the runs",
  open_repo: "opened a repo",
  open_view: "switched the view",
  end_conversation: "hung up",
  current_context: "checked the current repository and chat",
  orchestrate: "handed work to the chat",
};

export function voiceReduce(v: VoiceState, e: VoiceEvent): VoiceState {
  switch (e.type) {
    case "session.created":
      return { ...v, phase: "listening" };
    case "input_audio_buffer.speech_started":
      // a placeholder now, so what was said sits above the answer it gets
      return { ...v, phase: "hearing", lines: e.item_id ? upsert(v.lines, { id: e.item_id, who: "you", text: "" }, false) : v.lines };
    case "input_audio_buffer.speech_stopped":
      return { ...v, phase: "thinking" };
    case "conversation.item.input_audio_transcription.completed":
      return e.item_id ? { ...v, lines: upsert(v.lines, { id: e.item_id, who: "you", text: (e.transcript ?? "").trim() }, false) } : v;
    case "response.created":
      return { ...v, phase: "thinking" };
    case "response.output_audio_transcript.delta":
      return e.item_id && e.delta ? { ...v, lines: upsert(v.lines, { id: e.item_id, who: "canopy", text: e.delta }, true) } : v;
    case "response.output_audio.delta":
      return v.phase === "speaking" ? v : { ...v, phase: "speaking" };
    case "response.function_call_arguments.done":
      return { ...v, lines: upsert(v.lines, { id: e.call_id ?? e.item_id ?? "", who: "tool", text: TOOL_WORDS[e.name ?? ""] ?? e.name ?? "a tool" }, false) };
    case "response.done":
      return v.phase === "thinking" || v.phase === "speaking" ? { ...v, phase: "listening" } : v;
    case "error":
      return { ...v, error: e.error?.message ?? "the voice service sent an error" };
    default:
      return v;
  }
}

// ---- tools -----------------------------------------------------------------

/** what the tools read: the page's own copy of the backends' state */
export interface VoiceWorld {
  repos: Repo[];
  asks: Ask[];
  runs: Run[];
  jobs: Job[];
  /** unix ms */
  now: number;
  context?: VoiceContext;
}

export interface VoiceActs {
  openRepo: (id: string) => void;
  openView: (view: VoiceView) => void;
  /** after the goodbye in flight has played */
  hangUp: () => void;
  orchestrate?: (context: VoiceContext, prompt: string) => Promise<void>;
}

const LIST_CAP = 15;

/** lower case, letters and digits only, so "arch sketch" finds ArchiSketch */
export const squash = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, "");

const ago = (now: number, ms: number): string => {
  const min = Math.max(0, Math.round((now - ms) / 60_000));
  if (min < 60) return `${min} minutes`;
  const h = Math.round(min / 60);
  return h < 48 ? `${h} hours` : `${Math.round(h / 24)} days`;
};

const live = (world: VoiceWorld): Repo[] => world.repos.filter((r) => !r.archived);
const changedOf = (r: Repo): number => r.status?.files.length ?? 0;
const nameOf = (world: VoiceWorld, repoId: string): string => world.repos.find((r) => r.id === repoId)?.name ?? repoId.split("/").pop() ?? repoId;

function args(raw: string): Record<string, unknown> {
  try {
    const v: unknown = JSON.parse(raw || "{}");
    return typeof v === "object" && v !== null && !Array.isArray(v) ? Object.fromEntries(Object.entries(v)) : {};
  } catch {
    return {};
  }
}

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

/** Edit distance, for "did you mean" when a spoken name matches nothing. */
export function distance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let diag = row[0] ?? 0;
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const up = row[j] ?? 0;
      row[j] = Math.min(up + 1, (row[j - 1] ?? 0) + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = up;
    }
  }
  return row[b.length] ?? 0;
}

export interface RepoMatch {
  /** exact and within are sure enough to act on; near is only a guess */
  how: "exact" | "within" | "near" | "none";
  repos: Repo[];
}

/** The repos a spoken name means: an exact name first, then a name that
 *  holds it (or that it holds), then the nearest names a letter or so off
 *  ("arch sketch" for ArchiSketch). */
export function matchRepos(repos: Repo[], said: string): RepoMatch {
  const s = squash(said);
  if (!s) return { how: "none", repos: [] };
  const exact = repos.filter((r) => squash(r.name) === s);
  if (exact.length) return { how: "exact", repos: exact };
  const located = repos.filter((r) => squash(r.id) === s || squash(r.path) === s || (s.length > squash(r.name).length && squash(r.path).endsWith(s)));
  if (located.length) return { how: "exact", repos: located };
  const within = repos.filter((r) => {
    const n = squash(r.name);
    return n.includes(s) || (n.length >= 3 && s.includes(n));
  });
  if (within.length) return { how: "within", repos: within };
  const off = Math.max(1, Math.floor(s.length / 5));
  const near = repos.map((r) => ({ r, d: distance(s, squash(r.name)) })).filter((x) => x.d <= off);
  const best = Math.min(...near.map((x) => x.d));
  const hits = near.filter((x) => x.d === best).map((x) => x.r);
  return { how: hits.length ? "near" : "none", repos: hits };
}

export function runVoiceTool(name: string, raw: string, world: VoiceWorld, acts: VoiceActs): unknown {
  if (!isVoiceTool(name)) return { error: `there is no tool named ${name}` };
  const a = args(raw);
  const repos = live(world);
  const openAsks = world.asks.filter((x) => x.state === "open");
  const waiting = world.runs.filter((r) => r.status === "waiting");
  const working = world.runs.filter((r) => r.status === "working");
  switch (name) {
    case "current_context": {
      const context = world.context ?? { kind: "global", view: "git" };
      if (context.kind === "global") return context;
      const repo = world.repos.find((r) => r.id === context.repo.id);
      const git = repo?.status ? { branch: repo.status.branch, ahead: repo.status.ahead, behind: repo.status.behind, changed_files: changedOf(repo) } : null;
      if (context.kind === "repo") return {
        ...context, git,
        runs: world.runs.filter((r) => r.repoId === context.repo.id).slice(-LIST_CAP).map((r) => ({ id: r.id, doing: r.verb, status: r.status, ...(r.error ? { error: r.error } : {}) })),
      };
      const run = world.runs.find((r) => r.id === context.chat.id && r.repoId === context.repo.id);
      return run ? { ...context, git, chat: voiceChat(run), ...(run.error ? { error: run.error } : {}) } : { ...context, error: "The invoked chat is no longer available" };
    }
    case "orchestrate": {
      const prompt = str(a["prompt"]);
      if (!prompt || prompt.length > 8000) return { accepted: false, error: "A work request of 1 to 8000 characters is required" };
      let context: VoiceContext = world.context ?? { kind: "global", view: "git" };
      const named = str(a["name"]);
      if (named) {
        const m = matchRepos(repos, named);
        const first = m.repos[0];
        if (!first || m.repos.length !== 1 || m.how === "near") return { accepted: false, ask_the_user_first: true, which_one: m.repos.map((r) => r.path).slice(0, 5) };
        // Naming the invocation repo still continues its exact chat.
        if (context.kind === "global" || context.repo.id !== first.id) context = { kind: "repo", view: context.view, repo: { id: first.id, name: first.name, path: first.path } };
      }
      if (context.kind === "global") return { accepted: false, ask_the_user_first: true, error: "Which repository should handle this work?" };
      if (!acts.orchestrate) return { accepted: false, error: "Chat orchestration is unavailable" };
      const target = context;
      return acts.orchestrate(target, prompt).then(
        () => ({ accepted: true, repo: target.repo.name, ...(target.kind === "chat" ? { chat_id: target.chat.id } : {}), status: "handed to the chat; check progress before claiming completion" }),
        (e: unknown) => ({ accepted: false, error: e instanceof Error ? e.message : String(e) }),
      );
    }
    case "overview":
      return {
        repos: repos.length,
        with_changes: repos.filter((r) => changedOf(r) > 0).length,
        ahead: repos.filter((r) => (r.status?.ahead ?? 0) > 0).length,
        behind: repos.filter((r) => (r.status?.behind ?? 0) > 0).length,
        asks_waiting: openAsks.length,
        runs_waiting: waiting.length,
        runs_working: working.length,
        jobs_working: world.jobs.filter((j) => j.status === "working").length,
      };
    case "list_repos": {
      const only = str(a["only"]) ?? "changed";
      const part = str(a["name"]);
      const named = part ? new Set(matchRepos(repos, part).repos) : null;
      const picked = repos
        .filter((r) => {
          if (named && !named.has(r)) return false;
          if (only === "changed") return changedOf(r) > 0;
          if (only === "ahead") return (r.status?.ahead ?? 0) > 0;
          if (only === "behind") return (r.status?.behind ?? 0) > 0;
          return true;
        })
        .sort((x, y) => changedOf(y) - changedOf(x) || (y.status?.ahead ?? 0) + (y.status?.behind ?? 0) - ((x.status?.ahead ?? 0) + (x.status?.behind ?? 0)) || x.name.localeCompare(y.name));
      return {
        total: picked.length,
        repos: picked.slice(0, LIST_CAP).map((r) => ({
          name: r.name,
          branch: r.status?.branch ?? null,
          changed_files: changedOf(r),
          ahead: r.status?.ahead ?? 0,
          behind: r.status?.behind ?? 0,
          last_commit: r.status?.lastCommit ? { subject: r.status.lastCommit.subject, ago: ago(world.now, r.status.lastCommit.at * 1000) } : null,
          ...(r.error ? { error: r.error } : {}),
        })),
      };
    }
    case "needs_me":
      return {
        asks: openAsks.slice(0, LIST_CAP).map((x) => ({ kind: x.kind, title: x.title, from: x.agent })),
        waiting_runs: waiting.slice(0, LIST_CAP).map((r) => ({ repo: nameOf(world, r.repoId), doing: r.verb, waiting_for: r.prompt?.kind ?? "an answer" })),
      };
    case "list_runs": {
      const activeOnly = a["active_only"] !== false;
      const active = (s: string) => s === "working" || s === "waiting";
      const runs = world.runs
        .filter((r) => !activeOnly || active(r.status))
        .sort((x, y) => (y.endedAt ?? y.startedAt) - (x.endedAt ?? x.startedAt))
        .slice(0, LIST_CAP)
        .map((r) => ({ repo: nameOf(world, r.repoId), doing: r.verb, status: r.status, since: ago(world.now, r.endedAt ?? r.startedAt), ...(r.error ? { error: r.error } : {}) }));
      const jobs = world.jobs
        .filter((j) => !activeOnly || j.status === "working")
        .sort((x, y) => (y.endedAt ?? y.startedAt) - (x.endedAt ?? x.startedAt))
        .slice(0, LIST_CAP)
        .map((j) => ({ repo: nameOf(world, j.repoId), doing: j.title, status: j.status, since: ago(world.now, j.endedAt ?? j.startedAt) }));
      return { runs, jobs };
    }
    case "open_repo": {
      const said = str(a["name"]) ?? "";
      const m = matchRepos(repos, said);
      const names = m.repos.map((r) => m.repos.some((other) => other.id !== r.id && other.name === r.name) ? r.path : r.name);
      const first = m.repos[0];
      // opening a panel can start its shell, so a guess is put back to the
      // user rather than acted on; shared checkouts were deduplicated by the caller
      if (m.how === "near") return { opened: null, did_you_mean: names.slice(0, 3), ask_the_user_first: true };
      if (m.repos.length === 1 && first) {
        acts.openRepo(first.id);
        return { opened: first.name };
      }
      if (names.length > 1) return { opened: null, which_one: names.slice(0, 5) };
      const close = repos
        .map((r) => ({ name: r.name, d: distance(squash(said), squash(r.name)) }))
        .sort((x, y) => x.d - y.d)
        .slice(0, 3)
        .map((x) => x.name);
      return { opened: null, no_repo_named: said, closest: close };
    }
    case "open_view": {
      const view = VOICE_VIEWS.find((v) => v === a["view"]);
      if (!view) return { error: `no view named ${String(a["view"])}`, views: [...VOICE_VIEWS] };
      acts.openView(view);
      return { opened: view };
    }
    case "end_conversation":
      acts.hangUp();
      return { ok: true };
  }
}
