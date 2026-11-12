/** Agent plugins in the kit (FR-064, docs/superpowers/specs/2026-11-11-kit-plugins-design.md):
 *  what claude's and codex's plugin CLIs print, which ops a machine may
 *  run, each op's argv, and what a commit of dotclaude's settings.json
 *  holds. Every change goes through the agent's own CLI but one: codex has
 *  no command that turns a plugin off and on, so canopy flips the `enabled`
 *  line in that plugin's own config.toml table (pluginscan.ts
 *  CODEX_SWITCH_SCRIPT) and keeps it only when the CLI then lists it so.
 *  Pure and browser-safe: the page imports it to grey out what the server
 *  refuses. */
import type {
  PluginAgent, PluginAgentSeen, PluginCatalogEntry, PluginMachineSeen, PluginMarketSeen, PluginOp, PluginOpRequest, PluginOutcome, PluginSeen, SettingsChange,
} from "./types";

/** `name@marketplace`, both parts as the marketplaces name them */
export const PLUGIN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*@[A-Za-z0-9][A-Za-z0-9._-]*$/;
export const MARKET_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SHA256 = /^[0-9a-f]{64}$/;

export const PLUGIN_OPS: readonly PluginOp[] = ["install", "uninstall", "update", "enable", "disable", "market-add", "market-remove", "market-update"];
export const isPluginOp = (v: unknown): v is PluginOp => PLUGIN_OPS.some((o) => o === v);
export const isPluginAgent = (v: unknown): v is PluginAgent => v === "claude" || v === "codex";

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
const strList = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

/** A CLI's JSON: the whole text, or, when something printed before it, the
 *  text from the first line that opens an object or an array. */
export function jsonOf(text: string): unknown {
  const t = text.trim();
  if (t === "") return undefined;
  try {
    return JSON.parse(t);
  } catch {
    const lines = t.split("\n");
    const at = lines.findIndex((l) => l.startsWith("{") || l.startsWith("["));
    if (at <= 0) return undefined;
    try {
      return JSON.parse(lines.slice(at).join("\n"));
    } catch {
      return undefined;
    }
  }
}

/** the last line that parses as a JSON object: the result line an op prints with --json */
export function lastJsonObject(text: string): Record<string, unknown> | null {
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i] ?? "";
    if (!l.startsWith("{")) continue;
    try {
      const j: unknown = JSON.parse(l);
      if (isObj(j)) return j;
    } catch {
      // not this line
    }
  }
  const whole = jsonOf(text);
  return isObj(whole) ? whole : null;
}

/** what an MCP server runs: its url, or its command line */
export function serverLine(def: unknown): string {
  if (!isObj(def)) return "";
  const url = str(def["url"]);
  if (url) return url;
  return [str(def["command"]) ?? "", ...strList(def["args"])].join(" ").trim();
}

function serversOf(v: unknown): Record<string, string> {
  if (!isObj(v)) return {};
  return Object.fromEntries(Object.entries(v).map(([name, def]) => [name, serverLine(def)]));
}

/** `claude plugin list --json`: an array of installed plugins */
export function parseClaudeList(v: unknown): PluginSeen[] | null {
  if (!Array.isArray(v)) return null;
  const out: PluginSeen[] = [];
  for (const p of v) {
    if (!isObj(p)) continue;
    const id = str(p["id"]);
    if (!id) continue;
    out.push({
      id,
      version: str(p["version"]),
      enabled: p["enabled"] === true,
      scope: str(p["scope"]),
      servers: serversOf(p["mcpServers"]),
      errors: strList(p["errors"]),
      notes: strList(p["notes"]),
    });
  }
  return out;
}

/** `codex plugin list --json`: `{installed, available}`, the installed ones */
export function parseCodexList(v: unknown): PluginSeen[] | null {
  if (!isObj(v) || !Array.isArray(v["installed"])) return null;
  const out: PluginSeen[] = [];
  for (const p of v["installed"]) {
    if (!isObj(p) || p["installed"] === false) continue;
    const id = str(p["pluginId"]);
    if (!id) continue;
    const account = isObj(p["source"]) && p["source"]["source"] === "remote";
    out.push({ id, version: str(p["version"]), enabled: p["enabled"] !== false, scope: null, servers: {}, errors: [], notes: [], ...(account ? { account } : {}) });
  }
  return out;
}

/** `claude plugin marketplace list --json`: name with repo, url or path */
export function parseClaudeMarkets(v: unknown): PluginMarketSeen[] | null {
  if (!Array.isArray(v)) return null;
  return v.filter(isObj).flatMap((m) => {
    const name = str(m["name"]);
    return name ? [{ name, source: str(m["repo"]) ?? str(m["url"]) ?? str(m["path"]) ?? "" }] : [];
  });
}

/** `codex plugin marketplace list --json`: `{marketplaces: [{name, root, marketplaceSource}]}` */
export function parseCodexMarkets(v: unknown): PluginMarketSeen[] | null {
  if (!isObj(v) || !Array.isArray(v["marketplaces"])) return null;
  return v["marketplaces"].filter(isObj).flatMap((m) => {
    const name = str(m["name"]);
    const src = isObj(m["marketplaceSource"]) ? str(m["marketplaceSource"]["source"]) : null;
    return name ? [{ name, source: src ?? str(m["root"]) ?? "" }] : [];
  });
}

/** a settings.json marketplace source, as `marketplace add` takes it */
function sourceText(v: unknown): string {
  const s = isObj(v) && isObj(v["source"]) ? v["source"] : null;
  return s ? str(s["repo"]) ?? str(s["url"]) ?? str(s["path"]) ?? "" : "";
}

/** settings.json's enabledPlugins and extraKnownMarketplaces; empty for a file that does not parse */
export function parseSettings(text: string): { declared: Record<string, boolean>; declaredMarkets: Record<string, string> } {
  let j: unknown;
  try {
    j = JSON.parse(text);
  } catch {
    return { declared: {}, declaredMarkets: {} };
  }
  if (!isObj(j)) return { declared: {}, declaredMarkets: {} };
  const en = isObj(j["enabledPlugins"]) ? j["enabledPlugins"] : {};
  const mk = isObj(j["extraKnownMarketplaces"]) ? j["extraKnownMarketplaces"] : {};
  return {
    declared: Object.fromEntries(Object.entries(en).filter((e): e is [string, boolean] => typeof e[1] === "boolean")),
    declaredMarkets: Object.fromEntries(Object.entries(mk).map(([name, v]) => [name, sourceText(v)])),
  };
}

/** Whether an op writes ~/.claude/settings.json (enabledPlugins or
 *  extraKnownMarketplaces). Installing a plugin settings.json already
 *  enables, or adding a marketplace it already declares from the same
 *  source, writes the same bytes back (checked against claude 2.1.322), so
 *  a machine on the shared file can catch up with those two. */
export function editsSettings(a: PluginAgentSeen, op: PluginOp, id?: string, source?: string): boolean {
  if (a.agent !== "claude") return false;
  switch (op) {
    case "update":
    case "market-update":
      return false;
    case "install":
      return id === undefined || a.declared[id] !== true;
    case "market-add":
      return source === undefined || !Object.values(a.declaredMarkets).includes(source);
    case "uninstall":
    case "enable":
    case "disable":
    case "market-remove":
      return true;
    default: {
      const never: never = op;
      return never;
    }
  }
}

/** a market source as an argument: one line, not an option */
export function sourceProblem(s: string): string | null {
  if (s.trim() === "") return "a marketplace source is required";
  if (s.length > 512) return "that source is too long";
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(s)) return "a source is one line";
  if (s.startsWith("-")) return "a source cannot start with -";
  return null;
}

const CODEX_ACCOUNT = "it comes with the ChatGPT account, and codex keeps no switch for it in config.toml";
const CODEX_UPDATE = "codex updates a plugin through its marketplace: update the marketplace";

/** Why a machine refuses an op, or null when it may run. The server
 *  checks this before it runs anything; the page uses it to say why a
 *  button is not there. `committers`: the machines kit.json marks as
 *  where dotclaude is committed. */
export function refusal(m: PluginMachineSeen, req: Omit<PluginOpRequest, "machine">, committers: readonly string[]): string | null {
  if (m.away) return `${m.machine} is away: ${m.away}`;
  const a = m.agents.find((x) => x.agent === req.agent);
  if (!a) return `the kit does not read ${req.agent}'s plugins on ${m.machine}`;
  if (!a.path) return `${req.agent} is not installed on ${m.machine}`;
  if (req.agent === "codex" && (req.op === "enable" || req.op === "disable")) {
    const p = a.plugins.find((x) => x.id === req.id);
    if (!p) return `${req.id ?? "that plugin"} is not installed for codex on ${m.machine}`;
    if (p.account) return CODEX_ACCOUNT;
  }
  if (req.agent === "codex" && req.op === "update") return CODEX_UPDATE;
  if (m.shared && !m.commits && editsSettings(a, req.op, req.id, req.source)) {
    const where = committers.length > 0 ? committers.join(" or ") : "the machine dotclaude is committed on (none is marked: kit.json machines.<name>.commits)";
    return `${m.machine} reads dotclaude's shared settings.json, so a change there leaves an edit that stops its pulls. Make it on ${where}; ${m.machine} follows once dotclaude is committed and pulled.`;
  }
  return null;
}

/** The argv an op runs, without the CLI's path, or why the request is bad.
 *  Claude's ops name the user scope, so a run in a folder with project
 *  settings never lands in them. */
export function opArgs(req: Omit<PluginOpRequest, "machine">): string[] | { error: string } {
  const plugin = req.op === "install" || req.op === "uninstall" || req.op === "update" || req.op === "enable" || req.op === "disable";
  if (plugin && !(req.id && PLUGIN_ID.test(req.id))) return { error: "a plugin is named name@marketplace" };
  if ((req.op === "market-remove" || req.op === "market-update") && !(req.name && MARKET_NAME.test(req.name))) return { error: "a marketplace name is required" };
  if (req.op === "market-add") {
    const bad = sourceProblem(req.source ?? "");
    if (bad) return { error: bad };
  }
  if (req.accept !== undefined && !SHA256.test(req.accept)) return { error: "accept is the sha256 the CLI showed" };
  const accept = req.accept ? ["--accept-command", req.accept] : [];
  const id = req.id ?? "";
  const name = req.name ?? "";
  const source = req.source ?? "";
  if (req.agent === "claude") {
    switch (req.op) {
      case "install": return ["plugin", "install", id, "--scope", "user", "--json", ...accept];
      case "update": return ["plugin", "update", id, "--scope", "user", "--json", ...accept];
      case "uninstall": return ["plugin", "uninstall", id, "--scope", "user", "--json"];
      case "enable": return ["plugin", "enable", id, "--scope", "user", "--json"];
      case "disable": return ["plugin", "disable", id, "--scope", "user", "--json"];
      case "market-add": return ["plugin", "marketplace", "add", source, "--scope", "user", "--json"];
      case "market-remove": return ["plugin", "marketplace", "remove", name, "--scope", "user", "--json"];
      case "market-update": return ["plugin", "marketplace", "update", name, "--json"];
      default: {
        const never: never = req.op;
        return never;
      }
    }
  }
  switch (req.op) {
    case "install": return ["plugin", "add", id, "--json"];
    case "uninstall": return ["plugin", "remove", id, "--json"];
    case "market-add": return ["plugin", "marketplace", "add", source, "--json"];
    case "market-remove": return ["plugin", "marketplace", "remove", name, "--json"];
    case "market-update": return ["plugin", "marketplace", "upgrade", name, "--json"];
    case "enable":
    case "disable":
      return { error: "codex turns a plugin on and off in config.toml, not through its CLI (opPlan)" };
    case "update":
      return { error: CODEX_UPDATE };
    default: {
      const never: never = req.op;
      return never;
    }
  }
}

/** how an op runs: the agent's CLI with these arguments, or codex's switch
 *  in config.toml, which its CLI does not have */
export type OpPlan = { kind: "cli"; args: string[] } | { kind: "config"; id: string; on: boolean };

export function opPlan(req: Omit<PluginOpRequest, "machine">): OpPlan | { error: string } {
  if (req.agent === "codex" && (req.op === "enable" || req.op === "disable")) {
    if (!(req.id && PLUGIN_ID.test(req.id))) return { error: "a plugin is named name@marketplace" };
    return { kind: "config", id: req.id, on: req.op === "enable" };
  }
  const args = opArgs(req);
  return "error" in args ? args : { kind: "cli", args };
}

/** a command a marketplace declares, as the CLI shows it for a person to accept */
function shownCommand(v: unknown, depth = 0): { command: string; sha256: string } | null {
  if (!isObj(v) || depth > 4) return null;
  const sha = str(v["sha256"]);
  const command = str(v["command"]) ?? str(v["text"]) ?? str(v["display"]);
  if (sha && SHA256.test(sha) && command) return { command, sha256: sha };
  for (const x of Object.values(v)) {
    const found = shownCommand(x, depth + 1);
    if (found) return found;
  }
  return null;
}

const firstUseful = (...texts: string[]): string =>
  texts.flatMap((t) => t.split("\n")).map((l) => l.replace(/^[✘✔✓×]\s*/, "").trim()).find(Boolean) ?? "";

/** What an op came to. Claude prints one result line with --json: its
 *  `outcome`, and `alreadyInGoalState` for an enable of an enabled plugin,
 *  which is the op's goal and reads ok. Codex's exit code decides. */
export function outcomeOf(agent: PluginAgent, code: number, stdout: string, stderr: string): PluginOutcome {
  const j = lastJsonObject(stdout);
  const message = (j && str(j["message"])) ?? (firstUseful(stderr, stdout) || `exited ${code}`);
  if (agent === "claude" && j) {
    const shown = j["outcome"] === "ok" ? null : shownCommand(j);
    if (shown) return { outcome: "confirm", message, ...shown };
    return j["outcome"] === "ok" || j["alreadyInGoalState"] === true ? { outcome: "ok", message } : { outcome: "failed", message };
  }
  return code === 0 ? { outcome: "ok", message } : { outcome: "failed", message };
}

/** the catalog a `plugin list --json --available` prints, marking what is installed */
export function catalogOf(agent: PluginAgent, v: unknown): PluginCatalogEntry[] {
  if (!isObj(v) || !Array.isArray(v["available"])) return [];
  const installed = new Set<string>();
  if (Array.isArray(v["installed"])) {
    for (const p of v["installed"]) if (isObj(p)) { const id = str(p["id"]) ?? str(p["pluginId"]); if (id) installed.add(id); }
  }
  const out: PluginCatalogEntry[] = [];
  for (const p of v["available"]) {
    if (!isObj(p)) continue;
    const id = str(p["pluginId"]);
    if (!id || !PLUGIN_ID.test(id)) continue;
    const [name = id, marketplace = ""] = id.split("@");
    const installs = typeof p["installCount"] === "number" ? p["installCount"] : null;
    out.push({
      id, name: str(p["name"]) ?? name, marketplace: str(p["marketplaceName"]) ?? marketplace,
      description: str(p["description"]) ?? "", version: str(p["version"]), installs,
      installed: installed.has(id) || (agent === "codex" && p["installed"] === true),
    });
  }
  return out;
}

/** every word in the id, name or description; the most installed first */
export function searchCatalog(entries: readonly PluginCatalogEntry[], q: string, limit: number): { total: number; entries: PluginCatalogEntry[] } {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const hit = entries.filter((e) => {
    const hay = `${e.id} ${e.name} ${e.description}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
  hit.sort((a, b) => (b.installs ?? -1) - (a.installs ?? -1) || a.id.localeCompare(b.id));
  return { total: hit.length, entries: hit.slice(0, Math.max(0, limit)) };
}

/** an op in words, for a result line */
export function opText(op: PluginOp, what: string): string {
  switch (op) {
    case "install": return `install ${what}`;
    case "uninstall": return `remove ${what}`;
    case "update": return `update ${what}`;
    case "enable": return `turn on ${what}`;
    case "disable": return `turn off ${what}`;
    case "market-add": return `add the marketplace ${what}`;
    case "market-remove": return `remove the marketplace ${what}`;
    case "market-update": return `update the marketplace ${what}`;
    default: {
      const never: never = op;
      return never;
    }
  }
}

/* ---------- committing dotclaude's settings.json ---------- */

const objOf = (text: string): Record<string, unknown> => {
  try {
    const j: unknown = JSON.parse(text);
    return isObj(j) ? j : {};
  } catch {
    return {};
  }
};

const sameJson = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/** What `after` (the working file) holds that `before` (HEAD's) does not,
 *  by name only. A file that does not parse reads as empty. */
export function settingsChange(before: string, after: string): SettingsChange {
  const b = objOf(before);
  const a = objOf(after);
  const plugins = (o: Record<string, unknown>): Record<string, unknown> => (isObj(o["enabledPlugins"]) ? o["enabledPlugins"] : {});
  const markets = (o: Record<string, unknown>): Record<string, unknown> => (isObj(o["extraKnownMarketplaces"]) ? o["extraKnownMarketplaces"] : {});
  const bp = plugins(b);
  const ap = plugins(a);
  const bm = markets(b);
  const am = markets(a);
  const sorted = (xs: string[]): string[] => xs.sort((x, y) => x.localeCompare(y));
  return {
    on: sorted(Object.keys(ap).filter((id) => ap[id] === true && bp[id] !== true)),
    off: sorted(Object.keys(ap).filter((id) => ap[id] === false && bp[id] !== false)),
    dropped: sorted(Object.keys(bp).filter((id) => !(id in ap))),
    marketsAdded: sorted(Object.keys(am).filter((n) => !(n in bm))),
    marketsRemoved: sorted(Object.keys(bm).filter((n) => !(n in am))),
    marketsChanged: sorted(Object.keys(am).filter((n) => n in bm && !sameJson(am[n], bm[n]))),
    other: sorted([...new Set([...Object.keys(a), ...Object.keys(b)])]
      .filter((k) => k !== "enabledPlugins" && k !== "extraKnownMarketplaces" && !sameJson(a[k], b[k]))),
  };
}

/** a change as lines a person reads before the commit */
export function changeLines(c: SettingsChange): string[] {
  const line = (label: string, xs: string[]): string[] => (xs.length > 0 ? [`${label} ${xs.join(", ")}`] : []);
  const named = [
    ...line("turns on", c.on),
    ...line("turns off", c.off),
    ...line("drops", c.dropped),
    ...line("adds the marketplace", c.marketsAdded),
    ...line("removes the marketplace", c.marketsRemoved),
    ...line("changes the source of the marketplace", c.marketsChanged),
  ];
  return [...named, ...line(named.length > 0 ? "also changes" : "changes", c.other)];
}

/** The commit message: one change says itself in the subject, more than
 *  one is counted there and listed in the body. */
export function commitMessage(c: SettingsChange, machine: string): string {
  const parts: string[] = [
    ...c.on.map((id) => `turn on ${id}`),
    ...c.off.map((id) => `turn off ${id}`),
    ...c.dropped.map((id) => `drop ${id}`),
    ...c.marketsAdded.map((n) => `add the marketplace ${n}`),
    ...c.marketsRemoved.map((n) => `remove the marketplace ${n}`),
    ...c.marketsChanged.map((n) => `change the source of the marketplace ${n}`),
    ...(c.other.length > 0 ? [`change ${c.other.join(", ")}`] : []),
  ];
  const subject = parts.length === 0 ? "settings.json: its layout only" : parts.length === 1 ? `settings.json: ${parts[0] ?? ""}` : `settings.json: ${parts.length} changes`;
  const body = parts.length <= 1 ? [] : ["", ...parts.map((p) => `- ${p}`)];
  return [subject, ...body, "", `Committed from canopy on ${machine}.`].join("\n");
}
