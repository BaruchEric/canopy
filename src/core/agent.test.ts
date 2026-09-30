import { describe, expect, test } from "bun:test";
import { describeAgent, isDefaultAgent, normalizeAgent, splitArgs, withHarness } from "./agent";
import { DEFAULT_AGENT, type AgentSettings } from "./types";

const codex = (over: Partial<AgentSettings> = {}): AgentSettings => ({ ...DEFAULT_AGENT, harness: "codex", ...over });

describe("agent settings", () => {
  test("anything malformed falls back to the defaults, field by field", () => {
    expect(normalizeAgent(null)).toEqual(DEFAULT_AGENT);
    expect(normalizeAgent("opus")).toEqual(DEFAULT_AGENT);
    expect(normalizeAgent({ harness: "gemini", model: "gpt-5", effort: "ultra", yolo: "yes", extra: 3 })).toEqual(DEFAULT_AGENT);
    expect(normalizeAgent({ model: "opus", effort: "high", yolo: true, extra: "  --verbose " })).toEqual({
      harness: "claude",
      model: "opus",
      effort: "high",
      yolo: true,
      extra: "--verbose",
    });
  });

  test("an entry from before harnesses reads as claude", () => {
    expect(normalizeAgent({ model: "fable", effort: "max", yolo: false, extra: "" })).toEqual({
      harness: "claude",
      model: "fable",
      effort: "max",
      yolo: false,
      extra: "",
    });
  });

  test("claude takes its own aliases and efforts, never codex's", () => {
    expect(normalizeAgent({ harness: "claude", model: "gpt-5.5", effort: "ultra" })).toEqual(DEFAULT_AGENT);
    expect(normalizeAgent({ harness: "claude", model: "haiku", effort: "xhigh" })).toMatchObject({ model: "haiku", effort: "xhigh" });
  });

  test("codex takes any plain model name and its own efforts, ultra among them", () => {
    expect(normalizeAgent({ harness: "codex", model: "gpt-5.5", effort: "ultra", yolo: false })).toEqual(
      codex({ model: "gpt-5.5", effort: "ultra", yolo: false }),
    );
    expect(normalizeAgent({ harness: "codex", model: "gpt-6-astra", effort: "max" })).toEqual(codex({ model: "gpt-6-astra", effort: "max" }));
  });

  test("a stale value never reaches a command line: flags, spaces and claude's aliases are not codex models", () => {
    expect(normalizeAgent({ harness: "codex", model: "--dangerously-bypass-approvals-and-sandbox" }).model).toBe("default");
    expect(normalizeAgent({ harness: "codex", model: "gpt 5; rm -rf /" }).model).toBe("default");
    expect(normalizeAgent({ harness: "codex", model: "opus" }).model).toBe("default");
    expect(normalizeAgent({ harness: "codex", model: "" }).model).toBe("default");
    expect(normalizeAgent({ harness: "codex", effort: "minimal" }).effort).toBe("default");
  });

  test("switching the harness keeps what the new one takes", () => {
    expect(withHarness({ ...DEFAULT_AGENT, model: "opus", effort: "high", yolo: false }, "codex")).toEqual(
      codex({ effort: "high", yolo: false }),
    );
    expect(withHarness(codex({ model: "gpt-5.5", effort: "ultra", extra: "--search" }), "claude")).toEqual({
      ...DEFAULT_AGENT,
      extra: "--search",
    });
  });

  test("the defaults are recognised so the config can drop them", () => {
    expect(isDefaultAgent(DEFAULT_AGENT)).toBe(true);
    expect(isDefaultAgent({ ...DEFAULT_AGENT, yolo: false })).toBe(false);
    expect(isDefaultAgent({ ...DEFAULT_AGENT, extra: "--x" })).toBe(false);
    expect(isDefaultAgent(codex())).toBe(false);
  });

  test("extra flags split like a shell line", () => {
    expect(splitArgs("")).toEqual([]);
    expect(splitArgs("  --a   --b=1 ")).toEqual(["--a", "--b=1"]);
    expect(splitArgs(`--name "two words" --x 'it''s'`)).toEqual(["--name", "two words", "--x", "its"]);
    expect(splitArgs(`"" --y`)).toEqual(["", "--y"]);
    // an unclosed quote runs to the end rather than being lost
    expect(splitArgs(`--z "open`)).toEqual(["--z", "open"]);
  });

  test("one line for the menu, the harness named only when it is not claude", () => {
    expect(describeAgent(DEFAULT_AGENT)).toBe("yolo");
    expect(describeAgent({ ...DEFAULT_AGENT, model: "opus" })).toBe("opus · yolo");
    expect(describeAgent({ ...DEFAULT_AGENT, effort: "max", yolo: false, extra: "--x" })).toBe("max · ask · --x");
    expect(describeAgent(codex({ model: "gpt-5.5", effort: "high", yolo: false }))).toBe("codex · gpt-5.5 · high · ask");
    expect(describeAgent(codex())).toBe("codex · yolo");
  });
});
