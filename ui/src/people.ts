/* People on the page (FR-074): what the People view, the top bar's faces
   and a repo card's read off each backend's roster. Pure; tested. The rules
   themselves are src/core/people.ts, which the backend checks. */

import { colorOf, focusOf, inFocus, initials, inviteCode, type PeopleInfo, type Person, type PersonHere, type Role } from "../../src/core/people";
import type { Right } from "../../src/core/callers";

/** an invite still waiting, as an admin's read of the roster lists it: never its code */
export interface InviteRow {
  person: string;
  created: number;
  expires: number;
  by: string;
}

/** one backend's roster as the page keeps it */
export interface Roster extends PeopleInfo {
  invites: InviteRow[];
}

/** whether a reply is `GET /api/people`'s, not an older backend's 404 */
export function isRoster(v: unknown): v is Roster {
  if (typeof v !== "object" || v === null) return false;
  return Array.isArray(Reflect.get(v, "people")) && Array.isArray(Reflect.get(v, "teams")) && Array.isArray(Reflect.get(v, "invites"));
}

/** A face: two letters on the person's hue. */
export interface Face {
  id: string;
  name: string;
  letters: string;
  hue: number;
}

export const faceOf = (p: Pick<Person, "id" | "name" | "color">): Face => ({ id: p.id, name: p.name, letters: initials(p.name), hue: colorOf(p) });

/** a person's name by id, or the id for someone no longer on the roster */
export const nameOf = (people: readonly Pick<Person, "id" | "name">[] | undefined, id: string): string => people?.find((p) => p.id === id)?.name ?? id;

/** everyone else with a browser on, in the roster's order */
export function othersHere(roster: Roster | undefined, me: string | undefined): PersonHere[] {
  if (!roster) return [];
  return roster.people.filter((p) => p.id !== me && !p.off && p.devices.length > 0);
}

/** the others who have a repo open, by the id its backend knows */
export function othersAt(roster: Roster | undefined, me: string | undefined, repoId: string): PersonHere[] {
  return othersHere(roster, me).filter((p) => p.at.includes(repoId));
}

/** The folders a person's teams work in, and whether a repo's path is among
 *  them. A person on no team, or whose teams name no folder, has no focus. */
export function focusFor(roster: Roster | undefined, me: string | undefined): string[] {
  const p = roster?.people.find((x) => x.id === me);
  return roster && p ? focusOf(roster.teams, p) : [];
}

export { inFocus };

/** Whether a page starts on its person's team folders: a member or a viewer
 *  whose teams name any. An owner or an admin starts on the whole grove. */
export const startsFocused = (role: Role | undefined, focus: readonly string[] | undefined): boolean => (role === "member" || role === "viewer") && (focus?.length ?? 0) > 0;

/** `?join=<code>` off a URL's query: the invite a link carries, or null */
export function joinCodeIn(search: string): string | null {
  const raw = new URLSearchParams(search).get("join");
  return raw === null ? null : inviteCode(raw);
}

/** the URL without its invite, so a reload or a shared link never spends it twice */
export function withoutJoin(href: string): string {
  const u = new URL(href);
  u.searchParams.delete("join");
  return `${u.pathname}${u.search}${u.hash}`;
}

/** the link a person opens to sign in with an invite */
export const inviteLink = (origin: string, code: string): string => `${origin}/?join=${code}`;

/** how long an invite still has, in the words its row shows */
export function expiresWords(expires: number, now: number): string {
  const left = expires - now;
  if (left <= 0) return "expired";
  const hours = Math.floor(left / 3_600_000);
  if (hours >= 48) return `${Math.floor(hours / 24)} days left`;
  if (hours >= 1) return `${hours} h left`;
  return `${Math.max(1, Math.floor(left / 60_000))} min left`;
}

/** What a viewer reads on their chip: a role that cannot operate starts and
 *  changes nothing, and the buttons that would are refused by the backend.
 *  Null for a role that operates. */
export function roleLimit(role: Role | undefined, rights: readonly Right[] | undefined): string | null {
  if (!role || !rights || rights.includes("operate")) return null;
  return "You are viewing: you see the repos, the runs and who is here, and start or change nothing.";
}

/** the roles one person may hand another, by their own */
export function grantable(mine: Role | undefined): Role[] {
  if (mine === "owner") return ["owner", "admin", "member", "viewer"];
  if (mine === "admin") return ["admin", "member", "viewer"];
  return [];
}
