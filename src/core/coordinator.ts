/** The coordinator's pure half (FR-010): checking a plan it proposes, which
 *  queued cards start now, and the note a settled child sends back into its
 *  chat. Browser-safe: the hub in `server/coordinator.ts` keeps the state
 *  and calls these, and the UI may name a card's outcome with them. */

import { GROUP_MAX, type RunGroup } from "./group";
import { takesEffort, takesModel } from "./harness";
import { inQueue, landWord, sentBack } from "./landing";
import { isRunActive, type GateKind, type StepMode, type WorkflowEntry, type CardEquip, type CoordTask, type Flow, type LandEntry, type LoadoutsInfo, type ReviewVerdict, type Repo, type Run, type RunBranchState } from "./types";

/** tasks one plan call may add */
export const MAX_PLAN = 8;
/** tasks one coordinator may hold in all */
export const MAX_TASKS = 20;
/** children working at once per coordinator: the fleet's cap (FLEET_CONCURRENCY) */
export const COORD_AT_ONCE = 3;
export const MAX_TITLE = 120;
export const MAX_NOTE = 4000;
/** what a goal started from the top may carry: its text, the repos it names,
 *  the files it brings, and their bytes in all (25 MB) */
export const GOAL_LIMITS = { goal: 20000, repos: 20, files: 10, bytes: 26214400 } as const;
/** the repo id a goal started from the top is held at: no repo, a fixed anchor */
export const GOAL_ANCHOR = "~goal";
/** the characters of a child's result line a settle note keeps, its head
 *  and its tail together (`oneLine`) */
export const RESULT_CHARS = 1200;

/** A card as the coordinator proposes it, before canopy numbers it. */
export type PlannedTask = Omit<CoordTask, "id" | "state">;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** One text field of a task, trimmed, or why it cannot be. */
function text(t: Record<string, unknown>, at: string, field: "title" | "note", max: number): string | { error: string } {
  const v = t[field];
  if (typeof v !== "string") return { error: `${at}.${field} must be text` };
  const s = v.trim();
  if (!s) return { error: `${at}.${field} is empty` };
  if (s.length > max) return { error: `${at}.${field} is over ${max} characters` };
  return s;
}

/** What a plan or an edit is checked against. */
export interface PlanContext {
  known: (repo: string) => "local" | "remote" | null;
  /** every card the coordinator holds now */
  cards: readonly CoordTask[];
  /** the number the next new card takes: the plan's cards are t<next>, t<next+1>, ... */
  next: number;
  loadouts: LoadoutsInfo;
  /** the workflows a card in this repo may name */
  workflows: (repo: string) => readonly { name: string; fromRepo: boolean }[];
  by: "coordinator" | "person";
  /** the goal's file names, which a card's `files` may list (empty for a repo-card goal) */
  files: readonly string[];
}

const EQUIP_KEYS = ["loadout", "model", "effort", "skills", "mcp"] as const;

/** A card's `equip` off the wire: a coordinator names a loadout and nothing
 *  else; Eric may override the loadout's model, effort, skills and servers,
 *  and only with what the loadout's harness takes. */
function checkEquip(v: unknown, at: string, ctx: PlanContext): { equip: CardEquip | undefined } | { error: string } {
  if (!isRecord(v)) return { error: `${at}.equip must be an object` };
  for (const k of Object.keys(v)) {
    if (!(EQUIP_KEYS as readonly string[]).includes(k)) return { error: `${at}.equip.${k}: not a card field` };
  }
  const given = Object.keys(v).filter((k) => v[k] !== undefined);
  const fields = given.filter((k) => k !== "loadout");
  if (ctx.by === "coordinator" && fields.length > 0) return { error: `${at}.equip: a coordinator names a loadout; its fields are Eric's` };
  const name = v["loadout"];
  if (name === undefined) {
    if (fields.length > 0) return { error: `${at}.equip: name a loadout before changing its fields` };
    return { equip: undefined };
  }
  if (typeof name !== "string" || !name) return { error: `${at}.equip.loadout must be a loadout name` };
  const lo = ctx.loadouts.loadouts.find((l) => l.name === name);
  if (!lo) return { error: `${at}.equip.loadout: no loadout ${name} in kit.json` };
  const equip: CardEquip = { loadout: name };
  if (lo.harness === "codex" && (v["skills"] !== undefined || v["mcp"] !== undefined)) {
    return { error: `${at}.equip: a codex loadout takes no skills or servers` };
  }
  const model = v["model"];
  if (model !== undefined) {
    if (!takesModel(lo.harness, model)) return { error: `${at}.equip.model: ${lo.harness} does not take ${String(model)}` };
    equip.model = model;
  }
  const effort = v["effort"];
  if (effort !== undefined) {
    if (!takesEffort(lo.harness, effort)) return { error: `${at}.equip.effort: ${lo.harness} does not take ${String(effort)}` };
    equip.effort = effort;
  }
  for (const k of ["skills", "mcp"] as const) {
    const l = v[k];
    if (l === undefined) continue;
    if (!Array.isArray(l) || l.some((x) => typeof x !== "string" || !x)) return { error: `${at}.equip.${k} must be a list of names` };
    equip[k] = l as string[];
  }
  return { equip };
}

/** Why a card's loadout cannot run what the card asks of it, or null: plan,
 *  then build and every step of a card's flow need Claude Code, so a codex
 *  loadout fits neither. A loadout kit.json no longer holds is not read. */
function harnessRefusal(at: string, loadout: string | undefined, action: unknown, workflow: unknown, ctx: PlanContext): string | null {
  const lo = loadout === undefined ? undefined : ctx.loadouts.loadouts.find((l) => l.name === loadout);
  if (!lo || lo.harness === "claude") return null;
  if (workflow !== undefined && workflow !== null) return `${at}.equip.loadout: ${lo.name} runs ${lo.harness}; a card's flow needs Claude Code`;
  if (action === "propose") return `${at}.equip.loadout: ${lo.name} runs ${lo.harness}; plan, then build needs Claude Code`;
  return null;
}

/** One card off the wire, checked on its own. `self` is the id it will have
 *  and `ids` every id its `after` may name. */
function checkCard(t: unknown, at: string, self: string, ids: ReadonlySet<string>, ctx: PlanContext): PlannedTask | { error: string } {
  if (!isRecord(t)) return { error: `${at} must be an object` };
  const title = text(t, at, "title", MAX_TITLE);
  if (typeof title !== "string") return title;
  const note = text(t, at, "note", MAX_NOTE);
  if (typeof note !== "string") return note;
  const repo = t["repo"];
  if (typeof repo !== "string" || !repo) return { error: `${at}.repo must be a repo id` };
  const where = ctx.known(repo);
  if (where === null) return { error: `${at}.repo: no repo ${repo} on this backend` };
  if (where === "remote") return { error: `${at}.repo: ${repo} is on another host; a task runs in a local repo` };
  const action = t["action"];
  if (action !== "propose" && action !== "ask") return { error: `${at}.action must be propose or ask` };
  const times = t["times"];
  if (times !== undefined && (typeof times !== "number" || !Number.isInteger(times) || times < 1 || times > GROUP_MAX)) {
    return { error: `${at}.times must be 1 to ${GROUP_MAX}` };
  }
  const out: PlannedTask = { title, repo, note, action, ...(typeof times === "number" && times > 1 ? { times } : {}) };

  if (t["equip"] !== undefined) {
    const got = checkEquip(t["equip"], at, ctx);
    if ("error" in got) return got;
    if (got.equip) out.equip = got.equip;
  }

  const workflow = t["workflow"];
  if (workflow !== undefined) {
    if (typeof workflow !== "string" || !workflow) return { error: `${at}.workflow must be a workflow name` };
    const own = t["workflowRepo"];
    if (own !== undefined && own !== true) return { error: `${at}.workflowRepo must be true` };
    if (own === true && ctx.by === "coordinator") return { error: `${at}.workflowRepo: a repo's own workflow is Eric's to pick` };
    const named = ctx.workflows(repo).filter((w) => w.name === workflow);
    // a coordinator gets the bundled or user workflow of that name, never the repo's
    const match = ctx.by === "coordinator" ? named.find((w) => !w.fromRepo) : own === true ? named.find((w) => w.fromRepo) : (named.find((w) => !w.fromRepo) ?? named[0]);
    if (!match) return { error: `${at}.workflow: no workflow ${workflow} for ${repo}` };
    if (out.times !== undefined) return { error: `${at}: a card with a workflow starts one run` };
    out.workflow = workflow;
    if (match.fromRepo) out.workflowRepo = true;
  }

  const after = t["after"];
  if (after !== undefined) {
    if (!Array.isArray(after) || after.some((x) => typeof x !== "string")) return { error: `${at}.after must be a list of card ids` };
    const seen = new Set<string>();
    for (const id of after as string[]) {
      if (id === self) return { error: `${at}.after: a card cannot wait for itself` };
      if (seen.has(id)) return { error: `${at}.after: ${id} is named twice` };
      if (!ids.has(id)) return { error: `${at}.after: no card ${id}` };
      seen.add(id);
    }
    if (after.length > 0) out.after = after as string[];
  }
  const files = t["files"];
  if (files !== undefined) {
    if (!Array.isArray(files) || files.some((x) => typeof x !== "string")) return { error: `${at}.files must be a list of the goal's file names` };
    const names = files as string[];
    if (names.length > GOAL_LIMITS.files) return { error: `${at}.files: at most ${GOAL_LIMITS.files} files` };
    for (const name of names) {
      if (ctx.files.length === 0) return { error: `${at}.files: the goal has no files` };
      if (!ctx.files.includes(name)) return { error: `${at}.files: the goal has no file ${name}` };
    }
    if (names.length > 0) {
      if (out.times !== undefined || out.workflow !== undefined) return { error: `${at}.files: a card with files runs once, without a workflow` };
      out.files = [...new Set(names)];
    }
  }
  const refused = harnessRefusal(at, out.equip?.loadout, out.action, out.workflow, ctx);
  if (refused) return { error: refused };
  return out;
}

const andList = (ids: readonly string[]): string => (ids.length < 2 ? (ids[0] ?? "") : `${ids.slice(0, -1).join(", ")} and ${ids[ids.length - 1]}`);

/** The cards in a loop of `after`s that `start` is part of, in the order the
 *  walk first finds them, or null when `start` waits for no loop through itself. */
function waitLoop(start: string, after: ReadonlyMap<string, readonly string[]>): string[] | null {
  const path: string[] = [];
  const dead = new Set<string>();
  const walk = (id: string): boolean => {
    if (id === start && path.length > 0) return true;
    if (dead.has(id) || path.includes(id)) return false;
    path.push(id);
    for (const n of after.get(id) ?? []) if (walk(n)) return true;
    path.pop();
    dead.add(id);
    return false;
  };
  return walk(start) ? path : null;
}

/** A plan's tasks off the wire, checked against the limits: at most 8 in a
 *  call and 20 in all, a title of at most 120 characters, a note of at most
 *  4000, `propose` or `ask`, a repo this backend knows on this machine, a
 *  `times` of 1 to `GROUP_MAX`, and the card fields: an `equip` (a
 *  coordinator names only a loadout), a `workflow` the repo can run (alone
 *  in its card, never with `times`) and an `after` of cards that exist, in
 *  the plan or already held, with no card waiting on itself or in a loop.
 *  An error names the task's index and the field, so the coordinator can fix
 *  its plan. */
export function validatePlan(input: unknown, ctx: PlanContext): { tasks: PlannedTask[] } | { error: string } {
  if (!Array.isArray(input)) return { error: "tasks must be a list" };
  if (input.length === 0) return { error: "a plan needs at least one task" };
  if (input.length > MAX_PLAN) return { error: `at most ${MAX_PLAN} tasks per plan; this one has ${input.length}` };
  const have = ctx.cards.length;
  if (have + input.length > MAX_TASKS) {
    return { error: `a coordinator holds at most ${MAX_TASKS} tasks; it has ${have} and this plan adds ${input.length}` };
  }
  const ids = new Set<string>([...ctx.cards.map((c) => c.id), ...input.map((_, i) => `t${ctx.next + i}`)]);
  const tasks: PlannedTask[] = [];
  for (const [i, t] of input.entries()) {
    const got = checkCard(t, `tasks[${i}]`, `t${ctx.next + i}`, ids, ctx);
    if ("error" in got) return got;
    tasks.push(got);
  }
  const graph = new Map<string, readonly string[]>(ctx.cards.map((c) => [c.id, c.after ?? []]));
  for (const [i, t] of tasks.entries()) graph.set(`t${ctx.next + i}`, t.after ?? []);
  for (const i of tasks.keys()) {
    const loop = waitLoop(`t${ctx.next + i}`, graph);
    if (loop) return { error: `tasks[${i}].after: ${andList(loop)} wait for each other` };
  }
  return { tasks };
}

/** Edits to a card that has not started. A proposed card changes in every
 *  field the plan has; a queued card only in its `equip` and `after`; any
 *  other state changes nothing. `b` holds the fields to change (`null` clears
 *  `equip`, `workflow` and `after`), and `ctx.cards` every card of the
 *  coordinator, the edited one included. Errors name the card by its id. */
export function editCard(t: CoordTask, b: Record<string, unknown>, ctx: PlanContext): { task: CoordTask } | { error: string } {
  if (t.state !== "proposed" && t.state !== "queued") return { error: `${t.id} is ${t.state}; only a proposed or queued card changes` };
  if (t.state === "queued") {
    for (const k of ["title", "note", "repo", "action", "times", "workflow", "workflowRepo", "files"]) {
      if (b[k] !== undefined) return { error: `${t.id} is queued; only its loadout and after change` };
    }
  }
  // only what `b` supplies is checked; every other field is carried as stored,
  // so a loadout, workflow or repo gone since the card was made does not stop an edit of `after`
  const has = (k: string): boolean => b[k] !== undefined;
  const equipSet = has("equip");
  const flowSet = has("workflow") || has("workflowRepo");
  const afterSet = has("after");
  const filesSet = has("files");
  const merged: Record<string, unknown> = {
    title: b["title"] ?? t.title,
    note: b["note"] ?? t.note,
    repo: b["repo"] ?? t.repo,
    action: b["action"] ?? t.action,
    times: b["times"] ?? t.times,
    ...(equipSet && b["equip"] !== null ? { equip: b["equip"] } : {}),
    ...(flowSet && b["workflow"] !== null ? { workflow: b["workflow"] ?? t.workflow, workflowRepo: has("workflow") ? b["workflowRepo"] : (b["workflowRepo"] ?? t.workflowRepo) } : {}),
    ...(afterSet && b["after"] !== null ? { after: b["after"] } : {}),
    ...(filesSet ? (b["files"] !== null ? { files: b["files"] } : {}) : t.files ? { files: t.files } : {}),
  };
  if (filesSet && b["files"] !== null && !flowSet && t.workflow !== undefined) {
    return { error: `${t.id}.files: a card with files runs once, without a workflow` };
  }
  if (!flowSet && t.workflow !== undefined && typeof merged["times"] === "number" && merged["times"] > 1) {
    return { error: `${t.id}: a card with a workflow starts one run` };
  }
  const ids = new Set(ctx.cards.map((c) => c.id));
  ids.add(t.id);
  const repoGone = !has("repo") ? t.repo : null;
  // files the card already keeps stay valid even when the context no longer lists them
  const check: PlanContext = { ...ctx, files: [...ctx.files, ...(filesSet ? [] : (t.files ?? []))], known: (r) => (r === repoGone ? "local" : ctx.known(r)) };
  const got = checkCard(merged, t.id, t.id, ids, check);
  if ("error" in got) return got;
  // a new action or workflow is checked against the loadout the card keeps
  if (!equipSet && (has("action") || flowSet)) {
    const refused = harnessRefusal(t.id, t.equip?.loadout, got.action, flowSet ? got.workflow : t.workflow, ctx);
    if (refused) return { error: refused };
  }
  const after = afterSet ? got.after : t.after;
  const graph = new Map<string, readonly string[]>(ctx.cards.map((c) => [c.id, c.after ?? []]));
  graph.set(t.id, after ?? []);
  const loop = afterSet ? waitLoop(t.id, graph) : null;
  if (loop) return { error: `${t.id}.after: ${andList(loop)} wait for each other` };
  const { times: _t, equip: _e, workflow: _w, workflowRepo: _r, after: _a, files: _f, ...kept } = t;
  const { equip: _ge, workflow: _gw, workflowRepo: _gr, after: _ga, files: _gf, ...fields } = got;
  const files = filesSet ? got.files : t.files;
  const equip = equipSet ? got.equip : t.equip;
  const workflow = flowSet ? got.workflow : t.workflow;
  const workflowRepo = flowSet ? got.workflowRepo : t.workflowRepo;
  return {
    task: {
      ...kept,
      ...fields,
      ...(equip ? { equip } : {}),
      ...(workflow ? { workflow } : {}),
      ...(workflowRepo ? { workflowRepo } : {}),
      ...(after && after.length > 0 ? { after } : {}),
      ...(files && files.length > 0 ? { files } : {}),
    },
  };
}

/** Whether a card has landed, the only state `after` waits for: its branch
 *  landed or its PR merged. Ready, PR opened and a picked winner do not count. */
export const cardLanded = (t: Pick<CoordTask, "state" | "outcome">): boolean => t.state === "done" && t.outcome === "landed";

/** Whether a settled card may reopen: a later run on its branch takes it
 *  (the hub's `adopt`), so it needs a branch, one not dropped. A group card
 *  has no branch of its own to match. */
const mayReopen = (c: CoordTask): boolean => c.branch !== undefined && c.outcome !== "dropped";

/** A group card that settled "needs you": its group waits on Eric, who may
 *  still pick a winner and land it, so the hub reads the card again. */
export const groupNeedsEric = (c: Pick<CoordTask, "group" | "state" | "outcome">): boolean => c.group !== undefined && c.state === "failed" && c.outcome === "needs you";

/** What a card waits for, in words, or null when it waits for nothing (no
 *  `after`, or every card named has landed). `blocked` says a card it waits
 *  for will not land by itself: it failed, ended done without landing (no
 *  change), was dropped or was removed. A group card that needs Eric is not
 *  blocked, since he may still pick its winner and land it. `reopens` names
 *  that card when a new run on its branch may still reopen it. */
export function afterWait(task: CoordTask, cards: readonly CoordTask[]): { words: string; blocked: boolean; reopens?: string } | null {
  const open = (task.after ?? []).filter((id) => {
    const c = cards.find((x) => x.id === id);
    return !c || !cardLanded(c);
  });
  if (open.length === 0) return null;
  for (const id of open) {
    const c = cards.find((x) => x.id === id);
    if (!c) return { words: `waits for ${id}, which was removed`, blocked: true };
    const reopens = mayReopen(c) ? { reopens: id } : {};
    // Eric picks a winner, or lands one, and the card is read again
    if (c.state === "failed" && groupNeedsEric(c)) return { words: `waits for ${id}, whose group needs Eric`, blocked: false };
    if (c.state === "failed") return { words: `waits for ${id}, which failed`, blocked: true, ...reopens };
    if (c.state === "dropped") return { words: `waits for ${id}, which was dropped`, blocked: true };
    if (c.state === "done" && !(MAY_LAND_LATER as readonly string[]).includes(c.outcome ?? "")) {
      return { words: `waits for ${id}, which ended with ${c.outcome ?? "no change"}`, blocked: true, ...reopens };
    }
  }
  return { words: `waits for ${andList(open)}`, blocked: false };
}

/** The queued cards to start now, in order, without passing 3 working. A
 *  card with `times` counts as that many children and needs that many branch
 *  slots. A card that does not fit, whether its repo is short of slots or the
 *  3 are short of room, waits for this pass, and a later card may go ahead of
 *  it. A card that waits for another card to land (`afterWait`) is passed
 *  over, and a held coordinator starts none. `first` names cards to try
 *  before the rest, in that order (a start with ids). `repoFull` is read once
 *  per card, so two cards in a repo with one slot left both come back: the
 *  caller starts them one at a time and leaves a card queued when its start
 *  finds the repo full after all. */
export function nextToStart(
  tasks: readonly CoordTask[],
  ctx: { working: number; repoFull: (repo: string, need?: number) => boolean; cards: readonly CoordTask[]; held?: boolean; first?: readonly string[] },
): CoordTask[] {
  if (ctx.held) return [];
  const first = ctx.first ?? [];
  const ordered = [...tasks].sort((a, b) => {
    const x = first.indexOf(a.id);
    const y = first.indexOf(b.id);
    return (x < 0 ? first.length : x) - (y < 0 ? first.length : y);
  });
  const out: CoordTask[] = [];
  let going = ctx.working;
  for (const t of ordered) {
    if (going >= COORD_AT_ONCE) break;
    const need = t.times ?? 1;
    if (t.state !== "queued" || afterWait(t, ctx.cards) || going + need > COORD_AT_ONCE || ctx.repoFull(t.repo, need)) continue;
    out.push(t);
    going += need;
  }
  return out;
}

/** What the landing queue and the PR watch know of a child's branch, read
 *  by the hub when the child settles. */
export interface ChildLanding {
  /** the branch's queue entry, once it has one */
  entry?: LandEntry;
  /** every entry, for the entry's place in its queue ("queued 2nd") */
  entries?: readonly LandEntry[];
  /** the PR the branch opened, by its address */
  prUrl?: string;
  /** the PR was merged, which lands the card as the queue would */
  prMerged?: true;
}

/** How a child settled, in the words a card and its note use. */
export type ChildOutcomeWord = "landed" | "ready" | "PR opened" | "PR closed" | "sent back" | "failed" | "stopped" | "uncommitted" | "plan turned down" | "no change" | "waiting for capacity" | "winner picked" | "needs you" | "dropped";

/** A settled child as its card's state and outcome word. Null while the
 *  child is going, or ended with its branch still being read (its first
 *  change after the end still says `working`; the next one has the state).
 *  The queue's word beats the branch's once the branch has an entry: landed
 *  is done, sent back failed, and a ready branch with a PR open is done. A
 *  branch with nothing on it is done, since an ask may only answer, unless
 *  Eric turned its plan down; one left uncommitted failed. A limited run
 *  settles as waiting for capacity before its branch can read as success. */
export function childOutcome(run: Run, landing: ChildLanding = {}): { state: "done" | "failed"; outcome: ChildOutcomeWord } | null {
  if (isRunActive(run)) return null;
  if (run.status === "failed") return { state: "failed", outcome: "failed" };
  if (run.status === "stopped") return { state: "failed", outcome: "stopped" };
  if (run.status === "limited") return { state: "failed", outcome: "waiting for capacity" };
  return branchOutcome(run.branch?.state ?? "nothing", landing, run.proposalState === "turned down");
}

/** How a branch whose work has ended settles its card, shared by a run and a
 *  flow. Null while the branch still works. */
function branchOutcome(b: RunBranchState, landing: ChildLanding, turnedDown: boolean): { state: "done" | "failed"; outcome: ChildOutcomeWord } | null {
  if (b === "working") return null;
  const e = landing.entry;
  if (e?.state === "landed" || landing.prMerged) return { state: "done", outcome: "landed" };
  if (e && sentBack(e)) return { state: "failed", outcome: "sent back" };
  if (b === "ready" && landing.prUrl) return { state: "done", outcome: "PR opened" };
  if (b === "ready") return { state: "done", outcome: "ready" };
  if (b === "uncommitted") return { state: "failed", outcome: "uncommitted" };
  if (b === "stopped") return { state: "failed", outcome: "stopped" };
  if (turnedDown) return { state: "failed", outcome: "plan turned down" };
  return { state: "done", outcome: "no change" };
}

/** What the hub reads of a child's branch: the queue's entry and the PR as
 *  `ChildLanding` has them, the sort's verdict once the landing queue has
 *  sorted the branch, and whether the branch opens a PR in place of the
 *  queue. */
export interface ChildBranch extends ChildLanding {
  verdict?: ReviewVerdict;
  openPr?: boolean;
  /** the landing queue keeps no record of the branch: dropped with its
   *  worktree, or gone once it landed or its PR merged (which the entry or
   *  `prMerged` says) */
  gone?: true;
  /** the PR the branch opened closed without merging */
  prClosed?: true;
  /** the landing record's branch state and its last run's end, while the
   *  queue keeps the record */
  branchState?: RunBranchState;
  branchEnded?: number;
  /** the card's work item closed landed (FR-037). The item outlives the
   *  queue's landed entry, which goes past `KEEP_LANDED`, so a branch with no
   *  record that landed is not read as dropped. */
  workLanded?: true;
}

/** Whether a child has settled for its card and its note, and how. A child
 *  that failed, stopped, or left its branch uncommitted or empty settles
 *  the moment its branch is read. A ready branch is handed to the landing
 *  queue, so its card waits for the queue's last word: landed, sent back,
 *  or a PR open. It also settles as `ready` once the sort leaves it to
 *  Eric (a `land` or `approve` verdict, so nothing lands it on its own),
 *  or once `overdue` (the sort failed or the PR never opened). An `auto`
 *  verdict with no entry yet waits, since the queue takes it next, and an
 *  entry still in the queue waits however long it takes. Null while it
 *  should wait. */
export function childSettled(run: Run, b: ChildBranch, overdue: boolean): { state: "done" | "failed"; outcome: ChildOutcomeWord } | null {
  return readySettled(childOutcome(run, b), b, overdue);
}

/** The wait a ready branch adds to its outcome (see `childSettled`). */
function readySettled(out: { state: "done" | "failed"; outcome: ChildOutcomeWord } | null, b: ChildBranch, overdue: boolean): { state: "done" | "failed"; outcome: ChildOutcomeWord } | null {
  if (!out || out.outcome !== "ready") return out;
  if (b.entry && inQueue(b.entry)) return null;
  if (overdue) return out;
  if (b.openPr || b.verdict === undefined || b.verdict === "auto") return null;
  return out;
}

/** outcomes that may turn `landed` after the card settled, when Eric lands
 *  the branch or merges its PR later */
export const MAY_LAND_LATER: readonly ChildOutcomeWord[] = ["ready", "PR opened", "winner picked"];

/** What became of the branch of a card that settled ready or with a PR
 *  open, read again on the landing and PR broadcasts: landed (its entry
 *  landed or its PR merged, read first), dropped (the queue keeps no record
 *  of it and it has no PR, so Eric dropped it with its worktree), PR closed
 *  (closed unmerged, and the queue does not hold it), or null while it may
 *  still land. A branch with a PR is the PR watch's to say: a merge forgets
 *  the record before the watch reads merged. */
export function laterOutcome(b: ChildBranch): { state: "done" | "failed"; outcome: ChildOutcomeWord } | null {
  if (b.entry?.state === "landed" || b.prMerged || b.workLanded) return { state: "done", outcome: "landed" };
  if (b.gone && !b.prUrl) return { state: "failed", outcome: "dropped" };
  if (b.prClosed && !(b.entry && inQueue(b.entry))) return { state: "failed", outcome: "PR closed" };
  return null;
}

/** How a flow card settles once its flow's record is gone (the flows keep
 *  only the newest finished ones) while it waited on the landing queue,
 *  read off its branch alone: landed, sent back and a PR open settle it,
 *  and an entry still in the queue `waits`. A branch the queue still keeps a
 *  record of, with no entry and no PR, settles off the record's state as a
 *  child's does (`childSettled`, `overdue` counted from the record's last
 *  run), so a ready branch left to Eric settles ready. Anything else is
 *  null, which says nothing is known. */
export function flowGoneSettled(b: ChildBranch, overdue = true): { state: "done" | "failed"; outcome: ChildOutcomeWord } | "waits" | null {
  if (b.entry?.state === "landed" || b.prMerged || b.workLanded) return { state: "done", outcome: "landed" };
  if (b.entry && inQueue(b.entry)) return "waits";
  if (b.entry && sentBack(b.entry)) return { state: "failed", outcome: "sent back" };
  if (b.prUrl && !b.prClosed) return { state: "done", outcome: "PR opened" };
  if (b.gone || b.entry || b.prUrl || !b.branchState) return null;
  return readySettled(branchOutcome(b.branchState, b, false), b, overdue) ?? "waits";
}

/** How a flow ended, as its card's outcome. Null while the flow works, waits
 *  or sits at a gate. A done flow's branch settles as a run's does. */
function flowOutcome(flow: Pick<Flow, "status" | "branch">, landing: ChildLanding): { state: "done" | "failed"; outcome: ChildOutcomeWord } | null {
  switch (flow.status) {
    case "failed": return { state: "failed", outcome: "failed" };
    case "stopped": return { state: "failed", outcome: "stopped" };
    case "done": return branchOutcome(flow.branch?.state ?? "nothing", landing, false);
    default: return null;
  }
}

/** Whether a card's flow has settled it, by the same rules as `childSettled`
 *  for the flow's branch. */
export function flowSettled(flow: Pick<Flow, "status" | "branch">, b: ChildBranch, overdue: boolean): { state: "done" | "failed"; outcome: ChildOutcomeWord } | null {
  return readySettled(flowOutcome(flow, b), b, overdue);
}

/** Whether a group card has settled, on the group's word. Null while the
 *  group works, scores or reviews. A picked winner waiting for Eric counts as
 *  done, as a ready child left to Eric does, and a group that needs him
 *  counts as failed, as a sent-back child does. */
export function groupSettled(group: Pick<RunGroup, "state">): { state: "done" | "failed"; outcome: ChildOutcomeWord } | null {
  switch (group.state) {
    case "landed": return { state: "done", outcome: "landed" };
    case "picked": return { state: "done", outcome: "winner picked" };
    case "needs-you": return { state: "failed", outcome: "needs you" };
    case "dropped": return { state: "failed", outcome: "dropped" };
    default: return null;
  }
}

/** The note a card that could not start sends into the chat. */
export function startNote(task: CoordTask, error: string): string {
  return [
    "canopy: a task you started could not start",
    `task ${task.id}: ${task.title} (repo ${task.repo})`,
    "outcome: failed",
    `result: ${oneLine(error) || "(none)"}`,
  ].join("\n");
}

/** a branch's own state in words, as the run sheet says it */
const BRANCH_WORD: Record<RunBranchState, string> = {
  working: "working",
  ready: "ready to land",
  uncommitted: "changes left uncommitted",
  nothing: "no commits",
  stopped: "stopped by a restart",
};

/** what a cut result puts between the head and the tail it keeps */
const RESULT_GAP = " … ";

/** A result on one line. A longer one keeps its head and its tail within
 *  `RESULT_CHARS`, cut at words with `RESULT_GAP` between: a worker's
 *  report opens with what it did and closes with what it checked, and a
 *  cut that kept the head alone lost the tests it ran ("bun te…"). */
function oneLine(s: string): string {
  const flat = s.replace(/\s+/g, " ").trim();
  if (flat.length <= RESULT_CHARS) return flat;
  const room = RESULT_CHARS - RESULT_GAP.length;
  const headMax = Math.ceil(room * 0.6);
  const tailMax = room - headMax;
  // a word cut short at either end goes, unless that loses a fifth of the room
  const end = flat.lastIndexOf(" ", headMax);
  const head = end > headMax * 0.8 ? flat.slice(0, end) : flat.slice(0, headMax);
  const from = flat.length - tailMax;
  const space = flat.indexOf(" ", from - 1);
  const tail = space >= 0 && space < from + tailMax * 0.2 ? flat.slice(space + 1) : flat.slice(from);
  return `${head}${RESULT_GAP}${tail}`;
}

/** The user message a settled group card sends into its coordinator's chat:
 *  the card, how it went, why, and the winner's branch once there is one. */
export function groupNote(task: CoordTask, group: RunGroup, outcome: ChildOutcomeWord): string {
  const winner = group.winner ? group.scores?.[group.winner]?.branch : undefined;
  const why = winner && group.review && "why" in group.review ? group.review.why[winner] : undefined;
  const result = group.reason ?? why ?? "";
  const lines = [
    "canopy: a task you started has settled",
    `task ${task.id}: ${task.title} (repo ${task.repo})`,
    `outcome: ${outcome}`,
    `result: best of ${group.expectedMembers}${result ? `, ${oneLine(result)}` : ""}`,
  ];
  if (winner) lines.push(`branch: ${winner}, ${outcome === "landed" ? "landed" : "the winner, waiting for Eric to land it"}`);
  return lines.join("\n");
}

/** The user message a settled child sends into its coordinator's chat: the
 *  card, how it went, the child's result line (its error when it has none),
 *  and where its work is: the PR's address, or the branch and its landing
 *  state. `outcome` stands in for the child's own word where the card's
 *  differs: a second limit fails the card, while the run reads limited. */
export function settleNote(task: CoordTask, run: Run, landing: ChildLanding = {}, outcome?: ChildOutcomeWord): string {
  const how = outcome ? { outcome } : childOutcome(run, landing);
  const result = run.status === "limited"
    ? run.limited?.text?.trim() || run.error?.trim() || run.result?.text?.trim() || ""
    : run.result?.text?.trim() || run.error?.trim() || "";
  const lines = [
    "canopy: a task you started has settled",
    `task ${task.id}: ${task.title} (repo ${task.repo})`,
    `outcome: ${how?.outcome ?? run.status}`,
    `result: ${result ? oneLine(result) : "(none)"}`,
  ];
  if (landing.prUrl) lines.push(`PR: ${landing.prUrl}`);
  else if (run.branch) {
    const e = landing.entry;
    lines.push(`branch: ${run.branch.name}, ${e ? landWord(e, landing.entries ?? [e]) : BRANCH_WORD[run.branch.state]}`);
  }
  return lines.join("\n");
}

/** The user message a settled card's flow sends into its coordinator's chat,
 *  in `settleNote`'s lines: the result is the workflow and its status, and the
 *  last reason or summary a step left, with that step's name. */
export function flowNote(task: CoordTask, flow: Flow, landing: ChildLanding = {}): string {
  const how = flowOutcome(flow, landing);
  const step = [...flow.steps].reverse().find((s) => s.reason?.trim() || s.summary?.trim());
  const line = step ? oneLine(step.reason?.trim() || step.summary?.trim() || "") : "";
  const lines = [
    "canopy: a task you started has settled",
    `task ${task.id}: ${task.title} (repo ${task.repo})`,
    `outcome: ${how?.outcome ?? flow.status}`,
    `result: ${flow.workflow} ${flow.status}${step && line ? `, ${step.name}: ${line}` : ""}`,
  ];
  if (landing.prUrl) lines.push(`PR: ${landing.prUrl}`);
  else if (flow.branch) {
    const e = landing.entry;
    lines.push(`branch: ${flow.branch.name}, ${e ? landWord(e, landing.entries ?? [e]) : BRANCH_WORD[flow.branch.state]}`);
  }
  return lines.join("\n");
}

/** The note a flow card whose flow is no longer kept sends once its branch
 *  settles it (`flowGoneSettled`), in `flowNote`'s lines. */
export function flowGoneNote(task: CoordTask, outcome: ChildOutcomeWord, landing: ChildLanding = {}): string {
  const lines = [
    "canopy: a task you started has settled",
    `task ${task.id}: ${task.title} (repo ${task.repo})`,
    `outcome: ${outcome}`,
    `result: ${task.workflow ?? "its workflow"} ended; its flow is no longer kept`,
  ];
  const e = landing.entry;
  if (landing.prUrl) lines.push(`PR: ${landing.prUrl}`);
  else if (e) lines.push(`branch: ${e.branch}, ${landWord(e, landing.entries ?? [e])}`);
  return lines.join("\n");
}

/** The note a landed card sends: the cards that wait for it can start. */
export const landedNote = (task: CoordTask): string => `canopy: task ${task.id} (${task.title}) landed; cards that wait for it can start`;

/** The note a card that settled ready, PR opened or winner picked sends when
 *  its work will not land as it stood (`laterOutcome`, or its group's word). */
export const lateFailNote = (task: CoordTask, outcome: ChildOutcomeWord): string =>
  `canopy: task ${task.id} (${task.title}) settled ${task.outcome ?? "done"}, then failed: ${outcome}`;

/** The note for a queued card whose `after` can never be met by itself.
 *  `reopens` names the card it waits for when a new run on that card's
 *  branch may still reopen it (`afterWait`). */
export const blockedNote = (task: CoordTask, words: string, reopens?: string): string =>
  `canopy: task ${task.id} (${task.title}) ${words}; it stays queued until Eric takes its after off or removes it${reopens ? `, or a new run on ${reopens}'s branch reopens ${reopens}` : ""}`;

/** what a note's last line starts with: every card's state as it is said */
export const CARDS_NOW = "cards now: ";

const OUTCOME_WORDS: Record<ChildOutcomeWord, true> = {
  landed: true,
  ready: true,
  "PR opened": true,
  "PR closed": true,
  "sent back": true,
  failed: true,
  stopped: true,
  uncommitted: true,
  "plan turned down": true,
  "no change": true,
  "waiting for capacity": true,
  "winner picked": true,
  "needs you": true,
  dropped: true,
};
const OUTCOME_WORD_SET: ReadonlySet<string> = new Set(Object.keys(OUTCOME_WORDS));

/** A card's state in a word for `cardsLine`: a settled card's outcome when
 *  it is one of `childOutcome`'s words, else its state. */
function cardWord(t: CoordTask): string {
  if (t.state !== "done" && t.state !== "failed") return t.state;
  return t.outcome !== undefined && OUTCOME_WORD_SET.has(t.outcome) ? t.outcome : t.state;
}

/** Every card's state on one line, "cards now: t1 proposed, t2 ready", or
 *  "" with no cards. Each note ends with it, so the coordinator reads which
 *  cards started: Eric may start one card at a time from his page, and a
 *  card it heard nothing of may still be proposed. */
export function cardsLine(tasks: readonly CoordTask[]): string {
  return tasks.length > 0 ? `${CARDS_NOW}${tasks.map((t) => `${t.id} ${cardWord(t)}`).join(", ")}` : "";
}

/** A note with `cardsLine` under it, as the coordinator hears it. */
export function withCards(note: string, tasks: readonly CoordTask[]): string {
  const line = cardsLine(tasks);
  return line ? `${note}\n${line}` : note;
}

/** The note a hold or a resume sends. */
export const holdNote = (held: boolean): string =>
  held ? "canopy: Eric held the goal; no new card starts until he resumes it" : "canopy: Eric resumed the goal; queued cards start again";

/** A workflow as the coordinator reads it: what a card may name and what it
 *  will run, with no file path and no step prompt. */
export interface CoordWorkflow {
  name: string;
  label: string;
  blurb: string;
  source: "bundled" | "user";
  steps: { name: string; gate: GateKind; mode: StepMode }[];
}

/** The workflows a coordinator may name: parsed, listed, bundled and user
 *  entries. A repo's own workflow is Eric's to set from the page. */
export function coordWorkflows(entries: readonly WorkflowEntry[]): CoordWorkflow[] {
  const out: CoordWorkflow[] = [];
  for (const e of entries) {
    if (!e.ok) continue;
    const w = e.workflow;
    if (w.listed === false || (w.source !== "bundled" && w.source !== "user")) continue;
    out.push({ name: w.name, label: w.label, blurb: w.blurb, source: w.source, steps: w.steps.map((st) => ({ name: st.name, gate: st.gate, mode: st.mode })) });
  }
  return out;
}

/** The line that tells a coordinator which repo its goal started at, so it
 *  plans there instead of asking. */
export function goalRepoLine(repoId: string): string {
  return `Eric started this goal at the repo ${repoId}. Plan its cards there unless the goal names other repos; do not ask which repo.`;
}

/** Whether a repo id is the goal anchor, bare or qualified `<backend>|~goal`. */
export const isGoalAnchor = (repoId: string): boolean => repoId === GOAL_ANCHOR || repoId.endsWith(`|${GOAL_ANCHOR}`);

/** The stand-in repo a top goal's coordinator is held at: `root` is the folder
 *  its chat runs in, and every other field is empty. */
export function goalAnchor(root: string): Repo {
  return { id: GOAL_ANCHOR, name: "goal", path: root, group: "", source: "", status: null };
}

/** The last line of a top goal's brief: where Eric started it, which repos he
 *  named and where his files are. */
export function goalTopLine(repos: readonly string[], filesDir: string | null, files: readonly string[]): string {
  const parts = ["Eric started this goal from canopy's top, at no repo."];
  if (repos.length > 0) parts.push(`He named these repos: ${repos.join(", ")}. Plan there first.`);
  if (filesDir !== null && files.length > 0) {
    parts.push(`His files are in ${filesDir}: ${files.join(", ")}. Read each before you plan, and list the ones a card's worker needs in its "files".`);
  }
  parts.push("When the goal leaves the repo open, ask which.");
  return parts.join(" ");
}

/** Plain, unique names for the files a goal brings: each label cut to its last
 *  path part, an empty or dot name made `file`, a repeat `name (2).ext`. Same
 *  length and order as the input. */
export function goalFileNames(labels: readonly string[]): string[] {
  const seen = new Set<string>();
  return labels.map((label) => {
    const last = label.split(/[/\\]/).pop() ?? "";
    const base = last === "" || last === "." || last === ".." ? "file" : last;
    const dot = base.lastIndexOf(".");
    const stem = dot > 0 ? base.slice(0, dot) : base;
    const ext = dot > 0 ? base.slice(dot) : "";
    let name = base;
    for (let n = 2; seen.has(name); n++) name = `${stem} (${n})${ext}`;
    seen.add(name);
    return name;
  });
}

/** The line that tells a card's worker where Eric's files for it are. */
export function cardFilesLine(dir: string, files: readonly string[]): string {
  return `Files from Eric for this task: ${files.map((f) => `${dir}/${f}`).join(", ")}`;
}

/** The brief with Eric's standing rules from ~/.claude/manager.md under
 *  their own heading; the brief alone when there are none. */
export function withStandingRules(brief: string, rules: string | null): string {
  const text = rules?.trim();
  return text ? `${brief}\n\n## Eric's standing rules\n\n${text}` : brief;
}

/** Eric's overrides of a card's loadout, in words: "model sonnet". */
function overrides(e: CardEquip): string[] {
  const list = (l: readonly string[]): string => (l.length > 0 ? l.join(", ") : "none");
  return [
    e.model !== undefined ? `model ${e.model}` : "",
    e.effort !== undefined ? `effort ${e.effort}` : "",
    e.skills !== undefined ? `skills ${list(e.skills)}` : "",
    e.mcp !== undefined ? `servers ${list(e.mcp)}` : "",
  ].filter(Boolean);
}

/** The words a card's facts line adds: its loadout (with "changed" when
 *  Eric overrode a field, the overrides in its title), its workflow, and
 *  "after t1, t3" for the cards it waits for. */
export function cardCarries(task: CoordTask): { loadout?: { word: string; title: string }; workflow?: string; after?: string } {
  const out: { loadout?: { word: string; title: string }; workflow?: string; after?: string } = {};
  const e = task.equip;
  if (e?.loadout) {
    const set = overrides(e);
    out.loadout = { word: set.length > 0 ? `${e.loadout}, changed` : e.loadout, title: [`loadout ${e.loadout}`, ...set].join("; ") };
  }
  if (task.workflow) out.workflow = task.workflow;
  if (task.after && task.after.length > 0) out.after = `after ${task.after.join(", ")}`;
  return out;
}

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
