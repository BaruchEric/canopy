import { expect, test } from "bun:test";
import { ARCHIFY_USAGE, archifyLines, parseArchifyArgs } from "./archify";

test("parseArchifyArgs reads the repo, the act and its words, and leaves the list alone", () => {
  const argv = ["shop", "make", "--type", "sequence", "-m", "the login request", "--on", "mini"];
  expect(parseArchifyArgs(argv)).toEqual({ repo: "shop", act: "make", type: "sequence", note: "the login request", json: false, on: "mini" });
  expect(argv).toHaveLength(8);
  expect(parseArchifyArgs(["shop"])).toEqual({ repo: "shop", act: "list", json: false });
  expect(parseArchifyArgs(["./shop", "--json"])).toMatchObject({ repo: "./shop", act: "list", json: true });
  expect(parseArchifyArgs(["shop", "make"])).toMatchObject({ act: "make", type: "auto", note: "" });
  expect(parseArchifyArgs(["shop", "revise", "architecture-shop-20261121-090000", "-m", "add auth"])).toMatchObject({ act: "revise", diagram: "architecture-shop-20261121-090000", note: "add auth" });
  expect(parseArchifyArgs(["shop", "save", "d1"])).toMatchObject({ act: "save", diagram: "d1", file: null });
  expect(parseArchifyArgs(["shop", "save", "d1", "out.html"])).toMatchObject({ act: "save", diagram: "d1", file: "out.html" });
  expect(parseArchifyArgs(["shop", "rm", "d1", "--backend", "http://x:1"])).toMatchObject({ act: "rm", diagram: "d1", backend: "http://x:1" });
});

test("parseArchifyArgs refuses what it cannot run", () => {
  expect(parseArchifyArgs([])).toBe(ARCHIFY_USAGE);
  expect(parseArchifyArgs(["--json"])).toBe(ARCHIFY_USAGE);
  expect(parseArchifyArgs(["shop", "draw"])).toBe(ARCHIFY_USAGE);
  expect(parseArchifyArgs(["shop", "list", "extra"])).toBe(ARCHIFY_USAGE);
  expect(parseArchifyArgs(["shop", "make", "--type", "mindmap"])).toContain("--type is auto or one of");
  expect(parseArchifyArgs(["shop", "rm", "d1", "--type", "erd"])).toContain("--type goes with make");
  expect(parseArchifyArgs(["shop", "rm", "d1", "-m", "x"])).toContain("-m goes with make or revise");
  expect(parseArchifyArgs(["shop", "revise", "d1"])).toBe("say what to change with -m");
  expect(parseArchifyArgs(["shop", "revise", "-m", "x"])).toBe(ARCHIFY_USAGE);
  expect(parseArchifyArgs(["shop", "rm", "../etc"])).toBe(ARCHIFY_USAGE);
  expect(parseArchifyArgs(["shop", "rm"])).toBe(ARCHIFY_USAGE);
  expect(parseArchifyArgs(["shop", "--backend", "http://x:1", "--on", "mini"])).toBe("use either --backend URL or --on NAME");
});

test("archifyLines says the diagrams and the run", () => {
  const now = Date.parse("2026-11-21T12:00:00.000Z");
  const d = { id: "architecture-shop-20261121-090000", file: "shop.html", title: "Shop", type: "architecture" as const, bytes: 9, builtAt: now - 3 * 3600_000, checks: "browser-skipped" as const };
  expect(archifyLines({ diagrams: [], run: null }, now)).toEqual(["no diagrams yet"]);
  expect(archifyLines({ diagrams: [{ ...d, tracked: true }], run: "r7" }, now)).toEqual([
    "1 diagram, built 3h ago",
    "  architecture-shop-20261121-090000  Shop  (architecture, 3h ago, checked, no browser check, in git)",
    "run r7 is drawing one now (canopy run show r7)",
  ]);
});
