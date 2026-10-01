import { describe, expect, test } from "bun:test";
import { ANSWER_KEY_HEADER, ANSWER_KEY_STORE, cleanKey, keyHeaders, keyTestOf, maskKey, readAnswerKey, writeAnswerKey } from "./answerKey";

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

describe("this browser's answer key", () => {
  test("one word, trimmed; anything else is no key", () => {
    expect(cleanKey("  s3cret ")).toBe("s3cret");
    expect(cleanKey("two words")).toBeNull();
    expect(cleanKey("")).toBeNull();
    expect(cleanKey(null)).toBeNull();
    expect(cleanKey("x".repeat(513))).toBeNull();
  });

  test("kept under its own key, apart from the settings, and forgotten on null", () => {
    const st = storage();
    expect(readAnswerKey(st)).toBeNull();
    expect(writeAnswerKey("s3cret", st)).toBe(true);
    expect(st.m.get(ANSWER_KEY_STORE)).toBe("s3cret");
    expect(ANSWER_KEY_STORE).not.toBe("canopy.settings");
    expect(readAnswerKey(st)).toBe("s3cret");
    expect(writeAnswerKey(null, st)).toBe(true);
    expect(readAnswerKey(st)).toBeNull();
    // a value tampered into something the broker would not take reads as none
    st.m.set(ANSWER_KEY_STORE, "two words");
    expect(readAnswerKey(st)).toBeNull();
  });

  test("blocked or missing storage is no key and no crash", () => {
    expect(readAnswerKey(storage(true))).toBeNull();
    expect(writeAnswerKey("k", storage(true))).toBe(false);
    expect(readAnswerKey(null)).toBeNull();
    expect(writeAnswerKey("k", null)).toBe(false);
  });

  test("the headers a keyed write carries, and the key as Settings shows it", () => {
    expect(keyHeaders("k")).toEqual({ "Content-Type": "application/json", [ANSWER_KEY_HEADER]: "k" });
    expect(maskKey("short")).toBe("••••••••");
    expect(maskKey("0123456789abcdefWXYZ")).toBe("••••••••WXYZ");
  });

  test("a key's test: ok, refused by the broker, or no answer", () => {
    expect(keyTestOf(null)).toEqual({ ok: true });
    expect(keyTestOf(Object.assign(new Error("tailchan: bad answer token"), { status: 403 }))).toEqual({
      ok: false,
      refused: true,
      why: "tailchan: bad answer token",
    });
    expect(keyTestOf(new Error("canopy did not answer"))).toMatchObject({ ok: false, refused: false });
  });
});
