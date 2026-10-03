import { afterAll, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startStageRunner, type RunnerOptions as StageRunnerOptions } from "../stage/runner";
import { ACTIONS } from "./actions";
import { ClaudeDriver } from "./claudedrive";
import { bunSpawn, type RpcSpawn } from "./codexrpc";
import { CodexDriver } from "./codexrun";
import { Flows } from "./flow";
import type { DriveCtx, RunDriver } from "./driver";
import { defaultDriver, Runner, runEnv, type RunnerOptions } from "./runner";
import { StageClient } from "./stageclient";
import { parseWorkflow } from "./workflow";
import { STAGE_AWAY, StageAwayError } from "./stagewire";
import { DEFAULT_AGENT, isRunActive, type Harness, type Repo, type RepoStatus, type Run } from "./types";

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

const FAKE_CLAUDE = join(import.meta.dir, "testdata", "fake-claude.ts");
/** a stage runner behind a fence: its probe target times out */
const FENCE = { CANOPY_FENCE_PROBE: "http://probe.test/" };
const blocked: NonNullable<StageRunnerOptions["probe"]> = async () => ({ result: "blocked" });
/** the stand-in claude sits in a temp dir the test owns */
const notWritable: NonNullable<StageRunnerOptions["writable"]> = async () => false;

/** polls every 10 ms for up to 5 s */
async function waitFor(pred: () => boolean, what = "the condition"): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(10);
  }
}

/** the stand-in claude answers each message with a result, so a job ends */
const chatMode = (spawn: RpcSpawn): RpcSpawn => (argv, o) => spawn(argv, { ...o, env: { ...o.env, FAKE_CLAUDE_MODE: "chat" } });

describe("a stage run goes through the stage runner", () => {
  /** a seed under _incubator and a plain repo, both real folders */
  const folders = async (): Promise<{ seed: Repo; plain: Repo }> => {
    const dir = await mkdtemp(join(tmpdir(), "canopy-runner-stage-"));
    scratch.push(dir);
    const seedPath = join(dir, "_incubator", "coin");
    const plainPath = join(dir, "plain");
    await mkdir(seedPath, { recursive: true });
    await mkdir(plainPath);
    return { seed: repo("_incubator/coin", seedPath), plain: repo("plain", plainPath) };
  };
  const isSeed = (r: Repo): boolean => r.path.includes("/_incubator/");

  /** a client whose spawn records the request and starts the stand-in claude
   *  in place of the bare name; busy answers from `busy` */
  const recordingClient = (busy: () => boolean | null = () => false) => {
    const seen: { argv: readonly string[]; cwd: string; env: Record<string, string | undefined> }[] = [];
    const busyAsked: string[] = [];
    const spawn: RpcSpawn = (argv, { cwd, env }) => {
      seen.push({ argv, cwd, env });
      return bunSpawn([process.execPath, FAKE_CLAUDE, ...argv.slice(1)], { cwd, env: { ...process.env, FAKE_CLAUDE_MODE: "chat" } });
    };
    const client = {
      spawn,
      harnessesNow: () => ["claude"],
      busy: async (seed: string) => (busyAsked.push(seed), busy()),
    } as unknown as StageClient;
    return { client, seen, busyAsked };
  };
  const localClaude = (h: Harness): RunDriver =>
    h === "claude" ? new ClaudeDriver({ command: [process.execPath, FAKE_CLAUDE], spawn: chatMode(bunSpawn) }) : new FakeDriver(h);

  test("a stage run starts through the stage spawn by bare name, and a plain run does not", async () => {
    const { seed, plain } = await folders();
    const { client, seen } = recordingClient();
    const runner = new Runner({ onChange: () => {}, onGone: () => {} }, { stage: isSeed, stageExec: () => client, driver: localClaude });
    const a = runner.start(seed, "ask", ACTIONS.ask, "go", { ...DEFAULT_AGENT });
    const b = runner.start(plain, "ask", ACTIONS.ask, "go", { ...DEFAULT_AGENT });
    await waitFor(() => !isRunActive(a) && !isRunActive(b), "both runs to end");
    expect([a.status, b.status]).toEqual(["done", "done"]);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.argv[0]).toBe("claude");
    expect(seen[0]?.argv).toContain("--setting-sources");
    expect(seen[0]?.cwd).toBe(seed.path);
    // the runner builds the child's env; canopy sends only the run's own names
    expect(seen[0]?.env).toEqual({ CANOPY_RUN: a.id, CANOPY_REPO: seed.id });
  });

  test("a stage run with no stage runner refuses before a run exists", () => {
    const runner = new Runner({ onChange: () => {}, onGone: () => {} }, { stage: () => true, stageExec: () => null, driver: (h) => new FakeDriver(h) });
    expect(() => runner.start(repo("_incubator/coin"), "ask", ACTIONS.ask, "go", { ...DEFAULT_AGENT })).toThrow(StageAwayError);
    expect(runner.list()).toEqual([]);
  });

  test("a stage run with no runner set up refuses in the words stageAway gives", () => {
    const why = "stages need the stage runner (CANOPY_STAGE_SOCKET), or CANOPY_INCUBATOR_UNISOLATED=1";
    const runner = new Runner(
      { onChange: () => {}, onGone: () => {} },
      { stage: () => true, stageExec: () => null, stageAway: () => why, driver: (h) => new FakeDriver(h) },
    );
    expect(() => runner.start(repo("_incubator/coin"), "ask", ACTIONS.ask, "go", { ...DEFAULT_AGENT })).toThrow(why);
    expect(() => runner.start(repo("_incubator/coin"), "ask", ACTIONS.ask, "go", { ...DEFAULT_AGENT })).toThrow(StageAwayError);
  });

  test("a stage run whose runner has not answered a hello yet refuses as away, not as missing", () => {
    const client = { spawn: (() => { throw new Error("no"); }) as RpcSpawn, harnessesNow: () => null } as unknown as StageClient;
    const runner = new Runner({ onChange: () => {}, onGone: () => {} }, { stage: () => true, stageExec: () => client, driver: (h) => new FakeDriver(h) });
    expect(() => runner.start(repo("_incubator/coin"), "ask", ACTIONS.ask, "go", { ...DEFAULT_AGENT })).toThrow(StageAwayError);
  });

  test("a stage run whose runner lacks the harness refuses in words", () => {
    const client = { spawn: (() => { throw new Error("no"); }) as RpcSpawn, harnessesNow: () => ["claude"] } as unknown as StageClient;
    // the local driver's own check would pass: the stages container's list is what counts
    const runner = new Runner({ onChange: () => {}, onGone: () => {} }, { stage: () => true, stageExec: () => client, driver: (h) => new FakeDriver(h) });
    expect(() => runner.start(repo("_incubator/coin"), "ask", ACTIONS.ask, "go", { ...DEFAULT_AGENT, harness: "codex" })).toThrow(
      "codex is not installed in the stages container",
    );
  });

  test("liveIn holds from spawn to exit, and is clear by the end-of-run status read", async () => {
    const { seed } = await folders();
    const { client, busyAsked } = recordingClient();
    const seenAtRead: boolean[] = [];
    const runner: Runner = new Runner(
      {
        onChange: () => {},
        onGone: () => {},
        // the runner's settle() reads status once the process is over
        status: async () => (seenAtRead.push(runner.liveIn(seed.path)), null),
      },
      { stage: () => true, stageExec: () => client, driver: localClaude },
    );
    const run = runner.start(seed, "ask", ACTIONS.ask, "go", { ...DEFAULT_AGENT });
    expect(runner.liveIn(seed.path)).toBe(true);
    await waitFor(() => !isRunActive(run), "the run to end");
    await waitFor(() => seenAtRead.length > 0, "the status read");
    expect(seenAtRead).toEqual([false]);
    expect(runner.liveIn(seed.path)).toBe(false);
    // the runner was asked whether anything still runs in the seed
    expect(busyAsked).toEqual([seed.path]);
  });

  test("liveIn holds while the stage runner says the seed is still busy", async () => {
    const { seed } = await folders();
    let answers = 0;
    const { client } = recordingClient(() => (answers += 1) < 3);
    let reads = 0;
    const runner: Runner = new Runner(
      { onChange: () => {}, onGone: () => {}, status: async () => ((reads += 1), null) },
      { stage: () => true, stageExec: () => client, driver: localClaude },
    );
    const run = runner.start(seed, "ask", ACTIONS.ask, "go", { ...DEFAULT_AGENT });
    await waitFor(() => !isRunActive(run), "the run to end");
    await waitFor(() => answers >= 1, "the first busy answer");
    expect(runner.liveIn(seed.path)).toBe(true);
    expect(reads).toBe(0);
    await waitFor(() => !runner.liveIn(seed.path), "the seed to go quiet");
    expect(answers).toBe(3);
    await waitFor(() => reads === 1, "the status read");
  });

  test("a seed the stage runner keeps calling busy stays held past the wait, and the run still ends", async () => {
    const { seed } = await folders();
    let busy = true;
    const { client } = recordingClient(() => busy);
    let reads = 0;
    const atRead: { held: boolean | null } = { held: null };
    const runner: Runner = new Runner(
      {
        onChange: () => {},
        onGone: () => {},
        status: async () => {
          reads += 1;
          atRead.held = runner.liveAny();
          return null;
        },
      },
      { stage: () => true, stageExec: () => client, driver: localClaude, quietWait: 200 },
    );
    const run = runner.start(seed, "ask", ACTIONS.ask, "go", { ...DEFAULT_AGENT });
    // the run's own end does not wait on the seed for longer than the wait
    await waitFor(() => !isRunActive(run), "the run to end");
    expect(run.status).toBe("done");
    // a yes past the wait is still a yes: every seed stays busy, and the
    // end-of-run status read waits for the next no
    expect(runner.liveIn(seed.path)).toBe(true);
    expect(runner.liveAny()).toBe(true);
    await Bun.sleep(600);
    expect(runner.liveIn(seed.path)).toBe(true);
    expect(reads).toBe(0);
    busy = false;
    await waitFor(() => reads === 1, "the end-of-run status read");
    expect(atRead.held).toBe(false);
    expect(runner.liveIn(seed.path)).toBe(false);
    expect(runner.liveAny()).toBe(false);
  });

  test("a stage runner that does not answer the busy question lets the seed go, as before", async () => {
    const { seed } = await folders();
    const { client } = recordingClient(() => null);
    const runner = new Runner({ onChange: () => {}, onGone: () => {} }, { stage: () => true, stageExec: () => client, driver: localClaude, quietWait: 200 });
    const run = runner.start(seed, "ask", ACTIONS.ask, "go", { ...DEFAULT_AGENT });
    await waitFor(() => !isRunActive(run) && !runner.liveIn(seed.path), "the run to end and the seed to go");
    expect(runner.liveAny()).toBe(false);
  });

  test("an unisolated stage run feeds liveIn and still starts the local binary", async () => {
    const { seed } = await folders();
    const argvs: string[][] = [];
    const recorded: RpcSpawn = (argv, o) => (argvs.push([...argv]), chatMode(bunSpawn)(argv, o));
    let ctx: DriveCtx | null = null;
    const runner = new Runner(
      { onChange: () => {}, onGone: () => {} },
      {
        stage: () => true,
        stageExec: () => undefined,
        driver: () => {
          const d = new ClaudeDriver({ command: [process.execPath, FAKE_CLAUDE], spawn: recorded });
          const start = d.start.bind(d);
          d.start = (c, m) => ((ctx = c), start(c, m));
          return d;
        },
      },
    );
    const run = runner.start(seed, "ask", ACTIONS.ask, "go", { ...DEFAULT_AGENT });
    expect(runner.liveIn(seed.path)).toBe(true);
    expect(argvs[0]?.slice(0, 2)).toEqual([process.execPath, FAKE_CLAUDE]);
    expect((ctx as DriveCtx | null)?.spawn).toBeUndefined();
    await waitFor(() => !isRunActive(run) && !runner.liveIn(seed.path), "the run to end and the seed to go quiet");
    expect(run.status).toBe("done");
  });

  test("a stage codex run starts the app-server through the stage spawn by bare name", async () => {
    const { seed } = await folders();
    const scenarioPath = join(seed.path, "..", "scenario.json");
    await writeFile(
      scenarioPath,
      JSON.stringify({
        turns: [
          [
            { notify: "item/completed", params: { threadId: "$THREAD", turnId: "$TURN", item: { type: "agentMessage", id: "m", text: "done", phase: "final_answer" } } },
            { complete: "completed", durationMs: 1 },
          ],
        ],
      }),
    );
    const seen: { argv: readonly string[]; env: Record<string, string | undefined> }[] = [];
    const client = {
      spawn: ((argv, { cwd, env }) => {
        seen.push({ argv, env });
        return bunSpawn([process.execPath, FAKE, ...argv.slice(1)], { cwd, env: { ...process.env, FAKE_CODEX_SCENARIO: scenarioPath } });
      }) as RpcSpawn,
      harnessesNow: () => ["claude", "codex"],
      busy: async () => false,
    } as unknown as StageClient;
    const runner = new Runner(
      { onChange: () => {}, onGone: () => {} },
      {
        stage: () => true,
        stageExec: () => client,
        // a local command the stage run must not use
        driver: () => new CodexDriver({ command: ["/nonexistent/codex"], graceMs: 3_000 }),
      },
    );
    const run = runner.start(seed, "ask", ACTIONS.ask, "go", { ...DEFAULT_AGENT, harness: "codex", yolo: false });
    await waitFor(() => !isRunActive(run) && !runner.liveIn(seed.path), "the codex run to end");
    expect(run.status).toBe("done");
    expect(seen[0]?.argv.slice(0, 2)).toEqual(["codex", "app-server"]);
    expect(seen[0]?.env).toEqual({ CANOPY_RUN: run.id, CANOPY_REPO: seed.id });
  });

  test("a stage run whose runner is down at connect fails in words a flow parks on, on either harness", async () => {
    const { seed } = await folders();
    /** a real client on a socket nothing listens on, that last heard the runner up */
    class GoneClient extends StageClient {
      override harnessesNow(): string[] {
        return ["claude", "codex"];
      }
    }
    const client = new GoneClient(join(seed.path, "..", "no-such.sock"));
    const runner = new Runner(
      { onChange: () => {}, onGone: () => {}, status: async () => null },
      {
        stage: () => true,
        stageExec: () => client,
        driver: (h) => (h === "codex" ? new CodexDriver({ graceMs: 3_000 }) : new ClaudeDriver()),
      },
    );
    for (const harness of ["claude", "codex"] as const) {
      const run = runner.start(seed, "ask", ACTIONS.ask, "go", { ...DEFAULT_AGENT, harness, yolo: false });
      await waitFor(() => !isRunActive(run) && !runner.liveIn(seed.path), `the ${harness} run to end`);
      expect(run.status).toBe("failed");
      expect(run.error).toContain(STAGE_AWAY);
      // a hello confirmed the runner gone: the flag a flow parks on
      expect(run.away).toBe(true);
      runner.dismiss(run.id);
    }
  });

  test("whenQuiet settles once a finished stage run's process is gone and its seed quiet", async () => {
    const { seed } = await folders();
    let answers = 0;
    const { client } = recordingClient(() => (answers += 1) < 3);
    const runner = new Runner({ onChange: () => {}, onGone: () => {} }, { stage: () => true, stageExec: () => client, driver: localClaude });
    const run = runner.start(seed, "ask", ACTIONS.ask, "go", { ...DEFAULT_AGENT });
    // the run ends on its result, ahead of the process and the busy answers
    await waitFor(() => !isRunActive(run), "the run to end");
    expect(runner.liveIn(seed.path)).toBe(true);
    await runner.whenQuiet(seed.path);
    expect(runner.liveIn(seed.path)).toBe(false);
    expect(answers).toBe(3);
    // nothing started there: at once
    await runner.whenQuiet("/nowhere");
  });

  test("through a real stage runner: a job answered to its end, and a stop that kills", async () => {
    const dir = await realpath(await mkdtemp(join(tmpdir(), "canopy-runner-real-")));
    scratch.push(dir);
    const root = join(dir, "_incubator");
    const seedPath = join(root, "coin");
    await mkdir(seedPath, { recursive: true });
    // the stage runner starts claude by its own map; the stand-in, in job mode
    const fake = join(dir, "claude");
    await writeFile(fake, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(FAKE_CLAUDE)} "$@"\n`);
    await chmod(fake, 0o755);
    const socket = join(dir, "s.sock");
    const stage = await startStageRunner({ socket, root, env: { PATH: process.env["PATH"], HOME: dir, ...FENCE }, probe: blocked, writable: notWritable, programs: { claude: fake } });
    try {
      const client = new StageClient(socket);
      expect(await client.hello()).toContain("claude");
      const runner = new Runner(
        { onChange: () => {}, onGone: () => {}, status: async () => null },
        { stage: () => true, stageExec: () => client, driver: () => new ClaudeDriver({ command: ["/nonexistent/claude"] }) },
      );
      const seed = repo("_incubator/coin", seedPath);
      const run = runner.start(seed, "ask", ACTIONS.ask, "go", { ...DEFAULT_AGENT, yolo: false });
      await waitFor(() => run.status === "waiting", "the git push prompt");
      expect(runner.liveIn(seedPath)).toBe(true);
      runner.answer(run.id, run.prompt?.id ?? "", { kind: "allow" });
      await waitFor(() => !isRunActive(run), "the job to end");
      expect(run.status).toBe("done");
      // the runner passes the run's own names on, so the stand-in saw CANOPY_RUN
      expect(run.result?.text).toBe(`env:${run.id}`);
      await runner.whenQuiet(seedPath);
      expect(runner.liveIn(seedPath)).toBe(false);
      expect(await client.busy(seedPath)).toBe(false);
      runner.dismiss(run.id);

      const stopped = runner.start(seed, "ask", ACTIONS.ask, "go", { ...DEFAULT_AGENT, yolo: false });
      await waitFor(() => stopped.status === "waiting", "the second prompt");
      runner.stop(stopped.id);
      await waitFor(() => !isRunActive(stopped) && !runner.liveIn(seedPath), "the stop");
      expect(stopped.status).toBe("stopped");
      expect(await client.busy(seedPath)).toBe(false);
    } finally {
      await stage.stop();
    }
  }, 20_000);

  test("a stage runner that dies under a live run parks the flow, not fails it", async () => {
    const dir = await realpath(await mkdtemp(join(tmpdir(), "canopy-runner-dies-")));
    scratch.push(dir);
    const root = join(dir, "_incubator");
    const seedPath = join(root, "coin");
    await mkdir(seedPath, { recursive: true });
    const fake = join(dir, "claude");
    await writeFile(fake, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(FAKE_CLAUDE)} "$@"\n`);
    await chmod(fake, 0o755);
    const socket = join(dir, "s.sock");
    const stage = await startStageRunner({ socket, root, env: { PATH: process.env["PATH"], HOME: dir, ...FENCE }, probe: blocked, writable: notWritable, programs: { claude: fake } });
    let stopped = false;
    try {
      const client = new StageClient(socket);
      expect(await client.hello()).toContain("claude");
      let flows!: Flows;
      const runner = new Runner(
        { onChange: (r) => flows.onRun(r), onGone: () => {}, status: async () => null },
        { stage: () => true, stageExec: () => client, driver: () => new ClaudeDriver({ command: ["/nonexistent/claude"] }) },
      );
      flows = new Flows(runner, {
        onChange: () => {},
        onGone: () => {},
        onFleet: () => {},
        onFleetGone: () => {},
        check: async () => ({ exit: 0, output: "" }),
        evaluator: null,
      });
      const parsed = parseWorkflow("---\nname: one\nverb: do one\nblurb: b\n---\n\n## Only\n\nDo it.\n", { name: "one", source: "bundled", file: "/one.md" });
      if (!parsed.ok) throw new Error(parsed.error);
      const f = flows.start(repo("_incubator/coin", seedPath), parsed.workflow, "", { ...DEFAULT_AGENT, yolo: false });
      const runId = (): string => flows.get(f.id)?.steps[0]?.runId ?? "";
      await waitFor(() => runner.get(runId())?.status === "waiting", "the step's prompt");
      // the stages container goes away under the live run
      await stage.stop();
      stopped = true;
      await waitFor(() => flows.get(f.id)?.status !== "working" && flows.get(f.id)?.status !== "waiting", "the flow to settle");
      const now = flows.get(f.id);
      expect(now?.status).toBe("gated");
      expect(now?.parkedFor).toBe("stage");
      expect(now?.steps[0]?.reason).toContain(STAGE_AWAY);
    } finally {
      if (!stopped) await stage.stop();
    }
  }, 20_000);

  test("a step the stage runner refuses for its fence parks with the runner's words; any other refusal fails", async () => {
    const dir = await realpath(await mkdtemp(join(tmpdir(), "canopy-runner-fence-")));
    scratch.push(dir);
    const root = join(dir, "_incubator");
    const seedPath = join(root, "coin");
    await mkdir(seedPath, { recursive: true });
    const socket = join(dir, "s.sock");
    // no probe target: the runner refuses every spawn for its fence
    const stage = await startStageRunner({ socket, root, env: { PATH: process.env["PATH"], HOME: dir }, programs: { claude: "/nonexistent/claude" } });
    /** a client that still believes the runner fenced, as one does between two hellos */
    class Stale extends StageClient {
      override harnessesNow(): string[] {
        return ["claude"];
      }
    }
    try {
      const client = new Stale(socket);
      let flows!: Flows;
      const runner = new Runner(
        { onChange: (r) => flows.onRun(r), onGone: () => {}, status: async () => null },
        { stage: () => true, stageExec: () => client, driver: () => new ClaudeDriver({ command: ["/nonexistent/claude"] }) },
      );
      flows = new Flows(runner, {
        onChange: () => {},
        onGone: () => {},
        onFleet: () => {},
        onFleetGone: () => {},
        check: async () => ({ exit: 0, output: "" }),
        evaluator: null,
      });
      const parsed = parseWorkflow("---\nname: one\nverb: do one\nblurb: b\n---\n\n## Only\n\nDo it.\n", { name: "one", source: "bundled", file: "/one.md" });
      if (!parsed.ok) throw new Error(parsed.error);
      const f = flows.start(repo("_incubator/coin", seedPath), parsed.workflow, "", { ...DEFAULT_AGENT, yolo: false });
      await waitFor(() => flows.get(f.id)?.status === "gated", "the flow to park");
      const parked = flows.get(f.id);
      expect(parked?.parkedFor).toBe("stage");
      expect(parked?.steps[0]?.reason).toBe("the fence is unchecked: set CANOPY_FENCE_PROBE");
      const run = runner.get(parked?.steps[0]?.runId ?? "");
      expect(run?.away).toBe(true);
      expect(run?.error).toBe("the fence is unchecked: set CANOPY_FENCE_PROBE");
      flows.stop(f.id);
    } finally {
      await stage.stop();
    }
    // the same runner fenced, but with no claude to start: a plain refusal fails the step
    const fenced = await startStageRunner({ socket, root, env: { PATH: process.env["PATH"], HOME: dir, ...FENCE }, probe: blocked, programs: { claude: "/nonexistent/claude" } });
    try {
      const runner = new Runner(
        { onChange: () => {}, onGone: () => {}, status: async () => null },
        { stage: () => true, stageExec: () => new Stale(socket), driver: () => new ClaudeDriver({ command: ["/nonexistent/claude"] }) },
      );
      const run = runner.start(repo("_incubator/coin", seedPath), "ask", ACTIONS.ask, "go", { ...DEFAULT_AGENT, yolo: false });
      await waitFor(() => !isRunActive(run) && !runner.liveIn(seedPath), "the run to end");
      expect(run.status).toBe("failed");
      expect(run.away).toBeUndefined();
      expect(run.error).toContain("claude is not installed where the stage runner can start it");
    } finally {
      await fenced.stop();
    }
  }, 20_000);

  test("a step the stage runner refuses for its claude settings fails with the file and key, never parked as the runner away", async () => {
    const dir = await realpath(await mkdtemp(join(tmpdir(), "canopy-runner-settings-")));
    scratch.push(dir);
    const root = join(dir, "_incubator");
    const seedPath = join(root, "coin");
    await mkdir(seedPath, { recursive: true });
    const cfg = join(dir, "stage-claude");
    await mkdir(cfg, { recursive: true });
    await writeFile(join(cfg, "settings.json"), JSON.stringify({ hooks: { Stop: [] } }));
    const claude = join(dir, "claude");
    await writeFile(claude, `#!/bin/sh\ntouch ${join(dir, "ran")}\n`);
    await chmod(claude, 0o755);
    const socket = join(dir, "s.sock");
    const stage = await startStageRunner({
      socket,
      root,
      env: { PATH: process.env["PATH"], HOME: dir, CLAUDE_CONFIG_DIR: cfg, ...FENCE },
      probe: blocked,
      writable: notWritable,
      programs: { claude },
    });
    try {
      const client = new StageClient(socket);
      expect(await client.hello()).toContain("claude");
      let flows!: Flows;
      const runner = new Runner(
        { onChange: (r) => flows.onRun(r), onGone: () => {}, status: async () => null },
        { stage: () => true, stageExec: () => client, driver: () => new ClaudeDriver({ command: ["claude"] }) },
      );
      flows = new Flows(runner, {
        onChange: () => {},
        onGone: () => {},
        onFleet: () => {},
        onFleetGone: () => {},
        check: async () => ({ exit: 0, output: "" }),
        evaluator: null,
      });
      const parsed = parseWorkflow("---\nname: one\nverb: do one\nblurb: b\n---\n\n## Only\n\nDo it.\n", { name: "one", source: "bundled", file: "/one.md" });
      if (!parsed.ok) throw new Error(parsed.error);
      const f = flows.start(repo("_incubator/coin", seedPath), parsed.workflow, "", { ...DEFAULT_AGENT, yolo: false });
      await waitFor(() => flows.get(f.id)?.status === "failed", "the flow to fail");
      const failed = flows.get(f.id);
      expect(failed?.parkedFor).toBeUndefined();
      const run = runner.get(failed?.steps[0]?.runId ?? "");
      expect(run?.status).toBe("failed");
      expect(run?.away).toBeUndefined();
      expect(run?.error).toContain(`${join(cfg, "settings.json")} holds "hooks"`);
      expect(await Bun.file(join(dir, "ran")).exists()).toBe(false);
    } finally {
      await stage.stop();
    }
  }, 20_000);

  test("a plain run gets no stage spawn and no liveness tap", () => {
    const { runner, ctxOf } = setup({ stage: () => false, stageExec: () => null });
    runner.start(repo("a"), "ask", ACTIONS.ask, "x", DEFAULT_AGENT);
    expect(ctxOf(0).spawn).toBeUndefined();
    expect(ctxOf(0).track).toBeUndefined();
  });
});
