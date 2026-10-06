/** Runs on Claude Code: one `claude` process per run, driven over stdio.
 *
 *  The run spawns the `claude` binary on PATH (the same one, and the same
 *  login, as your terminal) in print mode with stream-json on both ends.
 *  Permission requests and questions come back on stdout as control
 *  requests; the run parks on them through `ctx.ask()` until the browser
 *  answers and the reply goes down stdin. Every other message is folded into
 *  the run's steps and result. No SDK: the wire format is the one the CLI
 *  speaks to its own SDK, and only the small part of it used here.
 *
 *  The prompt queue, "allow all", the notes a settled prompt leaves and how
 *  an exit becomes a status are the Runner's `RunCtx`, shared with Codex. */

import { homedir } from "node:os";
import { resolve } from "node:path";
import { describeTool, toolDetail } from "./actions";
import { normalizeAgent } from "./agent";
import { bunSpawn, type RpcProc, type RpcSpawn } from "./codexrpc";
import { spawnEnv, type DriveCtx, type DriveSpec, type RunDriver } from "./driver";
import { agentArgs } from "./harness";
import { DEFAULT_AGENT, type AgentSettings, type PermissionAsk, type RunQuestion, type RunStep } from "./types";

/** characters of tool output kept per step */
const OUTPUT_CAP = 2_000;
/** stderr kept for the failure message */
const STDERR_CAP = 2_000;
/** how long a stage run's exit waits for the last of its stderr */
const STDERR_WAIT = 1_000;
/** how long a held result waits once the subagents are done, for the turn
 *  their results wake */
const HELD_GRACE_MS = 60_000;

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const str = (o: Record<string, unknown>, k: string): string => (typeof o[k] === "string" ? o[k] : "");

const num = (o: Record<string, unknown>, k: string): number => (typeof o[k] === "number" ? o[k] : 0);

/** Whether a message is the CLI at work on a turn (a fresh init, a message,
 *  a prompt) rather than its bookkeeping about background tasks. */
const wakes = (m: Record<string, unknown>): boolean => {
  const type = str(m, "type");
  if (type === "system") return str(m, "subtype") === "init";
  return type === "assistant" || type === "user" || type === "control_request" || type === "control_cancel_request";
};

/** Text of a tool_result block, whatever shape it arrived in. */
function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((c: unknown) => (isRecord(c) ? str(c, "text") : ""))
    .filter(Boolean)
    .join("\n");
}

function clip(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}\n… (${s.length - max} more characters)` : s;
}

/** AskUserQuestion input → the questions the browser renders. Anything
 *  malformed becomes an empty list, and the run answers "deny". */
export function parseQuestions(input: Record<string, unknown>): RunQuestion[] {
  const raw = input["questions"];
  if (!Array.isArray(raw)) return [];
  const out: RunQuestion[] = [];
  for (const o of raw) {
    if (!isRecord(o)) continue;
    const question = str(o, "question");
    const header = str(o, "header");
    const options = Array.isArray(o["options"])
      ? o["options"].flatMap((p: unknown) => {
          if (!isRecord(p)) return [];
          const label = str(p, "label");
          return label ? [{ label, description: str(p, "description") }] : [];
        })
      : [];
    if (!question || options.length === 0) continue;
    out.push({ question, header, options, multiSelect: o["multiSelect"] === true });
  }
  return out;
}

/** A can_use_tool request as the permission the browser shows: the title
 *  and detail it always had, plus what the plain-language line and a
 *  remembered rule read: the model's own `description` of a Bash call (or
 *  a sub-agent's), the command, and the files a file tool names. */
export function permissionAsk(tool: string, input: Record<string, unknown>, cwd: string): PermissionAsk {
  const description = (str(input, "description") || str(input, "reason")).trim().slice(0, 500);
  const file = str(input, "file_path") || str(input, "notebook_path") || str(input, "path");
  const command = str(input, "command");
  return {
    kind: "permission",
    tool,
    title: describeTool(tool, input, cwd),
    detail: toolDetail(tool, input, cwd),
    ...(description ? { description } : {}),
    ...(tool === "Bash" && command ? { command } : {}),
    ...(file ? { paths: [absolutePath(file, cwd)] } : {}),
  };
}

/** A tool's path as the file it names: `~` is the home folder, a relative
 *  path is under the run's folder, `..` folded. */
function absolutePath(file: string, cwd: string): string {
  if (file === "~" || file.startsWith("~/")) return resolve(homedir(), file.slice(2));
  return resolve(cwd, file);
}

/** The reply the CLI expects on stdin to a can_use_tool request. */
type PermissionResult =
  | { behavior: "allow"; updatedInput: Record<string, unknown> }
  | { behavior: "deny"; message: string };

/** Where the `claude` binary is, or null. Spawning the binary directly
 *  bypasses the shell function some setups wrap around it, so no
 *  auto-update chatter lands on stdout. */
export function claudeBinary(): string | null {
  return Bun.which("claude");
}

/** The print-mode command line. The repo's agent settings ride along the
 *  way they would on an interactive `claude`, except that yolo becomes the
 *  bypass permission mode: the interactive flag and the prompt tool are two
 *  ways of answering the same question, and print mode takes the mode. */
export function cliArgs(spec: DriveSpec, agent: AgentSettings = DEFAULT_AGENT, stage = false): string[] {
  const flags = agentArgs({ ...agent, yolo: false });
  return [
    "-p",
    "--output-format",
    "stream-json",
    "--input-format",
    "stream-json",
    "--verbose",
    // permission decisions the settings do not cover come to us on stdout
    "--permission-prompt-tool",
    "stdio",
    "--permission-mode",
    agent.yolo ? "bypassPermissions" : "default",
    "--max-turns",
    String(spec.maxTurns),
    // The same CLAUDE.md files and permission rules a terminal session
    // would load, minus MCP servers: a git chore does not need them and
    // their startup would delay every run.
    // An incubator stage reads the user's alone: an earlier step could have
    // written the seed a .claude/settings.json with hooks or wider rules.
    "--setting-sources",
    stage ? "user" : "user,project,local",
    "--strict-mcp-config",
    ...(spec.allowedTools.length ? ["--allowedTools", spec.allowedTools.join(",")] : []),
    ...(spec.addDirs ?? []).flatMap((d) => ["--add-dir", d]),
    ...flags,
  ];
}

/** A user message as the CLI reads it on stdin. */
const userMessage = (content: string) => ({
  type: "user",
  message: { role: "user", content },
  parent_tool_use_id: null,
  session_id: "",
});

export interface ClaudeOptions {
  /** argv that starts claude, before its flags; the default is the claude
   *  binary on PATH (a stand-in in tests) */
  command?: readonly string[];
  /** starts the process; Bun.spawn with every stream piped unless a test
   *  swaps it. A stage run's own spawn (`DriveCtx.spawn`) wins over it. */
  spawn?: RpcSpawn;
  /** how long a held result waits once the subagents are done, for the turn they wake */
  heldGraceMs?: number;
}

export class ClaudeDriver implements RunDriver {
  readonly harness = "claude" as const;
  readonly label = "Claude Code";
  private ctx: DriveCtx | null = null;
  private proc: RpcProc | null = null;
  /** the binary check() found */
  private bin: string | null = null;
  /** tool_use id → its step, to attach results to their call */
  private tools = new Map<string, RunStep>();
  /** the session id is taken from the first message that carries one */
  private sessionSeen = false;
  /** live subagent task ids (spec P7): task_type local_agent only, since a
   *  background shell may run for good (a dev server) and must not hold a
   *  run open */
  private agents = new Set<string>();
  /** the last result that came while subagents ran */
  private held: Record<string, unknown> | null = null;
  private grace: ReturnType<typeof setTimeout> | null = null;
  /** the subagents are done and the turn they woke has begun: the held
   *  result now waits for that turn's own, however long it runs */
  private woke = false;

  constructor(private opts: ClaudeOptions = {}) {}

  check(): string | null {
    if (this.opts.command?.length) return null;
    this.bin = claudeBinary();
    return this.bin ? null : "the claude CLI is not on PATH; install Claude Code and sign in first";
  }

  start(ctx: DriveCtx, message: string): void {
    this.ctx = ctx;
    void this.drive(message);
  }

  /** A chat's next message goes down the same stdin as a plain user
   *  message, and the CLI keeps the conversation. */
  say(text: string): void {
    void this.send(userMessage(text));
  }

  /** A chat between turns closes stdin and the CLI exits on its own;
   *  anything else is killed. */
  stop(): void {
    const proc = this.proc;
    if (!proc || !this.ctx) return;
    if (this.ctx.status() === "idle") proc.stdin.end();
    else {
      // a result held for a subagent is not the run's once it is stopped
      this.held = null;
      this.woke = false;
      this.clearGrace();
      proc.kill();
    }
  }

  private clearGrace(): void {
    if (this.grace) {
      clearTimeout(this.grace);
      this.grace = null;
    }
  }

  /** What one system message says about background work. */
  private noteBackground(m: Record<string, unknown>): void {
    const sub = str(m, "subtype");
    if (sub === "background_tasks_changed" && Array.isArray(m["tasks"])) {
      // the CLI's own list is the truth: a lost notification cannot hold a run
      this.agents = new Set(
        m["tasks"]
          .filter(isRecord)
          .filter((t) => str(t, "task_type") === "local_agent")
          .map((t) => str(t, "task_id")),
      );
    } else if (sub === "task_started" && str(m, "task_type") === "local_agent") this.agents.add(str(m, "task_id"));
    else if (sub === "task_notification") this.agents.delete(str(m, "task_id"));
  }

  private async drive(message: string): Promise<void> {
    const ctx = this.ctx;
    if (!ctx) return;
    const chat = ctx.chat;
    let stderr = "";
    let proc: RpcProc | null = null;
    // a chat's later turns reuse this process, so only a new drive resets these
    this.agents = new Set();
    this.held = null;
    this.woke = false;
    this.clearGrace();
    try {
      const spawn = ctx.spawn ?? this.opts.spawn ?? bunSpawn;
      // the stage runner starts programs by bare name, out of its own PATH
      const command = ctx.spawn
        ? ["claude"]
        : this.opts.command?.length
          ? [...this.opts.command]
          : [this.bin ?? claudeBinary() ?? "claude"];
      // normalized again as Claude's own, so a stray value never reaches the
      // command line; settings the Runner resolved come through unchanged
      const agent = normalizeAgent({ ...ctx.agent, harness: "claude" });
      const started = spawn([...command, ...cliArgs(ctx.spec, agent, ctx.stage ?? false)], { cwd: ctx.cwd, env: spawnEnv(ctx) });
      proc = ctx.track ? ctx.track(started) : started;
      this.proc = proc;
      const stderrRead = new Response(proc.stderr ?? new ReadableStream()).text().then((text) => {
        stderr = text.slice(-STDERR_CAP);
      });
      await this.send(userMessage(message));

      for await (const m of lines(proc.stdout)) {
        const session = str(m, "session_id");
        if (session && !this.sessionSeen) {
          this.sessionSeen = true;
          ctx.session(session);
        }
        if (this.held && this.agents.size === 0 && wakes(m)) {
          // spec P5: the subagents' end starts a turn; its result is the
          // real one, and a prompt or a long tool call in it is no reason
          // to fall back on the held one
          this.woke = true;
          this.clearGrace();
        }
        if (m["type"] === "control_request") {
          void this.control(m);
        } else if (m["type"] === "control_cancel_request") {
          ctx.withdraw(str(m, "request_id"));
        } else {
          // any word from the CLI means the turn the subagents woke is running
          this.clearGrace();
          if (m["type"] === "system") this.noteBackground(m);
          if (m["type"] === "result" && this.agents.size > 0) {
            // spec P5/P6: the main thread paused for a subagent; closing
            // stdin now would fail every later permission request
            this.held = m;
            this.woke = false;
            continue;
          }
          if (m["type"] === "result") this.held = null;
          this.apply(m);
          // Stdin stays open while the turn runs, for the control replies.
          // The result ends the turn; closing stdin lets the CLI exit. A chat
          // keeps it open: the next message continues the same session.
          if (m["type"] === "result" && !chat) proc.stdin.end();
          // subagents done, a result held: the CLI normally starts a turn
          // with their results; if none begins, the held result is the end
          if (this.held && this.agents.size === 0 && !this.woke && !this.grace) {
            const held = this.held;
            const running = proc;
            this.grace = setTimeout(() => {
              this.grace = null;
              if (this.held !== held) return;
              this.held = null;
              this.apply(held);
              if (!chat) running.stdin.end();
            }, this.opts.heldGraceMs ?? HELD_GRACE_MS);
          }
        }
      }
      this.clearGrace();
      const held = this.held;
      this.held = null;
      const code = await proc.exited;
      // Through the stage runner, stderr carries the runner's own word on a
      // failure (that it is not answering), which a flow parks on: give it a
      // moment to land. A local process's run keeps its old timing, unless a
      // held result needs the tail to say why the process died.
      if (ctx.spawn || (held && code !== 0)) await Promise.race([stderrRead, Bun.sleep(STDERR_WAIT)]);
      // The process ended with a result still held. A clean exit makes it
      // the run's, not a failure for want of one; a crash while a subagent
      // ran is a failure, whatever the early result said. A stop dropped it.
      if (held) {
        const tail = stderr.trim();
        this.apply(held, code === 0 ? null : `${this.label} exited (code ${code}) while a subagent ran${tail ? `: ${tail}` : ""}`);
      }
      ctx.exited({ code, stderr });
    } catch (err) {
      ctx.exited({ code: null, stderr, error: errText(err) });
    } finally {
      // a throw must not leave the grace timer to apply a result after the
      // exit, onto a run that already ended
      this.clearGrace();
      this.held = null;
      if (this.proc === proc) this.proc = null;
    }
  }

  private async send(msg: unknown): Promise<void> {
    const proc = this.proc;
    if (!proc) return;
    try {
      proc.stdin.write(JSON.stringify(msg) + "\n");
      // Awaited: the write must reach the pipe before the caller starts
      // draining stdout, or a resumed turn can begin before its own prompt
      // arrives and end empty.
      await proc.stdin.flush?.();
    } catch {
      // the process is gone; the read loop will report that
    }
  }

  /** A control request from the CLI. Only can_use_tool is understood; the
   *  rest get an error reply so the CLI never waits on us. */
  private async control(m: Record<string, unknown>): Promise<void> {
    const requestId = str(m, "request_id");
    const request = isRecord(m["request"]) ? m["request"] : {};
    if (str(request, "subtype") !== "can_use_tool") {
      await this.send({
        type: "control_response",
        response: { subtype: "error", request_id: requestId, error: "not supported by canopy" },
      });
      return;
    }
    const tool = str(request, "tool_name");
    const input = isRecord(request["input"]) ? request["input"] : {};
    const response = await this.permission(requestId, tool, input);
    await this.send({
      type: "control_response",
      response: { subtype: "success", request_id: requestId, response },
    });
  }

  private async permission(requestId: string, tool: string, input: Record<string, unknown>): Promise<PermissionResult> {
    const ctx = this.ctx;
    if (!ctx) return { behavior: "deny", message: "The run is gone." };
    if (tool === "AskUserQuestion") {
      const questions = parseQuestions(input);
      if (questions.length === 0) {
        return { behavior: "deny", message: "The question could not be shown." };
      }
      const a = await ctx.ask({ kind: "question", questions }, requestId);
      if (a.kind === "answers") return { behavior: "allow", updatedInput: { ...input, answers: a.answers } };
      return {
        behavior: "deny",
        message: (a.kind === "deny" && a.message) || "The user closed the question without answering. Stop and summarize.",
      };
    }
    const a = await ctx.ask(permissionAsk(tool, input, ctx.cwd), requestId);
    if (a.kind === "allow" || a.kind === "allow-all") return { behavior: "allow", updatedInput: input };
    return {
      behavior: "deny",
      message:
        (a.kind === "deny" && a.message) || "The user declined this in canopy. Do not retry it; continue without it, or stop and explain what is left.",
    };
  }

  /** Folds one message into the run. `failure`, for a result only, is the
   *  problem that overrides what the result itself says. */
  private apply(m: Record<string, unknown>, failure: string | null = null): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const type = str(m, "type");
    if (type === "assistant" || type === "user") {
      const message = isRecord(m["message"]) ? m["message"] : {};
      const content = message["content"];
      if (!Array.isArray(content)) return;
      let changed = false;
      for (const block of content) {
        if (!isRecord(block)) continue;
        const kind = str(block, "type");
        if (kind === "text") {
          const text = str(block, "text").trim();
          if (text) {
            ctx.step({ kind: "text", text });
            changed = true;
          }
        } else if (kind === "tool_use") {
          const input = isRecord(block["input"]) ? block["input"] : {};
          const name = str(block, "name");
          const step = ctx.step({
            kind: "tool",
            tool: { name, title: describeTool(name, input, ctx.cwd), status: "running" },
          });
          this.tools.set(str(block, "id"), step);
          changed = true;
        } else if (kind === "tool_result") {
          const step = this.tools.get(str(block, "tool_use_id"));
          if (!step?.tool) continue;
          step.tool.status = block["is_error"] === true ? "error" : "ok";
          const text = resultText(block["content"]).trim();
          if (text) step.tool.output = clip(text, OUTPUT_CAP);
          changed = true;
        }
      }
      if (changed) ctx.changed();
      return;
    }
    if (type === "result") {
      const subtype = str(m, "subtype");
      const isError = m["is_error"] === true;
      const errors = Array.isArray(m["errors"])
        ? m["errors"].filter((e): e is string => typeof e === "string")
        : [];
      const text = subtype === "success" ? str(m, "result") : errors.join("\n");
      const turns = num(m, "num_turns");
      const ok = subtype === "success" && !isError;
      const problem =
        subtype === "error_max_turns"
          ? `stopped after ${turns} turns without finishing`
          : subtype === "error_max_budget_usd"
            ? "stopped at the spending limit"
            : text.trim() || "Claude Code reported an error";
      // A job ends with it; a chat's result ends one reply, not the
      // conversation, and a reply that failed is said in the timeline.
      ctx.result(
        { text: text.trim(), costUsd: num(m, "total_cost_usd"), durationMs: num(m, "duration_ms"), turns },
        failure ?? (ok ? null : problem),
      );
    }
  }
}

/** stdout as parsed JSON objects, one per line; anything else is skipped. */
async function* lines(stream: ReadableStream<Uint8Array>): AsyncGenerator<Record<string, unknown>> {
  const dec = new TextDecoder();
  let buf = "";
  for await (const chunk of stream) {
    buf += dec.decode(chunk, { stream: true });
    let nl = buf.indexOf("\n");
    while (nl !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      nl = buf.indexOf("\n");
      if (!line) continue;
      try {
        const parsed: unknown = JSON.parse(line);
        if (isRecord(parsed)) yield parsed;
      } catch {
        // progress chatter that is not JSON
      }
    }
  }
}
