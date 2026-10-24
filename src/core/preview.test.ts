import { afterAll, describe, expect, test } from "bun:test";
import {
  DOWN_RETRY,
  PreviewProxy,
  down,
  downstreamHeaders,
  dropFrameAncestors,
  injectable,
  parsePortRange,
  pickSlot,
  previewHostOk,
  previewable,
  rewriteLocation,
  upstreamHeaders,
} from "./preview";
import { PICK_PATH, PICK_SCRIPT, PICK_TAG } from "./pickscript";

test("parsePortRange", () => {
  expect(parsePortRange(undefined)).toEqual([7860, 7861, 7862, 7863, 7864, 7865, 7866, 7867, 7868, 7869]);
  expect(parsePortRange("9001, 9003-9004")).toEqual([9001, 9003, 9004]);
  expect(parsePortRange("0")).toEqual([]);
  expect(parsePortRange("off")).toEqual([]);
  expect(parsePortRange("")).toEqual([]);
  expect(parsePortRange("junk, 70000, 5")).toEqual([5]);
});

test("a down port's page tries again on its own", async () => {
  const r = down(5173);
  expect(r.status).toBe(502);
  const html = await r.text();
  expect(html).toContain(`<meta http-equiv="refresh" content="${DOWN_RETRY}">`);
  expect(html).toContain("port 5173");
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

test("injectable: GET 200 HTML loaded as a document or frame", () => {
  expect(injectable("GET", 200, "text/html; charset=utf-8", null)).toBe(true);
  expect(injectable("GET", 200, "TEXT/HTML", "document")).toBe(true);
  expect(injectable("GET", 200, "text/html", "iframe")).toBe(true);
  expect(injectable("GET", 200, "text/html", "empty")).toBe(false);
  expect(injectable("GET", 200, "text/html", "script")).toBe(false);
  expect(injectable("GET", 404, "text/html", null)).toBe(false);
  expect(injectable("HEAD", 200, "text/html", null)).toBe(false);
  expect(injectable("GET", 200, "application/json", null)).toBe(false);
  expect(injectable("GET", 200, "text/htmlx", null)).toBe(false);
  expect(injectable("GET", 200, null, null)).toBe(false);
});

describe("the picker script", () => {
  type Listener = (e: unknown) => void;
  // the script run against a stand-in window, framed by `parent` or not
  function load(framed: boolean) {
    const listeners = new Map<string, Listener[]>();
    const sent: { msg: unknown; origin: string }[] = [];
    const parent = { postMessage: (msg: unknown, origin: string) => void sent.push({ msg, origin }) };
    const win: Record<string, unknown> = {
      addEventListener: (t: string, f: Listener) => listeners.set(t, [...(listeners.get(t) ?? []), f]),
      removeEventListener: (t: string, f: Listener) => listeners.set(t, (listeners.get(t) ?? []).filter((g) => g !== f)),
      getComputedStyle: () => ({ getPropertyValue: (p: string) => (p === "color" ? "red" : "") }),
    };
    win.parent = framed ? parent : win;
    win.innerWidth = 800;
    win.innerHeight = 600;
    type El = { style: Record<string, string>; children: El[]; textContent?: string; parentNode?: { removeChild: (c: El) => void } | null; setAttribute(): void; appendChild(c: El): void };
    const body: { added: El[]; appendChild(c: El): void; removeChild(c: El): void } = {
      added: [],
      appendChild(c) {
        body.added.push(c);
        c.parentNode = body;
      },
      removeChild(c) {
        body.added = body.added.filter((x) => x !== c);
      },
    };
    const element = (): El => {
      const el: El = { style: {}, children: [], setAttribute() {}, appendChild: (c) => void el.children.push(c) };
      return el;
    };
    const found = (sel: string) => (sel === "h1.title" ? { getBoundingClientRect: () => ({ left: 10, top: 20, right: 110, width: 100, height: 30 }) } : null);
    const doc = { body, documentElement: {}, createElement: element, querySelector: found };
    new Function("window", "document", "location", "CSS", PICK_SCRIPT)(win, doc, { pathname: "/a", search: "?b=1" }, undefined);
    const fire = (type: string, e: unknown) => {
      for (const f of listeners.get(type) ?? []) f(e);
    };
    const count = (type: string) => listeners.get(type)?.length ?? 0;
    return { sent, parent, fire, count, body };
  }
  const canopy = "http://canopy:7850";
  const enable = { canopy: "pick", on: true };
  const ev = (more: object) => ({ preventDefault() {}, stopPropagation() {}, ...more });
  const h1 = {
    nodeType: 1,
    tagName: "H1",
    id: "",
    className: "title big",
    parentElement: null,
    outerHTML: "<h1 class=\"title big\">Hello</h1>",
    innerText: " Hello ",
    getBoundingClientRect: () => ({ left: 1.4, top: 2, width: 30, height: 4.6 }),
  };

  test("is inert in a page that is not framed", () => {
    expect(load(false).count("message")).toBe(0);
  });

  test("answers only its parent, and only to the origin that turned it on", () => {
    const p = load(true);
    p.fire("message", { source: {}, origin: canopy, data: enable });
    expect(p.sent).toEqual([]);
    expect(p.count("click")).toBe(0);
    p.fire("message", { source: p.parent, origin: canopy, data: enable });
    expect(p.sent).toEqual([{ msg: { canopy: "pick-ready" }, origin: canopy }]);
    expect(p.count("click")).toBe(1);
    // every enable is acked, already on or not, and nothing doubles
    p.fire("message", { source: p.parent, origin: canopy, data: enable });
    expect(p.sent).toHaveLength(2);
    expect(p.count("click")).toBe(1);
  });

  test("a click reports the element and stops", () => {
    const p = load(true);
    p.fire("message", { source: p.parent, origin: canopy, data: enable });
    p.fire("click", ev({ target: h1 }));
    expect(p.sent[1]).toEqual({
      origin: canopy,
      msg: {
        canopy: "picked",
        selector: "h1.title.big",
        html: h1.outerHTML,
        text: "Hello",
        path: "/a?b=1",
        styles: expect.objectContaining({ color: "red" }),
        rect: { x: 1, y: 2, width: 30, height: 5 },
      },
    });
    expect(p.count("click")).toBe(0);
    expect(p.count("mousemove")).toBe(0);
  });

  test("numbers the elements the parent names, follows a scroll, and clears", () => {
    const p = load(true);
    p.fire("message", { source: {}, origin: canopy, data: { canopy: "marks", list: ["h1.title"] } });
    expect(p.body.added).toHaveLength(0);
    p.fire("message", { source: p.parent, origin: canopy, data: { canopy: "marks", list: ["h1.title", "nope", 3] } });
    const layer = p.body.added[0];
    expect(layer?.children.map((b) => [b.textContent, b.style.display])).toEqual([
      ["1", "flex"],
      ["2", "none"],
    ]);
    expect(layer?.children[0]?.style.left).toBe("101px");
    expect(layer?.children[0]?.style.top).toBe("11px");
    expect(p.count("scroll")).toBe(1);
    p.fire("message", { source: p.parent, origin: canopy, data: { canopy: "marks", list: [] } });
    expect(p.body.added).toHaveLength(0);
    expect(p.count("scroll")).toBe(0);
  });

  test("Esc stops it and tells the parent; the parent can stop it too", () => {
    const p = load(true);
    p.fire("message", { source: p.parent, origin: canopy, data: enable });
    p.fire("keydown", ev({ key: "Escape" }));
    expect(p.sent[1]).toEqual({ msg: { canopy: "pick-off" }, origin: canopy });
    expect(p.count("keydown")).toBe(0);
    p.fire("message", { source: p.parent, origin: canopy, data: enable });
    p.fire("message", { source: p.parent, origin: canopy, data: { canopy: "pick", on: false } });
    expect(p.count("click")).toBe(0);
  });
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
      const html = { "content-type": "text/html; charset=utf-8" };
      if (url.pathname === "/page") return new Response("<html><head><title>t</title></head><body><h1>hi</h1></body></html>", { headers: html });
      if (url.pathname === "/bare") return new Response("<h1>hi</h1>", { headers: html });
      if (url.pathname === "/missing") return new Response("<html><head></head><body>no</body></html>", { status: 404, headers: html });
      if (url.pathname === "/api") return Response.json({ html: "<head></head>" });
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

  test("a page loaded as a document or frame gets the picker, in its head", async () => {
    const plain = await (await fetch(`${base}/page`)).text();
    expect(plain).toBe(`<html><head><title>t</title>${PICK_TAG}</head><body><h1>hi</h1></body></html>`);
    const framed = await (await fetch(`${base}/page`, { headers: { "sec-fetch-dest": "iframe" } })).text();
    expect(framed).toContain(PICK_TAG);
    // a page without a head or body still gets it, at its end
    expect(await (await fetch(`${base}/bare`)).text()).toBe(`<h1>hi</h1>${PICK_TAG}`);
  });

  test("JSON, fragments and non-200 pages pass untouched", async () => {
    expect(await (await fetch(`${base}/api`)).json()).toEqual({ html: "<head></head>" });
    const frag = await (await fetch(`${base}/page`, { headers: { "sec-fetch-dest": "empty" } })).text();
    expect(frag).not.toContain(PICK_PATH);
    const missing = await fetch(`${base}/missing`);
    expect(missing.status).toBe(404);
    expect(await missing.text()).not.toContain(PICK_PATH);
    const post = await (await fetch(`${base}/page`, { method: "POST", body: "x" })).text();
    expect(post).not.toContain(PICK_PATH);
  });

  test("the picker is served ahead of the dev server, behind the host check", async () => {
    const r = await fetch(`${base}${PICK_PATH}`);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("javascript");
    expect(await r.text()).toBe(PICK_SCRIPT);
    expect((await fetch(`${base}${PICK_PATH}`, { headers: { host: `evil.example:${slotPort}` } })).status).toBe(403);
  });

  test("the picker answers on a slot with no port mapped", async () => {
    const slot = slotPort + 1;
    const lone = new PreviewProxy([slot], { bind: "127.0.0.1", own: () => 1, hostOk: (h) => h === "127.0.0.1" });
    try {
      expect(await lone.serve(devPort)).toBe(slot);
      (lone as unknown as { map: Map<number, number> }).map.clear();
      expect((await fetch(`http://127.0.0.1:${slot}/`)).status).toBe(404);
      const r = await fetch(`http://127.0.0.1:${slot}${PICK_PATH}`);
      expect(r.status).toBe(200);
      expect(await r.text()).toBe(PICK_SCRIPT);
    } finally {
      lone.stop();
    }
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
