/** `canopy people` (FR-074): who is on a backend, their roles and teams,
 *  the invites that sign them in, and who did what. Each is a call to the
 *  people routes with the caller's token. A person or a team is named by
 *  its id or its name. */

import { findPerson, findTeam, isRole, ROLE_WORDS, ROLES, type ActivityLine, type PeopleFile, type PeopleInfo, type Person, type PersonHere, type Team } from "../core/people";
import { ask, errText, has, take, type Target } from "./health";

export const PEOPLE_USAGE = [
  "usage: canopy people [list] [--backend URL]",
  '       canopy people add "<name>" [--role owner|admin|member|viewer] [--team <team>]... [--no-invite] [--hours N]',
  "       canopy people invite <person> [--hours N]",
  "       canopy people uninvite <person>",
  "       canopy people role <person> <role>",
  '       canopy people rename <person> "<name>"',
  "       canopy people team <person> <team>[,<team>...] | none",
  "       canopy people off | on | remove <person>",
  '       canopy people me [--name "<name>"]',
  "       canopy people teams",
  '       canopy people teams add "<name>" [--folder <path>]...',
  '       canopy people teams set <team> [--name "<name>"] [--folder <path>]...',
  "       canopy people teams remove <team>",
  "       canopy people activity [--person <person>] [--limit N]",
  "",
  `roles: ${ROLES.map((r) => `${r} (${ROLE_WORDS[r]})`).join("; ")}`,
].join("\n");

/** every `--name value` pulled out of args, in order */
export function takeAll(args: string[], name: string): string[] {
  const out: string[] = [];
  for (;;) {
    const v = take(args, name);
    if (v === undefined) return out;
    out.push(v);
  }
}

/** the roster the API sent, in the shape the lookups read */
export function rosterOf(info: PeopleInfo): PeopleFile {
  const owner = info.people.find((p) => p.role === "owner" && p.id === "owner");
  return {
    owner: { name: owner?.name ?? "owner", ...(owner?.color !== undefined ? { color: owner.color } : {}) },
    people: info.people.filter((p) => p.id !== "owner"),
    teams: info.teams,
    invites: [],
  };
}

const teamNames = (p: Pick<Person, "teams">, teams: readonly Team[]): string => p.teams.map((id) => teams.find((t) => t.id === id)?.name ?? id).join(", ");

/** `id  name  role  teams  state`, the owner first */
export function peopleLines(info: PeopleInfo): string[] {
  const wide = Math.max(4, ...info.people.map((p) => p.name.length));
  return info.people.map((p: PersonHere) => {
    const state = [
      p.off ? "off" : "",
      p.devices.length > 0 ? `on: ${p.devices.map((d) => d.name).join(", ")}` : "",
      p.invited > 0 ? `${p.invited} invite${p.invited === 1 ? "" : "s"} waiting` : "",
    ].filter(Boolean);
    return `${p.id.padEnd(10)}  ${p.name.padEnd(wide)}  ${p.role.padEnd(6)}  ${teamNames(p, info.teams) || "-"}${state.length ? `  (${state.join("; ")})` : ""}`;
  });
}

/** `id  name  people  folders` */
export function teamLines(info: PeopleInfo): string[] {
  const wide = Math.max(4, ...info.teams.map((t) => t.name.length));
  return info.teams.map((t) => {
    const on = info.people.filter((p) => p.teams.includes(t.id)).map((p) => p.name);
    return `${t.id}  ${t.name.padEnd(wide)}  ${on.length ? on.join(", ") : "nobody"}${t.folders.length ? `  ${t.folders.join(" ")}` : ""}`;
  });
}

/** `when  who  what  repo`, newest first as the backend sends them */
export function activityLines(lines: readonly ActivityLine[], people: readonly Pick<Person, "id" | "name">[], when: (at: number) => string = (at) => new Date(at).toLocaleString()): string[] {
  const name = (id: string): string => people.find((p) => p.id === id)?.name ?? id;
  return lines.map((l) => `${when(l.at)}  ${name(l.person)}  ${l.what}${l.repo ? ` in ${l.repo}` : ""}${l.kind === "page" ? "" : `  (${l.kind})`}`);
}

/** how an invite is handed over: the link a browser opens and the CLI's line */
export function inviteWords(home: string, name: string, code: string, expires: number, when: (at: number) => string = (at) => new Date(at).toLocaleString()): string[] {
  return [
    `invite for ${name}, good once until ${when(expires)}:`,
    `  in a browser   ${home}/?join=${code}`,
    `  from a shell   canopy auth join ${code} --backend ${home}`,
  ];
}

interface Made {
  person: Person;
  invite?: { code: string; expires: number };
}

export async function peopleCommand(argv: string[], { fail }: { fail: (msg: string) => never }): Promise<void> {
  const args = [...argv];
  const given = take(args, "--backend");
  const home = (given ?? process.env["CANOPY_API"] ?? "http://127.0.0.1:7850").replace(/\/+$/, "");
  if (!/^https?:\/\/[^/\s]+$/.test(home)) return fail(`--backend must be an http(s) origin, got ${home}`);
  const target: Target = { name: "home", urls: [home] };
  const failed = (err: unknown): never => fail(errText(err));
  const roster = (): Promise<PeopleInfo> => ask<PeopleInfo>(target, "GET", "/api/people").catch(failed);
  /** `--hours N` out of a command's words; the backend holds it to 1 to 720 */
  const hoursIn = (words: string[]): number | undefined => {
    const raw = take(words, "--hours");
    if (raw === undefined) return undefined;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : fail("--hours is a number of hours, from 1 to 720");
  };
  /** a person by id or name off the roster, or the command fails */
  const person = (info: PeopleInfo, ref: string | undefined): Person => (ref ? findPerson(rosterOf(info), ref) : undefined) ?? fail(ref ? `nobody here is called ${ref}` : PEOPLE_USAGE);
  const team = (info: PeopleInfo, ref: string | undefined): Team => (ref ? findTeam(rosterOf(info), ref) : undefined) ?? fail(ref ? `no team ${ref}` : PEOPLE_USAGE);

  const [sub, ...rest] = args;

  if (sub === undefined || sub === "list") {
    const info = await roster();
    for (const line of peopleLines(info)) console.log(line);
    return;
  }

  if (sub === "add") {
    const role = take(rest, "--role") ?? "member";
    const teams = takeAll(rest, "--team");
    const bare = has(rest, "--no-invite");
    const hours = hoursIn(rest);
    const name = rest.join(" ").trim();
    if (!name) return fail(PEOPLE_USAGE);
    if (!isRole(role)) return fail(`--role is one of ${ROLES.join(", ")}`);
    const info = teams.length > 0 ? await roster() : null;
    const ids = info ? teams.map((t) => team(info, t).id) : [];
    const made = await ask<Made>(target, "POST", "/api/people/add", { name, role, teams: ids, ...(bare ? {} : { invite: true, ...(hours !== undefined ? { hours } : {}) }) }).catch(failed);
    console.log(`added ${made.person.name} (${made.person.id}) as ${made.person.role}`);
    if (made.invite) for (const line of inviteWords(home, made.person.name, made.invite.code, made.invite.expires)) console.log(line);
    return;
  }

  if (sub === "invite" || sub === "uninvite") {
    const hours = hoursIn(rest);
    const [ref, ...more] = rest;
    if (more.length > 0) return fail(PEOPLE_USAGE);
    const p = person(await roster(), ref);
    if (sub === "uninvite") {
      const out = await ask<{ dropped: number }>(target, "POST", "/api/people/uninvite", { id: p.id }).catch(failed);
      console.log(`dropped ${out.dropped} invite${out.dropped === 1 ? "" : "s"} for ${p.name}`);
      return;
    }
    const out = await ask<{ code: string; expires: number }>(target, "POST", "/api/people/invite", { id: p.id, ...(hours !== undefined ? { hours } : {}) }).catch(failed);
    for (const line of inviteWords(home, p.name, out.code, out.expires)) console.log(line);
    return;
  }

  if (sub === "role" || sub === "rename" || sub === "team") {
    const [ref, ...words] = rest;
    const value = words.join(" ").trim();
    if (!ref || !value) return fail(PEOPLE_USAGE);
    const info = await roster();
    const p = person(info, ref);
    if (sub === "role" && !isRole(value)) return fail(`a role is one of ${ROLES.join(", ")}`);
    const change =
      sub === "role" ? { role: value }
      : sub === "rename" ? { name: value }
      : { teams: value === "none" ? [] : value.split(",").map((t) => team(info, t.trim()).id) };
    const out = await ask<{ person: Person }>(target, "POST", "/api/people/set", { id: p.id, ...change }).catch(failed);
    console.log(`${out.person.name}: ${out.person.role}${out.person.teams.length ? `, on ${teamNames(out.person, info.teams)}` : ""}`);
    return;
  }

  if (sub === "off" || sub === "on" || sub === "remove" || sub === "rm") {
    const [ref, ...more] = rest;
    if (more.length > 0) return fail(PEOPLE_USAGE);
    const p = person(await roster(), ref);
    if (sub === "remove" || sub === "rm") {
      await ask<{ ok: true }>(target, "POST", "/api/people/remove", { id: p.id }).catch(failed);
      console.log(`removed ${p.name}; their sessions, shells' tokens and invites are gone`);
      return;
    }
    await ask<{ person: Person }>(target, "POST", "/api/people/set", { id: p.id, off: sub === "off" }).catch(failed);
    console.log(sub === "off" ? `${p.name} is off: every session of theirs is signed out` : `${p.name} is on again; invite them to sign back in`);
    return;
  }

  if (sub === "me") {
    const name = take(rest, "--name");
    if (rest.length > 0) return fail(PEOPLE_USAGE);
    if (name !== undefined) {
      const out = await ask<{ person: Person }>(target, "POST", "/api/people/me", { name }).catch(failed);
      console.log(`you are ${out.person.name} (${out.person.role})`);
      return;
    }
    const auth = await ask<{ person: { id: string; name: string; role: string } | null; rights: string[] }>(target, "GET", "/api/auth").catch(failed);
    if (!auth.person) return fail("nobody is signed in here; run canopy auth login, or canopy auth join <code>");
    console.log(`${auth.person.name} (${auth.person.id}), ${auth.person.role}; this token holds ${auth.rights.join(", ") || "nothing"}`);
    return;
  }

  if (sub === "teams") {
    const [verb, ...words] = rest;
    if (verb === undefined) {
      const info = await roster();
      if (info.teams.length === 0) return console.log("no teams");
      for (const line of teamLines(info)) console.log(line);
      return;
    }
    const folders = takeAll(words, "--folder");
    const name = take(words, "--name");
    if (verb === "add") {
      const called = (name ?? words.join(" ")).trim();
      if (!called) return fail(PEOPLE_USAGE);
      const out = await ask<{ team: Team }>(target, "POST", "/api/people/team", { name: called, folders }).catch(failed);
      console.log(`made ${out.team.name} (${out.team.id})${out.team.folders.length ? `: ${out.team.folders.join(" ")}` : ""}`);
      return;
    }
    if (verb === "set" || verb === "remove" || verb === "rm") {
      const [ref, ...more] = words;
      if (more.length > 0) return fail(PEOPLE_USAGE);
      const t = team(await roster(), ref);
      if (verb !== "set") {
        await ask<{ ok: true }>(target, "POST", "/api/people/team/remove", { id: t.id }).catch(failed);
        console.log(`removed ${t.name}`);
        return;
      }
      if (name === undefined && folders.length === 0) return fail(PEOPLE_USAGE);
      const out = await ask<{ team: Team }>(target, "POST", "/api/people/team", { id: t.id, ...(name !== undefined ? { name } : {}), ...(folders.length > 0 ? { folders } : {}) }).catch(failed);
      console.log(`${out.team.name} (${out.team.id})${out.team.folders.length ? `: ${out.team.folders.join(" ")}` : ""}`);
      return;
    }
    return fail(PEOPLE_USAGE);
  }

  if (sub === "activity") {
    const who = take(rest, "--person");
    const limit = take(rest, "--limit");
    if (rest.length > 0) return fail(PEOPLE_USAGE);
    const info = await roster();
    const id = who === undefined ? undefined : person(info, who).id;
    const q = new URLSearchParams({ ...(id ? { person: id } : {}), ...(limit ? { limit } : {}) }).toString();
    const out = await ask<{ lines: ActivityLine[] }>(target, "GET", `/api/people/activity${q ? `?${q}` : ""}`).catch(failed);
    if (out.lines.length === 0) return console.log("nothing yet");
    for (const line of activityLines(out.lines, info.people)) console.log(line);
    return;
  }

  return fail(PEOPLE_USAGE);
}
