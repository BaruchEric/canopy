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
  const { command, dir } = taskCommand(locator, cmd, cwd);
  let piped = await exec(pipeArgs(base, meta.id, logPath(meta.id)), { timeoutMs: 10_000 });
  if (piped.code !== 0 && /has exited/.test(piped.stderr)) {
    // A pane whose last command ended is dead and takes no pipe. Put the
    // placeholder back first (keeping the pipe-then-respawn order), then pipe.
    const held = await exec(respawnArgs(base, meta.id, ["sleep", "2147483647"], dir), { timeoutMs: 10_000 });
    if (held.code !== 0) throw new Error(held.stderr.trim() || "tmux could not reuse the task's pane");
    piped = await exec(pipeArgs(base, meta.id, logPath(meta.id)), { timeoutMs: 10_000 });
  }
  if (piped.code !== 0) throw new Error(piped.stderr.trim() || "tmux could not pipe the task's output");
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

/** every task pane; "no-server" when tmux says none runs, null when it did not answer */
export async function listTaskPanes(base: string[]): Promise<TaskPane[] | "no-server" | null> {
  const r = await exec(taskPanesArgs(base), { timeoutMs: 10_000 });
  if (r.code === 0) return parseTaskPanes(r.stdout);
  return noServer(r.stderr) ? "no-server" : null;
}
