/**
 * The agent harnesses canopy starts, Claude Code and Codex, as one table:
 * everything that differs between them (the binary, how a model, an effort
 * and yolo are spelled on its command line, how a conversation is resumed
 * or continued) is a lookup here, so nothing above it branches on the
 * harness by hand. Browser-safe and pure: the form reads the model and
 * effort lists, and the openers, the server and the runner build argv from
 * it. The shell lines themselves are made where `shellLine` lives
 * (openers, sessions, keep), since that module is not browser-safe.
 */

import { TOKEN_REF, TOKEN_SET_WORD } from "./host";
import { AGENT_MODELS, HARNESSES, isHarness, type AgentEffort, type AgentSettings, type Harness } from "./types";

export { HARNESSES, type Harness };

/** Variables canopy hands the agent's own commands (TAILCHAN_AS, and later
 *  phases' CANOPY_*): by name, each a plain identifier. */
export type AgentEnv = Record<string, string>;

/** The settings for one launch, with the folders beside its cwd it may also
 *  use: a workspace's agent tab names the members on the primary's machine.
 *  Both harnesses spell each one `--add-dir <dir>`. */
export type AgentLaunch = AgentSettings & {
  dirs?: readonly string[];
  /** a Claude provider resolved to this machine: the settings file canopy
   *  passes as `--settings` (`withProviderFile`); the pure table knows no
   *  folder, so an unresolved id puts no flag on the line */
  providerFile?: string;
};

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** a TOML basic string, for a codex `-c` value */
const tomlString = (v: string): string => `"${v.replace(/[\\"]/g, (c) => `\\${c}`)}"`;

export interface HarnessInfo {
  id: Harness;
  /** the word the UI and the error messages use */
  label: string;
  /** one character for a list row */
  glyph: string;
  /** the binary on PATH */
  binary: string;
  /** the models the form offers; for a closed list the only ones taken */
  models: readonly string[];
  /** whether a model outside `models` is taken, as long as it is a plain
   *  name (`MODEL_RE`); claude's list is closed, codex's is a hint */
  openModels: boolean;
  /** a configured provider id's launch override: codex names it in its own
   *  config (`-c model_provider=`), claude takes the settings file the id
   *  resolved to on this machine (`--settings file`) */
  providerArgs: (provider: string | undefined, file?: string) => string[];
  /** the efforts it takes, "default" first */
  efforts: readonly AgentEffort[];
  modelArgs: (model: string) => string[];
  effortArgs: (effort: AgentEffort) => string[];
  /** the permission flags: yolo on, or what "ask" means */
  permissionArgs: (yolo: boolean) => string[];
  /** flags on every line canopy writes for it */
  always: readonly string[];
  /** the flags that hand `env` to the commands the agent runs; none for a
   *  harness whose commands inherit the shell's environment */
  envArgs: (env: AgentEnv) => string[];
  /** the argv after the binary that picks conversation `session` back up */
  resume: (flags: string[], session: string) => string[];
  /** the argv after the binary that picks the folder's last one back up */
  continue: (flags: string[]) => string[];
  /** what yolo and ask mean, for the form's tooltips */
  yoloTitle: string;
  askTitle: string;
}

/** A model name a harness with an open list takes: a plain word, never a
 *  flag (no leading dash) and nothing a shell would split or expand. */
export const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,79}$/;

/** A configured provider name, kept deliberately to bare identifier words. */
export const PROVIDER_RE = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

/** A configured provider id, on either harness: for Codex a
 *  `model_providers` entry in its own config, for Claude Code a settings
 *  file canopy keeps as `<configDir>/providers/<id>.json`, whose `env`
 *  names the gateway (ANTHROPIC_BASE_URL, ANTHROPIC_AUTH_TOKEN,
 *  ANTHROPIC_MODEL), so a run or a shell can go to a local model. */
export function takesProvider(h: Harness, provider: unknown): provider is string {
  return isHarness(h) && typeof provider === "string" && provider !== "default" && PROVIDER_RE.test(provider);
}

/** The launch with a Claude provider resolved to `providers`, this
 *  machine's folder of settings files (`providersDir` in core/store); null
 *  for an agent that starts on another host, which has its own login and
 *  none of this machine's files. A codex id stays its own config's. */
export function withProviderFile<A extends AgentSettings>(a: A, providers: string | null): A & { providerFile?: string } {
  return providers !== null && a.harness === "claude" && takesProvider("claude", a.provider)
    ? { ...a, providerFile: `${providers}/${a.provider}.json` }
    : a;
}

const CLAUDE: HarnessInfo = {
  id: "claude",
  label: "claude",
  glyph: "✳",
  binary: "claude",
  models: AGENT_MODELS,
  openModels: false,
  providerArgs: (provider, file) => (file && takesProvider("claude", provider) ? ["--settings", file] : []),
  efforts: ["default", "low", "medium", "high", "xhigh", "max"],
  modelArgs: (m) => (m === "default" ? [] : ["--model", m]),
  effortArgs: (e) => (e === "default" ? [] : ["--effort", e]),
  permissionArgs: (yolo) => (yolo ? ["--dangerously-skip-permissions"] : []),
  always: [],
  // claude's commands inherit the shell's environment as it is
  envArgs: () => [],
  resume: (flags, session) => [...flags, "--resume", session],
  continue: (flags) => [...flags, "--continue"],
  yoloTitle: "Skip every permission prompt (--dangerously-skip-permissions)",
  askTitle: "Claude asks before anything the rules do not allow",
};

const CODEX: HarnessInfo = {
  id: "codex",
  label: "codex",
  glyph: "◇",
  binary: "codex",
  // a hint for the form's datalist, the models its own picker listed when
  // this was written; any plain name is taken
  models: ["default", "gpt-6-astra", "gpt-6-sol", "gpt-6-luna", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5"],
  openModels: true,
  providerArgs: (provider) => (takesProvider("codex", provider) ? ["-c", `model_provider=${tomlString(provider)}`] : []),
  efforts: ["default", "low", "medium", "high", "xhigh", "max", "ultra"],
  modelArgs: (m) => (m === "default" ? [] : ["-m", m]),
  effortArgs: (e) => (e === "default" ? [] : ["-c", `model_reasoning_effort=${e}`]),
  // ask is spelled out rather than left to config.toml, whose own default
  // may be full access: "ask" in canopy has to mean asking
  permissionArgs: (yolo) =>
    yolo ? ["--dangerously-bypass-approvals-and-sandbox"] : ["-a", "on-request", "-s", "workspace-write"],
  // without the shared daemon the agent runs in the pane itself, so its
  // process, its env (TAILCHAN_AS among it) and its exit are the shell's
  always: ["--no-daemon"],
  // codex hands its commands a filtered environment (the user's config says
  // how: `inherit = "core"` drops everything canopy set on the shell), so
  // each variable canopy means them to have is added to the policy's own
  // `set` table, beside whatever the user sets there
  envArgs: (env) =>
    Object.entries(env)
      .filter(([k, v]) => ENV_NAME.test(k) && ![...v].some((c) => c.charCodeAt(0) < 0x20))
      .flatMap(([k, v]) =>
        // the shell's own token rides as a reference the typed line's shell
        // expands inside the toml quotes, never as a value
        k === "CANOPY_TOKEN" && v === TOKEN_REF
          ? ["-c", TOKEN_SET_WORD]
          : ["-c", `shell_environment_policy.set.${k}=${tomlString(v)}`],
      ),
  resume: (flags, session) => ["resume", ...flags, session],
  continue: (flags) => ["resume", "--last", ...flags],
  yoloTitle: "Skip every approval and the sandbox (--dangerously-bypass-approvals-and-sandbox)",
  askTitle: "Codex asks before commands, in the workspace-write sandbox (-a on-request -s workspace-write)",
};

export const HARNESS: Record<Harness, HarnessInfo> = { claude: CLAUDE, codex: CODEX };

/** Whether a harness takes this model: "default" always, a closed list's
 *  own names, or for an open list any plain name but another harness's
 *  alias, which a flipped harness would otherwise carry over as nonsense
 *  (`codex -m opus`). */
export function takesModel(h: Harness, model: unknown): model is string {
  if (typeof model !== "string") return false;
  if (model === "default") return true;
  const info = HARNESS[h];
  if (info.models.includes(model)) return true;
  if (!info.openModels) return false;
  if ((AGENT_MODELS as readonly string[]).includes(model)) return false;
  return MODEL_RE.test(model);
}

export const takesEffort = (h: Harness, effort: unknown): effort is AgentEffort =>
  typeof effort === "string" && (HARNESS[h].efforts as readonly string[]).includes(effort);

/** The extra-flags box, split the way a shell would: on whitespace, with
 *  single or double quotes holding a word together. Quotes are removed; an
 *  unclosed quote runs to the end. */
export function splitArgs(s: string): string[] {
  const out: string[] = [];
  let word = "";
  let inWord = false;
  let quote: '"' | "'" | null = null;
  for (const ch of s) {
    if (quote) {
      if (ch === quote) quote = null;
      else word += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      inWord = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (inWord) out.push(word);
      word = "";
      inWord = false;
      continue;
    }
    word += ch;
    inWord = true;
  }
  if (inWord) out.push(word);
  return out;
}

/** The flags an interactive agent gets for these settings, in the
 *  harness's own spelling: model, provider, effort, permissions, what it always
 *  takes, the environment its commands are to see, the extra flags as
 *  typed, then the launch's folders. Claude's `--add-dir` takes every
 *  plain word after it, so the folders go after the typed flags (whose
 *  values it would swallow) and no first message rides with them. */
export function agentArgs(a: AgentLaunch, env: AgentEnv = {}): string[] {
  const h = HARNESS[a.harness];
  return [
    ...h.modelArgs(a.model),
    ...h.providerArgs(a.provider, a.providerFile),
    ...h.effortArgs(a.effort),
    ...h.permissionArgs(a.yolo),
    ...h.always,
    ...h.envArgs(env),
    ...splitArgs(a.extra),
    ...(a.dirs ?? []).flatMap((d) => ["--add-dir", d]),
  ];
}

/** The whole argv: the binary, then its flags. */
export const agentArgv = (a: AgentLaunch, env: AgentEnv = {}): string[] => [HARNESS[a.harness].binary, ...agentArgs(a, env)];

/** The argv that picks conversation `session` back up with these settings. */
export const resumeArgv = (a: AgentLaunch, session: string, env: AgentEnv = {}): string[] => {
  const h = HARNESS[a.harness];
  return [h.binary, ...h.resume(agentArgs(a, env), session)];
};

/** a harness's flags: the settings' when they are this harness's, else only
 *  what the harness always takes (a restored shell whose settings are not known) */
const flagsFor = (kind: Harness, a: AgentLaunch | undefined, env: AgentEnv): string[] =>
  a && a.harness === kind ? agentArgs(a, env) : [...HARNESS[kind].always, ...HARNESS[kind].envArgs(env)];

/** The argv that picks the folder's last conversation back up, with
 *  `flagsFor`'s flags. */
export function continueArgv(kind: Harness, a?: AgentLaunch, env: AgentEnv = {}): string[] {
  const h = HARNESS[kind];
  return [h.binary, ...h.continue(flagsFor(kind, a, env))];
}

/** The argv that picks conversation `session` of harness `kind` back up,
 *  with `flagsFor`'s flags: `resumeArgv` for a shell whose settings may be
 *  another harness's or not known at all. */
export function resumeKindArgv(kind: Harness, session: string, a?: AgentLaunch, env: AgentEnv = {}): string[] {
  const h = HARNESS[kind];
  return [h.binary, ...h.resume(flagsFor(kind, a, env), session)];
}

/** Which harnesses have a binary, given how to look one up. */
export const presentHarnesses = (has: (binary: string) => boolean): Harness[] =>
  HARNESSES.filter((h) => has(HARNESS[h].binary));
