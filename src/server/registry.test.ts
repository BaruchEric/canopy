/**
 * The agent registry through canopy, against a stand-in broker: the cards
 * listed at start, a change on the `agents` channel arriving as a
 * `registry` event, a stale one passed over, a swept card dropped on a
 * re-list, the 503 with no broker, the scan posted as canopy's bot with
 * each agent's repo and branch, and a new shell knowing where it runs.
 * Plain ptys (`CANOPY_TMUX=0`).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentProc } from "../core/agentscan";
import { selfName } from "../core/backends";
import { Chan } from "../core/chan";
import type { AgentCard, RegistryInfo, ScanBody, ServerEvent } from "../core/types";
import { startServer } from "./index";
import { RegistryHub } from "./registry";

/* ---------- the stand-in broker: the registry's routes, in memory ---------- */

const card = (over: Partial<AgentCard>): AgentCard => ({
  id: "claude:s1",
  handle: "app-0123",
  node: "macmini-2018",
  harness: "claude",
  session: "s1",
  origin: "canopy-shell",
  cwd: "/dev/app",
  repo: "https://github.com/me/app",
  branch: "main",
  model: "opus",
  mode: "default",
  state: "idle",
  waiting: null,
  caps: ["os:linux"],
  offers: [],
  notifyIdle: false,
  where: { os: "linux", container: true, pid: 41, term: null, canopy: { backend: "mini", term: "0123" } },
  transcript: null,
  startedAt: 1_000,
  seenAt: 2_000,
  endedAt: null,
  ...over,
});

const cards = new Map<string, AgentCard>();
const scans: { as: string; body: ScanBody }[] = [];
const streams = new Set<{ as: string; channels: string | null; send: (data: string) => void }>();
let msgId = 0;

/** a card change as the broker posts it: a silent event on #agents */
function post(c: AgentCard): void {
  cards.set(c.id, c);
  const m = { id: ++msgId, channel: "agents", handle: "tailchan", node: "tailchan", kind: "event", body: JSON.stringify({ type: "agent", card: c }), meta: { silent: true }, ts: Date.now() };
  for (const s of streams) if (s.channels?.split(",").includes("agents")) s.send(`id: ${m.id}\nevent: message\ndata: ${JSON.stringify(m)}\n\n`);
}

const broker = Bun.serve({
  port: 0,
  idleTimeout: 0,
  async fetch(req) {
    const url = new URL(req.url);
    const as = req.headers.get("x-tailchan-as") ?? "anon";
    const p = url.pathname;
    if (p === "/v1/agents" && req.method === "GET") {
      const state = url.searchParams.get("state") ?? "live";
      const all = [...cards.values()].filter((c) => state === "all" || ["working", "idle", "waiting"].includes(c.state));
      return Response.json(all.sort((a, b) => b.seenAt - a.seenAt));
    }
    // the open asks, which the asks hub follows (asks.test.ts has the rest)
    if (p === "/v1/asks") return Response.json([]);
    if (p === "/v1/agents/scan" && req.method === "POST") {
      const body = (await req.json()) as ScanBody;
      scans.push({ as, body });
      return Response.json({ cards: body.procs.length, ended: 0 });
    }
    if (p === "/v1/stream") {
      const enc = new TextEncoder();
      let entry: { as: string; channels: string | null; send: (data: string) => void } | null = null;
      const body = new ReadableStream<Uint8Array>({
        start(ctrl) {
          ctrl.enqueue(enc.encode(`event: ready\ndata: {}\n\n`));
          entry = { as, channels: url.searchParams.get("channels"), send: (d) => ctrl.enqueue(enc.encode(d)) };
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

/* ---------- canopy against it ---------- */

let scratch: string;
let root: string;
let server: { port: number; stop: () => void };
const saved: Record<string, string | undefined> = {};
const api = (path: string) => `http://127.0.0.1:${server.port}${path}`;
const events: ServerEvent[] = [];
const listening = new AbortController();
const lister: () => Promise<AgentProc[]> = async () => [
  { pid: 41, ppid: 40, harness: "claude", cwd: join(root, "app", "src"), startedAt: 5 },
  { pid: 50, ppid: 40, harness: "codex", cwd: "/elsewhere", startedAt: 6 },
];

async function until(pred: () => boolean | Promise<boolean>, what: string, ms = 10_000): Promise<void> {
  const start = Date.now();
  while (!(await pred())) {
    if (Date.now() - start > ms) throw new Error(`gave up waiting for ${what}`);
    await Bun.sleep(25);
  }
}

const registryEvents = () => events.filter((e): e is Extract<ServerEvent, { type: "registry" }> => e.type === "registry");

beforeAll(async () => {
  scratch = await realpath(await mkdtemp(join(tmpdir(), "canopy-registry-")));
  for (const k of ["CANOPY_CONFIG_DIR", "CANOPY_TMUX"]) saved[k] = process.env[k];
  process.env["CANOPY_CONFIG_DIR"] = join(scratch, "config");
  process.env["CANOPY_TMUX"] = "0";
  root = join(scratch, "root");
  const app = join(root, "app");
  await Bun.$`mkdir -p ${join(app, "src")} && git -C ${app} init -q -b main && git -C ${app} remote add origin git@github.com:me/app.git && git -C ${app} -c user.name=t -c user.email=t@t commit -q --allow-empty -m init`.quiet();
  cards.set("claude:s1", card({}));
  cards.set("codex:old", card({ id: "codex:old", harness: "codex", state: "ended", endedAt: 1_500, seenAt: 1_500 }));
  server = await startServer({ root, port: 0, chan: CFG, registry: { scanEvery: 100, relistEvery: 0, lister, container: true } });
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
  await until(() => [...streams].some((s) => s.as === "canopy" && s.channels === "agents"), "the registry's stream to the broker");
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

describe("the follow", () => {
  test("every card the broker holds, live and ended, newest beat first", async () => {
    const res = await fetch(api("/api/registry"));
    expect(res.status).toBe(200);
    const info = (await res.json()) as RegistryInfo;
    expect(info.ready).toBe(true);
    expect(info.cards.map((c) => [c.id, c.state])).toEqual([
      ["claude:s1", "idle"],
      ["codex:old", "ended"],
    ]);
  });

  test("a card change on #agents is a registry event, and the list follows", async () => {
    post(card({ state: "waiting", waiting: "your turn", seenAt: 3_000 }));
    await until(() => registryEvents().some((e) => e.cards.some((c) => c.state === "waiting")), "the registry event");
    const info = (await (await fetch(api("/api/registry"))).json()) as RegistryInfo;
    expect(info.cards.find((c) => c.id === "claude:s1")).toMatchObject({ state: "waiting", waiting: "your turn" });
  });

  test("a new card arrives whole", async () => {
    post(card({ id: "codex:t2", harness: "codex", handle: "web-9f9f", seenAt: 4_000 }));
    await until(() => registryEvents().some((e) => e.cards.some((c) => c.id === "codex:t2")), "the new card");
    const ev = registryEvents().find((e) => e.cards.some((c) => c.id === "codex:t2"));
    expect(ev?.cards[0]).toEqual(card({ id: "codex:t2", harness: "codex", handle: "web-9f9f", seenAt: 4_000 }));
  });
});

describe("the hub on its own", () => {
  test("a lagging event is passed over, a re-list drops what the broker swept and says only what changed", async () => {
    const out: ServerEvent[] = [];
    const hub = new RegistryHub(CFG, { broadcast: (ev) => out.push(ev), repos: () => [], chan: new Chan(BROKER), scanEvery: 0, relistEvery: 0 });
    await hub.relist();
    expect(hub.list().map((c) => c.id).sort()).toEqual(["claude:s1", "codex:old", "codex:t2"]);
    out.length = 0;
    // an event older than what the list said is not news
    hub["onMessage"]({ id: 1, channel: "agents", handle: "tailchan", node: "tailchan", kind: "event", body: JSON.stringify({ type: "agent", card: card({ state: "working", seenAt: 1 }) }), meta: {}, ts: 0 });
    expect(out).toEqual([]);
    expect(hub.list().find((c) => c.id === "claude:s1")?.state).toBe("waiting");
    // a beat moves only seenAt: held, not broadcast; a sweep is a gone id
    cards.set("claude:s1", { ...cards.get("claude:s1")!, seenAt: 9_000 });
    cards.delete("codex:old");
    await hub.relist();
    expect(out).toEqual([{ type: "registry", cards: [], gone: ["codex:old"] }]);
    expect(hub.list()[0]?.seenAt).toBe(9_000);
    hub.close();
  });

  test("no broker: no cards, and the route says why", async () => {
    const other = await startServer({ root, port: 0, chan: null });
    try {
      const res = await fetch(`http://127.0.0.1:${other.port}/api/registry`);
      expect(res.status).toBe(503);
      expect(((await res.json()) as { error: string }).error).toContain("tailchan");
    } finally {
      other.stop();
    }
  });
});

describe("the scan", () => {
  test("posted as canopy's bot: each agent, its repo and branch when its folder is in one", async () => {
    await until(() => scans.length > 0, "a scan");
    const { as, body } = scans[0]!;
    expect(as).toBe("canopy");
    expect(body).toEqual({
      container: true,
      os: process.platform,
      procs: [
        { pid: 41, harness: "claude", cwd: join(root, "app", "src"), startedAt: 5, repo: "https://github.com/me/app", branch: "main" },
        { pid: 50, harness: "codex", cwd: "/elsewhere", startedAt: 6 },
      ],
    });
    // and again on the timer
    await until(() => scans.length > 1, "the next scan");
  });
});

describe("shells", () => {
  test("a new shell knows where it runs: its id, the backend, the repo and the API", async () => {
    const id = "fedcba9876543210fedcba9876543210";
    const q = new URLSearchParams({ id: "app", term: id, place: "strip", cols: "200", rows: "24" });
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/api/term?${q}`);
    ws.binaryType = "arraybuffer";
    let out = "";
    ws.onmessage = (e) => {
      if (e.data instanceof ArrayBuffer) out += new TextDecoder().decode(e.data);
    };
    await new Promise<void>((r) => (ws.onopen = () => r()));
    ws.send(new TextEncoder().encode('echo "at=$CANOPY_TERM|$CANOPY_BACKEND|$CANOPY_REPO|$CANOPY_API|$TAILCHAN_AS"\r'));
    const want = `at=${id}|${selfName(null, hostname())}|app|http://127.0.0.1:${server.port}|app-fedc`;
    await until(() => out.includes(want), "the env in the shell", 15_000);
    ws.close();
    await fetch(api(`/api/terms?term=${id}`), { method: "DELETE" });
  });
});
