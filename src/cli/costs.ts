import type { HistoryOverview, ScanResult } from "../core/types";
import { joinRepos, type RepoCard } from "../core/cards";
import {
  costSheet,
  type CostLine,
  type CostSheet,
  type ServedRow,
  tokensWord,
  usageWords,
  usdWord,
} from "../core/costsheet";
import { qualify, split, type Reg } from "../core/backendid";
import { mergeHistory } from "../core/historymerge";
import {
  HARNESS_SHARE_MAX,
  harnessNames,
  harnessShare,
  harnessWeeks,
  pct,
  shareTone,
  type HarnessShare,
  type HarnessWeek,
} from "../core/harnessshare";
import type { CostReport } from "../core/costs";
import { apiBase } from "./api";
import { ask, backendTargets, errText, has, take, Unreachable, type Target } from "./health";
import { bold, dim, moss, rust } from "./render";

export const COSTS_USAGE = "usage: canopy costs [--days 1|7|30] [--share] [--on NAME] [--backend URL]";

/** 1, 7 or 30 from --days, 7 unset, null for anything else */
export function daysOf(arg: string | undefined): 1 | 7 | 30 | null {
  if (arg === undefined || arg === "7") return 7;
  if (arg === "1") return 1;
  if (arg === "30") return 30;
  return null;
}

function amountWord(line: CostLine): string {
  const parts: string[] = [];
  if (line.usd > 0) parts.push(usdWord(line.usd));
  if (line.est > 0) parts.push(`≈ ${usdWord(line.est)}`);
  if (parts.length > 0) return parts.join(" + ");
  return line.unpriced > 0 ? "unpriced" : "$0.00";
}

function groupLines(lines: readonly CostLine[]): string[] {
  if (lines.length === 0) return ["  nothing"];
  return lines.map((line) => {
    const amount = amountWord(line);
    const width = amount === "unpriced" ? 11 : 10;
    return `  ${line.label.padEnd(26)} ${amount.padStart(width)}  ${usageWords(line, tokensWord)}`.trimEnd();
  });
}

/** the window's total, then by service and by repo, the first `limit` repos */
export function costLines(sheet: CostSheet, days: number, limit = 15): string[] {
  const total = [usdWord(sheet.usd)];
  if (sheet.est > 0) total.push(`≈ ${usdWord(sheet.est)}`);
  if (sheet.unpriced > 0) total.push(`${sheet.unpriced} unpriced`);
  const lines = [`${days === 1 ? "today" : `${days} days`}: ${total.join(" + ")}`, "by service", ...groupLines(sheet.services), "by repo"];
  const repoLimit = Math.max(0, limit);
  lines.push(...groupLines(sheet.repos.slice(0, repoLimit)));
  if (sheet.repos.length > repoLimit) lines.push(`  … and ${sheet.repos.length - repoLimit} more`);
  return lines;
}

function paintShare(value: string, share: number | null, max: number): string {
  const tone = shareTone(share, max);
  if (tone === "rust") return rust(value);
  if (tone === "moss") return moss(value);
  return value;
}

function shareLineAt(share: HarnessShare, max: number): string {
  const dollars = share.usd.harness + share.usd.rest;
  const sessions = share.sessions.harness + share.sessions.rest;
  return `harness ${paintShare(pct(share.share), share.share, max)} of ${usdWord(dollars)} · ${paintShare(pct(share.sessionShare), share.sessionShare, max)} of ${sessions} sessions`;
}

/** "harness 23% of $41.20 · 31% of 48 sessions" */
export function shareLine(share: HarnessShare): string {
  return shareLineAt(share, HARNESS_SHARE_MAX);
}

/** the figure naming the harness repos, then the weeks table */
export function shareLines(share: HarnessShare, weeks: readonly HarnessWeek[], names: readonly string[], max: number): string[] {
  const label = names.length > 0 ? `(${names.join(", ")})` : "(no repo is marked as the harness)";
  if (weeks.length === 0) {
    return [`${shareLineAt(share, max)}  ${label}`, "  no week to show: claude-history has no spend in these repos"];
  }
  const lines = [
    `${shareLineAt(share, max)}  ${label}`,
    `${"week".padEnd(10)}  ${"harness".padStart(9)}  ${"rest".padStart(8)}  ${"share".padStart(5)}`,
  ];
  weeks.forEach((week, index) => {
    const isLast = index === weeks.length - 1;
    const amount = (value: number, width: number): string => usdWord(value).padStart(width);
    const shareCell = paintShare(pct(week.share).padStart(5), week.share, max);
    lines.push(`${week.from.padEnd(10)}  ${amount(week.harness, 9)}  ${amount(week.rest, 8)}  ${shareCell}${isLast ? "  so far" : ""}`);
  });
  return lines;
}

function qualifyOverview(overview: HistoryOverview, backend: string, reg: Reg): HistoryOverview {
  if (!overview.available) return overview;
  return {
    ...overview,
    repos: Object.fromEntries(Object.entries(overview.repos).map(([id, repo]) => [qualify(reg, backend, id), repo])),
  };
}

type Answer =
  | { target: Target; tree: ScanResult; history: HistoryOverview; costs: CostReport }
  | { target: Target; why: string };

export async function costsCommand(argv: string[], { fail }: { fail: (msg: string) => never }): Promise<void> {
  const args = [...argv];
  const backendFlag = args.includes("--backend");
  const onFlag = args.includes("--on");
  const given = take(args, "--backend");
  const on = take(args, "--on");
  const withShare = has(args, "--share");
  const daysArg = take(args, "--days");
  const days = daysOf(daysArg);
  if (
    days === null ||
    (daysArg === undefined && argv.includes("--days")) ||
    (backendFlag && given === undefined) ||
    (onFlag && on === undefined)
  ) return fail(COSTS_USAGE);
  if ((given !== undefined && given.startsWith("--")) || (on !== undefined && on.startsWith("--")) || args.length > 0) return fail(COSTS_USAGE);

  const home = apiBase(given);
  if (!/^https?:\/\/[^/\s]+$/.test(home)) return fail(`--backend must be an http(s) origin, got ${home}`);
  const targets = await backendTargets(home, { given, on }, fail);
  const reg: Reg = { home: targets[0]!.name, names: targets.map((target) => target.name) };
  const answers: Answer[] = await Promise.all(
    targets.map(async (target): Promise<Answer> => {
      try {
        const [tree, history, costs] = await Promise.all([
          ask<ScanResult>(target, "GET", "/api/tree"),
          ask<HistoryOverview>(target, "GET", "/api/history?window=90d"),
          ask<CostReport>(target, "GET", `/api/costs?days=${days}`),
        ]);
        return { target, tree, history, costs };
      } catch (err) {
        return { target, why: err instanceof Unreachable ? err.message : errText(err) };
      }
    }),
  );
  const ready = answers.filter((answer): answer is Extract<Answer, { tree: ScanResult }> => "tree" in answer);
  if (ready.length === 0) return fail("no backend answered");

  const repos = ready.flatMap(({ target, tree }) => tree.repos.map((repo) => ({ ...repo, id: qualify(reg, target.name, repo.id) })));
  const overviews = ready.map(({ target, history }) => qualifyOverview(history, target.name, reg));
  const rows: ServedRow[] = ready.flatMap(({ target, costs }) =>
    costs.rows.map((row) => ({
      ...row,
      backend: target.name,
      qid: row.repoId === null ? null : qualify(reg, target.name, row.repoId),
    })),
  );
  const cards: RepoCard[] = joinRepos(repos, reg.names, (id) => split(reg, id));
  const history = mergeHistory(overviews);
  const sheet = costSheet(rows, history, days, cards);
  for (const line of costLines(sheet, days)) console.log(line === "by service" || line === "by repo" ? bold(line) : line);
  if (withShare) {
    const share = harnessShare(sheet, history, days, cards);
    const weeks = harnessWeeks(history, cards);
    for (const line of shareLines(share, weeks, harnessNames(cards), HARNESS_SHARE_MAX)) console.log(line);
  }
  for (const answer of answers) if (!("tree" in answer)) console.log(dim(`not counted: ${answer.target.name}: ${answer.why}`));
}
