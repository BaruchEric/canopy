import { describe, expect, test } from "bun:test";
import { crumbs, dirExists, dirOf, entriesAt, findFiles, linesOf, looksBinary, placeOf, resolveRel, sizeWord, stepOf, withIgnored } from "./finder";

const FILES = [".github/workflows/ci.yml", ".gitignore", "README.md", "src/a.ts", "src/b.ts", "src/deep/c.ts", "src/file10.ts", "src/file2.ts", "ui/x.tsx"];

describe("entriesAt", () => {
  test("folders first with their counts, then files, dotfiles hidden", () => {
    expect(entriesAt(FILES, "").map((e) => [e.name, e.dir, e.count])).toEqual([
      ["src", true, 5],
      ["ui", true, 1],
      ["README.md", false, 0],
    ]);
  });
  test("shows dotfiles and dotfolders when asked", () => {
    expect(entriesAt(FILES, "", true).map((e) => e.name)).toEqual([".github", "src", "ui", ".gitignore", "README.md"]);
  });
  test("a nested folder, its paths whole, numbers in order", () => {
    const at = entriesAt(FILES, "src");
    expect(at.map((e) => e.path)).toEqual(["src/deep", "src/a.ts", "src/b.ts", "src/file2.ts", "src/file10.ts"]);
  });
  test("a folder that is gone", () => {
    expect(entriesAt(FILES, "nope")).toEqual([]);
    expect(dirExists(FILES, "nope")).toBe(false);
    expect(dirExists(FILES, "src/deep")).toBe(true);
    expect(dirExists(FILES, "")).toBe(true);
  });
});

describe("paths", () => {
  test("crumbs from the root", () => {
    expect(crumbs("", "canopy")).toEqual([{ name: "canopy", path: "" }]);
    expect(crumbs("src/deep", "canopy")).toEqual([
      { name: "canopy", path: "" },
      { name: "src", path: "src" },
      { name: "deep", path: "src/deep" },
    ]);
  });
  test("dirOf", () => {
    expect(dirOf("a.ts")).toBe("");
    expect(dirOf("src/deep/c.ts")).toBe("src/deep");
  });
});

describe("findFiles", () => {
  test("name matches ahead of path matches, every word must hit", () => {
    expect(findFiles(FILES, "c").hits[0]).toBe("src/deep/c.ts");
    expect(findFiles(FILES, "src ts").hits).toHaveLength(5);
    expect(findFiles(FILES, "deep a").hits).toEqual([]);
  });
  test("leaves hidden paths out until asked, and caps", () => {
    expect(findFiles(FILES, "ci").hits).toEqual([]);
    expect(findFiles(FILES, "ci", true).hits).toEqual([".github/workflows/ci.yml"]);
    expect(findFiles(FILES, "ts", false, 2)).toEqual({ hits: ["src/a.ts", "src/b.ts"], more: true });
    expect(findFiles(FILES, "  ").hits).toEqual([]);
  });
});

describe("the viewer", () => {
  test("steps without wrapping", () => {
    expect(stepOf(["a", "b", "c"], "a")).toEqual({ prev: null, next: "b", at: 0 });
    expect(stepOf(["a", "b", "c"], "c")).toEqual({ prev: "b", next: null, at: 2 });
    expect(stepOf(["a"], "z").at).toBe(-1);
  });
  test("tells binary from text", () => {
    expect(looksBinary(new TextEncoder().encode("plain"))).toBe(false);
    expect(looksBinary(new Uint8Array([80, 0, 1]))).toBe(true);
  });
  test("cuts long text and counts its lines", () => {
    expect(linesOf("a\nb\n")).toEqual({ lines: ["a", "b"], total: 2 });
    expect(linesOf("a\nb\nc", 2)).toEqual({ lines: ["a", "b"], total: 3 });
  });
  test("sizes", () => {
    expect(sizeWord(12)).toBe("12 B");
    expect(sizeWord(1536)).toBe("1.5 KB");
    expect(sizeWord(50 * 1024 * 1024)).toBe("50 MB");
  });
});

test("a saved place takes only what it should", () => {
  expect(placeOf({ dir: "src", file: "src/a.ts" })).toEqual({ dir: "src", file: "src/a.ts" });
  expect(placeOf({ dir: 3 })).toEqual({ dir: "", file: null });
  expect(placeOf(null)).toEqual({ dir: "", file: null });
});

describe("show ignored", () => {
  test("adds what only the disk has, marked, in name order", () => {
    const listed = entriesAt(FILES, "");
    const disk = [
      { name: "src", dir: true },
      { name: "node_modules", dir: true },
      { name: ".env", dir: false },
      { name: "dist", dir: true },
    ];
    expect(withIgnored(listed, disk, "").map((e) => [e.name, e.ignored ?? false, e.count])).toEqual([
      ["dist", true, null],
      ["node_modules", true, null],
      ["src", false, 5],
      ["ui", false, 1],
      ["README.md", false, 0],
    ]);
    expect(withIgnored([], disk, "x", true).map((e) => e.path)).toContain("x/.env");
  });
});

describe("resolveRel", () => {
  test("relative to the file's folder, or the root for a slash", () => {
    expect(resolveRel("docs/a.md", "img/x.png")).toBe("docs/img/x.png");
    expect(resolveRel("docs/a.md", "./b.md#part")).toBe("docs/b.md");
    expect(resolveRel("docs/a.md", "../README.md")).toBe("README.md");
    expect(resolveRel("docs/a.md", "/ui/x.tsx")).toBe("ui/x.tsx");
    expect(resolveRel("a.md", "my%20file.md")).toBe("my file.md");
  });
  test("nothing for an address off the page or above the root", () => {
    for (const h of ["https://x.y/z", "//cdn/x", "#top", "mailto:a@b", "../../x", ""]) expect(resolveRel("docs/a.md", h)).toBeNull();
  });
});
