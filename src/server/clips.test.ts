import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Clip } from "../core/clips";
import type { ServerEvent } from "../core/types";
import { ClipsHub, SECRET_REFUSED } from "./clips";

let root = "";
let n = 0;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "canopy-clips-"));
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

const IDS = ["c-testaaaa", "c-testbbbb", "c-testcccc", "c-testdddd", "c-testeeee"] as const;
const DEVICE = { id: "0123456789abcdef", name: "Pixel 9, Chrome", platform: "android" };

function hub(dir = join(root, `c${++n}`)) {
  const events: ServerEvent[] = [];
  let ids = 0;
  let clock = 1_000_000;
  const h = new ClipsHub({
    broadcast: (ev) => events.push(ev),
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

describe("ClipsHub routes", () => {
  test("a copy is kept, listed, written 0600 and broadcast as a put", async () => {
    const t = hub();
    expect((await t.call("GET", "/api/clips")).body).toEqual({ clips: [] });
    const added = await t.call("POST", "/api/clips", { text: "bun run redeploy", source: "shell", from: "canopy", device: DEVICE });
    expect(added.status).toBe(200);
    const clip: Clip = { id: "c-testaaaa", text: "bun run redeploy", source: "shell", from: "canopy", device: DEVICE, createdAt: t.clock(), at: t.clock(), count: 1 };
    expect(added.body as unknown).toEqual(clip);
    expect(t.events).toEqual([{ type: "clips", put: ["c-testaaaa"], gone: [] }]);
    expect((await t.call("GET", "/api/clips")).body).toEqual({ clips: [clip] });
    const file = join(t.dir, "clips.json");
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual([clip]);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
  });

  test("the same text again is the same clip, moved to the top", async () => {
    const t = hub();
    await t.call("POST", "/api/clips", { text: "one", source: "page" });
    t.tick(1_000);
    await t.call("POST", "/api/clips", { text: "two", source: "page" });
    t.tick(1_000);
    const again = await t.call("POST", "/api/clips", { text: "one", source: "cli", from: "mini" });
    expect(again.body).toMatchObject({ id: "c-testaaaa", source: "cli", from: "mini", count: 2, at: t.clock() });
    const list = (await t.call("GET", "/api/clips")).body["clips"] as { id: string }[];
    expect(list.map((c) => c.id)).toEqual(["c-testaaaa", "c-testbbbb"]);
    const some = (await t.call("GET", "/api/clips?ids=c-testbbbb,junk,c-nothinga")).body["clips"] as { id: string }[];
    expect(some.map((c) => c.id)).toEqual(["c-testbbbb"]);
    expect((await t.call("GET", "/api/clips?ids=")).body).toEqual({ clips: [] });
  });

  test("refuses empty text, an unknown source and anything shaped like a secret", async () => {
    const t = hub();
    expect((await t.call("POST", "/api/clips", { text: "  ", source: "page" })).status).toBe(400);
    expect((await t.call("POST", "/api/clips", { text: "x", source: "mail" })).status).toBe(400);
    const secret = await t.call("POST", "/api/clips", { text: "export GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789", source: "shell" });
    expect(secret).toEqual({ status: 422, body: { error: SECRET_REFUSED } });
    expect(t.events).toEqual([]);
    expect((await t.call("GET", "/api/clips")).body).toEqual({ clips: [] });
  });

  test("use moves a clip up with its source kept; pin, delete and clear", async () => {
    const t = hub();
    await t.call("POST", "/api/clips", { text: "a", source: "shell" });
    t.tick(10);
    await t.call("POST", "/api/clips", { text: "b", source: "page" });
    t.tick(10);
    const used = await t.call("POST", "/api/clips/use", { id: "c-testaaaa" });
    expect(used.body).toMatchObject({ id: "c-testaaaa", source: "shell", count: 2, at: t.clock() });
    expect((await t.call("POST", "/api/clips/use", { id: "c-nothinga" })).status).toBe(404);

    const pinned = await t.call("POST", "/api/clips/pin", { id: "c-testbbbb", pinned: true });
    expect(pinned.body).toMatchObject({ id: "c-testbbbb", pinned: true });
    expect((await t.call("POST", "/api/clips/pin", { id: "c-testbbbb", pinned: "yes" })).status).toBe(400);

    t.events.length = 0;
    const cleared = await t.call("POST", "/api/clips/clear");
    expect(cleared.body).toEqual({ gone: ["c-testaaaa"] });
    expect(t.events).toEqual([{ type: "clips", put: [], gone: ["c-testaaaa"] }]);

    expect((await t.call("DELETE", "/api/clips?id=c-testbbbb")).body).toEqual({ ok: true });
    expect((await t.call("DELETE", "/api/clips?id=c-testbbbb")).status).toBe(404);
    expect((await t.call("DELETE", "/api/clips?id=junk")).status).toBe(400);
    expect((await t.call("GET", "/api/clips")).body).toEqual({ clips: [] });
  });

  test("keeps what another server wrote to the file in between", async () => {
    const t = hub();
    await t.call("POST", "/api/clips", { text: "mine", source: "page" });
    const file = join(t.dir, "clips.json");
    const theirs = { id: "c-theirsaa", text: "theirs", source: "cli", createdAt: 2_000_000, at: 2_000_000, count: 1 };
    const kept = JSON.parse(await readFile(file, "utf8")) as unknown[];
    await writeFile(file, JSON.stringify([theirs, ...kept]));
    await t.call("POST", "/api/clips", { text: "next", source: "page" });
    const list = (await t.call("GET", "/api/clips")).body["clips"] as { id: string }[];
    expect(list.map((c) => c.id)).toEqual(["c-theirsaa", "c-testbbbb", "c-testaaaa"]);
  });

  test("a path that is not the clipboard's is not answered", async () => {
    const t = hub();
    expect(await t.h.handle(new Request("http://x/api/clipsy"), new URL("http://x/api/clipsy"))).toBeNull();
    expect((await t.call("PUT", "/api/clips")).status).toBe(404);
  });
});
