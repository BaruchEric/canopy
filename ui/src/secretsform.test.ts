import { describe, expect, test } from "bun:test";
import { newKeyProblem } from "./secretsform";

describe("newKeyProblem", () => {
  test("a short passphrase says how long it is", () => {
    expect(newKeyProblem("abcdefg", "abcdefg")).toBe("the passphrase has 7 characters; it needs 8 or more");
  });
  test("two different passphrases are named", () => {
    expect(newKeyProblem("abcdefgh", "abcdefgi")).toBe("the two passphrases differ");
  });
  test("an empty second field reads as a difference, not a pass", () => {
    expect(newKeyProblem("abcdefgh", "")).toBe("the two passphrases differ");
  });
  test("eight matching characters pass", () => {
    expect(newKeyProblem("abcdefgh", "abcdefgh")).toBeNull();
  });
});
