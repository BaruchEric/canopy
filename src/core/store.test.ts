import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, readlink, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  addSource,
  agentFor,
  defaultLabel,
  loadConfig,
  normalizeWorkspace,
  rememberRoot,
  removeSource,
  removeWorkspace,
  saveConfig,
  setArchived,
  setFavorite,
  setKeepShells,
  setProfile,
  setRepoAgent,
  setRole,
  setTask,
  setWorkspaceLook,
  slugify,
  tasksFor,
  uniqueId,
  upsertWorkspace,
} from "./store";
import { DEFAULT_AGENT, effectivePrimary } from "./types";

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

  test.skipIf(process.getuid?.() === 0)("a failed config read rejects edits without erasing settings", async () => {
    const path = join(dir, "config.json");
    const original = JSON.stringify({ favorites: ["/original"], recentRoots: ["/original"] });
    await writeFile(path, original);
    await chmod(path, 0);
    try {
      await expect(rememberRoot("/new")).rejects.toThrow();
    } finally {
      await chmod(path, 0o600);
    }
    expect(await readFile(path, "utf8")).toBe(original);
    await rm(path);
  });

  test("an unreadable config link rejects edits without replacing the link", async () => {
    const path = join(dir, "config.json");
    await symlink("config.json", path);
    try {
      await expect(rememberRoot("/new")).rejects.toThrow();
      expect(await readlink(path)).toBe("config.json");
    } finally {
      await rm(path);
    }
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

  test("a repo's override persists by path and vanishes when emptied", async () => {
    const opus = { harness: "claude", model: "opus", effort: "high", yolo: true, extra: "" } as const;
    let routes = await setRepoAgent("/Users/me/dev/x", { all: opus });
    expect(routes.repos).toEqual({ "/Users/me/dev/x": { all: opus } });
    expect(routes.profiles["default"]).toEqual(DEFAULT_AGENT);
    let cfg = await loadConfig();
    expect(agentFor(cfg, "/Users/me/dev/x")).toEqual(opus);
    expect(agentFor(cfg, "/Users/me/dev/x", "chat")).toEqual(opus);
    expect(agentFor(cfg, "/Users/me/dev/y")).toEqual(DEFAULT_AGENT);
    // a stray value from a request is repaired, not stored
    routes = await setRepoAgent("ssh://wsl/home/me/z", {
      all: { ...DEFAULT_AGENT, model: "gpt" as unknown as "opus", extra: " --x " },
    });
    expect(routes.repos["ssh://wsl/home/me/z"]).toEqual({ all: { ...DEFAULT_AGENT, extra: "--x" } });
    routes = await setRepoAgent("/Users/me/dev/x", {});
    expect(Object.keys(routes.repos)).toEqual(["ssh://wsl/home/me/z"]);
    cfg = await loadConfig();
    expect(cfg.agents["/Users/me/dev/x"]).toBeUndefined();
    await setRepoAgent("ssh://wsl/home/me/z", {});
  });

  test("an entry written before roles reads as the repo's whole pick", async () => {
    const path = join(dir, "config.json");
    const before = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    await writeFile(path, JSON.stringify({ ...before, agents: { "/old": { model: "sonnet", effort: "low", yolo: false, extra: "" } } }));
    const cfg = await loadConfig();
    expect(cfg.agents["/old"]).toEqual({ all: { harness: "claude", model: "sonnet", effort: "low", yolo: false, extra: "" } });
    expect(agentFor(cfg, "/old", "job").model).toBe("sonnet");
    await setRepoAgent("/old", {});
  });

  test("profiles and roles route every repo without an override", async () => {
    const review = { harness: "codex", model: "gpt-5.5", effort: "high", yolo: false, extra: "" } as const;
    let routes = await setProfile("review", review);
    expect(routes.profiles["review"]).toEqual(review);
    routes = await setRole("shell", { profile: "review" });
    expect(routes.roles).toEqual({ shell: { profile: "review" } });
    let cfg = await loadConfig();
    expect(agentFor(cfg, "/any")).toEqual(review);
    // the other roles stay on claude: codex runs only shells for now
    expect(agentFor(cfg, "/any", "chat")).toEqual(DEFAULT_AGENT);
    // default can be changed and put back, never deleted
    routes = await setProfile("default", { ...DEFAULT_AGENT, model: "opus" });
    expect(routes.profiles["default"]?.model).toBe("opus");
    routes = await setProfile("default", null);
    expect(routes.profiles["default"]).toEqual(DEFAULT_AGENT);
    // a deleted profile leaves its routes naming nothing, and they fall through
    routes = await setProfile("review", null);
    expect(routes.profiles["review"]).toBeUndefined();
    cfg = await loadConfig();
    expect(agentFor(cfg, "/any")).toEqual(DEFAULT_AGENT);
    routes = await setRole("shell", null);
    expect(routes.roles).toEqual({});
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

  test("favorite repos persist by path, each once", async () => {
    expect((await loadConfig()).favorites).toEqual([]);
    expect(await setFavorite("/Users/me/dev/x", true)).toEqual(["/Users/me/dev/x"]);
    expect(await setFavorite("/Users/me/dev/x", true)).toEqual(["/Users/me/dev/x"]);
    expect(await setFavorite("ssh://wsl/home/me/z", true)).toEqual(["/Users/me/dev/x", "ssh://wsl/home/me/z"]);
    expect(await setFavorite("/Users/me/dev/x", false)).toEqual(["ssh://wsl/home/me/z"]);
    expect((await loadConfig()).favorites).toEqual(["ssh://wsl/home/me/z"]);
    await setFavorite("ssh://wsl/home/me/z", false);
  });

  test("the keep switch waits its turn with every other setting", async () => {
    const opus = { harness: "claude", model: "opus", effort: "high", yolo: true, extra: "" } as const;
    await Promise.all([setKeepShells(true), setRepoAgent("/Users/me/dev/k", { all: opus }), setKeepShells(true)]);
    let cfg = await loadConfig();
    expect(cfg.keepShells).toBe(true);
    expect(agentFor(cfg, "/Users/me/dev/k")).toEqual(opus);
    await Promise.all([setRepoAgent("/Users/me/dev/k", {}), setKeepShells(false)]);
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

  test("extendOwners is empty by default and keeps GitHub logins only", async () => {
    const path = join(dir, "config.json");
    await writeFile(path, JSON.stringify({}));
    expect((await loadConfig()).extendOwners).toEqual([]);
    await writeFile(path, JSON.stringify({ extendOwners: ["acme", "", "-bad", "a/b", 7, "Side-Org", "acme"] }));
    expect((await loadConfig()).extendOwners).toEqual(["acme", "Side-Org"]);
  });
});

describe("task overrides", () => {
  test("set, replace, clear, and bad entries dropped on load", async () => {
    expect(await setTask("/r", "dev", { name: "dev", keep: true })).toEqual([{ name: "dev", keep: true }]);
    expect(await setTask("/r", "dev", { name: "dev", keep: false, cmd: "x" })).toEqual([{ name: "dev", keep: false, cmd: "x" }]);
    await setTask("/r", "web", { name: "web", cmd: "y" });
    expect(tasksFor(await loadConfig(), "/r").map((t) => t.name)).toEqual(["dev", "web"]);
    expect(await setTask("/r", "dev", { name: "dev" })).toEqual([{ name: "web", cmd: "y" }]);
    expect(await setTask("/r", "web", null)).toEqual([]);
    expect((await loadConfig()).tasks["/r"]).toBeUndefined();
    const cfg = await loadConfig();
    await saveConfig({ ...cfg, tasks: { "/s": [{ name: "ok", cmd: "a" }, { name: "Bad" } as never] } });
    expect(tasksFor(await loadConfig(), "/s")).toEqual([{ name: "ok", cmd: "a" }]);
  });
});

describe("workspace look", () => {
  test("keeps a primary that is a member and a known color", () => {
    expect(normalizeWorkspace({ name: "w", repos: ["/a", "/b"], primary: "/b", color: "sky" })).toEqual({
      name: "w",
      repos: ["/a", "/b"],
      primary: "/b",
      color: "sky",
    });
  });
  test("drops a primary that is not a member, and a color not in the palette", () => {
    expect(normalizeWorkspace({ name: "w", repos: ["/a"], primary: "/zzz", color: "#ff0000" })).toEqual({ name: "w", repos: ["/a"] });
  });
  test("refuses junk", () => {
    expect(normalizeWorkspace(null)).toBeNull();
    expect(normalizeWorkspace({ name: 3, repos: [] })).toBeNull();
    expect(normalizeWorkspace({ name: "w", repos: "x" })).toBeNull();
  });
  test("the effective primary is the marked one, else the first member, else none", () => {
    expect(effectivePrimary({ name: "w", repos: ["/a", "/b"], primary: "/b" })).toBe("/b");
    expect(effectivePrimary({ name: "w", repos: ["/a", "/b"] })).toBe("/a");
    expect(effectivePrimary({ name: "w", repos: [] })).toBeNull();
  });
});

describe("workspace look updates", () => {
  test("sets and clears primary and color without touching members", async () => {
    await upsertWorkspace("look", ["/a", "/b"]);
    let ws = await setWorkspaceLook("look", { primary: "/b", color: "rust" });
    expect(ws.find((w) => w.name === "look")).toEqual({ name: "look", repos: ["/a", "/b"], primary: "/b", color: "rust" });
    ws = await setWorkspaceLook("look", { color: null });
    expect(ws.find((w) => w.name === "look")).toEqual({ name: "look", repos: ["/a", "/b"], primary: "/b" });
  });
  test("refuses a primary that is not a member, and an unknown workspace", async () => {
    await expect(setWorkspaceLook("look", { primary: "/zzz" })).rejects.toThrow("not a member of look");
    await expect(setWorkspaceLook("nope", { color: "sky" })).rejects.toThrow("unknown workspace");
  });
  test("removing the primary member clears primary", async () => {
    const ws = await removeWorkspace("look", "/b");
    expect(ws.find((w) => w.name === "look")).toEqual({ name: "look", repos: ["/a"] });
    await removeWorkspace("look");
  });
});
