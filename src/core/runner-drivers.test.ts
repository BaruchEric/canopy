import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ACTIONS } from "./actions";
import { bunSpawn } from "./codexrpc";
import { CodexDriver } from "./codexrun";
import type { DriveCtx, RunDriver } from "./driver";
import { defaultDriver, Runner, runEnv, type RunnerOptions } from "./runner";
import { DEFAULT_AGENT, type Harness, type Repo, type RepoStatus, type Run } from "./types";

/* The Runner over its drivers: which driver a harness gets, what every run's
 * process is told, a chat's turn-taking and stops as the Runner drives them,
 * and a Codex job end to end against the stand-in app-server. The Claude
 * wire itself is claudedrive.test.ts's and runner.test.ts's. */

/** A driver that runs nothing: the test plays the harness through `ctx`. */
class FakeDriver implements RunDriver {
  readonly label: string;
  ctx: DriveCtx | null = null;
  started: string[] = [];
  said: string[] = [];
  stops = 0;
  constructor(
    readonly harness: Harness,
    private missing: string | null = null,
  ) {
    this.label = harness === "codex" ? "Codex" : "Claude Code";
  }
  check(): string | null {
    return this.missing;
  }
  start(ctx: DriveCtx, message: string): void {
    this.ctx = ctx;
    this.started.push(message);
  }
  say(text: string): void {
    this.said.push(text);
  }
  stop(): void {
    this.stops += 1;
  }
}

const repo = (id: string, path = `/tmp/${id}`): Repo => ({ id, name: id, path, group: "", source: "root", status: null });

const CHANGED: RepoStatus = {
  branch: "main",
  upstream: "origin/main",
  ahead: 1,
  behind: 0,
  files: [],
  lastCommit: { hash: "abc", subject: "x", at: 1 },
  user: null,
};

function setup(opts: RunnerOptions = {}) {
  const made: FakeDriver[] = [];
  const changes: Run[] = [];
  const runner = new Runner(
    { onChange: (r) => changes.push(structuredClone(r)), onGone: () => {}, status: async () => CHANGED },
    {
      driver: (h) => {
        const d = new FakeDriver(h);
        made.push(d);
        return d;
      },
      ...opts,
    },
  );
  const ctxOf = (i: number): DriveCtx => {
    const ctx = made[i]?.ctx;
    if (!ctx) throw new Error(`driver ${i} was never started`);
    return ctx;
  };
  return { runner, made, changes, ctxOf };
}

const flush = () => new Promise<void>((r) => setTimeout(r, 0));

describe("the driver a run gets", () => {
  test("by the settings' harness; the run says which, and its process is told which run, repo and backend it is", async () => {
    const { runner, made, ctxOf } = setup({ backend: "mini" });
    const a = runner.start(repo("a"), "ask", ACTIONS.ask, "do x", DEFAULT_AGENT);
    const b = runner.start(repo("b"), "ask", ACTIONS.ask, "do y", { ...DEFAULT_AGENT, harness: "codex", model: "gpt-5.5" });
    expect(made.map((d) => d.harness)).toEqual(["claude", "codex"]);
    expect([a.harness, b.harness]).toEqual(["claude", "codex"]);
    expect(ctxOf(1).env).toEqual({ CANOPY_RUN: b.id, CANOPY_REPO: "b", CANOPY_BACKEND: "mini" });
    expect(ctxOf(1).agent).toMatchObject({ model: "gpt-5.5" });
    // the first message is the framed prompt, the same for either harness
    expect(made[1]?.started[0]).toContain("Note from the user:\ndo y");
    expect(made[1]?.started[0]).toContain("/tmp/b");
    // a result ends the job, and the status read after it sets the outcome
    ctxOf(1).result({ text: "ok", durationMs: 1, turns: 1, tokens: { input: 5, cachedInput: 0, output: 2, reasoning: 0, total: 7 } }, null);
    expect(runner.get(b.id)?.status).toBe("done");
    await flush();
    expect(runner.get(b.id)?.outcome).toBe("changed");
    expect(runner.get(b.id)?.result?.costUsd).toBeUndefined();
  });

  test("a harness that cannot start here is refused in its own words before a run exists", () => {
    const runner = new Runner(
      { onChange: () => {}, onGone: () => {} },
      { driver: (h) => new FakeDriver(h, "the codex CLI is not on PATH; install Codex and sign in first") },
    );
    expect(() => runner.start(repo("a"), "ask", ACTIONS.ask, "x", { ...DEFAULT_AGENT, harness: "codex" })).toThrow(
      "the codex CLI is not on PATH",
    );
    expect(runner.list()).toEqual([]);
    expect(() => runner.start(repo("a"), "ask", ACTIONS.ask, " ", DEFAULT_AGENT)).toThrow("write what the agent should do first");
  });

  test("without a swap, claude gets the stream-json driver and codex the app-server one", () => {
    expect(defaultDriver("claude").label).toBe("Claude Code");
    expect(defaultDriver("codex", "1.2.3").label).toBe("Codex");
    expect(runEnv({ id: "r", repoId: "x" })).toEqual({ CANOPY_RUN: "r", CANOPY_REPO: "x" });
  });
});

describe("a chat through its driver", () => {
  test("opens idle; the first message starts the driver framed, later ones are its next turns", () => {
    const { runner, made, ctxOf } = setup();
    const run = runner.start(repo("a"), "chat", ACTIONS.chat, "", { ...DEFAULT_AGENT, harness: "codex" });
    expect(run.status).toBe("idle");
    expect(made[0]?.started).toEqual([]);
    runner.say(run.id, "hello");
    expect(made[0]?.started[0]?.endsWith("First message from the user:\nhello")).toBe(true);
    expect(run.status).toBe("working");
    expect(() => runner.say(run.id, "too soon")).toThrow("Codex is still replying");
    ctxOf(0).result({ text: "hi", durationMs: 1, turns: 1 }, null);
    expect(run.status).toBe("idle");
    runner.say(run.id, "more");
    expect(made[0]?.said).toEqual(["more"]);
    expect(run.steps.filter((s) => s.kind === "user").map((s) => s.text)).toEqual(["hello", "more"]);
    ctxOf(0).result({ text: "ok", durationMs: 1, turns: 2 }, null);
    // an idle chat that has its process ends politely: the exit after is its end
    runner.stop(run.id);
    expect(made[0]?.stops).toBe(1);
    ctxOf(0).exited({ code: 0, stderr: "" });
    expect(run.status).toBe("done");
  });

  test("a chat that never started its agent is simply done", () => {
    const { runner, made } = setup();
    const run = runner.start(repo("a"), "chat", ACTIONS.chat, "", DEFAULT_AGENT);
    runner.stop(run.id);
    expect(run.status).toBe("done");
    expect(made[0]?.stops).toBe(0);
  });

  test("a stop while a prompt waits denies it, then the exit is a stop", async () => {
    const { runner, made, ctxOf } = setup();
    const run = runner.start(repo("a"), "ask", ACTIONS.ask, "x", { ...DEFAULT_AGENT, harness: "codex" });
    const asked = ctxOf(0).ask({ kind: "permission", tool: "Bash", title: "git push", detail: "git push" }, "0");
    expect(run.status).toBe("waiting");
    expect(() => runner.answer(run.id, "nope", { kind: "allow" })).toThrow("no longer waiting");
    runner.stop(run.id);
    expect(await asked).toEqual({ kind: "deny" });
    expect(made[0]?.stops).toBe(1);
    ctxOf(0).exited({ code: null, stderr: "killed" });
    expect(run.status).toBe("stopped");
    expect(run.steps.at(-1)?.text).toBe("denied: git push");
  });

  test("the browser's answer reaches the prompt", async () => {
    const { runner, ctxOf } = setup();
    const run = runner.start(repo("a"), "ask", ACTIONS.ask, "x", DEFAULT_AGENT);
    const asked = ctxOf(0).ask({ kind: "permission", tool: "Bash", title: "ls", detail: "ls" }, "0");
    runner.answer(run.id, run.prompt?.id ?? "", { kind: "allow" });
    expect(await asked).toEqual({ kind: "allow" });
    expect(run.status).toBe("working");
  });
});

/* ---------- a Codex job through the Runner, against the stand-in app-server ---------- */

const FAKE = join(import.meta.dir, "testdata", "fake-codex-app-server.ts");
const scratch: string[] = [];
afterAll(async () => {
  for (const d of scratch) await rm(d, { recursive: true, force: true });
});

const command = (method: "item/started" | "item/completed", id: string, script: string) => ({
  notify: method,
  params: {
    threadId: "$THREAD",
    turnId: "$TURN",
    item: {
      type: "commandExecution",
      id,
      command: `/bin/sh -lc '${script}'`,
      status: method === "item/started" ? "inProgress" : "completed",
      aggregatedOutput: method === "item/started" ? null : " M a.ts\n",
      exitCode: method === "item/started" ? null : 0,
    },
  },
});
const approval = (id: string, script: string, reason?: string) => ({
  request: "item/commandExecution/requestApproval",
  params: {
    kind: "command",
    threadId: "$THREAD",
    turnId: "$TURN",
    itemId: id,
    command: `/bin/sh -lc '${script}'`,
    availableDecisions: ["accept", "cancel"],
    ...(reason ? { reason } : {}),
  },
});

describe("a Codex job through the Runner", () => {
  test("its rules answer a plain read by themselves, the rest parks; one note says commands leave the sandbox", async () => {
    const dir = await mkdtemp(join(tmpdir(), "canopy-runner-codex-"));
    scratch.push(dir);
    const path = join(dir, "repo");
    await mkdir(path);
    const scenarioPath = join(dir, "scenario.json");
    const logPath = join(dir, "log.jsonl");
    const escalate = "command failed; retry without sandbox?";
    await writeFile(
      scenarioPath,
      JSON.stringify({
        turns: [
          [
            command("item/started", "c1", "git status --short"),
            approval("c1", "git status --short", escalate),
            command("item/completed", "c1", "git status --short"),
            approval("c2", "git push", escalate),
            { notify: "item/completed", params: { threadId: "$THREAD", turnId: "$TURN", item: { type: "agentMessage", id: "m", text: "Status read; push declined.", phase: "final_answer" } } },
            {
              notify: "thread/tokenUsage/updated",
              params: {
                threadId: "$THREAD",
                turnId: "$TURN",
                tokenUsage: { total: { totalTokens: 30, inputTokens: 20, cachedInputTokens: 5, outputTokens: 10, reasoningOutputTokens: 2 } },
              },
            },
            { complete: "completed", durationMs: 42 },
          ],
        ],
      }),
    );
    const runner = new Runner(
      { onChange: () => {}, onGone: () => {}, status: async () => CHANGED },
      {
        backend: "mini",
        driver: (h) =>
          h === "codex"
            ? new CodexDriver({
                command: [process.execPath, FAKE],
                graceMs: 3_000,
                spawn: (argv, o) => bunSpawn(argv, { ...o, env: { ...o.env, FAKE_CODEX_SCENARIO: scenarioPath, FAKE_CODEX_LOG: logPath } }),
              })
            : new FakeDriver(h),
      },
    );
    const run = runner.start(repo("app", path), "ask", ACTIONS.ask, "read the status, then push", {
      ...DEFAULT_AGENT,
      harness: "codex",
      yolo: false,
    });
    const until = async (pred: () => boolean, what: string) => {
      const deadline = Date.now() + 8_000;
      while (!pred()) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}; run is ${run.status} ${run.error ?? ""}`);
        await Bun.sleep(10);
      }
    };
    await until(() => run.status === "waiting", "the push prompt");
    // the read never showed: the job's git-read rules took it
    expect(run.prompt).toMatchObject({ id: "p1", kind: "permission", tool: "Bash", title: "git push" });
    runner.answer(run.id, "p1", { kind: "deny" });
    await until(() => run.status === "done" || run.status === "failed", "the end");
    expect(run.status).toBe("done");
    expect(run.harness).toBe("codex");
    expect(run.session).toBe("thr-1");
    expect(run.result).toEqual({
      text: "Status read; push declined.",
      costUsd: 0,
      durationMs: 42,
      turns: 1,
      tokens: { input: 20, cachedInput: 5, output: 10, reasoning: 2, total: 30 },
    });
    const notes = run.steps.filter((s) => s.kind === "note").map((s) => s.text ?? "");
    expect(notes.filter((n) => n.includes("sandbox"))).toHaveLength(1);
    expect(notes[0]).toContain("a command failed in codex's sandbox and asks to run outside it");
    expect(notes).toContain("denied: git push");
    await until(() => run.outcome !== undefined, "the outcome");
    expect(run.outcome).toBe("changed");

    const log = (await readFile(logPath, "utf8")).split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
    const reply = (id: number) => log.find((m) => m["id"] === id && m["method"] === undefined) as { result?: unknown } | undefined;
    expect(reply(0)?.result).toEqual({ decision: "accept" });
    expect(reply(1)?.result).toEqual({ decision: "decline" });
    // canopy's CANOPY_* ride into the thread's config for the commands codex runs
    const thread = log.find((m) => m["method"] === "thread/start")?.["params"] as { config?: Record<string, unknown> };
    expect(thread.config?.["shell_environment_policy.set.CANOPY_RUN"]).toBe(run.id);
    expect(thread.config?.["shell_environment_policy.set.CANOPY_BACKEND"]).toBe("mini");
    expect(thread.config?.["shell_environment_policy.set.CANOPY_REPO"]).toBe("app");
    // every command and edit comes to canopy's rules, and a job that may not
    // edit runs in the read-only sandbox
    expect(log.find((m) => m["method"] === "thread/start")?.["params"]).toMatchObject({ approvalPolicy: "untrusted", sandbox: "read-only" });
    const init = log.find((m) => m["method"] === "initialize")?.["params"] as { clientInfo: { name: string } };
    expect(init.clientInfo.name).toBe("canopy");
  }, 20_000);
});
