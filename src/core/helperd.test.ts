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
import { runHelper } from "./helperd";

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
