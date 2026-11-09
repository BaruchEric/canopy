/**
 * What is at work in a folder right now: a test run, a build, an agent's
 * tool call. A kept tree that follows its base asks this before it rebases
 * itself (server/branchtrees.ts), since a rebase swaps the files under
 * whatever is running there: a test runner then reads new test files
 * against the modules it loaded before, and fails tests that are not
 * broken.
 *
 * The work in a folder is every process sitting in it or under it (its
 * working folder, so a `cd tree && bun test` started from elsewhere counts)
 * and everything those started. Two things make it work to wait for:
 *
 * - a job by name (`jobWord`): a test run, a build, a type check, a lint
 *   or an install, read off the program and its first words. This is the
 *   sure one, since a suite that mostly waits on the git calls it starts
 *   uses a few percent of a core and would pass for idle (canopy's own:
 *   `bun test` at 4 to 8% on a Mac, measured 2026-11-09). A watcher or a
 *   dev server is no job: it stays up, and reloads when the files change.
 * - anything else that is busy: the processes together used `WORK_SHARE`
 *   of a core or more over `WORK_WINDOW`, which a build script does and a
 *   shell at its prompt, an agent waiting on its model or an MCP server
 *   does not.
 *
 * The backend's own git calls in the folder are left out, or reading a
 * tree's status would hold its sync.
 *
 * The names, the sums and the words are pure and tested; `treesAtWork`
 * reads the machine (Bun: `/proc` on Linux, `ps` and `lsof` on a Mac),
 * best effort: a table that cannot be read says nothing is at work.
 */
import { realpath } from "node:fs/promises";
import { macProcs } from "./agentscan";
import { exec } from "./exec";
import { lsofBin, parseLsofCwd } from "./ports";
import { linuxProcs, procCwd, type Proc } from "./procs";

/** the share of one core the work in a folder uses from which it is busy */
export const WORK_SHARE = 0.1;

/** how long the two readings are apart, in ms */
export const WORK_WINDOW = 1_500;

/** how long a process's words may get */
const WORD_MAX = 40;

/** whether `cwd` is the folder or sits under it */
export function inFolder(cwd: string, dir: string): boolean {
  const base = dir.endsWith("/") ? dir.slice(0, -1) : dir;
  return cwd !== "" && (cwd === base || cwd.startsWith(`${base}/`));
}

const baseName = (path: string): string => path.slice(path.lastIndexOf("/") + 1);

/** the program a process runs, without its folder */
const program = (p: Proc): string => baseName(p.comm ?? p.argv[0] ?? "");

/**
 * The processes at work in `dir`: the ones whose working folder is in it,
 * and everything under them. `own` is the backend's pid: its git calls,
 * and what those start, are its own reading of the folder and left out.
 */
export function workPids(procs: readonly Proc[], cwds: ReadonlyMap<number, string>, dir: string, own?: number): Set<number> {
  const kids = new Map<number, Proc[]>();
  for (const p of procs) {
    const list = kids.get(p.ppid);
    if (list) list.push(p);
    else kids.set(p.ppid, [p]);
  }
  const under = (roots: readonly Proc[], skip: ReadonlySet<number>): Set<number> => {
    const out = new Set<number>();
    const queue = [...roots];
    for (let p = queue.pop(); p; p = queue.pop()) {
      if (out.has(p.pid) || skip.has(p.pid)) continue;
      out.add(p.pid);
      for (const k of kids.get(p.pid) ?? []) queue.push(k);
    }
    return out;
  };
  const none = new Set<number>();
  const mine = own === undefined ? none : under((kids.get(own) ?? []).filter((p) => program(p) === "git"), none);
  return under(
    procs.filter((p) => inFolder(cwds.get(p.pid) ?? "", dir)),
    mine,
  );
}

/**
 * How much of a core the processes in `pids` used between two readings
 * `ms` apart, and the one that used most. The use is added up process by
 * process: what each used since the first reading, all of it for one that
 * started since (or whose pid was taken over). One that ended in between
 * takes its time with it and is missed.
 */
export function busiest(before: readonly Proc[], after: readonly Proc[], pids: ReadonlySet<number>, ms: number): { share: number; top: Proc | null } {
  if (ms <= 0) return { share: 0, top: null };
  const was = new Map(before.map((p) => [p.pid, p]));
  let used = 0;
  let most = 0;
  let top: Proc | null = null;
  for (const p of after) {
    if (!pids.has(p.pid) || p.cpuMs === undefined) continue;
    const prev = was.get(p.pid);
    // a pid taken over since the first reading is a new process
    const base = prev && prev.startedAt === p.startedAt ? (prev.cpuMs ?? 0) : 0;
    const mine = Math.max(0, p.cpuMs - base);
    used += mine;
    if (mine > most) {
      most = mine;
      top = p;
    }
  }
  return { share: used / ms, top };
}

/** A process in a few words, for saying what a tree waits on: its program
 *  and the first plain word after it ("bun test"). Flags are passed over,
 *  and a script handed in on the line (`sh -c …`) is not quoted. */
export function workWord(p: Proc): string {
  const name = program(p);
  if (!name) return `process ${p.pid}`;
  let word = "";
  for (const arg of p.argv.slice(1)) {
    if (arg === "-c" || arg === "-e" || arg === "--eval") break;
    if (arg.startsWith("-")) continue;
    if (/^[\w@.+/-]+$/.test(arg)) word = baseName(arg);
    break;
  }
  return (word ? `${name} ${word}` : name).slice(0, WORD_MAX);
}

/** programs that run a script or a tool handed to them: the job is what they run */
const RUNTIMES = new Set(["node", "bun", "deno", "python", "python3", "ruby", "tsx", "ts-node"]);
/** programs whose next word is the tool they fetch and run */
const RUNNERS = new Set(["bunx", "npx", "pnpx", "uvx", "pipx"]);
/** programs with verbs of their own, some of which are jobs */
const MANAGERS = new Set(["bun", "npm", "pnpm", "yarn", "deno", "cargo", "go", "uv", "pip", "pip3", "swift", "dotnet", "mix", "gradle", "zig"]);
/** a manager's verbs that end by themselves */
const VERBS = new Set(["test", "build", "check", "clippy", "vet", "install", "ci", "sync", "lint", "typecheck", "bench", "compile", "fmt"]);
/** a package script that ends by itself, by how its name starts (`test:e2e`) */
const SCRIPT = /^(test|build|lint|typecheck|check|ci|e2e|compile|bundle|verify)([:._-]|$)/;
/** tools that are a job whenever they run without watching */
const TOOLS = new Set(["tsc", "tsgo", "vue-tsc", "jest", "mocha", "ava", "pytest", "tox", "oxlint", "eslint", "prettier", "mypy", "pyright", "make", "cmake", "ninja", "rustc", "rollup", "esbuild", "tsup", "webpack", "xcodebuild"]);
/** tools that are a job only under these words; bare, they watch or serve */
const TOOL_VERBS: Readonly<Record<string, readonly string[]>> = {
  vitest: ["run", "bench"],
  vite: ["build"],
  next: ["build", "lint", "export"],
  playwright: ["test"],
  cypress: ["run"],
  turbo: ["run", "build", "test", "lint", "typecheck"],
  nx: ["run", "build", "test", "lint", "typecheck"],
  astro: ["build", "check"],
  biome: ["check", "lint", "format", "ci"],
  ruff: ["check", "format"],
  docker: ["build"],
  firebase: ["deploy"],
  vercel: ["build", "deploy"],
  convex: ["deploy"],
  wrangler: ["deploy"],
};
/** a flag that keeps any of them up, watching */
const WATCH = new Set(["--watch", "-w", "--watchAll", "--watch-all"]);
/** a tool's word under which it stays up */
const STAYS = new Set(["serve", "dev", "watch", "start", "preview", "ui"]);

/** a script's or a tool's name off its path: no folder, no script extension */
const toolName = (word: string): string => baseName(word).replace(/\.(m?js|cjs|ts|py|rb)$/, "");

/** the job a tool's words make, the tool first: "tsc", "vite build" */
function toolJob(words: readonly string[]): string | null {
  const [tool, verb] = words;
  if (!tool || (verb !== undefined && STAYS.has(verb))) return null;
  if (TOOLS.has(tool)) return tool;
  return verb !== undefined && TOOL_VERBS[tool]?.includes(verb) ? `${tool} ${verb}` : null;
}

/**
 * The job a process is, in words ("bun test", "vitest run", "tsc"), or null
 * for one that is none: a test run, a build, a check or an install is a
 * job, since it reads the tree and ends; a watcher, a dev server, a shell
 * and an agent are not. Read off the program and its first words past the
 * flags, through a runtime (`node …/vitest run`), a runner (`bunx oxlint`)
 * or a manager's `run`/`x` (`uv run pytest`). A name it does not know is no
 * job, and is left to the CPU reading.
 */
export function jobWord(p: Proc): string | null {
  if (p.argv.some((arg) => WATCH.has(arg))) return null;
  const name = program(p);
  const words = p.argv.slice(1).filter((arg) => !arg.startsWith("-"));
  const tools = words.map(toolName);
  if (RUNNERS.has(name)) return toolJob(tools);
  if (MANAGERS.has(name)) {
    const verb = words[0];
    if (verb === "run" || verb === "run-script") {
      const script = words[1];
      return script !== undefined && SCRIPT.test(script) ? `${name} run ${script}` : toolJob(tools.slice(1));
    }
    if (verb === "x" || verb === "exec" || verb === "dlx") return toolJob(tools.slice(1));
    if (verb !== undefined && (VERBS.has(verb) || SCRIPT.test(verb))) return `${name} ${verb}`;
  }
  return RUNTIMES.has(name) ? toolJob(tools) : MANAGERS.has(name) ? null : toolJob([name, ...tools]);
}

/** every process on this machine with its CPU time; none where it cannot be read */
async function table(platform: NodeJS.Platform): Promise<Proc[]> {
  if (platform === "linux") return linuxProcs();
  if (platform === "darwin") return macProcs().catch(() => []);
  return [];
}

/** each process's working folder, by pid, for the ones that can be read */
async function folders(procs: readonly Proc[], platform: NodeJS.Platform): Promise<Map<number, string>> {
  if (platform === "linux") {
    const read = await Promise.all(procs.map(async (p) => [p.pid, await procCwd(p.pid)] as const));
    return new Map(read.filter((e): e is readonly [number, string] => e[1] !== undefined));
  }
  if (platform !== "darwin") return new Map();
  const r = await exec([lsofBin(), "-a", "-d", "cwd", "-Fpn"], { timeoutMs: 5_000 }).catch(() => null);
  // a timed-out read cut back to whole lines, so half a line names no pid or folder
  return r ? parseLsofCwd(r.stdout.slice(0, r.stdout.lastIndexOf("\n") + 1)) : new Map();
}

export interface WorkOptions {
  /** how long the two readings are apart, in place of `WORK_WINDOW` */
  windowMs?: number;
  /** the share of a core that reads as busy, in place of `WORK_SHARE` */
  share?: number;
  /** the backend's pid, whose git calls do not count; this process by default */
  own?: number;
  platform?: NodeJS.Platform;
}

/**
 * The folders of `dirs` something is at work in, each with what in words:
 * the job running there by name ("bun test"), else what uses the most CPU
 * there when the folder's processes are busy. A job is found off one
 * reading of the process table; the CPU takes a second reading `windowMs`
 * later, made only for folders something sits in with no job among it.
 */
export async function treesAtWork(dirs: readonly string[], opts: WorkOptions = {}): Promise<Map<string, string>> {
  const { windowMs = WORK_WINDOW, share = WORK_SHARE, own = process.pid, platform = process.platform } = opts;
  const found = new Map<string, string>();
  if (dirs.length === 0) return found;
  const started = Date.now();
  const before = await table(platform);
  const cwds = await folders(before, platform);
  // a tree's folder as the process table spells it (a Mac's /tmp is /private/tmp)
  const real = await Promise.all(dirs.map(async (dir) => ({ dir, real: await realpath(dir).catch(() => dir) })));
  const sitting: typeof real = [];
  for (const d of real) {
    const pids = workPids(before, cwds, d.real, own);
    if (pids.size === 0) continue;
    const job = before.filter((p) => pids.has(p.pid)).map(jobWord).find((word) => word !== null);
    if (job) found.set(d.dir, job);
    else sitting.push(d);
  }
  if (sitting.length === 0) return found;
  await Bun.sleep(Math.max(0, windowMs - (Date.now() - started)));
  const after = await table(platform);
  const ms = Date.now() - started;
  for (const d of sitting) {
    // the folders are the first reading's: what started since is reached through its parent
    const { share: used, top } = busiest(before, after, workPids(after, cwds, d.real, own), ms);
    if (top && used >= share) found.set(d.dir, workWord(top));
  }
  return found;
}
