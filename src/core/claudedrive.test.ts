import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudeDriver, cliArgs, parseQuestions } from "./claudedrive";
import { DEFAULT_AGENT } from "./types";
import { RunCtx, type DriveRun } from "./driver";

/* The ClaudeDriver against a stand-in `claude` (testdata/fake-claude.ts),
 * with the Runner's half played by RunCtx, the way codexrun.test.ts drives
 * the Codex driver. The end-to-end Runner path with the real binary lookup
 * is runner.test.ts's. */

const FAKE = join(import.meta.dir, "testdata", "fake-claude.ts");
const AGENT = { model: "default", effort: "default", yolo: false, extra: "" };
const scratch: string[] = [];
afterAll(async () => {
  for (const d of scratch) await rm(d, { recursive: true, force: true });
});

async function drive(mode: "job" | "chat" | "die", message = "do the thing") {
  const dir = await mkdtemp(join(tmpdir(), "canopy-claude-"));
  scratch.push(dir);
  const repo = join(dir, "repo");
  await mkdir(repo);
  const logPath = join(dir, "log.jsonl");
  const chat = mode === "chat";
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
      agent: AGENT,
      spec: { allowedTools: ["Read"], maxTurns: 10 },
      env: { CANOPY_RUN: "r1", FAKE_CLAUDE_MODE: mode, FAKE_CLAUDE_LOG: logPath },
      label: "Claude Code",
    },
    { emit: () => {}, ended: (r) => ended.push(r.status) },
  );
  const driver = new ClaudeDriver({ command: [process.execPath, FAKE] });
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

  test("check() names a missing binary before a run exists", () => {
    const why = new ClaudeDriver().check();
    expect(why === null || why.includes("claude CLI is not on PATH")).toBe(true);
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
