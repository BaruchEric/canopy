import { describe, expect, test } from "bun:test";
import { AGENT_NAME, agentWord, clock, harnessOf, resultLine, tokenCount, tokenTitle } from "./runs";

describe("a run's words", () => {
  test("its harness, and a run from before harnesses was Claude's", () => {
    expect(harnessOf({ harness: "codex" })).toBe("codex");
    expect(harnessOf({})).toBe("claude");
    expect(AGENT_NAME.codex).toBe("Codex");
    expect(AGENT_NAME.claude).toBe("Claude Code");
    expect(agentWord("claude")).toBe("claude");
  });

  test("the footer: the tokens where there are some, else the cost", () => {
    expect(resultLine({ text: "", turns: 3, durationMs: 187_000, costUsd: 0.042 })).toBe("3 turns · 3:07 · $0.04");
    expect(resultLine({ text: "", turns: 1, durationMs: 5_000, tokens: { input: 900, cachedInput: 100, output: 300, reasoning: 50, total: 1200 } })).toBe(
      "1 turn · 0:05 · 1.2k tokens",
    );
    // a codex result's zero cost is for older pages; this one shows its tokens
    expect(
      resultLine({ text: "", turns: 1, durationMs: 5_000, costUsd: 0, tokens: { input: 900, cachedInput: 100, output: 300, reasoning: 50, total: 1200 } }),
    ).toBe("1 turn · 0:05 · 1.2k tokens");
    expect(resultLine({ text: "", turns: 2, durationMs: 0 })).toBe("2 turns · 0:00");
    expect(tokenTitle({ text: "", turns: 1, durationMs: 0 })).toBeNull();
    expect(tokenTitle({ text: "", turns: 1, durationMs: 0, tokens: { input: 9, cachedInput: 3, output: 2, reasoning: 1, total: 11 } })).toBe(
      "9 in (3 cached), 2 out (1 reasoning), 11 in all",
    );
  });

  test("token counts and clocks at a glance", () => {
    expect([950, 1000, 1250, 48_400, 999_000, 1_300_000].map(tokenCount)).toEqual(["950", "1k", "1.3k", "48k", "999k", "1.3M"]);
    expect(clock(61_999)).toBe("1:01");
    expect(clock(-5)).toBe("0:00");
  });
});
