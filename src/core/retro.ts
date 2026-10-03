/**
 * The retro's pure parts (amendment 5 of the incubator spec): what a flow
 * leaves for it, the record its agent reads, the advice it writes back read
 * as untrusted, and the improvements list that advice folds into. Nothing
 * here applies an edit: advice is shown, and goes to a chat only when the
 * user accepts it. Browser-safe.
 */
import { sproutEnded, withoutSecrets } from "./sprout";
import type { Advice, AdviceEntry, AdviceOffer, Flow, FlowDigest, Improvements, InputKind, Sprout, SproutPick, SproutStatus, StepDigest } from "./types";

/** how long a park waits on the user before its retro runs */
export const RETRO_PARK_WAIT = 24 * 60 * 60 * 1000;
/** how many retros run at once; none of them holds a sprout's slot */
export const RETRO_CONCURRENCY = 1;
/** a retro cut short this many times (a restart under it) fails */
export const RETRO_TRIES = 3;
/** the parks a sprout keeps for its retro */
export const PARKS_KEPT = 20;
/** what canopy commits to the seed after a retro */
export const RETRO_FILES = [".canopy/retro.md", ".canopy/advice.json"];

export const ADVICE_MAX = 6;
export const ADVICE_FILE_MAX = 64 * 1024;
const KEY_MAX = 60;
const LESSON_MAX = 300;
export const EDIT_MAX = 4000;
const KEY_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const WORKFLOW_RE = /^[a-z0-9][a-z0-9-]{0,40}$/;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const oneLine = (s: string, max: number): string => s.replace(/\s+/g, " ").trim().slice(0, max);
/** the end of a text, where a check prints what failed */
const tail = (s: string, max: number): string => (s.length <= max ? s : `…${s.slice(s.length - max + 1)}`);

/* ---------- what a flow leaves ---------- */

export function flowDigest(f: Flow): FlowDigest {
  const steps: StepDigest[] = f.steps.map((st) => {
    const d: StepDigest = { name: st.name, status: st.status, tries: f.tries?.[st.name] ?? 0 };
    if (st.reason) d.reason = oneLine(st.reason, 300);
    if (st.check) d.check = { exit: st.check.exit, output: tail(st.check.output.trim(), 600) };
    if (st.judgment) {
      const a = st.judgment.answers;
      d.judgment = {
        fit: a.fit.choice,
        evidence: a.evidence.probability,
        rules: a.rules.probability,
        go: st.judgment.go,
        rejected: st.judgment.rejected,
        reason: st.judgment.reason === null ? null : oneLine(st.judgment.reason, 300),
      };
    }
    if (st.verdict) {
      d.verdict = { outcome: st.verdict.answers.outcome.choice, go: st.verdict.go, reason: st.verdict.reason === null ? null : oneLine(st.verdict.reason, 300) };
    }
    if (st.summary) d.summary = oneLine(st.summary, 400);
    return d;
  });
  return {
    status: f.status,
    startedAt: f.startedAt,
    ...(f.endedAt !== undefined ? { endedAt: f.endedAt } : {}),
    ...(f.error ? { error: oneLine(f.error, 300) } : {}),
    ...(f.spent ? { spent: { ...f.spent } } : {}),
    ...(f.budget ? { budget: { ...f.budget } } : {}),
    steps,
    rewinds: (f.rewinds ?? []).map((r) => ({ ...r, reason: oneLine(r.reason, 300) })),
  };
}

/* ---------- the record the retro reads ---------- */

export interface KnownAdvice {
  key: string;
  lesson: string;
  count: number;
}

export interface RetroRecord {
  about: string;
  sprout: {
    id: string;
    title: string;
    status: SproutStatus;
    parked?: string;
    pick?: SproutPick;
    privateRepo?: string;
    url?: string;
    createdAt: number;
    updatedAt: number;
    spent: { runs: number; workMs: number };
    clarifiedWithQuestions: boolean;
  };
  inputs: { n: number; kind: InputKind; summary: string; note?: string }[];
  flows: { workflow: string; outcome?: string; digest?: FlowDigest }[];
  parks: { at: number; reason: string }[];
  known: KnownAdvice[];
}

/** at most this many known keys go to the agent, the most repeated first */
const KNOWN_MAX = 40;

/** What the retro's agent reads: the sprout's facts, each input as its
 *  number, kind and summary (never its label, file or words), every flow
 *  with its digest (`now` holds digests read at retro time for flows that
 *  ended without one), every park, and the keys already on the list.
 *  Every string has any url's secret taken out. */
export function retroRecord(s: Sprout, now: ReadonlyMap<string, FlowDigest>, known: readonly KnownAdvice[]): RetroRecord {
  const rec: RetroRecord = {
    about:
      "canopy's incubator: one project's record, for its retro. Times are unix ms; spent is agent runs and working ms. Each flow is one workflow run on the seed, its steps in order.",
    sprout: {
      id: s.id,
      title: s.title,
      status: s.status,
      ...(s.parked ? { parked: oneLine(s.parked, 500) } : {}),
      ...(s.pick ? { pick: { ...s.pick } } : {}),
      ...(s.privateRepo ? { privateRepo: s.privateRepo } : {}),
      ...(s.url ? { url: s.url } : {}),
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
      spent: { ...s.spent },
      clarifiedWithQuestions: s.inputs.some((e) => e.kind === "answers"),
    },
    inputs: s.inputs.map((e) => ({ n: e.n, kind: e.kind, summary: oneLine(e.summary, 300), ...(e.note ? { note: oneLine(e.note, 300) } : {}) })),
    flows: s.flows.map((f) => {
      const digest = f.digest ?? now.get(f.flowId);
      return { workflow: f.workflow, ...(f.outcome ? { outcome: f.outcome } : {}), ...(digest ? { digest } : {}) };
    }),
    parks: (s.parks ?? []).map((p) => ({ at: p.at, reason: oneLine(p.reason, 500) })),
    known: known.slice(0, KNOWN_MAX).map((k) => ({ key: k.key, lesson: oneLine(k.lesson, LESSON_MAX), count: k.count })),
  };
  // the record is canopy's own shape, and withoutSecrets keeps it
  return withoutSecrets(rec) as RetroRecord;
}

/* ---------- the advice it writes back ---------- */

/** A workflow named by advice: `scout`, `scout.md`, `workflows/scout.md` or
 *  `lib/workflows/scout.md`, as `scout`; null for anything else, so no
 *  path reaches the accept route. */
export function adviceWorkflow(file: string): string | null {
  const m = /^(?:(?:lib\/)?workflows\/)?([a-z0-9][a-z0-9-]*)(?:\.md)?$/.exec(file.trim());
  const name = m?.[1];
  return name && WORKFLOW_RE.test(name) ? name : null;
}

export type ParsedAdvice = { ok: true; advice: Advice[] } | { ok: false; error: string };

/** `.canopy/advice.json`, read as untrusted: a list (or `{advice}`) of at
 *  most `ADVICE_MAX`; each key a slug, each lesson one line, each edit at
 *  most `EDIT_MAX`, each file a workflow's name. A repeated key and any
 *  other field are dropped. */
export function parseAdvice(text: string): ParsedAdvice {
  if (text.length > ADVICE_FILE_MAX) return { ok: false, error: `advice.json is over ${ADVICE_FILE_MAX / 1024} KB` };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, error: "advice.json is not JSON" };
  }
  const list: unknown = Array.isArray(raw) ? raw : isObj(raw) ? raw["advice"] : null;
  if (!Array.isArray(list)) return { ok: false, error: "advice.json must be a list of advice" };
  if (list.length > ADVICE_MAX) return { ok: false, error: `advice.json holds ${list.length}; at most ${ADVICE_MAX}` };
  const out: Advice[] = [];
  for (const [i, a] of (list as unknown[]).entries()) {
    const at = `advice ${i + 1}`;
    if (!isObj(a)) return { ok: false, error: `${at} is not an object` };
    const { key, lesson, file, edit } = a;
    if (typeof key !== "string" || !KEY_RE.test(key) || key.length > KEY_MAX) {
      return { ok: false, error: `${at}: key must be a slug of lowercase words and dashes, at most ${KEY_MAX}` };
    }
    if (typeof lesson !== "string" || !lesson.trim()) return { ok: false, error: `${at}: lesson must say the lesson in a sentence` };
    if (edit !== undefined && typeof edit !== "string") return { ok: false, error: `${at}: edit must be text` };
    if (typeof edit === "string" && edit.length > EDIT_MAX) return { ok: false, error: `${at}: edit is over ${EDIT_MAX} characters` };
    let name: string | null = null;
    if (file !== undefined) {
      name = typeof file === "string" ? adviceWorkflow(file) : null;
      if (!name) return { ok: false, error: `${at}: file must name a workflow, as scout or lib/workflows/scout.md` };
    }
    if (out.some((x) => x.key === key)) continue;
    out.push({ key, lesson: oneLine(lesson, LESSON_MAX), ...(name ? { file: name } : {}), ...(typeof edit === "string" && edit.trim() ? { edit } : {}) });
  }
  return { ok: true, advice: out };
}

/* ---------- the improvements list ---------- */

/** how many more sprouts bring a dismissed or accepted key back */
export const RECUR_AGAIN = 3;

const countOf = (e: AdviceEntry): number => e.from.length;
const lastAt = (e: AdviceEntry): number => e.from.reduce((m, f) => Math.max(m, f.at), 0);

/** A retro's advice folded in: a key counts each sprout once, and the
 *  newest lesson, file and edit stand. Returns a new state. */
export function foldAdvice(st: Improvements, advice: readonly Advice[], from: { id: string; title: string }, at: number): Improvements {
  const entries: Record<string, AdviceEntry> = { ...st.entries };
  for (const a of advice) {
    const had = Object.hasOwn(entries, a.key) ? entries[a.key] : undefined;
    const others = (had?.from ?? []).filter((f) => f.id !== from.id);
    // a retro that names no file or edit keeps the last one given
    const file = a.file ?? had?.file;
    const edit = a.edit ?? had?.edit;
    const next: AdviceEntry = {
      key: a.key,
      lesson: a.lesson,
      ...(file ? { file } : {}),
      ...(edit ? { edit } : {}),
      from: [...others, { id: from.id, title: from.title, at }],
      ...(had?.decided ? { decided: had.decided } : {}),
    };
    entries[a.key] = next;
  }
  return { entries };
}

const isOffered = (e: AdviceEntry): boolean => !e.decided || countOf(e) >= e.decided.count + RECUR_AGAIN;

/** the keys on offer, most repeated first, then the newest */
export function offered(st: Improvements): AdviceOffer[] {
  return Object.values(st.entries)
    .filter(isOffered)
    .sort((a, b) => countOf(b) - countOf(a) || lastAt(b) - lastAt(a) || a.key.localeCompare(b.key))
    .map((e) => ({
      key: e.key,
      lesson: e.lesson,
      ...(e.file ? { file: e.file } : {}),
      ...(e.edit ? { edit: e.edit } : {}),
      count: countOf(e),
      titles: [...e.from].sort((a, b) => b.at - a.at).slice(0, 5).map((f) => f.title),
      lastAt: lastAt(e),
    }));
}

/** the user's answer on a key, at its count now; null for a key not on the list */
export function decide(st: Improvements, key: string, accept: boolean, at: number): Improvements | null {
  const e = Object.hasOwn(st.entries, key) ? st.entries[key] : undefined;
  if (!e) return null;
  return { entries: { ...st.entries, [key]: { ...e, decided: { accept, at, count: countOf(e) } } } };
}

const ymd = (at: number): string => new Date(at).toISOString().slice(0, 10);

/** `incubator/improvements.md`: every key, most repeated first */
export function improvementsMd(st: Improvements): string {
  const all = Object.values(st.entries).sort((a, b) => countOf(b) - countOf(a) || lastAt(b) - lastAt(a) || a.key.localeCompare(b.key));
  const head = [
    "# Incubator improvements",
    "",
    "What the incubator's retros advise about its own process, folded by key. A lesson more projects hit sorts first. canopy writes this file from improvements.json; edits here are replaced.",
    "",
  ];
  if (all.length === 0) return [...head, "Nothing yet.", ""].join("\n");
  const body = all.flatMap((e) => {
    const n = countOf(e);
    const decided = e.decided ? `${e.decided.accept ? "accepted" : "dismissed"} ${ymd(e.decided.at)} at ${e.decided.count}` : "open";
    return [
      `## ${e.key}`,
      "",
      e.lesson,
      "",
      `- ${n} ${n === 1 ? "project" : "projects"}: ${e.from.map((f) => f.title).join(", ")}`,
      `- last ${ymd(lastAt(e))}; ${decided}${isOffered(e) && e.decided ? ", offered again" : ""}`,
      ...(e.file ? [`- workflow: ${e.file}`] : []),
      "",
      ...(e.edit ? ["```", e.edit.replace(/```/g, "'''"), "```", ""] : []),
    ];
  });
  return [...head, ...body].join("\n");
}

/* ---------- when a retro comes due ---------- */

/** A park waited on the user a day with nothing alive behind it, and no
 *  retro came due since it began. A park from before phase 5 has no
 *  `parkedAt` and never comes due. */
export function parkRetroDue(s: Sprout, now: number, flowLive: boolean): boolean {
  if (s.status !== "parked" || s.parkedAt === undefined || flowLive) return false;
  if (now - s.parkedAt < RETRO_PARK_WAIT) return false;
  return !s.retro || s.retro.at < s.parkedAt;
}

/** An ended sprout's retro, once: a stop right after a park retro, with no
 *  flow run since, would look back on the same record. */
export function endRetroDue(s: Sprout): boolean {
  if (!sproutEnded(s)) return false;
  const r = s.retro;
  if (!r) return true;
  if (r.for === "end") return false;
  return !(s.status === "stopped" && r.flowsSeen >= s.flows.length);
}
