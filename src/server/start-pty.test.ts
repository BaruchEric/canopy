/**
 * On a backend without tmux, start=agent still types the agent line, but
 * the agent route never says a plain pty runs claude: with no tmux to ask
 * what the shell is running, a user who quit Claude would get a prompt
 * typed into bash.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "./index";

let scratch: string;
let prevConfig: string | undefined;
let prevTmux: string | undefined;
let server: { port: number; stop: () => void };
const dec = new TextDecoder();
const ID = "e0000000000000000000000000000005";

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "canopy-start-pty-"));
  prevConfig = process.env["CANOPY_CONFIG_DIR"];
  prevTmux = process.env["CANOPY_TMUX"];
  process.env["CANOPY_CONFIG_DIR"] = join(scratch, "config");
  process.env["CANOPY_TMUX"] = "0";
  const root = join(scratch, "root");
  await Bun.$`mkdir -p ${join(root, "app")} && git -C ${join(root, "app")} init -q`.quiet();
  server = await startServer({ root, port: 0, harnesses: ["claude"], agentLine: async () => "printf 'agent-%s\\n' up" });
});

afterAll(async () => {
  server.stop();
  for (const [k, v] of [["CANOPY_CONFIG_DIR", prevConfig], ["CANOPY_TMUX", prevTmux]] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  await rm(scratch, { recursive: true, force: true });
});

test("the line is typed, and the route answers null all the same", async () => {
  const q = new URLSearchParams({ id: "app", cols: "80", rows: "24", term: ID, place: "panel", start: "agent" });
  const ws = new WebSocket(`ws://127.0.0.1:${server.port}/api/term?${q}`);
  ws.binaryType = "arraybuffer";
  let out = "";
  ws.onmessage = (e: MessageEvent<ArrayBuffer | string>) => {
    if (typeof e.data !== "string") out += dec.decode(new Uint8Array(e.data));
  };
  await new Promise<void>((resolve) => (ws.onopen = () => resolve()));
  const start = Date.now();
  while (!out.includes("agent-up") && Date.now() - start < 10_000) await Bun.sleep(100);
  expect(out).toContain("agent-up");
  const res = await fetch(`http://127.0.0.1:${server.port}/api/terms/agent?term=${ID}`);
  expect(((await res.json()) as { agent: unknown }).agent).toBeNull();
  ws.close();
});
