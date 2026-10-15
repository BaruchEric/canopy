import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Applied } from "../core/applied";
import { exec } from "../core/exec";
import { mcpHash } from "../core/kit";
import { fakeClaude } from "../core/kitfake";
import { newIdentity, sealProposal } from "../core/secretcrypt";
import { emptyFile, type SecretFile } from "../core/secretfile";
import type { Found } from "../core/secretimport";
import type { SecretsInfo, ServerEvent } from "../core/types";
import { KitHub } from "../server/kit";
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
  await mkdir(join(dir, "home", ".claude", "mcp-env"), { recursive: true });
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
    sinkRoots: [stacks, join(dir, "home", ".claude", "mcp-env")],
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

interface KitRig {
  h: string;
  claudeDir: string;
  argvLog: string;
  kitEvents: ServerEvent[];
  kitSend: (method: string, path: string, body?: unknown) => Promise<{ status: number; text: string }>;
}

/** a scratch home with a git-ignored dotclaude, a hand-made github holding a literal token and a hand-made
 *  hooky with a token in its url, a kit manifest with github's secret allowed, and a KitHub on the fake claude */
async function kitRig(): Promise<KitRig> {
  const h = join(dir, "home");
  const claudeDir = join(h, ".claude");
  await exec(["git", "init", "-q", "-b", "main", claudeDir]);
  await writeFile(join(claudeDir, ".gitignore"), "mcp-env/\n.canopy-kit-mcp.json\n");
  await mkdir(join(claudeDir, "skills"), { recursive: true });
  await mkdir(join(claudeDir, "bin"), { recursive: true });
  await copyFile(join(import.meta.dir, "..", "..", "scripts", "canopy-mcp-env"), join(claudeDir, "bin", "canopy-mcp-env"));
  await chmod(join(claudeDir, "bin", "canopy-mcp-env"), 0o755);
  await mkdir(join(h, ".codex", "skills"), { recursive: true });
  await writeFile(join(h, ".codex", "config.toml"), "");
  await writeFile(join(h, ".claude.json"), JSON.stringify({ mcpServers: {
    github: { type: "stdio", command: "bunx", args: ["-y", "@modelcontextprotocol/server-github"], env: { GITHUB_PERSONAL_ACCESS_TOKEN: V2 } },
    hooky: { type: "http", url: `https://h.example/mcp?token=${V3}` },
  } }));
  const kitPath = join(claudeDir, "kit.json");
  await writeFile(kitPath, JSON.stringify({
    version: 1,
    machines: { mini: { backend: "mini" } },
    targets: [
      { agent: "claude", skills: "~/.claude/skills", mode: "store", mcp: { file: "~/.claude.json", format: "claude-json" } },
      { agent: "codex", skills: "~/.codex/skills", mode: "link", mcp: { file: "~/.codex/config.toml", format: "codex-toml" } },
    ],
    mcp: { github: { command: "bunx", args: ["-y", "@modelcontextprotocol/server-github"], env: { GITHUB_PERSONAL_ACCESS_TOKEN: "${secret:gh_token}" } } },
  }));

  await act({ a: "add", name: "gh_token", value: V, description: "", tags: [] });
  const def = { command: "bunx", args: ["-y", "@modelcontextprotocol/server-github"], url: null, env: ["GITHUB_PERSONAL_ACCESS_TOKEN"], headers: [] };
  await act({ a: "mcp-allow", server: "github", hash: await mcpHash(def), def, env: { GITHUB_PERSONAL_ACCESS_TOKEN: "gh_token" }, headers: {}, homes: { mini: h } });

  const argvLog = join(dir, "argv.log");
  const kitEvents: ServerEvent[] = [];
  const kit = new KitHub({
    self: "mini", devRoot: join(h, "dev"), kitPath, broadcast: (e) => kitEvents.push(e), every: 0,
    env: { HOME: h, KIT_CLAUDE: fakeClaude(dir), FAKE_CLAUDE_LOG: argvLog }, secrets: () => hub.info(null), hostHome: h, procEnv: {},
  });
  const kitSend = async (method: string, path: string, body?: unknown): Promise<{ status: number; text: string }> => {
    const req = new Request(`http://127.0.0.1:7850${path}`, { method, body: body === undefined ? undefined : JSON.stringify(body) });
    const res = await kit.handle(req, new URL(req.url));
    if (!res) throw new Error(`${path} not handled`);
    const text = await res.text();
    seen.push(text);
    return { status: res.status, text };
  };
  await kit.scan();
  return { h, claudeDir, argvLog, kitEvents, kitSend };
}

/** every form a value could take on its way out: itself, its sha256 and its base64 */
function expectNone(text: string, values: string[]): void {
  for (const v of values) {
    expect(text).not.toContain(v);
    expect(text).not.toContain(sha(v));
    expect(text).not.toContain(b64(v));
  }
}

/** the kit-managed github entry in a written config must be the wrapper alone: no env, no value */
function expectWrapperEntry(entry: Record<string, unknown> | undefined): void {
  if (!entry) throw new Error("the kit-managed github entry is missing");
  expect(String(entry["command"])).toEndWith("/canopy-mcp-env");
  expect((entry["args"] as unknown[]).slice(0, 2)).toEqual(["github", "--"]);
  expect(JSON.stringify(entry)).not.toContain("GITHUB_PERSONAL_ACCESS_TOKEN");
  expect(entry["env"]).toBeUndefined();
}

// KitHub has no log dependency, so `logs` covers the secrets service only.
test("no value reaches a kit route, a kit event, an apply result, claude's argv or either config file", async () => {
  const { h, claudeDir, argvLog, kitEvents, kitSend } = await kitRig();
  await kitSend("GET", "/api/kit");
  const preview = await kitSend("GET", "/api/kit/preview?machine=mini&agent=claude&name=github");
  expect(preview.status).toBe(200);
  expect((await kitSend("POST", "/api/kit/adopt", { machine: "mini", agent: "claude", names: ["github"] })).status).toBe(200);
  const applied = await kitSend("POST", "/api/kit/apply", { machine: "mini" });
  expect(applied.status).toBe(200);
  expect(applied.text.length).toBeGreaterThan(0);

  // the server starts with the value, which reaches it through the wrapper alone
  const started = await exec(["sh", join(claudeDir, "bin", "canopy-mcp-env"), "github", "--", "printenv", "GITHUB_PERSONAL_ACCESS_TOKEN"], { env: { HOME: h } });
  expect(started.stdout).toBe(`${V}\n`);

  const claudeJson = await readFile(join(h, ".claude.json"), "utf8");
  const toml = await readFile(join(h, ".codex", "config.toml"), "utf8");
  const owned = await readFile(join(claudeDir, ".canopy-kit-mcp.json"), "utf8");
  // the hand-made entry adopt replaced is kept for put back, in a 0600 file git ignores
  expect(owned).toContain(V2);
  expect((await stat(join(claudeDir, ".canopy-kit-mcp.json"))).mode & 0o777).toBe(0o600);
  expect((await exec(["git", "-C", claudeDir, "check-ignore", "-q", ".canopy-kit-mcp.json"])).code).toBe(0);

  // the kit-managed entries hold only the wrapper: no secret-named key, no value
  const parsedJson = JSON.parse(claudeJson) as { mcpServers: Record<string, Record<string, unknown>> };
  expectWrapperEntry(parsedJson.mcpServers["github"]);
  const parsedToml = Bun.TOML.parse(toml) as { mcp_servers: Record<string, Record<string, unknown>> };
  expectWrapperEntry(parsedToml.mcp_servers["github"]);
  // hooky is hand-made and stays as it was
  expect(parsedJson.mcpServers["hooky"]?.["url"]).toBe(`https://h.example/mcp?token=${V3}`);

  // the captures the absent checks read are not empty
  const argv = await readFile(argvLog, "utf8");
  expect(argv).toContain("add-json");
  expect(seen.length).toBeGreaterThan(0);
  expect(kitEvents.some((e) => e.type === "kit")).toBe(true);

  // hooky's url holds V3 by design, in ~/.claude.json only
  const outside = [...seen, JSON.stringify(events), JSON.stringify(kitEvents), logs.join("\n"), argv].join("\n");
  expectNone(outside, VALUES);
  for (const text of [claudeJson, toml]) {
    expect(text).not.toContain(V);
    expect(text).not.toContain(V2);
  }
  expect(owned).not.toContain(V);
});

test("a foreign entry's literal is masked before adopt, and put back is the one place it reaches claude's argv", async () => {
  const { h, claudeDir, argvLog, kitEvents, kitSend } = await kitRig();
  // before adoption: the preview, KitInfo and the kit event mask the hand-made literal
  const preview = await kitSend("GET", "/api/kit/preview?machine=mini&agent=claude&name=github");
  expect(preview.status).toBe(200);
  const body = JSON.parse(preview.text) as { have: { env: Record<string, string> } | null };
  expect(Object.keys(body.have?.env ?? {})).toEqual(["GITHUB_PERSONAL_ACCESS_TOKEN"]);
  expect(body.have?.env["GITHUB_PERSONAL_ACCESS_TOKEN"]).toBe("•••");
  const infoRes = await kitSend("GET", "/api/kit");
  expect(infoRes.status).toBe(200);
  expect(infoRes.text).toContain("hooky");
  expect(preview.text).not.toContain(V2);
  expect(infoRes.text).not.toContain(V2);
  expect(infoRes.text).not.toContain(V3);
  expect(kitEvents.some((e) => e.type === "kit")).toBe(true);
  expect(JSON.stringify(kitEvents)).not.toContain(V2);

  const adopted = await kitSend("POST", "/api/kit/adopt", { machine: "mini", agent: "claude", names: ["github"] });
  expect(adopted.status).toBe(200);
  expect(adopted.text.length).toBeGreaterThan(0);
  expect(adopted.text).not.toContain(V2);
  // after adoption the literal lives only in the 0600 ownership file
  expect(await readFile(join(claudeDir, ".canopy-kit-mcp.json"), "utf8")).toContain(V2);
  expect((await stat(join(claudeDir, ".canopy-kit-mcp.json"))).mode & 0o777).toBe(0o600);
  expect(await readFile(join(h, ".claude.json"), "utf8")).not.toContain(V2);

  const restored = await kitSend("POST", "/api/kit/restore", { machine: "mini", agent: "claude", name: "github" });
  expect(restored.status).toBe(200);
  // policy: put back restores the hand-made entry, so ~/.claude.json holds V2 again. It was there before
  // canopy touched it, and claude mcp add-json takes the entry as argv, the one accepted exception.
  const argv = await readFile(argvLog, "utf8");
  expect(argv).toContain("add-json");
  expect(argv).toContain(V2);
  expect(await readFile(join(h, ".claude.json"), "utf8")).toContain(V2);
  expect(await readFile(join(h, ".codex", "config.toml"), "utf8")).not.toContain(V2);
  expect(seen.length).toBeGreaterThan(0);
  expectNone([...seen, JSON.stringify(events), JSON.stringify(kitEvents), logs.join("\n")].join("\n"), VALUES);
  expect(await readFile(join(claudeDir, ".canopy-kit-mcp.json"), "utf8")).not.toContain(V);
});
