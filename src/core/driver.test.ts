import { describe, expect, test } from "bun:test";
import { answerMisfit, exitOutcome, RunCtx, settleNote, STEP_CAP, type DriveRun, type RememberHook } from "./driver";
import { rememberedFor } from "./remember";
import type { RememberedRule } from "./types";

const AGENT = { model: "default", effort: "default", yolo: false, extra: "" };
const SPEC = { allowedTools: [], maxTurns: 10 };

function makeCtx(chat = false, spec: { allowedTools: string[]; maxTurns: number; unattended?: string } = SPEC, remember?: RememberHook, stage = false) {
  const run: DriveRun = {
    id: "r1",
    repoId: "fx",
    action: chat ? "chat" : "ask",
    verb: chat ? "chat" : "ask",
    progress: "working",
    expectsChange: false,
    chat,
    harness: "codex",
    note: "",
    status: "working",
    startedAt: 0,
    steps: [],
    prompt: null,
  };
  const emits: string[] = [];
  const ended: string[] = [];
  const ctx = new RunCtx(
    run,
    { cwd: "/r", agent: AGENT, spec, label: "Codex", stage, ...(remember ? { remember } : {}) },
    { emit: (r) => emits.push(r.status), ended: (r) => ended.push(r.status) },
  );
  return { run, ctx, emits, ended };
}

const perm = (title: string) => ({ kind: "permission" as const, tool: "Bash", title, detail: title });
const notes = (run: DriveRun) => run.steps.filter((s) => s.kind === "note").map((s) => s.text);

describe("how an exit becomes a status", () => {
  test("a stop is a stop, whatever the code", () => {
    expect(exitOutcome({ stopping: true, ending: false }, { code: 137, stderr: "x" }, "Codex")).toEqual({
      status: "stopped",
    });
  });

  test("a chat closed between turns is done when the exit is clean", () => {
    expect(exitOutcome({ stopping: false, ending: true }, { code: 0, stderr: "" }, "Codex")).toEqual({ status: "done" });
    expect(exitOutcome({ stopping: false, ending: true }, { code: 1, stderr: "" }, "Codex").status).toBe("failed");
  });

  test("anything else before a result fails with the stderr tail", () => {
    expect(exitOutcome({ stopping: false, ending: false }, { code: 3, stderr: "boom\n" }, "Codex")).toEqual({
      status: "failed",
      error: "Codex exited (code 3) without a result: boom",
    });
    expect(exitOutcome({ stopping: false, ending: false }, { code: null, stderr: "" }, "Claude Code").error).toBe(
      "Claude Code exited (code null) without a result",
    );
  });

  test("a failure the driver caught leads, with the tail under it", () => {
    expect(
      exitOutcome({ stopping: false, ending: true }, { code: 0, stderr: "tail", error: "could not start" }, "Codex"),
    ).toEqual({ status: "failed", error: "could not start\ntail" });
  });
});

describe("the notes a settled prompt leaves", () => {
  test("in the words the runner has always used", () => {
    expect(settleNote(perm("git push"), { kind: "allow" })).toBe("allowed: git push");
    expect(settleNote(perm("git push"), { kind: "allow-all" })).toBe("allowed everything from here: git push");
    expect(settleNote(perm("git push"), { kind: "deny" })).toBe("denied: git push");
    const q = { kind: "question" as const, questions: [] };
    expect(settleNote(q, { kind: "answers", answers: { a: "x", b: "y" } })).toBe("answered: x; y");
    expect(settleNote(q, { kind: "deny" })).toBe("question dismissed");
  });
});

describe("the prompt queue", () => {
  test("the oldest prompt shows; answering it shows the next, then the run works again", async () => {
    const { run, ctx } = makeCtx();
    const a = ctx.ask(perm("one"), "0");
    const b = ctx.ask(perm("two"), "1");
    expect(run.status).toBe("waiting");
    expect(run.prompt?.id).toBe("p1");
    ctx.answer("p1", { kind: "allow" });
    expect(await a).toEqual({ kind: "allow" });
    expect(run.prompt?.id).toBe("p2");
    ctx.answer("p2", { kind: "deny" });
    expect(await b).toEqual({ kind: "deny" });
    expect(run.status).toBe("working");
    expect(run.prompt).toBeNull();
    expect(notes(run)).toEqual(["allowed: one", "denied: two"]);
    expect(() => ctx.answer("p2", { kind: "allow" })).toThrow("no longer waiting");
  });

  test("an unattended run's every prompt is denied at once with its message, and the run never waits", async () => {
    const { run, ctx, emits } = makeCtx(false, { ...SPEC, unattended: "Nobody is watching; finish with your tools." });
    expect(await ctx.ask(perm("git push"), "0")).toEqual({ kind: "deny", message: "Nobody is watching; finish with your tools." });
    const q = { kind: "question" as const, questions: [{ question: "Which?", header: "", options: [], multiSelect: false }] };
    expect(await ctx.ask(q, "1")).toEqual({ kind: "deny", message: "Nobody is watching; finish with your tools." });
    expect(run.status).toBe("working");
    expect(run.prompt).toBeNull();
    expect(emits).not.toContain("waiting");
    expect(notes(run)).toEqual(["denied, as no one answers this run: git push", "denied, as no one answers this run: the question"]);
  });

  test("allow all lets the queued permissions and every later one through", async () => {
    const { run, ctx } = makeCtx();
    const a = ctx.ask(perm("one"), "0");
    const q = ctx.ask({ kind: "question", questions: [] }, "1");
    const b = ctx.ask(perm("two"), "2");
    ctx.answer("p1", { kind: "allow-all" });
    expect(await a).toEqual({ kind: "allow-all" });
    expect(await b).toEqual({ kind: "allow" });
    // a question is not a permission: it still waits
    expect(run.prompt?.kind).toBe("question");
    ctx.answer(run.prompt?.id ?? "", { kind: "answers", answers: { q: "yes" } });
    expect(await q).toEqual({ kind: "answers", answers: { q: "yes" } });
    // later permissions pass without showing anything
    const before = run.steps.length;
    expect(await ctx.ask(perm("three"), "3")).toEqual({ kind: "allow" });
    expect(run.steps.length).toBe(before);
    expect(run.status).toBe("working");
    expect(notes(run)).toEqual(["allowed everything from here: one", "allowed: two", "answered: yes"]);
  });

  test("a withdrawn prompt settles as a deny; a stop denies them all", async () => {
    const { run, ctx } = makeCtx();
    const a = ctx.ask(perm("one"), "7");
    const b = ctx.ask(perm("two"), "8");
    ctx.withdraw("7");
    expect(await a).toEqual({ kind: "deny" });
    ctx.withdraw("nope");
    ctx.denyAll();
    expect(await b).toEqual({ kind: "deny" });
    expect(run.status).toBe("working");
  });

  test("a prompt settled after the run ended does not bring it back", async () => {
    const { run, ctx } = makeCtx();
    const a = ctx.ask(perm("one"), "0");
    ctx.exited({ code: 1, stderr: "" });
    expect(run.status).toBe("failed");
    ctx.withdraw("0");
    await a;
    expect(run.status).toBe("failed");
  });
});

describe("remembered rules", () => {
  const sh = (command: string, cwd?: string) => ({ kind: "permission" as const, tool: "Bash", title: command, detail: command, command, ...(cwd ? { cwd } : {}) });
  /** a hook over a list the test can add to, matched as the Runner does, in repo /r */
  function hook(rules: RememberedRule[], inside = true): RememberHook {
    return {
      match: (p, facts) => rememberedFor(rules, { path: "/r" }, p, facts, "/r")?.rule ?? null,
      inside: () => Promise.resolve(inside),
    };
  }
  const repoRule = (rule: string): RememberedRule => ({ id: rule, rule, scope: { kind: "repo", path: "/r" }, at: 0 });

  test("a covered permission is allowed at once, with a note naming the rule; the run never waits", async () => {
    const { run, ctx, emits } = makeCtx(false, SPEC, hook([repoRule("Bash(git status:*)")]));
    expect(await ctx.ask(sh("git status --short"), "0")).toEqual({ kind: "allow" });
    expect(emits).not.toContain("waiting");
    expect(notes(run)).toEqual(["allowed by a remembered rule (Bash(git status:*)): git status --short"]);
  });

  test("a chain waits under a prefix rule and passes under a bare Bash", async () => {
    const rules = [repoRule("Bash(git status:*)")];
    const { run, ctx } = makeCtx(false, SPEC, hook(rules));
    void ctx.ask(sh("git status && rm -rf x"), "0");
    expect(run.status).toBe("waiting");
    const { ctx: ctx2 } = makeCtx(false, SPEC, hook([repoRule("Bash")]));
    expect(await ctx2.ask(sh("git status && rm -rf x"), "0")).toEqual({ kind: "allow" });
  });

  test("never a question, even under a rule that covers every tool", async () => {
    const { run, ctx } = makeCtx(false, SPEC, { match: () => "Bash", inside: () => Promise.resolve(true) });
    void ctx.ask({ kind: "question", questions: [] }, "0");
    expect(run.status).toBe("waiting");
    expect(run.prompt?.kind).toBe("question");
  });

  test("an incubator stage's run is never answered by a rule, and its prompts say none can be kept", async () => {
    const { run, ctx } = makeCtx(false, SPEC, hook([repoRule("Bash")]), true);
    void ctx.ask(sh("ls"), "0");
    await Bun.sleep(0);
    expect(run.status).toBe("waiting");
    expect(run.prompt?.kind === "permission" && run.prompt.noRule).toBeTruthy();
    ctx.recheck();
    await Bun.sleep(0);
    expect(run.status).toBe("waiting");
    ctx.denyAll();
  });

  test("a prompt marked noRule waits under a rule that would cover it", async () => {
    const { run, ctx } = makeCtx(false, SPEC, hook([repoRule("Bash")]));
    void ctx.ask({ ...sh("ls"), noRule: "it asks to run outside codex's sandbox" }, "0");
    await Bun.sleep(0);
    expect(run.status).toBe("waiting");
    ctx.denyAll();
  });

  test("a file tool's paths that leave the repo on disk ask after all", async () => {
    const seen: string[][] = [];
    const h: RememberHook = {
      match: () => "Read",
      inside: (p) => {
        seen.push(p.paths ?? []);
        return Promise.resolve(false);
      },
    };
    const { run, ctx } = makeCtx(false, SPEC, h);
    void ctx.ask({ kind: "permission", tool: "Read", title: "read", detail: "", paths: ["/r/link/x"] }, "0");
    await Bun.sleep(0);
    expect(seen).toEqual([["/r/link/x"]]);
    expect(run.status).toBe("waiting");
    ctx.denyAll();
  });

  test("an unattended run still denies everything with its message", async () => {
    const { ctx } = makeCtx(false, { ...SPEC, unattended: "no one" }, hook([repoRule("Bash")]));
    expect(await ctx.ask(sh("ls"), "0")).toEqual({ kind: "deny", message: "no one" });
  });

  test("a folder the request names that leaves the repo on disk asks after all", async () => {
    const { run, ctx } = makeCtx(false, SPEC, hook([repoRule("Bash(ls:*)")], false));
    const a = ctx.ask(sh("ls", "/r/link"), "0");
    await Bun.sleep(0);
    expect(run.status).toBe("waiting");
    ctx.answer("p1", { kind: "deny" });
    expect(await a).toEqual({ kind: "deny" });
  });

  test("the driver's own facts win over the prompt's fields", async () => {
    const { run, ctx } = makeCtx(false, SPEC, hook([repoRule("Bash")]));
    // Codex's input to a running program: a Bash prompt, but not a command
    void ctx.ask(sh("y"), "0", { kind: "other" });
    expect(run.status).toBe("waiting");
  });

  test("recheck settles the waiting permissions a new rule covers and leaves the rest", async () => {
    const rules: RememberedRule[] = [];
    const { run, ctx } = makeCtx(false, SPEC, hook(rules));
    const a = ctx.ask(sh("ls -la"), "0");
    const q = ctx.ask({ kind: "question", questions: [] }, "1");
    const b = ctx.ask(sh("rm x"), "2");
    expect(ctx.waitingPermission("p1")).toEqual({ prompt: { ...sh("ls -la"), id: "p1" }, facts: { kind: "command", command: "ls -la", cwd: null } });
    expect(ctx.waitingPermission("p2")).toBeUndefined();
    rules.push(repoRule("Bash(ls:*)"));
    ctx.recheck();
    expect(await a).toEqual({ kind: "allow" });
    expect(run.prompt?.kind).toBe("question");
    expect(notes(run)).toEqual(["allowed by a remembered rule (Bash(ls:*)): ls -la"]);
    ctx.denyAll();
    await Promise.all([q, b]);
  });

  test("an allow that remembers says so in the timeline", () => {
    expect(settleNote(perm("ls"), { kind: "allow", remember: { rule: "Bash(ls:*)", scope: "repo" } })).toBe("allowed, and remembered Bash(ls:*): ls");
  });
});

describe("results and exits", () => {
  test("a job ends with its result: done, or failed with the problem", () => {
    const ok = makeCtx();
    ok.ctx.result({ text: "all good", durationMs: 5, turns: 1 }, null);
    expect(ok.run.status).toBe("done");
    expect(ok.run.result?.text).toBe("all good");
    expect(ok.ended).toEqual(["done"]);
    // the exit that follows a result changes nothing
    ok.ctx.exited({ code: 0, stderr: "" });
    expect(ok.ended).toEqual(["done"]);

    const bad = makeCtx();
    bad.ctx.result({ text: "", durationMs: 5, turns: 1 }, "the turn was interrupted");
    expect(bad.run.status).toBe("failed");
    expect(bad.run.error).toBe("the turn was interrupted");
  });

  test("a chat goes idle after each result, a failed reply said as a note", () => {
    const { run, ctx, ended } = makeCtx(true);
    ctx.result({ text: "hi", durationMs: 5, turns: 1 }, null);
    expect(run.status).toBe("idle");
    ctx.result({ text: "", durationMs: 5, turns: 2 }, "codex refused the message: busy");
    expect(run.status).toBe("idle");
    expect(notes(run)).toEqual(["codex refused the message: busy"]);
    expect(ended).toEqual([]);
    ctx.ending = true;
    ctx.exited({ code: 0, stderr: "" });
    expect(run.status).toBe("done");
  });

  test("a chat going idle denies and drops the prompts its turn left, and nothing settled then wakes it", async () => {
    const { run, ctx } = makeCtx(true);
    const left = ctx.ask(perm("git push"), "7");
    expect(run.status).toBe("waiting");
    ctx.result({ text: "done", durationMs: 5, turns: 1 }, null);
    expect(await left).toEqual({ kind: "deny" });
    expect(run.status).toBe("idle");
    expect(run.prompt).toBeNull();
    expect(notes(run)).toEqual(["denied: git push"]);
    expect(() => ctx.answer("p1", { kind: "allow" })).toThrow("no longer waiting");
    ctx.withdraw("7");
    expect(run.status).toBe("idle");
  });

  test("a stop's exit is a stop, and the session is kept", () => {
    const { run, ctx } = makeCtx();
    ctx.session("thr-1");
    ctx.stopping = true;
    ctx.exited({ code: null, stderr: "killed" });
    expect(run.status).toBe("stopped");
    expect(run.session).toBe("thr-1");
    expect(run.error).toBeUndefined();
  });

  test("a run that stops or fails ends every step still running, as an error", () => {
    for (const how of ["stop", "fail"] as const) {
      const { run, ctx } = makeCtx();
      const plan = ctx.step({ kind: "tool", tool: { name: "ExitPlanMode", title: "the plan", status: "running" } });
      const read = ctx.step({ kind: "tool", tool: { name: "Read", title: "a.ts", status: "ok" } });
      if (how === "stop") ctx.stopping = true;
      ctx.exited({ code: null, stderr: "" });
      expect(run.status).toBe(how === "stop" ? "stopped" : "failed");
      expect(plan.tool?.status).toBe("error");
      expect(read.tool?.status).toBe("ok");
    }
  });

  test("a run that ends done leaves its steps as they are", () => {
    const { ctx } = makeCtx();
    const step = ctx.step({ kind: "tool", tool: { name: "Bash", title: "ls", status: "running" } });
    ctx.result({ text: "ok", durationMs: 5, turns: 1 }, null);
    expect(step.tool?.status).toBe("running");
  });
});

describe("steps", () => {
  test("the timeline keeps its cap and says when it trimmed", () => {
    const { run, ctx } = makeCtx();
    for (let i = 0; i < STEP_CAP + 5; i++) ctx.step({ kind: "text", text: String(i) });
    expect(run.steps.length).toBe(STEP_CAP + 1);
    expect(run.steps[0]?.text).toBe("earlier steps trimmed");
    expect(run.steps[1]?.text).toBe("5");
  });

  test("a tool step is updated in place", () => {
    const { run, ctx } = makeCtx();
    const s = ctx.step({ kind: "tool", tool: { name: "Bash", title: "ls", status: "running" } });
    if (s.tool) s.tool.status = "ok";
    expect(run.steps[0]?.tool?.status).toBe("ok");
  });
});

test("an answer must fit its prompt: approve is for a plan alone, and a plan takes approve or deny", async () => {
  const plan = { kind: "proposal" as const, plan: "1. x", auto: false };
  expect(answerMisfit(plan, { kind: "approve", auto: false })).toBeNull();
  expect(answerMisfit(plan, { kind: "deny", message: "no" })).toBeNull();
  for (const a of [{ kind: "allow" as const }, { kind: "allow-all" as const }, { kind: "answers" as const, answers: { q: "a" } }]) {
    expect(answerMisfit(plan, a)).toBe("a plan is approved, sent back or turned down");
  }
  expect(answerMisfit(perm("x"), { kind: "approve", auto: true })).toBe("only a plan is approved");
  expect(answerMisfit(perm("x"), { kind: "allow-all" })).toBeNull();

  const { run, ctx } = makeCtx();
  const p = ctx.ask(perm("one"), "0");
  const q = ctx.ask(plan, "1");
  // a queued plan is checked too, not only the prompt on show
  expect(ctx.waiting("p2")).toMatchObject({ kind: "proposal" });
  expect(() => ctx.answer("p2", { kind: "allow-all" })).toThrow("a plan is approved");
  expect(() => ctx.answer("p1", { kind: "approve", auto: false })).toThrow("only a plan is approved");
  expect(run.prompt?.id).toBe("p1");
  expect(notes(run)).toEqual([]);
  ctx.answer("p1", { kind: "allow" });
  expect(await p).toEqual({ kind: "allow" });
  // "run on its own" where it was never offered is approval that asks
  ctx.answer("p2", { kind: "approve", auto: true });
  expect(await q).toEqual({ kind: "approve", auto: false });
  expect(notes(run)).toEqual(["allowed: one", "approved the plan, asking before commands"]);
});

test("a proposal is kept on the run while it is live, never after", () => {
  const { run, ctx, emits } = makeCtx();
  ctx.proposal("# one");
  expect(run.proposal).toBe("# one");
  expect(emits.length).toBe(1);
  ctx.finish("done");
  ctx.proposal("# two");
  expect(run.proposal).toBe("# one");
});

test("the proposal's settle state is kept on the run, past the step cap", async () => {
  const { run, ctx } = makeCtx();
  const plan = { kind: "proposal" as const, plan: "# one", auto: false };
  ctx.proposal("# one");
  expect(run.proposalState).toBe("waiting");
  const asked = ctx.ask(plan, "1");
  ctx.answer(run.prompt?.id ?? "", { kind: "approve", auto: false });
  await asked;
  expect(run.proposalState).toBe("approved");
  // a long build pushes the settle note out of the timeline
  for (let i = 0; i < STEP_CAP + 5; i++) ctx.step({ kind: "text", text: String(i) });
  expect(notes(run)).not.toContain("approved the plan, asking before commands");
  expect(run.proposalState).toBe("approved");
  expect(run.proposal).toBe("# one");
});

test("a revised proposal starts waiting again under its own text", async () => {
  const { run, ctx } = makeCtx();
  ctx.proposal("# one");
  const first = ctx.ask({ kind: "proposal", plan: "# one", auto: true }, "1");
  ctx.answer(run.prompt?.id ?? "", { kind: "deny", message: "smaller" });
  await first;
  expect(run.proposalState).toBe("sent back");
  // the new text never shows under the old label
  ctx.proposal("# two");
  expect(run.proposal).toBe("# two");
  expect(run.proposalState).toBe("waiting");
  const second = ctx.ask({ kind: "proposal", plan: "# two", auto: true }, "2");
  ctx.answer(run.prompt?.id ?? "", { kind: "approve", auto: true });
  await second;
  expect(run.proposalState).toBe("approved-auto");
});

test("a proposal turned down, or settled after newer text came, is labelled for its own text", async () => {
  const { run, ctx } = makeCtx();
  ctx.proposal("# one");
  const stale = ctx.ask({ kind: "proposal", plan: "# one", auto: false }, "1");
  // newer text arrives while the first still waits: its settle is not the new one's
  ctx.proposal("# two");
  ctx.withdraw("1");
  await stale;
  expect(run.proposalState).toBe("waiting");
  const asked = ctx.ask({ kind: "proposal", plan: "# two", auto: false }, "2");
  ctx.denyAll();
  await asked;
  expect(run.proposalState).toBe("turned down");
});

test("settle notes for a proposal", () => {
  const p = { kind: "proposal" as const, plan: "1. x", auto: false };
  expect(settleNote(p, { kind: "approve", auto: false })).toBe("approved the plan, asking before commands");
  expect(settleNote(p, { kind: "approve", auto: true })).toBe("approved the plan, running on its own");
  expect(settleNote(p, { kind: "deny", message: "split step 2" })).toBe("sent the plan back: split step 2");
  expect(settleNote(p, { kind: "deny" })).toBe("turned the plan down");
});
