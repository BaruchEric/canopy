/** `canopy issues`: every GitHub and Forgejo issue a trigger rule took and
 *  where each stands, over the API of every backend the home one lists. */

import type { TriggerEvent, TriggersInfo } from "../core/trigger";
import type { BackendEntry } from "../core/types";
import { ask, errText, take, targetsOf, Unreachable, type Target } from "./health";

export const ISSUES_USAGE = "usage: canopy issues [repo] [--backend URL]";

/** whether the event is a forge's issue: GitHub's or Forgejo's, not Sentry's or Linear's */
const fromForge = (e: TriggerEvent): boolean => e.service === "github" || e.service === "forgejo";

/** One backend's forge issues, a repo at a time and newest first: the
 *  issue's number, its state, its branch's id and its PR when it has them,
 *  and why it stopped, failed or waits. `repo` keeps one repo by id. */
export function issueLines(info: Pick<TriggersInfo, "events">, repo: string | null, backend = ""): string[] {
  const where = backend ? ` on ${backend}` : "";
  const events = info.events.filter(fromForge).filter((e) => repo === null || e.repoId === repo);
  const repos = [...new Set(events.map((e) => e.repoId))].sort();
  const out: string[] = [];
  for (const id of repos) {
    out.push(`${id}${where}`);
    const mine = events.filter((e) => e.repoId === id).sort((a, b) => b.lastAt - a.lastAt);
    for (const e of mine) out.push(`  ${(e.short ?? e.key).padEnd(10)} ${e.status.padEnd(8)} ${(e.branch ?? "-").padEnd(12)} ${(e.pr ? `#${e.pr.number}` : "-").padEnd(6)} ${e.reason ?? "-"}`);
  }
  return out;
}

export interface IssuesDeps {
  fail: (msg: string) => never;
  /** one request to a backend; the CLI's `ask` unless a test says otherwise */
  ask?: typeof ask;
}

export async function issuesCommand(argv: string[], { fail, ask: askFn = ask }: IssuesDeps): Promise<void> {
  const args = [...argv];
  const given = take(args, "--backend");
  const home = (given ?? process.env["CANOPY_API"] ?? "http://127.0.0.1:7850").replace(/\/+$/, "");
  const homeTarget: Target = { name: "home", urls: [home] };
  const repo = args.shift() ?? null;
  if (args.length > 0) return fail(ISSUES_USAGE);
  const listed = await askFn<{ self?: string; backends?: BackendEntry[] }>(homeTarget, "GET", "/api/backends").catch(() => null);
  const targets = given === undefined && listed?.self ? targetsOf(home, listed.self, listed.backends ?? []) : [homeTarget];
  let any = false;
  for (const t of targets) {
    let info: TriggersInfo;
    try {
      info = await askFn<TriggersInfo>(t, "GET", "/api/triggers");
    } catch (err) {
      console.log(`${t.name}: ${err instanceof Unreachable ? `did not answer: ${err.message}` : errText(err)}`);
      continue;
    }
    const lines = issueLines(info, repo, targets.length > 1 ? t.name : "");
    for (const line of lines) console.log(line);
    any ||= lines.length > 0;
  }
  if (!any) console.log(repo ? `no GitHub or Forgejo issues taken in ${repo}` : "no GitHub or Forgejo issues taken");
}
