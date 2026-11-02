/**
 * `canopy capacity` (FR-036): each backend's usage windows, the hit that
 * holds work, the starts the governor holds and the thresholds; `read` asks
 * for a reading now, `release` starts one held start as interactive, and
 * `set` changes the thresholds or the observed dollar figure. The arg
 * parsing and the lines are pure (capacity.test.ts).
 */

import { hitStands, resetWord, type Capacity, type CapacitySettings, type Window } from "../core/capacity";
import type { CapacityInfo } from "../core/types";
import { apiBase } from "./api";
import { ask, backendTargets, errText, has, take, Unreachable, type Target } from "./health";
import { bold, dim, lichen, moss, rust } from "./render";

export const CAPACITY_USAGE = `usage: canopy capacity [--json] [--on NAME] [--backend URL]
       canopy capacity read [--on NAME]
       canopy capacity release <id> [--on NAME]
       canopy capacity set [--low N] [--normal N] [--weekly N] [--usd N|none] [--on NAME]
  the listing asks every backend the home one lists; read, release and set speak to the home
  backend, or to --on's. A hold is 0.7 or 70%; --usd is what one 5-hour window is worth in
  Claude dollars, for the estimate from the ledger, and none clears it`;

const pct = (share: number): string => `${Math.round(share * 100)}%`;

/** "5h 32% · resets 15:00", "week 61% · resets Thu", "5h 40%", "5h no reading" */
export function windowLine(name: "5h" | "week", w: Window | null, now: number): string {
  if (w === null) return `${name} no reading`;
  return w.resetsAt === null ? `${name} ${pct(w.used)}` : `${name} ${pct(w.used)} · resets ${resetWord(w.resetsAt, now)}`;
}

const sourceWord = (c: Capacity): string =>
  c.source === "endpoint" ? "read from the usage endpoint" : c.source === "observed" ? "observed from the ledger" : "no reading";

/** One backend's answer as lines: a line per harness, its hit under it, the
 *  held starts and the thresholds. `paint` colours a harness's line. */
export function capacityLines(name: string, info: CapacityInfo, now: number, paint: (tone: "moss" | "lichen" | "rust", text: string) => string = (_t, text) => text): string[] {
  const out = [bold(name)];
  const s = info.settings;
  for (const c of info.capacity) {
    const standing = hitStands(c.hit, now) ? c.hit : null;
    const windows = c.source === "unknown" && !standing ? "no reading" : `${windowLine("5h", c.fiveHour, now)}   ${windowLine("week", c.weekly, now)}`;
    const used = c.fiveHour?.used ?? 0;
    const tone = standing || used >= s.normalHold ? "rust" : used >= s.lowHold || (c.weekly?.used ?? 0) >= s.weeklyLowHold ? "lichen" : "moss";
    out.push(`  ${c.harness.padEnd(7)} ${paint(tone, windows)}  ${dim(`(${sourceWord(c)})`)}`);
    if (standing) out.push(`          limit hit, resets ${resetWord(standing.resetsAt, now)}: ${standing.text}`);
  }
  if (info.held.length > 0) {
    out.push(`  held for capacity: ${info.held.length}`);
    for (const h of info.held) out.push(`    ${h.id}  ${h.priority.padEnd(6)} ${h.what} (${h.repoId}): ${h.why}`);
  }
  out.push(dim(`  holds: low past ${pct(s.lowHold)}, normal past ${pct(s.normalHold)}, low past ${pct(s.weeklyLowHold)} of the week; ${s.observedFiveHourUsd === null ? "no observed dollar figure" : `$${s.observedFiveHourUsd} a 5-hour window`}`));
  return out;
}

/** A hold as written on the command line: 0.7 or 70%, else null. */
export function holdArg(v: string): number | null {
  const n = v.endsWith("%") ? Number(v.slice(0, -1)) / 100 : Number(v);
  return Number.isFinite(n) && n > 0 && n <= 1 ? n : null;
}

/** `set`'s flags as a settings patch, or what is wrong. */
export function parseSetArgs(argv: string[]): Partial<CapacitySettings> | string {
  const args = [...argv];
  const patch: Partial<CapacitySettings> = {};
  for (const [flag, key] of [["--low", "lowHold"], ["--normal", "normalHold"], ["--weekly", "weeklyLowHold"]] as const) {
    if (!args.includes(flag)) continue;
    const raw = take(args, flag);
    const n = raw === undefined ? null : holdArg(raw);
    if (n === null) return `${flag} needs a hold above 0 and at most 1 (0.7 or 70%)`;
    patch[key] = n;
  }
  if (args.includes("--usd")) {
    const raw = take(args, "--usd");
    if (raw === "none") patch.observedFiveHourUsd = null;
    else {
      const n = Number(raw);
      if (raw === undefined || !Number.isFinite(n) || n <= 0) return "--usd needs a dollar figure above 0, or none";
      patch.observedFiveHourUsd = n;
    }
  }
  if (args.length > 0) return `unknown words: ${args.join(" ")}`;
  if (Object.keys(patch).length === 0) return "name one of --low, --normal, --weekly or --usd";
  return patch;
}

const paintTone = (tone: "moss" | "lichen" | "rust", text: string): string =>
  tone === "rust" ? rust(text) : tone === "lichen" ? lichen(text) : moss(text);

export async function capacityCommand(argv: string[], { fail }: { fail: (msg: string) => never }): Promise<void> {
  const args = [...argv];
  const backendFlag = args.includes("--backend");
  const onFlag = args.includes("--on");
  const given = take(args, "--backend");
  const on = take(args, "--on");
  if (backendFlag && given === undefined) return fail("--backend needs a value");
  if (onFlag && on === undefined) return fail("--on needs a value");
  const asJson = has(args, "--json");
  const home = apiBase(given);
  const sub = args[0] && !args[0].startsWith("-") ? args.shift() : undefined;
  /** the home backend, or the one --on names */
  const one = async (): Promise<Target> => {
    if (on === undefined) return { name: "home", urls: [home] };
    const [t] = await backendTargets(home, { ...(given !== undefined ? { given } : {}), on }, fail);
    return t ?? fail(`no backend named ${on}`);
  };
  const call = async (t: Target, method: string, path: string, body?: unknown): Promise<CapacityInfo> => {
    try {
      return await ask<CapacityInfo>(t, method, path, body);
    } catch (err) {
      return fail(err instanceof Unreachable ? `${t.name} did not answer: ${err.message}` : errText(err));
    }
  };
  const show = (name: string, info: CapacityInfo): void => {
    if (asJson) console.log(JSON.stringify(info, null, 2));
    else for (const line of capacityLines(name, info, Date.now(), paintTone)) console.log(line);
  };

  if (sub === undefined || sub === "list") {
    if (args.length > 0) return fail(CAPACITY_USAGE);
    const targets = await backendTargets(home, { ...(given !== undefined ? { given } : {}), ...(on !== undefined ? { on } : {}) }, fail);
    const answers: Record<string, CapacityInfo> = {};
    for (const t of targets) {
      try {
        const info = await ask<CapacityInfo>(t, "GET", "/api/capacity");
        answers[t.name] = info;
        if (!asJson) for (const line of capacityLines(t.name, info, Date.now(), paintTone)) console.log(line);
      } catch (err) {
        if (!asJson) console.log(`${bold(t.name)}\n  ${dim(`no answer: ${errText(err)}`)}`);
      }
    }
    if (asJson) console.log(JSON.stringify(answers, null, 2));
    return;
  }
  if (sub === "read") {
    if (args.length > 0) return fail(CAPACITY_USAGE);
    const t = await one();
    show(t.name, await call(t, "POST", "/api/capacity/read", {}));
    return;
  }
  if (sub === "release") {
    const id = args.shift();
    if (!id || args.length > 0) return fail(CAPACITY_USAGE);
    const t = await one();
    const info = await call(t, "POST", "/api/capacity/release", { id });
    if (asJson) console.log(JSON.stringify(info, null, 2));
    else console.log(`${id} started as interactive; ${info.held.length} still held`);
    return;
  }
  if (sub === "set") {
    const patch = parseSetArgs(args);
    if (typeof patch === "string") return fail(patch);
    const t = await one();
    show(t.name, await call(t, "POST", "/api/capacity", patch));
    return;
  }
  return fail(CAPACITY_USAGE);
}
