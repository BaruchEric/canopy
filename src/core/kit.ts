/** The kit's pure core (docs/superpowers/specs/2026-10-14-kit-design.md):
 *  the manifest, what each machine should hold, and what to do about it.
 *  Browser-safe: no node imports. */
import type {
  KitAction, KitCell, KitCellState, KitMachine, KitManifest, KitMcpDef, KitMcpFormat, KitMcpOption, KitMcpServer, KitMcpTarget, KitMcpValue,
  KitMode, KitRule, KitSeen, KitSeenTarget, KitTarget,
} from "./types";
import { canonical, DOTENV_KEY, HEADER_NAME, MCP_SERVER, MCP_SERVER_SRC, mcpSinkId, SECRET_NAME, SINK_ID } from "./secretfile";

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

export function planKit(kit: KitManifest, seen: KitSeen, dev: string): KitAction[] {
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

export function cellsOf(kit: KitManifest, views: { seen: KitSeen; dev: string }[]): KitCell[] {
  const out: KitCell[] = [];
  for (const { seen, dev } of views) {
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
  }
  return out;
}
