import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudeDriver } from "../core/claudedrive";
import { spawnEnv, type DriveCtx, type RunDriver } from "../core/driver";
import type { FlowFile } from "../core/flowstore";
import { parseWorkflow } from "../core/workflow";
import { RunLog } from "../core/runlog";
import type { KeptRunHead, LandEntry, LandingRun, PrWatch, Run, SweepInfo } from "../core/types";
import { startServer } from "./index";

let scratch: string;
let previous: NodeJS.ProcessEnv;
let server: Awaited<ReturnType<typeof startServer>>;
const others: Awaited<ReturnType<typeof startServer>>[] = [];
const options = () => ({ root: join(scratch, "root"), port: 0, chan: null, harnesses: ["claude" as const], runner: { driver: () => new ClaudeDriver({ command: [process.execPath, join(import.meta.dir, "../core/testdata/fake-claude.ts")] }) } });
const url = (path: string) => `http://127.0.0.1:${server.port}${path}`;
const call = (path: string, body?: unknown) => fetch(url(path), { method: "POST", ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const runOf = async (id: string) => ((await (await fetch(url("/api/runs"))).json()) as Run[]).find((r) => r.id === id);
async function until(read: () => Promise<boolean>, what: string): Promise<void> {
  const start = Date.now();
  while (!(await read())) { if (Date.now() - start > 10000) throw new Error(`waiting for ${what}`); await Bun.sleep(20); }
}
async function startChat(note = "hello"): Promise<string> {
  const res = await call("/api/repos/run?id=proj", { action: "chat", note });
  expect(res.status).toBe(201);
  const run = await res.json() as Run;
  await until(async () => (await runOf(run.id))?.status === "idle", "chat reply");
  return run.id;
}
async function restart(): Promise<void> { await server.stop(); server = await startServer(options()); }
function kept(id: string, origin?: string): Run {
  return { id, repoId: "proj", action: "chat", verb: "Chat", progress: "", expectsChange: false, chat: true, harness: "claude", note: "", status: "done", startedAt: 1, endedAt: 2, steps: [], prompt: null, ...(origin ? { branch: { name: "run/old", target: "main", base: "abc", dir: "unused", state: "stopped" as const, origin } } : {}) };
}
async function seed(run: Run): Promise<void> {
  const log = new RunLog({ dir: join(scratch, "config/runs"), run, argv: [], secrets: [], onError: (why) => { throw new Error(why); } });
  await log.settle(run);
}
beforeEach(async () => {
  previous = { ...process.env };
  scratch = await mkdtemp(join(tmpdir(), "canopy-runlog-"));
  process.env["CANOPY_CONFIG_DIR"] = join(scratch, "config");
  process.env["FAKE_CLAUDE_MODE"] = "chat";
  process.env["CANOPY_CALLERS"] = "log";
  await mkdir(join(scratch, "root/proj"), { recursive: true });
  expect(Bun.spawnSync(["git", "init", "-q"], { cwd: join(scratch, "root/proj") }).exitCode).toBe(0);
  server = await startServer(options());
});
afterEach(async () => {
  for (const other of others.splice(0)) await other.stop();
  await server.stop();
  for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
  Object.assign(process.env, previous);
  await rm(scratch, { recursive: true, force: true });
});

test("live memory, restart recovery, kept list, export, validation and admin prune", async () => {
  const id = await startChat();
  expect((await call("/api/runs/stop", { id })).status).toBe(200);
  await until(async () => (await runOf(id))?.status === "done", "chat end");
  expect((await (await fetch(url(`/api/runs/${id}`))).json() as Run).kept).toBeUndefined();
  const folder = join(scratch, "config/runs", id);
  await until(async () => existsSync(join(folder, "wire.jsonl.gz")), "transcript settlement");
  await mkdir(join(scratch, "config/runs/zz1"), { recursive: true });
  await writeFile(join(scratch, "config/runs/zz1/wire.jsonl"), `${JSON.stringify({ canopy: "start", at: 5, run: "zz1", repo: "proj", action: "ask", harness: "claude", argv: [] })}\n`);
  await restart();
  expect(await (await fetch(url(`/api/runs/${id}`))).json()).toMatchObject({ id, kept: true, status: "done" });
  expect(await (await fetch(url("/api/runs/zz1"))).json()).toMatchObject({ id: "zz1", kept: true, status: "stopped" });
  expect(existsSync(join(scratch, "config/runs/zz1/wire.jsonl.gz"))).toBe(true);
  const heads = await (await fetch(url("/api/runs?kept=1"))).json() as KeptRunHead[];
  expect(heads.map((h) => h.id).sort()).toEqual([id, "zz1"].sort());
  expect(heads[0]?.ended).toBeGreaterThanOrEqual(heads[1]?.ended ?? 0);
  const exported = await fetch(url(`/api/runs/${id}/export`));
  expect(exported.headers.get("content-type")).toContain("text/markdown");
  expect(await exported.text()).toContain(`- run: ${id}\n`);
  for (const bad of ["../x", "nothere", "x%2Fy", "a".repeat(65)]) expect((await fetch(url(`/api/runs/${bad}`))).status).toBe(404);
  expect(await (await call("/api/runs/prune")).json()).toEqual({ removed: [], kept: 2 });
});

test("shutdown drains a running logged process before another owner recovers", async () => {
  const id = await startChat();
  await restart();
  expect(await (await fetch(url(`/api/runs/${id}`))).json()).toMatchObject({ id, kept: true, status: "done" });
  const raw = await readFile(join(scratch, "config/runs", id, "wire.jsonl.gz"));
  const wire = new TextDecoder().decode(Bun.gunzipSync(raw));
  expect(wire).toContain('"canopy":"end"');
  expect(wire).toContain('"type":"result"');
});

test("secondary servers keep live memory but cannot read or capture shared transcripts, then take over safely", async () => {
  const id = await startChat();
  const owner = server;
  server = await startServer(options());
  others.push(owner);
  expect((await fetch(url(`/api/runs/${id}`))).status).toBe(503);
  expect((await fetch(url("/api/runs?kept=1"))).status).toBe(503);
  const local = await startChat();
  expect((await fetch(url(`/api/runs/${local}`))).status).toBe(200);
  expect(existsSync(join(scratch, "config/runs", local))).toBe(false);
  await owner.stop(); others.splice(others.indexOf(owner), 1);
  expect((await call("/api/health/heal?id=canopy%3Aflows")).status).toBe(200);
  await until(async () => (await fetch(url(`/api/runs/${id}`))).status === 200, "record takeover");
  expect((await runOf(local))?.status).toBe("idle");
});

test("invalid applied source blocks persisted reads until repaired and recovery is safe", async () => {
  await seed(kept("old"));
  await writeFile(join(scratch, "config/secrets-applied.json"), "broken");
  await restart();
  expect((await fetch(url("/api/runs/old"))).status).toBe(503);
  expect((await fetch(url("/api/runs?kept=1"))).status).toBe(503);
  expect((await fetch(url("/api/runs"))).status).toBe(200);
  await writeFile(join(scratch, "config/secrets-applied.json"), "{}");
  expect((await fetch(url("/api/runs/old"))).status).toBe(200);
});

test("private and trigger values survive env stripping for capture and export", async () => {
  await server.stop();
  process.env["CANOPY_VOICE_KEY"] = "voice-private-example";
  process.env["CANOPY_TRIGGER_EXAMPLE"] = "  trigger-private-example  ";
  server = await startServer(options());
  expect(process.env["CANOPY_VOICE_KEY"]).toBeUndefined();
  expect(process.env["CANOPY_TRIGGER_EXAMPLE"]).toBeUndefined();
  const id = await startChat("voice-private-example trigger-private-example");
  const text = await (await fetch(url(`/api/runs/${id}/export`))).text();
  expect(text).not.toContain("voice-private-example");
  expect(text).not.toContain("trigger-private-example");
  await server.stop();
  const raw = await readFile(join(scratch, "config/runs", id, "run.json"), "utf8");
  expect(raw).not.toContain("voice-private-example");
  expect(raw).not.toContain("trigger-private-example");
});


test("prune and sweep protect active, held and PR aliases and remove expired folders", async () => {
  await server.stop();
  const repoPath = join(scratch, "root/proj");
  const record: LandingRun = { id: "held-origin", runId: "latest-held", repoId: "proj", repoPath, branch: "run/held", target: "main", base: "abc", dir: repoPath, note: "held", verb: "Build", harness: "claude", state: "nothing", startedAt: 1 };
  await mkdir(join(scratch, "config/landing/runs"), { recursive: true });
  await writeFile(join(scratch, "config/landing/runs/held-origin.json"), JSON.stringify(record));
  await mkdir(join(scratch, "config/prs"), { recursive: true });
  const watch = (id: string, number: number): PrWatch => ({ id, runId: `latest-${id}`, repoId: "proj", repoPath, branch: `run/${id}`, target: "main", dir: repoPath, note: "watch", slug: "example/proj", remote: "origin", number, url: `https://github.com/example/proj/pull/${number}`, autoFix: false, autoMerge: false, pushed: "abc", attempts: {}, seenComment: 0, openedAt: 1, updatedAt: 1 });
  const unknown = watch("unknown-pr", 1);
  const open = { ...watch("open-pr", 2), state: { number: 2, url: "https://github.com/example/proj/pull/2", status: "open" as const, draft: false, additions: 1, deletions: 0, files: 1, head: "abc", mergeable: "MERGEABLE", mergeState: "CLEAN", review: "none" as const, checks: [] } } satisfies PrWatch;
  for (const w of [unknown, open]) await writeFile(join(scratch, "config/prs", `${w.id}.json`), JSON.stringify(w));
  for (const run of [kept("held-origin"), kept("held-alias", "held-origin"), kept("unknown-alias", "unknown-pr"), kept("open-alias", "open-pr"), kept("expired")]) await seed(run);
  server = await startServer(options());
  const active = await startChat();
  await seed(kept("active-alias", active));
  // A live run's id itself is protected even if an old snapshot names it.
  await writeFile(join(scratch, "config/runs", active, "run.json"), JSON.stringify(kept(active)));
  const plan = await (await fetch(url("/api/sweep"))).json() as SweepInfo;
  expect(plan.items.filter((i) => i.kind === "transcript").map((i) => i.id)).toEqual(["expired"]);
  const close = await call("/api/sweep", { keys: ["transcript:expired", "transcript:held-alias", "transcript:unknown-alias", "transcript:open-alias", "transcript:active-alias"] });
  expect(await close.json()).toMatchObject({ outcomes: [{ key: "transcript:expired", result: "closed" }, { key: "transcript:held-alias", result: "in use now" }, { key: "transcript:unknown-alias", result: "in use now" }, { key: "transcript:open-alias", result: "in use now" }, { key: "transcript:active-alias", result: "in use now" }] });
  expect(existsSync(join(scratch, "config/runs/expired"))).toBe(false);
  await seed(kept("expired-again"));
  expect(await (await call("/api/runs/prune")).json()).toEqual({ removed: ["expired-again"], kept: 6 });
  for (const id of [active, "active-alias", "held-origin", "held-alias", "unknown-alias", "open-alias"]) expect(existsSync(join(scratch, "config/runs", id))).toBe(true);
});

test("export uses the branch origin for retained landed entries and PR watches", async () => {
  await server.stop();
  const repoPath = join(scratch, "root/proj");
  const landed: LandEntry = { id: "branch-origin", repoId: "proj", repoPath, branch: "run/old", target: "release", dir: repoPath, note: "retained", state: "landed", tries: 1, queuedAt: 1, updatedAt: 2, landedAt: 2 };
  await mkdir(join(scratch, "config/landing/queue"), { recursive: true });
  await writeFile(join(scratch, "config/landing/queue/retained.json"), JSON.stringify([landed]));
  const watch: PrWatch = { id: "pr-origin", runId: "latest", repoId: "proj", repoPath, branch: "run/pr", target: "main", dir: repoPath, note: "watch", slug: "example/proj", remote: "origin", number: 7, url: "https://github.com/example/proj/pull/7", autoFix: false, autoMerge: false, pushed: "abc", attempts: {}, seenComment: 0, openedAt: 1, updatedAt: 1 };
  await mkdir(join(scratch, "config/prs"), { recursive: true });
  await writeFile(join(scratch, "config/prs/pr-origin.json"), JSON.stringify(watch));
  await seed(kept("later-run", "branch-origin"));
  await seed(kept("pr-run", "pr-origin"));
  server = await startServer(options());
  expect((await (await fetch(url(`/api/runs/later-run/export`))).text())).toContain("landed on release");
  expect((await (await fetch(url(`/api/runs/pr-run/export`))).text())).toContain("PR #7 unknown");
});


test("recovery waits for current secrets and sanitizes landing hints captured before env stripping", async () => {
  await server.stop();
  process.env["CANOPY_TRIGGER_RECOVERY"] = "recovery-private-value";
  const record: LandingRun = { id: "hint-origin", runId: "orphan", repoId: "proj", repoPath: join(scratch, "root/proj"), branch: "run/hint", target: "main", base: "abc", dir: join(scratch, "root/proj"), note: "recovery-private-value", verb: "Build", harness: "claude", state: "nothing", startedAt: 1, session: "recovery-private-value" };
  await mkdir(join(scratch, "config/landing/runs"), { recursive: true });
  await writeFile(join(scratch, "config/landing/runs/hint-origin.json"), JSON.stringify(record));
  await mkdir(join(scratch, "config/runs/orphan"), { recursive: true });
  await writeFile(join(scratch, "config/runs/orphan/wire.jsonl"), `${JSON.stringify({ canopy: "start", at: 5, run: "orphan", repo: "proj", action: "ask", harness: "claude", argv: [] })}\n`);
  await writeFile(join(scratch, "config/secrets-applied.json"), "broken");
  server = await startServer(options());
  expect((await fetch(url("/api/runs/orphan"))).status).toBe(503);
  expect(existsSync(join(scratch, "config/runs/orphan/run.json"))).toBe(false);
  await writeFile(join(scratch, "config/secrets-applied.json"), "{}");
  expect(await (await fetch(url("/api/runs/orphan"))).json()).toMatchObject({ id: "orphan", branch: { origin: "hint-origin" }, note: "<redacted:CANOPY_TRIGGER_RECOVERY>", session: "<redacted:CANOPY_TRIGGER_RECOVERY>" });
  expect(await readFile(join(scratch, "config/runs/orphan/run.json"), "utf8")).not.toContain("recovery-private-value");
});


test.each(["visible terminal", "dismissed", "trimmed"])("retention preserves a %s pending log until driver exit", async (visibility) => {
  await server.stop();
  class Terminal implements RunDriver {
    readonly harness = "claude";
    readonly label = "Inert delayed exit";
    ctx: DriveCtx | null = null;
    constructor(private delayed: boolean) {}
    check() { return null; }
    start(ctx: DriveCtx) { this.ctx = ctx; ctx.wire("out", '{"type":"result","result":"done"}'); ctx.result({ text: "done", durationMs: 1, turns: 1 }, null); if (!this.delayed) this.exit(); }
    say() {}
    stop() {}
    exit() { if (!this.ctx) return; const ctx = this.ctx; this.ctx = null; ctx.wire("out", '{"type":"final","text":"trailing protocol"}'); ctx.exited({ code: 0, stderr: "" }); }
  }
  const delayed = new Terminal(true);
  let first = true;
  server = await startServer({ ...options(), runner: { driver: () => { if (first) { first = false; return delayed; } return new Terminal(false); } } });
  try {
    const run = await (await call("/api/repos/run?id=proj", { action: "ask", note: "finish before exit" })).json() as Run;
    const file = join(scratch, "config/runs", run.id, "wire.jsonl");
    // Make the real pending head old enough to qualify for both retention paths.
    const wire = await readFile(file, "utf8");
    const at = wire.indexOf("\n");
    const head: unknown = JSON.parse(wire.slice(0, at));
    if (typeof head !== "object" || head === null) throw new Error("missing header");
    await writeFile(file, JSON.stringify({ ...head, at: 1 }) + wire.slice(at));
    await utimes(file, new Date(2), new Date(2));
    await seed(kept("pending-alias", run.id));
    if (visibility === "dismissed") await fetch(url(`/api/runs?id=${run.id}`), { method: "DELETE" });
    if (visibility === "trimmed") for (let i = 0; i < 62; i++) expect((await call("/api/repos/run?id=proj", { action: "ask", note: "another" })).status).toBe(201);
    expect(Boolean(await runOf(run.id))).toBe(visibility === "visible terminal");
    const plan = await (await fetch(url("/api/sweep"))).json() as SweepInfo;
    expect(plan.items.filter((i) => i.kind === "transcript").map((i) => i.id)).not.toContain(run.id);
    expect(plan.items.filter((i) => i.kind === "transcript").map((i) => i.id)).not.toContain("pending-alias");
    expect(await (await call("/api/sweep", { keys: [`transcript:${run.id}`, "transcript:pending-alias"] })).json()).toMatchObject({ outcomes: [{ key: `transcript:${run.id}`, result: "in use now" }, { key: "transcript:pending-alias", result: "in use now" }] });
    expect((await (await call("/api/runs/prune")).json() as { removed: string[] }).removed).not.toContain(run.id);
    expect(existsSync(file)).toBe(true);
    delayed.exit();
    const gzip = join(scratch, "config/runs", run.id, "wire.jsonl.gz");
    await until(async () => existsSync(gzip), "pending log completion");
    expect(new TextDecoder().decode(Bun.gunzipSync(await readFile(gzip)))).toContain("trailing protocol");
    expect(JSON.parse(await readFile(join(scratch, "config/runs", run.id, "run.json"), "utf8"))).toMatchObject({ id: run.id, status: "done", result: { text: "done" } });
    expect((await (await call("/api/runs/prune")).json() as { removed: string[] }).removed).toContain("pending-alias");
  } finally { delayed.exit(); }
});

test.each(["startup", "takeover"])("a saved active flow is logged before its first restored event on %s", async (mode) => {
  let driverStarts = 0;
  class LoggedRestore extends ClaudeDriver {
    override start(ctx: DriveCtx, message: string) {
      expect(existsSync(join(scratch, "config/runs", ctx.env["CANOPY_RUN"] ?? "missing", "wire.jsonl"))).toBe(true);
      driverStarts++;
      super.start(ctx, message);
    }
  }
  const restoreOptions = () => ({ ...options(), runner: { driver: () => new LoggedRestore({ command: [process.execPath, join(import.meta.dir, "../core/testdata/fake-claude.ts")] }) } });
  const root = await realpath(join(scratch, "root"));
  const parsed = parseWorkflow("---\nblurb: saved\n---\n\n## Inspect\n\ninspect\n", { name: "saved-replay", source: "user", file: join(scratch, "saved.md") });
  if (!parsed.ok) throw new Error(parsed.error);
  const record: FlowFile = { v: 1, root, repoPath: join(root, "proj"), before: "", savedAt: 1, workflow: parsed.workflow, flow: { id: "abcdef12", repoId: "proj", workflow: "saved-replay", verb: "Replay", note: "restore me", status: "working", steps: [{ name: "Inspect", status: "running", runId: "previous-run", session: "saved-session", harness: "claude" }], current: 0, startedAt: 1 } };
  if (mode === "startup") await server.stop();
  await mkdir(join(scratch, "config/flows"), { recursive: true });
  await writeFile(join(scratch, "config/flows/abcdef12.json"), JSON.stringify(record));
  if (mode === "takeover") {
    const owner = server;
    server = await startServer(restoreOptions());
    others.push(owner);
    await owner.stop(); others.splice(others.indexOf(owner), 1);
    expect((await call("/api/health/heal?id=canopy%3Aflows")).status).toBe(200);
  } else server = await startServer(restoreOptions());
  let restored: Run | undefined;
  await until(async () => { restored = (await (await fetch(url("/api/runs"))).json() as Run[]).find((r) => r.action === "saved-replay"); return restored !== undefined; }, "restored step");
  if (!restored) throw new Error("restored run missing");
  expect(driverStarts).toBe(1);
  const id = restored.id;
  await until(async () => (await runOf(id))?.status === "done", "restored step result");
  await server.stop();
  const gzip = join(scratch, "config/runs", id, "wire.jsonl.gz");
  expect(existsSync(gzip)).toBe(true);
  const wire = new TextDecoder().decode(Bun.gunzipSync(await readFile(gzip)));
  expect(wire.split("\n")[0]).toContain('"canopy":"start"');
  expect(wire).toContain('"type":"system"');
  expect(wire).toContain('"type":"result"');
  expect(wire).toContain('"canopy":"end"');
  expect(JSON.parse(await readFile(join(scratch, "config/runs", id, "run.json"), "utf8"))).toMatchObject({ id, status: "done", flowStep: { workflow: "saved-replay", step: "Inspect" }, result: { text: "reply 1" } });
});


test("early removed private and inherited values stay redacted on disk and export across chat turns", async () => {
  await server.stop();
  const credential = "scratch-private-credential-572839";
  const inherited = "scratch-inherited-term-615298";
  const triggerRaw = "  scratch-trigger-effective-917264  ";
  const echo = `${credential} ${inherited} ${triggerRaw}`;
  process.env["CANOPY_TAILCHAN_ANSWER_TOKEN"] = credential;
  process.env["CANOPY_TERM"] = inherited;
  process.env["CANOPY_TRIGGER_EARLY"] = triggerRaw;
  const childChecks: unknown[] = [];
  class Echo implements RunDriver {
    readonly harness = "claude";
    readonly label = "Inert privacy echo";
    ctx: DriveCtx | null = null;
    check() { return null; }
    start(ctx: DriveCtx) {
      this.ctx = ctx;
      const child = Bun.spawnSync([process.execPath, "-e", 'process.stdout.write(JSON.stringify([process.env["CANOPY_TAILCHAN_ANSWER_TOKEN"] ?? null, process.env["CANOPY_TERM"] ?? null, process.env["CANOPY_TRIGGER_EARLY"] ?? null]))'], { env: spawnEnv(ctx), stdout: "pipe" });
      expect(child.exitCode).toBe(0);
      childChecks.push(JSON.parse(new TextDecoder().decode(child.stdout)));
      this.turn();
    }
    turn() { const ctx = this.ctx; if (!ctx) throw new Error("no chat"); ctx.wire("out", JSON.stringify({ type: "assistant", text: echo })); ctx.note(echo); ctx.step({ kind: "tool", tool: { name: "Echo", title: echo, output: echo, status: "ok" } }); ctx.result({ text: echo, durationMs: 1, turns: 1 }, null); }
    say() { this.turn(); }
    stop() { this.ctx?.wire("out", JSON.stringify({ type: "final", text: echo })); this.ctx?.exited({ code: 0, stderr: "" }); }
  }
  server = await startServer({ ...options(), runner: { driver: () => new Echo() } });
  expect(process.env["CANOPY_TAILCHAN_ANSWER_TOKEN"]).toBeUndefined();
  expect(process.env["CANOPY_TERM"]).toBeUndefined();
  expect(process.env["CANOPY_TRIGGER_EARLY"]).toBeUndefined();
  const id = await startChat(echo);
  expect(childChecks).toEqual([[null, null, null]]);
  const folder = join(scratch, "config/runs", id);
  const firstWire = await readFile(join(folder, "wire.jsonl"), "utf8");
  for (const value of [credential, inherited, triggerRaw.trim()]) expect(firstWire).not.toContain(value);
  expect((await call("/api/runs/say", { id, text: echo })).status).toBe(200);
  await until(async () => (await runOf(id))?.status === "idle", "second echo turn");
  const exported = await (await fetch(url(`/api/runs/${id}/export`))).text();
  expect((await call("/api/runs/stop", { id })).status).toBe(200);
  await until(async () => existsSync(join(folder, "wire.jsonl.gz")), "echo settlement");
  const wire = new TextDecoder().decode(Bun.gunzipSync(await readFile(join(folder, "wire.jsonl.gz"))));
  const stored = await readFile(join(folder, "run.json"), "utf8");
  for (const text of [wire, stored, exported]) {
    for (const value of [credential, inherited, triggerRaw.trim()]) expect(text).not.toContain(value);
    expect(text).toContain("<redacted:CANOPY_TAILCHAN_ANSWER_TOKEN>");
    expect(text).toContain("<redacted:CANOPY_TERM>");
  }
  expect(JSON.parse(stored)).toMatchObject({ id, repoId: "proj", status: "done" });
});
