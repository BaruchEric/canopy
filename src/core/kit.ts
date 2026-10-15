/** The kit's pure core (docs/superpowers/specs/2026-10-14-kit-design.md):
 *  the manifest, what each machine should hold, and what to do about it.
 *  Browser-safe: no node imports. */
import type {
  KitAction, KitCell, KitCellState, KitMachine, KitManifest, KitMcpAction, KitMcpCtx, KitMcpDef, KitMcpEntry, KitMcpFormat, KitMcpOption,
  KitMcpServer, KitMcpTarget, KitMcpValue, KitMode, KitRule, KitSeen, KitSeenTarget, KitTarget, SecretsInfo,
} from "./types";
import { canonical, DOTENV_KEY, HEADER_NAME, MCP_SERVER, MCP_SERVER_SRC, mcpSinkId, parseMcpAllow, SECRET_NAME, SINK_ID } from "./secretfile";

export const SKILL_NAME = /^[a-z0-9][a-z0-9._-]*$/;
const MODES: readonly KitMode[] = ["store", "link", "copy"];

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const strs = (v: unknown): string[] | null => (Array.isArray(v) && v.every((x) => typeof x === "string") ? v : null);
const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);

/** any server's name: the server part of an `mcp:` allow entry */
export const MCP_NAME = new RegExp(`^${MCP_SERVER_SRC}$`);
/** fields the kit writes itself, so an option cannot set them. headersHelper
 *  is not one: the kit writes it only for secret headers, and a server with
 *  secrets takes no options, so executor's own helper can be an option. */
const RESERVED = new Set(["type", "command", "args", "url", "env", "headers", "http_headers"]);
const REF = /^\$\{(env|secret):([^}]*)\}$/;

export function parseMcpValue(v: unknown): KitMcpValue | string {
  if (typeof v !== "string") return "is not a string";
  const m = REF.exec(v);
  if (m) {
    const name = m[2] ?? "";
    if (m[1] === "env") return DOTENV_KEY.test(name) ? { env: name } : `\${env:${name}} is not a variable name`;
    return SECRET_NAME.test(name) ? { secret: name } : `\${secret:${name}} is not a secret name`;
  }
  if (v.includes("${")) return "holds ${ that is not one whole ${env:NAME} or ${secret:NAME}";
  return { literal: v };
}

export const hasSecrets = (s: KitMcpServer): boolean => [...Object.values(s.env), ...Object.values(s.headers)].some((v) => "secret" in v);

const secretMap = (vals: Record<string, KitMcpValue>): Record<string, string> =>
  Object.fromEntries(Object.entries(vals).flatMap(([k, v]) => ("secret" in v ? [[k, v.secret]] : [])));

export const secretsOf = (s: KitMcpServer): { env: Record<string, string>; headers: Record<string, string> } => ({ env: secretMap(s.env), headers: secretMap(s.headers) });

export const mcpDefOf = (s: KitMcpServer): KitMcpDef => ({
  command: s.command, args: [...s.args], url: s.url, env: Object.keys(s.env).sort(), headers: Object.keys(s.headers).sort(),
});

function parseServer(name: string, s: Record<string, unknown>, machines: KitMachine[], errors: string[]): KitMcpServer | null {
  const at = `mcp.${name}`;
  const fail = (why: string): null => {
    errors.push(`${at}: ${why}`);
    return null;
  };
  const command = str(s["command"]);
  const url = str(s["url"]);
  if ((command === null) === (url === null)) return fail("needs command or url, not both");
  if (url !== null && !/^https?:\/\//.test(url)) return fail("url is http or https");
  if (url !== null && s["args"] !== undefined) return fail("args are for a command only");
  if (url !== null && s["env"] !== undefined) return fail("env is for a command only");
  if (command !== null && s["headers"] !== undefined) return fail("headers are for a url only");
  const args = s["args"] === undefined ? [] : strs(s["args"]);
  if (!args) return fail("args is a list of strings");
  const values = (field: "env" | "headers", re: RegExp): Record<string, KitMcpValue> | null => {
    const o = s[field] === undefined ? {} : s[field];
    if (!isObj(o)) return fail(`${field} is an object`);
    const out: Record<string, KitMcpValue> = {};
    for (const [k, v] of Object.entries(o)) {
      if (!re.test(k)) return fail(`${field}.${k} is not a name`);
      const p = parseMcpValue(v);
      if (typeof p === "string") return fail(`${field}.${k} ${p}`);
      out[k] = p;
    }
    return out;
  };
  const env = values("env", DOTENV_KEY);
  const headers = values("headers", HEADER_NAME);
  if (!env || !headers) return null;
  const agents = s["agents"] === undefined ? null : strs(s["agents"]);
  const ms = s["machines"] === undefined ? null : strs(s["machines"]);
  if ((s["agents"] !== undefined && !agents) || (s["machines"] !== undefined && !ms)) return fail("agents and machines are lists of names");
  const options: Record<string, Record<string, KitMcpOption>> = {};
  const rawOpts = s["options"] === undefined ? {} : s["options"];
  if (!isObj(rawOpts)) return fail("options is an object of agent to fields");
  for (const [agent, o] of Object.entries(rawOpts)) {
    if (!isObj(o)) return fail(`options.${agent} is an object`);
    const fields: Record<string, KitMcpOption> = {};
    for (const [k, v] of Object.entries(o)) {
      if (RESERVED.has(k)) return fail(`options.${agent}.${k} is reserved; the kit writes it`);
      if (typeof v !== "string" && typeof v !== "number" && typeof v !== "boolean") return fail(`options.${agent}.${k} is a string, a number or a boolean`);
      fields[k] = v;
    }
    options[agent] = fields;
  }
  const server: KitMcpServer = { name, command, args, url, env, headers, agents, machines: ms, options };
  if (hasSecrets(server)) {
    if (!MCP_SERVER.test(name)) return fail("a server with secrets has a name of a-z, 0-9 and -, at most 32 long");
    if (Object.keys(options).length > 0) return fail("options are for servers without secrets");
    for (const m of machines) {
      if (ms !== null && !ms.includes(m.name)) continue;
      const id = mcpSinkId(name, m.name, true);
      if (!SINK_ID.test(id)) return fail(`the sink id ${id} is too long; shorten the server's name`);
    }
  }
  return server;
}

export function parseKit(raw: unknown): { kit: KitManifest } | { errors: string[] } {
  if (!isObj(raw)) return { errors: ["kit.json is not an object"] };
  if (raw["version"] !== 1) return { errors: ["version: only 1 is known"] };
  const errors: string[] = [];

  const machines: KitMachine[] = [];
  const rawMachines = isObj(raw["machines"]) ? raw["machines"] : {};
  for (const [name, m] of Object.entries(rawMachines)) {
    if (!isObj(m)) { errors.push(`machines.${name}: not an object`); continue; }
    const backend = str(m["backend"]);
    const ssh = str(m["ssh"]);
    const via = str(m["via"]);
    const dev = str(m["dev"]);
    if (!backend && !ssh) errors.push(`machines.${name}: needs backend or ssh`);
    if (ssh && (!via || !dev)) errors.push(`machines.${name}: an ssh machine needs via and dev`);
    machines.push({ name, backend, ssh, via, dev });
  }

  const targets: KitTarget[] = [];
  const rawTargets = Array.isArray(raw["targets"]) ? raw["targets"] : [];
  rawTargets.forEach((t, i) => {
    if (!isObj(t)) { errors.push(`targets[${i}]: not an object`); return; }
    const agent = str(t["agent"]);
    const skills = str(t["skills"]);
    const mode = t["mode"] as KitMode;
    if (!agent || !skills || !MODES.includes(mode)) { errors.push(`targets[${i}]: needs agent, skills and mode`); return; }
    if (targets.some((x) => x.agent === agent)) { errors.push(`targets[${i}]: agent ${agent} appears twice`); return; }
    if (mode === "store" && t["machines"] !== undefined) { errors.push(`targets[${i}]: the store target is on every machine, so it takes no machines`); }
    let mcp: KitMcpTarget | null = null;
    if (t["mcp"] !== undefined) {
      const o = isObj(t["mcp"]) ? t["mcp"] : {};
      const file = str(o["file"]);
      const format = o["format"] as KitMcpFormat;
      const fits = (format === "claude-json" && agent === "claude") || (format === "codex-toml" && agent === "codex");
      if (!file || !fits) errors.push(`targets[${i}].mcp: needs a file, and the format claude-json for claude or codex-toml for codex`);
      else if (format === "claude-json" && file !== "~/.claude.json") errors.push(`targets[${i}].mcp: claude mcp writes ~/.claude.json, so the file is that`);
      else mcp = { file, format };
    }
    targets.push({ agent, skills, mode, machines: t["machines"] === undefined ? null : strs(t["machines"]), mcp });
  });
  if (targets.filter((t) => t.mode === "store").length !== 1) errors.push("targets: exactly one target has mode store");

  const rawSkills = isObj(raw["skills"]) ? raw["skills"] : {};
  const rule = (v: unknown, fallback: KitRule): KitRule => {
    const o = isObj(v) ? v : {};
    return { agents: strs(o["agents"]) ?? fallback.agents, machines: strs(o["machines"]) ?? fallback.machines };
  };
  const all: KitRule = { agents: ["*"], machines: ["*"] };
  const only: KitManifest["only"] = {};
  for (const [name, o] of Object.entries(isObj(rawSkills["only"]) ? rawSkills["only"] : {})) {
    if (!SKILL_NAME.test(name) || !isObj(o)) { errors.push(`skills.only.${name}: bad name or not an object`); continue; }
    const entry: KitManifest["only"][string] = {};
    const agents = strs(o["agents"]);
    const ms = strs(o["machines"]);
    const source = str(o["source"]);
    if (agents) entry.agents = agents;
    if (ms) entry.machines = ms;
    if (source) entry.source = source;
    only[name] = entry;
  }
  const mcp: KitMcpServer[] = [];
  for (const [name, s] of Object.entries(isObj(raw["mcp"]) ? raw["mcp"] : {})) {
    if (!MCP_NAME.test(name) || !isObj(s)) { errors.push(`mcp.${name}: bad name or not an object`); continue; }
    const server = parseServer(name, s, machines, errors);
    if (server) mcp.push(server);
  }
  if (errors.length) return { errors };
  return {
    kit: { machines, targets, default: rule(rawSkills["default"], all), only, exclude: strs(rawSkills["exclude"]) ?? [], mcp },
  };
}

export function expandHome(path: string, home: string): string {
  if (path === "~") return home;
  return path.startsWith("~/") ? `${home}/${path.slice(2)}` : path;
}

/** The definition hash (phase 2 spec): SHA-256 over the canonical JSON of
 *  the names-only definition, so the same on every machine. WebCrypto, so
 *  the page and the server compute it alike. */
export async function mcpHash(def: KitMcpDef): Promise<string> {
  const bytes = new TextEncoder().encode(canonical({ command: def.command, args: def.args, url: def.url, env: [...def.env].sort(), headers: [...def.headers].sort() }));
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...d].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const parts = (p: string) => p.split("/").filter((x) => x !== "" && x !== ".");

/** a posix relative path between two absolute dirs */
export function relPath(from: string, to: string): string {
  const a = parts(from);
  const b = parts(to);
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  const up = a.slice(i).map(() => "..");
  const rel = [...up, ...b.slice(i)].join("/");
  return rel === "" ? "." : rel;
}

export const storeTarget = (kit: KitManifest): KitTarget => kit.targets.find((t) => t.mode === "store")!;

export function targetsFor(kit: KitManifest, machine: string): KitTarget[] {
  const mine = kit.targets.filter((t) => t.machines === null || t.machines.includes(machine));
  return [...mine.filter((t) => t.mode === "store"), ...mine.filter((t) => t.mode !== "store")];
}

export function sourcePath(source: string, dev: string): string | null {
  if (source.startsWith("/")) return source;
  if (!source.startsWith("dev:")) return null;
  const rest = source.slice(4);
  if (parts(rest).includes("..")) return null;
  return `${dev.replace(/\/+$/, "")}/${parts(rest).join("/")}`;
}

const glob = (pattern: string, name: string): boolean =>
  new RegExp(`^${pattern.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`).test(name);

const excluded = (kit: KitManifest, name: string) => kit.exclude.some((p) => glob(p, name));

const sources = (kit: KitManifest) => Object.keys(kit.only).filter((n) => kit.only[n]!.source);

export function skillNames(kit: KitManifest, seen: KitSeen): string[] {
  const tracked = (seen.store?.tracked ?? []).filter((n) => SKILL_NAME.test(n) && !excluded(kit, n));
  return [...new Set([...tracked, ...sources(kit)])].sort();
}

const hits = (list: string[], v: string) => list.includes("*") || list.includes(v);

export function wanted(kit: KitManifest, skill: string, agent: string, machine: string): boolean {
  const o = kit.only[skill] ?? {};
  return hits(o.agents ?? kit.default.agents, agent) && hits(o.machines ?? kit.default.machines, machine);
}

const isSource = (kit: KitManifest, skill: string) => !!kit.only[skill]?.source;

/** the link text a managed entry should carry */
export function wantLink(kit: KitManifest, seen: KitSeen, target: KitSeenTarget, skill: string, dev: string): string {
  const store = seen.targets[0]!;
  if (target.agent === store.agent) return sourcePath(kit.only[skill]!.source!, dev) ?? "";
  return `${relPath(target.dir, store.dir)}/${skill}`;
}

/** whether a skill can exist on this machine at all */
const present = (kit: KitManifest, seen: KitSeen, skill: string) => !isSource(kit, skill) || seen.sources[skill] === true;

function planSkills(kit: KitManifest, seen: KitSeen, dev: string): KitAction[] {
  if (seen.away || !seen.store) return [];
  const out: KitAction[] = [];
  if (seen.store.behind > 0 && seen.store.ahead === 0) out.push({ kind: "pull" });
  const names = skillNames(kit, seen);
  seen.targets.forEach((t, i) => {
    const isStore = i === 0;
    const manage = names.filter((n) => (isStore ? isSource(kit, n) : true));
    const want = manage.filter((n) => wanted(kit, n, t.agent, seen.machine) && present(kit, seen, n));
    if (!t.exists) {
      if (t.parentExists && want.length) out.push({ kind: "mkdir", agent: t.agent });
      else return;
    }
    const byName = new Map(t.entries.map((e) => [e.name, e]));
    // a placed link whose text is no longer what the kit wrote was edited by
    // hand: drift, shown and left for a person (the spec's "apply asks")
    const asPlaced = (name: string) => { const e = byName.get(name); return e?.kind === "link" && e.link === t.placed[name]; };
    for (const name of want) {
      const link = wantLink(kit, seen, t, name, dev);
      const e = byName.get(name);
      if (!e) out.push({ kind: "link", agent: t.agent, name, link });
      else if (name in t.placed && asPlaced(name) && e.link !== link) out.push({ kind: "relink", agent: t.agent, name, link });
    }
    for (const name of Object.keys(t.placed)) {
      if (want.includes(name)) continue;
      if (asPlaced(name)) out.push({ kind: "remove", agent: t.agent, name });
    }
  });
  return out;
}

function cell(kit: KitManifest, seen: KitSeen, t: KitSeenTarget, isStore: boolean, skill: string, dev: string, names: string[]): { state: KitCellState; why: string } {
  const e = t.entries.find((x) => x.name === skill);
  // a name the store does not hold is someone else's (Omarchy's links, an
  // agent's own skills): shown, never managed, and no problem
  if (!isStore && !names.includes(skill)) return { state: "local", why: "not in the store; canopy leaves it alone" };
  const managed = !isStore || isSource(kit, skill);
  const isWanted = wanted(kit, skill, t.agent, seen.machine);
  if (isStore && !managed) {
    if ((seen.store?.tracked ?? []).includes(skill)) return e ? { state: "ok", why: "" } : { state: "missing", why: "tracked but not checked out" };
    return { state: "local", why: "only on this machine, not tracked in dotclaude" };
  }
  if (!isWanted) return e ? { state: "local", why: "here, but the manifest does not give it to this agent" } : { state: "off", why: "" };
  if (!present(kit, seen, skill)) return { state: "no-source", why: `no ${kit.only[skill]!.source} here` };
  if (!t.exists && !t.parentExists) return { state: "noagent", why: `${t.dir} has no parent; agent not installed` };
  if (!e) return { state: "missing", why: "" };
  if (!(skill in t.placed)) return { state: "foreign", why: `a ${e.kind} canopy did not place` };
  const link = wantLink(kit, seen, t, skill, dev);
  if (e.kind !== "link" || e.link !== link) return { state: "drift", why: e.kind === "link" ? `points at ${e.link}` : `now a ${e.kind}` };
  return { state: "ok", why: "" };
}

export function planKit(kit: KitManifest, seen: KitSeen, dev: string, ctx?: KitMcpCtx): KitAction[] {
  const skills = planSkills(kit, seen, dev);
  if (!ctx || seen.away || !seen.store) return skills;
  return [...skills, ...planMcp(kit, seen, ctx).actions];
}

export function cellsOf(kit: KitManifest, views: { seen: KitSeen; dev: string; ctx?: KitMcpCtx }[]): KitCell[] {
  const out: KitCell[] = [];
  for (const { seen, dev, ctx } of views) {
    if (seen.away || !seen.store) {
      for (const t of targetsFor(kit, seen.machine)) out.push({ machine: seen.machine, agent: t.agent, skill: "*", state: "away", why: seen.away ?? "no store" });
      continue;
    }
    const names = skillNames(kit, seen);
    seen.targets.forEach((t, i) => {
      const local = t.entries.map((e) => e.name).filter((n) => !names.includes(n) && !excluded(kit, n));
      for (const skill of [...names, ...local]) {
        out.push({ machine: seen.machine, agent: t.agent, skill, ...cell(kit, seen, t, i === 0, skill, dev, names) });
      }
    });
    if (ctx) out.push(...mcpCells(kit, seen, ctx));
  }
  return out;
}

/* ---------- MCP servers (docs/superpowers/specs/2026-10-14-kit-secrets-phase-2-design.md) ---------- */

export const WRAPPER = "~/.claude/bin/canopy-mcp-env";

export const isMcpAction = (a: KitAction): a is KitMcpAction => a.kind.startsWith("mcp-");

export const mcpTargets = (kit: KitManifest, machine: string): (KitTarget & { mcp: KitMcpTarget })[] =>
  targetsFor(kit, machine).filter((t): t is KitTarget & { mcp: KitMcpTarget } => t.mcp !== null);

export const mcpWanted = (s: KitMcpServer, agent: string, machine: string): boolean =>
  (s.agents === null || s.agents.includes(agent)) && (s.machines === null || s.machines.includes(machine));

/** literal and ${env:} values resolved; secrets left to the wrapper. The
 *  values sit under `vals` so a key named `unset` cannot pass for the signal
 *  and carry its value into a why. */
function resolved(vals: Record<string, KitMcpValue>, env: Record<string, string | undefined>): { vals: Record<string, string> } | { unset: string } {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(vals)) {
    if ("secret" in v) continue;
    if ("literal" in v) out[k] = v.literal;
    else {
      const x = env[v.env];
      if (x === undefined) return { unset: v.env };
      out[k] = x;
    }
  }
  return { vals: out };
}

/** the entry one agent's config should hold on this machine, or why it holds none */
export function buildEntry(s: KitMcpServer, agent: string, format: KitMcpFormat, home: string, env: Record<string, string | undefined>): { entry: KitMcpEntry } | { state: KitCellState; why: string } {
  const exp = (v: string) => expandHome(v, home);
  const re = resolved(s.env, env);
  const rh = resolved(s.headers, env);
  if ("unset" in re) return { state: "unresolved", why: `\${env:${re.unset}} is not set for canopy here` };
  if ("unset" in rh) return { state: "unresolved", why: `\${env:${rh.unset}} is not set for canopy here` };
  const e = re.vals;
  const h = rh.vals;
  const sec = secretsOf(s);
  const wrapper = exp(WRAPPER);
  const opts = Object.fromEntries(Object.entries(s.options[agent] ?? {}).map(([k, v]) => [k, typeof v === "string" ? exp(v) : v]));
  if (s.command !== null) {
    const viaWrapper = Object.keys(sec.env).length > 0;
    const command = viaWrapper ? wrapper : exp(s.command);
    const args = viaWrapper ? [s.name, "--", exp(s.command), ...s.args.map(exp)] : s.args.map(exp);
    const entry: KitMcpEntry = format === "claude-json" ? { type: "stdio", command, args } : { command, args };
    if (Object.keys(e).length > 0) entry["env"] = e;
    return { entry: { ...entry, ...opts } };
  }
  const secretHeaders = Object.keys(sec.headers).length > 0;
  if (format === "codex-toml") {
    if (secretHeaders) return { state: "unsupported", why: "not supported for codex: a url server with secret headers" };
    const entry: KitMcpEntry = { url: s.url };
    if (Object.keys(h).length > 0) entry["http_headers"] = h;
    return { entry: { ...entry, ...opts } };
  }
  const entry: KitMcpEntry = { type: "http", url: s.url };
  if (Object.keys(h).length > 0) entry["headers"] = h;
  if (secretHeaders) entry["headersHelper"] = `${wrapper} --headers ${s.name}`;
  return { entry: { ...entry, ...opts } };
}

const bare = (e: KitMcpEntry): KitMcpEntry =>
  Object.fromEntries(Object.entries(e).filter(([k, v]) => !(k === "type" && v === "stdio") && !(Array.isArray(v) && v.length === 0) && !(isObj(v) && Object.keys(v).length === 0)));

/** the same server: `type: "stdio"` and empty lists and tables are what each CLI leaves out or adds */
export const sameEntry = (a: KitMcpEntry, b: KitMcpEntry): boolean => canonical(bare(a)) === canonical(bare(b));

/** whether each of the server's secrets allows this definition, an older one, or none */
export function allowanceOf(s: KitMcpServer, hash: string, info: SecretsInfo): "allowed" | "stale" | "none" {
  const sec = secretsOf(s);
  const names = [...Object.values(sec.env), ...Object.values(sec.headers)];
  const hashes = names.map((n) => info.secrets.find((m) => m.name === n)?.allow.map(parseMcpAllow).find((p) => p?.server === s.name)?.hash ?? null);
  if (hashes.every((x) => x === hash)) return "allowed";
  return hashes.some((x) => x !== null) ? "stale" : "none";
}

function sinkReady(info: SecretsInfo, id: string, keys: string[]): { ok: true } | { waiting: true } | { why: string } {
  const k = info.sinks.find((x) => x.id === id);
  if (!k) return { why: `no sink ${id}; allow it again` };
  if (k.error) return { why: `sink ${id}: ${k.error}` };
  const states = keys.map((key) => k.state[key] ?? "unknown");
  if (states.every((x) => x === "same")) return { ok: true };
  if (states.some((x) => x === "waiting")) return { waiting: true };
  return { why: `sink ${id} reads ${states.join(", ")}` };
}

/** whether a server's secrets can reach it on this machine now */
export function serverReady(s: KitMcpServer, machine: string, ctx: KitMcpCtx): { ok: true } | { waiting: true } | { state: KitCellState; why: string } {
  if (!hasSecrets(s)) return { ok: true };
  if (ctx.ssh) return { state: "phase-3", why: "a server with secrets on an ssh machine waits for secrets phase 3" };
  if (!ctx.secrets?.ok) return { state: "no-sink", why: "this backend cannot read the secret store" };
  const a = allowanceOf(s, ctx.hashes[s.name] ?? "", ctx.secrets);
  if (a === "none") return { state: "not-allowed", why: "not allowed; allow it from the kit view" };
  if (a === "stale") return { state: "stale-allowance", why: "allowed for an older definition; allow it again" };
  if (!ctx.mcp.ignored) return { state: "no-sink", why: "dotclaude does not ignore mcp-env/ here; pull dotclaude" };
  if (!ctx.mcp.wrapper) return { state: "no-sink", why: "~/.claude/bin/canopy-mcp-env is missing; pull dotclaude" };
  const sec = secretsOf(s);
  let waiting = false;
  for (const [id, keys] of [[mcpSinkId(s.name, machine), Object.keys(sec.env)], [mcpSinkId(s.name, machine, true), Object.keys(sec.headers)]] as const) {
    if (keys.length === 0) continue;
    const r = sinkReady(ctx.secrets, id, keys);
    if ("why" in r) return { state: "no-sink", why: r.why };
    if ("waiting" in r) waiting = true;
  }
  return waiting ? { waiting: true } : { ok: true };
}

interface McpRow { agent: string; name: string; state: KitCellState; why: string; want: KitMcpEntry | null; restore: boolean; action: KitAction | null }

function mcpRows(kit: KitManifest, seen: KitSeen, ctx: KitMcpCtx): McpRow[] {
  const out: McpRow[] = [];
  for (const t of mcpTargets(kit, seen.machine)) {
    const file = ctx.mcp.files.find((x) => x.agent === t.agent);
    const placed = ctx.mcp.owned.placed[t.agent] ?? [];
    const adopted = ctx.mcp.owned.adoptedFrom[t.agent] ?? {};
    const mine = kit.mcp.filter((s) => mcpWanted(s, t.agent, seen.machine));
    const row = (name: string, state: KitCellState, why: string, extra: Partial<McpRow> = {}): McpRow =>
      ({ agent: t.agent, name, state, why, want: null, restore: name in adopted, action: null, ...extra });
    if (!file || file.entries === null) {
      for (const s of mine) out.push(row(s.name, "drift", file?.error ?? `${t.mcp.file} was not read`));
      continue;
    }
    if (t.mcp.format === "claude-json" && !ctx.mcp.claude) {
      for (const s of mine) out.push(row(s.name, "noagent", "no claude binary found here"));
      continue;
    }
    const entries = file.entries;
    for (const name of [...new Set([...kit.mcp.map((s) => s.name), ...Object.keys(entries), ...placed, ...Object.keys(adopted)])].sort()) {
      const s = mine.find((x) => x.name === name);
      const have = entries[name] ?? null;
      const owned = placed.includes(name);
      const remove: Partial<McpRow> = owned && have ? { action: { kind: "mcp-remove", agent: t.agent, name } } : {};
      if (!s) {
        const known = kit.mcp.some((x) => x.name === name);
        if (owned && have) out.push(row(name, "drift", "kit.json no longer gives it here; apply removes it", remove));
        else if (have) out.push(row(name, "local", known ? "here, but the manifest does not give it to this agent" : "hand-made; kit.json does not define it"));
        else if (name in adopted) out.push(row(name, "off", "canopy took it out; put back restores the hand-made one"));
        else if (known) out.push(row(name, "off", ""));
        continue;
      }
      // a written server comes out only on positive knowledge (not allowed,
      // allowed for an older definition, a definition this agent cannot take,
      // or dropped from the manifest above); anything else that keeps it from
      // being written keeps what it has
      const kept = (why: string) => (owned && have ? `${why}; keeps what it has` : have ? `${why}; a hand-made entry is there` : why);
      const built = buildEntry(s, t.agent, t.mcp.format, ctx.home, ctx.env);
      if ("state" in built) {
        out.push(built.state === "unsupported" ? row(name, built.state, have && !owned ? `${built.why}; a hand-made entry is there` : built.why, remove) : row(name, built.state, kept(built.why)));
        continue;
      }
      const ready = serverReady(s, seen.machine, ctx);
      if ("state" in ready) {
        const unwanted = ready.state === "not-allowed" || ready.state === "stale-allowance";
        out.push(unwanted ? row(name, ready.state, have && !owned ? `${ready.why}; a hand-made entry is there` : ready.why, remove) : row(name, ready.state, kept(ready.why)));
        continue;
      }
      if ("waiting" in ready) {
        // the sink file keeps the last value while the Mac is locked, so a written server stays (review focus 1)
        out.push(owned && have ? row(name, "ok", "waiting for unlock; keeps what it has") : row(name, "no-sink", "waiting for unlock"));
        continue;
      }
      const want = built.entry;
      const set: KitAction = { kind: "mcp-set", agent: t.agent, name };
      if (!have) out.push(row(name, "missing", "", { want, action: set }));
      else if (!owned) out.push(row(name, "adoptable", sameEntry(have, want) ? "a hand-made entry the same as the kit's; adopt to manage it" : "a hand-made entry; adopt shows both", { want }));
      else if (sameEntry(have, want)) out.push(row(name, "ok", "", { want }));
      else out.push(row(name, "drift", "differs from kit.json; apply writes the kit's version", { want, action: set }));
    }
  }
  return out;
}

/** the MCP actions apply all takes (never an adopt), and every entry the
 *  kit would write here, keyed "<agent>/<name>", for apply and adopt */
export function planMcp(kit: KitManifest, seen: KitSeen, ctx: KitMcpCtx): { actions: KitAction[]; entries: Record<string, KitMcpEntry> } {
  if (seen.away) return { actions: [], entries: {} };
  const rows = mcpRows(kit, seen, ctx);
  return {
    actions: rows.flatMap((r) => (r.action ? [r.action] : [])),
    entries: Object.fromEntries(rows.flatMap((r) => (r.want ? [[`${r.agent}/${r.name}`, r.want]] : []))),
  };
}

export function mcpCells(kit: KitManifest, seen: KitSeen, ctx: KitMcpCtx): KitCell[] {
  if (seen.away) return [];
  return mcpRows(kit, seen, ctx).map((r) => ({ machine: seen.machine, agent: r.agent, skill: r.name, state: r.state, why: r.why, kind: "mcp" as const, ...(r.restore ? { restore: true } : {}) }));
}

const SECRETISH = /token|secret|password|passwd|auth|bearer|cookie|key/i;
const LONG = /[A-Za-z0-9_\-+/=]{24,}/g;
const DOT = "•••";
/** a run of 24 or more token characters holding both a digit and a letter reads as a token */
/** a url's userinfo, up to the last @ before the host's end */
const USERINFO = /([a-z][a-z0-9+.-]*:\/\/)[^\s/?#]*@/gi;
const maskText = (v: string): string =>
  v.replace(USERINFO, `$1${DOT}@`).replace(LONG, (m) => (/\d/.test(m) && /[A-Za-z]/.test(m) ? DOT : m));
/** a header written as one arg, `Name: value` */
const HEADER_ARG = /^([A-Za-z][A-Za-z0-9_-]*):\s/;
const maskArg = (v: string): string => {
  const i = v.indexOf("=");
  if (i > 0 && SECRETISH.test(v.slice(0, i))) return `${v.slice(0, i + 1)}${DOT}`;
  const h = HEADER_ARG.exec(v);
  if (h && SECRETISH.test(h[1] ?? "")) return `${h[1]}: ${DOT}`;
  return maskText(v);
};
/** args with the word after a secret-named flag (`--api-key VALUE`) hidden whole */
const maskArgs = (xs: unknown[]): unknown[] =>
  xs.map((x, i) => {
    const prev = xs[i - 1];
    if (typeof x === "string" && typeof prev === "string" && prev.startsWith("-") && !prev.includes("=") && SECRETISH.test(prev)) return DOT;
    return typeof x === "string" ? maskArg(x) : isObj(x) ? maskEntry(x) : x;
  });
function maskUrl(u: string): string {
  const i = u.indexOf("?");
  if (i < 0) return maskText(u);
  const q = u.slice(i + 1).split("&").map((p) => (p.includes("=") ? `${p.slice(0, p.indexOf("="))}=${DOT}` : p));
  return `${maskText(u.slice(0, i))}?${q.join("&")}`;
}

/** An entry with every value that could be a secret hidden: env and
 *  header values, a url's userinfo and query values, `name=` args, the
 *  word after a `--name` flag, `Name: value` args and options whose name
 *  says token, and anything token-shaped. Names stay. For the adopt
 *  preview, which may show a hand-made entry holding a literal value. */
export function maskEntry(e: KitMcpEntry): KitMcpEntry {
  const out: KitMcpEntry = {};
  for (const [k, v] of Object.entries(e)) {
    if (["env", "headers", "http_headers", "env_http_headers"].includes(k) && isObj(v)) out[k] = Object.fromEntries(Object.keys(v).map((n) => [n, DOT]));
    else if (k === "url" && typeof v === "string") out[k] = maskUrl(v);
    else if (typeof v === "string") out[k] = SECRETISH.test(k) && !k.endsWith("_env_var") && k !== "headersHelper" ? DOT : maskText(v);
    else if (Array.isArray(v)) out[k] = maskArgs(v);
    else out[k] = isObj(v) ? maskEntry(v) : v;
  }
  return out;
}
