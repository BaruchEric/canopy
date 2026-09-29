/**
 * What is in front of the page: one thing at a time, for this page only.
 * Either the strip's shells, or one project's bench, where its panel's
 * changes, shells, preview and task log share one box. Pure, tested in
 * front.test.ts.
 */
import type { TaskInfo, TermInfo } from "../../src/core/types";
import type { TermTab } from "./term";

/** The parts of a bench: the panel's own column (changes, tasks and the
 *  rest), the app, the shells, the task log. */
export type BenchPane = "files" | "app" | "shell" | "log";

export type Front =
  | { kind: "strip" }
  | {
      kind: "project";
      repoId: string;
      /** the task whose log the bench shows, null for the one it picks */
      task: string | null;
      /** a shell asked for from another project's list, which the bench's
       *  shells show once */
      pick: string | null;
      /** the one part filling the bench, null for all of them side by side */
      solo: BenchPane | null;
    };

/** the bench for a project, with its task, pick and the part filling it */
export const projectFront = (
  repoId: string,
  task: string | null = null,
  pick: string | null = null,
  solo: BenchPane | null = null,
): Front => ({
  kind: "project",
  repoId,
  task,
  pick,
  solo,
});

/** the part filling `repoId`'s bench, null when every part shows or the
 *  bench is not in front */
export const benchSolo = (front: Front | null, repoId: string): BenchPane | null =>
  front?.kind === "project" && front.repoId === repoId ? front.solo : null;

/** `front` with `pane` filling `repoId`'s bench, or every part side by side
 *  again with null; anything else in front is left alone */
export const withSolo = (front: Front | null, repoId: string, pane: BenchPane | null): Front | null =>
  front?.kind === "project" && front.repoId === repoId && front.solo !== pane ? { ...front, solo: pane } : front;

/** the part of the bench a panel section sits in: the preview is the app,
 *  the tasks' ⧉ is about their log, every other section is the column */
export const paneOf = (key: string): BenchPane =>
  key === "preview" ? "app" : key === "tasks" ? "log" : key === "shell" ? "shell" : "files";

/** the project whose bench is in front, or null */
export const benchOf = (front: Front | null): string | null => (front?.kind === "project" ? front.repoId : null);

/** true while `repoId`'s bench is in front */
export const benchIs = (front: Front | null, repoId: string): boolean => benchOf(front) === repoId;

/** the task the bench asks for, or undefined when `repoId`'s bench is not
 *  in front (null there is "the one it picks") */
export const benchTask = (front: Front | null, repoId: string): string | null | undefined =>
  front?.kind === "project" && front.repoId === repoId ? front.task : undefined;

/** `front` with the bench's task put back to its own pick, which is what a
 *  tasks section that folds or goes asks for: the bench stays */
export const clearTask = (front: Front | null, repoId: string): Front | null =>
  front?.kind === "project" && front.repoId === repoId && front.task !== null ? { ...front, task: null } : front;

/** `front` while what it shows is still here: the strip while a tab sits
 *  there, a bench while its project's panel is open. Emptying the bench's
 *  shells does not end the bench; closing its panel does. */
export function keepFront(front: Front | null, tabs: TermTab[], panels: string[]): Front | null {
  if (front === null) return null;
  if (front.kind === "strip") return tabs.some((t) => t.place === "strip") ? front : null;
  return panels.includes(front.repoId) ? front : null;
}

/** where a shell's tab goes to the front: the strip, or its project's bench
 *  showing it, keeping the task that bench already had; a bench with
 *  another part filling it gives the room to the shells */
export function frontForTab(front: Front | null, tab: Pick<TermTab, "id" | "place" | "repoId">): Front {
  if (tab.place === "strip") return { kind: "strip" };
  const same = front?.kind === "project" && front.repoId === tab.repoId ? front : null;
  return projectFront(tab.repoId, same?.task ?? null, tab.id, same?.solo ? "shell" : null);
}

/** the bench for `repoId` with `task` in its log: the same bench with a
 *  part filling it gives the room to the log, another project's starts
 *  with every part showing */
export function frontForTask(front: Front | null, repoId: string, task: string | null): Front {
  const solo = front?.kind === "project" && front.repoId === repoId ? front.solo : null;
  return projectFront(repoId, task, null, solo ? "log" : null);
}

/** the panel sections a bench holds open whatever their folds say: the
 *  changes and tasks along its side, the preview and the shells in its
 *  main part. Held open without writing the folds, so leaving the bench
 *  leaves the panel as it was. */
export const BENCH_PANES: readonly string[] = ["changes", "tasks", "preview", "shell"];

/** true while `repoId`'s bench is in front and holds `key` open */
export const benchHolds = (front: Front | null, repoId: string, key: string): boolean =>
  benchIs(front, repoId) && BENCH_PANES.includes(key);

/** One project the bench's bar offers: its panel is open, or something of
 *  its runs (a shell, a task). */
export interface BenchProject {
  repoId: string;
  name: string;
  /** its shells, held on the backend or tabbed here and not exited */
  shells: number;
  /** its tasks running or restarting */
  running: number;
}

/** The projects the bench can switch to: the open panels in the dock's
 *  order, then every other project with a shell or a task running, by name.
 *  Only repos in the scan. */
export function benchProjects(
  panels: readonly string[],
  tabs: readonly TermTab[],
  live: readonly TermInfo[],
  tasks: readonly TaskInfo[],
  repos: readonly { id: string; name: string }[],
): BenchProject[] {
  const name = new Map(repos.map((r) => [r.id, r.name]));
  const shells = new Map<string, Set<string>>();
  const add = (repoId: string, id: string) => shells.set(repoId, (shells.get(repoId) ?? new Set()).add(id));
  for (const t of live) if (!t.task) add(t.repoId, t.id);
  for (const t of tabs) if (!t.task && t.exit === undefined) add(t.repoId, t.id);
  const running = new Map<string, number>();
  for (const t of tasks)
    if (!t.gone && (t.status === "running" || t.status === "backoff")) running.set(t.repoId, (running.get(t.repoId) ?? 0) + 1);
  const busy = [...new Set([...shells.keys(), ...running.keys()])]
    .filter((id) => !panels.includes(id))
    .sort((a, b) => (name.get(a) ?? a).localeCompare(name.get(b) ?? b));
  return [...panels, ...busy]
    .filter((id) => name.has(id))
    .map((repoId) => ({ repoId, name: name.get(repoId) ?? repoId, shells: shells.get(repoId)?.size ?? 0, running: running.get(repoId) ?? 0 }));
}
