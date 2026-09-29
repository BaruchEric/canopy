import { afterAll, describe, expect, test } from "bun:test";
import {
  PreviewProxy,
  downstreamHeaders,
  dropFrameAncestors,
  parsePortRange,
  pickSlot,
  previewHostOk,
  previewable,
  rewriteLocation,
  upstreamHeaders,
} from "./preview";

test("parsePortRange", () => {
  expect(parsePortRange(undefined)).toEqual([7860, 7861, 7862, 7863, 7864, 7865, 7866, 7867, 7868, 7869]);
  expect(parsePortRange("9001, 9003-9004")).toEqual([9001, 9003, 9004]);
  expect(parsePortRange("0")).toEqual([]);
  expect(parsePortRange("off")).toEqual([]);
  expect(parsePortRange("")).toEqual([]);
  expect(parsePortRange("junk, 70000, 5")).toEqual([5]);
});

test("previewable", () => {
  expect(previewable(5173, [7850, 7860])).toBe(true);
  expect(previewable(7850, [7850, 7860])).toBe(false);
  expect(previewable(7860, [7850, 7860])).toBe(false);
  expect(previewable(0, [])).toBe(false);
  expect(previewable(65536, [])).toBe(false);
  expect(previewable("5173", [])).toBe(false);
  expect(previewable(1.5, [])).toBe(false);
});

describe("pickSlot", () => {
  test("reuses the slot on a port, fills free ones, then takes the oldest", () => {
    const map = new Map<number, number>();
    const used: number[] = [];
    const slots = [1, 2];
    expect(pickSlot(map, used, slots, 5173)).toBe(1);
    expect(pickSlot(map, used, slots, 3000)).toBe(2);
    expect(pickSlot(map, used, slots, 5173)).toBe(1); // already there, now newest
    expect(pickSlot(map, used, slots, 8080)).toBe(2); // 2 is the oldest
    expect([...map]).toEqual([
      [1, 5173],
      [2, 8080],
    ]);
  });
  test("none without slots", () => {
    expect(pickSlot(new Map(), [], [], 1)).toBeNull();
  });
});

test("upstreamHeaders swaps the preview's origin for the dev server's", () => {
  const h = new Headers({
    host: "mini:7860",
    origin: "http://mini:7860",
    referer: "http://mini:7860/about?x=1",
    "accept-encoding": "gzip, br",
    connection: "keep-alive",
    cookie: "a=1",
  });
  const out = upstreamHeaders(h, "http://mini:7860", "http://127.0.0.1:5173");
  expect(out.get("host")).toBe("localhost:5173");
  expect(out.get("origin")).toBe("http://localhost:5173");
  expect(out.get("referer")).toBe("http://localhost:5173/about?x=1");
  expect(out.get("accept-encoding")).toBe("identity");
  expect(out.get("connection")).toBeNull();
  expect(out.get("cookie")).toBe("a=1");
  // a foreign origin is passed as it came, for the dev server to judge
  expect(upstreamHeaders(new Headers({ origin: "http://evil" }), "http://mini:7860", "http://[::1]:5173").get("origin")).toBe(
    "http://evil",
  );
});

test("rewriteLocation", () => {
  const o = "http://mini:7860";
  expect(rewriteLocation("http://localhost:5173/login", 5173, o)).toBe("http://mini:7860/login");
  expect(rewriteLocation("http://127.0.0.1:5173", 5173, o)).toBe("http://mini:7860/");
  expect(rewriteLocation("http://localhost:4000/x", 5173, o)).toBe("http://localhost:4000/x");
  expect(rewriteLocation("/relative", 5173, o)).toBe("/relative");
  expect(rewriteLocation("https://github.com/login", 5173, o)).toBe("https://github.com/login");
});

test("dropFrameAncestors", () => {
  expect(dropFrameAncestors("default-src 'self'; frame-ancestors 'none'")).toBe("default-src 'self'");
  expect(dropFrameAncestors("frame-ancestors 'self'")).toBeNull();
});

test("downstreamHeaders lets canopy frame the app and keeps every cookie", () => {
  const h = new Headers();
  h.set("x-frame-options", "DENY");
  h.set("content-security-policy", "frame-ancestors 'none'");
  h.set("location", "http://localhost:5173/next");
  h.set("content-type", "text/html");
  h.append("set-cookie", "a=1; Path=/");
  h.append("set-cookie", "b=2; Path=/");
  const out = downstreamHeaders(h, 5173, "http://mini:7860");
  expect(out.get("x-frame-options")).toBeNull();
  expect(out.get("content-security-policy")).toBeNull();
  expect(out.get("location")).toBe("http://mini:7860/next");
  expect(out.get("content-type")).toBe("text/html");
  expect(out.getSetCookie()).toEqual(["a=1; Path=/", "b=2; Path=/"]);
});

test("previewHostOk", () => {
  const tail = (h: string) => h === "mini";
  expect(previewHostOk("localhost", false, tail)).toBe(true);
  expect(previewHostOk("127.0.0.1", false, tail)).toBe(true);
  expect(previewHostOk("mini", false, tail)).toBe(false);
  expect(previewHostOk("mini", true, tail)).toBe(true);
  expect(previewHostOk("evil.example", true, tail)).toBe(false);
});

describe("PreviewProxy against a dev server", () => {
  // a stand-in dev server: a page, a redirect, a framing ban, a POST echo,
  // the Host it was asked with, and a websocket that echoes under a protocol
  const dev = Bun.serve<{ proto: string }>({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req, srv) {
      const url = new URL(req.url);
      if (url.pathname === "/hmr") {
        const proto = req.headers.get("sec-websocket-protocol") ?? "";
        return srv.upgrade(req, { data: { proto }, headers: proto ? { "Sec-WebSocket-Protocol": proto } : undefined })
          ? undefined
          : new Response("no", { status: 400 });
      }
      if (url.pathname === "/go") return Response.redirect(`http://localhost:${srv.port}/landed`, 302);
      if (url.pathname === "/echo") return new Response(req.body);
      return new Response(`host=${req.headers.get("host")} path=${url.pathname}`, {
        headers: { "x-frame-options": "DENY" },
      });
    },
    websocket: {
      message(ws, msg) {
        ws.send(`${ws.data.proto}:${String(msg)}`);
      },
    },
  });
  const devPort = dev.port as number;
  const slotPort = 20000 + Math.floor(Math.random() * 20000);
  const proxy = new PreviewProxy([slotPort], {
    bind: "127.0.0.1",
    own: () => 1,
    hostOk: (h) => h === "127.0.0.1",
    publicTemplate: "https://p{slot}.example.com",
  });
  afterAll(() => {
    proxy.stop();
    dev.stop(true);
  });
  const base = `http://127.0.0.1:${slotPort}`;

  test("a slot with nothing on it says so", async () => {
    expect(await proxy.serve(devPort)).toBe(slotPort);
  });

  test("pages, redirects and framing", async () => {
    const r = await fetch(`${base}/src/main.tsx`);
    expect(await r.text()).toBe(`host=localhost:${devPort} path=/src/main.tsx`);
    expect(r.headers.get("x-frame-options")).toBeNull();
    const go = await fetch(`${base}/go`, { redirect: "manual" });
    expect(go.status).toBe(302);
    expect(go.headers.get("location")).toBe(`${base}/landed`);
    const echo = await fetch(`${base}/echo`, { method: "POST", body: "hello" });
    expect(await echo.text()).toBe("hello");
  });

  test("the slot's public name is let in, and a redirect lands on its https origin", async () => {
    const pub = `https://p${slotPort}.example.com`;
    const go = await fetch(`${base}/go`, { redirect: "manual", headers: { host: `p${slotPort}.example.com` } });
    expect(go.status).toBe(302);
    expect(go.headers.get("location")).toBe(`${pub}/landed`);
    // another slot's public name is not this one's
    const other = await fetch(`${base}/`, { headers: { host: `p${slotPort + 1}.example.com` } });
    expect(other.status).toBe(403);
  });

  test("a foreign Host is refused", async () => {
    const r = await fetch(`${base}/`, { headers: { host: `evil.example:${slotPort}` } });
    expect(r.status).toBe(403);
  });

  test("websockets pass through with their protocol", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${slotPort}/hmr?token=t`, ["vite-hmr"]);
    const got = await new Promise<string>((resolve, reject) => {
      ws.onopen = () => ws.send("ping");
      ws.onmessage = (e) => resolve(String(e.data));
      ws.onerror = () => reject(new Error("socket failed"));
    });
    expect(ws.protocol).toBe("vite-hmr");
    expect(got).toBe("vite-hmr:ping");
    ws.close();
  });

  test("nothing listening is a page, not a hang", async () => {
    const gone = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("x") });
    const p = gone.port as number;
    gone.stop(true);
    await proxy.serve(p);
    const r = await fetch(`${base}/`);
    expect(r.status).toBe(502);
    expect(await r.text()).toContain(`port ${p}`);
  });
});
