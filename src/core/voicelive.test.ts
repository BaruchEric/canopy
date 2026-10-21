import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { liveConfig, liveOpener, liveSessionBody, openLiveSession, type LiveConfig } from "./voicelive";
import { LIVE_BACKEND_INSTRUCTIONS, LIVE_INSTRUCTIONS, VOICE_TOOL_NAMES, type VoiceContext } from "./voicewire";

let server: ReturnType<typeof Bun.serve>;
let answer: () => Response = () => Response.json({ session: { id: "live_123" }, transport: { type: "webrtc", sdp: "v=0 answer" } }, { status: 201 });
let seen: { auth: string | null; body: unknown } | null = null;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      if (new URL(req.url).pathname !== "/v1/live/sessions" || req.method !== "POST") return new Response("no", { status: 404 });
      seen = { auth: req.headers.get("authorization"), body: await req.json() };
      return answer();
    },
  });
});

afterAll(() => server.stop(true));

const cfg = (key = "sk-test"): LiveConfig => ({ key, model: "gpt-live-1", voice: "marin", backend: "gpt-6-luna", api: `http://127.0.0.1:${server.port}` });

interface Body {
  session: {
    model: string;
    instructions: string;
    audio: unknown;
    delegation: { type: string; responses: { model: string; instructions: string; tools: { name: string }[]; parallel_tool_calls: boolean } };
  };
  transport: { type: string; sdp: string };
}

describe("liveConfig", () => {
  test("off with no key and under bun test", () => {
    expect(liveConfig({})).toBeNull();
    expect(liveConfig({ CANOPY_LIVE_KEY: " " })).toBeNull();
    expect(liveConfig({ CANOPY_LIVE_KEY: "k", NODE_ENV: "test" })).toBeNull();
  });
  test("defaults to gpt-live-1, marin and gpt-6-luna, each one overridable", () => {
    expect(liveConfig({ CANOPY_LIVE_KEY: "k" })).toEqual({ key: "k", model: "gpt-live-1", voice: "marin", backend: "gpt-6-luna", api: "https://api.openai.com" });
    expect(liveConfig({ CANOPY_LIVE_KEY: "k", CANOPY_LIVE_MODEL: "gpt-live-2", CANOPY_LIVE_VOICE: "vesper", CANOPY_LIVE_BACKEND: "gpt-6-sol", CANOPY_LIVE_API: "http://x/" })).toEqual({
      key: "k",
      model: "gpt-live-2",
      voice: "vesper",
      backend: "gpt-6-sol",
      api: "http://x",
    });
  });
});

describe("openLiveSession", () => {
  test("posts the offer with the key as a bearer and answers the session's SDP", async () => {
    expect(await openLiveSession(cfg(), "v=0 offer")).toEqual({ id: "live_123", sdp: "v=0 answer" });
    expect(seen?.auth).toBe("Bearer sk-test");
    expect(seen?.body).toEqual(liveSessionBody(cfg(), "v=0 offer"));
  });
  test("the body gives the tools to the backend, one call at a time, and names no audio format", () => {
    const body = liveSessionBody(cfg(), "v=0") as Body;
    expect(body.transport).toEqual({ type: "webrtc", sdp: "v=0" });
    expect(body.session.audio).toEqual({ output: { voice: "marin" } });
    expect(body.session.instructions).toBe(LIVE_INSTRUCTIONS);
    const r = body.session.delegation.responses;
    expect(body.session.delegation.type).toBe("responses");
    expect(r.model).toBe("gpt-6-luna");
    expect(r.instructions).toBe(LIVE_BACKEND_INSTRUCTIONS);
    expect(r.tools.map((t) => t.name)).toEqual([...VOICE_TOOL_NAMES]);
    expect(r.parallel_tool_calls).toBe(false);
  });
  test("the invoked chat and conversation reach both live and delegated instructions", async () => {
    const context = { kind: "chat", view: "git", repo: { id: "dev/api", name: "api", path: "/r/api" }, chat: { id: "chat-7", verb: "Chat", status: "idle", note: "Fix uploads", messages: [{ who: "user", text: "Keep the API" }] } } satisfies VoiceContext;
    await openLiveSession(cfg(), "v=0 offer", fetch, context);
    expect(seen?.body).toMatchObject({ session: { instructions: expect.stringContaining("chat-7"), delegation: { responses: { instructions: expect.stringContaining("Keep the API") } } } });
  });
  test("an error status names OpenAI's message; no JSON or no SDP throws", async () => {
    answer = () => Response.json({ error: { message: "You do not have access to gpt-live-1.", type: "invalid_request_error" } }, { status: 403 });
    await expect(openLiveSession(cfg(), "v=0")).rejects.toThrow("answered 403: You do not have access to gpt-live-1.");
    answer = () => new Response("<html>", { status: 201 });
    await expect(openLiveSession(cfg(), "v=0")).rejects.toThrow("not JSON");
    answer = () => Response.json({ session: { id: "live_1" }, transport: {} }, { status: 201 });
    await expect(openLiveSession(cfg(), "v=0")).rejects.toThrow("no SDP");
    answer = () => Response.json({ session: { id: "live_123" }, transport: { type: "webrtc", sdp: "v=0 answer" } }, { status: 201 });
  });
  test("the key never shows in an error or in the opener", async () => {
    const secret = "sk-proj-secret_123";
    answer = () => new Response("bad", { status: 500 });
    expect(String(await openLiveSession(cfg(secret), "v=0").catch((e: unknown) => e))).not.toContain(secret);
    const err = await openLiveSession({ ...cfg(secret), api: "http://127.0.0.1:1" }, "v=0").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(String(err)).not.toContain(secret);
    answer = () => Response.json({ session: { id: "live_123" }, transport: { type: "webrtc", sdp: "v=0 answer" } }, { status: 201 });
    expect(JSON.stringify(liveOpener(cfg(secret)))).not.toContain(secret);
    expect(liveOpener(null)).toBeNull();
  });
});
