/** Triggers: an outside event (a Sentry issue) starts a workflow on a branch
 *  run of its own, with nobody typing. The rules, the event records, the
 *  Sentry payload reader, dedupe, and the event's state read off its run and
 *  its PR. Browser-safe and pure; the hub in server/triggers.ts keeps the
 *  records and starts the runs. */

import { TRIGGER_ENV_PREFIX } from "./envnames";
import { fence } from "./pr";
import type { Flow, LandNotice, PrWatch, Run, Workflow } from "./types";

export const TRIGGER_SOURCES = ["sentry"] as const;
export type TriggerSource = (typeof TRIGGER_SOURCES)[number];

/** One line of `<config dir>/triggers.json`: where an event comes from,
 *  which repo it is about and which workflow fixes it. Secrets are named by
 *  the environment variable that holds them, never written here. */
export interface TriggerRule {
  /** the last part of the hook's address: `/api/hooks/<source>/<name>` */
  name: string;
  source: TriggerSource;
  /** the repo's id or its absolute path */
  repo: string;
  /** a one-step workflow, run on a branch that opens a PR */
  workflow: string;
  /** the env var holding the Sentry integration's client secret, which signs
   *  each hook; it starts with `CANOPY_TRIGGER_`, which the server takes out of
   *  its env at start */
  secretEnv: string;
  /** the Sentry project slugs this rule takes; empty takes every one */
  projects: string[];
  /** the levels this rule takes */
  levels: string[];
  /** an event whose title holds one of these is recorded as ignored */
  ignore: string[];
  /** the env var holding a Sentry token that may resolve issues; unset leaves them open */
  tokenEnv?: string;
  /** the Sentry organisation slug, for the resolve call */
  org?: string;
  /** Sentry's address, for the resolve call */
  api: string;
}

/** What canopy says about a rule on the page: no secret, only whether it is set. */
export interface TriggerRuleInfo extends TriggerRule {
  hook: string;
  secretSet: boolean;
  tokenSet: boolean;
  /** why the rule cannot fire: an unknown repo or workflow, a bad line */
  problem?: string;
}

export type TriggerStatus =
  /** waiting for a branch run slot on the repo */
  | "queued"
  | "working"
  /** the run asks something */
  | "waiting"
  /** the run was stopped, or a restart cut it short: resume picks it up */
  | "stopped"
  /** the run failed, or canopy could not start it */
  | "failed"
  /** the run finished with nothing committed: the agent found nothing to fix */
  | "no-fix"
  /** the run committed but canopy could not open a PR, or it waits on the landing queue */
  | "ready"
  /** the PR is open */
  | "review"
  /** the PR merged */
  | "merged"
  /** the PR closed without merging */
  | "closed"
  /** a level, project or ignore line passed it over; no run */
  | "ignored";

export const TRIGGER_STATUSES: readonly TriggerStatus[] = ["queued", "working", "waiting", "stopped", "failed", "no-fix", "ready", "review", "merged", "closed", "ignored"];

/** One event a rule took, and everything canopy did about it. */
export interface TriggerEvent {
  id: string;
  rule: string;
  source: TriggerSource | "manual";
  /** the outside issue's id: one event, so one PR, per issue */
  key: string;
  /** Sentry's short id, PROJECT-1A */
  short?: string;
  title: string;
  culprit?: string;
  level?: string;
  project?: string;
  /** where the issue is shown */
  link?: string;
  /** the note the run started with, data fenced */
  note: string;
  repoId: string;
  workflow: string;
  status: TriggerStatus;
  /** why it is ignored, stopped or failed */
  reason?: string;
  /** how many times the issue came in */
  count: number;
  firstAt: number;
  lastAt: number;
  /** the latest run on its branch */
  runId?: string;
  /** the flow on its branch, while the event follows one: a workflow of
   *  several steps, or one with a check or a gate */
  flowId?: string;
  /** the flow's step in progress, while the flow is going */
  step?: string;
  /** the branch's id (`RunBranch.origin`), which the landing record and the PR watch use */
  branch?: string;
  pr?: { number: number; url: string };
  /** set once the merge marked the issue resolved where it came from, or why that failed */
  resolved?: { at: number } | { error: string };
  endedAt?: number;
}

/** `GET /api/triggers`: the rules as the page shows them and every event kept. */
export interface TriggersInfo {
  rules: TriggerRuleInfo[];
  /** lines of triggers.json that were left out, and why */
  problems: string[];
  events: TriggerEvent[];
  /** whether this backend holds the flows lock, so starts runs for its hooks */
  keeping: boolean;
}

/** What a hook delivery became. */
export type Delivery =
  | { kind: "started" | "queued" | "ignored"; event: TriggerEvent }
  | { kind: "duplicate"; event: TriggerEvent }
  | { kind: "skip"; why: string };

/** An outside issue as a rule reads it, before it is an event. */
export interface Incoming {
  key: string;
  short?: string;
  title: string;
  culprit?: string;
  level?: string;
  project?: string;
  link?: string;
  /** the exception's type and message, the file and function Sentry names */
  detail: string[];
  /** in-app stack frames, innermost last */
  frames: string[];
}

export const KEEP_EVENTS = 200;
const NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;
const ENV = /^[A-Z_][A-Z0-9_]*$/;
const DEFAULT_LEVELS = ["error", "fatal"];

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (o: Record<string, unknown>, k: string): string | undefined => {
  const v = o[k];
  return typeof v === "string" && v.trim() ? v.trim() : typeof v === "number" ? String(v) : undefined;
};
const strings = (v: unknown, what: string): string[] => {
  if (v === undefined) return [];
  if (!Array.isArray(v) || !v.every((x) => typeof x === "string")) throw new Error(`${what} must be a list of strings`);
  return v.map((x) => x.trim()).filter(Boolean);
};

/** `triggers.json` as rules, each line on its own: a bad one is kept out
 *  and named, the rest still fire. */
export function parseRules(text: string | null): { rules: TriggerRule[]; problems: string[] } {
  if (!text?.trim()) return { rules: [], problems: [] };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    return { rules: [], problems: [`triggers.json is not JSON: ${err instanceof Error ? err.message : String(err)}`] };
  }
  const list = isRecord(raw) ? raw["rules"] : undefined;
  if (!Array.isArray(list)) return { rules: [], problems: ["triggers.json needs a rules list"] };
  const rules: TriggerRule[] = [];
  const problems: string[] = [];
  list.forEach((item, i) => {
    try {
      const rule = parseRule(item);
      if (rules.some((r) => r.name === rule.name)) throw new Error(`the name ${rule.name} is taken by an earlier rule`);
      rules.push(rule);
    } catch (err) {
      problems.push(`rule ${i + 1}: ${err instanceof Error ? err.message : String(err)}`);
    }
  });
  return { rules, problems };
}

function parseRule(item: unknown): TriggerRule {
  if (!isRecord(item)) throw new Error("must be an object");
  const name = str(item, "name") ?? "";
  if (!NAME.test(name)) throw new Error(`name must be lowercase letters, digits and -, not ${name || "empty"}`);
  const source = str(item, "source") ?? "sentry";
  if (!(TRIGGER_SOURCES as readonly string[]).includes(source)) throw new Error(`source must be one of ${TRIGGER_SOURCES.join(", ")}, not ${source}`);
  const repo = str(item, "repo");
  if (!repo) throw new Error("repo is required: the repo's id or absolute path");
  const workflow = str(item, "workflow") ?? "sentry-fix";
  const secretEnv = str(item, "secretEnv");
  if (!secretEnv || !ENV.test(secretEnv)) throw new Error("secretEnv must name the environment variable holding the hook's secret");
  if (!secretEnv.startsWith(TRIGGER_ENV_PREFIX)) throw new Error(`secretEnv must start with ${TRIGGER_ENV_PREFIX}, so canopy keeps it from every run and shell, not ${secretEnv}`);
  const tokenEnv = str(item, "tokenEnv");
  if (tokenEnv !== undefined && !ENV.test(tokenEnv)) throw new Error(`tokenEnv must name an environment variable, not ${tokenEnv}`);
  if (tokenEnv !== undefined && !tokenEnv.startsWith(TRIGGER_ENV_PREFIX)) throw new Error(`tokenEnv must start with ${TRIGGER_ENV_PREFIX}, so canopy keeps it from every run and shell, not ${tokenEnv}`);
  const levels = strings(item["levels"], "levels").map((l) => l.toLowerCase());
  const org = str(item, "org");
  const api = (str(item, "api") ?? "https://sentry.io").replace(/\/+$/, "");
  if (!/^https?:\/\//.test(api)) throw new Error(`api must be an http(s) address, not ${api}`);
  return {
    name,
    source: source as TriggerSource,
    repo,
    workflow,
    secretEnv,
    projects: strings(item["projects"], "projects"),
    levels: levels.length ? levels : DEFAULT_LEVELS,
    ignore: strings(item["ignore"], "ignore"),
    ...(tokenEnv ? { tokenEnv } : {}),
    ...(org ? { org } : {}),
    api,
  };
}

/** A Sentry webhook's body as an issue, from the three resources that carry
 *  one: `issue` (created), `event_alert` (an alert rule fired) and `error`.
 *  Anything else (installation, a resolved or assigned issue) is null. */
export function parseSentry(resource: string, body: unknown): Incoming | null {
  if (!isRecord(body)) return null;
  const action = str(body, "action");
  const data = isRecord(body["data"]) ? body["data"] : null;
  if (!data) return null;
  if (resource === "issue") {
    if (action !== "created" && action !== "unresolved") return null;
    const issue = isRecord(data["issue"]) ? data["issue"] : null;
    if (!issue) return null;
    const key = str(issue, "id");
    if (!key) return null;
    const project = isRecord(issue["project"]) ? str(issue["project"], "slug") : undefined;
    return incoming(issue, key, project, str(issue, "permalink") ?? str(issue, "web_url"));
  }
  if (resource === "event_alert" || resource === "error") {
    const ev = isRecord(data["event"]) ? data["event"] : isRecord(data["error"]) ? data["error"] : null;
    if (!ev) return null;
    const key = str(ev, "issue_id") ?? str(ev, "group_id");
    if (!key) return null;
    const project = str(ev, "project_slug") ?? (isRecord(ev["project"]) ? str(ev["project"], "slug") : undefined);
    return incoming(ev, key, project, str(ev, "web_url") ?? str(ev, "issue_url"));
  }
  return null;
}

function incoming(o: Record<string, unknown>, key: string, project: string | undefined, link: string | undefined): Incoming {
  const meta = isRecord(o["metadata"]) ? o["metadata"] : {};
  const detail = [
    str(meta, "type") && str(meta, "value") ? `${str(meta, "type")}: ${str(meta, "value")}` : str(meta, "value") ?? str(meta, "title"),
    str(meta, "filename") ? `file: ${str(meta, "filename")}` : undefined,
    str(meta, "function") ? `function: ${str(meta, "function")}` : undefined,
  ].filter((x): x is string => x !== undefined);
  const short = str(o, "shortId") ?? str(o, "short_id");
  const culprit = str(o, "culprit");
  const level = str(o, "level");
  return {
    key,
    title: (str(o, "title") ?? (detail[0] || "an untitled Sentry issue")).slice(0, 300),
    ...(short ? { short } : {}),
    ...(culprit ? { culprit } : {}),
    ...(level ? { level: level.toLowerCase() } : {}),
    ...(project ? { project } : {}),
    ...(link && /^https?:\/\//.test(link) ? { link } : {}),
    detail,
    frames: framesOf(o),
  };
}

/** The in-app frames of the first exception that has any, innermost last,
 *  at most 15, as `file:line in function`. */
function framesOf(o: Record<string, unknown>): string[] {
  const exc = isRecord(o["exception"]) ? o["exception"] : null;
  const values = exc && Array.isArray(exc["values"]) ? exc["values"] : [];
  for (const v of values) {
    const st = isRecord(v) && isRecord(v["stacktrace"]) ? v["stacktrace"] : null;
    const frames = st && Array.isArray(st["frames"]) ? st["frames"].filter(isRecord) : [];
    const own = frames.filter((f) => f["in_app"] === true);
    const lines = (own.length ? own : frames).map((f) => {
      const file = str(f, "filename") ?? str(f, "abs_path") ?? "?";
      const line = str(f, "lineno");
      const fn = str(f, "function");
      return `${file}${line ? `:${line}` : ""}${fn ? ` in ${fn}` : ""}`;
    });
    if (lines.length) return lines.slice(-15);
  }
  return [];
}

/** Why a rule passes this issue over, or null when it takes it. */
export function ignoreReason(rule: TriggerRule, inc: Incoming): string | null {
  if (rule.projects.length && (!inc.project || !rule.projects.includes(inc.project))) {
    return `project ${inc.project ?? "unknown"} is not one this rule takes`;
  }
  if (inc.level && !rule.levels.includes(inc.level)) return `level ${inc.level} is not one this rule takes`;
  const hit = rule.ignore.find((w) => inc.title.toLowerCase().includes(w.toLowerCase()));
  return hit ? `the title holds "${hit}", on the rule's ignore list` : null;
}

/** States after which the same issue coming in again starts a new event:
 *  canopy could not start it, or it was fixed and came back. Any other
 *  state, open or ended, keeps it to one event and one PR. */
const AGAIN: readonly TriggerStatus[] = ["failed", "merged", "ignored"];

/** The event this issue already has under this rule, when one counts. */
export function existing(events: readonly TriggerEvent[], rule: string, key: string): TriggerEvent | undefined {
  const same = events.filter((e) => e.rule === rule && e.key === key).sort((a, b) => b.firstAt - a.firstAt)[0];
  return same && !AGAIN.includes(same.status) ? same : undefined;
}

/** The run's first message after the workflow's task: the issue, fenced as
 *  data, since anyone who can make the app throw chooses its words. */
export function noteFor(inc: Incoming, source: TriggerEvent["source"]): string {
  const lines = [
    `title: ${inc.title}`,
    inc.short ? `id: ${inc.short}` : "",
    inc.culprit ? `culprit: ${inc.culprit}` : "",
    inc.level ? `level: ${inc.level}` : "",
    inc.project ? `project: ${inc.project}` : "",
    inc.link ? `link: ${inc.link}` : "",
    ...inc.detail,
    inc.frames.length ? `stack, innermost last:\n${inc.frames.map((f) => `  ${f}`).join("\n")}` : "",
  ].filter(Boolean);
  // the first words name the branch (run/<slug>-<id>), so they lead with the id
  const id = inc.short ?? inc.key;
  const from = source === "manual" ? `Trigger test ${id}, fired by hand to try the trigger.` : `Sentry issue ${id} came in.`;
  return `${from} ${fence("The issue", lines.join("\n"))}`;
}

/** A new event for an issue the rule takes or ignores. */
export function newEvent(rule: TriggerRule, inc: Incoming, repoId: string, source: TriggerEvent["source"], now: number, ignored: string | null): TriggerEvent {
  return {
    id: crypto.randomUUID().slice(0, 8),
    rule: rule.name,
    source,
    key: inc.key,
    ...(inc.short ? { short: inc.short } : {}),
    title: inc.title,
    ...(inc.culprit ? { culprit: inc.culprit } : {}),
    ...(inc.level ? { level: inc.level } : {}),
    ...(inc.project ? { project: inc.project } : {}),
    ...(inc.link ? { link: inc.link } : {}),
    note: noteFor(inc, source),
    repoId,
    workflow: rule.workflow,
    status: ignored ? "ignored" : "queued",
    ...(ignored ? { reason: ignored, endedAt: now } : {}),
    count: 1,
    firstAt: now,
    lastAt: now,
  };
}

/** How a trigger runs a workflow. One step with a prompt and nothing after
 *  it is a branch run, with that step's task, tools and turns. Anything more
 *  (several steps, a check line, a gate) is a flow on a branch of its own.
 *  A step that asks before the next one starts is refused, since no one is
 *  there to answer; a verdict or judge gate with no gateway key parks the
 *  same way, and the event then waits on Eric. */
export function triggerPlan(wf: Workflow): { kind: "run"; task: string; tools: string[]; turns: number } | { kind: "flow" } | string {
  if (wf.steps.length === 0) return `${wf.name} has no steps`;
  if (!wf.steps.some((s) => s.body)) return `${wf.name} has no step with a prompt`;
  const asks = wf.steps.find((s) => s.gate === "ask");
  if (asks) return `${wf.name}'s ${asks.name} step asks before the next one starts, and no one answers a trigger's run`;
  const only = wf.steps.length === 1 ? wf.steps[0] : undefined;
  if (only?.body && !only.check && only.gate === "continue") return { kind: "run", task: only.body, tools: only.tools, turns: only.turns };
  return { kind: "flow" };
}

/** The event's state as its latest run says. Only moves an event that is
 *  waiting on its run; once a PR is open the PR speaks. */
export function fromRun(e: TriggerEvent, run: Run, now: number): TriggerEvent {
  if (e.runId !== run.id || e.pr || e.flowId) return e;
  const next: TriggerEvent = { ...e };
  if (run.branch) next.branch = run.branch.origin;
  if (run.status === "working" || run.status === "idle") next.status = "working";
  else if (run.status === "waiting") next.status = "waiting";
  else if (run.status === "stopped") {
    next.status = "stopped";
    next.reason = "stopped before it finished";
  } else if (run.status === "failed") {
    next.status = "failed";
    next.reason = run.error ?? "the run failed";
  } else if (run.status === "done") {
    const state = run.branch?.state;
    next.status = state === "nothing" ? "no-fix" : state === "uncommitted" ? "stopped" : "ready";
    if (state === "nothing") next.reason = "the agent committed nothing: it found no fix to make";
    else if (state === "uncommitted") next.reason = "the run ended with changes it did not commit";
    else next.reason = "committed; canopy opens the PR once the landing queue has sorted the branch";
  }
  if (next.status === "no-fix" || next.status === "failed") next.endedAt = now;
  else delete next.endedAt;
  return next;
}

/** The event's state as its flow says, while it follows one. A done flow
 *  reads as working until its worktree has been read into the branch's state. */
export function fromFlow(e: TriggerEvent, flow: Flow, now: number): TriggerEvent {
  if (e.flowId !== flow.id || e.pr) return e;
  const next: TriggerEvent = { ...e };
  const runId = [...flow.steps].reverse().find((s) => s.runId)?.runId;
  if (runId) next.runId = runId;
  if (flow.branch) next.branch = flow.branch.origin;
  delete next.reason;
  const going = flow.status === "working" || flow.status === "waiting" || flow.status === "gated";
  const step = flow.steps[flow.current]?.name;
  if (going && step && flow.steps.length > 1) next.step = step;
  else delete next.step;
  if (flow.status === "working") next.status = "working";
  else if (flow.status === "waiting") next.status = "waiting";
  else if (flow.status === "gated") {
    next.status = "waiting";
    next.reason = flow.steps[flow.current]?.reason ?? "the flow waits at a gate";
  } else if (flow.status === "stopped") {
    next.status = "stopped";
    next.reason = "stopped before it finished";
  } else if (flow.status === "failed") {
    next.status = "failed";
    next.reason = flow.error ?? "the flow failed";
  } else {
    const state = flow.branch?.state;
    if (state === "working" || state === undefined) next.status = "working";
    else if (state === "nothing") {
      next.status = "no-fix";
      next.reason = "the agent committed nothing: it found no fix to make";
    } else if (state === "uncommitted" || state === "stopped") {
      next.status = "stopped";
      next.reason = "the flow ended with changes it did not commit";
    } else {
      next.status = "ready";
      next.reason = "committed; canopy opens the PR once the landing queue has sorted the branch";
    }
  }
  if (next.status === "no-fix" || next.status === "failed") next.endedAt = now;
  else delete next.endedAt;
  return next;
}

/** The event's state as its branch's PR says. */
export function fromPr(e: TriggerEvent, w: PrWatch, now: number): TriggerEvent {
  if (!e.branch || w.id !== e.branch) return e;
  const status: TriggerStatus = w.state?.status === "merged" ? "merged" : w.state?.status === "closed" ? "closed" : "review";
  if (e.status === status && e.pr?.number === w.number && e.runId === w.runId) return e;
  const next: TriggerEvent = { ...e, status, pr: { number: w.number, url: w.url }, runId: w.runId };
  delete next.reason;
  if (status === "review") delete next.endedAt;
  else next.endedAt ??= now;
  return next;
}

/** A committed event the landing queue held back says why: its PR did not
 *  open (no GitHub remote, gh not signed in). The newest held notice for
 *  the event's branch wins. */
export function fromLanding(e: TriggerEvent, notices: readonly LandNotice[]): TriggerEvent {
  if (e.status !== "ready" || !e.branch) return e;
  const held = notices.filter((n) => n.entry === e.branch && n.kind === "held" && n.why).sort((a, b) => b.at - a.at)[0];
  if (!held?.why || held.why === e.reason) return e;
  return { ...e, reason: held.why };
}

/** An event whose run the last server held, after a restart: a run it was
 *  waiting on is gone, so it reads as stopped and resume picks it up. A
 *  flow is kept on disk and taken back by the new server, so an event
 *  following one stays as it is while that flow is known. */
export function afterRestart(e: TriggerEvent, runKnown: (id: string) => boolean, flowKnown: (id: string) => boolean = () => false): TriggerEvent {
  if (e.flowId && flowKnown(e.flowId)) return e;
  if ((e.status === "working" || e.status === "waiting") && (e.flowId || !e.runId || !runKnown(e.runId))) {
    return { ...e, status: "stopped", reason: "a restart cut the run short" };
  }
  return e;
}

/** Whether an event can be resumed: its run stopped and its branch is kept. */
export const resumable = (e: TriggerEvent): boolean => e.status === "stopped" && e.branch !== undefined;

/** Whether an event can be started again from scratch, on a new branch. */
export const retryable = (e: TriggerEvent): boolean => e.status === "failed" || e.status === "no-fix" || (e.status === "stopped" && e.branch === undefined);

/** Whether the run behind an event is still going. */
export const eventLive = (e: TriggerEvent): boolean => e.status === "working" || e.status === "waiting";

/** Kept newest first, at most `KEEP_EVENTS`, but never one still going. */
export function pruneEvents(events: TriggerEvent[]): TriggerEvent[] {
  const sorted = [...events].sort((a, b) => b.lastAt - a.lastAt);
  return sorted.filter((e, i) => i < KEEP_EVENTS || e.status === "queued" || eventLive(e));
}

/** A made-up issue for "try it": the hub fires it as if Sentry had. */
export function sampleIncoming(title: string, now: number): Incoming {
  return {
    key: `manual-${now.toString(36)}`,
    short: "MANUAL",
    title: title.trim().slice(0, 300) || "TypeError: Cannot read properties of undefined (reading 'percent')",
    level: "error",
    detail: ["fired by hand from canopy"],
    frames: [],
  };
}
