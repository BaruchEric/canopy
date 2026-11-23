/**
 * Several runs in one checkout over the API (FR-073): a second and a third
 * run start beside the first, each goes by a name (cut from its words, then
 * the namer's, or the one the start or a person gives), POST /api/runs/name
 * renames a live run, and the checkout is full at the runner's cap. A
 * workflow starts beside a run at work, and runs start beside the workflow,
 * each told of the other.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkoutFull } from "../core/actions";
import type { DriveCtx, RunDriver } from "../core/driver";
import { CHECKOUT_RUNS_PER_REPO } from "../core/runner";
import { isFlowActive, isRunActive, type Flow, type Harness, type Run } from "../core/types";
import { startServer } from "./index";

/** holds the run open, doing nothing, until it is stopped */
class HoldingDriver implements RunDriver {
  readonly label = "Claude Code";
  private ctx: DriveCtx | null = null;
  constructor(readonly harness: Harness) {}
  check(): string | null {
    return null;
  }
  start(ctx: DriveCtx): void {
    this.ctx = ctx;
  }
  say(): void {}
  stop(): void {
    this.ctx?.exited({ code: null, stderr: "" });
  }
}

let scratch: string;
let previous: string | undefined;
let server: { port: number; stop: () => void };
/** what the namer answers for a run's words; a text not listed gets none */
const names = new Map<string, string>();
const namerAsked: string[] = [];
/** the namer answers once the first test lets it, so a start's answer still
 *  carries the name cut from its words */
let letNamerAnswer: () => void = () => {};
const namerMayAnswer = new Promise<void>((r) => (letNamerAnswer = r));

const url = (p: string) => `http://127.0.0.1:${server.port}${p}`;
const call = (method: string, p: string, body: unknown) => fetch(url(p), { method, body: JSON.stringify(body) });
const errorOf = async (r: Response) => ((await r.json()) as { error: string }).error;
const runs = async (): Promise<Run[]> => (await (await fetch(url("/api/runs"))).json()) as Run[];
const runOf = async (id: string): Promise<Run | undefined> => (await runs()).find((r) => r.id === id);

async function until(pred: () => Promise<boolean>, what: string, ms = 10_000): Promise<void> {
  const start = Date.now();
  while (!(await pred())) {
    if (Date.now() - start > ms) throw new Error(`gave up waiting for ${what}`);
    await Bun.sleep(30);
  }
}

async function start(repo: string, body: Record<string, unknown>): Promise<Run> {
  const r = await call("POST", `/api/repos/run?id=${repo}`, body);
  expect(r.status).toBe(201);
  return (await r.json()) as Run;
}

async function stopAll(): Promise<void> {
  for (const run of (await runs()).filter(isRunActive)) expect((await call("POST", "/api/runs/stop", { id: run.id })).status).toBe(200);
  await until(async () => !(await runs()).some(isRunActive), "every run to end");
}

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "canopy-shared-"));
  previous = process.env["CANOPY_CONFIG_DIR"];
  process.env["CANOPY_CONFIG_DIR"] = join(scratch, "config");
  const root = join(scratch, "root");
  for (const name of ["app", "lib"]) await Bun.$`mkdir -p ${join(root, name)} && git -C ${join(root, name)} init -q`.quiet();
  // the user's own workflow, two steps, for the test of a workflow beside runs
  await mkdir(join(scratch, "config", "workflows"), { recursive: true });
  await writeFile(join(scratch, "config", "workflows", "tidy.md"), "---\nverb: tidy\nblurb: test\n---\n\n## Sweep\n\nSweep.\n\n## Sort\n\nSort.\n");
  server = await startServer({
    root,
    port: 0,
    chan: null,
    harnesses: ["claude"],
    runner: {
      driver: (h) => new HoldingDriver(h),
      namer: async (text) => {
        namerAsked.push(text);
        await namerMayAnswer;
        return names.get(text) ?? null;
      },
    },
  });
});

afterAll(async () => {
  server.stop();
  if (previous === undefined) delete process.env["CANOPY_CONFIG_DIR"];
  else process.env["CANOPY_CONFIG_DIR"] = previous;
  await rm(scratch, { recursive: true, force: true });
});

test("a job and two chats run on one repo at once, each under a name", async () => {
  names.set("Please look at why the build is slow", "slow build");
  const idle = await start("app", { action: "chat", note: "" });
  const job = await start("app", { action: "ask", note: "Please look at why the build is slow" });
  const chat = await start("app", { action: "chat", note: "tidy the imports" });
  expect(idle.status).toBe("idle");
  expect(idle.name).toBeUndefined();
  expect(job).toMatchObject({ name: "look at why the build is slow", nameBy: "words" });
  expect(chat).toMatchObject({ name: "tidy the imports", nameBy: "words" });
  // a chat between turns holds a place too: it may have work lying uncommitted
  expect(job.steps[0]).toMatchObject({ kind: "note", text: "sharing the checkout with another run: chat" });
  expect(chat.steps[0]).toMatchObject({ kind: "note", text: "sharing the checkout with 2 other runs: chat, look at why the build is slow" });
  const live = (await runs()).filter((r) => r.repoId === "app" && isRunActive(r));
  expect(live.map((r) => r.id).sort()).toEqual([idle.id, job.id, chat.id].sort());
  // the namer's answer replaces the words' name; a text it has no name for keeps its own
  letNamerAnswer();
  await until(async () => (await runOf(job.id))?.name === "slow build", "the namer's name");
  expect(await runOf(job.id)).toMatchObject({ name: "slow build", nameBy: "model" });
  expect(await runOf(chat.id)).toMatchObject({ name: "tidy the imports", nameBy: "words" });
  // the chat opened with nothing to say is named by its first message
  expect((await call("POST", "/api/runs/say", { id: idle.id, text: "what changed today?" })).status).toBe(200);
  expect(await runOf(idle.id)).toMatchObject({ name: "what changed today", nameBy: "words", status: "working" });
  expect(namerAsked).toContain("what changed today?");
  await stopAll();
});

test("a start's own name is kept, and a bad one is refused", async () => {
  const before = namerAsked.length;
  const run = await start("app", { action: "ask", note: "do the thing", name: "  landing retries. " });
  expect(run).toMatchObject({ name: "landing retries", nameBy: "hand" });
  expect(namerAsked.length).toBe(before);
  const bad = await call("POST", "/api/repos/run?id=app", { action: "ask", note: "x", name: 5 });
  expect(bad.status).toBe(400);
  expect(await errorOf(bad)).toBe("name must be text");
  const group = await call("POST", "/api/repos/run?id=app", { action: "ask", note: "x", name: "three ways", branch: true, times: 2 });
  expect(group.status).toBe(400);
  expect(await errorOf(group)).toBe("a group or a coordinator takes no name");
  await stopAll();
});

test("POST /api/runs/name renames a live run and refuses the rest", async () => {
  const run = await start("lib", { action: "ask", note: "first task" });
  const r = await call("POST", "/api/runs/name", { id: run.id, name: "  the   peer sync  " });
  expect(r.status).toBe(200);
  expect((await r.json()) as Run).toMatchObject({ id: run.id, name: "the peer sync", nameBy: "hand" });
  expect((await runOf(run.id))?.name).toBe("the peer sync");
  const empty = await call("POST", "/api/runs/name", { id: run.id, name: "  " });
  expect(empty.status).toBe(409);
  expect(await errorOf(empty)).toBe("write a name first");
  expect((await call("POST", "/api/runs/name", { id: "nope1234", name: "x" })).status).toBe(404);
  expect((await call("POST", "/api/runs/name", { id: run.id })).status).toBe(400);
  expect((await call("POST", "/api/runs/name", { name: "x" })).status).toBe(400);
  await stopAll();
  const ended = await call("POST", "/api/runs/name", { id: run.id, name: "later" });
  expect(ended.status).toBe(409);
  expect(await errorOf(ended)).toBe("the run has ended");
});

test("a workflow starts beside a run at work, and runs start beside the workflow, each told of the other", async () => {
  const job = await start("app", { action: "ask", note: "first task", name: "first task" });
  const started = await call("POST", "/api/repos/flow?id=app", { workflow: "tidy" });
  expect(started.status).toBe(201);
  const flow = (await started.json()) as Flow;
  expect(flow.steps[0]?.status).toBe("running");
  const step = await runOf(flow.steps[0]?.runId ?? "");
  expect(step?.steps[0]).toMatchObject({ kind: "note", text: "sharing the checkout with another run: first task" });
  // a job and a chat start while the workflow's step is at work
  const late = await start("app", { action: "ask", note: "second task", name: "second task" });
  expect(late.steps[0]).toMatchObject({ kind: "note", text: "sharing the checkout with the tidy workflow and another run: first task" });
  const chat = await start("app", { action: "chat", note: "what is the workflow doing", name: "a question" });
  expect(chat.steps[0]?.text).toBe("sharing the checkout with the tidy workflow and 2 other runs: first task, second task");
  // one workflow at a time in a checkout
  const second = await call("POST", "/api/repos/flow?id=app", { workflow: "tidy" });
  expect(second.status).toBe(400);
  expect(await errorOf(second)).toBe("app already has tidy going");
  expect((await call("POST", "/api/flows/stop", { id: flow.id })).status).toBe(200);
  await until(async () => !((await (await fetch(url("/api/flows"))).json()) as Flow[]).some(isFlowActive), "the workflow to end");
  // the runs beside it go on
  expect((await runOf(job.id))?.status).toBe("working");
  expect((await runOf(late.id))?.status).toBe("working");
  await stopAll();
});

test("the checkout is full at the cap, and another repo's is not", async () => {
  for (let i = 0; i < CHECKOUT_RUNS_PER_REPO; i += 1) await start("lib", { action: "ask", note: `task ${i}` });
  const full = await call("POST", "/api/repos/run?id=lib", { action: "chat", note: "" });
  expect(full.status).toBe(409);
  expect(await errorOf(full)).toBe(checkoutFull("lib", CHECKOUT_RUNS_PER_REPO));
  await start("app", { action: "chat", note: "" });
  await stopAll();
  await start("lib", { action: "chat", note: "" });
  await stopAll();
});
