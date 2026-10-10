/**
 * The shells behind the terminal websocket, against a real server on a
 * scratch root with one repo: a shell outlives its socket, the next socket
 * for its name gets what it wrote in between, a rejoin for a name the
 * server does not hold is told so, DELETE ends one, and on tmux a shell
 * outlives the server itself. The tmux server lives on a socket under the
 * scratch config dir, so nothing here touches the real one.
 */
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { killServer, listSessions, tmuxBase } from "../core/tmux";
import { TERM_GONE, type TermInfo } from "../core/types";
import { startServer } from "./index";

let scratch: string;
let previous: string | undefined;
let server: { port: number; stop: () => void };
let root: string;

const tmux = Bun.which("tmux") !== null;

// Shell startup and redraw wait up to fifteen seconds on a busy host.
setDefaultTimeout(30_000);

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
async function termsOn(port: number): Promise<TermInfo[]> {
  const res = await fetch(`http://127.0.0.1:${port}/api/terms`);
  return (await res.json()) as TermInfo[];
}
const terms = () => termsOn(server.port);

const ID = "0123456789abcdef0123456789abcdef";

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "canopy-term-"));
  previous = process.env["CANOPY_CONFIG_DIR"];
  process.env["CANOPY_CONFIG_DIR"] = join(scratch, "config");
  root = join(scratch, "root");
  const repo = join(root, "app");
  await Bun.$`mkdir -p ${repo} && git -C ${repo} init -q`.quiet();
  server = await startServer({ root, port: 0 });
});

afterAll(async () => {
  server.stop();
  const base = tmuxBase();
  if (base) await killServer(base);
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

  test("a pasted image lands under the config dir and comes back as a path to type", async () => {
    const id = "3333333333333333cccccccccccccccc";
    const c = connect({ term: id });
    await c.opened;
    const paste = (type: string, body: Uint8Array, term = id) =>
      fetch(`http://127.0.0.1:${server.port}/api/terms/paste?term=${term}`, { method: "POST", headers: { "content-type": type }, body });
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    // the shell is held once it has drawn, not when the socket opens
    c.ws.send(new TextEncoder().encode("printf 'pas%s\\n' te\n"));
    await until(() => c.text().includes("paste"), "the shell's first line");

    const res = await paste("image/png", png);
    expect(res.status).toBe(201);
    const { path, text } = (await res.json()) as { path: string; text: string };
    expect(path.startsWith(join(scratch, "config", "pastes", "33333333-"))).toBe(true);
    expect(path.endsWith(".png")).toBe(true);
    expect(text).toBe(path);
    expect([...new Uint8Array(await Bun.file(path).arrayBuffer())]).toEqual([...png]);

    expect((await paste("text/plain", png)).status).toBe(415);
    expect((await paste("image/png", new Uint8Array())).status).toBe(400);
    expect((await paste("image/png", png, "4444444444444444dddddddddddddddd")).status).toBe(404);

    await fetch(`http://127.0.0.1:${server.port}/api/terms?term=${id}`, { method: "DELETE" });
    await c.closed;
  });

  test.if(tmux)("draws on the normal screen and hands a new socket what scrolled off", async () => {
    const id = "1111111111111111aaaaaaaaaaaaaaaa";
    const first = connect({ term: id });
    await first.opened;
    first.ws.send(new TextEncoder().encode("for i in $(seq 1 40); do echo scrolled-$i; done\n"));
    await until(() => first.text().includes("scrolled-40"), "forty lines");
    // tmux's client would switch a terminal to its alternate screen, where
    // nothing scrolls back; canopy's config keeps it off
    expect(first.text()).not.toContain("?1049h");
    first.ws.close();
    await first.closed;

    const second = connect({ term: id, attach: "1" });
    await second.opened;
    // line 1 is long off a 24-row screen: it can only have come from history
    await until(() => second.text().includes("scrolled-1\r\n") && second.text().includes("scrolled-40"), "the history then the screen");
    const res = await fetch(`http://127.0.0.1:${server.port}/api/terms?term=${id}`, { method: "DELETE" });
    expect(res.status).toBe(200);
    await second.closed;
  });

  test.if(tmux)("a detach from inside drops the socket without an exit, and a rejoin gets a new client", async () => {
    const id = "2222222222222222bbbbbbbbbbbbbbbb";
    const first = connect({ term: id });
    await first.opened;
    first.ws.send(new TextEncoder().encode("printf 'still-%s\\n' here\n"));
    await until(() => first.text().includes("still-here"), "a line before the detach");
    // $TMUX in the shell names canopy's socket, so this is the socket's own client going
    first.ws.send(new TextEncoder().encode("tmux detach-client\n"));
    const end = await first.closed;
    expect(end.code).toBe(1000);
    expect(first.frames.some((f) => f.includes('"exit"'))).toBe(false);
    expect((await terms()).find((t) => t.id === id)?.attached).toBe(false);

    const second = connect({ term: id, attach: "1" });
    await second.opened;
    await until(() => second.text().includes("still-here"), "the screen after the detach");
    second.ws.send(new TextEncoder().encode("printf 'back-%s\\n' again\n"));
    await until(() => second.text().includes("back-again"), "a line after the rejoin");
    const res = await fetch(`http://127.0.0.1:${server.port}/api/terms?term=${id}`, { method: "DELETE" });
    expect(res.status).toBe(200);
    await second.closed;
  });

  test.if(tmux)("a new session knows where it runs, for an agent's hook to say", async () => {
    const id = "abcdefabcdefabcdefabcdefabcdef01";
    const c = connect({ term: id, place: "strip", cols: "200" });
    await c.opened;
    c.ws.send(new TextEncoder().encode('echo "at=$CANOPY_TERM|$CANOPY_REPO|$CANOPY_API"\n'));
    await until(() => c.text().includes(`at=${id}|app|http://127.0.0.1:${server.port}`), "the env in the session");
    const res = await fetch(`http://127.0.0.1:${server.port}/api/terms?term=${id}`, { method: "DELETE" });
    expect(res.status).toBe(200);
    await c.closed;
  });

  test.if(tmux)("a new session gets canopy's TZ even when the tmux server has none", async () => {
    // a session started first, with no TZ anywhere, holds the tmux server up,
    // so the second session's environment is the server's plus what canopy hands it
    const held = connect({ term: "abcdefabcdefabcdefabcdefabcdef02", place: "strip" });
    await held.opened;
    const was = process.env["TZ"];
    process.env["TZ"] = "America/Los_Angeles";
    const id = "abcdefabcdefabcdefabcdefabcdef03";
    try {
      const c = connect({ term: id, place: "strip", cols: "200" });
      await c.opened;
      c.ws.send(new TextEncoder().encode('echo "tz=$TZ="\n'));
      await until(() => c.text().includes("tz=America/Los_Angeles="), "the TZ in the session");
    } finally {
      if (was === undefined) delete process.env["TZ"];
      else process.env["TZ"] = was;
      for (const term of [id, "abcdefabcdefabcdefabcdefabcdef02"]) await fetch(`http://127.0.0.1:${server.port}/api/terms?term=${term}`, { method: "DELETE" });
    }
  });

  test.if(tmux)("outlives the server: the next one finds it and a socket rejoins", async () => {
    const id = "fedcbafedcbafedcbafedcbafedcbafe";
    const first = connect({ term: id, place: "strip" });
    await first.opened;
    first.ws.send(new TextEncoder().encode("printf 'kept-%s\\n' one\n"));
    await until(() => first.text().includes("kept-one"), "the line before the restart");

    server.stop();
    await first.closed;
    // the session is still on tmux, with what canopy knows about it
    const base = tmuxBase()!;
    expect((await listSessions(base)).map((s) => [s.id, s.repoId, s.place])).toEqual([[id, "app", "strip"]]);

    server = await startServer({ root, port: 0 });
    expect(await terms()).toEqual([expect.objectContaining({ id, repoId: "app", place: "strip", attached: false })]);

    const second = connect({ term: id, attach: "1" });
    await second.opened;
    // tmux repaints the screen on attach, and the line is still on it
    await until(() => second.text().includes("kept-one"), "the screen after the restart");
    second.ws.send(new TextEncoder().encode("printf 'kept-%s\\n' two\n"));
    await until(() => second.text().includes("kept-two"), "a line after the restart");

    const res = await fetch(`http://127.0.0.1:${server.port}/api/terms?term=${id}`, { method: "DELETE" });
    expect(res.status).toBe(200);
    await second.closed;
    expect(await terms()).toEqual([]);
    expect(await listSessions(base)).toEqual([]);
  });
});

describe("a shell on a plain pty (CANOPY_TMUX=0)", () => {
  test("ends with the server", async () => {
    process.env["CANOPY_TMUX"] = "0";
    let plain = await startServer({ root, port: 0 });
    try {
      const id = "0000000000000000ffffffffffffffff";
      const q = new URLSearchParams({ id: "app", term: id, cols: "80", rows: "24" });
      const ws = new WebSocket(`ws://127.0.0.1:${plain.port}/api/term?${q}`);
      ws.binaryType = "arraybuffer";
      let out = "";
      ws.onmessage = (e: MessageEvent<ArrayBuffer | string>) => {
        if (typeof e.data !== "string") out += dec.decode(new Uint8Array(e.data));
      };
      await new Promise<void>((resolve) => {
        ws.onopen = () => resolve();
      });
      ws.send(new TextEncoder().encode("printf 'plain-%s\\n' one\n"));
      await until(() => out.includes("plain-one"), "the plain shell's line");
      expect((await termsOn(plain.port)).map((t) => t.id)).toEqual([id]);
      plain.stop();
      plain = await startServer({ root, port: 0 });
      expect(await termsOn(plain.port)).toEqual([]);
    } finally {
      plain.stop();
      delete process.env["CANOPY_TMUX"];
    }
  });
});
