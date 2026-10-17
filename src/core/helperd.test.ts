/**
 * The helper daemon's keepalive, against two peers: a websocket server that
 * answers (the helper stays put across several ping rounds, since the pong
 * the layer sends back is what keeps the deadline fresh), and one that takes
 * the handshake and then goes silent, the shape of a backend whose host
 * reboots. The silent peer sends no close frame, so nothing but the ping
 * would ever tell the helper it is alone; it must give up and dial again.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CallerBook } from "../server/callers";
import { startServer } from "../server/index";
import { helperUrl, runHelper } from "./helperd";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const accept = (key: string): string => createHash("sha1").update(key + GUID).digest("base64");

/** a peer that completes the websocket handshake and then never writes
 *  again: every frame it is sent, pings included, goes nowhere */
function silentPeer(): { port: number; handshakes: number; stop: () => void } {
  const seen = { n: 0 };
  const server = Bun.listen<{ buf: string }>({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      open(socket) {
        socket.data = { buf: "" };
      },
      data(socket, chunk) {
        if (socket.data.buf === "done") return;
        socket.data.buf += chunk.toString("latin1");
        if (!socket.data.buf.includes("\r\n\r\n")) return;
        const key = /sec-websocket-key:\s*(\S+)/i.exec(socket.data.buf)?.[1];
        socket.data.buf = "done";
        if (!key) {
          socket.end();
          return;
        }
        seen.n += 1;
        socket.write(
          ["HTTP/1.1 101 Switching Protocols", "Upgrade: websocket", "Connection: Upgrade", `Sec-WebSocket-Accept: ${accept(key)}`, "", ""].join("\r\n"),
        );
      },
    },
  });
  return {
    port: server.port,
    get handshakes() {
      return seen.n;
    },
    stop: () => server.stop(true),
  };
}

async function until(pred: () => boolean, what: string, ms = 8_000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error(`gave up waiting for ${what}`);
    await Bun.sleep(10);
  }
}

const stops: Array<() => void> = [];
afterEach(() => {
  while (stops.length) stops.pop()?.();
});

describe("a helper on a backend that answers", () => {
  test("stays registered across ping rounds", async () => {
    let upgrades = 0;
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req, srv) {
        upgrades += 1;
        return srv.upgrade(req) ? undefined : new Response("no");
      },
      websocket: { message() {} },
    });
    stops.push(() => server.stop(true));
    const lines: string[] = [];
    const helper = runHelper({ backend: `http://127.0.0.1:${server.port}`, name: "mbp", openers: [], ping: 20, dead: 60, log: (l) => lines.push(l), run: async () => {} });
    stops.push(helper.stop);

    await until(() => helper.connected, "the helper to register");
    // several rounds of ping and pong, well past the deadline
    await Bun.sleep(300);
    expect(helper.connected).toBe(true);
    expect(upgrades).toBe(1);
    expect(lines.filter((l) => l.startsWith("registered"))).toHaveLength(1);
  });
});

describe("a helper on a backend that went with its host", () => {
  test("a request completed after reconnect cannot acknowledge the new socket's request", async () => {
    let connections = 0;
    let first: { close: (code?: number, reason?: string) => unknown } | undefined;
    const replies: Array<{ connection: number; body: unknown }> = [];
    const pending: Array<() => void> = [];
    const logs: string[] = [];
    const server = Bun.serve<{ connection: number }>({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req, srv) {
        return srv.upgrade(req, { data: { connection: ++connections } }) ? undefined : new Response("no");
      },
      websocket: {
        open(sock) {
          if (sock.data.connection === 1) first = sock;
          sock.send(JSON.stringify({ id: 1, open: { app: "finder", path: "/tmp" } }));
        },
        message(sock, body) {
          replies.push({ connection: sock.data.connection, body: JSON.parse(String(body)) });
        },
      },
    });
    stops.push(() => server.stop(true));
    const helper = runHelper({
      backend: `http://127.0.0.1:${server.port}`, name: "test", openers: ["finder"],
      log: (line) => logs.push(line),
      run: () => new Promise<void>((resolve) => pending.push(resolve)),
    });
    stops.push(helper.stop);
    await until(() => pending.length === 1, "the first request");
    first!.close(1001, "reconnect");
    await until(() => pending.length === 2, "the new request with the reused id");
    pending[0]!();
    await until(() => logs.some((line) => line.startsWith("opened ")), "the old action to complete");
    await Bun.sleep(30);
    expect(replies).toEqual([]);
    pending[1]!();
    await until(() => replies.length > 0, "the current request's reply");
    expect(replies).toEqual([{ connection: 2, body: { id: 1, ok: true } }]);
  });

  test("gives up on the silent socket and dials again", async () => {
    const peer = silentPeer();
    stops.push(peer.stop);
    const lines: string[] = [];
    const helper = runHelper({ backend: `http://127.0.0.1:${peer.port}`, name: "mbp", openers: [], ping: 20, dead: 60, log: (l) => lines.push(l), run: async () => {} });
    stops.push(helper.stop);

    await until(() => helper.connected, "the helper to register");
    await until(() => !helper.connected, "the helper to give up on a silent backend");
    // it had registered, so this is the backend going quiet under it, not a
    // handshake that never landed
    expect(lines.some((l) => l.startsWith("lost the backend: it stopped answering"))).toBe(true);
    await until(() => peer.handshakes > 1, "the helper to dial again");
  });
});

describe("a helper with a token", () => {
  test("fetches a fresh ticket for every dial and adds it to the url", async () => {
    const tickets: Array<string | null> = [];
    const asked: Array<string | null> = [];
    let issued = 0;
    let first: { close: (code?: number, reason?: string) => unknown } | undefined;
    const server = Bun.serve<{ n: number }>({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(req, srv) {
        const u = new URL(req.url);
        if (u.pathname === "/api/auth/ticket") {
          asked.push(req.headers.get("x-canopy-token"));
          expect(await req.json()).toEqual({ for: "helper" });
          issued += 1;
          return Response.json({ ticket: `t${issued}` });
        }
        tickets.push(u.searchParams.get("ticket"));
        return srv.upgrade(req, { data: { n: tickets.length } }) ? undefined : new Response("no");
      },
      websocket: {
        open(ws) {
          if (ws.data.n === 1) first = ws;
        },
        message() {},
      },
    });
    stops.push(() => server.stop(true));
    const helper = runHelper({ backend: `http://127.0.0.1:${server.port}`, name: "mbp", openers: [], token: () => "cnp_helper_x", log: () => {}, run: async () => {} });
    stops.push(helper.stop);
    await until(() => helper.connected, "the first registration");
    first?.close(1001, "again");
    await until(() => tickets.length === 2, "the second dial");
    expect(tickets).toEqual(["t1", "t2"]);
    expect(asked).toEqual(["cnp_helper_x", "cnp_helper_x"]);
  });

  test("no token means no ticket request", async () => {
    let posts = 0;
    let ticket: string | null = "unset";
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req, srv) {
        if (req.method === "POST") posts += 1;
        ticket = new URL(req.url).searchParams.get("ticket");
        return srv.upgrade(req) ? undefined : new Response("no");
      },
      websocket: { message() {} },
    });
    stops.push(() => server.stop(true));
    const helper = runHelper({ backend: `http://127.0.0.1:${server.port}`, name: "mbp", openers: [], token: () => null, log: () => {}, run: async () => {} });
    stops.push(helper.stop);
    await until(() => helper.connected, "the registration");
    expect(posts).toBe(0);
    expect(ticket).toBeNull();
  });

  test("against an enforce server a ticket opens the socket once", async () => {
    const saved = { dir: process.env["CANOPY_CONFIG_DIR"], calls: process.env["CANOPY_CALLERS"], tmux: process.env["CANOPY_TMUX"] };
    const dir = await mkdtemp(join(tmpdir(), "canopy-helperd-"));
    process.env["CANOPY_CONFIG_DIR"] = dir;
    process.env["CANOPY_CALLERS"] = "enforce";
    process.env["CANOPY_TMUX"] = "0";
    try {
      const book = new CallerBook({ file: join(dir, "callers.json") });
      const token = book.mint("helper", { label: "helper test" }).token;
      await book.flush();
      const s = await startServer({ root: dir, port: 0, callersLog: () => {} });
      try {
        const base = `http://127.0.0.1:${s.port}`;
        const ticket = async (): Promise<string> => {
          const r = await fetch(`${base}/api/auth/ticket`, { method: "POST", headers: { "content-type": "application/json", "x-canopy-token": token }, body: JSON.stringify({ for: "helper" }) });
          return ((await r.json()) as { ticket: string }).ticket;
        };
        const a = await ticket();
        const b = await ticket();
        expect(a).not.toBe(b);
        const url = helperUrl(base, "mbp", "linux", []);
        const opens = (t: string) =>
          new Promise<boolean>((resolve) => {
            const ws = new WebSocket(`${url}&ticket=${t}`);
            ws.onopen = () => (ws.close(), resolve(true));
            ws.onerror = () => resolve(false);
          });
        expect(await opens(a)).toBe(true);
        expect(await opens(a)).toBe(false);
        expect(await opens(b)).toBe(true);
      } finally {
        await s.stop();
      }
    } finally {
      for (const [k, v] of [["CANOPY_CONFIG_DIR", saved.dir], ["CANOPY_CALLERS", saved.calls], ["CANOPY_TMUX", saved.tmux]] as const) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      await rm(dir, { recursive: true, force: true });
    }
  });
});
