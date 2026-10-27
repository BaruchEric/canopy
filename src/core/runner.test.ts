import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import * as fs from "node:fs";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RpcProc } from "./codexrpc";
import { ACTIONS } from "./actions";
import { cliArgs, Runner, startArgv } from "./runner";
import type { DriveCtx, RunDriver } from "./driver";
import { DiskRunLogger, readKeptRun, WIRE_GZ, type RunLogger } from "./runlog";
import { StageClient } from "./stageclient";
import { DEFAULT_AGENT, type Harness, type Repo, type Run } from "./types";

describe("the print-mode command line", () => {
  test("the default is the bypass mode; ask goes through the prompt tool", () => {
    expect(cliArgs(ACTIONS.ask, DEFAULT_AGENT)).toContain("bypassPermissions");
    const args = cliArgs(ACTIONS.ask, { ...DEFAULT_AGENT, yolo: false });
    expect(args.slice(0, 2)).toEqual(["-p", "--output-format"]);
    expect(args).toContain("--permission-prompt-tool");
    expect(args.slice(args.indexOf("--permission-mode"), args.indexOf("--permission-mode") + 2)).toEqual([
      "--permission-mode",
      "default",
    ]);
    expect(args).not.toContain("--model");
    expect(args).not.toContain("--dangerously-skip-permissions");
  });

  test("the repo's settings ride along; yolo becomes the bypass mode", () => {
    const args = cliArgs(ACTIONS.chat, { harness: "claude", model: "opus", effort: "high", yolo: true, extra: "--name x" });
    expect(args.slice(-6)).toEqual(["--model", "opus", "--effort", "high", "--name", "x"]);
    expect(args).toContain("bypassPermissions");
    // print mode takes the mode, not the interactive flag
    expect(args).not.toContain("--dangerously-skip-permissions");
    // the prompt tool stays: questions still come to the browser
    expect(args).toContain("--permission-prompt-tool");
  });
});

test("a run keeps the resolved settings snapshot for its accounting row", () => {
  const driver: RunDriver = { harness: "codex", label: "Codex", check: () => null, start: () => {}, say: () => {}, stop: () => {} };
  const runner = new Runner({ onChange: () => {}, onGone: () => {} }, { driver: () => driver });
  const repo = { id: "api", name: "api", path: "/r/api", status: null } as Repo;
  const run = runner.start(repo, "chat", ACTIONS.chat, "", {
    ...DEFAULT_AGENT,
    harness: "codex",
    model: "gpt-x",
    effort: "high",
    provider: "team_1",
  });
  expect(run.agentSettings).toEqual({ harness: "codex", model: "gpt-x", effort: "high", provider: "team_1" });
});

test("Runner.note adds a timeline remark only to a live known run", () => {
  const driver: RunDriver = { harness: "codex", label: "Codex", check: () => null, start: () => {}, say: () => {}, stop: () => {} };
  const changes: Run[] = [];
  const runner = new Runner({ onChange: (run) => changes.push(run), onGone: () => {} }, { driver: () => driver });
  const repo: Repo = { id: "api", name: "api", path: "/r/api", group: "", source: "root", status: null };
  const run = runner.start(repo, "chat", ACTIONS.chat, "", DEFAULT_AGENT);
  const before = changes.length;
  runner.note(run.id, "also editing x.ts");
  expect(run.steps.at(-1)).toMatchObject({ kind: "note", text: "also editing x.ts" });
  expect(changes).toHaveLength(before + 1);
  const knownSteps = run.steps.length;
  runner.note("missing", "not recorded");
  run.status = "limited";
  runner.note(run.id, "not recorded either");
  expect(run.steps).toHaveLength(knownSteps);
});

/* A stand-in for the claude CLI that never calls anything: it asks for two
 * tools at once, the way Claude Code does for parallel reads, and finishes
 * only when both requests got an answer. */
const FAKE_CLAUDE = `
const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
const dec = new TextDecoder();
let buf = "";
const answered = new Set();
let asked = false;
const ask = (id, path) => out({ type: "control_request", request_id: id, request: { subtype: "can_use_tool", tool_name: "Read", input: { file_path: path }, tool_use_id: "tu-" + id } });
setTimeout(() => process.exit(3), 8000);
for await (const chunk of Bun.stdin.stream()) {
  buf += dec.decode(chunk, { stream: true });
  let i;
  while ((i = buf.indexOf("\\n")) >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    const m = JSON.parse(line);
    if (!asked && m.type === "user") {
      asked = true;
      ask("req-A", "/nowhere/a");
      ask("req-B", "/nowhere/b");
    } else if (m.type === "control_response") {
      answered.add(m.response.request_id);
      if (answered.size === 2) out({ type: "result", subtype: "success", is_error: false, result: "both answered", num_turns: 1, total_cost_usd: 0, duration_ms: 1 });
    }
  }
}
process.exit(0);
`;

/* Drives a Runner in a process whose PATH finds the stand-in first:
 * Bun.which does not see a PATH changed at runtime. */
const HARNESS = (root: string) => `
import { Runner, claudeBinary } from ${JSON.stringify(join(root, "src/core/runner.ts"))};
import type { RpcProc } from "./codexrpc";
import { ACTIONS } from ${JSON.stringify(join(root, "src/core/actions.ts"))};
import { DEFAULT_AGENT } from ${JSON.stringify(join(root, "src/core/types.ts"))};
if (claudeBinary() !== process.env.FAKE_CLAUDE) {
  console.log(JSON.stringify({ abort: claudeBinary() }));
  process.exit(1);
}
const runner = new Runner({ onChange: () => {}, onGone: () => {} });
const repo = { id: "fx", name: "fx", path: process.env.FAKE_REPO, status: null };
const run = runner.start(repo, "ask", ACTIONS.ask, "read two files", { ...DEFAULT_AGENT, yolo: false });
const until = async (pred) => {
  for (let i = 0; i < 100; i++) {
    const r = runner.get(run.id);
    if (pred(r)) return r;
    await Bun.sleep(50);
  }
  return runner.get(run.id);
};
const ids = [];
for (let n = 0; n < 2; n++) {
  const r = await until((r) => r.prompt && !ids.includes(r.prompt.id));
  if (!r.prompt || ids.includes(r.prompt.id)) break;
  ids.push(r.prompt.id);
  runner.answer(run.id, r.prompt.id, { kind: "allow" });
}
const end = await until((r) => r.status !== "working" && r.status !== "waiting");
if (end.status === "working" || end.status === "waiting") runner.stop(run.id);
console.log(JSON.stringify({ ids, status: end.status }));
process.exit(0);
`;

describe("a run asked two things at once", () => {
  test("shows each prompt under its own id and answers both requests", async () => {
    const dir = await mkdtemp(join(tmpdir(), "canopy-runner-"));
    try {
      const bin = join(dir, "bin");
      await Bun.$`mkdir -p ${bin} ${join(dir, "repo")}`.quiet();
      const fake = join(bin, "claude");
      await writeFile(fake, `#!${process.execPath}\n${FAKE_CLAUDE}`);
      await chmod(fake, 0o755);
      await writeFile(join(dir, "harness.ts"), HARNESS(join(import.meta.dir, "../..")));
      const proc = Bun.spawn([process.execPath, join(dir, "harness.ts")], {
        env: { ...process.env, PATH: `${bin}:${process.env["PATH"] ?? ""}`, FAKE_CLAUDE: fake, FAKE_REPO: join(dir, "repo") },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [out] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
      const result = JSON.parse(out.trim().split("\n").at(-1) ?? "{}") as { ids?: string[]; status?: string; abort?: string };
      expect(result.abort).toBeUndefined();
      expect(result.ids?.length).toBe(2);
      expect(new Set(result.ids).size).toBe(2);
      expect(result.status).toBe("done");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 30_000);
});

/* A chat whose process lingers after its stdin closes, as one does while
 * an async hook (tailchan's --wake waiter) runs: it answers each message,
 * and exits a while after the end. */
const LINGERING_CHAT = `
const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
const dec = new TextDecoder();
let buf = "";
setTimeout(() => process.exit(3), 8000);
for await (const chunk of Bun.stdin.stream()) {
  buf += dec.decode(chunk, { stream: true });
  let i;
  while ((i = buf.indexOf("\\n")) >= 0) {
    const m = JSON.parse(buf.slice(0, i));
    buf = buf.slice(i + 1);
    if (m.type === "user") out({ type: "result", subtype: "success", is_error: false, result: "ok", num_turns: 1, total_cost_usd: 0, duration_ms: 1, session_id: "s-linger" });
  }
}
await Bun.sleep(1500);
process.exit(0);
`;

const ENDED_CHAT_HARNESS = (root: string) => `
import { Runner, claudeBinary } from ${JSON.stringify(join(root, "src/core/runner.ts"))};
import type { RpcProc } from "./codexrpc";
import { ACTIONS } from ${JSON.stringify(join(root, "src/core/actions.ts"))};
import { DEFAULT_AGENT } from ${JSON.stringify(join(root, "src/core/types.ts"))};
if (claudeBinary() !== process.env.FAKE_CLAUDE) {
  console.log(JSON.stringify({ abort: claudeBinary() }));
  process.exit(1);
}
const runner = new Runner({ onChange: () => {}, onGone: () => {} });
const repo = { id: "fx", name: "fx", path: process.env.FAKE_REPO, status: null };
const until = async (id, pred) => {
  for (let i = 0; i < 100; i++) {
    const r = runner.get(id);
    if (pred(r)) return r;
    await Bun.sleep(50);
  }
  return runner.get(id);
};
const first = runner.start(repo, "chat", ACTIONS.chat, "", DEFAULT_AGENT);
runner.say(first.id, "hi");
await until(first.id, (r) => r.status === "idle" && r.steps.length > 0);
runner.stop(first.id);
const lingering = runner.get(first.id).status;
const holder = runner.activeFor(repo.id)?.id ?? null;
let second = null;
try {
  second = runner.start(repo, "chat", ACTIONS.chat, "", DEFAULT_AGENT).id;
} catch (err) {
  second = "refused: " + err.message;
}
const end = await until(first.id, (r) => r.status !== "idle");
console.log(JSON.stringify({ lingering, holder, second, firstEnd: end.status }));
process.exit(0);
`;

describe("a chat ended between turns", () => {
  test("frees its repo at once, while its process still runs its exit hooks", async () => {
    const dir = await mkdtemp(join(tmpdir(), "canopy-runner-"));
    try {
      const bin = join(dir, "bin");
      await Bun.$`mkdir -p ${bin} ${join(dir, "repo")}`.quiet();
      const fake = join(bin, "claude");
      await writeFile(fake, `#!${process.execPath}\n${LINGERING_CHAT}`);
      await chmod(fake, 0o755);
      await writeFile(join(dir, "harness.ts"), ENDED_CHAT_HARNESS(join(import.meta.dir, "../..")));
      const proc = Bun.spawn([process.execPath, join(dir, "harness.ts")], {
        env: { ...process.env, PATH: `${bin}:${process.env["PATH"] ?? ""}`, FAKE_CLAUDE: fake, FAKE_REPO: join(dir, "repo") },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [out] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
      const result = JSON.parse(out.trim().split("\n").at(-1) ?? "{}") as { abort?: string; lingering?: string; holder?: string | null; second?: string; firstEnd?: string };
      expect(result.abort).toBeUndefined();
      // still exiting, so still shown as a run, but no longer the repo's
      expect(result.lingering).toBe("idle");
      expect(result.holder).toBeNull();
      expect(result.second).not.toStartWith("refused");
      expect(result.firstEnd).toBe("done");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 30_000);
});

test("stopAndWait stops a terminal member's lingering process and awaits its actual exit", async () => {
  let context: import("./driver").DriveCtx | undefined;
  let stops = 0; let returned = false; let settlements = 0;
  const runner = new Runner({ onChange: () => {}, onGone: () => {}, branchState: async () => { settlements++; return "ready"; } }, {
    driver: harness => ({ harness, label: "delayed exit", check: () => null, start: ctx => { context = ctx; }, say: () => {}, stop: () => { stops++; } }),
  });
  const repo: Repo = { id: "app", name: "app", path: "/scratch/app", status: null, group: "", source: "root" };
  const run = runner.start(repo, "ask", ACTIONS.ask, "work", DEFAULT_AGENT, undefined, undefined, { branch: { name: "run/member", target: "main", base: "base", dir: "/scratch/member", state: "working", origin: "member" } });
  if (!context) throw new Error("driver absent");
  context.result({ text: "done", durationMs: 1, turns: 1 }, null);
  expect(run.status).toBe("done");
  const stopping = runner.stopAndWait(run.id).then(() => { returned = true; });
  try {
    await Bun.sleep(10);
    expect(stops).toBe(1); expect(returned).toBe(false);
    const beforeExit = settlements;
    context.exited({ code: 0, stderr: "" }); await stopping;
    expect(returned).toBe(true); expect(settlements).toBeGreaterThan(beforeExit);
  } finally { context.exited({ code: 0, stderr: "" }); await stopping; }
});


describe("the run log (FR-043)", () => {
  const roots: string[] = [];
  afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
  const repo: Repo = { id: "replay-repo", name: "r", path: "/owned/replay-repo", group: "", source: "root", status: null };
  const until = async (ready: () => boolean): Promise<void> => {
    for (let n = 0; n < 100 && !ready(); n++) await Bun.sleep(5);
    expect(ready()).toBe(true);
  };
  const disk = async () => {
    const root = await mkdtemp(join(tmpdir(), "canopy-runner-log-")); roots.push(root);
    const dir = join(root, "runs");
    const log = new DiskRunLogger({ dir, env: () => ({}), appliedFile: join(root, "absent-applied") });
    return { root, dir, log };
  };
  const lines = async (dir: string, id: string): Promise<unknown[]> => {
    const file = join(dir, id, WIRE_GZ);
    await until(() => existsSync(file));
    return new TextDecoder().decode(Bun.gunzipSync(await Bun.file(file).bytes())).trim().split("\n").map((line): unknown => JSON.parse(line));
  };
  class WireDriver implements RunDriver {
    readonly label = "Inert driver";
    ctx: DriveCtx | null = null;
    constructor(readonly harness: Harness = "claude", private auto = true) {}
    check() { return null; }
    start(ctx: DriveCtx, message: string) {
      this.ctx = ctx;
      ctx.wire("in", JSON.stringify({ type: "user", text: message, env: ctx.env }));
      ctx.wire("out", '{"type":"system","subtype":"init","session_id":"session-1"}');
      ctx.session("session-1");
      if (this.auto) { this.turn(); if (!ctx.chat) this.exit(); }
    }
    turn(problem: string | null = null) {
      this.ctx?.wire("out", JSON.stringify({ type: "result", text: "ok" }));
      this.ctx?.result({ text: "ok", durationMs: 1, turns: 1 }, problem);
    }
    say(text: string) { this.ctx?.wire("in", JSON.stringify({ type: "user", text })); this.turn(); }
    exit() { this.ctx?.wire("out", '{"type":"final","text":"after result"}'); this.ctx?.exited({ code: 0, stderr: "" }); }
    stop() { this.exit(); }
  }

  test("a job records argv, both wires and redacted run env, then keeps its final snapshot", async () => {
    const { dir, log } = await disk();
    const runner = new Runner({ onChange: () => {}, onGone: () => {} }, { driver: () => new WireDriver(), log, backend: "fixture-backend" });
    const run = runner.start(repo, "ask", ACTIONS.ask, "inspect", DEFAULT_AGENT, undefined, undefined, undefined, { env: { CANOPY_REPLAY: "synthetic-extra" } });
    const wire = await lines(dir, run.id);
    expect(wire[0]).toMatchObject({ canopy: "start", run: run.id, repo: repo.id, harness: "claude", argv: expect.arrayContaining(["claude", "-p"]) });
    const incoming = wire[1];
    if (typeof incoming !== "object" || incoming === null || !("line" in incoming)) throw new Error("missing input record");
    expect(incoming.line).toContain('"CANOPY_BACKEND":"<redacted:CANOPY_BACKEND>"');
    expect(incoming.line).toContain('"CANOPY_REPLAY":"<redacted:CANOPY_REPLAY>"');
    expect(wire[2]).toMatchObject({ type: "system", session_id: "session-1" });
    expect(wire.slice(-2)).toEqual([{ type: "final", text: "after result" }, { canopy: "end", at: expect.any(Number), status: "done" }]);
    expect(await readKeptRun(dir, run.id)).toMatchObject({ id: run.id, status: "done", session: "session-1", result: { text: "ok" } });
    expect(run.steps.some((s) => s.text?.startsWith("transcript stopped:"))).toBe(false);
  });

  test("a terminal result keeps collecting protocol until actual exit and preserves final branch attribution", async () => {
    const { dir, log } = await disk();
    let afterExit = false;
    class ExitWork extends WireDriver { override exit() { afterExit = true; super.exit(); } }
    const driver = new ExitWork("claude", false);
    let reads = 0;
    const changes: Run[] = [];
    const runner = new Runner({ onChange: (run) => { changes.push(structuredClone(run)); }, onGone: () => {}, branchState: async () => { reads++; return afterExit ? "ready" : "working"; } }, { driver: () => driver, log });
    const run = runner.start(repo, "ask", ACTIONS.ask, "inspect", DEFAULT_AGENT, undefined, undefined,
      { branch: { name: "run/replay", target: "main", base: "base", dir: "/owned/work", origin: "origin", state: "working", group: "batch-route" }, resume: "resume-fixture" },
      { priority: "low" });
    expect(changes[0]).toMatchObject({ group: "batch-route", priority: "low", branch: { group: "batch-route" } });
    driver.turn();
    expect(run.status).toBe("done");
    await Bun.sleep(15);
    expect(existsSync(join(dir, run.id, WIRE_GZ))).toBe(false);
    expect(reads).toBe(0);
    driver.exit();
    const wire = await lines(dir, run.id);
    expect(wire[0]).toMatchObject({ argv: expect.arrayContaining(["--resume", "resume-fixture"]) });
    expect(wire.slice(-2)).toMatchObject([{ type: "final" }, { canopy: "end", status: "done" }]);
    expect(await readKeptRun(dir, run.id)).toMatchObject({ group: "batch-route", priority: "low", branch: { group: "batch-route", state: "ready" }, outcome: "changed" });
    expect(reads).toBe(1);
    driver.exit();
    expect((await lines(dir, run.id)).filter((line) => typeof line === "object" && line !== null && "canopy" in line && line.canopy === "end")).toHaveLength(1);
  });

  test("stopAndWait waits for a terminal driver's actual exit without cycling through log settlement", async () => {
    const { dir, log } = await disk();
    class SlowStop extends WireDriver { stopped = false; override stop() { this.stopped = true; } }
    const driver = new SlowStop("claude", false);
    const runner = new Runner({ onChange: () => {}, onGone: () => {} }, { driver: () => driver, log });
    const run = runner.start(repo, "ask", ACTIONS.ask, "inspect"); driver.turn();
    let returned = false;
    const stopping = runner.stopAndWait(run.id).then(() => { returned = true; });
    await Bun.sleep(10);
    expect(driver.stopped).toBe(true); expect(returned).toBe(false);
    driver.exit(); await stopping;
    expect(returned).toBe(true);
    expect((await lines(dir, run.id)).at(-1)).toMatchObject({ canopy: "end", status: "done" });
  });

  test("a tracked stage seed stays busy and keeps its log open until quiet without a status hook", async () => {
    const { dir, log } = await disk();
    let releaseQuiet = (_quiet: boolean) => {};
    const quiet = new Promise<boolean>((resolve) => { releaseQuiet = resolve; });
    class HeldSeed extends StageClient {
      override harnessesNow() { return ["claude"]; }
      override busy() { return quiet; }
    }
    class Tracked extends WireDriver {
      override start(ctx: DriveCtx, message: string) {
        super.start(ctx, message);
        const proc: RpcProc = { stdin: { write() {}, end() {} }, stdout: new ReadableStream({ start(c) { c.close(); } }), exited: Promise.resolve(0), kill() {} };
        if (!ctx.track) throw new Error("missing seed tracker");
        ctx.track(proc);
        this.turn(); this.exit();
      }
    }
    const runner = new Runner({ onChange: () => {}, onGone: () => {} }, { driver: () => new Tracked("claude", false), log, stage: () => true, stageExec: () => new HeldSeed("/unused-fixture-socket") });
    const run = runner.start(repo, "ask", ACTIONS.ask, "inspect");
    await Bun.sleep(10);
    expect(run.status).toBe("done"); expect(runner.liveIn(repo.path)).toBe(true);
    expect(existsSync(join(dir, run.id, WIRE_GZ))).toBe(false);
    releaseQuiet(false);
    expect((await lines(dir, run.id)).at(-1)).toMatchObject({ status: "done" });
    expect(runner.liveIn(repo.path)).toBe(false);
  });

  test("a Codex run logs the app-server argv built from resolved extras", async () => {
    const { dir, log } = await disk();
    const runner = new Runner({ onChange: () => {}, onGone: () => {} }, { driver: (h) => new WireDriver(h), log });
    const run = runner.start(repo, "ask", ACTIONS.ask, "inspect", { ...DEFAULT_AGENT, harness: "codex", extra: "--enable fixture --search" });
    expect((await lines(dir, run.id))[0]).toMatchObject({ harness: "codex", argv: ["codex", "app-server", "--listen", "stdio://", "--enable", "fixture"] });
  });

  test("a chat keeps its single wire through turns and closes at its end", async () => {
    const { dir, log } = await disk(); const driver = new WireDriver();
    const runner = new Runner({ onChange: () => {}, onGone: () => {} }, { driver: () => driver, log });
    const run = runner.start(repo, "chat", ACTIONS.chat, "hello");
    runner.say(run.id, "more");
    expect(run.status).toBe("idle");
    expect(existsSync(join(dir, run.id, WIRE_GZ))).toBe(false);
    runner.stop(run.id);
    const wire = await lines(dir, run.id);
    expect(wire.filter((l) => typeof l === "object" && l !== null && "canopy" in l && l.canopy === "start")).toHaveLength(1);
    expect(wire.filter((l) => typeof l === "object" && l !== null && "canopy" in l && l.canopy === "in")).toHaveLength(2);
    expect(wire.at(-1)).toMatchObject({ canopy: "end", status: "done" });
  });

  test("an empty chat and a failed branch prepare settle without starting a process", async () => {
    const { dir, log } = await disk(); let starts = 0;
    class NotStarted extends WireDriver { override start(ctx: DriveCtx, message: string) { starts++; super.start(ctx, message); } }
    const runner = new Runner({ onChange: () => {}, onGone: () => {} }, { driver: () => new NotStarted(), log });
    const chat = runner.start(repo, "chat", ACTIONS.chat, ""); runner.stop(chat.id);
    expect((await lines(dir, chat.id)).at(-1)).toMatchObject({ status: "done" });
    const failed = runner.start(repo, "ask", ACTIONS.ask, "inspect", DEFAULT_AGENT, undefined, undefined, { branch: { name: "run/setup", target: "main", base: "base", dir: "/owned/work", origin: "setup", state: "working" }, prepare: async () => { throw new Error("fixture setup error"); } });
    expect((await lines(dir, failed.id)).at(-1)).toMatchObject({ status: "failed" });
    expect(starts).toBe(0);
  });

  test.each([true, false])("stopping deferred preparation waits for its final state and notes when logging is %s", async (logging) => {
    const { dir, log } = await disk(); const driver = new WireDriver();
    let release = () => {};
    const held = new Promise<void>((resolve) => { release = resolve; });
    let prepared = false;
    let returned = false;
    const reads: boolean[] = [];
    const runner = new Runner({
      onChange: () => {}, onGone: () => {},
      branchState: async () => { reads.push(prepared); return prepared ? "ready" : "nothing"; },
    }, { driver: () => driver, ...(logging ? { log } : {}) });
    const run = runner.start(repo, "ask", ACTIONS.ask, "inspect", DEFAULT_AGENT, undefined, undefined, {
      branch: { name: "run/deferred", target: "main", base: "base", dir: "/owned/work", origin: "deferred", state: "working" },
      prepare: async (say) => { await held; say("late preparation note"); prepared = true; },
    });
    const stopping = runner.stopAndWait(run.id).then(() => { returned = true; });
    try {
      expect(run.status).toBe("stopped");
      // Drain result-time microtasks while preparation stays explicitly held.
      await new Promise<void>((resolve) => { setImmediate(resolve); });
      expect(returned).toBe(false);
      if (logging) {
        expect(await readKeptRun(dir, run.id)).toBeNull();
        expect(reads).toEqual([]);
      } else {
        expect(reads).toEqual([false]);
        expect(run.branch?.state).toBe("nothing");
      }
      release(); await stopping;
      expect(returned).toBe(true);
      expect(driver.ctx).toBeNull();
      expect(run).toMatchObject({ status: "stopped", branch: { state: "ready" }, outcome: "changed" });
      if (logging) {
        const kept = await readKeptRun(dir, run.id);
        expect(kept).toMatchObject({ status: "stopped", branch: { state: "ready" }, outcome: "changed" });
        expect(kept?.steps.some((step) => step.text === "late preparation note")).toBe(true);
        expect((await lines(dir, run.id)).at(-1)).toMatchObject({ canopy: "end", status: "stopped" });
      }
    } finally { release(); await stopping; }
  });

  test("a limited job keeps its limited status after driver exit", async () => {
    const { dir, log } = await disk(); const driver = new WireDriver("claude", false);
    const runner = new Runner({ onChange: () => {}, onGone: () => {} }, { driver: () => driver, log });
    const run = runner.start(repo, "ask", ACTIONS.ask, "inspect");
    driver.turn("usage limit reached"); driver.exit();
    expect((await lines(dir, run.id)).at(-1)).toMatchObject({ status: "limited" });
    expect(await readKeptRun(dir, run.id)).toMatchObject({ status: "limited", limited: { text: "usage limit reached" } });
  });

  test("a stage job and a coordinator chat settle without a status hook", async () => {
    const { dir, log } = await disk();
    class InertStage extends StageClient { override harnessesNow() { return ["claude"]; } }
    const client = new InertStage("/unused-fixture-socket");
    const runner = new Runner({ onChange: () => {}, onGone: () => {} }, { driver: () => new WireDriver(), stage: () => true, stageExec: () => client, coordExec: () => client, log });
    const stage = runner.start(repo, "ask", ACTIONS.ask, "inspect");
    expect((await lines(dir, stage.id)).at(-1)).toMatchObject({ status: "done" });
    const coord = runner.start(repo, "coordinate", ACTIONS.chat, "coordinate", DEFAULT_AGENT, undefined, undefined, undefined, { cwd: "/owned/coordinator", env: { CANOPY_TOKEN: "synthetic-long-private-token" } });
    runner.stop(coord.id);
    expect((await lines(dir, coord.id)).at(-1)).toMatchObject({ status: "done" });
    const coordWire = JSON.stringify(await lines(dir, coord.id));
    expect(coordWire).not.toContain("synthetic-long-private-token");
    expect(coordWire).toContain("<redacted:CANOPY_TOKEN>");
    expect((await readFile(join(dir, coord.id, "run.json"), "utf8"))).not.toContain("synthetic-long-private-token");
  });

  test("a real disk open failure records one note and never blocks startup", async () => {
    const { root } = await disk(); const bad = join(root, "file"); await writeFile(bad, "occupied");
    const log = new DiskRunLogger({ dir: bad, env: () => ({}), appliedFile: join(root, "absent") });
    const runner = new Runner({ onChange: () => {}, onGone: () => {} }, { driver: () => new WireDriver(), log });
    const run = runner.start(repo, "ask", ACTIONS.ask, "inspect");
    await runner.stopAndWait(run.id);
    expect(run.status).toBe("done");
    expect(run.steps.filter((s) => s.text?.startsWith("transcript stopped:"))).toHaveLength(1);
  });

  test("a later real wire write failure reports once and leaves the run free to finish", async () => {
    const { dir, log } = await disk(); const driver = new WireDriver("claude", false);
    const runner = new Runner({ onChange: () => {}, onGone: () => {} }, { driver: () => driver, log });
    const run = runner.start(repo, "ask", ACTIONS.ask, "inspect");
    const write = spyOn(fs, "writeSync").mockImplementation(() => { throw new Error("ENOSPC: synthetic write failure"); });
    try { driver.turn(); driver.exit(); }
    finally { write.mockRestore(); }
    await runner.stopAndWait(run.id);
    expect(run.status).toBe("done");
    expect(run.steps.filter((s) => s.text === "transcript stopped: ENOSPC: synthetic write failure")).toHaveLength(1);
    expect(existsSync(join(dir, run.id, WIRE_GZ))).toBe(false);
  });

  test("a throwing logger and repeated synchronous error callbacks produce one note each", async () => {
    const logs: RunLogger[] = [
      { open: () => { throw new Error("synthetic open error"); } },
      { open: (_run, _argv, _env, onError) => { onError("synthetic callback error"); onError("second error"); return null; } },
    ];
    for (const log of logs) {
      const runner = new Runner({ onChange: () => {}, onGone: () => {} }, { driver: () => new WireDriver(), log });
      const run = runner.start(repo, "ask", ACTIONS.ask, "inspect");
      await runner.stopAndWait(run.id);
      expect(run.status).toBe("done");
      expect(run.steps.filter((s) => s.text?.startsWith("transcript stopped:"))).toHaveLength(1);
    }
  });

  test("without a logger wire recording has no timeline side effects", async () => {
    const runner = new Runner({ onChange: () => {}, onGone: () => {} }, { driver: () => new WireDriver() });
    const run = runner.start(repo, "ask", ACTIONS.ask, "inspect");
    await runner.stopAndWait(run.id);
    expect(run.status).toBe("done"); expect(run.steps).toEqual([]);
  });
});


test("FR-043 startArgv follows each harness and stage settings", () => {
  expect(startArgv("claude", { allowedTools: [], maxTurns: 5, resume: "fixture-session" }, DEFAULT_AGENT, false)).toEqual(expect.arrayContaining(["claude", "-p", "--resume", "fixture-session"]));
  const staged = startArgv("claude", ACTIONS.ask, { ...DEFAULT_AGENT, yolo: false }, true);
  expect(staged.slice(staged.indexOf("--setting-sources"), staged.indexOf("--setting-sources") + 2)).toEqual(["--setting-sources", "user"]);
  expect(startArgv("codex", ACTIONS.ask, { ...DEFAULT_AGENT, harness: "codex", extra: "--enable fixture" }, false)).toEqual(["codex", "app-server", "--listen", "stdio://", "--enable", "fixture"]);
});
