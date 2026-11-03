/** `canopy spec drift`: the newest spec-converge report per repo and where
 *  its fix stands, over the API of every backend the home one lists
 *  (FR-041 plan 2). The report is the Check step's closing text, kept on
 *  the trigger event as its summary. */

import { driftReports, type TriggersInfo } from "../core/trigger";
import { driftLines } from "../core/treelines";
import type { BackendEntry } from "../core/types";
import { paintLine } from "./render";
import { ask, errText, has, take, targetsOf, Unreachable, type Target } from "./health";

export const DRIFT_USAGE = "usage: canopy spec drift [repo] [--all] [--backend URL]";

/** One backend's drift lines: every repo with a report, or the one named
 *  by its id or its last path segment. Without `all`, the clean ones are
 *  left out. */
export function driftReportLines(info: Pick<TriggersInfo, "events">, repo: string | null, now: number, all = false, backend = ""): string[] {
  const rows = [...driftReports(info.events).values()].filter((row) => repo === null || row.event.repoId === repo || row.event.repoId.split("/").pop() === repo);
  return driftLines(rows, now, all, backend).map((line) => line.map((s) => s.text).join(""));
}

export interface DriftDeps {
  fail: (msg: string) => never;
  /** one request to a backend; the CLI's `ask` unless a test says otherwise */
  ask?: typeof ask;
  /** the clock, for "checked 2h ago" */
  now?: () => number;
  /** the terminal's painter; the plain text in tests */
  paint?: (line: ReturnType<typeof driftLines>[number]) => string;
}

export async function driftCommand(argv: string[], { fail, ask: askFn = ask, now = Date.now, paint = paintLine }: DriftDeps): Promise<void> {
  const args = [...argv];
  const given = take(args, "--backend");
  const home = (given ?? process.env["CANOPY_API"] ?? "http://127.0.0.1:7850").replace(/\/+$/, "");
  const homeTarget: Target = { name: "home", urls: [home] };
  const all = has(args, "--all");
  const repo = args.shift() ?? null;
  if (args.length > 0) return fail(DRIFT_USAGE);
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
    const rows = [...driftReports(info.events).values()].filter((row) => repo === null || row.event.repoId === repo || row.event.repoId.split("/").pop() === repo);
    const lines = driftLines(rows, now(), all, targets.length > 1 ? t.name : "");
    for (const line of lines) console.log(paint(line));
    any ||= lines.length > 0;
  }
  if (!any) console.log(repo ? `no spec drift ${all ? "report" : "found"} in ${repo}` : `no spec drift ${all ? "reports" : "found"}; a schedule rule running spec-converge writes one per repo`);
}
