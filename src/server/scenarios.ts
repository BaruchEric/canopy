/** The holdout scenarios: where a repo's set lives, the copy a pass hands a
 *  run as `SCENARIO_DIR`, and the pass itself. Bun-only. */
import { cp, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tail } from "../core/landing";
import { DEFAULT_SETTINGS, parseScenarioSet, parseScenariosFile, scoreOf, SCENARIOS_FILE } from "../core/scenario";
import type { Scenario, ScenarioSet, ScenarioSettings } from "../core/scenario";
import { configDir } from "../core/store";
import type { ScenarioResult, ScenarioRun } from "../core/types";
import { repoKey } from "../core/worktree";
import type { CheckOutcome } from "./landing";

const isMissing = (e: unknown): boolean => typeof e === "object" && e !== null && "code" in e && e.code === "ENOENT";

export const scenariosRoot = (): string => join(configDir(), "scenarios");

/** a repo's set folder under a root */
export const setDirOf = (root: string, repoPath: string): string => join(root, repoKey(repoPath));

/** every `*.md` in the set folder, parsed; a missing folder is an empty set */
export async function readScenarioSet(root: string, repoPath: string): Promise<ScenarioSet> {
  const dir = setDirOf(root, repoPath);
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (e) {
    if (isMissing(e)) return { scenarios: [], errors: [] };
    throw e;
  }
  const files = await Promise.all(
    names.filter((n) => n.endsWith(".md")).map(async (file) => ({ file, text: await readFile(join(dir, file), "utf8") })),
  );
  return parseScenarioSet(files);
}

/** `.canopy/scenarios.json` in the main checkout, or the defaults; throws on a file that is there but wrong, like `readGates` */
export async function readScenarioSettings(mainPath: string): Promise<ScenarioSettings> {
  const text = await readFile(join(mainPath, SCENARIOS_FILE), "utf8").catch((e: unknown) => {
    if (isMissing(e)) return null;
    throw e;
  });
  if (text === null) return DEFAULT_SETTINGS;
  const parsed = parseScenariosFile(text);
  if ("error" in parsed) throw new Error(parsed.error);
  return parsed;
}

/** the set folder copied to a fresh temp dir (`canopy-scenarios-` under tmpdir) */
export async function copySet(dir: string): Promise<string> {
  const copy = await mkdtemp(join(tmpdir(), "canopy-scenarios-"));
  try {
    await cp(dir, copy, { recursive: true });
  } catch (e) {
    await rm(copy, { recursive: true, force: true });
    throw e;
  }
  return copy;
}

export type ScenarioRunner = (cwd: string, line: string, setDir: string, timeoutMs: number) => Promise<CheckOutcome>;

export interface ScenarioPass {
  /** the worktree the lines run in */
  dir: string;
  /** the set folder on disk, copied before the first line runs */
  setDir: string;
  set: ScenarioSet;
  settings: ScenarioSettings;
  run: ScenarioRunner;
  head: string;
  now: number;
  /** after each scenario, with the next one's name or null */
  onDone?: (r: ScenarioResult, next: string | null) => void;
}

/** Runs the set's command scenarios in order and stops at the first red.
 *  A file in `errors` is a red result named by the file, listed first, and
 *  nothing runs after it. Judge scenarios are left out in plan 1. */
export async function runScenarioSet(p: ScenarioPass): Promise<ScenarioRun> {
  const commands: Scenario[] = p.set.scenarios.filter((s) => s.kind === "command");
  const results: ScenarioResult[] = p.set.errors.map((e) => ({ name: e.file, kind: "command", ok: false, tail: e.error }));
  const total = p.set.errors.length + commands.length;
  if (results.length > 0) return { head: p.head, at: p.now, total, passed: 0, score: scoreOf(results, total), results };

  let passed = 0;
  const copy = await copySet(p.setDir);
  try {
    for (const [i, s] of commands.entries()) {
      const r = await p.run(p.dir, s.run ?? p.settings.run, copy, p.settings.timeout * 1000);
      const result: ScenarioResult = {
        name: s.name,
        kind: "command",
        ok: r.exit === 0,
        tail: tail(r.output || `exited ${r.exit ?? "on a signal"}`),
      };
      results.push(result);
      if (result.ok) passed++;
      p.onDone?.(result, commands[i + 1]?.name ?? null);
      if (!result.ok) break;
    }
  } finally {
    await rm(copy, { recursive: true, force: true });
  }
  return { head: p.head, at: p.now, total: commands.length, passed, score: scoreOf(results, total), results };
}
