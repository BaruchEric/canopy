import { describe, expect, test } from "bun:test";
import { claudeArgs, describeAgent, isDefaultAgent, normalizeAgent, splitArgs } from "./agent";
import { DEFAULT_AGENT } from "./types";

describe("agent settings", () => {
  test("anything malformed falls back to the defaults, field by field", () => {
    expect(normalizeAgent(null)).toEqual(DEFAULT_AGENT);
    expect(normalizeAgent("opus")).toEqual(DEFAULT_AGENT);
    expect(normalizeAgent({ model: "gpt-5", effort: "ultra", yolo: "yes", extra: 3 })).toEqual(
      DEFAULT_AGENT,
    );
    expect(normalizeAgent({ model: "opus", effort: "high", yolo: true, extra: "  --verbose " })).toEqual({
      model: "opus",
      effort: "high",
      yolo: true,
      extra: "--verbose",
    });
  });

  test("the defaults are recognised so the config can drop them", () => {
    expect(isDefaultAgent(DEFAULT_AGENT)).toBe(true);
    expect(isDefaultAgent({ ...DEFAULT_AGENT, yolo: true })).toBe(false);
    expect(isDefaultAgent({ ...DEFAULT_AGENT, extra: "--x" })).toBe(false);
  });

  test("flags only for what is set", () => {
    expect(claudeArgs(DEFAULT_AGENT)).toEqual([]);
    expect(
      claudeArgs({ model: "fable", effort: "xhigh", yolo: true, extra: "--add-dir '../my lib'" }),
    ).toEqual([
      "--model",
      "fable",
      "--effort",
      "xhigh",
      "--dangerously-skip-permissions",
      "--add-dir",
      "../my lib",
    ]);
  });

  test("extra flags split like a shell line", () => {
    expect(splitArgs("")).toEqual([]);
    expect(splitArgs("  --a   --b=1 ")).toEqual(["--a", "--b=1"]);
    expect(splitArgs(`--name "two words" --x 'it''s'`)).toEqual(["--name", "two words", "--x", "its"]);
    expect(splitArgs(`"" --y`)).toEqual(["", "--y"]);
    // an unclosed quote runs to the end rather than being lost
    expect(splitArgs(`--z "open`)).toEqual(["--z", "open"]);
  });

  test("one line for the menu", () => {
    expect(describeAgent(DEFAULT_AGENT)).toBe("claude defaults");
    expect(describeAgent({ model: "opus", effort: "default", yolo: true, extra: "" })).toBe(
      "opus · yolo",
    );
    expect(describeAgent({ model: "default", effort: "max", yolo: false, extra: "--x" })).toBe(
      "max · --x",
    );
  });
});
