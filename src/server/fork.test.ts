/**
 * Forks over the API (FR-043 plan 3): `POST /api/runs/fork` on a finished
 * run makes a new branch run cut from the original's base, and how it gets
 * the original's context: a Claude transcript cut after the step and placed
 * for the fork's worktree (removed once the fork ends), the whole session
 * from the end or when the step is not in the transcript, a Codex thread
 * forked, or a fenced brief when nothing can be resumed. Against a scratch
 * repo, a scratch Claude config dir and a driver that records its spec.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describeTool } from "../core/actions";
import type { DriveCtx, RunDriver } from "../core/driver";
import { exec } from "../core/exec";
import { realDir, transcriptPath } from "../core/forkcut";
import { HANDOFF_OPEN } from "../core/handoff";
import type { Harness, Run } from "../core/types";
import { startServer } from "./index";

const SESSION = "aaaaaaaa-0000-4000-8000-000000000001";
const CODEX_THREAD = "cccccccc-0000-4000-8000-000000000003";
const FORKED = "bbbbbbbb-0000-4000-8000-000000000002";

interface Start {
  harness: Harness;
  cwd: string;
  message: string;
  resume: string | undefined;
  fork: boolean;
  /** the transcript copy at the resumed id for this worktree, as the driver found it */
  copy: string[] | null;
}
const starts: Start[] = [];

/** A driver that records what it was started with, makes three steps and
 *  ends done, with a session id of its harness's. */
class ForkDriver implements RunDriver {
  readonly label = "fake";
  constructor(readonly harness: Harness) {}
  check(): string | null {
    return null;
  }
  start(ctx: DriveCtx, message: string): void {
    const resume = ctx.spec.resume;
    void (async () => {
      // the CLI's cwd is the real path, so that is the slug it reads
      const file = resume ? transcriptPath(await realDir(ctx.cwd), resume, claudeDir) : null;
      const copy = file && existsSync(file) ? (await readFile(file, "utf8")).split("\n").filter(Boolean) : null;
      starts.push({ harness: this.harness, cwd: ctx.cwd, message, resume, fork: ctx.spec.fork === true, copy });
      ctx.step({ kind: "text", text: "Looking." });
      ctx.step({ kind: "tool", tool: { name: "Read", title: describeTool("Read", { file_path: join(ctx.cwd, "a.txt") }, ctx.cwd), status: "ok" } });
      ctx.step({ kind: "text", text: "Read it." });
      ctx.session(this.harness === "codex" ? CODEX_THREAD : resume ? FORKED : SESSION);
      ctx.result({ text: "done", durationMs: 1, turns: 1 }, null);
      ctx.exited({ code: 0, stderr: "" });
    })();
  }
  say(): void {}
  stop(): void {}
}

let scratch: string;
let root: string;
let claudeDir: string;
let previousConfig: string | undefined;
let previousClaude: string | undefined;
let server: Awaited<ReturnType<typeof startServer>>;
let original: Run;
/** a step's number as the replay bar and the route count them, from 1 */
const nth = (step: Run["steps"][number] | null | undefined): number => (step ? original.steps.indexOf(step) + 1 : 0);
const stepOf = (kind: string, which: "first" | "last" = "first") => {
  const hits = original.steps.filter((s) => s.kind === kind);
  return (which === "first" ? hits[0] : hits.at(-1)) ?? null;
};

const url = (p: string) => `http://127.0.0.1:${server.port}${p}`;
const call = (p: string, body: unknown) => fetch(url(p), { method: "POST", body: JSON.stringify(body) });
const runOf = async (id: string) => ((await (await fetch(url("/api/runs"))).json()) as Run[]).find((r) => r.id === id);
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

/** a run that has ended and whose branch the runner has read */
const settled = (id: string) => until(async () => {
  const r = await runOf(id);
  return r && r.status === "done" && r.branch?.state !== "working" ? r : null;
}, `run ${id} to settle`);

/** The original's transcript as Claude Code would have filed it for its
 *  worktree: its first two steps and the result; the third step's words
 *  are left out, so a fork at it has nothing to cut at. */
function transcript(cwd: string): string[] {
  const line = (type: string, uuid: string, parent: string | null, over: Record<string, unknown>) =>
    JSON.stringify({ type, uuid, parentUuid: parent, sessionId: SESSION, cwd, isSidechain: false, ...over });
  return [
    JSON.stringify({ type: "summary", summary: "looked at a.txt", leafUuid: "u6" }),
    line("user", "u1", null, { message: { role: "user", content: "look at a.txt" } }),
    line("assistant", "u2", "u1", { message: { role: "assistant", content: [{ type: "text", text: "Looking." }] } }),
    line("assistant", "u3", "u2", { message: { role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "Read", input: { file_path: join(cwd, "a.txt") } }] } }),
    line("user", "u4", "u3", { message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "one" }] } }),
    line("assistant", "u5", "u4", { message: { role: "assistant", content: [{ type: "text", text: "It says one." }] } }),
    line("assistant", "u6", "u5", { message: { role: "assistant", content: [{ type: "text", text: "done" }] } }),
  ];
}

/** the original's transcript where the CLI would have filed it: under its
 *  worktree's real path */
async function fileTranscript(run: Run): Promise<string> {
  const file = transcriptPath(await realDir(run.branch?.dir ?? ""), SESSION, claudeDir);
  await mkdir(join(file, ".."), { recursive: true });
  await writeFile(file, `${transcript(run.branch?.dir ?? "").join("\n")}\n`);
  return file;
}

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "canopy-fork-"));
  previousConfig = process.env["CANOPY_CONFIG_DIR"];
  previousClaude = process.env["CLAUDE_CONFIG_DIR"];
  process.env["CANOPY_CONFIG_DIR"] = join(scratch, "config");
  claudeDir = join(scratch, "claude");
  process.env["CLAUDE_CONFIG_DIR"] = claudeDir;
  root = join(scratch, "root");
  const proj = join(root, "proj");
  await mkdir(proj, { recursive: true });
  await exec(["git", "init", "-q", "-b", "main", proj]);
  await writeFile(join(proj, "a.txt"), "one\n");
  await exec(["git", "-C", proj, "add", "-A"]);
  await exec(["git", "-C", proj, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "one"]);
  server = await startServer({
    root,
    port: 0,
    chan: null,
    harnesses: ["claude", "codex"],
    runner: { driver: (h) => new ForkDriver(h) },
  });
  const start = await call("/api/repos/run?id=proj", { action: "ask", note: "look at a.txt", branch: true });
  expect(start.status).toBe(201);
  original = await settled(((await start.json()) as Run).id);
  // the runner's own note on the worktree comes first, and counts as a step
  expect(original.steps.map((s) => s.kind)).toEqual(["note", "text", "tool", "text"]);
  await fileTranscript(original);
  // main moves on after the original ran, so a fork's base is not its tip
  await writeFile(join(proj, "b.txt"), "two\n");
  await exec(["git", "-C", proj, "add", "-A"]);
  await exec(["git", "-C", proj, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "two"]);
});

afterAll(async () => {
  await server.stop();
  if (previousConfig === undefined) delete process.env["CANOPY_CONFIG_DIR"];
  else process.env["CANOPY_CONFIG_DIR"] = previousConfig;
  if (previousClaude === undefined) delete process.env["CLAUDE_CONFIG_DIR"];
  else process.env["CLAUDE_CONFIG_DIR"] = previousClaude;
  await rm(scratch, { recursive: true, force: true });
});

describe("POST /api/runs/fork", () => {
  test("at a tool step, Claude onto Claude: a cut copy of the transcript resumed under a new id in a fresh worktree from the original's base, removed once the fork ends", async () => {
    const step = stepOf("tool");
    if (!step) throw new Error("no tool step");
    const res = await call("/api/runs/fork", { run: original.id, step: step.id });
    expect(res.status).toBe(201);
    const fork = (await res.json()) as Run;
    expect(fork.forkOf).toEqual({ run: original.id, step: step.id, at: nth(step), how: "cut" });
    expect(fork.action).toBe("ask");
    expect(fork.note).toBe("");
    expect(fork.branch?.base).toBe(original.branch?.base ?? "");
    expect(await git(join(root, "proj"), "rev-parse", "main")).not.toBe(fork.branch?.base);
    expect(fork.branch?.dir).not.toBe(original.branch?.dir);
    expect(fork.branch?.dir.startsWith(join(scratch, "config", "worktrees"))).toBe(true);
    const done = await settled(fork.id);
    expect(done.forkOf?.how).toBe("cut");
    const start = starts.at(-1);
    expect(start?.cwd).toBe(fork.branch?.dir ?? "");
    expect(start?.fork).toBe(true);
    expect(start?.resume).toBeDefined();
    expect(start?.resume).not.toBe(SESSION);
    // the copy: the lines through the Read's result, every sessionId the new one, the later summary gone
    const copy = start?.copy ?? [];
    expect(copy).toHaveLength(4);
    const parsed = copy.map((l) => JSON.parse(l) as { uuid?: string; sessionId?: string; type: string });
    expect(parsed.map((l) => l.uuid)).toEqual(["u1", "u2", "u3", "u4"]);
    expect(parsed.every((l) => l.sessionId === start?.resume)).toBe(true);
    expect(start?.message).toContain(`fork of the session so far, taken at step ${nth(step)} of ${original.steps.length} ("read a.txt")`);
    expect(start?.message).toContain("none of the files the original changed are changed here");
    expect(start?.message).toContain(`You work on the branch ${fork.branch?.name}`);
    expect(start?.message).toContain("Go on from there.");
    expect(start?.message).not.toContain("Note from the user");
    await until(async () => !existsSync(transcriptPath(await realDir(fork.branch?.dir ?? ""), start?.resume ?? "", claudeDir)), "the cut copy to go");
    // the original's own transcript is untouched
    expect(existsSync(transcriptPath(await realDir(original.branch?.dir ?? ""), SESSION, claudeDir))).toBe(true);
    const items = (await (await fetch(url("/api/work?repo=proj"))).json()) as { items: { title: string }[] };
    expect(items.items.map((i) => i.title)).toContain(`fork of ${original.id}: look at a.txt`);
  });

  test("from the end: the whole session goes on under a new id, with the user's note", async () => {
    const res = await call("/api/runs/fork", { run: original.id, note: "now try it with grep" });
    expect(res.status).toBe(201);
    const fork = (await res.json()) as Run;
    expect(fork.forkOf).toEqual({ run: original.id, at: original.steps.length, how: "whole" });
    expect(fork.note).toBe("now try it with grep");
    await settled(fork.id);
    const start = starts.at(-1);
    expect(start?.resume).toBe(SESSION);
    expect(start?.fork).toBe(true);
    expect(start?.copy).toBeNull();
    expect(start?.message).toContain("taken at its end.");
    expect(start?.message).toContain("Note from the user:\nnow try it with grep");
    expect(start?.message).not.toContain("disregard");
  });

  test("at a step the transcript does not have, by its number: the whole session, the cut said in words", async () => {
    const last = stepOf("text", "last");
    const res = await call("/api/runs/fork", { run: original.id, step: nth(last) });
    expect(res.status).toBe(201);
    const fork = (await res.json()) as Run;
    expect(fork.forkOf).toEqual({ run: original.id, step: last?.id ?? "", at: nth(last), how: "whole" });
    await settled(fork.id);
    const start = starts.at(-1);
    expect(start?.resume).toBe(SESSION);
    expect(start?.message).toContain(`taken at step ${nth(last)} of ${original.steps.length} ("Read it.")`);
    expect(start?.message).toContain("disregard everything after it");
  });

  test("with no transcript left: a fresh run from a fenced brief of the steps, in the note", async () => {
    const file = transcriptPath(await realDir(original.branch?.dir ?? ""), SESSION, claudeDir);
    await rm(file);
    try {
      const first = stepOf("text");
      const res = await call("/api/runs/fork", { run: original.id, step: nth(first) });
      expect(res.status).toBe(201);
      const fork = (await res.json()) as Run;
      expect(fork.forkOf).toEqual({ run: original.id, step: first?.id ?? "", at: nth(first), how: "brief" });
      expect(fork.note.startsWith("The text between")).toBe(true);
      expect(fork.note).toContain(`${HANDOFF_OPEN}\nRun ${original.id} (ask on proj), forked at step ${nth(first)} of ${original.steps.length}: Looking.`);
      expect(fork.note).toContain("Go on from where that run was forked");
      await settled(fork.id);
      const start = starts.at(-1);
      expect(start?.resume).toBeUndefined();
      expect(start?.fork).toBe(false);
      expect(start?.message).toContain(HANDOFF_OPEN);
      expect(start?.message).toContain(`You work on the branch ${fork.branch?.name}`);
    } finally {
      await fileTranscript(original);
    }
  });

  test("onto the other harness, by profile: a brief, on that harness", async () => {
    const codex = { harness: "codex", model: "default", effort: "default", yolo: true, extra: "" };
    expect((await call("/api/agents/profile", { name: "codexp", settings: codex })).status).toBe(200);
    const res = await call("/api/runs/fork", { run: original.id, profile: "codexp" });
    expect(res.status).toBe(201);
    const fork = (await res.json()) as Run;
    expect(fork.harness).toBe("codex");
    expect(fork.forkOf).toEqual({ run: original.id, at: original.steps.length, how: "brief" });
    expect(fork.note).toContain(`forked at its end, after ${original.steps.length} steps.`);
    await settled(fork.id);
    expect(starts.at(-1)).toMatchObject({ harness: "codex", resume: undefined, fork: false });
  });

  test("a fork of a fork says so, and the step a fork has is the fork's own", async () => {
    const first = (await (await call("/api/runs/fork", { run: original.id })).json()) as Run;
    await settled(first.id);
    const res = await call("/api/runs/fork", { run: first.id, step: 2 });
    expect(res.status).toBe(201);
    const second = (await res.json()) as Run;
    expect(second.forkOf?.run).toBe(first.id);
    expect(second.forkOf?.at).toBe(2);
    await settled(second.id);
  });

  test("refusals: an unknown run, a step past the end, a step by a name the run has not, a profile it has not, a malformed id", async () => {
    expect((await call("/api/runs/fork", { run: "00000000" })).status).toBe(404);
    const past = await call("/api/runs/fork", { run: original.id, step: 9 });
    expect(past.status).toBe(400);
    expect(((await past.json()) as { error: string }).error).toBe(`step must be 1 to ${original.steps.length}`);
    const named = await call("/api/runs/fork", { run: original.id, step: "nope" });
    expect(named.status).toBe(400);
    expect(((await named.json()) as { error: string }).error).toContain("no step nope");
    expect((await call("/api/runs/fork", { run: original.id, step: true })).status).toBe(400);
    expect((await call("/api/runs/fork", { run: original.id, profile: "none" })).status).toBe(400);
    expect((await call("/api/runs/fork", { run: "../x" })).status).toBe(400);
    expect((await call("/api/runs/fork", { run: 7 })).status).toBe(400);
  });

  test("a Codex run forked onto Codex has its thread forked, whole", async () => {
    expect((await call("/api/agents/role", { role: "job", pick: { profile: "codexp" } })).status).toBe(200);
    const start = await call("/api/repos/run?id=proj", { action: "ask", note: "look again", branch: true });
    expect(start.status).toBe(201);
    const codexRun = await settled(((await start.json()) as Run).id);
    expect(codexRun.harness).toBe("codex");
    expect(codexRun.session).toBe(CODEX_THREAD);
    const at = codexRun.steps.findIndex((s) => s.kind === "text") + 1;
    const res = await call("/api/runs/fork", { run: codexRun.id, step: at });
    expect(res.status).toBe(201);
    const fork = (await res.json()) as Run;
    expect(fork.forkOf).toEqual({ run: codexRun.id, step: codexRun.steps[at - 1]?.id ?? "", at, how: "whole" });
    await settled(fork.id);
    expect(starts.at(-1)).toMatchObject({ harness: "codex", resume: CODEX_THREAD, fork: true, copy: null });
    expect(starts.at(-1)?.message).toContain("disregard everything after it");
  });
});
