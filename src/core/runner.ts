/** Runs: one Claude Code session per job, driven over stdio.
 *
 *  Each run spawns the `claude` binary on PATH (the same one, and the same
 *  login, as your terminal) in print mode with stream-json on both ends.
 *  Permission requests and questions come back on stdout as control
 *  requests; the run parks in "waiting" until the browser answers and the
 *  reply goes down stdin. Every other message is folded into a plain `Run`
 *  that the server broadcasts whole. No SDK: the wire format is the one the
 *  CLI speaks to its own SDK, and only the small part of it used here. */

import {
  buildPrompt,
  describeTool,
  toolDetail,
  type ActionSpec,
} from "./actions";
import { claudeArgs } from "./agent";
import {
  DEFAULT_AGENT,
  isRunActive,
  statusFingerprint,
  type AgentSettings,
  type Repo,
  type RepoStatus,
  type Run,
  type RunAnswer,
  type RunPrompt,
  type RunQuestion,
  type RunStatus,
  type RunStep,
} from "./types";

/** characters of tool output kept per step */
const OUTPUT_CAP = 2_000;
/** steps kept per run; the oldest fall off with a note */
const STEP_CAP = 400;
/** finished runs kept for late-joining browsers */
const KEEP_FINISHED = 60;
/** stderr kept for the failure message */
const STDERR_CAP = 2_000;

export interface RunnerHooks {
  onChange: (run: Run) => void;
  onGone: (id: string) => void;
  /** a fresh git status for the repo, read when a run ends, to tell whether
   *  the run changed anything the card shows; null when unreadable */
  status?: (repoId: string) => Promise<RepoStatus | null>;
}

/** a prompt the CLI is waiting on, and how to answer it */
interface Pending {
  /** the control request it answers, to honour a cancel from the CLI */
  requestId: string;
  prompt: RunPrompt;
  settle: (a: RunAnswer) => void;
}

interface Live {
  run: Run;
  /** the repo as it was when the run started; also what a continuation
   *  reuses for the prompt's cwd and spec */
  repo: Repo;
  spec: ActionSpec;
  /** the repo's agent settings when the run started */
  agent: AgentSettings;
  bin: string;
  /** status fingerprint at start, compared with the one at the end */
  before: string;
  /** absolute repo path, for shortening paths in step titles */
  root: string;
  proc: Bun.Subprocess<"pipe", "pipe", "pipe"> | null;
  /** set by stop(): the exit that follows is a stop, not a failure */
  stopping: boolean;
  /** a chat whose stdin was closed on purpose: the exit that follows is the
   *  end of the conversation, not a failure */
  ending: boolean;
  /** "allow all for this run" was chosen: later permissions pass silently */
  allowAll: boolean;
  /** The prompts the CLI is waiting on, oldest first; the first is the one
   *  the run shows. More than one when Claude calls tools in parallel: each
   *  call asks on its own and every one needs its own answer. */
  pending: Pending[];
  /** numbers the prompts, so no two share an id */
  prompts: number;
  /** tool_use id → step id, to attach results to their call */
  tools: Map<string, string>;
  seq: number;
}

const errText = (err: unknown): string =>
  err instanceof Error ? err.message : String(err);

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const str = (o: Record<string, unknown>, k: string): string =>
  typeof o[k] === "string" ? o[k] : "";

const num = (o: Record<string, unknown>, k: string): number =>
  typeof o[k] === "number" ? o[k] : 0;

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
function parseQuestions(input: Record<string, unknown>): RunQuestion[] {
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
export function cliArgs(spec: ActionSpec, agent: AgentSettings = DEFAULT_AGENT): string[] {
  const flags = claudeArgs({ ...agent, yolo: false });
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
    "--setting-sources",
    "user,project,local",
    "--strict-mcp-config",
    ...(spec.allowedTools.length ? ["--allowedTools", spec.allowedTools.join(",")] : []),
    ...flags,
  ];
}

export class Runner {
  private live = new Map<string, Live>();

  constructor(private hooks: RunnerHooks) {}

  list(): Run[] {
    return [...this.live.values()].map((l) => l.run);
  }

  get(id: string): Run | undefined {
    return this.live.get(id)?.run;
  }

  activeFor(repoId: string): Run | undefined {
    for (const l of this.live.values()) {
      if (l.run.repoId === repoId && isRunActive(l.run)) return l.run;
    }
    return undefined;
  }

  /** Starts a run. A chat may start with nothing to say: it opens idle, with
   *  no process, and the first message spawns Claude. */
  start(
    repo: Repo,
    action: string,
    spec: ActionSpec,
    note: string,
    agent: AgentSettings = DEFAULT_AGENT,
    by?: string,
  ): Run {
    const busy = this.activeFor(repo.id);
    if (busy) {
      throw new Error(`${repo.name} already has a ${busy.verb} run going`);
    }
    if (spec.noteRequired && !note.trim()) {
      throw new Error("write what Claude should do first");
    }
    const bin = claudeBinary();
    if (!bin) {
      throw new Error("the claude CLI is not on PATH; install Claude Code and sign in first");
    }
    const chat = spec.mode === "chat";
    const run: Run = {
      id: crypto.randomUUID().slice(0, 8),
      repoId: repo.id,
      action,
      verb: spec.verb,
      progress: spec.progress,
      expectsChange: spec.expectsChange,
      chat,
      // a chat keeps its messages as steps; the note box is not its record
      note: chat ? "" : note.trim(),
      status: chat && !note.trim() ? "idle" : "working",
      startedAt: Date.now(),
      steps: [],
      prompt: null,
    };
    if (by) run.by = by;
    const live: Live = {
      run,
      repo,
      spec,
      agent,
      bin,
      before: statusFingerprint(repo.status),
      root: repo.path,
      proc: null,
      stopping: false,
      ending: false,
      allowAll: false,
      pending: [],
      prompts: 0,
      tools: new Map(),
      seq: 0,
    };
    this.live.set(run.id, live);
    this.prune();
    if (chat) {
      if (note.trim()) this.step(live, { kind: "user", text: note.trim() });
      this.hooks.onChange(run);
      if (note.trim()) void this.drive(live, buildPrompt(repo, spec, note));
      return run;
    }
    this.hooks.onChange(run);
    void this.drive(live, buildPrompt(repo, spec, live.run.note));
    return run;
  }

  /** The user's next message in a chat. The first one spawns Claude with the
   *  repo's framing around it; later ones go down the same stdin as plain
   *  user messages, and the CLI keeps the conversation. */
  say(id: string, text: string): Run {
    const live = this.live.get(id);
    if (!live) throw new Error(`unknown run: ${id}`);
    if (!live.run.chat) throw new Error("only a chat takes messages");
    if (live.run.status !== "idle") throw new Error("Claude is still replying");
    const message = text.trim();
    if (!message) throw new Error("say something first");
    this.step(live, { kind: "user", text: message });
    live.run.status = "working";
    this.emit(live);
    if (live.proc) {
      void this.send(live, {
        type: "user",
        message: { role: "user", content: message },
        parent_tool_use_id: null,
        session_id: "",
      });
    } else {
      void this.drive(live, buildPrompt(live.repo, live.spec, message));
    }
    return live.run;
  }

  /** Settles the prompt the run is waiting on. */
  answer(id: string, promptId: string, answer: RunAnswer): Run {
    const live = this.live.get(id);
    if (!live) throw new Error(`unknown run: ${id}`);
    const waiting = live.pending.find((p) => p.prompt.id === promptId);
    if (!waiting) throw new Error("that prompt is no longer waiting");
    waiting.settle(answer);
    return live.run;
  }

  /** Stops a run. A chat between turns ends politely: its stdin closes, the
   *  CLI exits on its own, and the chat is done rather than stopped. A chat
   *  that never spawned Claude is simply done. */
  stop(id: string): Run {
    const live = this.live.get(id);
    if (!live) throw new Error(`unknown run: ${id}`);
    if (!isRunActive(live.run)) return live.run;
    if (live.run.status === "idle") {
      if (!live.proc) {
        this.finish(live, "done");
        return live.run;
      }
      live.ending = true;
      live.proc.stdin.end();
      return live.run;
    }
    live.stopping = true;
    // settling takes an entry off the queue, so walk a copy
    for (const p of live.pending.slice()) p.settle({ kind: "deny" });
    live.proc?.kill();
    return live.run;
  }

  /** Forgets a finished run. Active runs must be stopped first. */
  dismiss(id: string): void {
    const live = this.live.get(id);
    if (!live) return;
    if (isRunActive(live.run)) throw new Error("stop the run before dismissing it");
    this.live.delete(id);
    this.hooks.onGone(id);
  }

  /** Stops everything, for server shutdown. */
  stopAll(): void {
    for (const l of this.live.values()) {
      if (isRunActive(l.run)) this.stop(l.run.id);
    }
  }

  private prune(): void {
    const finished = [...this.live.values()]
      .filter((l) => !isRunActive(l.run))
      .sort((a, b) => (a.run.endedAt ?? 0) - (b.run.endedAt ?? 0));
    while (finished.length > KEEP_FINISHED) {
      const oldest = finished.shift();
      if (!oldest) break;
      this.live.delete(oldest.run.id);
      this.hooks.onGone(oldest.run.id);
    }
  }

  private emit(live: Live): void {
    this.hooks.onChange(live.run);
  }

  private step(live: Live, step: Omit<RunStep, "id" | "at">): RunStep {
    live.seq += 1;
    const full: RunStep = { id: String(live.seq), at: Date.now(), ...step };
    live.run.steps.push(full);
    if (live.run.steps.length > STEP_CAP) {
      const dropped = live.run.steps.length - STEP_CAP;
      live.run.steps.splice(0, dropped);
      const first = live.run.steps[0];
      if (first && first.kind !== "note") {
        live.run.steps.unshift({
          id: "trim",
          at: first.at,
          kind: "note",
          text: "earlier steps trimmed",
        });
      }
    }
    return full;
  }

  private finish(live: Live, status: RunStatus, error?: string): void {
    if (!isRunActive(live.run)) return;
    live.run.status = status;
    live.run.endedAt = Date.now();
    live.run.prompt = null;
    if (error) live.run.error = error;
    this.emit(live);
    void this.settle(live);
  }

  /** Reads git status once the run is over and records whether it moved. */
  private async settle(live: Live): Promise<void> {
    const read = this.hooks.status;
    if (!read) return;
    let after: string | null = null;
    try {
      const st = await read(live.run.repoId);
      after = st ? statusFingerprint(st) : null;
    } catch {
      after = null;
    }
    // A continuation may have started meanwhile; its own end will settle.
    if (after === null || isRunActive(live.run)) return;
    live.run.outcome = after === live.before ? "unchanged" : "changed";
    this.emit(live);
  }

  private async drive(live: Live, message: string): Promise<void> {
    const { bin, repo, spec, agent } = live;
    const chat = live.run.chat;
    let stderr = "";
    let proc: Bun.Subprocess<"pipe", "pipe", "pipe"> | null = null;
    try {
      proc = Bun.spawn([bin, ...cliArgs(spec, agent)], {
        cwd: repo.path,
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      });
      live.proc = proc;
      void new Response(proc.stderr).text().then((text) => {
        stderr = text.slice(-STDERR_CAP);
      });
      await this.send(live, {
        type: "user",
        message: { role: "user", content: message },
        parent_tool_use_id: null,
        session_id: "",
      });

      for await (const m of lines(proc.stdout)) {
        if (m["type"] === "control_request") {
          void this.control(live, m);
        } else if (m["type"] === "control_cancel_request") {
          live.pending.find((p) => p.requestId === str(m, "request_id"))?.settle({ kind: "deny" });
        } else {
          this.apply(live, m);
          // Stdin stays open while the turn runs, for the control replies.
          // The result ends the turn; closing stdin lets the CLI exit. A chat
          // keeps it open: the next message continues the same session.
          if (m["type"] === "result" && !chat) proc.stdin.end();
        }
      }
      const code = await proc.exited;
      if (live.stopping) {
        this.finish(live, "stopped");
      } else if (live.ending && code === 0) {
        this.finish(live, "done");
      } else if (isRunActive(live.run)) {
        const tail = stderr.trim();
        this.finish(
          live,
          "failed",
          `Claude Code exited (code ${code}) without a result${tail ? `: ${tail}` : ""}`,
        );
      }
    } catch (err) {
      if (live.stopping) {
        this.finish(live, "stopped");
      } else {
        const tail = stderr.trim();
        this.finish(live, "failed", tail ? `${errText(err)}\n${tail}` : errText(err));
      }
    } finally {
      // Only clear the handle if it is still ours: a continuation may have
      // already spawned and stored its own.
      if (live.proc === proc) live.proc = null;
    }
  }

  private async send(live: Live, msg: unknown): Promise<void> {
    const proc = live.proc;
    if (!proc) return;
    try {
      proc.stdin.write(JSON.stringify(msg) + "\n");
      // Awaited: the write must reach the pipe before the caller starts
      // draining stdout, or a resumed turn can begin before its own prompt
      // arrives and end empty.
      await proc.stdin.flush();
    } catch {
      // the process is gone; the read loop will report that
    }
  }

  /** A control request from the CLI. Only can_use_tool is understood; the
   *  rest get an error reply so the CLI never waits on us. */
  private async control(live: Live, m: Record<string, unknown>): Promise<void> {
    const requestId = str(m, "request_id");
    const request = isRecord(m["request"]) ? m["request"] : {};
    if (str(request, "subtype") !== "can_use_tool") {
      await this.send(live, {
        type: "control_response",
        response: { subtype: "error", request_id: requestId, error: "not supported by canopy" },
      });
      return;
    }
    const tool = str(request, "tool_name");
    const input = isRecord(request["input"]) ? request["input"] : {};
    const response = await this.permission(live, requestId, tool, input);
    await this.send(live, {
      type: "control_response",
      response: { subtype: "success", request_id: requestId, response },
    });
  }

  private async permission(
    live: Live,
    requestId: string,
    tool: string,
    input: Record<string, unknown>,
  ): Promise<PermissionResult> {
    if (tool === "AskUserQuestion") {
      const questions = parseQuestions(input);
      if (questions.length === 0) {
        return { behavior: "deny", message: "The question could not be shown." };
      }
      const a = await this.ask(live, requestId, {
        id: `p${++live.prompts}`,
        kind: "question",
        questions,
      });
      if (a.kind === "answers") {
        this.step(live, {
          kind: "note",
          text: `answered: ${Object.values(a.answers).join("; ")}`,
        });
        this.emit(live);
        return { behavior: "allow", updatedInput: { ...input, answers: a.answers } };
      }
      this.step(live, { kind: "note", text: "question dismissed" });
      this.emit(live);
      return {
        behavior: "deny",
        message: "The user closed the question without answering. Stop and summarize.",
      };
    }

    const title = describeTool(tool, input, live.root);
    if (live.allowAll) {
      return { behavior: "allow", updatedInput: input };
    }
    const a = await this.ask(live, requestId, {
      id: `p${++live.prompts}`,
      kind: "permission",
      tool,
      title,
      detail: toolDetail(tool, input, live.root),
    });
    if (a.kind === "allow-all") {
      live.allowAll = true;
      // the ones already queued behind it are "later" too
      for (const p of live.pending.slice()) if (p.prompt.kind === "permission") p.settle({ kind: "allow" });
    }
    if (a.kind === "allow" || a.kind === "allow-all") {
      this.step(live, {
        kind: "note",
        text: a.kind === "allow-all" ? `allowed everything from here: ${title}` : `allowed: ${title}`,
      });
      this.emit(live);
      return { behavior: "allow", updatedInput: input };
    }
    this.step(live, { kind: "note", text: `denied: ${title}` });
    this.emit(live);
    return {
      behavior: "deny",
      message:
        "The user declined this in canopy. Do not retry it; continue without it, or stop and explain what is left.",
    };
  }

  /** Parks the run on a prompt until the browser answers, the CLI cancels
   *  it or the run stops. Prompts queue: the run shows the oldest, and the
   *  next one shows once it is settled. */
  private ask(live: Live, requestId: string, prompt: RunPrompt): Promise<RunAnswer> {
    return new Promise((resolve) => {
      const entry: Pending = {
        requestId,
        prompt,
        settle: (a) => {
          const i = live.pending.indexOf(entry);
          if (i === -1) return;
          live.pending.splice(i, 1);
          const next = live.pending[0];
          live.run.status = next ? "waiting" : "working";
          live.run.prompt = next?.prompt ?? null;
          resolve(a);
        },
      };
      live.pending.push(entry);
      if (live.pending.length === 1) {
        live.run.status = "waiting";
        live.run.prompt = prompt;
        this.emit(live);
      }
    });
  }

  private apply(live: Live, m: Record<string, unknown>): void {
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
            this.step(live, { kind: "text", text });
            changed = true;
          }
        } else if (kind === "tool_use") {
          const input = isRecord(block["input"]) ? block["input"] : {};
          const name = str(block, "name");
          const step = this.step(live, {
            kind: "tool",
            tool: { name, title: describeTool(name, input, live.root), status: "running" },
          });
          live.tools.set(str(block, "id"), step.id);
          changed = true;
        } else if (kind === "tool_result") {
          const stepId = live.tools.get(str(block, "tool_use_id"));
          const step = live.run.steps.find((s) => s.id === stepId);
          if (!step?.tool) continue;
          step.tool.status = block["is_error"] === true ? "error" : "ok";
          const text = resultText(block["content"]).trim();
          if (text) step.tool.output = clip(text, OUTPUT_CAP);
          changed = true;
        }
      }
      if (changed) this.emit(live);
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
      live.run.result = {
        text: text.trim(),
        costUsd: num(m, "total_cost_usd"),
        durationMs: num(m, "duration_ms"),
        turns,
      };
      const ok = subtype === "success" && !isError;
      const problem =
        subtype === "error_max_turns"
          ? `stopped after ${turns} turns without finishing`
          : subtype === "error_max_budget_usd"
            ? "stopped at the spending limit"
            : text.trim() || "Claude Code reported an error";
      if (live.run.chat) {
        // A chat's result ends one reply, not the conversation: the process
        // stays, and the next message continues it. A reply that failed is
        // said in the timeline and the chat goes on.
        if (!ok) this.step(live, { kind: "note", text: problem });
        if (isRunActive(live.run)) {
          live.run.status = "idle";
          live.run.prompt = null;
        }
        this.emit(live);
        return;
      }
      if (!ok) live.run.error = problem;
      this.finish(live, ok ? "done" : "failed");
    }
  }
}

/** stdout as parsed JSON objects, one per line; anything else is skipped. */
async function* lines(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<Record<string, unknown>> {
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
