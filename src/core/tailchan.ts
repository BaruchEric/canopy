/**
 * tailchan, the tailnet message broker (homelab/services/tailchan), as canopy
 * sees it: target parsing, the handle a shell gets, the SSE reader, and what
 * canopy says about its own runs, flows and fleets. Browser-safe and pure;
 * the client that talks to the broker is chan.ts.
 */
import { AGENT_STATES, isHarness, type AgentCard, type AgentOrigin, type AgentState, type ChanMessage, type Fleet, type Flow, type Run, type RunStatus } from "./types";

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
  if (m.channel !== AGENTS_CHANNEL || m.kind !== "event") return null;
  let data: unknown;
  try {
    data = JSON.parse(m.body);
  } catch {
    return null;
  }
  if (!data || typeof data !== "object" || (data as { type?: unknown }).type !== "agent") return null;
  return asAgentCard((data as { card?: unknown }).card);
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
