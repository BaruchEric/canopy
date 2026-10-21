/**
 * GPT-Live's pure half: its data-channel events into the lines the panel
 * shows, the backend's function calls picked out of their envelopes, and
 * which engine this browser talks through when a backend has both. The
 * browser half (peer connection, mic, speaker) is livecall.ts; the panel's
 * shapes and the tools are voice.ts's, shared with the Eleven call.
 */
import { TOOL_WORDS, VOICE_LINES, type VoiceLine, type VoiceState } from "./voice";

/** one GPT-Live event, loosely: only the fields canopy reads */
export interface LiveEvent {
  type: string;
  delta?: string;
  /** a transcript fragment's place on the session's timeline */
  startMs?: number;
  /** an error's message */
  message?: string;
  /** why a closed session ended */
  reason?: string;
  /** a backend function call, out of its `response.event` envelope */
  call?: { id: string; name: string; arguments: string };
}

const field = (v: unknown, k: string): unknown => (typeof v === "object" && v !== null ? Object.entries(v).find(([key]) => key === k)?.[1] : undefined);
const text = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

/** A data-channel message as an event; null for anything that is not one.
 *  A finished function call comes nested, as `response.event` holding
 *  `response.output_item.done`, and is lifted out as `call`. */
export function parseLiveEvent(raw: string): LiveEvent | null {
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  const type = text(field(v, "type"));
  if (!type) return null;
  const e: LiveEvent = { type };
  const delta = text(field(v, "delta"));
  if (delta !== undefined) e.delta = delta;
  const start = field(v, "start_ms");
  if (typeof start === "number") e.startMs = start;
  const message = text(field(field(v, "error"), "message"));
  if (message !== undefined) e.message = message;
  const reason = text(field(v, "reason"));
  if (reason !== undefined) e.reason = reason;
  const inner = field(v, "event");
  if (type === "response.event" && field(inner, "type") === "response.output_item.done") {
    const item = field(inner, "item");
    const id = text(field(item, "call_id"));
    const name = text(field(item, "name"));
    if (field(item, "type") === "function_call" && id && name) e.call = { id, name, arguments: text(field(item, "arguments")) ?? "{}" };
  }
  return e;
}

/** what the panel says when a session ends on its own */
export const CLOSED_WORDS: Record<string, string> = {
  expired: "the call reached GPT-Live's time limit",
  content: "a safety filter ended the call",
  connection_lost: "the connection to GPT-Live was lost",
};

/** a line that ends a sentence, which a fragment after a tool line does not continue */
const ENDED = /[.!?…]["')\]]?\s*$/;

/** Transcripts come as fragments with no turn: a fragment joins the last
 *  line when the same side is still talking, else starts a new one. A tool
 *  line can land mid-sentence ("I'll check", a lookup, "that."), so the
 *  sentence it cut goes on above it. */
const said = (lines: VoiceLine[], who: "you" | "canopy", delta: string, at: number | undefined): VoiceLine[] => {
  let j = lines.length - 1;
  while (j >= 0 && lines[j]?.who === "tool") j--;
  const last = lines[j];
  if (last?.who === who && (j === lines.length - 1 || !ENDED.test(last.text))) return lines.map((l, i) => (i === j ? { ...l, text: l.text + delta } : l));
  const line: VoiceLine = { id: `${who}:${at ?? lines.length}`, who, text: delta.trimStart() };
  return [...lines, line].slice(-VOICE_LINES);
};

/** `quiet` is the call's own: no transcript for a moment, so whoever was
 *  talking has stopped */
export function liveReduce(v: VoiceState, e: LiveEvent): VoiceState {
  switch (e.type) {
    case "session.started":
      return { ...v, phase: "listening" };
    case "session.input_transcript.delta":
      return e.delta ? { ...v, phase: "hearing", lines: said(v.lines, "you", e.delta, e.startMs) } : v;
    case "session.output_transcript.delta":
      return e.delta ? { ...v, phase: "speaking", lines: said(v.lines, "canopy", e.delta, e.startMs) } : v;
    case "session.delegation.created":
      return { ...v, phase: "thinking" };
    case "response.event":
      return e.call ? { ...v, lines: [...v.lines, { id: e.call.id, who: "tool" as const, text: TOOL_WORDS[e.call.name] ?? e.call.name }].slice(-VOICE_LINES) } : v;
    case "quiet":
      return v.phase === "hearing" || v.phase === "speaking" ? { ...v, phase: "listening" } : v;
    case "error":
      // a moderation cut or a refused command; the session goes on
      return { ...v, error: e.message ?? "GPT-Live sent an error" };
    case "session.closed":
      return { ...v, phase: "ended", error: (e.reason && CLOSED_WORDS[e.reason]) ?? v.error };
    default:
      return v;
  }
}

// ---- which engine ----------------------------------------------------------

export type VoiceEngine = "eleven" | "live";

export const ENGINE_STORE = "canopy.voiceEngine";

type Store = Pick<Storage, "getItem" | "setItem">;

const local = (): Store | null => {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
};

/** The engine to talk through: the one this browser last picked when the
 *  backend still has it, else Eleven, else GPT-Live; null with neither. */
export function pickEngine(has: { eleven: boolean; live: boolean }, store: Store | null = local()): VoiceEngine | null {
  let kept: string | null = null;
  try {
    kept = store?.getItem(ENGINE_STORE) ?? null;
  } catch {
    // blocked storage: the default
  }
  if (kept === "live" && has.live) return "live";
  if (kept === "eleven" && has.eleven) return "eleven";
  return has.eleven ? "eleven" : has.live ? "live" : null;
}

export function keepEngine(engine: VoiceEngine, store: Store | null = local()): void {
  try {
    store?.setItem(ENGINE_STORE, engine);
  } catch {
    // blocked storage: the pick holds for this page only
  }
}
