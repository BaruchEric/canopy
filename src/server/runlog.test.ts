import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudeDriver } from "../core/claudedrive";
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
