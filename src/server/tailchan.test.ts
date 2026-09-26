/**
 * tailchan through canopy, against a stand-in broker: the routes, the
 * stream's messages arriving as `chan` events, what the UI sends coming
 * back to every browser, a file put and read back, the notify switch, the
 * posts canopy makes about a run, and a new shell's handle in its
 * environment. Plain ptys (`CANOPY_TMUX=0`).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Chan, chanConfig, parseEnvFile } from "../core/chan";
import type { ChanMessage, Run, ServerEvent, TailchanInfo, TermInfo } from "../core/types";
import { startServer } from "./index";
import { ChanHub } from "./tailchan";

/* ---------- the stand-in broker: the calls canopy makes, in memory ---------- */

interface Posted extends ChanMessage {}
const posts: Posted[] = [];
const subs: { handle: string; channel: string }[] = [];
const blobs = new Map<string, { data: Uint8Array; type: string; name: string }>();
const streams = new Set<{ handle: string; send: (m: Posted) => void }>();

const dm = (a: string, b: string) => `dm.${[a, b].sort().join("+")}`;

const broker = Bun.serve({
  port: 0,
  idleTimeout: 0,
  async fetch(req) {
    const url = new URL(req.url);
    const as = req.headers.get("x-tailchan-as") ?? "anon";
    const p = url.pathname;
    if (p === "/v1/who") return Response.json([{ handle: "claude-abc123", node: "macmini-2018", last_seen: 1, live: true }]);
    if (p === "/v1/channels") return Response.json([{ name: "canopy", topic: "", private: false, members: [], count: 0, last_ts: null, expires_at: null, subscribed: true }]);
    if (p === "/v1/subs" && req.method === "POST") {
      subs.push({ handle: as, channel: ((await req.json()) as { channel: string }).channel });
      return Response.json([]);
    }
    if (p === "/v1/messages" && req.method === "POST") {
      const b = (await req.json()) as { channel?: string; to?: string; kind: string; body: string; meta: Record<string, unknown> };
      const m: Posted = { id: posts.length + 1, channel: b.to ? dm(as, b.to) : b.channel!, handle: as, node: "erics-macbook-pro", kind: b.kind, body: b.body, meta: b.meta ?? {}, ts: Date.now() };
      posts.push(m);
      for (const s of streams) if (s.handle !== as) s.send(m);
      return Response.json(m, { status: 201 });
    }
    if (p === "/v1/messages" && req.method === "GET") {
      const to = url.searchParams.get("to");
      const ch = to ? dm(as, to) : url.searchParams.get("channel");
      return Response.json(posts.filter((m) => m.channel === ch).slice(-Number(url.searchParams.get("limit") ?? 20)));
    }
    if (p === "/v1/blobs" && req.method === "PUT") {
      const id = "ab".repeat(16);
      blobs.set(id, { data: new Uint8Array(await req.arrayBuffer()), type: req.headers.get("content-type") ?? "", name: req.headers.get("x-filename") ?? id });
      const b = blobs.get(id)!;
      return Response.json({ id, name: b.name, mime: b.type, size: b.data.byteLength }, { status: 201 });
    }
    if (p.startsWith("/v1/blobs/")) {
      const b = blobs.get(p.slice(10));
      if (!b) return Response.json({ error: "no such blob" }, { status: 404 });
      return new Response(b.data, { headers: { "content-type": b.type, "content-disposition": `attachment; filename="${b.name}"` } });
    }
    if (p === "/v1/stream") {
      const enc = new TextEncoder();
      let entry: { handle: string; send: (m: Posted) => void } | null = null;
      const body = new ReadableStream<Uint8Array>({
        start(ctrl) {
          ctrl.enqueue(enc.encode(`event: ready\ndata: {}\n\n`));
          entry = { handle: as, send: (m) => ctrl.enqueue(enc.encode(`id: ${m.id}\nevent: message\ndata: ${JSON.stringify(m)}\n\n`)) };
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

/* ---------- canopy against it ---------- */

let scratch: string;
let server: { port: number; stop: () => void };
const saved: Record<string, string | undefined> = {};
const api = (path: string) => `http://127.0.0.1:${server.port}${path}`;
const events: ServerEvent[] = [];
const listening = new AbortController();

async function until(pred: () => boolean | Promise<boolean>, what: string, ms = 10_000): Promise<void> {
  const start = Date.now();
  while (!(await pred())) {
    if (Date.now() - start > ms) throw new Error(`gave up waiting for ${what}`);
    await Bun.sleep(25);
  }
}

const chans = () => events.filter((e): e is Extract<ServerEvent, { type: "chan" }> => e.type === "chan").map((e) => e.message);

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "canopy-tailchan-"));
  for (const k of ["CANOPY_CONFIG_DIR", "CANOPY_TMUX"]) saved[k] = process.env[k];
  process.env["CANOPY_CONFIG_DIR"] = join(scratch, "config");
  process.env["CANOPY_TMUX"] = "0";
  const root = join(scratch, "root");
  await Bun.$`mkdir -p ${join(root, "app")} && git -C ${join(root, "app")} init -q`.quiet();
  server = await startServer({ root, port: 0, chan: { url: BROKER, as: "eric", bot: "canopy", channel: "canopy" } });
  void (async () => {
    const res = await fetch(api("/api/events"), { signal: listening.signal });
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
  await until(() => [...streams].some((s) => s.handle === "eric"), "canopy's stream to the broker");
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

describe("config", () => {
  test("the env wins over the CLI's file, which fills in what the env lacks", () => {
    const file = parseEnvFile('TAILCHAN_URL="http://100.1.2.3:7855/"\nTAILCHAN_HUMAN=eric\n# note\n');
    expect(chanConfig({}, file)).toEqual({ url: "http://100.1.2.3:7855", as: "eric", bot: "canopy", channel: "canopy" });
    expect(chanConfig({ CANOPY_TAILCHAN_URL: "http://x:1", CANOPY_TAILCHAN_AS: "Me" }, file)?.url).toBe("http://x:1");
    expect(chanConfig({ CANOPY_TAILCHAN_AS: "Me" }, file)?.as).toBe("me");
    expect(chanConfig({}, {})).toBeNull();
    expect(chanConfig({ TAILCHAN_URL: "not a url" }, {})).toBeNull();
  });
});

describe("routes", () => {
  test("the info; the UI's handle joins canopy's channel only once notify is on", async () => {
    const info = (await (await fetch(api("/api/tailchan"))).json()) as TailchanInfo;
    expect(info).toMatchObject({ ready: true, as: "eric", bot: "canopy", channel: "canopy", notify: false });
    if (!info.ready) throw new Error("not ready");
    expect(info.who[0]?.handle).toBe("claude-abc123");
    expect(subs.some((s) => s.handle === "eric")).toBe(false);
    await fetch(api("/api/tailchan/notify"), { method: "POST", body: JSON.stringify({ on: true }) });
    await until(() => subs.some((s) => s.handle === "eric" && s.channel === "canopy"), "the subscription");
    await fetch(api("/api/tailchan/notify"), { method: "POST", body: JSON.stringify({ on: false }) });
  });

  test("a post by canopy's own handle reaches the browsers once, off the stream", async () => {
    const m = await new Chan(BROKER).send("canopy", { channel: "canopy" }, "text", "app: commit done");
    await until(() => chans().some((c) => c.id === m.id), "the post");
    await Bun.sleep(150);
    expect(chans().filter((c) => c.id === m.id)).toHaveLength(1);
  });

  test("a post the UI's handle hears arrives as a chan event", async () => {
    await new Chan(BROKER).send("claude-abc123", { to: "eric" }, "text", "the build is green");
    await until(() => chans().some((m) => m.body === "the build is green"), "the chan event");
    expect(chans().find((m) => m.body === "the build is green")?.channel).toBe("dm.claude-abc123+eric");
  });

  test("what the UI sends goes to the broker as its handle and back out to every browser", async () => {
    const res = await fetch(api("/api/tailchan/send"), { method: "POST", body: JSON.stringify({ target: "@claude-abc123", body: "thanks" }) });
    expect(res.status).toBe(201);
    expect(posts.at(-1)).toMatchObject({ handle: "eric", channel: "dm.claude-abc123+eric", kind: "text", body: "thanks" });
    await until(() => chans().some((m) => m.body === "thanks"), "the echo");
    const read = (await (await fetch(api("/api/tailchan/read?target=%40claude-abc123&n=10"))).json()) as ChanMessage[];
    expect(read.map((m) => m.body)).toEqual(["the build is green", "thanks"]);
  });

  test("bad input is a 400", async () => {
    expect((await fetch(api("/api/tailchan/send"), { method: "POST", body: JSON.stringify({ target: "dm.a+b", body: "x" }) })).status).toBe(400);
    expect((await fetch(api("/api/tailchan/send"), { method: "POST", body: JSON.stringify({ target: "#x", body: " " }) })).status).toBe(400);
    expect((await fetch(api("/api/tailchan/blob?id=../x"))).status).toBe(400);
  });

  test("a file is a blob plus an object message, and reads back", async () => {
    const res = await fetch(api("/api/tailchan/put?target=%23drop&name=note.txt&note=hello"), { method: "POST", headers: { "content-type": "text/plain" }, body: "file body" });
    expect(res.status).toBe(201);
    const m = (await res.json()) as ChanMessage;
    expect(m).toMatchObject({ kind: "object", body: "hello", channel: "drop", meta: { name: "note.txt", mime: "text/plain", size: 9 } });
    const blob = await fetch(api(`/api/tailchan/blob?id=${String(m.meta.blob)}`));
    expect(await blob.text()).toBe("file body");
    expect(blob.headers.get("content-disposition")).toContain("note.txt");
  });

  test("the notify switch persists", async () => {
    await fetch(api("/api/tailchan/notify"), { method: "POST", body: JSON.stringify({ on: true }) });
    const info = (await (await fetch(api("/api/tailchan"))).json()) as TailchanInfo;
    expect(info.ready && info.notify).toBe(true);
    await fetch(api("/api/tailchan/notify"), { method: "POST", body: JSON.stringify({ on: false }) });
  });
});

describe("shells", () => {
  test("a new shell runs under its handle", async () => {
    const id = "0123456789abcdef0123456789abcdef";
    const q = new URLSearchParams({ id: "app", term: id, place: "strip", cols: "80", rows: "24" });
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/api/term?${q}`);
    ws.binaryType = "arraybuffer";
    let out = "";
    ws.onmessage = (e) => {
      if (e.data instanceof ArrayBuffer) out += new TextDecoder().decode(e.data);
    };
    await new Promise<void>((r) => (ws.onopen = () => r()));
    ws.send(new TextEncoder().encode("echo handle=$TAILCHAN_AS\r"));
    await until(() => out.includes("handle=app-0123"), "the handle in the shell", 15_000);
    const terms = (await (await fetch(api("/api/terms"))).json()) as TermInfo[];
    expect(terms.find((t) => t.id === id)?.handle).toBe("app-0123");
    ws.close();
    await fetch(api(`/api/terms?term=${id}`), { method: "DELETE" });
  });
});

describe("notices", () => {
  test("a run waiting is a DM to the human, its end a silent channel line, each once", async () => {
    await fetch(api("/api/tailchan/notify"), { method: "POST", body: JSON.stringify({ on: true }) });
    const out: ServerEvent[] = [];
    const hub = new ChanHub({ url: BROKER, as: "eric", bot: "canopy", channel: "canopy" }, {
      broadcast: (ev) => out.push(ev),
      repoName: () => "app",
      isFlowRun: (id) => id === "flowstep",
    });
    await hub.start();
    const base: Run = { id: "r1", repoId: "app", action: "commit", verb: "commit", progress: "", expectsChange: true, chat: false, note: "", status: "working", startedAt: 0, steps: [], prompt: null };
    const before = posts.length;
    hub.onRun(base);
    hub.onRun({ ...base, status: "waiting", prompt: { id: "p", kind: "question", questions: [] } });
    hub.onRun({ ...base, status: "waiting", prompt: { id: "p", kind: "question", questions: [] } });
    hub.onRun({ ...base, status: "done", outcome: "changed" });
    hub.onRun({ ...base, id: "flowstep", status: "done" });
    await until(() => posts.length >= before + 2, "two posts");
    await Bun.sleep(100);
    expect(posts.slice(before).map((m) => [m.handle, m.channel, m.body, m.meta.silent ?? false])).toEqual([
      ["canopy", "dm.canopy+eric", "app: commit has a question", false],
      ["canopy", "canopy", "app: commit done, changed", true],
    ]);
    // the hub's stream hears each from the broker, and the hub adds no copy
    const ids = out.flatMap((e) => (e.type === "chan" ? [e.message.id] : []));
    expect(ids.sort()).toEqual(posts.slice(before).map((m) => m.id).sort());
    hub.close();
    await fetch(api("/api/tailchan/notify"), { method: "POST", body: JSON.stringify({ on: false }) });
  });
});
