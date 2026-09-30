/**
 * The helper relay against a real server on a scratch root, headless
 * (`CANOPY_NO_DESKTOP=1`) so the backend has no desktop of its own: a
 * browser naming no helper is told so, a helper that dials in registers by
 * name and the event stream hears the list, the open routes that name it
 * become intents on its socket with the repo rewritten to an ssh locator
 * through `CANOPY_SSH_HOST`, its reply settles the request, its error is
 * the request's error, a newer helper under the name replaces it, and one
 * going away fails what it owed and tells the stream.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HELPER_TIMEOUT } from "../core/helper";
import { DEFAULT_AGENT, type ClientInfo, type HelperInfo, type ServerEvent } from "../core/types";
import { startServer } from "./index";

let scratch: string;
let server: { port: number; stop: () => void };
let root: string;
/** the repo as the scan records it (realpath, so /private/var on a Mac) */
let appPath: string;
const saved: Record<string, string | undefined> = {};

/** a fake helper: the frames it got, and a hand on the socket to answer */
interface Fake {
  ws: WebSocket;
  intents: Array<Record<string, unknown>>;
  opened: Promise<void>;
  closed: Promise<{ code: number; reason: string }>;
}

function dial(query: Record<string, string>): Fake {
  const q = new URLSearchParams({ name: "mbp", platform: "darwin", openers: "kitty,terminal,code,finder,agent", ...query });
  const ws = new WebSocket(`ws://127.0.0.1:${server.port}/api/helper?${q}`);
  const intents: Array<Record<string, unknown>> = [];
  ws.onmessage = (e: MessageEvent<string>) => {
    if (typeof e.data === "string") intents.push(JSON.parse(e.data) as Record<string, unknown>);
  };
  const opened = new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error("the socket failed"));
  });
  const closed = new Promise<{ code: number; reason: string }>((resolve) => {
    ws.onclose = (e) => resolve({ code: e.code, reason: e.reason });
  });
  return { ws, intents, opened, closed };
}

async function until(pred: () => boolean | Promise<boolean>, what: string, ms = 10_000): Promise<void> {
  const start = Date.now();
  while (!(await pred())) {
    if (Date.now() - start > ms) throw new Error(`gave up waiting for ${what}`);
    await Bun.sleep(20);
  }
}

const api = (path: string) => `http://127.0.0.1:${server.port}${path}`;
const client = async (): Promise<ClientInfo> => (await fetch(api("/api/client"))).json() as Promise<ClientInfo>;
const helpers = async (): Promise<HelperInfo[]> => (await fetch(api("/api/helpers"))).json() as Promise<HelperInfo[]>;
const post = (path: string, body: unknown) =>
  fetch(api(path), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

/** the `helpers` events off one event stream, as they land (bun test has
 *  no EventSource, so this reads the stream by hand) */
function listen(): { events: HelperInfo[][]; stop: () => void } {
  const events: HelperInfo[][] = [];
  const ctl = new AbortController();
  void (async () => {
    const res = await fetch(api("/api/events"), { signal: ctl.signal });
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let buf = "";
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf("\n\n")) !== -1) {
          const chunk = buf.slice(0, nl);
          buf = buf.slice(nl + 2);
          const line = chunk.split("\n").find((l) => l.startsWith("data: "));
          if (!line) continue;
          const ev = JSON.parse(line.slice(6)) as ServerEvent;
          if (ev.type === "helpers") events.push(ev.helpers);
        }
      }
    } catch {
      // aborted
    }
  })();
  return { events, stop: () => ctl.abort() };
}

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "canopy-helper-"));
  for (const k of ["CANOPY_CONFIG_DIR", "CANOPY_NO_DESKTOP", "CANOPY_SSH_HOST", "CANOPY_TMUX"]) saved[k] = process.env[k];
  process.env["CANOPY_CONFIG_DIR"] = join(scratch, "config");
  process.env["CANOPY_NO_DESKTOP"] = "1";
  process.env["CANOPY_SSH_HOST"] = "mini";
  process.env["CANOPY_TMUX"] = "0";
  root = join(scratch, "root");
  const repo = join(root, "app");
  await Bun.$`mkdir -p ${repo} && git -C ${repo} init -q`.quiet();
  server = await startServer({ root, port: 0 });
  appPath = await realpath(repo);
});

afterAll(async () => {
  server.stop();
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  await rm(scratch, { recursive: true, force: true });
});

describe("a browser with no helper", () => {
  test("is told its address, that the backend is not its desktop, and why an open fails", async () => {
    expect(await client()).toEqual({ address: "127.0.0.1", local: false, shared: false });
    expect(await helpers()).toEqual([]);
    const res = await post("/api/repos/open?id=app", { app: "kitty" });
    expect(res.status).toBe(400);
    const { error } = (await res.json()) as { error: string };
    expect(error).toContain("no desktop");
    expect(error).toContain("canopy helper");
    const named = await post("/api/repos/open?id=app", { app: "kitty", helper: "nobody" });
    expect(named.status).toBe(400);
    expect(((await named.json()) as { error: string }).error).toContain("nobody is not attached");
  });

  test("a helper with a bad registration is refused", async () => {
    const res = await fetch(api("/api/helper?name=a%20b&platform=darwin"));
    expect(res.status).toBe(400);
    const res2 = await fetch(api("/api/helper?name=ok&platform=darwin&openers=emacs"));
    expect(res2.status).toBe(400);
  });
});

describe("a helper dialled in", () => {
  test("registers by name, relays, and its answers settle the requests", async () => {
    const stream = listen();
    const h = dial({});
    await h.opened;
    await until(() => stream.events.length > 0, "the helpers event");
    const list = await helpers();
    expect(list.length).toBe(1);
    const info = list[0]!;
    expect(info.name).toBe("mbp");
    expect(info.platform).toBe("darwin");
    expect(info.openers).toEqual(["kitty", "terminal", "code", "finder", "agent"]);
    expect(info.address).toBe("127.0.0.1");
    expect(stream.events[0]).toEqual(list);

    // open: the repo's path becomes an ssh locator through CANOPY_SSH_HOST
    const open = post("/api/repos/open?id=app", { app: "kitty", tab: true, helper: "mbp" });
    await until(() => h.intents.length === 1, "the open intent");
    const i1 = h.intents[0]!;
    expect(i1.open).toEqual({ app: "kitty", path: `ssh://mini${appPath}`, agent: DEFAULT_AGENT, tab: true });
    h.ws.send(JSON.stringify({ id: i1.id, ok: true }));
    expect((await open).status).toBe(200);

    // openfile
    const file = post("/api/repos/openfile?id=app", { file: "src/a.ts", line: 7, helper: "mbp" });
    await until(() => h.intents.length === 2, "the file intent");
    const i2 = h.intents[1]!;
    expect(i2.file).toEqual({ path: `ssh://mini${appPath}`, file: "src/a.ts", line: 7 });
    h.ws.send(JSON.stringify({ id: i2.id, error: "no code CLI here" }));
    const failed = await file;
    expect(failed.status).toBe(502);
    expect(((await failed.json()) as { error: string }).error).toBe("mbp: no code CLI here");

    // a reply for an id no one waits on is ignored
    h.ws.send(JSON.stringify({ id: 999, ok: true }));
    h.ws.send("not json");

    // a newer helper under the same name replaces this one
    const h2 = dial({ openers: "code" });
    await h2.opened;
    const gone = await h.closed;
    expect(gone.reason).toContain("another helper");
    await until(() => stream.events.length >= 2, "the second helpers event");
    expect((await helpers()).map((x) => x.openers)).toEqual([["code"]]);

    // a second name is a second entry; when both hang up the list empties
    const h3 = dial({ name: "box", platform: "linux", openers: "kitty" });
    await h3.opened;
    await until(async () => (await helpers()).length === 2, "two helpers");
    h2.ws.close();
    h3.ws.close();
    await until(async () => (await helpers()).length === 0, "the list to empty");
    // the stream's frame may land a beat after the list read did
    await until(() => stream.events.at(-1)?.length === 0, "the empty list on the stream");
    stream.stop();
  });

  test("a request in flight fails when its helper goes away", async () => {
    const h = dial({});
    await h.opened;
    await until(async () => (await helpers()).length === 1, "registration");
    const open = post("/api/repos/open?id=app", { app: "code", helper: "mbp" });
    await until(() => h.intents.length === 1, "the intent");
    h.ws.close();
    const res = await open;
    expect(res.status).toBe(502);
    expect(((await res.json()) as { error: string }).error).toContain("went away");
  });

  test("a workspace goes as one group intent with each repo's settings", async () => {
    await post("/api/workspaces", { name: "pair", repos: ["app"] });
    const h = dial({});
    await h.opened;
    await until(async () => (await helpers()).length === 1, "registration");
    const open = post("/api/workspaces/open", { name: "pair", app: "kitty", helper: "mbp" });
    await until(() => h.intents.length === 1, "the group intent");
    const g = h.intents[0]!.group as { app: string; name: string; repos: string[]; agents: Record<string, unknown> };
    expect(g.app).toBe("kitty");
    expect(g.name).toBe("pair");
    expect(g.repos).toEqual([`ssh://mini${appPath}`]);
    expect(Object.keys(g.agents)).toEqual(g.repos);
    h.ws.send(JSON.stringify({ id: h.intents[0]!.id, ok: true }));
    expect((await open).status).toBe(200);
    h.ws.close();
    await until(async () => (await helpers()).length === 0, "the helper to go");
  });
});

describe("a codex start through a helper", () => {
  test("goes to a helper that reads the harness, and is refused in words for one older than harnesses", async () => {
    const codex = { ...DEFAULT_AGENT, harness: "codex", extra: "--search" };
    expect((await post("/api/repos/agent?id=app", { all: codex })).status).toBe(200);
    try {
      // an old helper registers no harnesses: it would drop codex and keep
      // its flags, so nothing is sent to it
      const old = dial({});
      await old.opened;
      await until(async () => (await helpers()).length === 1, "the old helper");
      const refused = await post("/api/repos/open?id=app", { app: "agent", helper: "mbp" });
      expect(refused.status).toBe(400);
      expect(((await refused.json()) as { error: string }).error).toContain("update canopy there");
      expect(old.intents).toEqual([]);
      // a plain shell reads no harness, so the old helper still gets that
      const kitty = post("/api/repos/open?id=app", { app: "kitty", helper: "mbp" });
      await until(() => old.intents.length === 1, "the kitty intent");
      old.ws.send(JSON.stringify({ id: old.intents[0]!.id, ok: true }));
      expect((await kitty).status).toBe(200);
      // a current helper says what it reads, and gets the codex start
      const now = dial({ harnesses: "claude,codex" });
      await now.opened;
      await old.closed;
      await until(async () => (await helpers())[0]?.harnesses?.length === 2, "the new helper");
      const sent = post("/api/repos/open?id=app", { app: "agent", helper: "mbp" });
      await until(() => now.intents.length === 1, "the codex intent");
      expect((now.intents[0]!.open as { agent: { harness: string } }).agent.harness).toBe("codex");
      now.ws.send(JSON.stringify({ id: now.intents[0]!.id, ok: true }));
      expect((await sent).status).toBe(200);
      now.ws.close();
      await until(async () => (await helpers()).length === 0, "the helper to go");
    } finally {
      await post("/api/repos/agent?id=app", {});
    }
  });
});

describe("the timeout", () => {
  test("is what the protocol says", () => {
    expect(HELPER_TIMEOUT).toBe(20_000);
  });
});
