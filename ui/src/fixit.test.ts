import { describe, expect, test } from "bun:test";
import { AUTO_FIX_MS, fixedNote, fixMove, fixPrompt, freshFailure, lastRun, moveDone, repairConfirmed, repairStatusSnapshot, repairTurnIdentity, taskFixPrompt, type RepairRun, type RepairStatus } from "./fixit";
import type { RepoFile } from "../../src/core/types";

describe("fixMove", () => {
  test("knows the moves an agent can finish", () => {
    expect(fixMove("push")).toBe("push");
    expect(fixMove("commit+push")).toBe("commit+push");
    expect(fixMove("spec sync")).toBe("spec sync");
  });

  test("leaves out the rest", () => {
    expect(fixMove("suggest")).toBeNull();
    expect(fixMove("open-vscode")).toBeNull();
    expect(fixMove("seed")).toBeNull();
    expect(fixMove("toString")).toBeNull();
  });
});

describe("fixPrompt", () => {
  const rejected = [
    "To https://github.com/BaruchEric/homelab.git",
    " ! [rejected]        main -> main (non-fast-forward)",
    "error: failed to push some refs to 'https://github.com/BaruchEric/homelab.git'",
  ].join("\n");

  test("quotes git and asks for the push to be finished", () => {
    const p = fixPrompt("push", `${rejected}\n`);
    expect(p.startsWith("I pressed push in canopy and it failed:")).toBe(true);
    expect(p).toContain(" ! [rejected]        main -> main (non-fast-forward)");
    expect(p).toContain("then finish the push.");
    expect(p).not.toContain("Do not push");
  });

  test("a plain commit says not to push", () => {
    expect(fixPrompt("commit", "nothing staged")).toContain("then finish the commit. Do not push.");
  });

  test("keeps the last 40 lines of a long answer", () => {
    const long = Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n");
    const p = fixPrompt("pull", long);
    expect(p).toContain("line 99");
    expect(p).toContain("line 60");
    expect(p).not.toContain("line 59\n");
  });
});

describe("lastRun", () => {
  const line = (n: number, text: string, mark?: true) => ({ n, text, at: mark ? n : null, ...(mark ? { mark } : {}) });

  test("keeps what follows the last start marker", () => {
    const lines = [line(1, "<m>", true), line(2, "old run"), line(3, "<m>", true), line(4, "new run"), line(5, "exit")];
    expect(lastRun(lines)).toEqual(["new run", "exit"]);
  });

  test("keeps the whole tail when no marker is in it", () => {
    expect(lastRun([line(7, "a"), line(8, "b")])).toEqual(["a", "b"]);
  });
});

describe("taskFixPrompt", () => {
  const task = { name: "test", cmd: "bun run test", exitCode: 1 };

  test("names the task, its command and its exit, and quotes the output", () => {
    const p = taskFixPrompt(task, ["(fail) spawnOnPty > leads a session", " 1 fail"]);
    expect(p.startsWith("I ran the test task in canopy (bun run test) and it exited 1.")).toBe(true);
    expect(p).toContain("(fail) spawnOnPty > leads a session");
    expect(p).toContain("run bun run test again until it passes.");
    expect(p).toContain("do not commit or push.");
  });

  test("a task that vanished died, and one that printed nothing says so", () => {
    const p = taskFixPrompt({ ...task, exitCode: null }, []);
    expect(p).toContain("and it died.");
    expect(p).toContain("(it printed nothing)");
  });

  test("keeps the last 60 lines of a long run", () => {
    const p = taskFixPrompt(task, Array.from({ length: 100 }, (_, i) => `line ${i}`));
    expect(p).toContain("line 99");
    expect(p).toContain("line 40");
    expect(p).not.toContain("line 39\n");
  });
});

describe("freshFailure", () => {
  test("a failure just now goes to the agent by itself", () => {
    expect(freshFailure(1_000, 1_000)).toBe(true);
    expect(freshFailure(1_000, 1_000 + AUTO_FIX_MS - 1)).toBe(true);
  });

  test("an old one, or one from a clock ahead, waits for a press", () => {
    expect(freshFailure(1_000, 1_000 + AUTO_FIX_MS)).toBe(false);
    expect(freshFailure(2_000, 1_000)).toBe(false);
  });
});

describe("moveDone", () => {
  const file = (over: Partial<RepoFile> = {}): RepoFile => ({ path: "a.ts", index: ".", worktree: "M", untracked: false, conflicted: false, ...over });
  const st = (ahead: number, behind: number, files: RepoFile[] = []) => ({ ahead, behind, files });

  test("a push is done once nothing is ahead or behind", () => {
    expect(moveDone("push", st(1, 3))).toBe(false);
    expect(moveDone("push", st(0, 3))).toBe(false);
    expect(moveDone("push", st(0, 0))).toBe(true);
  });

  test("a pull is done once nothing is behind, whatever is ahead", () => {
    expect(moveDone("pull", st(1, 3))).toBe(false);
    expect(moveDone("pull", st(2, 0))).toBe(true);
  });

  test("a commit is done once nothing is staged or conflicted; edits and new files may stay", () => {
    expect(moveDone("commit", st(1, 0, [file({ index: "M" })]))).toBe(false);
    expect(moveDone("commit", st(1, 0, [file({ conflicted: true, index: "U" })]))).toBe(false);
    expect(moveDone("commit", st(1, 0, [file(), file({ path: "n.ts", index: "?", worktree: "?", untracked: true })]))).toBe(true);
    expect(moveDone("commit+push", st(1, 0))).toBe(false);
    expect(moveDone("commit+push", st(0, 0))).toBe(true);
  });

  test("a move the status cannot speak for", () => {
    expect(moveDone("peer sync", st(0, 0))).toBeNull();
    expect(moveDone("spec sync", st(0, 0))).toBeNull();
  });

  test("the note it turns into", () => {
    expect(fixedNote("commit+push")).toBe("The agent finished the commit and push.");
  });
});

describe("repair confirmation", () => {
  const clear: RepairStatus = { ahead: 0, behind: 0, files: [] };
  const beforePull: RepairStatus = { ahead: 1, behind: 2, files: [] };
  const completedTurn = {
    id: "chat-1",
    status: "idle",
    result: { text: "Pulled the latest changes.", durationMs: 1, turns: 1 },
    steps: [{ id: "4", at: 400, kind: "text", text: "Pulled the latest changes." }],
  } satisfies RepairRun;

  test("an idle run without a newly completed reply cannot confirm an already-clear status", () => {
    expect(repairTurnIdentity({ ...completedTurn, result: undefined })).toBeNull();
    expect(repairConfirmed("pull", { ...completedTurn, status: "working" }, beforePull, clear, null)).toBe(false);
    expect(repairConfirmed("pull", completedTurn, clear, clear, null)).toBe(false);
  });

  test("a fresh successful turn must move the rescan from unfinished to finished", () => {
    const identity = repairTurnIdentity(completedTurn);
    expect(identity).not.toBeNull();
    expect(repairConfirmed("pull", completedTurn, beforePull, { ...clear, behind: 1 }, null)).toBe(false);
    expect(repairConfirmed("pull", completedTurn, beforePull, clear, identity)).toBe(false);
    expect(repairConfirmed("pull", { ...completedTurn, error: "could not finish" }, beforePull, clear, null)).toBe(false);
    expect(repairConfirmed("pull", { ...completedTurn, status: "failed" }, beforePull, clear, null)).toBe(false);
    expect(repairConfirmed("pull", completedTurn, beforePull, clear, null)).toBe(true);
  });

  test("a later successful reply on the same chat has a distinct completion identity", () => {
    const first = repairTurnIdentity(completedTurn);
    const secondTurn = {
      ...completedTurn,
      result: { ...completedTurn.result, turns: 2 },
      steps: [...completedTurn.steps, { id: "7", at: 700, kind: "text", text: completedTurn.result.text }],
    } satisfies RepairRun;
    const second = repairTurnIdentity(secondTurn);
    expect(second).not.toBe(first);
    expect(repairConfirmed("pull", secondTurn, beforePull, clear, first)).toBe(true);
  });

  test("the baseline is a detached snapshot", () => {
    const file: RepoFile = { path: "a.ts", index: ".", worktree: "M", untracked: false, conflicted: false };
    const original = { ahead: 0, behind: 1, files: [file] };
    const snapshot = repairStatusSnapshot(original);
    original.behind = 0;
    file.index = "M";
    expect(snapshot).toEqual({ ahead: 0, behind: 1, files: [{ path: "a.ts", index: ".", worktree: "M", untracked: false, conflicted: false }] });
  });
});
