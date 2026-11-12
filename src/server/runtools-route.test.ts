/**
 * A run's canopy tools over the API (FR-038), as the agent's own Bash could
 * reach them: real HTTP on a server in `enforce`, with the token read out of
 * the run's mcp.json, against a scratch repo and a driver that holds the run
 * open until the test ends it. Every check here is a handler's, since the
 * MCP server is no boundary: the agent can read the file and call the API.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, statSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DriveCtx, RunDriver } from "../core/driver";
import { exec } from "../core/exec";
import { RUN_CHILDREN } from "../core/runtools";
import type { Harness, RangerWake, Run } from "../core/types";
import { CallerBook } from "./callers";
import { startServer } from "./index";

const starts = new Map<string, DriveCtx>();
const firstMessages = new Map<string, string>();
/** what a person's steers put down each run's wire, and its interrupts */
const steered = new Map<string, string[]>();
const interrupts = new Map<string, number>();

/** Holds a run open until `end` finishes it. */
class HeldDriver implements RunDriver {
  readonly label = "fake";
  constructor(readonly harness: Harness) {}
  private ctx: DriveCtx | undefined;
  check(): string | null { return null; }
  start(ctx: DriveCtx, message: string): void { this.ctx = ctx; starts.set(ctx.env["CANOPY_RUN"] ?? "", ctx); firstMessages.set(ctx.env["CANOPY_RUN"] ?? "", message); }
  say(): void {}
  steer(text: string): boolean { const id = this.ctx?.env["CANOPY_RUN"] ?? ""; steered.set(id, [...(steered.get(id) ?? []), text]); return true; }
  interrupt(): boolean { const id = this.ctx?.env["CANOPY_RUN"] ?? ""; interrupts.set(id, (interrupts.get(id) ?? 0) + 1); return true; }
  stop(): void { this.ctx?.exited({ code: null, stderr: "" }); }
}

let scratch: string;
let root: string;
let config: string;
let cli: string;
let page: string;
let server: Awaited<ReturnType<typeof startServer>>;
const saved: Record<string, string | undefined> = {};
const ENV = ["CANOPY_CONFIG_DIR", "CANOPY_CALLERS", "CANOPY_TMUX", "CANOPY_COORD_SOCKET", "CANOPY_BIND"];

const url = (p: string) => `http://127.0.0.1:${server.port}${p}`;
const post = (p: string, body: unknown, token: string | undefined = cli) =>
  fetch(url(p), { method: "POST", headers: { "content-type": "application/json", ...(token ? { "x-canopy-token": token } : {}) }, body: JSON.stringify(body) });
const started = async (res: Response): Promise<Run> => {
  if (res.status !== 201) throw new Error(`start: ${res.status} ${await res.text()}`);
  return (await res.json()) as Run;
};
const fileOf = (id: string) => join(config, "run-tools", `${id}.mcp.json`);
const tokenOf = async (id: string): Promise<string> => (JSON.parse(await readFile(fileOf(id), "utf8")) as { mcpServers: { canopy: { env: { CANOPY_TOKEN: string } } } }).mcpServers.canopy.env.CANOPY_TOKEN;
const runOf = async (id: string) => ((await (await fetch(url("/api/runs"), { headers: { "x-canopy-token": cli } })).json()) as Run[]).find((r) => r.id === id);

async function until<T>(read: () => Promise<T | null | undefined | false>, what: string, ms = 10_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const got = await read();
    if (got) return got;
    if (Date.now() - start > ms) throw new Error(`gave up waiting for ${what}`);
    await Bun.sleep(20);
  }
}

/** ends a held run and waits for canopy to see it */
async function end(id: string): Promise<void> {
  const ctx = await until(async () => starts.get(id), `run ${id} to reach the driver`);
  ctx.result({ text: "done", durationMs: 1, turns: 1 }, null);
  ctx.exited({ code: 0, stderr: "" });
  await until(async () => {
    const r = await runOf(id);
    return r && r.status !== "working" && r.branch?.state !== "working" ? r : null;
  }, `run ${id} to end`);
}

const startTools = async (over: Record<string, unknown> = {}): Promise<Run> =>
  started(await post("/api/repos/run?id=app", { action: "ask", note: "work", branch: true, canopyTools: true, ...over }));

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "canopy-runtools-route-"));
  for (const k of ENV) saved[k] = process.env[k];
  root = join(scratch, "root");
  config = join(scratch, "config");
  const proj = join(root, "app");
  await mkdir(proj, { recursive: true });
  await exec(["git", "init", "-q", "-b", "main", proj]);
  await writeFile(join(proj, "a.txt"), "one\n");
  await exec(["git", "-C", proj, "add", "-A"]);
  await exec(["git", "-C", proj, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "one"]);
  await mkdir(join(root, "other"), { recursive: true });
  await exec(["git", "init", "-q", "-b", "main", join(root, "other")]);
  process.env["CANOPY_CONFIG_DIR"] = config;
  process.env["CANOPY_CALLERS"] = "enforce";
  process.env["CANOPY_TMUX"] = "0";
  delete process.env["CANOPY_COORD_SOCKET"];
  delete process.env["CANOPY_BIND"];
  const book = new CallerBook({ file: join(config, "callers.json") });
  cli = book.mint("cli", { label: "cli test" }).token;
  page = book.mint("page", { label: "page test" }).token;
  // what a restart must clear: a token and a file a run left behind
  book.mint("run", { label: "run app", run: "dead1234" });
  await book.flush();
  await mkdir(join(config, "run-tools"), { recursive: true });
  await writeFile(fileOf("dead1234"), "{}");
  server = await startServer({ root, port: 0, chan: null, harnesses: ["claude", "codex"], runner: { driver: (h: Harness) => new HeldDriver(h) } });
});

afterAll(async () => {
  await server.stop();
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  await rm(scratch, { recursive: true, force: true });
});

describe("the file and the token", () => {
  test("a restart dropped what a dead run left", async () => {
    expect(existsSync(fileOf("dead1234"))).toBe(false);
    const callers = (await (await fetch(url("/api/auth"), { headers: { "x-canopy-token": cli } })).json()) as { callers: { kind: string }[] };
    expect(callers.callers.some((c) => c.kind === "run")).toBe(false);
  });

  test("off by default: a plain run has no file, no token and no flag", async () => {
    const run = await started(await post("/api/repos/run?id=app", { action: "ask", note: "plain", branch: true }));
    expect(run.canopyTools).toBeUndefined();
    expect(existsSync(fileOf(run.id))).toBe(false);
    const ctx = await until(async () => starts.get(run.id), "the driver");
    expect(ctx.spec.mcpConfig).toBeUndefined();
    expect(firstMessages.get(run.id)).not.toContain("You hold canopy's tools");
    await end(run.id);
  });

  test("the toggle mints: 0600 in a 0700 folder, the token in the file and not the agent's env; the end takes both", async () => {
    const run = await startTools();
    expect(run.canopyTools).toBe(true);
    const file = fileOf(run.id);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(join(config, "run-tools")).mode & 0o777).toBe(0o700);
    const token = await tokenOf(run.id);
    expect(token.startsWith("cnp_run_")).toBe(true);
    const ctx = await until(async () => starts.get(run.id), "the driver");
    expect(ctx.spec.mcpConfig).toBe(file);
    expect(ctx.spec.mcpServer?.args.slice(-2)).toEqual(["--run-config", file]);
    expect(JSON.stringify(ctx.spec)).not.toContain(token);
    expect(firstMessages.get(run.id)).toContain("You hold canopy's tools");
    expect(Object.values(ctx.env)).not.toContain(token);
    expect(ctx.env["CANOPY_TOKEN"]).toBeUndefined();
    const held = JSON.parse(await readFile(file, "utf8")) as { mcpServers: { canopy: { command: string; args: string[]; env: Record<string, string> } } };
    expect(held.mcpServers.canopy.command).toBe(process.execPath);
    expect(held.mcpServers.canopy.env["CANOPY_RUN"]).toBe(run.id);
    expect((await fetch(url("/api/auth"), { headers: { "x-canopy-token": token } })).status).toBe(200);
    await end(run.id);
    await until(async () => !existsSync(file), "the file to go");
    const after = (await (await fetch(url("/api/auth"), { headers: { "x-canopy-token": token } })).json()) as { you: string };
    expect(after.you).toBe("none");
  });

  test("a start that fails leaves neither token nor file", async () => {
    const held = async () => (await readdir(join(config, "run-tools")).catch(() => [] as string[])).sort();
    const before = await held();
    const refused = await post("/api/repos/run?id=app", { action: "ask", note: "", branch: true, canopyTools: true });
    expect(refused.status).toBe(400);
    expect(await held()).toEqual(before);
    const callers = (await (await fetch(url("/api/auth"), { headers: { "x-canopy-token": cli } })).json()) as { callers: { kind: string }[] };
    expect(callers.callers.filter((c) => c.kind === "run")).toEqual([]);
  });

  test("a group and a coordinator say why they cannot have them, and the field is a boolean", async () => {
    expect((await post("/api/repos/run?id=app", { action: "ask", note: "x", branch: true, times: 2, canopyTools: true })).status).toBe(400);
    expect((await post("/api/repos/run?id=app", { action: "coordinate", note: "x", canopyTools: true })).status).toBe(400);
    expect((await post("/api/repos/run?id=app", { action: "ask", note: "x", canopyTools: "yes" })).status).toBe(400);
  });
});

describe("what a run's token reaches", () => {
  test("its lane reads, and nothing that lands, pushes, answers, stops or configures", async () => {
    const run = await startTools();
    const token = await tokenOf(run.id);
    for (const p of ["/api/tree", "/api/runs", "/api/landing", "/api/health", "/api/auth"]) {
      expect([p, (await fetch(url(p), { headers: { "x-canopy-token": token } })).status]).toEqual([p, 200]);
    }
    for (const [p, body] of [
      ["/api/landing/land", { run: run.id }],
      ["/api/prs/open", { run: run.id }],
      ["/api/runs/stop", { id: run.id }],
      ["/api/runs/answer", { id: run.id }],
      ["/api/runs/fork", { run: run.id }],
      ["/api/repos/run?id=app", { action: "ask", note: "x" }],
      ["/api/repos/push?id=app", {}],
      ["/api/agents/profile", {}],
      ["/api/coordinator/plan", {}],
      ["/api/work/close", {}],
      ["/api/auth/approve", { id: "x" }],
    ] as const) {
      expect([p, (await post(p, body, token)).status]).toEqual([p, 403]);
    }
    expect((await fetch(url("/api/events"), { headers: { "x-canopy-token": token } })).status).toBe(403);
    expect((await fetch(url("/api/ranger/wakes?id=00000000"), { method: "DELETE", headers: { "x-canopy-token": token } })).status).toBe(403);
    expect(await runOf(run.id)).toMatchObject({ status: "working" });
    await end(run.id);
  });

  test("a child: in its own repo, at low priority, by the run, with tools, and no further", async () => {
    const parent = await startTools();
    const token = await tokenOf(parent.id);
    expect((await post("/api/runs/child", { note: "elsewhere", repo: "other" }, token)).status).toBe(403);
    expect((await post("/api/runs/child", { note: "for another", parent: "abcd1234" }, token)).status).toBe(403);
    expect((await post("/api/runs/child", { note: "a chat", action: "chat" }, token)).status).toBe(400);
    expect((await post("/api/runs/child", { note: "a coordinator", action: "coordinate" }, token)).status).toBe(400);
    expect((await post("/api/runs/child", { note: "  " }, token)).status).toBe(400);
    const child = await started(await post("/api/runs/child", { note: "a part" }, token));
    expect(child).toMatchObject({ repoId: parent.repoId, parent: parent.id, depth: 1, priority: "low", by: "run", canopyTools: true });
    expect(child.branch).toBeDefined();
    const kidToken = await tokenOf(child.id);
    const refused = await post("/api/runs/child", { note: "a grandchild" }, kidToken);
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { error: string }).error).toContain("a child does not start children");
    await end(child.id);
    await end(parent.id);
  });

  test("the limit: a chat's fourth live child is refused, by count or by slots", async () => {
    const chat = await started(await post("/api/repos/run?id=app", { action: "chat", note: "", canopyTools: true }));
    const token = await tokenOf(chat.id);
    const kids = await Promise.all(Array.from({ length: RUN_CHILDREN + 2 }, (_, i) => post("/api/runs/child", { note: `part ${i}` }, token)));
    const counts = kids.map((r) => r.status).sort();
    expect(counts).toEqual([201, 201, 201, 409, 409]);
    const made = await Promise.all(kids.filter((r) => r.status === 201).map((r) => r.json() as Promise<Run>));
    await Promise.all(made.map((k) => end(k.id)));
    await post("/api/runs/stop", { id: chat.id });
    await until(async () => !existsSync(fileOf(chat.id)), "the chat's file to go");
  });

  test("say: kin only, and the kin check comes before the runner's own word", async () => {
    const chat = await started(await post("/api/repos/run?id=app", { action: "chat", note: "", canopyTools: true }));
    const stranger = await startTools();
    const child = await started(await post("/api/runs/child", { note: "a part" }, await tokenOf(chat.id)));
    const kid = await tokenOf(child.id);
    expect((await post("/api/runs/say", { id: stranger.id, text: "hello" }, kid)).status).toBe(403);
    expect((await post("/api/runs/say", { id: "nope1234", text: "hello" }, kid)).status).toBe(403);
    expect((await post("/api/runs/say", { id: chat.id, text: "done with my part" }, kid)).status).toBe(200);
    await end(child.id);
    await end(stranger.id);
    await post("/api/runs/stop", { id: chat.id });
  });

  test("a wake goes down as the run's whatever the body says, and a schedule is refused", async () => {
    const run = await startTools();
    const token = await tokenOf(run.id);
    expect((await post("/api/ranger/wakes", { prompt: "every day", cron: "0 9 * * *" }, token)).status).toBe(403);
    const res = await post("/api/ranger/wakes", { prompt: "check me", when: "in 2h", by: "eric" }, token);
    expect(res.status).toBe(201);
    expect((await res.json()) as RangerWake).toMatchObject({ by: "run", from: run.id, prompt: "check me" });
    await end(run.id);
  });

  test("a work note lands on the run's own item, named or not, and on no other", async () => {
    const run = await startTools();
    const other = await started(await post("/api/repos/run?id=app", { action: "ask", note: "other", branch: true }));
    const token = await tokenOf(run.id);
    expect((await post("/api/work/note", { id: other.branch?.work, text: "not mine" }, token)).status).toBe(403);
    const ok = await post("/api/work/note", { text: "for the next session" }, token);
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { id: string; notes: { by: string; text: string }[] })).toMatchObject({ id: run.branch?.work, notes: [{ by: `run app`, text: "for the next session" }] });
    await end(run.id);
    await end(other.id);
  });

  test("a chat in the checkout has no work item, and says so", async () => {
    const chat = await started(await post("/api/repos/run?id=app", { action: "chat", note: "", canopyTools: true }));
    const res = await post("/api/work/note", { text: "x" }, await tokenOf(chat.id));
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toContain("no work item");
    await post("/api/runs/stop", { id: chat.id });
  });

  test("a fix of a child stays a child, with a fresh token and the old one dead", async () => {
    const parent = await startTools();
    const child = await started(await post("/api/runs/child", { note: "a part" }, await tokenOf(parent.id)));
    const oldToken = await tokenOf(child.id);
    const dir = child.branch?.dir ?? "";
    await until(async () => starts.get(child.id), "the child's driver");
    await writeFile(join(dir, "b.txt"), "two\n");
    await exec(["git", "-C", dir, "add", "-A"]);
    await exec(["git", "-C", dir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "a part"]);
    await end(child.id);
    const repo = join(root, "app");
    await mkdir(join(repo, ".canopy"), { recursive: true });
    await writeFile(join(repo, ".canopy", "gates.json"), JSON.stringify({ gates: [{ name: "test", run: "false" }] }));
    await exec(["git", "-C", repo, "add", "-A"]);
    await exec(["git", "-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "red gate"]);
    const origin = child.branch?.origin ?? "";
    expect((await post("/api/landing/land", { run: origin })).status).toBe(200);
    await until(async () => {
      const info = (await (await fetch(url("/api/landing"), { headers: { "x-canopy-token": cli } })).json()) as { entries: { id: string; state: string }[] };
      return info.entries.some((e) => e.id === origin && e.state === "red");
    }, "the red gate");
    const fix = await started(await post("/api/landing/fix", { id: origin }));
    expect(fix).toMatchObject({ parent: parent.id, depth: 1, canopyTools: true });
    const fresh = await tokenOf(fix.id);
    expect(fresh).not.toBe(oldToken);
    expect((await post("/api/runs/child", { note: "a grandchild" }, fresh)).status).toBe(409);
    const dead = (await (await fetch(url("/api/auth"), { headers: { "x-canopy-token": oldToken } })).json()) as { you: string };
    expect(dead.you).toBe("none");
    await end(fix.id);
    await end(parent.id);
    await writeFile(join(repo, ".canopy", "gates.json"), JSON.stringify({ gates: [] }));
    await exec(["git", "-C", repo, "add", "-A"]);
    await exec(["git", "-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "no gate"]);
  }, 30_000); // a landing with a real gate; the 5 s default ran out under a full suite

  test("a person's token names the parent, and keeps the routes it had", async () => {
    expect((await post("/api/runs/child", { note: "x" })).status).toBe(400);
    expect((await post("/api/runs/child", { note: "x", parent: "nope1234" })).status).toBe(404);
    expect((await post("/api/work/note", { id: "nope", text: "x" })).status).toBe(404);
  });
});

describe("a person steering a run over the API (FR-066)", () => {
  const errorOf = async (res: Response) => ((await res.json()) as { error: string }).error;

  test("the CLI's token says into a working job and stops a chat's reply", async () => {
    const job = await startTools();
    await until(async () => starts.get(job.id), "the driver");
    const said = await post("/api/runs/say", { id: job.id, text: "use bun" });
    expect(said.status).toBe(200);
    expect(steered.get(job.id)).toEqual(["use bun"]);
    expect(((await said.json()) as Run).steps.at(-1)).toMatchObject({ kind: "user", text: "use bun" });

    const chat = await started(await post("/api/repos/run?id=app", { action: "chat", note: "" }));
    expect((await post("/api/runs/say", { id: chat.id, text: "hello" })).status).toBe(200);
    await until(async () => starts.get(chat.id), "the chat's driver");
    expect((await post("/api/runs/interrupt", { id: chat.id })).status).toBe(200);
    expect(interrupts.get(chat.id)).toBe(1);
    // a job is never stopped with nothing to go on with
    const bare = await post("/api/runs/interrupt", { id: job.id });
    expect(bare.status).toBe(409);
    expect(await errorOf(bare)).toContain("a job stops its turn only for a message");
    expect((await post("/api/runs/interrupt", { id: job.id, text: "do this instead" })).status).toBe(200);
    expect(steered.get(job.id)).toEqual(["use bun", "do this instead"]);
    await end(job.id);
    await post("/api/runs/stop", { id: chat.id });
  });

  test("a run's token keeps the old rule: kin between turns, never mid-turn, never a stop", async () => {
    const chat = await started(await post("/api/repos/run?id=app", { action: "chat", note: "", canopyTools: true }));
    const child = await started(await post("/api/runs/child", { note: "a part" }, await tokenOf(chat.id)));
    const kid = await tokenOf(child.id);
    // the chat at work on a person's message
    expect((await post("/api/runs/say", { id: chat.id, text: "hello" })).status).toBe(200);
    await until(async () => starts.get(chat.id), "the chat's driver");
    const busy = await post("/api/runs/say", { id: chat.id, text: "from the child" }, kid);
    expect(busy.status).toBe(409);
    expect(await errorOf(busy)).toBe("fake is still replying");
    expect(steered.get(chat.id)).toBeUndefined();
    expect((await post("/api/runs/interrupt", { id: chat.id }, kid)).status).toBe(403);
    expect(interrupts.get(chat.id)).toBeUndefined();
    await end(child.id);
    await post("/api/runs/stop", { id: chat.id });
  });

  test("a run that is not here is a 404, a bad body a 400", async () => {
    expect((await post("/api/runs/say", { id: "nope1234", text: "hi" })).status).toBe(404);
    expect((await post("/api/runs/interrupt", { id: "nope1234" })).status).toBe(404);
    expect((await post("/api/runs/interrupt", { id: 7 })).status).toBe(400);
    expect((await post("/api/runs/interrupt", { id: "nope1234", text: 7 })).status).toBe(400);
  });

  test("typing into a shell takes the page's shell right: words checked first, an unknown shell is a 404", async () => {
    expect((await post("/api/terms/say", { term: "abc", text: "  " }, page)).status).toBe(400);
    expect((await post("/api/terms/say", { term: "abc" }, page)).status).toBe(400);
    expect((await post("/api/terms/say", { term: "abc", text: "go on" }, page)).status).toBe(404);
    expect((await post("/api/terms/keys", { term: "abc", key: "enter" }, page)).status).toBe(400);
    expect((await post("/api/terms/keys", { term: "abc", key: "escape" }, page)).status).toBe(404);
    // the CLI holds no shell right, as for every other write into a terminal
    expect((await post("/api/terms/say", { term: "abc", text: "go on" })).status).toBe(403);
    const run = await startTools();
    const token = await tokenOf(run.id);
    expect((await post("/api/terms/say", { term: "abc", text: "go on" }, token)).status).toBe(403);
    expect((await post("/api/terms/keys", { term: "abc", key: "escape" }, token)).status).toBe(403);
    await end(run.id);
  });
});
