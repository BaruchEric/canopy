/**
 * What the stage runner reads before each spawn: the stages' own claude
 * settings and codex config. Every stage shares the stages container and
 * can write both, so a stage that runs code could give every later stage
 * hooks, an env, a permission mode, an MCP server or a model provider. The
 * runner refuses a spawn while either holds a key off a short allowlist,
 * and names the file and the key, which the user removes by hand.
 *
 * codex's config is read with Bun's TOML parser, not a line scan: a scan
 * takes a header inside a multi-line string for a real one (and so a real
 * top-level key after it for a table's), and misses an escaped key name.
 * A file the parser cannot read is refused. Bun-only.
 */
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";

/** What a stage's claude settings may hold. A fresh config writes no
 *  settings.json at all (only .claude.json, backups/ and projects/), and a
 *  login writes its account into .claude.json and .credentials.json; the
 *  model picker and the theme are what claude itself would put here. */
export const CLAUDE_SETTINGS_KEYS: readonly string[] = ["$schema", "model", "theme"];

/** What a stage's codex config may hold at its top level: the model and how
 *  it reasons, the personality and service tier codex's own commands set,
 *  the login method, and the notice table where codex records the prompts
 *  it has shown. Never notify, mcp_servers, model_providers,
 *  shell_environment_policy, profiles, or a projects table once the seeds'
 *  trust is swept. */
export const CODEX_CONFIG_KEYS: readonly string[] = [
  "model",
  "model_reasoning_effort",
  "model_reasoning_summary",
  "model_verbosity",
  "personality",
  "service_tier",
  "preferred_auth_method",
  "notice",
];

/** settings past this size are not settings */
const SETTINGS_MAX = 256 * 1024;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
/** a node fs error's code, or undefined */
const codeOf = (e: unknown): string | undefined => (isObj(e) && typeof e["code"] === "string" ? e["code"] : undefined);

/** Why a claude settings file's text may not stand, or null. Pure. */
export function claudeSettingsRefusal(text: string, file: string): string | null {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return `${file} is not JSON, so the stage runner cannot tell what it sets: fix or remove it by hand`;
  }
  if (!isObj(v)) return `${file} is not a JSON object: fix or remove it by hand`;
  const bad = Object.keys(v).find((k) => !CLAUDE_SETTINGS_KEYS.includes(k));
  return bad === undefined ? null : `${file} holds "${bad}", which a stage's settings may not: remove it by hand (allowed: ${CLAUDE_SETTINGS_KEYS.join(", ")})`;
}

/** Why a codex config's text may not stand, or null. Bun (its TOML parser). */
export function codexConfigRefusal(text: string, file: string): string | null {
  let v: unknown;
  try {
    v = Bun.TOML.parse(text);
  } catch {
    return `${file} is not TOML the stage runner can read, so it cannot tell what it sets: fix or remove it by hand`;
  }
  if (!isObj(v)) return `${file} is not TOML the stage runner can read, so it cannot tell what it sets: fix or remove it by hand`;
  const bad = Object.keys(v).find((k) => !CODEX_CONFIG_KEYS.includes(k));
  return bad === undefined ? null : `${file} holds "${bad}", which a stage's codex config may not: remove it by hand (allowed: ${CODEX_CONFIG_KEYS.join(", ")})`;
}

/** A settings file's text, null when there is none, or why it cannot be
 *  read as one. Opened without blocking, so a fifo a stage left in its
 *  place is refused rather than waited on. */
async function readSettings(file: string): Promise<{ text: string | null } | { refused: string }> {
  let fh;
  try {
    fh = await open(file, constants.O_RDONLY | constants.O_NONBLOCK);
  } catch (e) {
    const code = codeOf(e);
    if (code === "ENOENT") return { text: null };
    // a folder in its place opens on Linux and fails here on a Mac; either
    // way it is not a plain file
    if (code === "EISDIR") return { refused: `${file} is not a plain file: remove it by hand` };
    return { refused: `${file} cannot be read (${code ?? "error"}): fix or remove it by hand` };
  }
  try {
    const st = await fh.stat();
    if (!st.isFile()) return { refused: `${file} is not a plain file: remove it by hand` };
    if (st.size > SETTINGS_MAX) return { refused: `${file} is larger than settings ever are: remove it by hand` };
    const text = await fh.readFile("utf8");
    if (text.length > SETTINGS_MAX) return { refused: `${file} is larger than settings ever are: remove it by hand` };
    return { text };
  } finally {
    await fh.close();
  }
}

/** Why no stage may start while the stages' claude settings and codex
 *  config stand as they are, or null: `$CLAUDE_CONFIG_DIR/settings.json`
 *  and `settings.local.json`, and `$CODEX_HOME/config.toml` (each under
 *  HOME's default when its dir is not named). */
export async function stageSettingsRefusal(env: Record<string, string | undefined>): Promise<string | null> {
  const home = env["HOME"] ?? "";
  const claude = env["CLAUDE_CONFIG_DIR"] || join(home, ".claude");
  const codex = env["CODEX_HOME"] || join(home, ".codex");
  for (const name of ["settings.json", "settings.local.json"]) {
    const file = join(claude, name);
    const r = await readSettings(file);
    if ("refused" in r) return r.refused;
    if (r.text !== null) {
      const why = claudeSettingsRefusal(r.text, file);
      if (why) return why;
    }
  }
  const file = join(codex, "config.toml");
  const r = await readSettings(file);
  if ("refused" in r) return r.refused;
  return r.text === null ? null : codexConfigRefusal(r.text, file);
}
