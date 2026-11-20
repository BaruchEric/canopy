// Providers from kit.json (FR-069): the `providers` block parsed, a Claude
// provider's settings resolved against a backend's env, and the plan that
// keeps each backend's `providers/<id>.json` in step with it. Pure and
// browser-safe; the kit hub reads the folder and runs the plan.
import { PROVIDER_RE } from "./harness";
import { DOTENV_KEY } from "./secretfile";
import { isHarness, type Harness, type KitMachine, type KitProvider, type ProviderState, type ProviderView } from "./types";

const FIELDS = ["note", "harness", "machines", "settings"];
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const ENV_REF = /^\$\{env:([^}]*)\}$/;

/** The env names a settings value reads, or why it cannot be read: a string
 *  is a literal or one whole `${env:NAME}`; a secret is refused until the
 *  secret store has a provider sink. */
function refsOf(v: unknown, at: string, names: Set<string>, errors: string[]): void {
  if (typeof v === "string") {
    const m = ENV_REF.exec(v);
    if (m) {
      const name = m[1] ?? "";
      if (DOTENV_KEY.test(name)) names.add(name);
      else errors.push(`${at}: \${env:${name}} is not a variable name`);
    } else if (v.startsWith("${secret:")) errors.push(`${at}: a secret is not taken here yet; read it from the backend's env with \${env:NAME}`);
    else if (v.includes("${")) errors.push(`${at}: holds \${ that is not one whole \${env:NAME}`);
    return;
  }
  if (Array.isArray(v)) v.forEach((x, i) => refsOf(x, `${at}[${i}]`, names, errors));
  else if (isObj(v)) for (const [k, x] of Object.entries(v)) refsOf(x, `${at}.${k}`, names, errors);
}

/** The env variables a provider's settings read, sorted. */
export function envNamesOf(p: Pick<KitProvider, "settings">): string[] {
  const names = new Set<string>();
  if (p.settings) refsOf(p.settings, "", names, []);
  return [...names].sort();
}

/** kit.json's `providers` block. A provider with a problem is left out and
 *  named in `errors`; the rest still parse. */
export function parseProviders(raw: unknown, machines: readonly KitMachine[]): { providers: KitProvider[]; errors: string[] } {
  const errors: string[] = [];
  if (raw === undefined) return { providers: [], errors };
  if (!isObj(raw)) return { providers: [], errors: ["providers: an object of provider id to definition"] };
  const providers: KitProvider[] = [];
  for (const [id, def] of Object.entries(raw)) {
    const at = `providers.${id}`;
    if (!PROVIDER_RE.test(id) || id === "default") { errors.push(`${at}: an id of letters, digits, _ and -, starting with a letter, and not default`); continue; }
    if (!isObj(def)) { errors.push(`${at}: not an object`); continue; }
    const before = errors.length;
    for (const k of Object.keys(def)) if (!FIELDS.includes(k)) errors.push(`${at}.${k}: not a provider field`);
    let note = "";
    if (def["note"] !== undefined) {
      if (typeof def["note"] !== "string" || def["note"].length > 200) errors.push(`${at}.note: a line of at most 200 characters`);
      else note = def["note"];
    }
    let harness: Harness = "claude";
    if (def["harness"] !== undefined) {
      if (isHarness(def["harness"])) harness = def["harness"];
      else errors.push(`${at}.harness: claude or codex`);
    }
    let ms: string[] | null = null;
    if (def["machines"] !== undefined) {
      const l = Array.isArray(def["machines"]) && def["machines"].every((x) => typeof x === "string") ? (def["machines"] as string[]) : null;
      const unknown = l?.find((m) => !machines.some((x) => x.name === m));
      if (!l) errors.push(`${at}.machines: a list of machine names`);
      // a typo would keep the provider off everywhere it was meant for
      else if (unknown !== undefined) errors.push(`${at}.machines: names ${unknown}, which machines does not declare`);
      else ms = l;
    }
    let settings: Record<string, unknown> | null = null;
    if (def["settings"] !== undefined) {
      if (harness !== "claude") errors.push(`${at}.settings: a codex provider lives in codex's own config.toml, so it takes no settings`);
      else if (!isObj(def["settings"])) errors.push(`${at}.settings: a Claude Code settings object`);
      else {
        refsOf(def["settings"], `${at}.settings`, new Set(), errors);
        settings = def["settings"];
      }
    }
    if (errors.length === before) providers.push({ id, note, harness, machines: ms, settings });
  }
  return { providers, errors };
}

/** Whether a provider is for this backend: its machines list names the kit
 *  machine the backend is, or it lists none. */
export const providerHere = (p: Pick<KitProvider, "machines">, machine: string | null): boolean =>
  p.machines === null || (machine !== null && p.machines.includes(machine));

/** A provider's settings with each `${env:NAME}` read from `env`, as the
 *  file's text, or the names `env` does not set. */
export function resolveProvider(p: KitProvider, env: Readonly<Record<string, string | undefined>>): { text: string } | { unresolved: string[] } {
  if (!p.settings) return { unresolved: [] };
  const missing = envNamesOf(p).filter((n) => env[n] === undefined || env[n] === "");
  if (missing.length > 0) return { unresolved: missing };
  const fill = (v: unknown): unknown => {
    if (typeof v === "string") {
      const m = ENV_REF.exec(v);
      return m ? (env[m[1] ?? ""] ?? "") : v;
    }
    if (Array.isArray(v)) return v.map(fill);
    if (isObj(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fill(x)]));
    return v;
  };
  return { text: `${JSON.stringify(fill(p.settings), null, 2)}\n` };
}

/** What the kit wrote into a backend's providers folder: each file's id and
 *  the hash of the text it wrote, and the hand files it moved aside. */
export interface ProvidersRecord {
  written: Record<string, string>;
  adopted: string[];
}

export const EMPTY_PROVIDERS_RECORD: ProvidersRecord = { written: {}, adopted: [] };

/** The record off disk; anything it cannot read is an empty record. */
export function parseProvidersRecord(v: unknown): ProvidersRecord {
  if (!isObj(v)) return { written: {}, adopted: [] };
  const w = isObj(v["written"]) ? v["written"] : {};
  const written: Record<string, string> = {};
  for (const [id, h] of Object.entries(w)) if (PROVIDER_RE.test(id) && typeof h === "string") written[id] = h;
  const adopted = Array.isArray(v["adopted"]) ? v["adopted"].filter((x): x is string => typeof x === "string" && PROVIDER_RE.test(x)) : [];
  return { written, adopted };
}

export type ProviderAction =
  | { kind: "write"; id: string; text: string; hash: string }
  | { kind: "remove"; id: string }
  /** the kit forgets a file it wrote that someone changed, or that is gone */
  | { kind: "forget"; id: string };

/** Plan a backend's providers folder against kit.json. `files` is each
 *  `<id>.json` in the folder with the hash of its text; `hash` hashes a text
 *  the same way. A file the kit did not write is never touched; one it wrote
 *  and someone changed since is left and reads `drift`. */
export function planProviders(o: {
  providers: readonly KitProvider[];
  machine: string | null;
  /** the backend runs in a container whose config folder the shells mount */
  container: boolean;
  env: Readonly<Record<string, string | undefined>>;
  files: Readonly<Record<string, string>>;
  record: ProvidersRecord;
  hash: (text: string) => string;
}): { actions: ProviderAction[]; views: ProviderView[] } {
  const actions: ProviderAction[] = [];
  const views: ProviderView[] = [];
  const kept = new Set<string>();
  for (const p of o.providers) {
    const envNames = envNamesOf(p);
    const keys = p.settings ? [...Object.keys(p.settings), ...(isObj(p.settings["env"]) ? Object.keys(p.settings["env"]).map((k) => `env.${k}`) : [])] : [];
    const view = (state: ProviderState, why?: string): void => {
      views.push({
        id: p.id, note: p.note, harness: p.harness, machines: p.machines, central: p.settings !== null, envNames, keys, state,
        ...(why ? { why } : {}), ...(o.record.adopted.includes(p.id) ? { adopted: true } : {}),
      });
    };
    if (!providerHere(p, o.machine)) { view("off"); continue; }
    if (p.harness === "codex") { view("declared", "a model_providers entry in codex's own config.toml"); continue; }
    const have = o.files[p.id];
    const ours = o.record.written[p.id];
    if (!p.settings) {
      // a file the kit wrote while kit.json held settings is removed below,
      // unless someone changed it, which makes it this machine's own
      const goes = have !== undefined && ours !== undefined && have === ours;
      if (have === undefined || goes) view("missing", `declared without settings, and this machine has no providers/${p.id}.json`);
      else view("hand", "this machine keeps its own file");
      continue;
    }
    if (have !== undefined && ours === undefined) { view("hand", `this machine keeps its own providers/${p.id}.json; adopt to use kit.json's`); continue; }
    if (have !== undefined && ours !== undefined && have !== ours) {
      kept.add(p.id);
      view("drift", `providers/${p.id}.json changed since the kit wrote it; remove it to let the kit write it again`);
      continue;
    }
    if (o.container && envNames.length > 0) {
      kept.add(p.id);
      view("refused", `reads ${envNames.join(", ")} from the env, and this backend's config is on the volume the shells read`);
      continue;
    }
    const got = resolveProvider(p, o.env);
    if ("unresolved" in got) {
      kept.add(p.id);
      view("unresolved", `the backend's env does not set ${got.unresolved.join(", ")}`);
      continue;
    }
    const hash = o.hash(got.text);
    kept.add(p.id);
    if (have !== hash) actions.push({ kind: "write", id: p.id, text: got.text, hash });
    view("ok");
  }
  for (const [id, h] of Object.entries(o.record.written)) {
    if (kept.has(id)) continue;
    const have = o.files[id];
    // gone already, or changed by hand: the kit lets go of it and leaves the file
    if (have === undefined || have !== h) actions.push({ kind: "forget", id });
    else actions.push({ kind: "remove", id });
  }
  return { actions, views };
}
