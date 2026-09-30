/**
 * Agent routing: which settings, and so which harness, a repo gets for each
 * kind of work (a role). Profiles are named settings a route points at, so
 * changing a profile changes every route on it. Browser-safe and pure: the
 * server resolves with it for every start, and the agents view shows the
 * same resolution, `from` and all, so the order never surprises.
 *
 * The first layer that is present wins:
 *   1. explicit: the launch picker ("new codex shell"), or a workflow
 *      step's own `agent:` profile
 *   2. repo × role: `agents[path].roles[role]`
 *   3. repo: `agents[path].all`
 *   4. role: `agentRoles[role]`
 *   5. default: `profiles.default`
 *   6. builtin: `DEFAULT_AGENT`
 * The repo beats the role on purpose: a repo override is the more
 * deliberate choice. A pick naming a missing profile, or settings of a
 * harness the role cannot run yet, falls through to the next layer and is
 * listed in `skipped`, which the UI flags.
 */

import { normalizeAgent, sameAgent } from "./agent";
import { HARNESS } from "./harness";
import {
  AGENT_ROLES,
  DEFAULT_AGENT,
  isAgentRole,
  isHarness,
  type AgentLayer,
  type AgentPick,
  type AgentRole,
  type AgentRoutes,
  type AgentSettings,
  type AgentSkip,
  type Harness,
  type LaunchPick,
  type RepoAgent,
  type ResolvedAgent,
} from "./types";

/** A profile's name: short, lowercase, one path-safe word, and never one
 *  every object already has (`constructor`): profiles are kept by name in
 *  plain objects, where such a name would read the prototype's. */
export const PROFILE_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;
export const isProfileName = (v: unknown): v is string => typeof v === "string" && PROFILE_RE.test(v) && !(v in Object.prototype);

/** A profile by name, only when the routing holds one under it: never a
 *  name an object has by inheritance. */
export const profileOf = (profiles: Readonly<Record<string, AgentSettings>>, name: string): AgentSettings | undefined =>
  Object.hasOwn(profiles, name) ? profiles[name] : undefined;

/** Whether the routing holds a profile under `name`. */
export const hasProfile = (profiles: Readonly<Record<string, AgentSettings>>, name: string): boolean => Object.hasOwn(profiles, name);

/** the profile that is always there: the backend's default */
export const DEFAULT_PROFILE = "default";

/**
 * Which harnesses each role can run. Every role runs both: a shell starts
 * either CLI, the runner drives Claude Code's stream-json or Codex's
 * app-server (chats, jobs and workflow steps), and the commit message comes
 * from `claude -p` or `codex exec`. A harness added later that some role
 * cannot run yet is left out of that role here, and the refusals below say
 * so; a harness a backend lacks is a separate check (`Backend.harnesses`).
 */
export const ROLE_HARNESSES: Record<AgentRole, readonly Harness[]> = {
  shell: ["claude", "codex"],
  chat: ["claude", "codex"],
  job: ["claude", "codex"],
  flow: ["claude", "codex"],
  suggest: ["claude", "codex"],
};

export const roleTakes = (role: AgentRole, h: Harness): boolean => ROLE_HARNESSES[role].includes(h);

/** what a role covers, in words */
export const ROLE_WORDS: Record<AgentRole, string> = {
  shell: "shells and openers",
  chat: "chats",
  job: "jobs",
  flow: "workflow steps",
  suggest: "commit messages",
};

/** why a role passes a harness over, for the UI and the refusals */
export const roleRefusal = (role: AgentRole, h: Harness): string =>
  `${HARNESS[h].label} does not run ${ROLE_WORDS[role]} yet; they stay on ${ROLE_HARNESSES[role].map((x) => HARNESS[x].label).join(" or ")}`;

/* ---------- normalizing what a body or a hand-edited config holds ---------- */

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** A pick off the wire: a profile by a valid name, or settings validated
 *  field by field; null for anything else. */
export function normalizePick(v: unknown): AgentPick | null {
  if (!isRecord(v)) return null;
  if ("profile" in v) return isProfileName(v["profile"]) ? { profile: v["profile"] } : null;
  return normalizeAgent(v);
}

export const isProfilePick = (p: AgentPick): p is { profile: string } => "profile" in p;

/** A repo's entry. One saved before roles is plain settings and reads as
 *  `{ all: entry }`, so nothing needs migrating; the new shape keeps each
 *  valid pick and drops the rest. */
export function normalizeRepoAgent(v: unknown): RepoAgent {
  if (!isRecord(v)) return {};
  if (!("all" in v) && !("roles" in v)) {
    // an old entry: settings, or nothing usable
    return Object.keys(v).length ? { all: normalizeAgent(v) } : {};
  }
  const out: RepoAgent = {};
  const all = normalizePick(v["all"]);
  if (all) out.all = all;
  const roles = normalizeRoles(v["roles"]);
  if (Object.keys(roles).length) out.roles = roles;
  return out;
}

export const isEmptyRepoAgent = (r: RepoAgent): boolean => !r.all && !(r.roles && Object.keys(r.roles).length);

/** The per-role picks, unknown roles and malformed picks left out. */
export function normalizeRoles(v: unknown): Partial<Record<AgentRole, AgentPick>> {
  if (!isRecord(v)) return {};
  const out: Partial<Record<AgentRole, AgentPick>> = {};
  for (const role of AGENT_ROLES) {
    const p = normalizePick(v[role]);
    if (p) out[role] = p;
  }
  return out;
}

/** The profiles by name, bad names left out. `default` is stored only
 *  when it differs from the builtin, which it stands in for otherwise. */
export function normalizeProfiles(v: unknown): Record<string, AgentSettings> {
  if (!isRecord(v)) return {};
  const out: Record<string, AgentSettings> = {};
  for (const [name, raw] of Object.entries(v)) {
    if (!isProfileName(name)) continue;
    const a = normalizeAgent(raw);
    if (name === DEFAULT_PROFILE && sameAgent(a, DEFAULT_AGENT)) continue;
    out[name] = a;
  }
  return out;
}

/** The repo overrides, each through `normalizeRepoAgent`, empty ones out. */
export function normalizeRepoAgents(v: unknown): Record<string, RepoAgent> {
  if (!isRecord(v)) return {};
  const out: Record<string, RepoAgent> = {};
  for (const [path, raw] of Object.entries(v)) {
    const r = normalizeRepoAgent(raw);
    if (!isEmptyRepoAgent(r)) out[path] = r;
  }
  return out;
}

/** Every profile with `default` among them: the builtin when unset. */
export const withDefaultProfile = (profiles: Record<string, AgentSettings>): Record<string, AgentSettings> =>
  hasProfile(profiles, DEFAULT_PROFILE) ? profiles : { [DEFAULT_PROFILE]: { ...DEFAULT_AGENT }, ...profiles };

/** What `GET /api/agents` and the `agents` event carry, from anything a
 *  backend sent: this shape, or an older backend's plain map of settings
 *  by repo path, which reads as those repos' whole-repo picks. */
export function normalizeRoutes(v: unknown): AgentRoutes {
  if (isRecord(v) && isRecord(v["profiles"]) && isRecord(v["repos"])) {
    return {
      profiles: withDefaultProfile(normalizeProfiles(v["profiles"])),
      roles: normalizeRoles(v["roles"]),
      repos: normalizeRepoAgents(v["repos"]),
    };
  }
  return { profiles: withDefaultProfile({}), roles: {}, repos: normalizeRepoAgents(v) };
}

/** Settings of their own that a role cannot run, refused when a route is
 *  written (a profile pick is let through, since what a profile holds can
 *  change, and falls through at resolve time instead). */
export function pickRefusal(role: AgentRole, pick: AgentPick): string | null {
  if (isProfilePick(pick) || roleTakes(role, pick.harness)) return null;
  return roleRefusal(role, pick.harness);
}

/** The first refusal among a repo override's per-role picks. */
export function repoAgentRefusal(r: RepoAgent): string | null {
  for (const role of AGENT_ROLES) {
    const p = r.roles?.[role];
    const why = p ? pickRefusal(role, p) : null;
    if (why) return why;
  }
  return null;
}

/* ---------- resolution ---------- */

/** What a pick names, or why it names nothing a role can use. */
function settle(
  routes: AgentRoutes,
  role: AgentRole,
  pick: AgentPick,
): { settings: AgentSettings; profile?: string } | { why: string; profile?: string } {
  if (isProfilePick(pick)) {
    const s = profileOf(routes.profiles, pick.profile) ?? (pick.profile === DEFAULT_PROFILE ? DEFAULT_AGENT : undefined);
    if (!s) return { why: `no profile named ${pick.profile}`, profile: pick.profile };
    if (!roleTakes(role, s.harness)) return { why: roleRefusal(role, s.harness), profile: pick.profile };
    return { settings: s, profile: pick.profile };
  }
  if (!roleTakes(role, pick.harness)) return { why: roleRefusal(role, pick.harness) };
  return { settings: pick };
}

/** The routed layers for a repo and role, in order: what each names. */
function layers(routes: AgentRoutes, path: string, role: AgentRole): [AgentLayer, AgentPick][] {
  const repo = Object.hasOwn(routes.repos, path) ? routes.repos[path] : undefined;
  const out: [AgentLayer, AgentPick][] = [];
  const rr = repo?.roles?.[role];
  if (rr) out.push(["repo-role", rr]);
  if (repo?.all) out.push(["repo", repo.all]);
  const r = routes.roles[role];
  if (r) out.push(["role", r]);
  if (hasProfile(routes.profiles, DEFAULT_PROFILE)) out.push(["default", { profile: DEFAULT_PROFILE }]);
  return out;
}

/** The layers' resolution with no launch pick. */
function routed(routes: AgentRoutes, path: string, role: AgentRole, skipped: AgentSkip[]): ResolvedAgent {
  for (const [from, pick] of layers(routes, path, role)) {
    const got = settle(routes, role, pick);
    if ("why" in got) {
      skipped.push({ from, why: got.why, ...(got.profile ? { profile: got.profile } : {}) });
      continue;
    }
    return { settings: got.settings, from, ...(got.profile ? { profile: got.profile } : {}) };
  }
  return { settings: DEFAULT_AGENT, from: "builtin" };
}

/** The profiles of one harness in the order a harness pick tries them:
 *  `default`, then the rest by name. */
function profilesOf(routes: AgentRoutes, h: Harness): [string, AgentSettings][] {
  return Object.entries(routes.profiles)
    .filter(([, s]) => s.harness === h)
    .sort(([a], [b]) => (a === DEFAULT_PROFILE ? -1 : b === DEFAULT_PROFILE ? 1 : a.localeCompare(b)));
}

/**
 * The settings a repo gets for a role, where they came from, and what was
 * passed over on the way. `explicit` beats every route: a profile by name,
 * or a harness, which takes the first route layer of that harness (so a
 * repo's own codex settings win), else the first profile of it, else the
 * harness's defaults, and a harness the role cannot run is ignored with a
 * note.
 */
export function resolveAgent(routes: AgentRoutes, path: string, role: AgentRole, explicit?: LaunchPick): ResolvedAgent {
  const skipped: AgentSkip[] = [];
  const done = (r: ResolvedAgent): ResolvedAgent => {
    const out = role === "suggest" ? forSuggest(r) : r;
    return skipped.length ? { ...out, skipped } : out;
  };
  if (explicit && "profile" in explicit) {
    const got = settle(routes, role, explicit);
    if (!("why" in got)) return done({ settings: got.settings, from: "explicit", profile: explicit.profile });
    skipped.push({ from: "explicit", why: got.why, profile: explicit.profile });
  } else if (explicit && "harness" in explicit) {
    const h = explicit.harness;
    if (!roleTakes(role, h)) {
      skipped.push({ from: "explicit", why: roleRefusal(role, h) });
    } else {
      for (const [, pick] of layers(routes, path, role)) {
        const got = settle(routes, role, pick);
        if (!("why" in got) && got.settings.harness === h) {
          return done({ settings: got.settings, from: "explicit", ...(got.profile ? { profile: got.profile } : {}) });
        }
      }
      const first = profilesOf(routes, h)[0];
      if (first) return done({ settings: first[1], from: "explicit", profile: first[0] });
      return done({ settings: { ...DEFAULT_AGENT, harness: h }, from: "explicit" });
    }
  }
  return done(routed(routes, path, role, skipped));
}

/** The layers that choose settings for the commit message itself. */
const SUGGEST_LAYERS: readonly AgentLayer[] = ["explicit", "repo-role", "role"];

/**
 * The commit message runs one short `claude -p` or `codex exec` under a
 * 90 s timeout. A pick made for it (the repo's suggest pick, the suggest
 * role's route, a launch pick) is taken whole; any other layer (the repo's
 * whole pick, the default profile) was chosen for real work, and an opus
 * repo at max effort would make max-effort suggestions that run out of
 * time, so it lends its harness alone, at that harness's defaults.
 */
function forSuggest(r: ResolvedAgent): ResolvedAgent {
  if (SUGGEST_LAYERS.includes(r.from)) return r;
  return { ...r, settings: { ...DEFAULT_AGENT, harness: r.settings.harness } };
}

/** Every role's resolution for one repo: the effective table. */
export function effectiveAgents(routes: AgentRoutes, path: string): Record<AgentRole, ResolvedAgent> {
  const out = {} as Record<AgentRole, ResolvedAgent>;
  for (const role of AGENT_ROLES) out[role] = resolveAgent(routes, path, role);
  return out;
}

/** A launch pick off a query string: `profile=` wins over `harness=`. */
export function launchPick(profile: string | null, harness: string | null): LaunchPick | undefined {
  if (isProfileName(profile)) return { profile };
  if (isHarness(harness)) return { harness };
  return undefined;
}

export { isAgentRole };
