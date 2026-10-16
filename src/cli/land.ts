/** `canopy land` and `canopy queue`: a ready branch run (or one a restart
 *  stopped with its work whole) into its repo's landing queue, every ready
 *  run of a repo at once, and where every queue stands, over the API of
 *  every backend the home one lists. */

import { inQueue, landWord, queueOf, reviewWord, sentBack, stoppedWhole } from "../core/landing";
import type { BackendEntry, LandEntry, LandingInfo, LandingRun } from "../core/types";
import { ask, errText, has, take, targetsOf, Unreachable, type Target } from "./health";

export const LAND_USAGE =
  "usage: canopy land <run> [--approve <id>] [--backend URL]\n       canopy land --all [repo] [--backend URL]\n       canopy queue [repo] [--backend URL]";

const backWords = (e: LandEntry): string => (e.state === "red" ? `${e.gate ?? "a gate"} failed` : (e.reason ?? e.state));

/** whether `repo` (an id or a folder's name) names this repo */
const named = (repo: string | null, id: string, path: string): boolean => repo === null || id === repo || path.split("/").pop() === repo;

/** Where one backend's queues stand, a repo at a time: each entry in
 *  order, then what came back and why, then ready runs not queued yet with
 *  what their sort says, then runs a restart stopped whose work is whole
 *  enough to land. `repo` keeps one repo, by id or by its folder's name. */
export function queueLines(info: LandingInfo, repo: string | null, backend = ""): string[] {
  const where = backend ? ` on ${backend}` : "";
  const repos = [...new Set([...info.entries.map((e) => e.repoId), ...info.runs.map((r) => r.repoId)])].sort();
  const out: string[] = [];
  for (const id of repos) {
    const path = info.entries.find((e) => e.repoId === id)?.repoPath ?? info.runs.find((r) => r.repoId === id)?.repoPath ?? "";
    if (!named(repo, id, path)) continue;
    const mine = info.entries.filter((e) => e.repoId === id);
    const queued = queueOf(info.entries, id);
    const back = mine.filter(sentBack);
    const taken = new Set(mine.filter((e) => inQueue(e) || e.state === "landed" || sentBack(e)).map((e) => e.id));
    const ready = info.runs.filter((r) => r.repoId === id && r.state === "ready" && !taken.has(r.id));
    const stopped = info.runs.filter((r) => r.repoId === id && stoppedWhole(r) && !taken.has(r.id));
    if (queued.length + back.length + ready.length + stopped.length === 0) continue;
    out.push(`${id}${where}`);
    for (const e of queued) {
      const marks = [e.auto ? "joined on its own" : "", e.approved ? "approved" : "", e.reason ?? ""].filter(Boolean).join(", ");
      out.push(`  ${landWord(e, info.entries).padEnd(16)} ${e.branch}${marks ? `  ${marks}` : ""}`);
    }
    for (const e of back) out.push(`  ${landWord(e, info.entries).padEnd(16)} ${e.branch}  ${backWords(e).split("\n").pop() ?? ""}`);
    for (const r of ready) out.push(`  ${"ready".padEnd(16)} ${r.branch}  ${r.review ? reviewWord(r.review) : "sorting"}  canopy land ${r.runId}`);
    for (const r of stopped) out.push(`  ${"stopped".padEnd(16)} ${r.branch}  can land: ${r.review ? reviewWord(r.review) : "sorting"}  canopy land ${r.runId}`);
  }
  return out;
}

/** What `canopy land` prints for a run that needs an approval: each
 *  sensitive file with why, how to look at the diff, and the command that
 *  approves the id this sort gave. */
export function approveLines(rec: LandingRun): string[] {
  const review = rec.review;
  if (!review) return [`${rec.branch} is not sorted yet; try again in a moment`];
  const look = review.files.filter((f) => f.sensitive);
  const shown = look.length > 0 ? look : review.files;
  const paths = [...new Set(shown.flatMap((f) => (f.from !== undefined ? [f.from, f.path] : [f.path])))];
  return [
    `${rec.branch} ${reviewWord(review)}:`,
    ...shown.map((f) => `  ${f.from !== undefined ? `${f.from} -> ${f.path}` : f.path}  ${f.sensitive ?? f.why ?? f.cls}`),
    `look: git -C ${rec.dir} diff ${review.base.slice(0, 12)} ${review.head.slice(0, 12)} -- ${paths.join(" ")}`,
    `then: canopy land ${rec.runId} --approve ${review.sensitiveId ?? "?"}`,
  ];
}

export async function landCommand(cmd: "land" | "queue", argv: string[], { fail }: { fail: (msg: string) => never }): Promise<void> {
  const args = [...argv];
  const given = take(args, "--backend");
  const home = (given ?? process.env["CANOPY_API"] ?? "http://127.0.0.1:7850").replace(/\/+$/, "");
  const homeTarget: Target = { name: "home", urls: [home] };
  const failed = (err: unknown): never => fail(err instanceof Unreachable ? `home did not answer: ${err.message}` : errText(err));
  if (cmd === "land" && has(args, "--all")) {
    const repo = args.shift() ?? null;
    if (args.length > 0) return fail(LAND_USAGE);
    const info = await ask<LandingInfo>(homeTarget, "GET", "/api/landing").catch(failed);
    const repos = [...new Set(info.runs.filter((r) => r.state === "ready" && named(repo, r.repoId, r.repoPath)).map((r) => r.repoId))].sort();
    if (repos.length === 0) return void console.log(repo ? `nothing ready in ${repo}` : "nothing ready to land");
    for (const id of repos) {
      const got = await ask<{ queued: string[]; skipped: { id: string; branch: string; why: string }[] }>(homeTarget, "POST", "/api/landing/land-all", { repo: id }).catch(failed);
      console.log(`${id}: ${got.queued.length} queued`);
      for (const s of got.skipped) console.log(`  left for you: ${s.branch}  ${s.why}`);
    }
    return;
  }
  if (cmd === "land") {
    const approve = take(args, "--approve");
    const run = args.shift();
    if (!run || args.length > 0) return fail(LAND_USAGE);
    let entry: LandEntry;
    try {
      entry = await ask<LandEntry>(homeTarget, "POST", "/api/landing/land", { run, ...(approve ? { approve } : {}) });
    } catch (err) {
      if (err instanceof Unreachable || !/needs your approval/.test(errText(err))) return failed(err);
      // the land sorted it again just now, so the record holds what to show
      const info = await ask<LandingInfo>(homeTarget, "GET", "/api/landing").catch(failed);
      const rec = info.runs.find((r) => r.id === run || r.runId === run);
      if (!rec) return failed(err);
      for (const line of approveLines(rec)) console.log(line);
      return fail("it needs your approval; look at the files, then run the command above");
    }
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
