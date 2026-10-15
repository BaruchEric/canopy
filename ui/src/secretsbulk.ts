/* The import tab's bulk actions: which proposals look like secrets by
   their key name alone, and the approve act each one gets when many go at
   once. Names only; nothing here sees a value. */

import { DOTENV_KEY, JSON_PATH, SINK_ID } from "../../src/core/secretfile";
import type { SecretAct } from "../../src/core/secretwire";
import type { SecretProposalInfo } from "../../src/core/types";

const SECRETY = /(SECRET|TOKEN|PASSWORD|PASSWD|_PASS$|_PW$|_KEY$|^KEY$|_KEY_|APIKEY|PRIVATE|CREDENTIAL|SALT|COOKIE|WEBHOOK|DSN|JWT|SIGNING|ENCRYPTION|_AUTH$|BEARER|DATABASE_URL|_PSK)/i;
/** flags, limits and addresses that borrow a secret-sounding word */
const SETTING = /(^|_)(REQUIRE|ALLOW|ENABLE|DISABLE|MAX|MIN|CONTEXT|LIMIT|TTL|REMOTE|URL|HOST|PORT)(_|$)/i;

/** the last segment of a dotted json or toml path is the key that counts */
export function looksSecret(key: string): boolean {
  const last = key.split(".").pop() ?? key;
  if (/DATABASE_URL|DSN/i.test(last)) return true;
  return SECRETY.test(last) && !SETTING.test(last);
}

/** a stack's env file is named for the stack, any other dotenv or json file
 *  for the file; null when the file cannot be a sink */
export function sinkIdOf(source: string): string | null {
  if (!source.endsWith(".env") && !source.endsWith(".json")) return null;
  const stack = /^\/opt\/stacks\/([^/]+)\//.exec(source)?.[1];
  const file = (source.split("/").pop() ?? "").replace(/\.(env|json)$/, "").replace(/^\.+/, "");
  const id = (stack ?? file).toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
  return SINK_ID.test(id) ? id : null;
}

/** the tag and description word: the stack, else the file's stem */
function placeOf(source: string): string {
  const stack = /^\/opt\/stacks\/([^/]+)\//.exec(source)?.[1];
  if (stack) return stack;
  return (source.split("/").pop() ?? source).replace(/^\.+/, "").replace(/\..*$/, "") || source;
}

/** the act a bulk approve sends, null for a source that only lists names */
export function bulkAct(p: SecretProposalInfo): Extract<SecretAct, { a: "approve" }> | null {
  if (p.namesOnly) return null;
  const place = placeOf(p.source);
  const id = sinkIdOf(p.source);
  const fits = p.source.endsWith(".env") ? DOTENV_KEY.test(p.key) : JSON_PATH.test(p.key);
  return {
    a: "approve",
    proposal: p.id,
    name: p.merges ?? p.suggested,
    description: `${p.key} in ${place}`,
    tags: [place],
    value: null,
    sink: id && fits ? { id } : null,
  };
}

export type PickKind = "secrets" | "settings" | "none";

/** secrets: what looks secret and can be approved without typing; settings:
 *  what does not look secret, to reject */
export function pick(list: readonly SecretProposalInfo[], kind: PickKind): Set<string> {
  if (kind === "none") return new Set();
  return new Set(list.filter((p) => (kind === "secrets" ? looksSecret(p.key) && !p.namesOnly : !looksSecret(p.key))).map((p) => p.id));
}
