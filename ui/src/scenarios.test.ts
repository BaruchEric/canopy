import { describe, expect, test } from "bun:test";
import { setChip, setRows, staleWord } from "./scenarios";

describe("the landing section's scenarios", () => {
  test("the chip counts the set and turns rust for a file that does not read; none for no set", () => {
    expect(setChip(undefined)).toBeNull();
    expect(setChip({ names: [], errors: [] })).toBeNull();
    expect(setChip({ names: [{ name: "a", kind: "command" }, { name: "b", kind: "judge" }], errors: [] })).toEqual({ text: "scenarios 2", tone: "lichen" });
    expect(setChip({ names: [{ name: "a", kind: "command" }], errors: [{ file: "x.md" }] })).toEqual({ text: "scenarios 1 · 1 broken", tone: "rust" });
    expect(setChip({ names: [], errors: [{ file: "x.md" }] })?.text).toBe("scenarios 0 · 1 broken");
  });
  test("the list names each scenario by kind, then each broken file", () => {
    expect(setRows({ names: [{ name: "checkout", kind: "command" }, { name: "refund", kind: "judge" }], errors: [{ file: "x.md" }] })).toEqual([
      { key: "s:checkout", name: "checkout", word: "command", tone: "" },
      { key: "s:refund", name: "refund", word: "judge", tone: "" },
      { key: "e:x.md", name: "x.md", word: "does not read, so every pass is red", tone: "rust" },
    ]);
  });
  test("a pass on another head than the one shown says so", () => {
    expect(staleWord({ head: "1a2b3c4d5e" }, "1a2b3c4d5e")).toBeNull();
    expect(staleWord({ head: "1a2b3c4d5e" }, undefined)).toBeNull();
    expect(staleWord({ head: "1a2b3c4d5e" }, "ffff")).toBe("on 1a2b3c4, an older head");
  });
});
