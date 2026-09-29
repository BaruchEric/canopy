import { expect, test } from "bun:test";
import { defaultPort, portsFor, previewBlocked, previewPath, previewUrl, readChoices } from "./preview";

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

test("another machine's app previews through its public names, on any page", () => {
  const pub = "https://canopy-mac-p{slot}.example.com";
  expect(previewUrl({ protocol: "http:", hostname: "mini" }, 7860, "/", pub, false)).toBe("https://canopy-mac-p7860.example.com/");
  expect(previewBlocked({ protocol: "http:", hostname: "mini" }, pub, false)).toBeNull();
  // without them nothing of it is reachable: its ports are its own loopback
  expect(previewBlocked({ protocol: "http:", hostname: "mini" }, null, false)).toContain("public preview names");
});
