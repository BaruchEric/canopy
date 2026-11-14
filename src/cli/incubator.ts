/**
 * `canopy new` and `canopy incubator`: start a project, list the projects,
 * show one with its questions and why it waits, and answer it the way the
 * page's sheet does: answer or skip clarify's questions, resume, stop,
 * dismiss, add input, and say yes or no to a hand-off. The lines and the
 * answers are pure (incubator.test.ts).
 */

import { basename } from "node:path";
import { verbHelp } from "../core/help";
import { handOffText, isOwnStep, nextWorkflow, parsePick, phaseRefusal, pickRefusal, sproutEnded } from "../core/sprout";
import type { IncubatorStages, RunQuestion, Sprout, SproutDetail } from "../core/types";
import { NO_STAGES } from "../server/incubator";
import { apiBase, callerHeaders } from "./api";
import { errText, has, take } from "./health";
import { parseAddArgs, parseNewArgs, sproutLink, type IntakeArgs } from "./newargs";
import { bold, dim, moss, sky } from "./render";

type Fail = (msg: string) => never;

export const INCUBATOR_USAGE = verbHelp("incubator") ?? "usage: canopy incubator [list] | show <id> | answer | resume | stop | dismiss | add | handoff | pick-check";

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isOrigin = (url: string): boolean => /^https?:\/\/[^/\s]+$/.test(url);

/** The origin a link to the page is built on: the backend's public origin,
 *  as its own entry in `GET /api/backends` names it, else the API origin
 *  the CLI reached, which inside a canopy shell is loopback. */
export function pageBase(api: string, listed: unknown): string {
  if (!isObj(listed) || typeof listed["self"] !== "string" || !Array.isArray(listed["backends"])) return api;
  const self = listed["self"];
  const own: unknown = listed["backends"].find((b: unknown) => isObj(b) && b["name"] === self);
  const pub = isObj(own) && typeof own["public"] === "string" ? own["public"].replace(/\/+$/, "") : "";
  return isOrigin(pub) ? pub : api;
}

async function pageOrigin(api: string): Promise<string> {
  try {
    const res = await fetch(`${api}/api/backends`, { redirect: "manual", signal: AbortSignal.timeout(3_000), headers: callerHeaders(api) });
    return pageBase(api, res.ok ? await res.json() : null);
  } catch {
    return api;
  }
}

/** Where the backend's stages run, or null when it did not say (an older
 *  backend, a sign-in gate); throws when it does not answer at all. */
async function readStages(backend: string): Promise<IncubatorStages | null> {
  const res = await fetch(`${backend}/api/incubator/stages`, { redirect: "manual", signal: AbortSignal.timeout(8_000), headers: callerHeaders(backend) });
  if (!res.ok) return null;
  const body: unknown = await res.json().catch(() => null);
  return isObj(body) && typeof body["mode"] === "string" ? (body as unknown as IncubatorStages) : null;
}

/** One request to the backend, JSON or a form; a refusal fails the command in the server's words. */
async function call<T>(backend: string, method: string, path: string, body: unknown, fail: Fail): Promise<T> {
  const form = body instanceof FormData;
  let res: Response;
  try {
    res = await fetch(`${backend}${path}`, {
      method,
      redirect: "manual",
      headers: callerHeaders(backend, undefined, body !== undefined && !form ? { "content-type": "application/json" } : undefined),
      ...(form ? { body } : body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  } catch (err) {
    return fail(`${backend} did not answer: ${errText(err)}`);
  }
  const out = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) return fail(out.error ?? `the backend answered ${res.status}`);
  return out;
}

/** Why a queued project is not starting, in its backend's words, or null:
 *  the page's rule (queuedWhy in ui/src/sprouts.ts). A project still being
 *  prepared, or bound for canopy's own deploy or hand-off, waits for no stage. */
export function waitWhy(s: Sprout, st: IncubatorStages | null): string | null {
  if (s.status !== "queued" || !s.prepared || isOwnStep(nextWorkflow(s))) return null;
  return st?.waiting ?? null;
}

/** one project on one line: id, status, title, and what it waits on */
export function listLine(s: Sprout, st: IncubatorStages | null): string {
  const wait = waitWhy(s, st);
  const n = s.questions?.length ?? 0;
  const why = s.parked ? ` (${s.parked})` : n > 0 ? ` (${n} ${n === 1 ? "question" : "questions"} waiting)` : wait ? ` (waiting: ${wait})` : "";
  return `${s.id}  ${s.status.padEnd(11)} ${s.title}${why}`;
}

/** clarify's open questions, numbered, each with its numbered options, and how to answer them */
export function questionLines(id: string, questions: readonly RunQuestion[]): string[] {
  const out = [`clarify asks ${questions.length === 1 ? "one question" : `${questions.length} questions`}:`];
  questions.forEach((q, i) => {
    out.push(`${i + 1}. ${q.question}${q.options.length > 0 && q.multiSelect ? " (pick any)" : ""}`);
    q.options.forEach((o, j) => out.push(`   ${j + 1}) ${o.label}${o.description ? `: ${o.description}` : ""}`));
  });
  const slots = questions.map((_, i) => `"<${i + 1}>"`).join(" ");
  out.push(`answer: canopy incubator answer ${id} ${slots}`, `or go on assumptions: canopy incubator answer ${id} --skip`);
  return out;
}

/** One project at length: where it stands and why it waits, what it needs
 *  from you and the command that gives it, its intent and inputs, and the
 *  link to its sheet. */
export function showLines(d: SproutDetail, st: IncubatorStages | null, link: string): string[] {
  const s = d.sprout;
  const minutes = Math.round(s.spent.workMs / 60_000);
  const out = [`${s.title}  ${s.repoId}`, `${s.status}${s.parked ? `: ${s.parked}` : ""}`];
  const wait = waitWhy(s, st);
  if (wait) out.push(`waiting: ${wait}`);
  out.push(`${s.spent.runs} ${s.spent.runs === 1 ? "run" : "runs"}, ${minutes} min of agent work`);
  if (s.status === "clarifying" && s.questions?.length) out.push("", ...questionLines(s.id, s.questions));
  if (s.status === "approving" && s.handOff) {
    out.push("", handOffText(s.handOff), "", `push it: canopy incubator handoff ${s.id} --yes ${s.handOff.head.slice(0, 12)}`, `decline: canopy incubator handoff ${s.id} --no "<reason>"`);
  }
  if (s.status === "parked") {
    out.push("", `go on: canopy incubator resume ${s.id}`, `run the step again, or send the work back: canopy incubator resume ${s.id} --retry`, `end it: canopy incubator stop ${s.id}`);
  }
  if (sproutEnded(s)) out.push("", `off the list: canopy incubator dismiss ${s.id}`);
  if (d.intent) out.push("", d.intent.trim());
  out.push("", d.inputsIndex.trim(), "", link);
  return out;
}

/** a number in range picks that option; where any may be picked, numbers split by commas pick each */
function picked(q: RunQuestion, raw: string): string | null {
  if (q.options.length === 0 || !/^\d+(\s*,\s*\d+)*$/.test(raw)) return null;
  const nums = [...new Set(raw.split(",").map((n) => Number(n.trim())))];
  if (nums.length > 1 && !q.multiSelect) return null;
  if (nums.some((n) => n < 1 || n > q.options.length)) return null;
  return nums.map((n) => q.options[n - 1]?.label ?? "").join(", ");
}

/** The answers `POST /api/incubator/answer` reads, keyed by each question's
 *  text, from the command's words in question order. A number picks that
 *  option ("1,3" where any may be picked), "" leaves the question
 *  unanswered, and anything else is the answer as written. */
export function answerMap(questions: readonly RunQuestion[], given: readonly string[]): { answers: Record<string, string> } | { error: string } {
  if (given.length > questions.length) {
    return { error: `${given.length} answers for ${questions.length === 1 ? "one question" : `${questions.length} questions`}: give one per question, in order` };
  }
  const answers: Record<string, string> = {};
  questions.forEach((q, i) => {
    const raw = (given[i] ?? "").trim();
    if (raw) answers[q.question] = picked(q, raw) ?? raw;
  });
  if (Object.keys(answers).length === 0) return { error: `give an answer, or --skip to go on assumptions\n${INCUBATOR_USAGE}` };
  return { answers };
}

/** the multipart body the intake routes read, its files read from disk (`missingFile` checks them first) */
async function intakeForm(a: IntakeArgs): Promise<FormData> {
  const form = new FormData();
  if (a.text) form.append("text", a.text);
  for (const u of a.urls) form.append("url", u);
  if (a.repo) form.append("repo", a.repo);
  for (const path of a.files) {
    const f = Bun.file(path);
    form.append("file", new File([await f.arrayBuffer()], basename(path), { type: f.type }), basename(path));
  }
  form.append("via", "cli");
  return form;
}

async function missingFile(paths: readonly string[]): Promise<string | undefined> {
  for (const path of paths) if (!(await Bun.file(path).exists())) return path;
  return undefined;
}

export async function newCommand(argv: string[], { fail }: { fail: Fail }): Promise<void> {
  const parsed = parseNewArgs(argv, process.env);
  if ("error" in parsed) return fail(parsed.error);
  const missing = await missingFile(parsed.files);
  if (missing !== undefined) return fail(`no such file: ${missing}`);
  const b = parsed.backend;
  // asked before a file is read or sent: a backend with nowhere to run a
  // stage would refuse the project only after the whole upload
  const stages = await readStages(b).catch((err: unknown) => fail(`${b} did not answer: ${errText(err)}`));
  if (stages?.mode === "off") return fail(NO_STAGES);
  if (parsed.note) console.error(dim(parsed.note));
  const s = await call<Partial<Sprout>>(b, "POST", "/api/incubator", await intakeForm(parsed), fail);
  if (!s.id) return fail("the backend answered with no project");
  console.log(`${moss(s.id)} ${s.title ?? ""}`);
  console.log(sky(sproutLink(await pageOrigin(b), s.id)));
}

const unknownFlag = (words: readonly string[]): string | undefined => words.find((w) => w.startsWith("--"));

export async function incubatorCommand(argv: string[], { fail }: { fail: Fail }): Promise<void> {
  const args = [...argv];
  const backendFlag = args.includes("--backend");
  const given = take(args, "--backend");
  if (backendFlag && given === undefined) return fail("--backend needs a value");
  const backend = apiBase(given);
  if (!isOrigin(backend)) return fail(`--backend must be an http(s) origin, got ${backend}`);
  const asJson = has(args, "--json");
  const sub = args[0] ?? "list";
  /** the id, read once a subcommand has taken its own flags out, so a flag before it is not the id */
  const idArg = (): string => {
    const word = args[1] ?? "";
    return word.startsWith("--") ? "" : word;
  };
  const one = (id: string): string => `?id=${encodeURIComponent(id)}`;
  /** the sprout a write answered with, on its list line */
  const said = (s: Sprout): void => console.log(listLine(s, null));
  /** the id of a command that takes it and nothing else */
  const only = (usage: string): string => {
    const id = idArg();
    return id && args.length === 2 ? id : fail(usage);
  };

  switch (sub) {
    case "list": {
      if (args.length > 1) return fail(INCUBATOR_USAGE);
      const [list, stages] = await Promise.all([call<Sprout[]>(backend, "GET", "/api/incubator", undefined, fail), readStages(backend).catch(() => null)]);
      if (asJson) return void console.log(JSON.stringify(list, null, 2));
      if (list.length === 0) console.log(dim("nothing in the incubator"));
      for (const s of list) console.log(listLine(s, stages));
      return;
    }
    case "show": {
      const id = only("usage: canopy incubator show <id> [--json]");
      const [d, stages, page] = await Promise.all([call<SproutDetail>(backend, "GET", `/api/incubator/one${one(id)}`, undefined, fail), readStages(backend).catch(() => null), pageOrigin(backend)]);
      if (asJson) return void console.log(JSON.stringify(d, null, 2));
      const [head = "", ...rest] = showLines(d, stages, sproutLink(page, d.sprout.id));
      console.log(bold(head));
      for (const line of rest.slice(0, -1)) console.log(line);
      console.log(sky(rest.at(-1) ?? ""));
      return;
    }
    case "answer": {
      const usage = 'usage: canopy incubator answer <id> "<answer>"... | --skip';
      const skip = has(args, "--skip");
      const words = args.slice(2);
      const id = idArg();
      const odd = unknownFlag(words);
      if (!id || odd !== undefined) return fail(odd !== undefined ? `unknown flag ${odd}\n${usage}` : usage);
      if (skip) {
        if (words.length > 0) return fail("give answers or --skip, not both");
        return said(await call<Sprout>(backend, "POST", `/api/incubator/answer${one(id)}`, { skip: true }, fail));
      }
      if (words.length === 0) return fail(usage);
      const d = await call<SproutDetail>(backend, "GET", `/api/incubator/one${one(id)}`, undefined, fail);
      const questions = d.sprout.status === "clarifying" ? (d.sprout.questions ?? []) : [];
      if (questions.length === 0) return fail("this project has no open questions");
      const body = answerMap(questions, words);
      if ("error" in body) return fail(body.error);
      return said(await call<Sprout>(backend, "POST", `/api/incubator/answer${one(id)}`, body, fail));
    }
    case "resume": {
      const retry = has(args, "--retry");
      const id = only("usage: canopy incubator resume <id> [--retry]");
      return said(await call<Sprout>(backend, "POST", `/api/incubator/resume${one(id)}`, { choice: retry ? "retry" : "continue" }, fail));
    }
    case "stop": {
      const id = only("usage: canopy incubator stop <id>");
      return said(await call<Sprout>(backend, "POST", `/api/incubator/stop${one(id)}`, {}, fail));
    }
    case "dismiss": {
      const id = only("usage: canopy incubator dismiss <id>");
      await call<unknown>(backend, "DELETE", `/api/incubator${one(id)}`, undefined, fail);
      console.log(`${id} is off the list; its seed, inputs and vault note stay`);
      return;
    }
    case "add": {
      const id = idArg();
      const parsed = parseAddArgs(args.slice(2));
      if (!id || "error" in parsed) return fail("error" in parsed ? parsed.error : INCUBATOR_USAGE);
      const missing = await missingFile(parsed.files);
      if (missing !== undefined) return fail(`no such file: ${missing}`);
      return said(await call<Sprout>(backend, "POST", `/api/incubator/input${one(id)}`, await intakeForm(parsed), fail));
    }
    case "handoff": {
      const usage = 'usage: canopy incubator handoff <id> --yes <head> | --no ["<reason>"]';
      const yes = args.includes("--yes");
      const head = take(args, "--yes");
      const no = has(args, "--no");
      const words = args.slice(2);
      const id = idArg();
      if (!id || yes === no || unknownFlag(words) !== undefined) return fail(usage);
      if (yes) {
        if (!head || !/^[0-9a-f]+$/i.test(head) || words.length > 0) return fail(`${usage}\n--yes takes the head show printed, so the yes is for the commits you looked at`);
        // a yes holds for the head it names alone: show prints twelve characters of it
        const d = await call<SproutDetail>(backend, "GET", `/api/incubator/one${one(id)}`, undefined, fail);
        const at = d.sprout.handOff?.head ?? "";
        const full = head.length >= 7 && at.startsWith(head) ? at : head;
        return said(await call<Sprout>(backend, "POST", `/api/incubator/handoff${one(id)}`, { approve: true, head: full }, fail));
      }
      const reason = words.join(" ").trim();
      return said(await call<Sprout>(backend, "POST", `/api/incubator/handoff${one(id)}`, { approve: false, head: "", ...(reason ? { reason } : {}) }, fail));
    }
    case "pick-check": {
      // run by scout's check in the seed: what canopy will read after scout, read now
      const pickFile = Bun.file(".canopy/pick.json");
      if (!(await pickFile.exists())) return fail(".canopy/pick.json is missing: research ends by writing it");
      const parsed = parsePick(await pickFile.text());
      if (!parsed.ok) return fail(`.canopy/pick.json: ${parsed.error}`);
      const refused = pickRefusal(parsed.pick) ?? phaseRefusal(parsed.pick);
      if (refused) return fail(`.canopy/pick.json: ${refused}`);
      if (!(await Bun.file(".canopy/research.md").exists())) return fail(".canopy/research.md is missing: research writes it before the pick");
      console.log(`pick ok: ${parsed.pick.kind} on ${parsed.pick.host}`);
      return;
    }
    default:
      return fail(INCUBATOR_USAGE);
  }
}
