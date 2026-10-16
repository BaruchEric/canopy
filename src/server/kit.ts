/** The kit's server side: scans, routes and the `kit` event
 *  (docs/superpowers/specs/2026-10-14-kit-design.md). */
import { homedir } from "node:os";
import { join } from "node:path";
import { onHost } from "../core/exec";
import { cellsOf, hasSecrets, maskEntry, needsSudo, OWNED_NOT_IGNORED, mcpDefOf, mcpHash, mcpTargets, mcpWanted, parseKit, planKit, planMcp, secretsOf, wantLink } from "../core/kit";
import { applyKit } from "../core/kitapply";
import { seeKit, seeMcp, seeTools } from "../core/kitscan";
import type {
  KitAction, KitApplyResult, KitInfo, KitInstallResult, KitManifest, KitMachineView, KitMcpCtx, KitMcpEntry, KitMcpFormat, KitMcpPreview, KitMcpSeen, KitMcpView, KitSeen, SecretsInfo, ServerEvent,
} from "../core/types";

export const KIT_EVERY = 10 * 60_000;
/** an install line's time: a package manager can take a while */
export const INSTALL_TIMEOUT = 10 * 60_000;

/** runs one install line in the machine's login shell, so it sees the PATH a person's terminal has */
export const INSTALL_SCRIPT = String.raw`ls=$SHELL; [ -n "$ls" ] || ls=sh
exec "$ls" -lc "$1" </dev/null 2>&1`;

/** the last lines of an install's output */
const tail = (text: string, n = 40): string => text.trimEnd().split("\n").slice(-n).join("\n");

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
  /** the store's metadata as this backend sees it (SecretsHub.info(null)); absent: no store here */
  secrets?: () => Promise<SecretsInfo | null>;
  /** the home ~ stands for in what the kit writes on this backend's own machine: the mini's canopy runs as /home/bun but writes for /home/eric */
  hostHome?: string;
  /** where ${env:NAME} resolves; this process's environment by default */
  procEnv?: Record<string, string | undefined>;
}

class KitError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

interface Mine { name: string; host: string | null; dev: string }

interface View { seen: KitSeen; dev: string; mcp: KitMcpSeen | null; ssh: boolean; mcpError: string | null }

export class KitHub {
  private last: KitInfo = { ok: false, error: "not scanned yet", machines: [], cells: [] };
  private kit: KitManifest | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private scanning: Promise<KitInfo> | null = null;
  private views = new Map<string, View>();
  private hashes: Record<string, string> = {};
  /** counts publishes begun, so one that answers late gives way to a newer one */
  private publishes = 0;
  /** per machine, every entry the kit would write there; never leaves this process */
  private entries = new Map<string, Record<string, KitMcpEntry>>();
  private mcpSeen = new Map<string, KitMcpSeen>();
  /** per machine, the last write in line: executes run one at a time */
  private chains = new Map<string, Promise<unknown>>();
  /** counts scans begun, and per machine the one its view came from, so a scan that began before a write never lands after the write's rescan */
  private scans = 0;
  private scanOf = new Map<string, number>();

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

  /** the machines this backend reaches over ssh (gpd from the Mac): the
   *  secrets reader writes their sinks (phase 3) */
  sshMachines(): { name: string; host: string }[] {
    return this.kit ? this.mine(this.kit).flatMap((m) => (m.host === null ? [] : [{ name: m.name, host: m.host }])) : [];
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
      this.entries.clear();
      this.mcpSeen.clear();
      this.last = { ok: false, error: err instanceof Error ? err.message : String(err), machines: [], cells: [] };
      this.deps.broadcast({ type: "kit", kit: this.last });
      return this.last;
    }
    // the hashes before the manifest, so a republish during the await never plans a new kit against old hashes
    this.hashes = Object.fromEntries(await Promise.all(kit.mcp.map(async (s) => [s.name, await mcpHash(mcpDefOf(s))] as const)));
    this.kit = kit;
    const mine = this.mine(kit);
    for (const name of this.views.keys()) if (!mine.some((m) => m.name === name)) this.views.delete(name);
    await Promise.all(mine.map((m) => this.scanOne(kit, m)));
    return this.last;
  }

  private async scanOne(kit: KitManifest, m: Mine): Promise<void> {
    const n = ++this.scans;
    // a throw here would reject the scan, and nothing awaits the timer's
    // scans: an unhandled rejection ends the server
    const seen = await seeKit(kit, m, { run: this.deps.run, env: this.deps.env, now: this.deps.now }).catch(
      (err: unknown): KitSeen => ({ machine: m.name, at: (this.deps.now ?? Date.now)(), away: err instanceof Error ? err.message : String(err), home: "", store: null, targets: [], sources: {} }),
    );
    // after the skills scan, so an ssh machine that is away is not waited on twice
    if (!seen.away && kit.tools.length > 0) {
      await seeTools(kit, m, { run: this.deps.run, env: this.deps.env }).then(
        (t) => Object.assign(seen, t, { toolsError: null }),
        (err: unknown) => { seen.toolsError = err instanceof Error ? err.message : String(err); },
      );
    }
    let mcpError: string | null = null;
    const mcp = seen.away ? null : await seeMcp(kit, m, { run: this.deps.run, env: this.deps.env }).catch((err: unknown) => {
      mcpError = err instanceof Error ? err.message : String(err);
      return null;
    });
    // kit.json changed during the read (an apply's rescan racing a scan):
    // this read follows the old manifest, and the new one's scan paints it
    if (kit !== this.kit) return;
    if ((this.scanOf.get(m.name) ?? 0) > n) return;
    this.scanOf.set(m.name, n);
    this.views.set(m.name, { seen, dev: m.dev, mcp, ssh: m.host !== null, mcpError });
    await this.publish(kit);
  }

  /** the store's metadata changed (a `secrets` event): plans and cells
   *  follow without a rescan. Never rejects, since its caller does not wait. */
  async republish(): Promise<void> {
    if (this.kit) await this.publish(this.kit).catch(() => {});
  }

  /** an ssh machine's own home; this backend's machine writes for the host's */
  private homeOf(v: View): string {
    return v.ssh ? v.seen.home : (this.deps.hostHome ?? v.seen.home);
  }

  private ctxOf(v: View, secrets: SecretsInfo | null): KitMcpCtx | undefined {
    if (!v.mcp) return undefined;
    return { mcp: v.mcp, hashes: this.hashes, secrets, home: this.homeOf(v), env: this.deps.procEnv ?? process.env };
  }

  private mcpViews(kit: KitManifest): KitMcpView[] {
    return kit.mcp.filter(hasSecrets).map((s) => {
      const on = kit.machines.filter((m) => mcpTargets(kit, m.name).some((t) => mcpWanted(s, t.agent, m.name)));
      return {
        name: s.name, def: mcpDefOf(s), hash: this.hashes[s.name] ?? "", ...secretsOf(s),
        machines: on.map((m) => m.name),
      };
    });
  }

  private async publish(kit: KitManifest): Promise<void> {
    const n = ++this.publishes;
    const secrets = this.deps.secrets ? await this.deps.secrets().catch(() => null) : null;
    // During the read, kit.json may have changed (this.hashes are the new
    // kit's then), or a newer publish may have begun. That one reads every
    // view this one would and newer store metadata, so this result is dropped.
    if (kit !== this.kit || n !== this.publishes) return;
    const vs = this.mine(kit).map((m) => this.views.get(m.name)).filter((v): v is View => !!v);
    const machines: KitMachineView[] = [];
    const cellViews: { seen: KitSeen; dev: string; ctx?: KitMcpCtx; mcpError?: string | null }[] = [];
    for (const v of vs) {
      const ctx = this.ctxOf(v, secrets);
      if (ctx) {
        this.entries.set(v.seen.machine, planMcp(kit, v.seen, ctx).entries);
        this.mcpSeen.set(v.seen.machine, ctx.mcp);
      } else {
        this.entries.delete(v.seen.machine);
        this.mcpSeen.delete(v.seen.machine);
      }
      machines.push({ machine: v.seen.machine, seen: v.seen, plan: planKit(kit, v.seen, v.dev, ctx), home: this.homeOf(v) });
      cellViews.push({ seen: v.seen, dev: v.dev, ctx, mcpError: v.mcpError });
    }
    this.last = { ok: true, error: null, machines, cells: cellsOf(kit, cellViews), mcp: this.mcpViews(kit) };
    this.deps.broadcast({ type: "kit", kit: this.last });
  }

  private reach(machine: string): { kit: KitManifest; view: KitMachineView; m: Mine } {
    if (!this.kit) throw new KitError(this.last.error ?? "kit.json not read", 409);
    const view = this.last.machines.find((x) => x.machine === machine);
    if (!view) throw new KitError(`not a machine this backend reaches: ${machine}`, 400);
    if (view.seen.away) throw new KitError(`${machine} is away: ${view.seen.away}`, 409);
    const m = this.mine(this.kit).find((x) => x.name === machine);
    if (!m) throw new KitError(`not a machine this backend reaches: ${machine}`, 400);
    return { kit: this.kit, view, m };
  }

  /** One write at a time per machine, each call from its reach and checks
   *  on. applyMcp writes the whole ownership file from the scan it was
   *  given, so two overlapping writes would each save their own copy and
   *  the last would wipe the other's records. A refused call leaves the
   *  line for the next. */
  private serial<T>(machine: string, fn: () => Promise<T>): Promise<T> {
    const run = (this.chains.get(machine) ?? Promise.resolve()).then(fn);
    this.chains.set(machine, run.catch(() => {}));
    return run;
  }

  private async execute(machine: string, todo: KitAction[]): Promise<KitApplyResult> {
    const { kit, view, m } = this.reach(machine);
    // the view, not mcpSeen: scanOne sets it before it publishes, and a
    // publish that gives way to a newer one leaves mcpSeen behind
    const seen = this.views.get(machine)?.mcp;
    const formats: Record<string, KitMcpFormat> = Object.fromEntries(mcpTargets(kit, machine).map((t) => [t.agent, t.mcp.format]));
    const r = await applyKit(view.seen, m.host, todo, {
      run: this.deps.run, env: this.deps.env,
      mcp: seen ? { seen, entries: this.entries.get(machine) ?? {}, formats } : undefined,
    });
    // rescan against the manifest as it is now: one that changed during the
    // write has a scan in flight that read ownership before the write, and
    // only a newer scan numbered after it makes scanOf drop that one
    const now = this.kit ?? kit;
    await this.scanOne(now, this.mine(now).find((x) => x.name === machine) ?? m);
    return r;
  }

  /** the plan, or the part of it asked for; adopt and put back are never in a plan */
  apply(machine: string, actions?: KitAction[], dryRun = false): Promise<KitApplyResult> {
    return this.serial(machine, async () => {
      const { view } = this.reach(machine);
      const planned = new Set(view.plan.map((a) => JSON.stringify(a)));
      if (actions && !actions.every((a) => planned.has(JSON.stringify(a)))) throw new KitError("an action is not in the current plan; rescan first", 409);
      const todo = actions ?? view.plan;
      if (dryRun) return { machine, done: todo, failed: [] };
      return this.execute(machine, todo);
    });
  }

  private mcpCell(machine: string, agent: string, name: string) {
    return this.last.cells.find((c) => c.kind === "mcp" && c.machine === machine && c.agent === agent && c.skill === name);
  }

  /** Adopt hand-made entries the kit defines. Only an adoptable cell
   *  qualifies: a server with secrets is adoptable once its allowance
   *  and sink let the kit's version be written, so adopt never leaves a
   *  working server replaced by nothing (phase 2 plan, call 10). The
   *  batch holds adopts alone, since a set after an adopt in one batch
   *  would read the scan, not the adopt's result. */
  adopt(machine: string, agent: string, names?: string[]): Promise<KitApplyResult> {
    return this.serial(machine, async () => {
      this.reach(machine);
      if (this.views.get(machine)?.mcp?.ownedIgnored === false) throw new KitError(`adopt keeps the hand-made entry in ~/.claude/.canopy-kit-mcp.json, and ${OWNED_NOT_IGNORED}`, 409);
      const all = this.last.cells.filter((c) => c.kind === "mcp" && c.machine === machine && c.agent === agent);
      const pick = [...new Set(names ?? all.filter((c) => c.state === "adoptable").map((c) => c.skill))];
      if (pick.length === 0) throw new KitError(`nothing to adopt for ${agent} on ${machine}`, 409);
      for (const n of pick) {
        const c = this.mcpCell(machine, agent, n);
        if (c?.state !== "adoptable") throw new KitError(`${n} cannot be adopted: ${c ? c.why || c.state : "the kit has no such server here"}`, 409);
      }
      return this.execute(machine, pick.map((name): KitAction => ({ kind: "mcp-adopt", agent, name })));
    });
  }

  restore(machine: string, agent: string, name: string): Promise<KitApplyResult> {
    return this.serial(machine, async () => {
      this.reach(machine);
      if (!this.mcpCell(machine, agent, name)?.restore) throw new KitError(`canopy keeps no hand-made ${name} for ${agent} on ${machine}`, 409);
      return this.execute(machine, [{ kind: "mcp-restore", agent, name }]);
    });
  }

  private skillCell(machine: string, agent: string, name: string) {
    return this.last.cells.find((c) => c.kind === undefined && c.machine === machine && c.agent === agent && c.skill === name);
  }

  /** Move a hand-made skill aside and link the kit's. Only an adoptable
   *  cell qualifies: a link target's own entry for a store skill. */
  adoptSkill(machine: string, agent: string, name: string): Promise<KitApplyResult> {
    return this.serial(machine, async () => {
      const { kit, view, m } = this.reach(machine);
      const c = this.skillCell(machine, agent, name);
      if (c?.state !== "adoptable") throw new KitError(`${name} cannot be adopted for ${agent} on ${machine}: ${c ? c.why || c.state : "the kit has no such skill there"}`, 409);
      const t = view.seen.targets.find((x) => x.agent === agent);
      if (!t) throw new KitError(`${agent} is not a target on ${machine}`, 409);
      return this.execute(machine, [{ kind: "skill-adopt", agent, name, link: wantLink(kit, view.seen, t, name, m.dev) }]);
    });
  }

  restoreSkill(machine: string, agent: string, name: string): Promise<KitApplyResult> {
    return this.serial(machine, async () => {
      this.reach(machine);
      if (!this.skillCell(machine, agent, name)?.restore) throw new KitError(`canopy keeps no hand-made ${name} for ${agent} on ${machine}`, 409);
      return this.execute(machine, [{ kind: "skill-restore", agent, name }]);
    });
  }

  /** Run a missing tool's install line on its machine, then check again.
   *  The line comes from kit.json; the page sends the line it showed, and
   *  one that has changed since is refused rather than run unseen. A sudo
   *  line is never run: it cannot prompt over a non-interactive ssh. */
  install(machine: string, tool: string, line: string): Promise<KitInstallResult> {
    return this.serial(machine, async () => {
      const { kit, m } = this.reach(machine);
      if (!kit.tools.some((t) => t.name === tool)) throw new KitError(`${tool} is not a tool kit.json lists`, 404);
      const c = this.last.cells.find((x) => x.kind === "tool" && x.machine === machine && x.skill === tool);
      if (c?.state !== "missing" || !c.install) throw new KitError(`${tool} on ${machine} has nothing to install: ${c ? c.why || c.state : "not checked yet"}`, 409);
      if (c.container) throw new KitError(`${machine} checks its tools in canopy's container, where an install would be gone at the next recreate; add ${tool} to the image`, 409);
      if (c.sudo || needsSudo(c.install)) throw new KitError(`${tool}'s install line uses sudo, which cannot prompt over a non-interactive ssh; run it in a terminal on ${machine}`, 409);
      if (c.install !== line) throw new KitError(`${tool}'s install line has changed since it was shown; look at it again`, 409);
      const r = await (this.deps.run ?? onHost)(m.host, ["sh", "-c", INSTALL_SCRIPT, "kit-install", line], { env: this.deps.env, timeoutMs: INSTALL_TIMEOUT });
      const now = this.kit ?? kit;
      await this.scanOne(now, this.mine(now).find((x) => x.name === machine) ?? m);
      return { machine, tool, code: r.code, output: tail(`${r.stdout}${r.stderr}`) };
    });
  }

  /** what adopt would change, both sides masked */
  preview(machine: string, agent: string, name: string): KitMcpPreview {
    this.reach(machine);
    const c = this.mcpCell(machine, agent, name);
    if (!c) throw new KitError(`no server ${name} for ${agent} on ${machine}`, 404);
    const have = this.mcpSeen.get(machine)?.files.find((f) => f.agent === agent)?.entries?.[name] ?? null;
    const want = this.entries.get(machine)?.[`${agent}/${name}`] ?? null;
    return { state: c.state, why: c.why, have: have ? maskEntry(have) : null, want: want ? maskEntry(want) : null };
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
      if (path === "/api/kit/preview" && req.method === "GET") {
        const q = url.searchParams;
        return json(this.preview(q.get("machine") ?? "", q.get("agent") ?? "", q.get("name") ?? ""));
      }
      if ((path === "/api/kit/skill-adopt" || path === "/api/kit/skill-restore") && req.method === "POST") {
        const body = (await req.json().catch(() => ({}))) as { machine?: unknown; agent?: unknown; name?: unknown };
        if (typeof body.machine !== "string" || typeof body.agent !== "string" || typeof body.name !== "string") return json({ error: "machine, agent and name are required" }, 400);
        return json(path === "/api/kit/skill-adopt" ? await this.adoptSkill(body.machine, body.agent, body.name) : await this.restoreSkill(body.machine, body.agent, body.name));
      }
      if (path === "/api/kit/install" && req.method === "POST") {
        const body = (await req.json().catch(() => ({}))) as { machine?: unknown; tool?: unknown; line?: unknown };
        if (typeof body.machine !== "string" || typeof body.tool !== "string" || typeof body.line !== "string") return json({ error: "machine, tool and line are required" }, 400);
        return json(await this.install(body.machine, body.tool, body.line));
      }
      if ((path === "/api/kit/adopt" || path === "/api/kit/restore") && req.method === "POST") {
        const body = (await req.json().catch(() => ({}))) as { machine?: unknown; agent?: unknown; name?: unknown; names?: unknown };
        if (typeof body.machine !== "string" || typeof body.agent !== "string") return json({ error: "machine and agent are required" }, 400);
        if (path === "/api/kit/restore") {
          if (typeof body.name !== "string") return json({ error: "name is required" }, 400);
          return json(await this.restore(body.machine, body.agent, body.name));
        }
        // names left out adopts every adoptable server; anything else that is not a list of names is refused, not read as all
        if (body.names !== undefined && !(Array.isArray(body.names) && body.names.every((n) => typeof n === "string"))) return json({ error: "names must be a list of server names" }, 400);
        return json(await this.adopt(body.machine, body.agent, body.names as string[] | undefined));
      }
    } catch (err) {
      if (err instanceof KitError) return json({ error: err.message }, err.status);
      throw err;
    }
    return null;
  }
}
