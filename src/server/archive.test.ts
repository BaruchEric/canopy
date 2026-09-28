/**
 * Archiving a repo in canopy: the mark rides on the repo, survives a rescan
 * because it lives in the config, and comes off again.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../core/store";
import type { Repo } from "../core/types";
import { startServer } from "./index";

let scratch: string;
let server: { port: number; stop: () => void };
let saved: string | undefined;
const url = (p: string) => `http://127.0.0.1:${server.port}${p}`;
const archive = (id: string, body: unknown) =>
  fetch(url(`/api/repos/archive?id=${id}`), { method: "POST", body: JSON.stringify(body) });
const tree = async () => ((await (await fetch(url("/api/tree"))).json()) as { repos: Repo[] }).repos;

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "canopy-archive-"));
  saved = process.env["CANOPY_CONFIG_DIR"];
  process.env["CANOPY_CONFIG_DIR"] = join(scratch, "config");
  const root = join(scratch, "root");
  await Bun.$`mkdir -p ${join(root, "app")} ${join(root, "old")} && git -C ${join(root, "app")} init -q && git -C ${join(root, "old")} init -q`.quiet();
  server = await startServer({ root, port: 0 });
});

afterAll(async () => {
  server.stop();
  if (saved === undefined) delete process.env["CANOPY_CONFIG_DIR"];
  else process.env["CANOPY_CONFIG_DIR"] = saved;
  await rm(scratch, { recursive: true, force: true });
});

describe("archiving a repo", () => {
  test("refuses a body without a boolean", async () => {
    expect((await archive("old", {})).status).toBe(400);
    expect((await archive("old", { archived: "yes" })).status).toBe(400);
  });

  test("marks the repo, keeps the mark across a rescan, and takes it off", async () => {
    const res = await archive("old", { archived: true });
    expect(res.status).toBe(200);
    const marked = (await res.json()) as Repo;
    expect(marked.archived).toBe(true);
    expect((await loadConfig()).archived).toEqual([marked.path]);

    await fetch(url("/api/rescan"), { method: "POST" });
    const after = await tree();
    expect(after.find((r) => r.id === "old")?.archived).toBe(true);
    expect(after.find((r) => r.id === "app")?.archived).toBeUndefined();

    const back = (await (await archive("old", { archived: false })).json()) as Repo;
    expect(back.archived).toBeUndefined();
    expect((await tree()).find((r) => r.id === "old")?.archived).toBeUndefined();
    expect((await loadConfig()).archived).toEqual([]);
  });
});
