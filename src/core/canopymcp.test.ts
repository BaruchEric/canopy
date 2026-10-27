import { describe, expect, test } from "bun:test";
import { callTool, foldHealth, foldQueue, foldRuns, foldStatus, handleMessage, INSTRUCTIONS, serve, TOOLS, TOOLS_FOR, toolsFor, type CanopyApi, type McpContext, type ToolName } from "./canopymcp";
import { parseMessage } from "./codexrpc";
import { enqueue } from "./landing";
import type { HealthCheck, LandingInfo, LandingRun, Repo, RepoStatus, Run } from "./types";

const ALL = ["canopy_status", "canopy_runs", "canopy_queue", "canopy_health", "canopy_say", "canopy_wake", "canopy_land", "canopy_pr"] as const;

describe("the tool table", () => {
  test("names, rights and the list per kind", () => {
    expect(TOOLS.map((t) => [t.name, t.right])).toEqual([
      ["canopy_status", "read"], ["canopy_runs", "read"], ["canopy_queue", "read"], ["canopy_health", "read"],
      ["canopy_say", "plan"], ["canopy_wake", "plan"], ["canopy_land", "operate"], ["canopy_pr", "operate"],
    ]);
    for (const kind of ["page", "cli", "shell", "ranger"] as const) expect(TOOLS_FOR[kind]).toEqual(ALL);
    expect(TOOLS_FOR.coordinator).toEqual(ALL.slice(0, 6));
    expect(TOOLS_FOR.none).toEqual(ALL.slice(0, 4));
    expect(TOOLS_FOR.helper).toEqual([]);
    expect(toolsFor("shell").map((t) => t.name)).toEqual([...ALL]);
  });

  test("each schema is a closed object with the inputs the call reads", () => {
    for (const tool of TOOLS) expect([tool.inputSchema.type, tool.inputSchema.additionalProperties]).toEqual(["object", false]);
    const of = (name: ToolName) => {
      const tool = TOOLS.find((entry) => entry.name === name);
      if (!tool) throw new Error(`missing tool ${name}`);
      return tool.inputSchema;
    };
    expect(Object.keys(of("canopy_wake").properties)).toEqual(["prompt", "when", "cron", "run"]);
    expect(of("canopy_wake").required).toEqual(["prompt"]);
    expect(of("canopy_say").required).toEqual(["id", "text"]);
    expect(Object.keys(of("canopy_runs").properties)).toEqual(["id", "json"]);
    expect(Object.keys(of("canopy_queue").properties)).toEqual(["repo", "json"]);
    expect(of("canopy_status").properties).toEqual({});
    expect(of("canopy_land").required).toEqual(["run"]);
  });
});

const status = (over: Partial<RepoStatus> = {}): RepoStatus => ({ branch: "main", upstream: null, ahead: 0, behind: 0, files: [], lastCommit: null, user: null, ...over });
const repo = (id: string, over: Partial<Repo> = {}): Repo => ({ id, name: id.split("/").at(-1) ?? id, path: `/d/${id}`, group: "", source: "root", status: status(), ...over });
const run = (id: string, repoId: string, over: Partial<Run> = {}): Run => ({ id, repoId, action: "ask", verb: "Ask", progress: "asking", expectsChange: false, chat: false, harness: "claude", note: "", status: "done", startedAt: 1, steps: [], prompt: null, ...over });
const file = { path: "a.ts", index: ".", worktree: "M", untracked: false, conflicted: false };

test("foldStatus: branch, ahead and behind, changed files, the live run; archived repos left out", () => {
  const repos = [
    repo("dev-tools/canopy", { status: status({ ahead: 2, files: [file, file, file] }) }),
    repo("web-apps/ripe", { status: status({ branch: "feat", behind: 1 }) }),
    repo("old", { archived: "canopy" }),
    repo("broken", { status: null, error: "not a git repo" }),
  ];
  const runs = [run("r1", "dev-tools/canopy", { status: "working" }), run("r2", "web-apps/ripe", { status: "done" })];
  expect(foldStatus(repos, runs)).toBe("dev-tools/canopy  main 2 ahead 3 changed  run: Ask working\nweb-apps/ripe  feat 1 behind\nbroken  not a git repo");
  expect(foldStatus([], [])).toBe("no repos");
});

test("foldRuns: the list, one run with its last steps, an id that is gone", () => {
  const steps = Array.from({ length: 12 }, (_, i) => ({ id: `s${i}`, at: i, kind: "text" as const, text: `t${i}` }));
  const runs = [run("r1", "a", { status: "working", note: "fix the\nthing" }), run("r2", "b", { status: "failed", error: "exit 1", steps: [...steps, { id: "x", at: 99, kind: "tool" as const, tool: { name: "Bash", title: "bun test", status: "error" as const } }] })];
  expect(foldRuns(runs)).toBe("r1  a  working  Ask  fix the\nr2  b  failed  Ask");
  const one = foldRuns(runs, "r2").split("\n");
  expect(one[0]).toBe("r2  b  failed  Ask");
  expect(one[1]).toBe("error: exit 1");
  expect(one.length).toBe(12);
  expect(one[2]).toBe("  text: t3");
  expect(one[11]).toBe("  tool: bun test (error)");
  expect(foldRuns(runs, "nope")).toBe("no run nope");
  expect(foldRuns([])).toBe("no runs");
});

const rec = (id: string, over: Partial<LandingRun> = {}): LandingRun => ({ id, runId: `run-${id}`, repoId: "dev-tools/canopy", repoPath: "/d/dev-tools/canopy", branch: `run/x-${id}`, target: "main", base: "b0", dir: `/w/${id}`, note: "n", verb: "Ask", harness: "claude", state: "ready", startedAt: 1, ...over });

test("foldQueue: queued in order, sent back with why, ready with the tool to call; a repo filter; empty", () => {
  const entries = enqueue(enqueue([], rec("a"), 1), rec("b"), 2);
  const info: LandingInfo = { runs: [rec("a"), rec("b"), rec("c"), rec("d", { repoId: "web-apps/ripe", repoPath: "/d/web-apps/ripe" })], entries, orphans: [] };
  expect(foldQueue(info)).toBe([
    "dev-tools/canopy",
    "  queued 1st       run/x-a",
    "  queued 2nd       run/x-b",
    "  ready            run/x-c  sorting  canopy_land run-c",
    "web-apps/ripe",
    "  ready            run/x-d  sorting  canopy_land run-d",
  ].join("\n"));
  expect(foldQueue(info, "ripe")).toBe("web-apps/ripe\n  ready            run/x-d  sorting  canopy_land run-d");
  expect(foldQueue({ runs: [], entries: [], orphans: [] })).toBe("no branch runs in any queue");
});

const check = (id: string, state: HealthCheck["state"], why: string | null = null): HealthCheck => ({ id, label: id, scope: { kind: "canopy" }, state, why, since: 1, lastOk: null, heal: "auto", fails: 0, nextHeal: null, button: false, history: [] });

test("foldHealth: the bad ones first under a count line", () => {
  expect(foldHealth([check("c:a", "ok"), check("c:b", "down", "502 in 20ms"), check("c:c", "gave-up", "3 heals")])).toBe("2 of 3 checks down\n  down     c:b  502 in 20ms  c:b\n  gave-up  c:c  3 heals  c:c\n  ok       c:a  c:a");
  expect(foldHealth([check("c:a", "ok")])).toBe("all 1 checks ok\n  ok       c:a  c:a");
  expect(foldHealth([])).toBe("no checks");
});

function api(answers: Record<string, unknown | (() => never)>) {
  const calls: [string, string, unknown][] = [];
  const client: CanopyApi = {
    async call<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
      calls.push([method, path, body]);
      const answer = answers[`${method} ${path}`];
      if (typeof answer === "function") return answer();
      if (answer === undefined) throw new Error(`no answer for ${method} ${path}`);
      return answer as T;
    },
  };
  return { api: client, calls };
}

const ctx = (client: CanopyApi, kind: McpContext["kind"] = "shell"): McpContext => ({ api: client, kind, run: null, version: "0.1.0 (abc1234)" });

const req = (id: number, method: string, params?: unknown) => {
  const message = parseMessage(JSON.stringify({ jsonrpc: "2.0", id, method, ...(params !== undefined ? { params } : {}) }));
  if (!message || message.kind !== "request") throw new Error(`could not build request ${method}`);
  return message;
};

describe("handleMessage", () => {
  test("initialize answers the client's version when known, else the server's, with the instructions", async () => {
    const { api: client } = api({});
    const reply = await handleMessage(req(1, "initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "0" } }), ctx(client));
    expect(reply).toEqual({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "canopy", version: "0.1.0 (abc1234)" }, instructions: INSTRUCTIONS } });
    const unsupported = await handleMessage(req(2, "initialize", { protocolVersion: "2099-01-01" }), ctx(client));
    expect(unsupported).toMatchObject({ result: { protocolVersion: "2025-06-18" } });
  });

  test("ping, a notification, an unknown method", async () => {
    const { api: client } = api({});
    expect(await handleMessage(req(3, "ping"), ctx(client))).toEqual({ jsonrpc: "2.0", id: 3, result: {} });
    const notification = parseMessage('{"jsonrpc":"2.0","method":"notifications/initialized"}');
    if (!notification) throw new Error("could not build notification");
    expect(await handleMessage(notification, ctx(client))).toBeNull();
    expect(await handleMessage(req(4, "resources/list"), ctx(client))).toEqual({ jsonrpc: "2.0", id: 4, error: { code: -32601, message: "no method resources/list" } });
  });

  test("tools/list is the kind's list", async () => {
    const { api: client } = api({});
    const reply = await handleMessage(req(5, "tools/list"), ctx(client, "none"));
    expect(reply).toMatchObject({ result: { tools: [{ name: "canopy_status" }, { name: "canopy_runs" }, { name: "canopy_queue" }, { name: "canopy_health" }] } });
  });

  test("a tool the kind does not hold, and one that does not exist, are refused before any call", async () => {
    const { api: client, calls } = api({});
    expect(await handleMessage(req(6, "tools/call", { name: "canopy_land", arguments: { run: "r" } }), ctx(client, "none"))).toEqual({ jsonrpc: "2.0", id: 6, error: { code: -32602, message: "canopy_land is not a tool this none token holds" } });
    expect(await handleMessage(req(7, "tools/call", { name: "canopy_rm", arguments: {} }), ctx(client))).toEqual({ jsonrpc: "2.0", id: 7, error: { code: -32602, message: "no tool named canopy_rm" } });
    expect(await handleMessage(req(8, "tools/call", {}), ctx(client))).toEqual({ jsonrpc: "2.0", id: 8, error: { code: -32602, message: "tools/call needs a name" } });
    expect(calls).toEqual([]);
  });

  test("a call's result, and the API's error as text", async () => {
    const { api: client } = api({ "GET /api/health": { checks: [] }, "POST /api/runs/say": () => { throw new Error("no run nope"); } });
    expect(await handleMessage(req(9, "tools/call", { name: "canopy_health", arguments: {} }), ctx(client))).toEqual({ jsonrpc: "2.0", id: 9, result: { content: [{ type: "text", text: "no checks" }] } });
    expect(await handleMessage(req(10, "tools/call", { name: "canopy_say", arguments: { id: "nope", text: "hi" } }), ctx(client))).toEqual({ jsonrpc: "2.0", id: 10, result: { content: [{ type: "text", text: "no run nope" }], isError: true } });
  });
});

describe("callTool", () => {
  test("each tool's call and words", async () => {
    const { api: client, calls } = api({
      "GET /api/tree": { repos: [] }, "GET /api/runs": [], "GET /api/landing": { runs: [], entries: [], orphans: [] }, "GET /api/health": { checks: [] },
      "POST /api/runs/say": { id: "r1", status: "working" },
      "POST /api/ranger/wakes": { id: "1a2b3c4d", by: "eric", prompt: "p", cron: "0 8 * * *", created: 1, next: 2 },
      "POST /api/landing/land": { id: "a", state: "queued", branch: "run/x-a", target: "main", repoId: "r", repoPath: "/r", dir: "/w", note: "", tries: 0, queuedAt: 1, updatedAt: 1 },
      "POST /api/prs/open": { number: 12, url: "https://github.com/o/r/pull/12" },
    });
    expect(await callTool("canopy_status", {}, ctx(client))).toEqual({ text: "no repos", isError: false });
    expect(await callTool("canopy_runs", { json: true }, ctx(client))).toEqual({ text: "[]", isError: false });
    expect(await callTool("canopy_queue", {}, ctx(client))).toEqual({ text: "no branch runs in any queue", isError: false });
    expect(await callTool("canopy_health", {}, ctx(client))).toEqual({ text: "no checks", isError: false });
    expect(await callTool("canopy_say", { id: "r1", text: "go" }, ctx(client))).toEqual({ text: "said to r1, now working", isError: false });
    expect(await callTool("canopy_wake", { prompt: "p", cron: "0 8 * * *" }, ctx(client))).toEqual({ text: "wake 1a2b3c4d set for cron 0 8 * * *", isError: false });
    expect(await callTool("canopy_wake", { prompt: "p", when: "in 30m" }, ctx(client, "ranger"))).toMatchObject({ isError: false });
    expect(await callTool("canopy_land", { run: "run-a" }, ctx(client))).toEqual({ text: "queued 1st: run/x-a into main", isError: false });
    expect(await callTool("canopy_pr", { run: "run-a" }, ctx(client))).toEqual({ text: "PR #12 opened: https://github.com/o/r/pull/12", isError: false });
    expect(await callTool("canopy_say", { id: "r1" }, ctx(client))).toEqual({ text: "canopy_say needs text", isError: true });
    expect(calls.filter((call) => call[1] === "/api/ranger/wakes").map((call) => call[2])).toEqual([{ prompt: "p", cron: "0 8 * * *", by: "eric" }, { prompt: "p", when: "in 30m" }]);
    const say = calls.find((call) => call[1] === "/api/runs/say");
    const land = calls.find((call) => call[1] === "/api/landing/land");
    expect(say?.[2]).toEqual({ id: "r1", text: "go" });
    expect(land?.[2]).toEqual({ run: "run-a" });
  });
});

test("serve reads newline messages in order, drops junk, and flushes the last line", async () => {
  const { api: client } = api({ "GET /api/health": { checks: [] } });
  const lines = [
    JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } }),
    "",
    "starting up, log chatter",
    '{"jsonrpc":"2.0","method":"notifications/initialized"}',
    '{"not":"a message"}',
    JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "canopy_health", arguments: {} } }),
  ];
  const text = lines.join("\n") + "\n" + JSON.stringify({ jsonrpc: "2.0", id: 3, method: "ping" });
  const encoder = new TextEncoder();
  const input = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(encoder.encode(text.slice(0, 40))); controller.enqueue(encoder.encode(text.slice(40))); controller.close(); } });
  const output: string[] = [];
  await serve(input, { write: (line) => output.push(line) }, ctx(client));
  const ids = output.map((line) => {
    const value: unknown = JSON.parse(line);
    if (typeof value !== "object" || value === null || !("id" in value) || typeof value.id !== "number") throw new Error("reply did not have a numeric id");
    return value.id;
  });
  expect(ids).toEqual([1, 2, 3]);
  expect(JSON.parse(output[1] ?? "null")).toEqual({ jsonrpc: "2.0", id: 2, result: { content: [{ type: "text", text: "no checks" }] } });
});
