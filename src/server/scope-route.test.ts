/**
 * The wall a team's folders make, over HTTP (FR-074, plan 2): a member and
 * a viewer on a team with folders reach only those folders' repos, by read,
 * by write and on the event stream; an owner, an admin and a member on no
 * team reach everything. A real server on a scratch root with three repos,
 * two of them in the team's folder. Plain ptys (`CANOPY_TMUX=0`).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PeopleFile } from "../core/people";
import { CallerBook } from "./callers";
import { startServer } from "./index";

type Up = { port: number; stop: () => void | Promise<void> };

let scratch = "";
let root = "";
const saved: Record<string, string | undefined> = {};
const ENV = ["CANOPY_CONFIG_DIR", "CANOPY_TMUX", "CANOPY_BIND", "CANOPY_PUBLIC_ORIGIN", "CANOPY_ORIGINS", "CANOPY_CALLERS", "CANOPY_COORD_SOCKET", "CANOPY_COORD_API", "CANOPY_COORD_ROOT"];

const EMMA = "p-emmaemma";
const AVERY = "p-averyave";
const GUEST = "p-guestgue";
const ROBIN = "p-robinrob";
const RIO = "t-rioriori";
const LAB = "t-lablabla";

let s: Up;
const tokens = { owner: "", emma: "", avery: "", averyCli: "", guest: "", robin: "" };
const ids = { app: "", site: "", tool: "" };

beforeAll(async () => {
  // the folders as canopy will name them: a Mac's temp dir is a link
  scratch = realpathSync(await mkdtemp(join(tmpdir(), "canopy-scope-route-")));
  root = join(scratch, "root");
  for (const k of ENV) saved[k] = process.env[k];
  process.env["CANOPY_TMUX"] = "0";
  for (const k of ["CANOPY_BIND", "CANOPY_PUBLIC_ORIGIN", "CANOPY_ORIGINS", "CANOPY_COORD_SOCKET", "CANOPY_COORD_API", "CANOPY_COORD_ROOT"]) delete process.env[k];
  for (const name of ["rio/app", "rio/site", "lab/tool"]) {
    const repo = join(root, name);
    await Bun.$`mkdir -p ${repo} && git -C ${repo} init -q`.quiet();
  }
  const roster: PeopleFile = {
    owner: { name: "Eric" },
    people: [
      { id: EMMA, name: "Emma", role: "admin", teams: [RIO], created: 1 },
      { id: AVERY, name: "Avery", role: "member", teams: [RIO], created: 1 },
      { id: GUEST, name: "Guest", role: "viewer", teams: [RIO], created: 1 },
      { id: ROBIN, name: "Robin", role: "member", teams: [], created: 1 },
    ],
    teams: [
      { id: RIO, name: "Rio", folders: [join(root, "rio")], created: 1 },
      { id: LAB, name: "Lab", folders: [join(root, "lab")], created: 1 },
    ],
    invites: [],
  };
  const config = join(scratch, "config");
  await mkdir(config, { recursive: true });
  await writeFile(join(config, "people.json"), JSON.stringify(roster));
  await writeFile(
    join(config, "activity.jsonl"),
    [
      { at: 1, person: "owner", kind: "page", what: "pushed", repo: "tool" },
      { at: 2, person: "owner", kind: "page", what: "pushed", repo: "app" },
      { at: 3, person: AVERY, kind: "page", what: "answered a prompt" },
      { at: 4, person: "owner", kind: "page", what: "added a source" },
    ]
      .map((l) => JSON.stringify(l))
      .join("\n") + "\n",
  );
  process.env["CANOPY_CONFIG_DIR"] = config;
  process.env["CANOPY_CALLERS"] = "enforce";
  const book = new CallerBook({ file: join(config, "callers.json") });
  tokens.owner = book.mint("page", { label: "the owner's page" }).token;
  tokens.emma = book.mint("page", { label: "Emma's page", user: EMMA }).token;
  tokens.avery = book.mint("page", { label: "Avery's page", user: AVERY }).token;
  tokens.averyCli = book.mint("cli", { label: "Avery's CLI", user: AVERY }).token;
  tokens.guest = book.mint("page", { label: "Guest's page", user: GUEST }).token;
  tokens.robin = book.mint("page", { label: "Robin's page", user: ROBIN }).token;
  await book.flush();
  s = await startServer({ root, port: 0, callersLog: () => {} });
  for (const r of list(field(await body(await get("/api/tree", tokens.owner)), "repos"))) {
    const name = text(field(r, "name"));
    if (name === "app" || name === "site" || name === "tool") ids[name] = text(field(r, "id"));
  }
});

afterAll(async () => {
  await s.stop();
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  await rm(scratch, { recursive: true, force: true });
});

const url = (path: string): string => `http://127.0.0.1:${s.port}${path}`;
const get = (path: string, token?: string): Promise<Response> => fetch(url(path), { headers: token ? { "x-canopy-token": token } : {} });
const post = (path: string, payload: unknown, token?: string): Promise<Response> =>
  fetch(url(path), { method: "POST", headers: { "content-type": "application/json", ...(token ? { "x-canopy-token": token } : {}) }, body: JSON.stringify(payload) });

const field = (v: unknown, key: string): unknown => (typeof v === "object" && v !== null ? Reflect.get(v, key) : undefined);
const text = (v: unknown): string => {
  if (typeof v !== "string") throw new Error(`expected a string, got ${JSON.stringify(v)}`);
  return v;
};
const list = (v: unknown): unknown[] => {
  if (!Array.isArray(v)) throw new Error(`expected a list, got ${JSON.stringify(v)}`);
  return v;
};
/** a JSON answer, whatever its status */
const body = async (res: Response): Promise<unknown> => res.json();
const names = (v: unknown): string[] =>
  list(v)
    .map((r) => text(field(r, "name")))
    .sort();

/** whether an answer is the wall's refusal, not a role's or a 404 */
async function walled(res: Response): Promise<boolean> {
  return res.status === 403 && field(await body(res), "scoped") === true;
}

describe("who is held to a team's folders", () => {
  test("/api/auth names the folders, and nothing for someone who sees it all", async () => {
    expect(field(await body(await get("/api/auth", tokens.avery)), "scope")).toEqual([join(root, "rio")]);
    expect(field(await body(await get("/api/auth", tokens.guest)), "scope")).toEqual([join(root, "rio")]);
    for (const t of [tokens.owner, tokens.emma, tokens.robin]) expect(field(await body(await get("/api/auth", t)), "scope")).toBeNull();
  });

  test("the tree is cut to the team's repos, for a page and for the CLI", async () => {
    for (const t of [tokens.avery, tokens.averyCli, tokens.guest]) {
      const tree = await body(await get("/api/tree", t));
      expect(names(field(tree, "repos"))).toEqual(["app", "site"]);
      // the one source is the root above the team's folder, counted over
      expect(list(field(tree, "sources")).map((x) => field(x, "repos"))).toEqual([2]);
    }
    // an admin on the same team, and a member on none, see every repo
    for (const t of [tokens.owner, tokens.emma, tokens.robin]) expect(names(field(await body(await get("/api/tree", t)), "repos"))).toEqual(["app", "site", "tool"]);
  });

  test("a rescan answers the same cut", async () => {
    expect(names(field(await body(await post("/api/rescan", {}, tokens.avery)), "repos"))).toEqual(["app", "site"]);
    expect(names(field(await body(await post("/api/rescan", {}, tokens.robin)), "repos"))).toEqual(["app", "site", "tool"]);
  });
});

describe("a repo outside the folders", () => {
  test("is refused by read and by write, and one inside is not", async () => {
    expect(await walled(await get(`/api/repos/log?id=${ids.tool}`, tokens.avery))).toBe(true);
    expect(await walled(await post(`/api/repos/favorite?id=${ids.tool}`, { favorite: true }, tokens.avery))).toBe(true);
    expect(await walled(await get(`/api/repos/tasks?id=${ids.tool}`, tokens.avery))).toBe(true);
    expect((await get(`/api/repos/log?id=${ids.app}`, tokens.avery)).status).toBe(200);
    expect((await post(`/api/repos/favorite?id=${ids.app}`, { favorite: true }, tokens.avery)).status).toBe(200);
    // a member on no team reads it
    expect((await get(`/api/repos/log?id=${ids.tool}`, tokens.robin)).status).toBe(200);
  });

  test("is not reached by naming two repos, by a missing id, or by one canopy does not know", async () => {
    expect(await walled(await get(`/api/repos/log?id=${ids.app}&id=${ids.tool}`, tokens.avery))).toBe(true);
    expect(await walled(await get("/api/repos/log", tokens.avery))).toBe(true);
    expect(await walled(await get("/api/repos/log?id=nosuchrepo", tokens.avery))).toBe(true);
    expect(await walled(await post("/api/trees/clean", {}, tokens.avery))).toBe(true);
    expect(await walled(await post("/api/trees/clean", { repo: ids.tool }, tokens.avery))).toBe(true);
    expect(await walled(await post("/api/trees/clean", { repo: [ids.app] }, tokens.avery))).toBe(true);
  });

  test("a coordinator is not started through a repo's run", async () => {
    expect(await walled(await post(`/api/repos/run?id=${ids.app}`, { action: "coordinate", note: "x" }, tokens.avery))).toBe(true);
  });

  test("a shell's socket, which a browser opens with a ticket, is held too", async () => {
    const ticket = async (): Promise<string> => text(field(await body(await post("/api/auth/ticket", { for: "term" }, tokens.avery)), "ticket"));
    const term = "0123456789abcdef0123456789abcdef";
    expect(await walled(await get(`/api/term?ticket=${await ticket()}&id=${ids.tool}&term=${term}`))).toBe(true);
    // inside the folders the wall lets it by, and the socket's own checks answer
    expect(await walled(await get(`/api/term?ticket=${await ticket()}&id=${ids.app}&term=${term}`))).toBe(false);
  });

  test("a shell a panel names before its socket starts it runs no agent, and says so", async () => {
    const res = await get("/api/terms/agent?term=fedcba9876543210fedcba9876543210", tokens.avery);
    expect(res.status).toBe(200);
    expect(await body(res)).toEqual({ agent: null });
    // a shell's text by an id canopy does not hold is still refused
    expect(await walled(await get("/api/terms/text?term=fedcba9876543210fedcba9876543210", tokens.avery))).toBe(true);
  });

  test("a viewer's role still decides what they do inside", async () => {
    // inside the folders, and refused by the role, not by the wall
    const res = await post(`/api/repos/favorite?id=${ids.app}`, { favorite: false }, tokens.guest);
    expect(res.status).toBe(403);
    expect(field(await body(res), "scoped")).toBeUndefined();
  });
});

describe("a route nobody filed", () => {
  // The Library's reads are not here: they answer a request with no token
  // (its frame sends none), so no token's scope can close them.
  const closed = ["/api/landing", "/api/notes", "/api/clips", "/api/kit", "/api/health", "/api/work", "/api/sources", "/api/triggers", "/api/worktrees", "/api/prs"];

  test("is closed to a scoped member and a scoped viewer", async () => {
    for (const path of closed) {
      expect([path, await walled(await get(path, tokens.avery))]).toEqual([path, true]);
      // a viewer's role refuses some of these before the wall is asked
      expect([path, (await get(path, tokens.guest)).status]).toEqual([path, 403]);
    }
    expect(await walled(await post("/api/grep", { query: "x" }, tokens.avery))).toBe(true);
    // the roster's writes are an admin's, which the role says before the wall
    expect((await post("/api/people/add", { name: "Sam", role: "viewer" }, tokens.avery)).status).toBe(403);
  });

  test("and is not walled for a member on no team", async () => {
    for (const path of closed) expect([path, await walled(await get(path, tokens.robin))]).toEqual([path, false]);
  });

  test("what needs no token stays open", async () => {
    expect((await get("/api/about", tokens.avery)).status).toBe(200);
    expect((await get("/", tokens.avery)).status).not.toBe(403);
    expect((await post("/api/auth/ticket", { for: "events" }, tokens.avery)).status).toBe(200);
  });
});

describe("lists come back cut", () => {
  test("the board's lists hold nothing of another folder", async () => {
    for (const path of ["/api/runs", "/api/flows", "/api/fleets", "/api/jobs", "/api/terms", "/api/helpers"]) {
      const res = await get(path, tokens.avery);
      expect([path, res.status]).toEqual([path, 200]);
      expect(await body(res)).toEqual([]);
    }
    const trees = await body(await get("/api/trees", tokens.avery));
    for (const r of list(field(trees, "repos"))) expect([ids.app, ids.site]).toContain(text(field(r, "repoId")));
  });

  test("a run read by an id canopy does not hold is refused, not searched for", async () => {
    expect(await walled(await get("/api/runs/r-nosuchrun", tokens.avery))).toBe(true);
  });

  test("the roster keeps every name and only the caller's own teams", async () => {
    const mine = await body(await get("/api/people", tokens.avery));
    expect(names(field(mine, "people"))).toEqual(["Avery", "Emma", "Eric", "Guest", "Robin"]);
    expect(names(field(mine, "teams"))).toEqual(["Rio"]);
    expect(field(mine, "invites")).toEqual([]);
    expect(names(field(await body(await get("/api/people", tokens.robin)), "teams"))).toEqual(["Lab", "Rio"]);
  });

  test("who did what keeps the caller's own lines and those in their repos", async () => {
    const at = (v: unknown): unknown[] =>
      list(field(v, "lines"))
        .map((l) => field(l, "at"))
        .sort();
    expect(at(await body(await get("/api/people/activity", tokens.avery)))).toEqual([2, 3]);
    expect(at(await body(await get("/api/people/activity", tokens.guest)))).toEqual([2]);
    expect(at(await body(await get("/api/people/activity", tokens.robin)))).toEqual([1, 2, 3, 4]);
  });
});

describe("the event stream", () => {
  /** a stream's frames, read until `done` says so or the stream ends */
  async function listen(token: string | null, at = "/api/events"): Promise<{ frames: string[]; until: (done: (frames: string[]) => boolean) => Promise<boolean>; close: () => void }> {
    const cut = new AbortController();
    const res = await fetch(url(at), { headers: token ? { "x-canopy-token": token } : {}, signal: cut.signal });
    expect(res.status).toBe(200);
    const reader = res.body?.getReader();
    if (!reader) throw new Error("the stream has no body");
    const frames: string[] = [];
    const dec = new TextDecoder();
    let rest = "";
    /** true when `done` came true, false when the stream ended first */
    const until = async (done: (frames: string[]) => boolean): Promise<boolean> => {
      while (!done(frames)) {
        const { value, done: over } = await reader.read().catch(() => ({ value: undefined, done: true }));
        if (over) return done(frames);
        rest += dec.decode(value, { stream: true });
        const parts = rest.split("\n\n");
        rest = parts.pop() ?? "";
        frames.push(...parts);
      }
      return true;
    };
    return { frames, until, close: () => cut.abort() };
  }

  test("a stream opened with a ticket, as a browser opens it, is cut the same", async () => {
    const ticket = text(field(await body(await post("/api/auth/ticket", { for: "events" }, tokens.avery)), "ticket"));
    const mine = await listen(null, `/api/events?ticket=${ticket}`);
    await mine.until((f) => f.length > 0);
    expect((await post(`/api/repos/favorite?id=${ids.tool}`, { favorite: false }, tokens.owner)).status).toBe(200);
    expect((await post(`/api/repos/favorite?id=${ids.app}`, { favorite: false }, tokens.owner)).status).toBe(200);
    expect(await mine.until((f) => f.some((x) => x.includes('"type":"repo"') && x.includes(ids.app)))).toBe(true);
    expect(mine.frames.some((x) => x.includes(ids.tool))).toBe(false);
    mine.close();
  });

  test("carries a repo's event to its team and never another team's", async () => {
    const mine = await listen(tokens.avery);
    const all = await listen(tokens.robin);
    await mine.until((f) => f.length > 0);
    await all.until((f) => f.length > 0);
    // the other team's repo first, then the team's own: the second arriving
    // proves the first had its turn
    expect((await post(`/api/repos/favorite?id=${ids.tool}`, { favorite: true }, tokens.owner)).status).toBe(200);
    expect((await post(`/api/repos/favorite?id=${ids.site}`, { favorite: true }, tokens.owner)).status).toBe(200);
    const hears = (id: string) => (f: string[]) => f.some((x) => x.includes('"type":"repo"') && x.includes(id));
    expect(await mine.until(hears(ids.site))).toBe(true);
    expect(await all.until(hears(ids.site))).toBe(true);
    expect(hears(ids.tool)(all.frames)).toBe(true);
    expect(mine.frames.some((x) => x.includes(ids.tool))).toBe(false);
    mine.close();
    all.close();
  });

  test("ends when the person's scope moves, and their next read is the new one", async () => {
    const mine = await listen(tokens.avery);
    const other = await listen(tokens.robin);
    await mine.until((f) => f.length > 0);
    await other.until((f) => f.length > 0);
    // the team's folders move to the lab
    expect((await post("/api/people/team", { id: RIO, name: "Rio", folders: [join(root, "lab")] }, tokens.owner)).status).toBe(200);
    // Avery's stream ends: `until` answers false once it has
    expect(await mine.until(() => false)).toBe(false);
    expect(names(field(await body(await get("/api/tree", tokens.avery)), "repos"))).toEqual(["tool"]);
    expect(await walled(await get(`/api/repos/log?id=${ids.app}`, tokens.avery))).toBe(true);
    // someone whose scope did not move keeps their stream, and hears the roster
    expect(await other.until((f) => f.some((x) => x.includes('"type":"people"')))).toBe(true);
    other.close();
    // taken off the team, a member sees everything again
    expect((await post("/api/people/set", { id: AVERY, teams: [] }, tokens.owner)).status).toBe(200);
    expect(field(await body(await get("/api/auth", tokens.avery)), "scope")).toBeNull();
    expect(names(field(await body(await get("/api/tree", tokens.avery)), "repos"))).toEqual(["app", "site", "tool"]);
    expect((await get("/api/landing", tokens.avery)).status).not.toBe(403);
  });
});
