import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acpPermissionPrompt, acpResult, acpFold, acpTurn, foldAcp, tokensOf } from "./acpfold";
import { AntigravityDriver, antigravityArgs } from "./antigravity";
import { RunCtx, type DriveAgent, type DriveRun, type FoldOut } from "./driver";
import { HARNESS } from "./harness";
import type { RunStep } from "./types";

const AGENT: DriveAgent = { model: "default", effort: "default", yolo: false, extra: "" };

/* ---------- the command line and the fold, against agy 1.5.15's shapes ---------- */

describe("the agy command line", () => {
  test("ask mode passes no permission flag; yolo skips them; dirs ride as --add-dir", () => {
    expect(antigravityArgs({}, { yolo: false })).toEqual(["acp"]);
    expect(antigravityArgs({ addDirs: ["/a", "/b"] }, { yolo: true })).toEqual(["acp", "--dangerously-skip-permissions", "--add-dir", "/a", "--add-dir", "/b"]);
  });

  test("a shell takes agy's own --model, --effort and --conversation, and no --mode in ask", () => {
    const h = HARNESS.antigravity;
    expect(h.permissionArgs(false)).toEqual([]);
    expect(h.permissionArgs(true)).toEqual(["--dangerously-skip-permissions"]);
    expect(h.modelArgs("gemini-4-neon-high")).toEqual(["--model", "gemini-4-neon-high"]);
    expect(h.effortArgs("xhigh")).toEqual(["--effort", "xhigh"]);
    expect(h.resume([], "abc")).toEqual(["--conversation", "abc"]);
  });
});

describe("agy's wire in the fold", () => {
  const out = (steps: RunStep[]): FoldOut => ({
    step(step) {
      const full = { ...step, id: String(steps.length + 1), at: 0 };
      steps.push(full);
      return full;
    },
    changed() {},
    note() {},
    todos() {},
    result() {},
  });
  const call = {
    toolCallId: "call_1",
    name: "run_command",
    kind: "execute",
    title: "echo canopy-probe",
    rawInput: { CommandLine: "echo canopy-probe", WaitMsBeforeAsync: 5000, toolSummary: "Echo command" },
  };

  test("run_command is a Bash step, and a denied command's reason shows from rawOutput", () => {
    const state = acpFold("/repo");
    const steps: RunStep[] = [];
    acpTurn(state, 0);
    foldAcp(state, "session/update", { update: { sessionUpdate: "tool_call", ...call, status: "in_progress" } }, out(steps), 1);
    foldAcp(state, "session/update", { update: { sessionUpdate: "tool_call_update", ...call, status: "failed", rawOutput: "permission check failed: user denied permission" } }, out(steps), 2);
    expect(steps).toHaveLength(1);
    expect(steps[0]?.tool).toMatchObject({ name: "Bash", title: "echo canopy-probe", status: "error", output: "permission check failed: user denied permission" });
  });

  test("the permission prompt names agy's CommandLine as the command", () => {
    const prompt = acpPermissionPrompt({ toolCall: { ...call, status: "pending" }, options: [] }, "/repo");
    expect(prompt).toMatchObject({ kind: "permission", tool: "Bash", title: "echo canopy-probe", command: "echo canopy-probe", detail: "echo canopy-probe" });
  });

  test("a prompt for anything but a command still shows agy's input as JSON", () => {
    const edit = { toolCallId: "call_2", name: "write_to_file", kind: "edit", title: "File NOTES.md", rawInput: { TargetFile: "/repo/NOTES.md", CodeContent: "hi" } };
    const prompt = acpPermissionPrompt({ toolCall: { ...edit, status: "pending" }, options: [] }, "/repo");
    expect(prompt.kind === "permission" ? prompt.detail : "").toContain('"TargetFile": "/repo/NOTES.md"');
  });

  test("a finished command's output is rawOutput's output field", () => {
    const state = acpFold("/repo");
    const steps: RunStep[] = [];
    acpTurn(state, 0);
    foldAcp(state, "session/update", { update: { sessionUpdate: "tool_call_update", ...call, status: "completed", rawOutput: { output: "Command output:\ncanopy-probe\r\n", exit_code: 0 } } }, out(steps), 1);
    expect(steps[0]?.tool).toMatchObject({ status: "ok", output: "Command output:\ncanopy-probe" });
  });

  test("tokens come from the prompt response's usage: cache reads into input, thoughts inside output", () => {
    expect(tokensOf({ inputTokens: 11416, outputTokens: 49, cachedReadTokens: 7197, cachedWriteTokens: 0, totalTokens: 18662 }))
      .toEqual({ input: 18613, cachedInput: 7197, output: 49, reasoning: 0, total: 18662 });
    const usage = { inputTokens: 9246, outputTokens: 187, cachedReadTokens: 0, cachedWriteTokens: 0, thoughtTokens: 150, totalTokens: 9433 };
    expect(tokensOf(usage)).toEqual({ input: 9246, cachedInput: 0, output: 187, reasoning: 150, total: 9433 });
    const state = acpFold("/repo");
    acpTurn(state, 0);
    expect(acpResult(state, { stopReason: "end_turn", usage }, null, 5).result.tokens?.total).toBe(9433);
  });

  test("a chat's tokens add up over its turns, since agy counts each prompt alone", () => {
    const state = acpFold("/repo");
    acpTurn(state, 0);
    acpResult(state, { stopReason: "end_turn", usage: { inputTokens: 8600, outputTokens: 36, thoughtTokens: 29, totalTokens: 8636 } }, null, 1);
    acpTurn(state, 2);
    const second = acpResult(state, { stopReason: "end_turn", usage: { inputTokens: 8700, outputTokens: 50, cachedReadTokens: 100, totalTokens: 8850 } }, null, 3).result;
    expect(second.tokens).toEqual({ input: 17400, cachedInput: 100, output: 86, reasoning: 29, total: 17486 });
    acpTurn(state, 4);
    expect(acpResult(state, { stopReason: "end_turn" }, null, 5).result.tokens?.total).toBe(17486);
  });
});

/* ---------- the driver against the stand-in ---------- */

const FAKE = join(import.meta.dir, "testdata", "fake-agy-acp.ts");
const scratch: string[] = [];
afterAll(async () => {
  for (const d of scratch) await rm(d, { recursive: true, force: true });
});

type Step = Record<string, unknown>;
interface Scenario {
  auth?: boolean;
  loadSession?: boolean;
  ignoreCancel?: boolean;
  turns?: Step[][];
}

async function drive(scenario: Scenario, opts: { chat?: boolean; agent?: Partial<DriveAgent>; resume?: string; graceMs?: number } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "canopy-agy-"));
  scratch.push(dir);
  const repo = join(dir, "repo");
  await mkdir(repo);
  const scenarioPath = join(dir, "scenario.json");
  const logPath = join(dir, "log.jsonl");
  await writeFile(scenarioPath, JSON.stringify(scenario));
  const chat = opts.chat ?? false;
  const run: DriveRun = {
    id: "r1",
    repoId: "repo",
    action: chat ? "chat" : "ask",
    verb: chat ? "chat" : "ask",
    progress: "working",
    expectsChange: false,
    chat,
    note: "",
    status: "working",
    startedAt: Date.now(),
    steps: [],
    prompt: null,
    harness: "antigravity",
  };
  const ctx = new RunCtx(
    run,
    {
      cwd: repo,
      agent: { ...AGENT, ...opts.agent },
      spec: { allowedTools: [], maxTurns: 10, ...(opts.resume ? { resume: opts.resume } : {}) },
      env: { FAKE_AGY_SCENARIO: scenarioPath, FAKE_AGY_LOG: logPath },
      label: "Antigravity",
      wire: () => {},
    },
    { emit: () => {} },
  );
  const driver = new AntigravityDriver({ command: [process.execPath, FAKE], graceMs: opts.graceMs ?? 3_000 });
  driver.start(ctx, "do the thing");
  const until = async (pred: (r: DriveRun) => boolean, what: string, ms = 8_000): Promise<DriveRun> => {
    const deadline = Date.now() + ms;
    while (!pred(run)) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}; run is ${run.status}: ${JSON.stringify(run.steps.slice(-3))} ${run.error ?? ""}`);
      await Bun.sleep(10);
    }
    return run;
  };
  const sent = async (): Promise<Record<string, unknown>[]> =>
    (await readFile(logPath, "utf8").catch(() => ""))
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
  const ended = (r: DriveRun) => r.status === "done" || r.status === "failed" || r.status === "limited" || r.status === "stopped";
  return { run, ctx, driver, until, sent, ended };
}

const requests = (log: Record<string, unknown>[], method: string) => log.filter((m) => m["method"] === method);
const replyTo = (log: Record<string, unknown>[], id: string) => log.find((m) => m["id"] === id && m["method"] === undefined) as { result?: unknown } | undefined;
const text = (t: string) => ({ update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: t } } });
const permission = (options = [{ optionId: "allow", name: "Allow", kind: "allow_once" }, { optionId: "deny", name: "Deny", kind: "reject_once" }]) => ({
  permission: {
    toolCall: { toolCallId: "c1", name: "run_command", kind: "execute", status: "pending", title: "git push", rawInput: { CommandLine: "git push" } },
    options,
  },
});

describe("an Antigravity run", () => {
  test("opens a session, sets the model and thinking level, and ends a job on the turn's answer", async () => {
    const usage = { inputTokens: 100, outputTokens: 20, thoughtTokens: 5, totalTokens: 120 };
    const d = await drive({ turns: [[text("Hel"), text("lo."), { stop: "end_turn", usage }]] }, { agent: { model: "gemini-4-neon", effort: "xhigh" } });
    const run = await d.until(d.ended, "the end");
    expect(run.status).toBe("done");
    expect(run.session).toBe("agy-1");
    expect(run.result).toMatchObject({ text: "Hello.", turns: 1, model: "gemini-4-neon", tokens: { input: 100, output: 20, reasoning: 5, total: 120 } });
    const log = await d.sent();
    expect(log[0]?.["argv"]).toEqual(["acp"]);
    expect(requests(log, "initialize")[0]?.["jsonrpc"]).toBe("2.0");
    expect(requests(log, "session/set_config_option").map((m) => m["params"])).toEqual([
      { sessionId: "agy-1", configId: "model", value: "gemini-4-neon" },
      { sessionId: "agy-1", configId: "thought_level", value: "xhigh" },
    ]);
  });

  test("a model id from agy models, level included, goes to the model option as it is", async () => {
    const d = await drive({}, { agent: { model: "gemini-4-neon-high" } });
    const run = await d.until(d.ended, "the end");
    expect(run.status).toBe("done");
    expect(requests(await d.sent(), "session/set_config_option")[0]?.["params"]).toMatchObject({ configId: "model", value: "gemini-4-neon-high" });
  });

  test("a model agy does not offer fails the run in words before any prompt", async () => {
    const d = await drive({}, { agent: { model: "gpt-x" } });
    const run = await d.until(d.ended, "the end");
    expect(run.status).toBe("failed");
    expect(run.error).toContain('does not offer model "gpt-x"');
    expect(requests(await d.sent(), "session/prompt")).toHaveLength(0);
  });

  test("signed out, the run says how to sign in", async () => {
    const d = await drive({ auth: false });
    const run = await d.until(d.ended, "the end");
    expect(run.status).toBe("failed");
    expect(run.error).toContain("agy acp --login");
  });

  test("allow goes back as allow_once, even after allow all", async () => {
    const d = await drive({ turns: [[permission(), text("pushed"), { stop: "end_turn" }]] });
    await d.until((r) => r.status === "waiting", "the prompt");
    expect(d.run.prompt).toMatchObject({ kind: "permission", tool: "Bash", command: "git push", detail: "git push" });
    d.ctx.answer("p1", { kind: "allow-all" });
    const run = await d.until(d.ended, "the end");
    expect(run.status).toBe("done");
    expect(replyTo(await d.sent(), "1")?.result).toEqual({ outcome: { outcome: "selected", optionId: "allow" } });
  });

  test("deny goes back as reject_once, and with no reject on offer as cancelled", async () => {
    const d = await drive({ turns: [[permission(), permission([{ optionId: "ok", name: "Allow", kind: "allow_once" }]), { stop: "end_turn" }]] });
    await d.until((r) => r.status === "waiting", "the first prompt");
    d.ctx.answer("p1", { kind: "deny" });
    await d.until((r) => r.status === "waiting" && r.prompt?.id === "p2", "the second prompt");
    d.ctx.answer("p2", { kind: "deny" });
    await d.until(d.ended, "the end");
    const log = await d.sent();
    expect(replyTo(log, "1")?.result).toEqual({ outcome: { outcome: "selected", optionId: "deny" } });
    expect(replyTo(log, "2")?.result).toEqual({ outcome: { outcome: "cancelled" } });
  });

  test("an interrupt sends session/cancel and the job ends interrupted", async () => {
    const d = await drive({ turns: [[text("working"), { waitCancel: true }]] });
    await d.until((r) => r.steps.some((s) => s.text === "working"), "the first text");
    expect(d.driver.interrupt()).toBe(true);
    const run = await d.until(d.ended, "the end");
    expect(requests(await d.sent(), "session/cancel")[0]?.["params"]).toEqual({ sessionId: "agy-1" });
    expect(run.error).toContain("interrupted");
  });

  test("an agent that ignores the cancel is killed after the grace and still ends interrupted", async () => {
    const d = await drive({ ignoreCancel: true, turns: [[text("working"), { waitCancel: true }]] }, { graceMs: 200 });
    await d.until((r) => r.steps.some((s) => s.text === "working"), "the first text");
    d.driver.interrupt();
    const run = await d.until(d.ended, "the end");
    expect(run.error).toContain("interrupted");
  });

  test("a chat keeps the session between turns", async () => {
    const d = await drive({ turns: [[text("one"), { stop: "end_turn" }], [text("two"), { stop: "end_turn" }]] }, { chat: true });
    await d.until((r) => r.status === "idle", "the first turn");
    d.driver.say("again");
    await d.until((r) => r.steps.some((s) => s.text === "two") && r.status === "idle", "the second turn");
    expect(requests(await d.sent(), "session/prompt").map((m) => (m["params"] as { prompt: { text: string }[] }).prompt[0]?.text)).toEqual(["do the thing", "again"]);
    d.driver.stop();
  });

  test("resume loads the session when agy offers session/load, and is refused when it does not", async () => {
    const ok = await drive({}, { resume: "agy-old" });
    expect((await ok.until(ok.ended, "the end")).status).toBe("done");
    expect(requests(await ok.sent(), "session/load")[0]?.["params"]).toMatchObject({ sessionId: "agy-old" });
    const no = await drive({ loadSession: false }, { resume: "agy-old" });
    expect((await no.until(no.ended, "the end")).error).toContain("does not advertise session/load");
  });

  test("extra flags and a provider are refused, not dropped", async () => {
    const extra = await drive({}, { agent: { extra: "--project x" } });
    expect((await extra.until(extra.ended, "the end")).error).toContain("does not support extra flags");
    const provider = await drive({}, { agent: { provider: "local" } });
    expect((await provider.until(provider.ended, "the end")).error).toContain("does not support a configured provider");
  });
});
