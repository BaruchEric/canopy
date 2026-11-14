import { describe, expect, test } from "bun:test";
import { PARK_DETAIL_MAX, parkDetail, plainRunError } from "./runerror";

describe("plainRunError", () => {
  test("the harnesses' common errors read plainly", () => {
    const cases: [string, string][] = [
      ['API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}', "Anthropic's API was overloaded"],
      ["API Error: 500 Internal server error", "the model's API had a server error"],
      ["API Error: 429 rate_limit_error: Number of request tokens has exceeded your per-minute rate limit", "the model's API turned the request away for its rate limit"],
      ["API Error: Request timed out.", "a request to the model's API timed out"],
      ["API Error: Connection error.", "the connection to the model's API failed"],
      ["fetch failed: ECONNRESET", "the connection to the model's API failed"],
      ["Prompt is too long", "the conversation outgrew the model's context window"],
      ["You've hit your limit · resets 3pm (America/Los_Angeles)", "the plan's usage limit ran out"],
      ["Claude Code exited (code 137) without a result: Killed", "Claude Code was killed before it finished"],
      ["Codex exited (code null) without a result", "Codex was killed before it finished"],
      ["Claude Code exited (code 1) without a result: something odd", "Claude Code quit with exit code 1 before it finished"],
      ["the stage runner timed out after 600000 ms", "it timed out"],
    ];
    for (const [raw, plain] of cases) expect([raw, plainRunError(raw)]).toEqual([raw, plain]);
  });

  test("an API error the process printed before it quit reads as the API's, not the exit's", () => {
    expect(plainRunError("Claude Code exited (code 1) without a result: API Error: 529 Overloaded")).toBe("Anthropic's API was overloaded");
  });

  test("words canopy already wrote plainly, and anything it does not know, are left as they are", () => {
    for (const raw of ["stopped after 40 turns without finishing", "stopped at the spending limit", "the run failed", "boom", "Failed to authenticate: OAuth session expired"]) {
      expect(plainRunError(raw)).toBeNull();
    }
  });
});

describe("parkDetail", () => {
  test("keeps the end, where an error or a check says what failed, and takes secrets out", () => {
    const token = `cnp_run_${"a".repeat(43)}`;
    const text = `${"x".repeat(5000)}\npush to https://eric:ghp_SECRET@github.com/eric/app failed\n${token}\nFAIL src/a.test.ts`;
    const d = parkDetail(text);
    expect(d.length).toBeLessThanOrEqual(PARK_DETAIL_MAX);
    expect(d.startsWith("…")).toBe(true);
    expect(d.endsWith("FAIL src/a.test.ts")).toBe(true);
    expect(d).not.toContain("ghp_SECRET");
    expect(d).not.toContain(token);
    expect(d).toContain("https://github.com/eric/app");
  });

  test("a short text stays whole, trimmed", () => {
    expect(parkDetail("  error: one\n")).toBe("error: one");
  });
});
