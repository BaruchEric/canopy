import { describe, expect, test } from "bun:test";
import { hasGatewayKey, jev } from "./jev";
import { decide, verdictState } from "./verdict";

describe("jev, live", () => {
  test.skipIf(!hasGatewayKey())("a clean summary is a go", async () => {
    const answers = await jev(
      verdictState({ summary: "Committed the two changed files as one commit, abc1234. Nothing left in git status.", check: null, changed: true }),
    );
    expect(["done", "partial", "blocked"]).toContain(answers.outcome.choice);
    expect(decide(answers).go).toBe(true);
  }, 30_000);
});

describe("hasGatewayKey", () => {
  const NAMES = ["AI_GATEWAY_API_KEY", "VERCEL_AI_GATEWAY_API_KEY"] as const;
  const restore = (saved: Record<string, string | undefined>) => {
    for (const name of NAMES) {
      const was = saved[name];
      if (was === undefined) delete process.env[name];
      else process.env[name] = was;
    }
  };
  test("an empty or blank key reads as no key at all", () => {
    const saved: Record<string, string | undefined> = {};
    for (const name of NAMES) saved[name] = process.env[name];
    try {
      process.env["AI_GATEWAY_API_KEY"] = "";
      delete process.env["VERCEL_AI_GATEWAY_API_KEY"];
      expect(hasGatewayKey()).toBe(false);
      process.env["AI_GATEWAY_API_KEY"] = "   ";
      expect(hasGatewayKey()).toBe(false);
      process.env["VERCEL_AI_GATEWAY_API_KEY"] = "sk-real";
      expect(hasGatewayKey()).toBe(true);
    } finally {
      restore(saved);
    }
  });
});
