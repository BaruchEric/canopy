/** People, the server half (FR-074;
 *  docs/superpowers/specs/2026-11-22-people-design.md): the file, the routes
 *  under /api/people, the `people` event, where each person is, and the log
 *  of who did what. The rules are `core/people.ts`.
 *
 *  `<config dir>/people.json` holds the roster, the teams and the invites'
 *  hashes. The gate asks a caller's role on every request, so the file is
 *  kept in memory and read again only when its mtime moves, looked at no
 *  more than every two seconds: a second server on the same config dir (a
 *  redeploy's overlap) then follows a change within that. A write reads the
 *  file first and goes through a temp file and a rename at 0600.
 *
 *  `<config dir>/activity.jsonl` takes a line per write `ACTIVITY` gives
 *  words to. Bun-only (fs). */

import { readFileSync, statSync } from "node:fs";
import { appendFile, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import {
  addRefusal,
  cleanFolder,
  cleanName,
  everyone,
  handRefusal,
  inviteLife,
  isRole,
  liveInvites,
  meRefusal,
  mintInvite,
  mintPersonId,
  mintTeamId,
  MOST_INVITES,
  OWNER_ID,
  ownerOf,
  parseActivity,
  parsePeople,
  parsePlaces,
  personById,
  personOf,
  removeRefusal,
  roleAllows,
  setRefusal,
  teamRefusal,
  type ActivityLine,
  type Me,
  type PeopleFile,
  type PeopleInfo,
  type Person,
  type PersonChange,
  type PersonHere,
  type Role,
  type Team,
} from "../core/people";
import { configDir } from "../core/store";
import type { Device, ServerEvent } from "../core/types";
import type { Actor } from "./actor";
import type { AuthPeople, Caller, CallersMode } from "./callers";

export const peopleFile = (dir: string = configDir()): string => join(dir, "people.json");
export const activityFile = (dir: string = configDir()): string => join(dir, "activity.jsonl");

/** how often the file's mtime is looked at */
const LOOK_EVERY = 2_000;
/** the log is cut to its newest half past this size */
const ACTIVITY_MAX = 2 * 1024 * 1024;
const ACTIVITY_SHOWN = 200;
/** how long a place said by a browser whose stream is not up yet is kept:
 *  a page says where it is as it loads, a moment before its stream opens */
const PLACE_WAITS = 30_000;
/** the places kept at most, so a caller cannot grow the map without end */
const MOST_BROWSERS = 500;

export interface PeopleDeps {
  broadcast: (ev: ServerEvent) => void;
  /** drops every token a person holds: their sessions, shells and runs */
  dropUser: (id: string) => Promise<void>;
  /** the browsers on the event stream now */
  devices: () => Device[];
  dir?: string;
  now?: () => number;
}

const json = (data: unknown, status = 200): Response => Response.json(data, { status });
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err));
const sha = (s: string): string => createHash("sha256").update(s).digest("hex");
const isMissing = (err: unknown): boolean => typeof err === "object" && err !== null && "code" in err && err.code === "ENOENT";

/** a refusal the routes answer with its status */
class Refusal extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const refuse = (why: string | null, status = 403): void => {
  if (why) throw new Refusal(status, why);
};

export class PeopleHub implements AuthPeople {
  private kept: PeopleFile;
  private mtime = 0;
  private looked = 0;
  /** the writes, one after another, each on a fresh read of the file */
  private serial: Promise<void> = Promise.resolve();
  /** the repos each browser has open, by its device id */
  private places = new Map<string, { person: string; repos: string[]; said: number }>();
  private logged = 0;
  /** the log's appends, one after another, so lines land in the order they were said */
  private logging: Promise<void> = Promise.resolve();

  constructor(private deps: PeopleDeps) {
    this.kept = this.load();
  }

  private get dir(): string {
    return this.deps.dir ?? configDir();
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  /** The file as it is on disk. Only a missing file is nobody but the
   *  owner; one that cannot be read keeps what was last read, since an
   *  empty roster would hand every member's token to the owner's role
   *  check as "gone" and, worse, read a broken file as no people at all. */
  private load(): PeopleFile {
    const file = peopleFile(this.dir);
    try {
      const raw = readFileSync(file, "utf8");
      this.mtime = statSync(file).mtimeMs;
      return parsePeople(JSON.parse(raw));
    } catch (err) {
      if (isMissing(err)) {
        this.mtime = 0;
        return parsePeople(null);
      }
      console.error(`people: ${file} could not be read (${errText(err)}); keeping the roster last read`);
      return this.kept ?? parsePeople(null);
    }
  }

  /** the roster, read again when the file moved since the last look */
  file(): PeopleFile {
    const at = this.now();
    if (at - this.looked < LOOK_EVERY) return this.kept;
    this.looked = at;
    let mtime = 0;
    try {
      mtime = statSync(peopleFile(this.dir)).mtimeMs;
    } catch {
      // gone: nobody but the owner
    }
    if (mtime !== this.mtime) {
      this.kept = this.load();
      this.publish();
    }
    return this.kept;
  }

  /** Resolves once every write and every line of the log queued so far has settled. */
  async flush(): Promise<void> {
    await this.serial;
    await this.logging;
  }

  private async write(next: PeopleFile): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    const file = peopleFile(this.dir);
    const tmp = `${file}.tmp-${process.pid}-${crypto.randomUUID().slice(0, 8)}`;
    try {
      await writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
      await rename(tmp, file);
      this.mtime = (await stat(file)).mtimeMs;
    } catch (err) {
      await rm(tmp, { force: true }).catch(() => undefined);
      throw err;
    }
  }

  /** One change: the file read again, `fn` applied (it throws a `Refusal` to
   *  change nothing), the result written and told to every stream. */
  private change<T>(fn: (file: PeopleFile) => { file: PeopleFile; out: T }): Promise<T> {
    const next = this.serial.then(async () => {
      this.kept = this.load();
      const { file, out } = fn(this.kept);
      await this.write(file);
      this.kept = file;
      this.looked = this.now();
      this.publish();
      return out;
    });
    this.serial = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  /* ---------- who a caller is ---------- */

  personOf(caller: Caller | null): Person | null {
    return personOf(this.file(), caller?.user);
  }

  /** the gate's question: a caller's role, null once its person is gone or off */
  roleOf(caller: Caller): Role | null {
    return this.personOf(caller)?.role ?? null;
  }

  idOf(caller: Caller | null): string {
    return caller?.user ?? OWNER_ID;
  }

  me(caller: Caller | null, mode: CallersMode): Me | null {
    if (!caller && mode === "enforce") return null;
    const file = this.file();
    const p = personOf(file, caller?.user);
    return p ? { id: p.id, name: p.name, role: p.role } : null;
  }

  handRefusal(actor: Caller | null, person: string): string | null {
    const file = this.file();
    const who = personOf(file, actor?.user);
    const target = personById(file, person);
    if (!who) return "handing out a sign-in takes the admin right";
    if (!target) return `no person ${person}`;
    return handRefusal(who, target);
  }

  /** An invite spent, once: its hash is taken out of the file before the
   *  token is minted, so two claims of one code cannot both win. */
  async redeem(code: string): Promise<{ person: string; name: string } | null> {
    const hash = sha(code);
    try {
      return await this.change((file) => {
        const now = this.now();
        const invite = liveInvites(file, now).find((i) => i.hash === hash);
        const person = invite ? personById(file, invite.person) : undefined;
        if (!invite || !person || person.off) throw new Refusal(403, "not an invite");
        return { file: { ...file, invites: liveInvites(file, now).filter((i) => i.hash !== hash) }, out: { person: person.id, name: person.name } };
      });
    } catch (err) {
      if (err instanceof Refusal) return null;
      throw err;
    }
  }

  /* ---------- who is here ---------- */

  /** every person with the browsers they have on and the repos those have open */
  info(): PeopleInfo {
    const file = this.kept;
    const devices = this.deps.devices();
    const now = this.now();
    const live = liveInvites(file, now);
    const people: PersonHere[] = everyone(file).map((p) => {
      const mine = devices.filter((d) => (d.person ?? OWNER_ID) === p.id);
      const at = new Set<string>();
      for (const d of mine) {
        const place = this.places.get(d.id);
        // a place counts only for the person who said it
        if (place?.person === p.id) for (const r of place.repos) at.add(r);
      }
      return {
        ...p,
        teams: [...p.teams],
        devices: mine.map((d) => ({ id: d.id, name: d.name, platform: d.platform })),
        at: [...at],
        invited: live.filter((i) => i.person === p.id).length,
      };
    });
    return { people, teams: file.teams.map((t) => ({ ...t, folders: [...t.folders] })) };
  }

  publish(): void {
    this.deps.broadcast({ type: "people", ...this.info() });
  }

  /** The devices list moved: a browser came or went. A place is forgotten
   *  with its last stream, bar one said so lately its stream may not be up. */
  sawDevices(): void {
    const on = new Set(this.deps.devices().map((d) => d.id));
    const now = this.now();
    for (const [id, place] of this.places) if (!on.has(id) && now - place.said > PLACE_WAITS) this.places.delete(id);
    this.publish();
  }

  /* ---------- who did what ---------- */

  /** One line of activity. Never throws and never waits: a full disk must
   *  not fail the call it describes. */
  note(who: Actor, what: string, repo?: string): void {
    const line: ActivityLine = { at: this.now(), person: who.person, kind: who.kind, what, ...(repo ? { repo } : {}) };
    const file = activityFile(this.dir);
    this.logging = this.logging.then(async () => {
      try {
        await mkdir(this.dir, { recursive: true, mode: 0o700 });
        await appendFile(file, `${JSON.stringify(line)}\n`, { mode: 0o600 });
        if (++this.logged % 50 === 0 && (await stat(file)).size > ACTIVITY_MAX) await this.cutActivity();
      } catch (err) {
        console.error(`people: could not log activity (${errText(err)})`);
      }
    });
  }

  private async cutActivity(): Promise<void> {
    const file = activityFile(this.dir);
    const lines = (await readFile(file, "utf8")).split("\n").filter(Boolean);
    const tmp = `${file}.tmp-${process.pid}-${crypto.randomUUID().slice(0, 8)}`;
    await writeFile(tmp, `${lines.slice(Math.floor(lines.length / 2)).join("\n")}\n`, { mode: 0o600 });
    await rename(tmp, file);
  }

  /** the newest lines first, one person's when asked */
  async activity(limit: number, person?: string): Promise<ActivityLine[]> {
    let raw: string;
    try {
      raw = await readFile(activityFile(this.dir), "utf8");
    } catch (err) {
      if (isMissing(err)) return [];
      throw err;
    }
    const out: ActivityLine[] = [];
    const lines = raw.split("\n");
    for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
      const text = lines[i];
      if (!text) continue;
      let v: unknown;
      try {
        v = JSON.parse(text);
      } catch {
        continue;
      }
      const line = parseActivity(v);
      if (line && (!person || line.person === person)) out.push(line);
    }
    return out;
  }

  /* ---------- the routes ---------- */

  /** `/api/people` and below, after the gate has passed the request; null
   *  for any other path. */
  async handle(req: Request, url: URL, caller: Caller | null): Promise<Response | null> {
    const path = url.pathname;
    if (path !== "/api/people" && !path.startsWith("/api/people/")) return null;
    try {
      return await this.route(req, url, caller);
    } catch (err) {
      if (err instanceof Refusal) return json({ error: err.message }, err.status);
      return json({ error: `people.json could not be written: ${errText(err)}` }, 500);
    }
  }

  private async route(req: Request, url: URL, caller: Caller | null): Promise<Response> {
    const path = url.pathname;
    const method = req.method;
    if (path === "/api/people" && method === "GET") {
      const file = this.file();
      const me = personOf(file, caller?.user);
      const invites = me && roleAllows(me.role, "admin") ? liveInvites(file, this.now()).map(({ person, created, expires, by }) => ({ person, created, expires, by })) : [];
      return json({ ...this.info(), invites });
    }
    if (path === "/api/people/activity" && method === "GET") {
      const limit = Math.min(ACTIVITY_SHOWN, Math.max(1, Math.floor(Number(url.searchParams.get("limit") ?? ACTIVITY_SHOWN)) || ACTIVITY_SHOWN));
      const person = url.searchParams.get("person") ?? undefined;
      return json({ lines: await this.activity(limit, person) });
    }
    if (method !== "POST") return json({ error: "not found" }, 404);
    const raw: unknown = await req.json().catch(() => null);
    const b = isRecord(raw) ? raw : {};
    const actor = this.personOf(caller);
    if (!actor) return json({ error: "nobody this backend knows is calling" }, 401);
    const text = (k: string): string | undefined => (typeof b[k] === "string" ? b[k] : undefined);
    const teamsOf = (v: unknown): string[] | undefined => (Array.isArray(v) && v.every((x) => typeof x === "string") ? [...new Set(v)] : undefined);
    switch (path.slice("/api/people/".length)) {
      case "at": {
        const client = text("client") ?? "";
        const repos = parsePlaces(b["repos"]);
        if (!/^[0-9a-f]{16}$/.test(client) || repos === null) return json({ error: "client is a browser's id and repos a list of repo ids" }, 400);
        // a browser that is on is placed by its own person alone; one not on
        // yet is taken at its word, and shown only once its stream says the same
        const device = this.deps.devices().find((d) => d.id === client);
        if (device && (device.person ?? OWNER_ID) !== actor.id) return json({ ok: true });
        const was = this.places.get(client);
        if (was && was.person === actor.id && was.repos.length === repos.length && was.repos.every((r, i) => r === repos[i])) return json({ ok: true });
        if (repos.length === 0) this.places.delete(client);
        else if (was || this.places.size < MOST_BROWSERS) this.places.set(client, { person: actor.id, repos, said: this.now() });
        if (device) this.publish();
        return json({ ok: true });
      }
      case "me": {
        const name = text("name") === undefined ? undefined : cleanName(text("name") ?? "");
        const color = b["color"] === null ? null : typeof b["color"] === "number" ? b["color"] : undefined;
        const person = await this.change((file) => {
          const me = personOf(file, actor.id);
          if (!me) throw new Refusal(401, "nobody this backend knows is calling");
          refuse(meRefusal(file, me, { ...(name !== undefined ? { name } : {}), ...(color !== undefined ? { color } : {}) }), 400);
          return applyChange(file, me.id, { ...(name !== undefined ? { name } : {}), ...(color !== undefined ? { color } : {}) });
        });
        return json({ person });
      }
      case "add": {
        const name = cleanName(text("name") ?? "");
        const role = b["role"] === undefined ? "member" : b["role"];
        if (!isRole(role)) return json({ error: "role is owner, admin, member or viewer" }, 400);
        const teams = b["teams"] === undefined ? [] : teamsOf(b["teams"]);
        if (!teams) return json({ error: "teams is a list of team ids" }, 400);
        const life = b["invite"] === true ? inviteLife(b["hours"]) : undefined;
        if (life === null) return json({ error: "hours is from 1 to 720" }, 400);
        const code = life !== undefined ? mintInvite() : null;
        const out = await this.change((file) => {
          const who = personOf(file, actor.id);
          if (!who) throw new Refusal(401, "nobody this backend knows is calling");
          refuse(addRefusal(file, who, { name, role, teams }));
          let id = mintPersonId();
          while (file.people.some((p) => p.id === id)) id = mintPersonId();
          const now = this.now();
          const person: Person = { id, name, role, teams, created: now };
          const invite = code !== null && life !== undefined ? { hash: sha(code), person: id, created: now, expires: now + life, by: who.id } : null;
          return {
            file: { ...file, people: [...file.people, person], invites: invite ? [...liveInvites(file, now), invite] : file.invites },
            out: { person, ...(invite && code ? { invite: { code, expires: invite.expires } } : {}) },
          };
        });
        return json(out, 201);
      }
      case "set": {
        const id = text("id") ?? "";
        const change: PersonChange = {};
        if (text("name") !== undefined) change.name = cleanName(text("name") ?? "");
        if (b["role"] !== undefined) {
          if (!isRole(b["role"])) return json({ error: "role is owner, admin, member or viewer" }, 400);
          change.role = b["role"];
        }
        if (b["teams"] !== undefined) {
          const teams = teamsOf(b["teams"]);
          if (!teams) return json({ error: "teams is a list of team ids" }, 400);
          change.teams = teams;
        }
        if (typeof b["off"] === "boolean") change.off = b["off"];
        if (b["color"] === null || typeof b["color"] === "number") change.color = b["color"];
        const person = await this.change((file) => {
          const who = personOf(file, actor.id);
          const target = personById(file, id);
          if (!who) throw new Refusal(401, "nobody this backend knows is calling");
          if (!target) throw new Refusal(404, `no person ${id}`);
          refuse(setRefusal(file, who, target, change));
          return applyChange(file, target.id, change);
        });
        // a person turned off holds nothing from this moment
        if (change.off === true) await this.deps.dropUser(id);
        return json({ person });
      }
      case "remove": {
        const id = text("id") ?? "";
        await this.change((file) => {
          const who = personOf(file, actor.id);
          const target = personById(file, id);
          if (!who) throw new Refusal(401, "nobody this backend knows is calling");
          if (!target) throw new Refusal(404, `no person ${id}`);
          refuse(removeRefusal(who, target));
          return { file: { ...file, people: file.people.filter((p) => p.id !== id), invites: file.invites.filter((i) => i.person !== id) }, out: null };
        });
        await this.deps.dropUser(id);
        for (const [dev, place] of this.places) if (place.person === id) this.places.delete(dev);
        return json({ ok: true });
      }
      case "invite": {
        const id = text("id") ?? "";
        const life = inviteLife(b["hours"]);
        if (life === null) return json({ error: "hours is from 1 to 720" }, 400);
        const code = mintInvite();
        const expires = await this.change((file) => {
          const who = personOf(file, actor.id);
          const target = personById(file, id);
          if (!who) throw new Refusal(401, "nobody this backend knows is calling");
          if (!target) throw new Refusal(404, `no person ${id}`);
          refuse(handRefusal(who, target));
          const now = this.now();
          const live = liveInvites(file, now);
          if (live.filter((i) => i.person === id).length >= MOST_INVITES) throw new Refusal(409, `${MOST_INVITES} invites already wait for ${target.name}; drop them first`);
          const invite = { hash: sha(code), person: id, created: now, expires: now + life, by: who.id };
          return { file: { ...file, invites: [...live, invite] }, out: invite.expires };
        });
        return json({ code, expires }, 201);
      }
      case "uninvite": {
        const id = text("id") ?? "";
        const dropped = await this.change((file) => {
          const who = personOf(file, actor.id);
          const target = personById(file, id);
          if (!who) throw new Refusal(401, "nobody this backend knows is calling");
          if (!target) throw new Refusal(404, `no person ${id}`);
          // an invite of someone turned off is still an admin's to drop
          const { off: _off, ...on } = target;
          refuse(handRefusal(who, on));
          const live = liveInvites(file, this.now());
          return { file: { ...file, invites: live.filter((i) => i.person !== id) }, out: live.filter((i) => i.person === id).length };
        });
        return json({ dropped });
      }
      case "team": {
        const id = text("id");
        const name = cleanName(text("name") ?? "");
        const asked = b["folders"] === undefined ? undefined : teamsOf(b["folders"]);
        if (b["folders"] !== undefined && !asked) return json({ error: "folders is a list of absolute paths" }, 400);
        const team = await this.change((file) => {
          const old = id === undefined ? undefined : file.teams.find((t) => t.id === id);
          if (id !== undefined && !old) throw new Refusal(404, `no team ${id}`);
          const want = { name: name || (old?.name ?? ""), folders: asked ?? old?.folders ?? [] };
          refuse(teamRefusal(file, want, old?.id), 400);
          const folders = [...new Set(want.folders.map(cleanFolder).filter((f): f is string => f !== null))];
          if (old) {
            const next: Team = { ...old, name: want.name, folders };
            return { file: { ...file, teams: file.teams.map((t) => (t.id === old.id ? next : t)) }, out: next };
          }
          let fresh = mintTeamId();
          while (file.teams.some((t) => t.id === fresh)) fresh = mintTeamId();
          const next: Team = { id: fresh, name: want.name, folders, created: this.now() };
          return { file: { ...file, teams: [...file.teams, next] }, out: next };
        });
        return json({ team }, id === undefined ? 201 : 200);
      }
      case "team/remove": {
        const id = text("id") ?? "";
        await this.change((file) => {
          if (!file.teams.some((t) => t.id === id)) throw new Refusal(404, `no team ${id}`);
          return {
            file: { ...file, teams: file.teams.filter((t) => t.id !== id), people: file.people.map((p) => (p.teams.includes(id) ? { ...p, teams: p.teams.filter((t) => t !== id) } : p)) },
            out: null,
          };
        });
        return json({ ok: true });
      }
      default:
        return json({ error: "not found" }, 404);
    }
  }
}

/** a change laid over one person, the owner's name and colour included */
function applyChange(file: PeopleFile, id: string, change: PersonChange): { file: PeopleFile; out: Person } {
  if (id === OWNER_ID) {
    const owner = { ...file.owner };
    if (change.name !== undefined) owner.name = change.name;
    if (change.color === null) delete owner.color;
    else if (change.color !== undefined) owner.color = change.color;
    const next = { ...file, owner };
    return { file: next, out: ownerOf(next) };
  }
  let out: Person | undefined;
  const people = file.people.map((p) => {
    if (p.id !== id) return p;
    const next: Person = { ...p };
    if (change.name !== undefined) next.name = change.name;
    if (change.role !== undefined) next.role = change.role;
    if (change.teams !== undefined) next.teams = [...change.teams];
    if (change.color === null) delete next.color;
    else if (change.color !== undefined) next.color = change.color;
    if (change.off === true) next.off = true;
    else if (change.off === false) delete next.off;
    out = next;
    return next;
  });
  if (!out) throw new Refusal(404, `no person ${id}`);
  return { file: { ...file, people }, out };
}
