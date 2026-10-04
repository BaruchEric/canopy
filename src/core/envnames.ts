/**
 * Environment names canopy keeps from what it starts. Pure and tested.
 */

/** the incubator's secrets (vault token, transcribe key, Vercel and Firebase
 *  tokens): read once at start into its own configs, then deleted from
 *  canopy's env */
export const SECRET_ENV = ["CANOPY_VAULT_TOKEN", "CANOPY_TRANSCRIBE_KEY", "VERCEL_TOKEN", "FIREBASE_TOKEN"] as const;

/** never in a shell's environment: the answer token a deploy from before
 *  browser-held answer keys may still set (canopy no longer reads it), and
 *  the incubator's secrets */
export const PRIVATE_ENV = ["CANOPY_TAILCHAN_ANSWER_TOKEN", ...SECRET_ENV] as const;

/** What an incubator stage's processes never get: canopy's GitHub login
 *  (gh's tokens, and the `GIT_CONFIG_*` pairs that make gh git's credential
 *  helper), the ssh agent, the API to call canopy back, tailchan's handle and
 *  broker, and the private names above. A stage is unattended and may run
 *  code an agent wrote (build-new's `bun run`), so it holds no credential of
 *  canopy's to push with or make a repo with. Normal runs keep all of these,
 *  since a push workflow needs them. */
const STAGE_DROPPED: readonly string[] = [
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "GH_ENTERPRISE_TOKEN",
  "GITHUB_ENTERPRISE_TOKEN",
  "GIT_CONFIG_PARAMETERS",
  "GIT_ASKPASS",
  "SSH_ASKPASS",
  "SSH_AUTH_SOCK",
  "CANOPY_API",
  ...PRIVATE_ENV,
];
const GIT_CONFIG_PAIR = /^GIT_CONFIG_(COUNT|KEY_\d+|VALUE_\d+)$/;

/** whether an incubator stage's process goes without the variable */
export const stageDrops = (name: string): boolean => STAGE_DROPPED.includes(name) || GIT_CONFIG_PAIR.test(name) || name.startsWith("TAILCHAN_");

/** `env` without what a stage's process never gets, and without unset entries */
export function stageEnv(env: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined && !stageDrops(k)) out[k] = v;
  return out;
}
