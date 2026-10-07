/**
 * Plan, then build over the API, through the fake Claude CLI in propose
 * mode: the proposal prompt with its plan, approve, revise, and an answer
 * that does not fit a proposal.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudeDriver } from "../core/claudedrive";
import type { Run } from "../core/types";
import { startServer } from "./index";

const FAKE = join(import.meta.dir, "..", "core", "testdata", "fake-claude.ts");

let scratch: string;
let previousConfig: string | undefined;
let previousMode: string | undefined;
let server: { port: number; stop: () => void };

const url = (p: string) => `http://127.0.0.1:${server.port}${p}`;
const call = (p: string, body: unknown) => fetch(url(p), { method: "POST", body: JSON.stringify(body) });
const runOf = async (id: string) => ((await (await fetch(url("/api/runs"))).json()) as Run[]).find((r) => r.id === id);

async function until<T>(read: () => Promise<T | null | undefined | false>, what: string, ms = 10_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const got = await read();
    if (got) return got;
    if (Date.now() - start > ms) throw new Error(`gave up waiting for ${what}`);
    await Bun.sleep(30);
  }
}

const proposalOf = (id: string, plan?: string) =>
  until(async () => {
    const r = await runOf(id);
    return r?.prompt?.kind === "proposal" && (plan === undefined || r.prompt.plan.includes(plan)) ? r : null;
  }, `a proposal${plan ? ` with ${plan}` : ""}`);

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "canopy-propose-"));
  previousConfig = process.env["CANOPY_CONFIG_DIR"];
  previousMode = process.env["FAKE_CLAUDE_MODE"];
  process.env["CANOPY_CONFIG_DIR"] = join(scratch, "config");
  process.env["FAKE_CLAUDE_MODE"] = "propose";
  const root = join(scratch, "root");
  await mkdir(join(root, "proj"), { recursive: true });
  Bun.spawnSync(["git", "init", "-q"], { cwd: join(root, "proj") });
  server = await startServer({
    root,
    port: 0,
    chan: null,
    harnesses: ["claude"],
    runner: { driver: () => new ClaudeDriver({ command: [process.execPath, FAKE] }) },
  });
});

afterAll(async () => {
  server.stop();
  if (previousConfig === undefined) delete process.env["CANOPY_CONFIG_DIR"];
  else process.env["CANOPY_CONFIG_DIR"] = previousConfig;
  if (previousMode === undefined) delete process.env["FAKE_CLAUDE_MODE"];
  else process.env["FAKE_CLAUDE_MODE"] = previousMode;
  await rm(scratch, { recursive: true, force: true });
});

test("propose: start, the proposal over the API, approve, build, done", async () => {
  const start = await call("/api/repos/run?id=proj", { action: "propose", note: "add a function" });
  expect(start.status).toBe(201);
  const { id } = (await start.json()) as Run;
  const waiting = await proposalOf(id, "add it");
  expect(waiting.status).toBe("waiting");
  const prompt = waiting.prompt;
  if (prompt?.kind !== "proposal") throw new Error("not a proposal");
  expect(prompt.plan).toContain("# Plan");
  const ans = await call("/api/runs/answer", { id, promptId: prompt.id, answer: { kind: "approve", auto: false } });
  expect(ans.status).toBe(200);
  const done = await until(async () => {
    const r = await runOf(id);
    return r?.status === "done" ? r : null;
  }, "the run to finish");
  expect(done.result?.text).toBe("approved");
  expect(done.todos?.[0]?.status).toBe("completed");
});

test("propose: a revise brings a second proposal, then approve", async () => {
  const { id } = (await (await call("/api/repos/run?id=proj", { action: "propose", note: "again" })).json()) as Run;
  const first = await proposalOf(id, "# Plan\n");
  const p1 = first.prompt;
  if (p1?.kind !== "proposal") throw new Error("not a proposal");
  const revise = await call("/api/runs/answer", { id, promptId: p1.id, answer: { kind: "deny", message: "also test it" } });
  expect(revise.status).toBe(200);
  const second = await proposalOf(id, "Plan v2");
  const p2 = second.prompt;
  if (p2?.kind !== "proposal") throw new Error("not a proposal");
  expect(p2.id).not.toBe(p1.id);
  expect((await call("/api/runs/answer", { id, promptId: p2.id, answer: { kind: "approve", auto: false } })).status).toBe(200);
  await until(async () => (await runOf(id))?.status === "done", "the run to finish");
});

test("propose: an allow or allow-all to a proposal is refused and the proposal stays", async () => {
  const { id } = (await (await call("/api/repos/run?id=proj", { action: "propose", note: "misfit" })).json()) as Run;
  const waiting = await proposalOf(id);
  const prompt = waiting.prompt;
  if (prompt?.kind !== "proposal") throw new Error("not a proposal");
  for (const answer of [{ kind: "allow" }, { kind: "allow-all" }, { kind: "answers", answers: {} }]) {
    const r = await call("/api/runs/answer", { id, promptId: prompt.id, answer });
    expect(r.status).toBe(400);
  }
  expect((await runOf(id))?.prompt?.id).toBe(prompt.id);
  // turning it down is still an answer; the fake brings a second plan after the first deny, and ends on the next
  expect((await call("/api/runs/answer", { id, promptId: prompt.id, answer: { kind: "deny" } })).status).toBe(200);
  const second = await proposalOf(id, "Plan v2");
  expect(second.prompt?.id).not.toBe(prompt.id);
  expect((await call("/api/runs/answer", { id, promptId: second.prompt?.id, answer: { kind: "deny" } })).status).toBe(200);
  await until(async () => (await runOf(id))?.status === "done", "the declined run to end");
  expect((await runOf(id))?.result?.text).toBe("declined");
});

test("an answer to a prompt that is not waiting is a 409, and one to a run canopy does not know a 404", async () => {
  const { id } = (await (await call("/api/repos/run?id=proj", { action: "propose", note: "stale" })).json()) as Run;
  const first = (await proposalOf(id)).prompt;
  if (first?.kind !== "proposal") throw new Error("not a proposal");
  expect((await call("/api/runs/answer", { id, promptId: first.id, answer: { kind: "deny" } })).status).toBe(200);
  const second = (await proposalOf(id, "Plan v2")).prompt;
  if (second?.kind !== "proposal") throw new Error("not a proposal");
  // the first one again (answered already), and an id no prompt ever had
  for (const promptId of [first.id, ""]) {
    const stale = await call("/api/runs/answer", { id, promptId, answer: { kind: "deny" } });
    expect(stale.status).toBe(409);
    expect(((await stale.json()) as { error: string }).error).toBe("that prompt is no longer waiting");
  }
  const unknown = await call("/api/runs/answer", { id: "nope", promptId: "p1", answer: { kind: "deny" } });
  expect(unknown.status).toBe(404);
  expect(((await unknown.json()) as { error: string }).error).toBe("no such run");
  // the plan that waits is untouched
  expect((await runOf(id))?.prompt?.id).toBe(second.id);
  expect((await call("/api/runs/answer", { id, promptId: second.id, answer: { kind: "deny" } })).status).toBe(200);
  await until(async () => (await runOf(id))?.status === "done", "the declined run to end");
});
