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
const info = async (tok: string | null = null): Promise<SecretsInfo> => {
  const r = await svc.handle({ t: "info", token: tok });
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
    const list = (await info(token)).proposals;
    expect(list.find((x) => x.key === "CF_TOKEN")?.same).toBe("cf_token");
    const openai = list.find((x) => x.key === "OPENAI_API_KEY");
    expect(openai?.suggested).toBe("openai_api_key");
    await ok({ a: "approve", proposal: openai?.id ?? "", name: "openai_api_key", description: "", tags: [], value: null, sink: null });
    expect(await ok({ a: "reveal", name: "openai_api_key" })).toMatchObject({ value: "sk-other" });
    expect((await info()).proposals.map((x) => x.key)).toEqual(["CF_TOKEN"]);
    expect(JSON.stringify(await info())).not.toContain("sk-other");
  });

  test("without a session a proposal names no match, so a sealed guess tells the caller nothing", async () => {
    await add();
    const p = { from: "mac", source: "/Users/e/dev/.env", key: "GUESS" };
    await svc.handle({ t: "propose", items: [{ ...p, sealed: await sealProposal(p, V, store.recipient), merges: null }] });
    expect((await info()).proposals.find((x) => x.key === "GUESS")?.same).toBeNull();
    expect((await info(token)).proposals.find((x) => x.key === "GUESS")?.same).toBe("cf_token");
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
