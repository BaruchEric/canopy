import { describe, expect, test } from "bun:test";
import { originOf, pairLabel, readToken, TOKEN_HEADER, tokenHeaders, tokenKey, writeToken } from "./callerToken";

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

  test("a page's pair label never reads as the CLI's or the helper's", () => {
    expect(pairLabel("Chrome on Mac")).toBe("Chrome on Mac");
    expect(pairLabel("cli mac")).toBe("page cli mac");
    expect(pairLabel("helper x")).toBe("page helper x");
    expect(pairLabel("  ")).toBe("a browser");
  });
});
