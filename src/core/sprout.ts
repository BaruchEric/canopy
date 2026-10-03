/**
 * The incubator's pure parts (spec 2026-10-01-incubator-design.md): slugs
 * and titles, what an upload is taken as, the inputs index and the
 * summaries clarify writes back into it, clarify's questions, the answers
 * as text, and which sprouts hold one of the running slots. Browser-safe:
 * the UI imports it.
 */
import { HOSTS, SPROUT_STATUSES, type FlowStatus, type InputEntry, type InputKind, type InputVia, type RunQuestion, type RunQuestionOption, type HandOffReview, type HostId, type PickKind, type Sprout, type SproutPick, type SproutStatus, type SproutWork, type Workflow } from "./types";

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

/** under a seed's run button: what it starts, and as whom */
export const SEED_RUN_NOTE = "this runs code the incubator's agents wrote, with your tokens";

export const SEED_AGENT_REFUSAL = "a seed's agents run through the incubator; open a plain shell to work in it yourself";

/** a sprout's seed by repo id: `_incubator/<slug>` on the launch root,
 *  bare or qualified with another backend's `<name>|`; never a dot folder */
export function isSeedId(repoId: string): boolean {
  const plain = repoId.includes("|") ? repoId.slice(repoId.indexOf("|") + 1) : repoId;
  const m = /^_incubator\/([^/]+)$/.exec(plain);
  return m !== null && !(m[1] ?? "").startsWith(".");
}

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

/** a url anywhere in a string: up to whitespace, a quote or an angle bracket */
const URL_IN_TEXT = /[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/gi;

/** a JSON value with every url in every string, whole or inside free text,
 *  passed through `urlWithoutSecret` */
export function withoutSecrets(v: unknown): unknown {
  if (typeof v === "string") return v.replace(URL_IN_TEXT, (u) => urlWithoutSecret(u));
  if (Array.isArray(v)) return v.map(withoutSecrets);
  if (typeof v === "object" && v !== null) {
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, withoutSecrets(x)]));
  }
  return v;
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

/** canopy's own file of what the user answered while a stage ran: the judge
 *  reads it, and no agent is told to write it (Research may rewrite intent.md) */
export const ANSWERS_FILE = ".canopy/answers.md";

export const ANSWERS_HEAD =
  "# Answers\n\nWhat the user answered while a stage ran, in order. canopy writes this file; the evaluator reads it with the intent.\n";

/** what canopy commits to the seed after clarify, after answers and after a stage; nothing raw */
export const SEED_FILES = [".canopy/brief.md", ".canopy/intent.md", ".canopy/inputs.md", ANSWERS_FILE];

const answerOf = (answers: Readonly<Record<string, string>>, q: string): string => (Object.hasOwn(answers, q) ? (answers[q] ?? "") : "");

/** one answer given inside a run, as answers.md keeps it: `where` names the stage and step */
export function runAnswersText(where: string, questions: readonly RunQuestion[], answers: Readonly<Record<string, string>>, at: number): string {
  const lines = questions.map((q) => `- ${q.question}\n  ${oneLine(answerOf(answers, q.question), 1000) || "(no answer)"}`);
  return `## ${oneLine(where)}, ${localStamp(at)}\n\n${lines.join("\n")}\n`;
}

/** the same answer as the inputs index's one line */
export function runAnswersSummary(questions: readonly RunQuestion[], answers: Readonly<Record<string, string>>): string {
  const parts = questions.map((q) => `${q.question} ${answerOf(answers, q.question) || "(no answer)"}`);
  return oneLine(parts.join("; "), 200);
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
    s.work?.kind === "renovate" ? `The seed is a clone of ${s.work.from}; its remote is called upstream, and the incubator's earlier notes are on the branch incubator/notes.` : "",
    s.work?.kind === "extend"
      ? `The seed is a clone of the user's own repo ${s.work.target}, on the branch ${s.work.branch}; it has no remote, the files under .canopy/ stay out of git, and canopy pushes the branch once Accept passes.`
      : "",
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

/** not a workflow: the deploy canopy carries out itself after a new or renovate build */
export const SHIP = "ship";

/** not a workflow: the push of an extend's branch canopy carries out itself after its build */
export const HAND_OFF = "hand-off";

/** a next step canopy carries out itself, with no stage and no runner */
export const isOwnStep = (name: string): boolean => name === SHIP || name === HAND_OFF;

/** the build workflow each kind of pick runs */
export const BUILD_WORKFLOW: Readonly<Record<PickKind, string>> = { new: "build-new", renovate: "renovate", extend: "extend" };

/** whether a workflow is one of the builds a pick runs */
export const isBuildWorkflow = (name: string): boolean => Object.values(BUILD_WORKFLOW).includes(name);

/** the status a sprout shows while a workflow runs for it */
export const WORKFLOW_STATUS: Readonly<Record<string, SproutStatus>> = {
  clarify: "clarifying",
  scout: "researching",
  "build-new": "building",
  renovate: "building",
  extend: "building",
  [SHIP]: "deploying",
  [HAND_OFF]: "deploying",
};

/** within a workflow, the status each step shows; a step not named here shows the workflow's */
export const STEP_STATUS: Readonly<Record<string, Readonly<Record<string, SproutStatus>>>> = {
  "build-new": { Scaffold: "building", Test: "testing", Accept: "accepting" },
  renovate: { Renovate: "building", Test: "testing", Accept: "accepting" },
  extend: { Build: "building", Test: "testing", Accept: "accepting" },
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
 *  known now, scout until there is a pick, the pick's build after the newest
 *  scout, then canopy's own ship, or for an extend its hand-off */
export function nextWorkflow(s: Sprout): string {
  if (!s.clarified || s.reclarify) return "clarify";
  if (!s.pick) return "scout";
  const build = BUILD_WORKFLOW[s.pick.kind];
  if (lastDone(s, build) < lastDone(s, "scout")) return build;
  return s.pick.kind === "extend" ? HAND_OFF : SHIP;
}

/** the branch an extend builds in its seed and canopy pushes to the target */
export const extendBranch = (slug: string): string => `new/${slug}`;

export interface GithubRepo {
  owner: string;
  name: string;
}

const GH_OWNER = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/;
const GH_NAME = /^[A-Za-z0-9._-]{1,100}$/;
const GH_FORMS = [
  /^https:\/\/(?:[^@/\s]+@)?github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/,
  /^ssh:\/\/git@github\.com(?::22)?\/([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/,
  /^git@github\.com:([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/,
];

/** A github.com remote's owner and name, from its https, ssh or scp form;
 *  null for any other host, a path, or a url naming more than a repo. */
export function githubRepo(remote: string): GithubRepo | null {
  for (const form of GH_FORMS) {
    const m = form.exec(remote.trim());
    if (!m) continue;
    const owner = m[1] ?? "";
    const name = m[2] ?? "";
    if (!GH_OWNER.test(owner) || !GH_NAME.test(name) || name === "." || name === "..") return null;
    return { owner, name };
  }
  return null;
}

/** the https remote canopy clones and pushes a github.com repo through */
export const githubUrl = (r: GithubRepo): string => `https://github.com/${r.owner}/${r.name}.git`;

/** Why a path a hand-off's commits touch is shown first, or null: a push to
 *  the user's repo runs its CI and preview builds with the repo's secrets
 *  (amendment 6, ruling 19). Any letter case, any folder depth. */
export function handOffFlag(path: string): string | null {
  const parts = path.toLowerCase().split("/");
  const base = parts.at(-1) ?? "";
  if (parts[0] === ".github") return "GitHub Actions or repo settings";
  if (parts.some((x) => [".circleci", ".buildkite", ".gitlab", ".woodpecker", ".drone"].includes(x))) return "CI config";
  if ([".gitlab-ci.yml", ".travis.yml", "azure-pipelines.yml", "bitbucket-pipelines.yml", "jenkinsfile", ".drone.yml", "cloudbuild.yaml", "cloudbuild.yml", "buildspec.yml"].includes(base)) return "CI config";
  if (parts.some((x) => x === ".vercel" || x === ".netlify")) return "deploy config";
  if (["vercel.json", "now.json", "netlify.toml", "firebase.json", ".firebaserc", "fly.toml", "render.yaml", "railway.json", "railway.toml", "app.yaml", "procfile", "amplify.yml", "wrangler.toml", "wrangler.json", "wrangler.jsonc"].includes(base)) return "deploy config";
  if (base.startsWith("dockerfile") || /^(docker-)?compose(\.[\w-]+)?\.ya?ml$/.test(base)) return "deploy config";
  if (parts[0] === ".husky" || [".pre-commit-config.yaml", "lefthook.yml", "lefthook.yaml", ".npmrc", ".yarnrc", ".yarnrc.yml", "bunfig.toml", ".pnpmfile.cjs"].includes(base)) return "package manager or git hook config";
  return null;
}

/** what changed in a package.json's scripts from `before` to `after` (null
 *  for no file), as a flag line's why, or null when they are the same */
export function scriptsFlag(before: string | null, after: string | null): string | null {
  const scripts = (text: string | null): Record<string, unknown> | "bad" => {
    if (text === null) return {};
    try {
      const raw: unknown = JSON.parse(text);
      if (!isObj(raw)) return "bad";
      const s = raw["scripts"];
      return s === undefined ? {} : isObj(s) ? s : "bad";
    } catch {
      return "bad";
    }
  };
  const a = scripts(before);
  const b = scripts(after);
  if (a === "bad" || b === "bad") return "does not parse as a package.json, so its scripts cannot be checked";
  const names = [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k]));
  if (names.length === 0) return null;
  const shown = names.slice(0, 10).map((n) => showPath(n));
  return `scripts changed: ${shown.join(", ")}${names.length > shown.length ? ` and ${names.length - shown.length} more` : ""}`;
}

/** a name as one line: every control character escaped */
export const showPath = (p: string): string =>
  // eslint-disable-next-line no-control-regex
  p.replace(/[\u0000-\u001f\u007f]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);

/** a hand-off's review as the inbox and the sheet show it, the flagged changes first */
export function handOffText(r: HandOffReview): string {
  const gh = githubRepo(r.remote);
  const where = gh ? `github.com/${gh.owner}/${gh.name}` : r.remote;
  const out: string[] = [`Push ${r.branch} to ${where}, from ${r.base.slice(0, 12)} to ${r.head.slice(0, 12)}.`, ""];
  if (r.flagged.length) {
    out.push("Look at these first: a push runs the repo's CI and preview builds with its secrets.");
    for (const f of r.flagged) out.push(`! ${f}`);
  } else out.push("Nothing in CI, deploy config, hooks or package scripts changed.");
  out.push("", `${r.commits.length + r.moreCommits} ${r.commits.length + r.moreCommits === 1 ? "commit" : "commits"}:`);
  for (const c of r.commits) out.push(`  ${c.sha.slice(0, 12)} ${c.subject}`);
  if (r.moreCommits) out.push(`  and ${r.moreCommits} more`);
  out.push("", `${r.files.length + r.moreFiles} ${r.files.length + r.moreFiles === 1 ? "file" : "files"} changed:`);
  for (const f of r.files) out.push(`  ${f.added === null ? "bin" : `+${f.added} -${f.removed ?? 0}`} ${f.path}`);
  if (r.moreFiles) out.push(`  and ${r.moreFiles} more`);
  return out.join("\n");
}

/** Why canopy will not push this, or null: a hand-off pushes exactly
 *  `refs/heads/new/<slug>` to the extend target's own github.com remote, so
 *  `main`, a forced `+` ref and any other remote are refused before git runs. */
export function branchPushRefusal(push: { remote: string; ref: string }, want: { remote: string; slug: string }): string | null {
  if (!githubRepo(want.remote)) return `${want.remote} is not a github.com repo`;
  if (push.remote !== want.remote) return `canopy pushes only to ${want.remote}, the extend target's own remote`;
  const ref = `refs/heads/${extendBranch(want.slug)}`;
  if (push.ref !== ref) return `canopy pushes only ${ref}, not ${push.ref}`;
  return null;
}

/** the same github.com repo, whatever form each url names it in */
const sameGithub = (a: string, b: string): boolean => {
  const x = githubRepo(a);
  const y = githubRepo(b);
  return !!x && !!y && x.owner.toLowerCase() === y.owner.toLowerCase() && x.name.toLowerCase() === y.name.toLowerCase();
};

/** Why a pick cannot be built on a seed canopy already rebuilt, or null: a
 *  rebuilt seed holds one source, so a pick of another kind or source needs
 *  a project of its own (amendment 6, ruling 2). */
export function workRefusal(work: SproutWork | undefined, p: SproutPick): string | null {
  if (!work) return null;
  const t = (p.target ?? "").trim();
  if (work.kind === "renovate" && p.kind === "renovate" && sameGithub(work.from, t)) return null;
  if (work.kind === "extend" && p.kind === "extend" && (t === work.target || t === work.target.split("/").at(-1))) return null;
  return `this seed already holds ${work.kind === "extend" ? work.target : work.from}; start a new project for another pick`;
}

/** the web app config keys firebase-tools prints, and the env name each takes on Vercel after its prefix */
export const FIREBASE_ENV: Readonly<Record<string, string>> = {
  apiKey: "API_KEY",
  authDomain: "AUTH_DOMAIN",
  projectId: "PROJECT_ID",
  storageBucket: "STORAGE_BUCKET",
  messagingSenderId: "MESSAGING_SENDER_ID",
  appId: "APP_ID",
};

/** the prefixes the Firebase config goes to Vercel under: Vite's and Next.js's public ones */
export const FIREBASE_ENV_PREFIXES = ["VITE_FIREBASE_", "NEXT_PUBLIC_FIREBASE_"] as const;

/** the build stage note's line saying what the pick's host needs, so the workflow files stay host-free */
export function hostLine(p: SproutPick): string {
  if (p.kind === "extend") {
    return "This build becomes a branch of the user's own repo, which canopy pushes once Accept passes; it deploys nothing, so leave the project's own build and deploy setup as it is.";
  }
  if (p.host === "vercel") return "The host is Vercel with no database: a site Vercel builds from the repo on its own, holding no server state.";
  if (p.host === "vercel+firebase") {
    const names = Object.values(FIREBASE_ENV).map((k) => `VITE_FIREBASE_${k}`);
    return [
      "The host is Vercel with Firestore for data, read in the browser through the Firebase web SDK.",
      `Canopy makes the Firebase project and web app and sets ${names.join(", ")} on Vercel (NEXT_PUBLIC_FIREBASE_ for Next.js); read the config from those.`,
      "Keep firebase.json to firestore (rules and indexes files inside the repo) and emulators: canopy refuses hosting, functions, storage and any predeploy or postdeploy script.",
      "Write firestore.rules that let the app work and nothing more, and never write a .firebaserc or a key into the repo.",
    ].join(" ");
  }
  return `The host is ${p.host}.`;
}

/** what canopy commits to the seed after scout, beside SEED_FILES */
export const SCOUT_FILES = [".canopy/research.md", ".canopy/pick.json", ".canopy/eval.md"];

/** what canopy commits to the seed after build-new: the smoke and accept notes */
export const BUILD_FILES = [".canopy/smoke.md", ".canopy/accept.md"];

/** Every note of the incubator's own in a seed: what a rebuild carries
 *  over, what an extend's target may not already track, and what no
 *  commit on an extend's branch may touch. The retro's two files are
 *  retro.ts's RETRO_FILES. */
export const NOTE_FILES = [...SEED_FILES, ".canopy/questions.json", ...SCOUT_FILES, ...BUILD_FILES, ".canopy/retro.md", ".canopy/advice.json"];

/** A copy of the workflow whose every step may also read the sprout's raw
 *  inputs: `//` makes the rule an absolute path for Claude Code. */
export function withInputsRead(wf: Workflow, dir: string): Workflow {
  const rule = `Read(/${dir}/**)`;
  return { ...wf, steps: wf.steps.map((st) => ({ ...st, tools: [...st.tools, rule] })) };
}

/** A copy of the workflow whose every step may also read the workspace
 *  snapshot canopy copied for it (`.shared/workspace/<id>`), and nothing
 *  else: the launch root holds a shared `.env`. */
export function withWorkspaceRead(wf: Workflow, dir: string): Workflow {
  const rule = `Read(/${dir}/**)`;
  return { ...wf, steps: wf.steps.map((st) => ({ ...st, tools: [...st.tools, rule] })) };
}

/** A copy of the workflow whose every step may also read the record canopy
 *  shared for the sprout's retro (`.shared/record/<id>`), and nothing else. */
export function withRecordRead(wf: Workflow, dir: string): Workflow {
  const rule = `Read(/${dir}/**)`;
  return { ...wf, steps: wf.steps.map((st) => ({ ...st, tools: [...st.tools, rule] })) };
}

/** the retro's note: where its record is */
export const recordLine = (file: string): string => `This project's record is ${file}.`;

/** the stage note's sentence naming what withWorkspaceRead opens */
export const workspaceLine = (dir: string): string =>
  `The workspace's devhub manifest is ${dir}/manifest.json, its saved references are ${dir}/references.json and each project's README is in ${dir}/READMEs/.`;

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

/** what this phase can carry out: a new or renovate pick on vercel or
 *  vercel+firebase, and an extend, which never deploys (amendment 6,
 *  ruling 13); vercel+convex and mini park in one line each */
export function phaseRefusal(p: SproutPick): string | null {
  if (p.kind === "extend") return null;
  if (p.host === "vercel+convex") return CONVEX_PARKED;
  if (p.host === "mini") return MINI_PARKED;
  return null;
}

/** the one line a vercel+convex pick parks with (amendment 6, ruling 9) */
export const CONVEX_PARKED = "vercel+convex is parked: canopy cannot run a Convex deploy without handing it files outside the project; pick vercel+firebase for a database";
/** the one line a mini pick parks with (amendment 6, ruling 12) */
export const MINI_PARKED = "the mini host is not built yet: a stage's compose file would be root on the mini; pick vercel or vercel+firebase";

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

const isStepDigest = (st: unknown): boolean => isObj(st) && typeof st["name"] === "string" && typeof st["status"] === "string" && isNum(st["tries"]) && optStr(st["reason"]);

const isDigest = (d: unknown): boolean =>
  isObj(d) &&
  typeof d["status"] === "string" &&
  isNum(d["startedAt"]) &&
  optNum(d["endedAt"]) &&
  optStr(d["error"]) &&
  Array.isArray(d["steps"]) &&
  d["steps"].every(isStepDigest) &&
  Array.isArray(d["rewinds"]);

const isSproutFlow = (f: unknown): boolean =>
  isObj(f) && typeof f["workflow"] === "string" && typeof f["flowId"] === "string" && optStr(f["outcome"]) && (f["digest"] === undefined || isDigest(f["digest"]));

const isPark = (p: unknown): boolean => isObj(p) && isNum(p["at"]) && typeof p["reason"] === "string";

const RETRO_FORS: readonly string[] = ["end", "park"];
const RETRO_STATES: readonly string[] = ["due", "running", "done", "failed"];
const isLesson = (a: unknown): boolean => isObj(a) && typeof a["key"] === "string" && typeof a["lesson"] === "string";

const isRetro = (r: unknown): boolean => {
  if (!isObj(r)) return false;
  const { for: kind, state, at, endedAt, flowId, flowsSeen, tries, advice, reason } = r;
  return (
    typeof kind === "string" &&
    RETRO_FORS.includes(kind) &&
    typeof state === "string" &&
    RETRO_STATES.includes(state) &&
    isNum(at) &&
    optNum(endedAt) &&
    optStr(flowId) &&
    isNum(flowsSeen) &&
    isNum(tries) &&
    optStr(reason) &&
    (advice === undefined || (Array.isArray(advice) && advice.every(isLesson)))
  );
};

const isWork = (w: unknown): boolean => {
  if (!isObj(w) || typeof w["from"] !== "string" || typeof w["base"] !== "string" || !isNum(w["at"])) return false;
  if (w["kind"] === "renovate") return true;
  return w["kind"] === "extend" && typeof w["target"] === "string" && typeof w["remote"] === "string" && typeof w["branch"] === "string";
};

const optBool = (v: unknown): boolean => v === undefined || typeof v === "boolean";
const isHandOff = (h: unknown): boolean => {
  if (!isObj(h)) return false;
  const strs = ["head", "base", "remote", "branch"].every((k) => typeof h[k] === "string");
  const commits = Array.isArray(h["commits"]) && h["commits"].every((c: unknown) => isObj(c) && typeof c["sha"] === "string" && typeof c["subject"] === "string");
  const files = Array.isArray(h["files"]) && h["files"].every((f: unknown) => isObj(f) && typeof f["path"] === "string");
  const flagged = Array.isArray(h["flagged"]) && h["flagged"].every((f: unknown) => typeof f === "string");
  return strs && commits && files && flagged && isNum(h["moreCommits"]) && isNum(h["moreFiles"]) && isNum(h["at"]) && (h["approved"] === undefined || h["approved"] === true);
};
const isFirebase = (f: unknown): boolean => isObj(f) && typeof f["project"] === "string" && optBool(f["created"]) && optBool(f["database"]) && optStr(f["app"]) && optBool(f["env"]);

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
  const { pick, privateRepo, vercelProject, url } = raw;
  if (pick !== undefined && !isPick(pick)) return null;
  if (!optStr(privateRepo) || !optStr(vercelProject) || !optStr(url)) return null;
  const { parkedAt, parks, retro } = raw;
  if (!optNum(parkedAt) || (parks !== undefined && !(Array.isArray(parks) && parks.every(isPark)))) return null;
  if (retro !== undefined && !isRetro(retro)) return null;
  const { work, branch, firebase, handOff } = raw;
  if ((work !== undefined && !isWork(work)) || !optStr(branch) || (firebase !== undefined && !isFirebase(firebase))) return null;
  if (handOff !== undefined && !isHandOff(handOff)) return null;
  // canopy's own file: past these checks it is taken as written
  return raw as unknown as Sprout;
}
