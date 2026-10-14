/** The kit's pure core (docs/superpowers/specs/2026-10-14-kit-design.md):
 *  the manifest, what each machine should hold, and what to do about it.
 *  Browser-safe: no node imports. */
import type {
  KitAction, KitCell, KitCellState, KitMachine, KitManifest, KitMode, KitRule, KitSeen, KitSeenTarget, KitTarget,
} from "./types";

export const SKILL_NAME = /^[a-z0-9][a-z0-9._-]*$/;
const MODES: readonly KitMode[] = ["store", "link", "copy"];

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const strs = (v: unknown): string[] | null => (Array.isArray(v) && v.every((x) => typeof x === "string") ? v : null);
const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);

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
    targets.push({ agent, skills, mode, machines: t["machines"] === undefined ? null : strs(t["machines"]) });
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
  if (errors.length) return { errors };
  return {
    kit: { machines, targets, default: rule(rawSkills["default"], all), only, exclude: strs(rawSkills["exclude"]) ?? [] },
  };
}

export function expandHome(path: string, home: string): string {
  if (path === "~") return home;
  return path.startsWith("~/") ? `${home}/${path.slice(2)}` : path;
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
