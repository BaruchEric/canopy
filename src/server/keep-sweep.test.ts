/**
 * The sweep's end of a shell against a real server and tmux, with a
 * stand-in broker for the agent registry: the conversation a registry card
 * names for the shell lands on its kept record, and a user's plain end that
 * arrives while the sweep is keeping the shell waits for it, then forgets
 * the record, so nothing the user closed comes back on offer.
 *
 * Needs tmux. The tmux server lives on a socket under the scratch config dir.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { keepDir } from "../core/keep";
import { killServer, tmuxBase } from "../core/tmux";
import type { AgentCard, KeptShell, SweepInfo, SweepOutcome } from "../core/types";
import { startServer } from "./index";

const tmux = Bun.which("tmux") !== null;
const dec = new TextDecoder();

/** the shell the card names, and the conversation it says runs there */
const CARD_TERM = "dddddddddddddddddddddddddddddd01";
const SESSION = "0f1e2d3c-4b5a-4968-8778-695a4b3c2d1e";

const card: AgentCard = {
  id: `claude:${SESSION}`,
  handle: "app-dd01",
  node: "here",
  harness: "claude",
  session: SESSION,
  origin: "canopy-shell",
  cwd: "/dev/app",
  repo: null,
  branch: null,
  model: null,
  mode: null,
  state: "idle",
  waiting: null,
  caps: [],
  offers: [],
  notifyIdle: false,
  where: { os: "darwin", container: false, pid: 41, term: null, canopy: { backend: "here", term: CARD_TERM } },
  transcript: null,
  startedAt: Date.now() - 60_000,
  seenAt: Date.now(),
  endedAt: null,
};

const broker = Bun.serve({
  port: 0,
  idleTimeout: 0,
  fetch(req) {
    const p = new URL(req.url).pathname;
    if (p === "/v1/agents") return Response.json([card]);
    if (p === "/v1/asks") return Response.json([]);
    if (p === "/v1/stream") {
      const body = new ReadableStream<Uint8Array>({
        start(ctrl) {
          ctrl.enqueue(new TextEncoder().encode("event: ready\ndata: {}\n\n"));
        },
      });
      return new Response(body, { headers: { "content-type": "text/event-stream" } });
    }
    return Response.json({ error: `no route ${p}` }, { status: 404 });
  },
});

let scratch: string;
let previous: string | undefined;
let server: {
  port: number;
  stop: () => Promise<void>;
  endTerm: (id: string, opts?: { keep?: true }) => Promise<boolean>;
  sweepShell: (id: string) => Promise<"ended" | "in use" | "unkept">;
};

const api = (path: string) => `http://127.0.0.1:${server.port}${path}`;
const keptList = async (): Promise<KeptShell[]> => ((await (await fetch(api("/api/terms/kept"))).json()) as { kept: KeptShell[] }).kept;
const onDisk = async (id: string): Promise<boolean> => stat(join(keepDir(), `${id}.json`)).then(() => true, () => false);

async function until(pred: () => boolean | Promise<boolean>, what: string, ms = 15_000): Promise<void> {
  const start = Date.now();
  while (!(await pred())) {
    if (Date.now() - start > ms) throw new Error(`gave up waiting for ${what}`);
    await Bun.sleep(50);
  }
}

/** a shell with a line of its own on screen, its name, and then `after`
 *  typed into it when given */
async function shellWith(id: string, marker: string, after?: string): Promise<void> {
  const q = new URLSearchParams({ id: "app", cols: "80", rows: "24", place: "strip", term: id });
  const ws = new WebSocket(`ws://127.0.0.1:${server.port}/api/term?${q}`);
  ws.binaryType = "arraybuffer";
  const out: string[] = [];
  ws.onmessage = (e: MessageEvent<ArrayBuffer | string>) => {
    if (typeof e.data !== "string") out.push(dec.decode(new Uint8Array(e.data)));
  };
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error("the socket failed"));
  });
  await Bun.sleep(700);
  let typed = 0;
  await until(() => {
    if (out.join("").includes(marker)) return true;
    if (Date.now() - typed > 2_000) {
      ws.send(new TextEncoder().encode(`echo ${marker}\n`));
      typed = Date.now();
    }
    return false;
  }, `the shell to print ${marker}`, 30_000);
  if (after) {
    ws.send(new TextEncoder().encode(`${after}\n`));
    await Bun.sleep(500);
  }
  ws.close();
  await Bun.sleep(200);
}

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "canopy-keepsweep-"));
  previous = process.env["CANOPY_CONFIG_DIR"];
  process.env["CANOPY_CONFIG_DIR"] = join(scratch, "config");
  const root = join(scratch, "root");
  const repo = join(root, "app");
  await Bun.$`mkdir -p ${repo} && git -C ${repo} init -q`.quiet();
  server = await startServer({ root, port: 0, harnesses: ["claude", "codex"], chan: { url: `http://127.0.0.1:${broker.port}`, as: "eric", bot: "canopy", channel: "canopy" } });
});

afterAll(async () => {
  void server.stop();
  void broker.stop(true);
  const base = tmuxBase();
  if (base) await killServer(base);
  if (previous === undefined) delete process.env["CANOPY_CONFIG_DIR"];
  else process.env["CANOPY_CONFIG_DIR"] = previous;
  await rm(scratch, { recursive: true, force: true });
});

describe("the sweep's end of a shell", () => {
  test.if(tmux)("keeps the conversation the registry card names for the shell", async () => {
    await until(async () => {
      const res = await fetch(api("/api/registry"));
      return res.ok && ((await res.json()) as { cards: AgentCard[] }).cards.some((c) => c.id === card.id);
    }, "the registry to list the card");
    await shellWith(CARD_TERM, "marker-card-session");
    expect(await server.endTerm(CARD_TERM, { keep: true })).toBe(true);
    const kept = (await keptList()).find((k) => k.id === CARD_TERM);
    expect(kept?.swept).toBe(true);
    expect(kept?.session).toBe(SESSION);
  }, 60_000);

  test.if(tmux)("the sweep's routes answer here: a fresh shell is not offered, the swept one is listed to restore", async () => {
    const id = "dddddddddddddddddddddddddddddd03";
    await shellWith(id, "marker-fresh");
    const info = (await (await fetch(api("/api/sweep"))).json()) as SweepInfo;
    expect(info.items.some((i) => i.id === id)).toBe(false);
    expect(info.swept.shells.map((k) => k.id)).toContain(CARD_TERM);
    expect(info.settings.on).toBe(false);
    const closed = await fetch(api("/api/sweep"), { method: "POST", body: JSON.stringify({ keys: [`shell:${id}`] }) });
    expect(((await closed.json()) as { outcomes: SweepOutcome[] }).outcomes).toEqual([{ key: `shell:${id}`, result: "in use now" }]);
    expect((await fetch(api(`/api/terms?term=${id}`), { method: "DELETE" })).status).toBe(200);
  }, 60_000);

  test.if(tmux)("a shell quiet past a short span is offered, and closing it keeps it as swept", async () => {
    const id = "dddddddddddddddddddddddddddddd04";
    await shellWith(id, "marker-quiet");
    const set = await fetch(api("/api/sweep/settings"), { method: "POST", body: JSON.stringify({ spans: { shell: 1_000 } }) });
    expect(set.status).toBe(200);
    try {
      // tmux counts activity in whole seconds
      await until(async () => ((await (await fetch(api("/api/sweep"))).json()) as SweepInfo).items.some((i) => i.key === `shell:${id}`), "the quiet shell to be offered");
      const closed = await fetch(api("/api/sweep"), { method: "POST", body: JSON.stringify({ keys: [`shell:${id}`] }) });
      expect(((await closed.json()) as { outcomes: SweepOutcome[] }).outcomes).toEqual([{ key: `shell:${id}`, result: "closed" }]);
      const kept = (await keptList()).find((k) => k.id === id);
      expect(kept?.swept).toBe(true);
      const info = (await (await fetch(api("/api/sweep"))).json()) as SweepInfo;
      expect(info.lastRun?.outcomes).toEqual([{ key: `shell:${id}`, result: "closed" }]);
    } finally {
      await fetch(api("/api/sweep/settings"), { method: "POST", body: JSON.stringify({ spans: { shell: 24 * 3_600_000 } }) });
    }
  }, 60_000);

  test.if(tmux)("with no card to say, a shell the pane shows an agent in is never offered", async () => {
    const quiet = "dddddddddddddddddddddddddddddd05";
    const agent = "dddddddddddddddddddddddddddddd06";
    // a program called claude that waits as an agent at a permission does,
    // with no output and no input (a copy of sleep is killed on a Mac)
    const bin = join(scratch, "bin");
    await mkdir(bin, { recursive: true });
    await writeFile(join(bin, "claude"), `#!${process.execPath}\nsetTimeout(() => {}, 300_000);\n`, { mode: 0o755 });
    // the agent's shell first, so by the time the control is offered the
    // agent's has been quiet longer
    await shellWith(agent, "marker-agent", `${join(bin, "claude")} 300`);
    await shellWith(quiet, "marker-control");
    const set = await fetch(api("/api/sweep/settings"), { method: "POST", body: JSON.stringify({ spans: { shell: 1_000 } }) });
    expect(set.status).toBe(200);
    try {
      let info: SweepInfo | null = null;
      await until(async () => {
        info = (await (await fetch(api("/api/sweep"))).json()) as SweepInfo;
        return info.items.some((i) => i.key === `shell:${quiet}`);
      }, "the quiet shell to be offered");
      expect((info as SweepInfo | null)?.items.some((i) => i.key === `shell:${agent}`)).toBe(false);
    } finally {
      await fetch(api("/api/sweep/settings"), { method: "POST", body: JSON.stringify({ spans: { shell: 24 * 3_600_000 } }) });
      for (const id of [quiet, agent]) await fetch(api(`/api/terms?term=${id}`), { method: "DELETE" });
    }
  }, 60_000);

  test.if(tmux)("a shell typed into while the sweep keeps it stays, and its swept record goes", async () => {
    const id = "dddddddddddddddddddddddddddddd07";
    const q = new URLSearchParams({ id: "app", cols: "80", rows: "24", place: "strip", term: id });
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/api/term?${q}`);
    ws.binaryType = "arraybuffer";
    const out: string[] = [];
    ws.onmessage = (e: MessageEvent<ArrayBuffer | string>) => {
      if (typeof e.data !== "string") out.push(dec.decode(new Uint8Array(e.data)));
    };
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error("the socket failed"));
    });
    try {
      await Bun.sleep(700);
      let typed = 0;
      await until(() => {
        if (out.join("").includes("marker-typed")) return true;
        if (Date.now() - typed > 2_000) {
          ws.send(new TextEncoder().encode("echo marker-typed\n"));
          typed = Date.now();
        }
        return false;
      }, "the shell to print", 30_000);
      // the sweep starts on it, and a keystroke lands while it snapshots
      const how = server.sweepShell(id);
      ws.send(new TextEncoder().encode("x"));
      expect(await how).toBe("in use");
      const terms = (await (await fetch(api("/api/terms"))).json()) as { id: string }[];
      expect(terms.some((t) => t.id === id)).toBe(true);
      expect(await onDisk(id)).toBe(false);
      expect((await keptList()).some((k) => k.id === id)).toBe(false);
    } finally {
      ws.close();
      await fetch(api(`/api/terms?term=${id}`), { method: "DELETE" });
    }
  }, 60_000);

  test.if(tmux)("a plain end during a keep-end waits for it, then forgets the record", async () => {
    const id = "dddddddddddddddddddddddddddddd02";
    await shellWith(id, "marker-race");
    const order: string[] = [];
    // the sweep's end first, then the user's while it is still keeping
    const kept = server.endTerm(id, { keep: true }).then((ok) => {
      order.push("keep");
      return ok;
    });
    const plain = fetch(api(`/api/terms?term=${id}`), { method: "DELETE" }).then((res) => {
      order.push("plain");
      return res.status;
    });
    expect(await kept).toBe(true);
    expect(await plain).toBe(200);
    expect(order).toEqual(["keep", "plain"]);
    // the user's end wins: no record on disk, none on offer
    expect(await onDisk(id)).toBe(false);
    expect((await keptList()).some((k) => k.id === id)).toBe(false);
  }, 60_000);
});
