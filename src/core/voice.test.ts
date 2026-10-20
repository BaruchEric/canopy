import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mintVoiceSession, voiceConfig, voiceMinter, voiceSessionBody, type VoiceConfig } from "./voice";
import { VOICE_INSTRUCTIONS, VOICE_SOCKET, VOICE_TOOL_NAMES, VOICE_TOOLS, isVoiceTool } from "./voicewire";

let server: ReturnType<typeof Bun.serve>;
let answer: () => Response = () => Response.json({ value: "ek_abc", expires_at: 1_900_000_000, session: {} });
let seen: { key: string | null; body: unknown } | null = null;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      if (new URL(req.url).pathname !== "/v1/convai/realtime/client_secrets" || req.method !== "POST") return new Response("no", { status: 404 });
      seen = { key: req.headers.get("xi-api-key"), body: await req.json() };
      return answer();
    },
  });
});

afterAll(() => server.stop(true));

const cfg = (key = "xi-test"): VoiceConfig => ({ key, model: "eleven_realtime_v1_mini", voice: "brian", api: `http://127.0.0.1:${server.port}` });

describe("voiceConfig", () => {
  test("off with no key and under bun test", () => {
    expect(voiceConfig({})).toBeNull();
    expect(voiceConfig({ CANOPY_VOICE_KEY: "  " })).toBeNull();
    expect(voiceConfig({ CANOPY_VOICE_KEY: "k", NODE_ENV: "test" })).toBeNull();
  });
  test("defaults to Mini and brian, takes Max, and ignores a model it does not know", () => {
    expect(voiceConfig({ CANOPY_VOICE_KEY: "k" })).toEqual({ key: "k", model: "eleven_realtime_v1_mini", voice: "brian", api: "https://api.elevenlabs.io" });
    expect(voiceConfig({ CANOPY_VOICE_KEY: "k", CANOPY_VOICE_MODEL: "eleven_realtime_v1_max", CANOPY_VOICE_VOICE: "rachel" })).toMatchObject({ model: "eleven_realtime_v1_max", voice: "rachel" });
    expect(voiceConfig({ CANOPY_VOICE_KEY: "k", CANOPY_VOICE_MODEL: "gpt-realtime" })?.model).toBe("eleven_realtime_v1_mini");
    expect(voiceConfig({ CANOPY_VOICE_KEY: "k", CANOPY_VOICE_API: "http://x/" })?.api).toBe("http://x");
  });
});

describe("mintVoiceSession", () => {
  test("posts the session with the key in its header, and answers the secret", async () => {
    const s = await mintVoiceSession(cfg());
    expect(s).toEqual({ socket: VOICE_SOCKET, model: "eleven_realtime_v1_mini", secret: "ek_abc", expiresAt: 1_900_000_000 });
    expect(seen?.key).toBe("xi-test");
    expect(seen?.body).toEqual(voiceSessionBody(cfg(), VOICE_INSTRUCTIONS, VOICE_TOOLS));
  });
  test("the body asks for 24 kHz PCM, a transcript, and every tool", () => {
    const body = voiceSessionBody(cfg(), "hi", VOICE_TOOLS) as { session: { audio: { input: { format: unknown; transcription: unknown } }; tools: { name: string }[] } };
    expect(body.session.audio.input.format).toEqual({ type: "audio/pcm", rate: 24_000 });
    expect(body.session.audio.input.transcription).toEqual({});
    expect(body.session.tools.map((t) => t.name)).toEqual([...VOICE_TOOL_NAMES]);
  });
  test("an error status, an answer that is not JSON, or one with no secret all throw", async () => {
    answer = () => new Response("Realtime models are not available for this workspace.", { status: 403 });
    await expect(mintVoiceSession(cfg())).rejects.toThrow("answered 403: Realtime models are not available");
    answer = () => new Response("<html>", { status: 200 });
    await expect(mintVoiceSession(cfg())).rejects.toThrow("not JSON");
    answer = () => Response.json({ session: {} });
    await expect(mintVoiceSession(cfg())).rejects.toThrow("no client secret");
    answer = () => Response.json({ value: "ek_abc", expires_at: 1_900_000_000 });
  });
  test("the key never shows in an error or in the minter", async () => {
    const secret = "sk_eleven_secret_123";
    answer = () => new Response("bad", { status: 500 });
    expect(String(await mintVoiceSession(cfg(secret)).catch((e: unknown) => e))).not.toContain(secret);
    const down: VoiceConfig = { ...cfg(secret), api: "http://127.0.0.1:1" };
    const err = await mintVoiceSession(down).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(String(err)).not.toContain(secret);
    answer = () => Response.json({ value: "ek_abc", expires_at: 1_900_000_000 });
    const m = voiceMinter(cfg(secret));
    expect(JSON.stringify(m)).not.toContain(secret);
    expect(voiceMinter(null)).toBeNull();
  });
});

test("every tool is named in the list the page dispatches on", () => {
  for (const t of VOICE_TOOLS) expect(isVoiceTool(t.name)).toBe(true);
  expect(VOICE_TOOLS.length).toBe(VOICE_TOOL_NAMES.length);
  expect(isVoiceTool("commit")).toBe(false);
});
