/**
 * Remembering on a real server with a stand-in agent: an allow that
 * remembers keeps its rule only when the rule covers the prompt and the run
 * has the scope, the rule then answers the run's later matching permission
 * without asking, a chain and a question still wait, and forgetting drops
 * the rule from the config dir. An answer of the wrong kind for the prompt
 * (approve to a question, allow-all to a plan) is refused.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import type { DriveCtx, PromptInput, RunDriver } from "../core/driver";
import type { Harness, RememberedRule, Run, RunAnswer } from "../core/types";
import { startServer } from "./index";

const SCRIPT: PromptInput[] = [
  { kind: "permission", tool: "Bash", title: "git status --short", detail: "git status --short", command: "git status --short" },
  { kind: "permission", tool: "Bash", title: "git status", detail: "git status", command: "git status" },
  { kind: "permission", tool: "Bash", title: "git status && rm x", detail: "git status && rm x", command: "git status && rm x" },
  { kind: "question", questions: [{ question: "Which?", header: "", options: [{ label: "a", description: "" }], multiSelect: false }] },
  { kind: "proposal", plan: "# Plan\n1. add it", auto: false },
];

/** each answer the agent got, in order */
const answers: RunAnswer[] = [];

/** asks the script's prompts one after another, then holds until stopped */
class AskingDriver implements RunDriver {
  readonly label = "Claude Code";
  private ctx: DriveCtx | null = null;
  constructor(readonly harness: Harness) {}
  check(): string | null {
    return null;
  }
  start(ctx: DriveCtx): void {
    this.ctx = ctx;
    void (async () => {
      for (const [i, p] of SCRIPT.entries()) answers.push(await ctx.ask(p, String(i)));
    })();
  }
  say(): void {}
  stop(): void {
    this.ctx?.exited({ code: null, stderr: "" });
  }
}

let scratch: string;
let root: string;
let previous: string | undefined;

async function until(pred: () => boolean | Promise<boolean>, what: string, ms = 10_000): Promise<void> {
  const start = Date.now();
  while (!(await pred())) {
    if (Date.now() - start > ms) throw new Error(`gave up waiting for ${what}`);
    await Bun.sleep(30);
  }
}

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "canopy-remember-"));
  previous = process.env["CANOPY_CONFIG_DIR"];
  process.env["CANOPY_CONFIG_DIR"] = join(scratch, "config");
  root = join(scratch, "root");
  await mkdir(join(root, "proj"), { recursive: true });
  Bun.spawnSync(["git", "init", "-q"], { cwd: join(root, "proj") });
});

afterAll(async () => {
  if (previous === undefined) delete process.env["CANOPY_CONFIG_DIR"];
  else process.env["CANOPY_CONFIG_DIR"] = previous;
  await rm(scratch, { recursive: true, force: true });
});

test("remember keeps a covering rule, answers the next match with it, and forget drops it", async () => {
  const dir = process.env["CANOPY_CONFIG_DIR"] ?? "";
  await mkdir(dir, { recursive: true });
  if (!(await realpath(dir)).startsWith((await realpath(tmpdir())) + sep)) throw new Error("refusing a config dir outside tmp");
  const srv = await startServer({ root, port: 0, chan: null, harnesses: ["claude"], runner: { driver: (h) => new AskingDriver(h) } });
  const base = `http://127.0.0.1:${srv.port}`;
  const post = (path: string, body: unknown) => fetch(`${base}${path}`, { method: "POST", body: JSON.stringify(body) });
  const run = async (id: string) => ((await (await fetch(`${base}/api/runs`)).json()) as Run[]).find((r) => r.id === id);
  try {
    const started = await post("/api/repos/run?id=proj", { action: "ask", note: "look around" });
    expect(started.status).toBe(201);
    const { id } = (await started.json()) as Run;
    await until(async () => (await run(id))?.prompt?.id === "p1", "the first prompt");
    const remember = (rule: string, scope: string) => post("/api/runs/answer", { id, promptId: "p1", answer: { kind: "allow", remember: { rule, scope } } });

    // a rule that would not have answered this prompt is refused, and nothing is answered
    expect((await remember("Bash(rm:*)", "repo")).status).toBe(409);
    // a plain run has no step or workflow to remember for
    expect((await remember("Bash(git status:*)", "step")).status).toBe(400);
    expect((await remember("Edit(src/**)", "repo")).status).toBe(409);
    // a rule that covers the prompt but that the page never offers: git:* would also cover git -c alias.x=...
    const unoffered = await remember("Bash(git:*)", "repo");
    expect(unoffered.status).toBe(409);
    expect(((await unoffered.json()) as { error: string }).error).toContain("does not offer");
    // a save against a prompt id this run never asked is refused before any rule is kept
    // (one asked and no longer waiting is a 409, propose.test.ts)
    const stale = await post("/api/runs/answer", { id, promptId: "p9", answer: { kind: "allow", remember: { rule: "Bash(git status:*)", scope: "repo" } } });
    expect(stale.status).toBe(404);
    expect((await run(id))?.prompt?.id).toBe("p1");
    expect(((await (await fetch(`${base}/api/remembered`)).json()) as { rules: RememberedRule[] }).rules).toEqual([]);

    expect((await remember("Bash(git status:*)", "repo")).status).toBe(200);
    const saved = JSON.parse(await readFile(join(dir, "remembered.json"), "utf8")) as { rules: RememberedRule[] };
    expect(saved.rules.map((r) => [r.rule, r.scope, r.from])).toEqual([["Bash(git status:*)", { kind: "repo", path: await realpath(join(root, "proj")) }, "git status --short"]]);

    // the second prompt matches and is let through; the chain waits
    await until(async () => (await run(id))?.prompt?.id === "p2", "the chain's prompt");
    expect(answers).toEqual([{ kind: "allow", remember: { rule: "Bash(git status:*)", scope: "repo" } }, { kind: "allow" }]);
    const notes = (await run(id))?.steps.filter((s) => s.kind === "note").map((s) => s.text);
    expect(notes).toEqual(["allowed, and remembered Bash(git status:*): git status --short", "allowed by a remembered rule (Bash(git status:*)): git status"]);
    expect((await run(id))?.prompt).toMatchObject({ kind: "permission", command: "git status && rm x" });

    // a bare Bash answers the chain; the question after it still waits
    expect((await post("/api/runs/answer", { id, promptId: "p2", answer: { kind: "allow", remember: { rule: "Bash", scope: "repo" } } })).status).toBe(200);
    await until(async () => (await run(id))?.prompt?.kind === "question", "the question");

    const list = ((await (await fetch(`${base}/api/remembered`)).json()) as { rules: RememberedRule[] }).rules;
    expect(list.map((r) => r.rule)).toEqual(["Bash(git status:*)", "Bash"]);
    const forgot = await post("/api/remembered/forget", { id: list[1]?.id });
    expect(((await forgot.json()) as { rules: RememberedRule[] }).rules.map((r) => r.rule)).toEqual(["Bash(git status:*)"]);
    expect((await post("/api/remembered/forget", { id: list[1]?.id })).status).toBe(404);
    const after = JSON.parse(await readFile(join(dir, "remembered.json"), "utf8")) as { rules: RememberedRule[] };
    expect(after.rules.map((r) => r.rule)).toEqual(["Bash(git status:*)"]);

    // an answer must fit the prompt it answers: approve is for a plan alone
    const question = (await run(id))?.prompt?.id ?? "";
    const approveQ = await post("/api/runs/answer", { id, promptId: question, answer: { kind: "approve", auto: false } });
    expect(approveQ.status).toBe(400);
    expect(((await approveQ.json()) as { error: string }).error).toBe("only a plan is approved");
    expect((await run(id))?.prompt?.id).toBe(question);
    expect((await post("/api/runs/answer", { id, promptId: question, answer: { kind: "answers", answers: { "Which?": "a" } } })).status).toBe(200);
    await until(async () => (await run(id))?.prompt?.kind === "proposal", "the plan");
    const plan = (await run(id))?.prompt?.id ?? "";
    // a plan takes approve or deny: allow-all, answers, or an allow that would keep a rule are refused, and nothing is kept
    for (const answer of [{ kind: "allow-all" }, { kind: "answers", answers: { x: "y" } }, { kind: "allow" }, { kind: "allow", remember: { rule: "Bash", scope: "repo" } }]) {
      expect((await post("/api/runs/answer", { id, promptId: plan, answer })).status).toBe(400);
    }
    expect((await run(id))?.prompt?.id).toBe(plan);
    expect(((await (await fetch(`${base}/api/remembered`)).json()) as { rules: RememberedRule[] }).rules.map((r) => r.rule)).toEqual(["Bash(git status:*)"]);
    expect((await post("/api/runs/answer", { id, promptId: plan, answer: { kind: "approve", auto: true } })).status).toBe(200);
    // auto was never offered here, so the approval asks before commands
    await until(() => answers.length === 5, "the plan's answer");
    expect(answers.at(-1)).toEqual({ kind: "approve", auto: false });
  } finally {
    srv.stop();
  }
}, 30_000);
