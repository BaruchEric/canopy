/**
 * A shell's text as tmux holds it, for the gear's copy: history and screen
 * for a plain shell, and only the screen while a full-screen program (Claude
 * Code, vim) is up, since the lines above it are the shell's from before and
 * the browser terminal's own buffer holds stale frames of the program.
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

const textOf = async (term: string) => {
  const res = await fetch(`http://127.0.0.1:${server.port}/api/terms/text?term=${term}`);
  return { status: res.status, body: (await res.json()) as { text?: string | null; fullscreen?: boolean } };
};

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "canopy-text-"));
  previous = process.env["CANOPY_CONFIG_DIR"];
  process.env["CANOPY_CONFIG_DIR"] = join(scratch, "config");
  const root = join(scratch, "root");
  await Bun.$`mkdir -p ${join(root, "app")} && git -C ${join(root, "app")} init -q`.quiet();
  server = await startServer({
    root,
    port: 0,
    harnesses: ["claude"],
    // sixty lines that scroll into history, then, for "full", the
    // alternate screen with one line on it, the way a full-screen program
    // starts
    agentLine: async () =>
      `f() { i=0; while [ $i -lt 60 ]; do echo hist-$i; i=$((i+1)); done; ` +
      `if [ "$1" = full ]; then printf '\\033[?1049h\\033[HFULLSCREEN\\n'; else printf 'plain-%s\\n' done; fi; sleep 60; }; f`,
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

const PLAIN = "e0000000000000000000000000000005";
const FULL = "f0000000000000000000000000000006";

describe("/api/terms/text", () => {
  test("a plain shell's text is its history and screen", async () => {
    const c = connect({ term: PLAIN, place: "panel", start: "agent", prompt: "plain" });
    await c.opened;
    await until(async () => ((await textOf(PLAIN)).body.text ?? "").includes("plain-done"), "the shell's last line");
    const { body } = await textOf(PLAIN);
    expect(body.fullscreen).toBe(false);
    expect(body.text).toContain("hist-1\n");
    c.ws.close();
    await c.closed;
  }, 30_000);

  test("a full-screen program's text is its screen alone", async () => {
    const c = connect({ term: FULL, place: "panel", start: "agent", prompt: "full" });
    await c.opened;
    await until(async () => (await textOf(FULL)).body.fullscreen === true, "the alternate screen");
    await until(async () => ((await textOf(FULL)).body.text ?? "").includes("FULLSCREEN"), "the program's screen");
    expect((await textOf(FULL)).body.text).not.toContain("hist-");
    c.ws.close();
    await c.closed;
  }, 30_000);

  test("refuses a shell it does not hold", async () => {
    expect((await textOf("c0000000000000000000000000000003")).status).toBe(404);
  });
});
