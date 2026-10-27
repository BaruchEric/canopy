/** Browser-side group words, columns and safe action availability. */
import type { RunGroup, MemberScore } from "../../src/core/group";
import { pickWinner } from "../../src/core/group";
import type { CostEntry } from "../../src/core/costs";
import type { LandingInfo, LandingRun, Run } from "../../src/core/types";
import { isRunActive } from "../../src/core/types";
import { inQueue, sentBack } from "../../src/core/landing";

export interface GroupColumn {
  member: RunGroup["members"][number];
  run?: Run;
  record?: LandingRun;
  score?: MemberScore;
  cost: { usd: number; tokens: number };
}
export function groupWord(group: RunGroup): string {
  switch (group.state) {
    case "needs-you": return "ready: pick";
    case "picked": return group.pr ? "picked, opening PR" : "picked, waiting to land";
    default: return group.state;
  }
}
export function memberColumns(group: RunGroup, info: LandingInfo, runs: Readonly<Record<string, Run>> = {}): GroupColumn[] {
  return group.members.map(member => {
    const record = info.runs.find(r => r.id === member.origin);
    const run = runs[record?.runId ?? member.run];
    const score = group.scores?.[member.origin];
    return { member, run, record, score, cost: score?.cost ?? { usd: run?.result?.costUsd ?? 0, tokens: run?.result?.tokens?.total ?? 0 } };
  });
}
export function costOfGroup(rows: readonly CostEntry[], groupId: string, runId: string): { usd: number; tokens: number } {
  return rows.filter(r => r.group === groupId && r.run === runId).reduce((sum, r) => ({ usd: sum.usd + (r.usd ?? 0), tokens: sum.tokens + (r.tokens?.total ?? 0) }), { usd: 0, tokens: 0 });
}
export function groupWaiting(group: RunGroup, info: LandingInfo): boolean {
  if (group.state !== "picked" || !group.winner || group.pr) return false;
  const rec = info.runs.find(r => r.id === group.winner);
  return rec?.pr === undefined && !info.entries.some(e => e.id === group.winner && (inQueue(e) || e.state === "landed"));
}
export function canPickMember(group: RunGroup, origin: string, info: LandingInfo): boolean {
  if (!["needs-you", "reviewing", "picked"].includes(group.state)) return false;
  if (info.entries.some(e => group.members.some(m => m.origin === e.id) && (inQueue(e) || e.state === "landed"))) return false;
  if (info.runs.some(r => group.members.some(m => m.origin === r.id) && r.pr !== undefined)) return false;
  if (!info.runs.some(r => r.id === origin && r.state === "ready")) return false;
  const score = group.scores?.[origin];
  return score !== undefined && pickWinner(group, [score.branch], group.minimum ?? 1) === origin;
}
export function memberActions(group: RunGroup, column: GroupColumn, info: LandingInfo) {
  const { member, record, run } = column;
  const entry = info.entries.find(e => e.id === member.origin);
  const busy = run !== undefined && isRunActive(run);
  const held = entry !== undefined && (inQueue(entry) || entry.state === "landed");
  const score = group.scores?.[member.origin];
  const ready = record?.state === "ready" && score !== undefined && pickWinner(group, [score.branch], group.minimum ?? 1) === member.origin;
  return {
    land: group.state === "picked" && group.winner === member.origin && !group.pr && record?.pr === undefined && ready && !busy && !held,
    approve: record?.review?.verdict === "approve",
    fix: !busy && entry !== undefined && sentBack(entry) && entry.fixing === undefined,
    drop: !busy && record !== undefined && record.pr === undefined && !held,
  };
}
