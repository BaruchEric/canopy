/** `canopy scenarios`: a repo's holdout scenarios, listed, added and run,
 *  over the API of the backend that holds them. */

import type { ScenarioRun } from "../core/types";
import { ask, errText, has, take, Unreachable, type Target } from "./health";

export const SCENARIOS_USAGE =
  "usage: canopy scenarios <repo> [--backend URL]\n       canopy scenarios <repo> add <name> [--judge] [--run CMD] [--backend URL]\n       canopy scenarios <repo> run [<run>] [--backend URL]";

/** the list: one line per scenario, `name  kind`; errors as `file  cannot be read: why`; a line that says how to add one when empty */
export function listLines(repo: string, got: { names: { name: string; kind: string }[]; errors: { file: string; error: string }[] }): string[] {
  if (got.names.length === 0 && got.errors.length === 0) return [`no scenarios for ${repo}; add one with canopy scenarios ${repo} add <name>`];
  return [
    repo,
    ...got.names.map((n) => `  ${n.name.padEnd(16)} ${n.kind}`),
    ...got.errors.map((e) => `  ${e.file.padEnd(16)} cannot be read: ${e.error}`),
  ];
}

/** `scenarios 2/3 · 0.67`, then `ok name` or `red name  <last line of its tail>` per result */
export function runLines(run: ScenarioRun): string[] {
  return [
    `scenarios ${run.passed}/${run.total} · ${run.score.toFixed(2)}`,
    ...run.results.map((r) => (r.ok ? `  ok   ${r.name}` : `  red  ${r.name}  ${(r.tail ?? "").split("\n").pop() ?? ""}`)),
  ];
}

export async function scenariosCommand(argv: string[], { fail }: { fail: (msg: string) => never }): Promise<void> {
  const args = [...argv];
  const given = take(args, "--backend");
  const runCmd = take(args, "--run");
  const judge = has(args, "--judge");
  const home = (given ?? process.env["CANOPY_API"] ?? "http://127.0.0.1:7850").replace(/\/+$/, "");
  const target: Target = { name: "home", urls: [home] };
  const failed = (err: unknown): never => fail(err instanceof Unreachable ? `home did not answer: ${err.message}` : errText(err));
  const repo = args.shift();
  if (!repo) return fail(SCENARIOS_USAGE);
  const sub = args.shift();
  if (sub === undefined) {
    if (judge || runCmd !== undefined) return fail(SCENARIOS_USAGE);
    const got = await ask<{ names: { name: string; kind: string }[]; errors: { file: string; error: string }[] }>(target, "GET", `/api/scenarios/names?repo=${encodeURIComponent(repo)}`).catch(failed);
    for (const line of listLines(repo, got)) console.log(line);
    return;
  }
  if (sub === "add") {
    const name = args.shift();
    if (!name || args.length > 0) return fail(SCENARIOS_USAGE);
    const body = { repo, name, ...(judge ? { kind: "judge" } : {}), ...(runCmd !== undefined ? { run: runCmd } : {}) };
    const got = await ask<{ path: string }>(target, "POST", "/api/scenarios", body).catch(failed);
    console.log(`wrote ${got.path}`);
    return;
  }
  if (sub === "run") {
    const run = args.shift();
    if (args.length > 0 || judge || runCmd !== undefined) return fail(SCENARIOS_USAGE);
    // a set can take as long as the repo's gates, so wait for it
    const got = await ask<ScenarioRun>(target, "POST", "/api/scenarios/run", { repo, ...(run ? { run } : {}) }, 30 * 60_000).catch(failed);
    const lines = runLines(got);
    if (got.passed < got.total) return fail(lines.join("\n"));
    for (const line of lines) console.log(line);
    return;
  }
  return fail(SCENARIOS_USAGE);
}
