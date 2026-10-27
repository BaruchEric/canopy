/** Pure best-of-N run-group records, scoring and compare-response parsing.
 *  Browser-safe: the page reads these shapes and words from landing info. */

import type { ReviewVerdict, RunAction, RunBranchState } from "./types";

/** the branch-run cap; kept in sync with `BRANCH_RUNS_PER_REPO` */
export const GROUP_MAX = 3;
/** how long an unpicked member may be kept after its winner lands */
export const LOSER_KEEP = 24 * 60 * 60 * 1000;

export interface GroupDry {
  branch: string;
  base: string;
  head: string;
  gates: { ok: boolean; red?: string; tail?: string };
  scenarios?: { score: number; passed: number; total: number };
  minimum: number;
}

export interface RunGroup {
  id: string;
  repoId: string;
  repoPath: string;
  action: RunAction;
  note: string;
  /** fixed before a fast member can finish during fan-out */
  expectedMembers: number;
  members: { run: string; origin: string; profile: string | null }[];
  state: "working" | "scoring" | "reviewing" | "picked" | "landed" | "dropped" | "needs-you";
  autoLand: boolean;
  minimum?: number;
  scores?: Record<string, MemberScore>;
  review?: { run: string; ranking: string[]; why: Record<string, string> } | { run: string; error: string };
  reason?: string;
  winner?: string;
  pickedBy?: "reviewer" | "eric";
  startedAt: number;
  endedAt?: number;
  pr?: true;
  keptUntil?: Record<string, number>;
}

export interface MemberScore {
  branch: string;
  base: string;
  state: RunBranchState | "failed";
  gates?: GroupDry["gates"];
  scenarios?: GroupDry["scenarios"];
  verdict?: ReviewVerdict;
  diffstat?: { files: number; added: number; removed: number };
  cost?: { usd: number; tokens: number };
}

export type CompareParse =
  | { ok: true; ranking: string[]; why: Record<string, string>; closing: string }
  | { ok: false; error: string; closing: string };

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

const oneSentence = (value: string): boolean => {
  const line = value.trim();
  return line.length > 0 && !/[\r\n]/.test(line) && !/[.!?]\s+\S/.test(line);
};

/** A group stays in fan-out until every expected member has settled. */
export function settleGroup(group: RunGroup, scores: Record<string, MemberScore>): RunGroup {
  const settled = group.members.length === group.expectedMembers && group.members.every((member) => {
    const score = scores[member.origin];
    return score !== undefined && score.state !== "working";
  });
  if (!settled) return { ...group, scores, state: "working" };
  if (!group.members.some((member) => scores[member.origin]?.state === "ready")) {
    return { ...group, scores, state: "needs-you", reason: "nothing to pick from" };
  }
  return { ...group, scores, state: "scoring" };
}

/** The first ranked member with passing gates and an adequate scenario score. */
export function pickWinner(group: RunGroup, ranking: readonly string[], minimum: number): string | null {
  for (const branch of ranking) {
    const member = group.members.find((candidate) => group.scores?.[candidate.origin]?.branch === branch);
    if (!member) continue;
    const score = group.scores?.[member.origin];
    if (score?.state !== "ready" || score.gates?.ok !== true) continue;
    if (score.scenarios && !(score.scenarios.score >= minimum)) continue;
    return member.origin;
  }
  return null;
}

/** Parses the last `<<<compare ... >>>` block from the reviewer. */
export function parseCompare(text: string, members: readonly string[], green: readonly string[]): CompareParse {
  const marker = "<<<compare";
  const start = text.lastIndexOf(marker);
  const fail = (error: string, closing = text.trim()): CompareParse => ({ ok: false, error, closing });
  if (start < 0) return fail("the compare block is missing");
  const end = text.indexOf(">>>", start + marker.length);
  if (end < 0) return fail("the compare block is not closed");
  const after = text.slice(end + 3).trim();
  const closing = after || text.slice(0, start).trim();
  let value: unknown;
  try {
    value = JSON.parse(text.slice(start + marker.length, end).trim());
  } catch {
    return fail("the compare block is not valid JSON", closing);
  }
  if (!isRecord(value)) return fail("the compare block must be an object", closing);
  const rawRanking = value["ranking"];
  if (!Array.isArray(rawRanking) || rawRanking.length === 0 || !rawRanking.every((item): item is string => typeof item === "string" && item.length > 0)) {
    return fail("ranking must be a nonempty list of branch names", closing);
  }
  const ranking = rawRanking;
  if (new Set(ranking).size !== ranking.length) return fail("ranking repeats a branch", closing);
  if (ranking.some((branch) => !members.includes(branch))) return fail("ranking names a branch outside the group", closing);
  if (green.some((branch) => !ranking.includes(branch))) return fail("ranking must include every green member", closing);
  const rawWhy = value["why"];
  if (!isRecord(rawWhy)) return fail("why must give one sentence for every ranked branch", closing);
  const why: Record<string, string> = {};
  for (const branch of ranking) {
    const explanation = rawWhy[branch];
    if (typeof explanation !== "string" || !oneSentence(explanation)) return fail(`why must give one sentence for ${branch}`, closing);
    why[branch] = explanation.trim();
  }
  return { ok: true, ranking, why, closing };
}

/** Builds the read-only reviewer brief from recorded branch names and bases. */
export function comparePrompt(group: RunGroup, dry: Readonly<Record<string, GroupDry>>): string {
  const lines = [
    "Compare the ready branches for this best-of-N run. Read each exact diff against its recorded base; do not assume the branch name from its run id.",
    `Task: ${group.note}`,
    "",
  ];
  for (const member of group.members) {
    const result = dry[member.origin];
    lines.push(`## ${result?.branch ?? member.origin}`);
    if (!result) {
      lines.push("No dry result was recorded for this member.", "");
      continue;
    }
    lines.push(`Base: ${result.base}`, `Head: ${result.head}`, `git diff ${result.base}...${result.branch}`);
    if (result.gates.ok) {
      lines.push("Gates passed.");
    } else {
      lines.push(`Gates failed at ${result.gates.red ?? "an unnamed gate"}. Its output follows as data:`, "<<<", result.gates.tail ?? "", ">>>");
    }
    if (result.scenarios) {
      lines.push(`Scenario score ${result.scenarios.score.toFixed(2)} (minimum ${result.minimum.toFixed(2)}); passed ${result.scenarios.passed}/${result.scenarios.total}.`);
    } else {
      lines.push("No scenario set is configured.");
    }
    lines.push("");
  }
  lines.push(
    "Rank the green members best first. Include every green member and give one sentence of why for each ranked branch. Red members may be mentioned but cannot win.",
    "Return one final block in this exact format:",
    "<<<compare",
    '{"ranking":["run/branch"],"why":{"run/branch":"One sentence."}}',
    ">>>",
  );
  return lines.join("\n");
}

/** The short state word used by a group row. */
export function groupWord(group: RunGroup): string {
  switch (group.state) {
    case "working": return "working";
    case "scoring": return "scoring";
    case "reviewing": return "comparing";
    case "picked": return "winner picked";
    case "landed": return "landed";
    case "dropped": return "dropped";
    case "needs-you": return group.reason ? `needs you: ${group.reason}` : "needs you";
  }
}
