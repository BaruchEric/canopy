/** The kit's server side: scans, routes and the `kit` event
 *  (docs/superpowers/specs/2026-10-14-kit-design.md). */
import { homedir } from "node:os";
import { join } from "node:path";
import { onHost } from "../core/exec";
import { cellsOf, parseKit, planKit } from "../core/kit";
import { applyKit } from "../core/kitapply";
import { seeKit } from "../core/kitscan";
import type { KitAction, KitApplyResult, KitInfo, KitManifest, KitMachineView, KitSeen, ServerEvent } from "../core/types";

export const KIT_EVERY = 10 * 60_000;

export const kitPath = (): string => process.env["CANOPY_KIT"] ?? join(homedir(), ".claude", "kit.json");

export interface KitHubDeps {
  self: string;
  devRoot: string;
  kitPath: string;
  broadcast(ev: ServerEvent): void;
  run?: typeof onHost;
  env?: Record<string, string>;
  /** 0 turns the clock off (tests) */
  every?: number;
  now?: () => number;
}

class KitError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

interface Mine { name: string; host: string | null; dev: string }

export class KitHub {
  private last: KitInfo = { ok: false, error: "not scanned yet", machines: [], cells: [] };
  private kit: KitManifest | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private scanning: Promise<KitInfo> | null = null;
  private views = new Map<string, { seen: KitSeen; dev: string }>();

  constructor(private readonly deps: KitHubDeps) {}

  start(): void {
    void this.scan();
    const every = this.deps.every ?? KIT_EVERY;
    if (every > 0) this.timer = setInterval(() => void this.scan(), every);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  info(): KitInfo {
    return this.last;
  }

  private mine(kit: KitManifest): Mine[] {
    const out: Mine[] = [];
    for (const m of kit.machines) {
      if (m.backend === this.deps.self) out.push({ name: m.name, host: null, dev: this.deps.devRoot });
      else if (m.ssh && m.via === this.deps.self && m.dev) out.push({ name: m.name, host: m.ssh, dev: m.dev });
    }
    return out;
  }

  private async read(): Promise<KitManifest> {
    let raw: unknown;
    try {
      raw = JSON.parse(await Bun.file(this.deps.kitPath).text());
    } catch (err) {
      throw new KitError(`kit.json: ${err instanceof Error ? err.message : String(err)}`, 500);
    }
    const r = parseKit(raw);
    if ("errors" in r) throw new KitError(`kit.json: ${r.errors.join("; ")}`, 500);
    return r.kit;
  }

  scan(): Promise<KitInfo> {
    this.scanning ??= this.doScan().finally(() => { this.scanning = null; });
    return this.scanning;
  }

  /** each machine publishes as its own scan ends, so a slow ssh machine
   *  (gpd waiting on a Tailscale browser check) never holds up the others */
  private async doScan(): Promise<KitInfo> {
    let kit: KitManifest;
    try {
      kit = await this.read();
    } catch (err) {
      this.kit = null;
      this.views.clear();
      this.last = { ok: false, error: err instanceof Error ? err.message : String(err), machines: [], cells: [] };
      this.deps.broadcast({ type: "kit", kit: this.last });
      return this.last;
    }
    this.kit = kit;
    const mine = this.mine(kit);
    for (const name of this.views.keys()) if (!mine.some((m) => m.name === name)) this.views.delete(name);
    await Promise.all(mine.map((m) => this.scanOne(kit, m)));
    return this.last;
  }

  private async scanOne(kit: KitManifest, m: Mine): Promise<void> {
    // a throw here would reject the scan, and nothing awaits the timer's
    // scans: an unhandled rejection ends the server
    const seen = await seeKit(kit, m, { run: this.deps.run, env: this.deps.env, now: this.deps.now }).catch(
      (err: unknown): KitSeen => ({ machine: m.name, at: (this.deps.now ?? Date.now)(), away: err instanceof Error ? err.message : String(err), home: "", store: null, targets: [], sources: {} }),
    );
    this.views.set(m.name, { seen, dev: m.dev });
    this.publish(kit);
  }

  private publish(kit: KitManifest): void {
    const vs = this.mine(kit).map((m) => this.views.get(m.name)).filter((v): v is { seen: KitSeen; dev: string } => !!v);
    const machines: KitMachineView[] = vs.map((v) => ({ machine: v.seen.machine, seen: v.seen, plan: planKit(kit, v.seen, v.dev) }));
    this.last = { ok: true, error: null, machines, cells: cellsOf(kit, vs) };
    this.deps.broadcast({ type: "kit", kit: this.last });
  }

  async apply(machine: string, actions?: KitAction[], dryRun = false): Promise<KitApplyResult> {
    if (!this.kit) throw new KitError(this.last.error ?? "kit.json not read", 409);
    const view = this.last.machines.find((m) => m.machine === machine);
    if (!view) throw new KitError(`not a machine this backend reaches: ${machine}`, 400);
    if (view.seen.away) throw new KitError(`${machine} is away: ${view.seen.away}`, 409);
    const planned = new Set(view.plan.map((a) => JSON.stringify(a)));
    if (actions && !actions.every((a) => planned.has(JSON.stringify(a)))) throw new KitError("an action is not in the current plan; rescan first", 409);
    const todo = actions ?? view.plan;
    if (dryRun) return { machine, done: todo, failed: [] };
    const m = this.mine(this.kit).find((x) => x.name === machine)!;
    const r = await applyKit(view.seen, m.host, todo, { run: this.deps.run, env: this.deps.env });
    await this.scanOne(this.kit, m);
    return r;
  }

  async handle(req: Request, url: URL): Promise<Response | null> {
    const path = url.pathname;
    if (!path.startsWith("/api/kit")) return null;
    try {
      if (path === "/api/kit" && req.method === "GET") return json(this.last);
      if (path === "/api/kit/scan" && req.method === "POST") return json(await this.scan());
      if (path === "/api/kit/apply" && req.method === "POST") {
        const body = (await req.json().catch(() => ({}))) as { machine?: unknown; actions?: unknown; dryRun?: unknown };
        if (typeof body.machine !== "string") return json({ error: "machine is required" }, 400);
        const actions = Array.isArray(body.actions) ? (body.actions as KitAction[]) : undefined;
        return json(await this.apply(body.machine, actions, body.dryRun === true));
      }
    } catch (err) {
      if (err instanceof KitError) return json({ error: err.message }, err.status);
      throw err;
    }
    return null;
  }
}
