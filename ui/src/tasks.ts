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
