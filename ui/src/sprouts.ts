/** The incubator's words and arithmetic for the page: the stage strip, the
 *  status words, the order of the cards, and the feed's lines. Pure. */
import { BUILD_WORKFLOW, HAND_OFF, SHIP, isBuildWorkflow, isOwnStep, nextWorkflow, sproutEnded } from "../../src/core/sprout";
import type { Flow, IncubatorStages, InputKind, ServerEvent, Sprout, SproutStatus } from "../../src/core/types";
import type { FeedLine, FeedSnapshot } from "./feed";
import { gateWords, type GateWords } from "./flows";

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
  approving: "deploy",
};

const WORKFLOW_STAGE: Readonly<Record<string, Stage>> = {
  clarify: "clarify",
  scout: "research",
  "build-new": "build",
  renovate: "build",
  extend: "build",
  [SHIP]: "deploy",
  [HAND_OFF]: "deploy",
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

/** the retro's mark, from its own state: it runs after an end or beside a park */
const RETRO_MARK: Record<NonNullable<Sprout["retro"]>["state"], StageMark> = { due: "todo", running: "now", done: "done", failed: "stuck" };

export function stageStrip(s: Sprout): { stage: Stage; mark: StageMark }[] {
  const retro: StageMark = s.retro ? RETRO_MARK[s.retro.state] : "todo";
  return stagesBefore(s).map((x) => (x.stage === "retro" ? { stage: "retro", mark: retro } : x));
}

function stagesBefore(s: Sprout): { stage: Stage; mark: StageMark }[] {
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
  approving: "waiting for your yes to push its branch",
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
    const next = nextWorkflow(s);
    if (next === "clarify") return "waiting its turn to clarify";
    if (next === "scout") return "waiting its turn for research";
    if (next === SHIP) return "waiting its turn to deploy";
    if (next === HAND_OFF) return "waiting its turn to hand off";
    return "waiting its turn to build";
  }
  return STATUS_WORD[s.status];
}

/** the branch a hand-off pushed, as a link only when it is the GitHub tree url canopy writes */
export const branchHref = (url: string | undefined): string | null =>
  url && /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/tree\/new\/[\w.-]+$/.test(url) ? url : null;

/** the sheet's line on what a rebuilt seed came from */
export function workLine(s: Sprout): string | null {
  if (s.work?.kind === "extend") return `extends ${s.work.target}, on the branch ${s.work.branch}`;
  if (s.work?.kind === "renovate") return `renovates ${s.work.from}`;
  return null;
}

/** A project's stop, wherever it is offered (its sheet, its park and its
 *  stage's gate in the inbox): it ends the project, which no resume undoes. */
export const END_PROJECT = {
  stop: "end the project",
  stopTitle: "The project ends here and no stage runs again. Its seed, its inputs and its vault note stay; dismiss takes it off the list",
} as const;

/** A parked project's ways on, as its buttons word them. With the stage's
 *  flow waiting at a gate they are that gate's, in the project's terms:
 *  past a build's last step canopy deploys the project (an extend goes to
 *  its hand-off), so going on there says so. A plain "continue" at a build
 *  the judge refused deployed it. Past scout's last step canopy takes the
 *  pick and queues the build, where "accept and finish" read as the end of
 *  the project. With no flow waiting, continue and retry both start the
 *  stage again, so there is one button. */
export function parkWords(s: Sprout, flow: Flow | undefined): GateWords {
  const cur = s.flows.at(-1);
  if (!cur || cur.outcome || !flow || flow.id !== cur.flowId || flow.status !== "gated") return { go: "resume", retry: null, lead: "go", ...END_PROJECT };
  return { ...stageWords(cur.workflow, flow), ...END_PROJECT };
}

/** the gate's words for going on and back, in the project's terms */
function stageWords(workflow: string, flow: Flow): GateWords {
  const words = gateWords(flow);
  const step = flow.steps[flow.current];
  const last = flow.current + 1 >= flow.steps.length;
  if (!last || flow.parkedFor || step?.status === "held") return words;
  if (workflow === "scout") {
    if (words.lead !== "retry") return { ...words, go: "accept the pick and build it" };
    return { ...words, go: "build it anyway", title: `${step?.name ?? "The last step"} did not accept the research; this takes the pick as it is and queues the build` };
  }
  if (!isBuildWorkflow(workflow)) return words;
  const extend = workflow === BUILD_WORKFLOW.extend;
  if (words.lead !== "retry") return { ...words, go: extend ? "accept and hand it off" : "accept and deploy it" };
  return {
    ...words,
    go: extend ? "hand it off anyway" : "deploy it anyway",
    title: `${step?.name ?? "The last step"} did not accept the work; this ${extend ? "takes the branch to its hand-off" : "deploys the project"} as it is`,
  };
}

/** What stands behind the current park's reason (`SproutPark.detail`): a
 *  run's raw error the reason says plainly, or the end of a failed check's
 *  output. Null when the project is not parked or its park has none. */
export function parkDetailOf(s: Sprout): string | null {
  if (s.status !== "parked") return null;
  const last = s.parks?.at(-1);
  return last && last.at === s.parkedAt && last.detail ? last.detail : null;
}

export const needsYou = (s: Sprout): boolean => s.status === "parked" || (s.status === "clarifying" && (s.questions?.length ?? 0) > 0);

/** What a card's motion says: `needs` waits on the user (a question, a
 *  park, a branch to push), `working` has an agent on a stage or its
 *  retro, `still` has nothing under way (queued, ended). */
export type SproutActivity = "needs" | "working" | "still";

export function sproutActivity(s: Sprout): SproutActivity {
  if (needsYou(s) || s.status === "approving") return "needs";
  if (STATUS_STAGE[s.status] !== undefined || s.retro?.state === "running") return "working";
  return "still";
}

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
  const r = s.retro;
  if (r && r.state !== before.retro?.state) {
    if (r.state === "running") lines.push(line(s, "looking back"));
    if (r.state === "failed") lines.push(line(s, `the retro failed: ${r.reason ?? "no reason given"}`));
    if (r.state === "done") {
      const n = r.advice?.length ?? 0;
      lines.push(n > 0 ? line(s, `the retro left ${n} ${n === 1 ? "lesson" : "lessons"}`) : line(s, "the retro left no advice", true));
    }
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

/** The incubator bar's word for where stages run, the title naming which
 *  env is set or missing, and whether it is worth a second look. */
export function stagesWord(st: IncubatorStages): { word: string; title: string; warn: boolean } {
  if (st.notKeeping) {
    return {
      word: "incubator kept elsewhere",
      title: `${st.notKeeping}. A project started here is refused, and what this canopy says of its stages is its own view, not the keeper's.`,
      warn: true,
    };
  }
  switch (st.mode) {
    case "runner":
      if (!st.isolated && st.unfenced) {
        return {
          word: "stages unfenced",
          title: `The stage runner answers, but its fence is not confirmed: ${st.unfenced}. Stages wait until its probe of CANOPY_FENCE_PROBE times out, and start on their own then.`,
          warn: true,
        };
      }
      if (st.isolated && st.login) {
        return {
          word: "stages need a login",
          title: `The stage runner answers behind its fence, but ${st.login}. Stages wait, and start on their own once the login is back.`,
          warn: true,
        };
      }
      return st.isolated
        ? {
            word: "stages isolated",
            title: "CANOPY_STAGE_SOCKET is set and the stage runner answers behind its fence: stages run in the stages container, with none of canopy's tokens.",
            warn: false,
          }
        : {
            word: "stage runner away",
            title: "CANOPY_STAGE_SOCKET is set, but the stage runner is not answering. Stages wait for it and start on their own once it answers.",
            warn: true,
          };
    case "unisolated":
      return {
        word: "stages unisolated",
        title: "CANOPY_INCUBATOR_UNISOLATED=1 is set and CANOPY_STAGE_SOCKET is not: stages run here, in canopy's own container, with canopy's tokens.",
        warn: true,
      };
    case "off":
      return {
        word: "stages off",
        title: "Neither CANOPY_STAGE_SOCKET nor CANOPY_INCUBATOR_UNISOLATED=1 is set, so no stage starts. Set one and restart canopy.",
        warn: true,
      };
  }
}

/** How long after its nth failed read (from 1) the page asks a backend
 *  where it runs stages again: 5 s, 15 s and 45 s, then every two minutes
 *  for as long as the backend is on the page and has not said. */
export function stagesRetryIn(failures: number): number {
  return [5_000, 15_000, 45_000][failures - 1] ?? 120_000;
}

/** A backend's word on the new project sheet's picker: where it runs
 *  stages, or that its read failed (with why, for the tooltip), or that it
 *  has not said. */
export function stagesChoice(backend: string, st: IncubatorStages | undefined, err: string | undefined): { word: string; warn: boolean; title?: string } {
  if (st) return stagesWord(st);
  if (err !== undefined) return { word: "stages unread", warn: true, title: `${backend} did not say where it runs stages (${err}). The page asks again on its own.` };
  return { word: "stages unknown", warn: true };
}

/** The sheet's line while the picked backend's stages read has failed and
 *  nothing else has said: the start is not held, since the backend itself
 *  refuses a project it has nowhere to run. Null otherwise. */
export function stagesUnread(backend: string, st: IncubatorStages | undefined, err: string | undefined): string | null {
  if (st || err === undefined) return null;
  return `${backend} did not say where it runs stages (${err}). The page asks again on its own; a project started there still goes, and ${backend} refuses one it has nowhere to run.`;
}

/** Why a project started on this backend would never start, or is refused:
 *  it does not keep its incubator now, or its stages are off, with no
 *  runner and no unisolated switch. Null for any other mode (a runner away
 *  starts its projects once it answers) and for a backend that has not
 *  said, which the server answers for. */
export function cannotStart(backend: string, st: IncubatorStages | undefined): string | null {
  if (st?.notKeeping) return `${backend} cannot take a project now: ${st.notKeeping}. Pick another backend.`;
  if (st?.mode !== "off") return null;
  return `${backend} has nowhere to run a stage, so a project started there would never start. Pick another backend, or set CANOPY_INCUBATOR_UNISOLATED=1 on ${backend} and restart it.`;
}

/** Why a queued project is not starting, in its backend's words (the
 *  runner away, its fence unconfirmed, stages off), or null: not queued,
 *  still being prepared, bound for canopy's own deploy or hand-off (which
 *  go without a stage), or a backend that holds nothing back. */
export function queuedWhy(s: Sprout, st: IncubatorStages | undefined): string | null {
  if (s.status !== "queued" || !s.prepared || isOwnStep(nextWorkflow(s))) return null;
  return st?.waiting ?? null;
}

/** Where a new project goes unless the user picks: home while its stages
 *  can start (a runner away still counts, since its sprouts start once it
 *  answers), else the first online backend in the page's order whose can,
 *  else home, which says why it waits. */
export function sproutBackend(
  order: readonly string[],
  home: string,
  stages: Readonly<Record<string, IncubatorStages>>,
  online: (b: string) => boolean,
): string {
  const can = (b: string): boolean => {
    const st = Object.hasOwn(stages, b) ? stages[b] : undefined;
    return st !== undefined && st.mode !== "off" && !st.notKeeping;
  };
  if (can(home)) return home;
  return order.find((b) => b !== home && online(b) && can(b)) ?? home;
}

/** What the intake form holds that a close would lose. */
export interface IntakeState {
  text: string;
  /** the links box as typed */
  links: string;
  repo: string;
  files: number;
  recording: boolean;
  /** the form's send is still on its way */
  sending: boolean;
}

const andList = (parts: readonly string[]): string =>
  parts.length < 2 ? (parts[0] ?? "") : `${parts.slice(0, -1).join(", ")} and ${parts.at(-1) ?? ""}`;

/** The question Escape or a click beside the sheet asks before it closes
 *  the intake form, naming what the form holds; null for a form with
 *  nothing in it, which closes without a word. */
export function intakeLoss(f: IntakeState): string | null {
  const parts: string[] = [];
  if (f.text.trim()) parts.push("the idea");
  const links = f.links.split(/\s+/).filter(Boolean).length;
  if (links > 0) parts.push(links === 1 ? "a link" : `${links} links`);
  if (f.repo.trim()) parts.push("the repo");
  if (f.files > 0) parts.push(f.files === 1 ? "a file" : `${f.files} files`);
  if (f.recording) parts.push("the recording");
  if (parts.length === 0 && !f.sending) return null;
  const lose = parts.length > 0 ? `Close the form and lose ${andList(parts)}?` : "Close the form?";
  return f.sending ? `${lose} It is still sending, and closing stops the upload.` : lose;
}

