import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ACTIONS } from "./actions";
import { ClaudeDriver } from "./claudedrive";
import { CodexDriver, threadParams } from "./codexrun";
import { RunCtx, type DriveCtx, type DriveRun, type RunDriver } from "./driver";
import { stageDrops, stageEnv } from "./envnames";
import { Runner } from "./runner";
import { DEFAULT_AGENT, type Repo } from "./types";

/* An incubator stage's run and its check start without canopy's GitHub
 * login; every other run keeps it. Sentinel values stand in for the real
 * ones, set in this process's env and put back after each test. */

const SENTINELS: Record<string, string> = {
  GH_TOKEN: "sentinel-gh",
  GITHUB_TOKEN: "sentinel-github",
  GH_ENTERPRISE_TOKEN: "sentinel-ghe",
  GIT_CONFIG_COUNT: "1",
  GIT_CONFIG_KEY_0: "credential.https://github.com.helper",
  GIT_CONFIG_VALUE_0: "sentinel-helper",
  CANOPY_API: "http://127.0.0.1:1/sentinel",
  TAILCHAN_AS: "sentinel-handle",
  TAILCHAN_URL: "http://sentinel-broker",
};
const saved = new Map<string, string | undefined>();
const plant = (): void => {
  for (const [k, v] of Object.entries(SENTINELS)) {
    saved.set(k, process.env[k]);
    process.env[k] = v;
  }
};
afterEach(() => {
  for (const [k, v] of saved) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  saved.clear();
});
const scratch: string[] = [];
afterAll(async () => {
  for (const d of scratch) await rm(d, { recursive: true, force: true });
});

const AGENT = { model: "default", effort: "default", yolo: false, extra: "" };
const driveRun = (): DriveRun => ({
  id: "r1",
  repoId: "_incubator/x",
  action: "ask",
  verb: "ask",
  progress: "working",
  expectsChange: false,
  chat: false,
  harness: "claude",
  note: "",
  status: "working",
  startedAt: Date.now(),
  steps: [],
  prompt: null,
});
const ctxFor = (cwd: string, stage: boolean, env: Record<string, string>): RunCtx =>
  new RunCtx(driveRun(), { cwd, agent: AGENT, spec: { allowedTools: ["Read"], maxTurns: 5 }, env, stage, label: "test" }, { emit: () => {} });

describe("stageEnv", () => {
  test("drops the GitHub login, the callback API, tailchan and canopy's secrets; keeps the rest", () => {
    const env = stageEnv({
      ...SENTINELS,
      GIT_CONFIG_KEY_12: "x",
      GIT_CONFIG_VALUE_12: "y",
      GIT_CONFIG_PARAMETERS: "'core.fsmonitor'='x'",
      SSH_AUTH_SOCK: "/tmp/agent",
      VERCEL_TOKEN: "v",
      FIREBASE_TOKEN: "f",
      CANOPY_VAULT_TOKEN: "v",
      PATH: "/usr/bin",
      HOME: "/home/x",
      CANOPY_RUN: "r1",
      CLAUDE_CODE_OAUTH_TOKEN: "agent-login",
      OPENAI_API_KEY: "agent-login",
      GIT_AUTHOR_NAME: "canopy",
      UNSET: undefined,
    });
    expect(Object.keys(env).sort()).toEqual(["CANOPY_RUN", "CLAUDE_CODE_OAUTH_TOKEN", "GIT_AUTHOR_NAME", "HOME", "OPENAI_API_KEY", "PATH"]);
    expect(stageDrops("GIT_CONFIG_KEYS")).toBe(false);
  });
});

describe("the claude driver's process", () => {
  /** a stand-in claude that writes its env where the run's env says, then exits */
  async function envOf(stage: boolean): Promise<Record<string, string>> {
    const dir = await mkdtemp(join(tmpdir(), "canopy-stage-claude-"));
    scratch.push(dir);
    const dump = join(dir, "env.json");
    const script = join(dir, "dump.ts");
    await writeFile(script, `require("node:fs").writeFileSync(process.env.DUMP_TO, JSON.stringify(process.env));\n`);
    const ctx = ctxFor(dir, stage, { CANOPY_RUN: "r1", CANOPY_API: "http://127.0.0.1:1/run", DUMP_TO: dump });
    new ClaudeDriver({ command: [process.execPath, script] }).start(ctx, "go");
    const deadline = Date.now() + 8_000;
    while (!existsSync(dump) || ctx.run.status === "working") {
      if (Date.now() > deadline) throw new Error("the stand-in never wrote its env");
      await Bun.sleep(10);
    }
    const parsed: unknown = JSON.parse(await readFile(dump, "utf8"));
    if (typeof parsed !== "object" || parsed === null) throw new Error("no env object");
    return Object.fromEntries(Object.entries(parsed).filter((e): e is [string, string] => typeof e[1] === "string"));
  }

  test("a stage run's claude has none of them, a normal run's keeps every one", async () => {
    plant();
    const stage = await envOf(true);
    const normal = await envOf(false);
    for (const [k, v] of Object.entries(SENTINELS)) {
      expect(stage[k]).toBeUndefined();
      expect(normal[k]).toBe(k === "CANOPY_API" ? "http://127.0.0.1:1/run" : v);
    }
    expect(stage["CANOPY_RUN"]).toBe("r1");
    expect(stage["PATH"]).toBe(process.env["PATH"] ?? "");
  });
});

describe("the codex driver's app-server", () => {
  async function spawned(stage: boolean): Promise<Record<string, string | undefined>> {
    let seen: Record<string, string | undefined> | null = null;
    const ctx = ctxFor("/r", stage, { CANOPY_RUN: "r1" });
    const driver = new CodexDriver({
      command: ["codex"],
      spawn: (_argv, opts) => {
        seen = opts.env;
        throw new Error("not started in tests");
      },
    });
    driver.start(ctx, "go");
    for (let i = 0; i < 200 && seen === null; i++) await Bun.sleep(5);
    if (seen === null) throw new Error("codex was never spawned");
    return seen;
  }

  test("a stage run's app-server has none of them, a normal run's keeps every one", async () => {
    plant();
    const stage = await spawned(true);
    const normal = await spawned(false);
    for (const [k, v] of Object.entries(SENTINELS)) {
      expect(stage[k]).toBeUndefined();
      expect(normal[k]).toBe(v);
    }
    expect(stage["CANOPY_RUN"]).toBe("r1");
  });

  test("what codex sets in its commands' environment leaves them out too", () => {
    const env = { CANOPY_RUN: "r1", CANOPY_API: "http://127.0.0.1:1/run" };
    const config = (ctx: DriveCtx): Record<string, unknown> => {
      const p = threadParams("/r", AGENT, { askQuestions: false, env: ctx.env });
      const c = p["config"];
      return typeof c === "object" && c !== null ? Object.fromEntries(Object.entries(c)) : {};
    };
    const stage = config(ctxFor("/r", true, env));
    const normal = config(ctxFor("/r", false, env));
    expect(stage["shell_environment_policy.set.CANOPY_RUN"]).toBe("r1");
    expect(stage["shell_environment_policy.set.CANOPY_API"]).toBeUndefined();
    expect(normal["shell_environment_policy.set.CANOPY_API"]).toBe("http://127.0.0.1:1/run");
  });
});

describe("the runner", () => {
  test("marks a run a stage's by the repo, and only then", () => {
    const seen: DriveCtx[] = [];
    const driver = (): RunDriver => ({
      harness: "claude",
      label: "test",
      check: () => null,
      start: (ctx) => void seen.push(ctx),
      say: () => {},
      stop: () => {},
    });
    const runner = new Runner({ onChange: () => {}, onGone: () => {} }, { driver, stage: (repo) => repo.path.startsWith("/root/_incubator/") });
    const repo = (id: string, path: string): Repo => ({ id, name: id, path, group: "", source: "", status: null });
    runner.start(repo("_incubator/a", "/root/_incubator/a"), "ask", ACTIONS.ask, "read", DEFAULT_AGENT);
    runner.start(repo("b", "/root/b"), "ask", ACTIONS.ask, "read", DEFAULT_AGENT);
    expect(seen.map((c) => c.stage)).toEqual([true, false]);
  });
});
