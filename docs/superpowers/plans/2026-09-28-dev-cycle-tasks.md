# Tasks Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A repo's named processes (dev, test, typecheck, build) that canopy starts, stops, restarts and supervises on tmux, each with a joinable terminal and a log on disk, shown in a panel section, a card chip, a top bar chip and the feed.

**Architecture:** Pure definitions and decisions in `src/core/tasks.ts` (browser-safe). Bun-side file and tmux work in `src/core/taskrun.ts` plus new argv builders in `src/core/tmux.ts`. A `TaskHub` class in `src/server/tasks.ts` owns the routes, the 2 s supervisor and the hourly sweep, wired into `src/server/index.ts` the way `ChanHub` is. A task is a tmux session named like a shell (`canopy-<termId>`), so the existing `/api/term?attach=1` websocket joins it. The UI adds a `tasks` panel section, chips, a feed kind and an edit sheet.

**Tech Stack:** Bun + TypeScript (strict), tmux 3.x, React 19 + Zustand, xterm.js 6, `bun test`, oxlint, Vite.

**Spec:** `docs/superpowers/specs/2026-09-28-dev-cycle-tasks-design.md`

## Global Constraints

- Gates before anything is called done: `bun run typecheck && bun run lint && bun test && bun run build`.
- `src/core/tasks.ts` and `src/core/types.ts` stay browser-safe: no `node:*` or Bun imports.
- Task names match `^[a-z0-9][a-z0-9._-]{0,39}$`.
- Detected npm scripts always run as `bun run <script>`.
- Supervisor tick 2 s; stop grace 5 s; backoff 1, 2, 4, 8, 16, 32 then 60 s; give up after 5 consecutive failures; failure count resets after 60 s up; dead session reaped after 1 h with no viewers; sweep hourly; logs rotate at 2 MB keeping one old file; unused logs expire after 7 days.
- `keep` and `withPanel` from `.canopy/tasks.json` apply only when `accessFromUrls(...)` answers `"ok"` for the repo; elsewhere they are `suggested`.
- The sweep never kills a live process.
- Logs live flat at `<config dir>/tasks/logs/<termId>.log` (and `.log.1`); desired state at `<config dir>/tasks/state.json`. This refines the spec's per-repo folder: the termId already hashes the repo path and task name.
- The log route always returns ANSI-stripped plain lines; the start marker is `--- started <epoch ms> · <cmd> ---`, formatted to local time by the UI.
- Prose (comments, docs, UI copy, commit messages) follows the unslop rules: no em dashes, sentence case, plain words. No backticks in commit messages.
- Commit after each task. Never push.

## Review Focus

1. **A command with quotes, `&&` or `$`** (`echo 'a b' && echo "$HOME"`) must run exactly as typed, through two layers of shell quoting (tmux's command string and `sh -lc`). Test in Task 5.
2. **Two browsers pressing start at the same moment** must start one process; the second gets 409. Test in Task 6.
3. **A command that exits at once** (`echo quick; exit 3`) must still leave its output in the log and exit code 3 in the task, even though it died before the first supervisor tick. Test in Task 6.
4. **A flooding task crossing the rotation size mid-write** must keep logging into the new file after rotation. Test in Task 8.
5. **Canopy restarting while a keep task is dead or in backoff** must restart it once canopy is back (the retry timer lived in memory). Test in Task 7.

---

## File structure

| File | Responsibility |
|---|---|
| `src/core/types.ts` (modify) | `TaskDef`, `TaskPatch`, `TaskInfo`, `TaskRecord`, log shapes, `TermInfo.task`, `CanopyConfig.tasks`, the `tasks` server event |
| `src/core/tasks.ts` (create) | Pure: names, validation, detection parsers, repo file parsing, merge, backoff, status, log text, sweep decisions |
| `src/core/store.ts` (modify) | `tasks` in the config, `setTask`, `tasksFor` |
| `src/core/tmux.ts` (modify) | `@canopy_task` in the list format; task session, pipe, respawn, interrupt and pane-list builders; `taskCommand` |
| `src/core/taskrun.ts` (create) | Bun: `taskTermId`, reading task files, state.json, log files |
| `src/server/tasks.ts` (create) | `TaskHub`: routes, start/stop/restart, supervisor, recovery, sweep |
| `src/server/tailchan.ts` (modify) | `onTaskGaveUp` |
| `src/server/index.ts` (modify) | Wiring; shells skip task sessions |
| `ui/src/tasks.ts` (create) | Pure UI words: status, chip, when, feed lines |
| `ui/src/api.ts`, `ui/src/qualify.ts`, `ui/src/store.ts`, `ui/src/feed.ts` (modify) | Data flow for tasks |
| `ui/src/surface.ts`, `ui/src/term.ts`, `ui/src/routes.ts` (modify) | `tasks` section key, `TermTab.task`, `task=` route |
| `ui/src/components/Tasks.tsx` (create) | The section and log view, `TaskChip`, `TasksChip`; a task's terminal opens as a panel shells tab |
| `ui/src/components/Dock.tsx`, `RunSheet.tsx`, `TermDock.tsx`, `RepoGrid.tsx`, `TopBar.tsx`, `Preview.tsx`, `Feed.tsx` (modify) | Placement |
| `ui/src/styles.css` (modify) | Section and chip styles |
| `CLAUDE.md` (modify) | Architecture notes for tasks |

---

### Task 1: Types, validation, detection and merge (pure)

**Files:**
- Modify: `src/core/types.ts`
- Create: `src/core/tasks.ts`
- Create: `src/core/tasks.test.ts`
- Modify: `ui/src/qualify.ts` (event pass-through so typecheck stays green)
- Modify: `ui/src/feed.ts` (event case so typecheck stays green)

**Interfaces:**
- Produces (types.ts): `TaskSource`, `TaskStatus`, `TaskFlags`, `TaskDef`, `TaskPatch`, `TaskInfo`, `TasksResult`, `TaskAction`, `TaskRecord`, `TaskLogLine`, `TaskLogPage`; `TermInfo.task?: string`; `CanopyConfig.tasks: Record<string, TaskPatch[]>`; `ServerEvent` member `{ type: "tasks"; repoId: string; tasks: TaskInfo[] }`.
- Produces (tasks.ts): `isTaskName(v): v is string`, `cwdError(cwd): string | null`, `normalizeTaskPatch(v): TaskPatch | string`, `parseTaskFile(text): { patches: TaskPatch[]; errors: string[] }`, `parseScripts(text): TaskDef[]`, `parseCargo(text): TaskDef[]`, `parseMakeTargets(text): TaskDef[]`, `TASK_FILES`, `TaskFiles`, `TASK_FILES_SCRIPT`, `parseTaskFiles(out): TaskFiles`, `detectTasks(files): TaskDef[]`, `MergedTask`, `mergeTasks(detected, repo, canopy, own): { tasks: MergedTask[]; errors: string[] }`.

- [ ] **Step 1: Add the types**

Append to `src/core/types.ts` (near the shells types, after `TermInfo`):

```ts
/* ---------- tasks: a repo's named processes (core/tasks, server/tasks) ---------- */

/** which layer last said something about a task */
export type TaskSource = "detected" | "repo" | "canopy";

export type TaskStatus = "idle" | "running" | "exited" | "failed" | "backoff" | "gave-up";

export interface TaskFlags {
  /** the task the preview pairs with; one per repo */
  dev?: boolean;
  /** restarted when it fails and after the backend comes back */
  keep?: boolean;
  /** started when the repo's panel opens */
  withPanel?: boolean;
  /** left out of the list (a detected task you do not want) */
  hidden?: boolean;
}

/** a whole task, as detection or a merge produces it */
export interface TaskDef extends TaskFlags {
  name: string;
  /** one shell line, run from the repo root or `cwd` */
  cmd: string;
  /** relative to the repo root, never outside it */
  cwd?: string;
}

/** what one layer says about a task: a repo file or canopy's config may set
 *  only some fields of a task another layer defined */
export interface TaskPatch extends TaskFlags {
  name: string;
  cmd?: string;
  cwd?: string;
}

/** one task as the browser reads it: its merged definition and what it is doing */
export interface TaskInfo extends TaskDef {
  repoId: string;
  source: TaskSource;
  /** auto flags a repo file asked for that were not applied, since the repo is not the user's */
  suggested?: { keep?: true; withPanel?: true };
  /** the tmux session's id, 32 hex digits; the shell socket joins it */
  termId: string;
  status: TaskStatus;
  /** a session is there to join (running, or a dead pane not yet reaped) */
  live: boolean;
  startedAt?: number;
  exitedAt?: number;
  exitCode?: number | null;
  /** when a keep task is due to be started again */
  retryAt?: number;
  /** restarts by keep running since the last manual start */
  restarts: number;
  viewers: string[];
  /** a task still running whose definition or repo is gone */
  gone?: "definition" | "repo";
}

export interface TasksResult {
  tasks: TaskInfo[];
  /** what was wrong with `.canopy/tasks.json` or the merge */
  errors: string[];
}

export type TaskAction = "start" | "stop" | "restart";

/** what `tasks/state.json` keeps per task, by termId */
export interface TaskRecord {
  repoId: string;
  path: string;
  name: string;
  want: "running" | "stopped";
  startedAt?: number;
  exitedAt?: number;
  exitCode?: number | null;
}

export interface TaskLogLine {
  /** the line's number across the old and current log, from 1 */
  n: number;
  text: string;
  /** when the run this line belongs to started, ms; null before any marker */
  at: number | null;
  /** a start marker line */
  mark?: true;
}

export interface TaskLogPage {
  lines: TaskLogLine[];
  /** earlier lines match too */
  more: boolean;
}
```

In `TermInfo`, after `handle?: string;` add:

```ts
  /** the task this session runs, for a task's session; never set on a shell */
  task?: string;
```

In `CanopyConfig`, after `launchers`, add:

```ts
  /** per-machine task overrides by repo path (core/tasks) */
  tasks: Record<string, TaskPatch[]>;
```

In `ServerEvent`, before the `chan` member, add:

```ts
  /** a repo's tasks, whenever one starts, stops, dies, is edited or a viewer comes or goes */
  | { type: "tasks"; repoId: string; tasks: TaskInfo[] }
```

- [ ] **Step 2: Keep the exhaustive switches compiling**

In `ui/src/qualify.ts` add near `qJob`:

```ts
export const qTask = (q: Q, t: TaskInfo): TaskInfo => ({ ...t, repoId: q(t.repoId), termId: q(t.termId) });
```

(import `TaskInfo` from types) and in `qEvent` add:

```ts
    case "tasks":
      return { ...ev, repoId: q(ev.repoId), tasks: ev.tasks.map((t) => qTask(q, t)) };
```

In `ui/src/feed.ts` `describeEvent`, before `case "chan":` add (Task 10 replaces it):

```ts
    case "tasks":
      return [];
```

In `src/core/store.ts` `defaults()` add `tasks: {},` and in `normalize` add `tasks: {},` for now (Task 3 replaces it). Run `bun run typecheck`; expected: PASS.

- [ ] **Step 3: Write the failing tests**

Create `src/core/tasks.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import {
  cwdError,
  detectTasks,
  isTaskName,
  mergeTasks,
  normalizeTaskPatch,
  parseCargo,
  parseMakeTargets,
  parseScripts,
  parseTaskFile,
  parseTaskFiles,
} from "./tasks";

describe("names and patches", () => {
  test("task names", () => {
    expect(isTaskName("dev")).toBe(true);
    expect(isTaskName("test.watch-2")).toBe(true);
    expect(isTaskName("Dev")).toBe(false);
    expect(isTaskName("-x")).toBe(false);
    expect(isTaskName("a".repeat(41))).toBe(false);
  });
  test("cwd stays inside the repo", () => {
    expect(cwdError("ui")).toBeNull();
    expect(cwdError("/etc")).not.toBeNull();
    expect(cwdError("ui/../..")).not.toBeNull();
  });
  test("a patch is validated field by field", () => {
    expect(normalizeTaskPatch({ name: "dev", cmd: " bun run dev ", keep: true })).toEqual({ name: "dev", cmd: "bun run dev", keep: true });
    expect(normalizeTaskPatch({ name: "dev", cwd: "./" })).toEqual({ name: "dev" });
    expect(typeof normalizeTaskPatch({ name: "dev", cmd: "a\nb" })).toBe("string");
    expect(typeof normalizeTaskPatch({ name: "dev", keep: "yes" })).toBe("string");
    expect(typeof normalizeTaskPatch({ name: "Bad" })).toBe("string");
    expect(typeof normalizeTaskPatch({ name: "x", cwd: "../out" })).toBe("string");
  });
  test("the repo file keeps good entries and reports bad ones", () => {
    const r = parseTaskFile(JSON.stringify([{ name: "a", cmd: "x" }, { name: "B" }, { name: "a", cmd: "y" }]));
    expect(r.patches).toEqual([{ name: "a", cmd: "x" }]);
    expect(r.errors.length).toBe(2);
    expect(parseTaskFile("{").errors).toEqual([".canopy/tasks.json is not JSON"]);
    expect(parseTaskFile("{}").errors).toEqual([".canopy/tasks.json is a list of tasks"]);
  });
});

describe("detection", () => {
  test("package.json scripts run through bun, lifecycle hooks left out", () => {
    const pkg = JSON.stringify({ scripts: { dev: "vite", "test:watch": "vitest", prebuild: "x", build: "tsc", postinstall: "y", "my script": "z" } });
    expect(parseScripts(pkg)).toEqual([
      { name: "dev", cmd: "bun run dev", dev: true },
      { name: "test-watch", cmd: "bun run test:watch" },
      { name: "build", cmd: "bun run build" },
      { name: "my-script", cmd: "bun run 'my script'" },
    ]);
    expect(parseScripts("not json")).toEqual([]);
    expect(parseScripts("{}")).toEqual([]);
  });
  test("cargo: a package runs, a bare workspace does not", () => {
    expect(parseCargo('[package]\nname = "x"').map((t) => t.cmd)).toEqual(["cargo build", "cargo test", "cargo run"]);
    expect(parseCargo("[workspace]\nmembers = []").map((t) => t.cmd)).toEqual(["cargo build", "cargo test"]);
    expect(parseCargo("")).toEqual([]);
  });
  test("make: plain targets only", () => {
    const mk = ["all: build", ".PHONY: all", "%.o: %.c", "CC := gcc", "lint:", "\techo lint", "a b: c", "all: again"].join("\n");
    expect(parseMakeTargets(mk)).toEqual([
      { name: "all", cmd: "make all" },
      { name: "lint", cmd: "make lint" },
    ]);
  });
  test("the first manifest wins a name", () => {
    const t = detectTasks({ pkg: JSON.stringify({ scripts: { build: "tsc" } }), cargo: "[package]", make: "build:\nextra:" });
    expect(t.map((x) => `${x.name}=${x.cmd}`)).toEqual(["build=bun run build", "test=cargo test", "run=cargo run", "extra=make extra"]);
  });
  test("the file dump splits back into files", () => {
    const out = "\x1epackage.json\n{\"a\":1}\n\x1eMakefile\nall:\n";
    expect(parseTaskFiles(out)).toEqual({ pkg: '{"a":1}\n', make: "all:\n" });
    expect(parseTaskFiles("")).toEqual({});
  });
});

describe("merge", () => {
  const detected = [{ name: "dev", cmd: "bun run dev", dev: true }, { name: "test", cmd: "bun run test" }];

  test("later layers win field by field, and say so", () => {
    const r = mergeTasks(detected, [{ name: "test", cmd: "bun test --bail" }], [{ name: "dev", keep: true }], true);
    expect(r.tasks).toEqual([
      { name: "dev", cmd: "bun run dev", dev: true, keep: true, source: "canopy" },
      { name: "test", cmd: "bun test --bail", source: "repo" },
    ]);
  });
  test("new names append in layer order", () => {
    const r = mergeTasks([], [{ name: "a", cmd: "x" }], [{ name: "b", cmd: "y" }], true);
    expect(r.tasks.map((t) => t.name)).toEqual(["a", "b"]);
  });
  test("a task with no command is an error, not a task", () => {
    const r = mergeTasks([], [{ name: "a", keep: true }], [], true);
    expect(r.tasks).toEqual([]);
    expect(r.errors).toEqual(["a: no command"]);
  });
  test("auto flags from someone else's repo file are only suggested", () => {
    const r = mergeTasks(detected, [{ name: "dev", keep: true, withPanel: true }], [], false);
    expect(r.tasks[0]).toEqual({ name: "dev", cmd: "bun run dev", dev: true, source: "repo", suggested: { keep: true, withPanel: true } });
  });
  test("an answer in canopy's layer clears the suggestion", () => {
    const r = mergeTasks(detected, [{ name: "dev", keep: true }], [{ name: "dev", keep: false }], false);
    expect(r.tasks[0]).toEqual({ name: "dev", cmd: "bun run dev", dev: true, keep: false, source: "canopy" });
  });
  test("own repos apply the repo file's flags", () => {
    const r = mergeTasks(detected, [{ name: "dev", keep: true }], [], true);
    expect(r.tasks[0]?.keep).toBe(true);
  });
  test("only one dev task", () => {
    const r = mergeTasks(detected, [{ name: "web", cmd: "x", dev: true }], [], true);
    expect(r.tasks.filter((t) => t.dev).map((t) => t.name)).toEqual(["dev"]);
    expect(r.errors).toEqual(["web: only one dev task; dev is it"]);
  });
});
```

- [ ] **Step 4: Run the tests to see them fail**

Run: `bun test src/core/tasks.test.ts`
Expected: FAIL, `Cannot find module './tasks'`.

- [ ] **Step 5: Implement `src/core/tasks.ts`**

```ts
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
  const byName = new Map(Object.entries(TASK_FILES).map(([k, v]) => [v, k as keyof typeof TASK_FILES]));
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
```

Note the object key order in the test expectations (`name, cmd, dev, keep, source`): `toEqual` ignores key order, so this passes regardless.

- [ ] **Step 6: Run the tests to see them pass**

Run: `bun test src/core/tasks.test.ts && bun run typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/core/types.ts src/core/tasks.ts src/core/tasks.test.ts src/core/store.ts ui/src/qualify.ts ui/src/feed.ts
git commit -m "feat(tasks): task types, detection from manifests, and the three-layer merge"
```

---

### Task 2: Backoff, status, log text and sweep decisions (pure)

**Files:**
- Modify: `src/core/tasks.ts`
- Modify: `src/core/tasks.test.ts`

**Interfaces:**
- Consumes: types from Task 1.
- Produces: `TASK_TIMINGS: TaskTimings` and `TaskTimings { tick; grace; reap; uptime; sweep; backoff; backoffCap; giveUp; logCap; logAge }` (all ms except `giveUp` count and `logCap` bytes); `nextDelay(fails, base?, cap?): number`; `taskStatus(o: StatusInput): TaskStatus`; `startMark(at, cmd): string`; `plainLines(raw): string[]`; `logPage(raw, opts: { q?: string; before?: number; limit?: number }): TaskLogPage`; `parseTaskState(text): Record<string, TaskRecord>`; `LogFile { termId: string; mtime: number }`; `expiredTaskLogs(logs, live, defined, now, age): string[]`; `reapable(p, now, reapMs): boolean`; `staleWants(state, live, defined): string[]`.

- [ ] **Step 1: Write the failing tests**

Append to `src/core/tasks.test.ts` (add the new names to the import):

```ts
describe("backoff and status", () => {
  test("delays double to a cap", () => {
    expect([1, 2, 3, 4, 5, 6, 7, 8].map((n) => nextDelay(n))).toEqual([1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000]);
    expect(nextDelay(3, 100, 250)).toBe(250);
  });
  const base = { live: false, dead: false, want: undefined, gaveUp: false } as const;
  test("status from what tmux and the record say", () => {
    expect(taskStatus({ ...base, live: true })).toBe("running");
    expect(taskStatus({ ...base, live: true, dead: true, want: "running", exitedAt: 1, exitCode: 2 })).toBe("failed");
    expect(taskStatus({ ...base, want: "running", exitedAt: 1, exitCode: 0 })).toBe("exited");
    expect(taskStatus({ ...base, want: "stopped", exitedAt: 1, exitCode: 130 })).toBe("exited");
    expect(taskStatus({ ...base, want: "running", exitedAt: 1, exitCode: 1, retryAt: 5 })).toBe("backoff");
    expect(taskStatus({ ...base, want: "running", exitedAt: 1, exitCode: 1, gaveUp: true })).toBe("gave-up");
    expect(taskStatus(base)).toBe("idle");
  });
});

describe("log text", () => {
  test("ANSI and overwritten progress are dropped", () => {
    expect(plainLines("\x1b[32mok\x1b[0m\r\n10%\r50%\r100%\nend")).toEqual(["ok", "100%", "end"]);
    expect(plainLines("\x1b]0;title\x07x")).toEqual(["x"]);
  });
  test("a page carries each line's run start", () => {
    const raw = ["before", startMark(1000, "a"), "one", startMark(2000, "b"), "two", ""].join("\n");
    const page = logPage(raw, {});
    expect(page.lines.map((l) => [l.n, l.text, l.at, l.mark ?? false])).toEqual([
      [1, "before", null, false],
      [2, "--- started 1000 · a ---", 1000, true],
      [3, "one", 1000, false],
      [4, "--- started 2000 · b ---", 2000, true],
      [5, "two", 2000, false],
    ]);
    expect(page.more).toBe(false);
  });
  test("search, paging back and the limit", () => {
    const raw = ["Error a", "fine", "error b", "ERROR c"].join("\n");
    const hits = logPage(raw, { q: "error", limit: 2 });
    expect(hits.lines.map((l) => l.n)).toEqual([3, 4]);
    expect(hits.more).toBe(true);
    expect(logPage(raw, { q: "error", before: 3 }).lines.map((l) => l.n)).toEqual([1]);
  });
});

describe("state and the sweep", () => {
  test("state.json drops what it cannot use", () => {
    const [a, b, c] = ["a", "b", "c"].map((x) => x.repeat(32));
    const text = JSON.stringify({
      [a]: { repoId: "r", path: "/p", name: "dev", want: "running", exitCode: 1, exitedAt: 5 },
      [b]: { repoId: "r", path: "/p", name: "Bad", want: "running" },
      [c]: "nope",
      short: { repoId: "r", path: "/p", name: "dev", want: "running" },
    });
    expect(parseTaskState(text)).toEqual({ [a]: { repoId: "r", path: "/p", name: "dev", want: "running", exitCode: 1, exitedAt: 5 } });
    expect(parseTaskState("not json")).toEqual({});
  });
  const DAY = 86_400_000;
  test("logs go only when unused, undefined and old", () => {
    const logs = [
      { termId: "live", mtime: 0 },
      { termId: "defined", mtime: 0 },
      { termId: "unknown", mtime: 0 },
      { termId: "fresh", mtime: 8 * DAY - 1 },
      { termId: "gone", mtime: 0 },
    ];
    const defined = (id: string) => (id === "defined" ? true : id === "unknown" ? null : false);
    expect(expiredTaskLogs(logs, new Set(["live"]), defined, 8 * DAY, 7 * DAY)).toEqual(["gone"]);
  });
  test("a dead pane with no viewers is reaped after the wait", () => {
    expect(reapable({ dead: true, exitedAt: 0, viewers: 0 }, 3_600_001, 3_600_000)).toBe(true);
    expect(reapable({ dead: true, exitedAt: 0, viewers: 1 }, 3_600_001, 3_600_000)).toBe(false);
    expect(reapable({ dead: false, exitedAt: 0, viewers: 0 }, 3_600_001, 3_600_000)).toBe(false);
    expect(reapable({ dead: true, viewers: 0 }, 3_600_001, 3_600_000)).toBe(false);
  });
  test("wants for gone tasks with no session", () => {
    const st = {
      a: { repoId: "r", path: "/p", name: "a", want: "running" as const },
      b: { repoId: "r", path: "/p", name: "b", want: "stopped" as const },
      c: { repoId: "r", path: "/p", name: "c", want: "stopped" as const },
    };
    expect(staleWants(st, new Set(["a"]), (id) => (id === "b" ? true : false))).toEqual(["c"]);
  });
});
```

- [ ] **Step 2: Run to see them fail**

Run: `bun test src/core/tasks.test.ts`
Expected: FAIL, the new names are not exported.

- [ ] **Step 3: Implement**

Append to `src/core/tasks.ts` (add `TaskLogLine`, `TaskLogPage`, `TaskRecord`, `TaskStatus` to the type import):

```ts
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
```

- [ ] **Step 4: Run to see them pass**

Run: `bun test src/core/tasks.test.ts && bun run lint`
Expected: PASS. If oxlint flags the control-character regexes, keep the disable comment it asks for.

- [ ] **Step 5: Commit**

```bash
git add src/core/tasks.ts src/core/tasks.test.ts
git commit -m "feat(tasks): backoff, status words, log text and the sweep's decisions"
```

---

### Task 3: Per-machine overrides in canopy's config

**Files:**
- Modify: `src/core/store.ts`
- Modify: `src/core/store.test.ts`

**Interfaces:**
- Consumes: `normalizeTaskPatch` (Task 1).
- Produces: `tasksFor(cfg, path): TaskPatch[]`; `setTask(path, name, patch: TaskPatch | null): Promise<TaskPatch[]>` (replaces or removes one entry by name; an entry that is only a name is dropped; an empty list removes the repo's key).

- [ ] **Step 1: Write the failing test**

Append to `src/core/store.test.ts` (import `setTask`, `tasksFor`):

```ts
describe("task overrides", () => {
  test("set, replace, clear, and bad entries dropped on load", async () => {
    expect(await setTask("/r", "dev", { name: "dev", keep: true })).toEqual([{ name: "dev", keep: true }]);
    expect(await setTask("/r", "dev", { name: "dev", keep: false, cmd: "x" })).toEqual([{ name: "dev", keep: false, cmd: "x" }]);
    await setTask("/r", "web", { name: "web", cmd: "y" });
    expect(tasksFor(await loadConfig(), "/r").map((t) => t.name)).toEqual(["dev", "web"]);
    expect(await setTask("/r", "dev", { name: "dev" })).toEqual([{ name: "web", cmd: "y" }]);
    expect(await setTask("/r", "web", null)).toEqual([]);
    expect((await loadConfig()).tasks["/r"]).toBeUndefined();
    const cfg = await loadConfig();
    await saveConfig({ ...cfg, tasks: { "/s": [{ name: "ok", cmd: "a" }, { name: "Bad" } as never] } });
    expect(tasksFor(await loadConfig(), "/s")).toEqual([{ name: "ok", cmd: "a" }]);
  });
});
```

- [ ] **Step 2: Run to see it fail**

Run: `bun test src/core/store.test.ts`
Expected: FAIL, `setTask` is not exported.

- [ ] **Step 3: Implement**

In `src/core/store.ts`, import `normalizeTaskPatch` from `./tasks` and `TaskPatch` from `./types`. Add next to `normalizeLaunchers`:

```ts
/** Task overrides by repo path: each entry checked like a repo file's, and a
 *  repo with none left out. */
function normalizeTasks(v: unknown): Record<string, TaskPatch[]> {
  if (!v || typeof v !== "object" || Array.isArray(v)) return {};
  const out: Record<string, TaskPatch[]> = {};
  for (const [path, list] of Object.entries(v as Record<string, unknown>)) {
    if (!Array.isArray(list)) continue;
    const kept = list.map(normalizeTaskPatch).filter((p): p is TaskPatch => typeof p !== "string" && Object.keys(p).length > 1);
    if (kept.length) out[path] = kept;
  }
  return out;
}
```

Replace the `tasks: {},` placeholder in `normalize` with `tasks: normalizeTasks(cfg.tasks),`. After `setLaunch` add:

```ts
/* ---------- task overrides ---------- */

export const tasksFor = (cfg: CanopyConfig, path: string): TaskPatch[] => cfg.tasks[path] ?? [];

/** Stores, replaces or (with null, or a patch that says nothing but its
 *  name) removes one task's override. Returns the repo's list. */
export async function setTask(path: string, name: string, patch: TaskPatch | null): Promise<TaskPatch[]> {
  return withConfig((cfg) => {
    const list = (cfg.tasks[path] ?? []).filter((t) => t.name !== name);
    if (patch && Object.keys(patch).length > 1) list.push({ ...patch, name });
    if (list.length) cfg.tasks[path] = list;
    else delete cfg.tasks[path];
    return list;
  });
}
```

Replacing an entry moves it to the end of the list; the second assertion in the test (`[{ name: "dev", keep: false, cmd: "x" }]`) still holds since it is alone. If `store.ts` importing `tasks.ts` creates a cycle, there is none: `tasks.ts` imports only types.

- [ ] **Step 4: Run to see it pass**

Run: `bun test src/core/store.test.ts && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/store.ts src/core/store.test.ts
git commit -m "feat(tasks): per-machine task overrides in the config"
```

---

### Task 4: tmux argv builders and the task tag

**Files:**
- Modify: `src/core/tmux.ts`
- Modify: `src/core/tmux.test.ts`

**Interfaces:**
- Produces: `TmuxSession.task?: string` (read from a new 7th `LIST_FORMAT` field `#{@canopy_task}`); `TaskMeta { id: string; repoId: string; path: string; task: string }`; `taskSessionArgs(base, meta, size): string[]`; `pipeArgs(base, id, log): string[]`; `respawnArgs(base, id, command: string[], dir: string | null): string[]`; `interruptArgs(base, id): string[]`; `TASK_PANE_FORMAT`; `taskPanesArgs(base): string[]`; `TaskPane { termId; task; repoId; path; dead: boolean; code: number | null; createdAt: number }`; `parseTaskPanes(out): TaskPane[]`; `taskCommand(locator, cmd, cwd?): { command: string[]; dir: string | null }`.

- [ ] **Step 1: Write the failing tests**

Append to `src/core/tmux.test.ts` (import the new names):

```ts
describe("tasks on tmux", () => {
  const base = ["tmux", "-S", "/s"];
  const meta = { id: "0123456789abcdef0123456789abcdef", repoId: "app", path: "/r/app", task: "dev" };
  const name = "canopy-0123456789abcdef0123456789abcdef";

  test("a task session holds a placeholder, carries its tags and keeps its pane when it dies", () => {
    expect(taskSessionArgs(base, meta, { cols: 120, rows: 32 })).toEqual([
      ...base, "new-session", "-d", "-s", name, "-c", "/r/app", "-x", "120", "-y", "32", "'sleep' '2147483647'",
      ";", "set-option", "-t", name, "@canopy_repo", "app",
      ";", "set-option", "-t", name, "@canopy_place", "strip",
      ";", "set-option", "-t", name, "@canopy_path", "/r/app",
      ";", "set-option", "-t", name, "@canopy_task", "dev",
      ";", "set-option", "-w", "-t", name, "remain-on-exit", "on",
    ]);
  });
  test("pipe, respawn and interrupt", () => {
    expect(pipeArgs(base, meta.id, "/c/it's.log")).toEqual([...base, "pipe-pane", "-t", name, "cat >> '/c/it'\\''s.log'"]);
    expect(respawnArgs(base, meta.id, ["sh", "-lc", "echo 'a b'"], "/r/app")).toEqual([
      ...base, "respawn-pane", "-k", "-t", name, "-c", "/r/app", "'sh' '-lc' 'echo '\\''a b'\\'''",
    ]);
    expect(respawnArgs(base, meta.id, ["ssh", "h"], null)).toEqual([...base, "respawn-pane", "-k", "-t", name, "'ssh' 'h'"]);
    expect(interruptArgs(base, meta.id)).toEqual([...base, "send-keys", "-t", name, "C-c"]);
  });
  test("the pane list keeps task panes only", () => {
    const out = [
      `${name}\tdev\tapp\t/r/app\t1\t3\t100`,
      `${name.replace("0123", "ffff")}\t\tapp\t/r/app\t0\t\t100`,
      `other\tdev\tapp\t/r/app\t0\t\t100`,
    ].join("\n");
    expect(parseTaskPanes(out)).toEqual([
      { termId: meta.id, task: "dev", repoId: "app", path: "/r/app", dead: true, code: 3, createdAt: 100_000 },
    ]);
  });
  test("a task command here runs in its folder, elsewhere over ssh", () => {
    expect(taskCommand("/r/app", "bun run dev")).toEqual({ command: ["sh", "-lc", "bun run dev"], dir: "/r/app" });
    expect(taskCommand("/r/app", "x", "ui")).toEqual({ command: ["sh", "-lc", "x"], dir: "/r/app/ui" });
    expect(taskCommand("ssh://mini/r/app", "x", "ui")).toEqual({
      command: ["ssh", "-t", "--", "mini", "cd '/r/app/ui' && exec sh -lc 'x'"],
      dir: null,
    });
  });
  test("the session list reads the task tag", () => {
    const line = `${name}\tapp\tstrip\t100\t/r/app\t\tdev`;
    expect(parseSessions(line)[0]?.task).toBe("dev");
    expect(parseSessions(`${name}\tapp\tstrip\t100\t/r/app\t\t`)[0]?.task).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run to see them fail**

Run: `bun test src/core/tmux.test.ts`
Expected: FAIL, missing exports.

- [ ] **Step 3: Implement**

In `src/core/tmux.ts`:

1. Add `import { join } from "node:path";` is already there; add `task?: string` to `TmuxSession`:

```ts
export interface TmuxSession extends TmuxMeta {
  /** ms since the epoch */
  createdAt: number;
  /** the task a task's session runs; absent for a shell */
  task?: string;
}
```

2. Extend `LIST_FORMAT` with `\t#{@canopy_task}` at the end and read it in `parseSessions`:

```ts
export const LIST_FORMAT = "#{session_name}\t#{@canopy_repo}\t#{@canopy_place}\t#{session_created}\t#{@canopy_path}\t#{@canopy_handle}\t#{@canopy_task}";
```

```ts
    const [name = "", repoId = "", place, created = "", path = "", handle = "", task = ""] = line.split("\t");
    ...
      ...(handle ? { handle } : {}),
      ...(task ? { task } : {}),
```

3. Add after `sendLineArgs`:

```ts
/* ---------- tasks: a session that runs one command and keeps its pane when it ends ---------- */

export interface TaskMeta {
  id: string;
  repoId: string;
  path: string;
  task: string;
}

/**
 * A task's session: a placeholder `sleep` until `respawnArgs` swaps the real
 * command in, so the log's pipe can be attached first and catch the
 * command's first line. Tagged like a shell plus `@canopy_task`, which is
 * what keeps it out of every shell list, and set to keep its pane when the
 * command exits, so the exit code can be read.
 */
export function taskSessionArgs(base: string[], meta: TaskMeta, size: TermSize): string[] {
  const name = sessionName(meta.id);
  const { host, path } = parseLocator(meta.path);
  const opt = (key: string, value: string) => [";", "set-option", "-t", name, key, value];
  return [
    ...base,
    "new-session",
    "-d",
    "-s",
    name,
    ...(host === null ? ["-c", path] : []),
    "-x",
    String(size.cols),
    "-y",
    String(size.rows),
    ["sleep", "2147483647"].map(shellQuote).join(" "),
    ...opt("@canopy_repo", meta.repoId),
    ...opt("@canopy_place", "strip"),
    ...opt("@canopy_path", meta.path),
    ...opt("@canopy_task", meta.task),
    ";",
    "set-option",
    "-w",
    "-t",
    name,
    "remain-on-exit",
    "on",
  ];
}

/** everything the pane writes, appended to the log; given again it replaces the pipe */
export const pipeArgs = (base: string[], id: string, log: string): string[] => [...base, "pipe-pane", "-t", sessionName(id), `cat >> ${shellQuote(log)}`];

/** the pane's process swapped for `command`, killing whatever ran there */
export const respawnArgs = (base: string[], id: string, command: string[], dir: string | null): string[] => [
  ...base,
  "respawn-pane",
  "-k",
  "-t",
  sessionName(id),
  ...(dir === null ? [] : ["-c", dir]),
  command.map(shellQuote).join(" "),
];

/** ^C to the pane, the polite first half of a stop */
export const interruptArgs = (base: string[], id: string): string[] => [...base, "send-keys", "-t", sessionName(id), "C-c"];

/** one line per pane on the server: session, task, repo, path, dead, exit status, created */
export const TASK_PANE_FORMAT = "#{session_name}\t#{@canopy_task}\t#{@canopy_repo}\t#{@canopy_path}\t#{pane_dead}\t#{pane_dead_status}\t#{session_created}";

export const taskPanesArgs = (base: string[]): string[] => [...base, "list-panes", "-a", "-F", TASK_PANE_FORMAT];

export interface TaskPane {
  termId: string;
  task: string;
  repoId: string;
  path: string;
  dead: boolean;
  /** the exit status once dead; null while alive or when tmux did not say */
  code: number | null;
  /** ms */
  createdAt: number;
}

/** reads `taskPanesArgs`, keeping the panes of task sessions canopy made */
export function parseTaskPanes(out: string): TaskPane[] {
  const panes: TaskPane[] = [];
  for (const line of out.split("\n")) {
    if (!line) continue;
    const [name = "", task = "", repoId = "", path = "", dead = "", status = "", created = ""] = line.split("\t");
    const termId = sessionId(name);
    if (!termId || !task || !repoId || !path) continue;
    const code = Number(status);
    const secs = Number(created);
    panes.push({
      termId,
      task,
      repoId,
      path,
      dead: dead === "1",
      code: dead === "1" && status !== "" && Number.isFinite(code) ? code : null,
      createdAt: Number.isFinite(secs) && secs > 0 ? secs * 1000 : Date.now(),
    });
  }
  return panes;
}

/** What a task's pane runs: `sh -lc` in its folder here, or an ssh line
 *  that cds there and runs the same on the other host, so the pane's exit
 *  status is the command's own either way. */
export function taskCommand(locator: string, cmd: string, cwd?: string): { command: string[]; dir: string | null } {
  const { host, path } = parseLocator(locator);
  const dir = cwd ? join(path, cwd) : path;
  if (host === null) return { command: ["sh", "-lc", cmd], dir };
  return { command: ["ssh", "-t", "--", host, `cd ${shellQuote(dir)} && exec sh -lc ${shellQuote(cmd)}`], dir: null };
}
```

A pane of a task session still has a repo and path, so `parseSessions` lists it; the server filters on `task` (Task 6).

- [ ] **Step 4: Run to see them pass**

Run: `bun test src/core/tmux.test.ts && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/tmux.ts src/core/tmux.test.ts
git commit -m "feat(tasks): tmux builders for task sessions, pipes, respawn and the pane list"
```

---

### Task 5: Task files, state and logs on disk (Bun)

**Files:**
- Create: `src/core/taskrun.ts`
- Create: `src/core/taskrun.test.ts`

**Interfaces:**
- Consumes: `TASK_FILES`, `TASK_FILES_SCRIPT`, `parseTaskFiles`, `parseTaskState`, `startMark`, `LogFile` (Tasks 1-2); tmux builders (Task 4); `exec`, `onHost`; `configDir`.
- Produces: `taskTermId(path, name): string`; `readTaskFiles(locator): Promise<TaskFiles>`; `logPath(termId): string`; `readTaskState(): Promise<Record<string, TaskRecord>>`; `writeTaskState(s): Promise<void>`; `appendMark(termId, at, cmd): Promise<void>`; `rotateIfBig(termId, cap): Promise<boolean>`; `readLog(termId): Promise<string>`; `listLogs(): Promise<LogFile[]>`; `removeLog(termId): Promise<void>`; `startTaskSession(base, meta, locator, cmd, cwd?): Promise<void>` (makes the session when missing, appends nothing, pipes, respawns); `interruptTask(base, id)`; `listTaskPanes(base): Promise<TaskPane[] | null>` (null when tmux did not answer, `[]` when there is no server).

- [ ] **Step 1: Write the failing tests**

Create `src/core/taskrun.test.ts`:

```ts
/**
 * The disk and tmux side of tasks against a scratch config dir and a tmux
 * server of its own on a socket under it. The real server's sessions are
 * never touched.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { killServer, tmuxBase } from "./tmux";
import {
  appendMark,
  interruptTask,
  listLogs,
  listTaskPanes,
  logPath,
  readLog,
  readTaskFiles,
  readTaskState,
  rotateIfBig,
  startTaskSession,
  taskTermId,
  writeTaskState,
} from "./taskrun";

let scratch = "";
const prev = process.env["CANOPY_CONFIG_DIR"];
const tmux = Bun.which("tmux") !== null;

async function until(pred: () => Promise<boolean>, what: string, ms = 10_000) {
  const start = Date.now();
  while (!(await pred())) {
    if (Date.now() - start > ms) throw new Error(`gave up waiting for ${what}`);
    await Bun.sleep(50);
  }
}

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "canopy-taskrun-"));
  process.env["CANOPY_CONFIG_DIR"] = join(scratch, "config");
});

afterAll(async () => {
  const base = tmuxBase();
  if (base) await killServer(base);
  if (prev === undefined) delete process.env["CANOPY_CONFIG_DIR"];
  else process.env["CANOPY_CONFIG_DIR"] = prev;
  await rm(scratch, { recursive: true, force: true });
});

describe("files and state", () => {
  test("ids are stable, 32 hex, and differ by path and name", () => {
    const a = taskTermId("/r/app", "dev");
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(taskTermId("/r/app", "dev")).toBe(a);
    expect(taskTermId("/r/app", "test")).not.toBe(a);
    expect(taskTermId("/r/other", "dev")).not.toBe(a);
  });
  test("a local repo's task files", async () => {
    const repo = join(scratch, "repo");
    await mkdir(join(repo, ".canopy"), { recursive: true });
    await writeFile(join(repo, "package.json"), '{"scripts":{"dev":"vite"}}');
    await writeFile(join(repo, ".canopy/tasks.json"), "[]");
    expect(await readTaskFiles(repo)).toEqual({ pkg: '{"scripts":{"dev":"vite"}}', repoFile: "[]" });
  });
  test("state round-trips", async () => {
    expect(await readTaskState()).toEqual({});
    const id = taskTermId("/r", "dev");
    await writeTaskState({ [id]: { repoId: "r", path: "/r", name: "dev", want: "running", startedAt: 1 } });
    expect(await readTaskState()).toEqual({ [id]: { repoId: "r", path: "/r", name: "dev", want: "running", startedAt: 1 } });
  });
  test("marks, rotation and reading both files", async () => {
    const id = taskTermId("/r", "log");
    await appendMark(id, 1000, "a");
    await Bun.write(logPath(id), (await readLog(id)) + "x".repeat(50) + "\n");
    expect(await rotateIfBig(id, 10)).toBe(true);
    await appendMark(id, 2000, "b");
    expect(await rotateIfBig(id, 1000)).toBe(false);
    const text = await readLog(id);
    expect(text.startsWith("--- started 1000 · a ---\n")).toBe(true);
    expect(text.endsWith("--- started 2000 · b ---\n")).toBe(true);
    expect((await listLogs()).map((l) => l.termId)).toContain(id);
  });
});

describe.skipIf(!tmux)("a task session", () => {
  test("the first line reaches the log, the exit code is read, and a respawn keeps the pipe", async () => {
    const base = tmuxBase()!;
    const repo = join(scratch, "repo");
    const id = taskTermId(repo, "quick");
    const meta = { id, repoId: "repo", path: repo, task: "quick" };
    // Review focus 1: quotes, && and $ survive both shells
    await startTaskSession(base, meta, repo, `echo 'first line' && echo "home=$HOME" && exit 3`);
    await until(async () => (await listTaskPanes(base))?.some((p) => p.termId === id && p.dead) ?? false, "the task to exit");
    const pane = (await listTaskPanes(base))!.find((p) => p.termId === id)!;
    expect(pane.code).toBe(3);
    expect(pane.task).toBe("quick");
    const log = await readLog(id);
    expect(log).toContain("first line");
    expect(log).toContain(`home=${process.env["HOME"]}`);
    // again on the same session: the new run's output lands in the log too
    await startTaskSession(base, meta, repo, "echo second run; sleep 30");
    await until(async () => (await readLog(id)).includes("second run"), "the respawned output");
    await interruptTask(base, id);
    await until(async () => (await listTaskPanes(base))?.some((p) => p.termId === id && p.dead) ?? false, "^C to end it");
  });
  test("no server is an empty list, not a failure", async () => {
    const base = tmuxBase()!;
    await killServer(base);
    expect(await listTaskPanes(base)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to see them fail**

Run: `bun test src/core/taskrun.test.ts`
Expected: FAIL, `Cannot find module './taskrun'`.

- [ ] **Step 3: Implement `src/core/taskrun.ts`**

```ts
/**
 * The Bun half of tasks below the server: where a task's files, record and
 * log live, and the few tmux calls a start and a stop are made of. Logs and
 * `state.json` sit under the config dir, the volume the shells container
 * shares, since the tmux server that writes the logs runs there.
 */
import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { exec, onHost } from "./exec";
import { parseLocator, shellQuote } from "./host";
import { configDir } from "./store";
import { parseTaskFiles, parseTaskState, startMark, TASK_FILES, TASK_FILES_SCRIPT, type LogFile, type TaskFiles } from "./tasks";
import {
  hasSession,
  interruptArgs,
  noServer,
  parseTaskPanes,
  pipeArgs,
  respawnArgs,
  taskCommand,
  taskPanesArgs,
  taskSessionArgs,
  type TaskMeta,
  type TaskPane,
} from "./tmux";
import type { TaskRecord } from "./types";

/** a task's session id: the repo's locator and the task's name, hashed to a shell-shaped id */
export const taskTermId = (path: string, name: string): string => createHash("sha256").update(`${path}\0${name}`).digest("hex").slice(0, 32);

const tasksDir = (): string => join(configDir(), "tasks");
const logDir = (): string => join(tasksDir(), "logs");
const statePath = (): string => join(tasksDir(), "state.json");
export const logPath = (termId: string): string => join(logDir(), `${termId}.log`);
const oldLogPath = (termId: string): string => `${logPath(termId)}.1`;

/** the manifests and the repo file, here through fs, elsewhere in one ssh round trip */
export async function readTaskFiles(locator: string): Promise<TaskFiles> {
  const { host, path } = parseLocator(locator);
  if (host !== null) {
    const r = await onHost(host, ["sh", "-c", `cd ${shellQuote(path)} && ${TASK_FILES_SCRIPT}`], { timeoutMs: 15_000 });
    return r.code === 0 ? parseTaskFiles(r.stdout) : {};
  }
  const files: TaskFiles = {};
  for (const [key, file] of Object.entries(TASK_FILES) as [keyof TaskFiles, string][]) {
    try {
      files[key] = await readFile(join(path, file), "utf8");
    } catch {
      // not there
    }
  }
  return files;
}

export async function readTaskState(): Promise<Record<string, TaskRecord>> {
  try {
    return parseTaskState(await readFile(statePath(), "utf8"));
  } catch {
    return {};
  }
}

let writes = 0;

/** the whole record, written through a temporary file so a crash never leaves half of it */
export async function writeTaskState(state: Record<string, TaskRecord>): Promise<void> {
  await mkdir(tasksDir(), { recursive: true });
  const tmp = `${statePath()}.${process.pid}.${++writes}`;
  await writeFile(tmp, JSON.stringify(state, null, 2) + "\n", { mode: 0o600 });
  await rename(tmp, statePath());
}

/** The line ahead of a run, written by canopy rather than the pane. No
 *  0600 here: in the container the pane's `cat >>` runs in the shells
 *  container's tmux server, which may be another uid than canopy, and a
 *  file only canopy could write would lose every line after the marker. */
export async function appendMark(termId: string, at: number, cmd: string): Promise<void> {
  await mkdir(logDir(), { recursive: true });
  await appendFile(logPath(termId), `${startMark(at, cmd)}\n`);
}

/** moves a log past `cap` to `.log.1`, dropping the older one; true when it did */
export async function rotateIfBig(termId: string, cap: number): Promise<boolean> {
  try {
    if ((await stat(logPath(termId))).size <= cap) return false;
  } catch {
    return false;
  }
  await rename(logPath(termId), oldLogPath(termId));
  return true;
}

/** the old log then the current one, as one text */
export async function readLog(termId: string): Promise<string> {
  const read = (p: string) => readFile(p, "utf8").catch(() => "");
  return (await read(oldLogPath(termId))) + (await read(logPath(termId)));
}

/** every task log on disk, by the task it belongs to, with the newest write */
export async function listLogs(): Promise<LogFile[]> {
  let names: string[];
  try {
    names = await readdir(logDir());
  } catch {
    return [];
  }
  const newest = new Map<string, number>();
  for (const name of names) {
    const m = /^([0-9a-f]{32})\.log(?:\.1)?$/.exec(name);
    if (!m?.[1]) continue;
    const mtime = (await stat(join(logDir(), name)).catch(() => null))?.mtimeMs ?? 0;
    newest.set(m[1], Math.max(newest.get(m[1]) ?? 0, mtime));
  }
  return [...newest].map(([termId, mtime]) => ({ termId, mtime }));
}

export async function removeLog(termId: string): Promise<void> {
  await rm(logPath(termId), { force: true });
  await rm(oldLogPath(termId), { force: true });
}

/**
 * Runs a task's command on its session: the session made first when there
 * is none, the log's pipe attached (again, so a rotated log is followed),
 * then the command swapped in for whatever the pane held.
 */
export async function startTaskSession(base: string[], meta: TaskMeta, locator: string, cmd: string, cwd?: string): Promise<void> {
  await mkdir(logDir(), { recursive: true });
  if (!(await hasSession(base, meta.id))) {
    const made = await exec(taskSessionArgs(base, meta, { cols: 120, rows: 32 }), { timeoutMs: 15_000 });
    if (made.code !== 0 && !/duplicate session/.test(made.stderr)) throw new Error(made.stderr.trim() || "tmux could not make the task's session");
  }
  const piped = await exec(pipeArgs(base, meta.id, logPath(meta.id)), { timeoutMs: 10_000 });
  if (piped.code !== 0) throw new Error(piped.stderr.trim() || "tmux could not pipe the task's output");
  const { command, dir } = taskCommand(locator, cmd, cwd);
  const r = await exec(respawnArgs(base, meta.id, command, dir), { timeoutMs: 10_000 });
  if (r.code !== 0) throw new Error(r.stderr.trim() || "tmux could not start the task");
}

/** re-attaches the pipe after a rotation, so the running `cat` stops writing to the old file */
export async function repipe(base: string[], termId: string): Promise<void> {
  await exec(pipeArgs(base, termId, logPath(termId)), { timeoutMs: 10_000 });
}

export async function interruptTask(base: string[], id: string): Promise<void> {
  await exec(interruptArgs(base, id), { timeoutMs: 10_000 });
}

/** every task pane; [] with no server, null when tmux did not answer */
export async function listTaskPanes(base: string[]): Promise<TaskPane[] | null> {
  const r = await exec(taskPanesArgs(base), { timeoutMs: 10_000 });
  if (r.code === 0) return parseTaskPanes(r.stdout);
  return noServer(r.stderr) ? [] : null;
}
```

Check that `exec`'s options accept `timeoutMs` (they do, `ExecOptions`). If `appendFile`'s `mode` only applies on creation, that is fine.

- [ ] **Step 4: Run to see them pass**

Run: `bun test src/core/taskrun.test.ts`
Expected: PASS. If "second run" never reaches the log, `respawn-pane` closed the pipe: move the `pipeArgs` call in `startTaskSession` to run both before and immediately after the respawn, and note it in a comment. If "first line" is missing on the first run, the pipe was late: that is the ordering this function exists for, so check the order of calls.

- [ ] **Step 5: Commit**

```bash
git add src/core/taskrun.ts src/core/taskrun.test.ts
git commit -m "feat(tasks): task files, state, logs and the session calls on tmux"
```

---

### Task 6: TaskHub routes, start, stop, restart, and shells kept apart

**Files:**
- Create: `src/server/tasks.ts`
- Create: `src/server/tasks.test.ts`
- Modify: `src/server/index.ts`

**Interfaces:**
- Consumes: everything from Tasks 1-5; `setTask`, `tasksFor`, `loadConfig`; `accessFromUrls`, `githubLogin`.
- Produces: `class TaskHub` with `constructor(deps: TaskHubDeps)`, `start(): Promise<void>`, `stop(): void`, `handle(req, url, repoOf: (id: string) => Repo | undefined): Promise<Response | null>`, `refresh(): void` (re-tells repos with task sessions; called by `tellTerms`). `TaskHubDeps { tmux: string[] | null; repos: () => Repo[]; own: (repo: Repo) => Promise<boolean>; viewers: (termId: string) => string[]; hold: (info: TermInfo) => void; broadcast: (ev: ServerEvent) => void; gaveUp: (repo: string, task: string) => void; timings?: Partial<TaskTimings> }`. `startServer` gains `tasks?: Partial<TaskTimings>`.

This task builds the hub with the routes and manual actions; the supervisor tick records deaths but keep running, recovery and the sweep come in Tasks 7 and 8.

- [ ] **Step 1: Write the failing integration tests**

Create `src/server/tasks.test.ts`:

```ts
/**
 * Tasks through the HTTP API against a real server on a scratch root and a
 * tmux server of its own under the scratch config dir. Timings are shrunk
 * through startServer's `tasks` option.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { killServer, tmuxBase } from "../core/tmux";
import type { TaskInfo, TasksResult, TermInfo } from "../core/types";
import { startServer } from "./index";

const tmux = Bun.which("tmux") !== null;
let scratch = "";
let previous: string | undefined;
let server: { port: number; stop: () => void };
let repo = "";

const url = (p: string) => `http://127.0.0.1:${server.port}${p}`;
const get = async <T>(p: string): Promise<T> => (await fetch(url(p))).json() as Promise<T>;
const post = (p: string, body: unknown) => fetch(url(p), { method: "POST", body: JSON.stringify(body) });
const tasks = () => get<TasksResult>("/api/repos/tasks?id=app");
const task = async (name: string): Promise<TaskInfo> => (await tasks()).tasks.find((t) => t.name === name)!;

async function until(pred: () => Promise<boolean>, what: string, ms = 15_000) {
  const start = Date.now();
  while (!(await pred())) {
    if (Date.now() - start > ms) throw new Error(`gave up waiting for ${what}`);
    await Bun.sleep(50);
  }
}

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "canopy-tasks-"));
  previous = process.env["CANOPY_CONFIG_DIR"];
  process.env["CANOPY_CONFIG_DIR"] = join(scratch, "config");
  const root = join(scratch, "root");
  repo = join(root, "app");
  await mkdir(join(repo, ".canopy"), { recursive: true });
  await Bun.$`git -C ${repo} init -q`.quiet();
  await writeFile(
    join(repo, ".canopy/tasks.json"),
    JSON.stringify([
      { name: "hello", cmd: "echo hello-task; sleep 30" },
      { name: "quick", cmd: "echo quick-out; exit 3" },
      { name: "stubborn", cmd: "trap '' INT; echo stubborn; sleep 30" },
      { name: "auto", cmd: "echo auto; sleep 30", keep: true },
    ]),
  );
  server = await startServer({ root, port: 0, chan: null, tasks: { tick: 100, grace: 500 } });
});

afterAll(async () => {
  server.stop();
  const base = tmuxBase();
  if (base) await killServer(base);
  if (previous === undefined) delete process.env["CANOPY_CONFIG_DIR"];
  else process.env["CANOPY_CONFIG_DIR"] = previous;
  await rm(scratch, { recursive: true, force: true });
});

describe.skipIf(!tmux)("tasks", () => {
  test("the repo file's tasks list idle, and someone else's auto flags are only suggested", async () => {
    const r = await tasks();
    expect(r.errors).toEqual([]);
    expect(r.tasks.map((t) => [t.name, t.status, t.source])).toEqual([
      ["hello", "idle", "repo"],
      ["quick", "idle", "repo"],
      ["stubborn", "idle", "repo"],
      ["auto", "idle", "repo"],
    ]);
    const auto = r.tasks.find((t) => t.name === "auto")!;
    expect(auto.keep).toBeUndefined();
    expect(auto.suggested).toEqual({ keep: true });
    expect(auto.termId).toMatch(/^[0-9a-f]{32}$/);
  });

  test("start, a second start, and the shell lists leave it out", async () => {
    // Review focus 2: two starts at once, one wins
    const [a, b] = await Promise.all([
      post("/api/repos/tasks?id=app", { action: "start", name: "hello" }),
      post("/api/repos/tasks?id=app", { action: "start", name: "hello" }),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    const t = await task("hello");
    expect(t.status).toBe("running");
    expect(t.live).toBe(true);
    const shells = await get<TermInfo[]>("/api/terms");
    expect(shells.some((s) => s.id === t.termId)).toBe(false);
    const del = await fetch(url(`/api/terms?term=${t.termId}`), { method: "DELETE" });
    expect(del.status).toBe(400);
    const log = await get<{ lines: { text: string }[] }>("/api/repos/tasks/log?id=app&name=hello");
    await until(async () => (await get<{ lines: { text: string }[] }>("/api/repos/tasks/log?id=app&name=hello")).lines.some((l) => l.text === "hello-task"), "the output in the log");
    expect(log.lines[0]?.text.startsWith("--- started ")).toBe(true);
  });

  test("the terminal socket joins a task with attach=1", async () => {
    const t = await task("hello");
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/api/term?id=app&term=${t.termId}&attach=1&cols=80&rows=24`);
    ws.binaryType = "arraybuffer";
    let text = "";
    ws.onmessage = (e: MessageEvent<ArrayBuffer | string>) => {
      if (typeof e.data !== "string") text += new TextDecoder().decode(new Uint8Array(e.data));
    };
    await until(async () => text.includes("hello-task"), "the task's screen over the socket");
    ws.close();
  });

  test("a command that exits at once keeps its output and code", async () => {
    // Review focus 3
    expect((await post("/api/repos/tasks?id=app", { action: "start", name: "quick" })).status).toBe(200);
    await until(async () => (await task("quick")).status === "failed", "quick to fail");
    const t = await task("quick");
    expect(t.exitCode).toBe(3);
    const log = await get<{ lines: { text: string }[] }>("/api/repos/tasks/log?id=app&name=quick");
    expect(log.lines.some((l) => l.text === "quick-out")).toBe(true);
  });

  test("restart keeps the session; stop ends it, killing what ignores ^C", async () => {
    const before = await task("hello");
    expect((await post("/api/repos/tasks?id=app", { action: "restart", name: "hello" })).status).toBe(200);
    const after = await task("hello");
    expect(after.termId).toBe(before.termId);
    expect(after.status).toBe("running");
    await post("/api/repos/tasks?id=app", { action: "start", name: "stubborn" });
    expect((await post("/api/repos/tasks?id=app", { action: "stop", name: "stubborn" })).status).toBe(200);
    const s = await task("stubborn");
    expect(s.status).toBe("exited");
    expect(s.live).toBe(false);
    expect((await post("/api/repos/tasks?id=app", { action: "stop", name: "stubborn" })).status).toBe(200);
  });

  test("bad requests", async () => {
    expect((await post("/api/repos/tasks?id=app", { action: "start", name: "nope" })).status).toBe(404);
    expect((await post("/api/repos/tasks?id=app", { action: "jump", name: "hello" })).status).toBe(400);
    expect((await post("/api/repos/tasks?id=app", { action: "start" })).status).toBe(400);
    expect((await fetch(url("/api/repos/tasks?id=missing"))).status).toBe(404);
  });

  test("every non-idle task across repos", async () => {
    const all = await get<TaskInfo[]>("/api/tasks");
    expect(all.map((t) => t.name).sort()).toEqual(["hello", "quick", "stubborn"]);
  });

  test("the record is on disk", async () => {
    const st = JSON.parse(await readFile(join(scratch, "config/tasks/state.json"), "utf8")) as Record<string, { name: string; want: string }>;
    expect(Object.values(st).find((r) => r.name === "stubborn")?.want).toBe("stopped");
    expect(Object.values(st).find((r) => r.name === "hello")?.want).toBe("running");
  });
});

describe("without tmux", () => {
  test("the routes say tasks need tmux", async () => {
    const was = process.env["CANOPY_TMUX"];
    process.env["CANOPY_TMUX"] = "0";
    const root = join(scratch, "root2");
    await mkdir(join(root, "b"), { recursive: true });
    await Bun.$`git -C ${join(root, "b")} init -q`.quiet();
    const s = await startServer({ root, port: 0, chan: null });
    try {
      expect((await fetch(`http://127.0.0.1:${s.port}/api/repos/tasks?id=b`)).status).toBe(503);
    } finally {
      s.stop();
      if (was === undefined) delete process.env["CANOPY_TMUX"];
      else process.env["CANOPY_TMUX"] = was;
    }
  });
});
```

- [ ] **Step 2: Run to see them fail**

Run: `bun test src/server/tasks.test.ts`
Expected: FAIL (`tasks` is not a startServer option; routes 404).

- [ ] **Step 3: Implement `src/server/tasks.ts`**

```ts
/**
 * The server's side of tasks: the routes, the per-task lock that keeps two
 * starts from racing, and the supervisor that watches tmux every tick and
 * tells the browsers when a repo's tasks change. A task is a tmux session
 * named like a shell, so the terminal socket joins it with `attach=1`;
 * the shell lists pass over it by its `task` tag.
 */
import { interruptTask, listTaskPanes, logPath, readLog, readTaskFiles, readTaskState, rotateIfBig, repipe, startTaskSession, taskTermId, writeTaskState, appendMark } from "../core/taskrun";
import { detectTasks, logPage, mergeTasks, normalizeTaskPatch, parseTaskFile, TASK_TIMINGS, taskStatus, isTaskName, type MergedTask, type TaskTimings } from "../core/tasks";
import { killSession, type TaskPane } from "../core/tmux";
import { loadConfig, setTask, tasksFor } from "../core/store";
import type { Repo, ServerEvent, TaskAction, TaskInfo, TaskPatch, TaskRecord, TasksResult, TermInfo } from "../core/types";

export interface TaskHubDeps {
  /** canopy's tmux argv front; null means no tasks on this backend */
  tmux: string[] | null;
  repos: () => Repo[];
  /** whether a repo is the user's, which is what lets its repo file's auto flags apply */
  own: (repo: Repo) => Promise<boolean>;
  /** the device names with a socket on a session */
  viewers: (termId: string) => string[];
  /** puts a task's session among the ones the terminal socket may join */
  hold: (info: TermInfo) => void;
  broadcast: (ev: ServerEvent) => void;
  /** said when keep running gives up on a task */
  gaveUp: (repo: string, task: string) => void;
  timings?: Partial<TaskTimings>;
}

export class TaskError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

interface Runtime {
  fails: number;
  restarts: number;
  retryAt?: number;
  timer?: ReturnType<typeof setTimeout>;
  gaveUp: boolean;
  lastStart?: number;
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const ACTIONS: readonly TaskAction[] = ["start", "stop", "restart"];

export class TaskHub {
  private readonly t: TaskTimings;
  private state: Record<string, TaskRecord> = {};
  /** the last pane list, by termId */
  private panes = new Map<string, TaskPane>();
  private rt = new Map<string, Runtime>();
  /** merged definitions by repo path, from the last read */
  private defs = new Map<string, TasksResult & { merged: MergedTask[] }>();
  /** what each repo's tasks looked like when last told, by repo id */
  private told = new Map<string, string>();
  private locks = new Map<string, Promise<unknown>>();
  private timers: ReturnType<typeof setInterval>[] = [];
  private ticking: Promise<void> | null = null;

  constructor(private readonly deps: TaskHubDeps) {
    this.t = { ...TASK_TIMINGS, ...deps.timings };
  }

  async start(): Promise<void> {
    if (!this.deps.tmux) return;
    this.state = await readTaskState();
    await this.tick();
    this.timers.push(setInterval(() => void this.poke(), this.t.tick));
  }

  stop(): void {
    for (const t of this.timers) clearInterval(t);
    for (const r of this.rt.values()) if (r.timer) clearTimeout(r.timer);
    this.timers = [];
  }

  /** one tick at a time, never stacked */
  private poke(): Promise<void> {
    if (!this.ticking) this.ticking = this.tick().catch(() => {}).finally(() => (this.ticking = null));
    return this.ticking;
  }

  /** runs `fn` after anything already running for the same task */
  private lock<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(id) ?? Promise.resolve();
    const next = prev.catch(() => {}).then(fn);
    this.locks.set(id, next);
    void next.finally(() => {
      if (this.locks.get(id) === next) this.locks.delete(id);
    });
    return next;
  }

  private runtime(id: string): Runtime {
    let r = this.rt.get(id);
    if (!r) this.rt.set(id, (r = { fails: 0, restarts: 0, gaveUp: false }));
    return r;
  }

  private async save(): Promise<void> {
    await writeTaskState(this.state);
  }

  /* ---------- definitions ---------- */

  private async defsOf(repo: Repo, fresh: boolean): Promise<TasksResult & { merged: MergedTask[] }> {
    const cached = this.defs.get(repo.path);
    if (cached && !fresh) return cached;
    const files = await readTaskFiles(repo.path);
    const file = files.repoFile !== undefined ? parseTaskFile(files.repoFile) : { patches: [], errors: [] };
    const cfg = await loadConfig();
    const { tasks, errors } = mergeTasks(detectTasks(files), file.patches, tasksFor(cfg, repo.path), await this.deps.own(repo));
    const out = { merged: tasks, tasks: [] as TaskInfo[], errors: [...file.errors, ...errors] };
    this.defs.set(repo.path, out);
    return out;
  }

  private info(repo: Repo, d: MergedTask, gone?: TaskInfo["gone"]): TaskInfo {
    const id = taskTermId(repo.path, d.name);
    const p = this.panes.get(id);
    const rec = this.state[id];
    const rt = this.rt.get(id);
    return {
      ...d,
      repoId: repo.id,
      termId: id,
      status: taskStatus({ live: p !== undefined, dead: p?.dead ?? false, want: rec?.want, exitedAt: rec?.exitedAt, exitCode: rec?.exitCode, retryAt: rt?.retryAt, gaveUp: rt?.gaveUp ?? false }),
      live: p !== undefined,
      ...(rec?.startedAt !== undefined ? { startedAt: rec.startedAt } : {}),
      ...(rec?.exitedAt !== undefined ? { exitedAt: rec.exitedAt } : {}),
      ...(rec?.exitCode !== undefined ? { exitCode: rec.exitCode } : {}),
      ...(rt?.retryAt !== undefined ? { retryAt: rt.retryAt } : {}),
      restarts: rt?.restarts ?? 0,
      viewers: this.deps.viewers(id),
      ...(gone ? { gone } : {}),
    };
  }

  /** a repo's tasks, plus any still running under a name no layer defines any more */
  async tasksOf(repo: Repo, fresh: boolean): Promise<TasksResult> {
    const d = await this.defsOf(repo, fresh);
    const tasks = d.merged.map((m) => this.info(repo, m));
    for (const p of this.panes.values()) {
      if (p.path !== repo.path || d.merged.some((m) => m.name === p.task)) continue;
      tasks.push(this.info(repo, { name: p.task, cmd: "", source: "detected" }, "definition"));
    }
    return { tasks, errors: d.errors };
  }

  /** every task that is not idle, across repos, and the ones whose repo left the scan */
  async all(): Promise<TaskInfo[]> {
    const out: TaskInfo[] = [];
    const repos = this.deps.repos();
    for (const repo of repos) {
      if (repo.forge) continue;
      const has = [...this.panes.values()].some((p) => p.path === repo.path) || Object.values(this.state).some((r) => r.path === repo.path && this.rt.get(taskTermId(r.path, r.name))?.retryAt !== undefined);
      if (!has) continue;
      out.push(...(await this.tasksOf(repo, false)).tasks.filter((t) => t.status !== "idle"));
    }
    for (const p of this.panes.values()) {
      if (repos.some((r) => r.path === p.path)) continue;
      const ghost = { id: p.repoId, name: p.repoId, path: p.path } as Repo;
      out.push(this.info(ghost, { name: p.task, cmd: "", source: "detected" }, "repo"));
    }
    return out;
  }

  /** tells the browsers a repo's tasks when they differ from what was last told */
  private async tell(repoId: string): Promise<void> {
    const repo = this.deps.repos().find((r) => r.id === repoId);
    if (!repo) return;
    const { tasks } = await this.tasksOf(repo, false);
    const text = JSON.stringify(tasks);
    if (this.told.get(repoId) === text) return;
    this.told.set(repoId, text);
    this.deps.broadcast({ type: "tasks", repoId, tasks });
  }

  /** a viewer came or went: re-tell every repo with a task session */
  refresh(): void {
    const ids = new Set([...this.panes.values()].map((p) => this.deps.repos().find((r) => r.path === p.path)?.id).filter((x): x is string => !!x));
    for (const id of ids) void this.tell(id);
  }

  /* ---------- actions ---------- */

  private need(): string[] {
    if (!this.deps.tmux) throw new TaskError(503, "tasks need tmux on this backend");
    return this.deps.tmux;
  }

  private async launch(repo: Repo, def: MergedTask): Promise<void> {
    const tmux = this.need();
    const id = taskTermId(repo.path, def.name);
    const at = Date.now();
    // set before anything touches tmux, so a tick listing meanwhile knows this run is newer
    this.runtime(id).lastStart = at;
    try {
      await appendMark(id, at, def.cmd);
    } catch (err) {
      throw new TaskError(500, `cannot write the log at ${logPath(id)}: ${err instanceof Error ? err.message : err}`);
    }
    await startTaskSession(tmux, { id, repoId: repo.id, path: repo.path, task: def.name }, repo.path, def.cmd, def.cwd);
    this.state[id] = { repoId: repo.id, path: repo.path, name: def.name, want: "running", startedAt: at };
    await this.save();
    this.panes.set(id, { termId: id, task: def.name, repoId: repo.id, path: repo.path, dead: false, code: null, createdAt: at });
    this.deps.hold({ id, repoId: repo.id, path: repo.path, place: "strip", attached: false, viewers: [], startedAt: at, task: def.name });
  }

  private running(id: string): boolean {
    const p = this.panes.get(id);
    return p !== undefined && !p.dead;
  }

  private async stopTask(repo: Repo, name: string): Promise<void> {
    const tmux = this.need();
    const id = taskTermId(repo.path, name);
    const rec = this.state[id];
    if (rec) rec.want = "stopped";
    const rt = this.runtime(id);
    if (rt.timer) clearTimeout(rt.timer);
    rt.retryAt = undefined;
    rt.timer = undefined;
    await this.save();
    if (!this.running(id)) return;
    await interruptTask(tmux, id);
    const until = Date.now() + this.t.grace;
    while (Date.now() < until) {
      await this.poke();
      if (!this.running(id)) return;
      await Bun.sleep(100);
    }
    await killSession(tmux, id);
    await this.poke();
    const after = this.state[id];
    if (after && after.exitedAt === undefined) {
      after.exitedAt = Date.now();
      after.exitCode = null;
      await this.save();
    }
  }

  async act(repo: Repo, action: TaskAction, name: string | undefined, reason?: string): Promise<TasksResult> {
    this.need();
    if (action === "start" && reason === "panel" && name === undefined) {
      const { merged } = await this.defsOf(repo, true);
      for (const def of merged.filter((m) => m.withPanel && !m.hidden)) {
        const id = taskTermId(repo.path, def.name);
        await this.lock(id, async () => {
          if (this.running(id) || this.rt.get(id)?.gaveUp) return;
          await this.launch(repo, def);
        }).catch((err) => console.error(`task ${def.name}: ${err instanceof Error ? err.message : err}`));
      }
    } else {
      if (!isTaskName(name)) throw new TaskError(400, "name the task");
      const { merged } = await this.defsOf(repo, true);
      const def = merged.find((m) => m.name === name);
      const id = taskTermId(repo.path, name);
      if (action === "stop") {
        if (!def && !this.panes.has(id)) throw new TaskError(404, `no task ${name}`);
        await this.lock(id, () => this.stopTask(repo, name));
      } else {
        if (!def) throw new TaskError(404, `no task ${name}`);
        await this.lock(id, async () => {
          if (action === "start" && this.running(id)) throw new TaskError(409, `${name} is already running`);
          const rt = this.runtime(id);
          if (rt.timer) clearTimeout(rt.timer);
          Object.assign(rt, { fails: 0, restarts: 0, gaveUp: false, retryAt: undefined, timer: undefined });
          await this.launch(repo, def);
        });
      }
    }
    await this.tell(repo.id);
    return this.tasksOf(repo, false);
  }

  /* ---------- the supervisor ---------- */

  /** one look at tmux: records deaths, holds new sessions, tells what changed */
  private async tick(): Promise<void> {
    const tmux = this.deps.tmux;
    if (!tmux) return;
    // A start that lands while the list is being read is newer than the
    // list: its pane is either missing from it or still the old dead one.
    // Those tasks keep what `launch` set rather than what the list says.
    const listedAt = Date.now();
    const newer = (id: string): boolean => (this.rt.get(id)?.lastStart ?? -1) >= listedAt;
    const list = await listTaskPanes(tmux);
    // tmux did not answer (its container restarting): say nothing, mark nothing dead
    if (list === null) return;
    const now = Date.now();
    const next = new Map(list.map((p) => [p.termId, p]));
    const changed = new Set<string>();
    let dirty = false;
    const died = (p: TaskPane, code: number | null) => {
      const rec = this.state[p.termId];
      if (!rec || rec.exitedAt !== undefined) return;
      rec.exitedAt = now;
      rec.exitCode = code;
      dirty = true;
      this.onDeath(p.termId, rec, code);
    };
    for (const [id, p] of this.panes) if (newer(id)) next.set(id, p);
    for (const p of next.values()) {
      if (newer(p.termId)) continue;
      const before = this.panes.get(p.termId);
      if (!before) {
        this.deps.hold({ id: p.termId, repoId: p.repoId, path: p.path, place: "strip", attached: false, viewers: [], startedAt: p.createdAt, task: p.task });
        changed.add(p.path);
      }
      if (p.dead && (!before || !before.dead)) {
        died(p, p.code);
        changed.add(p.path);
      }
    }
    for (const [id, before] of this.panes) {
      if (next.has(id) || newer(id)) continue;
      changed.add(before.path);
      // gone while it ran: killed from outside, which counts as a failure
      if (!before.dead) died(before, null);
    }
    this.panes = next;
    for (const [id, rt] of this.rt) {
      const p = next.get(id);
      if (p && !p.dead && rt.lastStart !== undefined && now - rt.lastStart > this.t.uptime) rt.fails = 0;
    }
    if (dirty) await this.save();
    for (const path of changed) {
      const repo = this.deps.repos().find((r) => r.path === path);
      if (repo) await this.tell(repo.id);
    }
  }

  /** what a death means for keep running; Task 7 fills this in */
  private onDeath(_id: string, _rec: TaskRecord, _code: number | null): void {}

  /* ---------- routes ---------- */

  async handle(req: Request, url: URL, repoOf: (id: string) => Repo | undefined): Promise<Response | null> {
    const path = url.pathname;
    if (path !== "/api/tasks" && path !== "/api/repos/tasks" && !path.startsWith("/api/repos/tasks/")) return null;
    const method = req.method;
    try {
      this.need();
      if (path === "/api/tasks" && method === "GET") return json(await this.all());
      const repo = repoOf(url.searchParams.get("id") ?? "");
      if (!repo) return json({ error: "unknown repo" }, 404);
      if (repo.forge) return json({ error: `${repo.name} is on the forge; there is nothing to run` }, 400);
      if (path === "/api/repos/tasks" && method === "GET") return json(await this.tasksOf(repo, true));
      if (path === "/api/repos/tasks" && method === "POST") {
        const body = (await req.json().catch(() => null)) as { action?: unknown; name?: unknown; reason?: unknown } | null;
        const action = body?.action;
        if (!ACTIONS.includes(action as TaskAction)) return json({ error: "action is start, stop or restart" }, 400);
        const name = typeof body?.name === "string" ? body.name : undefined;
        const reason = typeof body?.reason === "string" ? body.reason : undefined;
        return json(await this.act(repo, action as TaskAction, name, reason));
      }
      if (path === "/api/repos/tasks/log" && method === "GET") {
        const name = url.searchParams.get("name");
        if (!isTaskName(name)) return json({ error: "name the task" }, 400);
        const before = Number(url.searchParams.get("before"));
        const limit = Number(url.searchParams.get("limit"));
        const raw = await readLog(taskTermId(repo.path, name));
        return json(
          logPage(raw, {
            q: url.searchParams.get("q") ?? "",
            ...(Number.isFinite(before) && before > 0 ? { before } : {}),
            ...(Number.isFinite(limit) && limit > 0 ? { limit: Math.min(limit, 2000) } : {}),
          }),
        );
      }
      return json({ error: "not found" }, 404);
    } catch (err) {
      const status = err instanceof TaskError ? err.status : 500;
      return json({ error: String(err instanceof Error ? err.message : err) }, status);
    }
  }
}
```

Unused imports (`rotateIfBig`, `repipe`, `normalizeTaskPatch`, `parseTaskFile` beyond this task, `setTask`, `TaskPatch`) are used in Tasks 7 and 8; leave out any that oxlint flags now and add them back then.

- [ ] **Step 4: Wire it into `src/server/index.ts`**

1. Imports: `import { TaskHub } from "./tasks";`, `import type { TaskTimings } from "../core/tasks";`, and `accessFromUrls`, `githubLogin` from `../core/access` if not already imported.
2. `ServerState`: add `/** a repo's named processes on tmux (server/tasks) */ tasks: TaskHub;`.
3. `startServer` opts: add `/** task timings, shrunk by tests */ tasks?: Partial<TaskTimings>;`.
4. In the `state` literal, after `chan`, add:

```ts
    tasks: new TaskHub({
      tmux: tmuxBase(),
      repos: () => state.result.repos,
      own: async (repo) => {
        // no remote is never the user's by this test, and asking gh costs a process
        if (!repo.remotes?.length) return false;
        if (state.login === undefined) state.login = await githubLogin();
        return (await accessFromUrls(repo.remotes ?? [], { login: state.login, permission: state.access })) === "ok";
      },
      viewers: (id) => {
        const t = state.terms.get(id);
        return t ? termInfo(state, t).viewers : [];
      },
      hold: (info) => {
        if (!state.terms.has(info.id)) state.terms.set(info.id, { info, pty: null, sockets: new Set() });
      },
      broadcast: (ev) => broadcast(state, ev),
      gaveUp: (repo, task) => state.chan.onTaskGaveUp(repo, task),
      ...(opts.tasks ? { timings: opts.tasks } : {}),
    }),
```

(`state.chan.onTaskGaveUp` is added in Task 7; until then pass `gaveUp: () => {}` and replace it there.)

5. After `const kept = await refreshKept(state);` add `await state.tasks.start();`. In the returned `stop` function, call `state.tasks.stop();` before the server stops (find the existing `stop: () => { ... }` in the return and add it first).
6. In `handleApi`, right after the `chanRes` lines:

```ts
  const taskRes = await state.tasks.handle(req, url, (id) => state.result.repos.find((r) => r.id === id));
  if (taskRes) return taskRes;
```

7. Keep shells apart:
   - `listTerms`: when adding a session to the map, include `...(s.task ? { task: s.task } : {})` in `info`. Change the return to `return [...state.terms.values()].filter((t) => !t.info.task).map((t) => termInfo(state, t));`.
   - `tellTerms`: filter `!t.info.task` too, and call `state.tasks.refresh();` at its end.
   - `snapshotShells`: first line of the loop body, `if (live.info.task) continue;`.
   - The `DELETE /api/terms` route: before calling `endTerm`, `if (state.terms.get(id)?.info.task) return json({ error: "that is a task; stop it from its repo's tasks" }, 400);` (use the route's own variable name for the id).
   - `joinTmuxTerm` needs no change: a task's session is in `state.terms` once held, and a socket with `attach=1` joins it.

- [ ] **Step 5: Run the tests**

Run: `bun test src/server/tasks.test.ts src/server/term.test.ts src/server/keep.test.ts`
Expected: PASS. `term.test.ts` and `keep.test.ts` guard that shells behave as before.

- [ ] **Step 6: Gates and commit**

Run: `bun run typecheck && bun run lint`
Expected: PASS.

```bash
git add src/server/tasks.ts src/server/tasks.test.ts src/server/index.ts
git commit -m "feat(tasks): the task hub, its routes, start stop and restart, kept out of the shell lists"
```

---

### Task 7: Keep running, reboot recovery and start with panel

**Files:**
- Modify: `src/server/tasks.ts`
- Modify: `src/server/tailchan.ts`
- Modify: `src/server/index.ts` (the `gaveUp` dep)
- Modify: `src/server/tasks.test.ts`

**Interfaces:**
- Consumes: `TaskHub` internals from Task 6; `nextDelay`.
- Produces: `ChanHub.onTaskGaveUp(repo: string, task: string): void`; `TaskHub.onDeath` implemented; recovery inside `start()`; `POST /api/repos/tasks/def` (`{ name, def: TaskPatch | null, target: "canopy" | "repo" }`).

- [ ] **Step 1: Write the failing tests**

Add to `src/server/tasks.test.ts`. Put this `describe` in its own file-level block with its own server so its timings do not collide: create `src/server/tasks-keep.test.ts` with the same `beforeAll`/`afterAll` shape as Task 6 (copy them), a repo file of:

```json
[
  { "name": "flaky", "cmd": "echo flaky; exit 1" },
  { "name": "steady", "cmd": "echo steady; sleep 30" },
  { "name": "clean", "cmd": "echo clean; exit 0" },
  { "name": "panel", "cmd": "echo panel; sleep 30" }
]
```

and `startServer({ root, port: 0, chan: null, tasks: { tick: 100, grace: 300, backoff: 100, backoffCap: 200, giveUp: 3, uptime: 5000 } })`. Tests:

```ts
const def = (name: string, patch: object) =>
  post("/api/repos/tasks/def?id=app", { name, def: { name, ...patch }, target: "canopy" });

describe.skipIf(!tmux)("keep running", () => {
  test("canopy's layer turns keep on; a failing task backs off, then gives up", async () => {
    expect((await def("flaky", { keep: true })).status).toBe(200);
    expect((await task("flaky")).keep).toBe(true);
    await post("/api/repos/tasks?id=app", { action: "start", name: "flaky" });
    await until(async () => (await task("flaky")).status === "gave-up", "flaky to give up");
    const t = await task("flaky");
    expect(t.restarts).toBe(2);
    const log = await get<{ lines: { text: string; mark?: true }[] }>("/api/repos/tasks/log?id=app&name=flaky");
    expect(log.lines.filter((l) => l.mark).length).toBe(3);
  });

  test("a clean exit is not restarted", async () => {
    await def("clean", { keep: true });
    await post("/api/repos/tasks?id=app", { action: "start", name: "clean" });
    await until(async () => (await task("clean")).status === "exited", "clean to finish");
    await Bun.sleep(400);
    expect((await task("clean")).restarts).toBe(0);
  });

  test("a manual start clears gave-up", async () => {
    await def("flaky", { cmd: "echo fixed; sleep 30" });
    expect((await post("/api/repos/tasks?id=app", { action: "start", name: "flaky" })).status).toBe(200);
    expect((await task("flaky")).status).toBe("running");
  });

  test("start with panel starts only flagged tasks that are not running", async () => {
    await def("panel", { withPanel: true });
    expect((await post("/api/repos/tasks?id=app", { action: "start", reason: "panel" })).status).toBe(200);
    expect((await task("panel")).status).toBe("running");
    expect((await task("steady")).status).toBe("idle");
  });

  test("clearing an override and a repo-file edit", async () => {
    expect((await post("/api/repos/tasks/def?id=app", { name: "panel", def: null, target: "canopy" })).status).toBe(200);
    expect((await task("panel")).withPanel).toBeUndefined();
    expect((await post("/api/repos/tasks/def?id=app", { name: "extra", def: { name: "extra", cmd: "echo extra" }, target: "repo" })).status).toBe(200);
    const file = JSON.parse(await readFile(join(repo, ".canopy/tasks.json"), "utf8")) as { name: string }[];
    expect(file.map((t) => t.name)).toContain("extra");
    expect((await post("/api/repos/tasks/def?id=app", { name: "x", def: { name: "x", cmd: "a", cwd: "../out" }, target: "canopy" })).status).toBe(400);
  });

  test("after a restart, a keep task that was meant to run comes back", async () => {
    // Review focus 5: steady is keep + running; kill tmux and canopy, then start canopy again
    await def("steady", { keep: true });
    await post("/api/repos/tasks?id=app", { action: "start", name: "steady" });
    server.stop();
    await killServer(tmuxBase()!);
    server = await startServer({ root: join(scratch, "root"), port: 0, chan: null, tasks: { tick: 100, grace: 300, backoff: 100, backoffCap: 200, giveUp: 3, uptime: 5000 } });
    await until(async () => (await task("steady")).status === "running", "steady to come back");
  });

  test("a keep task found dead after a restart is started again", async () => {
    await def("clean", { cmd: "echo again; sleep 0.2; exit 4", keep: true });
    await post("/api/repos/tasks?id=app", { action: "start", name: "clean" });
    server.stop();
    await Bun.sleep(600); // it dies while canopy is down
    server = await startServer({ root: join(scratch, "root"), port: 0, chan: null, tasks: { tick: 100, grace: 300, backoff: 100, backoffCap: 200, giveUp: 3, uptime: 5000 } });
    await until(async () => (await task("clean")).restarts >= 1, "clean to be restarted");
  });
});
```

(`server` must be `let`; `repo` is the repo folder as in Task 6.)

- [ ] **Step 2: Run to see them fail**

Run: `bun test src/server/tasks-keep.test.ts`
Expected: FAIL (the def route is 404; nothing restarts).

- [ ] **Step 3: `ChanHub.onTaskGaveUp`**

In `src/server/tailchan.ts`, after `onFleet`:

```ts
  /** keep running gave up on a task: a DM, since someone has to look */
  onTaskGaveUp(repo: string, task: string): void {
    this.say({ to: "human", text: `${repo}: task ${task} keeps failing; canopy stopped restarting it` });
  }
```

In `index.ts` replace the placeholder with `gaveUp: (repo, task) => state.chan.onTaskGaveUp(repo, task),`.

- [ ] **Step 4: Implement keep running and recovery in `TaskHub`**

Replace `onDeath` with:

```ts
  /** A death under keep running: a restart after the backoff, or giving up
   *  after too many in a row. A clean exit, a stopped task and a task with
   *  no keep flag stay down. */
  private onDeath(id: string, rec: TaskRecord, code: number | null): void {
    if (rec.want !== "running" || code === 0) return;
    const repo = this.deps.repos().find((r) => r.path === rec.path);
    if (!repo) return;
    void this.defsOf(repo, false).then(({ merged }) => {
      const def = merged.find((m) => m.name === rec.name);
      if (!def?.keep || def.hidden) return;
      const rt = this.runtime(id);
      rt.fails += 1;
      if (rt.fails >= this.t.giveUp) {
        rt.gaveUp = true;
        this.deps.gaveUp(repo.name, def.name);
        void this.tell(repo.id);
        return;
      }
      const wait = nextDelay(rt.fails, this.t.backoff, this.t.backoffCap);
      rt.retryAt = Date.now() + wait;
      rt.timer = setTimeout(() => {
        void this.lock(id, async () => {
          rt.retryAt = undefined;
          rt.timer = undefined;
          if (this.state[id]?.want !== "running" || this.running(id)) return;
          await this.launch(repo, def);
          rt.restarts += 1;
        })
          .catch((err) => console.error(`task ${def.name}: ${err instanceof Error ? err.message : err}`))
          .finally(() => void this.tell(repo.id));
      }, wait);
      void this.tell(repo.id);
    });
  }
```

`launch` resets `lastStart`, and the tick resets `fails` after `uptime` up. With `giveUp: 3` the first run plus two restarts fail, so `restarts` is 2 when it gives up, which is what the test expects.

In `start()`, after the first `await this.tick();`, add recovery:

```ts
    // A keep task that was meant to run and has no session (the machine
    // went down, or tmux did) starts again. One that died while canopy was
    // down was caught by the tick above, through onDeath.
    for (const [id, rec] of Object.entries(this.state)) {
      if (rec.want !== "running" || this.panes.has(id)) continue;
      const repo = this.deps.repos().find((r) => r.path === rec.path);
      if (!repo) continue;
      const def = (await this.defsOf(repo, true)).merged.find((m) => m.name === rec.name);
      if (!def?.keep || def.hidden) continue;
      await this.lock(id, () => this.launch(repo, def)).catch((err) => console.error(`task ${def.name}: ${err instanceof Error ? err.message : err}`));
    }
```

The "found dead after a restart" case: the first tick sees the pane dead for the first time (`before` undefined, `p.dead`), and `died` records it only when `rec.exitedAt` is undefined, which it is, since canopy was down when it died. Good.

- [ ] **Step 5: The def route**

Add to `handle`, before the final 404:

```ts
      if (path === "/api/repos/tasks/def" && method === "POST") {
        const body = (await req.json().catch(() => null)) as { name?: unknown; def?: unknown; target?: unknown } | null;
        if (!isTaskName(body?.name)) return json({ error: "name the task" }, 400);
        const target = body?.target;
        if (target !== "canopy" && target !== "repo") return json({ error: "target is canopy or repo" }, 400);
        let patch: TaskPatch | null = null;
        if (body?.def !== null && body?.def !== undefined) {
          const p = normalizeTaskPatch({ ...(body.def as object), name: body.name });
          if (typeof p === "string") return json({ error: p }, 400);
          patch = p;
        }
        await this.setDef(repo, body.name, patch, target);
        return json(await this.tasksOf(repo, true));
      }
```

and the method:

```ts
  /** stores one task's definition in canopy's layer or rewrites it in the repo file */
  private async setDef(repo: Repo, name: string, patch: TaskPatch | null, target: "canopy" | "repo"): Promise<void> {
    if (target === "canopy") {
      await setTask(repo.path, name, patch);
    } else {
      if (repo.host) throw new TaskError(400, "the repo file can only be written for a repo on this machine");
      const file = join(repo.path, ".canopy", "tasks.json");
      let list: TaskPatch[] = [];
      try {
        const parsed = parseTaskFile(await readFile(file, "utf8"));
        if (parsed.errors.length) throw new TaskError(409, `fix .canopy/tasks.json first: ${parsed.errors[0]}`);
        list = parsed.patches;
      } catch (err) {
        if (err instanceof TaskError) throw err;
        // no file yet
      }
      list = list.filter((t) => t.name !== name);
      if (patch) list.push(patch);
      await mkdir(join(repo.path, ".canopy"), { recursive: true });
      await writeFile(file, JSON.stringify(list, null, 2) + "\n");
    }
    this.defs.delete(repo.path);
    await this.tell(repo.id);
  }
```

with `import { mkdir, readFile, writeFile } from "node:fs/promises"; import { join } from "node:path";` and `nextDelay` added to the tasks import.

- [ ] **Step 6: Run the tests**

Run: `bun test src/server/tasks.test.ts src/server/tasks-keep.test.ts`
Expected: PASS.

- [ ] **Step 7: Gates and commit**

Run: `bun run typecheck && bun run lint`

```bash
git add src/server/tasks.ts src/server/tasks-keep.test.ts src/server/tasks.test.ts src/server/tailchan.ts src/server/index.ts
git commit -m "feat(tasks): keep running with backoff, recovery after a restart, start with panel, and editing"
```

---

### Task 8: Rotation and the sweep

**Files:**
- Modify: `src/server/tasks.ts`
- Create: `src/server/tasks-sweep.test.ts`

**Interfaces:**
- Consumes: `rotateIfBig`, `repipe`, `listLogs`, `removeLog`, `expiredTaskLogs`, `reapable`, `staleWants`.
- Produces: rotation inside `tick()`; `sweep()` on its own interval in `start()`.

- [ ] **Step 1: Write the failing tests**

Create `src/server/tasks-sweep.test.ts` with the same scaffolding as Task 6 and a repo file:

```json
[
  { "name": "flood", "cmd": "i=0; while [ $i -lt 400 ]; do echo line-$i-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx; i=$((i+1)); sleep 0.01; done; echo flood-done; sleep 30" },
  { "name": "brief", "cmd": "echo brief; exit 2" },
  { "name": "orphan", "cmd": "echo orphan; sleep 30" }
]
```

Server timings: `{ tick: 100, grace: 300, logCap: 4096, reap: 300, sweep: 200, logAge: 0 }`. Tests:

```ts
describe.skipIf(!tmux)("rotation and the sweep", () => {
  test("a flood crosses the cap and keeps logging after the rotation", async () => {
    // Review focus 4
    await post("/api/repos/tasks?id=app", { action: "start", name: "flood" });
    const t = await task("flood");
    const dir = join(scratch, "config/tasks/logs");
    const old = Bun.file(join(dir, `${t.termId}.log.1`));
    const cur = () => Bun.file(join(dir, `${t.termId}.log`));
    await until(async () => old.exists(), "a rotation");
    // the flood runs for seconds, so lines keep coming after a rotation: they
    // must land in a new current file, which only a re-attached pipe writes
    await until(async () => (await cur().exists()) && cur().size > 0, "output after the rotation");
    await until(async () => (await get<{ lines: { text: string }[] }>("/api/repos/tasks/log?id=app&name=flood&q=flood-done")).lines.length === 1, "the end of the flood");
  });

  test("a dead pane nobody watches is reaped, and its exit line stays", async () => {
    await post("/api/repos/tasks?id=app", { action: "start", name: "brief" });
    await until(async () => (await task("brief")).status === "failed", "brief to fail");
    await until(async () => !(await task("brief")).live, "brief's pane to be reaped");
    const t = await task("brief");
    expect(t.status).toBe("failed");
    expect(t.exitCode).toBe(2);
  });

  test("an orphan keeps running through a sweep; a gone task's log and record go once it stops", async () => {
    await post("/api/repos/tasks?id=app", { action: "start", name: "orphan" });
    const id = (await task("orphan")).termId;
    await writeFile(join(repo, ".canopy/tasks.json"), JSON.stringify([{ name: "brief", cmd: "echo brief; exit 2" }, { name: "flood", cmd: "true" }]));
    await Bun.sleep(600); // a few sweeps
    const all = await get<{ name: string; gone?: string; status: string }[]>("/api/tasks");
    expect(all.find((t) => t.name === "orphan")).toMatchObject({ gone: "definition", status: "running" });
    expect((await post("/api/repos/tasks?id=app", { action: "stop", name: "orphan" })).status).toBe(200);
    await until(async () => !(await Bun.file(join(scratch, `config/tasks/logs/${id}.log`)).exists()), "the orphan's log to go");
    const st = JSON.parse(await readFile(join(scratch, "config/tasks/state.json"), "utf8")) as Record<string, unknown>;
    expect(st[id]).toBeUndefined();
  });
});
```

The stop of an orphan kills its session (it ignores nothing, so ^C ends it); the dead pane is then reaped after `reap`, after which the log and record expire at `logAge: 0`.

- [ ] **Step 2: Run to see them fail**

Run: `bun test src/server/tasks-sweep.test.ts`
Expected: FAIL (no `.log.1`; the pane is never reaped).

- [ ] **Step 3: Implement**

In `tick()`, after `this.panes = next;`:

```ts
    for (const p of next.values()) {
      if (!p.dead && (await rotateIfBig(p.termId, this.t.logCap))) await repipe(tmux, p.termId);
    }
```

In `start()`, after the tick interval: `this.timers.push(setInterval(() => void this.sweep().catch(() => {}), this.t.sweep));`

Add:

```ts
  /** Clears what gone tasks left: dead panes nobody watches, then logs and
   *  records of tasks with no definition and no session. Never a live process. */
  private async sweep(): Promise<void> {
    const tmux = this.deps.tmux;
    if (!tmux) return;
    const now = Date.now();
    for (const p of this.panes.values()) {
      const rec = this.state[p.termId];
      if (reapable({ dead: p.dead, ...(rec?.exitedAt !== undefined ? { exitedAt: rec.exitedAt } : {}), viewers: this.deps.viewers(p.termId).length }, now, this.t.reap)) {
        await killSession(tmux, p.termId);
      }
    }
    await this.tick();
    const live = new Set(this.panes.keys());
    const logs = await listLogs();
    const known = new Map<string, boolean | null>();
    for (const id of new Set([...logs.map((l) => l.termId), ...Object.keys(this.state)])) {
      const rec = this.state[id];
      const repo = rec ? this.deps.repos().find((r) => r.path === rec.path) : undefined;
      if (!rec || !repo) known.set(id, false);
      else if (repo.host) known.set(id, null);
      else known.set(id, (await this.defsOf(repo, true)).merged.some((m) => m.name === rec.name));
    }
    const defined = (id: string) => known.get(id) ?? false;
    for (const id of expiredTaskLogs(logs, live, defined, now, this.t.logAge)) await removeLog(id);
    const stale = staleWants(this.state, live, defined);
    for (const id of stale) delete this.state[id];
    if (stale.length) await this.save();
  }
```

A reaped pane disappears from the next tick; since `before.dead` was true, `died` is not called again and its exit line stays in the record. Add the new names to the imports.

- [ ] **Step 4: Run the tests**

Run: `bun test src/server/tasks-sweep.test.ts src/server/tasks.test.ts src/server/tasks-keep.test.ts`
Expected: PASS.

- [ ] **Step 5: Gates and commit**

```bash
bun run typecheck && bun run lint
git add src/server/tasks.ts src/server/tasks-sweep.test.ts
git commit -m "feat(tasks): rotate logs past the cap and sweep what gone tasks leave"
```

---

### Task 9: UI data: api, store, words and the feed

**Files:**
- Create: `ui/src/tasks.ts`
- Create: `ui/src/tasks.test.ts`
- Modify: `ui/src/api.ts`, `ui/src/store.ts`, `ui/src/feed.ts`, `ui/src/components/Feed.tsx`, `ui/src/qualify.test.ts`

**Interfaces:**
- Consumes: `TaskInfo`, `TasksResult`, `TaskLogPage`, `TaskAction`, `TaskPatch` types; `qTask` (Task 1).
- Produces (ui/src/tasks.ts): `STATUS_WORD: Record<TaskStatus, string>`; `taskChip(tasks: TaskInfo[]): { text: string; bad: boolean; title: string } | null`; `taskWhen(t: TaskInfo, now: number): string`; `taskLines(prev: TaskInfo[] | undefined, next: TaskInfo[], now: number): string[]`; `devTask(tasks): TaskInfo | undefined`; `markTime(at: number): string`.
- Produces (api): `api.tasks(id): Promise<TasksResult>`, `api.taskAct(id, action, name?, reason?): Promise<TasksResult>`, `api.taskDef(id, name, def, target): Promise<TasksResult>`, `api.taskLog(id, name, q?, before?): Promise<TaskLogPage>`, `api.allTasks(b?): Promise<TaskInfo[]>`.
- Produces (store): `tasks: Record<string, TaskInfo[]>` by repo id, `taskErrors: Record<string, string[]>`, `taskAll: TaskInfo[]`, `loadTasks(repoId)`, `taskAct(repoId, action, name?)`, `saveTaskDef(repoId, name, def, target)`, `startPanelTasks(repoId)`; selector `tasksOf(s, repoId): TaskInfo[]` (through `useShallow`).

- [ ] **Step 1: Write the failing tests**

Create `ui/src/tasks.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import type { TaskInfo } from "../../src/core/types";
import { devTask, taskChip, taskLines, taskWhen } from "./tasks";

const t = (over: Partial<TaskInfo>): TaskInfo => ({ name: "dev", cmd: "x", repoId: "r", source: "detected", termId: "0".repeat(32), status: "idle", live: false, restarts: 0, viewers: [], ...over });

describe("task words", () => {
  test("the chip: running count, or the first failure", () => {
    expect(taskChip([t({})])).toBeNull();
    expect(taskChip([t({ status: "running" }), t({ name: "b", status: "running" })])?.text).toBe("▶ 2");
    expect(taskChip([t({ status: "running" }), t({ name: "test", status: "failed" })])).toMatchObject({ text: "✕ test", bad: true });
    expect(taskChip([t({ status: "gave-up" })])?.bad).toBe(true);
  });
  test("when", () => {
    expect(taskWhen(t({ status: "running", startedAt: 0 }), 125_000)).toBe("up 2m");
    expect(taskWhen(t({ status: "failed", exitCode: 1, exitedAt: 0 }), 180_000)).toBe("exit 1 · 3m ago");
    expect(taskWhen(t({ status: "exited", exitCode: 0, exitedAt: 0 }), 10_000)).toBe("exit 0 · now");
    expect(taskWhen(t({ status: "backoff", retryAt: 4_000 }), 0)).toBe("retry in 4s");
    expect(taskWhen(t({ status: "gave-up" }), 0)).toBe("gave up");
    expect(taskWhen(t({}), 0)).toBe("");
  });
  test("feed lines on transitions only", () => {
    const run = [t({ status: "running" })];
    expect(taskLines(undefined, run, 0)).toEqual(["dev started"]);
    expect(taskLines(run, run, 0)).toEqual([]);
    expect(taskLines(run, [t({ status: "failed", exitCode: 1 })], 0)).toEqual(["dev exited 1"]);
    expect(taskLines(run, [t({ status: "exited", exitCode: 130 })], 0)).toEqual(["dev stopped"]);
    expect(taskLines(run, [t({ status: "exited", exitCode: 0 })], 0)).toEqual(["dev finished"]);
    expect(taskLines([t({ status: "failed" })], [t({ status: "backoff", retryAt: 2000 })], 0)).toEqual(["dev restarting in 2s"]);
    expect(taskLines([t({ status: "backoff" })], [t({ status: "running", restarts: 1 })], 0)).toEqual(["dev restarted (1)"]);
    expect(taskLines([t({ status: "failed" })], [t({ status: "gave-up" })], 0)).toEqual(["dev gave up"]);
  });
  test("the dev task", () => {
    expect(devTask([t({ name: "a" }), t({ name: "b", dev: true })])?.name).toBe("b");
    expect(devTask([t({ dev: true, hidden: true })])).toBeUndefined();
  });
});
```

Add to `ui/src/qualify.test.ts`:

```ts
test("a task's repo and session ids are qualified", () => {
  const q = (id: string) => `mini|${id}`;
  const info = { name: "dev", cmd: "x", repoId: "app", source: "detected", termId: "a".repeat(32), status: "idle", live: false, restarts: 0, viewers: [] } as const;
  expect(qTask(q, info)).toMatchObject({ repoId: "mini|app", termId: `mini|${"a".repeat(32)}` });
  expect(qEvent(q, { type: "tasks", repoId: "app", tasks: [info] })).toMatchObject({ repoId: "mini|app", tasks: [{ repoId: "mini|app" }] });
});
```

- [ ] **Step 2: Run to see them fail**

Run: `bun test ui/src/tasks.test.ts ui/src/qualify.test.ts`
Expected: FAIL (no `./tasks` module).

- [ ] **Step 3: Implement `ui/src/tasks.ts`**

```ts
/** The words tasks are shown with: a status, a chip, a line of when, and the
 *  feed's lines for a change. Pure, and tested. */
import type { TaskInfo, TaskStatus } from "../../src/core/types";

export const STATUS_WORD: Record<TaskStatus, string> = {
  idle: "idle",
  running: "running",
  exited: "exited",
  failed: "failed",
  backoff: "restarting",
  "gave-up": "gave up",
};

const bad = (t: TaskInfo): boolean => t.status === "failed" || t.status === "gave-up";

/** a card's chip: `✕ name` for the first task in trouble, else `▶ n` running, else nothing */
export function taskChip(tasks: readonly TaskInfo[]): { text: string; bad: boolean; title: string } | null {
  const trouble = tasks.find(bad);
  if (trouble) return { text: `✕ ${trouble.name}`, bad: true, title: `${trouble.name} ${STATUS_WORD[trouble.status]}` };
  const running = tasks.filter((t) => t.status === "running" || t.status === "backoff");
  if (!running.length) return null;
  return { text: `▶ ${running.length}`, bad: false, title: running.map((t) => t.name).join(", ") };
}

const span = (ms: number): string => {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
};

/** "up 2m", "exit 1 · 3m ago", "retry in 4s", "gave up", or nothing for an idle task */
export function taskWhen(t: TaskInfo, now: number): string {
  switch (t.status) {
    case "running":
      return t.startedAt !== undefined ? `up ${span(now - t.startedAt)}` : "running";
    case "exited":
    case "failed": {
      const ago = t.exitedAt === undefined ? "" : now - t.exitedAt < 60_000 ? " · now" : ` · ${span(now - t.exitedAt)} ago`;
      return `exit ${t.exitCode ?? "?"}${ago}`;
    }
    case "backoff":
      return t.retryAt !== undefined ? `retry in ${span(t.retryAt - now)}` : "restarting";
    case "gave-up":
      return "gave up";
    case "idle":
      return "";
  }
}

/** what the feed says about a repo's tasks changing, one line per task that moved */
export function taskLines(prev: readonly TaskInfo[] | undefined, next: readonly TaskInfo[], now: number): string[] {
  const lines: string[] = [];
  for (const t of next) {
    const was = prev?.find((p) => p.name === t.name);
    if (was?.status === t.status) continue;
    switch (t.status) {
      case "running":
        lines.push(t.restarts > (was?.restarts ?? 0) ? `${t.name} restarted (${t.restarts})` : `${t.name} started`);
        break;
      case "failed":
        lines.push(`${t.name} exited ${t.exitCode ?? "?"}`);
        break;
      case "exited":
        lines.push(t.exitCode === 0 ? `${t.name} finished` : `${t.name} stopped`);
        break;
      case "backoff":
        lines.push(`${t.name} restarting in ${span((t.retryAt ?? now) - now)}`);
        break;
      case "gave-up":
        lines.push(`${t.name} gave up`);
        break;
      case "idle":
        break;
    }
  }
  return lines;
}

export const devTask = (tasks: readonly TaskInfo[]): TaskInfo | undefined => tasks.find((t) => t.dev && !t.hidden);

/** a start marker's time as the local clock shows it */
export const markTime = (at: number): string =>
  new Date(at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" });
```

- [ ] **Step 4: api**

In `ui/src/api.ts` (import `qTask` and the task types), add to `api` near the launcher entries:

```ts
  tasks: async (id: string) => {
    const [b, plain] = on(id);
    const r = await req<TasksResult>(b, `/api/repos/tasks?${rq(plain)}`);
    return { ...r, tasks: fromAll(b, r.tasks, qTask) };
  },
  taskAct: async (id: string, action: TaskAction, name?: string, reason?: string) => {
    const [b, plain] = on(id);
    const r = await req<TasksResult>(b, `/api/repos/tasks?${rq(plain)}`, {
      method: "POST",
      body: JSON.stringify({ action, ...(name ? { name } : {}), ...(reason ? { reason } : {}) }),
    });
    return { ...r, tasks: fromAll(b, r.tasks, qTask) };
  },
  taskDef: async (id: string, name: string, def: TaskPatch | null, target: "canopy" | "repo") => {
    const [b, plain] = on(id);
    const r = await req<TasksResult>(b, `/api/repos/tasks/def?${rq(plain)}`, { method: "POST", body: JSON.stringify({ name, def, target }) });
    return { ...r, tasks: fromAll(b, r.tasks, qTask) };
  },
  taskLog: (id: string, name: string, q = "", before?: number) =>
    repoReq<TaskLogPage>(id, (p) => `/api/repos/tasks/log?${rq(p, { name, q, ...(before ? { before: String(before) } : {}) })}`),
  allTasks: async (b: string = homeName()) => fromAll(b, await req<TaskInfo[]>(b, "/api/tasks"), qTask),
```

- [ ] **Step 5: store**

In `ui/src/store.ts`:

1. State fields (with the job fields): `tasks: Record<string, TaskInfo[]>; taskErrors: Record<string, string[]>; taskAll: TaskInfo[];` initialised to `{}`, `{}`, `[]`.
2. Actions in the interface and implementation:

```ts
  /** reads a repo's tasks from its backend */
  loadTasks: (repoId: string) => Promise<void>;
  taskAct: (repoId: string, action: TaskAction, name?: string) => Promise<void>;
  saveTaskDef: (repoId: string, name: string, def: TaskPatch | null, target: "canopy" | "repo") => Promise<void>;
  /** opening a panel starts its tasks flagged to start with it */
  startPanelTasks: (repoId: string) => void;
```

```ts
  loadTasks: async (repoId) => {
    const r = await api.tasks(repoId);
    set((s) => ({ tasks: { ...s.tasks, [repoId]: r.tasks }, taskErrors: { ...s.taskErrors, [repoId]: r.errors } }));
  },
  taskAct: async (repoId, action, name) => {
    const r = await api.taskAct(repoId, action, name);
    set((s) => ({ tasks: { ...s.tasks, [repoId]: r.tasks } }));
  },
  saveTaskDef: async (repoId, name, def, target) => {
    const r = await api.taskDef(repoId, name, def, target);
    set((s) => ({ tasks: { ...s.tasks, [repoId]: r.tasks }, taskErrors: { ...s.taskErrors, [repoId]: r.errors } }));
  },
  startPanelTasks: (repoId) => {
    const repo = get().repos.find((r) => r.id === repoId);
    if (!repo || repo.forge) return;
    // nothing flagged is the common case, and the answer is the list anyway
    api
      .taskAct(repoId, "start", undefined, "panel")
      .then((r) => set((s) => ({ tasks: { ...s.tasks, [repoId]: r.tasks } })))
      .catch(() => {});
  },
```

3. In `applyEvent`, before the `terms` branch:

```ts
    } else if (ev.type === "tasks") {
      set((s) => {
        const others = s.taskAll.filter((t) => t.repoId !== ev.repoId);
        return { tasks: { ...s.tasks, [ev.repoId]: ev.tasks }, taskAll: [...others, ...ev.tasks.filter((t) => t.status !== "idle")] };
      });
```

4. At init, after the terms are loaded for each backend, load `taskAll` (ignore a 503 from a backend without tmux):

```ts
      api.allTasks(b).then((list) => set((s) => ({ taskAll: [...s.taskAll.filter((t) => backendOf(t.repoId) !== b), ...list] })), () => {});
```

5. When a backend is hidden (the block that calls `recordOut(s.jobs, name)`), add `tasks: recordOut(s.tasks, name), taskAll: s.taskAll.filter((t) => backendOf(t.repoId) !== name),`.
6. Selector at the bottom, next to `jobsFor`:

```ts
const NO_TASKS: TaskInfo[] = [];
/** a repo's tasks as last read or told; a stable empty list when none */
export const tasksOf = (s: CanopyState, repoId: string): TaskInfo[] => s.tasks[repoId] ?? NO_TASKS;
```

7. Call `startPanelTasks` from `openPanel` right after the panel is added (the action that opens a repo's panel; only when the panel was not already open).
8. Add `tasks: s.tasks` to `feedView` and a `tasks?: Record<string, TaskInfo[]>` field to `FeedSnapshot` in `feed.ts`.

- [ ] **Step 6: feed**

In `ui/src/feed.ts`: add `"task"` to `FeedKind`; replace the placeholder case with:

```ts
    case "tasks": {
      const repo = prev.repos.find((r) => r.id === ev.repoId);
      return taskLines(prev.tasks?.[ev.repoId], ev.tasks, at).map((text) => about(repo, "task", at, text));
    }
```

(import `taskLines` from `./tasks`). In `ui/src/components/Feed.tsx`, add `task: "task",` to `KIND_WORD` and to the chips list if the chips come from a separate array.

- [ ] **Step 7: Run tests and gates**

Run: `bun test ui/src && bun run typecheck && bun run lint`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add ui/src/tasks.ts ui/src/tasks.test.ts ui/src/api.ts ui/src/store.ts ui/src/feed.ts ui/src/components/Feed.tsx ui/src/qualify.test.ts
git commit -m "feat(tasks): the ui's task data, words and feed lines"
```

---

### Task 10: The tasks panel section, and a task's terminal as a panel tab

**Files:**
- Create: `ui/src/components/Tasks.tsx`
- Modify: `ui/src/surface.ts`, `ui/src/surface.test.ts`, `ui/src/components/Dock.tsx`, `ui/src/term.ts`, `ui/src/components/TermDock.tsx`, `ui/src/store.ts`, `ui/src/styles.css`

**Interfaces:**
- Consumes: store `tasksOf`, `loadTasks`, `taskAct`, `taskErrors`, `joinTerm`; `api.taskLog`; `Section`, `useSectionClosed`; `markTime`, `STATUS_WORD`, `taskWhen`.
- Produces: `TasksSection({ repo })`; section key `tasks`; `TermTab.task?: string`; store `openTaskTab(repoId, task: TaskInfo, place: ShellPlace)`, `editTask(repoId, name: string | null)`, `showTasks(repoId)`; `Sheet` kind `{ kind: "task"; repoId: string; name: string | null }`.

**Why the terminal is not inline.** css `zoom` sits on `.panel-body` and on a section's `.section-main`, and an xterm under a zoomed ancestor gets its mouse and selection off by the factor (CLAUDE.md). The panel's shells footer is outside both and already has a drag-resizable height. So clicking a running task opens its terminal as a tab in that footer (`openTaskTab`), and the section itself shows the task's log. This refines the spec's "terminal under the list". A task tab is not restored after a reload (it is not a held shell, so `reconcileTerms` drops it); one click brings it back.

- [ ] **Step 1: Section key**

In `ui/src/surface.ts`: `SECTION_KEYS = ["changes", "tasks", "search", "history", "peers", "preview", "launch", "claude"]` and `SECTION_WORD.tasks = "tasks"`. `sectionOrder` already inserts a key a saved order lacks after its nearest earlier neighbour, so saved layouts get `tasks` right after `changes`. Add to `ui/src/surface.test.ts`:

```ts
test("a saved order from before tasks gets them after changes", () => {
  expect(sectionOrder(["changes", "search", "history", "peers", "preview", "launch", "claude"])).toEqual([...SECTION_KEYS]);
});
```

Update any test that pins the old key list. Run `bun test ui/src/surface.test.ts`; expected PASS.

- [ ] **Step 2: `TermTab.task`, attach-only sockets, and tabs that never end a task**

In `ui/src/term.ts` `TermTab`, add:

```ts
  /** the task this tab shows; closing the tab never stops it, and its
   *  socket only ever joins, never starts a shell under the task's id */
  task?: string;
```

In `ui/src/components/TermDock.tsx` `socketUrl`: `if (rejoin || tab.task) q.set("attach", "1");`.

In `ui/src/store.ts` `closeTerm`: replace `endShells([tab]);` with `if (!tab.task) endShells([tab]);`. Check `closePanel` and any other caller of `endShells` the same way (a task tab must never reach `DELETE /api/terms`; the server refuses it with 400 anyway).

- [ ] **Step 3: Store actions**

In `ui/src/store.ts`, add to `Sheet`: `| { kind: "task"; repoId: string; name: string | null }`. Add to the interface and implementation, next to `editLaunch` and `showLaunch`:

```ts
  /** the add or edit sheet for a repo's task; null adds one */
  editTask: (repoId: string, name: string | null) => void;
  /** opens a repo's panel with its tasks unfolded */
  showTasks: (repoId: string) => void;
  /** a task's terminal as a tab among the panel's shells or the strip's; closing it leaves the task running */
  openTaskTab: (repoId: string, task: TaskInfo, place: ShellPlace) => void;
```

```ts
  editTask: (repoId, name) => set({ sheet: { kind: "task", repoId, name } }),
  showTasks: (repoId) =>
    set((s) => ({
      ...focusPanel(s.panels, repoId),
      closedSections: unfoldIn(s.closedSections, repoId, "tasks"),
    })),
  openTaskTab: (repoId, task, place) => {
    const s = get();
    const repo = s.repos.find((r) => r.id === repoId);
    if (!repo) return;
    if (!s.terms.some((t) => t.id === task.termId)) {
      const tab: TermTab = { id: task.termId, repoId, name: `${repo.name} · ${task.name}`, path: repo.path, place, task: task.name };
      set({ terms: [...s.terms, tab] });
    }
    get().joinTerm(task.termId);
  },
```

`joinTerm` shows an existing tab (opening its panel and unfolding the shell section for a panel tab). Read it first; if it only handles ids in `shells`, add a branch at its top: a tab already in `terms` is focused the way `openTerm` focuses a new one. In `RunSheet.tsx`'s `Body`, add `if (sheet.kind === "task") return null;` for now (Task 11 fills it) and include `"task"` in `sheetRepoId`'s list of kinds with a `repoId`.

- [ ] **Step 4: The section**

Create `ui/src/components/Tasks.tsx`:

```tsx
import { useEffect, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { api } from "../api";
import { tasksOf, useStore } from "../store";
import { markTime, STATUS_WORD, taskWhen } from "../tasks";
import type { Repo, TaskInfo, TaskLogLine } from "../../../src/core/types";
import { Section, useSectionClosed } from "./Surface";

const errText = (err: unknown) => String(err instanceof Error ? err.message : err);

/** how often a running task's log tail is read again while it shows */
const TAIL_EVERY = 2000;

/** the glyphs after a task's name for the flags it has */
function Flags({ t }: { t: TaskInfo }) {
  return (
    <span className="task-flags">
      {t.dev && <span title="the dev task, the one the preview pairs with">◉</span>}
      {t.keep && <span title="keep running: restarted when it fails and after a restart">↻</span>}
      {t.withPanel && <span title="starts when the panel opens">▣</span>}
    </span>
  );
}

/** A repo's tasks: one line each with start, stop and restart. A click on a
 *  running task opens its terminal among the panel's shells; the picked
 *  task's log shows under the list, searchable. */
export function TasksSection({ repo }: { repo: Repo }) {
  const closed = useSectionClosed(repo.id, "tasks");
  const tasks = useStore(useShallow((s) => tasksOf(s, repo.id)));
  const errors = useStore((s) => s.taskErrors[repo.id]);
  const loadTasks = useStore((s) => s.loadTasks);
  const taskAct = useStore((s) => s.taskAct);
  const editTask = useStore((s) => s.editTask);
  const openTaskTab = useStore((s) => s.openTaskTab);
  const [open, setOpen] = useState<string | null>(null);
  const [showHidden, setShowHidden] = useState(false);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (closed) return;
    loadTasks(repo.id).catch((e: unknown) => setError(errText(e)));
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(tick);
  }, [closed, repo.id, loadTasks]);

  const act = async (action: "start" | "stop" | "restart", name: string) => {
    setBusy(`${action}:${name}`);
    setError(null);
    try {
      await taskAct(repo.id, action, name);
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy("");
    }
  };

  const pick = (t: TaskInfo) => {
    setOpen(open === t.name ? null : t.name);
    if (t.live && open !== t.name) openTaskTab(repo.id, t, "panel");
  };

  const shown = tasks.filter((t) => showHidden || !t.hidden);
  const hidden = tasks.filter((t) => t.hidden).length;
  const running = tasks.filter((t) => t.status === "running").length;
  const picked = shown.find((t) => t.name === open) ?? null;

  return (
    <Section
      repo={repo}
      k="tasks"
      className="tasks"
      label="Tasks"
      head={running ? `${running} running` : tasks.length ? String(tasks.length) : ""}
      title="The repo's dev server, tests and builds, run and watched by canopy"
      copy={() => shown.map((t) => `${t.name}  ${STATUS_WORD[t.status]}  ${t.cmd}`).join("\n")}
    >
      {errors?.map((e) => (
        <p key={e} className="note err">
          {e}
        </p>
      ))}
      {error && <p className="note err">{error}</p>}
      {shown.length === 0 ? (
        <p className="panel-clean">No tasks yet. Add one, or give the repo a package.json, Cargo.toml or Makefile.</p>
      ) : (
        <ul className="task-list">
          {shown.map((t) => (
            <li key={t.name} className={`task-row ${t.status}${open === t.name ? " open" : ""}`}>
              <button type="button" className="task-main" onClick={() => pick(t)} aria-expanded={open === t.name}>
                <span className={`task-dot ${t.status}`} aria-label={STATUS_WORD[t.status]} />
                <span className="task-name">{t.name}</span>
                <Flags t={t} />
                <span className="task-cmd" title={t.cmd}>
                  {t.cmd}
                </span>
                {t.source !== "detected" && <span className="task-source">{t.source}</span>}
                {t.gone && <span className="task-source">not defined</span>}
                <span className="task-when">{taskWhen(t, now)}</span>
              </button>
              <span className="task-actions">
                {t.status === "running" ? (
                  <>
                    <button type="button" className="mini" disabled={!!busy} onClick={() => void act("restart", t.name)} title="Restart">
                      ↻
                    </button>
                    <button type="button" className="mini" disabled={!!busy} onClick={() => void act("stop", t.name)} title="Stop">
                      ■
                    </button>
                  </>
                ) : t.status === "backoff" ? (
                  <button type="button" className="mini" disabled={!!busy} onClick={() => void act("stop", t.name)} title="Stop restarting">
                    ■
                  </button>
                ) : (
                  !t.gone && (
                    <button type="button" className="mini" disabled={!!busy} onClick={() => void act("start", t.name)} title="Start">
                      ▶
                    </button>
                  )
                )}
                {!t.gone && (
                  <button type="button" className="mini" onClick={() => editTask(repo.id, t.name)} title="Edit">
                    ⋯
                  </button>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
      <div className="task-foot">
        <button type="button" className="mini" onClick={() => editTask(repo.id, null)}>
          add task
        </button>
        {hidden > 0 && (
          <button type="button" className="mini" onClick={() => setShowHidden(!showHidden)}>
            {showHidden ? "leave hidden out" : `${hidden} hidden`}
          </button>
        )}
      </div>
      {picked && <TaskLog repo={repo} task={picked} />}
    </Section>
  );
}

/** The picked task's log: its tail, read again while it runs, or the lines matching a search. */
function TaskLog({ repo, task }: { repo: Repo; task: TaskInfo }) {
  const [q, setQ] = useState("");
  const [lines, setLines] = useState<TaskLogLine[] | null>(null);
  const [more, setMore] = useState(false);

  useEffect(() => {
    let live = true;
    const read = () =>
      api
        .taskLog(repo.id, task.name, q)
        .then((p) => {
          if (!live) return;
          setLines(p.lines);
          setMore(p.more);
        })
        .catch(() => {});
    const first = setTimeout(read, q ? 250 : 0);
    const again = task.status === "running" && !q ? setInterval(read, TAIL_EVERY) : null;
    return () => {
      live = false;
      clearTimeout(first);
      if (again) clearInterval(again);
    };
  }, [repo.id, task.name, task.status, q]);

  return (
    <div className="task-open">
      <input className="task-search" type="search" placeholder={`search ${task.name}'s log`} value={q} onChange={(e) => setQ(e.target.value)} />
      <pre className="task-log">
        {more && <span className="task-more">{q ? "earlier lines match too" : "earlier lines are in the log"}{"\n"}</span>}
        {lines?.map((l) => (
          <span key={l.n} className={l.mark ? "task-mark" : undefined}>
            {l.mark && l.at !== null ? `── started ${markTime(l.at)} ──` : l.text}
            {"\n"}
          </span>
        ))}
        {lines?.length === 0 && (q ? "no match" : "nothing logged yet")}
      </pre>
    </div>
  );
}
```

`useShallow` import path: use whichever path `Shells.tsx` or `Dock.tsx` already imports it from.

- [ ] **Step 5: Place it**

In `ui/src/components/Dock.tsx` `PanelSection`: `case "tasks": return repo.forge ? null : <TasksSection repo={repo} />;` (import it).

- [ ] **Step 6: Styles**

Add to `ui/src/styles.css`. Before pasting, look up the stylesheet's monospace font variable and the hover background the file table uses, and use those in place of `var(--mono)` and the `color-mix` line:

```css
.task-list { list-style: none; margin: 0; padding: 0; display: grid; gap: 2px; }
.task-row { display: flex; align-items: center; gap: 6px; }
.task-main { flex: 1; min-width: 0; display: flex; align-items: center; gap: 8px; background: none; border: 0; padding: 3px 4px; color: inherit; font: inherit; text-align: left; cursor: pointer; border-radius: 4px; }
.task-main:hover, .task-row.open .task-main { background: color-mix(in srgb, var(--ink) 6%, transparent); }
.task-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--ink-faint); flex: none; }
.task-dot.running { background: var(--moss); }
.task-dot.backoff { background: var(--sky); }
.task-dot.failed, .task-dot.gave-up { background: var(--rust); }
.task-name { font-weight: 600; }
.task-flags { color: var(--ink-dim); font-size: 0.85em; display: inline-flex; gap: 2px; }
.task-cmd { color: var(--ink-dim); font-family: var(--mono); font-size: 0.85em; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; flex: 1; }
.task-source { font-size: 0.75em; color: var(--ink-dim); border: 1px solid currentColor; border-radius: 3px; padding: 0 3px; }
.task-when { color: var(--ink-dim); font-size: 0.85em; white-space: nowrap; }
.task-actions { display: inline-flex; gap: 2px; }
.task-foot { display: flex; gap: 6px; margin-top: 6px; }
.task-open { margin-top: 6px; display: grid; gap: 4px; }
.task-log { max-height: 16rem; overflow: auto; margin: 0; font-family: var(--mono); font-size: 0.85em; white-space: pre-wrap; }
.task-mark, .task-more { color: var(--ink-dim); }
```

- [ ] **Step 7: Gates**

Run: `bun test && bun run typecheck && bun run lint && bun run build`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add ui/src
git commit -m "feat(tasks): the tasks section in a repo's panel, a task's terminal as a panel tab"
```

---

### Task 11: The edit sheet and a task in its own window

**Files:**
- Modify: `ui/src/components/RunSheet.tsx`, `ui/src/components/Tasks.tsx`, `ui/src/routes.ts`, `ui/src/routes.test.ts`, `ui/src/components/TermDock.tsx`

**Interfaces:**
- Consumes: `saveTaskDef`, `closeSheet`, `tasksOf`, the `task` sheet kind (Task 10).
- Produces: `TaskForm({ repo, name })`; `Route.task: string | null`; `taskShellUrl(repoId, termId, task): string`.

- [ ] **Step 1: Route test, then the route**

Add to `ui/src/routes.test.ts`:

```ts
test("a task window names its task", () => {
  const r = parseRoute(`?repo=app&view=shell&term=${"a".repeat(32)}&task=dev`);
  expect(r.term).toBe("a".repeat(32));
  expect(r.task).toBe("dev");
  expect(parseRoute("?repo=app&view=shell&task=Bad").task).toBeNull();
  expect(parseRoute("?repo=app").task).toBeNull();
});
```

Run `bun test ui/src/routes.test.ts`; expected FAIL. In `ui/src/routes.ts`: add `/** the task a shell window shows, which it only ever joins */ task: string | null;` to `Route`; in `parseRoute` read `const task = q.get("task");` and return `task: view === "shell" && task && /^[a-z0-9][a-z0-9._-]{0,39}$/.test(task) ? task : null`. Add:

```ts
/** a task's terminal in a window of its own */
export function taskShellUrl(id: string, term: string, task: string): string {
  const u = new URL(heldShellUrl(id, term));
  u.searchParams.set("task", task);
  return u.toString();
}
```

In `TermDock.tsx` `shellTab`, read the route once (`const route = parseRoute(window.location.search);`), use `route.term` where it read `.term` before, and add `...(route.task ? { task: route.task } : {})` to the tab. Run the test; expected PASS.

- [ ] **Step 2: The window button**

In `Tasks.tsx`, in a running task's actions, before the edit button:

```tsx
{t.live && (
  <button type="button" className="mini" title="Open in a window" onClick={() => window.open(taskShellUrl(repo.id, t.termId, t.name), "_blank", "noopener")}>
    ↗
  </button>
)}
```

(import `taskShellUrl` from `../routes`).

- [ ] **Step 3: The sheet**

In `RunSheet.tsx`'s `Body`, replace the Task 10 placeholder with:

```tsx
  if (sheet.kind === "task") {
    if (!repo) return <Missing what="That repo is no longer in the tree." onClose={close} />;
    return <TaskForm repo={repo} name={sheet.name} />;
  }
```

and add the form, in the same shape as `LaunchForm`:

```tsx
/** Adds or edits a task: saved to this machine's overrides, or to the repo's
 *  own `.canopy/tasks.json` for a repo on this machine. */
function TaskForm({ repo, name }: { repo: Repo; name: string | null }) {
  const close = useStore((s) => s.closeSheet);
  const task = useStore((s) => (name ? tasksOf(s, repo.id).find((t) => t.name === name) : undefined));
  const saveTaskDef = useStore((s) => s.saveTaskDef);
  const [draft, setDraft] = useState({
    name: task?.name ?? "",
    cmd: task?.cmd ?? "",
    cwd: task?.cwd ?? "",
    dev: task?.dev ?? false,
    keep: task?.keep ?? false,
    withPanel: task?.withPanel ?? false,
  });
  const [target, setTarget] = useState<"canopy" | "repo">("canopy");
  const [error, setError] = useState<string | null>(null);

  const run = async (what: () => Promise<void>) => {
    setError(null);
    try {
      await what();
      close();
    } catch (err) {
      setError(errText(err));
    }
  };
  const save = () =>
    run(async () => {
      if (name && name !== draft.name) await saveTaskDef(repo.id, name, null, target);
      await saveTaskDef(
        repo.id,
        draft.name,
        { name: draft.name, cmd: draft.cmd, ...(draft.cwd ? { cwd: draft.cwd } : {}), dev: draft.dev, keep: draft.keep, withPanel: draft.withPanel },
        target,
      );
    });
  const check = (key: "dev" | "keep" | "withPanel", label: string) => (
    <label className="settings-row">
      <input type="checkbox" checked={draft[key]} onChange={(e) => setDraft({ ...draft, [key]: e.target.checked })} /> {label}
    </label>
  );
  const text = (key: "name" | "cmd" | "cwd", label: string, placeholder: string, hint: string) => (
    <section className="settings-row">
      <h3 className="panel-label">{label}</h3>
      <input
        type="text"
        className="agent-extra"
        placeholder={placeholder}
        value={draft[key]}
        onChange={(e) => setDraft({ ...draft, [key]: e.target.value })}
        aria-label={label}
      />
      <p className="settings-hint">{hint}</p>
    </section>
  );

  return (
    <>
      <header className="sheet-head">
        <div>
          <div className="eyebrow">task</div>
          <h2 className="sheet-title">
            {name ? `edit ${name}` : "add a task"} <span className="sheet-repo">{idText(repo.id)}</span>
          </h2>
        </div>
        <button type="button" className="mini close" onClick={close} aria-label="Close">
          ✕
        </button>
      </header>
      <div className="sheet-body agent-form">
        {text("name", "name", "dev", "lowercase letters, digits, dot, dash and underscore")}
        {text("cmd", "command", "bun run dev", "one line, run through a login shell")}
        {text("cwd", "folder", "the repo root", "relative to the repo root")}
        {check("dev", "the dev task, the one the preview pairs with")}
        {check("keep", "keep running: restart when it fails and after a restart")}
        {check("withPanel", "start when the repo's panel opens")}
        <section className="settings-row">
          <h3 className="panel-label">save to</h3>
          <label>
            <input type="radio" checked={target === "canopy"} onChange={() => setTarget("canopy")} /> this machine
          </label>{" "}
          <label title={repo.host ? "only for a repo on this machine" : undefined}>
            <input type="radio" disabled={!!repo.host} checked={target === "repo"} onChange={() => setTarget("repo")} /> the repo, .canopy/tasks.json
          </label>
        </section>
        {task?.suggested && (
          <p className="settings-hint">
            The repo file asks for {Object.keys(task.suggested).join(" and ")}, which runs things without a click, so it waits for you.{" "}
            <button type="button" className="mini" onClick={() => void run(() => saveTaskDef(repo.id, task.name, { name: task.name, ...task.suggested }, "canopy"))}>
              accept
            </button>
          </p>
        )}
        {error && <p className="note err">{error}</p>}
      </div>
      <footer className="sheet-foot">
        {task?.source === "detected" && (
          <button type="button" className="mini" onClick={() => void run(() => saveTaskDef(repo.id, task.name, { name: task.name, hidden: true }, "canopy"))}>
            hide
          </button>
        )}
        {task && task.source !== "detected" && (
          <button type="button" className="mini" onClick={() => void run(() => saveTaskDef(repo.id, task.name, null, target))}>
            delete
          </button>
        )}
        <button type="button" className="mini" onClick={close}>
          cancel
        </button>
        <button type="button" className="mini strong" disabled={!draft.name || !draft.cmd} onClick={() => void save()}>
          save
        </button>
      </footer>
    </>
  );
}
```

Import `tasksOf` from the store. `idText` and `errText` already exist in this file.

- [ ] **Step 4: Gates**

Run: `bun test && bun run typecheck && bun run lint && bun run build`

- [ ] **Step 5: Commit**

```bash
git add ui/src
git commit -m "feat(tasks): the task edit sheet and a task in a window of its own"
```

---

### Task 12: Card chip, top bar chip and the preview

**Files:**
- Modify: `ui/src/components/Tasks.tsx`, `ui/src/components/RepoGrid.tsx`, `ui/src/components/Dock.tsx`, `ui/src/components/TopBar.tsx`, `ui/src/components/Preview.tsx`, `ui/src/styles.css`

**Interfaces:**
- Consumes: `taskChip`, `devTask`, `taskWhen`, `STATUS_WORD`; store `taskAll`, `tasksOf`, `loadTasks`, `showTasks`, `taskAct`; `useFitPop` from `../pop`.
- Produces: `TaskChip({ repoId })`, `TasksChip()`.

- [ ] **Step 1: The card and panel chip**

Add to `Tasks.tsx`:

```tsx
/** a card's word on its tasks: ▶ n running, or ✕ name in rust for one in trouble */
export function TaskChip({ repoId }: { repoId: string }) {
  const tasks = useStore(useShallow((s) => s.taskAll.filter((t) => t.repoId === repoId)));
  const showTasks = useStore((s) => s.showTasks);
  const chip = taskChip(tasks);
  if (!chip) return null;
  return (
    <button
      type="button"
      className={`run-chip task-chip${chip.bad ? " bad" : ""}`}
      title={chip.title}
      onClick={(e) => {
        e.stopPropagation();
        showTasks(repoId);
      }}
    >
      {chip.text}
    </button>
  );
}
```

In `RepoGrid.tsx`, render `<TaskChip repoId={repo.id} />` right after the `{activeFlow ? <FlowChip … : …}` expression. In `Dock.tsx`, render it right after `<RunChip run={repoRun} long />` in the panel head (outside that conditional, so it shows without a run).

- [ ] **Step 2: The top bar chip**

Add to `Tasks.tsx` (imports: `useRef`, `useFitPop` from `../pop`, `taskChip`, `taskWhen`):

```tsx
/** The top bar's ▶ n: every task that is not idle, on every shown backend,
 *  each with open, restart and stop. Nothing when none is. */
export function TasksChip() {
  const all = useStore((s) => s.taskAll);
  const repos = useStore((s) => s.repos);
  const showTasks = useStore((s) => s.showTasks);
  const taskAct = useStore((s) => s.taskAct);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState("");
  const [now, setNow] = useState(() => Date.now());
  const ref = useRef<HTMLDivElement>(null);
  useFitPop(ref, open);

  useEffect(() => {
    if (!open) return;
    setNow(Date.now());
    const tick = setInterval(() => setNow(Date.now()), 1000);
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      clearInterval(tick);
      document.removeEventListener("pointerdown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (all.length === 0) return null;
  const repoName = (id: string) => repos.find((r) => r.id === id)?.name ?? id;
  const list = [...all].sort((a, b) => repoName(a.repoId).localeCompare(repoName(b.repoId)) || a.name.localeCompare(b.name));
  const chip = taskChip(all);
  const running = all.filter((t) => t.status === "running").length;
  const act = (t: TaskInfo, action: "restart" | "stop") => {
    setError("");
    taskAct(t.repoId, action, t.name).catch((e: unknown) => setError(errText(e)));
  };

  return (
    <div className="settings tasks-chip" ref={ref}>
      <button
        type="button"
        className={`mini${open ? " on" : ""}${chip?.bad ? " bad" : ""}`}
        aria-label="Tasks on this backend"
        aria-expanded={open}
        title={chip?.title ?? "Tasks"}
        onClick={() => setOpen(!open)}
      >
        <span aria-hidden="true">▶</span> {running}
      </button>
      {open && (
        <div className="settings-pop tasks-pop" role="dialog" aria-label="Tasks">
          <ul className="task-list">
            {list.map((t) => (
              <li key={t.termId} className={`task-row ${t.status}`}>
                <button
                  type="button"
                  className="task-main"
                  disabled={t.gone === "repo"}
                  onClick={() => {
                    showTasks(t.repoId);
                    setOpen(false);
                  }}
                >
                  <span className={`task-dot ${t.status}`} aria-label={STATUS_WORD[t.status]} />
                  <span className="task-name">{repoName(t.repoId)}</span>
                  <span>{t.name}</span>
                  <span className="task-when">{t.gone === "repo" ? "not in scan" : taskWhen(t, now)}</span>
                </button>
                <span className="task-actions">
                  {t.status === "running" && !t.gone && (
                    <button type="button" className="mini" title="Restart" onClick={() => act(t, "restart")}>
                      ↻
                    </button>
                  )}
                  {(t.status === "running" || t.status === "backoff") && (
                    <button type="button" className="mini" title="Stop" onClick={() => act(t, "stop")}>
                      ■
                    </button>
                  )}
                </span>
              </li>
            ))}
          </ul>
          {error && <p className="note err">{error}</p>}
        </div>
      )}
    </div>
  );
}
```

A task whose repo left the scan has no repo id to post to (`taskAct` needs one); its stop goes through the same route with the `repoId` the session carried, which the server finds only if the repo is in the scan. That case is rare; if the stop answers 404, the error line says so and the task can be stopped from a shell with `tmux kill-session`. Do not build more for it.

Render `<TasksChip />` in `TopBar.tsx` right next to each `<ShellsChip />` (desktop and phone layouts).

- [ ] **Step 3: The preview**

`PreviewSection` already picks the one port that listens in the repo when nothing is chosen, so a running dev task's port is picked with no change. Add only the way to start it. In `ui/src/components/Preview.tsx`:

```tsx
  const dev = useStore(useShallow((s) => devTask(tasksOf(s, repo.id))));
  const known = useStore((s) => repo.id in s.tasks);
  const loadTasks = useStore((s) => s.loadTasks);
  const taskAct = useStore((s) => s.taskAct);
  useEffect(() => {
    if (!closed && !known) loadTasks(repo.id).catch(() => {});
  }, [closed, known, repo.id, loadTasks]);
```

and in the `!choice` empty-state paragraph, the `mine.length === 0` branch becomes:

```tsx
                  : mine.length === 0
                    ? dev && dev.status !== "running"
                      ? (
                        <>
                          Nothing listens in this repo yet.{" "}
                          <button type="button" className="mini" onClick={() => void taskAct(repo.id, "start", dev.name).catch((e: unknown) => setError(errText(e)))}>
                            start {dev.name}
                          </button>
                        </>
                      )
                      : "Nothing listens in this repo yet. Start its dev server in a shell and it turns up here, or pick a port."
```

(imports: `useShallow`, `useStore`, `tasksOf` from the store, `devTask` from `../tasks`).

- [ ] **Step 4: Styles**

```css
.task-chip.bad, .tasks-chip .mini.bad { color: var(--rust); border-color: var(--rust); }
.tasks-pop { min-width: 20rem; }
```

- [ ] **Step 5: Gates**

Run: `bun test && bun run typecheck && bun run lint && bun run build`

- [ ] **Step 6: Commit**

```bash
git add ui/src
git commit -m "feat(tasks): task chips on cards and in the top bar, and start dev from the preview"
```

---

### Task 13: Docs, full gates and a browser pass

**Files:**
- Modify: `CLAUDE.md`
- Modify: `docs/superpowers/specs/2026-09-28-dev-cycle-tasks-design.md` (only if implementation changed a detail)

- [ ] **Step 1: CLAUDE.md**

Add a tasks paragraph to the Architecture list, in the file's own style (long single bullets naming functions): `core/tasks.ts` (pure: `mergeTasks` over detected, `.canopy/tasks.json` and config `tasks`, the own-repo rule for `keep`/`withPanel`, `parseScripts`/`parseCargo`/`parseMakeTargets`, `nextDelay`, `taskStatus`, `plainLines`/`logPage`, `expiredTaskLogs`/`reapable`/`staleWants`), `core/taskrun.ts` (`taskTermId`, logs under `tasks/logs/`, `state.json`, `startTaskSession` making the session with a placeholder, piping, then `respawn-pane`), the tmux builders, `server/tasks.ts`'s `TaskHub` (routes, per-task lock, 2 s supervisor on `list-panes`, keep running with backoff, recovery in `start()`, the sweep), how task sessions sit in `state.terms` with `info.task` so `/api/term?attach=1` joins them while `listTerms`, `tellTerms`, `snapshotShells` and `DELETE /api/terms` pass over them, the `tasks` event, and the UI (`Tasks.tsx`, `ui/src/tasks.ts`, `TermTab.task`, `taskShellUrl`, the chips, the preview pairing). Mention `startServer({ tasks })` for test timings.

- [ ] **Step 2: Stale-build gate and full gates**

Run:

```bash
bun run typecheck && bun run lint && bun test && bun run build
~/.claude/skills/verify-build/clean-rebuild.sh check
```

Expected: all PASS, and `check` exits 0.

- [ ] **Step 3: Browser pass**

Start the built server on a scratch config so the real one is untouched:

```bash
CANOPY_CONFIG_DIR=$(mktemp -d) bun bin/canopy.ts ui --no-open --port 7890 ~/dev/dev-tools &
```

(Check `canopy ui --help` for the real flag names first.) With the playwright-cli skill, open `http://127.0.0.1:7890`, open canopy's own card, and in the tasks section:

1. Start `dev`: the dot goes moss and `▶ 1` shows on the card and in the top bar. Click the task: its terminal opens as a tab among the panel's shells and shows Vite's output, and its log shows under the list.
2. Type `h` + Enter into the task terminal (Vite's help): keys reach it.
3. Restart: the terminal stays and shows a new start.
4. Search the log for `ready`: hits list with the start marker's local time.
5. Open the preview section: it picks the dev port.
6. Stop: the dot goes grey, `exit` shows.
7. Take a screenshot of the section and the feed's task lines.

Kill the scratch server afterwards.

- [ ] **Step 4: On the mini, after the user redeploys**

Only when the user asks for a redeploy (`bun run redeploy`; never push or deploy unasked). Then, from a canopy page on the mini, start a task that prints a line and confirm the line shows in its log (`GET /api/repos/tasks/log`). The log is created by the canopy container and appended to by the shells container's tmux server; if the two run as different uids and the line is missing, make `appendMark` create the file group-writable or have the shells side create it. Record the outcome in the handoff.

- [ ] **Step 5: Commit**

```bash
git add CLAUDE.md docs/superpowers/specs/2026-09-28-dev-cycle-tasks-design.md
git commit -m "docs: tasks in the architecture notes"
```
