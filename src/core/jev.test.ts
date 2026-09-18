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
