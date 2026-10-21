/**
 * Talking to canopy through GPT-Live, OpenAI's full-duplex voice model. It
 * has no client secret a page could open a session with, so the page makes
 * a WebRTC offer and the server takes it to `/v1/live/sessions` with the
 * key (`CANOPY_LIVE_KEY`) and hands the answer back; audio then runs
 * between the page and OpenAI directly. The live model talks and delegates
 * every lookup to a backend Responses model, which holds canopy's tools
 * and whose calls the page runs. Off with no key, and always off under
 * `bun test`.
 */

import { LIVE_BACKEND_INSTRUCTIONS, LIVE_INSTRUCTIONS, VOICE_TOOLS, voiceContextInstructions, type LiveAnswer, type VoiceContext, type VoiceTool } from "./voicewire";

export interface LiveConfig {
  key: string;
  /** the live model, `gpt-live-1` by default */
  model: string;
  /** a GPT-Live voice name */
  voice: string;
  /** the Responses model the live one delegates to */
  backend: string;
  /** the API's origin; sessions start at `/v1/live/sessions` */
  api: string;
}

export const LIVE_API = "https://api.openai.com";

export function liveConfig(env: Record<string, string | undefined> = process.env): LiveConfig | null {
  if (env["NODE_ENV"] === "test") return null;
  const key = env["CANOPY_LIVE_KEY"]?.trim();
  if (!key) return null;
  return {
    key,
    model: env["CANOPY_LIVE_MODEL"]?.trim() || "gpt-live-1",
    voice: env["CANOPY_LIVE_VOICE"]?.trim() || "marin",
    backend: env["CANOPY_LIVE_BACKEND"]?.trim() || "gpt-6-luna",
    api: (env["CANOPY_LIVE_API"]?.trim() || LIVE_API).replace(/\/+$/, ""),
  };
}

export function liveSessionBody(cfg: LiveConfig, sdp: string, tools: VoiceTool[] = VOICE_TOOLS, context?: VoiceContext): unknown {
  return {
    session: {
      model: cfg.model,
      instructions: LIVE_INSTRUCTIONS + voiceContextInstructions(context),
      // WebRTC settles the audio format itself, so none is named here
      audio: { output: { voice: cfg.voice } },
      delegation: {
        type: "responses",
        responses: {
          model: cfg.backend,
          instructions: LIVE_BACKEND_INSTRUCTIONS + voiceContextInstructions(context),
          tools,
          tool_choice: "auto",
          // one call per response, so each answer goes straight back
          parallel_tool_calls: false,
          reasoning: { effort: "low" },
          max_output_tokens: 400,
        },
      },
    },
    transport: { type: "webrtc", sdp },
  };
}

const ERR_CAP = 200;

export async function openLiveSession(cfg: LiveConfig, sdp: string, fetcher: typeof fetch = fetch, context?: VoiceContext): Promise<LiveAnswer> {
  const res = await fetcher(`${cfg.api}/v1/live/sessions`, {
    method: "POST",
    headers: { authorization: `Bearer ${cfg.key}`, "content-type": "application/json" },
    body: JSON.stringify(liveSessionBody(cfg, sdp, VOICE_TOOLS, context)),
    signal: AbortSignal.timeout(20_000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`OpenAI answered ${res.status}: ${reason(text)}`);
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error("OpenAI's answer is not JSON");
  }
  const id = pick(body, "session", "id");
  const answer = pick(body, "transport", "sdp");
  if (typeof id !== "string" || typeof answer !== "string" || !answer.trim()) throw new Error("OpenAI's answer has no SDP");
  return { id, sdp: answer };
}

const pick = (v: unknown, outer: string, inner: string): unknown => {
  if (typeof v !== "object" || v === null || !(outer in v)) return undefined;
  const o: unknown = Object.entries(v).find(([k]) => k === outer)?.[1];
  if (typeof o !== "object" || o === null) return undefined;
  return Object.entries(o).find(([k]) => k === inner)?.[1];
};

/** the error's message when OpenAI sent its JSON shape, else the text, cut short */
function reason(text: string): string {
  try {
    const v: unknown = JSON.parse(text);
    const msg = pick(v, "error", "message");
    if (typeof msg === "string") return msg.slice(0, ERR_CAP);
  } catch {
    // not JSON; the text itself
  }
  return text.trim().slice(0, ERR_CAP);
}

/** what the server calls to start a conversation */
export interface LiveOpener {
  model: string;
  open: (sdp: string, context?: VoiceContext) => Promise<LiveAnswer>;
}

/** the opener as the server holds it; the key stays inside the closure,
 *  which neither JSON nor a console.log shows */
export const liveOpener = (cfg: LiveConfig | null): LiveOpener | null => {
  if (!cfg) return null;
  const held: LiveConfig = { ...cfg };
  return { model: held.model, open: (sdp, context) => openLiveSession(held, sdp, fetch, context) };
};
