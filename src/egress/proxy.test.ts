/**
 * The egress proxy over real sockets on loopback: an echo server stands in
 * for api.anthropic.com, the resolver and the dial are the test's, so
 * nothing leaves the machine and the production address rule
 * (isPublicV4) is left in place wherever a test does not say otherwise.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { connect, createServer, type Server, type Socket } from "node:net";
import { startEgressProxy, type EgressOptions } from "./proxy";

const stops: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const s of stops.splice(0).reverse()) await s();
});

/** an echo server on loopback: what it reads it writes back */
async function echo(): Promise<{ port: number; seen: () => number }> {
  let n = 0;
  const live = new Set<Socket>();
  const server: Server = createServer((s) => {
    n++;
    live.add(s);
    s.on("close", () => live.delete(s));
    s.on("data", (d) => s.write(d));
    s.on("error", () => {});
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  if (addr === null || typeof addr === "string") throw new Error("no port");
  stops.push(
    () =>
      new Promise<void>((r) => {
        for (const s of live) s.destroy();
        server.close(() => r());
      }),
  );
  return { port: addr.port, seen: () => n };
}

async function proxy(opts: Partial<EgressOptions> = {}): Promise<{ port: number; logs: string[]; tunnels: () => number }> {
  const logs: string[] = [];
  const p = await startEgressProxy({ host: "127.0.0.1", port: 0, log: (l) => logs.push(l), ...opts });
  stops.push(p.stop);
  return { port: p.port, logs, tunnels: p.tunnels };
}

/** a client: what it has read so far, and when the far end closed */
function client(port: number): { sock: Socket; got: () => string; closed: Promise<void>; until: (re: RegExp, ms?: number) => Promise<string> } {
  const sock = connect(port, "127.0.0.1");
  let buf = "";
  sock.on("data", (d) => {
    buf += d.toString("latin1");
  });
  sock.on("error", () => {});
  const closed = new Promise<void>((r) => sock.on("close", () => r()));
  const until = async (re: RegExp, ms = 3000): Promise<string> => {
    const end = Date.now() + ms;
    while (!re.test(buf)) {
      if (Date.now() > end) throw new Error(`timed out waiting for ${re} in ${JSON.stringify(buf)}`);
      await Bun.sleep(5);
    }
    return buf;
  };
  return { sock, got: () => buf, closed, until };
}

const toEcho = (port: number): Partial<EgressOptions> => ({
  resolve: async () => ["160.79.104.10"],
  dial: (_ip, _p) => connect(port, "127.0.0.1"),
});

describe("the egress proxy", () => {
  test("CONNECT to an allowed name on 443 answers 200 and then carries bytes both ways, those sent with the head too", async () => {
    const e = await echo();
    const dialed: string[] = [];
    const p = await proxy({
      resolve: async () => ["160.79.104.10"],
      dial: (ip, port) => {
        dialed.push(`${ip}:${port}`);
        return connect(e.port, "127.0.0.1");
      },
    });
    const c = client(p.port);
    c.sock.write("CONNECT api.anthropic.com:443 HTTP/1.1\r\nHost: api.anthropic.com:443\r\n\r\nearly");
    await c.until(/^HTTP\/1\.1 200 [^\r]*\r\n\r\nearly$/);
    c.sock.write(" and late");
    await c.until(/early and late$/);
    expect(dialed).toEqual(["160.79.104.10:443"]);
    expect(p.tunnels()).toBe(1);
    c.sock.end();
    await c.closed;
  });

  test("a method other than CONNECT is a 405 and the connection closes", async () => {
    const p = await proxy();
    const c = client(p.port);
    c.sock.write("GET http://example.com/ HTTP/1.1\r\nHost: example.com\r\n\r\n");
    await c.closed;
    expect(c.got()).toStartWith("HTTP/1.1 405 ");
  });

  test("a name off the list is a 403, logged once however often it is asked for", async () => {
    const e = await echo();
    const p = await proxy(toEcho(e.port));
    for (let i = 0; i < 3; i++) {
      const c = client(p.port);
      c.sock.write("CONNECT example.com:443 HTTP/1.1\r\n\r\n");
      await c.closed;
      expect(c.got()).toStartWith("HTTP/1.1 403 ");
    }
    expect(p.logs.filter((l) => l.includes("example.com"))).toHaveLength(1);
    expect(e.seen()).toBe(0);
  });

  test("an allowed name that resolves to a private address is refused, and nothing is dialed", async () => {
    for (const addrs of [["10.0.0.5"], ["127.0.0.1"], ["100.88.84.71"], ["160.79.104.10", "192.168.1.1"], []]) {
      let dials = 0;
      const p = await proxy({ resolve: async () => addrs, dial: (ip, port) => (dials++, connect(port, ip)) });
      const c = client(p.port);
      c.sock.write("CONNECT api.anthropic.com:443 HTTP/1.1\r\n\r\n");
      await c.closed;
      expect(c.got()).toMatch(/^HTTP\/1\.1 (403|502) /);
      expect(dials).toBe(0);
    }
  });

  test("the address dialed is the one checked: the name is resolved once", async () => {
    const e = await echo();
    let lookups = 0;
    const dialed: string[] = [];
    const p = await proxy({
      // a resolver that would rebind on a second lookup
      resolve: async () => (lookups++ === 0 ? ["160.79.104.10"] : ["127.0.0.1"]),
      dial: (ip) => {
        dialed.push(ip);
        return connect(e.port, "127.0.0.1");
      },
    });
    const c = client(p.port);
    c.sock.write("CONNECT api.anthropic.com:443 HTTP/1.1\r\n\r\n");
    await c.until(/^HTTP\/1\.1 200 /);
    expect(lookups).toBe(1);
    expect(dialed).toEqual(["160.79.104.10"]);
    c.sock.destroy();
  });

  test("a lookup that fails, or a dial that fails, is a 502", async () => {
    const failing = await proxy({ resolve: async () => Promise.reject(new Error("ENOTFOUND")) });
    const a = client(failing.port);
    a.sock.write("CONNECT api.anthropic.com:443 HTTP/1.1\r\n\r\n");
    await a.closed;
    expect(a.got()).toStartWith("HTTP/1.1 502 ");

    // a port nothing listens on: a server bound and closed again
    const gone = createServer();
    await new Promise<void>((r) => gone.listen(0, "127.0.0.1", r));
    const addr = gone.address();
    if (addr === null || typeof addr === "string") throw new Error("no port");
    await new Promise<void>((r) => gone.close(() => r()));
    const refused = await proxy(toEcho(addr.port));
    const b = client(refused.port);
    b.sock.write("CONNECT api.anthropic.com:443 HTTP/1.1\r\n\r\n");
    await b.closed;
    expect(b.got()).toStartWith("HTTP/1.1 502 ");
  });

  test("past the cap a connection gets a 503 and the open tunnel is left alone", async () => {
    const e = await echo();
    const p = await proxy({ ...toEcho(e.port), maxTunnels: 1 });
    const a = client(p.port);
    a.sock.write("CONNECT api.anthropic.com:443 HTTP/1.1\r\n\r\n");
    await a.until(/^HTTP\/1\.1 200 /);
    const b = client(p.port);
    b.sock.write("CONNECT api.anthropic.com:443 HTTP/1.1\r\n\r\n");
    await b.closed;
    expect(b.got()).toStartWith("HTTP/1.1 503 ");
    a.sock.write("still here");
    await a.until(/still here$/);
    a.sock.destroy();
  });

  test("a head that never ends is a 408 once the head timeout runs out", async () => {
    const p = await proxy({ headTimeoutMs: 100 });
    const c = client(p.port);
    c.sock.write("CONNECT api.anthropic.com:443 HTTP/1.1\r\n");
    await c.closed;
    expect(c.got()).toStartWith("HTTP/1.1 408 ");
  });

  test("a head past its size cap is a 400", async () => {
    const p = await proxy();
    const c = client(p.port);
    c.sock.write(`CONNECT api.anthropic.com:443 HTTP/1.1\r\nX: ${"a".repeat(20_000)}`);
    await c.closed;
    expect(c.got()).toStartWith("HTTP/1.1 400 ");
  });

  test("a tunnel quiet past the idle limit is closed", async () => {
    const e = await echo();
    const p = await proxy({ ...toEcho(e.port), idleMs: 150 });
    const c = client(p.port);
    c.sock.write("CONNECT api.anthropic.com:443 HTTP/1.1\r\n\r\n");
    await c.until(/^HTTP\/1\.1 200 /);
    await c.closed;
    expect(p.tunnels()).toBe(0);
  });
});
