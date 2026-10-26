# Agent surface, plan 1: canopy mcp for shells and the ranger (FR-038)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Status:** implemented and verified locally 2026-10-26, based on main at 0fabbb3. The combined four gates, MCP image builds, compose validation and real scratch-backend token check passed. Deployment and interactive Claude/Codex shell/ranger discovery remain pending; plans 2 and 3 remain open.

**Goal:** `canopy mcp` is a stdio MCP server over canopy's API that acts with
the token in its environment and offers the tools that token's rights allow;
the kit writes it into Claude's and Codex's config on every backend machine;
the mini's shells container can start it; and the ranger's brief names the
tools. Eric's own sessions in canopy shells get the tools with the shell's
token, the ranger with its own. No new caller kind: the `run` kind, `LANES`,
`runs/child`, depth, the pre-flight toggle and `mcp.json` are plan 2; Codex's
`-c` lines, `lib/canopy-tools.md` and the agents board chip are plan 3.

**Architecture:** three layers. `core/canopymcp.ts` is pure: the tool table
filtered by `allows(kind, right)`, text folders over the API's records, and
JSON-RPC dispatch over the line framing `core/codexrpc.ts` already has, with
no Bun or node import. `cli/mcp.ts` is the process: the backend's address and
the token from the environment, one `GET /api/auth` for the token's kind,
stdin and stdout. The kit gains `canopy` as a server it knows without the
manifest naming it, and the shells container gains a `canopy` launcher that
runs a bundle of the server the canopy service leaves on the config volume,
since that container carries no canopy code. Nothing in `src/server/`
changes but the kit hub's manifest read.

**Tech Stack:** Bun, TypeScript strict, bun:test. No new dependencies: the
MCP stdio protocol is four methods of newline-delimited JSON-RPC 2.0,
hand-written.

**Spec:** `docs/superpowers/specs/2026-10-25-agent-surface-design.md`, the
"Plans" list's item 1. The index is
`docs/superpowers/specs/2026-10-25-software-factory-borrowings-design.md`.

## Global constraints

- The server is started as `canopy mcp` and speaks newline-delimited JSON-RPC 2.0 on stdio: `initialize`, `notifications/initialized`, `ping`, `tools/list`, `tools/call`. stdout carries replies and nothing else; every other word goes to stderr.
- `PROTOCOL_VERSION` is `2025-06-18`; the server also knows `2025-03-26` and `2024-11-05` and answers `initialize` with the client's version when it is one of the three, else its own.
- The tools are `canopy_status`, `canopy_runs`, `canopy_queue`, `canopy_health` (right `read`), `canopy_say`, `canopy_wake` (right `plan`), `canopy_land`, `canopy_pr` (right `operate`). `canopy_work_note` waits for FR-037's route and `canopy_run_start` for plan 2's `POST /api/runs/child`.
- A kind's list is the tools `allows(kind, right)` lets through, from `TOOLS_FOR[kind]`; the server asks `GET /api/auth` once at start for `you`.
- Every tool answers plain text, short by default; `json: true` only on `canopy_runs` and `canopy_queue`. Errors come back as the API's `{error}` text, never a stack. The server never retries a write.
- The server reads `CANOPY_API`, `CANOPY_TOKEN` and `CANOPY_RUN` from its own environment, and takes `--backend` as every command does.
- The kit's entry is the server `canopy` with the command `canopy`, the args `["mcp"]` and no env of its own.
- Every file the UI could import from `src/core/` stays browser-safe: `core/canopymcp.ts` has no `node:` or `bun` import; the CLI hands it the streams.
- Plain words, no em dashes, sentence case headings (the unslop rules apply to docs and commit messages).
- All four gates pass before a task is done: `bun run typecheck`, `bun run lint`, `bun test`, `bun run build`.

## Review focus

Inputs the spec implies and no section of it names. Each has a test in the task that owns the code.

1. A line on stdin that is not a JSON-RPC message (blank, a log line, JSON without a method): the server ignores it and keeps serving, never exits and never answers it (Task 2).
2. A `tools/call` for a tool the token's kind does not hold (a `none` token calling `canopy_land`): refused by the server itself with a JSON-RPC error naming the tool and the kind, before any HTTP call is made (Task 2).
3. The backend answering a call with `{error}` (a 404 for a run id that is gone): the tool's result is that text with `isError`, and the server goes on to the next message rather than throwing (Task 2 for the result, Task 3 for the fetch).
4. `CANOPY_TOKEN` set in the environment on a machine that also has a CLI token file: the environment's token wins, so a shell's or the ranger's session acts with its own rights and never with the CLI's admin (Task 3).
5. A `kit.json` that defines `canopy` itself (Eric pinning it to one machine or another command): the manifest's entry stands and the built-in one yields, so nothing is written twice (Task 4).

---

## File structure

- Create `src/core/canopymcp.ts` (pure, browser-safe): `TOOLS`, `TOOLS_FOR`, `toolsFor`, the folders, `callTool`, `handleMessage`, `serve`, the protocol constants.
- Create `src/core/canopymcp.test.ts`.
- Create `src/cli/mcp.ts` and `src/cli/mcp.test.ts`: `mcpToken`, `apiOver`, `toolLines`, `mcpCommand`.
- Modify `src/cli/index.ts` (the `case "mcp"`), `src/core/help.ts` (two usage lines), `README.md` (two CLI lines).
- Modify `src/core/kit.ts` and `src/core/kit.test.ts`: `canopyServer`, `withCanopyServer`; `src/server/kit.ts`: the hub's read folds it in.
- Create `bin/canopy-mcp.ts` (the bundle's entry) and `docker/canopy` (the shells container's launcher); modify `Dockerfile`, `docker-compose.yml`, `docs/deploy.md`.
- Modify `lib/ranger.md` (a "Tools" block) and `src/server/ranger.test.ts`.
- Modify `docs/architecture.md`, `SPEC.md`, `README.md`, `FEATURES.md`, `docs/superpowers/plans/README.md`.

---

### Task 1: the tool table and the folders

**Files:**
- Create: `src/core/canopymcp.ts`, `src/core/canopymcp.test.ts`

**Interfaces:**
- Consumes: `CallerKind`, `Right`, `allows` from `src/core/callers.ts:9-35`; `Repo`, `Run`, `LandingInfo`, `LandEntry`, `LandingRun`, `HealthCheck` from `src/core/types.ts`; `inQueue`, `sentBack` (`src/core/landing.ts:25-26`), `reviewWord` (`:150`), `stoppedWhole` (`:175`), `queueOf` (`:216`), `landWord` (`:223`).
- Produces, all in `src/core/canopymcp.ts`:

```ts
export const SERVER_NAME = "canopy";
export const PROTOCOL_VERSION = "2025-06-18";
export const PROTOCOL_VERSIONS: readonly string[] = ["2025-06-18", "2025-03-26", "2024-11-05"];
export type ToolName = "canopy_status" | "canopy_runs" | "canopy_queue" | "canopy_health" | "canopy_say" | "canopy_wake" | "canopy_land" | "canopy_pr";
export interface ToolInput { type: "string" | "boolean"; description: string }
export interface ToolSchema { type: "object"; properties: Record<string, ToolInput>; required?: string[]; additionalProperties: false }
export interface ToolSpec { name: ToolName; right: Right; description: string; inputSchema: ToolSchema }
/** in the spec's order: the read tools, the plan tools, the operate tools */
export const TOOLS: readonly ToolSpec[];
export const toolsFor = (kind: CallerKind): ToolSpec[] => TOOLS.filter((t) => allows(kind, t.right));
/** the names per kind, derived from `toolsFor` */
export const TOOLS_FOR: Record<CallerKind, readonly ToolName[]>;
/** one line per repo that is not archived: id, branch, ahead and behind, changed files, the run working in it */
export function foldStatus(repos: readonly Repo[], runs: readonly Run[]): string;
/** one line per run in the API's order; with `id`, that run's line, its error, and its last 10 steps */
export function foldRuns(runs: readonly Run[], id?: string): string;
/** a repo's queue in order, what came back and why, what is ready; `repo` is an id or a folder name */
export function foldQueue(info: LandingInfo, repo?: string): string;
/** a count line, then one line per check, down and gave-up first */
export function foldHealth(checks: readonly HealthCheck[]): string;
```

The table, each description verbatim (the agent reads these):

| name | right | description | inputs |
| --- | --- | --- | --- |
| `canopy_status` | read | Every repo canopy shows on this backend: id, branch, ahead and behind, changed files, and the run working in it. A repo's id is what the other tools take. | none |
| `canopy_runs` | read | The agent runs on this backend, oldest first. Give id for one run with its last steps; json true for the records as the API has them. | `id` string, `json` boolean |
| `canopy_queue` | read | The landing queues: each repo's branch runs queued in order, what was sent back and why, and what is ready to land. repo narrows to one repo id or folder name; json true for the record. | `repo` string, `json` boolean |
| `canopy_health` | read | canopy's health checks, the bad ones first. | none |
| `canopy_say` | plan | Send text to a running chat or run by its id, as typing into its sheet would. | `id`, `text` strings, both required |
| `canopy_wake` | plan | Wake the ranger later with a prompt: when (in 30m, 14:00, an ISO time), cron (five fields, local time) or run (a run id: when that run ends). Give exactly one of the three. | `prompt` required; `when`, `cron`, `run` strings |
| `canopy_land` | operate | A ready branch run into its repo's landing queue: rebase, gates, fast-forward; never a push. Only when the user asked for it to land. | `run` string, required |
| `canopy_pr` | operate | Push a ready branch run and open a PR on GitHub in place of landing it; never a force push. Only when the user asked for a PR. | `run` string, required |

Every schema has `additionalProperties: false`. The folders' lines, pinned by the tests:
- `foldStatus`: `${id}  ${branch}` then, when present, ` ${ahead} ahead`, ` ${behind} behind`, ` ${files.length} changed`, then `  run: ${verb} ${status}` for a run in that repo whose status is `working`, `waiting` or `idle`; a repo with `status: null` reads `${id}  ${error ?? "no status"}`; archived repos are left out; `no repos` when none.
- `foldRuns`: `${id}  ${repoId}  ${status}  ${verb}` then `  ${first line of note}` when the note is not empty. With `id`: that line, then `error: ${error}` when set, then the last 10 steps as `  ${kind}: ${text}` for text, note and user steps and `  tool: ${tool.title} (${tool.status})` for a tool step; `no run ${id}` when none matches; `no runs` when the list is empty.
- `foldQueue`: for each repo id in `entries` and `runs`, sorted, that `repo` names (`id === repo` or the last path segment equals `repo`): the id, then each queued entry as `  ${landWord(e, entries).padEnd(16)} ${branch}`, each sent-back entry the same with `  ${last line of reason}` after, each ready run (`state === "ready"`, not in the entries) as `  ${"ready".padEnd(16)} ${branch}  ${review ? reviewWord(review) : "sorting"}  canopy_land ${runId}`, each stopped whole run as `  ${"stopped".padEnd(16)} ${branch}  can land: ...` the same way; `no branch runs in any queue` when nothing was listed.
- `foldHealth`: `${bad} of ${n} checks down` (or `all ${n} checks ok`, or `no checks`), then `  ${state.padEnd(8)} ${label}` with `  ${why}` when set and `  ${id}` last; `down` and `gave-up` first, in the order given, then the rest in the order given.

- [ ] **Step 1: Write the failing tests in `src/core/canopymcp.test.ts`**

```ts
import { describe, expect, test } from "bun:test";
import { foldHealth, foldQueue, foldRuns, foldStatus, TOOLS, TOOLS_FOR, toolsFor } from "./canopymcp";
import { enqueue } from "./landing";
import type { HealthCheck, LandingInfo, LandingRun, Repo, RepoStatus, Run } from "./types";

const ALL = ["canopy_status", "canopy_runs", "canopy_queue", "canopy_health", "canopy_say", "canopy_wake", "canopy_land", "canopy_pr"];

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
    expect(toolsFor("shell").map((t) => t.name)).toEqual(ALL);
  });
  test("each schema is a closed object with the inputs the call reads", () => {
    for (const t of TOOLS) expect([t.inputSchema.type, t.inputSchema.additionalProperties]).toEqual(["object", false]);
    const of = (name: string) => TOOLS.find((t) => t.name === name)!.inputSchema;
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
const repo = (id: string, over: Partial<Repo> = {}): Repo => ({ id, name: id.split("/").pop()!, path: `/d/${id}`, group: "", source: "root", status: status(), ...over });
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test src/core/canopymcp.test.ts`
Expected: FAIL, the module is not found.

- [ ] **Step 3: Write the table and the folders in `src/core/canopymcp.ts`**

Header comment: canopy's own MCP server, the pure half (the tool table, the folders, the JSON-RPC dispatch Task 2 adds), browser-safe, started as `canopy mcp` by `cli/mcp.ts`. Only the table and the folders in this task.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test src/core/canopymcp.test.ts && bun run typecheck && bun run lint`
Expected: PASS, clean.

- [ ] **Step 5: Commit**

```bash
git add src/core/canopymcp.ts src/core/canopymcp.test.ts
git commit -m "feat(mcp): the tool table per caller kind and the text folders (FR-038)"
```

---

### Task 2: the server

**Files:**
- Modify: `src/core/canopymcp.ts`, `src/core/canopymcp.test.ts`

**Interfaces:**
- Consumes: `parseMessage`, `LineSplitter`, `RpcMessage`, `RpcId` from `src/core/codexrpc.ts:85-168`; Task 1's table and folders; `ScanResult`, `RangerWake`, `PrWatch` from `core/types.ts`; `landWord` from `core/landing.ts`.
- Produces in `src/core/canopymcp.ts`:

```ts
export const INSTRUCTIONS = "These tools act on canopy's API with the token this session holds; a tool the token's rights do not cover is not listed. Answers are short text; json true on canopy_runs and canopy_queue gives the record. An error is the API's own words.";
export interface CanopyApi {
  /** one call to the backend; resolves the JSON body, rejects with the API's `error` text, else `<name> answered <status>` */
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
/** runs one tool the kind holds; a throw from the API is the text with isError */
export async function callTool(name: ToolName, args: unknown, ctx: McpContext): Promise<ToolResult>;
export type RpcReply =
  | { jsonrpc: "2.0"; id: RpcId; result: unknown }
  | { jsonrpc: "2.0"; id: RpcId; error: { code: number; message: string } };
/** one message in, at most one reply out: null for a notification or anything that is not a request */
export async function handleMessage(msg: RpcMessage, ctx: McpContext): Promise<RpcReply | null>;
export interface LineOut { write(line: string): unknown }
/** reads `input` to its end, one message per line; a line that is not a message is dropped */
export async function serve(input: ReadableStream<Uint8Array>, out: LineOut, ctx: McpContext): Promise<void>;
```

`handleMessage` by method:
- `initialize`: `{ protocolVersion, capabilities: { tools: {} }, serverInfo: { name: SERVER_NAME, version: ctx.version }, instructions: INSTRUCTIONS }`, `protocolVersion` being `params.protocolVersion` when it is in `PROTOCOL_VERSIONS`, else `PROTOCOL_VERSION`.
- `ping`: `{}`.
- `tools/list`: `{ tools: toolsFor(ctx.kind).map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) }`.
- `tools/call`: `params.name` missing is error `-32602` `tools/call needs a name`; a name in `TOOLS` but not in `toolsFor(ctx.kind)` is `-32602` `${name} is not a tool this ${kind} token holds`; a name not in `TOOLS` is `-32602` `no tool named ${name}`; else `{ content: [{ type: "text", text }], isError: true }` or without `isError` when false.
- any other method: `-32601` `no method ${method}`.
- a notification, a response or an error message: null.

`callTool` by tool, each a thin call; a string read off `args` that is missing or not a string is `{ text: "<tool> needs <field>", isError: true }` for a required field, and absent for an optional one:
- `canopy_status`: `GET /api/tree` (a `ScanResult`), then `GET /api/runs` (`Run[]`), one after the other → `foldStatus(tree.repos, runs)`.
- `canopy_runs`: `GET /api/runs` → `json` ? `JSON.stringify(id ? runs.find(...) ?? null : runs)` : `foldRuns(runs, id)`.
- `canopy_queue`: `GET /api/landing` (`LandingInfo`) → `json` ? `JSON.stringify(info)` : `foldQueue(info, repo)`.
- `canopy_health`: `GET /api/health` (`{ checks: HealthCheck[] }`) → `foldHealth(checks)`.
- `canopy_say`: `POST /api/runs/say { id, text }` (a `Run`) → `said to ${run.id}, now ${run.status}`.
- `canopy_wake`: `POST /api/ranger/wakes { prompt, when | cron | run, by }` with `by: "eric"` unless `ctx.kind === "ranger"` (the ranger's own wakes are its own, as `canopy ranger wake` sends `by: "eric"` at `src/cli/index.ts:837`) → a `RangerWake` → `wake ${w.id} set for ${w.cron ? \`cron ${w.cron}\` : w.run ? \`the end of run ${w.run}\` : new Date(w.at ?? 0).toISOString()}`.
- `canopy_land`: `POST /api/landing/land { run }` (a `LandEntry`) → `${landWord(e, [e])}: ${e.branch} into ${e.target}`.
- `canopy_pr`: `POST /api/prs/open { run }` (a `PrWatch`) → `PR #${pr.number} opened: ${pr.url}`.

`serve`: a `LineSplitter` over `input`'s chunks, `parseMessage` per line, `handleMessage` per message, `out.write(JSON.stringify(reply))` per reply, in order; `flush()` at the end for a last line without a newline.

- [ ] **Step 1: Write the failing tests in `src/core/canopymcp.test.ts`**

```ts
import { callTool, handleMessage, INSTRUCTIONS, serve, type CanopyApi, type McpContext } from "./canopymcp";
import { parseMessage } from "./codexrpc";

/** an API that answers by `method path` and records every call */
function api(answers: Record<string, unknown | (() => never)>) {
  const calls: [string, string, unknown][] = [];
  const a: CanopyApi = {
    async call<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
      calls.push([method, path, body]);
      const v = answers[`${method} ${path}`];
      if (typeof v === "function") (v as () => never)();
      if (v === undefined) throw new Error(`no answer for ${method} ${path}`);
      return v as T;
    },
  };
  return { api: a, calls };
}
const ctx = (a: CanopyApi, kind: McpContext["kind"] = "shell"): McpContext => ({ api: a, kind, run: null, version: "0.1.0 (abc1234)" });
const req = (id: number, method: string, params?: unknown) => parseMessage(JSON.stringify({ jsonrpc: "2.0", id, method, ...(params !== undefined ? { params } : {}) }))!;

describe("handleMessage", () => {
  test("initialize answers the client's version when known, else the server's, with the instructions", async () => {
    const { api: a } = api({});
    const r = await handleMessage(req(1, "initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "0" } }), ctx(a));
    expect(r).toEqual({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "canopy", version: "0.1.0 (abc1234)" }, instructions: INSTRUCTIONS } });
    const r2 = await handleMessage(req(2, "initialize", { protocolVersion: "2099-01-01" }), ctx(a));
    expect(r2).toMatchObject({ result: { protocolVersion: "2025-06-18" } });
  });
  test("ping, a notification, an unknown method", async () => {
    const { api: a } = api({});
    expect(await handleMessage(req(3, "ping"), ctx(a))).toEqual({ jsonrpc: "2.0", id: 3, result: {} });
    expect(await handleMessage(parseMessage('{"jsonrpc":"2.0","method":"notifications/initialized"}')!, ctx(a))).toBeNull();
    expect(await handleMessage(req(4, "resources/list"), ctx(a))).toEqual({ jsonrpc: "2.0", id: 4, error: { code: -32601, message: "no method resources/list" } });
  });
  test("tools/list is the kind's list", async () => {
    const { api: a } = api({});
    const r = await handleMessage(req(5, "tools/list"), ctx(a, "none"));
    expect((r as { result: { tools: { name: string; inputSchema: unknown }[] } }).result.tools.map((t) => t.name)).toEqual(["canopy_status", "canopy_runs", "canopy_queue", "canopy_health"]);
  });
  test("a tool the kind does not hold, and one that does not exist, are refused before any call (review focus 2)", async () => {
    const { api: a, calls } = api({});
    expect(await handleMessage(req(6, "tools/call", { name: "canopy_land", arguments: { run: "r" } }), ctx(a, "none"))).toEqual({ jsonrpc: "2.0", id: 6, error: { code: -32602, message: "canopy_land is not a tool this none token holds" } });
    expect(await handleMessage(req(7, "tools/call", { name: "canopy_rm", arguments: {} }), ctx(a))).toEqual({ jsonrpc: "2.0", id: 7, error: { code: -32602, message: "no tool named canopy_rm" } });
    expect(await handleMessage(req(8, "tools/call", {}), ctx(a))).toEqual({ jsonrpc: "2.0", id: 8, error: { code: -32602, message: "tools/call needs a name" } });
    expect(calls).toEqual([]);
  });
  test("a call's result, and the API's error as text (review focus 3)", async () => {
    const { api: a } = api({ "GET /api/health": { checks: [] }, "POST /api/runs/say": () => { throw new Error("no run nope"); } });
    expect(await handleMessage(req(9, "tools/call", { name: "canopy_health", arguments: {} }), ctx(a))).toEqual({ jsonrpc: "2.0", id: 9, result: { content: [{ type: "text", text: "no checks" }] } });
    expect(await handleMessage(req(10, "tools/call", { name: "canopy_say", arguments: { id: "nope", text: "hi" } }), ctx(a))).toEqual({ jsonrpc: "2.0", id: 10, result: { content: [{ type: "text", text: "no run nope" }], isError: true } });
  });
});

describe("callTool", () => {
  test("each tool's call and words", async () => {
    const { api: a, calls } = api({
      "GET /api/tree": { repos: [] }, "GET /api/runs": [], "GET /api/landing": { runs: [], entries: [], orphans: [] },
      "POST /api/runs/say": { id: "r1", status: "working" },
      "POST /api/ranger/wakes": { id: "1a2b3c4d", by: "eric", prompt: "p", cron: "0 8 * * *", created: 1, next: 2 },
      "POST /api/landing/land": { id: "a", state: "queued", branch: "run/x-a", target: "main", repoId: "r", repoPath: "/r", dir: "/w", note: "", tries: 0, queuedAt: 1, updatedAt: 1 },
      "POST /api/prs/open": { number: 12, url: "https://github.com/o/r/pull/12" },
    });
    expect(await callTool("canopy_status", {}, ctx(a))).toEqual({ text: "no repos", isError: false });
    expect(await callTool("canopy_runs", { json: true }, ctx(a))).toEqual({ text: "[]", isError: false });
    expect(await callTool("canopy_queue", {}, ctx(a))).toEqual({ text: "no branch runs in any queue", isError: false });
    expect(await callTool("canopy_say", { id: "r1", text: "go" }, ctx(a))).toEqual({ text: "said to r1, now working", isError: false });
    expect(await callTool("canopy_wake", { prompt: "p", cron: "0 8 * * *" }, ctx(a))).toEqual({ text: "wake 1a2b3c4d set for cron 0 8 * * *", isError: false });
    expect(await callTool("canopy_wake", { prompt: "p", when: "in 30m" }, ctx(a, "ranger"))).toMatchObject({ isError: false });
    expect(await callTool("canopy_land", { run: "run-a" }, ctx(a))).toEqual({ text: "queued 1st: run/x-a into main", isError: false });
    expect(await callTool("canopy_pr", { run: "run-a" }, ctx(a))).toEqual({ text: "PR #12 opened: https://github.com/o/r/pull/12", isError: false });
    expect(await callTool("canopy_say", { id: "r1" }, ctx(a))).toEqual({ text: "canopy_say needs text", isError: true });
    expect(calls.filter((c) => c[1] === "/api/ranger/wakes").map((c) => c[2])).toEqual([{ prompt: "p", cron: "0 8 * * *", by: "eric" }, { prompt: "p", when: "in 30m" }]);
    expect(calls.find((c) => c[1] === "/api/runs/say")![2]).toEqual({ id: "r1", text: "go" });
    expect(calls.find((c) => c[1] === "/api/landing/land")![2]).toEqual({ run: "run-a" });
  });
});

test("serve: a message per line, replies in order, junk lines dropped, a last line without a newline (review focus 1)", async () => {
  const { api: a } = api({ "GET /api/health": { checks: [] } });
  const lines = [
    JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } }),
    "",
    "starting up, log chatter",
    '{"jsonrpc":"2.0","method":"notifications/initialized"}',
    '{"not":"a message"}',
    JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "canopy_health", arguments: {} } }),
  ];
  const text = lines.join("\n") + "\n" + JSON.stringify({ jsonrpc: "2.0", id: 3, method: "ping" });
  const enc = new TextEncoder();
  const input = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(enc.encode(text.slice(0, 40))); c.enqueue(enc.encode(text.slice(40))); c.close(); } });
  const out: string[] = [];
  await serve(input, { write: (l) => out.push(l) }, ctx(a));
  expect(out.map((l) => (JSON.parse(l) as { id: number }).id)).toEqual([1, 2, 3]);
  expect(JSON.parse(out[1]!)).toEqual({ jsonrpc: "2.0", id: 2, result: { content: [{ type: "text", text: "no checks" }] } });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test src/core/canopymcp.test.ts`
Expected: FAIL, `handleMessage`, `callTool` and `serve` are not exported.

- [ ] **Step 3: Add `callTool`, `handleMessage` and `serve`**

Import `parseMessage`, `LineSplitter` and the two types from `./codexrpc` (pure). Read strings off `args` with a small local reader that narrows `unknown`; no cast.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test src/core/canopymcp.test.ts src/core/codexrpc.test.ts && bun run typecheck && bun run lint`
Expected: PASS, clean.

- [ ] **Step 5: Commit**

```bash
git add src/core/canopymcp.ts src/core/canopymcp.test.ts
git commit -m "feat(mcp): JSON-RPC over stdio, the tool calls and their words"
```

---

### Task 3: `canopy mcp` and `canopy mcp tools`

**Files:**
- Create: `src/cli/mcp.ts`, `src/cli/mcp.test.ts`
- Modify: `src/cli/index.ts:851-852` (a `case "mcp"` beside `kit`) and `:52` (the import); `src/core/help.ts:85` (two lines after `canopy kit`'s); `README.md:58` (two lines after `canopy auth status | logout`)

**Interfaces:**
- Consumes: `apiBase`, `callerToken` from `src/cli/api.ts:11,52`; `take`, `errText` from `src/cli/health.ts:36,195`; `readBuild` (`src/core/build.ts:46`), `versionLine` (`src/core/version.ts:12`); Task 2's `serve`, `CanopyApi`, `McpContext`, Task 1's `toolsFor`.
- Produces in `src/cli/mcp.ts`:

```ts
export const MCP_USAGE = "usage: canopy mcp [--backend URL]\n       canopy mcp tools [--backend URL]";
/** the environment's CANOPY_TOKEN first, then the CLI's own order (--token, the token file, $CANOPY_TOKEN for the home base) */
export function mcpToken(base: string, env: Record<string, string | undefined> = process.env): string | null;
/** a CanopyApi over one fetch per call to `base`, `token` in X-Canopy-Token, 30 s per call, a redirect counted as an answer, never a retry */
export function apiOver(base: string, token: string | null): CanopyApi;
/** `tools for a <kind> token on <base>`, then `  <name padded to 15>  <right padded to 8>  <description>` per tool */
export function toolLines(kind: CallerKind, base: string): string[];
export async function mcpCommand(argv: string[], { fail }: { fail: (msg: string) => never }): Promise<void>;
```

`mcpCommand`: `base = apiBase(take(args, "--backend"))`, `api = apiOver(base, mcpToken(base))`, then `you` from `api.call<{ you: CallerKind }>("GET", "/api/auth")`; a throw there is `fail(\`canopy mcp: ${base} did not answer: ${why}\`)`, so Claude shows the server as failed and a `/mcp` reconnect tries again. `tools` prints `toolLines(you, base)`. No word: `serve(Bun.stdin.stream(), out, { api, kind: you, run: process.env["CANOPY_RUN"] ?? null, version: versionLine(readBuild()) })` with `out` writing `line + "\n"` through `Bun.stdout.writer()` and flushing after each line. Any other word is `fail(MCP_USAGE)`. `apiOver.call` rejects with the body's `error` when the status is not 2xx, else `${base} answered ${status}`.

The help lines (`src/core/help.ts`, after line 85):

```
  canopy mcp                         an MCP server on stdio for the agent that started it: canopy's tools with the rights of $CANOPY_TOKEN
  canopy mcp tools                   the tools that token holds, one per line
```

The README lines (after line 58):

```
canopy mcp                         # an MCP server on stdio: canopy's tools for the agent that started it, with $CANOPY_TOKEN's rights (claude mcp add canopy -- canopy mcp)
canopy mcp tools                   # the tools that token holds
```

- [ ] **Step 1: Write the failing tests in `src/cli/mcp.test.ts`**

```ts
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LineSplitter } from "../core/codexrpc";
import { tokenFile } from "./api";
import { mcpToken, toolLines } from "./mcp";

const ALL = ["canopy_status", "canopy_runs", "canopy_queue", "canopy_health", "canopy_say", "canopy_wake", "canopy_land", "canopy_pr"];
const root = join(import.meta.dir, "../..");
let server: ReturnType<typeof Bun.serve>;
let base = "";
let config = "";
const seen: { path: string; token: string | null; body: unknown }[] = [];

beforeAll(async () => {
  config = await mkdtemp(join(tmpdir(), "canopy-mcp-"));
  process.env["CANOPY_CONFIG_DIR"] = config;
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      seen.push({ path: url.pathname, token: req.headers.get("x-canopy-token"), body: req.method === "POST" ? await req.json() : null });
      if (url.pathname === "/api/auth") return Response.json({ you: "shell" });
      if (url.pathname === "/api/tree") return Response.json({ repos: [{ id: "a", name: "a", path: "/d/a", group: "", source: "root", status: { branch: "main", upstream: null, ahead: 0, behind: 0, files: [], lastCommit: null, user: null } }] });
      if (url.pathname === "/api/runs") return Response.json([]);
      if (url.pathname === "/api/runs/say") return Response.json({ error: "no run nope" }, { status: 404 });
      return Response.json({ error: "nope" }, { status: 404 });
    },
  });
  base = `http://127.0.0.1:${server.port}`;
  await writeFile(tokenFile(base), "file-token");
});
afterAll(async () => {
  server.stop(true);
  await rm(config, { recursive: true, force: true });
});

test("the environment's token wins over the token file, which wins over nothing (review focus 4)", () => {
  expect(mcpToken(base, { CANOPY_TOKEN: "env-token" })).toBe("env-token");
  expect(mcpToken(base, {})).toBe("file-token");
  expect(mcpToken("http://127.0.0.1:1", {})).toBeNull();
});

test("toolLines", () => {
  const lines = toolLines("none", "http://x");
  expect(lines[0]).toBe("tools for a none token on http://x");
  expect(lines[1]).toBe("  canopy_status    read      Every repo canopy shows on this backend: id, branch, ahead and behind, changed files, and the run working in it. A repo's id is what the other tools take.");
  expect(lines).toHaveLength(5);
});

const env = () => ({ ...process.env, CANOPY_API: base, CANOPY_TOKEN: "env-token", CANOPY_CONFIG_DIR: config });
const msg = (o: unknown) => JSON.stringify(o) + "\n";

test("canopy mcp over stdio: initialize, the shell's tools, a status call, an API error as text, the environment's token on every call", async () => {
  seen.length = 0;
  const proc = Bun.spawn(["bun", "bin/canopy.ts", "mcp"], { cwd: root, env: env(), stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  proc.stdin.write(msg({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } } }));
  proc.stdin.write(msg({ jsonrpc: "2.0", method: "notifications/initialized" }));
  proc.stdin.write(msg({ jsonrpc: "2.0", id: 2, method: "tools/list" }));
  proc.stdin.write(msg({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "canopy_status", arguments: {} } }));
  proc.stdin.write(msg({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "canopy_say", arguments: { id: "nope", text: "hi" } } }));
  proc.stdin.end();
  const text = await new Response(proc.stdout).text();
  const replies = new LineSplitter().push(text).map((l) => JSON.parse(l) as { id: number; result?: Record<string, unknown> });
  expect(replies.map((r) => r.id)).toEqual([1, 2, 3, 4]);
  expect(replies[0]!.result).toMatchObject({ protocolVersion: "2025-06-18", serverInfo: { name: "canopy" }, capabilities: { tools: {} } });
  expect((replies[1]!.result!["tools"] as { name: string }[]).map((t) => t.name)).toEqual(ALL);
  expect(replies[2]!.result).toEqual({ content: [{ type: "text", text: "a  main" }] });
  expect(replies[3]!.result).toEqual({ content: [{ type: "text", text: "no run nope" }], isError: true });
  expect(await proc.exited).toBe(0);
  expect(seen.map((s) => [s.path, s.token])).toEqual([["/api/auth", "env-token"], ["/api/tree", "env-token"], ["/api/runs", "env-token"], ["/api/runs/say", "env-token"]]);
});

test("canopy mcp tools prints the list for the token in hand; a backend that does not answer fails plainly", async () => {
  const ok = Bun.spawnSync(["bun", "bin/canopy.ts", "mcp", "tools"], { cwd: root, env: env() });
  expect(ok.stdout.toString().split("\n")[0]).toBe(`tools for a shell token on ${base}`);
  expect(ok.stdout.toString().trim().split("\n")).toHaveLength(9);
  const down = Bun.spawnSync(["bun", "bin/canopy.ts", "mcp", "tools"], { cwd: root, env: { ...env(), CANOPY_API: "http://127.0.0.1:1" } });
  expect(down.exitCode).toBe(1);
  expect(down.stderr.toString()).toContain("canopy mcp: http://127.0.0.1:1 did not answer");
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test src/cli/mcp.test.ts`
Expected: FAIL, the module is not found.

- [ ] **Step 3: Write `src/cli/mcp.ts`, the `case`, the help and the README lines**

Header: "`canopy mcp`: the process around `core/canopymcp.ts`. Bun-only." The `case "mcp": return mcpCommand(args, { fail });` goes beside `kit` at `src/cli/index.ts:851`. `ui/src/cli.ts` reads the page's `VERBS` off `HELP_TEXT`, so run `bun test ui/src/cli.test.ts` after the help change.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test src/cli/mcp.test.ts src/cli/api.test.ts ui/src/cli.test.ts && bun run typecheck && bun run lint`
Expected: PASS, clean. Then, with the Mac's own backend up: `CANOPY_TOKEN= canopy mcp tools` prints `tools for a cli token on http://127.0.0.1:7850` and eight lines.

- [ ] **Step 5: Commit**

```bash
git add src/cli/mcp.ts src/cli/mcp.test.ts src/cli/index.ts src/core/help.ts README.md
git commit -m "feat(cli): canopy mcp serves canopy's tools on stdio with the token in its env (FR-038)"
```

---

### Task 4: the kit knows `canopy`

**Files:**
- Modify: `src/core/kit.ts` (beside `mcpWanted` at `:400`), `src/core/kit.test.ts`, `src/server/kit.ts` (the hub's `read`, the line after `parseKit(raw)`)

**Interfaces:**
- Consumes: `KitManifest`, `KitMachine`, `KitMcpServer` from `src/core/types.ts:3318-3405`; `buildEntry` (`src/core/kit.ts:421`) for the test.
- Produces in `src/core/kit.ts`:

```ts
/** canopy's own MCP server, on every machine a canopy backend runs on (`backend` set): `canopy mcp`, the token from the shell's env */
export const canopyServer = (machines: readonly KitMachine[]): KitMcpServer;
/** the manifest with `canopy` added unless it defines a server by that name itself */
export function withCanopyServer(kit: KitManifest): KitManifest;
```

`canopyServer` is `{ name: "canopy", command: "canopy", args: ["mcp"], url: null, env: {}, headers: {}, agents: null, machines: <names with backend !== null>, options: {} }`. `KitHub.read()` in `src/server/kit.ts` returns `withCanopyServer(r.kit)`, so every scan, plan and cell sees it while `parseKit` and its tests stay as they are.

- [ ] **Step 1: Write the failing test in `src/core/kit.test.ts`**

Beside the other manifest tests, using the file's `RAW` and `kit()`:

```ts
test("the kit knows canopy: canopy mcp on every backend machine, unless the manifest defines it (review focus 5)", () => {
  const k = withCanopyServer(kit());
  expect(k.mcp).toEqual([{ name: "canopy", command: "canopy", args: ["mcp"], url: null, env: {}, headers: {}, agents: null, machines: ["mac", "mini"], options: {} }]);
  expect(buildEntry(k.mcp[0]!, "claude", "claude-json", "/h", {})).toEqual({ entry: { type: "stdio", command: "canopy", args: ["mcp"] } });
  expect(buildEntry(k.mcp[0]!, "codex", "codex-toml", "/h", {})).toEqual({ entry: { command: "canopy", args: ["mcp"] } });
  const own = parseKit({ ...RAW, mcp: { canopy: { command: "~/.bun/bin/canopy", args: ["mcp"], machines: ["mac"] } } });
  if ("errors" in own) throw new Error(own.errors.join("; "));
  expect(withCanopyServer(own.kit).mcp.map((s) => [s.name, s.command, s.machines])).toEqual([["canopy", "~/.bun/bin/canopy", ["mac"]]]);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test src/core/kit.test.ts -t "knows canopy"`
Expected: FAIL, `withCanopyServer` is not exported.

- [ ] **Step 3: Add the two functions and the hub's call**

- [ ] **Step 4: Run the kit tests to verify they pass**

Run: `bun test src/core/kit.test.ts src/server/kit.test.ts src/cli/kit.test.ts && bun run typecheck`
Expected: PASS. A `src/server/kit.test.ts` expectation that lists every MCP action of a scan with mcp targets on a backend machine now has `canopy`'s `mcp-set` row too (`grep -n mcp-set src/server/kit.test.ts`); add the row rather than filter it out.

- [ ] **Step 5: Commit**

```bash
git add src/core/kit.ts src/core/kit.test.ts src/server/kit.ts
git commit -m "feat(kit): canopy mcp is a server the kit writes on every backend machine"
```

---

### Task 5: `canopy mcp` in the shells container

**Files:**
- Create: `bin/canopy-mcp.ts`, `docker/canopy`
- Modify: `Dockerfile:28` (the bundle, with the other `bun build` lines), `Dockerfile:110` (the launcher, after the claude install in the `shells` stage), `docker-compose.yml:514-521` (the canopy service's `command`), `docs/deploy.md:24-44` ("What runs where") and `:1166` ("The kit")
- Test: `src/cli/mcp.test.ts`

**Interfaces:**
- Consumes: Task 3's `mcpCommand`.
- Produces: `bin/canopy-mcp.ts`, the entry `bun build` bundles to `dist/canopy-mcp.js`:

```ts
#!/usr/bin/env bun
/** The shells container's `canopy` (docker/canopy starts this bundle): only
 *  `canopy mcp` runs there, since the container carries no canopy code. */
```

Its body: `const [word, ...rest] = process.argv.slice(2)`; a word other than `mcp` prints `canopy's CLI is not in the shells container; only canopy mcp runs here. Use the page or the API for the rest.` on stderr and exits 1; else `mcpCommand(rest, { fail })` with `fail` printing to stderr and exiting 1, as `bin/canopy.ts` does.

`docker/canopy`, mode 755 in git as `docker/vault` is:

```sh
#!/bin/sh
# canopy's CLI in the shells container: the MCP server's bundle the canopy
# service leaves on the config volume at each start (docker-compose.yml).
# Only `canopy mcp` runs here; the container has no canopy code of its own.
f=/config/bin/canopy-mcp.js
[ -r "$f" ] || { echo "canopy: $f is not there yet; the canopy service writes it when it starts" >&2; exit 127; }
exec bun "$f" "$@"
```

`Dockerfile`: in the build stage, after line 28, `RUN bun build bin/canopy-mcp.ts --target=bun --outfile /app/dist/canopy-mcp.js` with a comment "canopy's MCP server as one file, for the shells container (docker/canopy)"; in the `shells` stage after line 110, `COPY --chown=bun:bun docker/canopy /home/bun/.local/bin/canopy` with a comment that this is the one piece of canopy the shells image carries, a launcher that never changes, so the shells container is recreated once for it and never again for the server's code. `docker-compose.yml`: the canopy service's `command` becomes

```yaml
    command:
      - sh
      - -c
      - mkdir -p /config/bin && cp /app/dist/canopy-mcp.js /config/bin/canopy-mcp.js && exec bun bin/canopy.ts ui "${DEV_ROOT:-/home/eric/dev}" --port 7850 --no-open
```

with a comment above: the shells' `canopy mcp` runs this bundle off the config volume, copied here so a redeploy refreshes it without touching the shells container.

- [ ] **Step 1: Write the failing test in `src/cli/mcp.test.ts`**

```ts
test("the shells container's bundle builds, answers initialize, and refuses any word but mcp", async () => {
  const out = join(config, "bundle");
  const built = await Bun.build({ entrypoints: [join(root, "bin/canopy-mcp.ts")], target: "bun", outdir: out });
  expect(built.success).toBe(true);
  const file = join(out, "canopy-mcp.js");
  const refused = Bun.spawnSync(["bun", file, "status"], { env: env() });
  expect(refused.exitCode).toBe(1);
  expect(refused.stderr.toString()).toContain("only canopy mcp runs here");
  const proc = Bun.spawn(["bun", file, "mcp"], { env: env(), stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  proc.stdin.write(msg({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "0" } } }));
  proc.stdin.end();
  expect(JSON.parse((await new Response(proc.stdout).text()).trim())).toMatchObject({ id: 1, result: { protocolVersion: "2024-11-05", serverInfo: { name: "canopy" } } });
  expect(await proc.exited).toBe(0);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test src/cli/mcp.test.ts -t bundle`
Expected: FAIL, the entry does not exist.

- [ ] **Step 3: Write the entry, the launcher, the Dockerfile and compose lines**

`chmod +x docker/canopy` before `git add`, so git records 100755. Build the images to prove the Dockerfile parses: `docker build --target shells -t canopy-shells:plan1 . && docker build -t canopy-backend:plan1 .` (on the Mac with Docker, else on the mini through `ssh mini-host` in the synced checkout, without starting anything), and `docker run --rm canopy-backend:plan1 ls -l /app/dist/canopy-mcp.js /home/bun/.local/bin/canopy`.

- [ ] **Step 4: Write the deploy doc**

`docs/deploy.md` "What runs where", the "Shells and runs" bullet: one sentence that the shells container's `canopy` is a launcher for `canopy mcp` alone, running the bundle the canopy service copies to `/config/bin/canopy-mcp.js` at each start, and that the full CLI is not there. "The kit" (line 1166): one sentence that `canopy` is a server the kit knows and writes for Claude and Codex on the Mac and the mini, with no manifest entry needed, and that the first deploy of this change recreates the shells container (the launcher is in its image), so `redeploy` stops with exit 3 until it runs with `--shells`, as the MCP paragraph at line 1222 describes.

- [ ] **Step 5: Run the tests and the gates**

Run: `bun test src/cli/mcp.test.ts && bun run typecheck && bun run lint && bun run build`
Expected: PASS, clean, built. `bin/` is in lint's path.

- [ ] **Step 6: Commit**

```bash
git add bin/canopy-mcp.ts docker/canopy Dockerfile docker-compose.yml docs/deploy.md src/cli/mcp.test.ts
git commit -m "feat(deploy): canopy mcp runs in the shells container off a bundle on the config volume"
```

---

### Task 6: the ranger's paragraph

**Files:**
- Modify: `lib/ranger.md:8` (a "Tools" block after "Seeing the board", before "Changing a repo"), `src/server/ranger.test.ts:16` (import `BUNDLED_BRIEF`) and a test

**Interfaces:**
- Consumes: `BUNDLED_BRIEF` from `src/server/ranger.ts:45`.
- Produces: the bundled brief's Tools paragraph below, using the eight tool names from Tasks 1 and 2; `rangerBrief` and its slots keep their existing signatures.

The block, verbatim, inserted after line 8 of `lib/ranger.md` with a blank line on each side:

```
Tools:
- Your session has canopy's own tools, from the `canopy` MCP server (`canopy mcp`, started with your token): `canopy_status` (every repo: branch, ahead and behind, changed files, its live run), `canopy_runs` (the runs, or one by id with its last steps), `canopy_queue` (the landing queues), `canopy_health` (the checks, the bad ones first), `canopy_say` (a message to a running run), `canopy_wake` (a wake, as below), `canopy_land` and `canopy_pr` (a ready branch run into its queue, or a PR for it: only when Eric asks, as with any git chore). Prefer a tool to a curl line when one covers the call; the curl lines stay for the rest, starting a run among them. A tool answers in words, and an error is the API's own.
```

No new `{{slot}}`: `rangerBrief` is unchanged. The ranger's `claude` is interactive without yolo (`rangerArgv`, `src/core/ranger.ts:197`), so its first call of a tool asks in its pane the way a curl POST does; nothing here pre-allows one.

- [ ] **Step 1: Write the failing test in `src/server/ranger.test.ts`**

```ts
test("the bundled brief names the canopy tools (FR-038, plan 1)", async () => {
  const brief = await readFile(BUNDLED_BRIEF, "utf8");
  for (const t of ["canopy_status", "canopy_runs", "canopy_queue", "canopy_health", "canopy_say", "canopy_wake", "canopy_land", "canopy_pr"]) expect(brief).toContain(`\`${t}\``);
  expect(brief).toContain("`canopy mcp`");
  expect(brief.indexOf("Tools:")).toBeGreaterThan(brief.indexOf("Seeing the board"));
  expect(brief.indexOf("Tools:")).toBeLessThan(brief.indexOf("Changing a repo:"));
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test src/server/ranger.test.ts -t "bundled brief"`
Expected: FAIL, the brief has no `Tools:`.

- [ ] **Step 3: Add the block**

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test src/server/ranger.test.ts src/core/ranger.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/ranger.md src/server/ranger.test.ts
git commit -m "feat(ranger): the brief names canopy's tools and when to use a curl line instead"
```

---

### Task 7: the docs and the gates

**Files:**
- Modify: `docs/architecture.md:97` (the ranger paragraph), `:212` (the kit's phase 2 paragraph), `:393` (after the paragraph on where tokens reach a child), `SPEC.md:23`, `:51`, `:57`, `:80`, `README.md:381`, `FEATURES.md:45-48` and `:128`, `docs/superpowers/plans/README.md:8`

**Interfaces:**
- Consumes: the completed interfaces from Tasks 1 to 6, the source spec, and the live-check results.
- Produces: documentation and feature status that describe the implemented scope, with later phases still marked open. No new runtime interface.

- [ ] **Step 1: `docs/architecture.md`**

After line 393, a paragraph starting "canopy's own MCP server (FR-038, plan 1)." saying: `core/canopymcp.ts` is the pure half (the tool table with a right per tool, `toolsFor` through `allows`, the folders, `handleMessage` over `codexrpc.ts`'s `parseMessage` and `LineSplitter`, `serve`), `cli/mcp.ts` the process (`canopy mcp`: `CANOPY_API`, `CANOPY_TOKEN` first then the CLI's token order, one `GET /api/auth` for `you`, stdin and stdout; `canopy mcp tools`); the eight tools and their rights; that a shell's or the ranger's session gets the tools with its own token through the kit's `canopy` entry, which `withCanopyServer` adds to every manifest read on the machines a backend runs on; that in compose the shells container's `canopy` is a launcher for the bundle the canopy service copies to `/config/bin/canopy-mcp.js` at start; and that the `run` kind, `LANES`, `runs/child`, `mcp.json`, Codex's `-c` lines and `lib/canopy-tools.md` are plans 2 and 3. At line 212, one sentence: `canopy` is a server the kit knows without a manifest entry (`canopyServer`, `withCanopyServer` in `core/kit.ts`, folded in by the hub's read). At line 97, one sentence: the brief's "Tools" block names `canopy mcp`'s tools and keeps the curl lines for what they do not cover.

- [ ] **Step 2: `SPEC.md`**

Line 23: after "drive it through the CLI and the HTTP API", add "and through `canopy mcp`, an MCP server over that API with the token the session holds". Line 51: after the `shells` service's words, that the shells image carries one launcher, `canopy`, for `canopy mcp`. Line 57: add `bin/canopy-mcp.js` ("in compose only: canopy's MCP server as one file, copied there by the canopy service at each start for the shells container's `canopy` launcher") to the config dir list. After line 80, the decision: "2026-10-26: canopy's MCP server is four methods of JSON-RPC over stdio written by hand in `core/canopymcp.ts`, not the MCP SDK, because the repo already frames line JSON for Codex and a dependency for four methods would be the only one in the server's path; its tools are the API's own routes under the caller's own token, never a second rights model."

- [ ] **Step 3: `README.md`**

Line 381, after "Shells and the ranger carry their own token as `$CANOPY_TOKEN`.", one sentence: `canopy mcp` turns that token into tools for the agent in the shell (`claude mcp add canopy -- canopy mcp`, or the kit, which writes it on every backend machine), and the tools it lists are the ones the token's rights allow.

- [ ] **Step 4: `FEATURES.md` and the plans README**

Move the `### FR-038` block from `## Open` to the top of `## In Progress` and append to its Spec line: `Plan 1 shipped <date> (canopy mcp with the eight tools, the kit's canopy entry, the shells container's launcher, the ranger's paragraph); plan 2 (run tokens, LANES, runs/child, the pre-flight toggle, mcp.json) and plan 3 (Codex's -c lines, lib/canopy-tools.md, the board chip) open.` In `docs/superpowers/plans/README.md`, add the row `| [Agent surface, plan 1: canopy mcp for shells and the ranger](2026-10-26-agent-surface-1.md) | shipped | <date> | [agent surface](../specs/2026-10-25-agent-surface-design.md) |` above the scenario gates row, and set this plan's Status line to shipped with the merge commit.

- [ ] **Step 5: Run every gate**

Run: `bun run typecheck && bun run lint && bun test && bun run build`
Expected: all pass. Then `~/.claude/skills/verify-build/clean-rebuild.sh verify "canopy mcp"` proves the served help text is the new build.

- [ ] **Step 6: Commit**

```bash
git add docs/architecture.md SPEC.md README.md FEATURES.md docs/superpowers/plans/README.md docs/superpowers/plans/2026-10-26-agent-surface-1.md
git commit -m "docs(mcp): architecture, SPEC, README and the feature list for plan 1"
```

---

## Live check, before the branch is called done

On the Mac, with the launchd backend on :7850 and `bun link` done:

1. In a canopy shell at any repo: `canopy mcp tools` prints `tools for a shell token on http://127.0.0.1:7850` (with no CLI token file in the way, since the shell's `CANOPY_TOKEN` wins) and eight lines.
2. `claude mcp add canopy -- canopy mcp` in that shell, then `claude`: `/mcp` shows `canopy` connected with eight tools; "what is in the landing queue" calls `canopy_queue` and answers in the fold's words; "land run x" with a bad id calls `canopy_land` and the reply is the API's error text.
3. `canopy kit` shows `canopy` as `missing` for claude and codex on `mac`; `canopy kit apply` writes it; `claude mcp get canopy` prints `canopy mcp` with no env.
4. The ranger's pane, after `canopy ranger restart`: `/mcp` lists `canopy`; "what repos are dirty" calls `canopy_status` after the pane's permission ask is answered.

On the mini, after `bun run redeploy --shells` (the launcher changes the shells image once):

5. In a canopy shell: `canopy mcp tools` answers through `/config/bin/canopy-mcp.js`; `canopy status` prints the launcher's refusal.
6. `canopy kit apply --machine mini` writes the entry; the ranger's `/mcp` on the mini lists `canopy`.

## Decisions this plan makes beyond the spec

- No MCP SDK. The spec names no library and the subset is `initialize`, `ping`, `tools/list` and `tools/call` over newline-delimited JSON-RPC, which `core/codexrpc.ts` already frames; a dependency would be the only one in the server's path. The protocol versions the server knows are `2025-06-18`, `2025-03-26` and `2024-11-05`, and it answers with the client's when known.
- `canopy mcp` takes `CANOPY_TOKEN` from its environment before the CLI's token file, the reverse of `callerToken`'s order. The spec's "Where things stand" records that the CLI's admin token wins today; a server that exists to act with the token it was handed must not be outranked by a file on the same machine, and plan 2's run token depends on it.
- `canopy_say` and `canopy_wake` carry the right `plan` as the spec's table says, although `runs/say` and `ranger/wakes` need `operate` in the route table today; a coordinator token is shown both and the route refuses it, and no plan-only caller starts `canopy mcp` in plan 1. Plan 2 refiles the two routes for the `run` kind.
- `canopy_wake` takes `cron` and `run` beside `when`, since the route reads all three and the ranger's brief sets wakes all three ways; it sends `by: "eric"` for every kind but `ranger`, as `canopy ranger wake` does.
- `canopy_run_start` and `canopy_work_note` are left to plan 2 and FR-037: their routes (`POST /api/runs/child`, `POST /api/work/note`) do not exist, and wiring `canopy_run_start` to `POST /api/repos/run` would be a tool the spec did not draw. Starting a run stays a curl line in the ranger's brief until plan 2.
- The kit learns `canopy` in `core/kit.ts` (`withCanopyServer`, applied by the hub's read), not in `kitscan.ts` as the spec's words say: the scan reads machines, and servers come from the manifest, so a built-in server belongs beside `parseKit`. Its `machines` are the manifest's machines with a `backend`, not every machine, since an ssh-only machine such as gpd has no canopy to run.
- The shells container has no canopy code (`Dockerfile`, the `shells` stage), which the spec did not see. Rather than leave the mini's shells and ranger without the tools, the shells image gains a launcher `canopy` that runs `canopy mcp` alone off a bundle the canopy service copies to the config volume at each start. The launcher never changes, so the shells container is recreated once; the full CLI in that container is a follow-up, not this plan's.
- `canopy mcp` exits 1 at start when the backend does not answer `GET /api/auth`, rather than serving the read tools blind: Claude then shows the server as failed and a reconnect retries, and no tool is listed that cannot answer.
- `initialize` carries a short `instructions` text (`INSTRUCTIONS`), which MCP allows and the spec does not mention, so a session reads the rule about rights and `json` once.
