/** `canopy land` and `canopy queue`: a ready branch run into its repo's
 *  landing queue, and where every queue stands, over the API of every
 *  backend the home one lists. */

import { inQueue, landWord, queueOf, sentBack } from "../core/landing";
import type { BackendEntry, LandEntry, LandingInfo } from "../core/types";
import { ask, errText, take, targetsOf, Unreachable, type Target } from "./health";

export const LAND_USAGE = "usage: canopy land <run> [--backend URL]\n       canopy queue [repo] [--backend URL]";

const backWords = (e: LandEntry): string => (e.state === "red" ? `${e.gate ?? "a gate"} failed` : (e.reason ?? e.state));

/** Where one backend's queues stand, a repo at a time: each entry in
 *  order, then what came back and why, then ready runs not queued yet.
 *  `repo` keeps one repo, by id or by its folder's name. */
export function queueLines(info: LandingInfo, repo: string | null, backend = ""): string[] {
  const where = backend ? ` on ${backend}` : "";
  const repos = [...new Set([...info.entries.map((e) => e.repoId), ...info.runs.map((r) => r.repoId)])].sort();
  const wanted = (id: string, path: string) => repo === null || id === repo || path.split("/").pop() === repo;
  const out: string[] = [];
  for (const id of repos) {
    const path = info.entries.find((e) => e.repoId === id)?.repoPath ?? info.runs.find((r) => r.repoId === id)?.repoPath ?? "";
    if (!wanted(id, path)) continue;
    const mine = info.entries.filter((e) => e.repoId === id);
    const queued = queueOf(info.entries, id);
    const back = mine.filter(sentBack);
    const taken = new Set(mine.filter((e) => inQueue(e) || e.state === "landed" || sentBack(e)).map((e) => e.id));
    const ready = info.runs.filter((r) => r.repoId === id && r.state === "ready" && !taken.has(r.id));
    if (queued.length + back.length + ready.length === 0) continue;
    out.push(`${id}${where}`);
    for (const e of queued) out.push(`  ${landWord(e, info.entries).padEnd(16)} ${e.branch}${e.reason ? `  ${e.reason}` : ""}`);
    for (const e of back) out.push(`  ${landWord(e, info.entries).padEnd(16)} ${e.branch}  ${backWords(e).split("\n").pop() ?? ""}`);
    for (const r of ready) out.push(`  ${"ready".padEnd(16)} ${r.branch}  canopy land ${r.runId}`);
  }
  return out;
}

export async function landCommand(cmd: "land" | "queue", argv: string[], { fail }: { fail: (msg: string) => never }): Promise<void> {
  const args = [...argv];
  const given = take(args, "--backend");
  const home = (given ?? process.env["CANOPY_API"] ?? "http://127.0.0.1:7850").replace(/\/+$/, "");
  const homeTarget: Target = { name: "home", urls: [home] };
  if (cmd === "land") {
    const run = args.shift();
    if (!run || args.length > 0) return fail(LAND_USAGE);
    const entry = await ask<LandEntry>(homeTarget, "POST", "/api/landing/land", { run }).catch((err: unknown) =>
      fail(err instanceof Unreachable ? `home did not answer: ${err.message}` : errText(err)),
    );
    console.log(`${entry.branch}: ${landWord(entry, [entry])}; the queue rebases it onto ${entry.target}, runs the gates and fast-forwards ${entry.target}`);
    return;
  }
  const repo = args.shift() ?? null;
  if (args.length > 0) return fail(LAND_USAGE);
  const listed = await ask<{ self?: string; backends?: BackendEntry[] }>(homeTarget, "GET", "/api/backends").catch(() => null);
  const targets = given === undefined && listed?.self ? targetsOf(home, listed.self, listed.backends ?? []) : [homeTarget];
  let any = false;
  for (const t of targets) {
    let info: LandingInfo;
    try {
      info = await ask<LandingInfo>(t, "GET", "/api/landing");
    } catch (err) {
      console.log(`${t.name}: ${err instanceof Unreachable ? `did not answer: ${err.message}` : errText(err)}`);
      continue;
    }
    const lines = queueLines(info, repo, targets.length > 1 ? t.name : "");
    for (const line of lines) console.log(line);
    any ||= lines.length > 0;
  }
  if (!any) console.log(repo ? `nothing queued, sent back or ready in ${repo}` : "nothing queued, sent back or ready");
}
