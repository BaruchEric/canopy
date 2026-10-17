import { describe, expect, test } from "bun:test";
import type { PendingPair } from "../../src/core/types";
import { dialPlan, isOwnCode, originOf, pairAsk, pairKey, pairLabel, readPair, readToken, TOKEN_HEADER, tokenHeaders, tokenKey, writePair, writeToken } from "./callerToken";

/** a localStorage stand-in, or one that throws the way a blocked one does */
function storage(blocked = false) {
  const m = new Map<string, string>();
  const no = () => {
    throw new Error("SecurityError: storage is blocked");
  };
  return {
    m,
    getItem: (k: string) => (blocked ? no() : (m.get(k) ?? null)),
    setItem: (k: string, v: string) => (blocked ? no() : void m.set(k, v)),
    removeItem: (k: string) => (blocked ? no() : void m.delete(k)),
  };
}

describe("this page's caller tokens", () => {
  test("each backend's token is kept under its own origin, apart from the others", () => {
    const st = storage();
    expect(writeToken("http://a:7850", "cnp_page_a", st)).toBe(true);
    expect(writeToken("http://b:7850", "cnp_page_b", st)).toBe(true);
    expect(st.m.get("canopy.token.http://a:7850")).toBe("cnp_page_a");
    expect(tokenKey("http://b:7850")).toBe("canopy.token.http://b:7850");
    expect(readToken("http://a:7850", st)).toBe("cnp_page_a");
    expect(readToken("http://b:7850", st)).toBe("cnp_page_b");
    expect(writeToken("http://a:7850", null, st)).toBe(true);
    expect(readToken("http://a:7850", st)).toBeNull();
    expect(readToken("http://b:7850", st)).toBe("cnp_page_b");
  });

  test("a waiting sign-in is held per origin until its window passes, and a bad entry reads as none", () => {
    const st = storage();
    const pair = { id: "p1", secret: "s3", code: "K7QX", until: 1_000 };
    writePair("http://a:7850", pair, st);
    expect(readPair("http://a:7850", 999, st)).toEqual(pair);
    expect(readPair("http://b:7850", 999, st)).toBeNull();
    expect(readPair("http://a:7850", 1_000, st)).toBeNull();
    st.m.set(pairKey("http://b:7850"), '{"id":"p1"}');
    expect(readPair("http://b:7850", 0, st)).toBeNull();
    st.m.set(pairKey("http://b:7850"), "not json");
    expect(readPair("http://b:7850", 0, st)).toBeNull();
    writePair("http://a:7850", null, st);
    expect(st.m.has(pairKey("http://a:7850"))).toBe(false);
  });

  test("tokenHeaders adds the token when there is one and nothing when there is none, keeping what was passed", () => {
    const st = storage();
    st.m.set(tokenKey("http://a:7850"), "cnp_page_a");
    const a = tokenHeaders("http://a:7850", { "Content-Type": "application/json" }, st);
    expect(a.get(TOKEN_HEADER)).toBe("cnp_page_a");
    expect(a.get("content-type")).toBe("application/json");
    const b = tokenHeaders("http://b:7850", undefined, st);
    expect(b.get(TOKEN_HEADER)).toBeNull();
    expect([...b.keys()]).toEqual([]);
  });

  test("a throwing storage reads as no token, and a write is silent", () => {
    expect(readToken("http://a:7850", storage(true))).toBeNull();
    expect(writeToken("http://a:7850", "t", storage(true))).toBe(false);
    expect(tokenHeaders("http://a:7850", undefined, storage(true)).get(TOKEN_HEADER)).toBeNull();
    expect(readToken("http://a:7850", null)).toBeNull();
    expect(writeToken("http://a:7850", "t", null)).toBe(false);
  });

  test("a base's origin: the page's own for an empty base, else the URL's", () => {
    expect(originOf("http://b.test:7850/")).toBe("http://b.test:7850");
    expect(originOf("https://canopy-mac.beric.ca")).toBe("https://canopy-mac.beric.ca");
    // no page here (bun test): the empty base has no origin of its own
    expect(originOf("")).toBe("");
  });

  test("a shell's dial: with its ticket, bare where nothing is enforced, else it waits for a sign-in", () => {
    expect(dialPlan("enforce", "t1", false)).toEqual({ kind: "ticket", ticket: "t1" });
    expect(dialPlan("log", "t1", false)).toEqual({ kind: "ticket", ticket: "t1" });
    expect(dialPlan("enforce", null, false)).toEqual({ kind: "wait" });
    expect(dialPlan("enforce", null, true)).toEqual({ kind: "wait" });
    // a refused ticket on a backend whose mode is not read yet is enforce's
    expect(dialPlan(undefined, null, true)).toEqual({ kind: "wait" });
    // log and off let a bare dial through, even after a refused ticket
    expect(dialPlan("log", null, false)).toEqual({ kind: "bare" });
    expect(dialPlan("log", null, true)).toEqual({ kind: "bare" });
    expect(dialPlan("off", null, true)).toEqual({ kind: "bare" });
    // an older backend with no caller check
    expect(dialPlan(undefined, null, false)).toEqual({ kind: "bare" });
  });

  test("a page's pair label never reads as the CLI's or the helper's", () => {
    expect(pairLabel("Chrome on Mac")).toBe("Chrome on Mac");
    expect(pairLabel("cli mac")).toBe("page cli mac");
    expect(pairLabel("helper x")).toBe("page helper x");
    expect(pairLabel("  ")).toBe("a browser");
  });
});

describe("the pair card", () => {
  const ask = (label: string, kind: "page" | "cli" | "helper") => pairAsk({ id: "i", label, addr: "10.0.0.2", code: "CLVKN6", at: 1, kind }, "mini");
  const text = (a: ReturnType<typeof ask>) => `${a.head} ${a.rights.join(", ")}`;

  test("names the kind and the rights it grants", () => {
    expect(text(ask("cli Erics-MacBook-Pro", "cli"))).toBe("cli Erics-MacBook-Pro asks to sign in to mini, from 10.0.0.2. It would get cli rights: read, operate, admin");
    expect(text(ask("helper mac", "helper"))).toBe("helper mac asks to sign in to mini, from 10.0.0.2. It would get helper rights: helper");
    expect(text(ask("Chrome on Mac", "page"))).toBe("Chrome on Mac asks to sign in to mini, from 10.0.0.2. It would get page rights: read, operate, shell, admin");
  });

  test("a label that poses as another kind does not hide the kind", () => {
    expect(text(ask("cli mac", "page"))).toContain("It would get page rights: read, operate, shell, admin");
  });

  test("admin is flagged, and a helper has none", () => {
    expect(ask("x", "cli").admin).toBe(true);
    expect(ask("x", "helper").admin).toBe(false);
  });

  test("no backend name leaves the 'to' out", () => {
    expect(pairAsk({ id: "i", label: "x", addr: "a", code: "C", at: 1, kind: "cli" }, "").head).toBe("x asks to sign in, from a. It would get cli rights:");
  });

  test("a pending pair from an older backend has no kind: the label rule applies", () => {
    const old = (label: string) => pairAsk({ id: "i", label, addr: "a", code: "C", at: 1 } as unknown as PendingPair, "mini");
    expect(old("cli mac").rights).toEqual(["read", "operate", "admin"]);
    expect(old("helper mac").rights).toEqual(["helper"]);
    expect(old("Chrome").rights).toEqual(["read", "operate", "shell", "admin"]);
    expect(old("cli mac").head).toContain("It would get cli rights");
  });

  test("a long label is cut for the card and kept whole for the title", () => {
    const long = "x".repeat(60);
    const a = ask(long, "page");
    expect(a.head.startsWith(`${"x".repeat(39)}\u2026 asks`)).toBe(true);
    expect(a.title).toBe(long);
  });
});

describe("the first code box", () => {
  test("typing the pair's own code is caught, in any case and with spaces", () => {
    expect(isOwnCode("CLVKN6", "CLVKN6")).toBe(true);
    expect(isOwnCode("  clvkn6 ", "CLVKN6")).toBe(true);
  });

  test("another code, an empty box and no pair are not", () => {
    expect(isOwnCode("ABCDEF", "CLVKN6")).toBe(false);
    expect(isOwnCode("", "CLVKN6")).toBe(false);
    expect(isOwnCode("CLVKN6", "")).toBe(false);
  });
});

