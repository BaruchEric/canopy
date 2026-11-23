/**
 * People over HTTP (FR-074): a role caps what a caller's kind holds, an
 * invite is traded for a session, a pair is approved as a person, and a
 * write leaves a line of who did what. A real server on a scratch root,
 * its people.json and tokens written before it starts. Plain ptys
 * (`CANOPY_TMUX=0`), so nothing here touches a tmux server.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PeopleFile } from "../core/people";
import { CallerBook } from "./callers";
import { startServer } from "./index";

type Up = { port: number; stop: () => void | Promise<void> };

let scratch = "";
const saved: Record<string, string | undefined> = {};
const ENV = ["CANOPY_CONFIG_DIR", "CANOPY_TMUX", "CANOPY_BIND", "CANOPY_PUBLIC_ORIGIN", "CANOPY_ORIGINS", "CANOPY_CALLERS", "CANOPY_COORD_SOCKET", "CANOPY_COORD_API", "CANOPY_COORD_ROOT"];

const EMMA = "p-emmaemma";
const AVERY = "p-averyave";
const GUEST = "p-guestgue";
const GONE = "p-gonegone";

const roster: PeopleFile = {
  owner: { name: "Eric" },
  people: [
    { id: EMMA, name: "Emma", role: "admin", teams: [], created: 1 },
    { id: AVERY, name: "Avery", role: "member", teams: [], created: 1 },
    { id: GUEST, name: "Guest", role: "viewer", teams: [], created: 1 },
  ],
  teams: [],
  invites: [],
};

let s: Up;
const tokens = { owner: "", emma: "", avery: "", averyCli: "", guest: "", gone: "" };

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "canopy-people-route-"));
  for (const k of ENV) saved[k] = process.env[k];
  process.env["CANOPY_TMUX"] = "0";
  for (const k of ["CANOPY_BIND", "CANOPY_PUBLIC_ORIGIN", "CANOPY_ORIGINS", "CANOPY_COORD_SOCKET", "CANOPY_COORD_API", "CANOPY_COORD_ROOT"]) delete process.env[k];
  const repo = join(scratch, "root", "app");
  await Bun.$`mkdir -p ${repo} && git -C ${repo} init -q`.quiet();
  const config = join(scratch, "config");
  await mkdir(config, { recursive: true });
  await writeFile(join(config, "people.json"), JSON.stringify(roster));
  process.env["CANOPY_CONFIG_DIR"] = config;
  process.env["CANOPY_CALLERS"] = "enforce";
  const book = new CallerBook({ file: join(config, "callers.json") });
  tokens.owner = book.mint("page", { label: "the owner's page" }).token;
  tokens.emma = book.mint("page", { label: "Emma's page", user: EMMA }).token;
  tokens.avery = book.mint("page", { label: "Avery's page", user: AVERY }).token;
  tokens.averyCli = book.mint("cli", { label: "Avery's CLI", user: AVERY }).token;
  tokens.guest = book.mint("page", { label: "Guest's page", user: GUEST }).token;
  tokens.gone = book.mint("page", { label: "a page of nobody", user: GONE }).token;
  await book.flush();
  s = await startServer({ root: join(scratch, "root"), port: 0, callersLog: () => {} });
});

afterAll(async () => {
  await s.stop();
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  await rm(scratch, { recursive: true, force: true });
});

const get = (path: string, token?: string): Promise<Response> => fetch(`http://127.0.0.1:${s.port}${path}`, { headers: token ? { "x-canopy-token": token } : {} });

const post = (path: string, body: unknown, token?: string): Promise<Response> =>
  fetch(`http://127.0.0.1:${s.port}${path}`, { method: "POST", headers: { "content-type": "application/json", ...(token ? { "x-canopy-token": token } : {}) }, body: JSON.stringify(body) });

/** a JSON answer as a record, whatever its status */
async function body(res: Response): Promise<Record<string, unknown>> {
  const v: unknown = await res.json();
  if (typeof v !== "object" || v === null || Array.isArray(v)) throw new Error("the answer is not an object");
  return { ...v };
}

const field = (v: unknown, key: string): unknown => (typeof v === "object" && v !== null ? Reflect.get(v, key) : undefined);
const text = (v: unknown): string => {
  if (typeof v !== "string") throw new Error(`expected a string, got ${JSON.stringify(v)}`);
  return v;
};
const list = (v: unknown): unknown[] => {
  if (!Array.isArray(v)) throw new Error(`expected a list, got ${JSON.stringify(v)}`);
  return v;
};

describe("a role caps what a caller holds", () => {
  test("/api/auth says who the caller is and what they hold", async () => {
    const owner = await body(await get("/api/auth", tokens.owner));
    expect(owner["person"]).toEqual({ id: "owner", name: "Eric", role: "owner" });
    expect(owner["rights"]).toEqual(["read", "plan", "operate", "shell", "admin"]);
    const avery = await body(await get("/api/auth", tokens.avery));
    expect(avery["person"]).toEqual({ id: AVERY, name: "Avery", role: "member" });
    expect(avery["rights"]).toEqual(["read", "plan", "operate", "shell"]);
    // a member is not told the callers, the pairs or what was refused
    expect(avery["callers"]).toEqual([]);
    const guest = await body(await get("/api/auth", tokens.guest));
    expect(guest["rights"]).toEqual(["read"]);
    const bare = await body(await get("/api/auth"));
    expect(bare["person"]).toBeNull();
    expect(bare["rights"]).toEqual([]);
  });

  test("a member operates and is refused admin by their role", async () => {
    const note = await post("/api/notes", { text: "from Avery" }, tokens.avery);
    expect([401, 403]).not.toContain(note.status);
    const refused = await post("/api/people/add", { name: "Friend" }, tokens.avery);
    expect(refused.status).toBe(403);
    const why = await body(refused);
    expect(why["need"]).toBe("admin");
    expect(text(why["error"])).toContain("your role");
    expect((await post("/api/auth/revoke", { id: "nobody" }, tokens.avery)).status).toBe(403);
  });

  test("a viewer reads the tree and nothing out of a repo, and writes nothing", async () => {
    expect((await get("/api/tree", tokens.guest)).status).toBe(200);
    expect((await get("/api/people", tokens.guest)).status).toBe(200);
    const diff = await get("/api/repos/diff?id=app", tokens.guest);
    expect(diff.status).toBe(403);
    expect(text((await body(diff))["error"])).toContain("your role");
    expect((await post("/api/notes", { text: "no" }, tokens.guest)).status).toBe(403);
    expect((await post("/api/repos/run?id=app", {}, tokens.guest)).status).toBe(403);
    // their own name is theirs to change
    expect((await post("/api/people/me", { color: 90 }, tokens.guest)).status).toBe(200);
  });

  test("a CLI token of a member holds the CLI's rights and no more", async () => {
    const auth = await body(await get("/api/auth", tokens.averyCli));
    expect(auth["rights"]).toEqual(["read", "plan", "operate"]);
  });

  test("a token whose person is not on the roster is nobody's", async () => {
    expect((await get("/api/tree", tokens.gone)).status).toBe(401);
    expect((await body(await get("/api/auth", tokens.gone)))["person"]).toBeNull();
  });

  test("an admin manages people, and never an owner", async () => {
    const added = await post("/api/people/add", { name: "Temp", role: "viewer" }, tokens.emma);
    expect(added.status).toBe(201);
    const id = text(field((await body(added))["person"], "id"));
    expect((await post("/api/people/set", { id: "owner", name: "Mine" }, tokens.emma)).status).toBe(403);
    expect((await post("/api/people/remove", { id }, tokens.emma)).status).toBe(200);
  });
});

describe("an invite", () => {
  test("is traded once for a session of its person, and a wrong code for nothing", async () => {
    const made = await post("/api/people/invite", { id: AVERY }, tokens.owner);
    expect(made.status).toBe(201);
    const code = text((await body(made))["code"]);
    expect((await post("/api/auth/join", { code: "cnv_aaaaaaaaaaaaaaaaaaaaaaaa", label: "a guess" })).status).toBe(403);
    expect((await post("/api/auth/join", { code: "not a code", label: "a guess" })).status).toBe(403);
    expect((await post("/api/auth/join", { code })).status).toBe(400);
    const joined = await post("/api/auth/join", { code, label: "Avery's phone", kind: "page" });
    expect(joined.status).toBe(200);
    const got = await body(joined);
    expect(got["person"]).toBe("Avery");
    const token = text(got["token"]);
    expect(token).toStartWith("cnp_page_");
    expect((await body(await get("/api/auth", token)))["person"]).toEqual({ id: AVERY, name: "Avery", role: "member" });
    expect((await post("/api/auth/join", { code, label: "again" })).status).toBe(403);

    // signing out ends that session and no other
    expect((await post("/api/auth/signout", {}, token)).status).toBe(200);
    expect((await get("/api/tree", token)).status).toBe(401);
    expect((await get("/api/tree", tokens.avery)).status).toBe(200);
    expect((await post("/api/auth/signout", {})).status).toBe(401);
  });

  test("takes the asker's own waiting pair with it, and nobody else's", async () => {
    const waitingIds = async (): Promise<unknown[]> => list((await body(await get("/api/auth", tokens.owner)))["pending"]).map((p) => field(p, "id"));
    const mine = await body(await post("/api/auth/pair", { label: "Avery's tablet" }));
    const other = await body(await post("/api/auth/pair", { label: "someone else" }));
    expect(await waitingIds()).toEqual(expect.arrayContaining([mine["id"], other["id"]]));
    // a wrong secret withdraws nothing, though the invite is still taken
    const first = text((await body(await post("/api/people/invite", { id: AVERY }, tokens.owner)))["code"]);
    expect((await post("/api/auth/join", { code: first, label: "Avery's tablet", id: text(other["id"]), secret: "a guess" })).status).toBe(200);
    expect(await waitingIds()).toEqual(expect.arrayContaining([mine["id"], other["id"]]));
    const second = text((await body(await post("/api/people/invite", { id: AVERY }, tokens.owner)))["code"]);
    expect((await post("/api/auth/join", { code: second, label: "Avery's tablet", id: text(mine["id"]), secret: text(mine["secret"]) })).status).toBe(200);
    const left = await waitingIds();
    expect(left).not.toContain(mine["id"]);
    expect(left).toContain(other["id"]);
    expect((await post("/api/auth/deny", { id: text(other["id"]) }, tokens.owner)).status).toBe(200);
  });

  test("the CLI joins with its own kind, and a join asks for no other", async () => {
    const code = text((await body(await post("/api/people/invite", { id: GUEST }, tokens.emma)))["code"]);
    expect((await post("/api/auth/join", { code, label: "x", kind: "shell" })).status).toBe(400);
    const joined = await body(await post("/api/auth/join", { code, label: "Guest's laptop", kind: "cli" }));
    expect(text(joined["token"])).toStartWith("cnp_cli_");
  });
});

describe("a pair approved as a person", () => {
  test("claims a session of that person, and an admin approves no owner", async () => {
    const pair = await body(await post("/api/auth/pair", { label: "Guest's tablet" }));
    const id = text(pair["id"]);
    const asOwner = await post("/api/auth/approve", { id, person: "owner" }, tokens.emma);
    expect(asOwner.status).toBe(403);
    expect((await post("/api/auth/approve", { id, person: "p-nobodyno" }, tokens.emma)).status).toBe(403);
    expect((await post("/api/auth/approve", { id, person: GUEST }, tokens.emma)).status).toBe(200);
    const claimed = await body(await post("/api/auth/claim", { id, secret: text(pair["secret"]) }));
    const token = text(claimed["token"]);
    expect((await body(await get("/api/auth", token)))["person"]).toEqual({ id: GUEST, name: "Guest", role: "viewer" });
  });

  test("with no person named is the approver's own", async () => {
    const pair = await body(await post("/api/auth/pair", { label: "Emma's phone" }));
    expect((await post("/api/auth/approve", { id: text(pair["id"]) }, tokens.emma)).status).toBe(200);
    const claimed = await body(await post("/api/auth/claim", { id: text(pair["id"]), secret: text(pair["secret"]) }));
    expect(field((await body(await get("/api/auth", text(claimed["token"]))))["person"], "id")).toBe(EMMA);
  });
});

describe("who did what", () => {
  test("a write leaves a line with its person, and a refused one leaves none", async () => {
    const made = await body(await post("/api/people/team", { name: "Logged" }, tokens.emma));
    expect((await post("/api/people/team", { name: "Refused" }, tokens.guest)).status).toBe(403);
    await Bun.sleep(50);
    const lines = list((await body(await get(`/api/people/activity?person=${EMMA}`, tokens.guest)))["lines"]);
    expect(lines.length).toBeGreaterThan(0);
    expect(field(lines[0], "person")).toBe(EMMA);
    expect(field(lines[0], "kind")).toBe("page");
    expect(field(lines[0], "what")).toBe("changed a team");
    expect(list((await body(await get(`/api/people/activity?person=${GUEST}`, tokens.owner)))["lines"]).every((l) => field(l, "what") !== "changed a team")).toBe(true);
    await post("/api/people/team/remove", { id: text(field(made["team"], "id")) }, tokens.emma);
  });
});

describe("a person turned off", () => {
  test("loses every session at once, and gets them back by a new sign-in alone", async () => {
    expect((await get("/api/tree", tokens.avery)).status).toBe(200);
    expect((await post("/api/people/set", { id: AVERY, off: true }, tokens.owner)).status).toBe(200);
    expect((await get("/api/tree", tokens.avery)).status).toBe(401);
    expect((await get("/api/tree", tokens.averyCli)).status).toBe(401);
    expect((await post("/api/people/invite", { id: AVERY }, tokens.owner)).status).toBe(403);
    expect((await post("/api/people/set", { id: AVERY, off: false }, tokens.owner)).status).toBe(200);
    // the old tokens were dropped, not paused
    expect((await get("/api/tree", tokens.avery)).status).toBe(401);
  });
});
