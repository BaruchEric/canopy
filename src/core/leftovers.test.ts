/** The incubator's leftovers sweep on a real folder tree: what goes, and
 *  that nothing a sprout on the list holds ever does. */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DISMISSED_KEEP, LEFTOVER_AGE, sweepLeftovers } from "./leftovers";

const NOW = Date.UTC(2026, 10, 14, 12);
const OLD = NOW - LEFTOVER_AGE - 60_000;
const FRESH = NOW - 60_000;
const GONE = "sp_aaaaaaaaaaaa";
const LIVE = "sp_bbbbbbbbbbbb";
const ENDED = "sp_cccccccccccc";

let scratch = "";
let root = "";
let store = "";
const seeds = () => join(root, "_incubator");

/** a folder with a file in it, its own time set to `at` */
async function dir(path: string, at: number): Promise<string> {
  await mkdir(path, { recursive: true });
  await writeFile(join(path, "f"), "x");
  await utimes(path, at / 1000, at / 1000);
  return path;
}

beforeEach(async () => {
  scratch = await realpath(await mkdtemp(join(tmpdir(), "canopy-leftovers-")));
  root = join(scratch, "root");
  store = join(scratch, "config", "incubator");
  await mkdir(seeds(), { recursive: true });
  await mkdir(store, { recursive: true });
});
afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});

const sprouts = [
  { id: LIVE, slug: "jar" },
  { id: ENDED, slug: "coin" },
];

describe("sweepLeftovers", () => {
  test("old leftovers no sprout on the list holds go, each kind", async () => {
    const making = await dir(join(root, ".canopy-making", `tip.${GONE}`), OLD);
    const rework = await dir(join(root, ".canopy-making", `tip.${GONE}.rework`), OLD);
    const tmp = await dir(join(seeds(), ".shared", ".tmp-123-abcdef"), OLD);
    const shared = await Promise.all(["inputs", "workspace", "record"].map((k) => dir(join(seeds(), ".shared", k, GONE), OLD)));
    const dismissed = await dir(join(store, ".dismissed", GONE), NOW - DISMISSED_KEEP - 60_000);
    await dir(join(root, ".canopy-mirrors", "tip", ".git"), OLD);
    const mirror = await dir(join(root, ".canopy-mirrors", "tip"), OLD);
    const gone = await sweepLeftovers({ root, store }, sprouts, NOW);
    for (const p of [making, rework, tmp, ...shared, dismissed, mirror]) expect(existsSync(p)).toBe(false);
    expect(gone.sort()).toEqual([making, rework, tmp, ...shared, dismissed, mirror].sort());
  });

  test("never what a sprout on the list holds, however old: its making folder, its shared copies, its mirror", async () => {
    const held = [
      await dir(join(root, ".canopy-making", `jar.${LIVE}`), OLD),
      await dir(join(root, ".canopy-making", `jar.${LIVE}.rework`), OLD),
      ...(await Promise.all(["inputs", "workspace", "record"].map((k) => dir(join(seeds(), ".shared", k, LIVE), OLD)))),
      // an ended sprout still on the list: its retro reads its record
      ...(await Promise.all(["inputs", "workspace", "record"].map((k) => dir(join(seeds(), ".shared", k, ENDED), OLD)))),
      await dir(join(root, ".canopy-mirrors", "coin"), OLD),
    ];
    // even with a stray dismissed record under the same id
    await dir(join(store, ".dismissed", LIVE), OLD);
    expect(await sweepLeftovers({ root, store }, sprouts, NOW)).toEqual([]);
    for (const p of held) expect(existsSync(p)).toBe(true);
  });

  test("never anything younger than its safe age", async () => {
    const young = [
      await dir(join(root, ".canopy-making", `tip.${GONE}`), FRESH),
      await dir(join(seeds(), ".shared", ".tmp-123-abcdef"), FRESH),
      await dir(join(seeds(), ".shared", "inputs", GONE), FRESH),
      await dir(join(root, ".canopy-mirrors", "tip"), FRESH),
      // a dismissed record is kept two weeks, not a day
      await dir(join(store, ".dismissed", "sp_dddddddddddd"), OLD),
    ];
    await dir(join(store, ".dismissed", GONE), OLD);
    expect(await sweepLeftovers({ root, store }, sprouts, NOW)).toEqual([]);
    for (const p of young) expect(existsSync(p)).toBe(true);
  });

  test("a mirror synced lately stays: a sync moves the time of its .git, not its top folder's", async () => {
    await dir(join(root, ".canopy-mirrors", "tip", ".git"), FRESH);
    const mirror = await dir(join(root, ".canopy-mirrors", "tip"), OLD);
    expect(await sweepLeftovers({ root, store }, sprouts, NOW)).toEqual([]);
    expect(existsSync(mirror)).toBe(true);
  });

  test("a mirror whose seed is there stays, and a sprout's shared copies stay unless this canopy dismissed it", async () => {
    const mirror = await dir(join(root, ".canopy-mirrors", "tip"), OLD);
    await dir(join(seeds(), "tip"), OLD);
    // another canopy's sprout on the same root: not on this list, and never dismissed here
    const theirs = await dir(join(seeds(), ".shared", "inputs", "sp_eeeeeeeeeeee"), OLD);
    expect(await sweepLeftovers({ root, store }, sprouts, NOW)).toEqual([]);
    expect(existsSync(mirror)).toBe(true);
    expect(existsSync(theirs)).toBe(true);
  });

  test("a dismissed record whose shared copies are still there waits for them", async () => {
    const dismissed = await dir(join(store, ".dismissed", GONE), NOW - DISMISSED_KEEP - 60_000);
    // younger than a day: kept this time, so the record is too
    const shared = await dir(join(seeds(), ".shared", "record", GONE), FRESH);
    expect(await sweepLeftovers({ root, store }, sprouts, NOW)).toEqual([]);
    expect(existsSync(dismissed)).toBe(true);
    expect(existsSync(shared)).toBe(true);
  });

  test("links and names that are not canopy's are left alone", async () => {
    const elsewhere = await dir(join(scratch, "elsewhere"), OLD);
    await mkdir(join(root, ".canopy-making"), { recursive: true });
    await symlink(elsewhere, join(root, ".canopy-making", `tip.${GONE}`));
    await mkdir(join(seeds(), ".shared", "inputs"), { recursive: true });
    await symlink(elsewhere, join(seeds(), ".shared", "inputs", GONE));
    await dir(join(store, ".dismissed", GONE), NOW - DISMISSED_KEEP - 60_000);
    const odd = [await dir(join(root, ".canopy-making", "not-a-sprout"), OLD), await dir(join(seeds(), ".shared", "inputs", "../x-not-an-id"), OLD), await dir(join(seeds(), ".shared", "notes"), OLD)];
    await sweepLeftovers({ root, store }, sprouts, NOW);
    expect(existsSync(join(elsewhere, "f"))).toBe(true);
    for (const p of odd) expect(existsSync(p)).toBe(true);
  });

  test("no folders at all is nothing to do", async () => {
    await rm(scratch, { recursive: true, force: true });
    expect(await sweepLeftovers({ root, store }, sprouts, NOW)).toEqual([]);
  });
});
