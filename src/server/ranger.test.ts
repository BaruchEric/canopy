/**
 * The ranger's hub on its own, over a stand-in tmux and a scratch config
 * dir: starting and resuming its conversation, deaths and giving up, a
 * canopy restart adopting the live session, turning it off, a fresh
 * conversation, the handle on another backend, the trust dialog, wakes,
 * and the routes.
 */
import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RANGER_DEFAULTS } from "../core/ranger";
import { projectFolder } from "../core/sessions";
import type { RangerPane } from "../core/tmux";
import { DEFAULT_AGENT, type AgentCard, type AgentSettings, type RangerInfo, type RangerSettings, type RangerWake, type ServerEvent, type TermInfo } from "../core/types";
import { RangerHub, rangerTermId, type RangerHubDeps, type RangerRun, type RangerTimings, type RangerTmux } from "./ranger";

setDefaultTimeout(20_000);

const TIMINGS: Partial<RangerTimings> = { tick: 20, wakeEvery: 30, freshEvery: 3_600_000, backoff: 20, backoffCap: 40, giveUp: 3, uptime: 60_000, noServerGrace: 200, quiet: 0, recheck: 50 };
const ROOT = "/home/eric/dev";
const BACKEND = "mini";
const TERM = rangerTermId(BACKEND);

class FakeTmux implements RangerTmux {
  panes = new Map<string, RangerPane>();
  starts: { command: string[]; env: Record<string, string> }[] = [];
  kills = 0;
  screen = "";
  answering = true;
  reads = 0;
  /** when set, a start waits for it, so a test can catch a launch in flight */
  gate: Promise<void> | null = null;
  async list(): Promise<RangerPane[] | "no-server" | null> {
    if (!this.answering) return null;
    return [...this.panes.values()].map((p) => ({ ...p }));
  }
  async start(id: string, _root: string, command: string[], env: Record<string, string>): Promise<void> {
    this.starts.push({ command, env });
    if (this.gate) await this.gate;
    this.panes.set(id, { termId: id, dead: false, code: null, createdAt: Date.now(), activityAt: Date.now() });
  }
  async kill(id: string): Promise<void> {
    this.kills += 1;
    this.panes.delete(id);
  }
  async text(): Promise<string | null> {
    this.reads += 1;
    return this.screen;
  }
  die(code: number | null = 1): void {
    const p = this.panes.get(TERM);
    if (p) this.panes.set(TERM, { ...p, dead: true, code });
  }
  /** the shell line of the n-th start */
  line(n = -1): string {
    const s = this.starts.at(n);
    return s?.command[2] ?? "";
  }
}

let scratch = "";
let hubs: RangerHub[] = [];
let fake: FakeTmux;
let saved: RangerSettings;
let cards: AgentCard[];
let runs: Map<string, RangerRun>;
let sent: { handle: string; text: string }[];
let gaveUp: string[];
let held: TermInfo[];
let dropped: string[];
let events: RangerInfo[];
let broker: boolean;
let agent: AgentSettings;

const home = () => join(scratch, "claude");
const dir = () => join(scratch, "config", "ranger");
const own = () => join(dir(), "home");
const transcriptOf = (session: string, folder = own()) => join(home(), "projects", projectFolder(folder), `${session}.jsonl`);

async function until(pred: () => boolean | Promise<boolean>, what: string, ms = 5_000): Promise<void> {
  const start = Date.now();
  while (!(await pred())) {
    if (Date.now() - start > ms) throw new Error(`gave up waiting for ${what}`);
    await Bun.sleep(10);
  }
}

function hub(over: Partial<RangerHubDeps> = {}): RangerHub {
  const h = new RangerHub({
    tmux: fake,
    root: ROOT,
    backend: () => BACKEND,
    env: (term) => ({ CANOPY_TERM: term, CANOPY_BACKEND: BACKEND, CANOPY_API: "http://127.0.0.1:7850" }),
    shell: "/bin/bash",
    hasClaude: () => true,
    settings: async () => agent,
    cards: () => cards,
    broker: () => broker,
    send: async (handle, text) => {
      sent.push({ handle, text });
    },
    gaveUp: (text) => gaveUp.push(text),
    run: (id) => runs.get(id),
    viewers: () => [],
    lastInput: () => undefined,
    hold: (info) => held.push(info),
    drop: (id) => dropped.push(id),
    broadcast: (ev: ServerEvent) => {
      if (ev.type === "ranger") events.push(ev.ranger);
    },
    dir: dir(),
    claudeHome: home(),
    brief: async () => "You are {{handle}} on {{backend}} in {{home}} over {{root}}.{{#previous}} Before: {{previous}}{{/previous}}",
    telegramContested: async () => false,
    loadSettings: async () => saved,
    saveSettings: async (s) => {
      saved = s;
    },
    timings: TIMINGS,
    ...over,
  });
  hubs.push(h);
  return h;
}

const record = async () => JSON.parse(await readFile(join(dir(), "state.json"), "utf8")) as { session: string; previous?: string; fails?: number; gaveUp?: boolean };
const sessionIn = (line: string) => /--(?:session-id|resume)' '([0-9a-f-]{36})'/.exec(line)?.[1] ?? "";

async function call(h: RangerHub, method: string, path: string, body?: unknown): Promise<{ status: number; data: unknown }> {
  const url = new URL(`http://x${path}`);
  const res = await h.handle(new Request(url.href, { method, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }), url);
  if (!res) throw new Error(`no route for ${path}`);
  return { status: res.status, data: await res.json() };
}

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), "canopy-ranger-"));
  fake = new FakeTmux();
  saved = { ...RANGER_DEFAULTS, fresh: { daily: null, maxMb: null } };
  cards = [];
  runs = new Map();
  sent = [];
  gaveUp = [];
  held = [];
  dropped = [];
  events = [];
  broker = true;
  agent = { ...DEFAULT_AGENT, model: "opus" };
  hubs = [];
});

afterEach(async () => {
  for (const h of hubs) h.stop();
  for (const h of hubs) await h.settled();
  await rm(scratch, { recursive: true, force: true });
});

describe("starting and keeping it", () => {
  test("off until turned on; then a new conversation, never yolo, under its handle", async () => {
    const h = hub();
    await h.start();
    await Bun.sleep(60);
    expect(h.info().state).toBe("off");
    expect(fake.starts).toEqual([]);

    const { status, data } = await call(h, "POST", "/api/ranger", { on: true });
    expect(status).toBe(200);
    expect((data as RangerInfo).state).toBe("running");
    expect(saved.on).toBe(true);
    expect(fake.starts).toHaveLength(1);
    const line = fake.line();
    expect(fake.starts[0]?.command.slice(0, 2)).toEqual(["/bin/bash", "-lic"]);
    expect(line).toStartWith(`cd -- '${own()}' && exec 'claude' '--model' 'opus' '--add-dir' '${ROOT}' '--name' 'ranger'`);
    expect(line).toContain("'--session-id'");
    expect(line).toContain("'--append-system-prompt-file'");
    expect(line).toContain("'[canopy] this is your first conversation.");
    expect(line).not.toContain("dangerously");
    expect(fake.starts[0]?.env).toMatchObject({ TAILCHAN_AS: "ranger", CANOPY_TERM: TERM, CANOPY_BACKEND: BACKEND, CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: "1" });
    expect(fake.starts[0]?.env["CANOPY_REPO"]).toBeUndefined();
    expect(await readFile(join(dir(), "brief.md"), "utf8")).toBe(`You are ranger on mini in ${own()} over ${ROOT}.\n`);
    expect((await record()).session).toBe(sessionIn(line));
    expect(held.at(-1)).toMatchObject({ id: TERM, ranger: true, repoId: "", path: own(), handle: "ranger" });
    expect(events.at(-1)?.state).toBe("running");
  });

  test("a death resumes the same conversation after the backoff, whatever the exit code", async () => {
    saved.on = true;
    const h = hub();
    await h.start();
    await until(() => fake.starts.length === 1, "the first start");
    const session = sessionIn(fake.line());
    await mkdir(join(home(), "projects", projectFolder(own())), { recursive: true });
    await writeFile(transcriptOf(session), "{}\n");
    // /exit is a clean 0 and still a restart
    fake.die(0);
    await until(() => fake.starts.length === 2, "the restart");
    expect(fake.line()).toContain(`'--resume' '${session}' '[canopy] canopy started you again`);
    await until(() => h.info().state === "running" && h.info().restarts === 1, "running again");
    expect((await record()).fails).toBe(1);
  });

  test("too many deaths in a row and it gives up, until started by hand", async () => {
    saved.on = true;
    const h = hub();
    await h.start();
    for (let i = 1; i <= 3; i++) {
      await until(() => fake.starts.length === i && fake.panes.get(TERM)?.dead === false, `start ${i}`);
      fake.die(1);
      await until(() => !!h.info().lastExit, `death ${i}`);
    }
    await until(() => h.info().state === "gave-up", "giving up");
    expect(gaveUp).toHaveLength(1);
    await Bun.sleep(100);
    expect(fake.starts).toHaveLength(3);
    expect((await record()).gaveUp).toBe(true);

    await call(h, "POST", "/api/ranger/restart");
    expect(fake.starts).toHaveLength(4);
    expect(h.info().state).toBe("running");
    expect((await record()).gaveUp).toBeUndefined();
  });

  test("a canopy restart adopts the live session instead of starting another", async () => {
    saved.on = true;
    const first = hub();
    await first.start();
    await until(() => fake.starts.length === 1, "the first start");
    first.stop();
    await first.settled();
    held = [];
    const second = hub();
    await second.start();
    await until(() => held.some((t) => t.id === TERM), "the session held again");
    await Bun.sleep(80);
    expect(fake.starts).toHaveLength(1);
    expect(second.info().state).toBe("running");
  });

  test("a gave-up on record stays given up across a canopy restart", async () => {
    saved.on = true;
    await mkdir(dir(), { recursive: true });
    await writeFile(join(dir(), "state.json"), JSON.stringify({ session: "35adf21d-777e-428a-aec9-639404e23258", fails: 3, gaveUp: true }));
    const h = hub();
    await h.start();
    await until(() => h.info().state === "gave-up", "gave-up shown");
    await Bun.sleep(60);
    expect(fake.starts).toEqual([]);
  });

  test("turning it off ends the session, which is no death", async () => {
    saved.on = true;
    const h = hub();
    await h.start();
    await until(() => fake.starts.length === 1, "the first start");
    await call(h, "POST", "/api/ranger", { on: false });
    expect(fake.kills).toBe(1);
    expect(h.info().state).toBe("off");
    expect(dropped).toContain(TERM);
    await Bun.sleep(100);
    expect(fake.starts).toHaveLength(1);
    expect((await record()).fails).toBeUndefined();
  });

  test("a profile it cannot run is refused before anything is saved", async () => {
    saved.on = true;
    const h = hub({ settings: async (profile) => (profile === "codexy" ? { ...DEFAULT_AGENT, harness: "codex" } : agent) });
    await h.start();
    await until(() => fake.starts.length === 1, "the first start");
    const { status, data } = await call(h, "POST", "/api/ranger", { profile: "codexy" });
    expect(status).toBe(400);
    expect((data as { error: string }).error).toContain("codex");
    expect(saved.profile).toBeNull();
    expect(fake.starts).toHaveLength(1);
  });

  test("a change to what it runs as restarts a running one", async () => {
    saved.on = true;
    const h = hub();
    await h.start();
    await until(() => fake.starts.length === 1, "the first start");
    await call(h, "POST", "/api/ranger", { handle: "ranger-mini" });
    expect(fake.starts).toHaveLength(2);
    expect(fake.starts[1]?.env["TAILCHAN_AS"]).toBe("ranger-mini");
    await call(h, "POST", "/api/ranger", { fresh: { daily: "05:00" } });
    expect(fake.starts).toHaveLength(2);
  });

  test("a fresh conversation gets a new id and points back at the old one", async () => {
    saved.on = true;
    const h = hub();
    await h.start();
    await until(() => fake.starts.length === 1, "the first start");
    const old = sessionIn(fake.line());
    await mkdir(join(home(), "projects", projectFolder(own())), { recursive: true });
    await writeFile(transcriptOf(old), "{}\n");
    await call(h, "POST", "/api/ranger/fresh");
    expect(fake.starts).toHaveLength(2);
    const now = sessionIn(fake.line());
    expect(now).not.toBe(old);
    expect(fake.line()).toContain("'--session-id'");
    expect(fake.line()).toContain("fresh conversation; your brief names the last one");
    expect((await record()).previous).toBe(transcriptOf(old));
    expect(await readFile(join(dir(), "brief.md"), "utf8")).toContain(`Before: ${transcriptOf(old)}`);
  });
});

describe("its folder", () => {
  test("the scan root itself: no --add-dir, and moving there starts a new conversation", async () => {
    saved.on = true;
    const h = hub();
    await h.start();
    await until(() => fake.starts.length === 1, "the first start");
    const first = sessionIn(fake.line());
    expect(h.info().home).toBe(own());
    await call(h, "POST", "/api/ranger", { home: "root" });
    expect(fake.starts).toHaveLength(2);
    expect(fake.line()).toStartWith(`cd -- '${ROOT}' && exec 'claude' '--model' 'opus' '--name'`);
    expect(fake.line()).not.toContain("--add-dir");
    expect(fake.starts[1]?.env["CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD"]).toBeUndefined();
    expect(sessionIn(fake.line())).not.toBe(first);
    expect(h.info().home).toBe(ROOT);
  });

  test("the trust prompt says what trusting the scan root means", async () => {
    fake.screen = "   Yes, I trust this folder\n";
    saved = { ...saved, on: true, home: "root" };
    const h = hub();
    await h.start();
    await until(() => h.info().state === "trust", "trust");
    expect(h.info().why).toContain("also trusts every folder under it");
  });
});

describe("what the review found", () => {
  test("a handle live on another backend is refused before it is saved", async () => {
    saved.on = true;
    const h = hub();
    await h.start();
    await until(() => fake.starts.length === 1, "the first start");
    cards = [{ id: "claude:o", handle: "ops", session: "22222222-2222-2222-2222-222222222222", state: "idle", where: { canopy: { backend: "mac" } } } as unknown as AgentCard];
    const { status } = await call(h, "POST", "/api/ranger", { handle: "ops" });
    expect(status).toBe(409);
    expect(saved.handle).toBeNull();
    expect(fake.starts).toHaveLength(1);
  });

  test("a restart refused while the old session runs says so, and goes through once it can", async () => {
    saved.on = true;
    let claude = true;
    const h = hub({ hasClaude: () => claude });
    await h.start();
    await until(() => fake.starts.length === 1, "the first start");
    claude = false;
    await call(h, "POST", "/api/ranger/restart");
    // ticks keep finding it running, and the refusal still stands over that
    await Bun.sleep(60);
    expect(h.info().state).toBe("no-claude");
    expect(h.info().why).toContain("still runs as before");
    claude = true;
    await until(() => fake.starts.length === 2, "the restart once claude is back");
    await until(() => h.info().state === "running", "running");
    expect(h.info().why).toBeUndefined();
  });

  test("a fresh start asked for during another launch runs after it", async () => {
    let open = () => {};
    fake.gate = new Promise((r) => (open = r));
    const h = hub();
    await h.start();
    const on = call(h, "POST", "/api/ranger", { on: true });
    await until(() => fake.starts.length === 1, "the first start in flight");
    const fresh = call(h, "POST", "/api/ranger/fresh");
    fake.gate = null;
    open();
    await on;
    expect((await fresh).status).toBe(200);
    expect(fake.starts).toHaveLength(2);
    expect(sessionIn(fake.line(1))).not.toBe(sessionIn(fake.line(0)));
  });

  test("two settings changes in flight both land", async () => {
    const h = hub();
    await h.start();
    await Promise.all([call(h, "POST", "/api/ranger", { telegram: true }), call(h, "POST", "/api/ranger", { fresh: { daily: "05:30" } })]);
    expect(saved.telegram).toBe(true);
    expect(saved.fresh.daily).toBe("05:30");
  });

  test("a record from before its own folder ran in the scan root, so it starts a new conversation", async () => {
    const old = "35adf21d-777e-428a-aec9-639404e23258";
    await mkdir(dir(), { recursive: true });
    await writeFile(join(dir(), "state.json"), JSON.stringify({ session: old, sessionAt: 1 }));
    await mkdir(join(home(), "projects", projectFolder(ROOT)), { recursive: true });
    await writeFile(transcriptOf(old, ROOT), "{}\n");
    saved.on = true;
    const h = hub();
    await h.start();
    await until(() => fake.starts.length === 1, "the first start");
    expect(sessionIn(fake.line())).not.toBe(old);
    expect((await record()).previous).toBe(transcriptOf(old, ROOT));
  });

  test("the pane is read for the trust dialog only for a while after a start", async () => {
    saved.on = true;
    const h = hub({ timings: { ...TIMINGS, trustWindow: 0 } });
    await h.start();
    await until(() => fake.starts.length === 1, "the first start");
    await Bun.sleep(80);
    expect(fake.reads).toBe(0);
  });
});

describe("why it does not start", () => {
  const card = (over: Partial<AgentCard>): AgentCard => ({
    id: "claude:x",
    handle: "ranger",
    node: "macbook",
    harness: "claude",
    session: "11111111-1111-1111-1111-111111111111",
    origin: "canopy-shell",
    cwd: "/Users/x/dev",
    repo: null,
    branch: null,
    model: null,
    mode: null,
    state: "idle",
    waiting: null,
    caps: [],
    offers: [],
    notifyIdle: false,
    where: { os: "darwin", container: false, pid: 1, term: null, canopy: { backend: "mac", term: "x" } },
    transcript: null,
    startedAt: 0,
    seenAt: 0,
    endedAt: null,
    ...over,
  });

  test("its handle live on another backend", async () => {
    cards = [card({})];
    saved.on = true;
    const h = hub();
    await h.start();
    await until(() => h.info().state === "handle-taken", "handle-taken");
    expect(h.info().why).toContain("mac");
    expect(fake.starts).toEqual([]);
    // the same handle on this backend, or one that ended, is no clash
    cards = [card({ where: { ...card({}).where, canopy: { backend: BACKEND } } }), card({ state: "ended" })];
    await until(() => fake.starts.length === 1, "a start once the clash is gone");
  });

  test("a codex profile, no claude, no tmux", async () => {
    saved.on = true;
    agent = { ...DEFAULT_AGENT, harness: "codex" };
    const codex = hub();
    await codex.start();
    await until(() => codex.info().state === "error", "the codex refusal");
    expect(codex.info().why).toContain("codex");
    codex.stop();

    agent = DEFAULT_AGENT;
    const none = hub({ hasClaude: () => false });
    await none.start();
    await until(() => none.info().state === "no-claude", "no claude");
    none.stop();

    const bare = hub({ tmux: null });
    await bare.start();
    expect(bare.info().state).toBe("no-tmux");
    saved.on = false;
    expect((await call(bare, "POST", "/api/ranger", { on: true })).status).toBe(503);
    expect(fake.starts).toEqual([]);
  });

  test("Claude's trust dialog waits for someone to accept the folder", async () => {
    fake.screen = " ❯ No, exit\n   Yes, I trust this folder\n";
    saved.on = true;
    const h = hub();
    await h.start();
    await until(() => h.info().state === "trust", "trust");
    fake.screen = "❯ ";
    await until(() => h.info().state === "running", "running once accepted");
  });
});

describe("wakes", () => {
  test("a due wake is DM'd under its tag and goes; a refused one never lands", async () => {
    saved.on = true;
    const h = hub();
    await h.start();
    await until(() => h.info().state === "running", "running");
    expect((await call(h, "POST", "/api/ranger/wakes", { prompt: "x" })).status).toBe(400);
    expect((await call(h, "POST", "/api/ranger/wakes", { prompt: "x", run: "nope" })).status).toBe(404);
    const { status, data } = await call(h, "POST", "/api/ranger/wakes", { prompt: "check the deploy", at: Date.now() + 40 });
    expect(status).toBe(201);
    const w = data as RangerWake;
    expect(w.by).toBe("ranger");
    await until(() => sent.length === 1, "the wake delivered");
    expect(sent[0]).toEqual({ handle: "ranger", text: `[wake ${w.id}] check the deploy` });
    await until(() => h.info().wakes.length === 0, "the wake gone");
  });

  test("a cron wake due while it was down fires once and goes on", async () => {
    await mkdir(dir(), { recursive: true });
    const past = Date.now() - 3 * 86_400_000;
    await writeFile(join(dir(), "wakes.json"), JSON.stringify([{ id: "0000000a", by: "eric", prompt: "morning", created: past, cron: "0 8 * * *", next: past }]));
    saved.on = true;
    const h = hub();
    await h.start();
    await until(() => sent.length === 1, "the cron delivered");
    expect(sent[0]?.text).toBe("[cron 0000000a] morning");
    const [w] = h.info().wakes;
    expect(w?.next).toBeGreaterThan(Date.now());
    await Bun.sleep(100);
    expect(sent).toHaveLength(1);
  });

  test("a run wake fires when the run ends; nothing goes while there is no broker", async () => {
    broker = false;
    saved.on = true;
    runs.set("r1", { status: "working", repo: "canopy", active: true });
    const h = hub();
    await h.start();
    await until(() => h.info().state === "running", "running");
    await call(h, "POST", "/api/ranger/wakes", { prompt: "read the result", run: "r1" });
    runs.set("r1", { status: "done", repo: "canopy", active: false });
    h.onRun("r1", false);
    await Bun.sleep(100);
    expect(sent).toEqual([]);
    broker = true;
    await until(() => sent.length === 1, "the run wake delivered");
    expect(sent[0]?.text).toContain("run r1 in canopy ended done. read the result");
    expect(h.info().wakes).toEqual([]);
  });

  test("removing one, and an unknown one", async () => {
    const h = hub();
    await h.start();
    const { data } = await call(h, "POST", "/api/ranger/wakes", { prompt: "later", when: "in 2h", by: "eric" });
    const w = data as RangerWake;
    expect(w.by).toBe("eric");
    expect((await call(h, "DELETE", `/api/ranger/wakes?id=${w.id}`)).status).toBe(200);
    expect(h.info().wakes).toEqual([]);
    expect((await call(h, "DELETE", "/api/ranger/wakes?id=00000000")).status).toBe(404);
    expect(JSON.parse(await readFile(join(dir(), "wakes.json"), "utf8"))).toEqual([]);
  });
});

describe("routes", () => {
  test("refusals", async () => {
    const h = hub();
    await h.start();
    expect((await call(h, "POST", "/api/ranger", { on: "yes" })).status).toBe(400);
    expect((await call(h, "POST", "/api/ranger/restart")).status).toBe(409);
    expect((await call(h, "POST", "/api/ranger/fresh")).status).toBe(409);
    expect((await call(h, "GET", "/api/ranger/nope")).status).toBe(404);
    const url = new URL("http://x/api/rangers");
    expect(await h.handle(new Request(url.href), url)).toBeNull();
    expect(h.knows(TERM)).toBe(true);
    expect(h.knows("0".repeat(32))).toBe(false);
  });
});
