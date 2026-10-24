import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LibrarySyncStatus } from "../core/libsync";
import { LibrarySync, type LibrarySyncSettings } from "./libsync";

const adapter = join(import.meta.dir, "../../lib/devhub/canopy.py");

let base: string;
/** ahead of every file time the test writes, as a real clock is of a seed's */
const T0 = Date.now() + 10_000_000;
const clock = { at: T0 };

interface Side {
  name: string;
  root: string;
  dir: string;
  hub: LibrarySync;
  settings: LibrarySyncSettings;
  refreshed: number;
}
const sides: Record<string, Side> = {};

/** the adapter's real locked write, with this side's root and state */
async function adapterWrite(side: { root: string; dir: string }, expect: Record<string, string | null>, files: Record<string, string>): Promise<"ok" | "changed"> {
  const child = Bun.spawn(["python3", adapter, "--root", side.root, "--state", side.dir, "--", "__sync-write"], {
    stdin: new TextEncoder().encode(JSON.stringify({ expect, files })),
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
  });
  const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  if (code === 3) return "changed";
  if (code !== 0) throw new Error(stderr);
  return "ok";
}

const categories = (host: string) => ({
  version: 1,
  host_root: host,
  helper_port: 7333,
  terminal_app: host.startsWith("/Users") ? "Ghostty" : "Terminal",
  trusted_origins: [],
  stale_days: 120,
  ignore: ["skills"],
  categories: { apps: { label: "Apps", keywords: ["app"] }, tools: { label: "Tools", keywords: ["cli"] } },
  overrides: {},
  links: { alpha: { dev_port: 6101 } },
  notes: { alpha: "first note" },
});

async function makeSide(name: string, host: string): Promise<Side> {
  const root = join(base, name, "dev");
  const dir = join(base, name, "state");
  await mkdir(join(root, "apps", "alpha"), { recursive: true });
  await mkdir(join(root, "tools"), { recursive: true });
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "categories.json"), JSON.stringify(categories(host), null, 2));
  await writeFile(join(dir, "tags.json"), JSON.stringify({ alpha: ["react"] }, null, 2));
  await writeFile(join(dir, "references.json"), "[]\n");
  const settings: LibrarySyncSettings = {
    mode: "on",
    self: name,
    backends: [
      { name: "mac", tailnet: "http://mac.test" },
      { name: "mini", tailnet: "http://mini.test" },
    ],
  };
  const side: Side = { name, root, dir, settings, refreshed: 0, hub: null as unknown as LibrarySync };
  side.hub = new LibrarySync({
    root,
    dir,
    settings: async () => side.settings,
    write: (expect, files) => adapterWrite(side, expect, files),
    refresh: async () => {
      side.refreshed++;
    },
    report: () => {},
    // each side reaches the other's routes as a peer's fetch would
    fetch: (async (input: string | URL | Request) => {
      const url = new URL(String(input));
      const other = sides[url.hostname.replace(/\.test$/, "")];
      if (!other) throw new Error("unreachable");
      return (await other.hub.handle(new Request(url.href), url)) ?? new Response("{}", { status: 404 });
    }) as typeof fetch,
    now: () => clock.at,
  });
  return side;
}

const readJson = async (side: Side, name: string): Promise<Record<string, unknown>> => JSON.parse(await readFile(join(side.dir, name), "utf8"));
const status = (side: Side): Promise<LibrarySyncStatus> => side.hub.status();
async function post(side: Side, body: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const url = new URL("http://x/api/library/sync");
  const res = await side.hub.handle(new Request(url.href, { method: "POST", body: JSON.stringify(body) }), url);
  return { status: res!.status, body: (await res!.json()) as Record<string, unknown> };
}

let mac: Side;
let mini: Side;

beforeAll(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), "canopy-libsync-test-")));
  mac = await makeSide("mac", "/Users/ericbaruch/dev");
  mini = await makeSide("mini", "/home/eric/dev");
  sides["mac"] = mac;
  sides["mini"] = mini;
});

afterAll(async () => {
  await rm(base, { recursive: true, force: true });
});

describe("Library sync between two backends", () => {
  test("before a join nothing is served or taken", async () => {
    const url = new URL("http://x/api/library/sync");
    const doc = await (await mac.hub.handle(new Request(url.href), url))!.json();
    expect(doc).toEqual({ backend: "mac", ready: false });
    await mini.hub.pullAll();
    expect((await status(mini)).joined).toBeNull();
  });

  test("an adopt from a backend that has not joined is refused", async () => {
    const r = await post(mini, { action: "adopt", backend: "mac" });
    expect(r.status).toBe(409);
    expect(String(r.body["error"])).toContain("has not joined");
  });

  test("the Mac seeds, the mini adopts, and the mini keeps its own host keys", async () => {
    await writeFile(join(mac.dir, "tags.json"), JSON.stringify({ alpha: ["react", "firebase"] }, null, 2));
    expect((await post(mac, { action: "seed" })).status).toBe(200);
    expect((await post(mac, { action: "seed" })).status).toBe(409);
    clock.at = T0 + 2_000;
    const r = await post(mini, { action: "adopt", backend: "mac" });
    expect(r.status).toBe(200);
    expect((r.body["joined"] as { how: string; from: string }).from).toBe("mac");
    expect(await readJson(mini, "tags.json")).toEqual({ alpha: ["react", "firebase"] });
    const cfg = await readJson(mini, "categories.json");
    expect(cfg["host_root"]).toBe("/home/eric/dev");
    expect(cfg["terminal_app"]).toBe("Terminal");
    expect(mini.refreshed).toBe(1);
    // the replaced tags.json was kept first
    const backups = await readdir(join(mini.dir, "sync-backups"));
    expect(backups.length).toBe(1);
    expect(JSON.parse(await readFile(join(mini.dir, "sync-backups", backups[0]!, "tags.json"), "utf8"))).toEqual({ alpha: ["react"] });
  });

  test("a tag made on the Mac reaches the mini on its next pull", async () => {
    clock.at = T0 + 3_000;
    await writeFile(join(mac.dir, "tags.json"), JSON.stringify({ alpha: ["react", "firebase", "vite"], beta: ["cli"] }, null, 2));
    await mini.hub.pullAll();
    expect(await readJson(mini, "tags.json")).toEqual({ alpha: ["react", "firebase", "vite"], beta: ["cli"] });
    const peer = (await status(mini)).peers.find((p) => p.name === "mac");
    expect(peer).toMatchObject({ taken: 2, deleted: 0, away: null, held: null });
  });

  test("a note deleted on the mini goes from the Mac, and the Mac's host keys stay", async () => {
    clock.at = T0 + 4_000;
    const cfg = await readJson(mini, "categories.json");
    cfg["notes"] = {};
    await writeFile(join(mini.dir, "categories.json"), JSON.stringify(cfg, null, 2));
    await mac.hub.pullAll();
    const macCfg = await readJson(mac, "categories.json");
    expect(macCfg["notes"]).toEqual({});
    expect(macCfg["host_root"]).toBe("/Users/ericbaruch/dev");
    expect(macCfg["terminal_app"]).toBe("Ghostty");
  });

  test("the newer of two edits to one entry wins on both sides", async () => {
    clock.at = T0 + 5_000;
    await writeFile(join(mac.dir, "tags.json"), JSON.stringify({ alpha: ["mac-edit"], beta: ["cli"] }, null, 2));
    await mac.hub.pullAll(); // stamps the Mac's edit at 5000
    clock.at = T0 + 6_000;
    await writeFile(join(mini.dir, "tags.json"), JSON.stringify({ alpha: ["mini-edit"], beta: ["cli"] }, null, 2));
    await mini.hub.pullAll();
    await mac.hub.pullAll();
    expect((await readJson(mini, "tags.json"))["alpha"]).toEqual(["mini-edit"]);
    expect((await readJson(mac, "tags.json"))["alpha"]).toEqual(["mini-edit"]);
  });

  test("a category deleted on the Mac stays on the mini while its folder there has projects", async () => {
    clock.at = T0 + 7_000;
    const cfg = await readJson(mac, "categories.json");
    cfg["categories"] = { tools: { label: "Tools", keywords: ["cli"] } };
    await writeFile(join(mac.dir, "categories.json"), JSON.stringify(cfg, null, 2));
    await mini.hub.pullAll();
    const miniCats = (await readJson(mini, "categories.json"))["categories"] as Record<string, unknown>;
    expect(Object.keys(miniCats).sort()).toEqual(["apps", "tools"]);
    expect((await status(mini)).peers.find((p) => p.name === "mac")?.kept).toEqual(["cat:apps"]);
  });

  test("a mass deletion is held until it is accepted", async () => {
    clock.at = T0 + 8_000;
    const many: Record<string, string[]> = {};
    for (let i = 0; i < 30; i++) many[`p${i}`] = ["x"];
    await writeFile(join(mac.dir, "tags.json"), JSON.stringify(many, null, 2));
    await mini.hub.pullAll();
    expect(Object.keys(await readJson(mini, "tags.json")).length).toBe(30);
    clock.at = T0 + 9_000;
    await writeFile(join(mac.dir, "tags.json"), "{}\n");
    await mini.hub.pullAll();
    expect(Object.keys(await readJson(mini, "tags.json")).length).toBe(30);
    const held = (await status(mini)).peers.find((p) => p.name === "mac")?.held;
    expect(held).toContain("--accept mac");
    const r = await post(mini, { action: "accept", backend: "mac" });
    expect(r.status).toBe(200);
    expect(await readJson(mini, "tags.json")).toEqual({});
  });

  test("dry mode reports what it would take and writes nothing", async () => {
    clock.at = T0 + 10_000;
    mini.settings = { ...mini.settings, mode: "dry" };
    await writeFile(join(mac.dir, "tags.json"), JSON.stringify({ dry: ["run"] }, null, 2));
    await mini.hub.pullAll();
    expect(await readJson(mini, "tags.json")).toEqual({});
    expect((await status(mini)).peers.find((p) => p.name === "mac")).toMatchObject({ dry: true, taken: 1 });
    mini.settings = { ...mini.settings, mode: "on" };
  });

  test("a file that does not parse stops the pass and nothing is written", async () => {
    clock.at = T0 + 11_000;
    await writeFile(join(mini.dir, "tags.json"), "{ not json");
    await mini.hub.pullAll();
    expect(await readFile(join(mini.dir, "tags.json"), "utf8")).toBe("{ not json");
    expect((await status(mini)).error).toContain("tags.json does not parse");
    await writeFile(join(mini.dir, "tags.json"), "{}\n");
    await mini.hub.pullAll();
    expect((await status(mini)).error).toBeNull();
  });

  test("an away backend is reported, not an error", async () => {
    mini.settings = { ...mini.settings, backends: [...mini.settings.backends, { name: "gpd", tailnet: "http://gpd.test" }] };
    await mini.hub.pullAll();
    const st = await status(mini);
    expect(st.error).toBeNull();
    expect(st.peers.find((p) => p.name === "gpd")?.away).toContain("not answering");
    mini.settings = { ...mini.settings, backends: mini.settings.backends.filter((b) => b.name !== "gpd") };
  });
});

describe("the adapter's locked write", () => {
  test("refuses when a file changed since the merge read it", async () => {
    const r = await adapterWrite(mini, { "tags.json": "0".repeat(64) }, { "tags.json": "{}\n" });
    expect(r).toBe("changed");
  });

  test("refuses a file it may not write", async () => {
    await expect(adapterWrite(mini, {}, { "../escape.json": "{}" })).rejects.toThrow("may not write");
  });
});
