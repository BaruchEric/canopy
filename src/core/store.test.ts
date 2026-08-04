import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadConfig,
  rememberRoot,
  removeWorkspace,
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

  test("recent roots stay unique and capped", async () => {
    await rememberRoot("/a");
    await rememberRoot("/b");
    await rememberRoot("/a");
    const cfg = await loadConfig();
    expect(cfg.recentRoots.slice(0, 2)).toEqual(["/a", "/b"]);
  });
});
