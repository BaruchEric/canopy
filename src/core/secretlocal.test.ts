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

let published = 0;
async function publish(f: SecretFile, key: CryptoKey, msg = "change", force = false, seq = ++published): Promise<void> {
  await writeFile(join(work, "secrets.json"), serializeFile(await signFile({ ...f, seq }, key, "mini")));
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
  published = 0;
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

  test("refuses an older signed file committed on top, and keeps the newer one", async () => {
    const f = await base();
    await publish(f, signer, "one");
    await publish({ ...f, secrets: {} }, signer, "two");
    const r = await reader();
    const good = r.head;
    expect(r.info("mac").secrets).toEqual([]);
    await publish(f, signer, "put back", false, 1);
    await r.pull();
    expect(r.head).toBe(good);
    expect(r.refused).toContain("older");
    expect(r.info("mac").secrets).toEqual([]);
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
    if (!("recipient" in made)) throw new Error(made.error);
    expect(r.lock()).toBe("open");
    expect(r.info("mac").recipient).toBe(made.recipient);
    expect(await r.createKey("correct horse battery", false)).toMatchObject({ error: expect.stringContaining("has a key") });
    r.lockNow();
    expect(r.lock()).toBe("locked");
    expect(r.info("mac").recipient).toBeNull();
    expect(await r.unlock("wrong one")).toEqual({ ok: false, error: "wrong passphrase" });
    expect(await r.unlock("wrong two")).toEqual({ ok: false, error: "wrong passphrase" });
    expect(await r.unlock("correct horse battery")).toEqual({ ok: true });
    expect(waits).toEqual([2000, 4000]);
    expect(r.lock()).toBe("open");
    expect(r.info("mac").recipient).toBe(made.recipient);
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
