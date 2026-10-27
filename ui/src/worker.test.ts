import { describe, expect, test } from "bun:test";
import type { BuildInfo } from "../../src/core/types";
import { cacheName, fetchPlan, keepable, shouldRegister, staleCaches, wantsUpdate } from "./worker";

const build: BuildInfo = { version: "0.2.0", commit: "1ac8fe7a1872d164d152626a8784b1426eee28b4", committedAt: "2026-10-26T12:42:06-07:00", dirty: false };
const origin = "https://canopy.example";
const plan = (path: string, mode = "cors", method = "GET") => fetchPlan({ method, mode, url: new URL(path, origin).href }, origin);

describe("worker cache boundaries", () => {
  test("page navigations share an offline shell regardless of repo query", () => {
    expect(plan("/", "navigate")).toBe("shell");
    expect(plan("/?repo=a&view=solo", "navigate")).toBe("shell");
    expect(plan("/agent/a", "navigate")).toBe("shell");
  });
  test("API, Library and worker metadata always pass through, even navigations", () => {
    for (const path of ["/api", "/api/", "/api/auth", "/api/events", "/api/term?repo=a", "/library", "/library/", "/library/index.html", "/sw.js", "/manifest.webmanifest", "/icons", "/icons/canopy-192.png"]) {
      expect(plan(path)).toBe("pass");
      expect(plan(path, "navigate")).toBe("pass");
    }
  });
  test("hashed assets keep their own cache key, including direct navigation", () => {
    expect(plan("/assets/index-abc123.js", "no-cors")).toBe("asset");
    expect(plan("/assets/index-abc123.js", "navigate")).toBe("asset");
  });
  test("other origins, writes and non-shell resources are never intercepted", () => {
    expect(plan("/", "navigate", "POST")).toBe("pass");
    expect(plan("/api/runs", "cors", "POST")).toBe("pass");
    expect(plan("https://peer.example/assets/a.js")).toBe("pass");
    expect(plan("http://canopy.example/assets/a.js")).toBe("pass");
    expect(plan("/favicon.ico")).toBe("pass");
  });
  test("redirected, cross-origin and failed answers never enter the cache", () => {
    expect(keepable({ status: 200, redirected: false, type: "basic" })).toBe(true);
    for (const response of [
      { status: 200, redirected: true, type: "basic" },
      { status: 302, redirected: false, type: "basic" },
      { status: 200, redirected: false, type: "cors" },
      { status: 0, redirected: false, type: "opaqueredirect" },
      { status: 500, redirected: false, type: "basic" },
    ]) expect(keepable(response)).toBe(false);
  });
});

test("a new build retires older caches and asks for an update only across versions", () => {
  const keep = cacheName(build);
  expect(keep).toBe("canopy-0.2.0 (1ac8fe7, 2026-10-26)");
  expect(staleCaches([keep, "canopy-old", "other"], keep)).toEqual(["canopy-old", "other"]);
  expect(wantsUpdate(build, { ...build, commit: "1ac8fe7" })).toBe(false);
  expect(wantsUpdate(build, { ...build, commit: "abcdef0" })).toBe(true);
  expect(wantsUpdate(build, null)).toBe(false);
  expect(wantsUpdate(null, build)).toBe(false);
});

test("registration requires a secure built page with service workers", () => {
  const eligible = { secure: true, dev: false, port: "7850", hasWorker: true };
  expect(shouldRegister(eligible)).toBe(true);
  expect(shouldRegister({ ...eligible, secure: false })).toBe(false);
  expect(shouldRegister({ ...eligible, dev: true })).toBe(false);
  expect(shouldRegister({ ...eligible, port: "7851" })).toBe(false);
  expect(shouldRegister({ ...eligible, hasWorker: false })).toBe(false);
});
