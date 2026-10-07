import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudeDriver, cliArgs, parseQuestions, permissionAsk } from "./claudedrive";
import type { RpcSpawn } from "./codexrpc";
import { DEFAULT_AGENT } from "./types";
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
  mode: "job" | "chat" | "die" | "async" | "bgshell" | "quiet" | "stray" | "subtodo" | "woke" | "lost" | "notifyonly" | "crash" | "two" | "propose",
  message = "do the thing",
  unattended?: string,
  opts: {
    chat?: boolean;
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
    },
    { emit: opts.emit ?? (() => {}), ended: (r) => ended.push(r.status) },
  );
  const driver = new ClaudeDriver({
    command: [process.execPath, FAKE],
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
  const done = (r: DriveRun) => r.status === "done" || r.status === "failed" || r.status === "stopped";
  return { run, ctx, driver, until, sent, done, ended };
}

const responseTo = (log: Record<string, unknown>[], id: string) =>
  log.find((m) => m["type"] === "control_response" && (m["response"] as { request_id?: string }).request_id === id) as
    | { response: { subtype: string; response: { behavior: string; message?: string; updatedInput?: unknown } } }
    | undefined;

test("cliArgs adds one --add-dir per extra folder", () => {
  const args = cliArgs({ allowedTools: [], maxTurns: 5, addDirs: ["/x", "/y z"] });
  const at = args.indexOf("--add-dir");
  expect(args.slice(at, at + 4)).toEqual(["--add-dir", "/x", "--add-dir", "/y z"]);
  expect(cliArgs({ allowedTools: [], maxTurns: 5 })).not.toContain("--add-dir");
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
      "note:denied: rm x",
      "note:allowed: git push",
    ]);
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
