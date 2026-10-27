import { describe, expect, test } from "bun:test";
import { runConsoleAction } from "./RunSheet";

describe("run console actions", () => {
  test("a send action displays the error and rejects so the composer restores its draft", async () => {
    let shown = "";
    await expect(runConsoleAction(async () => {
      throw new Error("offline");
    }, (message) => {
      shown = message;
    }, true)).rejects.toThrow("offline");
    expect(shown).toBe("offline");
  });

  test("a void action displays the error without an unhandled rejection", async () => {
    let shown = "";
    await runConsoleAction(async () => {
      throw new Error("cannot stop");
    }, (message) => {
      shown = message;
    });
    expect(shown).toBe("cannot stop");
  });
});

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { GroupPreflight, freeBranchSlots } from "./RunSheet";
import { api } from "../api";
import { useStore } from "../store";
import type { Flow, Run } from "../../../src/core/types";

const branch = { name: "run/a", origin: "a", target: "main", base: "b", dir: "/a", state: "working" as const };
const active = (id: string, origin: string): Run => ({ id, repoId: "repo", action: "ask", verb: "ask", progress: "working", expectsChange: true, chat: false, harness: "claude", note: "n", status: "working", startedAt: 1, steps: [], prompt: null, branch: { ...branch, origin } });
const held: Flow = { id: "f", repoId: "repo", workflow: "build", verb: "build", note: "n", status: "gated", steps: [], current: 0, startedAt: 1, branch };

describe("group preflight", () => {
  test("slots count unique active branch origins and held workflows, never reader runs", () => {
    expect(freeBranchSlots("repo", [active("reader1", "a"), active("reader2", "a")], [held])).toBe(2);
    expect(freeBranchSlots("repo", [active("reader1", "b")], [held])).toBe(1);
    expect(freeBranchSlots("other", [active("reader1", "b")], [held])).toBe(3);
  });
  test("branch-only counts, free slots and default-off auto-land", () => {
    const props = { onBranch: true, times: 1, free: 2, profile: "", profiles: ["default", "fast"], autoLand: false, onTimes: () => {}, onProfile: () => {}, onAutoLand: () => {} };
    expect(renderToStaticMarkup(createElement(GroupPreflight, { ...props, onBranch: false }))).toBe("");
    const single = renderToStaticMarkup(createElement(GroupPreflight, props));
    expect(single).toContain("2 of 3 slots free");
    expect(single).toContain('disabled=""');
    expect(single).not.toContain("Shared profile");
    const group = renderToStaticMarkup(createElement(GroupPreflight, { ...props, times: 2 }));
    expect(group).toContain("Shared profile");
    expect(group).toContain("auto-land");
    expect(group).not.toContain('checked=""');
  });
  test("store sends one shared profile and opens the returned group; one uses existing start", async () => {
    const original = api.startGroup;
    const single = useStore.getState().startRun;
    const before = useStore.getState();
    const calls: unknown[][] = [];
    api.startGroup = async (...args) => { calls.push(args); return { id: "g", repoId: "repo", repoPath: "/r", action: "ask", note: "n", expectedMembers: 2, members: [], state: "working", autoLand: false, startedAt: 1 }; };
    useStore.setState({ startRun: async (...args) => { calls.push(args); } });
    try {
      await useStore.getState().startGroup("repo", "ask", "n", 2, "fast");
      expect(calls[0]).toEqual(["repo", "ask", "n", 2, "fast", false, false]);
      expect(useStore.getState().sheet).toEqual({ kind: "group", groupId: "g" });
      await useStore.getState().startGroup("repo", "ask", "n", 1);
      expect(calls[1]).toEqual(["repo", "ask", "n", true, undefined]);
    } finally { api.startGroup = original; useStore.setState({ ...before, startRun: single }); }
  });
});
