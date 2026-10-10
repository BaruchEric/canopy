/**
 * The ranger's hub (docs/superpowers/specs/2026-10-10-ranger-design.md):
 * canopy's always-on agent, one interactive Claude Code session on canopy's
 * tmux, kept alive the way a keep task is. The session sits in the shells
 * container, so a canopy redeploy never touches it; this hub only watches
 * it. When claude exits, for any reason and with any code, it starts again
 * on the same conversation after a backoff, and gives up after too many
 * quick deaths in a row. The conversation's id is canopy's (`--session-id`
 * the first time, `--resume` after), kept in `ranger/state.json`, and a
 * fresh one is minted by hand, daily, or once the transcript grows past its
 * size. The hub also delivers the ranger's wakes (`ranger/wakes.json`): a
 * prompt DM'd from canopy's bot at a time, on a cron line, or when a run
 * ends, which tailchan's Stop hook turns into a turn.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { exec } from "../core/exec";
import { shellQuote } from "../core/host";
import {
  cronAfter,
  freshDue,
  isQuiet,
  parseWake,
  patchRanger,
  RANGER_DEFAULTS,
  RANGER_QUIET,
  rangerArgv,
  rangerBrief,
  rangerHandle,
  rangerHello,
  readWake,
  TELEGRAM_PLUGIN,
  TRUST_RE,
  wakeLine,
  WAKES_MAX,
} from "../core/ranger";
import { claudeHome, projectFolder } from "../core/sessions";
import { configDir, loadConfig, setRanger } from "../core/store";
import { nextDelay, paneReading } from "../core/tasks";
import { killSession, noServer, parseRangerPanes, rangerPanesArgs, rangerSessionArgs, respawnArgs, textArgs, hasSession, type RangerPane } from "../core/tmux";
import { isLiveAgent, type AgentCard, type AgentSettings, type RangerInfo, type RangerSettings, type RangerState, type RangerWake, type ServerEvent, type TermInfo } from "../core/types";

/** the brief bundled with canopy; `<config dir>/ranger.md` replaces it */
export const BUNDLED_BRIEF = join(import.meta.dir, "../../lib/ranger.md");

export interface RangerTimings {
  /** how often tmux is looked at */
  tick: number;
  /** how often due wakes are delivered */
  wakeEvery: number;
  /** how often a fresh conversation is checked for */
  freshEvery: number;
  backoff: number;
  backoffCap: number;
  /** deaths in a row before it gives up */
  giveUp: number;
  /** how long up counts as a good stretch, which forgets the deaths */
  uptime: number;
  /** how long "no server" right after a live pane is doubted */
  noServerGrace: number;
  /** how long the pane must be still before a fresh start */
  quiet: number;
  /** how long a start refused for a reason that is not a death (another
   *  backend has the handle, no claude, a codex profile) waits to try again */
  recheck: number;
  /** how long after a start the pane is read for Claude's trust dialog
   *  while no card has come (it is read for as long as the dialog shows) */
  trustWindow: number;
}

export const RANGER_TIMINGS: RangerTimings = {
  tick: 2000,
  wakeEvery: 15_000,
  freshEvery: 5 * 60_000,
  backoff: 1000,
  backoffCap: 60_000,
  giveUp: 5,
  uptime: 5 * 60_000,
  noServerGrace: 30_000,
  quiet: RANGER_QUIET,
  recheck: 30_000,
  trustWindow: 2 * 60_000,
};

/** What the hub keeps across restarts. */
interface RangerRecord {
  /** the conversation it is on */
  session: string | null;
  /** when that conversation began */
  sessionAt?: number;
  /** the conversation before it, which the brief points back to */
  previous?: string | null;
  /** the folder the conversation runs in; a conversation is filed under it */
  home?: string;
  startedAt?: number;
  exitedAt?: number;
  exitCode?: number | null;
  fails?: number;
  gaveUp?: boolean;
}

/** The tmux calls the hub makes, so tests can stand in for tmux. */
export interface RangerTmux {
  /** every ranger pane; "no-server" when no tmux server runs, null when it did not answer */
  list(): Promise<RangerPane[] | "no-server" | null>;
  /** makes the session if it is not there and runs `command` in its pane */
  start(id: string, root: string, command: string[], env: Record<string, string>): Promise<void>;
  kill(id: string): Promise<void>;
  /** what the pane shows now; null when tmux will not say */
  text(id: string): Promise<string | null>;
}

/** The real tmux, over canopy's own socket. */
export function realTmux(base: string[]): RangerTmux {
  return {
    async list() {
      const r = await exec(rangerPanesArgs(base), { timeoutMs: 10_000 });
      if (r.code === 0) return parseRangerPanes(r.stdout);
      return noServer(r.stderr) ? "no-server" : null;
    },
    async start(id, root, command, env) {
      if (!(await hasSession(base, id))) {
        const made = await exec(rangerSessionArgs(base, id, root, { cols: 160, rows: 45 }), { timeoutMs: 15_000 });
        if (made.code !== 0 && !/duplicate session/.test(made.stderr)) throw new Error(made.stderr.trim() || "tmux could not make the ranger's session");
      }
      const r = await exec(respawnArgs(base, id, command, root, env), { timeoutMs: 10_000 });
      if (r.code !== 0) throw new Error(r.stderr.trim() || "tmux could not start the ranger");
    },
    async kill(id) {
      await killSession(base, id);
    },
    async text(id) {
      const r = await exec(textArgs(base, id, true), { timeoutMs: 10_000 });
      return r.code === 0 ? r.stdout : null;
    },
  };
}

/** a run as the hub needs it for a run wake */
export interface RangerRun {
  status: string;
  repo: string;
  active: boolean;
}

export interface RangerHubDeps {
  /** null on a backend without tmux, where the ranger cannot run */
  tmux: RangerTmux | null;
  /** the scan root: its folder */
  root: string;
  /** this backend's name, read when the hub starts */
  backend: () => string;
  /** `CANOPY_*` for its session, the way any canopy shell gets them */
  env: (term: string) => Record<string, string>;
  /** the login shell its claude runs through, so the rc files put tailchan on PATH */
  shell: string;
  hasClaude: () => boolean;
  /** the settings a profile resolves to (the shell route when null) */
  settings: (profile: string | null) => Promise<AgentSettings>;
  cards: () => AgentCard[];
  /** whether a broker is configured, which a wake needs */
  broker: () => boolean;
  /** a DM from canopy's bot */
  send: (handle: string, text: string) => Promise<void>;
  /** said to Eric when it gives up */
  gaveUp: (text: string) => void;
  run: (id: string) => RangerRun | undefined;
  viewers: (term: string) => string[];
  lastInput: (term: string) => number | undefined;
  /** puts its session among the ones `/api/term?attach=1` joins */
  hold: (info: TermInfo) => void;
  drop: (term: string) => void;
  broadcast: (ev: ServerEvent) => void;
  /** where state.json and wakes.json go; `<config dir>/ranger` by default */
  dir?: string;
  claudeHome?: string;
  /** the brief's text, before its slots are filled */
  brief?: () => Promise<string>;
  /** whether user settings still give the Telegram plugin to every session */
  telegramContested?: () => Promise<boolean>;
  loadSettings?: () => Promise<RangerSettings>;
  saveSettings?: (s: RangerSettings) => Promise<void>;
  timings?: Partial<RangerTimings>;
  now?: () => number;
}

export class RangerError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** the ranger's session id on a backend: shaped like a shell's, and the same every start */
export const rangerTermId = (backend: string): string => createHash("sha256").update(`ranger\0${backend}`).digest("hex").slice(0, 32);

const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const say = (what: string) => (err: unknown) => console.error(`ranger: ${what}: ${err instanceof Error ? err.message : err}`);

async function writeJson(file: string, data: unknown): Promise<void> {
  const tmp = `${file}.tmp-${process.pid}-${randomBytes(3).toString("hex")}`;
  await writeFile(tmp, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
  await rename(tmp, file);
}

async function readJson(file: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as unknown;
  } catch {
    return null;
  }
}

function parseRecord(v: unknown): RangerRecord {
  if (!v || typeof v !== "object" || Array.isArray(v)) return { session: null };
  const r = v as Record<string, unknown>;
  const num = (k: string) => (typeof r[k] === "number" ? { [k]: r[k] as number } : {});
  return {
    session: typeof r["session"] === "string" && /^[0-9a-f-]{36}$/.test(r["session"]) ? r["session"] : null,
    ...num("sessionAt"),
    ...num("startedAt"),
    ...num("exitedAt"),
    ...num("fails"),
    ...(typeof r["previous"] === "string" ? { previous: r["previous"] } : {}),
    ...(typeof r["home"] === "string" ? { home: r["home"] } : {}),
    ...(typeof r["exitCode"] === "number" || r["exitCode"] === null ? { exitCode: r["exitCode"] as number | null } : {}),
    ...(r["gaveUp"] === true ? { gaveUp: true } : {}),
  };
}

/** whether user settings at `home` enable the Telegram plugin for every session */
export async function telegramInUserSettings(home: string): Promise<boolean> {
  const s = await readJson(join(home, "settings.json"));
  if (!s || typeof s !== "object") return false;
  const plugins = (s as Record<string, unknown>)["enabledPlugins"];
  return !!plugins && typeof plugins === "object" && (plugins as Record<string, unknown>)[TELEGRAM_PLUGIN] === true;
}

type LaunchKind = "start" | "retry" | "restart" | "fresh";

export class RangerHub {
  readonly t: RangerTimings;
  private term = "";
  private dir: string;
  private home: string;
  private settings: RangerSettings = { ...RANGER_DEFAULTS, fresh: { ...RANGER_DEFAULTS.fresh } };
  private rec: RangerRecord = { session: null };
  private wakes: RangerWake[] = [];
  private pane: RangerPane | null = null;
  private answering: boolean | undefined;
  private noServerSince: number | undefined;
  private state: RangerState = "off";
  private why: string | undefined;
  private retryAt: number | undefined;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private restarts = 0;
  private launching: Promise<void> | null = null;
  /** when the last launch began, so a list read before it is not believed over it */
  private launchedAt = -1;
  private ticking: Promise<void> | null = null;
  private delivering: Promise<void> | null = null;
  private timers: ReturnType<typeof setInterval>[] = [];
  private stopped = false;
  /** set when canopy itself ends the session, so the exit is not a death */
  private ending = false;
  private trust = false;
  /** a restart or fresh start refused while the old session runs on: its
   *  state and reason stand over "running" until a start goes through */
  private held: { state: RangerState; why: string; kind: LaunchKind } | null = null;
  /** settings changes, one at a time, so two in flight never lose one */
  private patching: Promise<unknown> = Promise.resolve();
  private bytes: number | undefined;
  private contested = false;
  private told = "";

  constructor(private readonly deps: RangerHubDeps) {
    this.t = { ...RANGER_TIMINGS, ...deps.timings };
    this.dir = deps.dir ?? join(configDir(), "ranger");
    this.home = deps.claudeHome ?? claudeHome();
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  /** the ranger's session id; set once the hub starts */
  get termId(): string {
    return this.term || rangerTermId(this.deps.backend());
  }

  /** whether a shell id is the ranger's: a plain shell socket must never start one under it */
  knows(id: string): boolean {
    return id === this.termId;
  }

  async start(): Promise<void> {
    this.term = rangerTermId(this.deps.backend());
    this.settings = await this.loadSettings();
    this.rec = parseRecord(await readJson(join(this.dir, "state.json")));
    const raw = await readJson(join(this.dir, "wakes.json"));
    this.wakes = (Array.isArray(raw) ? raw : []).map(parseWake).filter((w): w is RangerWake => w !== null);
    await this.readTelegram();
    this.state = this.settings.on ? (this.deps.tmux ? "starting" : "no-tmux") : "off";
    this.tell();
    if (!this.deps.tmux) return;
    this.timers.push(setInterval(() => void this.poke(), this.t.tick));
    this.timers.push(setInterval(() => void this.deliver(), this.t.wakeEvery));
    this.timers.push(setInterval(() => void this.freshCheck().catch(say("fresh check")), this.t.freshEvery));
    void this.poke();
  }

  stop(): void {
    this.stopped = true;
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
  }

  /** resolves once a tick, a launch and a delivery in flight have finished */
  async settled(): Promise<void> {
    while (this.ticking || this.launching || this.delivering) await Promise.allSettled([this.ticking, this.launching, this.delivering]);
  }

  private async loadSettings(): Promise<RangerSettings> {
    if (this.deps.loadSettings) return this.deps.loadSettings();
    return (await loadConfig()).ranger;
  }

  private async saveSettings(s: RangerSettings): Promise<void> {
    if (this.deps.saveSettings) await this.deps.saveSettings(s);
    else await setRanger(s);
  }

  private async save(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    await writeJson(join(this.dir, "state.json"), this.rec);
  }

  private async saveWakes(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    await writeJson(join(this.dir, "wakes.json"), this.wakes);
  }

  private async readTelegram(): Promise<void> {
    this.contested = await (this.deps.telegramContested?.() ?? telegramInUserSettings(this.home)).catch(() => false);
  }

  /** the folder its session runs in: its own under the config dir, or the scan root */
  private homeDir(s: RangerSettings = this.settings): string {
    return s.home === "root" ? this.deps.root : join(this.dir, "home");
  }

  /** the folder the current conversation runs in: where it was started, else
   *  where the settings put it; a record from before `home` ran in the scan root */
  private convHome(): string {
    return this.rec.home ?? (this.rec.session ? this.deps.root : this.homeDir());
  }

  private transcript(session: string | null, home: string = this.convHome()): string | null {
    return session ? join(this.home, "projects", projectFolder(home), `${session}.jsonl`) : null;
  }

  private async brief(): Promise<string> {
    if (this.deps.brief) return this.deps.brief();
    for (const file of [join(configDir(), "ranger.md"), BUNDLED_BRIEF]) {
      try {
        return await readFile(file, "utf8");
      } catch {
        // the next one
      }
    }
    return "You are the ranger, canopy's always-on agent on {{backend}}. Your handle is @{{handle}}.";
  }

  /** its card, while live: the conversation it is on */
  private card(): AgentCard | undefined {
    const session = this.rec.session;
    return session ? this.deps.cards().find((c) => c.session === session && isLiveAgent(c)) : undefined;
  }

  /** a live canopy agent on another backend with the handle, or undefined */
  private takenBy(handle: string): AgentCard | undefined {
    const backend = this.deps.backend();
    return this.deps.cards().find((c) => c.handle === handle && isLiveAgent(c) && c.session !== this.rec.session && c.where.canopy !== null && c.where.canopy.backend !== backend);
  }

  private running(): boolean {
    return this.pane !== null && !this.pane.dead;
  }

  /* ---------- what the browsers see ---------- */

  info(): RangerInfo {
    const transcript = this.transcript(this.rec.session);
    const exit = this.rec.exitedAt !== undefined ? { lastExit: { at: this.rec.exitedAt, code: this.rec.exitCode ?? null } } : {};
    return {
      on: this.settings.on,
      state: this.state,
      ...(this.why ? { why: this.why } : {}),
      term: this.termId,
      handle: rangerHandle(this.settings),
      backend: this.deps.backend(),
      root: this.deps.root,
      home: this.homeDir(),
      session: this.rec.session,
      transcript: this.bytes !== undefined ? transcript : null,
      ...(this.bytes !== undefined ? { transcriptBytes: this.bytes } : {}),
      ...(this.rec.sessionAt !== undefined ? { sessionAt: this.rec.sessionAt } : {}),
      ...(this.running() && this.rec.startedAt !== undefined ? { startedAt: this.rec.startedAt } : {}),
      ...(this.retryAt !== undefined ? { retryAt: this.retryAt } : {}),
      fails: this.rec.fails ?? 0,
      restarts: this.restarts,
      ...exit,
      telegram: this.settings.telegram ? (this.contested ? "contested" : "owned") : "off",
      settings: this.settings,
      wakes: this.wakes,
      viewers: this.deps.viewers(this.termId),
      broker: this.deps.broker(),
    };
  }

  /** the `ranger` event, only when something in it changed */
  private tell(): void {
    const info = this.info();
    const text = JSON.stringify(info);
    if (text === this.told) return;
    this.told = text;
    this.deps.broadcast({ type: "ranger", ranger: info });
  }

  /** a viewer came or went */
  refresh(): void {
    this.tell();
  }

  private setState(state: RangerState, why?: string): void {
    this.state = state;
    this.why = why;
  }

  private holdInfo(startedAt: number): TermInfo {
    return { id: this.termId, repoId: "", path: this.homeDir(), place: "strip", attached: false, viewers: [], startedAt, ranger: true, handle: rangerHandle(this.settings) };
  }

  /* ---------- the supervisor ---------- */

  private poke(): Promise<void> {
    if (!this.ticking) this.ticking = this.tick().catch(say("supervisor")).finally(() => (this.ticking = null));
    return this.ticking;
  }

  private async tick(): Promise<void> {
    const tmux = this.deps.tmux;
    if (!tmux || this.stopped) return;
    const listedAt = this.now();
    const got = await tmux.list();
    const before = this.pane;
    const reading = paneReading(got, before !== null && !before.dead, this.noServerSince, this.now(), this.t.noServerGrace);
    this.noServerSince = reading.since;
    this.answering = reading.panes !== null;
    if (reading.panes === null || this.stopped) return this.tell();
    // a launch under way, or one that began while this list was read, owns the pane
    if (this.launching || this.launchedAt >= listedAt) return this.tell();
    const pane = reading.panes.find((p) => p.termId === this.termId) ?? null;
    this.pane = pane;
    if (pane) this.deps.hold(this.holdInfo(pane.createdAt));
    else if (before) this.deps.drop(this.termId);
    const died = (before !== null && !before.dead && (pane === null || pane.dead)) || (before === null && pane !== null && pane.dead && this.rec.exitedAt === undefined);
    if (died) await this.onExit(pane?.code ?? null);
    if (this.settings.on) {
      if (this.running()) {
        await this.watchRunning();
      } else if (this.rec.gaveUp) {
        this.setState("gave-up", `it exited ${this.rec.fails ?? this.t.giveUp} times in a row; restart it by hand`);
      } else if (!this.retryTimer) {
        // nothing there (a reboot, the shells container recreated, or turned
        // on): start it, a dead pane left over reused by the start, and the
        // deaths on record from before a canopy restart still counting
        void this.launch(this.rec.fails ? "retry" : "start");
      }
    } else if (pane) {
      await this.end();
      this.setState("off");
    } else if (this.state !== "off") this.setState("off");
    this.tell();
  }

  /** a live session: the trust dialog, the state word, and a good stretch forgetting deaths */
  private async watchRunning(): Promise<void> {
    const file = this.transcript(this.rec.session);
    this.bytes = file ? await stat(file).then((s) => s.size, () => undefined) : undefined;
    const card = this.card();
    // no hook runs before the trust dialog, so no card means it may be up:
    // read the pane while it shows, or for a while after a start, never
    // every tick for good on a backend whose hooks never make a card
    const fresh = this.rec.startedAt !== undefined && this.now() - this.rec.startedAt < this.t.trustWindow;
    if (!card && this.deps.tmux && (this.trust || fresh)) {
      const text = await this.deps.tmux.text(this.termId);
      this.trust = text !== null && TRUST_RE.test(text);
    } else if (card) this.trust = false;
    if (this.trust) {
      const home = this.homeDir();
      this.setState(
        "trust",
        this.settings.home === "root"
          ? `Claude asks whether to trust ${home}, which also trusts every folder under it; open the ranger's shell and accept, or give it a folder of its own`
          : `Claude asks once whether to trust ${home}, the ranger's own folder; open its shell and accept`,
      );
    }
    else if (this.held) this.setState(this.held.state, this.held.why);
    else this.setState("running");
    if (this.rec.fails && this.rec.startedAt !== undefined && this.now() - this.rec.startedAt > this.t.uptime) {
      delete this.rec.fails;
      await this.save();
    }
  }

  /** claude exited: a death, unless canopy ended it */
  private async onExit(code: number | null): Promise<void> {
    this.rec.exitedAt = this.now();
    this.rec.exitCode = code;
    if (this.ending || !this.settings.on) {
      this.ending = false;
      await this.save();
      return;
    }
    this.rec.fails = (this.rec.fails ?? 0) + 1;
    if (this.rec.fails >= this.t.giveUp) {
      this.rec.gaveUp = true;
      this.setState("gave-up", `it exited ${this.rec.fails} times in a row; restart it by hand`);
      this.deps.gaveUp(`the ranger on ${this.deps.backend()} exited ${this.rec.fails} times in a row; canopy stopped restarting it`);
    } else this.arm();
    await this.save();
  }

  /** a start after the backoff its deaths call for */
  private arm(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    const wait = nextDelay(this.rec.fails ?? 1, this.t.backoff, this.t.backoffCap);
    this.retryAt = this.now() + wait;
    this.setState("backoff", `exited${this.rec.exitCode !== undefined && this.rec.exitCode !== null ? ` with ${this.rec.exitCode}` : ""}; starting again`);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      this.retryAt = undefined;
      if (this.stopped || !this.settings.on || this.rec.gaveUp) return;
      void this.launch("retry");
    }, wait);
  }

  /** a start refused for a reason that is not a death: the state says why,
   *  and the next try waits `recheck` rather than the next tick */
  private refuse(state: RangerState, why: string, kind: LaunchKind): void {
    this.setState(state, why);
    // a restart or fresh start refused while the old session runs: that
    // session is on the old settings, so say so until the start goes through
    const live = this.running() && (kind === "restart" || kind === "fresh");
    this.held = live ? { state, why: `${why} (it still runs as before)`, kind } : null;
    if (this.held) this.why = this.held.why;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      if (this.stopped || !this.settings.on) return;
      if (this.held && this.running()) void this.launch(this.held.kind);
      else if (!this.running()) void this.launch(this.rec.fails ? "retry" : "start");
    }, this.t.recheck);
  }

  /** ends the session canopy's own way: not a death */
  private async end(): Promise<void> {
    const tmux = this.deps.tmux;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    this.retryAt = undefined;
    if (!tmux || !this.pane) return;
    this.ending = true;
    await tmux.kill(this.termId);
    this.pane = null;
    this.ending = false;
    this.rec.exitedAt = this.now();
    this.rec.exitCode = null;
    this.deps.drop(this.termId);
    await this.save();
  }

  /** Starts claude in the session, or puts a new one in place of whatever
   *  runs there: a first start, a retry after a death, a restart by hand
   *  (same conversation) or a fresh conversation. */
  private launch(kind: LaunchKind): Promise<void> {
    // a fresh start or restart asked for while another launch runs is not
    // that launch: it runs after it, never dropped
    if (this.launching) return kind === "fresh" || kind === "restart" ? this.launching.then(() => this.launch(kind)) : this.launching;
    this.launching = this.doLaunch(kind)
      .catch(async (err: unknown) => {
        // a start that failed is a death of its own, so it backs off too
        const why = `could not start: ${err instanceof Error ? err.message : String(err)}`;
        this.rec.fails = (this.rec.fails ?? 0) + 1;
        if (this.rec.fails >= this.t.giveUp) {
          this.rec.gaveUp = true;
          this.deps.gaveUp(`the ranger on ${this.deps.backend()} ${why}; canopy stopped trying`);
        } else this.arm();
        this.why = why;
        if (this.rec.gaveUp) this.state = "gave-up";
        await this.save().catch(say("save"));
      })
      .finally(() => {
        this.launching = null;
        this.tell();
      });
    return this.launching;
  }

  private async doLaunch(kind: LaunchKind): Promise<void> {
    const tmux = this.deps.tmux;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    this.retryAt = undefined;
    if (!tmux) return this.setState("no-tmux", "the ranger needs tmux on this backend");
    // tmux not answering may be its container restarting: a start now could
    // make a second server, or land on one about to go
    if (this.answering === false) return this.setState("starting", "waiting for tmux to answer");
    if (!this.deps.hasClaude()) return this.refuse("no-claude", `Claude Code is not installed on ${this.deps.backend()}`, kind);
    const agent = await this.deps.settings(this.settings.profile);
    if (agent.harness !== "claude") return this.refuse("error", `the ranger runs Claude Code; ${this.settings.profile ? `the profile ${this.settings.profile}` : "the shell route"} is ${agent.harness}`, kind);
    const handle = rangerHandle(this.settings);
    const taken = this.takenBy(handle);
    if (taken) return this.refuse("handle-taken", `@${handle} is live on ${taken.where.canopy?.backend ?? taken.node}; give this backend's ranger another handle`, kind);
    const now = this.now();
    this.launchedAt = now;
    const exists = (file: string | null) => (file ? stat(file).then(() => true, () => false) : Promise.resolve(false));
    const home = this.homeDir();
    await mkdir(home, { recursive: true });
    // a conversation lives under the folder it ran in, so a move to another folder starts a new one
    const was = this.convHome();
    const moved = this.rec.session !== null && was !== home;
    if (!this.rec.session || kind === "fresh" || moved) {
      const old = this.transcript(this.rec.session, was);
      if (await exists(old)) this.rec.previous = old;
      this.rec.session = randomUUID();
      this.rec.sessionAt = now;
      this.bytes = undefined;
    }
    this.rec.home = home;
    // a conversation that never got a message has no file, and --resume finds nothing
    const first = !(await exists(this.transcript(this.rec.session)));
    const brief = rangerBrief(await this.brief(), {
      backend: this.deps.backend(),
      handle,
      root: this.deps.root,
      home,
      previous: this.rec.previous ?? null,
      telegram: this.settings.telegram,
    });
    // a file rather than an argument: the brief would make the tmux command
    // long, and the config dir is where the shells container sees it too
    await mkdir(this.dir, { recursive: true });
    const briefFile = join(this.dir, "brief.md");
    await writeFile(briefFile, brief + "\n", { mode: 0o600 });
    const hello = rangerHello(!first ? "resume" : this.rec.previous ? "fresh" : "new");
    const own = home !== this.deps.root;
    const argv = rangerArgv({ settings: agent, session: this.rec.session, first, briefFile, telegram: this.settings.telegram, hello, ...(own ? { addDir: this.deps.root } : {}) });
    const command = [this.deps.shell, "-lic", `cd -- ${shellQuote(home)} && exec ${argv.map(shellQuote).join(" ")}`];
    this.setState("starting");
    this.tell();
    // in a folder of its own, the scan root's CLAUDE.md comes in through --add-dir only with this
    const env = { ...this.deps.env(this.termId), TAILCHAN_AS: handle, ...(own ? { CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: "1" } : {}) };
    await tmux.start(this.termId, home, command, env);
    this.rec.startedAt = now;
    delete this.rec.exitedAt;
    delete this.rec.exitCode;
    if (kind === "retry") this.restarts += 1;
    else {
      // a start by hand or a turn-on forgets the deaths and a gave-up
      delete this.rec.fails;
      delete this.rec.gaveUp;
    }
    this.pane = { termId: this.termId, dead: false, code: null, createdAt: now, activityAt: now };
    this.trust = false;
    this.held = null;
    this.deps.hold(this.holdInfo(now));
    this.setState("running");
    await this.save();
  }

  /* ---------- fresh conversations ---------- */

  private async freshCheck(): Promise<void> {
    if (this.stopped || !this.settings.on || !this.running() || this.launching || this.trust) return;
    await this.readTelegram();
    this.tell();
    const due = freshDue({ now: this.now(), fresh: this.settings.fresh, sessionAt: this.rec.sessionAt, bytes: this.bytes });
    if (!due) return;
    const quiet = isQuiet({ now: this.now(), card: this.card(), lastOutput: this.pane?.activityAt ?? undefined, lastInput: this.deps.lastInput(this.termId), quiet: this.t.quiet });
    if (!quiet) return;
    await this.launch("fresh");
  }

  /* ---------- wakes ---------- */

  /** Delivers what is due, one at a time. Held, not dropped, while there is
   *  no broker or the ranger is not running; a cron that came due meanwhile
   *  is delivered once and goes on from now. */
  private deliver(): Promise<void> {
    if (!this.delivering) this.delivering = this.deliverDue().catch(say("wakes")).finally(() => (this.delivering = null));
    return this.delivering;
  }

  private async deliverDue(): Promise<void> {
    if (this.stopped || !this.deps.broker() || !this.running() || this.trust || this.launching) return;
    const handle = rangerHandle(this.settings);
    let changed = false;
    // this.wakes is replaced below, never changed in place, so this walks the list as it was
    for (const w of this.wakes) {
      const now = this.now();
      let run: RangerRun | null | undefined;
      if (w.run) {
        run = this.deps.run(w.run) ?? null;
        if (run?.active) continue;
      } else if (w.next === undefined || w.next > now) continue;
      try {
        await this.deps.send(handle, wakeLine(w, run));
      } catch (err) {
        say(`wake ${w.id}`)(err);
        break;
      }
      const next = w.cron ? cronAfter(w.cron, now) : null;
      this.wakes = next !== null ? this.wakes.map((x) => (x.id === w.id ? { ...x, next } : x)) : this.wakes.filter((x) => x.id !== w.id);
      changed = true;
    }
    if (changed) {
      await this.saveWakes();
      this.tell();
    }
  }

  /** a run changed: a wake on it may be due */
  onRun(runId: string, active: boolean): void {
    if (!active && this.wakes.some((w) => w.run === runId)) void this.deliver();
  }

  async addWake(body: unknown): Promise<RangerWake> {
    const by = body && typeof body === "object" && (body as Record<string, unknown>)["by"] === "eric" ? "eric" : "ranger";
    const w = readWake(body, by, randomBytes(4).toString("hex"), this.now());
    if (typeof w === "string") throw new RangerError(400, w);
    if (w.run && !this.deps.run(w.run)) throw new RangerError(404, `no run ${w.run} on ${this.deps.backend()}`);
    if (this.wakes.length >= WAKES_MAX) throw new RangerError(409, `the ranger holds ${WAKES_MAX} wakes already; remove one first`);
    this.wakes = [...this.wakes, w];
    await this.saveWakes();
    this.tell();
    if (w.run) void this.deliver();
    return w;
  }

  async removeWake(id: string): Promise<void> {
    if (!this.wakes.some((w) => w.id === id)) throw new RangerError(404, `no wake ${id}`);
    this.wakes = this.wakes.filter((w) => w.id !== id);
    await this.saveWakes();
    this.tell();
  }

  /* ---------- actions ---------- */

  /** applies a settings change: on and off start and end it, and a change
   *  to what it runs as restarts a running one */
  /** applies settings changes one at a time: each is read against what the
   *  last one left, so two saves in flight never undo each other */
  patch(body: unknown): Promise<RangerInfo> {
    const run = this.patching.then(() => this.applyPatch(body));
    this.patching = run.catch(() => {});
    return run;
  }

  private async applyPatch(body: unknown): Promise<RangerInfo> {
    const next = patchRanger(this.settings, body);
    if (typeof next === "string") throw new RangerError(400, next);
    if (next.on && !this.deps.tmux) throw new RangerError(503, "the ranger needs tmux on this backend");
    // refused here, not at the next start: a running ranger would keep its
    // old claude while the settings named something it cannot run
    if (next.profile !== this.settings.profile) {
      const agent = await this.deps.settings(next.profile);
      if (agent.harness !== "claude") throw new RangerError(400, `the ranger runs Claude Code; ${next.profile ? `the profile ${next.profile}` : "the shell route"} is ${agent.harness}`);
    }
    // the same for a handle another backend's ranger is live under
    const handle = rangerHandle(next);
    const taken = handle !== rangerHandle(this.settings) ? this.takenBy(handle) : undefined;
    if (taken) throw new RangerError(409, `@${handle} is live on ${taken.where.canopy?.backend ?? taken.node}; pick another handle`);
    const was = this.settings;
    await this.saveSettings(next);
    this.settings = next;
    await this.readTelegram();
    const reshaped = was.profile !== next.profile || was.handle !== next.handle || was.telegram !== next.telegram || was.home !== next.home;
    if (!next.on) {
      this.held = null;
      await this.end();
      this.setState("off");
    } else if (!was.on) {
      delete this.rec.gaveUp;
      delete this.rec.fails;
      await this.launch("start");
    } else if (reshaped && this.running()) await this.launch("restart");
    this.tell();
    return this.info();
  }

  async restart(): Promise<RangerInfo> {
    if (!this.settings.on) throw new RangerError(409, "the ranger is off; turn it on first");
    await this.launch("restart");
    return this.info();
  }

  async fresh(): Promise<RangerInfo> {
    if (!this.settings.on) throw new RangerError(409, "the ranger is off; turn it on first");
    await this.launch("fresh");
    return this.info();
  }

  /* ---------- routes ---------- */

  async handle(req: Request, url: URL): Promise<Response | null> {
    const path = url.pathname;
    if (path !== "/api/ranger" && !path.startsWith("/api/ranger/")) return null;
    const method = req.method;
    const body = async (): Promise<unknown> => req.json().catch(() => null);
    try {
      if (path === "/api/ranger" && method === "GET") return json(this.info());
      if (path === "/api/ranger" && method === "POST") return json(await this.patch(await body()));
      if (path === "/api/ranger/restart" && method === "POST") return json(await this.restart());
      if (path === "/api/ranger/fresh" && method === "POST") return json(await this.fresh());
      if (path === "/api/ranger/wakes" && method === "GET") return json(this.wakes);
      if (path === "/api/ranger/wakes" && method === "POST") return json(await this.addWake(await body()), 201);
      if (path === "/api/ranger/wakes" && method === "DELETE") {
        await this.removeWake(url.searchParams.get("id") ?? "");
        return json(this.info());
      }
      return json({ error: "not found" }, 404);
    } catch (err) {
      const status = err instanceof RangerError ? err.status : 500;
      return json({ error: String(err instanceof Error ? err.message : err) }, status);
    }
  }
}
