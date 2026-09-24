import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { peerUrl } from "../core/peers";
import type { Peer, Repo } from "../core/types";
import { isPeerRemote, peerSettingsFromEnv, startServer, withPeering } from "./index";

let scratch: string;
let root: string;
let other: string;
let server: { port: number; stop: () => void };
const saved: Record<string, string | undefined> = {};
const url = (p: string) => `http://127.0.0.1:${server.port}${p}`;
const git = (cwd: string, ...args: string[]) => Bun.$`git -C ${cwd} ${args}`.quiet();
const peersConfig = (peerSync: string) =>
  JSON.stringify({ self: "mac", peerSync, seed: [], peers: [{ name: "mini", alias: null, root: other, role: "git" }] });

type Seen = { name: string; ok: boolean; at: number };
/** The last whole-tree pass's timestamp for reaching "mini", or 0 before any
 *  pass has run; polling for this to advance is how a test waits for a
 *  background /api/peers/sync to actually finish, not just answer 202. */
const seenAt = async (): Promise<number> => {
  const body = (await (await fetch(url("/api/peers"))).json()) as { seen: Seen[] };
  return body.seen.find((s) => s.name === "mini")?.at ?? 0;
};

const waitFor = async (pred: () => boolean | Promise<boolean>, ms = 10_000): Promise<void> => {
  const start = Date.now();
  while (!(await pred())) {
    if (Date.now() - start > ms) return;
    await Bun.sleep(50);
  }
};

/** Every `repo` event for one id off the SSE stream, from subscription
 *  onward; `opened` resolves once the stream is actually connected. */
function listenRepo(id: string): { events: Repo[]; stop: () => void; opened: Promise<void> } {
  const events: Repo[] = [];
  const ctl = new AbortController();
  let openIt: () => void = () => {};
  const opened = new Promise<void>((r) => {
    openIt = r;
  });
  void (async () => {
    const res = await fetch(url("/api/events"), { signal: ctl.signal });
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let buf = "";
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        if (buf.includes(": hello")) openIt();
        let nl: number;
        while ((nl = buf.indexOf("\n\n")) !== -1) {
          const chunk = buf.slice(0, nl);
          buf = buf.slice(nl + 2);
          const line = chunk.split("\n").find((l) => l.startsWith("data: "));
          if (!line) continue;
          const ev = JSON.parse(line.slice(6)) as { type: string; repo?: Repo };
          if (ev.type === "repo" && ev.repo?.id === id) events.push(ev.repo);
        }
      }
    } catch {
      // aborted
    }
  })();
  return { events, stop: () => ctl.abort(), opened };
}

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

  test("body validation: an object, a known action, and peer/branch for take and track", async () => {
    const bad = (body: unknown) => fetch(url("/api/repos/peer?id=app"), { method: "POST", body: JSON.stringify(body) });
    expect((await bad(null)).status).toBe(400);
    expect((await bad("hello")).status).toBe(400);
    expect((await bad([1, 2, 3])).status).toBe(400);
    // take/track need a peer and a non-empty branch, checked before the
    // peer is even looked up (a missing peer is 400, an unknown one is 404)
    expect((await bad({ action: "take", branch: "main" })).status).toBe(400);
    expect((await bad({ action: "take", peer: "mini" })).status).toBe(400);
    expect((await bad({ action: "take", peer: "mini", branch: "" })).status).toBe(400);
    expect((await bad({ action: "track", peer: 7, branch: "main" })).status).toBe(400);
  });

  test("409 when peer sync is off, for every action", async () => {
    process.env["CANOPY_PEERS_JSON"] = peersConfig("off");
    try {
      const off = (body: unknown) => fetch(url("/api/repos/peer?id=app"), { method: "POST", body: JSON.stringify(body) });
      expect((await off({ action: "sync" })).status).toBe(409);
      expect((await off({ action: "seed" })).status).toBe(409);
      expect((await off({ action: "take", peer: "mini", branch: "main" })).status).toBe(409);
      expect((await off({ action: "track", peer: "mini", branch: "main" })).status).toBe(409);
    } finally {
      process.env["CANOPY_PEERS_JSON"] = peersConfig("on");
    }
  });

  test("POST /api/peers/sync answers 202 and runs the pass in the background", async () => {
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
  });
});

// The active-run/flow 409 (finding #4) is not covered by a live test: a run
// only starts against the real `claude` binary, since `Bun.which`/`Bun.spawn`
// resolve a bare command name from the PATH the process started with, not a
// later `process.env["PATH"]` mutation (confirmed empirically: the same hole
// presence.test.ts's device-run test has). Faking it here would spawn Eric's
// real claude CLI under his login rather than a stand-in, so per finding #4's
// "else say so", this is said here rather than tested: the check itself is
// `state.runner.activeFor(repo.id)` / `state.flows.activeFor(repo.id)`, the
// same one the `run` action already relies on and already has coverage for
// elsewhere.

describe("initRepo and ownRemotesOf leave a user's own same-named remote alone", () => {
  test("a pre-existing mini remote without the no-push marker survives a sync action", async () => {
    const userRepo = join(root, "userowned");
    await mkdir(userRepo, { recursive: true });
    await git(userRepo, "init", "-q", "-b", "main");
    await git(userRepo, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "one");
    await git(userRepo, "remote", "add", "mini", "https://example.invalid/mine.git");
    await fetch(url("/api/rescan"), { method: "POST" });

    const r = await fetch(url("/api/repos/peer?id=userowned"), { method: "POST", body: JSON.stringify({ action: "sync" }) });
    expect(r.status).toBe(200);
    expect((await git(userRepo, "remote", "get-url", "mini")).stdout.toString().trim()).toBe("https://example.invalid/mine.git");
    expect((await Bun.$`git -C ${userRepo} config --get remote.mini.pushurl`.quiet().nothrow()).exitCode).not.toBe(0);
  });

  test("a remote a crash left with the peer's url but no marker is repaired, not mistaken for the user's own", async () => {
    const crashRepo = join(root, "crashed");
    await mkdir(crashRepo, { recursive: true });
    await git(crashRepo, "init", "-q", "-b", "main");
    await git(crashRepo, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "one");
    const peer: Peer = { name: "mini", alias: null, root: other, role: "git" };
    // simulates initRepo crashing right after `remote add`: the url is
    // already canopy's, but the marker was never written
    await git(crashRepo, "remote", "add", "mini", peerUrl(peer, "crashed"));
    await fetch(url("/api/rescan"), { method: "POST" });

    expect(await isPeerRemote(crashRepo, "crashed", peer)).toBe(true);

    const r = await fetch(url("/api/repos/peer?id=crashed"), { method: "POST", body: JSON.stringify({ action: "sync" }) });
    expect(r.status).toBe(200);
    expect((await Bun.$`git -C ${crashRepo} config --get remote.mini.pushurl`.quiet().nothrow()).stdout.toString().trim()).toBe(
      "canopy-peer-no-push",
    );
    expect(await isPeerRemote(crashRepo, "crashed", peer)).toBe(true);
  });

  test("isPeerRemote: only the no-push marker or an exact peer-url match count as canopy's own", async () => {
    const userRepo2 = join(root, "userowned2");
    await mkdir(userRepo2, { recursive: true });
    await git(userRepo2, "init", "-q", "-b", "main");
    await git(userRepo2, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "one");
    const peer: Peer = { name: "mini", alias: null, root: other, role: "git" };
    await git(userRepo2, "remote", "add", "mini", "https://example.invalid/definitely-not-mine.git");
    expect(await isPeerRemote(userRepo2, "userowned2", peer)).toBe(false);
  });
});

describe("applyPeerState broadcasts only on a real change", () => {
  test("a second whole-tree pass with the same outcome does not re-broadcast the repo", async () => {
    const stableRoot = join(root, "stable");
    const stableOther = join(other, "stable");
    await mkdir(stableRoot, { recursive: true });
    await git(stableRoot, "init", "-q", "-b", "main");
    await git(stableRoot, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "one");
    await Bun.$`git clone -q ${stableRoot} ${stableOther}`.quiet();
    await fetch(url("/api/rescan"), { method: "POST" });

    const before1 = await seenAt();
    await fetch(url("/api/peers/sync"), { method: "POST" });
    await waitFor(async () => (await seenAt()) > before1);
    // a genuinely settled first pass: past the fs watcher's own 400ms
    // debounce on the git fetch this pass just did, so a watcher-driven
    // status rebroadcast (same peers, unconditional) does not read as a
    // second applyPeerState broadcast below
    await Bun.sleep(500);
    const tree1 = (await (await fetch(url("/api/tree"))).json()) as { repos: Repo[] };
    const at1 = tree1.repos.find((r) => r.id === "stable")?.peers?.at;
    expect(at1).toBeDefined();

    const listener = listenRepo("stable");
    await listener.opened;
    try {
      // a second, genuinely separate pass (waited for the first to settle
      // above) with the same outcome must not compute a new peer state:
      // the watcher may still rebroadcast the repo on its own (a fetch
      // touches .git/refs regardless of outcome), but never with a fresh
      // peers.at, which is what applyPeerState alone would produce
      const before2 = await seenAt();
      await fetch(url("/api/peers/sync"), { method: "POST" });
      await waitFor(async () => (await seenAt()) > before2);
      // give a watcher-driven rebroadcast, and a stray second notify, time to land
      await Bun.sleep(600);
      // the fs watcher may still rebroadcast the repo on its own (a fetch
      // touches .git/refs regardless of outcome), and an unrelated
      // background pass (the server's own startup activity check) may
      // legitimately relink a newer, still-unchanged peer state onto a
      // rescan; neither is the thing under test. What applyPeerState alone
      // would do on an unchanged pass is broadcast nothing with a fresh
      // peers.at, so that is the one thing asserted here.
      expect(listener.events.every((r) => r.peers?.at === at1)).toBe(true);
    } finally {
      listener.stop();
    }
  });
});

describe("a diverged branch is notified once", () => {
  test(
    "two passes over the same divergence call the notifier once",
    async () => {
      const divRoot = join(root, "div");
      const divOther = join(other, "div");
      await mkdir(divRoot, { recursive: true });
      await git(divRoot, "init", "-q", "-b", "main");
      await git(divRoot, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "base");
      await Bun.$`git clone -q ${divRoot} ${divOther}`.quiet();
      await git(divRoot, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "root-only");
      await git(divOther, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "peer-only");
      await fetch(url("/api/rescan"), { method: "POST" });

      // a ctl stand-in ahead of the real one on PATH, so the notice never
      // reaches Eric: it only logs its call to a file this test reads.
      // notifyDiverged resolves ctl through an explicit PATH option, which
      // is what makes this prepend visible to it (Bun.which with no options
      // ignores a process.env mutation made after the process started).
      const bin = join(scratch, "ctlbin");
      await mkdir(bin, { recursive: true });
      const log = join(scratch, "ctl.log");
      await Bun.write(join(bin, "ctl"), `#!/bin/sh\necho "$@" >> ${log}\n`);
      await Bun.$`chmod +x ${join(bin, "ctl")}`.quiet();
      const path = process.env["PATH"];
      process.env["PATH"] = `${bin}:${path}`;
      const lines = async (): Promise<number> =>
        existsSync(log) ? (await Bun.file(log).text()).split("\n").filter(Boolean).length : 0;
      try {
        const sync = () => fetch(url("/api/repos/peer?id=div"), { method: "POST", body: JSON.stringify({ action: "sync" }) });
        const r1 = await sync();
        expect(r1.status).toBe(200);
        const repo1 = (await r1.json()) as Repo;
        expect(repo1.peers?.diverged.length).toBe(1);
        await waitFor(async () => (await lines()) >= 1, 5_000);
        expect(await lines()).toBe(1);

        const r2 = await sync();
        expect(r2.status).toBe(200);
        await Bun.sleep(300); // a stray second notify would have landed by now
        expect(await lines()).toBe(1);
      } finally {
        process.env["PATH"] = path;
      }
    },
    20_000,
  );
});

describe("dry mode and a repo only the peer has", () => {
  test("makes no scan and no error state for it", async () => {
    const peerOnly = join(other, "houseonly");
    await mkdir(peerOnly, { recursive: true });
    await git(peerOnly, "init", "-q", "-b", "main");
    await git(peerOnly, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "one");

    process.env["CANOPY_PEERS_JSON"] = peersConfig("dry");
    const logged: unknown[][] = [];
    const origError = console.error;
    console.error = (...args: unknown[]) => {
      logged.push(args);
    };
    try {
      const before = await seenAt();
      const r = await fetch(url("/api/peers/sync"), { method: "POST" });
      expect(r.status).toBe(202);
      await waitFor(async () => (await seenAt()) > before);
    } finally {
      console.error = origError;
      process.env["CANOPY_PEERS_JSON"] = peersConfig("on");
    }
    const tree = (await (await fetch(url("/api/tree"))).json()) as { repos: Repo[] };
    expect(tree.repos.some((r) => r.id === "houseonly")).toBe(false);
    expect(logged.some((args) => args.some((a) => String(a).includes("houseonly")))).toBe(false);
  });
});

describe("withPeering", () => {
  test("three callers queued behind a holder never overlap", async () => {
    const state: { peering: Promise<void> | null } = { peering: null };
    const order: string[] = [];
    let releaseHolder!: () => void;
    const holderGate = new Promise<void>((r) => {
      releaseHolder = r;
    });

    const holder = withPeering(state, async () => {
      order.push("holder enter");
      await holderGate;
      order.push("holder exit");
    });

    // Three more callers "arrive" while the holder is still running, back
    // to back with no await between them: exactly the case that used to
    // wake every waiter together once the holder finished.
    const turn = (name: string) =>
      withPeering(state, async () => {
        order.push(`${name} enter`);
        await Bun.sleep(5);
        order.push(`${name} exit`);
      });
    const a = turn("a");
    const b = turn("b");
    const c = turn("c");

    // Give a wrongly-woken waiter time to start early; none should have.
    await Bun.sleep(30);
    expect(order).toEqual(["holder enter"]);

    releaseHolder();
    await Promise.all([holder, a, b, c]);

    expect(order).toEqual([
      "holder enter",
      "holder exit",
      "a enter",
      "a exit",
      "b enter",
      "b exit",
      "c enter",
      "c exit",
    ]);
  });

  test("one link rejecting does not break the chain for the next", async () => {
    const state: { peering: Promise<void> | null } = { peering: null };
    const order: string[] = [];

    const failing = withPeering(state, async () => {
      order.push("failing enter");
      throw new Error("boom");
    });
    const after = withPeering(state, async () => {
      order.push("after enter");
    });

    await expect(failing).rejects.toThrow("boom");
    await after;
    expect(order).toEqual(["failing enter", "after enter"]);
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
