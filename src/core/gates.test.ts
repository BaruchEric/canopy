import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { packageGates, parseGatesFile, readGates, touchesLockfile } from "./gates";

let root = "";
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "canopy-gates-"));
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

const folder = async (name: string, files: Record<string, string>): Promise<string> => {
  const dir = join(root, name);
  for (const [p, body] of Object.entries(files)) {
    await mkdir(join(dir, p, ".."), { recursive: true });
    await writeFile(join(dir, p), body);
  }
  await mkdir(dir, { recursive: true });
  return dir;
};

describe("the gates file", () => {
  test("gates and setup", () => {
    expect(parseGatesFile(JSON.stringify({ gates: [{ name: "test", run: "bun test" }], setup: "bun install --frozen-lockfile" }))).toEqual({
      gates: [{ name: "test", run: "bun test" }],
      setup: "bun install --frozen-lockfile",
    });
  });

  test("warm: prepared worktrees to keep, a whole number from 0 to 2", () => {
    expect(parseGatesFile(JSON.stringify({ gates: [], warm: 1 }))).toEqual({ gates: [], warm: 1 });
    expect(parseGatesFile(JSON.stringify({ gates: [] }))).toEqual({ gates: [] });
    for (const warm of [3, -1, 1.5, "1"]) {
      expect(parseGatesFile(JSON.stringify({ gates: [], warm }))).toEqual({ error: ".canopy/gates.json: warm must be a whole number from 0 to 2" });
    }
  });

  test("a bad file says why", () => {
    expect(parseGatesFile("{")).toHaveProperty("error");
    expect(parseGatesFile("[]")).toEqual({ error: ".canopy/gates.json must be an object" });
    expect(parseGatesFile("{}")).toEqual({ error: ".canopy/gates.json needs a gates list" });
    expect(parseGatesFile(JSON.stringify({ gates: [{ name: "a b", run: "x" }] }))).toHaveProperty("error");
    expect(parseGatesFile(JSON.stringify({ gates: [{ name: "a", run: " " }] }))).toEqual({ error: ".canopy/gates.json: gate a needs a run line" });
    expect(parseGatesFile(JSON.stringify({ gates: [{ name: "a", run: "x" }, { name: "a", run: "y" }] }))).toEqual({ error: ".canopy/gates.json: two gates are named a" });
    expect(parseGatesFile(JSON.stringify({ gates: [], setup: 3 }))).toEqual({ error: ".canopy/gates.json: setup must be a shell line" });
  });
});

describe("package scripts", () => {
  test("the four names that exist, in order", () => {
    expect(packageGates(JSON.stringify({ scripts: { build: "vite build", test: "bun test", dev: "x" } }))).toEqual([
      { name: "test", run: "bun run test" },
      { name: "build", run: "bun run build" },
    ]);
    expect(packageGates("not json")).toEqual([]);
  });
});

describe("readGates", () => {
  test("warm comes with the file", async () => {
    const dir = await folder("warm", { ".canopy/gates.json": JSON.stringify({ gates: [], setup: "bun install", warm: 2 }) });
    expect(await readGates(dir)).toEqual({ gates: [], setup: "bun install", warm: 2, source: "file" });
  });

  test("the file wins over package.json", async () => {
    const dir = await folder("file", {
      ".canopy/gates.json": JSON.stringify({ gates: [{ name: "check", run: "make check" }] }),
      "package.json": JSON.stringify({ scripts: { test: "bun test" } }),
    });
    expect(await readGates(dir)).toEqual({ gates: [{ name: "check", run: "make check" }], source: "file" });
  });

  test("package.json when there is no file", async () => {
    const dir = await folder("pkg", { "package.json": JSON.stringify({ scripts: { lint: "oxlint" } }) });
    expect(await readGates(dir)).toEqual({ gates: [{ name: "lint", run: "bun run lint" }], source: "package" });
  });

  test("none", async () => {
    const dir = await folder("none", { "README.md": "hi" });
    expect(await readGates(dir)).toEqual({ gates: [], source: "none" });
  });

  test("a bad file throws rather than falling back", async () => {
    const dir = await folder("bad", { ".canopy/gates.json": "{", "package.json": JSON.stringify({ scripts: { test: "x" } }) });
    await expect(readGates(dir)).rejects.toThrow(/not JSON/);
  });

  test("read from the folder it is handed: the main checkout, not a branch's copy", async () => {
    const main = await folder("main", { ".canopy/gates.json": JSON.stringify({ gates: [{ name: "test", run: "bun test" }] }) });
    await folder("branch", { ".canopy/gates.json": JSON.stringify({ gates: [] }) });
    expect((await readGates(main)).gates).toEqual([{ name: "test", run: "bun test" }]);
  });
});

test("a lockfile at any depth", () => {
  expect(touchesLockfile(["src/a.ts", "bun.lock"])).toBe(true);
  expect(touchesLockfile(["web/package-lock.json"])).toBe(true);
  expect(touchesLockfile(["src/lock.ts"])).toBe(false);
});
