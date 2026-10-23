/**
 * The sweep's hub against stand-in deps: what it plans from the facts, the
 * recheck before each close, the closes themselves, one at a time, the log
 * and the event, and a swept chat resumed from its record. The swept-chat
 * records and the log are real files under a scratch config dir.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_SWEEP, type PlanInputs, type ShellFacts } from "../core/sweep";
import { addSweptChat, readLog, readSweptChats, sweepDir } from "../core/sweepstore";
import type { Run, ServerEvent, SweepInfo, SweepSettings, SweptChat } from "../core/types";
import { SweepHub, type SweepDeps } from "./sweep";

const H = 3_600_000;
// the swept-chat records expire against the real clock, so the facts are
// built around it rather than a fixed date
const NOW = Date.now();

const shell = (over: Partial<ShellFacts> = {}): ShellFacts => ({
  id: "t1",
  repoId: "app",
  startedAt: NOW - 48 * H,
  lastOutput: NOW - 30 * H,
  agent: null,
  ...over,
});
const run = (over: Partial<Run> = {}): Run => ({
  id: "r1",
  repoId: "app",
  action: "chat",
  verb: "Chat",
  progress: "",
  expectsChange: false,
  chat: false,
  harness: "claude",
  note: "",
  status: "done",
  startedAt: NOW - 100 * H,
  steps: [],
  prompt: null,
  ...over,
});
const idleChat = (id: string): Run => run({ id, chat: true, status: "idle", session: `sess-${id}`, steps: [{ id: "1", at: NOW - 13 * H, kind: "text" }] });

interface Facts {
  shells: ShellFacts[];
  runs: Run[];
  tmuxDown: boolean;
  /** a started chat's stop ends it only when its process exits, later */
  chatEndsLater: boolean;
  /** runs once the facts are read: a change that lands after the recheck */
  afterFacts: (() => void) | null;
  settings: SweepSettings;
  events: ServerEvent[];
  calls: { endShell: string[]; seen: number[]; stopChat: string[]; dismiss: string[]; startChat: SweptChat[] };
}

/** what the stand-in deps read and write, and the deps over it */
function world(): Facts & { deps: SweepDeps } {
  const w: Facts = {
    shells: [],
    runs: [],
    tmuxDown: false,
    chatEndsLater: false,
    afterFacts: null,
    settings: { ...DEFAULT_SWEEP, spans: { ...DEFAULT_SWEEP.spans }, auto: [...DEFAULT_SWEEP.auto] },
    events: [],
    calls: { endShell: [], seen: [], stopChat: [], dismiss: [], startChat: [] },
  };
  const deps: SweepDeps = {
    broadcast: (ev) => w.events.push(ev),
    facts: async (): Promise<PlanInputs> => {
      const read: PlanInputs = {
        serverStart: NOW - 10 * 24 * H,
        shells: w.tmuxDown ? null : w.shells.map((s) => ({ ...s })),
        runs: w.runs.map((r) => ({ ...r })),
        heldRuns: new Set<string>(),
        outside: [],
      };
      w.afterFacts?.();
      return read;
    },
    endShell: async (id, seen) => {
      w.calls.endShell.push(id);
      w.calls.seen.push(seen);
      // as the server's keep-end: a keystroke newer than the one the plan
      // saw is someone back at it, and the shell stays
      const typed = w.shells.find((s) => s.id === id)?.lastInput;
      if (typed !== undefined && typed > seen) return "in use now";
      // a beat, so a second close that did not wait would see the shell still there
      await Bun.sleep(20);
      w.shells = w.shells.filter((s) => s.id !== id);
      return "closed";
    },
    runStatus: (id) => w.runs.find((r) => r.id === id)?.status,
    stopChat: (id) => {
      w.calls.stopChat.push(id);
      const r = w.runs.find((x) => x.id === id);
      if (!r) throw new Error(`unknown run: ${id}`);
      if (w.chatEndsLater) return { ...r };
      r.status = "done";
      r.endedAt = NOW;
      return { ...r };
    },
    dismissRun: (id) => {
      w.calls.dismiss.push(id);
      w.runs = w.runs.filter((r) => r.id !== id);
    },
    startChat: async (c) => {
      w.calls.startChat.push(c);
      const r = run({ id: "new-chat", chat: true, status: "idle", repoId: c.repoId, harness: c.harness });
      w.runs.push(r);
      return r;
    },
    keptSwept: async () => [],
    now: () => NOW,
    loadSettings: async () => w.settings,
    saveSettings: async (s) => {
      w.settings = s;
    },
  };
  return Object.assign(w, { deps });
}

let scratch: string;
let previous: string | undefined;

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "canopy-sweep-"));
  previous = process.env["CANOPY_CONFIG_DIR"];
  process.env["CANOPY_CONFIG_DIR"] = join(scratch, "config");
});

beforeEach(async () => {
  await rm(sweepDir(), { recursive: true, force: true });
});

afterAll(async () => {
  if (previous === undefined) delete process.env["CANOPY_CONFIG_DIR"];
  else process.env["CANOPY_CONFIG_DIR"] = previous;
  await rm(scratch, { recursive: true, force: true });
});

const req = (path: string, init?: { method?: string; body?: unknown }) => {
  const url = new URL(`http://canopy${path}`);
  const request = new Request(url.href, { method: init?.method ?? "GET", ...(init?.body !== undefined ? { body: JSON.stringify(init.body) } : {}) });
  return { request, url };
};
async function call(hub: SweepHub, path: string, init?: { method?: string; body?: unknown }): Promise<{ status: number; body: unknown }> {
  const { request, url } = req(path, init);
  const res = await hub.handle(request, url);
  if (!res) throw new Error(`no route for ${path}`);
  return { status: res.status, body: await res.json() };
}

describe("the sweep hub", () => {
  test("GET plans from the facts", async () => {
    const w = world();
    w.shells = [shell({ id: "old" }), shell({ id: "new", lastOutput: NOW - 1 * H })];
    const hub = new SweepHub(w.deps);
    const got = await call(hub, "/api/sweep");
    expect(got.status).toBe(200);
    const info = got.body as SweepInfo;
    expect(info.items.map((i) => i.key)).toEqual(["shell:old"]);
    expect(info.settings).toEqual(w.settings);
    expect(info.lastRun).toBeNull();
    expect(info.ask).toBeNull();
  });

  test("close rechecks: a shell typed into since the plan is \"in use now\"", async () => {
    const w = world();
    w.shells = [shell()];
    const hub = new SweepHub(w.deps);
    expect((await hub.info()).items.map((i) => i.key)).toEqual(["shell:t1"]);
    w.shells = [shell({ lastInput: NOW - 60_000 })];
    expect(await hub.close(["shell:t1"], "eric")).toEqual([{ key: "shell:t1", result: "in use now" }]);
    expect(w.calls.endShell).toEqual([]);
  });

  test("close ends a shell with keep, stops a chat and records it, dismisses a run", async () => {
    const w = world();
    w.shells = [shell()];
    w.runs = [idleChat("c1"), run({ id: "d1", status: "done", endedAt: NOW - 4 * 24 * H })];
    const hub = new SweepHub(w.deps);
    const out = await hub.close(["shell:t1", "chat:c1", "run:d1"], "eric");
    expect(out).toEqual([
      { key: "shell:t1", result: "closed" },
      { key: "chat:c1", result: "closed" },
      { key: "run:d1", result: "closed" },
    ]);
    expect(w.calls.endShell).toEqual(["t1"]);
    expect(w.calls.stopChat).toEqual(["c1"]);
    expect(w.calls.dismiss).toEqual(["d1"]);
    const chats = await readSweptChats();
    expect(chats).toHaveLength(1);
    expect(chats[0]).toMatchObject({ runId: "c1", repoId: "app", harness: "claude", session: "sess-c1", sweptAt: NOW });
  });

  test("a key the plan no longer has is \"gone\"", async () => {
    const w = world();
    const hub = new SweepHub(w.deps);
    expect(await hub.close(["shell:t9", "run:r9", "chat:c9"], "eric")).toEqual([
      { key: "shell:t9", result: "gone" },
      { key: "run:r9", result: "gone" },
      { key: "chat:c9", result: "gone" },
    ]);
  });

  test("two closes at once run in turn; the second reports gone", async () => {
    const w = world();
    w.shells = [shell()];
    const hub = new SweepHub(w.deps);
    const [a, b] = await Promise.all([hub.close(["shell:t1"], "eric"), hub.close(["shell:t1"], "eric")]);
    expect(a).toEqual([{ key: "shell:t1", result: "closed" }]);
    expect(b).toEqual([{ key: "shell:t1", result: "gone" }]);
    expect(w.calls.endShell).toEqual(["t1"]);
  });

  test("two closes of a chat whose stop lands later: the second reports gone, and it is stopped once", async () => {
    const w = world();
    w.runs = [idleChat("c1")];
    w.chatEndsLater = true;
    const hub = new SweepHub(w.deps);
    const [a, b] = await Promise.all([hub.close(["chat:c1"], "eric"), hub.close(["chat:c1"], "eric")]);
    expect(a).toEqual([{ key: "chat:c1", result: "closed" }]);
    expect(b).toEqual([{ key: "chat:c1", result: "gone" }]);
    expect(w.calls.stopChat).toEqual(["c1"]);
    // nor is it offered again while it winds down
    expect((await hub.info()).items).toEqual([]);
  });

  test("a chat that starts a turn after the recheck is in use now, not stopped, and keeps no record", async () => {
    const w = world();
    w.runs = [idleChat("c1")];
    // a message arrives while the swept-chat record is being written
    w.afterFacts = () => {
      const r = w.runs.find((x) => x.id === "c1");
      if (r) r.status = "working";
    };
    const hub = new SweepHub(w.deps);
    expect(await hub.close(["chat:c1"], "eric")).toEqual([{ key: "chat:c1", result: "in use now" }]);
    expect(w.calls.stopChat).toEqual([]);
    expect(await readSweptChats()).toEqual([]);
  });

  test("a keystroke after the facts are read and before the close: the shell stays, in use now", async () => {
    const w = world();
    // never typed into since the server started, so the plan saw no keystroke
    w.shells = [shell()];
    w.afterFacts = () => {
      w.afterFacts = null;
      const sh = w.shells.find((s) => s.id === "t1");
      if (sh) sh.lastInput = NOW - 1_000;
    };
    const hub = new SweepHub(w.deps);
    expect(await hub.close(["shell:t1"], "eric")).toEqual([{ key: "shell:t1", result: "in use now" }]);
    expect(w.calls.seen).toEqual([0]);
    expect(w.shells.map((s) => s.id)).toEqual(["t1"]);
  });

  test("the keystroke the plan saw is handed on, and only a newer one keeps the shell", async () => {
    const w = world();
    const old = NOW - 26 * H;
    w.shells = [shell({ id: "a", lastInput: old }), shell({ id: "b", lastInput: old })];
    // a keystroke lands in b after its facts are read
    w.afterFacts = () => {
      const b = w.shells.find((s) => s.id === "b");
      if (b && w.calls.endShell.includes("a")) {
        w.afterFacts = null;
        b.lastInput = NOW - 1_000;
      }
    };
    const hub = new SweepHub(w.deps);
    expect(await hub.close(["shell:a", "shell:b"], "eric")).toEqual([
      { key: "shell:a", result: "closed" },
      { key: "shell:b", result: "in use now" },
    ]);
    expect(w.calls.seen).toEqual([old, old]);
    expect(w.shells.map((s) => s.id)).toEqual(["b"]);
  });

  test("a shell typed into while it is being kept is in use now", async () => {
    const w = world();
    w.shells = [shell()];
    w.deps.endShell = async (id) => {
      w.calls.endShell.push(id);
      return "in use now";
    };
    const hub = new SweepHub(w.deps);
    expect(await hub.close(["shell:t1"], "eric")).toEqual([{ key: "shell:t1", result: "in use now" }]);
  });

  test("tmux down: facts.shells null gives no shell items", async () => {
    const w = world();
    w.shells = [shell()];
    w.tmuxDown = true;
    const hub = new SweepHub(w.deps);
    expect((await hub.info()).items).toEqual([]);
    const [out] = await hub.close(["shell:t1"], "eric");
    expect(out?.result).toBe("failed");
    expect(w.calls.endShell).toEqual([]);
  });

  test("a close writes one log entry and broadcasts the new info", async () => {
    const w = world();
    w.shells = [shell()];
    w.runs = [run({ id: "d1", status: "done", endedAt: NOW - 4 * 24 * H })];
    const hub = new SweepHub(w.deps);
    await hub.close(["shell:t1", "run:d1"], "eric");
    const log = await readLog();
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ at: NOW, by: "eric" });
    expect(log[0]?.outcomes.map((o) => o.result)).toEqual(["closed", "closed"]);
    expect(log[0]?.items.map((i) => i.key)).toEqual(["shell:t1", "run:d1"]);
    const sent = w.events.filter((e): e is Extract<ServerEvent, { type: "sweep" }> => e.type === "sweep");
    expect(sent).toHaveLength(1);
    expect(sent[0]?.sweep.items).toEqual([]);
    expect(sent[0]?.sweep.lastRun?.at).toBe(NOW);
  });

  test("resume starts a chat from the record and removes it", async () => {
    const w = world();
    const rec: SweptChat = { runId: "c1", repoId: "app", harness: "claude", session: "sess-c1", title: "Chat", sweptAt: NOW };
    await addSweptChat(rec);
    const hub = new SweepHub(w.deps);
    const got = await call(hub, "/api/sweep/resume", { method: "POST", body: { runId: "c1" } });
    expect(got.status).toBe(200);
    expect((got.body as Run).id).toBe("new-chat");
    expect(w.calls.startChat).toEqual([rec]);
    expect(await readSweptChats()).toEqual([]);
    expect((await call(hub, "/api/sweep/resume", { method: "POST", body: { runId: "c1" } })).status).toBe(404);
  });

  test("POST /api/sweep closes the keys it is sent and refuses anything but a list of strings", async () => {
    const w = world();
    w.shells = [shell()];
    const hub = new SweepHub(w.deps);
    expect((await call(hub, "/api/sweep", { method: "POST", body: { keys: "shell:t1" } })).status).toBe(400);
    expect((await call(hub, "/api/sweep", { method: "POST", body: { keys: [1] } })).status).toBe(400);
    const got = await call(hub, "/api/sweep", { method: "POST", body: { keys: ["shell:t1"] } });
    expect(got).toEqual({ status: 200, body: { outcomes: [{ key: "shell:t1", result: "closed" }] } });
  });

  test("settings read and patch through patchSweep, with its message on a refusal", async () => {
    const w = world();
    const hub = new SweepHub(w.deps);
    expect((await call(hub, "/api/sweep/settings")).body).toEqual(DEFAULT_SWEEP);
    const bad = await call(hub, "/api/sweep/settings", { method: "POST", body: { auto: ["nope"] } });
    expect(bad.status).toBe(400);
    expect((bad.body as { error: string }).error).toContain("auto is a list of kinds");
    const ok = await call(hub, "/api/sweep/settings", { method: "POST", body: { spans: { shell: 2 * H } } });
    expect(ok.status).toBe(200);
    expect((ok.body as SweepSettings).spans.shell).toBe(2 * H);
    expect(w.settings.spans.shell).toBe(2 * H);
    expect(w.events.some((e) => e.type === "sweep")).toBe(true);
  });

  test("other paths are not the sweep's", async () => {
    const hub = new SweepHub(world().deps);
    const { request, url } = req("/api/sweeping");
    expect(await hub.handle(request, url)).toBeNull();
  });
});
