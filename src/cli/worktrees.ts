/** `canopy worktrees`: show this backend's run and warm trees, set a repo's
 *  warm count, and prune its orphans and stale slots. */

import type { WorktreesInfo, WorktreeRepoInfo } from "../core/types";
import { apiBase } from "./api";
import { ask, errText, has, take, Unreachable, type Target } from "./health";

export const WORKTREES_USAGE =
  "usage: canopy worktrees [repo] [--json] [--backend URL]\n       canopy worktrees warm <repo> [N] [--backend URL]\n       canopy worktrees prune [repo] [--backend URL]";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const MB = 1024 ** 2;
const GB = 1024 ** 3;

/** "2h", "3d", "5m", "now" */
export function ageWord(ms: number): string {
  const age = Math.max(0, ms);
  if (age < MINUTE) return "now";
  if (age < HOUR) return `${Math.floor(age / MINUTE)}m`;
  if (age < DAY) return `${Math.floor(age / HOUR)}h`;
  return `${Math.floor(age / DAY)}d`;
}

/** "312 MB", "1.2 GB" */
export function sizeWord(bytes: number): string {
  const unit = bytes >= GB ? GB : MB;
  const label = bytes >= GB ? "GB" : "MB";
  return `${new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 }).format(bytes / unit)} ${label}`;
}

function named(repo: string, entry: Pick<WorktreeRepoInfo, "repoId" | "repoPath">): boolean {
  const localId = entry.repoId.split("|").at(-1) ?? entry.repoId;
  const idName = localId.split(/[/:]/).at(-1);
  return repo === entry.repoId || repo === entry.repoPath.split("/").pop() || repo === idName;
}

function hasKeptWorktrees(repo: WorktreeRepoInfo): boolean {
  return repo.want > 0 || repo.runs.length > 0 || repo.warm.length > 0 || repo.refilling !== null ||
    repo.fails.length > 0 || repo.orphans.length > 0;
}

/** One repo at a time: its runs, warm slots, failures and orphans, then free disk. */
export function worktreeLines(info: WorktreesInfo, repo: string | null, now: number): string[] {
  const out: string[] = [];
  for (const entry of info.repos) {
    if (repo !== null && !named(repo, entry)) continue;
    if (repo === null && !hasKeptWorktrees(entry)) continue;

    if (entry.want === 0 && entry.runs.length === 0 && entry.warm.length === 0 && entry.refilling === null && entry.fails.length === 0 && entry.orphans.length === 0) {
      out.push(`${entry.repoId}  nothing kept`);
    } else {
      const gates = entry.fileWarm !== undefined && entry.fileWarm !== entry.want ? ` (the gates file says ${entry.fileWarm})` : "";
      out.push(`${entry.repoId}  ${entry.want} warm wanted${gates}`);
    }

    for (const run of entry.runs) out.push(`  run     ${run.branch}  ${run.state}  ${run.dir}`);
    for (const warm of entry.warm) out.push(`  warm    ${warm.name}  ${warm.base.slice(0, 7)}  ${ageWord(now - warm.madeAt)}  ${sizeWord(warm.size)}`);
    if (entry.refilling) out.push(`  warm    ${entry.refilling}  refilling`);
    for (const failure of entry.fails) out.push(`  warm    ${failure.name}  failed ${failure.fails}x: ${failure.why}`);
    for (const orphan of entry.orphans) out.push(`  orphan  ${orphan}`);
  }
  out.push(`free ${sizeWord(info.free)} under ${info.root}`);
  return out;
}

type Fail = (message: string) => never;

function repoId(info: WorktreesInfo, name: string, fail: Fail): string {
  const found = info.repos.filter((entry) => named(name, entry));
  if (found.length === 1) return found[0]!.repoId;
  if (found.length > 1) return fail(`${name} matches more than one repo: ${found.map((entry) => entry.repoId).join(", ")}; use an id`);
  return fail(`no repo named ${name}`);
}

/** Inspect or change the warm pool kept by the home backend. */
export async function worktreesCommand(argv: string[], { fail }: { fail: Fail }): Promise<void> {
  const args = [...argv];
  const backendFlag = args.includes("--backend");
  const given = take(args, "--backend");
  if (backendFlag && (given === undefined || given.startsWith("--"))) return fail("--backend needs a value");
  const home = apiBase(given);
  if (!/^https?:\/\/[^/\s]+$/.test(home)) return fail(`--backend must be an http(s) origin, got ${home}`);
  const target: Target = { name: "home", urls: [home] };
  const requestFailed = (error: unknown): never =>
    fail(error instanceof Unreachable ? `home did not answer: ${error.message}` : errText(error));
  const getInfo = async (): Promise<WorktreesInfo> => ask<WorktreesInfo>(target, "GET", "/api/worktrees").catch(requestFailed);

  if (args[0] === "warm") {
    args.shift();
    const repo = args.shift();
    const nArg = args.shift();
    const n = nArg === undefined ? undefined : Number(nArg);
    if (!repo || args.length > 0) return fail(WORKTREES_USAGE);
    if (nArg !== undefined && (n === undefined || !/^\d+$/.test(nArg) || !Number.isInteger(n) || n < 0 || n > 2)) {
      return fail("warm must be a whole number from 0 to 2");
    }
    const id = repoId(await getInfo(), repo, fail);
    const result = await ask<{ repo: string; want: number }>(target, "POST", "/api/worktrees/warm", {
      repo: id,
      ...(n !== undefined ? { n } : {}),
    }).catch(requestFailed);
    console.log(`${result.repo}: ${result.want} warm`);
    return;
  }

  if (args[0] === "prune") {
    args.shift();
    const repo = args.shift();
    if (repo?.startsWith("--") || args.length > 0) return fail(WORKTREES_USAGE);
    const body = repo === undefined ? {} : { repo: repoId(await getInfo(), repo, fail) };
    const result = await ask<{ removed: string[] }>(target, "POST", "/api/worktrees/prune", body).catch(requestFailed);
    for (const line of result.removed.length > 0 ? result.removed : ["nothing to prune"]) console.log(line);
    return;
  }

  const jsonFlagCount = args.filter((arg) => arg === "--json").length;
  const json = has(args, "--json");
  const repo = args.shift() ?? null;
  if (jsonFlagCount > 1 || repo?.startsWith("--") || args.length > 0) return fail(WORKTREES_USAGE);
  const info = await getInfo();
  if (json) console.log(JSON.stringify(info, null, 2));
  else for (const line of worktreeLines(info, repo, Date.now())) console.log(line);
}
