import { describe, expect, test } from "bun:test";
import type { SecretsReader } from "../core/secretlocal";
import type { SecretsReply, SecretsRequest } from "../core/secretwire";
import type { SecretsInfo, ServerEvent } from "../core/types";
import { SAMPLES } from "../core/secretwire.samples";
import { clearCookie, gateOriginOk, sameOriginOk, SecretsHub, sessionCookie, tokenFrom } from "./secrets";

const GATE = "https://canopy.beric.ca";
const TOKEN = "a".repeat(43);
const V = "fixture-value-0x5eed";

function writer(answer: (r: SecretsRequest) => SecretsReply = () => ({ ok: true, data: {} })) {
  const asked: SecretsRequest[] = [];
  const events: ServerEvent[] = [];
  const hub = new SecretsHub({
    backend: "mini",
    socket: "/run/canopy-secrets/secrets.sock",
    gateOrigin: GATE,
    reader: null,
    broadcast: (e) => events.push(e),
    ask: async (r) => {
      asked.push(r);
      return answer(r);
    },
  });
  return { hub, asked, events };
}

const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  new Request(`http://127.0.0.1:7850${path}`, { method: "POST", headers: { "content-type": "application/json", origin: GATE, "sec-fetch-site": "same-origin", ...headers }, body: JSON.stringify(body) });
const call = async (hub: SecretsHub, req: Request): Promise<Response> => {
  const r = await hub.handle(req, new URL(req.url));
  if (!r) throw new Error("not handled");
  return r;
};

describe("cookies", () => {
  test("the session cookie is HttpOnly, Secure, SameSite=Strict and scoped to the secrets routes", () => {
    expect(sessionCookie(TOKEN, 3600)).toBe(`canopy_secrets=${TOKEN}; Path=/api/secrets; HttpOnly; Secure; SameSite=Strict; Max-Age=3600`);
    expect(clearCookie()).toContain("Max-Age=0");
  });

  test("tokenFrom reads only a well-formed token", () => {
    expect(tokenFrom(new Request("http://x/", { headers: { cookie: `a=1; canopy_secrets=${TOKEN}` } }))).toBe(TOKEN);
    expect(tokenFrom(new Request("http://x/", { headers: { cookie: "canopy_secrets=short" } }))).toBeNull();
    expect(tokenFrom(new Request("http://x/"))).toBeNull();
  });

  test("origin rules", () => {
    expect(gateOriginOk(post("/api/secrets/act", {}), GATE)).toBe(true);
    expect(gateOriginOk(post("/api/secrets/act", {}, { origin: "http://mac.tail:7850" }), GATE)).toBe(false);
    expect(gateOriginOk(post("/api/secrets/act", {}, { "sec-fetch-site": "cross-site" }), GATE)).toBe(false);
    const own = new Request("http://127.0.0.1:7850/api/secrets/unlock", { method: "POST", headers: { origin: "http://127.0.0.1:7850" } });
    expect(sameOriginOk(own)).toBe(true);
    expect(sameOriginOk(new Request("http://127.0.0.1:7850/api/secrets/unlock", { method: "POST" }))).toBe(true);
    expect(sameOriginOk(new Request("http://mac.tail:7850/api/secrets/unlock", { method: "POST" }))).toBe(false);
    expect(sameOriginOk(new Request("http://127.0.0.1:7850/api/secrets/unlock", { method: "POST", headers: { origin: GATE } }))).toBe(false);
  });
});

describe("the writer relays", () => {
  test("an act without a session is a 401 with the passkey gate and no login field", async () => {
    const { hub } = writer(() => ({ ok: false, error: "open the passkey gate first", gate: "passkey" }));
    const r = await call(hub, post("/api/secrets/act", { act: { a: "reveal", name: "cf_token" } }));
    expect(r.status).toBe(401);
    const body = (await r.json()) as Record<string, unknown>;
    expect(body).toEqual({ error: "open the passkey gate first", gate: "passkey" });
    expect("login" in body).toBe(false);
    expect(r.headers.get("set-cookie")).toContain("Max-Age=0");
  });

  test("a login sets the cookie and the body never holds the token", async () => {
    const { hub } = writer((q) => (q.t === "finish" ? { ok: true, data: { token: TOKEN, maxAgeS: 3600 } } : { ok: true, data: {} }));
    const r = await call(hub, post("/api/secrets/gate/finish", { kind: "login", response: { id: "c" } }));
    expect(r.status).toBe(200);
    expect(r.headers.get("set-cookie")).toBe(sessionCookie(TOKEN, 3600));
    expect(await r.text()).not.toContain(TOKEN);
    expect(r.headers.get("cache-control")).toBe("no-store");
  });

  test("an mcp-allow waits for dotclaude's ignore on the writer's machine, and answers 409 without asking", async () => {
    const asked: SecretsRequest[] = [];
    const hub = new SecretsHub({
      backend: "mini", socket: "/run/canopy-secrets/secrets.sock", gateOrigin: GATE, reader: null, broadcast: () => {},
      ask: async (r) => (asked.push(r), { ok: true, data: {} }),
      mcpIgnored: async (server) => (server === "github" ? "/home/bun/.claude/mcp-env/github.env is inside the repo /home/bun/.claude and git does not ignore it there" : null),
    });
    const act = SAMPLES["mcp-allow"].good;
    const r = await call(hub, post("/api/secrets/act", { act }, { cookie: `canopy_secrets=${TOKEN}` }));
    expect(r.status).toBe(409);
    expect(((await r.json()) as { error: string }).error).toContain("pull dotclaude");
    expect(asked).toEqual([]);
    const other = await call(hub, post("/api/secrets/act", { act: { ...act, server: "other" } }, { cookie: `canopy_secrets=${TOKEN}` }));
    expect(other.status).toBe(200);
  });

  test("an act carries the cookie's token down the socket", async () => {
    const { hub, asked } = writer((q) => (q.t === "act" ? { ok: true, data: { value: V, hideAfterMs: 20000 } } : { ok: true, data: {} }));
    const r = await call(hub, post("/api/secrets/act", { act: { a: "reveal", name: "cf_token" } }, { cookie: `canopy_secrets=${TOKEN}` }));
    expect(await r.json()).toEqual({ value: V, hideAfterMs: 20000 });
    expect(asked[0]).toEqual({ t: "act", token: TOKEN, act: { a: "reveal", name: "cf_token" } });
  });

  test("a gated route from another origin never reaches the socket", async () => {
    const { hub, asked } = writer();
    const r = await call(hub, post("/api/secrets/act", { act: { a: "reveal", name: "cf_token" } }, { origin: "http://mac.tail:7850", cookie: `canopy_secrets=${TOKEN}` }));
    expect(r.status).toBe(403);
    expect(asked).toEqual([]);
  });

  test("a bad act is refused before the socket", async () => {
    const { hub, asked } = writer();
    expect((await call(hub, post("/api/secrets/act", { act: { a: "get-all" } }))).status).toBe(400);
    expect(asked).toEqual([]);
  });

  test("proposals come from any allowed page, capped", async () => {
    const { hub, asked } = writer();
    const one = { from: "mac", source: "/Users/e/dev/.env", key: "A", sealed: "", merges: null };
    const big = Array.from({ length: 201 }, () => one);
    expect((await call(hub, post("/api/secrets/proposals", { items: big }, { origin: "http://mac.tail:7850" }))).status).toBe(400);
    expect((await call(hub, post("/api/secrets/proposals", { items: [one] }, { origin: "http://mac.tail:7850" }))).status).toBe(200);
    expect(asked.map((q) => q.t)).toEqual(["propose", "info"]);
  });

  test("the info answers under this backend's name; the service down is a 200 with the reason", async () => {
    const { hub } = writer((q) => (q.t === "info" ? { ok: true, data: { ok: true, backend: "mini", secrets: [] } } : { ok: true, data: {} }));
    const r = await call(hub, new Request("http://127.0.0.1:7850/api/secrets"));
    expect(((await r.json()) as SecretsInfo).backend).toBe("mini");
    const down = writer(() => ({ ok: false, error: "the secrets service is not answering" }));
    const d = (await (await call(down.hub, new Request("http://127.0.0.1:7850/api/secrets"))).json()) as SecretsInfo;
    expect(d).toMatchObject({ ok: false, error: "the secrets service is not answering", role: "writer" });
  });
});

describe("a reader", () => {
  function reader() {
    const calls: string[] = [];
    const stub = {
      info: (b: string) => ({ ok: true, backend: b, role: "reader", secrets: [] }),
      unlock: async (p: string) => {
        calls.push(`unlock ${p.length}`);
        return p === "correct horse battery" ? { ok: true } : { ok: false, error: "wrong passphrase" };
      },
      lockNow: () => void calls.push("lock"),
      createKey: async () => ({ recipient: "age1x" }),
      pull: async () => void calls.push("pull"),
      proposals: async () => ({ items: [], missing: [] }),
      take: async () => ({ error: "no" }),
      start: async () => {},
    } as unknown as SecretsReader;
    const hub = new SecretsHub({ backend: "mac", socket: null, gateOrigin: GATE, reader: stub, broadcast: () => {} });
    return { hub, calls };
  }

  test("unlock answers only its own page or a loopback caller, and never echoes the passphrase", async () => {
    const { hub, calls } = reader();
    const foreign = new Request("http://127.0.0.1:7850/api/secrets/unlock", { method: "POST", headers: { origin: GATE }, body: JSON.stringify({ passphrase: "correct horse battery" }) });
    expect((await call(hub, foreign)).status).toBe(403);
    expect(calls).toEqual([]);
    const own = new Request("http://127.0.0.1:7850/api/secrets/unlock", { method: "POST", body: JSON.stringify({ passphrase: "correct horse battery" }) });
    const r = await call(hub, own);
    expect(r.status).toBe(200);
    expect(await r.text()).not.toContain("correct horse");
    const wrong = new Request("http://127.0.0.1:7850/api/secrets/unlock", { method: "POST", body: JSON.stringify({ passphrase: "nope" }) });
    const w = await call(hub, wrong);
    expect(w.status).toBe(403);
    expect(await w.text()).not.toContain("nope");
  });

  test("the writer's routes point at the gate page", async () => {
    const { hub } = reader();
    const r = await call(hub, new Request("http://127.0.0.1:7850/api/secrets/audit"));
    expect(r.status).toBe(404);
    expect(((await r.json()) as { error: string }).error).toContain(`${GATE}/?view=secrets`);
  });

  test("other paths are not this hub's", async () => {
    const { hub } = reader();
    expect(await hub.handle(new Request("http://127.0.0.1:7850/api/secretsx"), new URL("http://127.0.0.1:7850/api/secretsx"))).toBeNull();
  });
});
