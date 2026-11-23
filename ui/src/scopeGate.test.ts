import { describe, expect, test } from "bun:test";
import { heldEverywhere, isScoped, needOf, roleRefusal, ScopeBook, scopedOr, scopeReaches, scopeRefusal, viewShown } from "./scopeGate";

describe("what a held page asks for", () => {
  test("the board's routes and the open ones; never a closed one", () => {
    expect(scopeReaches("GET", "/api/tree")).toBe(true);
    expect(scopeReaches("GET", "/api/runs?kept=1")).toBe(true);
    expect(scopeReaches("GET", "/api/repos/log?id=abc")).toBe(true);
    expect(scopeReaches("GET", "/api/about")).toBe(true);
    expect(scopeReaches("GET", "/api/auth")).toBe(true);
    expect(scopeReaches("POST", "/api/auth/ticket")).toBe(true);
    for (const p of ["/api/landing", "/api/kit", "/api/health", "/api/notes", "/api/clips", "/api/work", "/api/sources"]) expect(scopeReaches("GET", p)).toBe(false);
    expect(scopeReaches("POST", "/api/repos/archive?id=abc")).toBe(false);
  });

  test("a closed route's refusal is the backend's own shape", () => {
    const e = scopeRefusal();
    expect(e.status).toBe(403);
    expect(e.body.scoped).toBe(true);
    expect(e.message).toBe(e.body.error);
  });
});

describe("what the page knows of each backend", () => {
  test("a request waits for the auth answer, then has it", async () => {
    const book = new ScopeBook();
    expect(book.now("home")).toBeNull();
    const asked = book.scoped("home");
    book.known("home", true);
    expect(await asked).toBe(true);
    expect(await book.scoped("home")).toBe(true);
    book.unknown("home");
    expect(book.now("home")).toBeNull();
    const again = book.scoped("home");
    book.known("home", false);
    expect(await again).toBe(false);
  });

  test("a backend that never says is taken for one that does not hold the page", async () => {
    const book = new ScopeBook();
    expect(await book.scoped("old", 5)).toBe(false);
  });

  test("backends are apart", async () => {
    const book = new ScopeBook();
    book.known("mini", true);
    book.known("desoto", false);
    expect(await book.scoped("mini")).toBe(true);
    expect(await book.scoped("desoto")).toBe(false);
  });
});

describe("a drop", () => {
  test("a page held before a drop stays held when the read after it fails", async () => {
    const book = new ScopeBook();
    book.known("home", true);
    book.unknown("home");
    const waiting = book.scoped("home", 1000);
    book.failed("home");
    expect(await waiting).toBe(true);
  });

  test("a backend never heard from holds nothing back", async () => {
    const book = new ScopeBook();
    const waiting = book.scoped("home", 1000);
    book.failed("home");
    expect(await waiting).toBe(false);
  });
});

describe("the views a held page shows", () => {
  test("only when every backend holds it", () => {
    const held = { scope: ["/srv/rio"] };
    expect(heldEverywhere(["home"], { home: held })).toBe(true);
    expect(heldEverywhere(["home", "mini"], { home: held, mini: { scope: null } })).toBe(false);
    expect(heldEverywhere(["home", "mini"], { home: held })).toBe(false);
    expect(heldEverywhere([], {})).toBe(false);
  });

  test("the board, the shells and the people", () => {
    for (const v of ["git", "sessions", "people"]) expect(viewShown(v, true)).toBe(true);
    for (const v of ["kit", "work", "health", "library", "manager", "secrets"]) expect(viewShown(v, true)).toBe(false);
    expect(viewShown("kit", false)).toBe(true);
  });
});

describe("a read a held page goes without", () => {
  test("the wall's refusal answers empty", () => {
    expect(isScoped(scopeRefusal())).toBe(true);
    expect(scopedOr<string[]>([])(scopeRefusal())).toEqual([]);
  });

  test("any other failure still fails", () => {
    const other = Object.assign(new Error("no"), { status: 500, body: { error: "no" } });
    expect(isScoped(other)).toBe(false);
    expect(() => scopedOr<string[]>([])(other)).toThrow("no");
  });
});

describe("a role, as the page keeps to it", () => {
  test("needs the server's right for a route, its query aside", () => {
    expect(needOf("GET", "/api/repos/log?id=a")).toBe("operate");
    expect(needOf("GET", "/api/tree")).toBe("read");
    expect(needOf("GET", "/api/about")).toBe("open");
  });

  test("refuses as the backend does, so the page reads it the same", () => {
    const err = roleRefusal("operate");
    expect(err.status).toBe(403);
    expect(err.body.need).toBe("operate");
    expect(err.message).toContain("your role on this backend does not hold it");
  });
});
