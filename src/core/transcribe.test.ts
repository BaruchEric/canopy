import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { transcribe, transcribeConfig, type TranscribeConfig } from "./transcribe";

let server: ReturnType<typeof Bun.serve>;
let answer: () => Response = () => Response.json({ text: " hello there " });
let seen: { model: string; name: string; type: string; size: number; auth: string | null } | null = null;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      if (new URL(req.url).pathname !== "/v1/audio/transcriptions") return new Response("no", { status: 404 });
      // Bun's own multipart parser re-types a .webm file as video/webm, so the
      // stand-in reads the type the client actually sent off the raw part header
      const raw = await req.clone().text();
      const sent = /Content-Type: ([^\r\n]+)/i.exec(raw)?.[1] ?? "";
      const form = await req.formData();
      const file = form.get("file");
      seen = {
        model: String(form.get("model")),
        name: typeof file === "string" || !file ? "" : file.name,
        type: sent,
        size: typeof file === "string" || !file ? 0 : file.size,
        auth: req.headers.get("authorization"),
      };
      return answer();
    },
  });
});

afterAll(() => server.stop(true));

const cfg = (): TranscribeConfig => ({ url: `http://127.0.0.1:${server.port}`, key: "k", model: "transcribe" });
const audio = new Uint8Array([1, 2, 3, 4]);

describe("transcribe", () => {
  test("posts the file and the model, answers the text trimmed", async () => {
    expect(await transcribe(cfg(), audio, "voice.webm", "audio/webm")).toBe("hello there");
    expect(seen).toEqual({ model: "transcribe", name: "voice.webm", type: "audio/webm", size: 4, auth: "Bearer k" });
  });
  test("an error status, an answer that is not JSON, or one with no text all throw", async () => {
    answer = () => new Response("model not found", { status: 404 });
    await expect(transcribe(cfg(), audio, "v.webm", "audio/webm")).rejects.toThrow("answered 404: model not found");
    answer = () => new Response("<html>", { status: 200 });
    await expect(transcribe(cfg(), audio, "v.webm", "audio/webm")).rejects.toThrow("not JSON");
    answer = () => Response.json({ words: [] });
    await expect(transcribe(cfg(), audio, "v.webm", "audio/webm")).rejects.toThrow("no text");
    answer = () => Response.json({ text: "ok" });
  });
  test("the key never shows in an error message", async () => {
    const secret = "sk-secret-key-123";
    const withKey = { ...cfg(), key: secret };
    answer = () => new Response("bad", { status: 500 });
    const err = await transcribe(withKey, audio, "v.webm", "audio/webm").catch((e: unknown) => e);
    expect(String(err)).not.toContain(secret);
    const down: TranscribeConfig = { url: "http://127.0.0.1:1", key: secret, model: "transcribe" };
    const err2 = await transcribe(down, audio, "v.webm", "audio/webm").catch((e: unknown) => e);
    expect(err2).toBeInstanceOf(Error);
    expect(String(err2)).not.toContain(secret);
    answer = () => Response.json({ text: "ok" });
  });
});

describe("transcribeConfig", () => {
  test("off without a url and under bun test; the model defaults to transcribe", () => {
    expect(transcribeConfig({})).toBeNull();
    expect(transcribeConfig({ CANOPY_TRANSCRIBE_URL: "http://x:4000", NODE_ENV: "test" })).toBeNull();
    expect(transcribeConfig({ CANOPY_TRANSCRIBE_URL: "http://x:4000/" })).toEqual({ url: "http://x:4000", key: null, model: "transcribe" });
    expect(transcribeConfig({ CANOPY_TRANSCRIBE_URL: "http://x:4000", CANOPY_TRANSCRIBE_KEY: "k", CANOPY_TRANSCRIBE_MODEL: "whisper" })).toEqual({
      url: "http://x:4000",
      key: "k",
      model: "whisper",
    });
  });
});
