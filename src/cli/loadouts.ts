/**
 * `canopy loadouts` (FR-065): the named loadouts kit.json offers a run, one
 * line each, the skills that are always on, and the lines kit.json got wrong.
 * The lines are pure (loadouts.test.ts).
 */

import type { LoadoutsInfo } from "../core/types";
import { apiBase } from "./api";
import { ask, backendTargets, errText, has, take, Unreachable } from "./health";

export const LOADOUTS_USAGE = "usage: canopy loadouts [--json] [--backend URL | --on NAME]";

export function loadoutLines(info: LoadoutsInfo): string[] {
  const agents = info.loadouts.map((l) => `${l.harness} ${l.model} ${l.effort}`);
  const nameWidth = Math.max(0, ...info.loadouts.map((l) => l.name.length));
  const agentWidth = Math.max(0, ...agents.map((a) => a.length));
  const out = info.loadouts.map((l, i) => {
    const servers = [...l.mcp, ...(l.canopyTools ? ["canopy tools"] : [])].join(", ");
    return [
      l.name.padEnd(nameWidth),
      (agents[i] ?? "").padEnd(agentWidth),
      `${l.skills.length} ${l.skills.length === 1 ? "skill" : "skills"}`,
      servers,
      l.note,
    ].filter((field) => field !== "").join("  ");
  });
  if (info.base.length > 0) out.push(`always on: ${info.base.join(", ")}`);
  for (const error of info.errors) out.push(`error: ${error}`);
  return out;
}

export async function loadoutsCommand(argv: string[], { fail }: { fail: (msg: string) => never }): Promise<void> {
  const args = [...argv];
  const backendFlag = args.includes("--backend");
  const given = take(args, "--backend");
  const onFlag = args.includes("--on");
  const on = take(args, "--on");
  if (backendFlag && given === undefined) return fail("--backend needs a value");
  if (onFlag && on === undefined) return fail("--on needs a value");
  if (backendFlag && onFlag) return fail("use either --backend URL or --on NAME");
  const asJson = has(args, "--json");
  if (args.length > 0) return fail(LOADOUTS_USAGE);
  const home = apiBase(given);
  const [named] = on === undefined ? [] : await backendTargets(home, { ...(given !== undefined ? { given } : {}), on }, fail);
  const target = named ?? { name: "home", urls: [home] };
  const info = await ask<LoadoutsInfo>(target, "GET", "/api/loadouts")
    .catch((err: unknown) => fail(err instanceof Unreachable ? `${target.name} did not answer: ${err.message}` : errText(err)));
  if (asJson) {
    console.log(JSON.stringify(info, null, 2));
    return;
  }
  if (info.loadouts.length === 0 && info.errors.length === 0) {
    console.log("no loadouts in kit.json");
    return;
  }
  for (const line of loadoutLines(info)) console.log(line);
}
