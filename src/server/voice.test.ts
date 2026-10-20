/**
 * The voice routes on a real server, with a stand-in minter: what the page
 * reads before it shows the mic, a minted session, ElevenLabs refusing, and
 * a backend with no key.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import type { VoiceMinter } from "../core/voice";
import { VOICE_SOCKET } from "../core/voicewire";
import { startServer } from "./index";

let scratch: string;
let previous: string | undefined;
let on: { port: number; stop: () => void };
let off: { port: number; stop: () => void };
let refuse = false;

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

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "canopy-voice-"));
  previous = process.env["CANOPY_CONFIG_DIR"];
  process.env["CANOPY_CONFIG_DIR"] = join(scratch, "config");
  const root = join(scratch, "root");
  await mkdir(root, { recursive: true });
  const base = { root, port: 0, chan: null, harnesses: ["claude" as const], incubator: { autostart: false, transcribe: null, notes: null, ship: null, stage: null } };
  on = await scratchServer({ ...base, voice: minter });
  off = await scratchServer({ ...base, voice: null });
});

afterAll(async () => {
  on.stop();
  off.stop();
  if (previous === undefined) delete process.env["CANOPY_CONFIG_DIR"];
  else process.env["CANOPY_CONFIG_DIR"] = previous;
  await rm(scratch, { recursive: true, force: true });
});

const at = (s: { port: number }, p: string, init?: RequestInit) => fetch(`http://127.0.0.1:${s.port}${p}`, init);

test("GET /api/voice names the model, or null with no key", async () => {
  expect(await (await at(on, "/api/voice")).json()).toEqual({ model: "eleven_realtime_v1_mini" });
  expect(await (await at(off, "/api/voice")).json()).toEqual({ model: null });
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
