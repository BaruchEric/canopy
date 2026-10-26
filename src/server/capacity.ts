/**
 * The capacity readings: one `Capacity` per harness from the ledger, every
 * limited run and, when configured, a usage reader; the hits across restarts
 * in `capacity.json`; the route and the event. Bun-only.
 */

import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  DEFAULT_CAPACITY,
  FIVE_HOURS,
  READ_EVERY,
  READ_IDLE,
  emptyCapacity,
  hitStands,
  limitHit,
  observe,
  readUsage,
  type Capacity,
  type CapacityHit,
  type CapacitySettings,
} from "../core/capacity";
import type { CostEntry } from "../core/costs";
import { configDir } from "../core/store";
import {
  HARNESSES,
  isHarness,
  type CanopyConfig,
  type CapacityInfo,
  type Harness,
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
}

const json = (data: unknown): Response =>
  new Response(JSON.stringify(data), { headers: { "content-type": "application/json" } });

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

  /** A run change: a new limited mark becomes its harness's hit. */
  onRun(run: Run): void {
    const limited = run.limited;
    if (!limited || this.seenRuns.get(run.id) === limited.at) return;
    const hit = limitHit(limited.text, limited.at);
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
    return { capacity: this.list(), held: [], settings: this.settings };
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

  /** null for a path outside /api/capacity */
  async handle(req: Request, url: URL): Promise<Response | null> {
    if (req.method !== "GET" || url.pathname !== "/api/capacity") return null;
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
    const hasStandingHit = HARNESSES.some((harness) => hitStands(this.get(harness).hit, this.now()));
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.refresh().catch((error: unknown) => {
        console.error("capacity: refresh failed", error);
        this.schedule();
      });
    }, forceEvery || hasStandingHit ? this.every : this.idle);
  }

  /** Debounce and send the full info only when its serialized shape changes. */
  private changed(): void {
    if (this.pending || this.stopped) return;
    this.pending = setTimeout(() => {
      this.pending = null;
      if (this.stopped) return;
      const info = this.info();
      const text = JSON.stringify(info);
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
