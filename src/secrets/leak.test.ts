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
