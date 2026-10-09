/**
 * Asks for a human through canopy, against a stand-in broker: the open
 * asks listed and followed on the `asks` channel, an answer carrying the
 * answering browser's device name and its own answer key (forwarded as the
 * broker's Bearer token, never kept), every write refused (403) without a
 * key or from another site, presence set and beaten, the guards proxied and
 * validated, a closed ask swept after its keep, a shell counted watched
 * only after a keystroke (not a terminal's own reply) and never beating
 * presence itself, and the transcript route over fixture session files.
 * Plain ptys (`CANOPY_TMUX=0`).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Chan, ChanError } from "../core/chan";
import { projectFolder } from "../core/sessions";
import type { Ask, AskAnswer, AsksInfo, GuardsInfo, Presence, ServerEvent } from "../core/types";
import { ANSWER_KEY_HEADER, AskHub, answerKeyOf, answerer, parseAskAnswer } from "./asks";
import { startServer } from "./index";

/* ---------- the stand-in broker: asks, presence and guards, in memory ---------- */

const TOKEN = "sekret";
const asks = new Map<string, Ask>();
let presence: Presence = { state: "away", at: 0, pinned: false };
let guards: string[] = ["Bash(git push --force:*)"];
const answers: { id: string; body: Record<string, unknown>; auth: string | null }[] = [];
const presencePuts: { state: string; pinned: boolean }[] = [];
let beats = 0;
const streams = new Set<{ channels: string | null; send: (data: string) => void }>();
let msgId = 0;

const ask = (over: Partial<Ask>): Ask => ({
  id: "a1",
  agent: "claude:s1",
  handle: "app-0123",
  node: "macmini-2018",
  kind: "permission",
  tool: "Bash",
  title: "Bash: rm -rf build",
  detail: JSON.stringify({ command: "rm -rf build" }),
  route: "remote",
  waitUntil: Date.now() + 60_000,
  state: "open",
  createdAt: Date.now() - 5_000,
  ...over,
});

/** an ask change as the broker posts it: a silent event on #asks */
function post(a: Ask): void {
  asks.set(a.id, a);
  const m = { id: ++msgId, channel: "asks", handle: "tailchan", node: "tailchan", kind: "event", body: JSON.stringify({ type: "ask", ask: a }), meta: { silent: true }, ts: Date.now() };
  for (const s of streams) if (s.channels?.split(",").includes("asks")) s.send(`id: ${m.id}\nevent: message\ndata: ${JSON.stringify(m)}\n\n`);
}

const authed = (req: Request): string | null => {
  const m = /^Bearer (\S+)$/.exec(req.headers.get("authorization") ?? "");
  return m ? m[1]! : null;
};

const broker = Bun.serve({
  port: 0,
  idleTimeout: 0,
  async fetch(req) {
    const url = new URL(req.url);
    const p = url.pathname;
    const deny = (): Response | null => {
      const t = authed(req);
      if (!t) return Response.json({ error: "an answer token is required" }, { status: 401 });
      if (t !== TOKEN) return Response.json({ error: "bad answer token" }, { status: 403 });
      return null;
    };
    if (p === "/v1/agents") return Response.json([]);
    if (p === "/v1/asks" && req.method === "GET") {
      const state = url.searchParams.get("state") ?? "open";
      return Response.json([...asks.values()].filter((a) => state === "all" || a.state === state).sort((a, b) => a.createdAt - b.createdAt));
    }
    const am = /^\/v1\/asks\/([A-Za-z0-9-]+)(\/answer)?$/.exec(p);
    if (am) {
      const a = asks.get(am[1]!);
      if (!a) return Response.json({ error: "no such ask" }, { status: 404 });
      if (!am[2] && req.method === "GET") return Response.json(a);
      if (am[2] && req.method === "POST") {
        const refused = deny();
        if (refused) return refused;
        const body = (await req.json()) as Record<string, unknown>;
        answers.push({ id: a.id, body, auth: authed(req) });
        if (a.state !== "open") return Response.json({ error: `ask is ${a.state}` }, { status: 409 });
        const { by, ...answer } = body;
        const next: Ask = { ...a, state: "answered", answer: answer as unknown as Ask["answer"], answeredBy: `${String(by)}@canopy`, answeredAt: Date.now() };
        post(next);
        return Response.json(next);
      }
    }
    if (p === "/v1/presence" && req.method === "GET") return Response.json(presence);
    if (p === "/v1/presence" && req.method === "PUT") {
      const refused = deny();
      if (refused) return refused;
      const b = (await req.json()) as { state: "here" | "away"; pinned?: boolean };
      presencePuts.push({ state: b.state, pinned: b.pinned === true });
      presence = { state: b.state, at: Date.now(), pinned: b.pinned === true, by: "canopy" };
      return Response.json(presence);
    }
    if (p === "/v1/presence/beat" && req.method === "POST") {
      const refused = deny();
      if (refused) return refused;
      beats++;
      if (!(presence.pinned && presence.state === "away")) presence = { state: "here", at: Date.now(), pinned: presence.pinned, by: "canopy" };
      return Response.json(presence);
    }
    if (p === "/v1/guards" && req.method === "GET") return Response.json({ rules: guards });
    if (p === "/v1/guards" && req.method === "PUT") {
      const refused = deny();
      if (refused) return refused;
      guards = ((await req.json()) as { rules: string[] }).rules;
      return Response.json({ rules: guards });
    }
    if (p === "/v1/stream") {
      const enc = new TextEncoder();
      let entry: { channels: string | null; send: (data: string) => void } | null = null;
      const body = new ReadableStream<Uint8Array>({
        start(ctrl) {
          ctrl.enqueue(enc.encode(`event: ready\ndata: {}\n\n`));
          entry = { channels: url.searchParams.get("channels"), send: (d) => ctrl.enqueue(enc.encode(d)) };
          streams.add(entry);
        },
        cancel() {
          if (entry) streams.delete(entry);
        },
      });
      return new Response(body, { headers: { "content-type": "text/event-stream" } });
    }
    return Response.json({ error: `no route ${p}` }, { status: 404 });
  },
});
const BROKER = `http://127.0.0.1:${broker.port}`;
const CFG = { url: BROKER, as: "eric", bot: "canopy", channel: "canopy" };

/* ---------- canopy against it, holding no secret of its own ---------- */

let scratch: string;
let root: string;
let appPath: string;
let server: { port: number; stop: () => void };
const saved: Record<string, string | undefined> = {};
const events: ServerEvent[] = [];
const listening = new AbortController();
const CLIENT = "0123456789abcdef";

const api = (path: string) => `http://127.0.0.1:${server.port}${path}`;
/** a write as the page sends it, with this browser's answer key (null for
 *  none) and whatever else a caller adds */
const post$ = (path: string, body: unknown, key: string | null = TOKEN, method: "POST" | "PUT" = "POST", extra: Record<string, string> = {}) =>
  fetch(api(path), {
    method,
    headers: { "content-type": "application/json", ...(key === null ? {} : { [ANSWER_KEY_HEADER]: key }), ...extra },
    body: JSON.stringify(body),
  });

async function until(pred: () => boolean | Promise<boolean>, what: string, ms = 10_000): Promise<void> {
  const start = Date.now();
  while (!(await pred())) {
    if (Date.now() - start > ms) throw new Error(`gave up waiting for ${what}`);
    await Bun.sleep(25);
  }
}

const askEvents = () => events.filter((e): e is Extract<ServerEvent, { type: "asks" }> => e.type === "asks");

beforeAll(async () => {
  scratch = await realpath(await mkdtemp(join(tmpdir(), "canopy-asks-")));
  for (const k of ["CANOPY_CONFIG_DIR", "CANOPY_TMUX", "CLAUDE_CONFIG_DIR", "CODEX_HOME"]) saved[k] = process.env[k];
  process.env["CANOPY_CONFIG_DIR"] = join(scratch, "config");
  process.env["CANOPY_TMUX"] = "0";
  process.env["CLAUDE_CONFIG_DIR"] = join(scratch, "claude");
  process.env["CODEX_HOME"] = join(scratch, "codex");
  root = join(scratch, "root");
  appPath = join(root, "app");
  await Bun.$`mkdir -p ${appPath} && git -C ${appPath} init -q`.quiet();
  asks.set("a1", ask({}));
  server = await startServer({ root, port: 0, chan: CFG, asks: { closedKeep: 400, sweepEvery: 100 } });
  // a browser on the event stream, so an answer can say which device it came from
  void (async () => {
    const q = new URLSearchParams({ client: CLIENT, name: "Eric's Phone", platform: "ios" });
    const res = await fetch(api(`/api/events?${q}`), { signal: listening.signal });
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let buf = "";
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf("\n\n")) !== -1) {
          const line = buf.slice(0, nl).split("\n").find((l) => l.startsWith("data: "));
          buf = buf.slice(nl + 2);
          if (line) events.push(JSON.parse(line.slice(6)) as ServerEvent);
        }
      }
    } catch {
      // aborted
    }
  })();
  // the follower is on the stream before the tests post
  await until(() => [...streams].some((s) => s.channels === "asks"), "the follower");
});

afterAll(async () => {
  listening.abort();
  server.stop();
  broker.stop(true);
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  await rm(scratch, { recursive: true, force: true });
});

describe("asks through canopy", () => {
  test("the open asks, that an answer can go through, and presence", async () => {
    const info = (await (await fetch(api("/api/asks"))).json()) as AsksInfo;
    expect(info.ready).toBe(true);
    // the broker answers; whether a page can answer is whether it has a key
    expect(info.canAnswer).toBe(true);
    expect(info.asks.map((a) => a.id)).toEqual(["a1"]);
    expect(info.presence?.state).toBe("away");
  });

  test("a new ask on the channel arrives as an asks event", async () => {
    post(ask({ id: "a2", kind: "question", tool: "AskUserQuestion", title: "question: which one?", questions: [{ question: "Which one?", header: "Pick", options: [{ label: "A", description: "" }], multiSelect: false }] }));
    await until(() => askEvents().some((e) => e.asks.some((a) => a.id === "a2")), "the a2 event");
    const got = askEvents().flatMap((e) => e.asks).find((a) => a.id === "a2");
    expect(got?.questions?.[0]?.options[0]?.label).toBe("A");
  });

  test("an answer carries the answering device's name and its answer key", async () => {
    // the device list is debounced; wait for the stream's device to be known
    await until(async () => ((await (await fetch(api("/api/devices"))).json()) as { id: string }[]).some((d) => d.id === CLIENT), "the device");
    const res = await post$("/api/asks/answer", { id: "a1", behavior: "allow", always: true, client: CLIENT });
    expect(res.status).toBe(200);
    const done = (await res.json()) as Ask;
    expect(done.state).toBe("answered");
    expect(done.answeredBy).toBe("Erics-Phone@canopy");
    expect(answers.at(-1)).toMatchObject({ id: "a1", auth: TOKEN, body: { behavior: "allow", always: true, by: "Erics-Phone" } });
    // answering again is the broker's 409, passed through
    expect((await post$("/api/asks/answer", { id: "a1", behavior: "deny" })).status).toBe(409);
  });

  test("no write goes to the broker without an answer key, or from another site", async () => {
    const n = { answers: answers.length, puts: presencePuts.length, beats, guards: [...guards] };
    const writes = (key: string | null, extra: Record<string, string> = {}) => [
      post$("/api/asks/answer", { id: "a2", behavior: "allow" }, key, "POST", extra),
      post$("/api/presence", { away: true }, key, "POST", extra),
      post$("/api/presence/beat", {}, key, "POST", extra),
      post$("/api/guards", { rules: [] }, key, "PUT", extra),
    ];
    // a shell's call on the loopback, no Origin and no key: what an agent
    // with CANOPY_API would send to approve its own ask
    for (const res of await Promise.all(writes(null))) {
      expect(res.status).toBe(403);
      expect(((await res.json()) as { error: string }).error).toContain("answer key");
    }
    // a browser saying the fetch came from another site, key or not
    for (const res of await Promise.all(writes(TOKEN, { "sec-fetch-site": "cross-site" }))) expect(res.status).toBe(403);
    for (const res of await Promise.all(writes(TOKEN, { "sec-fetch-site": "same-site" }))) expect(res.status).toBe(403);
    // a key the broker refuses is a 403 too, its words passed on
    const bad = await post$("/api/presence/beat", {}, "not-the-key");
    expect(bad.status).toBe(403);
    expect(((await bad.json()) as { error: string }).error).toContain("bad answer token");
    expect({ answers: answers.length, puts: presencePuts.length, beats, guards }).toEqual(n);
    // the page's own fetch says same-origin, and goes through with its key
    expect((await post$("/api/presence/beat", {}, TOKEN, "POST", { "sec-fetch-site": "same-origin" })).status).toBe(200);
    expect(beats).toBe(n.beats + 1);
    // reading needs no key
    expect(((await (await fetch(api("/api/guards"))).json()) as GuardsInfo).canEdit).toBe(true);
    // a malformed answer is refused, key or not
    expect((await post$("/api/asks/answer", { id: "a2", behavior: "maybe" })).status).toBe(400);
  });

  test("the server keeps no key: each write brings its own, and none is ever logged", async () => {
    const said: string[] = [];
    const was = { log: console.log, error: console.error, warn: console.warn };
    const tap = (...a: unknown[]) => void said.push(a.map(String).join(" "));
    console.log = tap;
    console.error = tap;
    console.warn = tap;
    try {
      expect((await post$("/api/presence/beat", {})).status).toBe(200);
      // the key of the write before is not the next one's
      expect((await post$("/api/presence/beat", {}, null)).status).toBe(403);
      expect((await post$("/api/presence/beat", {}, "wrong-secret")).status).toBe(403);
    } finally {
      Object.assign(console, was);
    }
    expect(said.some((l) => l.includes(TOKEN) || l.includes("wrong-secret"))).toBe(false);
  });

  test("a closed ask stays a while to say how it ended, then leaves", async () => {
    post({ ...asks.get("a2")!, state: "withdrawn", why: "terminal" });
    await until(() => askEvents().some((e) => e.asks.some((a) => a.id === "a2" && a.state === "withdrawn")), "the withdrawal");
    await until(() => askEvents().some((e) => e.gone?.includes("a2")), "a2 swept");
    const info = (await (await fetch(api("/api/asks"))).json()) as AsksInfo;
    expect(info.asks.some((a) => a.id === "a2")).toBe(false);
  });

  test("away pins, and clearing it is here", async () => {
    const away = (await (await post$("/api/presence", { away: true })).json()) as Presence;
    expect(away).toMatchObject({ state: "away", pinned: true });
    await until(() => askEvents().some((e) => e.presence?.state === "away" && e.presence.pinned), "the presence event");
    const here = (await (await post$("/api/presence", { away: false })).json()) as Presence;
    expect(here).toMatchObject({ state: "here", pinned: false });
    expect(presencePuts.slice(-2)).toEqual([
      { state: "away", pinned: true },
      { state: "here", pinned: false },
    ]);
    expect((await post$("/api/presence", { away: "yes" })).status).toBe(400);
  });

  test("guards are the broker's, checked before they go", async () => {
    const got = (await (await fetch(api("/api/guards"))).json()) as GuardsInfo;
    expect(got).toEqual({ rules: ["Bash(git push --force:*)"], canEdit: true });
    expect((await post$("/api/guards", { rules: ["Bash(rm -rf *)", "not a rule!"] }, TOKEN, "PUT")).status).toBe(400);
    const put = await post$("/api/guards", { rules: [" Bash(rm -rf *) ", "Bash(rm -rf *)", "", "Bash(bun run redeploy:*)"] }, TOKEN, "PUT");
    expect(put.status).toBe(200);
    expect(guards).toEqual(["Bash(rm -rf *)", "Bash(bun run redeploy:*)"]);
  });

  test("a relist learns how an ask it missed ended, and drops one the broker forgot", async () => {
    const seen: ServerEvent[] = [];
    const hub = new AskHub(CFG, { broadcast: (e) => seen.push(e), deviceName: () => null, chan: new Chan(BROKER), relistEvery: 0, sweepEvery: 0 });
    asks.set("r1", ask({ id: "r1" }));
    asks.set("r2", ask({ id: "r2" }));
    await hub.relist();
    expect(hub.list().filter((a) => a.state === "open").map((a) => a.id)).toEqual(["r1", "r2"]);
    // both close with no event heard: one expired, one swept away
    asks.set("r1", { ...asks.get("r1")!, state: "expired" });
    asks.delete("r2");
    await hub.relist();
    expect(hub.list().find((a) => a.id === "r1")?.state).toBe("expired");
    expect(hub.list().some((a) => a.id === "r2")).toBe(false);
    const last = seen.at(-1) as Extract<ServerEvent, { type: "asks" }>;
    expect(last.asks.map((a) => a.id)).toEqual(["r1"]);
    expect(last.gone).toEqual(["r2"]);
  });

  test("an open ask whose read fails is kept; only the broker's 404 drops it", async () => {
    let list: Ask[] = [ask({ id: "k1" })];
    let failure: ChanError = new ChanError(502, "tailchan unreachable");
    const stub = {
      listAsks: async () => list,
      getAsk: async () => {
        throw failure;
      },
    } as unknown as Chan;
    const seen: ServerEvent[] = [];
    const hub = new AskHub(CFG, { broadcast: (e) => seen.push(e), deviceName: () => null, chan: stub, relistEvery: 0, sweepEvery: 0 });
    await hub.relist();
    expect(hub.list().map((a) => a.id)).toEqual(["k1"]);
    // missing from the list, and the broker did not answer its read: it may
    // still be open, so it stays rather than vanish from the inbox
    list = [];
    await hub.relist();
    expect(hub.list().map((a) => [a.id, a.state])).toEqual([["k1", "open"]]);
    expect(seen.some((e) => e.type === "asks" && e.gone?.includes("k1"))).toBe(false);
    // the broker says it has no such ask: gone
    failure = new ChanError(404, "tailchan: no such ask");
    await hub.relist();
    expect(hub.list()).toEqual([]);
    expect(seen.at(-1)).toEqual({ type: "asks", asks: [], gone: ["k1"] });
  });

  test("a remember is checked before the answer goes, and kept once the allow lands", async () => {
    const sent: unknown[] = [];
    const kept: [string, string | null][] = [];
    const stub = {
      listAsks: async () => [],
      getAsk: async (_: unknown, id: string) => ask({ id }),
      answerAsk: async (_: unknown, _key: string, id: string, body: AskAnswer & { by: string }) => {
        sent.push(body);
        return { ...ask({ id }), state: "answered", answer: { behavior: body.behavior } };
      },
    } as unknown as Chan;
    const hub = new AskHub(CFG, {
      broadcast: () => {},
      deviceName: () => "Mac",
      chan: stub,
      relistEvery: 0,
      sweepEvery: 0,
      remember: (_a, rule) => (rule === "Bash(ls)" ? { save: async (by) => void kept.push([rule, by]) } : { error: "not offered" }),
    });
    const answer = (body: unknown) =>
      hub.handle(
        new Request("http://x/api/asks/answer", { method: "POST", headers: { [ANSWER_KEY_HEADER]: "k" }, body: JSON.stringify(body) }),
        new URL("http://x/api/asks/answer"),
      );
    const refused = await answer({ id: "m1", behavior: "allow", remember: "Bash" });
    expect(refused?.status).toBe(400);
    expect(sent).toEqual([]);
    expect((await answer({ id: "m1", behavior: "allow", remember: "Bash(ls)" }))?.status).toBe(200);
    // the rule is canopy's own: the broker hears a plain allow
    expect(sent).toEqual([{ behavior: "allow", by: "Mac" }]);
    expect(kept).toEqual([["Bash(ls)", "Mac"]]);
  });

  test("a key holds when the broker takes its beat, and only then", async () => {
    const hub = new AskHub(CFG, { broadcast: () => {}, deviceName: () => null, chan: new Chan(BROKER), relistEvery: 0, sweepEvery: 0 });
    const req = (h: Record<string, string>) => new Request("http://x/api/runs/answer", { method: "POST", headers: h });
    expect(await hub.keyHolds(req({ [ANSWER_KEY_HEADER]: TOKEN }))).toBe(true);
    expect(await hub.keyHolds(req({ [ANSWER_KEY_HEADER]: "not-the-key" }))).toBe(false);
    expect(await hub.keyHolds(req({ [ANSWER_KEY_HEADER]: TOKEN, "sec-fetch-site": "cross-site" }))).toBe(false);
    expect(await hub.keyHolds(req({}))).toBe(false);
    expect(await new AskHub(null, { broadcast: () => {}, deviceName: () => null }).keyHolds(req({ [ANSWER_KEY_HEADER]: TOKEN }))).toBe(false);
  });

  test("without a broker every route is a 503", async () => {
    const hub = new AskHub(null, { broadcast: () => {}, deviceName: () => null });
    const res = await hub.handle(new Request("http://x/api/asks"), new URL("http://x/api/asks"));
    expect(res?.status).toBe(503);
    expect(await hub.handle(new Request("http://x/api/tree"), new URL("http://x/api/tree"))).toBeNull();
  });
});

describe("the pure parts", () => {
  test("a write's answer key: the header, from the page's own origin or no browser at all", () => {
    const req = (h: Record<string, string>) => new Request("http://x/api/asks/answer", { method: "POST", headers: h });
    expect(answerKeyOf(req({ [ANSWER_KEY_HEADER]: " k-1 " }))).toEqual({ key: "k-1" });
    expect(answerKeyOf(req({ [ANSWER_KEY_HEADER]: "k", "sec-fetch-site": "same-origin" }))).toEqual({ key: "k" });
    expect(answerKeyOf(req({ [ANSWER_KEY_HEADER]: "k", "sec-fetch-site": "cross-site" }))).toHaveProperty("error");
    expect(answerKeyOf(req({ [ANSWER_KEY_HEADER]: "k", "sec-fetch-site": "none" }))).toHaveProperty("error");
    expect(answerKeyOf(req({}))).toHaveProperty("error");
    expect(answerKeyOf(req({ [ANSWER_KEY_HEADER]: "two words" }))).toHaveProperty("error");
  });

  test("who answered, as the broker keeps it", () => {
    expect(answerer("Eric's Phone")).toBe("Erics-Phone");
    expect(answerer(null)).toBe("canopy");
    expect(answerer("   ")).toBe("canopy");
    expect(answerer("x".repeat(60))).toHaveLength(40);
  });

  test("an answer as the page posts it", () => {
    expect(parseAskAnswer({ id: "a1", behavior: "deny", message: "  not now ", client: "c" })).toEqual({ id: "a1", behavior: "deny", message: "not now", client: "c" });
    expect(parseAskAnswer({ id: "a1", behavior: "allow", answers: { "Which?": "A", n: 1 } })).toEqual({ id: "a1", behavior: "allow", answers: { "Which?": "A" }, client: null });
    expect(parseAskAnswer({ id: "a1", behavior: "allow", remember: "Bash(ls)" })).toEqual({ id: "a1", behavior: "allow", client: null, remember: "Bash(ls)" });
    // a deny keeps nothing
    expect(parseAskAnswer({ id: "a1", behavior: "deny", remember: "Bash(ls)" })).toEqual({ id: "a1", behavior: "deny", client: null });
    expect(parseAskAnswer({ id: "../x", behavior: "allow" })).toBeNull();
    expect(parseAskAnswer({ id: "a1", behavior: "allow", answers: ["A"] })).toBeNull();
  });
});

/* ---------- watched, and the transcript a hand-off names ---------- */

const TERM = "fedcba9876543210fedcba9876543210";

function shell(port: number, term: string): { ws: WebSocket; opened: Promise<void>; text: () => string } {
  const q = new URLSearchParams({ id: "app", term, place: "panel", cols: "80", rows: "24" });
  const ws = new WebSocket(`ws://127.0.0.1:${port}/api/term?${q}`);
  ws.binaryType = "arraybuffer";
  const out: string[] = [];
  const dec = new TextDecoder();
  ws.onmessage = (e: MessageEvent<ArrayBuffer | string>) => {
    if (typeof e.data !== "string") out.push(dec.decode(new Uint8Array(e.data)));
  };
  const opened = new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error("the socket failed"));
  });
  return { ws, opened, text: () => out.join("") };
}

const watched = async (term: string) => ((await (await fetch(api(`/api/terms/watched?term=${term}`))).json()) as { watched: boolean }).watched;

describe("a shell someone is at", () => {
  test("is watched only after a keystroke, not a terminal's own reply, and beats nothing itself", async () => {
    const before = beats;
    const s = shell(server.port, TERM);
    await s.opened;
    expect(await watched(TERM)).toBe(false);
    // a device-attributes reply and a focus event are the terminal, not a person
    s.ws.send(new TextEncoder().encode("\x1b[?1;2c\x1b[I"));
    await Bun.sleep(150);
    expect(await watched(TERM)).toBe(false);
    s.ws.send(new TextEncoder().encode("echo watched-here\n"));
    await until(() => s.text().includes("watched-here"), "the echo");
    expect(await watched(TERM)).toBe(true);
    // presence is the page's to beat, with its own key: canopy holds none
    await Bun.sleep(150);
    expect(beats).toBe(before);
    // an unknown shell is not watched, and not an error
    expect(await watched("0".repeat(32))).toBe(false);
    s.ws.close();
  }, 20_000);

  test("the transcript route finds the newest one for the agent named", async () => {
    // two Claude Code conversations filed under the repo's folder; the
    // newer one is the one a hand-off names
    const dir = join(scratch, "claude", "projects", projectFolder(appPath));
    await mkdir(dir, { recursive: true });
    const older = join(dir, "11111111-1111-4111-8111-111111111111.jsonl");
    const newer = join(dir, "22222222-2222-4222-8222-222222222222.jsonl");
    const line = JSON.stringify({ type: "user", message: { role: "user", content: "fix the build" } });
    await writeFile(older, `${line}\n`);
    await writeFile(newer, `${line}\n`);
    await utimes(older, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));
    // a codex rollout for the same folder, today
    const d = new Date();
    const day = join(scratch, "codex", "sessions", String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, "0"), String(d.getDate()).padStart(2, "0"));
    await mkdir(day, { recursive: true });
    const rollout = join(day, "rollout-2026-09-30T10-00-00-33333333-3333-4333-8333-333333333333.jsonl");
    await writeFile(
      rollout,
      `${JSON.stringify({ type: "session_meta", payload: { id: "33333333-3333-4333-8333-333333333333", cwd: appPath, source: "cli" } })}\n${JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: "hello" } })}\n`,
    );

    const s = shell(server.port, TERM);
    await s.opened;
    const read = async (q: string) => {
      const res = await fetch(api(`/api/terms/transcript?${q}`));
      return { status: res.status, body: (await res.json()) as { harness?: string; path?: string } };
    };
    expect(await read(`term=${TERM}&harness=claude`)).toEqual({ status: 200, body: { harness: "claude", path: newer } });
    expect(await read(`term=${TERM}&harness=codex`)).toEqual({ status: 200, body: { harness: "codex", path: rollout } });
    // a plain pty cannot say what runs in it, so it needs the page's word
    expect((await read(`term=${TERM}`)).status).toBe(404);
    expect((await read(`term=${"0".repeat(32)}&harness=claude`)).status).toBe(404);
    s.ws.close();
  });
});
