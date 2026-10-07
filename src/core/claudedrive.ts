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
import { activeStatus, spawnEnv, type DriveCtx, type DriveSpec, type RunDriver } from "./driver";
import { agentArgs } from "./harness";
import { DEFAULT_AGENT, type AgentSettings, type PermissionAsk, type RunQuestion, type RunStep, type RunTodo } from "./types";
import { TODO_TOOLS, todoCreated, todoUpdated, todoWritten } from "./todos";

/** characters of tool output kept per step */
const OUTPUT_CAP = 2_000;
/** stderr kept for the failure message */
const STDERR_CAP = 2_000;
/** how long a stage run's exit waits for the last of its stderr */
const STDERR_WAIT = 1_000;
/** how long a held result waits once the subagents are done, for the turn
 *  their results wake */
const HELD_GRACE_MS = 60_000;
/** how long canopy's own control request waits for the CLI's reply */
const REQUEST_MS = 10_000;

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const str = (o: Record<string, unknown>, k: string): string => (typeof o[k] === "string" ? o[k] : "");

const num = (o: Record<string, unknown>, k: string): number => (typeof o[k] === "number" ? o[k] : 0);

/** Whether a message is the CLI at work on a turn (a fresh init, a message,
 *  a prompt) rather than its bookkeeping about background tasks. A
 *  subagent's own message (one with `parent_tool_use_id`) is never the main
 *  thread's turn, even one that straggles in after the task list emptied. */
const wakes = (m: Record<string, unknown>): boolean => {
  if (str(m, "parent_tool_use_id")) return false;
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

/** A can_use_tool reply, and what to send once it is on the wire: the mode
 *  switch after a plan's approval, which the allow would undo (spec P8).
 *  Each reply carries its own, so two prompts settled together can never
 *  send one's switch before the other's allow. */
interface PermissionReply {
  result: PermissionResult;
  after?: () => Promise<void>;
}

/** How the CLI answered one of canopy's own control requests. */
type RequestReply = { ok: true; response: Record<string, unknown> } | { ok: false; error: string };

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
    spec.permissionMode ?? (agent.yolo ? "bypassPermissions" : "default"),
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
    // spec P8: a switch to bypass after the plan is refused without it; a
    // run that starts in bypass needs no switch
    ...(spec.permissionMode === "plan" && agent.yolo ? ["--allow-dangerously-skip-permissions"] : []),
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
  /** how long canopy's own control request waits for the CLI's reply */
  requestMs?: number;
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
  /** main-thread todo tool calls by id, read once their result arrives */
  private todoInputs = new Map<string, { name: string; input: Record<string, unknown> }>();
  private todos: RunTodo[] = [];
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
  /** the turns of results held and then outrun by a later one, which the
   *  CLI counts per result: the run's own result adds them back. Null when
   *  nothing was held, so a plain result keeps the CLI's own numbers. */
  private heldTurns: number | null = null;
  /** when the message that began this turn went down stdin, for the time
   *  of a result after a hold (the CLI times its last turn alone) */
  private turnStart = Date.now();
  /** canopy's own control requests to the CLI, waiting on its control_response */
  private asked = new Map<string, { settle: (r: RequestReply) => void; done: Promise<RequestReply> }>();
  private asks = 0;
  /** what a sent reply still has to do (a mode switch), until it is done */
  private followUps = new Set<Promise<void>>();
  /** the CLI's stdout has ended: a request now gets no reply */
  private closed = false;

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
    this.turnStart = Date.now();
    this.heldTurns = null;
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
    this.heldTurns = null;
    this.turnStart = Date.now();
    this.clearGrace();
    this.closed = false;
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
        if (m["type"] === "control_response") {
          // the CLI's reply to a request of canopy's own: not the CLI at work
          // on a turn, so it leaves the grace alone
          const r = isRecord(m["response"]) ? m["response"] : {};
          this.asked
            .get(str(r, "request_id"))
            ?.settle(str(r, "subtype") === "success" ? { ok: true, response: isRecord(r["response"]) ? r["response"] : {} } : { ok: false, error: str(r, "error") || "refused" });
          continue;
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
            if (this.held) this.heldTurns = (this.heldTurns ?? 0) + num(this.held, "num_turns");
            this.held = m;
            this.woke = false;
            continue;
          }
          if (m["type"] === "result" && this.held) {
            this.heldTurns = (this.heldTurns ?? 0) + num(this.held, "num_turns");
            this.held = null;
          }
          this.apply(m);
          // Stdin stays open while the turn runs, for the control replies.
          // The result ends the turn; closing stdin lets the CLI exit. A chat
          // keeps it open: the next message continues the same session.
          if (m["type"] === "result" && !chat) this.endInput(proc);
          // subagents done, a result held: the CLI normally starts a turn
          // with their results; if none begins, the held result is the end
          if (this.held && this.agents.size === 0 && !this.woke && !this.grace) {
            const held = this.held;
            const running = proc;
            this.grace = setTimeout(() => {
              this.grace = null;
              if (this.held !== held) return;
              this.held = null;
              // a held result is timed from the start too, as one that outran it is
              this.heldTurns ??= 0;
              this.apply(held);
              if (!chat) this.endInput(running);
            }, this.opts.heldGraceMs ?? HELD_GRACE_MS);
          }
        }
      }
      this.clearGrace();
      // no reply comes now; a follow-up waiting on one gives up at once
      this.closed = true;
      for (const a of this.asked.values()) a.settle({ ok: false, error: "the run ended" });
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
        this.heldTurns ??= 0;
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

  /** Closes stdin, which lets the CLI exit, once canopy's own requests and
   *  the follow-ups that send them are done: closing it first would cut
   *  them off (spec P6). Each request gives up after its own wait, and a
   *  follow-up that failed counts as done, so this never holds a run open
   *  for good. */
  private endInput(proc: RpcProc): void {
    const waits: Promise<unknown>[] = [...this.followUps, ...[...this.asked.values()].map((a) => a.done)];
    if (waits.length > 0) {
      void Promise.allSettled(waits).then(() => this.endInput(proc));
      return;
    }
    try {
      proc.stdin.end();
    } catch {
      // the process is gone; the read loop will report that
    }
  }

  /** A control request from canopy to the CLI (spec P3), settled by its
   *  control_response, an error, or `ms` without one. */
  private request(subtype: string, body: Record<string, unknown>, ms = this.opts.requestMs ?? REQUEST_MS): Promise<RequestReply> {
    if (this.closed || !this.proc) return Promise.resolve({ ok: false, error: "the run ended" });
    const id = `canopy-${++this.asks}`;
    let settle: (r: RequestReply) => void = () => {};
    const done = new Promise<RequestReply>((resolve) => {
      const timer = setTimeout(() => settle({ ok: false, error: "no answer" }), ms);
      settle = (r) => {
        clearTimeout(timer);
        this.asked.delete(id);
        resolve(r);
      };
    });
    this.asked.set(id, { settle, done });
    void this.send({ type: "control_request", request_id: id, request: { subtype, ...body } });
    return done;
  }

  /** After a plan's approval: bypass when the user chose "run on its own"
   *  (and the agent's settings allow it), else acceptEdits, so edits go
   *  through and commands still ask (spec P3). A switch that fails still
   *  leaves the plan approved, and says so while the run is live. */
  private async switchMode(auto: boolean): Promise<void> {
    const ctx = this.ctx;
    if (!ctx) return;
    // a stop or a crash leaves no note behind on a run that is ending
    const say = (text: string) => {
      if (!this.closed && activeStatus(ctx.status())) ctx.note(text);
    };
    if (auto) {
      const bypass = await this.request("set_permission_mode", { mode: "bypassPermissions" });
      if (bypass.ok) return;
      say(`could not run on its own (${bypass.error}); asking before commands instead`);
    }
    const edits = await this.request("set_permission_mode", { mode: "acceptEdits" });
    if (!edits.ok) say(`could not switch to acceptEdits (${edits.error}); every edit will ask`);
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
    const { result, after } = await this.permission(requestId, tool, input);
    const sent = this.send({
      type: "control_response",
      response: { subtype: "success", request_id: requestId, response: result },
    });
    if (!after) return sent;
    // tracked from before the allow goes out, so a result in between cannot
    // close stdin ahead of the switch; one that throws must neither hold
    // stdin open nor go unhandled
    const followUp: Promise<void> = sent
      .then(after)
      .catch(() => {})
      .finally(() => this.followUps.delete(followUp));
    this.followUps.add(followUp);
    await followUp;
  }

  private async permission(requestId: string, tool: string, input: Record<string, unknown>): Promise<PermissionReply> {
    const ctx = this.ctx;
    if (!ctx) return { result: { behavior: "deny", message: "The run is gone." } };
    if (tool === "ExitPlanMode") {
      // spec P1: plan mode's end is the plan, put to the user as a proposal
      const plan = str(input, "plan").trim();
      if (!plan) return { result: { behavior: "deny", message: "The plan came through empty. Present it again with ExitPlanMode." } };
      ctx.proposal(plan);
      const a = await ctx.ask({ kind: "proposal", plan, auto: ctx.agent.yolo }, requestId);
      if (a.kind === "approve" || a.kind === "allow") {
        // never past what the agent's settings allow: auto needs yolo
        const auto = a.kind === "approve" && a.auto && ctx.agent.yolo;
        return { result: { behavior: "allow", updatedInput: input }, after: () => this.switchMode(auto) };
      }
      return {
        result: {
          behavior: "deny",
          message: (a.kind === "deny" && a.message) || "The user turned the plan down. Stop here and summarize what you found.",
        },
      };
    }
    if (tool === "AskUserQuestion") {
      const questions = parseQuestions(input);
      if (questions.length === 0) {
        return { result: { behavior: "deny", message: "The question could not be shown." } };
      }
      const a = await ctx.ask({ kind: "question", questions }, requestId);
      if (a.kind === "answers") return { result: { behavior: "allow", updatedInput: { ...input, answers: a.answers } } };
      return {
        result: {
          behavior: "deny",
          message: (a.kind === "deny" && a.message) || "The user closed the question without answering. Stop and summarize.",
        },
      };
    }
    const a = await ctx.ask(permissionAsk(tool, input, ctx.cwd), requestId);
    if (a.kind === "allow" || a.kind === "allow-all") return { result: { behavior: "allow", updatedInput: input } };
    return {
      result: {
        behavior: "deny",
        message:
          (a.kind === "deny" && a.message) || "The user declined this in canopy. Do not retry it; continue without it, or stop and explain what is left.",
      },
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
      const parentUse = str(m, "parent_tool_use_id");
      const parent = parentUse ? this.tools.get(parentUse)?.id : undefined;
      for (const block of content) {
        if (!isRecord(block)) continue;
        const kind = str(block, "type");
        if (kind === "text") {
          const text = str(block, "text").trim();
          if (text) {
            ctx.step({ kind: "text", text, ...(parent ? { parent } : {}) });
            changed = true;
          }
        } else if (kind === "tool_use") {
          const input = isRecord(block["input"]) ? block["input"] : {};
          const name = str(block, "name");
          const step = ctx.step({
            kind: "tool",
            tool: { name, title: describeTool(name, input, ctx.cwd), status: "running" },
            ...(parent ? { parent } : {}),
          });
          this.tools.set(str(block, "id"), step);
          if (!parentUse && TODO_TOOLS.has(name)) {
            if (name === "TodoWrite") {
              const next = todoWritten(input);
              if (next) {
                this.todos = next;
                ctx.todos(next);
              }
            } else {
              this.todoInputs.set(str(block, "id"), { name, input });
            }
          }
          changed = true;
        } else if (kind === "tool_result") {
          const useId = str(block, "tool_use_id");
          const step = this.tools.get(useId);
          const todoCall = this.todoInputs.get(useId);
          if (todoCall) {
            this.todoInputs.delete(useId);
            if (block["is_error"] !== true) {
              if (todoCall.name === "TaskCreate") this.todos = todoCreated(this.todos, todoCall.input, resultText(block["content"]));
              else if (todoCall.name === "TaskUpdate") this.todos = todoUpdated(this.todos, todoCall.input);
              if (todoCall.name === "TaskCreate" || todoCall.name === "TaskUpdate") ctx.todos(this.todos);
            }
          }
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
      const own = num(m, "num_turns");
      // a result that outran a held one, or a held one the run ends on,
      // counts every turn since the message and the time since it went
      // down stdin
      const outran = this.heldTurns !== null;
      const turns = own + (this.heldTurns ?? 0);
      const durationMs = outran ? Date.now() - this.turnStart : num(m, "duration_ms");
      this.heldTurns = null;
      const ok = subtype === "success" && !isError;
      const problem =
        subtype === "error_max_turns"
          ? `stopped after ${own} turns without finishing`
          : subtype === "error_max_budget_usd"
            ? "stopped at the spending limit"
            : text.trim() || "Claude Code reported an error";
      // A job ends with it; a chat's result ends one reply, not the
      // conversation, and a reply that failed is said in the timeline.
      ctx.result(
        { text: text.trim(), costUsd: num(m, "total_cost_usd"), durationMs, turns },
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
