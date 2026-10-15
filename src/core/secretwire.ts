/**
 * The wire between canopy and the secrets service: one JSON line each way
 * per connection. Pure and browser-safe; the page imports the act shapes.
 * Every act needs a passkey session, so ACT_KINDS is the whole gated list.
 */

import { AGE_HEAD, AGE_RECIPIENT, ALLOW, DOTENV_KEY, JSON_PATH, MACHINE, SECRET_NAME, SINK_ID } from "./secretfile";
import type { SecretProposalIn, SecretSinkFormat } from "./types";

export type GateKind = "login" | "register";

export type SecretAct =
  | { a: "reveal"; name: string }
  | { a: "add"; name: string; value: string; description: string; tags: string[] }
  | { a: "edit"; name: string; description: string; tags: string[] }
  | { a: "rotate"; name: string; value: string }
  | { a: "delete"; name: string }
  | { a: "allow"; name: string; allow: string[] }
  | { a: "sink-set"; id: string; machine: string; path: string; format: SecretSinkFormat; keys: Record<string, string> }
  | { a: "sink-remove"; id: string }
  /** the store's value over a drifted mini sink key */
  | { a: "sink-write"; id: string; key: string }
  /** a drifted mini sink key's value into the store */
  | { a: "take"; id: string; key: string }
  | { a: "import-scan" }
  /** `value` only for a names-only proposal; `sink` makes the source a sink */
  | { a: "approve"; proposal: string; name: string; description: string; tags: string[]; value: string | null; sink: { id: string } | null }
  | { a: "reject"; proposal: string }
  /** a machine's age recipient (the Mac's, after `mac-key`); never the mini's */
  | { a: "machine-key"; machine: string; recipient: string }
  | { a: "passkey-remove"; id: string }
  | { a: "passkey-label"; id: string; label: string };

export type ActKind = SecretAct["a"];

export const ACT_KINDS: readonly ActKind[] = [
  "reveal", "add", "edit", "rotate", "delete", "allow", "sink-set", "sink-remove", "sink-write", "take",
  "import-scan", "approve", "reject", "machine-key", "passkey-remove", "passkey-label",
];

export type SecretsRequest =
  | { t: "info"; token: string | null }
  | { t: "audit"; limit: number }
  | { t: "begin"; kind: GateKind; token: string | null; code: string | null }
  | { t: "finish"; kind: GateKind; token: string | null; code: string | null; response: unknown; label: string }
  | { t: "logout"; token: string }
  | { t: "act"; token: string | null; act: SecretAct }
  | { t: "propose"; items: SecretProposalIn[] };

export type SecretsReply = { ok: true; data: unknown } | { ok: false; error: string; gate?: "passkey" };

/** the gate field a refused act carries, and the route's 401 body */
export const PASSKEY = "passkey" as const;

export const LIMITS = {
  line: 1 << 20,
  value: 64 * 1024,
  description: 500,
  tags: 20,
  proposals: 200,
  sealed: 16 * 1024,
  pending: 500,
  field: 512,
  proposalTtlMs: 24 * 3_600_000,
  idleMs: 15 * 60_000,
  maxMs: 60 * 60_000,
  revealHideMs: 20_000,
} as const;

const TAG = /^[a-z0-9][a-z0-9-]{0,31}$/;
const ID = /^[A-Za-z0-9_-]{1,128}$/;

export const encodeLine = (v: SecretsRequest | SecretsReply): string => `${JSON.stringify(v)}\n`;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown, re: RegExp): v is string => typeof v === "string" && re.test(v);
const value = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= LIMITS.value;
const text = (v: unknown): v is string => typeof v === "string" && v.length <= LIMITS.description;
const tags = (v: unknown): v is string[] => Array.isArray(v) && v.length <= LIMITS.tags && v.every((t) => str(t, TAG));
const absPath = (v: unknown): v is string => typeof v === "string" && v.startsWith("/") && v.length <= LIMITS.field && !v.split("/").includes("..");

export function parseAct(v: unknown): SecretAct | { error: string } {
  if (!isObj(v)) return { error: "an act is an object" };
  // every field pulled into a const first, so each guard narrows it
  const { a, name, id, key, machine, path, format, keys, allow, description, proposal, sink, recipient, label } = v;
  const given = v["value"];
  const tagList = v["tags"];
  const bad = (what: string) => ({ error: `${String(a)}: ${what}` });
  switch (a) {
    case "reveal":
    case "delete":
      return str(name, SECRET_NAME) ? { a, name } : bad("a secret name");
    case "add":
      return str(name, SECRET_NAME) && value(given) && text(description) && tags(tagList)
        ? { a, name, value: given, description, tags: tagList }
        : bad("a name, a value, a description and tags");
    case "edit":
      return str(name, SECRET_NAME) && text(description) && tags(tagList) ? { a, name, description, tags: tagList } : bad("a name, a description and tags");
    case "rotate":
      return str(name, SECRET_NAME) && value(given) ? { a, name, value: given } : bad("a name and a value");
    case "allow":
      return str(name, SECRET_NAME) && Array.isArray(allow) && allow.length <= 64 && allow.every((x) => str(x, ALLOW))
        ? { a, name, allow: allow.map(String) }
        : bad("a name and sink:<id> or mcp:<server>#<sha256> entries");
    case "sink-set": {
      if (!str(id, SINK_ID) || !str(machine, MACHINE) || machine === "breakglass" || !absPath(path)) return bad("an id, a machine and an absolute path with no ..");
      if (format !== "dotenv" && format !== "json") return bad("a format, dotenv or json");
      if (!isObj(keys) || Object.keys(keys).length > 64) return bad("keys");
      const out: Record<string, string> = {};
      for (const [k, n] of Object.entries(keys)) {
        if (!(format === "dotenv" ? DOTENV_KEY : JSON_PATH).test(k) || !str(n, SECRET_NAME)) return bad(`the key ${k}`);
        out[k] = n;
      }
      return { a, id, machine, path, format, keys: out };
    }
    case "sink-remove":
      return str(id, SINK_ID) ? { a, id } : bad("a sink id");
    case "sink-write":
    case "take":
      return str(id, SINK_ID) && typeof key === "string" && (DOTENV_KEY.test(key) || JSON_PATH.test(key)) ? { a, id, key } : bad("a sink id and a key");
    case "import-scan":
      return { a };
    case "approve": {
      if (!str(proposal, ID) || !str(name, SECRET_NAME) || !text(description) || !tags(tagList)) return bad("a proposal, a name, a description and tags");
      let val: string | null = null;
      if (given !== null) {
        if (!value(given)) return bad("a value or null");
        val = given;
      }
      let to: { id: string } | null = null;
      if (sink !== null) {
        const sid = isObj(sink) ? sink["id"] : undefined;
        if (!str(sid, SINK_ID)) return bad("a sink id or null");
        to = { id: sid };
      }
      return { a, proposal, name, description, tags: tagList, value: val, sink: to };
    }
    case "reject":
      return str(proposal, ID) ? { a, proposal } : bad("a proposal");
    case "machine-key":
      return str(machine, MACHINE) && machine !== "mini" && machine !== "breakglass" && str(recipient, AGE_RECIPIENT)
        ? { a, machine, recipient }
        : bad("a machine other than mini or breakglass, and an age recipient");
    case "passkey-remove":
      return str(id, ID) ? { a, id } : bad("a passkey id");
    case "passkey-label":
      return str(id, ID) && typeof label === "string" && label.trim() !== "" && label.length <= 60 ? { a, id, label: label.trim() } : bad("a passkey id and a label of 1 to 60 characters");
    default:
      return { error: `unknown act ${String(a)}` };
  }
}

/** A Mac's batch of sealed values. Unauthenticated (it is inert until an
 *  approval on the mini's page), so it is capped by count and size here and
 *  by the pending total in the service. */
export function parseProposals(v: unknown): SecretProposalIn[] | { error: string } {
  if (!Array.isArray(v) || v.length > LIMITS.proposals) return { error: `a batch is at most ${LIMITS.proposals} proposals` };
  const out: SecretProposalIn[] = [];
  for (const p of v) {
    if (!isObj(p)) return { error: "a proposal is an object" };
    const { from, source, key, sealed, merges } = p;
    if (!str(from, MACHINE) || !absPath(source) || typeof key !== "string" || key.length === 0 || key.length > LIMITS.field) return { error: "a proposal needs from, an absolute source and a key" };
    if (typeof sealed !== "string" || sealed.length > LIMITS.sealed || (sealed !== "" && !sealed.startsWith(AGE_HEAD))) return { error: "a proposal's value is sealed with age, at most 16 KiB" };
    if (merges !== null && !str(merges, SECRET_NAME)) return { error: "merges is a secret name or null" };
    out.push({ from, source, key, sealed, merges });
  }
  return out;
}

export function parseRequest(line: string): SecretsRequest | { error: string } {
  if (line.length > LIMITS.line) return { error: "the request is too long" };
  let v: unknown;
  try {
    v = JSON.parse(line);
  } catch {
    return { error: "the request is not JSON" };
  }
  if (!isObj(v)) return { error: "the request is not an object" };
  const token = v["token"] === undefined || v["token"] === null ? null : typeof v["token"] === "string" ? v["token"] : undefined;
  const code = v["code"] === undefined || v["code"] === null ? null : typeof v["code"] === "string" ? v["code"] : undefined;
  if (token === undefined || code === undefined) return { error: "token and code are strings or null" };
  const kind = v["kind"];
  switch (v["t"]) {
    case "info":
      return { t: "info", token };
    case "audit":
      return { t: "audit", limit: typeof v["limit"] === "number" ? Math.max(1, Math.min(500, Math.floor(v["limit"]))) : 100 };
    case "begin":
      return kind === "login" || kind === "register" ? { t: "begin", kind, token, code } : { error: "begin needs kind login or register" };
    case "finish":
      if (kind !== "login" && kind !== "register") return { error: "finish needs kind login or register" };
      return { t: "finish", kind, token, code, response: v["response"], label: typeof v["label"] === "string" ? v["label"].slice(0, 60) : "" };
    case "logout":
      return token ? { t: "logout", token } : { error: "logout needs a token" };
    case "act": {
      const act = parseAct(v["act"]);
      return "error" in act ? act : { t: "act", token, act };
    }
    case "propose": {
      const items = parseProposals(v["items"]);
      return "error" in items ? items : { t: "propose", items };
    }
    default:
      return { error: `unknown request ${String(v["t"])}` };
  }
}

export function parseReply(line: string): SecretsReply | null {
  try {
    const v: unknown = JSON.parse(line);
    if (!isObj(v)) return null;
    if (v["ok"] === true) return { ok: true, data: v["data"] };
    if (v["ok"] === false && typeof v["error"] === "string") return v["gate"] === PASSKEY ? { ok: false, error: v["error"], gate: PASSKEY } : { ok: false, error: v["error"] };
    return null;
  } catch {
    return null;
  }
}
