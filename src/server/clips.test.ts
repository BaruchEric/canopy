import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { lstat, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Clip } from "../core/clips";
import type { ServerEvent } from "../core/types";
import { attachment, ClipsHub, SECRET_REFUSED } from "./clips";

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

  test("a file that cannot be read is not an empty clipboard: the copy is refused and the file is left alone", async () => {
    const t = hub();
    await mkdir(t.dir, { recursive: true });
    const file = join(t.dir, "clips.json");
    // a link to itself: reading it fails (ELOOP) on macOS and Linux alike, as root too
    await symlink("clips.json", file);
    expect((await t.call("POST", "/api/clips", { text: "next", source: "page" })).status).toBe(500);
    expect((await t.call("GET", "/api/clips")).status).toBe(500);
    expect((await lstat(file)).isSymbolicLink()).toBe(true);
    expect(t.events).toEqual([]);
    // readable again, the clipboard goes on
    await rm(file);
    expect((await t.call("POST", "/api/clips", { text: "next", source: "page" })).status).toBe(200);
  });

  test("a path that is not the clipboard's is not answered", async () => {
    const t = hub();
    expect(await t.h.handle(new Request("http://x/api/clipsy"), new URL("http://x/api/clipsy"))).toBeNull();
    expect((await t.call("PUT", "/api/clips")).status).toBe(404);
  });
});

describe("ClipsHub files", () => {
  const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
  const upload = async (t: ReturnType<typeof hub>, bytes: Uint8Array, q: string, type = "image/png") => {
    const path = `/api/clips/file?${q}`;
    const res = await t.h.handle(new Request(`http://x${path}`, { method: "POST", body: bytes, headers: { "content-type": type } }), new URL(`http://x${path}`));
    if (!res) throw new Error("no answer");
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };
  const download = async (t: ReturnType<typeof hub>, id: string) => {
    const path = `/api/clips/file?id=${id}`;
    const res = await t.h.handle(new Request(`http://x${path}`), new URL(`http://x${path}`));
    if (!res) throw new Error("no answer");
    return res;
  };

  test("a picture is kept under its clip's id, 0600 in a 0700 folder, and served back as a sandboxed download", async () => {
    const t = hub();
    const added = await upload(t, PNG, `name=${encodeURIComponent("../Screen Shot 1.png")}&source=device&from=pasted&device=${encodeURIComponent(JSON.stringify(DEVICE))}`);
    expect(added.status).toBe(201);
    expect(added.body).toMatchObject({ id: "c-testaaaa", text: "Screen Shot 1.png", source: "device", from: "pasted", device: DEVICE, file: { name: "Screen Shot 1.png", type: "image/png", size: PNG.byteLength } });
    expect(t.events).toEqual([{ type: "clips", put: ["c-testaaaa"], gone: [] }]);
    const bytes = join(t.dir, "clips", "c-testaaaa");
    expect(new Uint8Array(await readFile(bytes))).toEqual(PNG);
    expect((await stat(bytes)).mode & 0o777).toBe(0o600);
    expect((await stat(join(t.dir, "clips"))).mode & 0o777).toBe(0o700);
    const res = await download(t, "c-testaaaa");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-security-policy")).toBe("sandbox; default-src 'none'");
    expect(res.headers.get("content-disposition")).toBe(`attachment; filename="Screen Shot 1.png"; filename*=UTF-8''Screen%20Shot%201.png`);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(PNG);
  });

  test("HTML and anything a browser would run goes out as plain bytes; a name cannot break the header", async () => {
    const t = hub();
    await upload(t, new TextEncoder().encode("<script>alert(1)</script>"), `name=${encodeURIComponent('a"b\r\nc.html')}&source=device`, "text/html");
    const res = await download(t, "c-testaaaa");
    expect(res.headers.get("content-type")).toBe("application/octet-stream");
    expect(res.headers.get("content-disposition")).toBe(`attachment; filename="a_bc.html"; filename*=UTF-8''a_bc.html`);
  });

  test("a name cut inside an emoji still downloads", async () => {
    // half of a two-unit character, as a record written before the cap minded it could hold
    expect(attachment("shot \uD83D")).toBe(`attachment; filename="shot _"; filename*=UTF-8''shot%20_`);
    expect(attachment("\uDE00 shot \u{1F600}.png")).toBe(`attachment; filename="_ shot __.png"; filename*=UTF-8''_%20shot%20%F0%9F%98%80.png`);
    const t = hub();
    await upload(t, PNG, `name=${encodeURIComponent(`${"a".repeat(159)}\u{1F600}.png`)}&source=device`);
    const res = await download(t, "c-testaaaa");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toBe(`attachment; filename="${"a".repeat(159)}"; filename*=UTF-8''${"a".repeat(159)}`);
  });

  test("the same bytes kept again are the same clip, under any name; a text clip of the name is another", async () => {
    const t = hub();
    await upload(t, PNG, "name=one.png&source=device");
    await t.call("POST", "/api/clips", { text: "two.png", source: "canopy" });
    t.tick(1000);
    const again = await upload(t, PNG, "name=two.png&source=cli");
    expect(again.body).toMatchObject({ id: "c-testaaaa", text: "two.png", count: 2, source: "cli" });
    const list = (await t.call("GET", "/api/clips")).body["clips"] as Clip[];
    expect(list.map((c) => [c.id, c.text, c.file ? "file" : "text"])).toEqual([
      ["c-testaaaa", "two.png", "file"],
      ["c-testbbbb", "two.png", "text"],
    ]);
    // the second copy's bytes were not kept beside the first
    const { readdir } = await import("node:fs/promises");
    expect((await readdir(join(t.dir, "clips"))).sort()).toEqual(["c-testaaaa"]);
  });

  test("refusals: empty, too large, a key's name, a key inside, an unknown source", async () => {
    const t = hub();
    expect((await upload(t, new Uint8Array(), "name=a.png&source=device")).status).toBe(400);
    expect((await upload(t, new Uint8Array(26 * 1024 * 1024), "name=big.bin&source=device", "application/octet-stream")).status).toBe(413);
    expect((await upload(t, new TextEncoder().encode("ssh-ed25519 AAAA"), "name=id_ed25519&source=device", "text/plain")).body).toEqual({ error: "a file that looks like a key or a password is never kept" });
    expect((await upload(t, new TextEncoder().encode("-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n"), "name=notes.txt&source=device", "text/plain")).status).toBe(422);
    expect((await upload(t, new TextEncoder().encode("DB_PASSWORD=hunter2hunter2\n"), "name=settings.txt&source=device", "text/plain")).status).toBe(422);
    expect((await upload(t, PNG, "name=a.png&source=fax")).status).toBe(400);
    expect((await upload(t, new TextEncoder().encode("ssh-ed25519 AAAA eric@mac"), "name=id_ed25519.pub&source=device", "text/plain")).status).toBe(201);
  });

  test("a clip that goes takes its bytes: drop, clear, and the budget's prune", async () => {
    const t = hub();
    await upload(t, PNG, "name=a.png&source=device");
    await upload(t, new Uint8Array([...PNG, 9]), "name=b.png&source=device");
    const { readdir } = await import("node:fs/promises");
    expect((await readdir(join(t.dir, "clips"))).sort()).toEqual(["c-testaaaa", "c-testbbbb"]);
    await t.call("DELETE", "/api/clips?id=c-testaaaa");
    expect(await readdir(join(t.dir, "clips"))).toEqual(["c-testbbbb"]);
    await t.call("POST", "/api/clips/clear");
    expect(await readdir(join(t.dir, "clips"))).toEqual([]);
    expect((await download(t, "c-testbbbb")).status).toBe(404);
  });

  test("the sweep clears bytes no record names once they are a minute old, never younger", async () => {
    const t = hub();
    await upload(t, PNG, "name=a.png&source=device");
    const { utimes, readdir } = await import("node:fs/promises");
    await writeFile(join(t.dir, "clips", "c-strayaaa"), "x");
    await writeFile(join(t.dir, "clips", "c-strayzzz"), "x");
    const old = new Date(t.clock() - 2 * 60_000);
    await utimes(join(t.dir, "clips", "c-strayaaa"), old, old);
    await utimes(join(t.dir, "clips", "c-testaaaa"), old, old);
    // the young stray is in the future of the hub's clock, so it stays
    const young = new Date(t.clock());
    await utimes(join(t.dir, "clips", "c-strayzzz"), young, young);
    await t.h.sweepNow();
    expect((await readdir(join(t.dir, "clips"))).sort()).toEqual(["c-strayzzz", "c-testaaaa"]);
  });

  test("a file read is 404 for a text clip, a bad id is 400", async () => {
    const t = hub();
    await t.call("POST", "/api/clips", { text: "hello", source: "canopy" });
    expect((await download(t, "c-testaaaa")).status).toBe(404);
    expect((await download(t, "../clips.json")).status).toBe(400);
  });
});
