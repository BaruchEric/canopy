/** A repo's gates for the landing queue: `.canopy/gates.json` in the main
 *  checkout, else the `package.json` scripts named typecheck, lint, test and
 *  build that exist, run with `bun run`. Always read from the main
 *  checkout's folder, never from a run's branch, so a run cannot loosen the
 *  gates it is held to. */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

export interface Gate {
  name: string;
  /** one shell line, run in the run's worktree */
  run: string;
}

export interface Gates {
  gates: Gate[];
  /** a shell line run once when a worktree is made, and again after a
   *  rebase that changed the lockfile */
  setup?: string;
  /** where the list came from; `none` lands with no gates and says so */
  source: "file" | "package" | "none";
}

export const GATES_FILE = ".canopy/gates.json";
/** the package.json scripts used when the repo has no gates file, in order */
export const PACKAGE_GATES = ["typecheck", "lint", "test", "build"] as const;

const GATE_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,39}$/;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** `.canopy/gates.json`'s text as gates, or why it cannot be. */
export function parseGatesFile(text: string): { gates: Gate[]; setup?: string } | { error: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    return { error: `${GATES_FILE} is not JSON: ${String(err instanceof Error ? err.message : err)}` };
  }
  if (!isRecord(raw)) return { error: `${GATES_FILE} must be an object` };
  if (!Array.isArray(raw["gates"])) return { error: `${GATES_FILE} needs a gates list` };
  const gates: Gate[] = [];
  const seen = new Set<string>();
  for (const [i, g] of raw["gates"].entries()) {
    if (!isRecord(g)) return { error: `${GATES_FILE}: gate ${i + 1} must be an object` };
    const name = g["name"];
    const run = g["run"];
    if (typeof name !== "string" || !GATE_NAME.test(name)) return { error: `${GATES_FILE}: gate ${i + 1} needs a short name of letters, digits, dots, dashes or underscores` };
    if (typeof run !== "string" || !run.trim()) return { error: `${GATES_FILE}: gate ${name} needs a run line` };
    if (seen.has(name)) return { error: `${GATES_FILE}: two gates are named ${name}` };
    seen.add(name);
    gates.push({ name, run: run.trim() });
  }
  const setup = raw["setup"];
  if (setup !== undefined && (typeof setup !== "string" || !setup.trim())) return { error: `${GATES_FILE}: setup must be a shell line` };
  return typeof setup === "string" ? { gates, setup: setup.trim() } : { gates };
}

/** The gates `package.json`'s scripts give, in `PACKAGE_GATES` order. */
export function packageGates(text: string): Gate[] {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return [];
  }
  const scripts = isRecord(raw) && isRecord(raw["scripts"]) ? raw["scripts"] : {};
  return PACKAGE_GATES.filter((n) => typeof scripts[n] === "string").map((name) => ({ name, run: `bun run ${name}` }));
}

const readText = (path: string): Promise<string | null> => readFile(path, "utf8").catch(() => null);

/** The repo's gates as its main checkout holds them now. A gates file that
 *  is there but wrong throws, so the queue shows why rather than falling
 *  back to the package scripts. */
export async function readGates(mainPath: string): Promise<Gates> {
  const file = await readText(join(mainPath, GATES_FILE));
  if (file !== null) {
    const parsed = parseGatesFile(file);
    if ("error" in parsed) throw new Error(parsed.error);
    return { ...parsed, source: "file" };
  }
  const pkg = await readText(join(mainPath, "package.json"));
  const gates = pkg === null ? [] : packageGates(pkg);
  return gates.length > 0 ? { gates, source: "package" } : { gates: [], source: "none" };
}

/** The lockfiles whose change in a rebase runs `setup` again. */
export const LOCKFILES = ["bun.lock", "bun.lockb", "package-lock.json", "pnpm-lock.yaml", "yarn.lock", "Cargo.lock", "uv.lock", "poetry.lock", "Gemfile.lock", "go.sum"];

/** Whether any of the paths a rebase changed is a lockfile, at any depth. */
export const touchesLockfile = (paths: readonly string[]): boolean =>
  paths.some((p) => LOCKFILES.includes(p.split("/").pop() ?? ""));
