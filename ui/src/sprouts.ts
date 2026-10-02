/** The incubator's words and arithmetic for the page: the stage strip, the
 *  status words, the order of the cards, and the feed's lines. Pure. */
import { nextWorkflow, sproutEnded } from "../../src/core/sprout";
import type { InputKind, ServerEvent, Sprout, SproutStatus } from "../../src/core/types";
import type { FeedLine, FeedSnapshot } from "./feed";

export const STAGES = ["clarify", "research", "eval", "build", "test", "accept", "deploy", "retro"] as const;
export type Stage = (typeof STAGES)[number];
export type StageMark = "done" | "now" | "stuck" | "todo";

/** a running status's stage; research and eval are one flow (scout), shown as research */
const STATUS_STAGE: Partial<Record<SproutStatus, Stage>> = {
  clarifying: "clarify",
  researching: "research",
  building: "build",
  testing: "test",
  accepting: "accept",
  deploying: "deploy",
};

const WORKFLOW_STAGE: Readonly<Record<string, Stage>> = {
  clarify: "clarify",
  scout: "research",
  "build-new": "build",
  renovate: "build",
  extend: "build",
  retro: "retro",
};

/** The stage a sprout is at: its running status's, else the stage of the
 *  workflow it runs next (where a park or a queue leaves it); null before
 *  anything has run. */
export function stageAt(s: Sprout): Stage | null {
  const running = STATUS_STAGE[s.status];
  if (running) return running;
  if (s.flows.length === 0 && !s.clarified) return null;
  const last = s.flows.at(-1);
  // a flow that did not finish is where it stopped; one that did hands on to the next
  if (last && last.outcome !== "done") return WORKFLOW_STAGE[last.workflow] ?? null;
  return WORKFLOW_STAGE[nextWorkflow(s)] ?? null;
}

export function stageStrip(s: Sprout): { stage: Stage; mark: StageMark }[] {
  if (s.status === "live" || s.status === "handed-off") {
    return STAGES.map((stage) => ({ stage, mark: stage === "retro" ? "todo" : "done" }));
  }
  const at = stageAt(s);
  const i = at ? STAGES.indexOf(at) : 0;
  const stuck = s.status === "parked" || s.status === "rejected" || s.status === "stopped";
  const waiting = s.status === "queued";
  return STAGES.map((stage, j) => ({
    stage,
    mark: j < i ? "done" : j === i && at && !waiting ? (stuck ? "stuck" : "now") : "todo",
  }));
}

const STATUS_WORD: Record<SproutStatus, string> = {
  queued: "waiting its turn",
  clarifying: "clarifying",
  researching: "researching",
  building: "building",
  testing: "testing",
  accepting: "accepting",
  deploying: "deploying",
  live: "live",
  parked: "parked",
  rejected: "turned down at eval",
  "handed-off": "handed off",
  stopped: "stopped",
};

export function sproutWord(s: Sprout): string {
  const n = s.questions?.length ?? 0;
  if (s.status === "clarifying" && n > 0) return `${n} ${n === 1 ? "question" : "questions"} for you`;
  if (s.status === "queued") {
    if (!s.prepared) return "making the seed";
    return nextWorkflow(s) === "clarify" ? "waiting its turn to clarify" : "waiting its turn for research";
  }
  return STATUS_WORD[s.status];
}

export const needsYou = (s: Sprout): boolean => s.status === "parked" || (s.status === "clarifying" && (s.questions?.length ?? 0) > 0);

/** what needs you, then what runs or waits its turn, then what ended; newest change first in each */
export function sortSprouts(list: readonly Sprout[]): Sprout[] {
  const rank = (s: Sprout): number => (needsYou(s) ? 0 : sproutEnded(s) ? 2 : 1);
  return [...list].sort((a, b) => rank(a) - rank(b) || b.updatedAt - a.updatedAt);
}

export const INPUT_GLYPH: Record<InputKind, string> = {
  text: "¶",
  audio: "♪",
  image: "▣",
  url: "↗",
  file: "▤",
  transcript: "✎",
  answers: "✓",
};

/** The feed's lines for a sprout's event, against what the store held before. */
export function sproutLines(ev: Extract<ServerEvent, { type: "incubator" | "incubator-gone" }>, prev: FeedSnapshot, at: number): FeedLine[] {
  const line = (s: Pick<Sprout, "title" | "repoId">, text: string, quiet = false): FeedLine => ({
    at,
    kind: "incubator",
    source: "",
    repoId: s.repoId,
    repo: s.title,
    text,
    quiet,
  });
  if (ev.type === "incubator-gone") {
    const was = prev.sprouts?.[ev.id];
    return [was ? line(was, "dismissed", true) : { at, kind: "incubator", source: "", text: "a project dismissed", quiet: true }];
  }
  const s = ev.sprout;
  const before = prev.sprouts?.[s.id];
  if (!before) return [line(s, "new project in the incubator")];
  const lines: FeedLine[] = [];
  if (before.title !== s.title) lines.push(line(s, `now called ${s.title}`));
  const asking = (s.questions?.length ?? 0) > 0;
  const wasAsking = (before.questions?.length ?? 0) > 0;
  if (before.status !== s.status || asking !== wasAsking) {
    lines.push(line(s, s.status === "parked" ? `parked: ${s.parked ?? "no reason given"}` : sproutWord(s)));
  }
  const added = s.inputs.filter((e) => e.via !== "answer").length - before.inputs.filter((e) => e.via !== "answer").length;
  if (added > 0) lines.push(line(s, `${added} more ${added === 1 ? "input" : "inputs"}`));
  if (lines.length === 0) lines.push(line(s, sproutWord(s), true));
  return lines;
}

/** Whether an action's answer about a sprout is older than the one held:
 *  an event that landed while the request was on its way has moved it on,
 *  and the answer must not undo that. One as new applies. */
export function staleSprout(held: Readonly<Record<string, Sprout>>, incoming: Sprout): boolean {
  const had = Object.hasOwn(held, incoming.id) ? held[incoming.id] : undefined;
  return had !== undefined && incoming.updatedAt < had.updatedAt;
}

/** A whole list read as the sprouts held: what it names, except that
 *  `since` names the sprouts an event told of while the list was on its
 *  way, whose event stands (a sprout it brought is kept though the list
 *  lacks it, one it said was gone stays gone). A sprout the list lacks that
 *  no event touched has gone. */
export function replaceSprouts(
  held: Readonly<Record<string, Sprout>>,
  list: readonly Sprout[],
  since: (id: string) => boolean = () => false,
): Record<string, Sprout> {
  const out: Record<string, Sprout> = {};
  for (const s of list) {
    if (since(s.id)) {
      const had = Object.hasOwn(held, s.id) ? held[s.id] : undefined;
      if (had) out[s.id] = had;
      continue;
    }
    out[s.id] = s;
  }
  for (const [id, had] of Object.entries(held)) if (!Object.hasOwn(out, id) && since(id)) out[id] = had;
  return out;
}
