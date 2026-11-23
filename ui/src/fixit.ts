import type { HealthCheck, RepoCheckDef, RepoStatus, Run, RunStatus, TaskInfo, TaskLogLine } from "../../src/core/types";

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

/** How long after a move fails the agent still takes it over unasked. A
 *  note older than this (the command line's transcript reopened) waits for
 *  a press instead, so nothing starts twice for one failure. */
export const AUTO_FIX_MS = 15_000;

/** whether a failure at `at` goes to the agent by itself at `now` */
export const freshFailure = (at: number, now: number): boolean => now >= at && now - at < AUTO_FIX_MS;

/** what the note says about the agent that has the failure */
export const FIX_WATCH: Record<RunStatus, string> = {
  working: "the agent is on it",
  waiting: "the agent needs you",
  idle: "the agent answered",
  done: "the agent is done",
  failed: "the agent failed",
  limited: "the agent hit the plan's limit",
  stopped: "the agent was stopped",
};

/** Whether the repo's status shows the move finished, for the moves that
 *  leave a mark there: nothing ahead or behind after a push, nothing
 *  behind after a pull, nothing staged or conflicted after a commit. Null
 *  for the rest, whose finish the status cannot tell. */
export function moveDone(move: FixMove, st: Pick<RepoStatus, "ahead" | "behind" | "files">): boolean | null {
  const committed = !st.files.some((f) => f.conflicted || (!f.untracked && f.index !== "."));
  const level = st.ahead === 0 && st.behind === 0;
  if (move === "push") return level;
  if (move === "pull") return st.behind === 0;
  if (move === "commit") return committed;
  if (move === "commit+push") return committed && level;
  return null;
}

export type RepairStatus = Pick<RepoStatus, "ahead" | "behind" | "files">;
export type RepairRun = Pick<Run, "id" | "status" | "error" | "result" | "steps">;

/** Keep the baseline small and detached from the store's later snapshots. */
export function repairStatusSnapshot(status: RepairStatus | null | undefined): RepairStatus | null {
  return status ? { ahead: status.ahead, behind: status.behind, files: status.files.map((file) => ({ ...file })) } : null;
}

/** A useful completion needs a successful idle/done status, a result and a
 *  text step. The step id distinguishes repeated replies with identical text
 *  on the same chat run. */
export function repairTurnIdentity(run: RepairRun): string | null {
  if ((run.status !== "idle" && run.status !== "done") || run.error || !run.result?.text.trim()) return null;
  const textStep = run.steps.findLast((step) => step.kind === "text" && step.text?.trim());
  return textStep ? `${run.id}\0${textStep.id}\0${textStep.at}` : null;
}

/** A move is confirmed only after a new successful reply and a fresh rescan
 *  observes the move's status change from unfinished to finished. */
export function repairConfirmed(
  move: FixMove,
  run: RepairRun,
  before: RepairStatus | null,
  freshStatus: RepairStatus | null,
  previousTurn: string | null,
): boolean {
  const turn = repairTurnIdentity(run);
  return (
    turn !== null &&
    turn !== previousTurn &&
    before !== null &&
    freshStatus !== null &&
    moveDone(move, before) === false &&
    moveDone(move, freshStatus) === true
  );
}

/** what a failed move's note turns into once the agent finished it */
export const fixedNote = (move: FixMove): string => `The agent finished the ${DOING[move]}.`;

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

/** what a check passes on, in a sentence */
function passesOn(def: RepoCheckDef): string {
  switch (def.kind) {
    case "command":
      return `It runs ${def.run} in the repo and passes when that exits 0.`;
    case "http":
      return `It asks ${def.url} and passes on ${def.expect === undefined ? "a 2xx or 3xx" : `a ${def.expect}`}.`;
    case "port":
      return `It passes when ${def.host ?? "127.0.0.1"}:${def.port} takes a connection.`;
    case "task":
      return `It passes while the repo's ${def.task} task runs.`;
    case "compose":
      return `It passes while the compose service ${def.service}${def.file ? ` (docker compose -f ${def.file})` : ""} runs, healthy where it has a healthcheck.`;
  }
}

/** What "fix with the agent" says about a repo's check that is down or
 *  gave up: what the check passes on (its definition, when the page could
 *  read it), what it last said, the fix canopy has for it and how often
 *  that ran without holding, and for a task check the end of the task's
 *  last run. A command check is proved by its command; committing stays
 *  the user's call, as with a failed task. */
export function healthFixPrompt(
  check: Pick<HealthCheck, "label" | "state" | "why" | "detail" | "fails">,
  def?: RepoCheckDef,
  taskOutput: readonly string[] = [],
): string {
  const head = [`The ${check.label} health check canopy keeps for this repo is down${check.state === "gave-up" ? ", and canopy gave up healing it" : ""}.`];
  if (def) head.push(passesOn(def));
  if (def?.while) head.push(`canopy looks only while the ${def.while} task runs.`);
  if (def?.fix) head.push(`canopy's own fix for it is ${def.fix}${check.fails > 0 ? `, which ran ${check.fails} ${check.fails === 1 ? "time" : "times"} without bringing it back` : ""}.`);
  head.push("What it last said:");
  const said = [check.why, check.detail].filter(Boolean).join("\n");
  const lines = [head.join(" "), "", said || "(it said nothing)", ""];
  const tail = def?.kind === "task" ? taskOutput.join("\n").trim().split("\n").slice(-TASK_LINES).join("\n") : "";
  if (def?.kind === "task" && tail) lines.push(`The end of the ${def.task} task's last run:`, "", tail, "");
  lines.push(
    `Find the cause and fix it, then ${def?.kind === "command" ? `run ${def.run} again until it passes` : "check that it passes again"}.`,
    "Keep my changes, and do not commit or push.",
  );
  return lines.join("\n");
}
