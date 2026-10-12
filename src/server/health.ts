/**
 * The health hub (docs/superpowers/specs/2026-10-12-health-design.md): every
 * check this backend keeps, canopy's own pieces and the checks repos
 * declare. A check is polled (`probe` and `every`) or fed (`report`, for a
 * piece that already says when it changes, like tailchan's stream or the
 * ranger). The model in core/health.ts decides; this owns the timers, runs
 * the heals, and sends the whole list as a `health` event whenever it
 * changed.
 *
 * - A poll never overlaps itself, and a probe is cut at its timeout, so one
 *   that hangs costs one failed probe, not the loop.
 * - An auto heal runs at the check's `nextHeal`, then the probe again; a
 *   check with no probe waits for its next report to say how the heal went.
 * - A give-up calls `onGaveUp` once, which DMs the human when tailchan is up.
 */

import { HEALTH_TIMINGS, healFailed, manualHeal, newCheck, observe, type HealAction, type HealthTimings, type ProbeResult } from "../core/health";
import type { HealMode, HealthCheck, HealthScope, RangerInfo, ServerEvent } from "../core/types";

/** how long a probe may take unless its def says */
const PROBE_TIMEOUT = 10_000;
/** how long a heal may take unless its def says */
const HEAL_TIMEOUT = 60_000;

export interface CheckDef {
  id: string;
  label: string;
  scope: HealthScope;
  heal: HealMode;
  /** ms between polls; with `probe` the check is polled */
  every?: number;
  probe?: () => Promise<ProbeResult>;
  /** ms a probe may take */
  timeout?: number;
  /** what a heal does; without one a check heals by no hand of canopy's */
  doHeal?: () => Promise<void>;
  /** ms a heal may take */
  healTimeout?: number;
}

export interface HealthHubDeps {
  broadcast: (ev: ServerEvent) => void;
  onGaveUp?: (c: HealthCheck) => void;
  now?: () => number;
  timings?: HealthTimings;
  /** ms between a change and its event, so a burst sends one */
  debounce?: number;
}

export class HealthError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

interface Entry {
  def: CheckDef;
  check: HealthCheck;
  poll: ReturnType<typeof setInterval> | null;
  probing: boolean;
  healTimer: ReturnType<typeof setTimeout> | null;
  /** a heal is running */
  healing: boolean;
  /** a heal ran on a fed check; its next report says how it went */
  awaitingReport: boolean;
}

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

/** a promise cut at `ms`, rejecting with "timed out" */
function within<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const cut = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("timed out")), ms);
  });
  return Promise.race([p, cut]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

const words = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** the button can heal it: there is a heal, and the mode lets a hand run it */
const hasButton = (def: CheckDef): boolean => def.doHeal !== undefined && def.heal !== "none";

/** an auto check with no heal to run heals by no hand of ours */
const modeOf = (def: CheckDef): HealMode => (def.heal === "auto" && !def.doHeal ? "none" : def.heal);

export class HealthHub {
  private entries = new Map<string, Entry>();
  private sent = "";
  private pending: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private readonly now: () => number;
  private readonly t: HealthTimings;

  constructor(private readonly deps: HealthHubDeps) {
    this.now = deps.now ?? Date.now;
    this.t = deps.timings ?? HEALTH_TIMINGS;
  }

  /** a check, or a new def for one already kept (its state and history stay) */
  add(def: CheckDef): void {
    if (this.stopped) return;
    const old = this.entries.get(def.id);
    if (old) this.clearTimers(old);
    const shape = { id: def.id, label: def.label, scope: def.scope, heal: modeOf(def), button: hasButton(def) };
    const check = old ? { ...old.check, ...shape } : newCheck(shape, this.now());
    const e: Entry = { def, check, poll: null, probing: false, healTimer: null, healing: false, awaitingReport: old?.awaitingReport ?? false };
    this.entries.set(def.id, e);
    if (def.probe && def.every) {
      e.poll = setInterval(() => void this.probeNow(def.id), def.every);
      void this.probeNow(def.id);
    }
    // a pending heal carries over to the new def
    if (check.state === "healing" && check.nextHeal !== null) this.scheduleHeal(e);
    this.changed();
  }

  remove(id: string): void {
    const e = this.entries.get(id);
    if (!e) return;
    this.clearTimers(e);
    this.entries.delete(id);
    this.changed();
  }

  has(id: string): boolean {
    return this.entries.has(id);
  }

  /** the ids kept under a prefix, for a caller that keeps a family of checks */
  ids(prefix: string): string[] {
    return [...this.entries.keys()].filter((id) => id.startsWith(prefix));
  }

  /** what a piece says of itself, for a check fed rather than polled */
  report(id: string, r: ProbeResult): void {
    const e = this.entries.get(id);
    if (!e || this.stopped) return;
    if (e.awaitingReport && r.state === "down") {
      e.awaitingReport = false;
      this.afterHeal(e, r.why);
      return;
    }
    if (r.state !== "down") e.awaitingReport = false;
    this.apply(e, r);
  }

  /** one probe now, unless one is already running */
  async probeNow(id: string): Promise<void> {
    const e = this.entries.get(id);
    if (!e?.def.probe || e.probing || e.healing || this.stopped) return;
    const r = await this.runProbe(e);
    if (this.entries.get(id) !== e || this.stopped) return;
    this.apply(e, r);
  }

  /** The button: start counting again and heal now. 404 for an unknown
   *  check, 409 for one no hand here can heal. */
  async heal(id: string): Promise<HealthCheck> {
    const e = this.entries.get(id);
    if (!e) throw new HealthError(404, `no check ${id}`);
    if (!hasButton(e.def)) throw new HealthError(409, `${e.check.label} has no heal canopy can run`);
    if (e.healing) return e.check;
    if (e.healTimer) clearTimeout(e.healTimer);
    e.healTimer = null;
    e.check = manualHeal(e.check, this.now());
    this.changed();
    await this.runHeal(e);
    return this.entries.get(id)?.check ?? e.check;
  }

  /** every check, canopy's first, then by id */
  list(): HealthCheck[] {
    return [...this.entries.values()]
      .map((e) => e.check)
      .sort((a, b) => (a.scope.kind === b.scope.kind ? a.id.localeCompare(b.id) : a.scope.kind === "canopy" ? -1 : 1));
  }

  get(id: string): HealthCheck | undefined {
    return this.entries.get(id)?.check;
  }

  async handle(req: Request, url: URL): Promise<Response | null> {
    const path = url.pathname;
    if (path === "/api/health" && req.method === "GET") return json({ checks: this.list() });
    if (path === "/api/health/heal" && req.method === "POST") {
      try {
        return json(await this.heal(url.searchParams.get("id") ?? ""));
      } catch (err) {
        if (err instanceof HealthError) return json({ error: err.message }, err.status);
        throw err;
      }
    }
    return null;
  }

  stop(): void {
    this.stopped = true;
    for (const e of this.entries.values()) this.clearTimers(e);
    if (this.pending) clearTimeout(this.pending);
    this.pending = null;
  }

  private clearTimers(e: Entry): void {
    if (e.poll) clearInterval(e.poll);
    if (e.healTimer) clearTimeout(e.healTimer);
    e.poll = null;
    e.healTimer = null;
  }

  private async runProbe(e: Entry): Promise<ProbeResult> {
    const probe = e.def.probe;
    if (!probe) return { state: "down", why: "no probe" };
    e.probing = true;
    try {
      return await within(probe(), e.def.timeout ?? PROBE_TIMEOUT);
    } catch (err) {
      return { state: "down", why: words(err) };
    } finally {
      e.probing = false;
    }
  }

  private apply(e: Entry, r: ProbeResult): void {
    const { check, action } = observe(e.check, r, this.now(), this.t);
    e.check = check;
    this.act(e, action);
    this.changed();
  }

  private act(e: Entry, action: HealAction): void {
    if (action === "heal") this.scheduleHeal(e);
    else if (action === "escalate") {
      try {
        this.deps.onGaveUp?.(e.check);
      } catch (err) {
        console.error("health: telling of a give-up", err);
      }
    }
  }

  private scheduleHeal(e: Entry): void {
    if (e.healing || e.healTimer || e.check.nextHeal === null) return;
    const wait = Math.max(0, e.check.nextHeal - this.now());
    e.healTimer = setTimeout(() => {
      e.healTimer = null;
      void this.runHeal(e);
    }, wait);
  }

  /** the heal, then the probe again; a fed check waits for its next report */
  private async runHeal(e: Entry): Promise<void> {
    if (e.healing || this.stopped) return;
    const doHeal = e.def.doHeal;
    if (!doHeal) return;
    e.healing = true;
    let failed: string | null = null;
    try {
      await within(doHeal(), e.def.healTimeout ?? HEAL_TIMEOUT);
    } catch (err) {
      failed = `the heal failed: ${words(err)}`;
    }
    if (failed === null && e.def.probe) {
      const r = await this.runProbe(e);
      e.healing = false;
      if (this.entries.get(e.def.id) !== e || this.stopped) return;
      if (r.state === "down") this.afterHeal(e, r.why);
      else this.apply(e, r);
      return;
    }
    e.healing = false;
    if (this.entries.get(e.def.id) !== e || this.stopped) return;
    if (failed !== null) this.afterHeal(e, failed);
    else e.awaitingReport = true;
  }

  private afterHeal(e: Entry, why: string): void {
    const { check, action } = healFailed(e.check, why, this.now(), this.t);
    e.check = check;
    this.act(e, action);
    this.changed();
  }

  /** the event, once a burst settles, and only when something differs */
  private changed(): void {
    if (this.pending || this.stopped) return;
    this.pending = setTimeout(() => {
      this.pending = null;
      const checks = this.list();
      const text = JSON.stringify(checks);
      if (text === this.sent) return;
      this.sent = text;
      try {
        this.deps.broadcast({ type: "health", checks });
      } catch (err) {
        console.error("health: broadcast", err);
      }
    }, this.deps.debounce ?? 250);
  }
}

/** The ranger's own state as a check: it restarts itself with backoff and
 *  DMs when it gives up, so health only reports. */
export function rangerResult(r: Pick<RangerInfo, "on" | "state" | "why">): ProbeResult {
  if (!r.on || r.state === "off") return { state: "off" };
  switch (r.state) {
    case "running":
      return { state: "ok" };
    case "starting":
    case "trust":
    case "backoff":
      return { state: "healing", why: r.why ?? r.state };
    case "gave-up":
      return { state: "gave-up", why: r.why ?? "it exited too often" };
    case "no-tmux":
      return { state: "down", why: r.why ?? "this backend has no tmux" };
    case "no-claude":
      return { state: "down", why: r.why ?? "Claude Code is not installed here" };
    case "handle-taken":
      return { state: "down", why: r.why ?? "another backend's agent has its handle" };
    case "error":
      return { state: "down", why: r.why ?? "it cannot start" };
  }
}

/** A tailchan stream's state as a check: it redials itself (and drops a
 *  stream that went silent), so down here means it is redialing. */
export const streamResult = (up: boolean): ProbeResult => (up ? { state: "ok" } : { state: "down", why: "the stream to the broker dropped; redialing" });
