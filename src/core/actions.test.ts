import { describe, expect, test } from "bun:test";
import { ACTIONS, buildPrompt, checkWhen, describeTool, repoFacts, toolDetail } from "./actions";
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

const SCOPE = {
  workspace: "bike-trips",
  primary: "/tmp/grove/apps/orchard",
  others: ["/w/trips-analysis"],
  skipped: [],
};

const file = { path: "a.ts", index: ".", worktree: "M", untracked: false, conflicted: false };

test("a workspace prompt names the primary and the other folders, and widens the safety rule", () => {
  const p = buildPrompt(repo(), ACTIONS.ask, "add an endpoint", SCOPE);
  expect(p).toContain("workspace bike-trips");
  expect(p).toContain("Primary folder, where new code goes: /tmp/grove/apps/orchard");
  expect(p).toContain("/w/trips-analysis");
  expect(p).toContain("Work only inside these folders");
  expect(p).not.toContain("Work only inside this repository");
  expect(buildPrompt(repo(), ACTIONS.ask, "x")).toContain("Work only inside this repository");
});

describe("checkWhen", () => {
  test("dirty, unpushed, either, any", () => {
    expect(checkWhen(repo(), "dirty")).toEqual({ ok: false, why: "nothing to commit" });
    expect(checkWhen(repo({ files: [file] }), "dirty")).toEqual({ ok: true });
    expect(checkWhen(repo(), "unpushed")).toEqual({ ok: false, why: "nothing to push" });
    expect(checkWhen(repo({ ahead: 2 }), "unpushed")).toEqual({ ok: true });
    expect(checkWhen(repo({ upstream: null }), "unpushed")).toEqual({ ok: true });
    expect(checkWhen(repo(), "dirty-or-unpushed").ok).toBe(false);
    expect(checkWhen(repo({ ahead: 1 }), "dirty-or-unpushed").ok).toBe(true);
    expect(checkWhen(repo(), "any")).toEqual({ ok: true });
    expect(checkWhen({ ...repo(), error: "nope" }, "any").ok).toBe(false);
  });
});

describe("buildPrompt", () => {
  test("carries the repo path, the facts, the task, and the rules", () => {
    const job = { ...ACTIONS.ask, mode: "job" as const, task: "Task: commit the current changes." };
    const p = buildPrompt(repo({ files: [file], ahead: 1 }), job, "");
    expect(p).toContain("/tmp/grove/apps/orchard");
    expect(p).toContain("main, 1 changed file, 1 unpushed");
    expect(p).toContain("Task: commit the current changes");
    expect(p).toContain("Never rewrite published history");
    expect(p).not.toContain("Note from the user");
  });
  test("a note is quoted and trimmed", () => {
    const job = { ...ACTIONS.ask, mode: "job" as const, task: "Task: x" };
    const p = buildPrompt(repo(), job, "  use the fork remote  ");
    expect(p).toContain("Note from the user (follow it where it applies):\nuse the fork remote");
  });
  test("a chat frames the first message and keeps the safety rules only", () => {
    const p = buildPrompt(repo(), ACTIONS.chat, "what does this repo do?");
    expect(p).toContain("hold a conversation");
    expect(p).toContain("Never rewrite published history");
    expect(p).not.toContain("Finish with a short plain-prose summary");
    expect(p.endsWith("First message from the user:\nwhat does this repo do?")).toBe(true);
  });

  test("ask puts the note in as the task", () => {
    const p = buildPrompt(repo(), ACTIONS.ask, "rename foo to bar");
    expect(p).toContain("Task: see the note below.");
    expect(p).toContain("Note from the user:\nrename foo to bar");
  });
  test("an ask is done when the note is, not when the repo is clean and pushed", () => {
    const ask = buildPrompt(repo({ files: [file], ahead: 1 }), ACTIONS.ask, "explain the build script");
    expect(ask).toContain("Never rewrite published history");
    expect(ask).toContain("Ask with AskUserQuestion");
    expect(ask).not.toContain("The job is done when the list is empty");
    expect(ask.trim().endsWith("No headings, no bullet lists.")).toBe(true);
    // a job keeps it
    const job = buildPrompt(repo(), { ...ACTIONS.ask, mode: "job" as const, task: "Task: x" }, "");
    expect(job).toContain("The job is done when the list is empty and the branch is not ahead");
  });
  test("every action has a spec and a prompt", () => {
    for (const a of RUN_ACTIONS) {
      expect(ACTIONS[a].label.length).toBeGreaterThan(0);
      expect(buildPrompt(repo(), ACTIONS[a], "x")).toContain("Task:");
    }
  });
});

describe("the spec carries the run's words", () => {
  test("every action says what it does and how it ends", () => {
    for (const a of RUN_ACTIONS) {
      const spec = ACTIONS[a];
      expect(spec.task.length).toBeGreaterThan(0);
      expect(spec.progress.length).toBeGreaterThan(0);
    }
    expect(ACTIONS.ask.expectsChange).toBe(false);
    expect(ACTIONS.chat.mode).toBe("chat");
    expect(ACTIONS.ask.mode).toBe("ask");
  });

  test("a job prompt ends with the ground rules; a chat prompt ends with the message", () => {
    const r = repo();
    const jobSpec = { ...ACTIONS.ask, mode: "job" as const, task: "Task: x" };
    const job = buildPrompt(r, jobSpec, "be brief");
    expect(job).toContain("Note from the user (follow it where it applies):\nbe brief");
    expect(job.trim().endsWith("No headings, no bullet lists.")).toBe(true);
    const chat = buildPrompt(r, ACTIONS.chat, "hello");
    expect(chat.trim().endsWith("First message from the user:\nhello")).toBe(true);
    const ask = buildPrompt(r, ACTIONS.ask, "do x");
    expect(ask).toContain("Note from the user:\ndo x");
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
  test("Codex's vocabulary: searches, MCP calls, the plan, sub-agents, and the prompt-only access requests", () => {
    expect(describeTool("WebSearch", { query: "bun spawn" })).toBe("web search bun spawn");
    expect(describeTool("WebSearch", {})).toBe("web search");
    expect(describeTool("mcp__gh__get_issue", { repo: "o/r", n: 3 })).toBe("gh get_issue o/r");
    expect(describeTool("mcp__my_server__list", {})).toBe("my_server list");
    expect(describeTool("Plan", {})).toBe("update the plan");
    expect(describeTool("Agent", { description: "look at tests" })).toBe("agent: look at tests");
    expect(describeTool("Network", { host: "npmjs.org", protocol: "https" })).toBe("network access to npmjs.org");
    expect(toolDetail("Network", { host: "npmjs.org", protocol: "https" })).toBe("https npmjs.org");
    expect(describeTool("Permissions", { network: { enabled: true }, fileSystem: { write: ["/r/out"], read: ["/etc"] } }, "/r")).toBe(
      "more access: network, write out, read /etc",
    );
    expect(describeTool("Permissions", {})).toBe("more access: sandbox permissions");
    expect(toolDetail("Permissions", { network: { enabled: true } })).toContain('"enabled": true');
  });

  test("an edit whose detail is a unified diff, one file or several", () => {
    expect(toolDetail("Edit", { file_path: "/r/a.ts", diff: "@@\n-a\n+b\n" }, "/r")).toBe("a.ts\n@@\n-a\n+b");
    const changes = [
      { path: "/r/a.ts", kind: "update", diff: "-a\n+b" },
      { path: "/r/n.ts", kind: "add", diff: "+x" },
    ];
    expect(describeTool("Edit", { changes }, "/r")).toBe("edit a.ts, n.ts");
    expect(toolDetail("Edit", { changes }, "/r")).toBe("a.ts\n-a\n+b\n\nn.ts\n+x");
    expect(describeTool("Edit", { changes: [changes[1]] }, "/r")).toBe("write n.ts");
    expect(describeTool("Edit", { changes: [{ path: "/r/a", kind: "delete" }] }, "/r")).toBe("delete a");
    expect(describeTool("Edit", { changes: [{ path: "/r/a", kind: "update", movePath: "/r/b" }] }, "/r")).toBe("move a to b");
    expect(describeTool("Edit", { changes: [] })).toBe("edit files");
    // Claude's edit is unchanged
    expect(describeTool("Edit", { file_path: "/r/a.ts" }, "/r")).toBe("edit a.ts");
  });

  test("toolDetail keeps the whole command and falls back to JSON", () => {
    expect(toolDetail("Bash", { command: "a && b" })).toBe("a && b");
    expect(toolDetail("Grep", { pattern: "x" })).toContain('"pattern": "x"');
  });
});
