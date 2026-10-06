import { describe, expect, test } from "bun:test";
import { parseAnswer } from "./answers";

describe("parseAnswer", () => {
  test("approve needs a boolean auto", () => {
    expect(parseAnswer({ kind: "approve", auto: true })).toEqual({ kind: "approve", auto: true });
    expect(parseAnswer({ kind: "approve" })).toBeNull();
  });
  test("a deny keeps the user's words, trimmed, and refuses a huge one", () => {
    expect(parseAnswer({ kind: "deny", message: "  split step 2 " })).toEqual({ kind: "deny", message: "split step 2" });
    expect(parseAnswer({ kind: "deny", message: "   " })).toEqual({ kind: "deny" });
    expect(parseAnswer({ kind: "deny", message: "x".repeat(20_001) })).toBeNull();
    expect(parseAnswer({ kind: "deny", message: 5 })).toBeNull();
  });
  test("the old shapes still parse", () => {
    expect(parseAnswer({ kind: "allow" })).toEqual({ kind: "allow" });
    expect(parseAnswer({ kind: "allow-all" })).toEqual({ kind: "allow-all" });
    expect(parseAnswer({ kind: "answers", answers: { q: "a" } })).toEqual({ kind: "answers", answers: { q: "a" } });
  });
  test("a remembered rule is checked", () => {
    expect(parseAnswer({ kind: "allow", remember: { rule: " Bash(ls) ", scope: "repo" } })).toEqual({
      kind: "allow",
      remember: { rule: "Bash(ls)", scope: "repo" },
    });
    expect(parseAnswer({ kind: "allow", remember: { rule: "x", scope: "nope" } })).toBeNull();
    expect(parseAnswer(null)).toBeNull();
    expect(parseAnswer([])).toBeNull();
  });
});
