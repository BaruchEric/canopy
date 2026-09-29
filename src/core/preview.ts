/**
 * The in-app browser's proxy: a repo's dev server on the backend's loopback,
 * shown in the panel from any device. Each preview gets a port of its own
 * out of a small pool (`CANOPY_PREVIEW_PORTS`, 7860-7869 by default), so it
 * is its own origin: the app's absolute paths (`/src/main.tsx`,
 * `/@vite/client`, `/_next/...`) and its HMR websocket reach it unchanged,
 * which a path prefix under canopy's own origin would break, and the app
 * cannot touch canopy's API. A slot is handed out by `POST /api/preview`,
 * behind canopy's origin gate, and dials only loopback.
 *
 * The header rewriting, the port range and the slot pool are pure and
 * tested; `PreviewProxy` is Bun.
 */
import { publicPreviewOrigin } from "./previewPublic";
import type { Server, ServerWebSocket } from "bun";

/** the preview ports when `CANOPY_PREVIEW_PORTS` is unset */
export const PREVIEW_PORTS_DEFAULT = "7860-7869";

/** `7860-7869`, `7860,7862` or `0`/`off`/empty (previews off) as a port list */
export function parsePortRange(spec: string | undefined): number[] {
  const s = (spec ?? PREVIEW_PORTS_DEFAULT).trim();
  if (s === "" || s === "0" || s === "off") return [];
  const out: number[] = [];
  for (const part of s.split(",")) {
    const m = /^\s*(\d+)\s*(?:-\s*(\d+)\s*)?$/.exec(part);
    if (!m) continue;
    const a = Number(m[1]);
    const b = m[2] ? Number(m[2]) : a;
    for (let p = Math.min(a, b); p <= Math.max(a, b) && out.length < 64; p++) {
      if (p > 0 && p < 65536 && !out.includes(p)) out.push(p);
    }
  }
  return out;
}

/** a backend port a preview may dial: a real port, not canopy's own and not
 *  one of the preview ports (which would proxy to itself) */
export function previewable(port: unknown, own: number[]): port is number {
  return typeof port === "number" && Number.isInteger(port) && port > 0 && port < 65536 && !own.includes(port);
}

/**
 * Which preview port serves `port`: the one already on it, else a free one,
 * else the one used longest ago, which a preview elsewhere loses. `used`
 * orders the slots oldest first and is updated in place.
 */
export function pickSlot(map: Map<number, number>, used: number[], slots: number[], port: number): number | null {
  if (slots.length === 0) return null;
  let slot = [...map].find(([, p]) => p === port)?.[0];
  slot ??= slots.find((s) => !map.has(s));
  slot ??= used.find((s) => slots.includes(s)) ?? slots[0];
  if (slot === undefined) return null;
  map.set(slot, port);
  const i = used.indexOf(slot);
  if (i >= 0) used.splice(i, 1);
  used.push(slot);
  return slot;
}

// hop-by-hop headers (RFC 9110 7.6.1) and what Bun sets on its own
const HOP = [
  "connection",
  "keep-alive",
  "proxy-connection",
  "transfer-encoding",
  "te",
  "trailer",
  "upgrade",
  "host",
  "content-length",
];

/**
 * What goes to the dev server: the preview's own origin swapped for the
 * dev server's in Host, Origin and Referer, since Vite and Next refuse a
 * Host they do not know and check a websocket's Origin; and no compression,
 * since fetch would undo it and leave the header claiming it.
 */
export function upstreamHeaders(h: Headers, previewOrigin: string, target: string): Headers {
  const out = new Headers();
  for (const [k, v] of h) if (!HOP.includes(k.toLowerCase())) out.set(k, v);
  out.set("host", new URL(target).host.replace(/^127\.0\.0\.1|^\[::1\]/, "localhost"));
  const origin = out.get("origin");
  if (origin === previewOrigin) out.set("origin", target.replace(/^http:\/\/(127\.0\.0\.1|\[::1\])/, "http://localhost"));
  const ref = out.get("referer");
  if (ref?.startsWith(`${previewOrigin}/`) || ref === previewOrigin) {
    out.set("referer", target.replace(/^http:\/\/(127\.0\.0\.1|\[::1\])/, "http://localhost") + ref.slice(previewOrigin.length));
  }
  out.set("accept-encoding", "identity");
  out.delete("sec-websocket-key");
  out.delete("sec-websocket-version");
  out.delete("sec-websocket-extensions");
  return out;
}

/** a URL on the dev server itself (localhost, 127.0.0.1 or ::1 at its port)
 *  rewritten onto the preview's origin; anything else untouched */
export function rewriteLocation(loc: string, port: number, previewOrigin: string): string {
  const m = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0):(\d+)(.*)$/i.exec(loc);
  if (m && Number(m[2]) === port) return previewOrigin + (m[3] || "/");
  return loc;
}

/** `frame-ancestors` out of a CSP, which would stop canopy framing the app;
 *  null when nothing is left */
export function dropFrameAncestors(csp: string): string | null {
  const kept = csp
    .split(";")
    .map((d) => d.trim())
    .filter((d) => d !== "" && !/^frame-ancestors\b/i.test(d));
  return kept.length ? kept.join("; ") : null;
}

/**
 * What goes back to the browser: redirects onto the dev server pointed at
 * the preview instead, and nothing that forbids canopy's panel from framing
 * it (`X-Frame-Options`, a CSP `frame-ancestors`), since the panel is on
 * canopy's origin and the preview on its own port.
 */
export function downstreamHeaders(h: Headers, port: number, previewOrigin: string): Headers {
  const out = new Headers();
  for (const [k, v] of h) {
    const key = k.toLowerCase();
    if (HOP.includes(key) || key === "x-frame-options" || key === "content-encoding") continue;
    if (key === "set-cookie") continue; // appended one by one below
    out.set(k, v);
  }
  for (const c of h.getSetCookie()) out.append("set-cookie", c);
  const loc = out.get("location");
  if (loc) out.set("location", rewriteLocation(loc, port, previewOrigin));
  const csp = out.get("content-security-policy");
  if (csp !== null) {
    const next = dropFrameAncestors(csp);
    if (next) out.set("content-security-policy", next);
    else out.delete("content-security-policy");
  }
  return out;
}

/** a hostname a preview port answers to: loopback, or a tailnet name or
 *  address when canopy listens beyond loopback (the same edge the API's
 *  origin gate draws); anything else is a rebound domain */
export function previewHostOk(hostname: string, open: boolean, tailnet: (h: string) => boolean): boolean {
  if (["localhost", "127.0.0.1", "[::1]", "::1"].includes(hostname)) return true;
  return open && tailnet(hostname);
}

interface WsData {
  url: string;
  protocols: string[];
  headers: Record<string, string>;
  up?: WebSocket;
  queue: (string | ArrayBuffer | Uint8Array)[];
}

/** the preview ports: one lazy listener each, proxying to whatever backend
 *  port `serve` last put there */
export class PreviewProxy {
  readonly slots: number[];
  private map = new Map<number, number>();
  private used: number[] = [];
  private servers = new Map<number, Server<WsData>>();
  /** which loopback answered a port last, so a v6-only server is dialled right */
  private hosts = new Map<number, string>();

  constructor(
    slots: number[],
    private opts: {
      bind: string;
      /** canopy's own port, never a target (read late: it is known once bound) */
      own: () => number;
      hostOk: (hostname: string) => boolean;
      /** `CANOPY_PREVIEW_PUBLIC`: each slot's public https name, which the
       *  tunnel hands this slot under */
      publicTemplate?: string | null;
      /** the loopback a port is known to listen on, when the caller knows it */
      hostFor?: (port: number) => Promise<string | undefined>;
    },
  ) {
    this.slots = slots;
  }

  /** each slot's public name, when the backend has them */
  get publicTemplate(): string | null {
    return this.opts.publicTemplate ?? null;
  }

  /** the ports a preview may not dial */
  get reserved(): number[] {
    return [this.opts.own(), ...this.slots];
  }

  /** puts `port` on a preview port and starts its listener; null when every
   *  slot failed to bind or there are none */
  async serve(port: number): Promise<number | null> {
    const tried = new Set<number>();
    for (;;) {
      const slot = pickSlot(this.map, this.used, this.slots.filter((s) => !tried.has(s)), port);
      if (slot === null) return null;
      if (this.listen(slot)) return slot;
      tried.add(slot);
      this.map.delete(slot);
    }
  }

  stop() {
    for (const s of this.servers.values()) s.stop(true);
    this.servers.clear();
    this.map.clear();
  }

  private listen(slot: number): boolean {
    if (this.servers.has(slot)) return true;
    try {
      const server = Bun.serve<WsData>({
        port: slot,
        hostname: this.opts.bind,
        idleTimeout: 0,
        fetch: (req, srv) => this.handle(slot, req, srv),
        websocket: {
          open: (ws) => this.wsOpen(ws),
          message: (ws, msg) => {
            const { up, queue } = ws.data;
            if (up && up.readyState === WebSocket.OPEN) up.send(msg);
            else queue.push(msg);
          },
          close: (ws, code, reason) => {
            const up = ws.data.up;
            if (up && up.readyState <= WebSocket.OPEN) up.close(safeCode(code), reason);
          },
        },
      });
      this.servers.set(slot, server);
      return true;
    } catch (err) {
      console.error(`preview port ${slot}: ${String(err instanceof Error ? err.message : err)}`);
      return false;
    }
  }

  private async hostOf(port: number): Promise<string> {
    return this.hosts.get(port) ?? (await this.opts.hostFor?.(port)) ?? "127.0.0.1";
  }

  private async handle(slot: number, req: Request, srv: Server<WsData>): Promise<Response | undefined> {
    const url = new URL(req.url);
    // under its public name the request came through the tunnel, as plain
    // http from the tunnel's side, so the origin the browser sees is https
    const pub = this.opts.publicTemplate ? publicPreviewOrigin(this.opts.publicTemplate, slot) : null;
    const onPublic = pub !== null && url.hostname.toLowerCase() === new URL(pub).hostname;
    if (!onPublic && !this.opts.hostOk(url.hostname)) return new Response("Foreign host", { status: 403 });
    const port = this.map.get(slot);
    if (port === undefined) return new Response("Nothing is previewed on this port; pick a port in canopy's panel.", { status: 404 });
    const previewOrigin = onPublic && pub ? pub : url.origin;
    const host = await this.hostOf(port);
    const target = `http://${host}:${port}`;

    if (req.headers.get("upgrade")?.toLowerCase() === "websocket") {
      const protocols = (req.headers.get("sec-websocket-protocol") ?? "")
        .split(",")
        .map((p) => p.trim())
        .filter(Boolean);
      const headers: Record<string, string> = {};
      for (const [k, v] of upstreamHeaders(req.headers, previewOrigin, target)) {
        if (k !== "sec-websocket-protocol") headers[k] = v;
      }
      const data: WsData = {
        url: `ws://${host}:${port}${url.pathname}${url.search}`,
        protocols,
        headers,
        queue: [],
      };
      // the first protocol asked for is the one agreed; Vite's `vite-hmr`
      // and Next's (none) are the ones that matter
      const answer = protocols[0] ? { "Sec-WebSocket-Protocol": protocols[0] } : undefined;
      if (srv.upgrade(req, { data, headers: answer })) return undefined;
      return new Response("a websocket is expected here", { status: 426 });
    }

    const init = (to: string): RequestInit => ({
      method: req.method,
      headers: upstreamHeaders(req.headers, previewOrigin, to),
      body: req.method === "GET" || req.method === "HEAD" ? undefined : req.body,
      redirect: "manual",
    });
    let res: Response;
    try {
      res = await fetch(`${target}${url.pathname}${url.search}`, init(target));
      this.hosts.set(port, host);
    } catch {
      // not there on this loopback: a server bound to ::1 alone, or the
      // other way round. The body of a POST is spent, so only a bodiless
      // request tries the other one.
      const other = host === "127.0.0.1" ? "[::1]" : "127.0.0.1";
      const alt = `http://${other}:${port}`;
      if (req.method !== "GET" && req.method !== "HEAD") return down(port);
      try {
        res = await fetch(`${alt}${url.pathname}${url.search}`, init(alt));
        this.hosts.set(port, other);
      } catch {
        return down(port);
      }
    }
    return new Response(res.body, {
      status: res.status,
      statusText: res.statusText,
      headers: downstreamHeaders(res.headers, port, previewOrigin),
    });
  }

  private wsOpen(ws: ServerWebSocket<WsData>) {
    const { url, protocols, headers } = ws.data;
    let up: WebSocket;
    try {
      // Bun's client takes headers and protocols in one options object
      up = new WebSocket(url, { headers, protocols } as unknown as string[]);
    } catch {
      ws.close(1011, "the dev server's socket would not open");
      return;
    }
    up.binaryType = "arraybuffer";
    ws.data.up = up;
    up.onopen = () => {
      for (const m of ws.data.queue) up.send(m);
      ws.data.queue = [];
    };
    up.onmessage = (ev) => {
      const d: unknown = ev.data;
      if (typeof d === "string") ws.sendText(d);
      else if (d instanceof ArrayBuffer) ws.sendBinary(new Uint8Array(d));
    };
    up.onclose = (ev) => ws.close(safeCode(ev.code), ev.reason);
    up.onerror = () => ws.close(1011, "the dev server's socket failed");
  }
}

/** a close code a peer may send: 1000 or an application one, never the
 *  reserved codes the other side reported (1005, 1006, 1015) */
function safeCode(code: number): number {
  return code === 1000 || (code >= 3000 && code < 5000) ? code : 1000;
}

function down(port: number): Response {
  return new Response(
    `<!doctype html><meta charset="utf-8"><title>Nothing on ${port}</title>` +
      `<body style="font:14px system-ui;padding:2rem;color:#888">Nothing answers on port ${port} on the backend. ` +
      `Start the dev server in a canopy shell, then reload.</body>`,
    { status: 502, headers: { "content-type": "text/html; charset=utf-8" } },
  );
}
