import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Run } from "../core/types";
import { GOAL_FILES_KEEP, dropGoalFiles, goalFileList, goalFilesDir, liveGoalIds, pruneGoalFiles, writeGoalFiles } from "./goalfiles";

/* A goal's files folder under the coordinator's seeds: where it is, what a
 * start writes there, what a plan may name from it, and which folders a
 * prune takes. */

let scratch = "";
beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "canopy-goalfiles-"));
});
afterAll(async () => {
  await rm(scratch, { recursive: true, force: true });
});

const DAY = 24 * 60 * 60_000;
const bytes = (s: string): Uint8Array => new TextEncoder().encode(s);

describe("a goal's files folder", () => {
  test("sits under the seeds' goal-files, by the run's id", () => {
    expect(goalFilesDir("/seeds", "ab12cd34")).toBe("/seeds/goal-files/ab12cd34");
  });

  test("a start writes the files 0600 in a folder of its own, 0700, and the list reads them back", async () => {
    const seeds = join(scratch, "write");
    const dir = goalFilesDir(seeds, "ab12cd34");
    expect(await goalFileList(dir)).toEqual([]);
    await writeGoalFiles(dir, [{ name: "shot.png", data: bytes("png") }, { name: "notes.md", data: bytes("# notes") }]);
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
    expect((await stat(join(dir, "shot.png"))).mode & 0o777).toBe(0o600);
    expect(await Bun.file(join(dir, "notes.md")).text()).toBe("# notes");
    expect(await goalFileList(dir)).toEqual(["notes.md", "shot.png"]);
    // the list holds plain files alone
    await mkdir(join(dir, "sub"));
    await symlink(join(dir, "shot.png"), join(dir, "link.png"));
    expect(await goalFileList(dir)).toEqual(["notes.md", "shot.png"]);
  });

  test("a name that is not one plain path part is refused, and nothing is written outside the folder", async () => {
    const seeds = join(scratch, "escape");
    for (const name of ["../out.md", "a/b.md", "..", ".", ""]) {
      const dir = goalFilesDir(seeds, "ab12cd34");
      await expect(writeGoalFiles(dir, [{ name, data: bytes("x") }])).rejects.toThrow(`not a plain file name: ${name}`);
      await rm(dir, { recursive: true, force: true });
    }
    expect(existsSync(join(seeds, "goal-files", "out.md"))).toBe(false);
    expect(existsSync(join(seeds, "out.md"))).toBe(false);
  });

  test("a write that fails partway removes the folder it made", async () => {
    const seeds = join(scratch, "partway");
    const dir = goalFilesDir(seeds, "ab12cd34");
    await expect(writeGoalFiles(dir, [{ name: "shot.png", data: bytes("x") }, { name: "shot.png", data: bytes("y") }])).rejects.toThrow();
    expect(existsSync(dir)).toBe(false);
  });

  test("a folder that is there already is never written into", async () => {
    const seeds = join(scratch, "taken");
    const dir = goalFilesDir(seeds, "ab12cd34");
    await mkdir(dir, { recursive: true });
    await expect(writeGoalFiles(dir, [{ name: "shot.png", data: bytes("x") }])).rejects.toThrow();
    expect(await readdir(dir)).toEqual([]);
  });
});

describe("pruning the goals' files", () => {
  // whole seconds, so a file's mtime holds it exactly
  const now = Math.floor(Date.now() / 1000) * 1000;
  /** a goal-files folder with one file whose mtime is `age` ago */
  async function folder(seeds: string, id: string, age: number): Promise<string> {
    const dir = goalFilesDir(seeds, id);
    await writeGoalFiles(dir, [{ name: "shot.png", data: bytes("x") }]);
    const at = new Date(now - age);
    await utimes(join(dir, "shot.png"), at, at);
    return dir;
  }

  test("takes a folder whose run is not live and whose newest file is past the week, and leaves the rest", async () => {
    const seeds = join(scratch, "prune");
    const old = await folder(seeds, "0000000a", 8 * DAY);
    const recent = await folder(seeds, "0000000b", 6 * DAY);
    const live = await folder(seeds, "0000000c", 30 * DAY);
    // a newer file keeps a folder whose other file is old
    const mixed = await folder(seeds, "0000000d", 30 * DAY);
    await writeFile(join(mixed, "new.md"), "x");
    // an empty folder goes by its own mtime
    const empty = goalFilesDir(seeds, "0000000e");
    await mkdir(empty, { recursive: true });
    await utimes(empty, new Date(now - 9 * DAY), new Date(now - 9 * DAY));
    // a file under goal-files, a link and a folder not named like a run id are never taken
    const stray = join(seeds, "goal-files", "0000000f");
    await writeFile(stray, "x");
    await utimes(stray, new Date(now - 30 * DAY), new Date(now - 30 * DAY));
    const target = await folder(join(scratch, "elsewhere"), "00000001", 30 * DAY);
    await symlink(target, join(seeds, "goal-files", "00000002"));
    const named = join(seeds, "goal-files", "keep-me");
    await mkdir(named);
    await utimes(named, new Date(now - 30 * DAY), new Date(now - 30 * DAY));

    const removed = await pruneGoalFiles(seeds, new Set(["0000000c"]), now);
    expect(removed.sort()).toEqual(["0000000a", "0000000e"]);
    expect([existsSync(old), existsSync(recent), existsSync(live), existsSync(mixed), existsSync(empty)]).toEqual([false, true, true, true, false]);
    expect([existsSync(stray), existsSync(target), existsSync(join(seeds, "goal-files", "00000002")), existsSync(named)]).toEqual([true, true, true, true]);
  });

  test("keeps a week to the day", async () => {
    const seeds = join(scratch, "edge");
    const dir = await folder(seeds, "0000000a", GOAL_FILES_KEEP);
    expect(await pruneGoalFiles(seeds, new Set(), now)).toEqual([]);
    expect(existsSync(dir)).toBe(true);
  });

  test("seeds with no goal-files folder, or a relative path, take nothing and make nothing", async () => {
    const seeds = join(scratch, "bare");
    await mkdir(seeds);
    expect(await pruneGoalFiles(seeds, new Set(), now)).toEqual([]);
    expect(await readdir(seeds)).toEqual([]);
    expect(await pruneGoalFiles("relative/seeds", new Set(), now)).toEqual([]);
  });
});

describe("the goals a prune keeps", () => {
  const run = (id: string, action: Run["action"], addDirs?: string[]): Pick<Run, "id" | "action" | "addDirs"> => ({ id, action, ...(addDirs ? { addDirs } : {}) });
  test("every coordinator going, and every goal whose folder a run still at work reads", () => {
    const active = [
      run("c0000001", "coordinate"),
      // a card's child, or a fix or follow-up on a card's branch, after its goal ended
      run("r0000001", "ask", [goalFilesDir("/seeds", "0000000a")]),
      run("r0000002", "ask", [`${goalFilesDir("/seeds", "0000000b")}/`]),
      // a folder that is not one goal's under these seeds' goal-files
      run("r0000003", "ask", ["/seeds/goal-files", "/seeds/0000000c", "/other/goal-files/0000000d", "/seeds/goal-files/keep-me", "/seeds/goal-files/0000000e/inner", "relative/0000000f"]),
      run("r0000004", "ask"),
    ];
    expect([...liveGoalIds("/seeds", active)].sort()).toEqual(["0000000a", "0000000b", "c0000001"]);
  });
  test("a prune with that set keeps an old folder a running card reads", async () => {
    const seeds = join(scratch, "kept-by-a-card");
    const dir = goalFilesDir(seeds, "0000000a");
    await writeGoalFiles(dir, [{ name: "shot.png", data: bytes("png") }]);
    const then = new Date(Date.now() - 9 * DAY);
    await utimes(join(dir, "shot.png"), then, then);
    expect(await pruneGoalFiles(seeds, liveGoalIds(seeds, [run("r0000001", "ask", [dir])]), Date.now())).toEqual([]);
    expect(existsSync(dir)).toBe(true);
    expect(await pruneGoalFiles(seeds, liveGoalIds(seeds, []), Date.now())).toEqual(["0000000a"]);
  });
});

describe("dropping one goal's files", () => {
  test("removes that goal's folder and nothing else", async () => {
    const seeds = join(scratch, "drop");
    const dir = goalFilesDir(seeds, "0000000a");
    const other = goalFilesDir(seeds, "0000000b");
    await writeGoalFiles(dir, [{ name: "shot.png", data: bytes("png") }]);
    await writeGoalFiles(other, [{ name: "shot.png", data: bytes("png") }]);
    expect(await dropGoalFiles(seeds, "0000000a")).toBe(true);
    expect([existsSync(dir), existsSync(other)]).toEqual([false, true]);
    // gone already is nothing to do
    expect(await dropGoalFiles(seeds, "0000000a")).toBe(false);
  });
  test("never a link, a file, a name that is no run id, or under relative seeds", async () => {
    const seeds = join(scratch, "drop-guard");
    const target = goalFilesDir(join(scratch, "drop-elsewhere"), "00000001");
    await writeGoalFiles(target, [{ name: "keep.md", data: bytes("x") }]);
    await mkdir(join(seeds, "goal-files"), { recursive: true });
    await symlink(target, join(seeds, "goal-files", "00000002"));
    await writeFile(join(seeds, "goal-files", "00000003"), "x");
    for (const id of ["00000002", "00000003", "..", "../goal-files", "keep-me"]) expect(await dropGoalFiles(seeds, id)).toBe(false);
    expect(await dropGoalFiles("relative/seeds", "00000001")).toBe(false);
    expect([existsSync(join(target, "keep.md")), existsSync(join(seeds, "goal-files", "00000003"))]).toEqual([true, true]);
  });
});
