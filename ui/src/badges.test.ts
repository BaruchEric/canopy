import { describe, expect, test } from "bun:test";
import type { AgentCard, RepoStatus } from "../../src/core/types";
import { agentsBadge, gitBadge, groupSum, healthBadge, incubatorBadge, managerBadge, partText, sumParts, sumTitle } from "./badges";

const agent = (id: string, state: AgentCard["state"]) => ({ id, state });

describe("view tab badges", () => {
  test("git is the attention pill's count, nothing when quiet", () => {
    expect(gitBadge(0)).toBeNull();
    expect(gitBadge(3)).toMatchObject({ text: "3", tone: "lichen" });
  });

  test("agents counts the live ones, rust while one waits", () => {
    expect(agentsBadge([agent("a", "ended"), agent("b", "lost")])).toBeNull();
    expect(agentsBadge([agent("a", "working"), agent("b", "idle"), agent("c", "ended")])).toEqual({
      text: "✦ 2",
      tone: "sky",
      title: "2 agents running on the broker: 1 working, 1 idle",
    });
    expect(agentsBadge([agent("a", "working"), agent("b", "waiting")])?.tone).toBe("rust");
    // a session at its prompt asks nothing; a stall is lichen
    const turn = { id: "t", state: "waiting" as const, waiting: "your turn" };
    expect(agentsBadge([turn])).toMatchObject({ tone: "sky", title: "1 agent running on the broker: 1 idle" });
    const status = (c: { id: string }) => (c.id === "s" ? ("stalled" as const) : c.id === "b" ? ("background" as const) : ("idle" as const));
    expect(agentsBadge([agent("s", "working"), agent("b", "idle"), turn], status)).toEqual({
      text: "✦ 3",
      tone: "lichen",
      title: "3 agents running on the broker: 1 stalled, 1 in background, 1 idle",
    });
  });

  test("health counts down, healing and given-up checks on every backend", () => {
    const check = (label: string, state: "ok" | "down" | "healing" | "gave-up" | "off" | "unknown") => ({ label, state });
    expect(healthBadge({ mac: [check("tailchan", "ok"), check("watch", "off"), check("x", "unknown")] })).toBeNull();
    expect(healthBadge({ mac: [check("tailchan", "healing")] })).toMatchObject({ text: "1", tone: "lichen" });
    expect(healthBadge({ mac: [check("tailchan", "healing")], mini: [check("broker", "down")] })).toEqual({
      text: "2",
      tone: "rust",
      title: "mac: tailchan (healing)\nmini: broker (down)",
    });
  });

  test("incubator counts sprouts on the way, rust while one waits for a yes", () => {
    expect(incubatorBadge([{ status: "live" }, { status: "parked" }])).toBeNull();
    expect(incubatorBadge([{ status: "building" }, { status: "live" }])).toMatchObject({ text: "1", tone: "sky" });
    expect(incubatorBadge([{ status: "building" }, { status: "approving" }])).toMatchObject({ text: "2", tone: "rust" });
  });

  test("manager counts what waits on you across the live goals, rust as the work tab's; else the goals going, sky", () => {
    expect(managerBadge([])).toBeNull();
    expect(managerBadge([{ waiting: 0 }, { waiting: 0 }])).toEqual({ text: "2", tone: "sky", title: "2 goals going; nothing waits on you" });
    expect(managerBadge([{ waiting: 2 }, { waiting: 1 }])).toEqual({ text: "3", tone: "rust", title: "3 things wait on you across 2 goals" });
    expect(managerBadge([{ waiting: 1 }])).toEqual({ text: "1", tone: "rust", title: "1 thing waits on you across 1 goal" });
  });
});

describe("group sums", () => {
  const status = (over: Partial<RepoStatus>): RepoStatus => ({ branch: "main", upstream: null, ahead: 0, behind: 0, files: [], lastCommit: null, user: null, ...over });
  const file = { path: "a", index: ".", worktree: "M", untracked: false, conflicted: false };
  const repos = [
    { status: status({ files: [file], lines: { added: 10, deleted: 2 }, ahead: 1 }) },
    { status: status({ files: [file], ahead: 2, elsewhere: { worktrees: [{ path: "/w", branch: "x", files: 1, unmerged: 0 }], branches: [] } }) },
    { status: null },
  ];

  test("sums the repos and counts each live agent once, by state", () => {
    const shared = agent("a", "waiting");
    const s = groupSum(repos, [[shared, agent("b", "working"), agent("d", "idle")], [shared, agent("c", "ended"), agent("e", "lost")], []]);
    expect(s).toEqual({ dirty: 2, added: 10, deleted: 2, ahead: 3, worktrees: 1, working: 1, waiting: 1, idle: 1 });
    expect(sumParts(s).map((p) => [p.kind, partText(p), p.cls])).toEqual([
      ["dirty", "2●", "t-lichen"],
      ["added", "+10", "n-add"],
      ["deleted", "−2", "n-del"],
      ["ahead", "↑3", "t-sky"],
      ["worktrees", "⧉ 1", "t-lichen"],
      ["working", "✦ 1", "t-sky sum-live"],
      ["waiting", "⚑ 1", "t-rust"],
    ]);
    expect(sumTitle(s).split("\n")).toEqual([
      "2●: 2 repos with uncommitted changes",
      "+10: lines the tracked changes add and remove against HEAD",
      "−2: lines the tracked changes add and remove against HEAD",
      "↑3: 3 commits not pushed",
      "⧉ 1: 1 worktree holding work",
      "✦ 1: 1 agent working right now, 1 more open and idle",
      "⚑ 1: 1 agent waiting on you: a permission or a question",
    ]);
  });

  test("the narrow tree keeps the dirty count, the lines and the agents, shortened", () => {
    const s = { dirty: 3, added: 12_345, deleted: 1_200, ahead: 4, worktrees: 2, working: 2, waiting: 0, idle: 0 };
    expect(sumParts(s, true).map(partText)).toEqual(["3●", "+12k", "−1.2k", "✦ 2"]);
    // the tooltip says it whole
    expect(sumTitle(s)).toContain("+12345: ");
    expect(sumTitle(s)).toContain("↑4: 4 commits not pushed");
  });

  test("idle agents alone show nothing; waiting ones show without a working count", () => {
    expect(sumParts(groupSum([{ status: status({}) }], [[agent("a", "idle")]]))).toEqual([]);
    expect(sumParts(groupSum([{ status: status({}) }], [[agent("a", "waiting")]])).map(partText)).toEqual(["⚑ 1"]);
  });

  test("a quiet group says nothing", () => {
    expect(sumParts(groupSum([{ status: status({}) }], [[]]))).toEqual([]);
  });
});
