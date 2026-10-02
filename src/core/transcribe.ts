/**
 * A voice memo into text at intake, through any OpenAI-compatible
 * transcription endpoint (`CANOPY_TRANSCRIBE_URL`, a key and a model name
 * beside it). Off with no url, and always off under `bun test`.
 */

export interface TranscribeConfig {
  /** the server's origin; `/v1/audio/transcriptions` is added */
  url: string;
  key: string | null;
  model: string;
}

export function transcribeConfig(env: Record<string, string | undefined> = process.env): TranscribeConfig | null {
  if (env["NODE_ENV"] === "test") return null;
  const url = env["CANOPY_TRANSCRIBE_URL"]?.trim();
  if (!url) return null;
  return {
    url: url.replace(/\/+$/, ""),
    key: env["CANOPY_TRANSCRIBE_KEY"]?.trim() || null,
    model: env["CANOPY_TRANSCRIBE_MODEL"]?.trim() || "transcribe",
  };
}

/** a long memo takes a while; past this the audio is kept untranscribed */
export const TRANSCRIBE_TIMEOUT = 180_000;

export async function transcribe(
  cfg: TranscribeConfig,
  data: Uint8Array,
  name: string,
  type: string,
  fetcher: typeof fetch = fetch,
  timeoutMs = TRANSCRIBE_TIMEOUT,
): Promise<string> {
  const form = new FormData();
  // a copy, so the part is a plain ArrayBuffer-backed view
  form.append("file", new File([new Uint8Array(data)], name || "audio", { type: type || "application/octet-stream" }));
  form.append("model", cfg.model);
  form.append("response_format", "json");
  const res = await fetcher(`${cfg.url}/v1/audio/transcriptions`, {
    method: "POST",
    body: form,
    headers: cfg.key ? { authorization: `Bearer ${cfg.key}` } : {},
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`the speech model answered ${res.status}: ${text.trim().slice(0, 200)}`);
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error("the speech model's answer is not JSON");
  }
  if (typeof body !== "object" || body === null || typeof (body as { text?: unknown }).text !== "string") {
    throw new Error("the speech model's answer has no text");
  }
  // checked just above
  return (body as { text: string }).text.trim();
}

/** the speech model as the incubator calls it; the config, key and all,
 *  stays inside the closure, which neither JSON nor a console.log shows */
export const transcriber = (cfg: TranscribeConfig | null): ((data: Uint8Array, name: string, type: string) => Promise<string>) | null => {
  if (!cfg) return null;
  const held: TranscribeConfig = { ...cfg };
  return (data, name, type) => transcribe(held, data, name, type);
};
