/**
 * The sweep's hub against stand-in deps: what it plans from the facts, the
 * recheck before each close, the closes themselves, one at a time, the log
 * and the event, and a swept chat resumed from its record. The swept-chat
 * records and the log are real files under a scratch config dir.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_SWEEP, normalizeSweep, type PlanInputs, type ShellFacts } from "../core/sweep";
import { addSweptChat, readAsk, readLastFire, readLog, readSweptChats, sweepDir, writeAsk, writeLastFire } from "../core/sweepstore";
import type { AgentCard, Run, ServerEvent, SweepInfo, SweepOutcome, SweepSettings, SweptChat } from "../core/types";
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
const card = (over: Partial<AgentCard> = {}): AgentCard => ({
  id: "claude:s1",
  handle: "h",
  node: "mac",
  harness: "claude",
  session: "s1",
  origin: "elsewhere",
  cwd: "/x",
  repo: null,
  branch: null,
  model: null,
  mode: null,
  state: "idle",
  waiting: null,
  caps: [],
  offers: [],
  notifyIdle: false,
  where: { os: "darwin", container: false, pid: 1, term: "kitty", canopy: null },
  transcript: null,
  startedAt: NOW - 30 * H,
  seenAt: NOW - 25 * H,
  endedAt: null,
  ...over,
});
const idleChat = (id: string): Run => run({ id, chat: true, status: "idle", session: `sess-${id}`, steps: [{ id: "1", at: NOW - 13 * H, kind: "text" }] });

interface Facts {
  shells: ShellFacts[];
  runs: Run[];
  outside: AgentCard[];
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
    outside: [],
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
        outside: w.outside.map((c) => ({ ...c })),
        prs: [],
        fixing: new Set<string>(),
        repos: [],
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
  test("a hand-broken chats or log file does not take the routes down", async () => {
    const w = world();
    w.shells = [shell()];
    await mkdir(sweepDir(), { recursive: true });
    await writeFile(join(sweepDir(), "chats.json"), "[null]");
    await writeFile(join(sweepDir(), "log.json"), JSON.stringify([{ at: 1, by: "eric", items: [] }]));
    const hub = new SweepHub(w.deps);
    const got = await call(hub, "/api/sweep");
    expect(got.status).toBe(200);
    expect((got.body as SweepInfo).lastRun).toBeNull();
    expect(await hub.close(["shell:t1"], "eric")).toEqual([{ key: "shell:t1", result: "closed" }]);
    expect((await readLog()).map((e) => e.outcomes)).toEqual([[{ key: "shell:t1", result: "closed" }]]);
  });

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

describe("the schedule", () => {
  const MIN = 60_000;
  const DAY = 24 * H;
  /** the schedule on, firing every minute */
  const on = (w: Facts, over: Partial<SweepSettings> = {}): void => {
    w.settings = { ...w.settings, on: true, cron: "* * * * *", ...over };
  };
  const scheduled = async () => (await readLog()).filter((e) => e.by === "schedule");
  const keys = (items: { key: string }[] | null | undefined): string[] | null => items?.map((i) => i.key) ?? null;
  const lastSweep = (w: Facts): SweepInfo | undefined => w.events.filter((e): e is Extract<ServerEvent, { type: "sweep" }> => e.type === "sweep").at(-1)?.sweep;

  test("off: a due cron does nothing", async () => {
    const w = world();
    w.settings.cron = "* * * * *";
    w.shells = [shell()];
    w.runs = [run({ id: "d1", endedAt: NOW - 4 * DAY })];
    await writeLastFire(NOW - 2 * DAY);
    const hub = new SweepHub(w.deps);
    await hub.tick(NOW);
    expect(w.calls.endShell).toEqual([]);
    expect(w.calls.dismiss).toEqual([]);
    expect(await readLog()).toEqual([]);
    expect(await readAsk()).toBeNull();
    expect(await readLastFire()).toBe(NOW - 2 * DAY);
    expect(w.events).toEqual([]);
  });

  test("a fire closes the auto kinds; with the default kinds the ask is empty and a busy shell stays for the sheet", async () => {
    const w = world();
    on(w);
    // an idle shell, one running vim (offered unticked), an idle Claude
    // chat, a finished run and an agent canopy did not start
    w.shells = [shell({ id: "t1" }), shell({ id: "t2", command: "vim" })];
    w.runs = [idleChat("c1"), run({ id: "d1", endedAt: NOW - 4 * DAY })];
    w.outside = [card()];
    await writeLastFire(NOW - 2 * MIN);
    const hub = new SweepHub(w.deps);
    await hub.tick(NOW);
    expect(w.calls.endShell).toEqual(["t1"]);
    expect(w.calls.stopChat).toEqual(["c1"]);
    expect(w.calls.dismiss).toEqual(["d1"]);
    // the busy shell is in neither the close nor the ask, and nor is the outside agent
    expect(await readAsk()).toBeNull();
    const log = await scheduled();
    expect(log).toHaveLength(1);
    expect(log[0]?.outcomes).toEqual([
      { key: "shell:t1", result: "closed" },
      { key: "chat:c1", result: "closed" },
      { key: "run:d1", result: "closed" },
    ]);
    expect(await readLastFire()).toBe(NOW);
    expect(lastSweep(w)?.ask).toBeNull();
    const info = await hub.info();
    expect(info.ask).toBeNull();
    // it stays in the sheet, where a tick closes it
    expect(keys(info.items)).toEqual(["shell:t2", "outside:claude:s1"]);
    expect(await call(hub, "/api/sweep", { method: "POST", body: { keys: ["shell:t2"] } })).toEqual({ status: 200, body: { outcomes: [{ key: "shell:t2", result: "closed" }] } });
  });

  test("a kind left out of auto goes to the ask, not the close", async () => {
    const w = world();
    on(w, { auto: ["shell"] });
    w.shells = [shell({ id: "t1" })];
    w.runs = [idleChat("c1"), run({ id: "d1", endedAt: NOW - 4 * DAY })];
    await writeLastFire(NOW - 2 * MIN);
    await new SweepHub(w.deps).tick(NOW);
    expect(w.calls.endShell).toEqual(["t1"]);
    expect(w.calls.stopChat).toEqual([]);
    expect(w.calls.dismiss).toEqual([]);
    expect(keys(await readAsk())).toEqual(["chat:c1", "run:d1"]);
  });

  test("a shell that starts a program after the fire's plan is left running", async () => {
    const w = world();
    on(w);
    w.shells = [shell({ id: "t1" })];
    // the fire planned from a quiet shell; by the recheck vim is up in it
    w.afterFacts = () => {
      w.afterFacts = null;
      const sh = w.shells.find((s) => s.id === "t1");
      if (sh) sh.command = "vim";
    };
    await writeLastFire(NOW - 2 * MIN);
    await new SweepHub(w.deps).tick(NOW);
    expect(w.calls.endShell).toEqual([]);
    expect((await scheduled())[0]?.outcomes).toEqual([{ key: "shell:t1", result: "in use now" }]);
  });

  test("a newer fire replaces an unanswered ask", async () => {
    const w = world();
    on(w, { auto: ["shell"] });
    w.runs = [run({ id: "d1", endedAt: NOW - 4 * DAY })];
    await writeLastFire(NOW - 2 * MIN);
    const hub = new SweepHub(w.deps);
    await hub.tick(NOW);
    expect(keys(await readAsk())).toEqual(["run:d1"]);
    w.runs = [run({ id: "d2", endedAt: NOW - 4 * DAY })];
    await hub.tick(NOW + 2 * MIN);
    expect(keys(await readAsk())).toEqual(["run:d2"]);
    expect(await scheduled()).toHaveLength(2);
  });

  test("a busy shell is never in the ask, whatever kinds close on their own", async () => {
    const w = world();
    on(w, { auto: [] });
    w.shells = [shell({ id: "t1" }), shell({ id: "t2", command: "vim" })];
    await writeLastFire(NOW - 2 * MIN);
    const hub = new SweepHub(w.deps);
    await hub.tick(NOW);
    expect(keys(await readAsk())).toEqual(["shell:t1"]);
    expect(w.calls.endShell).toEqual([]);
  });

  test("a fire that finds nothing writes a log line and no ask", async () => {
    const w = world();
    on(w);
    await writeAsk([{ key: "shell:old", kind: "shell", id: "old", repoId: "app", where: "app", title: "shell", idleSince: 1, why: "w", closable: true, checked: false, handOnly: false, auto: false }]);
    await writeLastFire(NOW - 2 * MIN);
    const hub = new SweepHub(w.deps);
    await hub.tick(NOW);
    expect(await scheduled()).toEqual([{ at: NOW, by: "schedule", outcomes: [], items: [] }]);
    expect(await readAsk()).toBeNull();
    expect(lastSweep(w)?.ask).toBeNull();
  });

  test("a Mac asleep through a slot fires once on waking, with the sleep counted as idle", async () => {
    const w = world();
    on(w, { cron: "0 4 * * *" });
    let clock = NOW;
    w.deps.now = () => clock;
    // a live server: the shell went quiet an hour before the lid closed
    w.shells = [shell({ id: "t1", lastOutput: NOW - H })];
    await writeLastFire(NOW);
    const hub = new SweepHub(w.deps);
    await hub.start();
    hub.stop();
    expect(await scheduled()).toEqual([]);
    // asleep for 30 hours, past at least one 4 am slot; the first tick on waking fires
    clock = NOW + 30 * H;
    await hub.tick(clock);
    expect(w.calls.endShell).toEqual(["t1"]);
    expect(await scheduled()).toHaveLength(1);
    expect(await readLastFire()).toBe(clock);
    // the slots slept through fire once, not once each
    clock += MIN;
    await hub.tick(clock);
    expect(await scheduled()).toHaveLength(1);
  });

  test("start arms the minute timer before its catch-up, and a stop during the catch-up leaves none", async () => {
    const w = world();
    on(w);
    let release = (): void => {};
    const held = new Promise<void>((r) => {
      release = r;
    });
    const load = w.deps.loadSettings;
    w.deps.loadSettings = async () => {
      await held;
      return load ? load() : w.settings;
    };
    w.deps.timer = true;
    const hub = new SweepHub(w.deps);
    const started = hub.start();
    await Bun.sleep(5);
    // a catch-up that hangs (tmux not answering) does not keep the schedule off
    expect(hub.armed).toBe(true);
    hub.stop();
    release();
    await started;
    expect(hub.armed).toBe(false);
  });

  test("a fire stops closing once the schedule is switched off mid-fire; the keys left get no outcome", async () => {
    const w = world();
    on(w);
    w.shells = [shell({ id: "t1" }), shell({ id: "t2" })];
    w.runs = [run({ id: "d1", endedAt: NOW - 4 * DAY })];
    const end = w.deps.endShell;
    w.deps.endShell = async (id, seen) => {
      // Eric switches the schedule off while the first shell is being kept
      w.settings = { ...w.settings, on: false };
      return end(id, seen);
    };
    await writeLastFire(NOW - 2 * MIN);
    await new SweepHub(w.deps).tick(NOW);
    expect(w.calls.endShell).toEqual(["t1"]);
    expect(w.calls.dismiss).toEqual([]);
    expect((await scheduled())[0]?.outcomes).toEqual([{ key: "shell:t1", result: "closed" }]);
    expect(await readAsk()).toBeNull();
  });

  test("a kind taken out of auto mid-fire is not closed; it goes to the ask", async () => {
    const w = world();
    on(w);
    w.shells = [shell({ id: "t1" })];
    w.runs = [run({ id: "d1", endedAt: NOW - 4 * DAY })];
    const end = w.deps.endShell;
    w.deps.endShell = async (id, seen) => {
      w.settings = { ...w.settings, auto: ["shell", "chat"] };
      return end(id, seen);
    };
    await writeLastFire(NOW - 2 * MIN);
    await new SweepHub(w.deps).tick(NOW);
    expect(w.calls.endShell).toEqual(["t1"]);
    expect(w.calls.dismiss).toEqual([]);
    expect((await scheduled())[0]?.outcomes).toEqual([{ key: "shell:t1", result: "closed" }]);
    expect(keys(await readAsk())).toEqual(["run:d1"]);
  });

  test("a fire while tmux does not answer keeps the ask's shells", async () => {
    const w = world();
    on(w, { auto: [] });
    w.shells = [shell({ id: "t1" })];
    await writeLastFire(NOW - 2 * MIN);
    const hub = new SweepHub(w.deps);
    await hub.tick(NOW);
    expect(keys(await readAsk())).toEqual(["shell:t1"]);
    w.tmuxDown = true;
    w.runs = [run({ id: "d1", endedAt: NOW - 4 * DAY })];
    await hub.tick(NOW + 2 * MIN);
    expect(keys(await readAsk())).toEqual(["shell:t1", "run:d1"]);
    // and a close while it is down does not prune them either
    await hub.close(["run:d1"], "eric");
    expect(keys(await readAsk())).toEqual(["shell:t1"]);
  });

  test("a fire whose ask cannot be written still sends the event for its closes", async () => {
    const w = world();
    on(w, { auto: ["shell"] });
    w.shells = [shell({ id: "t1" })];
    w.runs = [run({ id: "d1", endedAt: NOW - 4 * DAY })];
    // a directory where the ask file goes: its write fails
    await mkdir(join(sweepDir(), "ask.json"), { recursive: true });
    await writeLastFire(NOW - 2 * MIN);
    const said = console.error;
    console.error = () => {};
    try {
      await new SweepHub(w.deps).tick(NOW);
    } finally {
      console.error = said;
    }
    expect(w.calls.endShell).toEqual(["t1"]);
    expect(keys(lastSweep(w)?.items)).toEqual(["run:d1"]);
  });

  test("switching the schedule off clears the ask", async () => {
    const w = world();
    on(w, { auto: ["shell"] });
    w.runs = [run({ id: "d1", endedAt: NOW - 4 * DAY })];
    await writeLastFire(NOW - 2 * MIN);
    const hub = new SweepHub(w.deps);
    await hub.tick(NOW);
    expect(keys(await readAsk())).toEqual(["run:d1"]);
    await hub.patch({ cron: "0 5 * * *" });
    expect(keys(await readAsk())).toEqual(["run:d1"]);
    await hub.patch({ on: false });
    expect(await readAsk()).toBeNull();
    expect(lastSweep(w)?.ask).toBeNull();
  });

  test("an ask stored while the schedule is off is not shown", async () => {
    const w = world();
    on(w, { auto: ["shell"] });
    w.runs = [run({ id: "d1", endedAt: NOW - 4 * DAY })];
    await writeLastFire(NOW - 2 * MIN);
    const hub = new SweepHub(w.deps);
    await hub.tick(NOW);
    // a fire that finished as the switch-off landed wrote its ask after it
    w.settings = { ...w.settings, on: false };
    expect(keys(await readAsk())).toEqual(["run:d1"]);
    expect((await hub.info()).ask).toBeNull();
  });

  test("a close from the sheet drops what it closed from the ask, and the ask once none is left", async () => {
    const w = world();
    on(w, { auto: ["shell"] });
    w.runs = [run({ id: "d1", endedAt: NOW - 4 * DAY }), run({ id: "d2", endedAt: NOW - 4 * DAY })];
    await writeLastFire(NOW - 2 * MIN);
    const hub = new SweepHub(w.deps);
    await hub.tick(NOW);
    expect(keys(await readAsk())).toEqual(["run:d1", "run:d2"]);
    await hub.close(["run:d1"], "eric");
    expect(keys(await readAsk())).toEqual(["run:d2"]);
    await hub.close(["run:d2"], "eric");
    expect(await readAsk()).toBeNull();
    // a run by the same id back later is not in an ask Eric thought was gone
    w.runs = [run({ id: "d1", endedAt: NOW - 4 * DAY })];
    expect((await hub.info()).ask).toBeNull();
  });

  test("a catch-up that throws at start is logged, not thrown, and the next tick still fires", async () => {
    const w = world();
    on(w);
    w.runs = [run({ id: "d1", endedAt: NOW - 4 * DAY })];
    await writeLastFire(NOW - 2 * MIN);
    const load = w.deps.loadSettings;
    let calls = 0;
    w.deps.loadSettings = async () => {
      if (++calls === 1) throw new Error("config unreadable");
      return load ? load() : w.settings;
    };
    const hub = new SweepHub(w.deps);
    const said = console.error;
    console.error = () => {};
    try {
      await hub.start();
    } finally {
      console.error = said;
      hub.stop();
    }
    expect(w.calls.dismiss).toEqual([]);
    await hub.tick(NOW);
    expect(w.calls.dismiss).toEqual(["d1"]);
  });

  test("a bad cron in config never fires", async () => {
    const w = world();
    w.shells = [shell()];
    await writeLastFire(NOW - 2 * DAY);
    const hub = new SweepHub(w.deps);
    // as the config reads it: a cron that does not parse turns the schedule off
    w.settings = normalizeSweep({ on: true, cron: "61 * * * *" });
    expect(w.settings.on).toBe(false);
    await hub.tick(NOW);
    // and one that reaches the hub on anyway
    w.settings = { ...w.settings, on: true, cron: "61 * * * *" };
    await hub.tick(NOW);
    w.settings = { ...w.settings, cron: "0 0 31 2 *" };
    await hub.tick(NOW);
    expect(w.calls.endShell).toEqual([]);
    expect(await readLog()).toEqual([]);
    expect(await readLastFire()).toBe(NOW - 2 * DAY);
  });

  test("answering the ask closes those keys after a recheck", async () => {
    const w = world();
    on(w, { auto: ["run"] });
    w.shells = [shell({ id: "t1" }), shell({ id: "t2" })];
    w.runs = [idleChat("c1")];
    await writeLastFire(NOW - 2 * MIN);
    const hub = new SweepHub(w.deps);
    await hub.tick(NOW);
    expect(keys(await readAsk())).toEqual(["shell:t1", "shell:t2", "chat:c1"]);
    // Eric is back at t2 before he answers
    const t2 = w.shells.find((s) => s.id === "t2");
    if (t2) t2.lastInput = NOW - 1_000;
    const got = await call(hub, "/api/sweep/ask", { method: "POST", body: { keys: ["shell:t2", "chat:c1"] } });
    expect(got.status).toBe(200);
    expect((got.body as { outcomes: SweepOutcome[] }).outcomes).toEqual([
      { key: "shell:t2", result: "in use now" },
      { key: "chat:c1", result: "closed" },
    ]);
    expect(w.calls.endShell).toEqual([]);
    expect(w.calls.stopChat).toEqual(["c1"]);
    expect(await readAsk()).toBeNull();
    expect((await hub.info()).ask).toBeNull();
    expect(lastSweep(w)?.ask).toBeNull();
    expect((await readLog()).at(-1)?.by).toBe("eric");
  });

  test("a shell in the ask that starts vim after the fire drops out of the ask shown, and an answer naming it does not close it", async () => {
    const w = world();
    on(w, { auto: ["chat"] });
    w.shells = [shell({ id: "t1" })];
    await writeLastFire(NOW - 2 * MIN);
    const hub = new SweepHub(w.deps);
    await hub.tick(NOW);
    expect((await readAsk())?.map((i) => [i.key, i.handOnly])).toEqual([["shell:t1", false]]);
    // Eric starts vim in it before he answers
    const t1 = w.shells.find((s) => s.id === "t1");
    if (t1) t1.command = "vim";
    const info = await hub.info();
    // a busy shell stays out of the ask; the sheet still has it
    expect(info.ask).toBeNull();
    expect(info.items.find((i) => i.key === "shell:t1")).toMatchObject({ checked: false, handOnly: true, auto: false });
    // the stored key is kept: once vim exits and the shell is idle again, it is back in the ask
    expect(keys(await readAsk())).toEqual(["shell:t1"]);
    const got = await call(hub, "/api/sweep/ask", { method: "POST", body: { keys: ["shell:t1"] } });
    expect((got.body as { outcomes: SweepOutcome[] }).outcomes).toEqual([{ key: "shell:t1", result: "in use now" }]);
    expect(w.calls.endShell).toEqual([]);
    expect(w.shells.map((s) => s.id)).toEqual(["t1"]);
  });

  test("turning the schedule off while a fire waits behind a slow close: that fire closes nothing", async () => {
    const w = world();
    on(w);
    w.shells = [shell({ id: "t0" })];
    w.runs = [run({ id: "d1", endedAt: NOW - 4 * DAY })];
    let release = (): void => {};
    const held = new Promise<void>((r) => {
      release = r;
    });
    w.deps.endShell = async (id) => {
      w.calls.endShell.push(id);
      await held;
      w.shells = w.shells.filter((s) => s.id !== id);
      return "closed";
    };
    await writeLastFire(NOW - 2 * MIN);
    const hub = new SweepHub(w.deps);
    const slow = hub.close(["shell:t0"], "eric");
    while (w.calls.endShell.length === 0) await Bun.sleep(1);
    const ticked = hub.tick(NOW);
    while ((await readLastFire()) !== NOW) await Bun.sleep(1);
    await Bun.sleep(10);
    w.settings = { ...w.settings, on: false };
    release();
    await Promise.all([slow, ticked]);
    expect(w.calls.dismiss).toEqual([]);
    expect(await scheduled()).toEqual([]);
    expect(await readAsk()).toBeNull();
  });

  test("a last fire a day ahead still fires at the next due time", async () => {
    const w = world();
    on(w);
    w.runs = [run({ id: "d1", endedAt: NOW - 4 * DAY })];
    await writeLastFire(NOW + DAY);
    const hub = new SweepHub(w.deps);
    await hub.tick(NOW);
    expect(w.calls.dismiss).toEqual([]);
    await hub.tick(NOW + 2 * MIN);
    expect(w.calls.dismiss).toEqual(["d1"]);
  });

  test("the ask's routes: only its own keys, a 404 with none, and a dismiss that closes nothing", async () => {
    const w = world();
    on(w, { auto: ["shell"] });
    w.shells = [shell({ id: "t1" })];
    w.runs = [run({ id: "d1", endedAt: NOW - 4 * DAY })];
    const hub = new SweepHub(w.deps);
    expect((await call(hub, "/api/sweep/ask", { method: "POST", body: { keys: ["run:d1"] } })).status).toBe(404);
    await writeLastFire(NOW - 2 * MIN);
    await hub.tick(NOW);
    expect((await call(hub, "/api/sweep/ask", { method: "POST", body: { keys: "run:d1" } })).status).toBe(400);
    // t1 was the fire's to close, not the ask's
    expect((await call(hub, "/api/sweep/ask", { method: "POST", body: { keys: ["shell:t1"] } })).status).toBe(400);
    const gone = await call(hub, "/api/sweep/ask", { method: "DELETE" });
    expect(gone.status).toBe(200);
    expect(await readAsk()).toBeNull();
    expect(lastSweep(w)?.ask).toBeNull();
    expect(w.calls.endShell).toEqual(["t1"]);
    expect(w.calls.dismiss).toEqual([]);
    expect(w.runs.map((r) => r.id)).toEqual(["d1"]);
  });

  test("turning the schedule on counts from then, not from an old fire", async () => {
    const w = world();
    w.settings.cron = "* * * * *";
    w.runs = [run({ id: "d1", endedAt: NOW - 4 * DAY })];
    await writeLastFire(NOW - 2 * DAY);
    const hub = new SweepHub(w.deps);
    await hub.patch({ on: true });
    expect(await readLastFire()).toBe(NOW);
    await hub.tick(NOW);
    expect(w.calls.dismiss).toEqual([]);
    // the next minute is due
    await hub.tick(NOW + 2 * MIN);
    expect(w.calls.dismiss).toEqual(["d1"]);
  });

  test("with no fire on record the first tick only starts the count", async () => {
    const w = world();
    on(w);
    w.runs = [run({ id: "d1", endedAt: NOW - 4 * DAY })];
    const hub = new SweepHub(w.deps);
    await hub.tick(NOW);
    expect(w.calls.dismiss).toEqual([]);
    expect(await readLastFire()).toBe(NOW);
  });
});
