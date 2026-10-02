/**
 * While a stage process or check is alive in a seed, canopy runs no git
 * there (seedgit.ts). A status read asked for meanwhile, by the watcher or
 * a rescan, keeps the card's last status rather than an error, and is read
 * once the seed is quiet again rather than dropped.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { appendFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setSeedBusy } from "../core/seedgit";
import type { Repo, ScanResult } from "../core/types";
import { startServer } from "./index";

let scratch: string;
let root: string;
let previous: string | undefined;
let server: { port: number; stop: () => void };
let busy = false;
const url = (p: string) => `http://127.0.0.1:${server.port}${p}`;

async function coin(): Promise<Repo> {
  const tree = (await (await fetch(url("/api/tree"))).json()) as ScanResult;
  const repo = tree.repos.find((r) => r.id === "_incubator/coin");
  if (!repo) throw new Error("the seed is not in the tree");
  return repo;
}

async function until(pred: () => Promise<boolean>, what: string, ms = 10_000): Promise<void> {
  const start = Date.now();
  while (!(await pred())) {
    if (Date.now() - start > ms) throw new Error(`gave up waiting for ${what}`);
    await Bun.sleep(100);
  }
}

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "canopy-seedbusy-"));
  previous = process.env["CANOPY_CONFIG_DIR"];
  process.env["CANOPY_CONFIG_DIR"] = join(scratch, "config");
  root = join(scratch, "root");
  const seed = join(root, "_incubator", "coin");
  await Bun.$`mkdir -p ${seed} && git -C ${seed} init -q -b main`.quiet();
  await Bun.write(join(seed, "a.txt"), "a\n");
  await Bun.$`git -C ${seed} add a.txt && git -C ${seed} -c user.name=a -c user.email=a@b commit -qm one`.quiet();
  server = await startServer({ root, port: 0 });
  // after the server's own hook, which this stands in for
  setSeedBusy(() => busy);
});

afterAll(async () => {
  setSeedBusy(() => false);
  server.stop();
  if (previous === undefined) delete process.env["CANOPY_CONFIG_DIR"];
  else process.env["CANOPY_CONFIG_DIR"] = previous;
  await rm(scratch, { recursive: true, force: true });
});

describe("a busy seed", () => {
  test("a rescan keeps its last status, not the refusal", async () => {
    expect((await coin()).status).not.toBe(null);
    busy = true;
    try {
      expect((await fetch(url("/api/rescan"), { method: "POST" })).status).toBe(200);
      const repo = await coin();
      expect(repo.error).toBeUndefined();
      expect(repo.status?.branch).toBe("main");
    } finally {
      busy = false;
    }
  });

  test("an edit made while it is busy is read once it is quiet", async () => {
    busy = true;
    await appendFile(join(root, "_incubator", "coin", "a.txt"), "more\n");
    // past the watcher's debounce, nothing is read yet
    await Bun.sleep(900);
    expect((await coin()).status?.files ?? []).toEqual([]);
    busy = false;
    await until(async () => ((await coin()).status?.files ?? []).length === 1, "the deferred read");
  }, 15_000);
});
