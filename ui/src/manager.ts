/** The manager's top view (`?view=manager`) as rows: a ring per card, what
 *  waits on Eric, a lane per worker, and the goal's head. Pure: it reads
 *  what the store holds and imports types and pure helpers only.
 *
 *  Tones follow the view's palette: sky running or checking, lichen gated,
 *  held or waiting on Eric, moss passed or landed, rust failed, sent back
 *  or dropped, hair to come. A card's word is `cardStatus`'s; its tone is
 *  the palette's, which differs from `cardStatus`'s chip for a queued card
 *  (to come), a dropped one (rust) and a settled one that waits on Eric. */

import { SEP } from "../../src/core/backendid";
import { cardLanded } from "../../src/core/coordinator";
import type { RunGroup } from "../../src/core/group";
import { entryRefusal, followupRefusal, pickupRefusal } from "../../src/core/landing";
import { watchHolds } from "../../src/core/pr";
import {
  isFlowActive,
  isRunActive,
  type CoordTask,
  type Flow,
  type LandEntry,
  type LandingInfo,
  type LandingRun,
  type Loadout,
  type PrWatch,
  type Run,
  type RunPrompt,
  type StepStatus,
} from "../../src/core/types";
import { cardCarries, cardCounts, cardStatus, childLine, coordTurn, stepLine } from "./coord";
import { gateWords, STEP_WORD } from "./flows";
import { backLine, inQueue, runLanding, sentBack, stoppedWhole, verdictWord } from "./landing";
import { equipTitle } from "./loadouts";

export type Tone = "sky" | "lichen" | "moss" | "rust" | "hair";
export interface Arc { label: string; tone: Tone }
export interface Ring { id: string; title: string; repo: string | null; word: string; tone: Tone; model: string | null; arcs: Arc[]; at: string | null; wave: number }
export type NeedKind = "prompt" | "gate" | "landing" | "cards";
export interface Need { key: string; kind: NeedKind; card: string | null; who: string; what: string; detail: string; since: number; runId?: string; prompt?: RunPrompt; flowId?: string; landingId?: string; canLand?: boolean }
export type SayTarget = { kind: "steer"; runId: string } | { kind: "followup"; landingId: string } | { kind: "none"; why: string };
export interface Lane { id: string; title: string; word: string; tone: Tone; repo: string; branch: string | null; startedAt: number | null; live: string | null; steps: Arc[]; loadout: string | null; model: string | null; effort: string | null; skills: number; servers: number; equipTitle: string; runId: string | null; flowId: string | null; landingId: string | null; canEquip: boolean; canStartNow: boolean; canStop: boolean; canResume: boolean; say: SayTarget }
export interface Goal { text: string; model: string | null; effort: string | null; startedAt: number; working: number; waiting: number; held: boolean; ended: boolean }
export interface ManagerRows { goal: Goal; rings: Ring[]; needs: Need[]; lanes: Lane[] }
export interface ManagerInputs { runs: Record<string, Run>; flows: Record<string, Flow>; landing: LandingInfo; prs: readonly PrWatch[]; loadouts: readonly Loadout[] }

const STEP_TONE: Record<StepStatus, Tone> = {
  running: "sky",
  checking: "sky",
  gated: "lichen",
  held: "lichen",
  passed: "moss",
  failed: "rust",
  pending: "hair",
  skipped: "hair",
};

const notStarted = (t: Pick<CoordTask, "state">): boolean => t.state === "proposed" || t.state === "queued";

/** "t2, homelab": the card and its repo as a person reads it, without the backend's name. */
const whoOf = (t: CoordTask): string => `${t.id}, ${t.repo.split(SEP).pop() ?? t.repo}`;

/** When a run last did something: its newest step, else its start. */
const lastAt = (r: Run): number => r.steps[r.steps.length - 1]?.at ?? r.startedAt;

/** The step run a flow has in hand: the current step's, else the newest
 *  earlier step's the page still holds. */
function stepRun(flow: Flow, runs: Record<string, Run>): Run | undefined {
  for (let i = Math.min(flow.current, flow.steps.length - 1); i >= 0; i--) {
    const id = flow.steps[i]?.runId;
    const r = id ? runs[id] : undefined;
    if (r) return r;
  }
  return undefined;
}

interface BranchOf {
  /** the branch's id: the record's, else the one the card or its run names */
  origin: string | undefined;
  rec: LandingRun | undefined;
  entry: LandEntry | undefined;
}

/** A card's branch and what the landing queue holds of it, found as the
 *  server finds them for a follow-up: the record by the branch's id or its
 *  latest run's, the entry by the record's id. */
function branchOf(task: CoordTask, run: Run | undefined, flow: Flow | undefined, landing: LandingInfo): BranchOf {
  const named = task.branch ?? run?.branch?.origin ?? flow?.branch?.origin;
  const rec = (named ? landing.runs.find((r) => r.id === named) : undefined) ?? (run ? landing.runs.find((r) => r.runId === run.id) : undefined);
  const origin = rec?.id ?? named;
  return { origin, rec, entry: origin ? landing.entries.find((e) => e.id === origin) : undefined };
}

/** Where a lane's say box sends: a steer into the run at work, a follow-up
 *  run on a settled branch the server would take, or why neither applies.
 *  For a flow card, `run` is the step run in hand. Each refusal is asked
 *  the server's way (`entryRefusal`, then `followupRefusal` with the PR
 *  watch's hold), so the box never offers a follow-up the server answers
 *  409; `busy` is false since a run at work is a steer above it. A card
 *  waiting on the usage reset takes no words: its own run carries on. */
export function sayTarget(task: CoordTask, run: Run | undefined, flow: Flow | undefined, landing: LandingInfo, prs: readonly PrWatch[] = []): SayTarget {
  const none = (why: string): SayTarget => ({ kind: "none", why });
  if (notStarted(task)) return none("it has not started");
  if (cardLanded(task)) return none("it has landed");
  if (flow?.status === "gated") return none("release or stop its gate first");
  if (run && isRunActive(run)) return run.harness === "codex" ? none("a Codex worker takes no message mid-turn") : { kind: "steer", runId: run.id };
  if (task.limited === 0) return none("it carries on after the reset");
  if (flow && isFlowActive(flow)) return none("no step of its flow is at work just now");
  const { origin, rec, entry } = branchOf(task, run, flow, landing);
  // the queue's hold comes ahead of a stopped flow, whose pickup it refuses too
  const held = entryRefusal(entry);
  if (held) return none(held);
  if (flow?.status === "stopped") return none("pick its flow up first");
  if (!origin) return none("it has no branch to follow up on");
  // a stopped flow was answered above, so it needs no flowStopped here
  const refused = followupRefusal(rec, entry, false, origin, { pr: watchHolds(prs.find((w) => w.id === origin)) });
  if (refused || !rec) return none(refused?.error ?? `canopy holds no branch ${origin}`);
  return { kind: "followup", landingId: rec.id };
}

/** Whom the manager chat's box speaks to, from the card Eric picked in its
 *  "to" list (`to`, "" for the manager). `options` are the lanes that take
 *  words now, and the picked lane whatever it takes. A picked lane that
 *  stops taking words stays picked, with `shut` saying why, so a draft
 *  never goes to the manager unless Eric picks the manager. A picked card
 *  no longer on the goal leaves the manager. */
export function chatAim(lanes: readonly Lane[], to: string): { options: Lane[]; lane?: Lane; shut?: string } {
  const lane = to ? lanes.find((l) => l.id === to) : undefined;
  const options = lanes.filter((l) => l.say.kind !== "none" || l === lane);
  if (!lane) return { options };
  if (lane.say.kind !== "none") return { options, lane };
  return { options, lane, shut: `${lane.id} takes no words now: ${lane.say.why}. Pick the manager or another worker to send this.` };
}

/** Each card's wave by `after`: 0 with nothing it waits for here, else one
 *  past the highest wave it names. A card met again inside a cycle counts
 *  as wave 0 there, and no wave passes the card count. */
export function waves(tasks: readonly CoordTask[]): Map<string, number> {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const done = new Map<string, number>();
  const visiting = new Set<string>();
  const wave = (id: string): number => {
    const known = done.get(id);
    if (known !== undefined) return known;
    if (visiting.has(id)) return 0;
    visiting.add(id);
    let w = 0;
    for (const a of byId.get(id)?.after ?? []) if (byId.has(a)) w = Math.max(w, wave(a) + 1);
    visiting.delete(id);
    const capped = Math.min(w, tasks.length);
    done.set(id, capped);
    return capped;
  };
  return new Map(tasks.map((t) => [t.id, wave(t.id)]));
}

/** A goal in words: the coordinator's first message, else its note. */
export const goalText = (coord: Run): string => coord.steps.find((s) => s.kind === "user" && s.text)?.text ?? coord.note;

/** The coordinators still going, newest first. */
export function liveCoordinators(runs: Record<string, Run>): Run[] {
  return Object.values(runs)
    .filter((r) => r.action === "coordinate" && isRunActive(r))
    .sort((a, b) => b.startedAt - a.startedAt);
}

/** What one card has in the store. */
interface Work {
  task: CoordTask;
  run: Run | undefined;
  flow: Flow | undefined;
  /** who works for the card: its run, or its flow's step run in hand */
  worker: Run | undefined;
  branch: BranchOf;
  /** the run whose branch the landing queue holds, once no flow works on it:
   *  the card's run, or the record's latest run (a flow hands its branch
   *  over by its last step's run) */
  landed: Run | undefined;
  group: RunGroup | undefined;
}

function workOf(task: CoordTask, at: ManagerInputs): Work {
  const run = task.run ? at.runs[task.run] : undefined;
  const flow = task.flow ? at.flows[task.flow] : undefined;
  const worker = flow ? stepRun(flow, at.runs) : run;
  const branch = branchOf(task, worker, flow, at.landing);
  const landed = flow && isFlowActive(flow) ? undefined : (run ?? (branch.rec ? at.runs[branch.rec.runId] : undefined));
  const group = task.group ? at.landing.groups?.find((g) => g.id === task.group) : undefined;
  return { task, run, flow, worker, branch, landed, group };
}

/* ---------- rings ---------- */

/** A propose card's plan: waiting on Eric's approval, approved, turned down. */
function planTone(task: CoordTask, run: Run | undefined): Tone {
  if (!run) return notStarted(task) ? "hair" : task.outcome === "plan turned down" ? "rust" : task.state === "running" ? "sky" : task.state === "done" ? "moss" : "hair";
  switch (run.proposalState) {
    case "approved":
    case "approved-auto":
      return "moss";
    case "waiting":
      return "lichen";
    case "turned down":
      return "rust";
    case "sent back":
      return isRunActive(run) ? "sky" : "rust";
    case undefined:
      break;
  }
  if (isRunActive(run)) return run.prompt?.kind === "proposal" ? "lichen" : "sky";
  if (run.status === "limited") return "lichen";
  return run.status === "failed" || run.status === "stopped" ? "rust" : "moss";
}

/** The build: sky while the run works, moss once its branch settled
 *  ready, rust when it failed, stopped or left changes uncommitted. A run
 *  the usage limit holds is lichen. Without the run, its branch's record
 *  says, else the card. */
function buildTone(task: CoordTask, run: Run | undefined, rec: LandingRun | undefined): Tone {
  if (run && isRunActive(run)) return "sky";
  if (run?.status === "failed" || run?.status === "stopped") return "rust";
  if (run?.status === "limited") return "lichen";
  switch (rec?.state ?? run?.branch?.state) {
    case "working":
      return "sky";
    case "ready":
    case "nothing":
      return "moss";
    case "stopped":
    case "uncommitted":
      return "rust";
    case undefined:
      break;
  }
  if (task.state === "done") return "moss";
  if (task.state === "running") return "sky";
  return task.state === "failed" ? "rust" : "hair";
}

/** The land: hair until ready, lichen while its verdict waits for Eric, it
 *  was sent back or it waits on the judge, sky while the queue works it
 *  (or a ready branch waits to be sorted or queued, or its PR is open),
 *  moss once landed, rust once dropped or its PR closed. */
function landTone(task: CoordTask, b: BranchOf, watch: PrWatch | undefined): Tone {
  const { rec, entry } = b;
  if (entry?.state === "landed" || cardLanded(task)) return "moss";
  if (entry && (entry.state === "judge" || sentBack(entry))) return "lichen";
  if (entry && inQueue(entry)) return "sky";
  if (task.state === "dropped" || task.outcome === "dropped") return "rust";
  if (rec?.pr !== undefined) {
    const s = watch?.state?.status;
    return s === "merged" ? "moss" : s === "closed" ? "rust" : "sky";
  }
  if (rec?.state === "ready") return rec.review && rec.review.verdict !== "auto" ? "lichen" : "sky";
  return "hair";
}

/** A plain run's lifecycle: plan (a propose card only), build, land. The
 *  build waits while the plan has not been approved. */
function lifeArcs(w: Work, watch: PrWatch | undefined): Arc[] {
  const run = w.run ?? w.landed;
  const plan = w.task.action === "propose" ? planTone(w.task, run) : null;
  const build = plan !== null && plan !== "moss" ? "hair" : buildTone(w.task, run, w.branch.rec);
  return [...(plan !== null ? [{ label: "plan", tone: plan }] : []), { label: "build", tone: build }, { label: "land", tone: landTone(w.task, w.branch, watch) }];
}

/** "2/3": the first arc not passed yet, or the last when all have. */
function inHand(arcs: readonly Arc[]): string | null {
  if (arcs.length === 0) return null;
  const i = arcs.findIndex((a) => a.tone !== "moss");
  return `${i < 0 ? arcs.length : i + 1}/${arcs.length}`;
}

/** A card's arcs: its flow's steps, else its lifecycle. */
function arcsOf(w: Work, prs: readonly PrWatch[]): { arcs: Arc[]; at: string | null } {
  const f = w.flow;
  if (f && f.steps.length > 0) return { arcs: f.steps.map((s) => ({ label: s.name, tone: STEP_TONE[s.status] })), at: `${Math.min(f.current, f.steps.length - 1) + 1}/${f.steps.length}` };
  const watch = w.branch.origin ? prs.find((p) => p.id === w.branch.origin) : undefined;
  const arcs = lifeArcs(w, watch);
  return { arcs, at: notStarted(w.task) ? null : inHand(arcs) };
}

/** The card's tone: proposed waits on Eric's start, queued is to come,
 *  failed and dropped are rust, a branch sent back is rust, anything else
 *  waiting on Eric is lichen, else done is moss and running sky. */
function cardTone(task: CoordTask, asks: boolean, entry: LandEntry | undefined): Tone {
  switch (task.state) {
    case "proposed":
      return "lichen";
    case "queued":
      return "hair";
    case "failed":
    case "dropped":
      return "rust";
    case "running":
    case "done":
      if (entry && sentBack(entry)) return "rust";
      if (asks) return "lichen";
      return task.state === "done" ? "moss" : "sky";
  }
}

/* ---------- needs ---------- */

function promptWords(p: RunPrompt): { what: string; detail: string } {
  switch (p.kind) {
    case "proposal":
      return { what: "Plan waits for your approval", detail: stepLine({ id: p.id, at: 0, kind: "text", text: p.plan }) };
    case "question":
      return { what: p.questions.length === 1 ? "Asks you a question" : `Asks you ${p.questions.length} questions`, detail: p.questions[0]?.question ?? "" };
    case "permission":
      return { what: `Asks to use ${p.tool}`, detail: p.title };
  }
}

/** A prompt a run waits on, the coordinator's (no card) or a worker's. */
function promptNeed(r: Run | undefined, task: CoordTask | null, flowId?: string): Need | null {
  if (!r?.prompt || !isRunActive(r)) return null;
  return {
    key: `prompt:${r.id}:${r.prompt.id}`,
    kind: "prompt",
    card: task?.id ?? null,
    who: task ? whoOf(task) : "manager",
    ...promptWords(r.prompt),
    since: lastAt(r),
    runId: r.id,
    prompt: r.prompt,
    ...(flowId ? { flowId } : {}),
  };
}

/** A card's flow parked at a gate, from when its step's run ended. */
function gateNeed(task: CoordTask, flow: Flow, runs: Record<string, Run>): Need | null {
  if (flow.status !== "gated") return null;
  const s = flow.steps[flow.current];
  const ended = s?.runId ? runs[s.runId]?.endedAt : undefined;
  return {
    key: `gate:${flow.id}`,
    kind: "gate",
    card: task.id,
    who: whoOf(task),
    what: s ? `${s.name}: ${STEP_WORD[s.status]}` : `${flow.verb}: waiting for you`,
    detail: s?.reason ?? gateWords(flow).title ?? "",
    since: ended ?? flow.startedAt,
    flowId: flow.id,
    ...(s?.runId ? { runId: s.runId } : {}),
  };
}

/** Where a card's branch stands in the landing queue, as far as Eric's say
 *  goes. `runLanding` reads it when the page holds the branch's run; once
 *  the runner has let the run go (it keeps only so many finished ones), the
 *  record and the entry the queue still holds say the same alone. */
interface LandView {
  canLand: boolean;
  /** sent back with no fix going */
  canFix: boolean;
  entry: LandEntry | undefined;
  /** the verdict in words, once sorted */
  verdict: string | undefined;
  /** the branch's latest run */
  runId: string | undefined;
  /** when the branch settled ready */
  readyAt: number;
}

function landView(w: Work, landing: LandingInfo): LandView | null {
  const { rec, entry } = w.branch;
  const r = w.landed;
  if (r) {
    const rl = runLanding(r, landing);
    if (!rl) return null;
    return { canLand: rl.canLand, canFix: rl.canFix, entry: rl.entry, verdict: rl.verdict, runId: r.id, readyAt: rec?.review?.at ?? rec?.endedAt ?? r.endedAt ?? r.startedAt };
  }
  if (w.flow && isFlowActive(w.flow)) return null;
  if (!rec && !entry) return null;
  const readyAt = rec?.review?.at ?? rec?.endedAt ?? rec?.startedAt ?? 0;
  if (entry) return { canLand: false, canFix: sentBack(entry) && entry.fixing === undefined, entry, verdict: undefined, runId: rec?.runId, readyAt };
  if (!rec || rec.pr !== undefined) return null;
  // a best-of-N member lands only as its group's picked winner
  const group = rec.group ? landing.groups?.find((g) => g.id === rec.group) : undefined;
  const outOfGroup = group !== undefined && (group.state !== "picked" || group.winner !== rec.id);
  const canLand = !outOfGroup && (rec.state === "ready" || stoppedWhole(rec));
  return { canLand, canFix: false, entry: undefined, verdict: canLand && rec.review ? verdictWord(rec) : undefined, runId: rec.runId, readyAt };
}

/** A card's branch the queue leaves to Eric: a verdict of land or approve,
 *  sent back with no fix going, or held for the judge. */
function landingNeed(w: Work, landing: LandingInfo): Need | null {
  const v = landView(w, landing);
  const id = v?.entry?.id ?? w.branch.origin;
  if (!v || !id) return null;
  const base = { key: `landing:${id}`, kind: "landing" as const, card: w.task.id, who: whoOf(w.task), landingId: id, ...(v.runId ? { runId: v.runId } : {}) };
  const verdict = w.branch.rec?.review?.verdict;
  if (v.canLand && (verdict === "land" || verdict === "approve")) {
    return { ...base, what: verdict === "approve" ? "Waits for your approval to land" : "Waits for your land", detail: v.verdict ?? "", since: v.readyAt, canLand: true };
  }
  if (v.canFix && v.entry) return { ...base, what: "Sent back from the landing queue", detail: backLine(v.entry), since: v.entry.updatedAt, canLand: false };
  if (v.entry?.state === "judge") return { ...base, what: "A scenario waits for a judge", detail: v.entry.reason ?? "", since: v.entry.updatedAt, canLand: false };
  return null;
}

/** Everything of one card that waits on Eric: prompts on its run, its
 *  group's member runs and its flow's step runs, its flow's gate, its
 *  branch's landing. */
function cardNeeds(w: Work, at: ManagerInputs): Need[] {
  const out: (Need | null)[] = [promptNeed(w.run, w.task)];
  for (const m of w.group?.members ?? []) out.push(promptNeed(at.runs[m.run], w.task));
  if (w.flow) {
    const flowId = w.flow.id;
    for (const s of w.flow.steps) out.push(promptNeed(s.runId ? at.runs[s.runId] : undefined, w.task, flowId));
    out.push(gateNeed(w.task, w.flow, at.runs));
  }
  out.push(landingNeed(w, at.landing));
  return out.filter((n): n is Need => n !== null);
}

/* ---------- the view ---------- */

/** The model a run works on: its settings, else what its loadout resolved to. */
const modelOf = (r: Run | undefined): string | undefined => r?.agentSettings?.model ?? r?.equip?.model;
const effortOf = (r: Run | undefined): string | undefined => r?.agentSettings?.effort ?? r?.equip?.effort;

/** What a card's worker carries: the worker run's own settings and equip,
 *  else the card's equip, else its loadout's in kit.json. */
interface Carried {
  loadout: string | null;
  model: string | null;
  effort: string | null;
  skills: number;
  servers: number;
  title: string;
}

function carriedOf(w: Work, loadouts: readonly Loadout[]): Carried {
  const { task, worker } = w;
  const equip = worker?.equip;
  const name = equip?.loadout ?? task.equip?.loadout;
  const lo = name ? loadouts.find((l) => l.name === name) : undefined;
  return {
    loadout: name ?? null,
    model: modelOf(worker) ?? task.equip?.model ?? lo?.model ?? null,
    effort: effortOf(worker) ?? task.equip?.effort ?? lo?.effort ?? null,
    skills: equip?.skills.length ?? task.equip?.skills?.length ?? lo?.skills.length ?? 0,
    servers: equip?.mcp.length ?? task.equip?.mcp?.length ?? lo?.mcp.length ?? 0,
    title: equip ? equipTitle(equip) : (cardCarries(task).loadout?.title ?? ""),
  };
}

/** How a card reads on its ring and its lane. */
interface Look {
  word: string;
  tone: Tone;
  /** `cardStatus`'s line under the card */
  line: string;
  arcs: Arc[];
  at: string | null;
  carried: Carried;
}

function laneOf(w: Work, coord: Run, at: ManagerInputs, look: Look): Lane {
  const { task, run, flow, worker } = w;
  const live = (() => {
    if (!flow || !isFlowActive(flow)) return look.line;
    const s = flow.steps[flow.current];
    const sr = s?.runId ? at.runs[s.runId] : undefined;
    const line = sr ? childLine(sr) : "";
    return s && line ? `${s.name}: ${line}` : look.line;
  })();
  const say = sayTarget(task, worker, flow, at.landing, at.prs);
  const fresh = notStarted(task);
  const c = look.carried;
  return {
    id: task.id,
    title: task.title,
    word: look.word,
    tone: look.tone,
    repo: task.repo,
    branch: run?.branch?.name ?? flow?.branch?.name ?? w.branch.rec?.branch ?? null,
    startedAt: run?.startedAt ?? flow?.startedAt ?? null,
    live: live || null,
    steps: look.arcs,
    loadout: c.loadout,
    model: c.model,
    effort: c.effort,
    skills: c.skills,
    servers: c.servers,
    equipTitle: c.title,
    runId: task.run ?? null,
    flowId: task.flow ?? null,
    landingId: w.branch.rec?.id ?? null,
    // an ended goal's cards no longer change: no equip, no start
    canEquip: fresh && isRunActive(coord),
    canStartNow: fresh && !coord.held && isRunActive(coord),
    canStop: (run !== undefined && isRunActive(run)) || (flow !== undefined && isFlowActive(flow)),
    // a resume is a follow-up with no words, so it applies where the server
    // takes one; a stopped flow's pickup where the server takes that: no
    // landing entry on its branch and no PR the PR watch holds
    canResume:
      (run?.status === "stopped" && say.kind === "followup") ||
      (flow?.status === "stopped" && flow.branch !== undefined && pickupRefusal(w.branch.entry, false, watchHolds(at.prs.find((p) => p.id === w.branch.origin))) === null),
    say,
  };
}

/** Whether a card's worker is at work: its run, or its flow short of a
 *  gate, which waits on Eric and counts there instead. */
const atWork = (w: Work): boolean => (w.run !== undefined && isRunActive(w.run)) || (w.flow !== undefined && isFlowActive(w.flow) && w.flow.status !== "gated");

/** The manager's own state in a word: ended, held, waiting on Eric, or at work. */
function managerLook(coord: Run, asks: boolean): { word: string; tone: Tone } {
  if (!isRunActive(coord)) return coord.status === "failed" ? { word: "failed", tone: "rust" } : { word: "ended", tone: "hair" };
  if (coord.held) return { word: "held", tone: "lichen" };
  if (asks) return { word: "needs you", tone: "lichen" };
  return { word: coord.status === "working" ? "working" : "idle", tone: "sky" };
}

/** The top view of one coordinator's goal. */
export function managerRows(coord: Run, at: ManagerInputs): ManagerRows {
  const tasks = coord.tasks ?? [];
  const works = tasks.map((t) => workOf(t, at));
  const wave = waves(tasks);

  // the manager's own come before a card's at the same moment, then card order
  const found: { need: Need; order: number }[] = [];
  const own = promptNeed(coord, null);
  if (own) found.push({ need: own, order: -1 });
  const turn = isRunActive(coord) ? coordTurn(coord) : null;
  if (turn) {
    const detail = tasks.filter((t) => t.state === "proposed").map((t) => `${t.id} ${t.title}`).join("; ");
    found.push({ need: { key: `cards:${coord.id}`, kind: "cards", card: null, who: "manager", what: turn, detail, since: lastAt(coord) }, order: -1 });
  }
  works.forEach((w, i) => {
    for (const need of cardNeeds(w, at)) found.push({ need, order: i });
  });
  // one item per key: a run can be both a card's and its flow's step's
  const byKey = new Map<string, { need: Need; order: number }>();
  for (const f of found) if (!byKey.has(f.need.key)) byKey.set(f.need.key, f);
  const needs = [...byKey.values()].sort((a, b) => a.need.since - b.need.since || a.order - b.order).map(({ need }) => need);

  const model = modelOf(coord) ?? null;
  const cards = works.map((w) => {
    const status = cardStatus(w.task, w.run ?? w.landed, at.landing, at.prs, w.group, w.flow);
    const tone = cardTone(w.task, needs.some((x) => x.card === w.task.id), w.branch.entry);
    const look: Look = { word: status.word, tone, line: status.line, ...arcsOf(w, at.prs), carried: carriedOf(w, at.loadouts) };
    return { w, look };
  });
  const n = tasks.length;
  const manager: Ring = {
    id: "manager",
    title: cardCounts(tasks),
    repo: null,
    ...managerLook(coord, needs.some((x) => x.card === null)),
    model,
    arcs: cards.map(({ w, look }) => ({ label: w.task.id, tone: look.tone })),
    at: `${n} ${n === 1 ? "card" : "cards"}`,
    wave: 0,
  };
  const rings: Ring[] = [
    manager,
    ...cards.map(({ w, look }): Ring => ({ id: w.task.id, title: w.task.title, repo: w.task.repo, word: look.word, tone: look.tone, model: look.carried.model, arcs: look.arcs, at: look.at, wave: wave.get(w.task.id) ?? 0 })),
  ];
  const lanes = cards.map(({ w, look }) => laneOf(w, coord, at, look));
  return {
    goal: {
      text: goalText(coord),
      model,
      effort: effortOf(coord) ?? null,
      startedAt: coord.startedAt,
      working: works.filter(atWork).length,
      waiting: needs.length,
      held: coord.held === true,
      ended: !isRunActive(coord),
    },
    rings,
    needs,
    lanes,
  };
}
