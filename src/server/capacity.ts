/**
 * The capacity readings: one `Capacity` per harness from the harness's own
 * count of its windows on each run's stream, the ledger, every limited run
 * and, when configured, a usage reader; the hits and a run's count across
 * restarts in `capacity.json`; the governor's `may` for the Runner and the
 * pumps; the starts the pumps hold, read from their owners; the routes and
 * the event. Bun-only.
 */

import { watch, type FSWatcher } from "node:fs";
import { chmod, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import {
  DEFAULT_CAPACITY,
  FIVE_HOURS,
  HIT_GRACE,
  READ_EVERY,
  READ_IDLE,
  decide,
  emptyCapacity,
  fade,
  hear,
  hitOfLimited,
  hitStands,
  mergeCli,
  observe,
  patchCapacity,
  readAntigravityUsage,
  readClaudeStatusLimits,
  readCodexLimits,
  readUsage,
  type Capacity,
  type CapacityHit,
  type CapacitySettings,
  type CapacitySource,
  type Decision,
  type Heard,
  type Window,
} from "../core/capacity";
import type { CostEntry } from "../core/costs";
import { workEnv } from "../core/envnames";
import { findBinary } from "../core/openers";
import { claudeHome } from "../core/sessions";
import { configDir } from "../core/store";
import {
  HARNESSES,
  isHarness,
  type CanopyConfig,
  type CapacityInfo,
  type Harness,
  type HeldStart,
  type Priority,
  type Run,
  type ServerEvent,
} from "../core/types";

export const capacityFile = (): string => join(configDir(), "capacity.json");

/** P2's endpoint for one harness; wired to nothing until the usage read is approved. */
export type UsageReader = (harness: Harness) => Promise<unknown>;

/** Reads one harness's usage windows directly from its own CLI. Returns null
 *  when the binary is not installed; throws on a read/auth/parse failure. */
export type CliUsageReader = (now: number) => Promise<{ fiveHour: Window | null; weekly: Window | null } | null>;

export const ANTIGRAVITY_USAGE_TIMEOUT = 15_000;

/** Reads Antigravity's plan windows through `agy -p /usage --output-format json`
 *  using this backend's own `agy` install and Google login (0 turns, 0 tokens,
 *  no conversation created). Kills promptly if `agy` asks for interactive login. */
export function antigravityUsageReader(opts: { command?: readonly string[]; timeoutMs?: number; find?: (bin: string) => string | null } = {}): CliUsageReader {
  const timeoutMs = opts.timeoutMs ?? ANTIGRAVITY_USAGE_TIMEOUT;
  return async (now: number) => {
    const argv = opts.command?.length
      ? [...opts.command, "-p", "/usage", "--output-format", "json"]
      : (() => {
          const bin = (opts.find ?? findBinary)("agy");
          return bin ? [bin, "-p", "/usage", "--output-format", "json"] : null;
        })();
    if (!argv) return null;
    const proc = Bun.spawn(argv, {
      cwd: tmpdir(),
      env: workEnv(process.env),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    let timedOut = false;
    let authRequired = false;
    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill();
    }, timeoutMs);
    (timer as { unref?: () => void }).unref?.();
    const readStderr = async (): Promise<string> => {
      const reader = proc.stderr.getReader();
      const decoder = new TextDecoder();
      let text = "";
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          text += decoder.decode(value, { stream: true });
          if (!authRequired && /authentication required/i.test(text)) {
            authRequired = true;
            proc.kill();
          }
        }
      } catch {
        // stream closed on kill
      } finally {
        reader.releaseLock();
      }
      return text;
    };
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text().catch(() => ""),
      readStderr(),
      proc.exited,
    ]);
    clearTimeout(timer);
    if (authRequired) throw new Error("Antigravity authentication required; run `agy acp --login` first");
    if (timedOut) throw new Error(`agy /usage timed out after ${timeoutMs}ms`);
    if (code !== 0) throw new Error(stderr.trim().split("\n").pop() || `agy /usage exited with ${code}`);
    let parsed: unknown;
    try {
      parsed = JSON.parse(stdout);
    } catch {
      throw new Error("agy /usage returned invalid JSON");
    }
    const windows = readAntigravityUsage(parsed, now);
    if (!windows) throw new Error("agy /usage returned no readable quota windows");
    return windows;
  };
}

export const CODEX_USAGE_TIMEOUT = 15_000;

/** Reads Codex's plan windows through `codex app-server`'s
 *  `account/rateLimits/read` RPC using this backend's own Codex login
 *  (0 threads, 0 turns, 0 tokens). Returns null when `codex` is not installed. */
export function codexUsageReader(opts: { command?: readonly string[]; timeoutMs?: number; find?: (bin: string) => string | null } = {}): CliUsageReader {
  const timeoutMs = opts.timeoutMs ?? CODEX_USAGE_TIMEOUT;
  return async (now: number) => {
    const argv = opts.command?.length
      ? [...opts.command, "app-server", "--listen", "stdio://"]
      : (() => {
          const bin = (opts.find ?? findBinary)("codex");
          return bin ? [bin, "app-server", "--listen", "stdio://"] : null;
        })();
    if (!argv) return null;
    const proc = Bun.spawn(argv, {
      cwd: tmpdir(),
      env: workEnv(process.env),
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill();
    }, timeoutMs);
    (timer as { unref?: () => void }).unref?.();
    const stderrTask = new Response(proc.stderr).text().catch(() => "");
    let reply: Record<string, unknown> | null = null;
    try {
      proc.stdin.write(
        `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { clientInfo: { name: "canopy", version: "0.2.0" }, capabilities: {} } })}\n`,
      );
      await proc.stdin.flush();
      const reader = proc.stdout.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      let asked = false;
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          let nl: number;
          while ((nl = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, nl).trim();
            buf = buf.slice(nl + 1);
            if (!line) continue;
            let parsed: unknown;
            try {
              parsed = JSON.parse(line);
            } catch {
              continue;
            }
            if (!isRecord(parsed)) continue;
            if (parsed["id"] === 1 && !asked) {
              asked = true;
              if (isRecord(parsed["error"])) {
                reply = parsed;
                break;
              }
              proc.stdin.write(
                `${JSON.stringify({ jsonrpc: "2.0", method: "initialized", params: {} })}\n`
                + `${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "account/rateLimits/read", params: {} })}\n`,
              );
              await proc.stdin.flush();
            } else if (parsed["id"] === 2) {
              reply = parsed;
              break;
            }
          }
          if (reply !== null) break;
        }
      } finally {
        reader.releaseLock();
      }
    } finally {
      clearTimeout(timer);
      try {
        proc.stdin.end();
      } catch {
        // already closed
      }
      proc.kill();
    }
    const [stderr, code] = await Promise.all([stderrTask, proc.exited]);
    if (timedOut) throw new Error(`codex account/rateLimits/read timed out after ${timeoutMs}ms`);
    if (reply === null) {
      throw new Error(stderr.trim().split("\n").pop() || `codex app-server exited with ${code} before returning rate limits`);
    }
    if (isRecord(reply["error"])) {
      const msg = typeof reply["error"]["message"] === "string" ? reply["error"]["message"] : "codex account/rateLimits/read failed";
      throw new Error(msg);
    }
    const heard = readCodexLimits(reply["result"]);
    if (!heard) throw new Error("codex account/rateLimits/read returned no readable rate limits");
    return {
      fiveHour: heard.fiveHour ? { ...heard.fiveHour, readAt: now } : null,
      weekly: heard.weekly ? { ...heard.weekly, readAt: now } : null,
    };
  };
}

/** Where Claude Code's statusline script caches the latest `rate_limits` JSON. */
export const claudeRateLimitsFile = (): string => join(claudeHome(), "cache", "rate-limits.json");

/** Reads Claude Code's plan windows from the local cache file written by the
 *  user's statusLine script (`~/.claude/cache/rate-limits.json`). Returns null
 *  silently when the file is absent or holds only expired windows. */
export function claudeStatusUsageReader(opts: { file?: string } = {}): CliUsageReader {
  return async (now: number) => {
    const file = opts.file ?? claudeRateLimitsFile();
    let st: Awaited<ReturnType<typeof stat>>;
    let raw: string;
    try {
      [st, raw] = await Promise.all([stat(file), readFile(file, "utf8")]);
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return null;
      throw error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return null;
    }
    return readClaudeStatusLimits(parsed, now, Math.round(st.mtimeMs));
  };
}

export interface CapacityHubDeps {
  broadcast: (event: ServerEvent) => void;
  /** the ledger's rows since `since` (readCosts) */
  ledger: (since: number) => Promise<CostEntry[]>;
  config: () => Promise<Pick<CanopyConfig, "capacity">>;
  /** where the hits live across restarts: capacityFile() */
  file: string;
  reader?: UsageReader | null;
  /** per-harness CLI usage readers, used when `reader` is not set */
  cliReaders?: Partial<Record<Harness, CliUsageReader>>;
  /** cache files to watch per harness, triggering `cliReaders[harness]` on change */
  watchFiles?: Partial<Record<Harness, string>>;
  now?: () => number;
  /** ms between a change and its event, so a burst sends one; 250 */
  debounce?: number;
  /** READ_EVERY and READ_IDLE, for tests */
  timings?: { every: number; idle: number };
  /** the starts the pumps hold now, read from their owners' records */
  held?: () => HeldStart[];
  /** the readings or a hit changed: every pump looks at what it holds again,
   *  so a reset wakes them without a timer of their own */
  wake?: () => void;
  /** writes a settings patch to the config, `POST /api/capacity` */
  saveSettings?: (settings: CapacitySettings) => Promise<void>;
  /** starts one held start now, as interactive; throws a refusal's words */
  release?: (id: string) => Promise<void>;
}

const json = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const finite = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

const isCapacityHit = (value: unknown): value is CapacityHit => {
  if (!isRecord(value)) return false;
  return (
    (value["window"] === "fiveHour" || value["window"] === "weekly")
    && finite(value["at"])
    && Number.isFinite(new Date(value["at"]).getTime())
    && finite(value["resetsAt"])
    && Number.isFinite(new Date(value["resetsAt"]).getTime())
    && typeof value["text"] === "string"
  );
};

/** a window as `capacity.json` keeps a run's or CLI's count; null for anything else */
const keptWindow = (value: unknown, allowNullReset = false): Window | null => {
  if (!isRecord(value) || !finite(value["used"]) || value["used"] < 0 || !finite(value["readAt"])) return null;
  const reset = value["resetsAt"];
  if (reset === null) return allowNullReset ? { used: value["used"], resetsAt: null, readAt: value["readAt"] } : null;
  return finite(reset) ? { used: value["used"], resetsAt: reset, readAt: value["readAt"] } : null;
};

/** A hit's source: an endpoint's, run's or CLI's reading stays what it is, and
 *  anything else is observed from the hit. */
const hitSource = (source: CapacitySource): CapacitySource =>
  source === "endpoint" || source === "run" || source === "cli" ? source : "observed";

export class CapacityHub {
  private readonly readings = new Map<Harness, Capacity>();
  private readonly seenRuns = new Map<string, number>();
  private readonly seenCliRuns = new Map<string, string>();
  private readonly cliInFlight = new Map<Harness, Promise<void>>();
  private readonly readerFailures = new Set<Harness>();
  private readonly now: () => number;
  private readonly every: number;
  private readonly idle: number;
  private readonly reader: UsageReader | null;
  private readonly cliReaders: Partial<Record<Harness, CliUsageReader>>;
  private readonly watchFiles: Partial<Record<Harness, string>>;
  private readonly watchers: FSWatcher[] = [];
  private readonly watchTimers = new Map<Harness, ReturnType<typeof setTimeout>>();
  private settings: CapacitySettings = { ...DEFAULT_CAPACITY };
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pending: ReturnType<typeof setTimeout> | null = null;
  private writeQueue: Promise<void> = Promise.resolve();
  private sent = "";
  /** the readings and settings last woken on, so held-list changes alone
   *  never wake the pumps that made them */
  private woke = "";
  private started = false;
  private stopped = false;

  constructor(private readonly deps: CapacityHubDeps) {
    this.now = deps.now ?? Date.now;
    this.every = deps.timings?.every ?? READ_EVERY;
    this.idle = deps.timings?.idle ?? READ_IDLE;
    this.reader = deps.reader ?? null;
    this.cliReaders = deps.cliReaders ?? {};
    this.watchFiles = deps.watchFiles ?? {};
    for (const harness of HARNESSES) this.readings.set(harness, emptyCapacity(harness));
  }

  /** Read the kept hits and counts, drop expired ones, read current usage and start the clock. */
  async start(): Promise<void> {
    if (this.started || this.stopped) return;
    this.started = true;
    await this.readKept();
    if (this.dropExpired(this.now())) await this.persist();
    this.startWatchers();
    await this.refresh();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.pending) clearTimeout(this.pending);
    this.timer = null;
    this.pending = null;
    for (const t of this.watchTimers.values()) clearTimeout(t);
    this.watchTimers.clear();
    for (const w of this.watchers) {
      try {
        w.close();
      } catch {
        // already closed
      }
    }
    this.watchers.length = 0;
  }

  private startWatchers(): void {
    if (this.reader) return;
    for (const [name, file] of Object.entries(this.watchFiles)) {
      if (!isHarness(name) || !file || !this.cliReaders[name]) continue;
      const target = basename(file);
      try {
        const watcher = watch(dirname(file), (_event, changed) => {
          if (this.stopped) return;
          if (changed !== null && changed !== target) return;
          const prev = this.watchTimers.get(name);
          if (prev) clearTimeout(prev);
          const t = setTimeout(() => {
            this.watchTimers.delete(name);
            if (!this.stopped) void this.readCli(name, true);
          }, 200);
          (t as { unref?: () => void }).unref?.();
          this.watchTimers.set(name, t);
        });
        watcher.on("error", () => {
          // directory may be absent or unmounted; periodic refresh still reads it
        });
        this.watchers.push(watcher);
      } catch {
        // directory does not exist yet; periodic refresh will pick up the file
      }
    }
  }

  /** A run change: a new limited mark becomes its harness's hit, at the
   *  CLI's own reset when its rate-limit event named one. A finished run or
   *  chat turn on a harness with a CLI reader refreshes that harness's count. */
  onRun(run: Run): void {
    const limited = run.limited;
    if (limited && this.seenRuns.get(run.id) !== limited.at) {
      const hit = hitOfLimited(limited);
      if (hit) {
        this.seenRuns.set(run.id, limited.at);
        const current = this.get(run.harness);
        this.readings.set(run.harness, { ...current, hit, source: hitSource(current.source) });
        this.keep();
        this.changed();
        this.schedule(true);
      }
    }
    if (!this.reader && this.cliReaders[run.harness] && (run.status === "done" || run.status === "limited" || (run.status === "idle" && (run.result?.turns ?? 0) > 0))) {
      const mark = `${run.status}:${run.result?.turns ?? 0}:${run.endedAt ?? 0}`;
      if (this.seenCliRuns.get(run.id) !== mark) {
        if (this.seenCliRuns.size >= 200) this.seenCliRuns.clear();
        this.seenCliRuns.set(run.id, mark);
        void this.readCli(run.harness, true);
      }
    }
  }

  /** A harness's own count of its windows, heard on the stream of a run
   *  here (Claude Code's `rate_limit_event`, Codex's
   *  `account/rateLimits/updated`): the reading while no endpoint gives one.
   *  It is kept across a restart, since only a run can say it again. */
  onHeard(harness: Harness, heard: Heard): void {
    const current = this.get(harness);
    const next = hear(current, heard, this.now());
    if (next === current) return;
    this.readings.set(harness, next);
    this.keep();
    this.changed();
    // a new reset is a new time to read again; the share moving alone must
    // not push the clock back with every event
    if (next.fiveHour?.resetsAt !== current.fiveHour?.resetsAt || next.weekly?.resetsAt !== current.weekly?.resetsAt) this.schedule();
  }

  get(harness: Harness): Capacity {
    return this.readings.get(harness) ?? emptyCapacity(harness);
  }

  /** one per HARNESSES entry, in that order */
  list(): Capacity[] {
    return HARNESSES.map((harness) => this.get(harness));
  }

  info(): CapacityInfo {
    let held: HeldStart[] = [];
    try {
      held = this.deps.held?.() ?? [];
    } catch (error) {
      console.error("capacity: the held starts", error);
    }
    return { capacity: this.list(), held, settings: this.settings };
  }

  /** The governor for one start: interactive always goes, anything else as
   *  `decide` reads this harness now. */
  may(harness: Harness, priority: Priority): Decision {
    return decide(this.get(harness), priority, this.settings, this.now());
  }

  /** A held start appeared or went: the event says so, once the burst is over. */
  touch(): void {
    this.changed();
  }

  /** Read each endpoint (when present), CLI reader, or estimate from the ledger. */
  async refresh(): Promise<void> {
    const now = this.now();
    this.settings = (await this.deps.config()).capacity;
    const rows = await this.deps.ledger(now - FIVE_HOURS);
    const expired = this.dropExpired(now);
    const cliTasks: Promise<void>[] = [];
    for (const harness of HARNESSES) {
      const current = this.get(harness);
      if (this.reader) {
        try {
          const windows = readUsage(await this.reader(harness), now);
          this.readings.set(harness, { ...current, ...windows, source: "endpoint" });
        } catch (error) {
          if (!this.readerFailures.has(harness)) {
            this.readerFailures.add(harness);
            console.error(`capacity: ${harness} usage read failed`, error);
          }
        }
      } else {
        this.readings.set(harness, observe(current, rows, this.settings, now));
        if (this.cliReaders[harness]) cliTasks.push(this.readCli(harness, false));
      }
    }
    if (cliTasks.length > 0) await Promise.all(cliTasks);
    if (expired) await this.persist();
    this.changed();
    this.schedule();
  }

  /** Reads one harness via its CLI reader, coalescing overlapping calls. */
  private readCli(harness: Harness, standalone: boolean): Promise<void> {
    const existing = this.cliInFlight.get(harness);
    if (existing) return existing;
    const reader = this.cliReaders[harness];
    if (!reader || this.stopped) return Promise.resolve();
    const task = (async () => {
      try {
        const now = this.now();
        const windows = await reader(now);
        if (this.stopped || !windows) return;
        const current = this.get(harness);
        const next = mergeCli(current, windows, now);
        this.readerFailures.delete(harness);
        if (next === current) return;
        this.readings.set(harness, next);
        this.keep();
        if (standalone) {
          this.changed();
          this.schedule();
        }
      } catch (error) {
        if (!this.readerFailures.has(harness)) {
          this.readerFailures.add(harness);
          console.error(`capacity: ${harness} usage read failed`, error);
        }
      } finally {
        this.cliInFlight.delete(harness);
      }
    })();
    this.cliInFlight.set(harness, task);
    return task;
  }

  /** null for a path outside /api/capacity. GET reads; a POST there is a
   *  settings patch (admin); `read` refreshes now and `release` starts one
   *  held start as interactive (operate). */
  async handle(req: Request, url: URL): Promise<Response | null> {
    const path = url.pathname;
    if (path !== "/api/capacity" && path !== "/api/capacity/read" && path !== "/api/capacity/release") return null;
    if (req.method === "GET" && path === "/api/capacity") return json(this.info());
    if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
    const body: unknown = await req.json().catch(() => (path === "/api/capacity/read" ? {} : null));
    if (path === "/api/capacity") {
      if (!this.deps.saveSettings) return json({ error: "this backend cannot change the capacity settings" }, 501);
      const next = patchCapacity(this.settings, body);
      if (typeof next === "string") return json({ error: next }, 400);
      await this.deps.saveSettings(next);
      this.settings = next;
      await this.refresh();
      return json(this.info());
    }
    if (path === "/api/capacity/read") {
      await this.refresh();
      return json(this.info());
    }
    const id = isRecord(body) ? body["id"] : undefined;
    if (typeof id !== "string" || !id) return json({ error: "name the held start by its id" }, 400);
    if (!this.deps.release) return json({ error: "this backend holds no starts" }, 501);
    if (!this.info().held.some((h) => h.id === id)) return json({ error: `nothing is held as ${id}` }, 404);
    try {
      await this.deps.release(id);
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : String(error) }, 409);
    }
    this.changed();
    return json(this.info());
  }

  /** What `capacity.json` kept: each harness's hit, and the windows a run
   *  counted. A run that already spoke since the start is not overwritten. */
  private async readKept(): Promise<void> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(this.deps.file, "utf8"));
    } catch {
      return;
    }
    if (!isRecord(parsed)) return;
    for (const [name, value] of Object.entries(isRecord(parsed["windows"]) ? parsed["windows"] : {})) {
      if (!isHarness(name) || !isRecord(value)) continue;
      const current = this.get(name);
      if (current.source !== "unknown") continue;
      const source: CapacitySource = value["source"] === "cli" ? "cli" : "run";
      const fiveHour = keptWindow(value["fiveHour"], source === "cli");
      const weekly = keptWindow(value["weekly"], source === "cli");
      if (fiveHour || weekly) this.readings.set(name, { ...current, fiveHour, weekly, source });
    }
    for (const [name, value] of Object.entries(isRecord(parsed["hits"]) ? parsed["hits"] : {})) {
      if (!isHarness(name) || !isCapacityHit(value)) continue;
      const current = this.get(name);
      this.readings.set(name, { ...current, hit: value, source: hitSource(current.source) });
    }
  }

  /** Drops what has ended: a hit past its reset and grace, and a run's
   *  window past its reset. True when the kept file is now wrong. */
  private dropExpired(now: number): boolean {
    let dropped = false;
    for (const harness of HARNESSES) {
      const current = this.get(harness);
      let next = current;
      if (next.hit && !hitStands(next.hit, now)) {
        next = { ...next, hit: null, source: harness !== "claude" && next.source === "observed" ? "unknown" : next.source };
      }
      next = fade(next, now);
      if (next === current) continue;
      this.readings.set(harness, next);
      dropped = true;
    }
    return dropped;
  }

  /** Writes the file after a change; a failure is said and the reading stands. */
  private keep(): void {
    void this.persist().catch((error: unknown) => {
      console.error(`capacity: could not write ${this.deps.file}`, error);
    });
  }

  private persist(): Promise<void> {
    const hits: Partial<Record<Harness, CapacityHit>> = {};
    const windows: Partial<Record<Harness, Pick<Capacity, "fiveHour" | "weekly"> & { source?: "cli" }>> = {};
    for (const harness of HARNESSES) {
      const current = this.get(harness);
      if (current.hit) hits[harness] = current.hit;
      if (current.source === "run") windows[harness] = { fiveHour: current.fiveHour, weekly: current.weekly };
      else if (current.source === "cli") windows[harness] = { fiveHour: current.fiveHour, weekly: current.weekly, source: "cli" };
    }
    const content = JSON.stringify(Object.keys(windows).length > 0 ? { hits, windows } : { hits });
    const write = async (): Promise<void> => {
      await mkdir(dirname(this.deps.file), { recursive: true });
      await writeFile(this.deps.file, content, { mode: 0o600 });
      await chmod(this.deps.file, 0o600);
    };
    const queued = this.writeQueue.catch(() => undefined).then(write);
    this.writeQueue = queued;
    return queued;
  }

  private schedule(forceEvery = false): void {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    const now = this.now();
    const hasStandingHit = HARNESSES.some((harness) => hitStands(this.get(harness).hit, now));
    let wait = forceEvery || hasStandingHit ? this.every : this.idle;
    // a hit's end comes at its reset plus the grace: read again then, so
    // the work held on it goes as soon as it may rather than a read later
    for (const harness of HARNESSES) {
      const current = this.get(harness);
      const hit = current.hit;
      if (hit && hitStands(hit, now)) wait = Math.min(wait, Math.max(0, hit.resetsAt + HIT_GRACE - now) + 250);
      // a run's or CLI's window ends at its reset, and what is held on it goes then
      if (current.source !== "run" && current.source !== "cli") continue;
      for (const window of [current.fiveHour, current.weekly]) {
        if (window !== null && window.resetsAt !== null) wait = Math.min(wait, Math.max(0, window.resetsAt - now) + 250);
      }
    }
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.refresh().catch((error: unknown) => {
        console.error("capacity: refresh failed", error);
        this.schedule();
      });
    }, wait);
  }

  /** Debounce and send the full info only when its serialized shape changes. */
  private changed(): void {
    if (this.pending || this.stopped) return;
    this.pending = setTimeout(() => {
      this.pending = null;
      if (this.stopped) return;
      const info = this.info();
      const text = JSON.stringify(info);
      const readings = JSON.stringify({ capacity: info.capacity, settings: info.settings });
      if (readings !== this.woke) {
        this.woke = readings;
        try {
          this.deps.wake?.();
        } catch (error) {
          console.error("capacity: wake", error);
        }
      }
      if (text === this.sent) return;
      this.sent = text;
      try {
        this.deps.broadcast({ type: "capacity", capacity: info });
      } catch (error) {
        console.error("capacity: broadcast", error);
      }
    }, this.deps.debounce ?? 250);
  }
}
