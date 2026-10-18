/**
 * The coordinator's egress proxy: an HTTPS CONNECT proxy that tunnels only
 * to the names in ALLOWED_HOSTS on port 443. It resolves the name itself,
 * refuses unless every address it got is public (isPublicV4), and dials the
 * address it checked, so a second lookup cannot rebind the name between the
 * check and the connect. Nothing past the head is read: TLS runs end to end
 * through the tunnel.
 *
 * Each refusal is logged once per host (or method), with a cap on how many
 * it remembers, so a client asking for endless names cannot grow the set.
 * A cap on open connections, a head timeout and size cap, a connect timeout
 * and an idle timeout keep a client from holding the proxy open.
 */
import { lookup } from "node:dns/promises";
import { connect, createServer, type Socket } from "node:net";
import { isPublicV4, parseConnect } from "./allow";

export interface EgressOptions {
  host: string;
  port: number;
  /** the name's v4 addresses; node's lookup by default */
  resolve?: (name: string) => Promise<string[]>;
  /** whether an address may be dialed; isPublicV4 by default */
  allowAddress?: (addr: string) => boolean;
  /** opens the upstream connection; net.connect by default */
  dial?: (addr: string, port: number) => Socket;
  /** connections open at once, tunnels and heads still coming in */
  maxTunnels?: number;
  headTimeoutMs?: number;
  connectTimeoutMs?: number;
  idleMs?: number;
  log?: (line: string) => void;
}

export const EGRESS_PORT = 3128;
const MAX_HEAD = 8 * 1024;
const MAX_LOGGED = 1000;

const resolveV4 = async (name: string): Promise<string[]> => (await lookup(name, { all: true, family: 4 })).map((a) => a.address);

const TEXT: Record<number, string> = {
  400: "Bad Request",
  403: "Forbidden",
  405: "Method Not Allowed",
  408: "Request Timeout",
  502: "Bad Gateway",
  503: "Service Unavailable",
};

export async function startEgressProxy(opts: EgressOptions): Promise<{ port: number; tunnels(): number; stop(): Promise<void> }> {
  const resolve = opts.resolve ?? resolveV4;
  const allowAddress = opts.allowAddress ?? isPublicV4;
  const dial = opts.dial ?? ((addr: string, port: number) => connect({ host: addr, port }));
  const max = opts.maxTunnels ?? 64;
  const headMs = opts.headTimeoutMs ?? 10_000;
  const connectMs = opts.connectTimeoutMs ?? 10_000;
  const idleMs = opts.idleMs ?? 10 * 60_000;
  const log = opts.log ?? ((line: string) => console.log(line));
  const logged = new Set<string>();
  const once = (key: string, line: string): void => {
    if (logged.has(key) || logged.size >= MAX_LOGGED) return;
    logged.add(key);
    // a refusal's words can carry the client's bytes
    log(line.replace(/[^\x20-\x7e]/g, "?"));
  };
  const open = new Set<Socket>();
  let tunnels = 0;

  const server = createServer((client) => {
    client.on("error", () => {});
    if (open.size >= max) {
      once("full", `egress: ${max} connections open, refusing more until one closes`);
      reject(client, 503);
      return;
    }
    open.add(client);
    client.on("close", () => open.delete(client));

    let head = Buffer.alloc(0);
    let done = false;
    const refuse = (status: number): void => {
      done = true;
      clearTimeout(headTimer);
      client.removeListener("data", onData);
      reject(client, status);
    };
    const headTimer = setTimeout(() => {
      if (!done) refuse(408);
    }, headMs);

    const onData = (chunk: Buffer): void => {
      head = Buffer.concat([head, chunk]);
      const end = head.indexOf("\r\n\r\n");
      if (end === -1) {
        if (head.length > MAX_HEAD) refuse(400);
        return;
      }
      if (end > MAX_HEAD) return refuse(400);
      done = true;
      clearTimeout(headTimer);
      client.removeListener("data", onData);
      client.pause();
      const rest = head.subarray(end + 4);
      void tunnel(client, head.subarray(0, end).toString("latin1"), rest);
    };
    client.on("data", onData);
  });

  const tunnel = async (client: Socket, head: string, rest: Buffer): Promise<void> => {
    const target = parseConnect(head);
    if ("status" in target) {
      once(target.host ?? `status ${target.status}: ${target.reason}`, `egress: refused ${target.reason}`);
      reject(client, target.status);
      return;
    }
    let addrs: string[];
    try {
      addrs = await withTimeout(resolve(target.host), connectMs);
    } catch (e) {
      once(`lookup ${target.host}`, `egress: could not resolve ${target.host} (${e instanceof Error ? e.message : String(e)})`);
      reject(client, 502);
      return;
    }
    const addr = addrs[0];
    if (addr === undefined) {
      once(`lookup ${target.host}`, `egress: ${target.host} has no v4 address`);
      reject(client, 502);
      return;
    }
    const bad = addrs.find((a) => !allowAddress(a));
    if (bad !== undefined) {
      once(`private ${target.host}`, `egress: refused ${target.host}, which resolves to ${bad}, not a public address`);
      reject(client, 403);
      return;
    }
    if (client.destroyed) return;
    const up = dial(addr, target.port);
    const connectTimer = setTimeout(() => up.destroy(new Error("connect timed out")), connectMs);
    const dialFailed = (e: Error): void => {
      clearTimeout(connectTimer);
      once(`dial ${target.host}`, `egress: could not reach ${target.host} at ${addr} (${e.message})`);
      reject(client, 502);
    };
    up.once("error", dialFailed);
    up.once("connect", () => {
      clearTimeout(connectTimer);
      up.removeListener("error", dialFailed);
      if (client.destroyed) return void up.destroy();
      tunnels++;
      up.on("error", () => client.destroy());
      client.on("error", () => up.destroy());
      const close = (): void => {
        up.destroy();
        client.destroy();
      };
      up.once("close", close);
      client.once("close", () => {
        tunnels--;
        close();
      });
      up.setTimeout(idleMs, close);
      client.setTimeout(idleMs, close);
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (rest.length) up.write(rest);
      client.pipe(up);
      up.pipe(client);
      client.resume();
    });
  };

  await new Promise<void>((ok, fail) => {
    server.once("error", fail);
    server.listen(opts.port, opts.host, () => {
      server.removeListener("error", fail);
      ok();
    });
  });
  const addr = server.address();
  const port = addr !== null && typeof addr === "object" ? addr.port : opts.port;
  return {
    port,
    tunnels: () => tunnels,
    stop: () =>
      new Promise<void>((ok) => {
        for (const s of open) s.destroy();
        server.close(() => ok());
      }),
  };
}

/** Answers with the status and closes. The socket is let flow again so the
 *  client's own end arrives and the socket closes; one that never ends is
 *  destroyed a moment later. */
function reject(client: Socket, status: number): void {
  client.end(answer(status));
  client.resume();
  setTimeout(() => client.destroy(), 2000).unref();
}

const answer = (status: number): string => `HTTP/1.1 ${status} ${TEXT[status] ?? "Error"}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`;

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((ok, fail) => {
    const t = setTimeout(() => fail(new Error(`no answer in ${ms} ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        ok(v);
      },
      (e: unknown) => {
        clearTimeout(t);
        fail(e);
      },
    );
  });
}
