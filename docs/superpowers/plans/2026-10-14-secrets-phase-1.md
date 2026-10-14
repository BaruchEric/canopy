# Secret store phase 1 implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** one signed `secrets.json` in the private Forgejo repo `eric/secrets`, written only by a new `secrets` service on the mini behind a passkey, read and verified by every other backend; values sealed one by one with age to the machines that need them; dotenv and JSON sink files kept in step on the mini and the Mac with drift shown; every existing secret source offered for import; a Secrets view and a `canopy secrets` CLI.

**Architecture:** Pure cores first. `src/core/secretfile.ts` owns the file's shape, its canonical JSON, the ed25519 signature and the recipient rule. `src/core/secretcrypt.ts` seals and opens values with `age-encryption`. `src/core/sinks.ts` reads and rewrites dotenv and JSON files without touching keys it does not manage. `src/core/secretwire.ts` is the framed JSON protocol between canopy and the service. The service (`src/secrets/`) is the only process on the mini that holds the mini's age identity and signing key: it owns the checkout in the `secrets-data` volume, the passkeys, the sessions, the audit log and the mini's sinks, and answers on a unix socket that only canopy's group reaches. On the mini, canopy's `SecretsHub` (`src/server/secrets.ts`) relays requests to that socket and turns the session token into a cookie. On every other backend the same hub runs `SecretsReader` (`src/core/secretlocal.ts`): a read-only checkout pulled `--ff-only` and verified against a pinned public key, plus, on the Mac, a passphrase-wrapped identity held in memory after unlock and the Mac's own sinks.

**Tech Stack:** Bun, TypeScript strict, React 19, Zustand, `bun:test`. New dependencies: `age-encryption@0.3.1`, `@simplewebauthn/server@14.0.3`, `@simplewebauthn/browser@14.0.0`.

**Spec:** `docs/superpowers/specs/2026-10-14-secrets-design.md` (read it first). Phase 1 only.

## Not in this plan

These are phases 2 and 3 of the spec, plus one thing the spec does not ask for (the last item). Do not start them here, even where a type leaves room for them.

- MCP references: `${secret:NAME}` in kit MCP entries, the `canopy-mcp-env` wrapper, `~/.claude/mcp-env/<server>.env`, and the `mcp:<server>#<hash>` allowlist entries doing anything. Phase 1 parses and keeps `mcp:` allowlist entries but nothing reads them.
- The rotation impact list and stack restarts (`restart` on a sink, `docker/canopy-restart`, the `~/.ssh/canopy-restart` key). Phase 1 parses and keeps `restart` but never runs it.
- gpd's sinks, written by the Mac over ssh. Phase 1 lets a sink name `gpd` (so the recipient rule is right from day one) and reports it as "phase 3" without writing it.
- The `~/.claude/mcp-env` mount on the service.
- Writing the store's value over a drifted key in a Mac sink from the page. The spec asks only for "take this value" on drift; the mini's `sink-write` act is an addition this plan makes, and the reader gets no forced write. Deleting the key's line from the file makes it missing, and the next sync writes the store's value (`decideKey`, Task 4).

## Global Constraints

- Gates before calling anything done: `bun run typecheck && bun run lint && bun test && bun run build`.
- The kit plan (`docs/superpowers/plans/2026-10-14-kit-phase-1.md`) is landing in the same tree and edits `src/core/types.ts`, `src/server/index.ts`, `ui/src/store.ts`, `ui/src/App.tsx`, `ui/src/cli.ts`, `src/cli/index.ts`, `src/core/help.ts` and `docker-compose.yml`. Land after it. Every step that edits one of those files names a text anchor ("after the `case "health":` line"); the anchor wins over any line hint, and when the kit plan added a sibling next to the anchor (a `kit` view, a `kit` event), put the secrets entry after the kit one.
- `src/core/types.ts`, `src/core/secretfile.ts` and `src/core/secretwire.ts` stay browser-safe: no Bun or node imports. The UI imports the last two.
- No route, log line, audit entry, event, error message or test output ever carries a secret value, a passphrase, a session token, or a hash of a value. The only exception is the `reveal` answer, which goes to the page that asked and nowhere else. Compare values in memory (`sameValue`), never by a stored or reported digest.
- Nothing secret goes into any container's environment. canopy runs with `pid: service:shells`, so a shell can read canopy's `/proc/<pid>/environ`. The service gets its paths, its gid and its origin through env; its keys live in files in `secrets-data`.
- Prose (comments, docs, UI copy) follows the unslop rules: no em dashes, sentence case, plain words.
- Every commit message ends with the line `Claude-Session: https://claude.ai/code/session_01DEgdKaVhnhcGveC62zKQJh` after a blank line, and has no backticks.
- Commits: Eric commits only when he asks. Each task's last step is "commit" and runs only if Eric approved commits for this execution; otherwise leave the change staged and say so. Never push. `main` deploys.
- Stage only the paths a task names. Other sessions leave unrelated edits in this tree.
- Git tests use a temporary bare repo as the remote. No test touches Forgejo, `~/.config/canopy`, `~/.claude` or `/opt/stacks`.
- Operational steps that create or change something outside this repo (the Forgejo repo `eric/secrets`, private and not mirrored to GitHub; its deploy key; the mini redeploy; the Mac's key) are asked for first and run only on a yes.
- Never read a secret value while implementing or verifying: no `cat` of a `.env`, `.credentials.json`, `~/.claude.json`, `~/.codex/config.toml` or anything under `/opt/stacks`. Names, counts and exit codes only (`grep -c`, `test -r`, `wc -c`, `-o /dev/null`).

## Review Focus

1. A gated act with no session, or an expired one, for every act kind: the service answers `{ok: false, gate: "passkey"}`, the route answers 401 with `{error, gate: "passkey"}` and no `login` field, and the page does not start the Cloudflare sign-in flow. Tests in Task 9 (the walk over every act), Task 12 (the route) and Task 14 (the page's `api`).
2. A `secrets.json` with its keys reordered still verifies; one changed byte of metadata fails; a reader keeps its last good commit, names why, and refuses a history that is not a fast-forward. Tests in Task 2 and Task 11.
3. A fixture secret value, and its sha256 hex, never appear in a route answer (other than reveal), the audit log, a log line, an event, or a sink error. Test in Task 16.
4. A sink file with comments, blank lines and keys canopy does not manage: all kept, byte for byte, through a write. A sink value that differs from the store before canopy ever wrote it: drift, never overwritten. A file canopy cannot parse: refused, untouched. Tests in Task 4 and Task 9.
5. A ciphertext moved to another secret's name, or an older ciphertext of the same secret put back: opening fails because the name and the rotation stamp inside it do not match. Test in Task 3.

---

### Task 1: Dependencies and types

**Files:**
- Modify: `package.json`, `bun.lock` (through `bun add`)
- Modify: `src/core/types.ts` (append the secrets block at the end of the file; add one `ServerEvent` member)

**Interfaces:**
- Produces: `SecretSinkFormat`, `SecretMeta`, `SecretKeyState`, `SecretSinkInfo`, `SecretProposalIn`, `SecretProposalInfo`, `SecretPasskeyInfo`, `SecretAuditEntry`, `SecretsInfo`, and the `{ type: "secrets"; info: SecretsInfo }` event, used by Tasks 2 to 16.

- [ ] **Step 1: Add the packages**

```bash
bun add age-encryption@0.3.1 @simplewebauthn/server@14.0.3 @simplewebauthn/browser@14.0.0
```

Expected: three new entries under `dependencies` in `package.json`, exact versions.

- [ ] **Step 2: Add the types**

Append to the end of `src/core/types.ts`:

```ts
/* ---------- the secret store (docs/superpowers/specs/2026-10-14-secrets-design.md) ---------- */

export type SecretSinkFormat = "dotenv" | "json";

/** One secret without its value: what every backend may show. */
export interface SecretMeta {
  name: string;
  description: string;
  tags: string[];
  /** ISO stamps, UTC */
  created: string;
  rotated: string;
  /** the machines the value is sealed to */
  to: string[];
  /** `sink:<id>` and (phase 2) `mcp:<server>#<sha256>` entries */
  allow: string[];
  /** the sinks that map a key to it */
  usedBy: string[];
}

/** One sink key as its owner sees it. `waiting`: the owner's key is locked
 *  or the value changed and is not written yet. `phase 3`: a gpd sink. */
export type SecretKeyState = "same" | "drift" | "missing" | "waiting" | "unknown" | "phase 3";

export interface SecretSinkInfo {
  id: string;
  machine: string;
  path: string;
  format: SecretSinkFormat;
  /** file key (dotenv name or dotted JSON path) to secret name */
  keys: Record<string, string>;
  /** per key, filled only by the backend that owns the sink */
  state: Record<string, SecretKeyState>;
  error: string | null;
}

/** A value found in a source file, sealed to the mini alone, on its way to
 *  an approval on the mini's page. `sealed` is empty for a source canopy
 *  can only list (a sops file): the approval then carries the value. */
export interface SecretProposalIn {
  from: string;
  source: string;
  key: string;
  sealed: string;
  /** the secret this would update, when it is a "take this value" */
  merges: string | null;
}

export interface SecretProposalInfo {
  id: string;
  from: string;
  source: string;
  key: string;
  /** the name canopy suggests for it */
  suggested: string;
  merges: string | null;
  /** another pending proposal or a secret that holds the same value */
  same: string | null;
  namesOnly: boolean;
  /** epoch ms */
  expires: number;
}

export interface SecretPasskeyInfo {
  id: string;
  label: string;
  created: string;
  lastUsed: string | null;
}

export interface SecretAuditEntry {
  at: string;
  action: string;
  name: string | null;
  ok: boolean;
  /** the passkey label that held the session */
  by: string | null;
  detail: string | null;
}

export interface SecretsInfo {
  ok: boolean;
  error: string | null;
  backend: string;
  /** the mini through its service, or a pulled and verified copy */
  role: "writer" | "reader";
  /** the commit this backend reads, short */
  head: string | null;
  /** why the newest commit was refused, when one was */
  refused: string | null;
  /** this machine's age key: open, waiting for its passphrase, or none here */
  lock: "open" | "locked" | "none";
  secrets: SecretMeta[];
  sinks: SecretSinkInfo[];
  proposals: SecretProposalInfo[];
  passkeys: SecretPasskeyInfo[];
  /** the request came with an open passkey session (writer only) */
  session: boolean;
  /** no passkey yet: the service printed a first-passkey code to its log */
  firstPasskey: boolean;
  /** the page where gated actions live */
  gate: string;
  /** commits Forgejo has not taken yet (writer only) */
  unpushed: number;
}
```

- [ ] **Step 3: Add the event**

In `src/core/types.ts`, in the `ServerEvent` union, after the line `| { type: "health"; checks: HealthCheck[] }` (after the kit member when the kit plan added one), add:

```ts
  | { type: "secrets"; info: SecretsInfo }
```

- [ ] **Step 4: Typecheck**

Run: `bun run typecheck`
Expected: exit 0. A switch over `ServerEvent` that must be exhaustive would fail here; if one does, add a `case "secrets":` that does nothing and say so in the task report.

- [ ] **Step 5: Commit**

```bash
git add package.json bun.lock src/core/types.ts
git commit -m "$(printf 'feat(secrets): dependencies and types for the secret store\n\nClaude-Session: https://claude.ai/code/session_01DEgdKaVhnhcGveC62zKQJh')"
```

---

### Task 2: The file, its canonical form and its signature

**Files:**
- Create: `src/core/secretfile.ts`
- Test: `src/core/secretfile.test.ts`

**Interfaces:**
- Consumes: `SecretMeta`, `SecretSinkFormat` (Task 1).
- Produces: `SecretFile`, `SecretEntry`, `SinkDef`, `AGE_HEAD`, `ALLOW`, `AGE_RECIPIENT`, `SECRET_NAME`, `SINK_ID`, `MACHINE`, `DOTENV_KEY`, `JSON_PATH`, `canonical`, `parseSecretFile`, `serializeFile`, `emptyFile`, `signFile`, `verifyFile`, `usedBy`, `recipientsFor`, `recipientKeys`, `fileProblems`, `metaOf`, `metaList`, `nowStamp`. Used by Tasks 3, 6, 8, 9, 11, 12, 13 and 14.

Canonical JSON, exactly: objects with their keys sorted by UTF-16 code unit (JavaScript's default `sort()`), keys whose value is `undefined` dropped, arrays in order, strings and numbers as `JSON.stringify` writes them, no whitespace anywhere, encoded as UTF-8 before signing. The signature covers the canonical form of `{version, keys, secrets, sinks}`, never `signature` itself.

- [ ] **Step 1: Write the failing tests**

Create `src/core/secretfile.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import {
  AGE_HEAD,
  canonical,
  emptyFile,
  fileProblems,
  metaOf,
  parseSecretFile,
  recipientsFor,
  serializeFile,
  signFile,
  verifyFile,
  type SecretFile,
} from "./secretfile";

// a real recipient's shape (the break-glass key from the spec); the file
// check reads shape only, so one string serves every machine here
const R = "age1xtc4cftnu55fn3enurt9jexnrenmru3w0xl93uz5q20e34mefs6stg2vra";
const SEALED = `${AGE_HEAD}\nnot really sealed\n-----END AGE ENCRYPTED FILE-----\n`;
const STAMP = "2026-10-14T12:00:00.000Z";

function fixture(): SecretFile {
  const f = emptyFile({ mini: R, mac: R, breakglass: R });
  f.secrets["cloudflare_token"] = { description: "dns edits", tags: ["cloudflare"], created: STAMP, rotated: STAMP, to: ["breakglass", "mini"], allow: [], value: SEALED };
  return f;
}

async function keyPair(): Promise<{ priv: CryptoKey; pub: string }> {
  const k = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", k.publicKey));
  return { priv: k.privateKey, pub: btoa(String.fromCharCode(...raw)) };
}

describe("canonical", () => {
  test("sorts keys at every depth, keeps array order, writes no whitespace", () => {
    expect(canonical({ b: 1, a: { d: [3, 1], c: "x y" } })).toBe('{"a":{"c":"x y","d":[3,1]},"b":1}');
  });

  test("drops undefined and refuses what JSON cannot hold", () => {
    expect(canonical({ a: undefined, b: null })).toBe('{"b":null}');
    expect(() => canonical({ a: Number.NaN })).toThrow();
    expect(() => canonical({ a: () => 1 })).toThrow();
  });
});

describe("the signature", () => {
  test("a file signed by the pinned key verifies after a round trip", async () => {
    const { priv, pub } = await keyPair();
    const signed = await signFile(fixture(), priv, "mini");
    const back = parseSecretFile(serializeFile(signed));
    if ("error" in back) throw new Error(back.error);
    expect(await verifyFile(back.file, pub)).toBe(true);
  });

  test("a file with its keys reordered still verifies", async () => {
    const { priv, pub } = await keyPair();
    const signed = await signFile(fixture(), priv, "mini");
    const reordered = JSON.parse(serializeFile(signed)) as Record<string, unknown>;
    const shuffled = JSON.stringify({ signature: reordered["signature"], sinks: reordered["sinks"], secrets: reordered["secrets"], keys: reordered["keys"], version: 1 }, null, 4);
    const back = parseSecretFile(shuffled);
    if ("error" in back) throw new Error(back.error);
    expect(await verifyFile(back.file, pub)).toBe(true);
  });

  test("one changed byte of metadata fails", async () => {
    const { priv, pub } = await keyPair();
    const signed = await signFile(fixture(), priv, "mini");
    const text = serializeFile(signed).replace("dns edits", "dns edit!");
    const back = parseSecretFile(text);
    if ("error" in back) throw new Error(back.error);
    expect(await verifyFile(back.file, pub)).toBe(false);
  });

  test("another key's signature, a missing one, or a broken public key fails", async () => {
    const a = await keyPair();
    const b = await keyPair();
    const signed = await signFile(fixture(), a.priv, "mini");
    expect(await verifyFile(signed, b.pub)).toBe(false);
    expect(await verifyFile({ ...signed, signature: null }, a.pub)).toBe(false);
    expect(await verifyFile(signed, "not base64!")).toBe(false);
  });
});

describe("parseSecretFile", () => {
  const good = (): Record<string, unknown> => JSON.parse(serializeFile(fixture())) as Record<string, unknown>;
  const refuses = (mutate: (f: Record<string, unknown>) => void, words: string) => {
    const f = good();
    mutate(f);
    const r = parseSecretFile(JSON.stringify(f));
    expect("error" in r ? r.error : "parsed").toContain(words);
  };

  test("takes a good file", () => {
    expect("file" in parseSecretFile(serializeFile(fixture()))).toBe(true);
  });

  test("refuses each broken part by name", () => {
    expect("error" in parseSecretFile("{")).toBe(true);
    refuses((f) => (f["version"] = 2), "version");
    refuses((f) => delete (f["keys"] as Record<string, unknown>)["breakglass"], "breakglass");
    refuses((f) => ((f["keys"] as Record<string, unknown>)["mac"] = "age1short"), "key mac");
    refuses((f) => ((f["secrets"] as Record<string, unknown>)["9bad"] = {}), "9bad");
    refuses((f) => (((f["secrets"] as Record<string, Record<string, unknown>>)["cloudflare_token"] as Record<string, unknown>)["value"] = "plain text"), "not an age file");
    refuses((f) => (((f["secrets"] as Record<string, Record<string, unknown>>)["cloudflare_token"] as Record<string, unknown>)["allow"] = ["everyone"]), "everyone");
    refuses((f) => (((f["secrets"] as Record<string, Record<string, unknown>>)["cloudflare_token"] as Record<string, unknown>)["to"] = ["mini", "nas"]), "no key");
    refuses((f) => ((f["sinks"] as Record<string, unknown>)["dns"] = { machine: "mini", path: "/opt/stacks/../etc/x", format: "dotenv", keys: {} }), "absolute");
    refuses((f) => ((f["sinks"] as Record<string, unknown>)["dns"] = { machine: "mini", path: "/opt/stacks/dns/.env", format: "yaml", keys: {} }), "format");
    refuses((f) => ((f["sinks"] as Record<string, unknown>)["dns"] = { machine: "mini", path: "/opt/stacks/dns/.env", format: "dotenv", keys: { CF: "missing_one" } }), "missing_one");
    refuses((f) => ((f["sinks"] as Record<string, unknown>)["dns"] = { machine: "mini", path: "/opt/stacks/dns/.env", format: "dotenv", keys: { "a.b": "cloudflare_token" } }), "a.b");
    refuses((f) => ((f["sinks"] as Record<string, unknown>)["dns"] = { machine: "breakglass", path: "/x", format: "dotenv", keys: {} }), "machine");
  });
});

describe("recipients and problems", () => {
  test("the mini and the break-glass key always, and each sink's machine; gpd's sinks add the Mac", () => {
    const f = fixture();
    expect(recipientsFor(f, "cloudflare_token")).toEqual(["breakglass", "mini"]);
    f.sinks["laptop"] = { machine: "mac", path: "/Users/e/x/.env", format: "dotenv", keys: { CF: "cloudflare_token" } };
    f.sinks["pad"] = { machine: "gpd", path: "/home/eric/x/.env", format: "dotenv", keys: { CF: "cloudflare_token" } };
    expect(recipientsFor(f, "cloudflare_token")).toEqual(["breakglass", "mac", "mini"]);
  });

  test("names a sink missing from the allowlist and a value sealed to the wrong machines", () => {
    const f = fixture();
    expect(fileProblems(f)).toEqual([]);
    f.sinks["laptop"] = { machine: "mac", path: "/Users/e/x/.env", format: "dotenv", keys: { CF: "cloudflare_token" } };
    const p = fileProblems(f);
    expect(p.some((l) => l.includes("sink:laptop"))).toBe(true);
    expect(p.some((l) => l.includes("not breakglass, mac, mini"))).toBe(true);
  });

  test("metadata carries no value", () => {
    const m = metaOf(fixture(), "cloudflare_token");
    expect(JSON.stringify(m)).not.toContain(AGE_HEAD);
    expect(m?.usedBy).toEqual([]);
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `bun test src/core/secretfile.test.ts`
Expected: FAIL, `Cannot find module './secretfile'`.

- [ ] **Step 3: Write the module**

Create `src/core/secretfile.ts`:

```ts
/**
 * The secret store's file (docs/superpowers/specs/2026-10-14-secrets-design.md):
 * its shape, its canonical form, the ed25519 signature over that form, and
 * which machines each value is sealed to. Pure and browser-safe: WebCrypto
 * is the only thing it calls, and Bun and the browser both have it.
 */

import type { SecretMeta, SecretSinkFormat } from "./types";

export const AGE_HEAD = "-----BEGIN AGE ENCRYPTED FILE-----";
/** a letter first, so no name is an integer-like key that JSON reorders */
export const SECRET_NAME = /^[A-Za-z][A-Za-z0-9_.-]{0,99}$/;
export const SINK_ID = /^[a-z][a-z0-9-]{0,62}$/;
export const MACHINE = /^[a-z][a-z0-9-]{0,29}$/;
export const DOTENV_KEY = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
export const JSON_PATH = /^[A-Za-z_][A-Za-z0-9_-]*(\.[A-Za-z_][A-Za-z0-9_-]*){0,15}$/;
export const ALLOW = /^(sink:[a-z][a-z0-9-]{0,62}|mcp:[a-z0-9][a-z0-9._-]{0,63}#[0-9a-f]{64})$/;
/** an X25519 recipient; a post-quantum one is longer and not taken yet */
export const AGE_RECIPIENT = /^age1[02-9ac-hj-np-z]{58}$/;
const STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/;
const RESTART = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export interface SecretEntry {
  description: string;
  tags: string[];
  created: string;
  rotated: string;
  to: string[];
  allow: string[];
  /** armored age, sealed to `to` */
  value: string;
}

export interface SinkDef {
  machine: string;
  path: string;
  format: SecretSinkFormat;
  keys: Record<string, string>;
  /** phase 3: the stack restarted after a change; kept, never run here */
  restart?: string;
}

export interface SecretSignature {
  by: string;
  alg: "ed25519";
  sig: string;
}

export interface SecretFile {
  version: 1;
  /** machine name to age recipient; `mini` and `breakglass` always */
  keys: Record<string, string>;
  secrets: Record<string, SecretEntry>;
  sinks: Record<string, SinkDef>;
  /** null only in memory, between a change and its signing */
  signature: SecretSignature | null;
}

export const nowStamp = (ms = Date.now()): string => new Date(ms).toISOString();

/** Sorted keys at every depth, no whitespace, `undefined` keys dropped. */
export function canonical(v: unknown): string {
  if (v === null || typeof v === "boolean" || typeof v === "string") return JSON.stringify(v);
  if (typeof v === "number") {
    if (!Number.isFinite(v)) throw new Error("canonical JSON holds no NaN or Infinity");
    return JSON.stringify(v);
  }
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    const keys = Object.keys(o).filter((k) => o[k] !== undefined).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(",")}}`;
  }
  throw new Error(`canonical JSON holds no ${typeof v}`);
}

/** what the signature covers: everything but the signature */
const signedBytes = (f: SecretFile): Uint8Array<ArrayBuffer> =>
  new TextEncoder().encode(canonical({ version: f.version, keys: f.keys, secrets: f.secrets, sinks: f.sinks }));

/** The file as written to disk: canonical order, two-space indent, so a diff
 *  in Forgejo reads line by line. */
export const serializeFile = (f: SecretFile): string => `${JSON.stringify(JSON.parse(canonical(f)), null, 2)}\n`;

export const emptyFile = (keys: Record<string, string>): SecretFile => ({ version: 1, keys: { ...keys }, secrets: {}, sinks: {}, signature: null });

const toB64 = (b: Uint8Array): string => btoa(String.fromCharCode(...b));
const fromB64 = (s: string): Uint8Array<ArrayBuffer> => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const ED = { name: "Ed25519" };

export async function signFile(f: SecretFile, key: CryptoKey, by: string): Promise<SecretFile> {
  const sig = new Uint8Array(await crypto.subtle.sign(ED, key, signedBytes(f)));
  return { ...f, signature: { by, alg: "ed25519", sig: toB64(sig) } };
}

/** True only when the pinned public key (raw, base64) signed this content. */
export async function verifyFile(f: SecretFile, publicB64: string): Promise<boolean> {
  if (!f.signature || f.signature.alg !== "ed25519") return false;
  try {
    const key = await crypto.subtle.importKey("raw", fromB64(publicB64), ED, false, ["verify"]);
    return await crypto.subtle.verify(ED, key, fromB64(f.signature.sig), signedBytes(f));
  } catch {
    return false;
  }
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const strs = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");
const stamp = (v: unknown): v is string => typeof v === "string" && STAMP.test(v);

function parseEntry(name: string, e: unknown, keys: Record<string, string>): SecretEntry | string {
  if (!SECRET_NAME.test(name)) return `secret name ${name} is not allowed (a letter, then letters, digits, _ . -)`;
  if (!isObj(e)) return `secret ${name} is not an object`;
  const { description, tags, created, rotated, to, allow, value } = e;
  if (typeof description !== "string" || !strs(tags) || !stamp(created) || !stamp(rotated) || !strs(to) || !strs(allow) || typeof value !== "string") {
    return `secret ${name} is missing a field or has one of the wrong type`;
  }
  if (!value.startsWith(AGE_HEAD)) return `secret ${name}'s value is not an age file`;
  const bad = allow.find((a) => !ALLOW.test(a));
  if (bad !== undefined) return `secret ${name} allows ${bad}, which is neither sink:<id> nor mcp:<server>#<sha256>`;
  if (to.some((m) => !(m in keys))) return `secret ${name} is sealed to a machine with no key`;
  return { description, tags, created, rotated, to, allow, value };
}

function parseSink(id: string, s: unknown, secrets: Record<string, SecretEntry>): SinkDef | string {
  if (!SINK_ID.test(id)) return `sink id ${id} is not allowed (a lowercase letter, then lowercase letters, digits, -)`;
  if (!isObj(s)) return `sink ${id} is not an object`;
  const { machine, path, format, keys, restart } = s;
  if (typeof machine !== "string" || !MACHINE.test(machine) || machine === "breakglass") return `sink ${id} names no machine it could live on`;
  if (typeof path !== "string" || !path.startsWith("/") || path.split("/").includes("..")) return `sink ${id}'s path must be absolute with no ..`;
  if (format !== "dotenv" && format !== "json") return `sink ${id}'s format is neither dotenv nor json`;
  if (!isObj(keys)) return `sink ${id} has no keys object`;
  const out: Record<string, string> = {};
  for (const [k, n] of Object.entries(keys)) {
    if (!(format === "dotenv" ? DOTENV_KEY : JSON_PATH).test(k)) return `sink ${id}'s key ${k} is not a ${format === "dotenv" ? "dotenv name" : "dotted JSON path"}`;
    if (typeof n !== "string" || !(n in secrets)) return `sink ${id} maps ${k} to ${String(n)}, a secret the file does not hold`;
    out[k] = n;
  }
  if (restart !== undefined && (typeof restart !== "string" || !RESTART.test(restart))) return `sink ${id}'s restart is not a stack name`;
  return { machine, path, format, keys: out, ...(typeof restart === "string" ? { restart } : {}) };
}

export function parseSecretFile(text: string): { file: SecretFile } | { error: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { error: "secrets.json is not JSON" };
  }
  if (!isObj(raw)) return { error: "secrets.json is not an object" };
  if (raw["version"] !== 1) return { error: "secrets.json has a version this canopy does not read" };
  const { keys, secrets, sinks, signature } = raw;
  if (!isObj(keys) || !isObj(secrets) || !isObj(sinks)) return { error: "secrets.json needs keys, secrets and sinks objects" };
  const outKeys: Record<string, string> = {};
  for (const [m, r] of Object.entries(keys)) {
    if (!MACHINE.test(m) || typeof r !== "string" || !AGE_RECIPIENT.test(r)) return { error: `key ${m} is not a machine name with an X25519 age recipient` };
    outKeys[m] = r;
  }
  if (!outKeys["mini"] || !outKeys["breakglass"]) return { error: "secrets.json needs the mini and breakglass keys" };
  const outSecrets: Record<string, SecretEntry> = {};
  for (const [name, e] of Object.entries(secrets)) {
    const entry = parseEntry(name, e, outKeys);
    if (typeof entry === "string") return { error: entry };
    outSecrets[name] = entry;
  }
  const outSinks: Record<string, SinkDef> = {};
  for (const [id, s] of Object.entries(sinks)) {
    const sink = parseSink(id, s, outSecrets);
    if (typeof sink === "string") return { error: sink };
    outSinks[id] = sink;
  }
  let sig: SecretSignature | null = null;
  if (signature !== undefined && signature !== null) {
    if (!isObj(signature) || typeof signature["by"] !== "string" || signature["alg"] !== "ed25519" || typeof signature["sig"] !== "string") {
      return { error: "secrets.json's signature is not {by, alg: ed25519, sig}" };
    }
    sig = { by: signature["by"], alg: "ed25519", sig: signature["sig"] };
  }
  return { file: { version: 1, keys: outKeys, secrets: outSecrets, sinks: outSinks, signature: sig } };
}

/** the sinks that map a key to `name`, sorted */
export function usedBy(f: SecretFile, name: string): string[] {
  return Object.entries(f.sinks)
    .filter(([, s]) => Object.values(s.keys).includes(name))
    .map(([id]) => id)
    .sort();
}

/** The machines a value is sealed to: the mini and the break-glass key
 *  always, and each machine that owns a sink using it. The Mac writes gpd's
 *  sinks (phase 3), so a gpd sink adds the Mac. Sorted. */
export function recipientsFor(f: SecretFile, name: string): string[] {
  const to = new Set(["mini", "breakglass"]);
  for (const id of usedBy(f, name)) {
    const m = f.sinks[id]?.machine;
    if (m) to.add(m === "gpd" ? "mac" : m);
  }
  return [...to].sort();
}

/** the age recipients for those machines, or which have no key yet */
export function recipientKeys(f: SecretFile, machines: readonly string[]): { keys: string[] } | { missing: string[] } {
  const missing = machines.filter((m) => !f.keys[m]);
  if (missing.length > 0) return { missing };
  return { keys: machines.flatMap((m) => (f.keys[m] ? [f.keys[m]] : [])) };
}

/** What is wrong with a file that parses: a sink outside its secret's
 *  allowlist, a value sealed to other machines than the rule says. */
export function fileProblems(f: SecretFile): string[] {
  const out: string[] = [];
  for (const [id, s] of Object.entries(f.sinks)) {
    for (const [key, name] of Object.entries(s.keys)) {
      const e = f.secrets[name];
      if (!e) out.push(`sink ${id} maps ${key} to ${name}, which is gone`);
      else if (!e.allow.includes(`sink:${id}`)) out.push(`sink ${id} uses ${name}, whose allowlist does not hold sink:${id}`);
    }
  }
  for (const [name, e] of Object.entries(f.secrets)) {
    const want = recipientsFor(f, name).join(", ");
    const have = [...e.to].sort().join(", ");
    if (want !== have) out.push(`${name} is sealed to ${have}, not ${want}`);
  }
  return out;
}

export function metaOf(f: SecretFile, name: string): SecretMeta | null {
  const e = f.secrets[name];
  if (!e) return null;
  return { name, description: e.description, tags: [...e.tags], created: e.created, rotated: e.rotated, to: [...e.to], allow: [...e.allow], usedBy: usedBy(f, name) };
}

export const metaList = (f: SecretFile): SecretMeta[] =>
  Object.keys(f.secrets)
    .sort()
    .flatMap((n) => {
      const m = metaOf(f, n);
      return m ? [m] : [];
    });
```

- [ ] **Step 4: Run the tests**

Run: `bun test src/core/secretfile.test.ts`
Expected: PASS. If TypeScript's lib in this repo types `TextEncoder.encode` as `Uint8Array<ArrayBufferLike>`, drop the `<ArrayBuffer>` parameters from `signedBytes` and `fromB64` and pass `.slice()` results instead; run `bun run typecheck` to see.

- [ ] **Step 5: Lint and typecheck**

Run: `bun run typecheck && bun run lint`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/core/secretfile.ts src/core/secretfile.test.ts
git commit -m "$(printf 'feat(secrets): the signed secrets.json, its canonical form and recipient rule\n\nClaude-Session: https://claude.ai/code/session_01DEgdKaVhnhcGveC62zKQJh')"
```

---

### Task 3: Sealing values and keys

**Files:**
- Create: `src/core/secretcrypt.ts`
- Test: `src/core/secretcrypt.test.ts`

**Interfaces:**
- Consumes: `age-encryption` 0.3.1 (`Encrypter`, `Decrypter`, `armor`, `generateX25519Identity`, `identityToRecipient`, all checked against the installed package: the two generators are async, a wrong key or passphrase throws "no identity matched any of the file's recipients"); `signFile`, `verifyFile`, `emptyFile` (Task 2) in the test.
- Produces: `newIdentity`, `sealValue`, `openValue`, `resealValue`, `wrapIdentity`, `unwrapIdentity`, `newSigningKey`, `signingKey`, `sameValue`, `proposalName`, `sealProposal`, `openProposal`. Used by Tasks 6, 9, 11, 13 and 16.

The plaintext inside each age file is `{"name","value","rotated"}`. `openValue` refuses when either the name or the rotation stamp differs from the metadata that points at it, so a ciphertext copied under another name, or an old one restored, does not open.

- [ ] **Step 1: Write the failing tests**

Create `src/core/secretcrypt.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import {
  newIdentity,
  newSigningKey,
  openProposal,
  openValue,
  resealValue,
  sameValue,
  sealProposal,
  sealValue,
  signingKey,
  unwrapIdentity,
  wrapIdentity,
} from "./secretcrypt";
import { emptyFile, signFile, verifyFile } from "./secretfile";

const V = "fixture-value-0x5eed";
const T1 = "2026-10-14T12:00:00.000Z";
const T2 = "2026-10-15T12:00:00.000Z";

describe("values", () => {
  test("each recipient opens a value; another key does not", async () => {
    const mini = await newIdentity();
    const mac = await newIdentity();
    const other = await newIdentity();
    const sealed = await sealValue("cf_token", V, T1, [mini.recipient, mac.recipient]);
    expect(sealed.startsWith("-----BEGIN AGE ENCRYPTED FILE-----")).toBe(true);
    expect(sealed).not.toContain(V);
    expect(await openValue(sealed, mini.identity, { name: "cf_token", rotated: T1 })).toBe(V);
    expect(await openValue(sealed, mac.identity, { name: "cf_token", rotated: T1 })).toBe(V);
    await expect(openValue(sealed, other.identity, { name: "cf_token", rotated: T1 })).rejects.toThrow("does not open with this key");
  });

  test("a value moved under another name does not open, and the error holds no value", async () => {
    const mini = await newIdentity();
    const sealed = await sealValue("cf_token", V, T1, [mini.recipient]);
    const err = await openValue(sealed, mini.identity, { name: "github_token", rotated: T1 }).catch((e: unknown) => e as Error);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain("another name");
    expect((err as Error).message).not.toContain(V);
  });

  test("an older ciphertext put back after a rotation does not open", async () => {
    const mini = await newIdentity();
    const old = await sealValue("cf_token", V, T1, [mini.recipient]);
    await expect(openValue(old, mini.identity, { name: "cf_token", rotated: T2 })).rejects.toThrow("another rotation");
  });

  test("resealing keeps the value and stamp and changes who opens it", async () => {
    const mini = await newIdentity();
    const mac = await newIdentity();
    const sealed = await sealValue("cf_token", V, T1, [mini.recipient]);
    const again = await resealValue(sealed, mini.identity, { name: "cf_token", rotated: T1 }, [mini.recipient, mac.recipient]);
    expect(await openValue(again, mac.identity, { name: "cf_token", rotated: T1 })).toBe(V);
  });

  test("a proposal opens only under its own source and key", async () => {
    const mini = await newIdentity();
    const p = { from: "mac", source: "~/dev/.env", key: "CF" };
    const sealed = await sealProposal(p, V, mini.recipient);
    expect(await openProposal(sealed, mini.identity, p)).toBe(V);
    await expect(openProposal(sealed, mini.identity, { ...p, key: "OTHER" })).rejects.toThrow("another name");
  });
});

describe("identities", () => {
  test("a passphrase-wrapped identity unwraps with the passphrase and only with it", async () => {
    const { identity } = await newIdentity();
    const wrapped = await wrapIdentity(identity, "correct horse", 10);
    expect(wrapped).not.toContain(identity);
    expect(await unwrapIdentity(wrapped, "correct horse")).toBe(identity);
    await expect(unwrapIdentity(wrapped, "wrong horse")).rejects.toThrow("wrong passphrase");
  });

  test("identities are X25519", async () => {
    const { identity, recipient } = await newIdentity();
    expect(identity.startsWith("AGE-SECRET-KEY-1")).toBe(true);
    expect(recipient).toMatch(/^age1[02-9ac-hj-np-z]{58}$/);
  });
});

describe("signing keys", () => {
  test("a new key signs a file its public half verifies", async () => {
    const k = await newSigningKey();
    const f = await signFile(emptyFile({}), await signingKey(k.privateB64), "mini");
    expect(await verifyFile(f, k.publicB64)).toBe(true);
  });
});

test("sameValue compares by content", () => {
  expect(sameValue("abc", "abc")).toBe(true);
  expect(sameValue("abc", "abd")).toBe(false);
  expect(sameValue("abc", "abcd")).toBe(false);
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `bun test src/core/secretcrypt.test.ts`
Expected: FAIL, `Cannot find module './secretcrypt'`.

- [ ] **Step 3: Write the module**

Create `src/core/secretcrypt.ts`:

```ts
/**
 * age for the secret store. One value is sealed alone to its machines, and
 * the sealed record carries its name and rotation stamp, so a ciphertext
 * copied under another name, or an old one restored, fails to open. A
 * machine's identity can be wrapped by a passphrase (age's scrypt). The
 * file's signing keys are ed25519 through WebCrypto. Bun-side.
 *
 * No error here names a value: callers put these messages in routes and logs.
 */

import { timingSafeEqual } from "node:crypto";
import { armor, Decrypter, Encrypter, generateX25519Identity, identityToRecipient } from "age-encryption";

interface Sealed {
  name: string;
  value: string;
  rotated: string;
}

const isSealed = (v: unknown): v is Sealed =>
  typeof v === "object" && v !== null && typeof (v as Sealed).name === "string" && typeof (v as Sealed).value === "string" && typeof (v as Sealed).rotated === "string";

/** A fresh X25519 identity and its recipient. Not `generateIdentity`, which
 *  may move to a post-quantum key the file's key check does not take. */
export async function newIdentity(): Promise<{ identity: string; recipient: string }> {
  const identity = await generateX25519Identity();
  return { identity, recipient: await identityToRecipient(identity) };
}

export async function sealValue(name: string, value: string, rotated: string, recipients: readonly string[]): Promise<string> {
  if (recipients.length === 0) throw new Error(`${name} needs at least one recipient`);
  const e = new Encrypter();
  for (const r of recipients) e.addRecipient(r);
  const inner: Sealed = { name, value, rotated };
  return armor.encode(await e.encrypt(JSON.stringify(inner)));
}

export async function openValue(armored: string, identity: string, expect: { name: string; rotated: string }): Promise<string> {
  const d = new Decrypter();
  d.addIdentity(identity);
  let text: string;
  try {
    text = await d.decrypt(armor.decode(armored), "text");
  } catch {
    throw new Error(`${expect.name} does not open with this key`);
  }
  let inner: unknown;
  try {
    inner = JSON.parse(text);
  } catch {
    throw new Error(`${expect.name} holds no sealed record`);
  }
  if (!isSealed(inner)) throw new Error(`${expect.name} holds no sealed record`);
  if (inner.name !== expect.name) throw new Error(`${expect.name} holds a value sealed under another name`);
  if (inner.rotated !== expect.rotated) throw new Error(`${expect.name} holds a value from another rotation`);
  return inner.value;
}

/** the same value and stamp, sealed to a new set of recipients */
export async function resealValue(armored: string, identity: string, expect: { name: string; rotated: string }, recipients: readonly string[]): Promise<string> {
  return sealValue(expect.name, await openValue(armored, identity, expect), expect.rotated, recipients);
}

/** An identity under a passphrase. `logN` is scrypt's work factor: 18 for
 *  real keys (about a second), lower only in tests. */
export async function wrapIdentity(identity: string, passphrase: string, logN = 18): Promise<string> {
  const e = new Encrypter();
  e.setPassphrase(passphrase);
  e.setScryptWorkFactor(logN);
  return armor.encode(await e.encrypt(identity));
}

export async function unwrapIdentity(armored: string, passphrase: string): Promise<string> {
  const d = new Decrypter();
  d.addPassphrase(passphrase);
  let identity: string;
  try {
    identity = await d.decrypt(armor.decode(armored), "text");
  } catch {
    throw new Error("wrong passphrase");
  }
  if (!identity.startsWith("AGE-SECRET-KEY-1")) throw new Error("the wrapped file holds no age identity");
  return identity;
}

const b64 = (b: Uint8Array): string => Buffer.from(b).toString("base64");
const ED = { name: "Ed25519" };

/** pkcs8 private and raw public halves, base64 */
export async function newSigningKey(): Promise<{ privateB64: string; publicB64: string }> {
  const k = (await crypto.subtle.generateKey(ED, true, ["sign", "verify"])) as CryptoKeyPair;
  return {
    privateB64: b64(new Uint8Array(await crypto.subtle.exportKey("pkcs8", k.privateKey))),
    publicB64: b64(new Uint8Array(await crypto.subtle.exportKey("raw", k.publicKey))),
  };
}

export const signingKey = (privateB64: string): Promise<CryptoKey> =>
  crypto.subtle.importKey("pkcs8", new Uint8Array(Buffer.from(privateB64, "base64")), ED, false, ["sign"]);

/** Equal values, compared in memory without an early exit. The store never
 *  writes or reports a digest of a value: a plain hash of a short secret is
 *  an offline guessing oracle for anyone holding the file. */
export function sameValue(a: string, b: string): boolean {
  const x = Buffer.from(a, "utf8");
  const y = Buffer.from(b, "utf8");
  return x.length === y.length && timingSafeEqual(x, y);
}

export interface ProposalRef {
  from: string;
  source: string;
  key: string;
}

/** the name a proposal's value is sealed under, so it opens only as itself */
export const proposalName = (p: ProposalRef): string => `proposal:${p.from}:${p.source}#${p.key}`;

export const sealProposal = (p: ProposalRef, value: string, miniRecipient: string): Promise<string> =>
  sealValue(proposalName(p), value, "", [miniRecipient]);

export const openProposal = (sealed: string, identity: string, p: ProposalRef): Promise<string> =>
  openValue(sealed, identity, { name: proposalName(p), rotated: "" });
```

- [ ] **Step 4: Run the tests**

Run: `bun test src/core/secretcrypt.test.ts`
Expected: PASS.

- [ ] **Step 5: Lint and typecheck**

Run: `bun run typecheck && bun run lint`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/core/secretcrypt.ts src/core/secretcrypt.test.ts
git commit -m "$(printf 'feat(secrets): seal each value alone with its name and rotation inside\n\nClaude-Session: https://claude.ai/code/session_01DEgdKaVhnhcGveC62zKQJh')"
```

---

### Task 4: Sink files

**Files:**
- Create: `src/core/sinks.ts`
- Test: `src/core/sinks.test.ts`

**Interfaces:**
- Consumes: `exec` (`src/core/exec.ts`), `sameValue` (Task 3), `SecretSinkFormat` (Task 1).
- Produces: `parseDotenv`, `quoteDotenv`, `readKeys`, `applyKeys`, `decideKey`, `readSinkFile`, `writeSinkFile`, `repoRefusal`. Used by Tasks 8, 9 and 11.

A dotenv write changes only the lines of the keys it manages, so comments, blank lines, order and unmanaged keys survive byte for byte. A JSON write keeps every key it does not manage and the file's indent. Writes are a temp file in the same folder (0600, the existing file's owner when running as root) renamed over the target. A symlink, a missing folder or an unparseable file is refused and left alone.

`decideKey` is the whole drift rule. The owner records, per sink key, the rotation stamp it last wrote (`applied`). A key whose file value equals the store is `same`. A missing key, or one whose secret rotated since the last write, is written. Anything else, including a file value that differs before canopy ever wrote that key, is `drift` and is never overwritten without a gated action.

- [ ] **Step 1: Write the failing tests**

Create `src/core/sinks.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyKeys, decideKey, parseDotenv, readKeys, readSinkFile, repoRefusal, writeSinkFile } from "./sinks";

describe("dotenv", () => {
  const FILE = "# the dns stack\nexport CF_TOKEN=old # rotated by hand\n\nKEEP_ME='as is'\nPLAIN=x\n";

  test("reads plain, quoted, exported and commented values", () => {
    const r = readKeys(FILE, "dotenv", ["CF_TOKEN", "KEEP_ME", "PLAIN", "ABSENT"]);
    if ("error" in r) throw new Error(r.error);
    expect(r.values).toEqual({ CF_TOKEN: "old", KEEP_ME: "as is", PLAIN: "x", ABSENT: undefined });
  });

  test("a write changes only its own lines and appends missing keys", () => {
    const r = applyKeys(FILE, "dotenv", { CF_TOKEN: "new", ADDED: "y" });
    if ("error" in r) throw new Error(r.error);
    expect(r.text).toBe("# the dns stack\nexport CF_TOKEN=new\n\nKEEP_ME='as is'\nPLAIN=x\nADDED=y\n");
  });

  test("every value comes back as it went in", () => {
    for (const v of ["plain", "", "with space", "has#hash", "it's", 'say "hi"', "multi\nline", "back\\slash", "a=b"]) {
      const w = applyKeys(null, "dotenv", { K: v });
      if ("error" in w) throw new Error(w.error);
      const r = readKeys(w.text, "dotenv", ["K"]);
      if ("error" in r) throw new Error(r.error);
      expect(r.values["K"]).toBe(v);
    }
  });

  test("refuses a value no quoting keeps literal for every reader", () => {
    const r = applyKeys(null, "dotenv", { K: "it's $HOME" });
    expect("error" in r ? r.error : "").toContain("$");
  });

  test("refuses a file it cannot parse and names the line", () => {
    const r = parseDotenv("A=1\nthis is not a pair\n");
    expect("error" in r ? r.error : "").toContain("line 2");
    expect("error" in parseDotenv("A='never closed\n")).toBe(true);
  });

  test("keeps a file without a final newline that way", () => {
    const r = applyKeys("A=1", "dotenv", { A: "2" });
    expect("text" in r ? r.text : "").toBe("A=2");
  });
});

describe("json", () => {
  test("sets dotted paths and keeps other keys and the indent", () => {
    const r = applyKeys('{\n    "name": "x",\n    "auth": { "token": "old" }\n}\n', "json", { "auth.token": "new", "extra.key": "z" });
    if ("error" in r) throw new Error(r.error);
    expect(JSON.parse(r.text)).toEqual({ name: "x", auth: { token: "new" }, extra: { key: "z" } });
    expect(r.text.startsWith('{\n    "name"')).toBe(true);
    expect(r.text.endsWith("}\n")).toBe(true);
  });

  test("refuses a path through a non-object and a non-string value", () => {
    expect("error" in applyKeys('{"auth": "flat"}', "json", { "auth.token": "x" })).toBe(true);
    expect("error" in readKeys('{"auth": {"token": 5}}', "json", ["auth.token"])).toBe(true);
    expect("error" in readKeys("[1]", "json", ["a"])).toBe(true);
  });
});

describe("decideKey", () => {
  const T1 = "2026-10-14T12:00:00.000Z";
  const T2 = "2026-10-15T12:00:00.000Z";
  test.each([
    ["same value", undefined, T1, "v", "v", "same"],
    ["missing key", T1, T1, undefined, "v", "write"],
    ["rotated since the last write", T1, T2, "old", "v", "write"],
    ["changed by hand after a write", T1, T1, "hand", "v", "drift"],
    ["different before canopy ever wrote it", undefined, T1, "theirs", "v", "drift"],
  ] as const)("%s", (_label, applied, rotated, file, value, want) => {
    expect(decideKey(applied, rotated, file, value)).toBe(want);
  });
});

describe("files", () => {
  let dir = "";
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "canopy-sinks-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("writes atomically at 0600 and reads back; a missing file reads as null", async () => {
    const p = join(dir, ".env");
    expect(await readSinkFile(p)).toEqual({ text: null });
    await writeSinkFile(p, "A=1\n");
    expect(await readFile(p, "utf8")).toBe("A=1\n");
    expect((await lstat(p)).mode & 0o777).toBe(0o600);
    expect(await readSinkFile(p)).toEqual({ text: "A=1\n" });
  });

  test("refuses a symlink and a missing folder", async () => {
    await writeFile(join(dir, "real"), "A=1\n");
    await symlink(join(dir, "real"), join(dir, "link"));
    await expect(writeSinkFile(join(dir, "link"), "A=2\n")).rejects.toThrow("symlink");
    expect("error" in (await readSinkFile(join(dir, "link")))).toBe(true);
    await expect(writeSinkFile(join(dir, "nope", ".env"), "A=1\n")).rejects.toThrow();
    expect(await readFile(join(dir, "real"), "utf8")).toBe("A=1\n");
  });

  test("a path inside a repo is refused unless git ignores it there", async () => {
    const repo = join(dir, "repo");
    await mkdir(repo);
    Bun.spawnSync(["git", "init", "-q", repo]);
    await writeFile(join(repo, ".gitignore"), ".env\n");
    expect(await repoRefusal(join(repo, ".env"), [repo])).toBeNull();
    expect(await repoRefusal(join(repo, "config.json"), [repo])).toContain("does not ignore");
    expect(await repoRefusal(join(dir, "elsewhere.env"), [repo])).toBeNull();
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `bun test src/core/sinks.test.ts`
Expected: FAIL, `Cannot find module './sinks'`.

- [ ] **Step 3: Write the module**

Create `src/core/sinks.ts`:

```ts
/**
 * Sink files: the dotenv and JSON files a secret is written into on the
 * machine that owns them. A write touches only the keys it manages, goes
 * through a temp file in the same folder, and refuses what it cannot read
 * back. No error here holds a value.
 */

import { chmod, chown, lstat, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { exec } from "./exec";
import { sameValue } from "./secretcrypt";
import type { SecretSinkFormat } from "./types";

export type EnvLine = { kind: "pair"; key: string; value: string; exported: boolean; raw: string } | { kind: "other"; raw: string };

const PAIR = /^\s*(export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/;
const REST = /^\s*(#.*)?$/;
const RAW_OK = /^[A-Za-z0-9_./:@+,=-]*$/;

function parseValue(v: string): string | null {
  if (v.startsWith("'")) {
    const end = v.indexOf("'", 1);
    if (end === -1 || !REST.test(v.slice(end + 1))) return null;
    return v.slice(1, end);
  }
  if (v.startsWith('"')) {
    let out = "";
    for (let i = 1; i < v.length; i++) {
      const c = v[i];
      if (c === "\\") {
        const n = v[i + 1];
        if (n === undefined) return null;
        out += n === "n" ? "\n" : n === "r" ? "\r" : n === "t" ? "\t" : n;
        i++;
      } else if (c === '"') {
        return REST.test(v.slice(i + 1)) ? out : null;
      } else {
        out += c;
      }
    }
    return null;
  }
  return v.replace(/\s+#.*$/, "").trimEnd();
}

/** `newline`: the text ends in one (an empty file counts, so a first key
 *  gets one) */
export function parseDotenv(text: string): { lines: EnvLine[]; newline: boolean } | { error: string } {
  if (text === "") return { lines: [], newline: true };
  const parts = text.split("\n");
  const newline = text.endsWith("\n");
  if (newline) parts.pop();
  const lines: EnvLine[] = [];
  for (const [i, raw] of parts.entries()) {
    const t = raw.trim();
    if (t === "" || t.startsWith("#")) {
      lines.push({ kind: "other", raw });
      continue;
    }
    const m = PAIR.exec(raw);
    const value = m ? parseValue((m[3] ?? "").replace(/\r$/, "")) : null;
    if (!m || value === null) return { error: `line ${i + 1} is not KEY=value, a comment or blank` };
    lines.push({ kind: "pair", key: m[2] ?? "", value, exported: !!m[1], raw });
  }
  return { lines, newline };
}

/** A value as one dotenv line keeps it: bare when safe, single quotes when
 *  it has no quote or newline, double quotes otherwise. A value that would
 *  need double quotes and holds `$` is refused: readers differ on whether
 *  `$` interpolates there. */
export function quoteDotenv(v: string): string | { error: string } {
  if (RAW_OK.test(v)) return v;
  if (!v.includes("'") && !v.includes("\n") && !v.includes("\r")) return `'${v}'`;
  if (v.includes("$")) return { error: "the value has a quote or newline and a $, which no dotenv quoting keeps literal for every reader" };
  return `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\r/g, "\\r")}"`;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function parseJsonObject(text: string): Record<string, unknown> | { error: string } {
  try {
    const v: unknown = JSON.parse(text);
    return isObj(v) ? v : { error: "the file is JSON but not an object" };
  } catch {
    return { error: "the file is not JSON" };
  }
}

/** the values at `keys`, undefined where a key is absent */
export function readKeys(text: string, format: SecretSinkFormat, keys: readonly string[]): { values: Record<string, string | undefined> } | { error: string } {
  const values: Record<string, string | undefined> = {};
  if (format === "dotenv") {
    const p = parseDotenv(text);
    if ("error" in p) return p;
    for (const k of keys) {
      // the last line of a key wins, as compose reads it
      const hit = p.lines.filter((l): l is Extract<EnvLine, { kind: "pair" }> => l.kind === "pair" && l.key === k).pop();
      values[k] = hit?.value;
    }
    return { values };
  }
  const obj = parseJsonObject(text);
  if ("error" in obj) return obj;
  for (const k of keys) {
    let at: unknown = obj;
    for (const seg of k.split(".")) at = isObj(at) ? at[seg] : undefined;
    if (at !== undefined && typeof at !== "string") return { error: `${k} holds something other than a string` };
    values[k] = at;
  }
  return { values };
}

/** The file with `updates` written in; `text` null is a new file. */
export function applyKeys(text: string | null, format: SecretSinkFormat, updates: Record<string, string>): { text: string } | { error: string } {
  if (format === "dotenv") {
    const p = parseDotenv(text ?? "");
    if ("error" in p) return p;
    const quoted: Record<string, string> = {};
    for (const [k, v] of Object.entries(updates)) {
      const q = quoteDotenv(v);
      if (typeof q !== "string") return { error: `${k}: ${q.error}` };
      quoted[k] = q;
    }
    const seen = new Set<string>();
    // a line canopy does not manage goes back exactly as it was read
    const lines = p.lines.map((l) => {
      const q = l.kind === "pair" ? quoted[l.key] : undefined;
      if (l.kind === "other" || q === undefined) return l.raw;
      seen.add(l.key);
      return `${l.exported ? "export " : ""}${l.key}=${q}`;
    });
    for (const [k, q] of Object.entries(quoted)) if (!seen.has(k)) lines.push(`${k}=${q}`);
    return { text: lines.join("\n") + (p.newline ? "\n" : "") };
  }
  const obj = parseJsonObject(text ?? "{}");
  if ("error" in obj) return obj;
  for (const [k, v] of Object.entries(updates)) {
    const segs = k.split(".");
    let at: Record<string, unknown> = obj;
    for (const seg of segs.slice(0, -1)) {
      const next = at[seg];
      if (next === undefined) at = at[seg] = {};
      else if (isObj(next)) at = next;
      else return { error: `${k} runs through ${seg}, which is not an object` };
    }
    at[segs[segs.length - 1] ?? k] = v;
  }
  const indent = text === null ? "  " : (/\n([ \t]+)"/.exec(text)?.[1] ?? "  ");
  const newline = text === null || text.endsWith("\n");
  return { text: JSON.stringify(obj, null, indent) + (newline ? "\n" : "") };
}

/** What the owner does with one sink key. `applied` is the rotation stamp
 *  it last wrote there, undefined when it never has. */
export function decideKey(applied: string | undefined, rotated: string, file: string | undefined, value: string): "same" | "write" | "drift" {
  if (file !== undefined && sameValue(file, value)) return "same";
  if (file === undefined) return "write";
  if (applied !== undefined && applied !== rotated) return "write";
  return "drift";
}

const code = (err: unknown): unknown => (typeof err === "object" && err !== null && "code" in err ? (err as { code: unknown }).code : undefined);

/** the file's text, null when it does not exist; a symlink is refused */
export async function readSinkFile(path: string): Promise<{ text: string | null } | { error: string }> {
  try {
    if ((await lstat(path)).isSymbolicLink()) return { error: `${path} is a symlink; canopy writes only plain files` };
    return { text: await readFile(path, "utf8") };
  } catch (err) {
    if (code(err) === "ENOENT") return { text: null };
    return { error: `${path} cannot be read (${String(code(err) ?? "error")})` };
  }
}

let writes = 0;

/** Temp file in the same folder at 0600, the old file's owner (or the
 *  folder's, for a new file) when this runs as root, renamed over. */
export async function writeSinkFile(path: string, text: string): Promise<void> {
  const dir = dirname(path);
  let owner: { uid: number; gid: number };
  try {
    const s = await lstat(path);
    if (s.isSymbolicLink()) throw new Error(`${path} is a symlink; canopy writes only plain files`);
    owner = { uid: s.uid, gid: s.gid };
  } catch (err) {
    if (code(err) !== "ENOENT") throw err;
    const d = await stat(dir);
    owner = { uid: d.uid, gid: d.gid };
  }
  const tmp = join(dir, `.${basename(path)}.canopy-${process.pid}-${++writes}`);
  await writeFile(tmp, text, { mode: 0o600, flag: "wx" });
  try {
    await chmod(tmp, 0o600);
    if (process.getuid?.() === 0) await chown(tmp, owner.uid, owner.gid);
    await rename(tmp, path);
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
}

/** Why a sink may not live at `path`: inside a scanned repo where git does
 *  not ignore it (a tracked file is never ignored). Null when it may. */
export async function repoRefusal(path: string, repoRoots: readonly string[]): Promise<string | null> {
  const root = repoRoots
    .filter((r) => path.startsWith(r.endsWith("/") ? r : `${r}/`))
    .sort((a, b) => b.length - a.length)[0];
  if (!root) return null;
  const r = await exec(["git", "-C", root, "check-ignore", "-q", path.slice(root.replace(/\/$/, "").length + 1)], { timeoutMs: 10_000 });
  if (r.code === 0) return null;
  return `${path} is inside the repo ${root} and git does not ignore it there`;
}
```

- [ ] **Step 4: Run the tests**

Run: `bun test src/core/sinks.test.ts`
Expected: PASS. The "files" tests run as the normal user, so the `chown` branch is skipped. It runs only as root, in the `secrets` container (Task 15), and the first mini sink write after the deploy is its first real use (Task 16's deploy notes, step 8).

- [ ] **Step 5: Lint and typecheck**

Run: `bun run typecheck && bun run lint`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/core/sinks.ts src/core/sinks.test.ts
git commit -m "$(printf 'feat(secrets): dotenv and json sinks that keep what canopy does not manage\n\nClaude-Session: https://claude.ai/code/session_01DEgdKaVhnhcGveC62zKQJh')"
```

---

### Task 5: The wire between canopy and the service

**Files:**
- Create: `src/core/secretwire.ts`
- Create: `src/core/secretwire.samples.ts` (test data shared with Task 9)
- Test: `src/core/secretwire.test.ts`

**Interfaces:**
- Consumes: `SECRET_NAME`, `SINK_ID`, `MACHINE`, `DOTENV_KEY`, `JSON_PATH`, `ALLOW`, `AGE_RECIPIENT`, `AGE_HEAD` (Task 2); `SecretProposalIn`, `SecretSinkFormat` (Task 1).
- Produces: `SAMPLES` (test data), `SecretAct`, `ActKind`, `ACT_KINDS`, `GateKind`, `SecretsRequest`, `SecretsReply`, `PASSKEY`, `LIMITS`, `encodeLine`, `parseRequest`, `parseReply`, `parseAct`, `parseProposals`. Used by Tasks 7, 9, 10, 12 and 14.

One request and one reply per connection, each a JSON line, like the stage runner's wire (`src/core/stagewire.ts`) but without streaming. Every act is gated: there is no act a request may carry without a session token, which is why the list of kinds is one constant the service's gate test walks.

- [ ] **Step 1: Write the failing tests**

Create `src/core/secretwire.samples.ts` (shared by this test and the service's gate walk in Task 9; not a test file, so bun does not run it twice):

```ts
/** One good act of every kind and one way to break it, for the wire test
 *  and the service's walk over every gated act. Test data only. */

import { LIMITS, type ActKind, type SecretAct } from "./secretwire";

const R = "age1xtc4cftnu55fn3enurt9jexnrenmru3w0xl93uz5q20e34mefs6stg2vra";

/** one good act of every kind, and one way to break it */
export const SAMPLES: Record<ActKind, { good: SecretAct; bad: Record<string, unknown> }> = {
  reveal: { good: { a: "reveal", name: "cf_token" }, bad: { a: "reveal", name: "../x" } },
  add: { good: { a: "add", name: "cf_token", value: "v", description: "d", tags: ["dns"] }, bad: { a: "add", name: "cf_token", value: "", description: "d", tags: [] } },
  edit: { good: { a: "edit", name: "cf_token", description: "d", tags: [] }, bad: { a: "edit", name: "cf_token", description: "d", tags: ["Not A Tag"] } },
  rotate: { good: { a: "rotate", name: "cf_token", value: "v2" }, bad: { a: "rotate", name: "cf_token", value: "x".repeat(LIMITS.value + 1) } },
  delete: { good: { a: "delete", name: "cf_token" }, bad: { a: "delete" } },
  allow: { good: { a: "allow", name: "cf_token", allow: ["sink:dns"] }, bad: { a: "allow", name: "cf_token", allow: ["*"] } },
  "sink-set": {
    good: { a: "sink-set", id: "dns", machine: "mini", path: "/opt/stacks/dns/.env", format: "dotenv", keys: { CF_TOKEN: "cf_token" } },
    bad: { a: "sink-set", id: "dns", machine: "mini", path: "relative/.env", format: "dotenv", keys: {} },
  },
  "sink-remove": { good: { a: "sink-remove", id: "dns" }, bad: { a: "sink-remove", id: "DNS" } },
  "sink-write": { good: { a: "sink-write", id: "dns", key: "CF_TOKEN" }, bad: { a: "sink-write", id: "dns" } },
  take: { good: { a: "take", id: "dns", key: "CF_TOKEN" }, bad: { a: "take", id: "dns", key: 5 } },
  "import-scan": { good: { a: "import-scan" }, bad: { a: "import-scans" } },
  approve: {
    good: { a: "approve", proposal: "p1", name: "cf_token", description: "", tags: [], value: null, sink: null },
    bad: { a: "approve", proposal: "p1", name: "cf_token", description: "", tags: [], value: null, sink: { id: "Bad Id" } },
  },
  reject: { good: { a: "reject", proposal: "p1" }, bad: { a: "reject", proposal: "" } },
  "machine-key": { good: { a: "machine-key", machine: "mac", recipient: R }, bad: { a: "machine-key", machine: "mini", recipient: R } },
  "passkey-remove": { good: { a: "passkey-remove", id: "abc" }, bad: { a: "passkey-remove", id: "" } },
};
```

Create `src/core/secretwire.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { AGE_HEAD } from "./secretfile";
import { ACT_KINDS, LIMITS, encodeLine, parseAct, parseProposals, parseReply, parseRequest, type ActKind } from "./secretwire";
import { SAMPLES } from "./secretwire.samples";

describe("parseAct", () => {
  test("the samples cover every act kind", () => {
    expect(Object.keys(SAMPLES).sort()).toEqual([...ACT_KINDS].sort());
  });

  test.each(ACT_KINDS.map((k) => [k]))("%s: the good sample parses and the bad one is refused", (k) => {
    const s = SAMPLES[k as ActKind];
    expect(parseAct(s.good)).toEqual(s.good);
    expect("error" in (parseAct(s.bad) as object)).toBe(true);
  });

  test("an unknown kind is refused", () => {
    expect(parseAct({ a: "get-all" })).toEqual({ error: "unknown act get-all" });
  });
});

describe("parseRequest and parseReply", () => {
  test("a request round-trips through a line", () => {
    const req = { t: "act" as const, token: "tok", act: SAMPLES.reveal.good };
    expect(parseRequest(encodeLine(req).trimEnd())).toEqual(req);
  });

  test("refuses an unknown request, a bad act, and a line over the limit", () => {
    expect("error" in parseRequest('{"t":"dump"}')).toBe(true);
    expect("error" in parseRequest('{"t":"act","token":"x","act":{"a":"delete"}}')).toBe(true);
    expect("error" in parseRequest("x".repeat(LIMITS.line + 1))).toBe(true);
  });

  test("a reply carries the passkey gate through", () => {
    expect(parseReply('{"ok":false,"error":"open the gate","gate":"passkey"}')).toEqual({ ok: false, error: "open the gate", gate: "passkey" });
    expect(parseReply("nope")).toBeNull();
  });
});

describe("parseProposals", () => {
  const one = { from: "mac", source: "/Users/e/dev/.env", key: "CF_TOKEN", sealed: `${AGE_HEAD}\nx\n`, merges: null };

  test("takes a batch within the limits", () => {
    expect(parseProposals([one])).toEqual([one]);
  });

  test("refuses too many, too large, or a sealed field that is not age", () => {
    expect("error" in (parseProposals(Array.from({ length: LIMITS.proposals + 1 }, () => one)) as object)).toBe(true);
    expect("error" in (parseProposals([{ ...one, sealed: AGE_HEAD + "x".repeat(LIMITS.sealed) }]) as object)).toBe(true);
    expect("error" in (parseProposals([{ ...one, sealed: "plain value" }]) as object)).toBe(true);
    expect("error" in (parseProposals([{ ...one, from: "Mac Book" }]) as object)).toBe(true);
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `bun test src/core/secretwire.test.ts`
Expected: FAIL, `Cannot find module './secretwire'`.

- [ ] **Step 3: Write the module**

Create `src/core/secretwire.ts`:

```ts
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
  | { a: "passkey-remove"; id: string };

export type ActKind = SecretAct["a"];

export const ACT_KINDS: readonly ActKind[] = [
  "reveal", "add", "edit", "rotate", "delete", "allow", "sink-set", "sink-remove", "sink-write", "take",
  "import-scan", "approve", "reject", "machine-key", "passkey-remove",
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
  const { a, name, id, key, machine, path, format, keys, allow, description, proposal, sink, recipient } = v;
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
```

- [ ] **Step 4: Run the tests**

Run: `bun test src/core/secretwire.test.ts`
Expected: PASS.

- [ ] **Step 5: Lint and typecheck**

Run: `bun run typecheck && bun run lint`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/core/secretwire.ts src/core/secretwire.samples.ts src/core/secretwire.test.ts
git commit -m "$(printf 'feat(secrets): the wire between canopy and the secrets service\n\nClaude-Session: https://claude.ai/code/session_01DEgdKaVhnhcGveC62zKQJh')"
```

---

### Task 6: The writer's checkout, keys, audit log and applied stamps

**Files:**
- Create: `src/secrets/store.ts`
- Create: `src/secrets/audit.ts`
- Create: `src/core/applied.ts`
- Test: `src/secrets/store.test.ts`
- Test: `src/secrets/audit.test.ts`

**Interfaces:**
- Consumes: `exec` (`src/core/exec.ts`); `emptyFile`, `parseSecretFile`, `serializeFile`, `signFile`, `verifyFile` (Task 2); `newIdentity`, `newSigningKey`, `signingKey` (Task 3); `SecretAuditEntry` (Task 1).
- Produces: `SecretStore` (`open`, `file`, `head`, `unpushed`, `recipient`, `publicB64`, `identity()`, `commit()`, `push()`), `storePaths`, `Audit` (`add`, `last`), `Applied`, `readApplied`, `writeApplied`. Used by Tasks 9, 10, 11 and 16.

The volume layout (only the `secrets` service mounts it):

```
<data>/repo/secrets.json     the clone of eric/secrets
<data>/keys/mini.age         the mini's age identity, 0400
<data>/keys/signing.key      ed25519 pkcs8, base64, 0400
<data>/keys/signing.pub      raw public key, base64
<data>/keys/deploy           the ssh key Forgejo takes pushes from, 0400
<data>/keys/known_hosts
<data>/audit.jsonl           0600, names and outcomes only
<data>/passkeys.json         0600 (Task 7)
<data>/applied.json          0600, sink id -> key -> rotation stamp last written
```

- [ ] **Step 1: Write the failing tests**

Create `src/secrets/store.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseSecretFile, verifyFile } from "../core/secretfile";
import { SecretStore, storePaths } from "./store";

const BREAKGLASS = "age1xtc4cftnu55fn3enurt9jexnrenmru3w0xl93uz5q20e34mefs6stg2vra";
const quiet = () => {};

let dir = "";
let remote = "";
const git = (cwd: string, ...args: string[]) => Bun.spawnSync(["git", "-C", cwd, ...args]).stdout.toString().trim();

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "canopy-store-"));
  remote = join(dir, "remote.git");
  Bun.spawnSync(["git", "init", "-q", "--bare", "-b", "main", remote]);
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("SecretStore", () => {
  test("a first start makes the keys at 0400, an empty signed file, and pushes it", async () => {
    const s = await SecretStore.open({ data: join(dir, "data"), remote, breakglass: BREAKGLASS, log: quiet });
    const p = storePaths(join(dir, "data"));
    expect((await stat(p.identity)).mode & 0o777).toBe(0o400);
    expect((await stat(p.signingKey)).mode & 0o777).toBe(0o400);
    expect(s.file.keys).toEqual({ mini: s.recipient, breakglass: BREAKGLASS });
    expect(s.unpushed).toBe(0);
    const pushed = parseSecretFile(git(remote, "show", "main:secrets.json"));
    if ("error" in pushed) throw new Error(pushed.error);
    expect(await verifyFile(pushed.file, s.publicB64)).toBe(true);
  });

  test("a second start keeps the same keys and reads the file back", async () => {
    const a = await SecretStore.open({ data: join(dir, "data"), remote, breakglass: BREAKGLASS, log: quiet });
    const b = await SecretStore.open({ data: join(dir, "data"), remote, breakglass: BREAKGLASS, log: quiet });
    expect(b.recipient).toBe(a.recipient);
    expect(b.publicB64).toBe(a.publicB64);
    expect(b.head).toBe(a.head);
  });

  test("a commit signs, commits as canopy@mini with the message given, and pushes", async () => {
    const s = await SecretStore.open({ data: join(dir, "data"), remote, breakglass: BREAKGLASS, log: quiet });
    await s.commit({ ...s.file, keys: { ...s.file.keys, mac: BREAKGLASS } }, "secrets: add the mac key");
    expect(git(remote, "log", "-1", "--format=%ae %s", "main")).toBe("canopy@mini secrets: add the mac key");
    const pushed = parseSecretFile(git(remote, "show", "main:secrets.json"));
    if ("error" in pushed) throw new Error(pushed.error);
    expect(pushed.file.keys["mac"]).toBe(BREAKGLASS);
    expect(await verifyFile(pushed.file, s.publicB64)).toBe(true);
  });

  test("a push that fails keeps the commit and counts it", async () => {
    const s = await SecretStore.open({ data: join(dir, "data"), remote, breakglass: BREAKGLASS, log: quiet });
    await rm(remote, { recursive: true, force: true });
    await s.commit({ ...s.file, keys: { ...s.file.keys, mac: BREAKGLASS } }, "secrets: add the mac key");
    expect(s.unpushed).toBe(1);
    expect(git(join(dir, "data", "repo"), "log", "-1", "--format=%s")).toBe("secrets: add the mac key");
  });

  test("refuses to start on a file this key did not sign", async () => {
    await SecretStore.open({ data: join(dir, "data"), remote, breakglass: BREAKGLASS, log: quiet });
    const file = join(dir, "data", "repo", "secrets.json");
    await writeFile(file, (await readFile(file, "utf8")).replace(BREAKGLASS, BREAKGLASS.replace("xtc4", "xtc5")));
    await expect(SecretStore.open({ data: join(dir, "data"), remote, breakglass: BREAKGLASS, log: quiet })).rejects.toThrow("not signed by this mini's key");
  });

  test("works with no remote at all", async () => {
    const s = await SecretStore.open({ data: join(dir, "data"), remote: null, breakglass: BREAKGLASS, log: quiet });
    expect(s.unpushed).toBe(0);
    expect(s.head).toMatch(/^[0-9a-f]{7,}$/);
  });
});
```

Create `src/secrets/audit.test.ts`:

```ts
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readApplied, writeApplied } from "../core/applied";
import { Audit } from "./audit";

let dir = "";
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "canopy-audit-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

test("the audit log appends at 0600 and reads newest first", async () => {
  let t = Date.parse("2026-10-14T12:00:00.000Z");
  const a = new Audit(join(dir, "audit.jsonl"), () => (t += 1000));
  await a.add({ action: "add", name: "cf_token", ok: true, by: "phone", detail: null });
  await a.add({ action: "reveal", name: "cf_token", ok: false, by: null, detail: "no session" });
  expect((await stat(join(dir, "audit.jsonl"))).mode & 0o777).toBe(0o600);
  const last = await a.last(10);
  expect(last.map((e) => e.action)).toEqual(["reveal", "add"]);
  expect(last[0]?.at).toBe("2026-10-14T12:00:02.000Z");
});

test("a missing audit log reads as empty", async () => {
  expect(await new Audit(join(dir, "none.jsonl")).last(5)).toEqual([]);
});

test("applied stamps round-trip and a missing file is empty", async () => {
  const p = join(dir, "applied.json");
  expect(await readApplied(p)).toEqual({});
  await writeApplied(p, { dns: { CF_TOKEN: "2026-10-14T12:00:00.000Z" } });
  expect(await readApplied(p)).toEqual({ dns: { CF_TOKEN: "2026-10-14T12:00:00.000Z" } });
  expect((await stat(p)).mode & 0o777).toBe(0o600);
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `bun test src/secrets/store.test.ts src/secrets/audit.test.ts`
Expected: FAIL, missing modules.

- [ ] **Step 3: Write the applied stamps**

Create `src/core/applied.ts`:

```ts
/**
 * What a sink owner last wrote: per sink, per key, the rotation stamp of the
 * value it wrote. `decideKey` (sinks.ts) reads it to tell a rotation that
 * must be written from a hand edit that must not be overwritten. Stamps
 * only, never values.
 */

import { readFile, rename, writeFile } from "node:fs/promises";

export type Applied = Record<string, Record<string, string>>;

export async function readApplied(path: string): Promise<Applied> {
  try {
    const v: unknown = JSON.parse(await readFile(path, "utf8"));
    if (typeof v !== "object" || v === null || Array.isArray(v)) return {};
    const out: Applied = {};
    for (const [id, keys] of Object.entries(v as Record<string, unknown>)) {
      if (typeof keys !== "object" || keys === null) continue;
      out[id] = Object.fromEntries(Object.entries(keys as Record<string, unknown>).filter((e): e is [string, string] => typeof e[1] === "string"));
    }
    return out;
  } catch {
    return {};
  }
}

let writes = 0;

export async function writeApplied(path: string, a: Applied): Promise<void> {
  const tmp = `${path}.tmp-${process.pid}-${++writes}`;
  await writeFile(tmp, `${JSON.stringify(a, null, 2)}\n`, { mode: 0o600 });
  await rename(tmp, path);
}
```

- [ ] **Step 4: Write the audit log**

Create `src/secrets/audit.ts`:

```ts
/**
 * The secrets service's audit log: one JSON line per gated act or gate
 * event, with the secret's name and the outcome, never a value. Lives in
 * the secrets-data volume; a recovery starts a new one.
 */

import { appendFile, chmod, readFile } from "node:fs/promises";
import type { SecretAuditEntry } from "../core/types";

export class Audit {
  constructor(
    private readonly file: string,
    private readonly now: () => number = Date.now,
  ) {}

  async add(e: Omit<SecretAuditEntry, "at">): Promise<void> {
    const line: SecretAuditEntry = { at: new Date(this.now()).toISOString(), ...e };
    await appendFile(this.file, `${JSON.stringify(line)}\n`, { mode: 0o600 });
    await chmod(this.file, 0o600);
  }

  /** the newest `n`, newest first */
  async last(n: number): Promise<SecretAuditEntry[]> {
    let text: string;
    try {
      text = await readFile(this.file, "utf8");
    } catch {
      return [];
    }
    const out: SecretAuditEntry[] = [];
    for (const line of text.split("\n").reverse()) {
      if (out.length >= n) break;
      if (!line) continue;
      try {
        out.push(JSON.parse(line) as SecretAuditEntry);
      } catch {
        // a torn last line after a crash; the rest still reads
      }
    }
    return out;
  }
}
```

- [ ] **Step 5: Write the store**

Create `src/secrets/store.ts`:

```ts
/**
 * The writer's side of secrets.json: the checkout and keys in the
 * secrets-data volume. Opens (or on a first start makes) the mini's age
 * identity and signing key, refuses a file its own key did not sign,
 * signs and commits each change as canopy@mini, and pushes to Forgejo with
 * the volume's deploy key. A failed push keeps the commit and counts it.
 */

import { chmod, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { identityToRecipient } from "age-encryption";
import { exec, type ExecResult } from "../core/exec";
import { newIdentity, newSigningKey, signingKey } from "../core/secretcrypt";
import { emptyFile, parseSecretFile, serializeFile, signFile, verifyFile, type SecretFile } from "../core/secretfile";

export const storePaths = (data: string) => ({
  repo: join(data, "repo"),
  file: join(data, "repo", "secrets.json"),
  keys: join(data, "keys"),
  identity: join(data, "keys", "mini.age"),
  signingKey: join(data, "keys", "signing.key"),
  signingPub: join(data, "keys", "signing.pub"),
  deployKey: join(data, "keys", "deploy"),
  knownHosts: join(data, "keys", "known_hosts"),
  audit: join(data, "audit.jsonl"),
  passkeys: join(data, "passkeys.json"),
  applied: join(data, "applied.json"),
});

export interface StoreOptions {
  data: string;
  /** Forgejo's URL for eric/secrets; null keeps the store local (tests, a first try) */
  remote: string | null;
  breakglass: string;
  log: (line: string) => void;
}

const exists = async (p: string): Promise<boolean> => stat(p).then(() => true, () => false);

async function writeKey(path: string, text: string): Promise<void> {
  await writeFile(path, text, { mode: 0o400, flag: "wx" });
  await chmod(path, 0o400);
}

export class SecretStore {
  file!: SecretFile;
  head: string | null = null;
  unpushed = 0;
  recipient = "";
  publicB64 = "";
  private ident = "";
  private signer!: CryptoKey;
  private readonly paths: ReturnType<typeof storePaths>;

  private constructor(private readonly opts: StoreOptions) {
    this.paths = storePaths(opts.data);
  }

  static async open(opts: StoreOptions): Promise<SecretStore> {
    const s = new SecretStore(opts);
    await s.keys();
    await s.checkout();
    return s;
  }

  /** the mini's age identity; never leaves this process */
  identity(): string {
    return this.ident;
  }

  private git(args: string[]): Promise<ExecResult> {
    const p = this.paths;
    return exec(["git", "-C", p.repo, ...args], {
      timeoutMs: 60_000,
      env: {
        GIT_AUTHOR_NAME: "canopy",
        GIT_AUTHOR_EMAIL: "canopy@mini",
        GIT_COMMITTER_NAME: "canopy",
        GIT_COMMITTER_EMAIL: "canopy@mini",
        GIT_TERMINAL_PROMPT: "0",
        GIT_SSH_COMMAND: `ssh -i ${p.deployKey} -o IdentitiesOnly=yes -o UserKnownHostsFile=${p.knownHosts} -o StrictHostKeyChecking=accept-new -o BatchMode=yes`,
      },
    });
  }

  private async keys(): Promise<void> {
    const p = this.paths;
    await mkdir(p.keys, { recursive: true, mode: 0o700 });
    if (!(await exists(p.identity))) {
      const { identity } = await newIdentity();
      await writeKey(p.identity, `${identity}\n`);
    }
    if (!(await exists(p.signingKey))) {
      const k = await newSigningKey();
      await writeKey(p.signingKey, `${k.privateB64}\n`);
      await writeFile(p.signingPub, `${k.publicB64}\n`, { mode: 0o444 });
    }
    if (this.opts.remote?.startsWith("ssh://") && !(await exists(p.deployKey))) {
      const r = await exec(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-C", "canopy-secrets@mini", "-f", p.deployKey], { timeoutMs: 30_000 });
      if (r.code !== 0) throw new Error(`ssh-keygen failed: ${r.stderr.trim()}`);
      await chmod(p.deployKey, 0o400);
      this.opts.log(`secrets: new deploy key for Forgejo (add it to eric/secrets with write access): ${(await readFile(`${p.deployKey}.pub`, "utf8")).trim()}`);
    }
    this.ident = (await readFile(p.identity, "utf8")).trim();
    this.signer = await signingKey((await readFile(p.signingKey, "utf8")).trim());
    this.publicB64 = (await readFile(p.signingPub, "utf8")).trim();
    this.recipient = await identityToRecipient(this.ident);
    // public halves only: what Eric pins on the Mac and what the file names
    this.opts.log(`secrets: mini recipient ${this.recipient}, signing key ${this.publicB64}`);
  }

  private async checkout(): Promise<void> {
    const p = this.paths;
    if (!(await exists(join(p.repo, ".git")))) {
      const r = this.opts.remote
        ? await exec(["git", "clone", "-q", this.opts.remote, p.repo], { timeoutMs: 120_000, env: { GIT_TERMINAL_PROMPT: "0", GIT_SSH_COMMAND: `ssh -i ${p.deployKey} -o IdentitiesOnly=yes -o UserKnownHostsFile=${p.knownHosts} -o StrictHostKeyChecking=accept-new -o BatchMode=yes` } })
        : await exec(["git", "init", "-q", "-b", "main", p.repo]);
      if (r.code !== 0) throw new Error(`the checkout could not be made: ${r.stderr.trim()}`);
      // an empty clone's unborn branch follows the client's default; pin it
      await this.git(["symbolic-ref", "HEAD", "refs/heads/main"]);
    } else if (this.opts.remote) {
      await this.fastForward();
    }
    if (!(await exists(p.file))) {
      await this.commit(emptyFile({ mini: this.recipient, breakglass: this.opts.breakglass }), "secrets: start the store");
      return;
    }
    const parsed = parseSecretFile(await readFile(p.file, "utf8"));
    if ("error" in parsed) throw new Error(`secrets.json does not parse: ${parsed.error}`);
    if (!(await verifyFile(parsed.file, this.publicB64))) {
      throw new Error("secrets.json is not signed by this mini's key; restore the key or run canopy secrets recover");
    }
    if (parsed.file.keys["mini"] !== this.recipient) throw new Error("secrets.json names another mini key; restore the key or run canopy secrets recover");
    this.file = parsed.file;
    await this.refreshHead();
  }

  /** take Forgejo's commits when they only add to ours (a recovery pushed from elsewhere) */
  private async fastForward(): Promise<void> {
    const f = await this.git(["fetch", "-q", "origin"]);
    if (f.code !== 0) {
      this.opts.log(`secrets: fetch failed, going on with the local checkout: ${f.stderr.trim().split("\n")[0] ?? ""}`);
      return;
    }
    const ahead = await this.git(["merge-base", "--is-ancestor", "HEAD", "origin/main"]);
    if (ahead.code === 0) {
      await this.git(["merge", "-q", "--ff-only", "origin/main"]);
      return;
    }
    const behind = await this.git(["merge-base", "--is-ancestor", "origin/main", "HEAD"]);
    if (behind.code !== 0) this.opts.log("secrets: Forgejo's history and this checkout have split; pushes will fail until one is reset");
  }

  private async refreshHead(): Promise<void> {
    const h = await this.git(["rev-parse", "--short", "HEAD"]);
    this.head = h.code === 0 ? h.stdout.trim() : null;
    if (!this.opts.remote) {
      this.unpushed = 0;
      return;
    }
    const n = await this.git(["rev-list", "--count", "origin/main..HEAD"]);
    // no origin/main yet (an empty remote): every local commit waits
    this.unpushed = n.code === 0 ? Number(n.stdout.trim()) : Number((await this.git(["rev-list", "--count", "HEAD"])).stdout.trim() || 0);
  }

  /** Sign `next`, write it, commit it with `message` (names only, never a
   *  value), and push. */
  async commit(next: SecretFile, message: string): Promise<void> {
    const signed = await signFile({ ...next, signature: null }, this.signer, "mini");
    const tmp = `${this.paths.file}.tmp-${process.pid}`;
    await writeFile(tmp, serializeFile(signed), { mode: 0o644 });
    await rename(tmp, this.paths.file);
    const add = await this.git(["add", "secrets.json"]);
    const c = add.code === 0 ? await this.git(["commit", "-q", "-m", message]) : add;
    if (c.code !== 0) throw new Error(`the commit failed: ${c.stderr.trim()}`);
    this.file = signed;
    await this.push();
  }

  async push(): Promise<void> {
    if (this.opts.remote) {
      const r = await this.git(["push", "-q", "origin", "HEAD:main"]);
      if (r.code !== 0) this.opts.log(`secrets: push failed, the commit waits: ${r.stderr.trim().split("\n")[0] ?? ""}`);
      else await this.git(["fetch", "-q", "origin"]);
    }
    await this.refreshHead();
  }
}
```

- [ ] **Step 6: Run the tests**

Run: `bun test src/secrets/store.test.ts src/secrets/audit.test.ts`
Expected: PASS. The tests set no git identity of their own: the store's env carries it.

- [ ] **Step 7: Lint and typecheck**

Run: `bun run typecheck && bun run lint`
Expected: exit 0.

- [ ] **Step 8: Commit**

```bash
git add src/secrets/store.ts src/secrets/store.test.ts src/secrets/audit.ts src/secrets/audit.test.ts src/core/applied.ts
git commit -m "$(printf 'feat(secrets): the writer checkout, its keys, the audit log and applied stamps\n\nClaude-Session: https://claude.ai/code/session_01DEgdKaVhnhcGveC62zKQJh')"
```

---

### Task 7: The passkey gate

**Files:**
- Create: `src/secrets/gate.ts`
- Test: `src/secrets/gate.test.ts`

**Interfaces:**
- Consumes: `@simplewebauthn/server` 14.0.3 (`generateRegistrationOptions`, `verifyRegistrationResponse`, `generateAuthenticationOptions`, `verifyAuthenticationResponse`, and the `RegistrationResponseJSON` and `AuthenticationResponseJSON` types; `WebAuthnCredential` is `{id, publicKey: Uint8Array, counter, transports?: string[]}`); `LIMITS`, `GateKind`, `PASSKEY` (Task 5); `SecretPasskeyInfo` (Task 1).
- Produces: `Gate` (`open`, `firstPasskey`, `session`, `begin`, `finish`, `logout`, `passkeys`, `remove`), `WebAuthn`, `REAL_WEBAUTHN`, `GateResult`. Used by Tasks 9, 10 and 16.

The gate lives in the service, so the relay (canopy) holds no key, no challenge and no session list. A session is a random 32-byte token; canopy only carries it between the cookie and the socket. The first passkey needs the one-time code the service prints to its own stdout when it holds no passkey; that code is the one thing the service ever logs that a caller could use, which is what the spec asks for.

- [ ] **Step 1: Write the failing tests**

Create `src/secrets/gate.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LIMITS } from "../core/secretwire";
import { Gate, type WebAuthn } from "./gate";

let dir = "";
let lines: string[] = [];
let t = 0;
let calls: Record<string, unknown>[] = [];

/** a stand-in for the browser and the library: verifies whatever it is told to */
function fake(verified = true): WebAuthn {
  return {
    genReg: (async () => ({ challenge: "c-reg" })) as unknown as WebAuthn["genReg"],
    verifyReg: (async (o: Record<string, unknown>) => {
      calls.push(o);
      return { verified, registrationInfo: { credential: { id: "cred1", publicKey: new Uint8Array([1, 2, 3]), counter: 0, transports: ["internal"] } } };
    }) as unknown as WebAuthn["verifyReg"],
    genAuth: (async () => ({ challenge: "c-auth" })) as unknown as WebAuthn["genAuth"],
    verifyAuth: (async (o: Record<string, unknown>) => {
      calls.push(o);
      return { verified, authenticationInfo: { newCounter: 1 } };
    }) as unknown as WebAuthn["verifyAuth"],
  };
}

const open = (wa = fake()) => Gate.open({ file: join(dir, "passkeys.json"), rpID: "canopy.beric.ca", origin: "https://canopy.beric.ca", now: () => t, wa, log: (l) => lines.push(l) });
const codeOf = (): string => /code ([0-9a-f]{10})/.exec(lines.join("\n"))?.[1] ?? "none";

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "canopy-gate-"));
  lines = [];
  calls = [];
  t = Date.parse("2026-10-14T12:00:00.000Z");
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function registered(): Promise<Gate> {
  const g = await open();
  expect((await g.begin("register", null, codeOf())).ok).toBe(true);
  expect((await g.finish("register", null, codeOf(), { id: "cred1" }, "phone")).ok).toBe(true);
  return g;
}

async function login(g: Gate): Promise<string> {
  expect((await g.begin("login", null, null)).ok).toBe(true);
  const r = await g.finish("login", null, null, { id: "cred1" }, "");
  if (!r.ok) throw new Error(r.error);
  return (r.data as { token: string }).token;
}

describe("the first passkey", () => {
  test("needs the printed code, and the code works once", async () => {
    const g = await open();
    expect(g.firstPasskey()).toBe(true);
    expect(codeOf()).not.toBe("none");
    expect(await g.begin("register", null, "0000000000")).toMatchObject({ ok: false });
    const first = codeOf();
    expect((await g.begin("register", null, first)).ok).toBe(true);
    expect((await g.finish("register", null, first, { id: "cred1" }, "phone")).ok).toBe(true);
    expect(g.firstPasskey()).toBe(false);
    expect(await g.begin("register", null, first)).toEqual({ ok: false, error: "open the passkey gate first", gate: "passkey" });
  });

  test("five wrong codes print a new one", async () => {
    const g = await open();
    const first = codeOf();
    for (let i = 0; i < 5; i++) await g.begin("register", null, "0000000000");
    expect(codeOf()).toBe(first);
    expect(/code ([0-9a-f]{10})/g.exec(lines.slice(1).join("\n"))?.[1]).not.toBe(first);
    expect((await g.begin("register", null, first)).ok).toBe(false);
  });

  test("the passkeys file is 0600 and holds no session", async () => {
    const g = await registered();
    const token = await login(g);
    expect((await stat(join(dir, "passkeys.json"))).mode & 0o777).toBe(0o600);
    expect(await readFile(join(dir, "passkeys.json"), "utf8")).not.toContain(token);
  });
});

describe("login and sessions", () => {
  test("checks the origin, the rp id and user verification", async () => {
    const g = await registered();
    await login(g);
    for (const c of calls) {
      expect(c["expectedOrigin"]).toBe("https://canopy.beric.ca");
      expect(c["expectedRPID"]).toBe("canopy.beric.ca");
      expect(c["requireUserVerification"]).toBe(true);
    }
  });

  test("a session ends after 15 idle minutes", async () => {
    const g = await registered();
    const token = await login(g);
    t += LIMITS.idleMs - 1;
    expect(g.session(token)).not.toBeNull();
    t += LIMITS.idleMs + 1;
    expect(g.session(token)).toBeNull();
  });

  test("a session ends after an hour however busy", async () => {
    const g = await registered();
    const token = await login(g);
    for (let i = 0; i < 6; i++) {
      t += 10 * 60_000;
      expect(g.session(token)).not.toBeNull();
    }
    t += 1;
    expect(g.session(token)).toBeNull();
  });

  test("a challenge is used once and lasts two minutes", async () => {
    const g = await registered();
    await g.begin("login", null, null);
    expect((await g.finish("login", null, null, { id: "cred1" }, "")).ok).toBe(true);
    expect(await g.finish("login", null, null, { id: "cred1" }, "")).toMatchObject({ ok: false, error: "start the passkey prompt again" });
    await g.begin("login", null, null);
    t += 2 * 60_000 + 1;
    expect((await g.finish("login", null, null, { id: "cred1" }, "")).ok).toBe(false);
  });

  test("a response that does not verify opens nothing", async () => {
    const g = await registered();
    const bad = await Gate.open({ file: join(dir, "passkeys.json"), rpID: "canopy.beric.ca", origin: "https://canopy.beric.ca", now: () => t, wa: fake(false), log: () => {} });
    await bad.begin("login", null, null);
    expect((await bad.finish("login", null, null, { id: "cred1" }, "")).ok).toBe(false);
    expect(g.passkeys()).toHaveLength(1);
  });

  test("logout ends the session; the last passkey cannot be removed", async () => {
    const g = await registered();
    const token = await login(g);
    expect((await g.remove("cred1")).ok).toBe(false);
    g.logout(token);
    expect(g.session(token)).toBeNull();
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `bun test src/secrets/gate.test.ts`
Expected: FAIL, `Cannot find module './gate'`.

- [ ] **Step 3: Write the gate**

Create `src/secrets/gate.ts`:

```ts
/**
 * The passkey gate, inside the secrets service: WebAuthn registration and
 * login checked against the mini's page origin and rp id, the passkeys
 * file, the first-passkey code, and the sessions a login opens (15 minutes
 * idle, an hour at most). canopy relays the messages and carries the token
 * between its cookie and the socket; it keeps nothing.
 */

import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { LIMITS, PASSKEY, type GateKind } from "../core/secretwire";
import type { SecretPasskeyInfo } from "../core/types";

export interface Passkey {
  id: string;
  /** base64url */
  publicKey: string;
  counter: number;
  transports: string[];
  label: string;
  created: string;
  lastUsed: string | null;
}

export interface WebAuthn {
  genReg: typeof generateRegistrationOptions;
  verifyReg: typeof verifyRegistrationResponse;
  genAuth: typeof generateAuthenticationOptions;
  verifyAuth: typeof verifyAuthenticationResponse;
}

export const REAL_WEBAUTHN: WebAuthn = {
  genReg: generateRegistrationOptions,
  verifyReg: verifyRegistrationResponse,
  genAuth: generateAuthenticationOptions,
  verifyAuth: verifyAuthenticationResponse,
};

export interface GateOptions {
  file: string;
  rpID: string;
  origin: string;
  log: (line: string) => void;
  now?: () => number;
  wa?: WebAuthn;
}

export type GateResult = { ok: true; data: unknown } | { ok: false; error: string; gate?: typeof PASSKEY };

interface Session {
  label: string;
  opened: number;
  seen: number;
}

const CHALLENGE_MS = 2 * 60_000;
const WRONG_CODES = 5;
const closed: GateResult = { ok: false, error: "open the passkey gate first", gate: PASSKEY };

export class Gate {
  private keys: Passkey[] = [];
  private readonly sessions = new Map<string, Session>();
  private readonly challenges = new Map<GateKind, { value: string; until: number }>();
  private code: string | null = null;
  private wrong = 0;
  private readonly now: () => number;
  private readonly wa: WebAuthn;

  private constructor(private readonly opts: GateOptions) {
    this.now = opts.now ?? Date.now;
    this.wa = opts.wa ?? REAL_WEBAUTHN;
  }

  static async open(opts: GateOptions): Promise<Gate> {
    const g = new Gate(opts);
    try {
      const v: unknown = JSON.parse(await readFile(opts.file, "utf8"));
      if (Array.isArray(v)) g.keys = v as Passkey[];
    } catch {
      // no passkeys yet
    }
    if (g.keys.length === 0) g.newCode();
    return g;
  }

  /** the one-time code for the first passkey, to this process's stdout only */
  private newCode(): void {
    this.code = randomBytes(5).toString("hex");
    this.wrong = 0;
    this.opts.log(`secrets: no passkey yet; first passkey code ${this.code} (enter it on the Secrets view of ${this.opts.origin})`);
  }

  firstPasskey(): boolean {
    return this.keys.length === 0;
  }

  /** the open session for `token`, touched; null when there is none */
  session(token: string | null): Session | null {
    if (!token) return null;
    const s = this.sessions.get(token);
    if (!s) return null;
    const t = this.now();
    if (t - s.seen > LIMITS.idleMs || t - s.opened > LIMITS.maxMs) {
      this.sessions.delete(token);
      return null;
    }
    s.seen = t;
    return s;
  }

  /** who may register: anyone holding a session, or the first-code holder */
  private mayRegister(token: string | null, code: string | null): GateResult | null {
    if (this.session(token)) return null;
    if (this.keys.length > 0 || this.code === null) return closed;
    const a = Buffer.from(code ?? "");
    const b = Buffer.from(this.code);
    if (a.length === b.length && timingSafeEqual(a, b)) return null;
    this.wrong += 1;
    if (this.wrong >= WRONG_CODES) this.newCode();
    return { ok: false, error: "the first-passkey code does not match" };
  }

  async begin(kind: GateKind, token: string | null, code: string | null): Promise<GateResult> {
    let options: { challenge: string };
    if (kind === "register") {
      const refused = this.mayRegister(token, code);
      if (refused) return refused;
      options = await this.wa.genReg({
        rpName: "canopy secrets",
        rpID: this.opts.rpID,
        userName: "eric",
        userID: new TextEncoder().encode("canopy-secrets"),
        attestationType: "none",
        excludeCredentials: this.keys.map((k) => ({ id: k.id })),
        authenticatorSelection: { residentKey: "preferred", userVerification: "required" },
      });
    } else {
      if (this.keys.length === 0) return { ok: false, error: "no passkey yet; register the first one with the printed code" };
      options = await this.wa.genAuth({ rpID: this.opts.rpID, allowCredentials: this.keys.map((k) => ({ id: k.id })), userVerification: "required" });
    }
    this.challenges.set(kind, { value: options.challenge, until: this.now() + CHALLENGE_MS });
    return { ok: true, data: options };
  }

  async finish(kind: GateKind, token: string | null, code: string | null, response: unknown, label: string): Promise<GateResult> {
    const ch = this.challenges.get(kind);
    this.challenges.delete(kind);
    if (!ch || ch.until < this.now()) return { ok: false, error: "start the passkey prompt again" };
    const common = { expectedChallenge: ch.value, expectedOrigin: this.opts.origin, expectedRPID: this.opts.rpID, requireUserVerification: true };
    if (kind === "register") {
      const refused = this.mayRegister(token, code);
      if (refused) return refused;
      try {
        const r = await this.wa.verifyReg({ response: response as RegistrationResponseJSON, ...common });
        if (!r.verified || !r.registrationInfo) return { ok: false, error: "the passkey did not verify" };
        const c = r.registrationInfo.credential;
        this.keys.push({
          id: c.id,
          publicKey: Buffer.from(c.publicKey).toString("base64url"),
          counter: c.counter,
          transports: c.transports ?? [],
          label: label.trim() || `passkey ${this.keys.length + 1}`,
          created: new Date(this.now()).toISOString(),
          lastUsed: null,
        });
        this.code = null;
        await this.save();
        return { ok: true, data: { registered: true } };
      } catch {
        return { ok: false, error: "the passkey did not verify" };
      }
    }
    const id = typeof response === "object" && response !== null ? (response as { id?: unknown }).id : undefined;
    const key = this.keys.find((k) => k.id === id);
    if (!key) return { ok: false, error: "that passkey is not registered here" };
    try {
      const r = await this.wa.verifyAuth({
        response: response as AuthenticationResponseJSON,
        ...common,
        credential: { id: key.id, publicKey: new Uint8Array(Buffer.from(key.publicKey, "base64url")), counter: key.counter, transports: key.transports },
      });
      if (!r.verified) return { ok: false, error: "the passkey did not verify" };
      key.counter = r.authenticationInfo.newCounter;
      key.lastUsed = new Date(this.now()).toISOString();
      await this.save();
    } catch {
      return { ok: false, error: "the passkey did not verify" };
    }
    const t = this.now();
    const session = randomBytes(32).toString("base64url");
    this.sessions.set(session, { label: key.label, opened: t, seen: t });
    return { ok: true, data: { token: session, maxAgeS: LIMITS.maxMs / 1000 } };
  }

  logout(token: string): void {
    this.sessions.delete(token);
  }

  passkeys(): SecretPasskeyInfo[] {
    return this.keys.map((k) => ({ id: k.id, label: k.label, created: k.created, lastUsed: k.lastUsed }));
  }

  async remove(id: string): Promise<GateResult> {
    if (!this.keys.some((k) => k.id === id)) return { ok: false, error: "no such passkey" };
    if (this.keys.length === 1) return { ok: false, error: "keep at least one passkey; register another first" };
    this.keys = this.keys.filter((k) => k.id !== id);
    await this.save();
    return { ok: true, data: { removed: id } };
  }

  private async save(): Promise<void> {
    const tmp = `${this.opts.file}.tmp-${process.pid}`;
    await writeFile(tmp, `${JSON.stringify(this.keys, null, 2)}\n`, { mode: 0o600 });
    await rename(tmp, this.opts.file);
  }
}
```

- [ ] **Step 4: Run the tests**

Run: `bun test src/secrets/gate.test.ts`
Expected: PASS. In "five wrong codes", the first log line holds the first code and a later line the new one; the old code then fails.

- [ ] **Step 5: Lint and typecheck**

Run: `bun run typecheck && bun run lint`
Expected: exit 0. If the library's option types reject `{ id }` alone in `excludeCredentials` or `allowCredentials`, add `transports: k.transports as AuthenticatorTransportFuture[]` with that type imported from `@simplewebauthn/server`.

- [ ] **Step 6: Commit**

```bash
git add src/secrets/gate.ts src/secrets/gate.test.ts
git commit -m "$(printf 'feat(secrets): the passkey gate, its first code and its sessions\n\nClaude-Session: https://claude.ai/code/session_01DEgdKaVhnhcGveC62zKQJh')"
```

---

### Task 8: Import sources

**Files:**
- Create: `src/core/secretimport.ts`
- Test: `src/core/secretimport.test.ts`

**Interfaces:**
- Consumes: `parseDotenv` (Task 4); `SECRET_NAME` (Task 2); `Bun.TOML.parse`, `Bun.YAML.parse`.
- Produces: `Found`, `ImportSource`, `fromDotenv`, `fromCredentials`, `fromClaudeJson`, `fromCodexToml`, `sopsNames`, `suggestName`, `macSources`, `miniSources`, `scanFiles`, `formatOf`. Used by Tasks 9, 10, 11 and 12.

What the spec lists, split by who reads it. The mini's service reads `/opt/stacks/*/.env`, the two sops files (names only: the service holds no sops key), and canopy's own `.env` on the mini, mounted read-only at `/import/canopy.env`. The Mac's canopy reads `~/.claude/credentials/.credentials.json`, `~/dev/.env`, `~/.claude.json` (MCP `env` and `headers`) and `~/.codex/config.toml` (MCP `env`). A value written as `${VAR}` is a reference, not a secret, and is skipped.

- [ ] **Step 1: Write the failing tests**

Create `src/core/secretimport.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatOf, fromClaudeJson, fromCodexToml, fromCredentials, fromDotenv, macSources, miniSources, scanFiles, sopsNames, suggestName } from "./secretimport";

describe("readers", () => {
  test("dotenv: every pair with a value", () => {
    expect(fromDotenv("/a/.env", "# c\nA=1\nB=\nexport C='x y'\n")).toEqual([
      { source: "/a/.env", key: "A", value: "1" },
      { source: "/a/.env", key: "C", value: "x y" },
    ]);
    expect(fromDotenv("/a/.env", "not a pair\n")).toEqual([]);
  });

  test("credentials: string leaves as dotted keys", () => {
    const text = JSON.stringify({ cloudflare: { api_token: "t1", account: { id: "a1" } }, kasa: { password: "p1", port: 9999 } });
    expect(fromCredentials("/c.json", text).map((f) => f.key)).toEqual(["cloudflare.api_token", "cloudflare.account.id", "kasa.password"]);
  });

  test("claude.json: MCP env and headers, top level and per project, skipping references", () => {
    const text = JSON.stringify({
      mcpServers: { github: { env: { GITHUB_TOKEN: "g1", REF: "${OTHER}" } }, linear: { headers: { Authorization: "Bearer l1" } } },
      projects: { "/Users/e/dev/x": { mcpServers: { db: { env: { DB_URL: "d1" } } } } },
      oauthAccount: { emailAddress: "not read" },
    });
    expect(fromClaudeJson("/h/.claude.json", text).map((f) => f.key)).toEqual([
      "mcpServers.github.env.GITHUB_TOKEN",
      "mcpServers.linear.headers.Authorization",
      "projects./Users/e/dev/x.mcpServers.db.env.DB_URL",
    ]);
  });

  test("codex config.toml: MCP env", () => {
    const text = '[mcp_servers.search]\ncommand = "x"\n[mcp_servers.search.env]\nAPI_KEY = "k1"\nPLAIN = "${HOME}"\n';
    expect(fromCodexToml("/h/.codex/config.toml", text)).toEqual([{ source: "/h/.codex/config.toml", key: "mcp_servers.search.env.API_KEY", value: "k1" }]);
  });

  test("sops: names only", () => {
    expect(sopsNames("/s.yaml", "DB_PASSWORD: ENC[AES256_GCM,data:x]\nsops:\n  version: 3\n")).toEqual([{ source: "/s.yaml", key: "DB_PASSWORD", value: null }]);
  });
});

describe("suggestName", () => {
  test.each([
    ["/opt/stacks/immich/.env", "DB_PASSWORD", "immich_db_password"],
    ["/Users/e/.claude/credentials/.credentials.json", "cloudflare.api_token", "cloudflare_api_token"],
    ["/Users/e/dev/.env", "OPENAI_API_KEY", "openai_api_key"],
    ["/Users/e/.claude.json", "mcpServers.github.env.GITHUB_TOKEN", "github_github_token"],
    ["/Users/e/dev/.env", "9LIVES", "s_9lives"],
  ])("%s %s", (source, key, want) => {
    expect(suggestName(source, key)).toBe(want);
  });
});

test("formatOf: only dotenv and json sources can become sinks", () => {
  expect(formatOf("/opt/stacks/x/.env")).toBe("dotenv");
  expect(formatOf("/import/canopy.env")).toBe("dotenv");
  expect(formatOf("/h/.claude/credentials/.credentials.json")).toBe("json");
  expect(formatOf("/h/.codex/config.toml")).toBeNull();
});

describe("scanFiles and the source lists", () => {
  let dir = "";
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "canopy-import-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("reads what exists and names what does not", async () => {
    await writeFile(join(dir, ".env"), "A=1\n");
    const r = await scanFiles([
      { path: join(dir, ".env"), kind: "dotenv" },
      { path: join(dir, "gone.json"), kind: "credentials" },
    ]);
    expect(r.found).toEqual([{ source: join(dir, ".env"), key: "A", value: "1" }]);
    expect(r.missing).toEqual([join(dir, "gone.json")]);
  });

  test("the mini's list: each stack's .env, the two sops files, and the extra files", async () => {
    await mkdir(join(dir, "immich"));
    await mkdir(join(dir, "memory"));
    const list = await miniSources(dir, ["/import/canopy.env"]);
    expect(list).toEqual([
      { path: join(dir, "immich", ".env"), kind: "dotenv" },
      { path: join(dir, "memory", ".env"), kind: "dotenv" },
      { path: join(dir, "memory", "env.sops.yaml"), kind: "sops" },
      { path: join(dir, "executor", "env.sops.yaml"), kind: "sops" },
      { path: "/import/canopy.env", kind: "dotenv" },
    ]);
  });

  test("the Mac's list", () => {
    expect(macSources("/Users/e", "/Users/e/dev").map((s) => s.kind)).toEqual(["credentials", "dotenv", "claude", "codex"]);
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `bun test src/core/secretimport.test.ts`
Expected: FAIL, `Cannot find module './secretimport'`.

- [ ] **Step 3: Write the module**

Create `src/core/secretimport.ts`:

```ts
/**
 * Where secrets live today, read for the import. Each reader takes a file's
 * text and returns the values in it; the lists name the files on the mini
 * (read by the secrets service) and on the Mac (read by the Mac's canopy).
 * A found value goes straight into a seal; nothing here logs one.
 */

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { SECRET_NAME } from "./secretfile";
import { parseDotenv } from "./sinks";
import type { SecretSinkFormat } from "./types";

/** `value` null: a source canopy can list but not read (sops) */
export interface Found {
  source: string;
  key: string;
  value: string | null;
}

export type ImportKind = "dotenv" | "credentials" | "claude" | "codex" | "sops";

export interface ImportSource {
  path: string;
  kind: ImportKind;
}

/** an env reference such as ${HOME}, which is not a secret */
const REF = /^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export function fromDotenv(source: string, text: string): Found[] {
  const p = parseDotenv(text);
  if ("error" in p) return [];
  return p.lines.flatMap((l) => (l.kind === "pair" && l.value !== "" && !REF.test(l.value) ? [{ source, key: l.key, value: l.value }] : []));
}

function leaves(source: string, v: unknown, path: string[]): Found[] {
  if (typeof v === "string") return v !== "" && !REF.test(v) ? [{ source, key: path.join("."), value: v }] : [];
  if (!isObj(v)) return [];
  return Object.entries(v).flatMap(([k, x]) => leaves(source, x, [...path, k]));
}

const json = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

export const fromCredentials = (source: string, text: string): Found[] => leaves(source, json(text), []);

/** each server's env and headers in one `mcpServers` map */
function mcp(source: string, servers: unknown, prefix: string[]): Found[] {
  if (!isObj(servers)) return [];
  return Object.entries(servers).flatMap(([name, s]) =>
    isObj(s) ? [...leaves(source, s["env"], [...prefix, name, "env"]), ...leaves(source, s["headers"], [...prefix, name, "headers"])] : [],
  );
}

export function fromClaudeJson(source: string, text: string): Found[] {
  const v = json(text);
  if (!isObj(v)) return [];
  const projects = isObj(v["projects"]) ? Object.entries(v["projects"]) : [];
  return [
    ...mcp(source, v["mcpServers"], ["mcpServers"]),
    ...projects.flatMap(([p, cfg]) => (isObj(cfg) ? mcp(source, cfg["mcpServers"], ["projects", p, "mcpServers"]) : [])),
  ];
}

export function fromCodexToml(source: string, text: string): Found[] {
  let v: unknown;
  try {
    v = Bun.TOML.parse(text);
  } catch {
    return [];
  }
  if (!isObj(v) || !isObj(v["mcp_servers"])) return [];
  return Object.entries(v["mcp_servers"]).flatMap(([name, s]) => (isObj(s) ? leaves(source, s["env"], ["mcp_servers", name, "env"]) : []));
}

export function sopsNames(source: string, text: string): Found[] {
  let v: unknown;
  try {
    v = Bun.YAML.parse(text);
  } catch {
    return [];
  }
  if (!isObj(v)) return [];
  return Object.keys(v)
    .filter((k) => k !== "sops")
    .map((key) => ({ source, key, value: null }));
}

/** A name for a found value: the stack or MCP server it belongs to, then
 *  its key, lowercased, in the store's alphabet. */
export function suggestName(source: string, key: string): string {
  const stack = /^\/opt\/stacks\/([^/]+)\//.exec(source)?.[1];
  const parts = key.split(".");
  const server = parts[0] === "mcpServers" || parts[0] === "mcp_servers" ? parts[parts.length - 3] : parts[0] === "projects" ? parts[parts.length - 3] : undefined;
  const last = parts.length > 1 && !server ? parts.join("_") : (parts[parts.length - 1] ?? key);
  const raw = [stack, server, last].filter(Boolean).join("_").toLowerCase().replace(/[^a-z0-9_.-]+/g, "_").slice(0, 100);
  return SECRET_NAME.test(raw) ? raw : `s_${raw}`.slice(0, 100);
}

/** the sink format a source file would have, null when it cannot be one */
export function formatOf(path: string): SecretSinkFormat | null {
  if (path.endsWith(".env")) return "dotenv";
  if (path.endsWith(".json")) return "json";
  return null;
}

const READERS: Record<ImportKind, (source: string, text: string) => Found[]> = {
  dotenv: fromDotenv,
  credentials: fromCredentials,
  claude: fromClaudeJson,
  codex: fromCodexToml,
  sops: sopsNames,
};

export async function scanFiles(list: readonly ImportSource[]): Promise<{ found: Found[]; missing: string[] }> {
  const found: Found[] = [];
  const missing: string[] = [];
  for (const s of list) {
    let text: string;
    try {
      text = await readFile(s.path, "utf8");
    } catch {
      missing.push(s.path);
      continue;
    }
    found.push(...READERS[s.kind](s.path, text));
  }
  return { found, missing };
}

export const macSources = (home: string, dev: string): ImportSource[] => [
  { path: join(home, ".claude", "credentials", ".credentials.json"), kind: "credentials" },
  { path: join(dev, ".env"), kind: "dotenv" },
  { path: join(home, ".claude.json"), kind: "claude" },
  { path: join(home, ".codex", "config.toml"), kind: "codex" },
];

/** each stack folder's .env, the two sops files, and `extra` dotenv files */
export async function miniSources(stacks: string, extra: readonly string[]): Promise<ImportSource[]> {
  let dirs: string[] = [];
  try {
    dirs = (await readdir(stacks, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name).sort();
  } catch {
    // no stacks mounted
  }
  return [
    ...dirs.map((d) => ({ path: join(stacks, d, ".env"), kind: "dotenv" as const })),
    { path: join(stacks, "memory", "env.sops.yaml"), kind: "sops" },
    { path: join(stacks, "executor", "env.sops.yaml"), kind: "sops" },
    ...extra.map((path) => ({ path, kind: "dotenv" as const })),
  ];
}
```

- [ ] **Step 4: Run the tests**

Run: `bun test src/core/secretimport.test.ts`
Expected: PASS. Check the suggestName table by hand if one fails: for `mcpServers.github.env.GITHUB_TOKEN` the server is the third part from the end (`github`) and the key is the last.

- [ ] **Step 5: Lint and typecheck**

Run: `bun run typecheck && bun run lint`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/core/secretimport.ts src/core/secretimport.test.ts
git commit -m "$(printf 'feat(secrets): read the import sources on the mini and the Mac\n\nClaude-Session: https://claude.ai/code/session_01DEgdKaVhnhcGveC62zKQJh')"
```

---

### Task 9: The service's requests and the mini's sinks

**Files:**
- Create: `src/core/sinksync.ts`
- Create: `src/secrets/service.ts`
- Test: `src/secrets/service.test.ts`

**Interfaces:**
- Consumes: Tasks 2 to 8: `SecretFile`, `SinkDef`, `metaList`, `nowStamp`, `recipientKeys`, `recipientsFor`, `usedBy`, `emptyFile`, `DOTENV_KEY`, `JSON_PATH`; `openValue`, `sealValue`, `resealValue`, `sameValue`, `sealProposal`, `openProposal`, `newIdentity`; `applyKeys`, `decideKey`, `readKeys`, `readSinkFile`, `writeSinkFile`; `LIMITS`, `PASSKEY`, `SecretAct`, `SecretsRequest`, `SecretsReply`, `ACT_KINDS`, `SAMPLES`; `Applied`; `Audit`; `Gate`; `Found`, `formatOf`, `suggestName`.
- Produces: `syncSink`, `waitingState`, `SinkIO`, `SinkState`, `FILE_IO` (sinksync.ts, used again by Task 11); `SecretsService` (`handle`, `info`, `syncSinks`, `tick`), `StoreLike`, `ServiceDeps`. Used by Tasks 10, 11 and 16.

Rules this task carries out:

- Every act checks the session first and is audited either way. One change runs at a time (`serial`), since two acts would each sign over the other's base.
- A value's recipients follow `recipientsFor`; `change` reseals every value whose machine set or whose machines' keys changed, then commits and syncs the mini's sinks.
- Defining a sink adds `sink:<id>` to the allowlist of each secret it maps and drops it from secrets it no longer maps. An allowlist edit that would drop a sink still mapping the secret is refused, as is deleting a secret any sink uses.
- The service writes only sinks whose machine is `mini`, only under its sink roots (`/opt/stacks`), and follows `decideKey`. A gpd sink shows `phase 3`; a Mac sink shows nothing here (the Mac reports its own).
- Proposals live in memory for 24 hours, at most 500 at once. One sealed to another key, or under another source or key, is dropped. A proposal holding the same value as a secret or another proposal says so (`same`), compared in memory.

- [ ] **Step 1: Write the failing tests**

Create `src/secrets/service.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Applied } from "../core/applied";
import { newIdentity, openValue, sealProposal } from "../core/secretcrypt";
import { emptyFile, type SecretFile } from "../core/secretfile";
import { ACT_KINDS, LIMITS, type SecretAct, type SecretsReply } from "../core/secretwire";
import { SAMPLES } from "../core/secretwire.samples";
import type { Found } from "../core/secretimport";
import type { SecretsInfo } from "../core/types";
import { Audit } from "./audit";
import { Gate, type WebAuthn } from "./gate";
import { SecretsService, type StoreLike } from "./service";

const BREAKGLASS = "age1xtc4cftnu55fn3enurt9jexnrenmru3w0xl93uz5q20e34mefs6stg2vra";
const V = "fixture-value-0x5eed";

class MemStore implements StoreLike {
  file: SecretFile;
  head = "abc1234";
  unpushed = 0;
  commits: string[] = [];
  constructor(
    public recipient: string,
    private readonly ident: string,
  ) {
    this.file = emptyFile({ mini: recipient, breakglass: BREAKGLASS });
  }
  identity(): string {
    return this.ident;
  }
  async commit(next: SecretFile, message: string): Promise<void> {
    this.file = { ...next, signature: null };
    this.commits.push(message);
  }
}

const wa: WebAuthn = {
  genReg: (async () => ({ challenge: "c" })) as unknown as WebAuthn["genReg"],
  verifyReg: (async () => ({ verified: true, registrationInfo: { credential: { id: "cred1", publicKey: new Uint8Array([1]), counter: 0 } } })) as unknown as WebAuthn["verifyReg"],
  genAuth: (async () => ({ challenge: "c" })) as unknown as WebAuthn["genAuth"],
  verifyAuth: (async () => ({ verified: true, authenticationInfo: { newCounter: 1 } })) as unknown as WebAuthn["verifyAuth"],
};

let dir = "";
let stacks = "";
let t = 0;
let logs: string[] = [];
let token = "";
let found: Found[] = [];
let svc: SecretsService;
let store: MemStore;
let audit: Audit;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "canopy-service-"));
  stacks = join(dir, "stacks");
  await mkdir(join(stacks, "dns"), { recursive: true });
  t = Date.parse("2026-10-14T12:00:00.000Z");
  logs = [];
  found = [];
  const mini = await newIdentity();
  store = new MemStore(mini.recipient, mini.identity);
  const gate = await Gate.open({ file: join(dir, "passkeys.json"), rpID: "canopy.beric.ca", origin: "https://canopy.beric.ca", now: () => t, wa, log: (l) => logs.push(l) });
  audit = new Audit(join(dir, "audit.jsonl"), () => t);
  let applied: Applied = {};
  svc = new SecretsService({
    store,
    gate,
    audit,
    machine: "mini",
    gateUrl: "https://canopy.beric.ca/?view=secrets",
    sinkRoots: [stacks],
    applied: { read: async () => structuredClone(applied), write: async (a) => void (applied = structuredClone(a)) },
    scan: async () => found,
    now: () => t,
    log: (l) => logs.push(l),
  });
  const code = /code ([0-9a-f]{10})/.exec(logs.join("\n"))?.[1] ?? "";
  await gate.begin("register", null, code);
  await gate.finish("register", null, code, { id: "cred1" }, "phone");
  await gate.begin("login", null, null);
  const r = await gate.finish("login", null, null, { id: "cred1" }, "");
  token = r.ok ? (r.data as { token: string }).token : "";
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const act = (a: SecretAct): Promise<SecretsReply> => svc.handle({ t: "act", token, act: a });
const ok = async (a: SecretAct): Promise<unknown> => {
  const r = await act(a);
  if (!r.ok) throw new Error(r.error);
  return r.data;
};
const info = async (): Promise<SecretsInfo> => {
  const r = await svc.handle({ t: "info", token: null });
  if (!r.ok) throw new Error(r.error);
  return r.data as SecretsInfo;
};
const sinkFile = () => join(stacks, "dns", ".env");
const add = (name = "cf_token", value = V) => ok({ a: "add", name, value, description: "dns", tags: ["dns"] });
const dnsSink = (): SecretAct => ({ a: "sink-set", id: "dns", machine: "mini", path: sinkFile(), format: "dotenv", keys: { CF_TOKEN: "cf_token" } });

describe("the gate in front of every act", () => {
  test("every act kind is refused without a session and after one expires, and audited", async () => {
    for (const k of ACT_KINDS) {
      expect(await svc.handle({ t: "act", token: null, act: SAMPLES[k].good })).toEqual({ ok: false, error: "open the passkey gate first", gate: "passkey" });
    }
    t += LIMITS.idleMs + 1;
    for (const k of ACT_KINDS) {
      expect(await act(SAMPLES[k].good)).toMatchObject({ ok: false, gate: "passkey" });
    }
    expect(store.commits).toEqual([]);
    const log = await audit.last(100);
    expect(log).toHaveLength(ACT_KINDS.length * 2);
    expect(log.every((e) => !e.ok && e.by === null)).toBe(true);
  });
});

describe("values", () => {
  test("add then reveal; info and the audit log never hold the value", async () => {
    await add();
    expect(store.commits).toEqual(["secrets: add cf_token"]);
    expect(await ok({ a: "reveal", name: "cf_token" })).toEqual({ value: V, hideAfterMs: LIMITS.revealHideMs });
    expect(JSON.stringify(await info())).not.toContain(V);
    expect(await readFile(join(dir, "audit.jsonl"), "utf8")).not.toContain(V);
    expect((await audit.last(1))[0]).toMatchObject({ action: "reveal", name: "cf_token", ok: true, by: "phone" });
  });

  test("an existing name is refused; delete is refused while a sink uses it", async () => {
    await add();
    expect((await act({ a: "add", name: "cf_token", value: "x", description: "", tags: [] })).ok).toBe(false);
    await ok(dnsSink());
    const r = await act({ a: "delete", name: "cf_token" });
    expect(r.ok ? "" : r.error).toContain("used by dns");
    await ok({ a: "sink-remove", id: "dns" });
    await ok({ a: "delete", name: "cf_token" });
    expect(store.file.secrets["cf_token"]).toBeUndefined();
  });

  test("an allowlist edit cannot drop a sink that still maps the secret", async () => {
    await add();
    await ok(dnsSink());
    expect(store.file.secrets["cf_token"]?.allow).toEqual(["sink:dns"]);
    expect((await act({ a: "allow", name: "cf_token", allow: [] })).ok).toBe(false);
  });
});

describe("the mini's sinks", () => {
  test("a write keeps comments and unmanaged keys and records the key as same", async () => {
    await writeFile(sinkFile(), "# keep\nOTHER=1\n");
    await add();
    await ok(dnsSink());
    expect(await readFile(sinkFile(), "utf8")).toBe(`# keep\nOTHER=1\nCF_TOKEN=${V}\n`);
    expect((await info()).sinks[0]?.state).toEqual({ CF_TOKEN: "same" });
  });

  test("a value that differs before canopy wrote it is drift and stays until sink-write", async () => {
    await writeFile(sinkFile(), "CF_TOKEN=theirs\n");
    await add();
    await ok(dnsSink());
    expect(await readFile(sinkFile(), "utf8")).toBe("CF_TOKEN=theirs\n");
    expect((await info()).sinks[0]?.state).toEqual({ CF_TOKEN: "drift" });
    await ok({ a: "sink-write", id: "dns", key: "CF_TOKEN" });
    expect(await readFile(sinkFile(), "utf8")).toBe(`CF_TOKEN=${V}\n`);
    expect((await info()).sinks[0]?.state).toEqual({ CF_TOKEN: "same" });
  });

  test("a hand edit after a write is drift; take puts it in the store", async () => {
    await add();
    await ok(dnsSink());
    await writeFile(sinkFile(), "CF_TOKEN=by-hand\n");
    await svc.syncSinks();
    expect((await info()).sinks[0]?.state).toEqual({ CF_TOKEN: "drift" });
    t += 1000;
    await ok({ a: "take", id: "dns", key: "CF_TOKEN" });
    expect(await ok({ a: "reveal", name: "cf_token" })).toMatchObject({ value: "by-hand" });
    expect((await info()).sinks[0]?.state).toEqual({ CF_TOKEN: "same" });
  });

  test("a rotation rewrites the file", async () => {
    await add();
    await ok(dnsSink());
    t += 1000;
    await ok({ a: "rotate", name: "cf_token", value: "second" });
    expect(await readFile(sinkFile(), "utf8")).toBe("CF_TOKEN=second\n");
  });

  test("outside the sink roots is refused; an unparseable file is left alone", async () => {
    await add();
    const r = await act({ ...(dnsSink() as Extract<SecretAct, { a: "sink-set" }>), path: join(dir, "elsewhere.env") });
    expect(r.ok ? "" : r.error).toContain("outside");
    await ok(dnsSink());
    await writeFile(sinkFile(), "this is not dotenv\n");
    await svc.syncSinks();
    const s = (await info()).sinks[0];
    expect(s?.error).toContain("line 1");
    expect(await readFile(sinkFile(), "utf8")).toBe("this is not dotenv\n");
    expect(s?.error).not.toContain(V);
  });

  test("a Mac sink needs the Mac's key, then seals the value to it", async () => {
    await add();
    const macSink: SecretAct = { a: "sink-set", id: "laptop", machine: "mac", path: "/Users/e/x/.env", format: "dotenv", keys: { CF: "cf_token" } };
    const before = await act(macSink);
    expect(before.ok ? "" : before.error).toContain("mac");
    const mac = await newIdentity();
    await ok({ a: "machine-key", machine: "mac", recipient: mac.recipient });
    await ok(macSink);
    const e = store.file.secrets["cf_token"];
    expect(e?.to).toEqual(["breakglass", "mac", "mini"]);
    expect(await openValue(e?.value ?? "", mac.identity, { name: "cf_token", rotated: e?.rotated ?? "" })).toBe(V);
    expect((await info()).sinks.find((s) => s.id === "laptop")?.state).toEqual({});
  });
});

describe("proposals", () => {
  test("a Mac proposal shows its suggested name and a match, and approves into a secret", async () => {
    await add();
    const p = { from: "mac", source: "/Users/e/dev/.env", key: "CF_TOKEN" };
    const q = { from: "mac", source: "/Users/e/dev/.env", key: "OPENAI_API_KEY" };
    const r = await svc.handle({
      t: "propose",
      items: [
        { ...p, sealed: await sealProposal(p, V, store.recipient), merges: null },
        { ...q, sealed: await sealProposal(q, "sk-other", store.recipient), merges: null },
        { ...q, key: "WRONG", sealed: await sealProposal(q, "x", store.recipient), merges: null },
      ],
    });
    expect(r).toEqual({ ok: true, data: { added: 2, dropped: 1 } });
    const list = (await info()).proposals;
    expect(list.find((x) => x.key === "CF_TOKEN")?.same).toBe("cf_token");
    const openai = list.find((x) => x.key === "OPENAI_API_KEY");
    expect(openai?.suggested).toBe("openai_api_key");
    await ok({ a: "approve", proposal: openai?.id ?? "", name: "openai_api_key", description: "", tags: [], value: null, sink: null });
    expect(await ok({ a: "reveal", name: "openai_api_key" })).toMatchObject({ value: "sk-other" });
    expect((await info()).proposals.map((x) => x.key)).toEqual(["CF_TOKEN"]);
    expect(JSON.stringify(await info())).not.toContain("sk-other");
  });

  test("a names-only proposal needs a value; proposals expire after a day", async () => {
    found = [{ source: join(stacks, "memory", "env.sops.yaml"), key: "DB_PASSWORD", value: null }];
    await ok({ a: "import-scan" });
    const p = (await info()).proposals[0];
    expect(p?.namesOnly).toBe(true);
    expect((await act({ a: "approve", proposal: p?.id ?? "", name: "memory_db_password", description: "", tags: [], value: null, sink: null })).ok).toBe(false);
    t += LIMITS.proposalTtlMs + 1;
    expect((await info()).proposals).toEqual([]);
  });

  test("at most 500 wait at once", async () => {
    const batch = (n: number) => Array.from({ length: 200 }, (_, i) => ({ from: "mac", source: "/Users/e/dev/.env", key: `K${n}_${i}`, sealed: "", merges: null }));
    expect((await svc.handle({ t: "propose", items: batch(1) })).ok).toBe(true);
    expect((await svc.handle({ t: "propose", items: batch(2) })).ok).toBe(true);
    expect((await svc.handle({ t: "propose", items: batch(3) })).ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `bun test src/secrets/service.test.ts`
Expected: FAIL, `Cannot find module './service'`.

- [ ] **Step 3: Write the shared sink sync**

The service writes the mini's sinks and the Mac's canopy writes the Mac's with the same rule, so the per-sink loop lives in core. Create `src/core/sinksync.ts`:

```ts
/**
 * One sink's sync, shared by the secrets service (the mini's sinks) and a
 * reader backend with an unlocked key (the Mac's): read the file, open each
 * mapped value, and write the keys `decideKey` says to write. A refused
 * path or a file that does not parse is left alone and named. No state or
 * error here holds a value.
 */

import type { Applied } from "./applied";
import { openValue } from "./secretcrypt";
import type { SecretFile, SinkDef } from "./secretfile";
import { applyKeys, decideKey, readKeys, readSinkFile, writeSinkFile } from "./sinks";
import type { SecretKeyState } from "./types";

export interface SinkIO {
  read(path: string): Promise<{ text: string | null } | { error: string }>;
  write(path: string, text: string): Promise<void>;
}

export const FILE_IO: SinkIO = { read: readSinkFile, write: writeSinkFile };

export interface SinkState {
  state: Record<string, SecretKeyState>;
  error: string | null;
}

const errText = (err: unknown): string => (err instanceof Error ? err.message : "failed");

/** every key waiting: the owner's key is locked and the file keeps what it has */
export const waitingState = (sink: SinkDef): SinkState => ({
  state: Object.fromEntries(Object.keys(sink.keys).map((k) => [k, "waiting" as const])),
  error: null,
});

/** Sync one sink. `applied` is updated in place for this sink's id. */
export async function syncSink(
  f: SecretFile,
  id: string,
  sink: SinkDef,
  identity: string,
  applied: Applied,
  io: SinkIO,
  refusal: string | null,
): Promise<SinkState> {
  if (refusal) return { state: {}, error: refusal };
  const read = await io.read(sink.path);
  if ("error" in read) return { state: {}, error: read.error };
  const keys = Object.keys(sink.keys);
  const have = read.text === null ? { values: {} as Record<string, string | undefined> } : readKeys(read.text, sink.format, keys);
  if ("error" in have) return { state: {}, error: `${sink.path}: ${have.error}; left as it is` };
  const stamps = { ...(applied[id] ?? {}) };
  const state: Record<string, SecretKeyState> = {};
  const updates: Record<string, string> = {};
  let error: string | null = null;
  for (const [key, name] of Object.entries(sink.keys)) {
    const e = f.secrets[name];
    if (!e) {
      state[key] = "unknown";
      continue;
    }
    let value: string;
    try {
      value = await openValue(e.value, identity, { name, rotated: e.rotated });
    } catch (err) {
      state[key] = "unknown";
      error = errText(err);
      continue;
    }
    const d = decideKey(stamps[key], e.rotated, have.values[key], value);
    if (d === "write") updates[key] = value;
    else if (d === "same") stamps[key] = e.rotated;
    state[key] = d === "drift" ? "drift" : d === "same" ? "same" : have.values[key] === undefined ? "missing" : "waiting";
  }
  if (Object.keys(updates).length > 0) {
    const next = applyKeys(read.text, sink.format, updates);
    if ("error" in next) return { state, error: `${sink.path}: ${next.error}` };
    try {
      await io.write(sink.path, next.text);
      for (const key of Object.keys(updates)) {
        const name = sink.keys[key];
        const e = name ? f.secrets[name] : undefined;
        if (e) stamps[key] = e.rotated;
        state[key] = "same";
      }
    } catch (err) {
      error = `${sink.path} could not be written: ${errText(err)}`;
    }
  }
  applied[id] = stamps;
  return { state, error };
}
```

- [ ] **Step 4: Write the service**

Create `src/secrets/service.ts`:

```ts
/**
 * The secrets service's requests (src/core/secretwire.ts): info and audit
 * for any caller on the socket, the passkey gate, proposals from the Mac,
 * and the gated acts. The only process on the mini that opens a value. It
 * writes the mini's own sinks after each change and on a timer, never over
 * a drifted key. Errors it returns name secrets and paths, never values.
 */

import { randomBytes } from "node:crypto";
import type { Applied } from "../core/applied";
import { openProposal, openValue, resealValue, sameValue, sealProposal, sealValue } from "../core/secretcrypt";
import { DOTENV_KEY, JSON_PATH, metaList, nowStamp, recipientKeys, recipientsFor, usedBy, type SecretFile, type SinkDef } from "../core/secretfile";
import { formatOf, suggestName, type Found } from "../core/secretimport";
import { LIMITS, PASSKEY, type SecretAct, type SecretsReply, type SecretsRequest } from "../core/secretwire";
import { applyKeys, readKeys } from "../core/sinks";
import { FILE_IO, syncSink, type SinkIO, type SinkState } from "../core/sinksync";
import type { SecretKeyState, SecretProposalIn, SecretsInfo } from "../core/types";
import type { Audit } from "./audit";
import type { Gate } from "./gate";

export interface StoreLike {
  file: SecretFile;
  head: string | null;
  unpushed: number;
  recipient: string;
  identity(): string;
  commit(next: SecretFile, message: string): Promise<void>;
}

export interface ServiceDeps {
  store: StoreLike;
  gate: Gate;
  audit: Audit;
  /** this machine's name in the file */
  machine: string;
  /** the page where gated acts live */
  gateUrl: string;
  /** the only folders this service writes sinks in */
  sinkRoots: readonly string[];
  applied: { read(): Promise<Applied>; write(a: Applied): Promise<void> };
  /** this machine's import sources */
  scan: () => Promise<Found[]>;
  io?: SinkIO;
  now?: () => number;
  log: (line: string) => void;
}

interface Pending {
  id: string;
  p: SecretProposalIn;
  expires: number;
  suggested: string;
  same: string | null;
}

const fail = (error: string): SecretsReply => ({ ok: false, error });
const errText = (err: unknown): string => (err instanceof Error ? err.message : "failed");

/** what an act is about, for the audit line */
function subject(act: SecretAct): string | null {
  switch (act.a) {
    case "reveal":
    case "add":
    case "edit":
    case "rotate":
    case "delete":
    case "allow":
      return act.name;
    case "sink-set":
    case "sink-remove":
    case "passkey-remove":
      return act.id;
    case "sink-write":
    case "take":
      return `${act.id}:${act.key}`;
    case "approve":
      return act.name;
    case "reject":
      return act.proposal;
    case "machine-key":
      return act.machine;
    case "import-scan":
      return null;
  }
}

export class SecretsService {
  private readonly proposals = new Map<string, Pending>();
  private sinkState: Record<string, SinkState> = {};
  private readonly io: SinkIO;
  private readonly now: () => number;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly d: ServiceDeps) {
    this.io = d.io ?? FILE_IO;
    this.now = d.now ?? Date.now;
  }

  /** one change at a time: two acts would each sign over the other's base */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => {});
    return run;
  }

  async handle(req: SecretsRequest): Promise<SecretsReply> {
    try {
      switch (req.t) {
        case "info":
          return { ok: true, data: this.info(req.token) };
        case "audit":
          return { ok: true, data: await this.d.audit.last(req.limit) };
        case "begin":
          return await this.d.gate.begin(req.kind, req.token, req.code);
        case "finish": {
          const r = await this.d.gate.finish(req.kind, req.token, req.code, req.response, req.label);
          await this.d.audit.add({ action: req.kind === "login" ? "login" : "passkey-add", name: null, ok: r.ok, by: req.kind === "register" && r.ok ? req.label || null : null, detail: r.ok ? null : r.error });
          return r;
        }
        case "logout":
          this.d.gate.logout(req.token);
          return { ok: true, data: null };
        case "propose":
          return await this.serial(() => this.propose(req.items));
        case "act":
          return await this.act(req.token, req.act);
      }
    } catch (err) {
      // the message, never a stack: a stack can quote what it failed on
      this.d.log(`secrets: ${req.t} failed: ${errText(err)}`);
      return fail(errText(err));
    }
  }

  private async act(token: string | null, act: SecretAct): Promise<SecretsReply> {
    const s = this.d.gate.session(token);
    if (!s) {
      await this.d.audit.add({ action: act.a, name: subject(act), ok: false, by: null, detail: "no passkey session" });
      return { ok: false, error: "open the passkey gate first", gate: PASSKEY };
    }
    let r: SecretsReply;
    try {
      r = await this.serial(() => this.run(act));
    } catch (err) {
      r = fail(errText(err));
    }
    await this.d.audit.add({ action: act.a, name: subject(act), ok: r.ok, by: s.label, detail: r.ok ? null : r.error });
    return r;
  }

  private async run(act: SecretAct): Promise<SecretsReply> {
    const f = this.d.store.file;
    switch (act.a) {
      case "reveal": {
        const e = f.secrets[act.name];
        if (!e) return fail(`no secret named ${act.name}`);
        const value = await openValue(e.value, this.d.store.identity(), { name: act.name, rotated: e.rotated });
        return { ok: true, data: { value, hideAfterMs: LIMITS.revealHideMs } };
      }
      case "add":
        if (f.secrets[act.name]) return fail(`${act.name} exists; rotate it instead`);
        return this.change(await this.withValue(f, act.name, act.value, { description: act.description, tags: act.tags }), `secrets: add ${act.name}`);
      case "edit": {
        const e = f.secrets[act.name];
        if (!e) return fail(`no secret named ${act.name}`);
        return this.change({ ...f, secrets: { ...f.secrets, [act.name]: { ...e, description: act.description, tags: act.tags } } }, `secrets: describe ${act.name}`);
      }
      case "rotate":
        if (!f.secrets[act.name]) return fail(`no secret named ${act.name}`);
        return this.change(await this.withValue(f, act.name, act.value, null), `secrets: rotate ${act.name}`);
      case "delete": {
        if (!f.secrets[act.name]) return fail(`no secret named ${act.name}`);
        const users = usedBy(f, act.name);
        if (users.length > 0) return fail(`${act.name} is used by ${users.join(", ")}; take it out of those sinks first`);
        const secrets = Object.fromEntries(Object.entries(f.secrets).filter(([n]) => n !== act.name));
        return this.change({ ...f, secrets }, `secrets: delete ${act.name}`);
      }
      case "allow": {
        const e = f.secrets[act.name];
        if (!e) return fail(`no secret named ${act.name}`);
        const still = usedBy(f, act.name).map((id) => `sink:${id}`).filter((a) => !act.allow.includes(a));
        if (still.length > 0) return fail(`${still.join(", ")} still use ${act.name}; take it out of those sinks first`);
        return this.change({ ...f, secrets: { ...f.secrets, [act.name]: { ...e, allow: [...new Set(act.allow)].sort() } } }, `secrets: allowlist ${act.name}`);
      }
      case "sink-set":
        return this.setSink(f, act.id, { machine: act.machine, path: act.path, format: act.format, keys: act.keys }, `secrets: sink ${act.id}`);
      case "sink-remove":
        if (!f.sinks[act.id]) return fail(`no sink named ${act.id}`);
        return this.setSink(f, act.id, null, `secrets: remove sink ${act.id}`);
      case "sink-write":
        return this.forceWrite(act.id, act.key);
      case "take":
        return this.take(act.id, act.key);
      case "import-scan": {
        const found = await this.d.scan();
        const items: SecretProposalIn[] = [];
        for (const x of found) {
          const ref = { from: this.d.machine, source: x.source, key: x.key };
          items.push({ ...ref, sealed: x.value === null ? "" : await sealProposal(ref, x.value, this.d.store.recipient), merges: null });
        }
        return this.propose(items);
      }
      case "approve":
        return this.approve(act);
      case "reject":
        return this.proposals.delete(act.proposal) ? { ok: true, data: null } : fail("no such proposal; it may have expired");
      case "machine-key":
        return this.change({ ...f, keys: { ...f.keys, [act.machine]: act.recipient } }, `secrets: key for ${act.machine}`);
      case "passkey-remove":
        return this.d.gate.remove(act.id);
    }
  }

  /** `name` holding `value`, sealed now; the stamp always moves forward */
  private async withValue(f: SecretFile, name: string, value: string, meta: { description: string; tags: string[] } | null): Promise<SecretFile> {
    const old = f.secrets[name];
    const stamp = nowStamp(Math.max(this.now(), old ? Date.parse(old.rotated) + 1 : 0));
    const to = recipientsFor(f, name);
    const keyed = recipientKeys(f, to);
    if ("missing" in keyed) throw new Error(`${name} needs the ${keyed.missing.join(", ")} key in the file first`);
    return {
      ...f,
      secrets: {
        ...f.secrets,
        [name]: {
          description: meta?.description ?? old?.description ?? "",
          tags: meta?.tags ?? old?.tags ?? [],
          created: old?.created ?? stamp,
          rotated: stamp,
          to,
          allow: old?.allow ?? [],
          value: await sealValue(name, value, stamp, keyed.keys),
        },
      },
    };
  }

  /** every value whose machines, or whose machines' keys, changed, sealed again */
  private async reseal(next: SecretFile): Promise<SecretFile> {
    const before = this.d.store.file;
    const secrets = { ...next.secrets };
    for (const [name, e] of Object.entries(next.secrets)) {
      const want = recipientsFor(next, name);
      const keyed = recipientKeys(next, want);
      if ("missing" in keyed) throw new Error(`${name} would be sealed to ${keyed.missing.join(", ")}, which has no key in the file yet`);
      const same = want.join() === [...e.to].sort().join() && want.every((m) => before.keys[m] === next.keys[m]);
      if (same) continue;
      secrets[name] = { ...e, to: want, value: await resealValue(e.value, this.d.store.identity(), { name, rotated: e.rotated }, keyed.keys) };
    }
    return { ...next, secrets };
  }

  private async change(next: SecretFile, message: string): Promise<SecretsReply> {
    await this.d.store.commit(await this.reseal(next), message);
    await this.syncSinks();
    return { ok: true, data: { head: this.d.store.head } };
  }

  private rootRefusal(path: string): string | null {
    const inside = this.d.sinkRoots.some((r) => path.startsWith(r.endsWith("/") ? r : `${r}/`));
    return inside ? null : `${path} is outside ${this.d.sinkRoots.join(", ")}, the only folders the secrets service writes`;
  }

  private setSink(f: SecretFile, id: string, def: SinkDef | null, message: string): Promise<SecretsReply> {
    if (def) {
      for (const [k, n] of Object.entries(def.keys)) if (!f.secrets[n]) return Promise.resolve(fail(`${k} maps to ${n}, which the store does not hold`));
      if (def.machine === this.d.machine) {
        const refused = this.rootRefusal(def.path);
        if (refused) return Promise.resolve(fail(refused));
      }
      const clash = Object.entries(f.sinks).find(([other, s]) => other !== id && s.machine === def.machine && s.path === def.path);
      if (clash) return Promise.resolve(fail(`sink ${clash[0]} already writes ${def.path} on ${def.machine}`));
    }
    const sinks: Record<string, SinkDef> = Object.fromEntries(Object.entries(f.sinks).filter(([k]) => k !== id));
    if (def) sinks[id] = def;
    const tag = `sink:${id}`;
    const uses = new Set(def ? Object.values(def.keys) : []);
    const secrets = Object.fromEntries(
      Object.entries(f.secrets).map(([n, e]) => {
        const has = e.allow.includes(tag);
        if (uses.has(n) && !has) return [n, { ...e, allow: [...e.allow, tag].sort() }];
        if (!uses.has(n) && has) return [n, { ...e, allow: e.allow.filter((a) => a !== tag) }];
        return [n, e];
      }),
    );
    return this.change({ ...f, sinks, secrets }, message);
  }

  /** the store's value over one drifted key of a sink on this machine */
  private async forceWrite(id: string, key: string): Promise<SecretsReply> {
    const f = this.d.store.file;
    const sink = f.sinks[id];
    const name = sink?.keys[key];
    const e = name ? f.secrets[name] : undefined;
    if (!sink || !name || !e) return fail(`sink ${id} has no key ${key}`);
    if (sink.machine !== this.d.machine) return fail(`sink ${id} lives on ${sink.machine}; its own canopy writes it`);
    const refused = this.rootRefusal(sink.path);
    if (refused) return fail(refused);
    const read = await this.io.read(sink.path);
    if ("error" in read) return fail(read.error);
    const value = await openValue(e.value, this.d.store.identity(), { name, rotated: e.rotated });
    const next = applyKeys(read.text, sink.format, { [key]: value });
    if ("error" in next) return fail(`${sink.path}: ${next.error}`);
    await this.io.write(sink.path, next.text);
    const applied = await this.d.applied.read();
    applied[id] = { ...(applied[id] ?? {}), [key]: e.rotated };
    await this.d.applied.write(applied);
    await this.syncSinks();
    return { ok: true, data: null };
  }

  /** one drifted key's file value into the store */
  private async take(id: string, key: string): Promise<SecretsReply> {
    const f = this.d.store.file;
    const sink = f.sinks[id];
    const name = sink?.keys[key];
    if (!sink || !name || !f.secrets[name]) return fail(`sink ${id} has no key ${key}`);
    if (sink.machine !== this.d.machine) return fail(`sink ${id} lives on ${sink.machine}; take it from that machine's page`);
    const read = await this.io.read(sink.path);
    if ("error" in read) return fail(read.error);
    if (read.text === null) return fail(`${sink.path} does not exist`);
    const have = readKeys(read.text, sink.format, [key]);
    if ("error" in have) return fail(`${sink.path}: ${have.error}`);
    const value = have.values[key];
    if (value === undefined || value === "") return fail(`${sink.path} has no ${key}`);
    return this.change(await this.withValue(f, name, value, null), `secrets: take ${name} from sink ${id}`);
  }

  private expire(): void {
    const t = this.now();
    for (const [id, p] of this.proposals) if (p.expires < t) this.proposals.delete(id);
  }

  /** every value this process can open now, labelled, for `same` */
  private async known(): Promise<[string, string][]> {
    const out: [string, string][] = [];
    const id = this.d.store.identity();
    for (const [name, e] of Object.entries(this.d.store.file.secrets)) {
      try {
        out.push([name, await openValue(e.value, id, { name, rotated: e.rotated })]);
      } catch {
        // a value this key cannot open matches nothing
      }
    }
    for (const q of this.proposals.values()) {
      if (!q.p.sealed) continue;
      try {
        out.push([`${q.p.key} from ${q.p.source}`, await openProposal(q.p.sealed, id, q.p)]);
      } catch {
        // dropped at intake already
      }
    }
    return out;
  }

  private async propose(items: SecretProposalIn[]): Promise<SecretsReply> {
    this.expire();
    if (this.proposals.size + items.length > LIMITS.pending) return fail(`at most ${LIMITS.pending} proposals wait at once; approve or reject some first`);
    const id = this.d.store.identity();
    const known = await this.known();
    let added = 0;
    let dropped = 0;
    for (const p of items) {
      for (const [pid, q] of this.proposals) if (q.p.from === p.from && q.p.source === p.source && q.p.key === p.key) this.proposals.delete(pid);
      let value: string | null = null;
      if (p.sealed) {
        try {
          value = await openProposal(p.sealed, id, p);
        } catch {
          dropped += 1;
          continue;
        }
      }
      if (p.merges && !this.d.store.file.secrets[p.merges]) {
        dropped += 1;
        continue;
      }
      const v = value;
      const same = v === null ? null : (known.find(([, k]) => sameValue(k, v))?.[0] ?? null);
      const pid = randomBytes(9).toString("base64url");
      this.proposals.set(pid, { id: pid, p, expires: this.now() + LIMITS.proposalTtlMs, suggested: suggestName(p.source, p.key), same });
      if (v !== null) known.push([`${p.key} from ${p.source}`, v]);
      added += 1;
    }
    return { ok: true, data: { added, dropped } };
  }

  private async approve(act: Extract<SecretAct, { a: "approve" }>): Promise<SecretsReply> {
    this.expire();
    const q = this.proposals.get(act.proposal);
    if (!q) return fail("no such proposal; it may have expired");
    const f = this.d.store.file;
    const ident = this.d.store.identity();
    let value: string;
    if (q.p.sealed) value = await openProposal(q.p.sealed, ident, q.p);
    else if (act.value !== null) value = act.value;
    else return fail("this source can only be listed; type its value to approve it");
    const target = q.p.merges ?? act.name;
    const existing = f.secrets[target];
    let next = f;
    if (q.p.merges) {
      if (!existing) return fail(`${target} is gone`);
      next = await this.withValue(f, target, value, null);
    } else if (existing) {
      const cur = await openValue(existing.value, ident, { name: target, rotated: existing.rotated });
      if (!sameValue(cur, value)) return fail(`${target} exists with another value; pick another name, or rotate it`);
    } else {
      next = await this.withValue(f, target, value, { description: act.description, tags: act.tags });
    }
    if (act.sink) {
      const format = formatOf(q.p.source);
      if (!format) return fail(`${q.p.source} cannot be a sink; only dotenv and json files can`);
      if (!(format === "dotenv" ? DOTENV_KEY : JSON_PATH).test(q.p.key)) return fail(`${q.p.key} cannot be a ${format} sink key`);
      const old = next.sinks[act.sink.id];
      if (old && (old.machine !== q.p.from || old.path !== q.p.source)) return fail(`sink ${act.sink.id} writes another file`);
      const def: SinkDef = { machine: q.p.from, path: q.p.source, format, keys: { ...(old?.keys ?? {}), [q.p.key]: target } };
      const r = await this.setSink(next, act.sink.id, def, `secrets: import ${target} into sink ${act.sink.id}`);
      if (r.ok) this.proposals.delete(q.id);
      return r;
    }
    this.proposals.delete(q.id);
    if (next === f) return { ok: true, data: { head: this.d.store.head } };
    return this.change(next, q.p.merges ? `secrets: take ${target} from ${q.p.from}` : `secrets: import ${target}`);
  }

  /** the timer's sync, queued behind any act in flight */
  tick(): Promise<void> {
    return this.serial(() => this.syncSinks());
  }

  /** Write the sinks this machine owns where the store changed, and read
   *  the rest as same, drift or missing. */
  async syncSinks(): Promise<void> {
    const f = this.d.store.file;
    const applied = await this.d.applied.read();
    const state: Record<string, SinkState> = {};
    for (const [id, sink] of Object.entries(f.sinks)) {
      if (sink.machine !== this.d.machine) continue;
      state[id] = await syncSink(f, id, sink, this.d.store.identity(), applied, this.io, this.rootRefusal(sink.path));
    }
    for (const id of Object.keys(applied)) if (!state[id]) delete applied[id];
    await this.d.applied.write(applied);
    this.sinkState = state;
  }

  info(token: string | null): SecretsInfo {
    this.expire();
    const s = this.d.store;
    const f = s.file;
    return {
      ok: true,
      error: null,
      backend: this.d.machine,
      role: "writer",
      head: s.head,
      refused: null,
      lock: "open",
      secrets: metaList(f),
      sinks: Object.keys(f.sinks)
        .sort()
        .flatMap((id) => {
          const k = f.sinks[id];
          if (!k) return [];
          const own = k.machine === this.d.machine;
          const state: Record<string, SecretKeyState> = own
            ? (this.sinkState[id]?.state ?? {})
            : k.machine === "gpd"
              ? Object.fromEntries(Object.keys(k.keys).map((key) => [key, "phase 3" as const]))
              : {};
          return [{ id, machine: k.machine, path: k.path, format: k.format, keys: { ...k.keys }, state, error: own ? (this.sinkState[id]?.error ?? null) : null }];
        }),
      proposals: [...this.proposals.values()].map((q) => ({
        id: q.id,
        from: q.p.from,
        source: q.p.source,
        key: q.p.key,
        suggested: q.suggested,
        merges: q.p.merges,
        same: q.same,
        namesOnly: q.p.sealed === "",
        expires: q.expires,
      })),
      passkeys: this.d.gate.passkeys(),
      session: this.d.gate.session(token) !== null,
      firstPasskey: this.d.gate.firstPasskey(),
      gate: this.d.gateUrl,
      unpushed: s.unpushed,
    };
  }
}
```

- [ ] **Step 5: Run the tests**

Run: `bun test src/secrets/service.test.ts`
Expected: PASS. Two things to check by reading, not just the run: every `fail(...)` text names a secret, a sink, a key or a path and never `value`; and every branch of `run` that changes the file goes through `change`.

- [ ] **Step 6: Lint and typecheck**

Run: `bun run typecheck && bun run lint`
Expected: exit 0. `delete applied[id]` in `syncSinks` is on a plain record the service owns; if oxlint flags it, rebuild the record with `Object.fromEntries` instead.

- [ ] **Step 7: Commit**

```bash
git add src/core/sinksync.ts src/secrets/service.ts src/secrets/service.test.ts
git commit -m "$(printf 'feat(secrets): the service, its gated acts, proposals and the mini sinks\n\nClaude-Session: https://claude.ai/code/session_01DEgdKaVhnhcGveC62zKQJh')"
```

---

### Task 10: The service's socket, its entry, and canopy's client

**Files:**
- Create: `src/secrets/main.ts`
- Create: `src/core/secretsclient.ts`
- Test: `src/secrets/main.test.ts`

**Interfaces:**
- Consumes: `SecretStore`, `storePaths` (Task 6); `Audit` (Task 6); `readApplied`, `writeApplied` (Task 6); `Gate` (Task 7); `miniSources`, `scanFiles` (Task 8); `SecretsService` (Task 9); `encodeLine`, `parseRequest`, `parseReply`, `LIMITS`, `SecretsRequest`, `SecretsReply` (Task 5); `AGE_RECIPIENT` (Task 2).
- Produces: `serviceEnv`, `serve`, `socketModes`, `DEFAULT_BREAKGLASS` (main.ts); `askSecrets`, `SECRETS_AWAY` (secretsclient.ts). Used by Tasks 12 and 15.

The service's environment carries paths, a gid, an origin and the break-glass public key. Nothing in it is secret, since a shell can read another container's environment through the shared pid namespace on canopy's side and the service keeps all its keys in files.

| Variable | Default | What |
|---|---|---|
| `CANOPY_SECRETS_SOCKET` | `/run/canopy-secrets/secrets.sock` | the socket |
| `CANOPY_SECRETS_CALLER_GID` | (required) | the group canopy reaches the socket with |
| `CANOPY_SECRETS_DATA` | `/data` | the secrets-data volume |
| `CANOPY_SECRETS_REMOTE` | (none: local only) | `ssh://git@<forgejo ssh host>/eric/secrets.git` |
| `CANOPY_SECRETS_ORIGIN` | `https://canopy.beric.ca` | the WebAuthn origin; its host is the rp id |
| `CANOPY_SECRETS_BREAKGLASS` | the spec's key | the break-glass recipient (public) |
| `CANOPY_SECRETS_SINK_ROOTS` | `/opt/stacks` | `:`-separated folders the service writes sinks in |
| `CANOPY_SECRETS_STACKS` | `/opt/stacks` | where the import looks for stacks |
| `CANOPY_SECRETS_IMPORT` | `/import/canopy.env` | `:`-separated extra dotenv files to import |

- [ ] **Step 1: Write the failing tests**

Create `src/secrets/main.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { connect } from "node:net";
import { join } from "node:path";
import { askSecrets, SECRETS_AWAY } from "../core/secretsclient";
import { LIMITS, type SecretsReply, type SecretsRequest } from "../core/secretwire";
import { DEFAULT_BREAKGLASS, serve, serviceEnv, socketModes } from "./main";

describe("serviceEnv", () => {
  test("defaults around the one required variable", () => {
    const e = serviceEnv({ CANOPY_SECRETS_CALLER_GID: "7851" });
    if ("refused" in e) throw new Error(e.refused);
    expect(e).toMatchObject({
      socket: "/run/canopy-secrets/secrets.sock",
      callerGid: 7851,
      data: "/data",
      remote: null,
      origin: "https://canopy.beric.ca",
      rpID: "canopy.beric.ca",
      gateUrl: "https://canopy.beric.ca/?view=secrets",
      breakglass: DEFAULT_BREAKGLASS,
      sinkRoots: ["/opt/stacks"],
      extra: ["/import/canopy.env"],
    });
  });

  test.each([
    [{}, "CANOPY_SECRETS_CALLER_GID"],
    [{ CANOPY_SECRETS_CALLER_GID: "0" }, "CANOPY_SECRETS_CALLER_GID"],
    [{ CANOPY_SECRETS_CALLER_GID: "7851", CANOPY_SECRETS_ORIGIN: "http://canopy.beric.ca" }, "https"],
    [{ CANOPY_SECRETS_CALLER_GID: "7851", CANOPY_SECRETS_BREAKGLASS: "age1short" }, "BREAKGLASS"],
    [{ CANOPY_SECRETS_CALLER_GID: "7851", CANOPY_SECRETS_SINK_ROOTS: "relative" }, "SINK_ROOTS"],
  ])("refuses %p", (env, words) => {
    const e = serviceEnv(env as Record<string, string>);
    expect("refused" in e ? e.refused : "").toContain(words);
  });
});

test("socketModes: the folder root:gid 0750, the socket root:gid 0660", async () => {
  const calls: string[] = [];
  const fs = { chown: async (p: string, u: number, g: number) => void calls.push(`chown ${p} ${u}:${g}`), chmod: async (p: string, m: number) => void calls.push(`chmod ${p} ${m.toString(8)}`) };
  await socketModes("/run/s", "/run/s/x.sock", 7851, fs);
  expect(calls).toEqual(["chown /run/s 0:7851", "chmod /run/s 750", "chown /run/s/x.sock 0:7851", "chmod /run/s/x.sock 660"]);
});

describe("the socket", () => {
  let dir = "";
  let socket = "";
  let seen: SecretsRequest[] = [];
  let close = () => {};
  beforeEach(async () => {
    // short: a unix socket path has a 104-byte limit on macOS
    dir = await mkdtemp("/tmp/cs-");
    socket = join(dir, "s.sock");
    seen = [];
    const handle = async (r: SecretsRequest): Promise<SecretsReply> => {
      seen.push(r);
      return { ok: true, data: { t: r.t } };
    };
    const server = await serve({ handle }, socket);
    close = () => server.close();
  });
  afterEach(async () => {
    close();
    await rm(dir, { recursive: true, force: true });
  });

  test("one request, one reply", async () => {
    expect(await askSecrets(socket, { t: "info", token: null })).toEqual({ ok: true, data: { t: "info" } });
    expect(seen).toEqual([{ t: "info", token: null }]);
  });

  test("a line that is not a request is answered with an error and never handled", async () => {
    const reply = await new Promise<string>((resolve) => {
      const c = connect(socket);
      let buf = "";
      c.setEncoding("utf8");
      c.on("connect", () => c.write('{"t":"dump"}\n'));
      c.on("data", (d: string) => (buf += d));
      c.on("close", () => resolve(buf));
    });
    expect(JSON.parse(reply)).toEqual({ ok: false, error: "unknown request dump" });
    expect(seen).toEqual([]);
  });

  test("a line over the limit is cut off", async () => {
    const reply = await new Promise<string>((resolve) => {
      const c = connect(socket);
      let buf = "";
      c.setEncoding("utf8");
      c.on("connect", () => c.write("x".repeat(LIMITS.line + 10)));
      c.on("data", (d: string) => (buf += d));
      c.on("close", () => resolve(buf));
      c.on("error", () => resolve(buf));
    });
    expect(reply).toContain("too long");
  });

  test("no service: the client says so", async () => {
    expect(await askSecrets(join(dir, "none.sock"), { t: "info", token: null })).toEqual({ ok: false, error: SECRETS_AWAY });
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `bun test src/secrets/main.test.ts`
Expected: FAIL, missing modules.

- [ ] **Step 3: Write the client**

Create `src/core/secretsclient.ts`:

```ts
/**
 * canopy's side of the secrets service's socket: one request line out, one
 * reply line back, then the connection closes. A service that is down or
 * slow is one answer, SECRETS_AWAY, so the page can say so.
 */

import { connect } from "node:net";
import { encodeLine, LIMITS, parseReply, type SecretsReply, type SecretsRequest } from "./secretwire";

export const SECRETS_AWAY = "the secrets service is not answering";

export function askSecrets(socket: string, req: SecretsRequest, timeoutMs = 15_000): Promise<SecretsReply> {
  return new Promise((resolve) => {
    let buf = "";
    let settled = false;
    const sock = connect(socket);
    const done = (r: SecretsReply): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      sock.destroy();
      resolve(r);
    };
    const timer = setTimeout(() => done({ ok: false, error: SECRETS_AWAY }), timeoutMs);
    sock.setEncoding("utf8");
    sock.on("connect", () => sock.write(encodeLine(req)));
    sock.on("data", (chunk: string) => {
      buf += chunk;
      if (buf.length > LIMITS.line * 2) return done({ ok: false, error: "the secrets service answered more than a reply holds" });
      const nl = buf.indexOf("\n");
      if (nl !== -1) done(parseReply(buf.slice(0, nl)) ?? { ok: false, error: "the secrets service answered something unreadable" });
    });
    sock.on("error", () => done({ ok: false, error: SECRETS_AWAY }));
    sock.on("close", () => done({ ok: false, error: SECRETS_AWAY }));
  });
}
```

- [ ] **Step 4: Write the entry**

Create `src/secrets/main.ts`:

```ts
/**
 * The secrets service (docs/superpowers/specs/2026-10-14-secrets-design.md),
 * bundled to /app/secrets-service.js by the Dockerfile's build stage and run
 * as root in a container of its own. It opens the store and the gate from
 * the secrets-data volume and answers one JSON line per connection on a
 * unix socket whose folder only the secretscaller group (canopy) enters.
 * `--health` asks the running service for its info and exits 0 when it
 * answers. Nothing secret comes in through the environment.
 */

import { chmod, chown, mkdir, rm } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { dirname } from "node:path";
import { readApplied, writeApplied } from "../core/applied";
import { AGE_RECIPIENT } from "../core/secretfile";
import { miniSources, scanFiles } from "../core/secretimport";
import { askSecrets } from "../core/secretsclient";
import { encodeLine, LIMITS, parseRequest, type SecretsReply, type SecretsRequest } from "../core/secretwire";
import { Audit } from "./audit";
import { Gate } from "./gate";
import { SecretsService } from "./service";
import { SecretStore, storePaths } from "./store";

/** the break-glass recipient from the spec; its identity is offline */
export const DEFAULT_BREAKGLASS = "age1xtc4cftnu55fn3enurt9jexnrenmru3w0xl93uz5q20e34mefs6stg2vra";

export interface ServiceEnv {
  socket: string;
  callerGid: number;
  data: string;
  remote: string | null;
  origin: string;
  rpID: string;
  gateUrl: string;
  breakglass: string;
  sinkRoots: string[];
  stacks: string;
  extra: string[];
}

const paths = (v: string): string[] => v.split(":").filter(Boolean);

export function serviceEnv(env: Record<string, string | undefined>): ServiceEnv | { refused: string } {
  const gid = env["CANOPY_SECRETS_CALLER_GID"] ?? "";
  if (!/^[1-9]\d{0,9}$/.test(gid)) return { refused: "CANOPY_SECRETS_CALLER_GID must be the group canopy reaches the socket with, set and not 0" };
  const origin = env["CANOPY_SECRETS_ORIGIN"] ?? "https://canopy.beric.ca";
  let rpID: string;
  try {
    const u = new URL(origin);
    if (u.protocol !== "https:" || u.origin !== origin) return { refused: "CANOPY_SECRETS_ORIGIN must be an exact https origin" };
    rpID = u.hostname;
  } catch {
    return { refused: "CANOPY_SECRETS_ORIGIN must be an exact https origin" };
  }
  const breakglass = env["CANOPY_SECRETS_BREAKGLASS"] ?? DEFAULT_BREAKGLASS;
  if (!AGE_RECIPIENT.test(breakglass)) return { refused: "CANOPY_SECRETS_BREAKGLASS is not an X25519 age recipient" };
  const sinkRoots = paths(env["CANOPY_SECRETS_SINK_ROOTS"] ?? "/opt/stacks");
  if (sinkRoots.length === 0 || sinkRoots.some((r) => !r.startsWith("/") || r.split("/").includes(".."))) return { refused: "CANOPY_SECRETS_SINK_ROOTS must be absolute folders" };
  return {
    socket: env["CANOPY_SECRETS_SOCKET"] ?? "/run/canopy-secrets/secrets.sock",
    callerGid: Number(gid),
    data: env["CANOPY_SECRETS_DATA"] ?? "/data",
    remote: env["CANOPY_SECRETS_REMOTE"] || null,
    origin,
    rpID,
    gateUrl: `${origin}/?view=secrets`,
    breakglass,
    sinkRoots,
    stacks: env["CANOPY_SECRETS_STACKS"] ?? "/opt/stacks",
    extra: paths(env["CANOPY_SECRETS_IMPORT"] ?? "/import/canopy.env"),
  };
}

/** The socket's folder root:gid 0750 and the socket root:gid 0660, set at
 *  every start (a volume keeps whatever it was first made with). The stage
 *  runner has the same rule; this copy keeps the service's bundle free of
 *  the runner's code. */
export async function socketModes(
  dir: string,
  socket: string | null,
  gid: number,
  fs: { chown: (p: string, uid: number, gid: number) => Promise<void>; chmod: (p: string, mode: number) => Promise<void> } = { chown, chmod },
): Promise<void> {
  await fs.chown(dir, 0, gid);
  await fs.chmod(dir, 0o750);
  if (socket === null) return;
  await fs.chown(socket, 0, gid);
  await fs.chmod(socket, 0o660);
}

/** one request line in, one reply line out, per connection */
export function serve(svc: { handle(r: SecretsRequest): Promise<SecretsReply> }, socket: string): Promise<Server> {
  const server = createServer((conn) => {
    let buf = "";
    let done = false;
    const reply = (r: SecretsReply): void => void conn.end(encodeLine(r));
    conn.setEncoding("utf8");
    conn.setTimeout(30_000, () => conn.destroy());
    conn.on("error", () => {});
    conn.on("data", (chunk: string) => {
      if (done) return;
      buf += chunk;
      const nl = buf.indexOf("\n");
      if (nl === -1 && buf.length <= LIMITS.line) return;
      done = true;
      if (nl === -1) return reply({ ok: false, error: "the request is too long" });
      const req = parseRequest(buf.slice(0, nl));
      if ("error" in req) return reply({ ok: false, error: req.error });
      svc.handle(req).then(reply, () => reply({ ok: false, error: "failed" }));
    });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socket, () => resolve(server));
  });
}

async function main(): Promise<void> {
  const env = serviceEnv(process.env);
  if ("refused" in env) {
    console.error(`secrets: ${env.refused}`);
    process.exit(2);
  }
  if (process.argv.includes("--health")) {
    const r = await askSecrets(env.socket, { t: "info", token: null }, 4_000);
    process.exit(r.ok ? 0 : 1);
  }
  const log = (line: string): void => console.log(line);
  if (process.getuid?.() !== 0) log("secrets: not root; sink files keep this user as owner and /opt/stacks may be unreadable");
  const p = storePaths(env.data);
  const store = await SecretStore.open({ data: env.data, remote: env.remote, breakglass: env.breakglass, log });
  const gate = await Gate.open({ file: p.passkeys, rpID: env.rpID, origin: env.origin, log });
  const svc = new SecretsService({
    store,
    gate,
    audit: new Audit(p.audit),
    machine: "mini",
    gateUrl: env.gateUrl,
    sinkRoots: env.sinkRoots,
    applied: { read: () => readApplied(p.applied), write: (a) => writeApplied(p.applied, a) },
    scan: async () => (await scanFiles(await miniSources(env.stacks, env.extra))).found,
    log,
  });
  await svc.tick();
  await mkdir(dirname(env.socket), { recursive: true });
  await rm(env.socket, { force: true });
  await socketModes(dirname(env.socket), null, env.callerGid);
  const server = await serve(svc, env.socket);
  await socketModes(dirname(env.socket), env.socket, env.callerGid);
  log(`secrets: listening on ${env.socket}`);
  const sync = setInterval(() => void svc.tick().catch((err: unknown) => log(`secrets: sink sync failed: ${err instanceof Error ? err.message : "failed"}`)), 60_000);
  const push = setInterval(() => void (store.unpushed > 0 ? store.push() : Promise.resolve()), 5 * 60_000);
  const stop = (): void => {
    clearInterval(sync);
    clearInterval(push);
    server.close();
    process.exit(0);
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}

if (import.meta.main) {
  main().catch((err: unknown) => {
    // the message only: a stack can quote what it failed on
    console.error(`secrets: ${err instanceof Error ? err.message : "failed to start"}`);
    process.exit(1);
  });
}
```

- [ ] **Step 5: Run the tests**

Run: `bun test src/secrets/main.test.ts`
Expected: PASS.

- [ ] **Step 6: Bundle it**

Run: `bun build src/secrets/main.ts --target=bun --outfile /tmp/secrets-service.js && grep -c "sweepCodexTrust\|stageSettingsRefusal" /tmp/secrets-service.js; rm /tmp/secrets-service.js`
Expected: the build succeeds and the count is 0: none of the stage runner's code is in the service's bundle.

- [ ] **Step 7: Lint and typecheck**

Run: `bun run typecheck && bun run lint`
Expected: exit 0.

- [ ] **Step 8: Commit**

```bash
git add src/secrets/main.ts src/secrets/main.test.ts src/core/secretsclient.ts
git commit -m "$(printf 'feat(secrets): the service socket, its entry and canopy client\n\nClaude-Session: https://claude.ai/code/session_01DEgdKaVhnhcGveC62zKQJh')"
```

---

### Task 11: The reader: pulled copy, Mac key and Mac sinks

**Files:**
- Create: `src/core/secretlocal.ts`
- Test: `src/core/secretlocal.test.ts`

**Interfaces:**
- Consumes: `configDir` (`src/core/store.ts`); `exec`; `readApplied`, `writeApplied` (Task 6); `newIdentity`, `sealProposal`, `unwrapIdentity`, `wrapIdentity` (Task 3); `metaList`, `parseSecretFile`, `verifyFile` (Task 2); `scanFiles`, `ImportSource` (Task 8); `readKeys`, `repoRefusal` (Task 4); `syncSink`, `waitingState`, `FILE_IO`, `SinkIO`, `SinkState` (Task 9); `LIMITS` (Task 5).
- Produces: `localPaths`, `LocalConfig`, `PIN`, `readLocalConfig`, `writeLocalConfig`, `SecretsReader` (`start`, `pull`, `lock`, `unlock`, `lockNow`, `createKey`, `recipient`, `syncSinks`, `proposals`, `take`, `info`). Used by Tasks 12 and 13.

Files in canopy's config dir (`~/.config/canopy` on the Mac):

```
secrets/                 the read-only checkout of eric/secrets
secrets-config.json      {"pin": "<mini signing key, base64>", "remote": "<Forgejo URL>"}
secrets-key.age          this machine's age identity under its passphrase (age scrypt), 0600
secrets-applied.json     sink id -> key -> rotation stamp last written, 0600
```

The checkout starts as `git init` plus a remote, not a clone, so `HEAD` is only ever a commit this reader verified: a fast-forward of the last good one whose `secrets.json` the pinned key signed. A failed attempt sets `refused` and leaves `HEAD` and the in-memory file where they were. A wrong passphrase costs two more seconds per attempt in a row.

- [ ] **Step 1: Write the failing tests**

Create `src/core/secretlocal.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newIdentity, newSigningKey, openProposal, sealValue, signingKey } from "./secretcrypt";
import { emptyFile, serializeFile, signFile, type SecretFile } from "./secretfile";
import { localPaths, SecretsReader, writeLocalConfig } from "./secretlocal";

const BREAKGLASS = "age1xtc4cftnu55fn3enurt9jexnrenmru3w0xl93uz5q20e34mefs6stg2vra";
const STAMP = "2026-10-14T12:00:00.000Z";
const V = "fixture-value-0x5eed";

let dir = "";
let remote = "";
let work = "";
let waits: number[] = [];
const run = (cwd: string, ...args: string[]) => {
  const r = Bun.spawnSync(["git", "-C", cwd, "-c", "user.name=t", "-c", "user.email=t@t", ...args]);
  if (r.exitCode !== 0) throw new Error(r.stderr.toString());
  return r.stdout.toString().trim();
};

async function publish(f: SecretFile, key: CryptoKey, msg = "change", force = false): Promise<void> {
  await writeFile(join(work, "secrets.json"), serializeFile(await signFile(f, key, "mini")));
  run(work, "add", "secrets.json");
  run(work, "commit", "-qm", msg);
  run(work, "push", "-q", ...(force ? ["-f"] : []), "origin", "HEAD:main");
}

async function reader(sources: string[] = [], roots: string[] = []): Promise<SecretsReader> {
  const r = new SecretsReader({
    paths: localPaths(join(dir, "config")),
    machine: "mac",
    gateUrl: "https://canopy.beric.ca/?view=secrets",
    sources: () => sources.map((path) => ({ path, kind: "dotenv" as const })),
    repoRoots: () => roots,
    sleep: async (ms) => void waits.push(ms),
    scryptLogN: 10,
    log: () => {},
  });
  await r.start();
  return r;
}

let signer: CryptoKey;
let pin = "";

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "canopy-reader-"));
  remote = join(dir, "remote.git");
  work = join(dir, "work");
  waits = [];
  Bun.spawnSync(["git", "init", "-q", "--bare", "-b", "main", remote]);
  Bun.spawnSync(["git", "init", "-q", "-b", "main", work]);
  run(work, "remote", "add", "origin", remote);
  const k = await newSigningKey();
  signer = await signingKey(k.privateB64);
  pin = k.publicB64;
  await mkdir(join(dir, "config"), { recursive: true });
  await writeLocalConfig(localPaths(join(dir, "config")).config, { pin, remote });
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const base = async (): Promise<SecretFile> => {
  const mini = await newIdentity();
  const f = emptyFile({ mini: mini.recipient, breakglass: BREAKGLASS });
  f.secrets["cf_token"] = { description: "dns", tags: [], created: STAMP, rotated: STAMP, to: ["breakglass", "mini"], allow: [], value: await sealValue("cf_token", V, STAMP, [mini.recipient]) };
  return f;
};

describe("pulling", () => {
  test("takes a signed fast-forward and lists names without values", async () => {
    await publish(await base(), signer);
    const r = await reader();
    const info = r.info("mac");
    expect(info.ok).toBe(true);
    expect(info.head).toMatch(/^[0-9a-f]{7,}$/);
    expect(info.secrets.map((s) => s.name)).toEqual(["cf_token"]);
    expect(JSON.stringify(info)).not.toContain(V);
    expect(JSON.stringify(info)).not.toContain("BEGIN AGE");
  });

  test("refuses a commit another key signed, and keeps the last good one", async () => {
    const f = await base();
    await publish(f, signer);
    const r = await reader();
    const good = r.head;
    const other = await signingKey((await newSigningKey()).privateB64);
    await publish({ ...f, secrets: {} }, other, "forged");
    await r.pull();
    expect(r.head).toBe(good);
    expect(r.refused).toContain("not signed by the pinned mini key");
    expect(r.info("mac").secrets.map((s) => s.name)).toEqual(["cf_token"]);
  });

  test("refuses one changed byte of metadata committed without a new signature", async () => {
    await publish(await base(), signer);
    const r = await reader();
    const text = (await readFile(join(work, "secrets.json"), "utf8")).replace('"dns"', '"dnz"');
    await writeFile(join(work, "secrets.json"), text);
    run(work, "commit", "-qam", "hand edit");
    run(work, "push", "-q", "origin", "HEAD:main");
    await r.pull();
    expect(r.refused).toContain("not signed");
    expect(r.info("mac").secrets[0]?.description).toBe("dns");
  });

  test("refuses a history that is not a fast-forward", async () => {
    const f = await base();
    await publish(f, signer, "one");
    const r = await reader();
    await publish({ ...f, secrets: {} }, signer, "two");
    await r.pull();
    const two = r.head;
    run(work, "reset", "-q", "--hard", "HEAD~1");
    // a different file (another mini key), so the rewrite is a real commit
    await publish(await base(), signer, "rewritten", true);
    await r.pull();
    expect(r.head).toBe(two);
    expect(r.refused).toContain("not a fast-forward");
  });

  test("with nothing pinned, it says what to run", async () => {
    await writeLocalConfig(localPaths(join(dir, "config")).config, { pin: null, remote: null });
    const r = await reader();
    expect(r.info("mac").error).toContain("canopy secrets pin");
  });
});

describe("the Mac's key", () => {
  test("create, lock, wrong passphrases cost two more seconds each, then unlock", async () => {
    await publish(await base(), signer);
    const r = await reader();
    expect(r.lock()).toBe("none");
    expect(await r.createKey("short", false)).toMatchObject({ error: expect.stringContaining("12") });
    const made = await r.createKey("correct horse battery", false);
    expect("recipient" in made).toBe(true);
    expect(r.lock()).toBe("open");
    expect(await r.createKey("correct horse battery", false)).toMatchObject({ error: expect.stringContaining("has a key") });
    r.lockNow();
    expect(r.lock()).toBe("locked");
    expect(await r.unlock("wrong one")).toEqual({ ok: false, error: "wrong passphrase" });
    expect(await r.unlock("wrong two")).toEqual({ ok: false, error: "wrong passphrase" });
    expect(await r.unlock("correct horse battery")).toEqual({ ok: true });
    expect(waits).toEqual([2000, 4000]);
    expect(r.lock()).toBe("open");
    const wrapped = await readFile(localPaths(join(dir, "config")).identity, "utf8");
    expect(wrapped).toContain("BEGIN AGE ENCRYPTED FILE");
    expect(wrapped).not.toContain("AGE-SECRET-KEY");
  });
});

describe("the Mac's sinks", () => {
  test("written when unlocked, waiting and untouched when locked, refused inside a repo git does not ignore", async () => {
    const r0 = await reader();
    const made = await r0.createKey("correct horse battery", false);
    if (!("recipient" in made)) throw new Error(made.error);
    const mini = await newIdentity();
    const f = emptyFile({ mini: mini.recipient, mac: made.recipient, breakglass: BREAKGLASS });
    f.secrets["cf_token"] = { description: "", tags: [], created: STAMP, rotated: STAMP, to: ["breakglass", "mac", "mini"], allow: ["sink:laptop", "sink:inrepo"], value: await sealValue("cf_token", V, STAMP, [mini.recipient, made.recipient]) };
    const sinkPath = join(dir, "app.env");
    const repo = join(dir, "repo");
    await mkdir(repo);
    Bun.spawnSync(["git", "init", "-q", repo]);
    f.sinks["laptop"] = { machine: "mac", path: sinkPath, format: "dotenv", keys: { CF_TOKEN: "cf_token" } };
    f.sinks["inrepo"] = { machine: "mac", path: join(repo, "config.env"), format: "dotenv", keys: { CF_TOKEN: "cf_token" } };
    await publish(f, signer);
    await writeFile(sinkPath, "KEEP=1\n");

    const r = await reader([], [repo]);
    expect(r.info("mac").sinks.find((s) => s.id === "laptop")?.state).toEqual({ CF_TOKEN: "waiting" });
    expect(await readFile(sinkPath, "utf8")).toBe("KEEP=1\n");

    expect(await r.unlock("correct horse battery")).toEqual({ ok: true });
    expect(await readFile(sinkPath, "utf8")).toBe(`KEEP=1\nCF_TOKEN=${V}\n`);
    const sinks = r.info("mac").sinks;
    expect(sinks.find((s) => s.id === "laptop")?.state).toEqual({ CF_TOKEN: "same" });
    expect(sinks.find((s) => s.id === "inrepo")?.error).toContain("does not ignore");
  });
});

describe("proposals", () => {
  test("found values and a take are sealed to the mini alone", async () => {
    const mini = await newIdentity();
    const f = emptyFile({ mini: mini.recipient, breakglass: BREAKGLASS });
    f.secrets["cf_token"] = { description: "", tags: [], created: STAMP, rotated: STAMP, to: ["breakglass", "mini"], allow: ["sink:laptop"], value: await sealValue("cf_token", V, STAMP, [mini.recipient]) };
    const sinkPath = join(dir, "app.env");
    f.sinks["laptop"] = { machine: "mac", path: sinkPath, format: "dotenv", keys: { CF_TOKEN: "cf_token" } };
    await publish(f, signer);
    await writeFile(join(dir, "dev.env"), "OPENAI_API_KEY=sk-1\n");
    await writeFile(sinkPath, "CF_TOKEN=by-hand\n");
    const r = await reader([join(dir, "dev.env"), join(dir, "gone.env")]);
    const p = await r.proposals();
    if ("error" in p) throw new Error(p.error);
    expect(p.missing).toEqual([join(dir, "gone.env")]);
    const one = p.items[0];
    if (!one) throw new Error("no proposal");
    expect(one.sealed).not.toContain("sk-1");
    expect(await openProposal(one.sealed, mini.identity, one)).toBe("sk-1");
    const take = await r.take("laptop", "CF_TOKEN");
    if ("error" in take) throw new Error(take.error);
    expect(take.merges).toBe("cf_token");
    expect(await openProposal(take.sealed, mini.identity, take)).toBe("by-hand");
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `bun test src/core/secretlocal.test.ts`
Expected: FAIL, `Cannot find module './secretlocal'`.

- [ ] **Step 3: Write the reader**

Create `src/core/secretlocal.ts`:

```ts
/**
 * A backend that is not the secrets writer (the Mac today): a read-only
 * checkout of eric/secrets in canopy's config dir, moved only by a
 * fast-forward whose newest secrets.json the pinned mini key signed; any
 * other commit is refused and the last good one stays. On a machine with
 * its own age key, the key is wrapped by a passphrase and held in memory
 * only after an unlock; the reader then writes this machine's sinks, and
 * seals import proposals and "take this value" to the mini's key for the
 * mini's page to approve. Locked, the sinks keep their contents.
 */

import { chmod, readFile, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { identityToRecipient } from "age-encryption";
import { readApplied, writeApplied } from "./applied";
import { exec, type ExecResult } from "./exec";
import { newIdentity, sealProposal, unwrapIdentity, wrapIdentity } from "./secretcrypt";
import { metaList, parseSecretFile, verifyFile, type SecretFile } from "./secretfile";
import { scanFiles, type ImportSource } from "./secretimport";
import { LIMITS } from "./secretwire";
import { readKeys, repoRefusal } from "./sinks";
import { FILE_IO, syncSink, waitingState, type SinkIO, type SinkState } from "./sinksync";
import { configDir } from "./store";
import type { SecretKeyState, SecretProposalIn, SecretsInfo } from "./types";

export const localPaths = (dir: string = configDir()) => ({
  checkout: join(dir, "secrets"),
  config: join(dir, "secrets-config.json"),
  identity: join(dir, "secrets-key.age"),
  applied: join(dir, "secrets-applied.json"),
});

export interface LocalConfig {
  /** the mini's signing key, raw ed25519, base64 */
  pin: string | null;
  /** Forgejo's URL for eric/secrets, as this machine's git reaches it */
  remote: string | null;
}

/** a raw ed25519 public key in base64: 32 bytes */
export const PIN = /^[A-Za-z0-9+/]{43}=$/;

export async function readLocalConfig(path: string): Promise<LocalConfig> {
  try {
    const v = JSON.parse(await readFile(path, "utf8")) as Partial<Record<keyof LocalConfig, unknown>>;
    return { pin: typeof v.pin === "string" && PIN.test(v.pin) ? v.pin : null, remote: typeof v.remote === "string" && v.remote ? v.remote : null };
  } catch {
    return { pin: null, remote: null };
  }
}

export async function writeLocalConfig(path: string, c: LocalConfig): Promise<void> {
  const tmp = `${path}.tmp-${process.pid}`;
  await writeFile(tmp, `${JSON.stringify(c, null, 2)}\n`, { mode: 0o600 });
  await rename(tmp, path);
}

export interface ReaderOptions {
  paths: ReturnType<typeof localPaths>;
  /** this machine's name in the file */
  machine: string;
  gateUrl: string;
  /** this machine's import sources */
  sources: () => ImportSource[];
  /** the scanned repos: a sink inside one must be ignored there */
  repoRoots: () => readonly string[];
  io?: SinkIO;
  sleep?: (ms: number) => Promise<void>;
  /** scrypt's work factor for a new key: 18 unless a test lowers it */
  scryptLogN?: number;
  log: (line: string) => void;
}

const exists = (p: string): Promise<boolean> => stat(p).then(() => true, () => false);
const firstLine = (s: string): string => s.trim().split("\n")[0] ?? "";

export class SecretsReader {
  file: SecretFile | null = null;
  head: string | null = null;
  refused: string | null = null;
  error: string | null = null;
  private ident: string | null = null;
  private hasKey = false;
  private failures = 0;
  private sinkState: Record<string, SinkState> = {};
  private pulling: Promise<void> | null = null;
  private readonly io: SinkIO;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly o: ReaderOptions) {
    this.io = o.io ?? FILE_IO;
    this.sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  async start(): Promise<void> {
    this.hasKey = await exists(this.o.paths.identity);
    await this.pull();
  }

  private git(args: string[]): Promise<ExecResult> {
    return exec(["git", "-C", this.o.paths.checkout, ...args], { timeoutMs: 60_000, env: { GIT_TERMINAL_PROMPT: "0" } });
  }

  /** one pull at a time; a second caller waits for the first */
  pull(): Promise<void> {
    this.pulling ??= this.pullNow().finally(() => {
      this.pulling = null;
    });
    return this.pulling;
  }

  private async pullNow(): Promise<void> {
    const cfg = await readLocalConfig(this.o.paths.config);
    if (!cfg.pin || !cfg.remote) {
      this.error = "no mini signing key pinned yet; run canopy secrets pin <key> --remote <url>";
      return;
    }
    this.error = null;
    if (!(await exists(join(this.o.paths.checkout, ".git")))) {
      const r = await exec(["git", "init", "-q", "-b", "main", this.o.paths.checkout]);
      if (r.code !== 0) {
        this.error = `the checkout could not be made: ${firstLine(r.stderr)}`;
        return;
      }
      await this.git(["remote", "add", "origin", cfg.remote]);
    } else {
      await this.git(["remote", "set-url", "origin", cfg.remote]);
    }
    if (!this.file) await this.loadHead(cfg.pin);
    const fetched = await this.git(["fetch", "-q", "origin", "main"]);
    if (fetched.code !== 0) {
      this.error = `Forgejo did not answer: ${firstLine(fetched.stderr)}`;
      return;
    }
    const tip = (await this.git(["rev-parse", "--short", "origin/main"])).stdout.trim();
    if (tip === this.head) return;
    if (this.head && (await this.git(["merge-base", "--is-ancestor", "HEAD", "origin/main"])).code !== 0) {
      this.refused = `Forgejo's main (${tip}) does not follow ${this.head}: not a fast-forward, so ${this.head} stays`;
      this.o.log(`secrets: ${this.refused}`);
      return;
    }
    const shown = await this.git(["show", "origin/main:secrets.json"]);
    const parsed = shown.code === 0 ? parseSecretFile(shown.stdout) : { error: "origin/main has no secrets.json" };
    if ("error" in parsed || !(await verifyFile(parsed.file, cfg.pin))) {
      const why = "error" in parsed ? `does not parse (${parsed.error})` : "is not signed by the pinned mini key";
      this.refused = `the newest commit (${tip}) ${why}; ${this.head ?? "nothing"} stays`;
      this.o.log(`secrets: ${this.refused}`);
      return;
    }
    const moved = this.head ? await this.git(["merge", "-q", "--ff-only", "origin/main"]) : await this.git(["checkout", "-q", "-B", "main", "origin/main"]);
    if (moved.code !== 0) {
      this.error = `the checkout did not move: ${firstLine(moved.stderr)}`;
      return;
    }
    this.file = parsed.file;
    this.head = tip;
    this.refused = null;
    await this.syncSinks();
  }

  /** the last good commit, read again after a restart (and verified again) */
  private async loadHead(pin: string): Promise<void> {
    const shown = await this.git(["show", "HEAD:secrets.json"]);
    if (shown.code !== 0) return;
    const parsed = parseSecretFile(shown.stdout);
    if ("error" in parsed || !(await verifyFile(parsed.file, pin))) {
      this.error = "the local checkout's secrets.json fails the pinned key; delete the checkout folder and let canopy fetch it again";
      return;
    }
    this.file = parsed.file;
    this.head = (await this.git(["rev-parse", "--short", "HEAD"])).stdout.trim();
  }

  lock(): "open" | "locked" | "none" {
    if (this.ident) return "open";
    return this.hasKey ? "locked" : "none";
  }

  async unlock(passphrase: string): Promise<{ ok: true } | { ok: false; error: string }> {
    if (this.failures > 0) await this.sleep(this.failures * 2000);
    let armored: string;
    try {
      armored = await readFile(this.o.paths.identity, "utf8");
    } catch {
      return { ok: false, error: "no key for this machine yet; create one first" };
    }
    try {
      this.ident = await unwrapIdentity(armored, passphrase);
    } catch {
      this.failures += 1;
      return { ok: false, error: "wrong passphrase" };
    }
    this.failures = 0;
    await this.syncSinks();
    return { ok: true };
  }

  /** forget the identity; the sinks keep their contents */
  lockNow(): void {
    this.ident = null;
    void this.syncSinks();
  }

  async createKey(passphrase: string, replace: boolean): Promise<{ recipient: string } | { error: string }> {
    if (passphrase.length < 12) return { error: "use a passphrase of at least 12 characters" };
    if (this.hasKey && !replace) return { error: "this machine has a key; replace it only when its passphrase is lost" };
    const { identity, recipient } = await newIdentity();
    const wrapped = await wrapIdentity(identity, passphrase, this.o.scryptLogN ?? 18);
    const tmp = `${this.o.paths.identity}.tmp-${process.pid}`;
    await writeFile(tmp, wrapped, { mode: 0o600 });
    await chmod(tmp, 0o600);
    await rename(tmp, this.o.paths.identity);
    this.hasKey = true;
    this.ident = identity;
    this.failures = 0;
    return { recipient };
  }

  /** this machine's recipient, while unlocked */
  async recipient(): Promise<string | null> {
    return this.ident ? identityToRecipient(this.ident) : null;
  }

  async syncSinks(): Promise<void> {
    const f = this.file;
    if (!f) return;
    const applied = await readApplied(this.o.paths.applied);
    const state: Record<string, SinkState> = {};
    for (const [id, sink] of Object.entries(f.sinks)) {
      if (sink.machine !== this.o.machine) continue;
      if (!this.ident) {
        state[id] = waitingState(sink);
        continue;
      }
      state[id] = await syncSink(f, id, sink, this.ident, applied, this.io, await repoRefusal(sink.path, this.o.repoRoots()));
    }
    if (this.ident) await writeApplied(this.o.paths.applied, Object.fromEntries(Object.entries(applied).filter(([id]) => state[id])));
    this.sinkState = state;
  }

  /** this machine's sources, each value sealed to the mini alone */
  async proposals(): Promise<{ items: SecretProposalIn[]; missing: string[] } | { error: string }> {
    const mini = this.file?.keys["mini"];
    if (!mini) return { error: "no verified secrets.json here yet, so no mini key to seal to" };
    const { found, missing } = await scanFiles(this.o.sources());
    const items: SecretProposalIn[] = [];
    for (const x of found) {
      if (items.length >= LIMITS.proposals) break;
      // a value too large to seal under the proposal cap is left for a hand entry
      if (x.value !== null && x.value.length > LIMITS.sealed / 2) continue;
      const ref = { from: this.o.machine, source: x.source, key: x.key };
      items.push({ ...ref, sealed: x.value === null ? "" : await sealProposal(ref, x.value, mini), merges: null });
    }
    return { items, missing };
  }

  /** a drifted sink key's file value, sealed to the mini as an update of its secret */
  async take(id: string, key: string): Promise<SecretProposalIn | { error: string }> {
    const f = this.file;
    const sink = f?.sinks[id];
    const name = sink?.keys[key];
    const mini = f?.keys["mini"];
    if (!f || !sink || !name || !mini) return { error: `sink ${id} has no key ${key}` };
    if (sink.machine !== this.o.machine) return { error: `sink ${id} lives on ${sink.machine}` };
    const read = await this.io.read(sink.path);
    if ("error" in read) return read;
    if (read.text === null) return { error: `${sink.path} does not exist` };
    const have = readKeys(read.text, sink.format, [key]);
    if ("error" in have) return { error: `${sink.path}: ${have.error}` };
    const value = have.values[key];
    if (!value) return { error: `${sink.path} has no ${key}` };
    const ref = { from: this.o.machine, source: sink.path, key };
    return { ...ref, sealed: await sealProposal(ref, value, mini), merges: name };
  }

  info(backend: string): SecretsInfo {
    const f = this.file;
    const sinks = f
      ? Object.keys(f.sinks)
          .sort()
          .flatMap((id) => {
            const k = f.sinks[id];
            if (!k) return [];
            const own = k.machine === this.o.machine;
            const state: Record<string, SecretKeyState> = own
              ? (this.sinkState[id]?.state ?? {})
              : k.machine === "gpd" && this.o.machine === "mac"
                ? Object.fromEntries(Object.keys(k.keys).map((key) => [key, "phase 3" as const]))
                : {};
            return [{ id, machine: k.machine, path: k.path, format: k.format, keys: { ...k.keys }, state, error: own ? (this.sinkState[id]?.error ?? null) : null }];
          })
      : [];
    return {
      ok: f !== null,
      error: this.error ?? (f ? null : "no verified secrets.json here yet"),
      backend,
      role: "reader",
      head: this.head,
      refused: this.refused,
      lock: this.lock(),
      secrets: f ? metaList(f) : [],
      sinks,
      proposals: [],
      passkeys: [],
      session: false,
      firstPasskey: false,
      gate: this.o.gateUrl,
      unpushed: 0,
    };
  }
}
```

- [ ] **Step 4: Run the tests**

Run: `bun test src/core/secretlocal.test.ts`
Expected: PASS. The tests use scrypt's work factor 10 so key creation stays fast.

- [ ] **Step 5: Lint and typecheck**

Run: `bun run typecheck && bun run lint`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/core/secretlocal.ts src/core/secretlocal.test.ts
git commit -m "$(printf 'feat(secrets): the verified read-only copy, the Mac key and the Mac sinks\n\nClaude-Session: https://claude.ai/code/session_01DEgdKaVhnhcGveC62zKQJh')"
```

---

### Task 12: canopy's routes: relay on the mini, reader elsewhere

**Files:**
- Create: `src/server/secrets.ts`
- Test: `src/server/secrets.test.ts`
- Modify: `src/server/index.ts` (five anchored insertions)

**Interfaces:**
- Consumes: `askSecrets`, `SECRETS_AWAY` (Task 10); `parseAct`, `parseProposals`, `PASSKEY`, `SecretsRequest`, `SecretsReply` (Task 5); `SecretsReader`, `localPaths` (Task 11); `macSources` (Task 8); `SecretsInfo`, `ServerEvent` (Task 1).
- Produces: `SecretsHub` (`start`, `stop`, `handle`, `info`), `createSecretsHub`, `COOKIE`, `tokenFrom`, `sessionCookie`, `clearCookie`, `gateOriginOk`, `sameOriginOk`. Used by Tasks 13, 14 and 16.

Routes. Every answer carries `cache-control: no-store`.

| Route | Writer (the mini) | Reader (every other backend) |
|---|---|---|
| `GET /api/secrets` | the service's info, `session` from the cookie | the verified copy's info |
| `GET /api/secrets/audit` | the service's audit log | 404 naming the gate page |
| `POST /api/secrets/gate/begin` `{kind, code}` | gate origin only | 404 |
| `POST /api/secrets/gate/finish` `{kind, code, response, label}` | gate origin only; a login sets the cookie, the body never holds the token | 404 |
| `POST /api/secrets/logout` | gate origin only; clears the cookie | 404 |
| `POST /api/secrets/act` `{act}` | gate origin only; 401 `{error, gate: "passkey"}` without a session | 404 |
| `POST /api/secrets/proposals` `{items}` | any origin the general gate lets in, capped by `parseProposals` | 404 |
| `POST /api/secrets/pull` | 404 | pull now |
| `POST /api/secrets/scan` | 404 | this machine's sources, sealed to the mini |
| `POST /api/secrets/take` `{id, key}` | 404 | one drifted key, sealed to the mini |
| `POST /api/secrets/unlock` `{passphrase}`, `/lock`, `/key` `{passphrase, replace}` | 404 | same origin or a loopback caller only |

The cookie is `canopy_secrets=<token>; Path=/api/secrets; HttpOnly; Secure; SameSite=Strict; Max-Age=3600`. The service ends the session at 15 idle minutes or an hour, so the cookie can outlive it and then reads as no session. No 401 here ever carries a `login` field: `ui/src/api.ts` starts the Cloudflare sign-in flow on a 401 whose body has a string `login`, and the passkey gate is not that.

- [ ] **Step 1: Write the failing tests**

Create `src/server/secrets.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import type { SecretsReader } from "../core/secretlocal";
import type { SecretsReply, SecretsRequest } from "../core/secretwire";
import type { SecretsInfo, ServerEvent } from "../core/types";
import { clearCookie, gateOriginOk, sameOriginOk, SecretsHub, sessionCookie, tokenFrom } from "./secrets";

const GATE = "https://canopy.beric.ca";
const TOKEN = "a".repeat(43);
const V = "fixture-value-0x5eed";

function writer(answer: (r: SecretsRequest) => SecretsReply = () => ({ ok: true, data: {} })) {
  const asked: SecretsRequest[] = [];
  const events: ServerEvent[] = [];
  const hub = new SecretsHub({
    backend: "mini",
    socket: "/run/canopy-secrets/secrets.sock",
    gateOrigin: GATE,
    reader: null,
    broadcast: (e) => events.push(e),
    ask: async (r) => {
      asked.push(r);
      return answer(r);
    },
  });
  return { hub, asked, events };
}

const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  new Request(`http://127.0.0.1:7850${path}`, { method: "POST", headers: { "content-type": "application/json", origin: GATE, "sec-fetch-site": "same-origin", ...headers }, body: JSON.stringify(body) });
const call = async (hub: SecretsHub, req: Request): Promise<Response> => {
  const r = await hub.handle(req, new URL(req.url));
  if (!r) throw new Error("not handled");
  return r;
};

describe("cookies", () => {
  test("the session cookie is HttpOnly, Secure, SameSite=Strict and scoped to the secrets routes", () => {
    expect(sessionCookie(TOKEN, 3600)).toBe(`canopy_secrets=${TOKEN}; Path=/api/secrets; HttpOnly; Secure; SameSite=Strict; Max-Age=3600`);
    expect(clearCookie()).toContain("Max-Age=0");
  });

  test("tokenFrom reads only a well-formed token", () => {
    expect(tokenFrom(new Request("http://x/", { headers: { cookie: `a=1; canopy_secrets=${TOKEN}` } }))).toBe(TOKEN);
    expect(tokenFrom(new Request("http://x/", { headers: { cookie: "canopy_secrets=short" } }))).toBeNull();
    expect(tokenFrom(new Request("http://x/"))).toBeNull();
  });

  test("origin rules", () => {
    expect(gateOriginOk(post("/api/secrets/act", {}), GATE)).toBe(true);
    expect(gateOriginOk(post("/api/secrets/act", {}, { origin: "http://mac.tail:7850" }), GATE)).toBe(false);
    expect(gateOriginOk(post("/api/secrets/act", {}, { "sec-fetch-site": "cross-site" }), GATE)).toBe(false);
    const own = new Request("http://127.0.0.1:7850/api/secrets/unlock", { method: "POST", headers: { origin: "http://127.0.0.1:7850" } });
    expect(sameOriginOk(own)).toBe(true);
    expect(sameOriginOk(new Request("http://127.0.0.1:7850/api/secrets/unlock", { method: "POST" }))).toBe(true);
    expect(sameOriginOk(new Request("http://mac.tail:7850/api/secrets/unlock", { method: "POST" }))).toBe(false);
    expect(sameOriginOk(new Request("http://127.0.0.1:7850/api/secrets/unlock", { method: "POST", headers: { origin: GATE } }))).toBe(false);
  });
});

describe("the writer relays", () => {
  test("an act without a session is a 401 with the passkey gate and no login field", async () => {
    const { hub } = writer(() => ({ ok: false, error: "open the passkey gate first", gate: "passkey" }));
    const r = await call(hub, post("/api/secrets/act", { act: { a: "reveal", name: "cf_token" } }));
    expect(r.status).toBe(401);
    const body = (await r.json()) as Record<string, unknown>;
    expect(body).toEqual({ error: "open the passkey gate first", gate: "passkey" });
    expect("login" in body).toBe(false);
    expect(r.headers.get("set-cookie")).toContain("Max-Age=0");
  });

  test("a login sets the cookie and the body never holds the token", async () => {
    const { hub } = writer((q) => (q.t === "finish" ? { ok: true, data: { token: TOKEN, maxAgeS: 3600 } } : { ok: true, data: {} }));
    const r = await call(hub, post("/api/secrets/gate/finish", { kind: "login", response: { id: "c" } }));
    expect(r.status).toBe(200);
    expect(r.headers.get("set-cookie")).toBe(sessionCookie(TOKEN, 3600));
    expect(await r.text()).not.toContain(TOKEN);
    expect(r.headers.get("cache-control")).toBe("no-store");
  });

  test("an act carries the cookie's token down the socket", async () => {
    const { hub, asked } = writer((q) => (q.t === "act" ? { ok: true, data: { value: V, hideAfterMs: 20000 } } : { ok: true, data: {} }));
    const r = await call(hub, post("/api/secrets/act", { act: { a: "reveal", name: "cf_token" } }, { cookie: `canopy_secrets=${TOKEN}` }));
    expect(await r.json()).toEqual({ value: V, hideAfterMs: 20000 });
    expect(asked[0]).toEqual({ t: "act", token: TOKEN, act: { a: "reveal", name: "cf_token" } });
  });

  test("a gated route from another origin never reaches the socket", async () => {
    const { hub, asked } = writer();
    const r = await call(hub, post("/api/secrets/act", { act: { a: "reveal", name: "cf_token" } }, { origin: "http://mac.tail:7850", cookie: `canopy_secrets=${TOKEN}` }));
    expect(r.status).toBe(403);
    expect(asked).toEqual([]);
  });

  test("a bad act is refused before the socket", async () => {
    const { hub, asked } = writer();
    expect((await call(hub, post("/api/secrets/act", { act: { a: "get-all" } }))).status).toBe(400);
    expect(asked).toEqual([]);
  });

  test("proposals come from any allowed page, capped", async () => {
    const { hub, asked } = writer();
    const one = { from: "mac", source: "/Users/e/dev/.env", key: "A", sealed: "", merges: null };
    const big = Array.from({ length: 201 }, () => one);
    expect((await call(hub, post("/api/secrets/proposals", { items: big }, { origin: "http://mac.tail:7850" }))).status).toBe(400);
    expect((await call(hub, post("/api/secrets/proposals", { items: [one] }, { origin: "http://mac.tail:7850" }))).status).toBe(200);
    expect(asked.map((q) => q.t)).toEqual(["propose", "info"]);
  });

  test("the info answers under this backend's name; the service down is a 200 with the reason", async () => {
    const { hub } = writer((q) => (q.t === "info" ? { ok: true, data: { ok: true, backend: "mini", secrets: [] } } : { ok: true, data: {} }));
    const r = await call(hub, new Request("http://127.0.0.1:7850/api/secrets"));
    expect(((await r.json()) as SecretsInfo).backend).toBe("mini");
    const down = writer(() => ({ ok: false, error: "the secrets service is not answering" }));
    const d = (await (await call(down.hub, new Request("http://127.0.0.1:7850/api/secrets"))).json()) as SecretsInfo;
    expect(d).toMatchObject({ ok: false, error: "the secrets service is not answering", role: "writer" });
  });
});

describe("a reader", () => {
  function reader() {
    const calls: string[] = [];
    const stub = {
      info: (b: string) => ({ ok: true, backend: b, role: "reader", secrets: [] }),
      unlock: async (p: string) => {
        calls.push(`unlock ${p.length}`);
        return p === "correct horse battery" ? { ok: true } : { ok: false, error: "wrong passphrase" };
      },
      lockNow: () => void calls.push("lock"),
      createKey: async () => ({ recipient: "age1x" }),
      pull: async () => void calls.push("pull"),
      proposals: async () => ({ items: [], missing: [] }),
      take: async () => ({ error: "no" }),
      start: async () => {},
    } as unknown as SecretsReader;
    const hub = new SecretsHub({ backend: "mac", socket: null, gateOrigin: GATE, reader: stub, broadcast: () => {} });
    return { hub, calls };
  }

  test("unlock answers only its own page or a loopback caller, and never echoes the passphrase", async () => {
    const { hub, calls } = reader();
    const foreign = new Request("http://127.0.0.1:7850/api/secrets/unlock", { method: "POST", headers: { origin: GATE }, body: JSON.stringify({ passphrase: "correct horse battery" }) });
    expect((await call(hub, foreign)).status).toBe(403);
    expect(calls).toEqual([]);
    const own = new Request("http://127.0.0.1:7850/api/secrets/unlock", { method: "POST", body: JSON.stringify({ passphrase: "correct horse battery" }) });
    const r = await call(hub, own);
    expect(r.status).toBe(200);
    expect(await r.text()).not.toContain("correct horse");
    const wrong = new Request("http://127.0.0.1:7850/api/secrets/unlock", { method: "POST", body: JSON.stringify({ passphrase: "nope" }) });
    const w = await call(hub, wrong);
    expect(w.status).toBe(403);
    expect(await w.text()).not.toContain("nope");
  });

  test("the writer's routes point at the gate page", async () => {
    const { hub } = reader();
    const r = await call(hub, new Request("http://127.0.0.1:7850/api/secrets/audit"));
    expect(r.status).toBe(404);
    expect(((await r.json()) as { error: string }).error).toContain(`${GATE}/?view=secrets`);
  });

  test("other paths are not this hub's", async () => {
    const { hub } = reader();
    expect(await hub.handle(new Request("http://127.0.0.1:7850/api/secretsx"), new URL("http://127.0.0.1:7850/api/secretsx"))).toBeNull();
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `bun test src/server/secrets.test.ts`
Expected: FAIL, `Cannot find module './secrets'`.

- [ ] **Step 3: Write the hub**

Create `src/server/secrets.ts`:

```ts
/**
 * The Secrets view's routes (docs/superpowers/specs/2026-10-14-secrets-design.md).
 * On the mini, where CANOPY_SECRETS_SOCKET is set, canopy only relays: each
 * request goes down the secrets service's socket, the session token rides
 * in an HttpOnly cookie, and the gated routes answer only the mini's own
 * page. canopy keeps no token, key or value between requests. Everywhere
 * else the routes read the verified copy (SecretsReader): the list, this
 * machine's key and lock (its own page or terminal only), and its import
 * values and takes, sealed to the mini for the mini's page to post.
 */

import { homedir } from "node:os";
import { macSources } from "../core/secretimport";
import { localPaths, SecretsReader } from "../core/secretlocal";
import { askSecrets, SECRETS_AWAY } from "../core/secretsclient";
import { parseAct, parseProposals, PASSKEY, type SecretsReply, type SecretsRequest } from "../core/secretwire";
import type { SecretsInfo, ServerEvent } from "../core/types";

export const COOKIE = "canopy_secrets";
/** 32 random bytes, base64url */
const TOKEN = /^[A-Za-z0-9_-]{43}$/;

const json = (body: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...headers } });

export function tokenFrom(req: Request): string | null {
  for (const part of (req.headers.get("cookie") ?? "").split(";")) {
    const at = part.indexOf("=");
    if (at === -1 || part.slice(0, at).trim() !== COOKIE) continue;
    const t = part.slice(at + 1).trim();
    return TOKEN.test(t) ? t : null;
  }
  return null;
}

export const sessionCookie = (token: string, maxAgeS: number): string =>
  `${COOKIE}=${token}; Path=/api/secrets; HttpOnly; Secure; SameSite=Strict; Max-Age=${Math.floor(maxAgeS)}`;

export const clearCookie = (): string => `${COOKIE}=; Path=/api/secrets; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;

/** a gated route answers only the mini's own page */
export function gateOriginOk(req: Request, gateOrigin: string): boolean {
  const site = req.headers.get("sec-fetch-site");
  return req.headers.get("origin") === gateOrigin && (site === null || site === "same-origin");
}

/** this machine's key answers only its own page, or a loopback caller with
 *  no Origin (the CLI) */
export function sameOriginOk(req: Request): boolean {
  const url = new URL(req.url);
  const site = req.headers.get("sec-fetch-site");
  if (site !== null && site !== "same-origin" && site !== "none") return false;
  const origin = req.headers.get("origin");
  if (origin === null) return ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  try {
    return new URL(origin).host === url.host;
  } catch {
    return false;
  }
}

const emptyInfo = (backend: string, gate: string, role: SecretsInfo["role"], error: string): SecretsInfo => ({
  ok: false,
  error,
  backend,
  role,
  head: null,
  refused: null,
  lock: "none",
  secrets: [],
  sinks: [],
  proposals: [],
  passkeys: [],
  session: false,
  firstPasskey: false,
  gate,
  unpushed: 0,
});

/** a service answer as a response; a closed gate is a 401 that is not a sign-in */
function reply(r: SecretsReply): Response {
  if (r.ok) return json(r.data ?? null);
  if (r.gate === PASSKEY) return json({ error: r.error, gate: PASSKEY }, 401, { "set-cookie": clearCookie() });
  return json({ error: r.error }, r.error === SECRETS_AWAY ? 503 : 400);
}

export interface SecretsHubDeps {
  /** this backend's name (`selfName`) */
  backend: string;
  /** the secrets service's socket: set on the writer only */
  socket: string | null;
  /** the page origin passkeys are bound to */
  gateOrigin: string;
  reader: SecretsReader | null;
  broadcast: (ev: ServerEvent) => void;
  ask?: (req: SecretsRequest) => Promise<SecretsReply>;
  pollMs?: number;
  pullMs?: number;
}

const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

export class SecretsHub {
  private timer: ReturnType<typeof setInterval> | null = null;
  private sent = "";
  private readonly ask: (req: SecretsRequest) => Promise<SecretsReply>;

  constructor(private readonly d: SecretsHubDeps) {
    this.ask = d.ask ?? ((req) => askSecrets(d.socket ?? "", req));
  }

  private get gateUrl(): string {
    return `${this.d.gateOrigin}/?view=secrets`;
  }

  start(): void {
    const r = this.d.reader;
    if (r) {
      void r.start().then(() => this.announce());
      this.timer = setInterval(() => void r.pull().then(() => this.announce()), this.d.pullMs ?? 5 * 60_000);
    } else if (this.d.socket) {
      void this.announce();
      this.timer = setInterval(() => void this.announce(), this.d.pollMs ?? 30_000);
    }
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async info(token: string | null): Promise<SecretsInfo> {
    if (this.d.reader) return this.d.reader.info(this.d.backend);
    const r = await this.ask({ t: "info", token });
    if (!r.ok) return emptyInfo(this.d.backend, this.gateUrl, "writer", r.error);
    return { ...(r.data as SecretsInfo), backend: this.d.backend };
  }

  /** the page hears of a change; every page gets the same, session-free info */
  private async announce(): Promise<void> {
    const info = await this.info(null).catch(() => null);
    if (!info) return;
    const text = JSON.stringify(info);
    if (text === this.sent) return;
    this.sent = text;
    this.d.broadcast({ type: "secrets", info });
  }

  async handle(req: Request, url: URL): Promise<Response | null> {
    const path = url.pathname;
    if (path !== "/api/secrets" && !path.startsWith("/api/secrets/")) return null;
    if (path === "/api/secrets" && req.method === "GET") return json(await this.info(tokenFrom(req)));
    const r = this.d.reader;
    return r ? this.readerRoute(req, path, r) : this.writerRoute(req, path);
  }

  private async writerRoute(req: Request, path: string): Promise<Response> {
    if (req.method === "GET" && path === "/api/secrets/audit") {
      const r = await this.ask({ t: "audit", limit: 200 });
      return r.ok ? json(r.data) : json({ error: r.error }, 503);
    }
    if (req.method !== "POST") return json({ error: "not found" }, 404);
    const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
    if (path === "/api/secrets/proposals") {
      const items = parseProposals(body?.["items"]);
      if ("error" in items) return json(items, 400);
      const r = await this.ask({ t: "propose", items });
      await this.announce();
      return reply(r);
    }
    if (!gateOriginOk(req, this.d.gateOrigin)) return json({ error: `gated actions answer only ${this.gateUrl}` }, 403);
    const token = tokenFrom(req);
    const kind = body?.["kind"];
    const code = str(body?.["code"]);
    switch (path) {
      case "/api/secrets/gate/begin":
        if (kind !== "login" && kind !== "register") return json({ error: "kind is login or register" }, 400);
        return reply(await this.ask({ t: "begin", kind, token, code }));
      case "/api/secrets/gate/finish": {
        if (kind !== "login" && kind !== "register") return json({ error: "kind is login or register" }, 400);
        const r = await this.ask({ t: "finish", kind, token, code, response: body?.["response"], label: str(body?.["label"]) ?? "" });
        await this.announce();
        if (!r.ok) return reply(r);
        const data = (r.data ?? {}) as { token?: unknown; maxAgeS?: unknown };
        if (typeof data.token === "string" && typeof data.maxAgeS === "number") return json({ ok: true }, 200, { "set-cookie": sessionCookie(data.token, data.maxAgeS) });
        return json({ ok: true });
      }
      case "/api/secrets/logout":
        if (token) await this.ask({ t: "logout", token });
        return json({ ok: true }, 200, { "set-cookie": clearCookie() });
      case "/api/secrets/act": {
        const act = parseAct(body?.["act"]);
        if ("error" in act) return json(act, 400);
        const r = await this.ask({ t: "act", token, act });
        if (r.ok && act.a !== "reveal") await this.announce();
        return reply(r);
      }
      default:
        return json({ error: "not found" }, 404);
    }
  }

  private async readerRoute(req: Request, path: string, r: SecretsReader): Promise<Response> {
    const elsewhere = json({ error: `gated actions live on ${this.gateUrl}` }, 404);
    if (req.method !== "POST") return elsewhere;
    const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
    switch (path) {
      case "/api/secrets/pull":
        await r.pull();
        await this.announce();
        return json(r.info(this.d.backend));
      case "/api/secrets/scan": {
        const p = await r.proposals();
        return "error" in p ? json(p, 409) : json(p);
      }
      case "/api/secrets/take": {
        const id = str(body?.["id"]);
        const key = str(body?.["key"]);
        if (!id || !key) return json({ error: "take needs a sink id and a key" }, 400);
        const t = await r.take(id, key);
        return "error" in t ? json(t, 400) : json(t);
      }
      case "/api/secrets/unlock":
      case "/api/secrets/lock":
      case "/api/secrets/key": {
        if (!sameOriginOk(req)) return json({ error: "this machine's key answers only its own page or its own terminal" }, 403);
        if (path === "/api/secrets/lock") {
          r.lockNow();
          await this.announce();
          return json({ ok: true });
        }
        const pass = str(body?.["passphrase"]) ?? "";
        if (path === "/api/secrets/unlock") {
          const u = await r.unlock(pass);
          await this.announce();
          return u.ok ? json({ ok: true }) : json({ error: u.error }, 403);
        }
        const k = await r.createKey(pass, body?.["replace"] === true);
        await this.announce();
        return "error" in k ? json(k, 409) : json(k);
      }
      default:
        return elsewhere;
    }
  }
}

/** the hub for this backend: the relay when the service's socket is set,
 *  else a reader of the pulled copy */
export function createSecretsHub(o: {
  backend: string;
  root: string;
  repoRoots: () => readonly string[];
  broadcast: (ev: ServerEvent) => void;
  env?: Record<string, string | undefined>;
}): SecretsHub {
  const env = o.env ?? process.env;
  const socket = env["CANOPY_SECRETS_SOCKET"] || null;
  const gateOrigin = env["CANOPY_SECRETS_ORIGIN"] ?? "https://canopy.beric.ca";
  const reader = socket
    ? null
    : new SecretsReader({
        paths: localPaths(),
        machine: o.backend,
        gateUrl: `${gateOrigin}/?view=secrets`,
        sources: () => macSources(homedir(), o.root),
        repoRoots: o.repoRoots,
        log: (line) => console.log(line),
      });
  return new SecretsHub({ backend: o.backend, socket, gateOrigin, reader, broadcast: o.broadcast });
}
```

- [ ] **Step 4: Run the hub's tests**

Run: `bun test src/server/secrets.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire it into the server**

In `src/server/index.ts`:

1. After the line `import { RepoHealth } from "./repohealth";` add:

```ts
import { createSecretsHub, type SecretsHub } from "./secrets";
```

2. In the `ServerState` interface, after the line `  health: HealthHub;` add:

```ts
  /** the Secrets view: the relay to the secrets service on the mini, the verified copy elsewhere */
  secrets: SecretsHub;
```

3. In the object literal that builds `state`, after the line `    layouts: new ScreenLayouts(),` add:

```ts
    // the same name as backendName below; the reader writes this machine's sinks by it
    secrets: createSecretsHub({
      backend: selfName(cfg.self, hostname()),
      root,
      repoRoots: () => state.result.repos.filter((r) => !r.host).map((r) => r.path),
      broadcast: (ev) => broadcast(state, ev),
    }),
```

4. In the route chain, after the line `  if (healthRes) return healthRes;` add:

```ts
  const secretsRes = await state.secrets.handle(req, url);
  if (secretsRes) return secretsRes;
```

5. After the line `  state.asks.start();` add:

```ts
  // a test server pulls nothing and asks no socket
  if (process.env["NODE_ENV"] !== "test") state.secrets.start();
```

6. In the returned `stop`, after the line `      state.health.stop();` add:

```ts
      state.secrets.stop();
```

If the kit plan added its own hub next to any of these anchors, put the secrets lines after the kit ones.

- [ ] **Step 6: Typecheck and run the server's tests**

Run: `bun run typecheck && bun test src/server/`
Expected: exit 0, PASS. A test that builds a `ServerState` by hand fails typecheck on the missing `secrets` field; give it `secrets: createSecretsHub({ backend: "test", root: "/tmp", repoRoots: () => [], broadcast: () => {}, env: {} })` and list the file in the task report.

- [ ] **Step 7: Lint**

Run: `bun run lint`
Expected: exit 0.

- [ ] **Step 8: Commit**

```bash
git add src/server/secrets.ts src/server/secrets.test.ts src/server/index.ts
git commit -m "$(printf 'feat(secrets): canopy relays to the service on the mini and reads the verified copy elsewhere\n\nClaude-Session: https://claude.ai/code/session_01DEgdKaVhnhcGveC62zKQJh')"
```

---

### Task 13: The CLI: list, status, unlock, pin, recover

**Files:**
- Create: `src/cli/secrets.ts`
- Test: `src/cli/secrets.test.ts`
- Modify: `src/cli/index.ts` (the `COMMANDS` set and the command switch)
- Modify: `src/core/help.ts` (the help text)

**Interfaces:**
- Consumes: `bold`, `dim`, `lichen`, `rust` (`src/cli/render.ts`); `newIdentity`, `newSigningKey`, `openValue`, `sealValue`, `signingKey` (Task 3); `parseSecretFile`, `recipientKeys`, `recipientsFor`, `serializeFile`, `signFile`, `verifyFile` (Task 2); `localPaths`, `PIN`, `readLocalConfig`, `writeLocalConfig` (Task 11); `SecretsInfo` (Task 1); the routes of Task 12.
- Produces: `secretsCommand`, `SECRETS_USAGE`, `listLines`, `statusLines`, `statusExit`, `recoverFile`, `breakglassIdentity`. Used by Task 16's docs.

There is no `get`. `unlock` reads the passphrase from the terminal without echo (or from stdin when it is not a terminal) and posts it to the home backend on loopback, which is the only non-page caller `sameOriginOk` lets in. `recover` runs offline on the machine that holds the break-glass identity and commits nothing.

- [ ] **Step 1: Write the failing tests**

Create `src/cli/secrets.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { newIdentity, newSigningKey, openValue, sealValue, signingKey } from "../core/secretcrypt";
import { emptyFile, serializeFile, signFile, verifyFile } from "../core/secretfile";
import type { SecretsInfo } from "../core/types";
import { breakglassIdentity, listLines, recoverFile, statusExit, statusLines } from "./secrets";

const STAMP = "2026-10-14T12:00:00.000Z";
const V = "fixture-value-0x5eed";

const info = (over: Partial<SecretsInfo> = {}): SecretsInfo => ({
  ok: true,
  error: null,
  backend: "mac",
  role: "reader",
  head: "abc1234",
  refused: null,
  lock: "locked",
  secrets: [{ name: "cf_token", description: "dns edits", tags: ["dns"], created: STAMP, rotated: STAMP, to: ["breakglass", "mini"], allow: ["sink:dns"], usedBy: ["dns"] }],
  sinks: [{ id: "dns", machine: "mac", path: "/Users/e/x/.env", format: "dotenv", keys: { CF_TOKEN: "cf_token" }, state: { CF_TOKEN: "drift" }, error: null }],
  proposals: [],
  passkeys: [],
  session: false,
  firstPasskey: false,
  gate: "https://canopy.beric.ca/?view=secrets",
  unpushed: 0,
  ...over,
});

describe("lines", () => {
  test("the list names, dates, tags and users, and no value", () => {
    const text = listLines(info()).join("\n");
    expect(text).toContain("cf_token");
    expect(text).toContain("2026-10-14");
    expect(text).toContain("#dns");
    expect(text).toContain("dns edits");
  });

  test("the status names the lock, the commit, drift, and a refusal", () => {
    const text = statusLines(info({ refused: "the newest commit (def5678) is not signed by the pinned mini key; abc1234 stays" })).join("\n");
    expect(text).toContain("abc1234");
    expect(text).toContain("canopy secrets unlock");
    expect(text).toContain("CF_TOKEN drift");
    expect(text).toContain("not signed");
  });

  test("status exits 1 on a refusal, a sink error or drift, 0 otherwise", () => {
    expect(statusExit(info())).toBe(1);
    expect(statusExit(info({ sinks: [] }))).toBe(0);
    expect(statusExit(info({ sinks: [], refused: "x" }))).toBe(1);
    expect(statusExit(info({ ok: false, sinks: [] }))).toBe(1);
  });
});

test("breakglassIdentity finds the key line in an age identity file", () => {
  expect(breakglassIdentity("# created: today\n# public key: age1...\nAGE-SECRET-KEY-1ABC\n")).toBe("AGE-SECRET-KEY-1ABC");
  expect(breakglassIdentity("nothing here")).toBeNull();
});

describe("recoverFile", () => {
  test("opens every value with the break-glass key, reseals to a new mini key, and signs with a new key", async () => {
    const breakglass = await newIdentity();
    const oldMini = await newIdentity();
    const mac = await newIdentity();
    const oldSigner = await signingKey((await newSigningKey()).privateB64);
    const f = emptyFile({ mini: oldMini.recipient, mac: mac.recipient, breakglass: breakglass.recipient });
    f.secrets["cf_token"] = { description: "", tags: [], created: STAMP, rotated: STAMP, to: ["breakglass", "mac", "mini"], allow: ["sink:laptop"], value: await sealValue("cf_token", V, STAMP, [breakglass.recipient, mac.recipient, oldMini.recipient]) };
    f.sinks["laptop"] = { machine: "mac", path: "/Users/e/x/.env", format: "dotenv", keys: { CF: "cf_token" } };
    const r = await recoverFile(serializeFile(await signFile(f, oldSigner, "mini")), breakglass.identity);
    if ("error" in r) throw new Error(r.error);
    expect(r.file.keys["mini"]).toBe(r.recipient);
    expect(r.file.keys["mini"]).not.toBe(oldMini.recipient);
    expect(r.file.keys["mac"]).toBe(mac.recipient);
    expect(await verifyFile(r.file, r.signing.publicB64)).toBe(true);
    const e = r.file.secrets["cf_token"];
    expect(await openValue(e?.value ?? "", r.identity, { name: "cf_token", rotated: STAMP })).toBe(V);
    expect(await openValue(e?.value ?? "", mac.identity, { name: "cf_token", rotated: STAMP })).toBe(V);
    await expect(openValue(e?.value ?? "", oldMini.identity, { name: "cf_token", rotated: STAMP })).rejects.toThrow();
  });

  test("names the secret the break-glass key cannot open, and no value", async () => {
    const breakglass = await newIdentity();
    const other = await newIdentity();
    const f = emptyFile({ mini: other.recipient, breakglass: breakglass.recipient });
    f.secrets["cf_token"] = { description: "", tags: [], created: STAMP, rotated: STAMP, to: ["breakglass", "mini"], allow: [], value: await sealValue("cf_token", V, STAMP, [other.recipient]) };
    const r = await recoverFile(serializeFile(f), breakglass.identity);
    expect("error" in r ? r.error : "").toContain("cf_token");
    expect("error" in r ? r.error : "").not.toContain(V);
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `bun test src/cli/secrets.test.ts`
Expected: FAIL, `Cannot find module './secrets'`.

- [ ] **Step 3: Write the command**

Create `src/cli/secrets.ts`:

```ts
/**
 * `canopy secrets`: the list, the status, unlocking this machine's key,
 * pinning the mini's signing key, and the break-glass recovery. There is no
 * `get`: a value leaves the store through the mini's page or a sink. The
 * lines and the recovery are pure enough to test (secrets.test.ts).
 */

import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { newIdentity, newSigningKey, openValue, sealValue, signingKey } from "../core/secretcrypt";
import { parseSecretFile, recipientKeys, recipientsFor, serializeFile, signFile, type SecretFile } from "../core/secretfile";
import { localPaths, PIN, readLocalConfig, writeLocalConfig } from "../core/secretlocal";
import type { SecretsInfo } from "../core/types";
import { bold, dim, lichen, rust } from "./render";

export const SECRETS_USAGE = `usage: canopy secrets [list] [--json]
       canopy secrets status [--json]
       canopy secrets unlock
       canopy secrets pin <signing key> [--remote URL]
       canopy secrets recover <checkout> --breakglass FILE --out DIR
  list, status and unlock speak to the home backend ($CANOPY_API, else 127.0.0.1:7850);
  unlock only from the machine itself
  pin keeps the mini's public signing key (and Forgejo's URL) in this machine's canopy config
  recover opens every value with the break-glass identity, puts a new mini key and signing key in DIR,
  reseals and signs secrets.json in the checkout, and prints the new public halves; it commits nothing
  there is no get: a value leaves the store through the mini's page or a sink`;

export function listLines(info: SecretsInfo): string[] {
  if (!info.ok) return [rust(`secrets: ${info.error ?? "unavailable"}`)];
  if (info.secrets.length === 0) return [dim("no secrets yet")];
  const w = Math.max(...info.secrets.map((s) => s.name.length));
  return info.secrets.map((s) => {
    const tags = s.tags.map((t) => `#${t}`).join(" ");
    const users = s.usedBy.length > 0 ? `  ${dim(`into ${s.usedBy.join(", ")}`)}` : "";
    const about = s.description ? `  ${dim(s.description)}` : "";
    return `${bold(s.name.padEnd(w))}  ${dim(s.rotated.slice(0, 10))}  ${tags}${users}${about}`;
  });
}

const LOCK_WORD: Record<SecretsInfo["lock"], string> = {
  open: "this machine's key is open",
  locked: "this machine's key is locked: run canopy secrets unlock",
  none: "no key on this machine",
};

export function statusLines(info: SecretsInfo): string[] {
  const out = [`${bold(info.backend)}: ${info.role === "writer" ? "the writer" : "a verified copy"}, commit ${info.head ?? "none"}`];
  if (info.error) out.push(rust(info.error));
  if (info.refused) out.push(rust(`refused: ${info.refused}`));
  out.push(LOCK_WORD[info.lock]);
  if (info.unpushed > 0) out.push(lichen(`${info.unpushed} commit${info.unpushed === 1 ? "" : "s"} waiting for Forgejo`));
  if (info.firstPasskey) out.push(lichen("no passkey yet: the first-passkey code is in the secrets service's log"));
  for (const s of info.sinks) {
    const keys = Object.entries(s.state);
    if (keys.length === 0 && !s.error) continue;
    const words = keys.map(([k, st]) => (st === "drift" ? rust(`${k} drift`) : `${k} ${st}`)).join(", ");
    out.push(`sink ${s.id} (${s.machine}) ${dim(s.path)}: ${words}${s.error ? ` ${rust(s.error)}` : ""}`);
  }
  if (info.proposals.length > 0) out.push(`${info.proposals.length} import proposal${info.proposals.length === 1 ? "" : "s"} waiting on ${info.gate}`);
  return out;
}

export const statusExit = (info: SecretsInfo): number =>
  !info.ok || info.refused !== null || info.sinks.some((s) => s.error !== null || Object.values(s.state).includes("drift")) ? 1 : 0;

/** the AGE-SECRET-KEY line of an age identity file */
export function breakglassIdentity(text: string): string | null {
  return text.split("\n").map((l) => l.trim()).find((l) => l.startsWith("AGE-SECRET-KEY-1")) ?? null;
}

/** Every value opened with the break-glass identity and sealed again under
 *  a new mini key, the file signed by a new signing key. The old signature
 *  is not checked: a recovery is for when that key is gone. */
export async function recoverFile(
  text: string,
  breakglass: string,
): Promise<{ file: SecretFile; identity: string; recipient: string; signing: { privateB64: string; publicB64: string } } | { error: string }> {
  const parsed = parseSecretFile(text);
  if ("error" in parsed) return parsed;
  const mini = await newIdentity();
  const signing = await newSigningKey();
  const next: SecretFile = { ...parsed.file, keys: { ...parsed.file.keys, mini: mini.recipient }, secrets: { ...parsed.file.secrets }, signature: null };
  for (const [name, e] of Object.entries(parsed.file.secrets)) {
    let value: string;
    try {
      value = await openValue(e.value, breakglass, { name, rotated: e.rotated });
    } catch (err) {
      return { error: err instanceof Error ? err.message : `${name} does not open` };
    }
    const to = recipientsFor(next, name);
    const keyed = recipientKeys(next, to);
    if ("missing" in keyed) return { error: `${name} needs the ${keyed.missing.join(", ")} key in the file` };
    next.secrets[name] = { ...e, to, value: await sealValue(name, value, e.rotated, keyed.keys) };
  }
  return { file: await signFile(next, await signingKey(signing.privateB64), "mini"), identity: mini.identity, recipient: mini.recipient, signing };
}

/** a line from the terminal with no echo, or stdin's first line when piped */
async function readHidden(prompt: string): Promise<string> {
  const stdin = process.stdin;
  if (!stdin.isTTY) return ((await Bun.stdin.text()).split("\n")[0] ?? "").replace(/\r$/, "");
  process.stderr.write(prompt);
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding("utf8");
  return new Promise((resolve, reject) => {
    let buf = "";
    const done = (): void => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.off("data", onData);
      process.stderr.write("\n");
    };
    const onData = (chunk: string): void => {
      for (const c of chunk) {
        if (c === "\r" || c === "\n") {
          done();
          resolve(buf);
          return;
        }
        if (c === "\u0003") {
          done();
          reject(new Error("cancelled"));
          return;
        }
        buf = c === "\u007f" || c === "\b" ? buf.slice(0, -1) : buf + c;
      }
    };
    stdin.on("data", onData);
  });
}

function take(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i === -1) return undefined;
  const [, value] = args.splice(i, 2);
  return value;
}

export interface SecretsDeps {
  fail: (msg: string) => never;
}

export async function secretsCommand(argv: string[], { fail }: SecretsDeps): Promise<void> {
  const args = [...argv];
  const home = (process.env["CANOPY_API"] ?? "http://127.0.0.1:7850").replace(/\/+$/, "");
  const asJson = args.includes("--json");
  const rest = args.filter((a) => a !== "--json");
  const sub = rest[0] ?? "list";
  const ask = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    let r: Response;
    try {
      r = await fetch(home + path, body === undefined ? { method } : { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    } catch {
      return fail(`${home} did not answer`);
    }
    const text = await r.text();
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      return fail(`${home} answered ${r.status} with something other than JSON`);
    }
    if (!r.ok) return fail((v as { error?: string }).error ?? `${home} answered ${r.status}`);
    return v as T;
  };

  switch (sub) {
    case "list":
    case "status": {
      const info = await ask<SecretsInfo>("GET", "/api/secrets");
      if (asJson) console.log(JSON.stringify(sub === "list" ? info.secrets : info, null, 2));
      else console.log((sub === "list" ? listLines(info) : statusLines(info)).join("\n"));
      if (sub === "status") process.exitCode = statusExit(info);
      return;
    }
    case "unlock": {
      const pass = await readHidden("passphrase for this machine's secrets key: ");
      await ask("POST", "/api/secrets/unlock", { passphrase: pass });
      console.log("unlocked; this machine's sinks are written now");
      return;
    }
    case "pin": {
      const key = rest[1];
      if (!key || !PIN.test(key)) return fail("the signing key is the 44-character base64 key the secrets service prints at its start");
      const remote = take(rest, "--remote");
      const p = localPaths();
      await mkdir(dirname(p.config), { recursive: true });
      const cur = await readLocalConfig(p.config);
      await writeLocalConfig(p.config, { pin: key, remote: remote ?? cur.remote });
      console.log(`pinned the mini's signing key; Forgejo: ${remote ?? cur.remote ?? "not set, add --remote URL"}`);
      // a pull now, when the home backend runs; the pin stands either way
      const info = await fetch(`${home}/api/secrets/pull`, { method: "POST" })
        .then((r) => (r.ok ? (r.json() as Promise<SecretsInfo>) : null))
        .catch(() => null);
      if (info) console.log(statusLines(info).join("\n"));
      return;
    }
    case "recover": {
      const checkout = rest[1];
      const bgFile = take(rest, "--breakglass");
      const out = take(rest, "--out");
      if (!checkout || !bgFile || !out) return fail(SECRETS_USAGE);
      const identity = breakglassIdentity(await readFile(bgFile, "utf8"));
      if (!identity) return fail(`${bgFile} holds no AGE-SECRET-KEY line`);
      const r = await recoverFile(await readFile(join(checkout, "secrets.json"), "utf8"), identity);
      if ("error" in r) return fail(`recovery stopped: ${r.error}`);
      await mkdir(out, { recursive: true, mode: 0o700 });
      for (const [name, text, mode] of [
        ["mini.age", `${r.identity}\n`, 0o400],
        ["signing.key", `${r.signing.privateB64}\n`, 0o400],
        ["signing.pub", `${r.signing.publicB64}\n`, 0o444],
      ] as const) {
        await writeFile(join(out, name), text, { mode, flag: "wx" });
        await chmod(join(out, name), mode);
      }
      await writeFile(join(checkout, "secrets.json"), serializeFile(r.file));
      console.log(
        [
          `new mini recipient   ${r.recipient}`,
          `new signing key      ${r.signing.publicB64}`,
          "",
          "next:",
          `  1. put ${out}/mini.age, signing.key and signing.pub in the secrets-data volume's keys/ folder, replacing the old ones`,
          `  2. commit and push ${checkout}/secrets.json to eric/secrets from this machine`,
          "  3. restart the secrets service; it fast-forwards to that commit",
          `  4. on every other backend: canopy secrets pin ${r.signing.publicB64}`,
          "  5. if the volume was lost, the service prints a first-passkey code: register a passkey again",
          `  6. delete ${out} once the files are in place`,
        ].join("\n"),
      );
      return;
    }
    default:
      return fail(SECRETS_USAGE);
  }
}
```

- [ ] **Step 4: Run the tests**

Run: `bun test src/cli/secrets.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire the command**

In `src/cli/index.ts`:

1. After the line `import { healthCommand } from "./health";` add:

```ts
import { secretsCommand } from "./secrets";
```

2. In the `COMMANDS` set, after the line `  "health",` add:

```ts
  "secrets",
```

3. After the two lines

```ts
    case "health":
      return healthCommand(args, { fail });
```

add:

```ts
    case "secrets":
      return secretsCommand(args, { fail });
```

In `src/core/help.ts`, after the line `  canopy health rm <repo> <name>     take one of canopy's checks away` add:

```
  canopy secrets [list] [--json]     the secret store's names, tags, rotation dates and sinks; never a value
  canopy secrets status [--json]     this backend's copy: commit, refusals, the key's lock, sink drift; exit 1 on drift
  canopy secrets unlock              unlock this machine's key (asks for its passphrase); its sinks are written then
  canopy secrets pin <key> [--remote URL]   trust the mini's signing key, and where to pull eric/secrets from
  canopy secrets recover <checkout> --breakglass FILE --out DIR
                                     rebuild the mini's keys from the break-glass identity; commits nothing
```

- [ ] **Step 6: Gates for the task**

Run: `bun run typecheck && bun run lint && bun test src/cli/`
Expected: exit 0, PASS.

- [ ] **Step 7: Commit**

```bash
git add src/cli/secrets.ts src/cli/secrets.test.ts src/cli/index.ts src/core/help.ts
git commit -m "$(printf 'feat(secrets): canopy secrets list, status, unlock, pin and recover\n\nClaude-Session: https://claude.ai/code/session_01DEgdKaVhnhcGveC62zKQJh')"
```

---

### Task 14: The secrets view

**Files:**
- Create: `ui/src/secrets.ts`, `ui/src/components/Secrets.tsx`
- Test: `ui/src/secrets.test.ts`, `ui/src/secrets.api.test.ts`
- Modify: `ui/src/api.ts`, `ui/src/store.ts`, `ui/src/App.tsx`, `ui/src/cli.ts`, `ui/src/cli.test.ts`, `ui/src/styles.css`

**Interfaces:**
- Consumes: the routes of Task 12; `SecretAct` (Task 5); `SECRET_NAME`, `DOTENV_KEY`, `JSON_PATH` (Task 2, browser-safe); the types of Task 1; `startAuthentication`, `startRegistration` from `@simplewebauthn/browser` (Task 1).
- Produces: `api.secrets*` calls, the store's `secrets` record and `loadSecrets`, `SecretsView`, the `secrets` view and command-line verb. Used by Task 16's docs.

What the view does, and where:

- Every backend's info loads into `secrets[backend]`. The page shows home's.
- The gate page is `info.gate` (`https://canopy.beric.ca/?view=secrets`). Only there does the view offer the passkey prompt and the gated acts. Anywhere else it links there. `gateHere` decides, from the info and `window.location.origin`.
- On a reader page (the Mac), the bar holds this machine's key: unlock, lock, or make one. A new key's recipient shows once, to paste into the gate page's machine-key form.
- Drift on a mini sink offers both directions (`sink-write`, `take`) behind the session. Drift on a Mac sink offers "take": the Mac's backend seals the file's value to the mini (`/api/secrets/take`) and the page hands that to the mini's proposals. Overwriting a Mac file from the store is not in phase 1 (see "Not in this plan").
- An import scan on a reader page runs on that backend (`/api/secrets/scan`) and the page posts the sealed items to the writer. Approval happens on the gate page.
- A revealed value lives in component state for `hideAfterMs` (20 s) and is never logged, stored or put in a URL.

- [ ] **Step 1: Write the failing tests**

Create `ui/src/secrets.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import type { SecretMeta, SecretSinkInfo, SecretsInfo } from "../../src/core/types";
import { filterSecrets, gateHere, hostOf, isGateClosed, keysText, parseKeysText, sinkRows, tagsOf, writerOf } from "./secrets";

const info = (over: Partial<SecretsInfo> = {}): SecretsInfo => ({
  ok: true,
  error: null,
  backend: "mini",
  role: "writer",
  head: "abc1234",
  refused: null,
  lock: "none",
  secrets: [],
  sinks: [],
  proposals: [],
  passkeys: [],
  session: false,
  firstPasskey: false,
  gate: "https://canopy.beric.ca/?view=secrets",
  unpushed: 0,
  ...over,
});
const meta = (name: string, over: Partial<SecretMeta> = {}): SecretMeta => ({
  name,
  description: "",
  tags: [],
  created: "2026-10-14T00:00:00.000Z",
  rotated: "2026-10-14T00:00:00.000Z",
  to: ["mini", "mac"],
  allow: [],
  usedBy: [],
  ...over,
});
const sink = (id: string, machine: string, state: SecretSinkInfo["state"] = {}): SecretSinkInfo => ({
  id,
  machine,
  path: `/x/${id}/.env`,
  format: "dotenv",
  keys: { K: "k" },
  state,
  error: null,
});

describe("where the store and its gate are", () => {
  test("the writer is the backend whose info says so, in page order", () => {
    const all = { mac: info({ backend: "mac", role: "reader" }), mini: info() };
    expect(writerOf(all, ["mac", "mini"])).toBe("mini");
    expect(writerOf({ mac: all.mac }, ["mac", "mini"])).toBeNull();
  });

  test("gated actions are offered only on the writer's own gate origin", () => {
    expect(gateHere(info(), "https://canopy.beric.ca")).toBe(true);
    expect(gateHere(info(), "http://mini.tail:7850")).toBe(false);
    expect(gateHere(info({ role: "reader" }), "https://canopy.beric.ca")).toBe(false);
    expect(gateHere(undefined, "https://canopy.beric.ca")).toBe(false);
    expect(gateHere(info({ gate: "" }), "https://canopy.beric.ca")).toBe(false);
  });

  test("a closed gate is an error carrying status 401, nothing else", () => {
    expect(isGateClosed(Object.assign(new Error("open a passkey session"), { status: 401 }))).toBe(true);
    expect(isGateClosed(Object.assign(new Error("not here"), { status: 403 }))).toBe(false);
    expect(isGateClosed(new Error("401"))).toBe(false);
    expect(isGateClosed("401")).toBe(false);
  });

  test("hostOf names a gate page's host and survives an empty one", () => {
    expect(hostOf("https://canopy.beric.ca/?view=secrets")).toBe("canopy.beric.ca");
    expect(hostOf("")).toBe("");
  });
});

describe("the list", () => {
  const list = [meta("cf_token", { tags: ["cloudflare", "dns"], description: "DNS edit token" }), meta("immich_db", { tags: ["stacks"] }), meta("openai_key", { description: "Codex" })];

  test("tags are every tag once, sorted", () => {
    expect(tagsOf(list)).toEqual(["cloudflare", "dns", "stacks"]);
  });

  test("the filter reads name, description and tags, case aside", () => {
    expect(filterSecrets(list, "DNS", null).map((m) => m.name)).toEqual(["cf_token"]);
    expect(filterSecrets(list, "codex", null).map((m) => m.name)).toEqual(["openai_key"]);
    expect(filterSecrets(list, "", "stacks").map((m) => m.name)).toEqual(["immich_db"]);
    expect(filterSecrets(list, "token", "stacks")).toEqual([]);
    expect(filterSecrets(list, "  ", null)).toHaveLength(3);
  });
});

describe("sinks", () => {
  test("each sink takes its key states from the backend that owns it", () => {
    const all = {
      mini: info({ sinks: [sink("mac-env", "mac"), sink("immich", "mini", { K: "same" })] }),
      mac: info({ backend: "mac", role: "reader", sinks: [sink("mac-env", "mac", { K: "drift" }), sink("immich", "mini")] }),
    };
    const rows = sinkRows(all, ["mac", "mini"], "mini");
    expect(rows.map((r) => [r.sink.id, r.owner, r.sink.state["K"]])).toEqual([
      ["mac-env", "mac", "drift"],
      ["immich", "mini", "same"],
    ]);
  });

  test("with no writer answering, the first readable copy lists them, unowned when nobody reports", () => {
    const all = { mac: info({ backend: "mac", role: "reader", sinks: [sink("gpd-env", "gpd")] }) };
    expect(sinkRows(all, ["mac", "mini"], null)).toEqual([{ sink: sink("gpd-env", "gpd"), owner: null }]);
    expect(sinkRows({}, ["mac"], null)).toEqual([]);
  });

  test("the key editor reads one KEY=secret a line and checks both sides", () => {
    expect(parseKeysText("A_KEY=cf_token\n\n  DB = immich_db  ", "dotenv")).toEqual({ A_KEY: "cf_token", DB: "immich_db" });
    expect(parseKeysText("mcp.cloudflare.token=cf_token", "json")).toEqual({ "mcp.cloudflare.token": "cf_token" });
    expect(parseKeysText("no equals sign", "dotenv")).toEqual({ error: "line 1 has no =" });
    expect(parseKeysText("a.b=cf_token", "dotenv")).toEqual({ error: "line 1: a.b is not a dotenv key" });
    expect(parseKeysText("A=../x", "dotenv")).toEqual({ error: "line 1: ../x is not a secret name" });
    expect(parseKeysText("A=x\nA=y", "dotenv")).toEqual({ error: "line 2: A is mapped twice" });
  });

  test("keysText writes what parseKeysText reads", () => {
    const keys = { A_KEY: "cf_token", DB: "immich_db" };
    expect(parseKeysText(keysText(keys), "dotenv")).toEqual(keys);
  });
});
```

Create `ui/src/secrets.api.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { api, onBackendSignal } from "./api";
import type { BackendSignal } from "./backends";
import { setBase, setRegistry } from "./registry";
import { isGateClosed } from "./secrets";

describe("the secrets calls", () => {
  const realFetch = globalThis.fetch;
  interface Call {
    url: string;
    init: RequestInit | undefined;
  }
  let calls: Call[] = [];
  let signals: [string, BackendSignal][] = [];
  let reply: (c: Call) => Response = () => new Response("{}");

  beforeEach(() => {
    calls = [];
    signals = [];
    setRegistry("a", ["a", "b"]);
    setBase("b", "http://b.test");
    onBackendSignal((b, sig) => signals.push([b, sig]));
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const c = { url: String(url), init };
      calls.push(c);
      return reply(c);
    }) as unknown as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    setRegistry("", [""]);
    setBase("b", "");
    onBackendSignal(() => {});
  });

  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

  test("a closed passkey gate rejects with status 401 and never starts a sign-in", async () => {
    reply = () => json({ error: "open a passkey session first", gate: "passkey" }, 401);
    const err = await api.secretsAct("a", { a: "reveal", name: "cf_token" }).catch((e: unknown) => e);
    expect(isGateClosed(err)).toBe(true);
    expect(signals).toEqual([["a", { kind: "answered" }]]);
  });

  test("an act posts {act} to the backend named", async () => {
    reply = () => json(null);
    await api.secretsAct("a", { a: "edit", name: "cf_token", description: "DNS", tags: ["dns"] });
    expect(calls[0]?.url).toBe("/api/secrets/act");
    expect(calls[0]?.init?.method).toBe("POST");
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ act: { a: "edit", name: "cf_token", description: "DNS", tags: ["dns"] } });
  });

  test("proposals to another backend go to its origin with credentials", async () => {
    reply = () => json({ added: 1, dropped: 0 });
    const item = { from: "mac", source: "~/dev/x/.env", key: "K", sealed: "", merges: null };
    expect(await api.secretsPropose("b", [item])).toEqual({ added: 1, dropped: 0 });
    expect(calls[0]?.url).toBe("http://b.test/api/secrets/proposals");
    expect(calls[0]?.init?.credentials).toBe("include");
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ items: [item] });
  });

  test("a gate login posts kind and code, and the token never comes back in the body", async () => {
    reply = () => json({ ok: true });
    expect(await api.secretsFinish("a", "login", null, { id: "c" }, "")).toEqual({ ok: true });
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ kind: "login", code: null, response: { id: "c" }, label: "" });
  });
});
```

In `ui/src/cli.test.ts`, after the line `    expect(parse("health")).toEqual({ kind: "view", view: "health", sprout: null });` add:

```ts
    expect(parse("secrets")).toEqual({ kind: "view", view: "secrets", sprout: null });
```

- [ ] **Step 2: Run them to see them fail**

Run: `bun test ui/src/secrets.test.ts ui/src/secrets.api.test.ts ui/src/cli.test.ts`
Expected: FAIL (`./secrets` missing, `api.secretsAct` not a function, `parse("secrets")` not a view).

- [ ] **Step 3: Write the helpers**

Create `ui/src/secrets.ts`:

```ts
/* The secrets view's pure parts: which backend writes, whether this page is
   the gate, the list's filter, and the sinks with their owners' states.
   Nothing here ever sees a value. */

import { DOTENV_KEY, JSON_PATH, SECRET_NAME } from "../../src/core/secretfile";
import type { SecretKeyState, SecretMeta, SecretSinkFormat, SecretSinkInfo, SecretsInfo } from "../../src/core/types";

/** the backend whose info comes from the mini's service, in page order */
export function writerOf(all: Readonly<Record<string, SecretsInfo>>, order: readonly string[]): string | null {
  return order.find((b) => all[b]?.role === "writer") ?? null;
}

/** gated actions answer only on the writer's gate page (`info.gate`, a full
 *  URL), so the view offers them only on that page's origin */
export const gateHere = (info: SecretsInfo | undefined, origin: string): boolean => info?.role === "writer" && originOf(info.gate) === origin;

/** a 401 from the passkey gate: `req` puts the status on the error */
export function isGateClosed(e: unknown): boolean {
  return typeof e === "object" && e !== null && (e as { status?: unknown }).status === 401;
}

export const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return "";
  }
}

export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

export function tagsOf(list: readonly SecretMeta[]): string[] {
  return [...new Set(list.flatMap((m) => m.tags))].sort();
}

export function filterSecrets(list: readonly SecretMeta[], text: string, tag: string | null): SecretMeta[] {
  const t = text.trim().toLowerCase();
  const hit = (s: string) => s.toLowerCase().includes(t);
  return list.filter((m) => (tag === null || m.tags.includes(tag)) && (t === "" || hit(m.name) || hit(m.description) || m.tags.some(hit)));
}

export interface SinkRow {
  sink: SecretSinkInfo;
  /** the backend that reported this sink's key states, if any did */
  owner: string | null;
}

/** The writer's sinks (or, with the writer away, the first readable copy's),
 *  each with the key states and error its owner reported. Only the backend
 *  that owns a sink fills `state`, so the owner is whoever did. */
export function sinkRows(all: Readonly<Record<string, SecretsInfo>>, order: readonly string[], writer: string | null): SinkRow[] {
  const base = writer ? all[writer] : order.map((b) => all[b]).find((i) => i?.ok);
  if (!base) return [];
  return base.sinks.map((sink) => {
    const owner = order.find((b) => Object.keys(all[b]?.sinks.find((x) => x.id === sink.id)?.state ?? {}).length > 0) ?? null;
    const own = owner === null ? undefined : all[owner]?.sinks.find((x) => x.id === sink.id);
    return { sink: own ? { ...sink, state: own.state, error: own.error } : sink, owner };
  });
}

/** a sink's keys as the editor shows them, one `KEY=secret_name` a line */
export const keysText = (keys: Readonly<Record<string, string>>): string =>
  Object.entries(keys)
    .map(([k, n]) => `${k}=${n}`)
    .join("\n");

/** the editor's lines back into keys; the service checks again */
export function parseKeysText(text: string, format: SecretSinkFormat): Record<string, string> | { error: string } {
  const keys: Record<string, string> = {};
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = (lines[i] ?? "").trim();
    if (line === "") continue;
    const at = line.indexOf("=");
    if (at < 0) return { error: `line ${i + 1} has no =` };
    const key = line.slice(0, at).trim();
    const name = line.slice(at + 1).trim();
    if (!(format === "json" ? JSON_PATH : DOTENV_KEY).test(key)) return { error: `line ${i + 1}: ${key} is not a ${format === "json" ? "JSON path" : "dotenv key"}` };
    if (!SECRET_NAME.test(name)) return { error: `line ${i + 1}: ${name} is not a secret name` };
    if (key in keys) return { error: `line ${i + 1}: ${key} is mapped twice` };
    keys[key] = name;
  }
  return keys;
}

/** the tone class each key state wears */
export const KEY_TONE: Record<SecretKeyState, string> = {
  same: "moss",
  drift: "rust",
  missing: "lichen",
  waiting: "sky",
  unknown: "",
  "phase 3": "",
};
```

- [ ] **Step 4: Add the calls**

In `ui/src/api.ts`, in the `import type { … } from "../../src/core/types";` list, after the line `  HealthInfo,` add:

```ts
  SecretAuditEntry,
  SecretProposalIn,
  SecretsInfo,
```

After the line `} from "../../src/core/types";` add:

```ts
import type { SecretAct } from "../../src/core/secretwire";
```

In the `api` object, after the line that starts `  healCheck: async (b: string, id: string) =>` add:

```ts
  /* the secret store (server/secrets.ts); no answer here ever holds a value
     but a reveal's, and none carries ids, so nothing is qualified */
  secrets: (b: string = homeName()) => req<SecretsInfo>(b, "/api/secrets"),
  secretsAudit: (b: string) => req<SecretAuditEntry[]>(b, "/api/secrets/audit"),
  secretsBegin: (b: string, kind: "login" | "register", code: string | null) =>
    req<unknown>(b, "/api/secrets/gate/begin", { method: "POST", body: JSON.stringify({ kind, code }) }),
  secretsFinish: (b: string, kind: "login" | "register", code: string | null, response: unknown, label: string) =>
    req<{ ok: true }>(b, "/api/secrets/gate/finish", { method: "POST", body: JSON.stringify({ kind, code, response, label }) }),
  secretsLogout: (b: string) => req<{ ok: true }>(b, "/api/secrets/logout", { method: "POST", body: "{}" }),
  secretsAct: (b: string, act: SecretAct) => req<unknown>(b, "/api/secrets/act", { method: "POST", body: JSON.stringify({ act }) }),
  secretsPropose: (b: string, items: SecretProposalIn[]) =>
    req<{ added: number; dropped: number }>(b, "/api/secrets/proposals", { method: "POST", body: JSON.stringify({ items }) }),
  secretsPull: (b: string) => req<SecretsInfo>(b, "/api/secrets/pull", { method: "POST", body: "{}" }),
  secretsScan: (b: string) => req<{ items: SecretProposalIn[]; missing: string[] }>(b, "/api/secrets/scan", { method: "POST", body: "{}" }),
  secretsTake: (b: string, id: string, key: string) => req<SecretProposalIn>(b, "/api/secrets/take", { method: "POST", body: JSON.stringify({ id, key }) }),
  secretsUnlock: (b: string, passphrase: string) => req<{ ok: true }>(b, "/api/secrets/unlock", { method: "POST", body: JSON.stringify({ passphrase }) }),
  secretsLock: (b: string) => req<{ ok: true }>(b, "/api/secrets/lock", { method: "POST", body: "{}" }),
  secretsKey: (b: string, passphrase: string, replace: boolean) =>
    req<{ recipient: string }>(b, "/api/secrets/key", { method: "POST", body: JSON.stringify({ passphrase, replace }) }),
```

`secretsAct` answers `unknown`: a reveal's data is `{ value, hideAfterMs }`, an import scan's `{ added, dropped }`, the rest `null`. The view narrows it where it reads it.

- [ ] **Step 5: Add the store slice**

In `ui/src/store.ts`:

1. In the `import type { … } from "../../src/core/types";` line that names `HealthCheck`, add `SecretsInfo` to the list.
2. After the line `  loadHealth: (backend?: string) => Promise<void>;` add:

```ts
  /** each backend's secret store, by backend name: names, sinks and
   *  proposals, never a value; an older backend that has none is missing */
  secrets: Record<string, SecretsInfo>;
  /** reads one backend's secret store, home by default */
  loadSecrets: (backend?: string) => Promise<void>;
```

3. After the line `const healthEvents = new Map<string, number>();` add:

```ts
/* and each backend's secrets events */
const secretsEvents = new Map<string, number>();
```

4. In the initial state, after the line `  health: {},` add:

```ts
  secrets: {},
```

5. In `applyEvent`, after the `if (ev.type === "health") { … return; }` block add:

```ts
    if (ev.type === "secrets") {
      secretsEvents.set(b, (secretsEvents.get(b) ?? 0) + 1);
      // a broadcast carries nobody's session; keep what this page last read
      set((st) => ({ secrets: { ...st.secrets, [b]: { ...ev.info, session: st.secrets[b]?.session ?? false } } }));
      return;
    }
```

6. After the `loadHealth: async (backend) => { … },` implementation add:

```ts
  loadSecrets: async (backend) => {
    const b = backend ?? get().home;
    const mark = secretsEvents.get(b) ?? 0;
    try {
      const info = await api.secrets(b);
      // a read carries this page's session, so it wins over any event that
      // came in meanwhile on that one field
      if ((secretsEvents.get(b) ?? 0) === mark && isShown(get(), b)) set((s) => ({ secrets: { ...s.secrets, [b]: info } }));
      else if (isShown(get(), b))
        set((s) => {
          const cur = s.secrets[b];
          return cur ? { secrets: { ...s.secrets, [b]: { ...cur, session: info.session } } } : {};
        });
    } catch {
      // an older backend has no secret store; nothing shows for it
    }
  },
```

7. After each of the three lines `  void get().loadHealth(b);`, `    void get().loadHealth();` and `    void get().loadHealth(name);` add the same call for secrets with the same argument (`void get().loadSecrets(b);`, `void get().loadSecrets();`, `void get().loadSecrets(name);`), at the same indentation.
8. Where a backend leaves, after the line `    const { [name]: _health, ...health } = s.health;` add `    const { [name]: _secrets, ...secrets } = s.secrets;`, and after the line `      health,` in the `set({ … })` that follows add `      secrets,`.

- [ ] **Step 6: Write the view**

Create `ui/src/components/Secrets.tsx`:

```tsx
import { startAuthentication, startRegistration } from "@simplewebauthn/browser";
import { useEffect, useState, type FormEvent } from "react";
import type { SecretAct } from "../../../src/core/secretwire";
import type { SecretAuditEntry, SecretMeta, SecretProposalInfo, SecretSinkFormat, SecretSinkInfo, SecretsInfo } from "../../../src/core/types";
import { api } from "../api";
import { KEY_TONE, errorText, filterSecrets, gateHere, hostOf, isGateClosed, keysText, parseKeysText, sinkRows, tagsOf, writerOf, type SinkRow } from "../secrets";
import { useStore } from "../store";
import { ago } from "../util";

type AuthOptions = Parameters<typeof startAuthentication>[0]["optionsJSON"];
type RegOptions = Parameters<typeof startRegistration>[0]["optionsJSON"];
type Tab = "secrets" | "sinks" | "import" | "passkeys";

const since = (iso: string): string => ago(Date.parse(iso) / 1000);
const words = (text: string): string[] =>
  text
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
const MACHINES = ["mini", "mac", "gpd"] as const;

function Err({ text }: { text: string | null }) {
  return text ? (
    <span className="secrets-err" role="alert">
      {text}
    </span>
  ) : null;
}

async function login(b: string): Promise<void> {
  const options = await api.secretsBegin(b, "login", null);
  const response = await startAuthentication({ optionsJSON: options as AuthOptions });
  await api.secretsFinish(b, "login", null, response, "");
}

async function register(b: string, code: string | null, label: string): Promise<void> {
  const options = await api.secretsBegin(b, "register", code);
  const response = await startRegistration({ optionsJSON: options as RegOptions });
  await api.secretsFinish(b, "register", code, response, label);
}

/** one gated act at a time on `b`, its error kept for the form that asked;
 *  null when it failed */
function useAct(b: string) {
  const load = useStore((s) => s.loadSecrets);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (act: SecretAct): Promise<{ data: unknown } | null> => {
    setBusy(true);
    setError(null);
    try {
      return { data: await api.secretsAct(b, act) };
    } catch (e) {
      if (isGateClosed(e)) {
        setError("the passkey session has ended; open it again above");
        void load(b);
      } else setError(errorText(e));
      return null;
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, run };
}

/** a step that reloads the store's info however it ends */
function useStep(b: string) {
  const load = useStore((s) => s.loadSecrets);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const step = async (fn: () => Promise<void>): Promise<boolean> => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      return true;
    } catch (e) {
      setError(errorText(e));
      return false;
    } finally {
      setBusy(false);
      void load(b);
    }
  };
  return { busy, error, setError, step };
}

export function SecretsView() {
  const all = useStore((s) => s.secrets);
  const home = useStore((s) => s.home);
  const order = useStore((s) => s.backendOrder);
  const load = useStore((s) => s.loadSecrets);
  const [tab, setTab] = useState<Tab>("secrets");
  useEffect(() => {
    for (const b of order) void load(b);
  }, [order, load]);
  const info = all[home];
  if (!info) {
    return (
      <main className="secrets-view">
        <p className="secrets-note">Reading the secret store…</p>
      </main>
    );
  }
  const here = gateHere(info, window.location.origin);
  const open = here && info.session;
  const writer = writerOf(all, order);
  const tabs: Tab[] = here ? ["secrets", "sinks", "import", "passkeys"] : ["secrets", "sinks", "import"];
  const shown = tabs.includes(tab) ? tab : "secrets";
  return (
    <main className="secrets-view">
      <div className="secrets-bar">
        <span className="secrets-head">
          {info.role === "writer" ? "the mini's store" : `${info.backend}'s pulled copy`} · {info.head ?? "no commit yet"} · {info.secrets.length} secrets
          {info.unpushed > 0 && <span className="lichen"> · {info.unpushed} not on Forgejo yet</span>}
        </span>
        {here ? <PasskeyGate info={info} home={home} /> : info.role === "reader" ? <MachineKey info={info} home={home} /> : null}
        {!here && hostOf(info.gate) !== "" && (
          <a className="chip" href={info.gate}>
            gated actions live on {hostOf(info.gate)}
          </a>
        )}
      </div>
      {!info.ok && (
        <p className="secrets-err" role="alert">
          {info.error}
        </p>
      )}
      {info.refused && (
        <p className="secrets-err" role="alert">
          The newest commit was refused: {info.refused}. This page reads {info.head ?? "nothing yet"}.
        </p>
      )}
      <div className="seg secrets-tabs" role="radiogroup" aria-label="Secret store sections">
        {tabs.map((t) => (
          <button key={t} type="button" role="radio" aria-checked={shown === t} onClick={() => setTab(t)}>
            {t}
          </button>
        ))}
      </div>
      {shown === "secrets" ? (
        <SecretsTab info={info} home={home} open={open} />
      ) : shown === "sinks" ? (
        <SinksTab rows={sinkRows(all, order, writer)} home={home} writer={writer} open={open} />
      ) : shown === "import" ? (
        <ImportTab info={info} home={home} writer={writer} here={here} open={open} />
      ) : (
        <PasskeysTab info={info} home={home} open={open} />
      )}
    </main>
  );
}

/** the gate page's passkey: the first one with the printed code, then a
 *  session to open or close */
function PasskeyGate({ info, home }: { info: SecretsInfo; home: string }) {
  const { busy, error, step } = useStep(home);
  const [code, setCode] = useState("");
  const [label, setLabel] = useState("");
  if (info.firstPasskey) {
    return (
      <form
        className="secrets-form"
        onSubmit={(e) => {
          e.preventDefault();
          void step(async () => {
            await register(home, code.trim(), label);
            await login(home);
          }).then((ok) => ok && setCode(""));
        }}
      >
        <span>No passkey yet. The code is in the secrets service's log.</span>
        <input aria-label="First-passkey code" placeholder="code" autoComplete="off" spellCheck={false} value={code} onChange={(e) => setCode(e.target.value)} />
        <input aria-label="Passkey label" placeholder="label, e.g. phone" value={label} onChange={(e) => setLabel(e.target.value)} />
        <button type="submit" className="mini" disabled={busy || code.trim() === ""}>
          register
        </button>
        <Err text={error} />
      </form>
    );
  }
  return (
    <span className="secrets-gate">
      {info.session ? (
        <>
          <span className="moss">session open</span>
          <button type="button" className="mini" disabled={busy} onClick={() => void step(async () => void (await api.secretsLogout(home)))}>
            close
          </button>
        </>
      ) : (
        <button type="button" className="mini" disabled={busy} onClick={() => void step(() => login(home))}>
          open with a passkey
        </button>
      )}
      <Err text={error} />
    </span>
  );
}

/** a reader's own age key: unlock, lock, or make one */
function MachineKey({ info, home }: { info: SecretsInfo; home: string }) {
  const { busy, error, setError, step } = useStep(home);
  const [pass, setPass] = useState("");
  const [again, setAgain] = useState("");
  const [recipient, setRecipient] = useState<string | null>(null);
  const forget = () => {
    setPass("");
    setAgain("");
  };
  if (recipient) {
    return (
      <span className="secrets-gate">
        Key made. Add it on the gate page under passkeys, machine keys:
        <code className="secrets-recipient">{recipient}</code>
        <button type="button" className="mini" onClick={() => void navigator.clipboard.writeText(recipient)}>
          copy
        </button>
        <button type="button" className="mini" onClick={() => setRecipient(null)}>
          done
        </button>
      </span>
    );
  }
  if (info.lock === "open") {
    return (
      <span className="secrets-gate">
        <span className="moss">this machine's key is open</span>
        <button type="button" className="mini" disabled={busy} onClick={() => void step(async () => void (await api.secretsLock(home)))}>
          lock
        </button>
        <Err text={error} />
      </span>
    );
  }
  if (info.lock === "locked") {
    return (
      <form
        className="secrets-form"
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          void step(async () => void (await api.secretsUnlock(home, pass))).then(forget);
        }}
      >
        <input type="password" aria-label="This machine's key passphrase" autoComplete="current-password" value={pass} onChange={(e) => setPass(e.target.value)} />
        <button type="submit" className="mini" disabled={busy || pass === ""}>
          unlock
        </button>
        <Err text={error} />
      </form>
    );
  }
  return (
    <form
      className="secrets-form"
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        if (pass !== again) {
          setError("the two passphrases differ");
          return;
        }
        void step(async () => {
          const k = await api.secretsKey(home, pass, false);
          setRecipient(k.recipient);
        }).then(forget);
      }}
    >
      <span>No key on this machine.</span>
      <input type="password" aria-label="New key passphrase, 12 characters or more" autoComplete="new-password" value={pass} onChange={(e) => setPass(e.target.value)} />
      <input type="password" aria-label="The passphrase again" autoComplete="new-password" value={again} onChange={(e) => setAgain(e.target.value)} />
      <button type="submit" className="mini" disabled={busy || pass.length < 12}>
        make a key
      </button>
      <Err text={error} />
    </form>
  );
}

function SecretsTab({ info, home, open }: { info: SecretsInfo; home: string; open: boolean }) {
  const [text, setText] = useState("");
  const [tag, setTag] = useState<string | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const shown = filterSecrets(info.secrets, text, tag);
  return (
    <section className="secrets-tab">
      <div className="secrets-filter">
        <input type="search" aria-label="Filter secrets" placeholder="filter by name, description or tag" value={text} onChange={(e) => setText(e.target.value)} />
        {tagsOf(info.secrets).map((t) => (
          <button key={t} type="button" className={`chip${tag === t ? " on" : ""}`} aria-pressed={tag === t} onClick={() => setTag(tag === t ? null : t)}>
            {t}
          </button>
        ))}
      </div>
      {open && <AddSecret home={home} />}
      <ul className="secrets-list">
        {shown.map((m) => (
          <li key={m.name}>
            <button type="button" className="secrets-row" aria-expanded={picked === m.name} onClick={() => setPicked(picked === m.name ? null : m.name)}>
              <span className="secrets-name">{m.name}</span>
              <span className="secrets-desc">{m.description}</span>
              <span className="secrets-meta">
                rotated {since(m.rotated)} · {m.to.join(", ")}
                {m.usedBy.length > 0 ? ` · ${m.usedBy.length} sink${m.usedBy.length === 1 ? "" : "s"}` : ""}
                {m.tags.length > 0 ? ` · ${m.tags.join(", ")}` : ""}
              </span>
            </button>
            {picked === m.name && <SecretSheet key={`${m.name}@${m.rotated}`} meta={m} home={home} open={open} />}
          </li>
        ))}
      </ul>
      {shown.length === 0 && <p className="secrets-note">{info.secrets.length === 0 ? "No secrets yet." : "Nothing matches."}</p>}
    </section>
  );
}

function AddSecret({ home }: { home: string }) {
  const act = useAct(home);
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const [description, setDescription] = useState("");
  const [tags, setTags] = useState("");
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const r = await act.run({ a: "add", name: name.trim(), value, description: description.trim(), tags: words(tags) });
    setValue("");
    if (r) {
      setName("");
      setDescription("");
      setTags("");
    }
  };
  return (
    <form className="secrets-form" onSubmit={(e) => void submit(e)}>
      <input aria-label="New secret name" placeholder="name, e.g. cf_token" spellCheck={false} value={name} onChange={(e) => setName(e.target.value)} />
      <input type="password" aria-label="New secret value" placeholder="value" autoComplete="off" value={value} onChange={(e) => setValue(e.target.value)} />
      <input aria-label="Description" placeholder="what it is for" value={description} onChange={(e) => setDescription(e.target.value)} />
      <input aria-label="Tags, comma separated" placeholder="tags" value={tags} onChange={(e) => setTags(e.target.value)} />
      <button type="submit" className="mini" disabled={act.busy || name.trim() === "" || value === ""}>
        add
      </button>
      <Err text={act.error} />
    </form>
  );
}

/** one secret opened: its facts for anyone, and behind the session its
 *  value (shown for 20 s), its words, a new value, its allowlist, delete
 *  and its history */
function SecretSheet({ meta, home, open }: { meta: SecretMeta; home: string; open: boolean }) {
  const act = useAct(home);
  const [shown, setShown] = useState<{ value: string; until: number } | null>(null);
  const [description, setDescription] = useState(meta.description);
  const [tags, setTags] = useState(meta.tags.join(", "));
  const [allow, setAllow] = useState(meta.allow.join("\n"));
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState(false);
  const [history, setHistory] = useState<SecretAuditEntry[]>([]);
  useEffect(() => {
    if (!shown) return;
    const t = setTimeout(() => setShown(null), Math.max(0, shown.until - Date.now()));
    return () => clearTimeout(t);
  }, [shown]);
  useEffect(() => {
    if (!open) return;
    let live = true;
    api.secretsAudit(home).then(
      (list) => live && setHistory(list.filter((h) => h.name === meta.name).slice(0, 20)),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [open, home, meta.name]);
  const reveal = async () => {
    const r = await act.run({ a: "reveal", name: meta.name });
    const d = r?.data as { value?: unknown; hideAfterMs?: unknown } | null | undefined;
    if (d && typeof d.value === "string") setShown({ value: d.value, until: Date.now() + (typeof d.hideAfterMs === "number" ? d.hideAfterMs : 20_000) });
  };
  const used = meta.usedBy.length > 0;
  return (
    <div className="secrets-sheet">
      <dl className="secrets-facts">
        <dt>created</dt>
        <dd>{since(meta.created)}</dd>
        <dt>rotated</dt>
        <dd>{since(meta.rotated)}</dd>
        <dt>sealed to</dt>
        <dd>{meta.to.join(", ") || "nobody"}</dd>
        <dt>used by</dt>
        <dd>{meta.usedBy.join(", ") || "no sink"}</dd>
        <dt>allowed</dt>
        <dd>{meta.allow.join(", ") || "nothing"}</dd>
      </dl>
      {!open ? (
        <p className="secrets-note">Reveal, rotate and edit need a passkey session on the gate page.</p>
      ) : (
        <>
          <div className="secrets-line">
            <code className="secrets-value">{shown ? shown.value : "••••••••"}</code>
            {shown ? (
              <>
                <button type="button" className="mini" onClick={() => void navigator.clipboard.writeText(shown.value)}>
                  copy
                </button>
                <button type="button" className="mini" onClick={() => setShown(null)}>
                  hide
                </button>
              </>
            ) : (
              <button type="button" className="mini" disabled={act.busy} onClick={() => void reveal()}>
                reveal
              </button>
            )}
          </div>
          <form
            className="secrets-form"
            onSubmit={(e) => {
              e.preventDefault();
              void act.run({ a: "edit", name: meta.name, description: description.trim(), tags: words(tags) });
            }}
          >
            <input aria-label="Description" value={description} onChange={(e) => setDescription(e.target.value)} />
            <input aria-label="Tags, comma separated" value={tags} onChange={(e) => setTags(e.target.value)} />
            <button type="submit" className="mini" disabled={act.busy}>
              save
            </button>
          </form>
          <form
            className="secrets-form"
            onSubmit={(e) => {
              e.preventDefault();
              void act.run({ a: "rotate", name: meta.name, value: next }).then(() => setNext(""));
            }}
          >
            <input type="password" aria-label={`New value for ${meta.name}`} placeholder="new value" autoComplete="off" value={next} onChange={(e) => setNext(e.target.value)} />
            <button type="submit" className="mini" disabled={act.busy || next === ""}>
              rotate
            </button>
          </form>
          <form
            className="secrets-form"
            onSubmit={(e) => {
              e.preventDefault();
              const list = allow
                .split("\n")
                .map((l) => l.trim())
                .filter(Boolean);
              void act.run({ a: "allow", name: meta.name, allow: list });
            }}
          >
            <textarea aria-label={`What may use ${meta.name}, one entry a line`} rows={3} spellCheck={false} value={allow} onChange={(e) => setAllow(e.target.value)} />
            <button type="submit" className="mini" disabled={act.busy}>
              save allowlist
            </button>
          </form>
          <div className="secrets-line">
            {confirm ? (
              <>
                <span className="rust">Delete {meta.name} for good?</span>
                <button type="button" className="mini" disabled={act.busy} onClick={() => void act.run({ a: "delete", name: meta.name })}>
                  delete
                </button>
                <button type="button" className="mini" onClick={() => setConfirm(false)}>
                  keep it
                </button>
              </>
            ) : (
              <button
                type="button"
                className="mini"
                disabled={used}
                title={used ? `used by ${meta.usedBy.join(", ")}; take it out of those sinks first` : `delete ${meta.name}`}
                onClick={() => setConfirm(true)}
              >
                delete…
              </button>
            )}
          </div>
          <Err text={act.error} />
          {history.length > 0 && (
            <ol className="secrets-history">
              {history.map((h, i) => (
                <li key={`${h.at}-${i}`} className={h.ok ? undefined : "rust"}>
                  {since(h.at)} · {h.action}
                  {h.by ? ` by ${h.by}` : ""}
                  {h.detail ? ` · ${h.detail}` : ""}
                </li>
              ))}
            </ol>
          )}
        </>
      )}
    </div>
  );
}

function SinksTab({ rows, home, writer, open }: { rows: SinkRow[]; home: string; writer: string | null; open: boolean }) {
  const act = useAct(home);
  const [editing, setEditing] = useState<SecretSinkInfo | null>(null);
  const [note, setNote] = useState<string | null>(null);
  /** a reader's drifted key: that backend seals the file's value to the
   *  mini, and the page hands it to the mini's proposals */
  const takeElsewhere = async (owner: string, id: string, key: string) => {
    if (!writer) {
      setNote("the mini is not answering, so nothing can be proposed to it");
      return;
    }
    try {
      const item = await api.secretsTake(owner, id, key);
      const r = await api.secretsPropose(writer, [item]);
      setNote(r.added > 0 ? "sent to the mini; approve it under import on the gate page" : "the mini dropped it; its secret may be gone");
    } catch (e) {
      setNote(errorText(e));
    }
  };
  return (
    <section className="secrets-tab">
      {open && <SinkEditor key={editing?.id ?? ""} home={home} start={editing} onDone={() => setEditing(null)} />}
      {rows.length === 0 && <p className="secrets-note">No sinks yet.</p>}
      <ul className="secrets-list">
        {rows.map(({ sink, owner }) => (
          <li key={sink.id}>
            <div className="secrets-line">
              <span className="secrets-name">{sink.id}</span>
              <span className="secrets-meta">
                {sink.machine} · {sink.path} · {sink.format}
                {owner === null ? " · no backend reports it" : ""}
              </span>
              {open && (
                <>
                  <button type="button" className="mini" onClick={() => setEditing(sink)}>
                    edit
                  </button>
                  <button type="button" className="mini" disabled={act.busy} onClick={() => void act.run({ a: "sink-remove", id: sink.id })}>
                    remove
                  </button>
                </>
              )}
            </div>
            {sink.error && (
              <p className="secrets-err" role="alert">
                {sink.error}
              </p>
            )}
            <ul className="secrets-keys">
              {Object.entries(sink.keys).map(([key, name]) => {
                const state = sink.state[key] ?? "unknown";
                return (
                  <li key={key}>
                    <code>{key}</code> ← {name} <span className={KEY_TONE[state]}>{state}</span>
                    {state === "drift" && owner !== null && owner === writer && open && (
                      <>
                        <button type="button" className="mini" disabled={act.busy} onClick={() => void act.run({ a: "sink-write", id: sink.id, key })}>
                          write the store's value
                        </button>
                        <button type="button" className="mini" disabled={act.busy} onClick={() => void act.run({ a: "take", id: sink.id, key })}>
                          take the file's value
                        </button>
                      </>
                    )}
                    {state === "drift" && owner !== null && owner !== writer && (
                      <button type="button" className="mini" onClick={() => void takeElsewhere(owner, sink.id, key)}>
                        take the file's value
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          </li>
        ))}
      </ul>
      <Err text={act.error} />
      {note && <p className="secrets-note">{note}</p>}
    </section>
  );
}

function SinkEditor({ home, start, onDone }: { home: string; start: SecretSinkInfo | null; onDone: () => void }) {
  const act = useAct(home);
  const [id, setId] = useState(start?.id ?? "");
  const [machine, setMachine] = useState(start?.machine ?? "mini");
  const [path, setPath] = useState(start?.path ?? "");
  const [format, setFormat] = useState<SecretSinkFormat>(start?.format ?? "dotenv");
  const [keys, setKeys] = useState(start ? keysText(start.keys) : "");
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const parsed = parseKeysText(keys, format);
    if ("error" in parsed) {
      setError(parsed.error);
      return;
    }
    setError(null);
    const r = await act.run({ a: "sink-set", id: id.trim(), machine, path: path.trim(), format, keys: parsed });
    if (r) {
      setId("");
      setPath("");
      setKeys("");
      onDone();
    }
  };
  return (
    <form className="secrets-form" onSubmit={(e) => void submit(e)}>
      <input aria-label="Sink id" placeholder="id, e.g. immich" spellCheck={false} value={id} readOnly={start !== null} onChange={(e) => setId(e.target.value)} />
      <select aria-label="Machine" value={machine} onChange={(e) => setMachine(e.target.value)}>
        {MACHINES.map((m) => (
          <option key={m} value={m}>
            {m}
          </option>
        ))}
      </select>
      <input aria-label="File path" placeholder="/opt/stacks/immich/.env" spellCheck={false} value={path} onChange={(e) => setPath(e.target.value)} />
      <select aria-label="Format" value={format} onChange={(e) => setFormat(e.target.value === "json" ? "json" : "dotenv")}>
        <option value="dotenv">dotenv</option>
        <option value="json">json</option>
      </select>
      <textarea aria-label="Keys, one KEY=secret_name a line" rows={3} spellCheck={false} placeholder="DB_PASSWORD=immich_db" value={keys} onChange={(e) => setKeys(e.target.value)} />
      <button type="submit" className="mini" disabled={act.busy || id.trim() === "" || path.trim() === ""}>
        {start ? "save sink" : "add sink"}
      </button>
      {start && (
        <button type="button" className="mini" onClick={onDone}>
          cancel
        </button>
      )}
      <Err text={error ?? act.error} />
    </form>
  );
}

function ImportTab({ info, home, writer, here, open }: { info: SecretsInfo; home: string; writer: string | null; here: boolean; open: boolean }) {
  const act = useAct(home);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const scanMini = async () => {
    const r = await act.run({ a: "import-scan" });
    const d = r?.data as { added?: unknown; dropped?: unknown } | null | undefined;
    if (d && typeof d.added === "number") setNote(`${d.added} waiting for approval${typeof d.dropped === "number" && d.dropped > 0 ? `, ${d.dropped} dropped` : ""}`);
  };
  const scanHere = async () => {
    if (!writer) {
      setNote("the mini is not answering, so nothing can be proposed to it");
      return;
    }
    setBusy(true);
    setNote(null);
    try {
      const found = await api.secretsScan(home);
      const r = found.items.length > 0 ? await api.secretsPropose(writer, found.items) : { added: 0, dropped: 0 };
      const away = found.missing.length > 0 ? `; not on this machine: ${found.missing.join(", ")}` : "";
      setNote(`${found.items.length} found, ${r.added} sent to the mini${r.dropped > 0 ? `, ${r.dropped} dropped` : ""}${away}. Approve them under import on the gate page.`);
    } catch (e) {
      setNote(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="secrets-tab">
      <div className="secrets-line">
        {here ? (
          <button type="button" className="mini" disabled={!open || act.busy} onClick={() => void scanMini()}>
            scan the mini's sources
          </button>
        ) : (
          <button type="button" className="mini" disabled={busy} onClick={() => void scanHere()}>
            scan this machine's sources
          </button>
        )}
        <span className="secrets-note">Values go to the mini sealed to its key. Nothing is stored until it is approved.</span>
      </div>
      <Err text={act.error} />
      {note && <p className="secrets-note">{note}</p>}
      {here && !open && info.proposals.length > 0 && <p className="secrets-note">{info.proposals.length} waiting; open a passkey session to approve them.</p>}
      {here && open && (
        <ul className="secrets-list">
          {info.proposals.map((p) => (
            <Proposal key={p.id} p={p} home={home} />
          ))}
        </ul>
      )}
    </section>
  );
}

function Proposal({ p, home }: { p: SecretProposalInfo; home: string }) {
  const act = useAct(home);
  const [name, setName] = useState(p.merges ?? p.suggested);
  const [description, setDescription] = useState("");
  const [tags, setTags] = useState("");
  const [value, setValue] = useState("");
  const [asSink, setAsSink] = useState(false);
  const [sinkId, setSinkId] = useState("");
  return (
    <li>
      <div className="secrets-line">
        <span className="secrets-name">{p.key}</span>
        <span className="secrets-meta">
          {p.from} · {p.source}
          {p.merges ? ` · updates ${p.merges}` : ""}
          {p.same ? ` · same value as ${p.same}` : ""}
          {p.namesOnly ? " · names only" : ""}
        </span>
      </div>
      <form
        className="secrets-form"
        onSubmit={(e) => {
          e.preventDefault();
          void act.run({
            a: "approve",
            proposal: p.id,
            name: name.trim(),
            description: description.trim(),
            tags: words(tags),
            value: p.namesOnly ? value : null,
            sink: asSink && sinkId.trim() !== "" ? { id: sinkId.trim() } : null,
          });
        }}
      >
        <input aria-label="Secret name" spellCheck={false} value={name} readOnly={p.merges !== null} onChange={(e) => setName(e.target.value)} />
        {p.merges === null && (
          <>
            <input aria-label="Description" placeholder="what it is for" value={description} onChange={(e) => setDescription(e.target.value)} />
            <input aria-label="Tags, comma separated" placeholder="tags" value={tags} onChange={(e) => setTags(e.target.value)} />
          </>
        )}
        {p.namesOnly && (
          <input type="password" aria-label={`Value for ${p.key}`} placeholder="value (this source lists names only)" autoComplete="off" value={value} onChange={(e) => setValue(e.target.value)} />
        )}
        <label className="secrets-check">
          <input type="checkbox" checked={asSink} onChange={(e) => setAsSink(e.target.checked)} />
          keep this file in step as a sink
        </label>
        {asSink && <input aria-label="Sink id" placeholder="sink id" spellCheck={false} value={sinkId} onChange={(e) => setSinkId(e.target.value)} />}
        <button type="submit" className="mini" disabled={act.busy || name.trim() === "" || (p.namesOnly && value === "")}>
          approve
        </button>
        <button type="button" className="mini" disabled={act.busy} onClick={() => void act.run({ a: "reject", proposal: p.id })}>
          reject
        </button>
        <Err text={act.error} />
      </form>
    </li>
  );
}

function PasskeysTab({ info, home, open }: { info: SecretsInfo; home: string; open: boolean }) {
  const act = useAct(home);
  const { busy, error, step } = useStep(home);
  const [label, setLabel] = useState("");
  const [machine, setMachine] = useState("mac");
  const [recipient, setRecipient] = useState("");
  const [audit, setAudit] = useState<SecretAuditEntry[]>([]);
  useEffect(() => {
    let live = true;
    api.secretsAudit(home).then(
      (list) => live && setAudit(list),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [home, info.head, info.passkeys.length, info.session]);
  return (
    <section className="secrets-tab">
      {!open ? (
        <p className="secrets-note">Open a passkey session above to add or remove passkeys and machine keys.</p>
      ) : (
        <>
          <ul className="secrets-list">
            {info.passkeys.map((k) => (
              <li key={k.id} className="secrets-line">
                <span className="secrets-name">{k.label}</span>
                <span className="secrets-meta">
                  added {since(k.created)}
                  {k.lastUsed ? ` · used ${since(k.lastUsed)}` : ""}
                </span>
                <button
                  type="button"
                  className="mini"
                  disabled={act.busy || info.passkeys.length <= 1}
                  title={info.passkeys.length <= 1 ? "the last passkey stays" : `remove ${k.label}`}
                  onClick={() => void act.run({ a: "passkey-remove", id: k.id })}
                >
                  remove
                </button>
              </li>
            ))}
          </ul>
          <form
            className="secrets-form"
            onSubmit={(e) => {
              e.preventDefault();
              void step(() => register(home, null, label)).then((ok) => ok && setLabel(""));
            }}
          >
            <input aria-label="New passkey label" placeholder="label, e.g. laptop" value={label} onChange={(e) => setLabel(e.target.value)} />
            <button type="submit" className="mini" disabled={busy}>
              add a passkey
            </button>
            <Err text={error} />
          </form>
          <form
            className="secrets-form"
            onSubmit={(e) => {
              e.preventDefault();
              void act.run({ a: "machine-key", machine, recipient: recipient.trim() }).then((r) => r && setRecipient(""));
            }}
          >
            <span>Machine key</span>
            <select aria-label="Machine" value={machine} onChange={(e) => setMachine(e.target.value)}>
              {MACHINES.filter((m) => m !== "mini").map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
            <input aria-label="Its age recipient" placeholder="age1…" spellCheck={false} value={recipient} onChange={(e) => setRecipient(e.target.value)} />
            <button type="submit" className="mini" disabled={act.busy || recipient.trim() === ""}>
              set
            </button>
            <Err text={act.error} />
          </form>
        </>
      )}
      {audit.length > 0 && (
        <ol className="secrets-history">
          {audit.map((h, i) => (
            <li key={`${h.at}-${i}`} className={h.ok ? undefined : "rust"}>
              {since(h.at)} · {h.action}
              {h.name ? ` ${h.name}` : ""}
              {h.by ? ` by ${h.by}` : ""}
              {h.detail ? ` · ${h.detail}` : ""}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
```

- [ ] **Step 7: Wire the view in**

In `ui/src/App.tsx`:

1. After the line `import { HealthView } from "./components/Health";` add `import { SecretsView } from "./components/Secrets";`.
2. In `VIEWS`, after the `health` entry (after the `kit` entry when the kit plan added one) add:

```ts
  { key: "secrets", label: "secrets", title: "Secrets: names, sinks and imports; values only behind a passkey on the mini's page" },
```

3. Add `"secrets"` at the end of the `OTHER_VIEWS` array.
4. After the two lines

```tsx
      ) : view === "health" ? (
        <HealthView />
```

add:

```tsx
      ) : view === "secrets" ? (
        <SecretsView />
```

In `ui/src/cli.ts`, add `| "secrets"` to the end of the `view` union on the `{ kind: "view"; view: … }` line, and after the two lines

```ts
    case "health":
      return { kind: "view", view: "health", sprout: null };
```

add:

```ts
    case "secrets":
      return { kind: "view", view: "secrets", sprout: null };
```

- [ ] **Step 8: Style it**

Append to `ui/src/styles.css`:

```css
/* the secret store's view (components/Secrets.tsx), built like .health-view */
.secrets-view {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 12px 16px 24px;
  max-width: 900px;
  width: 100%;
  margin: 0 auto;
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.secrets-bar,
.secrets-filter,
.secrets-form,
.secrets-gate,
.secrets-line {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  font-size: 12px;
}
.secrets-bar {
  gap: 6px 12px;
}
.secrets-head,
.secrets-meta,
.secrets-desc,
.secrets-note,
.secrets-history {
  color: var(--ink-dim);
  font-size: 12px;
}
.secrets-note {
  margin: 0;
}
.secrets-err {
  color: var(--rust);
  font-size: 12px;
  margin: 0;
}
.secrets-form input:not([type="checkbox"]),
.secrets-form select,
.secrets-form textarea,
.secrets-filter input {
  flex: 1 1 140px;
  min-width: 0;
  padding: 2px 6px;
  border: 1px solid var(--hair);
  border-radius: var(--r);
  background: transparent;
  color: var(--ink);
  font: inherit;
}
.secrets-form textarea {
  flex-basis: 100%;
  font-family: var(--mono);
}
.secrets-list {
  list-style: none;
  margin: 0;
  padding: 0;
}
.secrets-list > li {
  border-bottom: 1px solid var(--hair);
  padding: 6px 0;
}
.secrets-row {
  display: grid;
  grid-template-columns: minmax(120px, 1fr) 2fr;
  gap: 2px 12px;
  width: 100%;
  padding: 2px 4px;
  border-radius: var(--r);
  text-align: left;
}
.secrets-row:hover {
  background: var(--wash);
}
.secrets-row .secrets-meta {
  grid-column: 1 / -1;
}
.secrets-name,
.secrets-value,
.secrets-recipient {
  font-family: var(--mono);
  overflow-wrap: anywhere;
}
.secrets-value,
.secrets-recipient {
  user-select: all;
}
.secrets-sheet {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 8px 4px 4px 16px;
}
.secrets-facts {
  display: grid;
  grid-template-columns: max-content 1fr;
  gap: 2px 12px;
  margin: 0;
  font-size: 12px;
}
.secrets-facts dt {
  color: var(--ink-dim);
}
.secrets-facts dd {
  margin: 0;
  overflow-wrap: anywhere;
}
.secrets-keys {
  list-style: none;
  margin: 4px 0 0;
  padding: 0 0 0 12px;
  display: flex;
  flex-direction: column;
  gap: 2px;
  font-size: 12px;
}
.secrets-history {
  margin: 0;
  padding-left: 16px;
}
.secrets-check {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
.secrets-view .moss {
  color: var(--moss);
}
.secrets-view .lichen {
  color: var(--lichen);
}
.secrets-view .rust {
  color: var(--rust);
}
.secrets-view .sky {
  color: var(--sky);
}
```

- [ ] **Step 9: Run the tests**

Run: `bun test ui/src/secrets.test.ts ui/src/secrets.api.test.ts ui/src/cli.test.ts ui/src/api.test.ts`
Expected: PASS.

- [ ] **Step 10: Gates for the task, and a look in a browser**

Run: `bun run typecheck && bun run lint && bun test && bun run build`
Expected: exit 0.

Then start a scratch server (memory "Scratch canopy server for UI checks": `env -u TMUX`, a short `CANOPY_CONFIG_DIR`, previews off) with no `CANOPY_SECRETS_SOCKET` and no secrets config, so the hub is a reader with nothing pulled. Open `http://127.0.0.1:<port>/?view=secrets` with playwright-cli and check: the view renders, the bar reads "no commit yet", the tabs are secrets, sinks and import (no passkeys tab off the gate), the error line reads "no verified secrets.json here yet" (or names why the pull failed), "make a key" stays disabled under 12 characters, and the layout holds at 390 px wide. Resize the window during the check, not only at load. Do not make a real key on the Mac here: `secrets-key.age` would land in the scratch config dir, so delete that dir afterwards.

- [ ] **Step 11: Commit**

```bash
git add ui/src/secrets.ts ui/src/secrets.test.ts ui/src/secrets.api.test.ts ui/src/components/Secrets.tsx ui/src/api.ts ui/src/store.ts ui/src/App.tsx ui/src/cli.ts ui/src/cli.test.ts ui/src/styles.css
git commit -m "$(printf 'feat(secrets): the secrets view, its passkey gate and the Mac key\n\nClaude-Session: https://claude.ai/code/session_01DEgdKaVhnhcGveC62zKQJh')"
```

---

### Task 15: The service's image and compose service

**Files:**
- Modify: `Dockerfile` (one build line, one new stage)
- Modify: `docker-compose.yml` (the `secrets` service; the socket, group and env on `canopy`; two volumes)
- Test: `src/server/compose.test.ts` (two new `describe` blocks at the end; one existing assertion loosened)

**Interfaces:**
- Consumes: `src/secrets/main.ts` and its `--health` flag and env table (Task 10); `CANOPY_SECRETS_SOCKET` read by `createSecretsHub` (Task 12).
- Produces: the `canopy-secrets` image and the `secrets` service. Used by Task 16's deploy notes.

The service gets its own network and process namespace. canopy runs inside the shells' namespaces (`network_mode` and `pid: service:shells`), so anything canopy holds is as close to a shell as `/proc` lets it be. The service holds the keys, so it shares nothing with either but one socket folder. It runs as root because the sinks under `/opt/stacks` belong to whoever made each stack; `writeSinkFile` (Task 4) chowns each file back to its owner. canopy waits for it to start, not to be healthy: a service that cannot reach Forgejo must not keep the cockpit down, and the hub answers `SECRETS_AWAY` until the socket does.

- [ ] **Step 1: Write the failing tests**

Append to `src/server/compose.test.ts`:

```ts
describe("the secrets service", () => {
  const secrets = compose.services["secrets"];
  const canopy = compose.services["canopy"];
  const named = (v: string): string => v.split(":")[0] ?? v;

  test("exists in a network and process namespace of its own", () => {
    expect(secrets).toBeDefined();
    expect(secrets?.network_mode).toBeUndefined();
    expect(secrets?.pid).toBeUndefined();
  });
  test("inherits nothing: no env_file, no merge key, no extends", async () => {
    const raw = await Bun.file(new URL("../../docker-compose.yml", import.meta.url)).text();
    const start = raw.indexOf("\n  secrets:\n");
    expect(start).toBeGreaterThan(-1);
    const rest = raw.slice(start + 1);
    const next = rest.slice(1).search(/\n  [a-z][\w-]*:\n/);
    const block = next === -1 ? rest : rest.slice(0, next + 1);
    expect(block).not.toMatch(/<<:|env_file|extends:/);
    expect(secrets).not.toHaveProperty("env_file");
  });
  test("its env is its own settings and no token, key or password", () => {
    for (const e of envOf(secrets ?? {})) {
      const name = e.split("=")[0] ?? "";
      expect(name === "LANG" || name.startsWith("CANOPY_SECRETS_")).toBe(true);
      expect(name).not.toMatch(/TOKEN|KEY|PASSWORD|PASSPHRASE/);
    }
    expect(envOf(secrets ?? {})).toContain("CANOPY_SECRETS_CALLER_GID=${SECRETSCALLER_GID:-7851}");
  });
  test("mounts its data, the stacks, canopy's .env read-only and the socket, and nothing the shells mount", () => {
    const vols = secrets?.volumes ?? [];
    expect(vols).toContain("secrets-data:/data");
    expect(vols).toContain("/opt/stacks:/opt/stacks");
    expect(vols).toContain("./.env:/import/canopy.env:ro");
    expect(vols).toContain("secrets-sock:/run/canopy-secrets");
    const shells = (compose.services["shells"]?.volumes ?? []).map(named);
    for (const v of vols) expect(shells).not.toContain(named(v));
  });
  test("shares only the socket with canopy, and only canopy holds it", () => {
    const mine = (secrets?.volumes ?? []).map(named);
    expect((canopy?.volumes ?? []).filter((v) => mine.includes(named(v)))).toEqual(["secrets-sock:/run/canopy-secrets"]);
    for (const [name, s] of Object.entries(compose.services)) {
      if (name === "canopy" || name === "secrets") continue;
      expect((s.volumes ?? []).map(named)).not.toContain("secrets-sock");
      expect((s.volumes ?? []).map(named)).not.toContain("secrets-data");
    }
  });
  test("canopy holds the caller group and the socket path, and does not wait on the service's health", () => {
    expect((canopy as { group_add?: string[] }).group_add).toContain("${SECRETSCALLER_GID:-7851}");
    expect(envOf(canopy ?? {})).toContain("CANOPY_SECRETS_SOCKET=/run/canopy-secrets/secrets.sock");
    expect((canopy?.depends_on as Record<string, { condition?: string }>)?.["secrets"]?.condition).toBe("service_started");
    for (const [name, s] of Object.entries(compose.services)) {
      if (name === "canopy") continue;
      expect(envOf(s).some((e) => e.startsWith("CANOPY_SECRETS_SOCKET="))).toBe(false);
    }
  });
  test("is read-only with a small tmpfs /tmp, and answers a healthcheck", () => {
    const s = secrets as { read_only?: boolean; tmpfs?: string[]; healthcheck?: { test?: string[] } };
    expect(s.read_only).toBe(true);
    expect(s.tmpfs).toEqual(["/tmp:mode=1777,size=64m"]);
    expect(s.healthcheck?.test).toEqual(["CMD", "bun", "/app/secrets-service.js", "--health"]);
  });
});

describe("the secrets image", () => {
  test("is plain bun with git and ssh, and carries only the service's bundle", async () => {
    const text = await Bun.file(new URL("../../Dockerfile", import.meta.url)).text();
    expect(text).toContain("RUN bun build src/secrets/main.ts --target=bun --outfile /app/dist/secrets-service.js");
    const start = text.indexOf("FROM oven/bun:1 AS secrets");
    expect(start).toBeGreaterThan(-1);
    const end = text.indexOf("\nFROM ", start + 1);
    const stage = end === -1 ? text.slice(start) : text.slice(start, end);
    expect(stage).toContain("git openssh-client ca-certificates");
    expect(stage.match(/^COPY .*$/gm)).toEqual(["COPY --from=build /app/dist/secrets-service.js /app/secrets-service.js"]);
    expect(stage).toContain('CMD ["bun", "/app/secrets-service.js"]');
    expect(stage).not.toMatch(/^USER /m);
  });
});
```

In the same file, in the existing test `"canopy holds the stagecaller group, and the stages image is built with the same gid"`, replace

```ts
    expect(services["canopy"]?.group_add).toEqual(["${STAGECALLER_GID:-7850}"]);
```

with

```ts
    expect(services["canopy"]?.group_add).toContain("${STAGECALLER_GID:-7850}");
```

since canopy now holds the secretscaller group as well.

- [ ] **Step 2: Run them to see them fail**

Run: `bun test src/server/compose.test.ts`
Expected: FAIL (no `secrets` service, no stage).

- [ ] **Step 3: The image**

In `Dockerfile`, after the line `RUN bun build src/stage/fencecheck.ts --target=bun --outfile /app/dist/fence-check.js` add:

```dockerfile
# the secret store's service as one file, the only canopy code its image carries
RUN bun build src/secrets/main.ts --target=bun --outfile /app/dist/secrets-service.js
```

Immediately before the line that is exactly `FROM shells` (the final stage, with no `AS`), add:

```dockerfile
# The secret store's service (src/secrets/, docs/deploy.md "Secrets"): the one
# process on the mini that holds the store's age identity and signing key.
# Plain bun, not the shells image: no tmux, no claude, no shell anyone types
# in. git and ssh (with ssh-keygen) for the eric/secrets checkout, its deploy
# key and its push. Root, since it writes sinks under /opt/stacks that other
# users own and chowns each back (src/core/sinks.ts).
FROM oven/bun:1 AS secrets
RUN apt-get update && apt-get install -y --no-install-recommends \
      git openssh-client ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY --from=build /app/dist/secrets-service.js /app/secrets-service.js
# read-only root filesystem (docker-compose.yml): no transpiler cache
ENV BUN_RUNTIME_TRANSPILER_CACHE_PATH=0
CMD ["bun", "/app/secrets-service.js"]

```

- [ ] **Step 4: The compose service**

In `docker-compose.yml`, immediately before the line `  canopy:` (the service, two spaces in), add:

```yaml
  # The secret store's service (src/secrets/, docs/deploy.md "Secrets"): the
  # store's keys, its checkout of eric/secrets, the passkeys, the audit log
  # and the mini's sinks. A network and process namespace of its own, since
  # canopy shares the shells'; canopy reaches it only through the socket.
  secrets:
    build:
      context: .
      target: secrets
    image: canopy-secrets:latest
    environment:
      # the group the socket's folder lets in (root:gid 0750, set at every
      # start); canopy holds it through group_add. Set it in .env only when
      # 7851 is taken.
      - CANOPY_SECRETS_CALLER_GID=${SECRETSCALLER_GID:-7851}
      # ssh://git@<host>:<port>/eric/secrets.git, set in .env. Unset, the
      # store stays in its volume and every change counts as unpushed.
      - CANOPY_SECRETS_REMOTE=${CANOPY_SECRETS_REMOTE:-}
      # the page passkeys are bound to; changing it orphans every passkey
      - CANOPY_SECRETS_ORIGIN=${CANOPY_SECRETS_ORIGIN:-https://canopy.beric.ca}
      - LANG=C.UTF-8
    volumes:
      - secrets-data:/data
      # the stacks: the mini's sinks, and the import scan's sources
      - /opt/stacks:/opt/stacks
      # canopy's own .env, an import source only; read-only, so never a sink.
      # It must exist before `up`, or docker makes a folder in its place.
      - ./.env:/import/canopy.env:ro
      - secrets-sock:/run/canopy-secrets
    read_only: true
    tmpfs:
      - /tmp:mode=1777,size=64m
    init: true
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "bun", "/app/secrets-service.js", "--health"]
      interval: 10s
      timeout: 5s
      retries: 3
      start_period: 10s

```

In the `canopy` service:

1. Under `depends_on:`, after the two lines

```yaml
      stages:
        condition: service_healthy
```

add:

```yaml
      # the secret store's service, through its socket. Started, not healthy:
      # a service that cannot reach Forgejo must not keep canopy down, and
      # the hub answers "away" until the socket does
      secrets:
        condition: service_started
```

2. Replace the line `    group_add: ["${STAGECALLER_GID:-7850}"]` with:

```yaml
    # and the secretscaller group, the only one the secrets service's socket
    # folder lets in
    group_add: ["${STAGECALLER_GID:-7850}", "${SECRETSCALLER_GID:-7851}"]
```

3. After the two lines

```yaml
      # the one way canopy starts an agent, check or build in a seed
      - CANOPY_STAGE_SOCKET=/run/canopy-stage/runner.sock
```

add:

```yaml
      # the secrets service's socket (secrets-sock below); set on this
      # backend alone, so its hub relays to the service instead of reading a
      # pulled copy
      - CANOPY_SECRETS_SOCKET=/run/canopy-secrets/secrets.sock
```

4. After the two lines

```yaml
      # the stage runner's socket, shared with the stages service alone
      - stage-sock:/run/canopy-stage
```

add:

```yaml
      # the secrets service's socket, shared with that service alone
      - secrets-sock:/run/canopy-secrets
```

Under the top-level `volumes:`, after the two lines

```yaml
  # the stage runner's socket folder, owned by the stages' user (Dockerfile)
  stage-sock:
```

add:

```yaml
  # the secret store's checkout, keys, passkeys, audit log and applied
  # stamps; only the secrets service mounts it
  secrets-data:
  # the secrets service's socket folder (root:secretscaller 0750)
  secrets-sock:
```

- [ ] **Step 5: Run the tests**

Run: `bun test src/server/compose.test.ts`
Expected: PASS, the stages tests included.

- [ ] **Step 6: Check the mini, reading only**

Nothing here starts, builds or changes anything on the mini. Run each from the Mac and read the answers; never print a file's contents.

```bash
ssh mini 'cat /proc/sys/kernel/yama/ptrace_scope'
ssh mini 'cd ~/dev/dev-tools/canopy && test -f .env && echo ".env present" || echo ".env MISSING"'
ssh mini 'ls -ld /opt/stacks; find /opt/stacks -maxdepth 2 -name .env | wc -l'
ssh mini 'getent group 7851 || echo "7851 free"'
ssh mini 'cd ~/dev/dev-tools/canopy && docker compose exec -T shells sh -c "p=\$(pgrep -f \"bin/canopy.ts ui\" | head -1); test -r /proc/\$p/environ && echo canopy-environ-readable || echo canopy-environ-not-readable"'
ssh mini 'timeout 5 bash -c "</dev/tcp/192.168.1.76/2222" && echo forgejo-ssh-open || echo forgejo-ssh-closed'
```

Expected and what each means:
- `ptrace_scope` is the host's (a container cannot set its own); 1 means a process may trace only its descendants. The secrets service is in another pid namespace, so the shells cannot even see it.
- `.env present`: the read-only mount needs it. MISSING stops the task: ask Eric.
- The `.env` count under `/opt/stacks` is how many stack files the first mini scan will list.
- 7851 free, or a group the host already uses: then set `SECRETSCALLER_GID` in `.env` to a free one, with Eric's approval.
- `canopy-environ-readable` is expected (same uid, same pid namespace): it is why nothing secret goes into canopy's env, and why `FIREBASE_TOKEN` there is an existing exposure this plan does not fix. Report it either way.
- `forgejo-ssh-open` from the host says the port answers; whether the `secrets` container's bridge reaches it under ufw is checked at first start (Task 16's deploy notes), where a refused push shows as `unpushed`.

Put the six answers in the task report. Adjust `ssh mini` and the paths to the names `docs/deploy.md` uses if they differ.

- [ ] **Step 7: Gates for the task**

Run: `bun run typecheck && bun run lint && bun test && bun run build`
Expected: exit 0.

- [ ] **Step 8: Commit**

```bash
git add Dockerfile docker-compose.yml src/server/compose.test.ts
git commit -m "$(printf 'feat(secrets): the service image and its compose service\n\nClaude-Session: https://claude.ai/code/session_01DEgdKaVhnhcGveC62zKQJh')"
```

Do not deploy. A redeploy waits for Task 16's notes and Eric's approval.

---

### Task 16: The leak scan, and the docs

**Files:**
- Test: `src/secrets/leak.test.ts`
- Modify: `docs/architecture.md` (a new section at the end), `docs/deploy.md` (a new section at the end), `SPEC.md` (four lines), `CLAUDE.md` (one list)

**Interfaces:**
- Consumes: `SecretsService`, `StoreLike` (Task 9); `SecretsHub` (Task 12); `Gate`, `WebAuthn` (Task 7); `Audit` (Task 6); `newIdentity`, `sealProposal` (Task 3); `emptyFile` (Task 2).
- Produces: the leak scan, and the docs the deploy follows.

- [ ] **Step 1: Write the leak scan**

It drives the real service through the real hub with every path a value takes: add, a sink, drift both ways, a broken sink file, an import scan, a cross-origin proposal, an approval, a reveal. Then it reads every answer but the reveal's, every header, every event, every log line, the audit file and the sink states, and looks for each fixture value, its sha256 hex and its base64.

Create `src/secrets/leak.test.ts`:

```ts
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Applied } from "../core/applied";
import { newIdentity, sealProposal } from "../core/secretcrypt";
import { emptyFile, type SecretFile } from "../core/secretfile";
import type { Found } from "../core/secretimport";
import type { SecretsInfo, ServerEvent } from "../core/types";
import { SecretsHub } from "../server/secrets";
import { Audit } from "./audit";
import { Gate, type WebAuthn } from "./gate";
import { SecretsService, type StoreLike } from "./service";

const GATE = "https://canopy.beric.ca";
const BREAKGLASS = "age1xtc4cftnu55fn3enurt9jexnrenmru3w0xl93uz5q20e34mefs6stg2vra";
const V = "fixture-value-0x5eed";
const V2 = "fixture-drift-0x77aa";
const V3 = "fixture-proposed-0x31c4";
const V4 = "fixture-broken-0x9e02";
const VALUES = [V, V2, V3, V4];
const sha = (v: string): string => new Bun.CryptoHasher("sha256").update(v).digest("hex");
const b64 = (v: string): string => Buffer.from(v).toString("base64");

class MemStore implements StoreLike {
  file: SecretFile;
  head = "abc1234";
  unpushed = 0;
  commits: string[] = [];
  constructor(
    public recipient: string,
    private readonly ident: string,
  ) {
    this.file = emptyFile({ mini: recipient, breakglass: BREAKGLASS });
  }
  identity(): string {
    return this.ident;
  }
  async commit(next: SecretFile, message: string): Promise<void> {
    this.file = { ...next, signature: null };
    this.commits.push(message);
  }
}

const wa: WebAuthn = {
  genReg: (async () => ({ challenge: "c" })) as unknown as WebAuthn["genReg"],
  verifyReg: (async () => ({ verified: true, registrationInfo: { credential: { id: "cred1", publicKey: new Uint8Array([1]), counter: 0 } } })) as unknown as WebAuthn["verifyReg"],
  genAuth: (async () => ({ challenge: "c" })) as unknown as WebAuthn["genAuth"],
  verifyAuth: (async () => ({ verified: true, authenticationInfo: { newCounter: 1 } })) as unknown as WebAuthn["verifyAuth"],
};

let dir = "";
let stacks = "";
let logs: string[] = [];
let seen: string[] = [];
let events: ServerEvent[] = [];
let found: Found[] = [];
let token = "";
let store: MemStore;
let svc: SecretsService;
let hub: SecretsHub;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "canopy-leak-"));
  stacks = join(dir, "stacks");
  await mkdir(join(stacks, "dns"), { recursive: true });
  await mkdir(join(stacks, "broken"), { recursive: true });
  logs = [];
  seen = [];
  events = [];
  found = [];
  const mini = await newIdentity();
  store = new MemStore(mini.recipient, mini.identity);
  const log = (l: string) => logs.push(l);
  const gate = await Gate.open({ file: join(dir, "passkeys.json"), rpID: "canopy.beric.ca", origin: GATE, wa, log });
  let applied: Applied = {};
  svc = new SecretsService({
    store,
    gate,
    audit: new Audit(join(dir, "audit.jsonl")),
    machine: "mini",
    gateUrl: `${GATE}/?view=secrets`,
    sinkRoots: [stacks],
    applied: { read: async () => structuredClone(applied), write: async (a) => void (applied = structuredClone(a)) },
    scan: async () => found,
    log,
  });
  hub = new SecretsHub({ backend: "mini", socket: null, gateOrigin: GATE, reader: null, broadcast: (e) => events.push(e), ask: (r) => svc.handle(r) });
  const code = /code ([0-9a-f]{10})/.exec(logs.join("\n"))?.[1] ?? "";
  await gate.begin("register", null, code);
  await gate.finish("register", null, code, { id: "cred1" }, "phone");
  // the first-passkey code is in the log by design; it is not a value
  logs = [];
  await gate.begin("login", null, null);
  const r = await gate.finish("login", null, null, { id: "cred1" }, "");
  token = r.ok ? (r.data as { token: string }).token : "";
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** one request through the hub, its body and headers kept for the scan
 *  unless it is the reveal */
async function send(method: string, path: string, body?: unknown, origin = GATE, keep = true): Promise<{ status: number; text: string }> {
  const req = new Request(`http://127.0.0.1:7850${path}`, {
    method,
    headers: { "content-type": "application/json", origin, "sec-fetch-site": origin === GATE ? "same-origin" : "cross-site", cookie: `canopy_secrets=${token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const res = await hub.handle(req, new URL(req.url));
  if (!res) throw new Error(`${path} not handled`);
  const text = await res.text();
  if (keep) seen.push(text, [...res.headers.entries()].map(([k, v]) => `${k}: ${v}`).join("\n"));
  return { status: res.status, text };
}
async function act(a: unknown): Promise<string> {
  const r = await send("POST", "/api/secrets/act", { act: a });
  if (r.status !== 200) throw new Error(`${r.status} ${r.text}`);
  return r.text;
}
async function info(): Promise<SecretsInfo> {
  return JSON.parse((await send("GET", "/api/secrets")).text) as SecretsInfo;
}

test("no value, its sha256 or its base64 leaves the service but through a reveal", async () => {
  const env = join(stacks, "dns", ".env");
  await act({ a: "add", name: "cf_token", value: V, description: "DNS", tags: ["dns"] });
  await act({ a: "sink-set", id: "dns", machine: "mini", path: env, format: "dotenv", keys: { CF_API_TOKEN: "cf_token" } });
  // the sink file is the one place outside the store a value belongs
  expect(await readFile(env, "utf8")).toContain(V);

  // drift, put back from the store
  await writeFile(env, `CF_API_TOKEN=${V2}\n`);
  await svc.syncSinks();
  expect((await info()).sinks.find((s) => s.id === "dns")?.state["CF_API_TOKEN"]).toBe("drift");
  await act({ a: "sink-write", id: "dns", key: "CF_API_TOKEN" });
  // drift again, taken into the store
  await writeFile(env, `CF_API_TOKEN=${V2}\n`);
  await svc.syncSinks();
  await act({ a: "take", id: "dns", key: "CF_API_TOKEN" });

  // a sink file that does not parse, with a value-like line in it
  const brokenFile = join(stacks, "broken", ".env");
  await writeFile(brokenFile, `${V4}\n`);
  const broken = await send("POST", "/api/secrets/act", { act: { a: "sink-set", id: "broken", machine: "mini", path: brokenFile, format: "dotenv", keys: { A: "cf_token" } } });
  await svc.syncSinks();
  const after = await info();
  const err = after.sinks.find((s) => s.id === "broken")?.error ?? (broken.status === 200 ? null : broken.text);
  expect(err).toBeTruthy();

  // an import scan on the mini, and an approval
  found = [
    { source: env, key: "CF_API_TOKEN", value: V2 },
    { source: "/import/canopy.env", key: "OPENAI_API_KEY", value: V3 },
  ];
  await act({ a: "import-scan" });
  const p = (await info()).proposals.find((x) => x.key === "OPENAI_API_KEY");
  expect(p?.same).toBeNull();
  await act({ a: "approve", proposal: p?.id ?? "", name: "openai_key", description: "", tags: [], value: null, sink: null });

  // a proposal from the Mac's page, sealed to the mini
  const ref = { from: "mac", source: "/Users/eric/dev/x/.env", key: "OTHER_KEY" };
  const sealed = await sealProposal(ref, V3, store.recipient);
  const proposed = await send("POST", "/api/secrets/proposals", { items: [{ ...ref, sealed, merges: null }] }, "http://mac.tail:7850");
  expect(proposed.status).toBe(200);
  expect((await info()).proposals.find((x) => x.key === "OTHER_KEY")?.same).toBe("openai_key");

  // a refused act and an audit read
  await send("POST", "/api/secrets/act", { act: { a: "delete", name: "cf_token" } });
  await send("GET", "/api/secrets/audit");
  // without the cookie: an info read, and a reveal that answers 401 and no value
  const saved = token;
  token = "";
  await info();
  const shut = await send("POST", "/api/secrets/act", { act: { a: "reveal", name: "cf_token" } });
  expect(shut.status).toBe(401);
  token = saved;

  const audit = await readFile(join(dir, "audit.jsonl"), "utf8");
  const everything = [...seen, JSON.stringify(events), logs.join("\n"), audit, JSON.stringify(after.sinks)].join("\n");
  expect(events.length).toBeGreaterThan(0);
  expect(audit).toContain("sink-write");
  for (const v of VALUES) {
    expect(everything).not.toContain(v);
    expect(everything).not.toContain(sha(v));
    expect(everything).not.toContain(b64(v));
  }
});

test("a reveal answers the value, and only the reveal", async () => {
  await act({ a: "add", name: "cf_token", value: V, description: "", tags: [] });
  const r = await send("POST", "/api/secrets/act", { act: { a: "reveal", name: "cf_token" } }, GATE, false);
  expect(r.status).toBe(200);
  expect(JSON.parse(r.text)).toEqual({ value: V, hideAfterMs: 20_000 });
  const audit = await readFile(join(dir, "audit.jsonl"), "utf8");
  expect(audit).toContain("reveal");
  expect(audit).not.toContain(V);
  expect(JSON.stringify(events)).not.toContain(V);
  expect(logs.join("\n")).not.toContain(V);
});
```

- [ ] **Step 2: Run it**

Run: `bun test src/secrets/leak.test.ts`
Expected: PASS. A failure names the value and where it showed up (`everything` holds every source). Fix the code that leaked, never the test. If an act the scan drives is refused for a reason Tasks 9 and 12 did not plan for (the broken sink's `sink-set` is allowed to be refused; nothing else is), say so in the task report and stop.

- [ ] **Step 3: The architecture section**

Append to `docs/architecture.md`:

```markdown
## The secret store

The store (`docs/superpowers/specs/2026-10-14-secrets-design.md`, plan `docs/superpowers/plans/2026-10-14-secrets-phase-1.md`) is one signed file, `secrets.json`, in the private Forgejo repo `eric/secrets`. Every value in it is an age envelope sealed to the machines that may open it (`recipientsFor`: the mini and the break-glass key always, the Mac when a sink on the Mac or on gpd needs it); the rest (names, descriptions, tags, stamps, allowlists, sinks) is plain text. `core/secretfile.ts` (pure, browser-safe) owns the shape, the canonical JSON (keys sorted, so a reordered file verifies) and the ed25519 signature over it with WebCrypto. `core/secretcrypt.ts` seals and opens with `age-encryption`; a value's envelope binds its name and rotation stamp, so a sealed value moved to another name or stamp fails to open. `core/sinks.ts` reads and rewrites dotenv and JSON files, keeping every line and key it does not manage, refusing a symlink, writing atomically at 0600 and chowning back to the old owner when it runs as root; `repoRefusal` keeps sinks out of a git repo unless git ignores the path. `core/sinksync.ts` decides per key: same, missing (written), drift (left alone until someone picks a side), waiting (the key is locked or the value is not written yet). A key whose file value differs on first apply is drift, never an overwrite.

The writer is `src/secrets/`, its own image and compose service (`secrets`): `store.ts` (the checkout in the `secrets-data` volume, the keys in `data/keys`, signing and pushing as `canopy@mini`, refusing a checkout its own key did not sign), `gate.ts` (passkeys through `@simplewebauthn/server`, the first-passkey code in the log, sessions of 15 idle minutes and an hour at most), `audit.ts`, and `service.ts`, which answers one JSON line per connection on a unix socket only the secretscaller group reaches (`core/secretwire.ts` parses both ends). Every act needs a session and is audited either way; one change runs at a time. Proposals (import findings and "take this value") live in the service's memory for 24 hours, at most 500, sealed to the mini until approved; `same` names a secret or proposal holding the same value, compared in memory, never by hash. No answer, log line, event or audit entry holds a value or a hash of one but a reveal's answer (`src/secrets/leak.test.ts`).

canopy's side is `server/secrets.ts`'s `SecretsHub`. On the mini (`CANOPY_SECRETS_SOCKET` set) it relays to the service, turns a login's token into the `canopy_secrets` cookie (`Path=/api/secrets`, HttpOnly, Secure, SameSite=Strict), lets gated routes in only from the gate origin, and answers a closed gate 401 `{error, gate: "passkey"}` with no `login` field, so the page never mistakes it for Cloudflare's sign-in. Everywhere else it runs `core/secretlocal.ts`'s `SecretsReader`: a checkout pulled `--ff-only` and verified against the pinned signing key (`canopy secrets pin`), which keeps its last good commit and names why it refused a newer one; on the Mac, the Mac's age identity wrapped by a passphrase (`secrets-key.age`), opened into memory by `unlock` and dropped by `lock`, and the Mac's sinks. Readers scan their own import sources and take drift by sealing to the mini and posting to the writer's proposals.

The page is `components/Secrets.tsx` (the `secrets` view) with `ui/src/secrets.ts` (pure, tested). It offers gated acts only on the gate page itself (`gateHere`), links there from anywhere else, shows a revealed value for 20 seconds, and keeps each backend's info in the store's `secrets` record. The CLI is `src/cli/secrets.ts`: `list`, `status` (exit 1 on drift), `unlock`, `pin`, and `recover` from the break-glass identity.
```

- [ ] **Step 4: The deploy section**

Append to `docs/deploy.md`:

````markdown
## Secrets

The secret store's writer is the `secrets` service. These steps run once, in order, and each one marked "ask" waits for Eric.

1. **Forgejo (ask).** Create `eric/secrets`, private, with no push mirror; the keeper's GitHub mirroring must leave it out. The remote is `ssh://git@192.168.1.76:2222/eric/secrets.git`.
2. **Settings.** In the mini's `~/dev/dev-tools/canopy/.env`, set `CANOPY_SECRETS_REMOTE` to that URL. Leave `SECRETSCALLER_GID` unset unless 7851 is taken (`getent group 7851`). Each backend's `CANOPY_ORIGINS` must let in the other's page: the mini's the Mac page's origin, the Mac's `https://canopy.beric.ca`.
3. **Redeploy (ask).** `bun run redeploy` builds `canopy-secrets` and starts it before canopy. Its first start prints, in `docker compose logs secrets`: the deploy key's public half, the mini's age recipient, the signing public key, and a first-passkey code. All but the code are public keys; the code works once.
4. **Deploy key (ask).** Add the printed public half to `eric/secrets` as a deploy key with write access. Until then every change waits as `unpushed` on the gate page.
5. **First passkey.** Open `https://canopy.beric.ca/?view=secrets`, enter the code and a label, and approve the prompt. Five wrong codes print a new one.
6. **The Mac reads.** `canopy secrets pin <signing public key> --remote ssh://git@192.168.1.76:2222/eric/secrets.git`. The Mac pulls with Eric's own Forgejo key and refuses any commit the pinned key did not sign. Off the LAN the pull fails and the last good copy stays.
7. **The Mac's key.** On the Mac's page, `?view=secrets`, "make a key" with a passphrase of 12 characters or more, and copy the recipient it shows once. On the gate page, under passkeys, set it as machine key `mac`; the store reseals what the Mac's sinks need. `canopy secrets unlock` (or the page) opens it after each Mac canopy start.
8. **Check.** The gate page shows `unpushed` 0 after an add; `canopy secrets status` on the Mac names the same head and no refusal; `/api/secrets` from any page holds no value.

Recovery when the mini's keys are gone: `canopy secrets recover <checkout of eric/secrets> --breakglass <identity file> --out <dir>` rebuilds a file sealed to new keys from the break-glass identity, which lives offline. It commits nothing; read its output, then put the new keys in the volume by hand.

Rollback: `docker compose stop secrets`. canopy shows the store as away; sinks keep what was last written. `docker compose rm secrets` and dropping the two volumes removes it for good, keys included, so take a copy of `secrets-data` first.

Nothing secret goes into canopy's environment: canopy shares the shells' pid namespace, and a shell can read `/proc/<canopy>/environ`.
````

- [ ] **Step 5: SPEC.md and CLAUDE.md**

In `SPEC.md`:

1. After the line ``- git, gh and the `claude` CLI are shelled out to, never linked.`` add:

```markdown
- age-encryption 0.3.1 seals the secret store's values; @simplewebauthn/server 14.0.3 and @simplewebauthn/browser 14.0.0 are its passkey gate.
```

2. In the line that starts `- Shared backend: docker compose (`, add `` `secrets`, `` after `` `stages`, `` in the list of services.
3. After the line `- Session history is read from claude-history's CLI (`--json`), never its sqlite file.` add:

```markdown
- The secret store: `secrets.json` in the private Forgejo repo `eric/secrets`, its values sealed with age and the file signed. On the mini the `secrets-data` volume holds the checkout, the keys, `passkeys.json`, `audit.jsonl` and `applied.json`. On every other backend, next to the config: `secrets/` (a pulled copy), `secrets-config.json` (the pinned key and remote), `secrets-key.age` (that machine's passphrase-wrapped key) and `secrets-applied.json`.
```

4. After the line that starts `- 2026-10-09:` add:

```markdown
- 2026-10-14: Secrets live in one signed, age-sealed file in Forgejo, written only by a service on the mini behind passkeys, because a value must never sit in a container that shares the shells' namespaces or in a repo canopy syncs.
```

In `CLAUDE.md`, in the line that starts `- Feature areas with their own sections:`, add `, the secret store` before its final period.

- [ ] **Step 6: All the gates**

Run: `bun run typecheck && bun run lint && bun test && bun run build`
Expected: exit 0. Then `~/.claude/skills/verify-build/clean-rebuild.sh check` and, if it exits 1, `rebuild`, and `verify "secrets-view"` against the built `dist/web`.

- [ ] **Step 7: Commit**

```bash
git add src/secrets/leak.test.ts docs/architecture.md docs/deploy.md SPEC.md CLAUDE.md
git commit -m "$(printf 'test(secrets): the leak scan, and the store in the docs\n\nClaude-Session: https://claude.ai/code/session_01DEgdKaVhnhcGveC62zKQJh')"
```

The deploy itself (steps 1 to 8 of the new section) is Eric's call, step by step. Do not push: `main` deploys.

---

## Self-review

- Spec coverage, phase 1: the signed file and its recipient rule (Tasks 2, 3), sinks with unmanaged lines kept and drift both ways (Tasks 4, 9, 11), the service in its own namespace (Tasks 6, 7, 9, 10, 15), the passkey gate with first-passkey code and session limits (Task 7), import from every phase 1 source with approval (Tasks 8, 9, 11, 14), readers that verify and refuse (Task 11), the routes and cookie (Task 12), the CLI (Task 13), the page (Task 14), the leak scan (Task 16). MCP references, rotation impact, stack restarts and gpd's sinks are phases 2 and 3 ("Not in this plan").
- Every Review Focus item has its test in its owning task: 1 in Tasks 9, 12 and 14; 2 in Tasks 2 and 11; 3 in Task 16; 4 in Tasks 4 and 9; 5 in Task 3.
- Names used across tasks match their definitions: `SecretsInfo.gate` is the full gate page URL everywhere (service, reader, hub, page); `SecretAct` kinds are the fifteen in `ACT_KINDS`; the hub's `ask` takes a `SecretsRequest`.

