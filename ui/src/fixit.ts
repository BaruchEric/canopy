import type { TaskInfo, TaskLogLine } from "../../src/core/types";

/** The moves an agent can carry through when one fails, each with the
 *  words for it in the prompt. Moves left out are not an agent's to fix:
 *  opening an app, a commit message the agent CLI could not write, seeding
 *  secrets, starring or archiving a card. */
const DOING = {
  pull: "pull",
  push: "push",
  commit: "commit",
  "commit+push": "commit and push",
  stage: "stage a file",
  "peer sync": "peer sync",
  take: "take a peer's uncommitted work",
  track: "track a peer's branch",
  "spec sync": "spec sync (canopy spec sync)",
} as const;

export type FixMove = keyof typeof DOING;

/** a move whose failure goes to the agent, or null when it is not one */
export const fixMove = (label: string): FixMove | null => (Object.hasOwn(DOING, label) ? (label as FixMove) : null);

/** how much of git's answer the prompt quotes, from its end */
const FIX_LINES = 40;

/** What "fix with the agent" says to the repo's chat: the move pressed,
 *  what came back, and the go-ahead to finish it. Pressing push was the
 *  go-ahead to push; a plain commit's says nothing about pushing. Work in
 *  the way is kept unless the user says otherwise. */
export function fixPrompt(move: FixMove, output: string): string {
  const doing = DOING[move];
  const tail = output.trim().split("\n").slice(-FIX_LINES).join("\n");
  return [
    `I pressed ${doing} in canopy and it failed:`,
    "",
    tail,
    "",
    `Find the cause, fix it, then finish the ${doing}.${move === "commit" ? " Do not push." : ""}`,
    "Keep my commits and changes. A commit whose change is already upstream needs no copy: say so and let it go. Ask before anything else that throws work away (reset --hard, a force push, dropping a stash).",
  ].join("\n");
}

/** how much of a failed task's last run the prompt quotes, from its end */
const TASK_LINES = 60;

/** The lines of a task's last run: what follows the log's last start
 *  marker, or the whole tail when no marker is in it. */
export function lastRun(lines: readonly TaskLogLine[]): string[] {
  const from = lines.findLastIndex((l) => l.mark);
  return lines.slice(from + 1).map((l) => l.text);
}

/** What "fix with the agent" says about a failed task: its command, its
 *  exit and the end of its last run. The fix is checked by running the
 *  command again; committing stays the user's call. */
export function taskFixPrompt(task: Pick<TaskInfo, "name" | "cmd" | "exitCode">, output: readonly string[]): string {
  const tail = output.join("\n").trim().split("\n").slice(-TASK_LINES).join("\n");
  const how = task.exitCode === null || task.exitCode === undefined ? "it died" : `it exited ${task.exitCode}`;
  return [
    `I ran the ${task.name} task in canopy (${task.cmd}) and ${how}. The end of its output:`,
    "",
    tail || "(it printed nothing)",
    "",
    `Find the cause and fix it, then run ${task.cmd} again until it passes. The output above is only its end, so run the failing part again to see all of it.`,
    "Keep my changes, and do not commit or push.",
  ].join("\n");
}
