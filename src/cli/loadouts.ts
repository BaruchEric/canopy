/**
 * `canopy loadouts` (FR-065): the named loadouts kit.json offers a run, one
 * line each, the skills that are always on, the defaults that hand one to a
 * start that names none, each provider's state on the backend (FR-069), and
 * the lines kit.json got wrong. `resolve` says what a start in a repo takes;
 * `adopt` and `restore` move a provider's hand file aside for kit.json's and
 * back. The lines are pure (loadouts.test.ts).
 */

import type { LoadoutDefault, LoadoutsInfo } from "../core/types";
import { apiBase } from "./api";
import { ask, backendTargets, errText, has, take, Unreachable } from "./health";

export const LOADOUTS_USAGE = [
  "usage: canopy loadouts [--json] [--backend URL | --on NAME]",
  "       canopy loadouts resolve <repo> [--action ACTION] [--json] [--backend URL | --on NAME]",
  "       canopy loadouts adopt|restore <provider> [--backend URL | --on NAME]",
].join("\n");

/** The defaults, most specific last: everywhere, each machine, each repo. */
export function defaultLines(info: LoadoutsInfo): string[] {
  const d = info.defaults;
  if (!d) return [];
  const out: string[] = [];
  if (d.loadout !== null) out.push(`default: ${d.loadout} everywhere`);
  for (const [m, name] of Object.entries(d.machines)) out.push(`default: ${name} on machine ${m}${info.machine === m ? " (this backend)" : ""}`);
  for (const [r, name] of Object.entries(d.repos)) out.push(`default: ${name} in ${r}`);
  return out;
}

/** One line per provider kit.json declares, with its state on this backend. */
export function providerLines(info: LoadoutsInfo): string[] {
  const ps = info.providers ?? [];
  const idWidth = Math.max(0, ...ps.map((p) => p.id.length));
  return ps.map((p) => [
    `provider ${p.id.padEnd(idWidth)}`,
    p.harness,
    p.state + (p.adopted ? " (adopted)" : ""),
    p.machines === null ? "every machine" : `on ${p.machines.join(", ")}`,
    p.central ? "" : "own file",
    p.why ?? "",
    p.note,
  ].filter((f) => f !== "").join("  "));
}

/** What a start in a repo takes when it names no loadout, in words. */
export function resolveLines(repo: string, d: LoadoutDefault): string[] {
  const where = d.from ? ` (from ${d.from}${d.key ? ` ${d.key}` : ""})` : "";
  const head = d.name ? `${repo}: ${d.name}${where}` : `${repo}: no loadout${d.from ? `, ${d.from}${d.key ? ` ${d.key}` : ""} says none` : ""}`;
  return [head, ...(d.skipped ?? []).map((s) => `  passed over: ${s}`)];
}

export function loadoutLines(info: LoadoutsInfo): string[] {
  const agents = info.loadouts.map((l) => `${l.harness} ${l.model} ${l.effort}${l.provider ? ` on ${l.provider}` : ""}`);
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
  out.push(...defaultLines(info), ...providerLines(info));
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
  const actionFlag = args.includes("--action");
  const action = take(args, "--action");
  if (actionFlag && action === undefined) return fail("--action needs a value");
  const sub = args[0] === "resolve" || args[0] === "adopt" || args[0] === "restore" ? args.shift() : undefined;
  const arg = sub ? args.shift() : undefined;
  if (args.length > 0 || (sub && !arg) || (action !== undefined && sub !== "resolve")) return fail(LOADOUTS_USAGE);
  const home = apiBase(given);
  const [named] = on === undefined ? [] : await backendTargets(home, { ...(given !== undefined ? { given } : {}), on }, fail);
  const target = named ?? { name: "home", urls: [home] };
  const call = <T>(method: string, path: string, body?: unknown): Promise<T> => ask<T>(target, method, path, body)
    .catch((err: unknown) => fail(err instanceof Unreachable ? `${target.name} did not answer: ${err.message}` : errText(err)));
  if (sub === "resolve" && arg) {
    const q = new URLSearchParams({ id: arg, ...(action ? { action } : {}) });
    const d = await call<LoadoutDefault>("GET", `/api/loadouts/resolve?${q}`);
    if (asJson) console.log(JSON.stringify(d, null, 2));
    else for (const line of resolveLines(arg, d)) console.log(line);
    return;
  }
  if ((sub === "adopt" || sub === "restore") && arg) {
    const info = await call<LoadoutsInfo>("POST", `/api/kit/providers/${sub}`, { id: arg });
    const p = info.providers?.find((x) => x.id === arg);
    console.log(`provider ${arg}: ${p ? p.state : "gone"}${p?.why ? `  ${p.why}` : ""}`);
    return;
  }
  const info = await call<LoadoutsInfo>("GET", "/api/loadouts");
  if (asJson) {
    console.log(JSON.stringify(info, null, 2));
    return;
  }
  if (info.loadouts.length === 0 && info.errors.length === 0 && (info.providers ?? []).length === 0) {
    console.log("no loadouts in kit.json");
    return;
  }
  for (const line of loadoutLines(info)) console.log(line);
}
