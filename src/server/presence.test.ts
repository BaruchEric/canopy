/**
 * Presence and the live shell list, against a real server on a scratch
 * root: a browser that says who it is on the event stream is a device, two
 * streams of one id are one device with two windows, an anonymous stream
 * is no device, the list goes out as a `devices` event a beat after a
 * change, a shell's start, join, leave and end each go out as a `terms`
 * event with the viewers named, and a run started with the browser's id
 * says which device it came from. Plain ptys (`CANOPY_TMUX=0`), so nothing
 * here touches a tmux server.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Device, ServerEvent, TermInfo } from "../core/types";
import { startServer } from "./index";

let scratch: string;
let server: { port: number; stop: () => void };
let root: string;
const saved: Record<string, string | undefined> = {};

const api = (path: string) => `http://127.0.0.1:${server.port}${path}`;
const MAC = "a".repeat(16);
const PHONE = "b".repeat(16);

/** one event stream, registered as `who` (or anonymous), collecting events */
function listen(who: Record<string, string> | null): { events: ServerEvent[]; stop: () => void; opened: Promise<void> } {
  const events: ServerEvent[] = [];
  const ctl = new AbortController();
  const q = who ? `?${new URLSearchParams(who)}` : "";
  let openIt: () => void = () => {};
  const opened = new Promise<void>((r) => (openIt = r));
  void (async () => {
    const res = await fetch(api(`/api/events${q}`), { signal: ctl.signal });
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let buf = "";
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        if (buf.includes(": hello")) openIt();
        let nl: number;
        while ((nl = buf.indexOf("\n\n")) !== -1) {
          const chunk = buf.slice(0, nl);
          buf = buf.slice(nl + 2);
          const line = chunk.split("\n").find((l) => l.startsWith("data: "));
          if (line) events.push(JSON.parse(line.slice(6)) as ServerEvent);
        }
      }
    } catch {
      // aborted
    }
  })();
  return { events, stop: () => ctl.abort(), opened };
}

async function until(pred: () => boolean | Promise<boolean>, what: string, ms = 10_000): Promise<void> {
  const start = Date.now();
  while (!(await pred())) {
    if (Date.now() - start > ms) throw new Error(`gave up waiting for ${what}`);
    await Bun.sleep(25);
  }
}

const devices = async (): Promise<Device[]> => (await fetch(api("/api/devices"))).json() as Promise<Device[]>;
const terms = async (): Promise<TermInfo[]> => (await fetch(api("/api/terms"))).json() as Promise<TermInfo[]>;
const lastOf = <T extends ServerEvent["type"]>(events: ServerEvent[], type: T) =>
  events.filter((e): e is Extract<ServerEvent, { type: T }> => e.type === type).at(-1);

/** a shell socket for `term` as device `client` */
function shell(term: string, client: string | null): { ws: WebSocket; opened: Promise<void>; closed: Promise<void> } {
  const q = new URLSearchParams({ id: "app", term, place: "strip", cols: "80", rows: "24" });
  if (client) q.set("client", client);
  const ws = new WebSocket(`ws://127.0.0.1:${server.port}/api/term?${q}`);
  ws.binaryType = "arraybuffer";
  const opened = new Promise<void>((r, j) => {
    ws.onopen = () => r();
    ws.onerror = () => j(new Error("the socket failed"));
  });
  const closed = new Promise<void>((r) => {
    ws.onclose = () => r();
  });
  return { ws, opened, closed };
}

const ID1 = "0123456789abcdef0123456789abcdef";
const ID2 = "fedcba9876543210fedcba9876543210";

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "canopy-presence-"));
  for (const k of ["CANOPY_CONFIG_DIR", "CANOPY_TMUX"]) saved[k] = process.env[k];
  process.env["CANOPY_CONFIG_DIR"] = join(scratch, "config");
  process.env["CANOPY_TMUX"] = "0";
  root = join(scratch, "root");
  const repo = join(root, "app");
  await Bun.$`mkdir -p ${repo} && git -C ${repo} init -q`.quiet();
  server = await startServer({ root, port: 0 });
});

afterAll(async () => {
  server.stop();
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  await rm(scratch, { recursive: true, force: true });
});

describe("devices", () => {
  test("a stream that says who it is is a device; an anonymous one is not", async () => {
    const anon = listen(null);
    await anon.opened;
    expect(await devices()).toEqual([]);

    const mac = listen({ client: MAC, name: "Eric's Mac", platform: "mac" });
    await mac.opened;
    await until(async () => (await devices()).length === 1, "the mac");
    const [d] = await devices();
    expect(d).toMatchObject({ id: MAC, name: "Eric's Mac", platform: "mac", address: "127.0.0.1", streams: 1 });
    // the anonymous stream hears the list too, a beat after the change
    await until(() => lastOf(anon.events, "devices") !== undefined, "the devices event");
    expect(lastOf(anon.events, "devices")!.devices.map((x) => x.name)).toEqual(["Eric's Mac"]);

    // a second window of the same browser is one device with two windows
    const mac2 = listen({ client: MAC, name: "Eric's Mac", platform: "mac" });
    await mac2.opened;
    await until(async () => (await devices())[0]?.streams === 2, "two windows");
    expect((await devices()).length).toBe(1);

    // a phone is a second device
    const phone = listen({ client: PHONE, name: "Fold", platform: "android" });
    await phone.opened;
    await until(async () => (await devices()).length === 2, "the phone");
    expect((await devices()).map((x) => x.name)).toEqual(["Eric's Mac", "Fold"]);

    // and when its stream closes it goes, and the others hear
    phone.stop();
    await until(async () => (await devices()).length === 1, "the phone to go");
    await until(() => lastOf(mac.events, "devices")?.devices.length === 1, "the mac to hear");
    mac.stop();
    mac2.stop();
    anon.stop();
    await until(async () => (await devices()).length === 0, "everyone to go");
  });
});

describe("the shell list, live", () => {
  test("start, join, leave and end each go out with the viewers named", async () => {
    const mac = listen({ client: MAC, name: "Mac", platform: "mac" });
    const phone = listen({ client: PHONE, name: "Fold", platform: "android" });
    await mac.opened;
    await phone.opened;
    await until(async () => (await devices()).length === 2, "both devices");

    // the mac opens a shell: everyone hears, with the mac as its viewer
    const a = shell(ID1, MAC);
    await a.opened;
    await until(() => lastOf(phone.events, "terms")?.terms.some((t) => t.id === ID1 && t.viewers.includes("Mac")) === true, "the start on the phone's stream");
    expect((await terms()).find((t) => t.id === ID1)).toMatchObject({ attached: true, viewers: ["Mac"] });

    // the phone joins the same shell: both are viewers
    const b = shell(ID1, PHONE);
    await b.opened;
    await until(() => lastOf(mac.events, "terms")?.terms.find((t) => t.id === ID1)?.viewers.length === 2, "the join");
    expect(lastOf(mac.events, "terms")!.terms.find((t) => t.id === ID1)!.viewers.sort()).toEqual(["Fold", "Mac"]);

    // the phone leaves: the shell stays with the mac on it
    b.ws.close();
    await b.closed;
    await until(() => lastOf(mac.events, "terms")?.terms.find((t) => t.id === ID1)?.viewers.join() === "Mac", "the leave");
    expect((await terms()).find((t) => t.id === ID1)?.attached).toBe(true);

    // a socket with no client id is attached but names no viewer
    const c = shell(ID2, null);
    await c.opened;
    await until(async () => (await terms()).some((t) => t.id === ID2), "the second shell");
    expect((await terms()).find((t) => t.id === ID2)).toMatchObject({ attached: true, viewers: [] });

    // ending a shell goes out too
    await fetch(api(`/api/terms?term=${ID2}`), { method: "DELETE" });
    await until(() => lastOf(mac.events, "terms")?.terms.some((t) => t.id === ID2) === false, "the end");
    a.ws.close();
    await a.closed;
    await fetch(api(`/api/terms?term=${ID1}`), { method: "DELETE" });
    mac.stop();
    phone.stop();
  });
});

describe("a run says which device started it", () => {
  test("by the browser's id on the stream", async () => {
    // a stand-in claude on PATH, so the run starts without the real CLI
    const bin = join(scratch, "bin");
    await Bun.$`mkdir -p ${bin}`.quiet();
    await Bun.write(join(bin, "claude"), "#!/bin/sh\nsleep 30\n");
    await Bun.$`chmod +x ${join(bin, "claude")}`.quiet();
    const path = process.env["PATH"];
    process.env["PATH"] = `${bin}:${path}`;
    try {
      const mac = listen({ client: MAC, name: "Mac", platform: "mac" });
      await mac.opened;
      await until(async () => (await devices()).length === 1, "the mac");
      const res = await fetch(api("/api/repos/run?id=app"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "ask", note: "say hi", client: MAC }),
      });
      expect(res.status).toBe(201);
      const run = (await res.json()) as { by?: string; id: string };
      expect(run.by).toBe("Mac");
      await fetch(api("/api/runs/stop"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: run.id }) });
      await fetch(api(`/api/runs?id=${run.id}`), { method: "DELETE" });
      mac.stop();
    } finally {
      process.env["PATH"] = path;
    }
  });
});
