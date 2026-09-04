import { describe, expect, test } from "bun:test";
import { ACTIONS, buildPrompt, canRun, describeTool, repoFacts, toolDetail } from "./actions";
import { RUN_ACTIONS, statusFingerprint, type Repo, type RepoStatus } from "./types";

function repo(over: Partial<Repo["status"] & { error: string }> = {}): Repo {
  const { error, ...status } = over;
  return {
    id: "apps/orchard",
    name: "orchard",
    path: "/tmp/grove/apps/orchard",
    group: "apps",
    source: "launch",
    status: {
      branch: "main",
      upstream: "origin/main",
      ahead: 0,
      behind: 0,
      files: [],
      lastCommit: null,
      user: null,
      ...status,
    },
    ...(error ? { error } : {}),
  };
}

const file = { path: "a.ts", index: ".", worktree: "M", untracked: false, conflicted: false };

describe("canRun", () => {
  test("commit needs changes, push needs something unpushed", () => {
    expect(canRun(repo(), "commit")).toEqual({ ok: false, why: "nothing to commit" });
    expect(canRun(repo({ files: [file] }), "commit")).toEqual({ ok: true });
    expect(canRun(repo(), "push")).toEqual({ ok: false, why: "nothing to push" });
    expect(canRun(repo({ ahead: 2 }), "push")).toEqual({ ok: true });
  });
  test("a branch with no upstream can always be pushed", () => {
    expect(canRun(repo({ upstream: null }), "push")).toEqual({ ok: true });
  });
  test("commit and push needs either", () => {
    expect(canRun(repo(), "commit-push").ok).toBe(false);
    expect(canRun(repo({ ahead: 1 }), "commit-push").ok).toBe(true);
    expect(canRun(repo({ files: [file] }), "commit-push").ok).toBe(true);
  });
  test("deploy and ask only need a readable repo", () => {
    expect(canRun(repo(), "deploy")).toEqual({ ok: true });
    expect(canRun(repo(), "ask")).toEqual({ ok: true });
    expect(canRun(repo({ error: "boom" }), "ask").ok).toBe(false);
  });
});

describe("buildPrompt", () => {
  test("carries the repo path, the facts, the task, and the rules", () => {
    const p = buildPrompt(repo({ files: [file], ahead: 1 }), "commit", "");
    expect(p).toContain("/tmp/grove/apps/orchard");
    expect(p).toContain("main, 1 changed file, 1 unpushed");
    expect(p).toContain("Task: commit the current changes");
    expect(p).toContain("Never rewrite published history");
    expect(p).not.toContain("Note from the user");
  });
  test("a note is quoted and trimmed", () => {
    const p = buildPrompt(repo(), "push", "  use the fork remote  ");
    expect(p).toContain("Note from the user (follow it where it applies):\nuse the fork remote");
  });
  test("ask puts the note in as the task", () => {
    const p = buildPrompt(repo(), "ask", "rename foo to bar");
    expect(p).toContain("Task: see the note below.");
    expect(p).toContain("Note from the user:\nrename foo to bar");
  });
  test("commit and push runs handle submodules and stray files instead of stopping", () => {
    for (const a of ["commit", "commit-push"] as const) {
      const p = buildPrompt(repo({ files: [file] }), a, "");
      expect(p).toContain("submodule");
      expect(p).toContain("AskUserQuestion");
      expect(p).toContain("do not end the run by explaining");
    }
    expect(buildPrompt(repo({ ahead: 1 }), "push", "")).toContain("push the submodule first");
  });
  test("every action has a spec and a prompt", () => {
    for (const a of RUN_ACTIONS) {
      expect(ACTIONS[a].label.length).toBeGreaterThan(0);
      expect(buildPrompt(repo(), a, "x")).toContain("Task:");
    }
  });
});

describe("statusFingerprint", () => {
  const base: RepoStatus = {
    branch: "main",
    upstream: "origin/main",
    ahead: 1,
    behind: 0,
    files: [file, { ...file, path: "b.ts", untracked: true }],
    lastCommit: { hash: "abc", subject: "x", at: 1 },
    user: null,
  };
  test("ignores file order but not file state, position, or head", () => {
    const swapped = { ...base, files: [...base.files].reverse() };
    expect(statusFingerprint(swapped)).toBe(statusFingerprint(base));
    expect(statusFingerprint({ ...base, ahead: 0 })).not.toBe(statusFingerprint(base));
    expect(statusFingerprint({ ...base, files: [file] })).not.toBe(statusFingerprint(base));
    expect(
      statusFingerprint({ ...base, lastCommit: { hash: "def", subject: "x", at: 1 } }),
    ).not.toBe(statusFingerprint(base));
    expect(statusFingerprint(null)).toBe("");
  });
});

describe("repoFacts", () => {
  test("names what is missing as well as what is there", () => {
    expect(repoFacts(repo({ upstream: null, behind: 3 }))).toEqual([
      "main",
      "0 changed files",
      "3 behind",
      "no upstream",
    ]);
  });
});

describe("describeTool", () => {
  test("shows the command, the file, or the tool", () => {
    expect(describeTool("Bash", { command: "git status" })).toBe("git status");
    expect(describeTool("Edit", { file_path: "src/a.ts" })).toBe("edit src/a.ts");
    expect(describeTool("Read", { file_path: "README.md" })).toBe("read README.md");
    expect(describeTool("AskUserQuestion", {})).toBe("ask you a question");
    expect(describeTool("WebFetch", { url: "https://x" })).toBe("WebFetch https://x");
    expect(describeTool("Mystery", { n: 1 })).toBe("Mystery");
  });
  test("paths inside the repo lose the repo prefix", () => {
    expect(describeTool("Read", { file_path: "/r/a/b.ts" }, "/r")).toBe("read a/b.ts");
    expect(describeTool("Read", { file_path: "/other/b.ts" }, "/r")).toBe("read /other/b.ts");
    expect(toolDetail("Edit", { file_path: "/r/a.ts" }, "/r")).toBe("a.ts");
  });
  test("an edit shows what changes", () => {
    const d = toolDetail("Edit", { file_path: "/r/a.ts", old_string: "x = 1", new_string: "x = 2" }, "/r");
    expect(d).toBe("a.ts\n- x = 1\n+ x = 2");
    expect(toolDetail("Write", { file_path: "/r/n.txt", content: "hi\nthere" }, "/r")).toBe("n.txt\nhi\nthere");
  });
  test("toolDetail keeps the whole command and falls back to JSON", () => {
    expect(toolDetail("Bash", { command: "a && b" })).toBe("a && b");
    expect(toolDetail("Grep", { pattern: "x" })).toContain('"pattern": "x"');
  });
});
