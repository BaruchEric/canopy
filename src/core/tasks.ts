/**
 * Tasks: a repo's named processes. This file is the pure half, and
 * browser-safe: names and validation, reading the manifests a repo already
 * has (package.json, Cargo.toml, a Makefile) into tasks, reading the repo's
 * own `.canopy/tasks.json`, and merging those with canopy's per-machine
 * overrides. The rest (backoff, status, log text, the sweep's decisions)
 * lands here in later steps. The Bun side is `taskrun.ts` and the server's
 * `tasks.ts`.
 */
import type { TaskDef, TaskFlags, TaskLogLine, TaskLogPage, TaskPatch, TaskRecord, TaskSource, TaskStatus } from "./types";

const TASK_NAME = /^[a-z0-9][a-z0-9._-]{0,39}$/;

export const isTaskName = (v: unknown): v is string => typeof v === "string" && TASK_NAME.test(v);

const FLAGS = ["dev", "keep", "withPanel", "hidden"] as const satisfies readonly (keyof TaskFlags)[];

/** why a cwd is refused, or null for one that stays inside the repo */
export function cwdError(cwd: string): string | null {
  if (cwd.startsWith("/")) return "cwd is relative to the repo root";
  if (cwd.split("/").some((seg) => seg === "..")) return "cwd stays inside the repo";
  return null;
}

/** One layer's word on a task, checked field by field; a string says what is wrong. */
export function normalizeTaskPatch(v: unknown): TaskPatch | string {
  if (!v || typeof v !== "object" || Array.isArray(v)) return "a task is an object";
  const o = v as Record<string, unknown>;
  if (!isTaskName(o["name"])) return `bad task name: ${JSON.stringify(o["name"])}`;
  const name = o["name"];
  const out: TaskPatch = { name };
  const cmd = o["cmd"];
  if (cmd !== undefined) {
    if (typeof cmd !== "string" || !cmd.trim() || /[\r\n]/.test(cmd)) return `${name}: cmd is one line`;
    out.cmd = cmd.trim();
  }
  const cwd = o["cwd"];
  if (cwd !== undefined) {
    if (typeof cwd !== "string") return `${name}: cwd is a folder name`;
    const dir = cwd.trim().replace(/^\.\/+/, "").replace(/\/+$/, "");
    if (dir && dir !== ".") {
      const err = cwdError(dir);
      if (err) return `${name}: ${err}`;
      out.cwd = dir;
    }
  }
  for (const f of FLAGS) {
    const flag = o[f];
    if (flag === undefined) continue;
    if (typeof flag !== "boolean") return `${name}: ${f} is true or false`;
    out[f] = flag;
  }
  return out;
}

/** `.canopy/tasks.json`: a list of patches; a bad entry is dropped with its reason */
export function parseTaskFile(text: string): { patches: TaskPatch[]; errors: string[] } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { patches: [], errors: [".canopy/tasks.json is not JSON"] };
  }
  if (!Array.isArray(raw)) return { patches: [], errors: [".canopy/tasks.json is a list of tasks"] };
  const patches: TaskPatch[] = [];
  const errors: string[] = [];
  for (const item of raw) {
    const p = normalizeTaskPatch(item);
    if (typeof p === "string") errors.push(p);
    else if (patches.some((x) => x.name === p.name)) errors.push(`${p.name}: named twice`);
    else patches.push(p);
  }
  return { patches, errors };
}

/* ---------- detection ---------- */

const quote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;
const PLAIN = /^[A-Za-z0-9_.:/@+-]+$/;

/** a manifest's own name for something, as a task name; null when nothing usable is left */
function taskNameOf(s: string): string | null {
  const n = s
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[^a-z0-9]+/, "")
    .slice(0, 40);
  return isTaskName(n) ? n : null;
}

const LIFECYCLE = new Set(["preinstall", "install", "postinstall", "prepare", "prepublish", "prepublishOnly", "prepack", "postpack", "dependencies"]);

/** package.json's scripts, each through bun; npm's lifecycle hooks and a
 *  pre/post hook of another script are not tasks of their own */
export function parseScripts(text: string): TaskDef[] {
  let pkg: unknown;
  try {
    pkg = JSON.parse(text);
  } catch {
    return [];
  }
  const scripts = pkg && typeof pkg === "object" ? (pkg as { scripts?: unknown }).scripts : undefined;
  if (!scripts || typeof scripts !== "object" || Array.isArray(scripts)) return [];
  const keys = Object.entries(scripts as Record<string, unknown>)
    .filter(([, v]) => typeof v === "string")
    .map(([k]) => k);
  const out: TaskDef[] = [];
  for (const key of keys) {
    if (LIFECYCLE.has(key)) continue;
    const hook = /^(?:pre|post)(.+)$/.exec(key);
    if (hook?.[1] && keys.includes(hook[1])) continue;
    const name = taskNameOf(key);
    if (!name || out.some((t) => t.name === name)) continue;
    out.push({ name, cmd: `bun run ${PLAIN.test(key) ? key : quote(key)}`, ...(key === "dev" ? { dev: true } : {}) });
  }
  return out;
}

/** Cargo.toml: build and test, and run for a package (a bare workspace has nothing to run) */
export function parseCargo(text: string): TaskDef[] {
  const pkg = /^\s*\[package\]/m.test(text);
  if (!pkg && !/^\s*\[workspace\]/m.test(text)) return [];
  const out: TaskDef[] = [
    { name: "build", cmd: "cargo build" },
    { name: "test", cmd: "cargo test" },
  ];
  if (pkg) out.push({ name: "run", cmd: "cargo run" });
  return out;
}

/** a Makefile's plain targets: not dotted, not pattern rules, not variables */
export function parseMakeTargets(text: string): TaskDef[] {
  const out: TaskDef[] = [];
  for (const line of text.split("\n")) {
    const m = /^([A-Za-z0-9][A-Za-z0-9._-]*)\s*:(?![=:])/.exec(line);
    const target = m?.[1];
    if (!target) continue;
    const name = taskNameOf(target);
    if (!name || out.some((t) => t.name === name)) continue;
    out.push({ name, cmd: `make ${target}` });
  }
  return out;
}

/** the files a repo's tasks are read from, by the key `TaskFiles` uses */
export const TASK_FILES = { pkg: "package.json", cargo: "Cargo.toml", make: "Makefile", repoFile: ".canopy/tasks.json" } as const;

export type TaskFiles = Partial<Record<keyof typeof TASK_FILES, string>>;

/** One `sh` line, run from the repo root, that prints each file that is
 *  there after a record separator and its name: one round trip for a repo
 *  on another host. */
export const TASK_FILES_SCRIPT = `for f in ${Object.values(TASK_FILES).join(" ")}; do if [ -f "$f" ]; then printf '\\036%s\\n' "$f"; cat "$f"; fi; done`;

/** reads what `TASK_FILES_SCRIPT` printed */
export function parseTaskFiles(out: string): TaskFiles {
  const files: TaskFiles = {};
  const byName = new Map<string, keyof typeof TASK_FILES>(
    (Object.keys(TASK_FILES) as (keyof typeof TASK_FILES)[]).map((k) => [TASK_FILES[k], k]),
  );
  for (const chunk of out.split("\x1e")) {
    const nl = chunk.indexOf("\n");
    if (nl === -1) continue;
    const key = byName.get(chunk.slice(0, nl));
    if (key) files[key] = chunk.slice(nl + 1);
  }
  return files;
}

/** every manifest's tasks, the first to use a name keeping it */
export function detectTasks(files: TaskFiles): TaskDef[] {
  const out: TaskDef[] = [];
  const all = [
    ...(files.pkg ? parseScripts(files.pkg) : []),
    ...(files.cargo ? parseCargo(files.cargo) : []),
    ...(files.make ? parseMakeTargets(files.make) : []),
  ];
  for (const t of all) if (!out.some((x) => x.name === t.name)) out.push(t);
  return out;
}

/* ---------- merge ---------- */

export interface MergedTask extends TaskDef {
  source: TaskSource;
  suggested?: { keep?: true; withPanel?: true };
}

type Acc = TaskPatch & { source: TaskSource; suggested?: { keep?: true; withPanel?: true } };

const AUTO = ["keep", "withPanel"] as const;

/**
 * Detected tasks, then the repo file, then canopy's per-machine overrides,
 * merged by name and field by field; each task says the highest layer that
 * spoke about it. A repo file that is not the user's (`own` false) cannot
 * turn on the flags that run something without a click; they come back as
 * `suggested` until canopy's layer answers them.
 */
export function mergeTasks(detected: TaskDef[], repo: TaskPatch[], canopy: TaskPatch[], own: boolean): { tasks: MergedTask[]; errors: string[] } {
  const order: string[] = [];
  const acc = new Map<string, Acc>();
  const layer = (list: readonly TaskPatch[], source: TaskSource) => {
    for (const p of list) {
      const prev = acc.get(p.name);
      if (!prev) order.push(p.name);
      const patch: TaskPatch = { ...p };
      let suggested = prev?.suggested;
      if (source === "repo" && !own) {
        for (const f of AUTO) {
          if (patch[f] === undefined) continue;
          if (patch[f]) suggested = { ...suggested, [f]: true };
          delete patch[f];
        }
      }
      acc.set(p.name, { ...prev, ...patch, source, ...(suggested ? { suggested } : {}) });
    }
  };
  layer(detected, "detected");
  layer(repo, "repo");
  layer(canopy, "canopy");

  const tasks: MergedTask[] = [];
  const errors: string[] = [];
  let dev: string | null = null;
  for (const name of order) {
    const { cmd, suggested, ...rest } = acc.get(name)!;
    if (!cmd) {
      errors.push(`${name}: no command`);
      continue;
    }
    const t: MergedTask = { ...rest, cmd };
    const left = suggested ? AUTO.filter((f) => suggested[f] && t[f] === undefined) : [];
    if (left.length) t.suggested = Object.fromEntries(left.map((f) => [f, true]));
    if (t.dev) {
      if (dev) {
        errors.push(`${name}: only one dev task; ${dev} is it`);
        delete t.dev;
      } else dev = name;
    }
    tasks.push(t);
  }
  return { tasks, errors };
}

/* ---------- timing ---------- */

export interface TaskTimings {
  /** how often the supervisor looks at tmux */
  tick: number;
  /** how long a stop waits after ^C before it kills the session */
  grace: number;
  /** how long a dead pane with nobody watching is kept */
  reap: number;
  /** how long up counts as a good run, resetting the failure count */
  uptime: number;
  /** how often the sweep runs */
  sweep: number;
  /** the first restart delay, doubled per failure */
  backoff: number;
  backoffCap: number;
  /** failures in a row before keep running gives up */
  giveUp: number;
  /** bytes a log reaches before it rotates */
  logCap: number;
  /** how long an unused log of a gone task is kept */
  logAge: number;
}

export const TASK_TIMINGS: TaskTimings = {
  tick: 2_000,
  grace: 5_000,
  reap: 60 * 60_000,
  uptime: 60_000,
  sweep: 60 * 60_000,
  backoff: 1_000,
  backoffCap: 60_000,
  giveUp: 5,
  logCap: 2 * 1024 * 1024,
  logAge: 7 * 86_400_000,
};

/** the wait before the n-th restart in a row (n from 1) */
export const nextDelay = (fails: number, base = TASK_TIMINGS.backoff, cap = TASK_TIMINGS.backoffCap): number =>
  Math.min(cap, base * 2 ** Math.max(0, fails - 1));

export interface StatusInput {
  /** a session is there */
  live: boolean;
  /** its pane has exited */
  dead: boolean;
  want: "running" | "stopped" | undefined;
  exitedAt?: number;
  exitCode?: number | null;
  retryAt?: number;
  gaveUp: boolean;
}

/** One word for what a task is doing. A task stopped by hand reads as
 *  exited whatever ^C made its code, since that is not a failure. */
export function taskStatus(o: StatusInput): TaskStatus {
  if (o.live && !o.dead) return "running";
  if (o.gaveUp) return "gave-up";
  if (o.retryAt !== undefined) return "backoff";
  if (o.exitedAt === undefined) return "idle";
  if (o.want === "stopped" || o.exitCode === 0) return "exited";
  return "failed";
}

/* ---------- log text ---------- */

/** the line canopy writes into a log ahead of each run */
export const startMark = (at: number, cmd: string): string => `--- started ${at} · ${cmd} ---`;
const MARK = /^--- started (\d+) · .* ---$/;

// CSI, OSC (ended by BEL or ST), and two-byte escapes
// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\x00-\x08\x0b-\x1f\x7f]/g;

/** A pty's bytes as the lines a person saw: escapes gone, and a line a
 *  progress bar rewrote with carriage returns reduced to its last state. */
export function plainLines(raw: string): string[] {
  const text = raw.replace(ANSI, "");
  const lines = text.split("\n").map((line) => {
    const cut = line.replace(/\r+$/, "");
    const last = cut.lastIndexOf("\r");
    return (last === -1 ? cut : cut.slice(last + 1)).replace(CONTROL, "");
  });
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

/** The last `limit` lines (of the matches, with `q`) before line `before`,
 *  each with the start of the run it belongs to. */
export function logPage(raw: string, opts: { q?: string; before?: number; limit?: number }): TaskLogPage {
  const q = opts.q?.trim().toLowerCase() ?? "";
  const limit = opts.limit ?? 500;
  let at: number | null = null;
  const all: TaskLogLine[] = [];
  plainLines(raw).forEach((text, i) => {
    const m = MARK.exec(text);
    if (m) at = Number(m[1]);
    const line: TaskLogLine = { n: i + 1, text, at, ...(m ? { mark: true as const } : {}) };
    if ((opts.before === undefined || line.n < opts.before) && (!q || text.toLowerCase().includes(q))) all.push(line);
  });
  return { lines: all.slice(-limit), more: all.length > limit };
}

/* ---------- desired state and the sweep ---------- */

/** `tasks/state.json`, with anything malformed left out */
export function parseTaskState(text: string): Record<string, TaskRecord> {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return {};
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, TaskRecord> = {};
  for (const [id, v] of Object.entries(raw)) {
    if (!/^[0-9a-f]{32}$/.test(id)) continue;
    if (!v || typeof v !== "object") continue;
    const r = v as Record<string, unknown>;
    if (typeof r["repoId"] !== "string" || typeof r["path"] !== "string" || !isTaskName(r["name"])) continue;
    if (r["want"] !== "running" && r["want"] !== "stopped") continue;
    const rec: TaskRecord = { repoId: r["repoId"], path: r["path"], name: r["name"], want: r["want"] };
    if (typeof r["startedAt"] === "number") rec.startedAt = r["startedAt"];
    if (typeof r["exitedAt"] === "number") rec.exitedAt = r["exitedAt"];
    if (typeof r["exitCode"] === "number" || r["exitCode"] === null) rec.exitCode = r["exitCode"] as number | null;
    out[id] = rec;
  }
  return out;
}

export interface LogFile {
  termId: string;
  /** ms */
  mtime: number;
}

/** whether a task still has a definition: null when that cannot be told (a repo on another host) */
export type Defined = (termId: string) => boolean | null;

/** a `Defined` over what was looked up: an id nobody looked up is gone, and null (cannot tell) stays null */
export const definedFrom = (known: ReadonlyMap<string, boolean | null>): Defined => (id) => (known.has(id) ? known.get(id)! : false);

/** logs of tasks with no session and no definition, untouched for `age` */
export function expiredTaskLogs(logs: readonly LogFile[], live: ReadonlySet<string>, defined: Defined, now: number, age: number): string[] {
  return logs.filter((l) => !live.has(l.termId) && defined(l.termId) === false && now - l.mtime > age).map((l) => l.termId);
}

/** a dead pane whose exit is on record, with nobody watching, dead longer than `reapMs` */
export const reapable = (p: { dead: boolean; exitedAt?: number; viewers: number }, now: number, reapMs: number): boolean =>
  p.dead && p.exitedAt !== undefined && p.viewers === 0 && now - p.exitedAt > reapMs;

/** records for tasks that are gone and have no session */
export function staleWants(state: Readonly<Record<string, TaskRecord>>, live: ReadonlySet<string>, defined: Defined): string[] {
  return Object.keys(state).filter((id) => !live.has(id) && defined(id) === false);
}
