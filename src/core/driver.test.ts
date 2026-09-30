import { describe, expect, test } from "bun:test";
import { exitOutcome, RunCtx, settleNote, STEP_CAP, type DriveRun } from "./driver";

const AGENT = { model: "default", effort: "default", yolo: false, extra: "" };
const SPEC = { allowedTools: [], maxTurns: 10 };

function makeCtx(chat = false) {
  const run: DriveRun = {
    id: "r1",
    repoId: "fx",
    action: chat ? "chat" : "ask",
    verb: chat ? "chat" : "ask",
    progress: "working",
    expectsChange: false,
    chat,
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
    { cwd: "/r", agent: AGENT, spec: SPEC, label: "Codex" },
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

  test("a stop's exit is a stop, and the session is kept", () => {
    const { run, ctx } = makeCtx();
    ctx.session("thr-1");
    ctx.stopping = true;
    ctx.exited({ code: null, stderr: "killed" });
    expect(run.status).toBe("stopped");
    expect(run.session).toBe("thr-1");
    expect(run.error).toBeUndefined();
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
