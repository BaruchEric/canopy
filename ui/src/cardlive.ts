/** A repo card's live row: one mark for each thing running on the repo right
 *  now (its agents, its tasks, its shells), the groups they are drawn in, the
 *  row's headline, what the branch line and the card's leaf edge do about
 *  it, and the trace of the last thing that left the row. Pure; tested in
 *  cardlive.test.ts. The row is `CardLive.tsx`. */

import { isLiveAgent, type AgentCard, type TaskInfo, type TaskStatus, type TermInfo } from "../../src/core/types";
import { cardName, durationWord, runEnd, stateSince, stateWord, whereWord, type TrailMark } from "./agentcards";
import { AGENT_GLYPH } from "./agentpanel";
import { WAITING_GLYPH } from "./waiting";

/** what every mark carries, whatever it stands for */
interface MarkBase {
  /** the kind and the thing's own id, so no two on a card share one */
  id: string;
  /** who or what it is, for its tooltip; the row adds how long */
  title: string;
  /** since when it has been as it is, unix ms; null when the page cannot say */
  since: number | null;
  /** the checkout a click on it opens */
  repoId: string;
}

/** an agent: at work, waiting on you, or open between turns */
export interface AgentMark extends MarkBase {
  kind: "agent";
  state: "working" | "waiting" | "idle";
}

/** a task: up, being restarted after a failure, or failed */
export interface TaskMark extends MarkBase {
  kind: "task";
  state: "running" | "restarting" | "failed";
  name: string;
  /** the port it serves, null when it holds none */
  port: number | null;
}

/** a shell: on someone's screen, or only held by the backend */
export interface ShellMark extends MarkBase {
  kind: "shell";
  state: "watched" | "held";
  /** the shell's id, to bring it up */
  term: string;
}

/** One live thing on a card. Its kind and state set its glyph, its colour
 *  and how it moves. */
export type LiveMark = AgentMark | TaskMark | ShellMark;
export type LiveKind = LiveMark["kind"];
export type LiveState = LiveMark["state"];

export interface LiveInput {
  /** the checkout the card leads with: where its agents open */
  lead: string;
  /** every agent on the card, on any machine; the stopped ones are passed over */
  agents: readonly AgentCard[];
  /** what the page saw of each agent's states, by card id */
  trail: Readonly<Record<string, readonly TrailMark[] | undefined>>;
  /** the tasks on the card's checkouts */
  tasks: readonly TaskInfo[];
  /** the sessions on the card's checkouts, tasks' and the ranger's included */
  shells: readonly TermInfo[];
  /** a qualified id's backend and its plain id */
  split: (id: string) => [string, string];
}

const AGENT_ORDER: readonly AgentMark["state"][] = ["waiting", "working", "idle"];
const TASK_ORDER: readonly TaskMark["state"][] = ["failed", "restarting", "running"];

/** the task states the row shows, each with its word; one that is idle,
 *  stopped or finished is not running and has no mark */
const TASK_SHOWN: Partial<Record<TaskStatus, { state: TaskMark["state"]; word: string }>> = {
  failed: { state: "failed", word: "failed" },
  "gave-up": { state: "failed", word: "gave up" },
  backoff: { state: "restarting", word: "restarting" },
  running: { state: "running", word: "running" },
};

const agentState = (c: AgentCard): AgentMark["state"] => (c.state === "waiting" ? "waiting" : c.state === "working" ? "working" : "idle");

/** " on mini" for a checkout on another backend than the card's lead, nothing for one at home */
function elsewhere(lead: string, split: LiveInput["split"]): (id: string) => string {
  const home = split(lead)[0];
  return (id) => {
    const b = split(id)[0];
    return b === home ? "" : ` on ${b}`;
  };
}

/**
 * The card's marks, the most pressing first in each kind: agents (waiting,
 * working, idle), tasks (failed, restarting, running), shells (on a screen,
 * then held). A shell a live agent says it runs in is that agent's mark and
 * no shell's; a task's session and the ranger's are never shells.
 */
export function liveMarks({ lead, agents, trail, tasks, shells, split }: LiveInput): LiveMark[] {
  const away = elsewhere(lead, split);
  const out: LiveMark[] = [];

  const live = agents.filter(isLiveAgent);
  const ranked = [...live].sort(
    (a, b) => AGENT_ORDER.indexOf(agentState(a)) - AGENT_ORDER.indexOf(agentState(b)) || b.startedAt - a.startedAt || a.id.localeCompare(b.id),
  );
  for (const c of ranked) {
    out.push({
      id: `agent:${c.id}`,
      kind: "agent",
      state: agentState(c),
      title: `${cardName(c)}: ${stateWord(c)}, ${whereWord(c)}`,
      since: stateSince(c, trail[c.id]),
      repoId: lead,
    });
  }

  const shown = tasks.flatMap((t) => {
    const as = TASK_SHOWN[t.status];
    return as ? [{ t, ...as }] : [];
  });
  shown.sort((a, b) => TASK_ORDER.indexOf(a.state) - TASK_ORDER.indexOf(b.state) || a.t.name.localeCompare(b.t.name) || a.t.repoId.localeCompare(b.t.repoId));
  for (const { t, state, word } of shown) {
    out.push({
      id: `task:${t.repoId}:${t.name}`,
      kind: "task",
      state,
      name: t.name,
      port: t.port ?? null,
      title: `${t.name} ${word}${away(t.repoId)}`,
      since: (state === "running" ? t.startedAt : state === "failed" ? t.exitedAt : undefined) ?? null,
      repoId: t.repoId,
    });
  }

  const agentShells = new Set<string>();
  for (const c of live) {
    const cw = c.where.canopy;
    if (cw?.term) agentShells.add(`${cw.backend}\n${cw.term}`);
  }
  const plain = shells.filter((t) => t.task === undefined && !t.ranger && !agentShells.has(split(t.id).join("\n")));
  const watched = (t: TermInfo): boolean => t.attached || t.viewers.length > 0;
  plain.sort((a, b) => Number(watched(b)) - Number(watched(a)) || b.startedAt - a.startedAt || a.id.localeCompare(b.id));
  for (const t of plain) {
    const on = watched(t);
    out.push({
      id: `shell:${t.id}`,
      kind: "shell",
      state: on ? "watched" : "held",
      title: `${t.label ?? "shell"}${away(t.repoId)}: ${on ? `open on ${t.viewers.length ? t.viewers.join(", ") : "a screen"}` : "running, on no screen"}`,
      since: t.startedAt,
      repoId: t.repoId,
      term: t.id,
    });
  }
  return out;
}

/** a mark's glyph: the registry's ✦ and the waiting panel's ⚑ for an agent,
 *  the task chip's ▶ and ✕, a terminal's cursor for a shell */
export function liveGlyph(m: LiveMark): string {
  switch (m.kind) {
    case "agent":
      return m.state === "waiting" ? WAITING_GLYPH : AGENT_GLYPH;
    case "task":
      return m.state === "failed" ? "✕" : m.state === "restarting" ? "↻" : "▶";
    case "shell":
      return "▍";
    default: {
      const _exhaustive: never = m;
      return _exhaustive;
    }
  }
}

/** how many marks of a kind a row draws before the rest is a count */
export const LIVE_CAP: Record<LiveKind, number> = { agent: 5, task: 2, shell: 3 };

/** a mark as the row draws it: still running, or kept a moment past its end */
export interface ShownMark {
  mark: LiveMark;
  gone: boolean;
}

export interface LiveGroup {
  kind: LiveKind;
  /** the marks drawn: up to the cap, then the ones that just ended */
  marks: ShownMark[];
  /** how many more are running than are drawn */
  more: number;
  /** the group in words, for a screen reader */
  words: string;
  /** the mark a click on the group acts on; null when all of them just ended */
  first: LiveMark | null;
}

const count = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;

/** the marks of each kind, in the order they came */
function byKind(marks: readonly LiveMark[]): { agents: AgentMark[]; tasks: TaskMark[]; shells: ShellMark[] } {
  const agents: AgentMark[] = [];
  const tasks: TaskMark[] = [];
  const shells: ShellMark[] = [];
  for (const m of marks) {
    if (m.kind === "agent") agents.push(m);
    else if (m.kind === "task") tasks.push(m);
    else shells.push(m);
  }
  return { agents, tasks, shells };
}

function agentWords(agents: readonly AgentMark[]): string {
  const by = AGENT_ORDER.flatMap((s) => {
    const n = agents.filter((m) => m.state === s).length;
    return n ? [`${n} ${s}`] : [];
  });
  return `${count(agents.length, "agent")}: ${by.join(", ")}`;
}

const taskWords = (tasks: readonly TaskMark[]): string => `${count(tasks.length, "task")}: ${tasks.map((m) => `${m.name} ${m.state}`).join(", ")}`;

function shellWords(shells: readonly ShellMark[]): string {
  const on = shells.filter((m) => m.state === "watched").length;
  return `${count(shells.length, "shell")}, ${on ? `${on} on a screen` : "on no screen"}`;
}

/** The marks by kind, agents then tasks then shells, each cut at its cap;
 *  `gone` are the marks that ended a moment ago, kept at the end of their
 *  kind so they can be seen to go. A kind with neither has no group. */
export function liveGroups(marks: readonly LiveMark[], gone: readonly LiveMark[]): LiveGroup[] {
  const { agents, tasks, shells } = byKind(marks);
  const left = gone.filter((g) => !marks.some((m) => m.id === g.id));
  const group = (kind: LiveKind, here: readonly LiveMark[], words: string, ended: string): LiveGroup[] => {
    const past = left.filter((m) => m.kind === kind);
    if (here.length === 0 && past.length === 0) return [];
    const drawn = here.slice(0, LIVE_CAP[kind]);
    return [
      {
        kind,
        marks: [...drawn.map((mark) => ({ mark, gone: false })), ...past.map((mark) => ({ mark, gone: true }))],
        more: here.length - drawn.length,
        words: here.length ? words : ended,
        first: here[0] ?? null,
      },
    ];
  };
  return [
    ...group("agent", agents, agentWords(agents), "an agent just ended"),
    ...group("task", tasks, taskWords(tasks), "a task just ended"),
    ...group("shell", shells, shellWords(shells), "a shell just closed"),
  ];
}

export type LiveTone = "ask" | "bad" | "work" | "hold" | "calm";

export interface LiveHead {
  text: string;
  tone: LiveTone;
}

/** "4m", "3h", "2d"; nothing under a minute, since the row reads the clock twice a minute */
function short(ms: number): string {
  const m = Math.floor(ms / 60_000);
  if (m < 1) return "";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h` : `${Math.floor(h / 24)}d`;
}

const lasting = (m: LiveMark, now: number): string => {
  const w = m.since === null ? "" : short(now - m.since);
  return w ? ` ${w}` : "";
};

/**
 * The row's one line of words, about the most pressing thing on it: an
 * agent that waits on you, a task that failed, an agent at work, a task
 * being restarted, a task that is up, an idle agent, an open shell. One of
 * a kind says how long; several are counted. A task is named only when the
 * row holds more than one, since a lone task's mark already names it.
 */
export function liveHead(marks: readonly LiveMark[], now: number): LiveHead | null {
  const { agents, tasks, shells } = byKind(marks);
  const say = <M extends LiveMark>(list: readonly M[], tone: LiveTone, one: (m: M) => string, many: (n: number) => string): LiveHead | null => {
    const [only] = list;
    if (!only) return null;
    return { tone, text: list.length === 1 ? one(only) : many(list.length) };
  };
  const agentsIn = (state: AgentMark["state"]): AgentMark[] => agents.filter((m) => m.state === state);
  const tasksIn = (state: TaskMark["state"]): TaskMark[] => tasks.filter((m) => m.state === state);
  const named = (m: TaskMark): string => (tasks.length > 1 ? `${m.name} ` : "");
  const ago = (m: TaskMark): string => {
    const w = lasting(m, now);
    return w ? `${w} ago` : "";
  };
  return (
    say(agentsIn("waiting"), "ask", (m) => `needs you${lasting(m, now)}`, (n) => `${n} need you`) ??
    say(tasksIn("failed"), "bad", (m) => `${named(m)}failed${ago(m)}`, (n) => `${n} tasks failed`) ??
    say(agentsIn("working"), "work", (m) => `working${lasting(m, now)}`, (n) => `${n} working`) ??
    say(tasksIn("restarting"), "hold", (m) => `${named(m)}restarting`, (n) => `${n} tasks restarting`) ??
    say(tasksIn("running"), "calm", (m) => `${named(m)}up${lasting(m, now)}`, (n) => `${n} tasks up`) ??
    say(agentsIn("idle"), "calm", (m) => `idle${lasting(m, now)}`, (n) => `${n} idle`) ??
    say(shells, "calm", (m) => `shell open${lasting(m, now)}`, (n) => `${n} shells open`)
  );
}

/** whether sap runs along the row's branch line: only while an agent works */
export const liveFlow = (marks: readonly LiveMark[]): boolean => marks.some((m) => m.kind === "agent" && m.state === "working");

/** What the card's leaf edge does about its agents: asks while one waits on
 *  you, carries sap while one works, nothing otherwise. */
export function liveEdge(agents: readonly Pick<AgentCard, "state">[]): "waiting" | "working" | null {
  let working = false;
  for (const c of agents) {
    if (c.state === "waiting") return "waiting";
    if (c.state === "working") working = true;
  }
  return working ? "working" : null;
}

/** how long the row remembers the last thing that left it, in ms */
export const TRACE_MS = 30 * 60_000;

/** The last thing to leave the row: an agent that ended or that the broker
 *  lost, a task that ran to its end or was stopped. */
export interface LiveTrace {
  /** the thing and when it ended, so the next one is told from this one */
  id: string;
  kind: "agent" | "task";
  /** what happened, before how long ago: "test passed", "agent ended" */
  text: string;
  /** who or what it was, for its tooltip */
  title: string;
  /** when, unix ms */
  at: number;
  /** the checkout a click on it opens */
  repoId: string;
}

/** a task named for a check: one of these that exits clean passed */
const CHECK = /^(tests?|lint|typecheck|check|e2e|verify|ci)([:._-]|$)/;

/** how far apart two machines' clocks may put one start, in ms */
const CLOCKS = 60_000;

/**
 * Whether an ended scan card is an agent a hooked card took over, which is
 * no end. A backend's scan sees a new session before its hooks speak; once
 * the hooked card names the pid the broker drops the process from the
 * scan, and the scan's card ends about half a minute into a session that
 * runs on. Told by a card that is not a scan's, on the same machine, with
 * the same pid, that started inside the scan card's life.
 */
function takenOver(c: AgentCard, cards: readonly AgentCard[], end: number): boolean {
  if (c.origin !== "scan" || c.where.pid === null) return false;
  return cards.some((o) => o.origin !== "scan" && o.node === c.node && o.where.pid === c.where.pid && o.startedAt >= c.startedAt - CLOCKS && o.startedAt <= end + CLOCKS);
}

/**
 * The last thing that left the row, however long ago: the newest of the
 * agents that ended or were lost and the tasks that finished or were
 * stopped. All of it is read off what the backends hold (a card's end, a
 * task's exit), so a reload and another device say the same. A failed task
 * is no trace, since its mark stays on the row, a shell that closed leaves
 * nothing to read, and a scan card a hooked card took over (`takenOver`)
 * is an agent that runs on.
 */
export function lastEnded({ lead, agents, tasks, split }: Pick<LiveInput, "lead" | "agents" | "tasks" | "split">): LiveTrace | null {
  const away = elsewhere(lead, split);
  const ended: LiveTrace[] = [];
  for (const c of agents) {
    if (isLiveAgent(c)) continue;
    const at = runEnd(c, c.seenAt);
    if (takenOver(c, agents, at)) continue;
    ended.push({
      id: `agent:${c.id}:${at}`,
      kind: "agent",
      text: c.state === "lost" ? "agent lost" : "agent ended",
      title: `${cardName(c)}, ${whereWord(c)}, ran ${durationWord(at - c.startedAt)}`,
      at,
      repoId: lead,
    });
  }
  for (const t of tasks) {
    if (t.exitedAt === undefined) continue;
    const word = t.status === "exited" ? (CHECK.test(t.name) ? "passed" : "finished") : t.status === "stopped" ? "stopped" : null;
    if (word === null) continue;
    const text = `${t.name} ${word}`;
    ended.push({ id: `task:${t.repoId}:${t.name}:${t.exitedAt}`, kind: "task", text, title: `${text}${away(t.repoId)}`, at: t.exitedAt, repoId: t.repoId });
  }
  return ended.reduce<LiveTrace | null>((last, t) => (last && last.at >= t.at ? last : t), null);
}

/** until when the row shows a trace, unix ms */
export const traceUntil = (t: LiveTrace): number => t.at + TRACE_MS;

/** "test passed 4m ago"; "just now" inside the first minute, and when the
 *  backend's clock runs a little ahead of the page's */
export function traceWords(t: LiveTrace, now: number): string {
  const w = short(now - t.at);
  return `${t.text} ${w ? `${w} ago` : "just now"}`;
}

/** A trace the row has no room for, as the row's tooltip: the words it
 *  would have shown, then what the trace's own tooltip adds to them. A
 *  task's says where it ran when that is another backend; an agent's names
 *  it, where it sat and how long it ran. */
export function traceTip(t: LiveTrace, now: number): string {
  const words = traceWords(t, now);
  return t.kind === "task" ? `${words}${t.title.slice(t.text.length)}` : `${words}: ${t.title}`;
}

/**
 * Whether a row has room for its trace, from the branch line's width with
 * the trace drawn and the width the line starts from (its flex basis). The
 * line is the first thing on a row to give room up, so one shorter than
 * its basis means the trace took room from what runs now, and the trace
 * goes instead: it shows whole or not at all.
 */
export const traceFits = (line: number, basis: number): boolean => line > basis - 1 / 64;

/** how long a mark stays on the row after its thing ended, in ms */
export const LINGER_MS = 900;

/** a mark kept past its end, and until when */
export interface Gone<T> {
  item: T;
  until: number;
}

/**
 * The marks to keep showing after `next` took `prev`'s place: the ones
 * already held whose time is not over and that did not come back, and the
 * ones that just left, held for `ms`. The same array when nothing moved.
 */
export function departed<T extends { id: string }>(prev: readonly T[], next: readonly T[], gone: readonly Gone<T>[], now: number, ms: number): readonly Gone<T>[] {
  const here = new Set(next.map((m) => m.id));
  const kept = gone.filter((g) => g.until > now && !here.has(g.item.id));
  const held = new Set(kept.map((g) => g.item.id));
  const left = prev.filter((m) => !here.has(m.id) && !held.has(m.id));
  if (left.length === 0 && kept.length === gone.length) return gone;
  return [...kept, ...left.map((item) => ({ item, until: now + ms }))];
}
