import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AdviceFiles } from "./improvements";
import type { AdviceOffer } from "./types";

let dir = "";
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "canopy-improve-"));
});
afterEach(() => rm(dir, { recursive: true, force: true }));

describe("AdviceFiles", () => {
  test("folds, renders and reads back, at 0600, telling each change", async () => {
    const told: AdviceOffer[][] = [];
    let at = 10;
    const files = new AdviceFiles(dir, (o) => told.push(o), () => at);
    expect(await files.offers()).toEqual([]);
    await files.fold([{ key: "scout-reads-npm", lesson: "Scout reads npm.", file: "scout" }], { id: "sp_1", title: "One" });
    at = 20;
    await files.fold([{ key: "scout-reads-npm", lesson: "Scout reads npm." }], { id: "sp_2", title: "Two" });
    const offers = await files.offers();
    expect(offers.map((o) => [o.key, o.count, o.file])).toEqual([["scout-reads-npm", 2, "scout"]]);
    expect(told).toHaveLength(2);
    expect(await files.known()).toEqual([{ key: "scout-reads-npm", lesson: "Scout reads npm.", count: 2 }]);
    const md = await readFile(join(dir, "improvements.md"), "utf8");
    expect(md).toContain("## scout-reads-npm");
    expect((await stat(join(dir, "improvements.json"))).mode & 0o777).toBe(0o600);
    expect((await stat(join(dir, "improvements.md"))).mode & 0o777).toBe(0o600);
    expect(await files.offer("scout-reads-npm")).toMatchObject({ key: "scout-reads-npm" });
    expect(await files.decide("scout-reads-npm", false)).toBe(true);
    expect(await files.offers()).toEqual([]);
    expect(await files.offer("scout-reads-npm")).toBeUndefined();
    expect(await files.decide("nope", true)).toBe(false);
    expect(told.at(-1)).toEqual([]);
  });

  test("two folds at once both land", async () => {
    const files = new AdviceFiles(dir);
    await Promise.all([
      files.fold([{ key: "a", lesson: "a" }], { id: "sp_1", title: "One" }),
      files.fold([{ key: "b", lesson: "b" }], { id: "sp_2", title: "Two" }),
    ]);
    expect((await files.offers()).map((o) => o.key).sort()).toEqual(["a", "b"]);
  });

  test("a broken file reads as empty with a log line", async () => {
    await writeFile(join(dir, "improvements.json"), "{not json");
    const logs: string[] = [];
    const files = new AdviceFiles(dir, () => {}, Date.now, (l) => logs.push(l));
    expect(await files.offers()).toEqual([]);
    expect(logs[0]).toContain("is not an improvements list");
  });
});
