/**
 * Shells kept across a machine going down, against a real server on a
 * scratch root with one repo. The tmux server lives on a socket under the
 * scratch config dir, so nothing here touches the real one, and killing a
 * session behind canopy's back is the shape of a reboot: the session is
 * gone, the record it left is not.
 *
 * Needs tmux; without it there is nothing to outlive anything.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeKept } from "../core/keep";
import { killServer, killSession, snapshot, tmuxBase } from "../core/tmux";
import type { KeptShell, TermInfo } from "../core/types";
import { startServer } from "./index";

let scratch: string;
let previous: string | undefined;
let server: { port: number; stop: () => void };
let root: string;

const tmux = Bun.which("tmux") !== null;
const dec = new TextDecoder();

interface Client {
  ws: WebSocket;
  text: () => string;
  opened: Promise<void>;
}

function connect(term: string): Client {
  const q = new URLSearchParams({ id: "app", cols: "80", rows: "24", place: "strip", term });
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
  return { ws, text: () => out.join(""), opened };
}

async function until(pred: () => boolean | Promise<boolean>, what: string, ms = 15_000): Promise<void> {
  const start = Date.now();
  while (!(await pred())) {
    if (Date.now() - start > ms) throw new Error(`gave up waiting for ${what}`);
    await Bun.sleep(50);
  }
}

const api = (path: string) => `http://127.0.0.1:${server.port}${path}`;
const post = (path: string, body: unknown) => fetch(api(path), { method: "POST", body: JSON.stringify(body) });
const keptList = async (): Promise<{ keeping: boolean; kept: KeptShell[] }> => (await fetch(api("/api/terms/kept"))).json() as Promise<{ keeping: boolean; kept: KeptShell[] }>;

/** a shell with a line of its own on screen, its name */
async function shellWith(id: string, marker: string): Promise<void> {
  const client = connect(id);
  await client.opened;
  await Bun.sleep(700); // the shell's own start-up, before it reads input
  client.ws.send(new TextEncoder().encode(`echo ${marker}\n`));
  await until(() => client.text().includes(marker), `the shell to print ${marker}`);
  client.ws.close();
  await Bun.sleep(200);
}

/** what the pane of a session holds right now, as plain text: a shell that
 * highlights what is typed (ble.sh) puts colours between the words */
async function pane(id: string): Promise<string> {
  const base = tmuxBase();
  return base ? Bun.stripANSI((await snapshot(base, id)) ?? "") : "";
}

/** the machine going down under a shell: the session goes, its record stays */
async function crash(id: string): Promise<void> {
  const base = tmuxBase();
  if (base) await killSession(base, id);
}

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "canopy-keep-"));
  previous = process.env["CANOPY_CONFIG_DIR"];
  process.env["CANOPY_CONFIG_DIR"] = join(scratch, "config");
  root = join(scratch, "root");
  const repo = join(root, "app");
  await Bun.$`mkdir -p ${repo} && git -C ${repo} init -q`.quiet();
  server = await startServer({ root, port: 0, harnesses: ["claude", "codex"] });
});

afterAll(async () => {
  server.stop();
  const base = tmuxBase();
  if (base) await killServer(base);
  if (previous === undefined) delete process.env["CANOPY_CONFIG_DIR"];
  else process.env["CANOPY_CONFIG_DIR"] = previous;
  await rm(scratch, { recursive: true, force: true });
});

describe("keeping shells", () => {
  test.if(tmux)("is off until it is asked for, and nothing is written while it is", async () => {
    const id = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa0";
    expect((await keptList()).keeping).toBe(false);
    await shellWith(id, "before-keeping");
    await post("/api/keep", { on: false });
    await crash(id);
    const after = await keptList();
    expect(after.keeping).toBe(false);
    expect(after.kept).toEqual([]);
  }, 30_000);

  test.if(tmux)("a live shell is recorded but not offered; one whose session is gone is", async () => {
    const id = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb0";
    const on = (await (await post("/api/keep", { on: true })).json()) as { keeping: boolean };
    expect(on.keeping).toBe(true);
    await shellWith(id, "marker-kept-shell");
    // turning it on takes a snapshot of every shell held right then
    await post("/api/keep", { on: true });
    const live = await keptList();
    expect(live.keeping).toBe(true);
    expect(live.kept.some((k) => k.id === id)).toBe(false);

    await crash(id);
    await until(async () => (await keptList()).kept.some((k) => k.id === id), "the lost shell to be offered");
    const kept = (await keptList()).kept.find((k) => k.id === id)!;
    expect(kept.repoId).toBe("app");
    expect(kept.place).toBe("strip");
    expect(kept.lines).toBeGreaterThan(0);
  }, 30_000);

  test.if(tmux)("restoring starts it again under its own name, with what it had ahead of it", async () => {
    const id = "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeee0";
    await post("/api/keep", { on: true });
    await shellWith(id, "marker-restore-me");
    await post("/api/keep", { on: true });
    await crash(id);
    await until(async () => (await keptList()).kept.some((k) => k.id === id), "the lost shell to be offered");

    const res = await post("/api/terms/restore", { term: id, cols: 80, rows: 24 });
    expect(res.status).toBe(200);
    const info = (await res.json()) as TermInfo;
    expect(info.id).toBe(id);
    expect(info.restoredAt).toBeGreaterThan(0);
    // it is a live shell now, so it is no longer on offer
    expect((await keptList()).kept.some((k) => k.id === id)).toBe(false);

    const client = connect(id);
    await client.opened;
    await until(() => client.text().includes("marker-restore-me"), "the restored history");
    expect(client.text()).toContain("[restored by canopy]");
    client.ws.close();
    await Bun.sleep(200);
  }, 30_000);

  test.if(tmux)("a name nothing was kept under cannot be restored, and a live one cannot be restored twice", async () => {
    const gone = await post("/api/terms/restore", { term: "cccccccccccccccccccccccccccccccc", cols: 80, rows: 24 });
    expect(gone.status).toBe(404);
    const bad = await post("/api/terms/restore", { term: 12, cols: 80, rows: 24 });
    expect(bad.status).toBe(400);
  });

  test.if(tmux)("a shell that had Claude in it comes back with the continue typed into it", async () => {
    const id = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1";
    // the record a snapshot of a claude shell would have left; writing it by
    // hand keeps the test off a real agent, which is not what is under test
    await writeKept(
      { id, repoId: "app", path: join(root, "app"), place: "strip", startedAt: Date.now() - 5_000, savedAt: Date.now(), lines: 1, agent: "claude" },
      "what the agent had said\n",
    );
    await until(async () => (await keptList()).kept.some((k) => k.id === id), "the hand-written record to be offered");

    const res = await post("/api/terms/restore", { term: id, cols: 80, rows: 24, resume: true });
    expect(res.status).toBe(200);
    // the line is typed into the shell; whether claude then starts is claude's
    // with the repo's shell route for claude (the builtin: yolo) on it
    await until(async () => (await pane(id)).includes("claude --dangerously-skip-permissions --continue"), "the continue line in the pane");
    expect(await pane(id)).toContain("what the agent had said");
  }, 30_000);

  test.if(tmux)("a kept shell can be forgotten instead", async () => {
    const id = "ddddddddddddddddddddddddddddddd0";
    await post("/api/keep", { on: true });
    await shellWith(id, "marker-forget-me");
    await post("/api/keep", { on: true });
    await crash(id);
    await until(async () => (await keptList()).kept.some((k) => k.id === id), "the lost shell to be offered");

    const res = await fetch(api(`/api/terms/kept?term=${id}`), { method: "DELETE" });
    expect(res.status).toBe(200);
    expect((await keptList()).kept.some((k) => k.id === id)).toBe(false);
    expect((await fetch(api(`/api/terms/kept?term=${id}`), { method: "DELETE" })).status).toBe(404);
  }, 30_000);

  test.if(tmux)("a window that still names a lost shell does not start a new one under its name", async () => {
    const id = "ddddddddddddddddddddddddddddddd1";
    await post("/api/keep", { on: true });
    await shellWith(id, "marker-still-named");
    await post("/api/keep", { on: true });
    await crash(id);
    await until(async () => (await keptList()).kept.some((k) => k.id === id), "the lost shell to be offered");

    // a reloaded ?view=shell&term= window: its first socket does not ask to rejoin
    const client = connect(id);
    const code = await new Promise<number>((resolve) => client.ws.addEventListener("close", (e) => resolve(e.code)));
    expect(code).toBe(4404);
    await post("/api/keep", { on: true });
    const kept = (await keptList()).kept.find((k) => k.id === id);
    expect(kept?.lines).toBeGreaterThan(0);
    expect(await pane(id)).toBe("");
  }, 30_000);

  // last in the file: it takes the tmux server down with it
  test.if(tmux)("the tmux server going out from under canopy is not a shell exiting, so the records stay", async () => {
    const id = "ccccccccccccccccccccccccccccccc1";
    await post("/api/keep", { on: true });
    const client = connect(id);
    await client.opened;
    await Bun.sleep(700);
    client.ws.send(new TextEncoder().encode("echo marker-container-went\n"));
    await until(() => client.text().includes("marker-container-went"), "the shell to print");
    await post("/api/keep", { on: true });

    // the shells container restarting under a canopy that is still up, with
    // a browser still on the shell: every client exits at once, and none of
    // those is the shell exiting
    const base = tmuxBase();
    if (base) await killServer(base);
    await Bun.sleep(1_000);
    await until(async () => (await keptList()).kept.some((k) => k.id === id), "the record to still be offered");
    client.ws.close();
  }, 30_000);

  // after the server went: this shell is the only one on a fresh one
  test.if(tmux)("exiting the last shell on the server forgets it, though the server exits with it", async () => {
    const id = "ccccccccccccccccccccccccccccccc2";
    await post("/api/keep", { on: true });
    const client = connect(id);
    const frames: string[] = [];
    client.ws.addEventListener("message", (e: MessageEvent<ArrayBuffer | string>) => {
      if (typeof e.data === "string") frames.push(e.data);
    });
    const closed = new Promise<void>((resolve) => client.ws.addEventListener("close", () => resolve()));
    await client.opened;
    await Bun.sleep(700);
    client.ws.send(new TextEncoder().encode("echo marker-last-shell\n"));
    await until(() => client.text().includes("marker-last-shell"), "the shell to print");
    await post("/api/keep", { on: true });
    client.ws.send(new TextEncoder().encode("exit\n"));
    await closed;
    expect(frames).toContain(JSON.stringify({ exit: 0 }));
    await until(async () => !(await keptList()).kept.some((k) => k.id === id), "the exited shell to be forgotten");
    // and it stays forgotten through the next pass
    await post("/api/keep", { on: true });
    expect((await keptList()).kept.some((k) => k.id === id)).toBe(false);
  }, 30_000);

  // last in the file: it takes the tmux server down again
  test.if(tmux)("a pass that cannot reach tmux leaves the last good record alone", async () => {
    const id = "ccccccccccccccccccccccccccccccc3";
    await post("/api/keep", { on: true });
    // no socket stays on it, so nothing hears the server go
    await shellWith(id, "marker-good-record");
    await post("/api/keep", { on: true });
    const base = tmuxBase();
    if (base) await killServer(base);
    // the shells container restarting under a canopy that stays up, then
    // the next pass
    await post("/api/keep", { on: true });
    await until(async () => (await keptList()).kept.some((k) => k.id === id), "the lost shell to be offered");
    const kept = (await keptList()).kept.find((k) => k.id === id)!;
    expect(kept.lines).toBeGreaterThan(0);
  }, 30_000);
});
