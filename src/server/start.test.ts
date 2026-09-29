/**
 * A new shell asked for with start=claude gets the agent's line typed in
 * once; a join does not type it again; the agent route says what a shell
 * is running. The line is a stand-in so no real claude starts.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { killServer, tmuxBase } from "../core/tmux";
import { startServer } from "./index";

let scratch: string;
let previous: string | undefined;
let server: { port: number; stop: () => void };
/** how many times the server asked for the agent's line */
let typed = 0;
const dec = new TextDecoder();

function connect(query: Record<string, string>) {
  const q = new URLSearchParams({ id: "app", cols: "80", rows: "24", ...query });
  const ws = new WebSocket(`ws://127.0.0.1:${server.port}/api/term?${q}`);
  ws.binaryType = "arraybuffer";
  const out: string[] = [];
  ws.onmessage = (e: MessageEvent<ArrayBuffer | string>) => {
    if (typeof e.data !== "string") out.push(dec.decode(new Uint8Array(e.data)));
  };
  const opened = new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error("the socket failed"));
  });
  const closed = new Promise<void>((resolve) => {
    ws.onclose = () => resolve();
  });
  return { ws, text: () => out.join(""), opened, closed };
}

async function until(pred: () => boolean | Promise<boolean>, what: string, ms = 15_000): Promise<void> {
  const start = Date.now();
  while (!(await pred())) {
    if (Date.now() - start > ms) throw new Error(`gave up waiting for ${what}`);
    await Bun.sleep(100);
  }
}

const agentOf = async (term: string) => {
  const res = await fetch(`http://127.0.0.1:${server.port}/api/terms/agent?term=${term}`);
  return { status: res.status, body: (await res.json()) as { agent?: string | null } };
};

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "canopy-start-"));
  previous = process.env["CANOPY_CONFIG_DIR"];
  process.env["CANOPY_CONFIG_DIR"] = join(scratch, "config");
  const root = join(scratch, "root");
  await Bun.$`mkdir -p ${join(root, "app")} && git -C ${join(root, "app")} init -q`.quiet();
  server = await startServer({
    root,
    port: 0,
    agentLine: async () => {
      typed++;
      // a pane titled like Claude Code's, which agentIn reads, over a sleep
      return `printf 'agent-%s\\n' up; printf '\\033]2;claude-code\\033\\\\'; sleep 60`;
    },
  });
});

afterAll(async () => {
  server.stop();
  const base = tmuxBase();
  if (base) await killServer(base);
  if (previous === undefined) delete process.env["CANOPY_CONFIG_DIR"];
  else process.env["CANOPY_CONFIG_DIR"] = previous;
  await rm(scratch, { recursive: true, force: true });
});

const A = "a0000000000000000000000000000001";
const B = "b0000000000000000000000000000002";

describe("start=claude", () => {
  test("types the agent line into a new shell once, and a join does not type it again", async () => {
    const first = connect({ term: A, place: "panel", start: "claude" });
    await first.opened;
    await until(() => first.text().includes("agent-up"), "the typed line's output");
    first.ws.close();
    await first.closed;
    const second = connect({ term: A, place: "panel", start: "claude" });
    await second.opened;
    await Bun.sleep(1200);
    expect(typed).toBe(1);
    second.ws.close();
    await second.closed;
  });

  test("the agent route sees claude running, and a plain shell as nothing", async () => {
    await until(async () => (await agentOf(A)).body.agent === "claude", "the agent to show as claude");
    const plain = connect({ term: B, place: "panel" });
    await plain.opened;
    await Bun.sleep(800);
    expect((await agentOf(B)).body.agent).toBeNull();
    plain.ws.close();
    await plain.closed;
  });

  test("the agent route refuses a shell it does not hold", async () => {
    expect((await agentOf("c0000000000000000000000000000003")).status).toBe(404);
  });
});
