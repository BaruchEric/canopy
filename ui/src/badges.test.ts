import { describe, expect, test } from "bun:test";
import type { AgentCard, RepoStatus } from "../../src/core/types";
import { agentsBadge, gitBadge, groupSum, healthBadge, incubatorBadge, sumParts, sumTitle } from "./badges";

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
});

describe("group sums", () => {
  const status = (over: Partial<RepoStatus>): RepoStatus => ({ branch: "main", upstream: null, ahead: 0, behind: 0, files: [], lastCommit: null, user: null, ...over });
  const file = { path: "a", index: ".", worktree: "M", untracked: false, conflicted: false };
  const repos = [
    { status: status({ files: [file], lines: { added: 10, deleted: 2 }, ahead: 1 }) },
    { status: status({ files: [file], ahead: 2, elsewhere: { worktrees: [{ path: "/w", branch: "x", files: 1, unmerged: 0 }], branches: [] } }) },
    { status: null },
  ];

  test("sums the repos and counts each live agent once", () => {
    const shared = agent("a", "waiting");
    const s = groupSum(repos, [[shared, agent("b", "working")], [shared, agent("c", "ended")], []]);
    expect(s).toEqual({ dirty: 2, added: 10, deleted: 2, ahead: 3, worktrees: 1, agents: 2, waiting: 1 });
    expect(sumParts(s).map((p) => [p.text, p.cls])).toEqual([
      ["2●", "t-lichen"],
      ["+10", "n-add"],
      ["−2", "n-del"],
      ["↑3", "t-sky"],
      ["⧉ 1", "t-lichen"],
      ["✦ 2", "t-rust"],
    ]);
    expect(sumParts(s, true).map((p) => p.text)).toEqual(["2●", "✦ 2"]);
    expect(sumTitle(s).split("\n")).toHaveLength(6);
  });

  test("a quiet group says nothing", () => {
    expect(sumParts(groupSum([{ status: status({}) }], [[]]))).toEqual([]);
  });
});
