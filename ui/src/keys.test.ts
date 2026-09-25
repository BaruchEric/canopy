import { describe, expect, test } from "bun:test";
import { NO_MODS, ctrlChar, keyBytes, withMods } from "./keys";

const ctrl = { ctrl: true, alt: false };
const alt = { ctrl: false, alt: true };
const both = { ctrl: true, alt: true };

test("ctrlChar", () => {
  expect(ctrlChar("c")).toBe("\x03");
  expect(ctrlChar("C")).toBe("\x03");
  expect(ctrlChar("a")).toBe("\x01");
  expect(ctrlChar("z")).toBe("\x1a");
  expect(ctrlChar("[")).toBe("\x1b");
  expect(ctrlChar(" ")).toBe("\x00");
  expect(ctrlChar("?")).toBe("\x7f");
  expect(ctrlChar("é")).toBeNull();
  expect(ctrlChar("ab")).toBeNull();
});

describe("withMods", () => {
  test("nothing armed passes through", () => {
    expect(withMods("hello", NO_MODS)).toBe("hello");
  });
  test("one character takes Ctrl, Alt or both", () => {
    expect(withMods("c", ctrl)).toBe("\x03");
    expect(withMods("b", alt)).toBe("\x1bb");
    expect(withMods("r", both)).toBe("\x1b\x12");
  });
  test("a word or a paste goes as it came", () => {
    expect(withMods("hello", ctrl)).toBe("hello");
  });
  test("Ctrl on a character it means nothing for sends the character", () => {
    expect(withMods("é", ctrl)).toBe("é");
  });
});

describe("keyBytes", () => {
  test("arrows follow the cursor mode", () => {
    expect(keyBytes("up", NO_MODS, false)).toBe("\x1b[A");
    expect(keyBytes("up", NO_MODS, true)).toBe("\x1bOA");
    expect(keyBytes("left", NO_MODS, true)).toBe("\x1bOD");
  });
  test("modified arrows carry the xterm parameter in either mode", () => {
    expect(keyBytes("left", ctrl, true)).toBe("\x1b[1;5D");
    expect(keyBytes("right", alt, false)).toBe("\x1b[1;3C");
    expect(keyBytes("up", both, false)).toBe("\x1b[1;7A");
  });
  test("the rest", () => {
    expect(keyBytes("esc", NO_MODS, false)).toBe("\x1b");
    expect(keyBytes("tab", NO_MODS, false)).toBe("\t");
    expect(keyBytes("backtab", NO_MODS, false)).toBe("\x1b[Z");
    expect(keyBytes("home", NO_MODS, false)).toBe("\x1b[H");
    expect(keyBytes("end", NO_MODS, true)).toBe("\x1bOF");
    expect(keyBytes("pgup", NO_MODS, false)).toBe("\x1b[5~");
    expect(keyBytes("pgdn", ctrl, false)).toBe("\x1b[6;5~");
    expect(keyBytes("ctrl-c", NO_MODS, false)).toBe("\x03");
    expect(keyBytes("ctrl-d", alt, false)).toBe("\x1b\x04");
  });
});
