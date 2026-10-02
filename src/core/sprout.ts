/**
 * The incubator's pure parts (spec 2026-10-01-incubator-design.md): slugs
 * and titles, what an upload is taken as, the inputs index and the
 * summaries clarify writes back into it, clarify's questions, the answers
 * as text, and which sprouts hold one of the running slots. Browser-safe:
 * the UI imports it.
 */
import { HOSTS, SPROUT_STATUSES, type FlowStatus, type InputEntry, type InputKind, type InputVia, type RunQuestion, type RunQuestionOption, type HostId, type PickKind, type Sprout, type SproutPick, type SproutStatus, type Workflow } from "./types";

/** how many sprouts run a stage at once; the rest wait their turn */
export const SPROUT_CONCURRENCY = 2;
/** one upload, and everything one sprout was given */
export const INPUT_FILE_MAX = 25 * 1024 * 1024;
export const INPUT_TOTAL_MAX = 100 * 1024 * 1024;
/** clarify asks at most this many at once */
export const QUESTIONS_MAX = 4;
/** where seeds live under the launch root */
export const SEEDS_DIR = "_incubator";

/** whether a repo id is a sprout's seed in the launch root */
export const isSeedRepoId = (id: string): boolean => id.startsWith(`${SEEDS_DIR}/`);

/** A url with no secret in it, for everything canopy stores or shows: an
 *  http(s) url loses its whole userinfo ("https://x:token@host/r" is
 *  "https://host/r"), any other scheme's keeps its user name, which ssh
 *  needs, and loses a password. A scp-like "git@host:path" has none.
 *
 *  Read by a string scan, not `new URL`: a password pasted with a raw `/`,
 *  `?` or `#` in it ends the authority early for a url parser, which would
 *  leave the rest of the password standing. So when the authority by the
 *  book has no `@` but reads as `user:password` (a colon, and not one before
 *  a port), the password runs on to the first `@` past it, and the userinfo
 *  ends at the last `@` before the host's own path. An `@` in a path or a
 *  query after a plain host, or after a host and port, is left alone. */
export function urlWithoutSecret(url: string): string {
  const m = /^[a-z][a-z0-9+.-]*:\/\//i.exec(url);
  if (!m) return url;
  const scheme = m[0];
  const after = url.slice(scheme.length);
  /** the first `/`, `?` or `#` from `from` on, or the end */
  const stop = (from: number): number => {
    for (let i = from; i < after.length; i++) if ("/?#".includes(after.charAt(i))) return i;
    return after.length;
  };
  const head = after.slice(0, stop(0));
  let at = head.lastIndexOf("@");
  if (at < 0) {
    // an IPv6 literal is a host, never a user
    if (head.startsWith("[")) return url;
    const colon = head.lastIndexOf(":");
    if (colon < 0 || /^\d*$/.test(head.slice(colon + 1))) return url;
    const past = after.indexOf("@", head.length);
    if (past < 0) return url;
    at = after.lastIndexOf("@", stop(past + 1) - 1);
  }
  const rest = after.slice(at + 1);
  if (/^https?:\/\/$/i.test(scheme)) return `${scheme}${rest}`;
  const user = after.slice(0, at).split(":")[0] ?? "";
  return `${scheme}${user ? `${user}@` : ""}${rest}`;
}

const ID = /^sp_[0-9a-f]{12}$/;
export const isSproutId = (id: string): boolean => ID.test(id);

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const oneLine = (s: string, max = 200): string => s.replace(/\s+/g, " ").trim().slice(0, max);

const STOP_WORDS = new Set(["a", "an", "the", "to", "for", "of", "and", "or", "with", "my", "i", "we", "that", "this", "it"]);
const SLUG_WORDS = 6;
const SLUG_MAX = 40;

/** A folder name from the first words of the idea; `idea-<id>` when there
 *  are none (a voice memo alone), then `-2`, `-3` while the name is taken.
 *  Fixed at intake: flows and the scan know the seed by it. */
export function sproutSlug(text: string, id: string, taken: (slug: string) => boolean): string {
  const words = text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .split(/[^a-z0-9]+/)
    .filter((w) => w && !STOP_WORDS.has(w));
  const base = words.slice(0, SLUG_WORDS).join("-").slice(0, SLUG_MAX).replace(/-+$/, "") || `idea-${id.slice(3, 9)}`;
  let slug = base;
  for (let i = 2; taken(slug); i++) slug = `${base}-${i}`;
  return slug;
}

const clip = (t: string, max: number): string => (t.length <= max ? t : `${t.slice(0, max - 1).replace(/\s+\S*$/, "")}…`);

/** the first non-empty line, heading marks dropped, up to 80 characters */
export function sproutTitle(text: string, fallback: string): string {
  const line = text
    .split("\n")
    .map((l) => l.replace(/^#+\s*/, "").trim())
    .find(Boolean);
  return clip(line || fallback.trim() || "a new project", 80);
}

/** the brief's `# ` heading, which clarify writes as the project's name */
export function briefTitle(md: string): string | null {
  const line = md.split("\n").find((l) => /^#\s+\S/.test(l));
  return line ? clip(oneLine(line.replace(/^#\s+/, "")), 80) : null;
}

export const firstLine = (text: string, max = 120): string => clip(oneLine(text.split("\n").find((l) => l.trim()) ?? "", 1000), max);

const BY_EXT: Record<string, string> = {
  md: "text/markdown",
  markdown: "text/markdown",
  txt: "text/plain",
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  heic: "image/heic",
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  mp4: "audio/mp4",
  wav: "audio/wav",
  webm: "audio/webm",
  ogg: "audio/ogg",
  oga: "audio/ogg",
  flac: "audio/flac",
};

/** The type an upload is taken as, parameters dropped: audio, an image, a
 *  pdf, text or markdown by its own type, else by its extension (a dropped
 *  `.md` often comes as "" or octet-stream); null for anything else. */
export function inputType(type: string, name: string): string | null {
  const t = (type.split(";")[0] ?? "").trim().toLowerCase();
  if (/^(audio|image)\/[a-z0-9.+-]+$/.test(t) || t === "application/pdf" || t === "text/plain" || t === "text/markdown") return t;
  const ext = /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase();
  return (ext && BY_EXT[ext]) || null;
}

export function inputKindOf(type: string): InputKind {
  if (type.startsWith("audio/")) return "audio";
  if (type.startsWith("image/")) return "image";
  return "file";
}

/** `003-voice.webm`: the order, then the name with anything but letters,
 *  digits, dot, dash and underscore made a dash; never a path */
export function safeInputName(n: number, label: string): string {
  const base = label.split(/[/\\]/).pop() ?? "";
  const clean = base.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[.-]+/, "").slice(0, 80);
  return `${String(n).padStart(3, "0")}-${clean || "input"}`;
}

const pad2 = (n: number): string => String(n).padStart(2, "0");

/** `2026-10-01 14:03`, the backend's local wall clock */
export function localStamp(at: number): string {
  const d = new Date(at);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

export function sizeWord(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

const VIA_WORD: Record<InputVia, string> = { sheet: "from the page", cli: "from the command line", answer: "an answer in the inbox" };
const NO_SUMMARY = "not summarized yet";

export const INPUTS_HEAD =
  "# Inputs\n\nEvery input given for this project, in order. The raw files stay on the canopy backend; this index and its one-line summaries are what is kept here.\n";

/** The index: one `- [n] kind name: summary` line per input (the form
 *  clarify fills in and `parseSummaries` reads back), with the details on
 *  an indented line under it. */
export function inputsIndex(entries: readonly InputEntry[]): string {
  const lines = entries.map((e) => {
    const extra = [
      sizeWord(e.bytes),
      VIA_WORD[e.via],
      localStamp(e.at),
      e.from ? `transcript of [${e.from}]` : "",
      e.kind !== "text" && e.kind !== "answers" && e.label !== e.name ? oneLine(e.label) : "",
    ]
      .filter(Boolean)
      .join(", ");
    return `- [${e.n}] ${e.kind} ${e.name}: ${oneLine(e.summary || e.note || NO_SUMMARY)}\n  ${extra}`;
  });
  return `${INPUTS_HEAD}\n${lines.join("\n")}\n`;
}

const SUMMARY_LINE = /^- \[(\d+)\] [a-z]+ [^:\n]*: (.+)$/;

/** the summaries clarify wrote into the index, by input number */
export function parseSummaries(md: string): Map<number, string> {
  const out = new Map<number, string>();
  for (const line of md.split("\n")) {
    const m = SUMMARY_LINE.exec(line.trimEnd());
    if (!m) continue;
    const summary = oneLine(m[2] ?? "");
    if (!summary || summary === NO_SUMMARY || summary.startsWith("not transcribed")) continue;
    out.set(Number(m[1]), summary);
  }
  return out;
}

/** the kinds whose summary clarify writes; text and answers carry their own */
const SUMMARIZED: ReadonlySet<InputKind> = new Set<InputKind>(["url", "image", "file", "transcript"]);

export function withSummaries(entries: readonly InputEntry[], map: ReadonlyMap<number, string>): InputEntry[] {
  return entries.map((e) => {
    const summary = map.get(e.n);
    return summary && SUMMARIZED.has(e.kind) ? { ...e, summary, processed: true } : e;
  });
}

export type ParsedQuestions = { ok: true; questions: RunQuestion[] } | { ok: false; error: string };

/** clarify's `.canopy/questions.json`: a list (or `{questions}`) of at most
 *  four, each with its options as strings or `{label, description}` */
export function parseQuestions(text: string): ParsedQuestions {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, error: "questions.json is not JSON" };
  }
  const list: unknown = Array.isArray(raw) ? raw : isObj(raw) ? raw["questions"] : null;
  if (!Array.isArray(list)) return { ok: false, error: "questions.json must be a list of questions" };
  const out: RunQuestion[] = [];
  for (const q of list as unknown[]) {
    if (!isObj(q) || typeof q["question"] !== "string" || !q["question"].trim()) {
      return { ok: false, error: "every question needs its question text" };
    }
    const question = oneLine(q["question"], 300);
    if (out.some((o) => o.question === question)) continue;
    const options: RunQuestionOption[] = [];
    const given: unknown[] = Array.isArray(q["options"]) ? (q["options"] as unknown[]) : [];
    for (const o of given.slice(0, 6)) {
      const label = typeof o === "string" ? oneLine(o, 60) : isObj(o) && typeof o["label"] === "string" ? oneLine(o["label"], 60) : "";
      if (!label || options.some((x) => x.label === label)) continue;
      const description = isObj(o) && typeof o["description"] === "string" ? oneLine(o["description"]) : "";
      options.push({ label, description });
    }
    const header = typeof q["header"] === "string" ? q["header"].trim().slice(0, 12).trim() : "";
    out.push({ question, header, options, multiSelect: q["multiSelect"] === true });
    if (out.length === QUESTIONS_MAX) break;
  }
  return { ok: true, questions: out };
}

/** the answers as they go into intent.md and the inputs: each question
 *  with its answer, or that the user went on assumptions */
export function answersText(questions: readonly RunQuestion[], answers: Readonly<Record<string, string>> | null, at: number): string {
  const head = `## Answers, ${localStamp(at)}`;
  if (!answers) return `${head}\n\nThe user chose to go on assumptions: research goes on with what this file assumes.\n`;
  // own keys only: a question called "constructor" is not the object's
  const lines = questions.map((q) => `- ${q.question}\n  ${oneLine(Object.hasOwn(answers, q.question) ? (answers[q.question] ?? "") : "", 1000) || "(no answer)"}`);
  return `${head}\n\n${lines.join("\n")}\n`;
}

/** the seed's first brief, until clarify rewrites it */
export function briefText(title: string, text: string): string {
  return `# ${title}\n\n${text.trim() || "No text was given; clarify writes the brief from the other inputs."}\n`;
}

/** the note every stage's flow starts with, which each step's prompt carries */
export function stageNote(s: Sprout, inputsDir: string): string {
  return [
    `This is the incubator project "${s.title}" (${s.id}).`,
    `The user's raw inputs are in ${inputsDir}; .canopy/inputs.md in this repo indexes them.`,
    s.repo ? `The seed is a clone of ${s.repo}; its remote is called upstream.` : "",
  ]
    .filter(Boolean)
    .join(" ");
}

/** the statuses with a stage in progress */
export const RUNNING_STATUSES: ReadonlySet<SproutStatus> = new Set<SproutStatus>([
  "clarifying",
  "researching",
  "building",
  "testing",
  "accepting",
  "deploying",
]);

/** Whether a sprout holds one of the running slots: a stage in progress,
 *  except clarify waiting on the user's answers, which frees it. A sprout
 *  parked at a gate keeps it while its flow (`current`, the status of the
 *  stage's flow) is gated and alive, so resuming that flow never makes one
 *  more than `SPROUT_CONCURRENCY` run. */
export const holdsSlot = (s: Sprout, current?: FlowStatus): boolean =>
  (RUNNING_STATUSES.has(s.status) && !(s.status === "clarifying" && s.questions?.length)) || (s.status === "parked" && current === "gated");

const ENDED: ReadonlySet<SproutStatus> = new Set<SproutStatus>(["live", "rejected", "handed-off", "stopped"]);
export const sproutEnded = (s: Sprout): boolean => ENDED.has(s.status);

/** not a workflow: the deploy canopy carries out itself after build-new */
export const SHIP = "ship";

/** the status a sprout shows while a workflow runs for it */
export const WORKFLOW_STATUS: Readonly<Record<string, SproutStatus>> = {
  clarify: "clarifying",
  scout: "researching",
  "build-new": "building",
  renovate: "building",
  extend: "building",
  [SHIP]: "deploying",
};

/** within a workflow, the status each step shows; a step not named here shows the workflow's */
export const STEP_STATUS: Readonly<Record<string, Readonly<Record<string, SproutStatus>>>> = {
  "build-new": { Scaffold: "building", Test: "testing", Accept: "accepting" },
};

export function statusFor(workflow: string, step: string | undefined): SproutStatus {
  const byStep = Object.hasOwn(STEP_STATUS, workflow) ? STEP_STATUS[workflow] : undefined;
  const own = step !== undefined && byStep && Object.hasOwn(byStep, step) ? byStep[step] : undefined;
  const wf = Object.hasOwn(WORKFLOW_STATUS, workflow) ? WORKFLOW_STATUS[workflow] : undefined;
  return own ?? wf ?? "researching";
}

/** the index of the last flow of `workflow` that finished done, or -1 */
export function lastDone(s: Sprout, workflow: string): number {
  for (let i = s.flows.length - 1; i >= 0; i--) {
    const f = s.flows[i];
    if (f && f.workflow === workflow && f.outcome === "done") return i;
  }
  return -1;
}

/** what a queued sprout runs next: clarify until it has clarified what is
 *  known now, scout until there is a pick, a build after the newest scout,
 *  then canopy's own ship */
export function nextWorkflow(s: Sprout): string {
  if (!s.clarified || s.reclarify) return "clarify";
  if (!s.pick) return "scout";
  if (lastDone(s, "build-new") < lastDone(s, "scout")) return "build-new";
  return SHIP;
}

/** what canopy commits to the seed after scout, beside SEED_FILES */
export const SCOUT_FILES = [".canopy/research.md", ".canopy/pick.json", ".canopy/eval.md"];

/** what canopy commits to the seed after build-new: the smoke and accept notes */
export const BUILD_FILES = [".canopy/smoke.md", ".canopy/accept.md"];

/** A copy of the workflow whose every step may also read the sprout's raw
 *  inputs: `//` makes the rule an absolute path for Claude Code. */
export function withInputsRead(wf: Workflow, dir: string): Workflow {
  const rule = `Read(/${dir}/**)`;
  return { ...wf, steps: wf.steps.map((st) => ({ ...st, tools: [...st.tools, rule] })) };
}

/** A copy of the workflow whose every step may also read devhub's two
 *  indexes and the READMEs under the launch root, and nothing else there:
 *  the root holds a shared `.env`, and a whole-disk Read reaches
 *  /proc/<pid>/environ, either of which WebFetch could carry out. */
export function withWorkspaceRead(wf: Workflow, root: string): Workflow {
  const rules = [`Read(/${root}/_devhub/manifest.json)`, `Read(/${root}/_devhub/references.json)`, `Read(/${root}/**/README.md)`];
  return { ...wf, steps: wf.steps.map((st) => ({ ...st, tools: [...st.tools, ...rules] })) };
}

/** the stage note's sentence naming what withWorkspaceRead opens */
export const workspaceLine = (root: string): string =>
  `The workspace's devhub manifest is ${root}/_devhub/manifest.json and its saved references are ${root}/_devhub/references.json.`;

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const optStr = (v: unknown): boolean => v === undefined || typeof v === "string";
const optNum = (v: unknown): boolean => v === undefined || isNum(v);

/** the licenses a renovate pick may carry (SPDX ids) */
export const ALLOWED_LICENSES = ["MIT", "Apache-2.0", "BSD-2-Clause", "BSD-3-Clause", "ISC", "MPL-2.0", "Unlicense", "0BSD", "GPL-2.0", "GPL-3.0", "LGPL-2.1", "LGPL-3.0"] as const;
const PICK_KINDS: readonly PickKind[] = ["new", "renovate", "extend"];
const isPickKind = (v: unknown): v is PickKind => typeof v === "string" && (PICK_KINDS as readonly string[]).includes(v);
const isHostId = (v: unknown): v is HostId => typeof v === "string" && (HOSTS as readonly string[]).includes(v);

export type ParsedPick = { ok: true; pick: SproutPick } | { ok: false; error: string };

/** scout's `.canopy/pick.json`, read as untrusted: extra keys are dropped,
 *  `why` is one line of at most 500, a renovate target is an https url
 *  kept without its secret, and a new pick carries no target */
export function parsePick(text: string): ParsedPick {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, error: "pick.json is not JSON" };
  }
  if (!isObj(raw)) return { ok: false, error: "pick.json must be an object" };
  const { kind, host, why, target, license } = raw;
  if (!isPickKind(kind)) return { ok: false, error: `kind must be one of ${PICK_KINDS.join(", ")}` };
  if (!isHostId(host)) return { ok: false, error: `host must be one of ${HOSTS.join(", ")}` };
  if (typeof why !== "string" || !why.trim()) return { ok: false, error: "why must say in a sentence why this pick" };
  const pick: SproutPick = { kind, host, why: oneLine(why, 500) };
  if (kind === "renovate") {
    if (typeof target !== "string" || !/^https:\/\/\S+$/.test(target.trim())) return { ok: false, error: "a renovate pick needs target: the upstream's https url" };
    pick.target = urlWithoutSecret(target.trim());
  }
  if (kind === "extend") {
    if (typeof target !== "string" || !target.trim()) return { ok: false, error: "an extend pick needs target: the repo it extends" };
    pick.target = oneLine(target, 300);
  }
  if (typeof license === "string" && license.trim()) pick.license = oneLine(license, 40);
  return { ok: true, pick };
}

/** the hard limits on a pick, held in code whatever the judge said */
export function pickRefusal(p: SproutPick): string | null {
  if (!isHostId(p.host)) return `${p.host} is not one of the hosts canopy deploys to`;
  if (p.kind === "renovate") {
    if (!p.license) return "a renovate pick needs the upstream's SPDX license";
    if (!(ALLOWED_LICENSES as readonly string[]).includes(p.license)) return `${p.license} is not on the allowed license list`;
  }
  return null;
}

/** what this phase can carry out: a new pick deployed to vercel */
export function phaseRefusal(p: SproutPick): string | null {
  if (p.kind !== "new") return `a ${p.kind} pick arrives in phase 4; the research is in .canopy/research.md`;
  if (p.host !== "vercel") return `deploying to ${p.host} arrives in phase 4; the research is in .canopy/research.md`;
  return null;
}

export const isPick = (v: unknown): v is SproutPick =>
  isObj(v) && isPickKind(v["kind"]) && isHostId(v["host"]) && typeof v["why"] === "string" && optStr(v["target"]) && optStr(v["license"]);
const INPUT_KINDS: Readonly<Record<InputKind, true>> = { text: true, audio: true, image: true, url: true, file: true, transcript: true, answers: true };

function isInputEntry(e: unknown): boolean {
  if (!isObj(e)) return false;
  const { n, kind, name, label, type, at, via, bytes, summary, processed, from, note } = e;
  return (
    isNum(n) &&
    typeof kind === "string" &&
    Object.hasOwn(INPUT_KINDS, kind) &&
    typeof name === "string" &&
    typeof label === "string" &&
    typeof type === "string" &&
    isNum(at) &&
    typeof via === "string" &&
    Object.hasOwn(VIA_WORD, via) &&
    isNum(bytes) &&
    typeof summary === "string" &&
    typeof processed === "boolean" &&
    optNum(from) &&
    optStr(note)
  );
}

const isSproutFlow = (f: unknown): boolean => isObj(f) && typeof f["workflow"] === "string" && typeof f["flowId"] === "string" && optStr(f["outcome"]);

const isOption = (o: unknown): boolean => isObj(o) && typeof o["label"] === "string" && typeof o["description"] === "string";

const isQuestion = (q: unknown): boolean => {
  if (!isObj(q)) return false;
  const options: unknown = q["options"];
  return typeof q["question"] === "string" && typeof q["header"] === "string" && Array.isArray(options) && options.every(isOption) && typeof q["multiSelect"] === "boolean";
};

/** A sprout.json read back; null for a broken or foreign file. Every part
 *  restore and the page read is checked, down to each input, flow and
 *  question, so a damaged record is skipped rather than met halfway. */
export function parseSproutRecord(text: string): Sprout | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isObj(raw)) return null;
  const { id, slug, title, status, repoId, seedPath, inputs, flows, createdAt, updatedAt, prepared, clarified, reclarify, spent } = raw;
  if (typeof id !== "string" || !isSproutId(id) || typeof slug !== "string" || typeof title !== "string") return null;
  if (typeof repoId !== "string" || typeof seedPath !== "string" || !isNum(createdAt) || !isNum(updatedAt)) return null;
  if (typeof status !== "string" || !(SPROUT_STATUSES as readonly string[]).includes(status)) return null;
  if (typeof prepared !== "boolean" || typeof clarified !== "boolean" || typeof reclarify !== "boolean") return null;
  if (!isObj(spent) || !isNum(spent["runs"]) || !isNum(spent["workMs"])) return null;
  if (!Array.isArray(inputs) || !inputs.every(isInputEntry)) return null;
  if (!Array.isArray(flows) || !flows.every(isSproutFlow)) return null;
  const { questions, questionsAt, repo, parked, noteRev } = raw;
  if (questions !== undefined && !(Array.isArray(questions) && questions.every(isQuestion))) return null;
  if (!optNum(questionsAt) || !optStr(repo) || !optStr(parked) || !optStr(noteRev)) return null;
  const { pick, privateRepo, url } = raw;
  if (pick !== undefined && !isPick(pick)) return null;
  if (!optStr(privateRepo) || !optStr(url)) return null;
  // canopy's own file: past these checks it is taken as written
  return raw as unknown as Sprout;
}
