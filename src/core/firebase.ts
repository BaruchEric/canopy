/**
 * The Firebase side of a vercel+firebase deploy (spec amendment 6, ruling
 * 10), pure and tested: what `firebase.json` may hold, the project id canopy
 * makes, the web app config as Vercel env, and what the CLI's --json answers
 * say. The deploy itself is shipper.ts. Browser-safe.
 */
import { FIREBASE_ENV, FIREBASE_ENV_PREFIXES } from "./sprout";

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** the keys a firebase.json may hold: Firestore's rules and indexes, the emulators' settings, and its schema */
const TOP_KEYS = new Set(["$schema", "emulators", "firestore"]);
const FIRESTORE_KEYS = new Set(["rules", "indexes"]);

/** a plain relative path inside the clone: no absolute path, no `..`, no backslash, no odd characters */
export const isPlainRelative = (p: string): boolean =>
  /^[A-Za-z0-9._/-]+$/.test(p) && !p.startsWith("/") && p.split("/").every((part) => part !== "" && part !== "." && part !== "..");

/** a predeploy or postdeploy hook anywhere in the tree, by the path that names it */
function hookIn(v: unknown, at: string): string | null {
  if (Array.isArray(v)) {
    for (const [i, x] of v.entries()) {
      const found = hookIn(x, `${at}[${i}]`);
      if (found) return found;
    }
    return null;
  }
  if (!isObj(v)) return null;
  for (const [k, x] of Object.entries(v)) {
    const here = at ? `${at}.${k}` : k;
    if (/^(pre|post)deploy$/i.test(k)) return here;
    const found = hookIn(x, here);
    if (found) return found;
  }
  return null;
}

/** Why canopy will not deploy with this firebase.json, or null. Only
 *  Firestore's rules and indexes are deployed, so only they and the
 *  emulators' settings may be named; a hook would run a command on the
 *  machine that holds the token, and Storage needs the paid plan. */
export function firebaseConfigRefusal(text: string | null): string | null {
  if (text === null) return "a vercel+firebase project needs a firebase.json naming its Firestore rules";
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return "firebase.json is not JSON";
  }
  if (!isObj(raw)) return "firebase.json must be an object";
  const hook = hookIn(raw, "");
  if (hook) return `firebase.json holds ${hook}; canopy runs no deploy hook`;
  for (const k of Object.keys(raw)) {
    if (!TOP_KEYS.has(k)) return `firebase.json holds ${k}; canopy deploys Firestore rules and indexes only`;
  }
  const fs = raw["firestore"];
  if (!isObj(fs)) return "firebase.json needs firestore, an object naming its rules file";
  for (const k of Object.keys(fs)) {
    if (!FIRESTORE_KEYS.has(k)) return `firebase.json holds firestore.${k}; canopy takes firestore.rules and firestore.indexes only`;
  }
  const rules = fs["rules"];
  if (typeof rules !== "string" || !isPlainRelative(rules)) return "firestore.rules must name a rules file inside the repo by a plain relative path";
  const indexes = fs["indexes"];
  if (indexes !== undefined && (typeof indexes !== "string" || !isPlainRelative(indexes))) return "firestore.indexes must name an indexes file inside the repo by a plain relative path";
  return null;
}

/** the files firebase-tools reads for the deploy, as firebase.json names them */
export function firebaseFiles(text: string): string[] {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return [];
  }
  const fs = isObj(raw) ? raw["firestore"] : null;
  if (!isObj(fs)) return [];
  return [fs["rules"], fs["indexes"]].filter((p): p is string => typeof p === "string");
}

/** words a Google Cloud project id may not hold */
const BANNED = /google|null|undefined|ssl/g;

/** A Firebase project id for the slug: lowercase letters, digits and
 *  hyphens, a letter first, 6 to 30 long, ending in six hex digits that
 *  `hex` gives, so two sprouts never ask for one id. */
export function firebaseProjectId(slug: string, hex: string): string {
  if (!/^[0-9a-f]{6}$/.test(hex)) throw new Error("the project id's suffix is six hex digits");
  let stem = slug
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(BANNED, "app")
    .replace(/-+/g, "-")
    .replace(/^[^a-z]+/, "");
  stem = stem.slice(0, 23).replace(/-+$/, "");
  return `${stem || "sprout"}-${hex}`;
}

/** the web app config firebase-tools printed as Vercel env: each known key
 *  under each public prefix; nothing it did not name */
export function firebaseEnv(config: Readonly<Record<string, unknown>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, name] of Object.entries(FIREBASE_ENV)) {
    const v = config[key];
    if (typeof v !== "string" || !v.trim()) continue;
    for (const prefix of FIREBASE_ENV_PREFIXES) out[`${prefix}${name}`] = v.trim();
  }
  return out;
}

/** firebase-tools' `--json` answer: its result on success, else its error */
export function firebaseResult(stdout: string): { ok: true; result: unknown } | { ok: false; error: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(stdout);
  } catch {
    return { ok: false, error: "the firebase CLI did not answer JSON" };
  }
  if (!isObj(raw)) return { ok: false, error: "the firebase CLI answered something that is not an object" };
  if (raw["status"] === "success") return { ok: true, result: raw["result"] };
  const error = typeof raw["error"] === "string" ? raw["error"] : "the firebase CLI failed";
  return { ok: false, error: error.replace(/\s+/g, " ").trim().slice(0, 300) };
}

/** the web app's config in an `apps:sdkconfig WEB --json` result: its `sdkConfig`, or the result itself */
export function sdkConfigOf(result: unknown): Record<string, unknown> | null {
  if (!isObj(result)) return null;
  const inner = result["sdkConfig"];
  if (isObj(inner)) return inner;
  return typeof result["projectId"] === "string" ? result : null;
}
