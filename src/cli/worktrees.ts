/** `canopy worktrees`: show this backend's run, warm and kept trees, set a
 *  repo's warm count, prune its orphans and stale slots, and make, sync,
 *  merge, clean up, remove and find the trees kept by hand (FR-051). */

import { treeWords } from "../core/treewords";
import type { BranchTree, BranchTreesInfo, TasksResult, WorktreesInfo, WorktreeRepoInfo } from "../core/types";
import { apiBase } from "./api";
import { ask, errText, has, take, Unreachable, type Target } from "./health";

export const WORKTREES_USAGE = [
  "usage: canopy worktrees [repo] [--json] [--backend URL]",
  "       canopy worktrees warm <repo> [N] [--backend URL]",
  "       canopy worktrees prune [repo] [--backend URL]",
  "       canopy worktrees add <repo> <branch> [--base REF] [--no-caches] [--no-sync] [--backend URL]",
  "       canopy worktrees sync <repo> <branch> [--backend URL]",
  "       canopy worktrees auto <repo> <branch> on|off [--backend URL]",
  "       canopy worktrees merge <repo> <branch> [--no-squash] [--no-commit] [--keep] [--backend URL]",
  "       canopy worktrees clean [repo] [--backend URL]",
  "       canopy worktrees rm <repo> <branch> [--force] [--delete-branch] [--backend URL]",
  "       canopy worktrees path <repo> <branch> [--backend URL]",
  "       canopy worktrees start <repo> <run branch> [task] [--backend URL]",
  "       canopy worktrees stop <repo> <run branch> [task] [--backend URL]",
  "       canopy worktrees shell-init",
].join("\n");

/** how often `merge` asks after the tree, and for how long at most (the
 *  gates may take a while) */
const MERGE_POLL = 1_000;
const MERGE_WAIT = 30 * 60_000;

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

/** the trees a backend keeps by hand for one repo; none when the backend
 *  predates them (`trees` null) */
function keptTrees(trees: BranchTreesInfo | null, repoId: string): BranchTree[] {
  return trees?.repos.find((r) => r.repoId === repoId)?.trees ?? [];
}

const treeLine = (t: BranchTree): string => `  tree    ${t.branch}  ${treeWords(t)}  ${t.dir}`;

/** One repo at a time: its runs, kept trees, warm slots, failures and
 *  orphans, then free disk. */
export function worktreeLines(info: WorktreesInfo, repo: string | null, now: number, trees: BranchTreesInfo | null = null): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const entry of info.repos) {
    seen.add(entry.repoId);
    const kept = keptTrees(trees, entry.repoId);
    if (repo !== null && !named(repo, entry)) continue;
    if (repo === null && !hasKeptWorktrees(entry) && kept.length === 0) continue;

    if (!hasKeptWorktrees(entry)) {
      out.push(kept.length === 0 ? `${entry.repoId}  nothing kept` : `${entry.repoId}  ${kept.length} tree${kept.length === 1 ? "" : "s"} kept`);
    } else {
      const gates = entry.fileWarm !== undefined && entry.fileWarm !== entry.want ? ` (the gates file says ${entry.fileWarm})` : "";
      out.push(`${entry.repoId}  ${entry.want} warm wanted${gates}`);
    }

    for (const run of entry.runs) {
      out.push(`  run     ${run.branch}  ${run.state}  ${run.dir}`);
      if (run.task) out.push(`  task    ${run.task.name}  ${run.task.status}${run.task.port !== undefined ? `  :${run.task.port}` : ""}`);
    }
    for (const t of kept) out.push(treeLine(t));
    for (const warm of entry.warm) out.push(`  warm    ${warm.name}  ${warm.base.slice(0, 7)}  ${ageWord(now - warm.madeAt)}  ${sizeWord(warm.size)}`);
    if (entry.refilling) out.push(`  warm    ${entry.refilling}  refilling`);
    for (const failure of entry.fails) out.push(`  warm    ${failure.name}  failed ${failure.fails}x: ${failure.why}`);
    for (const orphan of entry.orphans) out.push(`  orphan  ${orphan}`);
  }
  // a repo the pool never lists but a tree was kept for
  for (const entry of trees?.repos ?? []) {
    if (seen.has(entry.repoId) || entry.trees.length === 0) continue;
    if (repo !== null && !named(repo, entry)) continue;
    out.push(`${entry.repoId}  ${entry.trees.length} tree${entry.trees.length === 1 ? "" : "s"} kept`);
    for (const t of entry.trees) out.push(treeLine(t));
  }
  out.push(`free ${sizeWord(info.free)} under ${info.root}`);
  return out;
}

/** a run's branch id, from its id or its branch's name; what nothing lists
 *  (a run still starting) is passed on for the backend to answer */
export function branchIdOf(entry: Pick<WorktreeRepoInfo, "runs"> | undefined, name: string): string {
  return entry?.runs.find((r) => r.id === name || r.branch === name)?.id ?? name;
}

/** what a start or stop left in the worktree */
export function treeTaskLine(result: TasksResult, id: string, name: string | undefined, action: "start" | "stop"): string {
  const t = result.trees?.find((x) => x.tree?.id === id && (name === undefined || x.name === name));
  if (!t) return `${action === "start" ? "started" : "stopped"} ${name ?? "the dev task"}`;
  return action === "stop" ? `stopped ${t.name} in ${t.tree?.branch}` : `${t.name} on ${t.port !== undefined ? `:${t.port}` : "a port of its own"} in ${t.tree?.branch}`;
}

/** The shell function `canopy worktrees shell-init` prints: `cw <branch>`
 *  changes into the tree on that branch for the repo the shell sits in
 *  (named by its folder), `cw <repo> <branch>` for any repo. Eval it from a
 *  shell's rc file, the way worktrunk's `wt config shell` is used. */
export const SHELL_INIT = `# canopy worktrees shell-init: cw changes into a kept worktree by branch
cw() {
  local dir
  if [ "$#" -eq 1 ]; then
    dir="$(canopy worktrees path "$(basename "$PWD")" "$1")" || return
  elif [ "$#" -eq 2 ]; then
    dir="$(canopy worktrees path "$1" "$2")" || return
  else
    echo "usage: cw [repo] <branch>" >&2
    return 2
  fi
  cd "$dir" || return
}
`;

type Fail = (message: string) => never;

function repoId(info: WorktreesInfo, name: string, fail: Fail): string {
  const found = info.repos.filter((entry) => named(name, entry));
  if (found.length === 1) return found[0]!.repoId;
  if (found.length > 1) return fail(`${name} matches more than one repo: ${found.map((entry) => entry.repoId).join(", ")}; use an id`);
  return fail(`no repo named ${name}`);
}

/** Inspect or change the worktrees kept by the home backend. */
export async function worktreesCommand(argv: string[], { fail }: { fail: Fail }): Promise<void> {
  if (argv[0] === "shell-init") {
    if (argv.length > 1) return fail(WORKTREES_USAGE);
    process.stdout.write(SHELL_INIT);
    return;
  }
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
  // a backend from before the kept trees answers 404 here: then there are none
  const getTrees = async (): Promise<BranchTreesInfo | null> =>
    ask<BranchTreesInfo>(target, "GET", "/api/trees").catch((error: unknown) => (error instanceof Unreachable ? requestFailed(error) : null));

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

  if (args[0] === "add") {
    args.shift();
    const baseFlag = args.includes("--base");
    const base = take(args, "--base");
    if (baseFlag && (base === undefined || base.startsWith("--"))) return fail("--base needs a ref");
    const caches = !has(args, "--no-caches");
    const sync = !has(args, "--no-sync");
    const repo = args.shift();
    const branch = args.shift();
    if (!repo || !branch || branch.startsWith("--") || args.length > 0) return fail(WORKTREES_USAGE);
    const id = repoId(await getInfo(), repo, fail);
    const { tree } = await ask<{ tree: BranchTree }>(target, "POST", "/api/trees/add", {
      repo: id,
      branch,
      ...(base !== undefined ? { base } : {}),
      caches,
      ...(sync ? {} : { sync }),
    }).catch(requestFailed);
    console.log(`${tree.branch}  ${tree.dir}${tree.port !== null ? `  :${tree.port}` : ""}`);
    if (tree.state === "preparing") console.log("preparing: the setup line runs and the caches clone in the background; canopy worktrees shows when it is ready");
    return;
  }

  if (args[0] === "sync") {
    args.shift();
    const repo = args.shift();
    const branch = args.shift();
    if (!repo || !branch || branch.startsWith("--") || args.length > 0) return fail(WORKTREES_USAGE);
    const id = repoId(await getInfo(), repo, fail);
    // a sync that stopped answers 409 with why, which requestFailed prints
    const { tree } = await ask<{ tree: BranchTree }>(target, "POST", "/api/trees/sync", { repo: id, tree: branch }).catch(requestFailed);
    console.log(`synced ${tree.branch} onto ${tree.base}  ${treeWords(tree)}`);
    return;
  }

  if (args[0] === "auto") {
    args.shift();
    const repo = args.shift();
    const branch = args.shift();
    const on = args.shift();
    if (!repo || !branch || branch.startsWith("--") || (on !== "on" && on !== "off") || args.length > 0) return fail(WORKTREES_USAGE);
    const id = repoId(await getInfo(), repo, fail);
    const { tree } = await ask<{ tree: BranchTree }>(target, "POST", "/api/trees/auto", { repo: id, tree: branch, sync: on === "on" }).catch(requestFailed);
    console.log(tree.sync ? `${tree.branch} follows ${tree.base}` : `${tree.branch} stays where it is while ${tree.base} moves`);
    return;
  }

  if (args[0] === "merge") {
    args.shift();
    const squash = !has(args, "--no-squash");
    const commit = !has(args, "--no-commit");
    const keep = has(args, "--keep");
    const repo = args.shift();
    const branch = args.shift();
    if (!repo || !branch || branch.startsWith("--") || args.length > 0) return fail(WORKTREES_USAGE);
    const id = repoId(await getInfo(), repo, fail);
    const { tree } = await ask<{ tree: BranchTree }>(target, "POST", "/api/trees/merge", {
      repo: id,
      tree: branch,
      ...(squash ? {} : { squash }),
      ...(commit ? {} : { commit }),
      ...(keep ? { keep } : {}),
    }).catch(requestFailed);
    console.log(`merging ${tree.branch} into ${tree.base}${squash ? ", squashed" : ""}…`);
    // the merge runs on the backend; the list says when the tree is gone, or why it stopped
    const until = Date.now() + MERGE_WAIT;
    while (Date.now() < until) {
      await Bun.sleep(MERGE_POLL);
      const now = keptTrees(await getTrees(), id).find((t) => t.slug === tree.slug);
      if (!now) {
        console.log(`merged ${tree.branch} into ${tree.base}; the tree and its branch are gone`);
        return;
      }
      if (now.state === "merging") continue;
      if (now.stopped) return fail(now.stopped);
      console.log(`merged ${tree.branch} into ${tree.base}; the tree stays at ${now.dir}`);
      return;
    }
    return fail(`still merging after ${MERGE_WAIT / 60_000} minutes; canopy worktrees shows how it ends`);
  }

  if (args[0] === "clean") {
    args.shift();
    const repo = args.shift();
    if (repo?.startsWith("--") || args.length > 0) return fail(WORKTREES_USAGE);
    const body = repo === undefined ? {} : { repo: repoId(await getInfo(), repo, fail) };
    const result = await ask<{ removed: { repoId: string; slug: string; branch: string }[] }>(target, "POST", "/api/trees/clean", body).catch(requestFailed);
    if (result.removed.length === 0) console.log("nothing to clean: no tree is merged into its base with nothing changed or open in it");
    for (const t of result.removed) console.log(`removed ${t.repoId}  ${t.branch}  and its branch`);
    return;
  }

  if (args[0] === "rm") {
    args.shift();
    const force = has(args, "--force");
    const deleteBranch = has(args, "--delete-branch");
    const repo = args.shift();
    const branch = args.shift();
    if (!repo || !branch || branch.startsWith("--") || args.length > 0) return fail(WORKTREES_USAGE);
    const id = repoId(await getInfo(), repo, fail);
    const { removed } = await ask<{ removed: string }>(target, "POST", "/api/trees/remove", {
      repo: id,
      tree: branch,
      ...(force ? { force } : {}),
      ...(deleteBranch ? { deleteBranch } : {}),
    }).catch(requestFailed);
    console.log(`removed ${removed}${deleteBranch ? ` and the branch ${branch}` : ""}`);
    return;
  }

  if (args[0] === "start" || args[0] === "stop") {
    const action = args.shift() as "start" | "stop";
    const repo = args.shift();
    const branch = args.shift();
    const name = args.shift();
    if (!repo || !branch || branch.startsWith("--") || name?.startsWith("--") || args.length > 0) return fail(WORKTREES_USAGE);
    const info = await getInfo();
    const id = repoId(info, repo, fail);
    const worktree = branchIdOf(info.repos.find((r) => r.repoId === id), branch);
    const result = await ask<TasksResult>(target, "POST", `/api/repos/tasks?id=${encodeURIComponent(id)}`, { action, worktree, ...(name ? { name } : {}) }).catch(requestFailed);
    console.log(treeTaskLine(result, worktree, name, action));
    return;
  }

  if (args[0] === "path") {
    args.shift();
    const repo = args.shift();
    const branch = args.shift();
    if (!repo || !branch || branch.startsWith("--") || args.length > 0) return fail(WORKTREES_USAGE);
    const id = repoId(await getInfo(), repo, fail);
    const tree = keptTrees(await getTrees(), id).find((t) => t.branch === branch || t.slug === branch);
    if (!tree) return fail(`${id} keeps no tree on ${branch}`);
    console.log(tree.dir);
    return;
  }

  const jsonFlagCount = args.filter((arg) => arg === "--json").length;
  const json = has(args, "--json");
  const repo = args.shift() ?? null;
  if (jsonFlagCount > 1 || repo?.startsWith("--") || args.length > 0) return fail(WORKTREES_USAGE);
  const info = await getInfo();
  const trees = await getTrees();
  if (json) console.log(JSON.stringify(trees ? { ...info, trees } : info, null, 2));
  else for (const line of worktreeLines(info, repo, Date.now(), trees)) console.log(line);
}
