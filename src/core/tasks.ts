/**
 * Tasks: a repo's named processes. This file is the pure half, and
 * browser-safe: names and validation, reading the manifests a repo already
 * has (package.json, Cargo.toml, a Makefile) into tasks, reading the repo's
 * own `.canopy/tasks.json`, and merging those with canopy's per-machine
 * overrides. The rest (backoff, status, log text, the sweep's decisions)
 * lands here in later steps. The Bun side is `taskrun.ts` and the server's
 * `tasks.ts`.
 */
import type { TaskDef, TaskFlags, TaskPatch, TaskSource } from "./types";

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
