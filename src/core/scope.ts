/** The wall a team's folders make (FR-074, plan 2). Pure and browser-safe.
 *
 *  A member or a viewer whose teams name folders is scoped: canopy shows
 *  them, and takes from them, only the repos under those folders. Owners and
 *  admins are never scoped, nor is a member on no team.
 *
 *  The 2026-11-09 decision turned down hiding fields per caller, since a
 *  list that leaks unless someone remembers a filter is a bug waiting. So
 *  the scope is built the other way round, as the coordinator's lane is: a
 *  scoped caller reaches only the routes filed here, each with how it is
 *  held (`any`, `own`, `filter`, `ids`), and hears only the events
 *  `scopeEvent` knows how to cut. Everything else is a 403. A new route or
 *  event is closed to a scoped person until someone files it.
 *
 *  The wall is exact for a viewer, who only reads through these routes. It
 *  is soft for a member: their agent and their shell run as canopy's OS
 *  user and can read a sibling folder. Two groups that must not reach each
 *  other's files need two backends (`canopy tenant add`). */
import { focusOf, OWNER_ID, under, type ActivityLine, type PeopleFile, type PeopleInfo, type Person } from "./people";
import type { ScanResult, ServerEvent } from "./types";

/** The folders a person is held to, or null for someone canopy shows the
 *  whole backend: an owner, an admin, and a member or viewer whose teams
 *  name no folder. */
export function scopeOf(file: Pick<PeopleFile, "teams">, person: Pick<Person, "role" | "teams">): string[] | null {
  if (person.role === "owner" || person.role === "admin") return null;
  const folders = focusOf(file.teams, person);
  return folders.length > 0 ? folders : null;
}

/** whether a repo's path is inside a scope */
export const inScope = (folders: readonly string[], path: string): boolean => folders.some((f) => under(path, f));

/** What a cut is made with: who the scoped person is, their folders, and
 *  whether a repo (by id, or by the name the activity log keeps) is theirs. */
export interface ScopeView {
  person: string;
  teams: readonly string[];
  folders: readonly string[];
  repo(id: string): boolean;
  named(name: string): boolean;
}

/* ---------- the routes a scoped caller reaches ---------- */

/** How a filed route is held to the scope.
 *  - `any`: nothing in its answer or its effect is a repo's.
 *  - `own`: the caller's own records, which the handler keeps to the caller.
 *  - `filter`: a list, whose answer `scopeAnswer` cuts to the scope.
 *  - `ids`: it names a repo, a run, a flow or a shell, read from where the
 *    handler reads it: the query or the JSON body under `keys`, or the path
 *    (`id`). At least one is given and each one given is in scope. `maybe`
 *    keys are checked when they name something canopy knows: a new shell's
 *    id names nothing yet. `self` counts a run token's own run as named. */
export type ScopeRule =
  | { hold: "any" }
  | { hold: "own" }
  | { hold: "filter" }
  | {
      hold: "ids";
      from: "query" | "body";
      keys: readonly string[];
      maybe: readonly string[];
      self: boolean;
      /** an id canopy holds nothing under passes, for a read whose handler
       *  answers such an id as nothing: a shell a panel names before its
       *  socket starts it runs no agent */
      fresh: boolean;
    }
  | { hold: "ids"; from: "path"; id: string };

const ANY: ScopeRule = { hold: "any" };
const OWN: ScopeRule = { hold: "own" };
const FILTER: ScopeRule = { hold: "filter" };
const ids = (from: "query" | "body", keys: readonly string[], more: { maybe?: readonly string[]; self?: boolean; fresh?: boolean } = {}): ScopeRule => ({ hold: "ids", from, keys, maybe: more.maybe ?? [], self: more.self ?? false, fresh: more.fresh ?? false });
const query = (...keys: string[]): ScopeRule => ids("query", keys);
const body = (...keys: string[]): ScopeRule => ids("body", keys);

/** What a scoped caller reads out of one repo, `GET /api/repos/<action>?id=`. */
export const SCOPED_REPO_READS: readonly string[] = ["commit", "diff", "dir", "grep", "log", "ls", "mentions", "raw", "resumable", "search", "session", "sessions", "workflows"];

/** What a scoped caller does to one repo, `POST /api/repos/<action>?id=`.
 *  Left out on purpose: archiving, moving a repo between machines, building
 *  and launching, opening anything on the backend's own desktop (a file, a
 *  session's note), the map section's agents and a coordinator, which reach
 *  past the one repo or spend the backend's own tools. */
export const SCOPED_REPO_WRITES: readonly string[] = ["agent", "commit", "dropstale", "favorite", "flow", "harness", "pull", "push", "refresh", "resume", "run", "stage", "unlock"];

/** What a filed write's body may not ask for: a run that coordinates others
 *  starts cards of its own, which is the coordinator's and closed. */
const BODY_REFUSED: Readonly<Record<string, { key: string; values: readonly string[]; why: string }>> = {
  "POST /api/repos/run": { key: "action", values: ["coordinate"], why: "a coordinator is not one of the things your teams' folders reach; an owner or an admin starts one" },
};

/** Why a filed write's body reaches past what a scoped caller may ask for,
 *  or null. */
export function scopeBodyRefusal(method: string, path: string, body: unknown): string | null {
  const rule = BODY_REFUSED[`${method} ${path}`];
  if (!rule || !isRecord(body)) return null;
  const v = body[rule.key];
  return typeof v === "string" && rule.values.includes(v) ? rule.why : null;
}

/** Keyed by method and exact path. */
const EXACT: Readonly<Record<string, ScopeRule>> = {
  // the board. A rescan answers the tree, which the page asks for on every
  // load, so it is cut the same way.
  "GET /api/tree": FILTER,
  "POST /api/rescan": FILTER,
  "GET /api/events": FILTER,
  "GET /api/runs": FILTER,
  "GET /api/flows": FILTER,
  "GET /api/fleets": FILTER,
  "GET /api/jobs": FILTER,
  "GET /api/terms": FILTER,
  "GET /api/terms/kept": FILTER,
  "GET /api/tasks": FILTER,
  "GET /api/trees": FILTER,
  "GET /api/devices": FILTER,
  // the machines that open things for an admin: none of them a scoped
  // person's to use, so the list comes back empty
  "GET /api/helpers": FILTER,
  // people: the roster is cut to the caller's own teams and places
  "GET /api/people": FILTER,
  "GET /api/people/activity": FILTER,
  "POST /api/people/at": OWN,
  "POST /api/people/me": OWN,
  // the browser's own: what its machine can open, its push subscription,
  // the helper it runs
  "GET /api/client": OWN,
  "GET /api/helper": OWN,
  "GET /api/push/key": ANY,
  "POST /api/push/subscribe": OWN,
  "DELETE /api/push/subscribe": OWN,
  // which agents a run can start with: profiles and models, no repo's data
  "GET /api/agents": ANY,
  "GET /api/verdict": ANY,
  // this backend's name and the other backends' addresses, which every id on
  // the page hangs off; each of those signs the person in on its own
  "GET /api/backends": ANY,
  // runs and their answers
  "DELETE /api/runs": query("id"),
  "POST /api/runs/answer": body("id"),
  "POST /api/runs/stop": body("id"),
  "POST /api/runs/fork": body("id"),
  "POST /api/runs/interrupt": body("id"),
  "POST /api/runs/name": body("id"),
  "POST /api/runs/say": ids("body", ["id"], { self: true }),
  "POST /api/runs/child": ids("body", ["parent"], { maybe: ["repo"], self: true }),
  // a run's own: its work item's note, and a wake for itself, which may
  // name a run to wake only inside the folders. A page or the CLI names
  // neither, so for them both are closed.
  "POST /api/work/note": ids("body", [], { self: true }),
  "POST /api/ranger/wakes": ids("body", [], { maybe: ["run"], self: true }),
  "DELETE /api/flows": query("id"),
  "POST /api/flows/resume": body("id"),
  "POST /api/flows/stop": body("id"),
  "POST /api/flows/pickup": body("id"),
  // shells: the socket lands in a repo, and joins only a shell of the scope
  "GET /api/term": ids("query", ["id"], { maybe: ["term"] }),
  "DELETE /api/terms": query("term"),
  "DELETE /api/terms/kept": query("term"),
  "GET /api/terms/agent": ids("query", ["term"], { fresh: true }),
  "GET /api/terms/transcript": query("term"),
  "GET /api/terms/text": query("term"),
  "GET /api/terms/screen": query("term"),
  "POST /api/terms/say": body("term"),
  "POST /api/terms/keys": body("term"),
  "POST /api/terms/label": body("term"),
  "POST /api/terms/place": body("term"),
  "POST /api/terms/paste": body("term"),
  "POST /api/terms/restore": body("term"),
  // a repo's tasks
  "GET /api/repos/tasks": query("id"),
  "POST /api/repos/tasks": query("id"),
  "GET /api/repos/tasks/log": query("id"),
  // a repo's kept worktrees; a clean-up that names no repo sweeps them all
  // and so is refused here
  "POST /api/trees/add": body("repo"),
  "POST /api/trees/remove": body("repo"),
  "POST /api/trees/sync": body("repo"),
  "POST /api/trees/merge": body("repo"),
  "POST /api/trees/clean": body("repo"),
  "POST /api/trees/auto": body("repo"),
};

const RUN_READ = /^\/api\/runs\/([^/]+)(?:\/export|\/replay)?$/;
const REPO_ACTION = /^\/api\/repos\/([a-z]+)$/;

/** The rule a scoped caller's request falls under; null for a route nobody
 *  filed. */
export function scopeRule(method: string, path: string): ScopeRule | null {
  const m = method === "HEAD" ? "GET" : method;
  const clean = path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
  const key = `${m} ${clean}`;
  if (Object.hasOwn(EXACT, key)) return EXACT[key] ?? null;
  const action = REPO_ACTION.exec(clean)?.[1];
  if (action !== undefined) {
    const filed = m === "GET" ? SCOPED_REPO_READS.includes(action) : m === "POST" && SCOPED_REPO_WRITES.includes(action);
    return filed ? query("id") : null;
  }
  const run = m === "GET" ? RUN_READ.exec(clean)?.[1] : undefined;
  if (run !== undefined) return { hold: "ids", from: "path", id: run };
  return null;
}

/** every exact route filed, for a test that each `filter` has its cut */
export const SCOPED_ROUTES: readonly string[] = Object.keys(EXACT);

/** Routes a run's or a coordinator's token reaches (core/callers.ts's
 *  LANES) that stay closed to a scoped person's agent, each on purpose, so
 *  a test can hold every lane route to being filed or named here. The
 *  landing queue, the health report and the coordinator's plans span every
 *  repo on the backend and have no cut. */
export const SCOPE_LANE_CLOSED: readonly string[] = ["GET /api/landing", "GET /api/health", "GET /api/loadouts", "GET /api/coordinator/workflows", "POST /api/coordinator/plan"];

/** the 403 a scoped caller gets for a route nobody filed */
export const SCOPE_CLOSED = "your teams' folders hold what you reach here, and this is not one of the things they reach; an owner or an admin sees it";
/** the 403 for a filed route that names something outside the folders */
export const SCOPE_OUTSIDE = "that is not in your teams' folders";

/* ---------- cutting an answer ---------- */

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** a fleet runs one workflow over many repos, and is a scoped person's only
 *  when every one of them is */
const wholeFleet = (fleet: unknown, view: ScopeView): boolean =>
  isRecord(fleet) && Array.isArray(fleet["repos"]) && fleet["repos"].length > 0 && fleet["repos"].every((r) => isRecord(r) && typeof r["repoId"] === "string" && view.repo(r["repoId"]));

/** the records of a list that name a repo of the scope under `repoId` (a
 *  kept run's head says `repo`); one that names none is dropped */
function byRepo(list: unknown, view: ScopeView): unknown[] {
  if (!Array.isArray(list)) return [];
  return list.filter((x) => {
    if (!isRecord(x)) return false;
    const id = typeof x["repoId"] === "string" ? x["repoId"] : x["repo"];
    return typeof id === "string" && view.repo(id);
  });
}

/** A scan as a scoped person gets it: their repos, and the sources those
 *  sit in. A source that is a folder above or below one of theirs stays;
 *  one on another host or a forge goes. */
export function cutScan(result: ScanResult, view: ScopeView): ScanResult {
  const repos = result.repos.filter((r) => inScope(view.folders, r.path));
  const sources = result.sources
    .filter((s) => s.kind === "local" && view.folders.some((f) => under(f, s.path) || under(s.path, f)))
    .map((s) => ({ ...s, repos: repos.filter((r) => s.kind === "local" && under(r.path, s.path)).length }));
  return { ...result, repos, sources };
}

/** The roster as a scoped person gets it: everyone's name, role and
 *  whether they are on, since a run says who started it; a place only
 *  where it is one of their repos; and only their own teams. */
export function cutPeople(info: PeopleInfo, view: ScopeView): PeopleInfo {
  return {
    people: info.people.map((p) => ({ ...p, at: p.at.filter((id) => view.repo(id)), teams: p.teams.filter((t) => view.teams.includes(t)), invited: p.id === view.person ? p.invited : 0 })),
    teams: info.teams.filter((t) => view.teams.includes(t.id)),
  };
}

/** who did what, for a scoped person: their own lines, and the lines that
 *  name one of their repos, by id, or by name on a line older than ids */
export function cutActivity(lines: readonly ActivityLine[], view: ScopeView): ActivityLine[] {
  return lines.filter((l) => l.person === view.person || (l.repoId !== undefined ? view.repo(l.repoId) : l.repo !== undefined && view.named(l.repo)));
}

const devicesOf = (list: unknown, view: ScopeView): unknown[] =>
  Array.isArray(list) ? list.filter((d) => isRecord(d) && (typeof d["person"] === "string" ? d["person"] : OWNER_ID) === view.person) : [];

/** Each `filter` route's cut, by path. A value that is not the shape the
 *  route answers comes back empty, never whole. */
const CUTS: Readonly<Record<string, (v: unknown, view: ScopeView) => unknown>> = {
  "/api/tree": (v, view) => (isScan(v) ? cutScan(v, view) : null),
  "/api/rescan": (v, view) => (isScan(v) ? cutScan(v, view) : null),
  "/api/runs": (v, view) => byRepo(v, view),
  "/api/flows": (v, view) => byRepo(v, view),
  "/api/fleets": (v, view) => (Array.isArray(v) ? v.filter((f) => wholeFleet(f, view)) : []),
  "/api/jobs": (v, view) => byRepo(v, view),
  "/api/helpers": () => [],
  "/api/terms": (v, view) => byRepo(v, view),
  "/api/tasks": (v, view) => byRepo(v, view),
  "/api/terms/kept": (v, view) => (isRecord(v) ? { ...v, kept: byRepo(v["kept"], view) } : { kept: [] }),
  "/api/trees": (v, view) => (isRecord(v) ? { ...v, repos: byRepo(v["repos"], view) } : { repos: [] }),
  "/api/devices": (v, view) => devicesOf(v, view),
  "/api/people": (v, view) => (isPeople(v) ? { ...cutPeople(v, view), invites: [] } : { people: [], teams: [], invites: [] }),
  "/api/people/activity": (v, view) => ({ lines: isRecord(v) && Array.isArray(v["lines"]) ? cutActivity(v["lines"].filter(isActivity), view) : [] }),
};

const isScan = (v: unknown): v is ScanResult => isRecord(v) && Array.isArray(v["repos"]) && Array.isArray(v["sources"]);
const isPeople = (v: unknown): v is PeopleInfo => isRecord(v) && Array.isArray(v["people"]) && Array.isArray(v["teams"]);
const isActivity = (v: unknown): v is ActivityLine => isRecord(v) && typeof v["person"] === "string" && typeof v["what"] === "string";

/** whether a `filter` route's JSON answer has a cut (the event stream is
 *  cut frame by frame, in `scopeEvent`) */
export const hasCut = (path: string): boolean => path === "/api/events" || Object.hasOwn(CUTS, path);

/** A `filter` route's JSON answer cut to the scope. A route with no cut
 *  answers null: nothing is passed whole by default. */
export function scopeAnswer(path: string, value: unknown, view: ScopeView): unknown {
  const clean = path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
  const cut = Object.hasOwn(CUTS, clean) ? CUTS[clean] : undefined;
  return cut ? cut(value, view) : null;
}

/* ---------- cutting the event stream ---------- */

/** An event as a scoped stream hears it, or null for one it does not. Only
 *  the events named here pass: the board's. The rest (the landing queue,
 *  notes, clips, the kit, secrets, health, triggers, the incubator, the
 *  registry and so on) carry what the routes above keep closed. */
export function scopeEvent(ev: ServerEvent, view: ScopeView): ServerEvent | null {
  switch (ev.type) {
    case "repo":
      return inScope(view.folders, ev.repo.path) ? ev : null;
    case "scan":
      return { type: "scan", result: cutScan(ev.result, view) };
    case "run":
      return view.repo(ev.run.repoId) ? ev : null;
    case "flow":
      return view.repo(ev.flow.repoId) ? ev : null;
    case "fleet":
      return wholeFleet(ev.fleet, view) ? ev : null;
    case "job":
      return view.repo(ev.job.repoId) ? ev : null;
    // an id alone, which names nothing to someone who never heard of it
    case "run-gone":
    case "flow-gone":
    case "fleet-gone":
    case "job-gone":
      return ev;
    case "terms":
      return { type: "terms", terms: ev.terms.filter((t) => view.repo(t.repoId)) };
    case "kept":
      return { type: "kept", kept: ev.kept.filter((k) => view.repo(k.repoId)) };
    case "tasks":
      return view.repo(ev.repoId) ? ev : null;
    case "trees":
      return { type: "trees", trees: { ...ev.trees, repos: ev.trees.repos.filter((r) => view.repo(r.repoId)) } };
    case "people": {
      const { type, ...info } = ev;
      return { type, ...cutPeople(info, view) };
    }
    case "devices":
      return { type: "devices", devices: ev.devices.filter((d) => (d.person ?? OWNER_ID) === view.person) };
    default:
      return null;
  }
}
