import { expect, test } from "bun:test";
import { PREVIEW_H, defaultPort, portsFor, previewBlocked, previewHeightOf, previewPath, previewUrl, readChoices } from "./preview";

test("previewBlocked", () => {
  expect(previewBlocked({ protocol: "http:", hostname: "mini" })).toBeNull();
  expect(previewBlocked({ protocol: "https:", hostname: "localhost" })).toBeNull();
  expect(previewBlocked({ protocol: "https:", hostname: "canopy.example.com" })).toContain("tailnet");
  // a backend with public preview names serves an https page too
  expect(previewBlocked({ protocol: "https:", hostname: "canopy.example.com" }, "https://p{slot}.example.com")).toBeNull();
});

test("previewPath", () => {
  expect(previewPath("")).toBe("/");
  expect(previewPath("about")).toBe("/about");
  expect(previewPath(" /a?b=1#c ")).toBe("/a?b=1#c");
  expect(previewPath("http://localhost:5173")).toBe("/");
  expect(previewPath("http://localhost:5173/login?next=/")).toBe("/login?next=/");
});

test("previewUrl", () => {
  expect(previewUrl({ hostname: "mini" }, 7860, "about")).toBe("http://mini:7860/about");
  expect(previewUrl({ hostname: "100.64.0.2" }, 7861, "/")).toBe("http://100.64.0.2:7861/");
  const pub = "https://p{slot}.example.com";
  // an https page off this machine goes to the slot's public name
  expect(previewUrl({ protocol: "https:", hostname: "canopy.example.com" }, 7860, "a", pub)).toBe("https://p7860.example.com/a");
  // a tailnet page keeps the slot's own port, public names or not
  expect(previewUrl({ protocol: "http:", hostname: "mini" }, 7860, "a", pub)).toBe("http://mini:7860/a");
});

test("portsFor", () => {
  const ports = [
    { port: 3000, repo: "a" },
    { port: 5173, repo: "b" },
    { port: 8080 },
  ];
  expect(portsFor(ports, "b")).toEqual({ mine: [{ port: 5173, repo: "b" }], loose: [{ port: 8080 }] });
});

test("readChoices", () => {
  expect(readChoices(null)).toEqual({});
  expect(readChoices("nope")).toEqual({});
  expect(readChoices(JSON.stringify({ a: { port: 5173, path: "x" }, b: { port: "1" }, c: { port: 3000 } }))).toEqual({
    a: { port: 5173, path: "/x" },
    c: { port: 3000, path: "/" },
  });
});

test("defaultPort takes the repo's lowest port, so an app with a kiosk beside it opens the app", () => {
  expect(defaultPort([{ port: 5178, repo: "a" }, { port: 5173, repo: "a" }])).toBe(5173);
  expect(defaultPort([{ port: 3000, repo: "a" }])).toBe(3000);
  expect(defaultPort([])).toBeNull();
});

test("another machine's app previews through its public names only on a page of their own site", () => {
  const pub = "https://canopy-mac-p{slot}.example.com";
  const site = { protocol: "https:", hostname: "canopy.example.com" };
  expect(previewUrl(site, 7860, "/", pub, false)).toBe("https://canopy-mac-p7860.example.com/");
  expect(previewBlocked(site, pub, false)).toBeNull();
  // an http page is another site: the gate's Lax cookie stays out of the frame
  expect(previewUrl({ protocol: "http:", hostname: "127.0.0.1" }, 7860, "/", pub, false)).toBeNull();
  expect(previewBlocked({ protocol: "http:", hostname: "127.0.0.1" }, pub, false)).toContain("only open inside a page on that site");
  // without names or an address nothing of it is reachable
  expect(previewBlocked({ protocol: "http:", hostname: "mini" }, null, false)).toContain("public preview names");
});

test("an http page frames another machine's app at its tailnet IP", () => {
  const pub = "https://canopy-p{slot}.example.com";
  const loop = { protocol: "http:", hostname: "127.0.0.1" };
  expect(previewUrl(loop, 7861, "a", pub, false, "100.68.139.95")).toBe("http://100.68.139.95:7861/a");
  expect(previewBlocked(loop, pub, false, "100.68.139.95")).toBeNull();
  // this backend's own app stays on the page's host
  expect(previewUrl(loop, 7861, "a", pub, true, "100.68.139.95")).toBe("http://127.0.0.1:7861/a");
});

test("an https page off the public names' site frames nothing", () => {
  const pub = "https://canopy-p{slot}.example.com";
  const tail = { protocol: "https:", hostname: "macmini.tail1.ts.net" };
  // http is mixed content there, and the names' gate turns a cross-site frame away
  expect(previewUrl(tail, 7860, "/", pub, true, "100.68.139.95")).toBeNull();
  expect(previewBlocked(tail, pub, false, "100.68.139.95")).toContain("gate");
  expect(previewBlocked(tail, pub, true)).toContain("gate");
  // an https loopback page still frames its own backend's http ports
  expect(previewUrl({ protocol: "https:", hostname: "localhost" }, 7860, "/", pub)).toBe("http://localhost:7860/");
});

test("a saved preview height is clamped, and anything else is the default", () => {
  expect(previewHeightOf(800)).toBe(800);
  expect(previewHeightOf(40)).toBe(PREVIEW_H.min);
  expect(previewHeightOf(1e6)).toBe(PREVIEW_H.max);
  expect(previewHeightOf(612.4)).toBe(612);
  expect(previewHeightOf("800")).toBe(PREVIEW_H.initial);
  expect(previewHeightOf(Number.NaN)).toBe(PREVIEW_H.initial);
});
