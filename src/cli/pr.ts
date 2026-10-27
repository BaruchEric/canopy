/** `canopy pr` and `canopy prs` (FR-011): open a PR for a ready branch
 *  run in place of landing it, rebase one by hand (`canopy pr rebase`,
 *  FR-035), and every PR branch runs opened with where its checks stand,
 *  over the API of every backend the home one lists. */

import { checksWord } from "../core/pr";
import type { BackendEntry, PrWatch } from "../core/types";
import { ask, errText, has, take, targetsOf, Unreachable, type Target } from "./health";

export const PR_USAGE = "usage: canopy pr <run> [--draft] [--backend URL]\n       canopy pr rebase <run> [--backend URL]\n       canopy prs [repo] [--backend URL]";

export interface PrCliDeps {
  fail: (msg: string) => never;
  /** one request to a backend; the CLI's `ask` unless a test says otherwise */
  ask?: typeof ask;
}

/** whether `repo` (an id or a folder's name) names this repo */
const named = (repo: string | null, id: string, path: string): boolean => repo === null || id === repo || path.split("/").pop() === repo;

const statusWord = (w: PrWatch): string => (!w.state ? "not read" : w.state.status === "open" && w.state.draft ? "draft" : w.state.status);

/** One backend's PRs, a repo at a time: each PR's number, where it stands,
 *  its checks, its branch, the toggles that are on and its link, with a
 *  line under it when auto-fix gave up or the last read failed. */
export function prsLines(prs: readonly PrWatch[], repo: string | null, backend = ""): string[] {
  const where = backend ? ` on ${backend}` : "";
  const out: string[] = [];
  for (const id of [...new Set(prs.map((w) => w.repoId))].sort()) {
    const mine = prs.filter((w) => w.repoId === id && named(repo, id, w.repoPath)).sort((a, b) => a.number - b.number);
    if (mine.length === 0) continue;
    out.push(`${id}${where}`);
    for (const w of mine) {
      const on = [w.autoFix ? "auto-fix" : "", w.autoMerge ? "auto-merge" : ""].filter(Boolean).join(", ");
      const checks = w.state ? checksWord(w.state) : "";
      out.push(`  ${`#${w.number}`.padEnd(4)} ${statusWord(w).padEnd(8)} ${checks.padEnd(19)} ${w.branch}${on ? `  ${on}` : ""}  ${w.url}`);
      if (w.gaveUp) out.push(`       auto-fix gave up: ${w.gaveUp}`);
      if (w.error) out.push(`       ${w.error}`);
    }
  }
  return out;
}

export async function prCommand(cmd: "pr" | "prs", argv: string[], { fail, ask: askFn = ask }: PrCliDeps): Promise<void> {
  const args = [...argv];
  const given = take(args, "--backend");
  const home = (given ?? process.env["CANOPY_API"] ?? "http://127.0.0.1:7850").replace(/\/+$/, "");
  const homeTarget: Target = { name: "home", urls: [home] };
  const failed = (err: unknown): never => fail(err instanceof Unreachable ? `home did not answer: ${err.message}` : errText(err));
  if (cmd === "pr" && args[0] === "rebase") {
    args.shift();
    const run = args.shift();
    if (!run || args.length > 0) return fail(PR_USAGE);
    const w = await askFn<PrWatch>(homeTarget, "POST", "/api/prs/rebase", { run }).catch(failed);
    if (w.gaveUp) return fail(`${w.branch}: ${w.gaveUp}`);
    if (w.error) return fail(`${w.branch}: ${w.error}`);
    if (w.fixing) console.log(`${w.branch}: rebasing onto ${w.target} stopped on conflicts; fix run ${w.fixing.run} is on them`);
    else console.log(`${w.branch}: rebased onto ${w.target} and pushed (${w.pushed.slice(0, 7)})`);
    return;
  }
  if (cmd === "pr") {
    const draft = has(args, "--draft");
    const run = args.shift();
    if (!run || args.length > 0) return fail(PR_USAGE);
    const w = await askFn<PrWatch>(homeTarget, "POST", "/api/prs/open", { run, ...(draft ? { draft } : {}) }).catch(failed);
    console.log(`${w.branch}: PR #${w.number} ${draft ? "opened as a draft" : "opened"} against ${w.target}: ${w.url}`);
    return;
  }
  const repo = args.shift() ?? null;
  if (args.length > 0) return fail(PR_USAGE);
  const listed = await askFn<{ self?: string; backends?: BackendEntry[] }>(homeTarget, "GET", "/api/backends").catch(() => null);
  const targets = given === undefined && listed?.self ? targetsOf(home, listed.self, listed.backends ?? []) : [homeTarget];
  let any = false;
  for (const t of targets) {
    let prs: PrWatch[];
    try {
      prs = await askFn<PrWatch[]>(t, "GET", "/api/prs");
    } catch (err) {
      console.log(`${t.name}: ${err instanceof Unreachable ? `did not answer: ${err.message}` : errText(err)}`);
      continue;
    }
    const lines = prsLines(prs, repo, targets.length > 1 ? t.name : "");
    for (const line of lines) console.log(line);
    any ||= lines.length > 0;
  }
  if (!any) console.log(repo ? `no PRs from branch runs in ${repo}` : "no PRs from branch runs");
}
