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

import { AGENT_MODELS, HARNESSES, type AgentEffort, type AgentSettings, type Harness } from "./types";

export { HARNESSES, type Harness };

/** Variables canopy hands the agent's own commands (TAILCHAN_AS, and later
 *  phases' CANOPY_*): by name, each a plain identifier. */
export type AgentEnv = Record<string, string>;

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

const CLAUDE: HarnessInfo = {
  id: "claude",
  label: "claude",
  glyph: "✳",
  binary: "claude",
  models: AGENT_MODELS,
  openModels: false,
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
      .flatMap(([k, v]) => ["-c", `shell_environment_policy.set.${k}=${tomlString(v)}`]),
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
 *  harness's own spelling: model, effort, permissions, what it always
 *  takes, the environment its commands are to see, then the extra flags as
 *  typed. */
export function agentArgs(a: AgentSettings, env: AgentEnv = {}): string[] {
  const h = HARNESS[a.harness];
  return [
    ...h.modelArgs(a.model),
    ...h.effortArgs(a.effort),
    ...h.permissionArgs(a.yolo),
    ...h.always,
    ...h.envArgs(env),
    ...splitArgs(a.extra),
  ];
}

/** The whole argv: the binary, then its flags. */
export const agentArgv = (a: AgentSettings, env: AgentEnv = {}): string[] => [HARNESS[a.harness].binary, ...agentArgs(a, env)];

/** The argv that picks conversation `session` back up with these settings. */
export const resumeArgv = (a: AgentSettings, session: string, env: AgentEnv = {}): string[] => {
  const h = HARNESS[a.harness];
  return [h.binary, ...h.resume(agentArgs(a, env), session)];
};

/** The argv that picks the folder's last conversation back up: with the
 *  settings' flags when they are this harness's, else only what the
 *  harness always takes (a restored shell whose settings are not known). */
export function continueArgv(kind: Harness, a?: AgentSettings, env: AgentEnv = {}): string[] {
  const h = HARNESS[kind];
  const flags = a && a.harness === kind ? agentArgs(a, env) : [...h.always, ...h.envArgs(env)];
  return [h.binary, ...h.continue(flags)];
}

/** Which harnesses have a binary, given how to look one up. */
export const presentHarnesses = (has: (binary: string) => boolean): Harness[] =>
  HARNESSES.filter((h) => has(HARNESS[h].binary));
