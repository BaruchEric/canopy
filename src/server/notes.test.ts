import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { QuickNote } from "../core/notes";
import type { Repo, ServerEvent } from "../core/types";
import { NotesHub } from "./notes";

let root = "";
let n = 0;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "canopy-notes-"));
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

const IDS = ["n-testaaaa", "n-testbbbb", "n-testcccc", "n-testdddd"] as const;
const repos = [{ id: "r1", path: "/repos/atlas", name: "atlas" }, { id: "r2", path: "/repos/keel", name: "keel" }] as unknown as Repo[];

function hub(dir = join(root, `n${++n}`)) {
  const events: ServerEvent[] = [];
  let ids = 0;
  let clock = 1_000_000;
  const h = new NotesHub({
    broadcast: (ev) => events.push(ev),
    repo: (ref) => repos.find((r) => r.id === ref || r.path === ref),
    dir,
    now: () => clock,
    mintId: () => {
      const id = IDS[ids++];
      if (!id) throw new Error("test id sequence exhausted");
      return id;
    },
  });
  const call = async (method: string, path: string, body?: unknown): Promise<{ status: number; body: Record<string, unknown> }> => {
    const res = await h.handle(new Request(`http://x${path}`, { method, ...(body !== undefined ? { body: JSON.stringify(body), headers: { "content-type": "application/json" } } : {}) }), new URL(`http://x${path}`));
    if (!res) throw new Error(`no answer for ${method} ${path}`);
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };
  const tick = (ms: number) => {
    clock += ms;
  };
  return { h, events, dir, call, tick, clock: () => clock };
}

const notesIn = (events: ServerEvent[]): QuickNote[] => {
  const last = events.at(-1);
  if (!last || last.type !== "notes") throw new Error("no notes event");
  return last.notes;
};

describe("NotesHub routes", () => {
  test("add, list, edit, done and delete, each written to the file and broadcast", async () => {
    const t = hub();
    expect((await t.call("GET", "/api/notes")).body).toEqual({ notes: [] });

    const added = await t.call("POST", "/api/notes", { text: "  ask Eric about atlas ", repo: "/repos/atlas", at: "in 30m" });
    expect(added.status).toBe(200);
    expect(added.body).toEqual({ id: "n-testaaaa", text: "ask Eric about atlas", repoId: "r1", due: t.clock() + 30 * 60_000, createdAt: t.clock() });
    expect(notesIn(t.events)).toEqual([added.body as unknown as QuickNote]);
    expect(JSON.parse(await readFile(join(t.dir, "notes.json"), "utf8"))).toEqual([added.body]);

    const plain = await t.call("POST", "/api/notes", { text: "a thought" });
    expect(plain.body).toEqual({ id: "n-testbbbb", text: "a thought", createdAt: t.clock() });
    expect((await t.call("GET", "/api/notes")).body).toEqual({ notes: [added.body, plain.body] });

    const edited = await t.call("POST", "/api/notes/edit", { id: "n-testbbbb", text: "a better thought", repo: "r2", at: "in 1h" });
    expect(edited.body).toEqual({ id: "n-testbbbb", text: "a better thought", repoId: "r2", due: t.clock() + 3_600_000, createdAt: t.clock() });
    const cleared = await t.call("POST", "/api/notes/edit", { id: "n-testbbbb", repo: null, at: null });
    expect(cleared.body).toEqual({ id: "n-testbbbb", text: "a better thought", createdAt: t.clock() });

    t.tick(10);
    const done = await t.call("POST", "/api/notes/done", { id: "n-testaaaa" });
    expect(done.body["doneAt"]).toBe(t.clock());
    expect(notesIn(t.events).find((x) => x.id === "n-testaaaa")?.doneAt).toBe(t.clock());

    const gone = await t.call("DELETE", "/api/notes?id=n-testbbbb");
    expect(gone.body).toEqual({ ok: true });
    expect(notesIn(t.events).map((x) => x.id)).toEqual(["n-testaaaa"]);
    expect(JSON.parse(await readFile(join(t.dir, "notes.json"), "utf8")).map((x: QuickNote) => x.id)).toEqual(["n-testaaaa"]);
  });

  test("refusals: empty text, an unknown repo, a time that cannot be read, an unknown id", async () => {
    const t = hub();
    expect((await t.call("POST", "/api/notes", { text: "   " })).status).toBe(400);
    expect((await t.call("POST", "/api/notes", { text: "x", repo: "/nowhere" })).status).toBe(404);
    const when = await t.call("POST", "/api/notes", { text: "x", at: "someday" });
    expect(when.status).toBe(400);
    expect(String(when.body["error"])).toContain("not a time");
    expect((await t.call("POST", "/api/notes/done", { id: "n-nosuchid" })).status).toBe(404);
    expect((await t.call("POST", "/api/notes/edit", { id: "n-testaaaa", text: "x" })).status).toBe(404);
    expect((await t.call("POST", "/api/notes/edit", { id: "n-testaaaa", text: "" })).status).toBe(400);
    expect((await t.call("DELETE", "/api/notes?id=w-wrongkind")).status).toBe(400);
    expect((await t.call("GET", "/api/notes/other")).status).toBe(404);
    expect(t.events).toEqual([]);
  });

  test("a time as unix ms is taken as it is; a past one is refused", async () => {
    const t = hub();
    const at = t.clock() + 120_000;
    expect((await t.call("POST", "/api/notes", { text: "x", at })).body["due"]).toBe(at);
    expect((await t.call("POST", "/api/notes", { text: "x", at: t.clock() - 1 })).status).toBe(400);
  });

  test("the file is read again before a write, so another server's note is kept", async () => {
    const t = hub();
    await t.call("POST", "/api/notes", { text: "mine" });
    const theirs: QuickNote = { id: "n-elsewher", text: "theirs", createdAt: 5 };
    const mine = JSON.parse(await readFile(join(t.dir, "notes.json"), "utf8")) as QuickNote[];
    await writeFile(join(t.dir, "notes.json"), JSON.stringify([...mine, theirs]));
    await t.call("POST", "/api/notes", { text: "mine too" });
    expect(notesIn(t.events).map((x) => x.id)).toEqual(["n-testaaaa", "n-elsewher", "n-testbbbb"]);
  });

  test("a file that is not JSON is read as no notes and overwritten by the next write", async () => {
    const t = hub();
    await mkdir(t.dir, { recursive: true });
    await writeFile(join(t.dir, "notes.json"), "{ not json");
    expect((await t.call("GET", "/api/notes")).body).toEqual({ notes: [] });
    await t.call("POST", "/api/notes", { text: "fresh" });
    expect(JSON.parse(await readFile(join(t.dir, "notes.json"), "utf8"))).toHaveLength(1);
  });
});

describe("NotesHub remind", () => {
  test("a reminder whose time has come is delivered once, written and broadcast; moving its time brings it back", async () => {
    const t = hub();
    await t.call("POST", "/api/notes", { text: "soon", at: "in 1m" });
    await t.call("POST", "/api/notes", { text: "later", at: "in 1h" });
    const before = t.events.length;
    await t.h.remind(t.clock());
    expect(t.events).toHaveLength(before);

    t.tick(61_000);
    await t.h.remind(t.clock());
    expect(t.events).toHaveLength(before + 1);
    const notes = notesIn(t.events);
    expect(notes.find((x) => x.text === "soon")?.remindedAt).toBe(t.clock());
    expect(notes.find((x) => x.text === "later")?.remindedAt).toBeUndefined();
    expect(JSON.parse(await readFile(join(t.dir, "notes.json"), "utf8")).find((x: QuickNote) => x.text === "soon").remindedAt).toBe(t.clock());

    await t.h.remind(t.clock() + 1);
    expect(t.events).toHaveLength(before + 1);

    const moved = await t.call("POST", "/api/notes/edit", { id: "n-testaaaa", at: "in 5m" });
    expect(moved.body["remindedAt"]).toBeUndefined();
    t.tick(6 * 60_000);
    await t.h.remind(t.clock());
    expect(notesIn(t.events).find((x) => x.id === "n-testaaaa")?.remindedAt).toBe(t.clock());
  });

  test("a done reminder is never delivered", async () => {
    const t = hub();
    await t.call("POST", "/api/notes", { text: "soon", at: "in 1m" });
    await t.call("POST", "/api/notes/done", { id: "n-testaaaa" });
    const before = t.events.length;
    t.tick(120_000);
    await t.h.remind(t.clock());
    expect(t.events).toHaveLength(before);
  });
});
