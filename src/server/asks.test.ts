/**
 * Asks for a human through canopy, against a stand-in broker: the open
 * asks listed and followed on the `asks` channel, an answer carrying the
 * answering browser's device name and the token, the same answer refused
 * (403) by a backend with no token, presence set and beaten, the guards
 * proxied and validated, a closed ask swept after its keep, a shell counted
 * watched only after a keystroke (not a terminal's own reply), and the
 * transcript route over fixture session files. Plain ptys (`CANOPY_TMUX=0`).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Chan } from "../core/chan";
import { projectFolder } from "../core/sessions";
import type { Ask, AsksInfo, GuardsInfo, Presence, ServerEvent } from "../core/types";
import { AskHub, answerer, parseAskAnswer } from "./asks";
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

/* ---------- canopy against it: one backend with the token, one without ---------- */

let scratch: string;
let root: string;
let appPath: string;
let withToken: { port: number; stop: () => void };
let readOnly: { port: number; stop: () => void };
const saved: Record<string, string | undefined> = {};
const events: ServerEvent[] = [];
const listening = new AbortController();
const CLIENT = "0123456789abcdef";

const api = (path: string, port = withToken.port) => `http://127.0.0.1:${port}${path}`;
const post$ = (path: string, body: unknown, port = withToken.port, method: "POST" | "PUT" = "POST") =>
  fetch(api(path, port), { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

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
  withToken = await startServer({ root, port: 0, chan: { ...CFG, token: TOKEN }, asks: { closedKeep: 400, sweepEvery: 100, beatEvery: 1_500 } });
  readOnly = await startServer({ root, port: 0, chan: CFG });
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
  // both backends' followers are on the stream before the tests post
  await until(() => [...streams].filter((s) => s.channels === "asks").length >= 2, "both followers");
});

afterAll(async () => {
  listening.abort();
  withToken.stop();
  readOnly.stop();
  broker.stop(true);
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  await rm(scratch, { recursive: true, force: true });
});

describe("asks through canopy", () => {
  test("the open asks, whether this backend can answer, and presence", async () => {
    const info = (await (await fetch(api("/api/asks"))).json()) as AsksInfo;
    expect(info.ready).toBe(true);
    expect(info.canAnswer).toBe(true);
    expect(info.asks.map((a) => a.id)).toEqual(["a1"]);
    expect(info.presence?.state).toBe("away");
    const ro = (await (await fetch(api("/api/asks", readOnly.port))).json()) as AsksInfo;
    expect(ro.canAnswer).toBe(false);
  });

  test("a new ask on the channel arrives as an asks event", async () => {
    post(ask({ id: "a2", kind: "question", tool: "AskUserQuestion", title: "question: which one?", questions: [{ question: "Which one?", header: "Pick", options: [{ label: "A", description: "" }], multiSelect: false }] }));
    await until(() => askEvents().some((e) => e.asks.some((a) => a.id === "a2")), "the a2 event");
    const got = askEvents().flatMap((e) => e.asks).find((a) => a.id === "a2");
    expect(got?.questions?.[0]?.options[0]?.label).toBe("A");
  });

  test("an answer carries the answering device's name and the token", async () => {
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

  test("a backend without a token cannot answer, set presence or edit guards", async () => {
    const n = answers.length;
    expect((await post$("/api/asks/answer", { id: "a2", behavior: "allow" }, readOnly.port)).status).toBe(403);
    expect((await post$("/api/presence", { away: true }, readOnly.port)).status).toBe(403);
    expect((await post$("/api/guards", { rules: [] }, readOnly.port, "PUT")).status).toBe(403);
    expect(((await (await fetch(api("/api/guards", readOnly.port))).json()) as GuardsInfo).canEdit).toBe(false);
    expect(answers.length).toBe(n);
    // a malformed answer is refused before the token is looked at
    expect((await post$("/api/asks/answer", { id: "a2", behavior: "maybe" }, readOnly.port)).status).toBe(400);
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
    expect((await post$("/api/guards", { rules: ["Bash(rm -rf *)", "not a rule!"] }, withToken.port, "PUT")).status).toBe(400);
    const put = await post$("/api/guards", { rules: [" Bash(rm -rf *) ", "Bash(rm -rf *)", "", "Bash(bun run redeploy:*)"] }, withToken.port, "PUT");
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

  test("without a broker every route is a 503", async () => {
    const hub = new AskHub(null, { broadcast: () => {}, deviceName: () => null });
    const res = await hub.handle(new Request("http://x/api/asks"), new URL("http://x/api/asks"));
    expect(res?.status).toBe(503);
    expect(await hub.handle(new Request("http://x/api/tree"), new URL("http://x/api/tree"))).toBeNull();
  });
});

describe("the pure parts", () => {
  test("who answered, as the broker keeps it", () => {
    expect(answerer("Eric's Phone")).toBe("Erics-Phone");
    expect(answerer(null)).toBe("canopy");
    expect(answerer("   ")).toBe("canopy");
    expect(answerer("x".repeat(60))).toHaveLength(40);
  });

  test("an answer as the page posts it", () => {
    expect(parseAskAnswer({ id: "a1", behavior: "deny", message: "  not now ", client: "c" })).toEqual({ id: "a1", behavior: "deny", message: "not now", client: "c" });
    expect(parseAskAnswer({ id: "a1", behavior: "allow", answers: { "Which?": "A", n: 1 } })).toEqual({ id: "a1", behavior: "allow", answers: { "Which?": "A" }, client: null });
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

const watched = async (term: string, port = withToken.port) =>
  ((await (await fetch(api(`/api/terms/watched?term=${term}`, port))).json()) as { watched: boolean }).watched;

describe("a shell someone is at", () => {
  test("is watched only after a keystroke, not a terminal's own reply", async () => {
    const s = shell(withToken.port, TERM);
    await s.opened;
    expect(await watched(TERM)).toBe(false);
    // a device-attributes reply and a focus event are the terminal, not a person
    s.ws.send(new TextEncoder().encode("\x1b[?1;2c\x1b[I"));
    await Bun.sleep(150);
    expect(await watched(TERM)).toBe(false);
    s.ws.send(new TextEncoder().encode("echo watched-here\n"));
    await until(() => s.text().includes("watched-here"), "the echo");
    expect(await watched(TERM)).toBe(true);
    // Presence: a keystroke a beat's interval after the last beat (clearing
    // away above was one, the echo may have been another) beats, and a
    // second keystroke right after it does not.
    await Bun.sleep(1_600);
    const before = beats;
    s.ws.send(new TextEncoder().encode(" "));
    await until(() => beats === before + 1, "a presence beat");
    s.ws.send(new TextEncoder().encode("true\n"));
    await Bun.sleep(150);
    expect(beats).toBe(before + 1);
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

    const s = shell(withToken.port, TERM);
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
