// Holdout scenarios: test files kept outside every checkout, under
// <configDir>/scenarios/<repo key>/, that the landing queue runs after a
// repo's gates. A set is a folder of markdown files, one scenario each.
//
//   ---
//   name: checkout-flow        short name, the same rule as a gate name
//   kind: command              command (default) or judge
//   run: bun test "$SCENARIO_DIR/checkout.test.ts"   command only, optional
//   evidence: src/a.ts src/b.ts                      judge only, repo paths
//   ---
//   A judge scenario's story goes here.
//
// A command scenario without a run line runs the set's default. The repo
// may tune the set in .canopy/scenarios.json. This file is pure and
// browser-safe: no node or Bun imports, so the UI may import it.

import { GATE_NAME } from "./gatename";
import type { ScenarioResult } from "./types";
import { frontmatter } from "./workflow";

export const SCENARIOS_FILE = ".canopy/scenarios.json";
export const SCENARIO_DIR_VAR = "SCENARIO_DIR";
export const DEFAULT_RUN = 'bun test "$SCENARIO_DIR"';
export const MAX_TIMEOUT = 1800;

export interface Scenario {
  name: string;
  kind: "command" | "judge";
  /** the shell line; a command scenario without one runs the set's default */
  run?: string;
  /** judge only: files the judge reads from the worktree, paths inside the repo */
  evidence: string[];
  /** judge only: the story */
  body: string;
}

export interface ScenarioSet {
  /** in file name order */
  scenarios: Scenario[];
  /** files that could not be read, named with why (never a line of the file); a pass counts each as red */
  errors: { file: string; error: string }[];
}

export interface ScenarioSettings {
  run: string;
  judge: "jev" | "off";
  minimum: number;
  /** seconds */
  timeout: number;
}

export const DEFAULT_SETTINGS: ScenarioSettings = { run: DEFAULT_RUN, judge: "jev", minimum: 1, timeout: 600 };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export function parseScenario(file: string, text: string): Scenario | { error: string } {
  let fm: { keys: Map<string, string>; body: string };
  try {
    fm = frontmatter(text);
  } catch (err) {
    // the parser's message may quote a line of the file; name the problem, never the text
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.startsWith("no frontmatter")) return { error: `${file}: no frontmatter: the file must start with a --- block` };
    if (msg.startsWith("frontmatter never closes")) return { error: `${file}: frontmatter never closes: no second --- line` };
    return { error: `${file}: frontmatter line is not key: value` };
  }
  const { keys } = fm;
  const name = keys.get("name");
  if (name === undefined || !GATE_NAME.test(name)) {
    return { error: `${file}: name must be a short name of letters, digits, dots, dashes or underscores` };
  }
  const k = keys.get("kind") || "command";
  if (k !== "command" && k !== "judge") return { error: `${file}: kind must be command or judge` };
  const run = keys.get("run") || "";
  if (run.includes("CANOPY_")) return { error: `${file}: run must not name a CANOPY_ variable` };
  const evidence = (keys.get("evidence") ?? "").split(/\s+/).filter(Boolean);
  if (evidence.length > 0 && k !== "judge") return { error: `${file}: evidence is only read by kind: judge` };
  for (const p of evidence) {
    if (p.startsWith("/") || p.split("/").includes("..")) {
      return { error: `${file}: evidence must be paths inside the repo` };
    }
  }
  const body = fm.body.trim();
  if (k === "judge" && body === "") return { error: `${file}: a judge scenario needs a story below the frontmatter` };
  return { name, kind: k, ...(run ? { run } : {}), evidence, body };
}

export function parseScenarioSet(files: readonly { file: string; text: string }[]): ScenarioSet {
  const sorted = [...files].sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
  const scenarios: Scenario[] = [];
  const errors: ScenarioSet["errors"] = [];
  const seen = new Map<string, string>();
  for (const { file, text } of sorted) {
    const parsed = parseScenario(file, text);
    if ("error" in parsed) {
      errors.push({ file, error: parsed.error });
      continue;
    }
    const first = seen.get(parsed.name);
    if (first !== undefined) {
      errors.push({ file, error: `${file}: a scenario named ${parsed.name} is in ${first} already` });
      continue;
    }
    seen.set(parsed.name, file);
    scenarios.push(parsed);
  }
  return { scenarios, errors };
}

export function parseScenariosFile(text: string): ScenarioSettings | { error: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    return { error: `${SCENARIOS_FILE} is not JSON: ${String(err instanceof Error ? err.message : err)}` };
  }
  if (!isRecord(raw)) return { error: `${SCENARIOS_FILE} must be an object` };
  const out: ScenarioSettings = { ...DEFAULT_SETTINGS };
  const run = raw["run"];
  if (run !== undefined) {
    if (typeof run !== "string" || !run.trim()) return { error: `${SCENARIOS_FILE}: run must be a shell line` };
    if (run.includes("CANOPY_")) return { error: `${SCENARIOS_FILE}: run must not name a CANOPY_ variable` };
    out.run = run.trim();
  }
  const judge = raw["judge"];
  if (judge !== undefined) {
    if (judge !== "jev" && judge !== "off") return { error: `${SCENARIOS_FILE}: judge must be jev or off` };
    out.judge = judge;
  }
  const minimum = raw["minimum"];
  if (minimum !== undefined) {
    if (typeof minimum !== "number" || !(minimum >= 0 && minimum <= 1)) {
      return { error: `${SCENARIOS_FILE}: minimum must be a number from 0 to 1` };
    }
    out.minimum = minimum;
  }
  const timeout = raw["timeout"];
  if (timeout !== undefined) {
    if (typeof timeout !== "number" || !Number.isInteger(timeout) || timeout < 1) {
      return { error: `${SCENARIOS_FILE}: timeout must be a positive whole number of seconds` };
    }
    if (timeout > MAX_TIMEOUT) return { error: `${SCENARIOS_FILE}: timeout must be at most ${MAX_TIMEOUT} seconds` };
    out.timeout = timeout;
  }
  return out;
}

/** the file `canopy scenarios add` writes */
export function scenarioTemplate(name: string, kind: Scenario["kind"], run?: string): string {
  const head = `---\nname: ${name}\nkind: ${kind}\n${run ? `run: ${run}\n` : ""}---\n`;
  return kind === "judge" ? `${head}What a user does, and what they should see when it works.\n` : head;
}

/** the mean satisfaction over `total` scenarios; a result not run counts 0; 1 when total is 0 */
export function scoreOf(results: readonly ScenarioResult[], total: number = results.length): number {
  if (total <= 0) return 1;
  const sum = results.reduce((s, r) => s + (r.p ?? (r.ok ? 1 : 0)), 0);
  return sum / total;
}
