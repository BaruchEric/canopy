/**
 * Talking to canopy: a spoken conversation with an Eleven Realtime model.
 * The server holds the ElevenLabs key (`CANOPY_VOICE_KEY`) and mints a
 * short-lived client secret scoped to one session config; the page opens the
 * WebSocket itself with that secret, streams the mic up, plays the answer,
 * and runs the model's tool calls against what it already shows. Off with no
 * key, and always off under `bun test`. The half the page shares is in
 * voicewire.ts.
 */

import { VOICE_INSTRUCTIONS, VOICE_MODELS, VOICE_RATE, VOICE_SOCKET, VOICE_TOOLS, type VoiceModel, type VoiceSession, type VoiceTool } from "./voicewire";

export interface VoiceConfig {
  key: string;
  model: VoiceModel;
  /** an ElevenLabs voice name or id */
  voice: string;
  /** the API's origin; the secret is minted at `/v1/convai/realtime/client_secrets` */
  api: string;
}

export const VOICE_API = "https://api.elevenlabs.io";
/** how long a minted secret may open a session; the session then runs to its own cap */
export const VOICE_SECRET_SECONDS = 60;

export function voiceConfig(env: Record<string, string | undefined> = process.env): VoiceConfig | null {
  if (env["NODE_ENV"] === "test") return null;
  const key = env["CANOPY_VOICE_KEY"]?.trim();
  if (!key) return null;
  const model = env["CANOPY_VOICE_MODEL"]?.trim();
  return {
    key,
    model: VOICE_MODELS.find((m) => m === model) ?? "eleven_realtime_v1_mini",
    voice: env["CANOPY_VOICE_VOICE"]?.trim() || "brian",
    api: (env["CANOPY_VOICE_API"]?.trim() || VOICE_API).replace(/\/+$/, ""),
  };
}

export function voiceSessionBody(cfg: VoiceConfig, instructions: string, tools: VoiceTool[]): unknown {
  return {
    session: {
      type: "realtime",
      model: cfg.model,
      instructions,
      output_modalities: ["audio"],
      audio: {
        input: {
          format: { type: "audio/pcm", rate: VOICE_RATE },
          // any object turns on the transcript of what was said; ElevenLabs
          // picks the model and drops a `model` field
          transcription: {},
          turn_detection: { type: "semantic_vad", eagerness: "medium" },
        },
        output: { format: { type: "audio/pcm" }, voice: cfg.voice },
      },
      tools,
      tool_choice: "auto",
    },
    expires_after: { anchor: "created_at", seconds: VOICE_SECRET_SECONDS },
  };
}

export async function mintVoiceSession(
  cfg: VoiceConfig,
  instructions: string = VOICE_INSTRUCTIONS,
  tools: VoiceTool[] = VOICE_TOOLS,
  fetcher: typeof fetch = fetch,
): Promise<VoiceSession> {
  const res = await fetcher(`${cfg.api}/v1/convai/realtime/client_secrets`, {
    method: "POST",
    headers: { "xi-api-key": cfg.key, "content-type": "application/json" },
    body: JSON.stringify(voiceSessionBody(cfg, instructions, tools)),
    signal: AbortSignal.timeout(15_000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`ElevenLabs answered ${res.status}: ${text.trim().slice(0, 200)}`);
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error("ElevenLabs' answer is not JSON");
  }
  if (typeof body !== "object" || body === null) throw new Error("ElevenLabs' answer has no client secret");
  const value = "value" in body ? body.value : undefined;
  const expires = "expires_at" in body ? body.expires_at : undefined;
  if (typeof value !== "string" || typeof expires !== "number") throw new Error("ElevenLabs' answer has no client secret");
  return { socket: VOICE_SOCKET, model: cfg.model, secret: value, expiresAt: expires };
}

/** what the server calls to open a conversation */
export interface VoiceMinter {
  model: VoiceModel;
  mint: () => Promise<VoiceSession>;
}

/** the minter as the server holds it; the key stays inside the closure,
 *  which neither JSON nor a console.log shows */
export const voiceMinter = (cfg: VoiceConfig | null): VoiceMinter | null => {
  if (!cfg) return null;
  const held: VoiceConfig = { ...cfg };
  return { model: held.model, mint: () => mintVoiceSession(held) };
};
