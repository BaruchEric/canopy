/** The coordinator's cards as the run sheet shows them (FR-010): each
 *  card's state chip, its child's one-line status, the parent card a
 *  child was started for, and whether start these applies. Pure. */

import { isRunActive, type CoordTask, type LandingInfo, type PrWatch, type Run, type RunStep } from "../../src/core/types";
import { runLanding } from "./landing";
import { prOfRun, prWord } from "./prs";

/** What an edit of a proposed card may change; a field left out stays. */
export type CoordEdit = Partial<Pick<CoordTask, "title" | "note" | "repo" | "action">>;

/** A coordinate run: a chat that holds no repo, so it never counts as the
 *  run going there (the server's `Runner.activeFor` skips it too). */
export const isCoordinator = (run: Pick<Run, "action">): boolean => run.action === "coordinate";

/** The words a settled card's outcome uses (`childOutcome` on the server).
 *  Anything else in `outcome` is a sentence: why it waits or failed to start. */
export const OUTCOME_WORDS: readonly string[] = Object.freeze([
  "landed",
  "ready",
  "PR opened",
  "sent back",
  "failed",
  "stopped",
  "uncommitted",
  "plan turned down",
  "no change",
]);

export type CardTone = "moss" | "sky" | "rust" | "lichen" | "faint";

export interface CardStatus {
  /** the chip: the card's state, or the child's landing word or outcome */
  word: string;
  tone: CardTone;
  /** one line under the card: the child's newest step, or why it waits or failed */
  line: string;
  /** the PR the child's branch opened */
  pr?: PrWatch;
}

const MAX_LINE = 140;

/** One timeline entry on one line: a tool call's title, else the first
 *  non-blank line of its text, without markdown's emphasis. */
export function stepLine(step: RunStep): string {
  const raw = step.kind === "tool" ? (step.tool?.title ?? step.tool?.name ?? "") : (step.text ?? "");
  const first = raw.split("\n").find((l) => l.trim()) ?? "";
  const flat = first.replace(/[*_`]+/g, "").replace(/\s+/g, " ").trim();
  return flat.length > MAX_LINE ? `${flat.slice(0, MAX_LINE - 1)}…` : flat;
}

/** A child run's one-line status: its newest main-thread entry that says
 *  something. A subagent's steps are its parent's business. */
export function childLine(run: Pick<Run, "steps">): string {
  for (let i = run.steps.length - 1; i >= 0; i--) {
    const st = run.steps[i];
    if (!st || st.parent) continue;
    const line = stepLine(st);
    if (line) return line;
  }
  return "";
}

/** What a card shows of itself and its child. `child` is the run the card
 *  started when this page still has it. A card still running whose child
 *  ended waits on the landing queue, so it shows the child's landing word. */
export function cardStatus(
  task: CoordTask,
  child: Run | undefined,
  landing: LandingInfo,
  prs: readonly PrWatch[],
): CardStatus {
  const line = child ? childLine(child) : "";
  const pr = child ? prOfRun(child, prs) : undefined;
  const withPr = pr ? { pr } : {};
  const sentence = task.outcome !== undefined && !OUTCOME_WORDS.includes(task.outcome) ? task.outcome : undefined;
  switch (task.state) {
    case "proposed":
      return { word: "proposed", tone: "lichen", line: "" };
    case "queued":
      return { word: "queued", tone: "sky", line: task.outcome ?? "" };
    case "running": {
      if (!child) return { word: "running", tone: "sky", line: task.outcome ?? "" };
      if (isRunActive(child)) return { word: child.status === "waiting" ? "needs you" : "running", tone: child.status === "waiting" ? "lichen" : "sky", line, ...withPr };
      const word = pr ? prWord(pr) : (runLanding(child, landing)?.word ?? "settling");
      return { word, tone: "sky", line, ...withPr };
    }
    case "done":
      return { word: task.outcome && !sentence ? task.outcome : "done", tone: "moss", line: sentence ?? line, ...withPr };
    case "failed":
      return { word: task.outcome && !sentence ? task.outcome : "failed", tone: "rust", line: sentence ?? line, ...withPr };
    case "dropped":
      return { word: "dropped", tone: "faint", line: sentence ?? "" };
  }
}

/** Start these applies while the coordinator is going and a card waits on it. */
export const canStartCards = (run: Run): boolean =>
  isRunActive(run) && (run.tasks ?? []).some((t) => t.state === "proposed");

/** The card a coordinator started a child for, when the page has the parent. */
export const parentCard = (parent: Pick<Run, "tasks"> | undefined, childId: string): CoordTask | undefined =>
  parent?.tasks?.find((t) => t.run === childId);

/** The cards in a few words for the block's head: "3 cards · 1 proposed, 2 running". */
export function cardCounts(tasks: readonly CoordTask[]): string {
  const order: CoordTask["state"][] = ["proposed", "queued", "running", "done", "failed", "dropped"];
  const parts = order
    .map((state) => [state, tasks.filter((t) => t.state === state).length] as const)
    .filter(([, n]) => n > 0)
    .map(([state, n]) => `${n} ${state}`);
  const head = `${tasks.length} ${tasks.length === 1 ? "card" : "cards"}`;
  return parts.length ? `${head} · ${parts.join(", ")}` : head;
}
