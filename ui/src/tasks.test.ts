import { describe, expect, test } from "bun:test";
import type { TaskInfo } from "../../src/core/types";
import { devTask, renameOld, taskChip, taskLines, taskWhen, withChange } from "./tasks";

const t = (over: Partial<TaskInfo>): TaskInfo => ({ name: "dev", cmd: "x", repoId: "r", source: "detected", termId: "0".repeat(32), status: "idle", live: false, restarts: 0, viewers: [], ...over });

describe("task words", () => {
  test("the chip: running count, or the first failure", () => {
    expect(taskChip([t({})])).toBeNull();
    expect(taskChip([t({ status: "running" }), t({ name: "b", status: "running" })])?.text).toBe("▶ 2");
    expect(taskChip([t({ status: "running" }), t({ name: "test", status: "failed" })])).toMatchObject({ text: "✕ test", bad: true });
    expect(taskChip([t({ status: "gave-up" })])?.bad).toBe(true);
    expect(taskChip([t({ status: "stopped", exitCode: 130, exitedAt: 0 })])).toBeNull();
  });
  test("when", () => {
    expect(taskWhen(t({ status: "running", startedAt: 0 }), 125_000)).toBe("up 2m");
    expect(taskWhen(t({ status: "failed", exitCode: 1, exitedAt: 0 }), 180_000)).toBe("exit 1 · 3m ago");
    expect(taskWhen(t({ status: "exited", exitCode: 0, exitedAt: 0 }), 10_000)).toBe("exit 0 · now");
    expect(taskWhen(t({ status: "stopped", exitCode: null, exitedAt: 0 }), 180_000)).toBe("stopped · 3m ago");
    expect(taskWhen(t({ status: "stopped", exitCode: 130, exitedAt: 0 }), 10_000)).toBe("stopped · now");
    expect(taskWhen(t({ status: "backoff", retryAt: 4_000 }), 0)).toBe("retry in 4s");
    expect(taskWhen(t({ status: "gave-up" }), 0)).toBe("gave up");
    expect(taskWhen(t({}), 0)).toBe("");
  });
  test("feed lines on transitions only", () => {
    const run = [t({ status: "running" })];
    expect(taskLines(undefined, run, 0)).toEqual(["dev started"]);
    expect(taskLines(run, run, 0)).toEqual([]);
    expect(taskLines(run, [t({ status: "failed", exitCode: 1 })], 0)).toEqual(["dev exited 1"]);
    expect(taskLines(run, [t({ status: "stopped", exitCode: 130 })], 0)).toEqual(["dev stopped"]);
    expect(taskLines(run, [t({ status: "exited", exitCode: 0 })], 0)).toEqual(["dev finished"]);
    expect(taskLines([t({ status: "failed" })], [t({ status: "backoff", retryAt: 2000 })], 0)).toEqual(["dev restarting in 2s"]);
    expect(taskLines([t({ status: "backoff" })], [t({ status: "running", restarts: 1 })], 0)).toEqual(["dev restarted (1)"]);
    expect(taskLines([t({ status: "failed" })], [t({ status: "gave-up" })], 0)).toEqual(["dev gave up"]);
  });
  test("an edit from the sheet is the whole task with one change", () => {
    const task = t({ name: "web", cmd: "vite", cwd: "ui", keep: true, status: "running", suggested: { withPanel: true } });
    expect(withChange(task, { hidden: true })).toEqual({ name: "web", cmd: "vite", cwd: "ui", keep: true, hidden: true });
    expect(withChange(task, { withPanel: true })).toEqual({ name: "web", cmd: "vite", cwd: "ui", keep: true, withPanel: true });
  });
  test("renaming leaves no old task behind", () => {
    const det = t({ name: "dev", cmd: "bun run dev", source: "detected" });
    expect(renameOld(det, "canopy")).toEqual({ def: { name: "dev", cmd: "bun run dev", hidden: true }, target: "canopy" });
    expect(renameOld(det, "repo")).toEqual({ def: { name: "dev", cmd: "bun run dev", hidden: true }, target: "canopy" });
    const file = t({ name: "web", cmd: "vite", source: "repo" });
    expect(renameOld(file, "repo")).toEqual({ def: null, target: "repo" });
    expect(renameOld(file, "canopy")).toEqual({ def: { name: "web", cmd: "vite", hidden: true }, target: "canopy" });
    expect(renameOld(t({ name: "mine", cmd: "x", source: "canopy" }), "canopy")).toEqual({ def: null, target: "canopy" });
  });
  test("the dev task", () => {
    expect(devTask([t({ name: "a" }), t({ name: "b", dev: true })])?.name).toBe("b");
    expect(devTask([t({ dev: true, hidden: true })])).toBeUndefined();
  });
});
