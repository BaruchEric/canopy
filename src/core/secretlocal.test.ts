import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newIdentity, newSigningKey, openProposal, sealValue, signingKey } from "./secretcrypt";
import { emptyFile, serializeFile, signFile, type SecretFile } from "./secretfile";
import { onHost } from "./exec";
import { sshSinks, type RemoteSinks } from "./sinkssh";
import { FILE_IO, type SinkIO } from "./sinksync";
import { localPaths, SecretsReader, writeLocalConfig, type ReaderOptions } from "./secretlocal";

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

async function reader(sources: string[] = [], roots: string[] = [], over: Partial<ReaderOptions> = {}): Promise<SecretsReader> {
  const r = new SecretsReader({
    paths: localPaths(join(dir, "config")),
    machine: "mac",
    gateUrl: "https://canopy.beric.ca/?view=secrets",
    sources: () => sources.map((path) => ({ path, kind: "dotenv" as const })),
    repoRoots: () => roots,
    sleep: async (ms) => void waits.push(ms),
    scryptLogN: 10,
    log: () => {},
    ...over,
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
  test("a locked Mac still prunes an env file no sink names (review focus 5)", async () => {
    await publish(await base(), signer);
    const mcpDir = join(dir, "mcp-env");
    await mkdir(mcpDir, { recursive: true });
    await writeFile(join(mcpDir, "github.env"), "GITHUB_PERSONAL_ACCESS_TOKEN=x\n");
    // no key was made here, so the reader is locked and every sink of its own would read waiting
    const r = await reader([], [], { mcpEnvDir: mcpDir });
    await r.syncSinks();
    await expect(readFile(join(mcpDir, "github.env"), "utf8")).rejects.toThrow();
  });

  test("a directory and a symlink in mcp-env survive the pass, which still finishes with sinksAt set", async () => {
    await publish(await base(), signer);
    const mcpDir = join(dir, "mcp-env");
    await mkdir(join(mcpDir, "stale.env"), { recursive: true });
    await writeFile(join(dir, "elsewhere"), "kept");
    await symlink(join(dir, "elsewhere"), join(mcpDir, "linked.env"));
    const lines: string[] = [];
    const r = await reader([], [], { mcpEnvDir: mcpDir, log: (l) => lines.push(l) });
    await r.syncSinks();
    expect(r.info("mac").sinksAt).toBe(r.head);
    expect((await readdir(mcpDir)).sort()).toEqual(["linked.env", "stale.env"]);
    expect(await readFile(join(dir, "elsewhere"), "utf8")).toBe("kept");
  });

  test("an env file it cannot remove is logged by name, and the pass still finishes", async () => {
    await publish(await base(), signer);
    const mcpDir = join(dir, "mcp-env");
    await mkdir(mcpDir, { recursive: true });
    await writeFile(join(mcpDir, "github.env"), "GITHUB_PERSONAL_ACCESS_TOKEN=x\n");
    await chmod(mcpDir, 0o500);
    const lines: string[] = [];
    try {
      const r = await reader([], [], { mcpEnvDir: mcpDir, log: (l) => lines.push(l) });
      await r.syncSinks();
      expect(r.info("mac").sinksAt).toBe(r.head);
      expect(lines).toContain(`secrets: could not remove ${mcpDir}/github.env, which no sink names`);
      expect(lines.join("\n")).not.toContain("GITHUB_PERSONAL_ACCESS_TOKEN=x");
    } finally {
      await chmod(mcpDir, 0o700);
    }
  });

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

  test("sinksAt is the commit a finished pass read, locked or not, and a refused commit leaves it", async () => {
    const f = await base();
    await publish(f, signer);
    const r = await reader();
    const good = r.head;
    expect(good).not.toBeNull();
    expect(r.info("mac").sinksAt).toBe(good);
    await publish({ ...f, secrets: {} }, await signingKey((await newSigningKey()).privateB64), "forged");
    await r.pull();
    expect(r.refused).not.toBeNull();
    expect(r.info("mac").sinksAt).toBe(good);
    await publish(f, signer, "next");
    await r.pull();
    expect(r.head).not.toBe(good);
    expect(r.info("mac").sinksAt).toBe(r.head);
  });

  test("a reader started on a head it already has still runs a pass", async () => {
    await publish(await base(), signer);
    await reader();
    const again = await reader();
    expect(again.info("mac").head).not.toBeNull();
    expect(again.info("mac").sinksAt).toBe(again.info("mac").head);
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

describe("sink passes", () => {
  test("overlapping passes run one after the other", async () => {
    const r0 = await reader();
    const made = await r0.createKey("correct horse battery", false);
    if (!("recipient" in made)) throw new Error(made.error);
    const mini = await newIdentity();
    const f = emptyFile({ mini: mini.recipient, mac: made.recipient, breakglass: BREAKGLASS });
    f.secrets["cf_token"] = { description: "", tags: [], created: STAMP, rotated: STAMP, to: ["breakglass", "mac", "mini"], allow: ["sink:laptop"], value: await sealValue("cf_token", V, STAMP, [mini.recipient, made.recipient]) };
    f.sinks["laptop"] = { machine: "mac", path: join(dir, "app.env"), format: "dotenv", keys: { CF_TOKEN: "cf_token" } };
    await publish(f, signer);
    let live = 0;
    let most = 0;
    const io: SinkIO = {
      read: async (p) => {
        live += 1;
        most = Math.max(most, live);
        await new Promise((res) => setTimeout(res, 5));
        live -= 1;
        return FILE_IO.read(p);
      },
      write: (p, t) => FILE_IO.write(p, t),
    };
    const r = await reader([], [], { io });
    await r.unlock("correct horse battery");
    most = 0;
    await Promise.all([r.syncSinks(), r.syncSinks(), r.syncSinks()]);
    expect(most).toBe(1);
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

describe("gpd's sinks, written by the Mac over ssh (phase 3)", () => {
  /** gpd's scripts run here against a scratch home; `down` makes it away */
  function gpd(home: string, state: { down: string | null; calls: number }): RemoteSinks {
    const inner = sshSinks("gpd", "gpd", (_h, cmd, o) => {
      state.calls += 1;
      return onHost(null, cmd, o);
    });
    return { ...inner, probe: async () => (state.down ? { away: state.down } : { home }) };
  }

  test("waiting while locked with no ssh at all, written once unlocked, away with the reason and tried again on the next pull", async () => {
    const r0 = await reader();
    const made = await r0.createKey("correct horse battery", false);
    if (!("recipient" in made)) throw new Error(made.error);
    const mini = await newIdentity();
    const home = join(dir, "gpd-home");
    await mkdir(join(home, ".claude", "mcp-env"), { recursive: true });
    await writeFile(join(home, ".claude", "mcp-env", "revoked.env"), "OLD=1\n");
    const f = emptyFile({ mini: mini.recipient, mac: made.recipient, breakglass: BREAKGLASS });
    f.secrets["gh_token"] = { description: "", tags: [], created: STAMP, rotated: STAMP, to: ["breakglass", "mac", "mini"], allow: ["sink:mcp-github-gpd"], value: await sealValue("gh_token", V, STAMP, [mini.recipient, made.recipient]) };
    const path = join(home, ".claude", "mcp-env", "github.env");
    f.sinks["mcp-github-gpd"] = { machine: "gpd", path, format: "dotenv", keys: { GITHUB_PERSONAL_ACCESS_TOKEN: "gh_token" } };
    await publish(f, signer);

    const st = { down: null as string | null, calls: 0 };
    const remote = gpd(home, st);
    const r = await reader([], [], { remotes: () => [remote] });
    r.lockNow();
    await r.syncSinks();
    expect(r.info("mac").sinks.find((s) => s.id === "mcp-github-gpd")?.state).toEqual({ GITHUB_PERSONAL_ACCESS_TOKEN: "waiting" });
    expect(st.calls).toBe(0);

    st.down = "ssh: connect to host gpd port 22: Operation timed out";
    expect(await r.unlock("correct horse battery")).toEqual({ ok: true });
    expect(r.info("mac").sinks.find((s) => s.id === "mcp-github-gpd")).toMatchObject({ state: {}, error: "gpd is away: ssh: connect to host gpd port 22: Operation timed out" });
    expect(await readFile(path, "utf8").catch(() => null)).toBeNull();

    // the same head, but gpd was away: the next pull passes again
    st.down = null;
    await r.pull();
    expect(await readFile(path, "utf8")).toBe(`GITHUB_PERSONAL_ACCESS_TOKEN=${V}\n`);
    expect(r.info("mac").sinks.find((s) => s.id === "mcp-github-gpd")).toMatchObject({ state: { GITHUB_PERSONAL_ACCESS_TOKEN: "same" }, error: null });
    // an env file no sink names is pruned on gpd too
    expect((await readdir(join(home, ".claude", "mcp-env"))).sort()).toEqual(["github.env"]);
  });

  test("a reader with no ssh machines reports no state for gpd's sinks", async () => {
    const f = await base();
    f.sinks["gpd-env"] = { machine: "gpd", path: "/home/eric/app.env", format: "dotenv", keys: { CF_TOKEN: "cf_token" } };
    await publish(f, signer);
    const r = await reader();
    expect(r.info("mac").sinks.find((s) => s.id === "gpd-env")).toMatchObject({ state: {}, error: null });
  });
});
