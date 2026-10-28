import { describe, expect, test } from "bun:test";
import { peersRoot } from "./peersroot";

const B = "http://127.0.0.1:7850";

describe("peersRoot", () => {
  test("--root wins, with no backend asked", () => {
    expect(peersRoot("/x/dev", "mac", B, { ok: false, reason: "refused" })).toEqual({ root: "/x/dev" });
  });

  test("otherwise the backend's own root", () => {
    expect(peersRoot(undefined, "mac", B, { ok: true, self: "mac", root: "/Users/e/dev" })).toEqual({ root: "/Users/e/dev" });
  });

  test("a backend that did not answer is an error, never the current directory", () => {
    const r = peersRoot(undefined, "mac", B, { ok: false, reason: "connection refused" });
    expect(r).toEqual({ error: expect.stringContaining("pass --root") });
    expect(r).toEqual({ error: expect.stringContaining("connection refused") });
  });

  test("another machine's backend is refused", () => {
    expect(peersRoot(undefined, "mac", B, { ok: true, self: "mini", root: "/home/eric/dev" })).toEqual({
      error: expect.stringContaining("is mini, not this machine (mac)"),
    });
  });

  test("an older backend with no root is refused", () => {
    expect(peersRoot(undefined, "mac", B, { ok: true, self: "mac" })).toEqual({ error: expect.stringContaining("does not say") });
    expect(peersRoot(undefined, "mac", B, { ok: true, self: "mac", root: "" })).toEqual({ error: expect.stringContaining("does not say") });
  });
});
