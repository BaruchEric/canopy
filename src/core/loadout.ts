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
  /** each loadout server's entry, by name */
  servers: Record<string, KitMcpEntry>;
  canopyTools: boolean;
  equip: RunEquip;
}

/** The `skillOverrides` for a run. Every skill the loadout lists that the
 *  machine has, from any source, gets "on", since the user's own settings may
 *  have turned it off. Every other user or plugin skill gets "off", except
 *  those the base covers and any user skill a repo skill of the same name
 *  shadows. A repo skill is never turned off. */
export function skillOverridesFor(
  loadout: Pick<Loadout, "skills">,
  base: readonly string[],
  skills: readonly Mention[],
): { overrides: Record<string, "on" | "off">; off: number } {
  const claude = skills.filter((s) => s.kind === "skill" && s.harness === "claude");
  const repo = new Set(claude.filter((s) => s.from === "project").map((s) => s.name));
  const have = new Set(claude.map((s) => s.name));
  const offable = new Set<string>();
  for (const s of claude) {
    if ((s.from === "user" || s.from.startsWith("plugin:")) && !repo.has(s.name)) offable.add(s.name);
  }
  const overrides: Record<string, "on" | "off"> = {};
  let off = 0;
  for (const name of [...new Set([...have, ...offable])].sort()) {
    if (loadout.skills.includes(name)) overrides[name] = "on";
    else if (offable.has(name) && !baseCovers(base, name)) {
      overrides[name] = "off";
      off++;
    }
  }
  return { overrides, off };
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
  for (const s of loadout.skills) {
    if (!o.skills.some((k) => k.name === s)) return { refused: `loadout ${loadout.name} names ${s}, which ${o.machine} does not have` };
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
  const { overrides, off } = codex ? { overrides: {}, off: 0 } : skillOverridesFor(loadout, o.info.base, o.skills);
  return {
    agent,
    overrides,
    servers: codex ? {} : servers,
    canopyTools: loadout.canopyTools,
    equip: { loadout: loadout.name, model: loadout.model, effort: loadout.effort, skills: [...loadout.skills], mcp: [...loadout.mcp], off },
  };
}

/** A provider's settings file with the skill overrides laid over its own. */
export function mergeProviderSettings(provider: Record<string, unknown> | null, overrides: Record<string, "on" | "off">): Record<string, unknown> {
  const own = provider?.["skillOverrides"];
  return { ...provider, skillOverrides: { ...(isObj(own) ? own : {}), ...overrides } };
}
