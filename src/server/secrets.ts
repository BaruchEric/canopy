/**
 * The Secrets view's routes (docs/superpowers/specs/2026-10-14-secrets-design.md).
 * On the mini, where CANOPY_SECRETS_SOCKET is set, canopy only relays: each
 * request goes down the secrets service's socket, the session token rides
 * in an HttpOnly cookie, and the gated routes answer only the mini's own
 * page. canopy keeps no token, key or value between requests. Everywhere
 * else the routes read the verified copy (SecretsReader): the list, this
 * machine's key and lock (its own page or terminal only), and its import
 * values and takes, sealed to the mini for the mini's page to post.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { macSources } from "../core/secretimport";
import { localPaths, SecretsReader } from "../core/secretlocal";
import { askSecrets, SECRETS_AWAY } from "../core/secretsclient";
import { sshSinks, type RemoteSinks } from "../core/sinkssh";
import { parseAct, parseProposals, PASSKEY, type SecretsReply, type SecretsRequest } from "../core/secretwire";
import { mcpIgnoreRefusal } from "../core/sinks";
import type { SecretsInfo, ServerEvent } from "../core/types";

export const COOKIE = "canopy_secrets";
/** 32 random bytes, base64url */
const TOKEN = /^[A-Za-z0-9_-]{43}$/;

const json = (body: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...headers } });

export function tokenFrom(req: Request): string | null {
  for (const part of (req.headers.get("cookie") ?? "").split(";")) {
    const at = part.indexOf("=");
    if (at === -1 || part.slice(0, at).trim() !== COOKIE) continue;
    const t = part.slice(at + 1).trim();
    return TOKEN.test(t) ? t : null;
  }
  return null;
}

export const sessionCookie = (token: string, maxAgeS: number): string =>
  `${COOKIE}=${token}; Path=/api/secrets; HttpOnly; Secure; SameSite=Strict; Max-Age=${Math.floor(maxAgeS)}`;

export const clearCookie = (): string => `${COOKIE}=; Path=/api/secrets; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;

/** a gated route answers only the mini's own page */
export function gateOriginOk(req: Request, gateOrigin: string): boolean {
  const site = req.headers.get("sec-fetch-site");
  return req.headers.get("origin") === gateOrigin && (site === null || site === "same-origin");
}

/** this machine's key answers only its own page, or a loopback caller with
 *  no Origin (the CLI) */
export function sameOriginOk(req: Request): boolean {
  const url = new URL(req.url);
  const site = req.headers.get("sec-fetch-site");
  if (site !== null && site !== "same-origin" && site !== "none") return false;
  const origin = req.headers.get("origin");
  if (origin === null) return ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  try {
    return new URL(origin).host === url.host;
  } catch {
    return false;
  }
}

const emptyInfo = (backend: string, gate: string, role: SecretsInfo["role"], error: string): SecretsInfo => ({
  ok: false,
  error,
  backend,
  role,
  head: null,
  refused: null,
  lock: "none",
  recipient: null,
  secrets: [],
  sinks: [],
  proposals: [],
  passkeys: [],
  session: false,
  firstPasskey: false,
  gate,
  unpushed: 0,
});

/** a service answer as a response; a closed gate is a 401 that is not a sign-in */
function reply(r: SecretsReply): Response {
  if (r.ok) return json(r.data ?? null);
  if (r.gate === PASSKEY) return json({ error: r.error, gate: PASSKEY }, 401, { "set-cookie": clearCookie() });
  return json({ error: r.error }, r.error === SECRETS_AWAY ? 503 : 400);
}

export interface SecretsHubDeps {
  /** this backend's name (`selfName`) */
  backend: string;
  /** the secrets service's socket: set on the writer only */
  socket: string | null;
  /** the page origin passkeys are bound to */
  gateOrigin: string;
  reader: SecretsReader | null;
  broadcast: (ev: ServerEvent) => void;
  ask?: (req: SecretsRequest) => Promise<SecretsReply>;
  /** the writer's accident guard before an mcp-allow: why this machine's
   *  dotclaude would commit the env file, or null (phase 2 plan, call 5) */
  mcpIgnored?: (server: string) => Promise<string | null>;
  /** console.log unless a test listens */
  log?: (line: string) => void;
  pollMs?: number;
  pullMs?: number;
}

const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

export class SecretsHub {
  private timer: ReturnType<typeof setInterval> | null = null;
  private sent = "";
  private readonly ask: (req: SecretsRequest) => Promise<SecretsReply>;

  constructor(private readonly d: SecretsHubDeps) {
    this.ask = d.ask ?? ((req) => askSecrets(d.socket ?? "", req));
  }

  private get gateUrl(): string {
    return `${this.d.gateOrigin}/?view=secrets`;
  }

  start(): void {
    const r = this.d.reader;
    if (r) {
      // nothing awaits these, and Bun ends the server on an unhandled rejection
      const failed = (what: string) => (err: unknown) => (this.d.log ?? console.log)(`secrets: the reader's ${what} failed: ${err instanceof Error ? err.message : "failed"}`);
      r.start().then(() => this.announce()).catch(failed("start"));
      this.timer = setInterval(() => void r.pull().then(() => this.announce()).catch(failed("pull")), this.d.pullMs ?? 5 * 60_000);
    } else if (this.d.socket) {
      void this.announce();
      this.timer = setInterval(() => void this.announce(), this.d.pollMs ?? 30_000);
    }
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async info(token: string | null): Promise<SecretsInfo> {
    if (this.d.reader) return this.d.reader.info(this.d.backend);
    const r = await this.ask({ t: "info", token });
    if (!r.ok) return emptyInfo(this.d.backend, this.gateUrl, "writer", r.error);
    return { ...(r.data as SecretsInfo), backend: this.d.backend };
  }

  /** the page hears of a change; every page gets the same, session-free info */
  private async announce(): Promise<void> {
    const info = await this.info(null).catch(() => null);
    if (!info) return;
    const text = JSON.stringify(info);
    if (text === this.sent) return;
    this.sent = text;
    this.d.broadcast({ type: "secrets", info });
  }

  async handle(req: Request, url: URL): Promise<Response | null> {
    const path = url.pathname;
    if (path !== "/api/secrets" && !path.startsWith("/api/secrets/")) return null;
    if (path === "/api/secrets" && req.method === "GET") return json(await this.info(tokenFrom(req)));
    const r = this.d.reader;
    return r ? this.readerRoute(req, path, r) : this.writerRoute(req, path);
  }

  private async writerRoute(req: Request, path: string): Promise<Response> {
    if (req.method === "GET" && path === "/api/secrets/audit") {
      const r = await this.ask({ t: "audit", limit: 200 });
      return r.ok ? json(r.data) : json({ error: r.error }, 503);
    }
    if (req.method !== "POST") return json({ error: "not found" }, 404);
    const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
    if (path === "/api/secrets/proposals") {
      const items = parseProposals(body?.["items"]);
      if ("error" in items) return json(items, 400);
      const r = await this.ask({ t: "propose", items });
      await this.announce();
      return reply(r);
    }
    if (!gateOriginOk(req, this.d.gateOrigin)) return json({ error: `gated actions answer only ${this.gateUrl}` }, 403);
    const token = tokenFrom(req);
    const kind = body?.["kind"];
    const code = str(body?.["code"]);
    switch (path) {
      case "/api/secrets/gate/begin":
        if (kind !== "login" && kind !== "register") return json({ error: "kind is login or register" }, 400);
        return reply(await this.ask({ t: "begin", kind, token, code }));
      case "/api/secrets/gate/finish": {
        if (kind !== "login" && kind !== "register") return json({ error: "kind is login or register" }, 400);
        const r = await this.ask({ t: "finish", kind, token, code, response: body?.["response"], label: str(body?.["label"]) ?? "" });
        await this.announce();
        if (!r.ok) return reply(r);
        const data = (r.data ?? {}) as { token?: unknown; maxAgeS?: unknown };
        if (typeof data.token === "string" && typeof data.maxAgeS === "number") return json({ ok: true }, 200, { "set-cookie": sessionCookie(data.token, data.maxAgeS) });
        return json({ ok: true });
      }
      case "/api/secrets/logout":
        if (token) await this.ask({ t: "logout", token });
        return json({ ok: true }, 200, { "set-cookie": clearCookie() });
      case "/api/secrets/act": {
        const act = parseAct(body?.["act"]);
        if ("error" in act) return json(act, 400);
        if (act.a === "mcp-allow" && this.d.mcpIgnored) {
          const why = await this.d.mcpIgnored(act.server);
          if (why) return json({ error: `${why}; pull dotclaude on this machine first` }, 409);
        }
        const r = await this.ask({ t: "act", token, act });
        if (r.ok && act.a !== "reveal") await this.announce();
        return reply(r);
      }
      default:
        return json({ error: "not found" }, 404);
    }
  }

  private async readerRoute(req: Request, path: string, r: SecretsReader): Promise<Response> {
    const elsewhere = json({ error: `gated actions live on ${this.gateUrl}` }, 404);
    if (req.method !== "POST") return elsewhere;
    const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
    switch (path) {
      case "/api/secrets/pull":
        await r.pull();
        await this.announce();
        return json(r.info(this.d.backend));
      case "/api/secrets/scan": {
        const p = await r.proposals();
        return "error" in p ? json(p, 409) : json(p);
      }
      case "/api/secrets/take": {
        const id = str(body?.["id"]);
        const key = str(body?.["key"]);
        if (!id || !key) return json({ error: "take needs a sink id and a key" }, 400);
        const t = await r.take(id, key);
        return "error" in t ? json(t, 400) : json(t);
      }
      case "/api/secrets/unlock":
      case "/api/secrets/lock":
      case "/api/secrets/key": {
        if (!sameOriginOk(req)) return json({ error: "this machine's key answers only its own page or its own terminal" }, 403);
        if (path === "/api/secrets/lock") {
          r.lockNow();
          await this.announce();
          return json({ ok: true });
        }
        const pass = str(body?.["passphrase"]) ?? "";
        if (path === "/api/secrets/unlock") {
          const u = await r.unlock(pass);
          await this.announce();
          return u.ok ? json({ ok: true }) : json({ error: u.error }, 403);
        }
        const k = await r.createKey(pass, body?.["replace"] === true);
        await this.announce();
        return "error" in k ? json(k, 409) : json(k);
      }
      default:
        return elsewhere;
    }
  }
}

/** the hub for this backend: the relay when the service's socket is set,
 *  else a reader of the pulled copy */
export function createSecretsHub(o: {
  backend: string;
  root: string;
  repoRoots: () => readonly string[];
  broadcast: (ev: ServerEvent) => void;
  /** the machines this backend reaches over ssh, from the kit's manifest */
  sshMachines?: () => { name: string; host: string }[];
  env?: Record<string, string | undefined>;
}): SecretsHub {
  const env = o.env ?? process.env;
  const remotes = new Map<string, RemoteSinks>();
  const remoteFor = (m: { name: string; host: string }): RemoteSinks => {
    const key = `${m.name}\t${m.host}`;
    let r = remotes.get(key);
    if (!r) remotes.set(key, (r = sshSinks(m.name, m.host)));
    return r;
  };
  const socket = env["CANOPY_SECRETS_SOCKET"] || null;
  const gateOrigin = env["CANOPY_SECRETS_ORIGIN"] ?? "https://canopy.beric.ca";
  const reader = socket
    ? null
    : new SecretsReader({
        paths: localPaths(),
        machine: o.backend,
        gateUrl: `${gateOrigin}/?view=secrets`,
        sources: () => macSources(homedir(), o.root),
        repoRoots: () => [...o.repoRoots(), join(homedir(), ".claude")],
        mcpEnvDir: join(homedir(), ".claude", "mcp-env"),
        remotes: () => (o.sshMachines?.() ?? []).map(remoteFor),
        log: (line) => console.log(line),
      });
  return new SecretsHub({
    backend: o.backend,
    socket,
    gateOrigin,
    reader,
    broadcast: o.broadcast,
    // on the mini, this is the canopy container's /home/bun/.claude: the same dotclaude checkout as the host's
    mcpIgnored: socket ? (server) => mcpIgnoreRefusal(homedir(), server) : undefined,
  });
}
