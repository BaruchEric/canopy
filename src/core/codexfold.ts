/** Codex's app-server wire folded into a run: the pure half of
 *  `codexrun.ts` (FR-043 plan 2).
 *
 *  `foldCodex` turns one notification for the run's thread into what the
 *  run shows: an agent message or a tool-like item as a step (a later
 *  notice about the same item updates it), the token count, Codex's
 *  warnings as notes, and a completed turn as its result. `codexThread`
 *  takes the answer to `thread/start` and `codexTurn` starts the count for
 *  a message sent as a turn. The live driver calls these as the wire
 *  arrives, and the replay of a kept wire (`wirereplay.ts`) calls them on
 *  its lines, so a rebuilt step is the one the run made. Approvals, the
 *  turn limit, interrupts and the process stay in the driver.
 *
 *  Pure and browser-safe: no node or bun import, the clock passed in. */

import { describeTool, toolDetail } from "./actions";
import type { DriveResult, DriveTokens, FoldOut } from "./driver";
import { writtenPaths } from "./explain";
import { unwrapShell } from "./shellwords";
import { relPath, toolTouch } from "./touch";
import type { RunStep, RunTool } from "./types";

/** characters of tool output kept per step, as for a Claude run */
export const OUTPUT_CAP = 2_000;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const rec = (v: unknown): Record<string, unknown> => (isRecord(v) ? v : {});

const str = (o: Record<string, unknown>, k: string): string => (typeof o[k] === "string" ? o[k] : "");

const num = (o: Record<string, unknown>, k: string): number | null => (typeof o[k] === "number" ? o[k] : null);

function clip(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}\n… (${s.length - max} more characters)` : s;
}

/** Paths inside the repo lose the repo prefix, as in actions.ts. */
function shorten(path: string, root: string): string {
  return root && path.startsWith(root + "/") ? path.slice(root.length + 1) : path;
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

/** `path` from `root`, as node's `resolve(root, path)` reads it for an
 *  absolute root. In a kept wire an absolute path under a redacted value (a
 *  worktree under the config dir) starts `<redacted:`, and is absolute still. */
const under = (root: string, path: string): string =>
  normal(path.startsWith("/") || path.startsWith("<redacted:") ? path : `${root}/${path}`);

/* ---------- items: what the timeline shows ---------- */

export type FileChange = { path: string; kind: string; movePath: string | null; diff: string };

export function fileChanges(item: Record<string, unknown>): FileChange[] {
  const raw = item["changes"];
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((c: unknown) => {
    if (!isRecord(c) || !str(c, "path")) return [];
    const kind = rec(c["kind"]);
    return [{ path: str(c, "path"), kind: str(kind, "type"), movePath: str(kind, "move_path") || null, diff: str(c, "diff") }];
  });
}

/** A file change's files as the shared Edit tool's input: its title and its
 *  diff are the same words a Claude edit gets. */
export const changesInput = (changes: FileChange[]): Record<string, unknown> => ({ changes });

/** Text out of an MCP result's content blocks. */
function contentText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .map((c: unknown) => (isRecord(c) && str(c, "type") === "text" ? str(c, "text") : ""))
    .filter(Boolean)
    .join("\n");
}

export type Phase = "started" | "completed";

/** Codex's item status as a step's. An item with no status of its own (a web
 *  search) is running until it completes. */
function toolStatus(item: Record<string, unknown>, phase: Phase): RunTool["status"] {
  const s = str(item, "status");
  if (s === "inProgress") return "running";
  if (s === "failed" || s === "declined" || s === "interrupted") return "error";
  if (s === "completed") return "ok";
  return phase === "completed" ? "ok" : "running";
}

/** A tool-like item as the timeline's tool step, or null for an item that is
 *  not one (messages, reasoning, ...). Names follow Claude's where one fits,
 *  so the console's icons and words need no second vocabulary: a command is
 *  `Bash`, a file change `Edit`, an MCP call `mcp__<server>__<tool>`. */
export function itemTool(item: Record<string, unknown>, phase: Phase, root: string): RunTool | null {
  const type = str(item, "type");
  const status = toolStatus(item, phase);
  const withOutput = (tool: RunTool, output: string): RunTool => {
    const text = output.trim();
    return text ? { ...tool, output: clip(text, OUTPUT_CAP) } : tool;
  };
  switch (type) {
    case "commandExecution": {
      const script = unwrapShell(str(item, "command"));
      const itemCwd = item["cwd"];
      const cwd = typeof itemCwd === "string" && itemCwd.startsWith("/") && !itemCwd.includes("\0") ? normal(itemCwd) : root;
      const exit = num(item, "exitCode");
      const failed = status === "ok" && exit !== null && exit !== 0;
      const declined = str(item, "status") === "declined";
      return withOutput(
        { name: "Bash", title: describeTool("Bash", { command: script }), status: failed ? "error" : status, ...toolTouch(writtenPaths(script, root, cwd)) },
        declined ? "declined" : str(item, "aggregatedOutput"),
      );
    }
    case "fileChange": {
      const changes = fileChanges(item);
      const input = changesInput(changes);
      const paths = changes.flatMap((change) => [change.path, ...(change.movePath ? [change.movePath] : [])].map((path) => relPath(under(root, path), root)));
      return withOutput(
        { name: "Edit", title: describeTool("Edit", input, root), status, ...(paths.length ? { paths } : {}) },
        str(item, "status") === "declined" ? "declined" : phase === "completed" ? toolDetail("Edit", input, root) : "",
      );
    }
    case "mcpToolCall": {
      const name = `mcp__${str(item, "server")}__${str(item, "tool")}`;
      const error = str(rec(item["error"]), "message");
      return withOutput(
        { name, title: describeTool(name, rec(item["arguments"]), root), status },
        error || contentText(rec(item["result"])["content"]),
      );
    }
    case "webSearch":
      return { name: "WebSearch", title: describeTool("WebSearch", { query: str(item, "query") }), status };
    case "dynamicToolCall": {
      const tool = str(item, "tool") || "tool";
      const bad = item["success"] === false;
      return { name: tool, title: describeTool(tool, rec(item["arguments"])), status: bad ? "error" : status };
    }
    case "collabAgentToolCall": {
      const prompt = str(item, "prompt").split("\n")[0]?.slice(0, 80) ?? "";
      return { name: "Agent", title: describeTool("Agent", { description: prompt || str(item, "tool") }), status };
    }
    case "imageView":
      return { name: "Read", title: `view ${shorten(str(item, "path"), root)}`, status };
    case "plan":
      return withOutput({ name: "Plan", title: describeTool("Plan", {}), status }, str(item, "text"));
    default:
      return null;
  }
}

/* ---------- the result ---------- */

/** Codex reports no cost, but a page from before harnesses reads a run's
 *  `costUsd` as always there (`costUsd.toFixed`) and would fail to render a
 *  Codex result without one. A zero keeps it drawing; the current page
 *  shows the tokens wherever a result has them (`resultLine`). */
export const NO_COST = { costUsd: 0 } as const;

export function tokensOf(breakdown: unknown): DriveTokens | undefined {
  if (!isRecord(breakdown)) return undefined;
  const n = (k: string) => num(breakdown, k) ?? 0;
  return {
    input: n("inputTokens"),
    cachedInput: n("cachedInputTokens"),
    output: n("outputTokens"),
    reasoning: n("reasoningOutputTokens"),
    total: n("totalTokens"),
  };
}

/** The text a turn ended with: its final answer, else its last message,
 *  else whatever the completed turn's own item summary holds. */
function closingText(final: string, last: string, turn: Record<string, unknown>): string {
  if (final || last) return final || last;
  const items = Array.isArray(turn["items"]) ? turn["items"] : [];
  for (let i = items.length - 1; i >= 0; i--) {
    const it = rec(items[i]);
    if (str(it, "type") === "agentMessage" && str(it, "text").trim()) return str(it, "text").trim();
  }
  return "";
}

/** `turn/completed` as the run's result and, when it did not complete, the
 *  problem the run reports. `turns` counts Codex turns on the thread, one per
 *  message: Codex does not report the model calls inside one. */
export function turnResult(
  turn: Record<string, unknown>,
  texts: { final: string; last: string },
  turns: number,
  tokens: DriveTokens | undefined,
  elapsedMs: number,
): { result: DriveResult; problem: string | null } {
  const status = str(turn, "status");
  const error = rec(turn["error"]);
  const detail = [str(error, "message"), str(error, "additionalDetails")].filter(Boolean).join("\n");
  const problem =
    status === "completed"
      ? null
      : status === "interrupted"
        ? "the turn was interrupted"
        : status === "failed"
          ? detail || "Codex reported an error"
          : `the turn ended as ${status || "unknown"}`;
  return {
    result: {
      text: closingText(texts.final, texts.last, turn),
      ...NO_COST,
      durationMs: num(turn, "durationMs") ?? elapsedMs,
      turns,
      ...(tokens ? { tokens } : {}),
    },
    problem,
  };
}

/* ---------- the fold ---------- */

/** What the fold keeps between notifications. */
export interface CodexFold {
  /** the run's folder: the prefix step titles drop, and the cwd a command
   *  without its own runs in */
  cwd: string;
  /** the thread canopy started; a notification for another (a
   *  sub-agent's) is not this run's. Null until thread/start answers. */
  thread: string | null;
  /** turns started on the thread, one per message */
  turns: number;
  /** when the running turn's message was sent */
  turnAt: number;
  /** the running turn's final answer and its last message */
  finalText: string;
  lastText: string;
  tokens: DriveTokens | undefined;
  /** the model and provider thread/start answered with, for the cost ledger */
  model: string;
  provider: string;
  /** item id → its tool step */
  steps: Map<string, RunStep>;
  /** item id → the last item seen under it, for approvals about it */
  items: Map<string, Record<string, unknown>>;
}

export function codexFold(cwd: string): CodexFold {
  return { cwd, thread: null, turns: 0, turnAt: 0, finalText: "", lastText: "", tokens: undefined, model: "", provider: "", steps: new Map(), items: new Map() };
}

/** The answer to `thread/start`: the thread is the run's, with the model and
 *  provider it named. Returns the thread's id, "" when it has none. */
export function codexThread(state: CodexFold, started: Record<string, unknown>): string {
  const id = str(rec(started["thread"]), "id");
  if (!id) return "";
  state.thread = id;
  state.model = str(started, "model");
  state.provider = str(started, "modelProvider");
  return id;
}

/** A message went to Codex as a new turn at `now`. */
export function codexTurn(state: CodexFold, now: number): void {
  state.turns += 1;
  state.turnAt = now;
  state.finalText = "";
  state.lastText = "";
}

/** Whether a notification is for the run's own thread (a sub-agent's is not). */
export function ownThread(state: Pick<CodexFold, "thread">, params: Record<string, unknown>): boolean {
  const t = params["threadId"];
  return state.thread === null || typeof t !== "string" || t === state.thread;
}

/** What a notification meant beyond the steps, for the driver to act on:
 *  a command or file change finished (the turn limit counts it), or the
 *  turn completed with its result. */
export type CodexFolded =
  | { kind: "counted" }
  | { kind: "completed"; turn: string | null; result: DriveResult; problem: string | null }
  | null;

/** Folds one notification for the run's thread into the run through `out`.
 *  `now` times a turn that reports no duration of its own. */
export function foldCodex(state: CodexFold, method: string, params: Record<string, unknown>, out: FoldOut, now: number): CodexFolded {
  switch (method) {
    case "item/started":
    case "item/completed":
      return foldItem(state, rec(params["item"]), method === "item/started" ? "started" : "completed", out);
    case "thread/tokenUsage/updated":
      state.tokens = tokensOf(rec(params["tokenUsage"])["total"]) ?? state.tokens;
      return null;
    case "turn/completed": {
      const turn = rec(params["turn"]);
      state.steps.clear();
      state.items.clear();
      const { result, problem } = turnResult(turn, { final: state.finalText, last: state.lastText }, state.turns, state.tokens, now - state.turnAt);
      if (state.model) result.model = state.model;
      if (state.provider) result.provider = state.provider;
      return { kind: "completed", turn: str(turn, "id") || null, result, problem };
    }
    case "error":
      if (params["willRetry"] === true) {
        out.note(`codex hit an error and is retrying: ${str(rec(params["error"]), "message") || "unknown error"}`);
      }
      return null;
    case "warning":
      if (str(params, "message")) out.note(`codex: ${str(params, "message")}`);
      return null;
    case "configWarning":
      if (str(params, "summary")) out.note(`codex config: ${str(params, "summary")}`);
      return null;
    case "model/rerouted":
      out.note(`codex moved this turn from ${str(params, "fromModel")} to ${str(params, "toModel")}`);
      return null;
    default:
      return null;
  }
}

function foldItem(state: CodexFold, item: Record<string, unknown>, phase: Phase, out: FoldOut): CodexFolded {
  const id = str(item, "id");
  if (!id) return null;
  state.items.set(id, item);
  const type = str(item, "type");
  if (type === "agentMessage") {
    const text = str(item, "text").trim();
    if (phase !== "completed" || !text) return null;
    state.lastText = text;
    if (str(item, "phase") === "final_answer") state.finalText = text;
    out.step({ kind: "text", text });
    out.changed();
    return null;
  }
  if (type === "contextCompaction") {
    if (phase === "completed") out.note("codex compacted the conversation to fit");
    return null;
  }
  const tool = itemTool(item, phase, state.cwd);
  if (!tool) return null;
  const step = state.steps.get(id);
  if (step?.tool) {
    step.tool = tool;
  } else {
    state.steps.set(id, out.step({ kind: "tool", tool }));
  }
  out.changed();
  if (phase === "completed") {
    state.items.delete(id);
    if (type === "commandExecution" || type === "fileChange") return { kind: "counted" };
  }
  return null;
}
