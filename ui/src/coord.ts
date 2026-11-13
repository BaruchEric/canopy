/** The coordinator's cards as the run sheet shows them (FR-010): each
 *  card's state chip, its child's one-line status, the parent card a
 *  child was started for, and whether start these applies. Pure. */

import type { RunGroup } from "../../src/core/group";
import { isFlowActive, isRunActive, type CardEquip, type CoordTask, type Flow, type LandingInfo, type PrWatch, type Run, type RunStep } from "../../src/core/types";
import { cardCarries, cardCounts } from "../../src/core/coordinator";
import { flowWord } from "./flows";
import { groupWord } from "./groups";
import { SEP } from "../../src/core/backendid";
import { runLanding } from "./landing";
import { prOfRun, prWord } from "./prs";

/** What an edit of a card may change; a field left out stays. A queued card
 *  changes only its equip and after. null clears equip, workflow or after,
 *  and workflowRepo says the workflow is the repo's own. */
export type CoordEdit = Partial<Pick<CoordTask, "title" | "note" | "repo" | "action" | "times" | "workflowRepo">> & {
  equip?: CardEquip | null;
  workflow?: string | null;
  after?: string[] | null;
};

/** A coordinate run: a chat that holds no repo, so it never counts as the
 *  run going there (the server's `Runner.activeFor` skips it too). */
export const isCoordinator = (run: Pick<Run, "action">): boolean => run.action === "coordinate";

const shortId = (id: string): string => (id.split(SEP).pop() ?? id).slice(0, 4);

/** Who started a run's child, up its chain (FR-038): "started by run 3f2a,
 *  which the coordinator started". A coordinator's card has a parent and no
 *  depth; a run's child has both. `parent` is absent once the page has lost
 *  it, so the words keep to what is known. */
export function chainWords(run: Pick<Run, "parent">, parent?: Pick<Run, "parent" | "depth">): string {
  if (!run.parent) return "";
  const first = `started by run ${shortId(run.parent)}`;
  if (!parent?.parent) return first;
  return parent.depth ? `${first}, which run ${shortId(parent.parent)} started` : `${first}, which the coordinator started`;
}

/** The words a settled card's outcome uses (`childOutcome` on the server).
 *  Anything else in `outcome` is a sentence: why it waits or failed to start. */
export const OUTCOME_WORDS: readonly string[] = Object.freeze([
  "landed",
  "ready",
  "PR opened",
  "PR closed",
  "sent back",
  "failed",
  "stopped",
  "uncommitted",
  "plan turned down",
  "no change",
  "winner picked",
  "needs you",
  "dropped",
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

/** Emphasis that wraps words, off: `**a**`, `__a__`, `*a*`, `_a_`. The
 *  underscores inside a word (`end_of_line`), a glob's stars and the star
 *  of a sum (`2 * 3`) stay. */
const plainEmphasis = (s: string): string =>
  s
    .replace(/(\*\*|__)(?=\S)(.+?)(?<=\S)\1(?![\w*])/g, "$2")
    .replace(/(^|[^\w*])\*(?=[^\s*])(.+?)(?<=[^\s*])\*(?![\w*])/g, "$1$2")
    .replace(/(^|\W)_(?=[^\s_])(.+?)(?<=[^\s_])_(?!\w)/g, "$1$2");

/** A line without markdown's emphasis. A code span loses its backticks and
 *  keeps its text whole, `[*]` and `end_of_line` included. */
function unmarked(line: string): string {
  return line
    .split(/(`+[^`]*`+)/)
    .map((part, i) => (i % 2 === 1 ? part.replace(/^`+|`+$/g, "") : plainEmphasis(part)))
    .join("");
}

/** One timeline entry on one line: a tool call's title, else the first
 *  non-blank line of its text, without markdown's emphasis. */
export function stepLine(step: RunStep): string {
  const raw = step.kind === "tool" ? (step.tool?.title ?? step.tool?.name ?? "") : (step.text ?? "");
  const first = raw.split("\n").find((l) => l.trim()) ?? "";
  const flat = unmarked(first).replace(/\s+/g, " ").trim();
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
 *  ended waits on the landing queue, so it shows the child's landing word.
 *  A card that started a group shows the group's word in its place, and a
 *  card whose `flow` the page has shows the flow's: needs you while it is
 *  parked at a gate or waits on a prompt, as a waiting child does. */
export function cardStatus(
  task: CoordTask,
  child: Run | undefined,
  landing: LandingInfo,
  prs: readonly PrWatch[],
  group?: RunGroup,
  flow?: Flow,
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
      if (group) return { word: groupWord(group), tone: "sky", line: group.reason ?? "" };
      if (flow && isFlowActive(flow)) {
        const asks = flow.status === "gated" || flow.status === "waiting";
        return { word: asks ? "needs you" : "running", tone: asks ? "lichen" : "sky", line: flowWord(flow, true) };
      }
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

/** A card's edit form as typed: the loadout's name ("" for none), the
 *  workflow picked with its source (null for none) and after as typed. */
export interface CardDraft {
  title: string;
  note: string;
  repo: string;
  action: CoordTask["action"];
  times: number;
  loadout: string;
  workflow: { name: string; fromRepo: boolean } | null;
  after: string;
}

/** The form as it opens on a card. */
export const cardDraft = (task: CoordTask): CardDraft => ({
  title: task.title,
  note: task.note,
  repo: task.repo,
  action: task.action,
  times: task.times ?? 1,
  loadout: task.equip?.loadout ?? "",
  workflow: task.workflow ? { name: task.workflow, fromRepo: task.workflowRepo === true } : null,
  after: (task.after ?? []).join(", "),
});

/** The card ids typed in an after field, split by commas or spaces. */
export const parseAfter = (text: string): string[] => text.split(/[\s,]+/).filter(Boolean);

const sameList = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((x, i) => x === b[i]);

/** What saving the form sends: only what changed. A new loadout replaces
 *  the card's equip, overrides and all; the same one sends none, so Eric's
 *  overrides stay. A queued card sends only its equip and after. */
export function cardEdit(task: CoordTask, d: CardDraft): CoordEdit {
  const had = task.equip?.loadout ?? "";
  const after = parseAfter(d.after);
  const out: CoordEdit = {
    ...(d.loadout !== had ? { equip: d.loadout ? { loadout: d.loadout } : null } : {}),
    ...(!sameList(after, task.after ?? []) ? { after: after.length > 0 ? after : null } : {}),
  };
  if (task.state !== "proposed") return out;
  const title = d.title.trim();
  const note = d.note.trim();
  // a workflow goes again with a new repo, so the server checks the new repo has it
  const flowSame =
    d.workflow === null ? task.workflow === undefined : d.workflow.name === task.workflow && d.workflow.fromRepo === (task.workflowRepo === true) && d.repo === task.repo;
  return {
    ...(title !== task.title ? { title } : {}),
    ...(note !== task.note ? { note } : {}),
    ...(d.repo !== task.repo ? { repo: d.repo } : {}),
    ...(d.action !== task.action ? { action: d.action } : {}),
    ...(d.times !== (task.times ?? 1) ? { times: d.times } : {}),
    ...out,
    ...(flowSame ? {} : d.workflow === null ? { workflow: null } : { workflow: d.workflow.name, ...(d.workflow.fromRepo ? { workflowRepo: true as const } : {}) }),
  };
}

/** Start these applies while the coordinator is going and a card waits on it. */
export const canStartCards = (run: Run): boolean =>
  isRunActive(run) && (run.tasks ?? []).some((t) => t.state === "proposed");

/** What an idle coordinator waits on you for: its cards waiting for start
 *  these, or null when none is. Between turns it is otherwise waiting on
 *  its children, not on you. */
export function coordTurn(run: Pick<Run, "tasks">): string | null {
  const n = (run.tasks ?? []).filter((t) => t.state === "proposed").length;
  return n ? `${n} ${n === 1 ? "card waits" : "cards wait"} for start these` : null;
}

/** The two views a coordinator's sheet takes on a phone, where the
 *  timeline and the cards do not both fit. */
export type CoordView = "cards" | "chat";

/** The view a phone opens a coordinator's sheet on: the chat while it has
 *  no cards, while a question waits in the timeline, or while it works on
 *  cards already started; the cards while any waits for start these, and
 *  between turns or once it ended. */
export function coordView(run: Pick<Run, "status" | "tasks">): CoordView {
  const tasks = run.tasks ?? [];
  if (tasks.length === 0 || run.status === "waiting") return "chat";
  if (tasks.some((t) => t.state === "proposed")) return "cards";
  return run.status === "working" ? "chat" : "cards";
}

/** The card a coordinator started a child for, when the page has the parent. */
export const parentCard = (parent: Pick<Run, "tasks"> | undefined, childId: string): CoordTask | undefined =>
  parent?.tasks?.find((t) => t.run === childId);

export { cardCarries, cardCounts };
