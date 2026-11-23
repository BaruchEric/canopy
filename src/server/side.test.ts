/**
 * Side questions over the API (FR-077): `POST /api/runs/side` on a live run
 * starts a chat forked from the run's session and leaves the run as it is,
 * and `POST /api/runs/model` gives that chat another model between turns.
 * Against a scratch repo and a driver the test plays by hand.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkoutFull } from "../core/actions";
import type { DriveCtx, RunDriver } from "../core/driver";
import { exec } from "../core/exec";
import { CHECKOUT_RUNS_PER_REPO } from "../core/runner";
import { sideMessage, sideNote } from "../core/sidequestion";
import type { Harness, Run } from "../core/types";
import { startServer } from "./index";

const OK = { text: "ok", durationMs: 1, turns: 1 };

/** One started process: what it was started with, and its context to play. */
interface Proc {
  ctx: DriveCtx;
  message: string;
  models: string[];
}
const procs: Proc[] = [];

/** A driver that starts nothing: it gives the run a session at once, as a
 *  harness does at its init, and the test ends each turn through `ctx`. */
class SideDriver implements RunDriver {
  readonly label = "fake";
  private proc: Proc | null = null;
  constructor(readonly harness: Harness) {}
  check(): string | null {
    return null;
  }
  start(ctx: DriveCtx, message: string): void {
    this.proc = { ctx, message, models: [] };
    procs.push(this.proc);
    ctx.session(`sess-${procs.length}`);
  }
  say(): void {}
  model(model: string): Promise<string | null> {
    this.proc?.models.push(model);
    return Promise.resolve(null);
  }
  stop(): void {
    this.proc?.ctx.exited({ code: 0, stderr: "" });
  }
}

let scratch: string;
let previousConfig: string | undefined;
let server: Awaited<ReturnType<typeof startServer>>;

const url = (p: string) => `http://127.0.0.1:${server.port}${p}`;
const call = (p: string, body: unknown) => fetch(url(p), { method: "POST", body: JSON.stringify(body) });
const runOf = async (id: string) => ((await (await fetch(url("/api/runs"))).json()) as Run[]).find((r) => r.id === id);
const errorOf = async (res: Response) => ((await res.json()) as { error: string }).error;
/** the process the `n`th start made, from 1 */
const proc = (n: number): Proc => {
  const p = procs[n - 1];
  if (!p) throw new Error(`no process ${n}`);
  return p;
};
const start = async (repo: string, action: "ask" | "chat", note: string): Promise<Run> => {
  const res = await call(`/api/repos/run?id=${repo}`, { action, note });
  expect(res.status).toBe(201);
  return (await res.json()) as Run;
};

async function makeRepo(root: string, name: string): Promise<void> {
  const dir = join(root, name);
  await mkdir(dir, { recursive: true });
  await exec(["git", "init", "-q", "-b", "main", dir]);
  await writeFile(join(dir, "a.txt"), "one\n");
  await exec(["git", "-C", dir, "add", "-A"]);
  await exec(["git", "-C", dir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "one"]);
}

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "canopy-side-"));
  previousConfig = process.env["CANOPY_CONFIG_DIR"];
  process.env["CANOPY_CONFIG_DIR"] = join(scratch, "config");
  const root = join(scratch, "root");
  for (const name of ["proj", "full", "quiet"]) await makeRepo(root, name);
  server = await startServer({ root, port: 0, chan: null, harnesses: ["claude", "codex"], runner: { driver: (h) => new SideDriver(h) } });
});

afterAll(async () => {
  await server.stop();
  if (previousConfig === undefined) delete process.env["CANOPY_CONFIG_DIR"];
  else process.env["CANOPY_CONFIG_DIR"] = previousConfig;
  await rm(scratch, { recursive: true, force: true });
});

describe("POST /api/runs/side", () => {
  let parent: Run;
  let side: Run;

  test("on a run mid-turn: a chat forked from its session starts beside it, and the run hears nothing", async () => {
    parent = await start("proj", "ask", "migrate the billing checkout");
    expect(parent.status).toBe("working");
    const before = await runOf(parent.id);
    const res = await call("/api/runs/side", { id: parent.id, text: "btw is not the server's word: what is the retry default?" });
    expect(res.status).toBe(201);
    side = (await res.json()) as Run;
    expect(side).toMatchObject({
      repoId: "proj",
      action: "chat",
      chat: true,
      status: "working",
      harness: "claude",
      sideOf: { run: parent.id, title: "migrate the billing checkout" },
    });
    expect(side.steps.map((s) => [s.kind, s.text])).toEqual([
      ["note", sideNote("migrate the billing checkout")],
      ["user", "btw is not the server's word: what is the retry default?"],
    ]);
    // the second process: the fork of the first's session, in the same folder
    expect(proc(2).ctx.spec).toMatchObject({ resume: "sess-1", fork: true });
    expect(proc(2).ctx.cwd).toBe(proc(1).ctx.cwd);
    expect(proc(2).message).toBe(sideMessage("btw is not the server's word: what is the retry default?"));
    // the parent as it was: still at work, no step and no message of it
    expect(await runOf(parent.id)).toEqual(before);
  });

  test("takes a model for this thread alone, and refuses one the harness does not take", async () => {
    const res = await call("/api/runs/side", { id: parent.id, text: "and the timeout?", model: "haiku" });
    expect(res.status).toBe(201);
    const picked = (await res.json()) as Run;
    expect(picked.agentSettings).toMatchObject({ harness: "claude", model: "haiku" });
    expect(proc(3).ctx.agent.model).toBe("haiku");
    // the first one took the repo's chat route, which names none
    expect(side.agentSettings?.model).toBe("default");
    const bad = await call("/api/runs/side", { id: parent.id, text: "and the port?", model: "gpt-6-luna" });
    expect([bad.status, await errorOf(bad)]).toEqual([400, "claude does not take model gpt-6-luna"]);
    const odd = await call("/api/runs/side", { id: parent.id, text: "and the port?", model: 7 });
    expect(odd.status).toBe(400);
  });

  test("says what is missing: the run, the question", async () => {
    expect((await call("/api/runs/side", { text: "what is the port" })).status).toBe(400);
    expect((await call("/api/runs/side", { id: "../etc", text: "what is the port" })).status).toBe(400);
    const empty = await call("/api/runs/side", { id: parent.id, text: "  " });
    expect([empty.status, await errorOf(empty)]).toEqual([400, "write the question first"]);
    const gone = await call("/api/runs/side", { id: "nope1234", text: "what is the port" });
    expect([gone.status, await errorOf(gone)]).toEqual([404, "no such run"]);
  });

  test("refuses a side question of a side question, and one beside a run that has ended", async () => {
    const nested = await call("/api/runs/side", { id: side.id, text: "and the host?" });
    expect(nested.status).toBe(409);
    expect(await errorOf(nested)).toContain("a side question already");
    // the parent's turn ends: a job is done, and takes none
    proc(1).ctx.result(OK, null);
    expect((await runOf(parent.id))?.status).toBe("done");
    const ended = await call("/api/runs/side", { id: parent.id, text: "what is the port" });
    expect(ended.status).toBe(409);
    expect(await errorOf(ended)).toContain("the run has ended");
    // the side threads go on without it
    expect((await runOf(side.id))?.status).toBe("working");
  });

  test("refuses a chat nothing was said in, which has no session yet", async () => {
    const quiet = await start("quiet", "chat", "");
    expect(quiet.status).toBe("idle");
    const res = await call("/api/runs/side", { id: quiet.id, text: "what is the port" });
    expect([res.status, await errorOf(res)]).toEqual([409, "the run has no session to fork yet: ask once it has begun"]);
  });

  test("refuses when the checkout is full, and says so", async () => {
    const first = await start("full", "chat", "hello");
    for (let i = 1; i < CHECKOUT_RUNS_PER_REPO; i += 1) await start("full", "chat", `chat ${i}`);
    const res = await call("/api/runs/side", { id: first.id, text: "what is the port" });
    expect([res.status, await errorOf(res)]).toEqual([409, checkoutFull("full", CHECKOUT_RUNS_PER_REPO)]);
  });

  describe("POST /api/runs/model", () => {
    test("gives a side question another model between its turns", async () => {
      const mid = await call("/api/runs/model", { id: side.id, model: "sonnet" });
      expect([mid.status, await errorOf(mid)]).toEqual([409, "it is mid-reply: pick the model once it has answered"]);
      proc(2).ctx.result(OK, null);
      const res = await call("/api/runs/model", { id: side.id, model: "sonnet" });
      expect(res.status).toBe(200);
      const after = (await res.json()) as Run;
      expect(after.agentSettings).toMatchObject({ model: "sonnet" });
      expect(after.steps.at(-1)).toMatchObject({ kind: "note", text: "model: sonnet, from the next message on" });
      expect(proc(2).models).toEqual(["sonnet"]);
    });

    test("refuses a run that is no side question, a name the harness does not take, and a call with a part missing", async () => {
      const plain = await call("/api/runs/model", { id: parent.id, model: "sonnet" });
      expect([plain.status, await errorOf(plain)]).toEqual([409, "only a side question changes its model once it has started"]);
      const bad = await call("/api/runs/model", { id: side.id, model: "gpt-6-luna" });
      expect([bad.status, await errorOf(bad)]).toEqual([409, "claude takes no model named gpt-6-luna"]);
      expect((await call("/api/runs/model", { id: side.id })).status).toBe(400);
      expect((await call("/api/runs/model", { id: "nope1234", model: "sonnet" })).status).toBe(404);
    });
  });
});
