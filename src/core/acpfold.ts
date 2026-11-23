/** ACP v1's session wire folded into a run.
 *
 * ACP deliberately keeps the transport small: a prompt response only says
 * why a turn stopped, while text, tool calls, plans and usage arrive as
 * `session/update` notifications.  This reducer is the browser-safe half of
 * the Antigravity driver.  The live driver and a kept-wire replay can both
 * feed it the same notifications, so a replay gets the same text and tool
 * timeline as the live run.
 */

import { describeTool } from "./actions";
import type { DriveResult, DriveTokens, FoldOut, PromptInput } from "./driver";
import { relPath } from "./touch";
import type { RunStep, RunTodo, RunTool } from "./types";

export const OUTPUT_CAP = 2_000;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const rec = (v: unknown): Record<string, unknown> => (isRecord(v) ? v : {});

const str = (o: Record<string, unknown>, k: string): string => (typeof o[k] === "string" ? o[k] : "");

const num = (o: Record<string, unknown>, k: string): number | null => (typeof o[k] === "number" && Number.isFinite(o[k]) ? o[k] : null);

const clip = (s: string, max: number): string => (s.length > max ? `${s.slice(0, max)}\n… (${s.length - max} more characters)` : s);

function contentText(value: unknown): string {
  if (!Array.isArray(value)) return "";
  return value
    .flatMap((block) => {
      if (!isRecord(block) || str(block, "type") !== "text") return [];
      const text = str(block, "text");
      return text ? [text] : [];
    })
    .join("\n");
}

function toolStatus(status: string, initial: boolean): RunTool["status"] {
  if (status === "completed") return "ok";
  if (status === "failed") return "error";
  if (status === "pending" || status === "in_progress") return "running";
  return initial ? "running" : "error";
}

/** ACP's tool kind as the name the timeline already draws for Claude and
 *  Codex (agy's run_command is an execute); a kind ACP leaves open keeps the
 *  agent's own name. */
function toolName(update: Record<string, unknown>): string {
  switch (str(update, "kind")) {
    case "execute":
      return "Bash";
    case "edit":
      return "Edit";
    case "read":
      return "Read";
    case "search":
      return "Search";
    default:
      return str(update, "name") || "Tool";
  }
}

/** A tool's output: ACP's content blocks, else the raw output agy sends
 *  (a denied command's reason arrives only there). */
function toolOutput(update: Record<string, unknown>): string {
  const content = contentText(update["content"]).trim();
  if (content) return content;
  const raw = update["rawOutput"];
  if (typeof raw === "string") return raw.trim();
  if (!isRecord(raw)) return "";
  // a finished run_command's is {"output": "...", "exit_code": 0}
  return typeof raw["output"] === "string" ? raw["output"].trim() : JSON.stringify(raw, null, 2);
}

function toolPaths(update: Record<string, unknown>, cwd: string): string[] {
  const locations = update["locations"];
  if (!Array.isArray(locations)) return [];
  return locations.flatMap((location) => {
    if (!isRecord(location)) return [];
    const path = str(location, "path");
    return path ? [relPath(path, cwd)] : [];
  });
}

function toolFrom(update: Record<string, unknown>, cwd: string, initial: boolean): RunTool {
  const name = toolName(update);
  const title = str(update, "title") || describeTool(name, rec(update["rawInput"]), cwd);
  const content = toolOutput(update);
  return {
    name,
    title,
    status: toolStatus(str(update, "status"), initial),
    ...(content ? { output: clip(content, OUTPUT_CAP) } : {}),
    ...(toolPaths(update, cwd).length ? { paths: toolPaths(update, cwd) } : {}),
  };
}

/** A run's ACP state between notifications. */
export interface AcpFold {
  cwd: string;
  session: string | null;
  turns: number;
  turnAt: number;
  /** the text from the current turn, grouped by ACP message id */
  messages: Map<string, RunStep>;
  /** Most recent text message key, including a synthetic key when ACP omits
   * messageId. Cleared at tool boundaries and the start of each turn. */
  textKey: string | null;
  finalText: string;
  lastText: string;
  steps: Map<string, RunStep>;
  /** the last tool call update, used by permission replay and live prompts */
  tools: Map<string, Record<string, unknown>>;
  todos: RunTodo[];
  model: string;
  provider: string;
  /** ACP's usage_update cost is cumulative for the session. Keep the
   * cumulative value separate so each turn reports only its own delta. */
  cumulativeCostUsd: number | undefined;
  turnCostBaseUsd: number | undefined;
  costUsd: number | undefined;
  usage: DriveTokens | undefined;
  /** the tokens of the turns this fold has finished. agy's usage counts one
   *  prompt, and a run's tokens are its whole spend, as Codex's thread total
   *  and Claude Code's session count are, so a chat's turns add up here. */
  spent: DriveTokens | undefined;
}

export function acpFold(cwd: string): AcpFold {
  return {
    cwd,
    session: null,
    turns: 0,
    turnAt: 0,
    messages: new Map(),
    textKey: null,
    finalText: "",
    lastText: "",
    steps: new Map(),
    tools: new Map(),
    todos: [],
    model: "",
    provider: "",
    cumulativeCostUsd: undefined,
    turnCostBaseUsd: undefined,
    costUsd: undefined,
    usage: undefined,
    spent: undefined,
  };
}

/** Stores the response to `session/new` or `session/load`. */
export function acpSession(state: AcpFold, response: Record<string, unknown>, fallback = ""): string {
  const id = str(response, "sessionId") || fallback;
  if (!id) return "";
  state.session = id;
  const model = str(response, "model");
  if (model) state.model = model;
  const currentModel = str(response, "currentModelId");
  if (currentModel) state.model = currentModel;
  return id;
}

/** Starts the counter for one `session/prompt`. */
export function acpTurn(state: AcpFold, now: number): void {
  state.turns += 1;
  state.turnAt = now;
  state.messages.clear();
  state.textKey = null;
  state.finalText = "";
  state.lastText = "";
  state.steps.clear();
  state.tools.clear();
  state.turnCostBaseUsd = state.cumulativeCostUsd;
  state.costUsd = undefined;
}

/** Whether an ACP notification belongs to this run's session. */
export function ownSession(state: Pick<AcpFold, "session">, params: Record<string, unknown>): boolean {
  const session = params["sessionId"];
  return state.session === null || typeof session !== "string" || session === state.session;
}

function foldText(state: AcpFold, update: Record<string, unknown>, out: FoldOut): void {
  const text = str(rec(update["content"]), "text");
  if (!text) return;
  // ACP does not require messageId. Agents commonly omit it on every streamed
  // chunk, so consecutive unaddressed chunks are one text step, not one step
  // per chunk (which could exhaust the run's step cap on a long answer).
  const explicit = str(update, "messageId");
  const id = explicit || state.textKey || `message-${state.messages.size + 1}`;
  state.textKey = id;
  const existing = state.messages.get(id);
  if (existing?.kind === "text") {
    existing.text = `${existing.text ?? ""}${text}`;
  } else {
    state.messages.set(id, out.step({ kind: "text", text }));
  }
  state.lastText = [...state.messages.values()]
    .map((step) => step.text ?? "")
    .join("")
    .trim();
  state.finalText = state.lastText;
  out.changed();
}

function planTodos(update: Record<string, unknown>): RunTodo[] {
  const raw = Array.isArray(update["entries"]) ? update["entries"] : [];
  return raw.flatMap((entry, i) => {
    if (!isRecord(entry)) return [];
    const subject = str(entry, "content").trim();
    if (!subject) return [];
    const status = str(entry, "status");
    const normalized: RunTodo["status"] = status === "completed" ? "completed" : status === "in_progress" ? "in_progress" : "pending";
    return [{ id: str(entry, "id") || String(i + 1), subject, status: normalized, ...(normalized === "in_progress" ? { active: subject } : {}) }];
  });
}

function foldTool(state: AcpFold, update: Record<string, unknown>, out: FoldOut, initial: boolean): void {
  state.textKey = null;
  const id = str(update, "toolCallId");
  if (!id) return;
  const previous = state.tools.get(id);
  const merged = previous ? { ...previous, ...update } : update;
  state.tools.set(id, merged);
  const step = state.steps.get(id);
  const tool = toolFrom(merged, state.cwd, initial && !previous);
  if (step?.tool) step.tool = tool;
  else state.steps.set(id, out.step({ kind: "tool", tool }));
  out.changed();
}

/** A prompt response's `usage` (ACP's unstable PromptResponse.usage) as a
 *  run's tokens. agy counts cache reads and writes apart from inputTokens
 *  and thoughts inside outputTokens, as measured on 1.5.15: input 11416,
 *  cache reads 7197, output 49 total 18662; input 9246, output 187,
 *  thoughts 150 total 9433. */
export function tokensOf(value: unknown): DriveTokens | undefined {
  if (!isRecord(value)) return undefined;
  const n = (k: string): number => num(value, k) ?? 0;
  const cachedInput = n("cachedReadTokens");
  const input = n("inputTokens") + cachedInput + n("cachedWriteTokens");
  const output = n("outputTokens");
  return {
    input,
    cachedInput,
    output,
    reasoning: n("thoughtTokens"),
    total: num(value, "totalTokens") ?? input + output,
  };
}

function addTokens(a: DriveTokens | undefined, b: DriveTokens): DriveTokens {
  if (!a) return b;
  return { input: a.input + b.input, cachedInput: a.cachedInput + b.cachedInput, output: a.output + b.output, reasoning: a.reasoning + b.reasoning, total: a.total + b.total };
}

/** Result from a prompt response, folded into the same result shape as the
 *  other drivers. `problem` is the driver's stop/interrupt override. */
export function acpResult(
  state: AcpFold,
  response: Record<string, unknown>,
  problem: string | null = null,
  now = Date.now(),
): { result: DriveResult; problem: string | null } {
  const stop = str(response, "stopReason");
  const turn = tokensOf(response["usage"]) ?? state.usage;
  const usage = turn ? addTokens(state.spent, turn) : state.spent;
  state.spent = usage;
  const error = rec(response["error"]);
  const detail = [str(error, "message"), str(error, "data")].filter(Boolean).join("\n");
  const reported = stop === "end_turn" ? null : stop === "cancelled" ? "the turn was cancelled" : stop === "error" ? detail || "Antigravity reported an error" : stop ? `Antigravity stopped with ${stop}` : "Antigravity returned no stop reason";
  return {
    result: {
      text: state.finalText || state.lastText,
      durationMs: Math.max(0, now - state.turnAt),
      turns: state.turns,
      ...(state.costUsd !== undefined ? { costUsd: state.costUsd } : {}),
      ...(usage ? { tokens: usage } : {}),
      ...(state.model ? { model: state.model } : {}),
      ...(state.provider ? { provider: state.provider } : {}),
    },
    problem: problem ?? reported,
  };
}

/** The meaningful ACP `session/update` variants. Unknown variants are left
 *  alone so a newer ACP version cannot corrupt a known timeline. */
export function foldAcp(state: AcpFold, method: string, params: Record<string, unknown>, out: FoldOut, _now: number): void {
  if (method !== "session/update") return;
  const update = rec(params["update"]);
  switch (str(update, "sessionUpdate")) {
    case "agent_message_chunk":
      foldText(state, update, out);
      return;
    case "tool_call":
      foldTool(state, update, out, true);
      return;
    case "tool_call_update":
      foldTool(state, update, out, false);
      return;
    case "plan":
    case "plan_update": {
      const next = planTodos(update);
      state.todos = next;
      out.todos(next);
      return;
    }
    case "usage_update": {
      const cost = rec(update["cost"]);
      const amount = num(cost, "amount");
      if (str(cost, "currency").toUpperCase() === "USD" && amount !== null) {
        const base = state.turnCostBaseUsd;
        // The first observed amount may include a resumed session's prior
        // turns, so do not report it as this turn's cost. Once a baseline is
        // known, only a monotonic cumulative amount yields a real delta.
        if (base !== undefined && amount >= base) state.costUsd = amount - base;
        if (state.cumulativeCostUsd === undefined || amount >= state.cumulativeCostUsd) state.cumulativeCostUsd = amount;
      }
      return;
    }
    case "config_option_update": {
      const options = Array.isArray(update["configOptions"]) ? update["configOptions"].filter(isRecord) : [];
      const model = options.find((option) => str(option, "category").toLowerCase() === "model");
      const current = model && typeof model["currentValue"] === "string" ? model["currentValue"] : "";
      if (current) state.model = current;
      return;
    }
    default:
      return;
  }
}

/** The command an execute call runs: agy names it CommandLine, other ACP
 *  agents command or cmd. */
export function acpCommand(input: unknown): string | undefined {
  const raw = rec(input);
  return ["command", "cmd", "CommandLine"].map((k) => raw[k]).find((v): v is string => typeof v === "string");
}

/** A tool call's input as a prompt shows it: the command alone for a
 *  command, as Claude Code's and Codex's prompts show it, rather than agy's
 *  JSON with its timeouts and summary; any other input as JSON. */
export function acpInputText(input: unknown, command?: string): string {
  if (command) return command;
  return typeof input === "string" ? input : isRecord(input) ? JSON.stringify(input, null, 2) : "";
}

/** Build a canopy permission prompt from ACP's `session/request_permission`
 *  payload. The driver uses the same helper for its live bridge and replay. */
export function acpPermissionPrompt(params: Record<string, unknown>, cwd: string): PromptInput {
  const call = rec(params["toolCall"]);
  const kind = str(call, "kind");
  const name = toolName(call);
  const tool = kind === "execute" || name === "Bash" ? "Bash" : kind === "edit" || name === "Edit" ? "Edit" : name;
  const title = str(call, "title") || describeTool(tool, rec(call["rawInput"]), cwd);
  const input = call["rawInput"];
  const command = acpCommand(input);
  const detail = [
    acpInputText(input, tool === "Bash" ? command : undefined),
    contentText(call["content"]),
    toolPaths(call, cwd).join(", "),
  ]
    .filter(Boolean)
    .join("\n\n")
    .slice(0, 4_000);
  const paths = toolPaths(call, cwd);
  return {
    kind: "permission",
    tool,
    title,
    detail: detail || title,
    ...(command ? { command } : {}),
    ...(paths.length ? { paths } : {}),
  };
}

