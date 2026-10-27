import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkItem } from "./work";
import { readWorkItems, writeWorkItem } from "./workstore";

let root = "";
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "canopy-workstore-"));
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

const item = (id: string): WorkItem => ({ id, title: `work ${id}`, repos: ["r"], state: "open", from: { kind: "note" }, runs: [], branches: [], prs: [], events: [], notes: [], createdAt: 1, updatedAt: 1 });

test("one file per item, read back in id order; a bad file is skipped; no folder is none", async () => {
  const dir = join(root, "work1");
  expect(await readWorkItems(dir)).toEqual([]);
  await writeWorkItem(dir, item("w-testbbbb"));
  await writeWorkItem(dir, item("w-testaaaa"));
  await writeFile(join(dir, "broken.json"), "{");
  await writeFile(join(dir, "w-testcccc.json"), JSON.stringify({ id: "nope" }));
  expect((await readdir(dir)).sort()).toEqual(["broken.json", "w-testaaaa.json", "w-testbbbb.json", "w-testcccc.json"]);
  expect((await readWorkItems(dir)).map((i) => i.id)).toEqual(["w-testaaaa", "w-testbbbb"]);
  expect(JSON.parse(await readFile(join(dir, "w-testaaaa.json"), "utf8"))).toEqual(item("w-testaaaa"));
});

test("a write replaces the file whole and leaves no temp file", async () => {
  const dir = join(root, "work2");
  await writeWorkItem(dir, item("w-testaaaa"));
  await writeWorkItem(dir, { ...item("w-testaaaa"), title: "renamed" });
  expect(await readdir(dir)).toEqual(["w-testaaaa.json"]);
  expect((await readWorkItems(dir))[0]?.title).toBe("renamed");
});
