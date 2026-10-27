/**
 * Branch runs over the API: the run route's branch flag and its default for
 * propose, the worktree a branch run works in, its settle state, and
 * "land" through the landing routes, against a scratch repo and the fake
 * Claude CLI.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DriveCtx, RunDriver } from "../core/driver";
import { exec } from "../core/exec";
import type { Harness, LandingInfo, Run } from "../core/types";
import { startServer } from "./index";

/** A driver that does the work itself: one commit in its cwd, then done. */
class CommitDriver implements RunDriver {
  readonly label = "Claude Code";
  constructor(readonly harness: Harness) {}
  check(): string | null {
    return null;
  }
  start(ctx: DriveCtx, message: string): void {
    void (async () => {
      prompts.push({ cwd: ctx.cwd, message, resume: ctx.spec.resume });
      if (!message.includes("leave it")) {
        await writeFile(join(ctx.cwd, `work-${prompts.length}.txt`), "work\n");
        await exec(["git", "-C", ctx.cwd, "add", "-A"]);
        await exec(["git", "-C", ctx.cwd, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "the work"]);
      }
      ctx.session("sess-1");
      ctx.result({ text: "done", durationMs: 1, turns: 1 }, null);
    })();
  }
  say(): void {}
  stop(): void {}
}

const prompts: { cwd: string; message: string; resume: string | undefined }[] = [];
let scratch: string;
let root: string;
let previousConfig: string | undefined;
let server: { port: number; stop: () => void };

const url = (p: string) => `http://127.0.0.1:${server.port}${p}`;
const call = (p: string, body: unknown) => fetch(url(p), { method: "POST", body: JSON.stringify(body) });
const runOf = async (id: string) => ((await (await fetch(url("/api/runs"))).json()) as Run[]).find((r) => r.id === id);
const landing = async () => (await (await fetch(url("/api/landing"))).json()) as LandingInfo;
const git = async (cwd: string, ...args: string[]) => (await exec(["git", "-C", cwd, ...args])).stdout.trim();

async function until<T>(read: () => Promise<T | null | undefined | false>, what: string, ms = 10_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const got = await read();
    if (got) return got;
    if (Date.now() - start > ms) throw new Error(`gave up waiting for ${what}`);
    await Bun.sleep(30);
  }
}

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "canopy-branchrun-"));
  previousConfig = process.env["CANOPY_CONFIG_DIR"];
  process.env["CANOPY_CONFIG_DIR"] = join(scratch, "config");
  root = join(scratch, "root");
  const proj = join(root, "proj");
  await mkdir(proj, { recursive: true });
  await exec(["git", "init", "-q", "-b", "main", proj]);
  await writeFile(join(proj, "a.txt"), "one\n");
  await exec(["git", "-C", proj, "add", "-A"]);
  await exec(["git", "-C", proj, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "one"]);
  await mkdir(join(root, "bare"), { recursive: true });
  await exec(["git", "init", "-q", join(root, "bare")]);
  server = await startServer({
    root,
    port: 0,
    chan: null,
    harnesses: ["claude"],
    runner: { driver: (h) => new CommitDriver(h) },
  });
});

afterAll(async () => {
  server.stop();
  if (previousConfig === undefined) delete process.env["CANOPY_CONFIG_DIR"];
  else process.env["CANOPY_CONFIG_DIR"] = previousConfig;
  await rm(scratch, { recursive: true, force: true });
});

describe("branch runs over the API", () => {
  test("branch: true works in a worktree on a run branch, settles ready, and lands on main", async () => {
    const start = await call("/api/repos/run?id=proj", { action: "ask", note: "add a file", branch: true });
    expect(start.status).toBe(201);
    const run = (await start.json()) as Run;
    expect(run.branch?.name).toBe(`run/${run.branch?.work}-add-a-file`);
    expect(run.branch?.dir.startsWith(join(scratch, "config", "worktrees"))).toBe(true);
    const done = await until(async () => {
      const r = await runOf(run.id);
      return r?.branch?.state === "ready" ? r : null;
    }, "the run to settle ready");
    expect(done.outcome).toBe("changed");
    expect(prompts.at(-1)?.cwd).toBe(run.branch!.dir);
    expect(prompts.at(-1)?.message).toContain("do not push");
    // the main checkout is untouched until it lands
    const proj = join(root, "proj");
    const before = await git(proj, "rev-parse", "HEAD");
    expect(await git(proj, "rev-parse", "HEAD")).toBe(before);
    const info = await landing();
    expect(info.runs.map((r) => [r.id, r.state, r.session])).toEqual([[run.branch!.origin, "ready", "sess-1"]]);
    // land through the route; canopy's gates come from package.json, of which this repo has none
    expect((await call("/api/landing/land", { run: run.id })).status).toBe(200);
    const landed = await until(async () => (await landing()).entries.find((e) => e.state === "landed"), "the entry to land");
    expect(landed.noGates).toBe(true);
    expect(await git(proj, "log", "-1", "--format=%s")).toBe("the work");
    // the worktree goes after the entry is marked landed, so wait for it
    await until(async () => !existsSync(run.branch!.dir), "the worktree to go");
  });

  test("a branch run is named after its work item, which is written at start and asked for as a trailer", async () => {
    const start = await call("/api/repos/run?id=proj", { action: "ask", note: "add a file", branch: true });
    const run = (await start.json()) as Run;
    expect(run.branch?.work).toMatch(/^w-[a-z2-7]{8}$/);
    expect(run.branch?.name).toBe(`run/${run.branch?.work}-add-a-file`);
    const file = join(scratch, "config", "work", `${run.branch!.work}.json`);
    const item = await until(async () => {
      if (!existsSync(file)) return null;
      const saved = JSON.parse(await readFile(file, "utf8")) as { title: string; state: string; from: unknown; repos: string[]; runs: string[]; branches: string[]; notes: { by: string; text: string }[] };
      return saved.runs.includes(run.id) && saved.branches.includes(run.branch!.origin) ? saved : null;
    }, "the item to record its run and branch");
    expect(item).toMatchObject({ title: "add a file", from: { kind: "note" }, repos: ["proj"], runs: [run.id], branches: [run.branch!.origin] });
    await until(async () => ((await runOf(run.id))?.branch?.state === "ready" ? true : null), "the run to settle ready");
    expect(prompts.at(-1)?.message).toContain(`"Canopy-Work: ${run.branch!.work}"`);
    await until(async () => {
      const saved = JSON.parse(await readFile(file, "utf8")) as { state: string; notes: { by: string; text: string }[] };
      return saved.state === "review" && saved.notes[0]?.text.startsWith("branch ready, ") ? saved : null;
    }, "the item to record the ready branch");
    const got = (await (await fetch(url(`/api/work/one?id=${run.branch!.work}`))).json()) as { state: string; notes: { by: string; text: string }[] };
    expect(got.state).toBe("review");
    expect(got.notes[0]).toMatchObject({ by: "canopy" });
    expect(got.notes[0]?.text.startsWith("branch ready, ")).toBe(true);
  });

  test("propose goes on a branch by default, and branch: false keeps it in the checkout", async () => {
    const r1 = (await (await call("/api/repos/run?id=proj", { action: "propose", note: "plan a thing" })).json()) as Run;
    expect(r1.branch?.name).toBe(`run/${r1.branch?.work}-plan-a-thing`);
    await until(async () => (await runOf(r1.id))?.status === "done", "the propose run");
    const r2 = (await (await call("/api/repos/run?id=proj", { action: "propose", note: "leave it", branch: false })).json()) as Run;
    expect(r2.branch).toBeUndefined();
    await until(async () => (await runOf(r2.id))?.status === "done", "the checkout run");
  });

  test("a run in the checkout and a branch run go side by side", async () => {
    const r1 = (await (await call("/api/repos/run?id=proj", { action: "ask", note: "leave it" })).json()) as Run;
    const r2 = await call("/api/repos/run?id=proj", { action: "ask", note: "leave it", branch: true });
    expect(r2.status).toBe(201);
    await until(async () => (await runOf(r1.id))?.status === "done", "the checkout run");
    const b = (await r2.json()) as Run;
    const settled = await until(async () => {
      const r = await runOf(b.id);
      return r?.branch?.state === "nothing" ? r : null;
    }, "the branch run to settle with nothing");
    expect(settled.outcome).toBe("unchanged");
  });

  test("a repo with nothing to cut from: propose falls back to the checkout, an explicit branch is refused", async () => {
    const r = await call("/api/repos/run?id=bare", { action: "ask", note: "x", branch: true });
    expect(r.status).toBe(400);
    expect(((await r.json()) as { error: string }).error).toContain("no main or master");
    const failed = (await (await fetch(url("/api/work?repo=bare"))).json()) as { items: { title: string; state: string; reason?: string }[] };
    expect(failed.items).toHaveLength(1);
    expect(failed.items[0]).toMatchObject({ title: "x", state: "dropped" });
    expect(failed.items[0]?.reason).toContain("the run did not start");
    const p = (await (await call("/api/repos/run?id=bare", { action: "propose", note: "leave it" })).json()) as Run;
    expect(p.branch).toBeUndefined();
    await until(async () => (await runOf(p.id))?.status === "done", "the bare repo's run");
    const afterCheckout = (await (await fetch(url("/api/work?repo=bare"))).json()) as { items: { title: string }[] };
    expect(afterCheckout.items).toHaveLength(1);
  });

  test("a bad branch flag is a 400", async () => {
    expect((await call("/api/repos/run?id=proj", { action: "ask", note: "x", branch: "yes" })).status).toBe(400);
  });

  test("pr: true marks the branch to open a PR when ready; with no remote it waits as ready with a notice", async () => {
    expect((await call("/api/repos/run?id=proj", { action: "ask", note: "x", pr: "yes" })).status).toBe(400);
    const off = await call("/api/repos/run?id=proj", { action: "ask", note: "x", branch: false, pr: true });
    expect(off.status).toBe(400);
    expect(((await off.json()) as { error: string }).error).toBe("only a run on a branch of its own can open a PR");
    const start = await call("/api/repos/run?id=proj", { action: "ask", note: "open a pr", branch: true, pr: true });
    expect(start.status).toBe(201);
    const run = (await start.json()) as Run;
    expect(run.branch?.openPr).toBe(true);
    const held = await until(async () => (await landing()).notices?.find((n) => n.entry === run.branch!.origin), "the held notice");
    expect(held.why).toBe("its PR did not open: its repo has no remote to push to");
    const rec = (await landing()).runs.find((r) => r.id === run.branch!.origin);
    expect([rec?.state, rec?.openPr, rec?.pr]).toEqual(["ready", true, undefined]);
    expect(await (await fetch(url("/api/prs"))).json()).toEqual([]);
    const open = await call("/api/prs/open", { run: run.id });
    expect(open.status).toBe(409);
  });
});

