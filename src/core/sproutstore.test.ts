import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SproutFiles } from "./sproutstore";
import type { Sprout } from "./types";

let dir: string;
let files: SproutFiles;

const ROOT = "/root";

const sprout = (id: string): Sprout => ({
  id,
  slug: "s",
  title: "s",
  status: "queued",
  repoId: "_incubator/s",
  seedPath: "/root/_incubator/s",
  prepared: false,
  inputs: [],
  clarified: false,
  reclarify: false,
  flows: [],
  spent: { runs: 0, workMs: 0 },
  createdAt: 1,
  updatedAt: 1,
});

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "canopy-sprouts-"));
  files = new SproutFiles(ROOT, dir);
});

afterAll(() => rm(dir, { recursive: true, force: true }));

describe("SproutFiles", () => {
  test("a saved sprout lists back, private to the user", async () => {
    await files.save(sprout("sp_000000000001"));
    expect((await files.list()).map((s) => s.id)).toEqual(["sp_000000000001"]);
    expect((await stat(join(dir, "sp_000000000001", "sprout.json"))).mode & 0o777).toBe(0o600);
    expect((await stat(join(dir, "sp_000000000001"))).mode & 0o777).toBe(0o700);
  });
  test("the launch root is stamped on the file and kept off the listed sprout", async () => {
    const onDisk: unknown = JSON.parse(await readFile(join(dir, "sp_000000000001", "sprout.json"), "utf8"));
    expect(onDisk).toMatchObject({ id: "sp_000000000001", root: ROOT });
    expect(Object.keys((await files.list())[0] ?? {})).not.toContain("root");
  });
  test("another root's record is left on disk untouched, and so is one with no root", async () => {
    const other = new SproutFiles("/other", dir);
    await other.save(sprout("sp_0000000000a1"));
    const bare = join(dir, "sp_0000000000a2", "sprout.json");
    await files.save(sprout("sp_0000000000a2"));
    const { root: _root, ...noRoot } = { ...sprout("sp_0000000000a2"), root: "" };
    await writeFile(bare, JSON.stringify(noRoot));
    const before = [
      await readFile(join(dir, "sp_0000000000a1", "sprout.json"), "utf8"),
      await readFile(bare, "utf8"),
    ];
    expect((await files.list()).map((s) => s.id)).toEqual(["sp_000000000001"]);
    expect((await other.list()).map((s) => s.id)).toEqual(["sp_0000000000a1"]);
    expect([
      await readFile(join(dir, "sp_0000000000a1", "sprout.json"), "utf8"),
      await readFile(bare, "utf8"),
    ]).toEqual(before);
    await rm(join(dir, "sp_0000000000a1"), { recursive: true });
    await rm(join(dir, "sp_0000000000a2"), { recursive: true });
  });
  test("a half-written record is skipped, not fatal", async () => {
    await files.save(sprout("sp_000000000002"));
    await writeFile(join(dir, "sp_000000000002", "sprout.json"), '{"id": "sp_0000');
    expect((await files.list()).map((s) => s.id)).toEqual(["sp_000000000001"]);
  });
  test("inputs are written once, read back, and never outside the folder", async () => {
    const id = "sp_000000000001";
    await files.writeInput(id, "001-text.md", "hello");
    expect(new TextDecoder().decode(await files.readInput(id, "001-text.md"))).toBe("hello");
    await expect(files.writeInput(id, "001-text.md", "again")).rejects.toThrow();
    await expect(files.writeInput(id, "../escape", "x")).rejects.toThrow("not an input name");
    await expect(files.writeInput(id, ".hidden", "x")).rejects.toThrow("not an input name");
    await expect(files.writeInput("../../etc", "a", "x")).rejects.toThrow("not a sprout id");
    expect((await stat(join(files.inputsDir(id), "001-text.md"))).mode & 0o777).toBe(0o600);
  });
  test("an input taken back is gone, and taking back one that is not there is fine", async () => {
    const id = "sp_000000000001";
    await files.writeInput(id, "009-answers.md", "a");
    await files.removeInput(id, "009-answers.md");
    await files.removeInput(id, "009-answers.md");
    await files.writeInput(id, "009-answers.md", "b");
    expect(new TextDecoder().decode(await files.readInput(id, "009-answers.md"))).toBe("b");
    await files.removeInput(id, "009-answers.md");
    await expect(files.removeInput(id, "../escape")).rejects.toThrow("not an input name");
  });
  test("two saves close together land in the order they were made", async () => {
    const id = "sp_000000000007";
    // the older one is large, so its write takes longer than the newer one's
    const older: Sprout = {
      ...sprout(id),
      updatedAt: 1,
      inputs: Array.from({ length: 20_000 }, (_, i) => ({ n: i + 1, kind: "text" as const, name: `${i}.md`, label: "x".repeat(40), type: "text/markdown", at: 1, via: "sheet" as const, bytes: 1, summary: "y".repeat(40), processed: true })),
    };
    const newer: Sprout = { ...sprout(id), updatedAt: 2 };
    // a folder of its own, so the other tests' listings never see it
    const own = new SproutFiles(ROOT, join(dir, "order"));
    await Promise.all([own.save(older), own.save(newer)]);
    const onDisk = JSON.parse(await readFile(join(dir, "order", id, "sprout.json"), "utf8")) as Sprout;
    expect(onDisk.updatedAt).toBe(2);
  });
  test("the index is written beside the record", async () => {
    await files.writeIndex("sp_000000000001", "# Inputs\n");
    expect(await readFile(join(dir, "sp_000000000001", "inputs.md"), "utf8")).toBe("# Inputs\n");
  });
  test("run answers are kept beside the record, private, never under inputs/, and a bad entry is dropped", async () => {
    const id = "sp_000000000007";
    expect(await files.readRunAnswers(id)).toEqual([]);
    const rec = { where: "scout, Research", at: 5, items: [{ question: "Q?", offered: ["A"], picked: [], text: "my secret", answered: true }] };
    await files.writeRunAnswers(id, [rec]);
    expect(await files.readRunAnswers(id)).toEqual([rec]);
    expect((await stat(join(dir, id, "run-answers.json"))).mode & 0o777).toBe(0o600);
    expect(await stat(join(files.inputsDir(id), "run-answers.json")).catch(() => null)).toBeNull();
    await writeFile(join(dir, id, "run-answers.json"), JSON.stringify([rec, { where: 1 }, { ...rec, items: [{ question: "x" }] }]));
    expect(await files.readRunAnswers(id)).toEqual([rec]);
  });
  test("dismiss keeps the inputs under .dismissed and drops the sprout from the list", async () => {
    await files.dismiss("sp_000000000001");
    expect(await files.list()).toEqual([]);
    expect(await readFile(join(dir, ".dismissed", "sp_000000000001", "inputs", "001-text.md"), "utf8")).toBe("hello");
  });
});
