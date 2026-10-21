/**
 * The voice routes on a real server, with a stand-in minter and speech
 * model: what the page reads before it shows the mic, a minted session,
 * ElevenLabs refusing, a GPT-Live offer, a dictated clip, and a backend
 * with none of them.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import type { VoiceMinter } from "../core/voice";
import type { LiveOpener } from "../core/voicelive";
import { VOICE_SOCKET, type VoiceContext } from "../core/voicewire";
import { startServer } from "./index";

let scratch: string;
let previous: string | undefined;
let on: { port: number; stop: () => void };
let off: { port: number; stop: () => void };
let refuse = false;
/** the offer the stand-in GPT-Live opener was handed last */
let offered: string | null = null;
let invoked: VoiceContext | undefined;
/** what the stand-in speech model was handed last */
let heard: { size: number; name: string; type: string } | null = null;

/** only once CANOPY_CONFIG_DIR is set and under the temp dir, as in incubator.test.ts */
async function scratchServer(opts: Parameters<typeof startServer>[0]): Promise<{ port: number; stop: () => void }> {
  const dir = process.env["CANOPY_CONFIG_DIR"];
  if (!dir) throw new Error("CANOPY_CONFIG_DIR is not set; refusing to start a server on the real config");
  await mkdir(dir, { recursive: true });
  const tmp = await realpath(tmpdir());
  if (!(await realpath(dir)).startsWith(tmp + sep)) throw new Error(`CANOPY_CONFIG_DIR is not under ${tmp}: ${dir}`);
  return startServer(opts);
}

const minter: VoiceMinter = {
  model: "eleven_realtime_v1_mini",
  mint: async () => {
    if (refuse) throw new Error("ElevenLabs answered 401: invalid api key");
    return { socket: VOICE_SOCKET, model: "eleven_realtime_v1_mini", secret: "ek_test", expiresAt: 1_900_000_000 };
  },
};

const live: LiveOpener = {
  model: "gpt-live-1",
  open: async (sdp, context) => {
    offered = sdp;
    invoked = context;
    if (refuse) throw new Error("OpenAI answered 403: no access to gpt-live-1");
    return { id: "live_123", sdp: "v=0 answer" };
  },
};

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "canopy-voice-"));
  previous = process.env["CANOPY_CONFIG_DIR"];
  process.env["CANOPY_CONFIG_DIR"] = join(scratch, "config");
  const root = join(scratch, "root");
  await mkdir(root, { recursive: true });
  const base = { root, port: 0, chan: null, harnesses: ["claude" as const] };
  const incubator = { autostart: false, notes: null, ship: null, stage: null };
  const transcribe = async (data: Uint8Array, name: string, type: string) => {
    heard = { size: data.length, name, type };
    if (refuse) throw new Error("the speech model answered 500: down");
    return "check the failing tests";
  };
  on = await scratchServer({ ...base, voice: minter, live, incubator: { ...incubator, transcribe } });
  off = await scratchServer({ ...base, voice: null, live: null, incubator: { ...incubator, transcribe: null } });
});

afterAll(async () => {
  on.stop();
  off.stop();
  if (previous === undefined) delete process.env["CANOPY_CONFIG_DIR"];
  else process.env["CANOPY_CONFIG_DIR"] = previous;
  await rm(scratch, { recursive: true, force: true });
});

const at = (s: { port: number }, p: string, init?: RequestInit) => fetch(`http://127.0.0.1:${s.port}${p}`, init);

test("GET /api/voice names the models, or null with no key", async () => {
  expect(await (await at(on, "/api/voice")).json()).toEqual({ model: "eleven_realtime_v1_mini", live: "gpt-live-1", dictate: true });
  expect(await (await at(off, "/api/voice")).json()).toEqual({ model: null, live: null, dictate: false });
});

test("POST /api/voice/session hands back the minted secret", async () => {
  const r = await at(on, "/api/voice/session", { method: "POST", body: "{}" });
  expect(r.status).toBe(200);
  expect(await r.json()).toEqual({ socket: VOICE_SOCKET, model: "eleven_realtime_v1_mini", secret: "ek_test", expiresAt: 1_900_000_000 });
});

test("ElevenLabs refusing is a 502 with its reason, and no key is a 503", async () => {
  refuse = true;
  const r = await at(on, "/api/voice/session", { method: "POST", body: "{}" });
  refuse = false;
  expect(r.status).toBe(502);
  expect(((await r.json()) as { error: string }).error).toContain("401");
  const none = await at(off, "/api/voice/session", { method: "POST", body: "{}" });
  expect(none.status).toBe(503);
});

test("POST /api/voice/dictate hands the clip to the speech model under a name it can read", async () => {
  const r = await at(on, "/api/voice/dictate", { method: "POST", body: new Blob([new Uint8Array(64)], { type: "audio/mp4" }) });
  expect(r.status).toBe(200);
  expect(await r.json()).toEqual({ text: "check the failing tests" });
  expect(heard).toEqual({ size: 64, name: "dictation.m4a", type: "audio/mp4" });
});

test("a dictated clip: empty is a 400, the model failing a 502, and no model a 503", async () => {
  expect((await at(on, "/api/voice/dictate", { method: "POST", body: new Blob([], { type: "audio/webm" }) })).status).toBe(400);
  refuse = true;
  const r = await at(on, "/api/voice/dictate", { method: "POST", body: new Blob([new Uint8Array(8)], { type: "audio/webm" }) });
  refuse = false;
  expect(r.status).toBe(502);
  expect(((await r.json()) as { error: string }).error).toContain("500");
  expect((await at(off, "/api/voice/dictate", { method: "POST", body: new Blob([new Uint8Array(8)], { type: "audio/webm" }) })).status).toBe(503);
});

test("POST /api/voice/live takes the offer to GPT-Live and hands the answer back", async () => {
  const r = await at(on, "/api/voice/live", { method: "POST", body: JSON.stringify({ sdp: "v=0 offer" }) });
  expect(r.status).toBe(200);
  expect(await r.json()).toEqual({ id: "live_123", sdp: "v=0 answer" });
  expect(offered).toBe("v=0 offer");
});

test("POST /api/voice/live forwards invocation context and rejects malformed context", async () => {
  const context = { kind: "repo", view: "git", repo: { id: "dev/api", name: "api", path: "/r/api" } } satisfies VoiceContext;
  const r = await at(on, "/api/voice/live", { method: "POST", body: JSON.stringify({ sdp: "v=0", context }) });
  expect(r.status).toBe(200);
  expect(invoked).toEqual(context);
  for (const invalid of [null, [], { kind: "chat", view: "git", repo: context.repo }, { ...context, repo: { name: "api" } }]) {
    expect((await at(on, "/api/voice/live", { method: "POST", body: JSON.stringify({ sdp: "v=0", context: invalid }) })).status).toBe(400);
  }
});

test("a GPT-Live offer: none is a 400, a huge one a 413, OpenAI refusing a 502, and no key a 503", async () => {
  for (const body of ["{}", '{"sdp":"  "}', "not json"]) expect((await at(on, "/api/voice/live", { method: "POST", body })).status).toBe(400);
  expect((await at(on, "/api/voice/live", { method: "POST", body: JSON.stringify({ sdp: "x".repeat(70_000) }) })).status).toBe(413);
  refuse = true;
  const r = await at(on, "/api/voice/live", { method: "POST", body: JSON.stringify({ sdp: "v=0" }) });
  refuse = false;
  expect(r.status).toBe(502);
  expect(((await r.json()) as { error: string }).error).toContain("403");
  expect((await at(off, "/api/voice/live", { method: "POST", body: JSON.stringify({ sdp: "v=0" }) })).status).toBe(503);
});
