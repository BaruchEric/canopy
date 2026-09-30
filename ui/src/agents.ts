/* The agents view's routing tab and the per-repo override sheet, the pure
   half: how a pick reads and is chosen in a select, the effective table's
   rows with what to flag on each, and the immutable edits a row makes to a
   repo's override. Tested in agents.test.ts. */

import { describeAgent } from "../../src/core/agent";
import { HARNESS } from "../../src/core/harness";
import { DEFAULT_PROFILE, isProfilePick, resolveAgent, roleTakes } from "../../src/core/route";
import {
  AGENT_ROLES,
  HARNESSES,
  type AgentLayer,
  type AgentPick,
  type AgentRole,
  type AgentRoutes,
  type AgentSettings,
  type Backend,
  type Harness,
  type RepoAgent,
  type ResolvedAgent,
} from "../../src/core/types";

/** what each role covers, as the rows name it */
export const ROLE_LABEL: Record<AgentRole, string> = {
  shell: "shell",
  chat: "chat",
  job: "job",
  flow: "workflow step",
  suggest: "commit message",
};

export const ROLE_TITLE: Record<AgentRole, string> = {
  shell: "Every interactive start: the panel's own shell, a new agent shell, resume, the agent and herdr openers, the guided panel's asks",
  chat: "A chat in canopy (the runner's conversation)",
  job: "A job handed over in canopy (ask, and the like)",
  flow: "A workflow step",
  suggest: "The commit-message suggestion",
};

const CLAUDE_ONLY: readonly Harness[] = Object.freeze(["claude"]);

/** the harnesses a backend has; one older than harnesses only had claude.
 *  The same array each time for the same backend, so a selector settles. */
export const harnessesOf = (b: Backend): readonly Harness[] => b.harnesses ?? CLAUDE_ONLY;

/** a harness's glyph and word, "✳ claude" */
export const harnessWord = (h: Harness): string => `${HARNESS[h].glyph} ${HARNESS[h].label}`;

/** An empty routing, for a backend not loaded yet. */
export const NO_ROUTES: AgentRoutes = Object.freeze({
  profiles: Object.freeze({ [DEFAULT_PROFILE]: Object.freeze({ harness: "claude", model: "default", effort: "default", yolo: true, extra: "" }) }),
  roles: Object.freeze({}),
  repos: Object.freeze({}),
}) as AgentRoutes;

/** The profile names in the order a picker lists them: default first,
 *  then by name. */
export function profileNames(routes: AgentRoutes): string[] {
  return Object.keys(routes.profiles).sort((a, b) => (a === DEFAULT_PROFILE ? -1 : b === DEFAULT_PROFILE ? 1 : a.localeCompare(b)));
}

/* ---------- a pick in a select ---------- */

/** A select's value for a pick: "" to inherit, `profile:<name>`, or
 *  "custom" for settings of its own. */
export function pickValue(pick: AgentPick | undefined): string {
  if (!pick) return "";
  return isProfilePick(pick) ? `profile:${pick.profile}` : "custom";
}

/** The pick a select's value names, given what the row held before (a
 *  custom pick keeps its settings; a new one starts from the harness's
 *  defaults, or from `seed`). */
export function pickOf(value: string, was: AgentPick | undefined, seed: AgentSettings): AgentPick | null {
  if (value === "") return null;
  if (value.startsWith("profile:")) return { profile: value.slice("profile:".length) };
  return was && !isProfilePick(was) ? was : { ...seed };
}

/** One line for a pick: the profile's name, or the settings' own line. */
export function pickLine(pick: AgentPick | undefined): string {
  if (!pick) return "—";
  return isProfilePick(pick) ? pick.profile : `${HARNESS[pick.harness].glyph} ${describeAgent(pick, false)}`;
}

/* ---------- where resolved settings came from ---------- */

const FROM_WORD: Record<AgentLayer, string> = {
  explicit: "picked at launch",
  "repo-role": "repo, this role",
  repo: "repo",
  role: "role route",
  default: "default profile",
  builtin: "builtin",
};

export const fromWord = (r: ResolvedAgent): string =>
  r.profile && r.from !== "default" ? `${FROM_WORD[r.from]} · ${r.profile}` : FROM_WORD[r.from];

/** One row of the effective table. */
export interface EffectiveRow {
  role: AgentRole;
  settings: AgentSettings;
  /** the harness's glyph and word */
  harness: string;
  /** the settings' line, "opus · high · yolo" */
  line: string;
  from: string;
  /** what to flag: a layer passed over and why, or a harness the backend
   *  lacks, which a start would be refused on */
  flags: string[];
}

/** Each role's resolution for one repo, with its flags. `has` is what the
 *  backend has installed. */
export function effectiveRows(routes: AgentRoutes, path: string, has: readonly Harness[]): EffectiveRow[] {
  return AGENT_ROLES.map((role) => {
    const r = resolveAgent(routes, path, role);
    const flags = (r.skipped ?? []).map((s) => `${FROM_WORD[s.from]}${s.profile ? ` (${s.profile})` : ""} passed over: ${s.why}`);
    if (!has.includes(r.settings.harness)) flags.push(`${HARNESS[r.settings.harness].label} is not installed on this backend`);
    return {
      role,
      settings: r.settings,
      harness: harnessWord(r.settings.harness),
      line: describeAgent(r.settings, false),
      from: fromWord(r),
      flags,
    };
  });
}

/** Every pick in the routing that names a profile that is gone, as
 *  "where: name", for the view's warning. */
export function missingProfiles(routes: AgentRoutes): string[] {
  const out: string[] = [];
  const check = (where: string, p: AgentPick | undefined) => {
    if (p && isProfilePick(p) && !(p.profile in routes.profiles)) out.push(`${where}: ${p.profile}`);
  };
  for (const role of AGENT_ROLES) check(`role ${role}`, routes.roles[role]);
  for (const [path, r] of Object.entries(routes.repos)) {
    check(`${path} (whole repo)`, r.all);
    for (const role of AGENT_ROLES) check(`${path} (${role})`, r.roles?.[role]);
  }
  return out;
}

/** How many routes point at a profile, so deleting a used one asks first. */
export function profileUses(routes: AgentRoutes, name: string): number {
  const is = (p: AgentPick | undefined) => !!p && isProfilePick(p) && p.profile === name;
  let n = AGENT_ROLES.filter((role) => is(routes.roles[role])).length;
  for (const r of Object.values(routes.repos)) {
    if (is(r.all)) n++;
    n += AGENT_ROLES.filter((role) => is(r.roles?.[role])).length;
  }
  return n;
}

/* ---------- editing one repo's override ---------- */

/** A repo's override with one pick set, or cleared with null: `all` for
 *  the whole repo, a role for that role. Empty parts are left out. */
export function withPick(agent: RepoAgent, slot: AgentRole | "all", pick: AgentPick | null): RepoAgent {
  if (slot === "all") {
    const { all: _all, ...rest } = agent;
    return pick ? { ...rest, all: pick } : rest;
  }
  const { [slot]: _was, ...roles } = agent.roles ?? {};
  const nextRoles = pick ? { ...roles, [slot]: pick } : roles;
  const { roles: _roles, ...rest } = agent;
  return Object.keys(nextRoles).length ? { ...rest, roles: nextRoles } : rest;
}

/** The harnesses a slot's settings may be: a role's own, or both for the
 *  whole repo, since the roles that cannot run one pass it over. */
export const slotHarnesses = (slot: AgentRole | "all"): readonly Harness[] =>
  slot === "all" ? HARNESSES : HARNESSES.filter((h) => roleTakes(slot, h));

/** The repos with an override, by path, named by the scan where it has
 *  them, sorted by that name. */
export function overrideRows<R extends { path: string; name: string; id: string }>(routes: AgentRoutes, repos: readonly R[]): { path: string; repo: R | null }[] {
  return Object.keys(routes.repos)
    .map((path) => ({ path, repo: repos.find((r) => r.path === path) ?? null }))
    .sort((a, b) => (a.repo?.name ?? a.path).localeCompare(b.repo?.name ?? b.path));
}
