import { describe, expect, test } from "bun:test";
import type { AgentCard, Ask, RangerInfo, Repo, RepoStatus, Run, RunStep, TaskInfo } from "../../src/core/types";
import { WAITING_PANEL, attentionRepos, behindRepos, failedRows, isUnpushed, isWaitingPanel, lastWords, turnRows } from "./waiting";

function repo(id: string, status: Partial<RepoStatus> | null, error?: string): Repo {
  const st: RepoStatus | null = status && { branch: "main", upstream: "origin/main", ahead: 0, behind: 0, files: [], lastCommit: null, user: null, ...status };
  return { id, name: id, path: `/x/${id}`, group: "", source: "launch", status: error ? null : st, ...(error ? { error } : {}) };
}

const file = (conflicted = false) => ({ path: "a", index: ".", worktree: "M", untracked: false, conflicted });

describe("the waiting panel's id", () => {
  test("is no repo's: a repo id is relative and never starts with a slash", () => {
    expect(isWaitingPanel(WAITING_PANEL)).toBe(true);
    expect(isWaitingPanel("waiting")).toBe(false);
    expect(WAITING_PANEL.includes("|")).toBe(false);
    expect(WAITING_PANEL.includes(":")).toBe(false);
  });
});

describe("attentionRepos", () => {
  test("ranks conflict, error, changes, unpushed, then by name, and leaves the rest out", () => {
    const rows = attentionRepos([
      repo("zed", { ahead: 2 }),
      repo("clean", {}),
      repo("behind", { behind: 4 }),
      repo("beta", { files: [file(), file()] }),
      repo("alpha", { files: [file()], ahead: 1 }),
      repo("broken", null, "not a repo"),
      repo("merge", { files: [file(true), file()] }),
      { ...repo("forge", null), forge: { kind: "forgejo", slug: "me/forge", clone: "ssh://x", branch: "main", updated: 0, private: false, empty: false } },
    ]);
    expect(rows.map((r) => [r.repo.id, r.state, r.detail])).toEqual([
      ["merge", "conflict", "1 conflicted file"],
      ["broken", "error", "not a repo"],
      ["alpha", "dirty", "1 file · ↑1"],
      ["beta", "dirty", "2 files"],
      ["zed", "ahead", "↑2"],
    ]);
    // only the row with nothing but unpushed commits goes to the folded group
    expect(rows.filter(isUnpushed).map((r) => r.repo.id)).toEqual(["zed"]);
  });
});

describe("behindRepos", () => {
  test("lists clean checkouts behind their upstream, by name, and nothing with work of its own", () => {
    const rows = behindRepos([
      repo("zed", { behind: 1 }),
      repo("alpha", { behind: 3 }),
      repo("level", {}),
      repo("diverged", { ahead: 1, behind: 2 }),
      repo("dirty", { behind: 2, files: [file()] }),
      repo("broken", null, "not a repo"),
    ]);
    expect(rows.map((r) => [r.repo.id, r.behind])).toEqual([
      ["alpha", 3],
      ["zed", 1],
    ]);
  });
});

describe("failedRows", () => {
  const run = (id: string, status: Run["status"], at: number): Run => ({
    id,
    repoId: "r",
    action: "ask",
    verb: "asking",
    progress: "",
    expectsChange: false,
    chat: false,
    harness: "claude",
    note: "",
    status,
    startedAt: at,
    endedAt: at + 5,
    steps: [],
    prompt: null,
  });
  const task = (name: string, status: TaskInfo["status"], at: number): TaskInfo => ({
    name,
    cmd: "x",
    repoId: "r",
    source: "detected",
    termId: "0".repeat(32),
    status,
    live: false,
    exitedAt: at,
    restarts: 0,
    viewers: [],
  });

  test("failed runs not owned by a flow, and failed or given-up tasks, newest first", () => {
    const rows = failedRows(
      [run("ok", "done", 100), run("bad", "failed", 200), run("step", "failed", 900)],
      { step: "flow1" },
      [task("dev", "failed", 300), task("watch", "gave-up", 50), task("lint", "running", 999)],
    );
    expect(rows.map((r) => [r.kind, r.what, r.at])).toEqual([
      ["task", "dev", 300],
      ["run", "ask", 205],
      ["task", "watch", 50],
    ]);
  });

  test("a ranger that gave up, and none that runs or is off", () => {
    const ranger = (state: RangerInfo["state"], on = true): RangerInfo =>
      ({ on, state, handle: "ranger", why: "it exited 5 times in a row; restart it by hand", lastExit: { at: 400, code: 1 } }) as RangerInfo;
    const rows = failedRows([], {}, [task("dev", "failed", 300)], [["mini", ranger("gave-up")], ["mac", ranger("running")], ["old", ranger("gave-up", false)]]);
    expect(rows.map((r) => [r.kind, r.id, r.at])).toEqual([
      ["ranger", "mini", 400],
      ["task", "r\u0000dev", 300],
    ]);
    expect(rows[0]).toMatchObject({ name: "@ranger", what: "it exited 5 times in a row; restart it by hand" });
  });
});

describe("turnRows", () => {
  const run = (id: string, status: Run["status"], at: number, stepAt?: number): Run => ({
    id,
    repoId: "app",
    action: "chat",
    verb: "chatting",
    progress: "",
    expectsChange: false,
    chat: true,
    harness: "claude",
    note: "",
    status,
    startedAt: at,
    steps: stepAt === undefined ? [] : [{ id: "s1", at: stepAt, kind: "text", text: "over to you" }],
    prompt: null,
  });
  const card = (id: string, over: Partial<AgentCard> = {}): AgentCard => ({
    id,
    handle: id,
    node: "mac",
    harness: "claude",
    session: id,
    origin: "elsewhere",
    cwd: "/x/app/src",
    repo: null,
    branch: "main",
    model: null,
    mode: null,
    state: "waiting",
    waiting: "your turn",
    caps: [],
    offers: [],
    notifyIdle: false,
    where: { os: "darwin", container: false, pid: 1, term: "kitty", canopy: null },
    transcript: null,
    startedAt: 0,
    seenAt: 500,
    endedAt: null,
    ...over,
  });
  const ask = (agent: string, state: Ask["state"]): Ask =>
    ({ id: `a-${agent}`, agent, handle: agent, node: "mac", kind: "permission", tool: "Bash", title: "", detail: "", route: "remote", waitUntil: 0, state, createdAt: 0 }) as Ask;
  const app = repo("app", {});

  test("idle chats and agents on their prompt, the longest waiting first", () => {
    const rows = turnRows(
      [run("chat1", "idle", 100, 700), run("busy", "working", 50), run("step", "idle", 10), run("old", "idle", 300)],
      { step: "flow1" },
      [card("term"), card("busy", { state: "working", waiting: null }), card("run", { origin: "canopy-run" }), card("asking"), card("lost", { cwd: "/elsewhere" })],
      [ask("asking", "open"), ask("term", "answered")],
      [app],
    );
    expect(rows.map((r) => [r.kind, r.id, r.repoId, r.at])).toEqual([
      ["chat", "old", "app", 300],
      ["agent", "lost", null, 500],
      ["agent", "term", "app", 500],
      ["chat", "chat1", "app", 700],
    ]);
    // a chat says its agent's last words, or its action before it has any
    expect(rows.filter((r) => r.kind === "chat").map((r) => r.what)).toEqual(["chat", "over to you"]);
    const term = rows.find((r) => r.id === "term");
    expect(term?.kind === "agent" && [term.what, term.where]).toEqual(["your turn", "kitty on mac"]);
  });
});

describe("lastWords", () => {
  const step = (kind: RunStep["kind"], text: string, parent?: string): RunStep => ({ id: text, at: 0, kind, text, ...(parent ? { parent } : {}) });
  test("the last paragraph of the agent's last words, on one line, emphasis dropped", () => {
    const steps = [
      step("text", "Done.\n\n**One choice is yours.** Stop,\nor keep `building`?"),
      step("text", "a subagent's report", "agent1"),
      step("tool", "Bash"),
      step("user", "go on"),
    ];
    expect(lastWords({ steps })).toBe("One choice is yours. Stop, or keep building?");
    expect(lastWords({ steps: [step("user", "hi")] })).toBe("");
  });
});
