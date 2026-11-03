/**
 * The push hub over a stand-in push service (FR-042): the key file,
 * subscribe and its refusals, the pruning and stale rules, the hold while a
 * page is about, the test push, and what the list shows.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PUSH_FAILS, PUSH_SUBS, type PushInput } from "../core/push";
import { b64url, freshSender, unb64url, verifyVapidToken, type Jwk } from "../core/webpush";
import type { Ask } from "../core/types";
import type { Caller } from "./callers";
import { PushHub, type PushFetch, type PushHubDeps, type PushKeyInfo, type PushListInfo } from "./push";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "canopy-push-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** a browser's keys, as its push service would make them */
async function browserKeys(): Promise<{ p256dh: string; auth: string; privateKey: Jwk }> {
  const s = await freshSender();
  return { p256dh: b64url(s.publicKey), auth: b64url(crypto.getRandomValues(new Uint8Array(16))), privateKey: s.privateKey };
}

const page: Caller = { id: "p1", kind: "page", label: "mac", created: 0, used: 0 };
const shell: Caller = { id: "s1", kind: "shell", label: "shell", created: 0, used: 0 };
const cli: Caller = { id: "c1", kind: "cli", label: "cli", created: 0, used: 0 };

const ask = (id: string, over: Partial<Ask> = {}): Ask => ({ id, agent: "claude", handle: "mac", node: "mac", kind: "permission", tool: "Bash", title: `run ${id}`, detail: "", route: "remote", waitUntil: 9_000_000_000_000, state: "open", createdAt: 1, ...over });

interface World {
  hub: PushHub;
  calls: { url: string; headers: Record<string, string>; body: Uint8Array }[];
  answer: (url: string) => number;
  input: PushInput;
  streams: number;
  now: number;
  health: string[];
}

/** a hub over a scratch dir and a service that answers what `answer` says */
async function up(over: Partial<PushHubDeps> = {}, started = true): Promise<World> {
  const w: World = {
    hub: null as unknown as PushHub,
    calls: [],
    answer: () => 201,
    input: { asks: [], runs: [], flows: [], landing: [], notices: [], prs: [], triggers: [], ranger: null, nameOf: () => "" },
    streams: 0,
    now: 1_700_000_000_000,
    health: [],
  };
  const fetch: PushFetch = async (url, init) => {
    w.calls.push({ url, headers: init.headers, body: init.body });
    const status = w.answer(url);
    return { status, headers: { get: (name: string) => (name === "retry-after" && status === 429 ? "0" : null) } };
  };
  w.hub = new PushHub({
    dir: join(dir, "push"),
    subject: "mailto:eric@example.test",
    backend: "mac",
    snapshot: () => w.input,
    streams: () => w.streams,
    fetch,
    now: () => w.now,
    onHealth: (r) => w.health.push(`${r.state}${"why" in r && r.why ? `: ${r.why}` : ""}`),
    debounce: 5,
    hold: 50,
    quiet: 20,
    ...over,
  });
  if (started) await w.hub.start();
  return w;
}

const req = (method: string, path: string, body?: unknown): [Request, URL] => {
  const url = new URL(`http://canopy.test${path}`);
  return [new Request(url.toString(), { method, ...(body !== undefined ? { body: JSON.stringify(body), headers: { "content-type": "application/json" } } : {}) }), url];
};

const client = (n: number): string => n.toString(16).padStart(16, "0");

async function subscribe(w: World, n: number, caller: Caller | null = page, over: Record<string, unknown> = {}): Promise<Response> {
  const keys = await browserKeys();
  const r = await w.hub.handle(...req("POST", "/api/push/subscribe", { subscription: { endpoint: `https://push.test/${client(n)}`, keys: { p256dh: keys.p256dh, auth: keys.auth } }, client: client(n), device: `device ${n}`, ...over }), caller);
  return r ?? new Response(null, { status: 404 });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("the key file", () => {
  test("is made on first start, 0600 under a 0700 dir, and read back on the next", async () => {
    const w = await up();
    const file = join(dir, "push", "vapid.json");
    expect(((await stat(file)).mode & 0o777).toString(8)).toBe("600");
    expect(((await stat(join(dir, "push"))).mode & 0o777).toString(8)).toBe("700");
    const key = w.hub.publicKey();
    expect(key).not.toBeNull();
    expect(unb64url(key ?? "").length).toBe(65);
    const again = await up();
    expect(again.hub.publicKey()).toBe(key);
    const kept = JSON.parse(await readFile(file, "utf8")) as { privateKey: { d?: string }; subject: string };
    expect(typeof kept.privateKey.d).toBe("string");
    // the key route gives the public half and the subject, never d
    const r = await w.hub.handle(...req("GET", "/api/push/key"), null);
    const info = (await r?.json()) as PushKeyInfo;
    expect(info).toEqual({ key, subject: "mailto:eric@example.test" });
    expect(JSON.stringify(info)).not.toContain(kept.privateKey.d ?? "no d at all");
  });

  test("a dir that cannot be written leaves no key, says why, and refuses to subscribe", async () => {
    const w = await up({ dir: join(dir, "nope", "push") }, false);
    await Bun.write(join(dir, "nope"), "a file where the dir should be");
    await w.hub.start();
    expect(w.hub.publicKey()).toBeNull();
    const info = (await (await w.hub.handle(...req("GET", "/api/push/key"), null))?.json()) as PushKeyInfo;
    expect(info.key).toBeNull();
    expect(info.why).toContain("the push key could not be kept");
    expect((await subscribe(w, 1)).status).toBe(503);
    expect(w.hub.probe()).toMatchObject({ state: "down", why: expect.stringContaining("push key") });
  });
});

describe("subscribe", () => {
  test("keeps a page's subscription, 0600 through a rename, and shows it without keys", async () => {
    const w = await up();
    const r = await subscribe(w, 1);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true, entry: { client: client(1), device: "device 1", backend: "mac", createdAt: w.now, usedAt: w.now, failures: 0, stale: false } });
    const file = join(dir, "push", "subscriptions.json");
    expect(((await stat(file)).mode & 0o777).toString(8)).toBe("600");
    expect((await readdir(join(dir, "push"))).filter((f) => f.endsWith(".tmp"))).toEqual([]);
    const list = (await (await w.hub.handle(...req("GET", "/api/push"), cli))?.json()) as PushListInfo;
    expect(list.vapid).toBe(true);
    expect(list.entries).toEqual([{ client: client(1), device: "device 1", backend: "mac", createdAt: w.now, usedAt: w.now, failures: 0, stale: false }]);
    expect(JSON.stringify(list)).not.toContain("push.test");
    expect(JSON.stringify(list)).not.toContain("p256dh");
    // the browser's own entry rides on the key read, by its client id
    const mine = (await (await w.hub.handle(...req("GET", `/api/push/key?client=${client(1)}`), null))?.json()) as PushKeyInfo;
    expect(mine.mine).toMatchObject({ client: client(1), stale: false });
    const other = (await (await w.hub.handle(...req("GET", `/api/push/key?client=${client(2)}`), null))?.json()) as PushKeyInfo;
    expect(other.mine).toBeNull();
  });

  test("a shell's token is refused, a page's and none (an unenforced backend) are not", async () => {
    const w = await up();
    expect((await subscribe(w, 1, shell)).status).toBe(403);
    expect((await subscribe(w, 1, null)).status).toBe(200);
    expect((await subscribe(w, 2, page)).status).toBe(200);
  });

  test("a second endpoint for the same browser is a 409 unless the body says replace", async () => {
    const w = await up();
    expect((await subscribe(w, 1)).status).toBe(200);
    const keys = await browserKeys();
    const other = { subscription: { endpoint: "https://push.test/other", keys: { p256dh: keys.p256dh, auth: keys.auth } }, client: client(1), device: "same browser" };
    expect((await w.hub.handle(...req("POST", "/api/push/subscribe", other), page))?.status).toBe(409);
    expect((await w.hub.handle(...req("POST", "/api/push/subscribe", { ...other, replace: true }), page))?.status).toBe(200);
    expect(w.hub.list().entries.map((e) => e.device)).toEqual(["same browser"]);
  });

  test("a bad body is a 400", async () => {
    const w = await up();
    expect((await subscribe(w, 1, page, { client: "x" })).status).toBe(400);
    expect((await w.hub.handle(...req("POST", "/api/push/subscribe", { subscription: { endpoint: "http://plain/x", keys: { p256dh: "B", auth: "A" } }, client: client(1) }), page))?.status).toBe(400);
  });

  test("delete removes the entry; an unknown client is fine", async () => {
    const w = await up();
    await subscribe(w, 1);
    const r = await w.hub.handle(...req("DELETE", `/api/push/subscribe?client=${client(1)}`), page);
    expect(await r?.json()).toEqual({ ok: true, removed: true });
    expect(w.hub.list().entries).toEqual([]);
    expect(await (await w.hub.handle(...req("DELETE", `/api/push/subscribe?client=${client(1)}`), page))?.json()).toEqual({ ok: true, removed: false });
    expect((await w.hub.handle(...req("DELETE", "/api/push/subscribe?client=zz"), page))?.status).toBe(400);
  });

  test("the cap keeps the newest used entries", async () => {
    const w = await up({ cap: 3 });
    for (let i = 1; i <= 4; i++) {
      w.now += 1000;
      await subscribe(w, i);
    }
    expect(w.hub.list().entries.map((e) => e.client)).toEqual([client(2), client(3), client(4)]);
  });

  test("the file is read back on the next start, and junk in it is dropped", async () => {
    const w = await up();
    await subscribe(w, 1);
    await Bun.write(join(dir, "push", "subscriptions.json"), JSON.stringify([...JSON.parse(await readFile(join(dir, "push", "subscriptions.json"), "utf8")), { client: "junk" }]));
    const again = await up();
    expect(again.hub.list().entries.map((e) => e.client)).toEqual([client(1)]);
  });
});

describe("the test push", () => {
  test("reaches every entry with a VAPID token for its origin and an encrypted body, and says how it went", async () => {
    const w = await up();
    await subscribe(w, 1);
    await subscribe(w, 2);
    const r = await w.hub.handle(...req("POST", "/api/push/test"), cli);
    const got = (await r?.json()) as { sent: number; failed: number; gone: number };
    expect(got).toMatchObject({ sent: 2, failed: 0, gone: 0 });
    expect(w.calls.map((c) => c.url).sort()).toEqual([`https://push.test/${client(1)}`, `https://push.test/${client(2)}`]);
    const call = w.calls[0]!;
    expect(call.headers["content-encoding"]).toBe("aes128gcm");
    expect(call.headers["ttl"]).toBe("3600");
    expect(call.headers["urgency"]).toBe("normal");
    const m = /^vapid t=([^,]+), k=(\S+)$/.exec(call.headers["authorization"] ?? "");
    expect(m?.[2]).toBe(w.hub.publicKey() ?? "no key");
    const vapid = JSON.parse(await readFile(join(dir, "push", "vapid.json"), "utf8")) as { publicKey: Jwk };
    expect(await verifyVapidToken(vapid.publicKey, m?.[1] ?? "")).toMatchObject({ aud: "https://push.test", sub: "mailto:eric@example.test" });
    // the body is ciphertext: the words are not in it
    expect(new TextDecoder().decode(call.body)).not.toContain("test push");
    expect(w.hub.list().entries.every((e) => e.usedAt === w.now && e.failures === 0)).toBe(true);
  });

  test("a 404 or 410 drops the browser, three other failures make it stale, a send clears them", async () => {
    const w = await up();
    await subscribe(w, 1);
    await subscribe(w, 2);
    w.answer = (url) => (url.endsWith(client(1)) ? 410 : 500);
    for (let i = 0; i < PUSH_FAILS; i++) await w.hub.test();
    const entries = w.hub.list().entries;
    expect(entries.map((e) => e.client)).toEqual([client(2)]);
    expect(entries[0]).toMatchObject({ failures: PUSH_FAILS, stale: true });
    expect(w.hub.probe()).toMatchObject({ state: "down", why: expect.stringContaining("stale"), detail: expect.stringContaining("500") });
    w.answer = () => 201;
    await w.hub.test();
    expect(w.hub.list().entries[0]).toMatchObject({ failures: 0, stale: false });
    expect(w.hub.probe()).toEqual({ state: "ok", detail: "1 browser" });
  });

  test("a 413 sends the title alone, a 429 is tried once more", async () => {
    const w = await up();
    await subscribe(w, 1);
    let first = true;
    w.answer = () => {
      if (first) {
        first = false;
        return 413;
      }
      return 201;
    };
    expect(await w.hub.test()).toMatchObject({ sent: 1 });
    expect(w.calls.length).toBe(2);
    expect(w.calls[1]!.body.length).toBeLessThan(w.calls[0]!.body.length);
    w.calls = [];
    first = true;
    w.answer = () => {
      if (first) {
        first = false;
        return 429;
      }
      return 201;
    };
    expect(await w.hub.test()).toMatchObject({ sent: 1 });
    expect(w.calls.length).toBe(2);
  });
});

/** polls until `pred` holds, for at most a second: the hub's timers are
 *  real, so a fixed sleep is a race under a loaded machine */
const until = async (pred: () => boolean, ms = 1000): Promise<void> => {
  const end = Date.now() + ms;
  while (!pred() && Date.now() < end) await sleep(5);
};

describe("what waits", () => {
  test("the first read is quiet; an ask that appears after it is pushed to every browser, once, with its count", async () => {
    const w = await up();
    await subscribe(w, 1);
    w.input = { ...w.input, asks: [ask("a1")] };
    w.hub.poke();
    await sleep(30);
    expect(w.calls).toEqual([]);
    w.now += 25;
    w.input = { ...w.input, asks: [ask("a1"), ask("a2")] };
    w.hub.poke();
    w.hub.poke();
    await until(() => w.calls.length === 1);
    expect(w.calls.length).toBe(1);
    expect(w.calls[0]!.headers["urgency"]).toBe("high");
    // the same item again is not news
    w.hub.poke();
    await sleep(30);
    expect(w.calls.length).toBe(1);
  });

  test("holds while a page's stream is open, drops the note when the item is gone by then, sends when it still waits", async () => {
    const w = await up();
    await subscribe(w, 1);
    w.hub.poke();
    await sleep(30);
    w.now += 25;
    w.streams = 1;
    w.input = { ...w.input, asks: [ask("gone"), ask("stays")] };
    w.hub.poke();
    await sleep(20);
    expect(w.calls).toEqual([]);
    w.input = { ...w.input, asks: [ask("stays")] };
    await until(() => w.calls.length === 1);
    await sleep(30);
    expect(w.calls.length).toBe(1);
    const call = w.calls[0]!;
    expect(call.url).toBe(`https://push.test/${client(1)}`);
  });

  test("an ask with under two minutes left goes at once even with a page about", async () => {
    const w = await up();
    await subscribe(w, 1);
    w.hub.poke();
    await sleep(30);
    w.now += 25;
    w.streams = 1;
    w.input = { ...w.input, asks: [ask("soon", { waitUntil: w.now + 60_000 })] };
    w.hub.poke();
    await until(() => w.calls.length === 1);
    expect(w.calls.length).toBe(1);
  });

  test("a page's request counts as presence, and a reseed opens a quiet window again", async () => {
    const w = await up();
    await subscribe(w, 1);
    w.hub.poke();
    await sleep(30);
    w.now += 25;
    w.hub.sawPage();
    w.input = { ...w.input, asks: [ask("a1")] };
    w.hub.poke();
    await sleep(20);
    expect(w.calls).toEqual([]);
    await until(() => w.calls.length === 1);
    expect(w.calls.length).toBe(1);
    // the stream came back: what the relist brings is not news
    w.hub.reseed();
    w.now += 25;
    w.input = { ...w.input, asks: [ask("a1"), ask("a2")] };
    w.hub.poke();
    await sleep(30);
    expect(w.calls.length).toBe(1);
  });
});

describe("health", () => {
  test("off with no browser, ok with one, reported after start and each pass", async () => {
    const w = await up();
    expect(w.health).toEqual(["off: no browser has turned push on"]);
    await subscribe(w, 1);
    expect(w.hub.probe()).toEqual({ state: "ok", detail: "1 browser" });
    await w.hub.test();
    expect(w.health.at(-1)).toBe("ok");
    for (let i = 2; i <= PUSH_SUBS; i++) await subscribe(w, i);
    expect(w.hub.probe()).toEqual({ state: "ok", detail: `${PUSH_SUBS} browsers` });
  });
});
