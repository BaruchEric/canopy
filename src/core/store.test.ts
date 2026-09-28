import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  addSource,
  agentFor,
  defaultLabel,
  loadConfig,
  rememberRoot,
  removeSource,
  removeWorkspace,
  saveConfig,
  setAgent,
  setArchived,
  setKeepShells,
  slugify,
  uniqueId,
  upsertWorkspace,
} from "./store";
import { DEFAULT_AGENT } from "./types";

let dir = "";
const prev = process.env["CANOPY_CONFIG_DIR"];

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "canopy-cfg-"));
  process.env["CANOPY_CONFIG_DIR"] = dir;
});

afterAll(async () => {
  if (prev === undefined) delete process.env["CANOPY_CONFIG_DIR"];
  else process.env["CANOPY_CONFIG_DIR"] = prev;
  await rm(dir, { recursive: true, force: true });
});

describe("config store", () => {
  test("defaults when no file exists", async () => {
    const cfg = await loadConfig();
    expect(cfg.port).toBe(7850);
    expect(cfg.workspaces).toEqual([]);
    expect(cfg.fetch).toBe(true);
  });

  test("fetch is off only when the file says so in so many words", async () => {
    const path = join(dir, "config.json");
    await writeFile(path, JSON.stringify({ fetch: false }));
    expect((await loadConfig()).fetch).toBe(false);
    await writeFile(path, JSON.stringify({ fetch: "no" }));
    expect((await loadConfig()).fetch).toBe(true);
    await rm(path);
  });

  test("workspace upsert dedupes and appends", async () => {
    await upsertWorkspace("web", ["web-apps/ripe", "web-apps/Tally"]);
    const ws = await upsertWorkspace("web", ["web-apps/ripe", "web-apps/clms"]);
    expect(ws).toEqual([
      {
        name: "web",
        repos: ["web-apps/ripe", "web-apps/Tally", "web-apps/clms"],
      },
    ]);
  });

  test("remove one repo, then the whole workspace", async () => {
    let ws = await removeWorkspace("web", "web-apps/Tally");
    expect(ws[0]?.repos).toEqual(["web-apps/ripe", "web-apps/clms"]);
    ws = await removeWorkspace("web");
    expect(ws).toEqual([]);
  });

  test("labels become ids, unique and never the launch root's", () => {
    expect(slugify("wsl:dev")).toBe("wsl-dev");
    expect(slugify("  My Work Stuff ")).toBe("my-work-stuff");
    expect(slugify("***")).toBe("source");
    expect(uniqueId("dev", ["dev", "dev-2"])).toBe("dev-3");
    expect(uniqueId("launch", [])).toBe("launch-2");
  });

  test("a default label is the folder name, with the host for ssh", () => {
    expect(defaultLabel({ kind: "local", path: "/Users/me/work/" })).toBe("work");
    expect(defaultLabel({ kind: "ssh", host: "wsl", path: "/home/me/dev" })).toBe("wsl:dev");
    expect(defaultLabel({ kind: "forgejo", url: "https://git.beric.ca" })).toBe("git.beric.ca");
    expect(defaultLabel({ kind: "forgejo", url: "http://192.168.1.76:3030" })).toBe("192.168.1.76");
  });

  test("sources persist, refuse a duplicate place, and go away", async () => {
    const a = await addSource({ kind: "local", path: "/Users/me/work" });
    expect(a).toEqual({ id: "work", label: "work", kind: "local", path: "/Users/me/work" });
    const b = await addSource({ kind: "ssh", host: "wsl", path: "/home/me/work", label: "work" });
    expect(b.id).toBe("work-2");
    await expect(addSource({ kind: "local", path: "/Users/me/work" })).rejects.toThrow(
      "already added as work",
    );
    // same path on a different host is a different place
    const c = await addSource({ kind: "ssh", host: "mini", path: "/home/me/work" });
    expect(c.id).toBe("mini-work");
    expect((await loadConfig()).sources.map((s) => s.id)).toEqual(["work", "work-2", "mini-work"]);
    const left = await removeSource("work-2");
    expect(left.map((s) => s.id)).toEqual(["work", "mini-work"]);
  });

  test("a forge is stored by address, with the token's path and never the token", async () => {
    const f = await addSource({
      kind: "forgejo",
      url: "https://git.beric.ca",
      tokenFile: "~/secrets/forgejo.txt",
    });
    expect(f).toEqual({
      id: "git-beric-ca",
      label: "git.beric.ca",
      kind: "forgejo",
      url: "https://git.beric.ca",
      tokenFile: "~/secrets/forgejo.txt",
    });
    await expect(addSource({ kind: "forgejo", url: "https://git.beric.ca" })).rejects.toThrow(
      "already added as git.beric.ca",
    );
    // a folder and a forge are never the same place, whatever they are called
    const dirSource = await addSource({ kind: "local", path: "/tmp/git.beric.ca" });
    expect(dirSource.id).toBe("git-beric-ca-2");
    await removeSource("git-beric-ca");
    await removeSource("git-beric-ca-2");
  });

  test("agent settings persist per repo path and vanish at the defaults", async () => {
    const opus = { model: "opus", effort: "high", yolo: true, extra: "" } as const;
    let agents = await setAgent("/Users/me/dev/x", opus);
    expect(agents).toEqual({ "/Users/me/dev/x": opus });
    let cfg = await loadConfig();
    expect(agentFor(cfg, "/Users/me/dev/x")).toEqual(opus);
    expect(agentFor(cfg, "/Users/me/dev/y")).toEqual(DEFAULT_AGENT);
    // a stray value from a request is repaired, not stored
    agents = await setAgent("ssh://wsl/home/me/z", {
      ...DEFAULT_AGENT,
      model: "gpt" as unknown as "opus",
      extra: " --x ",
    });
    expect(agents["ssh://wsl/home/me/z"]).toEqual({ ...DEFAULT_AGENT, extra: "--x" });
    agents = await setAgent("/Users/me/dev/x", DEFAULT_AGENT);
    expect(Object.keys(agents)).toEqual(["ssh://wsl/home/me/z"]);
    cfg = await loadConfig();
    expect(cfg.agents["/Users/me/dev/x"]).toBeUndefined();
  });

  test("archived repos persist by path, each once", async () => {
    expect((await loadConfig()).archived).toEqual([]);
    expect(await setArchived("/Users/me/dev/x", true)).toEqual(["/Users/me/dev/x"]);
    expect(await setArchived("/Users/me/dev/x", true)).toEqual(["/Users/me/dev/x"]);
    expect(await setArchived("ssh://wsl/home/me/z", true)).toEqual(["/Users/me/dev/x", "ssh://wsl/home/me/z"]);
    expect(await setArchived("/Users/me/dev/x", false)).toEqual(["ssh://wsl/home/me/z"]);
    expect((await loadConfig()).archived).toEqual(["ssh://wsl/home/me/z"]);
    await setArchived("ssh://wsl/home/me/z", false);
  });

  test("the keep switch waits its turn with every other setting", async () => {
    const opus = { model: "opus", effort: "high", yolo: true, extra: "" } as const;
    await Promise.all([setKeepShells(true), setAgent("/Users/me/dev/k", opus), setKeepShells(true)]);
    let cfg = await loadConfig();
    expect(cfg.keepShells).toBe(true);
    expect(agentFor(cfg, "/Users/me/dev/k")).toEqual(opus);
    await Promise.all([setAgent("/Users/me/dev/k", DEFAULT_AGENT), setKeepShells(false)]);
    cfg = await loadConfig();
    expect(cfg.keepShells).toBe(false);
    expect(cfg.agents["/Users/me/dev/k"]).toBeUndefined();
  });

  test("two saves at once each land whole, and neither loses its file", async () => {
    const base = await loadConfig();
    const long = { ...base, workspaces: [{ name: "long", repos: Array.from({ length: 200 }, (_, i) => `repo-${i}`) }] };
    for (let i = 0; i < 20; i++) {
      await Promise.all([saveConfig(long), saveConfig({ ...base, keepShells: true })]);
      const cfg = await loadConfig();
      expect(cfg.keepShells === true || cfg.workspaces.length === 1).toBe(true);
    }
    // nothing was quarantined as unreadable, and no temporary file is left
    const left = await readdir(dir);
    expect(left.filter((f) => f.includes(".corrupt-") || f.includes(".tmp-"))).toEqual([]);
    await saveConfig(base);
  });

  test("recent roots stay unique and capped", async () => {
    await rememberRoot("/a");
    await rememberRoot("/b");
    await rememberRoot("/a");
    const cfg = await loadConfig();
    expect(cfg.recentRoots.slice(0, 2)).toEqual(["/a", "/b"]);
  });

  test("peer fields default and repair", async () => {
    const path = join(dir, "config.json");
    await writeFile(
      path,
      JSON.stringify({
        self: "mac",
        peers: [{ name: "mini", alias: "mini-peer", root: "dev" }],
        peerSync: "loud",
        seed: "x",
      }),
    );
    const cfg = await loadConfig();
    expect(cfg.self).toBe("mac");
    expect(cfg.peers).toEqual([{ name: "mini", alias: "mini-peer", root: "dev", role: "git" }]);
    expect(cfg.peerSync).toBe("off");
    expect(cfg.seed).toEqual([".env", ".env.local"]);
  });
});
