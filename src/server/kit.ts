/** The kit's server side: scans, routes and the `kit` event
 *  (docs/superpowers/specs/2026-10-14-kit-design.md). */
import { homedir } from "node:os";
import { join } from "node:path";
import { onHost } from "../core/exec";
import { buildEntry, cellsOf, hasSecrets, maskEntry, needsSudo, OWNED_NOT_IGNORED, mcpDefOf, mcpHash, mcpTargets, mcpWanted, parseKit, planKit, planMcp, pluginAgentsOn, secretsOf, wantLink, withCanopyServer } from "../core/kit";
import { EMPTY_LOADOUTS, parseLoadouts } from "../core/loadout";
import { applyKit } from "../core/kitapply";
import { seeKit, seeMcp, seeTools } from "../core/kitscan";
import { catalogOf, changeLines, commitMessage, isPluginAgent, isPluginOp, jsonOf, opPlan, outcomeOf, parseCodexList, PLUGIN_ID, refusal, searchCatalog, settingsChange } from "../core/plugins";
import {
  CATALOG_TIMEOUT, codexSwitch, commitSettingsGit, OP_TIMEOUT, parseCommitRun, parseSettingsRead, plain, readSettingsGit, runCli, seePlugins,
} from "../core/pluginscan";
import type {
  KitAction, KitApplyResult, KitInfo, KitInstallResult, KitManifest, KitMachineView, KitMcpCtx, KitMcpEntry, KitMcpFormat, KitMcpPreview, KitMcpSeen, KitMcpView, KitSeen,
  PluginAgent, PluginCatalog, PluginCatalogEntry, PluginCommitPreview, PluginCommitResult, PluginMachineSeen, PluginOpRequest, PluginOpResult, PluginOutcome,
  LoadoutsInfo, SecretsInfo, ServerEvent,
} from "../core/types";

export const KIT_EVERY = 10 * 60_000;
/** an install line's time: a package manager can take a while */
export const INSTALL_TIMEOUT = 10 * 60_000;

/** runs one install line in the machine's login shell, so it sees the PATH a person's terminal has */
export const INSTALL_SCRIPT = String.raw`ls=$SHELL; [ -n "$ls" ] || ls=sh
exec "$ls" -lc "$1" </dev/null 2>&1`;

/** the last lines of an install's output */
const tail = (text: string, n = 40): string => text.trimEnd().split("\n").slice(-n).join("\n");

/** how long a machine's plugin catalog is kept before it is read again */
export const CATALOG_TTL = 10 * 60_000;

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

interface View { seen: KitSeen; dev: string; mcp: KitMcpSeen | null; ssh: boolean; mcpError: string | null; plugins: PluginMachineSeen | null }

export class KitHub {
  private last: KitInfo = { ok: false, error: "not scanned yet", machines: [], cells: [] };
  private kit: KitManifest | null = null;
  /** kit.json's loadouts as the last scan parsed them (FR-065) */
  private loadoutsInfo: LoadoutsInfo = EMPTY_LOADOUTS;
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
  /** per machine and agent, the plugins its marketplaces offer, read on demand */
  private catalogs = new Map<string, { at: number; entries: PluginCatalogEntry[] }>();

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

  loadouts(): LoadoutsInfo {
    return this.loadoutsInfo;
  }

  /** the kit machine this backend is, or null when kit.json names none */
  machineName(): string | null {
    return this.kit?.machines.find((m) => m.backend === this.deps.self)?.name ?? null;
  }

  /** the claude entry a run on this backend gets for a kit server, or why it gets none */
  runEntry(server: string): { entry: KitMcpEntry } | { why: string } {
    const machine = this.machineName();
    if (!this.kit || machine === null) return { why: "this backend is not a machine in kit.json" };
    const s = this.kit.mcp.find((x) => x.name === server);
    if (!s) return { why: `no server named ${server} in the kit` };
    if (!mcpWanted(s, "claude", machine)) return { why: `the kit does not put ${server} on ${machine}` };
    const r = buildEntry(s, "claude", "claude-json", this.deps.hostHome ?? homedir(), this.deps.procEnv ?? process.env);
    return "entry" in r ? { entry: r.entry } : { why: r.why };
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

  private async read(): Promise<{ kit: KitManifest; raw: unknown }> {
    let raw: unknown;
    try {
      raw = JSON.parse(await Bun.file(this.deps.kitPath).text());
    } catch (err) {
      throw new KitError(`kit.json: ${err instanceof Error ? err.message : String(err)}`, 500);
    }
    const r = parseKit(raw);
    if ("errors" in r) throw new KitError(`kit.json: ${r.errors.join("; ")}`, 500);
    return { kit: withCanopyServer(r.kit), raw };
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
      const r = await this.read();
      kit = r.kit;
      this.loadoutsInfo = parseLoadouts(r.raw, kit);
    } catch (err) {
      this.kit = null;
      this.loadoutsInfo = { ...EMPTY_LOADOUTS, errors: [err instanceof Error ? err.message : String(err)] };
      this.views.clear();
      this.entries.clear();
      this.mcpSeen.clear();
      this.last = { ok: false, error: err instanceof Error ? err.message : String(err), machines: [], cells: [], loadouts: this.loadoutsInfo };
      this.deps.broadcast({ type: "kit", kit: this.last });
      return this.last;
    }
    // the hashes before the manifest, so a republish during the await never plans a new kit against old hashes
    this.hashes = Object.fromEntries(await Promise.all(kit.mcp.map(async (s) => [s.name, await mcpHash(mcpDefOf(s))] as const)));
    this.kit = kit;
    const mine = this.mine(kit);
    for (const name of this.views.keys()) if (!mine.some((m) => m.name === name)) this.views.delete(name);
    // a backend that is no machine and reaches none has no scan to publish,
    // yet a run here can take a loadout, so the loadouts go out on their own
    if (mine.length === 0) {
      this.last = { ...this.last, loadouts: this.loadoutsInfo };
      this.deps.broadcast({ type: "kit", kit: this.last });
    }
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
    const plugins = await this.seePluginsOf(kit, m, seen);
    // kit.json changed during the read (an apply's rescan racing a scan):
    // this read follows the old manifest, and the new one's scan paints it
    if (kit !== this.kit) return;
    if ((this.scanOf.get(m.name) ?? 0) > n) return;
    this.scanOf.set(m.name, n);
    this.views.set(m.name, { seen, dev: m.dev, mcp, ssh: m.host !== null, mcpError, plugins });
    await this.publish(kit);
  }

  /** a machine's plugins (FR-064), when kit.json lists agents for it; a
   *  machine the skills scan found away reads away here too */
  private async seePluginsOf(kit: KitManifest, m: Mine, seen: KitSeen): Promise<PluginMachineSeen | null> {
    const agents = pluginAgentsOn(kit, m.name);
    if (agents.length === 0) return null;
    const commits = kit.machines.some((x) => x.name === m.name && x.commits === true);
    const away = (why: string): PluginMachineSeen => ({ machine: m.name, at: seen.at, away: why, shared: false, settingsDirty: false, commits, agents: [] });
    if (seen.away) return away(seen.away);
    const host = this.claudeHome(m);
    return seePlugins(m, agents, commits, { run: this.deps.run, env: host ? { ...this.deps.env, KIT_CLAUDE_HOME: host } : this.deps.env, now: this.deps.now })
      .catch((err: unknown) => away(err instanceof Error ? err.message : String(err)));
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
    const plugins = vs.flatMap((v) => (v.plugins ? [v.plugins] : []));
    this.last = { ok: true, error: null, machines, cells: cellsOf(kit, cellViews), mcp: this.mcpViews(kit), loadouts: this.loadoutsInfo, ...((kit.plugins ?? []).length > 0 ? { plugins } : {}) };
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

  /** the machines kit.json marks as where dotclaude is committed */
  private committers(kit: KitManifest): string[] {
    return kit.machines.filter((m) => m.commits === true).map((m) => m.name);
  }

  /** a machine's plugins and the agent's CLI there, or why an op cannot run */
  private pluginsOf(machine: string, agent: PluginAgent): { kit: KitManifest; m: Mine; ps: PluginMachineSeen; path: string } {
    const { kit, m } = this.reach(machine);
    const ps = this.views.get(machine)?.plugins;
    if (!ps) throw new KitError(`the kit reads no plugins on ${machine}; kit.json's plugins names the agents`, 409);
    const path = ps.agents.find((a) => a.agent === agent)?.path;
    if (ps.away) throw new KitError(`${machine} is away: ${ps.away}`, 409);
    if (!path) throw new KitError(`${agent} is not installed on ${machine}, or the kit does not read its plugins there`, 409);
    return { kit, m, ps, path };
  }

  /** Install, remove, update, turn on or off a plugin, or add, remove or
   *  update a marketplace, through the agent's own CLI on that machine
   *  (codex's switch through its config.toml, which its CLI lacks).
   *  Refused on a machine reading dotclaude's shared settings.json when
   *  the op would edit it there (refusal in core/plugins.ts). One at a
   *  time per machine, then a rescan of that machine. */
  pluginOp(req: PluginOpRequest): Promise<PluginOpResult> {
    return this.serial(req.machine, async () => {
      const { view } = this.reach(req.machine);
      // kit.json and dotclaude's settings can change through a pull without
      // this backend scanning first. Base the safety check on what is there
      // now, not the last scan's commit permission or plugin declarations.
      const kit = (await this.read()).kit;
      const m = this.mine(kit).find((x) => x.name === req.machine);
      if (!m) throw new KitError(`not a machine this backend reaches: ${req.machine}`, 400);
      const plan = opPlan(req);
      if ("error" in plan) throw new KitError(plan.error, 400);

      const ps = await this.seePluginsOf(kit, m, view.seen);
      if (!ps) throw new KitError(`the kit reads no plugins on ${req.machine}; kit.json's plugins names the agents`, 409);
      if (ps.away) throw new KitError(`${req.machine} is away: ${ps.away}`, 409);
      const path = ps.agents.find((a) => a.agent === req.agent)?.path;
      if (!path) throw new KitError(`${req.agent} is not installed on ${req.machine}, or the kit does not read its plugins there`, 409);
      const why = refusal(ps, req, this.committers(kit));
      if (why) throw new KitError(why, 409);
      let out: PluginOutcome;
      if (plan.kind === "config") out = await this.switchCodex(m, path, plan.id, plan.on);
      else {
        const r = await runCli(m.host, path, plan.args, { run: this.deps.run, env: this.cliEnv(m, req.agent), timeoutMs: OP_TIMEOUT });
        out = outcomeOf(req.agent, r.code, r.stdout, r.stderr);
      }
      for (const k of this.catalogs.keys()) if (k.startsWith(`${req.machine}/`)) this.catalogs.delete(k);
      const now = this.kit ?? kit;
      await this.scanOne(now, this.mine(now).find((x) => x.name === req.machine) ?? m);
      return { machine: req.machine, agent: req.agent, op: req.op, ...out };
    });
  }

  /** Codex's switch: the plugin's `enabled` line in config.toml, kept only
   *  when codex's own list then says it is on or off; otherwise the file
   *  goes back to the bytes it had (CODEX_SWITCH_SCRIPT). */
  private async switchCodex(m: Mine, path: string, id: string, on: boolean): Promise<PluginOutcome> {
    const io = { run: this.deps.run, env: this.deps.env };
    const word = on ? "on" : "off";
    const set = await codexSwitch(m.host, ["set", id, String(on)], io);
    const said = set.stdout.trim().split("\n")[0] ?? "";
    if (set.code === 7) return { outcome: "ok", message: `${id} is already ${word} in config.toml` };
    if (set.code !== 0) return { outcome: "failed", message: said || (set.stderr.trim().split("\n")[0] ?? "") || `the switch exited ${set.code}` };
    const sum = said.startsWith("S\t") ? said.slice(2) : "";
    const list = await runCli(m.host, path, ["plugin", "list", "--json"], { ...io, timeoutMs: OP_TIMEOUT });
    const listed = list.code === 0 ? parseCodexList(jsonOf(list.stdout))?.find((p) => p.id === id) : undefined;
    if (listed?.enabled === on) {
      await codexSwitch(m.host, ["keep"], io);
      return { outcome: "ok", message: `turned ${word} in config.toml` };
    }
    const undo = await codexSwitch(m.host, ["undo", sum], io);
    const seen = list.code !== 0 ? `codex plugin list failed after the edit (${(list.stderr.trim().split("\n")[0] ?? "") || `exited ${list.code}`})` : `codex still lists ${id} ${listed ? (listed.enabled ? "on" : "off") : "nowhere"} after the edit`;
    return { outcome: "failed", message: `${seen}; ${undo.code === 0 ? "config.toml is back as it was" : (undo.stdout.trim() || "config.toml could not be put back")}` };
  }

  /** a machine whose settings.json canopy may commit: it commits dotclaude and reads the shared file */
  private committing(machine: string): { m: Mine; ps: PluginMachineSeen } {
    const { m } = this.reach(machine);
    const ps = this.views.get(machine)?.plugins;
    if (!ps) throw new KitError(`the kit reads no plugins on ${machine}; kit.json's plugins names the agents`, 409);
    if (ps.away) throw new KitError(`${machine} is away: ${ps.away}`, 409);
    if (!ps.commits) throw new KitError(`kit.json does not mark ${machine} as the machine dotclaude is committed on (machines.${machine}.commits)`, 409);
    if (!ps.shared) throw new KitError(`${machine}'s settings.json is not dotclaude's shared file`, 409);
    return { m, ps };
  }

  /** what a commit of settings.json would hold, by name only, and the bytes it holds them for */
  private async readCommit(machine: string, m: Mine): Promise<PluginCommitPreview> {
    const r = await readSettingsGit(m.host, { run: this.deps.run, env: this.deps.env });
    if (r.code !== 0) throw new KitError(`${machine}: ${r.stdout.trim().split("\n")[0] || r.stderr.trim().split("\n")[0] || `the read exited ${r.code}`}`, 409);
    const g = parseSettingsRead(r.stdout);
    if (!g.dirty) throw new KitError(`${machine}'s settings.json has nothing to commit`, 409);
    const change = settingsChange(g.head, g.work);
    return { machine, sha: g.sha, branch: g.branch, change, message: commitMessage(change, machine) };
  }

  async commitPreview(machine: string): Promise<PluginCommitPreview & { lines: string[] }> {
    const { m } = this.committing(machine);
    const p = await this.readCommit(machine, m);
    return { ...p, lines: changeLines(p.change) };
  }

  /** Commits and pushes dotclaude's settings.json on the machine that
   *  commits it, only while it still holds the bytes a person was shown
   *  (`sha`), with the message canopy writes from the change. */
  commitSettings(machine: string, sha: string): Promise<PluginCommitResult> {
    return this.serial(machine, async () => {
      const { m } = this.committing(machine);
      const p = await this.readCommit(machine, m);
      if (p.sha !== sha) throw new KitError("settings.json changed since it was shown; look at it again", 409);
      const r = await commitSettingsGit(m.host, sha, p.message, { run: this.deps.run, env: this.deps.env });
      const c = parseCommitRun(r.stdout);
      const kit = this.kit;
      if (kit) await this.scanOne(kit, this.mine(kit).find((x) => x.name === machine) ?? m);
      if (!c.commit) return { machine, outcome: "failed", message: c.error ?? (r.stderr.trim().split("\n")[0] || `the commit exited ${r.code}`) };
      if (c.pushed) return { machine, outcome: "pushed", commit: c.commit, message: `committed ${c.commit} and pushed` };
      return { machine, outcome: "committed", commit: c.commit, message: `committed ${c.commit} on ${machine}; the push failed: ${c.pushError || "git gave no reason"}` };
    });
  }

  /** The home claude's plugin CLI runs under on this backend's own
   *  machine, when it is not this process's: the mini's canopy runs as
   *  /home/bun with the host's ~/.claude mounted at both homes. claude
   *  records every marketplace and install path under its own home and
   *  refuses one outside it, so a call made under /home/bun would break the
   *  host's claude and the host's paths break it. Run under the host's
   *  home, both see the same paths. null elsewhere. */
  private claudeHome(m: Mine): string | null {
    const host = this.deps.hostHome;
    const mine = this.deps.env?.["HOME"] ?? homedir();
    return m.host === null && host && host !== mine ? host : null;
  }

  private cliEnv(m: Mine, agent: PluginAgent): Record<string, string> | undefined {
    const host = agent === "claude" ? this.claudeHome(m) : null;
    return host ? { ...this.deps.env, HOME: host } : this.deps.env;
  }

  /** what an agent's marketplaces offer on a machine, searched; read once
   *  per CATALOG_TTL (it runs to megabytes), `fresh` reads it again */
  async catalog(machine: string, agent: PluginAgent, q: string, limit: number, fresh = false): Promise<PluginCatalog> {
    const { m, path } = this.pluginsOf(machine, agent);
    const key = `${machine}/${agent}`;
    const now = (this.deps.now ?? Date.now)();
    let hit = this.catalogs.get(key);
    if (!hit || fresh || now - hit.at > CATALOG_TTL) {
      const r = await runCli(m.host, path, ["plugin", "list", "--json", "--available"], { run: this.deps.run, env: this.cliEnv(m, agent), timeoutMs: CATALOG_TIMEOUT });
      if (r.code !== 0) throw new KitError(`${agent} plugin list on ${machine}: ${(r.stderr.trim().split("\n")[0] ?? "") || `exited ${r.code}`}`, 502);
      hit = { at: now, entries: catalogOf(agent, jsonOf(r.stdout)) };
      this.catalogs.set(key, hit);
    }
    return { machine, agent, ...searchCatalog(hit.entries, q, limit) };
  }

  /** claude's own account of a plugin: what it holds and what it costs a session */
  async details(machine: string, agent: PluginAgent, id: string): Promise<{ text: string }> {
    if (agent !== "claude") throw new KitError(`${agent} has no plugin details command`, 400);
    if (!PLUGIN_ID.test(id)) throw new KitError("a plugin is named name@marketplace", 400);
    const { m, path } = this.pluginsOf(machine, agent);
    const r = await runCli(m.host, path, ["plugin", "details", id], { run: this.deps.run, env: this.cliEnv(m, agent), timeoutMs: 60_000 });
    const text = plain(r.stdout).trimEnd();
    if (!text) throw new KitError(plain(r.stderr).trim().split("\n")[0] || `claude plugin details exited ${r.code}`, 502);
    return { text };
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
      if (path === "/api/kit/plugins" && req.method === "POST") {
        const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
        const { machine, agent, op } = body;
        if (typeof machine !== "string" || !isPluginAgent(agent) || !isPluginOp(op)) return json({ error: "machine, agent (claude or codex) and op are required" }, 400);
        const opt = (k: string): string | undefined => (typeof body[k] === "string" ? body[k] : undefined);
        const id = opt("id");
        const source = opt("source");
        const name = opt("name");
        const accept = opt("accept");
        return json(await this.pluginOp({ machine, agent, op, ...(id ? { id } : {}), ...(source ? { source } : {}), ...(name ? { name } : {}), ...(accept ? { accept } : {}) }));
      }
      if (path === "/api/kit/plugins/commit" && req.method === "GET") {
        const machine = url.searchParams.get("machine");
        if (!machine) return json({ error: "machine is required" }, 400);
        return json(await this.commitPreview(machine));
      }
      if (path === "/api/kit/plugins/commit" && req.method === "POST") {
        const body = (await req.json().catch(() => ({}))) as { machine?: unknown; sha?: unknown };
        if (typeof body.machine !== "string" || typeof body.sha !== "string" || !/^[0-9a-f]{40,64}$/.test(body.sha)) return json({ error: "machine and the sha the preview gave are required" }, 400);
        return json(await this.commitSettings(body.machine, body.sha));
      }
      if ((path === "/api/kit/plugins/catalog" || path === "/api/kit/plugins/details") && req.method === "GET") {
        const q = url.searchParams;
        const agent = q.get("agent");
        const machine = q.get("machine");
        if (!machine || !isPluginAgent(agent)) return json({ error: "machine and agent (claude or codex) are required" }, 400);
        if (path === "/api/kit/plugins/details") return json(await this.details(machine, agent, q.get("id") ?? ""));
        const limit = Math.min(200, Math.max(1, Number(q.get("limit") ?? "50") || 50));
        return json(await this.catalog(machine, agent, q.get("q") ?? "", limit, q.get("fresh") === "1"));
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
