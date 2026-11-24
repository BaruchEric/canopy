// Loadouts (FR-065): the `loadoutBase` and `loadouts` blocks of kit.json,
// parsed and checked against the kit's servers, with the providers a loadout
// may name and the defaults that hand one to a start that names none
// (FR-069). Pure and browser-safe.
import { takesEffort, takesModel } from "./harness";
import { parseProviders } from "./providers";
import { TREES_SOURCE } from "./treewords";
import {
  AGENT_LAYERS,
  isHarness,
  LAUNCH_SOURCE,
  NO_LOADOUT,
  DEFAULT_PROVIDER,
  type AgentLayer,
  type AgentSettings,
  type CardEquip,
  type Harness,
  type KitManifest,
  type KitMcpEntry,
  type KitProvider,
  type Loadout,
  type LoadoutDefault,
  type LoadoutDefaults,
  type LoadoutFrom,
  type LoadoutsInfo,
  type Mention,
  type Repo,
  type RunEquip,
} from "./types";

export const LOADOUT_NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;
const SKILL_KEY = /^[A-Za-z0-9][\w.-]*(:[A-Za-z0-9][\w.-]*)?$/;
const BASE_KEY = /^[A-Za-z0-9][\w.-]*(:([A-Za-z0-9][\w.-]*|\*))?$/;
const FIELDS = ["note", "harness", "model", "effort", "skills", "mcp", "canopyTools", "provider"];
/** a repo's path under the scan root, or a glob of such paths: no leading
 *  slash, no `..`, `*` for any run of characters */
const REPO_KEY = /^[A-Za-z0-9._*-]+(\/[A-Za-z0-9._*-]+)*$/;

export const EMPTY_LOADOUTS: LoadoutsInfo = { base: [], loadouts: [], errors: [], servers: [] };

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

function parseOne(name: string, o: Record<string, unknown>, kit: KitManifest, providers: readonly KitProvider[], errors: string[]): Loadout | null {
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
      bad("harness", "claude, codex or antigravity");
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
    else if (harness !== "claude" && l.length > 0) bad("skills", `${harness === "antigravity" ? "an Antigravity" : "a codex"} loadout takes no skills`);
    else skills = l;
  }

  let mcp: string[] = [];
  if (o["mcp"] !== undefined) {
    const l = list(o["mcp"], () => true);
    if (!l) bad("mcp", "a list of server names");
    else if (harness !== "claude" && l.length > 0) bad("mcp", `${harness === "antigravity" ? "an Antigravity" : "a codex"} loadout takes no servers`);
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

  let provider: string | undefined;
  if (o["provider"] !== undefined && harnessOk) {
    const p = typeof o["provider"] === "string" ? providers.find((x) => x.id === o["provider"]) : undefined;
    if (!p) bad("provider", `no provider ${String(o["provider"])} in kit.json's providers`);
    else if (p.harness !== harness) bad("provider", `${p.id} is a ${p.harness} provider; the loadout runs ${harness}`);
    else provider = p.id;
  }

  if (errors.length > before) return null;
  return { name, note, harness, model, effort, skills, mcp, canopyTools, ...(provider ? { provider } : {}) };
}

/** A default's value: a loadout that parsed, or `none`. */
function defaultValue(v: unknown, at: string, loadouts: readonly Loadout[], errors: string[]): string | null {
  if (v === NO_LOADOUT) return NO_LOADOUT;
  if (typeof v !== "string" || !LOADOUT_NAME.test(v)) { errors.push(`${at}: a loadout's name or none`); return null; }
  if (!loadouts.some((l) => l.name === v)) { errors.push(`${at}: no loadout ${v} that parsed`); return null; }
  return v;
}

/** kit.json's `defaults` block (FR-069), checked against the loadouts that
 *  parsed and the machines kit.json declares. An entry with a problem is left
 *  out and named; the rest still apply. */
function parseDefaults(raw: unknown, kit: KitManifest, loadouts: readonly Loadout[], errors: string[]): LoadoutDefaults | undefined {
  if (raw === undefined) return undefined;
  if (!isObj(raw)) { errors.push("defaults: an object with loadout, machines and repos"); return undefined; }
  for (const k of Object.keys(raw)) if (!["loadout", "machines", "repos"].includes(k)) errors.push(`defaults.${k}: not a defaults field`);
  const out: LoadoutDefaults = { loadout: null, machines: {}, repos: {} };
  if (raw["loadout"] !== undefined) out.loadout = defaultValue(raw["loadout"], "defaults.loadout", loadouts, errors);
  const block = (field: "machines" | "repos", keyOk: (k: string) => string | null): void => {
    const v = raw[field];
    if (v === undefined) return;
    if (!isObj(v)) { errors.push(`defaults.${field}: an object of ${field === "machines" ? "machine" : "repo path"} to loadout`); return; }
    for (const [k, x] of Object.entries(v)) {
      const why = keyOk(k);
      if (why) { errors.push(`defaults.${field}.${k}: ${why}`); continue; }
      const name = defaultValue(x, `defaults.${field}.${k}`, loadouts, errors);
      if (name !== null) out[field][k] = name;
    }
  };
  // a typo in a machine's name would keep its default off where it was meant for
  block("machines", (k) => (kit.machines.some((m) => m.name === k) ? null : "not a machine kit.json declares"));
  block("repos", (k) => (REPO_KEY.test(k) && !k.split("/").includes("..") ? null : "a repo's path under the dev folder, like dev-tools/canopy, or a glob like dev-tools/*"));
  return out;
}

/** kit.json's `loadoutBase` and `loadouts` blocks. A loadout with a problem
 *  is left out and named in `errors`; the rest still parse. With no kit
 *  there is nothing to check servers against, so no loadout is taken. */
export function parseLoadouts(raw: unknown, kit: KitManifest | null): LoadoutsInfo {
  if (!isObj(raw) || (raw["loadouts"] === undefined && raw["loadoutBase"] === undefined && raw["defaults"] === undefined && raw["providers"] === undefined)) return EMPTY_LOADOUTS;
  if (!kit) return { base: [], loadouts: [], errors: ["loadouts: kit.json did not parse, so no loadout can be checked"], servers: [] };
  const errors: string[] = [];
  // the providers' own problems are named here; the kit hub parses them again for their settings
  const parsedProviders = parseProviders(raw["providers"], kit.machines);
  const providers = parsedProviders.providers;
  errors.push(...parsedProviders.errors);

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
        else if (name === NO_LOADOUT) errors.push(`loadouts.${name}: ${NO_LOADOUT} is kept to mean no loadout`);
        else if (!isObj(def)) errors.push(`loadouts.${name}: not an object`);
        else {
          const l = parseOne(name, def, kit, providers, errors);
          if (l) loadouts.push(l);
        }
      }
    }
  }
  const defaults = parseDefaults(raw["defaults"], kit, loadouts, errors);
  // the servers (and where they run) and the providers' states are filled in
  // by the kit hub, which knows this machine
  return { base, loadouts, errors, servers: [], ...(defaults ? { defaults } : {}) };
}

const globMatch = (pattern: string, s: string): boolean =>
  new RegExp(`^${pattern.split("*").map((x) => x.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`).test(s);

/** The repo patterns in `defaults.repos` that match a repo's path, most
 *  specific first: the exact key, then globs by length, longest first. */
export function repoKeysFor(repos: Readonly<Record<string, string>>, rel: string): string[] {
  const keys = Object.keys(repos);
  const exact = keys.filter((k) => k === rel);
  const globs = keys.filter((k) => k !== rel && k.includes("*") && globMatch(k, rel)).sort((a, b) => b.length - a.length || a.localeCompare(b));
  return [...exact, ...globs];
}

/** The route layer each default loadout stands level with (FR-083): a
 *  repo's default with the repo's whole route, a machine's with the
 *  backend's default profile, and kit.json's, which reaches every machine,
 *  below both. */
const DEFAULT_LEVEL: Record<LoadoutFrom, AgentLayer> = { repo: "repo", machine: "default", default: "builtin" };

const ROUTE_WORD: Record<AgentLayer, string> = {
  explicit: "agent picked for this start",
  "repo-workflow": "repo's route for this workflow",
  workflow: "route for this workflow",
  "repo-task": "repo's route for this task",
  task: "route for this task",
  "repo-role": "repo's route for this role",
  repo: "repo's route",
  role: "route for this role",
  default: "default profile",
  builtin: "builtin agent",
};

/** Why a default loadout gives way to the route a start already has, or
 *  null when it does not (FR-083). A narrower setting beats a broader one:
 *  a route set for the repo, the task, the workflow or the role is
 *  narrower than a default for the whole machine, and anything this
 *  backend routes is narrower than kit.json's default for every machine.
 *  At the same level the loadout wins, since it carries skills and
 *  servers as well as the agent. */
export function routeBeatsDefault(route: AgentLayer | null, from: LoadoutFrom): string | null {
  if (route === null) return null;
  return AGENT_LAYERS.indexOf(route) < AGENT_LAYERS.indexOf(DEFAULT_LEVEL[from]) ? `gives way to the ${ROUTE_WORD[route]}` : null;
}

/** The loadout a start that names none takes (FR-069): the repo's default,
 *  then the machine's, then kit.json's. `none` at any of them stops there
 *  with no loadout. A default the start's route is narrower than
 *  (`at.route`, the layer its agent came from, or null to hear none:
 *  FR-083), one naming a
 *  loadout kit.json does not hold, or one `fits` turns away (a harness the
 *  start cannot run) is passed over and named in `skipped`. */
export function defaultLoadout(
  info: Pick<LoadoutsInfo, "defaults" | "loadouts">,
  at: { machine: string | null; rel: string | null; route: AgentLayer | null },
  fits: (l: Loadout) => string | null = () => null,
): LoadoutDefault {
  const d = info.defaults;
  const skipped: string[] = [];
  const done = (r: LoadoutDefault): LoadoutDefault => (skipped.length > 0 ? { ...r, skipped } : r);
  if (!d) return { name: null, from: null };
  const tries: { from: LoadoutFrom; key?: string; name: string }[] = [
    ...(at.rel === null ? [] : repoKeysFor(d.repos, at.rel).map((key) => ({ from: "repo" as const, key, name: d.repos[key] ?? "" }))),
    ...(at.machine !== null && d.machines[at.machine] !== undefined ? [{ from: "machine" as const, key: at.machine, name: d.machines[at.machine] ?? "" }] : []),
    ...(d.loadout !== null ? [{ from: "default" as const, name: d.loadout }] : []),
  ];
  for (const t of tries) {
    const where = t.key ? `${t.from} ${t.key}` : t.from;
    if (t.name === NO_LOADOUT) return done({ name: null, from: t.from, ...(t.key ? { key: t.key } : {}) });
    const beaten = routeBeatsDefault(at.route, t.from);
    if (beaten) { skipped.push(`${where}: ${t.name} ${beaten}`); continue; }
    const lo = info.loadouts.find((l) => l.name === t.name);
    if (!lo) { skipped.push(`${where}: no loadout ${t.name} in kit.json`); continue; }
    const why = fits(lo);
    if (why) { skipped.push(`${where}: ${t.name} ${why}`); continue; }
    return done({ name: lo.name, from: t.from, ...(t.key ? { key: t.key } : {}) });
  }
  return done({ name: null, from: null });
}

/** The key `defaults.repos` matches a repo by: its path under its source's
 *  root, read back out of its id (bare under the launch root, after
 *  `<source>:` elsewhere), so `dev-tools/canopy` on the Mac and the mini
 *  alike. A kept tree's card has no key of its own; its checkout's is used. */
export function defaultsKey(repo: Pick<Repo, "id" | "source">): string | null {
  if (repo.source === TREES_SOURCE) return null;
  const rel = repo.source === LAUNCH_SOURCE ? repo.id : repo.id.startsWith(`${repo.source}:`) ? repo.id.slice(repo.source.length + 1) : repo.id;
  return rel === "" || rel === "." ? null : rel;
}

/** What `GET /api/loadouts` answers a caller. A coordinator gets base and
 *  loadouts only: kit.json's errors are Eric's to read (a parse error can
 *  quote the file), and the server list is for the person's page. */
export function loadoutsView(info: LoadoutsInfo, caller: string | undefined): LoadoutsInfo | Pick<LoadoutsInfo, "base" | "loadouts" | "defaults"> {
  // the defaults name loadouts only, so a manager sees what a card it leaves bare takes
  return caller === "coordinator" ? { base: info.base, loadouts: info.loadouts, ...(info.defaults ? { defaults: info.defaults } : {}) } : info;
}

/** The loadout a card starts with: the named one with Eric's overrides laid
 *  over, never holding canopy's tools, since a manager's worker never does.
 *  The card's checks ran when it was planned; kit.json may have changed
 *  since, so the name and the overrides are checked again here. */
export function cardLoadout(equip: CardEquip, info: LoadoutsInfo): Loadout | { refused: string } {
  const name = equip.loadout ?? "";
  const lo = info.loadouts.find((l) => l.name === name);
  if (!lo) return { refused: `no loadout ${name} in kit.json` };
  if (lo.harness !== "claude" && (equip.skills !== undefined || equip.mcp !== undefined)) return { refused: `${lo.harness === "antigravity" ? "an Antigravity" : "a codex"} loadout takes no skills or servers` };
  if (equip.mcp?.includes("canopy")) return { refused: "a card's worker never holds canopy's own server" };
  if (equip.model !== undefined && !takesModel(lo.harness, equip.model)) return { refused: `${lo.harness} does not take ${equip.model}` };
  if (equip.effort !== undefined && !takesEffort(lo.harness, equip.effort)) return { refused: `${lo.harness} does not take ${equip.effort}` };
  if (equip.provider !== undefined && equip.provider !== DEFAULT_PROVIDER) {
    const p = info.providers?.find((x) => x.id === equip.provider);
    if (!p) return { refused: `no provider ${equip.provider} in kit.json` };
    if (p.harness !== lo.harness) return { refused: `${p.id} is a ${p.harness} provider; ${lo.name} runs ${lo.harness}` };
  }
  const provider = equip.provider ?? lo.provider;
  const { provider: _own, ...rest } = lo;
  return {
    ...rest,
    model: equip.model ?? lo.model,
    effort: equip.effort ?? lo.effort,
    skills: [...(equip.skills ?? lo.skills)],
    mcp: [...(equip.mcp ?? lo.mcp)],
    canopyTools: false,
    ...(provider ? { provider } : {}),
  };
}

/** The loadout a run started with, rebuilt from its equip, so a restart gets the same one whatever kit.json says now. */
export function loadoutOfEquip(equip: RunEquip, harness: Harness): Loadout {
  return {
    name: equip.loadout, note: "", harness, model: equip.model, effort: equip.effort, skills: [...equip.skills], mcp: [...equip.mcp], canopyTools: false,
    ...(equip.provider ? { provider: equip.provider } : {}),
  };
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
  /** why the loadout's provider cannot serve a start here, or null */
  providerRefusal?: (id: string) => string | null;
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
  if (loadout.provider) {
    const why = o.providerRefusal?.(loadout.provider) ?? null;
    if (why) return { refused: `loadout ${loadout.name}: ${why}` };
  }
  const ownSettings = loadout.harness !== "claude";
  const { provider: _provider, ...rest } = o.agent;
  const kept = loadout.harness === o.agent.harness ? o.agent : { ...rest, extra: "" };
  // the loadout's provider beats the route's; with none, the route's stays on its own harness
  const agent: AgentSettings = { ...kept, harness: loadout.harness, model: loadout.model, effort: loadout.effort, ...(loadout.provider ? { provider: loadout.provider } : {}) };
  const { overrides, plugins, pluginsOff, off }: SkillPlan = ownSettings ? { overrides: {}, plugins: {}, pluginsOff: [], off: 0 } : skillOverridesFor(loadout, o.info.base, o.skills);
  return {
    agent,
    overrides,
    plugins,
    servers: ownSettings ? {} : servers,
    canopyTools: loadout.canopyTools,
    equip: {
      loadout: loadout.name, model: loadout.model, effort: loadout.effort, skills: [...loadout.skills], mcp: [...loadout.mcp], off,
      ...(pluginsOff.length > 0 ? { pluginsOff } : {}),
      ...(loadout.provider ? { provider: loadout.provider } : {}),
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
