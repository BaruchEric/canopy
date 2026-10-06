/** A stand-in for `claude -p --input-format stream-json --output-format
 *  stream-json`, for the ClaudeDriver tests.
 *
 *  It speaks the part of the wire canopy uses: a `system` init carrying the
 *  session id, assistant and user messages with text, tool_use and
 *  tool_result blocks, `control_request`s for can_use_tool that wait for a
 *  `control_response`, a `control_cancel_request`, and a `result`. It exits
 *  when stdin closes. Everything canopy sends, and the argv, go to
 *  `FAKE_CLAUDE_LOG` one JSON object per line.
 *
 *  `FAKE_CLAUDE_MODE`:
 *    job   asks to run `git push` and `rm x` at once, takes the second back,
 *          and once the first is answered finishes with a result whose text
 *          is `env:$CANOPY_RUN`
 *    chat  answers every user message with a text and a result
 *    die   writes "boom" to stderr and exits 3 before any result
 *    async starts a background Agent and sends a result while it runs, then
 *          a permission request from inside the subagent; once that is
 *          answered, the task notification and the real result
 *    bgshell starts a background shell and ends its turn: a shell never
 *          holds a result
 *    quiet like async, but after the notification it sends nothing more
 *    woke  like async, but the turn the subagent's end wakes asks to run
 *          `bun test` from the main thread before its real result
 *
 *  The background modes use the message shapes a probe of the real CLI
 *  showed (spec P5 and P7): task_started, task_notification and
 *  background_tasks_changed as system messages, and a subagent's own
 *  messages carrying parent_tool_use_id. */

import { appendFileSync } from "node:fs";

const log = process.env["FAKE_CLAUDE_LOG"];
const mode = process.env["FAKE_CLAUDE_MODE"] ?? "job";
const record = (m: unknown): void => {
  if (log) appendFileSync(log, JSON.stringify(m) + "\n");
};
const out = (m: unknown): void => {
  process.stdout.write(JSON.stringify(m) + "\n");
};
const sys = (subtype: string, extra: Record<string, unknown>) => out({ type: "system", subtype, session_id: "sess-1", ...extra });
const tasks = (list: { task_id: string; task_type: string }[]) => sys("background_tasks_changed", { tasks: list });

record({ argv: process.argv.slice(2) });
out({ type: "system", subtype: "init", session_id: "sess-1", cwd: process.cwd() });

let turns = 0;
const bash = (id: string, command: string) =>
  out({
    type: "control_request",
    request_id: id,
    request: { subtype: "can_use_tool", tool_name: "Bash", input: { command }, tool_use_id: `tu-${id}` },
  });

function onUser(): void {
  turns += 1;
  if (mode === "die") {
    process.stderr.write("boom\n");
    process.exit(3);
  }
  if (mode === "chat") {
    out({ type: "assistant", session_id: "sess-1", message: { role: "assistant", content: [{ type: "text", text: `reply ${turns}` }] } });
    out({ type: "result", subtype: "success", is_error: false, result: `reply ${turns}`, num_turns: 1, total_cost_usd: 0.01, duration_ms: 3, session_id: "sess-1" });
    return;
  }
  if (mode === "async" || mode === "quiet" || mode === "woke") {
    out({ type: "assistant", session_id: "sess-1", message: { role: "assistant", content: [{ type: "tool_use", id: "ag1", name: "Agent", input: { description: "read math.ts", subagent_type: "Explore", prompt: "read it" } }] } });
    tasks([{ task_id: "t-ag", task_type: "local_agent" }]);
    sys("task_started", { task_id: "t-ag", tool_use_id: "ag1", task_type: "local_agent", is_backgrounded: true });
    out({ type: "user", session_id: "sess-1", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "ag1", content: [{ type: "text", text: "Async agent launched successfully." }], is_error: false }] } });
    // the early result (spec P5): the main thread's turn ended, the subagent's did not
    out({ type: "result", subtype: "success", is_error: false, result: "early", num_turns: 1, total_cost_usd: 0.01, duration_ms: 1, session_id: "sess-1" });
    out({ type: "assistant", session_id: "sess-1", parent_tool_use_id: "ag1", message: { role: "assistant", content: [{ type: "tool_use", id: "sub1", name: "Bash", input: { command: "git log" } }] } });
    out({ type: "control_request", request_id: "req-a", request: { subtype: "can_use_tool", tool_name: "Bash", input: { command: "git log" }, tool_use_id: "sub1" } });
    return;
  }
  if (mode === "bgshell") {
    out({ type: "assistant", session_id: "sess-1", message: { role: "assistant", content: [{ type: "tool_use", id: "sh1", name: "Bash", input: { command: "bun run dev", run_in_background: true } }] } });
    tasks([{ task_id: "t-sh", task_type: "local_bash" }]);
    sys("task_started", { task_id: "t-sh", tool_use_id: "sh1", task_type: "local_bash", is_backgrounded: true });
    out({ type: "result", subtype: "success", is_error: false, result: "server up", num_turns: 1, total_cost_usd: 0.01, duration_ms: 1, session_id: "sess-1" });
    return;
  }
  out({
    type: "assistant",
    session_id: "sess-1",
    message: {
      role: "assistant",
      content: [
        { type: "text", text: "Looking." },
        { type: "tool_use", id: "tu1", name: "Bash", input: { command: "git status" } },
      ],
    },
  });
  bash("req-1", "git push");
  bash("req-2", "rm x");
  out({ type: "control_cancel_request", request_id: "req-2" });
}

function onResponse(m: Record<string, unknown>): void {
  const response = (m["response"] ?? {}) as Record<string, unknown>;
  if (mode === "woke" && response["request_id"] === "req-m") {
    out({ type: "user", session_id: "sess-1", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "m1", content: [{ type: "text", text: "12 pass" }], is_error: false }] } });
    out({ type: "result", subtype: "success", is_error: false, result: "final", num_turns: 3, total_cost_usd: 0.05, duration_ms: 9, session_id: "sess-1" });
    return;
  }
  if ((mode === "async" || mode === "quiet" || mode === "woke") && response["request_id"] === "req-a") {
    out({ type: "user", session_id: "sess-1", parent_tool_use_id: "ag1", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "sub1", content: [{ type: "text", text: "abc123 first" }], is_error: false }] } });
    sys("task_notification", { task_id: "t-ag", tool_use_id: "ag1", status: "completed" });
    tasks([]);
    if (mode === "quiet") return;
    if (mode === "woke") {
      // the fresh init and the main thread's own turn (spec P5)
      sys("init", { cwd: process.cwd() });
      out({ type: "assistant", session_id: "sess-1", message: { role: "assistant", content: [{ type: "tool_use", id: "m1", name: "Bash", input: { command: "bun test" } }] } });
      out({ type: "control_request", request_id: "req-m", request: { subtype: "can_use_tool", tool_name: "Bash", input: { command: "bun test" }, tool_use_id: "m1" } });
      return;
    }
    out({ type: "assistant", session_id: "sess-1", message: { role: "assistant", content: [{ type: "text", text: "All read." }] } });
    out({ type: "result", subtype: "success", is_error: false, result: "final", num_turns: 3, total_cost_usd: 0.05, duration_ms: 9, session_id: "sess-1" });
    return;
  }
  if (response["request_id"] !== "req-1") return;
  out({
    type: "user",
    session_id: "sess-1",
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tu1", content: [{ type: "text", text: "clean" }], is_error: false }] },
  });
  out({
    type: "result",
    subtype: "success",
    is_error: false,
    result: `env:${process.env["CANOPY_RUN"] ?? ""}`,
    num_turns: 2,
    total_cost_usd: 0.12,
    duration_ms: 5,
    // a later session id is not the run's
    session_id: "sess-2",
  });
}

const dec = new TextDecoder();
let buf = "";
for await (const chunk of Bun.stdin.stream()) {
  buf += dec.decode(chunk, { stream: true });
  let nl = buf.indexOf("\n");
  while (nl !== -1) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    nl = buf.indexOf("\n");
    if (!line) continue;
    const m = JSON.parse(line) as Record<string, unknown>;
    record(m);
    if (m["type"] === "user") onUser();
    else if (m["type"] === "control_response") onResponse(m);
  }
}
record({ eof: true });
process.exit(0);
