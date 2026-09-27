/**
 * The API is not for other web pages: a page on another origin can send a
 * form-style POST or open a websocket without any CORS preflight, and a
 * domain rebound to this address is same-origin to the browser. Against a
 * real server on a scratch root with one repo. Plain ptys
 * (`CANOPY_TMUX=0`), so nothing here touches a tmux server.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ClientInfo, TermInfo } from "../core/types";
import { startServer } from "./index";

let scratch: string;
let server: { port: number; stop: () => void };
const saved: Record<string, string | undefined> = {};

const api = (path: string) => `http://127.0.0.1:${server.port}${path}`;
const EVIL = "https://evil.example";
const PUBLIC = "https://canopy.example";
const LISTED = "https://canopy-mac.example";
const SERVED = "https://box.tail0000.ts.net:7850";

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "canopy-origin-"));
  for (const k of ["CANOPY_CONFIG_DIR", "CANOPY_TMUX", "CANOPY_BIND", "CANOPY_PUBLIC_ORIGIN", "CANOPY_ORIGINS"]) saved[k] = process.env[k];
  process.env["CANOPY_CONFIG_DIR"] = join(scratch, "config");
  process.env["CANOPY_TMUX"] = "0";
  delete process.env["CANOPY_BIND"];
  // the tunnel case: an authenticating proxy at this origin, on loopback
  process.env["CANOPY_PUBLIC_ORIGIN"] = PUBLIC;
  process.env["CANOPY_ORIGINS"] = `${LISTED},${SERVED}`;
  const repo = join(scratch, "root", "app");
  await Bun.$`mkdir -p ${repo} && git -C ${repo} init -q`.quiet();
  server = await startServer({ root: join(scratch, "root"), port: 0 });
});

afterAll(async () => {
  server.stop();
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  await rm(scratch, { recursive: true, force: true });
});

describe("who may call the API", () => {
  test("the page itself and a client with no origin (the CLI helper, curl) may", async () => {
    expect((await fetch(api("/api/tree"))).status).toBe(200);
    const same = await fetch(api("/api/repos/refresh?id=app"), {
      method: "POST",
      headers: { origin: `http://127.0.0.1:${server.port}`, "sec-fetch-site": "same-origin" },
    });
    expect(same.status).toBe(200);
    const byName = await fetch(api("/api/tree"), { headers: { host: `localhost:${server.port}`, origin: `http://localhost:${server.port}` } });
    expect(byName.status).toBe(200);
  });

  test("another origin may not, whatever it sends", async () => {
    const post = await fetch(api("/api/repos/refresh?id=app"), {
      method: "POST",
      headers: { origin: EVIL, "content-type": "text/plain" },
      body: "{}",
    });
    expect(post.status).toBe(403);
    // a browser that sends the fetch metadata but no origin
    const meta = await fetch(api("/api/tree"), { headers: { "sec-fetch-site": "cross-site" } });
    expect(meta.status).toBe(403);
    // the event stream is the API too
    expect((await fetch(api("/api/events"), { headers: { origin: EVIL } })).status).toBe(403);
  });

  test("a domain rebound to this address may not", async () => {
    const host = `rebind.evil.example:${server.port}`;
    expect((await fetch(api("/api/tree"), { headers: { host } })).status).toBe(403);
    expect((await fetch(api("/api/tree"), { headers: { host, origin: `http://${host}` } })).status).toBe(403);
  });

  test("a shell socket from another origin is refused before it upgrades", async () => {
    const term = "0123456789abcdef0123456789abcdef";
    const q = new URLSearchParams({ id: "app", term, place: "strip", cols: "80", rows: "24" });
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/api/term?${q}`, { headers: { origin: EVIL } });
    const opened = await new Promise<boolean>((resolve) => {
      ws.onopen = () => resolve(true);
      ws.onerror = () => resolve(false);
      ws.onclose = () => resolve(false);
    });
    if (opened) ws.close();
    expect(opened).toBe(false);
    const held = (await (await fetch(api("/api/terms"))).json()) as TermInfo[];
    expect(held.some((t) => t.id === term)).toBe(false);
  });

  test("the configured public origin may, through its proxy", async () => {
    const res = await fetch(api("/api/repos/refresh?id=app"), {
      method: "POST",
      headers: { host: "canopy.example", "x-forwarded-proto": "https", origin: PUBLIC },
    });
    expect(res.status).toBe(200);
  });

  test("a browser behind the tunnel is not on this machine, though the tunnel connects from loopback", async () => {
    const tunnelled = (await (
      await fetch(api("/api/client"), { headers: { host: "canopy.example", "x-forwarded-proto": "https" } })
    ).json()) as ClientInfo;
    expect(tunnelled.address).toBe("127.0.0.1");
    expect(tunnelled.local).toBe(false);
  });

  test("the static page is not gated", async () => {
    expect((await fetch(api("/"), { headers: { origin: EVIL } })).status).not.toBe(403);
  });
});

describe("another canopy page", () => {
  test("a listed origin's preflight is answered, an unlisted one is refused", async () => {
    const ok = await fetch(api("/api/repos/refresh?id=app"), {
      method: "OPTIONS",
      headers: { origin: LISTED, "access-control-request-method": "POST", "access-control-request-headers": "content-type" },
    });
    expect(ok.status).toBe(204);
    expect(ok.headers.get("access-control-allow-origin")).toBe(LISTED);
    expect(ok.headers.get("access-control-allow-credentials")).toBe("true");
    expect(ok.headers.get("access-control-allow-methods")).toContain("POST");
    const no = await fetch(api("/api/repos/refresh?id=app"), {
      method: "OPTIONS",
      headers: { origin: EVIL, "access-control-request-method": "POST" },
    });
    expect(no.status).toBe(403);
    expect(no.headers.get("access-control-allow-origin")).toBeNull();
  });

  test("a listed origin's calls go through and say so, cross-site or not", async () => {
    const res = await fetch(api("/api/repos/refresh?id=app"), {
      method: "POST",
      headers: { origin: LISTED, "sec-fetch-site": "cross-site", "content-type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe(LISTED);
    expect(res.headers.get("vary")).toBe("Origin");
  });

  test("a listed page's own GET behind tailscale serve carries no Origin and is let in", async () => {
    const res = await fetch(api("/api/tree"), { headers: { host: "box.tail0000.ts.net:7850", "sec-fetch-site": "same-origin" } });
    expect(res.status).toBe(200);
  });

  test("the event stream answers a listed origin with CORS", async () => {
    const res = await fetch(api("/api/events"), { headers: { origin: LISTED } });
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe(LISTED);
    await res.body?.cancel();
  });

  test("a listed origin opens a shell socket", async () => {
    const term = "abcdef0123456789abcdef0123456789";
    const q = new URLSearchParams({ id: "app", term, place: "strip", cols: "80", rows: "24" });
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/api/term?${q}`, { headers: { origin: LISTED } });
    const opened = await new Promise<boolean>((resolve) => {
      ws.onopen = () => resolve(true);
      ws.onerror = () => resolve(false);
      ws.onclose = () => resolve(false);
    });
    ws.close();
    await fetch(api(`/api/terms?term=${term}`), { method: "DELETE" });
    expect(opened).toBe(true);
  });

  test("nothing ever says any origin will do", async () => {
    for (const headers of [{}, { origin: LISTED }, { origin: EVIL }] as Record<string, string>[]) {
      const res = await fetch(api("/api/tree"), { headers });
      expect(res.headers.get("access-control-allow-origin")).not.toBe("*");
    }
  });
});
