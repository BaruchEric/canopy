import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  addSource,
  defaultLabel,
  loadConfig,
  rememberRoot,
  removeSource,
  removeWorkspace,
  slugify,
  uniqueId,
  upsertWorkspace,
} from "./store";

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

  test("recent roots stay unique and capped", async () => {
    await rememberRoot("/a");
    await rememberRoot("/b");
    await rememberRoot("/a");
    const cfg = await loadConfig();
    expect(cfg.recentRoots.slice(0, 2)).toEqual(["/a", "/b"]);
  });
});
