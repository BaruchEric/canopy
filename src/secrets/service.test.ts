import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Applied } from "../core/applied";
import { mcpHash } from "../core/kit";
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
    sinkRoots: [stacks, join(dir, "home", ".claude", "mcp-env")],
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

  test("sinksAt is the commit the pass started from, and the store's head moving mid-pass does not change it", async () => {
    expect(svc.info(token).sinksAt).toBeNull();
    store.head = "aaa1111";
    const pass = svc.syncSinks();
    store.head = "bbb2222";
    await pass;
    expect(svc.info(token).sinksAt).toBe("aaa1111");
    await svc.syncSinks();
    expect(svc.info(token).sinksAt).toBe("bbb2222");
  });

  test("a write the sync makes on its own goes in the audit log, with no value", async () => {
    await add();
    await ok(dnsSink());
    await writeFile(sinkFile(), "");
    await svc.syncSinks();
    const lines = (await audit.last(50)).filter((e) => e.action === "sink-sync");
    expect(lines.length).toBe(2);
    expect(lines[0]).toMatchObject({ name: "cf_token", ok: true, by: null, detail: "sink dns, key CF_TOKEN" });
    expect(JSON.stringify(lines)).not.toContain(V);
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

  test("a proposal says whether its file can be a sink: inside the roots here, any dotenv or json elsewhere", async () => {
    found = [
      { source: join(stacks, "app", ".env"), key: "A", value: "1" },
      { source: "/import/canopy.env", key: "B", value: "2" },
      { source: join(stacks, "memory", "env.sops.yaml"), key: "C", value: null },
    ];
    await ok({ a: "import-scan" });
    const m = { from: "mac", source: "/Users/e/dev/.env", key: "D" };
    await svc.handle({ t: "propose", items: [{ ...m, sealed: await sealProposal(m, "4", store.recipient), merges: null }] });
    const by = Object.fromEntries((await info()).proposals.map((x) => [x.key, x.sinkable]));
    expect(by).toEqual({ A: true, B: false, C: false, D: true });
  });

  test("at most 500 wait at once", async () => {
    const batch = (n: number) => Array.from({ length: 200 }, (_, i) => ({ from: "mac", source: "/Users/e/dev/.env", key: `K${n}_${i}`, sealed: "", merges: null }));
    expect((await svc.handle({ t: "propose", items: batch(1) })).ok).toBe(true);
    expect((await svc.handle({ t: "propose", items: batch(2) })).ok).toBe(true);
    expect((await svc.handle({ t: "propose", items: batch(3) })).ok).toBe(false);
  });
});

describe("MCP allowances", () => {
  const DEF = { command: "bunx", args: ["-y", "@modelcontextprotocol/server-github"], url: null, env: ["GITHUB_PERSONAL_ACCESS_TOKEN"], headers: [] };
  const home = () => join(dir, "home");
  const envFile = () => join(home(), ".claude", "mcp-env", "github.env");
  const allow = async (over: Partial<Extract<SecretAct, { a: "mcp-allow" }>> = {}): Promise<SecretsReply> =>
    act({ a: "mcp-allow", server: "github", hash: await mcpHash(DEF), def: DEF, env: { GITHUB_PERSONAL_ACCESS_TOKEN: "gh_token" }, headers: {}, homes: { mini: home(), mac: "/Users/e" }, ...over });

  beforeEach(async () => {
    await mkdir(join(home(), ".claude", "mcp-env"), { recursive: true });
    await add("gh_token", V);
    await ok({ a: "machine-key", machine: "mac", recipient: (await newIdentity()).recipient });
    store.commits = [];
  });

  test("one commit adds the allow entry and both machines' sinks, and the mini's file is written", async () => {
    expect((await allow()).ok).toBe(true);
    expect(store.commits).toEqual(["secrets: allow MCP server github"]);
    const e = store.file.secrets["gh_token"];
    expect(e?.allow).toEqual([`mcp:github#${await mcpHash(DEF)}`, "sink:mcp-github-mac", "sink:mcp-github-mini"]);
    expect(e?.to).toEqual(["breakglass", "mac", "mini"]);
    expect(store.file.sinks["mcp-github-mac"]?.path).toBe("/Users/e/.claude/mcp-env/github.env");
    expect(await readFile(envFile(), "utf8")).toContain(`GITHUB_PERSONAL_ACCESS_TOKEN=${V}`);
    expect((await info()).sinks.find((s) => s.id === "mcp-github-mini")?.state).toEqual({ GITHUB_PERSONAL_ACCESS_TOKEN: "same" });
  });

  test("after a revoke the next sync deletes the env file (review focus 5)", async () => {
    await allow();
    expect(await readFile(envFile(), "utf8")).toContain("GITHUB_PERSONAL_ACCESS_TOKEN");
    await ok({ a: "mcp-revoke", server: "github" });
    await expect(readFile(envFile(), "utf8")).rejects.toThrow();
    expect((await audit.last(5)).some((e) => e.action === "sink-prune" && e.detail?.endsWith("github.env"))).toBe(true);
  });

  test("a directory and a symlink in mcp-env survive, an rm failure does not reject the pass, and sinksAt is set", async () => {
    const mcp = join(home(), ".claude", "mcp-env");
    await mkdir(join(mcp, "stale.env"));
    await writeFile(join(dir, "elsewhere"), "kept");
    await symlink(join(dir, "elsewhere"), join(mcp, "linked.env"));
    store.head = "ccc3333";
    await svc.tick();
    expect(svc.info(token).sinksAt).toBe("ccc3333");
    expect((await readdir(mcp)).sort()).toEqual(["linked.env", "stale.env"]);
    expect(await readFile(join(dir, "elsewhere"), "utf8")).toBe("kept");
    await writeFile(join(mcp, "old.env"), "x");
    await chmod(mcp, 0o500);
    store.head = "ddd4444";
    try {
      await svc.tick();
    } finally {
      await chmod(mcp, 0o700);
    }
    expect(svc.info(token).sinksAt).toBe("ddd4444");
    expect((await audit.last(5)).some((e) => e.action === "sink-prune" && !e.ok && e.detail === `${mcp}/old.env`)).toBe(true);
  });

  test("a hash that does not match its definition, gpd, and a home outside the roots are refused, with no commit", async () => {
    expect(await allow({ hash: "b".repeat(64) })).toEqual({ ok: false, error: "the hash does not match the definition of github that came with it" });
    const gpd = await allow({ homes: { gpd: "/home/eric" } });
    expect(gpd.ok ? "" : gpd.error).toContain("phase 3");
    const out = await allow({ homes: { mini: "/elsewhere" } });
    expect(out.ok ? "" : out.error).toContain("outside");
    expect(store.commits).toEqual([]);
  });

  test("revoke takes the allow entry and the sinks out in one commit; delete names the server until then", async () => {
    await allow();
    const refused = await act({ a: "delete", name: "gh_token" });
    expect(refused.ok ? "" : refused.error).toBe("gh_token is used by mcp-github-mac, mcp-github-mini and the MCP server github; take it out of those first");
    store.commits = [];
    await ok({ a: "mcp-revoke", server: "github" });
    expect(store.commits).toEqual(["secrets: revoke MCP server github"]);
    expect(store.file.sinks).toEqual({});
    expect(store.file.secrets["gh_token"]?.allow).toEqual([]);
    await ok({ a: "delete", name: "gh_token" });
  });
});
