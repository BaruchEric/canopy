/**
 * tailchan, the tailnet message broker (homelab/services/tailchan), as canopy
 * sees it: target parsing, the handle a shell gets, the SSE reader, and what
 * canopy says about its own runs, flows and fleets. Browser-safe and pure;
 * the client that talks to the broker is chan.ts.
 */
import {
  AGENT_STATES,
  ASK_STATES,
  isHarness,
  type AgentCard,
  type AgentOrigin,
  type AgentState,
  type Ask,
  type AskAnswer,
  type AskKind,
  type AskState,
  type ChanMessage,
  type Fleet,
  type Flow,
  type Presence,
  type Run,
  type RunQuestion,
  type RunStatus,
  type RetroState,
  type Sprout,
  type SproutStatus,
} from "./types";

export const HANDLE_RE = /^[a-z0-9][a-z0-9._-]{0,39}$/;
export const CHANNEL_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/** where a post goes, as the broker's POST /v1/messages body takes it */
export type ChanTarget = { channel: string } | { to: string };

/**
 * "#name" or a bare name is a channel, "@handle" a DM. A DM's own channel
 * name (dm.a+b) is readable but not a target the broker accepts, so it is
 * refused here; `dmPeer` turns it into the "@handle" that is.
 */
export function chanTarget(raw: string): ChanTarget | null {
  const t = raw.trim().toLowerCase();
  if (t.startsWith("@")) return HANDLE_RE.test(t.slice(1)) ? { to: t.slice(1) } : null;
  const name = t.replace(/^#/, "");
  return CHANNEL_RE.test(name) && !name.startsWith("dm.") ? { channel: name } : null;
}

/** the query string GET /v1/messages takes for a target or a DM channel name */
export function readQuery(raw: string): string | null {
  const t = raw.trim().toLowerCase();
  if (/^dm\.[a-z0-9._-]+\+[a-z0-9._-]+$/.test(t)) return `channel=${encodeURIComponent(t)}`;
  const target = chanTarget(t);
  if (!target) return null;
  return "to" in target ? `to=${encodeURIComponent(target.to)}` : `channel=${encodeURIComponent(target.channel)}`;
}

/** the other handle in a DM channel (dm.a+b), or null for anything else */
export function dmPeer(channel: string, me: string): string | null {
  const m = /^dm\.([a-z0-9._-]+)\+([a-z0-9._-]+)$/.exec(channel);
  if (!m) return null;
  const [, a = "", b = ""] = m;
  if (a === me) return b;
  if (b === me) return a;
  return null;
}

/**
 * The handle a canopy shell runs under, so an agent inside it is reachable
 * by a name that says where it is: the repo's name slugged and cut, then the
 * first four hex digits of the shell's id, which is what tells two shells at
 * the same repo apart. A restored shell keeps its id, so its handle too.
 */
export function shellHandle(repoName: string, termId: string): string {
  const slug = repoName
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[^a-z0-9]+/, "")
    .slice(0, 30)
    .replace(/[-._]+$/, "");
  return `${slug || "shell"}-${termId.slice(0, 4).toLowerCase()}`;
}

export interface SseEvent {
  event: string;
  data: string;
  id?: string;
}

/**
 * Reads whole server-sent events off the front of a buffer and hands back
 * what is left, an event cut off by a chunk boundary. Comment lines (the
 * broker's ": ping") are skipped.
 */
export function parseSse(buffer: string): { events: SseEvent[]; rest: string } {
  const events: SseEvent[] = [];
  const text = buffer.replace(/\r\n/g, "\n");
  let at = 0;
  for (;;) {
    const end = text.indexOf("\n\n", at);
    if (end < 0) break;
    const block = text.slice(at, end);
    at = end + 2;
    let event = "message";
    let id: string | undefined;
    const data: string[] = [];
    for (const line of block.split("\n")) {
      if (!line || line.startsWith(":")) continue;
      const colon = line.indexOf(":");
      const field = colon < 0 ? line : line.slice(0, colon);
      const value = colon < 0 ? "" : line.slice(colon + 1).replace(/^ /, "");
      if (field === "event") event = value;
      else if (field === "data") data.push(value);
      else if (field === "id") id = value;
    }
    if (data.length) events.push(id === undefined ? { event, data: data.join("\n") } : { event, data: data.join("\n"), id });
  }
  return { events, rest: text.slice(at) };
}

/** a message as the broker sends it, checked field by field */
export function asChanMessage(v: unknown): ChanMessage | null {
  if (!v || typeof v !== "object") return null;
  const m = v as Record<string, unknown>;
  if (typeof m.id !== "number" || typeof m.channel !== "string" || typeof m.handle !== "string") return null;
  if (typeof m.node !== "string" || typeof m.kind !== "string" || typeof m.body !== "string" || typeof m.ts !== "number") return null;
  const meta = m.meta && typeof m.meta === "object" ? (m.meta as Record<string, unknown>) : {};
  return { id: m.id, channel: m.channel, handle: m.handle, node: m.node, kind: m.kind, body: m.body, meta, ts: m.ts };
}

/* ---------- the agent registry, as the broker posts it ---------- */

/** the channel the broker posts every card change on */
export const AGENTS_CHANNEL = "agents";

/** The handle (and node) the broker posts its own events as. The broker
 *  refuses a client's post to `#agents` or `#asks`, and canopy still reads
 *  an event there only from this sender: a card or an ask another handle
 *  managed to post would otherwise be shown, and an ask answered, as the
 *  broker's. */
export const BROKER_HANDLE = "tailchan";

/** whether a message is the broker's own event on `channel` */
const brokerEvent = (m: ChanMessage, channel: string): boolean =>
  m.channel === channel && m.kind === "event" && m.handle === BROKER_HANDLE && m.node === BROKER_HANDLE;

const ORIGINS: readonly AgentOrigin[] = ["canopy-shell", "canopy-run", "elsewhere", "scan"];
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

/** A card as the broker sends it: what canopy keys and orders on (id,
 *  node, state, seenAt) checked, the rest defaulted field by field, so a
 *  broker a version ahead or behind never breaks the page. */
export function asAgentCard(v: unknown): AgentCard | null {
  if (!v || typeof v !== "object") return null;
  const c = v as Record<string, unknown>;
  const state = c.state;
  const seenAt = num(c.seenAt);
  if (typeof c.id !== "string" || !c.id || typeof c.node !== "string" || seenAt === null) return null;
  if (typeof state !== "string" || !(AGENT_STATES as readonly string[]).includes(state)) return null;
  const w = c.where && typeof c.where === "object" ? (c.where as Record<string, unknown>) : {};
  const cw = w.canopy && typeof w.canopy === "object" ? (w.canopy as Record<string, unknown>) : null;
  const cterm = str(cw?.term);
  const crun = str(cw?.run);
  return {
    id: c.id,
    handle: str(c.handle) ?? "",
    node: c.node,
    harness: isHarness(c.harness) ? c.harness : "other",
    session: str(c.session),
    origin: (ORIGINS as readonly unknown[]).includes(c.origin) ? (c.origin as AgentOrigin) : "elsewhere",
    cwd: str(c.cwd) ?? "",
    repo: str(c.repo),
    branch: str(c.branch),
    model: str(c.model),
    mode: str(c.mode),
    state: state as AgentState,
    waiting: str(c.waiting),
    caps: strs(c.caps),
    offers: strs(c.offers),
    notifyIdle: c.notifyIdle === true,
    where: {
      os: str(w.os) ?? "",
      container: w.container === true,
      pid: num(w.pid),
      term: str(w.term),
      canopy: cw ? { backend: str(cw.backend) ?? "", ...(cterm ? { term: cterm } : {}), ...(crun ? { run: crun } : {}) } : null,
    },
    transcript: str(c.transcript),
    startedAt: num(c.startedAt) ?? seenAt,
    seenAt,
    endedAt: num(c.endedAt),
  };
}

/** The card one of the broker's `#agents` events carries
 *  (`{"type":"agent","card":…}` as a silent `event` message), or null for
 *  any other message. */
export function registryCard(m: ChanMessage): AgentCard | null {
  if (!brokerEvent(m, AGENTS_CHANNEL)) return null;
  let data: unknown;
  try {
    data = JSON.parse(m.body);
  } catch {
    return null;
  }
  if (!data || typeof data !== "object" || (data as { type?: unknown }).type !== "agent") return null;
  return asAgentCard((data as { card?: unknown }).card);
}

/* ---------- asks for a human, as the broker posts them ---------- */

/** the channel the broker posts every ask change on */
export const ASKS_CHANNEL = "asks";

const ASK_KINDS: readonly AskKind[] = ["permission", "question", "guard"];

/** one question of an ask, the shape Claude's AskUserQuestion takes;
 *  null for anything that is not one */
function asQuestion(v: unknown): RunQuestion | null {
  if (!v || typeof v !== "object") return null;
  const q = v as Record<string, unknown>;
  if (typeof q.question !== "string" || !q.question) return null;
  const options = Array.isArray(q.options)
    ? q.options.flatMap((o) => {
        if (!o || typeof o !== "object") return [];
        const x = o as Record<string, unknown>;
        return typeof x.label === "string" && x.label ? [{ label: x.label, description: str(x.description) ?? "" }] : [];
      })
    : [];
  return { question: q.question, header: str(q.header) ?? "", options, multiSelect: q.multiSelect === true };
}

function asAnswer(v: unknown): AskAnswer | undefined {
  if (!v || typeof v !== "object") return undefined;
  const a = v as Record<string, unknown>;
  if (a.behavior !== "allow" && a.behavior !== "deny") return undefined;
  const answers =
    a.answers && typeof a.answers === "object"
      ? Object.fromEntries(Object.entries(a.answers as Record<string, unknown>).filter((e): e is [string, string] => typeof e[1] === "string"))
      : null;
  const message = str(a.message);
  return {
    behavior: a.behavior,
    ...(message ? { message } : {}),
    ...(answers && Object.keys(answers).length ? { answers } : {}),
    ...(a.always === true ? { always: true } : {}),
  };
}

/** An ask as the broker sends it: what canopy keys, orders and routes on
 *  (id, kind, state, the times) checked, the rest defaulted field by field,
 *  the way `asAgentCard` reads a card. */
export function asAsk(v: unknown): Ask | null {
  if (!v || typeof v !== "object") return null;
  const a = v as Record<string, unknown>;
  const createdAt = num(a.createdAt);
  if (typeof a.id !== "string" || !a.id || createdAt === null) return null;
  if (typeof a.kind !== "string" || !(ASK_KINDS as readonly string[]).includes(a.kind)) return null;
  if (typeof a.state !== "string" || !(ASK_STATES as readonly string[]).includes(a.state)) return null;
  const questions = Array.isArray(a.questions) ? a.questions.map(asQuestion).filter((q): q is RunQuestion => q !== null) : null;
  const answer = asAnswer(a.answer);
  const answeredBy = str(a.answeredBy);
  const why = str(a.why);
  const answeredAt = num(a.answeredAt);
  return {
    id: a.id,
    agent: str(a.agent) ?? "",
    handle: str(a.handle) ?? "",
    node: str(a.node) ?? "",
    kind: a.kind as AskKind,
    tool: str(a.tool),
    title: str(a.title) ?? a.kind,
    detail: typeof a.detail === "string" ? a.detail : "",
    ...(questions ? { questions } : {}),
    route: a.route === "local" ? "local" : "remote",
    waitUntil: num(a.waitUntil) ?? createdAt,
    state: a.state as AskState,
    ...(answer ? { answer } : {}),
    ...(answeredBy ? { answeredBy } : {}),
    ...(why ? { why } : {}),
    createdAt,
    ...(answeredAt !== null ? { answeredAt } : {}),
  };
}

/** The ask one of the broker's `#asks` events carries
 *  (`{"type":"ask","ask":…}` as a silent `event` message), or null. */
export function askOf(m: ChanMessage): Ask | null {
  if (!brokerEvent(m, ASKS_CHANNEL)) return null;
  let data: unknown;
  try {
    data = JSON.parse(m.body);
  } catch {
    return null;
  }
  if (!data || typeof data !== "object" || (data as { type?: unknown }).type !== "ask") return null;
  return asAsk((data as { ask?: unknown }).ask);
}

/** presence as the broker answers it, or null for anything else */
export function asPresence(v: unknown): Presence | null {
  if (!v || typeof v !== "object") return null;
  const p = v as Record<string, unknown>;
  if (p.state !== "here" && p.state !== "away") return null;
  const by = str(p.by);
  return { state: p.state, at: num(p.at) ?? 0, pinned: p.pinned === true, ...(by ? { by } : {}) };
}

/**
 * The channel every agent in a repo shares, `repo.<owner>-<name>`, off the
 * repo's web url, by the rule the tailchan CLI's hook subscribes with:
 * the url's last two path parts joined by `-`, lowercased (ASCII only, as
 * `tr` does), every byte outside `[a-z0-9._-]` made `-`, then cut to 59
 * characters with one trailing `-` dropped. (The CLI's pipeline turns the
 * line's own newline into that `-` before the cut, so a short slug loses it
 * again and a long one loses a real one.) Null for no url or no slug.
 */
export function repoChannel(url: string | null | undefined): string | null {
  if (!url) return null;
  const parts = url.split("/");
  if (parts.length < 2) return null;
  const pair = `${parts[parts.length - 2]}-${parts[parts.length - 1]}\n`;
  let slug = "";
  for (const b of new TextEncoder().encode(pair)) {
    const c = b >= 65 && b <= 90 ? b + 32 : b;
    const ok = (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 46 || c === 95 || c === 45;
    slug += ok ? String.fromCharCode(c) : "-";
  }
  slug = slug.slice(0, 59);
  if (slug.endsWith("-")) slug = slug.slice(0, -1);
  return slug ? `repo.${slug}` : null;
}

/* ---------- what canopy says about its own work ---------- */

/** One post canopy makes: to the human as a DM (which pings), or to the
 *  channel (which stays quiet). */
export interface Notice {
  to: "human" | "channel";
  text: string;
}

const ENDED = new Set<string>(["done", "failed", "stopped"]);

/** a run's words for its end: "done, changed", "failed: <why>" */
function ending(status: string, outcome?: string, error?: string): string {
  if (status === "failed") return error ? `failed: ${error}` : "failed";
  return outcome ? `${status}, ${outcome}` : status;
}

/**
 * What to say when a run moves from `prev` to its current status, or null
 * for nothing: a prompt waiting on the user is a DM, an end is a channel
 * line. A chat between turns says nothing; it waits on the user by design.
 */
export function runNotice(run: Run, prev: RunStatus | undefined, repo: string): Notice | null {
  if (run.status === prev) return null;
  if (run.status === "waiting") {
    const what = run.prompt?.kind === "permission" ? `wants to ${run.prompt.title}` : "has a question";
    return { to: "human", text: `${repo}: ${run.verb} ${what}` };
  }
  if (ENDED.has(run.status) && !(prev && ENDED.has(prev))) {
    return { to: "channel", text: `${repo}: ${run.verb} ${ending(run.status, run.outcome, run.error)}` };
  }
  return null;
}

/** the same for a flow: a gate waits on the user, an end is a line */
export function flowNotice(flow: Flow, prev: Flow["status"] | undefined, repo: string): Notice | null {
  if (flow.status === prev) return null;
  const step = flow.steps[flow.current];
  if (flow.status === "gated") {
    return { to: "human", text: `${repo}: ${flow.workflow} waits at a gate${step ? ` after "${step.name}"` : ""}` };
  }
  if (ENDED.has(flow.status) && !(prev && ENDED.has(prev))) {
    return { to: "channel", text: `${repo}: ${flow.workflow} ${ending(flow.status, flow.outcome, flow.error)}` };
  }
  return null;
}

/** a fleet's end, with how its repos came out */
export function fleetNotice(fleet: Fleet, prev: Fleet["status"] | undefined): Notice | null {
  if (fleet.status === prev || fleet.status === "working") return null;
  const skipped = fleet.repos.filter((r) => r.skipped).length;
  const ran = fleet.repos.length - skipped;
  return {
    to: "channel",
    text: `fleet ${fleet.workflow} ${fleet.status}: ${ran} ${ran === 1 ? "repo" : "repos"}${skipped ? `, ${skipped} skipped` : ""}`,
  };
}

/** A sprout's questions or park is a DM, since someone has to look; going
 *  live or being turned down is a channel line. Once per transition. */
export function sproutNotice(s: Sprout, prev: { status: SproutStatus; asking: boolean } | undefined): Notice | null {
  const asking = (s.questions?.length ?? 0) > 0;
  if (asking && !prev?.asking) {
    const n = s.questions?.length ?? 0;
    return { to: "human", text: `${s.title}: ${n} ${n === 1 ? "question" : "questions"} before research, in canopy's inbox` };
  }
  if (s.status === prev?.status) return null;
  if (s.status === "parked") return { to: "human", text: `${s.title} is parked: ${s.parked ?? "no reason given"}` };
  if (s.status === "approving") return { to: "human", text: `${s.title} waits for your yes to push ${s.handOff?.branch ?? "its branch"}, in canopy's inbox` };
  if (s.status === "live") return { to: "channel", text: `${s.title} is live` };
  if (s.status === "handed-off") return { to: "channel", text: `${s.title} is handed off as a branch` };
  if (s.status === "rejected") return { to: "channel", text: `${s.title} was turned down at eval` };
  return null;
}

/** how recent a retro's end must be to be told on a sprout not seen before
 *  (a restart empties what was seen), so a later save of an old one is quiet */
export const RETRO_FRESH = 5 * 60_000;

/** A retro that left lessons is a silent channel line pointing at the
 *  inbox, once (amendment 5, ruling 14). One that left none or failed is
 *  quiet here: the feed and the sheet say so, and nobody has to act. */
export function retroNotice(s: Sprout, prev: { retro?: RetroState | undefined } | undefined, now: number): Notice | null {
  const r = s.retro;
  if (r?.state !== "done") return null;
  const n = r.advice?.length ?? 0;
  if (n === 0) return null;
  if (prev ? prev.retro === "done" : now - (r.endedAt ?? 0) > RETRO_FRESH) return null;
  return { to: "channel", text: `${s.title}: the retro left ${n} ${n === 1 ? "lesson" : "lessons"}, in canopy's inbox` };
}
