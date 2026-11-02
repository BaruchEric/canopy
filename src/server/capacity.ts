/**
 * The capacity readings: one `Capacity` per harness from the ledger, every
 * limited run and, when configured, a usage reader; the hits across restarts
 * in `capacity.json`; the governor's `may` for the Runner and the pumps; the
 * starts the pumps hold, read from their owners; the routes and the event.
 * Bun-only.
 */

import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  DEFAULT_CAPACITY,
  FIVE_HOURS,
  HIT_GRACE,
  READ_EVERY,
  READ_IDLE,
  decide,
  emptyCapacity,
  hitOfLimited,
  hitStands,
  observe,
  patchCapacity,
  readUsage,
  type Capacity,
  type CapacityHit,
  type CapacitySettings,
  type Decision,
} from "../core/capacity";
import type { CostEntry } from "../core/costs";
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

export interface CapacityHubDeps {
  broadcast: (event: ServerEvent) => void;
  /** the ledger's rows since `since` (readCosts) */
  ledger: (since: number) => Promise<CostEntry[]>;
  config: () => Promise<Pick<CanopyConfig, "capacity">>;
  /** where the hits live across restarts: capacityFile() */
  file: string;
  reader?: UsageReader | null;
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

export class CapacityHub {
  private readonly readings = new Map<Harness, Capacity>();
  private readonly seenRuns = new Map<string, number>();
  private readonly readerFailures = new Set<Harness>();
  private readonly now: () => number;
  private readonly every: number;
  private readonly idle: number;
  private readonly reader: UsageReader | null;
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
    for (const harness of HARNESSES) this.readings.set(harness, emptyCapacity(harness));
  }

  /** Read persisted hits, drop expired ones, read current usage and start the clock. */
  async start(): Promise<void> {
    if (this.started || this.stopped) return;
    this.started = true;
    await this.readHits();
    if (this.dropExpired(this.now())) await this.persist();
    await this.refresh();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.pending) clearTimeout(this.pending);
    this.timer = null;
    this.pending = null;
  }

  /** A run change: a new limited mark becomes its harness's hit, at the
   *  CLI's own reset when its rate-limit event named one. */
  onRun(run: Run): void {
    const limited = run.limited;
    if (!limited || this.seenRuns.get(run.id) === limited.at) return;
    const hit = hitOfLimited(limited);
    if (!hit) return;
    this.seenRuns.set(run.id, limited.at);
    const current = this.get(run.harness);
    this.readings.set(run.harness, {
      ...current,
      hit,
      source: current.source === "endpoint" ? "endpoint" : "observed",
    });
    void this.persist().catch((error: unknown) => {
      console.error(`capacity: could not write ${this.deps.file}`, error);
    });
    this.changed();
    this.schedule(true);
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

  /** Read each endpoint (when present) or estimate from the ledger. */
  async refresh(): Promise<void> {
    const now = this.now();
    this.settings = (await this.deps.config()).capacity;
    const rows = await this.deps.ledger(now - FIVE_HOURS);
    const expired = this.dropExpired(now);
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
      }
    }
    if (expired) await this.persist();
    this.changed();
    this.schedule();
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

  private async readHits(): Promise<void> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(this.deps.file, "utf8"));
    } catch {
      return;
    }
    if (!isRecord(parsed) || !isRecord(parsed["hits"])) return;
    for (const [name, value] of Object.entries(parsed["hits"])) {
      if (!isHarness(name) || !isCapacityHit(value)) continue;
      const current = this.get(name);
      this.readings.set(name, {
        ...current,
        hit: value,
        source: current.source === "endpoint" ? "endpoint" : "observed",
      });
    }
  }

  private dropExpired(now: number): boolean {
    let dropped = false;
    for (const harness of HARNESSES) {
      const current = this.get(harness);
      if (current.hit && !hitStands(current.hit, now)) {
        this.readings.set(harness, {
          ...current,
          hit: null,
          source: harness === "codex" && current.source === "observed" ? "unknown" : current.source,
        });
        dropped = true;
      }
    }
    return dropped;
  }

  private persist(): Promise<void> {
    const hits: Partial<Record<Harness, CapacityHit>> = {};
    for (const harness of HARNESSES) {
      const hit = this.get(harness).hit;
      if (hit) hits[harness] = hit;
    }
    const content = JSON.stringify({ hits });
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
      const hit = this.get(harness).hit;
      if (hit && hitStands(hit, now)) wait = Math.min(wait, Math.max(0, hit.resetsAt + HIT_GRACE - now) + 250);
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
