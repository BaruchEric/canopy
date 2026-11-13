/**
 * `canopy coordinator`: the live coordinators, one goal's cards, and the
 * steering verbs hold, resume and start. The lines are pure
 * (coordinator.test.ts).
 */

import { cardCarries, cardCounts } from "../core/coordinator";
import { isRunActive, type Run } from "../core/types";
import { apiBase } from "./api";
import { ask, backendTargets, errText, has, take, Unreachable } from "./health";

export const COORDINATOR_USAGE =
  "usage: canopy coordinator [--json] [--backend URL | --on NAME]\n       canopy coordinator <run> [--json] [--backend URL | --on NAME]\n       canopy coordinator hold <run>\n       canopy coordinator resume <run>\n       canopy coordinator start <run> [id ...]";

const firstLine = (text: string): string => text.split("\n")[0]?.trim() ?? "";

/** the live coordinators: id, repo, held or not, card counts, the goal's first line */
export function coordinatorLines(runs: Run[]): string[] {
  return runs
    .filter((run) => run.action === "coordinate" && isRunActive(run))
    .map((run) => [run.id, run.repoId, run.held ? "held" : "", cardCounts(run.tasks ?? []), firstLine(run.note)].filter((field) => field !== "").join("  "));
}

/** one coordinator's cards, columns padded: id, state, repo, loadout, workflow, after, title */
export function cardLines(run: Run): string[] {
  const rows = (run.tasks ?? []).map((task) => {
    const carries = cardCarries(task);
    return [task.id, task.state, task.repo, carries.loadout?.word ?? "", carries.workflow ?? "", carries.after ?? ""];
  });
  const widths = [0, 1, 2, 3, 4, 5].map((col) => Math.max(0, ...rows.map((row) => row[col]?.length ?? 0)));
  return (run.tasks ?? []).map((task, i) => {
    const row = rows[i] ?? [];
    const cells = row.map((cell, col) => cell.padEnd(widths[col] ?? 0)).filter((_, col) => (widths[col] ?? 0) > 0);
    return [...cells, task.title].join("  ");
  });
}

export async function coordinatorCommand(argv: string[], { fail }: { fail: (msg: string) => never }): Promise<void> {
  const args = [...argv];
  const backendFlag = args.includes("--backend");
  const given = take(args, "--backend");
  const onFlag = args.includes("--on");
  const on = take(args, "--on");
  if (backendFlag && given === undefined) return fail("--backend needs a value");
  if (onFlag && on === undefined) return fail("--on needs a value");
  if (backendFlag && onFlag) return fail("use either --backend URL or --on NAME");
  const asJson = has(args, "--json");
  const home = apiBase(given);
  const [named] = on === undefined ? [] : await backendTargets(home, { ...(given !== undefined ? { given } : {}), on }, fail);
  const target = named ?? { name: "home", urls: [home] };
  const failed = (err: unknown): never => fail(err instanceof Unreachable ? `${target.name} did not answer: ${err.message}` : errText(err));

  const sub = args[0];
  if (sub === "hold" || sub === "resume") {
    const run = args[1];
    if (!run || args.length !== 2) return fail(COORDINATOR_USAGE);
    await ask<unknown>(target, "POST", "/api/coordinator/hold", { run, held: sub === "hold" }).catch(failed);
    console.log(sub === "hold" ? `${run} held: no card starts until you resume it` : `${run} resumed`);
    return;
  }
  if (sub === "start") {
    const run = args[1];
    if (!run) return fail(COORDINATOR_USAGE);
    const ids = args.slice(2);
    await ask<unknown>(target, "POST", "/api/coordinator/start", { run, ...(ids.length > 0 ? { ids } : {}) }).catch(failed);
    console.log(ids.length > 0 ? `${run}: started ${ids.join(", ")}` : `${run}: started every proposed card`);
    return;
  }

  if (args.length > 1) return fail(COORDINATOR_USAGE);
  const runs = await ask<Run[]>(target, "GET", "/api/runs").catch(failed);
  if (sub === undefined) {
    const live = runs.filter((run) => run.action === "coordinate" && isRunActive(run));
    if (asJson) return void console.log(JSON.stringify(live, null, 2));
    if (live.length === 0) return void console.log("no live coordinators");
    for (const line of coordinatorLines(runs)) console.log(line);
    return;
  }
  const run = runs.find((candidate) => candidate.id === sub && candidate.action === "coordinate" && isRunActive(candidate));
  if (!run) return fail(`no live coordinator ${sub}`);
  if (asJson) return void console.log(JSON.stringify(run.tasks ?? [], null, 2));
  const lines = cardLines(run);
  if (lines.length === 0) return void console.log(`${run.id} has no cards yet`);
  for (const line of lines) console.log(line);
}
