import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Run, ServerEvent } from "../core/types";
import { NOTE_CHARS, NOTES_MAX, type WorkFacts } from "../core/work";
import type { Caller } from "./callers";
import { WorkHub } from "./work";

let root = "";
let n = 0;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "canopy-workhub-"));
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

const IDS = ["w-testaaaa", "w-testbbbb", "w-testcccc"] as const;
const page: Caller = { id: "p1", kind: "page", label: "page mac", created: 0, used: 0 };

function hub(dir = join(root, `w${++n}`)) {
  const events: ServerEvent[] = [];
  const facts = new Map<string, WorkFacts>();
  let ids = 0;
  let clock = 1000;
  const h = new WorkHub({
    broadcast: (ev) => events.push(ev),
    facts: (item) => facts.get(item.id) ?? { active: false, branches: [] },
    dir,
    now: () => ++clock,
    mintId: () => {
      const id = IDS[ids++];
      if (!id) throw new Error("test id sequence exhausted");
      return id;
    },
  });
  const call = (method: string, path: string, body?: unknown, caller: Caller | null = page) =>
    h.handle(new Request(`http://x${path}`, { method, ...(body !== undefined ? { body: JSON.stringify(body), headers: { "content-type": "application/json" } } : {}) }), new URL(`http://x${path}`), caller);
  return { h, events, facts, dir, call };
}

const run = (id: string, work: string, origin: string, status: Run["status"] = "working"): Run => ({
  id,
  repoId: "r",
  action: "ask",
  verb: "Ask",
  progress: "building",
  expectsChange: true,
  chat: false,
  harness: "claude",
  note: "work run",
  status,
  startedAt: 1,
  ...(status === "working" ? {} : { endedAt: 2 }),
  steps: [],
  prompt: null,
  branch: { name: `run/${work}-x`, target: "main", base: "b", dir: "/w", state: status === "working" ? "working" : "ready", origin, work },
});

describe("the ledger", () => {
  test("mint keeps an open item, writes it, and the work event carries the list", async () => {
    const { h, events, dir } = hub();
    await h.adopt();
    const item = h.mint({ title: "Add a test", from: { kind: "note" }, repos: ["r"] });
    expect(item).toMatchObject({ id: "w-testaaaa", title: "Add a test", repos: ["r"], state: "open", from: { kind: "note" }, runs: [], branches: [], prs: [], events: [], notes: [] });
    expect(item.createdAt).toBe(item.updatedAt);
    await h.idle();
    expect(JSON.parse(await readFile(join(dir, "w-testaaaa.json"), "utf8"))).toEqual(item);
    expect(events.at(-1)).toEqual({ type: "work", items: [item] });
    expect(h.info()).toEqual({ items: [item], archived: 0 });
  });

  test("the sink's lines: by canopy, cut, folded past NOTES_MAX; an unknown id is dropped, never minted", async () => {
    const { h } = hub();
    await h.adopt();
    const { id } = h.mint({ title: "t", from: { kind: "note" }, repos: ["r"] });
    h.note(id, `  ${"x".repeat(700)}  `);
    expect(h.get(id)?.notes).toEqual([{ at: expect.any(Number), by: "canopy", text: "x".repeat(NOTE_CHARS) }]);
    for (let i = 0; i < NOTES_MAX; i++) h.note(id, `n${i}`);
    expect(h.get(id)?.notes).toHaveLength(NOTES_MAX);
    expect(h.get(id)?.notes[0]?.text.startsWith("earlier: ")).toBe(true);
    h.note(id, "   ");
    expect(h.get(id)?.notes).toHaveLength(NOTES_MAX);
    h.note("w-nope2345", "lost");
    h.link("w-nope2345", { event: "e1" });
    h.close("w-nope2345", "dropped", "gone");
    expect(h.info().items.map((i) => i.id)).toEqual([id]);
    await h.idle();
  });

  test("a run on the item's branch is written on it, and the state follows the facts", async () => {
    const { h, facts } = hub();
    await h.adopt();
    const { id } = h.mint({ title: "t", from: { kind: "note" }, repos: ["r"] });
    facts.set(id, { active: true, branches: [{ state: "working" }] });
    h.onRun(run("r1", id, "b1"));
    h.onRun(run("r1", id, "b1"));
    h.onRun(run("r9", "w-nope2345", "b9"));
    expect(h.get(id)).toMatchObject({ runs: ["r1"], branches: ["b1"], state: "working" });
    facts.set(id, { active: false, branches: [{ state: "ready", land: "queued" }] });
    h.recheck();
    expect(h.get(id)?.state).toBe("review");
    h.onRun(run("fix1", id, "b1", "done"));
    expect(h.get(id)?.runs).toEqual(["r1", "fix1"]);
    h.close(id, "landed", "landed on main");
    expect(h.get(id)).toMatchObject({ state: "landed", closedAt: expect.any(Number) });
    expect(h.get(id)?.reason).toBeUndefined();
    expect(h.get(id)?.notes.at(-1)?.text).toBe("landed on main");
    facts.set(id, { active: false, branches: [] });
    h.recheck();
    expect(h.get(id)?.state).toBe("landed");
    await h.idle();
  });

  test("link keeps each PR and event once", async () => {
    const { h } = hub();
    await h.adopt();
    const { id } = h.mint({ title: "t", from: { kind: "note" }, repos: ["r"] });
    h.link(id, { pr: { number: 7, url: "https://github.com/o/r/pull/7" } });
    h.link(id, { pr: { number: 7, url: "https://github.com/o/r/pull/7" } });
    h.link(id, { event: "e1" });
    h.link(id, { event: "e1" });
    expect(h.get(id)).toMatchObject({ prs: [{ number: 7, url: "https://github.com/o/r/pull/7" }], events: ["e1"] });
    await h.idle();
  });

  test("adopt reads the items the last server left, and writes what was minted before the lock", async () => {
    const first = hub();
    const early = first.h.mint({ title: "before the lock", from: { kind: "note" }, repos: ["r"] });
    await first.h.adopt();
    await first.h.idle();
    const again = hub(first.dir);
    await again.h.adopt();
    expect(again.h.get(early.id)?.title).toBe("before the lock");
  });
});

describe("the routes", () => {
  test("list and one with their filters; a note carries the caller's label; close by hand", async () => {
    const { h, facts, call } = hub();
    await h.adopt();
    const a = h.mint({ title: "A", from: { kind: "note" }, repos: ["r1"] });
    const b = h.mint({ title: "B", from: { kind: "trigger", event: "e1" }, repos: ["r2"] });
    const list = await (await call("GET", "/api/work"))?.json();
    expect(list).toMatchObject({ items: [{ id: b.id }, { id: a.id }], archived: 0 });
    expect(await (await call("GET", "/api/work?repo=r1"))?.json()).toMatchObject({ items: [{ id: a.id }] });
    expect(await (await call("GET", "/api/work?state=open"))?.json()).toMatchObject({ items: [{ id: b.id }, { id: a.id }] });
    expect((await call("GET", "/api/work?state=nope"))?.status).toBe(400);
    expect(await (await call("GET", `/api/work/one?id=${a.id}`))?.json()).toMatchObject({ title: "A" });
    expect((await call("GET", "/api/work/one?id=w-nope2345"))?.status).toBe(404);
    expect((await call("GET", "/api/work/one"))?.status).toBe(400);
    const noted = await call("POST", "/api/work/note", { id: a.id, text: "try the other branch first" });
    expect(noted?.status).toBe(200);
    expect(h.get(a.id)?.notes).toEqual([{ at: expect.any(Number), by: "page mac", text: "try the other branch first" }]);
    await call("POST", "/api/work/note", { id: a.id, text: "from nobody" }, null);
    expect(h.get(a.id)?.notes.at(-1)?.by).toBe("eric");
    expect((await call("POST", "/api/work/note", { id: a.id }))?.status).toBe(400);
    facts.set(a.id, { active: true, branches: [{ state: "working" }] });
    expect((await call("POST", "/api/work/close", { id: a.id, state: "dropped", reason: "not worth it" }))?.status).toBe(409);
    facts.set(a.id, { active: false, branches: [] });
    expect((await call("POST", "/api/work/close", { id: a.id, state: "nope" }))?.status).toBe(400);
    const closed = await call("POST", "/api/work/close", { id: a.id, state: "dropped", reason: "not worth it" });
    expect(closed?.status).toBe(200);
    expect(h.get(a.id)).toMatchObject({ state: "dropped", reason: "not worth it" });
    expect(h.get(a.id)?.notes.at(-1)).toMatchObject({ by: "page mac", text: "closed by hand as dropped: not worth it" });
    expect(await call("GET", "/api/other")).toBeNull();
    expect((await call("GET", "/api/work/nope"))?.status).toBe(404);
    await h.idle();
  });
});
