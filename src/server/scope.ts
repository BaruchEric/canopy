/** The scope lane's server half (FR-074, plan 2): whether a scoped caller's
 *  request stays inside its teams' folders, and the cut of a list's answer.
 *  The table of filed routes and the cuts themselves are pure, in
 *  core/scope.ts. Nothing here knows the server's state: `ScopeDeps` is how
 *  an id is traced to its repo. */
import { inScope, SCOPE_CLOSED, SCOPE_OUTSIDE, scopeAnswer, scopeBodyRefusal, scopeRule, type ScopeView } from "../core/scope";
import type { Repo } from "../core/types";
import type { Caller } from "./callers";

/** who a scope holds: the person, their teams, and those teams' folders */
export interface Scope {
  person: string;
  teams: readonly string[];
  folders: readonly string[];
}

/** How an id is traced to the repo it belongs to. Each answers a repo id,
 *  or undefined for an id that is not one of its kind. */
export interface ScopeDeps {
  repos(): readonly Repo[];
  runRepo(id: string): string | undefined;
  flowRepo(id: string): string | undefined;
  /** a live shell's, one kept from before a restart, or a task's session */
  termRepo(id: string): string | undefined;
  /** the ranger's own session, which is no repo's */
  isRanger(id: string): boolean;
  /** a finished run's repo, read off the transcript index */
  keptRunRepo(id: string): Promise<string | undefined>;
}

/** A scope with the repos it holds right now, for a check or a cut. The
 *  activity log keeps a repo's name, not its id, so `named` goes by name. */
export function viewOf(scope: Scope, repos: readonly Repo[]): ScopeView {
  const ids = new Set<string>();
  const names = new Set<string>();
  for (const r of repos) {
    if (!inScope(scope.folders, r.path)) continue;
    ids.add(r.id);
    names.add(r.name);
  }
  return { ...scope, repo: (id) => ids.has(id), named: (name) => names.has(name) };
}

const refuse = (error: string): Response => Response.json({ error, scoped: true }, { status: 403 });

type Where = "in" | "out" | "unknown";

/** Where an id sits: a repo's own id, or a run's, a flow's, a shell's or a
 *  task's traced to its repo. A run, a shell or a task in a kept tree
 *  carries its checkout's repo id, so the tree's folder under the config
 *  dir never decides. `unknown` names nothing canopy holds. */
function whereIs(deps: ScopeDeps, view: ScopeView, ref: string): Where {
  if (deps.repos().some((r) => r.id === ref)) return view.repo(ref) ? "in" : "out";
  const repo = deps.runRepo(ref) ?? deps.flowRepo(ref) ?? deps.termRepo(ref);
  if (repo !== undefined) return view.repo(repo) ? "in" : "out";
  if (deps.isRanger(ref)) return "out";
  return "unknown";
}

/** one key's value as the handler will read it: undefined when absent, null
 *  when it is there and not one plain string */
type Bag = (key: string) => string | null | undefined;

const queryBag =
  (url: URL): Bag =>
  (key) => {
    const all = url.searchParams.getAll(key);
    // the handler reads the first; two under one key is a request built to
    // show one id here and use another there
    if (all.length > 1) return null;
    return all[0];
  };

async function bodyBag(req: Request): Promise<Bag | null> {
  const body: unknown = await req
    .clone()
    .json()
    .catch(() => null);
  if (typeof body !== "object" || body === null || Array.isArray(body)) return null;
  return (key) => {
    if (!Object.hasOwn(body, key)) return undefined;
    const v: unknown = Reflect.get(body, key);
    if (v === undefined) return undefined;
    return typeof v === "string" && v !== "" ? v : null;
  };
}

/** Why a scoped caller's request is refused, or null to let it through:
 *  a route nobody filed is closed, and one that names a repo, a run, a flow
 *  or a shell must name one inside the scope. Runs after the caller gate,
 *  so the right the route needs is already held. */
export async function scopeRefusal(deps: ScopeDeps, view: ScopeView, caller: Caller, req: Request, url: URL): Promise<Response | null> {
  const rule = scopeRule(req.method, url.pathname);
  if (!rule) return refuse(SCOPE_CLOSED);
  if (rule.hold !== "ids") return null;
  if (rule.from === "path") {
    const here = whereIs(deps, view, rule.id);
    if (here === "in") return null;
    if (here === "out") return refuse(SCOPE_OUTSIDE);
    const kept = await deps.keptRunRepo(rule.id);
    return kept !== undefined && view.repo(kept) ? null : refuse(SCOPE_OUTSIDE);
  }
  const bag = rule.from === "query" ? queryBag(url) : await bodyBag(req);
  if (!bag) return refuse(SCOPE_OUTSIDE);
  // what a route's body asks for that reaches past the one repo
  if (req.method === "POST") {
    const why = scopeBodyRefusal(req.method, url.pathname, await req.clone().json().catch(() => null));
    if (why) return refuse(why);
  }
  const named: string[] = [];
  for (const key of rule.keys) {
    const v = bag(key);
    if (v === undefined) continue;
    if (v === null) return refuse(SCOPE_OUTSIDE);
    named.push(v);
  }
  if (rule.self && caller.kind === "run" && caller.run) named.push(caller.run);
  if (named.length === 0) return refuse(SCOPE_OUTSIDE);
  for (const ref of named) {
    const here = whereIs(deps, view, ref);
    if (here === "in" || (here === "unknown" && rule.fresh)) continue;
    return refuse(SCOPE_OUTSIDE);
  }
  for (const key of rule.maybe) {
    const v = bag(key);
    if (v === undefined) continue;
    if (v === null || whereIs(deps, view, v) === "out") return refuse(SCOPE_OUTSIDE);
  }
  return null;
}

/** A filed list's answer cut to the scope. An answer that is not JSON, or
 *  a list with no cut, is refused whole: nothing passes uncut. Errors pass,
 *  since they say what was wrong with the request and nothing of a repo. */
export async function scopeCut(view: ScopeView, req: Request, url: URL, res: Response): Promise<Response> {
  const rule = scopeRule(req.method, url.pathname);
  if (rule?.hold !== "filter" || !res.ok) return res;
  // the stream is cut frame by frame where it is written
  if ((res.headers.get("content-type") ?? "").startsWith("text/event-stream")) return res;
  const value: unknown = await res.json().catch(() => undefined);
  if (value === undefined) return refuse(SCOPE_CLOSED);
  const cut = scopeAnswer(url.pathname, value, view);
  if (cut === null) return refuse(SCOPE_CLOSED);
  return Response.json(cut, { status: res.status });
}
