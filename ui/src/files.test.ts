import { describe, expect, test } from "bun:test";
import type { RepoFile } from "../../src/core/types";
import {
  colOrder,
  filterFiles,
  folderOf,
  groupByFolder,
  markOf,
  moveCol,
  sortFiles,
} from "./files";

const file = (over: Partial<RepoFile>): RepoFile => ({
  path: "a.ts",
  index: ".",
  worktree: "M",
  untracked: false,
  conflicted: false,
  ...over,
});

describe("markOf", () => {
  test("staged wins over worktree, conflicts and untracked have their own", () => {
    expect(markOf(file({}))).toBe("M");
    expect(markOf(file({ index: "A", worktree: "M" }))).toBe("A");
    expect(markOf(file({ conflicted: true }))).toBe("U");
    expect(markOf(file({ untracked: true, worktree: "." }))).toBe("?");
  });
});

describe("sortFiles", () => {
  const files = [
    file({ path: "b.ts", mtime: 100 }),
    file({ path: "gone.ts", worktree: "D" }),
    file({ path: "a.ts", mtime: 300 }),
    file({ path: "c.ts", mtime: 200 }),
  ];
  test("time desc is recent first with timeless files last", () => {
    expect(
      sortFiles(files, { col: "time", dir: "desc" }).map((f) => f.path),
    ).toEqual(["a.ts", "c.ts", "b.ts", "gone.ts"]);
  });
  test("time asc keeps timeless files last", () => {
    expect(
      sortFiles(files, { col: "time", dir: "asc" }).map((f) => f.path),
    ).toEqual(["b.ts", "c.ts", "a.ts", "gone.ts"]);
  });
  test("name sorts A to Z and flips", () => {
    expect(
      sortFiles(files, { col: "file", dir: "asc" }).map((f) => f.path),
    ).toEqual(["a.ts", "b.ts", "c.ts", "gone.ts"]);
    expect(
      sortFiles(files, { col: "file", dir: "desc" }).map((f) => f.path),
    ).toEqual(["gone.ts", "c.ts", "b.ts", "a.ts"]);
  });
  test("ties keep their order and the input is untouched", () => {
    const sorted = sortFiles(files, { col: "mark", dir: "asc" });
    expect(sorted.map((f) => f.path)).toEqual(["gone.ts", "b.ts", "a.ts", "c.ts"]);
    expect(files[0]?.path).toBe("b.ts");
  });
});

describe("filterFiles", () => {
  const files = [
    file({ path: "src/app.ts" }),
    file({ path: "README.md", untracked: true, worktree: "." }),
    file({ path: "new.ts", index: "R", worktree: ".", orig: "src/old.ts" }),
  ];
  test("a blank query keeps everything", () => {
    expect(filterFiles(files, "  ")).toBe(files);
  });
  test("matches path and origin, every word, any case", () => {
    expect(filterFiles(files, "SRC").map((f) => f.path)).toEqual([
      "src/app.ts",
      "new.ts",
    ]);
    expect(filterFiles(files, "src old").map((f) => f.path)).toEqual(["new.ts"]);
    expect(filterFiles(files, "zzz")).toEqual([]);
  });
});

describe("folders", () => {
  test("folderOf is the path before the last slash", () => {
    expect(folderOf("README.md")).toBe("");
    expect(folderOf("src/core/git.ts")).toBe("src/core");
  });
  test("groupByFolder keeps first-seen folder order and file order", () => {
    const groups = groupByFolder([
      file({ path: "ui/src/a.ts" }),
      file({ path: "README.md" }),
      file({ path: "src/git.ts" }),
      file({ path: "ui/src/b.ts" }),
    ]);
    expect(groups.map((g) => [g.folder, g.files.map((f) => f.path)])).toEqual([
      ["ui/src", ["ui/src/a.ts", "ui/src/b.ts"]],
      ["", ["README.md"]],
      ["src", ["src/git.ts"]],
    ]);
    expect(groupByFolder([])).toEqual([]);
  });
});

describe("column order", () => {
  test("moveCol drops after when moving right, before when moving left", () => {
    expect(moveCol(["mark", "file", "time"], "mark", "time")).toEqual([
      "file",
      "time",
      "mark",
    ]);
    expect(moveCol(["mark", "file", "time"], "time", "file")).toEqual([
      "mark",
      "time",
      "file",
    ]);
    const same: ReturnType<typeof colOrder> = ["mark", "file", "time"];
    expect(moveCol(same, "file", "file")).toBe(same);
  });
  test("colOrder repairs what was saved, dropping columns that are gone", () => {
    expect(colOrder(["time", "file"])).toEqual(["time", "file", "mark"]);
    expect(colOrder(["time", "desc", "time", 3])).toEqual(["time", "mark", "file"]);
    expect(colOrder(undefined)).toEqual(["mark", "file", "time"]);
  });
});
