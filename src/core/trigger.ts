/** Triggers: outside Sentry, Linear, GitHub and Forgejo events, or a
 *  schedule rule's clock, start unattended branch work. The model, payload
 *  readers, clock and event reducers are pure and browser-safe; the server
 *  hub keeps records and starts runs. */

import { CRON_MAX, nextFire, parseCron } from "./cron";
import { checkWhen } from "./actions";
import { isSeedRepoId } from "./sprout";
import { TRIGGER_ENV_PREFIX } from "./envnames";
import { ISSUE_COMMENTS, type IssueView } from "./issue";
import { fence } from "./pr";
import { unattendedRefusal } from "./workflow";
import type { Flow, LandEntry, LandNotice, PrWatch, Repo, Run, Workflow } from "./types";

export const TRIGGER_SOURCES = ["sentry", "linear", "github", "forgejo", "schedule"] as const;
export type TriggerSource = (typeof TRIGGER_SOURCES)[number];
export const SERVICE_NAME: Record<TriggerSource, string> = { sentry: "Sentry", linear: "Linear", github: "GitHub", forgejo: "Forgejo", schedule: "Schedule" };

export const TRIGGER_LANDS = ["queue", "pr"] as const;
export type TriggerLand = (typeof TRIGGER_LANDS)[number];
export const SCHEDULE_ONLY = ["spec-adopted", "dirty", "unpushed", "clean"] as const;
export type ScheduleOnly = (typeof SCHEDULE_ONLY)[number];

/** A repo passed over by a schedule fire, for its rule's card. */
export interface ScheduleSkip {
  repo: string;
  why: string;
  at: number;
}

/** One line of `<config dir>/triggers.json`: where an event comes from,
 *  which repo it is about and which workflow fixes it. Secrets are named by
 *  the environment variable that holds them, never written here. */
export interface TriggerRule {
  /** the last part of the hook's address: `/api/hooks/<source>/<name>` */
  name: string;
  source: TriggerSource;
  /** the repo's id or absolute path; schedule rules may take every local repo with * */
  repo: string;
  /** a one-step workflow, run on a branch that opens a PR */
  workflow: string;
  /** the env var holding the secret that signs each hook (the Sentry
   *  integration's client secret, the Linear webhook's signing secret); it
   *  starts with `CANOPY_TRIGGER_`, which the server takes out of its env at start.
   *  A github or forgejo rule may leave it out: it then has no hook and polls */
  secretEnv?: string;
  /** github and forgejo: a cron line for polling the repo's labeled issues;
   *  15 minutes by default when there is no hook secret, none when there is */
  poll?: string;
  /** github and forgejo: whether canopy writes back (a comment with the PR's
   *  link, a close on merge); the parsed rule always carries it, true by default */
  write?: boolean;
  /** The schedule in the backend's local time; absent for hooks. */
  cron?: string;
  /** How this rule's branch reaches main. */
  land: TriggerLand;
  /** Schedule filters, combined with AND. */
  only: ScheduleOnly[];
  /** the Sentry project slugs, or the Linear team keys, this rule takes; empty takes every one */
  projects: string[];
  /** the Sentry levels this rule takes; a Linear rule takes none, and its issues carry none */
  levels: string[];
  /** Linear: the labels, by name or id, whose adding starts work */
  labels: string[];
  /** an event whose title holds one of these is recorded as ignored */
  ignore: string[];
  /** the env var holding a token that writes back: a Sentry token resolves
   *  the issue on merge, a Linear API key comments the PR's link and moves the
   *  issue to done; unset leaves the issue as it is */
  tokenEnv?: string;
  /** the Sentry organisation slug, for the resolve call */
  org?: string;
  /** the service's API address, for the calls that write back */
  api: string;
  /** Linear: the OAuth app's client id. With `clientSecretEnv` it turns the
   *  agent on: delegating an issue to the app, or mentioning it, starts the run */
  clientId?: string;
  /** Linear: the env var holding the OAuth app's client secret, which mints
   *  the app's own token (the client credentials grant), kept in memory only */
  clientSecretEnv?: string;
  /** Linear: the workspace's id; a delivery from any other workspace is
   *  passed over, so an app installed elsewhere starts nothing here */
  organization?: string;
}

/** What canopy says about a rule on the page: no secret, only whether it is set. */
export interface TriggerRuleInfo extends TriggerRule {
  hook?: string;
  next?: number;
  lastFire?: number;
  skips?: ScheduleSkip[];
  secretSet: boolean;
  tokenSet: boolean;
  /** Linear: the app's client secret is set, so the agent can answer */
  agentSet: boolean;
  /** Linear: the path that installs the rule's app in a workspace, when it has one */
  install?: string;
  /** why the rule cannot fire: an unknown repo or workflow, a bad line */
  problem?: string;
  /** when the poll next runs, as epoch ms, for a rule that polls */
  nextFire?: number;
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
  /** the rule's service, so a test fire still names it; absent on an event
   *  written while Sentry was the only one */
  service?: TriggerSource;
  /** the outside issue's id: one event, so one PR, per issue */
  key: string;
  /** the id people read: Sentry's PROJECT-1A, Linear's ENG-123 */
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
  /** Absent on legacy events, which opened a PR. */
  land?: TriggerLand;
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
  /** the branch's work item (FR-037) */
  work?: string;
  pr?: { number: number; url: string };
  /** set once the merge marked the issue resolved where it came from, or why that failed */
  resolved?: { at: number } | { error: string };
  /** Linear: set once the PR's link was commented on the issue, or added to
   *  the agent session, or why that failed */
  linked?: { at: number } | { error: string };
  /** Linear: the agent session the event reports to, when the issue was
   *  delegated to canopy or canopy was mentioned on it */
  session?: string;
  /** the run's closing message, which a Linear agent session is shown */
  summary?: string;
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
  | { kind: "skip"; why: string }
  | { kind: "fired"; events: TriggerEvent[]; skipped: ScheduleSkip[] };

/** An outside issue as a rule reads it, before it is an event. */
export interface Incoming {
  key: string;
  short?: string;
  title: string;
  culprit?: string;
  level?: string;
  project?: string;
  link?: string;
  /** the exception's type and message, the file and function Sentry names;
   *  a Linear issue's state, priority and labels */
  detail: string[];
  /** in-app stack frames, innermost last */
  frames: string[];
  /** a Linear issue's description, cut to `MAX_DESCRIPTION` */
  description?: string;
  /** a Linear issue's state type: triage, backlog, unstarted, started, completed or canceled */
  stateType?: string;
  /** a Linear agent session's context: the issue, its comments and the
   *  workspace's guidance, as Linear formats it */
  context?: string;
  /** a GitHub or Forgejo issue's newest comments, at most `ISSUE_COMMENTS`,
   *  oldest first; a hook delivery carries none, the detail read fills them */
  comments?: { author: string; body: string }[];
}

export const KEEP_EVENTS = 200;
/** the most of an issue's description the run's note carries */
export const MAX_DESCRIPTION = 6000;
/** the most of one comment the run's note carries */
const MAX_COMMENT = 4000;
/** how many open issues one poll reads in full per rule, oldest first, after
 *  the ones it knows are dropped from a listing of `LIST_ISSUES`
 *  (core/issue.ts); the rest wait for the next tick */
export const POLL_ISSUES = 50;
/** how far a Linear delivery's `webhookTimestamp` may sit from canopy's clock */
export const LINEAR_SKEW = 60_000;
const NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;
const ENV = /^[A-Z_][A-Z0-9_]*$/;
const DEFAULT_LEVELS = ["error", "fatal"];
const DEFAULTS: Record<TriggerSource, { workflow: string; api: string; labels: string[]; levels: string[] }> = {
  sentry: { workflow: "sentry-fix", api: "https://sentry.io", labels: [], levels: DEFAULT_LEVELS },
  linear: { workflow: "linear-issue", api: "https://api.linear.app", labels: ["canopy"], levels: [] },
  github: { workflow: "issue-fix", api: "https://api.github.com", labels: ["canopy"], levels: [] },
  forgejo: { workflow: "issue-fix", api: "", labels: ["canopy"], levels: [] },
  schedule: { workflow: "spec-converge", api: "", labels: [], levels: [] },
};
const DEFAULT_POLL = "*/15 * * * *";

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
  const raw = str(item, "source") ?? "sentry";
  const source = TRIGGER_SOURCES.find((value) => value === raw);
  if (!source) throw new Error(`source must be one of ${TRIGGER_SOURCES.join(", ")}, not ${raw}`);
  const defaults = DEFAULTS[source];
  const repo = str(item, "repo");
  if (!repo) throw new Error("repo is required: the repo's id or absolute path");
  const workflow = str(item, "workflow") ?? defaults.workflow;
  const issues = source === "github" || source === "forgejo";
  if (repo === "*" && source !== "schedule") throw new Error('repo "*" is allowed only on a schedule rule');
  const cron = str(item, "cron");
  if (source === "schedule") {
    if (!cron) throw new Error("cron is required on a schedule rule: five fields, minute hour day-of-month month day-of-week");
    if (cron.length > CRON_MAX) throw new Error(`cron must be at most ${CRON_MAX} characters`);
    const parsed = parseCron(cron);
    if ("error" in parsed) throw new Error(`cron: ${parsed.error}`);
  } else if (item["cron"] !== undefined) throw new Error("cron is for a schedule rule");
  const secretEnv = str(item, "secretEnv");
  if (source === "schedule") {
    if (item["secretEnv"] !== undefined) throw new Error("secretEnv is not read by a schedule rule: nothing signs a clock");
  } else {
    if ((!secretEnv && !issues) || (secretEnv !== undefined && !ENV.test(secretEnv))) throw new Error("secretEnv must name the environment variable holding the hook's secret");
    if (secretEnv !== undefined && !secretEnv.startsWith(TRIGGER_ENV_PREFIX)) throw new Error(`secretEnv must start with ${TRIGGER_ENV_PREFIX}, so canopy keeps it from every run and shell, not ${secretEnv}`);
  }
  const rawLand = item["land"];
  if (rawLand !== undefined && rawLand !== "queue" && rawLand !== "pr") throw new Error(`land must be queue or pr, not ${String(rawLand)}`);
  const land = rawLand ?? ((source === "schedule" || source === "forgejo") ? "queue" : "pr");
  if (item["only"] !== undefined && source !== "schedule") throw new Error("only is for a schedule rule");
  const only: ScheduleOnly[] = [];
  for (const value of strings(item["only"], "only")) {
    const known = SCHEDULE_ONLY.find((word) => word === value);
    if (!known) throw new Error(`only must be some of ${SCHEDULE_ONLY.join(", ")}, not ${value}`);
    only.push(known);
  }
  if (source === "schedule") {
    for (const key of ["projects", "levels", "ignore", "org", "api"]) {
      if (item[key] !== undefined) throw new Error(`${key} is not read by a schedule rule`);
    }
    for (const key of ["labels", "clientId", "clientSecretEnv", "organization"]) {
      if (item[key] !== undefined) throw new Error(`${key} is for a linear rule`);
    }
  }
  const clientId = str(item, "clientId");
  const clientSecretEnv = str(item, "clientSecretEnv");
  if ((clientId === undefined) !== (clientSecretEnv === undefined)) throw new Error("clientId and clientSecretEnv go together: both turn the Linear agent on");
  if (clientId !== undefined && source !== "linear") throw new Error("clientId is for a linear rule");
  if (clientSecretEnv !== undefined && !ENV.test(clientSecretEnv)) throw new Error(`clientSecretEnv must name an environment variable, not ${clientSecretEnv}`);
  if (clientSecretEnv !== undefined && !clientSecretEnv.startsWith(TRIGGER_ENV_PREFIX)) throw new Error(`clientSecretEnv must start with ${TRIGGER_ENV_PREFIX}, so canopy keeps it from every run and shell, not ${clientSecretEnv}`);
  const organization = str(item, "organization");
  if (organization !== undefined && source !== "linear") throw new Error("organization is for a linear rule");
  const tokenEnv = str(item, "tokenEnv");
  if (tokenEnv !== undefined && !ENV.test(tokenEnv)) throw new Error(`tokenEnv must name an environment variable, not ${tokenEnv}`);
  if (tokenEnv !== undefined && !tokenEnv.startsWith(TRIGGER_ENV_PREFIX)) throw new Error(`tokenEnv must start with ${TRIGGER_ENV_PREFIX}, so canopy keeps it from every run and shell, not ${tokenEnv}`);
  const levels = strings(item["levels"], "levels").map((l) => l.toLowerCase());
  const labels = strings(item["labels"], "labels");
  if (labels.length && source === "sentry") throw new Error("labels is for a linear rule, or a github or forgejo one");
  const org = str(item, "org");
  const projects = strings(item["projects"], "projects");
  if (issues) {
    if (projects.length) throw new Error(`projects is not for a ${source} rule`);
    if (levels.length) throw new Error(`levels is not for a ${source} rule`);
    if (org !== undefined) throw new Error(`org is not for a ${source} rule`);
  }
  const write = item["write"];
  if (write !== undefined && !issues) throw new Error("write is for a github or forgejo rule");
  if (write !== undefined && typeof write !== "boolean") throw new Error("write must be true or false");
  const pollRaw = item["poll"];
  if (pollRaw !== undefined && !issues) throw new Error("poll is for a github or forgejo rule");
  if (pollRaw !== undefined && (typeof pollRaw !== "string" || !pollRaw.trim())) throw new Error("poll must be a cron line such as */15 * * * *");
  const given = typeof pollRaw === "string" ? pollRaw.trim() : undefined;
  if (given !== undefined) {
    if (given.length > CRON_MAX) throw new Error(`poll must be at most ${CRON_MAX} characters`);
    const cron = parseCron(given);
    if ("error" in cron) throw new Error(`poll is not a cron line: ${cron.error}`);
  }
  const poll = given ?? (issues && secretEnv === undefined ? DEFAULT_POLL : undefined);
  const apiRaw = str(item, "api");
  if (source === "forgejo" && !apiRaw) throw new Error("api is required for a forgejo rule: the server's address, such as https://git.example.com");
  const api = (apiRaw ?? defaults.api).replace(/\/+$/, "");
  if (source !== "schedule" && !/^https?:\/\//.test(api)) throw new Error(`api must be an http(s) address, not ${api}`);
  return {
    name,
    source,
    repo,
    workflow,
    ...(secretEnv ? { secretEnv } : {}),
    ...(cron ? { cron } : {}),
    land,
    only,
    ...(poll ? { poll } : {}),
    ...(issues ? { write: write ?? true } : {}),
    projects,
    levels: levels.length ? levels : defaults.levels,
    labels: labels.length ? labels : defaults.labels,
    ignore: strings(item["ignore"], "ignore"),
    ...(tokenEnv ? { tokenEnv } : {}),
    ...(org ? { org } : {}),
    api,
    ...(clientId && clientSecretEnv ? { clientId, clientSecretEnv } : {}),
    ...(organization ? { organization } : {}),
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

/** A Linear webhook's body as an issue, when one of `labels` is new on it:
 *  the issue was created with it, or an update added it. A label matches by
 *  name, ignoring case, or by id, since a body may carry `labelIds` alone.
 *  Anything else (another type, a removal, an update that leaves the labels
 *  alone) is null. */
export function parseLinear(body: unknown, labels: readonly string[]): Incoming | null {
  if (!isRecord(body) || str(body, "type") !== "Issue") return null;
  const action = str(body, "action");
  const data = isRecord(body["data"]) ? body["data"] : null;
  if (!data || (action !== "create" && action !== "update")) return null;
  const key = str(data, "id");
  if (!key) return null;
  const want = new Set(labels.map((l) => l.toLowerCase()));
  const named = Array.isArray(data["labels"]) ? data["labels"].filter(isRecord) : [];
  const ids = new Set([...idsOf(data["labelIds"]), ...named.map((l) => str(l, "id")).filter((x): x is string => x !== undefined)]);
  const hits = [...ids].filter((id) => want.has(id.toLowerCase()) || named.some((l) => str(l, "id") === id && want.has((str(l, "name") ?? "").toLowerCase())));
  if (action === "update") {
    const from = isRecord(body["updatedFrom"]) ? body["updatedFrom"] : null;
    if (!from || !Array.isArray(from["labelIds"])) return null;
    const before = new Set(idsOf(from["labelIds"]));
    if (!hits.some((id) => !before.has(id))) return null;
  } else if (!hits.length) return null;
  const short = str(data, "identifier");
  const team = isRecord(data["team"]) ? data["team"] : {};
  const state = isRecord(data["state"]) ? data["state"] : {};
  const project = str(team, "key") ?? short?.split("-")[0];
  const link = str(body, "url") ?? str(data, "url");
  const description = str(data, "description")?.slice(0, MAX_DESCRIPTION);
  const stateType = str(state, "type");
  const names = named.map((l) => str(l, "name")).filter((x): x is string => x !== undefined);
  const detail = [
    str(state, "name") ? `state: ${str(state, "name")}` : undefined,
    str(data, "priorityLabel") ? `priority: ${str(data, "priorityLabel")}` : undefined,
    names.length ? `labels: ${names.join(", ")}` : undefined,
  ].filter((x): x is string => x !== undefined);
  return {
    key,
    title: (str(data, "title") ?? "an untitled Linear issue").slice(0, 300),
    ...(short ? { short } : {}),
    ...(project ? { project } : {}),
    ...(link && /^https?:\/\//.test(link) ? { link } : {}),
    detail,
    frames: [],
    ...(description ? { description } : {}),
    ...(stateType ? { stateType } : {}),
  };
}

const idsOf = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

/** A GitHub `issues` delivery as an issue, when the label added is one of
 *  `labels` and the issue is open and not a pull request. Anything else
 *  (another action, another label, a closed issue, a PR) is null. The
 *  delivery carries no comments; the detail read fills them in. */
export function parseGithubIssue(body: unknown, labels: readonly string[]): Incoming | null {
  if (!isRecord(body) || str(body, "action") !== "labeled") return null;
  const added = isRecord(body["label"]) ? str(body["label"], "name") : undefined;
  if (!added || !hasLabel(labels, [added])) return null;
  const issue = openIssue(body["issue"]);
  return issue ? incomingFromIssueView(issue) : null;
}

/** A Forgejo `issues` delivery as an issue: its labels were updated, or it
 *  was opened with labels on, and one of `labels` is on the open issue. The
 *  delivery names every label the issue has, not the one that changed, so
 *  any later update on the same issue finds its event through `knownEvent`
 *  whatever state it is in. */
export function parseForgejoIssue(body: unknown, labels: readonly string[]): Incoming | null {
  if (!isRecord(body)) return null;
  const action = str(body, "action");
  if (action !== "label_updated" && action !== "opened") return null;
  const issue = openIssue(body["issue"]);
  return issue && hasLabel(labels, issue.labels) ? incomingFromIssueView(issue) : null;
}

/** whether one of the rule's labels is among `names`, by name, ignoring case */
const hasLabel = (labels: readonly string[], names: readonly string[]): boolean => names.some((n) => labels.some((l) => l.toLowerCase() === n.toLowerCase()));

/** The issue object a GitHub or Forgejo delivery carries, as an `IssueView`
 *  with no comments, or null when it is closed, a pull request (GitHub puts
 *  a `pull_request` key on one, Forgejo sets it where an issue has null) or
 *  not an issue at all. */
function openIssue(v: unknown): IssueView | null {
  if (!isRecord(v) || typeof v["number"] !== "number" || str(v, "state") !== "open" || v["pull_request"]) return null;
  const labels = Array.isArray(v["labels"]) ? v["labels"].filter(isRecord).map((l) => str(l, "name")).filter((x): x is string => x !== undefined) : [];
  return { number: v["number"], title: str(v, "title") ?? "", body: typeof v["body"] === "string" ? v["body"] : "", url: str(v, "html_url") ?? "", labels, comments: [] };
}

/** An issue as gh or the Forgejo API gives it, as the incoming shape a hook
 *  delivery takes, so a polled issue and a delivered one make the same event
 *  and the same note: the number keys it, the body is its description, the
 *  labels are its detail, and the newest `ISSUE_COMMENTS` comments ride along. */
export function incomingFromIssueView(issue: IssueView): Incoming {
  const title = issue.title.replace(/\s+/g, " ").trim();
  const description = issue.body.trim().slice(0, MAX_DESCRIPTION);
  const comments = issue.comments.slice(-ISSUE_COMMENTS).map((c) => ({ author: c.author, body: c.body.trim().slice(0, MAX_COMMENT) }));
  return {
    key: String(issue.number),
    short: `#${issue.number}`,
    title: (title || "an untitled issue").slice(0, 300),
    ...(issue.url && /^https?:\/\//.test(issue.url) ? { link: issue.url } : {}),
    detail: issue.labels.length ? [`labels: ${issue.labels.join(", ")}`] : [],
    frames: [],
    ...(description ? { description } : {}),
    ...(comments.length ? { comments } : {}),
  };
}

/** A Linear agent session event: a new session (the issue delegated to
 *  canopy, or canopy mentioned on it), or a message in one. */
export type AgentDelivery =
  /** `inc` is null when the session is not on an issue (a mention in a document) */
  | { kind: "created"; session: string; inc: Incoming | null }
  /** `stop` is the user's stop button; otherwise `text` is what they wrote */
  | { kind: "prompted"; session: string; text: string; stop: boolean };

/** An `AgentSessionEvent` delivery, read tolerantly: Linear's docs name the
 *  fields but show no whole payload, so the context and the message are
 *  looked for in each place they could sit. Anything else is null. */
export function parseAgentEvent(body: unknown): AgentDelivery | null {
  if (!isRecord(body) || str(body, "type") !== "AgentSessionEvent") return null;
  const agentSession = isRecord(body["agentSession"]) ? body["agentSession"] : null;
  const session = agentSession ? str(agentSession, "id") : undefined;
  if (!agentSession || !session) return null;
  const action = str(body, "action");
  if (action === "prompted") {
    const act = isRecord(body["agentActivity"]) ? body["agentActivity"] : {};
    const content = isRecord(act["content"]) ? act["content"] : {};
    const text = (str(act, "body") ?? str(content, "body") ?? "").slice(0, MAX_DESCRIPTION);
    return { kind: "prompted", session, text, stop: str(act, "signal") === "stop" };
  }
  if (action !== "created") return null;
  const issue = isRecord(agentSession["issue"]) ? agentSession["issue"] : null;
  const key = issue ? str(issue, "id") : undefined;
  if (!issue || !key) return { kind: "created", session, inc: null };
  const short = str(issue, "identifier");
  const team = isRecord(issue["team"]) ? issue["team"] : {};
  const state = isRecord(issue["state"]) ? issue["state"] : {};
  const project = str(team, "key") ?? short?.split("-")[0];
  const link = str(issue, "url");
  const description = str(issue, "description")?.slice(0, MAX_DESCRIPTION);
  const context = (str(body, "promptContext") ?? str(agentSession, "promptContext"))?.slice(0, MAX_DESCRIPTION);
  const comment = isRecord(agentSession["comment"]) ? str(agentSession["comment"], "body") : undefined;
  const stateType = str(state, "type");
  return {
    kind: "created",
    session,
    inc: {
      key,
      title: (str(issue, "title") ?? "an untitled Linear issue").slice(0, 300),
      ...(short ? { short } : {}),
      ...(project ? { project } : {}),
      ...(link && /^https?:\/\//.test(link) ? { link } : {}),
      detail: [str(state, "name") ? `state: ${str(state, "name")}` : undefined, comment ? `asked in a comment: ${comment.slice(0, 2000)}` : undefined].filter((x): x is string => x !== undefined),
      frames: [],
      ...(description ? { description } : {}),
      ...(stateType ? { stateType } : {}),
      ...(context ? { context } : {}),
    },
  };
}

/** Whether a Linear delivery comes from a workspace other than the rule's,
 *  when the rule names one. */
export function otherWorkspace(rule: TriggerRule, body: unknown): boolean {
  if (!rule.organization) return false;
  return !isRecord(body) || str(body, "organizationId") !== rule.organization;
}

/** where Linear asks a workspace admin to install an app */
export const LINEAR_AUTHORIZE = "https://linear.app/oauth/authorize";
/** what the app may do: read and write, and be delegated issues and mentioned */
export const LINEAR_APP_SCOPES = "read,write,app:assignable,app:mentionable";

/** The address that installs a rule's Linear app as itself (`actor=app`):
 *  a workspace admin consents there, and Linear sends them back to `redirect`. */
export function linearInstallUrl(rule: TriggerRule, redirect: string, state: string): string | null {
  if (!rule.clientId) return null;
  const q = new URLSearchParams({ client_id: rule.clientId, redirect_uri: redirect, response_type: "code", scope: LINEAR_APP_SCOPES, actor: "app", state, prompt: "consent" });
  return `${LINEAR_AUTHORIZE}?${q.toString()}`;
}

/** Whether a Linear delivery was sent within `LINEAR_SKEW` of now, by its
 *  `webhookTimestamp`: an old signed body replayed is refused. */
export function linearFresh(body: unknown, now: number): boolean {
  const at = isRecord(body) ? body["webhookTimestamp"] : undefined;
  return typeof at === "number" && Math.abs(now - at) <= LINEAR_SKEW;
}

/** Why a rule passes this issue over, or null when it takes it. */
export function ignoreReason(rule: TriggerRule, inc: Incoming): string | null {
  if (rule.projects.length && (!inc.project || !rule.projects.includes(inc.project))) {
    return `${rule.source === "linear" ? "team" : "project"} ${inc.project ?? "unknown"} is not one this rule takes`;
  }
  if (inc.stateType === "completed" || inc.stateType === "canceled") return `the issue is already ${inc.stateType}`;
  if (inc.level && !rule.levels.includes(inc.level)) return `level ${inc.level} is not one this rule takes`;
  const hit = rule.ignore.find((w) => inc.title.toLowerCase().includes(w.toLowerCase()));
  return hit ? `the title holds "${hit}", on the rule's ignore list` : null;
}

/** States after which the same issue coming in again starts a new event:
 *  canopy could not start it, its PR was closed unmerged, or it was fixed
 *  and came back. Any other
 *  state, open or ended, keeps it to one event and one PR. */
const AGAIN: readonly TriggerStatus[] = ["failed", "merged", "closed", "ignored"];

/** The newest event this issue has under this rule, in any state. A poll
 *  checks this one: an issue still labelled carries no word that it is
 *  meant again, so it starts over only by Retry, a dismiss, or a hook's
 *  delivery of the label. */
export function anyEvent(events: readonly TriggerEvent[], rule: string, key: string): TriggerEvent | undefined {
  return events.filter((e) => e.rule === rule && e.key === key).sort((a, b) => b.firstAt - a.firstAt)[0];
}

/** The event this issue already has under this rule, when one counts. */
export function existing(events: readonly TriggerEvent[], rule: string, key: string): TriggerEvent | undefined {
  const same = anyEvent(events, rule, key);
  return same && !AGAIN.includes(same.status) ? same : undefined;
}

/** The event a delivery of this issue bumps instead of starting another:
 *  `existing` as a rule, since Sentry's alert, Linear's label and GitHub's
 *  `labeled` delivery each say the issue is meant again after an event in
 *  `AGAIN`; but on Forgejo any event at all, since its `label_updated`
 *  delivery lists every label the issue has and not the one that changed,
 *  so a label edit says nothing about canopy's. A Forgejo issue starts
 *  over by Retry or a dismiss, as a polled one does. */
export function knownEvent(events: readonly TriggerEvent[], rule: TriggerRule, key: string): TriggerEvent | undefined {
  return rule.source === "forgejo" ? anyEvent(events, rule.name, key) : existing(events, rule.name, key);
}

/** The run's first message after the workflow's task: the issue, fenced as
 *  data, since anyone who can make the app throw, or write in the Linear
 *  workspace, or file an issue on the repo, chooses its words. */
export function noteFor(inc: Incoming, source: TriggerEvent["source"], service: TriggerSource = "sentry"): string {
  const lines = [
    `title: ${inc.title}`,
    inc.short ? `id: ${inc.short}` : "",
    inc.culprit ? `culprit: ${inc.culprit}` : "",
    inc.level ? `level: ${inc.level}` : "",
    inc.project ? `${service === "linear" ? "team" : "project"}: ${inc.project}` : "",
    inc.link ? `link: ${inc.link}` : "",
    ...inc.detail,
    inc.frames.length ? `stack, innermost last:\n${inc.frames.map((f) => `  ${f}`).join("\n")}` : "",
    inc.description ? `description:\n${inc.description}` : "",
    inc.context ? `context from Linear:\n${inc.context}` : "",
    ...(inc.comments ?? []).map((c) => `comment by ${c.author}:\n${c.body}`),
  ].filter(Boolean);
  // the first words name the branch (run/<work id>-<slug>), so they lead with the
  // id; Linear's GitHub integration links a PR to the issue its branch names
  const id = inc.short ?? inc.key;
  const from = source === "manual" ? `Trigger test ${id}, fired by hand to try the trigger.` : `${SERVICE_NAME[service]} issue ${id} came in.`;
  return `${from} ${fence("The issue", lines.join("\n"))}`;
}

/** A new event for an issue the rule takes or ignores. */
export function newEvent(rule: TriggerRule, inc: Incoming, repoId: string, source: TriggerEvent["source"], now: number, ignored: string | null): TriggerEvent {
  return {
    id: crypto.randomUUID().slice(0, 8),
    rule: rule.name,
    source,
    service: rule.source,
    key: inc.key,
    ...(inc.short ? { short: inc.short } : {}),
    title: inc.title,
    ...(inc.culprit ? { culprit: inc.culprit } : {}),
    ...(inc.level ? { level: inc.level } : {}),
    ...(inc.project ? { project: inc.project } : {}),
    ...(inc.link ? { link: inc.link } : {}),
    note: noteFor(inc, source, rule.source),
    repoId,
    workflow: rule.workflow,
    land: rule.land,
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
 *  A step that asks, or waits for a go, is refused, since no one is there.
 *  A verdict or judge gate with no gateway key parks the same way, and
 *  the event then waits on Eric. */
export function triggerPlan(wf: Workflow): { kind: "run"; task: string; tools: string[]; turns: number } | { kind: "flow" } | string {
  if (wf.steps.length === 0) return `${wf.name} has no steps`;
  if (!wf.steps.some((s) => s.body)) return `${wf.name} has no step with a prompt`;
  const refusal = unattendedRefusal(wf, "a trigger's run");
  if (refusal) return refusal;
  const only = wf.steps.length === 1 ? wf.steps[0] : undefined;
  if (only?.body && !only.check && only.gate === "continue") return { kind: "run", task: only.body, tools: only.tools, turns: only.turns };
  return { kind: "flow" };
}

/** The event's state as its latest run says. Only moves an event that is
 *  waiting on its run; once a PR is open the PR speaks. */
export function fromRun(e: TriggerEvent, run: Run, now: number): TriggerEvent {
  if (e.runId !== run.id || e.pr || e.flowId || e.status === "merged") return e;
  const next: TriggerEvent = { ...e };
  if (run.branch) next.branch = run.branch.origin;
  if (run.status === "working" || run.status === "idle") next.status = "working";
  else if (run.status === "waiting") next.status = "waiting";
  else if (run.status === "stopped") {
    next.status = "stopped";
    next.reason = "stopped before it finished";
  } else if (run.status === "limited") {
    next.status = "stopped";
    next.reason = `waiting for capacity: ${run.limited?.text || run.error || "the plan's usage limit"}`;
  } else if (run.status === "failed") {
    next.status = "failed";
    next.reason = run.error ?? "the run failed";
  } else if (run.status === "done") {
    if (run.result?.text.trim()) next.summary = run.result.text.trim().slice(0, 2000);
    // the worktree is read just after the run ends; until then the branch
    // still says working, and the event does too
    const state = run.branch?.state;
    next.status = state === "working" ? "working" : state === "nothing" ? "no-fix" : state === "uncommitted" ? "stopped" : "ready";
    if (state === "nothing") next.reason = "the agent committed nothing: it found no fix to make";
    else if (state === "uncommitted") next.reason = "the run ended with changes it did not commit";
    else if (state !== "working") next.reason = opensPr(e) ? "committed; canopy opens the PR once the landing queue has sorted the branch" : "committed; the landing queue sorts the branch";
  }
  if (next.status === "no-fix" || next.status === "failed") next.endedAt = now;
  else delete next.endedAt;
  return next;
}

/** The event's state as its flow says, while it follows one. A done flow
 *  reads as working until its worktree has been read into the branch's state. */
export function fromFlow(e: TriggerEvent, flow: Flow, now: number): TriggerEvent {
  if (e.flowId !== flow.id || e.pr || e.status === "merged") return e;
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
      next.reason = opensPr(e) ? "committed; canopy opens the PR once the landing queue has sorted the branch" : "committed; the landing queue sorts the branch";
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

/** Whether an event's run opens a PR when it settles ready. A Forgejo run
 *  lands through the landing queue instead: canopy opens PRs with gh,
 *  which is GitHub's, and the queue is canopy's own merge. An event written
 *  before services were named is Sentry's. */
export const opensPr = (e: Pick<TriggerEvent, "service" | "land">): boolean => e.land !== undefined ? e.land === "pr" : e.service !== "forgejo" && e.service !== "schedule";

/** A committed event follows its landing entry, including a manual landing
 *  that raises no quiet notice. The newest queue or approval observation wins. */
export function fromLanding(e: TriggerEvent, notices: readonly LandNotice[], entries: readonly LandEntry[] = []): TriggerEvent {
  if (e.status !== "ready" || !e.branch) return e;
  const entry = entries.find((item) => item.id === e.branch);
  const landed = notices.filter((n) => n.entry === e.branch && n.kind === "landed").sort((a, b) => b.at - a.at)[0];
  if (entry?.state === "landed" || landed) {
    const next: TriggerEvent = { ...e, status: "merged", endedAt: entry?.landedAt ?? landed?.at ?? e.lastAt };
    delete next.reason;
    return next;
  }
  const held = notices.filter((n) => n.entry === e.branch && n.kind === "held" && n.why).sort((a, b) => b.at - a.at)[0];
  const queueWhy = entry && ["waiting", "judge", "conflict", "red", "moved"].includes(entry.state) ? entry.reason : undefined;
  const reason = queueWhy && (!held || (entry?.updatedAt ?? 0) >= held.at) ? queueWhy : held?.why;
  return !reason || reason === e.reason ? e : { ...e, reason };
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

/** What a Linear agent session is shown: Linear's activity content types. */
export type AgentActivity =
  | { type: "thought"; body: string }
  | { type: "action"; action: string; parameter: string; result?: string }
  | { type: "response"; body: string }
  | { type: "error"; body: string };

/** The activity an event's move tells its agent session, or null when the
 *  move is nothing the session needs to hear. `prev` is the event before
 *  the move, or undefined for a new one. Pure, so each wording is tested. */
export function activityFor(prev: TriggerEvent | undefined, next: TriggerEvent): AgentActivity | null {
  if (!next.session) return null;
  const moved = prev?.status !== next.status;
  const pr = next.pr ? `[pull request #${next.pr.number}](${next.pr.url})` : "the pull request";
  const said = (lead: string) => (next.summary ? `${lead}\n\n${next.summary}` : lead);
  if (!moved) {
    return next.status === "working" && next.step && prev?.step !== next.step ? { type: "action", action: "Working", parameter: `step ${next.step}` } : null;
  }
  switch (next.status) {
    case "queued":
      return prev ? { type: "thought", body: `Waiting for a free branch slot in ${next.repoId}${next.reason ? `: ${next.reason}` : ""}.` } : null;
    case "working":
      return { type: "action", action: "Working", parameter: next.step ? `step ${next.step}` : `${next.repoId}, on a branch of its own` };
    case "waiting":
      return { type: "thought", body: `Waiting in canopy: ${next.reason ?? "the run asks something"}.` };
    case "stopped":
      return { type: "response", body: `Stopped: ${next.reason ?? "the run ended early"}.${next.branch ? " Write here to carry on from where it stopped, on the same branch." : ""}` };
    case "failed":
      return { type: "error", body: next.reason ?? "the run failed" };
    case "no-fix":
      return { type: "response", body: said("Nothing committed: the run made no change.") };
    case "ready":
      return { type: "thought", body: "Committed on the branch; canopy opens the pull request once its checks pass." };
    case "review":
      return { type: "response", body: said(`Opened ${pr}.`) };
    case "merged":
      return { type: "response", body: `Merged ${pr}.` };
    case "closed":
      return { type: "response", body: `Closed ${pr} without merging it.` };
    case "ignored":
      return { type: "response", body: `Not taking this one: ${next.reason ?? "the rule passes it over"}.` };
  }
}

/** The services whose issues canopy comments on: a note when a run ends
 *  without a PR, the PR's link. Sentry's issues are only resolved. */
const COMMENTED: ReadonlySet<string> = new Set<TriggerSource>(["linear", "github", "forgejo"]);

/** The comment a labeled Linear, GitHub or Forgejo issue gets when its run
 *  ends without a PR, so whoever labeled it hears why, or null. An issue
 *  with an agent session hears through `activityFor` instead, and a test
 *  fire tells the service nothing. `origin` is canopy's public address,
 *  for the way to retry. */
export function issueNoteFor(prev: TriggerEvent | undefined, next: TriggerEvent, origin?: string): string | null {
  if (!next.service || !COMMENTED.has(next.service) || next.source === "manual" || next.session || prev?.status === next.status) return null;
  const lead =
    next.status === "no-fix"
      ? "canopy ran on this issue and committed nothing."
      : next.status === "failed"
        ? `canopy's run on this issue failed: ${(next.reason ?? "the run failed").replace(/\.+$/, "")}.`
        : null;
  if (!lead) return null;
  const said = next.status === "no-fix" && next.summary ? `\n\n${next.summary}` : "";
  const retry = origin ? `\n\nTo try again, use Retry on [canopy's triggers page](${origin.replace(/\/+$/, "")}/?view=triggers).` : "";
  return `${lead}${said}${retry}`;
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

/** The title a test fire takes when none is typed. */
export const SAMPLE_TITLE: Record<TriggerSource, string> = {
  sentry: "TypeError: Cannot read properties of undefined (reading 'percent')",
  linear: "Show the last sync time on the settings page",
  github: "Show the last sync time on the settings page",
  forgejo: "Show the last sync time on the settings page",
  schedule: "fired by hand",
};

/** A made-up issue for "try it": the hub fires it as if the service had. */
export function sampleIncoming(title: string, now: number, service: TriggerSource = "sentry"): Incoming {
  return {
    key: `manual-${now.toString(36)}`,
    short: "MANUAL",
    title: title.trim().slice(0, 300) || SAMPLE_TITLE[service],
    ...(service === "sentry" ? { level: "error" } : {}),
    detail: ["fired by hand from canopy"],
    frames: [],
  };
}


/* ---------- the schedule source (FR-041) ---------- */

export const SCHEDULE_CATCH_UP = 60 * 60 * 1000;
export const SKIPS_KEPT = 20;
export const fireMinute = (at: number): number => Math.floor(at / 60_000) * 60_000;
export const scheduleKey = (repoKey: string, at: number): string => `${repoKey}@${new Date(fireMinute(at)).toISOString()}`;

/** Creation time, rather than later run/PR updates, anchors a rule's next fire. */
export function lastFire(rule: string, events: readonly TriggerEvent[]): number | null {
  let latest: number | null = null;
  for (const event of events) {
    if (event.rule === rule && event.service === "schedule" && Number.isFinite(event.firstAt)) latest = Math.max(latest ?? event.firstAt, event.firstAt);
  }
  return latest;
}

export function nextFireOf(rule: TriggerRule, last: number): number | null {
  if (rule.source !== "schedule" || !rule.cron || !Number.isFinite(last)) return null;
  const cron = parseCron(rule.cron);
  return "error" in cron ? null : nextFire(cron, last);
}

/** All wildcard filters must hold; an unreadable repo never qualifies. */
export function takesRepo(rule: TriggerRule, repo: Repo): boolean {
  if (repo.error) return false;
  return rule.only.every((only) => {
    switch (only) {
      case "spec-adopted": return repo.spec !== undefined && repo.spec !== "not-adopted";
      case "dirty": return checkWhen(repo, "dirty").ok;
      case "unpushed": return checkWhen(repo, "unpushed").ok;
      case "clean": return !checkWhen(repo, "dirty").ok;
    }
  });
}

export function scheduleRepos(rule: TriggerRule, repos: readonly Repo[]): Repo[] {
  const local = repos.filter((repo) => !repo.host && !repo.forge && !isSeedRepoId(repo.id) && !repo.error);
  return rule.repo === "*" ? local.filter((repo) => takesRepo(rule, repo)) : local.filter((repo) => repo.id === rule.repo || repo.path === rule.repo);
}

export function scheduleBusy(events: readonly TriggerEvent[], rule: string, repoId: string): boolean {
  let latest: TriggerEvent | undefined;
  for (const event of events) {
    if (event.rule === rule && event.repoId === repoId && (!latest || event.lastAt > latest.lastAt)) latest = event;
  }
  return latest !== undefined && ["queued", "working", "waiting", "ready", "review"].includes(latest.status);
}

export interface ScheduleClock {
  since: number;
  marks: ReadonlyMap<string, number>;
}
export interface ScheduleFire {
  rule: TriggerRule;
  at: number;
  repos: Repo[];
  skipped: ScheduleSkip[];
  waits?: number;
}

/** One due slot per rule; the hub records a mark even when it starts nothing. */
export function dueRules(rules: readonly TriggerRule[], events: readonly TriggerEvent[], now: number, repos: readonly Repo[], clock: ScheduleClock): ScheduleFire[] {
  const fires: ScheduleFire[] = [];
  for (const rule of rules) {
    if (rule.source !== "schedule") continue;
    const eventAt = lastFire(rule.name, events);
    const mark = clock.marks.get(rule.name);
    if (eventAt === null && mark === undefined) continue;
    const last = Math.max(eventAt ?? Number.NEGATIVE_INFINITY, mark ?? Number.NEGATIVE_INFINITY);
    const next = nextFireOf(rule, last);
    if (next === null || next > now) continue;
    let at = next;
    if (next < clock.since) {
      at = fireMinute(now);
      const upcoming = nextFireOf(rule, now);
      if (upcoming !== null && upcoming - now < SCHEDULE_CATCH_UP) {
        fires.push({ rule, at, repos: [], skipped: [], waits: upcoming });
        continue;
      }
    }
    const matching = scheduleRepos(rule, repos);
    const skipped: ScheduleSkip[] = [];
    const free: Repo[] = [];
    for (const repo of matching) {
      if (scheduleBusy(events, rule.name, repo.id)) skipped.push({ repo: repo.name, why: "last run still going", at });
      else free.push(repo);
    }
    if (rule.repo !== "*" && matching.length === 0) skipped.push({ repo: rule.repo, why: `no repo ${rule.repo} in the tree`, at });
    fires.push({ rule, at, repos: free, skipped });
  }
  return fires;
}

export function scheduleNote(rule: TriggerRule, repo: Pick<Repo, "name">, at: number): string {
  return `${rule.workflow} on ${repo.name}: scheduled by canopy's ${rule.name} rule (${rule.cron ?? ""}) for ${new Date(fireMinute(at)).toISOString()}. No outside issue came in; work from the repository as it is.`;
}

export function scheduleEvent(rule: TriggerRule, repo: Pick<Repo, "id" | "name">, repoKey: string, at: number, now: number, source: "schedule" | "manual"): TriggerEvent {
  const date = new Date(at);
  const day = [date.getFullYear(), String(date.getMonth() + 1).padStart(2, "0"), String(date.getDate()).padStart(2, "0")].join("-");
  return {
    id: crypto.randomUUID().slice(0, 8), rule: rule.name, source, service: "schedule",
    key: scheduleKey(repoKey, at), short: day, title: `${rule.workflow} on ${repo.name}, ${day}`,
    note: scheduleNote(rule, repo, at), repoId: repo.id, workflow: rule.workflow,
    land: rule.land, status: "queued", count: 1, firstAt: now, lastAt: now,
  };
}
