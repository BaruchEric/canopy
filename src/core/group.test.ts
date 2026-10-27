import { describe, expect, test } from "bun:test";
import { BRANCH_RUNS_PER_REPO } from "./runner";
import { parseCostLine } from "./costs";
import { GROUP_MAX, LOSER_KEEP, comparePrompt, groupWord, parseCompare, pickWinner, settleGroup, type GroupDry, type MemberScore, type RunGroup } from "./group";

const group: RunGroup = {
  id: "g-a1b2c3d4",
  repoId: "apps/orchard",
  repoPath: "/work/apps/orchard",
  action: "propose",
  note: "Add a retry to the import",
  expectedMembers: 2,
  members: [
    { run: "run-red", origin: "origin-red", profile: null },
    { run: "run-green", origin: "origin-green", profile: "codex-fast" },
  ],
  state: "scoring",
  autoLand: false,
  scores: {
    "origin-red": { branch: "run/red", base: "base-sha", state: "ready", gates: { ok: false, red: "test", tail: "assertion failed" } },
    "origin-green": { branch: "run/green", base: "base-sha", state: "ready", gates: { ok: true }, scenarios: { score: 1, passed: 2, total: 2 } },
  },
  startedAt: 1,
};

const memberScore = (state: MemberScore["state"]): MemberScore => ({ branch: `run/${state}`, base: "base-sha", state });

describe("group limits and lifecycle", () => {
  test("the group cap follows the repo's branch-run cap, with a day to keep losers", () => {
    expect(GROUP_MAX).toBe(BRANCH_RUNS_PER_REPO);
    expect(LOSER_KEEP).toBe(24 * 60 * 60 * 1000);
  });

  test("an incomplete fan-out or a working member stays working", () => {
    const partial: RunGroup = { ...group, state: "working", expectedMembers: 3, members: group.members.slice(0, 1) };
    expect(settleGroup(partial, { "origin-red": memberScore("ready") }).state).toBe("working");
    expect(settleGroup(group, { "origin-red": memberScore("ready"), "origin-green": memberScore("working") }).state).toBe("working");
  });

  test("a ready member lets every settled state mix move to scoring", () => {
    const mixes: [MemberScore["state"], MemberScore["state"]][] = [
      ["ready", "ready"],
      ["ready", "uncommitted"],
      ["ready", "nothing"],
      ["ready", "stopped"],
      ["ready", "failed"],
    ];
    for (const [first, second] of mixes) {
      const scores = { "origin-red": memberScore(first), "origin-green": memberScore(second) };
      expect(settleGroup(group, scores).state).toBe("scoring");
    }
  });

  test("no ready member needs the user to choose another course", () => {
    const scores = { "origin-red": memberScore("uncommitted"), "origin-green": memberScore("failed") };
    expect(settleGroup(group, scores)).toMatchObject({ state: "needs-you", reason: "nothing to pick from", scores });
  });
});

describe("winner eligibility", () => {
  test("a red first-ranked member cannot win", () => {
    expect(pickWinner(group, ["run/red", "run/green"], 1)).toBe("origin-green");
  });

  test("a passing scenario set still must meet the group minimum", () => {
    const low: RunGroup = {
      ...group,
      scores: {
        "origin-green": {
          branch: "run/green",
          base: "base-sha",
          state: "ready",
          gates: { ok: true },
          scenarios: { score: 0.8, passed: 2, total: 2 },
        },
      },
    };
    expect(pickWinner(low, ["run/green"], 0.9)).toBeNull();
  });

  test("a missing scenario set does not block an otherwise green member", () => {
    const noScenarios: RunGroup = {
      ...group,
      scores: { "origin-green": { branch: "run/green", base: "base-sha", state: "ready", gates: { ok: true } } },
    };
    expect(pickWinner(noScenarios, ["run/green"], 1)).toBe("origin-green");
  });
});

describe("compare response", () => {
  const members = ["run/red", "run/green"];
  const green = ["run/green"];

  test("uses the last compare block and returns the closing text", () => {
    const text = `First pass.\n<<<compare\n{"ranking":["run/green"],"why":{"run/green":"smaller change"}}\n>>>\nThe green branch is the better fit.`;
    expect(parseCompare(text, members, green)).toEqual({
      ok: true,
      ranking: ["run/green"],
      why: { "run/green": "smaller change" },
      closing: "The green branch is the better fit.",
    });
    const last = `${text}\n<<<compare\n{"ranking":["run/red","run/green"],"why":{"run/red":"gate failed","run/green":"keeps the importer simple"}}\n>>>`;
    expect(parseCompare(last, members, green)).toMatchObject({ ok: true, ranking: ["run/red", "run/green"] });
  });

  test("rejects a missing or malformed block, a non-member, an omitted green member, and a missing or multi-sentence why", () => {
    const cases = [
      "No compare block was returned.",
      "<<<compare\nnot json\n>>>",
      `<<<compare\n{"ranking":["run/other","run/green"],"why":{"run/other":"not a member","run/green":"okay"}}\n>>>`,
      `<<<compare\n{"ranking":["run/red"],"why":{"run/red":"fails a gate"}}\n>>>`,
      `<<<compare\n{"ranking":["run/green"],"why":{}}\n>>>`,
      `<<<compare\n{"ranking":["run/green"],"why":{"run/green":"First sentence. Second sentence."}}\n>>>`,
    ];
    for (const text of cases) expect(parseCompare(text, members, green).ok).toBe(false);
  });

  test("keeps a red gate tail fenced and names each exact base-to-branch diff", () => {
    const dry: Record<string, GroupDry> = {
      "origin-red": { branch: "run/red", base: "base-sha", head: "red-head", gates: { ok: false, red: "test", tail: "assertion failed" }, minimum: 1 },
      "origin-green": { branch: "run/green", base: "base-sha", head: "green-head", gates: { ok: true }, scenarios: { score: 0.9, passed: 1, total: 1 }, minimum: 0.8 },
    };
    const prompt = comparePrompt(group, dry);
    expect(prompt).toContain("git diff base-sha...run/red");
    expect(prompt).toContain("git diff base-sha...run/green");
    expect(prompt).toContain("<<<\nassertion failed\n>>>");
    expect(prompt).toContain("Scenario score 0.90 (minimum 0.80)");
  });
});

test("group words name each state", () => {
  const words: [RunGroup["state"], string][] = [
    ["working", "working"],
    ["scoring", "scoring"],
    ["reviewing", "comparing"],
    ["picked", "winner picked"],
    ["landed", "landed"],
    ["dropped", "dropped"],
    ["needs-you", "needs you"],
  ];
  for (const [state, word] of words) expect(groupWord({ ...group, state })).toBe(word);
  expect(groupWord({ ...group, state: "needs-you", reason: "no member passed the gates" })).toBe("needs you: no member passed the gates");
});

test("cost ledger rows preserve the optional group id and old rows remain valid", () => {
  const row = { at: 1, service: "claude", provider: "anthropic", model: null, repo: "/work/apps/orchard", repoName: "orchard", run: "r1", label: "ask", session: "s1", usd: 0.1, tokens: null, seconds: null };
  expect(parseCostLine(JSON.stringify({ ...row, group: "g-a1b2c3d4" }))?.group).toBe("g-a1b2c3d4");
  expect(parseCostLine(JSON.stringify(row))?.group).toBeUndefined();
});
