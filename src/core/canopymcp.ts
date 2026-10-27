/** canopy's own MCP server, the pure half (the tool table, the folders, the
 *  JSON-RPC dispatch), browser-safe; started as `canopy mcp` by `cli/mcp.ts`. */

import { allows, type CallerKind, type Right } from "./callers";
import { LineSplitter, parseMessage, type RpcId, type RpcMessage } from "./codexrpc";
import { inQueue, landWord, queueOf, reviewWord, sentBack, stoppedWhole } from "./landing";
import type { HealthCheck, LandEntry, LandingInfo, PrWatch, RangerWake, Repo, Run, ScanResult } from "./types";

export const SERVER_NAME = "canopy";
export const PROTOCOL_VERSION = "2025-06-18";
export const PROTOCOL_VERSIONS: readonly string[] = ["2025-06-18", "2025-03-26", "2024-11-05"];

export type ToolName = "canopy_status" | "canopy_runs" | "canopy_queue" | "canopy_health" | "canopy_say" | "canopy_wake" | "canopy_land" | "canopy_pr";
export interface ToolInput { type: "string" | "boolean"; description: string }
export interface ToolSchema { type: "object"; properties: Record<string, ToolInput>; required?: string[]; additionalProperties: false }
export interface ToolSpec { name: ToolName; right: Right; description: string; inputSchema: ToolSchema }

const stringInput = (description: string): ToolInput => ({ type: "string", description });
const booleanInput = (description: string): ToolInput => ({ type: "boolean", description });
const schema = (properties: Record<string, ToolInput>, required?: string[]): ToolSchema => ({
  type: "object",
  properties,
  ...(required ? { required } : {}),
  additionalProperties: false,
});

/** In spec order: the read tools, the plan tools, the operate tools. */
export const TOOLS: readonly ToolSpec[] = [
  {
    name: "canopy_status",
    right: "read",
    description: "Every repo canopy shows on this backend: id, branch, ahead and behind, changed files, and the run working in it. A repo's id is what the other tools take.",
    inputSchema: schema({}),
  },
  {
    name: "canopy_runs",
    right: "read",
    description: "The agent runs on this backend, oldest first. Give id for one run with its last steps; json true for the records as the API has them.",
    inputSchema: schema({ id: stringInput("A run id to show one run and its last steps."), json: booleanInput("Return the API records as JSON.") }),
  },
  {
    name: "canopy_queue",
    right: "read",
    description: "The landing queues: each repo's branch runs queued in order, what was sent back and why, and what is ready to land. repo narrows to one repo id or folder name; json true for the record.",
    inputSchema: schema({ repo: stringInput("A repo id or folder name to show."), json: booleanInput("Return the API record as JSON.") }),
  },
  {
    name: "canopy_health",
    right: "read",
    description: "canopy's health checks, the bad ones first.",
    inputSchema: schema({}),
  },
  {
    name: "canopy_say",
    right: "plan",
    description: "Send text to a running chat or run by its id, as typing into its sheet would.",
    inputSchema: schema({ id: stringInput("The run or chat id."), text: stringInput("Text to send to the run.") }, ["id", "text"]),
  },
  {
    name: "canopy_wake",
    right: "plan",
    description: "Wake the ranger later with a prompt: when (in 30m, 14:00, an ISO time), cron (five fields, local time) or run (a run id: when that run ends). Give exactly one of the three.",
    inputSchema: schema({
      prompt: stringInput("What the ranger should do."),
      when: stringInput("A time such as in 30m, 14:00, or an ISO time."),
      cron: stringInput("A five-field cron schedule in local time."),
      run: stringInput("A run id; wake when that run ends."),
    }, ["prompt"]),
  },
  {
    name: "canopy_land",
    right: "operate",
    description: "A ready branch run into its repo's landing queue: rebase, gates, fast-forward; never a push. Only when the user asked for it to land.",
    inputSchema: schema({ run: stringInput("The ready branch run id to queue for landing.") }, ["run"]),
  },
  {
    name: "canopy_pr",
    right: "operate",
    description: "Push a ready branch run and open a PR on GitHub in place of landing it; never a force push. Only when the user asked for a PR.",
    inputSchema: schema({ run: stringInput("The ready branch run id to push and open as a PR.") }, ["run"]),
  },
];

export const toolsFor = (kind: CallerKind): ToolSpec[] => TOOLS.filter((tool) => allows(kind, tool.right));

const namesFor = (kind: CallerKind): ToolName[] => toolsFor(kind).map((tool) => tool.name);

/** The names per kind, derived from toolsFor. */
export const TOOLS_FOR: Record<CallerKind, readonly ToolName[]> = {
  page: namesFor("page"),
  cli: namesFor("cli"),
  shell: namesFor("shell"),
  ranger: namesFor("ranger"),
  coordinator: namesFor("coordinator"),
  helper: namesFor("helper"),
  none: namesFor("none"),
};

/** One line per repo that is not archived: id, branch, ahead and behind,
 *  changed files, and the run working in it. */
export function foldStatus(repos: readonly Repo[], runs: readonly Run[]): string {
  const lines: string[] = [];
  for (const repo of repos) {
    if (repo.archived) continue;
    if (repo.status === null) {
      lines.push(`${repo.id}  ${repo.error ?? "no status"}`);
      continue;
    }
    const status = repo.status;
    const parts: string[] = [];
    if (status.ahead > 0) parts.push(`${status.ahead} ahead`);
    if (status.behind > 0) parts.push(`${status.behind} behind`);
    if (status.files.length > 0) parts.push(`${status.files.length} changed`);
    const active = runs.find((run) => run.repoId === repo.id && (run.status === "working" || run.status === "waiting" || run.status === "idle"));
    const summary = `${repo.id}  ${status.branch}${parts.length > 0 ? ` ${parts.join(" ")}` : ""}`;
    lines.push(active ? `${summary}  run: ${active.verb} ${active.status}` : summary);
  }
  return lines.length > 0 ? lines.join("\n") : "no repos";
}

const runLine = (run: Run): string => {
  const note = run.note.split("\n", 1)[0];
  return `${run.id}  ${run.repoId}  ${run.status}  ${run.verb}${note ? `  ${note}` : ""}`;
};

/** One line per run in API order; an id adds its error and last ten steps. */
export function foldRuns(runs: readonly Run[], id?: string): string {
  if (id !== undefined) {
    const run = runs.find((entry) => entry.id === id);
    if (!run) return `no run ${id}`;
    const lines = [runLine(run)];
    if (run.error) lines.push(`error: ${run.error}`);
    for (const step of run.steps.slice(-10)) {
      if (step.kind === "tool") {
        if (step.tool) lines.push(`  tool: ${step.tool.title} (${step.tool.status})`);
      } else {
        lines.push(`  ${step.kind}: ${step.text ?? ""}`);
      }
    }
    return lines.join("\n");
  }
  return runs.length > 0 ? runs.map(runLine).join("\n") : "no runs";
}

const repoNamed = (repo: string | undefined, id: string, path: string): boolean =>
  repo === undefined || repo === id || path.split("/").at(-1) === repo;

const backWords = (entry: LandEntry): string =>
  entry.state === "red" ? `${entry.gate ?? "a gate"} failed` : (entry.reason ?? entry.state);

/** A repo's queue in order, with sent-back reasons and ready branch runs. */
export function foldQueue(info: LandingInfo, repo?: string): string {
  const repos = [...new Set([...info.entries.map((entry) => entry.repoId), ...info.runs.map((run) => run.repoId)])].sort();
  const lines: string[] = [];
  for (const id of repos) {
    const path = info.entries.find((entry) => entry.repoId === id)?.repoPath ?? info.runs.find((run) => run.repoId === id)?.repoPath ?? "";
    if (!repoNamed(repo, id, path)) continue;
    const mine = info.entries.filter((entry) => entry.repoId === id);
    const queued = queueOf(info.entries, id);
    const back = mine.filter(sentBack);
    const taken = new Set(mine.filter((entry) => inQueue(entry) || entry.state === "landed" || sentBack(entry)).map((entry) => entry.id));
    const ready = info.runs.filter((run) => run.repoId === id && run.state === "ready" && !taken.has(run.id));
    const stopped = info.runs.filter((run) => run.repoId === id && stoppedWhole(run) && !taken.has(run.id));
    if (queued.length + back.length + ready.length + stopped.length === 0) continue;
    lines.push(id);
    for (const entry of queued) lines.push(`  ${landWord(entry, info.entries).padEnd(16)} ${entry.branch}`);
    for (const entry of back) lines.push(`  ${landWord(entry, info.entries).padEnd(16)} ${entry.branch}  ${backWords(entry).split("\n").pop() ?? ""}`);
    for (const run of ready) lines.push(`  ${"ready".padEnd(16)} ${run.branch}  ${run.review ? reviewWord(run.review) : "sorting"}  canopy_land ${run.runId}`);
    for (const run of stopped) lines.push(`  ${"stopped".padEnd(16)} ${run.branch}  can land: ${run.review ? reviewWord(run.review) : "sorting"}  canopy_land ${run.runId}`);
  }
  return lines.length > 0 ? lines.join("\n") : "no branch runs in any queue";
}

/** A count line followed by down and gave-up checks, then the rest. */
export function foldHealth(checks: readonly HealthCheck[]): string {
  if (checks.length === 0) return "no checks";
  const bad = checks.filter((check) => check.state === "down" || check.state === "gave-up");
  const ordered = [...bad, ...checks.filter((check) => check.state !== "down" && check.state !== "gave-up")];
  const heading = bad.length > 0 ? `${bad.length} of ${checks.length} checks down` : `all ${checks.length} checks ok`;
  const rows = ordered.map((check) => `  ${check.state.padEnd(8)} ${check.label}${check.why ? `  ${check.why}` : ""}  ${check.id}`);
  return [heading, ...rows].join("\n");
}

export const INSTRUCTIONS = "These tools act on canopy's API with the token this session holds; a tool the token's rights do not cover is not listed. Answers are short text; json true on canopy_runs and canopy_queue gives the record. An error is the API's own words.";

export interface CanopyApi {
  /** one backend call; rejects with its `error` text, else `<name> answered <status>` */
  call<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T>;
}

export interface McpContext {
  api: CanopyApi;
  /** the token's kind, from GET /api/auth at start */
  kind: CallerKind;
  /** CANOPY_RUN when set; no tool reads it in plan 1 */
  run: string | null;
  /** what serverInfo says */
  version: string;
}

export interface ToolResult { text: string; isError: boolean }

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const stringArg = (args: unknown, name: string): string | undefined => {
  if (!isRecord(args)) return undefined;
  const value = args[name];
  return typeof value === "string" ? value : undefined;
};

const booleanArg = (args: unknown, name: string): boolean => isRecord(args) && args[name] === true;

const apiError = (error: unknown): string => error instanceof Error ? error.message : String(error);

/** Runs one tool. API errors become the same short text canopy returned. */
export async function callTool(name: ToolName, args: unknown, ctx: McpContext): Promise<ToolResult> {
  const invalid = (field: string): ToolResult => ({ text: `${name} needs ${field}`, isError: true });
  try {
    switch (name) {
      case "canopy_status": {
        const tree = await ctx.api.call<ScanResult>("GET", "/api/tree");
        const runs = await ctx.api.call<Run[]>("GET", "/api/runs");
        return { text: foldStatus(tree.repos, runs), isError: false };
      }
      case "canopy_runs": {
        const runs = await ctx.api.call<Run[]>("GET", "/api/runs");
        const id = stringArg(args, "id");
        return { text: booleanArg(args, "json") ? JSON.stringify(id !== undefined ? runs.find((run) => run.id === id) ?? null : runs) : foldRuns(runs, id), isError: false };
      }
      case "canopy_queue": {
        const info = await ctx.api.call<LandingInfo>("GET", "/api/landing");
        const repo = stringArg(args, "repo");
        return { text: booleanArg(args, "json") ? JSON.stringify(info) : foldQueue(info, repo), isError: false };
      }
      case "canopy_health": {
        const health = await ctx.api.call<{ checks: HealthCheck[] }>("GET", "/api/health");
        return { text: foldHealth(health.checks), isError: false };
      }
      case "canopy_say": {
        const id = stringArg(args, "id");
        if (id === undefined) return invalid("id");
        const text = stringArg(args, "text");
        if (text === undefined) return invalid("text");
        const run = await ctx.api.call<Run>("POST", "/api/runs/say", { id, text });
        return { text: `said to ${run.id}, now ${run.status}`, isError: false };
      }
      case "canopy_wake": {
        const prompt = stringArg(args, "prompt");
        if (prompt === undefined) return invalid("prompt");
        const when = stringArg(args, "when");
        const cron = stringArg(args, "cron");
        const run = stringArg(args, "run");
        const body = {
          prompt,
          ...(when !== undefined ? { when } : {}),
          ...(cron !== undefined ? { cron } : {}),
          ...(run !== undefined ? { run } : {}),
          ...(ctx.kind === "ranger" ? {} : { by: "eric" }),
        };
        const wake = await ctx.api.call<RangerWake>("POST", "/api/ranger/wakes", body);
        const whenSet = wake.cron ? `cron ${wake.cron}` : wake.run ? `the end of run ${wake.run}` : new Date(wake.at ?? 0).toISOString();
        return { text: `wake ${wake.id} set for ${whenSet}`, isError: false };
      }
      case "canopy_land": {
        const run = stringArg(args, "run");
        if (run === undefined) return invalid("run");
        const entry = await ctx.api.call<LandEntry>("POST", "/api/landing/land", { run });
        return { text: `${landWord(entry, [entry])}: ${entry.branch} into ${entry.target}`, isError: false };
      }
      case "canopy_pr": {
        const run = stringArg(args, "run");
        if (run === undefined) return invalid("run");
        const pr = await ctx.api.call<PrWatch>("POST", "/api/prs/open", { run });
        return { text: `PR #${pr.number} opened: ${pr.url}`, isError: false };
      }
    }
  } catch (error) {
    return { text: apiError(error), isError: true };
  }
}

export type RpcReply =
  | { jsonrpc: "2.0"; id: RpcId; result: unknown }
  | { jsonrpc: "2.0"; id: RpcId; error: { code: number; message: string } };

const rpcError = (id: RpcId, code: number, message: string): RpcReply => ({ jsonrpc: "2.0", id, error: { code, message } });
const rpcResult = (id: RpcId, result: unknown): RpcReply => ({ jsonrpc: "2.0", id, result });

/** One message in, at most one reply out. Notifications and responses have none. */
export async function handleMessage(msg: RpcMessage, ctx: McpContext): Promise<RpcReply | null> {
  if (msg.kind !== "request") return null;
  switch (msg.method) {
    case "initialize": {
      const params = isRecord(msg.params) ? msg.params : {};
      const requested = params["protocolVersion"];
      const protocolVersion = typeof requested === "string" && PROTOCOL_VERSIONS.includes(requested) ? requested : PROTOCOL_VERSION;
      return rpcResult(msg.id, {
        protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: ctx.version },
        instructions: INSTRUCTIONS,
      });
    }
    case "ping":
      return rpcResult(msg.id, {});
    case "tools/list":
      return rpcResult(msg.id, {
        tools: toolsFor(ctx.kind).map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
      });
    case "tools/call": {
      const params = isRecord(msg.params) ? msg.params : {};
      const rawName = params["name"];
      if (typeof rawName !== "string") return rpcError(msg.id, -32602, "tools/call needs a name");
      const tool = TOOLS.find((entry) => entry.name === rawName);
      if (!tool) return rpcError(msg.id, -32602, `no tool named ${rawName}`);
      if (!toolsFor(ctx.kind).some((entry) => entry.name === tool.name)) {
        return rpcError(msg.id, -32602, `${tool.name} is not a tool this ${ctx.kind} token holds`);
      }
      const result = await callTool(tool.name, params["arguments"], ctx);
      return rpcResult(msg.id, {
        content: [{ type: "text", text: result.text }],
        ...(result.isError ? { isError: true } : {}),
      });
    }
    default:
      return rpcError(msg.id, -32601, `no method ${msg.method}`);
  }
}

export interface LineOut { write(line: string): unknown }

/** Reads input to its end, one JSON-RPC message per line; other lines are dropped. */
export async function serve(input: ReadableStream<Uint8Array>, out: LineOut, ctx: McpContext): Promise<void> {
  const splitter = new LineSplitter();
  const reader = input.getReader();
  const processLine = async (line: string): Promise<void> => {
    const message = parseMessage(line);
    if (!message) return;
    const reply = await handleMessage(message, ctx);
    if (reply) await out.write(JSON.stringify(reply));
  };
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      for (const line of splitter.push(value)) await processLine(line);
    }
    for (const line of splitter.flush()) await processLine(line);
  } finally {
    reader.releaseLock();
  }
}
