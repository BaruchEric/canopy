// Loadouts (FR-065): the `loadoutBase` and `loadouts` blocks of kit.json,
// parsed and checked against the kit's servers. Pure and browser-safe.
import { takesEffort, takesModel } from "./harness";
import {
  isHarness,
  type AgentSettings,
  type Harness,
  type KitManifest,
  type KitMcpEntry,
  type Loadout,
  type LoadoutsInfo,
  type Mention,
  type RunEquip,
} from "./types";

export const LOADOUT_NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;
const SKILL_KEY = /^[A-Za-z0-9][\w.-]*(:[A-Za-z0-9][\w.-]*)?$/;
const BASE_KEY = /^[A-Za-z0-9][\w.-]*(:([A-Za-z0-9][\w.-]*|\*))?$/;
const FIELDS = ["note", "harness", "model", "effort", "skills", "mcp", "canopyTools"];

export const EMPTY_LOADOUTS: LoadoutsInfo = { base: [], loadouts: [], errors: [] };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function list(v: unknown, ok: (s: string) => boolean): string[] | null {
  if (!Array.isArray(v)) return null;
  const out: string[] = [];
  for (const x of v) {
    if (typeof x !== "string" || !ok(x)) return null;
    out.push(x);
  }
  return out;
}

/** Whether `loadoutBase.skills` keeps this skill on: its own name, or
 *  `plugin:*` for any of that plugin's skills. */
export function baseCovers(base: readonly string[], skill: string): boolean {
  return base.some((b) => b === skill || (b.endsWith(":*") && skill.startsWith(b.slice(0, -1))));
}

function parseOne(name: string, o: Record<string, unknown>, kit: KitManifest, errors: string[]): Loadout | null {
  const at = `loadouts.${name}`;
  const before = errors.length;
  const bad = (field: string, why: string): void => void errors.push(`${at}.${field}: ${why}`);
  for (const k of Object.keys(o)) if (!FIELDS.includes(k)) bad(k, "not a loadout field");

  let note = "";
  if (o["note"] !== undefined) {
    if (typeof o["note"] !== "string") bad("note", "a line of text");
    else if (o["note"].length > 200) bad("note", "at most 200 characters");
    else note = o["note"];
  }

  let harness: Harness = "claude";
  let harnessOk = true;
  if (o["harness"] !== undefined) {
    if (isHarness(o["harness"])) harness = o["harness"];
    else {
      harnessOk = false;
      bad("harness", "claude or codex");
    }
  }

  let model = "default";
  if (o["model"] !== undefined && harnessOk) {
    if (takesModel(harness, o["model"])) model = o["model"];
    else bad("model", `${harness} does not take ${String(o["model"])}`);
  }
  let effort: Loadout["effort"] = "default";
  if (o["effort"] !== undefined && harnessOk) {
    if (takesEffort(harness, o["effort"])) effort = o["effort"];
    else bad("effort", `${harness} does not take ${String(o["effort"])}`);
  }

  let skills: string[] = [];
  if (o["skills"] !== undefined) {
    const l = list(o["skills"], (s) => SKILL_KEY.test(s));
    if (!l) bad("skills", "a list of skill names");
    else if (harness === "codex" && l.length > 0) bad("skills", "a codex loadout takes no skills");
    else skills = l;
  }

  let mcp: string[] = [];
  if (o["mcp"] !== undefined) {
    const l = list(o["mcp"], () => true);
    if (!l) bad("mcp", "a list of server names");
    else if (harness === "codex" && l.length > 0) bad("mcp", "a codex loadout takes no servers");
    else {
      const why = l.map((n) => {
        if (n === "canopy") return "canopy's own server comes with canopyTools";
        const s = kit.mcp.find((m) => m.name === n);
        if (!s) return `no server named ${n} in the kit`;
        if (harnessOk && s.agents !== null && !s.agents.includes(harness)) return `${n} is not for ${harness}`;
        return null;
      }).find((w) => w !== null);
      if (why) bad("mcp", why);
      else mcp = l;
    }
  }

  let canopyTools = false;
  if (o["canopyTools"] !== undefined) {
    if (typeof o["canopyTools"] === "boolean") canopyTools = o["canopyTools"];
    else bad("canopyTools", "true or false");
  }

  if (errors.length > before) return null;
  return { name, note, harness, model, effort, skills, mcp, canopyTools };
}

/** kit.json's `loadoutBase` and `loadouts` blocks. A loadout with a problem
 *  is left out and named in `errors`; the rest still parse. With no kit
 *  there is nothing to check servers against, so no loadout is taken. */
export function parseLoadouts(raw: unknown, kit: KitManifest | null): LoadoutsInfo {
  if (!isObj(raw) || (raw["loadouts"] === undefined && raw["loadoutBase"] === undefined)) return EMPTY_LOADOUTS;
  if (!kit) return { base: [], loadouts: [], errors: ["loadouts: kit.json did not parse, so no loadout can be checked"] };
  const errors: string[] = [];

  let base: string[] = [];
  const lb = raw["loadoutBase"];
  if (lb !== undefined) {
    const l = isObj(lb) ? list(lb["skills"] ?? [], (s) => BASE_KEY.test(s)) : null;
    if (l) base = l;
    else errors.push("loadoutBase.skills: a list of skill names");
  }

  const loadouts: Loadout[] = [];
  const block = raw["loadouts"];
  if (block !== undefined) {
    if (!isObj(block)) errors.push("loadouts: an object of loadout name to definition");
    else {
      for (const [name, def] of Object.entries(block)) {
        if (!LOADOUT_NAME.test(name)) errors.push(`loadouts.${name}: a name of lowercase letters, digits and dashes`);
        else if (!isObj(def)) errors.push(`loadouts.${name}: not an object`);
        else {
          const l = parseOne(name, def, kit, errors);
          if (l) loadouts.push(l);
        }
      }
    }
  }
  return { base, loadouts, errors };
}

/** What a loadout start needs from the route and the machine. */
export interface LoadoutStartPlan {
  /** the route's settings with harness, model and effort replaced */
  agent: AgentSettings;
  /** empty for a codex loadout */
  overrides: Record<string, "on" | "off">;
  /** `enabledPlugins` for the run: each plugin it goes without, by its
   *  `name@marketplace` key; empty for a codex loadout */
  plugins: Record<string, false>;
  /** each loadout server's entry, by name */
  servers: Record<string, KitMcpEntry>;
  canopyTools: boolean;
  equip: RunEquip;
}

/** What a claude loadout turns on and off in the run's settings file. */
export interface SkillPlan {
  /** `skillOverrides`: "on" for each listed skill, "off" for each other user skill */
  overrides: Record<string, "on" | "off">;
  /** `enabledPlugins`: false for each plugin the run goes without */
  plugins: Record<string, false>;
  /** those plugins' names */
  pluginsOff: string[];
  /** the user skills turned off plus the skills of the plugins turned off */
  off: number;
}

/** A run's skill switches. Every skill the loadout lists that the machine
 *  has, from any source, gets "on", since the user's own settings may have
 *  turned it off. Every other user skill gets "off", except those the base
 *  covers and any a repo skill of the same name shadows; a repo skill is
 *  never turned off. claude 2.1.323 ignores `skillOverrides` for a plugin's
 *  skills, so a plugin goes off whole through `enabledPlugins`: one with at
 *  least one skill, none of which the loadout lists or the base covers. A
 *  plugin with no skills (hooks or commands only) is left alone, and so is
 *  one the scan read with no key. */
export function skillOverridesFor(
  loadout: Pick<Loadout, "skills">,
  base: readonly string[],
  skills: readonly Mention[],
): SkillPlan {
  const claude = skills.filter((s) => s.kind === "skill" && s.harness === "claude");
  const repo = new Set(claude.filter((s) => s.from === "project").map((s) => s.name));
  const user = new Set(claude.filter((s) => s.from === "user" && !repo.has(s.name)).map((s) => s.name));
  const overrides: Record<string, "on" | "off"> = {};
  let off = 0;
  for (const name of [...new Set(claude.map((s) => s.name))].sort()) {
    if (loadout.skills.includes(name)) overrides[name] = "on";
    else if (user.has(name) && !baseCovers(base, name)) {
      overrides[name] = "off";
      off++;
    }
  }
  const byPlugin = new Map<string, string[]>();
  for (const s of claude) if (s.plugin) byPlugin.set(s.plugin, [...(byPlugin.get(s.plugin) ?? []), s.name]);
  const plugins: Record<string, false> = {};
  const names = new Set<string>();
  for (const key of [...byPlugin.keys()].sort()) {
    const own = byPlugin.get(key) ?? [];
    if (own.some((name) => loadout.skills.includes(name) || baseCovers(base, name))) continue;
    plugins[key] = false;
    const at = key.indexOf("@");
    names.add(at > 0 ? key.slice(0, at) : key);
    off += own.length;
  }
  return { overrides, plugins, pluginsOff: [...names], off };
}

/** Plan a run's start from a loadout, or say why it cannot start. */
export function planLoadoutStart(o: {
  name: string;
  info: LoadoutsInfo;
  agent: AgentSettings;
  skills: readonly Mention[];
  /** the kit's own name for this machine, for the refusal */
  machine: string;
  entryOf: (server: string) => { entry: KitMcpEntry } | { why: string };
}): LoadoutStartPlan | { refused: string } {
  const loadout = o.info.loadouts.find((l) => l.name === o.name);
  if (!loadout) {
    const have = o.info.loadouts.length > 0 ? o.info.loadouts.map((l) => l.name).join(", ") : "none";
    const err = o.info.errors[0];
    return { refused: `no loadout named ${o.name}; kit.json has ${have}${err ? ` (${err})` : ""}` };
  }
  // a claude skill only: a command of the same name or a codex skill is not one the run can be given
  for (const s of loadout.skills) {
    if (!o.skills.some((k) => k.name === s && k.kind === "skill" && k.harness === "claude")) return { refused: `loadout ${loadout.name} names ${s}, which ${o.machine} does not have` };
  }
  const servers: Record<string, KitMcpEntry> = {};
  for (const name of loadout.mcp) {
    const got = o.entryOf(name);
    if ("why" in got) return { refused: `loadout ${loadout.name}: ${got.why}` };
    servers[name] = got.entry;
  }
  const codex = loadout.harness === "codex";
  const { provider: _provider, ...rest } = o.agent;
  const kept = loadout.harness === o.agent.harness ? o.agent : { ...rest, extra: "" };
  const agent: AgentSettings = { ...kept, harness: loadout.harness, model: loadout.model, effort: loadout.effort };
  const { overrides, plugins, pluginsOff, off }: SkillPlan = codex ? { overrides: {}, plugins: {}, pluginsOff: [], off: 0 } : skillOverridesFor(loadout, o.info.base, o.skills);
  return {
    agent,
    overrides,
    plugins,
    servers: codex ? {} : servers,
    canopyTools: loadout.canopyTools,
    equip: {
      loadout: loadout.name, model: loadout.model, effort: loadout.effort, skills: [...loadout.skills], mcp: [...loadout.mcp], off,
      ...(pluginsOff.length > 0 ? { pluginsOff } : {}),
    },
  };
}

/** A provider's settings file with the skill overrides laid over its own
 *  `skillOverrides`, and the plugins off over its own `enabledPlugins`, key
 *  by key. The flag's `enabledPlugins` merges with the user's the same way. */
export function mergeProviderSettings(
  provider: Record<string, unknown> | null,
  overrides: Record<string, "on" | "off">,
  plugins: Record<string, false> = {},
): Record<string, unknown> {
  const own = provider?.["skillOverrides"];
  const ownPlugins = provider?.["enabledPlugins"];
  return {
    ...provider,
    skillOverrides: { ...(isObj(own) ? own : {}), ...overrides },
    ...(Object.keys(plugins).length > 0 ? { enabledPlugins: { ...(isObj(ownPlugins) ? ownPlugins : {}), ...plugins } } : {}),
  };
}
