/**
 * A new shell asked for with start=agent gets the agent's line typed in
 * once, for the settings the shell route resolves to with any launch pick
 * applied; a join does not type it again; a start on a harness the backend
 * lacks is refused before any shell starts; the agent route says what a
 * shell is running. The line is a stand-in so no real agent starts.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { killServer, tmuxBase } from "../core/tmux";
import type { AgentSettings } from "../core/types";
import { startServer } from "./index";

let scratch: string;
let previous: string | undefined;
let server: { port: number; stop: () => void };
/** how many times the server asked for the agent's line */
let typed = 0;
/** the settings each ask was for */
const asked: AgentSettings[] = [];
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
  let close = { code: 0, reason: "" };
  const closed = new Promise<void>((resolve) => {
    ws.onclose = (e) => {
      close = { code: e.code, reason: e.reason };
      resolve();
    };
  });
  return { ws, text: () => out.join(""), opened, closed, close: () => close };
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
    // claude only: a codex start is what gets refused below
    harnesses: ["claude"],
    agentLine: async (_repo, agent) => {
      typed++;
      asked.push(agent);
      // a pane titled like Claude Code's, which agentIn reads, over a sleep
      // a function, so a prompt the server adds lands as its argument
      return `f() { printf 'agent-%s\\n' "\${1:-up}"; printf '\\033]2;claude-code\\033\\\\'; sleep 60; }; f`;
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

describe("start=agent", () => {
  test("types the agent line into a new shell once, and a join does not type it again", async () => {
    const first = connect({ term: A, place: "panel", start: "agent" });
    await first.opened;
    await until(() => first.text().includes("agent-up"), "the typed line's output");
    first.ws.close();
    await first.closed;
    const second = connect({ term: A, place: "panel", start: "agent" });
    await second.opened;
    await Bun.sleep(1200);
    expect(typed).toBe(1);
    // the shell route with nothing configured: the builtin claude
    expect(asked[0]?.harness).toBe("claude");
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

  test("a prompt rides in as the agent line's argument, quoted", async () => {
    const c = connect({ term: "d0000000000000000000000000000004", place: "panel", start: "agent", prompt: "it's here" });
    await c.opened;
    await until(() => c.text().includes("agent-it's here"), "the prompt as the argument");
    c.ws.close();
    await c.closed;
  });

  test("the agent route refuses a shell it does not hold", async () => {
    expect((await agentOf("c0000000000000000000000000000003")).status).toBe(404);
  });

  test("start=claude from a page older than harnesses starts the agent the same way", async () => {
    const before = typed;
    const c = connect({ term: "e0000000000000000000000000000005", place: "panel", start: "claude", prompt: "legacy" });
    await c.opened;
    await until(() => c.text().includes("agent-legacy"), "the legacy start's line");
    expect(typed).toBe(before + 1);
    c.ws.close();
    await c.closed;
  });

  test("a harness this backend lacks is refused in words, and no shell starts", async () => {
    const before = typed;
    const id = "f0000000000000000000000000000006";
    const c = connect({ term: id, place: "panel", start: "agent", harness: "codex" });
    await c.closed;
    expect(c.close().code).toBe(1011);
    expect(c.close().reason).toMatch(/^codex is not installed on /);
    expect(typed).toBe(before);
    expect((await agentOf(id)).status).toBe(404);
  });

  test("a profile picked at launch is what the line is made for", async () => {
    const put = await fetch(`http://127.0.0.1:${server.port}/api/agents/profile`, {
      method: "POST",
      body: JSON.stringify({ name: "deep", settings: { harness: "claude", model: "opus", effort: "max", yolo: false, extra: "" } }),
    });
    expect(put.status).toBe(200);
    const c = connect({ term: "f0000000000000000000000000000007", place: "panel", start: "agent", profile: "deep", prompt: "deep" });
    await c.opened;
    await until(() => c.text().includes("agent-deep"), "the profile's start");
    expect(asked.at(-1)).toEqual({ harness: "claude", model: "opus", effort: "max", yolo: false, extra: "" });
    c.ws.close();
    await c.closed;
  });
});
