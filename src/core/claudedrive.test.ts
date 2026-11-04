import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudeDriver, claudeAccounting, cliArgs, parseQuestions, permissionAsk, toolPaths } from "./claudedrive";
import { BUILTIN_MENTIONS, builtinMentions, noteCliCommands } from "./mentions";
import type { RpcSpawn } from "./codexrpc";
import { providerFile } from "./store";
import { DEFAULT_AGENT, type RunStep } from "./types";
import { replayWire } from "./wirereplay";
import { WIRE_TICK } from "./runlog";
import { RunCtx, type DriveRun } from "./driver";
import { STAGE_AWAY } from "./stagewire";

/* The ClaudeDriver against a stand-in `claude` (testdata/fake-claude.ts),
 * with the Runner's half played by RunCtx, the way codexrun.test.ts drives
 * the Codex driver. The end-to-end Runner path with the real binary lookup
 * is runner.test.ts's. */

const FAKE = join(import.meta.dir, "testdata", "fake-claude.ts");
const AGENT = { model: "default", effort: "default", yolo: false, extra: "" };
const AGENT_YOLO = { ...AGENT, yolo: true };
const scratch: string[] = [];
afterAll(async () => {
  for (const d of scratch) await rm(d, { recursive: true, force: true });
});

async function drive(
  mode: "job" | "chat" | "die" | "limited" | "limitdie" | "ratelimited" | "async" | "bgshell" | "quiet" | "stray" | "subtodo" | "woke" | "lost" | "notifyonly" | "crash" | "two" | "propose" | "hang" | "latenudge",
  message = "do the thing",
  unattended?: string,
  opts: {
    chat?: boolean;
    spawn?: RpcSpawn;
    onWire?: (run: DriveRun, line: string) => void;
    heldGraceMs?: number;
    requestMs?: number;
    agent?: typeof AGENT;
    env?: Record<string, string>;
    emit?: (run: DriveRun) => void;
  } = {},
) {
  const dir = await mkdtemp(join(tmpdir(), "canopy-claude-"));
  scratch.push(dir);
  const repo = join(dir, "repo");
  await mkdir(repo);
  const logPath = join(dir, "log.jsonl");
  const chat = opts.chat ?? mode === "chat";
  const run: DriveRun = {
    id: "r1",
    repoId: "repo",
    action: chat ? "chat" : "ask",
    verb: chat ? "chat" : "ask",
    progress: "working",
    expectsChange: false,
    chat,
    harness: "claude",
    note: "",
    status: "working",
    startedAt: Date.now(),
    steps: [],
    prompt: null,
  };
  const wire: [string, string][] = [];
  /** when each wire line came, as the run log would stamp it */
  const stamps: number[] = [];
  const ended: string[] = [];
  const ctx = new RunCtx(
    run,
    {
      cwd: repo,
      agent: opts.agent ?? AGENT,
      spec: {
        allowedTools: ["Read"],
        maxTurns: 10,
        ...(unattended ? { unattended } : {}),
        // a propose run starts in plan mode, which is what adds the launch flag a bypass needs
        ...(mode === "propose" ? { permissionMode: "plan" as const } : {}),
      },
      env: { CANOPY_RUN: "r1", FAKE_CLAUDE_MODE: mode, FAKE_CLAUDE_LOG: logPath, ...opts.env },
      label: "Claude Code",
      wire: (d, l) => {
        wire.push([d, l]);
        stamps.push(Date.now());
        if (d === "out") opts.onWire?.(run, l);
      },
    },
    { emit: opts.emit ?? (() => {}), ended: (r) => ended.push(r.status) },
  );
  const driver = new ClaudeDriver({
    command: [process.execPath, FAKE],
    ...(opts.spawn ? { spawn: opts.spawn } : {}),
    ...(opts.heldGraceMs !== undefined ? { heldGraceMs: opts.heldGraceMs } : {}),
    ...(opts.requestMs !== undefined ? { requestMs: opts.requestMs } : {}),
  });
  expect(driver.check()).toBeNull();
  driver.start(ctx, message);
  const until = async (pred: (r: DriveRun) => boolean, what: string, ms = 8_000): Promise<DriveRun> => {
    const deadline = Date.now() + ms;
    while (!pred(run)) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}; run is ${run.status} ${run.error ?? ""}`);
      await Bun.sleep(10);
    }
    return run;
  };
  const sent = async (): Promise<Record<string, unknown>[]> =>
    (await readFile(logPath, "utf8").catch(() => ""))
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
  const done = (r: DriveRun) => r.status === "done" || r.status === "failed" || r.status === "limited" || r.status === "stopped";
  return { run, ctx, driver, until, sent, done, ended, wire, stamps };
}

const responseTo = (log: Record<string, unknown>[], id: string) =>
  log.find((m) => m["type"] === "control_response" && (m["response"] as { request_id?: string }).request_id === id) as
    | { response: { subtype: string; response: { behavior: string; message?: string; updatedInput?: unknown } } }
    | undefined;

describe("toolPaths", () => {
  test("file tools, a Bash line, reads", () => {
    expect(toolPaths("Edit", { file_path: "/r/src/a.ts" }, "/r")).toEqual({ paths: ["src/a.ts"] });
    expect(toolPaths("Write", { file_path: "docs/x.md" }, "/r")).toEqual({ paths: ["docs/x.md"] });
    expect(toolPaths("MultiEdit", { file_path: "/r/a.ts", edits: [] }, "/r")).toEqual({ paths: ["a.ts"] });
    expect(toolPaths("NotebookEdit", { notebook_path: "/r/n.ipynb" }, "/r")).toEqual({ paths: ["n.ipynb"] });
    expect(toolPaths("Edit", { file_path: "/etc/hosts" }, "/r")).toEqual({ paths: ["/etc/hosts"] });
    expect(toolPaths("Bash", { command: "git mv src/a src/b && touch c.ts" }, "/r")).toEqual({ paths: ["c.ts", "src/a/", "src/b/"] });
    expect(toolPaths("Bash", { command: "sh -c 'rm x'" }, "/r")).toEqual({ touchesUnknown: true });
    expect(toolPaths("Read", { file_path: "/r/a.ts" }, "/r")).toEqual({});
  });
});

test("Claude accounting reads cumulative per-model usage, including cached input", () => {
  expect(
    claudeAccounting({
      modelUsage: {
        "provider-alias": {
          canonicalModel: "claude-sonnet-5",
          provider: "firstParty",
          inputTokens: 10,
          cacheReadInputTokens: 20,
          cacheCreationInputTokens: 30,
          outputTokens: 5,
          costUSD: 0.02,
        },
      },
    }),
  ).toEqual({
    model: "claude-sonnet-5",
    provider: "anthropic",
    tokens: { input: 60, cachedInput: 20, output: 5, reasoning: 0, total: 65 },
  });
});

test("cliArgs adds one --add-dir per extra folder", () => {
  const args = cliArgs({ allowedTools: [], maxTurns: 5, addDirs: ["/x", "/y z"] });
  const at = args.indexOf("--add-dir");
  expect(args.slice(at, at + 4)).toEqual(["--add-dir", "/x", "--add-dir", "/y z"]);
  expect(cliArgs({ allowedTools: [], maxTurns: 5 })).not.toContain("--add-dir");
});

test("cliArgs: a fork adds --fork-session after --resume, and nothing without a session to resume (FR-043 plan 3)", () => {
  const args = cliArgs({ allowedTools: [], maxTurns: 5, resume: "sess-1", fork: true });
  const at = args.indexOf("--resume");
  expect(args.slice(at, at + 3)).toEqual(["--resume", "sess-1", "--fork-session"]);
  expect(cliArgs({ allowedTools: [], maxTurns: 5, resume: "sess-1" })).not.toContain("--fork-session");
  expect(cliArgs({ allowedTools: [], maxTurns: 5, fork: true })).not.toContain("--fork-session");
});

test("cliArgs starts in plan mode when the spec says, whatever yolo says", () => {
  const args = cliArgs({ allowedTools: [], maxTurns: 5, permissionMode: "plan" }, { ...DEFAULT_AGENT, yolo: true });
  expect(args[args.indexOf("--permission-mode") + 1]).toBe("plan");
});

test("cliArgs: a plan-mode run on a yolo agent may switch to bypass later", () => {
  const yolo = cliArgs({ allowedTools: [], maxTurns: 5, permissionMode: "plan" }, { ...DEFAULT_AGENT, yolo: true });
  expect(yolo).toContain("--allow-dangerously-skip-permissions");
  expect(cliArgs({ allowedTools: [], maxTurns: 5, permissionMode: "plan" }, { ...DEFAULT_AGENT, yolo: false })).not.toContain("--allow-dangerously-skip-permissions");
  expect(cliArgs({ allowedTools: [], maxTurns: 5 }, { ...DEFAULT_AGENT, yolo: true })).not.toContain("--allow-dangerously-skip-permissions");
});

/** canopy's own control requests in the fake's log, in the order sent */
const modesAsked = (log: Record<string, unknown>[]) =>
  log.filter((m) => m["type"] === "control_request").map((m) => (m["request"] as { mode?: string }).mode);

describe("the plan's usage limit (FR-036)", () => {
  const LIMIT = "You've hit your limit · resets 3pm";
  test("a job whose result is the limit ends limited with the text", async () => {
    const d = await drive("limited");
    const run = await d.until(d.done, "the limit");
    expect([run.status, run.error, run.limited?.text, run.result?.costUsd]).toEqual(["limited", LIMIT, LIMIT, 0]);
    expect(d.ended).toEqual(["limited"]);
  });
  test("a chat's limited reply goes idle and is said in the timeline; the second in a row fails the run", async () => {
    const d = await drive("limited", "hello", undefined, { chat: true });
    await d.until((r) => r.status === "idle", "the first reply");
    expect(d.run.steps.filter((s) => s.kind === "note").map((s) => s.text)).toEqual([`the plan's usage limit: ${LIMIT}`]);
    d.run.status = "working";
    d.driver.say("again");
    const run = await d.until(d.done, "the second reply");
    expect([run.status, run.error]).toEqual(["failed", LIMIT]);
    // The fake is still up: a chat's failure kills nothing here, the Runner would.
    d.driver.stop();
  });
  test("a CLI that exits with the limit on stderr ends limited", async () => {
    const d = await drive("limitdie");
    const run = await d.until(d.done, "the exit");
    expect([run.status, run.error]).toEqual(["limited", LIMIT]);
  });
  test("the rate_limit_event's refusal puts the exact reset and window on the mark (plan 2)", async () => {
    const d = await drive("ratelimited");
    const run = await d.until(d.done, "the limit");
    expect([run.status, run.limited?.text, run.limited?.resetsAt, run.limited?.window]).toEqual(["limited", LIMIT, 1793026800 * 1000, "fiveHour"]);
  });
  test("a limit with no refusal event carries the text alone", async () => {
    const d = await drive("limited");
    const run = await d.until(d.done, "the limit");
    expect([run.limited?.resetsAt, run.limited?.window]).toEqual([undefined, undefined]);
  });
});

describe("a propose run: ExitPlanMode is a proposal", () => {
  test("approve allows first, then sets acceptEdits (spec P8)", async () => {
    const d = await drive("propose");
    const w = await d.until((r) => r.prompt?.kind === "proposal", "the proposal");
    expect(w.prompt).toMatchObject({ kind: "proposal", plan: "# Plan\n1. add it", auto: false });
    expect(w.proposal).toBe("# Plan\n1. add it");
    // auto refused: not yolo
    d.ctx.answer(w.prompt?.id ?? "", { kind: "approve", auto: true });
    const run = await d.until(d.done, "the end");
    expect(run.status).toBe("done");
    expect(run.result?.text).toBe("approved");
    const log = await d.sent();
    const modeAt = log.findIndex((m) => m["type"] === "control_request" && (m["request"] as { subtype?: string }).subtype === "set_permission_mode");
    const allowAt = log.findIndex((m) => m["type"] === "control_response" && (m["response"] as { request_id?: string }).request_id === "req-p1");
    expect(modeAt).toBeGreaterThan(-1);
    expect(modesAsked(log)).toEqual(["acceptEdits"]);
    // the allow resets the session to default, so the switch must come after it
    expect(allowAt).toBeGreaterThan(-1);
    expect(allowAt).toBeLessThan(modeAt);
    expect(responseTo(log, "req-p1")?.response.response).toEqual({ behavior: "allow", updatedInput: { plan: "# Plan\n1. add it" } });
    // the yolo launch flag is for a yolo agent only
    expect((log[0] as { argv: string[] }).argv).not.toContain("--allow-dangerously-skip-permissions");
    expect(run.steps.some((s) => s.kind === "note" && s.text?.startsWith("could not"))).toBe(false);
  });

  test("approve on a yolo agent with auto runs on its own", async () => {
    const d = await drive("propose", "build it", undefined, { agent: AGENT_YOLO });
    const w = await d.until((r) => r.prompt?.kind === "proposal", "the proposal");
    expect(w.prompt).toMatchObject({ auto: true });
    d.ctx.answer(w.prompt?.id ?? "", { kind: "approve", auto: true });
    const run = await d.until(d.done, "the end");
    expect(run.result?.text).toBe("approved");
    const log = await d.sent();
    expect(modesAsked(log)).toEqual(["bypassPermissions"]);
    const argv = (log[0] as { argv: string[] }).argv;
    expect(argv).toContain("--allow-dangerously-skip-permissions");
    expect(argv[argv.indexOf("--permission-mode") + 1]).toBe("plan");
  });

  test("approve without auto on a yolo agent asks before commands", async () => {
    const d = await drive("propose", "build it", undefined, { agent: AGENT_YOLO });
    const w = await d.until((r) => r.prompt?.kind === "proposal", "the proposal");
    d.ctx.answer(w.prompt?.id ?? "", { kind: "approve", auto: false });
    await d.until(d.done, "the end");
    expect(modesAsked(await d.sent())).toEqual(["acceptEdits"]);
  });

  test("a refused bypass falls back to acceptEdits, with a note", async () => {
    const d = await drive("propose", "build it", undefined, { agent: AGENT_YOLO, env: { FAKE_CLAUDE_REFUSE_BYPASS: "1" } });
    const w = await d.until((r) => r.prompt?.kind === "proposal", "the proposal");
    d.ctx.answer(w.prompt?.id ?? "", { kind: "approve", auto: true });
    const run = await d.until(d.done, "the end");
    expect(run.result?.text).toBe("approved");
    expect(modesAsked(await d.sent())).toEqual(["bypassPermissions", "acceptEdits"]);
    expect(run.steps.some((s) => s.kind === "note" && s.text?.startsWith("could not run on its own"))).toBe(true);
    expect(run.steps.some((s) => s.kind === "note" && s.text?.startsWith("could not switch"))).toBe(false);
  });

  test("revise sends the note back and the next proposal replaces the last", async () => {
    const d = await drive("propose");
    const w = await d.until((r) => r.prompt?.kind === "proposal", "the proposal");
    // until() hands back the live run, so the first id is kept by value
    const first = w.prompt?.id ?? "";
    d.ctx.answer(first, { kind: "deny", message: "add a test step" });
    const w2 = await d.until((r) => r.prompt?.kind === "proposal" && r.prompt.id !== first, "the second proposal");
    expect(w2.proposal).toContain("Plan v2");
    expect(w2.proposalState).toBe("waiting");
    const log = await d.sent();
    expect(responseTo(log, "req-p1")?.response.response).toEqual({ behavior: "deny", message: "add a test step" });
    expect(modesAsked(log)).toEqual([]);
    d.ctx.stopping = true;
    d.ctx.denyAll();
    d.driver.stop();
    await d.until(d.done, "the end");
  });

  test("turning the plan down denies it with the default words", async () => {
    const d = await drive("propose");
    const w = await d.until((r) => r.prompt?.kind === "proposal", "the proposal");
    const first = w.prompt?.id ?? "";
    d.ctx.answer(first, { kind: "deny" });
    const w2 = await d.until((r) => r.prompt?.kind === "proposal" && r.prompt.id !== first, "the second proposal");
    d.ctx.answer(w2.prompt?.id ?? "", { kind: "deny" });
    const run = await d.until(d.done, "the end");
    expect(run.result?.text).toBe("declined");
    const log = await d.sent();
    expect(responseTo(log, "req-p2")?.response.response).toEqual({
      behavior: "deny",
      message: "The user turned the plan down. Stop here and summarize what you found.",
    });
    expect(modesAsked(log)).toEqual([]);
  });

  test("a refused mode switch still approves, with a note", async () => {
    const d = await drive("propose", "build it", undefined, { env: { FAKE_CLAUDE_REFUSE_MODE: "1" } });
    const w = await d.until((r) => r.prompt?.kind === "proposal", "the proposal");
    d.ctx.answer(w.prompt?.id ?? "", { kind: "approve", auto: false });
    const run = await d.until(d.done, "the end");
    expect(run.result?.text).toBe("approved");
    expect(run.steps.some((s) => s.kind === "note" && s.text === "could not switch to acceptEdits (refused); every edit will ask")).toBe(true);
  });

  test("a mode switch with no answer still approves, with a note, once the wait is over", async () => {
    const d = await drive("propose", "build it", undefined, { requestMs: 50, env: { FAKE_CLAUDE_SILENT_MODE: "wait" } });
    const w = await d.until((r) => r.prompt?.kind === "proposal", "the proposal");
    d.ctx.answer(w.prompt?.id ?? "", { kind: "approve", auto: false });
    const run = await d.until(d.done, "the end");
    expect(run.status).toBe("done");
    expect(run.result?.text).toBe("approved");
    expect(run.steps.some((s) => s.kind === "note" && s.text === "could not switch to acceptEdits (no answer); every edit will ask")).toBe(true);
  });

  test("a result while canopy's own request waits keeps stdin open, and a late timeout leaves no note on the ended run", async () => {
    const d = await drive("propose", "build it", undefined, { requestMs: 300, env: { FAKE_CLAUDE_SILENT_MODE: "now" } });
    const w = await d.until((r) => r.prompt?.kind === "proposal", "the proposal");
    d.ctx.answer(w.prompt?.id ?? "", { kind: "approve", auto: false });
    const run = await d.until(d.done, "the end");
    expect(run.result?.text).toBe("approved");
    const endedAt = Date.now();
    let log = await d.sent();
    for (let i = 0; i < 100 && !log.some((m) => m["eof"]); i++) {
      await Bun.sleep(20);
      log = await d.sent();
    }
    // stdin closed only once the request gave up, not on the result
    expect(log.some((m) => m["eof"])).toBe(true);
    expect(Date.now() - endedAt).toBeGreaterThan(150);
    expect(modesAsked(log)).toEqual(["acceptEdits"]);
    expect(run.steps.some((s) => s.kind === "note" && s.text?.startsWith("could not"))).toBe(false);
  });

  test("a mode switch whose follow-up throws still lets stdin close", async () => {
    const d = await drive("propose", "build it", undefined, {
      env: { FAKE_CLAUDE_REFUSE_MODE: "1" },
      // the note the refused switch leaves fails to broadcast
      emit: (r) => {
        if (r.steps.at(-1)?.text?.startsWith("could not switch")) throw new Error("emit failed");
      },
    });
    const w = await d.until((r) => r.prompt?.kind === "proposal", "the proposal");
    d.ctx.answer(w.prompt?.id ?? "", { kind: "approve", auto: false });
    await d.until(d.done, "the end");
    let log = await d.sent();
    for (let i = 0; i < 50 && !log.some((m) => m["eof"]); i++) {
      await Bun.sleep(20);
      log = await d.sent();
    }
    expect(log.some((m) => m["eof"])).toBe(true);
  });

  test("an empty plan is sent back without asking anyone", async () => {
    const d = await drive("propose", "build it", undefined, { env: { FAKE_CLAUDE_EMPTY_PLAN: "1" } });
    const run = await d.until(d.done, "the end");
    expect(run.prompt).toBeNull();
    expect(run.proposal).toBeUndefined();
    const log = await d.sent();
    expect(responseTo(log, "req-p1")?.response.response.message).toBe("The plan came through empty. Present it again with ExitPlanMode.");
  });

  test("a stop while the proposal waits denies it and ends the run stopped", async () => {
    const d = await drive("propose");
    await d.until((r) => r.prompt?.kind === "proposal", "the proposal");
    // the Runner's stop() while a turn runs
    d.ctx.stopping = true;
    d.ctx.denyAll();
    d.driver.stop();
    const run = await d.until(d.done, "the end");
    expect(run.status).toBe("stopped");
    expect(run.steps.some((s) => s.text === "turned the plan down")).toBe(true);
  });
});

describe("a Claude run through the driver", () => {
  test("steps, prompts through the shared queue, a withdrawn prompt, the session, the cost and the env", async () => {
    const d = await drive("job");
    const waiting = await d.until((r) => r.status === "waiting", "the prompt");
    // the second request was taken back by the CLI: it settled as a deny
    // before anyone saw it, and the first one is what shows
    expect(waiting.prompt).toMatchObject({ id: "p1", kind: "permission", tool: "Bash", title: "git push", detail: "git push" });
    await d.until((r) => r.steps.some((s) => s.text === "denied: rm x"), "the withdrawn prompt's note");
    d.ctx.answer("p1", { kind: "allow" });
    const run = await d.until(d.done, "the end");
    expect(run.status).toBe("done");
    expect(d.ended).toEqual(["done"]);
    // the first message's session is the run's
    expect(run.session).toBe("sess-1");
    // what the process was given reaches the result: CANOPY_RUN
    expect(run.result).toEqual({ text: "env:r1", costUsd: 0.12, durationMs: 5, turns: 2 });
    expect(run.steps.map((s) => (s.kind === "tool" ? `tool:${s.tool?.title}:${s.tool?.status}:${s.tool?.output}` : `${s.kind}:${s.text}`))).toEqual([
      "text:Looking.",
      "tool:git status:ok:clean",
      "tool:write src/a.ts:ok:written",
      "note:denied: rm x",
      "note:allowed: git push",
    ]);
    expect(run.steps.find((s) => s.tool?.name === "Write")?.tool?.paths).toEqual(["src/a.ts"]);
    expect(run.steps.find((s) => s.tool?.name === "Bash")?.tool?.paths).toBeUndefined();
    let log = await d.sent();
    for (let i = 0; i < 100 && !log.some((m) => m["eof"]); i++) {
      await Bun.sleep(20);
      log = await d.sent();
    }
    // a job's stdin closes after the result, so the CLI exits
    expect(log.some((m) => m["eof"])).toBe(true);
    expect(responseTo(log, "req-1")?.response.response).toEqual({ behavior: "allow", updatedInput: { command: "git push" } });
    expect(responseTo(log, "req-2")?.response.response.behavior).toBe("deny");
    const argv = (log[0] as { argv: string[] }).argv;
    expect(argv.slice(0, 2)).toEqual(["-p", "--output-format"]);
    expect(argv).toContain("--allowedTools");
    const first = log.find((m) => m["type"] === "user") as { message: { content: string } };
    expect(first.message.content).toBe("do the thing");
  });

  test("an unattended run answers a permission with a deny carrying its message, and never waits", async () => {
    const d = await drive("job", "do the thing", "No one answers this run. Finish within your tools.");
    const run = await d.until(d.done, "the end");
    expect(run.status).toBe("done");
    let log = await d.sent();
    for (let i = 0; i < 100 && !responseTo(log, "req-1"); i++) {
      await Bun.sleep(20);
      log = await d.sent();
    }
    expect(responseTo(log, "req-1")?.response.response).toEqual({ behavior: "deny", message: "No one answers this run. Finish within your tools." });
  });

  test("a chat goes idle after each reply, takes the next message on the same process, and ends politely", async () => {
    const d = await drive("chat", "hello");
    await d.until((r) => r.status === "idle", "the first reply");
    expect(d.run.result).toMatchObject({ text: "reply 1", costUsd: 0.01 });
    d.run.status = "working";
    d.driver.say("again");
    await d.until((r) => r.status === "idle" && r.result?.text === "reply 2", "the second reply");
    // the Runner's stop() on an idle chat
    d.ctx.ending = true;
    d.driver.stop();
    const run = await d.until(d.done, "the end");
    expect(run.status).toBe("done");
    const users = (await d.sent()).filter((m) => m["type"] === "user").map((m) => (m["message"] as { content: string }).content);
    expect(users).toEqual(["hello", "again"]);
  });

  test("a CLI that dies before its result fails the run in the words it always had", async () => {
    const d = await drive("die");
    const run = await d.until(d.done, "the failure");
    expect(run.status).toBe("failed");
    expect(run.error).toBe("Claude Code exited (code 3) without a result: boom");
  });

  test("a stop while a prompt waits denies it and kills the CLI: the run is stopped", async () => {
    const d = await drive("job");
    await d.until((r) => r.status === "waiting", "the prompt");
    // the Runner's stop() while a turn runs
    d.ctx.stopping = true;
    d.ctx.denyAll();
    d.driver.stop();
    const run = await d.until(d.done, "the stop");
    expect(run.status).toBe("stopped");
    expect(run.error).toBeUndefined();
    expect(run.steps.some((s) => s.text === "denied: git push")).toBe(true);
  });

  test("a result while a background subagent runs is held: stdin stays open, the prompt is answered, the real result ends the run", async () => {
    const d = await drive("async");
    const waiting = await d.until((r) => r.status === "waiting", "the subagent's prompt");
    expect(waiting.result).toBeUndefined();
    d.ctx.answer(waiting.prompt?.id ?? "", { kind: "allow" });
    const run = await d.until(d.done, "the end");
    expect(run.status).toBe("done");
    expect(run.result?.text).toBe("final");
    const log = await d.sent();
    // the fake logged the answer, so stdin was still open when it was sent
    expect(log.some((m) => m["type"] === "control_response" && (m["response"] as { request_id?: string }).request_id === "req-a")).toBe(true);
  });

  test("a held result's turns count toward the real one's, and the time runs from the start", async () => {
    const d = await drive("async");
    const waiting = await d.until((r) => r.status === "waiting", "the subagent's prompt");
    await Bun.sleep(120);
    d.ctx.answer(waiting.prompt?.id ?? "", { kind: "allow" });
    const run = await d.until(d.done, "the end");
    // the early result's 1 turn and the woken turn's 3; the cost is the
    // CLI's running total already, so it is the last result's alone
    expect(run.result?.turns).toBe(4);
    expect(run.result?.durationMs).toBeGreaterThanOrEqual(120);
    expect(run.result?.costUsd).toBe(0.05);
  });

  test("a result nothing held keeps the CLI's own turns and time", async () => {
    const run = await (await drive("bgshell")).until((r) => r.status === "done", "the end");
    expect(run.result?.turns).toBe(1);
    expect(run.result?.durationMs).toBe(1);
  });

  test("a chat holds the early result too: no idle and no denied prompt while the subagent runs", async () => {
    const d = await drive("async", "do the thing", undefined, { chat: true });
    const waiting = await d.until((r) => r.status === "waiting", "the subagent's prompt");
    expect(waiting.result).toBeUndefined();
    d.ctx.answer(waiting.prompt?.id ?? "", { kind: "allow" });
    await d.until((r) => r.status === "idle" && r.result?.text === "final", "the reply's end");
    // the Runner's stop() on an idle chat, so the fake does not outlive the test
    d.ctx.ending = true;
    d.driver.stop();
    await d.until(d.done, "the end");
  });

  test("a background shell never holds a result", async () => {
    const run = await (await drive("bgshell")).until((r) => r.status === "done", "the end");
    expect(run.result?.text).toBe("server up");
  });

  test("subagents done and no further result: the held one ends the run after the grace", async () => {
    const d = await drive("quiet", "do the thing", undefined, { heldGraceMs: 50 });
    const waiting = await d.until((r) => r.status === "waiting", "the subagent's prompt");
    d.ctx.answer(waiting.prompt?.id ?? "", { kind: "allow" });
    const run = await d.until(d.done, "the end");
    expect(run.status).toBe("done");
    expect(run.result?.text).toBe("early");
  });

  test("a stray subagent message after the subagents are done is not a new turn: the grace still ends the run", async () => {
    const d = await drive("stray", "do the thing", undefined, { heldGraceMs: 50 });
    const waiting = await d.until((r) => r.status === "waiting", "the subagent's prompt");
    d.ctx.answer(waiting.prompt?.id ?? "", { kind: "allow" });
    const run = await d.until(d.done, "the end", 2_000);
    expect(run.status).toBe("done");
    expect(run.result?.text).toBe("early");
    expect(run.steps.some((s) => s.text === "late word")).toBe(true);
  });

  test("a held result waits out the turn the subagents woke, however long its prompt waits", async () => {
    const d = await drive("woke", "do the thing", undefined, { heldGraceMs: 50 });
    const first = await d.until((r) => r.status === "waiting", "the subagent's prompt");
    d.ctx.answer(first.prompt?.id ?? "", { kind: "allow" });
    await d.until((r) => r.status === "waiting" && r.prompt?.kind === "permission" && r.prompt.title === "bun test", "the main thread's prompt");
    // far past the grace: the woken turn is still the run's, not over
    await Bun.sleep(300);
    expect(d.run.status).toBe("waiting");
    expect(d.run.result).toBeUndefined();
    d.ctx.answer(d.run.prompt?.id ?? "", { kind: "allow" });
    const run = await d.until(d.done, "the end");
    expect(run.status).toBe("done");
    expect(run.result?.text).toBe("final");
  });

  test("a CLI that dies while a result is held fails the run: the early result is not a success", async () => {
    const d = await drive("crash");
    const run = await d.until(d.done, "the end");
    expect(run.status).toBe("failed");
    expect(run.error).toBe("Claude Code exited (code 7) while a subagent ran: subagent lost");
  });

  for (const mode of ["lost", "notifyonly"] as const) {
    test(`a subagent whose end says only ${mode === "lost" ? "the task list" : "its notification"} still lets the real result end the run`, async () => {
      const d = await drive(mode);
      const waiting = await d.until((r) => r.status === "waiting", "the subagent's prompt");
      expect(waiting.result).toBeUndefined();
      d.ctx.answer(waiting.prompt?.id ?? "", { kind: "allow" });
      const run = await d.until(d.done, "the end");
      expect(run.status).toBe("done");
      expect(run.result?.text).toBe("final");
    });
  }

  test("two subagents: a result while the second still runs is held too", async () => {
    const d = await drive("two");
    const waiting = await d.until((r) => r.status === "waiting", "the second subagent's prompt");
    expect(waiting.result).toBeUndefined();
    expect(waiting.steps.some((s) => s.text === "One back.")).toBe(true);
    d.ctx.answer(waiting.prompt?.id ?? "", { kind: "allow" });
    const run = await d.until(d.done, "the end");
    expect(run.status).toBe("done");
    expect(run.result?.text).toBe("final");
  });

  test("a stop while a result is held for a subagent ends the run stopped, not done", async () => {
    const d = await drive("async");
    await d.until((r) => r.status === "waiting", "the subagent's prompt");
    d.ctx.stopping = true;
    d.ctx.denyAll();
    d.driver.stop();
    const run = await d.until(d.done, "the stop");
    expect(run.status).toBe("stopped");
    expect(run.result).toBeUndefined();
  });

  test("check() names a missing binary before a run exists", () => {
    const why = new ClaudeDriver().check();
    expect(why === null || why.includes("claude CLI is not on PATH")).toBe(true);
  });
});

describe("a permission's input", () => {
  test("keeps the model's description of a Bash call and the command itself", () => {
    expect(permissionAsk("Bash", { command: "ls -la src", description: "List the source folder" }, "/r")).toEqual({
      kind: "permission",
      tool: "Bash",
      title: "ls -la src",
      detail: "ls -la src",
      description: "List the source folder",
      command: "ls -la src",
    });
  });

  test("names the file a file tool touches, made absolute", () => {
    expect(permissionAsk("Write", { file_path: "/r/a.ts", content: "x" }, "/r").paths).toEqual(["/r/a.ts"]);
    expect(permissionAsk("Grep", { pattern: "x", path: "src" }, "/r").paths).toEqual(["/r/src"]);
    // a home path is the home folder, not a folder named ~ in the project
    expect(permissionAsk("Read", { file_path: "~/.ssh/id_rsa" }, "/r").paths).toEqual([join(homedir(), ".ssh/id_rsa")]);
    expect(permissionAsk("Read", { file_path: "~" }, "/r").paths).toEqual([homedir()]);
    expect(permissionAsk("Read", { file_path: "../x/../y" }, "/r/a").paths).toEqual(["/r/y"]);
    const web = permissionAsk("WebFetch", { url: "https://a.com", prompt: "read" }, "/r");
    expect(web.paths).toBeUndefined();
    expect(web.description).toBeUndefined();
    expect(web.command).toBeUndefined();
  });
});

describe("AskUserQuestion input", () => {
  test("becomes the questions the browser renders; anything malformed is left out", () => {
    expect(
      parseQuestions({
        questions: [
          { question: "Which?", header: "Pick", options: [{ label: "a", description: "A" }, { nope: 1 }], multiSelect: true },
          { question: "No options", options: [] },
          "junk",
        ],
      }),
    ).toEqual([{ question: "Which?", header: "Pick", options: [{ label: "a", description: "A" }], multiSelect: true }]);
    expect(parseQuestions({})).toEqual([]);
  });
});

test("a stage run reads the user's settings only, never the seed's .claude/", () => {
  const args = cliArgs({ allowedTools: [], maxTurns: 5 }, DEFAULT_AGENT, true);
  expect(args[args.indexOf("--setting-sources") + 1]).toBe("user");
  const plain = cliArgs({ allowedTools: [], maxTurns: 5 }, DEFAULT_AGENT);
  expect(plain[plain.indexOf("--setting-sources") + 1]).toBe("user,project,local");
});

describe("a stage run through the stage runner's spawn", () => {
  test("waits for stderr before the exit, so the runner's away line reaches the error", async () => {
    const run: DriveRun = {
      id: "r1", repoId: "_incubator/coin", action: "ask", verb: "ask", progress: "working", expectsChange: false,
      chat: false, harness: "claude", note: "", status: "working", startedAt: Date.now(), steps: [], prompt: null,
    };
    const enc = new TextEncoder();
    // exited and stdout settle at once; the away line lands on stderr a beat later
    const spawn: RpcSpawn = () => ({
      stdin: { write: () => undefined, flush: () => undefined, end: () => undefined },
      stdout: new ReadableStream<Uint8Array>({ start: (c) => c.close() }),
      stderr: new ReadableStream<Uint8Array>({
        start: (c) => {
          setTimeout(() => {
            c.enqueue(enc.encode(`${STAGE_AWAY}: connect ENOENT\n`));
            c.close();
          }, 50);
        },
      }),
      exited: Promise.resolve(127),
      kill: () => undefined,
    });
    const ctx = new RunCtx(
      run,
      { cwd: "/w/_incubator/coin", agent: AGENT, spec: { allowedTools: [], maxTurns: 10 }, stage: true, spawn, label: "Claude Code" },
      { emit: () => {} },
    );
    new ClaudeDriver().start(ctx, "go");
    const deadline = Date.now() + 3_000;
    while (run.status === "working" && Date.now() < deadline) await Bun.sleep(5);
    expect(run.status).toBe("failed");
    expect(run.error).toContain(STAGE_AWAY);
  });
});

test("the checklist follows TaskCreate and TaskUpdate", async () => {
  const d = await drive("propose");
  const w = await d.until((r) => (r.todos?.length ?? 0) > 0, "the first todo");
  expect(w.todos).toEqual([{ id: "1", subject: "Read the code", status: "pending", active: "Reading the code" }]);
  const asked = await d.until((r) => r.prompt?.kind === "proposal", "the proposal");
  d.ctx.answer(asked.prompt?.id ?? "", { kind: "approve", auto: false });
  const run = await d.until(d.done, "the end");
  expect(run.todos?.[0]?.status).toBe("completed");
});

test("a subagent's own TaskCreate never reaches the checklist", async () => {
  const d = await drive("subtodo");
  const w = await d.until((r) => r.status === "waiting", "the subagent's prompt");
  const made = w.steps.find((s) => s.tool?.name === "TaskCreate");
  expect(made?.parent).toBe(w.steps.find((s) => s.tool?.name === "Agent")?.id);
  expect(made?.tool?.status).toBe("ok");
  expect(w.todos).toBeUndefined();
  d.ctx.answer(w.prompt?.id ?? "", { kind: "allow" });
  const run = await d.until(d.done, "the end");
  expect(run.todos).toBeUndefined();
});

test("a subagent's steps carry their Agent step as parent", async () => {
  const d = await drive("async");
  const w = await d.until((r) => r.status === "waiting", "the prompt");
  const agentStep = w.steps.find((s) => s.tool?.name === "Agent");
  const child = w.steps.find((s) => s.tool?.name === "Bash");
  expect(agentStep).toBeDefined();
  expect(child?.parent).toBe(agentStep?.id);
  expect(agentStep?.parent).toBeUndefined();
  d.ctx.answer(w.prompt?.id ?? "", { kind: "allow" });
  await d.until(d.done, "the end");
});

test("the init's slash commands say which built-ins the CLI has", async () => {
  const d = await drive("chat", "hello");
  await d.until((r) => r.status === "idle", "the first reply");
  const names = builtinMentions().map((w) => w.name);
  expect(names).toContain("compact");
  expect(names).not.toContain("security-review");
  d.ctx.ending = true;
  d.driver.stop();
  noteCliCommands("claude", BUILTIN_MENTIONS.map((w) => w.name));
});

test("wire records real fake-driver input counts and stdout before folding", async () => {
  const h = await drive("job");
  await h.until((r) => r.status === "waiting", "permission");
  h.ctx.answer("p1", { kind: "allow" });
  await h.until(h.done, "end");
  const ins = h.wire.filter(([d]) => d === "in").map(([, l]): unknown => JSON.parse(l));
  const out = h.wire.filter(([d]) => d === "out").map(([, l]): unknown => JSON.parse(l));
  expect(ins[0]).toMatchObject({ type: "user" });
  expect(ins.some((m: unknown) => typeof m === "object" && m !== null && "type" in m && m.type === "control_response")).toBe(true);
  expect(out[0]).toMatchObject({ type: "system", subtype: "init" });
  expect(out.at(-1)).toMatchObject({ type: "result" });
  const logged = (await h.sent()).filter((m) => !("argv" in m) && !("eof" in m));
  expect(ins.length).toBe(logged.length);
  expect(ins).toEqual(logged);
});

test("wire includes non-JSON stdout and a final unterminated result", async () => {
  const enc = new TextEncoder();
  const result = JSON.stringify({ type: "result", subtype: "success", result: "tail é", num_turns: 1 });
  const beforeFold: [string | undefined, string | undefined][] = [];
  const h = await drive("job", "hello", undefined, {
    onWire: (run) => { beforeFold.push([run.session, run.result?.text]); },
    spawn: () => ({
    stdin: { write() {}, end() {} },
    stdout: new ReadableStream({ start(c) {
      c.enqueue(enc.encode('  chatter  \n{"type":"system","subtype":"init","session_id":"tail-session"}\n' + result));
      c.close();
    } }),
    exited: Promise.resolve(0), kill() {},
  }) });
  await h.until(h.done, "final flush");
  expect(h.wire.filter(([d]) => d === "out").map(([, l]) => l)).toEqual([
    "chatter", '{"type":"system","subtype":"init","session_id":"tail-session"}', result,
  ]);
  expect(beforeFold).toEqual([[undefined, undefined], [undefined, undefined], ["tail-session", undefined]]);
  expect(h.run.status).toBe("done");
  expect(h.run.session).toBe("tail-session");
  expect(h.run.result?.text).toBe("tail é");
});

test("cliArgs passes a Claude provider as this machine's settings file, except to a stage", () => {
  const spec = { allowedTools: [], maxTurns: 5 };
  const args = cliArgs(spec, { ...DEFAULT_AGENT, provider: "local" });
  const at = args.indexOf("--settings");
  expect(args.slice(at, at + 2)).toEqual(["--settings", providerFile("local")]);
  expect(cliArgs(spec, DEFAULT_AGENT)).not.toContain("--settings");
  // a stage runs in a container that has no canopy config dir
  expect(cliArgs(spec, { ...DEFAULT_AGENT, provider: "local" }, true)).not.toContain("--settings");
});

describe("the stall watchdog's message", () => {
  test("a nudge goes down stdin into the job's turn, which then ends; none once the run is over", async () => {
    const d = await drive("hang");
    await d.until((r) => r.steps.some((s) => s.kind === "text" && s.text === "looking"), "the first word");
    expect(d.driver.holding()).toBe(false);
    expect(d.driver.nudge("wrap up now")).toBe(true);
    const run = await d.until(d.done, "the end");
    expect(run.status).toBe("done");
    expect(run.result?.text).toBe("wrapped up");
    const users = (await d.sent()).filter((m) => m["type"] === "user");
    expect(users.map((m) => (m["message"] as { content: string }).content).at(-1)).toBe("wrap up now");
    expect(d.driver.nudge("again")).toBe(false);
  });

  test("a nudge the turn outran is not a second turn: the CLI is stopped the moment it starts one", async () => {
    const d = await drive("latenudge");
    await d.until((r) => r.steps.some((s) => s.kind === "text" && s.text === "looking"), "the first word");
    expect(d.driver.nudge("wrap up now")).toBe(true);
    const run = await d.until(d.done, "the end");
    expect([run.status, run.result?.text]).toEqual(["done", "on my own"]);
    // the fake takes the queued message as a new turn once its own ends;
    // the driver kills it on that turn's first word
    const deadline = Date.now() + 4_000;
    while (!(await d.sent()).some((m) => m["signal"] === "SIGTERM")) {
      if (Date.now() > deadline) throw new Error("the CLI was not stopped");
      await Bun.sleep(10);
    }
    expect(run.result?.text).toBe("on my own");
    expect(run.steps.some((s) => s.kind === "text" && s.text === "second")).toBe(false);
    expect(d.ended).toEqual(["done"]);
  });

  test("a result held for a background subagent is holding, and a chat takes no nudge", async () => {
    const d = await drive("quiet");
    await d.until(() => d.driver.holding(), "the held result");
    d.driver.stop();
    await d.until(d.done, "the stop");
    const chat = await drive("chat");
    await chat.until((r) => r.status === "idle", "the first reply");
    expect(chat.driver.nudge("hello")).toBe(false);
    chat.driver.stop();
  });
});

/* ---------- plan 2's reducer, on the wire a live run recorded ---------- */

describe("foldClaude replays the recorded wire into the steps the live run made", () => {
  type Harness = Awaited<ReturnType<typeof drive>>;
  /** the run's wire as the run log keeps it: canopy's start line, each in
   *  line stamped, the out lines as read with a tick before one that came
   *  after a quiet spell */
  const kept = (h: Harness): string[] => {
    let last = h.run.startedAt;
    const lines = [JSON.stringify({ canopy: "start", at: last, run: h.run.id, repo: h.run.repoId, action: h.run.action, harness: "claude", argv: [] })];
    h.wire.forEach(([d, l], i) => {
      const at = h.stamps[i] ?? last;
      if (d === "in") lines.push(JSON.stringify({ canopy: "in", at, line: l }));
      else if (at - last >= WIRE_TICK) lines.push(JSON.stringify({ canopy: "tick", at }), l);
      else lines.push(l);
      if (d === "in" || at - last >= WIRE_TICK) last = at;
    });
    return lines;
  };
  /** what a step shows, with a parent named by its place among the work steps */
  const shape = (steps: readonly RunStep[]) => {
    const work = steps.filter((s) => s.kind === "text" || s.kind === "tool");
    const place = new Map(work.map((s, i) => [s.id, i]));
    return work.map((s) => ({ kind: s.kind, text: s.text, tool: s.tool, parent: s.parent === undefined ? undefined : place.get(s.parent) }));
  };
  const check = (h: Harness) => {
    const rebuilt = replayWire(kept(h), { ...h.run, steps: [] }, { cwd: h.ctx.cwd, home: homedir() });
    expect(rebuilt.source).toBe("wire");
    expect(shape(rebuilt.steps)).toEqual(shape(h.run.steps));
    // with the record whole, its own steps stand and the wire places the asks
    const record = replayWire(kept(h), h.run, { cwd: h.ctx.cwd, home: homedir() });
    expect(record.source).toBe("record");
    expect(record.steps.filter((s) => !record.asks.includes(s.id))).toEqual(h.run.steps);
    return { rebuilt, record };
  };

  test("a job with two prompts, one taken back", async () => {
    const h = await drive("job");
    const w = await h.until((r) => r.status === "waiting", "the prompt");
    h.ctx.answer(w.prompt?.id ?? "", { kind: "allow" });
    await h.until(h.done, "the end");
    const { rebuilt, record } = check(h);
    const words = (steps: readonly RunStep[]) => steps.filter((s) => s.kind === "note").map((s) => s.text);
    // the wire's asks and answers in the live notes' words; the cancel settles as a deny
    expect(words(rebuilt.steps)).toEqual(["asked: git push", "asked: rm x", "denied: rm x", "allowed: git push"]);
    // placed in the record after the step the CLI asked after, before the notes that answered them
    expect(words(record.steps)).toEqual(["asked: git push", "asked: rm x", ...words(h.run.steps)]);
    expect(record.steps.map((s) => s.kind).slice(0, 5)).toEqual(["text", "tool", "tool", "note", "note"]);
  });

  test("a chat of two messages", async () => {
    const h = await drive("chat", "hello");
    await h.until((r) => r.status === "idle", "the first reply");
    h.run.status = "working";
    h.ctx.step({ kind: "user", text: "again" });
    h.driver.say("again");
    await h.until((r) => r.status === "idle" && r.result?.text === "reply 2", "the second reply");
    h.ctx.ending = true;
    h.driver.stop();
    await h.until(h.done, "the end");
    const { rebuilt } = check(h);
    expect(rebuilt.steps.filter((s) => s.kind !== "note").map((s) => [s.kind, s.text])).toEqual([["text", "reply 1"], ["user", "again"], ["text", "reply 2"]]);
  });

  test("a subagent's steps under its Agent call, and its own checklist", async () => {
    const h = await drive("subtodo");
    const w = await h.until((r) => r.status === "waiting", "the subagent's prompt");
    h.ctx.answer(w.prompt?.id ?? "", { kind: "allow" });
    await h.until(h.done, "the end");
    const { rebuilt } = check(h);
    expect(rebuilt.steps.some((s) => s.parent !== undefined)).toBe(true);
  });

  test("a plan sent back with words, then approved", async () => {
    const h = await drive("propose");
    const w = await h.until((r) => r.prompt?.kind === "proposal", "the proposal");
    const first = w.prompt?.id ?? "";
    h.ctx.answer(first, { kind: "deny", message: "add a test step" });
    const w2 = await h.until((r) => r.prompt?.kind === "proposal" && r.prompt.id !== first, "the second proposal");
    h.ctx.answer(w2.prompt?.id ?? "", { kind: "approve", auto: false });
    await h.until(h.done, "the end");
    const { rebuilt } = check(h);
    expect(rebuilt.steps.filter((s) => s.kind === "note").map((s) => s.text)).toEqual([
      "asked: the plan", "sent the plan back: add a test step", "asked: the plan", "approved the plan, asking before commands",
    ]);
  });
});

test("a run with canopy's tools: the file by path, then one rule list that names them", () => {
  const spec = { allowedTools: ["Read", "Grep"], maxTurns: 5, mcpConfig: "/c/runs/r1/mcp.json" };
  const args = cliArgs(spec);
  const at = args.indexOf("--mcp-config");
  expect(args[at + 1]).toBe("/c/runs/r1/mcp.json");
  // the flag is variadic, so what follows must be a flag
  expect(args[at + 2]).toBe("--allowedTools");
  expect(args[at + 3]).toBe("Read,Grep,mcp__canopy__*");
  expect(args.filter((a) => a === "--allowedTools")).toHaveLength(1);
  expect(args).toContain("--strict-mcp-config");
});

test("with no tools the command line is as it was, even when the settings ask for them", () => {
  const args = cliArgs({ allowedTools: ["Read"], maxTurns: 5 }, { ...DEFAULT_AGENT, canopyTools: true });
  expect(args).not.toContain("--mcp-config");
  expect(args[args.indexOf("--allowedTools") + 1]).toBe("Read");
});

test("a run with tools and no rules of its own still names them", () => {
  const args = cliArgs({ allowedTools: [], maxTurns: 5, mcpConfig: "/m.json" });
  expect(args[args.indexOf("--mcp-config") + 2]).toBe("--allowedTools");
  expect(args[args.indexOf("--allowedTools") + 1]).toBe("mcp__canopy__*");
});

test("canopy's own tool call folds into a step like any other (probe P1)", async () => {
  const d = await drive("canopytool");
  const run = await d.until(d.done, "the end");
  expect(run.status).toBe("done");
  expect(run.steps.find((s) => s.tool?.name === "mcp__canopy__canopy_status")?.tool).toMatchObject({ status: "ok", output: "app  main" });
});
