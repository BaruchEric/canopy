import { describe, expect, test } from "bun:test";
import { agentPanel, cardOfPanel, isAgentPanel } from "./agentpanel";

describe("agent panels", () => {
  test("round trip, and nothing else reads as one", () => {
    const id = agentPanel("claude:abc");
    expect(id).toBe("/agent/claude:abc");
    expect(isAgentPanel(id)).toBe(true);
    expect(cardOfPanel(id)).toBe("claude:abc");
    expect(isAgentPanel("/agent/")).toBe(false);
    expect(isAgentPanel("/waiting")).toBe(false);
    expect(cardOfPanel("web-apps/ripe")).toBeNull();
  });
});
