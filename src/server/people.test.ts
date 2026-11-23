import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parsePeople, type PeopleFile, type PeopleInfo } from "../core/people";
import type { Device, ServerEvent } from "../core/types";
import type { Caller } from "./callers";
import { activityFile, peopleFile, PeopleHub } from "./people";

let dir = "";
let clock = 1_000_000;
let devices: Device[] = [];
let events: ServerEvent[] = [];
let dropped: string[] = [];

const hubOf = (): PeopleHub =>
  new PeopleHub({
    dir,
    now: () => clock,
    devices: () => devices,
    broadcast: (ev) => events.push(ev),
    dropUser: async (id) => {
      dropped.push(id);
    },
  });

const caller = (user?: string, kind: Caller["kind"] = "page"): Caller => ({ id: `c-${user ?? "owner"}`, kind, label: "test", created: 1, used: 1, ...(user ? { user } : {}) });
const owner = caller();

const device = (id: string, person?: string): Device => ({ id, name: `browser ${id.slice(0, 2)}`, platform: "mac", address: "127.0.0.1", since: 1, streams: 1, ...(person ? { person } : {}) });

async function call(hub: PeopleHub, who: Caller | null, method: string, path: string, body?: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const url = new URL(`http://canopy.test${path}`);
  const req = new Request(url.href, { method, ...(body !== undefined ? { body: JSON.stringify(body), headers: { "content-type": "application/json" } } : {}) });
  const res = await hub.handle(req, url, who);
  if (!res) throw new Error(`${path} is not a people route`);
  const parsed: unknown = await res.json();
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error(`${path} did not answer an object`);
  return { status: res.status, body: { ...parsed } };
}

const str = (v: unknown): string => {
  if (typeof v !== "string") throw new Error(`expected a string, got ${typeof v}`);
  return v;
};
const idOf = (v: unknown): string => {
  if (typeof v !== "object" || v === null || !("id" in v)) throw new Error("no id");
  return str(v.id);
};
const codeOf = (v: unknown): string => {
  if (typeof v !== "object" || v === null || !("code" in v)) throw new Error("no code");
  return str(v.code);
};

const onDisk = async (): Promise<PeopleFile> => parsePeople(JSON.parse(await readFile(peopleFile(dir), "utf8")));

const lastPeople = (): PeopleInfo => {
  const ev = events.findLast((e) => e.type === "people");
  if (!ev || ev.type !== "people") throw new Error("no people event");
  return ev;
};

/** a member named `name`, added by the owner */
async function add(hub: PeopleHub, name: string, role = "member", extra: Record<string, unknown> = {}): Promise<string> {
  const res = await call(hub, owner, "POST", "/api/people/add", { name, role, ...extra });
  expect(res.status).toBe(201);
  return idOf(res.body["person"]);
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "canopy-people-"));
  clock = 1_000_000;
  devices = [];
  events = [];
  dropped = [];
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("the roster", () => {
  test("a backend with no file has its owner and nobody else", async () => {
    const hub = hubOf();
    expect(hub.roleOf(owner)).toBe("owner");
    const res = await call(hub, owner, "GET", "/api/people");
    expect(res.status).toBe(200);
    expect(res.body["people"]).toHaveLength(1);
    expect(res.body["teams"]).toEqual([]);
    expect(hub.me(null, "log")?.role).toBe("owner");
    // under enforce, nobody is calling when no token came
    expect(hub.me(null, "enforce")).toBeNull();
  });

  test("an added person is kept in a file only its owner reads", async () => {
    const hub = hubOf();
    const id = await add(hub, "  Avery  ");
    const file = await onDisk();
    expect(file.people).toHaveLength(1);
    expect(file.people[0]?.name).toBe("Avery");
    expect(file.people[0]?.role).toBe("member");
    expect((await stat(peopleFile(dir))).mode & 0o777).toBe(0o600);
    expect(hub.roleOf(caller(id))).toBe("member");
    expect(lastPeople().people.map((p) => p.name)).toEqual(["owner", "Avery"]);
  });

  test("two people never share a name, and a name is needed", async () => {
    const hub = hubOf();
    await add(hub, "Avery");
    expect((await call(hub, owner, "POST", "/api/people/add", { name: "avery" })).status).toBe(403);
    expect((await call(hub, owner, "POST", "/api/people/add", { name: "   " })).status).toBe(403);
    expect((await call(hub, owner, "POST", "/api/people/add", { name: "Emma", role: "boss" })).status).toBe(400);
  });

  test("an admin adds members and never an owner, and changes no owner", async () => {
    const hub = hubOf();
    const emma = await add(hub, "Emma", "admin");
    const admin = caller(emma);
    expect((await call(hub, admin, "POST", "/api/people/add", { name: "Avery" })).status).toBe(201);
    expect((await call(hub, admin, "POST", "/api/people/add", { name: "Boss", role: "owner" })).status).toBe(403);
    expect((await call(hub, admin, "POST", "/api/people/set", { id: "owner", name: "Mine" })).status).toBe(403);
    expect((await call(hub, admin, "POST", "/api/people/set", { id: emma, role: "owner" })).status).toBe(403);
  });

  test("a role change, a rename and a colour land on the person", async () => {
    const hub = hubOf();
    const id = await add(hub, "Avery");
    const res = await call(hub, owner, "POST", "/api/people/set", { id, role: "viewer", name: "Ari", color: 120 });
    expect(res.status).toBe(200);
    expect(hub.roleOf(caller(id))).toBe("viewer");
    const kept = (await onDisk()).people[0];
    expect(kept?.name).toBe("Ari");
    expect(kept?.color).toBe(120);
    expect((await call(hub, owner, "POST", "/api/people/set", { id: "p-zzzzzzzz", role: "viewer" })).status).toBe(404);
  });

  test("a person turned off holds no role and loses every token", async () => {
    const hub = hubOf();
    const id = await add(hub, "Avery");
    expect((await call(hub, owner, "POST", "/api/people/set", { id, off: true })).status).toBe(200);
    expect(hub.roleOf(caller(id))).toBeNull();
    expect(dropped).toEqual([id]);
    expect((await call(hub, owner, "POST", "/api/people/set", { id, off: false })).status).toBe(200);
    expect(hub.roleOf(caller(id))).toBe("member");
    expect((await onDisk()).people[0]?.off).toBeUndefined();
  });

  test("a removed person is gone with their invites and their tokens", async () => {
    const hub = hubOf();
    const id = await add(hub, "Avery", "member", { invite: true });
    expect((await onDisk()).invites).toHaveLength(1);
    expect((await call(hub, owner, "POST", "/api/people/remove", { id })).status).toBe(200);
    const file = await onDisk();
    expect(file.people).toEqual([]);
    expect(file.invites).toEqual([]);
    expect(dropped).toEqual([id]);
    expect(hub.roleOf(caller(id))).toBeNull();
    expect((await call(hub, owner, "POST", "/api/people/remove", { id: "owner" })).status).toBe(403);
  });

  test("anyone renames themselves, the owner too, and nobody else", async () => {
    const hub = hubOf();
    const id = await add(hub, "Avery", "viewer");
    expect((await call(hub, caller(id), "POST", "/api/people/me", { name: "Ari", color: 40 })).status).toBe(200);
    expect((await call(hub, owner, "POST", "/api/people/me", { name: "Eric" })).status).toBe(200);
    const file = await onDisk();
    expect(file.owner.name).toBe("Eric");
    expect(file.people[0]?.name).toBe("Ari");
    expect((await call(hub, caller(id), "POST", "/api/people/me", { name: "eric" })).status).toBe(400);
    // a caller whose person is gone is nobody
    expect((await call(hub, caller("p-zzzzzzzz"), "POST", "/api/people/me", { name: "Ghost" })).status).toBe(401);
  });
});

describe("invites", () => {
  test("the file keeps a hash, and the code is spent once", async () => {
    const hub = hubOf();
    const id = await add(hub, "Avery");
    const res = await call(hub, owner, "POST", "/api/people/invite", { id });
    expect(res.status).toBe(201);
    const code = str(res.body["code"]);
    expect(code.startsWith("cnv_")).toBe(true);
    const raw = await readFile(peopleFile(dir), "utf8");
    expect(raw.includes(code)).toBe(false);
    expect(await hub.redeem(code)).toEqual({ person: id, name: "Avery" });
    expect(await hub.redeem(code)).toBeNull();
    expect((await onDisk()).invites).toEqual([]);
  });

  test("two claims of one code cannot both win", async () => {
    const hub = hubOf();
    const id = await add(hub, "Avery");
    const code = str((await call(hub, owner, "POST", "/api/people/invite", { id })).body["code"]);
    const got = await Promise.all([hub.redeem(code), hub.redeem(code)]);
    expect(got.filter((g) => g !== null)).toHaveLength(1);
  });

  test("an invite ends at its hour, and a wrong code is nothing", async () => {
    const hub = hubOf();
    const id = await add(hub, "Avery");
    const code = str((await call(hub, owner, "POST", "/api/people/invite", { id, hours: 1 })).body["code"]);
    expect(await hub.redeem("cnv_aaaaaaaaaaaaaaaaaaaaaaaa")).toBeNull();
    clock += 3_600_001;
    expect(await hub.redeem(code)).toBeNull();
    expect((await call(hub, owner, "POST", "/api/people/invite", { id, hours: 0 })).status).toBe(400);
  });

  test("an invite of someone turned off is not spent", async () => {
    const hub = hubOf();
    const id = await add(hub, "Avery");
    const code = str((await call(hub, owner, "POST", "/api/people/invite", { id })).body["code"]);
    await call(hub, owner, "POST", "/api/people/set", { id, off: true });
    expect(await hub.redeem(code)).toBeNull();
  });

  test("a person holds five waiting invites at most, and dropping them frees the count", async () => {
    const hub = hubOf();
    const id = await add(hub, "Avery");
    for (let i = 0; i < 5; i++) expect((await call(hub, owner, "POST", "/api/people/invite", { id })).status).toBe(201);
    expect((await call(hub, owner, "POST", "/api/people/invite", { id })).status).toBe(409);
    expect((await call(hub, owner, "GET", "/api/people")).body["invites"]).toHaveLength(5);
    expect((await call(hub, owner, "POST", "/api/people/uninvite", { id })).body["dropped"]).toBe(5);
    expect((await call(hub, owner, "POST", "/api/people/invite", { id })).status).toBe(201);
  });

  test("add with an invite answers the code once, and a member's list shows no invites", async () => {
    const hub = hubOf();
    const res = await call(hub, owner, "POST", "/api/people/add", { name: "Avery", invite: true, hours: 2 });
    expect(res.status).toBe(201);
    const code = codeOf(res.body["invite"]);
    const id = idOf(res.body["person"]);
    expect((await call(hub, caller(id), "GET", "/api/people")).body["invites"]).toEqual([]);
    expect(await hub.redeem(code)).toEqual({ person: id, name: "Avery" });
  });

  test("an admin hands no sign-in to an owner", async () => {
    const hub = hubOf();
    const emma = await add(hub, "Emma", "admin");
    expect(hub.handRefusal(caller(emma), "owner")).not.toBeNull();
    expect(hub.handRefusal(caller(emma), emma)).toBeNull();
    expect(hub.handRefusal(owner, "p-zzzzzzzz")).not.toBeNull();
    expect((await call(hub, caller(emma), "POST", "/api/people/invite", { id: "owner" })).status).toBe(403);
  });
});

describe("teams", () => {
  test("a team is made, renamed, given folders and put on a person", async () => {
    const hub = hubOf();
    const made = await call(hub, owner, "POST", "/api/people/team", { name: "Rio", folders: ["/srv/rio/", "/srv/rio"] });
    expect(made.status).toBe(201);
    const team = idOf(made.body["team"]);
    expect((await onDisk()).teams[0]?.folders).toEqual(["/srv/rio"]);
    expect((await call(hub, owner, "POST", "/api/people/team", { name: "rio" })).status).toBe(400);
    expect((await call(hub, owner, "POST", "/api/people/team", { name: "Bad", folders: ["relative/path"] })).status).toBe(400);
    expect((await call(hub, owner, "POST", "/api/people/team", { id: team, name: "Rio Laundromat" })).status).toBe(200);
    const kept = (await onDisk()).teams[0];
    expect(kept?.name).toBe("Rio Laundromat");
    expect(kept?.folders).toEqual(["/srv/rio"]);
    const id = await add(hub, "Avery", "member", { teams: [team] });
    expect((await onDisk()).people[0]?.teams).toEqual([team]);
    expect((await call(hub, owner, "POST", "/api/people/set", { id, teams: ["t-zzzzzzzz"] })).status).toBe(403);
  });

  test("a removed team leaves its people", async () => {
    const hub = hubOf();
    const team = idOf((await call(hub, owner, "POST", "/api/people/team", { name: "Rio" })).body["team"]);
    await add(hub, "Avery", "member", { teams: [team] });
    expect((await call(hub, owner, "POST", "/api/people/team/remove", { id: team })).status).toBe(200);
    const file = await onDisk();
    expect(file.teams).toEqual([]);
    expect(file.people[0]?.teams).toEqual([]);
    expect((await call(hub, owner, "POST", "/api/people/team/remove", { id: team })).status).toBe(404);
  });
});

describe("who is here", () => {
  test("a person's browsers and the repos they have open ride the people event", async () => {
    const hub = hubOf();
    const id = await add(hub, "Avery");
    devices = [device("aaaaaaaaaaaaaaaa"), device("bbbbbbbbbbbbbbbb", id)];
    hub.sawDevices();
    expect(lastPeople().people.map((p) => p.devices.length)).toEqual([1, 1]);
    expect((await call(hub, caller(id), "POST", "/api/people/at", { client: "bbbbbbbbbbbbbbbb", repos: ["rio", "clms"] })).status).toBe(200);
    expect(lastPeople().people[1]?.at).toEqual(["rio", "clms"]);
    // another person's browser is not theirs to place
    const before = events.length;
    await call(hub, caller(id), "POST", "/api/people/at", { client: "aaaaaaaaaaaaaaaa", repos: ["secret"] });
    expect(events.length).toBe(before);
    expect((await call(hub, caller(id), "POST", "/api/people/at", { client: "nope", repos: [] })).status).toBe(400);
  });

  test("the same place said twice tells nobody, and a closed browser forgets its place", async () => {
    const hub = hubOf();
    devices = [device("aaaaaaaaaaaaaaaa")];
    await call(hub, owner, "POST", "/api/people/at", { client: "aaaaaaaaaaaaaaaa", repos: ["rio"] });
    const before = events.length;
    await call(hub, owner, "POST", "/api/people/at", { client: "aaaaaaaaaaaaaaaa", repos: ["rio"] });
    expect(events.length).toBe(before);
    devices = [];
    clock += 30_001;
    hub.sawDevices();
    expect(lastPeople().people[0]?.at).toEqual([]);
    devices = [device("aaaaaaaaaaaaaaaa")];
    hub.sawDevices();
    expect(lastPeople().people[0]?.at).toEqual([]);
  });

  test("a place said a moment before the browser's stream opens shows once it does", async () => {
    const hub = hubOf();
    const id = await add(hub, "Avery");
    await call(hub, caller(id), "POST", "/api/people/at", { client: "bbbbbbbbbbbbbbbb", repos: ["rio"] });
    devices = [device("bbbbbbbbbbbbbbbb", id)];
    hub.sawDevices();
    expect(lastPeople().people[1]?.at).toEqual(["rio"]);
    // said for a browser that turns out to be another person's: never shown
    await call(hub, caller(id), "POST", "/api/people/at", { client: "cccccccccccccccc", repos: ["secret"] });
    devices = [device("bbbbbbbbbbbbbbbb", id), device("cccccccccccccccc")];
    hub.sawDevices();
    expect(lastPeople().people[0]?.at).toEqual([]);
  });
});

describe("who did what", () => {
  test("lines come back newest first, one person's when asked", async () => {
    const hub = hubOf();
    const id = await add(hub, "Avery");
    hub.note({ person: "owner", kind: "page" }, "started a run", "rio");
    clock += 10;
    hub.note({ person: id, kind: "cli" }, "opened a shell", "clms");
    clock += 10;
    hub.note({ person: "owner", kind: "none" }, "committed");
    await hub.flush();
    const all = await hub.activity(200);
    expect(all.map((l) => l.what)).toEqual(["committed", "opened a shell", "started a run"]);
    expect(all[1]).toEqual({ at: 1_000_010, person: id, kind: "cli", what: "opened a shell", repo: "clms" });
    expect((await hub.activity(200, id)).map((l) => l.what)).toEqual(["opened a shell"]);
    expect(await hub.activity(1)).toHaveLength(1);
    expect((await stat(activityFile(dir))).mode & 0o777).toBe(0o600);
    const res = await call(hub, owner, "GET", `/api/people/activity?limit=2&person=${id}`);
    expect(res.body["lines"]).toHaveLength(1);
  });

  test("no log yet is no lines, and a broken line is skipped", async () => {
    const hub = hubOf();
    expect(await hub.activity(10)).toEqual([]);
    await writeFile(activityFile(dir), `not json\n${JSON.stringify({ at: 5, person: "owner", kind: "page", what: "pushed" })}\n{"at":"x"}\n`);
    expect((await hub.activity(10)).map((l) => l.what)).toEqual(["pushed"]);
  });
});

describe("the file under another writer", () => {
  test("a change made by another process is followed within the look", async () => {
    const hub = hubOf();
    const id = await add(hub, "Avery");
    const file = await onDisk();
    await writeFile(peopleFile(dir), JSON.stringify({ ...file, people: file.people.map((p) => ({ ...p, role: "viewer" })) }));
    await utimes(peopleFile(dir), new Date(), new Date(Date.now() + 5_000));
    // not looked at again inside the two seconds
    expect(hub.roleOf(caller(id))).toBe("member");
    clock += 2_001;
    expect(hub.roleOf(caller(id))).toBe("viewer");
  });

  test("a file that cannot be read keeps the roster last read", async () => {
    const hub = hubOf();
    const id = await add(hub, "Avery");
    await writeFile(peopleFile(dir), "{ not json");
    await utimes(peopleFile(dir), new Date(), new Date(Date.now() + 5_000));
    clock += 2_001;
    expect(hub.roleOf(caller(id))).toBe("member");
  });

  test("a write starts from what is on disk, not from memory", async () => {
    const a = hubOf();
    const b = hubOf();
    await add(a, "Avery");
    await add(b, "Emma");
    expect((await onDisk()).people.map((p) => p.name)).toEqual(["Avery", "Emma"]);
  });

  test("anything that is not a people route is left to the others", async () => {
    const hub = hubOf();
    const url = new URL("http://canopy.test/api/peoplex");
    expect(await hub.handle(new Request(url.href), url, owner)).toBeNull();
    expect((await call(hub, owner, "POST", "/api/people/nothing", {})).status).toBe(404);
    expect((await call(hub, owner, "DELETE", "/api/people")).status).toBe(404);
  });
});
