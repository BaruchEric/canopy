/** `canopy plugins`: the kit's agent plugins (FR-064) from a terminal, the
 *  same reads and ops the plugins view runs. */
import { ask, errText, take, targetsOf, Unreachable, type Target } from "./health";
import { isPluginAgent, opText } from "../core/plugins";
import type { BackendEntry, KitInfo, PluginAgent, PluginCatalog, PluginMachineSeen, PluginOp, PluginOpResult } from "../core/types";

export const PLUGINS_USAGE = [
  "usage: canopy plugins [list] [--machine M] [--agent claude|codex]",
  "       canopy plugins install|uninstall|update|enable|disable <name@marketplace> --machine M [--agent claude|codex] [--accept SHA256]",
  "       canopy plugins search [words] --machine M [--agent claude|codex] [--limit N]",
  "       canopy plugins marketplace add <source> | remove <name> | update <name> --machine M [--agent claude|codex]",
  "       --backend URL asks that backend alone",
].join("\n");

/** a machine's plugins as lines: the machine, then a line per plugin installed or turned on in settings.json */
export function pluginLines(m: PluginMachineSeen, agent: PluginAgent | null): string[] {
  if (m.away) return [`${m.machine}  away: ${m.away}`];
  const how = m.shared ? (m.commits ? "commits the shared settings.json" : "follows the shared settings.json") : "own settings.json";
  const out = [`${m.machine}  ${how}${m.shared && m.settingsDirty ? ", settings.json changed and not committed" : ""}`];
  for (const a of m.agents) {
    if (agent && a.agent !== agent) continue;
    if (a.error) out.push(`  ${a.agent}  ${a.error}`);
    for (const p of a.plugins) {
      const servers = Object.keys(p.servers);
      const fails = p.errors.length > 0 ? `  fails: ${p.errors[0] ?? ""}` : "";
      out.push(`  ${a.agent}  ${p.id}  ${p.enabled ? "on" : "off"}${p.version ? ` ${p.version}` : ""}${servers.length ? `  servers: ${servers.join(", ")}` : ""}${fails}`);
    }
    for (const [id, on] of Object.entries(a.declared)) {
      if (on && !a.plugins.some((p) => p.id === id)) out.push(`  ${a.agent}  ${id}  wanted: settings.json turns it on, not installed here`);
    }
    if (a.markets.length > 0) out.push(`  ${a.agent}  marketplaces: ${a.markets.map((x) => x.name).join(", ")}`);
  }
  return out;
}

export function catalogLines(c: PluginCatalog): string[] {
  return [
    ...c.entries.map((e) => `${e.id}${e.installed ? "  (installed)" : ""}${e.installs !== null ? `  ${e.installs} installs` : ""}${e.description ? `  ${e.description}` : ""}`),
    `${c.total} on ${c.machine} for ${c.agent}${c.total > c.entries.length ? `, ${c.entries.length} shown` : ""}`,
  ];
}

export function opLines(r: PluginOpResult, what: string): string[] {
  if (r.outcome === "confirm") {
    return [
      `${r.machine}: ${opText(r.op, what)} waits: the marketplace declares a command to run`,
      `  ${r.command}`,
      `read it, then run the same command again with --accept ${r.sha256}`,
    ];
  }
  return [`${r.machine}: ${opText(r.op, what)} ${r.outcome === "ok" ? "done" : "failed"}: ${r.message}`];
}

const PLUGIN_OPS: Record<string, PluginOp> = { install: "install", uninstall: "uninstall", remove: "uninstall", update: "update", enable: "enable", disable: "disable" };
const MARKET_OPS: Record<string, PluginOp> = { add: "market-add", remove: "market-remove", rm: "market-remove", update: "market-update" };

export async function pluginsCommand(argv: string[], { fail }: { fail: (msg: string) => never }): Promise<void> {
  const args = [...argv];
  const given = take(args, "--backend");
  const machine = take(args, "--machine") ?? null;
  const agentGiven = take(args, "--agent");
  const accept = take(args, "--accept");
  const limit = Number(take(args, "--limit") ?? "30") || 30;
  const sub = args.shift() ?? "list";
  if (agentGiven !== undefined && !isPluginAgent(agentGiven)) return fail(`--agent is claude or codex\n${PLUGINS_USAGE}`);
  // a list shows every agent unless one is named; an op is claude's unless codex is
  const only: PluginAgent | null = isPluginAgent(agentGiven) ? agentGiven : null;
  const agent: PluginAgent = only ?? "claude";
  const home = (given ?? process.env["CANOPY_API"] ?? "http://127.0.0.1:7850").replace(/\/+$/, "");
  const homeTarget: Target = { name: "home", urls: [home] };
  const listed = await ask<{ self?: string; backends?: BackendEntry[] }>(homeTarget, "GET", "/api/backends").catch(() => null);
  const targets = given === undefined && listed?.self ? targetsOf(home, listed.self, listed.backends ?? []) : [homeTarget];
  const call = <T>(t: Target, method: string, path: string, body?: unknown) =>
    ask<T>(t, method, path, body).catch((err: unknown) => fail(err instanceof Unreachable ? `${t.name} did not answer: ${err.message}` : errText(err)));

  /** every backend's plugin machines; one that cannot answer is named and skipped */
  const read = async (): Promise<{ t: Target; m: PluginMachineSeen }[]> => {
    const out: { t: Target; m: PluginMachineSeen }[] = [];
    for (const t of targets) {
      try {
        const info = await ask<KitInfo>(t, "GET", "/api/kit");
        for (const m of info.plugins ?? []) if (!out.some((x) => x.m.machine === m.machine)) out.push({ t, m });
      } catch (err) {
        console.log(`${t.name}: ${err instanceof Unreachable ? `did not answer: ${err.message}` : errText(err)}`);
      }
    }
    return out;
  };
  const owner = async (): Promise<Target> => {
    if (!machine) return fail(`--machine is required\n${PLUGINS_USAGE}`);
    const hit = (await read()).find((x) => x.m.machine === machine);
    if (!hit) return fail(`no backend reads plugins on ${machine}`);
    return hit.t;
  };

  if (sub === "list" || sub === "status") {
    const ms = await read();
    if (ms.length === 0) return fail("no backend reads plugins: kit.json's plugins names the agents");
    for (const { m } of ms) if (!machine || m.machine === machine) for (const line of pluginLines(m, only)) console.log(line);
    return;
  }
  if (sub === "search") {
    const t = await owner();
    const q = args.join(" ");
    const c = await call<PluginCatalog>(t, "GET", `/api/kit/plugins/catalog?${new URLSearchParams({ machine: machine ?? "", agent, q, limit: String(limit) }).toString()}`);
    for (const line of catalogLines(c)) console.log(line);
    return;
  }
  let op: PluginOp | undefined;
  let body: Record<string, string> = {};
  let what = "";
  if (sub === "marketplace" || sub === "market") {
    const verb = args.shift() ?? "";
    op = MARKET_OPS[verb];
    const arg = args.shift();
    if (!op || !arg) return fail(PLUGINS_USAGE);
    body = op === "market-add" ? { source: arg } : { name: arg };
    what = arg;
  } else {
    op = PLUGIN_OPS[sub];
    const id = args.shift();
    if (!op || !id) return fail(PLUGINS_USAGE);
    body = { id, ...(accept ? { accept } : {}) };
    what = id;
  }
  const t = await owner();
  const r = await call<PluginOpResult>(t, "POST", "/api/kit/plugins", { machine, agent, op, ...body });
  for (const line of opLines(r, what)) console.log(line);
  if (r.outcome !== "ok") process.exitCode = 1;
}
