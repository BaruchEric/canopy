import { describe, expect, test } from "bun:test";
import type { Repo, RepoStatus, TaskInfo } from "../../src/core/types";
import type { TermTab } from "./term";
import { canSave, claudeCandidates, debugPrompt, devState, pendingClaude, plainStatus, tourStep } from "./guided";

const status = (over: Partial<RepoStatus> = {}): RepoStatus => ({
  branch: "main",
  upstream: "origin/main",
  ahead: 0,
  behind: 0,
  files: [],
  lastCommit: null,
  user: null,
  ...over,
});
const repo = (over: Partial<Repo> = {}): Repo => ({ id: "app", name: "app", path: "/r/app", status: status(), ...over }) as Repo;
const file = { path: "a.ts", x: ".", y: "M" } as unknown as RepoStatus["files"][number];
const task = (s: TaskInfo["status"]): TaskInfo => ({ name: "dev", status: s, dev: true }) as TaskInfo;
const tab = (id: string, repoId: string, place: "panel" | "strip", task?: string): TermTab => ({
  id,
  repoId,
  name: repoId,
  path: `/r/${repoId}`,
  place,
  ...(task ? { task } : {}),
});

describe("devState", () => {
  test("no task, running, restarting, failed, stopped", () => {
    expect(devState(undefined)).toBe("none");
    expect(devState(task("running"))).toBe("running");
    expect(devState(task("backoff"))).toBe("running");
    expect(devState(task("failed"))).toBe("failed");
    expect(devState(task("gave-up"))).toBe("failed");
    expect(devState(task("idle"))).toBe("stopped");
    expect(devState(task("stopped"))).toBe("stopped");
    expect(devState(task("exited"))).toBe("stopped");
  });
});

describe("plainStatus", () => {
  test("changed files, counted", () => {
    expect(plainStatus(repo({ status: status({ files: [file, file, file] }) }), "none")).toBe("3 files changed, not saved yet");
    expect(plainStatus(repo({ status: status({ files: [file] }) }), "none")).toBe("1 file changed, not saved yet");
  });
  test("saved but not pushed, saved and pushed, no upstream", () => {
    expect(plainStatus(repo({ status: status({ ahead: 2 }) }), "none")).toBe("saved, not backed up yet");
    expect(plainStatus(repo(), "none")).toBe("all saved and backed up");
    expect(plainStatus(repo({ status: status({ upstream: null }) }), "none")).toBe("saved on this computer only");
  });
  test("a scan error, and the app's state after", () => {
    expect(plainStatus(repo({ status: null, error: "boom" }), "none")).toBe("can't read this project");
    expect(plainStatus(repo(), "running")).toBe("all saved and backed up · app running");
    expect(plainStatus(repo(), "failed")).toBe("all saved and backed up · app stopped with an error");
  });
});

describe("canSave", () => {
  test("dirty, ahead, or never pushed can save; clean and level cannot", () => {
    expect(canSave(repo({ status: status({ files: [file] }) }))).toBe(true);
    expect(canSave(repo({ status: status({ ahead: 1 }) }))).toBe(true);
    expect(canSave(repo())).toBe(false);
    expect(canSave(repo({ status: null }))).toBe(false);
  });
});

describe("debugPrompt", () => {
  test("keeps the last 40 lines under the ask", () => {
    const lines = Array.from({ length: 50 }, (_, i) => `line ${i}`);
    const p = debugPrompt(lines);
    expect(p.startsWith("My app shows this error. Find the cause and fix it.")).toBe(true);
    expect(p).toContain("line 49");
    expect(p).toContain("line 10");
    expect(p).not.toContain("line 9\n");
  });
  test("no lines, no block", () => {
    expect(debugPrompt([])).toBe("My app shows this error. Find the cause and fix it.");
  });
});

describe("claudeCandidates", () => {
  test("the showing shell first, then the repo's panel shells newest first, then its strip shells", () => {
    const tabs = [tab("p1", "app", "panel"), tab("s1", "app", "strip"), tab("p2", "app", "panel"), tab("x", "other", "panel")];
    expect(claudeCandidates(tabs[1] ?? null, tabs, "app")).toEqual(["s1", "p2", "p1"]);
    expect(claudeCandidates(null, tabs, "app")).toEqual(["p2", "p1", "s1"]);
  });
  test("a task's tab and another repo's showing tab are never candidates", () => {
    const tabs = [tab("t", "app", "panel", "dev"), tab("x", "other", "strip")];
    expect(claudeCandidates(tabs[1] ?? null, tabs, "app")).toEqual([]);
  });
});

describe("tourStep", () => {
  test("next walks the three steps, skip ends at once", () => {
    expect(tourStep(0, "next")).toBe(1);
    expect(tourStep(1, "next")).toBe(2);
    expect(tourStep(2, "next")).toBe("done");
    expect(tourStep(1, "skip")).toBe("done");
    expect(tourStep("done", "next")).toBe("done");
  });
});

describe("pendingClaude", () => {
  test("the newest live tab of the repo started with claude", () => {
    const a = { ...tab("a", "app", "panel"), start: "claude" as const };
    const b = { ...tab("b", "app", "strip"), start: "claude" as const };
    const ended = { ...tab("c", "app", "panel"), start: "claude" as const, exit: 0 };
    expect(pendingClaude([a, b, ended, tab("d", "app", "panel")], "app")).toBe("b");
    expect(pendingClaude([a], "other")).toBeNull();
    expect(pendingClaude([tab("d", "app", "panel")], "app")).toBeNull();
  });
});
