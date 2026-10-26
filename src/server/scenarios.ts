/** The holdout scenarios: where a repo's set lives, the copy a pass hands a
 *  run as `SCENARIO_DIR`, and the pass itself. Bun-only. */
import { cp, mkdir, mkdtemp, readdir, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GATE_NAME } from "../core/gatename";
import { parseLocator } from "../core/host";
import { tail } from "../core/landing";
import { DEFAULT_SETTINGS, parseScenario, parseScenarioSet, parseScenariosFile, scenarioTemplate, scoreOf, SCENARIOS_FILE } from "../core/scenario";
import type { Scenario, ScenarioSet, ScenarioSettings } from "../core/scenario";
import { configDir } from "../core/store";
import type { Repo, ScenarioResult, ScenarioRun } from "../core/types";
import { repoKey, revOf } from "../core/worktree";
import type { CheckOutcome } from "./landing";

const codeOf = (e: unknown): unknown => (typeof e === "object" && e !== null && "code" in e ? e.code : undefined);
const isMissing = (e: unknown): boolean => codeOf(e) === "ENOENT";

export const scenariosRoot = (): string => join(configDir(), "scenarios");

/** a repo's set folder under a root */
export const setDirOf = (root: string, repoPath: string): string => join(root, repoKey(repoPath));

/** every `*.md` in the set folder with its text as written; a missing folder has none */
async function readSetFiles(root: string, repoPath: string): Promise<{ file: string; text: string }[]> {
  const dir = setDirOf(root, repoPath);
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (e) {
    if (isMissing(e)) return [];
    throw e;
  }
  return Promise.all(names.filter((n) => n.endsWith(".md")).map(async (file) => ({ file, text: await readFile(join(dir, file), "utf8") })));
}

/** every `*.md` in the set folder, parsed; a missing folder is an empty set */
export async function readScenarioSet(root: string, repoPath: string): Promise<ScenarioSet> {
  return parseScenarioSet(await readSetFiles(root, repoPath));
}

/** `.canopy/scenarios.json` in the main checkout, or the defaults; throws on a file that is there but wrong, like `readGates` */
export async function readScenarioSettings(mainPath: string): Promise<ScenarioSettings> {
  const text = await readFile(join(mainPath, SCENARIOS_FILE), "utf8").catch((e: unknown) => {
    if (isMissing(e)) return null;
    throw e;
  });
  if (text === null) return { ...DEFAULT_SETTINGS };
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
  // nothing to run: no copy, so a repo with no set folder never reaches cp
  if (commands.length === 0) return { head: p.head, at: p.now, total: 0, passed: 0, score: 1, results: [] };

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

export interface ScenarioDeps {
  root: string;
  /** the scan's repo by id */
  repo: (id: string) => Repo | undefined;
  /** a branch run's worktree by the run's id, else undefined */
  runDir: (run: string) => string | undefined;
  run: ScenarioRunner;
  now?: () => number;
}

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err));
const BAD_NAME = "name must be a short name of letters, digits, dots, dashes or underscores";

/** The routes under /api/scenarios: the set's files, their names, adding and
 *  removing one, and a pass on demand against main or a branch run. */
export class Scenarios {
  constructor(private readonly deps: ScenarioDeps) {}

  /** the repo a request names, or the answer that refuses it */
  private repoFor(id: unknown): Repo | Response {
    if (typeof id !== "string" || id === "") return json({ error: "repo is required" }, 400);
    const repo = this.deps.repo(id);
    if (!repo) return json({ error: "no repo by that id" }, 404);
    if (parseLocator(repo.path).host !== null) return json({ error: "scenarios run only for a repo on this backend" }, 400);
    return repo;
  }

  /** null for a path outside /api/scenarios */
  async handle(req: Request, url: URL): Promise<Response | null> {
    const path = url.pathname;
    if (path !== "/api/scenarios" && !path.startsWith("/api/scenarios/")) return null;
    try {
      if (req.method === "GET" || req.method === "DELETE") {
        const repo = this.repoFor(url.searchParams.get("repo"));
        if (repo instanceof Response) return repo;
        if (req.method === "GET" && path === "/api/scenarios") return json(await this.list(repo));
        if (req.method === "GET" && path === "/api/scenarios/names") {
          const set = await readScenarioSet(this.deps.root, repo.path);
          return json({ names: set.scenarios.map((s) => ({ name: s.name, kind: s.kind })), errors: set.errors });
        }
        if (req.method === "DELETE" && path === "/api/scenarios") return await this.remove(repo, url.searchParams.get("name"));
        return json({ error: "not found" }, 404);
      }
      if (req.method !== "POST" || (path !== "/api/scenarios" && path !== "/api/scenarios/run")) return json({ error: "not found" }, 404);
      const body: unknown = await req.json().catch(() => null);
      if (!isRecord(body)) return json({ error: "malformed body" }, 400);
      const repo = this.repoFor(body["repo"]);
      if (repo instanceof Response) return repo;
      if (path === "/api/scenarios") return await this.add(repo, body);
      return await this.pass(repo, body["run"]);
    } catch (err) {
      return json({ error: errText(err) }, 500);
    }
  }

  /** every file's scenario with its text as written, and the files that do not read */
  private async list(repo: Repo) {
    const files = await readSetFiles(this.deps.root, repo.path);
    const set = parseScenarioSet(files);
    // the set keeps the first file in name order for a name; so does this
    const textOf = new Map<string, string>();
    for (const { file, text } of [...files].sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0))) {
      const parsed = parseScenario(file, text);
      if (!("error" in parsed) && !textOf.has(parsed.name)) textOf.set(parsed.name, text);
    }
    return {
      dir: setDirOf(this.deps.root, repo.path),
      scenarios: set.scenarios.map((s) => ({ name: s.name, kind: s.kind, ...(s.run ? { run: s.run } : {}), text: textOf.get(s.name) ?? "" })),
      errors: set.errors,
    };
  }

  private async add(repo: Repo, body: Record<string, unknown>): Promise<Response> {
    const name = body["name"];
    if (typeof name !== "string" || !GATE_NAME.test(name)) return json({ error: BAD_NAME }, 400);
    const kind = body["kind"] ?? "command";
    if (kind !== "command" && kind !== "judge") return json({ error: "kind must be command or judge" }, 400);
    const run = body["run"];
    // one line, so a run cannot write a second frontmatter key
    if (run !== undefined && (typeof run !== "string" || /[\r\n]/.test(run))) return json({ error: "run must be one line" }, 400);
    const dir = setDirOf(this.deps.root, repo.path);
    const file = join(dir, `${name}.md`);
    await mkdir(dir, { recursive: true });
    try {
      await writeFile(file, scenarioTemplate(name, kind, run), { flag: "wx" });
    } catch (e) {
      if (codeOf(e) === "EEXIST") return json({ error: `a scenario named ${name} is there already` }, 409);
      throw e;
    }
    return json({ path: file }, 201);
  }

  private async remove(repo: Repo, name: string | null): Promise<Response> {
    if (name === null || !GATE_NAME.test(name)) return json({ error: BAD_NAME }, 400);
    try {
      await unlink(join(setDirOf(this.deps.root, repo.path), `${name}.md`));
    } catch (e) {
      if (isMissing(e)) return json({ error: `no scenario named ${name}` }, 404);
      throw e;
    }
    return json({ ok: true });
  }

  /** a pass against a branch run's worktree when `run` names one, else the main checkout */
  private async pass(repo: Repo, run: unknown): Promise<Response> {
    if (run !== undefined && typeof run !== "string") return json({ error: "run must be a branch run's id" }, 400);
    let dir = repo.path;
    if (run !== undefined) {
      const found = this.deps.runDir(run);
      if (found === undefined) return json({ error: "no branch run by that id" }, 404);
      dir = found;
    }
    let settings: ScenarioSettings;
    try {
      settings = await readScenarioSettings(repo.path);
    } catch (e) {
      return json({ error: errText(e) }, 409);
    }
    const set = await readScenarioSet(this.deps.root, repo.path);
    // a folder with no git, or no folder at all, has no head; the pass still runs
    const head = (await revOf(dir, "HEAD").catch(() => null)) ?? "";
    const now = (this.deps.now ?? Date.now)();
    return json(await runScenarioSet({ dir, setDir: setDirOf(this.deps.root, repo.path), set, settings, run: this.deps.run, head, now }));
  }
}
