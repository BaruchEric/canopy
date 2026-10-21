import { describe, expect, test } from "bun:test";
import { DictatorDiscovery, dictatable, dictationText, type FieldLike } from "./dictate";

const field = (tagName: string, more: Partial<FieldLike> & { inside?: boolean } = {}): FieldLike => ({
  tagName,
  ...more,
  closest: () => (more.inside ? {} : null),
});

describe("dictatable", () => {
  test("a textarea and the word-holding inputs take dictation", () => {
    expect(dictatable(field("TEXTAREA"))).toBe(true);
    for (const type of ["text", "search", "url", "email", ""]) expect(dictatable(field("INPUT", { type }))).toBe(true);
  });

  test("passwords, numbers, dates and boxes do not", () => {
    for (const type of ["password", "number", "date", "checkbox", "file", "range"]) expect(dictatable(field("INPUT", { type }))).toBe(false);
    expect(dictatable(field("SELECT"))).toBe(false);
    expect(dictatable(field("DIV"))).toBe(false);
    expect(dictatable(null)).toBe(false);
  });

  test("a read-only, disabled or opted-out field does not", () => {
    expect(dictatable(field("TEXTAREA", { readOnly: true }))).toBe(false);
    expect(dictatable(field("INPUT", { type: "text", disabled: true }))).toBe(false);
    expect(dictatable(field("TEXTAREA", { inside: true }))).toBe(false);
    expect(dictatable(field("INPUT", { type: "text", inside: true }))).toBe(false);
  });
});

describe("dictationText", () => {
  test("an empty field takes the words as said, trimmed", () => {
    expect(dictationText("", "  open the repo  ", "")).toBe("open the repo");
  });

  test("a space goes before when the words would run into one", () => {
    expect(dictationText("fix", "the build", "")).toBe(" the build");
    expect(dictationText("fix ", "the build", "")).toBe("the build");
    expect(dictationText("fix\n", "the build", "")).toBe("the build");
  });

  test("a space goes after when a word follows, not before punctuation", () => {
    expect(dictationText("", "please", "fix it")).toBe("please ");
    expect(dictationText("fix it", "now", ".")).toBe(" now");
    expect(dictationText("a", "b", " c")).toBe(" b");
  });

  test("nothing heard puts nothing in", () => {
    expect(dictationText("fix", "   ", "it")).toBe("");
  });
});

describe("DictatorDiscovery", () => {
  test("shares an in-flight capability lookup across simultaneous mics", async () => {
    const discovery = new DictatorDiscovery();
    let calls = 0;
    let answer: ((value: boolean) => void) | undefined;
    const canDictate = () => {
      calls++;
      return new Promise<boolean>((resolve) => {
        answer = resolve;
      });
    };
    const first = discovery.find(["home"], "home:online", canDictate);
    const second = discovery.find(["home"], "home:online", canDictate);
    expect(second).toBe(first);
    expect(calls).toBe(1);
    answer?.(false);
    await expect(first).resolves.toBeNull();
  });

  test("rechecks a cached negative after a secondary backend disconnects and returns", async () => {
    const discovery = new DictatorDiscovery();
    let miniSupportsDictation = false;
    let calls = 0;
    const canDictate = async (backend: string) => {
      calls++;
      return backend === "mini" && miniSupportsDictation;
    };

    await expect(discovery.find(["home", "mini"], "home:online|mini:online", canDictate)).resolves.toBeNull();
    await expect(discovery.find(["home"], "home:online|mini:offline", canDictate)).resolves.toBeNull();
    miniSupportsDictation = true;
    await expect(discovery.find(["home", "mini"], "home:online|mini:online", canDictate)).resolves.toBe("mini");
    expect(calls).toBe(5);
  });
});
