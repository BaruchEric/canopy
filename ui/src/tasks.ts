/** The words tasks are shown with: a status, a chip, a line of when, and the
 *  feed's lines for a change. Pure, and tested. */
import type { TaskDef, TaskFlags, TaskInfo, TaskPatch, TaskSource, TaskStatus } from "../../src/core/types";

export const STATUS_WORD: Record<TaskStatus, string> = {
  idle: "idle",
  running: "running",
  exited: "exited",
  stopped: "stopped",
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

/** "up 2m", "exit 1 · 3m ago", "stopped · 3m ago", "retry in 4s", "gave up", or nothing for an idle task */
export function taskWhen(t: TaskInfo, now: number): string {
  const ago = t.exitedAt === undefined ? "" : now - t.exitedAt < 60_000 ? " · now" : ` · ${span(now - t.exitedAt)} ago`;
  switch (t.status) {
    case "running":
      return t.startedAt !== undefined ? `up ${span(now - t.startedAt)}` : "running";
    case "exited":
    case "failed":
      return `exit ${t.exitCode ?? "?"}${ago}`;
    case "stopped":
      return `stopped${ago}`;
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
        lines.push(`${t.name} finished`);
        break;
      case "stopped":
        lines.push(`${t.name} stopped`);
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

const FLAG_KEYS = ["dev", "keep", "withPanel", "hidden"] as const satisfies readonly (keyof TaskFlags)[];

export interface TaskDraft {
  name: string;
  cmd: string;
  cwd: string;
  dev: boolean;
  keep: boolean;
  withPanel: boolean;
}

/** The form leaves the root marker out of the folder box so its placeholder
 * still says that the task runs from the repo root. */
export const taskDraftCwd = (cwd: string | undefined): string => (cwd === undefined || cwd === "." ? "" : cwd);

/** The task sheet sends an explicit root marker when its folder box is blank,
 * so a canopy override can clear a lower layer's subfolder. */
export function taskDraftPatch(draft: TaskDraft, hidden = false): TaskPatch {
  return {
    name: draft.name,
    cmd: draft.cmd,
    cwd: draft.cwd.trim() || ".",
    dev: draft.dev,
    keep: draft.keep,
    withPanel: draft.withPanel,
    ...(hidden ? { hidden: true } : {}),
  };
}

/** A task as the sheet sends it: the whole merged definition plus one
 *  change. Canopy's layer keeps only what differs from the layers under it,
 *  so sending less would drop an override the task already has. */
export function withChange(t: TaskDef, change: TaskFlags): TaskPatch {
  const out: TaskPatch = { name: t.name, cmd: t.cmd, ...(t.cwd ? { cwd: t.cwd } : {}) };
  for (const f of FLAG_KEYS) if (t[f] !== undefined) out[f] = t[f];
  return { ...out, ...change };
}

/** What a rename does with the old name, so it does not stay behind: a
 *  task a lower layer defines is hidden in canopy's layer (a null there
 *  would clear nothing), one that lives where it is saved is removed. */
export function renameOld(t: TaskDef & { source: TaskSource }, target: "canopy" | "repo"): { def: TaskPatch | null; target: "canopy" | "repo" } {
  if (t.source === "canopy") return { def: null, target: "canopy" };
  if (t.source === "repo" && target === "repo") return { def: null, target: "repo" };
  return { def: withChange(t, { hidden: true }), target: "canopy" };
}

export const devTask = (tasks: readonly TaskInfo[]): TaskInfo | undefined => tasks.find((t) => t.dev && !t.hidden);

/** a start marker's time as the local clock shows it */
export const markTime = (at: number): string =>
  new Date(at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" });

/** The task a repo's tasks in front show: the one asked for while it is
 *  listed, else the one picked there, else the first running, else the first. */
export function frontTask(tasks: readonly TaskInfo[], asked: string | null, picked: string | null): TaskInfo | null {
  const named = (n: string | null) => (n === null ? undefined : tasks.find((t) => t.name === n));
  return named(asked) ?? named(picked) ?? tasks.find((t) => t.status === "running") ?? tasks[0] ?? null;
}

/** The tasks in front's "also running": every other repo's task that is
 *  running or waiting to restart, repo by repo, a repo that left the scan
 *  left out since there is no panel to bring it to. */
export function otherTasks(all: readonly TaskInfo[], repoId: string, name: (repoId: string) => string): TaskInfo[] {
  return all
    .filter((t) => t.repoId !== repoId && !t.gone && (t.status === "running" || t.status === "backoff"))
    .sort((a, b) => name(a.repoId).localeCompare(name(b.repoId)) || a.name.localeCompare(b.name));
}
