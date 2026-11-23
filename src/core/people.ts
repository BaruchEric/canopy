/** People, roles and teams (FR-074;
 *  docs/superpowers/specs/2026-11-22-people-design.md): who a caller is, what
 *  their role lets them do, and which repos a team's folders cover. Pure and
 *  browser-safe, since the page reads the same tables the gate checks. The
 *  file and the routes are `server/people.ts`.
 *
 *  A caller's rights are its kind's and its person's role's, both. The
 *  built-in person `owner` always exists and is who a session with no person
 *  belongs to, so a backend with no `people.json` behaves as it did before
 *  there were people. */

import { allows, KIND_RIGHTS, type CallerKind, type Right } from "./callers";

export type Role = "owner" | "admin" | "member" | "viewer";
export const ROLES: readonly Role[] = ["owner", "admin", "member", "viewer"];

/** the built-in person: never in the file's list, never removed or demoted */
export const OWNER_ID = "owner";

const ALL: readonly Right[] = ["read", "plan", "operate", "shell", "admin", "helper"];

/** What a role may hold. A member works (runs, shells, a helper on their own
 *  machine) and changes nothing about the backend; a viewer reads the board. */
export const ROLE_RIGHTS: Record<Role, readonly Right[]> = {
  owner: ALL,
  admin: ALL,
  member: ["read", "plan", "operate", "shell", "helper"],
  viewer: ["read"],
};

/** what each role is, in a line, for the page and the CLI */
export const ROLE_WORDS: Record<Role, string> = {
  owner: "everything, and the only one who makes or changes an owner",
  admin: "everything but changing an owner: people, sources, the kit, secrets",
  member: "runs, chats, shells and commits; no settings, people or secrets",
  viewer: "reads the board; starts and changes nothing",
};

const RANK: Record<Role, number> = { viewer: 0, member: 1, admin: 2, owner: 3 };

export const isRole = (v: unknown): v is Role => ROLES.some((r) => r === v);

const isKind = (v: unknown): v is CallerKind => typeof v === "string" && Object.hasOwn(KIND_RIGHTS, v);

export const roleAllows = (role: Role, right: Right | "open"): boolean => right === "open" || ROLE_RIGHTS[role].includes(right);

/** whether a caller of this kind, whose person has this role, holds a right */
export const allowsAs = (kind: CallerKind, role: Role, right: Right | "open"): boolean => allows(kind, right) && roleAllows(role, right);

/** every right a caller holds, for the page to ask once */
export const rightsOf = (kind: CallerKind, role: Role): Right[] => ALL.filter((r) => allowsAs(kind, role, r));

/** Whether someone with `actor`'s role may hand out `target`'s: make a person
 *  of that role, invite one, change one, or give one a device. Nobody hands
 *  out more than they hold, and only an admin or an owner hands out at all. */
export const mayGrant = (actor: Role, target: Role): boolean => roleAllows(actor, "admin") && RANK[actor] >= RANK[target];

export interface Person {
  /** `p-` and eight base32 characters, or `owner` */
  id: string;
  name: string;
  role: Role;
  /** the teams whose folders a member's or viewer's page starts on; none is the whole backend */
  teams: string[];
  /** a hue, 0 to 359, for their initials; one off their id when unset */
  color?: number;
  /** unix ms */
  created: number;
  /** kept on record, holding no token */
  off?: true;
}

export interface Team {
  /** `t-` and eight base32 characters */
  id: string;
  name: string;
  /** absolute paths (or ssh locators) on this backend; a repo under one is the team's */
  folders: string[];
  created: number;
}

/** an invite as kept: the code's SHA-256, never the code */
export interface Invite {
  hash: string;
  person: string;
  created: number;
  expires: number;
  /** the person who made it */
  by: string;
}

export interface PeopleFile {
  owner: { name: string; color?: number };
  people: Person[];
  teams: Team[];
  invites: Invite[];
}

export const NAME_MAX = 40;
export const MOST_INVITES = 5;
export const INVITE_HOURS = 72;
export const INVITE_HOURS_MAX = 30 * 24;
export const MOST_PLACES = 12;
const HOUR = 60 * 60 * 1000;

const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";
const PERSON_ID = /^p-[a-z2-7]{8}$/;
const TEAM_ID = /^t-[a-z2-7]{8}$/;
const INVITE = /^cnv_[a-z2-7]{24}$/;

type Random = (n: number) => Uint8Array;
const random: Random = (n) => globalThis.crypto.getRandomValues(new Uint8Array(n));

/** `n` base32 characters off random bytes, one byte each: 5 bits kept */
function base32(n: number, rand: Random): string {
  const bytes = rand(n);
  if (bytes.length !== n) throw new Error(`an id takes ${n} random bytes`);
  let out = "";
  for (const b of bytes) out += BASE32[b & 31];
  return out;
}

export const isPersonId = (v: unknown): v is string => typeof v === "string" && (v === OWNER_ID || PERSON_ID.test(v));
export const isTeamId = (v: unknown): v is string => typeof v === "string" && TEAM_ID.test(v);
export const mintPersonId = (rand: Random = random): string => `p-${base32(8, rand)}`;
export const mintTeamId = (rand: Random = random): string => `t-${base32(8, rand)}`;
/** an invite code: 120 bits, typed or pasted in a link */
export const mintInvite = (rand: Random = random): string => `cnv_${base32(24, rand)}`;
/** an invite as typed: trimmed and lowercased, or null when it is not one */
export function inviteCode(raw: string): string | null {
  const c = raw.trim().toLowerCase();
  return INVITE.test(c) ? c : null;
}

/** A name as kept: one line, no control characters, at most `NAME_MAX`. */
export function cleanName(raw: string): string {
  // eslint-disable-next-line no-control-regex
  return raw.replace(/[\s\x00-\x1f\x7f]+/g, " ").trim().slice(0, NAME_MAX).trim();
}

/** a hue from an id, one of twelve, so two people rarely share one */
export function hueOf(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return (h % 12) * 30;
}

export const colorOf = (p: Pick<Person, "id" | "color">): number => p.color ?? hueOf(p.id);

/** two letters for a person: the first of their first two words, or the
 *  first two of a single word */
export function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const first = words[0] ?? "";
  const second = words[1];
  const two = second ? `${[...first][0] ?? ""}${[...second][0] ?? ""}` : [...first].slice(0, 2).join("");
  return two.toUpperCase() || "?";
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const timeOf = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined);
const hue = (v: unknown): number | undefined => (typeof v === "number" && Number.isInteger(v) && v >= 0 && v < 360 ? v : undefined);
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x !== "") : []);

export const EMPTY_PEOPLE: PeopleFile = { owner: { name: "owner" }, people: [], teams: [], invites: [] };

/** The file read back. A record that does not check out is dropped, never the
 *  file; a second record with an id or a name already taken is dropped too. */
export function parsePeople(v: unknown): PeopleFile {
  if (!isRecord(v)) return { ...EMPTY_PEOPLE, owner: { ...EMPTY_PEOPLE.owner } };
  const o = isRecord(v["owner"]) ? v["owner"] : {};
  const ownerName = typeof o["name"] === "string" ? cleanName(o["name"]) : "";
  const ownerHue = hue(o["color"]);
  const owner = { name: ownerName || "owner", ...(ownerHue !== undefined ? { color: ownerHue } : {}) };
  const teams: Team[] = [];
  for (const t of Array.isArray(v["teams"]) ? v["teams"] : []) {
    if (!isRecord(t) || !isTeamId(t["id"]) || typeof t["name"] !== "string") continue;
    const name = cleanName(t["name"]);
    if (!name || teams.some((x) => x.id === t["id"] || sameName(x.name, name))) continue;
    teams.push({ id: t["id"], name, folders: strings(t["folders"]).map(cleanFolder).filter((f): f is string => f !== null), created: timeOf(t["created"]) ?? 0 });
  }
  const people: Person[] = [];
  for (const p of Array.isArray(v["people"]) ? v["people"] : []) {
    if (!isRecord(p) || typeof p["id"] !== "string" || !PERSON_ID.test(p["id"]) || typeof p["name"] !== "string" || !isRole(p["role"])) continue;
    const name = cleanName(p["name"]);
    if (!name || sameName(name, owner.name) || people.some((x) => x.id === p["id"] || sameName(x.name, name))) continue;
    const color = hue(p["color"]);
    people.push({
      id: p["id"],
      name,
      role: p["role"],
      teams: strings(p["teams"]).filter((id) => teams.some((t) => t.id === id)),
      created: timeOf(p["created"]) ?? 0,
      ...(color !== undefined ? { color } : {}),
      ...(p["off"] === true ? { off: true as const } : {}),
    });
  }
  const invites: Invite[] = [];
  for (const i of Array.isArray(v["invites"]) ? v["invites"] : []) {
    if (!isRecord(i) || typeof i["hash"] !== "string" || !/^[0-9a-f]{64}$/.test(i["hash"]) || typeof i["person"] !== "string") continue;
    const created = timeOf(i["created"]);
    const expires = timeOf(i["expires"]);
    if (created === undefined || expires === undefined) continue;
    if (i["person"] !== OWNER_ID && !people.some((p) => p.id === i["person"])) continue;
    invites.push({ hash: i["hash"], person: i["person"], created, expires, by: typeof i["by"] === "string" ? i["by"] : OWNER_ID });
  }
  return { owner, people, teams, invites };
}

const sameName = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/** the owner as a person, so every list and check reads one shape */
export const ownerOf = (file: PeopleFile): Person => ({
  id: OWNER_ID,
  name: file.owner.name,
  role: "owner",
  teams: [],
  created: 0,
  ...(file.owner.color !== undefined ? { color: file.owner.color } : {}),
});

/** everyone, the owner first */
export const everyone = (file: PeopleFile): Person[] => [ownerOf(file), ...file.people];

export const personById = (file: PeopleFile, id: string): Person | undefined => (id === OWNER_ID ? ownerOf(file) : file.people.find((p) => p.id === id));

/** a person by id or by name, as a CLI names one; names compare without case */
export function findPerson(file: PeopleFile, ref: string): Person | undefined {
  const r = ref.trim();
  return personById(file, r) ?? everyone(file).find((p) => sameName(p.name, r));
}

export const findTeam = (file: PeopleFile, ref: string): Team | undefined => {
  const r = ref.trim();
  return file.teams.find((t) => t.id === r) ?? file.teams.find((t) => sameName(t.name, r));
};

/** The person a session with this `user` is: the owner for a session from
 *  before there were people, and null for one whose person is gone or off,
 *  whose token then is nobody's. */
export function personOf(file: PeopleFile, user: string | undefined): Person | null {
  const p = personById(file, user ?? OWNER_ID);
  return p && !p.off ? p : null;
}

/* ---------- the rules, each answering a refusal's words or null ---------- */

const taken = (file: PeopleFile, name: string, but?: string): boolean => everyone(file).some((p) => p.id !== but && sameName(p.name, name));

const teamsRefusal = (file: PeopleFile, teams: readonly string[]): string | null => {
  const missing = teams.find((id) => !file.teams.some((t) => t.id === id));
  return missing ? `no team ${missing}` : null;
};

export function addRefusal(file: PeopleFile, actor: Person, want: { name: string; role: Role; teams: readonly string[] }): string | null {
  if (!want.name) return "a person needs a name";
  if (taken(file, want.name)) return `${want.name} is someone here already`;
  if (!mayGrant(actor.role, want.role)) return roleAllows(actor.role, "admin") ? `only an owner makes an ${want.role}` : "adding a person takes the admin right";
  return teamsRefusal(file, want.teams);
}

export interface PersonChange {
  name?: string;
  role?: Role;
  teams?: readonly string[];
  off?: boolean;
  color?: number | null;
}

/** Why `actor` may not change `target` this way. The owner keeps their role
 *  and stays on; nobody changes someone above them, or lifts anyone above
 *  themselves; nobody turns themselves off or changes their own role. */
export function setRefusal(file: PeopleFile, actor: Person, target: Person, change: PersonChange): string | null {
  if (!mayGrant(actor.role, target.role)) return roleAllows(actor.role, "admin") ? `only an owner changes ${target.name}` : "changing a person takes the admin right";
  if (change.name !== undefined) {
    if (!change.name) return "a person needs a name";
    if (taken(file, change.name, target.id)) return `${change.name} is someone here already`;
  }
  if (change.role !== undefined && change.role !== target.role) {
    if (target.id === OWNER_ID) return "the owner stays the owner";
    if (target.id === actor.id) return "someone else changes your role";
    if (!mayGrant(actor.role, change.role)) return `only an owner makes an ${change.role}`;
  }
  if (change.off !== undefined) {
    if (target.id === OWNER_ID) return "the owner cannot be turned off";
    if (target.id === actor.id) return "sign out instead; someone else turns you off";
  }
  if (change.color !== undefined && change.color !== null && hue(change.color) === undefined) return "a colour is a hue from 0 to 359";
  return change.teams ? teamsRefusal(file, change.teams) : null;
}

/** what anyone may change about themselves: their name and their colour */
export function meRefusal(file: PeopleFile, me: Person, change: { name?: string; color?: number | null }): string | null {
  if (change.name !== undefined) {
    if (!change.name) return "a person needs a name";
    if (taken(file, change.name, me.id)) return `${change.name} is someone here already`;
  }
  if (change.color !== undefined && change.color !== null && hue(change.color) === undefined) return "a colour is a hue from 0 to 359";
  return null;
}

export function removeRefusal(actor: Person, target: Person): string | null {
  if (target.id === OWNER_ID) return "the owner cannot be removed";
  if (target.id === actor.id) return "sign out instead; someone else removes you";
  if (!mayGrant(actor.role, target.role)) return roleAllows(actor.role, "admin") ? `only an owner removes ${target.name}` : "removing a person takes the admin right";
  return null;
}

/** Why `actor` may not hand a session of `target`'s out: an invite, or an
 *  approved device. Your own is always yours to add a device to, as long as
 *  you may approve at all. */
export function handRefusal(actor: Person, target: Person): string | null {
  if (target.off) return `${target.name} is turned off`;
  if (!roleAllows(actor.role, "admin")) return "handing out a sign-in takes the admin right";
  if (target.id !== actor.id && !mayGrant(actor.role, target.role)) return `only an owner signs ${target.name} in`;
  return null;
}

/** how long an invite lasts, from hours as asked: 72 unsaid, 1 to 720 */
export function inviteLife(hours: unknown): number | null {
  if (hours === undefined || hours === null) return INVITE_HOURS * HOUR;
  if (typeof hours !== "number" || !Number.isFinite(hours) || hours < 1 || hours > INVITE_HOURS_MAX) return null;
  return Math.round(hours * HOUR);
}

/** the invites still good at `now` */
export const liveInvites = (file: PeopleFile, now: number): Invite[] => file.invites.filter((i) => i.expires > now);

/* ---------- teams: which repos a person sees ---------- */

/** A folder as kept: an absolute path or an ssh locator with no trailing
 *  slash, or null when it is neither. */
export function cleanFolder(raw: string): string | null {
  const f = raw.trim();
  if (!f.startsWith("/") && !f.startsWith("ssh://")) return null;
  const cut = f.length > 1 ? f.replace(/\/+$/, "") : f;
  return cut || "/";
}

export function teamRefusal(file: PeopleFile, want: { name: string; folders: readonly string[] }, but?: string): string | null {
  if (!want.name) return "a team needs a name";
  if (file.teams.some((t) => t.id !== but && sameName(t.name, want.name))) return `there is a team ${want.name} already`;
  const bad = want.folders.find((f) => cleanFolder(f) === null);
  return bad !== undefined ? `${bad} is not an absolute path on this backend` : null;
}

/** whether a repo's path sits in a folder: the folder itself or below it */
export const under = (path: string, folder: string): boolean => path === folder || path.startsWith(folder === "/" ? "/" : `${folder}/`);

/** The folders a person's teams work in, which their page shows first.
 *  A focus and not a wall: every person on a backend can open every repo
 *  it scans, since they all act as one OS user (the spec's trust section).
 *  Empty for a person on no team, or whose teams name no folder. */
export function focusOf(teams: readonly Team[], person: Pick<Person, "teams">): string[] {
  const out = new Set<string>();
  for (const t of teams) if (person.teams.includes(t.id)) for (const f of t.folders) out.add(f);
  return [...out];
}

/** whether a repo's path is in a focus; an empty focus holds every repo */
export const inFocus = (focus: readonly string[], path: string): boolean => focus.length === 0 || focus.some((f) => under(path, f));

/* ---------- who did what ---------- */

export interface ActivityLine {
  at: number;
  /** the person's id */
  person: string;
  /** the kind of caller it came through: a page, the CLI, a shell's agent */
  kind: CallerKind;
  what: string;
  /** the repo's name, when the call named one */
  repo?: string;
}

/** The writes worth a line, with their words. A route not here is never
 *  logged: beats, tickets, layout and clipboard writes say nothing about the
 *  work. Keyed by method and exact path. */
export const ACTIVITY: Readonly<Record<string, string>> = {
  "POST /api/repos/run": "started a run",
  "POST /api/repos/flow": "started a workflow",
  "POST /api/repos/resume": "resumed a session",
  "POST /api/repos/agent": "started an agent in a shell",
  "POST /api/repos/stage": "staged changes",
  "POST /api/repos/commit": "committed",
  "POST /api/repos/push": "pushed",
  "POST /api/repos/pull": "pulled",
  "POST /api/repos/archive": "archived a repo",
  "POST /api/workspaces/run": "started a workspace run",
  "POST /api/runs/answer": "answered a prompt",
  "POST /api/runs/stop": "stopped a run",
  "POST /api/runs/interrupt": "stopped a run's turn",
  "POST /api/runs/fork": "forked a run",
  "POST /api/runs/say": "sent a run a message",
  "DELETE /api/runs": "dismissed a run",
  "POST /api/flows/stop": "stopped a workflow",
  "POST /api/flows/resume": "continued a workflow",
  "POST /api/flows/pickup": "picked a workflow up",
  "POST /api/landing/land": "landed a branch",
  "POST /api/landing/land-all": "landed every ready branch",
  "POST /api/landing/drop": "dropped a branch",
  "POST /api/landing/fix": "sent a branch back for a fix",
  "POST /api/landing/followup": "followed a branch up",
  "POST /api/prs/open": "opened a PR",
  "POST /api/prs/close": "closed a PR",
  "POST /api/trees/add": "kept a worktree",
  "POST /api/trees/remove": "removed a worktree",
  "POST /api/trees/merge": "merged a worktree",
  "POST /api/coordinator/new": "started a goal",
  "POST /api/coordinator/start": "started a goal's cards",
  "POST /api/coordinator/hold": "held a goal",
  "POST /api/groups/pick": "picked a best-of-N winner",
  "POST /api/incubator": "started a project",
  "POST /api/triggers/fire": "fired a trigger",
  "POST /api/asks/answer": "answered an ask",
  "DELETE /api/terms": "closed a shell",
  "POST /api/sources": "added a source",
  "DELETE /api/sources": "removed a source",
  "POST /api/kit/apply": "applied the kit",
  "POST /api/secrets/act": "changed a secret",
  "POST /api/auth/approve": "approved a device",
  "POST /api/auth/deny": "denied a device",
  "POST /api/auth/revoke": "revoked a session",
  "POST /api/people/add": "added a person",
  "POST /api/people/set": "changed a person",
  "POST /api/people/remove": "removed a person",
  "POST /api/people/invite": "made an invite",
  "POST /api/people/team": "changed a team",
  "POST /api/people/team/remove": "removed a team",
};

export const activityWords = (method: string, path: string): string | null => ACTIVITY[`${method} ${path}`] ?? null;

export function parseActivity(v: unknown): ActivityLine | null {
  if (!isRecord(v)) return null;
  const at = timeOf(v["at"]);
  if (at === undefined || typeof v["person"] !== "string" || typeof v["what"] !== "string" || !isKind(v["kind"])) return null;
  return { at, person: v["person"], kind: v["kind"], what: v["what"], ...(typeof v["repo"] === "string" && v["repo"] ? { repo: v["repo"] } : {}) };
}

/* ---------- what the page is told ---------- */

/** a person as the roster shows them: who they are, what they have on and where */
export interface PersonHere extends Person {
  /** the browsers they have on the event stream now */
  devices: { id: string; name: string; platform: string }[];
  /** the repos those browsers have open, by id */
  at: string[];
  /** invites of theirs still waiting */
  invited: number;
}

export interface PeopleInfo {
  people: PersonHere[];
  teams: Team[];
}

/** what `GET /api/auth` says of the caller's person */
export interface Me {
  id: string;
  name: string;
  role: Role;
}

/** A person's place as said by one browser: its open repos, the first
 *  `MOST_PLACES`, each an id; null when the body is not that. */
export function parsePlaces(v: unknown): string[] | null {
  if (!Array.isArray(v)) return null;
  const out: string[] = [];
  for (const x of v) {
    if (typeof x !== "string" || x === "" || x.length > 200) return null;
    if (!out.includes(x)) out.push(x);
    if (out.length === MOST_PLACES) break;
  }
  return out;
}
