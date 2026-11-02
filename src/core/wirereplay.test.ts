import { describe, expect, test } from "bun:test";
import { absolutePath, claudeFold, foldClaude, toolPaths } from "./claudefold";
import type { FoldOut } from "./driver";
import type { Run, RunResult, RunStep } from "./types";
import { redactReplay, replayWire } from "./wirereplay";

/* The replay's own rules on hand-written wires. That a recorded wire folds
 * into the steps the live run made is claudedrive.test.ts's and
 * codexrun.test.ts's, against the stand-in CLIs. */

const run = (over: Partial<Run> = {}): Run => ({
  id: "r1", repoId: "repo", action: "ask", verb: "Ask", progress: "", expectsChange: false, chat: false, harness: "claude",
  note: "", status: "done", startedAt: 1000, endedAt: 9000, steps: [], prompt: null, ...over,
});
const line = (v: unknown): string => JSON.stringify(v);
const start = (harness = "claude") => line({ canopy: "start", at: 1000, run: "r1", repo: "repo", action: "ask", harness, argv: [] });
const say = (text: string) => ({ type: "assistant", message: { content: [{ type: "text", text }] } });
const bash = (id: string, command: string) => ({ type: "assistant", message: { content: [{ type: "tool_use", id, name: "Bash", input: { command } }] } });
const can = (id: string, command: string) => ({ type: "control_request", request_id: id, request: { subtype: "can_use_tool", tool_name: "Bash", input: { command } } });
const reply = (id: string, behavior: "allow" | "deny") => line({ canopy: "in", at: 0, line: line({ type: "control_response", response: { subtype: "success", request_id: id, response: { behavior } } }) });
const opts = { cwd: "/repo", home: "/home/me" };

describe("replayWire", () => {
  test("ticks time the steps folded out of the wire; a line that is not JSON is passed over", () => {
    const got = replayWire([
      start(),
      line({ canopy: "in", at: 1001, line: line({ type: "user", message: { content: "framed" } }) }),
      "progress chatter",
      line({ canopy: "tick", at: 1500 }), line(say("one")),
      line({ canopy: "tick", at: 4200 }), line(say("two")), line(say("three")),
      line({ canopy: "end", at: 9000, status: "done" }),
    ], run(), opts);
    expect(got).toMatchObject({ source: "wire", asks: [], cut: false });
    expect(got.steps.map((s) => [s.text, s.at])).toEqual([["one", 1500], ["two", 4200], ["three", 4200]]);
  });

  test("a wire from before ticks times out lines by the in line before them, and a cut says so", () => {
    const got = replayWire([
      start(),
      line({ canopy: "in", at: 1001, line: line({ type: "user", message: { content: "framed" } }) }),
      line(say("one")), line(say("two")),
      line({ canopy: "cut", at: 5000, bytes: 10 }),
    ], run(), opts);
    expect(got.cut).toBe(true);
    expect(got.steps.map((s) => s.at)).toEqual([1001, 1001]);
  });

  test("a whole record keeps its steps and times; each ask lands after the step it followed and before later notes", () => {
    const record: RunStep[] = [
      { id: "1", at: 1100, kind: "note", text: "on branch run/x" },
      { id: "2", at: 1200, kind: "tool", tool: { name: "Bash", title: "git push", status: "ok" } },
      { id: "3", at: 1250, kind: "note", text: "an earlier note" },
      { id: "4", at: 1400, kind: "note", text: "allowed: git push" },
      { id: "5", at: 1500, kind: "text", text: "pushed" },
    ];
    const got = replayWire([
      start(),
      line({ canopy: "in", at: 1001, line: line({ type: "user", message: { content: "framed" } }) }),
      line({ canopy: "tick", at: 1199 }), line(bash("t1", "git push")),
      line({ canopy: "tick", at: 1300 }), line(can("q1", "git push")),
      reply("q1", "allow").replace('"at":0', '"at":1401'),
      line({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] } }),
      line(say("pushed")),
    ], run({ steps: record }), opts);
    expect(got.source).toBe("record");
    expect(got.asks).toEqual(["ask1"]);
    expect(got.steps.map((s) => s.id)).toEqual(["1", "2", "3", "ask1", "4", "5"]);
    expect(got.steps[3]).toEqual({ id: "ask1", at: 1300, kind: "note", text: "asked: git push" });
  });

  test("a record whose oldest steps were trimmed gives way to the wire's whole story", () => {
    const trimmed: RunStep[] = [
      { id: "trim", at: 2000, kind: "note", text: "earlier steps trimmed" },
      { id: "9", at: 2000, kind: "text", text: "two" },
    ];
    const got = replayWire([start(), line(say("one")), line(say("two"))], run({ steps: trimmed }), opts);
    expect(got.source).toBe("wire");
    expect(got.steps.map((s) => s.text)).toEqual(["one", "two"]);
  });

  test("the start line names the harness, whatever the record says", () => {
    const got = replayWire([
      start("codex"),
      line({ canopy: "in", at: 1001, line: line({ id: 2, method: "thread/start", params: { cwd: "/w" } }) }),
      line({ id: 2, result: { thread: { id: "thr" }, model: "m" } }),
      line({ method: "item/completed", params: { threadId: "thr", item: { type: "agentMessage", id: "a", text: "hi", phase: "final_answer" } } }),
      line({ method: "item/completed", params: { threadId: "other", item: { type: "agentMessage", id: "b", text: "not ours" } } }),
    ], run({ harness: "claude" }), opts);
    expect(got.steps.map((s) => s.text)).toEqual(["hi"]);
  });
});

test("redactReplay redacts every word a step shows with the secrets known now", () => {
  const got = redactReplay(
    { source: "wire", asks: [], cut: false, steps: [
      { id: "w1", at: 1, kind: "text", text: "the key is s3cret" },
      { id: "w2", at: 2, kind: "tool", tool: { name: "Bash", title: "echo s3cret", status: "ok", output: "s3cret", paths: ["s3cret.txt"] } },
    ] },
    [{ name: "API_KEY", value: "s3cret" }],
  );
  expect(JSON.stringify(got)).not.toContain("s3cret");
  expect(got.steps[1]?.tool).toEqual({ name: "Bash", title: "echo <redacted:API_KEY>", status: "ok", output: "<redacted:API_KEY>", paths: ["<redacted:API_KEY>.txt"] });
});

describe("claudefold", () => {
  test("paths: home, relative, dot-dot, and a redacted absolute one from a kept wire", () => {
    expect(absolutePath("~/notes.md", "/repo", "/home/me")).toBe("/home/me/notes.md");
    expect(absolutePath("~", "/repo", "/home/me")).toBe("/home/me");
    expect(absolutePath("src/../a.ts", "/repo", "/home/me")).toBe("/repo/a.ts");
    expect(toolPaths("Edit", { file_path: "<redacted:CANOPY_CONFIG_DIR>/w/1/src/a.ts" }, "<redacted:CANOPY_CONFIG_DIR>/w/1", "/home/me")).toEqual({ paths: ["src/a.ts"] });
  });

  test("a result after a held one counts the held turns and is timed from the turn's start", () => {
    const results: [RunResult, string | null][] = [];
    const out: FoldOut = { step: (s) => ({ id: "1", at: 0, ...s }), changed: () => {}, note: () => {}, todos: () => {}, result: (r, p) => results.push([r, p]) };
    const state = claudeFold("/repo", "/home/me", 100);
    foldClaude(state, { type: "system", subtype: "init", model: "opus" }, out);
    state.heldTurns = 2;
    foldClaude(state, { type: "result", subtype: "success", result: "done", num_turns: 3, duration_ms: 5 }, out, { now: 600 });
    foldClaude(state, { type: "result", subtype: "error_max_turns", num_turns: 4, duration_ms: 7 }, out, { failure: null });
    expect(results).toEqual([
      [{ text: "done", costUsd: 0, durationMs: 500, turns: 5, model: "opus" }, null],
      [{ text: "", costUsd: 0, durationMs: 7, turns: 4, model: "opus" }, "stopped after 4 turns without finishing"],
    ]);
    expect(state.heldTurns).toBeNull();
  });
});
