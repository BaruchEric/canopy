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
import { Console, GroupPreflight, RunPane, freeBranchSlots } from "./RunSheet";
import { api } from "../api";
import { useStore } from "../store";
import type { Flow, PrWatch, Run } from "../../../src/core/types";

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


function renderConsole(run: Run): string {
  const initial = useStore.getInitialState();
  const previous = { ...initial };
  Object.assign(initial, useStore.getState());
  try { return renderToStaticMarkup(createElement(Console, { run, repo: undefined })); }
  finally { Object.assign(initial, previous); }
}

describe("kept run console", () => {
  test("shows its recorded timeline and kept marker with close, never dismiss", () => {
    const html = renderConsole({ ...active("kept", "kept"), kept: true, status: "done", note: "Recorded note", steps: [{ id: "s", kind: "text", text: "Recorded reply", at: 1 }] });
    expect(html).toContain(" · kept");
    expect(html).toContain("Recorded note");
    expect(html).toContain("Recorded reply");
    expect(html).toContain(">close</button>");
    expect(html).not.toContain(">dismiss</button>");
    expect(html).not.toContain("<textarea");
  });

  test("an active-looking kept chat cannot show a composer, answer form or stop action", () => {
    const html = renderConsole({ ...active("kept", "kept"), kept: true, chat: true, status: "waiting", prompt: { id: "p", kind: "proposal", plan: "Waiting plan", auto: true } });
    expect(html).toContain(" · kept");
    expect(html).not.toContain("<textarea");
    expect(html).not.toContain("<form");
    expect(html).not.toContain(">stop</button>");
    expect(html).not.toContain(">hide</button>");
    expect(html).not.toContain(">dismiss</button>");
    expect(html).toContain(">close</button>");
  });

  test("a kept run pane has no message composer even with an active-looking status", () => {
    const html = renderToStaticMarkup(createElement(RunPane, { run: { ...active("kept", "kept"), chat: true, kept: true, status: "idle" }, repo: undefined }));
    expect(html).not.toContain("<textarea");
    expect(html).not.toContain(">send</button>");
  });

  test("kept coordinator cards stay visible without start, edit or remove actions", () => {
    const html = renderConsole({ ...active("coord", "coord"), action: "coordinate", kept: true, chat: true, tasks: [{ id: "card", repo: "repo", action: "ask", title: "Recorded card", note: "Do the work", state: "proposed" }] });
    expect(html).toContain("Recorded card");
    expect(html).not.toContain("start these");
    expect(html).not.toContain(">edit</button>");
    expect(html).not.toContain(">remove</button>");
  });

  test("a kept ready branch keeps its branch context without land or open-PR actions", () => {
    const ready: Run = { ...active("kept", "kept"), status: "done", branch: { ...branch, state: "ready" } };
    const live = renderConsole(ready);
    expect(live).toContain(">land</button>");
    expect(live).toContain("open PR");
    const html = renderConsole({ ...ready, kept: true });
    expect(html).toContain("run/a");
    expect(html).not.toContain(">land</button>");
    expect(html).not.toContain("open PR");
  });
});


test("a kept PR retains its link and status without PR mutations, while the live PR keeps its controls", () => {
  const before = useStore.getState();
  const watch: PrWatch = { id: "a", runId: "kept", repoId: "repo", repoPath: "/r", branch: "run/a", target: "main", dir: "/a", note: "n", slug: "o/r", remote: "origin", number: 12, url: "https://github.com/o/r/pull/12", autoFix: false, autoMerge: false, pushed: "h", attempts: {}, seenComment: 0, openedAt: 1, updatedAt: 1 };
  useStore.setState({ prs: { "": [watch] } });
  try {
    const run = { ...active("kept", "a"), status: "done" } satisfies Run;
    const live = renderConsole(run);
    expect(live).toContain("close PR");
    expect(live).toContain('type="checkbox"');
    const kept = renderConsole({ ...run, kept: true });
    expect(kept).toContain('href="https://github.com/o/r/pull/12"');
    expect(kept).not.toContain("close PR");
    expect(kept).not.toContain('type="checkbox"');
  } finally { useStore.setState(before, true); }
});

test("live chats retain prompt, composer and stop controls; finished live runs retain dismiss", () => {
  const run: Run = { ...active("live", "a"), chat: true, status: "waiting", prompt: { id: "p", kind: "proposal", plan: "Live plan", auto: true } };
  const html = renderConsole(run);
  expect(html).toContain("Live plan");
  expect(html).toContain('aria-label="Your message"');
  expect(html).toContain(">stop</button>");
  expect(renderConsole({ ...run, chat: false, status: "done", prompt: null })).toContain(">dismiss</button>");
});
