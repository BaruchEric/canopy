/** Claude Code's stream-json folded into a run: the pure half of
 *  `claudedrive.ts` (FR-043 plan 2).
 *
 *  `foldClaude` turns one message from the CLI's stdout into what the run
 *  shows: Claude's words and tool calls as steps, a tool's result on its
 *  call, the main thread's checklist, the model the init names and a turn's
 *  result. The live driver calls it on every message it folds, and the
 *  replay of a kept wire (`wirereplay.ts`) calls it on the wire's lines, so
 *  a rebuilt step is the one the run made. What stays in the driver is the
 *  driving: the process, prompts, canopy's own control requests and a
 *  result held while a subagent runs.
 *
 *  Pure and browser-safe: no node or bun import, the home folder and the
 *  clock are passed in. */

import { describeTool } from "./actions";
import { readRateLimit } from "./capacity";
import type { FoldOut } from "./driver";
import { writtenPaths } from "./explain";
import { relPath, toolTouch } from "./touch";
import { TODO_TOOLS, todoCreated, todoUpdated, todoWritten } from "./todos";
import type { RunStep, RunTodo, RunTokens, RunTool } from "./types";

/** characters of tool output kept per step */
export const OUTPUT_CAP = 2_000;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const str = (o: Record<string, unknown>, k: string): string => (typeof o[k] === "string" ? o[k] : "");

const num = (o: Record<string, unknown>, k: string): number => (typeof o[k] === "number" ? o[k] : 0);

function nonnegative(o: Record<string, unknown>, k: string): number {
  const n = o[k];
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? n : 0;
}

/** The result's modelUsage is cumulative across the query pipeline (including
 *  subagents); the top-level `usage` only covers the main loop and is not a
 *  safe substitute for session accounting. */
export function claudeAccounting(m: Record<string, unknown>): { tokens?: RunTokens; model?: string; provider?: string } {
  const byModel = isRecord(m["modelUsage"]) ? m["modelUsage"] : null;
  if (!byModel) return {};
  let input = 0;
  let cachedInput = 0;
  let output = 0;
  let hasTokens = false;
  const models = new Set<string>();
  const providers = new Set<string>();
  for (const [name, raw] of Object.entries(byModel)) {
    if (!isRecord(raw)) continue;
    const model = typeof raw["canonicalModel"] === "string" ? raw["canonicalModel"] : name;
    if (model) models.add(model);
    if (typeof raw["provider"] === "string" && raw["provider"]) {
      providers.add(raw["provider"] === "firstParty" ? "anthropic" : raw["provider"]);
    }
    const fresh = nonnegative(raw, "inputTokens");
    const cached = nonnegative(raw, "cacheReadInputTokens");
    const created = nonnegative(raw, "cacheCreationInputTokens");
    const generated = nonnegative(raw, "outputTokens");
    hasTokens ||= fresh + cached + created + generated > 0;
    input += fresh + cached + created;
    cachedInput += cached;
    output += generated;
  }
  return {
    ...(hasTokens ? { tokens: { input, cachedInput, output, reasoning: 0, total: input + output } } : {}),
    ...(models.size === 1 ? { model: [...models][0] } : models.size > 1 ? { model: "multiple" } : {}),
    ...(providers.size === 1 ? { provider: [...providers][0] } : providers.size > 1 ? { provider: "multiple" } : {}),
  };
}

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

/** `.` and `..` folded out of an absolute path, without a platform path module. */
function normal(path: string): string {
  const parts: string[] = [];
  for (const part of path.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return `/${parts.join("/")}`;
}

/** A tool's path as the file it names: `~` is the home folder, a relative
 *  path is under the run's folder, `..` folded. In a kept wire an absolute
 *  path under a redacted value (a worktree under the config dir) starts
 *  `<redacted:`, and is absolute still. */
export function absolutePath(file: string, cwd: string, home: string): string {
  if (file === "~" || file.startsWith("~/")) return normal(`${home}/${file.slice(2)}`);
  return normal(file.startsWith("/") || file.startsWith("<redacted:") ? file : `${cwd}/${file}`);
}

/** What a tool call touches, for the step (FR-040): a file tool's path from the
 *  run's folder, a Bash line's `writtenPaths`, nothing for a read. */
export function toolPaths(tool: string, input: Record<string, unknown>, cwd: string, home: string): Pick<RunTool, "paths" | "touchesUnknown"> {
  if (tool === "Bash") return toolTouch(writtenPaths(str(input, "command"), cwd));
  if (!["Edit", "Write", "MultiEdit", "NotebookEdit"].includes(tool)) return {};
  const file = tool === "NotebookEdit" ? str(input, "notebook_path") : str(input, "file_path");
  return file ? { paths: [relPath(absolutePath(file, cwd, home), cwd)] } : {};
}

/** What the fold keeps between messages. */
export interface ClaudeFold {
  /** the run's folder: where tool paths start, and the prefix step titles drop */
  cwd: string;
  /** the home folder a `~` path names */
  home: string;
  /** tool_use id → its step, to attach results to their call */
  tools: Map<string, RunStep>;
  /** main-thread todo tool calls by id, read once their result arrives */
  todoInputs: Map<string, { name: string; input: Record<string, unknown> }>;
  todos: RunTodo[];
  /** the model the CLI's init named, for the cost ledger */
  model: string;
  /** the turns of results held and then outrun by a later one, which the
   *  CLI counts per result: the run's own result adds them back. Null when
   *  nothing was held, so a plain result keeps the CLI's own numbers. Only
   *  the live driver holds a result. */
  heldTurns: number | null;
  /** when the message that began this turn went down stdin, for the time
   *  of a result after a hold (the CLI times its last turn alone) */
  turnStart: number;
}

export function claudeFold(cwd: string, home: string, turnStart = 0): ClaudeFold {
  return { cwd, home, tools: new Map(), todoInputs: new Map(), todos: [], model: "", heldTurns: null, turnStart };
}

/** The words the CLI puts in a user message of its own when an interrupt
 *  stops a turn ("[Request interrupted by user]", "... for tool use"). */
export const INTERRUPT_MARK = "[Request interrupted by user";

/** The CLI's echo of a message canopy sent (`--replay-user-messages`): it
 *  says when the CLI took the message, and is no step of the run's. */
export const isReplay = (m: Record<string, unknown>): boolean => m["type"] === "user" && m["isReplay"] === true;

export interface ClaudeFoldOpts {
  /** for a result only: the problem that overrides what the result itself says */
  failure?: string | null;
  /** for a result only: the turn ended on canopy's own interrupt, which a
   *  person asked for, so the result's error is no failure of the run's */
  interrupted?: boolean;
  /** the time now, for a result that outran a held one; without it such a
   *  result is timed as taking no time */
  now?: number;
}

/** Folds one message into the run through `out`. Messages that are not the
 *  run's story (control requests and replies, background task bookkeeping)
 *  are the driver's and change nothing here. */
export function foldClaude(state: ClaudeFold, m: Record<string, unknown>, out: FoldOut, opts: ClaudeFoldOpts = {}): void {
  const type = str(m, "type");
  if (type === "system") {
    if (str(m, "subtype") === "init") state.model = str(m, "model") || state.model;
    return;
  }
  if (type === "assistant" || type === "user") {
    if (isReplay(m)) return;
    const message = isRecord(m["message"]) ? m["message"] : {};
    const content = message["content"];
    if (!Array.isArray(content)) return;
    let changed = false;
    const parentUse = str(m, "parent_tool_use_id");
    const parent = parentUse ? state.tools.get(parentUse)?.id : undefined;
    for (const block of content) {
      if (!isRecord(block)) continue;
      const kind = str(block, "type");
      if (kind === "text") {
        const text = str(block, "text").trim();
        // the CLI's own note that an interrupt stopped the turn; the run's
        // timeline says that in canopy's words
        if (type === "user" && text.startsWith(INTERRUPT_MARK)) continue;
        if (text) {
          out.step({ kind: "text", text, ...(parent ? { parent } : {}) });
          changed = true;
        }
      } else if (kind === "tool_use") {
        const input = isRecord(block["input"]) ? block["input"] : {};
        const name = str(block, "name");
        const step = out.step({
          kind: "tool",
          tool: { name, title: describeTool(name, input, state.cwd), status: "running", ...toolPaths(name, input, state.cwd, state.home) },
          ...(parent ? { parent } : {}),
        });
        state.tools.set(str(block, "id"), step);
        if (!parentUse && TODO_TOOLS.has(name)) {
          if (name === "TodoWrite") {
            const next = todoWritten(input);
            if (next) {
              state.todos = next;
              out.todos(next);
            }
          } else {
            state.todoInputs.set(str(block, "id"), { name, input });
          }
        }
        changed = true;
      } else if (kind === "tool_result") {
        const useId = str(block, "tool_use_id");
        const step = state.tools.get(useId);
        const todoCall = state.todoInputs.get(useId);
        if (todoCall) {
          state.todoInputs.delete(useId);
          if (block["is_error"] !== true) {
            if (todoCall.name === "TaskCreate") state.todos = todoCreated(state.todos, todoCall.input, resultText(block["content"]));
            else if (todoCall.name === "TaskUpdate") state.todos = todoUpdated(state.todos, todoCall.input);
            if (todoCall.name === "TaskCreate" || todoCall.name === "TaskUpdate") out.todos(state.todos);
          }
        }
        if (!step?.tool) continue;
        step.tool.status = block["is_error"] === true ? "error" : "ok";
        const text = resultText(block["content"]).trim();
        if (text) step.tool.output = clip(text, OUTPUT_CAP);
        changed = true;
      }
    }
    if (changed) out.changed();
    return;
  }
  if (type === "rate_limit_event") {
    // the CLI's word on the plan's window: a refusal's exact reset rides on
    // the run's limited mark (FR-036)
    const info = readRateLimit(m);
    if (info) out.rateLimit?.(info);
    return;
  }
  if (type === "result") {
    const subtype = str(m, "subtype");
    const isError = m["is_error"] === true;
    const errors = Array.isArray(m["errors"])
      ? m["errors"].filter((e): e is string => typeof e === "string")
      : [];
    // an interrupt's result carries the CLI's diagnostic as its error, which
    // is not the run's to show
    const text = opts.interrupted ? "" : subtype === "success" ? str(m, "result") : errors.join("\n");
    const own = num(m, "num_turns");
    // a result that outran a held one, or a held one the run ends on,
    // counts every turn since the message and the time since it went
    // down stdin
    const outran = state.heldTurns !== null;
    const turns = own + (state.heldTurns ?? 0);
    const durationMs = outran ? (opts.now ?? state.turnStart) - state.turnStart : num(m, "duration_ms");
    state.heldTurns = null;
    const ok = subtype === "success" && !isError;
    const problem =
      subtype === "error_max_turns"
        ? `stopped after ${own} turns without finishing`
        : subtype === "error_max_budget_usd"
          ? "stopped at the spending limit"
          : text.trim() || "Claude Code reported an error";
    const accounting = claudeAccounting(m);
    // A job ends with it; a chat's result ends one reply, not the
    // conversation, and a reply that failed is said in the timeline.
    out.result(
      { text: text.trim(), costUsd: num(m, "total_cost_usd"), durationMs, turns, ...(state.model ? { model: state.model } : {}), ...accounting },
      opts.failure ?? (ok || opts.interrupted ? null : problem),
    );
  }
}
