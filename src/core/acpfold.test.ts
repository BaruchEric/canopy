import { describe, expect, test } from "bun:test";
import { acpFold, acpResult, acpSession, acpTurn, foldAcp } from "./acpfold";
import type { FoldOut } from "./driver";
import type { RunStep, RunTodo } from "./types";

function output(steps: RunStep[] = []): FoldOut {
  let next = 0;
  return {
    step(step) {
      const full = { ...step, id: String(++next), at: 0 };
      steps.push(full);
      return full;
    },
    changed() {},
    note() {},
    todos(_next: RunTodo[]) {},
    result() {},
  };
}

const text = (value: string, messageId?: string) => ({
  sessionUpdate: "agent_message_chunk",
  ...(messageId ? { messageId } : {}),
  content: { type: "text", text: value },
});

describe("ACP fold", () => {
  test("coalesces unaddressed text chunks and starts a new text after a tool", () => {
    const state = acpFold("/repo");
    const steps: RunStep[] = [];
    const out = output(steps);
    acpTurn(state, 10);
    foldAcp(state, "session/update", { update: text("hel") }, out, 11);
    foldAcp(state, "session/update", { update: text("lo") }, out, 12);
    foldAcp(state, "session/update", { update: { sessionUpdate: "tool_call", toolCallId: "t1", name: "Bash", status: "pending" } }, out, 13);
    foldAcp(state, "session/update", { update: { sessionUpdate: "tool_call_update", toolCallId: "t1", status: "completed", content: [{ type: "text", text: "ok" }] } }, out, 14);
    foldAcp(state, "session/update", { update: text("!") }, out, 15);
    expect(steps.map((step) => step.kind)).toEqual(["text", "tool", "text"]);
    expect(steps[0]?.text).toBe("hello");
    expect(steps[1]?.tool).toMatchObject({ name: "Bash", status: "ok", output: "ok" });
    expect(steps[2]?.text).toBe("!");
    expect(state.finalText).toBe("hello!");
  });

  test("loads a response with no session id using the requested id", () => {
    const state = acpFold("/repo");
    expect(acpSession(state, {}, "resume-1")).toBe("resume-1");
    expect(state.session).toBe("resume-1");
  });

  test("reports the per-turn delta of ACP's cumulative USD usage", () => {
    const state = acpFold("/repo");
    const out = output();
    acpTurn(state, 10);
    foldAcp(state, "session/update", { update: { sessionUpdate: "usage_update", cost: { amount: 1.25, currency: "USD" } } }, out, 11);
    expect(acpResult(state, { stopReason: "end_turn" }, null, 20).result).not.toHaveProperty("costUsd");
    acpTurn(state, 30);
    foldAcp(state, "session/update", { update: { sessionUpdate: "usage_update", cost: { amount: 1.5, currency: "USD" } } }, out, 31);
    expect(acpResult(state, { stopReason: "end_turn" }, null, 40).result.costUsd).toBe(0.25);
    acpTurn(state, 50);
    expect(acpResult(state, { stopReason: "end_turn" }, null, 60).result).not.toHaveProperty("costUsd");
  });
});
