import { expect, test } from "bun:test";
import { portsFor, previewBlocked, previewPath, previewUrl, readChoices } from "./preview";

test("previewBlocked", () => {
  expect(previewBlocked({ protocol: "http:", hostname: "mini" })).toBeNull();
  expect(previewBlocked({ protocol: "https:", hostname: "localhost" })).toBeNull();
  expect(previewBlocked({ protocol: "https:", hostname: "canopy.example.com" })).toContain("tailnet");
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
