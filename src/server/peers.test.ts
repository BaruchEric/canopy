import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Repo } from "../core/types";
import { peerSettingsFromEnv, startServer } from "./index";

let scratch: string;
let root: string;
let other: string;
let server: { port: number; stop: () => void };
const saved: Record<string, string | undefined> = {};
const url = (p: string) => `http://127.0.0.1:${server.port}${p}`;
const git = (cwd: string, ...args: string[]) => Bun.$`git -C ${cwd} ${args}`.quiet();
const peersConfig = (peerSync: string) =>
  JSON.stringify({ self: "mac", peerSync, seed: [], peers: [{ name: "mini", alias: null, root: other, role: "git" }] });

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "canopy-peers-srv-"));
  saved["CANOPY_CONFIG_DIR"] = process.env["CANOPY_CONFIG_DIR"];
  process.env["CANOPY_CONFIG_DIR"] = join(scratch, "config");
  root = join(scratch, "root");
  other = join(scratch, "other");
  await mkdir(join(root, "app"), { recursive: true });
  await git(join(root, "app"), "init", "-q", "-b", "main");
  await git(join(root, "app"), "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "one");
  await mkdir(other, { recursive: true });
  await Bun.$`git clone -q ${join(root, "app")} ${join(other, "app")}`.quiet();
  await git(join(other, "app"), "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "two");
  await mkdir(join(scratch, "config"), { recursive: true });
  // alias null is how a test names a local peer; config validation requires
  // an ssh alias, so the test writes the config the server reads through a
  // test hook: CANOPY_PEERS_JSON (see peerSettingsFromEnv below).
  process.env["CANOPY_PEERS_JSON"] = peersConfig("on");
  server = await startServer({ root, port: 0 });
});

afterAll(async () => {
  server.stop();
  delete process.env["CANOPY_PEERS_JSON"];
  process.env["CANOPY_CONFIG_DIR"] = saved["CANOPY_CONFIG_DIR"];
  await rm(scratch, { recursive: true, force: true });
});

describe("peer routes", () => {
  test("GET /api/peers", async () => {
    const body = await (await fetch(url("/api/peers"))).json();
    expect(body).toMatchObject({ self: "mac", sync: "on", peers: [{ name: "mini" }] });
  });

  test("sync one repo: init, fetch, fast-forward, state on the repo", async () => {
    const r = await fetch(url("/api/repos/peer?id=app"), { method: "POST", body: JSON.stringify({ action: "sync" }) });
    expect(r.status).toBe(200);
    const repo = (await r.json()) as Repo;
    expect(repo.peers?.moved.map((m) => m.branch)).toEqual(["main"]);
  });

  test("bad requests", async () => {
    const bad = (body: unknown, id = "app") => fetch(url(`/api/repos/peer?id=${id}`), { method: "POST", body: JSON.stringify(body) });
    expect((await bad({ action: "dance" })).status).toBe(400);
    expect((await bad({ action: "take", peer: "nobody", branch: "main" })).status).toBe(404);
    expect((await bad({ action: "take", peer: "mini", branch: "main" })).status).toBe(409);
    expect((await bad({ action: "sync" }, "nope")).status).toBe(404);
  });

  test("POST /api/peers/sync answers 202 and runs the pass in the background", async () => {
    type Seen = { name: string; ok: boolean; at: number };
    const seenAt = async (): Promise<number> => {
      const body = (await (await fetch(url("/api/peers"))).json()) as { seen: Seen[] };
      return body.seen.find((s) => s.name === "mini")?.at ?? 0;
    };
    const before = await seenAt();
    const r = await fetch(url("/api/peers/sync"), { method: "POST" });
    expect(r.status).toBe(202);
    expect(await r.json()).toEqual({});
    // A 202 only promises the pass started; wait for it to actually run
    // (a fresh, later timestamp for the peer it saw), not just for the response.
    const start = Date.now();
    let after = await seenAt();
    while (after <= before && Date.now() - start < 10_000) {
      await Bun.sleep(50);
      after = await seenAt();
    }
    expect(after).toBeGreaterThan(before);
  });
});

describe("dry to on: state.inited gates a non-dry initRepo", () => {
  test("a dry pass sets up no peer remote; flipping to on sets it up without a restart", async () => {
    await mkdir(join(root, "lib"), { recursive: true });
    await git(join(root, "lib"), "init", "-q", "-b", "main");
    await git(join(root, "lib"), "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "one");
    await mkdir(other, { recursive: true });
    await Bun.$`git clone -q ${join(root, "lib")} ${join(other, "lib")}`.quiet();
    await fetch(url("/api/rescan"), { method: "POST" });

    const hasPeers = async (): Promise<boolean> => {
      const tree = (await (await fetch(url("/api/tree"))).json()) as { repos: Repo[] };
      return tree.repos.find((r) => r.id === "lib")?.peers !== undefined;
    };
    const remoteUrl = () => Bun.$`git -C ${join(root, "lib")} remote get-url mini`.quiet().nothrow();
    const pushUrl = () => Bun.$`git -C ${join(root, "lib")} config --get remote.mini.pushurl`.quiet().nothrow();

    process.env["CANOPY_PEERS_JSON"] = peersConfig("dry");
    await fetch(url("/api/peers/sync"), { method: "POST" });
    const dryStart = Date.now();
    while (!(await hasPeers()) && Date.now() - dryStart < 10_000) await Bun.sleep(50);
    expect(await hasPeers()).toBe(true);
    expect((await remoteUrl()).exitCode).not.toBe(0);

    process.env["CANOPY_PEERS_JSON"] = peersConfig("on");
    await fetch(url("/api/peers/sync"), { method: "POST" });
    const onStart = Date.now();
    let pu = await pushUrl();
    while (pu.exitCode !== 0 && Date.now() - onStart < 10_000) {
      await Bun.sleep(50);
      pu = await pushUrl();
    }
    expect(pu.exitCode).toBe(0);
    expect(pu.stdout.toString().trim()).toBe("canopy-peer-no-push");

    process.env["CANOPY_PEERS_JSON"] = peersConfig("on");
  });
});

describe("peerSettingsFromEnv: the CANOPY_PEERS_JSON test hook", () => {
  test("used only under NODE_ENV=test", () => {
    const raw = JSON.stringify({ self: "mac", peerSync: "on", seed: [], peers: [] });
    expect(peerSettingsFromEnv({ NODE_ENV: "test", CANOPY_PEERS_JSON: raw })).toEqual({
      self: "mac",
      peerSync: "on",
      seed: [],
      peers: [],
    });
  });

  test("ignored outside NODE_ENV=test even when set", () => {
    const raw = JSON.stringify({ self: "mac", peerSync: "on", seed: [], peers: [] });
    expect(peerSettingsFromEnv({ NODE_ENV: "production", CANOPY_PEERS_JSON: raw })).toBeNull();
    expect(peerSettingsFromEnv({ CANOPY_PEERS_JSON: raw })).toBeNull();
  });

  test("null under NODE_ENV=test with nothing set", () => {
    expect(peerSettingsFromEnv({ NODE_ENV: "test" })).toBeNull();
  });
});
