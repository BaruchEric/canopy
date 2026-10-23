/**
 * The sweep (docs/superpowers/specs/2026-10-22-sweep-design.md): the pure
 * part. Its settings as stored, and the planner that turns the shells, runs
 * and registry cards the server holds into the list of things idle long
 * enough to offer for closing. No I/O; the hub that closes them is
 * server/sweep.ts. Browser-safe.
 */

import { CRON_MAX, isCron, parseCron } from "./cron";
import { isShellCommand } from "./shellname";
import { SWEEP_KINDS } from "./types";
import type { AgentCard, AgentState, Run, SweepItem, SweepKind, SweepSettings } from "./types";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

export const DEFAULT_SWEEP: SweepSettings = {
  on: false,
  cron: "0 4 * * *",
  spans: { shell: 24 * HOUR, chat: 12 * HOUR, run: 3 * DAY, pr: 14 * DAY, outside: 24 * HOUR },
  auto: ["shell", "chat", "run"],
};

const isKind = (v: unknown): v is SweepKind => (SWEEP_KINDS as readonly unknown[]).includes(v);
const isSpan = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v > 0;
const kindsOf = (v: unknown[]): SweepKind[] => SWEEP_KINDS.filter((k) => v.includes(k));

function fresh(): SweepSettings {
  return { ...DEFAULT_SWEEP, spans: { ...DEFAULT_SWEEP.spans }, auto: [...DEFAULT_SWEEP.auto] };
}

/** The stored settings, field by field: anything that does not read falls
 *  back to its default rather than failing the config. */
export function normalizeSweep(raw: unknown): SweepSettings {
  const out = fresh();
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  const r = raw as Record<string, unknown>;
  out.on = r["on"] === true;
  if ("cron" in r) {
    // a stored cron that does not read leaves the schedule off, not firing at the default time
    if (isCron(r["cron"])) out.cron = r["cron"];
    else out.on = false;
  }
  const spans = r["spans"];
  if (spans && typeof spans === "object" && !Array.isArray(spans)) {
    for (const k of SWEEP_KINDS) {
      const v = (spans as Record<string, unknown>)[k];
      if (isSpan(v)) out.spans[k] = v;
    }
  }
  if (Array.isArray(r["auto"])) out.auto = kindsOf(r["auto"]);
  return out;
}

/**
 * A change to the settings as a request sends it, applied over `cur`. Only
 * the fields present change; a field that is present and does not read is
 * refused with the reason (the 400 message), rather than quietly kept.
 */
export function patchSweep(cur: SweepSettings, patch: unknown): SweepSettings | string {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) return "send the settings as an object";
  const b = patch as Record<string, unknown>;
  const out: SweepSettings = { ...cur, spans: { ...cur.spans }, auto: [...cur.auto] };
  if ("on" in b) {
    if (typeof b["on"] !== "boolean") return "on is true or false";
    out.on = b["on"];
  }
  if ("cron" in b) {
    const c = b["cron"];
    if (typeof c !== "string" || c.length > CRON_MAX) return `cron is a cron line of at most ${CRON_MAX} characters`;
    const got = parseCron(c);
    if ("error" in got) return got.error;
    out.cron = c;
  }
  if ("spans" in b) {
    const s = b["spans"];
    if (!s || typeof s !== "object" || Array.isArray(s)) return "spans is an object of milliseconds by kind";
    for (const [k, v] of Object.entries(s)) {
      if (!isKind(k)) return `${k} is not a kind of thing the sweep closes`;
      if (!isSpan(v)) return `the ${k} span is a positive number of milliseconds`;
      out.spans[k] = v;
    }
  }
  if ("auto" in b) {
    const a = b["auto"];
    if (!Array.isArray(a) || !a.every(isKind)) return `auto is a list of kinds: ${SWEEP_KINDS.join(", ")}`;
    out.auto = kindsOf(a);
  }
  return out;
}

/** What the planner needs to know about one canopy shell. */
export interface ShellFacts {
  id: string;
  repoId: string;
  /** a name given by hand */
  label?: string;
  task?: boolean;
  ranger?: boolean;
  /** in the middle of a move to another backend */
  moving?: boolean;
  startedAt: number;
  /** tmux's last output time; null when it did not say */
  lastOutput: number | null;
  /** the last keystroke from any device; in memory only */
  lastInput?: number;
  /** the pane's foreground command, when it was read: a shell's own name at
   *  its prompt, else the program running in it (a dev server, an editor,
   *  ssh, a REPL), which may sit quiet for days while still in use */
  command?: string;
  agent: { state: AgentState; session: string | null } | null;
}

export interface PlanInputs {
  /** when this server process started */
  serverStart: number;
  /** null when tmux did not answer */
  shells: ShellFacts[] | null;
  runs: Run[];
  /** runs the landing queue or a flow still holds */
  heldRuns: ReadonlySet<string>;
  outside: AgentCard[];
}

/** a span as the row says it: minutes under an hour, hours under two
 *  days, else days */
function ago(ms: number): string {
  const h = Math.floor(ms / HOUR);
  if (h < 1) return `${Math.max(1, Math.floor(ms / 60_000))}m`;
  return h < 48 ? `${h}h` : `${Math.floor(h / 24)}d`;
}

const ENDED = new Set<Run["status"]>(["done", "failed", "stopped"]);

/**
 * The things idle past their kind's span, sorted by kind and then oldest
 * first. Shells with a name, a task, the ranger, a move under way, or an
 * agent that is working or waiting are never offered; an agent idle at its
 * prompt goes with its shell. A shell running some other program in the
 * foreground is offered unticked and left out of the schedule's closes,
 * with the program named. Chats are listed always, and closable only
 * when they are Claude's with a session to resume. Agents canopy did not
 * start are listed, never closable.
 */
export function planSweep(inputs: PlanInputs, s: SweepSettings, now: number): SweepItem[] {
  const items: SweepItem[] = [];
  // `ask`: offered, but only by hand: never ticked, never closed unasked
  const add = (kind: SweepKind, id: string, repoId: string | null, where: string, title: string, idleSince: number, why: (idle: number) => string, closable: boolean, ask = false) => {
    const idle = now - idleSince;
    if (idle < s.spans[kind]) return;
    items.push({ key: `${kind}:${id}`, kind, id, repoId, where, title, idleSince, why: why(idle), closable, checked: closable && kind !== "pr" && !ask, auto: s.auto.includes(kind) && !ask });
  };

  for (const sh of inputs.shells ?? []) {
    if (sh.label || sh.task || sh.ranger || sh.moving) continue;
    if (sh.agent && sh.agent.state !== "idle") continue;
    const since = Math.max(inputs.serverStart, sh.lastOutput ?? sh.startedAt, sh.lastInput ?? 0);
    // a program in the foreground that is not an agent: quiet is not idle
    const running = !sh.agent && sh.command !== undefined && !isShellCommand(sh.command) ? sh.command.trim() : null;
    const title = sh.agent ? "shell with an idle agent" : "shell";
    add("shell", sh.id, sh.repoId, sh.repoId, title, since, (i) => `${running ? `running ${running}, ` : ""}no input or output for ${ago(i)}`, true, running !== null);
  }

  for (const r of inputs.runs) {
    if (r.chat && r.status === "idle") {
      const since = r.steps.at(-1)?.at ?? r.startedAt;
      add("chat", r.id, r.repoId, r.repoId, r.verb, since, (i) => `chat quiet for ${ago(i)}`, r.harness === "claude" && !!r.session);
    } else if (ENDED.has(r.status) && r.endedAt !== undefined && !inputs.heldRuns.has(r.id)) {
      add("run", r.id, r.repoId, r.repoId, r.verb, r.endedAt, (i) => `finished ${ago(i)} ago`, true);
    }
  }

  for (const c of inputs.outside) {
    if (c.where.canopy !== null || (c.state !== "idle" && c.state !== "lost")) continue;
    add("outside", c.id, null, `${c.node}:${c.cwd}`, `${c.harness} agent`, c.seenAt, (i) => `${c.state} for ${ago(i)}, not started by canopy`, false);
  }

  const order = (k: SweepKind) => SWEEP_KINDS.indexOf(k);
  return items.sort((a, b) => order(a.kind) - order(b.kind) || a.idleSince - b.idleSince);
}
