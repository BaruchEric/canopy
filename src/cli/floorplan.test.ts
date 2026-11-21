import { expect, test } from "bun:test";
import { FLOORPLAN_USAGE, floorplanLines, parseFloorplanArgs } from "./floorplan";

test("parseFloorplanArgs reads the repo, the act and the flags, and leaves the list alone", () => {
  const argv = ["shop", "make", "-m", "the server matters", "--developers", "--on", "mini"];
  expect(parseFloorplanArgs(argv)).toEqual({ repo: "shop", act: "make", note: "the server matters", developers: true, json: false, on: "mini" });
  expect(argv).toHaveLength(7);
  expect(parseFloorplanArgs(["shop"])).toMatchObject({ repo: "shop", act: "status", note: "", developers: false });
  expect(parseFloorplanArgs(["./shop", "--json"])).toMatchObject({ repo: "./shop", act: "status", json: true });
  expect(parseFloorplanArgs(["shop", "update"])).toMatchObject({ act: "update" });
});

test("parseFloorplanArgs refuses what it cannot run", () => {
  expect(parseFloorplanArgs([])).toBe(FLOORPLAN_USAGE);
  expect(parseFloorplanArgs(["shop", "draw"])).toBe(FLOORPLAN_USAGE);
  expect(parseFloorplanArgs(["shop", "open", "extra"])).toBe(FLOORPLAN_USAGE);
  expect(parseFloorplanArgs(["--json"])).toBe(FLOORPLAN_USAGE);
  expect(parseFloorplanArgs(["shop", "open", "-m", "hi"])).toContain("-m and --developers go with make or update");
  expect(parseFloorplanArgs(["shop", "--backend", "http://x:1", "--on", "mini"])).toBe("use either --backend URL or --on NAME");
});

test("floorplanLines says the map, its server and its run", () => {
  const now = Date.parse("2026-11-20T12:00:00.000Z");
  const base = { builtAt: "2026-11-20T09:00:00.000Z", files: 40, nodes: 5, changed: 2, uncommitted: 0 };
  expect(floorplanLines({ state: "map", ...base, server: null, run: null }, now)).toEqual(["40 files in 5 parts, built 3h ago; 2 files changed since"]);
  expect(floorplanLines({ state: "map", ...base, builtAt: "2026-11-20T11:59:50.000Z", server: { port: 4378 }, run: "r7" }, now)).toEqual([
    "40 files in 5 parts, built just now; 2 files changed since",
    "its server is up on the backend's port 4378; the repo's map section shows it",
    "run r7 is drawing it now (canopy run show r7)",
  ]);
  expect(floorplanLines({ state: "none", builtAt: null, files: null, nodes: null, changed: null, uncommitted: null, server: null, run: null }, now)).toEqual(["no map yet"]);
});
