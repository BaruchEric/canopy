/**
 * The shells behind the terminal websocket, against a real server on a
 * scratch root with one repo: a shell outlives its socket, the next socket
 * for its name gets what it wrote in between, a rejoin for a name the
 * server does not hold is told so, and DELETE ends one.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TERM_GONE, type TermInfo } from "../core/types";
import { startServer } from "./index";

let scratch: string;
let previous: string | undefined;
let server: { port: number; stop: () => void };

const dec = new TextDecoder();

/** a client socket that collects everything the server sends */
interface Client {
  ws: WebSocket;
  text: () => string;
  frames: string[];
  closed: Promise<{ code: number; reason: string }>;
  opened: Promise<void>;
}

function connect(query: Record<string, string>): Client {
  const q = new URLSearchParams({ id: "app", cols: "80", rows: "24", ...query });
  const ws = new WebSocket(`ws://127.0.0.1:${server.port}/api/term?${q}`);
  ws.binaryType = "arraybuffer";
  const out: string[] = [];
  const frames: string[] = [];
  ws.onmessage = (e: MessageEvent<ArrayBuffer | string>) => {
    if (typeof e.data === "string") frames.push(e.data);
    else out.push(dec.decode(new Uint8Array(e.data)));
  };
  const closed = new Promise<{ code: number; reason: string }>((resolve) => {
    ws.onclose = (e) => resolve({ code: e.code, reason: e.reason });
  });
  const opened = new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error("the socket failed"));
  });
  return { ws, text: () => out.join(""), frames, closed, opened };
}

async function until(pred: () => boolean, what: string, ms = 15_000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error(`gave up waiting for ${what}`);
    await Bun.sleep(50);
  }
}

/** the list as the browser reads it; the wire shape is the server's own,
 *  which is what the assertions below check */
async function terms(): Promise<TermInfo[]> {
  const res = await fetch(`http://127.0.0.1:${server.port}/api/terms`);
  return (await res.json()) as TermInfo[];
}

const ID = "0123456789abcdef0123456789abcdef";

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "canopy-term-"));
  previous = process.env["CANOPY_CONFIG_DIR"];
  process.env["CANOPY_CONFIG_DIR"] = join(scratch, "config");
  const repo = join(scratch, "root", "app");
  await Bun.$`mkdir -p ${repo} && git -C ${repo} init -q`.quiet();
  server = await startServer({ root: join(scratch, "root"), port: 0 });
});

afterAll(async () => {
  server.stop();
  if (previous === undefined) delete process.env["CANOPY_CONFIG_DIR"];
  else process.env["CANOPY_CONFIG_DIR"] = previous;
  await rm(scratch, { recursive: true, force: true });
});

describe("a shell behind the socket", () => {
  test("a shell needs a well-formed name", async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/term?id=app&term=t1`);
    expect(res.status).toBe(400);
  });

  test("outlives its socket and hands the next one what it missed", async () => {
    const first = connect({ term: ID, place: "panel" });
    await first.opened;
    first.ws.send(new TextEncoder().encode("printf 'held-%s\\n' one\n"));
    await until(() => first.text().includes("held-one"), "the shell's first line");
    expect(await terms()).toEqual([
      expect.objectContaining({ id: ID, repoId: "app", place: "panel", attached: true }),
    ]);

    first.ws.close();
    await first.closed;
    // still there, nobody on it
    expect((await terms()).map((t) => t.attached)).toEqual([false]);

    const second = connect({ term: ID, attach: "1" });
    await second.opened;
    // the replay carries the line the first socket saw
    await until(() => second.text().includes("held-one"), "the replay");
    second.ws.send(new TextEncoder().encode("printf 'held-%s\\n' two\n"));
    await until(() => second.text().includes("held-two"), "the shell's second line");
    expect((await terms()).map((t) => t.attached)).toEqual([true]);

    // DELETE ends it: the socket hears the exit and closes
    const res = await fetch(`http://127.0.0.1:${server.port}/api/terms?term=${ID}`, { method: "DELETE" });
    expect(res.status).toBe(200);
    const end = await second.closed;
    expect(end.code).toBe(1000);
    expect(second.frames.some((f) => f.includes('"exit"'))).toBe(true);
    expect(await terms()).toEqual([]);
  });

  test("two windows on one shell both see it, and one leaving keeps the other", async () => {
    const id = "abcdefabcdefabcdefabcdefabcdefab";
    const a = connect({ term: id });
    await a.opened;
    a.ws.send(new TextEncoder().encode("printf 'both-%s\\n' one\n"));
    await until(() => a.text().includes("both-one"), "the first window's line");
    const b = connect({ term: id, attach: "1" });
    await b.opened;
    await until(() => b.text().includes("both-one"), "the replay in the second window");
    b.ws.send(new TextEncoder().encode("printf 'both-%s\\n' two\n"));
    await until(() => a.text().includes("both-two") && b.text().includes("both-two"), "the line in both");

    a.ws.close();
    await a.closed;
    await Bun.sleep(100);
    expect(b.ws.readyState).toBe(WebSocket.OPEN);
    expect((await terms()).find((t) => t.id === id)?.attached).toBe(true);

    const res = await fetch(`http://127.0.0.1:${server.port}/api/terms?term=${id}`, { method: "DELETE" });
    expect(res.status).toBe(200);
    await b.closed;
  });

  test("a rejoin for a name the server does not hold is told so", async () => {
    const c = connect({ term: "ffffffffffffffffffffffffffffffff", attach: "1" });
    const end = await c.closed;
    expect(end.code).toBe(TERM_GONE);
    expect(await terms()).toEqual([]);
  });

  test("ending a shell that is not there is a 404", async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/terms?term=${ID}`, { method: "DELETE" });
    expect(res.status).toBe(404);
  });
});
