import { describe, expect, test } from "bun:test";
import { newKeyProblem } from "./secretsform";

describe("newKeyProblem", () => {
  test("a short passphrase says how long it is", () => {
    expect(newKeyProblem("abcdefghijk", "abcdefghijk")).toBe("the passphrase has 11 characters; it needs 12 or more");
  });
  test("two different passphrases are named", () => {
    expect(newKeyProblem("abcdefghijkl", "abcdefghijkm")).toBe("the two passphrases differ");
  });
  test("an empty second field reads as a difference, not a pass", () => {
    expect(newKeyProblem("abcdefghijkl", "")).toBe("the two passphrases differ");
  });
  test("twelve matching characters pass", () => {
    expect(newKeyProblem("abcdefghijkl", "abcdefghijkl")).toBeNull();
  });
});
